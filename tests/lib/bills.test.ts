import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';
import { upsertBudget } from '@/lib/budgets';
import { upcomingBills, safeToSpend } from '@/lib/bills';

type Kind = 'warranty' | 'subscription' | 'contract' | 'loan';
type Cycle = 'monthly' | 'annual';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function insertItemType(db: Db, kind: Kind, name: string): number {
  const row = db.get<{ id: number }>(sql`
    insert into warranty_item_types (name, kind, is_subscription, created_at)
    values (${name}, ${kind}, ${kind === 'subscription' ? 1 : 0}, ${nowIso()})
    returning id`);
  return row.id;
}

function insertItem(
  db: Db,
  over: {
    name?: string;
    ownerUserId: number;
    typeId: number | null;
    purchaseDate: string;
    billingCycle?: Cycle | null;
    billingAmountCents?: number | null;
    // warranty_items has CHECK ((warranty_months IS NULL) = (expiry_date IS NULL)) (0002),
    // so a fixture that wants a specific expiryDate must also supply a consistent
    // warrantyMonths (expiryDate = addMonthsClamped(purchaseDate, warrantyMonths), the same
    // computation computeExpiryDate() in src/lib/warranty/expiry.ts performs at write time).
    warrantyMonths?: number | null;
    expiryDate?: string | null;
  },
): number {
  const row = db.get<{ id: number }>(sql`
    insert into warranty_items
      (name, purchase_date, warranty_months, is_lifetime, owner_user_id, type_id, billing_cycle, billing_amount_cents, expiry_date, created_at, updated_at)
    values
      (${over.name ?? 'Item'}, ${over.purchaseDate}, ${over.warrantyMonths ?? null}, 0, ${over.ownerUserId}, ${over.typeId},
       ${over.billingCycle ?? null}, ${over.billingAmountCents ?? null}, ${over.expiryDate ?? null},
       ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

function setup() {
  current = createSeededTestDb();
  const db = current.db;
  const owner = insertTestUser(db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(db, { name: 'Joint Chequing' });
  // Names avoid the built-in defaults seeded by drizzle/0003_warranty_item_types.sql and
  // 0004_item_type_kinds.sql ('Laptop', 'Appliance', 'Subscription', 'Contract', 'Loan') --
  // warranty_item_types_name_uq is COLLATE NOCASE, so any case-variant of those would collide.
  const types = {
    subscription: insertItemType(db, 'subscription', 'Streaming'),
    contract: insertItemType(db, 'contract', 'Service contract'),
    warranty: insertItemType(db, 'warranty', 'Test fridge'),
    loan: insertItemType(db, 'loan', 'Auto loan'),
  };
  const spend = (over: { categoryId: number; amountCents: number; date: string }) => {
    db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${owner}, ${nowIso()}, ${nowIso()})
      returning id`);
  };
  return {
    db,
    owner,
    joint,
    types,
    spend,
    item: (over: Omit<Parameters<typeof insertItem>[1], 'ownerUserId'>) =>
      insertItem(db, { ...over, ownerUserId: owner }),
  };
}

