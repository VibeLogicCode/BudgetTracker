/**
 * Loan interest, as an estimate the household can check.
 *
 * Design and rulings: docs/superpowers/specs/2026-09-18-loan-interest-design.md. This module is
 * ruling I14's "one pure module": it imports nothing from '@/db', reads no clock, and never spells
 * the literal 'lent' -- the caller re-signs every amount into the loan's own frame with
 * loanSignedDelta before anything arrives here, so a negative movement always means "this balance
 * goes down" whichever way the loan points (ruling P4, restated by I16). Guard G2 in
 * tests/ops/loan-invariants.test.ts holds those three properties.
 *
 * MUST-13.1', which replaces the old "the interest rate is display only": interest is DERIVED, never
 * stored; it is computed only here; and it is shown only for a loan whose basis a person has set.
 * Nothing in this file writes anything. Ruling I12 explains why deriving beats storing -- briefly,
 * accrued interest is a pure function of (anchor balance, anchor date, rate, basis, the movements
 * since, today), so storing its outputs would be a cache needing a scheduler to fill it, a reversal
 * step on every undo path, and a rule for what happens when a person re-anchors. Deriving gives
 * every one of those for free.
 */

/**
 * How a rate is charged. The one thing the app cannot infer and must be told (ruling I5): a bare
 * rate with no period attached is a twelve-times error in either direction, and every rate already
 * in the database was typed under a promise that nothing would be computed from it.
 *
 * 'none' is a VALUE, not an absence. An interest-free loan is a positive claim -- "every payment is
 * principal" -- and it still has payments, a payoff date and a statement to reconcile against. NULL
 * on the item means "we have not been told", which is a weaker and quite different statement, and
 * keeps the loan off every interest surface.
 */
export type InterestBasis =
  | 'none'
  | 'apr_monthly'
  | 'apr_semiannual'
  | 'per_month'
  | 'simple_on_principal'
  | 'apr_daily';

export const INTEREST_BASES: readonly InterestBasis[] = [
  'none',
  'apr_monthly',
  'apr_semiannual',
  'per_month',
  'simple_on_principal',
  'apr_daily',
] as const;

/** Parts per billion. A rate, never a money value -- see ratePpb's own note on why this unit. */
const PPB = 1_000_000_000;

/** Basis points to ppb: 1 bp = 0.01% = 1e-4, and 1e-4 x 1e9 = 1e5. */
const BPS_TO_PPB = 100_000;

/** Fixed, and stated in the help. A leap year is 0.27% more days than this assumes (ruling I8). */
const DAYS_PER_YEAR = 365;

/**
 * The periodic rate as ONE INTEGER in parts per billion, derived once from the rate the lender
 * printed and the way it is charged.
 *
 * WHY AN INTEGER, AND WHY THIS UNIT. Every charge below is balanceCents x ppb / 1e9, so the only
 * floating-point arithmetic in the entire feature happens here, on a RATE, and never on a money
 * value carried between steps. At 1e-9 resolution the rounding error on a monthly charge against a
 * million-dollar balance is under a hundredth of a cent, far inside the accuracy anything labelled
 * an estimate can claim.
 *
 * The result is PER MONTH for every basis except apr_daily, which is per day -- the two are never
 * mixed, because the caller dispatches on the basis before it walks a period.
 */
export function ratePpb(bps: number, basis: InterestBasis): number {
  if (basis === 'none' || bps <= 0) return 0;

  switch (basis) {
    /*
      The Canadian mortgage convention, and the only place a root appears. A rate "compounded
      semi-annually" means the half-year factor is (1 + r/2); the monthly factor is its sixth root.
      That lands about 1% BELOW r/12 -- on $300,000 at 5%, about $13 a month -- which is exactly why
      it cannot be folded into apr_monthly: a household checking against a statement spots it at once.
    */
    case 'apr_semiannual': {
      const halfYearly = bps / 20_000; // basis points to a fraction, halved
      return Math.round((Math.pow(1 + halfYearly, 1 / 6) - 1) * PPB);
    }
    /** Already per month; nothing to convert. */
    case 'per_month':
      return bps * BPS_TO_PPB;
    /** Daily accrual on a balance that moves -- a line of credit (ruling I7). */
    case 'apr_daily':
      return Math.round((bps * BPS_TO_PPB) / DAYS_PER_YEAR);
    /*
      simple_on_principal shares apr_monthly's arithmetic and differs in WHAT it is applied to: the
      original amount rather than the outstanding balance. That difference lives in the caller, so
      this function stays a pure rate conversion.
    */
    case 'apr_monthly':
    case 'simple_on_principal':
      return Math.round((bps * BPS_TO_PPB) / 12);
  }
}

/**
 * One period's charge, in whole cents, rounded half away from zero.
 *
 * Half away from zero rather than JavaScript's Math.round (which is half UP, and therefore
 * asymmetric across zero): money rounding must not depend on the sign of its input. Nothing here
 * ever receives a negative balance -- the caller works in the loan's own frame, where a balance is a
 * magnitude -- but a function that would silently do the wrong thing if it did is a trap left for
 * somebody else, so the guard is explicit and returns 0.
 */
export function chargeCents(balanceCents: number, ppb: number): number {
  if (balanceCents <= 0 || ppb <= 0) return 0;
  return Math.floor((balanceCents * ppb) / PPB + 0.5);
}

/**
 * One movement against the loan, already SIGNED IN THE LOAN'S FRAME by the caller: negative reduces
 * what is owed (a repayment), positive increases it (an advance on a line of credit, or a
 * disbursement). loanSignedDelta in src/lib/warranty/constants.ts does that re-signing, which is why
 * nothing in this module knows or cares which way the loan points (rulings P4, I16).
 *
 * date is the TRANSACTION's date, never the link's created_at -- the v1.25.0 fix, which this module
 * has to follow or a catch-up import re-creates the bug that fix removed.
 */
export interface Movement {
  date: string;
  amountCents: number;
}

/*
  simulate() lived here until v1.48.0: a calendar-month walk that produced the loan summary while
  the ledger walked the loan's own posting cycle. Two models for one question is how a dashboard
  and a loan page come to print different balances, so the ledger engine (src/lib/loans/ledger.ts)
  took over both and this one went. What remains is the rate arithmetic, which both always shared.
*/
