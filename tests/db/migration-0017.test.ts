import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '../helpers/db';
import { openDatabase } from '@/db/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(sqlite: TestDb['sqlite'], table: string): Map<string, ColumnInfo> {
  const rows = sqlite.pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('drizzle/0017_pack_provenance.sql', () => {
  it('adds pack_source (text), pack_version (integer) and installed_at (text) to merchant_rules, all nullable, no default', () => {
    current = createTestDb();
    const cols = columns(current.sqlite, 'merchant_rules');
    for (const name of ['pack_source', 'pack_version', 'installed_at']) {
      const col = cols.get(name);
      expect(col, `missing column ${name}`).toBeDefined();
      expect(col?.notnull, `${name} must be nullable`).toBe(0);
      expect(col?.dflt_value, `${name} must have no default`).toBeNull();
    }
    expect(cols.get('pack_source')?.type.toLowerCase()).toBe('text');
    expect(cols.get('pack_version')?.type.toLowerCase()).toBe('integer');
    expect(cols.get('installed_at')?.type.toLowerCase()).toBe('text');
  });

  it('defaults every column to NULL on an existing row', () => {
    current = createTestDb();
    current.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at)
         values ('WALMART', 'exact', 'category', null, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const row = current.sqlite
      .prepare('select pack_source, pack_version, installed_at from merchant_rules')
      .get() as { pack_source: string | null; pack_version: number | null; installed_at: string | null };
    expect(row).toEqual({ pack_source: null, pack_version: null, installed_at: null });
  });

  it('records itself in the journal, immediately after 0016', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((row) => row.tag === '0017_pack_provenance');
    expect(entry).toMatchObject({ idx: 17, tag: '0017_pack_provenance' });
    const idxs = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(17)).toBe(idxs.indexOf(16) + 1);
    // No "and 17 is the newest" assertion here any more (v1.25.0, item 18). That claim belongs to
    // whichever migration is currently last, not to this one: 0018 added a column of its own and
    // its own suite asserts Math.max(...idxs) === 18, exactly as this file did while 0017 held that
    // position. 0016's suite has always checked only the immediately-after relation, for the same
    // reason -- an assertion a later, correct migration must break is a maintenance tax, not a guard.
  });

  it('the breakpoint marker never appears inside a comment', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0017_pack_provenance.sql'), 'utf8');
    const marker = ['-->', 'statement-breakpoint'].join(' ');
    const total = sqlText.split(marker).length - 1;
    const withoutComments = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
      .join('\n');
    expect(withoutComments.split(marker).length - 1).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('reopening an already-migrated file applies 0017 exactly once (idempotent boot)', () => {
    current = createTestDb();
    current.sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, hit_count, created_at, pack_source, pack_version, installed_at)
         values ('WALMART', 'exact', 'category', null, 0, '2026-01-01T00:00:00.000Z', 'canadian-merchants', 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      const row = again.sqlite
        .prepare('select pack_source, pack_version, installed_at from merchant_rules')
        .get() as { pack_source: string | null; pack_version: number | null; installed_at: string | null };
      expect(row).toEqual({ pack_source: 'canadian-merchants', pack_version: 1, installed_at: '2026-01-01T00:00:00.000Z' });
    } finally {
      again.sqlite.close();
    }
  });
});
