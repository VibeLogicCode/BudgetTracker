import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationHouseholdPrefs, notificationSmtp, notificationTargets, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { TELEGRAM_HKDF_INFO, decryptSecret, encryptSecret } from '@/lib/notify/crypto';
import {
  CHANNELS,
  householdEligibleEvents,
  isHouseholdEligible,
  type Channel,
  type NotificationEventDef,
  type TargetScope,
} from '@/lib/notify/events';

export { householdEligibleEvents, type TargetScope };

/**
 * v1.28.0, the household channel layer (spec §3.3 as amended by drizzle/0021).
 *
 * WHY THIS EXISTS. notification_targets was one row per person per channel, so the only way to
 * reach a group chat both partners sit in was to point a PERSONAL target at it -- and doing that
 * for both people made the group receive two of every message, because enqueue() fans out per
 * user (MUST-7.1). The household now owns exactly ONE Telegram and ONE email, enforced by the
 * partial unique index `(channel) WHERE scope = 'household'` rather than by convention, and a
 * routed event is sent once to that channel and suppressed for every member's personal one.
 *
 * SERVER ONLY (MUST-2.2): this module imports @/db, so it is never imported from a *-client.tsx.
 * The client-safe half -- householdEligibleEvents(), TargetScope -- lives in events.ts and is
 * re-exported above so the settings lane has one import path for the whole contract.
 */

/**
 * The safe projection of a notification_targets row. MUST-5.3: `secretSet` says THAT a bot token
 * exists; the token itself never leaves this module, and the only function that decrypts one
 * (getHouseholdTelegramToken) hands it straight to the transport.
 */
export interface NotificationTargetRow {
  id: number;
  scope: TargetScope;
  /** NULL on a household row: the family channel belongs to nobody in particular. */
  userId: number | null;
  /** Audit only, and NULL once that admin is deleted. The channel outlives them (drizzle/0021). */
  createdByUserId: number | null;
  channel: Channel;
  destination: string;
  /** MUST-5.3: never the token itself. */
  secretSet: boolean;
  enabled: boolean;
  verifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
}

/** MUST-19.11, one wording per rule. Returned as `reason`, never thrown at a page. */
export const NOT_ADMIN_ERROR = 'Only an admin can set up a family channel.';
export const NO_DESTINATION_ERROR = 'A family channel needs a destination.';
export const TELEGRAM_SECRET_REQUIRED = 'A family Telegram channel needs its own bot token.';
export const EMAIL_SECRET_REFUSED = 'An email channel never carries a secret.';
export const NOT_HOUSEHOLD_ELIGIBLE = 'That event cannot be sent to a family channel.';

function toRow(row: typeof notificationTargets.$inferSelect): NotificationTargetRow {
  return {
    id: row.id,
    scope: row.scope,
    userId: row.userId,
    createdByUserId: row.createdByUserId,
    channel: row.channel,
    destination: row.destination,
    secretSet: (row.secretEncrypted ?? '').length > 0,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastSuccessAt: row.lastSuccessAt,
  };
}

/**
 * `scope = 'household'` AND `user_id IS NULL` are the same fact -- the pairing CHECK in
 * drizzle/0021 makes them inseparable -- but both are written here on purpose. Either one alone
 * would silently start matching personal rows if the other were ever relaxed, and this predicate
 * is what stands between the family channel and a member's private one on every read below.
 */
function householdWhere(channel?: Channel) {
  const base = and(eq(notificationTargets.scope, 'household'), isNull(notificationTargets.userId));
  return channel === undefined ? base : and(base, eq(notificationTargets.channel, channel));
}

/** The one household target for this channel, or null when the household has not set one. */
export function householdTarget(channel: Channel): NotificationTargetRow | null {
  const row = getDb().select().from(notificationTargets).where(householdWhere(channel)).get();
  return row ? toRow(row) : null;
}

export function listHouseholdTargets(): NotificationTargetRow[] {
  return getDb()
    .select()
    .from(notificationTargets)
    .where(householdWhere())
    .orderBy(asc(notificationTargets.channel))
    .all()
    .map(toRow);
}

function isActiveAdmin(userId: number): boolean {
  const row = getDb()
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.isActive === true && row.role === 'admin';
}

