// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BudgetsClient } from '@/app/(app)/budgets/budgets-client';
import { setRolloverAction } from '@/app/(app)/budgets/actions';
import type { BudgetRow } from '@/lib/budgets';

/**
 * v1.7.0 Task 11, deliverable (a): the "Roll over unspent" toggle and the carried-amount
 * display on the Budgets page. Pure client-rendering tests -- no database. The server-side
 * half of the toggle (setRolloverAction's permission checks and its writes) lives in
 * tests/app/budgets-actions.test.ts, next to setLimitAction's own tests, since it already has
 * the real-DB harness these need.
 */

vi.mock('@/app/(app)/budgets/actions', () => ({
  setLimitAction: vi.fn(async () => ({})),
  copyPreviousMonthAction: vi.fn(async () => ({})),
  applySuggestionAction: vi.fn(async () => ({})),
  applyAllSuggestionsAction: vi.fn(async () => ({})),
  // Typed explicitly (not just `async () => ({})`): otherwise vitest infers a zero-arg mock,
  // and `.mock.calls[n][1]` below has no such index under strict mode -- the mock's OWN
  // inferred arity, not the real action's signature, decides that.
  setRolloverAction: vi.fn(async (_prev: unknown, _formData: FormData) => ({})),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    categoryId: 1,
    categoryName: 'Groceries',
    parentId: null,
    isIncome: false,
    isArchived: false,
    limitCents: 20000,
    baseLimitCents: 20000,
    carryCents: 0,
    spentCents: 5000,
    remainingCents: 15000,
    pct: 25,
    overBudget: false,
    children: [],
    ...overrides,
  };
}

function sectionFor(container: HTMLElement, name: string): HTMLElement {
  const section = Array.from(container.querySelectorAll('section')).find((node) =>
    node.querySelector('h2')?.textContent?.startsWith(name),
  );
  if (!section) throw new Error(`no section for ${name}`);
  return section as HTMLElement;
}

describe('rollover toggle — permission (admin, and for a personal budget its own owner)', () => {
  it('a non-admin member does not see the toggle on a household row', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[makeRow({ categoryId: 5 })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(container.textContent).not.toContain('Roll over unspent');
  });

  it('an admin sees the toggle on a household row', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[makeRow({ categoryId: 5 })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(container.textContent).toContain('Roll over unspent');
  });

  it("a personal row's own owner sees the toggle even without admin rights", () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[{ userId: 1, name: 'Alice', rows: [makeRow({ categoryId: 7, categoryName: 'Hobbies' })] }]}
      />,
    );
    expect(sectionFor(container, 'Alice').textContent).toContain('Roll over unspent');
  });

  it("a non-owner, non-admin member does not see the toggle on someone else's personal row", () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[
          { userId: 1, name: 'Alice', rows: [makeRow({ categoryId: 7, categoryName: 'Hobbies' })] },
          { userId: 2, name: 'Bob', rows: [makeRow({ categoryId: 7, categoryName: 'Hobbies' })] },
        ]}
      />,
    );
    expect(sectionFor(container, 'Bob').textContent).not.toContain('Roll over unspent');
  });

  it("an admin sees the toggle on someone else's personal row too", () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[{ userId: 2, name: 'Bob', rows: [makeRow({ categoryId: 7, categoryName: 'Hobbies' })] }]}
      />,
    );
    expect(sectionFor(container, 'Bob').textContent).toContain('Roll over unspent');
  });

  it('an archived row never shows the toggle, even for an admin', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[makeRow({ categoryId: 9, isArchived: true, limitCents: null, remainingCents: null, pct: null })]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(container.textContent).not.toContain('Roll over unspent');
  });
});

