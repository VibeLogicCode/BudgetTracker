/**
 * The loan ledger engine: what a loan has cost, period by period, from facts alone.
 *
 * PURE, and guarded as such (MUST-13.1' G2, extended to this file in v1.48.0). No database, no
 * clock, no direction value. The caller supplies today's date and movements already signed in the
 * loan's frame, and applies loanSignedDelta on the way in -- this file must never learn which way
 * a loan points, because that knowledge has exactly one home (ruling P4).
 *
 * WHY A CYCLE AND NOT A CALENDAR MONTH. v1.47.0 charged interest on the 1st of each calendar month
 * because the anchor gave no other day to use. A loan agreement says otherwise: interest is charged
 * monthly from the date of the loan, and a statement is dated on the lender's own cycle day. So a
 * period here runs posting day to posting day (C1), and a household comparing this to a statement
 * is comparing the same span of days rather than one that happens to overlap.
 *
 * WHY DAILY BALANCES. A payment made on the 15th genuinely halves what the second half of the
 * month costs; charging a whole month on the opening balance overstates it, and the owner asked
 * directly what happens when 5k lands mid-month. Every basis except the two that are defined
 * otherwise therefore charges on the average daily balance (A2).
 */
import { addDaysIso, daysBetweenIso } from '@/lib/dates';
import { chargeCents, ratePpb, type InterestBasis, type Movement } from '@/lib/loans/interest';

/** Parts per billion, matching interest.ts. Derived rates are integers in this unit. */
const PPB = 1_000_000_000;

