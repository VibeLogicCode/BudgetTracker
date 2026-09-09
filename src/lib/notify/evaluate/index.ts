import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox, transactions } from '@/db/schema';
import { readEnv } from '@/lib/env';
import { getUserSettings, notifiableUsers } from '@/lib/notify/config';
import { closeMonthsAutomatically } from '@/lib/month-close';
import { evaluateAnomalies, evaluateSubscriptionCreep } from '@/lib/notify/evaluate/anomalies';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { flushMonthSummaries } from '@/lib/notify/evaluate/monthly';
import { evaluateSavingsDaily } from '@/lib/notify/evaluate/savings';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';
import { dailySlot, mondayOfIsoWeek, weeklySlot } from '@/lib/notify/evaluate/slots';
import { CHANNELS, householdWeeklyDigestKey, weeklyDigestKey } from '@/lib/notify/events';
import { HOUSEHOLD_PASS_SETTINGS } from '@/lib/notify/family-pass';
import { householdRoutedChannels } from '@/lib/notify/household';

/**
 * Slot-skip logging is deduped by (kind, userId) so a family sitting outside every slot's
 * catch-up window (the common case between ticks) does not write ~1000 identical "skipped"
 * lines a day (every 5-minute tick, times every user, times two slot kinds). A line is
 * emitted only when the SKIPPED SLOT DATE changes from the last one logged for that
 * (kind, userId); the slot advancing to a new day is still visible, just not every 5 minutes.
 */
let lastLoggedSlot = new Map<string, string>();

export function resetSlotSkipLogForTests(): void {
  lastLoggedSlot = new Map();
}

/**
 * MUST-10.9 (final-fix-wave item 4): mirrors digestAlreadySent's purpose for the remaining
 * daily-slot evaluators -- evaluateSubscriptionCreep and evaluateSavingsDaily. It covered four:
 * evaluateMonthBoundary moved to flushMonthSummaries (its trigger is the month being closed, not a
 * slot) and evaluateBudgetPace stopped being scheduled at all (its projection is a section of the
 * weekly summary now). Both moves are dated 2026-09-09 and argued at their call sites below.
 *
 * `daily.fires` stays true for the whole DAILY_MAX_CATCHUP_HOURS (12h) window and the scheduler
 * ticks every 5 minutes, so without this an unchanged tick recomputed each of them roughly 144
 * times a day per user. Each detector's own dedup key already makes a repeat enqueue a no-op;
 * this in-memory per-user record of the last daily slotDate actually processed skips the
 * recompute itself before any query runs, the same way lastAnomalyKey does for the tick-cadence
 * detectors. A restart clears it, costing at most one wasted evaluation per user, which is
 * dedup-safe for the same reason.
 */
let lastDailyEvaluatedSlot = new Map<number, string>();

/**
 * v1.32.0 (ruling R23). The household's own version of lastDailyEvaluatedSlot above, and for the
 * identical reason: `daily.fires` stays true for the whole 12-hour catch-up window and the
 * scheduler ticks every five minutes, so without this the household's daily pass would recompute
 * roughly 144 times a day. One entry, not a map, because there is exactly one household.
 */
let lastHouseholdDailySlot: string | null = null;

export function resetDailyEvaluationSlotForTests(): void {
  lastDailyEvaluatedSlot = new Map();
  lastHouseholdDailySlot = null;
}

function logSlotSkipOnce(kind: 'daily' | 'weekly', userId: number, slotDate: string, hoursSince: number): void {
  const key = `${kind}:${userId}`;
  if (lastLoggedSlot.get(key) === slotDate) return;
  lastLoggedSlot.set(key, slotDate);
  console.log(`[notify] slot ${slotDate} (${kind}) for user ${userId} skipped (${hoursSince}h stale)`);
}

/**
 * MUST-3.11's dedup key already contains the slot date, so a digest already sent for this
 * user's current slot means every tick for the rest of the 48h catch-up window would
 * otherwise recompute categoryBreakdown/topMerchants/budgetProgress/reviewQueueCount only to
 * have enqueue() discard the result. This indexed existence check (served by
 * notification_outbox_dedup_uq's (user_id, ...) prefix) skips that recompute entirely once
 * the real send has already happened. coming_due has no equivalent check: its own query is
 * already a single cheap read, so the extra existence check would cost more than it saves.
 */
