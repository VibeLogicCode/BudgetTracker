import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { simplefinAccountLinks, simplefinConnections } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { SimplefinError } from './client';
import { decryptAccessUrl, encryptAccessUrl } from './crypto';

/** The bridge allows roughly 24/day/token; stop at 20 so a sync never discovers the ceiling. */
export const DAILY_REQUEST_LIMIT = 20;
export const OVERLAP_DAYS = 5;
export const MAX_WINDOW_DAYS = 90;

/**
 * Auto-sync cadence (design ruling 7, v1.7.0). The scheduler only ever wakes on the coarse
 * 5-minute notify tick (NOTIFY_TICK_CRON in scheduler.ts), not a precise per-interval timer,
 * so `dueAfterHours` sits BELOW each nominal interval on purpose: a threshold set exactly at
 * the interval would push the effective cadence a few minutes later every single cycle, since
 * the tick can never catch a sync at the exact instant it becomes due. The slack keeps the
 * average cadence honest instead of drifting later forever.
 *
 * This ONE constant drives three call sites that must never disagree: the scheduler's
 * due-check (runSimplefinTick in scheduler.ts), the Connections page's <select>, and the
 * server action's zod schema. All three read it (directly, or via a value derived from it)
 * from here rather than each declaring their own copy.
 */
export const AUTO_SYNC_INTERVALS = {
  '6h': { label: 'Every 6 hours', dueAfterHours: 5.5 },
  '12h': { label: 'Every 12 hours', dueAfterHours: 11 },
  daily: { label: 'Once a day', dueAfterHours: 20 },
  weekly: { label: 'Once a week', dueAfterHours: 160 },
} as const;

export type AutoSyncInterval = keyof typeof AUTO_SYNC_INTERVALS;

export function isAutoSyncInterval(value: string): value is AutoSyncInterval {
  return Object.prototype.hasOwnProperty.call(AUTO_SYNC_INTERVALS, value);
}

/**
 * Settings-table keys (absence = off, same discipline as src/lib/update/state.ts). Owned
 * entirely by the auto-sync feature: no other module writes these two keys.
 */
export const SETTING_AUTO_SYNC = 'simplefin_auto_sync';
export const SETTING_AUTO_SYNC_USER_ID = 'simplefin_auto_sync_user_id';

/**
 * Automatic sync backoff (v1.60.0). last_sync_at moves only on a clean run, so without these a bank
 * that keeps failing makes every five-minute tick due again until the day's requests are gone.
 * The scheduler records each automatic attempt and counts consecutive automatic failures; markSynced
 * (any clean run, manual or automatic) deletes both. A manual sync never reads them.
 */
export const SETTING_AUTO_SYNC_FAILURES = 'simplefin_auto_sync_failures';
export const SETTING_AUTO_SYNC_LAST_ATTEMPT_AT = 'simplefin_auto_sync_last_attempt_at';

const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * 30 minutes after the first failure, doubling with each one after, never more than 24 hours. A
 * bank that fails all day therefore costs at most six requests (0, 0.5, 1.5, 3.5, 7.5 and 15.5
 * hours after the first), leaving the rest of the 20 for a manual sync.
 */
export function autoSyncBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  // 2^6 x 30 min is already past the cap, so the exponent never needs to grow beyond that.
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 6), BACKOFF_MAX_MS);
}

export function recordAutoSyncAttempt(at: Date = new Date()): void {
  setSetting(SETTING_AUTO_SYNC_LAST_ATTEMPT_AT, nowIso(at));
}

/** Returns the new consecutive-failure count. */
export function recordAutoSyncFailure(): number {
  const failures = readFailures() + 1;
  setSetting(SETTING_AUTO_SYNC_FAILURES, String(failures));
  return failures;
}

function clearAutoSyncBackoff(): void {
  deleteSetting(SETTING_AUTO_SYNC_FAILURES);
  deleteSetting(SETTING_AUTO_SYNC_LAST_ATTEMPT_AT);
}

