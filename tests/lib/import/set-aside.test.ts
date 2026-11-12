import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { setAsideRows } from '@/db/schema';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { runEngine } from '@/lib/categorize/engine';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { resetImportHooks } from '@/lib/import/hooks';
import {
  dismissSetAsideRow,
  listWaitingSetAside,
  releaseSetAsideRow,
  waitingSetAsideCount,
} from '@/lib/import/set-aside';
import { createManualTransaction } from '@/lib/transactions';
import type { Viewer } from '@/lib/auth/viewer';

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  current?.cleanup();
  current = null;
});

const AT = new Date('2026-03-12T15:00:00.000Z');

function csvRows(accountId: number, input: { date: string; description?: string; amountCents?: number }[]) {
  return computeRowHashes(
    accountId,
    input.map((row, index) => ({
      rowIndex: index,
      rawDate: row.date,
      date: row.date,
      rawDescription: row.description ?? 'MAPLE GROCER',
      amountCents: row.amountCents ?? -4217,
      balanceCents: null,
      cells: [],
    })),
  );
}

function setup() {
  current = createSeededTestDb();
  const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'admin' });
  const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(current.db, { name: 'Joint chequing', ownerUserId: alex });
  const admin: Viewer = { id: alex, role: 'admin', visibility: 'household' };
  const member: Viewer = { id: sam, role: 'member', visibility: 'household' };
  const selfViewer: Viewer = { id: sam, role: 'member', visibility: 'self' };
  const t = current;
  const handTyped = (date: string, person = alex) =>
    createManualTransaction({
      accountId: account,
      date,
      description: 'MAPLE GROCER',
      amountCents: -4217,
      categoryId: null,
      attributedUserId: person,
      userId: alex,
      actorRole: 'admin',
    });
  const count = (sql: string, ...params: unknown[]) => (t.sqlite.prepare(sql).get(...params) as { c: number }).c;
  return { t, alex, sam, account, admin, member, selfViewer, handTyped, count };
}

/** Hand-typed MAPLE GROCER on 03-09, then a statement row for it on 03-10 committed with no choice: held. */
function heldRow(s: ReturnType<typeof setup>, over: { person?: number } = {}) {
  const typed = s.handTyped('2026-03-09', over.person);
  const result = commitImport({
    accountId: s.account,
    profileId: null,
    filename: 'march.csv',
    importedBy: s.alex,
    rows: csvRows(s.account, [{ date: '2026-03-10' }]),
    errors: [],
    origin: 'csv',
    at: AT,
  });
  expect(result.rowsHeld).toBe(1);
  return { typed, result, recordId: result.heldIds[0] };
}

