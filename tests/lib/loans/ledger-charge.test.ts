import { describe, it, expect } from 'vitest';
import { periodCharge, rateOn, type RateInForce } from '@/lib/loans/ledger';

/**
 * What one period costs (ledger spec A2–A6), and which rate applied to it (R1).
 *
 * The figures below are PINS. Three of them are the same numbers v1.47.0 pinned, and they are
 * repeated here rather than referenced because the whole claim of this release is that moving from
 * calendar months to a posting cycle changed nothing about what an unchanged balance costs.
 */
const apr10 = (from = '2026-01-01'): RateInForce => ({ effectiveFrom: from, rateBps: 1000, basis: 'apr_monthly' });

describe('periodCharge: an unchanged balance (A3)', () => {
  it('charges a twelfth of the yearly rate', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-08-01',
      openingCents: 1_000_000,
      principalCents: 1_000_000,
      movements: [],
      rate: apr10(),
    });
    expect(charge.interestCents).toBe(8_333);
    expect(charge.averageDailyBalanceCents).toBe(1_000_000);
    expect(charge.daysInPeriod).toBe(31);
    expect(charge.daysCounted).toBe(31);
  });

  /** The v1.47.0 pins, unchanged: $300,000 at 5%, and the two that are not a twelfth. */
  it('reproduces every pinned basis figure', () => {
    const on = (basis: InterestBasisName, bps: number, opening = 30_000_000, principal = 30_000_000) =>
      periodCharge({
        start: '2026-07-01',
        end: '2026-08-01',
        openingCents: opening,
        principalCents: principal,
        movements: [],
        rate: { effectiveFrom: '2026-01-01', rateBps: bps, basis },
      }).interestCents;

    expect(on('apr_monthly', 500)).toBe(125_000);
    expect(on('per_month', 50)).toBe(150_000);
    // The Canadian mortgage convention: about $13 a month below a plain twelfth, which is the
    // whole reason it is its own basis.
    expect(on('apr_semiannual', 500)).toBeGreaterThan(123_500);
    expect(on('apr_semiannual', 500)).toBeLessThan(123_800);
    // Charged on the ORIGINAL amount, so repaying most of it changes nothing.
    expect(on('simple_on_principal', 500, 400_000, 1_000_000)).toBe(4_167);
  });

  it('reproduces the daily pin over thirty days', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-07-31',
      openingCents: 2_000_000,
      principalCents: null,
      movements: [],
      rate: { effectiveFrom: '2026-01-01', rateBps: 800, basis: 'apr_daily' },
    });
    expect(charge.daysCounted).toBe(30);
    expect(charge.interestCents).toBe(13_151);
  });
});

describe('periodCharge: a balance that moves (A2)', () => {
  /**
   * The owner's own question: $10,000 at 10%, $5,000 paid on the 15th. Fourteen days at the full
   * balance, seventeen at half, so the month costs $60.48 rather than $83.33.
   */
  it('charges the average daily balance, not the opening one', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-08-01',
      openingCents: 1_000_000,
      principalCents: 1_000_000,
      movements: [{ date: '2026-07-15', amountCents: -500_000 }],
      rate: apr10(),
    });
    expect(charge.averageDailyBalanceCents).toBe(725_806);
    expect(charge.interestCents).toBe(6_048);
  });

  it('an advance mid-period raises it the same way', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-08-01',
      openingCents: 1_000_000,
      principalCents: 1_000_000,
      movements: [{ date: '2026-07-15', amountCents: 500_000 }],
      rate: apr10(),
    });
    expect(charge.averageDailyBalanceCents).toBe(1_274_194);
    expect(charge.interestCents).toBe(10_618);
  });

  /** simple_on_principal ignores the balance entirely -- that is what makes it flat. */
  it('leaves simple_on_principal untouched by a payment', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-08-01',
      openingCents: 1_000_000,
      principalCents: 1_000_000,
      movements: [{ date: '2026-07-02', amountCents: -900_000 }],
      rate: { effectiveFrom: '2026-01-01', rateBps: 500, basis: 'simple_on_principal' },
    });
    expect(charge.interestCents).toBe(4_167);
  });
});

