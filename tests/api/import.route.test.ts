import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { POST as previewRoute } from '@/app/api/import/preview/route';
import { POST as commitRoute } from '@/app/api/import/commit/route';
import { POST as undoRoute } from '@/app/api/import/undo/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { createAccount } from '@/lib/accounts';
import { setUserVisibility } from '@/lib/auth/users';
import { listAudit } from '@/lib/audit';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { MAX_FILE_BYTES } from '@/lib/import/parse';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let accountId: number;
let profileId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-api-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  token = createSession(userId).token;
  accountId = createAccount({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
  profileId = getProfileByName('TD Chequing/Debit')!.id;
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

function uploadRequest(withAuth = true, origin = 'http://nas.local:3000') {
  const form = new FormData();
  form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
  form.append('accountId', String(accountId));
  form.append('profileId', String(profileId));
  return new Request('http://nas.local:3000/api/import/preview', {
    method: 'POST',
    headers: { ...headers(withAuth), origin },
    body: form,
  });
}

function jsonRequest(url: string, body: unknown, withAuth = true) {
  return new Request(url, {
    method: 'POST',
    headers: { ...headers(withAuth), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Same as uploadRequest()/jsonRequest() above, but signed in as an arbitrary session token --
 * v1.13.0 ruling R3's tests need a request from someone OTHER than the outer beforeEach's `token`. */
function uploadRequestAs(sessionToken: string) {
  const form = new FormData();
  form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
  form.append('accountId', String(accountId));
  form.append('profileId', String(profileId));
  return new Request('http://nas.local:3000/api/import/preview', {
    method: 'POST',
    headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    body: form,
  });
}

function jsonRequestAs(sessionToken: string, url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin: 'http://nas.local:3000',
      host: 'nas.local:3000',
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/import/preview', () => {
  it('stages the upload and returns the preview', async () => {
    const response = await previewRoute(uploadRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stagingId: string; totalRows: number; rows: unknown[]; encoding: string };
    expect(body.totalRows).toBe(9);
    expect(body.rows).toHaveLength(9);
    expect(body.encoding).toBe('utf-8');
    expect(fs.existsSync(path.join(tempDir, 'tmp', `${body.stagingId}.csv`))).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    expect((await previewRoute(uploadRequest(false))).status).toBe(401);
  });

  it('rejects a cross-origin request', async () => {
    expect((await previewRoute(uploadRequest(true, 'http://evil.local'))).status).toBe(403);
  });

  it('404s on an unknown account', async () => {
    const response = await previewRoute(
      jsonRequest('http://nas.local:3000/api/import/preview', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId: 9999,
        profileId,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('410s when the staged file is gone', async () => {
    const response = await previewRoute(
      jsonRequest('http://nas.local:3000/api/import/preview', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId,
      }),
    );
    expect(response.status).toBe(410);
  });

  it('413s an oversized upload and leaves the staging directory empty (review finding 4)', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'huge.csv', { type: 'text/csv' }));
    form.append('accountId', String(accountId));
    form.append('profileId', String(profileId));
    const request = new Request('http://nas.local:3000/api/import/preview', {
      method: 'POST',
      headers: headers(),
      body: form,
    });
    const response = await previewRoute(request);
    expect(response.status).toBe(413);
    // file.size is checked before the buffer is ever staged to disk.
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });

  it('rejects on the declared content-length alone, before formData/json is ever called (review finding 1)', async () => {
    const formDataSpy = vi.fn(async () => {
      throw new Error('formData() must not be called once content-length already exceeds the cap');
    });
    const jsonSpy = vi.fn(async () => {
      throw new Error('json() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      formData: formDataSpy,
      json: jsonSpy,
    } as unknown as Request;

    const response = await previewRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  // Task 14 fix round 1 (controller ruling): the import UI refuses a self viewer, but this
  // route was reachable directly.
  it('403s a self-scoped viewer, staging nothing', async () => {
    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kidId, 'self');
    const kidToken = createSession(kidId).token;

    const response = await previewRoute(uploadRequestAs(kidToken));
    expect(response.status).toBe(403);
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });

  it('400s an asset account, the same refusal commit already makes (item BQ)', async () => {
    const assetId = insertTestAccount(current!.db, { name: 'House', type: 'asset', ownerUserId: null });
    const form = new FormData();
    form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
    form.append('accountId', String(assetId));
    form.append('profileId', String(profileId));
    const response = await previewRoute(
      new Request('http://nas.local:3000/api/import/preview', { method: 'POST', headers: headers(), body: form }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('That account only holds a balance you type in.');
    // Nothing staged: the refusal lands before the file is written.
    const tmp = path.join(tempDir, 'tmp');
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toHaveLength(0);
  });
});

describe('POST /api/import/commit and /api/import/undo', () => {
  it('commits the staged import and then undoes it', async () => {
    const previewResponse = await previewRoute(uploadRequest());
    const preview = (await previewResponse.json()) as { stagingId: string };

    const commitResponse = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(commitResponse.status).toBe(200);
    const committed = (await commitResponse.json()) as { importId: number; rowsAdded: number; needsReview: number };
    expect(committed.rowsAdded).toBe(9);
    expect(committed.needsReview).toBe(8);

    const dialog = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: committed.importId }));
    expect(await dialog.json()).toMatchObject({ willDelete: 9, willKeep: 0 });

    const undone = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }));
    // v1.12.1 (item AE / MON-5): td-chequing.csv's 9 rows span 7 unique statement dates, all
    // written as 'csv' snapshots on commit -- undoing the whole import removes all 7.
    expect(await undone.json()).toEqual({ deleted: 9, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 7 });
    expect((current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('rejects a commit with a malformed mapping', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId,
        mapping: { ...getBuiltinPreset('TD Chequing/Debit'), descCols: [] },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('404s a commit against an unknown (foreign) account id', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId: 999999,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('404s a commit against an unknown (foreign) profile id', async () => {
    const response = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId: 999999,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('commit route rejects on the declared content-length alone, before json() is ever called (review finding 1)', async () => {
    const jsonSpy = vi.fn(async () => {
      throw new Error('json() must not be called once content-length already exceeds the cap');
    });
    const fakeRequest = {
      method: 'POST',
      headers: new Headers({ ...headers(), 'content-length': String(MAX_FILE_BYTES + 1) }),
      json: jsonSpy,
    } as unknown as Request;

    const response = await commitRoute(fakeRequest);
    expect(response.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it('404s an undo of an unknown importId instead of silently no-opping (review finding 6)', async () => {
    const dialog = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: 999999 }));
    expect(dialog.status).toBe(404);

    const confirmed = await undoRoute(jsonRequest('http://nas.local:3000/api/import/undo', { importId: 999999, confirm: true }));
    expect(confirmed.status).toBe(404);
  });

  // v1.13.0 ruling R3 (review 2026-08-27, SEC-2): only the person who ran an import, or an admin,
  // may undo it -- previously any signed-in household member could undo anyone's import.
  it('ruling R3: a member cannot undo an import somebody else ran, and the row survives', async () => {
    const importerId = insertTestUser(current!.db, { name: 'Importer', username: 'importer', role: 'member' });
    const importerToken = createSession(importerId).token;
    const otherId = insertTestUser(current!.db, { name: 'Other', username: 'other', role: 'member' });
    const otherToken = createSession(otherId).token;

    const previewResponse = await previewRoute(uploadRequestAs(importerToken));
    const preview = (await previewResponse.json()) as { stagingId: string };
    const commitResponse = await commitRoute(
      jsonRequestAs(importerToken, 'http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    const committed = (await commitResponse.json()) as { importId: number };
    const before = (current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

    const response = await undoRoute(
      jsonRequestAs(otherToken, 'http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }),
    );
    expect(response.status).toBe(403);
    expect((current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(before);
    expect(listAudit()).toEqual([]);
  });

  it('ruling R3: the importer can undo their own import, and one audit row records it with the count', async () => {
    const importerId = insertTestUser(current!.db, { name: 'Importer', username: 'importer', role: 'member' });
    const importerToken = createSession(importerId).token;

    const previewResponse = await previewRoute(uploadRequestAs(importerToken));
    const preview = (await previewResponse.json()) as { stagingId: string };
    const commitResponse = await commitRoute(
      jsonRequestAs(importerToken, 'http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    const committed = (await commitResponse.json()) as { importId: number };

    const response = await undoRoute(
      jsonRequestAs(importerToken, 'http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }),
    );
    expect(response.status).toBe(200);

    const audit = listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: importerId,
      action: 'undo_import',
      entity: 'imports',
      entityId: committed.importId,
    });
    expect(audit[0]?.detail).toMatch(/\d+ transactions/);
  });

  it('an admin may undo an import somebody else ran', async () => {
    const importerId = insertTestUser(current!.db, { name: 'Importer', username: 'importer', role: 'member' });
    const importerToken = createSession(importerId).token;
    // `token` (the outer beforeEach's Alice) is seeded via insertTestUser's own default role, admin.
    const previewResponse = await previewRoute(uploadRequestAs(importerToken));
    const preview = (await previewResponse.json()) as { stagingId: string };
    const commitResponse = await commitRoute(
      jsonRequestAs(importerToken, 'http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    const committed = (await commitResponse.json()) as { importId: number };

    const response = await undoRoute(
      jsonRequest('http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }),
    );
    expect(response.status).toBe(200);
    expect(listAudit()[0]?.userId).not.toBe(importerId);
  });

  // Task 14 fix round 1 (controller ruling): both routes refuse a self-scoped viewer, before
  // any work -- neither writes a transaction nor deletes one.
  it('commit 403s a self-scoped viewer, committing nothing', async () => {
    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kidId, 'self');
    const kidToken = createSession(kidId).token;
    const before = (current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

    const response = await commitRoute(
      jsonRequestAs(kidToken, 'http://nas.local:3000/api/import/commit', {
        stagingId: '00000000-0000-4000-8000-000000000000',
        filename: 'x.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    expect(response.status).toBe(403);
    expect((current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(before);
  });

  it('undo 403s a self-scoped viewer, leaving the import untouched', async () => {
    const previewResponse = await previewRoute(uploadRequest());
    const preview = (await previewResponse.json()) as { stagingId: string };
    const commitResponse = await commitRoute(
      jsonRequest('http://nas.local:3000/api/import/commit', {
        stagingId: preview.stagingId,
        filename: 'td-chequing.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      }),
    );
    const committed = (await commitResponse.json()) as { importId: number };
    const before = (current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(kidId, 'self');
    const kidToken = createSession(kidId).token;

    const response = await undoRoute(
      jsonRequestAs(kidToken, 'http://nas.local:3000/api/import/undo', { importId: committed.importId, confirm: true }),
    );
    expect(response.status).toBe(403);
    expect((current!.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(before);
  });
});
