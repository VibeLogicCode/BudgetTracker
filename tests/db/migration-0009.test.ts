import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, insertTestUser, insertTestAccount, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const now = '2026-08-22T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function insertCategory(sqlite: TestDb['sqlite'], name = 'Groceries'): number {
  const info = sqlite.prepare(`insert into categories (name) values (?)`).run(name);
  return Number(info.lastInsertRowid);
}

function insertTransaction(sqlite: TestDb['sqlite'], accountId: number, userId: number, amountCents: number): number {
  const info = sqlite
    .prepare(
      `insert into transactions
         (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, '2026-08-01', 'GROCERY STORE', 'GROCERY STORE', ?, ?, ?, ?)`,
    )
    .run(accountId, amountCents, userId, now, now);
  return Number(info.lastInsertRowid);
}

describe('the journal entry', () => {
  it('records idx 9 / when 1755993600000 / tag 0009_finish_line', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 9);
    expect(entry).toEqual({
      idx: 9,
      version: '6',
      when: 1755993600000,
      tag: '0009_finish_line',
      breakpoints: true,
    });
    // One day after 0008, matching the file's existing one-per-day cadence.
    const prior = journal.entries.find((e) => e.idx === 8);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0008 keeps its slot.
    expect(prior?.tag).toBe('0008_import_attribution');
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0009_finish_line.sql'), 'utf8');
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
  it('creates transaction_splits with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'transaction_splits'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'transaction_splits' }]);

    const { n } = current.sqlite.prepare('select count(*) as n from transaction_splits').get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(transaction_splits)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'txn_id', 'category_id', 'amount_cents', 'note', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('txn_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('txn_id')!.notnull).toBe(1);
    expect(byName.get('category_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('category_id')!.notnull).toBe(1);
    expect(byName.get('amount_cents')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('amount_cents')!.notnull).toBe(1);
    expect(byName.get('note')!.type.toLowerCase()).toBe('text');
    expect(byName.get('note')!.notnull).toBe(0);
    expect(byName.get('created_at')!.type.toLowerCase()).toBe('text');
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the transaction_splits indexes', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(
        `select name from sqlite_master where type = 'index'
           and name in ('transaction_splits_txn_idx', 'transaction_splits_category_idx') order by name`,
      )
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'transaction_splits_category_idx' }, { name: 'transaction_splits_txn_idx' }]);
  });

  it('creates account_balance_snapshots with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'account_balance_snapshots'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots' }]);

    const { n } = current.sqlite
      .prepare('select count(*) as n from account_balance_snapshots')
      .get() as { n: number };
    expect(n).toBe(0);

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
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the account_balance_snapshots_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'account_balance_snapshots_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'account_balance_snapshots_uq' }]);
  });

  it('creates budget_rollover with the exact columns, types and nullability', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'table' and name = 'budget_rollover'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'budget_rollover' }]);

    const { n } = current.sqlite.prepare('select count(*) as n from budget_rollover').get() as { n: number };
    expect(n).toBe(0);

    const cols = current.sqlite.prepare('pragma table_info(budget_rollover)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'scope', 'user_id', 'category_id', 'start_month', 'created_at']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('scope')!.type.toLowerCase()).toBe('text');
    expect(byName.get('scope')!.notnull).toBe(1);
    expect(byName.get('user_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('user_id')!.notnull).toBe(0);
    expect(byName.get('category_id')!.type.toLowerCase()).toBe('integer');
    expect(byName.get('category_id')!.notnull).toBe(1);
    expect(byName.get('start_month')!.type.toLowerCase()).toBe('text');
    expect(byName.get('start_month')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
  });

  it('creates the budget_rollover_uq unique index', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(`select name from sqlite_master where type = 'index' and name = 'budget_rollover_uq'`)
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'budget_rollover_uq' }]);
  });

  it('adds tax_relevant to categories, NOT NULL, defaulting to 0', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(categories)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const flag = cols.find((c) => c.name === 'tax_relevant');
    expect(flag).toBeDefined();
    expect(flag!.type.toLowerCase()).toBe('integer');
    expect(flag!.notnull).toBe(1);
    expect(String(flag!.dflt_value)).toBe('0');

    const info = current.sqlite.prepare(`insert into categories (name) values ('Medical')`).run();
    const row = current.sqlite
      .prepare('select tax_relevant from categories where id = ?')
      .get(info.lastInsertRowid) as { tax_relevant: number };
    expect(row.tax_relevant).toBe(0);
  });
});

