/**
 * A small-caps title over a group of cards or rows, with an optional right-aligned action
 * ("Add goal", "Manage", "Upload") -- what `CardHeader` is for a single card, this is for a
 * whole section of them (a dashboard block, a page's own sub-list) that never had a shared
 * header at all before this release.
 *
 * Reuses `.eyebrow` (globals.css) rather than inventing a second small-caps treatment: the same
 * uppercase/letter-spacing rule that already names what a StatTile's number counts now also
 * names what a section holds.
 */
export function SectionHeader({
  title,
  icon,
  action,
  className = '',
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`}>
      <h2 className="eyebrow flex min-w-0 items-center gap-1.5">
        {icon ? (
          <span aria-hidden="true" className="text-subtle">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{title}</span>
      </h2>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