describe('upcomingBills — next-occurrence math', () => {
  it('computes the next monthly occurrence from a mid-month anchor, rolling past an already-passed month', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2026-01-15', billingCycle: 'monthly', billingAmountCents: 999, name: 'Streaming Co' });
    const result = upcomingBills({ today: '2026-02-20', days: 30 });
    expect(result).toEqual([{ itemId: expect.any(Number), name: 'Streaming Co', kind: 'subscription', dueDate: '2026-03-15', amountCents: 999 }]);
  });

  it('clamps a 31st anchor into February 28 in a non-leap year', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2026-01-31', billingCycle: 'monthly', billingAmountCents: 500 });
    const result = upcomingBills({ today: '2026-02-01', days: 30 });
    expect(result).toHaveLength(1);
    expect(result[0].dueDate).toBe('2026-02-28');
  });

  it('clamps a 31st anchor into February 29 in a leap year', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2028-01-31', billingCycle: 'monthly', billingAmountCents: 500 });
    const result = upcomingBills({ today: '2028-02-01', days: 30 });
    expect(result).toHaveLength(1);
    expect(result[0].dueDate).toBe('2028-02-29');
  });

  it('finds the annual anniversary later this year when it has not happened yet', () => {
    const { types, item } = setup();
    item({ typeId: types.contract, purchaseDate: '2020-06-10', billingCycle: 'annual', billingAmountCents: 120000, name: 'Home service plan' });
    const result = upcomingBills({ today: '2026-03-01', days: 110 });
    expect(result).toEqual([{ itemId: expect.any(Number), name: 'Home service plan', kind: 'contract', dueDate: '2026-06-10', amountCents: 120000 }]);
  });

  it('rolls the annual anniversary to next year once this year’s date has already passed', () => {
    const { types, item } = setup();
    item({ typeId: types.contract, purchaseDate: '2020-06-10', billingCycle: 'annual', billingAmountCents: 120000 });
    const result = upcomingBills({ today: '2026-08-01', days: 400 });
    expect(result).toHaveLength(1);
    expect(result[0].dueDate).toBe('2027-06-10');
  });

  it('does not return an occurrence that falls exactly on today (strictly after only)', () => {
    const { types, item } = setup();
    // Anchored so the naive "same day next month" occurrence lands exactly on `today`.
    item({ typeId: types.subscription, purchaseDate: '2026-01-15', billingCycle: 'monthly', billingAmountCents: 999 });
    const result = upcomingBills({ today: '2026-02-15', days: 45 });
    expect(result).toHaveLength(1);
    expect(result[0].dueDate).not.toBe('2026-02-15');
    expect(result[0].dueDate).toBe('2026-03-15');
  });
});

