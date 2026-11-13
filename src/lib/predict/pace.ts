import { divRound, medianCents } from '@/lib/predict/stats';

/**
 * The month check-in, PURE (MUST-2.1). Integers in, one integer out.
 *
 * v1.62.0 replaces the straight-line pace (spent so far scaled across the whole month) with
 * three parts a household can check one by one:
 *
 *   spent so far + bills and marked recurring charges still due this month + the usual spending
 *   for the rest of the month
 *
 * The last part is DAY-ALIGNED: each `history` entry is what was spent after today's day of the
 * month in one of the last full months (restOfMonthSpend, src/lib/predict/history.ts), with the
 * days that stretch had. A payment that always lands early in the month (rent on the 1st) is in
 * none of those stretches, so it adds nothing for the rest of this one.
 *
 * It is the MEDIAN of the months, each scaled to the days left, not a pooled mean: a one-off
 * purchase or an annual bill in one of three months would otherwise add a third of itself to the
 * figure for three months running.
 *
 * Rulings this supersedes and keeps:
 *   - supersedes MUST-8.4 for display: there is no day-7 floor on the page. The pace alert keeps
 *     its own floor (PACE_MIN_DAY_OF_MONTH, MUST-9.6 condition 1).
 *   - supersedes MUST-8.6: the figure now has a known-upcoming term (what is still due).
 *   - supersedes MUST-16.4: the check-in reads its own history, so it is no longer free.
 *   - keeps MUST-8.3: today counts as elapsed, so `daysLeft` is daysInMonth - dayOfMonth and the
 *     last day of the month is spent plus due.
 *   - keeps MUST-8.5: spend below zero (a net-refunded month so far) counts as zero, and so does
 *     a net-refunded history month.
 *   - keeps MUST-8.7: `spentCents` is the figure already on screen beside it.
 */

/** One past month's stretch after today's day of the month. */
export interface HistoryStretch {
  cents: number;
  /** len(month) - dayOfMonth, or 0 when that month was shorter than today's day. */
  days: number;
}

/**
 * The usual rest of the month: the median over the history months of each month's spend after
 * the day, scaled to the days left. Null when no month reached this far into a month (no full
 * month of history yet): there is no straight-line fallback, since a guess from the days so far
 * is the figure this release removed.
 */
export function everydayCents(input: { history: readonly HistoryStretch[]; daysLeft: number }): number | null {
  if (input.daysLeft <= 0) return 0;
  const scaled = input.history
    .filter((month) => month.days > 0)
    .map((month) => divRound(Math.max(month.cents, 0) * input.daysLeft, month.days));
  return medianCents(scaled);
}

export function checkInMonthEnd(input: {
  spentCents: number;
  /** Bills and marked recurring charges still due before the month ends. */
  dueCents: number;
  /** Day-aligned history, one entry per full month read. */
  history: readonly HistoryStretch[];
  /** daysInMonth - dayOfMonth, 0 on the last day. */
  daysLeft: number;
}): number | null {
  const everyday = everydayCents({ history: input.history, daysLeft: input.daysLeft });
  if (everyday === null) return null;
  return Math.max(input.spentCents, 0) + input.dueCents + everyday;
}
