import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyPaymentMatchers, assignTransactionToLoan, saveLoanRule } from '@/lib/loans';
import { addInstallment } from '@/lib/warranty/installments';
import { setupLoanTest } from './fixtures';

const NOW = '2026-06-01T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * A bill item with one unpaid installment and a matcher rule, a loan item with a balance, and one
 * transaction that the bill rule matches (item T / MON-2, ruling P4). Also a second loan item (for
 * MUST-11.16) and one unrelated transaction the bill rule does not touch.
 */
function setup() {
  current = createSeededTestDb();
  const db = current.db;
  const userId = insertTestUser(db, { username: 'payer' });
  const accountId = insertTestAccount(db, { name: 'Chequing' });

  const billTypeId = db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values ('Property tax', 0, 'bill', ${NOW}) returning id`,
  )!.id;
  const billItemId = db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
        values ('City property tax', '2024-01-15', 0, ${userId}, ${billTypeId}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const installmentId = addInstallment({ itemId: billItemId, dueDate: '2026-06-15', amountCents: 120_000, at: NOW });
  saveLoanRule({ itemId: billItemId, merchantContains: 'CITY TAX OFFICE', accountId: null, enabled: true });

  const loanTypeId = db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values ('Car loan', 0, 'loan', ${NOW}) returning id`,
  )!.id;
  const loanItemId = db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
        values ('Civic', '2024-01-15', 0, ${userId}, ${loanTypeId}, 2000000, 1800000, ${NOW}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const secondLoanItemId = db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
        values ('Truck', '2024-01-15', 0, ${userId}, ${loanTypeId}, 3000000, 2500000, ${NOW}, ${NOW}, ${NOW}) returning id`,
  )!.id;

  const txnId = db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
        values (${accountId}, '2026-06-14', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ${userId}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const unrelatedTxnId = db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
        values (${accountId}, '2026-06-10', 'GROCERY STORE', 'GROCERY STORE', -5000, 0, ${userId}, ${NOW}, ${NOW}) returning id`,
  )!.id;

  return { txnId, loanItemId, secondLoanItemId, unrelatedTxnId, installmentId, db };
}

describe('a transaction cannot pay a bill and a loan (item T / MON-2, ruling P4)', () => {
  it('refuses the manual assign, by name, and does not move the loan balance', () => {
    const { txnId, loanItemId, db } = setup();
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    expect(db.get<{ paid: number | null }>(sql`select paid_txn_id as paid from bill_installments limit 1`).paid).toBe(
      txnId,
    );
    const before = db.get<{ b: number }>(
      sql`select current_balance_cents as b from warranty_items where id = ${loanItemId}`,
    ).b;

    expect(() => assignTransactionToLoan({ txnId, itemId: loanItemId })).toThrow(/already pays a bill installment/);

    expect(
      db.get<{ b: number }>(sql`select current_balance_cents as b from warranty_items where id = ${loanItemId}`).b,
    ).toBe(before);
  });

  it('still allows a manual assign for a transaction that pays no bill', () => {
    const { loanItemId, unrelatedTxnId } = setup();
    const result = assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: loanItemId });
    expect(result.linked).toBe(true);
  });

  it('still allows a SECOND loan on one transaction — MUST-11.16, a combined payment is legitimate', () => {
    const { unrelatedTxnId, loanItemId, secondLoanItemId } = setup();
    assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: loanItemId });
    expect(assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: secondLoanItemId }).linked).toBe(true);
  });
});

describe('assignTransactionToLoan on a lent loan (spec BU)', () => {
  let ctx: ReturnType<typeof setupLoanTest>;
  afterEach(() => ctx?.t.cleanup());

  it('money OUT raises the balance and money IN lowers it', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 0, direction: 'lent' });

    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(50_000);

    const repayment = ctx.spend('E TRANSFER', 20_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 20_000 });
    expect(ctx.balanceOf(itemId)).toBe(30_000);
  });

  it('a repayment larger than the outstanding balance clamps at zero, never below', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 30_000, direction: 'lent' });
    const repayment = ctx.spend('E TRANSFER', 50_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 30_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
  });

  it('an UNKNOWN balance still applies nothing in either direction (NEW-2, unchanged)', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: null, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 0 });
    expect(ctx.balanceOf(itemId)).toBeNull();
  });

  it('an owed loan is untouched: money OUT still pays it down', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000);
    expect(assignTransactionToLoan({ txnId: payment, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(150_000);
  });
});
