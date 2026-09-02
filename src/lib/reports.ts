import { and, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories, loanPayments, transactions, transactionSplits, users, warrantyItems } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { listRules, matchRule } from '@/lib/categorize/rules';
import { addMonths, monthEnd, monthOf, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents } from '@/lib/money';
import { savingsRate, type SavingsRate } from '@/lib/savings-rate';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY, splitsForTransactions } from '@/lib/splits';
import { listTransactions, type TransactionFilter } from '@/lib/transactions';

export interface DateRange {
  from: string;
  to: string;
}

export const UNATTRIBUTED_LABEL = 'Household/unattributed';

type PersonScope = number | 'unattributed' | null | undefined;

function personClause(scope: PersonScope): SQL | null {
  if (scope === undefined || scope === null) return null;
  if (scope === 'unattributed') return isNull(transactions.attributedUserId);
  return eq(transactions.attributedUserId, scope);
}

/**
 * v1.13.0 ruling R2: a self viewer's person scope is THEIR OWN id, whatever the URL asked for.
 *
 * This is the one place in reports.ts that knows about visibility. Every exported aggregate below
 * runs its requested scope through it before building a clause, so a page cannot forget -- and
 * `viewer` is a required parameter on all seven, so a NEW aggregate cannot forget either: it will
 * not compile until its author decides what scope it is reading.
 */
function scopeFor(requested: PersonScope, viewer: Viewer): PersonScope {
  const own = ownerScope(viewer);
  return own === null ? requested : own;
}

/**
 * v1.21.0 (2026-08-30 plan, item 8a; revised same day after coordinator review -- see below). A
 * transaction linked to a loan moves loan PRINCIPAL, and principal is not always spend or income
 * -- restating the plan's classification table:
 *
 *   money out, 'lent' loan  -- lending money out      -- NOT spend  (cash becomes a receivable)
 *   money in,  'lent' loan  -- being repaid            -- NOT income (a receivable becomes cash)
 *   money in,  'owed' loan  -- borrowing                -- NOT income
 *   money out, 'owed' loan  -- repaying what we owe    -- SPEND, deliberately (MUST-13.2)
 *
 * Only the last row is real consumption -- a car payment is money the household will never see
 * again, exactly like any other bill, which is what MUST-13.2 exists to protect. The other three
 * convert one asset into another (cash into a receivable, or back) without changing how much was
 * earned or spent; counting any of them as spend or income double-books the same dollar as both
 * "money moved" and "money consumed/earned".
 *
 * CORRELATED, not materialized. The first version of this fix computed a JS-side Set<number> of
 * excluded ids via one unfiltered three-table scan of the WHOLE loan_payments/warranty_items
 * history, then ran it again at every one of rangeClauses' 7 call sites, and fed the result into
 * `notInArray(transactions.id, [...ids])`. Both halves were wrong at scale: MUST-16.3 budgets a
 * page's grouped aggregates deliberately, and an unfiltered scan repeated 7 times has no such
 * budget; and notInArray splats one bind parameter per excluded id, which runs into SQLite's
 * SQLITE_MAX_VARIABLE_NUMBER ceiling on a household with years of loan payments -- discoverable
 * only on the largest, oldest databases, the worst possible time. This version instead lets
 * SQLite decide inclusion per ROW via `loan_payments_txn_idx`, the same `not exists (select 1
 * from ... where ...)` idiom REVIEW_WHERE (src/lib/categorize/engine.ts) already uses for the
 * identical reason -- nothing is materialized into JS, and no bind parameter count scales with
 * history.
 *
 * Whole-transaction, not split-aware: `loan_payments.txn_id` names a whole transaction -- the
 * same row `transactions.amount_cents` belongs to -- and there is no split-part counterpart to
 * join against here the way EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) give the
 * rest of this file for category totals.
 *
 * Every row this reads is a LOAN's own direction, never a bill's absence of one:
 * `applyPaymentMatchers` (src/lib/loans.ts) routes a bill-kind match to `bill_installments`
 * instead of `loan_payments`, and `assignTransactionToLoan`'s `itemId` is always a loan by
 * construction of the loan picker that calls it. `loan_payments` rows are loan-kind, full stop.
 *
 * MUST-11.16 tie-break -- worth deriving carefully, because the obvious single NOT EXISTS gets
 * it backwards. One transaction may legitimately fund two loans, and MUST-13.2 requires that it
 * stays counted as spend the moment ANY linked loan makes it an owed-loan repayment (money out,
 * 'owed'), regardless of what a second link on the same row says. A single
 * `not exists (select ... where txn_id = transactions.id and not (owed-repayment))` would instead
 * implement the WRONG quantifier: "keep only if EVERY link is an owed-repayment", i.e. it would
 * EXCLUDE a transaction the instant any one of its links is not a repayment -- exactly the
 * failure MUST-13.2 forbids, applied to a row that also, coincidentally, repays a real debt. The
 * correct rule is existential, not universal: keep this row if it has NO loan link at all, OR at
 * least ONE of its links is an owed-repayment. That is the OR of two independent correlated
 * subqueries below, not a single inverted NOT EXISTS. tests/lib/reports.test.ts's own
 * MUST-11.16 case pins this: a transaction linked to both an owed loan (a repayment) and a lent
 * loan (growth, not a repayment) must still count as spend in full.
 */
