/**
 * A small-caps title over a group of cards or rows, with an optional right-aligned action
 * ("Add goal", "Manage", "Upload") -- what `CardHeader` is for a single card, this is for a
 * whole section of them (a dashboard block, a page's own sub-list) that never had a shared
 * header at all before this release.
 *
 * 2026-09-15, `$impeccable critique` P2: this used `.eyebrow` -- 11px uppercase --subtle -- while
 * CardHeader titles a single card at 16px semibold --ink. So "Goals", which introduces an entire
 * GRID of cards, rendered visually subordinate to "Top merchants", which titles one card inside a
 * section. The ladder ran backwards.
 *
 * It now sits one step ABOVE CardHeader (text-lg over text-base) rather than far below it, which
 * is the smallest change that puts the ladder the right way up -- a step, not a shout. `.eyebrow`
 * keeps the job it was invented for: naming what a StatTile's number counts.
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
      <h2 className="flex min-w-0 items-center gap-1.5 text-lg font-semibold tracking-tight text-ink">
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
