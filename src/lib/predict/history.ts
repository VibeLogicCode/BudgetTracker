import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions, transactionSplits } from '@/db/schema';
import { listCategories, type CategoryRecord } from '@/lib/categories';
import { addMonths, monthEnd, monthOf, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents } from '@/lib/money';
import { historyMonths, seasonalApplies } from '@/lib/predict/window';
import { seasonalFactor, suggestBudget, type SuggestionResult } from '@/lib/predict/suggest';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY } from '@/lib/splits';

/**
 * The ONLY module under src/lib/predict/ that touches the database (MUST-2.1). Server-only:
 * never imported, directly or transitively, from a *-client.tsx file (MUST-2.2).
 *
 * MUST-3.1 / MUST-3.2: net spend is defined exactly as src/lib/budgets.ts defines it, and
 * there is no second definition. If a suggestion and a progress bar disagree, this file is
 * where the disagreement is.
 */

/**
 * One row of the series, for one category budgetProgress() draws a row for. A top-level row
 * carries its rolled total; a child row carries its own.
 */
export interface CategorySeries {
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  isArchived: boolean;
  /** One entry per month in historyMonths(), same order, zero-filled per MUST-4.4. */
  monthlyCents: number[];
}

export interface SeasonalSeries {
  categoryId: number;
  /** Spend in month A = addMonths(targetMonth, -12). */
  monthCents: number;
  /** The 12 calendar months ending at A inclusive, ascending. */
  twelveMonths: number[];
}

/**
 * MUST-4.8: one grouped query for the whole window, served by transactions_date_idx. Not one
 * query per month and not one resolveBudget() call per category per month.
 *
 * Split-aware (spec 2026-08-22, v1.7.0, Task 3): LEFT JOIN transaction_splits and read
 * EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) instead of the transaction's own
 * columns, so a split transaction is counted once, at its parts -- the date/transfer/
 * attribution predicates keep reading the parent's own columns, since a split has no date or
 * owner of its own.
 */
function cells(
  months: string[],
  scope: 'household' | 'personal',
  userId: number | null,
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  if (months.length === 0) return out;

  const clauses = [
    gte(transactions.date, monthStart(months[0])),
    lte(transactions.date, monthEnd(months[months.length - 1])),
    eq(transactions.isTransfer, false),
    isNotNull(EFFECTIVE_CATEGORY),
  ];
  if (scope === 'personal') {
    if (userId === null) throw new Error('Personal series requires a user');
    clauses.push(eq(transactions.attributedUserId, userId));
  }

  const month = sql<string>`substr(${transactions.date}, 1, 7)`;
  const rows = getDb()
    .select({ month, categoryId: EFFECTIVE_CATEGORY, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...clauses))
    .groupBy(month, EFFECTIVE_CATEGORY)
    .all();

  for (const row of rows) {
    if (row.categoryId === null) continue;
    const byMonth = out.get(row.categoryId) ?? new Map<string, number>();
    // MUST-4.9: netSpentCents() per (month, category) cell, before any rollup.
    byMonth.set(row.month, netSpentCents(row.total ?? 0));
    out.set(row.categoryId, byMonth);
  }
  return out;
}

/**
 * MUST-3.2 and MUST-4.9: this MIRRORS budgetProgress() row for row.
 *
 * budgetProgress()'s own rollup was not exported for reuse here (spec section 2.2, the original
 * 2026-08-22 v1.7.0 spec this module was written against), so it is reproduced here and pinned
 * by a test that compares the two on the seeded tree for a single month. Every rule below is
 * budgetProgress()'s rule:
 *
 *   - income is filtered out FIRST, so an income child never changes a spend parent's total;
 *   - a top-level category's value is its own cell plus every DIRECT child's cell, archived
 *     children included;
 *   - a child is its own row carrying only its own cell, UNLESS it is archived and carries no
 *     spend anywhere in the window, in which case it only rolls up (v1.12.1, item S / MON-1 --
 *     see below);
 *   - an archived top-level category surfaces only when its OWN cell is non-zero, which over
 *     a window means non-zero in at least one month of it;
 *   - nothing rolls up more than one level, because budgetProgress does not either.
 *
 * The result is flat and in budgetProgress()'s order (each top-level row, then its rendered
 * children), which is exactly the set flatten(budgetProgress(...)) produces and therefore
 * exactly the set the Budgets page draws a row for. A suggestion for anything else could
 * never be seen or applied.
 *
 * v1.12.1 (item S / MON-1, ruling P3): budgetProgress()'s archived-child rule changed from a
 * blanket "never its own row" to "surfaces when it still carries a resolved LIMIT or non-zero
 * SPEND this month, dropped when it carries neither" (src/lib/budgets.ts). Only the SPEND half
 * of that rule has an analog here: CategorySeries has no `limitCents` field and never will --
 * this module predicts spend, it does not resolve budgets -- and a multi-month window (the
 * common case; only the MUST-3.2 test ever calls this with a single month) has no one "current
 * month" to resolve a limit against the way budgetProgress's single `month` argument does. So
 * an archived child surfaces here whenever ANY month in the window carries real spend, and
 * still rolls up silently, with no row of its own, when the whole window is zero -- which is
 * exactly budgetProgress()'s outcome on every fixture MUST-3.2 pins, because every one of them
 * that gives an archived child a limit also gives it spend. `suggestionsFor` skips every
 * archived row regardless (controller ruling, Task 5 review), so this divergence can never
 * surface a suggestion budgetProgress wouldn't also show a limit for.
 */
