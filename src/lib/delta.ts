import { formatCents } from '@/lib/money';

/** What a tile's delta line says, and how it should be coloured. */
export type DeltaTone = 'default' | 'positive' | 'negative';

/**
 * Past this, a percentage has stopped describing the household's month and started describing how
 * close last month happened to land to zero. 300% is a judgement, not a measurement: a real month
 * can genuinely triple, and almost nothing beyond that is a trend rather than an artefact of the
 * denominator.
 */
const PERCENT_READABLE_MAX = 300;

/**
 * "+2.4% vs last month", from whatever prior-period figure the tile already has a twin query for.
 *
 * `prev === 0` yields NO delta rather than a fabricated percentage: a household with nothing last
 * month is not "infinite percent" anything, it is nothing to compare against, and no delta is
 * strictly better than a wrong one.
 */
function percentChange(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

/**
 * 2026-09-15. A real dashboard read "-1109.4% vs last month" on one tile and "-99.0% vs
 * last month" on another sitting beside a couple of hundred dollars. Both were arithmetically
 * correct and told a reader nothing.
 *
 * The `prev === 0` guard above only ever caught the exact case that cannot happen quietly. A prior
 * month of a few dollars is far more common and produces the same nonsense with none of the
 * warning — the percentage is real, enormous, and about the denominator rather than the household.
 *
 * So past a readable ceiling the line switches to the ABSOLUTE difference, which does not degrade
 * at any scale: "$5,158.85 lower than last month" means exactly what it says whether last month was
 * ten dollars or ten thousand. The percentage is kept where it is the better read, because at
 * ordinary scale a ratio is easier to judge at a glance than a figure.
 *
 * `goodWhenUp` names what KIND of figure this is — money in going up is good news, spending going
 * up is not — rather than the tone being guessed from the arithmetic sign. Getting that backwards
 * is worse than shipping no delta at all, which is why it is a required argument with no default.
 * The tone is computed once and carries across both forms of the sentence.
 */
export function monthDelta(
  curr: number,
  prev: number,
  goodWhenUp: boolean,
): { delta?: string; deltaTone?: DeltaTone } {
  const pct = percentChange(curr, prev);
  if (pct === null) return {};

  const tone: DeltaTone = pct === 0 ? 'default' : (pct > 0) === goodWhenUp ? 'positive' : 'negative';

  if (Math.abs(pct) > PERCENT_READABLE_MAX) {
    const difference = curr - prev;
    // `formatCents` on the magnitude plus a word, rather than a signed figure: "-$5,158.85 vs last
    // month" reads as a negative amount OF something, which is not what a difference is.
    const direction = difference >= 0 ? 'higher' : 'lower';
    return { delta: `${formatCents(Math.abs(difference))} ${direction} than last month`, deltaTone: tone };
  }

  return { delta: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs last month`, deltaTone: tone };
}
