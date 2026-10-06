/**
 * Spec 2026-10-05 §2.4 and 2026-10-06 §2.2. The one builder of an /insights or /insights/recurring
 * link and the one reader of their params. A link that drops `person` answers a different question
 * than the figure it came from -- the rule transactionsHref (src/lib/transaction-links.ts) enforces
 * for /transactions. No imports, so a client component and a server page can both use it
 * (tests/ops/client-bundle.test.ts).
 */
export interface InsightsLinkScope {
  /** The person scope, a user id; null is the whole household. A self viewer's own scope still wins server-side. */
  person: number | null;
  /** The Account filter; null is every account. */
  account: number | null;
}

export function insightsHref(scope: InsightsLinkScope): string {
  const params = new URLSearchParams();
  if (scope.person !== null) params.set('person', String(scope.person));
  if (scope.account !== null) params.set('account', String(scope.account));
  const query = params.toString();
  return query === '' ? '/insights' : `/insights?${query}`;
}

/** The first value of a param, or '' -- a repeated key reads as its first. */
function firstValue(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Digits or nothing, the way the Dashboard reads ?person=: a malformed value is no filter, never an error. */
function idOf(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export function readInsightsParams(params: Record<string, string | string[] | undefined>): InsightsLinkScope {
  return { person: idOf(firstValue(params, 'person')), account: idOf(firstValue(params, 'account')) };
}

/** Spec 2026-10-06 §2.2. The full page's Show choices; 'all' is the default and is never written. */
export const RECURRING_SHOWS = ['all', 'known', 'looks', 'forming', 'late'] as const;
export type RecurringShow = (typeof RECURRING_SHOWS)[number];

/** Spec 2026-10-06 §2.2. The full page's Sort choices; 'monthly' is the default and is never written. */
export const RECURRING_SORTS = ['monthly', 'next', 'last', 'merchant'] as const;
export type RecurringSort = (typeof RECURRING_SORTS)[number];

export interface RecurringLinkScope extends InsightsLinkScope {
  show: RecurringShow;
  sort: RecurringSort;
}

export function recurringHref(scope: RecurringLinkScope): string {
  const params = new URLSearchParams();
  if (scope.person !== null) params.set('person', String(scope.person));
  if (scope.account !== null) params.set('account', String(scope.account));
  if (scope.show !== 'all') params.set('show', scope.show);
  if (scope.sort !== 'monthly') params.set('sort', scope.sort);
  const query = params.toString();
  return query === '' ? '/insights/recurring' : `/insights/recurring?${query}`;
}

/** A value outside the fixed lists reads as the default: a hand-edited address shows the page, never an error. */
export function readRecurringParams(params: Record<string, string | string[] | undefined>): RecurringLinkScope {
  const show = firstValue(params, 'show');
  const sort = firstValue(params, 'sort');
  return {
    ...readInsightsParams(params),
    show: (RECURRING_SHOWS as readonly string[]).includes(show) ? (show as RecurringShow) : 'all',
    sort: (RECURRING_SORTS as readonly string[]).includes(sort) ? (sort as RecurringSort) : 'monthly',
  };
}
