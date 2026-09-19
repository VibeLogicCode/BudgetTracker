import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { createManualTransaction } from '@/lib/transactions';
import { assignTransactionToBill, unlinkItemTransaction } from '@/lib/loans';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const NOW = '2026-09-01T00:00:00.000Z';

function seedBill(name: string, ownerUserId: number): number {
  const type = current!.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`${name} type`}, 0, 'bill', ${NOW}) returning id`,
  );
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
        values (${name}, '2024-01-15', 0, ${ownerUserId}, ${type.id}, ${NOW}, ${NOW}) returning id`,
  ).id;
}

function addInstallment(itemId: number, dueDate: string, amountCents: number): number {
  return current!.db.get<{ id: number }>(
    sql`insert into bill_installments (item_id, due_date, amount_cents, created_at)
        values (${itemId}, ${dueDate}, ${amountCents}, ${NOW}) returning id`,
  ).id;
}

function txn(accountId: number, userId: number, date: string, amountCents = -103906): number {
  return createManualTransaction({
    accountId,
    date,
    description: 'PROPERTY TAX PAYMENT',
    amountCents,
    categoryId: null,
    attributedUserId: null,
    userId,
    actorRole: 'admin',
  });
}

function paidState(installmentId: number) {
  return current!.db.get<{ paidAt: string | null; paidTxnId: number | null; unlinkedAt: string | null }>(
    sql`select paid_at as paidAt, paid_txn_id as paidTxnId, unlinked_at as unlinkedAt
        from bill_installments where id = ${installmentId}`,
  );
}

/**
 * The owner, 2026-09-13: "there is no way for me to assign a transaction to a bill or a contract?
 * if i say record payment from the bill menu it creates a payment but i should only be assigning
 * it a payment not manually creating a record."
 *
 * A loan has had `assignTransactionToLoan` on the row menu since v1.7.0. A bill had only two
 * routes: a payment-matching rule (automatic, text-matched) or Record payment, which WRITES a new
 * transaction. Neither of them is "this line on my statement is that bill's payment", which is
 * what a household standing on the Transactions page actually has in front of it.
 */
describe('assignTransactionToBill: linking a statement line to an installment', () => {
  it('marks the installment paid by that transaction', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const installment = addInstallment(item, '2026-09-30', 103906);
    const id = txn(account, user, '2026-09-13');

    const result = assignTransactionToBill({ txnId: id, itemId: item });

    expect(result.linked).toBe(true);
    expect(result.installmentId).toBe(installment);
    const state = paidState(installment);
    expect(state.paidTxnId).toBe(id);
    expect(state.paidAt).not.toBeNull();
  });

  it('picks the installment nearest the transaction date when none is named', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    addInstallment(item, '2026-03-31', 103906);
    const september = addInstallment(item, '2026-09-30', 103906);
    const id = txn(account, user, '2026-09-13');

    expect(assignTransactionToBill({ txnId: id, itemId: item }).installmentId).toBe(september);
  });

  it('takes the installment the household names, even when another is nearer', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const march = addInstallment(item, '2026-03-31', 103906);
    addInstallment(item, '2026-09-30', 103906);
    const id = txn(account, user, '2026-09-13');

    const result = assignTransactionToBill({ txnId: id, itemId: item, installmentId: march });

    expect(result.installmentId).toBe(march);
    expect(paidState(march).paidTxnId).toBe(id);
  });

  /**
   * The rule path refuses an installment a person has unlinked (`unlinked_at`), because that
   * suppression IS a person's earlier "no" to exactly this pairing. A person naming it now is a
   * newer decision by the same authority, so the manual path clears it -- the same way
   * assignTransactionToLoan is deliberately more permissive than the rule path it shares a file
   * with (MUST-11.16).
   */
  it('overrides a suppression a person set earlier, and clears it', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const installment = addInstallment(item, '2026-09-30', 103906);
    const first = txn(account, user, '2026-09-13');
    assignTransactionToBill({ txnId: first, itemId: item });
    unlinkItemTransaction(item, first, HOUSEHOLD_VIEWER);
    expect(paidState(installment).unlinkedAt).not.toBeNull();

    const second = txn(account, user, '2026-09-14');
    const result = assignTransactionToBill({ txnId: second, itemId: item, installmentId: installment });

    expect(result.linked).toBe(true);
    expect(paidState(installment).paidTxnId).toBe(second);
    expect(paidState(installment).unlinkedAt).toBeNull();
  });
});

describe('assignTransactionToBill: what it refuses', () => {
  it('refuses an installment another transaction already paid', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const installment = addInstallment(item, '2026-09-30', 103906);
    const first = txn(account, user, '2026-09-13');
    assignTransactionToBill({ txnId: first, itemId: item });

    const second = txn(account, user, '2026-09-14');
    const result = assignTransactionToBill({ txnId: second, itemId: item, installmentId: installment });

    expect(result.linked).toBe(false);
    expect(result.reason).toMatch(/already/i);
    expect(paidState(installment).paidTxnId).toBe(first);
  });

  it('refuses a bill with nothing left unpaid, rather than inventing an installment', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const id = txn(account, user, '2026-09-13');

    const result = assignTransactionToBill({ txnId: id, itemId: item });

    expect(result.linked).toBe(false);
    expect(result.reason).toMatch(/nothing|no unpaid/i);
  });

  it('refuses an item that is not a bill', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const type = current.db.get<{ id: number }>(
      sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
          values ('Car loan', 0, 'loan', ${NOW}) returning id`,
    );
    const loan = current.db.get<{ id: number }>(
      sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
          values ('Civic', '2024-01-15', 0, ${user}, ${type.id}, ${NOW}, ${NOW}) returning id`,
    ).id;
    const id = txn(account, user, '2026-09-13');

    expect(assignTransactionToBill({ txnId: id, itemId: loan }).linked).toBe(false);
  });

  it('unlinks the way the item page already unlinks, so there is one reversal and not two', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const account = insertTestAccount(current.db, {});
    const item = seedBill('Property tax', user);
    const installment = addInstallment(item, '2026-09-30', 103906);
    const id = txn(account, user, '2026-09-13');
    assignTransactionToBill({ txnId: id, itemId: item });

    expect(unlinkItemTransaction(item, id, HOUSEHOLD_VIEWER)).toBe(true);
    expect(paidState(installment).paidAt).toBeNull();
  });
});
