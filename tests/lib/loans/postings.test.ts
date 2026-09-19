import { describe, it, expect, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from './fixtures';
import {
  addRateChange,
  assignTransactionToLoan,
  listRateHistory,
  loanLedger,
  postAllDueInterest,
  postDueInterest,
  setLoanAnchor,
  unassignTransactionFromLoan,
} from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => c?.t.cleanup());

/**
 * postDueInterest is the one function that turns a closed period into a row (ledger spec P2). The
 * engine decides WHAT is due; this decides that it is written down, once, and that the stored
 * balance follows.
 */
function seedInterestLoan(over: { rateBps?: number; basis?: 'apr_monthly' | 'none'; balance?: number } = {}): number {
  c = setupLoanTest();
  const { itemId } = c.seedLoan({ balanceCents: over.balance ?? 1_000_000, principalCents: 1_000_000 });
  c.t.sqlite
    .prepare(`update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = ?, interest_rate_basis = ? where id = ?`)
    .run(over.rateBps ?? 1000, over.basis ?? 'apr_monthly', itemId);
  setLoanAnchor({
    itemId,
    asOfDate: '2026-07-01',
    balanceCents: over.balance ?? 1_000_000,
    source: 'form',
    actorUserId: c.userId,
    at: new Date('2026-07-01T12:00:00.000Z'),
  });
  c.t.sqlite
    .prepare(
      `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
       values (?, '2026-07-01', ?, ?, '2026-07-01T12:00:00.000Z')`,
    )
    .run(itemId, over.rateBps ?? 1000, over.basis ?? 'apr_monthly');
  return itemId;
}

const postings = (itemId: number) =>
  c.t.sqlite
    .prepare(`select kind, period_start, period_end, interest_cents, closing_cents from loan_postings where item_id = ? order by id`)
    .all(itemId) as { kind: string; period_start: string; period_end: string; interest_cents: number; closing_cents: number }[];

describe('postDueInterest (P2)', () => {
  it('writes every closed period since the anchor, oldest first, and moves the stored balance', () => {
    const itemId = seedInterestLoan();
    const result = postDueInterest(itemId, '2026-09-18');
    expect(result.posted.map((row) => [row.periodEnd, row.interestCents])).toEqual([
      ['2026-08-01', 8_333],
      ['2026-09-01', 8_403],
    ]);
    expect(postings(itemId).map((row) => row.period_end)).toEqual(['2026-08-01', '2026-09-01']);
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  /** Called on every payment and every night, so a second call the same day must do nothing. */
  it('is idempotent', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    expect(postDueInterest(itemId, '2026-09-18').posted).toEqual([]);
    expect(postings(itemId)).toHaveLength(2);
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  it('carries the rate and the balance it charged on into the row', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-08-02');
    const row = c.t.sqlite
      .prepare(`select rate_bps, basis, average_daily_balance_cents, payments_cents, opening_cents from loan_postings where item_id = ?`)
      .get(itemId);
    expect(row).toEqual({
      rate_bps: 1000,
      basis: 'apr_monthly',
      average_daily_balance_cents: 1_000_000,
      payments_cents: 0,
      opening_cents: 1_000_000,
    });
  });

  /** D2: a rate with no basis is still not computed from. Nothing is assumed for it. */
  it('does nothing for a loan with no basis', () => {
    c = setupLoanTest();
    const { itemId } = c.seedLoan({ balanceCents: 1_000_000 });
    expect(postDueInterest(itemId, '2026-09-18').posted).toEqual([]);
    expect(postings(itemId)).toEqual([]);
    expect(c.balanceOf(itemId)).toBe(1_000_000);
  });

  it('does nothing for a loan that has never been anchored', () => {
    c = setupLoanTest();
    const { itemId } = c.seedLoan({ balanceCents: null });
    c.t.sqlite
      .prepare(`update warranty_items set interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`)
      .run(itemId);
    expect(postDueInterest(itemId, '2026-09-18').posted).toEqual([]);
  });

  /** Interest-free still posts, at zero, so its ledger reads like every other loan's. */
  it('posts zero for an interest-free loan', () => {
    const itemId = seedInterestLoan({ rateBps: 0, basis: 'none' });
    expect(postDueInterest(itemId, '2026-09-18').posted.map((row) => row.interestCents)).toEqual([0, 0]);
    expect(c.balanceOf(itemId)).toBe(1_000_000);
  });
});

describe('postDueInterest: payments (P4)', () => {
  it('a payment mid-period lowers what that period charges', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-07-15' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-07-15T12:00:00.000Z') });
    postDueInterest(itemId, '2026-08-02');
    expect(postings(itemId).map((row) => [row.interest_cents, row.closing_cents])).toEqual([[6_048, 506_048]]);
    expect(c.balanceOf(itemId)).toBe(506_048);
  });

  /** K1/K2: the closed period is not reopened; the difference becomes one dated row. */
  it('a payment linked into a closed period writes one adjustment, and the balance matches the facts', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    const rows = postings(itemId);
    expect(rows.map((row) => row.kind)).toEqual(['posting', 'posting', 'adjustment']);
    expect(rows[2]!.period_end).toBe('2026-09-18');
    expect(rows[2]!.interest_cents).toBeLessThan(0);

    const ledger = loanLedger(itemId, '2026-09-18')!;
    expect(ledger.dueAdjustment).toBeNull();
    expect(c.balanceOf(itemId)).toBe(ledger.postedBalanceCents);
  });

  /** K3: undoing it reverses with another row. Nothing is deleted. */
  it('unlinking the late payment writes a reversing adjustment', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');
    const correction = postings(itemId)[2]!.interest_cents;

    unassignTransactionFromLoan({ txnId, itemId, at: new Date('2026-09-18T13:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    const rows = postings(itemId);
    expect(rows).toHaveLength(4);
    expect(rows[3]!.kind).toBe('adjustment');
    expect(rows[3]!.interest_cents).toBe(-correction);
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  /** The wall (K4): a movement behind the statement was already inside it. */
  it('ignores a payment dated on or before the anchor', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-06-20' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-07-02T12:00:00.000Z') });
    postDueInterest(itemId, '2026-08-02');
    expect(postings(itemId).map((row) => row.interest_cents)).toEqual([8_333]);
    expect(c.balanceOf(itemId)).toBe(1_008_333);
  });
});

