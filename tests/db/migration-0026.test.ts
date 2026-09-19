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
  current!.sqlite
    .prepare(`pragma table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

/**
 * The backfill statement, read out of the migration file itself and run here against rows that
 * were inserted after the migration had already gone by. A fresh test database is empty when the
 * migration runs, so the only way to exercise an upgrade seed is to replay its SQL over data --
 * the same approach 0025's suite takes for its anchor recovery.
 */
function backfillStatement(): string {
  const sql = fs.readFileSync(path.join(process.cwd(), 'drizzle/0026_loan_ledger.sql'), 'utf8');
  const statement = sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().includes('insert into loan_rate_history'));
  if (statement === undefined) throw new Error('0026 has no loan_rate_history backfill');
  return statement;
}

/**
 * drizzle/0026_loan_ledger.sql. Three additions, all additive:
 *   - loan_postings, one append-only row per closed period, plus adjustments (ledger spec P1)
 *   - loan_rate_history, so a closed period keeps the rate that applied to it (R1)
 *   - warranty_items.posting_day and .statement_csv_columns (C1, S3)
 *
 * No balance moves at migration time. The postings that bring a loan up to date are written by
 * postAllDueInterest on the first boot after the upgrade (M3), because a migration cannot run the
 * interest engine.
 */
describe('0026: the migration records itself', () => {
  /** The "I am the newest" claim moved on to 0027's suite, as 0026 took it from 0025's. */
  it('sits immediately after 0025 in the journal', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0026_loan_ledger')).toMatchObject({ idx: 26 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(26)).toBe(idxs.indexOf(25) + 1);
  });
});

describe('0026: loan_postings', () => {
  it('has the columns the ledger writes', () => {
    current = createSeededTestDb();
    expect(columns('loan_postings')).toEqual([
      'id',
      'item_id',
      'kind',
      'period_start',
      'period_end',
      'opening_cents',
      'interest_cents',
      'payments_cents',
      'advances_cents',
      'closing_cents',
      'rate_bps',
      'basis',
      'average_daily_balance_cents',
      'note',
      'created_at',
      'created_by_user_id',
    ]);
  });

  /**
   * The partial index is what lets a correction land on a day that already has a posting. One
   * posting per period is the invariant; adjustments are deliberately outside it (K2).
   */
  it('allows one posting per period, and any number of adjustments on a day', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    const insert = current.sqlite.prepare(
      `insert into loan_postings
         (item_id, kind, period_start, period_end, opening_cents, interest_cents, closing_cents, created_at)
       values (?, ?, ?, ?, 0, 0, 0, '2026-09-18T00:00:00.000Z')`,
    );
    insert.run(itemId, 'posting', '2026-08-01', '2026-09-01');
    expect(() => insert.run(itemId, 'posting', '2026-08-01', '2026-09-01')).toThrow(/UNIQUE constraint/i);
    insert.run(itemId, 'adjustment', '2026-09-01', '2026-09-01');
    insert.run(itemId, 'adjustment', '2026-09-01', '2026-09-01');
    const rows = current.sqlite
      .prepare(`select count(*) as n from loan_postings where item_id = ?`)
      .get(itemId) as { n: number };
    expect(rows.n).toBe(3);
  });

  it('refuses a kind it does not know', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into loan_postings
             (item_id, kind, period_start, period_end, opening_cents, interest_cents, closing_cents, created_at)
           values (?, 'estimate', '2026-08-01', '2026-09-01', 0, 0, 0, '2026-09-18T00:00:00.000Z')`,
        )
        .run(itemId),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('goes when its loan goes', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    current.sqlite
      .prepare(
        `insert into loan_postings
           (item_id, kind, period_start, period_end, opening_cents, interest_cents, closing_cents, created_at)
         values (?, 'posting', '2026-08-01', '2026-09-01', 0, 0, 0, '2026-09-18T00:00:00.000Z')`,
      )
      .run(itemId);
    current.sqlite.prepare('delete from warranty_items where id = ?').run(itemId);
    expect(current.sqlite.prepare('select count(*) as n from loan_postings').get()).toEqual({ n: 0 });
  });
});

