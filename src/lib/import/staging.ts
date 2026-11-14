import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnv } from '@/lib/env';
import { STAGED_FILE_MISSING } from './held-file';

/**
 * Why a staged file could not be used. `staged_file_missing` is the one a client acts on: the
 * bytes were swept from DATA_DIR/tmp (purgeStagedFiles below) or already consumed by a commit, and
 * the only way forward is to choose the file again. The routes send it as `code`, beside `error`,
 * the same shape ImportLimitError's codes already take.
 */
export type StagingErrorCode = typeof STAGED_FILE_MISSING | 'invalid_staging_id' | 'staging_full';

export class StagingError extends Error {
  readonly code: StagingErrorCode;

  constructor(message: string, code: StagingErrorCode) {
    super(message);
    this.name = 'StagingError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGED_IMPORT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;
const IMPORT_OWNER_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.import\.json$/i;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** The most bytes all staged import files together may hold in DATA_DIR/tmp. */
export const MAX_STAGED_IMPORT_BYTES = 200 * 1024 * 1024;

export const STAGING_FULL_MESSAGE = 'Too many files are waiting to be imported. Import or clear some, then try again.';

/** The status a route answers a StagingError with: 429 when staging is full, else 410 (gone). */
export function stagingErrorStatus(error: StagingError): number {
  return error.code === 'staging_full' ? 429 : 410;
}

export function stagingDir(): string {
  return path.join(readEnv().dataDir, 'tmp');
}

export function stagedFilePath(stagingId: string): string {
  // Path-traversal guard: only a UUID may ever reach path.join.
  if (!UUID_RE.test(stagingId)) throw new StagingError('Invalid staging id', 'invalid_staging_id');
  return path.join(stagingDir(), `${stagingId}.csv`);
}

/** Who staged an import file, kept beside it as `<stagingId>.import.json`. */
function ownerRecordPath(stagingId: string): string {
  if (!UUID_RE.test(stagingId)) throw new StagingError('Invalid staging id', 'invalid_staging_id');
  return path.join(stagingDir(), `${stagingId}.import.json`);
}

/** The id of the member who staged this file, or null when no readable record says. */
function stagedImportOwner(stagingId: string): number | null {
  const record = ownerRecordPath(stagingId);
  if (!fs.existsSync(record)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(record, 'utf8')) as { uploadedBy?: unknown };
    return typeof parsed.uploadedBy === 'number' ? parsed.uploadedBy : null;
  } catch {
    return null;
  }
}

/** The bytes every staged import file in DATA_DIR/tmp holds together. */
export function stagedImportBytes(): number {
  const dir = stagingDir();
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!STAGED_IMPORT_RE.test(entry)) continue;
    try {
      total += fs.statSync(path.join(dir, entry)).size;
    } catch {
      // Removed between the listing and the stat: nothing to count.
    }
  }
  return total;
}

/**
 * Stages an import file for `uploadedBy`, recorded beside it. Refused with nothing written when it
 * would take the staged import files past MAX_STAGED_IMPORT_BYTES.
 */
export function writeStagedFile(buf: Buffer, uploadedBy: number): string {
  if (stagedImportBytes() + buf.length > MAX_STAGED_IMPORT_BYTES) {
    throw new StagingError(STAGING_FULL_MESSAGE, 'staging_full');
  }
  const dir = stagingDir();
  fs.mkdirSync(dir, { recursive: true });
  const stagingId = randomUUID();
  fs.writeFileSync(path.join(dir, `${stagingId}.csv`), buf);
  fs.writeFileSync(ownerRecordPath(stagingId), JSON.stringify({ uploadedBy }), 'utf8');
  return stagingId;
}

/**
 * The staged bytes, for the member who staged them. A file staged by someone else, or with no
 * owner record, reads exactly as a missing one.
 */
export function readStagedFile(stagingId: string, userId: number): Buffer {
  const file = stagedFilePath(stagingId);
  if (!fs.existsSync(file) || stagedImportOwner(stagingId) !== userId) {
    throw new StagingError('Staged upload not found or expired', STAGED_FILE_MISSING);
  }
  return fs.readFileSync(file);
}

/** Removes a member's own staged file and its owner record. Someone else's is left alone. */
export function deleteStagedFile(stagingId: string, userId: number): void {
  const file = stagedFilePath(stagingId);
  if (stagedImportOwner(stagingId) !== userId) return;
  fs.rmSync(file, { force: true });
  fs.rmSync(ownerRecordPath(stagingId), { force: true });
}

export function purgeStagedFiles(olderThanMs: number = DEFAULT_TTL_MS, now: Date = new Date()): number {
  const dir = stagingDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const ownerRecords: string[] = [];
  const swept = new Set<string>();
  for (const entry of fs.readdirSync(dir)) {
    // An import owner record goes with its file, below, and is never counted on its own.
    if (IMPORT_OWNER_RE.test(entry)) {
      ownerRecords.push(entry);
      continue;
    }
    const file = path.join(dir, entry);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(file);
    } catch {
      continue;
    }
    const aged = now.getTime() - stats.mtimeMs > olderThanMs;
    // Ruling P14 (both halves): this directory is also where buildArchive()
    // (src/lib/backup/archive.ts) stages a whole backup archive (budget.db + receipts/)
    // under a `<uuid>-archive` subdirectory while a backup is being written. A directory
    // can't be a staged upload, and fs.rmSync on a directory without { recursive: true }
    // throws (EISDIR/ENOTEMPTY) — so directories in general are left alone, or a stale one
    // would crash the entire nightly maintenance sweep. But a `-archive` directory left
    // behind by a container killed mid-backup holds a full copy of the database (and,
    // transiently, hard-linked receipts) — leaving THAT alone forever leaks disk space
    // without bound. Once one is old enough that no backup could still be writing it, it is
    // safe, and necessary, to remove it recursively. Any other directory shape is left
    // completely untouched: this sweep only ever removes things it can positively identify
    // as its own leftovers.
    //
    // MUST-20.32: `<uuid>-restore` is the same argument, for the same reason, one entry
    // point later — src/lib/backup/restore.ts's stageRestore() builds one of these under
    // this same DATA_DIR/tmp while validating and staging a restore, and a container killed
    // mid-stage leaves it behind holding a hard-linked (or copied) backup payload. Same age
    // constant, same "only removed once nothing could still be writing it" reasoning.
    if (stats.isDirectory()) {
      if (aged && (entry.endsWith('-archive') || entry.endsWith('-restore'))) {
        fs.rmSync(file, { recursive: true, force: true });
        removed += 1;
      }
      continue;
    }
    if (aged) {
      fs.rmSync(file, { force: true });
      removed += 1;
      if (STAGED_IMPORT_RE.test(entry)) swept.add(entry.slice(0, -'.csv'.length));
    }
  }
  // An owner record leaves with its staged file, or once it is old enough when its file is gone.
  for (const entry of ownerRecords) {
    const stagingId = IMPORT_OWNER_RE.exec(entry)![1]!;
    const record = path.join(dir, entry);
    if (fs.existsSync(path.join(dir, `${stagingId}.csv`))) continue;
    if (!swept.has(stagingId)) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(record);
      } catch {
        continue;
      }
      if (now.getTime() - stats.mtimeMs <= olderThanMs) continue;
    }
    fs.rmSync(record, { force: true });
  }
  return removed;
}
