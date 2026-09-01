import { isSelfScoped, ownerScope, type Viewer } from '@/lib/auth/viewer';
import { resolveRange, type ResolvedRange } from '@/lib/date-range';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import type { CategorizationSource, SortDirection, TransactionFilter, TransactionSort } from '@/lib/transactions';

/**
 * v1.26.0 Lane 3a. `readFilter` used to be a private function inside page.tsx, which was right
 * for as long as the ONLY thing that ever turned this page's querystring into a TransactionFilter
 * was the page's own render. The group bulk actions (bulkConfirmGroupAction /
 * bulkRecategorizeGroupAction, actions.ts) break that assumption: a group header states a count
 * taken from `CategoryGroupRow.count`, which is the cluster's FULL size across every row page, so
 * the write behind it has to reach the same set -- and the only way to name that set from a form
 * post is to send the filter the page was rendered under and rebuild it server-side.
 *
 * Rebuilt with THIS function, not a second parse beside it. That is the whole reason this file
 * exists: two parsers would be two places for `?transfers=only` (or `?source=`, or a self viewer's
 * forced person scope) to be understood differently, and the failure mode is a dialog that
 * promises "34 transactions" and a write that touches some other number of rows. One parser, two
 * callers, and the ids the action writes are derived from a viewer-scoped read rather than
 * accepted from the request.
 *
 * Deliberately NOT in src/lib/**: nothing outside this route reads these params, and the ban on
 * `new Date()` under src/lib is exactly the kind of rule a URL-reading helper that needs "today"
 * for `?range=this-month` would have to fight. page.tsx already did this same `todayIso(new
 * Date(), readEnv().tz)` call before this release; `filterFromQuery` below is that call moved, not
 * added.
 */
export type TransactionParams = Record<string, string | string[] | undefined>;

/** A repeated key (nothing produces one today, but a hand-edited URL can) reads as its first
 *  value rather than as `"a,b"` -- the same choice page.tsx's own `one` helper always made. */
