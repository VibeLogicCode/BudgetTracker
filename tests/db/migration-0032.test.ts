import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase } from '@/db/client';
import { createSeededTestDb, type TestDb } from '../helpers/db';
import { buildSplitPersonFixture } from '../helpers/split-person-fixture';

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

let current: TestDb | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** drizzle/0032_split_person.sql. Two columns on transaction_splits and a partial index. */
describe('0032: the migration records itself', () => {
  it('sits immediately after 0031 in the journal', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.find((row) => row.tag === '0032_split_person')).toMatchObject({ idx: 32, when: 1758758400000 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(32)).toBe(idxs.indexOf(31) + 1);
    const when = (idx: number) => journal.entries.find((entry) => entry.idx === idx)!.when;
    expect(when(32)).toBeGreaterThan(when(31));
  });
});

/** A database migrated to 0031 and no further, and the staged migrations folder that got it there. */
function buildPre0032Db(): { file: string; stageDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0032-migrations-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0032-db-'));
  tempDirs.push(stageDir, dbDir);
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith('0032_'))) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 31) }),
  );
  return { file: path.join(dbDir, 'budget.db'), stageDir };
}

describe('0032: an existing split keeps following its transaction', () => {
  it('reads person_set 0 and no person on every existing part, with no backfill', () => {
    const { file, stageDir } = buildPre0032Db();
    process.env.BUDGET_MIGRATIONS_DIR = stageDir;
    const staged = openDatabase(file);
    const s = staged.sqlite;
    s.prepare(
      `insert into users (id, name, username, password_hash, role, created_at)
       values (1, 'Alex', 'alex', 'h', 'admin', '2026-03-01T00:00:00.000Z')`,
    ).run();
    s.prepare(
      `insert into accounts (id, name, institution, type, created_at)
       values (1, 'Joint chequing', 'Maple Credit Union', 'chequing', '2026-03-01T00:00:00.000Z')`,
    ).run();
    s.prepare(`insert into categories (id, name, sort_order) values (1, 'Groceries', 0), (2, 'Dining', 1)`).run();
    s.prepare(
      `insert into transactions (id, account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
         attributed_user_id, created_by, created_at, updated_at)
       values (1, 1, '2026-03-09', 'MAPLE GROCER', 'MAPLE GROCER', -15000, 1, 1, 1, '2026-03-09T00:00:00.000Z', '2026-03-09T00:00:00.000Z')`,
    ).run();
    const part = s.prepare(
      `insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (1, ?, ?, '2026-03-09T00:00:00.000Z')`,
    );
    part.run(1, -11000);
    part.run(2, -4000);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      expect(
        upgraded.sqlite.prepare('select category_id, amount_cents, person_set, attributed_user_id from transaction_splits order by id').all(),
      ).toEqual([
        { category_id: 1, amount_cents: -11000, person_set: 0, attributed_user_id: null },
        { category_id: 2, amount_cents: -4000, person_set: 0, attributed_user_id: null },
      ]);
    } finally {
      upgraded.sqlite.close();
    }
  });
});

describe('0032: the columns on a new database', () => {
  it('refuses a person_set outside 0 and 1, and a person who is not a user', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    expect(() => fx.t.sqlite.prepare('update transaction_splits set person_set = 2 where id = ?').run(fx.parts.dining)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      fx.t.sqlite.prepare('update transaction_splits set attributed_user_id = 9999 where id = ?').run(fx.parts.dining),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('indexes only the set parts, and a person lookup plans through that index', () => {
    current = createSeededTestDb();
    const index = current.sqlite
      .prepare(`select sql from sqlite_master where type = 'index' and name = 'transaction_splits_person_idx'`)
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/WHERE `person_set` = 1/);
    const plan = current.sqlite
      .prepare(`explain query plan select txn_id from transaction_splits where person_set = 1 and attributed_user_id = ?`)
      .all(4) as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING INDEX transaction_splits_person_idx/);
  });
});
