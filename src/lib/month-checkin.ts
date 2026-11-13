import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions, transactionSplits, warrantyItems } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { billsDueThisMonth } from '@/lib/bills';
import { flattenBudgetRows, type BudgetRow, type BudgetScope } from '@/lib/budgets';
import { listCategories } from '@/lib/categories';
import { daysBetweenIso, monthEnd, monthOf, monthStart } from '@/lib/dates';
import { checkInHistoryMonths, restOfMonthSpend } from '@/lib/predict/history';
import { checkInMonthEnd, everydayCents, type HistoryStretch } from '@/lib/predict/pace';
import { dueElsewhereMatcher, expectedRecurringCharges, recurringCharges } from '@/lib/recurring';
import { EFFECTIVE_CATEGORY } from '@/lib/splits';

/**
 * v1.62.0, the month check-in. SERVER-ONLY: it reads the database through bills.ts, recurring.ts
 * and predict/history.ts, so a client component never imports it -- figures arrive as props.
 *
 * Where the month is heading, in three parts a household can check one by one:
 *
 *   spent so far + bills and marked recurring charges still due this month + what is usually
 *   spent in the rest of the month (day-aligned, the median of the last CHECKIN_HISTORY_MONTHS
 *   complete months)
 *
 * ONE function, read by the Budgets cards, the Dashboard's Spent and Net tiles, the budget_pace
 * alert and the weekly digest's pace list, so no two of them can disagree about the same budget.
 *
 * Nothing is counted twice:
 *   - the history leaves out exactly the merchants the due side counts (dueElsewhereMatcher, built
 *     from the due bills and expected charges below), and every row that paid a bill installment;
 *   - an expected recurring charge a bill row already stands for is left out of the due part
 *     (expectedRecurringCharges, handed the same bills);
 *   - a marked merchant that has already charged this month is not due again, whatever its next
 *     expected date says (a charge on the 1st of each month has a 30-day median gap, which puts
 *     the next one on the 31st of a 31-day month).
 *
 * Rows held as possible duplicates (set_aside_rows, v1.61.0) are not transactions, so neither the
 * spent figures callers pass nor the history read here can count them.
 */

export interface CheckIn {
  /** The figure already on screen beside it (MUST-8.7). */
  spentCents: number;
  /** Bills and marked recurring charges still due before the month ends. */
  dueCents: number;
  /** The usual rest of the month: the median day-aligned month, scaled to the days left. */
  everydayCents: number;
  /** max(spent, 0) + due + everyday. */
  projectedCents: number;
}

export interface MonthCheckIn {
  /** Null before the household has one complete month of history (no straight-line fallback). */
  total: CheckIn | null;
  /** One entry per budget row with a limit, not archived. Empty when `total` is null. */
  byCategory: Map<number, CheckIn>;
  /** How many complete months the history read: 0 to CHECKIN_HISTORY_MONTHS. */
  monthsUsed: number;
  /** How many bills and marked recurring charges the due part counts (0 when `total` is null). */
  dueCount: number;
}

/** v1.62.0 (plan item E4): the quiet line under the check-in. */
export interface RecurringCountLine {
  /** The bills and marked recurring charges the check-in counts as still due this month. */
  counted: number;
  /** Merchants with a detected rhythm nobody has marked either way (recurringCharges' Looks tier). */
  looks: number;
}

/**
 * "Counting N recurring charges · M more look recurring", for the scope the check-in was read
 * for: `ownerUserId` is the person (null for the household), resolved through recurringCharges'
 * own `ownerScope(viewer) ?? ownerUserId`, so a self viewer only ever counts their own. Null --
 * no line -- when there is no check-in, or when both counts are zero.
 */
export function recurringCountLine(input: {
  checkIn: MonthCheckIn | null;
  today: string;
  ownerUserId: number | null;
  viewer: Viewer;
}): RecurringCountLine | null {
  if (input.checkIn === null || input.checkIn.total === null) return null;
  const looks = recurringCharges({ today: input.today, ownerUserId: input.ownerUserId, viewer: input.viewer, accountId: null }).looks
    .length;
  const counted = input.checkIn.dueCount;
  if (counted === 0 && looks === 0) return null;
  return { counted, looks };
}

interface DueItem {
  amountCents: number;
  categoryId: number | null;
}

/** Bill items' own budget category, in one read. */
function itemCategories(itemIds: number[]): Map<number, number | null> {
  if (itemIds.length === 0) return new Map();
  return new Map(
    getDb()
      .select({ id: warrantyItems.id, categoryId: warrantyItems.budgetCategoryId })
      .from(warrantyItems)
      .where(inArray(warrantyItems.id, itemIds))
      .all()
      .map((row) => [row.id, row.categoryId]),
  );
}

/**
 * Each newest charge's date and effective category, in one read. A split charge whose parts sit
 * in more than one category has no single one, so its expected charge counts in the total only.
 */
function newestCharges(transactionIds: number[]): Map<number, { date: string; categoryId: number | null }> {
  if (transactionIds.length === 0) return new Map();
  const rows = getDb()
    .select({ id: transactions.id, date: transactions.date, categoryId: EFFECTIVE_CATEGORY })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(inArray(transactions.id, transactionIds))
    .all();
  const seen = new Map<number, { date: string; categories: Set<number | null> }>();
  for (const row of rows) {
    const entry = seen.get(row.id) ?? { date: row.date, categories: new Set<number | null>() };
    entry.categories.add(row.categoryId);
    seen.set(row.id, entry);
  }
  const out = new Map<number, { date: string; categoryId: number | null }>();
  for (const [id, entry] of seen) {
    out.set(id, { date: entry.date, categoryId: entry.categories.size === 1 ? [...entry.categories][0] : null });
  }
  return out;
}

