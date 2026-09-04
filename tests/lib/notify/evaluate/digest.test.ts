import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { upsertBudget } from '@/lib/budgets';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

// Item BK's own test needs findUserById mockable independently of enqueue()'s separate
// isEventEnabled() guard (config.ts), which runs its own raw `users` query and would otherwise
// mask viewerFor()'s behaviour: a REAL row deletion satisfies isEventEnabled's live-user check
// failing too, so evaluateWeeklyDigest would already return 0 via that unrelated gate regardless
// of what viewerFor does. Spying on findUserById reproduces the race the docblock actually
// describes -- gone at the moment viewerFor's OWN lookup runs -- without also making
// isEventEnabled see the row as gone.
vi.mock('@/lib/auth/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/users')>();
  return { ...actual, findUserById: vi.fn(actual.findUserById) };
});

import { findUserById, setUserVisibility } from '@/lib/auth/users';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';

let t: TestDb;
let accountId: number;
let creatorId: number;
const NOW = new Date('2026-08-17T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  // A fixed FK target for transactions.created_by (NOT NULL) — independent of
  // notification attribution, which each test controls via emailUser()/spend().
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  vi.mocked(findUserById).mockClear();
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(role: 'admin' | 'member' = 'admin'): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}`, role });
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
  setPref(userId, 'weekly_digest', 'email', true); // default-off (MUST-4.1)
  return userId;
}

function spend(categoryId: number, cents: number, date: string, attributedUserId: number | null = null, merchant = 'LOBLAWS'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${merchant}, ${normalizeMerchant(merchant)}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
  );
}

function body(): string {
  const row = t.sqlite.prepare('select body from notification_outbox').get() as { body: string };
  return row.body;
}

describe('§10.2: the window is [slot − 7, slot − 1]', () => {
  it('includes the seven days ending the day before the slot and excludes the slot day itself', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 1000, '2026-08-10'); // in (slot − 7)
    spend(groceries, 2000, '2026-08-16'); // in (slot − 1)
    spend(groceries, 4000, '2026-08-17'); // the slot day — OUT
    spend(groceries, 8000, '2026-08-09'); // before the window — OUT

    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    const subject = (t.sqlite.prepare('select subject from notification_outbox').get() as { subject: string }).subject;
    expect(subject).toBe('Weekly summary — 2026-08-10 to 2026-08-16');
    expect(body()).toContain('Household spend: $30.00');
  });

  it('reports the recipient’s own attributed spend separately', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 1000, '2026-08-12', userId);
    spend(groceries, 3000, '2026-08-13', null);
    evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
    expect(body()).toContain('Household spend: $40.00');
    expect(body()).toContain('$10.00');
  });

  it('names the top categories and merchants', () => {
    const userId = emailUser();
    spend(categoryIdByName(t.db, 'Groceries'), 40211, '2026-08-12', null, 'LOBLAWS');
    spend(categoryIdByName(t.db, 'Gas'), 12100, '2026-08-13', null, 'PETRO-CANADA');
    evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW });
    expect(body()).toContain('Top categories (household)');
    expect(body()).toContain('Groceries');
    expect(body()).toContain('Top merchants (household)');
    // topMerchants() reports normalizedMerchant, which normalizeMerchant() UPPERCASES —
    // production digests show 'LOBLAWS', matching the raw description here.
    expect(body()).toContain('LOBLAWS');
  });
});

describe('§10.2: an empty week still sends', () => {
  it('renders the empty sentence rather than staying silent', () => {
    const userId = emailUser();
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(body()).toContain('No transactions were recorded this week.');
  });
});

describe('MUST-3.11: once per weekly slot', () => {
  it('dedupes a second evaluation of the same slot and fires for the next one', () => {
    const userId = emailUser();
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(0);
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-24', now: new Date('2026-08-24T12:00:00Z') })).toBe(1);
    const keys = (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
      (r) => r.dedup_key,
    );
    expect(keys).toEqual(['digest:2026-08-17', 'digest:2026-08-24']);
  });
});

/**
 * v1.13.0 ruling R2 (Task 6 fix round 1, controller ruling): the weekly digest builds its viewer
 * from the RECIPIENT's own user record (viewerFor in digest.ts), so a self-visibility recipient's
 * "household" figure collapses to their own scope exactly like every other reports.ts aggregate
 * -- no household total, belonging to someone else, may reach a self viewer through this or any
 * other channel.
 */
describe('ruling R2: a self-visibility recipient never receives the true household total', () => {
  it('"Household spend" collapses to the recipient\'s own figure, never the full household total', () => {
    const userId = emailUser('member');
    setUserVisibility(userId, 'self');
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 1000, '2026-08-12', userId); // the recipient's own $10
    spend(groceries, 9000, '2026-08-13', null); // someone/unattributed else's $90 -- must never reach them

    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(body()).toContain('Household spend: $10.00');
    expect(body()).toContain('Your spend:      $10.00');
    // The true combined household total ($10 + $90) must never appear anywhere in this recipient's digest.
    expect(body()).not.toContain('$100.00');
  });
});

/**
 * S-18 fix (v1.13.0 ruling R2, review follow-up): every OTHER line in evaluateWeeklyDigest
 * already went through `viewer` (the describe block above), but `overBudget` was read from
 * budgetProgress(month, 'household', null) unconditionally -- the one line that did not, and
 * so the one household figure that reached a self-scoped recipient's own digest by push. Fixed
 * by branching on isSelfScoped(viewer): a self-scoped recipient's overBudget now comes from
 * budgetProgress(month, 'personal', viewer.id) instead.
 */
describe('S-18 fix (v1.13.0 ruling R2): overBudget names only the recipient\'s own over-budget categories', () => {
  it('a self-scoped recipient sees no household over-budget category, but does see their own', () => {
    const userId = emailUser('member');
    setUserVisibility(userId, 'self');
    const groceries = categoryIdByName(t.db, 'Groceries');
    const gas = categoryIdByName(t.db, 'Gas');

    // A household budget, blown by someone else's (unattributed) spend -- must never reach
    // this recipient's "Over budget this month" line.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 10000 });
    spend(groceries, 20000, '2026-08-12'); // $200.00 against a $100.00 household limit

    // This recipient's OWN personal budget, blown by their own spend -- must still appear.
    upsertBudget({ scope: 'personal', userId, categoryId: gas, month: '2026-08', amountCents: 5000 });
    spend(gas, 9000, '2026-08-12', userId); // $90.00 against a $50.00 personal limit

    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(body()).not.toContain('Groceries');
    expect(body()).toContain('Over budget this month: Gas');
  });

  it('a household-visibility member and an admin see the household over-budget category unchanged', () => {
    const member = emailUser('member'); // household-visibility (the default), not self-scoped
    const admin = emailUser('admin');
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 10000 });
    spend(groceries, 20000, '2026-08-12');

    expect(evaluateWeeklyDigest({ userId: member, slotDate: '2026-08-17', now: NOW })).toBe(1);
    const memberBody = (t.sqlite.prepare('select body from notification_outbox where user_id = ?').get(member) as { body: string }).body;
    expect(memberBody).toContain('Over budget this month: Groceries');

    expect(evaluateWeeklyDigest({ userId: admin, slotDate: '2026-08-17', now: NOW })).toBe(1);
    const adminBody = (t.sqlite.prepare('select body from notification_outbox where user_id = ?').get(admin) as { body: string }).body;
    expect(adminBody).toContain('Over budget this month: Groceries');
  });
});

describe('item BK: viewerFor skips rather than falling back to a household scope', () => {
  it('sends nothing when the recipient\'s own row is gone', () => {
    const userId = emailUser();
    // The fallback was { role: 'admin', visibility: 'household' }, so a self-scoped child whose
    // account was deleted mid-batch could have carried household-wide figures in that one
    // delivery. Silence is safer than an over-scoped send.
    //
    // findUserById is stubbed to return null for exactly the one call viewerFor makes, leaving
    // the real users/prefs rows untouched -- a real row deletion would ALSO trip enqueue()'s own
    // independent isEventEnabled() live-user check (config.ts), which would return 0 regardless
    // of what viewerFor does and prove nothing about this fix. This reproduces the race the
    // docblock actually describes: gone at the moment viewerFor's own lookup runs.
    vi.mocked(findUserById).mockReturnValueOnce(null);
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-24', now: new Date('2026-08-24T10:00:00Z') })).toBe(0);
    const count = (
      t.sqlite.prepare('select count(*) as c from notification_outbox where user_id = ?').get(userId) as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
