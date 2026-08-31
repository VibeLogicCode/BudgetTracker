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

describe('drizzle/0016_rule_hygiene.sql', () => {
  it('adds disabled_at to merchant_rules, nullable, no default', () => {
    current = createTestDb();
    const col = columns(current.sqlite, 'merchant_rules').get('disabled_at');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  it('creates merchant_rule_merges with the expected columns', () => {
    current = createTestDb();
    const names = [...columns(current.sqlite, 'merchant_rule_merges').keys()];
    expect(names).toEqual([
      'id', 'kept_rule_id', 'dropped_pattern', 'dropped_match_type', 'dropped_rule_kind',
      'dropped_hit_count', 'dropped_created_at', 'merged_at',
    ]);
  });

  it('records itself in the journal, immediately after 0015', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0016_rule_hygiene');
    expect(entry).toMatchObject({ idx: 16, tag: '0016_rule_hygiene' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(16)).toBe(idxs.indexOf(15) + 1);
  });

  it('the breakpoint marker never appears inside a comment', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0016_rule_hygiene.sql'), 'utf8');
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
 * Builds a database that has only ever seen migrations 0000-0015 (a v1.20.x household database
 * the moment before this release), the same staged-folder technique migration-0011's and
 * migration-0014's own suites already use. This is the ONLY way to exercise the merge logic at
 * all: a freshly created test DB runs every migration, 0016 included, over an EMPTY
 * merchant_rules table, so there is nothing yet for it to collide with.
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0016-migrations-'));
  const names = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n !== '0016_rule_hygiene.sql');
  for (const name of names) fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 15) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0016-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

function insertPreMigrationRule(
  sqlite: TestDb['sqlite'],
  row: { pattern: string; matchType: string; ruleKind: string; hitCount: number; createdAt: string; categoryId?: number | null },
): number {
  const result = sqlite
    .prepare(
      `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.pattern, row.matchType, row.ruleKind, row.categoryId ?? null, row.hitCount, row.createdAt);
  return Number(result.lastInsertRowid);
}

describe('a v1.20.x database (no 0016 applied) merges duplicates that uppercasing would collide', () => {
  it('picks the higher hit_count as survivor, carries the earlier created_at, and records the merge', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    // The exact shape item 9 describes: a household already has an uppercase rule in real use
    // (higher hit_count, created LATER) and a dead lowercase duplicate (zero hits, created
    // EARLIER -- e.g. typed once, mistyped, and re-added correctly afterward without the first
    // one ever being noticed).
    const deadId = insertPreMigrationRule(staged.sqlite, {
      pattern: 'walmart', matchType: 'exact', ruleKind: 'category', hitCount: 0, createdAt: '2026-01-01T00:00:00.000Z',
    });
    const liveId = insertPreMigrationRule(staged.sqlite, {
      pattern: 'WALMART', matchType: 'exact', ruleKind: 'category', hitCount: 12, createdAt: '2026-03-01T00:00:00.000Z',
    });
    // An unrelated rule with no collision at all -- must simply end up uppercased, untouched
    // otherwise, and never merged with anything.
    insertPreMigrationRule(staged.sqlite, {
      pattern: 'cineplex', matchType: 'exact', ruleKind: 'category', hitCount: 3, createdAt: '2026-02-01T00:00:00.000Z',
    });
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0016
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite
        .prepare(`select id, pattern, hit_count, created_at from merchant_rules where rule_kind = 'category' order by id`)
        .all() as { id: number; pattern: string; hit_count: number; created_at: string }[];

      // The dead duplicate is gone; only the survivor and the untouched row remain.
      expect(rows).toHaveLength(2);
      const survivor = rows.find((r) => r.id === liveId);
      expect(survivor).toBeDefined();
      expect(survivor).toMatchObject({ pattern: 'WALMART', hit_count: 12, created_at: '2026-01-01T00:00:00.000Z' });
      expect(rows.find((r) => r.id === deadId)).toBeUndefined();

      const untouched = rows.find((r) => r.pattern === 'CINEPLEX');
      expect(untouched).toBeDefined();

      const merges = upgraded.sqlite.prepare('select * from merchant_rule_merges').all() as {
        kept_rule_id: number;
        dropped_pattern: string;
        dropped_match_type: string;
        dropped_rule_kind: string;
        dropped_hit_count: number;
        dropped_created_at: string;
      }[];
      expect(merges).toHaveLength(1);
      expect(merges[0]).toMatchObject({
        kept_rule_id: liveId,
        dropped_pattern: 'walmart',
        dropped_match_type: 'exact',
        dropped_rule_kind: 'category',
        dropped_hit_count: 0,
        dropped_created_at: '2026-01-01T00:00:00.000Z',
      });

      // No orphans, no leftover temp table.
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      const tempTable = upgraded.sqlite
        .prepare(`select name from sqlite_master where name = '_rule_merge_group'`)
        .all();
      expect(tempTable).toEqual([]);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('merges a three-way collision into one survivor and records two dropped rows', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    const a = insertPreMigrationRule(staged.sqlite, {
      pattern: 'shell', matchType: 'contains', ruleKind: 'category', hitCount: 1, createdAt: '2026-01-03T00:00:00.000Z',
    });
    const b = insertPreMigrationRule(staged.sqlite, {
      pattern: 'SHELL', matchType: 'contains', ruleKind: 'category', hitCount: 5, createdAt: '2026-01-02T00:00:00.000Z',
    });
    const c = insertPreMigrationRule(staged.sqlite, {
      pattern: 'Shell', matchType: 'contains', ruleKind: 'category', hitCount: 5, createdAt: '2026-01-01T00:00:00.000Z',
    });
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite
        .prepare(`select id, pattern, hit_count, created_at from merchant_rules where rule_kind = 'category'`)
        .all() as { id: number; pattern: string; hit_count: number; created_at: string }[];
      expect(rows).toHaveLength(1);
      // Tie on hit_count (5) between b and c -- broken by the earlier created_at (c), then by id.
      expect(rows[0]).toMatchObject({ id: c, pattern: 'SHELL', hit_count: 5, created_at: '2026-01-01T00:00:00.000Z' });

      const merges = upgraded.sqlite.prepare('select dropped_pattern, kept_rule_id from merchant_rule_merges order by dropped_pattern').all();
      expect(merges).toEqual([
        { dropped_pattern: 'SHELL', kept_rule_id: c },
        { dropped_pattern: 'shell', kept_rule_id: c },
      ]);
      expect([a, b, c].filter((id) => id === c)).toHaveLength(1); // sanity: three distinct ids were created
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening an already-migrated file applies 0016 exactly once (idempotent boot)', () => {
    current = createTestDb();
    current.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at)
         values ('WALMART', 'exact', 'category', null, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      const rows = again.sqlite.prepare(`select pattern from merchant_rules where rule_kind = 'category'`).all();
      expect(rows).toEqual([{ pattern: 'WALMART' }]);
      const merges = again.sqlite.prepare('select count(*) as n from merchant_rule_merges').get() as { n: number };
      expect(merges.n).toBe(0);
    } finally {
      again.sqlite.close();
    }
  });
});
