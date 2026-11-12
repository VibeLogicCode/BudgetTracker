import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '@/db/client';
import { createManualTransaction } from '@/lib/transactions';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

let current: TestDb | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * drizzle/0031_no_double_counting.sql. transactions.origin with a backfill, the set_aside_rows
 * table, and two nullable columns on simplefin_account_links.
 */
describe('0031: the migration records itself', () => {
  it('sits immediately after 0030 in the journal', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.find((row) => row.tag === '0031_no_double_counting')).toMatchObject({ idx: 31 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(31)).toBe(idxs.indexOf(30) + 1);
    const when = (idx: number) => journal.entries.find((entry) => entry.idx === idx)!.when;
    expect(when(31)).toBeGreaterThan(when(30));
  });
});

/** A database migrated to 0030 and no further, and the staged migrations folder that got it there. */
function buildPre0031Db(): { file: string; stageDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0031-migrations-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0031-db-'));
  tempDirs.push(stageDir, dbDir);
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith('0031_'))) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 30) }),
  );
  return { file: path.join(dbDir, 'budget.db'), stageDir };
}

describe('0031: existing transactions are labelled with how they arrived', () => {
  it('reads csv from a hash, simplefin from a sync import, ofx from any other provider id, manual otherwise', () => {
    const { file, stageDir } = buildPre0031Db();
    process.env.BUDGET_MIGRATIONS_DIR = stageDir;
    const staged = openDatabase(file);
    const s = staged.sqlite;
    s.prepare(
      `insert into users (id, name, username, password_hash, role, created_at)
       values (1, 'Alex', 'alex', 'h', 'admin', '2026-03-01T00:00:00.000Z')`,
    ).run();
    s.prepare(
      `insert into accounts (id, name, institution, type, created_at)
       values (1, 'Joint chequing', 'Maple Credit Union', 'chequing', '2026-03-01T00:00:00.000Z')`,
    ).run();
    const importRow = s.prepare(
      `insert into imports (id, account_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
       values (?, 1, ?, 1, 1, 0, 0, '2026-03-02T00:00:00.000Z')`,
    );
    importRow.run(1, 'march.csv');
    importRow.run(2, 'simplefin 2026-03-02 09:15');
    importRow.run(3, 'march.qfx');
    importRow.run(4, 'simplefin 2026-03-09 07:00');
    const txn = s.prepare(
      `insert into transactions (id, account_id, import_id, date, raw_description, normalized_merchant, amount_cents,
         dedup_hash, external_id, created_by, created_at, updated_at)
       values (?, 1, ?, '2026-03-02', ?, ?, -4217, ?, ?, 1, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z')`,
    );
    txn.run(1, 1, 'MAPLE GROCER', 'MAPLE GROCER', 'a'.repeat(64), null);
    txn.run(2, 2, 'FUEL STOP 12', 'FUEL STOP 12', null, 'sf-txn-1');
    txn.run(3, 3, 'MAPLE GROCER', 'MAPLE GROCER', null, 'FIT-0001');
    txn.run(4, null, 'CORNER CAFE', 'CORNER CAFE', null, null);
    // A synced row whose first import was undone while a later sync still covered it: its own
    // import_id is gone, and the surviving association is the evidence.
    txn.run(5, null, 'FUEL STOP 12', 'FUEL STOP 12', null, 'sf-txn-2');
    const link = s.prepare(`insert into transaction_imports (transaction_id, import_id, created_at) values (?, ?, '2026-03-02T00:00:00.000Z')`);
    link.run(1, 1);
    link.run(2, 2);
    link.run(3, 3);
    link.run(5, 4);
    s.prepare(
      `insert into simplefin_account_links (simplefin_account_id, account_id, currency, created_at)
       values ('remote-1', 1, 'CAD', '2026-03-01T00:00:00.000Z')`,
    ).run();
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.prepare('select id, origin from transactions order by id').all()).toEqual([
        { id: 1, origin: 'csv' },
        { id: 2, origin: 'simplefin' },
        { id: 3, origin: 'ofx' },
        { id: 4, origin: 'manual' },
        { id: 5, origin: 'simplefin' },
      ]);
      // The link columns arrive empty: an existing link syncs exactly as it did.
      expect(upgraded.sqlite.prepare('select sync_from, first_synced_at from simplefin_account_links').get()).toEqual({
        sync_from: null,
        first_synced_at: null,
      });
    } finally {
      upgraded.sqlite.close();
    }
  });
});

