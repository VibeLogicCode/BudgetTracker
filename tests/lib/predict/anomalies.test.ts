import { describe, it, expect } from 'vitest';
import { addDaysIso } from '@/lib/dates';
import {
  creepVerdict,
  findDuplicates,
  hasEnoughHouseholdHistory,
  recurringVerdict,
  unusualVerdict,
  type SpendRow,
} from '@/lib/predict/anomalies';
import {
  CREEP_LOOKBACK_DAYS,
  CREEP_MONTHLY_GAP_MAX_DAYS,
  CREEP_MONTHLY_GAP_MIN_DAYS,
  CREEP_YEARLY_GAP_MAX_DAYS,
  CREEP_YEARLY_GAP_MIN_DAYS,
  DUPLICATE_LOOKBACK_DAYS,
  DUPLICATE_WINDOW_DAYS,
  RECURRING_STALE_GRACE_DAYS,
} from '@/lib/predict/constants';

const TODAY = '2026-08-18';

function row(over: Partial<SpendRow> & { id: number; date: string; amountCents: number }): SpendRow {
  return { merchant: 'NETFLIX', categoryId: 1, ...over };
}

describe('MUST-9.10 condition 1: the household history floor', () => {
  it('is silent on a first import and speaks once there are 60 days', () => {
    expect(hasEnoughHouseholdHistory(null, TODAY)).toBe(false);
    expect(hasEnoughHouseholdHistory('2026-07-01', TODAY)).toBe(false);
    expect(hasEnoughHouseholdHistory('2026-06-19', TODAY)).toBe(true);
  });
});

describe('MUST-9.10: unusualVerdict', () => {
  const usual = [12000, 12100, 11900, 12200, 12000];

  it('fires on a charge three times the merchant baseline', () => {
    expect(unusualVerdict({ amountCents: -41288, merchantSample: usual, categorySample: [] })).toEqual({
      baselineCents: 12000,
      baselineKind: 'merchant',
    });
  });

  it('does not fire on a refund or a deposit', () => {
    expect(unusualVerdict({ amountCents: 41288, merchantSample: usual, categorySample: [] })).toBeNull();
  });

  it('does not fire under the $50 floor, however large the multiple', () => {
    expect(unusualVerdict({ amountCents: -400, merchantSample: [100, 100, 100, 100, 100], categorySample: [] })).toBeNull();
  });

  it('does not fire under a 3x multiple', () => {
    expect(unusualVerdict({ amountCents: -35000, merchantSample: usual, categorySample: [] })).toBeNull();
    expect(unusualVerdict({ amountCents: -36000, merchantSample: usual, categorySample: [] })?.baselineKind).toBe('merchant');
  });

  it('falls back to the category baseline under five merchant samples, then to nothing', () => {
    const category = [10000, 10000, 10000, 10000, 10000];
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [12000], categorySample: category })).toEqual({
      baselineCents: 10000,
      baselineKind: 'category',
    });
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [12000], categorySample: [10000] })).toBeNull();
  });

  it('does not fire against a zero baseline, which would make every charge a triple', () => {
    expect(unusualVerdict({ amountCents: -41288, merchantSample: [0, 0, 0, 0, 0], categorySample: [] })).toBeNull();
  });
});

