import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@/db/client';
import { createTestDb, insertTestAccount, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');
const now = '2026-08-23T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  // Same belt-and-braces as migration-0009's suite: the upgrade-path test below points this at
  // a temp folder while it builds a 0009-era database. Clear it here too so a failed assertion
  // mid-test never leaks the override into a later test in this same process.
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

function insertSnapshot(
  sqlite: TestDb['sqlite'],
  accountId: number,
  date: string,
  balanceCents: number,
  source: string,
): void {
  sqlite
    .prepare(
      `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(accountId, date, balanceCents, source, now);
}

describe('the journal entry', () => {
  it('records idx 10 / when 1756080000000 / tag 0010_balances', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 10);
    expect(entry).toEqual({
      idx: 10,
      version: '6',
      when: 1756080000000,
      tag: '0010_balances',
      breakpoints: true,
    });
    // One day after 0009, matching the file's existing one-per-day cadence.
    const prior = journal.entries.find((e) => e.idx === 9);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0009 keeps its slot.
    expect(prior?.tag).toBe('0009_finish_line');
    // 10 sits immediately after 9 in idx order -- that's what this test actually needs to guard.
    // (Not "10 is the journal's last entry": that pinned the tail and broke the moment a later
    // migration appended its own entry -- e.g. 0011 -- even though 0010's own slot was untouched
    // and still exactly right. Append-only growth past 10 is expected, not a regression.)
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(10)).toBe(idxs.indexOf(9) + 1);
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0010_balances.sql'), 'utf8');
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
  it('keeps the exact same columns, types and nullability across the recreate', () => {
    current = createTestDb();
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
    expect(byName.get('created_at')!.type.toLowerCase()).toBe('text');
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('leaves exactly one table of that name behind, not a stray __new_ one', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(
        `select name from sqlite_master where type = 'table'
           and name like '%account_balance_snapshots%' order by name`,
      )
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots' }]);
  });

  it('re-creates the account_balance_snapshots_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'account_balance_snapshots_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots_uq' }]);
  });
});

describe('the widened source constraint', () => {
  it('accepts all three of simplefin, manual and csv', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    insertSnapshot(current.sqlite, accountId, '2026-08-01', 500000, 'simplefin');
    insertSnapshot(current.sqlite, accountId, '2026-08-02', 510000, 'manual');
    insertSnapshot(current.sqlite, accountId, '2026-08-03', 520000, 'csv');
    const { n } = current.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
      n: number;
    };
    expect(n).toBe(3);
  });

  it('still rejects an unknown source', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() => insertSnapshot(current!.sqlite, accountId, '2026-08-01', 100000, 'bogus')).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it("rejects 'derived', which an earlier draft of this release would have added", () => {
    // Withdrawn on 2026-08-23: balances are resolved as newest-snapshot-plus-movement
    // (src/lib/balance.ts), so nothing is ever stored as a derived row. Pinned so a future
    // session does not reintroduce the value without reopening that decision.
    current = createTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() => insertSnapshot(current!.sqlite, accountId, '2026-08-01', 100000, 'derived')).toThrowError(
      /CHECK constraint failed/,
    );
  });
});

describe('constraints that must survive the recreate', () => {
  it('rejects a duplicate (account_id, date) but allows a second date or a second account', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const otherAccountId = insertTestAccount(current.db, { name: 'Savings' });
    insertSnapshot(current.sqlite, accountId, '2026-08-01', 500000, 'csv');
    expect(() => insertSnapshot(current!.sqlite, accountId, '2026-08-01', 600000, 'manual')).toThrowError(
      /UNIQUE constraint failed/,
    );
    insertSnapshot(current.sqlite, accountId, '2026-08-02', 510000, 'csv');
    insertSnapshot(current.sqlite, otherAccountId, '2026-08-01', 250000, 'manual');
    const { n } = current.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
      n: number;
    };
    expect(n).toBe(3);
  });

  it('still cascade-deletes when its account is deleted', () => {
    // The FK is re-declared by hand in the recreate. A dropped ON DELETE cascade would leave
    // orphan snapshots behind a deleted account, and src/lib/balance.ts would anchor on them.
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    insertSnapshot(current.sqlite, accountId, '2026-08-01', 500000, 'csv');
    current.sqlite.prepare('delete from accounts where id = ?').run(accountId);
    const { n } = current.sqlite
      .prepare('select count(*) as n from account_balance_snapshots where account_id = ?')
      .get(accountId) as { n: number };
    expect(n).toBe(0);
  });

  it('rejects a snapshot for an account that does not exist', () => {
    current = createTestDb();
    expect(() => insertSnapshot(current!.sqlite, 9999, '2026-08-01', 100000, 'csv')).toThrowError(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe('idempotent reboot', () => {
  it('reopening an already-migrated file applies 0010 exactly once and does not re-drop the table', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    insertSnapshot(current.sqlite, accountId, '2026-08-01', 500000, 'csv');
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      // The row written AFTER 0010 had already run must survive a reboot -- if the migration
      // re-applied, DROP TABLE would have taken it with it.
      const { n } = again.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
        n: number;
      };
      expect(n).toBe(1);
      // And the widened constraint is still in force, not reverted.
      insertSnapshot(again.sqlite, accountId, '2026-08-02', 510000, 'csv');
      expect(() => insertSnapshot(again.sqlite, accountId, '2026-08-03', 1, 'derived')).toThrowError(
        /CHECK constraint failed/,
      );
    } finally {
      again.sqlite.close();
    }
  });
});

/**
 * Builds a database that has only ever seen migrations 0000-0009 (a v1.7.x household database
 * the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a temp folder holding
 * copies of just those ten files plus a journal trimmed to their entries. Reopening the SAME
 * file with the default (real, 0010-including) folder reproduces exactly what happens the first
 * time this release boots against an existing database. Same shape as migration-0009's own
 * buildPreMigrationDb().
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0009-migrations-'));
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
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 9) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0009-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('a v1.7.x database (no 0010 applied) boots and migrates cleanly', () => {
  it('DISCARDS pre-existing snapshot rows, by design, and leaves every other table intact', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    // A real pre-0010 database: 'csv' is not yet an accepted source.
    const accountId = insertTestAccount(staged.db, { name: 'Chequing' });
    insertSnapshot(staged.sqlite, accountId, '2026-08-01', 500000, 'manual');
    expect(() => insertSnapshot(staged.sqlite, accountId, '2026-08-02', 1, 'csv')).toThrowError(
      /CHECK constraint failed/,
    );
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0010
    const upgraded = openDatabase(file);
    try {
      // THE DELIBERATE ROW LOSS. Owner ruling 2026-08-23: dummy data only, nothing worth
      // preserving, so 0010 drops and recreates rather than doing the 12-step INSERT ... SELECT
      // rebuild. Asserted rather than merely commented so the behaviour reads as a decision.
      // See 0010_balances.sql's header for why this must not be copied once real data lands.
      const { n } = upgraded.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
        n: number;
      };
      expect(n).toBe(0);

      // The account that owned that snapshot is untouched -- only the snapshot table was rebuilt.
      const account = upgraded.sqlite.prepare('select name from accounts where id = ?').get(accountId) as {
        name: string;
      };
      expect(account.name).toBe('Chequing');

      // And the whole point of the migration: 'csv' now works, against that same account.
      insertSnapshot(upgraded.sqlite, accountId, '2026-08-02', 510000, 'csv');
      const after = upgraded.sqlite.prepare('select source from account_balance_snapshots').all() as {
        source: string;
      }[];
      expect(after).toEqual([{ source: 'csv' }]);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
