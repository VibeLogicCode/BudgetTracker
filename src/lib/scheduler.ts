import cron, { type ScheduledTask } from 'node-cron';
import { runNightlyJob } from '@/lib/backup';
import { readEnv } from '@/lib/env';
import { adminUserIds, hasAnyEnabledTarget } from '@/lib/notify/config';
import { runScheduledEvaluation } from '@/lib/notify/evaluate';
import { countPendingOutbox, expireStalePending, pumpOutbox } from '@/lib/notify/outbox';
import { raiseBackupFailed, raiseSyncFailed } from '@/lib/notify/raise';
import { getSetting } from '@/lib/settings';
import {
  AUTO_SYNC_INTERVALS,
  SETTING_AUTO_SYNC,
  SETTING_AUTO_SYNC_USER_ID,
  getConnection,
  isAutoSyncDue,
  isAutoSyncInterval,
  remainingRequestsToday,
} from '@/lib/simplefin/connection';
import { runSync } from '@/lib/simplefin/sync';
import { dueForCheck, runUpdateCheck } from '@/lib/update/check';
import { isUpdateCheckEnabled, readUpdateState } from '@/lib/update/state';
import { sweepPendingReceipts } from '@/lib/warranty/ocr/queue';

export const NIGHTLY_CRON = '0 2 * * *';
/** MUST-7.12: a crash leaves rows in 'pending'; this tick re-enqueues them. */
export const OCR_SWEEP_CRON = '*/10 * * * *';
/** MUST-6.1: five minutes is the retry and catch-up granularity, not the latency floor. */
export const NOTIFY_TICK_CRON = '*/5 * * * *';

let task: ScheduledTask | null = null;
let ocrTask: ScheduledTask | null = null;
let notifyTask: ScheduledTask | null = null;
/** MUST-6.3: single-flight. A tick arriving while the last one is still running is a no-op. */
let ticking = false;
/** MUST-7.8: the 24-hour pending expiry runs on the FIRST tick after boot, once. */
let bootExpiryDone = false;
/** MUST-5.4: runUpdateTick's own single-flight guard, reset by stopScheduler(). */
let updateTicking = false;
/** Task 8: runSimplefinTick's own single-flight guard, reset by stopScheduler(). */
let simplefinTicking = false;

function runOcrSweep(): void {
  try {
    const enqueued = sweepPendingReceipts();
    if (enqueued > 0) console.log(`[ocr] sweep enqueued ${enqueued} pending receipt(s)`);
  } catch (error) {
    console.error('[ocr] sweep failed', error);
  }
}

/** Exported so a test can drive the nightly failure path without waiting on a real cron tick. */
export function runNightlyTick(now: Date = new Date()): void {
  try {
    runNightlyJob(now);
  } catch (error) {
    console.error('[backup] nightly job failed', error);
    // MUST-14.1: the UNATTENDED path notifies. The "run now" action deliberately does not.
    // raiseBackupFailed is internally guarded (MUST-6.19) and never throws today, so it is
    // NOT relying on this catch for protection: it simply runs inside the same catch body
    // that already handles runNightlyJob's own failure. If that guarantee ever changed, a
    // throw here would propagate out of the cron callback uncaught.
    raiseBackupFailed({ error, at: now });
  }
}

export function runNotifyTick(now: Date = new Date()): void {
  // MUST-6.3: the single-flight guard is the tick's actual first statement.
  if (ticking) return;
  // MUST-6.4: the dormancy bail, right after the single-flight guard above. Two indexed
  // reads against tables that are empty on a dormant install. Nothing below this line
  // executes, so no evaluator runs, no renderer runs, and no transport module is even
  // reached.
  if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;

  ticking = true;
  try {
    if (!bootExpiryDone) {
      bootExpiryDone = true;
      const expired = expireStalePending(now);
      if (expired > 0) console.log(`[notify] expired ${expired} pending row(s) older than 24h`);
    }
    runScheduledEvaluation(now);
  } catch (error) {
    console.error('[notify] tick failed', error);
  } finally {
    ticking = false;
  }
  // The pump owns its own single-flight guard and is deliberately not awaited: a slow
  // relay must not hold the cron callback open into the next tick.
  void pumpOutbox(now).catch((error) => console.error('[notify] pump failed', error));
}

/**
 * MUST-5.1 / MUST-5.3: a SEPARATE function with its OWN independent gate, deliberately not
 * folded into runNotifyTick's dormancy bail. The consequence is the correct one: an install
 * with update checks on and no notification channel still checks for updates, and an install
 * with a notification channel and no update checks still makes no GitHub call.
 */
export function runUpdateTick(now: Date = new Date()): void {
  try {
    // The dormancy gate is the tick's first statement: one indexed read of a settings key
    // that is ABSENT on every install nobody has enabled this on.
    if (!isUpdateCheckEnabled()) return;
    if (updateTicking) return;
    const state = readUpdateState();
    if (!dueForCheck(state.lastCheckedAt, now)) return; // UPDATE_CHECK_INTERVAL_MS
  } catch (error) {
    // Defect fix (same shape as runSimplefinTick's identical pre-existing gap below): a
    // throw here used to escape uncaught. node-cron swallows an uncaught throw from a
    // scheduled callback, so the process never crashed, but nothing was ever logged either.
    // updateTicking is never set inside this try, so a throw here can never leave it stuck.
    console.error('[update] tick failed', error);
    return;
  }
  updateTicking = true;
  void runUpdateCheck({ now })
    .catch((error) => console.error('[update] check failed', error))
    .finally(() => {
      updateTicking = false;
    });
}

