import { budgetProgress, budgetTotals, resolveBudget } from '@/lib/budgets';
import { listCategories } from '@/lib/categories';
import { addMonths, currentMonth, monthEnd, monthStart, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, monthlyDigestKey, predictedVsActualKey, suggestedBudgetRefreshKey } from '@/lib/notify/events';
import { flattenBudgetRows } from '@/lib/notify/evaluate/pace';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent, type DigestLine, type PredictedLine, type RefreshLine } from '@/lib/notify/render';
import {
  MONTH_REPORT_DAY_MAX,
  MONTH_REPORT_MAX_LINES,
  SUGGEST_REFRESH_MIN_DELTA_CENTS,
  SUGGEST_REFRESH_MIN_DELTA_PCT,
} from '@/lib/predict/constants';
import { suggestionsFor } from '@/lib/predict/history';
import { cashflowTrend, topMerchants } from '@/lib/reports';

const MONTHLY_DIGEST_TOP_MERCHANTS = 5;

/**
 * The two month-boundary reports. Both run on the user's daily slot and both need no
 * fingerprint (MUST-10.8): the three-day window plus a monthly dedup key already bound them.
 *
 * MUST-9.35: both render BOTH scopes into one message per user, a household section and a
 * "Yours" section, which is why their keys carry only the month.
 */

interface ScopedPredicted {
  scope: 'household' | 'personal';
  line: PredictedLine;
}

/**
 * MUST-9.27 and spec D3: "predicted" is recomputed here as the suggestion the app WOULD have
 * produced for month M, from the six full calendar months ending the month before it. There is
 * no stored forecast, because storing one needs a table and MUST-1.4 rules that out.
 */
function comparePredicted(
  month: string,
  scope: 'household' | 'personal',
  userId: number | null,
): { lines: ScopedPredicted[]; totalDeltaCents: number } {
  const suggestions = suggestionsFor({ targetMonth: month, scope, userId }).byCategory;
  // The two sets coincide by construction: categorySeries mirrors budgetProgress row for row
  // (Task 2). The undefined guard below is belt and braces, not a real branch.
  const actual = new Map(flattenBudgetRows(budgetProgress(month, scope, userId)).map((row) => [row.categoryId, row]));

  const lines: ScopedPredicted[] = [];
  let totalDeltaCents = 0;
  for (const [categoryId, result] of suggestions) {
    if (!('suggestion' in result)) continue;
    const row = actual.get(categoryId);
    if (row === undefined) continue;
    const expectedCents = result.suggestion.suggestedCents;
    // MEDIUM fix: per MUST-4.10, suggestionsFor's rows include both a rolled top-level parent
    // and its non-archived children, so a child's spend is already counted once inside its
    // parent's row. Only top-level household rows contribute to the total, matching the
    // precedent budgetTotals() and the Reports baselines card already set for exactly this
    // reason. Personal spend is a strict subset of household spend, so it never contributes to
    // the total either (the caller uses household's total alone).
    if (scope === 'household' && row.parentId === null) {
      totalDeltaCents += row.spentCents - expectedCents;
    }
    lines.push({ scope, line: { name: row.categoryName, expectedCents, actualCents: row.spentCents } });
  }
  return { lines, totalDeltaCents };
}

