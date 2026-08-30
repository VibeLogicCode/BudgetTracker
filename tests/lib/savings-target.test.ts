import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import {
  copySavingsTargetForward,
  deleteSavingsTarget,
  getSavingsTarget,
  saveSavingsTarget,
  savingsProgress,
  savingsStreak,
} from '@/lib/savings-target';

const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * Seeds a household with a chequing and a savings account, and returns a `txn` helper that
 * inserts one transaction row -- same minimal shape as tests/lib/budgets.test.ts's own `spend`
 * helper, extended with `accountId` and `isTransfer` since ruling T1's three cases turn on
 * exactly those two fields.
 */
function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const chequing = insertTestAccount(current.db, { name: 'Joint Chequing', type: 'chequing' });
  const savingsAccount = insertTestAccount(current.db, { name: 'Joint Savings', type: 'savings' });
  const salary = categoryIdByName(current.db, 'Salary');
  const groceries = categoryIdByName(current.db, 'Groceries');

  const txn = (over: {
    accountId: number;
    amountCents: number;
    categoryId: number | null;
    date?: string;
    isTransfer?: boolean;
  }) => {
    current!.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${over.accountId}, ${over.date ?? '2026-03-15'}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${alice}, ${nowIso()}, ${nowIso()})
    `);
  };

  return { db: current.db, sqlite: current.sqlite, alice, chequing, savingsAccount, salary, groceries, txn };
}

describe('saveSavingsTarget / getSavingsTarget', () => {
  it('returns null for a month that was never set', () => {
    setup();
    expect(getSavingsTarget('2026-03')).toBeNull();
  });

  it('upserting the same month twice replaces rather than duplicating (ruling T3/T4)', () => {
    const { sqlite } = setup();
    saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 20 });
    saveSavingsTarget({ month: '2026-03', mode: 'amount', value: 50000 });

    expect((sqlite.prepare('select count(*) as c from savings_targets').get() as { c: number }).c).toBe(1);
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'amount', value: 50000 });
  });

  it('rejects a malformed month key', () => {
    setup();
    expect(() => saveSavingsTarget({ month: '2026-3', mode: 'percent', value: 20 })).toThrowError(/YYYY-MM/);
  });

  it('rejects a percent value outside 1-100', () => {
    setup();
    expect(() => saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 0 })).toThrowError();
    expect(() => saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 101 })).toThrowError();
  });

  it('rejects a negative amount', () => {
    setup();
    expect(() => saveSavingsTarget({ month: '2026-03', mode: 'amount', value: -1 })).toThrowError();
  });
});

describe('deleteSavingsTarget', () => {
  it('reports whether a row actually existed', () => {
    setup();
    saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 20 });
    expect(deleteSavingsTarget('2026-03')).toBe(true);
    expect(getSavingsTarget('2026-03')).toBeNull();
    expect(deleteSavingsTarget('2026-03')).toBe(false);
  });
});

describe('copySavingsTargetForward (ruling T4)', () => {
  it('returns false and writes nothing when the previous month has no target', () => {
    const { sqlite } = setup();
    expect(copySavingsTargetForward('2026-03')).toBe(false);
    expect((sqlite.prepare('select count(*) as c from savings_targets').get() as { c: number }).c).toBe(0);
  });

  it('copies the previous month exactly, mode and value both', () => {
    setup();
    saveSavingsTarget({ month: '2026-02', mode: 'percent', value: 15 });
    expect(copySavingsTargetForward('2026-03')).toBe(true);
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'percent', value: 15 });
  });

  it('overwrites an existing target for the viewed month, same as saveSavingsTarget', () => {
    setup();
    saveSavingsTarget({ month: '2026-02', mode: 'amount', value: 40000 });
    saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 10 });
    copySavingsTargetForward('2026-03');
    expect(getSavingsTarget('2026-03')).toEqual({ month: '2026-03', mode: 'amount', value: 40000 });
  });
});

describe('savingsProgress: target resolution', () => {
  it('resolves a percent target against this month\'s income', () => {
    const { chequing, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary }); // $5,000 income
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries }); // $3,500 spend
    saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 20 });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.incomeCents).toBe(500000);
    expect(progress.spendCents).toBe(350000);
    expect(progress.netCents).toBe(150000);
    expect(progress.targetCents).toBe(100000); // 20% of 500000
    expect(progress.met).toBe(true);
    expect(progress.pct).toBe(150); // 150000 / 100000
  });

  it('resolves a fixed amount target regardless of income', () => {
    const { chequing, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -480000, categoryId: groceries });
    saveSavingsTarget({ month: '2026-03', mode: 'amount', value: 50000 });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.targetCents).toBe(50000);
    expect(progress.netCents).toBe(20000);
    expect(progress.met).toBe(false);
  });

  it('a percent target with zero income resolves targetCents to null, never dividing by zero', () => {
    const { groceries, chequing, txn } = setup();
    txn({ accountId: chequing, amountCents: -10000, categoryId: groceries }); // spend only, no income row at all
    saveSavingsTarget({ month: '2026-03', mode: 'percent', value: 20 });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.incomeCents).toBe(0);
    expect(progress.targetCents).toBeNull();
    expect(progress.pct).toBeNull();
    expect(progress.met).toBe(false); // no opinion, not a failure -- but never true with a null target
  });

  it('a month with no target has a null targetCents, a null pct, and met=false -- no opinion, not a miss', () => {
    const { chequing, salary, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.target).toBeNull();
    expect(progress.targetCents).toBeNull();
    expect(progress.pct).toBeNull();
    expect(progress.met).toBe(false);
  });
});

/**
 * Ruling T1's three cases, verbatim from the plan: $5,000 income, $3,500 spend, $1,000 moved to
 * savings. Cases 1 and 2 must land on the exact same net ($1,500); case 3 is not a bug -- it is
 * the behaviour the household is warned about (ruling T1a's noSavingsAccount disclosure exists
 * precisely because this case is silent otherwise).
 */
describe('savingsProgress: ruling T1 -- moving money to savings must not change "saved"', () => {
  it('case 1: both legs flagged as transfers -- net is $1,500', () => {
    const { chequing, savingsAccount, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries });
    txn({ accountId: chequing, amountCents: -100000, categoryId: null, isTransfer: true });
    txn({ accountId: savingsAccount, amountCents: 100000, categoryId: null, isTransfer: true });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.netCents).toBe(150000);
  });

  it('case 2: savings account imported, NEITHER leg flagged -- still $1,500 (uncategorized legs cancel)', () => {
    const { chequing, savingsAccount, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries });
    txn({ accountId: chequing, amountCents: -100000, categoryId: null }); // uncategorized, not flagged
    txn({ accountId: savingsAccount, amountCents: 100000, categoryId: null }); // uncategorized, not flagged

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.netCents).toBe(150000);
  });

  it('case 3: savings account NOT imported and the leg not flagged -- net is understated by exactly what was saved (not a bug)', () => {
    const { chequing, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries });
    // The $1,000 leaves for a bank this app never sees -- only the outflow is recorded, and it is
    // never flagged, so it reads as ordinary uncategorized spend.
    txn({ accountId: chequing, amountCents: -100000, categoryId: null });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.netCents).toBe(50000); // $500, not $1,500 -- understated by the $1,000 saved
  });

  it('a transfer deposit filed under an INCOME category inflates income -- a trap fixtures must avoid, not a case this module fixes', () => {
    const { chequing, savingsAccount, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries });
    txn({ accountId: chequing, amountCents: -100000, categoryId: null, isTransfer: true });
    // Filed under an income category instead of null/transfer-neutral: this transaction still
    // carries is_transfer=true, so rangeClauses (reports.ts) excludes it from every series
    // regardless of its category -- transfers are excluded FIRST, so a miscategorized transfer
    // still cannot inflate income.
    txn({ accountId: savingsAccount, amountCents: 100000, categoryId: salary, isTransfer: true });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.incomeCents).toBe(500000); // NOT 600000
    expect(progress.netCents).toBe(150000);
  });
});

describe('savingsProgress: ruling T1a -- movedToSavingsCents is disclosure only', () => {
  it('counts only flagged transfer DEPOSITS landing in a savings-type account, and never folds into netCents', () => {
    const { chequing, savingsAccount, salary, groceries, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: chequing, amountCents: -350000, categoryId: groceries });
    txn({ accountId: chequing, amountCents: -100000, categoryId: null, isTransfer: true });
    txn({ accountId: savingsAccount, amountCents: 100000, categoryId: null, isTransfer: true });

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.movedToSavingsCents).toBe(100000);
    expect(progress.netCents).toBe(150000); // unaffected -- 150000, not 250000
    expect(progress.noSavingsAccount).toBe(false);
  });

  it('ignores an unflagged deposit into a savings account -- only FLAGGED transfers count', () => {
    const { chequing, savingsAccount, salary, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: savingsAccount, amountCents: 100000, categoryId: null }); // not flagged

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.movedToSavingsCents).toBe(0);
  });

  it('ignores a flagged transfer OUT of a savings account -- deposits only, never withdrawals', () => {
    const { chequing, savingsAccount, salary, txn } = setup();
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary });
    txn({ accountId: savingsAccount, amountCents: -20000, categoryId: null, isTransfer: true }); // withdrawal

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.movedToSavingsCents).toBe(0);
  });

  it('reports noSavingsAccount when the household has no savings-type account at all', () => {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const chequing = insertTestAccount(current.db, { name: 'Chequing', type: 'chequing' });
    const salary = categoryIdByName(current.db, 'Salary');
    current.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${chequing}, '2026-03-10', 'X', 'X', 500000, ${salary}, 'manual', 0, ${alice}, ${nowIso()}, ${nowIso()})
    `);

    const progress = savingsProgress('2026-03', HOUSEHOLD);
    expect(progress.noSavingsAccount).toBe(true);
    expect(progress.movedToSavingsCents).toBe(0);
  });
});

