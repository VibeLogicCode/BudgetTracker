// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { TransactionsClient } from '@/app/(app)/transactions/transactions-client';
import type { TransactionPage, TransactionRow } from '@/lib/transactions';
import type { SplitRow } from '@/lib/splits';

vi.mock('@/app/(app)/transactions/actions', () => ({
  manualEntryAction: vi.fn(async () => ({})),
  setCategoryAction: vi.fn(async () => ({})),
  setAttributionAction: vi.fn(async () => ({})),
  bulkCategorizeAction: vi.fn(async () => ({})),
  bulkTransferAction: vi.fn(async () => ({})),
  renameTransactionAction: vi.fn(async () => ({})),
  assignToLoanAction: vi.fn(async () => ({})),
  unassignFromLoanAction: vi.fn(async () => ({})),
  saveSplitsAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function pageWithRow(overrides: Partial<TransactionRow> = {}): TransactionPage {
  const row: TransactionRow = {
    id: 1,
    date: '2026-03-02',
    accountId: 1,
    accountName: 'Joint Chequing',
    rawDescription: 'TIM HORTONS',
    displayDescription: null,
    displaySource: null,
    normalizedMerchant: 'TIM HORTONS',
    amountCents: -500,
    categoryId: 42,
    categoryName: 'Old Category',
    source: 'manual',
    confidence: null,
    isTransfer: false,
    attributedUserId: null,
    attributedUserName: null,
    notes: null,
    importId: null,
    ...overrides,
  };
  return { total: 1, page: 1, pageSize: 50, pageCount: 1, rows: [row] };
}

describe('TransactionsClient — archived-category silent-clear hazard', () => {
  it("renders an archived category's own label on its row instead of falling back to Uncategorized", () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[{ id: 42, name: 'Old Category', parentId: null, isArchived: true }]}
        people={[]}
        today="2026-03-02"
      />,
    );

    const rowSelect = container.querySelector('tbody select[name="categoryId"]') as HTMLSelectElement;
    expect(rowSelect).toBeTruthy();
    // The archived category must be a real <option> so the browser's initial selection
    // actually lands on it, instead of silently falling back to the first option
    // ("Uncategorized", value "") because no option matched defaultValue.
    expect(rowSelect.value).toBe('42');
    const selectedOption = rowSelect.querySelector('option[value="42"]');
    expect(selectedOption?.textContent).toContain('Old Category');
    expect(selectedOption?.hasAttribute('disabled')).toBe(true);
  });

  it('saving the row without changing the selection would resubmit the same archived category, not clear it', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[{ id: 42, name: 'Old Category', parentId: null, isArchived: true }]}
        people={[]}
        today="2026-03-02"
      />,
    );

    const rowForm = container.querySelector('tbody select[name="categoryId"]')!.closest('form') as HTMLFormElement;
    const rowSelect = rowForm.elements.namedItem('categoryId') as HTMLSelectElement;
    // Simulate reading the form exactly as a real submit would, without ever touching the select.
    const submittedValue = new FormData(rowForm).get('categoryId');
    expect(submittedValue).toBe('42');
    expect(rowSelect.value).not.toBe('');
  });

  it('excludes archived categories from the filter, bulk-categorize and manual-entry pickers', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[
          { id: 42, name: 'Old Category', parentId: null, isArchived: true },
          { id: 7, name: 'Coffee', parentId: null, isArchived: false },
        ]}
        people={[]}
        today="2026-03-02"
      />,
    );

    const filterSelect = container.querySelector('form[method="get"] select[name="category"]') as HTMLSelectElement;
    expect(filterSelect.querySelector('option[value="42"]')).toBeNull();
    expect(filterSelect.querySelector('option[value="7"]')).not.toBeNull();

    const manualForm = Array.from(container.querySelectorAll('form')).find((f) => f.querySelector('input[name="description"]'))!;
    const manualCategorySelect = manualForm.querySelector('select[name="categoryId"]') as HTMLSelectElement;
    expect(manualCategorySelect.querySelector('option[value="42"]')).toBeNull();
    expect(manualCategorySelect.querySelector('option[value="7"]')).not.toBeNull();
  });
});

