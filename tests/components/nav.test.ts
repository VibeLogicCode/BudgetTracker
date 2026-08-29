import { describe, it, expect } from 'vitest';
import { NAV, visibleNav, REVIEW_NAV_HREF } from '@/components/app-shell/nav';
import type { Viewer } from '@/lib/auth/viewer';

const household: Viewer = { id: 1, role: 'member', visibility: 'household' };
const child: Viewer = { id: 5, role: 'member', visibility: 'self' };
const admin: Viewer = { id: 1, role: 'admin', visibility: 'self' };

describe('visibleNav (micro-ruling M6)', () => {
  it('a household member sees the whole nav, byte-identical to before v1.13.0', () => {
    expect(visibleNav(household)).toEqual(NAV);
  });

  it('a self viewer loses Import, Review and Settings and keeps the rest', () => {
    expect(visibleNav(child).map((item) => item.href)).toEqual([
      '/dashboard', '/transactions', '/budgets', '/goals', '/warranties', '/reports', '/help',
    ]);
  });

  it('an admin always sees the whole nav, even if their row were somehow marked self (M1 makes this unreachable in practice)', () => {
    expect(visibleNav(admin)).toEqual(NAV);
  });

  it('NAV itself is untouched, so the onboarding-coverage guard still greps the full list', () => {
    expect(NAV.map((item) => item.href)).toContain('/import');
    // v1.14.1: the entry survives, its href does not -- /review is a redirect now and the nav
    // points straight at the filter that replaced it (ruling R7). REVIEW_NAV_HREF is the single
    // place that link is written down.
    expect(NAV.map((item) => item.href)).toContain(REVIEW_NAV_HREF);
    expect(NAV.find((item) => item.href === REVIEW_NAV_HREF)?.label).toBe('Review');
    expect(NAV.map((item) => item.href)).toContain('/settings');
  });
});
