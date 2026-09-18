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

export interface SimulateInput {
  /** The as-of date of the newest figure a person confirmed. Nothing before this is estimated. */
  anchorDate: string;
  /** That confirmed figure, a magnitude in the loan's frame. */
  anchorBalanceCents: number;
  basis: InterestBasis;
  rateBps: number;
  /** The original amount. Required by simple_on_principal, ignored by every other basis. */
  principalCents: number | null;
  movements: Movement[];
  /** Today, supplied by the caller: this module reads no clock (guard G2). */
  asOf: string;
}

export interface MonthRow {
  /** YYYY-MM. */
  month: string;
  /** What was owed as the month opened: principal + unpaid interest. */
  openingCents: number;
  chargedCents: number;
  interestPaidCents: number;
  principalPaidCents: number;
  advancedCents: number;
  /** Owed at month end. */
  closingCents: number;
  cumulativeInterestCents: number;
  /** Money came in this month, and it did not cover the month's interest. */
  shortfall: boolean;
}

export interface SimulateResult {
  /** principal + pot: the estimate this whole module exists to produce. */
  owingCents: number;
  principalCents: number;
  /** Interest charged and not yet paid. */
  potCents: number;
  interestSinceAnchorCents: number;
  months: MonthRow[];
}

/** YYYY-MM for an ISO date. */
const monthKeyOf = (isoDate: string): string => isoDate.slice(0, 7);

