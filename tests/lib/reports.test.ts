import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import {
  UNATTRIBUTED_LABEL,
  cashflowTrend,
  categoryBreakdown,
  categoryMonthOverMonth,
  personSpendSplit,
  savingsRate,
  toCsv,
  topMerchants,
  transactionsCsv,
  type MonthTrendRow,
} from '@/lib/reports';
import { nowIso } from '@/lib/clock';
import { assignTransactionToLoan } from '@/lib/loans';
import { setTransactionSplits } from '@/lib/splits';

// v1.13.0 ruling R2: every aggregate under test here now takes a viewer as its last argument.
// A household viewer's ownerScope() is always null, so passing this constant reproduces the
// pre-v1.13.0 unscoped behaviour every one of these pre-existing tests already assumes.
const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

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

  const add = (over: {
    categoryId: number | null;
    amountCents: number;
    date?: string;
    attributedUserId?: number | null;
    isTransfer?: boolean;
    merchant?: string;
  }) => {
    const merchant = over.merchant ?? 'TIM HORTONS';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date ?? '2026-03-10'}, ${merchant}, ${merchant}, ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, account, add };
}

/**
 * A loan-kind warranty_items row (item 8a fixture). `loan_direction` is spelled out explicitly on
 * every insert -- unlike some other loan fixtures in this repo that omit it to prove the column
 * DEFAULT -- because these tests exist specifically to tell 'owed' and 'lent' apart.
 */
function seedLoanItem(ownerUserId: number, direction: 'owed' | 'lent'): number {
  const now = nowIso();
  const typeId = current!.db.get<{ id: number }>(sql`
    insert into warranty_item_types (name, is_subscription, kind, created_at)
    values (${`Loan type ${Math.random().toString(36).slice(2, 8)}`}, 0, 'loan', ${now})
    returning id`).id;
  return current!.db.get<{ id: number }>(sql`
    insert into warranty_items
      (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, current_balance_cents, balance_updated_at, created_at, updated_at)
    values (${'Test loan'}, '2026-01-01', 0, ${ownerUserId}, ${typeId}, ${direction}, ${5_000_000}, ${now}, ${now}, ${now})
    returning id`).id;
}

const MARCH = { from: '2026-03-01', to: '2026-03-31' };

describe('categoryBreakdown', () => {
  it('nets refunds and excludes transfers', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -12000 });
    add({ categoryId: groceries, amountCents: 2000 });
    add({ categoryId: groceries, amountCents: -99999, isTransfer: true });

    const rows = categoryBreakdown(MARCH, HOUSEHOLD);
    expect(rows.find((r) => r.categoryId === groceries)?.spentCents).toBe(10000);
  });

  it('includes an Uncategorized bucket with a null id', () => {
    const { add } = setup();
    add({ categoryId: null, amountCents: -4000 });
    const rows = categoryBreakdown(MARCH, HOUSEHOLD);
    expect(rows.find((r) => r.categoryId === null)).toMatchObject({ categoryName: 'Uncategorized', spentCents: 4000 });
  });

  it('excludes income categories by default and can include them', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: salary, amountCents: 500000 });
    add({ categoryId: groceries, amountCents: -12000 });

    expect(categoryBreakdown(MARCH, HOUSEHOLD).some((r) => r.categoryId === salary)).toBe(false);
    const withIncome = categoryBreakdown({ ...MARCH, includeIncome: true }, HOUSEHOLD);
    expect(withIncome.find((r) => r.categoryId === salary)?.spentCents).toBe(-500000);
  });

  it('rolls children into their parent when asked', () => {
    const { db, add } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: food, amountCents: -1000 });
    add({ categoryId: groceries, amountCents: -20000 });
    add({ categoryId: coffee, amountCents: -3000 });

    const flat = categoryBreakdown(MARCH, HOUSEHOLD);
    expect(flat.find((r) => r.categoryId === food)?.spentCents).toBe(1000);

    const rolled = categoryBreakdown({ ...MARCH, rollup: true }, HOUSEHOLD);
    expect(rolled.find((r) => r.categoryId === food)?.spentCents).toBe(24000);
    expect(rolled.some((r) => r.categoryId === groceries)).toBe(false);
  });

  it('respects the date range and the person filter', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -1000, date: '2026-02-28' });
    add({ categoryId: groceries, amountCents: -2000, date: '2026-03-01', attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -3000, date: '2026-03-31', attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -4000, date: '2026-04-01' });

    expect(categoryBreakdown(MARCH, HOUSEHOLD).find((r) => r.categoryId === groceries)?.spentCents).toBe(5000);
    expect(categoryBreakdown({ ...MARCH, attributedUserId: alice }, HOUSEHOLD).find((r) => r.categoryId === groceries)?.spentCents).toBe(2000);
  });

  it('sorts by spend, highest first', () => {
    const { db, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Coffee'), amountCents: -1000 });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -9000 });
    const rows = categoryBreakdown(MARCH, HOUSEHOLD);
    expect(rows[0].categoryName).toBe('Groceries');
  });
});

