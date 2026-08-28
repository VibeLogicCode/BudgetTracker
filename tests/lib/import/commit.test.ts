import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { upsertAccountCardPerson } from '@/lib/import/card-people';
import { commitImport, listImportHistory, undoImport } from '@/lib/import/commit';
import { computeRowHashes, DEDUP_HASH_VERSION } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import { resetImportHooks } from '@/lib/import/hooks';
import { recordBalanceSnapshot } from '@/lib/networth';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  current?.cleanup();
  current = null;
});

function tdRows(accountId: number) {
  const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
  return { hashed: computeRowHashes(accountId, parsed.rows), errors: parsed.errors };
}

describe('commitImport', () => {
  it('inserts every non-duplicate row and reports the counts', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed, errors } = tdRows(accountId);

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors });

    expect(result.rowsAdded).toBe(9);
    expect(result.rowsDuplicate).toBe(0);
    expect(result.rowsError).toBe(0);
    expect(result.insertedTransactionIds).toHaveLength(9);
    const count = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(count.c).toBe(9);
  });

  it('stores date, raw description, amount, dedup hash and hash version', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed, errors } = tdRows(accountId);
    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors });

    const row = current.sqlite
      .prepare('select date, raw_description, normalized_merchant, amount_cents, dedup_hash, hash_version, categorization_source, is_transfer, category_id from transactions order by id limit 1')
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      date: '2026-03-02',
      raw_description: 'POS PURCHASE       TIM HORTONS #4821 TORONTO ON',
      amount_cents: -485,
      hash_version: 1,
      categorization_source: 'none',
      is_transfer: 0,
      category_id: null,
    });
    expect(row.dedup_hash).toBe(hashed[0].dedupHash);
    expect(row.normalized_merchant).toBe('TIM HORTONS');
  });

  it('defaults attribution to the account owner and leaves joint accounts unattributed', () => {
    current = createSeededTestDb();
    const alice = insertTestUser(current.db, { username: 'alice' });
    const personal = insertTestAccount(current.db, { name: 'Alice Visa', type: 'credit', ownerUserId: alice });
    const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });

    const personalRows = tdRows(personal);
    commitImport({ accountId: personal, profileId: null, filename: 'a.csv', importedBy: alice, rows: personalRows.hashed, errors: [] });
    const jointRows = tdRows(joint);
    commitImport({ accountId: joint, profileId: null, filename: 'b.csv', importedBy: alice, rows: jointRows.hashed, errors: [] });

    const personalAttribution = current.sqlite.prepare('select distinct attributed_user_id as a from transactions where account_id = ?').all(personal);
    const jointAttribution = current.sqlite.prepare('select distinct attributed_user_id as a from transactions where account_id = ?').all(joint);
    expect(personalAttribution).toEqual([{ a: alice }]);
    expect(jointAttribution).toEqual([{ a: null }]);
  });

  it('records an association for every inserted row', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });

    const links = current.sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(result.importId) as { c: number };
    expect(links.c).toBe(9);
  });

  it('records an association for DUPLICATE rows too, and inserts nothing new', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);

    const first = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'td-again.csv', importedBy: userId, rows: hashed, errors: [] });

    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(9);
    expect(second.duplicateTransactionIds.sort()).toEqual(first.insertedTransactionIds.sort());

    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(total.c).toBe(9);
    const secondLinks = current.sqlite.prepare('select count(*) as c from transaction_imports where import_id = ?').get(second.importId) as { c: number };
    expect(secondLinks.c).toBe(9);
  });

  it('handles a partially overlapping second export', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);

    commitImport({ accountId, profileId: null, filename: 'part1.csv', importedBy: userId, rows: hashed.slice(0, 5), errors: [] });
    const second = commitImport({ accountId, profileId: null, filename: 'part2.csv', importedBy: userId, rows: hashed.slice(3), errors: [] });

    expect(second.rowsDuplicate).toBe(2);
    expect(second.rowsAdded).toBe(4);
    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(total.c).toBe(9);
  });

  it('creates the imports row with the filename, importer and counts', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = insertTestAccount(current.db);
    // mint-like-edge-cases.csv is an untouched fixture whose dates are still MM/DD/YYYY;
    // this test is about row-error propagation into imports, not the real TD Chequing
    // date format, so it's overridden explicitly here rather than regenerating the fixture.
    const parsed = parseCsv(fixture('mint-like-edge-cases.csv'), { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' });
    const hashed = computeRowHashes(accountId, parsed.rows);

    const result = commitImport({ accountId, profileId: null, filename: 'edge.csv', importedBy: userId, rows: hashed, errors: parsed.errors });

    const row = current.sqlite.prepare('select * from imports where id = ?').get(result.importId) as Record<string, unknown>;
    expect(row).toMatchObject({ filename: 'edge.csv', imported_by: userId, rows_added: 3, rows_duplicate: 0, rows_error: 5 });

    const history = listImportHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ filename: 'edge.csv', importedByName: 'Alice', rowsAdded: 3, rowsError: 5 });
  });

  it('is atomic — a failure inserts nothing', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);
    const broken = [...hashed];
    broken[4] = { ...broken[4], amountCents: 'nope' as unknown as number };

    expect(() => commitImport({ accountId, profileId: null, filename: 'bad.csv', importedBy: userId, rows: broken, errors: [] })).toThrow();
    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    const importsCount = current.sqlite.prepare('select count(*) as c from imports').get() as { c: number };
    expect(total.c).toBe(0);
    expect(importsCount.c).toBe(0);
  });

  it('accepts an empty row list', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const result = commitImport({ accountId, profileId: null, filename: 'empty.csv', importedBy: userId, rows: [], errors: [] });
    expect(result).toMatchObject({ rowsAdded: 0, rowsDuplicate: 0, rowsError: 0 });
  });

  it('treats an empty-string externalId as absent — it must never enter the partial unique index as a non-null value', () => {
    // '' !== NULL in SQL: the transactions_external_id_uq partial index only
    // excludes NULL, so writing '' verbatim would let two unrelated rows
    // collide on (accountId, ''), or silently mark a CSV row as "provider-owned".
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const { hashed } = tdRows(accountId);
    const row = { ...hashed[0], externalId: '' };

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: [row], errors: [] });
    expect(result.rowsAdded).toBe(1);

    const stored = current.sqlite.prepare('select external_id, dedup_hash from transactions where id = ?').get(result.insertedTransactionIds[0]) as {
      external_id: unknown;
      dedup_hash: unknown;
    };
    expect(stored.external_id).toBeNull();
    expect(stored.dedup_hash).toBe(hashed[0].dedupHash);

    // A second row with the same empty-string externalId must dedup on its
    // dedupHash (the CSV path), not collide as if both shared a real provider id.
    const second = commitImport({ accountId, profileId: null, filename: 'td-again.csv', importedBy: userId, rows: [{ ...hashed[0], externalId: '' }], errors: [] });
    expect(second.rowsDuplicate).toBe(1);
    expect(second.rowsAdded).toBe(0);
  });

  it('mapping omitted entirely leaves attributionSummary null, same as cardCol: null', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db, { ownerUserId: userId });
    const { hashed, errors } = tdRows(accountId);
    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors });
    expect(result.attributionSummary).toBeNull();
  });
});

