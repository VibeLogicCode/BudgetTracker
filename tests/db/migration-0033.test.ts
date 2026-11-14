import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '@/db/client';
import { categoryIdByName, createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

let current: TestDb | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** drizzle/0033_ai_suggestions.sql (v1.64.0). One new, empty table and its unique index. */
describe('0033: the migration records itself', () => {
  it('sits immediately after 0032 in the journal', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.find((row) => row.tag === '0033_ai_suggestions')).toMatchObject({ idx: 33, when: 1758844800000 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(33)).toBe(idxs.indexOf(32) + 1);
    const when = (idx: number) => journal.entries.find((entry) => entry.idx === idx)!.when;
    expect(when(33)).toBeGreaterThan(when(32));
  });
});

/** A database migrated to 0032 and no further, and the staged migrations folder that got it there. */
function buildPre0033Db(): { file: string; stageDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0033-migrations-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0033-db-'));
  tempDirs.push(stageDir, dbDir);
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith('0033_'))) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 32) }),
  );
  return { file: path.join(dbDir, 'budget.db'), stageDir };
}

describe('0033: an existing install', () => {
  it('gains an empty table and leaves every existing row as it was', () => {
    const { file, stageDir } = buildPre0033Db();
    process.env.BUDGET_MIGRATIONS_DIR = stageDir;
    const staged = openDatabase(file);
    const s = staged.sqlite;
    expect(s.prepare("select count(*) as c from sqlite_master where name = 'ai_suggestions'").get()).toEqual({ c: 0 });
    s.prepare(
      `insert into users (id, name, username, password_hash, role, created_at)
       values (1, 'Alex', 'alex', 'h', 'admin', '2026-03-01T00:00:00.000Z')`,
    ).run();
    s.prepare(
      `insert into accounts (id, name, institution, type, created_at)
       values (1, 'Joint chequing', 'Example Credit Union', 'chequing', '2026-03-01T00:00:00.000Z')`,
    ).run();
    s.prepare(
      `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (1, 1, '2026-03-09', 'MAPLE GROCER 0042', 'MAPLE GROCER', -4217, 1, '2026-03-09T00:00:00.000Z', '2026-03-09T00:00:00.000Z')`,
    ).run();
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      expect(upgraded.sqlite.prepare('select count(*) as c from ai_suggestions').get()).toEqual({ c: 0 });
      expect(upgraded.sqlite.prepare('select id, normalized_merchant, category_id from transactions').all()).toEqual([
        { id: 1, normalized_merchant: 'MAPLE GROCER', category_id: null },
      ]);
    } finally {
      upgraded.sqlite.close();
    }
  });
});

describe('0033: the table on a new database', () => {
  function fixture() {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const groceries = categoryIdByName(current.db, 'Groceries');
    const insert = current.sqlite.prepare(
      `insert into ai_suggestions (normalized_merchant, status, category_id, clean_name, model, reason, created_at, decided_by, decided_at)
       values (@merchant, @status, @category, @name, @model, @reason, '2026-03-10T09:00:00.000Z', @by, @at)`,
    );
    const row = (over: Record<string, unknown> = {}) => ({
      merchant: 'MAPLE GROCER',
      status: 'suggested',
      category: groceries,
      name: 'Maple Grocer',
      model: 'test-model:1b',
      reason: null,
      by: null,
      at: null,
      ...over,
    });
    return { insert, row, alex };
  }

  it('takes a good row, and one row per merchant', () => {
    const { insert, row, alex } = fixture();
    insert.run(row());
    insert.run(row({ merchant: 'FUEL STOP 12', status: 'ignored', category: null, name: null, by: alex, at: '2026-03-10T10:00:00.000Z' }));
    insert.run(row({ merchant: 'STREAMBOX', status: 'failed', category: null, name: null, reason: 'Nothing in the answer could be used.' }));
    expect(() => insert.run(row({ status: 'failed' }))).toThrow(/UNIQUE constraint failed/);
  });

  it('refuses each bad value its CHECK names', () => {
    const { insert, row } = fixture();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ merchant: '' }, /CHECK constraint failed/],
      [{ status: 'accepted' }, /CHECK constraint failed/],
      [{ name: '' }, /CHECK constraint failed/],
      [{ name: 'M'.repeat(61) }, /CHECK constraint failed/],
      [{ model: '' }, /CHECK constraint failed/],
      [{ model: 'm'.repeat(101) }, /CHECK constraint failed/],
      [{ reason: 'r'.repeat(201) }, /CHECK constraint failed/],
      [{ merchant: null }, /NOT NULL constraint failed/],
      [{ model: null }, /NOT NULL constraint failed/],
      [{ category: 999_999 }, /FOREIGN KEY constraint failed/],
      [{ by: 999_999 }, /FOREIGN KEY constraint failed/],
    ];
    for (const [over, error] of cases) {
      expect(() => insert.run(row({ merchant: `SHOP ${JSON.stringify(over).length}`, ...over })), JSON.stringify(over).slice(0, 60)).toThrow(error);
    }
    expect(current!.sqlite.prepare('select count(*) as c from ai_suggestions').get()).toEqual({ c: 0 });
  });
});
