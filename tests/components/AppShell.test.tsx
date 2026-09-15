// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell/AppShell';
import { activeNavItem, NAV } from '@/components/app-shell/nav';

/** v1.14.1: AppShell now reads the query string too -- the review entry is a filter on
 *  /transactions, so only `?review=1` tells it apart from the plain list. Both are mutable so a
 *  test can put the shell on the review filter. */
const nav = { pathname: '/dashboard', search: '' };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  nav.pathname = '/dashboard';
  nav.search = '';
});

describe('the Review nav entry after the queue became a filter (v1.14.1, rulings R6/R7)', () => {
  it('carries the waiting count as a badge even though its href is a query string', () => {
    render(
      <AppShell user={user} reviewCount={4} version="1.2.3">
        <p>child</p>
      </AppShell>,
    );
    expect(screen.getAllByLabelText('4 to review').length).toBeGreaterThan(0);
  });

  it('marks Review current on the filter, and Transactions current without it', () => {
    nav.pathname = '/transactions';
    nav.search = '?review=1';
    const { unmount } = render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>child</p>
      </AppShell>,
    );
    const current = screen.getAllByRole('link', { current: 'page' }).map((el) => el.textContent);
    expect(current).toContain('Review');
    expect(current).not.toContain('Transactions');
    unmount();

    nav.search = '';
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>child</p>
      </AppShell>,
    );
    const plain = screen.getAllByRole('link', { current: 'page' }).map((el) => el.textContent);
    expect(plain).toContain('Transactions');
    expect(plain).not.toContain('Review');
  });
});

const user = { id: 1, name: 'Ada Lovelace', role: 'member' as const, visibility: 'household' as const };

describe('AppShell mobile menu (regression: opened off-screen at the document top when scrolled)', () => {
  it('anchors the panel to the viewport, not the document, so it stays visible however far the page has scrolled', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const panel = document.getElementById('mobile-nav');
    expect(panel).toBeTruthy();
    // `fixed` (not `absolute`/static) is what keeps the panel pinned to the
    // viewport instead of at its position in the scrolled document.
    expect(panel!.className).toContain('fixed');
    expect(panel!.className).not.toContain('absolute');
  });

  it('locks body scroll while open and restores it on close', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    expect(document.body.style.overflow).toBe('');

    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and returns focus to the toggle button', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    const button = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(button);
    expect(document.getElementById('mobile-nav')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('mobile-nav')).toBeFalsy();
    expect(document.activeElement).toBe(button);
  });

  it('closes on an outside tap', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(document.getElementById('mobile-nav')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(document.getElementById('mobile-nav')).toBeFalsy();
  });

  it('closes when a nav link inside the panel is clicked', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const panel = document.getElementById('mobile-nav') as HTMLElement;
    const link = panel.querySelector('a[href="/budgets"]') as HTMLAnchorElement;
    fireEvent.click(link);

    expect(document.getElementById('mobile-nav')).toBeFalsy();
  });

  it('keeps aria-expanded and aria-controls wired to the toggle button', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('mobile-nav');

    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Help is reachable from the shell', () => {
  it('is the last nav entry, sitting outside the money-flow sequence', () => {
    expect(NAV.at(-1)).toMatchObject({ href: '/help', label: 'Help' });
    // Placed after Settings, not inside the flow -- see the NAV docblock.
    expect(NAV.map((item) => item.href).indexOf('/help')).toBe(NAV.length - 1);
  });

  it('needs no special case in activeNavItem: longest prefix already resolves it', () => {
    expect(activeNavItem('/help')?.href).toBe('/help');
    // No other href is a prefix of /help, so nothing else can win it.
    expect(activeNavItem('/help/anything')?.href).toBe('/help');
  });

  it('renders the Help link in the rail and in the phone menu', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    expect(document.querySelector('aside a[href="/help"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const panel = document.getElementById('mobile-nav') as HTMLElement;
    expect(panel.querySelector('a[href="/help"]')).toBeTruthy();
  });

  it('offers help from the version footer, for a reader who never reads the rail', () => {
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>content</p>
      </AppShell>,
    );

    const footer = document.querySelector('footer') as HTMLElement;
    expect(footer.textContent).toContain('Budget Tracker v1.2.3');
    expect(footer.querySelector('a[href="/help"]')).toBeTruthy();
    // The what's-new link keeps its place; help joins it rather than replacing it.
    expect(footer.querySelector('a[href="/settings"]')).toBeTruthy();
  });
});

