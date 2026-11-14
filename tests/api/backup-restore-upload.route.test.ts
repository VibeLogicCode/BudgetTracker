import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

const armRestart = vi.fn();
vi.mock('@/lib/backup/restart', () => ({ armRestart: () => armRestart() }));

import { POST as START } from '@/app/api/backup/restore-upload/route';
import { DELETE, POST as FINISH, PUT } from '@/app/api/backup/restore-upload/[id]/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { runNightlyBackup } from '@/lib/backup';
import { tempDir } from '@/lib/backup/archive';
import { stageRestore, stagedDir } from '@/lib/backup/restore';
import { RESTORE_UPLOAD_CHUNK_BYTES, RESTORE_UPLOAD_MAX_BYTES } from '@/lib/backup/restore-upload';

/**
 * v1.63.0 C4: the restore-upload routes. Real sessions, a real temp DATA_DIR and the real staging
 * core; only the restart is mocked, so the test process never exits.
 */

const BASE = 'http://nas.local:3000';
const UNKNOWN_ID = '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let originalDbPath: string | undefined;
let adminId: number;
let adminToken: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-upload-api-'));
  originalDataDir = process.env.DATA_DIR;
  originalDbPath = process.env.BUDGET_DB_PATH;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  process.env.BUDGET_DB_PATH = current.path;
  adminId = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'admin' });
  adminToken = createSession(adminId).token;
  current.sqlite.exec(`VACUUM INTO '${path.join(dataDir, 'budget.db').replace(/'/g, "''")}'`);
  armRestart.mockClear();
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalDbPath === undefined) delete process.env.BUDGET_DB_PATH;
  else process.env.BUDGET_DB_PATH = originalDbPath;
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Options {
  token?: string | null;
  origin?: string | null;
  body?: BodyInit;
  headers?: Record<string, string>;
}

function request(method: string, url: string, options: Options = {}): Request {
  const headers: Record<string, string> = { host: 'nas.local:3000', ...options.headers };
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin) headers.origin = origin;
  const token = options.token === undefined ? adminToken : options.token;
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  return new Request(`${BASE}${url}`, { method, headers, body: options.body });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function startRequest(body: unknown, options: Options = {}): Request {
  return request('POST', '/api/backup/restore-upload', {
    ...options,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...options.headers },
  });
}

function pieceRequest(id: string, offset: number | string, bytes: Uint8Array, options: Options = {}): Request {
  return request('PUT', `/api/backup/restore-upload/${id}?offset=${offset}`, {
    ...options,
    body: new Uint8Array(bytes),
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), ...options.headers },
  });
}

async function startUpload(bytes: number, name = 'budget-2026-03-09.tar.gz'): Promise<string> {
  const response = await START(startRequest({ name, bytes, confirm: true }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string; chunkBytes: number };
  expect(body.chunkBytes).toBe(RESTORE_UPLOAD_CHUNK_BYTES);
  return body.id;
}

async function sendAll(id: string, bytes: Buffer, pieces = 3): Promise<void> {
  const size = Math.ceil(bytes.length / pieces);
  for (let offset = 0; offset < bytes.length; offset += size) {
    const piece = bytes.subarray(offset, Math.min(offset + size, bytes.length));
    const response = await PUT(pieceRequest(id, offset, piece), params(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: offset + piece.length });
  }
}

function restoreDirs(): string[] {
  return fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()).filter((name) => name.endsWith('-restore')) : [];
}

function userToken(over: { role: 'admin' | 'member'; visibility?: 'self'; mustChange?: boolean }): string {
  const id = insertTestUser(current!.db, { role: over.role, username: `u${Math.random().toString(36).slice(2, 8)}` });
  if (over.visibility) current!.sqlite.prepare('update users set visibility = ? where id = ?').run(over.visibility, id);
  if (over.mustChange) current!.sqlite.prepare('update users set must_change_password = 1 where id = ?').run(id);
  return createSession(id).token;
}

/** Every handler, called the way the browser calls it. */
function everyHandler(options: Options): Array<[string, () => Promise<Response>]> {
  return [
    ['start', () => START(startRequest({ name: 'budget-2026-03-09.tar.gz', bytes: 100, confirm: true }, options))],
    ['piece', () => PUT(pieceRequest(UNKNOWN_ID, 0, new Uint8Array(4), options), params(UNKNOWN_ID))],
    ['finish', () => FINISH(request('POST', `/api/backup/restore-upload/${UNKNOWN_ID}`, options), params(UNKNOWN_ID))],
    ['cancel', () => DELETE(request('DELETE', `/api/backup/restore-upload/${UNKNOWN_ID}`, options), params(UNKNOWN_ID))],
  ];
}

