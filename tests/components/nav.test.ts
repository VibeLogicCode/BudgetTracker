import { describe, it, expect } from 'vitest';
import { NAV, visibleNav } from '@/components/app-shell/nav';
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
    expect(NAV.map((item) => item.href)).toContain('/review');
    expect(NAV.map((item) => item.href)).toContain('/settings');
  });
});