/** C1. The day of the month a loan posts: its own, or the day it was borrowed. */
export function postingDayFor(purchaseDate: string, postingDay: number | null): number {
  return postingDay ?? Number(purchaseDate.slice(8, 10));
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * The posting day in a given month, clamped to the month's own end.
 *
 * A loan borrowed on the 31st has no 31st in February. Clamping to the 28th there and returning to
 * the 31st in March is what a lender does, and it is why the clamp lives here rather than in a
 * caller: every date this file produces has to agree about it.
 */
function clampedDate(year: number, month1: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/**
 * The first posting date STRICTLY after `afterIso`.
 *
 * Strictly, because a date that is itself a posting date opens the next period rather than closing
 * one -- otherwise a loan anchored on its own posting day would produce a zero-length period.
 *
 * Month arithmetic, not "add 31 days": two clamped months in a row (Jan 30 -> Feb 28 -> Mar 30)
 * must stay two periods, and a day-count walk would collapse them.
 */
export function nextPostingDate(afterIso: string, postingDay: number): string {
  let year = Number(afterIso.slice(0, 4));
  let month = Number(afterIso.slice(5, 7));
  for (let guard = 0; guard < 24; guard++) {
    const candidate = clampedDate(year, month, postingDay);
    if (candidate > afterIso) return candidate;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  // Unreachable: two months of candidates always clear any date inside one month.
  throw new Error('nextPostingDate found no date after ' + afterIso);
}

export interface PeriodBoundary {
  start: string;
  /** Exclusive: the posting date, and the next period's start. */
  end: string;
  /** C3. Its end has arrived, so it is written down and left alone. */
  closed: boolean;
}

/**
 * Every period from the start point to the one containing today, in order.
 *
 * Always ends with exactly one OPEN period -- the one interest is still accruing in. Callers rely
 * on that: it is where "accrued so far" comes from, and it is the only period a late payment can
 * still change without a correction.
 */
export function periodBoundaries(startIso: string, postingDay: number, todayIso: string): PeriodBoundary[] {
  const out: PeriodBoundary[] = [];
  let start = startIso;
  for (let guard = 0; guard < 1200; guard++) {
    const end = nextPostingDate(start, postingDay);
    const closed = end <= todayIso;
    out.push({ start, end, closed });
    if (!closed) return out;
    start = end;
  }
  // A hundred years of periods means a corrupt start date, not a long loan.
  throw new Error('periodBoundaries did not reach today from ' + startIso);
}

/**
 * A1. One balance per day in [startIso, endIsoExclusive): what was owed at the END of that day.
 *
 * A movement counts from the day it lands, which is the convention a bank uses for a payment and
 * the one the owner would check against: money paid on the 15th is not owed on the 15th.
 *
 * Clamped at zero. An overpayment leaves nothing owing rather than a negative balance that would
 * quietly earn interest the other way.
 */
export function dailyBalances(
  startIso: string,
  endIsoExclusive: string,
  openingCents: number,
  movements: Movement[],
): number[] {
  const byDate = new Map<string, number>();
  for (const movement of movements) {
    if (movement.date < startIso || movement.date >= endIsoExclusive) continue;
    byDate.set(movement.date, (byDate.get(movement.date) ?? 0) + movement.amountCents);
  }
  const days = daysBetweenIso(startIso, endIsoExclusive);
  const out: number[] = [];
  let balance = openingCents;
  for (let i = 0; i < days; i++) {
    balance = Math.max(0, balance + (byDate.get(addDaysIso(startIso, i)) ?? 0));
    out.push(balance);
  }
  return out;
}

/** R1. A rate and how it is charged, in force from a date. */
export interface RateInForce {
  effectiveFrom: string;
  rateBps: number;
  basis: InterestBasis;
}

/**
 * R1. The rate that applied on a given day: the newest row effective on or before it.
 *
 * Null before the first row, and a period with a null rate charges nothing. That is deliberate --
 * a loan whose history starts in August has no opinion about July, and inventing one would make
 * up interest for a period nobody described.
 */
export function rateOn(date: string, history: RateInForce[]): RateInForce | null {
  let found: RateInForce | null = null;
  for (const row of history) {
    if (row.effectiveFrom > date) continue;
    if (found === null || row.effectiveFrom >= found.effectiveFrom) found = row;
  }
  return found;
}

export interface PeriodCharge {
  interestCents: number;
  /** What the charge was worked out on. Shown to a person so the sum can be checked by hand. */
  averageDailyBalanceCents: number;
  /** Days actually charged: the whole period once closed, or the days gone so far while open. */
  daysCounted: number;
  daysInPeriod: number;
}

/**
 * A2/A4/A5. What one period costs.
 *
 *   monthly bases   periodic rate x average daily balance x (daysCounted / daysInPeriod)
 *   apr_daily       the daily walk, compounding daily, summed
 *   simple_on_principal   the periodic rate on the ORIGINAL amount, balance ignored
 *
 * ROUNDED ONCE, at the end (A6). Rounding each day and summing would drift by a cent or two a
 * month against a lender that rounds once, and those cents are exactly what a household notices
 * when it checks a statement.
 *
 * `upTo` is what makes "accrued so far" the same function as "what this period cost": it counts
 * only the days already gone. Today is excluded because today is not over.
 */
export function periodCharge(input: {
  start: string;
  /** Exclusive: the posting date. */
  end: string;
  /** Stop counting days here (exclusive). Omitted, or beyond the end, means the whole period. */
  upTo?: string;
  /**
   * The nominal length of the CYCLE this period is a fragment of, when it is one (C2). A full
   * period leaves it out and is charged a full periodic rate.
   */
  cycleDays?: number;
  openingCents: number;
  /** The original amount. Required by simple_on_principal, ignored by every other basis. */
  principalCents: number | null;
  movements: Movement[];
  rate: RateInForce | null;
}): PeriodCharge {
  const daysInPeriod = daysBetweenIso(input.start, input.end);
  const countUntil = input.upTo === undefined || input.upTo > input.end ? input.end : input.upTo;
  const daysCounted = Math.max(0, Math.min(daysInPeriod, daysBetweenIso(input.start, countUntil)));
  const balances = dailyBalances(input.start, input.end, input.openingCents, input.movements).slice(0, daysCounted);
  const sum = balances.reduce((total, balance) => total + balance, 0);
  const averageDailyBalanceCents = daysCounted === 0 ? input.openingCents : Math.floor(sum / daysCounted + 0.5);

  const rate = input.rate;
  if (rate === null || rate.basis === 'none' || rate.rateBps <= 0 || daysCounted === 0 || daysInPeriod === 0) {
    return { interestCents: 0, averageDailyBalanceCents, daysCounted, daysInPeriod };
  }
  const ppb = ratePpb(rate.rateBps, rate.basis);

  if (rate.basis === 'apr_daily') {
    /*
      A DAILY rate on each day's balance, summed and rounded once -- NOT compounded within the
      period. Unpaid interest still compounds, but at the posting date, when it joins the balance
      the next period is charged on. Compounding inside the period as well would charge interest on
      interest the lender has not yet posted, and would break the v1.47.0 pin ($20,000 at 8% costs
      $131.51 over thirty days) that a household has already checked against a statement.

      No pro-rating: the day count is already inside `sum`, which is what makes this basis right for
      a balance that moves every day.
    */
    return { interestCents: Math.floor((sum * ppb) / PPB + 0.5), averageDailyBalanceCents, daysCounted, daysInPeriod };
  }

  /*
    The monthly bases charge one periodic rate per CYCLE, so a fragment of a cycle is pro-rated by
    the cycle's own length -- not by the fragment's. Twelve days of a thirty-one day cycle cost
    12/31 of a month; dividing by twelve would charge a full month for twelve days, which is what a
    mid-statement anchor would otherwise do to the period it lands in.
  */
  const cycleDays = input.cycleDays ?? daysInPeriod;
  const base = rate.basis === 'simple_on_principal' ? (input.principalCents ?? 0) : sum / daysCounted;
  const raw = (base * ppb * daysCounted) / (PPB * cycleDays);
  return { interestCents: Math.floor(raw + 0.5), averageDailyBalanceCents, daysCounted, daysInPeriod };
}

export { PPB, chargeCents, ratePpb };
export type { InterestBasis, Movement };
