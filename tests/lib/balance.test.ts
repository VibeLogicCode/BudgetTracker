import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { recordBalanceSnapshot } from '@/lib/networth';
import { setTransactionSplits } from '@/lib/splits';
import { balanceAsOf, balancesAsOf, movementBetween } from '@/lib/balance';

/**
 * balanceAsOf / balancesAsOf (spec 2026-08-23, v1.8.0, Task 4). Ruling R1 -- the resolver reads
 * transactions.amount_cents raw, with no is_transfer filter, no splits join and no category
 * filter -- is pinned FIRST, before anything else in this file, matching the spec's own step
 * ordering: it is the one defect class a fixture might not happen to cover if it were left
 * until later, so it gets fixtures on purpose, up front. tests/ops/balance-invariants.test.ts
 * is the second, independent guard for the same ruling -- a source-level grep rather than a
 * behavioural fixture.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const SENTINEL_TIMESTAMP = '2020-01-01T00:00:00.000Z';

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Owner', username: 'owner' });

  const seedAccount = (over: Partial<{ type: 'chequing' | 'credit' | 'cash'; name: string }> = {}): number =>
    insertTestAccount(current!.db, over);

  const seedTransaction = (
    over: Partial<{
      accountId: number;
      date: string;
      description: string;
      amountCents: number;
      categoryId: number | null;
      isTransfer: boolean;
    }> = {},
  ): number => {
    const description = over.description ?? 'GENERIC MERCHANT';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${over.accountId}, ${over.date ?? '2026-07-15'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -1000}, ${over.categoryId ?? null}, 'none',
              ${over.isTransfer ? 1 : 0}, ${userId}, ${SENTINEL_TIMESTAMP}, ${SENTINEL_TIMESTAMP})
      returning id`);
    return row.id;
  };

  return { db: current.db, userId, seedAccount, seedTransaction };
}

describe('balanceAsOf: ruling R1 -- raw transaction amounts, no spend filters', () => {
  it('counts a transfer-flagged transaction in the balance', () => {
    // A credit-card payment is normally is_transfer=1 to keep it out of spend reporting. If
    // this path inherited that filter, every payment would vanish and the card balance would
    // climb forever while looking entirely plausible.
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'credit' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: -50000, source: 'manual' });
    seedTransaction({ accountId, date: '2026-07-15', amountCents: 50000, isTransfer: true });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })?.balanceCents).toBe(0);
  });

  it('counts a split transaction once, at its parent amount', () => {
    // The parent's amount_cents is the true movement. A LEFT JOIN over transaction_splits
    // (EFFECTIVE_AMOUNT, src/lib/splits.ts) must not appear in this path.
    const { db, seedAccount, seedTransaction, userId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'manual' });
    const txnId = seedTransaction({ accountId, date: '2026-07-15', amountCents: -10000 });
    setTransactionSplits({
      txnId,
      userId,
      parts: [
        { categoryId: groceries, amountCents: -6000, note: null },
        { categoryId: coffee, amountCents: -4000, note: null },
      ],
    });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })?.balanceCents).toBe(90000);
  });

  it('counts an uncategorized transaction -- no category filter either', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'manual' });
    seedTransaction({ accountId, date: '2026-07-15', amountCents: -2500, categoryId: null });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })?.balanceCents).toBe(97500);
  });
});

describe('balanceAsOf: ruling R2 -- newest snapshot at or before the date, summed forward', () => {
  it('anchors on the newest snapshot at or before the date', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-06-01', balanceCents: 100000, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 120000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-07-10', amountCents: -2000 });

    const resolved = balanceAsOf({ accountId, date: '2026-07-31' });
    expect(resolved).toMatchObject({ anchorDate: '2026-07-01', balanceCents: 118000, movedSinceCents: -2000 });
  });

  it('ignores transactions before the anchor -- they are already inside the anchor figure', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    seedTransaction({ accountId, date: '2026-06-15', amountCents: -99999 });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 120000, source: 'csv' });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })?.balanceCents).toBe(120000);
  });

  it('ignores transactions on the anchor date itself -- a snapshot is that date\'s CLOSING balance (ruling R4)', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-07-01', amountCents: -5000 });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })).toMatchObject({ balanceCents: 100000, movedSinceCents: 0 });
  });

  it('ignores transactions after the requested date', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-08-15', amountCents: -30000 });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })).toMatchObject({ balanceCents: 100000, movedSinceCents: 0 });
  });

  it('returns null when no snapshot exists at or before the date', () => {
    const { seedAccount } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: 100000, source: 'csv' });

    expect(balanceAsOf({ accountId, date: '2026-07-01' })).toBeNull();
  });

  it('heals drift when a fresh snapshot lands after a period of missing transactions', () => {
    // The self-correcting property that makes caching unnecessary: a new snapshot re-anchors
    // everything after it, whatever was wrong (or simply unrecorded) before it.
    const { seedAccount } = setup();
    const accountId = seedAccount({ type: 'credit' });
    recordBalanceSnapshot({ accountId, date: '2026-06-01', balanceCents: -10000, source: 'manual' });
    recordBalanceSnapshot({ accountId, date: '2026-08-01', balanceCents: -55000, source: 'manual' });

    expect(balanceAsOf({ accountId, date: '2026-08-15' })?.balanceCents).toBe(-55000);
  });
});

describe('balanceAsOf: full ResolvedBalance shape', () => {
  it('reports accountId, anchorSource and movedSinceCents alongside the resolved balance', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 50000, source: 'simplefin' });
    seedTransaction({ accountId, date: '2026-07-05', amountCents: 1500 });

    expect(balanceAsOf({ accountId, date: '2026-07-31' })).toEqual({
      accountId,
      balanceCents: 51500,
      anchorDate: '2026-07-01',
      anchorSource: 'simplefin',
      movedSinceCents: 1500,
    });
  });

  it('reports source csv and source manual just as faithfully as simplefin', () => {
    const { seedAccount } = setup();
    const csvAccount = seedAccount({ type: 'chequing', name: 'CSV account' });
    const manualAccount = seedAccount({ type: 'cash', name: 'Manual account' });
    recordBalanceSnapshot({ accountId: csvAccount, date: '2026-07-01', balanceCents: 1000, source: 'csv' });
    recordBalanceSnapshot({ accountId: manualAccount, date: '2026-07-01', balanceCents: 2000, source: 'manual' });

    expect(balanceAsOf({ accountId: csvAccount, date: '2026-07-01' })?.anchorSource).toBe('csv');
    expect(balanceAsOf({ accountId: manualAccount, date: '2026-07-01' })?.anchorSource).toBe('manual');
  });
});

describe('balancesAsOf: many accounts in one call', () => {
  it('resolves many accounts in one call, and omits one with no qualifying snapshot', () => {
    const { seedAccount, seedTransaction } = setup();
    const a = seedAccount({ type: 'chequing', name: 'A' });
    const b = seedAccount({ type: 'credit', name: 'B' });
    const c = seedAccount({ type: 'cash', name: 'C' }); // never snapshotted

    recordBalanceSnapshot({ accountId: a, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    seedTransaction({ accountId: a, date: '2026-07-10', amountCents: -2500 });
    recordBalanceSnapshot({ accountId: b, date: '2026-07-01', balanceCents: -20000, source: 'manual' });

    const resolved = balancesAsOf({ accountIds: [a, b, c], date: '2026-07-31' });

    expect(resolved.size).toBe(2);
    expect(resolved.get(a)).toMatchObject({ balanceCents: 97500, anchorDate: '2026-07-01', movedSinceCents: -2500 });
    expect(resolved.get(b)).toMatchObject({ balanceCents: -20000, anchorDate: '2026-07-01', movedSinceCents: 0 });
    expect(resolved.has(c)).toBe(false);
  });

  it('lets two accounts in the same call anchor on two different dates without cross-contaminating movement', () => {
    const { seedAccount, seedTransaction } = setup();
    const early = seedAccount({ type: 'chequing', name: 'Early anchor' });
    const late = seedAccount({ type: 'chequing', name: 'Late anchor' });

    recordBalanceSnapshot({ accountId: early, date: '2026-05-01', balanceCents: 10000, source: 'csv' });
    seedTransaction({ accountId: early, date: '2026-06-15', amountCents: 500 });
    recordBalanceSnapshot({ accountId: late, date: '2026-07-20', balanceCents: 30000, source: 'csv' });
    // Dated between `early`'s anchor and the target date, but BEFORE `late`'s own anchor --
    // must count for `early` and must not leak into `late`'s total.
    seedTransaction({ accountId: late, date: '2026-06-01', amountCents: -999999 });

    const resolved = balancesAsOf({ accountIds: [early, late], date: '2026-07-31' });
    expect(resolved.get(early)).toMatchObject({ anchorDate: '2026-05-01', balanceCents: 10500 });
    expect(resolved.get(late)).toMatchObject({ anchorDate: '2026-07-20', balanceCents: 30000 });
  });

  it('returns an empty map for an empty account list, without touching the database', () => {
    setup();
    expect(balancesAsOf({ accountIds: [], date: '2026-07-31' })).toEqual(new Map());
  });
});

describe('movementBetween: raw sum over an explicit date range (v1.8.0 Task 5)', () => {
  // Task 5's reconciliation building block: unlike balanceAsOf/balancesAsOf above, this does not
  // look up an anchor snapshot at all -- both dates are given by the caller (two ALREADY-KNOWN
  // statement dates from src/lib/balance-reconcile.ts). Same ruling R1 raw sum either way, which
  // is the whole reason this lives here rather than being re-derived in that file.
  it('sums raw transaction amounts strictly after afterDate and up to and including throughDate', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    seedTransaction({ accountId, date: '2026-07-05', amountCents: -1000 });
    seedTransaction({ accountId, date: '2026-07-10', amountCents: -2000 });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-15' })).toBe(-3000);
  });

  it('excludes a transaction dated exactly on afterDate -- that date is already inside the earlier balance', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    seedTransaction({ accountId, date: '2026-07-01', amountCents: -50000 });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(0);
  });

  it('includes a transaction dated exactly on throughDate', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    seedTransaction({ accountId, date: '2026-07-20', amountCents: -1500 });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(-1500);
  });

  it('excludes a transaction dated after throughDate', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    seedTransaction({ accountId, date: '2026-07-21', amountCents: -1500 });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(0);
  });

  it('counts a transfer-flagged transaction -- ruling R1 applies to this sum identically', () => {
    // Same trap as balanceAsOf: a credit-card payment is normally is_transfer=1 to keep it out
    // of spend reporting, but reconciliation needs the real money movement, transfer or not.
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'credit' });
    seedTransaction({ accountId, date: '2026-07-10', amountCents: 50000, isTransfer: true });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(50000);
  });

  it('returns 0, not null, for a range with no transactions', () => {
    const { seedAccount } = setup();
    const accountId = seedAccount({ type: 'chequing' });

    expect(movementBetween({ accountId, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(0);
  });

  it('sums only the given account, not any other', () => {
    const { seedAccount, seedTransaction } = setup();
    const a = seedAccount({ type: 'chequing', name: 'A' });
    const b = seedAccount({ type: 'chequing', name: 'B' });
    seedTransaction({ accountId: a, date: '2026-07-10', amountCents: -1000 });
    seedTransaction({ accountId: b, date: '2026-07-10', amountCents: -999999 });

    expect(movementBetween({ accountId: a, afterDate: '2026-07-01', throughDate: '2026-07-20' })).toBe(-1000);
  });
});
