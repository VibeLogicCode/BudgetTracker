// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { recordBalanceSnapshot } from '@/lib/networth';
import { createManualTransaction } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * v1.13.0 ruling R2: a self viewer's dashboard shows only the cards that survive (own
 * transactions, own personal budgets, own goals, own items/bills, own Coming-up) -- NO
 * balances, NO net worth, NO household totals. A household/admin viewer's dashboard is
 * byte-identical to v1.12.1.
 *
 * No dashboard.test.tsx existed before this task (confirmed: neither in the working tree nor
 * anywhere in git history), despite the brief's file list calling this a "Modify" -- this is a
 * new file, following the render-the-real-page-with-a-seeded-db pattern already established by
 * tests/app/settings-page-notifications.test.tsx (mock only auth/session, everything else is a
 * real createTestDb()).
 */

// recharts' ResponsiveContainer (used by CashflowChart) requires ResizeObserver to mount, which
// jsdom does not provide -- same test-environment shim as tests/app/reports-client.test.tsx.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'admin' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
}));

afterEach(cleanup);

describe('DashboardPage (ruling R2)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  async function setup() {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Kid', username: 'kid', password: 'correct horse battery', role: 'member' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    recordBalanceSnapshot({ accountId, date: today, balanceCents: 500_000, source: 'manual' });
    createManualTransaction({
      accountId,
      date: today,
      description: 'BIG STORE',
      amountCents: -5000,
      categoryId: null,
      attributedUserId: adult.id,
      userId: adult.id,
    });
    createManualTransaction({
      accountId,
      date: today,
      description: 'KID SHOP',
      amountCents: -1200,
      categoryId: null,
      attributedUserId: child.id,
      userId: adult.id,
    });
    return { adultId: adult.id, childId: child.id };
  }

  it('a self viewer sees no net worth, no top merchants, and no person switcher', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText('Net worth')).toBeNull();
    expect(screen.queryByText('Top merchants')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Whose money to show' })).toBeNull();
    expect(screen.getByText('Your month.')).toBeTruthy();
    // The self viewer's own spending still shows up -- this is their own transaction.
    expect(screen.getByText(/\$12\.00/)).toBeTruthy();
  });

  it('a household viewer keeps the full card set, including net worth, top merchants and the person switcher', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Net worth')).toBeTruthy();
    expect(screen.getByText('Top merchants')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Whose money to show' })).toBeTruthy();
  });
});
