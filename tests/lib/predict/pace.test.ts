import { describe, it, expect } from 'vitest';
import { monthEnd } from '@/lib/dates';
import { checkInMonthEnd, everydayCents, type HistoryStretch } from '@/lib/predict/pace';
import { divRound } from '@/lib/predict/stats';

/**
 * v1.62.0, the month check-in. Today is 2026-03-07 in a 31-day month, so 24 days are left. The
 * history is the day-aligned stretch after the 7th in December (24 days), January (24) and
 * February (21).
 */
const DAYS_LEFT = 31 - 7;
const stretch = (dec: number, jan: number, feb: number): HistoryStretch[] => [
  { cents: dec, days: 24 },
  { cents: jan, days: 24 },
  { cents: feb, days: 21 },
];

describe('v1.62.0: spent so far + still due + the usual rest of the month', () => {
  it('rent paid on the 1st, whose history lands only on the 1st, reads as one rent', () => {
    const projected = checkInMonthEnd({ spentCents: 200000, dueCents: 0, history: stretch(0, 0, 0), daysLeft: DAYS_LEFT });
    expect(projected).toBe(200000);
    // The straight-line pace this replaces (v1.61.0 projectMonthEnd): 200000 * 31 / 7.
    expect(divRound(200000 * 31, 7)).toBe(885714);
  });

  it('groceries: the median month after the 7th, each scaled to the 24 days left', () => {
    // Dec 48000 over 24 days -> 48000; Jan 52000 -> 52000; Feb 40000 over 21 days -> 45714.
    // The median is December's 48000, so 15000 + 48000.
    const history = stretch(48000, 52000, 40000);
    expect(everydayCents({ history, daysLeft: DAYS_LEFT })).toBe(48000);
    expect(checkInMonthEnd({ spentCents: 15000, dueCents: 0, history, daysLeft: DAYS_LEFT })).toBe(63000);
  });

  it('a one-off in one month moves the median by nothing, where a pooled mean would add a third of it', () => {
    // A 1,200.00 television in January's stretch.
    const history = stretch(40000, 160000, 35000);
    expect(everydayCents({ history, daysLeft: DAYS_LEFT })).toBe(40000);
    // The pooled mean would have been (40000 + 160000 + 35000) * 24 / 69 = 81739.
    expect(divRound((40000 + 160000 + 35000) * DAYS_LEFT, 69)).toBe(81739);
  });

  it('adds what is still due on top', () => {
    expect(checkInMonthEnd({ spentCents: 15000, dueCents: 18000, history: stretch(48000, 52000, 40000), daysLeft: DAYS_LEFT })).toBe(
      81000,
    );
  });

  it('MUST-8.3: the last day of the month is spent plus due, with or without history', () => {
    expect(checkInMonthEnd({ spentCents: 123456, dueCents: 1699, history: stretch(9000, 9000, 9000), daysLeft: 0 })).toBe(125155);
    expect(checkInMonthEnd({ spentCents: 123456, dueCents: 0, history: [], daysLeft: 0 })).toBe(123456);
  });

  it('MUST-8.5: spend below zero and a net-refunded history month each count as zero', () => {
    expect(checkInMonthEnd({ spentCents: -4000, dueCents: 0, history: stretch(0, 0, 0), daysLeft: DAYS_LEFT })).toBe(0);
    // December refunded more than it spent: it counts as 0, and the median of 0, 24000, 24000 is 24000.
    expect(everydayCents({ history: stretch(-9000, 24000, 21000), daysLeft: DAYS_LEFT })).toBe(24000);
  });

  it('gives null with no history at all, and with no month long enough to reach today', () => {
    expect(checkInMonthEnd({ spentCents: 50000, dueCents: 0, history: [], daysLeft: DAYS_LEFT })).toBeNull();
    // Only February as history, read on March 30: February has no day after the 30th.
    expect(checkInMonthEnd({ spentCents: 50000, dueCents: 0, history: [{ cents: 0, days: 0 }], daysLeft: 1 })).toBeNull();
  });

  it('skips a month too short to reach today and takes the median of the rest', () => {
    // Read on the 29th of a 31-day month: December and January have 2 days each, February 0.
    const history = [
      { cents: 3000, days: 2 },
      { cents: 5000, days: 2 },
      { cents: 0, days: 0 },
    ];
    expect(everydayCents({ history, daysLeft: 2 })).toBe(4000);
  });

  it('MUST-8.2: February 2028 has twenty-nine days', () => {
    const daysInMonth = Number(monthEnd('2028-02').slice(8, 10));
    expect(daysInMonth).toBe(29);
    // On the 20th: 9 days left. January's stretch after the 20th is 11 days.
    const history = [{ cents: 11000, days: 11 }];
    expect(checkInMonthEnd({ spentCents: 20000, dueCents: 0, history, daysLeft: daysInMonth - 20 })).toBe(29000);
    expect(checkInMonthEnd({ spentCents: 29000, dueCents: 0, history, daysLeft: daysInMonth - 29 })).toBe(29000);
  });
});
