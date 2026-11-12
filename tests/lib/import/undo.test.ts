import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { upsertAccountCardPerson } from '@/lib/import/card-people';
import { commitImport, previewUndoImport, undoImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { createProfile, deleteProfile, getBuiltinPreset } from '@/lib/import/presets';
import { resetImportHooks, setImportHooks } from '@/lib/import/hooks';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  resetImportHooks();
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
  const hashed = computeRowHashes(accountId, parsed.rows);
  return { db: current.db, sqlite: current.sqlite, userId, accountId, hashed };
}

describe('undoImport with no overlap', () => {
  it('deletes every row the import created', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });

    expect(previewUndoImport(result.importId)).toMatchObject({ importId: result.importId, willDelete: 9, willKeep: 0 });
    // v1.12.1 (item AE / MON-5): td-chequing.csv's 9 rows span 7 unique statement dates, all
    // written as 'csv' snapshots on commit (TD Chequing/Debit's balanceCol is mapped) -- a full
    // undo removes all 7.
    expect(undoImport(result.importId)).toEqual({ deleted: 9, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 7 });

    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number }).c).toBe(0);
  });
});

describe('undoImport after the import’s profile has been deleted', () => {
  it('still deletes every row, even though imports.profile_id was nulled by deleteProfile', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const profileId = createProfile({
      name: 'Custom TD',
      institution: 'TD Canada Trust',
      mapping: getBuiltinPreset('TD Chequing/Debit'),
    });
    const result = commitImport({ accountId, profileId, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });

    // undoImport keys off transaction_imports / imports.id, never imports.profile_id —
    // deleting the profile that created an import must not strand its undo button.
    deleteProfile(profileId);
    expect((sqlite.prepare('select profile_id from imports where id = ?').get(result.importId) as { profile_id: number | null }).profile_id).toBeNull();

    expect(previewUndoImport(result.importId)).toMatchObject({ importId: result.importId, willDelete: 9, willKeep: 0 });
    // Same fixture, same 7 dates -- deleting the profile doesn't change what got written.
    expect(undoImport(result.importId)).toEqual({ deleted: 9, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 7 });

    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number }).c).toBe(0);
  });
});

describe('undoImport with overlapping imports — the sole-association rule', () => {
  it('keeps rows that another import also covers and deletes only the exclusive ones', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    // rows 3 and 4 are shared between the two imports
    expect(previewUndoImport(first.importId)).toMatchObject({ importId: first.importId, willDelete: 3, willKeep: 2 });
    // The 3 sole rows are the first three statement dates (2026-03-02/03/04), each its own
    // csv snapshot -- the shared 2026-03-05 snapshot (written by both commits) is not one of them.
    expect(undoImport(first.importId)).toEqual({ deleted: 3, kept: 2, loanLinksReversed: 0, snapshotsDeleted: 3 });

    const remaining = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;
    expect(remaining).toBe(6);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(1);
    expect((sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(second.importId) as { c: number }).c).toBe(6);
  });

  it('clears the denormalized import_id on kept rows', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });
    undoImport(first.importId);
    const dangling = sqlite.prepare('select count(*) as c from transactions where import_id = ?').get(first.importId) as { c: number };
    expect(dangling.c).toBe(0);
  });

  it('undoing the second import afterwards removes the rest', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });
    undoImport(first.importId);
    // Undoing the first left the four remaining dates' csv snapshots in place (2026-03-05,
    // written by the second commit too; 06, 07, 09, written only by the second commit) -- all
    // four now belong solely to the second import.
    expect(undoImport(second.importId)).toEqual({ deleted: 6, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 4 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('a full re-import of the same file makes every row shared, so undo deletes nothing', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    commitImport({ accountId, profileId: null, filename: 'td-again.csv', importedBy: userId, rows: hashed, errors: [] });
    expect(previewUndoImport(first.importId)).toMatchObject({ importId: first.importId, willDelete: 0, willKeep: 9 });
    // Nothing is sole, so the snapshot-delete block never runs -- the 7 csv snapshots both
    // commits wrote are left alone, same as every transaction row.
    expect(undoImport(first.importId)).toEqual({ deleted: 0, kept: 9, loanLinksReversed: 0, snapshotsDeleted: 0 });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(9);
  });

  it('undoing the duplicate-hitting import leaves the original owning import untouched', () => {
    const { sqlite, userId, accountId, hashed } = setup();
    // A creates T (T.import_id = A's id).
    const first = commitImport({ accountId, profileId: null, filename: 'a.csv', importedBy: userId, rows: hashed.slice(0, 1), errors: [] });
    // B duplicate-hits T: no new row, but an association to B is recorded.
    const second = commitImport({ accountId, profileId: null, filename: 'b.csv', importedBy: userId, rows: hashed.slice(0, 1), errors: [] });
    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(1);
    const transactionId = first.insertedTransactionIds[0];

    // Undoing B: T is shared (associated with both A and B), so it survives, and nothing is
    // sole -- the snapshot-delete block never runs.
    expect(undoImport(second.importId)).toEqual({ deleted: 0, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 0 });

    const row = sqlite.prepare('select import_id from transactions where id = ?').get(transactionId) as { import_id: number | null };
    expect(row.import_id).toBe(first.importId);

    const surviving = sqlite
      .prepare('select count(*) as c from transaction_imports where transaction_id = ? and import_id = ?')
      .get(transactionId, first.importId) as { c: number };
    expect(surviving.c).toBe(1);

    const importAStillExists = sqlite.prepare('select count(*) as c from imports where id = ?').get(first.importId) as { c: number };
    expect(importAStillExists.c).toBe(1);
  });
});