describe('cashflowTrend', () => {
  it('separates income from spend and excludes transfers', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: salary, amountCents: 500000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -120000, date: '2026-03-05' });
    add({ categoryId: null, amountCents: -30000, date: '2026-03-06' });
    add({ categoryId: null, amountCents: -900000, date: '2026-03-07', isTransfer: true });

    const trend = cashflowTrend(3, { endMonth: '2026-03' }, HOUSEHOLD);
    expect(trend.map((r) => r.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    const march = trend[2];
    expect(march.incomeCents).toBe(500000);
    expect(march.spendCents).toBe(150000);
    expect(march.netCents).toBe(350000);
  });

  it('never lets a refund inflate income', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: 5000, date: '2026-03-05' });
    const march = cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0];
    expect(march.incomeCents).toBe(0);
    expect(march.spendCents).toBe(-5000);
  });

  it('emits zero-filled months with no activity', () => {
    setup();
    const trend = cashflowTrend(12, { endMonth: '2026-03' }, HOUSEHOLD);
    expect(trend).toHaveLength(12);
    expect(trend[0].month).toBe('2025-04');
    expect(trend.every((r) => r.incomeCents === 0 && r.spendCents === 0)).toBe(true);
  });

  it('can scope to one person', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, date: '2026-03-05', attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -20000, date: '2026-03-06', attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -30000, date: '2026-03-07', attributedUserId: null });

    expect(cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0].spendCents).toBe(60000);
    expect(cashflowTrend(1, { endMonth: '2026-03', attributedUserId: alice }, HOUSEHOLD)[0].spendCents).toBe(10000);
    expect(cashflowTrend(1, { endMonth: '2026-03', attributedUserId: 'unattributed' }, HOUSEHOLD)[0].spendCents).toBe(30000);
  });
});

describe('categoryMonthOverMonth', () => {
  it('returns one row per category with a value for every month in the range', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: groceries, amountCents: -10000, date: '2026-01-05' });
    add({ categoryId: groceries, amountCents: -12000, date: '2026-02-05' });
    add({ categoryId: coffee, amountCents: -2000, date: '2026-02-05' });

    const result = categoryMonthOverMonth({ fromMonth: '2026-01', toMonth: '2026-03' }, HOUSEHOLD);
    expect(result.months).toEqual(['2026-01', '2026-02', '2026-03']);
    const groceriesRow = result.rows.find((r) => r.categoryId === groceries)!;
    expect(groceriesRow.byMonth).toEqual({ '2026-01': 10000, '2026-02': 12000, '2026-03': 0 });
    expect(groceriesRow.totalCents).toBe(22000);
    expect(result.rows[0].categoryId).toBe(groceries); // biggest total first
    expect(result.rows.find((r) => r.categoryId === coffee)?.byMonth['2026-01']).toBe(0);
  });

  it('honours the limit', () => {
    const { db, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, date: '2026-01-05' });
    add({ categoryId: categoryIdByName(db, 'Coffee'), amountCents: -2000, date: '2026-01-05' });
    add({ categoryId: categoryIdByName(db, 'Gas'), amountCents: -5000, date: '2026-01-05' });
    expect(categoryMonthOverMonth({ fromMonth: '2026-01', toMonth: '2026-01', limit: 2 }, HOUSEHOLD).rows).toHaveLength(2);
  });

  it('stays continuous across a year boundary', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -5000, date: '2025-11-15' });
    add({ categoryId: groceries, amountCents: -6000, date: '2025-12-20' });
    add({ categoryId: groceries, amountCents: -7000, date: '2026-01-05' });
    add({ categoryId: groceries, amountCents: -8000, date: '2026-02-01' });

    const result = categoryMonthOverMonth({ fromMonth: '2025-11', toMonth: '2026-02' }, HOUSEHOLD);
    expect(result.months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    const row = result.rows.find((r) => r.categoryId === groceries)!;
    expect(row.byMonth).toEqual({ '2025-11': 5000, '2025-12': 6000, '2026-01': 7000, '2026-02': 8000 });
    expect(row.totalCents).toBe(26000);
  });
});

