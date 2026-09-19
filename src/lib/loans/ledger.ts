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
  throw new Error('previousPostingDate found no date before ' + beforeIso);
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

/**
 * One row of loan_postings, in the engine's own shape. The database mirror of this is written by
 * postDueInterest; nothing here knows the table exists.
 */
export interface StoredPosting {
  kind: 'posting' | 'adjustment';
  periodStart: string;
  periodEnd: string;
  openingCents: number;
  /** Signed. A posting is never negative; an adjustment usually is. */
  interestCents: number;
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
  /** On an interest row: enough to check the charge by hand (U8). */
  detail?: {
    rateBps: number;
    basis: InterestBasis;
    averageDailyBalanceCents: number;
    daysCounted: number;
    cycleDays: number;
    paidToInterestCents: number;
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
  yearAtThisBalanceCents: number;
}

/** A period as the engine works it out, before anything is written down. */
interface TruePeriod extends StoredPosting {
  kind: 'posting';
  cycleDays: number;
  /** Every movement inside it, so the row builder does not have to filter twice. */
  inside: Movement[];
}

function inWindow(movements: Movement[], from: string, toExclusive: string): Movement[] {
  return movements.filter((movement) => movement.date >= from && movement.date < toExclusive);
}

/**
 * The truth for every closed period, from facts alone -- stored rows are not consulted.
 *
 * This is what makes a correction possible: the engine can always say what the balance SHOULD be,
 * independently of what was written down when, and the difference between the two is the
 * adjustment (K1).
 */
function computePeriods(input: LedgerInput): {
  closed: TruePeriod[];
  open: { start: string; end: string; cycleDays: number; openingCents: number };
} {
  const closed: TruePeriod[] = [];
  let balance = input.startBalanceCents;
  for (const boundary of periodBoundaries(input.startDate, input.postingDay, input.today)) {
    const cycleDays = daysBetweenIso(previousPostingDate(boundary.end, input.postingDay), boundary.end);
    if (!boundary.closed) {
      return { closed, open: { start: boundary.start, end: boundary.end, cycleDays, openingCents: balance } };
    }
    const inside = inWindow(input.movements, boundary.start, boundary.end);
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
    const paymentsCents = inside.reduce(
      (total, movement) => (movement.amountCents < 0 ? total - movement.amountCents : total),
      0,
    );
    const advancesCents = inside.reduce(
      (total, movement) => (movement.amountCents > 0 ? total + movement.amountCents : total),
      0,
    );
    const closingCents = Math.max(0, balance - paymentsCents + advancesCents + charge.interestCents);
    closed.push({
      kind: 'posting',
      periodStart: boundary.start,
      periodEnd: boundary.end,
      openingCents: balance,
      interestCents: charge.interestCents,
      paymentsCents,
      advancesCents,
      closingCents,
      rateBps: rate?.rateBps ?? null,
      basis: rate?.basis ?? null,
      averageDailyBalanceCents: charge.averageDailyBalanceCents,
      note: null,
      cycleDays,
      inside,
    });
    balance = closingCents;
  }
  // Unreachable: periodBoundaries always ends on an open period.
  throw new Error('computePeriods found no open period');
}

/** A posting row, with the two fields only the engine's own walk needs stripped off. */
function asStored(period: TruePeriod): StoredPosting {
  const { cycleDays: _cycleDays, inside: _inside, ...rest } = period;
  return rest;
}

function money(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2);
}

/**
 * The whole ledger: what to write down, what it costs, and the rows a person reads.
 *
 * Called on every page load and before every posting, so it must be cheap and must agree with
 * itself: building a ledger, storing what it says is due, and building it again has to leave
 * nothing due. That property is what lets the same function serve the screen and the scheduler.
 */
