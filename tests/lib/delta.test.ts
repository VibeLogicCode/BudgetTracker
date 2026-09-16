import { describe, it, expect } from 'vitest';
import { monthDelta } from '@/lib/delta';

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