describe('MUST-9.15 and MUST-9.16: creepVerdict', () => {
  const monthlyCharges: SpendRow[] = [
    row({ id: 1, date: '2026-05-14', amountCents: -1649 }),
    row({ id: 2, date: '2026-06-14', amountCents: -1649 }),
    row({ id: 3, date: '2026-07-14', amountCents: -1649 }),
    row({ id: 4, date: '2026-08-14', amountCents: -2099 }),
  ];

  it('fires on a monthly subscription whose newest charge went up', () => {
    expect(creepVerdict({ charges: monthlyCharges, today: TODAY })).toEqual({
      transactionId: 4,
      dateIso: '2026-08-14',
      newAmountCents: 2099,
      baselineCents: 1649,
      priorCount: 3,
    });
  });

  it('needs at least four charges', () => {
    expect(creepVerdict({ charges: monthlyCharges.slice(1), today: TODAY })).toBeNull();
  });

  // Four charges ending on 2026-08-14, which is four days inside the 35-day lookback, spaced
  // `days` apart. Only the gap band changes between cases.
  const at = (days: number) =>
    creepVerdict({
      charges: [0, 1, 2, 3].map((step) =>
        row({ id: step + 1, date: addDaysIso('2026-08-14', -(3 - step) * days), amountCents: step === 3 ? -2099 : -1649 }),
      ),
      today: TODAY,
    });

  it('accepts a 28-day gap and a 365-day gap, and rejects 7 and 90', () => {
    expect(at(28)).not.toBeNull();
    expect(at(365)).not.toBeNull();
    expect(at(7)).toBeNull();
    expect(at(90)).toBeNull();
  });

  it('boundary: the monthly band fires at its two edges and not one day outside them', () => {
    expect(at(CREEP_MONTHLY_GAP_MIN_DAYS)).not.toBeNull();
    expect(at(CREEP_MONTHLY_GAP_MAX_DAYS)).not.toBeNull();
    expect(at(CREEP_MONTHLY_GAP_MIN_DAYS - 1)).toBeNull();
    expect(at(CREEP_MONTHLY_GAP_MAX_DAYS + 1)).toBeNull();
  });

  it('boundary: the yearly band fires at its lower edge', () => {
    expect(at(CREEP_YEARLY_GAP_MIN_DAYS)).not.toBeNull();
  });

  it('does not fire when the newest charge is older than the 35-day lookback', () => {
    const stale = monthlyCharges.map((charge) => row({ ...charge, date: addDaysIso(charge.date, -60) }));
    expect(creepVerdict({ charges: stale, today: TODAY })).toBeNull();
  });

  it('boundary: fires when the newest charge is exactly CREEP_LOOKBACK_DAYS old, not one day older', () => {
    // Charges spaced 30 days apart (inside the monthly band), ending `daysOld` before TODAY.
    const agedCharges = (daysOld: number): SpendRow[] =>
      [0, 1, 2, 3].map((step) =>
        row({ id: step + 1, date: addDaysIso(TODAY, -daysOld - (3 - step) * 30), amountCents: step === 3 ? -2099 : -1649 }),
      );
    expect(creepVerdict({ charges: agedCharges(CREEP_LOOKBACK_DAYS), today: TODAY })).not.toBeNull();
    expect(creepVerdict({ charges: agedCharges(CREEP_LOOKBACK_DAYS + 1), today: TODAY })).toBeNull();
  });

  it('does not fire when the increase clears only one of the two thresholds', () => {
    // 5 percent of $16.49 is 82 cents, under the $1 floor, so a 90-cent rise fails.
    const smallAbsolute = [...monthlyCharges.slice(0, 3), row({ id: 4, date: '2026-08-14', amountCents: -1739 })];
    expect(creepVerdict({ charges: smallAbsolute, today: TODAY })).toBeNull();
    // $1 on a $100 subscription is 1 percent, under the 5 percent floor.
    const bigBase: SpendRow[] = [
      row({ id: 1, date: '2026-05-14', amountCents: -100000 }),
      row({ id: 2, date: '2026-06-14', amountCents: -100000 }),
      row({ id: 3, date: '2026-07-14', amountCents: -100000 }),
      row({ id: 4, date: '2026-08-14', amountCents: -100100 }),
    ];
    expect(creepVerdict({ charges: bigBase, today: TODAY })).toBeNull();
  });

  it('does not fire when the newest charge went down', () => {
    const cheaper = [...monthlyCharges.slice(0, 3), row({ id: 4, date: '2026-08-14', amountCents: -1000 })];
    expect(creepVerdict({ charges: cheaper, today: TODAY })).toBeNull();
  });
});

