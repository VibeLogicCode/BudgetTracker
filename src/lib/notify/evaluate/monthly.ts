import { budgetProgress, budgetTotals, resolveBudget, type BudgetScope } from '@/lib/budgets';
import { viewerFor } from '@/lib/auth/users';
import { HOUSEHOLD_VIEWER, isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { addMonths, currentMonth, monthEnd, monthStart, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, monthlyDigestKey, predictedVsActualKey, suggestedBudgetRefreshKey } from '@/lib/notify/events';
import { flattenBudgetRows } from '@/lib/notify/evaluate/pace';
import { householdRoutedChannels } from '@/lib/notify/household';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
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
 * "Yours" section, which is why their keys carry only the month. S-18 fix (ruling R2): for a
 * self-scoped recipient the household section is omitted from THEIR OWN message -- see each
 * function's own S-18 comment below -- so what lands in their inbox carries "Yours" alone.
 *
 * Finding I-1 (v1.30.0 whole-branch review): all three functions below therefore render TWICE
 * whenever the event is routed to a family channel -- once for the recipient, once for the room --
 * and pass the second as enqueue's `household` override. Leaving it to enqueue's fallback (which
 * copies `subject`/`body` verbatim into the user_id NULL row) is what the S-18 round-1 narrowing
 * turned into a defect: the first member to evaluate wrote the family row, so the room read
 * whichever member's message happened to land first -- a self-scoped member's personal figures
 * presented as the household's, or a household member's "Yours" block addressed to a room -- and
 * every later member hit onConflictDoNothing, deduping the correct household message away for the
 * month. The household read is skipped only when it has NO audience: unrouted AND the recipient
 * self-scoped (evaluate/digest.ts's own ordering, its review round 1 minor 4).
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

/**
 * One renderer for both audiences (finding I-1), because the two messages differ ONLY in which
 * lines they are given: the recipient's own carries a Household block and a "Yours" block, the
 * family channel's carries household lines alone (nothing scoped 'personal' is ever passed to it,
 * so render.ts emits no "Yours" heading at all). Sorting and the MONTH_REPORT_MAX_LINES cap have
 * to happen per audience -- the room's eight biggest household differences are not the eight
 * biggest of one member's household+personal mix -- so this is a function rather than one `shown`
 * computed once and filtered twice.
 */
function renderPredicted(
  month: string,
  entries: ScopedPredicted[],
  totalDeltaCents: number | null,
): { subject: string; body: string } {
  // MUST-9.30: at most MONTH_REPORT_MAX_LINES categories, chosen by the largest absolute
  // difference. The total line still sums EVERY household category with a suggestion.
  const shown = entries
    .slice()
    .sort((a, b) => Math.abs(b.line.actualCents - b.line.expectedCents) - Math.abs(a.line.actualCents - a.line.expectedCents))
    .slice(0, MONTH_REPORT_MAX_LINES);
  return renderEvent({
    event: 'predicted_vs_actual',
    month,
    household: shown.filter((entry) => entry.scope === 'household').map((entry) => entry.line),
    personal: shown.filter((entry) => entry.scope === 'personal').map((entry) => entry.line),
    totalDeltaCents,
  });
}

function firePredictedVsActual(input: { userId: number; month: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'predicted_vs_actual', channel))) return 0;

  const viewer = viewerFor(input.userId);
  // Item BK: 0 already means "nothing enqueued" to every caller of this function.
  if (viewer === null) return 0;

  const selfScoped = isSelfScoped(viewer);
  // Resolved BEFORE the household read, not after it -- evaluate/digest.ts's review round 1
  // minor 4, for the identical reason: it is the one thing that decides whether the read below
  // has any audience at all for a self-scoped recipient.
  const routed = householdRoutedChannels('predicted_vs_actual');
  // The TRUE household comparison, byte-identical to what this function computed for every
  // recipient before the S-18 fix. Finding I-1: it is what the family-channel message is built
  // from, so it is skipped only when nobody could read it -- a self-scoped recipient whose
  // household has routed this event nowhere. That is HOUSEHOLD_ONLY_AT_PAGE's own rule for
  // budgetProgress's non-page callers (tests/ops/visibility-invariants.test.ts): skip the call
  // outright, or run it and deliver it to the family channel alone. Never run it and discard it.
  const household = selfScoped && routed.length === 0 ? null : comparePredicted(input.month, 'household', null);
  // S-18 fix (v1.13.0 ruling R2), unchanged by I-1: what the RECIPIENT's own message may carry.
  // A self-scoped recipient's own message has no Household block whether or not the read above
  // ran. `personal` is unaffected either way: it is this recipient's OWN comparison, computed the
  // same for every recipient regardless of visibility.
  const ownHousehold = selfScoped ? null : household;
  const personal = comparePredicted(input.month, 'personal', input.userId);
  const own = [...(ownHousehold?.lines ?? []), ...personal.lines];
  const family = routed.length === 0 ? [] : (household?.lines ?? []);
  // MUST-9.26: a category with a limit and no suggestion has no expected figure to compare
  // against, so no line, so nothing to send. Finding I-1 widens "nothing to send" from the
  // recipient's own lines to both audiences': a self-scoped member with no attributed spend has
  // an empty message of their own but still contributes the room's, and returning 0 here was one
  // more way for the family row to depend on which member evaluated first.
  if (own.length === 0 && family.length === 0) return 0;

  // MEDIUM fix: household's total alone (top-level rows only, see comparePredicted). Adding
  // personal on top double-counted every attributed dollar, since personal spend is already
  // inside its household top-level row.
  // S-18 fix, round 1: NULL for a self-scoped recipient, so render.ts drops the sentence
  // instead of asserting a total. Round 0 passed 0 here and reused the branch a household with
  // no suggested top-level category already takes -- but those two zeros mean different things:
  // that one is vacuously true, this one told the recipient the household came in $0.00 over
  // when it was really $113.40 over. There is no per-person analogue of "every household
  // category" to substitute (comparePredicted's totalDeltaCents accumulator is deliberately
  // household-only; see its doc comment above), and this recipient's message correctly has no
  // Household block, so the honest render is no sentence at all.
  const { subject, body } = renderPredicted(input.month, own, ownHousehold?.totalDeltaCents ?? null);
  const result = enqueue({
    userId: input.userId,
    eventId: 'predicted_vs_actual',
    dedupKey: predictedVsActualKey(input.month),
    subject,
    body,
    // Finding I-1. The family channel gets the household comparison and its true total, never
    // this recipient's copy: enqueue's fallback would put a self-scoped member's "Yours"-only
    // message (or a household member's own "Yours" block) under user_id NULL and dedup the real
    // one away for the month. The room's totalDeltaCents is non-null by construction here --
    // `family` is non-empty only when the household read ran.
    household: family.length === 0 ? undefined : renderPredicted(input.month, family, household?.totalDeltaCents ?? null),
    // A recipient whose own message came out empty still contributes the family row, and must
    // not be sent a header with no lines under it on the channels the room did not take. Only
    // ever true for a self-scoped recipient: for anyone else `own` is a superset of `family`, so
    // an empty `own` means an empty `family` and the guard above already returned.
    familyChannelOnly: own.length === 0,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
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

  const viewer = viewerFor(input.userId);
  // Item BK: 0 already means "nothing enqueued" to every caller of this function.
  if (viewer === null) return 0;

  const selfScoped = isSelfScoped(viewer);
  // Resolved before the household read, as in firePredictedVsActual above and for the same
  // reason (evaluate/digest.ts, review round 1 minor 4).
  const routed = householdRoutedChannels('suggested_budget_refresh');
  // The TRUE household refresh list -- what the family channel's message is built from (finding
  // I-1), and byte-identical to what every recipient's message carried before the S-18 fix. Run
  // unless it has no audience at all: a self-scoped recipient in a household that has routed this
  // event nowhere. Never run and discarded.
  const household = selfScoped && routed.length === 0 ? [] : refreshFor(input.month, 'household', null);
  // S-18 fix (v1.13.0 ruling R2), unchanged by I-1: a self-scoped recipient's OWN message carries
  // no household list whether or not the read above ran. `personal` is unaffected: it is this
  // recipient's own suggestions, computed the same for every recipient regardless of visibility.
  const ownHousehold = selfScoped ? [] : household;
  const personal = refreshFor(input.month, 'personal', input.userId);
  // Honest for each audience separately: this one counts only what THIS recipient's message
  // actually carries, and the family channel's count below only what the room's carries. One
  // shared count would put the recipient's personal changes in the room's subject line.
  const changedCount = ownHousehold.length + personal.length;
  const family = routed.length === 0 ? [] : household;
  // Finding I-1, as in firePredictedVsActual: a self-scoped member with no personal suggestions
  // of their own still contributes the room's message, so "nothing changed" is asked of both
  // audiences rather than of the recipient alone.
  if (changedCount === 0 && family.length === 0) return 0;

  const { subject, body } = renderEvent({
    event: 'suggested_budget_refresh',
    month: input.month,
    household: ownHousehold.slice(0, MONTH_REPORT_MAX_LINES),
    personal: personal.slice(0, Math.max(0, MONTH_REPORT_MAX_LINES - Math.min(ownHousehold.length, MONTH_REPORT_MAX_LINES))),
    changedCount,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'suggested_budget_refresh',
    dedupKey: suggestedBudgetRefreshKey(input.month),
    subject,
    body,
    // Finding I-1. Passed explicitly rather than left to enqueue's fallback, which would copy
    // this recipient's message into the user_id NULL row: for a self-scoped member that is a
    // "Yours" list with no household section, and for anybody else it is a household list with
    // that member's personal one appended -- neither is the room's message, and whichever member
    // evaluated first would decide which of them the room read for the month.
    household:
      family.length === 0
        ? undefined
        : renderEvent({
            event: 'suggested_budget_refresh',
            month: input.month,
            household: family.slice(0, MONTH_REPORT_MAX_LINES),
            personal: [],
            changedCount: family.length,
          }),
    // As in firePredictedVsActual: only ever true for a self-scoped recipient whose own message
    // came out empty, and it withholds a subject line reading "0 suggested budgets changed" on
    // the channels the family channel did not take.
    familyChannelOnly: changedCount === 0,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
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
 *
 * S-18 fix (v1.13.0 ruling R2): unlike cashflowTrend/topMerchants just above, budgetTotals(
 * budgetProgress(...)) took no viewer at all and always read household scope, so this was the
 * one figure in this message that stayed household-wide for every recipient regardless of
 * visibility. There is no separate "Yours" budgets line in this digest's render (renderEvent's
 * monthly_digest case has exactly one budgetedLimitCents/budgetedSpentCents pair, not a
 * household/personal split the way predicted_vs_actual and suggested_budget_refresh have), so
 * dropping the figure for a self-scoped recipient would have meant losing the whole "Budgets:"
 * line rather than narrowing it -- the section IS the household read, but it also has an exact
 * personal equivalent one call away. The fix picks the scope from the viewer instead: 'personal'
 * (their own budgeted limit vs their own spend) for a self-scoped recipient, 'household' (this
 * line's original call, byte-identical) for everyone else.
 *
 * Finding I-1: those three reads and the render now live in renderMonthlyDigestFor below, called
 * once per audience -- with this recipient's viewer for their own copy, with HOUSEHOLD_VIEWER for
 * the family channel's -- so the paragraph above describes that helper, not this function.
 */
function fireMonthlyDigest(input: { userId: number; endedMonth: string; now: Date }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'monthly_digest', channel))) return 0;

  const viewer = viewerFor(input.userId);
  // Item BK: 0 already means "no outbox row was enqueued" to every caller of this function.
  if (viewer === null) return 0;
  const { subject, body } = renderMonthlyDigestFor(input.endedMonth, viewer);

  const result = enqueue({
    userId: input.userId,
    eventId: 'monthly_digest',
    dedupKey: monthlyDigestKey(input.endedMonth),
    subject,
    body,
    // Finding I-1, and the plainest of the three: EVERY figure in this message is viewer-scoped
    // (cashflowTrend and topMerchants take the viewer; the S-18 fix above swapped the budgeted
    // pair to personal scope for a self-scoped recipient), so enqueue's fallback put one member's
    // narrowed digest end to end -- "Budgets: $150.00 of $200.00" where the household is $600 of
    // $500 -- under user_id NULL, and deduped the household's own digest away for the month.
    // Rendered through HOUSEHOLD_VIEWER instead of reusing this recipient's render even when the
    // two would agree (they do for a household-visibility recipient, whose ownerScope is null):
    // the room's message must not depend on who evaluated first, and a pass-through would break
    // silently the day this digest gains a per-recipient section the way the two reports above
    // already have.
    household: householdRoutedChannels('monthly_digest').length === 0 ? undefined : renderMonthlyDigestFor(input.endedMonth, HOUSEHOLD_VIEWER),
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * The digest as ONE viewer reads it -- the recipient for their own copy, HOUSEHOLD_VIEWER for the
 * family channel's (finding I-1). Every read here already took a viewer except the budgeted pair,
 * whose scope is derived from that same viewer on the line below, so the two renders differ in
 * exactly one argument and there is nothing left in this function that can quietly stay
 * household-wide for a self-scoped recipient.
 *
 * HOUSEHOLD_VIEWER is imported from src/lib/auth/viewer.ts rather than rebuilt here (v1.31.0
 * item M-1 moved it there from evaluate/digest.ts, which is where the argument for why a
 * synthetic household-scoped viewer is the right thing to render a ROOM's message with still
 * lives, above buildHouseholdDigest). A hand-built copy of a security-relevant viewer with
 * nothing tying it to that argument is the shape item M-1 exists to stop, and
 * tests/ops/viewer-construction.test.ts now does stop it.
 */
function renderMonthlyDigestFor(endedMonth: string, viewer: Viewer): { subject: string; body: string } {
  // cashflowTrend(1, {endMonth}) always returns exactly one row, for endedMonth itself.
  const [trend] = cashflowTrend(1, { endMonth: endedMonth }, viewer);
  const totalsScope: BudgetScope = isSelfScoped(viewer) ? 'personal' : 'household';
  const totals = budgetTotals(budgetProgress(endedMonth, totalsScope, totalsScope === 'personal' ? viewer.id : null));
  const topMerchantLines: DigestLine[] = topMerchants(
    {
      from: monthStart(endedMonth),
      to: monthEnd(endedMonth),
      limit: MONTHLY_DIGEST_TOP_MERCHANTS,
    },
    viewer,
  ).map((row) => ({ name: row.normalizedMerchant, cents: row.spentCents }));

  return renderEvent({
    event: 'monthly_digest',
    month: endedMonth,
    incomeCents: trend.incomeCents,
    spendCents: trend.spendCents,
    netCents: trend.netCents,
    budgetedLimitCents: totals.budgetedLimitCents,
    budgetedSpentCents: totals.budgetedSpentCents,
    topMerchants: topMerchantLines,
  });
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
