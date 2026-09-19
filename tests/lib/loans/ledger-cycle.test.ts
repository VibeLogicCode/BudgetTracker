import { describe, it, expect } from 'vitest';
import { postingDayFor, nextPostingDate, periodBoundaries, dailyBalances } from '@/lib/loans/ledger';

/**
 * The posting cycle (ledger spec C1–C3) and the daily balance walk (A1).
 *
 * A period runs posting day to posting day, not calendar month to calendar month, because that is
 * what a loan agreement says and what a statement shows. Everything downstream -- the charge, the
 * ledger rows, what is due to be posted -- is a function of these two.
 */
describe('postingDayFor (C1)', () => {
  it('defaults to the borrowed date, and an explicit day wins', () => {
    expect(postingDayFor('2026-07-17', null)).toBe(17);
    expect(postingDayFor('2026-07-17', 1)).toBe(1);
  });
});

describe('nextPostingDate (C1)', () => {
  it('finds the same day in the following month', () => {
    expect(nextPostingDate('2026-07-01', 1)).toBe('2026-08-01');
    expect(nextPostingDate('2026-07-17', 17)).toBe('2026-08-17');
  });

  /** A loan borrowed on the 31st has no 31st in February. It posts on the last day there. */
  it('clamps a day past the month end, and recovers the full day afterwards', () => {
    expect(nextPostingDate('2026-01-31', 31)).toBe('2026-02-28');
    expect(nextPostingDate('2026-02-28', 31)).toBe('2026-03-31');
    expect(nextPostingDate('2026-04-30', 31)).toBe('2026-05-31');
  });

  it('knows about leap years', () => {
    expect(nextPostingDate('2028-01-31', 31)).toBe('2028-02-29');
  });

  /** Strictly after: a date that IS a posting date opens the next period, it does not close one. */
  it('never returns the date it was given', () => {
    expect(nextPostingDate('2026-08-01', 1)).toBe('2026-09-01');
  });

  /** A clamped month must not swallow the following one: Feb 28 and Mar 31 are separate periods. */
  it('advances a month at a time even when two months clamp to the same day', () => {
    expect(nextPostingDate('2026-01-30', 30)).toBe('2026-02-28');
    expect(nextPostingDate('2026-02-28', 30)).toBe('2026-03-30');
  });
});

describe('periodBoundaries (C2–C3)', () => {
  it('closes every period whose end has arrived and leaves exactly one open', () => {
    expect(periodBoundaries('2026-07-01', 1, '2026-09-18')).toEqual([
      { start: '2026-07-01', end: '2026-08-01', closed: true },
      { start: '2026-08-01', end: '2026-09-01', closed: true },
      { start: '2026-09-01', end: '2026-10-01', closed: false },
    ]);
  });

  /** A period ending TODAY has ended: its last day is over. */
  it('closes a period whose end is today', () => {
    const periods = periodBoundaries('2026-07-01', 1, '2026-08-01');
    expect(periods[0]).toEqual({ start: '2026-07-01', end: '2026-08-01', closed: true });
    expect(periods).toHaveLength(2);
  });

  it('a start point on the posting day itself opens a full period there', () => {
    expect(periodBoundaries('2026-09-01', 1, '2026-09-01')).toEqual([
      { start: '2026-09-01', end: '2026-10-01', closed: false },
    ]);
  });

  /** C2: a statement dated mid-cycle restarts the cycle, so the first period is short. */
  it('a mid-cycle start point yields one short first period', () => {
    expect(periodBoundaries('2026-08-20', 1, '2026-09-18')).toEqual([
      { start: '2026-08-20', end: '2026-09-01', closed: true },
      { start: '2026-09-01', end: '2026-10-01', closed: false },
    ]);
  });

  it('a start point in the future leaves one open period and closes nothing', () => {
    expect(periodBoundaries('2026-12-01', 1, '2026-09-18')).toEqual([
      { start: '2026-12-01', end: '2027-01-01', closed: false },
    ]);
  });
});

describe('dailyBalances (A1)', () => {
  it('gives one balance per day, and a payment counts from the day it lands', () => {
    const days = dailyBalances('2026-07-01', '2026-08-01', 1_000_000, [{ date: '2026-07-15', amountCents: -500_000 }]);
    expect(days).toHaveLength(31);
    expect(days[0]).toBe(1_000_000);
    expect(days[13]).toBe(1_000_000); // 14 July, the day before
    expect(days[14]).toBe(500_000); // 15 July, the day it lands
    expect(days[30]).toBe(500_000);
  });

  it('adds an advance the same way', () => {
    const days = dailyBalances('2026-07-01', '2026-07-04', 100_000, [{ date: '2026-07-03', amountCents: 50_000 }]);
    expect(days).toEqual([100_000, 100_000, 150_000]);
  });

  it('ignores movements outside the window', () => {
    const days = dailyBalances('2026-07-01', '2026-07-03', 100_000, [
      { date: '2026-06-30', amountCents: -50_000 },
      { date: '2026-07-03', amountCents: -50_000 },
    ]);
    expect(days).toEqual([100_000, 100_000]);
  });

  /** An overpayment leaves nothing owing; it never becomes a negative balance that earns interest. */
  it('never goes below zero', () => {
    expect(dailyBalances('2026-07-01', '2026-07-03', 100, [{ date: '2026-07-02', amountCents: -500 }])).toEqual([100, 0]);
  });

  it('sums two movements on the same day', () => {
    expect(dailyBalances('2026-07-01', '2026-07-03', 100_000, [
      { date: '2026-07-02', amountCents: -30_000 },
      { date: '2026-07-02', amountCents: -20_000 },
    ])).toEqual([100_000, 50_000]);
  });
});
