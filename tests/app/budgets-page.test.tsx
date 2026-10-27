// @vitest-environment jsdom
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { render, cleanup, screen } from '@testing-library/react';
import type { Db } from '@/db/client';
import { nowIso } from '@/lib/clock';
import { upsertBudget, setRollover } from '@/lib/budgets';
import { addMonths, currentMonth, todayIso } from '@/lib/dates';
// Lane 1 (src/lib/savings-target.ts): not mocked, real DB, same as every other lib import in
// this file.
import { saveSavingsTarget } from '@/lib/savings-target';
import { setBudgetCategory } from '@/lib/warranty/items';
import { addInstallment } from '@/lib/warranty/installments';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.13.0 rulings R2 and R11 / micro-ruling M9. No budgets-page.test.tsx existed before this task
 * (confirmed: neither in the working tree nor anywhere in git history) despite the brief calling
 * this a "Modify" -- this is a new file. Follows the same render-the-real-page-with-a-seeded-db
 * pattern as tests/app/dashboard.test.tsx.
 */

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

function insertBillType(db: Db, name: string): number {
  const row = db.get<{ id: number }>(sql`
    insert into warranty_item_types (name, kind, is_subscription, created_at)
    values (${name}, 'bill', 0, ${nowIso()})
    returning id`);
  return row.id;
}

function insertBillItem(db: Db, over: { ownerUserId: number; typeId: number; name: string }): number {
  const row = db.get<{ id: number }>(sql`
    insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
    values (${over.name}, '2024-01-15', 0, ${over.ownerUserId}, ${over.typeId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

// Pin Date (only) so a run that crosses local midnight or a month end cannot disagree with itself.
vi.useFakeTimers({ now: new Date('2026-03-18T16:00:00.000Z'), toFake: ['Date'] });
afterAll(() => vi.useRealTimers());

describe('BudgetsPage (rulings R2, R11 / M9)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const month = currentMonth();
  const prevMonth = addMonths(month, -1);
  const today = todayIso();

  async function setup() {
    t = createSeededTestDb();
    const db = t.db;
    const adultId = insertTestUser(db, { name: 'Adult', username: 'adult', role: 'admin' });
    const childId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    insertTestAccount(db, { name: 'Chequing', ownerUserId: adultId });

    // Ruling R11 / M9: a household bill linked to a category, with a carry accumulated from
    // last month's underspend, so this month's row can say what it is saving for.
    const propertyTaxCategoryId = categoryIdByName(db, 'Property Tax');
    const billType = insertBillType(db, 'Property tax bill');
    const itemId = insertBillItem(db, { ownerUserId: adultId, typeId: billType, name: 'Property tax' });
    setBudgetCategory(itemId, propertyTaxCategoryId);
    addInstallment({ itemId, dueDate: '2099-06-30', amountCents: 180000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: propertyTaxCategoryId, month: prevMonth, amountCents: 100000 });
    setRollover({ scope: 'household', userId: null, categoryId: propertyTaxCategoryId, enabled: true, startMonth: prevMonth });
    db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (
        (select id from accounts limit 1), ${`${prevMonth}-10`}, 'X', 'X', -55000, ${propertyTaxCategoryId}, 'manual', 0, ${adultId}, ${nowIso()}, ${nowIso()}
      ) returning id`);

    return { adultId, childId };
  }

  it('a household viewer sees the Household card, both personal sections, and the sinking-fund line', async () => {
    const { adultId, childId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).toContain('Household —');
    // Section headings, not a plain text search -- "Kids" (a seeded category cell) would
    // otherwise collide with a prefix match on "Kid".
    expect(screen.getByRole('heading', { name: 'Adult (you)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kid' })).toBeTruthy();
    // Ruling R11: "Accumulating for <bill> — $X of $Y by <date>", from sinkingFundsFor.
    expect(container.textContent).toContain('Accumulating for Property tax');
    expect(container.textContent).toContain('$450.00 of $1,800.00 by 2099-06-30');
    void childId;
  });

  it('a self viewer sees no Household card and only their own personal section', async () => {
    const { adultId, childId } = await setup();
    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({}) }));

    expect(container.textContent).not.toContain('Household —');
    expect(screen.queryByRole('heading', { name: /Adult/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Kid (you)' })).toBeTruthy();
    void adultId;
    void today;
  });

  // Lane 3 item 3 / ruling T3: household scope only -- same R2 gate as the Household card
  // itself, since a self viewer has no household scope to set a target for.
  it('a household viewer sees the savings target control; a self viewer does not', async () => {
    const { adultId, childId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { unmount } = render(await BudgetsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Savings target')).toBeTruthy();
    unmount();

    currentUser.value = { id: childId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    render(await BudgetsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByText('Savings target')).toBeNull();
  });

  it('a set target resolves for the viewed month, and Copy previous month brings it forward', async () => {
    const { adultId } = await setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    saveSavingsTarget({ month: prevMonth, mode: 'percent', value: 20 });
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({ month: prevMonth }) }));
    // Provisional-until-close wording (ruling T5) -- the exact resolved dollar figure is Lane
    // 1's own math to test; this just proves the page wired the real target through.
    expect(container.textContent).toContain('20% of income');
  });
});

