import { describe, it, expect } from 'vitest';
import { buildLedger, type LedgerInput, type StoredPosting } from '@/lib/loans/ledger';

/**
 * The whole ledger, from facts (ledger spec §6–§7).
 *
 * The A8 worked example is the owner's own loan: $10,000 at 10%, borrowed 1 July, looked at on
 * 18 September. Every figure in the first table below is pinned here, and the second table (the
 * same loan with $5,000 paid on the 15th) is pinned in the payment test.
 */
const base: LedgerInput = {
  startDate: '2026-07-01',
  startBalanceCents: 1_000_000,
  principalCents: 1_000_000,
  postingDay: 1,
  rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' }],
  movements: [],
  stored: [],
  today: '2026-09-18',
};

describe('buildLedger: the worked example (A8)', () => {
  it('finds two periods due and the accrual since', () => {
    const ledger = buildLedger(base);
    expect(ledger.duePostings.map((posting) => [posting.periodEnd, posting.interestCents, posting.closingCents])).toEqual([
      ['2026-08-01', 8_333, 1_008_333],
      ['2026-09-01', 8_403, 1_016_736],
    ]);
    expect(ledger.postedBalanceCents).toBe(1_016_736);
    expect(ledger.accruedCents).toBe(4_801);
    expect(ledger.owingCents).toBe(1_021_537);
  });

  it('lays the rows out oldest first, ending on the accrued line', () => {
    const ledger = buildLedger(base);
    expect(ledger.rows.map((row) => [row.kind, row.date, row.balanceCents])).toEqual([
      ['opening', '2026-07-01', 1_000_000],
      ['interest', '2026-08-01', 1_008_333],
      ['interest', '2026-09-01', 1_016_736],
      ['accrued', '2026-09-18', 1_021_537],
    ]);
  });

  it('reports a year at this balance', () => {
    expect(buildLedger(base).yearAtThisBalanceCents).toBe(101_674);
  });

  /** The reason the engine can be called on every page load: it agrees with itself. */
  it('is idempotent -- storing what it produced leaves nothing due', () => {
    const first = buildLedger(base);
    const second = buildLedger({ ...base, stored: first.duePostings });
    expect(second.duePostings).toEqual([]);
    expect(second.dueAdjustment).toBeNull();
    expect(second.postedBalanceCents).toBe(1_016_736);
    expect(second.owingCents).toBe(1_021_537);
    expect(second.rows.map((row) => row.kind)).toEqual(['opening', 'interest', 'interest', 'accrued']);
  });
});

describe('buildLedger: payments', () => {
  const paid: LedgerInput = { ...base, today: '2026-08-02', movements: [{ date: '2026-07-15', amountCents: -500_000 }] };

  it('lowers the period it lands in (A8, second table)', () => {
    const ledger = buildLedger(paid);
    expect(ledger.duePostings).toHaveLength(1);
    expect(ledger.duePostings[0]!.interestCents).toBe(6_048);
    expect(ledger.duePostings[0]!.closingCents).toBe(506_048);
    expect(ledger.duePostings[0]!.paymentsCents).toBe(500_000);
  });

  it('shows the payment as its own row, with what had accrued by that day', () => {
    const payment = buildLedger(paid).rows.find((row) => row.kind === 'payment')!;
    expect(payment.date).toBe('2026-07-15');
    expect(payment.paymentCents).toBe(500_000);
    expect(payment.balanceCents).toBe(500_000);
    expect(payment.interestCents).toBe(3_763); // fourteen days of the full balance
  });

  /** U3: the split is stated on the posting row, because that is the period it belongs to. */
  it('states how much of the period’s payments went on interest', () => {
    const ledger = buildLedger(paid);
    const posting = ledger.rows.find((row) => row.kind === 'interest')!;
    expect(posting.detail?.paidToInterestCents).toBe(6_048);
    expect(posting.description).toContain('covered interest');
    expect(ledger.interestPaidToDateCents).toBe(6_048);
    expect(ledger.principalPaidToDateCents).toBe(493_952);
  });

  it('shows an advance as its own row and adds it to the balance', () => {
    const ledger = buildLedger({ ...base, today: '2026-08-02', movements: [{ date: '2026-07-10', amountCents: 200_000 }] });
    const advance = ledger.rows.find((row) => row.kind === 'advance')!;
    expect(advance.principalCents).toBe(200_000);
    expect(advance.balanceCents).toBe(1_200_000);
    expect(ledger.duePostings[0]!.advancesCents).toBe(200_000);
  });

  it('counts a payment in the OPEN period against what is owing today', () => {
    const ledger = buildLedger({ ...base, movements: [{ date: '2026-09-10', amountCents: -16_736 }] });
    expect(ledger.postedBalanceCents).toBe(1_000_000);
    expect(ledger.rows.some((row) => row.kind === 'payment' && row.date === '2026-09-10')).toBe(true);
  });

  /** A payment that clears the lot leaves nothing owing, and nothing further accrues. */
  it('stops at zero', () => {
    const ledger = buildLedger({ ...base, today: '2026-07-20', movements: [{ date: '2026-07-02', amountCents: -1_000_000 }] });
    expect(ledger.postedBalanceCents).toBe(0);
    expect(ledger.owingCents).toBeLessThan(500);
  });
});

