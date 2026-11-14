// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { saveLocalAiConfig, recordLocalAiFailure } from '@/lib/ai/config';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

/** v1.64.0 Lane B (plan 2026-11-12, B3). The real page against a seeded database. */
const session = vi.hoisted(() => ({ user: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as const } }));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => session.user,
  requireAdmin: async () => {
    if (session.user.role !== 'admin') throw new Error('Admin only');
    return session.user;
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let current: TestDb | null = null;
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  current?.cleanup();
  current = null;
});

function setup(role: 'admin' | 'member' = 'admin'): number {
  current = createSeededTestDb();
  const id = insertTestUser(current.db, { name: 'Alex', username: 'alex', role });
  session.user = { id, name: 'Alex', username: 'alex', role, visibility: 'household' };
  return id;
}

describe('Settings, Connections: the Local AI card', () => {
  it('an admin sees the card, off by default', async () => {
    setup();
    const { default: ConnectionsPage } = await import('@/app/(app)/settings/connections/page');
    render(await ConnectionsPage());

    expect(screen.getByText('Local AI (optional)')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Off. Nothing is sent anywhere.');
    expect((screen.getByLabelText('Model server address') as HTMLInputElement).value).toBe('');
  });

  it('shows the saved values and the waiting line after failures', async () => {
    const id = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: id, at: new Date('2026-03-10T09:00:00.000Z') });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T09:01:00.000Z'));
    recordLocalAiFailure(new Date('2026-03-10T09:00:00.000Z'), 'Could not reach the model server at 192.168.1.50:11434.');
    const { default: ConnectionsPage } = await import('@/app/(app)/settings/connections/page');
    render(await ConnectionsPage());

    expect((screen.getByLabelText('Model server address') as HTMLInputElement).value).toBe('http://192.168.1.50:11434');
    expect((screen.getByLabelText('Model name') as HTMLInputElement).value).toBe('test-model:1b');
    expect(screen.getByRole('status').textContent).toMatch(/^Waiting after 1 failed try\. Next try about .+ Last problem: Could not reach/);
  });

  it('a member never reaches the page', async () => {
    setup('member');
    const { default: ConnectionsPage } = await import('@/app/(app)/settings/connections/page');

    await expect(ConnectionsPage()).rejects.toThrow('Admin only');
  });
});
