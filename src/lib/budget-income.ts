import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addMonths } from '@/lib/dates';
import { cashflowTrend, trimLeadingEmptyMonths } from '@/lib/reports';

/** How many complete calendar months typical income averages. */
export const TYPICAL_INCOME_MONTHS = 3;

/**
 * v1.59.0 (Budgets income line). The month's money in, spending and net, beside typical income
 * and how far this month's budgets run past it.
 *
 * No new query: every figure is the Dashboard's own Money in / Spent / Net source, `cashflowTrend`
 * (src/lib/reports.ts), so the two pages can never disagree for the same month and scope. Calendar
 * months throughout, as the Dashboard uses: there is no household period start day.
 */
export interface BudgetIncomeLine {
  month: string;
  /** The scope these figures were read for, after a self viewer's own id has won: null is the household. */
  attributedUserId: number | null;
  incomeCents: number;
  spendCents: number;
  netCents: number;
  /** The complete calendar months typical income reads, oldest first. Never the current month. */
  typicalMonths: string[];
  /** Average income over `typicalMonths`; null until history covers all of them. */
  typicalIncomeCents: number | null;
  budgetedLimitCents: number;
  /** Budgeted minus typical, when typical is above zero and the budgets exceed it; otherwise null. */
  overTypicalByCents: number | null;
  /**
   * Owner decision 4: a person's line with no income attributed to them in `typicalMonths`. There
   * is no fallback to household income, so the page points at person rules instead. Always false
   * for the household.
   */
  noAttributedIncome: boolean;
}

export function budgetIncomeLine(
  input: { month: string; currentMonth: string; attributedUserId: number | null; budgetedLimitCents: number },
  viewer: Viewer,
): BudgetIncomeLine {
  // cashflowTrend applies this same rule inside; it is resolved here too because whether the line
  // is a person's decides the no-income hint, and a self viewer's line is always their own.
  const scope = ownerScope(viewer) ?? input.attributedUserId;
  const own = cashflowTrend(1, { endMonth: input.month, attributedUserId: scope }, viewer)[0];

  // The last complete month before the viewed one, and never later than the one before today's:
  // a future month's typical income is still the last three months that actually finished.
  const latest = input.month < input.currentMonth ? input.month : input.currentMonth;
  const window = cashflowTrend(TYPICAL_INCOME_MONTHS, { endMonth: addMonths(latest, -1), attributedUserId: scope }, viewer);
  // The trim drops only months before this scope's first transaction (see its own docblock), so a
  // full window is three months that really happened, quiet or not.
  const covered = trimLeadingEmptyMonths(window).length === TYPICAL_INCOME_MONTHS;
  const windowIncomeCents = window.reduce((sum, row) => sum + row.incomeCents, 0);
  const typicalIncomeCents = covered ? Math.round(windowIncomeCents / TYPICAL_INCOME_MONTHS) : null;

  const overTypicalByCents =
    typicalIncomeCents !== null && typicalIncomeCents > 0 && input.budgetedLimitCents > typicalIncomeCents
      ? input.budgetedLimitCents - typicalIncomeCents
      : null;

  return {
    month: input.month,
    attributedUserId: scope,
    incomeCents: own?.incomeCents ?? 0,
    spendCents: own?.spendCents ?? 0,
    netCents: own?.netCents ?? 0,
    typicalMonths: window.map((row) => row.month),
    typicalIncomeCents,
    budgetedLimitCents: input.budgetedLimitCents,
    overTypicalByCents,
    noAttributedIncome: scope !== null && window.every((row) => row.incomeCents === 0),
  };
}
