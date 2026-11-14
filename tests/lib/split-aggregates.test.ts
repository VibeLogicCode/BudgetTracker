import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { budgetProgress, budgetTotals, categorySpend, flattenBudgetRows } from '@/lib/budgets';
import type { Viewer } from '@/lib/auth/viewer';
import { listUsers } from '@/lib/auth/users';
import {
  cashflowTrend,
  categoryBreakdown,
  categoryMonthOverMonth,
  categoryYearOverYear,
  personSpendSplit,
  topMerchants,
  UNATTRIBUTED_LABEL,
} from '@/lib/reports';
import { categorySeries } from '@/lib/predict/history';
import { setTransactionSplits } from '@/lib/splits';
import { taxYearReport } from '@/lib/tax';
import { nowIso } from '@/lib/clock';
import { buildSplitPersonFixture, type SplitPersonFixture } from '../helpers/split-person-fixture';

// v1.13.0 ruling R2 (Task 6 fix round 1): every reports.ts aggregate below now takes a viewer as
// its last argument. A household viewer's ownerScope() is always null, so passing this constant
// reproduces the pre-v1.13.0 unscoped behaviour every test in this file already assumes.
const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

/**
 * Task 3 (spec 2026-08-22, v1.7.0): "the double-counting audit". Every category aggregate
 * that sums transactions.amount_cents grouped by transactions.category_id must instead sum
 * EFFECTIVE_AMOUNT grouped by EFFECTIVE_CATEGORY (src/lib/splits.ts) via a LEFT JOIN onto
 * transaction_splits, so a split transaction is counted once, at its parts -- never at the
 * parent's own lump category/amount, and never at BOTH (the parent's $100 plus its $70/$30
 * parts, which is the double-counting bug this task exists to prevent).
 *
 * Converted here: categorySpend (src/lib/budgets.ts, and budgetProgress/budgetTotals which
 * build on it); categoryBreakdown, cashflowTrend, categoryMonthOverMonth, personSpendSplit
 * (src/lib/reports.ts); the per-category-per-month cells() query inside
 * src/lib/predict/history.ts, exercised below through its public categorySeries() wrapper
 * (cells() itself is private).
 *
 * Deliberately NOT converted (spec's list, each independently confirmed by the audit below):
 *   - topMerchants (src/lib/reports.ts) -- merchant identity is a fact about the CARD CHARGE,
 *     not the category a person later divides it into. A split never changes who charged the
 *     card, so topMerchants is left summing transactions.amountCents grouped by
 *     normalizedMerchant, including its own untouched
 *     `.leftJoin(categories, eq(categories.id, transactions.categoryId))` income-exclusion join.
 *   - the anomaly evaluators (src/lib/notify/evaluate/anomalies.ts) -- both amountCents hits
 *     there are `abs(${transactions.amountCents})`, a CHARGE-level magnitude fed to a
 *     merchant's unusual/creep verdict, never a category-grouped sum. Splitting a transaction
 *     after the fact does not change how much the card was charged.
 *   - loan matching (src/lib/loans.ts) -- matches and applies payments by amount and merchant
 *     substring; it never groups by category and never appeared in either audit grep below.
 *   - dedup (src/lib/import/dedup.ts) -- hashes raw_description/date/amount at import time,
 *     before a split can even exist; it never appeared in either audit grep below either.
 *   - the list/search queries in src/lib/transactions.ts -- these render individual rows for
 *     display (a future task gives a split row a "Split - N parts" badge instead of rewriting
 *     the row source itself).
 *
 * MANDATORY AUDIT (run 2026-08-22 against both src/lib and src/app -- src/app is a
 * subdirectory of src/lib's common ancestor so a single `path: src` search below covers both):
 *
 *   rg "amountCents\}\)" src/lib src/app
 *
 *   Every hit: src/lib/budgets.ts (categorySpend, converted); src/lib/reports.ts x5
 *   (categoryBreakdown, cashflowTrend, categoryMonthOverMonth, personSpendSplit, converted;
 *   topMerchants, deliberately not); src/lib/predict/history.ts (cells(), converted);
 *   src/lib/notify/evaluate/anomalies.ts x2 (abs(), deliberately not -- see above);
 *   src/lib/splits.ts (the EFFECTIVE_AMOUNT fragment's own definition -- the source, not a
 *   consumer). Nothing in src/app matched at all: no page or server action does its own
 *   aggregation, confirming every UI surface reads these numbers through the lib layer.
 *
 *   rg "transactions\.categoryId" src/lib src/app
 *
 *   Every hit not already covered above was one of: src/lib/splits.ts (EFFECTIVE_CATEGORY's
 *   own definition, and setTransactionSplits reading the PARENT's own category_id to validate
 *   a new split -- a single-row lookup, not an aggregate); src/lib/categorize/engine.ts
 *   (Task 2b's scope, a different agent's concurrent file, not touched here -- REVIEW_WHERE/
 *   ELIGIBLE and per-row category reads, none of them a category-grouped sum);
 *   src/lib/import/commit.ts and src/lib/import/flow.ts (per-row category lookups during
 *   import/auto-categorization, not a spend aggregate); src/lib/transactions.ts (list/search,
 *   deliberately not converted, see above). Nothing else.
 *
 * Notify-evaluator independence, verified by:
 *
 *   rg "from '@/lib/(budgets|reports|predict)" src/lib/notify
 *
 *   Every evaluator that touches category money -- budget.ts, digest.ts, monthly.ts, pace.ts
 *   -- imports budgetProgress / categoryBreakdown / topMerchants / suggestionsFor and nothing
 *   else; none of them has a `sum(...)` of its own. A second grep,
 *   `rg "sql\`sum\(|\bsum\(transactions|drizzle-orm.*\bsum\b" src`, returned NO matches beyond
 *   the sites already listed above (i.e. every `sum(...)` in src/lib is one of the
 *   `amountCents})` hits already audited) -- there is no second aggregate pattern (a raw JS
 *   reduce, or drizzle's own sum() helper) hiding an un-audited category total anywhere.
 *
 * No aggregate outside the spec's named list was found; nothing was missed.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });

  const add = (over: {
    date: string;
    amountCents: number;
    categoryId: number | null;
    attributedUserId?: number | null;
  }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'GENERIC MERCHANT', 'GENERIC MERCHANT', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };

  return { db: current.db, alice, joint, add };
}

const MONTH = '2026-03';
const MARCH_RANGE = { from: '2026-03-01', to: '2026-03-31' };

/**
 * The spec's core fixture: one $100 transaction split $70 groceries + $30 gas (the spec's own
 * example names the second part "household"; the seeded category tree has no category by that
 * name, so Gas -- a distinct top-level parent, Transport, from Groceries' parent, Food -- is
 * used instead, which additionally proves a rollup consumer sends each part to its OWN correct
 * parent rather than one shared parent), plus one UNSPLIT $40 control transaction under Kids
 * (a top-level category with no children of its own).
 *
 * The parent is filed under Groceries before the split (splits.ts ruling 1/2: a split never
 * touches the parent's own category_id), so a consumer that has not been converted yet still
 * sees a single $100 row at Groceries -- which is exactly what makes every assertion below
 * fail red before Task 3's conversion and pass green after it.
 */
