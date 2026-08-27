import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { openDatabase } from '@/db/client';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('the migration pass runs with foreign keys disabled', () => {
  it('openDatabase turns them off around migrate() and back on after, then checks for orphans', () => {
    // Not a style preference: drizzle's SQLite dialect wraps every migration in BEGIN ... COMMIT
    // (node_modules/drizzle-orm/sqlite-core/dialect.cjs), and PRAGMA foreign_keys is a NO-OP
    // inside a transaction. A table rebuild -- 0011 is the first one this schema has needed on a
    // table that HAS children -- is therefore impossible unless the pragma is set out here.
    const source = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
    const off = source.indexOf('foreign_keys = OFF');
    const migrateCall = source.indexOf('migrate(db,');
    const on = source.indexOf('foreign_keys = ON');
    const check = source.indexOf('foreign_key_check');
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(migrateCall);
    expect(migrateCall).toBeLessThan(on);
    expect(on).toBeLessThan(check);
  });

  it('0011 contains no PRAGMA at all, because a pragma in that file would be a lie', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0011_bill_installments.sql'), 'utf8');
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(/PRAGMA/i.test(statements)).toBe(false);
  });
});

const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');
const NOW = '2026-08-24T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  // Same belt-and-braces as the 0009 and 0010 suites: the upgrade-path test below points this
  // at a temp folder. Clear it here too, so a failed assertion mid-test cannot leak the
  // override into a later test in this same process.
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

/**
 * A migrations folder holding every real migration plus one deliberately broken extra one, so
 * migrate() gets partway through a real batch and then throws -- this is what proves
 * openDatabase's error path (restore foreign_keys, close the handle, rethrow) actually runs,
 * rather than only the happy path exercised everywhere else in this file.
 */
function buildBrokenMigrationsDir(): string {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-broken-migrations-'));
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR)) {
    if (name.endsWith('.sql')) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.writeFileSync(path.join(stageDir, '0012_broken.sql'), 'THIS IS NOT VALID SQL;\n');
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({
      ...journal,
      entries: [...journal.entries, { idx: 12, version: '6', when: 1756253000000, tag: '0012_broken', breakpoints: true }],
    }),
  );
  return stageDir;
}

describe('openDatabase when migrate() itself throws', () => {
  it('restores foreign_keys=ON and closes the handle before rethrowing, and does not silently swallow the error', () => {
    // What this test does NOT do, and why: the request behind it was "assert the pragma is ON
    // afterwards on a fresh handle to the same file". That is not observable. PRAGMA foreign_keys
    // is per-connection state, never persisted to the database file, and better-sqlite3 defaults
    // every brand-new connection's foreign_keys to ON regardless of what any earlier connection
    // to the same file did or did not set -- verified directly: a fresh connection reads ON even
    // after a prior connection to the same file explicitly set it OFF and closed. So a "fresh
    // handle" assertion would pass identically whether or not openDatabase's finally block ever
    // ran, and is not a real test of anything. What actually needs proving -- that the specific
    // handle openDatabase constructed internally really had foreign_keys set back to ON, and
    // really was closed, before the throw -- is instead observed here by instrumenting
    // better-sqlite3's own prototype for the duration of this one call, since openDatabase has no
    // dependency-injection seam for the Database it constructs.
    const brokenDir = buildBrokenMigrationsDir();
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-broken-db-'));
    const file = path.join(dbDir, 'budget.db');
    process.env.BUDGET_MIGRATIONS_DIR = brokenDir;

    const calls: string[] = [];
    const originalPragma = BetterSqlite3.prototype.pragma;
    const originalClose = BetterSqlite3.prototype.close;
    BetterSqlite3.prototype.pragma = function (this: BetterSqlite3.Database, source: string, options?: unknown) {
      calls.push(`pragma:${source}`);
      return originalPragma.call(this, source, options as never);
    } as typeof originalPragma;
    BetterSqlite3.prototype.close = function (this: BetterSqlite3.Database) {
      calls.push('close');
      return originalClose.call(this);
    } as typeof originalClose;

    try {
      expect(() => openDatabase(file)).toThrow();
    } finally {
      BetterSqlite3.prototype.pragma = originalPragma;
      BetterSqlite3.prototype.close = originalClose;
      fs.rmSync(dbDir, { recursive: true, force: true });
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }

    // foreign_keys was turned OFF for the migration pass, migrate() threw partway through (the
    // broken 0012 statement), and openDatabase's finally block turned it back ON -- BEFORE
    // closing the handle and rethrowing, exactly the order the fix in src/db/client.ts requires.
    const offIdx = calls.indexOf('pragma:foreign_keys = OFF');
    const onIdx = calls.lastIndexOf('pragma:foreign_keys = ON');
    const closeIdx = calls.indexOf('close');
    expect(offIdx).toBeGreaterThan(-1);
    expect(onIdx).toBeGreaterThan(offIdx);
    expect(closeIdx).toBeGreaterThan(onIdx);
  });
});

