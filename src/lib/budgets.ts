import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { budgetRollover, budgets, transactions, transactionSplits } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { listCategories, type CategoryRecord } from '@/lib/categories';
import { nowIso } from '@/lib/clock';
import { addMonths, isMonthKey, monthEnd, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents, pctOf } from '@/lib/money';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY } from '@/lib/splits';
import { SPEND_ROW_WHERE } from '@/lib/spend-where';

export type BudgetScope = 'household' | 'personal';

export interface BudgetRow {
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  isIncome: boolean;
  isArchived: boolean;
  /**
   * The EFFECTIVE limit -- base + carried rollover (spec 2026-08-22, v1.7.0, Task 10). Every
   * existing consumer (progress bars, budgetTotals, the dashboard, notification evaluators)
   * reads this field and needs no further changes to pick up rollover.
   */
  limitCents: number | null;
  /** The resolved limit BEFORE any rollover carry. Equal to limitCents whenever rollover is
   *  off, or on but carrying nothing yet. */
  baseLimitCents: number | null;
  /** Positive-only leftover carried in from prior months (ruling 4: overspend never carries
   *  a debt forward). Zero when rollover is off.
   *  v1.13.0 ruling R11: `sinkingFundsFor` in src/lib/bills.ts reads this figure to say what a
   *  category is accumulating toward. It writes nothing here. */
  carryCents: number;
  spentCents: number;
  remainingCents: number | null;
  pct: number | null;
  overBudget: boolean;
  children: BudgetRow[];
  /**
   * v1.21.0 item 2 (owner's screenshot: a parent reading $628.55 over children totalling
   * $183.55). This category's OWN spend, before foldRollup adds any child's -- the exact same
   * figure foldRollup seeds `spentCents` with (src/lib/budgets.ts's own foldRollup, just below).
   * That seed was always arithmetically correct; the defect was that it had no ROW anywhere --
   * BudgetCategoryCard rendered only `children`, so a pharmacy run filed straight under "Health"
   * counted in the parent's headline total and then vanished from the breakdown underneath it.
   *
   * Populated for every row, leaf or parent (a leaf's own spend and its `spentCents` are the same
   * number, since it has no children to fold in) -- the CLIENT decides when it means anything: a
   * leaf never renders it as a separate row, and a parent renders it, labelled "Not in a
   * sub-category", only when it is non-zero. Deliberately NOT one of `children`: it carries no
   * limit of its own, so it must never be counted in a card's "N sub-categories" eyebrow or its
   * "M over" tally -- both read `children` alone, which this figure is not part of.
   */
  directSpentCents: number;
}

function assertMonth(month: string): void {
  if (!isMonthKey(month)) throw new Error(`Month must be YYYY-MM, got "${month}"`);
}

function scopeCondition(scope: BudgetScope, userId: number | null) {
  return scope === 'personal'
    ? and(eq(budgets.scope, 'personal'), eq(budgets.userId, userId as number))
    : and(eq(budgets.scope, 'household'), isNull(budgets.userId));
}

/**
 * The newest row at or before `month` for this (scope, user, category).
 * A row with amount_cents = NULL means "cleared from here forward" and resolves to null.
 */
export function resolveBudget(scope: BudgetScope, userId: number | null, categoryId: number, month: string): number | null {
  assertMonth(month);
  const row = getDb()
    .select({ amountCents: budgets.amountCents })
    .from(budgets)
    .where(and(scopeCondition(scope, userId), eq(budgets.categoryId, categoryId), lte(budgets.effectiveMonth, month)))
    .orderBy(sql`${budgets.effectiveMonth} desc`)
    .limit(1)
    .get();
  if (!row) return null;
  return row.amountCents;
}

export function upsertBudget(input: {
  scope: BudgetScope;
  userId: number | null;
  categoryId: number;
  month: string;
  amountCents: number | null;
}): void {
  assertMonth(input.month);
  if (input.scope === 'personal' && input.userId === null) throw new Error('Personal budgets require a user');
  if (input.scope === 'household' && input.userId !== null) throw new Error('Household budgets must not have a user');

  const db = getDb();
  const existing = db
    .select({ id: budgets.id })
    .from(budgets)
    .where(
      and(scopeCondition(input.scope, input.userId), eq(budgets.categoryId, input.categoryId), eq(budgets.effectiveMonth, input.month)),
    )
    .get();

  if (existing) {
    db.update(budgets).set({ amountCents: input.amountCents }).where(eq(budgets.id, existing.id)).run();
    return;
  }

  db.insert(budgets)
    .values({
      scope: input.scope,
      userId: input.userId,
      categoryId: input.categoryId,
      amountCents: input.amountCents,
      effectiveMonth: input.month,
      createdAt: nowIso(),
    })
    .run();
}

