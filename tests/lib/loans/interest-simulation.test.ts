import { describe, it, expect } from 'vitest';
import { chargeCents, ratePpb, simulate, type SimulateInput } from '@/lib/loans/interest';

/**
 * The month-by-month simulation. Ruling I1's two buckets -- principal, and a pot holding interest
 * that has been charged but not yet paid -- with owing = principal + pot.
 *
 * ORDER WITHIN A MONTH, which the spec's worked example pins exactly: the month's charge is computed
 * on the opening balance and posted, and THEN that month's payments drain it, interest first
 * (ruling I9). $300,000 at 5% with an $1,800 payment gives $1,250 interest and $550 principal, which
 * is only true if the charge is available to be paid by the payment arriving in the same month.
 *
 * Every movement here is already SIGNED IN THE LOAN'S FRAME -- negative reduces what is owed,
 * positive increases it -- because the caller applies `loanSignedDelta` before anything reaches this
 * module (ruling P4/I16). That is why nothing below mentions which way the loan points.
 */
const pct = (percent: number): number => Math.round(percent * 100);

const anchored = (over: Partial<SimulateInput> = {}) =>
  simulate({
    anchorDate: '2026-01-01',
    anchorBalanceCents: 30_000_000,
    basis: 'apr_monthly',
    rateBps: pct(5),
    principalCents: null,
    movements: [],
    asOf: '2026-01-31',
    ...over,
  });

describe('simulate: the worked example, end to end', () => {
  it('splits an $1,800 payment into $1,250 interest and $550 principal', () => {
    const january = anchored({ movements: [{ date: '2026-01-15', amountCents: -180_000 }] }).months[0]!;
    expect(january.chargedCents).toBe(125_000);
    expect(january.interestPaidCents).toBe(125_000);
    expect(january.principalPaidCents).toBe(55_000);
  });

  it('leaves $299,450 owing, with nothing unpaid in the pot', () => {
    const result = anchored({ movements: [{ date: '2026-01-15', amountCents: -180_000 }] });
    expect(result.owingCents).toBe(29_945_000);
    expect(result.potCents).toBe(0);
  });

  /** The balance fell, so the next month's charge is lower. That is what amortising means. */
  it('charges less the next month, because the balance came down', () => {
    const result = anchored({
      movements: [
        { date: '2026-01-15', amountCents: -180_000 },
        { date: '2026-02-15', amountCents: -180_000 },
      ],
      asOf: '2026-02-28',
    });
    expect(result.months[1]!.chargedCents).toBe(124_771);
  });
});

describe('simulate: allocation (I9)', () => {
  it('puts every cent of an overpayment against principal', () => {
    const january = anchored({ movements: [{ date: '2026-01-15', amountCents: -500_000 }] }).months[0]!;
    expect(january.interestPaidCents).toBe(125_000);
    expect(january.principalPaidCents).toBe(375_000);
  });

  /** The case worth naming on screen: this month the loan grew. */
  it('leaves interest owing when a payment does not cover it, and says so', () => {
    const result = anchored({ movements: [{ date: '2026-01-15', amountCents: -100_000 }] });
    expect(result.months[0]!.shortfall).toBe(true);
    expect(result.potCents).toBe(25_000);
    expect(result.owingCents).toBe(30_025_000);
  });

  it('carries unpaid interest into the balance the next month is charged on', () => {
    const result = anchored({ movements: [{ date: '2026-01-15', amountCents: -100_000 }], asOf: '2026-02-28' });
    expect(result.months[1]!.openingCents).toBe(30_025_000);
  });

  it('does not call a month with no payment at all a shortfall', () => {
    expect(anchored({}).months[0]!.shortfall).toBe(false);
  });
});

describe('simulate: the anchor month is pro-rated by days (I7)', () => {
  it('charges a whole month when the statement is dated the 1st', () => {
    expect(anchored({}).months[0]!.chargedCents).toBe(125_000);
  });

  /** From the 10th of a 30-day month through month end is 21 days, so 21/30 of a month. */
  it('charges 21/30 of a month from the 10th of April', () => {
    const result = anchored({ anchorDate: '2026-04-10', asOf: '2026-04-30' });
    expect(result.months[0]!.chargedCents).toBe(Math.floor((125_000 * 21) / 30 + 0.5));
  });

  /**
   * May is charged for a whole month -- but on ITS opening balance, which is higher than April's
   * because April's interest went unpaid and joined the loan (ruling I1). Asserting a flat $1,250
   * here would be asserting that unpaid interest vanishes.
   */
  it('charges a whole month after the anchor month, on the balance as it then stood', () => {
    const result = anchored({ anchorDate: '2026-04-10', asOf: '2026-05-31' });
    const may = result.months[1]!;
    expect(may.chargedCents).toBe(chargeCents(may.openingCents, ratePpb(pct(5), 'apr_monthly')));
    expect(may.chargedCents).toBeGreaterThan(result.months[0]!.chargedCents);
  });
});

