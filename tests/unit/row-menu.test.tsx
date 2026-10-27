// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';

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

describe('v1.58.0: scroll or resize closing the menu', () => {
  it('hands focus back to the trigger when the menu held it', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves focus alone when it was somewhere outside the menu', () => {
    render(
      <>
        <button>Elsewhere</button>
        <RowMenu label="Actions for Card A payment">
          <RowMenuButton onSelect={() => {}}>Rename…</RowMenuButton>
        </RowMenu>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Card A payment' }));
    const outside = screen.getByText('Elsewhere');
    outside.focus();
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

describe('v1.12.1: focus comes back to the trigger (item AW / UX-8)', () => {
  it('refocuses the trigger after a menu button is activated', async () => {
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuButton onSelect={() => {}}>Rename…</RowMenuButton>
      </RowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('refocuses the trigger after a menu form is submitted', async () => {
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuForm action={() => {}} fields={{ id: '1' }}>
          Remove
        </RowMenuForm>
      </RowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('v1.12.1: a destructive menu form asks first (item AU / UX-6, ruling R5)', () => {
  it('does not call the action when the confirmation is refused', async () => {
    const action = vi.fn();
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuForm action={action} fields={{ id: '1' }} confirm="Remove the installment due 2026-06-15?">
          Remove
        </RowMenuForm>
      </RowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    expect(spy).toHaveBeenCalledWith('Remove the installment due 2026-06-15?');
    expect(action).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('calls the action when the confirmation is accepted', async () => {
    const action = vi.fn();
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuForm action={action} fields={{ id: '1' }} confirm="Remove the installment due 2026-06-15?">
          Remove
        </RowMenuForm>
      </RowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    spy.mockRestore();
  });

  it('a form with no confirm prop submits straight away, as it always did', async () => {
    const action = vi.fn();
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuForm action={action} fields={{ id: '1' }}>
          Mark paid
        </RowMenuForm>
      </RowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark paid' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});

describe('v1.12.1: the kebab is finger-sized on a phone (item AV / UX-7)', () => {
  it('the trigger is 44px below sm: and back to 32px at sm:', () => {
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuButton onSelect={() => {}}>Rename…</RowMenuButton>
      </RowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' });
    expect(trigger.className).toContain('h-11');
    expect(trigger.className).toContain('w-11');
    expect(trigger.className).toContain('sm:h-8');
    expect(trigger.className).toContain('sm:w-8');
  });

  it('menu items are py-2.5 with a 44px floor below sm:, reverting at sm:', async () => {
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuButton onSelect={() => {}}>Rename…</RowMenuButton>
      </RowMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' }));
    const item = await screen.findByRole('menuitem', { name: 'Rename…' });
    expect(item.className).toContain('py-2.5');
    expect(item.className).toContain('sm:py-1.5');
    // Fix round 1: py-2.5 text-sm alone renders ~40px, 4px short of the 44px floor -- an
    // explicit min-h-11 (matching the trigger's own h-11) closes that gap; sm:min-h-0 lets
    // desktop fall back to its unconstrained, padding-driven height as before.
    expect(item.className).toContain('min-h-11');
    expect(item.className).toContain('sm:min-h-0');
  });
});

describe('v1.58.0: the whole row as the trigger', () => {
  it('is one button holding the row, named by the label, and the menu opens beside it, not inside it', () => {
    render(
      <RowMenu label="Fix Phonemart, 2026-03-12, -$42.17" row={{ content: <span>Phonemart</span> }}>
        <RowMenuButton onSelect={() => {}}>Change category…</RowMenuButton>
        <RowMenuButton onSelect={() => {}}>Split…</RowMenuButton>
      </RowMenu>,
    );
    const button = screen.getByRole('button', { name: 'Fix Phonemart, 2026-03-12, -$42.17' });
    expect(button.textContent).toContain('Phonemart');
    expect(button.textContent).not.toContain('⋯');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(button.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
  });

  it('is described by the part of the row it names, and Escape hands the key back handled with focus on the row', () => {
    render(
      <RowMenu
        label="Fix Phonemart, 2026-03-12, -$42.17"
        row={{ content: <span id="tag-1">Set by guess</span>, describedBy: 'tag-1' }}
      >
        <RowMenuButton onSelect={() => {}}>Split…</RowMenuButton>
      </RowMenu>,
    );
    const button = screen.getByRole('button', { name: 'Fix Phonemart, 2026-03-12, -$42.17' });
    expect(button.getAttribute('aria-describedby')).toBe('tag-1');
    fireEvent.click(button);
    const notPrevented = fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
  });
});

describe('v1.59.0: a labelled trigger', () => {
  it('is a secondary small button showing the text and a chevron that flips while open, still named by the label', () => {
    render(
      <RowMenu label="Actions for Household" trigger="Actions">
        <RowMenuButton onSelect={() => {}}>Edit limits</RowMenuButton>
      </RowMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Actions for Household' });
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['btn', 'btn--secondary', 'btn--sm']));
    expect(trigger.textContent).toBe('Actions');
    expect(trigger.textContent).not.toContain('⋯');
    const icon = trigger.querySelector('svg')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('class')).not.toContain('rotate-180');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.querySelector('svg')!.getAttribute('class')).toContain('rotate-180');
    expect(screen.getByRole('menuitem', { name: 'Edit limits' })).toBeTruthy();
  });

  it('leaves the kebab and the row trigger as they were', () => {
    render(
      <RowMenu label="Actions for CITY TAX OFFICE">
        <RowMenuButton onSelect={() => {}}>Rename…</RowMenuButton>
      </RowMenu>,
    );
    const kebab = screen.getByRole('button', { name: 'Actions for CITY TAX OFFICE' });
    expect(kebab.textContent).toBe('⋯');
    expect(kebab.className).not.toContain('btn--secondary');
  });
});