const NOT_PRINCIPAL_MOVEMENT: SQL = sql`(
  not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})
  or exists (
    select 1 from ${loanPayments}
    inner join ${warrantyItems} on ${warrantyItems.id} = ${loanPayments.itemId}
    where ${loanPayments.txnId} = ${transactions.id}
      and ${transactions.amountCents} < 0
      and ${warrantyItems.loanDirection} = ${'owed'}
  )
)`;

function rangeClauses(range: DateRange, scope: PersonScope): SQL[] {
  const clauses: SQL[] = [
    gte(transactions.date, range.from),
    lte(transactions.date, range.to),
    // Transfers are excluded from every report series.
    eq(transactions.isTransfer, false),
    // Item 8a: a loan-principal movement is excluded from every report series too -- see
    // NOT_PRINCIPAL_MOVEMENT's own docblock for exactly which of the four loan movements that
    // is, and which one (repaying a debt we owe) it deliberately leaves alone.
    NOT_PRINCIPAL_MOVEMENT,
  ];
  const person = personClause(scope);
  if (person) clauses.push(person);
  return clauses;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  categoryName: string;
  parentId: number | null;
  isIncome: boolean;
  spentCents: number;
}

export function categoryBreakdown(
  input: DateRange & { attributedUserId?: PersonScope; rollup?: boolean; includeIncome?: boolean },
  viewer: Viewer,
): CategoryBreakdownRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  // Split-aware (spec 2026-08-22, v1.7.0, Task 3): a split transaction is counted once, at
  // its parts' own categories/amounts (EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT, src/lib/splits.ts)
  // via the LEFT JOIN below, never at its own lump category/amount and never at both.
  const rows = getDb()
    .select({ categoryId: EFFECTIVE_CATEGORY, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...rangeClauses(input, scope)))
    .groupBy(EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const spendByCategory = new Map<number | null, number>();
  for (const row of rows) spendByCategory.set(row.categoryId, netSpentCents(row.total ?? 0));

  const result: CategoryBreakdownRow[] = [];
  const emit = (categoryId: number | null, spentCents: number, nameOverride?: string) => {
    const category = categoryId === null ? null : byId.get(categoryId);
    const isIncome = category?.isIncome ?? false;
    if (!input.includeIncome && isIncome) return;
    result.push({
      categoryId,
      categoryName: nameOverride ?? category?.name ?? 'Uncategorized',
      parentId: category?.parentId ?? null,
      isIncome,
      spentCents,
    });
  };

  if (input.rollup) {
    const rolled = new Map<number | null, number>();
    for (const [categoryId, spent] of spendByCategory) {
      if (categoryId === null) {
        rolled.set(null, (rolled.get(null) ?? 0) + spent);
        continue;
      }
      const category = byId.get(categoryId);
      const target = category?.parentId ?? categoryId;
      rolled.set(target, (rolled.get(target) ?? 0) + spent);
    }
    // Rolled-up reports are already correct here (v1.21.0 plan, item 2): a rolled bucket for an
    // actual parent already IS "parent plus every child", so its own name is exactly right and
    // gets no override.
    for (const [categoryId, spent] of rolled) emit(categoryId, spent);
  } else {
    // v1.21.0 plan, item 2: with rollup off, a bucket keyed by a PARENT category id (money spent
    // directly on Health, say, never on Pharmacy/Dental/Fitness) is only that direct slice, not
    // the parent's total -- but emitting it under the parent's own plain name reads exactly like
    // the total, the same lie item 2 already fixed on the Budgets breakdown (BudgetCategoryCard's
    // "Not in a sub-category" row, budgets-client.tsx). One vocabulary fixes both surfaces: this
    // uses the SAME label, verbatim, only for a parent category that ALSO carries at least one
    // child -- `parentIds` below is exactly "category ids that are somebody's parentId". A
    // top-level category with no children (e.g. a household's own 'Kids' bucket) has nothing to
    // disambiguate it from, so it keeps its plain name.
    //
    // The label is QUALIFIED with the category's own name here, unlike the Budgets card's bare
    // "Not in a sub-category". That is not drift: on Budgets the row is rendered nested INSIDE the
    // parent's own breakdown, so the enclosing card already says which category it belongs to.
    // This function's rows land in FLAT lists with no such enclosure -- the weekly digest
    // (src/lib/notify/evaluate/digest.ts) is its only non-rollup consumer today -- where a bare
    // "Not in a sub-category" line would name no category at all and be strictly less informative
    // than the plain name it replaced. Same vocabulary, carried into a context that has to say
    // what it is about.
    const parentIds = new Set(all.filter((category) => category.parentId !== null).map((category) => category.parentId as number));
    for (const [categoryId, spent] of spendByCategory) {
      const isDirectParentSpend = categoryId !== null && parentIds.has(categoryId);
      const name = categoryId === null ? null : byId.get(categoryId)?.name;
      emit(categoryId, spent, isDirectParentSpend && name ? `${name} — not in a sub-category` : undefined);
    }
  }

  return result.sort((a, b) => b.spentCents - a.spentCents);
}

