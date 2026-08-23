import { describe, it, expect } from 'vitest';
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
