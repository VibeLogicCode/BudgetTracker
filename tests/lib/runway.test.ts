import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { recordBalanceSnapshot } from '@/lib/networth';
import { cashRunway, cashRunwayHint } from '@/lib/runway';

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
    // All six requested months carry real history here, so the trim takes nothing and the
    // divisor is the full window -- the unchanged case the fix below must not disturb.
    expect(runway.monthsOfHistory).toBe(6);
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
    // Every month in the window was empty, so the trim leaves nothing: the `trend.length === 0`
    // guard now covers "no month in this window had any data" as well as "no months requested",
    // and both correctly land on months: null rather than a runway divided by a phantom average.
    expect(runway.monthsOfHistory).toBe(0);
  });

  /** v1.21.0 plan, item 14: `readyAfterMonth` names the month that must begin before there is a
   *  complete month to average -- one month after `today`'s own month, regardless of the
   *  reason `months` is null (this field is always computed, see its own docblock). */
  it('readyAfterMonth is one month after today, regardless of whether months is null', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-06-30', balanceCents: 100000, source: 'manual' });

    expect(cashRunway({ today: '2026-06-30' }, HOUSEHOLD).readyAfterMonth).toBe('2026-07');
  });
});

/**
 * The defect this block pins: `cashflowTrend` zero-fills every month in its requested range by
 * contract (src/lib/reports.ts), so a fixed six-month divisor on a household whose history starts
 * part-way into that window averaged in months the household never lived through -- halving the
 * average and doubling the runway. `trimLeadingEmptyMonths` (the same helper the dashboard chart
 * uses, shared from src/lib/reports.ts) drops exactly the leading run, and the divisor is
 * whatever survives it.
 */
describe('cashRunway: the average is drawn only from months the household actually has', () => {
  it('averages over the 2 months that have data, not the 6 that were requested', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 500000, source: 'manual' });

    // Today is mid-July, so the six full months requested are January through June. This
    // household's history starts in MAY: January-April are months it did not exist for.
    spend(chequing, -120000, '2026-05-10');
    spend(chequing, -80000, '2026-06-10');

    const totalSpendCents = 120000 + 80000;
    const runway = cashRunway({ today: '2026-07-15' }, HOUSEHOLD);
    expect(runway.monthsOfHistory).toBe(2);
    expect(runway.avgMonthlySpendCents).toBe(Math.round(totalSpendCents / 2)); // 100000
  });

  /**
   * The bug-proving assertion. Both candidate averages are computed here rather than written as
   * literals so the comparison cannot quietly become a tautology: the diluted figure is what a
   * six-month divisor really produces on this fixture, and the runway that follows from it (15.0
   * months of cover on $1,000-a-month spending) is the exact shape of the reported defect -- a
   * household with five months of cash being told it has fifteen.
   */
  it('does NOT report the six-month-diluted average, or the inflated runway that follows from it', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 500000, source: 'manual' });
    spend(chequing, -120000, '2026-05-10');
    spend(chequing, -80000, '2026-06-10');

    const totalSpendCents = 120000 + 80000;
    const overMonthsWithData = Math.round(totalSpendCents / 2); // 100000
    const overSixMonthWindow = Math.round(totalSpendCents / 6); // 33333
    expect(overSixMonthWindow).toBeLessThan(overMonthsWithData); // the fixture really does dilute

    const runway = cashRunway({ today: '2026-07-15' }, HOUSEHOLD);
    expect(runway.avgMonthlySpendCents).not.toBe(overSixMonthWindow);
    expect(runway.avgMonthlySpendCents).toBe(overMonthsWithData);

    // And the figure the tile actually shows: 5.0 months of cover, not the 15.0 the diluted
    // average would have claimed from the very same $5,000 balance.
    expect(runway.months).toBe(Math.round((500000 / overMonthsWithData) * 10) / 10);
    expect(runway.months).toBe(5);
    expect(runway.months).not.toBe(Math.round((500000 / overSixMonthWindow) * 10) / 10);
  });

  /**
   * The trim is LEADING-only, and this is the case that proves why that matters for an average
   * and not only for a chart: a month the household lived through and spent nothing in is real
   * signal about its pace. Dropping it would flatter the average upward exactly as badly as the
   * leading zeros flattered it downward.
   */
  it('keeps an interior quiet month in the divisor -- a real zero is data, not missing data', () => {
    const { db, spend } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 500000, source: 'manual' });

    // April and June have spend; May is genuinely quiet, with real months either side of it.
    spend(chequing, -90000, '2026-04-10');
    spend(chequing, -30000, '2026-06-10');

    const totalSpendCents = 90000 + 30000;
    const runway = cashRunway({ today: '2026-07-15' }, HOUSEHOLD);
    expect(runway.monthsOfHistory).toBe(3); // April, May, June -- January-March were before its time
    expect(runway.avgMonthlySpendCents).toBe(Math.round(totalSpendCents / 3)); // 40000
    // Not the 60000 that dropping the quiet interior month would have produced.
    expect(runway.avgMonthlySpendCents).not.toBe(Math.round(totalSpendCents / 2));
  });

  it('reports 0 months of history, and no runway at all, on a household with no transactions', () => {
    const { db } = setup();
    const chequing = insertTestAccount(db, { name: 'Chequing', type: 'chequing' });
    recordBalanceSnapshot({ accountId: chequing, date: '2026-07-15', balanceCents: 500000, source: 'manual' });

    const runway = cashRunway({ today: '2026-07-15' }, HOUSEHOLD);
    expect(runway.monthsOfHistory).toBe(0);
    expect(runway.avgMonthlySpendCents).toBe(0);
    expect(runway.months).toBeNull();
    // A household with cash on hand and no history still has cash on hand -- the balance half of
    // the figure is unaffected by the spend half having nothing to average.
    expect(runway.liquidCents).toBe(500000);
  });
});