// v1.6.0 per-card attribution (spec 2026-08-22, MUST-3.3/3.4/SHOULD-3.6). fixtures/amex-two-card.csv
// is the real Amex Canada column layout (Card Member at index 3, Account # suffix at index 4)
// with two cardholders (ALEX MORGAN / -1001, SAM RIVERA / -1002), one card value
// present but never assigned (X UNKNOWN / -9999) and one row with no card value at all — the
// two distinct ways MUST-3.3 requires a fallback to the account owner.
function amexTwoCardRows(accountId: number, cardCol: number | null) {
  const mapping = { ...getBuiltinPreset('Amex Canada'), cardCol };
  const parsed = parseCsv(fixture('amex-two-card.csv'), mapping);
  return { mapping, hashed: computeRowHashes(accountId, parsed.rows), errors: parsed.errors };
}

describe('commitImport — per-card attribution (MUST-3.3)', () => {
  it('attributes each row to the card map entry matching Account # (index 4), falling back to the owner for an unmapped value and a blank one', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: sam });

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, 4);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors });

    expect(result.rowsAdded).toBe(7);
    const attributions = (current.sqlite.prepare('select attributed_user_id as a from transactions order by id').all() as { a: number }[]).map((r) => r.a);
    expect(attributions).toEqual([alex, sam, alex, sam, alex, owner, owner]);
  });

  it('is keyed agnostically: the same file mapped on Card Member (index 3, names) instead of Account # attributes identically', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: 'ALEX MORGAN', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: 'SAM RIVERA', userId: sam });

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, 3);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors });

    const attributions = (current.sqlite.prepare('select attributed_user_id as a from transactions order by id').all() as { a: number }[]).map((r) => r.a);
    expect(attributions).toEqual([alex, sam, alex, sam, alex, owner, owner]);
    void result;
  });

  it('cardCol: null is byte-identical to today: every row goes to the account owner regardless of any card map', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    // A card map exists, but cardCol: null must mean it is never consulted.
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, null);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors });

    const attributions = (current.sqlite.prepare('select distinct attributed_user_id as a from transactions').all() as { a: number }[]).map((r) => r.a);
    expect(attributions).toEqual([owner]);
    expect(result.attributionSummary).toBeNull();
  });

  it('falls back to the owner when cardCol points past a row shorter than that index', () => {
    current = createSeededTestDb();
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { ownerUserId: owner });
    // TD Chequing/Debit rows only ever have 4 cells (date, desc, debit, credit) — index 10
    // is out of range on every single row, which is the "index beyond the row's cell
    // count" branch of MUST-3.3, distinct from an in-range but empty/blank value.
    const mapping = { ...getBuiltinPreset('TD Chequing/Debit'), cardCol: 10 };
    const parsed = parseCsv(fixture('td-chequing.csv'), mapping);
    const hashed = computeRowHashes(accountId, parsed.rows);

    const result = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: owner, mapping, rows: hashed, errors: parsed.errors });

    expect(result.rowsAdded).toBe(9);
    const attributions = (current.sqlite.prepare('select distinct attributed_user_id as a from transactions').all() as { a: number }[]).map((r) => r.a);
    expect(attributions).toEqual([owner]);
  });

  it('loads the account card map once per commit, not once per row', async () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const cardPeople = await import('@/lib/import/card-people');
    const { vi } = await import('vitest');
    const spy = vi.spyOn(cardPeople, 'listAccountCardPeople');

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, 4);
    commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('commitImport — the dedup hash never changes with cardCol (MUST-3.4, frozen dedup.ts)', () => {
  it('DEDUP_HASH_VERSION is still 1 — a bump here would mean dedup.ts changed, which is a stop-and-ask', () => {
    expect(DEDUP_HASH_VERSION).toBe(1);
  });

  it('the same file hashes identically whether cardCol is null or set', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const withoutCardCol = amexTwoCardRows(accountId, null);
    const withCardCol = amexTwoCardRows(accountId, 4);

    expect(withCardCol.hashed.map((r) => r.dedupHash)).toEqual(withoutCardCol.hashed.map((r) => r.dedupHash));
    expect(withCardCol.hashed.every((r) => r.hashVersion === DEDUP_HASH_VERSION)).toBe(true);
  });

  it('behaviourally: committing the same file a second time under a cardCol mapping still recognizes every row as a duplicate', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const first = amexTwoCardRows(accountId, null);
    const firstResult = commitImport({ accountId, profileId: null, filename: 'a.csv', importedBy: owner, mapping: first.mapping, rows: first.hashed, errors: first.errors });
    expect(firstResult.rowsAdded).toBe(7);

    // Same underlying file, re-parsed under a mapping that NOW has cardCol set. If the
    // dedup hash inputs had drifted with cardCol, this would insert 7 new rows instead of
    // recognizing 7 duplicates — silently doubling a household's history is exactly what
    // MUST-3.4 exists to prevent.
    const second = amexTwoCardRows(accountId, 4);
    const secondResult = commitImport({ accountId, profileId: null, filename: 'a-again.csv', importedBy: owner, mapping: second.mapping, rows: second.hashed, errors: second.errors });

    expect(secondResult.rowsAdded).toBe(0);
    expect(secondResult.rowsDuplicate).toBe(7);
    const total = current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number };
    expect(total.c).toBe(7);
  });
});

