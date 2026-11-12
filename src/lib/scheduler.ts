import cron, { type ScheduledTask } from 'node-cron';
import { todayIso } from '@/lib/dates';
import { postAllDueInterest } from '@/lib/loans';
import { countUsers } from '@/lib/auth/users';
import { backupCatchUpDue, newestBackupAt, runNightlyJob } from '@/lib/backup';
import { isRestorePending } from '@/lib/backup/restore';
import { notifyCanadianPackUpdateAvailable } from '@/lib/canadian-pack';
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
  autoSyncBackoff,
  getConnection,
  isAutoSyncDue,
  isAutoSyncInterval,
  recordAutoSyncAttempt,
  recordAutoSyncFailure,
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
/** v1.60.0: the boot backup catch-up's pending timer, cleared by stopScheduler(). */
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;

/** How long boot waits before a catch-up backup, so the backup never competes with boot itself. */
export const BACKUP_CATCH_UP_DELAY_MS = 2 * 60 * 1000;

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

export function runNotifyTick(now: Date = new Date(), options?: { atBoot?: boolean }): void {
  // MUST-6.3: the single-flight guard is the tick's actual first statement.
  if (ticking) return;

  ticking = true;
  try {
    /*
      Ledger spec P3. A machine that was switched off for a month catches up here, within five
      minutes of coming back, rather than waiting for the next 2am. Only at boot: an ordinary
      five-minute tick must not sweep every loan, and the nightly job already owns the routine
      case.
    */
    if (options?.atBoot === true) {
      try {
        postAllDueInterest(todayIso(now), now);
      } catch (error) {
        console.error('[loans] boot catch-up of due interest failed', error);
      }
    }

    // MUST-6.4: the dormancy bail, right after the single-flight guard above. Two indexed
    // reads against tables that are empty on a dormant install. Nothing below this line
    // executes, so no evaluator runs, no renderer runs, and no transport module is even
    // reached.
    //
    // O-03 fix: hasAnyEnabledTarget()/countPendingOutbox() are DATABASE reads -- either can
    // throw (a locked database, a full disk, a corrupted page) -- so this bail moved inside
    // the try that now surrounds it, the same fix runNightlyJob's own comment already
    // documents ("If that guarantee ever changed, a throw here would propagate out of the
    // cron callback uncaught") and runUpdateTick/runSimplefinTick already carry for their own
    // gates. `ticking` above is a module-level boolean, not a DB read, so it cannot throw and
    // correctly stays outside.
    if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;

    if (!bootExpiryDone) {
      bootExpiryDone = true;
      const expired = expireStalePending(now);
      if (expired > 0) console.log(`[notify] expired ${expired} pending row(s) older than 24h`);
    }
    runScheduledEvaluation(now, options);
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
 * Backlog item 17 / Part 4: a SEPARATE function with its OWN independent gate (there is none --
 * see below) from runUpdateTick, deliberately. runUpdateTick's very first statement bails out
 * when the household has switched APP update checks off (isUpdateCheckEnabled) -- a household
 * preference about polling GitHub for a newer Budget Tracker image, which has nothing to do with
 * whether they would want to hear about a stale preset pack they installed. Folding this into
 * runUpdateTick would make disabling one silently disable the other.
 *
 * No single-flight guard, unlike runUpdateTick/runSimplefinTick: notifyCanadianPackUpdateAvailable
 * is synchronous (a local version comparison plus an idempotent, dedup-keyed insert -- no network
 * call), so there is no async window across which a second tick could overlap the first.
 */
export function runCanadianPackUpdateTick(now: Date = new Date()): void {
  try {
    notifyCanadianPackUpdateAvailable(now);
  } catch (error) {
    console.error('[canadian-pack] update tick failed', error);
  }
}

/**
 * 2026-09-09: runCanadianPackUpdateTick IS NO LONGER SCHEDULED.
 *
 * A merchant-rules pack update changes how new transactions get categorised. It is genuinely
 * useful and genuinely not urgent -- nothing breaks if it is applied a month from now, and it is
 * already on the Settings -> Merchant rules page whenever somebody looks. Sending it as a push
 * notification spends the household's attention on a fact that asks nothing of them, and a channel
 * that mostly carries those is a channel people stop reading.
 *
 * That is the same judgement applied to app updates immediately above (major versions only) and to
 * budgets a day earlier (one weekly summary, not one message per category). The function, the
 * event id and its preference row all stay, exactly as evaluateBudgets does, so restoring it is
 * one line in registerScheduler.
 */

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

    // v1.60.0: consecutive automatic failures wait 30 minutes, doubling, up to 24 hours from the
    // last attempt (autoSyncBackoff), so a bank that keeps failing cannot spend the day's requests.
    // Silent for the same reason as the budget check above. A manual sync never reads it.
    if (autoSyncBackoff(now) !== null) return;

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
 * v1.60.0: the attempt is recorded first and every throw from the run counts as one failure (the
 * errlist throw and an invalid sync user included), which is what the tick's backoff reads. A
 * clean run's markSynced clears both.
 */
async function runAutoSimplefinSync(now: Date): Promise<void> {
  recordAutoSyncAttempt(now);
  try {
    await syncAsAutoSyncUser(now);
  } catch (error) {
    recordAutoSyncFailure();
    throw error;
  }
}

/**
 * The stored user id is re-validated as an ACTIVE ADMIN at read time, never trusted from
 * whenever the setting was saved: a promotion can be undone and a user can be deactivated,
 * and neither currently clears simplefin_auto_sync_user_id. An invalid id never reaches
 * runSync -- it throws instead, which runSimplefinTick's catch turns into exactly the same
 * sync_failed alert a real sync failure would raise, naming the actual problem.
 */
async function syncAsAutoSyncUser(now: Date): Promise<void> {
  const raw = getSetting(SETTING_AUTO_SYNC_USER_ID);
  const userId = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(userId) || !adminUserIds().includes(userId)) {
    throw new Error('The automatic sync user is no longer an active admin. Re-save automatic sync in Settings → Connections.');
  }
  const result = await runSync({ userId, now });

  /*
    A BANK THAT DID NOT ANSWER IS A FAILURE HERE, even though the call itself succeeded (review E2).

    The manual sync page shows errlist to the person who pressed the button. This path has nobody
    watching it, and until now it alerted only when runSync THREW -- so the one sync nobody sees was
    also the one that reported nothing. The window no longer advances through a partial run
    (sync.ts), which means the data is recoverable; this is what makes it known.

    Thrown rather than enqueued directly, so it travels the same catch as every other failure and
    the household gets one kind of alert for one kind of problem.
  */
  if (result.errlist.length > 0) {
    throw new Error(`Some accounts did not sync: ${result.errlist.join('; ')}`);
  }
}

/**
 * v1.60.0 boot catch-up. A machine that was off at 02:00 (or for a week) used to wait for the next
 * 02:00. Checked once at boot: when the newest archive is over 26 hours old, or there is none, and
 * somebody has an account (a fresh install has nothing to protect yet), the nightly job runs
 * BACKUP_CATCH_UP_DELAY_MS later on an unref'd timer, so boot never waits on it and the timer never
 * holds the process open. It goes through runNightlyTick, so a failure raises the same alert.
 *
 * Called from startScheduler, which instrumentation-node runs only after the staged-restore boot
 * hook has finished (tests/ops/restore-seams pins that order). Returns whether a run was scheduled.
 */
export function scheduleBackupCatchUp(now: Date = new Date()): boolean {
  try {
    if (catchUpTimer !== null) return false;
    if (countUsers() === 0) return false;
    if (!backupCatchUpDue(newestBackupAt(), now)) return false;
  } catch (error) {
    console.error('[backup] boot catch-up check failed', error);
    return false;
  }
  catchUpTimer = setTimeout(runBackupCatchUp, BACKUP_CATCH_UP_DELAY_MS);
  catchUpTimer.unref?.();
  return true;
}

/**
 * Re-checks before running: the 02:00 job may have landed during the wait (no second run on top of
 * it), and a restore staged in that window owns the data directory until the restart applies it.
 */
function runBackupCatchUp(): void {
  catchUpTimer = null;
  const now = new Date();
  try {
    if (isRestorePending()) return;
    if (!backupCatchUpDue(newestBackupAt(), now)) return;
  } catch (error) {
    console.error('[backup] boot catch-up check failed', error);
    return;
  }
  console.log('[backup] no backup in the last 26 hours; running the nightly job now');
  runNightlyTick(now);
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
  // atBoot: slot catch-up still runs (MUST-6.1); budget/anomaly/savings-target alerts do not.
  // Reported 2026-09-08 -- a restart should not produce a burst of alerts.
  runNotifyTick(new Date(), { atBoot: true });
  // Task 8: same reasoning as the two ticks above -- a container that was off catches up on
  // a due auto-sync immediately at boot rather than waiting up to five minutes.
  runSimplefinTick();
  // v1.60.0: a missed nightly backup runs two minutes after boot, never during it.
  scheduleBackupCatchUp();
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
  if (catchUpTimer !== null) clearTimeout(catchUpTimer);
  catchUpTimer = null;
}

/**
 * True if ANY of the three registered tasks is still running, not just the nightly one,
 * so a regression that forgets to null out `ocrTask`/`notifyTask` in stopScheduler() makes
 * this report "still running" instead of silently agreeing with a partial teardown.
 */
export function isSchedulerRunning(): boolean {
  return task !== null || ocrTask !== null || notifyTask !== null;
}
