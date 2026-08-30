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
  minWidth,
  responsive = false,
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
  /**
   * REQUIRED whenever `fixed` is set, and the reason is a bug this shipped without it.
   *
   * `.data-table` is `width: 100%`, so a fixed-layout table can never grow past its
   * container -- which means `overflow-x-auto` above NEVER engages, because there is nothing
   * to overflow. On a narrow screen the browser then honours the <colgroup> by shrinking
   * every column instead, and any column left elastic collapses to nothing: on a phone the
   * transactions description came out one character wide, spelling merchant names down the
   * page a letter per line.
   *
   * A min-width equal to the colgroup's own total restores the intent: the table keeps its
   * real size, and the container scrolls sideways when the viewport cannot hold it. Pass the
   * sum of the <col> widths.
   */
  minWidth?: string;
  /**
   * Below `sm`, restyle this table into a list of cards -- same DOM, no second render path.
   * Adds `data-table--stack` to the <table>; `globals.css` does the rest with a media query
   * that hides `thead`, turns each `tr` into a card, and reprints every `<td>`'s column name
   * from its `data-label` attribute (see `AmountCell` and the `cell-stack-*` classes).
   *
   * The alternative -- branching the render to a bespoke card list on phones, the way the
   * review queue does -- was refused by v1.14.1 ruling R5: two DOM trees means every checkbox,
   * button and input a page renders exists twice in the document, which doubles the matches
   * for the label/role queries roughly 25 test files depend on (`getByLabelText`, `getByRole`
   * with a `name`) and makes them ambiguous instead of wrong. One tree that CSS reflows keeps
   * every query pointed at exactly one node, on every width, for free.
   *
   * Composes with `fixed` and `minWidth` -- both stay desktop concerns. `minWidth` sets an
   * inline style, which the stacked layout must override with `!important` to drop the
   * sideways scroll (see the `.data-table--stack` rule in globals.css); `fixed`'s <colgroup>
   * widths simply stop mattering once `display: grid` takes over the row below `sm`.
   */
  responsive?: boolean;
}) {
  const shell = bare ? '' : 'rounded-lg border border-line bg-surface shadow-card';
  const tableClass = [
    'data-table',
    fixed ? 'data-table--fixed' : '',
    responsive ? 'data-table--stack' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={`w-full overflow-x-auto ${shell} ${className}`}>
      <table className={tableClass} style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

/** Right-aligned, tabular-figure cell for amounts. */
export function AmountCell({
  children,
  className = '',
  'data-label': dataLabel,
}: {
  children: React.ReactNode;
  className?: string;
  /**
   * The column header text, reprinted by `.data-table--stack td::before` (globals.css) when
   * this cell's table stacks into cards below `sm`. Plumbed through explicitly rather than by
   * spreading arbitrary props -- this component has exactly one caller-facing extra attribute
   * to carry, and a spread would let any prop reach the `<td>` unreviewed, including ones that
   * silently shadow `className` or `children`.
   */
  'data-label'?: string;
}) {
  return (
    <td className={`money text-right ${className}`} data-label={dataLabel}>
      {children}
    </td>
  );
}
