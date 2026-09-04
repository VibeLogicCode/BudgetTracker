/**
 * Every threshold and window this release uses, in one place, PURE (MUST-2.1, MUST-3.6).
 *
 * No magic number appears in suggest.ts, pace.ts, anomalies.ts or any evaluator. A test
 * pins each value, so changing one is a reviewed edit rather than a silent behaviour change.
 *
 * These are module constants, not stored settings (spec D2): notification_user_settings is a
 * fixed-column table with SQL range CHECKs, so a per-user threshold there needs a migration,
 * which MUST-1.4 rules out; the settings key/value table is household-wide, so a per-user
 * "what counts as unusual for me" is not expressible there either.
 */

// The history window (spec section 4)
export const HISTORY_MONTHS = 6; // last 6 full calendar months
export const MIN_HISTORY_MONTHS = 3; // fewer than this: no suggestion at all
export const SEASONAL_MIN_MONTHS = 15; // 12 for the reference year, plus 3 more

// The suggestion (spec section 6)
export const TREND_MIN_ABS_CENTS = 2000; // $20
export const TREND_MIN_PCT = 10;
export const TREND_DAMPING_DIVISOR = 2; // apply half the observed move
export const SEASONAL_CLAMP_MIN_PCT = 50; // ratio floor, 0.5x
export const SEASONAL_CLAMP_MAX_PCT = 200; // ratio ceiling, 2.0x
export const SUGGESTION_FLOOR_CENTS = 500; // $5, below which no suggestion is offered
export const SUGGESTION_CAP_MULTIPLE = 3; // never more than 3x the median

// The pace projection (spec section 8)
export const PACE_MIN_DAY_OF_MONTH = 7;

// The pace notification (spec section 9.2)
export const PACE_OVERSHOOT_MIN_PCT = 110; // projected must reach 110% of the limit
export const PACE_MAX_PER_EVALUATION = 5; // same cap shape as the three anomaly detectors below

// Unusual transaction (spec section 9.3)
export const UNUSUAL_MULTIPLE = 3;
export const UNUSUAL_LOOKBACK_DAYS = 14;
export const UNUSUAL_BASELINE_DAYS = 365;
export const UNUSUAL_MIN_SAMPLES = 5;
export const UNUSUAL_MIN_ABS_CENTS = 5000; // $50
export const UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS = 60;
export const UNUSUAL_MAX_PER_EVALUATION = 5;

// Subscription creep (spec section 9.4)
export const CREEP_LOOKBACK_DAYS = 35;
export const CREEP_BASELINE_DAYS = 365;
export const CREEP_MIN_CHARGES = 4; // 3 baseline charges plus the new one
export const CREEP_MONTHLY_GAP_MIN_DAYS = 25;
export const CREEP_MONTHLY_GAP_MAX_DAYS = 35;
export const CREEP_YEARLY_GAP_MIN_DAYS = 350;
export const CREEP_YEARLY_GAP_MAX_DAYS = 380;
export const CREEP_MIN_PCT = 5;
export const CREEP_MIN_ABS_CENTS = 100; // $1
export const CREEP_MAX_PER_EVALUATION = 5;

// Recurring commitments (F-05, 2026-09-02 review, v1.31.0). The bands themselves are the
// CREEP_*_GAP_* pair above, reused rather than re-declared: "what a monthly cadence looks like"
// must mean one thing, or the Recurring charges card and the subscription-creep alert would
// disagree about the same merchant on the same day.
/**
 * Why a little over three YEARS and not the proposal's "last 12 months": three charges at a
 * yearly gap span 700 to 760 days, so a 365-day slice cannot contain them -- the yearly band
 * would have been structurally unreachable and the card would silently have been monthly-only.
 * 1200 = the widest span the detector can still accept (760 days of gaps, plus a latest charge
 * up to CREEP_YEARLY_GAP_MAX_DAYS + RECURRING_STALE_GRACE_DAYS old) rounded up.
 *
 * The cost is one indexed range scan over transactions.date returning four narrow columns --
 * the same shape readSlice (src/lib/insights.ts) already runs over 365 days, three times as
 * long. Narrowing it per band (13 months for monthly, 1200 days for yearly) was rejected: two
 * windows means two queries and two answers to "what did this card look at", for a scan that
 * is one row per charge either way.
 */
export const RECURRING_LOOKBACK_DAYS = 1200;
/** Two gaps is the fewest that can have a median at all; one gap is a coincidence with a name. */
export const RECURRING_MIN_CHARGES = 3;
/**
 * How late a charge may be before the cadence reads as STOPPED rather than current. Added
 * because the wide window above makes staleness the live risk: a subscription cancelled two
 * years ago still has a textbook monthly gap inside 1200 days, and listing it as a recurring
 * commitment -- worse, counting it in a total -- would be asserting something the data says the
 * opposite of. An annual renewal that fell on the 5th and is now read on the 20th is 380 days
 * out, so the grace sits just above the band, not far above it.
 */
export const RECURRING_STALE_GRACE_DAYS = 10;

// Duplicate charge (spec section 9.5)
export const DUPLICATE_WINDOW_DAYS = 3;
export const DUPLICATE_LOOKBACK_DAYS = 14;
export const DUPLICATE_MIN_ABS_CENTS = 1000; // $10
export const DUPLICATE_MAX_PER_EVALUATION = 5;

// The two month-boundary reports (spec sections 9.6, 9.7)
export const MONTH_REPORT_DAY_MAX = 3; // fires on day 1, 2 or 3 of the month
export const MONTH_REPORT_MAX_LINES = 8;
export const SUGGEST_REFRESH_MIN_DELTA_PCT = 10;
export const SUGGEST_REFRESH_MIN_DELTA_CENTS = 1000; // $10