describe('F-05: recurringVerdict reports a cadence, and only a cadence', () => {
  /** Thirteen monthly charges ending three days before TODAY -- an ordinary current commitment. */
  const monthly = (over: { amountCents?: (index: number) => number; count?: number; endsDaysAgo?: number } = {}): SpendRow[] => {
    const count = over.count ?? 13;
    const endsDaysAgo = over.endsDaysAgo ?? 3;
    return Array.from({ length: count }, (_unused, index) =>
      row({
        id: index + 1,
        date: addDaysIso(TODAY, -endsDaysAgo - (count - 1 - index) * 30),
        amountCents: over.amountCents ? over.amountCents(index) : -1649,
      }),
    );
  };

  it('names the monthly cadence, the newest charge and what the charge usually is', () => {
    expect(recurringVerdict({ charges: monthly(), today: TODAY })).toEqual({
      cadence: 'monthly',
      chargeCount: 13,
      medianGapDays: 30,
      latestId: 13,
      latestDateIso: addDaysIso(TODAY, -3),
      latestAmountCents: 1649,
      typicalCents: 1649,
    });
  });

  it('reports the typical amount as the median, so a variable bill shows the gap between the two', () => {
    // Five charges: 40, 60, 80, 100 and 300 dollars. The latest is the outlier; "usually" is 80.
    const varying = monthly({ count: 5, amountCents: (index) => [-4000, -6000, -8000, -10000, -30000][index] });
    const verdict = recurringVerdict({ charges: varying, today: TODAY });
    expect(verdict?.typicalCents).toBe(8000);
    expect(verdict?.latestAmountCents).toBe(30000);
  });

  it('needs three charges: two are one gap, and one gap is a coincidence with a name', () => {
    expect(recurringVerdict({ charges: monthly({ count: 2 }), today: TODAY })).toBeNull();
    expect(recurringVerdict({ charges: monthly({ count: 3 }), today: TODAY })?.cadence).toBe('monthly');
  });

  it('names the yearly cadence, which needs more than 12 months of history to exist at all', () => {
    const yearly = [
      row({ id: 1, date: addDaysIso(TODAY, -735), amountCents: -11999 }),
      row({ id: 2, date: addDaysIso(TODAY, -370), amountCents: -11999 }),
      row({ id: 3, date: addDaysIso(TODAY, -5), amountCents: -12999 }),
    ];
    expect(recurringVerdict({ charges: yearly, today: TODAY })).toMatchObject({ cadence: 'yearly', chargeCount: 3 });
    // The point of RECURRING_LOOKBACK_DAYS: the earliest of these sits well outside a 365-day slice.
    expect(735).toBeGreaterThan(365);
  });

  it('says nothing about a weekly or a quarterly rhythm -- monthly and yearly are the only bands', () => {
    const weekly = Array.from({ length: 12 }, (_unused, index) =>
      row({ id: index + 1, date: addDaysIso(TODAY, -index * 7), amountCents: -8500 }),
    );
    expect(recurringVerdict({ charges: weekly, today: TODAY })).toBeNull();
    const quarterly = Array.from({ length: 5 }, (_unused, index) =>
      row({ id: index + 1, date: addDaysIso(TODAY, -index * 91), amountCents: -8500 }),
    );
    expect(recurringVerdict({ charges: quarterly, today: TODAY })).toBeNull();
  });

  it('holds the band edges exactly where creepVerdict holds them', () => {
    for (const gap of [CREEP_MONTHLY_GAP_MIN_DAYS, CREEP_MONTHLY_GAP_MAX_DAYS]) {
      const charges = Array.from({ length: 4 }, (_unused, index) =>
        row({ id: index + 1, date: addDaysIso(TODAY, -(3 - index) * gap), amountCents: -1649 }),
      );
      expect(recurringVerdict({ charges, today: TODAY })?.cadence).toBe('monthly');
    }
    const justOutside = Array.from({ length: 4 }, (_unused, index) =>
      row({ id: index + 1, date: addDaysIso(TODAY, -(3 - index) * (CREEP_MONTHLY_GAP_MAX_DAYS + 1)), amountCents: -1649 }),
    );
    expect(recurringVerdict({ charges: justOutside, today: TODAY })).toBeNull();
    expect(CREEP_YEARLY_GAP_MIN_DAYS).toBeGreaterThan(CREEP_MONTHLY_GAP_MAX_DAYS + 1);
  });

  it('drops a cadence that STOPPED: a cancelled subscription is not a current commitment', () => {
    // The gaps are still textbook monthly; the newest charge is a year old.
    expect(recurringVerdict({ charges: monthly({ endsDaysAgo: 365 }), today: TODAY })).toBeNull();
    // One band-width plus the grace still counts; a day past it does not.
    const grace = CREEP_MONTHLY_GAP_MAX_DAYS + RECURRING_STALE_GRACE_DAYS;
    expect(recurringVerdict({ charges: monthly({ endsDaysAgo: grace }), today: TODAY })?.cadence).toBe('monthly');
    expect(recurringVerdict({ charges: monthly({ endsDaysAgo: grace + 1 }), today: TODAY })).toBeNull();
    // The yearly band gets the wider allowance its own edge implies, not the monthly one.
    const yearly = Array.from({ length: 3 }, (_unused, index) =>
      row({ id: index + 1, date: addDaysIso(TODAY, -(CREEP_YEARLY_GAP_MAX_DAYS + RECURRING_STALE_GRACE_DAYS) - (2 - index) * 365), amountCents: -11999 }),
    );
    expect(recurringVerdict({ charges: yearly, today: TODAY })?.cadence).toBe('yearly');
  });

  it('counts charges only: a refund and a future-dated row are neither', () => {
    const withRefund = [...monthly(), row({ id: 99, date: addDaysIso(TODAY, -2), amountCents: 1649 })];
    expect(recurringVerdict({ charges: withRefund, today: TODAY })?.chargeCount).toBe(13);
    const withFuture = [...monthly(), row({ id: 98, date: addDaysIso(TODAY, 20), amountCents: -1649 })];
    const verdict = recurringVerdict({ charges: withFuture, today: TODAY });
    expect(verdict?.chargeCount).toBe(13);
    expect(verdict?.latestDateIso).toBe(addDaysIso(TODAY, -3));
  });

  it('asserts a cadence and nothing else -- no subscription claim to render', () => {
    const verdict = recurringVerdict({ charges: monthly(), today: TODAY });
    expect(Object.keys(verdict ?? {}).sort()).toEqual([
      'cadence',
      'chargeCount',
      'latestAmountCents',
      'latestDateIso',
      'latestId',
      'medianGapDays',
      'typicalCents',
    ]);
  });

  it('is order-insensitive: the caller may hand rows over in any order', () => {
    const shuffled = [...monthly()].reverse();
    expect(recurringVerdict({ charges: shuffled, today: TODAY })).toEqual(
      recurringVerdict({ charges: monthly(), today: TODAY }),
    );
  });

  it('I-1 (2026-09-02 review): does not claim a cadence when a two-value median is only the MEAN of two out-of-band gaps', () => {
    // Gaps of 1 day and 59 days average (medianCents of two values) to 30, which sits inside the
    // monthly band though neither gap does -- reproduced verbatim from the review.
    const monthlyShape: SpendRow[] = [
      row({ id: 1, date: '2026-06-30', amountCents: -1000 }),
      row({ id: 2, date: '2026-07-01', amountCents: -1000 }),
      row({ id: 3, date: '2026-08-29', amountCents: -1000 }),
    ];
    expect(recurringVerdict({ charges: monthlyShape, today: '2026-08-29' })).toBeNull();

    // Gaps of 26 days and 704 days average to 365, which sits inside the yearly band though
    // neither gap does -- same shape, reproduced in the yearly band.
    const yearlyShape: SpendRow[] = [
      row({ id: 1, date: '2024-09-01', amountCents: -1000 }),
      row({ id: 2, date: '2024-09-27', amountCents: -1000 }),
      row({ id: 3, date: '2026-09-01', amountCents: -1000 }),
    ];
    expect(recurringVerdict({ charges: yearlyShape, today: '2026-09-01' })).toBeNull();
  });
});

