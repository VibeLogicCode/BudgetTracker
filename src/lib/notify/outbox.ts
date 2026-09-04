import { and, asc, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import {
  getSmtp,
  getSmtpPassword,
  getTarget,
  getTelegramToken,
  isEventEnabled,
  recordSmtpOutcome,
  recordTargetOutcome,
} from '@/lib/notify/config';
import { CREDENTIAL_UNREADABLE, NotifyCredentialError, authPlainBase64, scrubSecrets } from '@/lib/notify/crypto';
import { CHANNELS, householdDedupKey, isHouseholdEligible, type Channel } from '@/lib/notify/events';
import {
  householdTarget,
  getHouseholdTelegramToken,
  isHouseholdRouted,
  recordHouseholdTargetOutcome,
} from '@/lib/notify/household';
import { NotifyError, deliver, type DeliveryRequest } from '@/lib/notify/send';

/** §19.16: the numbers, in one place. */
export const OUTBOX_BATCH = 50;
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const PENDING_MAX_AGE_HOURS = 24;
/**
 * MUST-3.14/R3: must exceed the maximum `comingDueDays` window (365, the top of the 1-365
 * range in notification_user_settings) with margin. A shorter retention would let the sweep
 * delete a 'sent' coming_due row while the item is still inside the user's lookahead window,
 * resurrecting its dedup key and re-alerting on the same item every retention period.
 */
export const OUTBOX_RETENTION_DAYS = 400;

export const CHANNEL_REMOVED_ERROR = 'Channel was removed before delivery.';
export const PENDING_EXPIRED_ERROR = 'Not delivered within 24 hours.';
/** MUST-7.4: written on every row a broken channel group skips without attempting. */
export const DEFERRED_ERROR = 'Deferred: an earlier send this pass failed for this channel.';
/**
 * v1.28.0, the SEND-PATH half of the eligibility guard. setHouseholdEventPref refuses to route
 * an ineligible event, which covers every path through the app; this covers the one it cannot,
 * a row written straight into the database file. A queued household send whose event is not
 * household-eligible is killed here rather than delivered, so no hand edit can put a sign-in
 * alert into a family group chat.
 */
export const HOUSEHOLD_INELIGIBLE_ERROR = 'That event may not be sent to a family channel.';

/** MUST-7.6: 2, 4, 8, 16, 32, 64, 128, 256 minutes, capped at six hours. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, MAX_BACKOFF_MS);
}

/**
 * MUST-7.1: resolves the user's enabled channels for the event via isEventEnabled() and
 * inserts ONE ROW PER CHANNEL, each with ON CONFLICT DO NOTHING. Enqueueing is the only
 * place channel fan-out happens, so per-channel isolation is structural: two rows, two
 * independent lifecycles.
 *
 * MUST-7.2: subject and body are rendered by the CALLER, at evaluation time. Re-rendering
 * at send time after three retries would produce a "budget at 82%" alert that says 91%.
 */
export interface EnqueueResult {
  /** Personal rows actually inserted. Unchanged meaning since v1.3.0. */
  inserted: Channel[];
  /** Household rows actually inserted by THIS call. Empty on the second member's call. */
  household: Channel[];
  /** Channels where the personal send was suppressed because the family channel took it. */
  suppressed: Channel[];
}

export function enqueue(input: {
  userId: number;
  eventId: string;
  dedupKey: string;
  subject: string;
  body: string;
  /**
   * v1.28.0. WHOSE MONEY this message is about, which is not the same question as who receives
   * it. 'household' (the default, and true of almost every event) may be routed to the family
   * channel; 'personal' NEVER is, whatever an admin has switched on.
   *
   * This is load-bearing, not belt-and-braces. budgetThresholdKey/budgetPaceKey carry a scope
   * letter but NO user id -- user_id is already part of the unique index (MUST-3.11) -- so two
   * members' PERSONAL budget alerts for the same category and month share a dedup key. Routed to
   * the household channel they would collapse into one row under user_id NULL: the group would
   * get whichever member fired first, labelled as a personal budget, and the other member's
   * alert would vanish silently. A personal budget is also nobody else's business.
   */
  subjectScope?: 'household' | 'personal';
  /**
   * The message the FAMILY channel gets, when it differs from the personal one. Omit it and the
   * household send reuses `subject`/`body` verbatim, which is right for every event that already
   * describes the household ("Groceries is over budget" reads the same to one person or five).
   * Only the weekly digest differs, because a personal digest names YOUR spend and a household
   * one names everybody's (evaluate/digest.ts).
   *
   * `dedupKey` overrides the key for the household row only. Supply one when the personal key
   * varies per member -- again only the digest, whose key carries the firing member's own slot
   * date (householdWeeklyDigestKey's docblock has the argument).
   */
  household?: { subject: string; body: string; dedupKey?: string };
  /**
   * v1.30.0 (S-18 fix, round 1). "This recipient contributes the FAMILY-CHANNEL row, but must
   * receive no personal copy of it." Set for a SELF-SCOPED recipient on a household-scope send
   * (evaluate/budget.ts, evaluate/pace.ts, evaluate/savings.ts): household figures are the
   * room's business and stay the room's, while the member's own inbox gets nothing carrying
   * them (v1.13.0 ruling R2).
   *
   * The distinction has to live HERE, not at the call site, because the routed/personal split is
   * PER CHANNEL and this loop is the only place that knows it. Round 0 of the S-18 fix skipped
   * the whole household send for a self-scoped participant instead, which on a routed channel
   * removed their contribution to the family channel and protected nobody -- in a household
   * where every participant with the event enabled is self-scoped, family budget alerts stopped
   * entirely. The other rejected shape, gating the call on householdRoutedChannels() at the
   * evaluator, still leaks on the OTHER channel whenever an admin has routed an event to one of
   * the two and not both.
   *
   * Meaningless together with subjectScope 'personal': nothing is routable, so nothing at all
   * would be enqueued. No caller pairs them, and none should -- a personal-scope send carries no
   * household figure to withhold in the first place.
   */
  familyChannelOnly?: boolean;
  at?: Date;
}): EnqueueResult {
  const db = getDb();
  const at = nowIso(input.at ?? new Date());
  const inserted: Channel[] = [];
  const household: Channel[] = [];
  const suppressed: Channel[] = [];
  const routable = (input.subjectScope ?? 'household') === 'household';

  for (const channel of CHANNELS) {
    // v1.28.0, decision 4: the family channel REPLACES the personal one for a routed event. Per
    // channel, so routing the digest to the family Telegram leaves everybody's email digest
    // alone. The suppression is unconditional -- it does not consult isEventEnabled -- because
    // the household row is the household's decision, not the sum of five people's toggles, and
    // a member who has the event switched off must not be able to conjure a second copy into
    // the group by switching it on.
    if (routable && isHouseholdRouted(input.eventId, channel)) {
      suppressed.push(channel);
      // MUST-3.9 holds unchanged for the family channel: the row IS the guard. The unique index
      // is (COALESCE(user_id, -1), channel, dedup_key), so every member's evaluation this week
      // aims at the same slot and only the first one lands. That is what makes "two members,
      // same event, routed" one message rather than two.
      const result = db
        .insert(notificationOutbox)
        .values({
          userId: null,
          channel,
          eventId: input.eventId,
          dedupKey: householdDedupKey(input.household?.dedupKey ?? input.dedupKey),
          subject: input.household?.subject ?? input.subject,
          body: input.household?.body ?? input.body,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: at,
          createdAt: at,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) household.push(channel);
      continue;
    }

    // Not routed on this channel, so the only row it could produce is the PERSONAL one -- and
    // that is exactly the delivery familyChannelOnly exists to withhold. Placed after the routed
    // branch above, never before it: the family-channel row must still be written.
    if (input.familyChannelOnly) continue;

    if (!isEventEnabled(input.userId, input.eventId, channel)) continue;
    // MUST-3.9: the row that was sent IS the dedup guard. `changes === 0` means
    // "already fired": there is no separate bookkeeping that could drift.
    const result = db
      .insert(notificationOutbox)
      .values({
        userId: input.userId,
        channel,
        eventId: input.eventId,
        dedupKey: input.dedupKey,
        subject: input.subject,
        body: input.body,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        createdAt: at,
      })
      .onConflictDoNothing()
      .run();
    if (result.changes > 0) inserted.push(channel);
  }

  return { inserted, household, suppressed };
}

/**
 * "Did this call put anything on the wire?" -- the question every evaluator's `fired` counter is
 * actually asking. It has to count the household row too: once the weekly digest is routed, no
 * member ever gets a personal row for it, and an evaluator reading `inserted.length` alone would
 * report that it enqueued nothing on the very tick it enqueued the family digest.
 */
export function enqueuedAnything(result: EnqueueResult): boolean {
  return result.inserted.length > 0 || result.household.length > 0;
}

/** MUST-6.4: the other half of the dormancy bail. */
export function countPendingOutbox(): number {
  const row = getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.status, 'pending'))
    .get();
  return row?.n ?? 0;
}

