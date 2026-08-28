// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { recordBalanceSnapshot } from '@/lib/networth';
import { createManualTransaction } from '@/lib/transactions';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
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

// v1.13.0 whole-branch review, item I2. DashboardPage used to pass `people` (straight off
// listAttributablePeople(), a full UserRecord -- id, name, username, role, totpEnabled,
// isActive, mustChangePassword, createdAt, visibility, canSignIn, lastAccountId) into
// QuickAddTransaction, whose own declared prop type is just `{ id, name }[]`. Structural typing
// let every extra field ride along into the RSC payload anyway. QuickAddTransaction is stubbed
// here to capture exactly the `people` value DashboardPage handed it, so the test below can
// assert on the ACTUAL serialized shape rather than on whether the extra fields happen to be
// rendered anywhere in the DOM (they never were, even before the fix -- the leak is in the
// payload, not the render).
const capturedQuickAddProps = vi.hoisted(() => ({ people: null as unknown }));
vi.mock('@/components/QuickAddTransaction', () => ({
  QuickAddTransaction: (props: { people: unknown }) => {
    capturedQuickAddProps.people = props.people;
    return null;
  },
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
      actorRole: 'admin',
    });
    createManualTransaction({
      accountId,
      date: today,
      description: 'KID SHOP',
      amountCents: -1200,
      categoryId: null,
      attributedUserId: child.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    return { adultId: adult.id, childId: child.id };
  }

  /** v1.14.0 (spec BU): a loan item of the given direction, owned by `ownerUserId`, with a
   *  tracked balance -- following tests/app/transactions-actions.test.ts's seedLoanItem shape. */
  function seedLoan(over: { name: string; ownerUserId: number; direction: 'owed' | 'lent'; balanceCents: number }): void {
    const loanType = createItemType(`Loan type for ${over.name}`, 'loan');
    createWarrantyItem({
      name: over.name,
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2026-01-01',
      warrantyMonths: null,
      isLifetime: false,
      priceCents: null,
      ownerUserId: over.ownerUserId,
      transactionId: null,
      typeId: loanType.id,
      notes: null,
      principalCents: over.balanceCents,
      interestRateBps: null,
      currentBalanceCents: over.balanceCents,
      balanceUpdatedAt: today,
      loanDirection: over.direction,
    });
  }

  it('partitions loans: owed to the Loans card, lent to the "Who owes us" card', async () => {
    const { adultId } = await setup();
    seedLoan({ name: 'Civic', ownerUserId: adultId, direction: 'owed', balanceCents: 200_000 });
    seedLoan({ name: 'Loan to a friend', ownerUserId: adultId, direction: 'lent', balanceCents: 50_000 });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Loans')).toBeTruthy();
    expect(screen.getByText('Who owes us')).toBeTruthy();
    expect(screen.getByText('Civic')).toBeTruthy();
    expect(screen.getByText('Loan to a friend')).toBeTruthy();
    // Each card's own total is exactly its own loan's balance -- the owed total does not
    // include the lent loan's balance, and vice versa.
    expect(screen.getByLabelText('Total owed $2,000.00')).toBeTruthy();
    expect(screen.getByLabelText('Total $500.00')).toBeTruthy();
  });

  it('a self viewer sees "Owed to you" but never the Loans card (ruling R2 + P11)', async () => {
    const { adultId, childId } = await setup();
    seedLoan({ name: 'Adult owed loan', ownerUserId: adultId, direction: 'owed', balanceCents: 200_000 });
    seedLoan({ name: 'Loan to a friend', ownerUserId: childId, direction: 'lent', balanceCents: 50_000 });
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Owed to you')).toBeTruthy();
    expect(screen.queryByText('Who owes us')).toBeNull();
    expect(screen.queryByText('Loans')).toBeNull();
    expect(screen.getByText('Loan to a friend')).toBeTruthy();
    // The other household member's owed loan is never in this viewer's rows at all.
    expect(screen.queryByText('Adult owed loan')).toBeNull();
  });

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

  // v1.13.0 whole-branch review, item I2.
  it("passes QuickAddTransaction only { id, name } per person -- no username, no totpEnabled, no other UserRecord field", async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const people = capturedQuickAddProps.people as Array<Record<string, unknown>>;
    expect(people.length).toBeGreaterThan(0);
    for (const person of people) {
      expect(Object.keys(person).sort()).toEqual(['id', 'name']);
    }
  });

  // Review fix-round: the page guide's "Loans, net worth ... stay household-wide" clause (and
  // the new Loans-vs-"Who owes us" sentence) is household-viewer copy -- a self viewer has no
  // Loans card and no person pills, so that whole clause is gated on !selfScoped and replaced
  // with one short sentence about their own "Owed to you" card (the BM/P11 defect class).
  it('a self viewer\'s page guide never claims anything is household-wide', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const guide = screen.getByText('What is this page for?').closest('details');
    expect(guide).not.toBeNull();
    expect(guide!.textContent).not.toMatch(/household/i);
    expect(guide!.textContent).not.toMatch(/Who owes us/);
    expect(guide!.textContent).toMatch(/Owed to you/);
  });

  it('a household viewer\'s page guide still explains Loans vs "Who owes us"', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const guide = screen.getByText('What is this page for?').closest('details');
    expect(guide).not.toBeNull();
    expect(guide!.textContent).toMatch(/household-wide/);
    expect(guide!.textContent).toMatch(/Who owes us/);
  });

  // v1.13.1 review A: DashboardPage passed listAttributablePeople() into QuickAddTransaction
  // without the selfScoped gate the rest of the file uses -- a self viewer's RSC payload
  // carried the whole household roster even though nothing on the page renders it.
  it('does not hand a self viewer the household roster via QuickAddTransaction', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const people = capturedQuickAddProps.people as Array<Record<string, unknown>>;
    expect(people).toEqual([]);
  });
});
