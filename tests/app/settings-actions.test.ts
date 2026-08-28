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

import { changePasswordAction, confirmTotpEnrollmentAction, disableTotpAction } from '@/app/(app)/settings/actions';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createUser } from '@/lib/auth/users';
import { enableTotpForUser, generateTotpSecret } from '@/lib/auth/totp';

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
