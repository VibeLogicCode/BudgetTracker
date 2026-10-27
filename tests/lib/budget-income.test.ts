import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { budgetIncomeLine } from '@/lib/budget-income';
import { cashflowTrend } from '@/lib/reports';

/**
 * v1.59.0 item 13: the Budgets income line reads the Dashboard's own cashflowTrend source. Every
 * date here is explicit and `currentMonth` is passed in, so nothing depends on today.
 */
let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const db = current.db;
  const alex = insertTestUser(db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(db, { name: 'Joint Chequing', ownerUserId: alex });
  const salary = categoryIdByName(db, 'Salary');
  const groceries = categoryIdByName(db, 'Groceries');
  const add = (date: string, amountCents: number, categoryId: number, attributedUserId: number | null = null) =>
    db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${date}, 'MAPLE GROCER', 'MAPLE GROCER', ${amountCents}, ${categoryId}, 'manual', 0, ${attributedUserId}, ${alex}, ${nowIso()}, ${nowIso()})
    `);
  const household: Viewer = { id: alex, role: 'admin', visibility: 'household' };
  const samSelf: Viewer = { id: sam, role: 'member', visibility: 'self' };
  return { alex, sam, salary, groceries, add, household, samSelf };
}

describe('budgetIncomeLine: the month itself', () => {
  it("equals the Dashboard's one-month cashflowTrend call, for the household and for a person", () => {
    const { alex, salary, groceries, add, household } = setup();
    add('2026-05-01', 412300, salary, alex);
    add('2026-05-03', 98700, salary);
    add('2026-05-09', -15420, groceries, alex);
    add('2026-05-20', -6110, groceries);

    for (const attributedUserId of [null, alex]) {
      const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId, budgetedLimitCents: 0 }, household);
      const dashboard = cashflowTrend(1, { endMonth: '2026-05', attributedUserId }, household)[0];
      expect({ income: line.incomeCents, spend: line.spendCents, net: line.netCents }).toEqual({
        income: dashboard.incomeCents,
        spend: dashboard.spendCents,
        net: dashboard.netCents,
      });
    }
    const householdLine = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(householdLine.incomeCents).toBe(511000);
    expect(householdLine.spendCents).toBe(21530);
  });
});

describe('budgetIncomeLine: typical income', () => {
  it('May averages Feb-Apr, never May itself, rounded to the cent', () => {
    const { salary, add, household } = setup();
    add('2026-01-15', 900000, salary);
    add('2026-02-15', 300000, salary);
    add('2026-03-15', 330000, salary);
    add('2026-04-15', 360001, salary);
    add('2026-05-15', 777700, salary);
    const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(line.typicalMonths).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(line.typicalIncomeCents).toBe(330000);
  });

  it('a past month uses the three months before it', () => {
    const { salary, add, household } = setup();
    add('2026-01-15', 200000, salary);
    add('2026-02-15', 210000, salary);
    add('2026-03-15', 220000, salary);
    add('2026-04-15', 999900, salary);
    const line = budgetIncomeLine({ month: '2026-04', currentMonth: '2026-06', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(line.typicalMonths).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(line.typicalIncomeCents).toBe(210000);
  });

  it('a future month stops before the current one', () => {
    const { salary, add, household } = setup();
    add('2026-02-15', 300000, salary);
    add('2026-03-15', 300000, salary);
    add('2026-04-15', 300000, salary);
    add('2026-05-15', 999900, salary);
    const line = budgetIncomeLine({ month: '2026-08', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(line.typicalMonths).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(line.typicalIncomeCents).toBe(300000);
  });

  it('is null until history covers all three complete months', () => {
    const { salary, groceries, add, household } = setup();
    add('2026-03-15', 300000, salary);
    add('2026-04-02', -4500, groceries);
    add('2026-04-15', 300000, salary);
    const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(line.typicalIncomeCents).toBeNull();
    expect(line.overTypicalByCents).toBeNull();
  });

  it('is 0, not null, when the three months hold spending but no income', () => {
    const { groceries, add, household } = setup();
    add('2026-02-10', -4500, groceries);
    add('2026-03-10', -4500, groceries);
    add('2026-04-10', -4500, groceries);
    const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 50000 }, household);
    expect(line.typicalIncomeCents).toBe(0);
    expect(line.overTypicalByCents).toBeNull();
  });
});

describe('budgetIncomeLine: budgets against typical income', () => {
  function threeMonths(add: (date: string, amountCents: number, categoryId: number) => void, salary: number) {
    add('2026-02-15', 330000, salary);
    add('2026-03-15', 330000, salary);
    add('2026-04-15', 330000, salary);
  }

  it('reports how far budgets exceed typical income, and nothing when they do not', () => {
    const { salary, add, household } = setup();
    threeMonths(add, salary);
    const over = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 345000 }, household);
    expect(over.budgetedLimitCents).toBe(345000);
    expect(over.overTypicalByCents).toBe(15000);
    const equal = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 330000 }, household);
    expect(equal.overTypicalByCents).toBeNull();
    const under = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 120000 }, household);
    expect(under.overTypicalByCents).toBeNull();
  });
});

describe('budgetIncomeLine: whose money (owner decision 4)', () => {
  it("a person's line reads only what is attributed to them, never the household's income", () => {
    const { alex, sam, salary, groceries, add, household } = setup();
    for (const month of ['2026-02', '2026-03', '2026-04']) {
      add(`${month}-15`, 400000, salary, alex);
      add(`${month}-16`, -8800, groceries, sam);
    }
    const samLine = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: sam, budgetedLimitCents: 90000 }, household);
    expect(samLine.attributedUserId).toBe(sam);
    expect(samLine.typicalIncomeCents).toBe(0);
    expect(samLine.overTypicalByCents).toBeNull();
    expect(samLine.noAttributedIncome).toBe(true);

    const alexLine = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: alex, budgetedLimitCents: 0 }, household);
    expect(alexLine.typicalIncomeCents).toBe(400000);
    expect(alexLine.noAttributedIncome).toBe(false);
  });

  it('the household line never carries the no-income hint', () => {
    const { groceries, add, household } = setup();
    add('2026-02-10', -4500, groceries);
    add('2026-03-10', -4500, groceries);
    add('2026-04-10', -4500, groceries);
    const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId: null, budgetedLimitCents: 0 }, household);
    expect(line.attributedUserId).toBeNull();
    expect(line.noAttributedIncome).toBe(false);
  });

  it('a self viewer asking for another id, or for the household, gets their own figures', () => {
    const { alex, sam, salary, add, samSelf } = setup();
    add('2026-05-01', 412300, salary, alex);
    add('2026-05-02', 151500, salary, sam);
    add('2026-05-03', 98700, salary);
    for (const attributedUserId of [alex, null]) {
      const line = budgetIncomeLine({ month: '2026-05', currentMonth: '2026-05', attributedUserId, budgetedLimitCents: 0 }, samSelf);
      expect(line.attributedUserId).toBe(sam);
      expect(line.incomeCents).toBe(151500);
    }
  });
});
