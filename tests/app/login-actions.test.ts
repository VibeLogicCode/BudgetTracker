import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';
import { createUser } from '@/lib/auth/users';

// Server Actions read next/headers()/cookies() via Next's request-scoped
// AsyncLocalStorage, which only exists inside a real Next.js request. Outside of
// that (as here, importing the action function directly), both must be mocked.
function createFakeCookieStore() {
  const store = new Map<string, { value: string }>();
  return {
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
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

describe('loginAction — v1.12.1 (item AB / SEC-5): a forged x-real-ip must not partition the lockout', () => {
  it('locks the 6th attempt even though every failed attempt carried a different forged x-real-ip, with TRUST_PROXY off', async () => {
    // This is the actual vulnerability site: clientIpFromHeaders() called DIRECTLY with
    // socketIp: null never reproduces the pre-fix bug, because the bug was this file (the
    // caller) handing requestHeaders.get('x-real-ip') in AS the socketIp argument. Only a test
    // that drives the real loginAction, with a real forged header on each request, exercises
    // that call site. Under the pre-fix `const ip = clientIpFromHeaders(requestHeaders,
    // requestHeaders.get('x-real-ip'))`, each attempt below gets its own IP bucket (since the
    // header varies every time and TRUST_PROXY off meant the OLD code still echoed socketIp
    // verbatim), so layer A's 5-in-15-minutes counter never accumulates and the 6th attempt
    // never locks. Fixed code passes null as socketIp, so every attempt collapses onto the
    // same 'unknown' bucket and the 6th attempt (any header, or none) is locked.
    const originalTrustProxy = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      current = createTestDb();
      await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'admin' });

      for (let i = 0; i < 5; i += 1) {
        mockHeaders = new Headers({
          origin: 'http://nas.local:3000',
          host: 'nas.local:3000',
          'x-real-ip': `203.0.113.${i}`, // a different forged address on every failed attempt
        });
        const result = await loginAction({}, formData({ username: 'alice', password: 'wrong password' }));
        expect(result.error).toBe(GENERIC_LOGIN_ERROR);
      }

      mockHeaders = new Headers({
        origin: 'http://nas.local:3000',
        host: 'nas.local:3000',
        'x-real-ip': '203.0.113.99', // yet another forged value on the 6th attempt
      });
      const sixth = await loginAction({}, formData({ username: 'alice', password: 'wrong password' }));
      expect(sixth.error).toMatch(/Too many attempts/i);
    } finally {
      if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = originalTrustProxy;
    }
  });
});
