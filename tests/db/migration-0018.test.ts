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

describe('drizzle/0018_pack_origin_key.sql', () => {
  it('adds pack_origin_key (text) to merchant_rules, nullable, no default', () => {
    current = createTestDb();
    const col = columns(current.sqlite, 'merchant_rules').get('pack_origin_key');
    expect(col, 'missing column pack_origin_key').toBeDefined();
    expect(col?.type.toLowerCase()).toBe('text');
    expect(col?.notnull, 'pack_origin_key must be nullable').toBe(0);
    expect(col?.dflt_value, 'pack_origin_key must have no default').toBeNull();
  });

  it('leaves pack_origin_key NULL on a rule inserted after it ran', () => {
    current = createTestDb();
    current.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at)
         values ('WALMART', 'exact', 'category', null, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const row = current.sqlite.prepare('select pack_origin_key from merchant_rules').get() as { pack_origin_key: string | null };
    expect(row.pack_origin_key).toBeNull();
  });

  it('records itself in the journal, immediately after 0017', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0018_pack_origin_key');
    expect(entry).toMatchObject({ idx: 18, tag: '0018_pack_origin_key' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(18)).toBe(idxs.indexOf(17) + 1);
    // No "and 18 is the newest" assertion here any more (v1.26.0, Lane 2 item 4) -- handed on
    // exactly the way 0017's suite handed it to this one. That claim belongs to whichever migration
    // is currently last: 0019 added a column of its own and its own suite asserts
    // Math.max(...idxs) === 19, as this file did while 0018 held the position. An assertion a later,
    // correct migration must break is a maintenance tax, not a guard.
  });

  it('the breakpoint marker never appears inside a comment', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0018_pack_origin_key.sql'), 'utf8');
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
 * Builds a database that has only ever seen migrations 0000-0017 -- a v1.24.x household database
 * with the preset pack already installed, the moment before this release. Same staged-folder
 * technique migration-0011's, 0014's and 0016's own suites use, and the only way to exercise the
 * backfill at all: a freshly created test DB runs every migration, 0018 included, over an EMPTY
 * merchant_rules table, so there is nothing there for it to record an origin for.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0018-migrations-'));
  const names = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n !== '0018_pack_origin_key.sql');
  for (const name of names) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 17) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0018-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

function insertPreMigrationRule(
  sqlite: TestDb['sqlite'],
  row: { pattern: string; matchType: string; ruleKind: string; packSource?: string | null; packVersion?: number | null },
): number {
  const result = sqlite
    .prepare(
      `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at, pack_source, pack_version, installed_at)
       values (?, ?, ?, null, 0, '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
    )
    .run(
      row.pattern,
      row.matchType,
      row.ruleKind,
      row.packSource ?? null,
      row.packVersion ?? null,
      row.packSource === undefined || row.packSource === null ? null : '2026-01-01T00:00:00.000Z',
    );
  return Number(result.lastInsertRowid);
}

describe('a v1.24.x database (0017 applied, 0018 not) upgrades cleanly', () => {
  it('backfills every stamped row with its own key and leaves every unstamped row NULL', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    // Three shapes a real pre-0018 household database can hold, and the migration has to treat
    // them differently: a plain stamped preset row; a stamped preset row of a kind and match type
    // other than the default pair (so the backfilled key is visibly built from all three columns,
    // not just the pattern); and a rule the household wrote themselves.
    const stampedId = insertPreMigrationRule(staged.sqlite, {
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', packSource: 'canadian-merchants', packVersion: 2,
    });
    const stampedWordId = insertPreMigrationRule(staged.sqlite, {
      pattern: 'IGA', matchType: 'word', ruleKind: 'rename', packSource: 'canadian-merchants', packVersion: 2,
    });
    const ownId = insertPreMigrationRule(staged.sqlite, { pattern: 'CORNER STORE', matchType: 'contains', ruleKind: 'category' });
    expect(staged.sqlite.pragma('table_info(merchant_rules)') as ColumnInfo[]).not.toContainEqual(
      expect.objectContaining({ name: 'pack_origin_key' }),
    );
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0018
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite
        .prepare('select id, pack_origin_key from merchant_rules order by id')
        .all() as { id: number; pack_origin_key: string | null }[];
      const originOf = new Map(rows.map((row) => [row.id, row.pack_origin_key]));

      // A row that is stamped right now is, by definition, sitting under the key the pack last
      // wrote it under -- so recording its current key is a statement of fact, not a guess.
      expect(originOf.get(stampedId)).toBe('TIM HORTONS|exact|category');
      // All three columns, in the order ruleKeyOf (src/lib/packs.ts) builds them.
      expect(originOf.get(stampedWordId)).toBe('IGA|word|rename');
      // Never invented for a row the pack does not claim: there is no evidence in the database to
      // tell a pre-0018 pattern edit of a preset rule apart from a rule written from scratch, and
      // guessing would risk the pack claiming a rule it never wrote.
      expect(originOf.get(ownId)).toBeNull();

      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening the upgraded file applies 0018 exactly once and never rewrites a recorded origin', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);
    const stampedId = insertPreMigrationRule(staged.sqlite, {
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', packSource: 'canadian-merchants', packVersion: 2,
    });
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    // Stand in for the state item 18 actually cares about: a row whose origin points somewhere
    // OTHER than where it now sits, which is what a form re-key leaves behind. If a second boot
    // re-ran the backfill unconditionally it would overwrite this with the row's own key and the
    // pack would stop recognising the replacement -- which is why the migration's UPDATE carries
    // its own `pack_origin_key IS NULL` guard.
    upgraded.sqlite
      .prepare(`update merchant_rules set pack_source = null, pack_version = null, installed_at = null, pattern = 'TIM HORTON' where id = ?`)
      .run(stampedId);
    upgraded.sqlite.close();

    const again = openDatabase(file);
    try {
      const row = again.sqlite
        .prepare('select pattern, pack_source, pack_origin_key from merchant_rules where id = ?')
        .get(stampedId) as { pattern: string; pack_source: string | null; pack_origin_key: string | null };
      expect(row).toEqual({ pattern: 'TIM HORTON', pack_source: null, pack_origin_key: 'TIM HORTONS|exact|category' });
    } finally {
      again.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
});
