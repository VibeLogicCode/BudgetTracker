import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { POST as detectRoute } from '@/app/api/import/detect/route';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { setUserVisibility } from '@/lib/auth/users';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { BUILTIN_PRESETS, getProfileByName } from '@/lib/import/presets';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let userId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-detect-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
  userId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  token = createSession(userId).token;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function upload(name: string, withAuth = true, as = name): Request {
  const form = new FormData();
  form.append('file', new File([fixture(name)], as, { type: 'text/csv' }));
  return new Request('http://nas.local:3000/api/import/detect', {
    method: 'POST',
    headers: {
      origin: 'http://nas.local:3000',
      host: 'nas.local:3000',
      ...(withAuth ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}),
    },
    body: form,
  });
}

interface DetectBody {
  stagingId: string;
  filename: string;
  profile: { id: number; name: string } | null;
  profileReason: string;
  profileConfidence: string;
  account: { id: number; name: string } | null;
  accountReason: string;
  accountConfidence: string;
}

describe('POST /api/import/detect', () => {
  it('stages the file once and names the profile that can read it', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const response = await detectRoute(upload('td-chequing.csv'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as DetectBody;
    expect(body.profile?.name).toBe('TD Chequing/Debit');
    expect(body.profileConfidence).toBe('certain');
    // Staged under the same id the preview call will re-read, so the file uploads exactly once.
    expect(fs.existsSync(path.join(tempDir, 'tmp', `${body.stagingId}.csv`))).toBe(true);
  });

  it('names the account whose rows this file already contains', async () => {
    const chequing = insertTestAccount(current!.db, { name: 'TD Chequing' });
    insertTestAccount(current!.db, { name: 'Other account' });
    const rows = parseCsv(fixture('td-chequing.csv'), BUILTIN_PRESETS['TD Chequing/Debit'].mapping).rows;
    commitImport({
      accountId: chequing,
      profileId: null,
      filename: 'td-chequing.csv',
      importedBy: userId,
      rows: computeRowHashes(chequing, rows),
      errors: [],
      mapping: BUILTIN_PRESETS['TD Chequing/Debit'].mapping,
    });

    const body = (await (await detectRoute(upload('td-chequing.csv'))).json()) as DetectBody;
    expect(body.account?.id).toBe(chequing);
    expect(body.accountReason).toContain('already in TD Chequing');
  });

  it('offers only profiles the import picker itself offers', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    // The detected id must be a real profile row, not an index into the shipped preset table.
    const body = (await (await detectRoute(upload('scotia.csv'))).json()) as DetectBody;
    expect(body.profile?.id).toBe(getProfileByName('Scotiabank Chequing/Debit')?.id);
  });

  it('says so honestly when nothing can read the file', async () => {
    insertTestAccount(current!.db, { name: 'TD Chequing' });
    const form = new FormData();
    form.append('file', new File(['this is not a statement at all'], 'notes.csv', { type: 'text/csv' }));
    const response = await detectRoute(
      new Request('http://nas.local:3000/api/import/detect', {
        method: 'POST',
        headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: form,
      }),
    );
    const body = (await response.json()) as DetectBody;
    expect(response.status).toBe(200);
    expect(body.profile).toBeNull();
    expect(body.profileReason.length).toBeGreaterThan(0);
  });
});

describe('POST /api/import/detect: who may call it', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await detectRoute(upload('td-chequing.csv', false));
    expect(response.status).toBe(401);
  });

  it('refuses a self-scoped member, exactly as preview does', async () => {
    // An admin cannot be limited to their own records, so the self case needs a member.
    const member = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    setUserVisibility(member, 'self');
    token = createSession(member).token;
    const response = await detectRoute(upload('td-chequing.csv'));
    expect(response.status).toBe(403);
  });

  it('refuses a cross-origin request', async () => {
    const form = new FormData();
    form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
    const response = await detectRoute(
      new Request('http://nas.local:3000/api/import/detect', {
        method: 'POST',
        headers: { origin: 'http://evil.example', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: form,
      }),
    );
    expect(response.status).toBe(403);
  });
});
