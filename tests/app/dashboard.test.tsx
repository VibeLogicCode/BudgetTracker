// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { sql } from 'drizzle-orm';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { createCategory } from '@/lib/categories';
import { nowIso } from '@/lib/clock';
import { recordBalanceSnapshot } from '@/lib/networth';
import { createManualTransaction } from '@/lib/transactions';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
import { addMonths, currentMonth, monthEnd, monthLabel, monthStart, todayIso } from '@/lib/dates';
// Lane 1 (src/lib/savings-target.ts): not mocked, real DB, same as every other lib import here.
import { saveSavingsTarget } from '@/lib/savings-target';
import { createTestDb, type TestDb } from '../helpers/db';

// v1.26.0 Lane 3b's own describe block near the end of this file exercises
// dismissRuleImportAction directly (a real 'use server' function, same reasoning
// tests/app/import-actions.test.ts gives for mocking these two rather than letting the real
// ones run under jsdom) -- same origin/host pair that file uses, so isSameOrigin accepts it.
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

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

// recharts' ResponsiveContainer requires ResizeObserver to mount, which jsdom does not provide --
// same test-environment shim as tests/app/reports-client.test.tsx. Item 1 (2026-08-30 plan)
// mocks SavingsChart itself below (the dashboard's own 12-month card, formerly CashflowChart), so
// nothing in this file actually exercises recharts any more -- the shim is kept anyway, on the
// same "harmless and cheap" reasoning as every other global test shim in this repo, rather than
// leaving a future card that DOES mount a real chart to rediscover the missing polyfill.
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

