import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { addMonths, currentMonth, monthEnd, todayIso } from '@/lib/dates';
import { isEventEnabled, notifiableUsers } from '@/lib/notify/config';
import { CHANNELS, savingsMonthClosedKey, savingsTargetMetKey, savingsTargetPaceKey } from '@/lib/notify/events';
import { householdRoutedChannels } from '@/lib/notify/household';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { MONTH_REPORT_DAY_MAX, PACE_MIN_DAY_OF_MONTH } from '@/lib/predict/constants';
import { savingsProgress, savingsStreak } from '@/lib/savings-target';

/**
 * Lane 2, spec docs/superpowers/plans/2026-08-30-savings-targets.md, rulings T1/T1a/T3/T5.
 *
 * Ruling T3: a savings target is household-scoped only, never per-person, so every evaluator
 * below reads the SAME pooled figure for every recipient rather than re-scoping per viewer the
 * way the monthly digest's household/personal split does (evaluate/monthly.ts's viewerFor).
 * `id: 0` on the placeholder viewer is never read: ownerScope (src/lib/auth/viewer.ts) resolves
 * visibility 'household' to "no restriction" without consulting it, the same placeholder shape
 * src/lib/loans.ts's loansTotalOwedCents() already uses for an identical whole-household total.
 *
 * S-18 fix, round 1 (v1.13.0 ruling R2, new scope): T3 justifies the READ SHAPE above and says
 * nothing about DELIVERY. Every send below carried the household's netCents and targetCents to
 * every notifiable user, self-scoped members -- a household uses self scope for a child's
 * account -- included; that is R2's leak, structurally identical to the one closed in
 * evaluate/budget.ts and evaluate/pace.ts, and the original sweep missed this file because it
 * uses none of the six symbols that sweep grepped for.
 *
 * All three events are householdEligible (events.ts), so the fix is round 1's distinction, not
 * round 0's: a FAMILY-CHANNEL send is fine -- one message to a room an admin deliberately
 * pointed the household's bot at -- and a PER-USER send carrying these figures to a self-scoped
 * member is not. Withheld by enqueue's familyChannelOnly at each of the three call sites. A
 * savings target has NO personal analogue (T3 again: there is no per-person target to substitute
 * the way evaluate/monthly.ts's Budgets line substitutes personal budget totals), so for a
 * self-scoped recipient the answer is to omit the personal send entirely rather than scope it to
 * zero -- a "$0.00 target" sentence would be a false statement about household state, not a
 * narrowed one.
 *
 * Every arithmetic decision -- what "saved" means, how a percent target resolves, what "met"
 * means, what the streak is -- comes from src/lib/savings-target.ts's savingsProgress/
 * savingsStreak. Ruling T1 forbids a second definition of any of that anywhere in this release,
 * so nothing here recomputes income, spend, net, or the streak; this file only decides WHEN to
 * fire and renders what savingsProgress/savingsStreak already computed.
 */
const HOUSEHOLD_WIDE: Viewer = { id: 0, role: 'admin', visibility: 'household' };

/**
 * Every notifiable user with at least one channel enabled for `eventId`, each carrying the one
 * fact the send below has to know about them. isSelfScoped() itself rather than a second copy of
 * its rule: Viewer is structural, so a NotifiableUser projects straight onto it, and the admin
 * clause (a hand-edited row must not lock a self-scoped reading onto an admin) stays in one place.
 */
function participantsFor(eventId: string): { userId: number; selfScoped: boolean }[] {
  return notifiableUsers()
    .filter((user) => CHANNELS.some((channel) => isEventEnabled(user.id, eventId, channel)))
    .map((user) => ({
      userId: user.id,
      selfScoped: isSelfScoped({ id: user.id, role: user.role, visibility: user.visibility }),
    }));
}

/**
 * The recipient's own scope, for the two per-user sends below. Its own local copy, matching the
 * shape evaluate/digest.ts, evaluate/pace.ts and evaluate/monthly.ts each already carry -- see
 * digest.ts's viewerFor docblock for the fuller argument; none of the four exports its internals
 * as test-only surface for the others.
 *
 * Returns null when the recipient's row is gone by the time this runs (a deleted account
 * mid-batch): item BK's precedent, sending nothing rather than guessing a scope.
 */