function insertType(sqlite: TestDb['sqlite'], name: string, kind: string, isSubscription = 0): number {
  const row = sqlite
    .prepare(
      `insert into warranty_item_types (name, is_subscription, kind, created_at)
       values (?, ?, ?, ?) returning id`,
    )
    .get(name, isSubscription, kind, NOW) as { id: number };
  return row.id;
}

function insertItem(sqlite: TestDb['sqlite'], ownerUserId: number, typeId: number | null, name = 'Home'): number {
  const row = sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(name, ownerUserId, typeId, NOW, NOW) as { id: number };
  return row.id;
}

function insertInstallment(
  sqlite: TestDb['sqlite'],
  itemId: number,
  dueDate: string,
  amountCents: number,
  paidAt: string | null = null,
  paidTxnId: number | null = null,
): void {
  sqlite
    .prepare(
      `insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(itemId, dueDate, amountCents, paidAt, paidTxnId, NOW);
}

describe('the journal entry', () => {
  it('records idx 11 / when 1756166400000 / tag 0011_bill_installments', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 11);
    expect(entry).toEqual({
      idx: 11,
      version: '6',
      when: 1756166400000,
      tag: '0011_bill_installments',
      breakpoints: true,
    });
    const prior = journal.entries.find((e) => e.idx === 10);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0010 keeps its slot.
    expect(prior?.tag).toBe('0010_balances');
    expect(Math.max(...journal.entries.map((e) => e.idx))).toBe(11);
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0011_bill_installments.sql'), 'utf8');
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

describe('the warranty_item_types rebuild', () => {
  it('leaves exactly one table of that name behind, not a stray __new_ one', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(
        `select name from sqlite_master where type = 'table'
           and name like '%warranty_item_types%' order by name`,
      )
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'warranty_item_types' }]);
  });

  it('keeps the same columns, types and nullability, in the same physical order', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(warranty_item_types)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];
    // kind stays LAST: it arrived by ALTER TABLE ADD COLUMN in 0004 and src/db/schema.ts declares
    // it last for exactly that reason. A rebuild that reordered it would make the mirror lie.
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'is_subscription', 'created_at', 'kind']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('name')!.notnull).toBe(1);
    expect(byName.get('is_subscription')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
    expect(byName.get('kind')!.notnull).toBe(1);
    expect(byName.get('kind')!.dflt_value).toBe("'warranty'");
  });

  it('re-creates warranty_item_types_name_uq and it still folds case', () => {
    current = createTestDb();
    insertType(current.sqlite, 'Laptop A', 'warranty');
    expect(() => insertType(current!.sqlite, 'laptop a', 'warranty')).toThrowError(/UNIQUE constraint failed/);
  });

  it('still enforces both 0003 CHECKs', () => {
    current = createTestDb();
    expect(() => insertType(current!.sqlite, '   ', 'warranty')).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!.sqlite, 'X'.repeat(61), 'warranty')).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!.sqlite, 'Odd flag', 'warranty', 5)).toThrowError(/CHECK constraint failed/);
  });

  it("accepts 'bill' and still refuses anything outside the five", () => {
    current = createTestDb();
    for (const kind of ['warranty', 'subscription', 'contract', 'loan', 'bill']) {
      insertType(current.sqlite, `Type ${kind}`, kind, kind === 'subscription' ? 1 : 0);
    }
    const { n } = current.sqlite
      .prepare(`select count(*) as n from warranty_item_types where name like 'Type %'`)
      .get() as { n: number };
    expect(n).toBe(5);
    expect(() => insertType(current!.sqlite, 'Nonsense', 'nonsense')).toThrowError(/CHECK constraint failed/);
  });

  it('keeps warranty_items.type_id resolving after the rename, in both directions', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    const itemId = insertItem(current.sqlite, userId, typeId);
    const joined = current.sqlite
      .prepare(
        `select t.kind as kind from warranty_items i join warranty_item_types t on t.id = i.type_id where i.id = ?`,
      )
      .get(itemId) as { kind: string };
    expect(joined.kind).toBe('bill');
    // And the constraint is LIVE, not merely re-declared in text.
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
           values ('Orphan', '2024-01-15', 0, ?, 99999, ?, ?)`,
        )
        .run(userId, NOW, NOW),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  // This proves ordinary AUTOINCREMENT behaviour on the ALREADY-rebuilt table going forward --
  // it does not exercise the rebuild itself. The 0011 SQL header documents that the rebuild's
  // own INSERT ... SELECT can regress the sequence to max(id) when the all-time-highest id had
  // already been deleted before the migration ran, and that this is harmless under FK
  // enforcement. That is a one-time, migration-time property and is not asserted here.
  it('does not reuse an id after an ordinary delete, once the table has been rebuilt', () => {
    current = createTestDb();
    const first = insertType(current.sqlite, 'Alpha', 'warranty');
    current.sqlite.prepare('delete from warranty_item_types where id = ?').run(first);
    const second = insertType(current.sqlite, 'Beta', 'warranty');
    expect(second).toBeGreaterThan(first);
  });
});