/** Days in the month an ISO date falls in. Day 0 of the next month is the last day of this one. */
function daysInMonth(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The month key after this one. */
function nextMonthKey(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** The next ISO date. Kept local so this module still imports nothing (guard G2). */
function addOneDay(isoDate: string): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

const lastDayOf = (monthKey: string): string =>
  `${monthKey}-${String(daysInMonth(`${monthKey}-01`)).padStart(2, '0')}`;

/**
 * Interest charged and unpaid, plus what is still owed of the loan itself. Ruling I1: owing is the
 * sum of the two, and a payment drains the pot before it touches principal (I9).
 */
interface Buckets {
  principal: number;
  pot: number;
}

const owing = (buckets: Buckets): number => buckets.principal + buckets.pot;

/**
 * A repayment, interest first. Returns what it actually paid off each bucket so the month row can
 * report the split -- the "Interest $1,250.00 / Principal $550.00" line (ruling I11).
 */
function applyRepayment(buckets: Buckets, magnitude: number): { interest: number; principal: number } {
  const interest = Math.min(buckets.pot, magnitude);
  buckets.pot -= interest;
  const principal = Math.min(buckets.principal, magnitude - interest);
  buckets.principal -= principal;
  return { interest, principal };
}

interface MonthTally {
  interestPaid: number;
  principalPaid: number;
  advanced: number;
}

/** Apply one day's movements, recording the split so the month row can report it. */
function applyDay(buckets: Buckets, movements: Movement[], tally: MonthTally): void {
  for (const movement of movements) {
    if (movement.amountCents < 0) {
      const paid = applyRepayment(buckets, -movement.amountCents);
      tally.interestPaid += paid.interest;
      tally.principalPaid += paid.principal;
    } else {
      buckets.principal += movement.amountCents;
      tally.advanced += movement.amountCents;
    }
  }
}

/**
 * The month's charge for the four bases that post monthly.
 *
 * simple_on_principal is the one that does not look at the balance: it charges on the ORIGINAL
 * amount, every month, until nothing is owed. That is what a household means by "5% a year on the
 * $10,000", and modelling it as amortising would misstate the interest by roughly half over two
 * years (ruling I2).
 */
function monthlyCharge(input: SimulateInput, buckets: Buckets, ppb: number, fraction: number): number {
  if (owing(buckets) <= 0) return 0;
  const base = input.basis === 'simple_on_principal' ? (input.principalCents ?? 0) : owing(buckets);
  return chargeCents(Math.round(base * fraction), ppb);
}

/**
 * A month of daily accrual, for a balance that moves several times within it -- a line of credit.
 *
 * Each day: apply that day's movements, then accrue on what is owed at the END of that day. The
 * accumulator is in cents x 1e9 so nothing is rounded until the month closes and the total is posted
 * once (ruling I8) -- rounding each day would drift by up to half a cent a day, which over a year of
 * a large balance is real money.
 *
 * WHY THE BANK'S DATE IS GOOD ENOUGH HERE: the date the app holds is the chequing-side transaction
 * date, one to three days from the lender's posting date. A movement off by a day mis-attributes
 * movement x daily rate x days, which on $2,000 at 8% is about 44 cents a day. The error does not
 * compound, because the next reconciliation resets the balance to the statement's own figure (ruling
 * R6). The convention has to be right in shape, not to the cent.
 */
function accrueDaily(
  from: string,
  to: string,
  buckets: Buckets,
  byDate: Map<string, Movement[]>,
  ppb: number,
  tally: MonthTally,
): number {
  let accrued = 0;
  for (let day = from; day <= to; day = addOneDay(day)) {
    applyDay(buckets, byDate.get(day) ?? [], tally);
    accrued += Math.max(0, owing(buckets)) * ppb;
  }
  return Math.floor(accrued / PPB + 0.5);
}

/**
 * Walk from the confirmed figure to today, a month at a time, and report what interest did.
 *
 * THE ORDER WITHIN A MONTH is pinned by the spec's worked example: the charge is computed on the
 * opening balance and posted, and then that month's payments drain it, interest first. $300,000 at
 * 5% with an $1,800 payment gives $1,250 interest and $550 principal, which holds only if the charge
 * is payable by the payment that arrives in the same month.
 *
 * THE WALL (ruling R5): a movement dated on or before the anchor is already inside the figure the
 * person confirmed, so it is skipped rather than applied a second time.
 */
export function simulate(input: SimulateInput): SimulateResult {
  const months: MonthRow[] = [];
  const buckets: Buckets = { principal: Math.max(0, input.anchorBalanceCents), pot: 0 };

  if (input.asOf < input.anchorDate) {
    return {
      owingCents: owing(buckets),
      principalCents: buckets.principal,
      potCents: 0,
      interestSinceAnchorCents: 0,
      months,
    };
  }

  const ppb = ratePpb(input.rateBps, input.basis);
  const byDate = new Map<string, Movement[]>();
  for (const movement of input.movements) {
    // The wall, and its mirror: a future-dated row is not history either.
    if (movement.date <= input.anchorDate || movement.date > input.asOf) continue;
    byDate.set(movement.date, [...(byDate.get(movement.date) ?? []), movement]);
  }

  let cumulative = 0;
  const finalMonth = monthKeyOf(input.asOf);
  const anchorMonth = monthKeyOf(input.anchorDate);

  for (let monthKey = anchorMonth; monthKey <= finalMonth; monthKey = nextMonthKey(monthKey)) {
    const opening = owing(buckets);
    const tally: MonthTally = { interestPaid: 0, principalPaid: 0, advanced: 0 };

    const isAnchorMonth = monthKey === anchorMonth;
    /*
      The anchor DAY itself accrues. The wall keeps a movement dated that day from being applied
      twice, which is a statement about MOVEMENTS; the day is still a day the loan was outstanding.
      Starting a day later would charge 29 days for a statement dated the 1st of a 30-day month,
      while the monthly bases charge that same statement a whole month -- the two conventions have
      to agree, or a household switching basis would see the figure jump.
    */
    const firstDay = isAnchorMonth ? input.anchorDate : `${monthKey}-01`;
    const finalDay = monthKey === finalMonth ? input.asOf : lastDayOf(monthKey);

    let charged: number;
    if (input.basis === 'apr_daily') {
      charged = accrueDaily(firstDay, finalDay, buckets, byDate, ppb, tally);
      buckets.pot += charged;
    } else {
      /*
        The anchor month is pro-rated by the days it actually covers: a statement dated the 1st earns
        a whole month, one dated the 10th of a 30-day month earns 21/30. Only the anchor month --
        every month after it is whole (ruling I7). apr_daily needs none of this: it counts real days.
      */
      const total = daysInMonth(`${monthKey}-01`);
      const covered = isAnchorMonth ? total - Number(input.anchorDate.slice(8, 10)) + 1 : total;
      charged = monthlyCharge(input, buckets, ppb, Math.max(0, Math.min(1, covered / total)));
      buckets.pot += charged;

      for (let day = firstDay; day <= finalDay; day = addOneDay(day)) {
        applyDay(buckets, byDate.get(day) ?? [], tally);
      }
    }

    cumulative += charged;
    const received = tally.interestPaid + tally.principalPaid;
    months.push({
      month: monthKey,
      openingCents: opening,
      chargedCents: charged,
      interestPaidCents: tally.interestPaid,
      principalPaidCents: tally.principalPaid,
      advancedCents: tally.advanced,
      closingCents: owing(buckets),
      cumulativeInterestCents: cumulative,
      // Silence on a month with no payment at all: "you did not cover the interest" is a complaint
      // about a payment, and there was none to complain about.
      shortfall: received > 0 && received < charged,
    });
  }

  return {
    owingCents: owing(buckets),
    principalCents: buckets.principal,
    potCents: buckets.pot,
    interestSinceAnchorCents: cumulative,
    months,
  };
}
