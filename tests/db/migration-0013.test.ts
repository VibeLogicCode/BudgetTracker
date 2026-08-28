import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqlite } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(table: string): Map<string, ColumnInfo> {
  const rows = getSqlite().pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

let current: TestDb | null = null;

describe('drizzle/0013_household_scope.sql', () => {
  beforeEach(() => {
    current = createTestDb();
  });

  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  it('adds visibility, can_sign_in and last_account_id to users with the documented defaults', () => {
    const cols = columns('users');
    expect(cols.get('visibility')?.notnull).toBe(1);
    expect(cols.get('visibility')?.dflt_value).toBe("'household'");
    expect(cols.get('can_sign_in')?.notnull).toBe(1);
    expect(cols.get('can_sign_in')?.dflt_value).toBe('1');
    expect(cols.has('last_account_id')).toBe(true);
    expect(cols.get('last_account_id')?.notnull).toBe(0);
  });

  it('a pre-existing row receives the defaults, so both CHECKs hold by construction', () => {
    const db = getSqlite();
    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    const row = db.prepare('select visibility, can_sign_in, last_account_id from users').get() as {
      visibility: string; can_sign_in: number; last_account_id: number | null;
    };
    expect(row).toEqual({ visibility: 'household', can_sign_in: 1, last_account_id: null });
  });

  it('the visibility CHECK refuses a third value', () => {
    const db = getSqlite();
    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare(`update users set visibility = 'guest'`).run()).toThrow(/CHECK/i);
  });

  it('adds merchant_rules.last_modified_by and warranty_items.budget_category_id', () => {
    expect(columns('merchant_rules').has('last_modified_by')).toBe(true);
    expect(columns('warranty_items').has('budget_category_id')).toBe(true);
  });

  it('creates audit_log with its two indexes and a length CHECK, not a value enum', () => {
    const db = getSqlite();
    const cols = columns('audit_log');
    expect([...cols.keys()]).toEqual(['id', 'at', 'user_id', 'action', 'entity', 'entity_id', 'detail']);
    const indexes = (db.pragma('index_list(audit_log)') as { name: string }[]).map((row) => row.name);
    expect(indexes).toContain('audit_log_at_idx');
    expect(indexes).toContain('audit_log_entity_idx');

    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    // A value this release does not know about is accepted -- a future audited action must never
    // need a migration (spec, Data model note 2).
    expect(() =>
      db
        .prepare(`insert into audit_log (at, user_id, action, entity, entity_id) values (?, 1, 'future_action', 'accounts', 7)`)
        .run('2026-08-27T00:00:00.000Z'),
    ).not.toThrow();
    // An empty action is refused by the length CHECK.
    expect(() =>
      db
        .prepare(`insert into audit_log (at, user_id, action, entity, entity_id) values (?, 1, '   ', 'accounts', 7)`)
        .run('2026-08-27T00:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it('accounts.type still carries no SQL CHECK, which is why widening it needed no migration', () => {
    const sql = (getSqlite()
      .prepare(`select sql from sqlite_master where type = 'table' and name = 'accounts'`)
      .get() as { sql: string }).sql;
    expect(sql).not.toMatch(/CHECK/i);
  });
});