describe('commitImport — attribution split in the result message (SHOULD-3.6)', () => {
  it('reports counts per person by name, with the owner-fallback bucket last and labelled "(no card match)"', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: sam });

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, 4);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors });

    expect(result.attributionSummary).toBe('3 rows to Alex, 2 rows to Sam, 2 rows to the account owner (no card match)');
  });

  it('says "unattributed" instead of "the account owner" for a joint account with no owner', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: null });
    const importer = insertTestUser(current.db, { name: 'Importer', username: 'importer' });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const { mapping, hashed, errors } = amexTwoCardRows(accountId, 4);
    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: importer, mapping, rows: hashed, errors });

    expect(result.attributionSummary).toBe('3 rows to Alex, 4 rows to unattributed (no card match)');
  });

  it('omits the fallback clause entirely when every row matched the card map', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    const owner = insertTestUser(current.db, { name: 'Account Owner', username: 'owner' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint', type: 'credit', ownerUserId: owner });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: sam });

    const mapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };
    const parsed = parseCsv(fixture('amex-two-card.csv'), mapping);
    // The fixture's first 5 rows are the mapped Alex/Sam rows; rows 5-6 are the
    // two owner-fallback rows (unmapped suffix, then blank) — sliced off here so this test
    // exercises the "zero fallback rows" branch cleanly, on its own from the mixed case
    // already covered above.
    const onlyMappedRows = parsed.rows.slice(0, 5);
    const hashed = computeRowHashes(accountId, onlyMappedRows);

    const result = commitImport({ accountId, profileId: null, filename: 'amex.csv', importedBy: owner, mapping, rows: hashed, errors: [] });

    expect(result.attributionSummary).toBe('3 rows to Alex, 2 rows to Sam');
  });
});

