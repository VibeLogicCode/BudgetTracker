import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';

/**
 * v1.60.1. What the real actions and routes say when zod refuses their input, as they said it on
 * zod 3.25.76. The schemas behind these sentences live inside 'use server' files and route
 * modules, so this is the only place they can be checked end to end. This file imports no zod
 * itself. Every expectation is a literal copied from zod 3's output.
 */
const headerBag = vi.hoisted(() => ({ value: new Headers({ host: 'budget.local', origin: 'http://budget.local' }) }));
const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Sam', username: 'sam', role: 'admin' as 'admin' | 'member' } }));

vi.mock('next/headers', () => ({ headers: async () => headerBag.value }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`unexpected redirect to ${to}`);
  },
}));
// The actions read the person from requireUser/requireAdmin; the routes read the session cookie
// through the real userFromRequest, so everything else in the module stays as it is.
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireUser: async () => currentUser.value,
  requireAdmin: async () => currentUser.value,
}));

const { createSession, SESSION_COOKIE_NAME } = await import('@/lib/auth/session');
const notifications = await import('@/app/(app)/settings/notifications/actions');
const backups = await import('@/app/(app)/settings/backups/actions');
const accounts = await import('@/app/(app)/settings/accounts/actions');
const itemTypes = await import('@/app/(app)/settings/item-types/actions');
const users = await import('@/app/(app)/settings/users/actions');
const transactions = await import('@/app/(app)/transactions/actions');
const warranties = await import('@/app/(app)/warranties/actions');
const { POST: previewRoute } = await import('@/app/api/import/preview/route');
const { POST: commitRoute } = await import('@/app/api/import/commit/route');
const { POST: batchCommitRoute } = await import('@/app/api/import/batch/commit/route');

const SAME_ORIGIN = 'http://nas.local:3000';
const VALID_SHAPE_ID = '11111111-2222-3333-4444-555555555555';

let t: TestDb;
let tempDir: string;
let originalDataDir: string | undefined;
let token: string;
let accountId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-zod-parity-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  t = createSeededTestDb();
  const userId = insertTestUser(t.db, { role: 'admin', username: 'sam', name: 'Sam' });
  currentUser.value = { id: userId, name: 'Sam', username: 'sam', role: 'admin' };
  headerBag.value = new Headers({ host: 'budget.local', origin: 'http://budget.local' });
  token = createSession(userId).token;
  accountId = insertTestAccount(t.db, { name: 'Joint Chequing', institution: 'Maple Credit Union' });
});

