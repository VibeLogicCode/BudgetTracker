import type { TaxYearRow } from '@/lib/tax';

/**
 * v1.63.0 (plan 2026-11-12, B7). How the tax rows are ordered and totalled on screen, moved out of
 * reports-client.tsx so the Tax year card and the Year in review card share one definition and
 * cannot total differently. Pure: a type-only import from tax.ts and nothing else, so a client
 * component can import it without reaching @/db (tests/ops/client-bundle.test.ts).
 */

/** Task 15b (v1.7.0): one taxYearReport() row, plus its place in the category tree. tax.ts's
 *  TaxYearRow does not carry parentId -- a tax-year row does not otherwise need it -- so the
 *  page attaches it before handing rows to a card, which needs it to indent a flagged child
 *  under its flagged parent and disclose the overlap (see orderTaxRows below). */
export interface TaxYearDisplayRow extends TaxYearRow {
  parentId: number | null;
}

export interface OrderedTaxRow {
  row: TaxYearDisplayRow;
  nested: boolean;
}

/**
 * Task 15b: pairs each taxYearReport() row with whether it is a flagged child nested under a
 * flagged parent that is ALSO present in this year's rows -- the one case where two rows on
 * this card overlap (src/lib/tax.ts's module doc comment: a flagged parent's row always folds
 * in every child's spend, flagged or not, so a separately-flagged child's own row duplicates
 * part of its parent's total by design).
 *
 * A nested row is placed directly after its parent regardless of where taxYearReport's own
 * totalCents-descending sort put it -- the whole point of nesting is that the two rows read
 * together, adjacent, not wherever their totals happened to rank. A child whose parent is not
 * separately flagged (so the parent never appears as its own row here) has nothing to overlap
 * with and stays at the top level, in taxYearReport's original order.
 */
export function orderTaxRows(rows: TaxYearDisplayRow[]): OrderedTaxRow[] {
  const presentIds = new Set(rows.map((row) => row.categoryId));
  const nestedIds = new Set(
    rows.filter((row) => row.parentId !== null && presentIds.has(row.parentId)).map((row) => row.categoryId),
  );
  const ordered: OrderedTaxRow[] = [];
  for (const row of rows) {
    if (nestedIds.has(row.categoryId)) continue;
    ordered.push({ row, nested: false });
    for (const child of rows) {
      if (nestedIds.has(child.categoryId) && child.parentId === row.categoryId) ordered.push({ row: child, nested: true });
    }
  }
  return ordered;
}

/** The cards' own total. A nested row's spend already counts inside the parent row placed
 *  directly above it, so only the non-nested rows are added -- summing every row's totalCents
 *  unconditionally would double the exact overlap the cards exist to disclose. */
export function taxGrandTotal(ordered: OrderedTaxRow[]): number {
  return ordered.filter((entry) => !entry.nested).reduce((sum, entry) => sum + entry.row.totalCents, 0);
}