/**
 * Create or update the household's channel. Returns a reason rather than throwing, so the
 * settings action can render it beside the field (the shape every notify write path already
 * uses).
 *
 * MUST-5.6, matching saveTelegramTarget: `secret: null | undefined` means "keep the stored
 * token", so re-saving a destination never requires re-typing the bot token, and a token can
 * never be blanked by omission. Creating a Telegram channel without one is refused here rather
 * than left to fail the SQL pairing CHECK, because a CHECK violation reaches the user as a
 * stack trace.
 *
 * The admin check is defence in depth, not the primary gate -- the server action owns that --
 * but this function is the ONE place any caller funnels through to write a household row, and
 * "an admin decides" is a rule of the feature rather than of one page.
 */
export function upsertHouseholdTarget(input: {
  channel: Channel;
  destination: string;
  secret?: string | null;
  actorUserId: number;
  at?: Date;
}): { ok: true; id: number } | { ok: false; reason: string } {
  if (!isActiveAdmin(input.actorUserId)) return { ok: false, reason: NOT_ADMIN_ERROR };

  const destination = input.destination.trim();
  if (destination.length === 0) return { ok: false, reason: NO_DESTINATION_ERROR };

  const supplied = typeof input.secret === 'string' && input.secret.length > 0 ? input.secret : null;
  if (input.channel === 'email' && supplied !== null) return { ok: false, reason: EMAIL_SECRET_REFUSED };

  const db = getDb();
  const at = nowIso(input.at ?? new Date());
  const existing = db
    .select({
      id: notificationTargets.id,
      destination: notificationTargets.destination,
      secretEncrypted: notificationTargets.secretEncrypted,
    })
    .from(notificationTargets)
    .where(householdWhere(input.channel))
    .get();

  const secretEncrypted =
    input.channel === 'email'
      ? null
      : supplied !== null
        ? encryptSecret(supplied, TELEGRAM_HKDF_INFO)
        : (existing?.secretEncrypted ?? null);
  if (input.channel === 'telegram' && secretEncrypted === null) {
    return { ok: false, reason: TELEGRAM_SECRET_REQUIRED };
  }

  if (existing) {
    // A changed destination or a re-typed token invalidates the previous Send test, exactly as
    // upsertTarget's resetVerified does for a personal row.
    const resetVerified = existing.destination !== destination || supplied !== null;
    db.update(notificationTargets)
      .set({
        destination,
        secretEncrypted,
        enabled: true,
        updatedAt: at,
        ...(resetVerified ? { verifiedAt: null } : {}),
      })
      .where(eq(notificationTargets.id, existing.id))
      .run();
    return { ok: true, id: existing.id };
  }

  const inserted = db
    .insert(notificationTargets)
    .values({
      userId: null,
      scope: 'household',
      createdByUserId: input.actorUserId,
      channel: input.channel,
      destination,
      secretEncrypted,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: notificationTargets.id })
    .get();
  return { ok: true, id: inserted.id };
}

/**
 * Removing the family channel does NOT clear notification_household_prefs. isHouseholdRouted()
 * already returns false with no enabled target, so every routed event falls straight back to
 * personal delivery; keeping the rows means re-adding the channel restores the routing the admin
 * chose rather than silently resetting it, which is the same reasoning MUST-3.6 gives for never
 * deleting an unknown event's pref row.
 */
export function deleteHouseholdTarget(channel: Channel): boolean {
  return getDb().delete(notificationTargets).where(householdWhere(channel)).run().changes > 0;
}

/** MUST-3.5's household counterpart: the FAMILY channel's own token, never a member's. */
export function getHouseholdTelegramToken(): string {
  const row = getDb()
    .select({ payload: notificationTargets.secretEncrypted })
    .from(notificationTargets)
    .where(householdWhere('telegram'))
    .get();
  if (!row || row.payload === null) throw new Error('no Telegram token is stored for the household');
  return decryptSecret(row.payload, TELEGRAM_HKDF_INFO);
}

/** MUST-7.10's household counterpart: an outcome an admin can see on the settings page. */
export function recordHouseholdTargetOutcome(input: {
  channel: Channel;
  ok: boolean;
  error?: string;
  verify?: boolean;
  at?: Date;
}): void {
  const at = nowIso(input.at ?? new Date());
  getDb()
    .update(notificationTargets)
    .set(
      input.ok
        ? {
            lastError: null,
            lastErrorAt: null,
            lastSuccessAt: at,
            updatedAt: at,
            ...(input.verify ? { verifiedAt: at } : {}),
          }
        : { lastError: input.error ?? 'Send failed.', lastErrorAt: at, updatedAt: at },
    )
    .where(householdWhere(input.channel))
    .run();
}