export function clearBudget(input: { scope: BudgetScope; userId: number | null; categoryId: number; month: string }): void {
  upsertBudget({ ...input, amountCents: null });
}

/**
 * Net spend per category for one month. Refunds net against spend, transfers are
 * excluded, and the result is keyed by the transaction's own category (rollup is
 * applied later, in budgetProgress).
 *
 * `scope` governs attribution: 'personal' filters to `attributedUserId` (required —
 * a missing user here is the same silent-wrong-number trap as an unguarded
 * `resolveBudget('personal', null, ...)`), 'household' always counts every row
 * regardless of attribution, and omitting `scope` falls back to filtering on
 * `attributedUserId` when one is given (back-compat for direct callers).
 *
 * Split-aware (spec 2026-08-22, v1.7.0, Task 3): LEFT JOIN transaction_splits and read
 * EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) instead of the transaction's own
 * columns, so a split transaction is counted once, at its parts, never at its own lump
 * category/amount and never at both. The date/transfer/attribution predicates below
 * deliberately keep reading the PARENT's columns -- a split has no date or owner of its own.
 *
 * C-02 fix: `SPEND_ROW_WHERE` (src/lib/spend-where.ts) is both halves of "a row that counts as
 * spend" -- transfers AND loan-principal movements (lending out, being repaid on a loan we
 * lent, borrowing on a loan we owe) are excluded, the same rule reports.ts's rangeClauses
 * applies. Before this, a loan-linked row that had already picked up a category from an import
 * rule counted here even though reports.ts correctly read it as $0 -- see NOT_PRINCIPAL_
 * MOVEMENT's own docblock for exactly which movement stays spend (repaying a debt we owe,
 * MUST-13.2) and why.
 */
export function categorySpend(
  month: string,
  opts: { attributedUserId?: number | null; scope?: BudgetScope } = {},
): Map<number, number> {
  assertMonth(month);
  if (opts.scope === 'personal' && (opts.attributedUserId === undefined || opts.attributedUserId === null)) {
    throw new Error('Personal category spend requires a user');
  }
  const clauses = [
    gte(transactions.date, monthStart(month)),
    lte(transactions.date, monthEnd(month)),
    ...SPEND_ROW_WHERE,
    sql`${EFFECTIVE_CATEGORY} is not null`,
  ];
  if (opts.scope !== 'household' && opts.attributedUserId !== undefined && opts.attributedUserId !== null) {
    clauses.push(eq(transactions.attributedUserId, opts.attributedUserId));
  }

  const rows = getDb()
    .select({ categoryId: EFFECTIVE_CATEGORY, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...clauses))
    .groupBy(EFFECTIVE_CATEGORY)
    .all();

  const result = new Map<number, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    result.set(row.categoryId, netSpentCents(row.total ?? 0));
  }
  return result;
}

export interface CategoryTransactionRow {
  id: number;
  date: string;
  merchant: string;
  amountCents: number;
}

/**
 * One category's own transactions for one month -- the read the 2026-08-30 plan's Budgets card
 * "View breakdown" drill-down needs (a card names a total; a person still wants to see what made
 * it up). Nothing existing served this: listTransactions (src/lib/transactions.ts) scopes to the
 * REQUESTING viewer's own attribution (ownerScope), which is the wrong axis here -- an admin
 * viewing a household card must see every member's rows, and viewing a NAMED person's personal
 * card must see exactly that person's, regardless of who is looking. That is categorySpend's own
 * scope/attributedUserId shape, not listTransactions', so this reuses categorySpend's exactly --
 * same options, same "personal requires a user" guard, same split-awareness -- rather than
 * inventing a third scoping rule next to the two this file already has.
 *
 * Deliberately the smallest useful shape: id/date/merchant/amountCents. No account, no source, no
 * attribution -- a card's breakdown says what was spent and when, not a second transactions
 * table's worth of columns. A split transaction contributes its OWN part's category and amount
 * (EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT, src/lib/splits.ts), the same rule categorySpend already
 * folds every total through, so a row returned here is exactly one of the rows that total summed.
 *
 * `viewer` is REQUIRED (controller ruling R11), for the same reason listTransactions' is
 * (src/lib/transactions.ts): an optional parameter lets a forgotten call site compile into a
 * silent leak. `opts.attributedUserId`/`opts.scope` answer "whose card is this a breakdown of"
 * (household, or one NAMED person, regardless of who is asking); `viewer` answers a different
 * question, "who is asking", and narrows the result to what THEY may see -- see the appended
 * clause below for how the two combine.
 */
