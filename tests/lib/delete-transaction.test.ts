import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { createManualTransaction, deleteManualTransaction, listTransactions } from '@/lib/transactions';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { listAudit } from '@/lib/audit';
import { assignTransactionToLoan } from '@/lib/loans';
import { setTransactionSplits } from '@/lib/splits';
import { confirmCategory } from '@/lib/categorize/engine';

import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function admin(): number {
  return insertTestUser(current!.db, { role: 'admin' });
}

/** An item of a given kind. `kind` lives on the item TYPE, not on the item -- the same shape
 *  seedLoan in tests/db/loan-schema.test.ts uses. */
function seedItem(kind: 'loan' | 'bill', name: string, ownerUserId: number): number {
  const now = '2026-09-01T00:00:00.000Z';
  const type = current!.db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values (${`${name} type`}, 0, ${kind}, ${now}) returning id`,
  );
  return current!.db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
        values (${name}, '2024-01-15', 0, ${ownerUserId}, ${type.id}, ${now}, ${now})
        returning id`,
  ).id;
}

function manualRow(accountId: number, userId: number, over: Partial<{ description: string; amountCents: number }> = {}) {
  return createManualTransaction({
    accountId,
    date: '2026-09-13',
    description: over.description ?? 'Property Tax 50 Henderson',
    amountCents: over.amountCents ?? -103906,
    categoryId: null,
    attributedUserId: null,
    userId,
    actorRole: 'admin',
  });
}

/**
 * The owner, 2026-09-13: "it recorded this payment now which i have no way of removing." Record
 * payment on a bill writes a transaction, and until now NOTHING in the app could delete a
 * transaction -- undoImport was the only code that deleted rows, and only rows an import created.
 * So a row entered by hand, or written by Record payment, was permanent.
 */
describe('deleteManualTransaction: a row nobody imported', () => {
  it('deletes it', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const id = manualRow(account, user);

    const result = deleteManualTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    expect(result).toEqual({ ok: true });
    expect(listTransactions({}, HOUSEHOLD_VIEWER).rows.map((row) => row.id)).not.toContain(id);
  });

  it('records who deleted what, in the same audit log every other destructive action writes to', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const id = manualRow(account, user);

    deleteManualTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    const entry = listAudit(10).find((row) => row.entityId === id);
    expect(entry?.action).toBe('delete_transaction');
    expect(entry?.entity).toBe('transaction');
    // The description, so the log says what went rather than only that something did.
    expect(entry?.detail).toContain('Property Tax');
  });

  it('refuses a transaction that came from an import, and names the way to remove that one', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const committed = commitImport({
      accountId: account,
      profileId: null,
      filename: 'march.csv',
      importedBy: user,
      rows: computeRowHashes(account, [
        {
          rowIndex: 0,
          rawDate: '2026-09-01',
          date: '2026-09-01',
          rawDescription: 'TIM HORTONS',
          amountCents: -485,
          balanceCents: null,
          cells: [],
        },
      ]),
      errors: [],
    });
    const id = committed.insertedTransactionIds[0]!;

    const result = deleteManualTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toMatch(/undo/i);
    expect(listTransactions({}, HOUSEHOLD_VIEWER).rows.map((row) => row.id)).toContain(id);
  });

  it('refuses an id that does not exist rather than reporting a success it did not perform', () => {
    current = createSeededTestDb();
    const user = admin();
    expect(deleteManualTransaction({ txnId: 9999, userId: user, viewer: HOUSEHOLD_VIEWER })).toHaveProperty('error');
  });
});

/**
 * The same three reversals undoImport runs before ITS delete, for the same reasons its comments
 * give: a cascade removes a link but cannot restore a loan balance, cannot restore an installment's
 * paid_at, and cannot untrain the classifier.
 */