function readFailures(): number {
  const parsed = Number.parseInt(getSetting(SETTING_AUTO_SYNC_FAILURES) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface AutoSyncBackoff {
  failures: number;
  nextTryAt: Date;
}

/**
 * Non-null while automatic sync is waiting: at least one recorded failure, and less than its
 * backoff has passed since the last automatic attempt. An unreadable attempt time reads as no wait,
 * so a damaged key can only ever make the sync try, never stop it for good.
 */
export function autoSyncBackoff(now: Date = new Date()): AutoSyncBackoff | null {
  const failures = readFailures();
  if (failures === 0) return null;
  const lastAttempt = Date.parse(getSetting(SETTING_AUTO_SYNC_LAST_ATTEMPT_AT) ?? '');
  if (!Number.isFinite(lastAttempt)) return null;
  const nextTryAt = lastAttempt + autoSyncBackoffMs(failures);
  return now.getTime() < nextTryAt ? { failures, nextTryAt: new Date(nextTryAt) } : null;
}

/**
 * Pure due-check: a connection that has never synced is always due; otherwise strictly more
 * than `dueAfterHours` must have elapsed since the last successful sync.
 */
export function isAutoSyncDue(lastSyncAt: string | null, dueAfterHours: number, now: Date = new Date()): boolean {
  if (lastSyncAt === null) return true;
  const elapsedMs = now.getTime() - new Date(lastSyncAt).getTime();
  return elapsedMs > dueAfterHours * 60 * 60 * 1000;
}

export interface ConnectionRecord {
  id: number;
  claimedAt: string;
  lastSyncAt: string | null;
  requestsToday: number;
  requestsDate: string;
  enabled: boolean;
}

function row() {
  return getDb().select().from(simplefinConnections).limit(1).get();
}

export function getConnection(): ConnectionRecord | null {
  const found = row();
  if (!found) return null;
  return {
    id: found.id,
    claimedAt: found.claimedAt,
    lastSyncAt: found.lastSyncAt,
    requestsToday: found.requestsToday,
    requestsDate: found.requestsDate,
    enabled: found.enabled,
  };
}

/**
 * v1 keeps a single connection: claiming again replaces the previous one, and the new bridge does
 * not inherit the old one's automatic sync backoff.
 */
export function saveClaimedConnection(accessUrl: string, at: Date = new Date()): ConnectionRecord {
  const db = getDb();
  clearAutoSyncBackoff();
  db.transaction((tx) => {
    tx.delete(simplefinConnections).run();
    tx.insert(simplefinConnections)
      .values({
        accessUrlEncrypted: encryptAccessUrl(accessUrl),
        claimedAt: nowIso(at),
        lastSyncAt: null,
        requestsToday: 0,
        requestsDate: todayIso(at),
        enabled: true,
        createdAt: nowIso(at),
      })
      .run();
  });
  const created = getConnection();
  if (!created) throw new Error('failed to store the SimpleFIN connection');
  return created;
}

/** Decrypted only server-side, at the moment of use. Never returned to the browser. */
export function getAccessUrl(): string | null {
  const found = row();
  if (!found) return null;
  return decryptAccessUrl(found.accessUrlEncrypted);
}

/**
 * "Forget connection" also drops every account link: leaving them behind would
 * permanently lock those accounts out of CSV import (isSimplefinManaged stays
 * true forever with no UI left to unlink from) and matches the user's mental
 * model of "forget" — accounts revert to CSV-managed.
 */
export function deleteConnection(): void {
  getDb().transaction((tx) => {
    tx.delete(simplefinAccountLinks).run();
    tx.delete(simplefinConnections).run();
  });
}

/** A clean run, manual or automatic: the window moves on and any automatic backoff ends. */
export function markSynced(at: Date = new Date()): void {
  const found = row();
  if (!found) return;
  getDb().update(simplefinConnections).set({ lastSyncAt: nowIso(at) }).where(eq(simplefinConnections.id, found.id)).run();
  clearAutoSyncBackoff();
}

export function remainingRequestsToday(at: Date = new Date()): number {
  const found = row();
  if (!found) return DAILY_REQUEST_LIMIT;
  if (found.requestsDate !== todayIso(at)) return DAILY_REQUEST_LIMIT;
  return Math.max(0, DAILY_REQUEST_LIMIT - found.requestsToday);
}

export function assertRequestBudget(at: Date = new Date()): void {
  if (remainingRequestsToday(at) <= 0) {
    throw new SimplefinError(
      'http_error',
      `Daily SimpleFIN request budget used up (${DAILY_REQUEST_LIMIT} of about 24 allowed by the bridge). Try again tomorrow.`,
      429,
    );
  }
}

export function consumeRequest(at: Date = new Date()): void {
  const found = row();
  if (!found) return;
  const today = todayIso(at);
  const requestsToday = found.requestsDate === today ? found.requestsToday + 1 : 1;
  getDb()
    .update(simplefinConnections)
    .set({ requestsToday, requestsDate: today })
    .where(eq(simplefinConnections.id, found.id))
    .run();
}

export interface AccountLink {
  simplefinAccountId: string;
  accountId: number;
  currency: string;
  lastBalanceCents: number | null;
  lastBalanceDate: string | null;
}

export function listLinks(): AccountLink[] {
  return getDb()
    .select({
      simplefinAccountId: simplefinAccountLinks.simplefinAccountId,
      accountId: simplefinAccountLinks.accountId,
      currency: simplefinAccountLinks.currency,
      lastBalanceCents: simplefinAccountLinks.lastBalanceCents,
      lastBalanceDate: simplefinAccountLinks.lastBalanceDate,
    })
    .from(simplefinAccountLinks)
    .all();
}

export function linkAccount(input: { simplefinAccountId: string; accountId: number; currency: string }): void {
  const existing = listLinks().find((link) => link.accountId === input.accountId);
  if (existing && existing.simplefinAccountId !== input.simplefinAccountId) {
    throw new SimplefinError('bad_token', 'That local account is already linked to a different SimpleFIN account.');
  }
  getDb()
    .insert(simplefinAccountLinks)
    .values({
      simplefinAccountId: input.simplefinAccountId,
      accountId: input.accountId,
      currency: input.currency,
      lastBalanceCents: null,
      lastBalanceDate: null,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: simplefinAccountLinks.simplefinAccountId,
      set: { accountId: input.accountId, currency: input.currency },
    })
    .run();
}

export function unlinkAccount(simplefinAccountId: string): void {
  getDb().delete(simplefinAccountLinks).where(eq(simplefinAccountLinks.simplefinAccountId, simplefinAccountId)).run();
}

export function updateLinkBalance(input: { simplefinAccountId: string; balanceCents: number | null; balanceDate: string | null }): void {
  getDb()
    .update(simplefinAccountLinks)
    .set({ lastBalanceCents: input.balanceCents, lastBalanceDate: input.balanceDate })
    .where(eq(simplefinAccountLinks.simplefinAccountId, input.simplefinAccountId))
    .run();
}

/** Spec section 3: an account is CSV-managed or SimpleFIN-managed, never both. */
export function isSimplefinManaged(accountId: number): boolean {
  const found = getDb()
    .select({ id: simplefinAccountLinks.simplefinAccountId })
    .from(simplefinAccountLinks)
    .where(eq(simplefinAccountLinks.accountId, accountId))
    .get();
  return found !== undefined;
}

export function linkForAccount(accountId: number): AccountLink | null {
  return listLinks().find((link) => link.accountId === accountId) ?? null;
}