export function categoryTransactions(
  month: string,
  categoryId: number,
  opts: { attributedUserId?: number | null; scope?: BudgetScope },
  viewer: Viewer,
): CategoryTransactionRow[] {
  assertMonth(month);
  if (opts.scope === 'personal' && (opts.attributedUserId === undefined || opts.attributedUserId === null)) {
    throw new Error('Personal category transactions requires a user');
  }
  const clauses = [
    gte(transactions.date, monthStart(month)),
    lte(transactions.date, monthEnd(month)),
    ...SPEND_ROW_WHERE,
    sql`${EFFECTIVE_CATEGORY} = ${categoryId}`,
  ];
  if (opts.scope !== 'household' && opts.attributedUserId !== undefined && opts.attributedUserId !== null) {
    clauses.push(eq(transactions.attributedUserId, opts.attributedUserId));
  }
  // v1.13.0 ruling R2, applied here the same way src/lib/transactions.ts:343-348 applies it to
  // listTransactions. Appended AFTER the caller's own attributedUserId clause above, never instead
  // of it: a self viewer who asks for `scope: 'household'` (or for another named person) must get
  // an unsatisfiable AND -- their own rows only, or zero rows -- not a filter silently rewritten to
  // themselves. A rewrite would show them their own spending under another person's name (or under
  // "household"), which is a worse answer than the true, narrower one. ownerScope returns null for
  // a household-visibility viewer or an admin (micro-ruling M1: admin + self is unrestricted), so
  // neither is affected.
  const viewerScope = ownerScope(viewer);
  if (viewerScope !== null) clauses.push(eq(transactions.attributedUserId, viewerScope));

  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: sql<string>`coalesce(${transactions.displayDescription}, ${transactions.rawDescription})`,
      amountCents: EFFECTIVE_AMOUNT,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...clauses))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .all();
}

/**
 * The rollup rule, in exactly one place (spec 2026-08-22, v1.7.0, Task 10): a category's own
 * spend plus every id in `childIds` -- archived children included, because callers pass the
 * archived-inclusive list, never the render-only one, so an archived child's spend is never
 * silently dropped. buildRow is this function's only caller now; categorySpendWithRollupSeries
 * below applies the identical rule independently, in its own batched form, rather than calling
 * this function (see its own doc comment) -- so this rule itself can only drift by editing
 * foldRollup directly.
 */
function foldRollup(categoryId: number, childIds: number[], spendByCategory: Map<number, number>): number {
  return childIds.reduce((sum, id) => sum + (spendByCategory.get(id) ?? 0), spendByCategory.get(categoryId) ?? 0);
}

/**
 * Same rule as foldRollup, applied independently and batched over many months in ONE query
 * instead of one call per month. Without this, effectiveBudget's up-to-24-month lookback
 * would be a query per category per month. Same batch-then-fold-over-the-month-axis shape as
 * debtOverTime in src/lib/loans.ts: two queries (the category tree, and the transactions
 * grouped by month), then a fold over the requested month keys -- no per-month query.
 *
 * Exported for F-06 (2026-09-02 review, v1.31.0): budgets/category-history-action.ts is now a
 * SECOND caller, alongside effectiveBudget, for the budget card's six-month spend strip -- the
 * same one-query series this function already computed for rollover's lookback is exactly the
 * per-category, per-month, child-rolled spend that strip needs, so it reuses this rather than
 * writing the rollup rule a third time. Still takes no viewer, same as budgetProgress
 * (HOUSEHOLD_ONLY_AT_PAGE, tests/ops/visibility-invariants.test.ts) -- category-history-action.ts
 * carries the narrowing itself, the way every caller in that list does.
 */
