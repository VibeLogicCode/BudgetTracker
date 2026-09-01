// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PillNav } from '@/components/ui/PillNav';

afterEach(() => cleanup());

// v1.25.0 backlog item 15. Was ScopePill (budgets-client.tsx) and PersonPill (dashboard/page.tsx),
// two independent copies of the same idea -- one implementation, one test file, the same reasoning
// tests/components/DaysRemainingPill.test.tsx already applies to its own three-implementations
// unification.
describe('PillNav', () => {
  const options = [
    { key: 'household', href: '/budgets?month=2026-08', label: 'Household', active: true },
    { key: '2', href: '/budgets?person=2&month=2026-08', label: 'Alice', active: false },
    { key: '3', href: '/budgets?person=3&month=2026-08', label: 'Bob', active: false },
  ];

  it('renders every option as a link with its own href', () => {
    render(<PillNav groupLabel="Which budgets to show" options={options} />);
    expect(screen.getByRole('link', { name: 'Household' }).getAttribute('href')).toBe('/budgets?month=2026-08');
    expect(screen.getByRole('link', { name: 'Alice' }).getAttribute('href')).toBe(
      '/budgets?person=2&month=2026-08',
    );
    expect(screen.getByRole('link', { name: 'Bob' }).getAttribute('href')).toBe('/budgets?person=3&month=2026-08');
  });

  it('marks exactly the active option with aria-current="page"', () => {
    render(<PillNav groupLabel="Which budgets to show" options={options} />);
    expect(screen.getByRole('link', { name: 'Household' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Alice' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Bob' }).getAttribute('aria-current')).toBeNull();
  });

  it('wraps the options in a labelled navigation landmark, not a bare group', () => {
    render(<PillNav groupLabel="Which budgets to show" options={options} />);
    expect(screen.getByRole('navigation', { name: 'Which budgets to show' })).toBeTruthy();
    // The landmark is the point: role="group" would name the set but could not be jumped to.
    expect(screen.queryByRole('group', { name: 'Which budgets to show' })).toBeNull();
  });

  it('carries the 44px mobile touch-target floor on every option link', () => {
    render(<PillNav groupLabel="Which budgets to show" options={options} />);
    for (const label of ['Household', 'Alice', 'Bob']) {
      const link = screen.getByRole('link', { name: label });
      expect(link.className).toContain('min-h-11');
      expect(link.className).toContain('sm:min-h-0');
    }
  });

  it('renders no options at all for an empty list, without throwing', () => {
    const { container } = render(<PillNav groupLabel="Which budgets to show" options={[]} />);
    expect(screen.getByRole('navigation', { name: 'Which budgets to show' })).toBeTruthy();
    expect(container.querySelectorAll('a').length).toBe(0);
  });
});