/**
 * 2026-09-08. When this recipient last had a weekly summary, or null if never.
 *
 * Reads the outbox rather than a stored timestamp, because the outbox row IS the record that a
 * summary was produced — the same "the row is the guard" rule MUST-3.9 already relies on, and it
 * means a manual send from the dashboard counts as the last summary too, which is what stops the
 * button and the schedule sending twice about the same data.
 */
function lastDigestAt(userId: number): string | null {
  const row = getDb()
    .select({ at: notificationOutbox.createdAt })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.userId, userId), eq(notificationOutbox.eventId, 'weekly_digest')))
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(1)
    .get();
  return row?.at ?? null;
}

/**
 * 2026-09-08. Have any transactions ARRIVED since then?
 *
 * `transactions.created_at`, not an `imports` row, and the distinction is the whole point. A
 * SimpleFIN sync that finds nothing still writes an imports row with `rows_added` zero, so gating
 * on "an import happened" would fire a summary about a week in which nothing changed — which is
 * precisely the stale message this gate exists to prevent. A transaction row is the honest signal:
 * it exists only when there is genuinely something new to report.
 *
 * A household that has never had a summary passes: the first one should not wait for a second
 * import.
 */
function hasNewTransactionsSince(since: string | null): boolean {
  if (since === null) return true;
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .where(gt(transactions.createdAt, since))
    .get();
  return (row?.n ?? 0) > 0;
}

function digestAlreadySent(userId: number, slotDate: string): boolean {
  const row = getDb()
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.userId, userId), eq(notificationOutbox.dedupKey, weeklyDigestKey(slotDate))))
    .limit(1)
    .get();
  if (row !== undefined) return true;

  // v1.28.0. A digest routed to the family channel writes NO personal row for that channel, so
  // for a household that routed BOTH channels the check above can never be satisfied and the
  // recompute it exists to prevent would run on every five-minute tick for the whole 48-hour
  // catch-up window -- now with the per-member breakdown queries on top.
  //
  // The "both channels" condition is not tidiness. Route only Telegram and this user still owes
  // themselves a personal EMAIL digest; skipping on the strength of the household row would mean
  // they never got one. Partial routing therefore falls through to the personal check above, which
  // starts returning true once their own remaining row exists.
  if (householdRoutedChannels('weekly_digest').length !== CHANNELS.length) return false;

  // The household digest's key is week-bounded (householdWeeklyDigestKey), so this one indexed
  // probe covers every member's slot in that week, however differently they set their weekday.
  const householdRow = getDb()
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(
      and(
        isNull(notificationOutbox.userId),
        eq(notificationOutbox.dedupKey, householdWeeklyDigestKey(mondayOfIsoWeek(slotDate))),
      ),
    )
    .limit(1)
    .get();
  return householdRow !== undefined;
}

/**
 * §6.2: what is evaluated when:
 *   coming_due, stale_import  → the user's DAILY slot
 *   weekly_digest             → the user's WEEKLY slot
 *   budget_threshold/exceeded → EVERY tick, fingerprint-guarded (§6.5)
 *   backup_failed, new_signin, restore_outcome,
 *   password_changed, mfa_disabled          → immediate (§6.6), never here
 *
 * MUST-6.7: a slot outside its catch-up window is skipped, logging exactly one line PER
 * SLOT (see logSlotSkipOnce) rather than once per five-minute tick for as long as the
 * install stays outside every window.
 * MUST-6.9: firing a slot twice is harmless: every key contains the slot date or the item
 * id, so a second evaluation inserts nothing.
 *
 * This function never throws into the scheduler: each user's evaluation is wrapped so one
 * bad row cannot stop the rest of the household from being told anything.
 */
