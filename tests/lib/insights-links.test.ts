import { describe, it, expect } from 'vitest';
import { insightsHref, readInsightsParams, readRecurringParams, recurringHref } from '@/lib/insights-links';

/** Spec 2026-10-05 §2.4. The /insights link and its reader, round-tripped so they cannot drift. */
describe('insightsHref and readInsightsParams', () => {
  const paramsOf = (href: string) => Object.fromEntries(new URL(href, 'http://nas.local').searchParams);

  it('round-trips every shape through its reader', () => {
    for (const scope of [
      { person: null, account: null },
      { person: 7, account: null },
      { person: null, account: 3 },
      { person: 7, account: 3 },
    ]) {
      const href = insightsHref(scope);
      expect(href.startsWith('/insights')).toBe(true);
      expect(readInsightsParams(paramsOf(href))).toEqual(scope);
    }
  });

  it('writes no querystring for the whole household on every account', () => {
    expect(insightsHref({ person: null, account: null })).toBe('/insights');
  });

  it('reads an empty or malformed value as no filter, and the first of a repeated key', () => {
    expect(readInsightsParams({ person: '', account: 'visa' })).toEqual({ person: null, account: null });
    expect(readInsightsParams({ account: ['3', '9'] })).toEqual({ person: null, account: 3 });
  });
});

/** Spec 2026-10-06 §2.2. The /insights/recurring link and its reader. */
describe('recurringHref and readRecurringParams', () => {
  const paramsOf = (href: string) => Object.fromEntries(new URL(href, 'http://nas.local').searchParams);

  it('round-trips every shape through its reader', () => {
    for (const scope of [
      { person: null, account: null, show: 'all', sort: 'monthly' },
      { person: 7, account: 3, show: 'late', sort: 'next' },
      { person: null, account: 3, show: 'forming', sort: 'merchant' },
      { person: 7, account: null, show: 'known', sort: 'last' },
    ] as const) {
      const href = recurringHref(scope);
      expect(href.startsWith('/insights/recurring')).toBe(true);
      expect(readRecurringParams(paramsOf(href))).toEqual(scope);
    }
  });

  it('writes no querystring for the defaults, and only what differs otherwise', () => {
    expect(recurringHref({ person: null, account: null, show: 'all', sort: 'monthly' })).toBe('/insights/recurring');
    expect(recurringHref({ person: 7, account: 3, show: 'late', sort: 'next' })).toBe('/insights/recurring?person=7&account=3&show=late&sort=next');
  });

  /** Review Focus 3. */
  it('reads a malformed or repeated value as the default', () => {
    expect(readRecurringParams({ show: 'everything', sort: 'drop', account: 'abc', person: 'x' })).toEqual({
      person: null,
      account: null,
      show: 'all',
      sort: 'monthly',
    });
    expect(readRecurringParams({ show: ['late', 'known'], sort: ['next'] })).toEqual({ person: null, account: null, show: 'late', sort: 'next' });
  });
});