export function categorySpendWithRollupSeries(
  scope: BudgetScope,
  userId: number | null,
  categoryId: number,
  months: string[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (months.length === 0) return result;
  for (const m of months) result.set(m, 0);

  const childIds = listCategories({ includeArchived: true })
    .filter((category) => category.parentId === categoryId)
    .map((category) => category.id);
  const includedIds = new Set([categoryId, ...childIds]);

  const clauses = [
    gte(transactions.date, monthStart(months[0] as string)),
    lte(transactions.date, monthEnd(months[months.length - 1] as string)),
    ...SPEND_ROW_WHERE,
    sql`${EFFECTIVE_CATEGORY} is not null`,
  ];
  if (scope === 'personal' && userId !== null) clauses.push(eq(transactions.attributedUserId, userId));

  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: EFFECTIVE_CATEGORY,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...clauses))
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, EFFECTIVE_CATEGORY)
    .all();

  for (const row of rows) {
    if (row.categoryId === null || !includedIds.has(row.categoryId)) continue;
    result.set(row.month, (result.get(row.month) ?? 0) + netSpentCents(row.total ?? 0));
  }
  return result;
}

function rolloverCondition(scope: BudgetScope, userId: number | null, categoryId: number) {
  return scope === 'personal'
    ? and(eq(budgetRollover.scope, 'personal'), eq(budgetRollover.userId, userId as number), eq(budgetRollover.categoryId, categoryId))
    : and(eq(budgetRollover.scope, 'household'), isNull(budgetRollover.userId), eq(budgetRollover.categoryId, categoryId));
}

/**
 * A row's EXISTENCE means rollover is ON for this (scope, user, category); deleting it turns
 * rollover off again (src/db/schema.ts's doc comment on budgetRollover -- no `enabled` column
 * to drift out of sync with). Re-enabling an already-on rollover is a no-op that leaves the
 * original startMonth untouched: silently moving when the carry began would be a worse
 * surprise than doing nothing.
 */
export function setRollover(input: {
  scope: BudgetScope;
  userId: number | null;
  categoryId: number;
  enabled: boolean;
  startMonth: string;
}): void {
  assertMonth(input.startMonth);
  if (input.scope === 'personal' && input.userId === null) throw new Error('Personal rollover requires a user');
  if (input.scope === 'household' && input.userId !== null) throw new Error('Household rollover must not have a user');

  const db = getDb();
  const existing = db
    .select({ id: budgetRollover.id })
    .from(budgetRollover)
    .where(rolloverCondition(input.scope, input.userId, input.categoryId))
    .get();

  if (!input.enabled) {
    if (existing) db.delete(budgetRollover).where(eq(budgetRollover.id, existing.id)).run();
    return;
  }
  if (existing) return; // already on -- leave its startMonth exactly as it was

  db.insert(budgetRollover)
    .values({
      scope: input.scope,
      userId: input.userId,
      categoryId: input.categoryId,
      startMonth: input.startMonth,
      createdAt: nowIso(),
    })
    .run();
}

/** Null means rollover is off for this (scope, user, category). */
export function rolloverStartMonth(scope: BudgetScope, userId: number | null, categoryId: number): string | null {
  const row = getDb()
    .select({ startMonth: budgetRollover.startMonth })
    .from(budgetRollover)
    .where(rolloverCondition(scope, userId, categoryId))
    .get();
  return row ? row.startMonth : null;
}

/**
 * resolveBudget's own "newest row at or before" rule (see its doc comment above), batched
 * over many months in ONE query -- same reasoning as categorySpendWithRollupSeries above.
 */
function resolveBudgetSeries(
  scope: BudgetScope,
  userId: number | null,
  categoryId: number,
  months: string[],
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  if (months.length === 0) return result;

  const rows = getDb()
    .select({ effectiveMonth: budgets.effectiveMonth, amountCents: budgets.amountCents })
    .from(budgets)
    .where(
      and(
        scopeCondition(scope, userId),
        eq(budgets.categoryId, categoryId),
        lte(budgets.effectiveMonth, months[months.length - 1] as string),
      ),
    )
    .orderBy(asc(budgets.effectiveMonth))
    .all();

  let idx = 0;
  let current: number | null = null;
  for (const m of months) {
    while (idx < rows.length && rows[idx].effectiveMonth <= m) {
      current = rows[idx].amountCents;
      idx += 1;
    }
    result.set(m, current);
  }
  return result;
}