/**
 * MUST-7.8: on the first tick after boot, every pending row older than 24 hours is
 * abandoned. This covers a container that was off for a week, and also a RESTORED OLDER
 * DATABASE whose outbox still holds rows that were pending when the backup was taken;
 * without it a restore would emit a flood of stale alerts about a world that no longer
 * exists.
 */
export function expireStalePending(now: Date = new Date()): number {
  const cutoff = nowIso(new Date(now.getTime() - PENDING_MAX_AGE_HOURS * 60 * 60 * 1000));
  const result = getDb()
    .update(notificationOutbox)
    .set({ status: 'failed', lastError: PENDING_EXPIRED_ERROR })
    .where(and(eq(notificationOutbox.status, 'pending'), lt(notificationOutbox.createdAt, cutoff)))
    .run();
  return result.changes;
}

/** MUST-3.14: the sixth purge in runMaintenanceSweep(). */
export function purgeOldOutboxRows(at: Date = new Date()): number {
  const cutoff = nowIso(new Date(at.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000));
  const result = getDb()
    .delete(notificationOutbox)
    .where(and(inArray(notificationOutbox.status, ['sent', 'failed']), lt(notificationOutbox.createdAt, cutoff)))
    .run();
  return result.changes;
}

export interface DeliveryRow {
  id: number;
  /** v1.28.0: NULL is a household send -- one message to the family channel, addressed to
   *  nobody. Render it with a household label, never by looking a user up. */
  userId: number | null;
  channel: Channel;
  eventId: string;
  subject: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/**
 * §11.6: served by notification_outbox_user_idx. `userId: null` is the admin's view.
 *
 * v1.28.0: household sends carry user_id NULL, so they appear in the admin's household-wide
 * view and NOT in a member's own list. That is deliberate rather than incidental: the family
 * channel is configured by an admin and its deliveries are the admin's to diagnose, and a
 * member's list is "what was sent to me", which a group-chat message is not.
 */
export function listRecentDeliveries(input: { userId: number | null; limit?: number }): DeliveryRow[] {
  const limit = input.limit ?? 20;
  const base = getDb()
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      channel: notificationOutbox.channel,
      eventId: notificationOutbox.eventId,
      subject: notificationOutbox.subject,
      status: notificationOutbox.status,
      attempts: notificationOutbox.attempts,
      lastError: notificationOutbox.lastError,
      createdAt: notificationOutbox.createdAt,
      sentAt: notificationOutbox.sentAt,
    })
    .from(notificationOutbox);
  const rows =
    input.userId === null
      ? base.orderBy(desc(notificationOutbox.id)).limit(limit).all()
      : base.where(eq(notificationOutbox.userId, input.userId)).orderBy(desc(notificationOutbox.id)).limit(limit).all();
  return rows;
}

