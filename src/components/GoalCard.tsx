import { Fragment } from 'react';
import { MetricCard } from '@/components/ui/MetricCard';
import { Pill } from '@/components/ui/Pill';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { categoryIcon } from '@/components/ui/icons';
import { formatCents } from '@/lib/money';
import type { GoalWithProgress } from '@/lib/goals';

/**
 * A thin wrapper over MetricCard (2026-08-30 plan, ruling D1): Goals and Budgets now render the
 * exact same card shell, so the two cannot drift the way two hand-rolled cards eventually would.
 * `footer` still exists so the goals page can hang its per-goal controls (contribute, archive,
 * the contribution log) inside the same card instead of stacking a second bordered box
 * underneath every goal -- it is passed straight through as MetricCard's own `action` slot, which
 * renders byte-identical footer-strip markup to what this file used to hand-roll itself.
 *
 * One gap this reuse could not close, reported rather than forked into a local variant of the
 * shared bar (ruling D1): ProgressBar's three-state scale (calm/warning/over, ruling D5) is
 * shaped for "percentage of a LIMIT" -- calm well under it, warning approaching it, over past it.
 * A goal has no limit to overspend; getting closer to 100% saved is good news, never a warning.
 * The hand-rolled bar this replaced used a fourth, distinct "in progress" hue (accent) alongside
 * its own "met" colour, which BarTone has no name for. This maps the one genuinely bad state a
 * goal has -- overdue, from computePace -- onto 'over', and everything else (on track OR fully
 * met) onto 'calm', which loses that fourth hue rather than growing ProgressBar a fourth tone
 * only this one card would ever use.
 */
export function GoalCard({ goal, footer }: { goal: GoalWithProgress; footer?: React.ReactNode }) {
  const { pace } = goal;
  const pct = goal.targetCents === 0 ? 100 : Math.round((goal.savedCents / goal.targetCents) * 100);
  const clamped = Math.min(100, Math.max(0, pct));
  // A freeform goal name ("Trip to Japan", "New roof") is matched the same way a budget
  // category name already is -- categoryIcon's fallback (a plain Tag) is a sensible glyph for a
  // goal nothing else matches, so this needed no goal-specific icon table of its own.
  const Icon = categoryIcon(goal.name);

  // Built as a list rather than one JSX blob so a <br/> can separate whichever of these lines
  // actually apply -- MetricCard's `status` slot is a single <p>, so real paragraph elements
  // (this file's own layout before this rewrite) are not an option here; <br/> is still valid
  // phrasing content inside a <p>, which a block-level child would not be.
  const lines: React.ReactNode[] = [];
  if (goal.targetDate) lines.push(<span key="date" className="text-subtle">Target date {goal.targetDate}</span>);
  if (pace.overdue) {
    lines.push(
      <span key="overdue" className="font-semibold money-neg">
        Overdue — {formatCents(pace.requiredMonthlyCents ?? pace.remainingCents)} still to go
      </span>,
    );
  } else if (pace.requiredMonthlyCents !== null) {
    lines.push(<span key="required">Required monthly: {formatCents(pace.requiredMonthlyCents)}</span>);
  }
  if (pace.met) {
    lines.push(<span key="met" className="font-semibold money-pos">Goal reached</span>);
  } else if (pace.noPace) {
    lines.push(<span key="nopace">No pace yet — log a contribution to see a projection.</span>);
  } else {
    lines.push(
      <span key="pace">
        Averaging {formatCents(pace.avgMonthlyCents)}/month · projected finish {pace.projectedFinishMonth}
      </span>,
    );
  }

  return (
    <MetricCard
      icon={<Icon className="h-5 w-5" />}
      title={goal.name}
      pill={<Pill tone="neutral">{goal.ownerName ?? 'Shared'}</Pill>}
      value={formatCents(goal.savedCents)}
      compare={`of ${formatCents(goal.targetCents)} (${clamped}%)`}
      bar={<ProgressBar pct={clamped} tone={pace.overdue ? 'over' : 'calm'} label={`${goal.name} progress`} />}
      status={lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
      action={footer}
    />
  );
}
