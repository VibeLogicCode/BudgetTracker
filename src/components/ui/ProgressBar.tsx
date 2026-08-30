/**
 * The one meter every page uses for "how much of X has happened" -- a budget's spend, a review
 * queue's confirmed count, anything with a limit. Generalises BudgetProgressBar and GoalCard's
 * own hand-rolled bar (src/components/BudgetProgressBar.tsx, src/components/GoalCard.tsx) into a
 * single component so a third page cannot invent a fourth meter (ruling D1).
 *
 * Ruling D4 is the one rule this file exists to get right: the FILL clamps at 100% so a bar can
 * never overflow its track in any browser, but `aria-valuenow` and the caller's own label/pill
 * text keep reporting the true percentage. A category at 138% renders a full, negative-toned bar
 * -- the bar says "maxed out", the number next to it says by how much.
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

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-2 w-full overflow-hidden rounded-full bg-surface-3 ${className}`}
    >
      <div
        style={{ width: `${clampedWidth}%` }}
        className={`h-full rounded-full transition-[width] duration-300 ease-out ${FILL_CLASS[resolvedTone]}`}
      />
    </div>
  );
}
