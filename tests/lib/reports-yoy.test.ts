import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { categoryYearOverYear } from '@/lib/reports';
import { setTransactionSplits } from '@/lib/splits';
import { nowIso } from '@/lib/clock';

// v1.13.0 ruling R2 (Task 6 fix round 1): categoryYearOverYear now takes a viewer as its last
// argument. A household viewer's ownerScope() is always null, so passing this constant at every
// call site below reproduces the pre-v1.13.0 unscoped behaviour every test here already assumes.
const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

/**
 * Task 13 (spec 2026-08-22, v1.7.0): categoryYearOverYear compares one month against the month
 * before it and the same month a year earlier, in ONE grouped query rather than three separate
 * calls. The three month keys are not contiguous -- last year sits 11 months before last month
 * -- so the query spans the full range from the earliest to the latest of the three (the same
 * shape categoryMonthOverMonth already uses for a contiguous window) and keeps only the three
 * month buckets that matter; every fixture below plants "noise" transactions in the months
 * between last year and last month specifically to prove those extra buckets never leak in.
 *
 * Split-aware via the same LEFT JOIN transaction_splits / EFFECTIVE_CATEGORY / EFFECTIVE_AMOUNT
 * pattern Task 3 applied to categoryBreakdown/cashflowTrend/categoryMonthOverMonth/personSpendSplit
 * (src/lib/splits.ts) -- see the dedicated split test below.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const account = insertTestAccount(current.db, { name: 'Joint Chequing' });

  const add = (over: { categoryId: number | null; amountCents: number; date: string; attributedUserId?: number | null }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date}, 'GENERIC MERCHANT', 'GENERIC MERCHANT', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, alice, bob, account, add };
}

// A 13+ month spread: last year is exactly 12 months before this month, with several
// "noise" months in between that must never contribute to any of the three buckets.
const THIS_MONTH = '2026-03';
const LAST_MONTH = '2026-02';
const LAST_YEAR = '2025-03';

describe('categoryYearOverYear', () => {
  it('reports the three month figures per category from one call, ignoring the months in between', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');

    add({ categoryId: groceries, amountCents: -10000, date: `${THIS_MONTH}-05` });
    add({ categoryId: groceries, amountCents: -8000, date: `${LAST_MONTH}-05` });
    add({ categoryId: groceries, amountCents: -6000, date: `${LAST_YEAR}-05` });
    // Noise: inside the 13-month span the query scans, but not one of the three keys.
    add({ categoryId: groceries, amountCents: -99999, date: '2025-06-10' });
    add({ categoryId: groceries, amountCents: -99999, date: '2025-10-10' });
    add({ categoryId: groceries, amountCents: -99999, date: '2026-01-10' });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    const food = rows.find((r) => r.categoryName === 'Food')!;
    expect(food).toMatchObject({ thisMonthCents: 10000, lastMonthCents: 8000, lastYearCents: 6000 });
  });

  it('rolls children into their parent, folding each part into its own parent (categoryBreakdown rollup rule)', () => {
    const { db, add } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    add({ categoryId: food, amountCents: -500, date: `${THIS_MONTH}-01` });
    add({ categoryId: groceries, amountCents: -10000, date: `${THIS_MONTH}-05` });
    add({ categoryId: coffee, amountCents: -1500, date: `${THIS_MONTH}-06` });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(rows.find((r) => r.categoryId === food)?.thisMonthCents).toBe(12000);
    expect(rows.some((r) => r.categoryId === groceries)).toBe(false);
    expect(rows.some((r) => r.categoryId === coffee)).toBe(false);
  });

  it('excludes income categories entirely', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    add({ categoryId: salary, amountCents: 500000, date: `${THIS_MONTH}-01` });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(rows.some((r) => r.categoryName === 'Income' || r.categoryId === salary)).toBe(false);
  });

  it('respects the person filter, including the unattributed bucket', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, date: `${THIS_MONTH}-05`, attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -20000, date: `${THIS_MONTH}-06`, attributedUserId: bob });

    const all = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(all.find((r) => r.categoryName === 'Food')?.thisMonthCents).toBe(30000);

    const aliceOnly = categoryYearOverYear({ month: THIS_MONTH, attributedUserId: alice }, HOUSEHOLD);
    expect(aliceOnly.find((r) => r.categoryName === 'Food')?.thisMonthCents).toBe(10000);

    const unattributedOnly = categoryYearOverYear({ month: THIS_MONTH, attributedUserId: 'unattributed' }, HOUSEHOLD);
    expect(unattributedOnly.some((r) => r.categoryName === 'Food')).toBe(false);
  });

  it('drops a category whose three figures are all zero, but keeps one with spend in only one of the three months', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const kids = categoryIdByName(db, 'Kids');
    add({ categoryId: groceries, amountCents: -10000, date: `${THIS_MONTH}-05` });
    // Entirely outside all three windows -- nets to zero in every bucket and must be dropped.
    add({ categoryId: kids, amountCents: -5000, date: '2025-08-01' });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(rows.find((r) => r.categoryName === 'Food')).toMatchObject({
      thisMonthCents: 10000,
      lastMonthCents: 0,
      lastYearCents: 0,
    });
    expect(rows.some((r) => r.categoryId === kids)).toBe(false);
  });

  it('sorts rows by thisMonthCents descending', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    add({ categoryId: gas, amountCents: -2000, date: `${THIS_MONTH}-05` });
    add({ categoryId: groceries, amountCents: -9000, date: `${THIS_MONTH}-06` });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(rows[0].categoryName).toBe('Food');
    expect(rows[1].categoryName).toBe('Transport');
  });

  it('counts a split transaction at its split categories, never at the parent lump (the regression Task 3 exists to prevent)', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const food = categoryIdByName(db, 'Food');
    const transport = categoryIdByName(db, 'Transport');

    // $100 filed at Groceries before the split (a split never touches the parent's own
    // category_id -- ruling 1/2), then divided $70 groceries + $30 gas.
    const id = add({ categoryId: groceries, amountCents: -10000, date: `${THIS_MONTH}-10`, attributedUserId: alice });
    setTransactionSplits({
      txnId: id,
      userId: alice,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: gas, amountCents: -3000 },
      ],
    });

    const rows = categoryYearOverYear({ month: THIS_MONTH }, HOUSEHOLD);
    expect(rows.find((r) => r.categoryId === food)?.thisMonthCents).toBe(7000);
    expect(rows.find((r) => r.categoryId === transport)?.thisMonthCents).toBe(3000);
    // Never the parent's own undivided $100 counted whole anywhere, and never $100+$70+$30.
    expect(rows.some((r) => r.thisMonthCents === 10000)).toBe(false);
    const total = rows.reduce((sum, r) => sum + r.thisMonthCents, 0);
    expect(total).toBe(10000);
  });
});