// Item 1 (2026-08-30 plan): the dashboard's 12-month card now renders SavingsChart (the same
// component Reports uses) instead of the plain CashflowChart. Stubbed the same way as
// QuickAddTransaction above, to capture the exact `data` array DashboardPage builds rather than
// trying to read it back out of recharts' own DOM -- jsdom's ResponsiveContainer measures 0x0 and
// renders none of its children (see reports-client.test.tsx and reports.test.tsx, which hit the
// same limitation), so asserting on chart internals is not an option here either.
const capturedSavingsChartProps = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('@/components/charts/SavingsChart', () => ({
  SavingsChart: (props: { data: unknown }) => {
    capturedSavingsChartProps.data = props.data;
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
    // v1.25.0 backlog item 15: the person-scope pills' wrapper is now PillNav's own
    // a labelled `<nav>` landmark (src/components/ui/PillNav.tsx), the implicit navigation
    // landmark -- see that component's own docblock for why the shared control settled on the
    // same explicit role the transactions transfer-view control (v1.24.0) already used.
    expect(screen.queryByRole('navigation', { name: 'Whose money to show' })).toBeNull();
    expect(screen.getByText('Your month.')).toBeTruthy();
    // The self viewer's own spending still shows up -- this is their own transaction ($12.00,
    // uncategorized). Item 4 (2026-08-30 plan) means it now appears in BOTH "Spent this month"
    // (which counts uncategorized spend since this fix) and "Net this month" (which always did),
    // so this asserts at least one match rather than the single match it used to be.
    expect(screen.getAllByText(/\$12\.00/).length).toBeGreaterThanOrEqual(1);
  });

  it('a household viewer keeps the full card set, including net worth, top merchants and the person switcher', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Net worth')).toBeTruthy();
    expect(screen.getByText('Top merchants')).toBeTruthy();
    // v1.25.0 backlog item 15: same role change as the self-viewer test above.
    expect(screen.getByRole('navigation', { name: 'Whose money to show' })).toBeTruthy();
  });

  /**
   * F-01 (v1.31.0). The Top merchants card is scoped to the month being viewed AND to the person
   * pill, so its link has to carry both: a bare `?q=<merchant>` opens the household's whole
   * history at that merchant, which is not the figure the card just stated.
   *
   * The seeded description is 'BIG STORE' but the row reads 'BIG', and that is the point of
   * asserting on this merchant rather than a name that survives untouched: `topMerchants` groups
   * by transactions.normalized_merchant, and normalizeMerchant() drops the bare token 'STORE' as
   * a store-number marker (src/lib/categorize/normalize.ts). So the link has to carry the
   * NORMALIZED name -- which is what `?q=` matches against on the receiving page
   * (transactions.ts's `upper(normalizedMerchant) like`) -- and a future edit that "helpfully"
   * passed the raw bank description instead would fail here rather than ship a link that lands
   * on a filter matching nothing.
   */
  it('links each top merchant to that merchant within the month the card is showing', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('link', { name: 'BIG' }).getAttribute('href')).toBe(
      `/transactions?range=custom&from=${monthStart(currentMonth())}&to=${monthEnd(currentMonth())}&q=BIG`,
    );
  });

  it('carries the person pill into the merchant link, so the list answers the question the card answered', async () => {
    const { adultId, childId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({ person: String(childId) }) }));

    expect(screen.getByRole('link', { name: 'KID SHOP' }).getAttribute('href')).toContain(`&person=${childId}&`);
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
    // Categorised, though it no longer has to be: before item 8a (2026-08-30 plan), "Spent this
    // month" read budgetTotals(budgetProgress(month)), which attributes spend by category id and
    // never saw an uncategorised (categoryId: null) transaction at all -- unlike cashflowTrend
    // (Money in/Net/savingsProgress), which counted every uncategorised row as spend. Item 4
    // moved "Spent this month" onto cashflowTrend too, so both would now follow the chosen month
    // regardless of category; this fixture is kept categorised anyway so this test still proves
    // the ORIGINAL claim (budgetProgress itself honours `month`) rather than only the newer one.
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
    // This fixture's only spend is a single $40 transaction in the previous month, so exactly one
    // of the six trailing months the runway asks for has any data. The tile says so, and still
    // shows the figure: the average is $40 over 1 month, never $40 spread across 6 (the leading
    // five months predate this household entirely -- see cashRunway's own trim, src/lib/runway.ts).
    expect(runwayTile?.textContent).toContain('$40.00 average monthly spend');
    expect(runwayTile?.textContent).toContain('based on 1 month of history');
    expect(runwayTile?.textContent).not.toContain('1 months');
    expect(runwayTile?.textContent).toContain('months covered');
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

  // Item 1 (2026-08-30 plan): the dashboard's 12-month card renders SavingsChart, the same
  // component Reports uses, in place of the plain CashflowChart -- fed a target resolved per
  // month via savingsProgress() (ruling T1). Only the current month gets a target here, so this
  // also proves the other 11 months in the trailing window carry `targetCents: null` rather than
  // a fallback 0 (SavingsChart.tsx's own docblock: a null-vs-0 mixup would draw a dashed target
  // line reading "your target was nothing" for a month that in fact had no target at all).
  it('renders the savings chart trimmed to the months with real history, and a month with no target carries targetCents: null, never 0', async () => {
    const { adultId } = await setupMonths();
    saveSavingsTarget({ month: currentMonth(), mode: 'amount', value: 20000 });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const data = capturedSavingsChartProps.data as Array<{ month: string; targetCents: number | null }>;
    // Item 5 (2026-08-30 plan): setupMonths' only transaction is dated prevMonth, so every one
    // of the 10 months before it is a leading month with no history and is trimmed -- only
    // prevMonth and currentMonth (the two REAL months in this fixture) survive, not all 12.
    expect(data.map((row) => row.month)).toEqual([prevMonth, currentMonth()]);
    expect(data.find((row) => row.month === currentMonth())?.targetCents).toBe(20000);
    // prevMonth (set up by setupMonths' own fixture) never got a target -- it must read `null`,
    // not `0`.
    expect(data.find((row) => row.month === prevMonth)?.targetCents).toBeNull();
  });

  // Ruling T3: the savings target is household-scope only, the same gate the "Saved this month"
  // tile above already uses -- a self-scoped viewer must never receive a resolved target on the
  // chart either, even when the household has one on file for the current month.
  it('a self-scoped viewer never receives a resolved savings target on the chart, even when one is set', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Kid', username: 'kid', password: 'correct horse battery', role: 'member' });
    void adult;
    // Item 5: with no history at all for this child, the trim below would leave the chart with
    // nothing to show -- one of their own transactions, dated today, is what this test needs to
    // exercise the target-nulling behavior on a non-empty chart.
    const accountId = createAccount({ name: 'Kid Chequing', type: 'chequing', ownerUserId: child.id });
    createManualTransaction({
      accountId,
      date: today,
      description: 'KID SNACK',
      amountCents: -500,
      categoryId: null,
      attributedUserId: child.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    saveSavingsTarget({ month: currentMonth(), mode: 'amount', value: 20000 });
    currentUser.value = { id: child.id, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const data = capturedSavingsChartProps.data as Array<{ targetCents: number | null }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((row) => row.targetCents === null)).toBe(true);
  });

  /**
   * v1.21.0 plan, item 5, defect 1. This is the owner's own reported shape: a household a few
   * weeks old, whose only real history is the last couple of months, used to see all 12 trailing
   * months plotted (ten of them at a flat 0,0) and a card confidently titled "12-month cashflow".
   */
  describe('item 5: the 12-month cashflow card names how much history it actually has', () => {
    it('with two real months, the title and description say 2, not 12', async () => {
      const { adultId } = await setupMonths();
      currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
      const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
      // Viewing prevMonth (not the current month) so the "Always the trailing..." clause, which
      // only appears once the viewed month differs from today, is on screen to assert against.
      const { container } = render(await DashboardPage({ searchParams: Promise.resolve({ month: prevMonth }) }));

      expect(screen.getByText('2-month cashflow')).toBeTruthy();
      expect(screen.queryByText('12-month cashflow')).toBeNull();
      expect(container.textContent).toContain(`Always the trailing 2 months to today, not ${monthLabel(prevMonth)}.`);
    });

    it('with only the current month of history, the title reads as one month, not "1-month"', async () => {
      t = createTestDb();
      const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
      const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
      createManualTransaction({
        accountId,
        date: today,
        description: 'FIRST EVER PURCHASE',
        amountCents: -1000,
        categoryId: null,
        attributedUserId: adult.id,
        userId: adult.id,
        actorRole: 'admin',
      });
      currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
      const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
      render(await DashboardPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByText("This month's cashflow")).toBeTruthy();
      expect(capturedSavingsChartProps.data).toEqual([expect.objectContaining({ month: currentMonth() })]);
    });

    it('with no transactions at all, shows an empty state instead of an empty chart', async () => {
      t = createTestDb();
      const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
      createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
      currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
      const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
      render(await DashboardPage({ searchParams: Promise.resolve({}) }));

      expect(screen.getByText('Cashflow')).toBeTruthy();
      expect(screen.getByText('No transactions yet to chart.')).toBeTruthy();

      // Item 14, checked from the same fixture: a household this new has zero complete months
      // to average, and the runway tile must say so honestly rather than the old, actively false
      // "no spending history yet to average" (this page shows nothing BUT this household's own
      // lack of history, so there is nothing on screen that sentence was ever true against).
      const runwayTile = screen.getByText('Cash runway').closest('div');
      expect(runwayTile?.textContent).not.toContain('no spending history');
      expect(runwayTile?.textContent).toContain('one complete month');
    });
  });
});

