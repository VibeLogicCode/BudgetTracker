/**
 * Shared restore logic for BOTH the CLI (scripts/restore-backup.ts, run under
 * `node --experimental-strip-types` outside any bundler) and the app-side boot hook
 * (src/lib/backup/restore.ts, bundled into Next's server build). Neither side may import
 * the other, so this module is the third party both of them import instead (MUST-20.4):
 *
 *   - alias-free: only `node:*`, `better-sqlite3`, `tar`, and relative siblings. No `@/…`
 *     import may ever appear here — tests/ops/restore-seams.test.ts pins that with a source
 *     scan, not a convention.
 *   - parameterised, never environment-reading: every exported function that needs a path
 *     takes it as an argument. Nothing here calls readEnv(), reads process.env, or calls
 *     process.cwd().
 *   - erasable-syntax only: no enum, no namespace, no parameter properties, because
 *     `--experimental-strip-types` erases types rather than compiling them.
 *
 * Every consumer imports this file with the explicit '.ts' extension: Node's type-stripping
 * loader does no extension resolution, and Vitest/webpack both accept the explicit extension
 * too, so one specifier works for all three.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as tar from 'tar';
// O-04: the comparison, the journal reader and the applied-migration reader now live in one leaf
// module that src/db/client.ts can also reach (it cannot import THIS file -- `tar` and the whole
// restore machinery have no business in the boot path). The wrappers below keep MUST-20.12: every
// error that can reach restore-result.json is still a written, operator-readable RestoreError.
import {
  MigrationJournalError,
  isNewerThanCode,
  readAppliedMigrationCounts,
  readLocalMigrationCounts,
} from '../src/lib/db/migration-state.ts';

/** Must stay identical to STORED_NAME_RE in src/lib/warranty/receipts.ts. */
export const RESTORE_STORED_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$/;

/** An archive lists at most this many entries (budget.db, receipts/ and the receipt files). */
export const MAX_ARCHIVE_ENTRIES = 200_000;
/** Free space that must remain on the data volume after an archive is unpacked. */
export const RESTORE_HEADROOM_BYTES = 100 * 1024 * 1024;
/** A refusal names at most this many entries, each cut to this many characters. */
export const MAX_LISTED_PROBLEMS = 5;
export const MAX_LISTED_NAME_CHARS = 100;
/** Operator-readable restore text is cut to this many characters. */
export const MAX_RESTORE_TEXT_CHARS = 1000;

