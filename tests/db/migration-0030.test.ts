import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { openDatabase, getDb } from '@/db/client';
import { transactions, transactionSplits, loanPayments } from '@/db/schema';
import { REVIEW_WHERE, reviewQueueCount } from '@/lib/categorize/engine';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

const REAL_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

let current: TestDb | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  current?.cleanup();
  current = null;
  delete process.env.BUDGET_MIGRATIONS_DIR;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * drizzle/0030_review_index_and_deactivation.sql. One column with a backfill for accounts already
 * inactive, and one partial index the review count reads through.
 */
describe('0030: the migration records itself', () => {
  it('sits immediately after 0029 in the journal', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0030_review_index_and_deactivation')).toMatchObject({ idx: 30 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(30)).toBe(idxs.indexOf(29) + 1);
  });
});

// ------------------------------------------------------------------ accounts.deactivated_at

/** A database migrated to 0029 and no further, and the staged migrations folder that got it there. */
function buildPre0030Db(): { file: string; stageDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0030-migrations-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0030-db-'));
  tempDirs.push(stageDir, dbDir);
  for (const name of fs.readdirSync(REAL_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && !n.startsWith('0030_'))) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 29) }),
  );
  return { file: path.join(dbDir, 'budget.db'), stageDir };
}

describe('0030: an account records the day it was deactivated', () => {
  it('adds deactivated_at to accounts, nullable, and null on a new account', () => {
    current = createSeededTestDb();
    const cols = current.sqlite.prepare('pragma table_info(accounts)').all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === 'deactivated_at')).toMatchObject({ notnull: 0 });
    const id = insertTestAccount(current.db);
    expect(current.sqlite.prepare('select deactivated_at as d from accounts where id = ?').get(id)).toEqual({ d: null });
  });

  it('backfills an inactive account with the day after its last activity, and leaves active ones null', () => {
    const { file, stageDir } = buildPre0030Db();
    process.env.BUDGET_MIGRATIONS_DIR = stageDir;
    const staged = openDatabase(file);
    const s = staged.sqlite;
    s.prepare(
      `insert into users (id, name, username, password_hash, role, created_at)
       values (1, 'Alex', 'alex', 'h', 'admin', '2025-01-01T00:00:00.000Z')`,
    ).run();
    const account = s.prepare(
      `insert into accounts (id, name, institution, type, is_active, created_at)
       values (?, ?, 'Maple Credit Union', 'chequing', ?, ?)`,
    );
    account.run(1, 'Closed chequing', 0, '2025-03-01T12:00:00.000Z');
    account.run(2, 'Open chequing', 1, '2025-03-01T12:00:00.000Z');
    account.run(3, 'Never used', 0, '2025-06-10T12:00:00.000Z');
    account.run(4, 'Closed savings', 0, '2025-04-01T12:00:00.000Z');
    const snapshot = s.prepare(
      `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at)
       values (?, ?, 1000, 'manual', '2025-03-01T12:00:00.000Z')`,
    );
    snapshot.run(1, '2025-10-01');
    snapshot.run(1, '2025-11-20');
    snapshot.run(2, '2025-11-20');
    snapshot.run(4, '2025-09-14');
    const txn = s.prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents,
         created_by, created_at, updated_at)
       values (?, ?, 'MAPLE GROCER', 'MAPLE GROCER', -1500, 1, '2025-03-01T12:00:00.000Z', '2025-03-01T12:00:00.000Z')`,
    );
    txn.run(1, '2025-11-28');
    txn.run(1, '2025-12-02');
    txn.run(2, '2025-12-30');
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR;
    const upgraded = openDatabase(file);
    try {
      const rows = upgraded.sqlite.prepare('select id, deactivated_at as d from accounts order by id').all();
      expect(rows).toEqual([
        // Last snapshot 2025-11-20, last transaction 2025-12-02: the later one, plus a day.
        { id: 1, d: '2025-12-03' },
        { id: 2, d: null },
        // No snapshot and no transaction: the day after it was created.
        { id: 3, d: '2025-06-11' },
        // A snapshot and no transaction.
        { id: 4, d: '2025-09-15' },
      ]);
    } finally {
      upgraded.sqlite.close();
    }
  });
});

// ------------------------------------------------------------------ the review index

/** The rows a review queue meets in practice, plus each kind it must leave out. */
function seedReviewMix(t: TestDb): void {
  const user = insertTestUser(t.db, { name: 'Alex', username: 'alex' });
  const account = insertTestAccount(t.db, { name: 'Joint chequing' });
  const groceries = categoryIdByName(t.db, 'Groceries');
  const insert = t.sqlite.prepare(
    `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
       categorization_source, is_transfer, created_by, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z') returning id`,
  );
  const row = (date: string, merchant: string, categoryId: number | null, source: string, transfer: 0 | 1) =>
    (insert.get(account, date, merchant, merchant, -2500, categoryId, source, transfer, user) as { id: number }).id;

  row('2026-05-01', 'MAPLE GROCER', null, 'none', 0); // uncategorized: in
  row('2026-05-02', 'FUEL STOP 12', groceries, 'bayes', 0); // a guess: in
  row('2026-05-03', 'MAPLE GROCER', groceries, 'rule', 0); // filed by a rule: out
  row('2026-05-04', 'MAPLE GROCER', groceries, 'manual', 0); // confirmed: out
  row('2026-05-05', 'TRANSFER', null, 'none', 1); // a transfer: out
  row('2026-05-06', 'FUEL STOP 12', groceries, 'bayes', 1); // a transfer the classifier guessed: out
  const split = row('2026-05-07', 'MAPLE GROCER', null, 'none', 0); // split: out
  t.sqlite
    .prepare(`insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, -2500, '2026-05-07T00:00:00.000Z')`)
    .run(split, groceries);
  row('2026-05-08', 'FUEL STOP 12', groceries, 'bayes', 0); // another guess: in
}