describe('buildLedger: corrections (K1–K3)', () => {
  const movements = [{ date: '2026-08-10', amountCents: -500_000 }];

  function withLatePayment(): { stored: StoredPosting[]; late: ReturnType<typeof buildLedger> } {
    const stored = buildLedger(base).duePostings;
    return { stored, late: buildLedger({ ...base, stored, movements }) };
  }

  it('does not reopen a closed period', () => {
    const { late } = withLatePayment();
    expect(late.duePostings).toEqual([]);
  });

  it('proposes one adjustment, dated today, naming what was recorded late', () => {
    const { late } = withLatePayment();
    expect(late.dueAdjustment).not.toBeNull();
    expect(late.dueAdjustment!.kind).toBe('adjustment');
    expect(late.dueAdjustment!.periodEnd).toBe('2026-09-18');
    expect(late.dueAdjustment!.note).toContain('2026-08-10');
    expect(late.dueAdjustment!.note).toContain('2026-09-01');
  });

  /** The point of the adjustment: after it, the ledger equals a from-scratch recomputation. */
  it('brings the balance back to what the facts alone say', () => {
    const { stored, late } = withLatePayment();
    const settled = buildLedger({ ...base, stored: [...stored, late.dueAdjustment!], movements });
    const truth = buildLedger({ ...base, movements });
    expect(settled.dueAdjustment).toBeNull();
    expect(settled.postedBalanceCents).toBe(truth.postedBalanceCents);
    expect(settled.owingCents).toBe(truth.owingCents);
  });

  it('shows the adjustment as its own row once it is stored', () => {
    const { stored, late } = withLatePayment();
    const settled = buildLedger({ ...base, stored: [...stored, late.dueAdjustment!], movements });
    const row = settled.rows.find((entry) => entry.kind === 'adjustment')!;
    expect(row.date).toBe('2026-09-18');
    expect(row.interestCents).toBe(late.dueAdjustment!.interestCents);
  });

  /** K3: undoing the late payment reverses the correction with another row, never a delete. */
  it('proposes a reversing adjustment when the late movement goes away', () => {
    const { stored, late } = withLatePayment();
    const settled = [...stored, late.dueAdjustment!];
    const undone = buildLedger({ ...base, stored: settled, movements: [] });
    expect(undone.dueAdjustment).not.toBeNull();
    expect(undone.dueAdjustment!.interestCents).toBe(-late.dueAdjustment!.interestCents);
    const afterUndo = buildLedger({ ...base, stored: [...settled, undone.dueAdjustment!], movements: [] });
    expect(afterUndo.dueAdjustment).toBeNull();
    expect(afterUndo.postedBalanceCents).toBe(buildLedger(base).postedBalanceCents);
  });

  it('proposes nothing when the stored rows already agree', () => {
    const stored = buildLedger(base).duePostings;
    expect(buildLedger({ ...base, stored }).dueAdjustment).toBeNull();
  });

  /** Nothing stored yet means nothing to correct: the periods simply post for the first time. */
  it('never proposes an adjustment before anything has been posted', () => {
    expect(buildLedger({ ...base, movements }).dueAdjustment).toBeNull();
  });
});

describe('buildLedger: rate changes (R1)', () => {
  it('applies a new rate from its own date and leaves the closed period alone', () => {
    const ledger = buildLedger({
      ...base,
      rateHistory: [...base.rateHistory, { effectiveFrom: '2026-08-01', rateBps: 1200, basis: 'apr_monthly' }],
    });
    expect(ledger.duePostings[0]!.interestCents).toBe(8_333);
    expect(ledger.duePostings[1]!.interestCents).toBe(10_083);
    expect(ledger.duePostings[0]!.rateBps).toBe(1000);
    expect(ledger.duePostings[1]!.rateBps).toBe(1200);
  });

  it('charges nothing for a period before the first rate row', () => {
    const ledger = buildLedger({ ...base, rateHistory: [{ effectiveFrom: '2026-09-01', rateBps: 1000, basis: 'apr_monthly' }] });
    expect(ledger.duePostings.map((posting) => posting.interestCents)).toEqual([0, 0]);
  });
});

describe('buildLedger: interest-free', () => {
  /** A $0 posting is still a posting: the ledger reads like a statement either way. */
  it('posts zero each period and accrues nothing', () => {
    const ledger = buildLedger({ ...base, rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 0, basis: 'none' }] });
    expect(ledger.duePostings.map((posting) => posting.interestCents)).toEqual([0, 0]);
    expect(ledger.accruedCents).toBe(0);
    expect(ledger.owingCents).toBe(1_000_000);
    expect(ledger.yearAtThisBalanceCents).toBe(0);
  });

  it('puts every payment against the principal', () => {
    const ledger = buildLedger({
      ...base,
      today: '2026-08-02',
      rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 0, basis: 'none' }],
      movements: [{ date: '2026-07-15', amountCents: -500_000 }],
    });
    expect(ledger.interestPaidToDateCents).toBe(0);
    expect(ledger.principalPaidToDateCents).toBe(500_000);
  });
});

describe('buildLedger: a statement mid-cycle (C2)', () => {
  /** The short period is charged as a fraction of the cycle, not as a whole month. */
  it('starts a short first period at the statement date', () => {
    const ledger = buildLedger({ ...base, startDate: '2026-08-20', startBalanceCents: 1_010_000, today: '2026-09-18' });
    expect(ledger.duePostings).toHaveLength(1);
    expect(ledger.duePostings[0]!.periodStart).toBe('2026-08-20');
    expect(ledger.duePostings[0]!.periodEnd).toBe('2026-09-01');
    expect(ledger.duePostings[0]!.interestCents).toBe(3_258); // 1,010,000 x 10%/12 x 12/31
  });
});