/** Spec 2026-10-21 §2.2, against the real page and a seeded database. */
describe('BudgetsPage — Not categorized yet', () => {
  let t: TestDb | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  function seed() {
    t = createSeededTestDb();
    const db = t.db;
    const adultId = insertTestUser(db, { name: 'Adult', username: 'adult', role: 'admin' });
    const kidId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    insertTestAccount(db, { name: 'Chequing', ownerUserId: adultId });
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 50000 });
    const add = (amountCents: number, over: { categoryId?: number | null; attributedUserId?: number | null; isTransfer?: boolean } = {}) =>
      db.get<{ id: number }>(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
        values ((select id from accounts limit 1), '2026-03-12', 'X', 'X', ${amountCents}, ${over.categoryId ?? null}, 'none', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${adultId}, ${nowIso()}, ${nowIso()})
        returning id`).id;
    return { db, adultId, kidId, groceries, add };
  }

  it('shows uncategorized spending for the month on the household grid and in the header', async () => {
    const { adultId, groceries, add } = seed();
    add(-4500, { attributedUserId: adultId });
    add(-1250);
    add(-3000, { categoryId: groceries });
    add(-9900, { isTransfer: true });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.getByText('Not categorized yet')).toBeTruthy();
    expect(screen.getByText('2 transactions')).toBeTruthy();
    expect(container.textContent).toContain('$57.50 not categorized yet');
  });

  it('leaves out a split row', async () => {
    const { adultId, groceries, add } = seed();
    const split = add(-6000);
    t!.sqlite.prepare('insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(split, groceries, -4000, nowIso(), split, groceries, -2000, nowIso());
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.queryByText('Not categorized yet')).toBeNull();
  });

  it('a self viewer sees only their own uncategorized spending', async () => {
    const { adultId, kidId, add } = seed();
    add(-1000, { attributedUserId: kidId });
    add(-2000, { attributedUserId: adultId });
    currentUser.value = { id: kidId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(container.textContent).not.toContain('$30.00');
    expect(container.textContent).not.toContain('$20.00');
  });
});

/** v1.59.0 items 13-14: the income line, against the real page and a seeded database (clock pinned to 2026-03-18 above). */
describe('BudgetsPage — the income line', () => {
  let t: TestDb | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  function seed() {
    t = createSeededTestDb();
    const db = t.db;
    const alexId = insertTestUser(db, { name: 'Alex', username: 'alex', role: 'admin' });
    const samId = insertTestUser(db, { name: 'Sam', username: 'sam', role: 'member' });
    insertTestAccount(db, { name: 'Joint Chequing', ownerUserId: alexId });
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    const add = (date: string, amountCents: number, categoryId: number, attributedUserId: number | null) =>
      db.run(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
        values ((select id from accounts limit 1), ${date}, 'MAPLE GROCER', 'MAPLE GROCER', ${amountCents}, ${categoryId}, 'manual', 0, ${attributedUserId}, ${alexId}, ${nowIso()}, ${nowIso()})`);
    for (const month of ['2025-12', '2026-01', '2026-02', '2026-03']) {
      add(`${month}-01`, 400000, salary, alexId);
      add(`${month}-02`, 50000, salary, null);
      add(`${month}-05`, -8800, groceries, samId);
    }
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 50000 });
    upsertBudget({ scope: 'personal', userId: samId, categoryId: groceries, month: '2026-03', amountCents: 30000 });
    return { alexId, samId };
  }

  async function incomeProp(params: Record<string, string>) {
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const element = await BudgetsPage({ searchParams: Promise.resolve(params) });
    render(element);
    return (element.props as { income: Record<string, unknown> | null }).income;
  }

  it('Household compares household limits with household income and spending', async () => {
    const { alexId } = seed();
    currentUser.value = { id: alexId, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const income = await incomeProp({ month: '2026-03' });
    expect(income).toMatchObject({
      scopeLabel: 'Household',
      attributedUserId: null,
      incomeCents: 450000,
      spendCents: 8800,
      typicalMonths: ['2025-12', '2026-01', '2026-02'],
      typicalIncomeCents: 450000,
      budgetedLimitCents: 50000,
      noAttributedIncome: false,
    });
    expect(screen.getByText('Household, March 2026: Money in $4,500.00 · Spent $88.00 · Net +$4,412.00')).toBeTruthy();
  });

  it("?person= compares that person's own limits with what is attributed to them, never the household's income", async () => {
    const { alexId, samId } = seed();
    currentUser.value = { id: alexId, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const income = await incomeProp({ month: '2026-03', person: String(samId) });
    expect(income).toMatchObject({
      scopeLabel: 'Sam',
      attributedUserId: samId,
      incomeCents: 0,
      spendCents: 8800,
      typicalIncomeCents: 0,
      budgetedLimitCents: 30000,
      overTypicalByCents: null,
      noAttributedIncome: true,
    });
    expect(screen.getByText(/^No income is assigned to Sam yet in Dec-Feb\./)).toBeTruthy();
    expect(screen.queryByText(/more than typical income/)).toBeNull();
  });

  it("a self viewer's props carry only their own figures, whatever the URL asks for", async () => {
    const { alexId, samId } = seed();
    currentUser.value = { id: samId, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
    const income = await incomeProp({ month: '2026-03', person: String(alexId) });
    expect(income).toMatchObject({ scopeLabel: 'Sam', attributedUserId: samId, incomeCents: 0, spendCents: 8800, budgetedLimitCents: 30000 });
    const serialized = JSON.stringify(income);
    expect(serialized).not.toContain('450000');
    expect(serialized).not.toContain('400000');
    expect(serialized).not.toContain('50000');
  });
});