/**
 * v1.21.0 plan, item 14. `cashRunwayHint` is the one place the "why is there nothing to show"
 * sentence is decided (mirroring `netWorthHint`, src/lib/networth.ts) -- these tests pin it
 * directly rather than through a rendered dashboard page, the same level render.test.ts already
 * tests notify's own per-event sentences at.
 */
describe('cashRunwayHint', () => {
  it('says what is true on a brand-new household -- needs one complete month, and names when', () => {
    const hint = cashRunwayHint({ months: null, liquidCents: 0, avgMonthlySpendCents: 0, readyAfterMonth: '2026-09', monthsOfHistory: 0 });
    expect(hint).not.toContain('no spending history');
    expect(hint).toContain('one complete month');
    expect(hint).toContain('September 2026');
    // The null branch's wording is untouched by the basis disclosure below: there is no basis to
    // state when there is not one complete month yet, and naming "0 months of history" here would
    // be a second, worse way of saying what this sentence already says better.
    expect(hint).not.toContain('of history');
  });

  it('states the liquid/average-spend arithmetic AND the months of history it rests on', () => {
    const hint = cashRunwayHint({ months: 4.2, liquidCents: 420000, avgMonthlySpendCents: 100000, readyAfterMonth: '2026-08', monthsOfHistory: 6 });
    expect(hint).toBe('$4,200.00 liquid ÷ $1,000.00 average monthly spend, based on 6 months of history');
  });

  /**
   * The tile still SHOWS the number on a household this young -- a deliberate ruling, not an
   * oversight: blanking it would take away the one figure that answers "can we cover next month"
   * from exactly the households most likely to be asking. The sentence names how thin the basis
   * is instead, in the same plain register `netWorthHint` (src/lib/networth.ts) uses for the
   * sibling "some accounts have no balance" disclosure.
   */
  it('says the run is short when the average rests on 2 months, without withholding the figure', () => {
    const hint = cashRunwayHint({ months: 5, liquidCents: 500000, avgMonthlySpendCents: 100000, readyAfterMonth: '2026-08', monthsOfHistory: 2 });
    expect(hint).toBe('$5,000.00 liquid ÷ $1,000.00 average monthly spend, based on 2 months of history — a short run to average over');
  });

  it('says "1 month", singular, when the average rests on a single month', () => {
    const hint = cashRunwayHint({ months: 5, liquidCents: 500000, avgMonthlySpendCents: 100000, readyAfterMonth: '2026-08', monthsOfHistory: 1 });
    expect(hint).toBe('$5,000.00 liquid ÷ $1,000.00 average monthly spend, based on 1 month of history — a short run to average over');
    expect(hint).not.toContain('1 months');
  });

  it('states the basis plainly, with no hedge, from 3 months of history up', () => {
    const hint = cashRunwayHint({ months: 5, liquidCents: 500000, avgMonthlySpendCents: 100000, readyAfterMonth: '2026-08', monthsOfHistory: 3 });
    expect(hint).toBe('$5,000.00 liquid ÷ $1,000.00 average monthly spend, based on 3 months of history');
    expect(hint).not.toContain('short run');
  });
});