function coreFixture() {
  const { db, alice, add } = setup();
  const groceries = categoryIdByName(db, 'Groceries');
  const gas = categoryIdByName(db, 'Gas');
  const food = categoryIdByName(db, 'Food');
  const transport = categoryIdByName(db, 'Transport');
  const kids = categoryIdByName(db, 'Kids');

  const splitParentId = add({ date: '2026-03-10', amountCents: -10000, categoryId: groceries, attributedUserId: alice });
  setTransactionSplits({
    txnId: splitParentId,
    parts: [
      { categoryId: groceries, amountCents: -7000 },
      { categoryId: gas, amountCents: -3000 },
    ],
    userId: alice,
  });

  // Unsplit control: every function below must report exactly $40 here, unchanged, proving
  // the split-aware join changes nothing for a transaction that was never split.
  add({ date: '2026-03-12', amountCents: -4000, categoryId: kids, attributedUserId: null });

  return { db, alice, groceries, gas, food, transport, kids, splitParentId };
}

/**
 * The correct grand total once the control and both split parts are counted exactly once:
 * $40 (control) + $70 + $30 (the split, correctly divided) = $140. The bug this task exists
 * to prevent would produce $240 -- the control's $40, plus the split PARENT's own undivided
 * $100 leaking through the join alongside its two $70/$30 parts counted AGAIN.
 */