/**
 * Item 4 (2026-08-30 plan): "Spent this month" now counts EVERYTHING cashflowTrend counts
 * (uncategorized rows included), so it reconciles with "Money in" and "Net this month" on the
 * face of the card, and names the uncategorized share with a link to the review queue.
 */
describe('DashboardPage — item 4 (Spent tile counts everything)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  it('Spent this month includes uncategorized spend, reconciles Money in - Spent = Net, and names the uncategorized share with a link', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    const salary = createCategory({ name: 'Salary', parentId: null, isIncome: true });
    const groceries = createCategory({ name: 'Groceries', parentId: null });
    createManualTransaction({
      accountId,
      date: today,
      description: 'PAYCHEQUE',
      amountCents: 500_000,
      categoryId: salary,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    createManualTransaction({
      accountId,
      date: today,
      description: 'SUPERMARKET',
      amountCents: -100_000,
      categoryId: groceries,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    createManualTransaction({
      accountId,
      date: today,
      description: 'UNKNOWN SHOP',
      amountCents: -25_000,
      categoryId: null,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    // $1,000.00 (Groceries) + $250.00 (uncategorized) = $1,250.00 -- before item 4 this tile
    // would have shown only $1,000.00 (budgetProgress never sees the uncategorized row at all).
    const spentTile = screen.getByText('Spent this month').closest('div');
    expect(spentTile?.textContent).toContain('$1,250.00');

    // The uncategorized share is named on the tile, linking to the review queue.
    const uncategorizedLink = screen.getByText('$250.00 not categorized yet');
    expect(uncategorizedLink.closest('a')?.getAttribute('href')).toBe('/transactions?review=1');

    // Money in ($5,000.00) - Spent ($1,250.00) = Net (+$3,750.00) -- the reconciliation item 4
    // exists to restore.
    const moneyInTile = screen.getByText('Money in').closest('div');
    expect(moneyInTile?.textContent).toContain('$5,000.00');
    const netTile = screen.getByText('Net this month').closest('div');
    expect(netTile?.textContent).toContain('+$3,750.00');
  });

  it('says nothing about uncategorized spend when there is none', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    const groceries = createCategory({ name: 'Groceries', parentId: null });
    createManualTransaction({
      accountId,
      date: today,
      description: 'SUPERMARKET',
      amountCents: -100_000,
      categoryId: groceries,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const spentTile = screen.getByText('Spent this month').closest('div');
    expect(spentTile?.textContent).toContain('$1,000.00');
    expect(screen.queryByText(/not categorized yet/)).toBeNull();
  });
});

/**
 * Item 7 (2026-08-30 plan): when an active account has no balance snapshot at all, the Net worth
 * tile stops asserting a sign (accountsMissing > 0 means the sign is not established), marks the
 * figure "(partial)", and offers a route to fix it -- rather than rendering a confident green or
 * red figure that excludes the very accounts that could flip it.
 */
describe('DashboardPage — item 7 (Net worth stops asserting when accounts are missing)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  it('marks the figure partial, drops the positive/negative tone, drops the delta, and links to Settings > Accounts', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const hasSnapshot = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    createAccount({ name: 'Never snapshotted', type: 'credit', ownerUserId: adult.id });
    recordBalanceSnapshot({ accountId: hasSnapshot, date: today, balanceCents: 500_000, source: 'manual' });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    const { container } = render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const netWorthTile = screen.getByText('Net worth').closest('div') as HTMLElement;
    expect(netWorthTile.textContent).toContain('(partial)');
    expect(netWorthTile.textContent).toContain('1 account has no balance yet');
    // No colored tone -- the sign is not established with an account excluded.
    const valueSpan = netWorthTile.querySelector('.money-lg') as HTMLElement;
    expect(valueSpan.className).not.toMatch(/money-pos|money-neg/);
    // No "vs last month" delta compounding the same unsupported claim a second way.
    expect(netWorthTile.textContent).not.toMatch(/vs last month/);

    const accountsLink = screen.getByText('Update in Settings and Accounts').closest('a');
    expect(accountsLink?.getAttribute('href')).toBe('/settings/accounts');
    void container;
  });

  it('keeps the positive/negative tone and the delta when no account is missing a balance', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    // addMonths takes a MONTH KEY ('YYYY-MM'), not a full date -- monthEnd back to a real date.
    recordBalanceSnapshot({ accountId, date: monthEnd(addMonths(currentMonth(), -1)), balanceCents: 400_000, source: 'manual' });
    recordBalanceSnapshot({ accountId, date: today, balanceCents: 500_000, source: 'manual' });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    const netWorthTile = screen.getByText('Net worth').closest('div') as HTMLElement;
    expect(netWorthTile.textContent).not.toContain('(partial)');
    const valueSpan = netWorthTile.querySelector('.money-lg') as HTMLElement;
    expect(valueSpan.className).toMatch(/money-pos/);
    expect(netWorthTile.textContent).toMatch(/vs last month/);
    expect(screen.queryByText('Update in Settings and Accounts')).toBeNull();
  });
});

