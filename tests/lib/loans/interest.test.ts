import { describe, it, expect } from 'vitest';
import { ratePpb, chargeCents, type InterestBasis } from '@/lib/loans/interest';

/**
 * 2026-09-18, ruling I8 of docs/superpowers/specs/2026-09-18-loan-interest-design.md.
 *
 * THE RATE BECOMES ONE INTEGER, in parts per billion, derived once from (basis points, basis). Every
 * charge is then `balanceCents × ppb / 1e9` rounded to whole cents. The point of the detour through
 * an integer is that no float ever carries a MONEY value between steps: the only non-integer
 * operation in the whole feature is a sixth root, and it is applied to a RATE.
 *
 * Every figure asserted below is hand-computed in the spec and repeated here so a failure says which
 * convention broke rather than only that a number moved.
 *
 * WHAT THIS FILE DOES NOT COVER: which basis a loan should use. That is a person's answer on the
 * form, never a guess this module makes -- ruling I5.
 */
const pct = (percent: number): number => Math.round(percent * 100);

describe('ratePpb: each basis reads the same rate differently', () => {
  /** The ordinary case: a yearly rate, one twelfth of it charged each month. */
  it('apr_monthly divides the yearly rate by twelve', () => {
    expect(ratePpb(pct(5), 'apr_monthly')).toBe(4166667);
  });

  /** A rate already quoted per month is used as it stands. */
  it('per_month uses the rate as given', () => {
    expect(ratePpb(pct(0.5), 'per_month')).toBe(5000000);
  });

  /**
   * The Canadian mortgage convention, and the reason the option exists: compounded twice a year, so
   * the monthly factor is the sixth root of the half-yearly one -- about 1% BELOW rate/12. A lender
   * statement makes the difference obvious immediately.
   */
  it('apr_semiannual takes the sixth root, landing below rate/12', () => {
    const semi = ratePpb(pct(5), 'apr_semiannual');
    expect(semi).toBeGreaterThan(4_100_000);
    expect(semi).toBeLessThan(ratePpb(pct(5), 'apr_monthly'));
  });

  /** Daily accrual for a revolving balance. 365 fixed; leap years are ignored and the help says so. */
  it('apr_daily divides the yearly rate by 365', () => {
    expect(ratePpb(pct(8), 'apr_daily')).toBe(219178);
  });

  /** Charged on the ORIGINAL amount, so the per-period rate is the same shape as apr_monthly. */
  it('simple_on_principal is a twelfth of the yearly rate, like apr_monthly', () => {
    expect(ratePpb(pct(5), 'simple_on_principal')).toBe(ratePpb(pct(5), 'apr_monthly'));
  });

  /** An interest-free loan is a positive claim, not an absence: the rate is zero, and stays zero. */
  it('none is always zero, whatever rate was typed', () => {
    expect(ratePpb(pct(5), 'none')).toBe(0);
    expect(ratePpb(0, 'none')).toBe(0);
  });

  it('a zero rate is zero on every basis', () => {
    const bases: InterestBasis[] = ['apr_monthly', 'apr_semiannual', 'per_month', 'apr_daily', 'simple_on_principal'];
    for (const basis of bases) expect({ basis, ppb: ratePpb(0, basis) }).toEqual({ basis, ppb: 0 });
  });
});

describe('chargeCents: whole cents, always', () => {
  /** The spec's worked example, and the one most households can check against a statement. */
  it('charges $1,250.00 on $300,000 at 5% yearly', () => {
    expect(chargeCents(30_000_000, ratePpb(pct(5), 'apr_monthly'))).toBe(125_000);
  });

  it('charges $1,500.00 on $300,000 at 0.5% a month', () => {
    expect(chargeCents(30_000_000, ratePpb(pct(0.5), 'per_month'))).toBe(150_000);
  });

  /** About $13 a month less than rate/12 on a $300,000 mortgage -- roughly $156 a year. */
  it('charges about $1,237 on $300,000 at 5% compounded semi-annually', () => {
    const charge = chargeCents(30_000_000, ratePpb(pct(5), 'apr_semiannual'));
    expect(charge).toBeGreaterThan(123_000);
    expect(charge).toBeLessThan(124_000);
  });

  it('rounds to the nearer cent rather than truncating', () => {
    // 1 cent at half a billion ppb is exactly half a cent, which must round away from zero.
    expect(chargeCents(1, 500_000_000)).toBe(1);
  });

  it('charges nothing on a zero balance, and nothing at a zero rate', () => {
    expect(chargeCents(0, 4_166_667)).toBe(0);
    expect(chargeCents(30_000_000, 0)).toBe(0);
  });

  /** A balance cannot be negative in the loan's own frame; the caller re-signs before it gets here. */
  it('never returns a negative charge', () => {
    expect(chargeCents(-100, 4_166_667)).toBe(0);
  });
});
