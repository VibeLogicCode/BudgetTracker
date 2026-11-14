/**
 * v1.63.0: restoring a backup uploaded from the browser, for moving to a new machine.
 *
 * The file arrives in pieces (R1 in docs/superpowers/plans/2026-11-12-v1.63.0-year-end-and-sharing.md):
 * Next keeps only the first 10 MB of a request body that src/proxy.ts runs on, and Node ends a
 * request still uploading after 300 s. So the browser starts a session, sends 8 MiB pieces at
 * explicit offsets, then finishes. Finishing hands the payload to stageUploadedRestore(), the same
 * staging core a listed backup goes through (full validation, marker, one rename); the boot hook
 * then revalidates and applies it exactly like a listed one.
 *
 * A session is DATA_DIR/tmp/<uuid>-restore/ holding `payload` and `upload.json`. The `-restore`
 * suffix means the nightly sweep (purgeStagedFiles) removes an abandoned one after 24 hours; a
 * session idle for an hour is refused, and removed by the next start. No path ever comes from the
 * client: the id must be a UUID and the directory is built here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from '@/lib/zod';
import { tempDir } from '@/lib/backup/archive';
import {
  RESTORE_TMP_DIR_RE,
  RestoreError,
  isRestorePending,
  stageUploadedRestore,
  writeJsonAtomically,
  type RestoreRequest,
} from '@/lib/backup/restore';

/** Owner decision (2026-11-12): 4 GB. A larger archive goes through the restore-backup command. */
export const RESTORE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Under the proxy's 10 MB body clone, and seconds per piece on a slow link. */
export const RESTORE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const RESTORE_UPLOAD_IDLE_MS = 60 * 60 * 1000;
/** Owner decision: three times the archive's size free (the upload, then the two extractions
 *  staging and the boot hook make), plus this much room for the app to keep working. */
export const RESTORE_UPLOAD_HEADROOM_BYTES = 100 * 1000 * 1000;

const SESSION_FILE = 'upload.json';
const PAYLOAD_FILE = 'payload';
const ALREADY_STAGED = 'A restore is already staged; restart the app to apply it.';
const NOT_FOUND = 'That upload was not found. Start it again.';

export type RestoreUploadStatus = 400 | 404 | 409 | 413 | 422 | 507;

/** A refusal with a written sentence and the HTTP status the routes send it with. `received` is
 *  the payload's size when the refusal is about where the upload stands, so the browser can resume. */
export class RestoreUploadError extends Error {
  readonly status: RestoreUploadStatus;
  readonly received: number | null;

  constructor(message: string, status: RestoreUploadStatus, received: number | null = null) {
    super(message);
    this.name = 'RestoreUploadError';
    this.status = status;
    this.received = received;
  }
}

export interface RestoreUploadUser {
  id: number;
  username: string;
}

/** upload.json lives on the bind-mounted data directory, so it is checked on every read. */
const sessionSchema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(255),
  bytes: z.number().int().positive().max(RESTORE_UPLOAD_MAX_BYTES),
  userId: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  touchedAt: z.iso.datetime(),
});

type UploadSession = z.infer<typeof sessionSchema>;

function formatSize(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  if (bytes < gib) return `${Math.ceil(bytes / (1024 * 1024))} MB`;
  return `${(bytes / gib).toFixed(1).replace(/\.0$/, '')} GB`;
}

function isNoSpace(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOSPC';
}

/** The session directory for a client-supplied id, or null. Only a UUID ever reaches path.join,
 *  and the result must be a direct child of DATA_DIR/tmp. */
function sessionDirOf(id: string): string | null {
  if (!z.guid().safeParse(id).success) return null;
  const root = path.resolve(tempDir());
  const dir = path.resolve(root, `${id}-restore`);
  if (path.dirname(dir) !== root || !RESTORE_TMP_DIR_RE.test(path.basename(dir))) return null;
  return dir;
}

