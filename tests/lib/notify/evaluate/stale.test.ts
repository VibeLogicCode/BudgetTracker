import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setAccountActive } from '@/lib/accounts';
import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

// Item BT's own test needs viewerFor mockable independently of enqueue()'s separate
// isEventEnabled() guard (config.ts), which runs its own raw `users` query and would otherwise
// mask viewerFor()'s behaviour: a REAL row deletion satisfies isEventEnabled's live-user check
// failing too, so evaluateStaleImport would already return 0 via that unrelated gate regardless
// of what viewerFor does. Spying on viewerFor reproduces the race the docblock actually
// describes -- gone at the moment viewerFor's OWN lookup runs -- without also making
// isEventEnabled see the row as gone. Mirrors digest.test.ts's own BK test (2033d4b).
vi.mock('@/lib/auth/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/users')>();
  // v1.31.0 item M-1: viewerFor now LIVES in this module (it used to be five local copies, one
  // per evaluator), so the spy goes on viewerFor itself rather than on the findUserById it calls.
  // Mocking findUserById here would no longer reach it: viewerFor resolves that name through its
  // own module scope, not through this mocked namespace object.
  return { ...actual, viewerFor: vi.fn(actual.viewerFor) };
});

import { viewerFor } from '@/lib/auth/users';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';

let t: TestDb;
const TZ = 'UTC';

beforeEach(() => {
  t = createSeededTestDb();
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  vi.mocked(viewerFor).mockClear();
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(over: Partial<{ role: 'admin' | 'member'; visibility: 'household' | 'self' }> = {}): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}`, role: over.role ?? 'admin' });
  if (over.visibility) t.db.run(sql`update users set visibility = ${over.visibility} where id = ${userId}`);
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  // stale_import defaults to OFF in the event registry (MUST-4.1: it is one of the chattier
  // informational events a person opts into), so an evaluator test needs it explicitly on.
  setPref(userId, 'stale_import', 'email', true);
  return userId;
}

/** Inserts an import row. Reuses `accountId` when given (so the SAME account's clock advances);
 * otherwise creates a fresh account. Always returns the account id used. */
function importAt(userId: number, createdAt: string, accountId?: number): number {
  const id = accountId ?? insertTestAccount(t.db);
  t.db.run(
    sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
        values (${id}, null, ${'export.csv'}, ${userId}, 10, 0, 0, ${createdAt})`,
  );
  return id;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

function pendingOutbox(userId: number): { body: string; dedupKey: string }[] {
  return t.sqlite
    .prepare('select body, dedup_key as dedupKey from notification_outbox where user_id = ? order by id')
    .all(userId) as { body: string; dedupKey: string }[];
}

describe('decision 10: an install with zero imports never fires', () => {
  it('says nothing before the household has anything to be stale about', () => {
    const userId = emailUser();
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

describe('the N-week threshold', () => {
  it('is silent at N × 7 − 1 days and fires at N × 7', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-28T12:00:00.000Z'); // 20 days before 2026-08-17
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
  });

  it('honours a different staleImportWeeks', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 1 });
    importAt(userId, '2026-08-10T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1);
  });
});

describe('MUST-3.11: one message per calendar week while stale', () => {
  it('dedupes within a week and fires again the following week', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    const accountId = importAt(userId, '2026-07-01T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1); // Monday
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-19T12:00:00Z'), tz: TZ })).toBe(0); // Wednesday
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-24T12:00:00Z'), tz: TZ })).toBe(1); // next Monday
    expect(keys()).toEqual([`stale:2026-08-17:${accountId}`, `stale:2026-08-24:${accountId}`]);
  });
});

describe('MUST-14.8: any imports row resets the SAME account clock, including a SimpleFIN sync', () => {
  it('a recent import to the same account silences the event', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    const accountId = importAt(userId, '2026-07-01T12:00:00.000Z');
    importAt(userId, '2026-08-16T12:00:00.000Z', accountId);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
  });
});

describe('the body', () => {
  it('names the last import date and the days since', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-27T12:00:00.000Z');
    evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ });
    const row = t.sqlite.prepare('select subject, body from notification_outbox').get() as {
      subject: string;
      body: string;
    };
    expect(row.subject).toBe('No transactions imported in 3 weeks');
    expect(row.body).toContain('The last import was 2026-07-27 (21 days ago).');
  });
});

describe('ruling R14: the stale-import alert names the account', () => {
  let userId = 0;
  let accountA = 0;
  let accountB = 0;

  beforeEach(() => {
    userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    accountA = insertTestAccount(t.db, { name: 'Chequing' });
    accountB = insertTestAccount(t.db, { name: 'Amex', type: 'credit' });
    importAt(userId, '2026-08-26T12:00:00.000Z', accountA); // 1 day before 'now' below: fresh
    importAt(userId, '2026-07-28T12:00:00.000Z', accountB); // 30 days before 'now' below: stale
  });

  it('fires once for the lagging account and not for the fresh one', () => {
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' })).toBe(1);
    const queued = pendingOutbox(userId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.body).toContain('Amex');
    expect(queued[0]?.dedupKey).toBe(`stale:2026-08-24:${accountB}`);
  });

  it('a second evaluation in the same week enqueues nothing', () => {
    evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' });
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-28T09:00:00Z'), tz: 'America/Toronto' })).toBe(0);
  });

  it('the next Monday is a new key, so it nags again', () => {
    evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' });
    expect(evaluateStaleImport({ userId, now: new Date('2026-09-03T09:00:00Z'), tz: 'America/Toronto' })).toBe(1);
  });

  it('an inactive account never fires, and an install with no imports still fires nothing', () => {
    setAccountActive(accountB, false);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' })).toBe(0);
  });
});

// v1.13.0 whole-branch review, item I5. evaluateStaleImport took no viewer at all and queried
// every account in the install unconditionally, so a self-visibility recipient was told about
// (and could be emailed the name of) an account they cannot see on any page in the app --
// household data reaching a self viewer through the ONE channel that isn't a page render.
describe('ruling R2 (item I5): a self-scoped recipient never gets stale_import, even with a genuinely stale account', () => {
  it('returns 0 and enqueues nothing for a self-scoped (member, visibility self) recipient', () => {
    const userId = emailUser({ role: 'member', visibility: 'self' });
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-01T12:00:00.000Z'); // 47 days before 'now' below -- genuinely stale
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('the same stale account still fires for a household recipient (regression guard)', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-01T12:00:00.000Z');
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(1);
  });
});

describe('item BT: viewerFor skips rather than falling back to a household scope', () => {
  it('sends nothing when the recipient\'s own row is gone, even with a genuinely stale account', () => {
    const userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
    importAt(userId, '2026-07-01T12:00:00.000Z'); // genuinely stale by 'now' below
    // The fallback was { role: 'admin', visibility: 'household' }, so a self-scoped recipient
    // whose row vanished mid-batch would read as household-scoped instead, and the ruling R2
    // guard that exists specifically to keep a self viewer from being nagged about accounts they
    // cannot see would silently not fire for that one case.
    //
    // viewerFor is stubbed to return null for exactly the one call the evaluator makes, leaving
    // the real users/prefs rows untouched -- a real row deletion would ALSO trip enqueue()'s own
    // independent isEventEnabled() live-user check (config.ts), which would return 0 regardless
    // of what viewerFor does and prove nothing about this fix.
    vi.mocked(viewerFor).mockReturnValueOnce(null);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-17T12:00:00Z'), tz: TZ })).toBe(0);
    const count = (
      t.sqlite.prepare('select count(*) as c from notification_outbox where user_id = ?').get(userId) as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
