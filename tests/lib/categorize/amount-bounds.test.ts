import { describe, it, expect } from 'vitest';
import {
  amountWithinBounds,
  boundsWidth,
  defaultBoundsAround,
  isBounded,
} from '@/lib/categorize/amount-bounds';

/**
 * The owner, 2026-09-13: "insurance is with same company but different amount but imported
 * categorizes the last setting i do so everything goes to home or auto. can i set in rule vendor +
 * amount rule?"
 *
 * This module is the WHOLE of "does this amount fall inside that window" -- one predicate, shared
 * by matchRule, by the kebab dialog that prefills a window, and (later) by the loan matcher's
 * R27a tolerance. tests/ops/amount-bounds.test.ts is the guard that keeps it the only one.
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, ruling P6.
 */
describe('amountWithinBounds', () => {
  it('says yes to anything when both sides are null, which is every rule before migration 0024', () => {
    expect(amountWithinBounds(-12345, null, null)).toBe(true);
    expect(amountWithinBounds(0, null, null)).toBe(true);
  });

  it('compares the MAGNITUDE, so a refund files with the charge it reverses', () => {
    expect(amountWithinBounds(-14012, 12500, 15500)).toBe(true);
    expect(amountWithinBounds(14012, 12500, 15500)).toBe(true);
  });

  it('includes both ends, because a household typing $125 to $155 means those two amounts too', () => {
    expect(amountWithinBounds(-12500, 12500, 15500)).toBe(true);
    expect(amountWithinBounds(-15500, 12500, 15500)).toBe(true);
  });

  it('refuses an amount outside the window on either side', () => {
    expect(amountWithinBounds(-12499, 12500, 15500)).toBe(false);
    expect(amountWithinBounds(-15501, 12500, 15500)).toBe(false);
  });

  it('leaves an open side open', () => {
    expect(amountWithinBounds(-99999999, 12500, null)).toBe(true);
    expect(amountWithinBounds(-1, 12500, null)).toBe(false);
    expect(amountWithinBounds(-1, null, 15500)).toBe(true);
    expect(amountWithinBounds(-15501, null, 15500)).toBe(false);
  });
});

describe('isBounded', () => {
  it('is false only when BOTH sides are null', () => {
    expect(isBounded({ amountMinCents: null, amountMaxCents: null })).toBe(false);
    expect(isBounded({ amountMinCents: 100, amountMaxCents: null })).toBe(true);
    expect(isBounded({ amountMinCents: null, amountMaxCents: 100 })).toBe(true);
    expect(isBounded({ amountMinCents: 100, amountMaxCents: 200 })).toBe(true);
  });
});

describe('boundsWidth', () => {
  it('is the span between the two ends', () => {
    expect(boundsWidth({ amountMinCents: 12500, amountMaxCents: 15500 })).toBe(3000);
  });

  /**
   * An open side is infinitely wide, which is what makes the P4 tie-break "narrower wins" say the
   * right thing about `[$125, up]` against `[$125, $155]`: the half-open rule claims every larger
   * charge the merchant ever makes, so it is the less specific of the two.
   */
  it('is Infinity when either side is open, and for a wholly unbounded rule', () => {
    expect(boundsWidth({ amountMinCents: 12500, amountMaxCents: null })).toBe(Number.POSITIVE_INFINITY);
    expect(boundsWidth({ amountMinCents: null, amountMaxCents: 15500 })).toBe(Number.POSITIVE_INFINITY);
    expect(boundsWidth({ amountMinCents: null, amountMaxCents: null })).toBe(Number.POSITIVE_INFINITY);
  });
});

/**
 * The kebab dialog's prefill (ruling P6/Q6): the household thinks "about this much", and this is
 * what "about" computes to before they see and can edit it. Whole dollars, outward, so the two
 * numbers on screen are the kind a person would have typed themselves.
 */
describe('defaultBoundsAround', () => {
  it('is 10% either side of the magnitude, rounded outward to whole dollars', () => {
    // $130.00 -> +/- $13.00 -> $117.00 to $143.00.
    expect(defaultBoundsAround(-13000)).toEqual({ minCents: 11700, maxCents: 14300 });
  });

  it('rounds outward rather than to the nearest dollar, so the row it came from always matches', () => {
    // $140.12 -> +/- $14.012 -> $126.108 .. $154.132 -> floor/ceil to whole dollars.
    expect(defaultBoundsAround(-14012)).toEqual({ minCents: 12600, maxCents: 15500 });
    expect(amountWithinBounds(-14012, 12600, 15500)).toBe(true);
  });

  it('uses the magnitude, so a refund prefills the same window as the charge', () => {
    expect(defaultBoundsAround(13000)).toEqual(defaultBoundsAround(-13000));
  });

  /**
   * A $4.85 coffee would otherwise get a 48-cent window that the next price rise leaves behind on
   * the first day. The floor is a dollar each way, which is the smallest window worth storing.
   */
  it('opens to at least a dollar either side for a small amount', () => {
    expect(defaultBoundsAround(-485)).toEqual({ minCents: 300, maxCents: 600 });
  });

  it('never proposes a negative minimum, which the table refuses anyway', () => {
    expect(defaultBoundsAround(-50).minCents).toBe(0);
  });
});