// v1.8.0 (spec 2026-08-23 Task 3): td-chequing.csv is the real 5-column TD export (date,
// description, debit, credit, balance) and the TD Chequing/Debit preset now ships with
// balanceCol: 4 mapped, so parsing it for these tests needs no mapping override. The fixture's
// 9 rows span 7 unique dates -- two dates (2026-03-05, 2026-03-07) each carry two rows, the
// same-date-group shape rulings R4/R5 exist for.
describe('commitImport — csv balance snapshots (Task 3, spec 2026-08-23 v1.8.0)', () => {
  function tdParsed() {
    return parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
  }

  function snapshotsFor(accountId: number): { date: string; balance_cents: number; source: string }[] {
    return current!.sqlite
      .prepare('select date, balance_cents, source from account_balance_snapshots where account_id = ? order by date')
      .all(accountId) as { date: string; balance_cents: number; source: string }[];
  }

  it('records one csv snapshot per statement date on import', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const parsed = tdParsed();
    const hashed = computeRowHashes(accountId, parsed.rows);

    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });

    // Same-date groups (2026-03-05, 2026-03-07) resolve to the LAST row of the group in file
    // order (ruling R4, this file being oldest-first per ruling R5) -- 386218 and 360248, not
    // the earlier rows' 436218 / 360733.
    expect(snapshotsFor(accountId)).toEqual([
      { date: '2026-03-02', balance_cents: 243122, source: 'csv' },
      { date: '2026-03-03', balance_cents: 230282, source: 'csv' },
      { date: '2026-03-04', balance_cents: 444849, source: 'csv' },
      { date: '2026-03-05', balance_cents: 386218, source: 'csv' },
      { date: '2026-03-06', balance_cents: 361218, source: 'csv' },
      { date: '2026-03-07', balance_cents: 360248, source: 'csv' },
      { date: '2026-03-09', balance_cents: 359153, source: 'csv' },
    ]);
  });

  it('re-importing the same file leaves one snapshot per date, not duplicates', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const parsed = tdParsed();
    const hashed = computeRowHashes(accountId, parsed.rows);

    commitImport({ accountId, profileId: null, filename: 'a.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });
    // Second call re-asserts the SAME 9 rows -- every one a duplicate this time.
    const second = commitImport({ accountId, profileId: null, filename: 'b.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });

    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(9);
    // Upsert on (account_id, date), not a second insert -- still exactly 7 rows, one per date.
    expect(snapshotsFor(accountId)).toHaveLength(7);
  });

  it('records the snapshot for a date whose transactions were all duplicates', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const parsed = tdParsed();
    const hashed = computeRowHashes(accountId, parsed.rows);
    const firstRowOnly = hashed.slice(0, 1); // 2026-03-02 only

    commitImport({ accountId, profileId: null, filename: 'a.csv', importedBy: userId, rows: firstRowOnly, errors: [], dateOrder: 'oldest_first' });
    // Clear the snapshot the FIRST commit wrote, so the second commit below -- whose one row
    // is entirely a duplicate (rowsAdded: 0) -- is the only thing that could have restored it.
    current.sqlite.prepare('delete from account_balance_snapshots where account_id = ?').run(accountId);

    const second = commitImport({ accountId, profileId: null, filename: 'b.csv', importedBy: userId, rows: firstRowOnly, errors: [], dateOrder: 'oldest_first' });
    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(1);

    // The bank's stated balance for 2026-03-02 is true whether or not this call is the first
    // time that date's transactions were seen -- an all-duplicate commit still records it.
    expect(snapshotsFor(accountId)).toEqual([{ date: '2026-03-02', balance_cents: 243122, source: 'csv' }]);
  });

  it('records nothing when the mapping has no balance column', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const mapping = { ...getBuiltinPreset('TD Chequing/Debit'), balanceCol: null };
    const parsed = parseCsv(fixture('td-chequing.csv'), mapping);
    const hashed = computeRowHashes(accountId, parsed.rows);

    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });

    expect(snapshotsFor(accountId)).toEqual([]);
  });

  it('overwrites a manual snapshot for the same date with the statement figure (ruling R3)', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    // A hand-typed guess already sits on 2026-03-02, deliberately far from the real figure.
    recordBalanceSnapshot({ accountId, date: '2026-03-02', balanceCents: 1, source: 'manual' });

    const parsed = tdParsed();
    const hashed = computeRowHashes(accountId, parsed.rows);
    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });

    const row = current.sqlite
      .prepare('select balance_cents, source from account_balance_snapshots where account_id = ? and date = ?')
      .get(accountId, '2026-03-02') as { balance_cents: number; source: string };
    expect(row).toEqual({ balance_cents: 243122, source: 'csv' });
  });

  it('does not touch balance snapshots on an unrelated account', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db, { name: 'A' });
    const otherAccountId = insertTestAccount(current.db, { name: 'B' });
    const parsed = tdParsed();
    const hashed = computeRowHashes(accountId, parsed.rows);

    commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: parsed.errors, dateOrder: parsed.dateOrder });

    expect(snapshotsFor(otherAccountId)).toEqual([]);
  });
});