describe('0031: transactions.origin on a new database', () => {
  it('defaults a hand-typed row to manual and refuses a value outside the four', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const account = insertTestAccount(current.db, { ownerUserId: alex });
    const id = createManualTransaction({
      accountId: account,
      date: '2026-03-09',
      description: 'MAPLE GROCER',
      amountCents: -4217,
      categoryId: null,
      attributedUserId: alex,
      userId: alex,
      actorRole: 'admin',
    });
    expect(current.sqlite.prepare('select origin from transactions where id = ?').get(id)).toEqual({ origin: 'manual' });
    expect(() => current!.sqlite.prepare(`update transactions set origin = 'bank' where id = ?`).run(id)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('adds the two nullable link columns', () => {
    current = createSeededTestDb();
    const cols = current.sqlite.prepare('pragma table_info(simplefin_account_links)').all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === 'sync_from')).toMatchObject({ notnull: 0 });
    expect(cols.find((c) => c.name === 'first_synced_at')).toMatchObject({ notnull: 0 });
  });
});

describe('0031: set_aside_rows', () => {
  function insertRow(t: TestDb) {
    return t.sqlite.prepare(
      `insert into set_aside_rows (account_id, state, reason, origin, date, amount_cents, raw_description,
         dedup_hash, external_id, created_at)
       values (?, ?, ?, ?, '2026-03-10', -4217, 'MAPLE GROCER', ?, ?, '2026-03-10T00:00:00.000Z')`,
    );
  }

  it('keeps one record per key per account, by hash and by provider id', () => {
    current = createSeededTestDb();
    const one = insertTestAccount(current.db, { name: 'Joint chequing' });
    const two = insertTestAccount(current.db, { name: 'Sam Visa', type: 'credit' });
    const insert = insertRow(current);
    insert.run(one, 'waiting', 'possible_duplicate', 'csv', 'b'.repeat(64), null);
    expect(() => insert.run(one, 'dismissed', 'deleted', 'csv', 'b'.repeat(64), null)).toThrow(/UNIQUE constraint failed/);
    insert.run(one, 'waiting', 'possible_duplicate', 'simplefin', null, 'sf-txn-9');
    expect(() => insert.run(one, 'dismissed', 'possible_duplicate', 'ofx', null, 'sf-txn-9')).toThrow(/UNIQUE constraint failed/);
    // The same key on another account is another row.
    insert.run(two, 'waiting', 'possible_duplicate', 'simplefin', null, 'sf-txn-9');
  });

  it('refuses a row with neither key, and a state, reason or origin outside its set', () => {
    current = createSeededTestDb();
    const account = insertTestAccount(current.db);
    const insert = insertRow(current);
    expect(() => insert.run(account, 'waiting', 'possible_duplicate', 'csv', null, null)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(account, 'kept', 'possible_duplicate', 'csv', 'c'.repeat(64), null)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(account, 'waiting', 'other', 'csv', 'c'.repeat(64), null)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(account, 'waiting', 'possible_duplicate', 'manual', 'c'.repeat(64), null)).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('counts the waiting rows through the partial index', () => {
    current = createSeededTestDb();
    const plan = current.sqlite
      .prepare(`explain query plan select count(*) from set_aside_rows where state = 'waiting'`)
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX set_aside_rows_waiting_idx/);
  });
});
