// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RowMenu, RowMenuButton } from '@/components/ui/RowMenu';

afterEach(() => cleanup());

function renderMenu(onSplit = vi.fn(), onRename = vi.fn()) {
  render(
    <RowMenu label="Actions for Card A payment">
      <RowMenuButton onSelect={onRename}>Rename…</RowMenuButton>
      <RowMenuButton onSelect={onSplit}>Split…</RowMenuButton>
    </RowMenu>,
  );
  return screen.getByRole('button', { name: 'Actions for Card A payment' });
}

describe('RowMenu', () => {
  it('opens on click, tracks aria-expanded, and focuses the first item', () => {
    const trigger = renderMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Rename…', 'Split…']);
    expect(document.activeElement).toBe(items[0]);
  });

  it('is positioned fixed, not absolute — an absolute menu is clipped by the table wrapper', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.style.position).toBe('fixed');
    expect(menu.className).not.toContain('absolute');
  });

  it('moves focus with the arrow keys and jumps with Home/End', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside pointer down', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the item handler and closes when an item is chosen', () => {
    const onSplit = vi.fn();
    const trigger = renderMenu(onSplit);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));

    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps only one menu open at a time', () => {
    render(
      <>
        <RowMenu label="Actions for row one">
          <RowMenuButton onSelect={vi.fn()}>One</RowMenuButton>
        </RowMenu>
        <RowMenu label="Actions for row two">
          <RowMenuButton onSelect={vi.fn()}>Two</RowMenuButton>
        </RowMenu>
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for row one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for row two' }));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem').textContent).toBe('Two');
  });
});
