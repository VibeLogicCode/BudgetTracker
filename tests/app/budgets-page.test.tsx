// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { render, cleanup, screen } from '@testing-library/react';
import type { Db } from '@/db/client';
import { nowIso } from '@/lib/clock';
import { upsertBudget, setRollover } from '@/lib/budgets';
import { addMonths, currentMonth, todayIso } from '@/lib/dates';
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
});