describe('bill_installments', () => {
  function seedBill(): { itemId: number; userId: number } {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    return { itemId: insertItem(current.sqlite, userId, typeId), userId };
  }

  it('exists with the expected columns', () => {
    const { itemId } = seedBill();
    expect(itemId).toBeGreaterThan(0);
    const cols = (current!.sqlite.prepare('pragma table_info(bill_installments)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['id', 'item_id', 'due_date', 'amount_cents', 'paid_at', 'paid_txn_id', 'created_at']);
  });

  it('refuses a non-positive amount', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', 0)).toThrowError(/CHECK constraint failed/);
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', -1)).toThrowError(/CHECK constraint failed/);
  });

  it('refuses a malformed due date and accepts a well-formed one', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-9-30', 100)).toThrowError(/CHECK constraint failed/);
    expect(() => insertInstallment(current!.sqlite, itemId, 'soon', 100)).toThrowError(/CHECK constraint failed/);
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 100);
  });

  it('refuses a paid_txn_id with no paid_at', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', 100, null, 1)).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it('accepts many NULL paid_txn_id rows but only one row per real transaction', () => {
    const { itemId, userId } = seedBill();
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txn = current!.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, '2026-09-30', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ?, ?, ?) returning id`,
      )
      .get(accountId, userId, NOW, NOW) as { id: number };
    // Hand-marked rows carry NULL, and SQLite treats NULLs as distinct in a unique index, so
    // there is no partial index to maintain (ruling B12).
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 120000, NOW, null);
    insertInstallment(current!.sqlite, itemId, '2026-11-30', 120000, NOW, null);
    insertInstallment(current!.sqlite, itemId, '2027-01-30', 120000, NOW, txn.id);
    expect(() => insertInstallment(current!.sqlite, itemId, '2027-03-30', 120000, NOW, txn.id)).toThrowError(
      /UNIQUE constraint failed/,
    );
  });

  it('cascades away when its item is deleted', () => {
    const { itemId } = seedBill();
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 120000);
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(itemId);
    const { n } = current!.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
    expect(n).toBe(0);
  });

  it('has all three indexes', () => {
    seedBill();
    const names = (
      current!.sqlite
        .prepare(`select name from sqlite_master where type = 'index' and tbl_name = 'bill_installments' order by name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(['bill_installments_due_idx', 'bill_installments_item_idx', 'bill_installments_txn_uq']);
  });
});