describe('MUST-9.20 to MUST-9.23: findDuplicates', () => {
  it('pairs two identical charges one day apart', () => {
    const rows = [
      row({ id: 10, date: '2026-08-12', amountCents: -8950, merchant: 'BELL CANADA' }),
      row({ id: 11, date: '2026-08-13', amountCents: -8950, merchant: 'BELL CANADA' }),
    ];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([
      {
        lowerId: 10,
        higherId: 11,
        merchant: 'BELL CANADA',
        amountCents: -8950,
        earlierDateIso: '2026-08-12',
        laterDateIso: '2026-08-13',
      },
    ]);
  });

  it('MUST-9.23: three identical charges produce two pairs, nearest earlier only', () => {
    const rows = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950 }),
      row({ id: 2, date: '2026-08-13', amountCents: -8950 }),
      row({ id: 3, date: '2026-08-14', amountCents: -8950 }),
    ];
    expect(findDuplicates({ rows, today: TODAY }).map((pair) => [pair.lowerId, pair.higherId])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it('MUST-9.22: the same pair keys the same way whatever order the scan reaches it in', () => {
    const forward = findDuplicates({
      rows: [row({ id: 5, date: '2026-08-12', amountCents: -8950 }), row({ id: 4, date: '2026-08-13', amountCents: -8950 })],
      today: TODAY,
    });
    expect(forward).toHaveLength(1);
    expect([forward[0].lowerId, forward[0].higherId]).toEqual([4, 5]);
  });

  it('needs the same merchant, the same amount, and both inside the windows', () => {
    const differentMerchant = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950, merchant: 'BELL' }),
      row({ id: 2, date: '2026-08-13', amountCents: -8950, merchant: 'ROGERS' }),
    ];
    expect(findDuplicates({ rows: differentMerchant, today: TODAY })).toEqual([]);

    const differentAmount = [
      row({ id: 1, date: '2026-08-12', amountCents: -8950 }),
      row({ id: 2, date: '2026-08-13', amountCents: -8951 }),
    ];
    expect(findDuplicates({ rows: differentAmount, today: TODAY })).toEqual([]);

    const tooFarApart = [row({ id: 1, date: '2026-08-10', amountCents: -8950 }), row({ id: 2, date: '2026-08-14', amountCents: -8950 })];
    expect(findDuplicates({ rows: tooFarApart, today: TODAY })).toEqual([]);

    const laterTooOld = [row({ id: 1, date: '2026-07-01', amountCents: -8950 }), row({ id: 2, date: '2026-07-02', amountCents: -8950 })];
    expect(findDuplicates({ rows: laterTooOld, today: TODAY })).toEqual([]);
  });

  it('ignores pairs under $10, because two identical transit fares are two transit fares', () => {
    const rows = [row({ id: 1, date: '2026-08-12', amountCents: -400 }), row({ id: 2, date: '2026-08-13', amountCents: -400 })];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([]);
  });

  it('ignores refunds and deposits', () => {
    const rows = [row({ id: 1, date: '2026-08-12', amountCents: 8950 }), row({ id: 2, date: '2026-08-13', amountCents: 8950 })];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([]);
  });

  it('boundary: a pair exactly DUPLICATE_WINDOW_DAYS apart fires', () => {
    const laterDate = addDaysIso(TODAY, -5);
    const earlierDate = addDaysIso(laterDate, -DUPLICATE_WINDOW_DAYS);
    const rows = [row({ id: 1, date: earlierDate, amountCents: -8950 }), row({ id: 2, date: laterDate, amountCents: -8950 })];
    expect(findDuplicates({ rows, today: TODAY })).toHaveLength(1);
  });

  it('boundary: fires when the later charge is exactly DUPLICATE_LOOKBACK_DAYS old, not one day older', () => {
    const atLimit = addDaysIso(TODAY, -DUPLICATE_LOOKBACK_DAYS);
    const limitRows = [row({ id: 1, date: addDaysIso(atLimit, -1), amountCents: -8950 }), row({ id: 2, date: atLimit, amountCents: -8950 })];
    expect(findDuplicates({ rows: limitRows, today: TODAY })).toHaveLength(1);

    const oneDayOlder = addDaysIso(TODAY, -(DUPLICATE_LOOKBACK_DAYS + 1));
    const olderRows = [
      row({ id: 1, date: addDaysIso(oneDayOlder, -1), amountCents: -8950 }),
      row({ id: 2, date: oneDayOlder, amountCents: -8950 }),
    ];
    expect(findDuplicates({ rows: olderRows, today: TODAY })).toEqual([]);
  });

  it('L-8: rejects a future-dated pair, aligned with the unusual detector', () => {
    // A post-dated entry or a bad import, one day apart, both after "today". Without the L-8
    // fix, daysBetweenIso(later.date, today) is NEGATIVE here and therefore passes the
    // "<= DUPLICATE_LOOKBACK_DAYS" check unintentionally, so the pair fired.
    const rows = [
      row({ id: 1, date: addDaysIso(TODAY, 1), amountCents: -8950 }),
      row({ id: 2, date: addDaysIso(TODAY, 2), amountCents: -8950 }),
    ];
    expect(findDuplicates({ rows, today: TODAY })).toEqual([]);
  });
});
