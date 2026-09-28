import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const columns = (table: string): string[] =>
  (current!.sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

/**
 * drizzle/0028_account_import_cadence.sql (spec 2026-09-28 §2.2). One nullable column, no
 * backfill: NULL means "the household default", which is what every existing row meant already.
 */
describe('0028: the migration records itself', () => {
  it('sits immediately after 0027 in the journal, and is the newest', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0028_account_import_cadence')).toMatchObject({ idx: 28 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(28)).toBe(idxs.indexOf(27) + 1);
    expect(Math.max(...idxs)).toBe(28);
  });
});

describe('0028: an account can say how often it is imported', () => {
  it('adds expected_import_weeks to accounts, nullable, and null by default', () => {
    current = createSeededTestDb();
    expect(columns('accounts')).toContain('expected_import_weeks');
    const id = insertTestAccount(current.db);
    expect(current.sqlite.prepare('select expected_import_weeks as w from accounts where id = ?').get(id)).toEqual({ w: null });
  });

  it('stores 0 (never) and 53 (yearly): no CHECK, the meaning lives in src/lib/import/cadence.ts', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db);
    for (const weeks of [0, 2, 53]) {
      current.sqlite.prepare('update accounts set expected_import_weeks = ? where id = ?').run(weeks, id);
      expect(current.sqlite.prepare('select expected_import_weeks as w from accounts where id = ?').get(id)).toEqual({ w: weeks });
    }
  });
});
