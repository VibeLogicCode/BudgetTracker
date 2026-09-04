import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setUserVisibility } from '@/lib/auth/users';
import { upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

/**
 * Finding I-1 (v1.30.0 whole-branch review). The S-18 fix narrowed the per-recipient message for a
 * self-scoped recipient and passed THAT message to enqueue with no `household:` override, so
 * outbox.ts copied the narrowed subject/body verbatim into the family-channel row (user_id NULL)
 * and every later member's evaluation hit onConflictDoNothing -- the family room could read a
 * child's personal figures as the household digest, once a month, order-dependently.
 *
 * Each test below has the shape of tests/lib/notify/evaluate/digest-household.test.ts, which
 * covers the one event (weekly_digest) that already had its household variant: route the event to
 * a family Telegram channel, evaluate as a SELF-SCOPED member whose only personal channel is
 * email, and assert the two rows say different, correct things -- the family row the household's
 * figures, the member's own row only theirs.
 */
const FAMILY_TOKEN = '888800001:AAFAMILY-invented-token-never-a-real-one';
const FAMILY_CHAT = '-1009876543210';
const NOW = new Date('2026-08-01T09:00:00Z');
const TZ = 'UTC';

let t: TestDb;
let accountId: number;
let adminId: number;
let groceries: number;
let gas: number;

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  adminId = insertTestUser(t.db, { username: 'admin', name: 'Admin' });
  groceries = categoryIdByName(t.db, 'Groceries');
  gas = categoryIdByName(t.db, 'Gas');
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.invalid',
    password: 'pw',
    fromEmail: 'me@example.invalid',
    fromName: 'Budget Tracker',
    enabled: true,
  });
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

/** A self-scoped member whose only personal channel is email. */
function selfScopedMember(): number {
  const userId = insertTestUser(t.db, { username: 'kid', name: 'Kid', role: 'member' });
  saveEmailTarget({ userId, destination: 'kid@example.invalid', enabled: true });
  setUserVisibility(userId, 'self');
  return userId;
}

/** Routes ONE event to the family Telegram channel. All three are default-off (MUST-9.2). */
function routeToFamily(eventId: string): void {
  expect(
    upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId: adminId })
      .ok,
  ).toBe(true);
  expect(setHouseholdEventPref({ eventId, channel: 'telegram', enabled: true }).ok).toBe(true);
}

function spend(categoryId: number, cents: number, date: string, attributedUserId: number | null = null): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${adminId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
  );
}

/** Six flat $600 months ending 2026-06, then a $713.40 July: a $113.40 difference per row. */
function seedCategoryHistory(categoryId: number, attributedUserId: number | null = null): void {
  for (const month of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
    spend(categoryId, 60000, `${month}-10`, attributedUserId);
  }
  spend(categoryId, 71340, '2026-07-10', attributedUserId);
}

interface Row {
  userId: number | null;
  channel: string;
  subject: string;
  body: string;
}

function rows(): Row[] {
  return t.sqlite
    .prepare('select user_id as userId, channel, subject, body from notification_outbox order by id')
    .all() as Row[];
}

function familyRow(): Row {
  const row = rows().find((r) => r.userId === null);
  expect(row, 'no family-channel row (user_id NULL) was written').toBeTruthy();
  return row as Row;
}

function personalRow(userId: number): Row {
  const row = rows().find((r) => r.userId === userId);
  expect(row, `no personal row for user ${userId}`).toBeTruthy();
  return row as Row;
}

describe('I-1: predicted_vs_actual', () => {
  it("writes the HOUSEHOLD comparison to the family row while the self-scoped member's own row keeps only theirs", () => {
    routeToFamily('predicted_vs_actual');
    const self = selfScopedMember();
    setPref(self, 'predicted_vs_actual', 'email', true);
    seedCategoryHistory(groceries); // unattributed: the household's money, not this member's
    seedCategoryHistory(gas, self); // this member's own

    expect(evaluateMonthBoundary({ userId: self, now: NOW, tz: TZ })).toBe(1);

    const family = familyRow();
    expect(family.channel).toBe('telegram');
    expect(family.body).toContain('Household');
    expect(family.body).toContain('Groceries');
    expect(family.body).toContain('came in $226.80 over what the last six months pointed at');
    // The room gets the household's message, not one member's: a Household block, the true
    // household total, and no "Yours" block at all -- "Yours" is a word addressed to one reader
    // and the family channel has no reader to address.
    //
    // The household block DOES name Gas, and that is correct rather than a leak: household scope
    // is everybody's money, this member's included, so their $713.40 is part of the household's
    // own comparison and part of the $226.80 asserted above. v1.28.0 decision 3 is that routing an
    // event to a family channel deliberately puts household figures in a room every member reads
    // (see HOUSEHOLD_VIEWER's docblock in evaluate/digest.ts). What I-1 is about is the room
    // reading this member's OWN message in place of the household's.
    expect(family.body).not.toContain('Yours');

    // Round 1's narrowing is untouched: the member's own row still carries only their own.
    const own = personalRow(self);
    expect(own.channel).toBe('email');
    expect(own.body).toContain('Yours');
    expect(own.body).toContain('Gas');
    expect(own.body).not.toContain('Household');
    expect(own.body).not.toContain('Groceries');
    expect(own.body).not.toContain('$226.80');
  });
});

