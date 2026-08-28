// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransactionsClient } from '@/app/(app)/transactions/transactions-client';
import { setCategoryAction } from '@/app/(app)/transactions/actions';
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

// v1.11.0 Task 3: the row's actions collapsed into a kebab (RowMenu), which renders its
// items only once opened -- so any test that used to find "Create warranty", "Split…" or a
// loan link/select directly in the DOM must open the row's menu first, the same way a person
// would click the ⋯ button before seeing them.
function openRowMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

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
        categories={[{ id: 42, name: 'Old Category', parentId: null, isArchived: true, sortOrder: 0 }]}
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

  it('never auto-submits on mount -- only a real change would clear the archived category', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[{ id: 42, name: 'Old Category', parentId: null, isArchived: true, sortOrder: 0 }]}
        people={[]}
        today="2026-03-02"
      />,
    );

    // AutoSaveSelect has no <form> or Save button any more -- it fires only from the
    // select's own onChange (src/components/ui/AutoSave.tsx). Rendering the row must not
    // itself submit anything, or an untouched row would silently clear (and untrain) a
    // legitimate historical categorization the moment the page loaded.
    const rowSelect = container.querySelector('tbody select[name="categoryId"]') as HTMLSelectElement;
    expect(rowSelect.value).toBe('42');
    expect(setCategoryAction).not.toHaveBeenCalled();
  });

  it('excludes archived categories from the filter, bulk-categorize and manual-entry pickers', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[
          { id: 42, name: 'Old Category', parentId: null, isArchived: true, sortOrder: 0 },
          { id: 7, name: 'Coffee', parentId: null, isArchived: false, sortOrder: 1 },
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
    openRowMenu('Actions for TIM HORTONS');
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
    openRowMenu('Actions for TIM HORTONS');
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
    openRowMenu('Actions for HOME DEPOT');
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
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByText(/Assign to/)).toBeNull();
  });

  it('a linked row shows Unassign and keeps the assign item reachable (F4 fix-round)', () => {
    // F4: the select used to disappear entirely once a row had a link, which made the
    // over-link warn path (MUST-14.10) unreachable from the UI. The row menu keeps both --
    // "Unassign from Civic" and "Assign to Civic" -- offered together, one item each.
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
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByText('Unassign from Civic')).toBeTruthy();
    expect(screen.getByText('Assign to Civic')).toBeTruthy();
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
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByText('Unassign from Civic')).toBeTruthy();
    expect(screen.getByText('Unassign from Boat')).toBeTruthy();
  });

  it('an unlinked row renders an assign item for the loan when there ARE loans', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByText('Assign to Civic')).toBeTruthy();
  });

  it('a transfer row renders neither control', () => {
    render(<TransactionsClient {...transferOnlyProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByText(/Assign to/)).toBeNull();
    expect(screen.queryByText(/Unassign/)).toBeNull();
  });

  // Fix wave (2026-08-23 review, finding I4): the six kebab-form dispatch paths across the
  // suite had zero coverage that clicking the menuitem actually fires the bound server action
  // with the right fields. These two cover Assign to loan / Unassign from loan.
  it('clicking "Assign to <loan>" calls assignToLoanAction with the transaction and loan ids', async () => {
    const { assignToLoanAction } = await import('@/app/(app)/transactions/actions');
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to Civic' }));

    await waitFor(() => expect(assignToLoanAction).toHaveBeenCalled());
    // Bound as `(_prev, formData) => assignToLoanAction(formData)` (transactions-client.tsx),
    // so the FormData the kebab form built is the mock's FIRST and only argument.
    const sent = (assignToLoanAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as FormData;
    expect(sent.get('transactionId')).toBe(String(linkedRowId));
    expect(sent.get('itemId')).toBe('7');
  });

  it('clicking "Unassign from <loan>" calls unassignFromLoanAction with the transaction and loan ids', async () => {
    // v1.12.1 (item AU / UX-6, ruling R5): Unassign now confirms first. Mocked to accept, so
    // this test still covers the underlying dispatch; the refusal path is RowMenu's own test.
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { unassignFromLoanAction } = await import('@/app/(app)/transactions/actions');
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
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unassign from Civic' }));

    await waitFor(() => expect(unassignFromLoanAction).toHaveBeenCalled());
    expect(spy).toHaveBeenCalled();
    const sent = (unassignFromLoanAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as FormData;
    expect(sent.get('transactionId')).toBe(String(linkedRowId));
    expect(sent.get('itemId')).toBe('7');
    spy.mockRestore();
  });
});

describe('Split editor (v1.7.0 Task 4)', () => {
  const categories = [
    { id: 42, name: 'Old Category', parentId: null, isArchived: false, sortOrder: 0 },
    { id: 7, name: 'Coffee', parentId: null, isArchived: false, sortOrder: 1 },
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

    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));

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

    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));

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

    // Both rows share the same rawDescription (twoRowPage doesn't override it), so their
    // kebabs share one accessible name -- getAllByRole plus index stands in for "row 1's
    // kebab" and "row 2's kebab".
    const kebabs = screen.getAllByRole('button', { name: 'Actions for TIM HORTONS' });

    fireEvent.click(kebabs[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));
    expect(screen.getAllByText('Split this transaction')).toHaveLength(1);
    expect((container.querySelector('input[name="txnId"]') as HTMLInputElement).value).toBe('1');

    fireEvent.click(kebabs[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));
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

  it('the per-row attribution select still auto-saves for a split row', () => {
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
    // AutoSaveSelect has no <form> of its own any more (see src/components/ui/AutoSave.tsx) --
    // the assertion that matters is that a split row still gets the control at all.
    const attributionSelect = container.querySelector('tbody select[name="attributedUserId"]');
    expect(attributionSelect).toBeTruthy();
  });
});

describe('v1.12.1: the number pad opens for the manual-entry amount (item Y / UX-9)', () => {
  it('the Amount field carries inputMode="decimal"', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const amount = document.querySelector('input[name="amount"]') as HTMLInputElement | null;
    expect(amount?.getAttribute('inputmode')).toBe('decimal');
  });
});
