import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { recordBalanceSnapshot } from '@/lib/networth';
import { reconcileAccount } from '@/lib/balance-reconcile';

/**
 * reconcileAccount (spec 2026-08-23, v1.8.0, Task 5). Two consecutive source='csv' snapshots
 * are the bank's own statement balances for two dates -- the transactions imported between
 * those dates should account for exactly the difference. Ruling R7: report only, never correct
 * -- there is no write path in src/lib/balance-reconcile.ts at all, so nothing here can ever
 * assert on an adjusting transaction or a plug entry, because none can exist.
 *
 * Ruling R1 applies here identically to src/lib/balance.ts: this module calls that file's
 * movementBetween rather than re-deriving its own transaction sum, so the fixtures below pin
 * the SAME trap balance.test.ts pins for balanceAsOf -- a transfer-flagged card payment must
 * count as real movement, or a perfectly clean statement would wrongly read as a missing
 * import. tests/ops/balance-invariants.test.ts is the second, independent guard for this file,
 * the same way it already is for balance.ts.
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
    over: Partial<{ accountId: number; date: string; amountCents: number; isTransfer: boolean }> = {},
  ): number => {
    const description = 'GENERIC MERCHANT';
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${over.accountId}, ${over.date ?? '2026-07-15'}, ${description}, ${normalizeMerchant(description)},
              ${over.amountCents ?? -1000}, ${null}, 'none',
              ${over.isTransfer ? 1 : 0}, ${userId}, ${SENTINEL_TIMESTAMP}, ${SENTINEL_TIMESTAMP})
      returning id`);
    return row.id;
  };

  return { db: current.db, seedAccount, seedTransaction };
}

describe('reconcileAccount: consecutive csv snapshots checksummed against transactions between them', () => {
  it('finds nothing when consecutive statement balances agree with the transactions between', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-07-10', amountCents: -2500 });
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 97500, source: 'csv' });

    expect(reconcileAccount({ accountId })).toEqual([]);
  });

  it('reports the delta and both dates when a transaction never imported', () => {
    const { seedAccount } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 95000, source: 'csv' });

    expect(reconcileAccount({ accountId })).toEqual([
      { accountId, fromDate: '2026-07-01', toDate: '2026-07-20', expectedCents: 95000, impliedCents: 100000, deltaCents: 5000 },
    ]);
  });

  it('walks multiple consecutive pairs and reports only the pair that disagrees', () => {
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-06-01', balanceCents: 100000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-06-15', amountCents: -1000 });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 99000, source: 'csv' }); // agrees exactly
    // No transaction recorded in this window even though the statement shows $50 left the account.
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 94000, source: 'csv' }); // disagrees by 5000

    expect(reconcileAccount({ accountId })).toEqual([
      { accountId, fromDate: '2026-07-01', toDate: '2026-07-20', expectedCents: 94000, impliedCents: 99000, deltaCents: 5000 },
    ]);
  });

  it('counts a transfer-flagged payment when reconciling -- it must not read as a missing row', () => {
    // Ruling R1: a credit-card payment is normally is_transfer=1 to keep it out of spend
    // reporting, but the money still moved through the account and the bank's own statement
    // reflects it. If reconcileAccount inherited that filter -- directly, or by re-deriving its
    // own sum instead of calling movementBetween -- the payment would vanish from impliedCents
    // and this would wrongly flag a perfectly clean statement as a missing import.
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'credit' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: -50000, source: 'csv' });
    seedTransaction({ accountId, date: '2026-07-15', amountCents: 50000, isTransfer: true });
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 0, source: 'csv' });

    expect(reconcileAccount({ accountId })).toEqual([]);
  });

  it('ignores manual and simplefin snapshots as reconciliation endpoints', () => {
    // Only a statement's own balance column is authoritative enough to reconcile against -- a
    // hand-typed figure (or a live sync figure) disagreeing with the transactions around it is
    // not evidence of a missing import. Both rows below would blow up the gap if they were ever
    // treated as an endpoint; reconcileAccount must walk straight past them to the next csv row.
    const { seedAccount, seedTransaction } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    recordBalanceSnapshot({ accountId, date: '2026-07-05', balanceCents: 1, source: 'manual' });
    recordBalanceSnapshot({ accountId, date: '2026-07-10', balanceCents: 2, source: 'simplefin' });
    seedTransaction({ accountId, date: '2026-07-15', amountCents: -2500 });
    recordBalanceSnapshot({ accountId, date: '2026-07-20', balanceCents: 97500, source: 'csv' });

    expect(reconcileAccount({ accountId })).toEqual([]);
  });

  it('finds nothing for an account with fewer than two csv snapshots', () => {
    const { seedAccount } = setup();
    const accountId = seedAccount({ type: 'chequing' });
    expect(reconcileAccount({ accountId })).toEqual([]);

    recordBalanceSnapshot({ accountId, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    expect(reconcileAccount({ accountId })).toEqual([]);
  });

  it('reconciles only the requested account, leaving another account alone', () => {
    const { seedAccount } = setup();
    const a = seedAccount({ type: 'chequing', name: 'A' });
    const b = seedAccount({ type: 'chequing', name: 'B' });
    recordBalanceSnapshot({ accountId: a, date: '2026-07-01', balanceCents: 100000, source: 'csv' });
    recordBalanceSnapshot({ accountId: a, date: '2026-07-20', balanceCents: 95000, source: 'csv' });
    recordBalanceSnapshot({ accountId: b, date: '2026-07-01', balanceCents: 5000, source: 'csv' });
    recordBalanceSnapshot({ accountId: b, date: '2026-07-20', balanceCents: 5000, source: 'csv' });

    const discrepancies = reconcileAccount({ accountId: a });
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0].accountId).toBe(a);
  });
});
