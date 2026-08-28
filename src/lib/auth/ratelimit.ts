import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loginAttempts } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv, type AppEnv } from '@/lib/env';

export const USER_IP_WINDOW_MS = 15 * 60 * 1000;
export const USER_IP_MAX_FAILURES = 5;
export const USER_IP_LOCKOUT_MS = 15 * 60 * 1000;

export const USERNAME_WINDOW_MS = 15 * 60 * 1000;
export const USERNAME_MAX_FAILURES = 10;
export const USERNAME_BASE_LOCKOUT_MS = 15 * 60 * 1000;
export const USERNAME_MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
export const USERNAME_HISTORY_MS = 24 * 60 * 60 * 1000;

export const ATTEMPT_RETENTION_DAYS = 30;

export type LockoutReason = 'none' | 'user_ip' | 'username';

export interface LockoutStatus {
  locked: boolean;
  reason: LockoutReason;
  retryAfterMs: number;
}

const UNLOCKED: LockoutStatus = { locked: false, reason: 'none', retryAfterMs: 0 };

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function recordLoginAttempt(input: { username: string; ip: string; success: boolean; at?: Date }): void {
  getDb()
    .insert(loginAttempts)
    .values({
      username: normalizeUsername(input.username),
      ip: input.ip,
      success: input.success,
      createdAt: nowIso(input.at),
    })
    .run();
}

function lastSuccessIso(username: string): string | null {
  const row = getDb()
    .select({ createdAt: sql<string>`max(${loginAttempts.createdAt})` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.username, username), eq(loginAttempts.success, true)))
    .get();
  return row?.createdAt ?? null;
}

/** Failure timestamps (ms, newest first) since the given floor. */
function failuresSince(username: string, ip: string | null, floorIso: string): number[] {
  const conditions = [eq(loginAttempts.username, username), eq(loginAttempts.success, false), sql`${loginAttempts.createdAt} > ${floorIso}`];
  if (ip !== null) conditions.push(eq(loginAttempts.ip, ip));
  const rows = getDb()
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(and(...conditions))
    .orderBy(sql`${loginAttempts.createdAt} desc`)
    .all();
  return rows.map((r) => new Date(r.createdAt).getTime());
}

function laterIso(a: string | null, b: string): string {
  if (a === null) return b;
  return a > b ? a : b;
}

// CALLER CONTRACT: callers must not call recordLoginAttempt() while checkLockout()
// still reports locked — the login flow rejects the attempt before verifying the
// password or recording anything. Both layers below anchor a candidate lockout on
// whichever qualifying 5-/10-failure window yields the LATEST expiry, which makes
// the lockout monotonic against attempts recorded *after* an active lockout began.
// That guard only covers attempts recorded *before* checkLockout is (correctly)
// consulted; it does not by itself stop a determined caller who ignores the
// reported lock state and records anyway. Layer B's mandated algorithm (brief's
// "Exact Layer B algorithm") anchors only on the single newest failure and has the
// same theoretical hole in isolation — it is protected in practice by the same
// caller contract, not by independent logic in this module.

/** Latest lockout expiry (ms) implied by any qualifying 5-in-a-row window, or null if none. */
function layerACandidateUntil(failuresDesc: number[]): number | null {
  let candidate: number | null = null;
  for (let i = 0; i + USER_IP_MAX_FAILURES - 1 < failuresDesc.length; i += 1) {
    const newest = failuresDesc[i];
    const nthNewest = failuresDesc[i + USER_IP_MAX_FAILURES - 1];
    if (newest - nthNewest <= USER_IP_WINDOW_MS) {
      const until = newest + USER_IP_LOCKOUT_MS;
      if (candidate === null || until > candidate) candidate = until;
    }
  }
  return candidate;
}