describe('personSpendSplit', () => {
  it('buckets by attribution and gives unattributed spend its own bucket', () => {
    const { db, alice, bob, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -20000, attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -30000, attributedUserId: null });
    add({ categoryId: null, amountCents: -5000, attributedUserId: null });

    const split = personSpendSplit(MARCH, HOUSEHOLD);
    expect(UNATTRIBUTED_LABEL).toBe('Household/unattributed');
    expect(split.find((r) => r.userId === alice)).toMatchObject({ label: 'Alice', spentCents: 10000 });
    expect(split.find((r) => r.userId === bob)).toMatchObject({ label: 'Bob', spentCents: 20000 });
    expect(split.find((r) => r.userId === null)).toMatchObject({ label: UNATTRIBUTED_LABEL, spentCents: 35000 });
  });

  it('always includes the unattributed bucket, even at zero', () => {
    const { db, alice, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -10000, attributedUserId: alice });
    expect(personSpendSplit(MARCH, HOUSEHOLD).find((r) => r.userId === null)).toMatchObject({ spentCents: 0 });
  });

  it('excludes income and transfers', () => {
    const { db, alice, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Salary'), amountCents: 500000, attributedUserId: alice });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -900000, attributedUserId: alice, isTransfer: true });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -1000, attributedUserId: alice });
    expect(personSpendSplit(MARCH, HOUSEHOLD).find((r) => r.userId === alice)?.spentCents).toBe(1000);
  });

  it('always returns the unattributed bucket, even at zero (item A, ruling P2)', () => {
    // Deliberate: a bucket that disappears at zero hides the difference between "nobody
    // unattributed" and "we stopped counting". reports-client.tsx's empty state is gated on every
    // row being zero BECAUSE of this, not the other way round.
    setup();
    const rows = personSpendSplit({ from: '2099-01-01', to: '2099-01-31' }, HOUSEHOLD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 });
  });
});

describe('topMerchants', () => {
  it('ranks merchants by net spend with a transaction count', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -10000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: -12000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: 2000, merchant: 'LOBLAWS' });
    add({ categoryId: groceries, amountCents: -5000, merchant: 'METRO' });

    const rows = topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD);
    expect(rows[0]).toMatchObject({ normalizedMerchant: 'LOBLAWS', spentCents: 20000, count: 3 });
    expect(rows[1]).toMatchObject({ normalizedMerchant: 'METRO', spentCents: 5000, count: 1 });
  });

  it('drops merchants whose net is zero or negative and honours the limit', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: 3000, merchant: 'REFUND ONLY' });
    add({ categoryId: groceries, amountCents: -1000, merchant: 'A' });
    add({ categoryId: groceries, amountCents: -2000, merchant: 'B' });
    const rows = topMerchants({ ...MARCH, limit: 1 }, HOUSEHOLD);
    expect(rows).toHaveLength(1);
    expect(rows[0].normalizedMerchant).toBe('B');
  });
});