export function runScheduledEvaluation(
  now: Date = new Date(),
  options?: {
    /**
     * Owner report, 2026-09-08: "it shouldnt send notifications on boot. when it reboots it sends
     * notifications about budget".
     *
     * SLOT events still catch up at boot -- that is MUST-6.1, and it is the whole reason a
     * container that was off overnight still gets yesterday's coming_due and its weekly digest.
     * TICK events do not, and never needed to: budget_threshold, budget_exceeded, the anomaly
     * family and savings_target_met all describe a CURRENT state, so if the state still holds the
     * next five-minute tick reports it anyway. Firing them at boot buys nothing and costs a burst.
     *
     * It became loud rather than merely redundant in v1.32.0: the family channel gained its own
     * evaluation pass (ruling R23), so on the first boot after that upgrade every household dedup
     * key was unwritten and every currently-over-budget category fired into the family channel at
     * once. That is a one-off, but "restart the container, get a wall of alerts" is not a thing an
     * app should do at all.
     */
    atBoot?: boolean;
  },
): void {
  const { tz } = readEnv();

  for (const user of notifiableUsers()) {
    const settings = getUserSettings(user.id);

    try {
      const daily = dailySlot(now, settings.dailyHour, tz);
      if (daily.fires) {
        evaluateComingDue({ userId: user.id, now, tz });
        evaluateStaleImport({ userId: user.id, now, tz });
        // MUST-10.9: skip the three newer evaluators once this daily slot has already been
        // processed, rather than recomputing them on every 5-minute tick inside the 12-hour
        // catch-up window. Recorded only after all three return without throwing, so a
        // transient failure retries on the next tick instead of being silently skipped.
        if (lastDailyEvaluatedSlot.get(user.id) !== daily.slotDate) {
          /**
           * 2026-09-09: evaluateBudgetPace is NO LONGER CALLED, for the third and last time this
           * redesign makes this argument.
           *
           * It was the one detector still sending a message PER CATEGORY -- up to five a day, on
           * this daily slot. For a household that imports on Sundays that meant five notifications
           * on Sunday about five categories, six days of silence while the figures did not move,
           * and five more the following Sunday. The owner's original complaint, exactly:
           * "there is 1 message per budget can we not send a summary message ... less repetitive".
           *
           * The projection is now a section of the weekly summary, between Over and Close
           * (evaluate/digest.ts, collectBudgets). Same arithmetic, same thresholds, same
           * src/lib/predict helpers -- what changed is that it arrives with the figures it belongs
           * beside, once, instead of alone and daily.
           *
           * The function and the event id stay, as evaluateBudgets and evaluateSavingsTargetMet do.
           */
          evaluateSubscriptionCreep({ userId: user.id, now, tz });
          // 2026-09-09: the month-boundary reports moved OUT of the daily slot and into
          // flushMonthSummaries below. Their trigger is the month being closed -- a person pressing
          // a button, or every account being synced -- not a slot, and the loop has to be owned in
          // one place so the month can be marked sent after everybody has been evaluated. See
          // flushMonthSummaries, which also documents the defect that made this necessary.
          // Lane 2 (savings targets): savings_target_pace and savings_month_closed are both
          // daily_slot events, so they share this same once-per-day-per-user cache rather than
          // recomputing savingsProgress/savingsStreak on every five-minute tick inside the
          // 12-hour catch-up window.
          evaluateSavingsDaily({ userId: user.id, now, tz });
          lastDailyEvaluatedSlot.set(user.id, daily.slotDate);
        }
      } else {
        logSlotSkipOnce('daily', user.id, daily.slotDate, daily.hoursSince);
      }
    } catch (error) {
      console.error(`[notify] daily evaluation failed for user ${user.id}`, error);
    }

    /**
     * 2026-09-08. THE ANCHOR, and the reason the owner stopped getting stale summaries.
     *
     * He imports once a week, on Sundays. The old rule fired at the weekly slot if it was inside a
     * 48-hour catch-up window, which produced two bad outcomes: a summary on Monday whether or not
     * anything had been imported (a report on a week in which, from the app's point of view,
     * nothing happened), and — worse — if he imported on Monday AFTERNOON, the next evaluation was
     * the following Monday and six days of data sat unreported.
     *
     * The fix separates the two jobs the schedule was doing. The chosen weekday and hour give an
     * ANCHOR: the most recent Monday 08:00 at or before now, which weeklySlot already computes as
     * `slotDate`. We look EVERY day, and send when both hold:
     *
     *   (a) transactions have been added since the last summary, and
     *   (b) no summary has gone out for this anchor yet.
     *
     * (b) is free: the dedup key is already `digest:<slotDate>`, so a summary sent for this anchor
     * cannot be sent twice. (a) is the new half.
     *
     * WHY IT DOES NOT DRIFT. A count of days would: send on Tuesday, and the following Monday is
     * only six days later, so it slips to Tuesday permanently, then Wednesday. Anchoring on the
     * weekday re-pins it — a Tuesday send is still "before the next Monday anchor", so the week
     * after returns to Monday.
     *
     * The catch-up window is gone with it. An anchor waits as long as it needs to, so a container
     * off for three days simply sends on the day it comes back, and `logSlotSkipOnce` has nothing
     * left to report.
     */
    try {
      /**
       * 2026-09-09: summaryFrequency picks the ANCHOR, and nothing else about the mechanism above
       * changes. 'manual' has no anchor at all -- the schedule does not send, the dashboard button
       * does -- so it returns before any query runs.
       *
       * THE FAMILY CHANNEL STAYS WEEKLY whatever any member chooses, and that is deliberate: its
       * key is week-bounded (householdWeeklyDigestKey) precisely so several members with different
       * weekdays produce ONE message in the room rather than one each. A member who picks 'daily'
       * and whose channels are ALL routed to the room therefore still reads a weekly message --
       * already true of everything else they receive, routing being the choice to be told in the
       * room instead of privately. Route only one channel and their own daily copy arrives on the
       * other, which is digestAlreadySent's partial-routing branch falling through as written.
       */
      if (settings.summaryFrequency !== 'manual') {
        const anchor =
          settings.summaryFrequency === 'daily'
            ? dailySlot(now, settings.digestHour, tz).slotDate
            : weeklySlot(now, settings.digestWeekday, settings.digestHour, tz).slotDate;
        if (!digestAlreadySent(user.id, anchor) && hasNewTransactionsSince(lastDigestAt(user.id))) {
          evaluateWeeklyDigest({ userId: user.id, slotDate: anchor, now });
        }
      }
    } catch (error) {
      console.error(`[notify] weekly evaluation failed for user ${user.id}`, error);
    }
  }

  /**
   * 2026-09-08. A household whose accounts are ALL SimpleFIN-linked needs nobody to confirm the
   * month: a successful sync past the month end is a reliable statement that the data is current,
   * which is the one machine signal this design trusts. Anyone with a manual account closes the
   * month by hand on the Import page instead, and this does nothing for them.
   *
   * Before the per-user loop's month-boundary evaluation would find anything to send, so a
   * fully-synced household gets last month's summary on the first slot after the posting lag.
   */
  try {
    closeMonthsAutomatically(now, tz);
  } catch (error) {
    console.error('[notify] automatic month closure failed', error);
  }

  /**
   * 2026-09-09. Every month-boundary report, for everybody, in one owned loop -- and the month
   * marked sent afterwards, which nothing did before (see flushMonthSummaries).
   *
   * Runs on every tick, boot included: its first statement is an indexed read that returns an
   * empty list whenever no month is waiting, which is almost always. It belongs in the boot pass
   * for MUST-6.1's reason -- a container that was off when somebody closed a month should send the
   * summary when it comes back, not sit on it.
   */
  try {
    flushMonthSummaries(now, tz);
  } catch (error) {
    console.error('[notify] month summary flush failed', error);
  }

  runHouseholdEvaluation(now, tz);

  // The three TICK-triggered evaluators, skipped on the boot pass -- see `atBoot` above. Grouped
  // here behind one guard rather than three, because "what fires on a tick but not at boot" is one
  // idea and a fourth such evaluator must land inside this block, not beside it.
  if (options?.atBoot === true) {
    console.log('[notify] boot pass: slot catch-up only, tick-triggered events skipped');
    return;
  }

  /**
   * 2026-09-08 (owner report: "there is 1 message per budget can we not send a summary message
   * with key figures and less repetative text so its easier to read and digest info").
   *
   * evaluateBudgets is NO LONGER CALLED. Every figure it used to send one message at a time --
   * category, spent, limit, how far over -- is now a section of the weekly summary, which the
   * household reads once instead of six times (evaluate/digest.ts, collectBudgets).
   *
   * This is a deliberate removal, not an oversight, and the trade is worth stating: a category
   * that goes over on Tuesday is reported in Monday's summary rather than within five minutes.
   * For this household that costs nothing, because transactions arrive in one weekly import --
   * there is no Tuesday in which the number could have moved. The function and its two event ids
   * stay (prefs, family-channel routing and its own tests are untouched) so the decision is one
   * line to revisit.
   */

  try {
    evaluateAnomalies({ now, tz });
  } catch (error) {
    console.error('[notify] anomaly evaluation failed', error);
  }

  /**
   * 2026-09-09: evaluateSavingsTargetMet is NO LONGER CALLED, for the same reason evaluateBudgets
   * is not (see above).
   *
   * It fired on a five-minute tick, the moment net first crossed the target. For a household paid
   * monthly that is a push notification on payday, every month, telling them something the
   * Savings page already showed -- and by the time the month is over the figure may well have
   * moved. Its fact belongs to the month, so it is now a line in the monthly summary
   * (evaluate/monthly.ts, renderMonthlyDigestFor).
   *
   * The function and the event id stay, as evaluateBudgets does: one line to revisit.
   */

  // evaluateSavingsDaily still runs on the daily slot inside the per-user loop above --
  // savings_target_pace and savings_month_closed are unaffected by this.
}

