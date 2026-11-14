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
    // No `people` (the default, null): an editor that cannot choose a person keeps each stored part's.
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
      { categoryId: 1, amountCents: -2000, note: null, person: 'keep', splitId: 501 },
      { categoryId: 2, amountCents: -2217, note: 'the case', person: 'keep', splitId: 502 },
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

describe('SplitDialog: a part belongs to a person (v1.63.0)', () => {
  const PEOPLE = [
    { id: 4, name: 'Alex' },
    { id: 5, name: 'Sam' },
  ];
  const existing = [
    { id: 1, txnId: 9, categoryId: 1, amountCents: -8000, note: null, personSet: false, attributedUserId: null },
    { id: 2, txnId: 9, categoryId: 2, amountCents: -4000, note: null, personSet: true, attributedUserId: 5 },
    { id: 3, txnId: 9, categoryId: 1, amountCents: -3000, note: null, personSet: true, attributedUserId: null },
  ];
  const open = (people: typeof PEOPLE | null, rows = existing) =>
    render(
      <SplitDialog
        target={{ id: 9, merchant: 'MAPLE GROCER', date: '2026-03-09', amountCents: -15000 }}
        existing={rows}
        categories={CATEGORIES}
        people={people}
        parentPersonName="Alex"
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  const posted = () => {
    const form = screen.getByRole('button', { name: 'Save split' }).closest('form') as HTMLFormElement;
    return JSON.parse(String(new FormData(form).get('parts'))) as { person: unknown }[];
  };

  it('renders a person select per part with the three kinds of choice, seeded from the stored parts', () => {
    open(PEOPLE);
    const first = screen.getByRole('combobox', { name: 'Person for part 1' }) as HTMLSelectElement;
    expect(within(first).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Same as the transaction (Alex)',
      'Household',
      'Alex',
      'Sam',
    ]);
    expect(first.value).toBe('follow');
    expect((screen.getByRole('combobox', { name: 'Person for part 2' }) as HTMLSelectElement).value).toBe('5');
    expect((screen.getByRole('combobox', { name: 'Person for part 3' }) as HTMLSelectElement).value).toBe('household');
  });

  it('posts follow, household and an id', () => {
    open(PEOPLE);
    expect(posted().map((p) => p.person)).toEqual(['follow', 5, 'household']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Person for part 1' }), { target: { value: '4' } });
    expect(posted()[0].person).toBe(4);
  });

  it("shows no person select when people is null, and keeps every stored part's person (fix round)", () => {
    open(null);
    expect(screen.queryByRole('combobox', { name: /^Person for part/ })).toBeNull();
    // Each stored part asks to keep the person it has, by its own id; nothing is reset to follow.
    expect(posted().map((p) => [p.person, (p as { splitId?: unknown }).splitId])).toEqual([
      ['keep', 1],
      ['keep', 2],
      ['keep', 3],
    ]);
  });

  it('a part added in an editor with no person select follows the transaction', () => {
    open(null, []);
    expect(screen.queryByRole('combobox', { name: /^Person for part/ })).toBeNull();
    const [first, second] = screen.getAllByRole('combobox') as HTMLInputElement[];
    for (const [field, label] of [[first, 'Groceries'], [second, 'Phone']] as const) {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: label } });
      fireEvent.mouseDown(screen.getAllByRole('option').find((node) => node.textContent === label)!);
    }
    expect(posted()).toEqual([
      { categoryId: 1, amountCents: 0, note: null, person: 'follow' },
      { categoryId: 2, amountCents: 0, note: null, person: 'follow' },
    ]);
  });
});