const FS_CALLS = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'rmSync', 'statfsSync'] as const;

function spyOnFs() {
  return FS_CALLS.map((name) => vi.spyOn(fs, name));
}

describe('the gate, in order, on every handler', () => {
  it('refuses a cross-origin request before anything else', async () => {
    for (const [label, call] of everyHandler({ origin: 'http://evil.example' })) {
      const spies = spyOnFs();
      const response = await call();
      expect(response.status, label).toBe(403);
      for (const spy of spies) expect(spy, `${label}: ${spy.getMockName()}`).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses a request with no session', async () => {
    for (const [label, call] of everyHandler({ token: null })) expect((await call()).status, label).toBe(401);
  });

  it('refuses a member and a self-scoped member', async () => {
    for (const token of [userToken({ role: 'member' }), userToken({ role: 'member', visibility: 'self' })]) {
      for (const [label, call] of everyHandler({ token })) {
        const response = await call();
        expect(response.status, label).toBe(403);
        expect(await response.json()).toEqual({ error: 'Only an admin can restore a backup.' });
      }
    }
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses an admin who still has to change their password', async () => {
    const token = userToken({ role: 'admin', mustChange: true });
    for (const [label, call] of everyHandler({ token })) expect((await call()).status, label).toBe(403);
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses an id that is not a UUID with 400, before any filesystem call', async () => {
    for (const id of ['not-a-uuid', '..', '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f..']) {
      const calls: Array<[string, () => Promise<Response>]> = [
        ['piece', () => PUT(pieceRequest(id, 0, new Uint8Array(4)), params(id))],
        ['finish', () => FINISH(request('POST', `/api/backup/restore-upload/x`), params(id))],
        ['cancel', () => DELETE(request('DELETE', `/api/backup/restore-upload/x`), params(id))],
      ];
      for (const [label, call] of calls) {
        const spies = spyOnFs();
        const response = await call();
        expect(response.status, `${label} ${id}`).toBe(400);
        for (const spy of spies) expect(spy, `${label}: ${spy.getMockName()}`).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      }
    }
  });
});

describe('POST /api/backup/restore-upload (start)', () => {
  it('needs the confirmation', async () => {
    const response = await START(startRequest({ name: 'budget-2026-03-09.tar.gz', bytes: 100, confirm: false }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Tick the confirmation box first.' });
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses a file over the limit with 413', async () => {
    const response = await START(startRequest({ name: 'budget-2026-03-09.tar.gz', bytes: RESTORE_UPLOAD_MAX_BYTES + 1, confirm: true }));
    expect(response.status).toBe(413);
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses low space with 507 and the sentence', async () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 1, bsize: 4096 } as fs.StatsFs);
    const response = await START(startRequest({ name: 'budget-2026-03-09.tar.gz', bytes: 100, confirm: true }));
    expect(response.status).toBe(507);
    expect(((await response.json()) as { error: string }).error).toMatch(/^This restore needs about .+ free on the data volume; .+ is free\. Nothing was changed\.$/);
    expect(restoreDirs()).toEqual([]);
  });

  it('refuses while a restore is staged with 409', async () => {
    const backup = runNightlyBackup(new Date('2026-03-09T06:00:00.000Z'));
    stageRestore({ backupName: backup.name, userId: adminId, username: 'alex' });
    const response = await START(startRequest({ name: 'budget-2026-03-09.tar.gz', bytes: 100, confirm: true }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already staged/);
  });

  it('refuses a second upload while the first is live with 409', async () => {
    await startUpload(100);
    const response = await START(startRequest({ name: 'other.tar.gz', bytes: 100, confirm: true }));
    expect(response.status).toBe(409);
    expect(restoreDirs()).toHaveLength(1);
  });
});

describe('PUT /api/backup/restore-upload/[id] (a piece)', () => {
  it('answers 404 for an unknown session', async () => {
    const response = await PUT(pieceRequest(UNKNOWN_ID, 0, new Uint8Array(4)), params(UNKNOWN_ID));
    expect(response.status).toBe(404);
  });

  it('answers 409 with where the upload stands for a wrong offset', async () => {
    const id = await startUpload(100);
    await PUT(pieceRequest(id, 0, new Uint8Array(40)), params(id));
    const response = await PUT(pieceRequest(id, 0, new Uint8Array(10)), params(id));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { received: number }).received).toBe(40);
  });

  it('refuses a declared length over the piece size before reading the body', async () => {
    const id = await startUpload(RESTORE_UPLOAD_CHUNK_BYTES + 10);
    const piece = pieceRequest(id, 0, new Uint8Array(4), { headers: { 'content-length': String(RESTORE_UPLOAD_CHUNK_BYTES + 1) } });
    const read = vi.spyOn(piece, 'arrayBuffer');
    const response = await PUT(piece, params(id));
    expect(response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(tempDir(), `${id}-restore`, 'payload')).size).toBe(0);
  });

  it('checks the bytes actually read against the piece size too', async () => {
    const id = await startUpload(RESTORE_UPLOAD_CHUNK_BYTES + 10);
    const piece = pieceRequest(id, 0, new Uint8Array(RESTORE_UPLOAD_CHUNK_BYTES + 1), { headers: { 'content-length': '10' } });
    expect((await PUT(piece, params(id))).status).toBe(413);
    expect(fs.statSync(path.join(tempDir(), `${id}-restore`, 'payload')).size).toBe(0);
  });

  it('needs a length and the octet-stream type', async () => {
    const id = await startUpload(100);
    const noLength = pieceRequest(id, 0, new Uint8Array(4));
    noLength.headers.delete('content-length');
    expect((await PUT(noLength, params(id))).status).toBe(411);
    expect((await PUT(pieceRequest(id, 0, new Uint8Array(4), { headers: { 'content-type': 'text/plain' } }), params(id))).status).toBe(415);
    expect((await PUT(pieceRequest(id, '-1', new Uint8Array(4)), params(id))).status).toBe(400);
    expect((await PUT(pieceRequest(id, '1e3', new Uint8Array(4)), params(id))).status).toBe(400);
  });

  it('answers 413 for a piece past the declared size', async () => {
    const id = await startUpload(10);
    expect((await PUT(pieceRequest(id, 0, new Uint8Array(11)), params(id))).status).toBe(413);
  });
});

describe('POST /api/backup/restore-upload/[id] (finish)', () => {
  it('stages the upload, arms the restart and says so', async () => {
    const bytes = fs.readFileSync(path.join(dataDir, 'backups', runNightlyBackup(new Date('2026-03-09T06:00:00.000Z')).name));
    const id = await startUpload(bytes.length);
    await sendAll(id, bytes);

    const response = await FINISH(request('POST', `/api/backup/restore-upload/${id}`), params(id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      restarting: true,
      message: 'Restoring uploaded: budget-2026-03-09.tar.gz. The app will restart. Refresh this page in about 30 seconds.',
    });
    expect(armRestart).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(stagedDir(), 'restore-request.json'))).toBe(true);
  });

  it('answers 422 with the sentence for a refused file, and arms nothing', async () => {
    const id = await startUpload(4096);
    await sendAll(id, Buffer.alloc(4096, 0x41));

    const response = await FINISH(request('POST', `/api/backup/restore-upload/${id}`), params(id));

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toMatch(/neither a \.tar\.gz archive nor a SQLite backup/);
    expect(armRestart).not.toHaveBeenCalled();
    expect(fs.existsSync(stagedDir())).toBe(false);
    expect(restoreDirs()).toEqual([]);
  });

  it('answers 409 for an incomplete upload', async () => {
    const id = await startUpload(100);
    await PUT(pieceRequest(id, 0, new Uint8Array(50)), params(id));
    const response = await FINISH(request('POST', `/api/backup/restore-upload/${id}`), params(id));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { received: number }).received).toBe(50);
    expect(armRestart).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    expect((await FINISH(request('POST', `/api/backup/restore-upload/${UNKNOWN_ID}`), params(UNKNOWN_ID))).status).toBe(404);
    expect(armRestart).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/backup/restore-upload/[id] (cancel)', () => {
  it('removes the session', async () => {
    const id = await startUpload(100);
    await PUT(pieceRequest(id, 0, new Uint8Array(10)), params(id));
    const response = await DELETE(request('DELETE', `/api/backup/restore-upload/${id}`), params(id));
    expect(response.status).toBe(200);
    expect(restoreDirs()).toEqual([]);
  });

  it('answers 404 for an unknown session', async () => {
    expect((await DELETE(request('DELETE', `/api/backup/restore-upload/${UNKNOWN_ID}`), params(UNKNOWN_ID))).status).toBe(404);
  });
});
