import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox } from '@/db/schema';
import { readEnv } from '@/lib/env';
import { getUserSettings, notifiableUsers } from '@/lib/notify/config';
import { evaluateAnomalies, evaluateSubscriptionCreep } from '@/lib/notify/evaluate/anomalies';
import { evaluateBudgets } from '@/lib/notify/evaluate/budget';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';
import { evaluateSavingsDaily, evaluateSavingsTargetMet } from '@/lib/notify/evaluate/savings';
import { evaluateStaleImport } from '@/lib/notify/evaluate/stale';
import { dailySlot, mondayOfIsoWeek, weeklySlot } from '@/lib/notify/evaluate/slots';
import { CHANNELS, householdWeeklyDigestKey, weeklyDigestKey } from '@/lib/notify/events';
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
 * MUST-10.9 (final-fix-wave item 4): mirrors digestAlreadySent's purpose for the three newer
 * daily-slot evaluators (evaluateBudgetPace, evaluateSubscriptionCreep, evaluateMonthBoundary).
 * `daily.fires` stays true for the whole DAILY_MAX_CATCHUP_HOURS (12h) window and the scheduler
 * ticks every 5 minutes, so without this an unchanged tick recomputed all three roughly 144
 * times a day per user. Each detector's own dedup key already makes a repeat enqueue a no-op;
 * this in-memory per-user record of the last daily slotDate actually processed skips the
 * recompute itself before any query runs, the same way lastAnomalyKey does for the tick-cadence
 * detectors. A restart clears it, costing at most one wasted evaluation per user, which is
 * dedup-safe for the same reason.
 */
let lastDailyEvaluatedSlot = new Map<number, string>();

export function resetDailyEvaluationSlotForTests(): void {
  lastDailyEvaluatedSlot = new Map();
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
export function runScheduledEvaluation(now: Date = new Date()): void {
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
          evaluateBudgetPace({ userId: user.id, now, tz });
          evaluateSubscriptionCreep({ userId: user.id, now, tz });
          evaluateMonthBoundary({ userId: user.id, now, tz });
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

    try {
      const weekly = weeklySlot(now, settings.digestWeekday, settings.digestHour, tz);
      if (weekly.fires) {
        if (!digestAlreadySent(user.id, weekly.slotDate)) {
          evaluateWeeklyDigest({ userId: user.id, slotDate: weekly.slotDate, now });
        }
      } else {
        logSlotSkipOnce('weekly', user.id, weekly.slotDate, weekly.hoursSince);
      }
    } catch (error) {
      console.error(`[notify] weekly evaluation failed for user ${user.id}`, error);
    }
  }

  try {
    evaluateBudgets({ now, tz });
  } catch (error) {
    console.error('[notify] budget evaluation failed', error);
  }

  try {
    evaluateAnomalies({ now, tz });
  } catch (error) {
    console.error('[notify] anomaly evaluation failed', error);
  }

  try {
    // Lane 2: savings_target_met is a tick event, household-wide (ruling T3), so it runs once
    // per tick here rather than once per user inside the loop above -- the same shape
    // evaluateBudgets/evaluateAnomalies already use for their own tick-triggered events.
    evaluateSavingsTargetMet({ now, tz });
  } catch (error) {
    console.error('[notify] savings target evaluation failed', error);
  }
}
