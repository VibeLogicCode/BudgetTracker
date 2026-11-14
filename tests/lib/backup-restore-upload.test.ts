import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { runNightlyBackup } from '@/lib/backup';
import { tempDir } from '@/lib/backup/archive';
import { purgeStagedFiles } from '@/lib/import/staging';
import { createSession } from '@/lib/auth/session';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import {
  applyStagedRestoreOnBoot,
  readRestoreState,
  stageRestore,
  stagedDir,
  uploadedSourceName,
} from '@/lib/backup/restore';
import {
  RESTORE_UPLOAD_CHUNK_BYTES,
  RESTORE_UPLOAD_IDLE_MS,
  RESTORE_UPLOAD_MAX_BYTES,
  RestoreUploadError,
  appendRestoreUpload,
  cancelRestoreUpload,
  finishRestoreUpload,
  startRestoreUpload,
} from '@/lib/backup/restore-upload';

/**
 * v1.63.0 C3: a backup uploaded from the browser, in pieces, through the listed restore's staging
 * core. Explicit clocks throughout; free space is injected so no test depends on the machine's disk.
 */

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;
let admin: { id: number; username: string };
let otherAdmin: { id: number; username: string };

const T0 = new Date('2026-03-09T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60 * 1000);
const PLENTY = 50 * 1024 * 1024 * 1024;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-upload-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
  admin = { id: insertTestUser(current.db, { name: 'Alex', username: 'alex' }), username: 'alex' };
  otherAdmin = { id: insertTestUser(current.db, { name: 'Sam', username: 'sam' }), username: 'sam' };
  // The live data a restore replaces (see tests/lib/backup-restore.test.ts for why VACUUM INTO).
  current.sqlite.exec(`VACUUM INTO '${path.join(dataDir, 'budget.db').replace(/'/g, "''")}'`);
  fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'receipts', '11111111-2222-3333-4444-555555555555.jpg'), JPEG);
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A real nightly archive's bytes, made the way the nightly job makes one. */
function archiveBytes(): Buffer {
  const backup = runNightlyBackup(new Date('2026-03-09T06:00:00.000Z'));
  return fs.readFileSync(path.join(dataDir, 'backups', backup.name));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sessionDir(id: string): string {
  return path.join(tempDir(), `${id}-restore`);
}

function payloadOf(id: string): Buffer {
  return fs.readFileSync(path.join(sessionDir(id), 'payload'));
}

/** Every `-restore` directory under DATA_DIR/tmp: upload sessions and staging scratch alike. */
function restoreDirs(): string[] {
  return fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()).filter((name) => name.endsWith('-restore')) : [];
}

function start(bytes: number, now = T0, user = admin, freeBytes = PLENTY): string {
  return startRestoreUpload({ name: 'budget-2026-03-09.tar.gz', bytes, user, now, freeBytes }).id;
}

/** Uploads `bytes` in `pieces` roughly equal pieces, one minute apart. */
function uploadAll(bytes: Buffer, pieces = 3): string {
  const id = start(bytes.length);
  const size = Math.ceil(bytes.length / pieces);
  let minute = 1;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.length));
    expect(appendRestoreUpload({ id, offset, chunk, user: admin, now: at(minute) })).toEqual({ received: offset + chunk.length });
    minute += 1;
  }
  return id;
}

/** Runs `fn`, expecting a RestoreUploadError, and returns it. */
function refusal(fn: () => unknown): RestoreUploadError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreUploadError);
    return error as RestoreUploadError;
  }
  throw new Error('expected a refusal');
}

