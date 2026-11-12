import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { createManualTransaction, deleteTransaction, listTransactions } from '@/lib/transactions';
import { NOT_YOURS_ERROR } from '@/lib/auth/viewer';
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
 * Reported 2026-09-13: a recorded payment could not be removed. Record
 * payment on a bill writes a transaction, and until now NOTHING in the app could delete a
 * transaction -- undoImport was the only code that deleted rows, and only rows an import created.
 * So a row entered by hand, or written by Record payment, was permanent.
 */
describe('deleteTransaction: a row nobody imported', () => {
  it('deletes it', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const id = manualRow(account, user);

    const result = deleteTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    expect(result).toEqual({ ok: true });
    expect(listTransactions({}, HOUSEHOLD_VIEWER).rows.map((row) => row.id)).not.toContain(id);
  });

  it('records who deleted what, in the same audit log every other destructive action writes to', () => {
    current = createSeededTestDb();
    const user = admin();
    const account = insertTestAccount(current.db, {});
    const id = manualRow(account, user);

    deleteTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    const entry = listAudit(10).find((row) => row.entityId === id);
    expect(entry?.action).toBe('delete_transaction');
    expect(entry?.entity).toBe('transaction');
    // The description, so the log says what went rather than only that something did.
    expect(entry?.detail).toContain('Property Tax');
  });

  /**
   * v1.61.0 (owner decision 2), a deliberate change: this used to refuse every imported row and
   * point at Undo import. One wrong row from a statement can now go on its own; the next import of
   * the same statement leaves it out (the describe block below).
   */
  it('deletes a transaction that came from an import', () => {
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

    const result = deleteTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

    expect(result).toEqual({ ok: true });
    expect(listTransactions({}, HOUSEHOLD_VIEWER).rows.map((row) => row.id)).not.toContain(id);
  });

  it('refuses an id that does not exist rather than reporting a success it did not perform', () => {
    current = createSeededTestDb();
    const user = admin();
    expect(deleteTransaction({ txnId: 9999, userId: user, viewer: HOUSEHOLD_VIEWER })).toHaveProperty('error');
  });
});

/**
 * The same three reversals undoImport runs before ITS delete, for the same reasons its comments
 * give: a cascade removes a link but cannot restore a loan balance, cannot restore an installment's
 * paid_at, and cannot untrain the classifier.
 */
describe('deleteTransaction: what a delete has to undo first', () => {
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

    deleteTransaction({ txnId: txn, userId: user, viewer: HOUSEHOLD_VIEWER });

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

    deleteTransaction({ txnId: txn, userId: user, viewer: HOUSEHOLD_VIEWER });

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

    deleteTransaction({ txnId: id, userId: user, viewer: HOUSEHOLD_VIEWER });

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

    expect(deleteTransaction({ txnId, userId, viewer: HOUSEHOLD_VIEWER })).toEqual({ ok: true });

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

    deleteTransaction({ txnId, userId, viewer: HOUSEHOLD_VIEWER });

    expect(trained(groceries)).toBe(0);
  });
});

/**
 * v1.61.0 item 2a (owner decision 2). One imported row can be deleted on its own: an admin or the
 * row's person may (anyone for a shared row), a self-scoped member only rows they typed in. The
 * delete leaves a dismissed `deleted` record keyed as the row was, so importing the same statement
 * again, or the bank sync's overlap, leaves it out instead of bringing it back.
 */