const CORRECT_TOTAL_CENTS = 4000 + 7000 + 3000;

describe('categorySpend (src/lib/budgets.ts) is split-aware', () => {
  it('counts the $100 split once, at $70 groceries and $30 gas -- never $100, never $100+$70+$30', () => {
    const { groceries, gas, kids } = coreFixture();
    const spend = categorySpend(MONTH);

    expect(spend.get(groceries)).toBe(7000);
    expect(spend.get(gas)).toBe(3000);
    expect(spend.get(kids)).toBe(4000); // unsplit control, unchanged

    const total = [...spend.values()].reduce((sum, cents) => sum + cents, 0);
    expect(total).toBe(CORRECT_TOTAL_CENTS);
  });
});

describe('budgetProgress (src/lib/budgets.ts) rolls each split part into its OWN parent', () => {
  it('places $70 under Food (via Groceries) and $30 under Transport (via Gas)', () => {
    const { food, transport, groceries, gas, kids } = coreFixture();
    const rows = budgetProgress(MONTH);

    const foodRow = rows.find((r) => r.categoryId === food)!;
    const transportRow = rows.find((r) => r.categoryId === transport)!;
    const kidsRow = rows.find((r) => r.categoryId === kids)!;

    expect(foodRow.spentCents).toBe(7000);
    expect(foodRow.children.find((c) => c.categoryId === groceries)?.spentCents).toBe(7000);
    expect(transportRow.spentCents).toBe(3000);
    expect(transportRow.children.find((c) => c.categoryId === gas)?.spentCents).toBe(3000);
    expect(kidsRow.spentCents).toBe(4000); // unsplit control, unchanged

    // Explicit total, per the task: must never be $240 (control + parent's undivided $100 +
    // both parts counted again).
    expect(budgetTotals(rows).totalSpentCents).toBe(CORRECT_TOTAL_CENTS);
  });
});

describe('categoryBreakdown (src/lib/reports.ts) is split-aware', () => {
  it('flat: lists the two split categories separately, never a $100 row at Groceries', () => {
    const { groceries, gas, kids } = coreFixture();
    const rows = categoryBreakdown(MARCH_RANGE, HOUSEHOLD);

    expect(rows.find((r) => r.categoryId === groceries)?.spentCents).toBe(7000);
    expect(rows.find((r) => r.categoryId === gas)?.spentCents).toBe(3000);
    expect(rows.find((r) => r.categoryId === kids)?.spentCents).toBe(4000);
    expect(rows.reduce((sum, r) => sum + r.spentCents, 0)).toBe(CORRECT_TOTAL_CENTS);
  });

  it('rollup: rolls each part into its OWN parent, not one shared parent and not doubled', () => {
    const { food, transport, kids } = coreFixture();
    const rolled = categoryBreakdown({ ...MARCH_RANGE, rollup: true }, HOUSEHOLD);

    expect(rolled.find((r) => r.categoryId === food)?.spentCents).toBe(7000);
    expect(rolled.find((r) => r.categoryId === transport)?.spentCents).toBe(3000);
    expect(rolled.find((r) => r.categoryId === kids)?.spentCents).toBe(4000);
    expect(rolled.reduce((sum, r) => sum + r.spentCents, 0)).toBe(CORRECT_TOTAL_CENTS);
  });
});

describe('categoryMonthOverMonth (src/lib/reports.ts) is split-aware', () => {
  it('gives each split part its own monthly row -- never a $100 row at Groceries', () => {
    const { groceries, gas, kids } = coreFixture();
    const result = categoryMonthOverMonth({ fromMonth: MONTH, toMonth: MONTH }, HOUSEHOLD);

    expect(result.rows.find((r) => r.categoryId === groceries)?.byMonth[MONTH]).toBe(7000);
    expect(result.rows.find((r) => r.categoryId === gas)?.byMonth[MONTH]).toBe(3000);
    expect(result.rows.find((r) => r.categoryId === kids)?.byMonth[MONTH]).toBe(4000);
    expect(result.rows.some((r) => r.byMonth[MONTH] === 10000)).toBe(false);

    const total = result.rows.reduce((sum, r) => sum + r.byMonth[MONTH], 0);
    expect(total).toBe(CORRECT_TOTAL_CENTS);
  });
});