describe('an upload stages through the listed restore core', () => {
  it('stages restore-staged/ from an archive sent in three pieces', () => {
    const bytes = archiveBytes();
    const id = uploadAll(bytes, 3);

    const request = finishRestoreUpload({ id, user: admin, now: at(10) });

    expect(request.sourceName).toBe('uploaded: budget-2026-03-09.tar.gz');
    expect(request.kind).toBe('archive');
    expect(request.sha256).toBe(sha256(bytes));
    expect(request.bytes).toBe(bytes.length);
    expect(request.requestedByUserId).toBe(admin.id);
    expect(request.requestedAt).toBe(at(10).toISOString());
    const marker = JSON.parse(fs.readFileSync(path.join(stagedDir(), 'restore-request.json'), 'utf8'));
    expect(marker.sourceName).toBe('uploaded: budget-2026-03-09.tar.gz');
    expect(marker.kind).toBe('archive');
    expect(marker.sha256).toBe(sha256(bytes));
    expect(fs.readFileSync(path.join(stagedDir(), 'payload')).equals(bytes)).toBe(true);
    // The session became restore-staged/: nothing is left under tmp/, and no upload.json travels.
    expect(fs.existsSync(path.join(stagedDir(), 'upload.json'))).toBe(false);
    expect(restoreDirs()).toEqual([]);
    expect(readRestoreState().staged?.sourceName).toBe('uploaded: budget-2026-03-09.tar.gz');
  });

  it('is applied at boot like a listed backup', () => {
    const id = uploadAll(archiveBytes(), 3);
    finishRestoreUpload({ id, user: admin, now: at(10) });
    fs.writeFileSync(path.join(dataDir, 'receipts', 'extra-not-in-backup.txt'), 'changed after the backup');

    expect(applyStagedRestoreOnBoot(at(12))).toBe('continue');

    const state = readRestoreState();
    expect(state.result?.status).toBe('success');
    expect(state.result?.sourceName).toBe('uploaded: budget-2026-03-09.tar.gz');
    expect(state.result?.requestedByUserId).toBe(admin.id);
    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'receipts', 'extra-not-in-backup.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, state.result!.safetyCopy!))).toBe(true);
  });

  it('signs everyone out: the restored database carries no session rows', () => {
    createSession(admin.id);
    expect(current!.sqlite.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
    const id = uploadAll(archiveBytes(), 3);
    finishRestoreUpload({ id, user: admin, now: at(10) });
    applyStagedRestoreOnBoot(at(12));

    expect(readRestoreState().result?.status).toBe('success');
    const restored = new Database(path.join(dataDir, 'budget.db'), { readonly: true });
    try {
      expect(restored.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
      expect(restored.prepare("select count(*) as n from users where username = 'alex'").get()).toEqual({ n: 1 });
    } finally {
      restored.close();
    }
  });

  it('refuses a garbage file, removes the session and stages nothing', () => {
    const garbage = Buffer.alloc(4096, 0x41);
    const id = uploadAll(garbage, 3);

    const error = refusal(() => finishRestoreUpload({ id, user: admin, now: at(10) }));

    expect(error.status).toBe(422);
    expect(error.message).toMatch(/neither a \.tar\.gz archive nor a SQLite backup/);
    expect(fs.existsSync(sessionDir(id))).toBe(false);
    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses a database made by a newer version than the code', () => {
    const newer = path.join(dataDir, 'newer.db');
    current!.sqlite.exec(`VACUUM INTO '${newer.replace(/'/g, "''")}'`);
    const db = new Database(newer);
    db.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run('from-the-future', 99_999_999_999_999);
    db.close();
    const id = uploadAll(fs.readFileSync(newer), 3);

    const error = refusal(() => finishRestoreUpload({ id, user: admin, now: at(10) }));

    expect(error.status).toBe(422);
    expect(error.message).toMatch(/made by a newer version of Budget Tracker/);
    expect(fs.existsSync(sessionDir(id))).toBe(false);
    expect(fs.existsSync(stagedDir())).toBe(false);
  });

  it('accepts an older bare .db backup', () => {
    const legacy = path.join(dataDir, 'legacy.db');
    current!.sqlite.exec(`VACUUM INTO '${legacy.replace(/'/g, "''")}'`);
    const id = uploadAll(fs.readFileSync(legacy), 2);
    expect(finishRestoreUpload({ id, user: admin, now: at(10) }).kind).toBe('sqlite');
  });
});

describe('each refusal leaves nothing written', () => {
  it('a piece at the wrong offset is a conflict that reports where the upload stands', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(40, 1), user: admin, now: at(1) });

    for (const offset of [0, 39, 41]) {
      const error = refusal(() => appendRestoreUpload({ id, offset, chunk: Buffer.alloc(10, 2), user: admin, now: at(2) }));
      expect(error.status).toBe(409);
      expect(error.received).toBe(40);
    }
    expect(payloadOf(id).equals(Buffer.alloc(40, 1))).toBe(true);
  });

  it('a piece over the piece size is refused', () => {
    const id = start(RESTORE_UPLOAD_CHUNK_BYTES + 10);
    const error = refusal(() =>
      appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(RESTORE_UPLOAD_CHUNK_BYTES + 1), user: admin, now: at(1) }),
    );
    expect(error.status).toBe(413);
    expect(payloadOf(id).length).toBe(0);
  });

  it('a piece past the declared size is refused', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(90, 1), user: admin, now: at(1) });
    const error = refusal(() => appendRestoreUpload({ id, offset: 90, chunk: Buffer.alloc(11, 2), user: admin, now: at(2) }));
    expect(error.status).toBe(413);
    expect(payloadOf(id).length).toBe(90);
  });

  it('a finish before every byte has arrived is refused and keeps the session', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(60, 1), user: admin, now: at(1) });
    const error = refusal(() => finishRestoreUpload({ id, user: admin, now: at(2) }));
    expect(error.status).toBe(409);
    expect(error.received).toBe(60);
    expect(error.message).toMatch(/60 of 100 bytes/);
    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(payloadOf(id).length).toBe(60);
  });

  it('an idle session expires, is removed and takes nothing more', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(10, 1), user: admin, now: at(30) });

    // Idle is measured from the last piece, not the start.
    appendRestoreUpload({ id, offset: 10, chunk: Buffer.alloc(10, 1), user: admin, now: at(89) });
    const error = refusal(() => appendRestoreUpload({ id, offset: 20, chunk: Buffer.alloc(10, 1), user: admin, now: at(89 + 60) }));
    expect(error.status).toBe(404);
    expect(error.message).toBe('That upload expired. Start it again.');
    expect(fs.existsSync(sessionDir(id))).toBe(false);
    expect(fs.existsSync(stagedDir())).toBe(false);
  });

  it("someone else's session reads exactly like a missing one", () => {
    const id = start(100);
    const foreign = refusal(() => appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(10, 1), user: otherAdmin, now: at(1) }));
    const missing = refusal(() =>
      appendRestoreUpload({ id: '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f', offset: 0, chunk: Buffer.alloc(10, 1), user: admin, now: at(1) }),
    );
    expect(foreign.status).toBe(404);
    expect(foreign.message).toBe(missing.message);
    expect(refusal(() => finishRestoreUpload({ id, user: otherAdmin, now: at(1) })).status).toBe(404);
    expect(refusal(() => cancelRestoreUpload({ id, user: otherAdmin })).status).toBe(404);
    expect(payloadOf(id).length).toBe(0);
  });

  it('an id that is not a UUID never reaches the disk', () => {
    for (const id of ['..', '../../etc', 'not-a-uuid', '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f/..']) {
      expect(refusal(() => appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(1), user: admin, now: at(1) })).status).toBe(404);
    }
    expect(restoreDirs()).toEqual([]);
  });

  it('a second start while one is live is refused; once the first is idle it is removed', () => {
    const first = start(100);
    const busy = refusal(() => start(100, at(59), otherAdmin));
    expect(busy.status).toBe(409);
    expect(busy.message).toMatch(/Another restore upload is in progress/);
    expect(restoreDirs()).toEqual([`${first}-restore`]);

    const second = start(100, at(60), otherAdmin);
    expect(restoreDirs()).toEqual([`${second}-restore`]);
  });

  it('low space is refused with the sizes, and nothing is created', () => {
    const gib = 1024 * 1024 * 1024;
    const error = refusal(() => start(gib, T0, admin, 1.2 * gib));
    expect(error.status).toBe(507);
    expect(error.message).toBe('This restore needs about 3.1 GB free on the data volume; 1.2 GB is free. Nothing was changed.');
    expect(restoreDirs()).toEqual([]);
  });

  it('exactly three times the size plus the headroom is enough', () => {
    expect(() => start(1000, T0, admin, 3 * 1000 + 100 * 1000 * 1000)).not.toThrow();
  });

  it('an empty or oversize file is refused before anything is created', () => {
    expect(refusal(() => start(0)).status).toBe(400);
    const tooBig = refusal(() => start(RESTORE_UPLOAD_MAX_BYTES + 1));
    expect(tooBig.status).toBe(413);
    expect(tooBig.message).toMatch(/at most 4 GB/);
    expect(restoreDirs()).toEqual([]);
  });

  it('a restore already staged refuses a start, and a finish (removing the upload)', () => {
    const bytes = archiveBytes();
    const id = uploadAll(bytes, 2);
    const listed = stageRestore({ backupName: 'budget-2026-03-09.tar.gz', userId: admin.id, username: admin.username });

    const atStart = refusal(() => start(100, at(5), otherAdmin));
    expect(atStart.status).toBe(409);
    expect(atStart.message).toMatch(/already staged/);

    const atFinish = refusal(() => finishRestoreUpload({ id, user: admin, now: at(5) }));
    expect(atFinish.status).toBe(409);
    expect(fs.existsSync(sessionDir(id))).toBe(false);
    // The listed restore that was staged first is untouched.
    expect(readRestoreState().staged?.sourceName).toBe(listed.sourceName);
    expect(restoreDirs()).toEqual([]);
  });
});