export interface MonthTrendRow {
  month: string;
  incomeCents: number;
  spendCents: number;
  netCents: number;
}

export function cashflowTrend(
  months: number,
  opts: { endMonth?: string; attributedUserId?: PersonScope } = {},
  viewer: Viewer,
): MonthTrendRow[] {
  const scope = scopeFor(opts.attributedUserId, viewer);
  const endMonth = opts.endMonth ?? monthOf(new Date().toISOString().slice(0, 10));
  const startMonth = addMonths(endMonth, -(months - 1));
  const keys = monthRange(startMonth, endMonth);

  // Split-aware (Task 3): each split part is classified as income/spend by ITS OWN category
  // (the categories join below keys off EFFECTIVE_CATEGORY, not the parent's own
  // transactions.category_id), so a part filed under an income category moves into the
  // income series even when the parent transaction itself was not.
  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      isIncome: categories.isIncome,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses({ from: monthStart(startMonth), to: monthEnd(endMonth) }, scope)))
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, categories.isIncome)
    .all();

  const income = new Map<string, number>();
  const spend = new Map<string, number>();
  for (const row of rows) {
    // Income counts ONLY is_income categories; everything else (including
    // uncategorized rows) is spend, netted.
    if (row.isIncome) income.set(row.month, (income.get(row.month) ?? 0) + (row.total ?? 0));
    else spend.set(row.month, (spend.get(row.month) ?? 0) + (row.total ?? 0));
  }

  return keys.map((month) => {
    const incomeCents = income.get(month) ?? 0;
    const spendCents = netSpentCents(spend.get(month) ?? 0);
    return { month, incomeCents, spendCents, netCents: incomeCents - spendCents };
  });
}

