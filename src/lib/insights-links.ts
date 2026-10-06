/**
 * Spec 2026-10-05 §2.4. The one builder of an /insights link and the one reader of its params. A
 * link that drops `person` answers a different question than the figure it came from -- the rule
 * transactionsHref (src/lib/transaction-links.ts) enforces for /transactions. No imports, so a
 * client component and a server page can both use it (tests/ops/client-bundle.test.ts).
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

/** Digits or nothing, the way the Dashboard reads ?person=: a malformed value is no filter, never an error. */
export function readInsightsParams(params: Record<string, string | string[] | undefined>): InsightsLinkScope {
  const one = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const id = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);
  return { person: id(one('person')), account: id(one('account')) };
}