describe('releaseSetAsideRow (Keep both)', () => {
  it('writes what a direct import would have written, and counts it in its import', () => {
    const s = setup();
    const groceries = categoryIdByName(s.t.db, 'Groceries');
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'exact', ruleKind: 'category', categoryId: groceries,
      createdBy: s.alex, actorRole: 'admin',
    });
    upsertRuleFromCorrection({
      pattern: 'MAPLE GROCER', matchType: 'exact', ruleKind: 'attribution', categoryId: null,
      attributedUserId: s.sam, createdBy: s.alex, actorRole: 'admin',
    });
    const { result, recordId } = heldRow(s);

    // The same row imported straight into an account with nothing to match it.
    const control = insertTestAccount(s.t.db, { name: 'Spare chequing', ownerUserId: s.alex });
    const direct = commitImport({
      accountId: control,
      profileId: null,
      filename: 'control.csv',
      importedBy: s.alex,
      rows: csvRows(control, [{ date: '2026-03-10' }]),
      errors: [],
      origin: 'csv',
      at: AT,
    });
    runEngine(direct.insertedTransactionIds);

    const released = releaseSetAsideRow({ id: recordId, userId: s.alex, viewer: s.admin, at: AT });
    if (!('ok' in released)) throw new Error(released.error);

    const columns = `attributed_user_id, date, raw_description, normalized_merchant, amount_cents, category_id,
      categorization_source, is_transfer, hash_version, origin, created_by`;
    const kept = s.t.sqlite.prepare(`select ${columns}, dedup_hash, import_id from transactions where id = ?`).get(released.transactionId) as Record<string, unknown>;
    const imported = s.t.sqlite.prepare(`select ${columns} from transactions where id = ?`).get(direct.insertedTransactionIds[0]);
    expect({ ...kept, dedup_hash: undefined, import_id: undefined }).toEqual({ ...(imported as object), dedup_hash: undefined, import_id: undefined });
    expect(kept).toMatchObject({ attributed_user_id: s.sam, category_id: groceries, categorization_source: 'rule', origin: 'csv' });
    expect(kept.dedup_hash).toBe(csvRows(s.account, [{ date: '2026-03-10' }])[0].dedupHash);
    expect(kept.import_id).toBe(result.importId);

    expect(s.count('select rows_added as c from imports where id = ?', result.importId)).toBe(1);
    expect(s.count('select count(*) as c from transaction_imports where import_id = ? and transaction_id = ?', result.importId, released.transactionId)).toBe(1);
    expect(s.count('select count(*) as c from set_aside_rows')).toBe(0);
  });

  it('fails the second time', () => {
    const s = setup();
    const { recordId } = heldRow(s);
    expect(releaseSetAsideRow({ id: recordId, userId: s.alex, viewer: s.admin, at: AT })).toMatchObject({ ok: true });
    expect(releaseSetAsideRow({ id: recordId, userId: s.alex, viewer: s.admin, at: AT })).toEqual({
      error: 'That row has already been decided.',
    });
    expect(s.count(`select count(*) as c from transactions where raw_description = 'MAPLE GROCER'`)).toBe(2);
  });

  it('is refused to a self-scoped viewer, and allowed to a member on another person’s row', () => {
    const s = setup();
    const { recordId } = heldRow(s);
    expect(releaseSetAsideRow({ id: recordId, userId: s.sam, viewer: s.selfViewer, at: AT })).toHaveProperty('error');
    expect(s.count('select count(*) as c from set_aside_rows')).toBe(1);
    expect(releaseSetAsideRow({ id: recordId, userId: s.sam, viewer: s.member, at: AT })).toMatchObject({ ok: true });
  });

  it('writes one audit row', () => {
    const s = setup();
    const { recordId } = heldRow(s);
    releaseSetAsideRow({ id: recordId, userId: s.alex, viewer: s.admin, at: AT });
    expect(s.t.sqlite.prepare('select action, entity, entity_id, detail, user_id from audit_log').all()).toEqual([
      { action: 'keep_duplicate', entity: 'set_aside_rows', entity_id: recordId, detail: 'MAPLE GROCER -42.17 on 2026-03-10', user_id: s.alex },
    ]);
  });
});