afterEach(() => {
  t.cleanup();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`${SAME_ORIGIN}${url}`, {
    method: 'POST',
    headers: {
      origin: SAME_ORIGIN,
      host: 'nas.local:3000',
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function outcome(response: Response): Promise<{ status: number; error: unknown }> {
  const body = (await response.json()) as { error?: unknown };
  return { status: response.status, error: body.error };
}

describe('notification settings', () => {
  const relay = (over: Record<string, string> = {}) =>
    form({
      preset: 'custom',
      host: 'smtp.example.com',
      port: '587',
      security: 'starttls',
      username: 'alex@example.com',
      password: 'not-a-real-key',
      fromEmail: 'alex@example.com',
      fromName: 'Budget Tracker',
      ...over,
    });

  it('saveSmtpAction', async () => {
    expect(await notifications.saveSmtpAction({}, relay({ port: '0' }))).toEqual({ error: 'Number must be greater than or equal to 1' });
    expect(await notifications.saveSmtpAction({}, relay({ fromEmail: 'nope' }))).toEqual({ error: 'Invalid email' });
    expect(await notifications.saveSmtpAction({}, relay({ username: '' }))).toEqual({
      error: 'String must contain at least 1 character(s)',
    });
  });

  it('saveEmailTargetAction', async () => {
    expect(await notifications.saveEmailTargetAction({}, form({ destination: 'nope' }))).toEqual({ error: 'Invalid email' });
  });

  it('savePreferencesAction', async () => {
    const knobs = (over: Record<string, string>) =>
      form({
        comingDueDays: '7',
        budgetThresholdPct: '80',
        staleImportWeeks: '4',
        dailyHour: '8',
        digestWeekday: '1',
        digestHour: '8',
        summaryFrequency: 'weekly',
        ...over,
      });
    expect(await notifications.savePreferencesAction({}, knobs({ comingDueDays: '400' }))).toEqual({
      error: 'Number must be less than or equal to 365',
    });
    expect(await notifications.savePreferencesAction({}, knobs({ summaryFrequency: 'hourly' }))).toEqual({
      error: "Invalid enum value. Expected 'daily' | 'weekly' | 'manual', received 'hourly'",
    });
  });
});

describe('other settings actions', () => {
  it('stageRestoreAction without the confirmation tick', async () => {
    expect(await backups.stageRestoreAction({}, form({ name: 'budget-2026-03-15.tar.gz' }))).toEqual({
      error: 'Tick the confirmation box first.',
    });
  });

  it('createAccountAction with a long institution', async () => {
    const entries = { name: 'Holiday Fund', institution: 'i'.repeat(81), type: 'savings', owner: '' };
    expect(await accounts.createAccountAction({}, form(entries))).toEqual({ error: 'String must contain at most 80 character(s)' });
  });

  it('createItemTypeAction with an unknown kind', async () => {
    expect(await itemTypes.createItemTypeAction({}, form({ name: 'Boats', kind: 'boat' }))).toEqual({
      error: "Invalid enum value. Expected 'warranty' | 'subscription' | 'contract' | 'loan' | 'bill', received 'boat'",
    });
  });

  it('createUserAction with an unknown role', async () => {
    const entries = { name: 'Alex', username: 'alex', password: 'long-enough-passphrase', role: 'root' };
    expect(await users.createUserAction({}, form(entries))).toEqual({
      error: "Invalid enum value. Expected 'admin' | 'member', received 'root'",
    });
  });
});

describe('transactions and items', () => {
  it('renameTransactionAction with a long display name', async () => {
    const row = t.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'MAPLE GROCER', 'maple grocer', -4250, ${currentUser.value.id}, ${nowIso()}, ${nowIso()})
      returning id`);
    const entries = { transactionId: String(row.id), displayName: 'd'.repeat(201), scope: 'one' };
    expect(await transactions.renameTransactionAction({}, form(entries))).toEqual({
      error: 'String must contain at most 200 character(s)',
    });
  });

  it('createWarrantyAction with a long name', async () => {
    const entries = {
      name: 'n'.repeat(201),
      vendor: 'Maple Appliances',
      model: '',
      serial: '',
      purchaseDate: '2026-03-01',
      warrantyMonths: '24',
      price: '$1,299.99',
      ownerUserId: String(currentUser.value.id),
      transactionId: '',
      notes: '',
      staged: '[]',
      interestRateBasis: 'apr_monthly',
    };
    expect(await warranties.createWarrantyAction({}, form(entries))).toEqual({
      error: 'String must contain at most 200 character(s)',
    });
  });
});

describe('import routes', () => {
  it('preview and commit refuse a malformed staging id, and pass a well-formed one on', async () => {
    const body = (stagingId: string) => ({ stagingId, filename: 'statement.csv', accountId });
    const refused = { status: 400, error: 'Invalid uuid' };
    expect(await outcome(await previewRoute(jsonRequest('/api/import/preview', body('nope'))))).toEqual(refused);
    expect(await outcome(await commitRoute(jsonRequest('/api/import/commit', body('nope'))))).toEqual(refused);
    expect(await outcome(await previewRoute(jsonRequest('/api/import/preview', body(VALID_SHAPE_ID))))).not.toEqual(refused);
    expect(await outcome(await commitRoute(jsonRequest('/api/import/commit', body(VALID_SHAPE_ID))))).not.toEqual(refused);
  });

  it('batch commit refuses an empty file list', async () => {
    expect(await outcome(await batchCommitRoute(jsonRequest('/api/import/batch/commit', { files: [] })))).toEqual({
      status: 400,
      error: 'Array must contain at least 1 element(s)',
    });
  });
});
