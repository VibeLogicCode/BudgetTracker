import { describe, it, expect } from 'vitest';
import { NAV, navGroups, visibleNav, REVIEW_NAV_HREF } from '@/components/app-shell/nav';
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

/**
 * 2026-09-15, from the `$impeccable critique` design review (28/40; heuristic 8, Aesthetic and
 * minimalist design, scored 2): "the nav rail is ten undifferentiated doors."
 *
 * NAV's own docblock has always said the entries follow the order money moves through the app --
 * see the month, check the transactions behind it, fix what the categorizer was unsure of, bring
 * more in, then the planning surfaces, then the back office. None of that was ever visible in the
 * rendering. These groups are that sentence, made structural.
 *
 * NAV itself is deliberately NOT reordered or shortened: tests/ops/onboarding-coverage.test.ts
 * greps the full list, and AppShell.test.tsx pins Help last. Grouping is a VIEW of NAV.
 */
describe('navGroups: the rail shows the money-flow sequence it always described', () => {
  it('puts the four money-flow entries under one label, in NAV order', () => {
    const groups = navGroups(household);
    expect(groups[0].label).toBe('This month');
    expect(groups[0].items.map((item) => item.href)).toEqual([
      '/dashboard', '/transactions', REVIEW_NAV_HREF, '/import',
    ]);
  });

  it('puts the planning surfaces under the second label, in NAV order', () => {
    const groups = navGroups(household);
    expect(groups[1].label).toBe('Planning');
    expect(groups[1].items.map((item) => item.href)).toEqual([
      '/budgets', '/goals', '/warranties', '/reports',
    ]);
  });

  /**
   * Settings and Help are the back office. They get a hairline rather than a label: naming a pair
   * of utility links "Other" tells a reader nothing they cannot see, and the craft floor is right
   * that a label which adds no information is decoration.
   */
  it('leaves the back office unlabelled, separated by a rule', () => {
    const groups = navGroups(household);
    expect(groups[2].label).toBeNull();
    expect(groups[2].items.map((item) => item.href)).toEqual(['/settings', '/help']);
  });

  it('accounts for every visible entry exactly once, and changes none of them', () => {
    const groups = navGroups(household);
    const flat = groups.flatMap((group) => group.items);
    // Same objects, same order as NAV -- grouping is a view, never a rewrite.
    expect(flat).toEqual(NAV);
  });

  /**
   * A self viewer loses Import, Review and Settings. The groups have to survive that without
   * printing a label over nothing -- the failure mode where a heading outlives its content.
   */
  it('drops a group that a viewer cannot see anything in, rather than heading an empty list', () => {
    const groups = navGroups(child);
    expect(groups.flatMap((group) => group.items)).toEqual(visibleNav(child));
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
    expect(groups[0].items.map((item) => item.href)).toEqual(['/dashboard', '/transactions']);
    // Settings is gone; Help alone still forms the unlabelled tail.
    expect(groups.at(-1)).toMatchObject({ label: null });
    expect(groups.at(-1)?.items.map((item) => item.href)).toEqual(['/help']);
  });

  it('gives every NAV entry a group, so a new one cannot silently fall out of the rail', () => {
    const grouped = new Set(navGroups(household).flatMap((group) => group.items.map((i) => i.href)));
    for (const item of NAV) expect(grouped.has(item.href)).toBe(true);
  });
});