export function monthCheckIn(input: {
  month: string;
  /** The household date (todayIso in the household zone). */
  today: string;
  scope: BudgetScope;
  userId: number | null;
  rows: BudgetRow[];
  viewer: Viewer;
  /** The caller's on-screen total: the Dashboard's Spent tile, or the section's own total. */
  spentTotalCents: number;
}): MonthCheckIn | null {
  // The current month only: where July is heading, read in August, is not a check-in.
  if (input.month !== monthOf(input.today)) return null;

  // Ruling R2: a self viewer's own scope wins, whatever the caller asked for.
  let scope: BudgetScope = input.scope;
  let userId = input.userId;
  const own = ownerScope(input.viewer);
  if (own !== null) {
    scope = 'personal';
    userId = own;
  }
  if (scope === 'personal' && userId === null) throw new Error('A personal check-in requires a user');
  const ownerUserId = scope === 'personal' ? userId : null;

  // Owner decision (2026-11-12): nothing before one complete month of history, and no fallback.
  // Checked first, so a new household pays for none of the reads below.
  const empty: MonthCheckIn = { total: null, byCategory: new Map(), monthsUsed: 0, dueCount: 0 };
  if (checkInHistoryMonths(input.month).length === 0) return empty;

  // MUST-8.2: the day comes from the household date, and the month's length from monthEnd.
  const dayOfMonth = Number(input.today.slice(8, 10));
  const daysLeft = Number(monthEnd(input.month).slice(8, 10)) - dayOfMonth;
  const first = monthStart(input.month);
  const last = monthEnd(input.month);

  // Due: the bills safeToSpend reads (to month end, overdue left out), then the marked merchants'
  // next charges inside this month that no bill row stands for and that have not charged yet.
  const bills = billsDueThisMonth({ month: input.month, today: input.today, ownerUserId, viewer: input.viewer });
  const inMonth = expectedRecurringCharges({
    today: input.today,
    days: daysBetweenIso(input.today, last),
    ownerUserId,
    viewer: input.viewer,
    bills,
  }).filter((charge) => charge.expectedDate >= first && charge.expectedDate <= last);
  const newest = newestCharges(inMonth.map((charge) => charge.newestTransactionId));
  const expected = inMonth.filter((charge) => (newest.get(charge.newestTransactionId)?.date ?? '') < first);

  const rest = restOfMonthSpend({
    targetMonth: input.month,
    dayOfMonth,
    scope,
    userId,
    excludeMerchant: dueElsewhereMatcher({ bills, expected }),
  });
  const stretches = (perMonth: readonly number[] | undefined): HistoryStretch[] =>
    rest.months.map((_month, index) => ({ cents: perMonth?.[index] ?? 0, days: rest.daysAfter[index] }));
  if (everydayCents({ history: stretches(rest.totalByMonth), daysLeft }) === null) {
    return { ...empty, monthsUsed: rest.months.length };
  }

  const billCategory = itemCategories([...new Set(bills.map((bill) => bill.itemId))]);
  const due: DueItem[] = [
    ...bills.map((bill) => ({ amountCents: bill.amountCents, categoryId: billCategory.get(bill.itemId) ?? null })),
    ...expected.map((charge) => ({
      amountCents: charge.typicalCents,
      categoryId: newest.get(charge.newestTransactionId)?.categoryId ?? null,
    })),
  ];

  // A child category's due amount also counts on its parent, as a child's spend does. An item
  // with no category counts in the total only.
  const parentOf = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.parentId]));
  const dueByCategory = new Map<number, number>();
  for (const item of due) {
    if (item.categoryId === null) continue;
    dueByCategory.set(item.categoryId, (dueByCategory.get(item.categoryId) ?? 0) + item.amountCents);
    const parentId = parentOf.get(item.categoryId) ?? null;
    if (parentId !== null) dueByCategory.set(parentId, (dueByCategory.get(parentId) ?? 0) + item.amountCents);
  }

  const checkIn = (spentCents: number, dueCents: number, history: HistoryStretch[]): CheckIn | null => {
    const projectedCents = checkInMonthEnd({ spentCents, dueCents, history, daysLeft });
    const everyday = everydayCents({ history, daysLeft });
    if (projectedCents === null || everyday === null) return null;
    return { spentCents, dueCents, everydayCents: everyday, projectedCents };
  };

  const byCategory = new Map<number, CheckIn>();
  for (const row of flattenBudgetRows(input.rows)) {
    // The rows Budgets draws a heading line for: a limit, and not archived (read-only).
    if (row.isArchived || row.limitCents === null) continue;
    const found = checkIn(row.spentCents, dueByCategory.get(row.categoryId) ?? 0, stretches(rest.byCategory.get(row.categoryId)));
    if (found !== null) byCategory.set(row.categoryId, found);
  }

  const dueCents = due.reduce((sum, item) => sum + item.amountCents, 0);
  return {
    total: checkIn(input.spentTotalCents, dueCents, stretches(rest.totalByMonth)),
    byCategory,
    monthsUsed: rest.months.length,
    dueCount: due.length,
  };
}