type PendingRow = {
  id: number;
  /** NULL = the household channel (v1.28.0). */
  userId: number | null;
  channel: Channel;
  eventId: string;
  subject: string;
  body: string;
  attempts: number;
};

/**
 * MUST-7.5: pre-send revalidation. Re-reads the row's target immediately before sending.
 * If the target is gone or disabled, or (for email) the relay is gone or disabled, NOTHING
 * IS SENT. Removing a channel therefore stops egress at once, including for rows already
 * in the queue: the dormancy rule holds even with a full outbox.
 *
 * Returns the request to send, or null with the reason the row is dead.
 */
function buildRequest(row: PendingRow): { request: DeliveryRequest } | { dead: string } {
  // v1.28.0: `userId` is narrowed once here rather than re-tested (and re-cast) at every use.
  const { userId } = row;
  // The send-path eligibility guard. Checked BEFORE the target is resolved, so a hand-written
  // household row for a security event dies without the family channel ever being looked up, let
  // alone connected to.
  if (userId === null && !isHouseholdEligible(row.eventId)) return { dead: HOUSEHOLD_INELIGIBLE_ERROR };

  const target = userId === null ? householdTarget(row.channel) : getTarget(userId, row.channel);
  if (!target || !target.enabled) return { dead: CHANNEL_REMOVED_ERROR };

  if (row.channel === 'telegram') {
    let botToken: string;
    try {
      // MUST-3.5: the FAMILY channel's own token for a household send, never a member's. The
      // household bot is the one that was actually added to the group chat, so a member's token
      // would fail with "chat not found" even if using it were acceptable, which it is not.
      botToken = userId === null ? getHouseholdTelegramToken() : getTelegramToken(userId);
    } catch (error) {
      if (error instanceof NotifyCredentialError) return { dead: error.message };
      throw error;
    }
    return {
      request: { channel: 'telegram', destination: target.destination, botToken, subject: row.subject, body: row.body },
    };
  }

  // NOT the same as the re-read removed from runTest in v1.3.1 (spec MUST-17.7/17.8). THIS one
  // is live and mandated by MUST-7.5's pre-send revalidation: enqueue and pump are separated in
  // time -- minutes, or hours across a retry ladder -- so the relay genuinely can be changed or
  // removed in between. Do not "simplify" it by analogy with runTest's.
  const relay = getSmtp();
  if (!relay || !relay.enabled) return { dead: CHANNEL_REMOVED_ERROR };
  let password: string;
  try {
    password = getSmtpPassword();
  } catch (error) {
    if (error instanceof NotifyCredentialError) return { dead: error.message };
    throw error;
  }
  return {
    request: {
      channel: 'email',
      destination: target.destination,
      smtp: {
        host: relay.host,
        port: relay.port,
        security: relay.security,
        username: relay.username,
        password,
        fromEmail: relay.fromEmail,
        fromName: relay.fromName,
      },
      subject: row.subject,
      body: row.body,
    },
  };
}

