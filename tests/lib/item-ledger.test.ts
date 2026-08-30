import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { assignTransactionToLoan, itemLedger, unlinkItemTransaction } from '@/lib/loans';
import { nowIso } from '@/lib/clock';
import { setupLoanTest, type LoanTestContext } from './loans/fixtures';

/**
 * Item 6 (v1.16.0 plan): itemLedger() unions loan_payments and paid bill_installments for one
 * item, and unlinkItemTransaction() is its row-menu Unlink. Both are exercised here against a
 * real (seeded) sqlite db, the same fixture setupLoanTest() already gives loans.ts's other
 * write-side suites -- a bill needs its own raw-SQL fixture below because setupLoanTest() only
 * seeds loan-kind items.
 */

let ctx: LoanTestContext | null = null;
afterEach(() => {
  ctx?.t.cleanup();
  ctx = null;
});

/** A bill-kind item with one installment, inserted the same raw-SQL way
 *  tests/lib/loans/manual-assign.test.ts's own bill fixture does. */
function seedBillWithPaidInstallment(context: LoanTestContext, opts: { dueDate: string; amountCents: number; txnDate: string }) {
  const NOW = '2026-08-18T12:00:00.000Z';
  const billTypeId = context.t.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values ('Property tax', 0, 'bill', ${NOW}) returning id`,
  ).id;
  const billItemId = context.t.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
        values ('City property tax', '2024-01-15', 0, ${context.userId}, ${billTypeId}, ${NOW}, ${NOW}) returning id`,
  ).id;
  const txnId = context.spend('CITY TAX OFFICE', -opts.amountCents, { date: opts.txnDate });
  const installmentId = context.t.db.get<{ id: number }>(
    sql`insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
        values (${billItemId}, ${opts.dueDate}, ${opts.amountCents}, ${nowIso()}, ${txnId}, ${NOW}) returning id`,
  ).id;
  return { billItemId, txnId, installmentId };
}

describe('itemLedger: an item with no links', () => {
  it('returns an empty ledger', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan();
    expect(itemLedger(itemId)).toEqual({ rows: [], totalAppliedCents: 0 });
  });
});

describe('itemLedger: loan_payments rows, newest first, direction-correct total', () => {
  it('sorts newest-first by the linked transaction date and sums a signed total for an owed loan', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000, direction: 'owed' });
    // Older payment first, then a newer one -- the ledger must reverse this.
    const older = ctx.spend('CAR LOAN', -50_000, { date: '2026-07-01' });
    const newer = ctx.spend('CAR LOAN', -30_000, { date: '2026-07-15' });
    // link() runs through assignTransactionToLoan in the fixtures' own suites; here the
    // ledger only needs real loan_payments rows, so insert them the same way `link()` does
    // (source 'manual', applied_cents == the full magnitude since neither payment exceeds
    // the anchored balance).
    ctx.t.db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
                      values (${older}, ${itemId}, 50000, 50000, 'manual', ${nowIso()})`);
    ctx.t.db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
                      values (${newer}, ${itemId}, 30000, 30000, 'manual', ${nowIso()})`);

    const ledger = itemLedger(itemId);
    expect(ledger.rows.map((row) => row.txnId)).toEqual([newer, older]);
    expect(ledger.rows[0]).toMatchObject({
      date: '2026-07-15',
      merchant: 'CAR LOAN',
      accountName: 'Chequing',
      amountCents: -30_000,
      appliedCents: 30_000,
      source: 'manual',
    });
    // Both rows are repayments on an owed loan (negative transactions), so both contribute
    // a NEGATIVE signed delta -- isLoanRepayment(direction, amountCents) is true for each.
    expect(ledger.totalAppliedCents).toBe(-80_000);
  });

  it('flips the sign for a lent loan: money out grows the total, money in shrinks it', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000, { date: '2026-07-01' });
    const repayment = ctx.spend('E TRANSFER', 20_000, { date: '2026-07-15' });
    ctx.t.db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
                      values (${advance}, ${itemId}, 50000, 50000, 'manual', ${nowIso()})`);
    ctx.t.db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
                      values (${repayment}, ${itemId}, 20000, 20000, 'manual', ${nowIso()})`);

    // Ruling P4: loanSignedDelta/isLoanRepayment own the flip -- the advance (money out) is
    // +50,000 in the loan's own frame, the repayment (money in) is -20,000.
    expect(itemLedger(itemId).totalAppliedCents).toBe(30_000);
  });
});