describe('simulate: interest-free', () => {
  it('charges nothing, ever', () => {
    const result = anchored({ basis: 'none', rateBps: 0, movements: [{ date: '2026-01-15', amountCents: -180_000 }] });
    expect(result.months[0]!.chargedCents).toBe(0);
    expect(result.interestSinceAnchorCents).toBe(0);
  });

  it('puts every payment against principal', () => {
    const result = anchored({ basis: 'none', rateBps: 0, movements: [{ date: '2026-01-15', amountCents: -180_000 }] });
    expect(result.owingCents).toBe(29_820_000);
    expect(result.months[0]!.principalPaidCents).toBe(180_000);
  });
});

describe('simulate: flat on the original amount', () => {
  /** $10,000 at 5% is $41.67 a month whatever the balance does -- that is what flat means. */
  it('charges the same every month as the balance falls', () => {
    const result = simulate({
      anchorDate: '2026-01-01',
      anchorBalanceCents: 1_000_000,
      basis: 'simple_on_principal',
      rateBps: pct(5),
      principalCents: 1_000_000,
      movements: [
        { date: '2026-01-15', amountCents: -20_000 },
        { date: '2026-02-15', amountCents: -20_000 },
      ],
      asOf: '2026-02-28',
    });
    expect(result.months[0]!.chargedCents).toBe(4_167);
    expect(result.months[1]!.chargedCents).toBe(4_167);
  });

  /** A settled loan does not keep earning interest. */
  it('stops once nothing is owed', () => {
    const result = simulate({
      anchorDate: '2026-01-01',
      anchorBalanceCents: 1_000_000,
      basis: 'simple_on_principal',
      rateBps: pct(5),
      principalCents: 1_000_000,
      movements: [{ date: '2026-01-15', amountCents: -1_004_167 }],
      asOf: '2026-03-31',
    });
    expect(result.owingCents).toBe(0);
    expect(result.months[1]!.chargedCents).toBe(0);
  });
});

describe('simulate: daily accrual on a revolving balance', () => {
  const loc = (over: Partial<SimulateInput> = {}) =>
    simulate({
      anchorDate: '2026-04-01',
      anchorBalanceCents: 2_000_000,
      basis: 'apr_daily',
      rateBps: pct(8),
      principalCents: null,
      movements: [],
      asOf: '2026-04-30',
      ...over,
    });

  /** $20,000 at 8% over a 30-day month, accrued daily and posted once. */
  it('accrues day by day and posts once at month end', () => {
    expect(loc().months[0]!.chargedCents).toBe(13_151);
  });

  /**
   * A draw is money IN to chequing assigned to the loan -- a positive delta in the loan's frame,
   * which `link()` already applies in full with no clamp (ruling L1). It raises the balance, and
   * from that day on it accrues.
   */
  it('a mid-month advance accrues from the day it lands, to the cent', () => {
    const drawn = loc({ movements: [{ date: '2026-04-21', amountCents: 500_000 }] });
    // 21 April through 30 April inclusive is 10 days of the extra $5,000.
    const extra = Math.floor((10 * 500_000 * ratePpb(pct(8), 'apr_daily')) / 1_000_000_000 + 0.5);
    expect(drawn.months[0]!.chargedCents - loc().months[0]!.chargedCents).toBe(extra);
  });

  it('accrues less after a repayment, from the day it lands', () => {
    expect(loc({ movements: [{ date: '2026-04-11', amountCents: -1_000_000 }] }).months[0]!.chargedCents).toBeLessThan(13_151);
  });

  it('reports an advance apart from a payment -- they are not the same event', () => {
    const drawn = loc({ movements: [{ date: '2026-04-21', amountCents: 500_000 }] });
    expect(drawn.months[0]!.advancedCents).toBe(500_000);
    expect(drawn.months[0]!.principalPaidCents).toBe(0);
  });
});

describe('simulate: what it reports overall', () => {
  it('totals the interest charged since the anchor', () => {
    const result = anchored({
      movements: [
        { date: '2026-01-15', amountCents: -180_000 },
        { date: '2026-02-15', amountCents: -180_000 },
      ],
      asOf: '2026-02-28',
    });
    expect(result.interestSinceAnchorCents).toBe(125_000 + 124_771);
  });

  it('runs a row for every month from the anchor to the as-of date', () => {
    expect(anchored({ asOf: '2026-03-31' }).months.map((month) => month.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
  });

  /**
   * The wall (ruling R5). A statement figure already contains every movement up to its date, so a
   * movement dated on or before the anchor must not move the balance a second time.
   */
  it('ignores movements dated on or before the anchor', () => {
    const result = anchored({
      movements: [
        { date: '2025-12-20', amountCents: -500_000 },
        { date: '2026-01-01', amountCents: -500_000 },
      ],
    });
    expect(result.months[0]!.principalPaidCents).toBe(0);
    expect(result.owingCents).toBe(30_125_000);
  });

  it('never reports a negative balance', () => {
    expect(anchored({ movements: [{ date: '2026-01-15', amountCents: -99_999_999 }] }).owingCents).toBe(0);
  });

  /** Nothing to estimate before a person has confirmed a figure. */
  it('returns no months when the as-of date precedes the anchor', () => {
    expect(anchored({ asOf: '2025-12-31' }).months).toEqual([]);
  });
});