// This file has no shared render helper elsewhere; every other test above mounts AppShell
// inline. renderShell() is a local convenience for this describe block only.
function renderShell() {
  return render(
    <AppShell user={user} reviewCount={0} version="1.2.3">
      <p>content</p>
    </AppShell>,
  );
}

describe('v1.12.1: safe-area insets for an installed home-screen app (item AY / UX-11)', () => {
  it('the sticky header clears the status bar', () => {
    const { container } = renderShell();
    expect(container.querySelector('header')?.className).toContain('pt-[env(safe-area-inset-top)]');
  });

  it('the footer clears the home indicator', () => {
    const { container } = renderShell();
    expect(container.querySelector('footer')?.className).toContain('env(safe-area-inset-bottom)');
  });

  it('main clears the rounded corners on both sides', () => {
    const { container } = renderShell();
    const main = container.querySelector('main')?.className ?? '';
    expect(main).toContain('pl-[max(1rem,env(safe-area-inset-left))]');
    expect(main).toContain('pr-[max(1rem,env(safe-area-inset-right))]');
  });

  it('regression (fix round 2): no bare pl-[env(...)]/pr-[env(...)] alongside a shadowed px-4 -- Tailwind v4 orders px-* before pl-*/pr-*, so a separate px-4 loses the padding below sm: on any device without a notch on that axis', () => {
    const { container } = renderShell();
    const main = container.querySelector('main')?.className ?? '';
    expect(main).not.toContain('px-4');
    expect(main).not.toContain('pl-[env(safe-area-inset-left)]');
    expect(main).not.toContain('pr-[env(safe-area-inset-right)]');
  });
});

/**
 * 2026-09-15, `$impeccable critique` priority issue P0: "the nav rail is ten undifferentiated
 * doors." The grouping data lives in nav.ts (tests/components/nav.test.ts covers it); these are
 * the rendering guarantees.
 */
describe('the rail renders the money-flow sequence it always described', () => {
  const renderShell = () =>
    render(
      <AppShell user={user} reviewCount={0} version="1.2.3">
        <p>child</p>
      </AppShell>,
    );

  it('prints the two run labels', () => {
    renderShell();
    expect(screen.getAllByText('This month').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Planning').length).toBeGreaterThan(0);
  });

  /**
   * A screen reader gets the run's name from the list's accessible name, so the visible word is
   * `aria-hidden` -- otherwise the group is announced twice, once as stray text and once as the
   * list label.
   */
  it('names each run to assistive tech without announcing the label twice', () => {
    const { container } = renderShell();
    const lists = [...container.querySelectorAll('ul[aria-label]')].map((ul) => ul.getAttribute('aria-label'));
    expect(lists).toContain('This month');
    expect(lists).toContain('Planning');
    const visible = screen.getAllByText('This month')[0];
    expect(visible.getAttribute('aria-hidden')).toBe('true');
  });

  /** The back office is separated by a rule and carries no words. */
  it('gives the back office a hairline and no label', () => {
    const { container } = renderShell();
    const labels = [...container.querySelectorAll('ul[aria-label]')].map((ul) => ul.getAttribute('aria-label'));
    expect(labels).not.toContain('Other');
    expect(labels).not.toContain('Admin');
    expect(container.querySelector('[data-nav-rule]')).toBeTruthy();
  });

  /** A run label is a caption, never a target: it must not be a link and must not take focus. */
  it('never makes a run label focusable or clickable', () => {
    renderShell();
    const label = screen.getAllByText('This month')[0];
    expect(label.closest('a')).toBeNull();
    expect(label.tagName).toBe('SPAN');
    expect(label.hasAttribute('tabindex')).toBe(false);
  });

  /** Both renderings of the nav -- the desktop rail and the phone panel -- come from one NavList,
   *  so the grouping cannot ship to one and not the other (the CB lesson, PENDING-FIXES). */
  it('groups the phone menu too, not just the rail', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const panel = document.getElementById('mobile-nav') as HTMLElement;
    expect(panel.querySelector('ul[aria-label="This month"]')).toBeTruthy();
    expect(panel.querySelector('ul[aria-label="Planning"]')).toBeTruthy();
  });

  it('still renders every entry, grouped or not', () => {
    renderShell();
    for (const item of NAV) {
      expect(screen.getAllByRole('link', { name: new RegExp(item.label.replace('&', '&')) }).length).toBeGreaterThan(0);
    }
  });
});