describe('topMerchants — split-aware income filter and sum (v1.7.0 review fix)', () => {
  // DEFECT regression (adversarial review, 2026-08-22): topMerchants joined `categories` on
  // the PARENT's own transactions.categoryId and summed transactions.amountCents directly --
  // neither is split-aware. A split never updates the parent's own category_id (splits.ts
  // ruling 1/2), so a charge filed under an income category and then corrected by a split
  // had its whole amount silently excluded forever, and even a same-category split's income
  // parts (if any) were never separated from its expense parts. The fix keeps grouping by
  // merchant (identity does not change) but joins categories on EFFECTIVE_CATEGORY and sums
  // EFFECTIVE_AMOUNT, so each split PART decides its own inclusion.

  it('a charge filed under an income category before splitting is no longer dropped -- it appears with the summed EXPENSE total', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary'); // isIncome = true
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    // Filed (wrongly, before splitting) under Salary -- exactly the mistake splitting exists
    // to correct. The parent's own category_id never changes once split, so a reader keying
    // its income test off transactions.categoryId sees "Salary" forever.
    const id = add({ categoryId: salary, amountCents: -10000, merchant: 'COSTCO' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -6000 },
        { categoryId: gas, amountCents: -4000 },
      ],
      userId: 1,
    });

    const rows = topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD);
    const costco = rows.find((r) => r.normalizedMerchant === 'COSTCO');
    expect(costco).toBeDefined();
    expect(costco).toMatchObject({ spentCents: 10000, count: 1 });
  });

  it('a 3-part split reports a count of 1 charge at that merchant, never 3 (the join-multiplies-rows trap)', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add({ categoryId: groceries, amountCents: -9000, merchant: 'COSTCO' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -5000 },
        { categoryId: coffee, amountCents: -3000 },
        { categoryId: restaurants, amountCents: -1000 },
      ],
      userId: 1,
    });

    const rows = topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD);
    const costco = rows.find((r) => r.normalizedMerchant === 'COSTCO')!;
    expect(costco.count).toBe(1);
    expect(costco.spentCents).toBe(9000);
  });

  it('a split with one income part and two expense parts counts only the expense total', () => {
    const { db, add } = setup();
    const salary = categoryIdByName(db, 'Salary');
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = add({ categoryId: groceries, amountCents: -10000, merchant: 'COSTCO' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: salary, amountCents: -2000 },
        { categoryId: groceries, amountCents: -5000 },
        { categoryId: gas, amountCents: -3000 },
      ],
      userId: 1,
    });

    const rows = topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD);
    const costco = rows.find((r) => r.normalizedMerchant === 'COSTCO')!;
    // Only the two expense parts ($50 + $30) -- the $20 income part is excluded WITHOUT
    // taking the expense parts down with it.
    expect(costco.spentCents).toBe(8000);
    expect(costco.count).toBe(1);
  });

  it("an unsplit transaction's row is unchanged, including its count", () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -4500, merchant: 'METRO' });

    const rows = topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD);
    expect(rows.find((r) => r.normalizedMerchant === 'METRO')).toMatchObject({ spentCents: 4500, count: 1 });
  });

  it('still groups by merchant, not by merchant+category -- a split across categories stays ONE row', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ categoryId: groceries, amountCents: -8000, merchant: 'COSTCO' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -5000 },
        { categoryId: coffee, amountCents: -3000 },
      ],
      userId: 1,
    });

    const rows = topMerchants({ ...MARCH, limit: 10 }, HOUSEHOLD);
    expect(rows.filter((r) => r.normalizedMerchant === 'COSTCO')).toHaveLength(1);
  });
});