function readSession(dir: string): UploadSession | null {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    const parsed = sessionSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, SESSION_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isIdle(session: UploadSession, now: Date): boolean {
  return now.getTime() - Date.parse(session.touchedAt) >= RESTORE_UPLOAD_IDLE_MS;
}

function removeSession(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The payload's size, or null when it is missing or not a plain file. */
function payloadSize(dir: string): number | null {
  try {
    const stats = fs.lstatSync(path.join(dir, PAYLOAD_FILE));
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/** A session this user started that has not gone idle. An idle one is removed and refused. */
function liveSession(id: string, user: RestoreUploadUser, now: Date): { dir: string; session: UploadSession; size: number } {
  const dir = sessionDirOf(id);
  const session = dir === null ? null : readSession(dir);
  // Someone else's session reads exactly like a missing one.
  if (dir === null || session === null || session.userId !== user.id) throw new RestoreUploadError(NOT_FOUND, 404);
  if (isIdle(session, now)) {
    removeSession(dir);
    throw new RestoreUploadError('That upload expired. Start it again.', 404);
  }
  const size = payloadSize(dir);
  if (size === null) throw new RestoreUploadError(NOT_FOUND, 404);
  return { dir, session, size };
}

/** Removes every idle upload session and reports whether a live one remains. Directories without
 *  a valid upload.json (a listed restore mid-stage, a validation scratch) are not sessions and are
 *  left to the nightly sweep. */
function clearIdleSessions(now: Date): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(tempDir());
  } catch {
    return false;
  }
  let live = false;
  for (const name of names) {
    if (!RESTORE_TMP_DIR_RE.test(name)) continue;
    const dir = path.join(tempDir(), name);
    const session = readSession(dir);
    if (session === null) continue;
    if (isIdle(session, now)) removeSession(dir);
    else live = true;
  }
  return live;
}

function freeBytesOnDataVolume(): number {
  const stats = fs.statfsSync(path.dirname(tempDir()));
  return stats.bavail * stats.bsize;
}

/**
 * Opens a session for an upload of `bytes`. Every refusal leaves nothing behind (an idle session
 * of anyone's is removed first, as the idle rule already allows).
 */
export function startRestoreUpload(args: {
  name: string;
  bytes: number;
  user: RestoreUploadUser;
  now: Date;
  /** Tests only; otherwise the data volume's own free space. */
  freeBytes?: number;
}): { id: string } {
  const name = args.name.trim();
  if (name.length === 0 || name.length > 255) throw new RestoreUploadError('That file needs a name of 1 to 255 characters.', 400);
  if (!Number.isSafeInteger(args.bytes) || args.bytes <= 0) {
    throw new RestoreUploadError('That file is empty. Nothing was changed.', 400);
  }
  if (args.bytes > RESTORE_UPLOAD_MAX_BYTES) {
    throw new RestoreUploadError(
      `That file is ${formatSize(args.bytes)}; a restore from a file takes at most ${formatSize(RESTORE_UPLOAD_MAX_BYTES)}. ` +
        'Use the restore-backup command for a larger archive. Nothing was changed.',
      413,
    );
  }
  if (isRestorePending()) throw new RestoreUploadError(ALREADY_STAGED, 409);
  if (clearIdleSessions(args.now)) {
    throw new RestoreUploadError(
      'Another restore upload is in progress. Let it finish, or try again after an hour without activity. Nothing was changed.',
      409,
    );
  }

  const needed = 3 * args.bytes + RESTORE_UPLOAD_HEADROOM_BYTES;
  const free = args.freeBytes ?? freeBytesOnDataVolume();
  if (free < needed) {
    throw new RestoreUploadError(
      `This restore needs about ${formatSize(needed)} free on the data volume; ${formatSize(free)} is free. Nothing was changed.`,
      507,
    );
  }

  const id = randomUUID();
  const dir = path.join(tempDir(), `${id}-restore`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, PAYLOAD_FILE), Buffer.alloc(0), { flag: 'wx' });
    const at = args.now.toISOString();
    const session: UploadSession = { v: 1, name, bytes: args.bytes, userId: args.user.id, startedAt: at, touchedAt: at };
    writeJsonAtomically(path.join(dir, SESSION_FILE), session);
  } catch (error) {
    removeSession(dir);
    throw error;
  }
  return { id };
}

