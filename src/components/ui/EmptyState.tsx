import type { IconProps } from '@/components/icons';

/**
 * What a list looks like before it has anything in it.
 *
 * An empty screen is an invitation to act, so the shape is fixed: a quiet
 * glyph, one sentence naming what will appear here, and the single button that
 * makes it happen. First-run is most of this app's first impression.
 *
 * Item 2 (2026-08-30 one-design-language plan) adds `size="compact"`, the shape a CARD reaches
 * for when one SECTION of it -- not the whole page -- has nothing in it yet: a receipts list
 * with no receipts, a ledger with no linked transactions, a changelog that failed to load. Seven
 * call sites (ComingUpCard.tsx, dashboard/page.tsx x2, warranty-detail-client.tsx x2,
 * about-panel.tsx, connections-client.tsx) had all hand-rolled the identical `rounded-md border
 * border-dashed border-line-strong px-4 py-{6,8} text-center text-sm text-muted` box instead of
 * reaching for this component, because none of them had an icon to give it and the bold title +
 * icon-circle shape reads as a page's ONE empty state, not a card's incidental one. `compact`
 * drops the icon circle and the bold title -- a single muted sentence, exactly what all seven
 * boxes already rendered -- while keeping the dashed border those boxes drew by hand. The two
 * `py-8` boxes among the seven (dashboard's Budgets and Top merchants cards) fold into this
 * shared `py-6`: a difference nobody was relying on, not a third padding value worth keeping
 * alive. `icon` becomes optional independently of `size` -- none of these seven pass one, so
 * `compact` never shows the circle in practice, but the two remain separate knobs rather than
 * one flag standing in for the other: a future `compact` caller that does have an icon still
 * gets it, instead of this component silently dropping a prop it was handed.
 *
 * `noAction`: Guard 1 (tests/ops/onboarding-coverage.test.ts, spec 2026-08-23 Component 6) grep-
 * scans every `<EmptyState` call site in src/ and fails the build if its opening tag carries
 * neither `action=` nor `noAction=` -- "because every kind has a correct action, the guard test
 * needs no allowlist" is that spec's own ruling, and converting seven hand-rolled boxes to this
 * component (item 2, 2026-08-30 plan) does not get to quietly relax that. Six of the seven had a
 * real one once looked for (Import a statement, Go to Transactions, Add a receipt, ...). Exactly
 * one -- about-panel.tsx's "CHANGELOG.md was not found" -- does not: that file ships inside the
 * built image itself, so if it is missing there is no button anywhere in this app that puts it
 * back, and inventing one to satisfy a grep would be the "wrong action is worse than none" case
 * the same spec warns about. `noAction` is the explicit, typed way to say so: a short string
 * (never rendered -- it exists to be read by a person and matched by the guard, not shown to a
 * viewer) stating why no action exists. It is deliberately not `action?: undefined`, because
 * omitting `action` by accident and omitting it on purpose must not look identical at the call
 * site or to the guard.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  size = 'default',
  className = '',
}: {
  icon?: (props: IconProps) => React.ReactElement;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  /** 'compact' is the card-scoped shape described above: no icon, no bold title, a dashed
   *  border and tighter padding instead of the page-level default's open whitespace. */
  size?: 'default' | 'compact';
  /** Passed INSTEAD of `action`, only when no action genuinely exists -- see this file's own
   *  docblock. Never rendered; Guard 1 accepts it in place of `action=` and nothing else does. */
  noAction?: string;
  className?: string;
}) {
  const compact = size === 'compact';
  return (
    <div
      className={`flex flex-col items-center gap-3 text-center ${
        compact ? 'rounded-md border border-dashed border-line-strong px-4 py-6' : 'px-6 py-12'
      } ${className}`}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-subtle"
        >
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className={compact ? 'text-sm text-muted' : 'text-sm font-semibold text-ink'}>{title}</p>
        {children ? <p className="mx-auto max-w-sm text-sm text-muted">{children}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
