import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { recordBalanceSnapshot } from '@/lib/networth';
import { cashRunway } from '@/lib/runway';

const HOUSEHOLD: Viewer = { id: 1, role: 'admin', visibility: 'household' };

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const groceries = categoryIdByName(current.db, 'Groceries');

  /**
   * Every spend row here is dated ON OR BEFORE the snapshot's own anchor date in each test, never
   * after -- balancesAsOf (src/lib/balance.ts) only sums transactions STRICTLY AFTER a snapshot's
   * date, so history dated at or before the anchor never moves the reported balance. That keeps
   * liquidCents exactly equal to whatever this file records as the snapshot, independent of the
   * spend fixtures built for the average-spend half of the same test.
   */
  const spend = (accountId: number, amountCents: number, date: string) => {
    current!.db.run(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${accountId}, ${date}, 'X', 'X', ${amountCents}, ${groceries}, 'manual', 0, ${alice}, ${nowIso()}, ${nowIso()})
    `);
  };

  return { db: current.db, sqlite: current.sqlite, alice, groceries, spend };
}

describe('cashRunway: which accounts count as liquid', () => {
  it('sums the latest balance of chequing, savings and cash accounts', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    const savings = insertTestAccount(db, { name: 'Savings', type: 'savings' });
    const cash = insertTestAccount(db, { name: 'Cash Jar', type: 'cash' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-06-30', balanceCents: 200000, source: 'manual' });
    recordBalanceSnapshot({ accountId: savings, date: '2026-06-30', balanceCents: 300000, source: 'manual' });
    recordBalanceSnapshot({ accountId: cash, date: '2026-06-30', balanceCents: 5000, source: 'manual' });

    const runway = cashRunway({ today: '2026-06-30' }, HOUSEHOLD);
    expect(runway.liquidCents).toBe(505000);
    expect(runway.accountsMissing).toBe(0);
  });

  it('excludes credit (a liability) and asset (property) accounts entirely, even when they carry a balance', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    const credit = insertTestAccount(db, { name: 'Credit Card', type: 'credit' });
    const asset = insertTestAccount(db, { name: 'House', type: 'asset' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-06-30', balanceCents: 100000, source: 'manual' });
    recordBalanceSnapshot({ accountId: credit, date: '2026-06-30', balanceCents: -50000, source: 'manual' });
    recordBalanceSnapshot({ accountId: asset, date: '2026-06-30', balanceCents: 40000000, source: 'manual' });

    const runway = cashRunway({ today: '2026-06-30' }, HOUSEHOLD);
    expect(runway.liquidCents).toBe(100000);
    // Neither excluded type counts toward accountsMissing either -- they were never candidates.
    expect(runway.accountsMissing).toBe(0);
  });

  it('counts a liquid account with no snapshot at all in accountsMissing, contributing 0 to liquidCents', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    insertTestAccount(db, { name: 'Never Balanced Savings', type: 'savings' }); // no snapshot ever recorded
    recordBalanceSnapshot({ accountId: chequing, date: '2026-06-30', balanceCents: 100000, source: 'manual' });

    const runway = cashRunway({ today: '2026-06-30' }, HOUSEHOLD);
    expect(runway.liquidCents).toBe(100000);
    expect(runway.accountsMissing).toBe(1);
  });
});

describe('cashRunway: average monthly spend and months covered', () => {
  it('averages the trailing 6 FULL months, and divides liquid cash by that average', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 420000, source: 'manual' });

    // $1,000 spend in each of the 6 full months before July (Jan-Jun).
    for (const month of ['01', '02', '03', '04', '05', '06']) {
      spend(chequing, -100000, `2026-${month}-10`);
    }

    const runway = cashRunway({ today: '2026-07-15' }, HOUSEHOLD);
    expect(runway.avgMonthlySpendCents).toBe(100000);
    expect(runway.liquidCents).toBe(420000);
    expect(runway.months).toBe(4.2); // 420000 / 100000, one decimal
  });

  it('excludes the CURRENT, possibly partial, month from the average', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 100000, source: 'manual' });
    spend(chequing, -100000, '2026-06-10'); // one full month of history: $1,000
    // A huge spend dated THIS month must not pull the average up -- July has not finished yet.
    spend(chequing, -900000, '2026-07-14');

    const runway = cashRunway({ today: '2026-07-15', months: 1 }, HOUSEHOLD);
    expect(runway.avgMonthlySpendCents).toBe(100000);
  });

  it('honours a custom trailing window', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-04-30', balanceCents: 60000, source: 'manual' });
    spend(chequing, -20000, '2026-01-10');
    spend(chequing, -40000, '2026-02-10');
    spend(chequing, -60000, '2026-03-10');

    // Today is in April, so the last FULL month is March -- a 2-month window is Feb-Mar, and a
    // 3-month window reaches back to January.
    expect(cashRunway({ today: '2026-04-30', months: 2 }, HOUSEHOLD).avgMonthlySpendCents).toBe(50000); // (40000+60000)/2
    expect(cashRunway({ today: '2026-04-30', months: 3 }, HOUSEHOLD).avgMonthlySpendCents).toBe(40000); // (20000+40000+60000)/3
  });

  it('returns months: null when there is no spend history at all, never dividing by zero', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-06-30', balanceCents: 100000, source: 'manual' });

    const runway = cashRunway({ today: '2026-06-30' }, HOUSEHOLD);
    expect(runway.avgMonthlySpendCents).toBe(0);
    expect(runway.months).toBeNull();
  });
});