/**
 * Writes one piece at `offset`, which must be exactly where the payload ends: a piece can be
 * retried, but never reordered, overlapped or sent past the declared size. Synchronous from the
 * size check to the write, so two requests for one session cannot interleave.
 */
export function appendRestoreUpload(args: {
  id: string;
  offset: number;
  chunk: Uint8Array;
  user: RestoreUploadUser;
  now: Date;
}): { received: number } {
  const { dir, session, size } = liveSession(args.id, args.user, args.now);
  const length = args.chunk.byteLength;
  if (length === 0) throw new RestoreUploadError('That piece of the upload was empty. Nothing was changed.', 400);
  if (length > RESTORE_UPLOAD_CHUNK_BYTES) {
    throw new RestoreUploadError(`Each piece of an upload is at most ${formatSize(RESTORE_UPLOAD_CHUNK_BYTES)}. Nothing was changed.`, 413);
  }
  if (args.offset !== size) {
    throw new RestoreUploadError(`The upload has ${size} bytes so far; send the next piece from there.`, 409, size);
  }
  if (size + length > session.bytes) {
    throw new RestoreUploadError('That piece runs past the size this upload declared. Nothing was changed.', 413, size);
  }

  const fd = fs.openSync(path.join(dir, PAYLOAD_FILE), 'r+');
  try {
    let written = 0;
    try {
      while (written < length) {
        written += fs.writeSync(fd, args.chunk, written, length - written, size + written);
      }
    } catch (error) {
      // A piece lands whole or not at all, so a retry at the reported offset is always right.
      try {
        fs.ftruncateSync(fd, size);
      } catch {
        /* the size check on the next piece still reports where the payload really ends */
      }
      if (isNoSpace(error)) throw new RestoreUploadError('The data volume is full. Nothing was changed.', 507, size);
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }

  writeJsonAtomically(path.join(dir, SESSION_FILE), { ...session, touchedAt: args.now.toISOString() });
  return { received: size + length };
}

/**
 * Stages a complete upload. upload.json goes first, so no piece can land while the payload is
 * checked; any refusal removes the whole session and nothing is staged.
 */
export function finishRestoreUpload(args: { id: string; user: RestoreUploadUser; now: Date }): RestoreRequest {
  const { dir, session, size } = liveSession(args.id, args.user, args.now);
  if (size !== session.bytes) {
    throw new RestoreUploadError(
      `The upload is not complete: ${size} of ${session.bytes} bytes have arrived. Nothing was changed.`,
      409,
      size,
    );
  }
  if (isRestorePending()) {
    removeSession(dir);
    throw new RestoreUploadError(ALREADY_STAGED, 409);
  }

  fs.rmSync(path.join(dir, SESSION_FILE), { force: true });
  try {
    return stageUploadedRestore({
      uploadDir: dir,
      originalName: session.name,
      userId: args.user.id,
      username: args.user.username,
      now: args.now,
    });
  } catch (error) {
    removeSession(dir); // stageUploadedRestore already removes it; this covers a refusal before it starts
    if (error instanceof RestoreError) throw new RestoreUploadError(error.message, 422);
    if (isNoSpace(error)) throw new RestoreUploadError('The data volume filled up while the upload was checked. Nothing was changed.', 507);
    throw error;
  }
}

/** Removes this user's session. */
export function cancelRestoreUpload(args: { id: string; user: RestoreUploadUser }): void {
  const dir = sessionDirOf(args.id);
  const session = dir === null ? null : readSession(dir);
  if (dir === null || session === null || session.userId !== args.user.id) throw new RestoreUploadError(NOT_FOUND, 404);
  removeSession(dir);
}

/** The routes' answer for anything a session call threw: its sentence and status for a refusal,
 *  a generic sentence (and the full error in the server log) for anything else. */
export function restoreUploadErrorResponse(error: unknown): Response {
  if (error instanceof RestoreUploadError) {
    return Response.json(
      error.received === null ? { error: error.message } : { error: error.message, received: error.received },
      { status: error.status },
    );
  }
  console.error('[restore] an upload request failed', error);
  return Response.json({ error: 'The upload could not be handled. Nothing was changed.' }, { status: 500 });
}
