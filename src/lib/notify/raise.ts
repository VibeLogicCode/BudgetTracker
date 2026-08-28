import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { readEnv } from '@/lib/env';
import { readRestoreState } from '@/lib/backup/restore';
import { todayIso } from '@/lib/dates';
import { adminUserIds } from '@/lib/notify/config';
import {
  backupFailedKey,
  mfaDisabledKey,
  newSigninKey,
  passwordChangedKey,
  restoreOutcomeKey,
  syncFailedKey,
} from '@/lib/notify/events';
import { enqueue, kickOutbox } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * §6.6: the three immediate raisers.
 *
 * MUST-6.19: each MUST NEVER THROW into its caller and each is wrapped internally in
 * try/catch: a notification failure may not break a login, a boot, or a backup.
 *
 * MUST-6.2: each enqueues (a synchronous SQLite insert) and then kicks the sender pump
 * WITHOUT awaiting it, so a sign-in alert leaves the box in seconds rather than waiting up
 * to five minutes for the tick.
 */

/**
 * MUST-14.2: result.json persists on disk across boots, so without this guard an
 * outbox row aging out under the 400-day sweep would let a months-old restore re-notify.
 * This is the single case where MUST-3.12's pruning-safety argument needs an explicit
 * guard rather than following from the key's shape.
 */
export const RESTORE_NOTIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

