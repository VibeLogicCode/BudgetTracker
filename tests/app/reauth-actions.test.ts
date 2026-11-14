import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * v1.64.1: every re-check of a signed-in person's current password (and current two-factor code)
 * is counted through the sign-in lockout. Real sessions, real lockout rows; Next's request plumbing
 * is stood in for, and the password verify is wrapped so a test can see whether one ran.
 */
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
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => cookieStore,
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/notify/raise', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify/raise')>();
  return { ...actual, raiseAccountSecurityEvent: vi.fn() };
});
vi.mock('@/lib/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/password')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import { changePasswordAction, beginTotpEnrollmentAction, confirmTotpEnrollmentAction, disableTotpAction } from '@/app/(app)/settings/actions';
import { forcedChangePasswordAction } from '@/app/(auth)/change-password/actions';
import { attemptLogin } from '@/lib/auth/login';
import { withKnownDevice, KNOWN_DEVICE_COOKIE_NAME } from '@/lib/auth/known-device';
import { verifyPassword } from '@/lib/auth/password';
import { verifyCurrentPassword } from '@/lib/auth/reauth';
import { UNKNOWN_IP, USER_IP_MAX_FAILURES, recordLoginAttempt } from '@/lib/auth/ratelimit';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createUser, findUserByUsername, mustChangePassword } from '@/lib/auth/users';
import { currentTotpToken, enableTotpForUser, generateTotpSecret } from '@/lib/auth/totp';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  cookieJar.clear();
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
});

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a whole new password';

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function signedIn(options: { mustChangePassword?: boolean; totp?: boolean } = {}) {
  current = createTestDb();
  const alex = await createUser({
    name: 'Alex',
    username: 'alex',
    password: PASSWORD,
    role: 'admin',
    mustChangePassword: options.mustChangePassword === true,
  });
  const secret = generateTotpSecret();
  if (options.totp) enableTotpForUser(alex.id, secret);
  const session = createSession(alex.id);
  createSession(alex.id);
  cookieJar.set(SESSION_COOKIE_NAME, session.token);
  return { alex, secret };
}

function hashOf(): string {
  return findUserByUsername('alex')!.passwordHash;
}

function totpOn(userId: number): boolean {
  return current!.db.get<{ on: number }>(sql`select totp_enabled as "on" from users where id = ${userId}`).on === 1;
}

function failedRows(): number {
  return current!.db.get<{ n: number }>(sql`select count(*) as n from login_attempts where success = 0`).n;
}

function wrongCode(secret: string): string {
  return currentTotpToken(secret) === '000000' ? '000001' : '000000';
}

/** Sign-in from an unrecognised browser is refused; a recognised browser still gets past the password. */
async function expectSignInLockedOnlyForUnrecognised(): Promise<void> {
  expect((await attemptLogin({ username: 'alex', password: PASSWORD, ip: UNKNOWN_IP, deviceId: null })).status).toBe('locked');
  expect((await attemptLogin({ username: 'alex', password: PASSWORD, ip: UNKNOWN_IP, deviceId: 'dev-alex' })).status).toMatch(
    /^(ok|totp_required)$/,
  );
}

describe('changing the password in Settings', () => {
  it('counts a wrong current password and refuses without a verify once the threshold is reached', async () => {
    await signedIn();
    const before = hashOf();
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      const result = await changePasswordAction({}, formData({ currentPassword: 'not the password', newPassword: NEW_PASSWORD }));
      expect(result.error).toBe('Current password is incorrect.');
    }
    expect(failedRows()).toBe(USER_IP_MAX_FAILURES);
    vi.mocked(verifyPassword).mockClear();

    const locked = await changePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

    expect(locked.error).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(hashOf()).toBe(before);
    expect(failedRows()).toBe(USER_IP_MAX_FAILURES);
    await expectSignInLockedOnlyForUnrecognised();
  });

  it('a right current password writes no success row, so the sign-in window is not reset', async () => {
    await signedIn();
    for (let i = 0; i < USER_IP_MAX_FAILURES - 1; i += 1) {
      recordLoginAttempt({ username: 'alex', ip: UNKNOWN_IP, success: false });
    }
    const result = await changePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
    expect(result.error).toBeUndefined();
    expect(current!.db.get<{ n: number }>(sql`select count(*) as n from login_attempts where success = 1`).n).toBe(0);

    expect((await attemptLogin({ username: 'alex', password: 'still wrong', ip: UNKNOWN_IP })).status).toBe('invalid');
    expect((await attemptLogin({ username: 'alex', password: NEW_PASSWORD, ip: UNKNOWN_IP })).status).toBe('locked');
  });
});

