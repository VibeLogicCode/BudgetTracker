/**
 * The one <h1> on a page, plus whatever the page's primary action is.
 * `eyebrow` is for real context (the month a page is scoped to, the account a
 * detail page belongs to) — not decoration.
 *
 * Item 5 (2026-08-30 plan, the owner's own complaint): the dashboard passes SEVERAL stacked
 * rows through `actions` (a month nav, a person-scope pills row, and now a quick-add button) --
 * before this fix each row centred itself independently inside this slot, and because the rows
 * are different widths that meant NEITHER edge lined up with anything, which is exactly why the
 * block read as floating rather than placed. One rule now, applied here so every page's header
 * gets it at once rather than each page re-solving it: stacked rows share ONE edge -- flush with
 * the right page gutter (the same edge the title's own column ends on) at `sm` and up, full
 * width and left-aligned with the title below `sm` where there is no gutter left to flush
 * against. `flex-col` applies at every width (not just when there happen to be multiple rows) so
 * a page with a single action button gets the identical rule -- it just has nothing else to
 * align against.
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
        <div className="flex w-full flex-col items-start gap-2 sm:w-auto sm:items-end">{actions}</div>
      ) : null}
    </div>
  );
}