/** Control characters removed (line breaks included), then cut to `max` characters. */
export function cleanRestoreText(text: string, max: number = MAX_RESTORE_TEXT_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/** Free bytes on the volume holding `dir`, using the nearest directory that exists. */
export function freeBytesAt(dir: string): number {
  let probe = path.resolve(dir);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const stats = fs.statfsSync(probe);
  return stats.bavail * stats.bsize;
}

export type ArtifactKind = 'archive' | 'sqlite' | 'unknown';

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreResult {
  kind: ArtifactKind;
  databaseRestored: boolean;
  receiptsRestored: number;
  /** The directory the previous receipts/ was renamed to, or null when there was none. */
  receiptsMovedAside: string | null;
  /** Best-effort (see safeCountMissingReceiptRows): also 0 when the post-commit count itself
   *  failed, not only when nothing is genuinely missing. Never gates anything — reported only. */
  missingReceiptRows: number;
  /** How many pre-existing receipt files had their mtime re-armed to "now" after a bare-db restore. */
  receiptsTouched: number;
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/** MUST-12.5: format detection is by magic bytes, NEVER by file extension. */
export function detectArtifactKind(filePath: string): ArtifactKind {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'archive';
  if (read >= 16 && head.toString('binary') === SQLITE_MAGIC) return 'sqlite';
  return 'unknown';
}

/**
 * MUST-12.6, tar-slip defence: extraction accepts ONLY the entry `budget.db` (a File),
 * `receipts` (a Directory), and entries matching `receipts/<STORED_NAME_RE>` (each a File).
 * Absolute paths, `..` segments, symlinks, hardlinks, device nodes, a `budget.db` that is
 * itself a directory, a `receipts` that is itself a plain file, and anything else abort the
 * whole restore. This runs as a FIRST PASS over the archive listing, before a single byte is
 * written, so "reject" really does mean "abort" and not "skip". node-tar's own protections
 * are relied on IN ADDITION TO this allow-list.
 *
 * MUST-20.4: this is the same function, moved — not a second copy of the tar-slip defence.
 */
export function assertArchiveEntriesAreSafe(artifactPath: string, opts: { freeBytes?: number; maxEntries?: number } = {}): void {
  const problems: string[] = [];
  let problemCount = 0;
  const flag = (text: string): void => {
    problemCount += 1;
    if (problems.length < MAX_LISTED_PROBLEMS) problems.push(cleanRestoreText(text, MAX_LISTED_NAME_CHARS));
  };
  const maxEntries = opts.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const seen = new Set<string>();
  let entryCount = 0;
  let expandedBytes = 0;
  tar.list({
    file: artifactPath,
    sync: true,
    onReadEntry: (entry) => {
      entryCount += 1;
      // Past the cap the archive is refused whatever else it holds: stop tracking names so a huge
      // listing cannot grow `seen` or the problem list, and flag it once.
      if (entryCount > maxEntries) {
        if (entryCount === maxEntries + 1) flag(`more than ${maxEntries} entries`);
        return;
      }
      if (entry.type === 'File') expandedBytes += Number(entry.size ?? 0);
      const name = entry.path.replace(/\/+$/, '');
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        flag(`${entry.path} (${entry.type})`);
        return;
      }
      if (path.isAbsolute(name) || name.split('/').includes('..')) {
        flag(entry.path);
        return;
      }
      if (seen.has(name)) {
        flag(`${entry.path} (repeated)`);
        return;
      }
      seen.add(name);
      if (name === 'budget.db') {
        if (entry.type !== 'File') flag(`${entry.path} (expected a file)`);
        return;
      }
      if (name === 'receipts') {
        if (entry.type !== 'Directory') flag(`${entry.path} (expected a directory)`);
        return;
      }
      const match = /^receipts\/(.+)$/.exec(name);
      if (match === null || !RESTORE_STORED_NAME_RE.test(match[1]) || entry.type !== 'File') {
        flag(entry.path);
      }
    },
  });
  if (entryCount > maxEntries) {
    throw new RestoreError('That archive holds too many entries to restore. Nothing was changed.');
  }
  if (problemCount > 0) {
    const more = problemCount > problems.length ? `, and ${problemCount - problems.length} more` : '';
    throw new RestoreError(`Refusing to extract unexpected archive entries: ${problems.join(', ')}${more}`);
  }
  const free = opts.freeBytes ?? freeBytesAt(path.dirname(path.resolve(artifactPath)));
  if (expandedBytes + RESTORE_HEADROOM_BYTES > free) {
    throw new RestoreError('That archive would not fit on the data volume once unpacked. Nothing was changed.');
  }
}

/** MUST-12.9: how many warranty_receipts rows point at a file that is not on disk. */
function countMissingReceiptRows(databasePath: string, receiptsPath: string): number {
  const db = new Database(databasePath, { readonly: true });
  try {
    const table = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'warranty_receipts'")
      .get();
    if (!table) return 0; // a genuine v1.0.0 artifact has no such table
    const rows = db.prepare('select stored_filename from warranty_receipts').all() as {
      stored_filename: string;
    }[];
    return rows.filter((row) => !fs.existsSync(path.join(receiptsPath, row.stored_filename))).length;
  } finally {
    db.close();
  }
}

/**
 * Wraps countMissingReceiptRows() so a failure in it can never be mistaken for the restore
 * itself failing. This call runs from inside commitRestore(), strictly AFTER every restore
 * step has already renamed its files into place — the point of no return has long since
 * passed, and its result feeds nothing but a reported statistic (a source grep confirms it:
 * the RestoreResult/RestoreOutcome JSON, one notification line in src/lib/notify/render.ts,
 * and one CLI console.log in restore-backup.ts — nothing anywhere branches on it).
 *
 * Left unguarded, a throw here (the just-renamed budget.db momentarily locked, or a corrupt
 * page making better-sqlite3's own open() throw) propagates out of commitRestore() and is
 * caught by the app boot hook's runCommitAttempt(), whose try block exists to catch failures
 * IN THE COMMIT ITSELF — misreporting a restore that already, correctly, fully completed as a
 * failed commit attempt and signalling 'restart' (see runCommitAttempt()'s docblock,
 * src/lib/backup/restore.ts). Repeated across MAX_COMMIT_ATTEMPTS boots, that becomes a FAILED
 * restore whose recovery text tells the operator to roll a good database back — the worst
 * outcome a data-recovery path can produce. The same throw also reaches the CLI's
 * restoreFromArtifact() caller (scripts/restore-backup.ts's main().catch), which would exit 1
 * and print an error for a restore that had, in fact, already succeeded.
 *
 * Reports 0 on failure, console.warn'ing in this module's existing log style, rather than
 * widening RestoreResult['missingReceiptRows'] to a `number | null` that distinguishes
 * "genuinely none missing" from "could not count": this module is deliberately alias-free and
 * shared by both the CLI and the app (MUST-20.4), and that field is threaded, as a plain
 * number, into RestoreOutcome and its zod schema, src/lib/notify/render.ts and raise.ts, and
 * the backups UI — none of which restore-core.ts may import into or should have to change for
 * a best-effort statistic. An operator who needs to know the difference has the warn line in
 * the server log.
 */
function safeCountMissingReceiptRows(databasePath: string, receiptsPath: string): number {
  try {
    return countMissingReceiptRows(databasePath, receiptsPath);
  } catch (error) {
    console.warn('[restore] could not count missing receipt rows after a successful commit; reporting 0', error);
    return 0;
  }
}

/**
 * MUST-4.9 / MUST-12.9's mtime re-arm: re-arms purgeOrphanReceipts' 24 h grace window for
 * every file already sitting in receiptsPath, by stamping its mtime to `now`.
 *
 * Without this, a bare-db restore replaces budget.db with a snapshot that references few or
 * zero receipt files — by design (MUST-12.9) receipts/ itself is left completely untouched —
 * while every file already in that directory keeps whatever mtime it had before the restore,
 * which after any real amount of uptime is well past 24 h old. The very next nightly
 * runMaintenanceSweep() then calls purgeOrphanReceipts() with that freshly-restored
 * (near-empty) known set, and every one of those "too old" files reads as an orphan.
 * Stamping every file's mtime to "now" buys the operator time to reconcile.
 *
 * `fs.utimesSync` is wrapped per-file in its own try/catch so one EPERM/read-only file does
 * not throw after the restore has otherwise succeeded; `receiptsTouched` counts only the
 * files actually touched.
 */
export function touchReceiptFiles(receiptsPath: string, now: Date): number {
  if (!fs.existsSync(receiptsPath)) return 0;
  let touched = 0;
  for (const entry of fs.readdirSync(receiptsPath)) {
    const file = path.join(receiptsPath, entry);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.utimesSync(file, now, now);
      touched += 1;
    } catch (error) {
      console.warn(`[restore] could not refresh mtime on ${entry}, skipping:`, error);
    }
  }
  return touched;
}

