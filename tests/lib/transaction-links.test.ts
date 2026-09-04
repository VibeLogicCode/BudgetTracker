import { describe, it, expect } from 'vitest';
import { readFilter, type TransactionParams } from '@/app/(app)/transactions/filter-params';
import { resolveRange, type ResolvedRange } from '@/lib/date-range';
import { transactionsHref } from '@/lib/transaction-links';
import type { TransactionFilter } from '@/lib/transactions';

/**
 * F-01 (v1.31.0). `transactionsHref` is the WRITER of a /transactions querystring and
 * `readFilter` (src/app/(app)/transactions/filter-params.ts) is its READER. Nothing in the type
 * system connects the two, so the tests below do not assert on the URL text alone -- most of
 * them feed the produced href straight back through the reader the transactions page itself
 * uses and assert on the FILTER that comes out. That is the property that actually matters:
 * "the link shows the rows the figure was made of", not "the link contains the characters I
 * expected".
 */

const TODAY = '2026-09-04';

/** Exactly what src/app/(app)/transactions/page.tsx does with a URL, minus the viewer. */
function filterFromHref(href: string, selfOwnerId: number | null = null): TransactionFilter {
  const query = href.slice(href.indexOf('?') + 1);
  const params: TransactionParams = Object.fromEntries(new URLSearchParams(query));
  const range = resolveRange({
    preset: params.range as string | undefined,
    from: params.from as string | undefined,
    to: params.to as string | undefined,
    today: TODAY,
    fallback: null,
  });
  return readFilter(params, range, selfOwnerId, false);
}

const LAST_6: ResolvedRange = { preset: 'last_6_months', from: '2026-04-01', to: '2026-09-30', label: 'Last 6 months' };
const CUSTOM: ResolvedRange = { preset: 'custom', from: '2026-02-01', to: '2026-02-28', label: '2026-02-01 to 2026-02-28' };

describe('transactionsHref — the range the card was built with', () => {
  it('carries a preset range as its TOKEN, so the list resolves the same window the card did', () => {
    const href = transactionsHref({ range: LAST_6, person: null }, { kind: 'category', categoryId: 7 });
    expect(href).toContain('range=last_6_months');
    expect(href).not.toContain('from=');
    const filter = filterFromHref(href);
    expect({ from: filter.from, to: filter.to }).toEqual({ from: '2026-04-01', to: '2026-09-30' });
  });

  it('carries a custom range as both dates', () => {
    const filter = filterFromHref(transactionsHref({ range: CUSTOM, person: null }, { kind: 'category', categoryId: 7 }));
    expect({ from: filter.from, to: filter.to }).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('carries a card that has its own window (a tax year, a month) as that window', () => {
    const filter = filterFromHref(
      transactionsHref({ range: { from: '2025-01-01', to: '2025-12-31' }, person: null }, { kind: 'category', categoryId: 7 }),
    );
    expect({ from: filter.from, to: filter.to }).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('a null range means every date, and says so by carrying no date parameter at all', () => {
    const href = transactionsHref({ range: null, person: null }, { kind: 'merchant', merchant: 'TIM HORTONS' });
    expect(href).toBe('/transactions?q=TIM+HORTONS');
    const filter = filterFromHref(href);
    expect({ from: filter.from, to: filter.to }).toEqual({ from: null, to: null });
  });
});

describe('transactionsHref — the person scope the card was built with', () => {
  it('carries a numeric person scope', () => {
    expect(filterFromHref(transactionsHref({ range: LAST_6, person: 4 }, { kind: 'category', categoryId: 7 })).attributedUserId).toBe(4);
  });

  it('carries a person scope that reached it as a string (the value the page resolved for the select)', () => {
    expect(filterFromHref(transactionsHref({ range: LAST_6, person: '4' }, { kind: 'category', categoryId: 7 })).attributedUserId).toBe(4);
  });

  it('carries the unattributed bucket, which is a scope and not an absence of one', () => {
    expect(
      filterFromHref(transactionsHref({ range: LAST_6, person: 'unattributed' }, { kind: 'category', categoryId: 7 })).attributedUserId,
    ).toBe('unattributed');
  });

  it("leaves the person parameter off for a household figure, and only for one", () => {
    for (const person of [null, ''] as const) {
      const href = transactionsHref({ range: LAST_6, person }, { kind: 'category', categoryId: 7 });
      expect(href).not.toContain('person=');
      expect(filterFromHref(href).attributedUserId).toBeNull();
    }
  });

  it("a self viewer's own scope still wins over whatever the link asked for", () => {
    // The link a household card built, opened by a self-scoped member: readFilter's selfOwnerId
    // (ownerScope(viewer) at the page) overrides the querystring, so no link can widen a read.
    expect(filterFromHref(transactionsHref({ range: LAST_6, person: 4 }, { kind: 'category', categoryId: 7 }), 9).attributedUserId).toBe(9);
  });
});

describe('transactionsHref — the figure the link is under', () => {
  it('a rolled-up category row means the category AND its children', () => {
    const filter = filterFromHref(transactionsHref({ range: LAST_6, person: null }, { kind: 'category', categoryId: 7 }));
    expect({ categoryId: filter.categoryId, categoryExact: filter.categoryExact }).toEqual({ categoryId: 7, categoryExact: false });
  });

  it('a "not in a sub-category" row means that category ALONE', () => {
    const filter = filterFromHref(
      transactionsHref({ range: LAST_6, person: null }, { kind: 'category', categoryId: 7, exact: true }),
    );
    expect({ categoryId: filter.categoryId, categoryExact: filter.categoryExact }).toEqual({ categoryId: 7, categoryExact: true });
  });

  it('the Uncategorized bucket is a real target, not a missing one', () => {
    expect(filterFromHref(transactionsHref({ range: LAST_6, person: null }, { kind: 'category', categoryId: null })).categoryId).toBe(
      'uncategorized',
    );
  });

  it('a merchant row searches for the merchant', () => {
    expect(filterFromHref(transactionsHref({ range: LAST_6, person: null }, { kind: 'merchant', merchant: "MO'S DINER & CO" })).search).toBe(
      "MO'S DINER & CO",
    );
  });

  // F-03 (v1.31.0): the import screen's History "View rows" link. An import id already fully
  // identifies its own rows, so the call site passes `{ range: null, person: null }` -- this
  // just confirms the reader agrees that a bare importId is enough, with no date or person
  // filter riding along uninvited.
  it('an import row filters on the import id alone', () => {
    const href = transactionsHref({ range: null, person: null }, { kind: 'import', importId: 77 });
    expect(href).toBe('/transactions?import=77');
    const filter = filterFromHref(href);
    expect(filter.importId).toBe(77);
    expect({ from: filter.from, to: filter.to }).toEqual({ from: null, to: null });
  });
});
