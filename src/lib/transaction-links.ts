import { rangeParams, type ResolvedRange } from '@/lib/date-range';

/**
 * F-01 (v1.31.0): the ONE place a reported figure becomes a `/transactions` link.
 *
 * Reports, the dashboard's Top merchants card and the transactions row menu all want the same
 * sentence -- "show me the rows behind this number" -- and before this module each of them would
 * have hand-built a querystring for it. That is the defect shape this review lineage keeps
 * finding (the last sweep found one rule living in six modules), and it has a specific, ugly
 * failure here: a hand-built link that forgets `person` silently answers a DIFFERENT question
 * than the figure above it, showing the household's rows to somebody who asked about one person,
 * or one person's rows to somebody who asked about the household. v1.30.0 shipped three separate
 * fixes for paths that forgot a person scope; this module exists so a link cannot.
 *
 * Both parameters are REQUIRED and `scope` carries both of its fields with no defaults, so a
 * call site cannot omit the scope by omitting an argument -- it has to write down what range and
 * what person the figure was built with, and `range: null` (every date) is a decision somebody
 * typed rather than one they forgot. This is the same "it will not compile until its author
 * decides what scope it is reading" discipline `viewer` already enforces on every aggregate in
 * src/lib/reports.ts.
 *
 * The counterpart READER is `readFilter` in src/app/(app)/transactions/filter-params.ts. Nothing
 * in the type system ties the two together, so tests/lib/transaction-links.test.ts round-trips
 * every shape below through that reader and asserts on the resulting TransactionFilter rather
 * than on URL text -- a link that merely LOOKS right is not the property worth guarding.
 *
 * Lives under src/lib/ rather than beside `readFilter` (whose own docblock explains why IT does
 * not): three separate route groups build these links, this module needs no notion of "today"
 * (so the src/lib ban on `new Date()` costs it nothing), and it must stay importable from a
 * `'use client'` component AND a Server Component at once -- so it value-imports only
 * @/lib/date-range, itself pure and client-safe (tests/ops/client-bundle.test.ts).
 */

export interface TransactionsLinkScope {
  /**
   * The window the figure was summed over. A `ResolvedRange` (the page's own picker) is carried
   * as its PRESET TOKEN wherever it has one, not as two dates -- MUST-11.4's reason, and what
   * the Export CSV link already does: the token means the same window on the receiving page
   * because the same server resolves it in the same timezone. A card with a window of its own
   * that the picker did not choose -- a tax year, one month on the dashboard -- passes the two
   * dates instead.
   *
   * `null` means "every date", and is for the one link that genuinely means it: the row menu's
   * "Show all from this merchant". It is spelled out rather than defaulted so that dropping a
   * range is always visible in the diff.
   */
  range: ResolvedRange | { from: string; to: string } | null;
  /**
   * The person scope, exactly as the page resolved it for its own `?person=`: a user id, the
   * literal `'unattributed'` bucket, or null/'' for a household figure. Passing the page's own
   * `person` value (never a re-derivation of it) is what keeps the link and the figure asking
   * the same question.
   */
  person: string | number | null;
}

/**
 * What the figure was ABOUT. A discriminated union rather than two optional fields: a link is
 * for exactly one of these, and `{ categoryId, merchant }` both set is not a filter anybody on
 * this app's cards means.
 */
export type TransactionsLinkTarget =
  /**
   * `exact` is the difference between a category row that means "this category and its children"
   * (a rolled-up breakdown row, a month-over-month row) and one that means "this category alone"
   * -- the `— not in a sub-category` rows a non-rollup breakdown emits. Getting it wrong lists a
   * different set of rows than the amount beside the link claims, which is worse than no link.
   * See TransactionFilter.categoryExact (src/lib/transactions.ts) for the reader's half.
   */
  | { kind: 'category'; categoryId: number | null; exact?: boolean }
  | { kind: 'merchant'; merchant: string };

/** rangeParams() for a preset (one definition of "a range as query parameters", MUST-11.8), and
 *  the same `custom` shape it produces for a card carrying its own two dates. */
function rangeQuery(range: TransactionsLinkScope['range']): Record<string, string> {
  if (range === null) return {};
  if ('preset' in range) return rangeParams(range);
  return { range: 'custom', from: range.from, to: range.to };
}

/** '' and null both mean "no person filter"; everything else is passed through as written, so a
 *  numeric id and the 'unattributed' bucket travel by the same path. */
function personParam(person: string | number | null): string | null {
  if (person === null) return null;
  const text = String(person);
  return text === '' ? null : text;
}

export function transactionsHref(scope: TransactionsLinkScope, target: TransactionsLinkTarget): string {
  const params = new URLSearchParams(rangeQuery(scope.range));
  const person = personParam(scope.person);
  if (person !== null) params.set('person', person);

  if (target.kind === 'category') {
    // `uncategorized` is a real filter value on the reading side, not a missing one -- the
    // breakdown's null-id bucket is a figure like any other and links like one.
    params.set('category', target.categoryId === null ? 'uncategorized' : String(target.categoryId));
    if (target.exact) params.set('exact', '1');
  } else {
    params.set('q', target.merchant);
  }

  return `/transactions?${params.toString()}`;
}
