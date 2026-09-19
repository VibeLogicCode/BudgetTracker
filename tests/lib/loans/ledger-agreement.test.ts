import { describe, it, expect } from 'vitest';
import { buildLedger, type LedgerInput, type Movement, type StoredPosting } from '@/lib/loans/ledger';

/**
 * THE ONE BALANCE RULE (review findings A5, B5).
 *
 * v1.48.0 had three clamping models -- one per period in the truth walk, one at the end of the
 * stored replay, and one per movement in the row walk. They disagreed, and the difference was
 * written down as "interest". The reviewer's reproduction showed a loan whose card said $0.00, whose
 * ledger said $2.03, and which sent a "paid off" notification at the same time.
 *
 * These tests pin the property that replaces all three: whatever a household has done, storing what
 * the engine says is due and then asking again must leave nothing due, and the rows must end on the
 * same figure the engine reports.
 */

/** A tiny deterministic PRNG, so a failing seed reproduces exactly. */
function rng(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

describe('the three balances agree for any history', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    it(`seed ${seed}: the stored replay plus its adjustment equals the truth, and the rows end on it`, () => {
      const random = rng(seed);
      const movements: Movement[] = [];
      for (let index = 0; index < 12; index += 1) {
        const day = 1 + Math.floor(random() * 27);
        const month = 7 + Math.floor(random() * 3);
        movements.push({
          date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          amountCents: Math.round((random() - 0.3) * 400_000),
        });
      }
      movements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      const base: LedgerInput = {
        startDate: '2026-07-01',
        startBalanceCents: 1_000_000,
        principalCents: 1_000_000,
        postingDay: 1 + Math.floor(random() * 28),
        rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 100 + Math.floor(random() * 2000), basis: 'apr_monthly' }],
        movements: [],
        stored: [],
        today: '2026-10-15',
      };

      // Post with half the movements known, then learn the rest late -- the shape that produces a
      // correction in the first place.
      const early = movements.slice(0, 6);
      const stored: StoredPosting[] = buildLedger({ ...base, movements: early }).duePostings;
      const late = buildLedger({ ...base, stored, movements });
      const settledStored = late.dueAdjustment === null ? stored : [...stored, late.dueAdjustment];
      const settled = buildLedger({ ...base, stored: settledStored, movements });
      const truth = buildLedger({ ...base, movements });

      expect(settled.dueAdjustment).toBeNull();
      expect(settled.duePostings).toEqual([]);
      expect(settled.postedBalanceCents).toBe(truth.postedBalanceCents);
      const lastStated = settled.rows.filter((row) => row.kind !== 'accrued').at(-1)!;
      expect(lastStated.balanceCents).toBe(settled.postedBalanceCents);
    });
  }
});

describe('the reviewer’s own reproduction', () => {
  /** Anchor $100, 1% a month, posting day 1; a $103.03 payment imported after three postings. */
  const base: LedgerInput = {
    startDate: '2026-06-01',
    startBalanceCents: 10_000,
    principalCents: 10_000,
    postingDay: 1,
    rateHistory: [{ effectiveFrom: '2026-06-01', rateBps: 100, basis: 'per_month' }],
    movements: [],
    stored: [],
    today: '2026-09-19',
  };
  const late: Movement[] = [{ date: '2026-07-10', amountCents: -10_303 }];

  it('settles to one figure instead of three', () => {
    const stored = buildLedger(base).duePostings;
    const withLate = buildLedger({ ...base, stored, movements: late });
    const settled = buildLedger({
      ...base,
      stored: withLate.dueAdjustment === null ? stored : [...stored, withLate.dueAdjustment],
      movements: late,
    });
    const truth = buildLedger({ ...base, movements: late });
    expect(settled.postedBalanceCents).toBe(truth.postedBalanceCents);
    expect(settled.dueAdjustment).toBeNull();
    expect(settled.rows.filter((row) => row.kind !== 'accrued').at(-1)!.balanceCents).toBe(settled.postedBalanceCents);
  });
});

describe('a payment applies only what is owed', () => {
  /**
   * MUST-11.14, which loan_payments.applied_cents has always enforced in the database. The engine
   * now enforces it too, in the same place for every figure it reports -- so an overpayment cannot
   * become a negative balance in one reading and a clamped one in another.
   */
  it('caps a payment at the running balance in the period figures and in the rows', () => {
    const ledger = buildLedger({
      startDate: '2026-07-01',
      startBalanceCents: 10_000,
      principalCents: 10_000,
      postingDay: 1,
      rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 1200, basis: 'per_month' }],
      movements: [{ date: '2026-07-10', amountCents: -50_000 }],
      stored: [],
      today: '2026-08-02',
    });
    // Applied is capped at the $100 owed, not the $500 offered.
    expect(ledger.duePostings[0]!.paymentsCents).toBe(10_000);
    expect(ledger.rows.find((row) => row.kind === 'payment')!.paymentCents).toBe(10_000);
    // Nine days of interest had already accrued before the payment landed, so the period closes on
    // that and not on zero -- the cap applies to the payment, never to what was genuinely charged.
    expect(ledger.duePostings[0]!.closingCents).toBe(348);
    expect(ledger.postedBalanceCents).toBe(348);
  });

  it('leaves an advance uncapped', () => {
    const ledger = buildLedger({
      startDate: '2026-07-01',
      startBalanceCents: 10_000,
      principalCents: 10_000,
      postingDay: 1,
      rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 0, basis: 'none' }],
      movements: [{ date: '2026-07-10', amountCents: 50_000 }],
      stored: [],
      today: '2026-08-02',
    });
    expect(ledger.duePostings[0]!.advancesCents).toBe(50_000);
    expect(ledger.duePostings[0]!.closingCents).toBe(60_000);
  });
});