export function buildLedger(input: LedgerInput): Ledger {
  const { closed, open } = computePeriods(input);
  const storedPostings = input.stored.filter((row) => row.kind === 'posting');
  const storedEnds = new Set(storedPostings.map((row) => row.periodEnd));
  const duePostings = closed.filter((period) => !storedEnds.has(period.periodEnd)).map(asStored);

  /*
    K1/K2. Compare what the facts say the balance was when the open period began against what the
    written-down rows replay to. A gap means something was recorded after its period had already
    closed -- a payment imported late, a rate corrected, a link undone -- and a gap is settled with
    one dated adjustment rather than by rewriting the periods, because a lender does not restate a
    statement it has already sent and neither should this.
  */
  const beforeOpen = input.movements.filter((movement) => movement.date < open.start);
  const writtenInterest = [...input.stored, ...duePostings].reduce((total, row) => total + row.interestCents, 0);
  const replayedAtOpen = Math.max(
    0,
    input.startBalanceCents + beforeOpen.reduce((total, movement) => total + movement.amountCents, 0) + writtenInterest,
  );
  const gap = open.openingCents - replayedAtOpen;

  let dueAdjustment: StoredPosting | null = null;
  if (gap !== 0 && storedPostings.length > 0) {
    const newest = storedPostings.reduce((best, row) => (row.periodEnd > best.periodEnd ? row : best));
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
      periodStart: input.today,
      periodEnd: input.today,
      openingCents: replayedAtOpen,
      interestCents: gap,
      paymentsCents: 0,
      advancesCents: 0,
      closingCents: replayedAtOpen + gap,
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

  // Rows. One chronological pass: movements as they land, a posting on each period end, any stored
  // adjustment where it was recorded, and the accrual last.
  const openMovements = inWindow(input.movements, open.start, addDaysIso(input.today, 1));
  const openRate = rateOn(open.start, input.rateHistory);

  interface Descriptor {
    date: string;
    order: number;
    make: (balance: number) => { row: LedgerRow; next: number };
  }
  const descriptors: Descriptor[] = [];

  const movementDescriptor = (
    movement: Movement,
    period: { start: string; end: string; cycleDays: number; openingCents: number; inside: Movement[] },
    rate: RateInForce | null,
  ): Descriptor => ({
    date: movement.date,
    order: 0,
    make: (balance) => {
      const next = Math.max(0, balance + movement.amountCents);
      // What had built up by the day the money moved. Shown beside the payment so a person can see
      // the part of it that never touched the loan.
      const accruedToDay = periodCharge({
        start: period.start,
        end: period.end,
        upTo: movement.date,
        cycleDays: period.cycleDays,
        openingCents: period.openingCents,
        principalCents: input.principalCents,
        movements: period.inside,
        rate,
      }).interestCents;
      return {
        next,
        row:
          movement.amountCents < 0
            ? {
                kind: 'payment',
                date: movement.date,
                description: 'Payment',
                paymentCents: -movement.amountCents,
                interestCents: accruedToDay,
                principalCents: null,
                balanceCents: next,
              }
            : {
                kind: 'advance',
                date: movement.date,
                description: 'Advance',
                paymentCents: null,
                interestCents: null,
                principalCents: movement.amountCents,
                balanceCents: next,
              },
      };
    },
  });

  let interestPaidToDateCents = 0;
  let principalPaidToDateCents = 0;
  const storedByEnd = new Map(storedPostings.map((row) => [row.periodEnd, row]));

  for (const period of closed) {
    /*
      A period that has already been posted shows THE FIGURE THAT WAS POSTED, not today's
      recomputation of it. That is the whole difference between a ledger and a projection: a late
      payment does not change what August charged, it produces an adjustment (K2). Taking the
      recomputed figure here as well as the adjustment would count the correction twice.
    */
    const posted = storedByEnd.get(period.periodEnd) ?? period;
    const rate = rateOn(period.periodStart, input.rateHistory);
    for (const movement of period.inside) {
      descriptors.push(
        movementDescriptor(
          movement,
          {
            start: period.periodStart,
            end: period.periodEnd,
            cycleDays: period.cycleDays,
            openingCents: period.openingCents,
            inside: period.inside,
          },
          rate,
        ),
      );
    }
    // A payment covers the period's interest first, then the loan itself (I1).
    const paidToInterestCents = Math.min(period.paymentsCents, posted.interestCents);
    interestPaidToDateCents += paidToInterestCents;
    principalPaidToDateCents += period.paymentsCents - paidToInterestCents;
    descriptors.push({
      date: period.periodEnd,
      order: 1,
      make: (balance) => {
        // Running arithmetic, not the stored closing: a movement recorded late sits between the
        // opening and this posting, so the balance column has to carry it forward.
        const next = Math.max(0, balance + posted.interestCents);
        return {
          next,
          row: {
            kind: 'interest',
            date: period.periodEnd,
            description:
              period.paymentsCents > 0
                ? 'Interest posted. Of ' +
                  money(period.paymentsCents) +
                  ' paid this period, ' +
                  money(paidToInterestCents) +
                  ' covered interest.'
                : 'Interest posted',
            paymentCents: null,
            interestCents: posted.interestCents,
            principalCents: null,
            balanceCents: next,
            detail:
              posted.rateBps === null || posted.basis === null
                ? undefined
                : {
                    rateBps: posted.rateBps,
                    basis: posted.basis,
                    averageDailyBalanceCents: posted.averageDailyBalanceCents ?? period.openingCents,
                    daysCounted: daysBetweenIso(period.periodStart, period.periodEnd),
                    cycleDays: period.cycleDays,
                    paidToInterestCents,
                  },
          },
        };
      },
    });
  }

  for (const movement of openMovements) {
    descriptors.push(movementDescriptor(movement, { ...open, inside: openMovements }, openRate));
  }

  for (const adjustment of input.stored.filter((row) => row.kind === 'adjustment')) {
    descriptors.push({
      date: adjustment.periodEnd,
      order: 2,
      make: (balance) => {
        const next = Math.max(0, balance + adjustment.interestCents);
        return {
          next,
          row: {
            kind: 'adjustment',
            date: adjustment.periodEnd,
            description: adjustment.note ?? 'Adjustment',
            paymentCents: null,
            interestCents: adjustment.interestCents,
            principalCents: null,
            balanceCents: next,
          },
        };
      },
    });
  }

  descriptors.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

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
  let running = input.startBalanceCents;
  for (const descriptor of descriptors) {
    const made = descriptor.make(running);
    running = made.next;
    rows.push(made.row);
  }

  const postedBalanceCents = running;
  const accrued = periodCharge({
    start: open.start,
    end: open.end,
    upTo: input.today,
    cycleDays: open.cycleDays,
    openingCents: open.openingCents,
    principalCents: input.principalCents,
    movements: openMovements,
    rate: openRate,
  });
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
    start: open.start,
    end: open.end,
    cycleDays: open.cycleDays,
    openingCents: postedBalanceCents,
    principalCents: input.principalCents,
    movements: [],
    rate: openRate,
  });

  /*
    "A year at this balance" is twelve charges at the rate in force, or three hundred and sixty-five
    for a daily one -- not a compounded projection. It answers "what is this costing me", which is
    what a household asks, and a compounded figure would silently assume nothing is ever repaid.
  */
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
    yearAtThisBalanceCents,
  };
}

export { PPB, chargeCents, ratePpb };
export type { InterestBasis, Movement };