describe("personSpendSplit (src/lib/reports.ts) attributes BOTH parts to the parent's person", () => {
  it("reads each PART's own category for the income filter, not the parent's stale one", () => {
    // Deliberately files the PARENT itself under an INCOME category (Salary) while both split
    // parts are real non-income spend (Groceries + Gas). A reader that still consulted the
    // parent's own transactions.category_id for the income-exclusion filter would drop this
    // transaction ENTIRELY (Alice = $0, wrongly), rather than correctly reading each part's
    // OWN category (both non-income, so both of Alice's $70 + $30 count) -- this is what makes
    // this fixture fail red before the conversion and pass green after it, in a way the
    // "same classification either way" fixture used by the other tests above cannot.
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const salary = categoryIdByName(db, 'Salary');
    const kids = categoryIdByName(db, 'Kids');

    const id = add({ date: '2026-03-10', amountCents: -10000, categoryId: salary, attributedUserId: alice });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: gas, amountCents: -3000 },
      ],
      userId: alice,
    });
    add({ date: '2026-03-12', amountCents: -4000, categoryId: kids, attributedUserId: null });

    const rows = personSpendSplit(MARCH_RANGE, HOUSEHOLD);
    const aliceRow = rows.find((r) => r.userId === alice)!;
    const unattributed = rows.find((r) => r.userId === null)!;

    // Both parts land on Alice (attribution is read from the PARENT row -- splits carry no
    // owner of their own, design ruling 1) -- exactly $100 because BOTH non-income parts
    // belong to her, which is different from double counting: that bug would show $200 (the
    // parent's own $100, wrongly included via a stale category read, PLUS both parts again).
    expect(aliceRow.spentCents).toBe(10000);
    expect(unattributed.spentCents).toBe(4000); // unsplit control, unchanged
  });
});

describe('cashflowTrend (src/lib/reports.ts) moves an income-classified split part into income', () => {
  it('an income part is counted as income, a non-income part as spend, never the $100 lumped one way', () => {
    const { db, alice, add } = setup();
    const salary = categoryIdByName(db, 'Salary'); // isIncome = true
    const groceries = categoryIdByName(db, 'Groceries'); // isIncome = false

    // A $100 DEPOSIT (positive, so every part must also be positive -- setTransactionSplits
    // requires each part's sign to match the parent's) split $70 Salary + $30 Groceries. The
    // parent itself is filed under Salary, so an unconverted reader counts the whole $100 as
    // income; a converted one must see $70 income and $30 spend.
    const id = add({ date: '2026-03-15', amountCents: 10000, categoryId: salary, attributedUserId: alice });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: salary, amountCents: 7000 },
        { categoryId: groceries, amountCents: 3000 },
      ],
      userId: alice,
    });

    const [march] = cashflowTrend(1, { endMonth: MONTH }, HOUSEHOLD);
    expect(march.incomeCents).toBe(7000); // only the Salary part -- never the full $100, never $0
    // netSpentCents(3000): a positive, non-income amount nets to a negative "spend" (a
    // credit), the same convention an ordinary refund-only month already uses elsewhere.
    expect(march.spendCents).toBe(-3000);
  });
});

describe('predict history (src/lib/predict/history.ts) is split-aware', () => {
  it('categorySeries sees $70 at groceries and $30 at gas for the month, never $100 at groceries', () => {
    const { food, transport, groceries, gas, kids } = coreFixture();
    const series = categorySeries({ months: [MONTH], scope: 'household', userId: null });
    const pick = (categoryId: number) => series.find((row) => row.categoryId === categoryId);

    expect(pick(groceries)?.monthlyCents).toEqual([7000]);
    expect(pick(gas)?.monthlyCents).toEqual([3000]);
    expect(pick(kids)?.monthlyCents).toEqual([4000]); // unsplit control, unchanged
    // Rollup mirrors budgetProgress (MUST-3.2): each parent reflects only its own part.
    expect(pick(food)?.monthlyCents).toEqual([7000]);
    expect(pick(transport)?.monthlyCents).toEqual([3000]);
  });
});

