import { daysBetweenIso } from '@/lib/dates';
import {
  CREEP_LOOKBACK_DAYS,
  CREEP_MIN_ABS_CENTS,
  CREEP_MIN_CHARGES,
  CREEP_MIN_PCT,
  CREEP_MONTHLY_GAP_MAX_DAYS,
  CREEP_MONTHLY_GAP_MIN_DAYS,
  CREEP_YEARLY_GAP_MAX_DAYS,
  CREEP_YEARLY_GAP_MIN_DAYS,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_MIN_ABS_CENTS,
  DUPLICATE_WINDOW_DAYS,
  RECURRING_MIN_CHARGES,
  RECURRING_STALE_GRACE_DAYS,
  UNUSUAL_MIN_ABS_CENTS,
  UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS,
  UNUSUAL_MIN_SAMPLES,
  UNUSUAL_MULTIPLE,
} from '@/lib/predict/constants';
import { medianCents } from '@/lib/predict/stats';

/**
 * The three anomaly detectors, PURE (MUST-2.1). They decide over rows a caller has already
 * read; the queries live in src/lib/notify/evaluate/anomalies.ts.
 */

/** One non-transfer spend row, as the evaluator reads it. amountCents is signed. */
export interface SpendRow {
  id: number;
  date: string;
  merchant: string;
  categoryId: number | null;
  amountCents: number;
}

/** MUST-9.10 condition 1: a first import has no baseline to be unusual against. */
export function hasEnoughHouseholdHistory(firstDateIso: string | null, today: string): boolean {
  if (firstDateIso === null) return false;
  return daysBetweenIso(firstDateIso, today) >= UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS;
}

export interface UnusualVerdict {
  baselineCents: number;
  baselineKind: 'merchant' | 'category';
}

/**
 * MUST-9.10 conditions 2 to 5. Both samples arrive with the tested row already excluded
 * (MUST-9.11): including it pulls the median toward the outlier and makes a large charge
 * partly responsible for deciding it is not large.
 *
 * A zero baseline is refused because every charge is three times zero.
 */
export function unusualVerdict(input: {
  amountCents: number;
  merchantSample: number[];
  categorySample: number[];
}): UnusualVerdict | null {
  if (input.amountCents >= 0) return null;
  const spend = Math.abs(input.amountCents);
  if (spend < UNUSUAL_MIN_ABS_CENTS) return null;

  const kind: 'merchant' | 'category' | null =
    input.merchantSample.length >= UNUSUAL_MIN_SAMPLES
      ? 'merchant'
      : input.categorySample.length >= UNUSUAL_MIN_SAMPLES
        ? 'category'
        : null;
  if (kind === null) return null;

  const baselineCents = medianCents(kind === 'merchant' ? input.merchantSample : input.categorySample);
  if (baselineCents === null || baselineCents <= 0) return null;
  if (spend < UNUSUAL_MULTIPLE * baselineCents) return null;
  return { baselineCents, baselineKind: kind };
}

export interface CreepVerdict {
  transactionId: number;
  dateIso: string;
  newAmountCents: number;
  baselineCents: number;
  priorCount: number;
}

/** The two cadences this app recognises. Weekly and quarterly are out of scope (MUST-9.15). */
export type RecurringCadence = 'monthly' | 'yearly';

/**
 * MUST-9.15's two bands, now returning WHICH one matched rather than a bare yes.
 *
 * F-05 (v1.31.0) needs the name of the band to say "monthly" or "yearly" on a card and to pick
 * the staleness allowance below; creepVerdict needs only the yes/no it always had, and
 * isRecurringGap() is kept as its one-line caller so that reading stays byte-identical. One
 * definition of "what a monthly gap is", two callers -- the alternative (a second pair of
 * comparisons inside the new detector) is how the Reports/Budgets spend disagreement started.
 */
function recurringBand(medianGapDays: number): RecurringCadence | null {
  if (medianGapDays >= CREEP_MONTHLY_GAP_MIN_DAYS && medianGapDays <= CREEP_MONTHLY_GAP_MAX_DAYS) return 'monthly';
  if (medianGapDays >= CREEP_YEARLY_GAP_MIN_DAYS && medianGapDays <= CREEP_YEARLY_GAP_MAX_DAYS) return 'yearly';
  return null;
}

