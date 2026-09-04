import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

// v1.12.1 (item Z / SEC-3, item AA / SEC-4): the two new action tests below need real
// session behaviour -- destroyOtherSessionsForUser has to run against real rows, and
// disableTotpAction has to verify a real password hash -- so this suite no longer mocks
// @/lib/auth/session wholesale (as it used to, for the confirmTotpEnrollmentAction tests
// only). Instead the fake cookie jar is a generic name -> value map (same shape as
// tests/app/change-password.test.ts's cookieStore), and requireUser() runs its real
// implementation against a real test database for every test in this file.
const cookieJar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  set: (name: string, value: string) => {
    cookieJar.set(name, value);
  },
  delete: (name: string) => {
    cookieJar.delete(name);
  },
};

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
  cookies: async () => cookieStore,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));

import {
  beginTotpEnrollmentAction,
  changePasswordAction,
  confirmTotpEnrollmentAction,
  disableTotpAction,
  signOutSessionAction,
} from '@/app/(app)/settings/actions';
import { SESSION_COOKIE_NAME, createSession, hashSessionToken, validateSession } from '@/lib/auth/session';
import { createUser, findUserById } from '@/lib/auth/users';
import {
  consumeTotpCounter,
  countUnusedRecoveryCodes,
  currentTotpToken,
  enableTotpForUser,
  generateTotpSecret,
  verifyTotpCounter,
} from '@/lib/auth/totp';

/** actions.ts's own private PENDING_TOTP_COOKIE name -- stable, not exported. */
const PENDING_TOTP_COOKIE = 'bt_pending_totp';

const PASSWORD = 'correct horse battery';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  cookieJar.clear();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Runs `fn` with the session cookie set to `token`, exactly like a real request would send it. */
async function withSession<T>(token: string, fn: () => Promise<T>): Promise<T> {
  cookieJar.set(SESSION_COOKIE_NAME, token);
  try {
    return await fn();
  } finally {
    cookieJar.delete(SESSION_COOKIE_NAME);
  }
}

async function signedInUser(): Promise<{ userId: number; token: string }> {
  current = createTestDb();
  const user = await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
  const session = createSession(user.id);
  return { userId: user.id, token: session.token };
}

/** The caller's own session plus one other, already-open, session for the same user. */
async function setupWithTwoSessions(): Promise<{ db: TestDb['db']; userId: number; myToken: string }> {
  const { userId, token } = await signedInUser();
  createSession(userId); // the "elsewhere" session
  return { db: current!.db, userId, myToken: token };
}

async function setupWithTotpEnabled(): Promise<{ db: TestDb['db']; userId: number; myToken: string }> {
  const setup = await setupWithTwoSessions();
  enableTotpForUser(setup.userId, generateTotpSecret());
  return setup;
}

describe('confirmTotpEnrollmentAction — finding 6c: pending-enrollment cookie', () => {
  it('returns a clean error (not a throw) when there is no pending-enrollment cookie', async () => {
    const { token } = await signedInUser();
    const result = await withSession(token, () => confirmTotpEnrollmentAction({}, formData({ code: '123456' })));
    expect(result.error).toMatch(/expired/i);
  });

  it('returns the same clean error when the cookie value is garbage/undecryptable, rather than throwing', async () => {
    const { token } = await signedInUser();
    cookieJar.set(PENDING_TOTP_COOKIE, 'not-a-valid-encrypted-payload');
    const result = await withSession(token, () => confirmTotpEnrollmentAction({}, formData({ code: '123456' })));
    expect(result.error).toMatch(/expired/i);
  });

  it('rejects a malformed code before ever reading the pending secret (zod schema, spec-compliance fold-in)', async () => {
    const { token } = await signedInUser();
    const result = await withSession(token, () => confirmTotpEnrollmentAction({}, formData({ code: 'not-a-code' })));
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/expired/i);
  });
});

describe('confirmTotpEnrollmentAction — v1.12.1 SEC-10 verify-then-spend, carried into v1.13.0', () => {
  it('a valid code from the QR-code secret enables two-factor', async () => {
    const { token } = await signedInUser();
    const begin = await withSession(token, () => beginTotpEnrollmentAction());
    const secret = begin.enrollment!.secret;
    const code = currentTotpToken(secret);
    const result = await withSession(token, () => confirmTotpEnrollmentAction({}, formData({ code })));
    expect(result.message).toMatch(/two-factor authentication is on/i);
    expect(result.recoveryCodes?.length).toBeGreaterThan(0);
  });

  it('refuses a code whose time-step counter has already been spent, so it cannot be replayed', async () => {
    const { userId, token } = await signedInUser();
    const begin = await withSession(token, () => beginTotpEnrollmentAction());
    const secret = begin.enrollment!.secret;
    const at = new Date();
    const code = currentTotpToken(secret, at);
    const counter = verifyTotpCounter(secret, code, at)!;
    // Simulate this exact counter already having been accepted once (e.g. shoulder-surfed and
    // used elsewhere in the same ~90s window) -- confirmTotpEnrollmentAction must refuse it.
    consumeTotpCounter(userId, counter);

    const result = await withSession(token, () => confirmTotpEnrollmentAction({}, formData({ code })));
    expect(result.error).toMatch(/already used/i);
    // Task 14 fix round 1: enableTotpForUser used to run BEFORE the counter was consumed, so a
    // refused replay still left MFA switched on with zero recovery codes generated. Neither may
    // happen on a refusal.
    expect(findUserById(userId)?.totpEnabled).toBe(false);
    expect(countUnusedRecoveryCodes(userId)).toBe(0);
  });
});

