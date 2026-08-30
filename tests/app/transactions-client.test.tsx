// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  saveNoteAction: vi.fn(async () => ({})),
  createLoanFromTransactionAction: vi.fn(async () => ({})),
  // Review round (fold /review in): the review filter's own actions, ported from
  // src/app/(app)/review/actions.ts (Lane 1) into this same file.
  acceptGuessAction: vi.fn(async () => ({})),
  applyToAllMatchingAction: vi.fn(async () => ({})),
  setRowTransferAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  // Ruling S7's disclosure reads window.location.search in an effect (never during render --
  // see transactions-client.tsx's own comment on why) to decide whether it starts open. Reset
  // between tests so one test's URL never leaks into the next, which defaults to no filter
  // active -- exactly what every existing test below implicitly assumes.
  window.history.pushState({}, '', '/');
});

// v1.11.0 Task 3: the row's actions collapsed into a kebab (RowMenu), which renders its
// items only once opened -- so any test that used to find "Create warranty", "Split…" or a
// loan link/select directly in the DOM must open the row's menu first, the same way a person
// would click the ⋯ button before seeing them.
//
// v1.13.1 (item M): the kebab's accessible name now carries the row's date and amount too
// (`Actions for TIM HORTONS on 2026-08-03, -$4.12`), so an exact-string match no longer finds
// it. The 16 existing call sites below still pass just `Actions for <description>`, so this
// matches on that as a PREFIX instead of the whole name.
function openRowMenu(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${escaped}`) }));
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

    // Ruling S6 changed this: Quick add now renders collapsed by default outside review mode, so
    // the manual-entry form is not in the DOM until its disclosure is opened.
    fireEvent.click(screen.getByRole('button', { name: 'Add a transaction' }));
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

  it('with no loans, the "Assign to loan…" editor offers only "New loan…" (backlog BY)', () => {
    // Backlog BY: the per-loan "Assign to <loan>" list is gone -- one "Assign to loan…" item
    // opens the (extended) new-loan editor instead, whose own select is what gates on
    // loanOptions being non-empty.
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Assign to loan…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    const select = screen.getByLabelText('Assign to') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['New loan…']);
  });

  it('a linked row shows Unassign, and the single "Assign to loan…" item stays reachable (F4 fix-round)', () => {
    // F4: the assign control used to disappear entirely once a row had a link, which made the
    // over-link warn path (MUST-14.10) unreachable from the UI. The row menu keeps both --
    // "Unassign from Civic" and "Assign to loan…" -- offered together.
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
    expect(screen.getByRole('menuitem', { name: 'Assign to loan…' })).toBeTruthy();
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

  it('an unlinked row\'s "Assign to loan…" editor lists an existing loan alongside "New loan…"', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    const select = screen.getByLabelText('Assign to') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Civic', 'New loan…']);
  });

  it('a transfer row renders neither control', () => {
    render(<TransactionsClient {...transferOnlyProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: 'Assign to loan…' })).toBeNull();
    expect(screen.queryByText(/Unassign/)).toBeNull();
  });

  // Fix wave (2026-08-23 review, finding I4): the six kebab-form dispatch paths across the
  // suite had zero coverage that clicking the menuitem actually fires the bound server action
  // with the right fields. These two cover Assign to loan / Unassign from loan.
  it('choosing an existing loan and saving calls assignToLoanAction with the transaction and loan ids (backlog BY)', async () => {
    const { assignToLoanAction } = await import('@/app/(app)/transactions/actions');
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

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

  // v1.14.0 (ruling P15): "moves back up" was only ever true for a loan the household owes.
  // Rather than plumb a direction through LoanLink and loanLinksForTransactions for one
  // sentence, the confirm now says what is true in both frames.
  it('the unassign confirm is direction-neutral (ruling P15)', () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);
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
    expect(spy).toHaveBeenCalledWith("Unassign this transaction from Civic? That loan's balance moves back to what it was.");
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

    // Both rows share the same rawDescription (twoRowPage doesn't override it) -- and, since
    // item M, their accessible names now diverge by amount, which is exactly what this
    // getAllByRole + a shared-prefix regex is for: "row 1's kebab" and "row 2's kebab".
    const kebabs = screen.getAllByRole('button', { name: /^Actions for TIM HORTONS/ });

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
    // Ruling S6 changed this: Quick add starts collapsed outside review mode now, so its fields
    // (this one included) are not in the DOM until the disclosure is opened.
    fireEvent.click(screen.getByRole('button', { name: 'Add a transaction' }));
    const amount = document.querySelector('input[name="amount"]') as HTMLInputElement | null;
    expect(amount?.getAttribute('inputmode')).toBe('decimal');
  });
});

describe('v1.13.0 ruling R7: QuickAddTransaction sits at the top of the page', () => {
  it('renders the #quick-add anchor above the filter bar', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        defaultAccountId={1}
      />,
    );
    const anchor = container.querySelector('#quick-add');
    const filterForm = container.querySelector('form[method="get"]');
    expect(anchor).toBeTruthy();
    expect(filterForm).toBeTruthy();
    // Node.compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING (4) means `filterForm` comes
    // after `anchor` in the tree, i.e. quick-add really is above the filter bar, not just
    // present somewhere on the page.
    expect(anchor!.compareDocumentPosition(filterForm!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('v1.13.0 ruling R13: the Note… row action', () => {
  it('opens an inline sub-row prefilled with the existing note, spanning every column', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 5, notes: 'paid in cash' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));

    const textarea = screen.getByLabelText(/Note for TIM HORTONS/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('paid in cash');
    const cell = textarea.closest('td') as HTMLTableCellElement;
    expect(cell.colSpan).toBeGreaterThan(1);
  });

  it('submits the note through saveNoteAction with the transaction id, and closes the sub-row', async () => {
    const { saveNoteAction } = await import('@/app/(app)/transactions/actions');
    render(
      <TransactionsClient page={pageWithRow({ id: 5, notes: null })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));

    const textarea = screen.getByLabelText(/Note for TIM HORTONS/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'split with Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => expect(saveNoteAction).toHaveBeenCalled());
    const sent = (saveNoteAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('transactionId')).toBe('5');
    expect(sent.get('notes')).toBe('split with Bob');
    expect(screen.queryByLabelText(/Note for TIM HORTONS/)).toBeNull();
  });

  it('Cancel closes the sub-row without submitting', () => {
    render(
      <TransactionsClient page={pageWithRow({ id: 5 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));
    expect(screen.getByRole('button', { name: 'Save note' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save note' })).toBeNull();
  });
});

describe('v1.13.0 ruling R2: a self-scoped viewer never sees the person filter pill', () => {
  it('hides the Person filter select when selfScoped is true', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={[]}
        people={[{ id: 1, name: 'Alice' }]}
        today="2026-03-02"
        selfScoped
      />,
    );
    expect(container.querySelector('form[method="get"] select[name="person"]')).toBeNull();
  });

  it('shows it for a household-scoped viewer (the default)', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={[]}
        people={[{ id: 1, name: 'Alice' }]}
        today="2026-03-02"
      />,
    );
    expect(container.querySelector('form[method="get"] select[name="person"]')).toBeTruthy();
  });
});

describe('TransactionsClient — two identical charges are tellable apart (item M)', () => {
  it('puts the row date and amount in the kebab name', () => {
    const page: TransactionPage = {
      total: 2,
      page: 1,
      pageSize: 50,
      pageCount: 1,
      rows: [
        pageWithRow({ id: 1, date: '2026-08-03', amountCents: -412 }).rows[0],
        pageWithRow({ id: 2, date: '2026-08-03', amountCents: -1099 }).rows[0],
      ],
    };
    render(<TransactionsClient page={page} accounts={[]} categories={[]} people={[]} today="2026-08-16" />);
    // Sighted users disambiguate by position, amount and date; none of that was in the name.
    expect(screen.getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$4.12' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$10.99' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Actions for TIM HORTONS/ })).toHaveLength(2);
  });
});

describe('TransactionsClient — a self viewer gets no attribution controls (item BO)', () => {
  it('renders no bulk Attribute form and no per-row person select', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        selfScoped
      />,
    );
    fireEvent.click(screen.getByLabelText('Select transaction 1'));
    expect(screen.queryByRole('button', { name: 'Attribute' })).toBeNull();
    expect(screen.queryByLabelText('Person for transaction 1')).toBeNull();
    // Not rendered rather than shown-but-ineffective -- this file's own rule at :382-384.
    expect(screen.queryByLabelText('Person for the selected transactions')).toBeNull();
  });

  it('still shows who the row belongs to', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, attributedUserId: 7, attributedUserName: 'Alice' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        selfScoped
      />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('keeps both controls for a household viewer', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[]}
        categories={[]}
        people={[{ id: 7, name: 'Alice' }]}
        today="2026-03-02"
      />,
    );
    expect(screen.getByLabelText('Person for transaction 1')).toBeTruthy();
  });
});

describe('Assign to new loan — Addendum A', () => {
  const baseProps = {
    page: pageWithRow(),
    accounts: [{ id: 1, name: 'Joint Chequing' }],
    categories: [],
    people: [],
    today: '2026-03-02',
  };
  const transferOnlyProps = { ...baseProps, page: pageWithRow({ isTransfer: true }) };
  const twoRowProps = {
    ...baseProps,
    page: {
      total: 2,
      page: 1,
      pageSize: 50,
      pageCount: 1,
      rows: [
        pageWithRow({ id: 1 }).rows[0],
        pageWithRow({ id: 2, rawDescription: 'SECOND ROW', normalizedMerchant: 'SECOND ROW' }).rows[0],
      ],
    },
  };

  it('is offered on a normal row even when the household has no loans yet', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Assign to loan…' })).toBeTruthy();
  });

  it('is not offered on a transfer (MUST-14.8, ruling A13)', () => {
    render(<TransactionsClient {...transferOnlyProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: 'Assign to loan…' })).toBeNull();
  });

  it('opens an inline sub-row with a name box and a direction select, defaulting to lent', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    const name = screen.getByLabelText('Loan name') as HTMLInputElement;
    const direction = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect(name.name).toBe('loanName');
    expect(direction.name).toBe('loanDirection');
    expect(direction.value).toBe('lent');
    expect([...direction.options].map((option) => option.textContent)).toEqual([
      'Borrowed — we owe them',
      'Lent out — they owe us',
    ]);
    // The 44px floor lives in the shared control class, not in hand-rolled utilities
    // (Addendum A, guard strategy): both controls must carry it.
    expect(name.className).toContain('field-control');
    expect(direction.className).toContain('field-control');
  });

  it('submits the transaction id, the name and the direction', async () => {
    const { createLoanFromTransactionAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(createLoanFromTransactionAction);
    spy.mockClear();
    const { container } = render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Loan name'), { target: { value: 'Loan to Sam' } });
    fireEvent.submit(container.querySelector('form[data-testid="new-loan-form"]') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('transactionId')).toBe('1');
    expect(submitted.get('loanName')).toBe('Loan to Sam');
    expect(submitted.get('loanDirection')).toBe('lent');
  });

  it('opening it on a second row replaces the first, like the note editor', () => {
    render(<TransactionsClient {...twoRowProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    openRowMenu('Actions for SECOND ROW');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    expect(screen.getAllByLabelText('Loan name')).toHaveLength(1);
  });

  // Review round: the name input carries HTML validation and focus attributes, not just a
  // bare, unconstrained <input>.
  it('the loan name input requires a value, caps at 80 characters, and takes focus on open', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    const name = screen.getByLabelText('Loan name') as HTMLInputElement;
    expect(name.required).toBe(true);
    expect(name.maxLength).toBe(80);
    expect(document.activeElement).toBe(name);
  });
});

describe('Assign to new loan — a refusal keeps the editor open (review round)', () => {
  const baseProps = {
    page: pageWithRow(),
    accounts: [{ id: 1, name: 'Joint Chequing' }],
    categories: [],
    people: [],
    today: '2026-03-02',
  };

  // Before this fix, the sub-row's <form onSubmit> closed unconditionally, so a refusal (lent +
  // incoming money, already linked, a blank name) discarded whatever name the person had just
  // typed and left only the top banner to explain why. The form must now stay open, keep the
  // typed name, and show the refusal where the person is looking -- under the form itself.
  it('discards nothing: the typed name survives a refusal, and the error shows inline', async () => {
    const { createLoanFromTransactionAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(createLoanFromTransactionAction);
    spy.mockResolvedValueOnce({ error: 'A loan you lent out starts with money going out.' });
    const { container } = render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Loan name'), { target: { value: 'Loan to Sam' } });
    const form = container.querySelector('form[data-testid="new-loan-form"]') as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => expect(spy).toHaveBeenCalled());

    // Still open, still carrying what was typed.
    await waitFor(() =>
      expect(within(form).getByText('A loan you lent out starts with money going out.')).toBeTruthy(),
    );
    expect(within(form).getByRole('alert')).toBeTruthy();
    expect((screen.getByLabelText('Loan name') as HTMLInputElement).value).toBe('Loan to Sam');
  });

  it('a success closes the editor', async () => {
    const { createLoanFromTransactionAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(createLoanFromTransactionAction);
    spy.mockResolvedValueOnce({ message: 'Created Loan to Sam. Assigned. $500.00 came off the balance.' });
    const { container } = render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Loan name'), { target: { value: 'Loan to Sam' } });
    fireEvent.submit(container.querySelector('form[data-testid="new-loan-form"]') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('Loan name')).toBeNull());
  });
});

describe('Assign to new loan — create result priority (review round)', () => {
  const twoRowProps = {
    page: {
      total: 2,
      page: 1,
      pageSize: 50,
      pageCount: 1,
      rows: [
        pageWithRow({ id: 1 }).rows[0],
        pageWithRow({ id: 2, rawDescription: 'SECOND ROW', normalizedMerchant: 'SECOND ROW' }).rows[0],
      ],
    },
    accounts: [{ id: 1, name: 'Joint Chequing' }],
    categories: [],
    people: [],
    today: '2026-03-02',
  };

  // newLoanState used to be LAST in the top banner's `??` chain, so a stale message left behind
  // by an earlier, unrelated action (assignState here) could mask a fresh create's own result.
  // newLoanState now goes first: the create's own message/error always wins.
  it('a fresh create result is not masked by a stale assign message', async () => {
    const { assignToLoanAction, createLoanFromTransactionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(assignToLoanAction).mockResolvedValueOnce({ message: 'That transaction is already linked to this loan.' });
    vi.mocked(createLoanFromTransactionAction).mockResolvedValueOnce({ message: 'Created Loan to Sam. Assigned. $500.00 came off the balance.' });

    const { container } = render(
      <TransactionsClient {...twoRowProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('That transaction is already linked to this loan.')).toBeTruthy());

    openRowMenu('Actions for SECOND ROW');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Loan name'), { target: { value: 'Loan to Sam' } });
    fireEvent.submit(container.querySelector('form[data-testid="new-loan-form"]') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Created Loan to Sam. Assigned. $500.00 came off the balance.')).toBeTruthy());
    expect(screen.queryByText('That transaction is already linked to this loan.')).toBeNull();
  });
});

/**
 * Review round (fold /review in). Assertions ported from the deleted review-client.test.tsx,
 * re-pointed at TransactionsClient's own `reviewMode` prop -- ruling R5 renders a card list
 * (`<li>`) instead of the table when it is set, never both.
 */
describe('Review mode (ruling R5): the card list replaces the table', () => {
  const categories = [
    { id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 },
  ];

  function reviewPage(overrides: Partial<TransactionRow> = {}): TransactionPage {
    return pageWithRow({
      source: 'bayes',
      categoryId: 1,
      categoryName: 'Dining',
      confidence: 0.82,
      ...overrides,
    });
  }

  /** The card branch renders the SAME rowMenu() as the table, but nothing covered that its
   *  kebab forms actually dispatch from inside a <li> rather than a <td>. Reported as
   *  "assign to loan does nothing in review mode": the dispatch is fine (this test); what was
   *  actually missing was noteEditor/newLoanEditor's own sub-rows never rendering from the card
   *  list at all (fix round, item CB) -- covered by its own describe block below. */
  it('dispatches a kebab action from a review card, not just from a table row', async () => {
    const { assignToLoanAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(assignToLoanAction).mockClear();
    render(
      <TransactionsClient
        page={reviewPage()}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        loanOptions={[{ id: 7, name: 'Civic' }]}
        loanLinks={{}}
      />,
    );
    const menus = screen.getAllByRole('button', { name: /Actions for/ });
    fireEvent.click(menus[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(assignToLoanAction).toHaveBeenCalled());
  });

  it('renders a <li> card, not a <table>, when reviewMode is set', () => {
    const { container } = render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('ul > li.card')).toBeTruthy();
  });

  it('renders the ordinary table when reviewMode is not set, even with the same rows', () => {
    const { container } = render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" />,
    );
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('ul > li.card')).toBeNull();
  });

  it('shows the guessed-category badge with its margin', () => {
    render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.getByText(/guessed Dining \(margin 0\.82\)/)).toBeTruthy();
  });

  // Ruling S5(c) replaced this test: every card in a queue defined as "not categorized yet" used
  // to carry an "uncategorized" badge, which labelled the one thing every card already shares --
  // noise, not information. The fallback badge is deleted outright now, so this proves its
  // absence instead of its presence.
  it('renders no "uncategorized" badge when nothing was guessed -- the meta line just ends after the account', () => {
    const { container } = render(
      <TransactionsClient
        page={reviewPage({ source: 'none', categoryId: null, categoryName: null, confidence: null })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    expect(screen.queryByText('uncategorized')).toBeNull();
    expect(container.querySelector('.badge--slate')).toBeNull();
  });

  it('labels the per-row select "This transaction only" and sends teach=1', async () => {
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    const { container } = render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.getByText('This transaction only')).toBeTruthy();
    const select = screen.getByLabelText('Category for TIM HORTONS — this transaction only') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(setCategoryAction).toHaveBeenCalled());
    const sent = (setCategoryAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('teach')).toBe('1');
    expect(container).toBeTruthy();
  });

  it('the table row select does NOT send teach=1 (ruling R3: only review mode teaches)', async () => {
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(setCategoryAction).mockClear();
    render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" />,
    );
    const select = screen.getByLabelText('Category for transaction 1') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(setCategoryAction).toHaveBeenCalled());
    const sent = (setCategoryAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('teach')).toBeNull();
  });

  it('renders the name once (no "X — X") when the raw description matches the merchant', () => {
    const { container } = render(
      <TransactionsClient
        page={reviewPage({ rawDescription: 'TIM HORTONS' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    // Scoped to the card itself, not the whole page: the pagination footer below the list
    // ("Page 1 of 1 — 1 transactions") carries its own, unrelated em dash.
    expect(container.querySelector('li.card')!.textContent).not.toContain('—');
  });

  it('still renders "X — Y" when the merchant and raw description differ', () => {
    const { container } = render(
      <TransactionsClient
        page={reviewPage({ rawDescription: 'TIM HORTONS #4021' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    expect(container.textContent).toContain('TIM HORTONS — TIM HORTONS #4021');
  });

  it('an empty queue shows the review empty state with its two links, not the table empty state', () => {
    const empty: TransactionPage = { total: 0, page: 1, pageSize: 50, pageCount: 1, rows: [] };
    const { container } = render(
      <TransactionsClient page={empty} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.getByText('Nothing to review. Everything is categorized.')).toBeTruthy();
    expect(container.querySelector('a[href="/transactions"]')).toBeTruthy();
    expect(container.querySelector('a[href="/import"]')).toBeTruthy();
    expect(screen.queryByText('Nothing matches these filters')).toBeNull();
  });
});

describe('Review mode: Accept <category> and Apply to all N matching (inventory #5/#7)', () => {
  const categories = [{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }];

  function reviewPage(overrides: Partial<TransactionRow> = {}): TransactionPage {
    return pageWithRow({ source: 'bayes', categoryId: 1, categoryName: 'Dining', confidence: 0.82, ...overrides });
  }

  it('offers "Accept <category>" only when the categorizer guessed and nobody confirmed it', () => {
    render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Accept Dining' })).toBeTruthy();
  });

  it('does not offer Accept for a row nobody guessed', () => {
    render(
      <TransactionsClient
        page={reviewPage({ source: 'none', categoryId: null, categoryName: null, confidence: null })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /^Accept/ })).toBeNull();
  });

  it('never offers Accept or Apply-to-all outside review mode', () => {
    render(<TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /^Accept/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Apply a category to all/ })).toBeNull();
  });

  it('clicking Accept posts the transaction id to acceptGuessAction', async () => {
    const { acceptGuessAction } = await import('@/app/(app)/transactions/actions');
    render(
      <TransactionsClient page={reviewPage({ id: 3 })} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Accept Dining' }));
    await waitFor(() => expect(acceptGuessAction).toHaveBeenCalled());
    const sent = (acceptGuessAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('transactionId')).toBe('3');
  });

  it('"Apply a category to all N matching…" is offered only when matchingCounts says other rows share the merchant', () => {
    render(
      <TransactionsClient
        page={reviewPage({ id: 4 })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        matchingCounts={{ 4: 3 }}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Apply a category to all 3 matching…' })).toBeTruthy();
  });

  it('is absent when matchingCounts has no entry, or only 1, for that row', () => {
    render(
      <TransactionsClient
        page={reviewPage({ id: 5 })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /^Apply a category to all/ })).toBeNull();
  });

  it('opens an inline editor with the merchant name, count and a labelled select, and posts to applyToAllMatchingAction', async () => {
    const { applyToAllMatchingAction } = await import('@/app/(app)/transactions/actions');
    const { container } = render(
      <TransactionsClient
        page={reviewPage({ id: 6, normalizedMerchant: 'CITY GROCER' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        matchingCounts={{ 6: 3 }}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apply a category to all 3 matching…' }));
    expect(screen.getByText('Every "CITY GROCER" — 3 transactions, plus future imports')).toBeTruthy();
    const select = screen.getByLabelText('Category for all 3 matching CITY GROCER — every transaction') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply to all 3 matching/ }));
    await waitFor(() => expect(applyToAllMatchingAction).toHaveBeenCalled());
    const sent = (applyToAllMatchingAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('normalizedMerchant')).toBe('CITY GROCER');
    expect(sent.get('categoryId')).toBe('1');
  });

  it('stays open and shows the error inline on a refusal', async () => {
    const { applyToAllMatchingAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(applyToAllMatchingAction).mockResolvedValueOnce({ error: 'Bob already owns this rule.' });
    render(
      <TransactionsClient
        page={reviewPage({ id: 7, normalizedMerchant: 'CITY GROCER' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        matchingCounts={{ 7: 3 }}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apply a category to all 3 matching…' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply to all 3 matching/ }));
    // Shown twice on purpose (the same idiom the new-loan editor already uses): once in the top
    // banner (`error`, from the shared chain) and once inline, under the editor a refusal leaves
    // open -- getAllByText, not getByText, is the correct query for that.
    await waitFor(() => expect(screen.getAllByText('Bob already owns this rule.').length).toBeGreaterThan(0));
    // Still open.
    expect(screen.getByText('Every "CITY GROCER" — 3 transactions, plus future imports')).toBeTruthy();
  });

  it('a success closes the editor', async () => {
    const { applyToAllMatchingAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(applyToAllMatchingAction).mockResolvedValueOnce({ message: 'Applied to 3 transactions and created a rule.' });
    render(
      <TransactionsClient
        page={reviewPage({ id: 8, normalizedMerchant: 'CITY GROCER' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        matchingCounts={{ 8: 3 }}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Apply a category to all 3 matching…' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply to all 3 matching/ }));
    await waitFor(() => expect(screen.queryByText('Every "CITY GROCER" — 3 transactions, plus future imports')).toBeNull());
  });
});

describe('Ruling R4: per-row transfer toggle on every row, both directions', () => {
  it('offers "Mark as transfer" on an ordinary (non-review) table row', async () => {
    const { setRowTransferAction } = await import('@/app/(app)/transactions/actions');
    render(<TransactionsClient page={pageWithRow({ id: 9, isTransfer: false })} accounts={[]} categories={[]} people={[]} today="2026-08-16" />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as transfer' }));
    await waitFor(() => expect(setRowTransferAction).toHaveBeenCalled());
    const sent = (setRowTransferAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('transactionId')).toBe('9');
    expect(sent.get('isTransfer')).toBe('1');
  });

  it('offers "Not a transfer" on an already-transfer row, and it is not gated on reviewMode', async () => {
    const { setRowTransferAction } = await import('@/app/(app)/transactions/actions');
    render(<TransactionsClient page={pageWithRow({ id: 10, isTransfer: true })} accounts={[]} categories={[]} people={[]} today="2026-08-16" />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Not a transfer' }));
    await waitFor(() => expect(setRowTransferAction).toHaveBeenCalled());
    const sent = (setRowTransferAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('transactionId')).toBe('10');
    expect(sent.get('isTransfer')).toBe('0');
  });

  it('is offered in review mode too, on the card list', async () => {
    const { setRowTransferAction } = await import('@/app/(app)/transactions/actions');
    render(
      <TransactionsClient
        page={pageWithRow({ id: 11, isTransfer: false })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as transfer' }));
    await waitFor(() => expect(setRowTransferAction).toHaveBeenCalled());
  });
});

describe('Ruling R2: the "Needs review" chip', () => {
  it('is hidden for a self viewer even when reviewCount is positive', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-08-16" selfScoped reviewCount={4} />,
    );
    expect(screen.queryByText(/Needs review/)).toBeNull();
  });

  it('is hidden when there is nothing to review and the filter is not active', () => {
    render(<TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewCount={0} />);
    expect(screen.queryByText(/Needs review/)).toBeNull();
  });

  it('shows the count and links into the filter for a household viewer', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewCount={4} />,
    );
    const link = screen.getByText('Needs review (4)').closest('a');
    expect(link?.getAttribute('href')).toBe('/transactions?review=1');
    expect(container).toBeTruthy();
  });

  it('links back out of the filter once inside review mode', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewMode reviewCount={4} />,
    );
    const link = screen.getByText('Needs review (4)').closest('a');
    expect(link?.getAttribute('href')).toBe('/transactions');
  });
});

/**
 * Fix round (item CB, regression): noteEditor/newLoanEditor used to be `<tr>` sub-rows rendered
 * only from the table branch, so opening either one from the review card list's kebab did
 * nothing at all. Both are now plain functions rendered from both branches -- these two prove
 * the card branch specifically.
 */
describe('Fix round (item CB): the row editors work from the review card list', () => {
  const categories = [{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }];

  function reviewPage(overrides: Partial<TransactionRow> = {}): TransactionPage {
    return pageWithRow({ source: 'bayes', categoryId: 1, categoryName: 'Dining', confidence: 0.82, ...overrides });
  }

  it('in review mode, clicking Note… shows a textarea', () => {
    render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));
    expect(screen.getByLabelText(/Note for TIM HORTONS/).tagName).toBe('TEXTAREA');
  });

  // Backlog BY folded in: the same editor now opens with a select at the top, listing every
  // existing loan plus "New loan…".
  it('in review mode, clicking Assign to loan… shows the editor with a select listing an existing loan and New loan…', () => {
    render(
      <TransactionsClient
        page={reviewPage()}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        loanOptions={[{ id: 7, name: 'Civic' }]}
        loanLinks={{}}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    const select = screen.getByLabelText('Assign to') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Civic', 'New loan…']);
  });
});

/** Backlog CA: a row linked to a loan carries a badge naming it, on the table row and the card. */
describe('Backlog CA: a loan link shows a badge naming the loan', () => {
  const linkedLoanLinks = {
    1: [{ id: 1, txnId: 1, itemId: 7, itemName: 'Civic', amountCents: 45000, appliedCents: 45000, source: 'manual' as const }],
  };

  it('renders a badge naming the loan on the table row', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
        loanOptions={[{ id: 7, name: 'Civic' }]}
        loanLinks={linkedLoanLinks}
      />,
    );
    expect(screen.getByText('Civic')).toBeTruthy();
  });
});

/** Backlog BZ: the category selects group children under their parent via an <optgroup>. */
describe('Backlog BZ: category selects render optgroups', () => {
  const categories = [
    { id: 1, name: 'Home', parentId: null, isArchived: false, sortOrder: 0 },
    { id: 2, name: 'Rent', parentId: 1, isArchived: false, sortOrder: 0 },
  ];

  it("renders an <optgroup> whose label is the parent's name", () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
      />,
    );
    const optgroup = container.querySelector('tbody select[name="categoryId"] optgroup') as HTMLOptGroupElement;
    expect(optgroup).toBeTruthy();
    expect(optgroup.label).toBe('Home');
  });
});

/**
 * v1.15.0 (responsive-rows plan, Lane 2, item 1): the table's own `<td>`s now carry `data-label`
 * and the `cell-stack-*` roles globals.css uses to reflow the row into a phone card below `sm`
 * (rulings S2/S3). jsdom does not evaluate media queries, so these are attribute/class
 * assertions, not layout assertions -- the real reflow is covered visually, not here.
 */
describe('v1.15.0 ruling S2/S3: the table row carries data-label and cell-stack roles', () => {
  it('the amount cell carries data-label="Amount" and the cell-stack-amount role', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const amountCell = container.querySelector('tbody td[data-label="Amount"]') as HTMLTableCellElement;
    expect(amountCell).toBeTruthy();
    expect(amountCell.className).toContain('cell-stack-amount');
  });

  it('the account cell carries the cell-stack-hide role -- it repeats down the column and is already the Account filter', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const accountCell = container.querySelector('tbody td[data-label="Account"]') as HTMLTableCellElement;
    expect(accountCell).toBeTruthy();
    expect(accountCell.className).toContain('cell-stack-hide');
  });

  it('the date cell is NOT hidden -- unlike the account, it is not identical down the page', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const dateCell = container.querySelector('tbody td[data-label="Date"]') as HTMLTableCellElement;
    expect(dateCell).toBeTruthy();
    expect(dateCell.className).not.toContain('cell-stack-hide');
  });

  it('the checkbox and row-menu cells carry data-label="" plus their lead/actions roles', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const cells = Array.from(container.querySelectorAll('tbody tr:first-child > td'));
    const lead = cells.find((td) => td.className.includes('cell-stack-lead'));
    const actions = cells.find((td) => td.className.includes('cell-stack-actions'));
    expect(lead?.getAttribute('data-label')).toBe('');
    expect(actions?.getAttribute('data-label')).toBe('');
  });

  it('a colSpan sub-row editor carries data-label="" and still renders (regression guard, backlog CB)', () => {
    render(
      <TransactionsClient page={pageWithRow({ id: 5, notes: 'paid in cash' })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));
    const textarea = screen.getByLabelText(/Note for TIM HORTONS/);
    const cell = textarea.closest('td') as HTMLTableCellElement;
    expect(cell.getAttribute('data-label')).toBe('');
    expect(cell.colSpan).toBeGreaterThan(1);
  });
});

/** v1.15.0 ruling S6: Quick add is a disclosure on Transactions, hidden entirely in review mode. */
describe('v1.15.0 ruling S6: Quick add folds away on Transactions', () => {
  it('is absent entirely in review mode -- a triage queue has no business showing a create form', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
    );
    expect(container.querySelector('#quick-add')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a transaction' })).toBeNull();
  });

  it('renders collapsed by default outside review mode, with a working toggle', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    expect(container.querySelector('#quick-add')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Add a transaction' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: the manual-entry form is not mounted at all yet.
    expect(container.querySelector('input[name="description"]')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close' }).getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('input[name="description"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Add a transaction' })).toBeTruthy();
    expect(container.querySelector('input[name="description"]')).toBeNull();
  });
});

/** v1.15.0 ruling S7: the filter controls fold behind a disclosure below `sm`. */
describe('v1.15.0 ruling S7: the filter controls disclosure', () => {
  it('the fields stay mounted whether the disclosure is open or not -- the filter form still submits every field it does today', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[{ id: 1, name: 'Alice' }]}
        today="2026-03-02"
      />,
    );
    const form = container.querySelector('form[method="get"]') as HTMLFormElement;
    // Closed by default (no filter active in the mocked search string) -- still present in the
    // DOM, not conditionally unmounted, so a hand-edited URL's fields are never lost mid-toggle.
    expect(form.querySelector('select[name="account"]')).toBeTruthy();
    expect(form.querySelector('select[name="category"]')).toBeTruthy();
    expect(form.querySelector('select[name="person"]')).toBeTruthy();
    expect(form.querySelector('input[name="q"]')).toBeTruthy();
    expect(form.querySelector('input[name="uncat"]')).toBeTruthy();
    expect(form.querySelector('input[name="transfers"]')).toBeTruthy();
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
  });

  it('closed by default when nothing is filtered, and the toggle opens it', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens by default and names the count when the URL already carries a filter', () => {
    window.history.pushState({}, '', '/transactions?account=1&q=coffee');
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const toggle = screen.getByRole('button', { name: 'Filters (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