const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * v1.63.0: read in 1 MiB pieces, never the whole file. fs.readFileSync held the archive in memory
 * and refuses any file over 2 GiB, so a large backup could not be staged or revalidated at boot.
 * Still synchronous: both callers (staging and the boot hook) are synchronous.
 */
export function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(HASH_CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export interface MigrationCounts {
  count: number;
  maxWhen: number;
}

export function readLocalMigrations(migrationsFolder: string): MigrationCounts {
  // MUST-20.12: every error that can end up in restore-result.json must be a written,
  // operator-readable RestoreError, never a raw ENOENT/parse SyntaxError bubbling up from a
  // filesystem primitive. The leaf module throws MigrationJournalError; the two messages below are
  // unchanged from when the reading lived here.
  try {
    return readLocalMigrationCounts(migrationsFolder);
  } catch (error) {
    if (error instanceof MigrationJournalError) {
      throw new RestoreError(
        error.message.includes('valid JSON')
          ? 'The local migrations journal is not valid JSON. The installation may be corrupted.'
          : 'Could not read the local migrations journal. The installation may be corrupted.',
      );
    }
    throw error;
  }
}

export function readAppliedMigrations(databasePath: string): MigrationCounts {
  // Opens its own read-only handle because the restore path is asked about a file it does not have
  // open. The boot path calls the leaf module directly with the connection it already has.
  const db = new Database(databasePath, { readonly: true });
  try {
    return readAppliedMigrationCounts(db);
  } finally {
    db.close();
  }
}

/**
 * The RESTORE path's phrasing of the shared question — "is this ARCHIVE newer than the code?" —
 * where src/db/client.ts asks it of the live database at boot. One rule (isNewerThanCode, in
 * src/lib/db/migration-state.ts), two call sites, two messages, because "restore a backup made by
 * this version" is the wrong instruction when there is no backup in play and vice versa.
 */
export function assertNotNewerThanCode(databasePath: string, migrationsFolder: string): number {
  const local = readLocalMigrations(migrationsFolder);
  const backup = readAppliedMigrations(databasePath);
  if (isNewerThanCode(backup, local)) {
    throw new RestoreError(
      `This backup was made by a newer version of Budget Tracker than the one running ` +
        `(it carries ${backup.count} applied migrations; this version ships ${local.count}). ` +
        `Upgrade the app first, then restore. Nothing was changed.`,
    );
  }
  return backup.count;
}

/**
 * Controller ruling (T1 review): the one-way guard is a real safety property for the GUI/boot
 * path, which must never be bypassable — but it is also the one thing that can strand an
 * operator who has deliberately rolled the running image back to recover from a bad upgrade
 * and now needs their most recent (newer-schema) backup back. `allowNewer` exists ONLY on the
 * CLI disaster path (scripts/restore-backup.ts's `--allow-newer` flag, default off); the app
 * side (src/lib/backup/restore.ts) never sets it, so the GUI/boot guard cannot be bypassed.
 */
function appliedMigrationsFor(databasePath: string, migrationsFolder: string, allowNewer: boolean | undefined): number {
  if (allowNewer) return readAppliedMigrations(databasePath).count;
  return assertNotNewerThanCode(databasePath, migrationsFolder);
}

const schemaObjectKey = (type: string, name: string, sqlText: string | null): string =>
  `${type}:${name}:${(sqlText ?? '').replace(/\s+/g, ' ').trim()}`;

const referenceObjectCache = new Map<string, Set<string>>();

/**
 * Every trigger and view (type, name, SQL) that the local migrations create at ANY step: the
 * migrations are applied one at a time to an in-memory database and what exists after each step is
 * collected, so a backup made at an older step still matches. Cached per folder for the process.
 */
function referenceTriggersAndViews(migrationsFolder: string): Set<string> {
  const cached = referenceObjectCache.get(migrationsFolder);
  if (cached !== undefined) return cached;
  const found = new Set<string>();
  let tags: string[];
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries?: { tag: string }[];
    };
    tags = (journal.entries ?? []).map((entry) => entry.tag);
  } catch {
    throw new RestoreError('Could not read the local migrations journal. The installation may be corrupted.');
  }
  const memory = new Database(':memory:');
  try {
    for (const tag of tags) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
      } catch {
        throw new RestoreError('Could not read a local migration. The installation may be corrupted.');
      }
      for (const statement of text.split('--> statement-breakpoint')) memory.exec(statement);
      const rows = memory
        .prepare("select type, name, sql from sqlite_master where type in ('trigger', 'view')")
        .all() as { type: string; name: string; sql: string | null }[];
      for (const row of rows) found.add(schemaObjectKey(row.type, row.name, row.sql));
    }
  } finally {
    memory.close();
  }
  referenceObjectCache.set(migrationsFolder, found);
  return found;
}

