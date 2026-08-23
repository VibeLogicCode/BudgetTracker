import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { effectiveBudget, setRollover, upsertBudget } from '@/lib/budgets';
import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';
import { setTransactionSplits } from '@/lib/splits';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
const NOW = new Date('2026-08-17T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  // A fixed FK target for transactions.created_by (NOT NULL) — independent of
  // notification attribution, which each test controls via emailUser()/spend().
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  t.cleanup();
});

function emailUser(): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}` });
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
  // budget_threshold is default-off (MUST-4.1); every test here wants it on.
  setPref(userId, 'budget_threshold', 'email', true);
  return userId;
}

function spend(categoryId: number, cents: number, attributedUserId: number | null = null, date = '2026-08-05'): number {
  // Returns the new row's id (needed by the split-clearing regression below); every existing
  // caller here ignores the return value, so widening void -> number is not a breaking change.
  const row = t.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-6.16: the thresholds', () => {
  it('is silent at 79%, fires the threshold at 80%, and fires exceeded past 100%', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });

    spend(groceries, 39500); // 79%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);

    resetBudgetFingerprintForTests();
    spend(groceries, 500); // 80%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`budget:h:${groceries}:2026-08:80`]);

    resetBudgetFingerprintForTests();
    spend(groceries, 15000); // 110%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toContain(`budget:h:${groceries}:2026-08:100`);
  });

  it('MUST-6.17: a single import that jumps from under the threshold to over 100% fires both', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${gas}:2026-08:100`, `budget:h:${gas}:2026-08:80`]);
  });

  it('does not re-fire the same category in the same month', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 9000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    resetBudgetFingerprintForTests();
    spend(gas, 100);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
  });

  it('raising the threshold mid-month fires again at the new number', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 9500);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys()).toEqual([`budget:h:${gas}:2026-08:80`]);
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toContain(`budget:h:${gas}:2026-08:90`);
  });

  it('an unbudgeted category never fires', () => {
    emailUser();
    spend(categoryIdByName(t.db, 'Gas'), 999999);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
  });
});

describe('MUST-6.15: household and personal scopes are independent facts', () => {
  it('the same category can fire once for each scope', () => {
    const userId = emailUser();
    const coffee = categoryIdByName(t.db, 'Coffee');
    // Deliberately decoupled from the MUST-6.17 jump case: household (9000/10000 = 90%)
    // only crosses its threshold, never its limit; personal (9000/5000 = 180%) crosses
    // both. The point here is scope independence, not the same-tick double-fire.
    upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 10000 });
    upsertBudget({ scope: 'personal', userId, categoryId: coffee, month: '2026-08', amountCents: 5000 });
    spend(coffee, 9000, userId);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys().sort()).toEqual(
      [`budget:h:${coffee}:2026-08:80`, `budget:p:${coffee}:2026-08:100`, `budget:p:${coffee}:2026-08:80`].sort(),
    );
  });

  it('a personal budget only reaches its own owner', () => {
    const mine = emailUser();
    const theirs = emailUser();
    const coffee = categoryIdByName(t.db, 'Coffee');
    upsertBudget({ scope: 'personal', userId: mine, categoryId: coffee, month: '2026-08', amountCents: 5000 });
    spend(coffee, 9000, mine);
    evaluateBudgets({ now: NOW, tz: TZ });
    const rows = t.sqlite.prepare('select distinct user_id from notification_outbox').all() as { user_id: number }[];
    expect(rows.map((r) => r.user_id)).toEqual([mine]);
    expect(theirs).toBeGreaterThan(0);
  });

  it('a household budget reaches every user with the event enabled', () => {
    const a = emailUser();
    const b = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    const owners = new Set(
      (t.sqlite.prepare('select user_id from notification_outbox').all() as { user_id: number }[]).map((r) => r.user_id),
    );
    expect([...owners].sort()).toEqual([a, b].sort());
  });
});

describe('MUST-6.18: the fingerprint guard', () => {
  it('skips a second tick when nothing has changed', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    // Second tick with no data change: no work at all, and nothing new enqueued.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(2);
  });

  it('does NOT skip after a re-categorisation (max(updated_at) moved)', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    const coffee = categoryIdByName(t.db, 'Coffee');
    upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    expect(keys()).toEqual([]);
    t.db.run(sql`update transactions set category_id = ${coffee}, updated_at = ${'2026-08-17T11:59:00.000Z'}`);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
  });

  it('does NOT skip after a new user enables the event', () => {
    const a = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 20000);
    evaluateBudgets({ now: NOW, tz: TZ });
    const b = emailUser();
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(b).toBeGreaterThan(a);
  });

  it('does NOT skip after a threshold change', () => {
    const userId = emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 });
    spend(gas, 8500);
    evaluateBudgets({ now: NOW, tz: TZ });
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0); // 85% is below the new 90
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 84 });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
  });

  it('does NOT skip after a budget is set mid-month, with the SAME transactions and no fingerprint reset', () => {
    emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    // No budget yet — the row has limitCents === null and cannot fire, regardless of spend.
    spend(gas, 9000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    // Setting the budget is the ONLY change between these two ticks — no new/updated
    // transaction. The fingerprint must fold in the budgets table (count + max id) for this
    // to be seen on the very next tick rather than waiting for the next import.
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 }); // 9000/10000 = 90%
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`budget:h:${gas}:2026-08:80`]);
  });
});

