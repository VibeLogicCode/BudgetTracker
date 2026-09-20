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
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let c: LoanTestContext;
afterEach(() => c?.t.cleanup());

/**
 * postDueInterest is the one function that turns a closed period into a row (ledger spec P2). The
 * engine decides WHAT is due; this decides that it is written down, once, and that the stored
 * balance follows.
 */
interface SeedOptions {
  rateBps?: number;
  basis?: 'apr_monthly' | 'none';
  balance?: number;
  name?: string;
}

/**
 * Seeds one interest-bearing loan into an EXISTING context, so a test can stand two of them side by
 * side in the same database and compare what the writer did to each.
 */
function seedInterestLoanIn(ctx: LoanTestContext, over: SeedOptions = {}): number {
  const { itemId } = ctx.seedLoan({ name: over.name, balanceCents: over.balance ?? 1_000_000, principalCents: 1_000_000 });
  ctx.t.sqlite
    .prepare(`update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = ?, interest_rate_basis = ? where id = ?`)
    .run(over.rateBps ?? 1000, over.basis ?? 'apr_monthly', itemId);
  setLoanAnchor({
    itemId,
    asOfDate: '2026-07-01',
    balanceCents: over.balance ?? 1_000_000,
    source: 'form',
    actorUserId: ctx.userId,
    at: new Date('2026-07-01T12:00:00.000Z'),
  });
  ctx.t.sqlite
    .prepare(
      `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
       values (?, '2026-07-01', ?, ?, '2026-07-01T12:00:00.000Z')`,
    )
    .run(itemId, over.rateBps ?? 1000, over.basis ?? 'apr_monthly');
  return itemId;
}

function seedInterestLoan(over: SeedOptions = {}): number {
  c = setupLoanTest();
  return seedInterestLoanIn(c, over);
}

