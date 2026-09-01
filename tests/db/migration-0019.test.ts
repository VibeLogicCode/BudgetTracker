import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(sqlite: TestDb['sqlite'], table: string): Map<string, ColumnInfo> {
  const rows = sqlite.pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

describe('drizzle/0019_import_audit.sql', () => {
  it('adds rules_reviewed_at (text) to imports, nullable, no default', () => {
    current = createTestDb();
    const col = columns(current.sqlite, 'imports').get('rules_reviewed_at');
    expect(col, 'missing column rules_reviewed_at').toBeDefined();
    expect(col?.type.toLowerCase()).toBe('text');
    // Nullable with no default is the whole mechanism: it is what makes a fresh import UNREVIEWED
    // with no write from src/lib/import/flow.ts (see that file's own comment).
    expect(col?.notnull, 'rules_reviewed_at must be nullable').toBe(0);
    expect(col?.dflt_value, 'rules_reviewed_at must have no default').toBeNull();
  });

  it('leaves rules_reviewed_at NULL on an import inserted after it ran', () => {
    current = createTestDb();
    const { sqlite } = current;
    sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
    sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','Bank','chequing','2026-01-01T00:00:00.000Z')").run();
    sqlite
      .prepare(
        "insert into imports (account_id, profile_id, filename, imported_by, created_at) values (1, null, 'march.csv', 1, '2026-03-01T00:00:00.000Z')",
      )
      .run();
    const row = sqlite.prepare('select rules_reviewed_at from imports').get() as { rules_reviewed_at: string | null };
    expect(row.rules_reviewed_at).toBeNull();
  });

  it('adds no table and no index (the read is served by transactions_import_idx)', () => {
    current = createTestDb();
    const ddl = fs.readFileSync(path.join(root, 'drizzle/0019_import_audit.sql'), 'utf8');
    const statements = ddl
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(statements).not.toMatch(/create\s+table/i);
    // The pre-existing index this feature's per-import read leans on must still be there.
    const indexes = (current.sqlite.prepare("select name from sqlite_master where type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain('transactions_import_idx');
  });

  it('records itself in the journal, immediately after 0018, and is the newest', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0019_import_audit');
    expect(entry).toMatchObject({ idx: 19, tag: '0019_import_audit' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(19)).toBe(idxs.indexOf(18) + 1);
    // This suite now owns the "I am the newest" claim, handed on from 0018's suite the way 0017
    // handed it to 0018. Whichever migration is last owns it; nobody else asserts it.
    expect(Math.max(...idxs)).toBe(19);
  });

  it('the breakpoint marker never appears inside a comment', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0019_import_audit.sql'), 'utf8');
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

/**
 * Builds a database that has only ever seen migrations 0000-0018 -- a v1.25.x household database
 * with real import history, the moment before this release. Same staged-folder technique
 * migration-0011's, 0014's, 0016's and 0018's own suites use, and the only way to exercise the
 * backfill at all: a freshly created test DB runs every migration, 0019 included, over an EMPTY
 * imports table, so there is nothing there for it to stamp.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0019-migrations-'));
  const names = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n !== '0019_import_audit.sql');
  for (const name of names) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 18) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0019-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

function seedPreMigrationHistory(sqlite: TestDb['sqlite']): { first: number; second: number } {
  sqlite.prepare("insert into users (id, name, username, password_hash, role, created_at) values (1,'A','a','h','admin','2026-01-01T00:00:00.000Z')").run();
  sqlite.prepare("insert into accounts (id, name, institution, type, created_at) values (1,'Chq','Bank','chequing','2026-01-01T00:00:00.000Z')").run();
  const insert = sqlite.prepare(
    "insert into imports (account_id, profile_id, filename, imported_by, rows_added, created_at) values (1, null, ?, 1, ?, ?)",
  );
  const first = Number(insert.run('january.csv', 40, '2026-01-31T00:00:00.000Z').lastInsertRowid);
  const second = Number(insert.run('february.csv', 38, '2026-02-28T00:00:00.000Z').lastInsertRowid);
  return { first, second };
}

describe('a v1.25.x database (0018 applied, 0019 not) upgrades cleanly', () => {
  it('stamps every import that predates it as already reviewed', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    const { first, second } = seedPreMigrationHistory(staged.sqlite);
    expect(staged.sqlite.pragma('table_info(imports)') as ColumnInfo[]).not.toContainEqual(
      expect.objectContaining({ name: 'rules_reviewed_at' }),
    );
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0019
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite.prepare('select id, rules_reviewed_at from imports order by id').all() as {
        id: number;
        rules_reviewed_at: string | null;
      }[];
      const stampOf = new Map(rows.map((row) => [row.id, row.rules_reviewed_at]));

      // The whole point of the backfill: a household that has been importing since v1.0.0 must not
      // be greeted with "you have 47 imports you never checked" about statements they closed months
      // ago. Everything that happened before the feature existed counts as already seen.
      expect(stampOf.get(first)).not.toBeNull();
      expect(stampOf.get(second)).not.toBeNull();
      // Byte-compatible with nowIso()'s toISOString() -- millisecond precision, trailing Z -- so a
      // reader cannot tell a backfilled stamp from one the app wrote.
      expect(stampOf.get(first)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // An import created AFTER the upgrade is unreviewed, which is what the feature counts.
      upgraded.sqlite
        .prepare("insert into imports (account_id, profile_id, filename, imported_by, created_at) values (1, null, 'march.csv', 1, '2026-03-31T00:00:00.000Z')")
        .run();
      const fresh = upgraded.sqlite.prepare("select rules_reviewed_at from imports where filename = 'march.csv'").get() as {
        rules_reviewed_at: string | null;
      };
      expect(fresh.rules_reviewed_at).toBeNull();

      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening the upgraded file applies 0019 exactly once and never re-stamps a cleared marker', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    const { first } = seedPreMigrationHistory(staged.sqlite);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    // Stand in for the state that actually matters: a household that clears a marker back to NULL
    // (markImportRulesReviewed({ reviewed: false }) -- the recovery path for an accidental dismiss).
    // If a second boot re-ran the backfill, that import would silently become "reviewed" again and
    // the household would lose the un-dismiss they just performed.
    upgraded.sqlite.prepare('update imports set rules_reviewed_at = null where id = ?').run(first);
    upgraded.sqlite.close();

    const again = openDatabase(file);
    try {
      const row = again.sqlite.prepare('select rules_reviewed_at from imports where id = ?').get(first) as {
        rules_reviewed_at: string | null;
      };
      expect(row.rules_reviewed_at).toBeNull();
    } finally {
      again.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('rows that predate the column behave sensibly: an old import reports nothing unreviewed', async () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    const { first } = seedPreMigrationHistory(staged.sqlite);
    // A rule-assigned transaction belonging to that historical import -- exactly the row the audit
    // view is about. Before the upgrade there was no marker at all, so this row's import must not
    // start nagging the moment one exists.
    staged.sqlite
      .prepare(
        `insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents,
                                   category_id, categorization_source, is_transfer, hash_version, created_by, created_at, updated_at)
         values (1, ?, '2026-01-15', 'CORNER MARKET', 'CORNER MARKET', -2500, null, 'rule', 0, 1, 1,
                 '2026-01-31T00:00:00.000Z', '2026-01-31T00:00:00.000Z')`,
      )
      .run(first);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    const { setDbForTests } = await import('@/db/client');
    const { unreviewedRuleImports } = await import('@/lib/import/commit');
    setDbForTests(upgraded);
    try {
      expect(unreviewedRuleImports()).toEqual([]);
    } finally {
      setDbForTests(null);
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