function rollup(months: string[], byCategory: Map<number, Map<string, number>>): CategorySeries[] {
  const all = listCategories({ includeArchived: true }).filter((category) => !category.isIncome);
  const cell = (categoryId: number, month: string) => byCategory.get(categoryId)?.get(month) ?? 0;

  const out: CategorySeries[] = [];
  for (const parent of all.filter((category) => category.parentId === null)) {
    const children: CategoryRecord[] = all.filter((category) => category.parentId === parent.id);
    const own = months.map((month) => cell(parent.id, month));
    if (parent.isArchived && own.every((cents) => cents === 0)) continue;

    out.push({
      categoryId: parent.id,
      categoryName: parent.name,
      parentId: null,
      isArchived: parent.isArchived,
      monthlyCents: months.map(
        (month, index) => own[index] + children.reduce((sum, child) => sum + cell(child.id, month), 0),
      ),
    });
    for (const child of children) {
      const childMonthly = months.map((month) => cell(child.id, month));
      if (child.isArchived && childMonthly.every((cents) => cents === 0)) continue;
      out.push({
        categoryId: child.id,
        categoryName: child.name,
        parentId: parent.id,
        isArchived: child.isArchived,
        monthlyCents: childMonthly,
      });
    }
  }
  return out;
}

export function categorySeries(input: {
  months: string[];
  scope: 'household' | 'personal';
  userId: number | null;
}): CategorySeries[] {
  // MUST-4.5: the window can be empty, on a household with no transactions or for a target
  // month it has not reached. No window means no series, and no query either.
  if (input.months.length === 0) return [];
  return rollup(input.months, cells(input.months, input.scope, input.userId));
}

/** MUST-4.3: the month of the oldest non-transfer row, or null on a household with none. */
export function firstDataMonth(): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(eq(transactions.isTransfer, false))
    .get();
  return row?.first ? monthOf(row.first) : null;
}

/**
 * MUST-4.11: the 12 calendar months ending at A = targetMonth - 12, inclusive, through the
 * same query shape and the same rollup rule. Called only when seasonalApplies() is true, so a
 * household under the history floor never pays for the second query.
 */
export function seasonalReference(input: {
  targetMonth: string;
  scope: 'household' | 'personal';
  userId: number | null;
}): Map<number, SeasonalSeries> {
  const referenceMonth = addMonths(input.targetMonth, -12);
  const months = monthRange(addMonths(referenceMonth, -11), referenceMonth);
  const out = new Map<number, SeasonalSeries>();
  for (const row of categorySeries({ months, scope: input.scope, userId: input.userId })) {
    out.set(row.categoryId, {
      categoryId: row.categoryId,
      monthCents: row.monthlyCents[row.monthlyCents.length - 1] ?? 0,
      twelveMonths: row.monthlyCents,
    });
  }
  return out;
}

export interface ScopeSuggestions {
  /** The clipped window these were computed over. Its length drives MUST-15.1's sentence. */
  months: string[];
  byCategory: Map<number, SuggestionResult>;
}

/**
 * The one composition of window, series, seasonality and suggestion, for one scope and one
 * target month.
 *
 * It lives here, in the tree's only server module, because both the Budgets page render and
 * applySuggestionAction need it and MUST-3.2 forbids a second definition: the button's label
 * can never disagree with what the button did if there is one computation.
 *
 * MUST-16.3: one categorySeries() query, plus at most one seasonalReference() query and only
 * on installs whose history covers a complete reference year (MUST-4.11's gate, via
 * seasonalApplies which is at least as tight).
 */
export function suggestionsFor(input: {
  targetMonth: string;
  scope: 'household' | 'personal';
  userId: number | null;
}): ScopeSuggestions {
  const first = firstDataMonth();
  const months = historyMonths({ targetMonth: input.targetMonth, firstDataMonth: first });
  const byCategory = new Map<number, SuggestionResult>();

  const series = categorySeries({ months, scope: input.scope, userId: input.userId });
  const reference = seasonalApplies({ targetMonth: input.targetMonth, firstDataMonth: first })
    ? seasonalReference({ targetMonth: input.targetMonth, scope: input.scope, userId: input.userId })
    : null;

  for (const row of series) {
    // Controller ruling (Task 5 review): an archived row is read-only on the Budgets page, so
    // a suggestion for it could never be applied. Skip it entirely rather than compute one
    // nobody can act on.
    if (row.isArchived) continue;
    const found = reference?.get(row.categoryId) ?? null;
    byCategory.set(
      row.categoryId,
      suggestBudget({
        monthlyCents: row.monthlyCents,
        seasonal: found === null ? null : seasonalFactor({ monthCents: found.monthCents, twelveMonths: found.twelveMonths }),
      }),
    );
  }
  return { months, byCategory };
}

/**
 * MUST-15.2 and MUST-7.2: true when every category in this scope resolves to 'no-spend' over
 * the historical window. An empty map returns false: nothing was computed, so there is
 * nothing to call a no-spend scope.
 *
 * This reads the HISTORICAL series suggestionsFor() already computed, never the current
 * month's budgetProgress() snapshot. The two differ on purpose: the window suggestionsFor
 * uses is the full months strictly before the target month (historyMonths), so a person's
 * attribution status does not flip on whichever day of the current month happens to be true.
 */
export function isAllNoSpend(byCategory: Map<number, SuggestionResult>): boolean {
  if (byCategory.size === 0) return false;
  for (const result of byCategory.values()) {
    if (!('reason' in result) || result.reason !== 'no-spend') return false;
  }
  return true;
}