describe('deleteManualTransaction: what a delete has to undo first', () => {
  it('puts a loan balance back before the row goes', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const itemId = seedItem('loan', 'Civic', user);
    current.db.run(
      sql`update warranty_items set loan_direction = 'owed', principal_cents = 100000,
          current_balance_cents = 100000 where id = ${itemId}`,
    );
    const txn = manualRow(account, user, { amountCents: -25000 });
    // The real link path, so this test proves the reversal against what the app actually writes.
    expect(assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: txn, itemId }).linked).toBe(true);
    expect(
      current.db.get<{ balance: number }>(sql`select current_balance_cents as balance from warranty_items where id = ${itemId}`)
        .balance,
    ).toBe(75000);

    deleteManualTransaction({ txnId: txn, userId: user, viewer: HOUSEHOLD_VIEWER });

    const after = current.db.get<{ balance: number }>(
      sql`select current_balance_cents as balance from warranty_items where id = ${itemId}`,
    );
    expect(after.balance).toBe(100000);
  });

  it('marks an installment unpaid again, so the bill stops claiming a payment that no longer exists', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const itemId = seedItem('bill', 'Property tax', user);
    const txn = manualRow(account, user);
    current.db.run(
      sql`insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
          values (${itemId}, '2026-09-30', 103906, '2026-09-13T00:00:00.000Z', ${txn}, '2026-09-01T00:00:00.000Z')`,
    );

    deleteManualTransaction({ txnId: txn, userId: user, viewer: HOUSEHOLD_VIEWER });

    const after = current.db.get<{ paidAt: string | null; paidTxnId: number | null }>(
      sql`select paid_at as paidAt, paid_txn_id as paidTxnId from bill_installments where item_id = ${itemId}`,
    );
    expect(after.paidAt).toBeNull();
    expect(after.paidTxnId).toBeNull();
  });

  it('untrains the classifier for a row somebody had confirmed', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const groceries = categoryIdByName(current.db, 'Groceries');
    const id = createManualTransaction({
      accountId: account,
      date: '2026-09-13',
      description: 'SOBEYS 123',
      amountCents: -4000,
      categoryId: groceries,
      attributedUserId: null,
      userId: user,
      actorRole: 'admin',
    });
    const trained = current.db.get<{ c: number }>(sql`select count(*) as c from bayes_tokens`).c;
    expect(trained).toBeGreaterThan(0);

    deleteManualTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    const after = current.db.get<{ total: number }>(
      sql`select coalesce(sum(count), 0) as total from bayes_tokens`,
    ).total;
    expect(after).toBe(0);
  });
});

/**
 * Review E3. clearCategory refuses to untrain a split parent, and its docblock says why: a split
 * row's category is not what the parts say it is, so unlearning the parent's tokens teaches Bayes
 * the opposite of what happened. The delete path ran the same untrain with no such guard.
 */
describe('E3: deleting a split parent does not untrain Bayes', () => {
  function splitParent(): { txnId: number; userId: number; groceries: number } {
    current = createSeededTestDb();
    const userId = admin();
    const accountId = insertTestAccount(current.db);
    const groceries = categoryIdByName(current.db, 'Groceries');
    const txnId = createManualTransaction({
      accountId,
      date: '2026-09-13',
      description: 'COSTCO WHOLESALE',
      amountCents: -20_000,
      categoryId: null,
      attributedUserId: null,
      userId,
      actorRole: 'admin',
    });
    // Confirming is what TRAINS Bayes and stamps the row 'manual' -- the two conditions the
    // delete path's untrain reads. Splitting afterwards is the ordinary order: a person files the
    // row, then breaks it up.
    confirmCategory({ transactionId: txnId, categoryId: groceries, userId, actorRole: 'admin' });
    setTransactionSplits({
      txnId,
      parts: [
        { categoryId: groceries, amountCents: -15_000, note: null },
        { categoryId: categoryIdByName(current.db, 'Restaurants'), amountCents: -5_000, note: null },
      ],
      userId,
    });
    return { txnId, userId, groceries };
  }

  /** What Bayes actually holds for this merchant: one row per token per category. */
  const trained = (categoryId: number): number =>
    (
      current!.sqlite
        .prepare("select coalesce(sum(count), 0) as n from bayes_tokens where token = 'COSTCO' and category_id = ?")
        .get(categoryId) as { n: number }
    ).n;

  it('leaves the merchant trained exactly as it was before the delete', () => {
    const { txnId, userId, groceries } = splitParent();
    const before = trained(groceries);
    expect(before).toBeGreaterThan(0);

    expect(deleteManualTransaction({ txnId, userId, viewer: HOUSEHOLD_VIEWER })).toEqual({ ok: true });

    expect(trained(groceries)).toBe(before);
  });

  /** An ordinary manual row is still untrained, which is the behaviour this guard narrows. */
  it('still untrains a manual row with no splits', () => {
    current = createSeededTestDb();
    const userId = admin();
    const accountId = insertTestAccount(current.db);
    const groceries = categoryIdByName(current.db, 'Groceries');
    const txnId = createManualTransaction({
      accountId,
      date: '2026-09-13',
      description: 'COSTCO WHOLESALE',
      amountCents: -20_000,
      categoryId: null,
      attributedUserId: null,
      userId,
      actorRole: 'admin',
    });
    confirmCategory({ transactionId: txnId, categoryId: groceries, userId, actorRole: 'admin' });
    expect(trained(groceries)).toBeGreaterThan(0);

    deleteManualTransaction({ txnId, userId, viewer: HOUSEHOLD_VIEWER });

    expect(trained(groceries)).toBe(0);
  });
});