/**
 * Builds a database that has only ever seen migrations 0000-0010 (a v1.11.x household database
 * the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a temp folder holding
 * copies of just those eleven files plus a journal trimmed to their entries. Reopening the SAME
 * file with the default (real, 0011-including) folder reproduces exactly what happens the first
 * time this release boots against an existing database. Same shape as migration-0009's and
 * migration-0010's own buildPreMigrationDb().
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0010-migrations-'));
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
    '0009_finish_line.sql',
    '0010_balances.sql',
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
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 10) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0010-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('a v1.11.x database (no 0011 applied) boots and migrates cleanly', () => {
  it('PRESERVES every item type and every item across the rebuild', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    const userId = insertTestUser(staged.db, { username: 'user-1' });
    // 0003 and 0004 already seed Laptop / Appliance / Subscription / Contract / Loan; add one
    // hand-made type and one item pointing at it, which is the data nobody can regenerate.
    const typeId = insertType(staged.sqlite, 'Extended contract', 'contract');
    const itemId = insertItem(staged.sqlite, userId, typeId, 'Boiler cover');
    const before = staged.sqlite.prepare('select id, name, kind from warranty_item_types order by id').all();
    // A real pre-0011 database: 'bill' is not yet an accepted kind.
    expect(() => insertType(staged.sqlite, 'Property tax', 'bill')).toThrowError(/CHECK constraint failed/);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0011
    const upgraded = openDatabase(file);
    try {
      // EVERY row survives, with the same ids. This is what makes 0011 a real rebuild rather
      // than 0010's deliberate row loss -- read 0010_balances.sql's header for why that
      // shortcut was allowed exactly once and must not be copied.
      const after = upgraded.sqlite.prepare('select id, name, kind from warranty_item_types order by id').all();
      expect(after).toEqual(before);

      // The item still resolves through its type.
      const joined = upgraded.sqlite
        .prepare(
          `select t.name as typeName from warranty_items i join warranty_item_types t on t.id = i.type_id where i.id = ?`,
        )
        .get(itemId) as { typeName: string };
      expect(joined.typeName).toBe('Extended contract');

      // openDatabase's own post-migration sweep found nothing, or it would have thrown above.
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      // ...and foreign keys are back ON for the app's own connection.
      expect(upgraded.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

      // And the whole point of the migration.
      const billTypeId = insertType(upgraded.sqlite, 'Property tax', 'bill');
      const billItemId = insertItem(upgraded.sqlite, userId, billTypeId, 'Municipal tax');
      insertInstallment(upgraded.sqlite, billItemId, '2026-09-30', 120000);
      const { n } = upgraded.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
      expect(n).toBe(1);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening an already-migrated file applies 0011 exactly once', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    const itemId = insertItem(current.sqlite, userId, typeId);
    insertInstallment(current.sqlite, itemId, '2026-09-30', 120000);
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      // A row written AFTER 0011 had already run must survive a reboot -- if the rebuild
      // re-applied, DROP TABLE would have taken the type (and, by cascade, its item and its
      // installments) with it.
      const { n } = again.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
      expect(n).toBe(1);
      const types = again.sqlite.prepare(`select count(*) as n from warranty_item_types where kind = 'bill'`).get() as {
        n: number;
      };
      expect(types.n).toBe(1);
    } finally {
      again.sqlite.close();
    }
  });
});