function firePredictedVsActual(input: { userId: number; month: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'predicted_vs_actual', channel))) return 0;

  const household = comparePredicted(input.month, 'household', null);
  const personal = comparePredicted(input.month, 'personal', input.userId);
  const all = [...household.lines, ...personal.lines];
  // MUST-9.26: a category with a limit and no suggestion has no expected figure to compare
  // against, so no line, so nothing to send.
  if (all.length === 0) return 0;

  // MUST-9.30: at most MONTH_REPORT_MAX_LINES categories, chosen by the largest absolute
  // difference. The total line below still sums EVERY category with a suggestion.
  const shown = all
    .slice()
    .sort((a, b) => Math.abs(b.line.actualCents - b.line.expectedCents) - Math.abs(a.line.actualCents - a.line.expectedCents))
    .slice(0, MONTH_REPORT_MAX_LINES);

  const { subject, body } = renderEvent({
    event: 'predicted_vs_actual',
    month: input.month,
    household: shown.filter((entry) => entry.scope === 'household').map((entry) => entry.line),
    personal: shown.filter((entry) => entry.scope === 'personal').map((entry) => entry.line),
    // MEDIUM fix: household's total alone (top-level rows only, see comparePredicted). Adding
    // personal on top double-counted every attributed dollar, since personal spend is already
    // inside its household top-level row.
    totalDeltaCents: household.totalDeltaCents,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'predicted_vs_actual',
    dedupKey: predictedVsActualKey(input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.31: a category counts as changed when its suggestion differs from the limit resolved
 * for that month by at least 10 percent AND at least $10. A category with no resolved limit
 * counts as a difference when it has a suggestion at all.
 */
function refreshFor(month: string, scope: 'household' | 'personal', userId: number | null): RefreshLine[] {
  const names = new Map(listCategories({ includeArchived: true }).map((category) => [category.id, category.name]));
  const out: RefreshLine[] = [];
  for (const [categoryId, result] of suggestionsFor({ targetMonth: month, scope, userId }).byCategory) {
    if (!('suggestion' in result)) continue;
    const nowCents = result.suggestion.suggestedCents;
    const wasCents = resolveBudget(scope, userId, categoryId, month);
    if (wasCents !== null) {
      const delta = Math.abs(nowCents - wasCents);
      if (delta * 100 < Math.abs(wasCents) * SUGGEST_REFRESH_MIN_DELTA_PCT) continue;
      if (delta < SUGGEST_REFRESH_MIN_DELTA_CENTS) continue;
    }
    out.push({ name: names.get(categoryId) ?? String(categoryId), nowCents, wasCents });
  }
  return out.sort((a, b) => Math.abs(b.nowCents - (b.wasCents ?? 0)) - Math.abs(a.nowCents - (a.wasCents ?? 0)));
}

function fireSuggestedRefresh(input: { userId: number; month: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'suggested_budget_refresh', channel))) return 0;

  const household = refreshFor(input.month, 'household', null);
  const personal = refreshFor(input.month, 'personal', input.userId);
  const changedCount = household.length + personal.length;
  if (changedCount === 0) return 0;

  const { subject, body } = renderEvent({
    event: 'suggested_budget_refresh',
    month: input.month,
    household: household.slice(0, MONTH_REPORT_MAX_LINES),
    personal: personal.slice(0, Math.max(0, MONTH_REPORT_MAX_LINES - Math.min(household.length, MONTH_REPORT_MAX_LINES))),
    changedCount,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'suggested_budget_refresh',
    dedupKey: suggestedBudgetRefreshKey(input.month),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * Design ruling 10 (v1.7.0): the monthly household digest, sharing this same first-3-days
 * window and reporting the month that JUST ENDED, same as firePredictedVsActual above --
 * `endedMonth` is computed once in evaluateMonthBoundary and passed to both.
 *
 * Composed ENTIRELY from existing report/budget helpers (Task 16): cashflowTrend for the
 * closed month's income/spend/net, budgetTotals(budgetProgress(month)) for the budgeted pair
 * (limitCents there is already the rollover-EFFECTIVE limit as of commit 3538d91, which is
 * exactly the number the Budgets page shows), and topMerchants for the merchant lines. No new
 * aggregate query is written here.
 */
function fireMonthlyDigest(input: { userId: number; endedMonth: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'monthly_digest', channel))) return 0;

  // cashflowTrend(1, {endMonth}) always returns exactly one row, for endedMonth itself.
  const [trend] = cashflowTrend(1, { endMonth: input.endedMonth });
  const totals = budgetTotals(budgetProgress(input.endedMonth));
  const topMerchantLines: DigestLine[] = topMerchants({
    from: monthStart(input.endedMonth),
    to: monthEnd(input.endedMonth),
    limit: MONTHLY_DIGEST_TOP_MERCHANTS,
  }).map((row) => ({ name: row.normalizedMerchant, cents: row.spentCents }));

  const { subject, body } = renderEvent({
    event: 'monthly_digest',
    month: input.endedMonth,
    incomeCents: trend.incomeCents,
    spendCents: trend.spendCents,
    netCents: trend.netCents,
    budgetedLimitCents: totals.budgetedLimitCents,
    budgetedSpentCents: totals.budgetedSpentCents,
    topMerchants: topMerchantLines,
  });

  const result = enqueue({
    userId: input.userId,
    eventId: 'monthly_digest',
    dedupKey: monthlyDigestKey(input.endedMonth),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}

/**
 * MUST-9.26 and MUST-9.31: the three-day window exists so a container switched off on the 1st
 * still delivers on the 2nd or 3rd, on top of the daily slot's own 12-hour catch-up. Each
 * event's monthly key makes the second and third day a no-op.
 */
export function evaluateMonthBoundary(input: { userId: number; now: Date; tz: string }): number {
  const today = todayIso(input.now, input.tz);
  if (Number(today.slice(8, 10)) > MONTH_REPORT_DAY_MAX) return 0;

  const target = currentMonth(input.now, input.tz);
  const endedMonth = addMonths(target, -1);
  let fired = 0;
  fired += firePredictedVsActual({ userId: input.userId, month: endedMonth, now: input.now });
  fired += fireSuggestedRefresh({ userId: input.userId, month: target, now: input.now });
  fired += fireMonthlyDigest({ userId: input.userId, endedMonth, now: input.now });
  return fired;
}
