import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { clearBudget, effectiveBudget, setRollover, upsertBudget } from '@/lib/budgets';
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
 * DEFECT regression (adversarial review, 2026-08-22): fingerprint() hashed only
 * transactions(count, max id, max updated_at), budgets(count, max id) and participant
 * settings. Since rollover shipped, the limit evaluateBudgets alerts against is a function
 * of budget_rollover TOO (src/lib/budgets.ts effectiveBudget/buildRow), but the fingerprint
 * never read that table -- toggling rollover changed the alertable state without changing
 * the fingerprint, so the skip guard returned 0 without recomputing. A second, related gap:
 * budgets has no updated_at column, so an in-place UPDATE to an EXISTING month's row (a
 * changed amount, or a clear to NULL) moved neither count(*) nor max(id) either.
 *
 * Reproduction numbers are the reviewer's, verified end to end, with NO manual
 * resetBudgetFingerprintForTests() call between the "before" and "after" evaluateBudgets()
 * calls in any of these tests -- that absence is the entire point.
 */
describe('DEFECT regression: fingerprint must react to budget_rollover and in-place budget edits', () => {
  it("the reviewer's exact sequence: disabling rollover reveals an alert the very next evaluation", () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 150000 }); // $1500 July, no July spend
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 }); // $500 August base
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 150000,
      effectiveCents: 200000,
    });

    // $1200 is 60% of the $2000 effective limit -- under the 80% threshold. Silent, and this
    // seeds the fingerprint cache with the rollover-ON state.
    spend(groceries, 120000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);

    // The ONLY change: budget_rollover loses its one row. No transaction or budget row is
    // touched. The effective limit collapses to the $500 base, so the SAME $1200 is now
    // 240% -- past both the 80% threshold and the 100% exceeded line.
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: false, startMonth: '2026-07' });
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 0,
      effectiveCents: 50000,
    });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());
  });

  it('enabling rollover on an over-budget category moves the fingerprint on the very next evaluation', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // July's budget is planted up front but has ZERO effect until rollover is turned on --
    // rolloverStartMonth() reads null while rollover is off, so effectiveBudget() short-
    // circuits straight to the base regardless of what July's row says. This keeps the
    // later setRollover() call the ONLY budget_rollover/budgets/transactions change in the
    // whole test, so the isolation is real, not incidental.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 150000 }); // $1500 July, no July spend
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 }); // $500 August base
    spend(groceries, 75000); // $750 = 150% of the $500 base alone
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());

    // Enabling rollover raises the effective limit to $2000 ($500 base + $1500 carry) --
    // $750 is now only 37.5%, fully covered. Confirmed independently via effectiveBudget()
    // so this isn't the only evidence the underlying state changed.
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 150000,
      effectiveCents: 200000,
    });

    // NOTE on what this assertion can and cannot prove: rollover's carry is never negative
    // (ruling 4), so ENABLING it can only raise the effective limit, which can only suppress
    // or maintain an alert, never manufacture a new one -- and enqueue() is a dedup ratchet,
    // so a key that already fired can never "unfire" and be observed doing so. That makes a
    // correct recompute and a stale skip BOTH read as "0 fired, same two keys" here; this
    // assertion pins that enabling doesn't throw and doesn't duplicate. The DISCRIMINATING
    // half of this defect -- proving the fingerprint actually moved rather than coincidentally
    // producing the same answer -- is the disable-direction test above and the in-place-edit
    // /clear tests below, all of which move pct UPWARD into never-before-fired territory.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());
  });

  it("an in-place edit to an existing month's budget amount is picked up on the next evaluation", () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 100000 }); // $1000
    spend(groceries, 50000); // $500 = 50% -- under threshold
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);

    // Same (scope, user, category, month) row as above -- upsertBudget's UPDATE branch, not
    // an insert (src/lib/budgets.ts). count(*) and max(id) on budgets are UNCHANGED by this;
    // only sum(amount_cents) moves ($1000 -> $600).
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 }); // $600
    // $500 / $600 = 83.3%, newly over the 80% threshold, with no new transaction and no
    // manual resetBudgetFingerprintForTests() call.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`budget:h:${groceries}:2026-08:80`]);
  });

  it('clearing an existing budget (amount set to NULL) is picked up, proven by what re-setting it afterward fires', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 100000 }); // $1000
    spend(groceries, 90000); // $900 = 90% -- fires the threshold only (under the 100% exceeded line)
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`budget:h:${groceries}:2026-08:80`]);

    // Clear it: same row, amount_cents -> NULL (src/lib/budgets.ts clearBudget). limitCents
    // becomes null so nothing CAN fire for this category until a real limit exists again --
    // silent either way (same reasoning as the rollover-enable test above: clearing can only
    // ever remove an alert, never create one), so this step alone is not the discriminating
    // half of this test.
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08' });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);

    // Re-set it to a LOWER number, still the SAME row (amount_cents NULL -> $400). count(*)
    // and max(id) on budgets are unchanged across this entire test; only sum(amount_cents)
    // ever moves. $900 / $400 = 225%, crossing the 100% exceeded line for the first time --
    // the 80% threshold already fired above and stays deduped. THIS is the step that proves
    // the clear was actually picked up: if it had been missed, the fingerprint here would be
    // identical to the one before the clear (same count/max id throughout), and this would
    // wrongly stay silent instead of firing.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 40000 }); // $400
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(1);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());
  });

  it('still dedups correctly: two identical evaluations back to back return 0 the second time, even with rollover populated', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 150000 }); // $1500 July, no July spend
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 }); // $500 August base
    spend(groceries, 220000); // $2200 vs the $2000 effective limit -- fires both
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);

    // Nothing at all changes between these two calls: this is the regression that matters
    // most after widening the fingerprint -- it must not defeat the cache and start
    // re-alerting every tick.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(2);
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

