import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import type { Viewer } from '@/lib/auth/viewer';
import { getTransaction } from '@/lib/transactions';
import { INSTALLMENT_KIND_ERROR } from '@/lib/warranty/constants';
import { setBudgetCategory } from '@/lib/warranty/items';
import {
  addInstallment,
  findInstallmentItem,
  installmentStateFor,
  listInstallments,
  markInstallmentPaid,
  recordInstallmentPayment,
  removeInstallment,
  unmarkInstallmentPaid,
  unpaidInstallments,
} from '@/lib/warranty/installments';

/** This suite is entirely about the installment/payment mechanics, not visibility. */
const HOUSEHOLD: Viewer = { id: 0, role: 'admin', visibility: 'household' };

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup(): { userId: number } {
  current = createTestDb();
  return { userId: insertTestUser(current.db, { username: 'user-1' }) };
}

function typeOfKind(kind: string, name: string): number {
  const row = current!.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, ?, ?, ?) returning id`)
    .get(name, kind === 'subscription' ? 1 : 0, kind, NOW) as { id: number };
  return row.id;
}

function item(userId: number, typeId: number, name = 'Municipal tax'): number {
  const row = current!.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(name, userId, typeId, NOW, NOW) as { id: number };
  return row.id;
}

function billItem(userId: number, name = 'Municipal tax'): number {
  return item(userId, typeOfKind('bill', `Property tax ${name}`), name);
}

describe('addInstallment', () => {
  it('adds to a bill item and reads back in due_date, id order', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000, at: NOW });
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 95_000, at: NOW });
    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-09-30', '2026-11-30']);
    expect(rows.map((r) => r.amountCents)).toEqual([95_000, 120_000]);
    expect(rows.every((r) => r.paidAt === null && r.paidTxnId === null && r.paidTxn === null)).toBe(true);
  });

  it('breaks a same-date tie by id, so "earliest unpaid" is a total order', () => {
    // Two parcels, same bill, same day, different amounts -- which is exactly why there is no
    // unique index on (item_id, due_date).
    const { userId } = setup();
    const itemId = billItem(userId);
    const first = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 300_000, at: NOW });
    const second = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 10_000, at: NOW });
    expect(listInstallments(itemId, TODAY, 30).map((r) => r.id)).toEqual([first, second]);
  });

  it('refuses a non-bill item, in the DATA layer and not only in the action', () => {
    const { userId } = setup();
    for (const kind of ['warranty', 'subscription', 'contract', 'loan']) {
      const itemId = item(userId, typeOfKind(kind, `Type ${kind}`), `Item ${kind}`);
      expect(() => addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 100, at: NOW })).toThrowError(
        INSTALLMENT_KIND_ERROR,
      );
    }
  });

  it('refuses a malformed date, a non-positive amount and a date before 1970', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    expect(() => addInstallment({ itemId, dueDate: '2026-9-30', amountCents: 100, at: NOW })).toThrow();
    expect(() => addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 0, at: NOW })).toThrow();
    expect(() => addInstallment({ itemId, dueDate: '1969-12-31', amountCents: 100, at: NOW })).toThrow();
  });

  it('ALLOWS a due date in the past -- that is the case the overdue state exists for', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    addInstallment({ itemId, dueDate: '2025-03-01', amountCents: 100_000, at: NOW });
    expect(listInstallments(itemId, TODAY, 30)[0]?.state).toBe('overdue');
  });
});

describe('the derived state', () => {
  it('is paid / overdue / due_soon / scheduled, with both boundaries inclusive', () => {
    // paid wins over everything, including an overdue date.
    expect(installmentStateFor('2020-01-01', NOW, TODAY, 30)).toBe('paid');
    // strictly before today is overdue; today itself is not.
    expect(installmentStateFor('2026-08-23', null, TODAY, 30)).toBe('overdue');
    expect(installmentStateFor('2026-08-24', null, TODAY, 30)).toBe('due_soon');
    // the window's far edge is inclusive: today + 30 is still due_soon, today + 31 is not.
    expect(installmentStateFor('2026-09-23', null, TODAY, 30)).toBe('due_soon');
    expect(installmentStateFor('2026-09-24', null, TODAY, 30)).toBe('scheduled');
    // and the window is the CALLER's, so a different reader gets a different answer for the
    // same row -- that is the point, not a bug.
    expect(installmentStateFor('2026-09-24', null, TODAY, 45)).toBe('due_soon');
  });
});

describe('marking paid', () => {
  it('sets paid_at, leaves paid_txn_id NULL (ruling B13) and is idempotent', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    // Second call: the desired state already holds, so it reports success rather than failure.
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    const row = listInstallments(itemId, TODAY, 30)[0]!;
    expect(row.state).toBe('paid');
    expect(row.paidAt).toBe(NOW);
    expect(row.paidTxnId).toBeNull();
    expect(row.paidTxn).toBeNull();
  });

  it('unmark clears BOTH columns, including a rule-set link', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txn = current!.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, '2026-09-30', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ?, ?, ?) returning id`,
      )
      .get(accountId, userId, NOW, NOW) as { id: number };
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    current!.sqlite.prepare('update bill_installments set paid_at = ?, paid_txn_id = ? where id = ?').run(NOW, txn.id, id);

    const linked = listInstallments(itemId, TODAY, 30)[0]!;
    expect(linked.paidTxn).toEqual({ id: txn.id, date: '2026-09-30', description: 'CITY TAX OFFICE', amountCents: -120_000 });

    expect(unmarkInstallmentPaid(id)).toBe(true);
    const after = listInstallments(itemId, TODAY, 30)[0]!;
    expect(after.paidAt).toBeNull();
    expect(after.paidTxnId).toBeNull();
    expect(after.paidTxn).toBeNull();
    // mark -> unmark -> mark is a cycle, not a one-way door.
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    expect(listInstallments(itemId, TODAY, 30)[0]!.state).toBe('paid');
  });

  it('reports false for an installment that is not there', () => {
    setup();
    expect(markInstallmentPaid(9999, NOW)).toBe(false);
    expect(unmarkInstallmentPaid(9999)).toBe(false);
    expect(removeInstallment(9999)).toBe(false);
  });
});