/**
 * The routing matrix, over ELIGIBLE events only. Every eligible event appears, so the settings
 * matrix renders straight from this; a stored row for an ineligible id (a downgrade, or a hand
 * edit) is neither read nor deleted, which is MUST-3.6's rule applied unchanged.
 */
export function householdEventPrefs(): Record<string, { telegram: boolean; email: boolean }> {
  const stored = new Map<string, boolean>();
  for (const row of getDb().select().from(notificationHouseholdPrefs).all()) {
    stored.set(`${row.eventId}:${row.channel}`, row.enabled);
  }
  const out: Record<string, { telegram: boolean; email: boolean }> = {};
  for (const event of householdEligibleEvents()) {
    out[event.id] = {
      telegram: stored.get(`${event.id}:telegram`) ?? false,
      email: stored.get(`${event.id}:email`) ?? false,
    };
  }
  return out;
}

/**
 * WRITE-PATH GUARD. An ineligible event is refused here, so a security event cannot be routed
 * to a group chat through the UI, through a server action, or through any future caller. The
 * send path refuses it a second time (src/lib/notify/outbox.ts), which is what covers the case
 * this guard cannot: a row written directly into the database file.
 *
 * Sparse, like applyPref: the default is "not routed", so switching a route back off DELETES the
 * row rather than storing `enabled = 0`. An absent table therefore means exactly what a fresh
 * install means.
 */
export function setHouseholdEventPref(input: {
  eventId: string;
  channel: Channel;
  enabled: boolean;
  at?: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (!isHouseholdEligible(input.eventId)) return { ok: false, reason: NOT_HOUSEHOLD_ELIGIBLE };

  const db = getDb();
  if (!input.enabled) {
    db.delete(notificationHouseholdPrefs)
      .where(
        and(
          eq(notificationHouseholdPrefs.eventId, input.eventId),
          eq(notificationHouseholdPrefs.channel, input.channel),
        ),
      )
      .run();
    return { ok: true };
  }

  const at = nowIso(input.at ?? new Date());
  db.insert(notificationHouseholdPrefs)
    .values({ eventId: input.eventId, channel: input.channel, enabled: true, updatedAt: at })
    .onConflictDoUpdate({
      target: [notificationHouseholdPrefs.eventId, notificationHouseholdPrefs.channel],
      set: { enabled: true, updatedAt: at },
    })
    .run();
  return { ok: true };
}

/**
 * The one predicate enqueue() consults, and the household mirror of isEventEnabled()'s five
 * conditions (§4.3). There is no user, so there is no active-user check and no role check --
 * the family channel is not a person. The audience rule still holds implicitly: every
 * household-eligible event has audience 'all' (asserted in tests/lib/notify/events.test.ts).
 *
 *   1. the event exists AND is household-eligible (the registry, not the database),
 *   2. an admin has routed it to this channel,
 *   3. an ENABLED household target exists for the channel, per MUST-4.2,
 *   4. for channel 'email', an ENABLED notification_smtp row exists.
 */
export function isHouseholdRouted(eventId: string, channel: Channel): boolean {
  if (!isHouseholdEligible(eventId)) return false;

  const db = getDb();
  const pref = db
    .select({ enabled: notificationHouseholdPrefs.enabled })
    .from(notificationHouseholdPrefs)
    .where(
      and(eq(notificationHouseholdPrefs.eventId, eventId), eq(notificationHouseholdPrefs.channel, channel)),
    )
    .get();
  if (pref?.enabled !== true) return false;

  const target = db
    .select({ enabled: notificationTargets.enabled })
    .from(notificationTargets)
    .where(householdWhere(channel))
    .get();
  if (!target || !target.enabled) return false;

  if (channel === 'email') {
    const relay = db
      .select({ enabled: notificationSmtp.enabled })
      .from(notificationSmtp)
      .where(eq(notificationSmtp.id, 1))
      .get();
    if (!relay || !relay.enabled) return false;
  }

  return true;
}

/** The channels this event is routed on, for an evaluator deciding whether to build a household
 *  body at all (evaluate/digest.ts). Empty means "behave exactly as before". */
export function householdRoutedChannels(eventId: string): Channel[] {
  return CHANNELS.filter((channel) => isHouseholdRouted(eventId, channel));
}

export type { NotificationEventDef };