describe('itemLedger: paid bill_installments rows, unsigned total', () => {
  it('carries source "installment" and adds unsigned, never re-signed by direction', () => {
    ctx = setupLoanTest();
    const { billItemId, txnId } = seedBillWithPaidInstallment(ctx, {
      dueDate: '2026-06-15',
      amountCents: 120_000,
      txnDate: '2026-06-14',
    });
    const ledger = itemLedger(billItemId);
    expect(ledger.rows).toMatchObject([{ txnId, source: 'installment', appliedCents: 120_000 }]);
    expect(ledger.totalAppliedCents).toBe(120_000);
  });

  it('unions loan_payments and bill_installments rows for one item, still newest first', () => {
    // A synthetic fixture (not a shape a real item ever takes -- an item is one kind or the
    // other) purely to prove the union-and-sort mechanism itself, which is the actual
    // behaviour the plan asks this test to pin: "returns loan payments and installment
    // payments together, newest first".
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 500_000 });
    const loanTxn = ctx.spend('CAR LOAN', -40_000, { date: '2026-05-01' });
    ctx.t.db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
                      values (${loanTxn}, ${itemId}, 40000, 40000, 'rule', ${nowIso()})`);
    const billTxn = ctx.spend('CITY TAX OFFICE', -60_000, { date: '2026-05-20' });
    ctx.t.db.run(sql`insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
                      values (${itemId}, '2026-05-15', 60000, ${nowIso()}, ${billTxn}, ${nowIso()})`);

    const ledger = itemLedger(itemId);
    // The bill row (2026-05-20) is newer than the loan row (2026-05-01), so it sorts first.
    expect(ledger.rows.map((row) => ({ txnId: row.txnId, source: row.source }))).toEqual([
      { txnId: billTxn, source: 'installment' },
      { txnId: loanTxn, source: 'rule' },
    ]);
  });
});

describe('unlinkItemTransaction', () => {
  it('removes a loan_payments row and restores the balance (unassignTransactionFromLoan)', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000 });
    const txnId = ctx.spend('CAR LOAN', -50_000);
    // Through the real write path (assignTransactionToLoan), not a raw INSERT: link() is what
    // actually moves current_balance_cents, and a raw row here would leave the balance
    // untouched -- nothing to restore, and this test would pass for the wrong reason.
    expect(assignTransactionToLoan({ txnId, itemId }).linked).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(150_000);

    expect(unlinkItemTransaction(itemId, txnId)).toBe(true);
    expect(itemLedger(itemId).rows).toHaveLength(0);
    expect(ctx.balanceOf(itemId)).toBe(200_000);
  });

  it('removes a paid bill_installments row (the un-mark path) and stamps unlinked_at', () => {
    ctx = setupLoanTest();
    const { billItemId, txnId, installmentId } = seedBillWithPaidInstallment(ctx, {
      dueDate: '2026-06-15',
      amountCents: 120_000,
      txnDate: '2026-06-14',
    });

    expect(unlinkItemTransaction(billItemId, txnId)).toBe(true);
    expect(itemLedger(billItemId).rows).toHaveLength(0);
    const row = ctx.t.db.get<{ paidAt: string | null; paidTxnId: number | null; unlinkedAt: string | null }>(
      sql`select paid_at as paidAt, paid_txn_id as paidTxnId, unlinked_at as unlinkedAt from bill_installments where id = ${installmentId}`,
    );
    expect(row.paidAt).toBeNull();
    expect(row.paidTxnId).toBeNull();
    // ruling P1: stamped so a rule cannot silently re-mark the exact row a person just unlinked.
    expect(row.unlinkedAt).not.toBeNull();
  });

  it('returns false when neither table names this (itemId, txnId) pair', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan();
    const txnId = ctx.spend('GROCERY STORE', -5_000);
    expect(unlinkItemTransaction(itemId, txnId)).toBe(false);
  });
});
