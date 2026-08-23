import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { UNATTRIBUTED_LABEL } from '@/lib/reports';
import { createCategory } from '@/lib/categories';
import { taxYearCsv, taxYearReport, taxYears } from '@/lib/tax';
import { setTransactionSplits } from '@/lib/splits';
import { nowIso } from '@/lib/clock';

/**
 * Task 15a (spec 2026-08-22, v1.7.0): the tax-relevant data layer. src/lib/tax.ts is a new
 * module (split out of reports.ts per the amended Files note) so this task could run in
 * parallel with Tasks 12-14, which had reports.ts open — it imports toCsv/UNATTRIBUTED_LABEL
 * from reports.ts rather than duplicating them.
 *
 * The overlap rule under test throughout "which categories appear" below: a flagged PARENT's
 * row folds in every child's spend (flagged or not); a flagged CHILD counts alone (it has no
 * children of its own in this two-level tree); when BOTH a parent and a child are flagged, the
 * parent's row still includes the child's spend AND the child gets its own separate row — the
 * two numbers are not meant to be added together (see the "both flagged" test below for the
 * concrete arithmetic that makes a naive sum wrong).
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

  const add = (over: {
    categoryId: number | null;
    amountCents: number;
    date?: string;
    attributedUserId?: number | null;
    isTransfer?: boolean;
  }) => {
    const merchant = 'GENERIC MERCHANT';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date ?? '2026-03-10'}, ${merchant}, ${merchant}, ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };

  // Direct SQL, deliberately not routed through setCategoryTaxRelevant (src/lib/categories.ts)
  // -- these are fixtures for tax.ts's own report/aggregate logic, not a test of that setter
  // (which categories.test.ts already covers on its own).
  const flag = (categoryId: number) => {
    current!.sqlite.prepare('update categories set tax_relevant = 1 where id = ?').run(categoryId);
  };

  return { db: current.db, sqlite: current.sqlite, alice, bob, account, add, flag };
}

describe('taxYears', () => {
  it('returns an empty array when there is no data at all', () => {
    setup();
    expect(taxYears()).toEqual([]);
  });

  it('lists only years that actually have transactions, newest first', () => {
    const { db, add } = setup();
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -1000, date: '2024-06-01' });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -1000, date: '2026-01-01' });
    add({ categoryId: categoryIdByName(db, 'Groceries'), amountCents: -1000, date: '2025-12-31' });
    expect(taxYears()).toEqual([2026, 2025, 2024]);
  });

  it('a year whose only transaction is a transfer does not count', () => {
    const { add } = setup();
    add({ categoryId: null, amountCents: -1000, date: '2026-05-01', isTransfer: true });
    expect(taxYears()).toEqual([]);
  });
});

describe('taxYearReport — which categories appear', () => {
  it('only flagged categories appear', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: groceries, amountCents: -5000, date: '2026-03-01' });
    add({ categoryId: coffee, amountCents: -1000, date: '2026-03-02' });
    flag(groceries); // Coffee stays unflagged

    const rows = taxYearReport(2026);
    expect(rows.map((r) => r.categoryId)).toEqual([groceries]);
    expect(rows[0].totalCents).toBe(5000);
  });

  it('a flagged PARENT includes an unflagged child\'s spend', () => {
    const { db, add, flag } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: food, amountCents: -1000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -5000, date: '2026-03-02' });
    add({ categoryId: coffee, amountCents: -2000, date: '2026-03-03' });
    flag(food); // Groceries and Coffee are NOT flagged

    const rows = taxYearReport(2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ categoryId: food, categoryName: 'Food', totalCents: 8000 }); // 1000+5000+2000
  });

  it('a flagged CHILD whose parent is unflagged counts alone', () => {
    const { db, add, flag } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: food, amountCents: -1000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -5000, date: '2026-03-02' });
    add({ categoryId: coffee, amountCents: -2000, date: '2026-03-03' });
    flag(groceries); // Food (the parent) and Coffee stay unflagged

    const rows = taxYearReport(2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ categoryId: groceries, totalCents: 5000 }); // own spend only
  });

  it('both flagged: the parent row includes the child, and the child ALSO has its own row -- the two overlap by design and must never be summed together', () => {
    const { db, add, flag } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    add({ categoryId: food, amountCents: -1000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -5000, date: '2026-03-02' });
    add({ categoryId: coffee, amountCents: -2000, date: '2026-03-03' }); // Coffee stays unflagged
    flag(food);
    flag(groceries);

    const rows = taxYearReport(2026);
    expect(rows).toHaveLength(2); // Coffee never gets its own row -- it was never flagged
    const foodRow = rows.find((r) => r.categoryId === food)!;
    const groceriesRow = rows.find((r) => r.categoryId === groceries)!;

    // Food's row rolls up its own $10 + Groceries' $50 + Coffee's $20 (Coffee rolls up
    // structurally even though it is itself unflagged -- same rule as the "flagged parent"
    // test above).
    expect(foodRow.totalCents).toBe(8000);
    // Groceries' OWN row counts only its own $50. Adding foodRow.totalCents (80.00) to
    // groceriesRow.totalCents (50.00) gives $130, but the real total spend in this fixture is
    // only $80 (10+50+20) -- that $50 gap IS the Groceries spend counted twice. The two rows
    // are both correct answers to different questions ("what did the whole Food umbrella
    // cost" vs. "what did Groceries alone cost") and are documented here as not summable.
    expect(groceriesRow.totalCents).toBe(5000);
  });
});

describe('taxYearReport — split-aware', () => {
  it('a split transaction counts at its split categories, never at its parent lump (the regression that matters)', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    flag(groceries);
    flag(gas);

    const id = add({ categoryId: groceries, amountCents: -10000, date: '2026-03-10' });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: gas, amountCents: -3000 },
      ],
      userId: 1,
    });

    const rows = taxYearReport(2026);
    expect(rows.find((r) => r.categoryId === groceries)?.totalCents).toBe(7000);
    expect(rows.find((r) => r.categoryId === gas)?.totalCents).toBe(3000);
    // Explicit regression guard: never the parent's undivided $100 leaking through, and never
    // $100 + $70 + $30 double counted.
    const total = rows.reduce((sum, r) => sum + r.totalCents, 0);
    expect(total).toBe(10000);
  });
});

describe('taxYearReport — transfers excluded', () => {
  it('a transfer never counts, even filed under a flagged category', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flag(groceries);
    add({ categoryId: groceries, amountCents: -50000, date: '2026-03-05', isTransfer: true });
    expect(taxYearReport(2026)).toEqual([]);
  });
});

describe('taxYearReport — per-person breakdown', () => {
  it("splits by attributed person, including an unattributed bucket, and both parts of a split land on the parent's person", () => {
    const { db, alice, bob, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    flag(groceries); // gas is deliberately left unflagged

    add({ categoryId: groceries, amountCents: -4000, date: '2026-03-01', attributedUserId: alice });
    add({ categoryId: groceries, amountCents: -6000, date: '2026-03-02', attributedUserId: bob });
    add({ categoryId: groceries, amountCents: -1000, date: '2026-03-03', attributedUserId: null });

    // A split attributed to Alice, parts across TWO categories -- attribution is
    // whole-transaction (design ruling 1), so both parts land on Alice; only the Groceries
    // part shows up in this row because only Groceries is flagged.
    const id = add({ categoryId: groceries, amountCents: -2000, date: '2026-03-04', attributedUserId: alice });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -1500 },
        { categoryId: gas, amountCents: -500 },
      ],
      userId: alice,
    });

    const row = taxYearReport(2026).find((r) => r.categoryId === groceries)!;
    expect(row.totalCents).toBe(4000 + 6000 + 1000 + 1500);
    expect(row.byUser.find((u) => u.userId === alice)).toMatchObject({ label: 'Alice', cents: 4000 + 1500 });
    expect(row.byUser.find((u) => u.userId === bob)).toMatchObject({ label: 'Bob', cents: 6000 });
    expect(row.byUser.find((u) => u.userId === null)).toMatchObject({ label: UNATTRIBUTED_LABEL, cents: 1000 });
    // Exhaustive: the per-person breakdown always sums back to the row's own total.
    expect(row.byUser.reduce((sum, u) => sum + u.cents, 0)).toBe(row.totalCents);
  });

  it('always includes the unattributed bucket, even at zero', () => {
    const { db, alice, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flag(groceries);
    add({ categoryId: groceries, amountCents: -1000, date: '2026-03-01', attributedUserId: alice });
    const row = taxYearReport(2026).find((r) => r.categoryId === groceries)!;
    expect(row.byUser.find((u) => u.userId === null)).toMatchObject({ label: UNATTRIBUTED_LABEL, cents: 0 });
  });
});

describe('taxYearReport — date range, sorting and empty years', () => {
  it('excludes transactions outside the calendar year', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flag(groceries);
    add({ categoryId: groceries, amountCents: -1000, date: '2025-12-31' });
    add({ categoryId: groceries, amountCents: -2000, date: '2026-01-01' });
    add({ categoryId: groceries, amountCents: -3000, date: '2026-12-31' });
    add({ categoryId: groceries, amountCents: -4000, date: '2027-01-01' });
    const row = taxYearReport(2026).find((r) => r.categoryId === groceries)!;
    expect(row.totalCents).toBe(5000);
  });

  it('sorts rows by totalCents, highest first', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    flag(groceries);
    flag(gas);
    add({ categoryId: gas, amountCents: -1000, date: '2026-03-01' });
    add({ categoryId: groceries, amountCents: -9000, date: '2026-03-02' });
    expect(taxYearReport(2026).map((r) => r.categoryId)).toEqual([groceries, gas]);
  });

  it('a year with no data returns an empty array, even when categories are flagged and other years have data', () => {
    const { db, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flag(groceries);
    add({ categoryId: groceries, amountCents: -1000, date: '2026-03-01' });
    expect(taxYearReport(2020)).toEqual([]);
  });
});

describe('taxYearCsv', () => {
  it('exact expected rows for a simple fixture: header, Category, Person, Amount', () => {
    const { db, alice, add, flag } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    flag(groceries);
    add({ categoryId: groceries, amountCents: -4000, date: '2026-03-01', attributedUserId: alice });

    const csv = taxYearCsv(2026);
    expect(csv).toBe(
      'Category,Person,Amount\r\n' +
        `Groceries,Alice,40.00\r\n` +
        `Groceries,${UNATTRIBUTED_LABEL},0.00\r\n`,
    );
  });

  it('neutralises a category name beginning with = using the inherited formula-injection guard', () => {
    const { add, flag } = setup();
    const evilId = createCategory({ name: '=EVIL()', parentId: null });
    flag(evilId);
    add({ categoryId: evilId, amountCents: -1000, date: '2026-03-01' });

    const csv = taxYearCsv(2026);
    const lines = csv.trim().split('\r\n');
    const row = lines.find((line) => line.includes('10.00'))!;
    expect(row).toContain(`'=EVIL()`);
    expect(row).not.toContain(`,=EVIL()`);
  });
});