/** Refuses an incoming database holding a trigger or view that no local migration creates. */
function assertOnlyKnownTriggersAndViews(db: Database.Database, migrationsFolder: string): void {
  const rows = db.prepare("select type, name, sql from sqlite_master where type in ('trigger', 'view')").all() as {
    type: string;
    name: string;
    sql: string | null;
  }[];
  if (rows.length === 0) return;
  const known = referenceTriggersAndViews(migrationsFolder);
  const unknown = rows.filter((row) => !known.has(schemaObjectKey(row.type, row.name, row.sql)));
  if (unknown.length === 0) return;
  const listed = unknown.slice(0, MAX_LISTED_PROBLEMS).map((row) => cleanRestoreText(`${row.type} ${row.name}`, MAX_LISTED_NAME_CHARS));
  const more = unknown.length > listed.length ? `, and ${unknown.length - listed.length} more` : '';
  throw new RestoreError(
    `That backup's database holds triggers or views this version does not create (${listed.join(', ')}${more}). Nothing was changed.`,
  );
}

const REQUIRED_TABLES = ['users', 'accounts', 'transactions'] as const;

/**
 * MUST-20.14 step 5. Three checks, in increasing cost:
 *   1. magic bytes — a well-formed tar can carry a `budget.db` File entry full of garbage;
 *   2. PRAGMA quick_check — the same class of answer as integrity_check in a fraction of the
 *      time on a multi-gigabyte database, on a path an operator is watching a spinner for;
 *   3. three tables that have existed since 0000_init and will not be renamed — i.e. this is
 *      A BUDGET TRACKER DATABASE, not some other SQLite file that got renamed budget.db.
 */
