import { describe, it, expect } from 'vitest';
import * as C from '@/lib/predict/constants';
import { OUTBOX_RETENTION_DAYS } from '@/lib/notify/outbox';

describe('MUST-3.6: every threshold is a pinned named export', () => {
  it('matches the spec table value for value', () => {
    expect({
      HISTORY_MONTHS: C.HISTORY_MONTHS,
      MIN_HISTORY_MONTHS: C.MIN_HISTORY_MONTHS,
      SEASONAL_MIN_MONTHS: C.SEASONAL_MIN_MONTHS,
      TREND_MIN_ABS_CENTS: C.TREND_MIN_ABS_CENTS,
      TREND_MIN_PCT: C.TREND_MIN_PCT,
      TREND_DAMPING_DIVISOR: C.TREND_DAMPING_DIVISOR,
      SEASONAL_CLAMP_MIN_PCT: C.SEASONAL_CLAMP_MIN_PCT,
      SEASONAL_CLAMP_MAX_PCT: C.SEASONAL_CLAMP_MAX_PCT,
      SUGGESTION_FLOOR_CENTS: C.SUGGESTION_FLOOR_CENTS,
      SUGGESTION_CAP_MULTIPLE: C.SUGGESTION_CAP_MULTIPLE,
      PACE_MIN_DAY_OF_MONTH: C.PACE_MIN_DAY_OF_MONTH,
      PACE_OVERSHOOT_MIN_PCT: C.PACE_OVERSHOOT_MIN_PCT,
      PACE_MAX_PER_EVALUATION: C.PACE_MAX_PER_EVALUATION,
      UNUSUAL_MULTIPLE: C.UNUSUAL_MULTIPLE,
      UNUSUAL_LOOKBACK_DAYS: C.UNUSUAL_LOOKBACK_DAYS,
      UNUSUAL_BASELINE_DAYS: C.UNUSUAL_BASELINE_DAYS,
      UNUSUAL_MIN_SAMPLES: C.UNUSUAL_MIN_SAMPLES,
      UNUSUAL_MIN_ABS_CENTS: C.UNUSUAL_MIN_ABS_CENTS,
      UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS: C.UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS,
      UNUSUAL_MAX_PER_EVALUATION: C.UNUSUAL_MAX_PER_EVALUATION,
      CREEP_LOOKBACK_DAYS: C.CREEP_LOOKBACK_DAYS,
      CREEP_BASELINE_DAYS: C.CREEP_BASELINE_DAYS,
      CREEP_MIN_CHARGES: C.CREEP_MIN_CHARGES,
      CREEP_MONTHLY_GAP_MIN_DAYS: C.CREEP_MONTHLY_GAP_MIN_DAYS,
      CREEP_MONTHLY_GAP_MAX_DAYS: C.CREEP_MONTHLY_GAP_MAX_DAYS,
      CREEP_YEARLY_GAP_MIN_DAYS: C.CREEP_YEARLY_GAP_MIN_DAYS,
      CREEP_YEARLY_GAP_MAX_DAYS: C.CREEP_YEARLY_GAP_MAX_DAYS,
      CREEP_MIN_PCT: C.CREEP_MIN_PCT,
      CREEP_MIN_ABS_CENTS: C.CREEP_MIN_ABS_CENTS,
      CREEP_MAX_PER_EVALUATION: C.CREEP_MAX_PER_EVALUATION,
      RECURRING_LOOKBACK_DAYS: C.RECURRING_LOOKBACK_DAYS,
      RECURRING_MIN_CHARGES: C.RECURRING_MIN_CHARGES,
      RECURRING_STALE_GRACE_DAYS: C.RECURRING_STALE_GRACE_DAYS,
      DUPLICATE_WINDOW_DAYS: C.DUPLICATE_WINDOW_DAYS,
      DUPLICATE_LOOKBACK_DAYS: C.DUPLICATE_LOOKBACK_DAYS,
      DUPLICATE_MIN_ABS_CENTS: C.DUPLICATE_MIN_ABS_CENTS,
      DUPLICATE_MAX_PER_EVALUATION: C.DUPLICATE_MAX_PER_EVALUATION,
      MONTH_REPORT_DAY_MAX: C.MONTH_REPORT_DAY_MAX,
      MONTH_REPORT_MAX_LINES: C.MONTH_REPORT_MAX_LINES,
      SUGGEST_REFRESH_MIN_DELTA_PCT: C.SUGGEST_REFRESH_MIN_DELTA_PCT,
      SUGGEST_REFRESH_MIN_DELTA_CENTS: C.SUGGEST_REFRESH_MIN_DELTA_CENTS,
    }).toEqual({
      HISTORY_MONTHS: 6,
      MIN_HISTORY_MONTHS: 3,
      SEASONAL_MIN_MONTHS: 15,
      TREND_MIN_ABS_CENTS: 2000,
      TREND_MIN_PCT: 10,
      TREND_DAMPING_DIVISOR: 2,
      SEASONAL_CLAMP_MIN_PCT: 50,
      SEASONAL_CLAMP_MAX_PCT: 200,
      SUGGESTION_FLOOR_CENTS: 500,
      SUGGESTION_CAP_MULTIPLE: 3,
      PACE_MIN_DAY_OF_MONTH: 7,
      PACE_OVERSHOOT_MIN_PCT: 110,
      PACE_MAX_PER_EVALUATION: 5,
      UNUSUAL_MULTIPLE: 3,
      UNUSUAL_LOOKBACK_DAYS: 14,
      UNUSUAL_BASELINE_DAYS: 365,
      UNUSUAL_MIN_SAMPLES: 5,
      UNUSUAL_MIN_ABS_CENTS: 5000,
      UNUSUAL_MIN_HOUSEHOLD_HISTORY_DAYS: 60,
      UNUSUAL_MAX_PER_EVALUATION: 5,
      CREEP_LOOKBACK_DAYS: 35,
      CREEP_BASELINE_DAYS: 365,
      CREEP_MIN_CHARGES: 4,
      CREEP_MONTHLY_GAP_MIN_DAYS: 25,
      CREEP_MONTHLY_GAP_MAX_DAYS: 35,
      CREEP_YEARLY_GAP_MIN_DAYS: 350,
      CREEP_YEARLY_GAP_MAX_DAYS: 380,
      CREEP_MIN_PCT: 5,
      CREEP_MIN_ABS_CENTS: 100,
      CREEP_MAX_PER_EVALUATION: 5,
      RECURRING_LOOKBACK_DAYS: 1200,
      RECURRING_MIN_CHARGES: 3,
      RECURRING_STALE_GRACE_DAYS: 10,
      DUPLICATE_WINDOW_DAYS: 3,
      DUPLICATE_LOOKBACK_DAYS: 14,
      DUPLICATE_MIN_ABS_CENTS: 1000,
      DUPLICATE_MAX_PER_EVALUATION: 5,
      MONTH_REPORT_DAY_MAX: 3,
      MONTH_REPORT_MAX_LINES: 8,
      SUGGEST_REFRESH_MIN_DELTA_PCT: 10,
      SUGGEST_REFRESH_MIN_DELTA_CENTS: 1000,
    });
  });
});