/** REVIEW_WHERE as v1.59.1 wrote it, every value a bound parameter. */
const V1_59_1_REVIEW_WHERE = and(
  eq(transactions.isTransfer, false),
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
  sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
  sql`not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})`,
);

/**
 * The count's plan with nothing bound. SQLite can match a bound value against the index's
 * literals only by planning the statement again after binding, so a count that needs no
 * parameters is one whose first plan already uses the index.
 */
function countPlan(t: TestDb): { params: unknown[]; plan: string } {
  const query = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(REVIEW_WHERE)
    .toSQL();
  if (query.params.length > 0) return { params: query.params, plan: '' };
  const rows = t.sqlite.prepare(`explain query plan ${query.sql}`).all() as { detail: string }[];
  return { params: [], plan: rows.map((row) => row.detail).join('\n') };
}

describe('0030: the review count reads a partial index', () => {
  it('creates transactions_review_idx with the review queue predicate', () => {
    current = createSeededTestDb();
    const row = current.sqlite
      .prepare(`select sql from sqlite_master where type = 'index' and name = 'transactions_review_idx'`)
      .get() as { sql: string } | undefined;
    expect(row?.sql).toMatch(/where is_transfer = 0 and \(category_id is null or categorization_source = 'bayes'\)/i);
  });

  it('is the index the count query plans through, with no value left to bind', () => {
    current = createSeededTestDb();
    seedReviewMix(current);
    const { params, plan } = countPlan(current);
    expect(params).toEqual([]);
    expect(plan).toMatch(/USING (COVERING )?INDEX transactions_review_idx/);
  });

  it('gives the same count as the v1.59.1 predicate, and the same count with the index dropped', () => {
    current = createSeededTestDb();
    seedReviewMix(current);
    const before = getDb().select({ c: sql<number>`count(*)` }).from(transactions).where(V1_59_1_REVIEW_WHERE).get()!.c;
    expect(before).toBe(3);
    expect(reviewQueueCount()).toBe(before);
    current.sqlite.exec('drop index transactions_review_idx');
    expect(reviewQueueCount()).toBe(before);
  });
});
