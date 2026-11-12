// @vitest-environment jsdom
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { saveSavingsTarget, savingsProgress } from '@/lib/savings-target';
import { createManualTransaction } from '@/lib/transactions';
import { todayIso } from '@/lib/dates';
import { cashflowTrend } from '@/lib/reports';
import { setTransactionSplits } from '@/lib/splits';
import type { Viewer } from '@/lib/auth/viewer';
import type { SavingsMonthRow } from '@/app/(app)/reports/reports-client';
import { createSeededTestDb, createTestDb, categoryIdByName, type TestDb } from '../helpers/db';

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

// Pin Date (only) so a run that crosses local midnight or a month end cannot disagree with itself.
vi.useFakeTimers({ now: new Date('2026-03-18T16:00:00.000Z'), toFake: ['Date'] });
afterAll(() => vi.useRealTimers());

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

  // v1.13.0 ruling R2 (fix round 2, controller directive): listUsers() names every household
  // member -- an RSC payload prop reaches the browser even when the client component never
  // renders it, so `people` itself must carry no other member's name for a self viewer, not
  // merely have its <select> hidden. This is the DOM-visible proxy for that: if `people` ever
  // leaked into this render (a future Field un-hiding it, a stray option list, anything), the
  // other member's name would show up somewhere in the tree, and this test would catch it.
  it('a self viewer render carries no other household members name', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).not.toContain('Adult');
  });

  // Ruling R2 (fix round 2): "no export links offered" -- the top Export CSV control must not
  // appear at all for a self viewer, independent of Task 14's server-side route refusal.
  it('a self viewer sees no Export CSV link', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    // getByRole('link', ...), not a plain text search -- "Export CSV" also appears in the
    // PageGuide's descriptive prose (unconditionally, for every viewer), which is not itself
    // an offered control and is not what ruling R2's "no export links offered" is about.
    expect(container.querySelector('a[href^="/api/reports/export"]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull();
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

  // Fix round 2's positive mirror: a household viewer keeps both the other member's name (in
  // the Person picker's own options) and the Export CSV link.
  it('a household viewer render carries every members name and the Export CSV link', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).toContain('Adult');
    expect(container.textContent).toContain('Kid');
    expect(container.querySelector('a[href^="/api/reports/export"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export CSV' })).toBeTruthy();
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

  // v1.13.0 ruling R2 (item C1). The page used to call suggestionsFor({ scope: 'household',
  // userId: null }) UNCONDITIONALLY and hand its baselines/baselineMonthsUsed straight to the
  // client regardless of viewer, and reports-client.tsx's "Category baselines" card had no gate
  // of its own -- so a self viewer's household-wide category baselines rendered exactly like a
  // household viewer's. Fixed the same way the sibling Net worth/Debt over time/Tax year cards
  // already are: dropped ENTIRELY for a self viewer, not shown as an empty/scoped-to-zero
  // version -- this household's real baseline data (below three months, so it would otherwise
  // render "Not enough history yet") never even computes for one.
  it('a self viewer sees no Category baselines card', async () => {
    const { childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole('heading', { name: 'Category baselines' })).toBeNull();
  });

  it('a household viewer keeps the Category baselines card', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: 'Category baselines' })).toBeTruthy();
  });

  // v1.14.0 (spec BU, ruling P12): hasLoans and hasLent both come from ONE listLoans call, and
  // hasLoans keeps its exact pre-1.14.0 meaning -- any loan with a tracked balance, either
  // direction -- so a household whose only tracked loan is lent still gets the debt card.
  it('hasLoans and hasLent both reflect one listLoans() read (ruling P12)', async () => {
    const { adultId } = await setup();
    const loanType = t!.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Personal loan', 0, 'loan', ?) returning id`)
      .get(today) as { id: number };
    t!.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, loan_direction, created_at, updated_at)
         values ('Loan to a friend', '2024-01-15', 0, ?, ?, 50000, ?, 'lent', ?, ?)`,
      )
      .run(adultId, loanType.id, today, today, today);
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    // setup() already seeded one owed loan (Civic) with a tracked balance, so both flags are
    // true here -- both loans, one of each direction, from the single read. hasLent shows up
    // in the card's own description (recharts renders nothing in jsdom at 0x0, so the chart's
    // legend itself is not a reachable assertion here -- see DebtTrendChart's own tests).
    expect(screen.getByRole('heading', { name: 'Debt over time' })).toBeTruthy();
    expect(screen.getByText('What the household owes, and what it has lent out, as separate lines.')).toBeTruthy();
  });

  it('a household with only an owed loan keeps the pre-1.14.0 card description', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: 'Debt over time' })).toBeTruthy();
    expect(screen.getByText('Total owed across every loan with a balance.')).toBeTruthy();
  });

  it('hasLoans stays true for a household whose only tracked loan is lent (ruling P12)', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const loanType = t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Personal loan', 0, 'loan', ?) returning id`)
      .get(today) as { id: number };
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, loan_direction, created_at, updated_at)
         values ('Loan to a friend', '2024-01-15', 0, ?, ?, 50000, ?, 'lent', ?, ?)`,
      )
      .run(adult.id, loanType.id, today, today, today);
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('heading', { name: 'Debt over time' })).toBeTruthy();
  });

  it('a household with no loans at all gets no debt card', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.queryByRole('heading', { name: 'Debt over time' })).toBeNull();
  });

  // Lane 4 (savings targets, v1.17.0 spec docs/superpowers/plans/2026-08-30-savings-targets.md):
  // the page now resolves each month's target via savingsProgress() (Lane 1,
  // src/lib/savings-target.ts) and folds it into the Cash flow card's row data. This is the one
  // test that exercises that wiring end to end against a real database -- every other savings-
  // target assertion for this card (tests/app/reports-client.test.tsx) passes synthetic props
  // straight to ReportsClient and never touches the page itself. Needs a seeded DB (not the bare
  // createTestDb() the rest of this file uses) so an income category ("Salary") exists to file
  // the paycheque under -- cashflowTrend only counts an is_income category as income
  // (src/lib/reports.ts), and the bare createTestDb() setup() above deliberately files every
  // transaction under categoryId: null so it nets as spend.
  it('a savings target set for the current month reaches the Cash flow card summary', async () => {
    t = createSeededTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adult.id });
    const salary = categoryIdByName(t.db, 'Salary');
    createManualTransaction({
      accountId,
      date: today,
      description: 'PAYCHEQUE',
      amountCents: 500000,
      categoryId: salary,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    createManualTransaction({
      accountId,
      date: today,
      description: 'GROCERIES',
      amountCents: -350000,
      categoryId: null,
      attributedUserId: adult.id,
      userId: adult.id,
      actorRole: 'admin',
    });
    // $1,000 target against $1,500 actually saved (income $5,000 - spend $3,500) -- met, and it
    // is the only month in range with a target set, so the card should read "1 of 1".
    saveSavingsTarget({ month: today.slice(0, 7), mode: 'amount', value: 100000 });

    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const { container } = render(await ReportsPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).toContain('Target met in 1 of 1 month.');
  });
});

/**
 * v1.60.0 item 13b. Each month's savings target and whether it was met come from ONE household
 * read and one target read, not savingsProgress per month (four queries each, up to 24 months).
 * The figures must equal savingsProgress month by month -- the v1.59.1 computation -- on a fixture
 * with transfers, a split, refunds and uncategorized rows both ways, a person filter set, and for a
 * self viewer.
 */
describe('ReportsPage — savings targets in one read (v1.60.0 item 13b)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const RANGE = { range: 'custom', from: '2026-01-01', to: '2026-03-31' };
  const MONTHS = ['2026-01', '2026-02', '2026-03'];

  async function seed() {
    t = createSeededTestDb();
    const alex = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const sam = await createUser({ name: 'Sam', username: 'sam', password: 'correct horse battery', role: 'member' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: alex.id });
    const salary = categoryIdByName(t.db, 'Salary');
    const groceries = categoryIdByName(t.db, 'Groceries');
    const gas = categoryIdByName(t.db, 'Gas');
    const add = (date: string, amountCents: number, categoryId: number | null, person: number, description = 'MAPLE GROCER') =>
      createManualTransaction({ accountId, date, description, amountCents, categoryId, attributedUserId: person, userId: alex.id, actorRole: 'admin' });
    for (const [month, pay] of [['2026-01', 400_000], ['2026-02', 380_000], ['2026-03', 410_000]] as const) {
      add(`${month}-01`, pay, salary, alex.id, 'PAYROLL');
      add(`${month}-02`, 120_000, salary, sam.id, 'PAYROLL');
      add(`${month}-04`, -95_000, groceries, sam.id);
      add(`${month}-06`, 4_000, groceries, sam.id);
      add(`${month}-09`, -21_000, null, alex.id, 'FUEL STOP 12');
      add(`${month}-11`, 6_500, null, sam.id, 'E-TRANSFER');
      const transfer = add(`${month}-13`, -150_000, null, alex.id, 'TO SAVINGS');
      t.db.run(sql`update transactions set is_transfer = 1 where id = ${transfer}`);
      const split = add(`${month}-15`, -30_000, groceries, sam.id);
      setTransactionSplits({
        txnId: split,
        parts: [
          { categoryId: groceries, amountCents: -18_000 },
          { categoryId: gas, amountCents: -12_000 },
        ],
        userId: alex.id,
      });
    }
    saveSavingsTarget({ month: '2026-01', mode: 'percent', value: 20 });
    saveSavingsTarget({ month: '2026-02', mode: 'amount', value: 200_000 });
    saveSavingsTarget({ month: '2026-03', mode: 'amount', value: 900_000 });
    return { alex, sam };
  }

  async function cashflowProp(params: Record<string, string>): Promise<SavingsMonthRow[]> {
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    const element = await ReportsPage({ searchParams: Promise.resolve(params) });
    return (element.props as { cashflow: SavingsMonthRow[] }).cashflow;
  }

  /** Cashflow queries prepared during `run` -- the grouped month-by-income read, old shape or new. */
  async function cashflowReads(run: () => Promise<unknown>): Promise<number> {
    const sqlite = t!.sqlite;
    const original = sqlite.prepare.bind(sqlite);
    let count = 0;
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((text: string) => {
      if (/group by substr\("transactions"\."date", 1, 7\), (?:case\s+when )?"categories"\."is_income"/.test(text)) count += 1;
      return original(text);
    }) as TestDb['sqlite']['prepare']);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return count;
  }

  /** v1.59.1's computation: the card's own row, plus savingsProgress for that month. */
  function oracle(person: number | null, viewer: Viewer): SavingsMonthRow[] {
    return MONTHS.map((month) => {
      const row = cashflowTrend(1, { endMonth: month, attributedUserId: person }, viewer)[0];
      const progress = savingsProgress(month, viewer);
      return { ...row, targetCents: progress.targetCents, met: progress.met };
    });
  }

  it('with a person filter, each month equals savingsProgress month by month, from two cashflow reads', async () => {
    const { alex, sam } = await seed();
    currentUser.value = { id: alex.id, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const viewer: Viewer = { id: alex.id, role: 'admin', visibility: 'household' };
    const params = { ...RANGE, person: String(sam.id) };

    const rows = await cashflowProp(params);
    expect(rows).toEqual(oracle(sam.id, viewer));
    // The targets are the household ones, met against the household net, never the filtered person.
    expect(rows.map((row) => row.met)).toEqual([true, true, false]);
    expect(rows.every((row) => row.targetCents !== null)).toBe(true);
    // The card rows and the household rows; v1.59.1 read the card rows plus one per month.
    expect(await cashflowReads(() => cashflowProp(params))).toBe(2);
  });

  it('with no person filter, the household rows are the card rows: one cashflow read', async () => {
    const { alex } = await seed();
    currentUser.value = { id: alex.id, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const viewer: Viewer = { id: alex.id, role: 'admin', visibility: 'household' };
    expect(await cashflowProp(RANGE)).toEqual(oracle(null, viewer));
    expect(await cashflowReads(() => cashflowProp(RANGE))).toBe(1);
  });

  it('a self viewer gets savingsProgress over their own rows, as before, whatever person the URL names', async () => {
    const { alex, sam } = await seed();
    currentUser.value = { id: sam.id, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    const samSelf: Viewer = { id: sam.id, role: 'member', visibility: 'self' };
    expect(await cashflowProp({ ...RANGE, person: String(alex.id) })).toEqual(oracle(sam.id, samSelf));
    expect(await cashflowReads(() => cashflowProp(RANGE))).toBe(1);
  });
});

/**
 * v1.60.0 item 8. /import sends a self viewer back to the dashboard and every /settings page is
 * admin-only, so neither viewer is offered a link to one. The cards say who can act instead.
 */
describe('ReportsPage — no link that bounces the viewer (v1.60.0 item 8)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function seed() {
    t = createTestDb();
    const alex = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const sam = await createUser({ name: 'Sam', username: 'sam', password: 'correct horse battery', role: 'member' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: alex.id });
    createManualTransaction({
      accountId, date: todayIso(), description: 'MAPLE GROCER', amountCents: -5000, categoryId: null,
      attributedUserId: sam.id, userId: alex.id, actorRole: 'admin',
    });
    // An owed loan, so the Debt over time card renders its own empty state.
    const loanType = t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Car loan', 0, 'loan', ?) returning id`)
      .get(todayIso()) as { id: number };
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, balance_updated_at, created_at, updated_at)
         values ('Civic', '2024-01-15', 0, ?, ?, 1500000, ?, ?, ?)`,
      )
      .run(alex.id, loanType.id, todayIso(), todayIso(), todayIso());
    return { alex, sam };
  }

  const hrefs = (container: HTMLElement) => [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  async function renderAs(user: { id: number; name: string; username: string }, role: 'admin' | 'member', visibility: 'household' | 'self') {
    currentUser.value = { id: user.id, name: user.name, username: user.username, role, visibility };
    const { default: ReportsPage } = await import('@/app/(app)/reports/page');
    return render(await ReportsPage({ searchParams: Promise.resolve({}) }));
  }

  it('a self viewer sees no Import or Settings link, and is told who marks income', async () => {
    const { sam } = await seed();
    const { container } = await renderAs(sam, 'member', 'self');
    expect(hrefs(container).filter((href) => href.startsWith('/import') || href.startsWith('/settings'))).toEqual([]);
    expect(container.textContent).toContain('An admin marks income categories in Settings.');
  });

  it('a member with household visibility can import, but sees no Settings link', async () => {
    const { sam } = await seed();
    const { container } = await renderAs(sam, 'member', 'household');
    expect(hrefs(container).filter((href) => href.startsWith('/settings'))).toEqual([]);
    expect(hrefs(container)).toContain('/import');
    expect(container.textContent).toContain('Net worth appears here once an admin records a balance');
    expect(container.textContent).toContain('Categories show here once an admin marks them as tax relevant in Settings.');
  });

  it('an admin keeps every link', async () => {
    const { alex } = await seed();
    const { container } = await renderAs(alex, 'admin', 'household');
    const all = hrefs(container);
    expect(all).toContain('/import');
    expect(all).toContain('/settings/managers');
    expect(all).toContain('/settings/accounts');
  });
});