describe('savingsStreak', () => {
  function setTargetAndIncome(month: string, { chequing, salary, groceries, txn }: ReturnType<typeof setup>, netCents: number) {
    txn({ accountId: chequing, amountCents: 500000, categoryId: salary, date: `${month}-05` });
    txn({ accountId: chequing, amountCents: -(500000 - netCents), categoryId: groceries, date: `${month}-06` });
  }

  it('counts consecutive met months ending at endMonth', () => {
    const seeded = setup();
    for (const month of ['2026-01', '2026-02', '2026-03']) {
      saveSavingsTarget({ month, mode: 'amount', value: 100000 });
      setTargetAndIncome(month, seeded, 150000); // $1,500 saved each month, target is $1,000
    }

    expect(savingsStreak('2026-03', HOUSEHOLD)).toBe(3);
  });

  it('stops at the first miss', () => {
    const seeded = setup();
    saveSavingsTarget({ month: '2026-01', mode: 'amount', value: 100000 });
    setTargetAndIncome('2026-01', seeded, 150000); // met
    saveSavingsTarget({ month: '2026-02', mode: 'amount', value: 100000 });
    setTargetAndIncome('2026-02', seeded, 50000); // missed
    saveSavingsTarget({ month: '2026-03', mode: 'amount', value: 100000 });
    setTargetAndIncome('2026-03', seeded, 150000); // met, but February breaks continuity with January

    expect(savingsStreak('2026-02', HOUSEHOLD)).toBe(0); // endMonth itself was missed
    expect(savingsStreak('2026-03', HOUSEHOLD)).toBe(1); // only March counts -- February stops the walk
  });

  it('stops at a month with no target set, distinct from a miss', () => {
    const seeded = setup();
    // 2026-01 has no target at all -- never nag about a target a household never agreed to.
    setTargetAndIncome('2026-01', seeded, 150000);
    saveSavingsTarget({ month: '2026-02', mode: 'amount', value: 100000 });
    setTargetAndIncome('2026-02', seeded, 150000);
    saveSavingsTarget({ month: '2026-03', mode: 'amount', value: 100000 });
    setTargetAndIncome('2026-03', seeded, 150000);

    expect(savingsStreak('2026-03', HOUSEHOLD)).toBe(2);
  });

  it('honours max', () => {
    const seeded = setup();
    const months = ['2026-01', '2026-02', '2026-03', '2026-04'];
    for (const month of months) {
      saveSavingsTarget({ month, mode: 'amount', value: 100000 });
      setTargetAndIncome(month, seeded, 150000);
    }

    expect(savingsStreak('2026-04', HOUSEHOLD, 2)).toBe(2);
    expect(savingsStreak('2026-04', HOUSEHOLD)).toBe(4);
  });
});