/**
 * Base limit + carried leftover for `month` (spec 2026-08-22, v1.7.0, Task 10). Pure over db
 * reads and the `month` argument -- no clock access.
 *
 * No rollover row, or `month` at or before the row's startMonth: carryCents is 0 and
 * effectiveCents is exactly baseCents, so a category with rollover off (or not yet at its
 * start month) is indistinguishable from before this feature existed -- every existing
 * consumer of limitCents keeps seeing the same number it always did.
 *
 * Otherwise, walk every month from max(startMonth, month-24) to month-1 inclusive:
 *   carry = max(0, carry + resolveBudget(m) - spentRollup(m))
 * A month with no resolved base contributes 0 (never null) to that sum. The max(0, ...) is
 * applied EVERY month, not once at the end -- ruling 4 (positive leftovers only; overspend
 * never creates a carried debt) -- so one very bad month can zero out the carry, but can
 * never push a later month's effective limit below its own base. 24 months is a hard cap on
 * the look-back regardless of how much earlier startMonth is.
 *
 * PERFORMANCE: the walk reads the whole window's base values and the whole window's
 * rolled-up spend in one query each (resolveBudgetSeries / categorySpendWithRollupSeries), so
 * this function costs a small, constant number of queries no matter how many months it
 * walks -- never a query per month.
 */
export function effectiveBudget(
  scope: BudgetScope,
  userId: number | null,
  categoryId: number,
  month: string,
): { baseCents: number | null; carryCents: number; effectiveCents: number | null } {
  assertMonth(month);
  if (scope === 'personal' && userId === null) throw new Error('Personal effective budget requires a user');

  const baseCents = resolveBudget(scope, userId, categoryId, month);
  const startMonth = rolloverStartMonth(scope, userId, categoryId);

  if (startMonth === null || month <= startMonth) {
    return { baseCents, carryCents: 0, effectiveCents: baseCents };
  }

  const lookbackFloor = addMonths(month, -24);
  const windowStart = startMonth > lookbackFloor ? startMonth : lookbackFloor;
  const months = monthRange(windowStart, addMonths(month, -1));

  const baseByMonth = resolveBudgetSeries(scope, userId, categoryId, months);
  const spentByMonth = categorySpendWithRollupSeries(scope, userId, categoryId, months);

  let carry = 0;
  for (const m of months) {
    const base = baseByMonth.get(m) ?? 0;
    const spent = spentByMonth.get(m) ?? 0;
    carry = Math.max(0, carry + base - spent);
  }

  return { baseCents, carryCents: carry, effectiveCents: baseCents === null ? null : baseCents + carry };
}

/**
 * `pctOf` (money.ts) returns null for a zero limit, which is correct for "no limit"
 * but wrong for a real, explicit $0 limit: a $0 budget with any spend against it is
 * not "no data", it's maximally over. money.ts is not touched — this local branch
 * is the fix: a $0 limit with spend reports 100%, a $0 limit with no spend reports 0%.
 */
function computePct(limitCents: number | null, spentCents: number): number | null {
  if (limitCents === null) return null;
  if (limitCents === 0) return spentCents > 0 ? 100 : 0;
  return pctOf(spentCents, limitCents);
}

