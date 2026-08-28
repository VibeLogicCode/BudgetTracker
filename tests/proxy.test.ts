import { describe, it, expect, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { proxy } from '@/proxy';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-constants';

function requestFor(path: string, init: { cookie?: string } = {}): NextRequest {
  const headers = new Headers();
  if (init.cookie) headers.set('cookie', init.cookie);
  return new NextRequest(new Request(`http://nas.local:3000${path}`, { headers }));
}

describe('middleware', () => {
  it('redirects an unauthenticated request for a protected page to /login', () => {
    const response = proxy(requestFor('/dashboard'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('lets an unauthenticated /api/* request pass through with no redirect', () => {
    const response = proxy(requestFor('/api/transactions'));
    expect(response.status).not.toBe(307);
    expect(response.headers.get('location')).toBeNull();
  });

  it('lets an unauthenticated /api request (no trailing segment) pass through too', () => {
    const response = proxy(requestFor('/api'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('does not redirect requests under the public prefixes', () => {
    for (const path of ['/login', '/login/', '/setup', '/setup/step-1']) {
      const response = proxy(requestFor(path));
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('does not redirect an unauthenticated request for the root path (it dispatches to /setup or /login itself)', () => {
    const response = proxy(requestFor('/'));
    expect(response.headers.get('location')).toBeNull();
  });

  it('serves the PWA manifest and icons unauthenticated, so the app is installable from /login', () => {
    // A browser fetches these to decide whether the app can be installed, and it does so
    // from whatever page it is on. Gated, they answered with a redirect to /login and the
    // browser got HTML where it expected a manifest, so no install option appeared at all.
    for (const path of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png']) {
      const response = proxy(requestFor(path));
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('does not treat a path that merely starts with a public prefix as public', () => {
    // /loginfoo must NOT match the /login prefix — only /login and /login/* do.
    const response = proxy(requestFor('/loginfoo'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });

  it('lets a request through when the session cookie is present', () => {
    const response = proxy(requestFor('/dashboard', { cookie: `${SESSION_COOKIE_NAME}=some-token` }));
    expect(response.status).not.toBe(307);
    expect(response.headers.get('location')).toBeNull();
  });

  it('attaches security headers to every response, redirect or pass-through', () => {
    for (const response of [
      proxy(requestFor('/dashboard')),
      proxy(requestFor('/api/transactions')),
      proxy(requestFor('/dashboard', { cookie: `${SESSION_COOKIE_NAME}=some-token` })),
    ]) {
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('embeds a fresh per-request nonce in the CSP script-src on every call', () => {
    const nonceOf = (response: NextResponse): string => {
      const csp = response.headers.get('Content-Security-Policy') ?? '';
      const match = csp.match(/'nonce-([^']+)'/);
      expect(match).not.toBeNull();
      return match![1];
    };
    const first = nonceOf(proxy(requestFor('/dashboard', { cookie: `${SESSION_COOKIE_NAME}=some-token` })));
    const second = nonceOf(proxy(requestFor('/dashboard', { cookie: `${SESSION_COOKIE_NAME}=some-token` })));
    expect(first).not.toBe(second);
  });
});

describe('v1.12.1: HSTS and the TRUST_PROXY mismatch warning (item AC / SEC-7, ruling P6)', () => {
  // v1.12.1 fix round 1: the plain-HTTP assertion, tested alone, passed against the PRE-FIX
  // proxy() too -- that code never called securityHeaders with an https option at all, so
  // "no HSTS on plain HTTP" was true before this feature existed and proved nothing about the
  // fix. Pairing it with the real-https case in the same test means a regression that stops
  // sending HSTS at all (not just one that sends it unconditionally) fails this test.
  it('sends HSTS when the request URL itself is https, and none on the plain-HTTP LAN default, where it would brick the install', () => {
    const secure = proxy(new NextRequest('https://budget.example/dashboard'));
    expect(secure.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
    const plain = proxy(new NextRequest('http://192.168.1.20:3000/dashboard'));
    expect(plain.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('warns, and still sends no HSTS, when a proxy claims https but TRUST_PROXY is off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = new NextRequest('http://budget.example/dashboard', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const response = proxy(request);

    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('TRUST_PROXY');
    // Once per process, not once per request: this runs on essentially every request.
    proxy(request);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