describe('transaction_splits constraints', () => {
  it('cascade-deletes when its parent transaction is deleted', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const categoryId = insertCategory(current.sqlite, 'Groceries');
    const otherCategoryId = insertCategory(current.sqlite, 'Household');
    const txnId = insertTransaction(current.sqlite, accountId, userId, -10000);

    const insert = current.sqlite.prepare(
      `insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)`,
    );
    insert.run(txnId, categoryId, -7000, now);
    insert.run(txnId, otherCategoryId, -3000, now);

    const before = current.sqlite
      .prepare('select count(*) as n from transaction_splits where txn_id = ?')
      .get(txnId) as { n: number };
    expect(before.n).toBe(2);

    current.sqlite.prepare('delete from transactions where id = ?').run(txnId);

    const after = current.sqlite
      .prepare('select count(*) as n from transaction_splits where txn_id = ?')
      .get(txnId) as { n: number };
    expect(after.n).toBe(0);
  });

  it('rejects a zero amount_cents split', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const categoryId = insertCategory(current.sqlite);
    const txnId = insertTransaction(current.sqlite, accountId, userId, -5000);
    expect(() =>
      current!.sqlite
        .prepare(`insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, 0, ?)`)
        .run(txnId, categoryId, now),
    ).toThrowError(/CHECK constraint failed/);
  });
});

describe('account_balance_snapshots constraints', () => {
  it('rejects a duplicate (account_id, date) but allows a second date or a second account', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Chequing' });
    const otherAccountId = insertTestAccount(current.db, { name: 'Savings' });
    const insert = current.sqlite.prepare(
      `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at) values (?, ?, ?, ?, ?)`,
    );
    insert.run(accountId, '2026-08-01', 500000, 'simplefin', now);
    expect(() => insert.run(accountId, '2026-08-01', 600000, 'manual', now)).toThrowError(
      /UNIQUE constraint failed/,
    );
    insert.run(accountId, '2026-08-02', 510000, 'simplefin', now);
    insert.run(otherAccountId, '2026-08-01', 250000, 'manual', now);
    const { n } = current.sqlite.prepare('select count(*) as n from account_balance_snapshots').get() as {
      n: number;
    };
    expect(n).toBe(3);
  });

  it('rejects a source outside simplefin/manual', () => {
    current = createTestDb();
    const accountId = insertTestAccount(current.db);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into account_balance_snapshots (account_id, date, balance_cents, source, created_at)
           values (?, '2026-08-01', 100000, 'bogus', ?)`,
        )
        .run(accountId, now),
    ).toThrowError(/CHECK constraint failed/);
  });
});

describe('budget_rollover constraints', () => {
  it('rejects a duplicate household row for the same category, but allows personal rows for different users', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite, 'Medical');
    const otherCategoryId = insertCategory(current.sqlite, 'Dental');
    const user1 = insertTestUser(current.db, { username: 'alex' });
    const user2 = insertTestUser(current.db, { username: 'sam' });
    const insert = current.sqlite.prepare(
      `insert into budget_rollover (scope, user_id, category_id, start_month, created_at) values (?, ?, ?, ?, ?)`,
    );
    insert.run('household', null, categoryId, '2026-08', now);
    // A plain UNIQUE index would let this through, because NULL != NULL in SQL.
    expect(() => insert.run('household', null, categoryId, '2026-08', now)).toThrowError(
      /UNIQUE constraint failed/,
    );
    insert.run('personal', user1, categoryId, '2026-08', now);
    insert.run('personal', user2, categoryId, '2026-08', now);
    insert.run('household', null, otherCategoryId, '2026-08', now);
    const { n } = current.sqlite.prepare('select count(*) as n from budget_rollover').get() as { n: number };
    expect(n).toBe(4);
  });

  it('rejects a scope outside household/personal', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into budget_rollover (scope, user_id, category_id, start_month, created_at)
           values ('invalid', null, ?, '2026-08', ?)`,
        )
        .run(categoryId, now),
    ).toThrowError(/CHECK constraint failed/);
  });

  it('rejects scope/user_id combinations that break the pairing rule', () => {
    current = createTestDb();
    const categoryId = insertCategory(current.sqlite);
    const userId = insertTestUser(current.db);
    const insert = current!.sqlite.prepare(
      `insert into budget_rollover (scope, user_id, category_id, start_month, created_at) values (?, ?, ?, '2026-08', ?)`,
    );
    // A household row must carry a NULL user_id...
    expect(() => insert.run('household', userId, categoryId, now)).toThrowError(/CHECK constraint failed/);
    // ...and a personal row must carry a non-NULL one.
    expect(() => insert.run('personal', null, categoryId, now)).toThrowError(/CHECK constraint failed/);
  });
});
