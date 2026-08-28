// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from '@/components/app-shell/AppShell';
import { activeNavItem, NAV } from '@/components/app-shell/nav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

const user = { name: 'Ada Lovelace', role: 'member' as const };

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
