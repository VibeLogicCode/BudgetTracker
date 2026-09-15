/**
 * The one meter every page uses for "how much of X has happened" -- a budget's spend, a review
 * queue's confirmed count, anything with a limit. Generalised BudgetProgressBar's and GoalCard's
 * own hand-rolled bars (src/components/GoalCard.tsx; BudgetProgressBar.tsx itself was retired as
 * dead code once every caller had migrated here -- item 4 of the 2026-08-30 plan) into a single
 * component so a third page cannot invent a fourth meter (ruling D1).
 *
 * Ruling D4 is the one rule this file exists to get right: the FILL clamps at 100% so a bar can
 * never overflow its track in any browser, but `aria-valuenow` and the caller's own label/pill
 * text keep reporting the true percentage. A category at 138% renders a full, negative-toned bar
 * -- the bar says "maxed out", the number next to it says by how much.
 *
 * 2026-09-15, THE LIMIT MARKER. D4's clamp is still right, but on its own it threw away the one
 * thing a reader needs at the moment a budget breaks: how far over. On the owner's own budgets
 * card, Housing at 117% and Health at 370% drew the IDENTICAL full red bar, and those two numbers
 * call for very different reactions. So past 100% the track stops meaning "the limit" and starts
 * meaning "the whole spend", and a marker is drawn where the limit now falls -- 100/pct along it.
 * Slightly over puts the marker near the right-hand end with a sliver after it; far over drags it
 * left and the gap after it is the overshoot. One glance separates the two.
 *
 * WHY A MARKER RATHER THAN A SECOND BAR OR A LOG SCALE. A second, overflowing bar reintroduces
 * exactly the overflow D4 banned. A compressed scale would make the bar's length stop being
 * proportional to anything, which is worse than clamping because it looks quantitative and is not.
 * The marker leaves the fill honest (full = maxed) and adds one position that IS proportional.
 *
 * Ruling D5 is the shared three-state scale: under 80% is calm, 80-100% is warning, over 100% is
 * negative. 80 is already this app's `budgetThresholdPct` default (src/db/schema.ts,
 * src/lib/notify/config.ts), so a bar
 * that turns amber is describing the same threshold the notification evaluator alerts on -- the
 * UI and the alerts were never allowed to disagree. `tone` is still a prop, not just an internal
 * default: a caller with its own reason to call something "over" (a goal missing its pace, say)
 * can say so without this component recomputing a percentage-derived guess that would fight it.
 */
export type BarTone = 'calm' | 'warning' | 'over';

const FILL_CLASS: Record<BarTone, string> = {
  calm: 'bg-positive-solid',
  warning: 'bg-warning-solid',
  over: 'bg-negative-solid',
};

function deriveTone(pct: number): BarTone {
  if (pct > 100) return 'over';
  if (pct >= 80) return 'warning';
  return 'calm';
}

export function ProgressBar({
  pct,
  tone,
  label,
  className = '',
}: {
  /** True percentage -- may run past 100. The fill below is clamped; this value is not. */
  pct: number;
  tone?: BarTone;
  /** Accessible name, e.g. "Groceries budget used". There is no visible caption on the bar
   *  itself -- the pill or hero number beside it is what a sighted reader sees. */
  label: string;
  className?: string;
}) {
  const resolvedTone = tone ?? deriveTone(pct);
  const clampedWidth = Math.min(100, Math.max(0, pct));
  /** Only meaningful past the limit; at or under it the marker would sit on the track's own end. */
  const limitAt = pct > 100 ? (100 / pct) * 100 : null;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`relative h-2 w-full overflow-hidden rounded-full bg-surface-3 ${className}`}
    >
      <div
        data-bar-fill
        style={{ width: `${clampedWidth}%` }}
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${FILL_CLASS[resolvedTone]}`}
      />
      {limitAt === null ? null : (
        /* Decoration over a bar that already carries an accessible name and its true value, so it
           is hidden from assistive tech rather than announced as a second, nameless thing. The
           notch is the card's own surface colour: it reads as a cut through the fill at any tone,
           and needs no contrast pairing of its own. */
        <span
          data-bar-limit
          aria-hidden="true"
          style={{ left: `${limitAt}%` }}
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-surface"
        />
      )}
    </div>
  );
}