function one(params: TransactionParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

function num(params: TransactionParams, key: string): number | undefined {
  const value = one(params, key);
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * v1.26.0 Lane 3a, the `?source=` half of the audit URL. Anything but the four real values --
 * absent, or a hand-edited junk value -- is `undefined`, meaning "every source", which is the same
 * "fall back rather than refuse" rule `?transfers=` and `?queue=` already follow (readFilter
 * below). The list is checked against CategorizationSource by construction: the record's key type
 * is that union, so adding a fifth source to src/lib/transactions.ts fails to compile here until
 * this reader knows about it, rather than silently ignoring the new value in the URL.
 */
const SOURCE_VALUES: Record<CategorizationSource, true> = { rule: true, bayes: true, manual: true, none: true };

export function readSource(raw: string | undefined): CategorizationSource | undefined {
  return raw !== undefined && raw in SOURCE_VALUES ? (raw as CategorizationSource) : undefined;
}

/** Same shape and same fallback rule as readSource above, for `?sort=`. `undefined` is the one
 *  default that leaves listTransactions' order byte-identical to what it was before this release
 *  (TransactionFilter.sort's own doc comment, src/lib/transactions.ts) -- so a junk value must land
 *  here, never on an arbitrary column. */
const SORT_VALUES: Record<TransactionSort, true> = { date: true, amount: true, category: true };

export function readSort(raw: string | undefined): TransactionSort | undefined {
  return raw !== undefined && raw in SORT_VALUES ? (raw as TransactionSort) : undefined;
}

/** `?dir=`. Only ever read when a sort is set (the data layer ignores it otherwise), and anything
 *  but the literal 'asc' is 'desc' -- the page's own long-standing newest-first default. */
export function readDirection(raw: string | undefined): SortDirection {
  return raw === 'asc' ? 'asc' : 'desc';
}

/**
 * v1.26.0 Lane 3a. `?group=category` turns the grouped view on; absent or unrecognised is off,
 * exactly as `transfers`/`queue`/`uncat` already behave. One accepted value, not a boolean flag:
 * "grouped by category" is one of several groupings this page could grow (by merchant, by
 * account), and `?group=1` would have to be re-spelled the day a second one lands.
 */
export function readGroupMode(params: TransactionParams): boolean {
  return one(params, 'group') === 'category';
}

/** `?gpage=`. GROUP pagination, never row pagination -- see groupTransactionsByCategory's own doc
 *  comment (src/lib/transactions.ts) for why the two cannot share a number. Junk (or absent) is
 *  page 1, the same clamp groupTransactionsByCategory applies to whatever it is handed. */
export function readGroupPage(params: TransactionParams): number {
  return num(params, 'gpage') ?? 1;
}

export function readFilter(
  params: TransactionParams,
  range: ResolvedRange | null,
  /** v1.13.0 ruling R2: the person filter for a self viewer comes from the SESSION, not the URL --
   *  the same `ownerScope(viewer) ?? urlValue` idiom dashboard/page.tsx and reports/page.tsx already
   *  use, so a self viewer's own id always wins over whatever a hand-edited `?person=` says. */
  selfOwnerId: number | null,
  /** Ruling R1/R2: already forced to `false` for a self viewer by the caller -- listReviewQueue's
   *  replacement (`reviewOnly` on the filter) is household-wide by construction, same as the page
   *  it replaces, so this function never has to know WHY it is false, only what to do with it. */
  reviewMode: boolean,
): TransactionFilter {
  const person = one(params, 'person');
  const category = one(params, 'category');
  const sort = readSort(one(params, 'sort'));
  return {
    accountId: num(params, 'account') ?? null,
    categoryId:
      category === 'uncategorized' ? 'uncategorized' : category && /^\d+$/.test(category) ? Number(category) : null,
    // v1.21.0 item 3: `?category=<id>` means the category AND its children (a chip's own
    // meaning); `?category=<id>&exact=1` means that category alone (the Budgets "Not in a
    // sub-category" row's drill-down wants this, and so does a group header's drill-down --
    // groupDrillHref in transactions-client.tsx). See TransactionFilter.categoryExact's own
    // doc comment (src/lib/transactions.ts) for the rest of the reasoning.
    categoryExact: one(params, 'exact') === '1',
    attributedUserId:
      selfOwnerId !== null
        ? selfOwnerId
        : person === 'unattributed'
          ? 'unattributed'
          : person && /^\d+$/.test(person)
            ? Number(person)
            : null,
    from: range?.from ?? null,
    to: range?.to ?? null,
    search: one(params, 'q') ?? null,
    uncategorizedOnly: one(params, 'uncat') === '1',
    // v1.24.0 Lane A item 2. Backwards compatible with links people already have: `transfers=0`
    // keeps meaning "hide transfers", exactly as it always has. `transfers=only` is the new
    // recovery-path value (TransactionFilter.transferView's own doc comment, src/lib/transactions.ts,
    // has the full reasoning); anything else -- absent, or a hand-edited junk value -- is 'all'.
    transferView:
      one(params, 'transfers') === '0' ? 'none' : one(params, 'transfers') === 'only' ? 'only' : 'all',
    // v1.25.0 Lane R item R1: `?queue=` chips onto the review filter (TransactionFilter.reviewQueue's
    // own doc comment, src/lib/transactions.ts). Anything but the two real values -- absent, or a
    // hand-edited junk value -- is `undefined`, meaning "both", the same "fall back rather than
    // refuse" rule `?transfers=` just above already follows.
    reviewQueue:
      one(params, 'queue') === 'suggested'
        ? 'suggested'
        : one(params, 'queue') === 'uncategorized'
          ? 'uncategorized'
          : undefined,
    // v1.26.0 Lane 3a. The two halves of the audit URL (`/transactions?import=<id>&source=rule`),
    // both plain equality on an indexed transactions column at the data layer -- see their own doc
    // comments on TransactionFilter (src/lib/transactions.ts) for why import_id and not the
    // transaction_imports join table. `importId` is null, not undefined, when absent: the field is
    // `number | null | undefined` and buildWhere only ever acts on `typeof === 'number'`, so null
    // reads the same as omitted while keeping this object's shape stable.
    source: readSource(one(params, 'source')),
    importId: num(params, 'import') ?? null,
    // v1.26.0 Lane 3a. `sort` ABSENT is the only value that leaves today's ordering untouched, so
    // there is deliberately no default written here -- an unrecognised `?sort=` lands on undefined
    // (readSort) and the list looks exactly as it did before this release. `direction` is sent only
    // alongside a real sort: the data layer ignores it without one, and writing it anyway would put
    // a value in the filter object that nothing reads, which is how a later reader learns the wrong
    // thing about what this page asked for.
    sort,
    direction: sort === undefined ? undefined : readDirection(one(params, 'dir')),
    page: num(params, 'page') ?? 1,
    pageSize: 50,
    reviewOnly: reviewMode,
  };
}

/**
 * v1.26.0 Lane 3a. The whole "querystring in, TransactionFilter out" pipeline in one call, for the
 * server actions that are handed a querystring rather than Next's already-parsed searchParams.
 * page.tsx does NOT use this: it needs `today` and the resolved range as values of their own (both
 * are props the client renders), so it runs the same three steps itself and calls readFilter above
 * directly. Same parser either way, which is the point of this file.
 *
 * `viewer` decides two things no querystring may override: a self viewer's person scope (ruling
 * R2, applied inside readFilter) and whether `?review=1` means anything at all (ruling R2 again --
 * silently ignored for a self viewer, never refused). A tampered `?person=` therefore cannot widen
 * what a group bulk action writes, and neither can a tampered `?review=1`.
 */
export function filterFromQuery(query: string, viewer: Viewer): TransactionFilter {
  const params: TransactionParams = Object.fromEntries(new URLSearchParams(query));
  const today = todayIso(new Date(), readEnv().tz);
  const range = resolveRange({
    preset: one(params, 'range'),
    from: one(params, 'from'),
    to: one(params, 'to'),
    today,
    fallback: null,
  });
  return readFilter(params, range, ownerScope(viewer), one(params, 'review') === '1' && !isSelfScoped(viewer));
}
