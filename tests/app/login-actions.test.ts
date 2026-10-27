import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { createUser } from '@/lib/auth/users';

// Server Actions read next/headers()/cookies() via Next's request-scoped
// AsyncLocalStorage, which only exists inside a real Next.js request. Outside of
// that (as here, importing the action function directly), both must be mocked.
function createFakeCookieStore() {
  const store = new Map<string, { value: string; options?: Record<string, unknown> }>();
  return {
    get: (name: string) => store.get(name),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      store.set(name, { value, options });
    },
    clear: () => store.clear(),
    delete: (name: string) => {
      store.delete(name);
    },
  };
}

let mockHeaders = new Headers();
const fakeCookies = createFakeCookieStore();

vi.mock('next/headers', () => ({
  headers: async () => mockHeaders,
  cookies: async () => fakeCookies,
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
}));

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return { ...actual, shouldUseSecureCookie: vi.fn(actual.shouldUseSecureCookie) };
});

import { shouldUseSecureCookie } from '@/lib/auth/session';
import { GENERIC_LOGIN_ERROR } from '@/lib/auth/login';
import { loginAction, type LoginFormState } from '@/app/(auth)/login/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  fakeCookies.clear();
  vi.mocked(shouldUseSecureCookie).mockClear();
});

const PASSWORD = 'correct horse battery';
const SAME_ORIGIN_HEADERS = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('loginAction — finding 2: same-origin check on every mutating action', () => {
  it('rejects a cross-origin submission (first thing, before any DB work)', async () => {
    current = createTestDb();
    mockHeaders = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });
    const result = await loginAction({}, formData({ username: 'alice', password: PASSWORD }));
    expect(result.error).toMatch(/cross-origin/i);
  });
});

describe('loginAction — finding 5: TOTP-step dead-end', () => {
  it('preserves needsTotp across a client-side validation failure (e.g. blank re-typed password) instead of silently dropping the TOTP step', async () => {
    current = createTestDb();
    mockHeaders = SAME_ORIGIN_HEADERS;
    const prev: LoginFormState = { needsTotp: true, username: 'alice' };
    const result = await loginAction(prev, formData({ username: 'alice', password: '', totpCode: '123456' }));
    expect(result.needsTotp).toBe(true);
  });
});

describe('loginAction — finding 4: secure-cookie protocol arg', () => {
  it('passes the literal "http:" to shouldUseSecureCookie on a successful login (controller ruling; never a client-derived value)', async () => {
    current = createTestDb();
    mockHeaders = SAME_ORIGIN_HEADERS;
    await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });
    await expect(loginAction({}, formData({ username: 'alice', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(shouldUseSecureCookie).toHaveBeenCalledWith('http:', expect.anything());
  });
});

describe('loginAction — v1.58.1: sign-in lockout with no trustworthy address', () => {
  const headersWithForgedIp = (i: number) =>
    new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000', 'x-real-ip': `203.0.113.${i}`, 'x-forwarded-for': `203.0.113.${i}` });

  async function failTimes(n: number) {
    for (let i = 0; i < n; i += 1) {
      mockHeaders = headersWithForgedIp(i);
      const result = await loginAction({}, formData({ username: 'alex', password: 'wrong password' }));
      expect(result.error).toBe(GENERIC_LOGIN_ERROR);
    }
  }

  async function withoutTrustProxy(fn: () => Promise<void>) {
    const original = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      await fn();
    } finally {
      if (original === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = original;
    }
  }

  it('does not lock on 5 failures with TRUST_PROXY off, and locks an unrecognised browser after 10', async () => {
    await withoutTrustProxy(async () => {
      current = createTestDb();
      await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
      await failTimes(5);
      mockHeaders = headersWithForgedIp(50);
      const sixth = await loginAction({}, formData({ username: 'alex', password: 'wrong password' }));
      expect(sixth.error).toBe(GENERIC_LOGIN_ERROR);
      await failTimes(4);
      const eleventh = await loginAction({}, formData({ username: 'alex', password: PASSWORD }));
      expect(eleventh.error).toMatch(/Too many attempts\. Try again in \d+ minutes?\./);
    });
  });

  it('sets the known-device cookie on a full sign-in, not on a failure', async () => {
    await withoutTrustProxy(async () => {
      current = createTestDb();
      await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
      mockHeaders = SAME_ORIGIN_HEADERS;
      await loginAction({}, formData({ username: 'alex', password: 'wrong password' }));
      expect(fakeCookies.get('bt_device')).toBeUndefined();
      await expect(loginAction({}, formData({ username: 'alex', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);
      const cookie = fakeCookies.get('bt_device');
      expect(cookie?.value).toBeTruthy();
      expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 180 * 24 * 60 * 60 });
    });
  });

  it('lets a recognised browser sign in while an unrecognised one is backed off, and locks that device after its own 10 failures', async () => {
    await withoutTrustProxy(async () => {
      current = createTestDb();
      await createUser({ name: 'Alex', username: 'alex', password: PASSWORD, role: 'admin' });
      mockHeaders = SAME_ORIGIN_HEADERS;
      await expect(loginAction({}, formData({ username: 'alex', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);
      const known = fakeCookies.get('bt_device')!.value;

      // another browser (no cookie) is guessing
      fakeCookies.clear();
      await failTimes(10);
      const guesser = await loginAction({}, formData({ username: 'alex', password: PASSWORD }));
      expect(guesser.error).toMatch(/Too many attempts/);

      // a cookie minted for someone else, a tampered one and garbage are all unrecognised
      await createUser({ name: 'Sam', username: 'sam', password: PASSWORD, role: 'member' });
      mockHeaders = SAME_ORIGIN_HEADERS;
      await expect(loginAction({}, formData({ username: 'sam', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);
      const samCookie = fakeCookies.get('bt_device')!.value;
      const tampered = `${known.slice(0, -1)}${known.endsWith('A') ? 'B' : 'A'}`;
      for (const bad of [samCookie, tampered, 'garbage']) {
        fakeCookies.clear();
        fakeCookies.set('bt_device', bad);
        const refused = await loginAction({}, formData({ username: 'alex', password: PASSWORD }));
        expect(refused.error).toMatch(/Too many attempts/);
      }

      // the recognised browser still signs in
      fakeCookies.clear();
      fakeCookies.set('bt_device', known);
      await expect(loginAction({}, formData({ username: 'alex', password: PASSWORD }))).rejects.toThrow(/NEXT_REDIRECT/);

      // and its own failures lock only that device
      for (let i = 0; i < 10; i += 1) {
        fakeCookies.set('bt_device', known);
        const r = await loginAction({}, formData({ username: 'alex', password: 'wrong password' }));
        expect(r.error).toBe(GENERIC_LOGIN_ERROR);
      }
      fakeCookies.set('bt_device', known);
      const locked = await loginAction({}, formData({ username: 'alex', password: PASSWORD }));
      expect(locked.error).toMatch(/Too many attempts/);
    });
  });
});
