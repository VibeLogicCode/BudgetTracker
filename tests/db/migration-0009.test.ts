import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@/db/client';
import { createTestDb, insertTestUser, insertTestAccount, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');
const now = '2026-08-22T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  // Belt and braces: every upgrade-path test below points this at a temp folder while it
  // builds a 0008-era database, then deletes it again to fall back to the real (0009-including)
  // drizzle/ folder. Clear it here too so a failed assertion mid-test never leaks the override
  // into a later, unrelated test in this same process (same idiom as migration-0004/0008's own
  // suites).
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

function insertCategory(sqlite: TestDb['sqlite'], name = 'Groceries'): number {
  const info = sqlite.prepare(`insert into categories (name) values (?)`).run(name);
  return Number(info.lastInsertRowid);
}

function insertTransaction(sqlite: TestDb['sqlite'], accountId: number, userId: number, amountCents: number): number {
  const info = sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, '2026-08-01', 'GROCERY STORE', 'GROCERY STORE', ?, ?, ?, ?)`,
    )
    .run(accountId, amountCents, userId, now, now);
  return Number(info.lastInsertRowid);
}

describe('the journal entry', () => {
  it('records idx 9 / when 1755993600000 / tag 0009_finish_line', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 9);
    expect(entry).toEqual({
      idx: 9,
      version: '6',
      when: 1755993600000,
      tag: '0009_finish_line',
      breakpoints: true,
    });
    // One day after 0008, matching the file's existing one-per-day cadence.
    const prior = journal.entries.find((e) => e.idx === 8);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0008 keeps its slot.
    expect(prior?.tag).toBe('0008_import_attribution');
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0009_finish_line.sql'), 'utf8');
    const marker = ['-->', 'statement-breakpoint'].join(' ');
    const total = sqlText.split(marker).length - 1;
    const withoutComments = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
      .join('\n');
    expect(withoutComments.split(marker).length - 1).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});

describe('fresh database shape', () => {
  it('creates transaction_splits with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'transaction_splits'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'transaction_splits' }]);

    const { n } = current.sqlite.prepare('select count(*) as n from transaction_splits').get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(transaction_splits)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'txn_id', 'category_id', 'amount_cents', 'note', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('txn_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('txn_id')!.notnull).toBe(1);
    expect(byName.get('category_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('category_id')!.notnull).toBe(1);
    expect(byName.get('amount_cents')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('amount_cents')!.notnull).toBe(1);
    expect(byName.get('note')!.type.toLowerCase()).toBe('text');
    expect(byName.get('note')!.notnull).toBe(0);
    expect(byName.get('created_at')!.type.toLowerCase()).toBe('text');
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the transaction_splits indexes', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(
        `select name from sqlite_master where type = 'index'
           and name in ('transaction_splits_txn_idx', 'transaction_splits_category_idx') order by name`,
      )
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'transaction_splits_category_idx' }, { name: 'transaction_splits_txn_idx' }]);
  });

  it('creates account_balance_snapshots with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'account_balance_snapshots'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots' }]);

    const { n } = current.sqlite
      .prepare('select count(*) as n from account_balance_snapshots')
      .get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(account_balance_snapshots)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'account_id', 'date', 'balance_cents', 'source', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('account_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('account_id')!.notnull).toBe(1);
    expect(byName.get('date')!.type.toLowerCase()).toBe('text');
    expect(byName.get('date')!.notnull).toBe(1);
    expect(byName.get('balance_cents')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('balance_cents')!.notnull).toBe(1);
    expect(byName.get('source')!.type.toLowerCase()).toBe('text');
    expect(byName.get('source')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the account_balance_snapshots_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'account_balance_snapshots_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots_uq' }]);
  });

  it('creates budget_rollover with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'budget_rollover'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'budget_rollover' }]);

    const { n } = current.sqlite.prepare('select count(*) as n from budget_rollover').get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(budget_rollover)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'scope', 'user_id', 'category_id', 'start_month', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('scope')!.type.toLowerCase()).toBe('text');
    expect(byName.get('scope')!.notnull).toBe(1);
    expect(byName.get('user_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('user_id')!.notnull).toBe(0);
    expect(byName.get('category_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('category_id')!.notnull).toBe(1);
    expect(byName.get('start_month')!.type.toLowerCase()).toBe('text');
    expect(byName.get('start_month')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the budget_rollover_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'budget_rollover_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'budget_rollover_uq' }]);
  });

  it('adds tax_relevant to categories, NOT NULL, defaulting to 0', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(categories)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const flag = cols.find((c) => c.name === 'tax_relevant');
    expect(flag).toBeDefined();
    expect(flag!.type.toLowerCase()).toBe('integer');
    expect(flag!.notnull).toBe(1);
    expect(String(flag!.dflt_value)).toBe('0');

    const info = current.sqlite.prepare(`insert into categories (name) values ('Medical')`).run();
    const row = current.sqlite
      .prepare('select tax_relevant from categories where id = ?')
      .get(info.lastInsertRowid) as { tax_relevant: number };
    expect(row.tax_relevant).toBe(0);
  });
});

describe('transaction_splits constraints', () => {
  it('cascade-deletes when its parent transaction is deleted', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const categoryId = insertCategory(current.sqlite, 'Groceries');
    const otherCategoryId = insertCategory(current.sqlite, 'Household');
    const txnId = insertTransaction(current.sqlite, accountId, userId, -10000);

    const insert = current.sqlite.prepare(
      `insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)`,
    );
    insert.run(txnId, categoryId, -7000, now);
    insert.run(txnId, otherCategoryId, -3000, now);

    const before = current.sqlite
      .prepare('select count(*) as n from transaction_splits where txn_id = ?')
      .get(txnId) as { n: number };
    expect(before.n).toBe(2);

    current.sqlite.prepare('delete from transactions where id = ?').run(txnId);

    const after = current.sqlite
      .prepare('select count(*) as n from transaction_splits where txn_id = ?')
      .get(txnId) as { n: number };
    expect(after.n).toBe(0);
  });

  it('rejects a zero amount_cents split', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const categoryId = insertCategory(current.sqlite);
    const txnId = insertTransaction(current.sqlite, accountId, userId, -5000);
    expect(() =>
      current!.sqlite
        .prepare(`insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, 0, ?)`)
        .run(txnId, categoryId, now),
    ).toThrowError(/CHECK constraint failed/);
  });
});

describe('account_balance_snapshots constraints', () => {
  it('rejects a duplicate (account_id, date) but allows a second date or a second account', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const otherAccountId = insertTestAccount(current.db, { name: 'Savings' });
    const insert = current.sqlite.prepare(
      `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at) values (?, ?, ?, ?, ?)`,
    );
    insert.run(accountId, '2026-08-01', 500000, 'simplefin', now);
    expect(() => insert.run(accountId, '2026-08-01', 600000, 'manual', now)).toThrowError(
      /UNIQUE constraint failed/,
    );
    insert.run(accountId, '2026-08-02', 510000, 'simplefin', now);
    insert.run(otherAccountId, '2026-08-01', 250000, 'manual', now);
    const { n } = current.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
      n: number;
    };
    expect(n).toBe(3);
  });

  it('rejects a source outside simplefin/manual', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at)
           values (?, '2026-08-01', 100000, 'bogus', ?)`,
        )
        .run(accountId, now),
    ).toThrowError(/CHECK constraint failed/);
  });
});

