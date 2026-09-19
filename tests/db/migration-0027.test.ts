import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const columns = (table: string): string[] =>
  (current!.sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

const indexNames = (): string[] =>
  (current!.sqlite.prepare(`select name from sqlite_master where type = 'index'`).all() as { name: string }[]).map(
    (row) => row.name,
  );

/**
 * The backfill statement, read out of the migration file and replayed over rows inserted after the
 * migration had already gone by -- a fresh test database is empty when it runs, so this is the only
 * way to exercise an upgrade seed. Same approach 0025 and 0026 take.
 */
function backfillStatement(): string {
  const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0027_review_fixes.sql'), 'utf8');
  const statement = sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().includes('update loan_postings'));
  if (statement === undefined) throw new Error('0027 has no adjustment backfill');
  return statement;
}

/**
 * drizzle/0027_review_fixes.sql. One column, four indexes, one backfill -- all additive, and none of
 * them moves a balance on its own.
 */
describe('0027: the migration records itself', () => {
  it('sits immediately after 0026 in the journal, and is the newest', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0027_review_fixes')).toMatchObject({ idx: 27 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(27)).toBe(idxs.indexOf(26) + 1);
    expect(Math.max(...idxs)).toBe(27);
  });
});

describe('0027: a statement can be withdrawn', () => {
  it('adds retracted_at to loan_anchors, nullable', () => {
    current = createSeededTestDb();
    expect(columns('loan_anchors')).toContain('retracted_at');
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = listItemTypes().find((type) => type.kind === 'loan')!.id;
    const item = current.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, current_balance_cents, created_at, updated_at)
         values ('Loan', '2026-07-01', 0, ?, ?, 1000000, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z') returning id`,
      )
      .get(user, typeId) as { id: number };
    current.sqlite
      .prepare(
        `insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at)
         values (?, '2026-07-01', 1000000, 'form', '2026-07-01T00:00:00.000Z')`,
      )
      .run(item.id);
    expect(current.sqlite.prepare('select retracted_at from loan_anchors where item_id = ?').get(item.id)).toEqual({
      retracted_at: null,
    });
  });
});

describe('0027: the four indexes the review named', () => {
  it('creates all of them', () => {
    current = createSeededTestDb();
    const names = indexNames();
    for (const name of [
      'notification_outbox_event_idx',
      'budget_rollover_scope_idx',
      'loan_payments_source_idx',
      'warranty_items_basis_idx',
    ]) {
      expect({ name, present: names.includes(name) }).toEqual({ name, present: true });
    }
  });

  /** Partial, because almost no item is a loan with a rate. */
  it('keeps the basis index partial', () => {
    current = createSeededTestDb();
    const row = current.sqlite
      .prepare(`select sql from sqlite_master where name = 'warranty_items_basis_idx'`)
      .get() as { sql: string };
    expect(row.sql).toMatch(/where interest_rate_basis is not null/i);
  });
});

describe('0027: the adjustment backfill', () => {
  it('moves an adjustment’s period start to the period it corrected', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = listItemTypes().find((type) => type.kind === 'loan')!.id;
    const item = current.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('Loan', '2026-07-01', 0, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z') returning id`,
      )
      .get(user, typeId) as { id: number };
    const insert = current.sqlite.prepare(
      `insert into loan_postings (item_id, kind, period_start, period_end, opening_cents, interest_cents, closing_cents, created_at)
       values (?, ?, ?, ?, 0, ?, 0, '2026-09-18T00:00:00.000Z')`,
    );
    insert.run(item.id, 'posting', '2026-07-01', '2026-08-01', 100);
    insert.run(item.id, 'posting', '2026-08-01', '2026-09-01', 101);
    // As v1.48.0 wrote it: the day it was discovered, in both columns.
    insert.run(item.id, 'adjustment', '2026-09-18', '2026-09-18', -50);

    current.sqlite.exec(backfillStatement());

    const rows = current.sqlite
      .prepare(`select kind, period_start from loan_postings where item_id = ? order by id`)
      .all(item.id);
    expect(rows).toEqual([
      { kind: 'posting', period_start: '2026-07-01' },
      { kind: 'posting', period_start: '2026-08-01' },
      // The newest posting it was written against began on 2026-08-01, so that is the period it
      // belongs to -- and a statement dated after it now supersedes both together.
      { kind: 'adjustment', period_start: '2026-08-01' },
    ]);
  });

  it('leaves an adjustment alone when there is no posting before it', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const typeId = listItemTypes().find((type) => type.kind === 'loan')!.id;
    const item = current.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('Loan', '2026-07-01', 0, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z') returning id`,
      )
      .get(user, typeId) as { id: number };
    current.sqlite
      .prepare(
        `insert into loan_postings (item_id, kind, period_start, period_end, opening_cents, interest_cents, closing_cents, created_at)
         values (?, 'adjustment', '2026-09-18', '2026-09-18', 0, -50, 0, '2026-09-18T00:00:00.000Z')`,
      )
      .run(item.id);
    current.sqlite.exec(backfillStatement());
    expect(
      current.sqlite.prepare(`select period_start from loan_postings where item_id = ?`).get(item.id),
    ).toEqual({ period_start: '2026-09-18' });
  });
});