/**
 * MUST-7.10's one dispatch point. A household row has no user to record an outcome against, so
 * it records against the household target instead -- and every caller in drain() goes through
 * here rather than reaching for row.userId, so neither branch can be forgotten in one place and
 * remembered in another.
 */
function recordOutcomeForRow(
  row: PendingRow,
  outcome: { ok: boolean; error?: string; at: Date },
): void {
  if (row.userId === null) {
    recordHouseholdTargetOutcome({ channel: row.channel, ...outcome });
    return;
  }
  recordTargetOutcome({ userId: row.userId, channel: row.channel, ...outcome });
}

/** MUST-5.5: everything written to last_error goes through here first. */
function scrubForRow(message: string, request: DeliveryRequest | null): string {
  if (!request) return message;
  const secrets =
    request.channel === 'telegram'
      ? [request.botToken]
      : [request.smtp.password, authPlainBase64(request.smtp.username, request.smtp.password)];
  return scrubSecrets(message, secrets);
}

function markSent(id: number, attempts: number, at: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ status: 'sent', attempts, sentAt: at, lastError: null })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function markFailed(id: number, attempts: number, message: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ status: 'failed', attempts, lastError: message })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function markRetry(id: number, attempts: number, message: string, nextAt: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ attempts, lastError: message, nextAttemptAt: nextAt })
    .where(eq(notificationOutbox.id, id))
    .run();
}

function deferRow(id: number, nextAt: string): void {
  getDb()
    .update(notificationOutbox)
    .set({ nextAttemptAt: nextAt, lastError: DEFERRED_ERROR })
    .where(eq(notificationOutbox.id, id))
    .run();
}

/**
 * MUST-6.3: single-flight, the pump: Promise<void> | null pattern of
 * src/lib/warranty/ocr/queue.ts, verbatim. A tick that arrives while the previous one is
 * still draining returns immediately.
 */
let pump: Promise<{ sent: number; failed: number; deferred: number }> | null = null;

export function resetOutboxPumpForTests(): void {
  pump = null;
}

export async function drainOutboxForTests(): Promise<void> {
  while (pump !== null) {
    await pump;
  }
}

export function pumpOutbox(now: Date = new Date()): Promise<{ sent: number; failed: number; deferred: number }> {
  if (pump !== null) return Promise.resolve({ sent: 0, failed: 0, deferred: 0 });
  const run = drain(now).finally(() => {
    pump = null;
  });
  pump = run;
  return run;
}