describe('Bayes reversal on undo', () => {
  it('untrains only the deleted rows that had reached source = manual', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'METRO PLUS' where id = ${ids[0]}`);
    db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'bayes', normalized_merchant = 'TIM HORTONS' where id = ${ids[1]}`);
    db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'rule', normalized_merchant = 'STARBUCKS' where id = ${ids[2]}`);

    undoImport(result.importId);

    expect(untrain).toHaveBeenCalledTimes(1);
    expect(untrain).toHaveBeenCalledWith(['METRO', 'PLUS'], groceries);
  });

  it('does not untrain rows that survive because another import covers them', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });

    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    const groceries = categoryIdByName(db, 'Groceries');
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    // ids[4] is shared between the two imports; ids[0] is exclusive to the first.
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'SHARED ROW' where id = ${ids[4]}`);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual', normalized_merchant = 'EXCLUSIVE ROW' where id = ${ids[0]}`);

    undoImport(first.importId);

    expect(untrain).toHaveBeenCalledTimes(1);
    expect(untrain).toHaveBeenCalledWith(['EXCLUSIVE', 'ROW'], groceries);
  });

  it('skips manual rows whose category is NULL', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const untrain = vi.fn();
    setImportHooks({ untrain, tokenize: (value) => value.split(' ') });
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    db.run(sql`update transactions set category_id = null, categorization_source = 'manual' where id = ${ids[0]}`);
    undoImport(result.importId);
    expect(untrain).not.toHaveBeenCalled();
  });
});

describe('Bayes reversal through the real wiring', () => {
  it('decrements the real token counts when a confirmed row is deleted by undo', async () => {
    const { db, userId, accountId, hashed } = setup();
    const { confirmCategory } = await import('@/lib/categorize/engine');
    const { getVocabSize } = await import('@/lib/categorize/bayes');
    const groceries = categoryIdByName(db, 'Groceries');

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const first = result.insertedTransactionIds[0];
    confirmCategory({ transactionId: first, categoryId: groceries, userId, actorRole: 'admin' });

    const before = current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    undoImport(result.importId);

    const after = current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number };
    expect(after.c).toBe(0);
    expect(getVocabSize()).toBe(0);
  });
});

// MUST-3.5, spec 2026-08-22: undo keys off transaction_imports / imports.id, which per-card
// attribution never touches — this proves it directly rather than assuming it, on a real
// per-card import (two cardholders plus an owner-fallback row).
describe('undoImport after a per-card import (MUST-3.5)', () => {
  it('deletes every row a per-card commit created, regardless of which person each row was attributed to', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: sam });

    const mapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };
    const parsed = parseCsv(fixture('amex-two-card.csv'), mapping);
    const hashed = computeRowHashes(accountId, parsed.rows);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors: parsed.errors });
    expect(result.rowsAdded).toBe(7);

    expect(previewUndoImport(result.importId)).toMatchObject({ importId: result.importId, willDelete: 7, willKeep: 0 });
    // Amex Canada's preset ships balanceCol: null (a card's stated balance is an amount owed,
    // not a running balance) -- commitImport never wrote a csv snapshot for this import at all.
    expect(undoImport(result.importId)).toEqual({ deleted: 7, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 0 });

    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from transaction_imports').get() as { c: number }).c).toBe(0);
    // The card->person map itself is an account fact, not import history — undo must
    // leave it completely alone so the next statement still attributes correctly.
    expect((current.sqlite.prepare('select count(*) as c from account_card_people where account_id = ?').get(accountId) as { c: number }).c).toBe(2);
  });

  it('a partial-overlap undo keeps the surviving rows AND their original per-person attribution intact', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: sam });

    const mapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };
    const parsed = parseCsv(fixture('amex-two-card.csv'), mapping);
    const hashed = computeRowHashes(accountId, parsed.rows);
    // Fixture rows by index: 0 alex, 1 sam, 2 alex, 3 sam, 4 alex,
    // 5 owner-fallback (unmapped suffix), 6 owner-fallback (blank). Rows 3 and 4 are the
    // overlap between the two commits below.
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: owner, mapping, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: owner, mapping, rows: hashed.slice(3), errors: [] });

    expect(previewUndoImport(first.importId)).toMatchObject({ importId: first.importId, willDelete: 3, willKeep: 2 });
    // Same Amex preset, same balanceCol: null -- no csv snapshot ever existed to delete.
    expect(undoImport(first.importId)).toEqual({ deleted: 3, kept: 2, loanLinksReversed: 0, snapshotsDeleted: 0 });

    const remaining = current.sqlite
      .prepare('select raw_description as d, attributed_user_id as a from transactions order by id')
      .all() as { d: string; a: number }[];
    expect(remaining.map((r) => r.a)).toEqual([sam, alex, owner, owner]);
    expect(remaining.map((r) => r.d)).toEqual([
      'SHOPPERS DRUG MART',
      'LCBO OTTAWA',
      'UNKNOWN CARD PURCHASE',
      'NO CARD VALUE PURCHASE',
    ]);
  });
});