describe('periodCharge: part of a period (A5)', () => {
  /** "So far" stops at the day BEFORE today: today is not over, so it has not been owed yet. */
  it('counts the days already gone and pro-rates by them', () => {
    const charge = periodCharge({
      start: '2026-09-01',
      end: '2026-10-01',
      upTo: '2026-09-18',
      openingCents: 1_016_736,
      principalCents: 1_000_000,
      movements: [],
      rate: apr10(),
    });
    expect(charge.daysCounted).toBe(17);
    expect(charge.daysInPeriod).toBe(30);
    expect(charge.interestCents).toBe(4_801);
  });

  it('charges nothing on the period’s first day', () => {
    const charge = periodCharge({
      start: '2026-09-01',
      end: '2026-10-01',
      upTo: '2026-09-01',
      openingCents: 1_000_000,
      principalCents: null,
      movements: [],
      rate: apr10(),
    });
    expect(charge.daysCounted).toBe(0);
    expect(charge.interestCents).toBe(0);
  });

  it('an upTo beyond the period charges the whole period, never more', () => {
    const whole = periodCharge({
      start: '2026-09-01',
      end: '2026-10-01',
      openingCents: 1_000_000,
      principalCents: null,
      movements: [],
      rate: apr10(),
    });
    const clamped = periodCharge({
      start: '2026-09-01',
      end: '2026-10-01',
      upTo: '2026-12-25',
      openingCents: 1_000_000,
      principalCents: null,
      movements: [],
      rate: apr10(),
    });
    expect(clamped.interestCents).toBe(whole.interestCents);
  });

  /**
   * A short first period after a mid-cycle statement (C2) costs a FRACTION OF THE CYCLE it belongs
   * to, not a whole periodic rate. Twelve days of a thirty-one day cycle, not twelve days of a
   * twelve-day one -- otherwise anchoring to a statement would charge a full month for a fortnight.
   */
  it('pro-rates a short period by the cycle it is a fragment of', () => {
    const charge = periodCharge({
      start: '2026-08-20',
      end: '2026-09-01',
      cycleDays: 31,
      openingCents: 1_000_000,
      principalCents: null,
      movements: [],
      rate: apr10(),
    });
    expect(charge.daysInPeriod).toBe(12);
    expect(charge.interestCents).toBe(3_226); // 8,333 x 12/31
  });

  it('charges a full periodic rate when no cycle length is given', () => {
    const charge = periodCharge({
      start: '2026-08-20',
      end: '2026-09-01',
      openingCents: 1_000_000,
      principalCents: null,
      movements: [],
      rate: apr10(),
    });
    expect(charge.interestCents).toBe(8_333);
  });
});

describe('periodCharge: nothing to charge', () => {
  it('charges nothing with no rate at all', () => {
    expect(
      periodCharge({
        start: '2026-07-01',
        end: '2026-08-01',
        openingCents: 1_000_000,
        principalCents: null,
        movements: [],
        rate: null,
      }),
    ).toMatchObject({ interestCents: 0, averageDailyBalanceCents: 1_000_000 });
  });

  /** Interest-free is a real state, not an absence: it still reports the balance it did not charge. */
  it('charges nothing when the basis is none, and still reports the balance', () => {
    const charge = periodCharge({
      start: '2026-07-01',
      end: '2026-08-01',
      openingCents: 1_000_000,
      principalCents: null,
      movements: [{ date: '2026-07-15', amountCents: -500_000 }],
      rate: { effectiveFrom: '2026-01-01', rateBps: 0, basis: 'none' },
    });
    expect(charge.interestCents).toBe(0);
    expect(charge.averageDailyBalanceCents).toBe(725_806);
  });

  it('charges nothing on a balance that is already zero', () => {
    expect(
      periodCharge({
        start: '2026-07-01',
        end: '2026-08-01',
        openingCents: 0,
        principalCents: null,
        movements: [],
        rate: apr10(),
      }).interestCents,
    ).toBe(0);
  });
});

describe('rateOn (R1)', () => {
  const history: RateInForce[] = [apr10('2026-01-01'), { effectiveFrom: '2026-08-15', rateBps: 1200, basis: 'apr_monthly' }];

  it('picks the newest row on or before the date', () => {
    expect(rateOn('2026-08-14', history)?.rateBps).toBe(1000);
    expect(rateOn('2026-08-15', history)?.rateBps).toBe(1200);
    expect(rateOn('2027-01-01', history)?.rateBps).toBe(1200);
  });

  it('is null before the first row, so a period before any rate charges nothing', () => {
    expect(rateOn('2025-12-31', history)).toBeNull();
  });

  it('is null for an empty history', () => {
    expect(rateOn('2026-08-15', [])).toBeNull();
  });
});

type InterestBasisName = RateInForce['basis'];