describe('0026: loan_rate_history', () => {
  it('has the columns a rate in force needs', () => {
    current = createSeededTestDb();
    expect(columns('loan_rate_history')).toEqual([
      'id',
      'item_id',
      'effective_from',
      'rate_bps',
      'basis',
      'created_at',
      'created_by_user_id',
    ]);
  });

  it('refuses a basis outside the six', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
           values (?, '2026-07-01', 500, 'weekly', '2026-07-01T00:00:00.000Z')`,
        )
        .run(itemId),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe('0026: the new item columns', () => {
  it('adds posting_day and statement_csv_columns, both nullable', () => {
    current = createSeededTestDb();
    const cols = columns('warranty_items');
    expect(cols).toContain('posting_day');
    expect(cols).toContain('statement_csv_columns');
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    expect(
      current.sqlite.prepare('select posting_day, statement_csv_columns from warranty_items where id = ?').get(itemId),
    ).toEqual({ posting_day: null, statement_csv_columns: null });
  });

  it('refuses a posting day outside a month', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user);
    expect(() => current!.sqlite.prepare('update warranty_items set posting_day = 32 where id = ?').run(itemId)).toThrow(
      /CHECK constraint failed/i,
    );
    expect(() => current!.sqlite.prepare('update warranty_items set posting_day = 0 where id = ?').run(itemId)).toThrow(
      /CHECK constraint failed/i,
    );
    current.sqlite.prepare('update warranty_items set posting_day = 31 where id = ?').run(itemId);
  });
});

describe('0026: the rate-history backfill', () => {
  it('writes one row per loan with a basis, dated at its newest anchor', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const withBasis = seedLoan(user, { rateBps: 1000, basis: 'apr_monthly' });
    const withoutBasis = seedLoan(user, { rateBps: 1000, basis: null, name: 'No basis' });
    current.sqlite
      .prepare(
        `insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at)
         values (?, '2026-08-05', 1000000, 'migrated', '2026-08-05T00:00:00.000Z')`,
      )
      .run(withBasis);
    current.sqlite.prepare('delete from loan_rate_history').run();

    current.sqlite.exec(backfillStatement());

    const rows = current.sqlite
      .prepare('select item_id, effective_from, rate_bps, basis from loan_rate_history order by item_id')
      .all();
    expect(rows).toEqual([{ item_id: withBasis, effective_from: '2026-08-05', rate_bps: 1000, basis: 'apr_monthly' }]);
    expect(rows.some((row) => (row as { item_id: number }).item_id === withoutBasis)).toBe(false);
  });

  it('falls back to the borrowed date when a loan has no anchor', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const itemId = seedLoan(user, { rateBps: 500, basis: 'apr_semiannual' });
    current.sqlite.prepare('delete from loan_anchors').run();
    current.sqlite.prepare('delete from loan_rate_history').run();

    current.sqlite.exec(backfillStatement());

    expect(current.sqlite.prepare('select effective_from from loan_rate_history where item_id = ?').get(itemId)).toEqual({
      effective_from: '2026-07-01',
    });
  });
});

/** A loan row written straight to SQLite: this suite is about the schema, not the item layer. */
function seedLoan(
  ownerUserId: number,
  over: { rateBps?: number | null; basis?: string | null; name?: string } = {},
): number {
  const row = current!.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents,
          interest_rate_bps, interest_rate_basis, current_balance_cents, created_at, updated_at)
       values (?, '2026-07-01', 0, ?, ?, 1000000, ?, ?, 1000000, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
       returning id`,
    )
    .get(
      over.name ?? 'Loan',
      ownerUserId,
      loanTypeId(),
      over.rateBps ?? null,
      over.basis ?? null,
    ) as { id: number };
  return row.id;
}
