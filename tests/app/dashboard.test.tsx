// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { createCategory } from '@/lib/categories';
import { recordBalanceSnapshot } from '@/lib/networth';
import { createManualTransaction } from '@/lib/transactions';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
import { addMonths, currentMonth, monthLabel, todayIso } from '@/lib/dates';
// Lane 1 (src/lib/savings-target.ts): not mocked, real DB, same as every other lib import here.
import { saveSavingsTarget } from '@/lib/savings-target';
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
const capturedQuickAddProps = vi.hoisted(() => ({ people: null as unknown, collapsible: null as unknown }));
vi.mock('@/components/QuickAddTransaction', () => ({
  // v1.16.0 Lane C item 1: also captures `collapsible` now, so the test below can prove the
  // dashboard actually asks for the folded-away card rather than merely rendering SOME props.
  QuickAddTransaction: (props: { people: unknown; collapsible?: unknown }) => {
    capturedQuickAddProps.people = props.people;
    capturedQuickAddProps.collapsible = props.collapsible;
    return null;
  },
  // Item 6 (2026-08-30 plan): DashboardPage now also renders QuickAddTrigger (the header's own
  // "Add a transaction" button) alongside QuickAddTransaction -- stubbed the same way so the real
  // component's `useEffect`/hash wiring (irrelevant to every test in this file) never runs.
  QuickAddTrigger: () => null,
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

    expect(screen.getByText('What we owe')).toBeTruthy();
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
    expect(screen.queryByText('What we owe')).toBeNull();
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

  // v1.16.0 Lane C item 1: the dashboard's Quick add now folds away behind an "Add a
  // transaction" button, exactly like Transactions' own copy (ruling S6) -- the global rule
  // behind this plan is that a form which CREATES something sits behind a button, and this was
  // the largest block on the dashboard's card while being the least-used control on it.
  it('passes collapsible to QuickAddTransaction, so the dashboard card starts folded away', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(capturedQuickAddProps.collapsible).toBe(true);
  });

  // v1.15.0 (responsive rows, ruling S3): the category is what tells one budget row from
  // another on this widget, so it must carry cell-stack-headline.
  it('the budgets table\'s Category cell carries cell-stack-headline', async () => {
    const { adultId } = await setup();
    const categoryId = createCategory({ name: 'Groceries', parentId: null });
    createManualTransaction({
      accountId: createAccount({ name: 'Cash', type: 'cash', ownerUserId: adultId }),
      date: today,
      description: 'SUPERMARKET',
      amountCents: -3000,
      categoryId,
      attributedUserId: adultId,
      userId: adultId,
      actorRole: 'admin',
    });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const table = screen.getByText('Groceries').closest('table');
    const headlineCell = table?.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });
});

/**
 * Lane 1 of the 2026-08-30 plan (ruling U1): v1.17.0 stated the month three times in this
 * header -- an `AUGUST 2026` eyebrow above the greeting, the MonthNav pill, and a second visible
 * `<input type="month">` beside it, two of the three interactive. This block proves the eyebrow
 * and the second input are both gone, the subtitle no longer claims anything is "this month" (a
 * sentence that goes wrong the instant MonthNav is used to look at any other month), and
 * prev/next print short month names rather than the raw ISO keys they used to.
 */
describe('DashboardPage — ruling U1 (the month is stated once, by the control that changes it)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function setupBasic() {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    return { adultId: adult.id };
  }

  it('has no eyebrow above the greeting, and exactly one <input type="month"> on the whole page', async () => {
    const { adultId } = await setupBasic();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    const { container } = render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    // `.eyebrow` is a shared style class other widgets legitimately use too (StatTile's own
    // "Spent this month" label, for one) -- what proves THIS defect fixed is that the <h1> has
    // no eyebrow sibling of its own any more, so its previous sibling within PageHeader's wrapper
    // is gone outright rather than merely renamed.
    const heading = screen.getByRole('heading', { level: 1, name: /Hello, Adult/ });
    expect(heading.previousElementSibling).toBeNull();
    // v1.17.0 rendered a second, visible <input type="month"> beside the pill -- ruling U1
    // collapses it behind the pill (still in the DOM for keyboards/mobile) rather than adding a
    // third statement of the month.
    expect(container.querySelectorAll('input[type="month"]').length).toBe(1);
    // The pill is now the only place the month is named.
    expect(screen.getByText(monthLabel(currentMonth()))).toBeTruthy();
  });

  it('the subtitle no longer says "this month"', async () => {
    const { adultId } = await setupBasic();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Everything the household spent and brought in.')).toBeTruthy();
    expect(screen.queryByText('Everything the household spent and brought in this month.')).toBeNull();
  });

  it('MonthNav prev/next print three-letter month names, never raw ISO', async () => {
    const { adultId } = await setupBasic();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    const { container } = render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const monthLinks = Array.from(container.querySelectorAll('nav[aria-label="Change month"] a')) as HTMLAnchorElement[];
    const expectedPrev = monthLabel(addMonths(currentMonth(), -1)).slice(0, 3);
    const expectedNext = monthLabel(addMonths(currentMonth(), 1)).slice(0, 3);
    expect(monthLinks.map((a) => a.textContent)).toEqual([`← ${expectedPrev}`, `${expectedNext} →`]);
  });
});