function buildRow(
  category: CategoryRecord,
  spendByCategory: Map<number, number>,
  scope: BudgetScope,
  userId: number | null,
  month: string,
  renderChildren: CategoryRecord[],
  rollupChildren: CategoryRecord[],
): BudgetRow {
  const childRows = renderChildren.map((child) =>
    buildRow(child, spendByCategory, scope, userId, month, [], []),
  );
  // Rollup rule: a parent counts its own transactions plus ALL children's — including
  // an archived child's, which is never rendered as its own row (rollupChildren is
  // archived-inclusive; renderChildren, used only for display, is not). foldRollup is the ONE
  // place this rule lives for THIS path; categorySpendWithRollupSeries, which effectiveBudget's
  // carry walk uses, applies the identical rule independently in its own batched form rather
  // than calling foldRollup (both functions' own doc comments say so), so the rule as it applies
  // here can only change by editing foldRollup itself (Task 10).
  const spentCents = foldRollup(
    category.id,
    rollupChildren.map((child) => child.id),
    spendByCategory,
  );
  const { baseCents, carryCents, effectiveCents } = effectiveBudget(scope, userId, category.id, month);
  return {
    categoryId: category.id,
    categoryName: category.name,
    parentId: category.parentId,
    isIncome: category.isIncome,
    isArchived: category.isArchived,
    limitCents: effectiveCents,
    baseLimitCents: baseCents,
    carryCents,
    spentCents,
    remainingCents: effectiveCents === null ? null : effectiveCents - spentCents,
    pct: computePct(effectiveCents, spentCents),
    overBudget: effectiveCents !== null && spentCents > effectiveCents,
    children: childRows,
    // The foldRollup seed above, read back rather than recomputed -- see this field's own
    // doc comment on BudgetRow for why it exists and why it is never one of `children`.
    directSpentCents: spendByCategory.get(category.id) ?? 0,
  };
}

export function budgetProgress(month: string, scope: BudgetScope = 'household', userId: number | null = null): BudgetRow[] {
  assertMonth(month);
  if (scope === 'personal' && userId === null) throw new Error('Personal budget progress requires a user');

  // Archived-inclusive so an archived category's spend is never silently dropped from
  // the rollup; income categories are excluded entirely (finding 7 — not budgetable rows).
  const all = listCategories({ includeArchived: true }).filter((category) => !category.isIncome);
  const spendByCategory = categorySpend(month, {
    scope,
    attributedUserId: scope === 'personal' ? userId : undefined,
  });

  // C-05 half 1: an income category never reaches `all` above, so a non-income category
  // whose PARENT happens to be an income category (e.g. a spend category filed directly
  // under "Salary") has no surviving parent row in `all` at all -- its parentId names
  // nobody `all` still contains. Treat that as top-level rather than silently dropping it:
  // the walk below already relies on an absent parent id matching no row's parentId (see
  // the `allChildren` line), so widening the top-level test to "parentId is null OR its
  // parent isn't present" is tolerant of existing data with no migration. Half 2
  // (src/lib/categories.ts createCategory) stops any NEW ones from being made -- item M-5 deleted
  // half 2's flip-time twin, setCategoryIncome, which guarded a path no caller ever took.
  const presentIds = new Set(all.map((category) => category.id));
  const isTopLevel = (category: CategoryRecord) => category.parentId === null || !presentIds.has(category.parentId);

  return all
    .filter((category) => isTopLevel(category))
    .map((parent) => {
      const allChildren = all.filter((row) => row.parentId === parent.id);
      // v1.12.1 (item S / MON-1). This used to be a blanket `!row.isArchived`, while allChildren
      // (the rollup) kept archived rows -- so archiving a child made its LIMIT disappear from
      // every number while its SPEND went on counting against the parent, and the parent flipped
      // to over budget for no visible reason anybody could see on the page. The rule is now the
      // archived-TOP-LEVEL rule below, applied one level down: an archived child
      // surfaces when it still carries a resolved limit or real spend this month, and is dropped
      // when it carries neither.
      const renderChildren = allChildren.filter(
        (row) =>
          !row.isArchived ||
          (spendByCategory.get(row.id) ?? 0) !== 0 ||
          resolveBudget(scope, userId, row.id, month) !== null,
      );
      return { parent, allChildren, renderChildren };
    })
    // C-01. `spendByCategory` is each category's OWN direct spend, never the rollup (see
    // foldRollup above) -- a parent whose spending sits entirely in its children reads 0
    // there, so the naive "archived + no direct spend" test used to drop the parent AND,
    // since the walk only ever iterates top-level rows, every live child underneath it too:
    // one click on Settings -> Managers zeroed budgetedLimitCents/budgetedSpentCents/
    // totalSpentCents for the whole subtree and silenced every budget_threshold alert for it.
    // This is the v1.12.1 / item S / MON-1 bug (archiving making a LIMIT vanish while SPEND
    // kept counting) one level up. The fix asks the child predicate's own question, over the
    // rollup rather than the direct map: keep an archived parent when it has direct spend of
    // its own, OR any child survives the predicate above, OR it carries a resolved limit of
    // its own -- an archived parent with a live limit and no spend yet is exactly as real as
    // an archived child in the same state (controller ruling).
    .filter(
      ({ parent, renderChildren }) =>
        !parent.isArchived ||
        (spendByCategory.get(parent.id) ?? 0) !== 0 ||
        renderChildren.length > 0 ||
        resolveBudget(scope, userId, parent.id, month) !== null,
    )
    .map(({ parent, allChildren, renderChildren }) =>
      buildRow(parent, spendByCategory, scope, userId, month, renderChildren, allChildren),
    );
}