describe('budget_rollover constraints', () => {
  it('rejects a duplicate household row for the same category, but allows personal rows for different users', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite, 'Medical');
    const otherCategoryId = insertCategory(current.sqlite, 'Dental');
    const user1 = insertTestUser(current.db, { username: 'alex' });
    const user2 = insertTestUser(current.db, { username: 'sam' });
    const insert = current.sqlite.prepare(
      `insert into budget_rollover (scope, user_id, category_id, start_month, created_at) values (?, ?, ?, ?, ?)`,
    );
    insert.run('household', null, categoryId, '2026-08', now);
    // A plain UNIQUE index would let this through, because NULL != NULL in SQL.
    expect(() => insert.run('household', null, categoryId, '2026-08', now)).toThrowError(
      /UNIQUE constraint failed/,
    );
    insert.run('personal', user1, categoryId, '2026-08', now);
    insert.run('personal', user2, categoryId, '2026-08', now);
    insert.run('household', null, otherCategoryId, '2026-08', now);
    const { n } = current.sqlite.prepare('select count(*) as n from budget_rollover').get() as { n: number };
    expect(n).toBe(4);
  });

  it('rejects a scope outside household/personal', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into budget_rollover (scope, user_id, category_id, start_month, created_at)
           values ('invalid', null, ?, '2026-08', ?)`,
        )
        .run(categoryId, now),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('rejects scope/user_id combinations that break the pairing rule', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite);
    const userId = insertTestUser(current.db);
    const insert = current!.sqlite.prepare(
      `insert into budget_rollover (scope, user_id, category_id, start_month, created_at) values (?, ?, ?, '2026-08', ?)`,
    );
    // A household row must carry a NULL user_id...
    expect(() => insert.run('household', userId, categoryId, now)).toThrowError(/CHECK constraint failed/);
    // ...and a personal row must carry a non-NULL one.
    expect(() => insert.run('personal', null, categoryId, now)).toThrowError(/CHECK constraint failed/);
  });
});

/**
 * Coverage-gap fix (final pre-release review, 2026-08-22): migrations 0004 and 0008 each carry
 * an "idempotent reboot" test and an "upgrade from a pre-migration database" test; 0009 only
 * ever exercised a fresh single-shot install. This matters for a concrete, near-term reason:
 * the owner is about to purge and re-import on real data, and the restore-from-backup path
 * re-runs migrations on the next boot -- so the upgrade path below is a real first-week
 * scenario, not a hypothetical one.
 */
describe('idempotent reboot', () => {
  it('reopening an already-migrated file applies 0009 exactly once', () => {
    current = createTestDb();
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      const cols = again.sqlite.prepare('pragma table_info(categories)').all() as { name: string }[];
      expect(cols.filter((c) => c.name === 'tax_relevant')).toHaveLength(1);

      const tables = again.sqlite
        .prepare(
          `select name from sqlite_master where type = 'table'
             and name in ('transaction_splits', 'account_balance_snapshots', 'budget_rollover') order by name`,
        )
        .all() as { name: string }[];
      expect(tables).toEqual([
        { name: 'account_balance_snapshots' },
        { name: 'budget_rollover' },
        { name: 'transaction_splits' },
      ]);

      // A second CREATE TABLE or ALTER TABLE ADD COLUMN of the same objects would have thrown
      // by now ("table already exists" / "duplicate column name"); reaching here at all is
      // itself part of the proof, on top of the exact single-copy assertions above.
    } finally {
      again.sqlite.close();
    }
  });
});

/**
 * Builds a database that has only ever seen migrations 0000-0008 (a real household's v1.6.x
 * database the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a temp folder
 * holding copies of just those nine files plus a journal trimmed to their entries. Reopening
 * the SAME file with the default (real, 0009-including) migrations folder reproduces exactly
 * what happens the first time this release boots against an existing database -- which is also
 * exactly what happens after a pre-0009 backup is restored, since restoreFromArtifact() only
 * replaces the database FILE and never touches schema itself; migration application happens
 * the next time the app calls openDatabase() at boot, the same call this test makes directly.
 * Same shape as buildPreMigrationDb() in migration-0004/import-attribution-schema's own suites.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0008-migrations-'));
  for (const name of [
    '0000_init.sql',
    '0001_add_must_change_password.sql',
    '0002_warranty_tracker.sql',
    '0003_warranty_item_types.sql',
    '0004_item_type_kinds.sql',
    '0005_billing_cycle.sql',
    '0006_notifications.sql',
    '0007_loans.sql',
    '0008_import_attribution.sql',
  ]) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 8) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0008-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('a v1.6.x database (no 0009 applied) boots and migrates cleanly', () => {
  it('applies exactly 0009: creates the three new tables and categories.tax_relevant, with pre-existing rows intact', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    // A real pre-0009 row: no tax_relevant column exists yet on this database.
    const legacyCols = staged.sqlite.prepare('pragma table_info(categories)').all() as { name: string }[];
    expect(legacyCols.some((c) => c.name === 'tax_relevant')).toBe(false);
    const preExistingCategoryId = insertCategory(staged.sqlite, 'Medical');
    const userId = insertTestUser(staged.db, { username: 'alex' });
    const accountId = insertTestAccount(staged.db, { name: 'Chequing' });
    const txnId = insertTransaction(staged.sqlite, accountId, userId, -5000);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/ folder, which now includes 0009
    const upgraded = openDatabase(file);
    try {
      // categories.tax_relevant: NOT NULL, and ALTER TABLE ADD COLUMN ... DEFAULT 0 backfills
      // the pre-existing row.
      const cols = upgraded.sqlite.prepare('pragma table_info(categories)').all() as {
        name: string;
        notnull: number;
      }[];
      const flag = cols.find((c) => c.name === 'tax_relevant');
      expect(flag).toBeDefined();
      expect(flag!.notnull).toBe(1);
      const categoryRow = upgraded.sqlite
        .prepare('select tax_relevant from categories where id = ?')
        .get(preExistingCategoryId) as { tax_relevant: number };
      expect(categoryRow.tax_relevant).toBe(0);

      // The three new tables now exist, empty...
      const tableNames = upgraded.sqlite
        .prepare(
          `select name from sqlite_master where type = 'table'
             and name in ('transaction_splits', 'account_balance_snapshots', 'budget_rollover') order by name`,
        )
        .all() as { name: string }[];
      expect(tableNames).toEqual([
        { name: 'account_balance_snapshots' },
        { name: 'budget_rollover' },
        { name: 'transaction_splits' },
      ]);
      expect((upgraded.sqlite.prepare('select count(*) as n from transaction_splits').get() as { n: number }).n).toBe(0);
      expect((upgraded.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as { n: number }).n).toBe(0);
      expect((upgraded.sqlite.prepare('select count(*) as n from budget_rollover').get() as { n: number }).n).toBe(0);

      // ...and usable: a real split insert against the pre-existing transaction/category works
      // end to end, cascading correctly on the pre-existing foreign keys.
      upgraded.sqlite
        .prepare(`insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)`)
        .run(txnId, preExistingCategoryId, -5000, now);
      expect((upgraded.sqlite.prepare('select count(*) as n from transaction_splits').get() as { n: number }).n).toBe(1);

      // Pre-existing rows from before the upgrade are untouched.
      const category = upgraded.sqlite.prepare('select name from categories where id = ?').get(preExistingCategoryId) as {
        name: string;
      };
      expect(category.name).toBe('Medical');
      const txn = upgraded.sqlite.prepare('select amount_cents from transactions where id = ?').get(txnId) as {
        amount_cents: number;
      };
      expect(txn.amount_cents).toBe(-5000);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