describe('dismissSetAsideRow (Delete this one)', () => {
  it('leaves the row out, links an imported candidate to the import, and writes one audit row', () => {
    const s = setup();
    // The candidate is a SimpleFIN row this time, and the held row comes from a CSV.
    const synced = commitImport({
      accountId: s.account,
      profileId: null,
      filename: 'simplefin 2026-03-09 09:15',
      importedBy: s.alex,
      rows: [{ ...csvRows(s.account, [{ date: '2026-03-09' }])[0], dedupHash: '', externalId: 'sf-txn-1' }],
      errors: [],
      origin: 'simplefin',
      at: AT,
    });
    const statement = commitImport({
      accountId: s.account,
      profileId: null,
      filename: 'march.csv',
      importedBy: s.alex,
      rows: csvRows(s.account, [{ date: '2026-03-10' }]),
      errors: [],
      origin: 'csv',
      at: AT,
    });
    expect(statement.rowsHeld).toBe(1);

    expect(dismissSetAsideRow({ id: statement.heldIds[0], userId: s.alex, viewer: s.admin, at: AT })).toEqual({ ok: true });
    expect(s.t.sqlite.prepare('select state, decided_by, decided_at from set_aside_rows').get()).toEqual({
      state: 'dismissed',
      decided_by: s.alex,
      decided_at: AT.toISOString(),
    });
    expect(
      s.count('select count(*) as c from transaction_imports where import_id = ? and transaction_id = ?', statement.importId, synced.insertedTransactionIds[0]),
    ).toBe(1);
    expect(s.t.sqlite.prepare('select action, entity, entity_id, detail from audit_log').all()).toEqual([
      { action: 'dismiss_duplicate', entity: 'set_aside_rows', entity_id: statement.heldIds[0], detail: 'MAPLE GROCER -42.17 on 2026-03-10' },
    ]);
  });

  it('never links a hand-typed candidate', () => {
    const s = setup();
    const { typed, recordId } = heldRow(s);
    expect(dismissSetAsideRow({ id: recordId, userId: s.alex, viewer: s.admin, at: AT })).toEqual({ ok: true });
    expect(s.count('select count(*) as c from transaction_imports where transaction_id = ?', typed)).toBe(0);
  });

  it('is refused to a self-scoped viewer, and to a member on Sam’s row when the member is not Sam', () => {
    const s = setup();
    const taylor = insertTestUser(s.t.db, { name: 'Taylor', username: 'taylor', role: 'member' });
    const otherMember: Viewer = { id: taylor, role: 'member', visibility: 'household' };
    // The account belongs to Sam this time, so the held row is Sam's.
    s.t.sqlite.prepare('update accounts set owner_user_id = ? where id = ?').run(s.sam, s.account);
    const { recordId } = heldRow(s, { person: s.sam });
    expect(s.t.sqlite.prepare('select attributed_user_id as a from set_aside_rows').get()).toEqual({ a: s.sam });

    expect(dismissSetAsideRow({ id: recordId, userId: s.sam, viewer: s.selfViewer, at: AT })).toHaveProperty('error');
    expect(dismissSetAsideRow({ id: recordId, userId: taylor, viewer: otherMember, at: AT })).toEqual({
      error: 'That belongs to someone else in the household.',
    });
    expect(s.count(`select count(*) as c from set_aside_rows where state = 'waiting'`)).toBe(1);
    // Keep both is any household viewer's to press.
    expect(releaseSetAsideRow({ id: recordId, userId: taylor, viewer: otherMember, at: AT })).toMatchObject({ ok: true });
  });
});

describe('listWaitingSetAside and waitingSetAsideCount', () => {
  it('lists a held row with its candidate for the household, and nothing for a self-scoped viewer', () => {
    const s = setup();
    const { typed, result, recordId } = heldRow(s);
    expect(listWaitingSetAside(s.selfViewer)).toEqual([]);
    expect(listWaitingSetAside(s.admin)).toEqual([
      {
        id: recordId,
        accountId: s.account,
        accountName: 'Joint chequing',
        origin: 'csv',
        importId: result.importId,
        importFilename: 'march.csv',
        date: '2026-03-10',
        amountCents: -4217,
        rawDescription: 'MAPLE GROCER',
        attributedUserId: s.alex,
        personName: 'Alex',
        reason: 'possible_duplicate',
        createdAt: AT.toISOString(),
        candidate: { id: typed, date: '2026-03-09', description: 'MAPLE GROCER', amountCents: -4217, origin: 'manual', personName: 'Alex' },
      },
    ]);
    expect(waitingSetAsideCount()).toBe(1);
    // The count's own statement plans through the partial index, with nothing left to bind.
    const query = getDb().select({ c: sql<number>`count(*)` }).from(setAsideRows).where(sql`${setAsideRows.state} = 'waiting'`).toSQL();
    expect(query.params).toEqual([]);
    const plan = s.t.sqlite.prepare(`explain query plan ${query.sql}`).all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX set_aside_rows_waiting_idx/);
  });
});
