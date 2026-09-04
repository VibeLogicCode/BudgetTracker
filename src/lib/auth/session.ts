import { createHash, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { readEnv, type AppEnv } from '@/lib/env';
import { SESSION_COOKIE_NAME, SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from './session-constants';

export { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './session-constants';

export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  /**
   * v1.13.0 ruling R2. 'self' scopes every read this person makes to rows they own. Carried on the
   * session so that every existing requireUser() call site already holds a Viewer and no page has to
   * fetch the flag separately -- which is what keeps the six chokepoints' viewer argument free at
   * every call site.
   */
  visibility: 'household' | 'self';
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  userId: number,
  meta: { userAgent?: string | null; ip?: string | null; at?: Date } = {},
): { token: string; expiresAt: string; createdAt: string } {
  const at = meta.at ?? new Date();
  const token = generateSessionToken();
  const createdAt = nowIso(at);
  const expiresAt = new Date(at.getTime() + SESSION_TTL_MS).toISOString();
  getDb()
    .insert(sessions)
    .values({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt,
      expiresAt,
      lastSeenAt: createdAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    })
    .run();
  // MUST-3.11: raiseNewSignin's dedup key is `signin:<session created_at ISO>`, so the
  // caller needs this session's own createdAt rather than substituting a different
  // timestamp (e.g. expiresAt, which is offset by SESSION_TTL_MS and not unique per sign-in
  // the same way).
  return { token, expiresAt, createdAt };
}

export function validateSession(token: string, at: Date = new Date()): SessionUser | null {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const db = getDb();
  const row = db
    .select({
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
      visibility: users.visibility,
      canSignIn: users.canSignIn,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();

  if (!row) return null;
  if (!row.isActive) return null;
  // v1.13.0 ruling R5: a person whose login was withdrawn must not keep the session they had when it
  // was granted -- the same argument resetMfaAction makes about destroying sessions on an auth
  // downgrade, expressed here as a read-time refusal so no sweep is needed.
  if (!row.canSignIn) return null;
  const nowMs = at.getTime();
  if (new Date(row.expiresAt).getTime() <= nowMs) return null;

  // Sliding expiry, throttled so every request does not write.
  if (nowMs - new Date(row.lastSeenAt).getTime() >= SESSION_RENEW_AFTER_MS) {
    db.update(sessions)
      .set({
        expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
        lastSeenAt: nowIso(at),
      })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
  }

  return { id: row.id, name: row.name, username: row.username, role: row.role, visibility: row.visibility };
}

export function destroySession(token: string): void {
  getDb().delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run();
}

/**
 * F-09 (v1.31.0). One row per live session, for the "which devices are signed in as me" card.
 * `id` is `sessions.tokenHash` -- the row's own primary key, already the opaque identifier this
 * table uses to name a session everywhere else (destroySession takes a raw token and hashes it
 * itself; this is the read-side mirror). It is NOT the session token: a SHA-256 hash of 256
 * random bits is one-way, so handing it to a page prop or a hidden form field cannot be turned
 * back into a bearer credential, unlike the token itself, which must never reach either. See
 * destroySessionForUser below for the write side of the same id.
 *
 * Scoped to `userId` and nothing else -- this is a member's OWN sessions, never the household's
 * (an admin gets no wider a list here; that would be a new privilege this release did not agree
 * to add). Ordered newest-active-first, the same ordering a person would want when scanning for
 * a device they do not recognise.
 */
export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export function listSessionsForUser(userId: number): SessionSummary[] {
  return getDb()
    .select({
      id: sessions.tokenHash,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.lastSeenAt))
    .all();
}

/**
 * F-09's per-row "Sign out". Takes the opaque id listSessionsForUser handed out (tokenHash), not
 * a raw token -- there is no raw token to take, the caller only ever held the hash. Scoped to
 * `userId` in the WHERE clause, not just checked after the fact: without it, a member could sign
 * out a session id that turned out to belong to someone else simply by guessing or observing
 * another row's id, the same class of hole ownerScope exists to close on every other table.
 */
export function destroySessionForUser(userId: number, sessionId: string): void {
  getDb()
    .delete(sessions)
    .where(and(eq(sessions.tokenHash, sessionId), eq(sessions.userId, userId)))
    .run();
}

export function destroyAllSessionsForUser(userId: number): number {
  const result = getDb().delete(sessions).where(eq(sessions.userId, userId)).run();
  return Number(result.changes ?? 0);
}

/**
 * "Sign out everywhere else": every session for this user except the one presenting
 * `keepToken`. Used by the forced password change (spec v1.5), where signing the user
 * out of the very browser they are typing in would be a hostile way to end the flow.
 */
export function destroyOtherSessionsForUser(userId: number, keepToken: string): number {
  const result = getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, hashSessionToken(keepToken))))
    .run();
  return Number(result.changes ?? 0);
}

export function purgeExpiredSessions(at: Date = new Date()): number {
  const result = getDb().delete(sessions).where(lt(sessions.expiresAt, at.toISOString())).run();
  return Number(result.changes ?? 0);
}

/**
 * Secure cookie logic (spec section 6):
 *  - direct HTTPS (the request's own URL protocol) → secure
 *  - TRUST_PROXY on and X-Forwarded-Proto starts with "https" → secure
 *  - otherwise      → not secure (plain HTTP on a trusted LAN)
 *
 * `protocol` must come from the actual request URL (e.g. `new URL(request.url).protocol`),
 * never from a client-supplied header — a fabricated header would let any client force a
 * Secure cookie over plain HTTP, which browsers then refuse to send back (self-DoS).
 */
export function shouldUseSecureCookie(protocol: string, headers: Headers, env: AppEnv = readEnv()): boolean {
  if (protocol.toLowerCase() === 'https:') return true;
  if (!env.trustProxy) return false;
  const forwarded = headers.get('x-forwarded-proto');
  if (!forwarded) return false;
  return forwarded.split(',')[0].trim().toLowerCase() === 'https';
}

export function sessionCookieOptions(input: { secure: boolean; expiresAt: string }): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  expires: Date;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: input.secure,
    path: '/',
    expires: new Date(input.expiresAt),
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Route-handler friendly: no next/headers, so it is unit-testable with a plain Request. */
export function userFromRequest(request: Request): SessionUser | null {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  if (!token) return null;
  return validateSession(token);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return validateSession(token);
}

/**
 * F-09: which of listSessionsForUser's rows is "this device". Returns the SAME hash
 * listSessionsForUser exposes as `id` -- never the cookie's raw token -- so a caller can mark a
 * row current, and destroySessionForUser's own id, purely by string equality, with no bearer
 * value ever leaving this module.
 */
export async function getCurrentSessionId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return hashSessionToken(token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/dashboard');
  return user;
}

export async function setSessionCookie(token: string, expiresAt: string, secure: boolean): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions({ secure, expiresAt }));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}