function viewerFor(userId: number): Viewer | null {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : null;
}

/**
 * `savings_target_met` (tick trigger). No fingerprint cache the way evaluateBudgets'/
 * evaluateAnomalies' guard their own every-five-minute tick (MUST-6.18/MUST-10.4): those exist
 * to skip a WHOLE-TABLE scan on a tick that changed nothing, while savingsProgress reads one
 * month's already-indexed range -- the same cost budget_pace accepts uncached for its own
 * daily-slot events (evaluate/pace.ts's MUST-10.8 comment: the dedup key already makes a
 * redundant evaluation a no-op, so a cache would only save a cheap read, not correctness).
 *
 * Fires ONCE per month, ever: the dedup key carries only the month (savingsTargetMetKey), so
 * the first tick after net first reaches the target inserts a row and every later tick this
 * month -- even as net keeps climbing -- is a no-op. A month with no resolved target (no target
 * set at all, or a percent target with no income to apply to -- src/lib/savings-target.ts keeps
 * `met` false in both cases) never fires: never nag a household about a target it never agreed
 * to, or one the app itself could not resolve.
 */
export function evaluateSavingsTargetMet(input: { now: Date; tz: string }): number {
  const participants = participantsFor('savings_target_met');
  if (participants.length === 0) return 0;

  const month = currentMonth(input.now, input.tz);
  const progress = savingsProgress(month, HOUSEHOLD_WIDE);
  if (progress.targetCents === null || !progress.met) return 0;

  // One render, shared across every recipient: ruling T3 means there is no per-person figure
  // to personalise the way the monthly digest's "Yours" section does.
  const { subject, body } = renderEvent({
    event: 'savings_target_met',
    month,
    netCents: progress.netCents,
    targetCents: progress.targetCents,
  });

  let fired = 0;
  for (const participant of participants) {
    const result = enqueue({
      userId: participant.userId,
      eventId: 'savings_target_met',
      dedupKey: savingsTargetMetKey(month),
      subject,
      body,
      // S-18 round 1: a self-scoped participant still feeds the family channel -- the routed row
      // is the room's message, addressed to nobody -- but never receives a personal copy of the
      // household's net and target. The progress read above stays unconditional because it is
      // computed ONCE for the whole household and every household-visibility participant needs
      // it; it is the delivery, not the read, that this fix gates.
      familyChannelOnly: participant.selfScoped,
      at: input.now,
    });
    if (enqueuedAnything(result)) fired += 1;
  }
  return fired;
}

/**
 * `savings_target_pace` (daily_slot trigger, ruling T5). Compares net-so-far against the target
 * PRO-RATED to today's day of the month (`targetCents * dayOfMonth / daysInMonth`), rather than
 * projecting net to a month-end total the way budget_pace projects spend forward: T5 exists
 * because a percent target is provisional until the month closes, so the honest question this
 * asks is "are we behind the straight-line pace so far", not "where will we land" -- projecting
 * an early-month net (which is often lumpy around payday) to a full month would read as far more
 * confident than the number actually is.
 *
 * Reuses PACE_MIN_DAY_OF_MONTH (day 7) rather than a second constant meaning the same thing:
 * budget_pace's own reasoning -- a three-day sample says nothing -- applies verbatim to a
 * savings target, so this is the same floor, not a new one (predict/constants.ts's own
 * constants-discipline rule).
 *
 * Fires ONCE per month, ever (dedup key carries only the month): the first daily slot at or
 * after day 7 on which net-so-far falls short of the pro-rated target, and never again that
 * month even if the shortfall later narrows or widens -- the same "never re-alert on a moving
 * projection" rule budgetPaceKey documents.
 */