describe('rollover toggle — reflects on/off state and submits the right fields', () => {
  it('is unchecked by default when the category id is not in householdRolloverIds', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[makeRow({ categoryId: 5 })]}
        householdRolloverIds={[]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    const checkbox = container.querySelector('input[name="enabled"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(false);
  });

  it('is checked when the category id is in householdRolloverIds, and toggling it submits the right fields', async () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[makeRow({ categoryId: 9 })]}
        householdRolloverIds={[9]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    const checkbox = container.querySelector('input[name="enabled"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // AutoSaveCheckbox has no <form> to read a static FormData from -- it builds one itself,
    // on change, from `fields` plus the control's own name/value. Toggling off then back on
    // exercises both branches: the second save is what carries `enabled`.
    fireEvent.click(checkbox);
    await waitFor(() => expect(vi.mocked(setRolloverAction)).toHaveBeenCalledTimes(1));
    fireEvent.click(checkbox);
    await waitFor(() => expect(vi.mocked(setRolloverAction)).toHaveBeenCalledTimes(2));

    const data = vi.mocked(setRolloverAction).mock.calls[1][1];
    expect(data.get('scope')).toBe('household');
    expect(data.get('month')).toBe('2026-03');
    expect(data.get('categoryId')).toBe('9');
    expect(data.get('userId')).toBe('');
    // A checked checkbox contributes its value; an unchecked one is absent from FormData
    // entirely (the first of the two calls above), which is exactly how setRolloverAction
    // tells the two states apart server-side.
    expect(data.get('enabled')).toBe('on');
  });

  it("a personal row's toggle carries that person's userId, not the viewer's", async () => {
    const { container } = render(
      <BudgetsClient
        month="2026-04"
        currentUserId={1}
        currentUserIsAdmin
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[{ userId: 2, name: 'Bob', rows: [makeRow({ categoryId: 7, categoryName: 'Hobbies' })], rolloverIds: [7] }]}
      />,
    );
    const checkbox = container.querySelector('input[name="enabled"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    await waitFor(() => expect(vi.mocked(setRolloverAction)).toHaveBeenCalledTimes(1));

    const data = vi.mocked(setRolloverAction).mock.calls[0][1];
    expect(data.get('scope')).toBe('personal');
    expect(data.get('userId')).toBe('2');
    expect(data.get('categoryId')).toBe('7');
  });

  it('a rollover row for one child does not check its sibling', () => {
    const parent = makeRow({
      categoryId: 1,
      categoryName: 'Food',
      children: [
        makeRow({ categoryId: 2, categoryName: 'Groceries', parentId: 1 }),
        makeRow({ categoryId: 3, categoryName: 'Coffee', parentId: 1 }),
      ],
    });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[parent]}
        householdRolloverIds={[2]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const groceriesRow = rows.find((r) => r.textContent?.includes('Groceries'));
    const coffeeRow = rows.find((r) => r.textContent?.includes('Coffee'));
    expect((groceriesRow?.querySelector('input[name="enabled"]') as HTMLInputElement).checked).toBe(true);
    expect((coffeeRow?.querySelector('input[name="enabled"]') as HTMLInputElement).checked).toBe(false);
    // v1.15.0 (responsive rows, ruling S3): a child row's indent lives on the same cell that
    // is the phone card's headline, so nesting one level deep must not lose the class.
    expect(groceriesRow?.querySelector('td:first-child')?.className).toContain('cell-stack-headline');
  });
});

describe('carried amount display — "$X plus $Y carried"', () => {
  it('an editable row with a carry shows both figures, base plus carry, next to the input', () => {
    const { container, getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow({ categoryId: 3, baseLimitCents: 50000, carryCents: 12300, limitCents: 62300 })]}
        householdTotals={{ budgetedLimitCents: 62300, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(getByText('$500.00 plus $123.00 carried')).toBeTruthy();
    // The editable field itself still holds the BASE, so an unchanged Save cannot bake the
    // carry into it (see the actions test file for the write-path proof of the same rule).
    const input = container.querySelector('input[name="amount"]') as HTMLInputElement;
    expect(input.defaultValue).toBe('500.00');
  });

  it('a read-only row with a carry shows both figures too, not just the effective total', () => {
    const carrying = makeRow({ categoryId: 7, categoryName: 'Hobbies', baseLimitCents: 15000, carryCents: 5000, limitCents: 20000 });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[
          { userId: 1, name: 'Alice', rows: [carrying] },
          { userId: 2, name: 'Bob', rows: [carrying] },
        ]}
      />,
    );
    // Bob's row is read-only for a non-admin viewer who is not Bob.
    expect(sectionFor(container, 'Bob').textContent).toContain('$150.00 plus $50.00 carried');
    expect(sectionFor(container, 'Bob').textContent).not.toContain('$200.00 · read-only');
  });

  it('a row with no carry looks exactly as it did before this feature', () => {
    const { container, queryByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow({ categoryId: 4 })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(queryByText(/carried/)).toBeNull();
    const input = container.querySelector('input[name="amount"]') as HTMLInputElement;
    expect(input.defaultValue).toBe('200.00');
  });

  it('an archived row with a carry still shows the breakdown text (display needs no edit permission)', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin
        household={[
          makeRow({ categoryId: 11, isArchived: true, baseLimitCents: 30000, carryCents: 7000, limitCents: 37000 }),
        ]}
        householdRolloverIds={[11]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(container.textContent).toContain('$300.00 plus $70.00 carried');
  });
});