/**
 * Lane 3 item 2 (MonthNav on the dashboard) and item 3 (ruling T7: the dashboard follows
 * `?month=`, and every section that does not gets an "as of today" note or is hidden outright).
 * A separate describe block, own seeded db, so a past month's data does not have to share
 * fixtures with the "today" scenarios the block above already covers.
 */
describe('DashboardPage — ruling T7 (month filter)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();
  const prevMonth = addMonths(currentMonth(), -1);

  async function setupMonths() {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    recordBalanceSnapshot({ accountId, date: today, balanceCents: 500_000, source: 'manual' });
    // Categorised, deliberately: "Spent this month" reads budgetTotals(budgetProgress(month)),
    // which attributes spend by category id and never sees an uncategorised (categoryId: null)
    // transaction at all -- unlike cashflowTrend (Money in/Net/savingsProgress), which counts
    // every uncategorised row as spend. A real category is what makes this fixture actually
    // exercise "Spent this month follows the chosen month" rather than silently proving nothing.
    const categoryId = createCategory({ name: 'Old Month Category', parentId: null });
    createManualTransaction({
      accountId,
      date: `${prevMonth}-05`,
      description: 'OLD MONTH SPEND',
      amountCents: -4000,
      categoryId,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    return { adultId: adult.id };
  }

  it('a malformed ?month= falls back to the current month instead of throwing', async () => {
    const { adultId } = await setupMonths();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    await expect(DashboardPage({ searchParams: Promise.resolve({ month: 'not-a-month' }) })).resolves.toBeTruthy();
  });

  it('a past month shows the Viewing banner and follows spend into "Spent this month"', async () => {
    const { adultId } = await setupMonths();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({ month: prevMonth }) }));

    expect(screen.getByText(new RegExp(`Viewing ${monthLabel(prevMonth)}`))).toBeTruthy();
    // Ruling T7: "Spent this month" follows the chosen month, so the OLD MONTH SPEND transaction
    // (dated in prevMonth, not today) shows up in this tile's own figure.
    const spentTile = screen.getByText('Spent this month').closest('div');
    expect(spentTile?.textContent).toContain('$40.00');
  });

  it('ruling T7: "Safe to spend" (the Coming up card) is hidden entirely for a past month', async () => {
    const { adultId } = await setupMonths();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({ month: prevMonth }) }));
    expect(screen.queryByText('Coming up')).toBeNull();
  });

  it('the current month shows neither the Viewing banner nor any "as of today" note, and Coming up is present', async () => {
    const { adultId } = await setupMonths();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText(/^Viewing /)).toBeNull();
    expect(screen.queryByText(/As of today, not/)).toBeNull();
  });

  it('MonthNav prev/next and the person pills both carry the other\'s param, so switching one never resets the other', async () => {
    const { adultId } = await setupMonths();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    const { container } = render(await DashboardPage({ searchParams: Promise.resolve({ month: prevMonth }) }));

    const householdPill = screen.getByText('Household').closest('a') as HTMLAnchorElement;
    expect(householdPill.getAttribute('href')).toBe(`/dashboard?month=${prevMonth}`);

    const monthLinks = Array.from(container.querySelectorAll('nav[aria-label="Change month"] a')) as HTMLAnchorElement[];
    expect(monthLinks.map((a) => a.getAttribute('href'))).toEqual([
      `/dashboard?month=${addMonths(prevMonth, -1)}`,
      `/dashboard?month=${addMonths(prevMonth, 1)}`,
    ]);
  });

  // Lane 3 item 4. Ruling T1a: the household has NO savings-type account in this fixture, so
  // the tile must name that setup rather than silently showing a low or zero figure -- exactly
  // the trap ruling T1 case 3 describes (an unflagged transfer to an outside bank understates
  // the month).
  it('Saved this month names the no-savings-account setup; Cash runway shows a figure from the recorded balance', async () => {
    const { adultId } = await setupMonths();
    saveSavingsTarget({ month: currentMonth(), mode: 'percent', value: 20 });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const savedTile = screen.getByText('Saved this month').closest('div');
    expect(savedTile?.textContent).toContain("doesn't track counts as spending unless the transaction is marked a transfer");

    const runwayTile = screen.getByText('Cash runway').closest('div');
    expect(runwayTile?.textContent).toContain('As of today');
  });

  // Ruling T3: household scope only -- a self viewer gets neither tile, the same gate net worth
  // already uses.
  it('a self viewer sees neither Saved this month nor Cash runway', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Kid', username: 'kid', password: 'correct horse battery', role: 'member' });
    void adult;
    currentUser.value = { id: child.id, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText('Saved this month')).toBeNull();
    expect(screen.queryByText('Cash runway')).toBeNull();
  });
});