/**
 * v1.21.0 plan, item 5, defect 1. `cashflowTrend` seeds every month key in its requested range
 * with 0 by contract (above) -- it has no way to tell "the household earned $0 and spent $0 this
 * month" apart from "this month is before the household's first transaction", so it does not try;
 * that is this function's job instead. Ten such months, on a household a few weeks old, used to
 * squeeze one real month of data into the last few percent of a 12-wide chart.
 *
 * Trims only the LEADING run of zero-both months, never an interior or trailing one: once real
 * history has started, a later genuinely-quiet month is indistinguishable from "no data" by this
 * same test, and only the former is the defect being fixed here -- a real zero month stays on the
 * chart. Every dropped row would have plotted a flat, informationless baseline bar anyway (income
 * 0, spend 0, so net 0 too), so the cumulative-saved running total SavingsChart derives from
 * whatever survives this trim is unaffected: a dropped row could only ever have contributed 0 to
 * it. That same asymmetry is what makes the trim safe for an AVERAGE and not only for a chart: an
 * interior quiet month is a month the household genuinely lived through and spent nothing in, so
 * it belongs in the divisor, while a leading one is a month that never happened for this
 * household at all.
 *
 * Lives here rather than in src/app/(app)/dashboard/page.tsx, where it was first written: a
 * second consumer now needs the identical judgement about which leading months are real -- the
 * runway average (src/lib/runway.ts) divides by exactly the months this trim keeps, and a
 * six-month divisor over three months of history halves the average and doubles the runway. Two
 * copies of this rule is how the chart and the runway would eventually disagree about when a
 * household's history starts, which is the defect, not the fix.
 *
 * The move changes nothing about `cashflowTrend` itself: its zero-fill contract (one row per
 * requested month, always) is untouched and still correct for the callers that want exactly
 * that -- Reports' own cash flow card follows a date range the person picking it chose on
 * purpose, and every month in it is a month they asked to see. This remains a separate, opt-in
 * helper applied BY the callers whose window is a fixed trailing-N-months-ending-today, the one
 * shape where a household's youth produces a wall of leading zeros nobody asked for. It is
 * deliberately not new behaviour inside `cashflowTrend`.
 */
export function trimLeadingEmptyMonths(rows: MonthTrendRow[]): MonthTrendRow[] {
  const firstReal = rows.findIndex((row) => row.incomeCents !== 0 || row.spendCents !== 0);
  return firstReal === -1 ? [] : rows.slice(firstReal);
}

// Re-exported so every existing importer of savingsRate/SavingsRate from '@/lib/reports' keeps
// working unchanged -- the actual implementation lives in @/lib/savings-rate (client-bundle fix,
// 2026-08-23): a 'use client' component (reports-client.tsx) needs this function, and importing
// it from THIS file would still drag @/db/client's better-sqlite3/node:fs graph into the browser
// bundle even though the function itself never touches the database. See that module's docblock.
export { savingsRate, type SavingsRate };

export interface CategoryMonthTrend {
  categoryId: number;
  categoryName: string;
  byMonth: Record<string, number>;
  totalCents: number;
}