describe('removeInstallment', () => {
  it('does NOT assert the kind (ruling B7): a row kept on a flipped type is still removable', () => {
    const { userId } = setup();
    const typeId = typeOfKind('bill', 'Property tax');
    const itemId = item(userId, typeId);
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract' where id = ?`).run(typeId);
    expect(removeInstallment(id)).toBe(true);
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });
});

describe('unpaidInstallments', () => {
  function seedTwoHouseholds(): { mine: number; itemId: number } {
    const { userId } = setup();
    const other = insertTestUser(current!.db, { username: 'user-2' });
    const itemId = billItem(userId);
    const theirs = billItem(other, 'Their tax');
    addInstallment({ itemId, dueDate: '2026-08-30', amountCents: 120_000, at: NOW });  // inside
    addInstallment({ itemId, dueDate: '2026-12-30', amountCents: 120_000, at: NOW });  // outside
    const paid = addInstallment({ itemId, dueDate: '2026-08-26', amountCents: 5_000, at: NOW });
    markInstallmentPaid(paid, NOW);
    addInstallment({ itemId: theirs, dueDate: '2026-08-30', amountCents: 999, at: NOW });
    return { mine: userId, itemId };
  }

  it('returns unpaid rows inside the window, with the item name and owner', () => {
    const { mine, itemId } = seedTwoHouseholds();
    const rows = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId,
      itemName: 'Municipal tax',
      ownerUserId: mine,
      dueDate: '2026-08-30',
      amountCents: 120_000,
      overdue: false,
    });
  });

  it('omits overdue rows unless asked, and marks them when asked', () => {
    const { mine, itemId } = seedTwoHouseholds();
    addInstallment({ itemId, dueDate: '2024-05-01', amountCents: 70_000, at: NOW });
    const without = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine });
    expect(without.map((r) => r.dueDate)).toEqual(['2026-08-30']);
    const withOverdue = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true, ownerUserId: mine });
    expect(withOverdue.map((r) => r.dueDate)).toEqual(['2024-05-01', '2026-08-30']);
    expect(withOverdue.map((r) => r.overdue)).toEqual([true, false]);
  });

  it('scopes to one owner when asked and spans the household when not', () => {
    const { mine } = seedTwoHouseholds();
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine })).toHaveLength(1);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false })).toHaveLength(2);
  });

  it('never returns a row whose item type is not a bill', () => {
    const { userId } = setup();
    const typeId = typeOfKind('bill', 'Property tax');
    const itemId = item(userId, typeId);
    addInstallment({ itemId, dueDate: '2026-08-30', amountCents: 120_000, at: NOW });
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toHaveLength(1);
    // Ruling B6: flipping the kind KEEPS the rows; every reader joins on kind = 'bill', so they
    // simply go quiet -- and come back when the type is flipped back.
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract' where id = ?`).run(typeId);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toEqual([]);
    current!.sqlite.prepare(`update warranty_item_types set kind = 'bill' where id = ?`).run(typeId);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toHaveLength(1);
  });
});

