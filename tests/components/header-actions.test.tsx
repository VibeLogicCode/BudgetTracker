// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HeaderActions } from '@/components/ui/HeaderActions';

afterEach(() => cleanup());

const classesOf = (element: Element) => element.className.split(/\s+/);

describe('HeaderActions (v1.59.0 item 10)', () => {
  it('one action is one secondary small button at every width, with no menu', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <HeaderActions menuLabel="Actions for Sam" actions={[{ key: 'edit', label: 'Edit limits', onSelect }]} />,
    );
    const button = screen.getByRole('button', { name: 'Edit limits' });
    expect(classesOf(button)).toEqual(expect.arrayContaining(['btn', 'btn--secondary', 'btn--sm']));
    expect(classesOf(button)).not.toContain('sm:flex');
    expect(button.closest('.hidden')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Sam' })).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('several actions are a desktop row of one style and a phone menu holding the same actions', async () => {
    const copy = vi.fn();
    const onEdit = vi.fn();
    render(
      <HeaderActions
        menuLabel="Actions for Household"
        actions={[
          { key: 'copy', label: 'Copy previous month', title: 'Also brings forward the savings target.', action: copy, fields: { scope: 'household', month: '2026-05' } },
          { key: 'edit', label: 'Edit limits', onSelect: onEdit },
        ]}
      />,
    );
    const copyButton = screen.getByRole('button', { name: 'Copy previous month' });
    const editButton = screen.getByRole('button', { name: 'Edit limits' });
    expect(copyButton.className).toBe(editButton.className);
    expect(classesOf(copyButton)).toEqual(expect.arrayContaining(['btn', 'btn--secondary', 'btn--sm']));
    expect(copyButton.getAttribute('title')).toBe('Also brings forward the savings target.');
    const row = copyButton.parentElement!.closest('div')!;
    expect(classesOf(row)).toEqual(expect.arrayContaining(['hidden', 'sm:flex']));

    const trigger = screen.getByRole('button', { name: 'Actions for Household' });
    expect(trigger.textContent).toBe('Actions');
    expect(classesOf(trigger.closest('div')!)).toContain('sm:hidden');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Actions for Household' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy previous month', 'Edit limits']);

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy previous month' }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    const posted = copy.mock.calls[0][0] as FormData;
    expect(Object.fromEntries(posted.entries())).toEqual({ scope: 'household', month: '2026-05' });
  });

  it('each action keeps its title as the tooltip in the phone menu too, its name unchanged', () => {
    render(
      <HeaderActions
        menuLabel="Actions for Household"
        actions={[
          { key: 'copy', label: 'Copy previous month', title: 'Also brings forward the savings target.', action: vi.fn(), fields: { month: '2026-05' } },
          { key: 'fill', label: 'Fill from suggestions', title: 'Uses the last three full months.', onSelect: vi.fn() },
          { key: 'edit', label: 'Edit limits', onSelect: vi.fn() },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Household' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Household' });
    expect(within(menu).getByRole('menuitem', { name: 'Copy previous month' }).getAttribute('title')).toBe('Also brings forward the savings target.');
    expect(within(menu).getByRole('menuitem', { name: 'Fill from suggestions' }).getAttribute('title')).toBe('Uses the last three full months.');
    expect(within(menu).getByRole('menuitem', { name: 'Edit limits' }).hasAttribute('title')).toBe(false);
  });

  it('the desktop form posts the same fields, and a menu button runs its handler', async () => {
    const copy = vi.fn();
    const onEdit = vi.fn();
    render(
      <HeaderActions
        menuLabel="Actions for Alex"
        actions={[
          { key: 'copy', label: 'Copy previous month', action: copy, fields: { scope: 'personal', userId: '7', month: '2026-05' } },
          { key: 'edit', label: 'Edit limits', onSelect: onEdit },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy previous month' }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries((copy.mock.calls[0][0] as FormData).entries())).toEqual({ scope: 'personal', userId: '7', month: '2026-05' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Alex' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit limits' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for no actions', () => {
    const { container } = render(<HeaderActions menuLabel="Actions for Sam" actions={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