export function categoryMonthOverMonth(
  input: {
    fromMonth: string;
    toMonth: string;
    attributedUserId?: PersonScope;
    limit?: number;
  },
  viewer: Viewer,
): { months: string[]; rows: CategoryMonthTrend[] } {
  const scope = scopeFor(input.attributedUserId, viewer);
  const months = monthRange(input.fromMonth, input.toMonth);
  // Split-aware (Task 3): grouped by EFFECTIVE_CATEGORY so each split part gets its own
  // monthly row, and the income-exclusion join below keys off EFFECTIVE_CATEGORY too, so a
  // part's own category decides inclusion rather than the parent's.
  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: EFFECTIVE_CATEGORY,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(
      and(
        ...rangeClauses({ from: monthStart(input.fromMonth), to: monthEnd(input.toMonth) }, scope),
        eq(categories.isIncome, false),
      ),
    )
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const trends = new Map<number, CategoryMonthTrend>();

  for (const row of rows) {
    if (row.categoryId === null) continue;
    let trend = trends.get(row.categoryId);
    if (!trend) {
      trend = {
        categoryId: row.categoryId,
        categoryName: byId.get(row.categoryId)?.name ?? 'Unknown',
        byMonth: Object.fromEntries(months.map((month) => [month, 0])),
        totalCents: 0,
      };
      trends.set(row.categoryId, trend);
    }
    const spent = netSpentCents(row.total ?? 0);
    trend.byMonth[row.month] = spent;
    trend.totalCents += spent;
  }

  const sorted = [...trends.values()].sort((a, b) => b.totalCents - a.totalCents);
  return { months, rows: input.limit ? sorted.slice(0, input.limit) : sorted };
}

export interface YoYRow {
  categoryId: number;
  categoryName: string;
  thisMonthCents: number;
  lastMonthCents: number;
  lastYearCents: number;
}

/**
 * Task 13 (spec 2026-08-22, v1.7.0): one month against the month before it and the same month
 * a year earlier, for the Reports "This month against last year" card.
 *
 * ONE query, not three: the three month keys are not contiguous (lastYear sits 11 months
 * before lastMonth), so this scans the full span from the earliest to the latest of the three
 * -- the same shape categoryMonthOverMonth already uses for a contiguous window, grouped by
 * (month, EFFECTIVE_CATEGORY) -- and keeps only the three month buckets that matter in JS. That
 * is still one grouped aggregate hitting transactions_date_idx once, never one round trip per
 * month key.
 *
 * Split-aware (Task 3's pattern): LEFT JOIN transaction_splits and group by EFFECTIVE_CATEGORY/
 * EFFECTIVE_AMOUNT so a split transaction is counted once, at its parts' own categories, never
 * at the parent's own lump category/amount.
 */
export function categoryYearOverYear(input: { month: string; attributedUserId?: PersonScope }, viewer: Viewer): YoYRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  const thisMonth = input.month;
  const lastMonth = addMonths(thisMonth, -1);
  const lastYear = addMonths(thisMonth, -12);

  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: EFFECTIVE_CATEGORY,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(
      and(
        ...rangeClauses({ from: monthStart(lastYear), to: monthEnd(thisMonth) }, scope),
        eq(categories.isIncome, false),
      ),
    )
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));

  // Cells keyed by the transaction's OWN category (pre-rollup), matching only the three month
  // keys this card cares about -- every other month the range query happened to scan is
  // dropped here, in JS, rather than fetched again.
  interface Cell {
    thisMonthCents: number;
    lastMonthCents: number;
    lastYearCents: number;
  }
  const cellsByCategory = new Map<number, Cell>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    if (row.month !== thisMonth && row.month !== lastMonth && row.month !== lastYear) continue;
    const cell = cellsByCategory.get(row.categoryId) ?? { thisMonthCents: 0, lastMonthCents: 0, lastYearCents: 0 };
    const spent = netSpentCents(row.total ?? 0);
    if (row.month === thisMonth) cell.thisMonthCents += spent;
    else if (row.month === lastMonth) cell.lastMonthCents += spent;
    else cell.lastYearCents += spent;
    cellsByCategory.set(row.categoryId, cell);
  }

  // Rollup to parent level (categoryBreakdown({ rollup: true })'s rule): each child's three
  // cells fold into ITS OWN parent, never into a shared bucket.
  const rolled = new Map<number, Cell>();
  for (const [categoryId, cell] of cellsByCategory) {
    const target = byId.get(categoryId)?.parentId ?? categoryId;
    const existing = rolled.get(target) ?? { thisMonthCents: 0, lastMonthCents: 0, lastYearCents: 0 };
    existing.thisMonthCents += cell.thisMonthCents;
    existing.lastMonthCents += cell.lastMonthCents;
    existing.lastYearCents += cell.lastYearCents;
    rolled.set(target, existing);
  }

  const result: YoYRow[] = [];
  for (const [categoryId, cell] of rolled) {
    // A row with nothing to show in any of the three months is noise, not a comparison.
    if (cell.thisMonthCents === 0 && cell.lastMonthCents === 0 && cell.lastYearCents === 0) continue;
    result.push({ categoryId, categoryName: byId.get(categoryId)?.name ?? 'Unknown', ...cell });
  }
  return result.sort((a, b) => b.thisMonthCents - a.thisMonthCents);
}