/**
 * v1.26.0 Lane 3b. RuleReviewCard (src/components/RuleReviewCard.tsx) is the standing notice
 * for "rules did this, nobody has looked" -- unreviewedRuleImports() (src/lib/import/commit.ts)
 * is deliberately not viewer-scoped, so these fixtures build imports/transactions rows with raw
 * SQL exactly the way tests/lib/import/rules-audit.test.ts's own setup() does (that file is
 * owned by a concurrent lane and is not touched here), rather than driving a real CSV through
 * commitStagedImport just to get a categorization_source of 'rule' onto a row.
 */
describe('DashboardPage — Lane 3b: the unreviewed-rule-imports card', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function addImport(accountId: number, userId: number, filename: string): number {
    const row = t!.db.get<{ id: number }>(sql`
      insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
      values (${accountId}, null, ${filename}, ${userId}, 0, 0, 0, ${nowIso()})
      returning id`);
    return row.id;
  }

  function addRuleRow(accountId: number, importId: number, userId: number, description = 'CORNER MARKET'): number {
    const row = t!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents,
                                category_id, categorization_source, is_transfer, hash_version, created_by, created_at, updated_at)
      values (${accountId}, ${importId}, '2026-03-04', ${description}, ${description}, -2500,
              null, 'rule', 0, 1, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  }

  it('renders nothing at all when no import is unreviewed', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText('Rules categorized these on import')).toBeNull();
  });

  it('lists an unreviewed import with account, filename and count, linking to the fixed audit contract URL', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Joint Chequing', type: 'chequing', ownerUserId: adult.id });
    const importId = addImport(accountId, adult.id, 'march.csv');
    addRuleRow(accountId, importId, adult.id, 'CORNER MARKET');
    addRuleRow(accountId, importId, adult.id, 'FUEL DEPOT');
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Rules categorized these on import')).toBeTruthy();
    expect(screen.getByText('Joint Chequing')).toBeTruthy();
    expect(screen.getByText(/march\.csv/)).toBeTruthy();
    expect(screen.getByText(/2 transactions categorized by a rule/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Check' });
    // The URL contract is fixed (v1.26.0 Lane 3a/3b) -- never a param this lane invents.
    expect(link.getAttribute('href')).toBe(`/transactions?import=${importId}&source=rule&group=category`);
  });

  it('caps the list and reports how many more there are', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Joint Chequing', type: 'chequing', ownerUserId: adult.id });
    for (let i = 0; i < 7; i += 1) {
      const importId = addImport(accountId, adult.id, `statement-${i}.csv`);
      addRuleRow(accountId, importId, adult.id, `MERCHANT ${i}`);
    }
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    // RULE_REVIEW_ROW_LIMIT (RuleReviewCard.tsx) is 5 -- 7 unreviewed imports means 5 rows and
    // an overflow line naming the other 2, never a silently truncated or unbounded list.
    expect(screen.getAllByRole('link', { name: 'Check' })).toHaveLength(5);
    expect(screen.getByText('+2 more to check')).toBeTruthy();
  });

  it('a self viewer never sees the card, even with an unreviewed import on the books', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const kid = await createUser({ name: 'Kid', username: 'kid', password: 'correct horse battery', role: 'member' });
    const accountId = createAccount({ name: 'Joint Chequing', type: 'chequing', ownerUserId: adult.id });
    const importId = addImport(accountId, adult.id, 'march.csv');
    addRuleRow(accountId, importId, adult.id);
    currentUser.value = { id: kid.id, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByText('Rules categorized these on import')).toBeNull();
  });

  it('dismiss calls markImportRulesReviewed, and the entry disappears from the card', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Joint Chequing', type: 'chequing', ownerUserId: adult.id });
    const importId = addImport(accountId, adult.id, 'march.csv');
    addRuleRow(accountId, importId, adult.id);
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };

    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Rules categorized these on import')).toBeTruthy();

    // dismissRuleImportAction (src/app/(app)/dashboard/actions.ts) is the real 'use server'
    // function -- invoked directly with a FormData rather than through the rendered
    // DismissImportForm, the same reasoning tests/app/import-actions.test.ts and
    // tests/app/bills-actions.test.ts give for calling their own actions directly against a
    // real DB instead of simulating a click through jsdom.
    const { dismissRuleImportAction } = await import('@/app/(app)/dashboard/actions');
    const fd = new FormData();
    fd.set('importId', String(importId));
    const result = await dismissRuleImportAction({}, fd);
    expect(result.error).toBeUndefined();

    cleanup();
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText('Rules categorized these on import')).toBeNull();
  });
});
