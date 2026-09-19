import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { postAllDueInterest } from '@/lib/loans';

let t: TestDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

/**
 * Ledger spec M3/M4. The postings that bring a loan up to date are written IN CODE, by the first
 * sweep after the upgrade -- a migration cannot run the interest engine, and hand-writing the
 * arithmetic in SQL would be a second implementation of the thing this release exists to have one
 * of.
 *
 * This file stands in for that first boot: it builds the rows an upgraded database would hold, then
 * runs the sweep and checks what appears.
 */
function upgradedLoan(over: { basis?: string | null; rateBps?: number; anchor?: string } = {}): number {
  const userId = insertTestUser(t!.db, { role: 'admin' });
  const row = t!.sqlite
    .prepare(
      `insert into warranty_items
         (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents,
          interest_rate_bps, interest_rate_basis, current_balance_cents, balance_updated_at, created_at, updated_at)
       values ('Existing loan', '2026-07-01', 0, ?, ?, 1000000, ?, ?, 1000000, '2026-07-01T00:00:00.000Z',
               '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
       returning id`,
    )
    .get(userId, loanTypeId(), over.rateBps ?? 1000, over.basis === undefined ? 'apr_monthly' : over.basis) as {
    id: number;
  };
  // The 'migrated' anchor 0025 wrote for every loan that already had a balance.
  t!.sqlite
    .prepare(
      `insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at)
       values (?, ?, 1000000, 'migrated', '2026-07-01T00:00:00.000Z')`,
    )
    .run(row.id, over.anchor ?? '2026-07-01');
  // The rate-history row 0026's backfill wrote for every loan that already had a basis.
  if (over.basis !== null) {
    t!.sqlite
      .prepare(
        `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
         values (?, ?, ?, ?, '2026-07-01T00:00:00.000Z')`,
      )
      .run(row.id, over.anchor ?? '2026-07-01', over.rateBps ?? 1000, over.basis ?? 'apr_monthly');
  }
  return row.id;
}

const postings = (itemId: number) =>
  t!.sqlite
    .prepare('select period_end, interest_cents from loan_postings where item_id = ? order by id')
    .all(itemId) as { period_end: string; interest_cents: number }[];

const balanceOf = (itemId: number) =>
  (t!.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number })
    .b;

describe('M3: the first sweep after an upgrade', () => {
  it('posts every period that closed since the loan was last confirmed', () => {
    t = createSeededTestDb();
    const itemId = upgradedLoan();
    expect(postAllDueInterest('2026-09-18', new Date('2026-09-18T02:00:00.000Z'))).toEqual({
      items: 1,
      posted: 2,
      adjusted: 0,
      failed: 0,
    });
    expect(postings(itemId)).toEqual([
      { period_end: '2026-08-01', interest_cents: 8_333 },
      { period_end: '2026-09-01', interest_cents: 8_403 },
    ]);
  });

  /** M4: a loan WITH a basis does move, and the release note says so. */
  it('moves the balance of a loan that says how its rate is charged', () => {
    t = createSeededTestDb();
    const itemId = upgradedLoan();
    postAllDueInterest('2026-09-18', new Date('2026-09-18T02:00:00.000Z'));
    expect(balanceOf(itemId)).toBe(1_016_736);
  });

  /**
   * M4, the half that matters more: every loan on an existing install whose rate was typed while
   * the form promised no interest maths is left exactly where it was.
   */
  it('leaves a loan with no basis completely alone', () => {
    t = createSeededTestDb();
    const itemId = upgradedLoan({ basis: null });
    expect(postAllDueInterest('2026-09-18', new Date('2026-09-18T02:00:00.000Z'))).toEqual({
      items: 0,
      posted: 0,
      adjusted: 0,
      failed: 0,
    });
    expect(postings(itemId)).toEqual([]);
    expect(balanceOf(itemId)).toBe(1_000_000);
  });

  it('writes nothing the second night', () => {
    t = createSeededTestDb();
    upgradedLoan();
    postAllDueInterest('2026-09-18', new Date('2026-09-18T02:00:00.000Z'));
    expect(postAllDueInterest('2026-09-19', new Date('2026-09-19T02:00:00.000Z'))).toEqual({
      items: 0,
      posted: 0,
      adjusted: 0,
      failed: 0,
    });
  });

  /** A machine switched off for half a year catches up in one sweep, oldest period first. */
  it('catches up however long it has been', () => {
    t = createSeededTestDb();
    const itemId = upgradedLoan({ anchor: '2026-01-01' });
    postAllDueInterest('2026-09-18', new Date('2026-09-18T02:00:00.000Z'));
    const rows = postings(itemId);
    expect(rows).toHaveLength(8);
    expect(rows[0]!.period_end).toBe('2026-02-01');
    expect(rows.at(-1)!.period_end).toBe('2026-09-01');
  });
});
