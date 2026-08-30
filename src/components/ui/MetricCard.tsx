/**
 * The app's one card (ruling D1): a number and, usually, a bar. Generalised OUT OF GoalCard
 * (src/components/GoalCard.tsx), which was already four-fifths of this shape -- an icon-less
 * header, a hero number with "of X" beside it, a semantic bar, and a footer slot for per-item
 * controls. Lane 1 turns GoalCard itself into a thin wrapper over this component; every other
 * card-shaped page (Budgets, dashboard tiles, Settings -> Accounts) converts to this directly.
 *
 * Every prop here is a slot, not a computation. This component derives no percentage, no total
 * and no "over budget" verdict of its own -- it renders whatever ReactNode each caller hands it.
 * That is deliberate, not an oversight: the design reference this was generalised from
 * (`UI Component/budget-tracker-card/components/budget-card.tsx`, gitignored, read-only) derives
 * a parent category's spend from the SUM of its children, silently overriding the parent's own
 * limit. This app settled the opposite rule last release -- a parent's limit is its own cap, and
 * spending past it WARNS rather than being masked by a recomputed total -- so the arithmetic has
 * to live in the page that knows which rule applies, never in this shared shell.
 *
 * `pill` is typically a <Pill>, `bar` a <ProgressBar>, but neither is required to be: the type is
 * ReactNode so a card with nothing to warn about can omit the pill entirely rather than rendering
 * an empty one.
 */
export function MetricCard({
  icon,
  title,
  subtitle,
  pill,
  value,
  compare,
  bar,
  status,
  action,
  children,
  className = '',
}: {
  /** Rendered inside the 40px rounded tile. Usually a lucide icon from ./icons -- categoryIcon()
   *  for a budget category, a fixed glyph for a goal or an account. Decorative: the title text
   *  beside it already names the thing, so this file does not add its own aria-hidden wrapper
   *  requirement onto the caller -- it wraps the slot in one regardless of what is passed in. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** "6 categories · 2 over" -- say something real about the card's contents, not just a count
   *  for its own sake. Optional: a leaf card with nothing to summarise omits it. */
  subtitle?: React.ReactNode;
  pill?: React.ReactNode;
  /** The hero number -- spent-so-far, saved-so-far, a balance. */
  value: React.ReactNode;
  /** "of $500.00", small and muted, set on the same baseline as `value` rather than below it. */
  compare?: React.ReactNode;
  bar?: React.ReactNode;
  /** "$87.65 remaining" / "$173.10 over budget" -- the sentence a bar and a pill together imply. */
  status?: React.ReactNode;
  /** The footer strip behind a hairline -- "View breakdown", a contribute button. Omitted
   *  entirely (no strip, no hairline) when there is nothing to put there, rather than reserving
   *  empty space for it. */
  action?: React.ReactNode;
  /** Expanded content -- a child breakdown, a transaction list -- below the footer strip. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <article className={`card flex flex-col gap-3 p-4 sm:p-5 ${className}`}>
      <header className="flex items-start gap-3">
        {icon ? (
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg"
          >
            {icon}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
          {subtitle ? <p className="truncate text-xs text-subtle">{subtitle}</p> : null}
        </div>
        {pill ? <div className="mt-0.5 shrink-0">{pill}</div> : null}
      </header>

      <p className="money-lg text-ink">
        {value}
        {compare ? <span className="ml-1.5 text-sm font-normal text-muted">{compare}</span> : null}
      </p>

      {bar}

      {status ? <p className="text-xs text-muted">{status}</p> : null}

      {action ? (
        <div data-testid="metric-card-footer" className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
          {action}
        </div>
      ) : null}

      {children}
    </article>
  );
}
