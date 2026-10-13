import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { POST as rawPreviewRoute } from '@/app/api/import/raw-preview/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { setUserVisibility } from '@/lib/auth/users';
import { MAX_FILE_BYTES } from '@/lib/import/parse';
import { writeStagedFile } from '@/lib/import/staging';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-rawpreview-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  token = createSession(userId).token;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function headers(withAuth = true): Record<string, string> {
  return {
    origin: 'http://nas.local:3000',
    host: 'nas.local:3000',
    ...(withAuth ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
  };
}

function uploadRequest(file: File, withAuth = true) {
  const form = new FormData();
  form.append('file', file);
  return new Request('http://nas.local:3000/api/import/raw-preview', {
    method: 'POST',
    headers: headers(withAuth),
    body: form,
  });
}

describe('POST /api/import/raw-preview', () => {
  it('stages the sample file and returns the first raw rows with column indexes implied by array position', async () => {
    const response = await rawPreviewRoute(uploadRequest(new File([fixture('scotia.csv')], 'scotia.csv', { type: 'text/csv' })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stagingId: string; rows: string[][]; encoding: string };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThanOrEqual(10);
    expect(fs.existsSync(path.join(tempDir, 'tmp', `${body.stagingId}.csv`))).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const response = await rawPreviewRoute(uploadRequest(new File(['a,b,c'], 'x.csv'), false));
    expect(response.status).toBe(401);
  });

  it('rejects a request with no file', async () => {
    const form = new FormData();
    const request = new Request('http://nas.local:3000/api/import/raw-preview', { method: 'POST', headers: headers(), body: form });
    expect((await rawPreviewRoute(request)).status).toBe(400);
  });

  it('413s an oversized file instead of staging it', async () => {
    const oversized = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'huge.csv', { type: 'text/csv' });
    const response = await rawPreviewRoute(uploadRequest(oversized));
    expect(response.status).toBe(413);
    // Nothing should have been written to the staging directory.
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });

  it('rejects on the declared content-length alone, before formData is ever called (review finding 1)', async () => {
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
    } as unknown as Request;

    const response = await rawPreviewRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  // Task 14 fix round 1 (controller ruling): the import UI refuses a self viewer, but this
  // route was reachable directly.
  it('403s a self-scoped viewer, staging nothing', async () => {
    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kidId, 'self');
    const kidToken = createSession(kidId).token;
    const form = new FormData();
    form.append('file', new File([fixture('scotia.csv')], 'scotia.csv', { type: 'text/csv' }));
    const request = new Request('http://nas.local:3000/api/import/raw-preview', {
      method: 'POST',
      headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${kidToken}` },
      body: form,
    });

    const response = await rawPreviewRoute(request);
    expect(response.status).toBe(403);
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });
});

/**
 * v1.55.2. "Add a bank" from a file the import screen already staged: the wizard reads that
 * file's columns by its staging id instead of asking for the same file again. Before this the
 * route took only a multipart `file`, so a JSON body was refused as "No file uploaded".
 */
describe('POST /api/import/raw-preview with a staged file (JSON { stagingId })', () => {
  function stagedRequest(body: unknown, sessionToken = token) {
    return new Request('http://nas.local:3000/api/import/raw-preview', {
      method: 'POST',
      headers: {
        origin: 'http://nas.local:3000',
        host: 'nas.local:3000',
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  it('returns the same rows as the multipart path for the same bytes, without staging a second copy', async () => {
    const bytes = fixture('scotia.csv');
    const uploaded = await rawPreviewRoute(uploadRequest(new File([bytes], 'scotia.csv', { type: 'text/csv' })));
    const fromUpload = (await uploaded.json()) as { stagingId: string; rows: string[][]; encoding: string };
    const before = fs.readdirSync(path.join(tempDir, 'tmp')).length;

    const response = await rawPreviewRoute(stagedRequest({ stagingId: fromUpload.stagingId }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { stagingId: string; rows: string[][]; encoding: string };
    expect(body.rows).toEqual(fromUpload.rows);
    expect(body.encoding).toBe(fromUpload.encoding);
    expect(body.stagingId).toBe(fromUpload.stagingId);
    expect(fs.readdirSync(path.join(tempDir, 'tmp'))).toHaveLength(before);
  });

  it('honours an explicit encoding the same way the multipart path does', async () => {
    const stagingId = writeStagedFile(fixture('td-chequing-win1252.csv'));
    const response = await rawPreviewRoute(stagedRequest({ stagingId, encoding: 'windows-1252' }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { encoding: string }).encoding).toBe('windows-1252');
  });

  it('410s an unknown staging id with a code the client can recognise', async () => {
    const response = await rawPreviewRoute(stagedRequest({ stagingId: '00000000-0000-4000-8000-000000000000' }));
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.error).toMatch(/expired|not found/i);
    expect(body.code).toBe('staged_file_missing');
  });

  it('400s a malformed staging id before any path is built from it', async () => {
    const response = await rawPreviewRoute(stagedRequest({ stagingId: '../../budget.db' }));
    expect(response.status).toBe(400);
    expect(typeof ((await response.json()) as { error: unknown }).error).toBe('string');
  });

  it('403s a self-scoped viewer before reading the staged file', async () => {
    const stagingId = writeStagedFile(fixture('scotia.csv'));
    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kidId, 'self');
    const response = await rawPreviewRoute(stagedRequest({ stagingId }, createSession(kidId).token));
    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const stagingId = writeStagedFile(fixture('scotia.csv'));
    const request = new Request('http://nas.local:3000/api/import/raw-preview', {
      method: 'POST',
      headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ stagingId }),
    });
    expect((await rawPreviewRoute(request)).status).toBe(401);
  });
});