describe('savingsRate (v1.7.0 Task 14)', () => {
  it('sums income, spend and net across the rows and rounds net/income to a whole percent', () => {
    const rows: MonthTrendRow[] = [
      { month: '2026-01', incomeCents: 500000, spendCents: 300000, netCents: 200000 },
      { month: '2026-02', incomeCents: 500000, spendCents: 450000, netCents: 50000 },
    ];
    expect(savingsRate(rows)).toEqual({ incomeCents: 1000000, spendCents: 750000, netCents: 250000, pct: 25 });
  });

  it('rounds to the nearest whole percent rather than truncating', () => {
    // 100000 / 300000 = 33.33...%, must round to 33, not truncate to 33 by luck of the draw --
    // covered separately below with a case that would fail under truncation vs rounding.
    const rows: MonthTrendRow[] = [{ month: '2026-01', incomeCents: 300000, spendCents: 200000, netCents: 100000 }];
    expect(savingsRate(rows).pct).toBe(33);
  });

  it('a negative net (spent more than earned) reports a negative percentage, never clamped to zero', () => {
    const rows: MonthTrendRow[] = [{ month: '2026-01', incomeCents: 100000, spendCents: 150000, netCents: -50000 }];
    expect(savingsRate(rows).pct).toBe(-50);
  });

  it('is null, never a division-by-zero artifact, when there is no income', () => {
    const rows: MonthTrendRow[] = [{ month: '2026-01', incomeCents: 0, spendCents: 20000, netCents: -20000 }];
    const rate = savingsRate(rows);
    expect(rate.pct).toBeNull();
    expect(rate.incomeCents).toBe(0);
    expect(rate.spendCents).toBe(20000);
    expect(rate.netCents).toBe(-20000);
  });

  it('is null when income sums negative too, not just at exactly zero', () => {
    const rows: MonthTrendRow[] = [{ month: '2026-01', incomeCents: -5000, spendCents: 1000, netCents: -6000 }];
    expect(savingsRate(rows).pct).toBeNull();
  });

  it('an empty series is all zeros with no income to divide by', () => {
    expect(savingsRate([])).toEqual({ incomeCents: 0, spendCents: 0, netCents: 0, pct: null });
  });
});

describe('csv export', () => {
  it('quotes commas, quotes and newlines per RFC 4180', () => {
    const csv = toCsv(
      [
        { a: 'plain', b: 'has,comma' },
        { a: 'has"quote', b: 'has\nnewline' },
      ],
      [
        { key: 'a', header: 'Column A' },
        { key: 'b', header: 'Column B' },
      ],
    );
    expect(csv).toBe('Column A,Column B\r\nplain,"has,comma"\r\n"has""quote","has\nnewline"\r\n');
  });

  it('renders null and undefined as empty cells', () => {
    const csv = toCsv([{ a: null, b: undefined, c: 0 }], [
      { key: 'a', header: 'A' },
      { key: 'b', header: 'B' },
      { key: 'c', header: 'C' },
    ]);
    expect(csv).toBe('A,B,C\r\n,,0\r\n');
  });

  it('quotes a single field containing a comma, a quote and a newline all at once', () => {
    const csv = toCsv(
      [{ a: 'safe', b: 'weird, "quoted"\nvalue' }],
      [
        { key: 'a', header: 'A' },
        { key: 'b', header: 'B' },
      ],
    );
    expect(csv).toBe('A,B\r\nsafe,"weird, ""quoted""\nvalue"\r\n');
  });

  it('neutralises spreadsheet formula triggers with a leading apostrophe', () => {
    const csv = toCsv(
      [
        { v: '=SUM(1)' },
        { v: '+1+1' },
        { v: '-cmd|calc' },
        { v: '@import' },
        { v: '\tleading tab' },
      ],
      [{ key: 'v', header: 'V' }],
    );
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toBe(`'=SUM(1)`);
    expect(lines[2]).toBe(`'+1+1`);
    expect(lines[3]).toBe(`'-cmd|calc`);
    expect(lines[4]).toBe(`'@import`);
    expect(lines[5]).toBe(`'\tleading tab`);
  });

  it('keeps RFC quoting on top of the guard when the field also needs quoting', () => {
    const csv = toCsv([{ v: '=SUM(1,2)' }], [{ key: 'v', header: 'V' }]);
    expect(csv.trim().split('\r\n')[1]).toBe(`"'=SUM(1,2)"`);
  });

  it('leaves plain negative numbers alone so the Amount column still sums', () => {
    const csv = toCsv([{ v: '-45.00' }, { v: '+3' }, { v: '-1.5e3' }], [{ key: 'v', header: 'V' }]);
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toBe('-45.00');
    expect(lines[2]).toBe('+3');
    expect(lines[3]).toBe('-1.5e3');
  });

  it('guards a formula smuggled into a transaction note, and still exports a negative amount as a number', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add({ categoryId: groceries, amountCents: -4500, merchant: 'LOBLAWS', date: '2026-03-05' });
    db.run(sql`update transactions set notes = ${'=SUM(1)'} where id = ${id}`);

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' }, HOUSEHOLD);
    const row = csv.trim().split('\r\n')[1];
    expect(row).toContain(`'=SUM(1)`);
    expect(row).not.toContain(',=SUM(1)');
    expect(row).toContain('-45.00');
    expect(row).not.toContain(`'-45.00`);
  });

  it('exports the filtered transactions view with readable columns', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -12345, attributedUserId: alice, merchant: 'LOBLAWS', date: '2026-03-05' });
    add({ categoryId: null, amountCents: -500, merchant: 'UNKNOWN SHOP', date: '2026-03-06' });

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' }, HOUSEHOLD);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Date,Account,Description,Merchant,Amount,Category,Person,Transfer,Source,Notes');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-03-06');
    expect(lines[1]).toContain('-5.00');
    expect(lines[1]).toContain('Uncategorized');
    expect(lines[2]).toContain('Alice');
    expect(lines[2]).toContain('-123.45');
  });
});

