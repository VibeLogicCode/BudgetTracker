import { and, eq, gt, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyItemTypes, warrantyItems } from '@/db/schema';
import { addDaysIso, addMonthsClamped, daysBetweenIso, monthEnd, monthOf, monthsBetween } from '@/lib/dates';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { sumCents } from '@/lib/money';
import { projectMonthEnd } from '@/lib/predict/pace';
import { unpaidInstallments } from '@/lib/warranty/installments';

/**
 * Upcoming bills + safe-to-spend (spec 2026-08-22, v1.7.0, Task 9 / ruling 8). "Upcoming
 * bills v1" is deliberately narrow: only warranty_items whose TYPE kind is subscription or
 * contract, with both billing_cycle and billing_amount_cents set. No merchant-pattern bill
 * inference, and warranty/loan items are never bills here even if they happen to carry a
 * billing pair (a loan's billing pair is its payment, not a "bill" in this sense).
 *
 * Both functions are PURE with respect to the clock (project-wide v1.4.0 rule): they take
 * `today`/`month` as plain string arguments and never call `new Date()`. The only
 * non-determinism is the database read itself, exactly like every other lib/*.ts function in
 * this codebase (budgets.ts, reports.ts, etc.) -- "clock-free" here means "same inputs, same
 * db state -> same output", not "no I/O".
 */

export interface UpcomingBill {
  itemId: number;
  name: string;
  kind: 'subscription' | 'contract' | 'bill';
  dueDate: string;
  amountCents: number;
  /** v1.12.0: present only for SCHEDULE-derived rows. Null for a cadence occurrence, which has
   *  no row of its own to point at. Callers key their list on it, because one bill item can
   *  contribute several rows and the item id no longer identifies a row. */
  installmentId: number | null;
  /** v1.12.0: always false for a cadence occurrence -- nextOccurrence() only ever returns a date
   *  strictly after `today`, so a cadence row cannot be in the past by construction. */
  overdue: boolean;
}

/**
 * The next occurrence of a recurring anchor date, strictly after `today`, stepping by whole
 * multiples of `stepMonths` (1 for monthly, 12 for annual) from the anchor. Reuses
 * addMonthsClamped for every month computation -- so a day-of-month that does not exist in
 * the target month (the 31st landing in February) clamps to that month's last day, exactly
 * the way warranty expiry dates already do (src/lib/warranty/expiry.ts).
 *
 * The anchor's own day-of-month/month-and-day is never itself re-derived from a previous
 * occurrence: every candidate is computed fresh from the ORIGINAL anchor plus a step count,
 * so a short-month clamp in one month (Jan 31 -> Feb 28) does not "stick" and drag the
 * following month's occurrence down to the 28th too (March is still the 31st).
 */
function nextOccurrence(anchor: string, today: string, stepMonths: number): string {
  let steps = Math.floor(monthsBetween(monthOf(anchor), monthOf(today)) / stepMonths);
  let candidate = addMonthsClamped(anchor, steps * stepMonths);
  while (candidate <= today) {
    steps += 1;
    candidate = addMonthsClamped(anchor, steps * stepMonths);
  }
  return candidate;
}

const RECURRING_KINDS = ['subscription', 'contract'] as const;

/**
 * Bills due within `days` of `today` (inclusive of the boundary day itself), sorted by dueDate
 * ascending. Two sources, one array:
 *
 *   1. the CADENCE half (unchanged since v1.7.0): subscription/contract items with a billing
 *      pair, walked forward from their anchor by nextOccurrence().
 *   2. v1.12.0, the SCHEDULE half: unpaid bill_installments rows on bill-kind items.
 *
 * `includeOverdue` defaults to FALSE, and safeToSpend() keeps that default deliberately. Its
 * billsDueCents answers "is what is left in my budget enough for what the rest of THIS MONTH
 * still owes"; folding in an installment from two years ago that nobody ever marked paid would
 * quietly and permanently distort that number, and it would do so most for the household that is
 * worst at housekeeping. The dashboard card, whose whole job is to surface the thing you forgot,
 * passes true.
 *
 * Overdue rows need no second sort key: their dates are earlier, so the existing ascending sort
 * already puts them first.
 */