// v1.60.0 item 6: the confirm lists what else an undo removes, and every count is over the rows
// that will be deleted -- so each one must equal what undoImport then actually removes or changes.
describe('previewUndoImport counts what goes with the rows', () => {
  it('reports each side effect, and undoImport then removes exactly that', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);
    const groceries = categoryIdByName(db, 'Groceries');

    // Two rows with a note, three set by hand, two renamed (one by hand, one by a rule).
    db.run(sql`update transactions set notes = 'Split the bill with Sam' where id in (${ids[0]}, ${ids[1]})`);
    db.run(sql`update transactions set notes = '   ' where id = ${ids[2]}`);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id in (${ids[0]}, ${ids[3]}, ${ids[4]})`);
    db.run(sql`update transactions set display_description = 'Maple Grocer', display_source = 'manual' where id = ${ids[5]}`);
    db.run(sql`update transactions set display_description = 'Fuel Stop', display_source = 'rename' where id = ${ids[6]}`);
    db.run(sql`update transactions set display_source = 'loan' where id = ${ids[7]}`);
    // One split row with two parts.
    db.run(sql`insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (${ids[0]}, ${groceries}, -1000, '2026-08-01T00:00:00.000Z'), (${ids[0]}, ${groceries}, -500, '2026-08-01T00:00:00.000Z')`);
    // An item bought with row 1, a loan payment and a bill installment tied to row 2.
    db.run(sql`insert into warranty_items (name, purchase_date, owner_user_id, transaction_id, created_at, updated_at) values ('Blender', '2026-08-01', ${userId}, ${ids[1]}, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`);
    const itemId = (sqlite.prepare('select id from warranty_items').get() as { id: number }).id;
    db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at) values (${ids[2]}, ${itemId}, 1000, 0, 'manual', '2026-08-01T00:00:00.000Z')`);
    db.run(sql`insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at) values (${itemId}, '2026-08-05', 1000, '2026-08-05T00:00:00.000Z', ${ids[3]}, '2026-08-01T00:00:00.000Z')`);

    const preview = previewUndoImport(result.importId);
    expect(preview.willDelete).toBe(9);
    expect(preview.alsoRemoved).toEqual({
      splitRows: 1,
      notedRows: 2,
      manualCategories: 3,
      renamedRows: 2,
      itemLinks: 1,
      loanPayments: 1,
      installments: 1,
      snapshots: 7,
    });

    const undone = undoImport(result.importId);
    expect(undone.snapshotsDeleted).toBe(preview.alsoRemoved.snapshots);
    expect((sqlite.prepare('select count(*) as c from transaction_splits').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from loan_payments').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select transaction_id as t from warranty_items').get() as { t: number | null }).t).toBeNull();
    expect(sqlite.prepare('select paid_at, paid_txn_id from bill_installments').get()).toEqual({ paid_at: null, paid_txn_id: null });
  });

  it('counts nothing for a clean import and counts only the rows that will be deleted', () => {
    const { db, sqlite, userId, accountId, hashed } = setup();
    const first = commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });
    const ids = (sqlite.prepare('select id from transactions order by id').all() as { id: number }[]).map((r) => r.id);

    expect(previewUndoImport(first.importId).alsoRemoved).toMatchObject({
      splitRows: 0,
      notedRows: 0,
      manualCategories: 0,
      renamedRows: 0,
      itemLinks: 0,
      loanPayments: 0,
      installments: 0,
    });

    // A note on a row the second import also holds survives the undo, so it is not counted.
    db.run(sql`update transactions set notes = 'kept' where id = ${ids[4]}`);
    expect(previewUndoImport(first.importId).alsoRemoved.notedRows).toBe(0);
    db.run(sql`update transactions set notes = 'goes' where id = ${ids[0]}`);
    expect(previewUndoImport(first.importId).alsoRemoved.notedRows).toBe(1);
  });
});