describe('transactionsCsv — splits (v1.7.0 Task 4)', () => {
  it('an unsplit row stays byte-identical to the pre-split format', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    add({ categoryId: groceries, amountCents: -12345, attributedUserId: alice, merchant: 'LOBLAWS', date: '2026-03-05' });

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' }, HOUSEHOLD);
    expect(csv).toBe(
      'Date,Account,Description,Merchant,Amount,Category,Person,Transfer,Source,Notes\r\n' +
        '2026-03-05,Joint Chequing,LOBLAWS,LOBLAWS,-123.45,Food > Groceries,Alice,no,manual,\r\n',
    );
  });

  it('a 3-part split emits one row per part, each with its own amount, category and a description suffix', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const gas = categoryIdByName(db, 'Gas');
    const id = add({ categoryId: groceries, amountCents: -10000, merchant: 'COSTCO', date: '2026-03-05' });
    setTransactionSplits({
      txnId: id,
      userId: 1,
      parts: [
        { categoryId: groceries, amountCents: -5000 },
        { categoryId: coffee, amountCents: -3000, note: 'birthday cake' },
        { categoryId: gas, amountCents: -2000 },
      ],
    });

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' }, HOUSEHOLD);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4); // header + 3 parts, never the parent's own lump row
    expect(lines[1]).toBe(
      '2026-03-05,Joint Chequing,COSTCO (split 1/3),COSTCO,-50.00,Food > Groceries,Household/unattributed,no,manual,',
    );
    expect(lines[2]).toBe(
      '2026-03-05,Joint Chequing,COSTCO (split 2/3),COSTCO,-30.00,Food > Coffee,Household/unattributed,no,manual,birthday cake',
    );
    expect(lines[3]).toBe(
      '2026-03-05,Joint Chequing,COSTCO (split 3/3),COSTCO,-20.00,Transport > Gas,Household/unattributed,no,manual,',
    );
  });

  it('neutralises a formula-triggering leading = in a split part note, same as any other note', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add({ categoryId: groceries, amountCents: -10000, merchant: 'COSTCO', date: '2026-03-05' });
    setTransactionSplits({
      txnId: id,
      userId: 1,
      parts: [
        { categoryId: groceries, amountCents: -6000, note: '=SUM(1)' },
        { categoryId: coffee, amountCents: -4000 },
      ],
    });

    const csv = transactionsCsv({ from: '2026-03-01', to: '2026-03-31' }, HOUSEHOLD);
    const lines = csv.trim().split('\r\n');
    expect(lines[1]).toContain(`'=SUM(1)`);
    expect(lines[1]).not.toContain(',=SUM(1)');
    // The guard didn't accidentally eat the rest of the row.
    expect(lines[1]).toContain('-60.00');
  });
});

