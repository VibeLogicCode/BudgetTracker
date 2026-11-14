import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, type TestDb } from '../helpers/db';
import { POST as importDetect } from '@/app/api/import/detect/route';
import { POST as importBatchDetect } from '@/app/api/import/batch/detect/route';
import { POST as importPreview } from '@/app/api/import/preview/route';
import { POST as importCommit } from '@/app/api/import/commit/route';
import { POST as importUndo } from '@/app/api/import/undo/route';
import { GET as profilesExport } from '@/app/api/packs/profiles/export/route';
import { POST as profilesImport } from '@/app/api/packs/profiles/import/route';
import { GET as rulesExport } from '@/app/api/packs/rules/export/route';
import { POST as rulesImport } from '@/app/api/packs/rules/import/route';
import { POST as simplefinClaim } from '@/app/api/simplefin/claim/route';
import { POST as simplefinLink } from '@/app/api/simplefin/link/route';
import { POST as simplefinSync } from '@/app/api/simplefin/sync/route';
import { POST as statementPrefill } from '@/app/api/loans/statement-prefill/route';
import { POST as receiptStage } from '@/app/api/warranties/receipts/stage/route';
import { GET as stagePoll } from '@/app/api/warranties/receipts/stage/[stagingId]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createUser, setMustChangePassword } from '@/lib/auth/users';

/**
 * v1.64.1: userFromRequest() answers as signed out for a person who still has to choose their own
 * password, so every route under src/app/api treats them as it treats no session at all.
 */
let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-forced-change-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  current = createSeededTestDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  current?.cleanup();
  current = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function flaggedAdmin(): Promise<{ id: number; cookie: string }> {
  const alex = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin', mustChangePassword: true });
  return { id: alex.id, cookie: `${SESSION_COOKIE_NAME}=${createSession(alex.id).token}` };
}

function post(route: string, cookie: string, body: BodyInit): Request {
  return new Request(`http://nas.local:3000${route}`, {
    method: 'POST',
    headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie },
    body,
  });
}

function get(route: string, cookie: string): Request {
  return new Request(`http://nas.local:3000${route}`, { headers: { cookie } });
}

function smallForm(): FormData {
  const form = new FormData();
  form.append('file', new File(['Date,Description,Amount\n2026-03-09,MAPLE GROCER,-42.17\n'], 'statement.csv', { type: 'text/csv' }));
  return form;
}

const STAGING_ID = '0b9d2c4e-7f1a-4c3b-9e8d-5a6b7c8d9e0f';

function everyRoute(cookie: string): Array<[string, () => Promise<Response>]> {
  return [
    ['import detect', () => importDetect(post('/api/import/detect', cookie, smallForm()))],
    ['import batch detect', () => importBatchDetect(post('/api/import/batch/detect', cookie, smallForm()))],
    ['import preview', () => importPreview(post('/api/import/preview', cookie, JSON.stringify({ stagingId: STAGING_ID })))],
    ['import commit', () => importCommit(post('/api/import/commit', cookie, JSON.stringify({ stagingId: STAGING_ID })))],
    ['import undo', () => importUndo(post('/api/import/undo', cookie, JSON.stringify({ importId: 1 })))],
    ['profiles pack export', () => profilesExport(get('/api/packs/profiles/export', cookie))],
    ['profiles pack import', () => profilesImport(post('/api/packs/profiles/import', cookie, smallForm()))],
    ['rules pack export', () => rulesExport(get('/api/packs/rules/export', cookie))],
    ['rules pack import', () => rulesImport(post('/api/packs/rules/import', cookie, smallForm()))],
    ['SimpleFIN claim', () => simplefinClaim(post('/api/simplefin/claim', cookie, JSON.stringify({ setupToken: 'x' })))],
    ['SimpleFIN link', () => simplefinLink(post('/api/simplefin/link', cookie, JSON.stringify({})))],
    ['SimpleFIN sync', () => simplefinSync(post('/api/simplefin/sync', cookie, JSON.stringify({})))],
    ['statement prefill', () => statementPrefill(post('/api/loans/statement-prefill', cookie, smallForm()))],
    ['receipt stage', () => receiptStage(post('/api/warranties/receipts/stage', cookie, smallForm()))],
    [
      'receipt stage poll',
      () => stagePoll(get(`/api/warranties/receipts/stage/${STAGING_ID}`, cookie), { params: Promise.resolve({ stagingId: STAGING_ID }) }),
    ],
  ];
}

describe('v1.64.1: routes answer a flagged person as signed out', () => {
  it('every import, pack, SimpleFIN, statement and receipt-staging route answers 401', async () => {
    const { cookie } = await flaggedAdmin();
    for (const [label, call] of everyRoute(cookie)) {
      expect((await call()).status, label).toBe(401);
    }
    // Nothing was staged or written under the data folder.
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('the same session is let through once the flag is clear', async () => {
    const { id, cookie } = await flaggedAdmin();
    setMustChangePassword(id, false);
    expect((await rulesExport(get('/api/packs/rules/export', cookie))).status).toBe(200);
    const poll = await stagePoll(get(`/api/warranties/receipts/stage/${STAGING_ID}`, cookie), {
      params: Promise.resolve({ stagingId: STAGING_ID }),
    });
    expect(poll.status).not.toBe(401);
  });
});