/**
 * v1.63.0 (plan 2026-11-12, Lane A, A3). The split-joined aggregates read each part's own person
 * (EFFECTIVE_PERSON, src/lib/splits.ts), so a person's line holds exactly their parts and the
 * people's lines still add up to the household's.
 */
describe('v1.63.0: every split-joined aggregate counts a part for its own person', () => {
  const MARCH = { from: '2026-03-01', to: '2026-03-31' };
  const byCategory = (rows: { categoryId: number | null; spentCents: number }[]) =>
    Object.fromEntries(rows.filter((row) => row.spentCents !== 0).map((row) => [String(row.categoryId), row.spentCents]));
  const people = (fx: SplitPersonFixture) => personSpendSplit(MARCH, fx.admin).map((row) => [row.label, row.spentCents]);
  const spendOf = (fx: SplitPersonFixture, person: number | 'unattributed') =>
    cashflowTrend(1, { endMonth: MONTH, attributedUserId: person }, fx.admin)[0].spendCents;

  /** Every household figure this file covers, for one fixture, in a comparable shape. */
  function householdFigures(fx: SplitPersonFixture) {
    const flag = fx.t.sqlite.prepare('update categories set tax_relevant = 1 where id = ?');
    flag.run(fx.dining);
    flag.run(fx.groceries);
    return {
      breakdown: categoryBreakdown(MARCH, fx.admin),
      rolled: categoryBreakdown({ ...MARCH, rollup: true }, fx.admin),
      cashflow: cashflowTrend(1, { endMonth: MONTH }, fx.admin),
      monthOverMonth: categoryMonthOverMonth({ fromMonth: MONTH, toMonth: MONTH }, fx.admin),
      yearOverYear: categoryYearOverYear({ month: MONTH }, fx.admin),
      merchants: topMerchants(MARCH, fx.admin),
      spend: [...categorySpend(MONTH, { scope: 'household' })].sort(([a], [b]) => a - b),
      progress: flattenBudgetRows(budgetProgress(MONTH, 'household', null)).map((row) => [row.categoryId, row.spentCents]),
      series: categorySeries({ months: [MONTH], scope: 'household', userId: null }).map((row) => [row.categoryId, row.monthlyCents]),
      tax: taxYearReport(2026).map((row) => [row.categoryName, row.totalCents]),
      peopleTotal: personSpendSplit(MARCH, fx.admin).reduce((sum, row) => sum + row.spentCents, 0),
    };
  }

  it('with every part following, every person figure is exactly what v1.62.0 gave', () => {
    const fx = buildSplitPersonFixture({ allFollow: true });
    current = fx.t;
    expect(people(fx)).toEqual([
      ['Alex', 15000],
      ['Sam', 6130],
      [UNATTRIBUTED_LABEL, 0],
    ]);
    expect(byCategory(categoryBreakdown({ ...MARCH, attributedUserId: fx.alex }, fx.admin))).toEqual({
      [fx.groceries]: 8000,
      [fx.dining]: 4000,
      [fx.supplies]: 3000,
    });
    expect(byCategory(categoryBreakdown({ ...MARCH, attributedUserId: fx.sam }, fx.admin))).toEqual({ [fx.transport]: 6130 });
    expect(spendOf(fx, fx.alex)).toBe(15000);
    expect(spendOf(fx, 'unattributed')).toBe(0);
    expect([...categorySpend(MONTH, { scope: 'personal', attributedUserId: fx.sam })]).toEqual([[fx.transport, 6130]]);
    const alexSeries = categorySeries({ months: [MONTH], scope: 'personal', userId: fx.alex });
    expect(alexSeries.find((row) => row.categoryId === fx.dining)?.monthlyCents).toEqual([4000]);
    expect(topMerchants({ ...MARCH, attributedUserId: fx.alex }, fx.admin).map((row) => [row.normalizedMerchant, row.spentCents])).toEqual([
      ['MAPLE GROCER', 15000],
    ]);
  });

  it('a part set to Sam counts for Sam, a part set to Household for nobody, the rest for Alex', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    expect(people(fx)).toEqual([
      ['Sam', 10130],
      ['Alex', 8000],
      [UNATTRIBUTED_LABEL, 3000],
    ]);
    expect(byCategory(categoryBreakdown({ ...MARCH, attributedUserId: fx.sam }, fx.admin))).toEqual({
      [fx.dining]: 4000,
      [fx.transport]: 6130,
    });
    expect(byCategory(categoryBreakdown({ ...MARCH, attributedUserId: 'unattributed' }, fx.admin))).toEqual({ [fx.supplies]: 3000 });
    expect(spendOf(fx, fx.alex)).toBe(8000);
    expect(spendOf(fx, 'unattributed')).toBe(3000);
    expect(new Map(categorySpend(MONTH, { scope: 'personal', attributedUserId: fx.sam }))).toEqual(
      new Map([
        [fx.dining, 4000],
        [fx.transport, 6130],
      ]),
    );
    const samProgress = flattenBudgetRows(budgetProgress(MONTH, 'personal', fx.sam));
    expect(samProgress.find((row) => row.categoryId === fx.dining)?.spentCents).toBe(4000);
    expect(samProgress.find((row) => row.categoryId === fx.groceries)?.spentCents).toBe(0);
    const samSeries = categorySeries({ months: [MONTH], scope: 'personal', userId: fx.sam });
    expect(samSeries.find((row) => row.categoryId === fx.dining)?.monthlyCents).toEqual([4000]);
    expect(samSeries.find((row) => row.categoryId === fx.groceries)?.monthlyCents).toEqual([0]);
    const samTrend = categoryMonthOverMonth({ fromMonth: MONTH, toMonth: MONTH, attributedUserId: fx.sam }, fx.admin);
    expect(samTrend.rows.map((row) => [row.categoryId, row.totalCents])).toEqual([
      [fx.transport, 6130],
      [fx.dining, 4000],
    ]);
    expect(categoryYearOverYear({ month: MONTH, attributedUserId: fx.sam }, fx.admin).map((row) => [row.categoryId, row.thisMonthCents])).toEqual([
      [fx.transport, 6130],
      [fx.dining, 4000],
    ]);
    // A merchant still groups by the charge; Sam's line there is his part of it.
    expect(topMerchants({ ...MARCH, attributedUserId: fx.sam }, fx.admin).map((row) => [row.normalizedMerchant, row.spentCents, row.count])).toEqual([
      ['FUEL STOP 12', 6130, 1],
      ['MAPLE GROCER', 4000, 1],
    ]);
  });

  it('the people add up to the household: personSpendSplit and the household digest lines', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const household = categoryBreakdown(MARCH, fx.admin).reduce((sum, row) => sum + row.spentCents, 0);
    expect(household).toBe(21130);
    expect(personSpendSplit(MARCH, fx.admin).reduce((sum, row) => sum + row.spentCents, 0)).toBe(household);
    // buildHouseholdDigest (src/lib/notify/evaluate/digest.ts) composes its lines from exactly these
    // calls: one categoryBreakdown per user, one for the unattributed pile, one for the household.
    const lines = listUsers().map((user) => categoryBreakdown({ ...MARCH, attributedUserId: user.id }, fx.admin));
    lines.push(categoryBreakdown({ ...MARCH, attributedUserId: 'unattributed' }, fx.admin));
    expect(lines.flat().reduce((sum, row) => sum + row.spentCents, 0)).toBe(household);
  });

  it('setting a part to someone else leaves every household figure exactly as it was', () => {
    const fx = buildSplitPersonFixture({ allFollow: true });
    current = fx.t;
    const before = householdFigures(fx);
    setTransactionSplits({
      txnId: fx.maple,
      parts: [
        { categoryId: fx.groceries, amountCents: -8000, person: 'follow' },
        { categoryId: fx.dining, amountCents: -4000, person: fx.sam },
        { categoryId: fx.supplies, amountCents: -3000, person: 'household' },
      ],
      userId: fx.alex,
    });
    // The person lines did move, so this is not comparing two identical databases.
    expect(people(fx)).toEqual([
      ['Sam', 10130],
      ['Alex', 8000],
      [UNATTRIBUTED_LABEL, 3000],
    ]);
    expect(householdFigures(fx)).toEqual(before);
  });
});