/** MUST-9.15: monthly and yearly are the two bands. Weekly and quarterly are out of scope. */
function isRecurringGap(medianGapDays: number): boolean {
  return recurringBand(medianGapDays) !== null;
}

/** The band's own upper edge, which is what "how late may the newest charge be" is measured from. */
function bandMaxDays(cadence: RecurringCadence): number {
  return cadence === 'monthly' ? CREEP_MONTHLY_GAP_MAX_DAYS : CREEP_YEARLY_GAP_MAX_DAYS;
}

/**
 * MUST-9.15 and MUST-9.16, over one merchant's non-transfer spend rows from the last
 * CREEP_BASELINE_DAYS, ascending by date. Returns the newest charge when its price went up.
 *
 * MUST-9.17: the next month's charge at the new price does not fire again, because by then
 * the median of the preceding charges has moved and the percentage condition fails.
 */
export function creepVerdict(input: { charges: SpendRow[]; today: string }): CreepVerdict | null {
  const charges = [...input.charges].sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  if (charges.length < CREEP_MIN_CHARGES) return null;

  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const medianGap = medianCents(gaps);
  if (medianGap === null || !isRecurringGap(medianGap)) return null;

  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > CREEP_LOOKBACK_DAYS) return null;

  const preceding = charges.slice(0, -1).map((charge) => Math.abs(charge.amountCents));
  const baselineCents = medianCents(preceding);
  if (baselineCents === null || baselineCents <= 0) return null;

  const newAmountCents = Math.abs(latest.amountCents);
  if (newAmountCents <= baselineCents) return null;

  const rise = newAmountCents - baselineCents;
  // Both thresholds, so neither a large cheap subscription nor a tiny expensive one slips
  // through on a technicality.
  if (rise * 100 < baselineCents * CREEP_MIN_PCT) return null;
  if (rise < CREEP_MIN_ABS_CENTS) return null;

  return { transactionId: latest.id, dateIso: latest.date, newAmountCents, baselineCents, priorCount: preceding.length };
}

/**
 * F-05 (2026-09-02 review, v1.31.0). What creepVerdict already knew, asked as a different
 * question: not "did this merchant's price go up" but "is this merchant charging on a cadence at
 * all, and is it still charging". PURE, beside creepVerdict, because it decides over the same
 * rows from the same 25-35 / 350-380 day bands -- putting it anywhere else would have meant a
 * second, drifting definition of a monthly charge.
 *
 * WHAT THIS RETURNS IS A CADENCE, NOT A SUBSCRIPTION. Nothing here can distinguish a streaming
 * service from a once-a-month grocery shop or a utility bill that varies: they produce the same
 * dates. The verdict deliberately carries no `isSubscription`, no confidence score and no
 * category guess, so no caller can render a claim this function did not make -- the household
 * decides what a row is, by recording it (F-05's "Track"). This is the same rule three v1.30.0
 * fixes rest on: state what was measured, never what it implies.
 *
 * `charges` is ONE merchant's spend rows over a window at least RECURRING_LOOKBACK_DAYS wide,
 * in any order. Amounts are signed as the ledger stores them; the verdict reports magnitudes.
 */
export interface RecurringVerdict {
  cadence: RecurringCadence;
  /** How many charges the cadence was read from -- the card prints it, so a 3-charge row and a
   *  30-charge row are not presented as equally established. */
  chargeCount: number;
  medianGapDays: number;
  /** The newest charge: what "Track" prefills from, and what the card's amount/date columns say. */
  latestId: number;
  latestDateIso: string;
  /** Magnitude, not the ledger's negative. */
  latestAmountCents: number;
  /** Median magnitude across every charge -- the honest answer to "what does this usually cost",
   *  and how a variable bill shows itself when it sits well away from the latest amount. */
  typicalCents: number;
}

