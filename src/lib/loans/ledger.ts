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

/**
 * A date range the engine cannot walk: a start point a century before today, or a posting day that
 * never resolves. Typed so a caller can degrade (a loan page showing no ledger) instead of taking
 * the request down -- one corrupt date used to 500 the dashboard, reports and net worth alike.
 */
export class LedgerRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerRangeError';
  }
}

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
  throw new LedgerRangeError('nextPostingDate found no date after ' + afterIso);
}

/**
 * The last posting date STRICTLY before `beforeIso`. The mirror of nextPostingDate, and the way a
 * period learns the length of the CYCLE it belongs to: a period that starts mid-cycle is a fragment
 * of the cycle ending on its own posting date, not a short cycle of its own (C2, A2).
 */
export function previousPostingDate(beforeIso: string, postingDay: number): string {
  let year = Number(beforeIso.slice(0, 4));
  let month = Number(beforeIso.slice(5, 7));
  for (let guard = 0; guard < 24; guard++) {
    const candidate = clampedDate(year, month, postingDay);
    if (candidate < beforeIso) return candidate;
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  }
  // Unreachable, for the same reason nextPostingDate's guard is.
  throw new LedgerRangeError('previousPostingDate found no date before ' + beforeIso);
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
  throw new LedgerRangeError('periodBoundaries did not reach today from ' + startIso);
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

/**
 * One row of loan_postings, in the engine's own shape. The database mirror of this is written by
 * postDueInterest; nothing here knows the table exists.
 */
export interface StoredPosting {
  kind: 'posting' | 'adjustment';
  /**
   * For a posting, the period's own start. For an ADJUSTMENT, the start of the period it corrects
   * -- not the day it was found. The anchor wall selects rows by this, so a statement supersedes a
   * correction along with the posting it corrected.
   */
  periodStart: string;
  periodEnd: string;
  openingCents: number;
  /** Signed. A posting is never negative; an adjustment usually is. */
  interestCents: number;
  /** APPLIED cents: what the payments actually took off, after the cap at what was owed. */
  paymentsCents: number;
  advancesCents: number;
  closingCents: number;
  rateBps: number | null;
  basis: InterestBasis | null;
  averageDailyBalanceCents: number | null;
  note: string | null;
}

export interface LedgerInput {
  /** The newest figure a person confirmed: an anchor's date. Nothing before it is estimated. */
  startDate: string;
  startBalanceCents: number;
  /** The original amount. Required by simple_on_principal, ignored by every other basis. */
  principalCents: number | null;
  postingDay: number;
  rateHistory: RateInForce[];
  /** Signed in the loan's frame, and already past the anchor wall. Negative repays. */
  movements: Movement[];
  /** What is already written down. */
  stored: StoredPosting[];
  today: string;
}

export type LedgerRowKind = 'opening' | 'advance' | 'payment' | 'interest' | 'adjustment' | 'accrued';

export interface LedgerRow {
  kind: LedgerRowKind;
  date: string;
  description: string;
  paymentCents: number | null;
  interestCents: number | null;
  principalCents: number | null;
  balanceCents: number;
  /**
   * On an interest row: enough to check the charge by hand (U8). On a payment row: what had built
   * up by the day the money moved, which is NOT additive with the Interest column and therefore
   * does not live in it.
   */
  detail?: {
    rateBps?: number;
    basis?: InterestBasis;
    averageDailyBalanceCents?: number;
    daysCounted?: number;
    cycleDays?: number;
    paidToInterestCents?: number;
    accruedToDayCents?: number;
  };
}

export interface Ledger {
  rows: LedgerRow[];
  /** Closed periods with nothing written down for them yet, oldest first (P2). */
  duePostings: StoredPosting[];
  /** The one correction the stored rows need to match the facts, or null (K2). */
  dueAdjustment: StoredPosting | null;
  /** Everything posted, plus movements: the figure the database keeps (P5). */
  postedBalanceCents: number;
  /** This cycle so far, never stored (C3). */
  accruedCents: number;
  owingCents: number;
  /** What the whole of this cycle costs at the balance as it stands. */
  interestThisPeriodCents: number;
  interestPaidToDateCents: number;
  principalPaidToDateCents: number;
  /**
   * Every interest figure written down since the start point, corrections included. What the
   * summary means by "interest since your statement" -- distinct from what was PAID, which is
   * interestPaidToDateCents.
   */
  interestPostedSinceStartCents: number;
  yearAtThisBalanceCents: number;
}

/**
 * One period, walked. The ONE BALANCE RULE lives here and nowhere else.
 *
 * v1.48.0 clamped at zero in three places -- once per period in the truth walk, once at the end of
 * the stored replay, and once per movement in the row walk -- and the three disagreed. The
 * difference was then written down as an "interest" adjustment, so a loan could report $0.00 on its
 * card, $2.03 on its ledger, and announce itself paid off, all at once.
 *
 * The rule: a repayment applies at most what is owed at that moment (MUST-11.14, the same cap
 * `loan_payments.applied_cents` has always carried in the database), an advance adds in full, and
 * interest joins at the period end. Truth and stored-replay differ ONLY in where the interest
 * figure comes from, so they cannot disagree about anything else -- and recomputeBalance walks the
 * same events in the same order with the same cap.
 */
interface WalkPeriod {
  start: string;
  end: string;
  cycleDays: number;
  openingCents: number;
  inside: Movement[];
  /** What the payments actually took off, after the cap. Stored as `payments_cents`. */
  appliedCents: number;
  advancesCents: number;
  interestCents: number;
  closingCents: number;
  charge: PeriodCharge;
  rate: RateInForce | null;
  /** Interest accrued through the END of each day of the period. Indexed by day offset. */
  accruedByDay: number[];
}

type OpenPeriod = Omit<WalkPeriod, 'interestCents' | 'closingCents'>;

function inWindow(movements: Movement[], from: string, toExclusive: string): Movement[] {
  return movements.filter((movement) => movement.date >= from && movement.date < toExclusive);
}

function byDate(movements: Movement[]): Movement[] {
  return [...movements].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Interest accrued through the end of each day, computed ONCE per period.
 *
 * v1.48.0 called periodCharge once per movement to print the accrued-to-date figure beside a
 * payment row, which measured at 38-74% of the engine's whole cost on a busy line of credit. The
 * prefix is the same arithmetic done once: charge for days [0..i] is the same shape periodCharge
 * uses, so the two agree by construction.
 */
function accrualPrefix(
  period: { start: string; end: string; cycleDays: number; openingCents: number; inside: Movement[]; rate: RateInForce | null },
  principalCents: number | null,
): number[] {
  const days = daysBetweenIso(period.start, period.end);
  const balances = dailyBalances(period.start, period.end, period.openingCents, period.inside);
  const out: number[] = [];
  const rate = period.rate;
  if (rate === null || rate.basis === 'none' || rate.rateBps <= 0 || days === 0) {
    for (let index = 0; index < days; index += 1) out.push(0);
    return out;
  }
  const ppb = ratePpb(rate.rateBps, rate.basis);
  let sum = 0;
  for (let index = 0; index < days; index += 1) {
    sum += balances[index] ?? 0;
    const counted = index + 1;
    if (rate.basis === 'apr_daily') {
      out.push(Math.floor((sum * ppb) / PPB + 0.5));
    } else {
      const base = rate.basis === 'simple_on_principal' ? (principalCents ?? 0) : sum / counted;
      out.push(Math.floor((base * ppb * counted) / (PPB * period.cycleDays) + 0.5));
    }
  }
  return out;
}

/** What the accrual prefix says had built up by the START of a given day. */
function accruedBefore(period: { start: string; accruedByDay: number[] }, date: string): number {
  const offset = daysBetweenIso(period.start, date);
  if (offset <= 0) return 0;
  return period.accruedByDay[offset - 1] ?? 0;
}

/**
 * Walk every period from the start point to today, applying the one balance rule.
 *
 * `interestFor` decides where a closed period's interest figure comes from: the computed charge (the
 * truth) or the row that was written down (the replay). `adjustmentsAt` folds stored corrections in
 * at their own dates, so the replay ends where the corrections say it should.
 */
function walkPeriods(
  input: LedgerInput,
  interestFor: (period: OpenPeriod, index: number) => number,
  adjustmentsByEnd: Map<string, number>,
): { closed: WalkPeriod[]; open: OpenPeriod } {
  const closed: WalkPeriod[] = [];
  let balance = input.startBalanceCents;
  let index = 0;
  for (const boundary of periodBoundaries(input.startDate, input.postingDay, input.today)) {
    const cycleDays = daysBetweenIso(previousPostingDate(boundary.end, input.postingDay), boundary.end);
    const inside = byDate(inWindow(input.movements, boundary.start, boundary.end));
    const rate = rateOn(boundary.start, input.rateHistory);
    const charge = periodCharge({
      start: boundary.start,
      end: boundary.end,
      cycleDays,
      openingCents: balance,
      principalCents: input.principalCents,
      movements: inside,
      rate,
    });

    // The cap, applied movement by movement in date order.
    let running = balance;
    let appliedCents = 0;
    let advancesCents = 0;
    for (const movement of inside) {
      if (movement.amountCents < 0) {
        const paid = Math.min(-movement.amountCents, running);
        running -= paid;
        appliedCents += paid;
      } else {
        running += movement.amountCents;
        advancesCents += movement.amountCents;
      }
    }

    const partial: OpenPeriod = {
      start: boundary.start,
      end: boundary.end,
      cycleDays,
      openingCents: balance,
      inside,
      appliedCents,
      advancesCents,
      charge,
      rate,
      accruedByDay: accrualPrefix({ start: boundary.start, end: boundary.end, cycleDays, openingCents: balance, inside, rate }, input.principalCents),
    };
    if (!boundary.closed) return { closed, open: partial };

    const interestCents = interestFor(partial, index);
    index += 1;
    // A correction recorded on or before this period's end lands here, so the replay ends where
    // the written-down rows say it does.
    const correction = adjustmentsByEnd.get(boundary.end) ?? 0;
    const closingCents = Math.max(0, running + interestCents + correction);
    closed.push({ ...partial, interestCents, closingCents });
    balance = closingCents;
  }
  // Unreachable: periodBoundaries always ends on an open period.
  throw new LedgerRangeError('walkPeriods found no open period');
}

function money(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

/** A closed period as a row for loan_postings. */
function asStored(period: WalkPeriod): StoredPosting {
  return {
    kind: 'posting',
    periodStart: period.start,
    periodEnd: period.end,
    openingCents: period.openingCents,
    interestCents: period.interestCents,
    // APPLIED cents, not the face value of the payments: what actually came off the balance.
    paymentsCents: period.appliedCents,
    advancesCents: period.advancesCents,
    closingCents: period.closingCents,
    rateBps: period.rate?.rateBps ?? null,
    basis: period.rate?.basis ?? null,
    averageDailyBalanceCents: period.charge.averageDailyBalanceCents,
    note: null,
  };
}

/**
 * The whole ledger: what to write down, what it costs, and the rows a person reads.
 *
 * Called on every page load and before every posting, so it must be cheap and must agree with
 * itself: building a ledger, storing what it says is due, and building it again has to leave
 * nothing due. That property is what lets the same function serve the screen and the scheduler.
 */
export function buildLedger(input: LedgerInput): Ledger {
  const storedPostings = input.stored.filter((row) => row.kind === 'posting');
  const storedByEnd = new Map(storedPostings.map((row) => [row.periodEnd, row]));
  const storedAdjustments = input.stored.filter((row) => row.kind === 'adjustment');

  // An adjustment belongs to the period it CORRECTS, which its periodStart names. It takes effect
  // at the end of the first closed period that starts on or after it.
  const truth = walkPeriods(input, (period) => period.charge.interestCents, new Map());
  const lastClosedEnd = truth.closed.at(-1)?.end;
  const landingFor = (adjustment: StoredPosting): string | undefined =>
    truth.closed.find((period) => period.end >= adjustment.periodEnd)?.end ?? lastClosedEnd;
  const adjustmentsByEnd = new Map<string, number>();
  for (const adjustment of storedAdjustments) {
    // A correction dated inside the open period (the usual case -- it was found today) still
    // belongs to the closed history it corrects, so it lands on the last closed period. Otherwise
    // the replay would never see it and would propose the same correction again, for ever.
    const landing = landingFor(adjustment);
    if (landing === undefined) continue;
    adjustmentsByEnd.set(landing, (adjustmentsByEnd.get(landing) ?? 0) + adjustment.interestCents);
  }
  const replay = walkPeriods(
    input,
    (period) => storedByEnd.get(period.end)?.interestCents ?? period.charge.interestCents,
    adjustmentsByEnd,
  );

  const duePostings = truth.closed.filter((period) => !storedByEnd.has(period.end)).map(asStored);

  /*
    K1/K2. The truth says what the balance was when the open period began; the replay says what the
    written-down rows add up to. A gap means something was recorded after its period had already
    closed -- a payment imported late, a rate corrected, a link undone -- and a gap is settled with
    one dated correction rather than by rewriting the periods, because a lender does not restate a
    statement it has already sent and neither should this.

    With nothing stored yet there is nothing to correct: the due postings ARE the truth.
  */
  const replayWithDue =
    duePostings.length === 0
      ? replay
      : walkPeriods(
          input,
          (period) => storedByEnd.get(period.end)?.interestCents ?? period.charge.interestCents,
          adjustmentsByEnd,
        );
  const gap = truth.open.openingCents - replayWithDue.open.openingCents;

  let dueAdjustment: StoredPosting | null = null;
  if (gap !== 0 && storedPostings.length > 0) {
    /*
      The period the correction BELONGS to: the earliest closed period whose movements the stored
      row does not reflect. The wall in loans.ts selects postings by periodStart, so a statement
      dated after that period supersedes the correction along with the posting it corrects -- which
      is the whole reason this is not simply "today".
    */
    const mismatch = truth.closed.find((period) => {
      const stored = storedByEnd.get(period.end);
      if (stored === undefined) return false;
      return stored.paymentsCents !== period.appliedCents || stored.advancesCents !== period.advancesCents;
    });
    const newest = storedPostings.reduce((best, row) => (row.periodEnd > best.periodEnd ? row : best));
    const belongsTo = mismatch?.start ?? newest.periodStart;
    const late = input.movements.filter((movement) => movement.date <= newest.periodEnd);
    const described = late
      .map(
        (movement) =>
          (movement.amountCents < 0 ? 'Payment' : 'Advance') +
          ' of ' +
          money(movement.amountCents) +
          ' dated ' +
          movement.date,
      )
      .join('; ');
    dueAdjustment = {
      kind: 'adjustment',
      periodStart: belongsTo,
      periodEnd: input.today,
      openingCents: replayWithDue.open.openingCents,
      interestCents: gap,
      paymentsCents: 0,
      advancesCents: 0,
      closingCents: replayWithDue.open.openingCents + gap,
      rateBps: null,
      basis: null,
      averageDailyBalanceCents: null,
      note:
        (described === '' ? 'A change' : described) +
        ' recorded after the ' +
        newest.periodEnd +
        ' posting. Interest ' +
        (gap < 0 ? '−' : '+') +
        money(gap) +
        '.',
    };
  }

  /*
    Rows. Walked off the REPLAY, because a ledger shows what was posted, not a recomputation of it
    -- and with the due postings folded in, because those are about to be written and a household
    looking at the page before the sweep runs should see them.
  */
  const shown = replayWithDue;
  const openMovements = byDate(inWindow(input.movements, shown.open.start, addDaysIso(input.today, 1)));

  const rows: LedgerRow[] = [
    {
      kind: 'opening',
      date: input.startDate,
      description: 'Opening balance',
      paymentCents: null,
      interestCents: null,
      principalCents: null,
      balanceCents: input.startBalanceCents,
    },
  ];

  let interestPaidToDateCents = 0;
  let principalPaidToDateCents = 0;
  let interestPostedSinceStartCents = 0;
  let unpaidInterest = 0;
  let running = input.startBalanceCents;

  const movementRow = (movement: Movement, period: { start: string; accruedByDay: number[] }): LedgerRow => {
    const applied = movement.amountCents < 0 ? Math.min(-movement.amountCents, running) : 0;
    running = movement.amountCents < 0 ? running - applied : running + movement.amountCents;
    return movement.amountCents < 0
      ? {
          kind: 'payment',
          date: movement.date,
          description: 'Payment',
          paymentCents: applied,
          /*
            NULL, deliberately. v1.48.0 put the accrued-to-day figure here, which is a SUBSET of the
            posting row's figure for the same period -- so summing the Interest column over-counted,
            and the CSV exported it under the same heading with no way to tell. The figure is still
            available, in `detail`, where it cannot be added up by mistake.
          */
          interestCents: null,
          principalCents: null,
          balanceCents: running,
          detail: { accruedToDayCents: accruedBefore(period, movement.date) },
        }
      : {
          kind: 'advance',
          date: movement.date,
          description: 'Advance',
          paymentCents: null,
          interestCents: null,
          principalCents: movement.amountCents,
          balanceCents: running,
        };
  };

  for (const period of shown.closed) {
    for (const movement of period.inside) rows.push(movementRow(movement, period));

    // I1: a payment covers the interest OUTSTANDING, which includes anything an earlier period left
    // unpaid -- not just this period's own charge. Capping per period reported arrears as principal.
    const due = unpaidInterest + period.interestCents;
    const paidToInterestCents = Math.min(period.appliedCents, due);
    unpaidInterest = due - paidToInterestCents;
    interestPaidToDateCents += paidToInterestCents;
    principalPaidToDateCents += period.appliedCents - paidToInterestCents;
    interestPostedSinceStartCents += period.interestCents;

    running = Math.max(0, running + period.interestCents);
    rows.push({
      kind: 'interest',
      date: period.end,
      description:
        period.appliedCents > 0
          ? 'Interest posted. Of ' +
            money(period.appliedCents) +
            ' paid this period, ' +
            money(paidToInterestCents) +
            ' covered interest.'
          : 'Interest posted',
      paymentCents: null,
      interestCents: period.interestCents,
      principalCents: null,
      balanceCents: running,
      detail:
        period.rate === null
          ? { paidToInterestCents }
          : {
              rateBps: period.rate.rateBps,
              basis: period.rate.basis,
              averageDailyBalanceCents: period.charge.averageDailyBalanceCents,
              daysCounted: daysBetweenIso(period.start, period.end),
              cycleDays: period.cycleDays,
              paidToInterestCents,
            },
    });

    const correction = adjustmentsByEnd.get(period.end);
    if (correction !== undefined) {
      for (const adjustment of storedAdjustments.filter((row) => landingFor(row) === period.end)) {
        running = Math.max(0, running + adjustment.interestCents);
        interestPostedSinceStartCents += adjustment.interestCents;
        rows.push({
          kind: 'adjustment',
          date: adjustment.periodEnd,
          description: adjustment.note ?? 'Adjustment',
          paymentCents: null,
          interestCents: adjustment.interestCents,
          principalCents: null,
          balanceCents: running,
        });
      }
    }
  }

  for (const movement of openMovements) rows.push(movementRow(movement, shown.open));

  const postedBalanceCents = running;
  const accrued = periodCharge({
    start: shown.open.start,
    end: shown.open.end,
    upTo: input.today,
    cycleDays: shown.open.cycleDays,
    openingCents: shown.open.openingCents,
    principalCents: input.principalCents,
    movements: openMovements,
    rate: shown.open.rate,
  });

  // The open period's payments split the same way, against what is outstanding including arrears.
  const openDue = unpaidInterest + accrued.interestCents;
  const openToInterest = Math.min(shown.open.appliedCents, openDue);
  interestPaidToDateCents += openToInterest;
  principalPaidToDateCents += shown.open.appliedCents - openToInterest;

  const owingCents = postedBalanceCents + accrued.interestCents;
  rows.push({
    kind: 'accrued',
    date: input.today,
    description: 'Accrued so far (' + accrued.daysCounted + ' of ' + accrued.daysInPeriod + ' days)',
    paymentCents: null,
    interestCents: accrued.interestCents,
    principalCents: null,
    balanceCents: owingCents,
  });

  const thisPeriod = periodCharge({
    start: shown.open.start,
    end: shown.open.end,
    cycleDays: shown.open.cycleDays,
    openingCents: postedBalanceCents,
    principalCents: input.principalCents,
    movements: [],
    rate: shown.open.rate,
  });

  /*
    "A year at this balance" is twelve charges at the rate in force, or three hundred and sixty-five
    for a daily one -- not a compounded projection. It answers "what is this costing me", which is
    what a household asks, and a compounded figure would silently assume nothing is ever repaid.
  */
  const openRate = shown.open.rate;
  const yearBase = openRate?.basis === 'simple_on_principal' ? input.principalCents ?? 0 : postedBalanceCents;
  const yearAtThisBalanceCents =
    openRate === null || openRate.basis === 'none'
      ? 0
      : Math.floor(
          (yearBase * ratePpb(openRate.rateBps, openRate.basis) * (openRate.basis === 'apr_daily' ? 365 : 12)) / PPB +
            0.5,
        );

  return {
    rows,
    duePostings,
    dueAdjustment,
    postedBalanceCents,
    accruedCents: accrued.interestCents,
    owingCents,
    interestThisPeriodCents: thisPeriod.interestCents,
    interestPaidToDateCents,
    principalPaidToDateCents,
    interestPostedSinceStartCents,
    yearAtThisBalanceCents,
  };
}

export { PPB, chargeCents, ratePpb };
export type { InterestBasis, Movement };
