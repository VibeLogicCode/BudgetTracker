import { MoneyInIcon, MoneyOutIcon } from '@/components/ui/icons';

/**
 * One line in any list -- a transaction, a review-queue row, a subscription, a linked receipt.
 * Generalises the row shape `ComingUpCard` and `BudgetProgressBar`'s callers each hand-rolled
 * separately (src/components/ComingUpCard.tsx's `<li>`, the design reference's TransactionList
 * row) into the one row every list renders from now on (ruling D1). Transactions itself stays a
 * `<table>` on desktop (ruling D7 -- a ledger is scanned down a column) and does not render this
 * component there; ListRow is for the lists that were never a table to begin with, and for the
 * table's own phone-stacked fallback where a "row" already reads as a small card.
 *
 * The circled arrow carries direction, not the amount's colour -- `amount` is a plain ReactNode
 * (typically a `<Money>`, src/components/ui/Money.tsx, which already colours by sign), so this
 * component never has to guess whether "money went out" should always mean "paint it red": a
 * category's own spending is not bad news the way a budget overrun is.
 *
 * `direction`'s arrow is `aria-hidden` -- the sign is already carried by the amount text next to
 * it (a screen reader reads "minus twelve dollars", not a circled glyph), so the arrow is
 * decoration layered on top of information that already exists, exactly like every other
 * decorative icon in this app.
 */
export function ListRow({
  direction,
  icon,
  title,
  meta,
  amount,
  trailing,
  leading,
  className = '',
}: {
  /** Renders the circled in/out arrow. Omit for a non-money row (a warranty, a bill). */
  direction?: 'in' | 'out';
  /** Used instead of the arrow when `direction` is absent -- a category glyph, a file icon. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** Date, category, account -- small and muted, printed under the title. */
  meta?: React.ReactNode;
  /** Right-aligned, tabular. Undefined renders no amount column at all (a non-money row). */
  amount?: React.ReactNode;
  /** A control: a category picker, a row menu, a confirm button. Sits after the amount, hard
   *  right, matching every existing row's own kebab-at-the-end convention. */
  trailing?: React.ReactNode;
  /** A checkbox, ahead of everything else. */
  leading?: React.ReactNode;
  className?: string;
}) {
  const hasDirection = direction !== undefined;
  const Arrow = direction === 'in' ? MoneyInIcon : MoneyOutIcon;

  return (
    <li
      className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:px-5 ${className}`}
    >
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}

      {hasDirection ? (
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            direction === 'in' ? 'bg-positive-soft text-positive-soft-fg' : 'bg-surface-2 text-muted'
          }`}
        >
          <Arrow className="h-4 w-4" />
        </span>
      ) : icon ? (
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"
        >
          {icon}
        </span>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm font-semibold text-ink">{title}</p>
        {meta ? <p className="truncate text-xs text-subtle">{meta}</p> : null}
      </div>

      {amount !== undefined ? (
        <p className="money shrink-0 text-sm font-semibold text-ink">{amount}</p>
      ) : null}

      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </li>
  );
}