describe('upcomingBills — filters', () => {
  it('excludes an expired item, but includes one whose expiry date is exactly today', () => {
    const { types, item } = setup();
    // expiryDate = addMonthsClamped(purchaseDate, warrantyMonths) in both rows below, matching
    // the real computeExpiryDate() rule -- see insertItem's CHECK-constraint comment.
    item({
      typeId: types.subscription,
      purchaseDate: '2025-12-25',
      warrantyMonths: 1,
      expiryDate: '2026-01-25', // before today: expired
      billingCycle: 'monthly',
      billingAmountCents: 100,
      name: 'Expired',
    });
    item({
      typeId: types.subscription,
      purchaseDate: '2026-01-01',
      warrantyMonths: 1,
      expiryDate: '2026-02-01', // exactly today: still included
      billingCycle: 'monthly',
      billingAmountCents: 200,
      name: 'Expiring today',
    });
    const result = upcomingBills({ today: '2026-02-01', days: 30 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Expiring today');
    expect(result[0].dueDate).toBe('2026-03-01');
  });

  it('excludes items missing billingCycle or billingAmountCents', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2025-12-01', billingCycle: null, billingAmountCents: 999, name: 'No cycle' });
    item({ typeId: types.subscription, purchaseDate: '2025-12-01', billingCycle: 'monthly', billingAmountCents: null, name: 'No amount' });
    item({ typeId: types.subscription, purchaseDate: '2025-12-01', billingCycle: 'monthly', billingAmountCents: 500, name: 'Valid' });
    const result = upcomingBills({ today: '2026-01-01', days: 60 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Valid');
  });

  it('excludes warranty-kind and loan-kind items even when billing fields are set', () => {
    const { types, item } = setup();
    item({ typeId: types.warranty, purchaseDate: '2025-12-01', billingCycle: 'monthly', billingAmountCents: 999, name: 'Warranty item' });
    item({ typeId: types.loan, purchaseDate: '2025-12-01', billingCycle: 'monthly', billingAmountCents: 999, name: 'Loan item' });
    item({ typeId: types.subscription, purchaseDate: '2025-12-01', billingCycle: 'monthly', billingAmountCents: 500, name: 'Subscription item' });
    const result = upcomingBills({ today: '2026-01-01', days: 60 });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Subscription item');
  });
});

describe('upcomingBills — the days window and sorting', () => {
  it('includes an occurrence on the last day of the window and excludes one a day later', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2026-01-01', billingCycle: 'monthly', billingAmountCents: 100 });
    // Next occurrence for this fixture is 2026-02-01, which is 31 days after 2026-01-01.
    expect(upcomingBills({ today: '2026-01-01', days: 31 })).toHaveLength(1);
    expect(upcomingBills({ today: '2026-01-01', days: 30 })).toHaveLength(0);
  });

  it('sorts results by dueDate ascending', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2025-12-20', billingCycle: 'monthly', billingAmountCents: 1, name: 'Due 20th' });
    item({ typeId: types.subscription, purchaseDate: '2025-12-05', billingCycle: 'monthly', billingAmountCents: 2, name: 'Due 5th' });
    item({ typeId: types.subscription, purchaseDate: '2025-12-10', billingCycle: 'monthly', billingAmountCents: 3, name: 'Due 10th' });
    const result = upcomingBills({ today: '2026-01-01', days: 60 });
    expect(result.map((bill) => bill.name)).toEqual(['Due 5th', 'Due 10th', 'Due 20th']);
    expect(result.map((bill) => bill.dueDate)).toEqual(['2026-01-05', '2026-01-10', '2026-01-20']);
  });
});

describe('upcomingBills — clock-free', () => {
  it('returns identical results across repeated calls with the same input', () => {
    const { types, item } = setup();
    item({ typeId: types.subscription, purchaseDate: '2026-01-15', billingCycle: 'monthly', billingAmountCents: 999 });
    const input = { today: '2026-02-01', days: 30 };
    expect(upcomingBills(input)).toEqual(upcomingBills(input));
  });
});

describe('safeToSpend', () => {
  it('computes budgetedRemainingCents, a projection and billsDueCents together on one fixture', () => {
    const { db, types, item, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    // Budget lives on the top-level parent; budgetTotals only sums top-level rows
    // (children are already rolled into the parent by budgetProgress).
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 50000 });
    spend({ categoryId: groceries, amountCents: -30000, date: '2026-03-10' });
    spend({ categoryId: restaurants, amountCents: -10000, date: '2026-03-12' });
    // Total household spend this month is 40000 -> budgetedRemainingCents = 50000 - 40000.

    item({ typeId: types.subscription, purchaseDate: '2026-01-25', billingCycle: 'monthly', billingAmountCents: 1500, name: 'Streaming' });
    item({ typeId: types.contract, purchaseDate: '2020-03-28', billingCycle: 'annual', billingAmountCents: 120000, name: 'Home plan' });
    // Distractor: next occurrence 2026-04-05, after month end, must NOT be counted.
    item({ typeId: types.subscription, purchaseDate: '2026-02-05', billingCycle: 'monthly', billingAmountCents: 777, name: 'Next month' });

    const result = safeToSpend({ month: '2026-03', today: '2026-03-20' });

    expect(result.budgetedRemainingCents).toBe(10000);
    expect(result.projectedSpendCents).toBe(62000);
    expect(result.billsDueCents).toBe(121500);
  });

  it('passes through projectMonthEnd’s null before day 7, without touching the other fields', () => {
    const { db, item, types, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 50000 });
    spend({ categoryId: groceries, amountCents: -20000, date: '2026-03-02' });
    void item; // no bills in this fixture
    void types;

    const result = safeToSpend({ month: '2026-03', today: '2026-03-05' });

    expect(result.projectedSpendCents).toBeNull();
    expect(result.budgetedRemainingCents).toBe(30000);
    expect(result.billsDueCents).toBe(0);
  });

  it('returns identical results across repeated calls with the same input (clock-free)', () => {
    const { db, item, types, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 50000 });
    spend({ categoryId: groceries, amountCents: -15000, date: '2026-03-08' });
    item({ typeId: types.subscription, purchaseDate: '2026-01-25', billingCycle: 'monthly', billingAmountCents: 1500 });

    const input = { month: '2026-03', today: '2026-03-20' };
    expect(safeToSpend(input)).toEqual(safeToSpend(input));
  });
});