function setupRuleMarked(): { db: TestDb['db']; id: number } {
  const { userId } = setup();
  const itemId = billItem(userId);
  const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
  const txn = current!.sqlite
    .prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
       values (?, '2026-06-15', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ?, ?, ?) returning id`,
    )
    .get(accountId, userId, NOW, NOW) as { id: number };
  const id = addInstallment({ itemId, dueDate: '2026-06-15', amountCents: 120_000, at: NOW });
  current!.sqlite.prepare('update bill_installments set paid_at = ?, paid_txn_id = ? where id = ?').run(NOW, txn.id, id);
  return { db: current!.db, id };
}

function setupUnpaid(): { db: TestDb['db']; id: number } {
  const { userId } = setup();
  const itemId = billItem(userId);
  const id = addInstallment({ itemId, dueDate: '2026-06-15', amountCents: 120_000, at: NOW });
  return { db: current!.db, id };
}

describe('v1.12.1: unmark records the suppression, and remove is guarded (item BA / MON-3)', () => {
  it('unmark clears both columns AND stamps unlinked_at', () => {
    const { db, id } = setupRuleMarked();
    expect(unmarkInstallmentPaid(id, '2026-06-21T00:00:00.000Z')).toBe(true);

    const row = db.get<{ paidAt: string | null; paidTxn: number | null; unlinked: string | null }>(
      sql`select paid_at as paidAt, paid_txn_id as paidTxn, unlinked_at as unlinked from bill_installments where id = ${id}`,
    );
    expect(row.paidAt).toBeNull();
    expect(row.paidTxn).toBeNull();
    expect(row.unlinked).toBe('2026-06-21T00:00:00.000Z');
  });

  it('a HAND mark clears the suppression, because a deliberate act is what it protects', () => {
    const { db, id } = setupRuleMarked();
    unmarkInstallmentPaid(id, '2026-06-21T00:00:00.000Z');

    expect(markInstallmentPaid(id, '2026-06-22T00:00:00.000Z')).toBe(true);
    const row = db.get<{ paidAt: string | null; unlinked: string | null }>(
      sql`select paid_at as paidAt, unlinked_at as unlinked from bill_installments where id = ${id}`,
    );
    expect(row.paidAt).toBe('2026-06-22T00:00:00.000Z');
    expect(row.unlinked).toBeNull();
  });

  it('remove refuses a paid installment, and the row survives', () => {
    const { db, id } = setupRuleMarked();
    expect(removeInstallment(id)).toBe(false);
    expect(db.get<{ n: number }>(sql`select count(*) as n from bill_installments where id = ${id}`).n).toBe(1);
  });

  it('remove still deletes an unpaid installment', () => {
    const { db, id } = setupUnpaid();
    expect(removeInstallment(id)).toBe(true);
    expect(db.get<{ n: number }>(sql`select count(*) as n from bill_installments where id = ${id}`).n).toBe(0);
  });

  it('remove still deletes an un-marked installment, so a suppression is not a life sentence', () => {
    const { id } = setupRuleMarked();
    unmarkInstallmentPaid(id, '2026-06-21T00:00:00.000Z');
    expect(removeInstallment(id)).toBe(true);
  });
});

function categoryIdByName(name: string): number {
  const row = current!.sqlite.prepare('insert into categories (name) values (?) returning id').get(name) as {
    id: number;
  };
  return row.id;
}

function countTransactions(): number {
  return (current!.sqlite.prepare('select count(*) as n from transactions').get() as { n: number }).n;
}

function setupBillForPayment(): {
  itemId: number;
  installmentId: number;
  accountId: number;
  userId: number;
  propertyTaxCategoryId: number;
} {
  const { userId } = setup();
  const itemId = billItem(userId, 'Property tax');
  const propertyTaxCategoryId = categoryIdByName('Property Tax');
  setBudgetCategory(itemId, propertyTaxCategoryId);
  const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
  const installmentId = addInstallment({ itemId, dueDate: '2026-06-30', amountCents: 180_000, at: NOW });
  return { itemId, installmentId, accountId, userId, propertyTaxCategoryId };
}

describe('recordInstallmentPayment (ruling R8)', () => {
  it('writes one transaction and marks the installment, in one step', () => {
    const { itemId, installmentId, accountId, userId, propertyTaxCategoryId } = setupBillForPayment();

    const result = recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    expect(result).toEqual({ ok: true, transactionId: expect.any(Number), installmentId });

    const txn = getTransaction((result as { transactionId: number }).transactionId, HOUSEHOLD);
    expect(txn?.amountCents).toBe(-180000);
    expect(txn?.date).toBe('2026-08-27');
    expect(txn?.rawDescription).toBe('Property tax');
    expect(txn?.categoryId).toBe(propertyTaxCategoryId);

    const row = listInstallments(itemId, '2026-08-27', 30).find((r) => r.id === installmentId);
    expect(row?.paidAt).not.toBeNull();
    expect(row?.paidTxnId).toBe((result as { transactionId: number }).transactionId);
  });

  it('a second click writes nothing and says so', () => {
    const { installmentId, accountId, userId } = setupBillForPayment();
    recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    const before = countTransactions();
    expect(recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' })).toEqual({
      ok: false,
      reason: 'already_paid',
    });
    expect(countTransactions()).toBe(before);
  });

  it('leaves the category NULL when the bill is not linked to one', () => {
    const { itemId, installmentId, accountId, userId } = setupBillForPayment();
    setBudgetCategory(itemId, null);
    const result = recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    expect(getTransaction((result as { transactionId: number }).transactionId, HOUSEHOLD)?.categoryId).toBeNull();
  });

  it('refuses when the installment is gone', () => {
    const { accountId, userId } = setupBillForPayment();
    expect(recordInstallmentPayment({ installmentId: 999999, accountId, userId, today: '2026-08-27' })).toEqual({
      ok: false,
      reason: 'gone',
    });
  });

  it('refuses when the account id is not a positive integer', () => {
    const { installmentId, userId } = setupBillForPayment();
    expect(recordInstallmentPayment({ installmentId, accountId: 0, userId, today: '2026-08-27' })).toEqual({
      ok: false,
      reason: 'no_account',
    });
  });
});

describe('findInstallmentItem', () => {
  it('returns the item id and owner for an installment that exists', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    const installmentId = addInstallment({ itemId, dueDate: '2026-06-30', amountCents: 100, at: NOW });
    expect(findInstallmentItem(installmentId)).toEqual({ itemId, ownerUserId: userId });
  });

  it('returns null for an installment that does not exist', () => {
    setup();
    expect(findInstallmentItem(999999)).toBeNull();
  });
});