describe('abandoned uploads are cleaned up', () => {
  it('cancel removes the session and what it received', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(10, 1), user: admin, now: at(1) });
    cancelRestoreUpload({ id, user: admin });
    expect(fs.existsSync(sessionDir(id))).toBe(false);
  });

  it('the nightly sweep removes a session left for a day', () => {
    const id = start(100);
    appendRestoreUpload({ id, offset: 0, chunk: Buffer.alloc(10, 1), user: admin, now: at(1) });
    const old = new Date('2026-03-01T00:00:00.000Z');
    fs.utimesSync(sessionDir(id), old, old);

    purgeStagedFiles(24 * 60 * 60 * 1000, new Date('2026-03-09T12:00:00.000Z'));

    expect(fs.existsSync(sessionDir(id))).toBe(false);
  });

  it('a session idle for the limit no longer blocks a start', () => {
    start(100);
    expect(() => start(100, new Date(T0.getTime() + RESTORE_UPLOAD_IDLE_MS))).not.toThrow();
  });
});

describe("the marker's name for an upload", () => {
  it('keeps only safe characters and fits the marker', () => {
    expect(uploadedSourceName('budget-2026-03-09.tar.gz')).toBe('uploaded: budget-2026-03-09.tar.gz');
    expect(uploadedSourceName('../evil\u0000name<script>.db')).toBe('uploaded: .._evil_name_script_.db');
    const long = uploadedSourceName('a'.repeat(400));
    expect(long.length).toBe(120);
    expect(long.startsWith('uploaded: aaa')).toBe(true);
  });
});