describe('F-05: the recurring window is wide enough for the cadence it claims to detect', () => {
  it('can contain three charges a year apart plus a full staleness allowance', () => {
    // The proposal said "the last 12 months". Three charges at the yearly band's own widest gap
    // span 2 * CREEP_YEARLY_GAP_MAX_DAYS, and the newest of them may itself be a band-width plus
    // the grace old -- so anything narrower than this makes the yearly cadence undetectable
    // rather than merely rare, and the card would have been monthly-only without saying so.
    const widestSpan = 2 * C.CREEP_YEARLY_GAP_MAX_DAYS + C.CREEP_YEARLY_GAP_MAX_DAYS + C.RECURRING_STALE_GRACE_DAYS;
    expect(C.RECURRING_LOOKBACK_DAYS).toBeGreaterThanOrEqual(widestSpan);
    expect(365).toBeLessThan(widestSpan);
  });

  it('reads the cadence from the SAME bands the creep alert does', () => {
    // F-05 declares no bands of its own: recurringBand() (src/lib/predict/anomalies.ts) reads
    // these four. A fifth constant appearing here for "the recurring card's monthly band" is
    // the drift this asserts against.
    expect([C.CREEP_MONTHLY_GAP_MIN_DAYS, C.CREEP_MONTHLY_GAP_MAX_DAYS]).toEqual([25, 35]);
    expect([C.CREEP_YEARLY_GAP_MIN_DAYS, C.CREEP_YEARLY_GAP_MAX_DAYS]).toEqual([350, 380]);
  });
});

describe('MUST-3.7: every lookback that appears in a dedup key is far inside outbox retention', () => {
  it('compares against the imported constant, not a copied number', () => {
    expect(C.UNUSUAL_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    expect(C.CREEP_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    expect(C.DUPLICATE_LOOKBACK_DAYS).toBeLessThan(OUTBOX_RETENTION_DAYS);
    // Pins the widest of the three at its current value, so widening one is a reviewed
    // edit here as well as in constants.ts. The three assertions above are what actually
    // guard the 400-day retention boundary.
    expect(Math.max(C.UNUSUAL_LOOKBACK_DAYS, C.CREEP_LOOKBACK_DAYS, C.DUPLICATE_LOOKBACK_DAYS)).toBe(35);
  });
});