/** Everything the writer decided, minus the identity of the row: what two loans must agree on. */
const fullPostings = (itemId: number) =>
  c.t.sqlite
    .prepare(
      `select kind, period_start, period_end, opening_cents, interest_cents, payments_cents, advances_cents, closing_cents, note
         from loan_postings where item_id = ? order by period_start, period_end`,
    )
    .all(itemId);

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
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-07-15T12:00:00.000Z') });
    postDueInterest(itemId, '2026-08-02');
    expect(postings(itemId).map((row) => [row.interest_cents, row.closing_cents])).toEqual([[6_048, 506_048]]);
    expect(c.balanceOf(itemId)).toBe(506_048);
  });

  /**
   * K2, rewritten 2026-09-20 (THE RE-CUT). This used to assert the opposite: that a payment landing
   * in a closed period left the period alone and wrote one dated correction, on the argument that a
   * lender does not restate a statement it has already sent.
   *
   * That holds for a payment imported a few days late. It did not survive a household entering a
   * year of payments by hand. Every posting after the first back-dated one had charged interest on
   * a balance that was not reduced yet, so the ledger showed a charge no reader could reproduce
   * from the balance printed beside it, with the whole difference swept into correction rows at the
   * bottom -- and each correction re-listed every earlier payment while carrying only its own
   * increment. The totals were right to the penny; the page was unreadable.
   *
   * Rows the app worked out itself are not a statement. They are re-cut. A confirmed statement is
   * still untouchable, which is what the next test pins.
   */
  it('a payment linked into a closed period re-cuts that period instead of correcting it', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    const rows = postings(itemId);
    expect(rows.map((row) => row.kind)).toEqual(['posting', 'posting']);
    // The period the payment fell in charges on the reduced balance, not on the old one.
    expect(rows[1]!.period_end).toBe('2026-09-01');
    expect(rows[1]!.interest_cents).toBeLessThan(rows[0]!.interest_cents);

    const ledger = loanLedger(itemId, '2026-09-18')!;
    expect(ledger.dueAdjustment).toBeNull();
    expect(c.balanceOf(itemId)).toBe(ledger.postedBalanceCents);
  });

  /**
   * The point of the whole change: WHEN a payment was entered must not change what the ledger says.
   * Two identical loans, the same payment on the same day -- one linked the week it happened, one
   * entered after every period had already been posted. Every stored row must match.
   */
  it('a back-dated payment lands the same rows as the same payment entered on the day', () => {
    c = setupLoanTest();
    const timely = seedInterestLoanIn(c, { name: 'Entered on the day' });
    const late = seedInterestLoanIn(c, { name: 'Entered months later' });

    const onTime = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: onTime, itemId: timely, at: new Date('2026-08-10T12:00:00.000Z') });
    postDueInterest(timely, '2026-09-18');

    postDueInterest(late, '2026-09-18');
    const afterTheFact = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: afterTheFact, itemId: late, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(late, '2026-09-18');

    expect(fullPostings(late)).toEqual(fullPostings(timely));
    expect(c.balanceOf(late)).toBe(c.balanceOf(timely));
  });

  /**
   * THE WALL. The re-cut is allowed to delete the app's own estimates and nothing else. A period a
   * statement confirmed is behind the anchor, and the delete is bounded by the same anchor date the
   * three readers filter on.
   */
  it('re-cutting never touches a period a statement already confirmed', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const confirmed = postings(itemId)[0]!;
    setLoanAnchor({
      itemId,
      asOfDate: '2026-08-01',
      balanceCents: confirmed.closing_cents,
      source: 'reconcile',
      actorUserId: c.userId,
      at: new Date('2026-09-18T11:00:00.000Z'),
    });

    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    const survivor = postings(itemId).find((row) => row.period_start === '2026-07-01');
    expect(survivor).toEqual(confirmed);
  });

  /** K3: undoing it puts the ledger back to what it said before, by the same route. */
  it('unlinking the late payment re-cuts the period back', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const before = fullPostings(itemId);
    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    unassignTransactionFromLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-09-18T13:00:00.000Z') });
    postDueInterest(itemId, '2026-09-18');

    expect(fullPostings(itemId)).toEqual(before);
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  /** The wall (K4): a movement behind the statement was already inside it. */
  it('ignores a payment dated on or before the anchor', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-06-20' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-07-02T12:00:00.000Z') });
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
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-08-02T12:00:00.000Z') });
    expect(postings(itemId).map((row) => row.interest_cents)).toEqual([6_048]);
  });

  it('posts when a payment is unlinked', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-07-15' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-08-02T12:00:00.000Z') });
    unassignTransactionFromLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-08-02T13:00:00.000Z') });
    // The re-cut (2026-09-20) reaches this path too: the period is posted again without the
    // payment rather than left standing beside a row that cancels it out.
    const rows = postings(itemId);
    expect(rows.map((row) => row.kind)).toEqual(['posting']);
    expect(rows[0]!.interest_cents).toBe(8_333);
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
    expect(postAllDueInterest('2026-09-18')).toEqual({ items: 1, posted: 2, adjusted: 0, failed: 0 });
    expect(c.balanceOf(itemId)).toBe(1_016_736);
    expect(c.balanceOf(other.itemId)).toBe(500_000);
  });

  it('reports nothing to do on a second sweep', () => {
    seedInterestLoan();
    postAllDueInterest('2026-09-18');
    expect(postAllDueInterest('2026-09-18')).toEqual({ items: 0, posted: 0, adjusted: 0, failed: 0 });
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

/**
 * Review A1/A2/A4/A11. The wall, atomicity, and one bad loan not starving the rest.
 */
describe('the wall selects by the period a row belongs to (A1)', () => {
  it('a statement supersedes a correction to a period that began before it', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    /*
      A RATE corrected after the periods closed, not a back-dated payment: since 2026-09-20 a
      payment re-cuts its period and leaves no correction behind, so it can no longer stand up the
      row this test is about. A rate is the case the adjustment path still owns -- the movements
      are right and only the charge was wrong, so there is nothing to re-cut.
    */
    addRateChange({
      itemId,
      effectiveFrom: '2026-07-15',
      rateBps: 1600,
      basis: 'apr_monthly',
      actorUserId: c.userId,
      at: new Date('2026-09-18T12:00:00.000Z'),
    });
    postDueInterest(itemId, '2026-09-18');
    expect(postings(itemId).some((row) => row.kind === 'adjustment')).toBe(true);

    setLoanAnchor({
      itemId,
      asOfDate: '2026-09-01',
      balanceCents: 510_000,
      source: 'reconcile',
      actorUserId: c.userId,
      at: new Date('2026-09-18T13:00:00.000Z'),
    });

    // Everything that began before 2026-09-01 is inside the statement now: both postings and the
    // correction that fixed one of them. Nothing may be re-applied on top.
    expect(c.balanceOf(itemId)).toBe(510_000);
    const ledger = loanLedger(itemId, '2026-09-18')!;
    expect(ledger.postedBalanceCents).toBe(510_000);
    expect(ledger.rows.filter((row) => row.kind === 'adjustment')).toHaveLength(0);
  });
});

describe('reconcile is atomic (A2)', () => {
  it('a mid-cycle statement leaves the balance at the statement, not the statement plus a month', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    setLoanAnchor({
      itemId,
      asOfDate: '2026-08-15',
      balanceCents: 1_000_000,
      source: 'reconcile',
      actorUserId: c.userId,
      at: new Date('2026-09-18T12:00:00.000Z'),
    });
    const after = postings(itemId).filter((row) => row.period_start >= '2026-08-15');
    expect(after.map((row) => [row.period_start, row.period_end])).toEqual([['2026-08-15', '2026-09-01']]);
    // 1,000,000 at 10%/12, seventeen of thirty-one days.
    expect(after[0]!.interest_cents).toBe(4_570);
    expect(c.balanceOf(itemId)).toBe(1_004_570);
  });

  it('an older statement entered after a newer one compares against the anchor before it (A11)', () => {
    const itemId = seedInterestLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 1_016_736, source: 'reconcile', actorUserId: c.userId });
    setLoanAnchor({ itemId, asOfDate: '2026-08-01', balanceCents: 1_008_000, source: 'reconcile', actorUserId: c.userId });
    // The newest BY DATE still governs the balance.
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });
});

describe('one bad loan does not starve the sweep (A4)', () => {
  it('isolates a loan whose engine cannot walk its dates, and counts it', () => {
    const good = seedInterestLoan();
    const bad = c.seedLoan({ name: 'Bad', balanceCents: 100, principalCents: 100 });
    c.t.sqlite
      .prepare(
        `update warranty_items set purchase_date = '1900-01-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`,
      )
      .run(bad.itemId);
    c.t.sqlite
      .prepare(
        `insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (?, '1900-01-01', 100, 'migrated', '2026-01-01T00:00:00.000Z')`,
      )
      .run(bad.itemId);
    c.t.sqlite
      .prepare(
        `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at) values (?, '1900-01-01', 1000, 'apr_monthly', '2026-01-01T00:00:00.000Z')`,
      )
      .run(bad.itemId);

    const result = postAllDueInterest('2026-09-18');
    expect(result.failed).toBe(1);
    expect(c.balanceOf(good)).toBe(1_016_736);
  });
});