export function recurringVerdict(input: { charges: SpendRow[]; today: string }): RecurringVerdict | null {
  const charges = [...input.charges]
    // A refund or a reversal on the same merchant is not one of its charges, and a future-dated
    // row (a post-dated entry, a bad import) is not evidence of anything yet -- the same L-8
    // reasoning findDuplicates() applies below.
    .filter((charge) => charge.amountCents < 0 && charge.date <= input.today)
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  if (charges.length < RECURRING_MIN_CHARGES) return null;

  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const medianGapDays = medianCents(gaps);
  if (medianGapDays === null) return null;
  const cadence = recurringBand(medianGapDays);
  if (cadence === null) return null;

  /**
   * Every gap must itself sit in the band the median chose -- not just the median (2026-09-02
   * review, I-1). At the 3-charge floor there are exactly two gaps, and medianCents() of two
   * values is their mean, not an observed interval: gaps of 1 and 59 days average to 30 and,
   * without this check, would read as a confident "Monthly" though neither gap is a month.
   * Raising RECURRING_MIN_CHARGES instead was rejected -- it does not fix the averaging, it only
   * moves the count at which it can still happen (three gaps of 1, 1 and 88 average to 30 too).
   * Requiring the band on every gap is what stops a mean from posing as a rhythm, at any count,
   * and is why the 3-charge floor above can stay put.
   */
  if (!gaps.every((gap) => recurringBand(gap) === cadence)) return null;

  /**
   * STILL charging, not "once charged". This is the condition the wide window (see
   * RECURRING_LOOKBACK_DAYS) makes load-bearing: a subscription cancelled two years ago has a
   * textbook monthly median gap inside that window, and listing it as a current commitment
   * would be the exact overclaim F-05 is written to avoid. One band-width plus a small grace,
   * so a renewal read a fortnight after its anniversary still counts and one read a year late
   * does not.
   */
  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > bandMaxDays(cadence) + RECURRING_STALE_GRACE_DAYS) return null;

  const typicalCents = medianCents(charges.map((charge) => Math.abs(charge.amountCents)));
  if (typicalCents === null) return null;

  return {
    cadence,
    chargeCount: charges.length,
    medianGapDays,
    latestId: latest.id,
    latestDateIso: latest.date,
    latestAmountCents: Math.abs(latest.amountCents),
    typicalCents,
  };
}

export interface DuplicatePair {
  lowerId: number;
  higherId: number;
  merchant: string;
  amountCents: number;
  earlierDateIso: string;
  laterDateIso: string;
}

/**
 * MUST-9.20 to MUST-9.23. `rows` covers the last DUPLICATE_LOOKBACK_DAYS + DUPLICATE_WINDOW_DAYS
 * days, so a pair whose later half sits on the lookback boundary still has its earlier half.
 *
 * MUST-9.21: everything reaching here already survived transactions_dedup_uq and the
 * SimpleFIN external_id index, so it is either a genuine second charge or a bank reporting
 * one charge twice. The message says exactly that.
 */
export function findDuplicates(input: { rows: SpendRow[]; today: string }): DuplicatePair[] {
  const groups = new Map<string, SpendRow[]>();
  for (const row of input.rows) {
    if (row.amountCents >= 0) continue;
    if (Math.abs(row.amountCents) < DUPLICATE_MIN_ABS_CENTS) continue;
    const key = `${row.merchant}\u0000${row.amountCents}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const pairs: DuplicatePair[] = [];
  for (const group of groups.values()) {
    const ordered = group.slice().sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
    for (let index = 1; index < ordered.length; index += 1) {
      const later = ordered[index];
      // L-8: aligned with the unusual detector (src/lib/notify/evaluate/anomalies.ts), which
      // also rejects a future-dated row (a post-dated entry or a bad import) rather than
      // treating it as "within the last N days". Sorted ascending, so once `later` clears this
      // check every earlier row in the same group does too.
      if (later.date > input.today) continue;
      if (daysBetweenIso(later.date, input.today) > DUPLICATE_LOOKBACK_DAYS) continue;
      // MUST-9.23: the single NEAREST earlier match, never all of them. Three identical
      // charges on three consecutive days produce two events, not three.
      const earlier = ordered[index - 1];
      if (daysBetweenIso(earlier.date, later.date) > DUPLICATE_WINDOW_DAYS) continue;
      pairs.push({
        lowerId: Math.min(earlier.id, later.id),
        higherId: Math.max(earlier.id, later.id),
        merchant: later.merchant,
        amountCents: later.amountCents,
        earlierDateIso: earlier.date,
        laterDateIso: later.date,
      });
    }
  }
  return pairs.sort((a, b) => (a.laterDateIso === b.laterDateIso ? a.higherId - b.higherId : a.laterDateIso < b.laterDateIso ? -1 : 1));
}