/** Fire-and-forget kick used by the immediate raisers (§6.6) and the server actions. */
export function kickOutbox(now?: Date): void {
  void pumpOutbox(now).catch((error) => {
    console.error('[notify] outbox pump failed', error);
  });
}

async function drain(now: Date): Promise<{ sent: number; failed: number; deferred: number }> {
  const at = nowIso(now);
  // MUST-7.3: served by notification_outbox_due_idx.
  const rows = getDb()
    .select({
      id: notificationOutbox.id,
      userId: notificationOutbox.userId,
      channel: notificationOutbox.channel,
      eventId: notificationOutbox.eventId,
      subject: notificationOutbox.subject,
      body: notificationOutbox.body,
      attempts: notificationOutbox.attempts,
    })
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.status, 'pending'), lte(notificationOutbox.nextAttemptAt, at)))
    .orderBy(asc(notificationOutbox.id))
    .limit(OUTBOX_BATCH)
    .all();

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  // MUST-7.3: grouped by channel, each group inside its own try/catch. A Telegram group
  // that throws at the transport level cannot touch a single email row, and vice versa.
  for (const channel of CHANNELS) {
    const group = rows.filter((row) => row.channel === channel);
    if (group.length === 0) continue;

    try {
      let broken: string | null = null;
      let brokenNextAt = at;

      for (const row of group) {
        if (broken !== null) {
          // MUST-7.4: the per-channel circuit break. Every remaining row is deferred to
          // the same next_attempt_at WITHOUT being attempted, so a dead relay cannot cost
          // 50 × 15 s of connect timeouts inside one tick.
          deferRow(row.id, brokenNextAt);
          deferred += 1;
          continue;
        }

        const built = buildRequest(row);
        if ('dead' in built) {
          // MUST-7.10: an unreadable credential (a rotated SECRET_KEY, a tampered ciphertext)
          // is still an outcome worth surfacing in Settings, unlike CHANNEL_REMOVED_ERROR
          // where the target/relay row is simply gone and there is nothing left to record it
          // on.
          if (built.dead === CREDENTIAL_UNREADABLE) {
            if (channel === 'telegram') {
              recordOutcomeForRow(row, { ok: false, error: CREDENTIAL_UNREADABLE, at: now });
            } else {
              recordSmtpOutcome({ ok: false, error: CREDENTIAL_UNREADABLE, at: now });
            }
          }
          markFailed(row.id, row.attempts, built.dead);
          failed += 1;
          continue;
        }

        const attempts = row.attempts + 1;
        try {
          await deliver(built.request);
          markSent(row.id, attempts, at);
          recordOutcomeForRow(row, { ok: true, at: now });
          if (channel === 'email') recordSmtpOutcome({ ok: true, at: now });
          sent += 1;
        } catch (error) {
          const notifyError =
            error instanceof NotifyError
              ? error
              : new NotifyError(error instanceof Error ? error.message : 'Send failed.', { permanent: false });
          const message = scrubForRow(notifyError.message, built.request);

          if (notifyError.scope === 'relay') recordSmtpOutcome({ ok: false, error: message, at: now });
          else recordOutcomeForRow(row, { ok: false, error: message, at: now });

          if (notifyError.permanent) {
            // MUST-7.7: skip backoff entirely and fail on the first attempt.
            markFailed(row.id, attempts, message);
            failed += 1;
            console.error(`[notify] permanent ${channel} failure on row ${row.id}: ${message}`);
            continue;
          }

          const waitMs = notifyError.retryAfterMs ?? backoffMs(attempts);
          const nextAt = nowIso(new Date(now.getTime() + waitMs));
          if (attempts >= MAX_ATTEMPTS) {
            markFailed(row.id, attempts, message);
            failed += 1;
          } else {
            markRetry(row.id, attempts, message, nextAt);
          }
          broken = message;
          brokenNextAt = nextAt;
        }
      }
    } catch (error) {
      // A genuine bug in the group loop must not stop the other channel.
      console.error(`[notify] ${channel} group aborted`, error);
    }
  }

  // MUST-7.11: one summary line per NON-EMPTY run. Never a subject, never a body, never a
  // credential.
  if (sent + failed + deferred > 0) console.log(`[notify] sent ${sent}, failed ${failed}, deferred ${deferred}`);
  return { sent, failed, deferred };
}
