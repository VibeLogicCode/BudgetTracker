// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createTestDb, type TestDb } from '../helpers/db';
import { createUser } from '@/lib/auth/users';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * F-09 (v1.31.0), Settings -> Sessions. Deliberately does NOT mock '@/lib/auth/session' the way
 * tests/app/settings-page-notifications.test.tsx does -- that file is testing unrelated cards and
 * stubs the session list to an empty array. This file exists specifically to prove what the real
 * listSessionsForUser/getCurrentSessionId wiring renders, against a real test database and a real
 * session row, which is the only way to catch the one failure mode that matters here: the session
 * token itself leaking into the page.
 */
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  }),
}));

let current: TestDb | null = null;
afterEach(() => {
  cleanup();
  current?.cleanup();
  current = null;
  cookieJar.clear();
  delete process.env.TRUST_PROXY;
});

const PASSWORD = 'correct horse battery';

describe('F-09: Settings -> Sessions card', () => {
  it('lists this member\'s own devices, marks the current one, and never renders the raw session token', async () => {
    current = createTestDb();
    const alice = await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'member' });
    const bob = await createUser({ name: 'Bob', username: 'bob', password: PASSWORD, role: 'member' });

    const mine = createSession(alice.id, { userAgent: 'Mozilla/5.0 (Alices Phone)', ip: '203.0.113.9' });
    createSession(alice.id, { userAgent: 'Alices Old Laptop', ip: '198.51.100.4' });
    createSession(bob.id, { userAgent: 'Bobs Tablet, never Alices to see' });

    cookieJar.set(SESSION_COOKIE_NAME, mine.token);
    const { default: SettingsPage } = await import('@/app/(app)/settings/page');
    const { container } = render(await SettingsPage());

    // Both of Alice's own sessions are listed...
    expect(screen.getByText(/Mozilla\/5\.0 \(Alices Phone\)/)).toBeTruthy();
    expect(screen.getByText(/Alices Old Laptop/)).toBeTruthy();
    // ...the one the request is coming from is marked...
    expect(screen.getByText('This device')).toBeTruthy();
    // ...and Bob's session is never shown to Alice -- F-09 is a member's OWN sessions only, not
    // a household-wide list, even though Alice is not an admin here either way.
    expect(screen.queryByText(/Bobs Tablet/)).toBeNull();

    // Both rows offer their own "Sign out".
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(2);

    // The one rule this card cannot ever break: the bearer token backing the cookie must not
    // reach the rendered page in any form -- not the prop, not a data attribute, nothing.
    expect(container.innerHTML).not.toContain(mine.token);
  });

  it('omits the IP column entirely when TRUST_PROXY is off, and shows it when TRUST_PROXY is on', async () => {
    current = createTestDb();
    const alice = await createUser({ name: 'Alice', username: 'alice', password: PASSWORD, role: 'member' });
    const mine = createSession(alice.id, { userAgent: 'UA', ip: '203.0.113.9' });
    cookieJar.set(SESSION_COOKIE_NAME, mine.token);
    const { default: SettingsPage } = await import('@/app/(app)/settings/page');

    delete process.env.TRUST_PROXY;
    const { container: withoutProxy } = render(await SettingsPage());
    expect(withoutProxy.innerHTML).not.toContain('203.0.113.9');
    expect(screen.queryByText('IP')).toBeNull();
    cleanup();

    process.env.TRUST_PROXY = 'true';
    const { container: withProxy } = render(await SettingsPage());
    expect(withProxy.innerHTML).toContain('203.0.113.9');
    expect(screen.getByText('IP')).toBeTruthy();
  });
});