describe('loan principal movements are excluded from spend/income (item 8a, 2026-08-30 plan)', () => {
  it('lending money out is excluded from spend entirely -- not counted, not netted as a refund', () => {
    const { alice, add } = setup();
    const loanId = seedLoanItem(alice, 'lent');
    const txnId = add({ categoryId: null, amountCents: -600_000, merchant: 'E TRANSFER', date: '2026-03-10' });
    assignTransactionToLoan({ txnId, itemId: loanId });

    expect(cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0]).toMatchObject({
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
    });
    expect(categoryBreakdown(MARCH, HOUSEHOLD)).toEqual([]);
    expect(topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD)).toEqual([]);
  });

  it('being repaid on a lent loan is excluded -- not income, and not a phantom refund that shrinks real spend', () => {
    const { db, alice, add } = setup();
    const loanId = seedLoanItem(alice, 'lent');
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -5000, date: '2026-03-05' });
    const repaymentTxnId = add({ categoryId: null, amountCents: 600_000, merchant: 'E TRANSFER', date: '2026-03-11' });
    assignTransactionToLoan({ txnId: repaymentTxnId, itemId: loanId });

    // Before item 8a this repayment's positive amount netted straight into the same aggregate as
    // the $50.00 grocery spend, so the month would have reported net spend of -$5,950.00 -- a
    // fake refund vastly larger than anything the household actually bought.
    const march = cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0];
    expect(march.spendCents).toBe(5000);
    expect(march.incomeCents).toBe(0);
  });

  it('borrowing on an owed loan is excluded from spend/income the same way', () => {
    const { alice, add } = setup();
    const loanId = seedLoanItem(alice, 'owed');
    const txnId = add({ categoryId: null, amountCents: 600_000, merchant: 'BANK LOAN', date: '2026-03-10' });
    assignTransactionToLoan({ txnId, itemId: loanId });

    expect(cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0]).toMatchObject({
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
    });
  });

  it('repaying a loan you OWE stays counted as spend -- MUST-13.2, unaffected by item 8a', () => {
    const { db, alice, add } = setup();
    const loanId = seedLoanItem(alice, 'owed');
    const groceries = categoryIdByName(db, 'Groceries');
    const txnId = add({ categoryId: groceries, amountCents: -50_000, merchant: 'CAR LOAN CO', date: '2026-03-10' });
    assignTransactionToLoan({ txnId, itemId: loanId });

    expect(cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0].spendCents).toBe(50_000);
    expect(categoryBreakdown(MARCH, HOUSEHOLD).find((r) => r.categoryId === groceries)?.spentCents).toBe(50_000);
    expect(topMerchants({ ...MARCH, limit: 5 }, HOUSEHOLD).find((r) => r.normalizedMerchant === 'CAR LOAN CO')).toMatchObject({
      spentCents: 50_000,
    });
  });

  it('MUST-11.16 tie-break: a transaction funding two loans stays counted the moment ANY link is an owed repayment', () => {
    const { alice, add } = setup();
    const owedLoanId = seedLoanItem(alice, 'owed');
    const lentLoanId = seedLoanItem(alice, 'lent');
    const txnId = add({ categoryId: null, amountCents: -50_000, merchant: 'COMBINED PAYMENT', date: '2026-03-10' });
    assignTransactionToLoan({ txnId, itemId: owedLoanId });
    assignTransactionToLoan({ txnId, itemId: lentLoanId });

    expect(cashflowTrend(1, { endMonth: '2026-03' }, HOUSEHOLD)[0].spendCents).toBe(50_000);
  });
});
