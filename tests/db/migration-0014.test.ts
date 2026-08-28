import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqlite } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(table: string): Map<string, ColumnInfo> {
  const rows = getSqlite().pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

let current: TestDb | null = null;

describe('drizzle/0014_loan_direction.sql', () => {
  beforeEach(() => { current = createTestDb(); });
  afterEach(() => { current?.cleanup(); current = null; });

  it('adds loan_direction to warranty_items, NOT NULL, defaulting to owed', () => {
    const cols = columns('warranty_items');
    expect(cols.get('loan_direction')?.notnull).toBe(1);
    expect(cols.get('loan_direction')?.dflt_value).toBe("'owed'");
  });

  it('appends PAST the four loan money columns, which stay contiguous and in order', () => {
    // tests/db/loan-schema.test.ts pins this and must keep passing unedited: ALTER TABLE ADD
    // COLUMN appends physically, so 0014's column lands after budget_category_id.
    const names = [...columns('warranty_items').keys()];
    const start = names.indexOf('principal_cents');
    expect(names.slice(start, start + 4)).toEqual([
      'principal_cents', 'interest_rate_bps', 'current_balance_cents', 'balance_updated_at',
    ]);
    expect(names.indexOf('loan_direction')).toBeGreaterThan(names.indexOf('budget_category_id'));
  });

  it('a row inserted without naming the column takes owed, so the CHECK holds by construction', () => {
    const db = getSqlite();
    const user = db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Alice', 'alice', 'x', 'member', 0, 1, '2026-08-28T00:00:00.000Z') returning id`,
    ).get() as { id: number };
    db.prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
    ).run(user.id);
    const row = db.prepare('select loan_direction from warranty_items').get() as { loan_direction: string };
    expect(row.loan_direction).toBe('owed');
  });

  it('the CHECK refuses a third value', () => {
    const db = getSqlite();
    const user = db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Alice', 'alice', 'x', 'member', 0, 1, '2026-08-28T00:00:00.000Z') returning id`,
    ).get() as { id: number };
    db.prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
    ).run(user.id);
    expect(() => db.prepare(`update warranty_items set loan_direction = 'given'`).run()).toThrow(/CHECK/i);
  });

  it('records itself in the journal', () => {
    const journal = JSON.parse(
      require('node:fs').readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1];
    expect(last).toMatchObject({ idx: 14, tag: '0014_loan_direction' });
  });
});