describe('v1.12.1: undo removes the balance snapshots that import wrote (item AE / MON-5)', () => {
  /**
   * One row (2026-03-02, balance 243122) so `statementDate` names an unambiguous single date --
   * the same slice-to-one-row shape as the "records the snapshot for a date whose transactions
   * were all duplicates" test above, reused here as a fixture rather than re-derived per test.
   */
  function commitOneImportWithBalances() {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(accountId, parsed.rows);
    const firstRowOnly = hashed.slice(0, 1); // 2026-03-02 only
    const result = commitImport({
      accountId,
      profileId: null,
      filename: 'td.csv',
      importedBy: userId,
      rows: firstRowOnly,
      errors: [],
      dateOrder: 'oldest_first',
    });
    return { accountId, importId: result.importId, statementDate: '2026-03-02' };
  }

  /** Same fixture, but with balanceCol stripped from the mapping -- no csv snapshot is ever written. */
  function commitOneImportWithoutBalances() {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const mapping = { ...getBuiltinPreset('TD Chequing/Debit'), balanceCol: null };
    const parsed = parseCsv(fixture('td-chequing.csv'), mapping);
    const hashed = computeRowHashes(accountId, parsed.rows);
    const result = commitImport({
      accountId,
      profileId: null,
      filename: 'td.csv',
      importedBy: userId,
      rows: hashed,
      errors: parsed.errors,
      dateOrder: parsed.dateOrder,
    });
    return { accountId, importId: result.importId };
  }

  function snapshotAt(accountId: number, date: string): { balanceCents: number; source: string } | undefined {
    return current!.sqlite
      .prepare('select balance_cents as balanceCents, source from account_balance_snapshots where account_id = ? and date = ?')
      .get(accountId, date) as { balanceCents: number; source: string } | undefined;
  }

  it('deletes the csv snapshot and reports the count', () => {
    const { accountId, importId, statementDate } = commitOneImportWithBalances();
    expect(snapshotAt(accountId, statementDate)).toBeDefined();

    const result = undoImport(importId);

    expect(result.snapshotsDeleted).toBe(1);
    expect(snapshotAt(accountId, statementDate)).toBeUndefined();
  });

  it('leaves a hand-typed snapshot on the same day alone', () => {
    const { accountId, importId, statementDate } = commitOneImportWithBalances();
    // An admin corrected a DIFFERENT account's day by hand; and on this account, a manual row on a
    // day the import did not touch.
    recordBalanceSnapshot({ accountId, date: '2020-01-01', balanceCents: 999, source: 'manual' });

    undoImport(importId);

    expect(snapshotAt(accountId, '2020-01-01')?.balanceCents).toBe(999);
    expect(snapshotAt(accountId, statementDate)).toBeUndefined();
  });

  it('reports zero when the import wrote no balances at all', () => {
    const { importId } = commitOneImportWithoutBalances();
    expect(undoImport(importId).snapshotsDeleted).toBe(0);
  });
});