/**
 * Flatten budgetProgress()'s parent/child tree into one list, depth-first, parent before its own
 * children.
 *
 * v1.12.1 (ruling P2): this used to live in src/lib/notify/evaluate/pace.ts, which is where a
 * budget helper ended up because the notification evaluators needed it first. It moves here, beside
 * the function whose shape it knows, and pace.ts re-exports it -- so src/lib/budgets.ts never
 * imports from src/lib/notify/**, and monthly.ts and budgets/page.tsx keep working unedited.
 */
export function flattenBudgetRows(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flattenBudgetRows(row.children, acc);
  }
  return acc;
}

/**
 * Three numbers, deliberately not one "spent of limit": mixing all non-income spend against only
 * the rows that happen to have a resolved limit reads as a nonsense percentage (e.g. "$3,200 of
 * $1,000 budgeted" on a month with unbudgeted categories).
 *   - budgetedLimitCents / budgetedSpentCents: only rows with a resolved limit -- this pair is
 *     what the progress bar should be driven by.
 *   - totalSpentCents: every non-income TOP-LEVEL row's spend, budgeted or not (a parent's
 *     spentCents already rolls its children's in, so descending here would double count).
 *
 * v1.12.1 (item S / MON-1, ruling P3). This used to iterate the top level ONLY, with the comment
 * "children are already rolled into their parent". That is true for SPEND and false for LIMITS: a
 * parent with no limit of its own contributes limitCents === null and was skipped, taking every
 * child limit underneath it with it -- so a household that budgets at the child level (Food >
 * Groceries $600, Food > Restaurants $200) was told it had budgeted $0.00 on the budgets header,
 * the dashboard tile and safe-to-spend, while the page one row down rendered both child limits
 * correctly.
 *
 * The overlap rule is explicit and is ruling P3: a parent's own limit SUPERSEDES its children's
 * when it is set, and only when it is null do the children's limits sum. A naive flatten-and-sum
 * would double count whenever both levels carry a limit, because the parent's spentCents already
 * includes the children's -- one pot of spending measured against two pots of budget.
 */
export function budgetTotals(rows: BudgetRow[]): {
  budgetedLimitCents: number;
  budgetedSpentCents: number;
  totalSpentCents: number;
} {
  let budgetedLimitCents = 0;
  let budgetedSpentCents = 0;
  let totalSpentCents = 0;
  for (const row of rows) {
    if (row.isIncome) continue;
    totalSpentCents += row.spentCents;
    if (row.limitCents !== null) {
      // The parent's own limit wins, and its spentCents already includes every child's.
      budgetedLimitCents += row.limitCents;
      budgetedSpentCents += row.spentCents;
      continue;
    }
    // No limit at this level: the children speak for it.
    for (const child of flattenBudgetRows(row.children)) {
      if (child.isIncome || child.limitCents === null) continue;
      budgetedLimitCents += child.limitCents;
      budgetedSpentCents += child.spentCents;
    }
  }
  return { budgetedLimitCents, budgetedSpentCents, totalSpentCents };
}

export function copyBudgetsFromPreviousMonth(month: string, scope: BudgetScope, userId: number | null): number {
  assertMonth(month);
  const previous = addMonths(month, -1);
  let copied = 0;
  // Archived-inclusive, to match budgetProgress: an archived category can still surface
  // as a read-only row carrying real spend, and dropping its limit here would silently
  // turn "$200 of $300" into unbudgeted spend the month after someone archives it.
  // Categories with no resolved limit last month are skipped anyway, so this only ever
  // copies limits that actually existed.
  for (const category of listCategories({ includeArchived: true })) {
    const amount = resolveBudget(scope, userId, category.id, previous);
    if (amount === null) continue;
    upsertBudget({ scope, userId, categoryId: category.id, month, amountCents: amount });
    copied += 1;
  }
  return copied;
}