describe('P4: posting happens without anyone asking', () => {
  /** The owner should never have to press anything for the ledger to be current. */
  it('posts when a payment is linked', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-07-15' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-08-02T12:00:00.000Z') });
    expect(postings(itemId).map((row) => row.interest_cents)).toEqual([6_048]);
  });

  it('posts when a payment is unlinked', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-07-15' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-08-02T12:00:00.000Z') });
    unassignTransactionFromLoan({ txnId, itemId, at: new Date('2026-08-02T13:00:00.000Z') });
    const rows = postings(itemId);
    expect(rows.map((row) => row.kind)).toEqual(['posting', 'adjustment']);
    expect(rows[0]!.interest_cents + rows[1]!.interest_cents).toBe(8_333);
  });

  it('posts when a statement is reconciled', () => {
    const itemId = seedInterestLoan();
    setLoanAnchor({
      itemId,
      asOfDate: '2026-08-01',
      balanceCents: 1_008_333,
      source: 'reconcile',
      actorUserId: c.userId,
      at: new Date('2026-09-18T12:00:00.000Z'),
    });
    expect(postings(itemId).map((row) => row.period_end)).toEqual(['2026-09-01']);
  });
});

describe('postAllDueInterest (P3)', () => {
  it('covers every loan with a basis and leaves the others alone', () => {
    const itemId = seedInterestLoan();
    const other = c.seedLoan({ name: 'No basis', balanceCents: 500_000 });
    expect(postAllDueInterest('2026-09-18')).toEqual({ items: 1, posted: 2, adjusted: 0 });
    expect(c.balanceOf(itemId)).toBe(1_016_736);
    expect(c.balanceOf(other.itemId)).toBe(500_000);
  });

  it('reports nothing to do on a second sweep', () => {
    seedInterestLoan();
    postAllDueInterest('2026-09-18');
    expect(postAllDueInterest('2026-09-18')).toEqual({ items: 0, posted: 0, adjusted: 0 });
  });
});

describe('loanLedger', () => {
  it('returns the engine’s view for a loan with a basis and an anchor', () => {
    const itemId = seedInterestLoan();
    const ledger = loanLedger(itemId, '2026-09-18')!;
    expect(ledger.owingCents).toBe(1_021_537);
    expect(ledger.rows[0]!.kind).toBe('opening');
    expect(ledger.rows.at(-1)!.kind).toBe('accrued');
  });

  it('is null without a basis', () => {
    c = setupLoanTest();
    const { itemId } = c.seedLoan({ balanceCents: 1_000_000 });
    expect(loanLedger(itemId, '2026-09-18')).toBeNull();
  });
});

describe('rate history (R1–R2)', () => {
  it('lists rows oldest first', () => {
    const itemId = seedInterestLoan();
    addRateChange({
      itemId,
      effectiveFrom: '2026-08-01',
      rateBps: 1200,
      basis: 'apr_monthly',
      actorUserId: c.userId,
      at: new Date('2026-09-18T12:00:00.000Z'),
    });
    expect(listRateHistory(itemId)).toEqual([
      { effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' },
      { effectiveFrom: '2026-08-01', rateBps: 1200, basis: 'apr_monthly' },
    ]);
  });

  it('applies the new rate from its own date and updates the item', () => {
    const itemId = seedInterestLoan();
    addRateChange({
      itemId,
      effectiveFrom: '2026-08-01',
      rateBps: 1200,
      basis: 'apr_monthly',
      actorUserId: c.userId,
      at: new Date('2026-09-18T12:00:00.000Z'),
    });
    expect(postings(itemId).map((row) => row.interest_cents)).toEqual([8_333, 10_083]);
    expect(c.t.sqlite.prepare('select interest_rate_bps from warranty_items where id = ?').get(itemId)).toEqual({
      interest_rate_bps: 1200,
    });
  });
});