function fireSavingsPace(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'savings_target_pace', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const dayOfMonth = Number(today.slice(8, 10));
  if (dayOfMonth < PACE_MIN_DAY_OF_MONTH) return 0;

  const viewer = viewerFor(input.userId);
  // Item BK precedent: 0 already means "nothing enqueued" to every caller.
  if (viewer === null) return 0;
  const selfScoped = isSelfScoped(viewer);
  // S-18 round 1: for a self-scoped recipient this send exists ONLY to feed the family channel,
  // so with no routed channel there is no room to feed -- the household read is skipped outright
  // rather than run and discarded, the same routed-first ordering evaluate/digest.ts uses.
  if (selfScoped && householdRoutedChannels('savings_target_pace').length === 0) return 0;

  const month = currentMonth(input.now, input.tz);
  // From monthEnd, so February is 29 days in a leap year without a leap-year rule here --
  // the same reasoning evaluate/pace.ts's own daysInMonth line documents.
  const daysInMonth = Number(monthEnd(month).slice(8, 10));
  const progress = savingsProgress(month, HOUSEHOLD_WIDE);
  if (progress.targetCents === null) return 0;

  const proRatedTargetCents = Math.round((progress.targetCents * dayOfMonth) / daysInMonth);
  if (progress.netCents >= proRatedTargetCents) return 0;

  const { subject, body } = renderEvent({
    event: 'savings_target_pace',
    month,
    dayOfMonth,
    netCents: progress.netCents,
    targetCents: progress.targetCents,
    proRatedTargetCents,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'savings_target_pace',
    dedupKey: savingsTargetPaceKey(month),
    subject,
    body,
    familyChannelOnly: selfScoped,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * `savings_month_closed` (daily_slot trigger). Reports the month that just ended, fires on the
 * first daily slot at or before MONTH_REPORT_DAY_MAX of the new month (the same three-day
 * catch-up window evaluate/monthly.ts's evaluateMonthBoundary uses, for the identical reason: a
 * container that is off through day 1 must not silently skip the whole month's savings report
 * until next month), and is keyed once per closed month, ever -- days 2 and 3 are a no-op once
 * day 1 has already fired.
 *
 * Carries the streak from savingsStreak so "third month running" -- the sentence the Lane 2
 * plan says is worth sending -- reaches the renderer already computed; render.ts's own wording
 * rule only mentions it once the streak is 2 or more, since one month alone is noise.
 */
function fireSavingsMonthClosed(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'savings_month_closed', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  if (Number(today.slice(8, 10)) > MONTH_REPORT_DAY_MAX) return 0;

  const viewer = viewerFor(input.userId);
  // Item BK precedent: 0 already means "nothing enqueued" to every caller.
  if (viewer === null) return 0;
  const selfScoped = isSelfScoped(viewer);
  // S-18 round 1, as in fireSavingsPace above: nothing routed means no room to feed, so neither
  // the closed month's progress nor its streak is read for a self-scoped recipient at all.
  if (selfScoped && householdRoutedChannels('savings_month_closed').length === 0) return 0;

  const closedMonth = addMonths(currentMonth(input.now, input.tz), -1);
  const progress = savingsProgress(closedMonth, HOUSEHOLD_WIDE);
  if (progress.targetCents === null) return 0;

  const streak = savingsStreak(closedMonth, HOUSEHOLD_WIDE);
  const { subject, body } = renderEvent({
    event: 'savings_month_closed',
    month: closedMonth,
    netCents: progress.netCents,
    targetCents: progress.targetCents,
    met: progress.met,
    streak,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'savings_month_closed',
    dedupKey: savingsMonthClosedKey(closedMonth),
    subject,
    body,
    familyChannelOnly: selfScoped,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * The daily-slot half of Lane 2: both savings_target_pace (current month) and
 * savings_month_closed (previous month) share this one entry point, the same shape
 * evaluate/monthly.ts's evaluateMonthBoundary uses to fold its own two month-boundary events
 * into a single call for evaluate/index.ts to make.
 */
export function evaluateSavingsDaily(input: { userId: number; now: Date; tz: string }): number {
  return fireSavingsPace(input) + fireSavingsMonthClosed(input);
}
