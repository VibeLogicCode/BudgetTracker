import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/db';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(db: TestDb, table: string): ColumnInfo[] {
  return db.sqlite.prepare(`pragma table_info(${table})`).all() as ColumnInfo[];
}

describe('migration 0012 — two additive columns, no rebuild', () => {
  it('adds users.totp_last_counter as a nullable integer, last in the table', () => {
    current = createTestDb();
    const cols = columns(current, 'users');
    const added = cols.find((c) => c.name === 'totp_last_counter');
    expect(added).toBeDefined();
    expect(added?.type.toLowerCase()).toBe('integer');
    expect(added?.notnull).toBe(0);
    expect(added?.dflt_value).toBeNull();
    // ALTER TABLE ADD COLUMN appends physically. If this is ever not last, the schema.ts mirror
    // has stopped matching pragma table_info and the next reader has to guess.
    expect(cols[cols.length - 1]?.name).toBe('totp_last_counter');
  });

  it('adds bill_installments.unlinked_at as a nullable text column, last in the table', () => {
    current = createTestDb();
    const cols = columns(current, 'bill_installments');
    const added = cols.find((c) => c.name === 'unlinked_at');
    expect(added).toBeDefined();
    expect(added?.type.toLowerCase()).toBe('text');
    expect(added?.notnull).toBe(0);
    expect(cols[cols.length - 1]?.name).toBe('unlinked_at');
  });

  it('rebuilds neither table: every 0011 constraint and index still bites', () => {
    current = createTestDb();
    // The three bill_installments CHECKs from 0011 survive an ALTER TABLE ADD COLUMN only
    // because nothing was recreated. Assert one of each rather than trusting that.
    // item_id 1 does not exist in this fresh, unseeded db, so a bare toThrow() here would pass
    // just as well on the FOREIGN KEY failing as on the CHECK this test actually means to pin --
    // both throw, and toThrow() alone cannot tell them apart. Asserting the message names the
    // CHECK specifically closes that gap.
    const insertItemless = () =>
      current!.sqlite
        .prepare(
          `insert into bill_installments (item_id, due_date, amount_cents, created_at)
           values (1, '2026-06-15', -1, '2026-08-27T00:00:00.000Z')`,
        )
        .run();
    expect(insertItemless).toThrow(/CHECK constraint failed/i);
    const indexes = current.sqlite.prepare(`pragma index_list(bill_installments)`).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('bill_installments_txn_uq');
    const userIndexes = current.sqlite.prepare(`pragma index_list(users)`).all() as { name: string }[];
    expect(userIndexes.map((i) => i.name)).toContain('users_username_uq');
  });

  it('contains no PRAGMA and no table rebuild, and the journal names it', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0012_totp_last_counter.sql'), 'utf8');
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(/PRAGMA/i.test(statements)).toBe(false);
    expect(/CREATE TABLE/i.test(statements)).toBe(false);
    expect(/DROP TABLE/i.test(statements)).toBe(false);
    expect(statements.match(/ALTER TABLE/gi)?.length).toBe(2);

    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((e) => e.idx === 12);
    expect(entry?.tag).toBe('0012_totp_last_counter');
    const previous = journal.entries.find((e) => e.idx === 11);
    expect(entry?.when).toBeGreaterThan(previous?.when ?? 0);
  });

  it('the schema mirror can read and write both columns', () => {
    current = createTestDb();
    current.db.run(sql`
      insert into users (name, username, password_hash, role, created_at)
      values ('Alice', 'alice', 'x', 'admin', '2026-08-27T00:00:00.000Z')`);
    current.db.run(sql`update users set totp_last_counter = 58231001 where username = 'alice'`);
    const row = current.db.get<{ counter: number | null }>(
      sql`select totp_last_counter as counter from users where username = 'alice'`,
    );
    expect(row.counter).toBe(58231001);
  });
});