describe('I-1: suggested_budget_refresh', () => {
  it("writes the HOUSEHOLD refresh list to the family row while the self-scoped member's own row keeps only theirs", () => {
    routeToFamily('suggested_budget_refresh');
    const self = selfScopedMember();
    setPref(self, 'suggested_budget_refresh', 'email', true);
    seedCategoryHistory(groceries);
    seedCategoryHistory(gas, self);

    expect(evaluateMonthBoundary({ userId: self, now: NOW, tz: TZ })).toBe(1);

    const family = familyRow();
    expect(family.channel).toBe('telegram');
    expect(family.body).toContain('Household');
    expect(family.body).toContain('Groceries');
    expect(family.body).not.toContain('Yours');
    // As above: the household list names this member's category too, because household scope
    // includes their spend. The subject is what separates the two audiences here -- the room is
    // told how many HOUSEHOLD budgets changed (Food, Groceries, Transport, Gas), the member how
    // many of their own did (Transport, Gas).
    expect(family.subject).toBe('New month: 4 suggested budgets changed');

    const own = personalRow(self);
    expect(own.channel).toBe('email');
    expect(own.subject).toBe('New month: 2 suggested budgets changed');
    expect(own.body).toContain('Yours');
    expect(own.body).toContain('Gas');
    expect(own.body).not.toContain('Household');
    expect(own.body).not.toContain('Groceries');
  });
});

describe('I-1: monthly_digest', () => {
  it("writes the HOUSEHOLD figures to the family row while the self-scoped member's own row keeps only theirs", () => {
    routeToFamily('monthly_digest');
    const self = selfScopedMember();
    setPref(self, 'monthly_digest', 'email', true);
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 50000 });
    spend(groceries, 60000, '2026-07-10'); // the household's $600 against a $500 limit
    upsertBudget({ scope: 'personal', userId: self, categoryId: gas, month: '2026-07', amountCents: 20000 });
    spend(gas, 15000, '2026-07-10', self); // this member's own $150 against a $200 limit

    expect(evaluateMonthBoundary({ userId: self, now: NOW, tz: TZ })).toBe(1);

    const family = familyRow();
    expect(family.channel).toBe('telegram');
    expect(family.body).toContain('Budgets: $600.00 of $500.00 spent, $100.00 over.');
    expect(family.body).toContain('Spent: $750.00');
    // The defect in one line: the room must never read this member's personal budget as the
    // household's.
    expect(family.body).not.toContain('$200.00');

    const own = personalRow(self);
    expect(own.channel).toBe('email');
    expect(own.body).toContain('Budgets: $150.00 of $200.00 spent, $50.00 left.');
    expect(own.body).toContain('Spent: $150.00');
    expect(own.body).not.toContain('$600.00');
    expect(own.body).not.toContain('$500.00');
  });
});

/**
 * The other half of I-1's order-dependence, and the one case the three above cannot show: a
 * self-scoped member with NO attributed spend of their own. Round 1 returned 0 for them before
 * anything was enqueued -- their own message had no lines -- so they stopped contributing the
 * family row too, and in a household where every opted-in member is self-scoped the room got
 * nothing at all for the month. That is the same failure round 0 of the S-18 fix produced for
 * budget alerts, which is why enqueue has familyChannelOnly (see its docblock in outbox.ts): the
 * family row is written, the empty personal copy is not.
 */
describe('I-1: a self-scoped member with nothing of their own', () => {
  it('still writes the family row, and gets no empty personal copy of it', () => {
    routeToFamily('predicted_vs_actual');
    const self = selfScopedMember();
    setPref(self, 'predicted_vs_actual', 'email', true);
    seedCategoryHistory(groceries); // the household's money; this member has none of their own

    expect(evaluateMonthBoundary({ userId: self, now: NOW, tz: TZ })).toBe(1);

    const family = familyRow();
    expect(family.channel).toBe('telegram');
    expect(family.body).toContain('Household');
    expect(family.body).toContain('Groceries');
    expect(family.body).toContain('came in $113.40 over what the last six months pointed at');
    expect(rows().filter((row) => row.userId === self)).toEqual([]);
  });
});
