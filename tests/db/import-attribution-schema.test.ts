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
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

describe('MUST-1.1: the journal entry', () => {
  it('records idx 8 / when 1755907200000 / tag 0008_import_attribution', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 8);
    expect(entry).toEqual({
      idx: 8,
      version: '6',
      when: 1755907200000,
      tag: '0008_import_attribution',
      breakpoints: true,
    });
    // One day after 0007, matching the file's existing one-per-day cadence.
    const prior = journal.entries.find((e) => e.idx === 7);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0007 keeps its slot.
    expect(prior?.tag).toBe('0007_loans');
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0008_import_attribution.sql'), 'utf8');
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

describe('MUST-1.1: fresh database shape', () => {
  it('adds is_active to import_profiles, NOT NULL, defaulting to 1', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(import_profiles)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const flag = cols.find((c) => c.name === 'is_active');
    expect(flag).toBeDefined();
    expect(flag!.type.toLowerCase()).toBe('integer');
    expect(flag!.notnull).toBe(1);
    expect(String(flag!.dflt_value)).toBe('1');

    const info = current.sqlite
      .prepare(
        `insert into import_profiles (name, institution, is_builtin, mapping, created_at)
         values ('Scotia', 'Scotiabank', 0, '{}', ?)`,
      )
      .run(now);
    const row = current.sqlite
      .prepare('select is_active from import_profiles where id = ?')
      .get(info.lastInsertRowid) as { is_active: number };
    expect(row.is_active).toBe(1);
  });

  it('creates account_card_people, empty, with the right columns', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'account_card_people'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_card_people' }]);

    const { n } = current.sqlite.prepare('select count(*) as n from account_card_people').get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(account_card_people)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'account_id', 'card_value', 'user_id', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('account_id')!.notnull).toBe(1);
    expect(byName.get('card_value')!.notnull).toBe(1);
    expect(byName.get('user_id')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the account_card_people_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'account_card_people_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_card_people_uq' }]);
  });
});

describe('MUST-1.1: account_card_people constraints', () => {
  function seedAccountAndUser(): { accountId: number; userId: number } {
    const userId = insertTestUser(current!.db, { username: 'alex' });
    const accountId = insertTestAccount(current!.db, { name: 'Joint Amex' });
    return { accountId, userId };
  }

  it('enforces the account_id foreign key', () => {
    current = createTestDb();
    const { userId } = seedAccountAndUser();
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into account_card_people (account_id, card_value, user_id, created_at) values (9999, '-1001', ?, ?)`,
        )
        .run(userId, now),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('enforces the user_id foreign key', () => {
    current = createTestDb();
    const { accountId } = seedAccountAndUser();
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into account_card_people (account_id, card_value, user_id, created_at) values (?, '-1001', 9999, ?)`,
        )
        .run(accountId, now),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('rejects a duplicate (account_id, card_value) but allows a second value or a second account', () => {
    current = createTestDb();
    const { accountId, userId } = seedAccountAndUser();
    const otherUserId = insertTestUser(current!.db, { username: 'sam' });
    const otherAccountId = insertTestAccount(current!.db, { name: 'Second Account' });
    const insert = current!.sqlite.prepare(
      `insert into account_card_people (account_id, card_value, user_id, created_at) values (?, ?, ?, ?)`,
    );
    insert.run(accountId, '-1001', userId, now);
    expect(() => insert.run(accountId, '-1001', otherUserId, now)).toThrowError(/UNIQUE constraint failed/);
    insert.run(accountId, '-1002', otherUserId, now);
    insert.run(otherAccountId, '-1001', userId, now);
    const { n } = current!.sqlite.prepare('select count(*) as n from account_card_people').get() as { n: number };
    expect(n).toBe(3);
  });
});

describe('MUST-1.2: idempotent reboot', () => {
  it('reopening an already-migrated file applies 0008 exactly once', () => {
    current = createTestDb();
    const file = current.path;
    current.sqlite.close();
    const again = openDatabase(file);
    const cols = again.sqlite.prepare('pragma table_info(import_profiles)').all() as { name: string }[];
    expect(cols.filter((c) => c.name === 'is_active')).toHaveLength(1);
    again.sqlite.close();
  });
});

/**
 * Builds a database that has only ever seen migrations 0000-0007 (a real household's
 * v1.5.x database the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a
 * temp folder holding copies of just those eight files plus a journal trimmed to their
 * entries. Reopening the SAME file with the default (real, 0008-including) migrations
 * folder reproduces exactly what happens the first time this release boots against an
 * existing database -- which is also exactly what happens after a pre-0008 backup is
 * restored, since restoreFromArtifact() only replaces the database FILE and never touches
 * schema itself; migration application happens the next time the app calls openDatabase()
 * at boot, the same call this test makes directly.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0007-migrations-'));
  for (const name of [
    '0000_init.sql',
    '0001_add_must_change_password.sql',
    '0002_warranty_tracker.sql',
    '0003_warranty_item_types.sql',
    '0004_item_type_kinds.sql',
    '0005_billing_cycle.sql',
    '0006_notifications.sql',
    '0007_loans.sql',
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
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 7) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0007-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('MUST-1.2: a v1.5.x database (no 0008 applied) boots and migrates cleanly', () => {
  it('backfills is_active = 1 on a pre-existing import_profiles row and creates account_card_people', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    // A real pre-0008 row: no is_active column exists yet on this database.
    const legacyCols = staged.sqlite.prepare('pragma table_info(import_profiles)').all() as { name: string }[];
    expect(legacyCols.some((c) => c.name === 'is_active')).toBe(false);
    staged.sqlite
      .prepare(
        `insert into import_profiles (name, institution, is_builtin, mapping, created_at)
         values ('Scotiabank', 'Scotiabank', 1, '{}', ?)`,
      )
      .run(now);
    staged.sqlite
      .prepare(`insert into users (name, username, password_hash, role, created_at) values ('A','a','h','admin',?)`)
      .run(now);
    staged.sqlite
      .prepare(`insert into accounts (name, institution, type, created_at) values ('Chq','TD','chequing',?)`)
      .run(now);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/ folder, which now includes 0008
    const upgraded = openDatabase(file);
    try {
      const cols = upgraded.sqlite.prepare('pragma table_info(import_profiles)').all() as {
        name: string;
        notnull: number;
      }[];
      const flag = cols.find((c) => c.name === 'is_active');
      expect(flag).toBeDefined();
      expect(flag!.notnull).toBe(1);
      const row = upgraded.sqlite
        .prepare(`select is_active from import_profiles where name = 'Scotiabank'`)
        .get() as { is_active: number };
      // ALTER TABLE ADD COLUMN ... DEFAULT 1 backfills every existing row.
      expect(row.is_active).toBe(1);

      const tableNames = upgraded.sqlite
        .prepare(`select name from sqlite_master where type = 'table' and name = 'account_card_people'`)
        .all() as { name: string }[];
      expect(tableNames).toEqual([{ name: 'account_card_people' }]);

      const accountId = (upgraded.sqlite.prepare('select id from accounts limit 1').get() as { id: number }).id;
      const userId = (upgraded.sqlite.prepare('select id from users limit 1').get() as { id: number }).id;
      upgraded.sqlite
        .prepare(
          `insert into account_card_people (account_id, card_value, user_id, created_at) values (?, ?, ?, ?)`,
        )
        .run(accountId, '-1001', userId, now);
      const { n } = upgraded.sqlite.prepare('select count(*) as n from account_card_people').get() as { n: number };
      expect(n).toBe(1);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