describe('deleteTransaction: one imported row (v1.61.0)', () => {
  const AT = new Date('2026-03-12T15:00:00.000Z');

  function setup() {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'admin' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam', role: 'member' });
    const account = insertTestAccount(current.db, { name: 'Joint chequing' });
    const t = current;
    const statementRows = () =>
      computeRowHashes(account, [
        { rowIndex: 0, rawDate: '2026-03-09', date: '2026-03-09', rawDescription: 'MAPLE GROCER', amountCents: -4217, balanceCents: null, cells: [] },
        { rowIndex: 1, rawDate: '2026-03-11', date: '2026-03-11', rawDescription: 'FUEL STOP 12', amountCents: -6130, balanceCents: null, cells: [] },
      ]);
    const importCsv = (person: number | null = null) => {
      // Attribution follows the account's owner, so the owner is the person the rows belong to.
      t.sqlite.prepare('update accounts set owner_user_id = ? where id = ?').run(person, account);
      return commitImport({
        accountId: account,
        profileId: null,
        filename: 'march.csv',
        importedBy: alex,
        rows: statementRows(),
        errors: [],
        origin: 'csv',
        at: AT,
      });
    };
    const ids = () => (t.sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((row) => row.id);
    const records = () =>
      t.sqlite
        .prepare(
          'select state, reason, origin, dedup_hash is not null as hashed, external_id, import_id, raw_description from set_aside_rows',
        )
        .all();
    const viewer = (id: number, role: 'admin' | 'member', visibility: 'household' | 'self' = 'household') => ({ id, role, visibility });
    return { t, alex, sam, account, importCsv, ids, records, viewer };
  }

  it('an admin deletes an imported row; it leaves a record, and the same file imported again leaves it out', () => {
    const s = setup();
    const first = s.importCsv();
    const maple = first.insertedTransactionIds[0]!;

    expect(deleteTransaction({ txnId: maple, userId: s.alex, viewer: s.viewer(s.alex, 'admin'), at: AT })).toEqual({ ok: true });
    expect(s.ids()).toEqual([first.insertedTransactionIds[1]]);
    expect(s.records()).toEqual([
      {
        state: 'dismissed',
        reason: 'deleted',
        origin: 'csv',
        hashed: 1,
        external_id: null,
        import_id: first.importId,
        raw_description: 'MAPLE GROCER',
      },
    ]);

    const again = s.importCsv();
    expect(again.rowsAdded).toBe(0);
    expect(again.rowsDuplicate).toBe(1);
    expect(again.rowsSetAside).toBe(1);
    expect(s.ids()).toEqual([first.insertedTransactionIds[1]]);
  });

  it('a SimpleFIN row deleted, then the same id synced again, stays out', () => {
    const s = setup();
    const syncRow = () => [
      {
        ...computeRowHashes(s.account, [
          { rowIndex: 0, rawDate: '2026-03-09', date: '2026-03-09', rawDescription: 'FUEL STOP 12', amountCents: -6130, balanceCents: null, cells: [] },
        ])[0]!,
        dedupHash: '',
        externalId: 'sf-txn-7',
      },
    ];
    const sync = (filename: string) =>
      commitImport({ accountId: s.account, profileId: null, filename, importedBy: s.alex, rows: syncRow(), errors: [], origin: 'simplefin', at: AT });
    const first = sync('simplefin 2026-03-10 09:15');
    expect(
      deleteTransaction({ txnId: first.insertedTransactionIds[0]!, userId: s.alex, viewer: s.viewer(s.alex, 'admin'), at: AT }),
    ).toEqual({ ok: true });
    expect(s.records()).toEqual([
      {
        state: 'dismissed',
        reason: 'deleted',
        origin: 'simplefin',
        hashed: 0,
        external_id: 'sf-txn-7',
        import_id: first.importId,
        raw_description: 'FUEL STOP 12',
      },
    ]);

    const next = sync('simplefin 2026-03-11 09:15');
    expect(next.rowsAdded).toBe(0);
    expect(next.rowsSetAside).toBe(1);
    expect(s.ids()).toEqual([]);
  });

  it('names the row and its statement in the audit log', () => {
    const s = setup();
    const first = s.importCsv();
    deleteTransaction({ txnId: first.insertedTransactionIds[0]!, userId: s.alex, viewer: s.viewer(s.alex, 'admin'), at: AT });
    expect(s.t.sqlite.prepare('select action, entity, entity_id, detail, user_id from audit_log').all()).toEqual([
      {
        action: 'delete_transaction',
        entity: 'transaction',
        entity_id: first.insertedTransactionIds[0],
        detail: 'MAPLE GROCER (from march.csv)',
        user_id: s.alex,
      },
    ]);
  });

  it('a member deletes their own imported row and a shared one, and is refused another person’s', () => {
    const s = setup();
    const own = s.importCsv(s.sam);
    const member = s.viewer(s.sam, 'member');
    expect(deleteTransaction({ txnId: own.insertedTransactionIds[0]!, userId: s.sam, viewer: member, at: AT })).toEqual({ ok: true });

    // The second row is Alex's: refused, and nothing is written.
    s.t.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(s.alex, own.insertedTransactionIds[1]);
    expect(deleteTransaction({ txnId: own.insertedTransactionIds[1]!, userId: s.sam, viewer: member, at: AT })).toEqual({
      error: NOT_YOURS_ERROR,
    });
    expect(s.ids()).toEqual([own.insertedTransactionIds[1]]);
    expect(s.records()).toHaveLength(1);
    expect(s.t.sqlite.prepare('select count(*) as c from audit_log').get()).toEqual({ c: 1 });

    // Shared (nobody's): anyone in the household may.
    s.t.sqlite.prepare('update transactions set attributed_user_id = null where id = ?').run(own.insertedTransactionIds[1]);
    expect(deleteTransaction({ txnId: own.insertedTransactionIds[1]!, userId: s.sam, viewer: member, at: AT })).toEqual({ ok: true });
  });

  it('a self-scoped member is refused an imported row, even their own, and still deletes what they typed in', () => {
    const s = setup();
    const own = s.importCsv(s.sam);
    const selfViewer = s.viewer(s.sam, 'member', 'self');
    expect(deleteTransaction({ txnId: own.insertedTransactionIds[0]!, userId: s.sam, viewer: selfViewer, at: AT })).toEqual({
      error: 'Ask an admin to delete a row from a bank statement.',
    });
    expect(s.ids()).toEqual(own.insertedTransactionIds);
    expect(s.records()).toEqual([]);

    const typed = createManualTransaction({
      accountId: s.account,
      date: '2026-03-20',
      description: 'CORNER BAKERY',
      amountCents: -850,
      categoryId: null,
      attributedUserId: s.sam,
      userId: s.sam,
      actorRole: 'member',
    });
    expect(deleteTransaction({ txnId: typed, userId: s.sam, viewer: selfViewer, at: AT })).toEqual({ ok: true });
    expect(s.records()).toEqual([]);
  });

  it('refuses a self-scoped member an imported row that is not theirs with the plain wording', () => {
    const s = setup();
    const alexRows = s.importCsv(s.alex);
    expect(
      deleteTransaction({
        txnId: alexRows.insertedTransactionIds[0]!,
        userId: s.sam,
        viewer: s.viewer(s.sam, 'member', 'self'),
        at: AT,
      }),
    ).toEqual({ error: NOT_YOURS_ERROR });
  });

  it('deleting the row a dismissed duplicate matched puts that duplicate back to waiting (D5)', () => {
    const s = setup();
    const typed = createManualTransaction({
      accountId: s.account,
      date: '2026-03-08',
      description: 'MAPLE GROCER',
      amountCents: -4217,
      categoryId: null,
      attributedUserId: null,
      userId: s.alex,
      actorRole: 'admin',
    });
    // A statement whose MAPLE GROCER row was left out as a copy of the hand-typed one.
    const rows = computeRowHashes(s.account, [
      { rowIndex: 0, rawDate: '2026-03-09', date: '2026-03-09', rawDescription: 'MAPLE GROCER', amountCents: -4217, balanceCents: null, cells: [] },
    ]);
    const statement = commitImport({
      accountId: s.account,
      profileId: null,
      filename: 'march.csv',
      importedBy: s.alex,
      rows,
      errors: [],
      origin: 'csv',
      rowDecisions: new Map([[rows[0]!.dedupHash, 'skip' as const]]),
      at: AT,
    });
    expect(statement.rowsSetAside).toBe(1);
    expect(s.t.sqlite.prepare('select state, candidate_txn_id from set_aside_rows').get()).toEqual({
      state: 'dismissed',
      candidate_txn_id: typed,
    });

    expect(deleteTransaction({ txnId: typed, userId: s.alex, viewer: s.viewer(s.alex, 'admin'), at: AT })).toEqual({ ok: true });

    expect(s.t.sqlite.prepare('select state, candidate_txn_id, decided_by, decided_at from set_aside_rows').get()).toEqual({
      state: 'waiting',
      candidate_txn_id: null,
      decided_by: null,
      decided_at: null,
    });
  });
});
