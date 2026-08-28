// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { createManualTransaction } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * v1.13.0 ruling R2: reports are force-scoped -- every one of Task 6's seven aggregates takes
 * `viewer`, and a self viewer sees no person split at all (the picker's Person field and the
 * "Who spent it" card are both dropped). No reports.test.tsx existed before this task (confirmed:
 * neither in the working tree nor anywhere in git history) despite the brief calling this a
 * "Modify" -- this is a new file, following the same render-the-real-page-with-a-seeded-db
 * pattern as tests/app/dashboard.test.tsx and tests/app/budgets-page.test.tsx.
 */

// recharts' ResponsiveContainer (used by several report charts) requires ResizeObserver to
// mount, which jsdom does not provide -- same test-environment shim as
// tests/app/reports-client.test.tsx and tests/app/dashboard.test.tsx.
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

describe('ReportsPage (ruling R2)', () => {
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
    // A household-owned loan with a tracked balance, so the "Debt over time" card (which only
    // renders at all when hasLoans is true) has something to be present FOR in the household
    // fixture below -- Net worth and Tax year render their own empty state with no further
    // setup, but Debt over time is gated on real data existing.
    const loanType = t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
      .get(today) as { id: number };
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, created_at, updated_at)
         values ('Civic', '2024-01-15', 0, ?, ?, 1500000, ?, ?, ?)`,
      )
      .run(adult.id, loanType.id, today, today, today);
    return { adultId: adult.id, childId: child.id };
  }

  it('a self viewer sees no "Who spent it" card and no Person picker', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText('Who spent it')).toBeNull();
    expect(container.querySelector('select[name="person"]')).toBeNull();
    // The self viewer's own spending still shows up in the (unscoped-by-person) cards below.
    expect(container.textContent).toContain('$12.00');
  });

  it('a household viewer keeps the Person picker and the "Who spent it" card', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Who spent it')).toBeTruthy();
    expect(container.querySelector('select[name="person"]')).toBeTruthy();
    // Both members' spending shows up, unscoped.
    expect(container.textContent).toContain('$50.00');
    expect(container.textContent).toContain('$12.00');
  });

  // v1.13.0 ruling R2 (fix round 1, controller directive): R2 binds every page, not just the
  // dashboard -- a self viewer gets NO account balances, NO net worth, NO reports of household
  // totals. Net worth, debt-over-time and the tax-year card must be dropped ENTIRELY for a self
  // viewer, not rendered as a scoped-to-zero/empty-state version of themselves.
  it('a self viewer sees no Net worth, Debt over time or Tax year card', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole('heading', { name: 'Net worth' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Debt over time' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tax year' })).toBeNull();
    // No export link on the page points at the household-wide tax-export route either -- there
    // is no Tax year card to carry a Download CSV action in the first place.
    expect(container.querySelector('a[href^="/api/reports/tax-export"]')).toBeNull();
  });

  it('a household viewer keeps the Net worth, Debt over time and Tax year cards', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    // Card headings, not a plain text search -- "Tax year" also appears as the filter form's
    // own Field label once the picker has a year to offer, which would otherwise collide with
    // a prefix/exact text match.
    expect(screen.getByRole('heading', { name: 'Net worth' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Debt over time' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tax year' })).toBeTruthy();
  });
});