export function checkLockout(input: { username: string; ip: string; at?: Date }): LockoutStatus {
  const username = normalizeUsername(input.username);
  const now = (input.at ?? new Date()).getTime();
  const success = lastSuccessIso(username);

  // ---- Layer A: (username, ip), 5 failures / 15 min -> 15 min lockout ----
  // Floor is bounded to now-(WINDOW+LOCKOUT): any failure old enough that even its
  // own 15-min lockout would already have expired can never contribute to a still-
  // active or newly-forming lockout, so it's safe (and keeps the query bounded for
  // never-successful usernames) to exclude it up front.
  const layerAFloor = laterIso(success, new Date(now - (USER_IP_WINDOW_MS + USER_IP_LOCKOUT_MS)).toISOString());
  const layerA = failuresSince(username, input.ip, layerAFloor);
  const layerACandidate = layerACandidateUntil(layerA);
  if (layerACandidate !== null && now < layerACandidate) {
    return { locked: true, reason: 'user_ip', retryAfterMs: layerACandidate - now };
  }

  // ---- Layer B: username only, 10 failures / 15 min burst -> exponential backoff ----
  const layerBFloor = laterIso(success, new Date(now - USERNAME_HISTORY_MS).toISOString());
  const layerB = failuresSince(username, null, layerBFloor);
  if (layerB.length >= USERNAME_MAX_FAILURES) {
    const newest = layerB[0];
    const tenthNewest = layerB[USERNAME_MAX_FAILURES - 1];
    const isBurst = newest - tenthNewest <= USERNAME_WINDOW_MS;
    if (isBurst) {
      const rounds = Math.floor(layerB.length / USERNAME_MAX_FAILURES);
      const lockoutMs = Math.min(USERNAME_BASE_LOCKOUT_MS * 2 ** (rounds - 1), USERNAME_MAX_LOCKOUT_MS);
      const until = newest + lockoutMs;
      if (now < until) {
        return { locked: true, reason: 'username', retryAfterMs: until - now };
      }
    }
  }

  return UNLOCKED;
}

export function clearAttemptsFor(username: string): number {
  const result = getDb().delete(loginAttempts).where(eq(loginAttempts.username, normalizeUsername(username))).run();
  return Number(result.changes ?? 0);
}

/**
 * The longest textual IPv6 address (an IPv4-mapped form with a zone id) is comfortably under this.
 * The cap exists because this string is stored on sessions.ip and rendered verbatim into the "New
 * sign-in" notification, where `name` and `userAgent` are both length-bounded and this was not.
 */
const IP_MAX = 45;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9a-f:]+$/i;
/**
 * The IPv4-mapped IPv6 form (e.g. `::ffff:10.0.0.5`): a run of hex/colon groups followed by one
 * literal dotted-quad tail. IP_MAX's comment has claimed to accommodate this form since it was
 * written, but IPV6 above can never match it -- a dotted quad contains '.', which IPV6 forbids --
 * so every such address was previously refused and fell through to 'unknown'.
 */
const IPV6_V4_TAIL = /^[0-9a-f:]*:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Rejects anything that is not plainly an address, so a forged header cannot become display text. */
function validIp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > IP_MAX) return null;
  const v4 = IPV4.exec(trimmed);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255) ? trimmed : null;
  // Deliberately loose for v6 rather than reimplementing RFC 4291: the point is to refuse free
  // text, not to be a parser. A colon and hex digits only, with at least one colon.
  if (IPV6.test(trimmed) && trimmed.includes(':')) return trimmed;
  const mapped = IPV6_V4_TAIL.exec(trimmed);
  if (mapped) return mapped[1].split('.').every((part) => Number(part) <= 255) ? trimmed : null;
  return null;
}

/**
 * The client's address, or the literal 'unknown'.
 *
 * v1.12.1 (item AB / SEC-5). Two changes, both about the same mistake. A server action has no
 * socket, so login/actions.ts used to hand the client-controlled `x-real-ip` HEADER in as the
 * `socketIp` argument -- the parameter that exists precisely because it is supposed to be free of
 * untrusted input -- and this function returned it verbatim whenever TRUST_PROXY was off. Layer A
 * of the lockout (5 failures per username+IP in 15 minutes) is keyed on the result, so varying the
 * header defeated that layer entirely; and the same forged value was stored on the session row and
 * rendered into the "New sign-in" alert, letting a successful attacker choose which address the
 * family was told they had signed in from.
 *
 * So: `x-real-ip` is now read ONLY when TRUST_PROXY is on -- the same treatment `x-forwarded-for`
 * has always had, one line below -- and whatever survives is validated as an address and bounded
 * in length before it can reach sessions.ip or renderEvent.
 */
export function clientIpFromHeaders(headers: Headers, socketIp: string | null, env: AppEnv = readEnv()): string {
  if (env.trustProxy) {
    const forwarded = headers.get('x-forwarded-for');
    const first = forwarded?.split(',')[0];
    const fromForwarded = first === undefined ? null : validIp(first);
    if (fromForwarded !== null) return fromForwarded;
    const real = headers.get('x-real-ip');
    const fromReal = real === null ? null : validIp(real);
    if (fromReal !== null) return fromReal;
  }
  const fromSocket = socketIp === null ? null : validIp(socketIp);
  return fromSocket ?? 'unknown';
}

export function purgeOldLoginAttempts(at: Date = new Date(), olderThanDays: number = ATTEMPT_RETENTION_DAYS): number {
  const cutoff = new Date(at.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = getDb().delete(loginAttempts).where(lt(loginAttempts.createdAt, cutoff)).run();
  return Number(result.changes ?? 0);
}