describe('replacing two-factor sign-in', () => {
  async function setupReplace() {
    const t = await signedIn({ totp: true });
    const begin = await beginTotpEnrollmentAction();
    return { ...t, newSecret: begin.enrollment!.secret };
  }

  it('counts a wrong current password and refuses without a verify once the threshold is reached', async () => {
    const t = await setupReplace();
    const fields = (password: string) => ({
      code: currentTotpToken(t.newSecret),
      currentPassword: password,
      currentCode: currentTotpToken(t.secret),
    });
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      expect((await confirmTotpEnrollmentAction({}, formData(fields('not the password')))).error).toBe('Current password is incorrect.');
    }
    vi.mocked(verifyPassword).mockClear();

    const locked = await confirmTotpEnrollmentAction({}, formData(fields(PASSWORD)));

    expect(locked.error).toMatch(/^Too many attempts/);
    expect(locked.recoveryCodes).toBeUndefined();
    expect(verifyPassword).not.toHaveBeenCalled();
    await expectSignInLockedOnlyForUnrecognised();
  });

  it('counts a wrong current code the same way', async () => {
    const t = await setupReplace();
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      const result = await confirmTotpEnrollmentAction(
        {},
        formData({ code: currentTotpToken(t.newSecret), currentPassword: PASSWORD, currentCode: wrongCode(t.secret) }),
      );
      expect(result.error).toMatch(/current code did not match/);
    }
    expect(failedRows()).toBe(USER_IP_MAX_FAILURES);
    const locked = await confirmTotpEnrollmentAction(
      {},
      formData({ code: currentTotpToken(t.newSecret), currentPassword: PASSWORD, currentCode: currentTotpToken(t.secret) }),
    );
    expect(locked.error).toMatch(/^Too many attempts/);
  });
});

describe('turning off two-factor sign-in', () => {
  it('counts a wrong current password and refuses without a verify once the threshold is reached', async () => {
    const t = await signedIn({ totp: true });
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      const result = await disableTotpAction({}, formData({ currentPassword: 'not the password', currentCode: currentTotpToken(t.secret) }));
      expect(result.error).toBe('Current password is incorrect.');
    }
    vi.mocked(verifyPassword).mockClear();

    const locked = await disableTotpAction({}, formData({ currentPassword: PASSWORD, currentCode: currentTotpToken(t.secret) }));

    expect(locked.error).toMatch(/^Too many attempts/);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(totpOn(t.alex.id)).toBe(true);
    await expectSignInLockedOnlyForUnrecognised();
  });

  it('counts a wrong current code the same way', async () => {
    const t = await signedIn({ totp: true });
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      const result = await disableTotpAction({}, formData({ currentPassword: PASSWORD, currentCode: wrongCode(t.secret) }));
      expect(result.error).toMatch(/current code did not match/);
    }
    const locked = await disableTotpAction({}, formData({ currentPassword: PASSWORD, currentCode: currentTotpToken(t.secret) }));
    expect(locked.error).toMatch(/^Too many attempts/);
    expect(totpOn(t.alex.id)).toBe(true);
  });
});

describe('the forced password change', () => {
  it('counts a wrong current password and refuses without a verify once the threshold is reached', async () => {
    const { alex } = await signedIn({ mustChangePassword: true });
    for (let i = 0; i < USER_IP_MAX_FAILURES; i += 1) {
      const result = await forcedChangePasswordAction({}, formData({ currentPassword: 'not the password', newPassword: NEW_PASSWORD }));
      expect(result.error).toBe('Current password is incorrect.');
    }
    vi.mocked(verifyPassword).mockClear();

    const locked = await forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));

    expect(locked.error).toMatch(/^Too many attempts/);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(mustChangePassword(alex.id)).toBe(true);
    await expectSignInLockedOnlyForUnrecognised();
  });

  it('does not count choosing the same password again', async () => {
    await signedIn({ mustChangePassword: true });
    const result = await forcedChangePasswordAction({}, formData({ currentPassword: PASSWORD, newPassword: PASSWORD }));
    expect(result.error).toMatch(/not used here before/);
    expect(failedRows()).toBe(0);
  });
});

describe('verifyCurrentPassword', () => {
  it('counts a re-check from a recognised browser in that browser’s own bucket', async () => {
    const { alex } = await signedIn();
    const device = withKnownDevice(undefined, 'alex');
    const headers = new Headers({ cookie: `${KNOWN_DEVICE_COOKIE_NAME}=${device}` });
    const user = { id: alex.id, name: 'Alex', username: 'alex', role: 'admin' as const, visibility: 'household' as const };

    expect(await verifyCurrentPassword({ user, password: 'not the password', headers })).toEqual({
      ok: false,
      error: 'Current password is incorrect.',
    });

    const row = current!.db.get<{ device_id: string | null }>(sql`select device_id from login_attempts`);
    expect(row.device_id).not.toBeNull();
    expect(await verifyCurrentPassword({ user, password: PASSWORD, headers })).toEqual({ ok: true });
  });
});
