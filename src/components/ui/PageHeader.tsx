/**
 * The one <h1> on a page, plus whatever the page's primary action is.
 * `eyebrow` is for real context (the month a page is scoped to, the account a
 * detail page belongs to) — not decoration.
 *
 * Item 5 (2026-08-30 plan, corrected): a first pass at this slot made it `flex-col`, reasoning
 * from the dashboard's own header, which passes THREE stacked rows (a quick-add button, a month
 * nav, and a person-scope pills nav) that need a shared right edge. That reasoning was sound for
 * the dashboard and wrong for everyone else -- every other page passes a small handful of plain
 * buttons/links through `actions`, and `flex-col` stacked those vertically too, leaving dead
 * space beside each one for no reason (the owner's own complaint, reported on /goals: "Hide
 * archived" and "Add goal" sat on separate lines with nothing between them).
 *
 * The slot is ONE ROW of actions that wraps if it must, full width and left-aligned below `sm`,
 * right-flush with the page gutter (the same edge the title's own column ends on) at `sm` and
 * up. A page that genuinely needs several stacked rows -- the dashboard's own case -- composes
 * its own `flex-col` wrapper around them and passes that ONE element in; the "stacked rows share
 * one edge, flush with the right gutter" reasoning above is still correct, it now belongs to
 * that caller instead of to every page that never asked for it.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="flex min-w-0 flex-col gap-1.5">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}