export function upcomingBills(input: { today: string; days: number; includeOverdue?: boolean }): UpcomingBill[] {
  const { today, days } = input;
  const includeOverdue = input.includeOverdue ?? false;
  const windowEnd = addDaysIso(today, days);

  const rows = getDb()
    .select({
      itemId: warrantyItems.id,
      name: warrantyItems.name,
      kind: warrantyItemTypes.kind,
      billingCycle: warrantyItems.billingCycle,
      billingAmountCents: warrantyItems.billingAmountCents,
      purchaseDate: warrantyItems.purchaseDate,
    })
    .from(warrantyItems)
    // INNER, not LEFT: an untyped item (typeId NULL) normalises to kind 'warranty' elsewhere
    // (see warrantyItemTypes' doc comment / toItemRow in items.ts) and can never be a bill,
    // so it is correctly dropped by requiring a matching type row at all.
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(
      and(
        inArray(warrantyItemTypes.kind, RECURRING_KINDS),
        isNotNull(warrantyItems.billingCycle),
        // Defect fix: isNotNull alone let a billing amount of exactly 0 through as "set",
        // putting a $0.00 subscription in the Coming up list contributing nothing. gt(...,
        // 0) excludes both NULL and a zero (or negative) amount in one comparison, since SQL
        // evaluates `column > 0` as false/unknown, never true, for either.
        gt(warrantyItems.billingAmountCents, 0),
        or(isNull(warrantyItems.expiryDate), gte(warrantyItems.expiryDate, today)),
      ),
    )
    .all();

  const result: UpcomingBill[] = [];
  for (const row of rows) {
    // Narrowed by the query above: kind is 'subscription' | 'contract', billingCycle and
    // billingAmountCents are both non-null.
    const stepMonths = row.billingCycle === 'monthly' ? 1 : 12;
    const dueDate = nextOccurrence(row.purchaseDate, today, stepMonths);
    if (dueDate > windowEnd) continue;
    result.push({
      itemId: row.itemId,
      name: row.name,
      kind: row.kind as 'subscription' | 'contract',
      dueDate,
      amountCents: row.billingAmountCents as number,
      installmentId: null,
      overdue: false,
    });
  }

  for (const row of unpaidInstallments({ today, windowEnd, includeOverdue })) {
    result.push({
      itemId: row.itemId,
      name: row.itemName,
      kind: 'bill',
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      installmentId: row.installmentId,
      overdue: row.overdue,
    });
  }

  result.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return result;
}

/**
 * `budgetedRemainingCents`: what is left of every category that actually has a resolved
 * limit this month (same pair budgetTotals already exposes for the dashboard's own
 * "Spent this month" tile).
 *
 * `projectedSpendCents`: projectMonthEnd fed with the household's total spend so far this
 * month (budgetTotals' totalSpentCents -- every non-income category, budgeted or not, the
 * same total the dashboard headline already uses). Its null before day 7 of the month is
 * passed through untouched, per projectMonthEnd's own contract (src/lib/predict/pace.ts) --
 * this function never works around that guard.
 *
 * `billsDueCents`: every upcomingBills() occurrence landing on or before the END of `month`,
 * summed. Deliberately a DIFFERENT window than the dashboard card's own "next 30 days" list:
 * this is "what's left in the budget, minus what the month itself still owes", not a fixed
 * lookahead.
 */
export function safeToSpend(input: {
  month: string;
  today: string;
}): { budgetedRemainingCents: number; projectedSpendCents: number | null; billsDueCents: number } {
  const { month, today } = input;

  const totals = budgetTotals(budgetProgress(month));
  const budgetedRemainingCents = totals.budgetedLimitCents - totals.budgetedSpentCents;

  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd(month).slice(8, 10));
  const projectedSpendCents = projectMonthEnd({
    spentCents: totals.totalSpentCents,
    dayOfMonth,
    daysInMonth,
  });

  const daysUntilMonthEnd = daysBetweenIso(today, monthEnd(month));
  const billsDueCents = sumCents(upcomingBills({ today, days: daysUntilMonthEnd }).map((bill) => bill.amountCents));

  return { budgetedRemainingCents, projectedSpendCents, billsDueCents };
}