describe('Create warranty row action (§11)', () => {
  it('links a normal row to the add form carrying only the transaction id', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ id: 77 })} accounts={[]} categories={[]} people={[]} today="2026-08-16" />,
    );
    const link = container.querySelector('a[href="/warranties/new?transactionId=77"]');
    expect(link).toBeTruthy();
    expect(link!.textContent).toMatch(/create warranty/i);
  });

  it('hides the action on a transfer row (MUST-11.2)', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 78, isTransfer: true })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
      />,
    );
    expect(container.querySelector('a[href="/warranties/new?transactionId=78"]')).toBeNull();
  });

  it('carries no field values in the URL — prefill is computed server-side (MUST-11.3)', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 79, amountCents: -129999, rawDescription: 'HOME DEPOT' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
      />,
    );
    const href = container.querySelector('a[href^="/warranties/new"]')!.getAttribute('href')!;
    expect(href).toBe('/warranties/new?transactionId=79');
    expect(href).not.toContain('amount');
    expect(href).not.toContain('vendor');
    expect(href).not.toContain('date');
  });
});

describe('MUST-14.8 / MUST-14.9: the row control', () => {
  const linkedRowId = 1; // matches pageWithRow()'s default row id
  const baseProps = {
    page: pageWithRow(),
    accounts: [{ id: 1, name: 'Joint Chequing' }],
    categories: [],
    people: [],
    today: '2026-03-02',
  };
  const transferOnlyProps = { ...baseProps, page: pageWithRow({ isTransfer: true }) };

  it('with no loans, the assign control is absent entirely', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    expect(screen.queryByText('Assign to loan…')).toBeNull();
    expect(screen.queryByText('Assign')).toBeNull();
  });

  it('a linked row shows the link and Unassign, AND keeps the assign select reachable (F4 fix-round)', () => {
    // F4: the select used to disappear entirely once a row had a link, which made the
    // over-link warn path (MUST-14.10) unreachable from the UI. It must stay visible.
    render(
      <TransactionsClient
        {...baseProps}
        loanOptions={[{ id: 7, name: 'Civic' }]}
        loanLinks={{
          [linkedRowId]: [
            { id: 1, txnId: linkedRowId, itemId: 7, itemName: 'Civic', amountCents: 45000, appliedCents: 45000, source: 'manual' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Unassign')).toBeTruthy();
    // "Civic" appears twice now -- the link's own name, and the (still-visible) select's
    // option -- so this is an AllBy, not a plain getByText.
    expect(screen.getAllByText('Civic').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Assign to loan…')).toBeTruthy();
  });

  it('renders every link on a row, each with its own Unassign (F4 fix-round: a combined payment)', () => {
    render(
      <TransactionsClient
        {...baseProps}
        loanOptions={[{ id: 7, name: 'Civic' }, { id: 9, name: 'Boat' }]}
        loanLinks={{
          [linkedRowId]: [
            { id: 1, txnId: linkedRowId, itemId: 7, itemName: 'Civic', amountCents: 45000, appliedCents: 45000, source: 'manual' },
            { id: 2, txnId: linkedRowId, itemId: 9, itemName: 'Boat', amountCents: 45000, appliedCents: 45000, source: 'manual' },
          ],
        }}
      />,
    );
    expect(screen.getAllByText('Unassign')).toHaveLength(2);
    expect(screen.getByText('Boat', { selector: 'span.text-xs' })).toBeTruthy();
  });

  it('an unlinked row renders the select when there ARE loans', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    expect(screen.getByText('Assign to loan…')).toBeTruthy();
    expect(screen.getByText('Civic')).toBeTruthy();
  });

  it('a transfer row renders neither control', () => {
    render(<TransactionsClient {...transferOnlyProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    expect(screen.queryByText('Assign to loan…')).toBeNull();
    expect(screen.queryByText('Unassign')).toBeNull();
  });
});

describe('Split editor (v1.7.0 Task 4)', () => {
  const categories = [
    { id: 42, name: 'Old Category', parentId: null, isArchived: false },
    { id: 7, name: 'Coffee', parentId: null, isArchived: false },
  ];

  const splitRows: SplitRow[] = [
    { id: 501, txnId: 1, categoryId: 42, amountCents: -300, note: 'half' },
    { id: 502, txnId: 1, categoryId: 7, amountCents: -200, note: null },
  ];

  function twoRowPage(): TransactionPage {
    const a = pageWithRow({ id: 1, amountCents: -500 }).rows[0];
    const b = pageWithRow({ id: 2, amountCents: -700 }).rows[0];
    return { total: 2, page: 1, pageSize: 50, pageCount: 1, rows: [a, b] };
  }

  it('shows a "Split · N parts" badge instead of the category select for a split row', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );
    expect(screen.getByText('Split · 2 parts')).toBeTruthy();
    expect(container.querySelector('tbody select[name="categoryId"]')).toBeNull();
  });

  it('a row with no split still shows the ordinary category select, not a badge', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{}}
      />,
    );
    expect(screen.queryByText(/Split ·/)).toBeNull();
    expect(container.querySelector('tbody select[name="categoryId"]')).toBeTruthy();
  });

  it('opens the editor prefilled from the existing split parts', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, amountCents: -500 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split transaction 1' }));

    const categorySelects = screen.getAllByLabelText(/Category for part/) as HTMLSelectElement[];
    expect(categorySelects.map((s) => s.value)).toEqual(['42', '7']);

    const amountInputs = screen.getAllByLabelText(/Amount for part/) as HTMLInputElement[];
    expect(amountInputs.map((i) => i.value)).toEqual(['3.00', '2.00']);

    const noteInputs = screen.getAllByLabelText(/Note for part/) as HTMLInputElement[];
    expect(noteInputs.map((i) => i.value)).toEqual(['half', '']);
  });

  it('disables Save until the remainder is exactly zero, then enables it', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, amountCents: -5000 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split transaction 1' }));

    const saveButton = screen.getByRole('button', { name: 'Save split' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const categorySelects = screen.getAllByLabelText(/Category for part/) as HTMLSelectElement[];
    const amountInputs = screen.getAllByLabelText(/Amount for part/) as HTMLInputElement[];

    fireEvent.change(categorySelects[0], { target: { value: '42' } });
    fireEvent.change(amountInputs[0], { target: { value: '30.00' } });
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(categorySelects[1], { target: { value: '7' } });
    fireEvent.change(amountInputs[1], { target: { value: '20.00' } });
    expect(saveButton.disabled).toBe(false);
  });

  it('only one row editor is open at a time', () => {
    const { container } = render(
      <TransactionsClient
        page={twoRowPage()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Split transaction 1' }));
    expect(screen.getAllByText('Split this transaction')).toHaveLength(1);
    expect((container.querySelector('input[name="txnId"]') as HTMLInputElement).value).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Split transaction 2' }));
    expect(screen.getAllByText('Split this transaction')).toHaveLength(1);
    const txnIdInputs = Array.from(container.querySelectorAll('input[name="txnId"]')) as HTMLInputElement[];
    expect(txnIdInputs.length).toBeGreaterThan(0);
    expect(txnIdInputs.every((input) => input.value === '2')).toBe(true);
  });
});

/**
 * Adversarial-review fix (2026-08-22), requirement (c): bulkSetCategory/bulkSetTransfer now
 * skip a split row (see src/lib/categorize/engine.ts's guard on confirmCategory/
 * setTransferFlag), but selection itself must stay open to a split row -- bulk ATTRIBUTION is
 * still legitimate on one (ruling 1: attribution is whole-transaction), and disabling the
 * checkbox would block that valid operation along with the two it should actually skip. These
 * tests prove the checkbox and the attribution controls are untouched, and that the toolbar
 * only ever adds a cheap heads-up, never a block.
 */
describe('Bulk toolbar and a split row (v1.7.0 bulk-guard fix, requirement c)', () => {
  const splitRows: SplitRow[] = [
    { id: 501, txnId: 1, categoryId: 42, amountCents: -300, note: null },
    { id: 502, txnId: 1, categoryId: 7, amountCents: -200, note: null },
  ];

  it('the row checkbox for a split transaction is never disabled', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );
    const checkbox = screen.getByLabelText('Select transaction 1') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
  });

  it('selecting a split row still works and opens the bulk toolbar, including bulk Attribute', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select transaction 1'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    // Bulk attribution is still offered -- attribution stays legitimate on a split row.
    expect(screen.getByRole('button', { name: 'Attribute' })).toBeTruthy();
    // Categorize and Mark transfer are ALSO still offered (they skip, not block).
    expect(screen.getByRole('button', { name: 'Categorize' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark transfer' })).toBeTruthy();
  });

  it('warns in the toolbar that a selected split row will be skipped by Categorize and Mark transfer', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select transaction 1'));
    expect(screen.getByText(/split and will be skipped/i)).toBeTruthy();
  });

  it('does not warn when the selected row has no split', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        splits={{}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select transaction 1'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(screen.queryByText(/split and will be skipped/i)).toBeNull();
  });

  it('the per-row attribution select and Save button still render for a split row', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[{ id: 9, name: 'Bob' }]}
        today="2026-03-02"
        splits={{ 1: splitRows }}
      />,
    );
    const attributionSelect = container.querySelector('tbody select[name="attributedUserId"]');
    expect(attributionSelect).toBeTruthy();
    expect(attributionSelect!.closest('form')).toBeTruthy();
  });
});