/**
 * Task 8 (v1.7.0, design ruling 7): a SEPARATE function with its OWN independent gate,
 * deliberately not folded into runUpdateTick or runNotifyTick, for the same reason MUST-5.1
 * separates the update tick from the notify tick: a household that wants auto-sync but has
 * no notification channel configured must still get synced, and a household with
 * notifications on but auto-sync off must never make a single SimpleFIN request or spend any
 * of its daily budget.
 */
export function runSimplefinTick(now: Date = new Date()): void {
  try {
    // The dormancy gate is the tick's first statement, same shape as isUpdateCheckEnabled():
    // one indexed settings read. isAutoSyncInterval is the SAME guard the Connections page's
    // <select> and the server action's zod schema use, so a stored value none of the three
    // recognise -- including plain absence -- can only ever mean "off" everywhere at once.
    const stored = getSetting(SETTING_AUTO_SYNC);
    if (stored === null || !isAutoSyncInterval(stored)) return;

    const connection = getConnection();
    if (!connection || !connection.enabled) return;

    // An exhausted daily request budget is expected backpressure, not a failure (design ruling
    // 7): this returns silently, same as the two checks above, and never reaches
    // raiseSyncFailed below.
    if (remainingRequestsToday(now) === 0) return;

    if (!isAutoSyncDue(connection.lastSyncAt, AUTO_SYNC_INTERVALS[stored].dueAfterHours, now)) return;
  } catch (error) {
    // Defect fix: this gate used to sit outside any try/catch, unlike every sibling job in
    // this file. node-cron swallows an uncaught throw from a scheduled callback, so a
    // database hiccup here never crashed the process, but it never logged anything either --
    // auto-sync would silently stop firing with nothing to diagnose from. simplefinTicking is
    // never set inside this try, so a throw here can never leave it stuck true.
    console.error('[simplefin] tick failed', error);
    return;
  }

  if (simplefinTicking) return;
  simplefinTicking = true;
  void runAutoSimplefinSync(now)
    .catch((error) => raiseSyncFailed({ error, at: now }))
    .finally(() => {
      simplefinTicking = false;
    });
}

/**
 * The stored user id is re-validated as an ACTIVE ADMIN at read time, never trusted from
 * whenever the setting was saved: a promotion can be undone and a user can be deactivated,
 * and neither currently clears simplefin_auto_sync_user_id. An invalid id never reaches
 * runSync -- it throws instead, which runSimplefinTick's catch turns into exactly the same
 * sync_failed alert a real sync failure would raise, naming the actual problem.
 */
async function runAutoSimplefinSync(now: Date): Promise<void> {
  const raw = getSetting(SETTING_AUTO_SYNC_USER_ID);
  const userId = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(userId) || !adminUserIds().includes(userId)) {
    throw new Error('The automatic sync user is no longer an active admin. Re-save automatic sync in Settings → Connections.');
  }
  await runSync({ userId, now });
}

/** Idempotent: safe to call more than once per process (e.g. hot-reload in dev). */
export function startScheduler(): void {
  if (task) return;
  const { tz } = readEnv();
  task = cron.schedule(NIGHTLY_CRON, () => runNightlyTick(), { timezone: tz });
  ocrTask = cron.schedule(OCR_SWEEP_CRON, runOcrSweep, { timezone: tz });
  notifyTask = cron.schedule(
    NOTIFY_TICK_CRON,
    () => {
      runUpdateTick();
      runNotifyTick();
      runSimplefinTick();
    },
    { timezone: tz },
  );
  console.log(`[scheduler] nightly job registered for ${NIGHTLY_CRON} (${tz})`);
  console.log(`[scheduler] OCR sweep registered for ${OCR_SWEEP_CRON} (${tz})`);
  console.log(`[scheduler] notification tick registered for ${NOTIFY_TICK_CRON} (${tz})`);
  // ...and once at boot, so a container restarted mid-job recovers immediately instead of
  // leaving a member's receipt unread for up to ten minutes.
  runOcrSweep();
  // MUST-6.1 / MUST-5.2: both run once immediately at boot, so a container that was off
  // through a slot catches up in seconds rather than waiting up to five minutes for the
  // next cron tick. The update check goes first, ahead of the notification tick.
  runUpdateTick();
  runNotifyTick();
  // Task 8: same reasoning as the two ticks above -- a container that was off catches up on
  // a due auto-sync immediately at boot rather than waiting up to five minutes.
  runSimplefinTick();
}

export function stopScheduler(): void {
  task?.stop();
  task = null;
  ocrTask?.stop();
  ocrTask = null;
  notifyTask?.stop();
  notifyTask = null;
  bootExpiryDone = false;
  updateTicking = false;
  simplefinTicking = false;
}

/**
 * True if ANY of the three registered tasks is still running, not just the nightly one,
 * so a regression that forgets to null out `ocrTask`/`notifyTask` in stopScheduler() makes
 * this report "still running" instead of silently agreeing with a partial teardown.
 */
export function isSchedulerRunning(): boolean {
  return task !== null || ocrTask !== null || notifyTask !== null;
}
