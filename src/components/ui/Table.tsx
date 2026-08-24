/**
 * Table wrapper. Wide financial tables must scroll inside their own box rather
 * than pushing the page sideways on a phone, and the rounded clip is what keeps
 * a sticky header from spilling over the card's corner.
 *
 * `.data-table` (globals.css) does the actual cell styling, so a page writes
 * plain <thead>/<tbody> markup and gets the house table for free.
 */
export function TableWrap({
  children,
  className = '',
  bare = false,
  fixed = false,
}: {
  children: React.ReactNode;
  /** Extra classes for the scroll container. */
  className?: string;
  /** Inside a Card already? Drop the border and radius so they do not double up. */
  bare?: boolean;
  /**
   * Opt into `table-layout: fixed`, which means the <colgroup> decides the widths and
   * content does not.
   *
   * Default `auto` is right for a table of short read-only values, and wrong for any table
   * whose row carries controls. Auto sizing hands width to whatever column has the longest
   * text -- a merchant name, a category name -- and leaves the selects, number inputs and
   * buttons to fight over the remainder. That is not cosmetic: it pushed the transactions
   * row past the shell's max-width so its last column clipped, and it squeezed the budgets
   * limit cell until "Roll over unspent" wrapped onto two lines beside a column of dead
   * space. A control needs a width the layout cannot renegotiate, so pass a <colgroup>.
   *
   * Requires a <colgroup> whose <col> count matches the header. Without one, fixed layout
   * divides the width equally, which is worse than auto.
   */
  fixed?: boolean;
}) {
  const shell = bare ? '' : 'rounded-lg border border-line bg-surface shadow-card';
  return (
    <div className={`w-full overflow-x-auto ${shell} ${className}`}>
      <table className={fixed ? 'data-table data-table--fixed' : 'data-table'}>{children}</table>
    </div>
  );
}

/** Right-aligned, tabular-figure cell for amounts. */
export function AmountCell({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`money text-right ${className}`}>{children}</td>;
}