/**
 * DEFECT regression (adversarial review, 2026-08-23): the transactions component of
 * fingerprint() was scoped to the CURRENT month only. Since rollover shipped,
 * effectiveBudget()'s carry walk (categorySpendWithRollupSeries in src/lib/budgets.ts) reads
 * up to 24 PRIOR months of transactions, so a category's CURRENT month effective limit can
 * change because of a transaction dated in a month the current-month window never touches.
 * That is the ROUTINE case for this app's main entry paths -- a CSV statement import (a
 * bank export always covers a past period) or a SimpleFIN lookback sync -- not a rare
 * coincidence. A month-scoped fingerprint misses it entirely and keeps alerting against a
 * stale limit until an unrelated current-month write happens to move the fingerprint. The
 * fix widens the transactions component to the whole table, matching the shape
 * budgets/budget_rollover already use below.
 *
 * Reproduction numbers are verified end to end, with NO manual resetBudgetFingerprintForTests()
 * call between the "before" and "after" evaluateBudgets() calls in any of these tests -- that
 * absence is the entire point.
 */
describe('DEFECT regression: fingerprint must react to a backdated prior-month transaction that moves a rollover carry', () => {
  it('fires once a backdated July transaction collapses a rollover carry, with no manual fingerprint reset in between', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 150000 }); // $1500 July, no July spend yet
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 }); // $500 August base
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 150000,
      effectiveCents: 200000,
    });

    // $1200 is 60% of the $2000 effective limit -- under the 80% threshold. Silent, and this
    // also seeds the fingerprint cache with the pre-backdate state.
    spend(groceries, 120000);
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);

    // A BACKDATED July transaction, dated a month before `now` -- the routine shape of a CSV
    // import or a SimpleFIN lookback sync, not current-month data entry. It fully consumes
    // July's $1500 budget, so July's carry into August collapses from $1500 to $0: the SAME
    // $1200 August spend is now 240% of the $500-only effective limit -- past both the 80%
    // threshold and the 100% exceeded line. Nothing dated inside August changed at all.
    spend(groceries, 150000, null, '2026-07-15');
    expect(effectiveBudget('household', null, groceries, '2026-08')).toEqual({
      baseCents: 50000,
      carryCents: 0,
      effectiveCents: 50000,
    });
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);
    expect(keys().sort()).toEqual([`budget:h:${groceries}:2026-08:100`, `budget:h:${groceries}:2026-08:80`].sort());
  });

  it('still dedups correctly: two identical evaluations back to back return 0 the second time, with a backdated transaction already reflected', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 150000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });
    spend(groceries, 150000, null, '2026-07-15'); // backdated -- collapses the carry to 0 up front
    spend(groceries, 120000); // 240% of the $500-only effective limit -- fires both
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(2);

    // Nothing at all changes between these two calls. This is the regression a whole-table
    // transactions aggregate could introduce: re-evaluating (and re-attempting to enqueue)
    // on every tick even when nothing moved, rather than short-circuiting on the guard.
    // enqueue() is itself idempotent (MUST-3.9), so even a wrongly-forced recompute would
    // still show 0 NEWLY inserted here -- keys() staying at length 2 alone doesn't prove the
    // guard fired. The discriminating assertion is evaluateBudgets() itself returning 0,
    // which only happens via the early `key === lastBudgetKey` return, never via the
    // recompute path finding nothing new to enqueue.
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(2);
  });

  it('a backdated prior-month transaction for a category with no rollover does not change its alert outcome', () => {
    emailUser();
    const gas = categoryIdByName(t.db, 'Gas');
    upsertBudget({ scope: 'household', userId: null, categoryId: gas, month: '2026-08', amountCents: 10000 }); // $100
    spend(gas, 5000); // $50 = 50% -- under threshold, silent
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);

    // A backdated JULY transaction on the same NO-ROLLOVER category. No budget_rollover row
    // exists for Gas, so effectiveBudget() short-circuits to the August base every time,
    // regardless of July's spend -- this insert cannot change Gas's August limit. It DOES
    // move the whole-table transactions aggregate (a new row: higher count, higher max id
    // and max updated_at), forcing a recompute with no manual fingerprint reset -- proving
    // the forced recompute alone does not manufacture an alert where the alertable state
    // hasn't actually changed.
    spend(gas, 900000, null, '2026-07-10');
    expect(evaluateBudgets({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});