export interface PersonSplitRow {
  userId: number | null;
  label: string;
  spentCents: number;
}

/**
 * A self viewer gets exactly one row -- their own. The split IS the household comparison otherwise,
 * which is precisely the "reports of household totals" ruling R2 forbids, so the Reports page renders
 * this section only for a household viewer (Task 13). Returning one row rather than throwing keeps
 * this function total for any caller.
 */
export function personSpendSplit(input: DateRange, viewer: Viewer): PersonSplitRow[] {
  // Split-aware (Task 3): grouped by transactions.attributedUserId (attribution stays
  // whole-transaction, design ruling 1 -- a split has no owner of its own), but the income
  // exclusion join keys off EFFECTIVE_CATEGORY and the summed amount is EFFECTIVE_AMOUNT, so
  // BOTH of a split's parts land on the parent's person, each correctly included/excluded by
  // its OWN category rather than the parent's.
  const rows = getDb()
    .select({ userId: transactions.attributedUserId, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses(input, undefined), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.attributedUserId)
    .all();

  const people = getDb().select({ id: users.id, name: users.name }).from(users).all();
  const spendByUser = new Map<number | null, number>();
  for (const row of rows) spendByUser.set(row.userId, netSpentCents(row.total ?? 0));

  const result: PersonSplitRow[] = people
    .filter((person) => spendByUser.has(person.id))
    .map((person) => ({ userId: person.id, label: person.name, spentCents: spendByUser.get(person.id) ?? 0 }));

  // The unattributed bucket is always present — never silently dropped.
  result.push({ userId: null, label: UNATTRIBUTED_LABEL, spentCents: spendByUser.get(null) ?? 0 });
  const sorted = result.sort((a, b) => b.spentCents - a.spentCents);

  const own = ownerScope(viewer);
  return own === null ? sorted : sorted.filter((row) => row.userId === own);
}

export interface TopMerchantRow {
  /**
   * v1.21.0 plan, item 8b: NOT always the raw `transactions.normalized_merchant` any more. When
   * a rename rule (`merchant_rules`, rule_kind = 'rename') resolves for a bucket's own
   * normalized key, this is the rule's `rename_to` -- the same folded identity the buckets below
   * are grouped by. A key with no matching rule keeps its own raw value, exactly as before.
   */
  normalizedMerchant: string;
  spentCents: number;
  count: number;
}

/**
 * v1.21.0 plan, item 8b. Before this fix, a big-box store split across several
 * `normalized_merchant` values (differing store numbers/city suffixes normalize.ts's
 * deterministic rules do not strip) stayed split here even after the owner wrote a `contains
 * WALMART -> Walmart` rename rule -- that rule already relabels the Transactions list (it writes
 * `display_description`/`display_source = 'rename'` at engine.ts:793), but this report grouped
 * and displayed `transactions.normalized_merchant` directly and never consulted it.
 *
 * Folded by RULE, not by the stored `display_description`: a transaction renamed BY HAND keeps
 * its own label and is deliberately skipped by the rename engine (its `display_source` is
 * 'manual', not 'rename'), so grouping on the stored display value would tear that one row away
 * from the vendor bucket it belongs in even though its `normalized_merchant` matches the rule
 * exactly like every other row at that store. Running `matchRule` against each bucket's raw
 * normalized key -- never against a transaction's own possibly-hand-edited display text --
 * groups it correctly regardless of what a person typed over it.
 *
 * Folded at the RAW bucket level, before `netSpentCents`/the `> 0` filter, not after: the SQL
 * query below already nets refunds against charges PER RAW normalized_merchant (a return at
 * "WALMART 1234" against a charge at the same key). Two of a rename rule's raw buckets are
 * disjoint by construction (one row's normalized_merchant cannot equal two different values), so
 * summing their signed totals and their `count(distinct id)` before resolving to dollars and
 * filtering is exactly "the buckets are disjoint, so sums and charge counts simply add" -- and it
 * is also the economically correct answer: a refund-heavy location of the same vendor nets
 * against a spend-heavy one, the same way two receipts at the identical store already do.
 *
 * Two different rule patterns resolving to the SAME `rename_to` (e.g. `contains WALMART ->
 * Walmart` and a separate `contains WAL-MART -> Walmart`) fold into ONE bucket too -- the map
 * below keys on the resolved display name, not on which rule produced it, so there is no way for
 * the same vendor to end up split across two rows just because two patterns both point at it.
 */
export function topMerchants(input: DateRange & { limit?: number; attributedUserId?: PersonScope }, viewer: Viewer): TopMerchantRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  // Split-aware (v1.7.0 review fix, 2026-08-22): merchant IDENTITY still groups by the
  // parent's own normalizedMerchant -- a split never changes who charged the card, so the
  // GROUPING here was always correct. What was wrong was the income FILTER and the SUM: this
  // used to join `categories` on the parent's own transactions.categoryId, which a split
  // never updates (splits.ts ruling 1/2), so the whole transaction's include/exclude decision
  // was made on a stale category. A charge filed under an income category and later corrected
  // by a split -- exactly the case splitting exists for -- had its entire amount silently
  // excluded forever. Both the join and the summed amount now key off
  // EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) via a LEFT JOIN onto
  // transaction_splits, so each split PART decides its own inclusion and contributes its own
  // amount, while every part still lands in the parent's merchant bucket.
  //
  // count(distinct transactions.id), NOT count(*): the transaction_splits join multiplies
  // rows per split part (an N-part split yields N joined rows for one charge), so count(*)
  // would report a 3-part split as 3 charges at that merchant. Counting distinct transaction
  // ids keeps "Charges" meaning the number of card charges, not the number of category parts
  // summed across all of them.
  const rows = getDb()
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
      count: sql<number>`count(distinct ${transactions.id})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses(input, scope), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.normalizedMerchant)
    .all();

  // A handful of rules read once for the whole report, not once per merchant bucket.
  const renameRules = listRules('rename');
  const folded = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const rule = matchRule(row.normalizedMerchant, 'rename', renameRules);
    const displayName = rule?.renameTo ?? row.normalizedMerchant;
    const bucket = folded.get(displayName) ?? { total: 0, count: 0 };
    bucket.total += row.total ?? 0;
    bucket.count += row.count;
    folded.set(displayName, bucket);
  }

  return [...folded.entries()]
    .map(([normalizedMerchant, bucket]) => ({ normalizedMerchant, spentCents: netSpentCents(bucket.total), count: bucket.count }))
    .filter((row) => row.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, input.limit ?? 10);
}

export interface CsvColumn<T> {
  key: keyof T & string;
  header: string;
}

/**
 * Fields a spreadsheet would execute rather than display. Excel/Sheets/LibreOffice all
 * treat a leading =, +, - or @ as the start of a formula, and a leading tab as a cell
 * separator that shifts the payload into the next cell — so a transaction note reading
 * `=SUM(1)` (or worse, a WEBSERVICE/HYPERLINK call) would run on open. Bank descriptions
 * are attacker-influenced text in exactly the way this attack needs.
 */
const FORMULA_TRIGGER = /^[=+\-@\t]/;

/**
 * ...except a plain number. Spend is stored negative, so the Amount column is full of
 * values like "-45.00": those start with a trigger character but are numeric literals,
 * not formulas, and quoting them as text would break every sum in the exported sheet —
 * the one thing people export a CSV to do. Anything with an operator in it ("-2+3") fails
 * this test and is still guarded.
 */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * RFC 4180 quoting is preserved exactly as before; the injection guard is a separate,
 * earlier step that prefixes a single quote. The apostrophe is what spreadsheets read as
 * "this cell is literal text" — it is not shown in the cell, and a plain-text reader sees
 * one extra leading character, which is the accepted cost of the guard.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function transactionsCsv(filter: TransactionFilter, viewer: Viewer): string {
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  // Shared by the unsplit and per-part rows below so a part's category renders with exactly
  // the same "Parent > Child" formatting the unsplit path has always used.
  const categoryPath = (categoryId: number | null): string => {
    const category = categoryId === null ? null : byId.get(categoryId);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} > ${category.name}` : category.name;
  };

  const page = listTransactions({ ...filter, page: 1, pageSize: 200 }, viewer);
  const rows: Record<string, unknown>[] = [];

  for (let pageNumber = 1; pageNumber <= page.pageCount; pageNumber += 1) {
    const chunk = pageNumber === 1 ? page : listTransactions({ ...filter, page: pageNumber, pageSize: 200 }, viewer);
    // Split-aware (spec 2026-08-22, v1.7.0, Task 4): one batched lookup per page of up to
    // 200 transactions, not a query per row.
    const splitsByTxn = splitsForTransactions(chunk.rows.map((row) => row.id));

    for (const row of chunk.rows) {
      const parts = splitsByTxn.get(row.id) ?? [];

      if (parts.length === 0) {
        // Unchanged from the pre-split format -- byte-identical for every transaction that
        // was never split (tests/lib/reports.test.ts asserts this against a fixture).
        rows.push({
          Date: row.date,
          Account: row.accountName,
          Description: row.rawDescription,
          Merchant: row.normalizedMerchant,
          Amount: (row.amountCents / 100).toFixed(2),
          Category: categoryPath(row.categoryId),
          Person: row.attributedUserName ?? UNATTRIBUTED_LABEL,
          Transfer: row.isTransfer ? 'yes' : 'no',
          Source: row.source,
          Notes: row.notes ?? '',
        });
        continue;
      }

      // One row per part: amount, category and note are the part's own. Date, account,
      // merchant, person, transfer and source stay the parent's -- attribution and every
      // other parent-level fact are whole-transaction (design ruling 1, spec 2026-08-22).
      parts.forEach((part, index) => {
        rows.push({
          Date: row.date,
          Account: row.accountName,
          Description: `${row.rawDescription} (split ${index + 1}/${parts.length})`,
          Merchant: row.normalizedMerchant,
          Amount: (part.amountCents / 100).toFixed(2),
          Category: categoryPath(part.categoryId),
          Person: row.attributedUserName ?? UNATTRIBUTED_LABEL,
          Transfer: row.isTransfer ? 'yes' : 'no',
          Source: row.source,
          Notes: part.note ?? '',
        });
      });
    }
  }

  return toCsv(rows, [
    { key: 'Date', header: 'Date' },
    { key: 'Account', header: 'Account' },
    { key: 'Description', header: 'Description' },
    { key: 'Merchant', header: 'Merchant' },
    { key: 'Amount', header: 'Amount' },
    { key: 'Category', header: 'Category' },
    { key: 'Person', header: 'Person' },
    { key: 'Transfer', header: 'Transfer' },
    { key: 'Source', header: 'Source' },
    { key: 'Notes', header: 'Notes' },
  ]);
}