/**
 * v1.32.0, RULING R23: THE FAMILY CHANNEL'S OWN EVALUATION PASS.
 *
 * Every slot-triggered evaluator above is driven by ONE MEMBER'S clock and gated on THAT MEMBER'S
 * preferences, and the family-channel row was a by-product of reaching enqueue() during such a
 * pass. So a household that had configured a family channel, enabled it, and switched the event on
 * for the room but for nobody in particular got no row at all -- for every household-eligible
 * event, silently, with nothing anywhere saying why. src/lib/notify/family-pass.ts carries the
 * ruling itself: a family-channel subscription is a thing in its own right, so it evaluates as
 * itself, with `userId: null` all the way down to the outbox row it was always going to write.
 *
 * WHY THE HOUSEHOLD HAS ITS OWN CLOCK RATHER THAN RIDING ON A MEMBER'S. Each evaluator here fires
 * on a slot, and the household has no notification_user_settings row to take an hour from. The two
 * candidates were "run it inside the per-user loop, on whichever member's slot comes first" and
 * this. The first is cheaper by one slot computation and was rejected twice over: it would run the
 * whole household pass once per member per slot (idempotent, but N times the queries every day for
 * as long as the routing lasts), and it would make the family channel's delivery time depend on
 * who is in the household -- change your own daily hour and the group chat moves. This uses
 * HOUSEHOLD_PASS_SETTINGS, the app's own documented defaults, which is exactly what a member who
 * has never opened their settings page uses too, so on a default install the room and the people
 * in it are told at the same time.
 *
 * NOT HERE, deliberately: the tick-triggered events (budget_threshold, budget_exceeded,
 * unusual_transaction, duplicate_charge, savings_target_met). Those evaluators already run once per
 * tick outside the per-user loop and own their own recipient rosters, so the family channel joins
 * the roster inside them rather than being called separately from here -- one place that decides
 * who an event is for, per event, which is the shape those files already had.
 *
 * ALSO NOT HERE: coming_due and weekly_digest, the two household-eligible events whose evaluators
 * have no personal gate at all. They run for every notifiable user regardless of that user's
 * toggles, so their family row was never the missing one; adding a second writer would buy nothing
 * and put the room's coming_due message under a different owner. tests/ops/family-channel-pass.test.ts
 * is the named list, and tests/lib/notify/evaluate/family-channel-pass.test.ts proves the claim
 * about those two rather than asserting it.
 *
 * Wrapped exactly as the per-user blocks above are: one bad read for the room must not stop the
 * household from being told anything.
 */
function runHouseholdEvaluation(now: Date, tz: string): void {
  try {
    const daily = dailySlot(now, HOUSEHOLD_PASS_SETTINGS.dailyHour, tz);
    if (daily.fires && lastHouseholdDailySlot !== daily.slotDate) {
      // 2026-09-09: the room's budget_pace pass went with the member one -- the family channel
      // reads the projection in the household weekly summary, which buildHouseholdDigest already
      // carries the budget block of.
      evaluateSubscriptionCreep({ userId: null, now, tz });
      // 2026-09-09: the room's month-boundary reports moved to flushMonthSummaries too, which
      // makes the family-channel pass for them part of the same loop the marking depends on.
      evaluateSavingsDaily({ userId: null, now, tz });
      // Recorded only after all three return without throwing, so a transient failure retries on
      // the next tick rather than being silently skipped for the day (MUST-10.9's own rule).
      lastHouseholdDailySlot = daily.slotDate;
    }
  } catch (error) {
    console.error('[notify] daily evaluation failed for the family channel', error);
  }
}
