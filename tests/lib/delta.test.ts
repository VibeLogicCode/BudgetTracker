import { describe, it, expect } from 'vitest';
import { monthDelta, sameDaysLastMonth } from '@/lib/delta';

/**
 * 2026-09-15, from a real dashboard: a tile read "-1109.4% vs last month" and another
 * "-99.0% vs last month" beside a figure of a couple of hundred dollars.
 *
 * Both were arithmetically correct and humanly useless. A percentage is a ratio, and a ratio to a
 * near-zero base explodes — it stops describing the household's month and starts describing how
 * close last month happened to land to zero. The existing guard only caught prev === 0 exactly,
 * which is the one case that cannot happen quietly.
 *
 * Past a readable ceiling the delta switches to the ABSOLUTE difference, which never degrades:
 * "$4,693.85 lower than last month" means the same thing at every scale.
 */
describe('monthDelta: a percentage that stops being readable becomes a figure', () => {
  it('reads as a percentage at ordinary scale', () => {
    expect(monthDelta(11_000, 10_000, true)).toMatchObject({ delta: '+10.0% vs last month', deltaTone: 'positive' });
  });

  it('says nothing at all when last month was exactly zero', () => {
    // Not "infinite percent more" and not "+100%": there is nothing to compare against, and the
    // ruling this inherits calls no delta strictly better than a wrong one.
    expect(monthDelta(5_000, 0, true)).toEqual({});
  });

  it('switches to an absolute figure when the ratio explodes', () => {
    // A real tile: a small prior month turns an ordinary swing into -1109%.
    const result = monthDelta(-469_385, 46_500, true);
    expect(result.delta).not.toMatch(/%/);
    expect(result.delta).toMatch(/lower than last month/);
    expect(result.delta).toContain('$5,158.85');
  });

  it('switches on the way up too', () => {
    const result = monthDelta(500_000, 1_000, true);
    expect(result.delta).toMatch(/higher than last month/);
    expect(result.delta).not.toMatch(/%/);
  });

  /** The tone is about whether the news is good, never about the arithmetic sign alone. */
  it('keeps the tone the figure deserves, whichever form it takes', () => {
    // Spending up is bad news even though the number rose.
    expect(monthDelta(20_000, 10_000, false).deltaTone).toBe('negative');
    // And an exploded ratio must not lose that.
    expect(monthDelta(900_000, 1_000, false).deltaTone).toBe('negative');
    expect(monthDelta(900_000, 1_000, true).deltaTone).toBe('positive');
  });

  it('is flat rather than positive when nothing moved', () => {
    expect(monthDelta(10_000, 10_000, true)).toMatchObject({ deltaTone: 'default' });
  });

  /** The boundary itself, so the threshold is a decision and not an accident. */
  it('holds the percentage right up to the ceiling', () => {
    expect(monthDelta(400, 100, true).delta).toBe('+300.0% vs last month');
    expect(monthDelta(401, 100, true).delta).toMatch(/higher than last month/);
  });
});

/**
 * v1.60.0 item 4. A month in progress is compared with the same days of the month before, and the
 * sentence names that window instead of claiming "last month".
 */
describe('monthDelta: the comparison names its window', () => {
  it('reads "vs Feb 1-18" in the percentage form', () => {
    expect(monthDelta(11_000, 10_000, true, 'Feb 1-18')).toEqual({ delta: '+10.0% vs Feb 1-18', deltaTone: 'positive' });
  });

  it('reads "higher than Feb 1-18" in the large-change form', () => {
    expect(monthDelta(500_000, 1_000, false, 'Feb 1-18')).toEqual({ delta: '$4,990.00 higher than Feb 1-18', deltaTone: 'negative' });
  });

  it('keeps "last month" when no window is named', () => {
    expect(monthDelta(9_000, 10_000, true).delta).toBe('-10.0% vs last month');
  });
});

describe('sameDaysLastMonth', () => {
  it('runs day 1 to the same day of the month before', () => {
    expect(sameDaysLastMonth('2026-03-18')).toEqual({ from: '2026-02-01', to: '2026-02-18', label: 'Feb 1-18' });
  });

  it('clamps to the shorter month, so the 31st compares with all of February', () => {
    expect(sameDaysLastMonth('2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28', label: 'Feb 1-28' });
    expect(sameDaysLastMonth('2028-03-30')).toEqual({ from: '2028-02-01', to: '2028-02-29', label: 'Feb 1-29' });
    expect(sameDaysLastMonth('2026-05-31')).toEqual({ from: '2026-04-01', to: '2026-04-30', label: 'Apr 1-30' });
  });

  it('crosses the year without naming it', () => {
    expect(sameDaysLastMonth('2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-15', label: 'Dec 1-15' });
  });

  it('names a single day plainly on the 1st', () => {
    expect(sameDaysLastMonth('2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-01', label: 'Feb 1' });
  });
});
