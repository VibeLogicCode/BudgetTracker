// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react';
import { SplitDialog } from '@/components/transactions/SplitDialog';

afterEach(cleanup);

/** v1.57.2: the dialog takes the categories themselves and builds each part's list (categoryOptions). */
const CATEGORIES = [
  { id: 1, name: 'Groceries', parentId: null, sortOrder: 0, isArchived: false },
  { id: 2, name: 'Phone', parentId: null, sortOrder: 1, isArchived: false },
];

describe('SplitDialog', () => {
  it('posts the whole transaction id and the parts it was given through the action handed to it, then closes', () => {
    const action = vi.fn();
    const onClose = vi.fn();
    render(
      <SplitDialog
        target={{ id: 77, merchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217 }}
        existing={[
          { id: 501, txnId: 77, categoryId: 1, amountCents: -2000, note: null },
          { id: 502, txnId: 77, categoryId: 2, amountCents: -2217, note: 'the case' },
        ]}
        categories={CATEGORIES}
        action={action}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: /^Split PHONEMART 884/ })).toBeTruthy();
    expect(screen.getByText('Remaining to assign: $0.00')).toBeTruthy();
    const form = screen.getByRole('button', { name: 'Save split' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(onClose).toHaveBeenCalled();
    const data = new FormData(form);
    expect(data.get('txnId')).toBe('77');
    expect(JSON.parse(String(data.get('parts')))).toEqual([
      { categoryId: 1, amountCents: -2000, note: null },
      { categoryId: 2, amountCents: -2217, note: 'the case' },
    ]);
  });

  it('opens two blank parts for an unsplit row and keeps Save disabled until the parts add up', () => {
    render(
      <SplitDialog
        target={{ id: 78, merchant: 'MAPLE GROCER', date: '2026-03-14', amountCents: -5000 }}
        existing={[]}
        categories={CATEGORIES}
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Save split' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SplitDialog: a part on an archived category (v1.57.2)', () => {
  const categories = [
    ...CATEGORIES,
    { id: 3, name: 'Lanterns', parentId: null, sortOrder: 2, isArchived: true },
    { id: 4, name: 'Ferries', parentId: null, sortOrder: 3, isArchived: true },
  ];

  it("shows the part's own archived category, disabled, and no other archived one in any part", () => {
    render(
      <SplitDialog
        target={{ id: 79, merchant: 'HARBOUR LAMPS', date: '2026-03-16', amountCents: -3000 }}
        existing={[
          { id: 601, txnId: 79, categoryId: 3, amountCents: -1000, note: null },
          { id: 602, txnId: 79, categoryId: 1, amountCents: -2000, note: null },
        ]}
        categories={categories}
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const [first, second] = screen.getAllByRole('combobox') as HTMLInputElement[];
    expect(first.value).toBe('Lanterns (archived)');
    fireEvent.focus(first);
    const archived = screen.getAllByRole('option').filter((node) => (node.textContent ?? '').includes('(archived)'));
    expect(archived.map((node) => [node.textContent, node.getAttribute('aria-disabled')])).toEqual([['Lanterns (archived)', 'true']]);
    fireEvent.focus(second);
    const secondList = document.getElementById(second.getAttribute('aria-controls')!) as HTMLElement;
    expect(within(secondList).getAllByRole('option').some((node) => (node.textContent ?? '').includes('(archived)'))).toBe(false);
  });
});