export function preflightSqliteFile(databasePath: string, migrationsFolder?: string): void {
  if (detectArtifactKind(databasePath) !== 'sqlite') {
    throw new RestoreError("The archive's budget.db is not a valid SQLite database. Nothing was changed.");
  }
  const db = new Database(databasePath, { readonly: true });
  try {
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') {
      throw new RestoreError(`That backup's database failed an integrity check (${String(check)}). Nothing was changed.`);
    }
    const names = new Set(
      (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
    if (missing.length > 0) {
      throw new RestoreError(
        `That file is a SQLite database but not a usable Budget Tracker database (missing: ${missing.join(', ')}). Nothing was changed.`,
      );
    }
    if (migrationsFolder !== undefined) assertOnlyKnownTriggersAndViews(db, migrationsFolder);
  } finally {
    db.close();
  }
}

export interface ValidationReport {
  kind: 'archive' | 'sqlite';
  bytes: number;
  sha256: string;
  receiptCount: number;
  appliedMigrations: number;
}

/**
 * MUST-20.14: the complete check set, run in order, all fatal. Called twice in the app flow —
 * once by the server action before staging, once again by the boot hook before applying —
 * because the payload has survived a process restart and a filesystem in between by the
 * second call.
 */
export function validateArtifact(
  artifactPath: string,
  opts: { scratchDir: string; migrationsFolder: string; allowNewerMigrations?: boolean; freeBytes?: number },
): ValidationReport {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(artifactPath);
  } catch {
    throw new RestoreError(`No such backup: ${path.basename(artifactPath)}`);
  }
  if (!stats.isFile()) throw new RestoreError('That backup is not a regular file. Nothing was changed.');
  if (stats.size === 0) throw new RestoreError('That backup is empty. Nothing was changed.');

  const kind = detectArtifactKind(artifactPath);
  if (kind === 'unknown') {
    throw new RestoreError(
      'That file is neither a .tar.gz archive nor a SQLite backup. Nothing was changed.',
    );
  }

  if (kind === 'sqlite') {
    preflightSqliteFile(artifactPath, opts.migrationsFolder);
    return {
      kind,
      bytes: stats.size,
      sha256: sha256File(artifactPath),
      receiptCount: 0,
      appliedMigrations: appliedMigrationsFor(artifactPath, opts.migrationsFolder, opts.allowNewerMigrations),
    };
  }

  // MUST-12.6, before a byte is written. The space check is against the volume the scratch
  // directory lives on, unless the caller passes the free bytes it already measured.
  assertArchiveEntriesAreSafe(artifactPath, { freeBytes: opts.freeBytes ?? freeBytesAt(opts.scratchDir) });
  fs.mkdirSync(opts.scratchDir, { recursive: true });
  const probe = path.join(opts.scratchDir, 'validate');
  try {
    fs.rmSync(probe, { recursive: true, force: true });
    fs.mkdirSync(probe, { recursive: true });
    tar.extract({ file: artifactPath, cwd: probe, sync: true, preservePaths: false, strip: 0 });
    const inner = path.join(probe, 'budget.db');
    if (!fs.existsSync(inner)) throw new RestoreError('The archive contains no budget.db.');
    preflightSqliteFile(inner, opts.migrationsFolder);
    const receipts = path.join(probe, 'receipts');
    const receiptCount = fs.existsSync(receipts)
      ? fs.readdirSync(receipts).filter((name) => RESTORE_STORED_NAME_RE.test(name)).length
      : 0;
    return {
      kind,
      bytes: stats.size,
      sha256: sha256File(artifactPath),
      receiptCount,
      appliedMigrations: appliedMigrationsFor(inner, opts.migrationsFolder, opts.allowNewerMigrations),
    };
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * v1.60.0: the nightly job's check of an archive it has just written, run on the `.partial` before
 * it replaces anything (src/lib/backup/archive.ts's buildArchive). assertArchiveEntriesAreSafe
 * reads the whole gzip stream, so a truncated or corrupt archive fails there; then budget.db alone
 * is extracted into scratchDir and preflighted (magic bytes and quick_check). Receipts are listed,
 * never written out. scratchDir is removed whatever the outcome.
 *
 * No migration comparison, unlike validateArtifact: an archive this install has just made carries
 * exactly this install's migrations.
 */
export function verifyArchive(artifactPath: string, scratchDir: string): void {
  try {
    if (detectArtifactKind(artifactPath) !== 'archive') {
      throw new RestoreError('The file is not a gzip archive.');
    }
    // Only budget.db is written out here, so the unpacked-size gate does not apply.
    assertArchiveEntriesAreSafe(artifactPath, { freeBytes: Number.POSITIVE_INFINITY });
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    tar.extract({
      file: artifactPath,
      cwd: scratchDir,
      sync: true,
      preservePaths: false,
      strip: 0,
      filter: (entryPath) => entryPath.replace(/\/+$/, '') === 'budget.db',
    });
    const inner = path.join(scratchDir, 'budget.db');
    if (!fs.existsSync(inner)) throw new RestoreError('The archive contains no budget.db.');
    preflightSqliteFile(inner);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

export type RestoreStep =
  | {
      op: 'rename';
      from: string;
      to: string;
      optional?: boolean;
      /**
       * T1 review fix (CRITICAL 1a): true for the two steps whose `from` lives inside this
       * plan's `work/` scratch directory (the incoming database/receipts). Tagged explicitly
       * at plan time, not inferred at replay time, because the replay RULE differs by kind —
       * see runStep()'s docblock.
       */
      incoming?: boolean;
    }
  | { op: 'touch-receipts'; dir: string };

export interface RestorePlan {
  version: 1;
  stamp: string;
  kind: 'archive' | 'sqlite';
  steps: RestoreStep[];
  attempts: number;
  receiptsRestored: number;
  safetyCopy: string | null;
  receiptsMovedAside: string | null;
}

/**
 * v1.58.1: a restore installs the backup's users, passwords and two-factor settings wholesale, so a
 * session row carried inside the backup must not keep working. Deletes every session row from the
 * INCOMING copy under work/, before commit.json exists:
 *   - the live path is never opened here (opening an absent budget.db creates an empty one, the
 *     impostor runStep's incoming rule guards against);
 *   - a failure is a prepare failure, so nothing under dataDir has moved;
 *   - a resumed commit installs the already-purged file, and a re-run prepare purges a fresh copy.
 * journal_mode=DELETE folds any WAL content into the main file, so the single-file rename that
 * installs it carries the deletion and leaves no sidecar behind in work/.
 */
function purgeIncomingSessions(incomingDbPath: string): void {
  try {
    const db = new Database(incomingDbPath, { fileMustExist: true });
    try {
      const mode = db.pragma('journal_mode = DELETE', { simple: true });
      if (mode !== 'delete') throw new RestoreError(`journal mode stayed ${String(mode)}`);
      const table = db.prepare("select name from sqlite_master where type = 'table' and name = 'sessions'").get();
      if (table) db.prepare('delete from sessions').run();
    } finally {
      db.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RestoreError(`Could not sign everyone out of the backup's database (${detail}). Nothing was changed.`);
  }
}

/**
 * MUST-20.7: builds a RestorePlan by validating the artifact and constructing the INCOMING
 * files entirely inside scratchDir — `dataDir` is only ever read here (existence checks, to
 * decide which safety-copy renames apply and to compute the report fields below), never
 * written. That is what makes the crash-safety argument in commitRestore() sound: everything
 * this function does can be safely abandoned with `rm -rf scratchDir` and nothing under
 * `dataDir` will have moved.
 */
export function prepareRestore(
  artifactPath: string,
  opts: {
    dataDir: string;
    scratchDir: string;
    migrationsFolder: string;
    now: Date;
    /** CLI disaster-path only (controller ruling) — see appliedMigrationsFor()'s docblock.
     *  The app/boot path never sets this. */
    allowNewerMigrations?: boolean;
  },
): RestorePlan {
  const dataDir = path.resolve(opts.dataDir);
  const scratchDir = path.resolve(opts.scratchDir);
  const stamp = opts.now.toISOString().replace(/[:.]/g, '-');

  // Validation runs first and is what actually enforces MUST-20.14; if it throws, nothing
  // below has run and nothing under scratchDir or dataDir has been created or touched.
  const report = validateArtifact(artifactPath, {
    scratchDir: path.join(scratchDir, 'validate-probe'),
    migrationsFolder: opts.migrationsFolder,
    allowNewerMigrations: opts.allowNewerMigrations,
  });

  const workDir = path.join(scratchDir, 'work');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const incomingDb = path.join(workDir, 'budget.db.incoming');
  const incomingReceipts = path.join(workDir, 'receipts.incoming');
  let receiptsRestored = 0;

  if (report.kind === 'archive') {
    // validateArtifact() already ran assertArchiveEntriesAreSafe() and cleaned up its own
    // probe extraction in a finally, so this is a fresh, independent extraction — not a
    // second copy of the tar-slip check, just a second look at the same already-vetted bytes.
    tar.extract({ file: artifactPath, cwd: workDir, sync: true, preservePaths: false, strip: 0 });
    fs.renameSync(path.join(workDir, 'budget.db'), incomingDb);
    const extractedReceipts = path.join(workDir, 'receipts');
    fs.mkdirSync(incomingReceipts, { recursive: true });
    if (fs.existsSync(extractedReceipts)) {
      for (const entry of fs.readdirSync(extractedReceipts)) {
        if (!RESTORE_STORED_NAME_RE.test(entry)) continue;
        fs.renameSync(path.join(extractedReceipts, entry), path.join(incomingReceipts, entry));
        receiptsRestored += 1;
      }
    }
  } else {
    fs.copyFileSync(artifactPath, incomingDb);
  }
  purgeIncomingSessions(incomingDb);

  const dbTarget = path.join(dataDir, 'budget.db');
  const receiptsTarget = path.join(dataDir, 'receipts');
  const dbExisted = fs.existsSync(dbTarget);
  const receiptsExisted = report.kind === 'archive' && fs.existsSync(receiptsTarget);

  const safetyCopy = dbExisted ? `budget.pre-restore-${stamp}.db` : null;
  const receiptsMovedAside = receiptsExisted ? `receipts.pre-restore-${stamp}` : null;

  // MUST-20.21, in this exact order.
  const steps: RestoreStep[] = [
    { op: 'rename', from: dbTarget, to: path.join(dataDir, `budget.pre-restore-${stamp}.db`), optional: true },
    { op: 'rename', from: `${dbTarget}-wal`, to: path.join(dataDir, `budget.pre-restore-${stamp}.db-wal`), optional: true },
    { op: 'rename', from: `${dbTarget}-shm`, to: path.join(dataDir, `budget.pre-restore-${stamp}.db-shm`), optional: true },
  ];

  if (report.kind === 'archive') {
    // MUST-12.8: the existing receipts/ is renamed aside, never deleted.
    steps.push({ op: 'rename', from: receiptsTarget, to: path.join(dataDir, `receipts.pre-restore-${stamp}`), optional: true });
    steps.push({ op: 'rename', from: incomingReceipts, to: receiptsTarget, incoming: true });
    steps.push({ op: 'rename', from: incomingDb, to: dbTarget, incoming: true });
  } else {
    steps.push({ op: 'rename', from: incomingDb, to: dbTarget, incoming: true });
    // MUST-12.9: receipts/ is never renamed, emptied or modified on a bare-db restore —
    // only its files' mtimes are re-armed, and only after the database itself is in place.
    steps.push({ op: 'touch-receipts', dir: receiptsTarget });
  }

  return {
    version: 1,
    stamp,
    kind: report.kind,
    steps,
    attempts: 0,
    receiptsRestored,
    safetyCopy,
    receiptsMovedAside,
  };
}

/**
 * MUST-20.22. Idempotency is decided from the FILESYSTEM, never from a flag inside the
 * journal: a flag written after the rename has its own crash window, and a flag written
 * before it lies. Two DIFFERENT replay rules, by step KIND — tagged at plan time
 * (`step.incoming`), not inferred, because inferring it from path shape is exactly the bug
 * a T1 review caught:
 *
 * - **Safety-copy steps** (current live path → `*.pre-restore-<stamp>`, `incoming` absent):
 *   `to` is checked FIRST. A later INCOMING step's `to` reuses this step's `from` path (step 1
 *   moves `budget.db` out of the way; the last step renames the incoming database back to
 *   that same path), so by the time a full replay reaches here a second time, `from` may have
 *   been repopulated with the NEW content while this step's own `to` (the safety copy)
 *   already exists from the first run. Checking `to` first recognises "already done"
 *   regardless of what has since moved back into `from`'s place — this is what makes
 *   `commitRestore()` safe to call twice on an already-fully-applied plan.
 * - **Incoming steps** (`work/*.incoming` → the live path, `incoming: true`): `from` is
 *   checked FIRST instead, and — this is the fix — a stale `to` is unconditionally CLEARED
 *   before the rename, never trusted as "already done" on its own. Nothing legitimate can
 *   recreate an incoming step's `from` once it is gone (it lives under this plan's private
 *   `work/` scratch dir), so `from` existing is a completely reliable "not done yet" signal.
 *   The reverse is NOT reliable: if a boot ever continues past a failed, non-exhausted commit
 *   attempt and reaches `getDb()` (it must not — see src/lib/backup/restore.ts's
 *   `applyStagedRestoreOnBoot()` contract), `getDb()` will CREATE an empty `budget.db` at
 *   exactly this step's `to`. A naive `to`-exists-means-done check would then skip installing
 *   the real payload forever, reporting success over an empty database. Checking `from` first
 *   and clearing `to` closes that hole even if the "must not reach getDb()" contract is ever
 *   violated by a caller.
 *
 * touch-receipts always re-touches: it is idempotent by construction (re-stamping an mtime
 * that is already "now" is a no-op in effect). It uses the `now` passed to commitRestore()
 * (defaulting to the real wall clock), not a value captured at plan time, because the grace
 * window it re-arms (MUST-4.9) is measured from whenever the restore actually completes.
 */
function runStep(step: RestoreStep, now: Date): number {
  if (step.op === 'touch-receipts') {
    return touchReceiptFiles(step.dir, now);
  }
  if (step.incoming) {
    if (fs.existsSync(step.from)) {
      fs.rmSync(step.to, { recursive: true, force: true });
      // T1 re-review D1: clearing `to` is not enough if `to` was an impostor SQLite
      // database created in WAL mode (e.g. by a boot that wrongly reached getDb() after a
      // failed, non-exhausted commit) and then died uncleanly — its -wal/-shm sidecars
      // survive the rmSync above, sitting at these exact paths, and SQLite replays a -wal
      // over whatever file it finds at its matching main-file path the moment that path is
      // next opened. Left in place, the impostor's -wal would silently overwrite the REAL
      // payload we are about to install here, and PRAGMA quick_check would still report
      // "ok" afterward (the merged result is structurally valid, just wrong). This is safe
      // unconditionally: any LEGITIMATE -wal/-shm for the path this step replaces was
      // already relocated by the earlier safety-copy steps (their own `rename` ops target
      // `*.pre-restore-<stamp>.db-wal`/`-shm`), and the receipts incoming step's `to` has no
      // such sidecars to begin with, making this a harmless no-op there.
      fs.rmSync(`${step.to}-wal`, { force: true });
      fs.rmSync(`${step.to}-shm`, { force: true });
      fs.renameSync(step.from, step.to);
      return 0;
    }
    if (fs.existsSync(step.to)) return 0;
    if (step.optional) return 0;
    throw new RestoreError(`Restore step cannot be replayed: neither ${step.from} nor ${step.to} exists.`);
  }
  if (fs.existsSync(step.to)) return 0;
  if (fs.existsSync(step.from)) {
    fs.renameSync(step.from, step.to);
    return 0;
  }
  if (step.optional) return 0;
  throw new RestoreError(`Restore step cannot be replayed: neither ${step.from} nor ${step.to} exists.`);
}

/**
 * Replays plan.steps in order. Every step is individually idempotent (see runStep), so
 * calling this twice on the same plan — or once after a previous call was interrupted
 * partway through — converges to the same final state. This is the half of the crash-safety
 * argument that runs AFTER commit.json exists (the point of no return); the half that runs
 * BEFORE it is prepareRestore()'s "writes nothing outside scratchDir" property.
 */
export function commitRestore(plan: RestorePlan, opts: { dataDir: string; now?: Date }): RestoreResult {
  const dataDir = path.resolve(opts.dataDir);
  const now = opts.now ?? new Date();
  let receiptsTouched = 0;
  for (const step of plan.steps) {
    const touched = runStep(step, now);
    if (step.op === 'touch-receipts') receiptsTouched = touched;
  }
  const dbPath = path.join(dataDir, 'budget.db');
  const receiptsPath = path.join(dataDir, 'receipts');
  return {
    kind: plan.kind,
    databaseRestored: true,
    receiptsRestored: plan.receiptsRestored,
    receiptsMovedAside: plan.receiptsMovedAside,
    missingReceiptRows: safeCountMissingReceiptRows(dbPath, receiptsPath),
    receiptsTouched,
  };
}

/**
 * scripts/restore-core.ts lives at <root>/scripts/restore-core.ts; 'drizzle' is a sibling of
 * scripts/. Resolved from import.meta.url rather than process.cwd(), so it is correct
 * regardless of the working directory the CLI happens to be invoked from, and this file never
 * needs to call process.cwd() at all (MUST-20.4).
 */
function defaultMigrationsFolder(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

/**
 * MUST-20.7: restoreFromArtifact() is prepareRestore() + commitRestore() + `rm -rf` the
 * scratch dir in a finally, and is re-expressed in these terms so the CLI's observable
 * behaviour is bit-for-bit what it was before the split. Signature and behaviour unchanged
 * from v1.1.0: this is the function tests/scripts/restore-backup.test.ts exercises, and that
 * file must keep passing without a single edit.
 */
export function restoreFromArtifact(
  artifactPath: string,
  opts: {
    dataDir: string;
    now?: Date;
    /** CLI-only (`--allow-newer`, controller ruling): bypasses the one-way migration guard
     *  for an operator who has deliberately rolled the running image back. Never set by the
     *  app/boot path. */
    allowNewerMigrations?: boolean;
  },
): RestoreResult {
  const now = opts.now ?? new Date();
  const dataDir = path.resolve(opts.dataDir);
  const scratch = path.join(dataDir, `.restore-${now.toISOString().replace(/[:.]/g, '-')}`);
  try {
    const plan = prepareRestore(artifactPath, {
      dataDir,
      scratchDir: scratch,
      migrationsFolder: defaultMigrationsFolder(),
      now,
      allowNewerMigrations: opts.allowNewerMigrations,
    });
    // Passing `now` through means commitRestore's single touch-receipts pass uses the exact
    // value the CALLER supplied (tests/scripts/restore-backup.test.ts asserts an exact mtime)
    // rather than a second, separate re-touch pass — one touch, one clock, for every caller.
    return commitRestore(plan, { dataDir, now });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