export function raiseNewSignin(input: {
  userId: number;
  at: Date;
  ip: string;
  userAgent: string | null;
  sessionCreatedAt: string;
}): void {
  try {
    const { tz } = readEnv();
    const atLabel = `${todayIso(input.at, tz)} ${new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(input.at)}`;

    const { subject, body } = renderEvent({
      event: 'new_signin',
      name: signinName(input.userId),
      atLabel,
      tz,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    const result = enqueue({
      userId: input.userId,
      eventId: 'new_signin',
      dedupKey: newSigninKey(input.sessionCreatedAt),
      subject,
      body,
      at: input.at,
    });
    if (result.inserted.length > 0) kickOutbox(input.at);
  } catch (error) {
    console.error('[notify] new sign-in raise failed', error);
  }
}

function signinName(userId: number): string {
  const row = getDb().select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  return row?.name ?? 'Somebody';
}

/**
 * v1.12.1 (item AA / SEC-4). The account-security pair, raised from
 * src/app/(app)/settings/actions.ts. Same three properties as raiseNewSignin, for the same
 * reasons: it NEVER throws into its caller (MUST-6.19 -- a notification failure may not break a
 * password change), it enqueues synchronously and kicks the pump without awaiting it (MUST-6.2),
 * and its dedup key is a never-recurring timestamp (MUST-3.12).
 */
export function raiseAccountSecurityEvent(input: {
  userId: number;
  event: 'password_changed' | 'mfa_disabled';
  at: Date;
}): void {
  try {
    const { tz } = readEnv();
    const atLabel = `${todayIso(input.at, tz)} ${new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(input.at)}`;
    const atIso = input.at.toISOString();

    const { subject, body } = renderEvent({
      event: input.event,
      name: signinName(input.userId),
      atLabel,
      tz,
    });

    const result = enqueue({
      userId: input.userId,
      eventId: input.event,
      dedupKey: input.event === 'mfa_disabled' ? mfaDisabledKey(atIso) : passwordChangedKey(atIso),
      subject,
      body,
      at: input.at,
    });
    if (result.inserted.length > 0) kickOutbox(input.at);
  } catch (error) {
    console.error(`[notify] ${input.event} raise failed`, error);
  }
}

/**
 * MUST-14.1: raised from the SCHEDULER's existing catch around runNightlyJob, not from
 * src/lib/backup.ts, so the backup module acquires no notify import and its tests are
 * untouched. Settings → Backups' "run now" deliberately does NOT notify: an admin standing
 * in front of the result page does not need to be emailed about it.
 *
 * MUST-4.3: audience 'admin', so this fans out to active admins only.
 */
export function raiseBackupFailed(input: { error: unknown; at: Date }): void {
  try {
    const { tz } = readEnv();
    const dateIso = todayIso(input.at, tz);
    // A backup error carries no credential material (it never touches the notify transport
    // layer), so there is nothing here for scrubSecrets to redact; anything transport-related
    // that later flows through the outbox is re-scrubbed there (MUST-5.5).
    const { subject, body } = renderEvent({
      event: 'backup_failed',
      dateIso,
      error: messageOf(input.error, 'The backup job failed without an error message.'),
    });
    let queued = 0;
    for (const userId of adminUserIds()) {
      queued += enqueue({
        userId,
        eventId: 'backup_failed',
        dedupKey: backupFailedKey(dateIso),
        subject,
        body,
        at: input.at,
      }).inserted.length;
    }
    if (queued > 0) kickOutbox(input.at);
  } catch (error) {
    console.error('[notify] backup failure raise failed', error);
  }
}

/**
 * MUST-14.2: called from src/instrumentation-node.ts, AFTER getDb() (the outcome has to be
 * written into the restored database) and BEFORE startScheduler() (whose immediate boot
 * tick then drains the row).
 */
export function raiseRestoreOutcome(now: Date = new Date()): void {
  try {
    const outcome = readRestoreState().result;
    if (!outcome) return;

    const finishedMs = Date.parse(outcome.finishedAt);
    if (!Number.isFinite(finishedMs) || now.getTime() - finishedMs > RESTORE_NOTIFY_MAX_AGE_MS) return;

    const { subject, body } = renderEvent({
      event: 'restore_outcome',
      status: outcome.status,
      sourceName: outcome.sourceName,
      requestedByUsername: outcome.requestedByUsername,
      finishedAt: outcome.finishedAt,
      receiptsRestored: outcome.receiptsRestored,
      missingReceiptRows: outcome.missingReceiptRows,
      error: outcome.error,
    });

    let queued = 0;
    for (const userId of adminUserIds()) {
      queued += enqueue({
        userId,
        eventId: 'restore_outcome',
        dedupKey: restoreOutcomeKey(outcome.finishedAt),
        subject,
        body,
        at: now,
      }).inserted.length;
    }
    if (queued > 0) kickOutbox(now);
  } catch (error) {
    console.error('[notify] restore outcome raise failed', error);
  }
}

/**
 * Task 8 (v1.7.0): raised from src/lib/scheduler.ts's runSimplefinTick, either when runSync
 * itself throws/rejects, or when the stored auto-sync user id no longer resolves to an active
 * admin (in which case the scheduler never calls runSync at all -- see the message it builds
 * for that case).
 *
 * SECURITY, non-negotiable: the SimpleFIN access URL is a bearer credential for the user's
 * bank data and must never appear in a notification or a log line. This raiser reads ONLY
 * error.message off the thrown value via messageOf() below -- never .stack, never a
 * re-serialised copy of the whole error or of the connection it was acting on -- so whatever
 * SimplefinError/Error message the sync layer produced (which by construction, see
 * simplefin/client.ts and simplefin/connection.ts, never embeds the access URL) is the only
 * dynamic text that can reach the subject or body.
 *
 * MUST-4.3: audience 'admin', so this fans out to active admins only, same as
 * raiseBackupFailed above.
 */
export function raiseSyncFailed(input: { error: unknown; at: Date }): void {
  try {
    const { tz } = readEnv();
    const dateIso = todayIso(input.at, tz);
    const { subject, body } = renderEvent({
      event: 'sync_failed',
      dateIso,
      error: messageOf(input.error, 'The SimpleFIN sync failed without an error message.'),
    });
    let queued = 0;
    for (const userId of adminUserIds()) {
      queued += enqueue({
        userId,
        eventId: 'sync_failed',
        dedupKey: syncFailedKey(dateIso),
        subject,
        body,
        at: input.at,
      }).inserted.length;
    }
    if (queued > 0) kickOutbox(input.at);
  } catch (error) {
    console.error('[notify] sync failure raise failed', error);
  }
}