describe('v1.12.1: changing your password signs out everything else (item Z / SEC-3)', () => {
  it('destroys the other sessions and keeps the caller own', async () => {
    const { db, userId, myToken } = await setupWithTwoSessions();

    const result = await withSession(myToken, () =>
      changePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: 'a-new-one-please' })),
    );

    expect(result.error).toBeUndefined();
    const rows = db.get<{ n: number }>(sql`select count(*) as n from sessions where user_id = ${userId}`);
    expect(rows.n).toBe(1);
  });
});

describe('v1.12.1: turning off two-factor costs a password (item AA / SEC-4)', () => {
  it('refuses when the password field is absent, and leaves MFA on', async () => {
    const { db, userId, myToken } = await setupWithTotpEnabled();

    const result = await withSession(myToken, () => disableTotpAction({}, formData({})));

    expect(result.error).toBeTruthy();
    expect(db.get<{ on: number }>(sql`select totp_enabled as "on" from users where id = ${userId}`).on).toBe(1);
  });

  it('refuses a wrong password, and leaves MFA on', async () => {
    const { db, userId, myToken } = await setupWithTotpEnabled();

    const result = await withSession(myToken, () => disableTotpAction({}, formData({ currentPassword: 'nope' })));

    expect(result.error).toBe('Current password is incorrect.');
    expect(db.get<{ on: number }>(sql`select totp_enabled as "on" from users where id = ${userId}`).on).toBe(1);
  });

  it('disables it on the right password, and signs out every other session', async () => {
    const { db, userId, myToken } = await setupWithTotpEnabled();

    const result = await withSession(myToken, () =>
      disableTotpAction({}, formData({ currentPassword: PASSWORD })),
    );

    expect(result.message).toContain('off');
    expect(db.get<{ on: number }>(sql`select totp_enabled as "on" from users where id = ${userId}`).on).toBe(0);
    expect(db.get<{ n: number }>(sql`select count(*) as n from sessions where user_id = ${userId}`).n).toBe(1);
  });
});

describe('F-09: signOutSessionAction -- Settings -> Sessions per-row "Sign out"', () => {
  it('signs out a DIFFERENT device, leaving the caller signed in and the cookie untouched', async () => {
    const { db, userId, myToken } = await setupWithTwoSessions();
    const other = db.get<{ token_hash: string }>(
      sql`select token_hash from sessions where user_id = ${userId} and token_hash != ${hashSessionToken(myToken)}`,
    );

    const result = await withSession(myToken, () => signOutSessionAction({}, formData({ sessionId: other.token_hash })));

    expect(result.error).toBeUndefined();
    expect(result.message).toMatch(/signed out/i);
    // The caller's own session is still live -- ending someone else's row must never end this one.
    expect(validateSession(myToken)).not.toBeNull();
    expect(db.get<{ n: number }>(sql`select count(*) as n from sessions where user_id = ${userId}`).n).toBe(1);
  });

  it('signing out THIS device clears the cookie and redirects to /login, same as /api/auth/logout', async () => {
    const { token: myToken } = await signedInUser();
    const sessionId = hashSessionToken(myToken);
    cookieJar.set(SESSION_COOKIE_NAME, myToken);

    await expect(signOutSessionAction({}, formData({ sessionId }))).rejects.toThrow(/NEXT_REDIRECT/);

    expect(validateSession(myToken)).toBeNull();
    // clearSessionCookie() overwrites the cookie value before the redirect throws.
    expect(cookieJar.get(SESSION_COOKIE_NAME)).toBe('');
    cookieJar.delete(SESSION_COOKIE_NAME);
  });

  it('does not end another user\'s session even if its id is guessed or reused', async () => {
    const { token: myToken } = await signedInUser();
    const stranger = await createUser({ name: 'Bob', username: 'bob', password: PASSWORD, role: 'member' });
    const strangerSession = createSession(stranger.id);
    const strangerSessionId = hashSessionToken(strangerSession.token);

    const result = await withSession(myToken, () => signOutSessionAction({}, formData({ sessionId: strangerSessionId })));

    // Scoped by userId, so this reports success without having deleted anything real --
    // exactly like any other write against an id that does not belong to the caller.
    expect(result.error).toBeUndefined();
    expect(validateSession(strangerSession.token)).not.toBeNull();
  });

  it('refuses when no device is chosen', async () => {
    const { token: myToken } = await signedInUser();
    const result = await withSession(myToken, () => signOutSessionAction({}, formData({})));
    expect(result.error).toMatch(/choose a device/i);
  });

  it('the success result never contains the raw session token -- only the opaque tokenHash id ever travels through this action', async () => {
    const { db, userId, myToken } = await setupWithTwoSessions();
    const other = db.get<{ token_hash: string }>(
      sql`select token_hash from sessions where user_id = ${userId} and token_hash != ${hashSessionToken(myToken)}`,
    );
    const result = await withSession(myToken, () => signOutSessionAction({}, formData({ sessionId: other.token_hash })));
    expect(JSON.stringify(result)).not.toContain(myToken);
  });
});