/**
 * DEFECT regression (adversarial review, 2026-08-22): setTransactionSplits's clear path
 * (src/lib/splits.ts) only bumped transactions.updated_at when the parent's category_id was
 * NULL. The fingerprint above is built from transactions(count, max(id), max(updated_at)) +
 * budgets(count, max(id)); clearing a split on a row that already carried a category changes
 * every aggregate's answer for that category without inserting/deleting a row, so
 * updated_at was the ONLY column left that could move the fingerprint. Left conditional, a
 * clear that raises a category back over budget was silently invisible to this evaluator
 * until some unrelated transaction changed. The fix makes that updated_at bump
 * unconditional; this test reproduces the reviewer's exact numbers end to end.
 */
describe('DEFECT regression: clearing a split must not suppress a budget alert', () => {
  it('fires once a cleared split raises Groceries from under-budget to 250%, with no manual fingerprint reset in between', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const restaurants = categoryIdByName(t.db, 'Restaurants');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 20000 }); // $200 budget

    // A $500 transaction filed under Groceries, split into $100 Groceries + $400 Restaurants.
    // categorySpend()/budgetProgress() are already split-aware (Task 3), so Groceries reads
    // only its own $100 part here: 50% of the $200 budget, under the 80% threshold -- nothing
    // should fire, and this call also seeds the fingerprint cache with the POST-split state.
    const txnId = spend(groceries, 50000);
    setTransactionSplits({
      txnId,
      parts: [
        { categoryId: groceries, amountCents: -10000 },
        { categoryId: restaurants, amountCents: -40000 },
      ],
      userId: creatorId,
    });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);

    // Clear the split: with no split rows left, Groceries reads the full $500 against the
    // same $200 budget -- 250%, past both the 80% threshold and the 100% exceeded line.
    // Checked WITHOUT a manual resetBudgetFingerprintForTests() call in between -- that is
    // the whole point. The transactions row was neither inserted nor deleted (same count,
    // same max id), so the ONLY way the evaluator can see this change is updated_at moving.
    setTransactionSplits({ txnId, parts: [], userId: creatorId });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());
  });
});

/**
 * v1.7.0 Task 11, deliverable (c): the budget evaluators must alert against the EFFECTIVE
 * limit (base + rollover carry), not the base alone -- otherwise a category comfortably
 * covered by a carried-forward leftover would false-alarm every month it carries.
 *
 * Verification performed BEFORE writing these tests: `grep -n "resolveBudget"
 * src/lib/notify/evaluate/budget.ts` -> no matches. `fireFor` (this file's source, above) reads
 * only `row.limitCents`, `row.pct` and `row.spentCents`, all three produced by
 * `budgetProgress()` -> `buildRow()` in src/lib/budgets.ts, whose own doc comment on BudgetRow
 * states `limitCents` is "the EFFECTIVE limit -- base + carried rollover" and that every
 * existing consumer -- evaluators included -- "reads this field and needs no further changes to
 * pick up rollover."
 *
 * CONCLUSION: current behaviour is already correct; no fix was needed in budget.ts. The two
 * tests below pin it: each sets up a category whose BASE alone would have crossed the line,
 * then shows a rollover carry that covers the difference keeps the evaluator silent.
 */
describe('v1.7.0 Task 11: rollover carry keeps a covered category from false-alarming', () => {
  it('budget_threshold does not fire when the carry keeps spend under the percentage', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    // July: a $1000 base against zero July spend on this category leaves the full $1000 as
    // carry entering August.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 100000 });
    // August: a $500 base. $420 spent is 84% of the $500 base alone -- past the 80% default
    // threshold -- but only 28% of the $1500 effective (base + carry) limit.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 100000,
      effectiveCents: 150000,
    });

    spend(groceries, 42000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('budget_exceeded does not fire when the carry covers the overspend', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 100000 });
    // August: a $500 base. $550 spent is 110% of the base alone -- a real overspend -- but the
    // $1000 carry covers it easily: 55000 / 150000 is 36.7%.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });
    expect(effectiveBudget('household', null, groceries, '2026-08').carryCents).toBe(100000);

    spend(groceries, 55000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});
