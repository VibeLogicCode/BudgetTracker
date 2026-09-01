// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TransactionsClient } from '@/app/(app)/transactions/transactions-client';
import { setCategoryAction } from '@/app/(app)/transactions/actions';
import type { CategoryGroupPage, CategoryGroupRow, TransactionPage, TransactionRow } from '@/lib/transactions';
import type { SplitRow } from '@/lib/splits';

vi.mock('@/app/(app)/transactions/actions', () => ({
  manualEntryAction: vi.fn(async () => ({})),
  setCategoryAction: vi.fn(async () => ({})),
  setAttributionAction: vi.fn(async () => ({})),
  bulkCategorizeAction: vi.fn(async () => ({})),
  bulkTransferAction: vi.fn(async () => ({})),
  // v1.25.0 Lane R item R3: the two new bulk actions (assign-to-loan, note).
  bulkAssignToLoanAction: vi.fn(async () => ({})),
  bulkNoteAction: vi.fn(async () => ({})),
  // v1.26.0 Lane 3a item 4: the two group-header actions.
  bulkConfirmGroupAction: vi.fn(async () => ({})),
  bulkRecategorizeGroupAction: vi.fn(async () => ({})),
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
  // v1.19.0 Lane 2 item 5: "Accept all suggestions".
  acceptAllGuessesAction: vi.fn(async () => ({})),
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
//
// Single-card-renderer task (2026-08-30): outside review mode this file now renders TWO trees
// for the same rows -- a card list (sm:hidden) and a <table> (hidden below sm), because a real
// browser only ever shows one (see transactions-client.tsx's own docblock on transactionCard).
// jsdom evaluates no media query, so both are live nodes here, and a bare, unscoped query for a
// row's kebab now matches twice. rowScope()/openRowMenu below fix that by scoping to the
// <table> when one exists -- every test in this file that predates this task was written back
// when the table was the ONLY tree, so that reproduces exactly what those assertions already
// meant. Review mode never grows a second tree (there was only ever the card list), so falling
// back to the whole document there is a no-op change.
function rowScope() {
  const table = document.querySelector('table');
  return within((table ?? document.body) as HTMLElement);
}

function openRowMenu(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  fireEvent.click(rowScope().getByRole('button', { name: new RegExp(`^${escaped}`) }));
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
    // Unify-the-editors task (2026-08-30): this editor is a dialog now, rendered once at the top
    // level of the page rather than duplicated inside the table/card the row itself lives in --
    // so, unlike the row's own kebab trigger, its content needs no rowScope() to disambiguate.
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

  /**
   * 2026-08-30 fix: the assign-to-loan editor's opt-in "Also mark as a transfer" checkbox.
   * Offered only once an EXISTING loan is chosen (assignToLoanAction is the one action wired to
   * read it) -- not on the default "New loan…" branch, which posts to createLoanFromTransactionAction
   * instead and is untouched by this fix. Defaults ON: money lent out and money repaid moves an
   * asset between pockets, not spending.
   *
   * v1.27.0 item 1 relabelled it. The old copy stopped at "(keeps it out of spending)", which was
   * true and incomplete: ticking it also wrote a household-wide exact transfer rule for the
   * merchant. That rule write is gone, and the copy now says so -- see the help-text test below.
   */
  it('the "Also keep this out of spending" checkbox appears once an existing loan is chosen, checked by default', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    // Not shown yet: the editor opens on the default "New loan…" branch.
    expect(screen.queryByLabelText(/Also keep this out of spending/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    const checkbox = screen.getByLabelText(/Also keep this out of spending/) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  /**
   * v1.27.0 item 1 (the owner's report: "it also adds a rule ... next time i buy from [that shop] i
   * dont want it to automatically caretgorize it as transfer"). The control's copy has to answer
   * the question the owner had to discover by being bitten by it, because the per-row "Mark as
   * transfer" control one menu away DOES author a rule and says so in its own success message.
   * Asserted as copy rather than left to the docblock: a person reading a pre-armed checkbox is the
   * only protection against a surprise they cannot see.
   */
  it('says in plain words that no merchant rule is created', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });

    // The whole sentence, not a fragment: "This transaction only" on its own is already this
    // page's house phrase (the scope radio and the row-select label both use it), so a partial
    // match would find three elements and prove nothing about THIS control's copy.
    expect(screen.getByText(/No rule is created, so other purchases from this merchant are unaffected/)).toBeTruthy();
  });

  it('saving with the checkbox left ticked sends alsoTransfer=1 to assignToLoanAction', async () => {
    const { assignToLoanAction } = await import('@/app/(app)/transactions/actions');
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(assignToLoanAction).toHaveBeenCalled());
    const sent = (assignToLoanAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as FormData;
    expect(sent.get('alsoTransfer')).toBe('1');
  });

  it('unticking the checkbox before saving sends no alsoTransfer field at all', async () => {
    const { assignToLoanAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(assignToLoanAction).mockClear();
    render(<TransactionsClient {...baseProps} loanOptions={[{ id: 7, name: 'Civic' }]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText(/Also keep this out of spending/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(assignToLoanAction).toHaveBeenCalled());
    const sent = (assignToLoanAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as FormData;
    expect(sent.get('alsoTransfer')).toBeNull();
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
    expect(rowScope().getByText('Split · 2 parts')).toBeTruthy();
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

  // Item 1 (split editor -> modal dialog): the title used to be the fixed string "Split this
  // transaction"; it now names the transaction ("Split TIM HORTONS"), so "only one editor is
  // open" is asserted by counting `role="dialog"` elements instead of matching that literal text.
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
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect((container.querySelector('input[name="txnId"]') as HTMLInputElement).value).toBe('1');

    fireEvent.click(kebabs[1]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const txnIdInputs = Array.from(container.querySelectorAll('input[name="txnId"]')) as HTMLInputElement[];
    expect(txnIdInputs.length).toBeGreaterThan(0);
    expect(txnIdInputs.every((input) => input.value === '2')).toBe(true);
  });
});

/**
 * Owner report (item 1): the split editor used to render at the very top of the page (a plain
 * Card, wherever `splitting` happened to sit in the JSX), so pressing Split… looked like it did
 * nothing until a person scrolled up -- and once there, they had lost track of which row they
 * were splitting. It is a real modal dialog now: a dimmed/blurred backdrop that closes it on
 * click, role="dialog" + aria-modal, a header naming the transaction, a focus trap, Escape-to-
 * close, and the page behind stops scrolling while it is open.
 */
describe('Split editor is a modal dialog, not a card at the top of the page (item 1)', () => {
  const categories = [{ id: 42, name: 'Old Category', parentId: null, isArchived: false, sortOrder: 0 }];

  function openSplit() {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, date: '2026-03-02', amountCents: -500, normalizedMerchant: 'TIM HORTONS' })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        splits={{}}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));
  }

  it('opens as a labelled dialog naming the merchant, date and amount', () => {
    openSplit();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    // aria-labelledby may name more than one element; concatenating each one's text is the same
    // computation an accessibility tree gives the dialog its accessible name from.
    const name = labelledby!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(name).toContain('TIM HORTONS');
    expect(name).toContain('2026-03-02');
    expect(name).toContain('-$5.00');
  });

  it('moves focus into the dialog on open', () => {
    openSplit();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the row menu button that opened it once it closes', () => {
    openSplit();
    // rowScope(), not plain screen: outside review mode this render now also carries the
    // mobile card's own kebab for the same row (transactionCard, sm:hidden), so an unscoped
    // query would match twice. openRowMenu (which openSplit() calls) already opened the
    // TABLE's trigger specifically -- this must name that exact same element back, not merely
    // "a" trigger with the same name.
    const trigger = rowScope().getByRole('button', { name: /^Actions for TIM HORTONS/ });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes it', () => {
    openSplit();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the backdrop closes it, but clicking a control inside the panel does not', () => {
    openSplit();
    fireEvent.click(screen.getByRole('button', { name: 'Add a part' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('split-dialog-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('locks the page behind from scrolling while open, and restores it once closed', () => {
    openSplit();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('traps Tab inside the dialog: past the last control it wraps to the first, and Shift+Tab off the first wraps to the last', () => {
    openSplit();
    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
      ),
    );
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('changes nothing about what the form submits: same hidden fields, same action, same disabled-until-zero Save', async () => {
    const { saveSplitsAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(saveSplitsAction).mockClear();
    openSplit();

    const saveButton = screen.getByRole('button', { name: 'Save split' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const categorySelects = screen.getAllByLabelText(/Category for part/) as HTMLSelectElement[];
    const amountInputs = screen.getAllByLabelText(/Amount for part/) as HTMLInputElement[];
    fireEvent.change(categorySelects[0], { target: { value: '42' } });
    fireEvent.change(amountInputs[0], { target: { value: '5.00' } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);
    await waitFor(() => expect(saveSplitsAction).toHaveBeenCalled());
    const sent = (saveSplitsAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('txnId')).toBe('1');
    expect(JSON.parse(String(sent.get('parts')))).toEqual([{ categoryId: 42, amountCents: -500, note: null }]);
  });
});

/**
 * Owner report (item 2): a note used to vanish from the row the instant it was saved -- nothing
 * said one existed, so telling which rows carried one (or reading it back) meant reopening the
 * Note… editor blind, one row at a time.
 */
describe('Note indicator (item 2): a saved note is no longer invisible', () => {
  it('renders a small icon button beside the merchant, its text as the title and an accessible name naming the row', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, notes: 'split with Bob', normalizedMerchant: 'TIM HORTONS' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    // rowScope(): the desktop table row's own copy specifically. Coordinator fix (2026-08-30,
    // card-density task) moved the CARD's own copy off the merchant line onto the meta line
    // instead (transactionCard's own docblock) -- the table row's placement, beside the merchant
    // name, is what this test is actually about, and rowScope() is what keeps it pinned there
    // rather than finding either copy on a page that (outside review mode) renders both trees.
    const button = rowScope().getByRole('button', { name: 'Edit note for TIM HORTONS' });
    expect(button.getAttribute('title')).toBe('split with Bob');
  });

  it('renders nothing for a row with no note', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, notes: null })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    expect(screen.queryByRole('button', { name: /^Edit note for/ })).toBeNull();
  });

  it('clicking it opens the same pre-filled Note… editor the row menu already wires up -- one editing path, not two', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, notes: 'split with Bob', normalizedMerchant: 'TIM HORTONS' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Edit note for TIM HORTONS' }));
    // Unify-the-editors task (2026-08-30): the note editor is a dialog now, rendered once at the
    // top level of the page (not nested inside the table this row's own trigger lives in),
    // titled "Note for TIM HORTONS" -- the copy pattern the owner's report asked to keep, now
    // carried by the dialog's own accessible name rather than the field's label.
    expect(screen.getByRole('dialog', { name: /Note for TIM HORTONS/ })).toBeTruthy();
    const textarea = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(textarea.value).toBe('split with Bob');
  });

  it('renders in the review card list too, and opens the same editor there', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, notes: 'split with Bob', normalizedMerchant: 'TIM HORTONS' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Edit note for TIM HORTONS' }));
    expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe('split with Bob');
  });
});

/**
 * Owner report (item 3): the review card had no way at all to attribute a transaction to a
 * household member -- triaging a shared import meant categorizing in review, then flipping back
 * to plain Transactions just to say who a charge belonged to.
 */
describe('Review card: the person control (item 3)', () => {
  const categories = [{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }];

  function reviewPage(overrides: Partial<TransactionRow> = {}): TransactionPage {
    return pageWithRow({ source: 'bayes', categoryId: 1, categoryName: 'Dining', confidence: 0.82, ...overrides });
  }

  it('renders the same attribution control the table row uses, offering the household roster it was handed', () => {
    render(
      <TransactionsClient
        page={reviewPage({ id: 1 })}
        accounts={[]}
        categories={categories}
        people={[{ id: 7, name: 'Alice' }]}
        today="2026-08-16"
        reviewMode
      />,
    );
    const select = screen.getByLabelText('Person for transaction 1') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Household', 'Alice']);
  });

  it('submits through the same setAttributionAction the table row posts to', async () => {
    const { setAttributionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(setAttributionAction).mockClear();
    render(
      <TransactionsClient
        page={reviewPage({ id: 1 })}
        accounts={[]}
        categories={categories}
        people={[{ id: 7, name: 'Alice' }]}
        today="2026-08-16"
        reviewMode
      />,
    );
    fireEvent.change(screen.getByLabelText('Person for transaction 1'), { target: { value: '7' } });
    await waitFor(() => expect(setAttributionAction).toHaveBeenCalled());
    const sent = (setAttributionAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('ids')).toBe('1');
    expect(sent.get('attributedUserId')).toBe('7');
  });

  it('is hidden for a self-scoped viewer, exactly as it is on the table row -- plain text instead', () => {
    render(
      <TransactionsClient
        page={reviewPage({ id: 1, attributedUserId: 7, attributedUserName: 'Alice' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        selfScoped
      />,
    );
    expect(screen.queryByLabelText('Person for transaction 1')).toBeNull();
    expect(screen.getByText('Alice')).toBeTruthy();
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
    const checkbox = rowScope().getByLabelText('Select transaction 1') as HTMLInputElement;
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
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
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
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
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
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
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

/**
 * v1.25.0 Lane R item R3. Bulk assign-to-loan and bulk note -- the two new bulk actions, derived
 * from the same shared `bulkActions` list as Categorize/Attribute/Mark transfer (see that list's
 * own doc comment above transactionCard's return in transactions-client.tsx). Both open a
 * RowDialog confirm before writing anything; neither is subject to the split guard
 * bulkCategorizeAction/bulkTransferAction honour (see bulkAssignToLoan/bulkSetNotes' own doc
 * comments, src/lib/transactions.ts, for the justification), which these tests prove by
 * selecting a split row and finding both actions still offered with no skip warning of their own.
 */
describe('Bulk assign-to-loan and bulk note (v1.25.0 Lane R item R3)', () => {
  const splitRows: SplitRow[] = [
    { id: 501, txnId: 1, categoryId: 42, amountCents: -300, note: null },
    { id: 502, txnId: 1, categoryId: 7, amountCents: -200, note: null },
  ];

  function renderSelected(overrides: Partial<TransactionRow> = {}) {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, ...overrides })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        loanOptions={[{ id: 9, name: 'Car Loan' }]}
        splits={{ 1: splitRows }}
      />,
    );
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
  }

  it('offers "Assign to loan…" only when the household has a loan (MUST-14.9)', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        loanOptions={[]}
      />,
    );
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
    expect(screen.queryByRole('button', { name: 'Assign to loan…' })).toBeNull();
  });

  it('offers both bulk actions on a SPLIT row, with no skip warning of their own', () => {
    renderSelected();
    expect(screen.getByRole('button', { name: 'Assign to loan…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Note…' })).toBeTruthy();
    // The existing split-skip sentence names only Categorize and Mark transfer -- neither new
    // action is subject to that guard, so it must not grow a second clause mentioning them.
    expect(screen.getByText(/split and will be skipped/i).textContent).not.toMatch(/loan|note/i);
  });

  it('Assign to loan… opens a dialog naming the selection and stating the loan select', () => {
    renderSelected();
    fireEvent.click(screen.getByRole('button', { name: 'Assign to loan…' }));
    expect(screen.getByRole('dialog', { name: /Assign 1 transaction to a loan/ })).toBeTruthy();
    expect(screen.getByLabelText('Loan')).toBeTruthy();
    expect(screen.getByText(/1 transaction will be linked/)).toBeTruthy();
  });

  it('Assign to loan…: Cancel closes the dialog and posts nothing', async () => {
    const { bulkAssignToLoanAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkAssignToLoanAction);
    spy.mockClear();
    renderSelected();
    fireEvent.click(screen.getByRole('button', { name: 'Assign to loan…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Assign to loan…: Save posts the selected ids and the chosen loan', async () => {
    const { bulkAssignToLoanAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkAssignToLoanAction);
    spy.mockClear();
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        loanOptions={[{ id: 9, name: 'Car Loan' }, { id: 10, name: 'Boat Loan' }]}
      />,
    );
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Assign to loan…' }));
    fireEvent.change(screen.getByLabelText('Loan'), { target: { value: '10' } });
    fireEvent.submit(container.querySelector('[data-testid="bulk-assign-loan-dialog-backdrop"] form') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('ids')).toBe('1');
    expect(submitted.get('itemId')).toBe('10');
  });

  it('Assign to loan…: a row already linked to the chosen loan is previewed as "will be left unchanged"', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        loanOptions={[{ id: 9, name: 'Car Loan' }]}
        loanLinks={{ 1: [{ id: 1, txnId: 1, itemId: 9, itemName: 'Car Loan', amountCents: -500, appliedCents: 500, source: 'manual' }] }}
      />,
    );
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Assign to loan…' }));
    expect(screen.getByText(/0 transactions will be linked/)).toBeTruthy();
    expect(screen.getByText(/already linked to this loan/)).toBeTruthy();
  });

  it('Note…: Cancel closes the dialog and posts nothing', async () => {
    const { bulkNoteAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkNoteAction);
    spy.mockClear();
    renderSelected();
    fireEvent.click(screen.getByRole('button', { name: 'Note…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('Note…: Save posts the selected ids and the typed note', async () => {
    const { bulkNoteAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkNoteAction);
    spy.mockClear();
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Note…' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'shared with Bob' } });
    fireEvent.submit(container.querySelector('[data-testid="bulk-note-dialog-backdrop"] form') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('ids')).toBe('1');
    expect(submitted.get('notes')).toBe('shared with Bob');
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

/**
 * Coordinator fix (2026-08-30): renaming used to open as a plain Card at the very top of the
 * page, wherever `renaming` happened to sit in the JSX -- the same "editor rendered somewhere
 * other than beside its row" defect the split dialog had before item 1 fixed it. It is now the
 * same inline-sub-row idiom as Note…/Assign to loan…/Apply to all, anchored at its own row and
 * rendered from both the card and the table row.
 */
describe('Rename editor: a dialog naming the row, not a card at the top of the page', () => {
  it('does not render a top-of-page "Rename this merchant" card at all', () => {
    render(
      <TransactionsClient page={pageWithRow({ id: 5 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    expect(screen.queryByText('Rename this merchant')).toBeNull();
  });

  it('opens as a dialog titled with the display name, prefilled with it', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, displayDescription: 'Coffee run' })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    // The kebab's own accessible name is built from displayDescription when the row has one
    // (rowMenu's own `displayDescription ?? rawDescription`), so "Coffee run" replaces
    // "TIM HORTONS" here rather than joining it.
    openRowMenu('Actions for Coffee run');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));

    // Unify-the-editors task (2026-08-30): this editor is a dialog now, rendered once at the top
    // level of the page rather than duplicated inside whichever tree (table or card) the row
    // itself lives in -- see RowDialog's own docblock. Its title names the row being renamed,
    // the same copy pattern the note dialog already established ("Note for X").
    expect(screen.getByRole('dialog', { name: /Rename Coffee run/ })).toBeTruthy();
    const nameInput = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(nameInput.value).toBe('Coffee run');
  });

  it('submits the transaction id, the typed name and the default "this transaction only" scope through renameTransactionAction', async () => {
    const { renameTransactionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(renameTransactionAction).mockClear();
    render(
      <TransactionsClient page={pageWithRow({ id: 5 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Coffee run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    await waitFor(() => expect(renameTransactionAction).toHaveBeenCalled());
    const sent = (renameTransactionAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('transactionId')).toBe('5');
    expect(sent.get('displayName')).toBe('Coffee run');
    expect(sent.get('scope')).toBe('one');
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('Cancel closes the dialog without submitting', async () => {
    const { renameTransactionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(renameTransactionAction).mockClear();
    render(
      <TransactionsClient page={pageWithRow({ id: 5 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    expect(screen.getByRole('button', { name: 'Save name' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save name' })).toBeNull();
    expect(renameTransactionAction).not.toHaveBeenCalled();
  });

  it('opens from the review card list too, at the same row', async () => {
    const { renameTransactionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(renameTransactionAction).mockClear();
    render(
      <TransactionsClient
        page={pageWithRow({ id: 5, source: 'bayes', categoryId: 1, categoryName: 'Dining', confidence: 0.5 })}
        accounts={[]}
        categories={[{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }]}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Coffee run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(renameTransactionAction).toHaveBeenCalled());
  });
});

describe('v1.13.0 ruling R13: the Note… row action', () => {
  it('opens a dialog titled with the row, prefilled with the existing note', () => {
    render(
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

    // Unify-the-editors task (2026-08-30): a dialog now, rendered once at the top level of the
    // page -- role="dialog" per RowDialog's own contract, titled "Note for TIM HORTONS" (the
    // exact copy pattern the owner's report asked to keep), with a plain "Note" field inside.
    expect(screen.getByRole('dialog', { name: /Note for TIM HORTONS/ })).toBeTruthy();
    const textarea = screen.getByLabelText('Note') as HTMLTextAreaElement;
    expect(textarea.value).toBe('paid in cash');
  });

  it('submits the note through saveNoteAction with the transaction id, and closes the dialog', async () => {
    const { saveNoteAction } = await import('@/app/(app)/transactions/actions');
    render(
      <TransactionsClient page={pageWithRow({ id: 5, notes: null })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));

    const textarea = screen.getByLabelText('Note') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'split with Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => expect(saveNoteAction).toHaveBeenCalled());
    const sent = (saveNoteAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('transactionId')).toBe('5');
    expect(sent.get('notes')).toBe('split with Bob');
    expect(screen.queryByLabelText('Note')).toBeNull();
  });

  it('Cancel closes the dialog without submitting', () => {
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
    // rowScope(): outside review mode this page also carries the mobile card's own kebab for
    // each row (sm:hidden), so an unscoped query would find every name twice.
    expect(rowScope().getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$4.12' })).toBeTruthy();
    expect(rowScope().getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$10.99' })).toBeTruthy();
    expect(rowScope().getAllByRole('button', { name: /^Actions for TIM HORTONS/ })).toHaveLength(2);
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
    fireEvent.click(rowScope().getByLabelText('Select transaction 1'));
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
    // rowScope(): both the table row and the mobile card show this same plain-text fallback
    // for a self-scoped viewer, so an unscoped query matches twice.
    expect(rowScope().getByText('Alice')).toBeTruthy();
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
    expect(rowScope().getByLabelText('Person for transaction 1')).toBeTruthy();
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

  it('opens a dialog naming the row, with a name box and a direction select, defaulting to lent', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to loan…' }));
    // Unify-the-editors task (2026-08-30): a dialog now, rendered once at the top level of the
    // page, titled after the row it assigns ("Assign TIM HORTONS to a loan").
    expect(screen.getByRole('dialog', { name: /Assign TIM HORTONS to a loan/ })).toBeTruthy();
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
    fireEvent.change(rowScope().getByLabelText('Assign to'), { target: { value: '7' } });
    fireEvent.click(rowScope().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(assignToLoanAction).toHaveBeenCalled());
  });

  it('renders a <li> card, not a <table>, when reviewMode is set', () => {
    const { container } = render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('ul > li.card')).toBeTruthy();
  });

  /**
   * Single-card-renderer task (2026-08-30): before this task, "reviewMode not set" meant the
   * table and ONLY the table -- no card anywhere in the DOM. That is no longer true: the shared
   * row card (transactionCard) is now ALSO rendered outside review mode, for the below-`sm`
   * Transactions view, so both a <table> and a card list exist here. What still distinguishes
   * plain Transactions from review mode is that each is shown at a different width instead of
   * unconditionally -- CSS decides which one a real browser displays, not two DOM trees that
   * always both render fully visible (see transactionCard's own docblock on the rule this
   * proves).
   */
  it('renders BOTH the desktop table and the shared row card when reviewMode is not set, each hidden at the other one\'s width', () => {
    const { container } = render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" />,
    );
    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    // The table's own wrapper is hidden below `sm` -- the card list is what a phone sees there
    // instead, fed from the same page.rows.
    expect(table!.closest('.hidden.sm\\:block')).toBeTruthy();
    const card = container.querySelector('ul[data-transaction-cards] > li.card');
    expect(card).toBeTruthy();
    // And the card list is hidden AT `sm` and up -- the table is the wide browsing view there.
    expect(card!.closest('ul')?.className).toContain('sm:hidden');
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
    // rowScope(): outside review mode, the mobile card's own category select carries the SAME
    // aria-label as the table row's (both read "Category for transaction 1" -- see
    // transactionCard's own comment on why its label matches the table's outside review mode),
    // so an unscoped query would find two.
    const select = rowScope().getByLabelText('Category for transaction 1') as HTMLSelectElement;
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

  it('opens a titled dialog with the merchant name, count and a labelled select, and posts to applyToAllMatchingAction', async () => {
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
    // Unify-the-editors task (2026-08-30): a dialog now, titled with the merchant every matching
    // transaction shares.
    expect(screen.getByRole('dialog', { name: /Apply a category to every "CITY GROCER"/ })).toBeTruthy();
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
 * Fix round (item CB, regression, now historical): noteEditor/newLoanEditor used to be `<tr>`
 * sub-rows rendered only from the table branch, so opening either one from the review card
 * list's kebab did nothing at all. Unify-the-editors task (2026-08-30): both are dialogs now,
 * rendered once regardless of which branch (table or card) triggered them -- these two prove
 * the review card list's own kebab still reaches them.
 */
describe('Fix round (item CB): the row editors work from the review card list', () => {
  const categories = [{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }];

  function reviewPage(overrides: Partial<TransactionRow> = {}): TransactionPage {
    return pageWithRow({ source: 'bayes', categoryId: 1, categoryName: 'Dining', confidence: 0.82, ...overrides });
  }

  it('in review mode, clicking Note… shows a textarea, in a dialog titled with the row', () => {
    render(
      <TransactionsClient page={reviewPage()} accounts={[]} categories={categories} people={[]} today="2026-08-16" reviewMode />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Note…' }));
    expect(screen.getByRole('dialog', { name: /Note for TIM HORTONS/ })).toBeTruthy();
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA');
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
    const select = rowScope().getByLabelText('Assign to') as HTMLSelectElement;
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
    expect(rowScope().getByText('Civic')).toBeTruthy();
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

  // v1.16.0 Lane C item 3: this used to be `cell-stack-hide`, which dropped the account entirely
  // from the phone card -- the owner asked for it back, so it now carries `cell-stack-meta`
  // instead, reading as context under the merchant rather than vanishing outright.
  it('the account cell carries the cell-stack-meta role, not cell-stack-hide -- the owner asked for it back', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const accountCell = container.querySelector('tbody td[data-label="Account"]') as HTMLTableCellElement;
    expect(accountCell).toBeTruthy();
    expect(accountCell.className).toContain('cell-stack-meta');
    expect(accountCell.className).not.toContain('cell-stack-hide');
  });

  // v1.16.0 Lane C item 3: a date is not identical down the page and is the thing a person scans
  // for first, so it stays visible -- as `cell-stack-meta` context under the merchant headline,
  // not its own labelled row.
  it('the date cell is NOT hidden, and carries cell-stack-meta rather than its own labelled row', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const dateCell = container.querySelector('tbody td[data-label="Date"]') as HTMLTableCellElement;
    expect(dateCell).toBeTruthy();
    expect(dateCell.className).not.toContain('cell-stack-hide');
    expect(dateCell.className).toContain('cell-stack-meta');
  });

  it('the checkbox and row-menu cells carry data-label="" plus their lead/actions roles', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    // v1.19.0 Lane 2 item 3: `tbody tr:first-child` used to BE the one data row, but date
    // grouping now always renders a day-header <tr> ahead of it (every row starts a new day the
    // first time it appears) -- `:nth-of-type(2)` is the actual transaction row for this
    // single-row fixture, the same way the day header's own tests below prove it is a plain,
    // single-<td> row rather than a second copy of the data row's cells.
    const cells = Array.from(container.querySelectorAll('tbody tr:nth-of-type(2) > td'));
    const lead = cells.find((td) => td.className.includes('cell-stack-lead'));
    const actions = cells.find((td) => td.className.includes('cell-stack-actions'));
    expect(lead?.getAttribute('data-label')).toBe('');
    expect(actions?.getAttribute('data-label')).toBe('');
  });

  // The colSpan sub-row regression guard that used to live here (backlog CB: a `<td
  // colSpan>` note/loan/apply-all editor carrying `data-label=""` so the phone-stack reflow
  // still handled it) is gone along with the code path it guarded: unify-the-editors task
  // (2026-08-30) replaced every one of those sub-rows with a dialog, which renders as a
  // `fixed inset-0` overlay outside the table entirely and so has no `<td>`, colSpan or
  // data-label of its own to carry. See the Note/Rename/Assign-to-loan/Apply-to-all describe
  // blocks elsewhere in this file for the dialog-shaped assertions that replaced it.
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

/**
 * v1.16.0 Lane C item 3. The root used to carry `data-page-width="wide"` in BOTH modes, bumping
 * the shell's `main` to a 96rem cap for the review filter too -- so the guide and the filter card
 * ran to 96rem while the card list a few lines down stayed capped at `max-w-4xl` (ruling S5(a)),
 * a visible edge mismatch. The fix: the wide marker is gone entirely in review mode, and the
 * guide/filter card/card list/pager all sit inside one shared `max-w-4xl` container instead.
 */
describe('v1.16.0 Lane C item 3: review mode is one narrow column, not the wide table\'s width', () => {
  it('renders no data-page-width="wide" in review mode', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
    );
    expect(container.querySelector('[data-page-width]')).toBeNull();
  });

  it('still marks the page wide outside review mode -- nothing about that layout changes', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    expect(container.querySelector('[data-page-width="wide"]')).toBeTruthy();
  });

  it('wraps the guide and the filter card in the SAME max-w-4xl container as the card list, so every edge lines up', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
    );
    const guide = screen.getByText('What is this page for?').closest('details');
    const wrapper = guide?.closest('.max-w-4xl');
    expect(wrapper).not.toBeNull();
    // The filter form's own "Filter" submit button, and the card list's row menu, both sit
    // inside that SAME wrapper as the guide -- proving this is one shared container rather than
    // three elements that each happened to pick max-w-4xl independently (the reported mismatch).
    expect(wrapper?.contains(screen.getByRole('button', { name: 'Filter' }))).toBe(true);
    expect(wrapper?.contains(screen.getByText('TIM HORTONS'))).toBe(true);
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
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
  });

  /**
   * v1.24.0 Lane A item 2: `transfers` is no longer one of the fields THIS disclosure toggles --
   * the old "Hide transfers" checkbox is gone, replaced by three always-visible links (below,
   * regardless of `filtersOpen`) that navigate rather than submit. Burying that control behind a
   * disclosure was the reported bug (a mis-tagged transfer had no way back into view), so it
   * staying visible with the disclosure closed is the fix, not an oversight.
   */
  it('the transfer-view control renders outside the disclosure, visible whether it is open or not', () => {
    render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[{ id: 1, name: 'Alice' }]}
        today="2026-03-02"
      />,
    );
    // Disclosure is closed by default here (no filter active) -- the links are still findable.
    expect(screen.getByRole('link', { name: 'All' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Transfers only' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'No transfers' })).toBeTruthy();
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

  /**
   * v1.25.0 Lane R item R2: the transfer-view control moved onto PillNav
   * (src/components/ui/PillNav.tsx), the last hand-rolled `role="group"` instance of that
   * pattern. Two deliberate changes verified here: a LABELLED `<nav>` LANDMARK instead of
   * `role="group"` (jumpable by a screen-reader user, unlike a group), and the active option
   * marked -- both PillNav properties, not reimplemented by hand. The three hrefs themselves
   * are asserted unchanged from v1.24.0 in the next test.
   */
  describe('v1.25.0 Lane R item R2: transfer-view control on PillNav', () => {
    it('exposes a labelled navigation landmark, not role="group"', () => {
      const { container } = render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
      );
      expect(screen.getByRole('navigation', { name: 'Filter by transfer status' })).toBeTruthy();
      expect(container.querySelector('[role="group"][aria-label="Filter by transfer status"]')).toBeNull();
    });

    it('marks the active option with aria-current="page" -- "All" by default, "Transfers only" for ?transfers=only', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
      );
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'Transfers only' }).getAttribute('aria-current')).toBeNull();

      cleanup();
      render(
        <TransactionsClient
          page={pageWithRow()}
          accounts={[]}
          categories={[]}
          people={[]}
          today="2026-03-02"
          currentQuery="transfers=only"
        />,
      );
      expect(screen.getByRole('link', { name: 'Transfers only' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBeNull();
    });

    it('the three hrefs are unchanged from v1.24.0', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
      );
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/transactions');
      expect(screen.getByRole('link', { name: 'Transfers only' }).getAttribute('href')).toBe('/transactions?transfers=only');
      expect(screen.getByRole('link', { name: 'No transfers' }).getAttribute('href')).toBe('/transactions?transfers=0');
    });

    it('never renders in review mode -- the queue chips (item R1) take this slot instead', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
      );
      expect(screen.queryByRole('navigation', { name: 'Filter by transfer status' })).toBeNull();
    });
  });

  /**
   * v1.25.0 Lane R item R1 (deferred from v1.20.0). The review-queue chip row -- All / Suggested
   * / Not categorized -- takes the transfer-view control's own slot, only in review mode. Reuses
   * PillNav and filterHref the same way the R2 control does (verified just above); the row-level
   * suggested/uncategorized filtering itself is exercised end-to-end in
   * tests/app/transactions-page.test.tsx and tests/lib/transactions.test.ts, so these are about
   * the RENDERING contract only: labelled landmark, active marking, plain hrefs, no per-chip
   * counts (this task's own brief: a count needs its own query and is left off).
   */
  describe('v1.25.0 Lane R item R1: review-queue chip row', () => {
    it('renders only in review mode, taking the transfer-view control\'s slot', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
      );
      expect(screen.getByRole('navigation', { name: 'Filter the review queue' })).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Filter by transfer status' })).toBeNull();
    });

    it('labels are plain -- All, Suggested, Not categorized -- with no count appended', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
      );
      expect(screen.getByRole('link', { name: 'All' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Suggested' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Not categorized' })).toBeTruthy();
    });

    it('marks "All" active by default and the right chip active for ?queue=', () => {
      render(
        <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" reviewMode />,
      );
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBe('page');

      cleanup();
      render(
        <TransactionsClient
          page={pageWithRow()}
          accounts={[]}
          categories={[]}
          people={[]}
          today="2026-03-02"
          reviewMode
          currentQuery="review=1&queue=suggested"
        />,
      );
      expect(screen.getByRole('link', { name: 'Suggested' }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBeNull();
    });

    it('builds hrefs from filterHref, preserving the rest of the querystring (e.g. review=1)', () => {
      render(
        <TransactionsClient
          page={pageWithRow()}
          accounts={[]}
          categories={[]}
          people={[]}
          today="2026-03-02"
          reviewMode
          currentQuery="review=1"
        />,
      );
      expect(screen.getByRole('link', { name: 'Suggested' }).getAttribute('href')).toBe('/transactions?review=1&queue=suggested');
      expect(screen.getByRole('link', { name: 'Not categorized' }).getAttribute('href')).toBe(
        '/transactions?review=1&queue=uncategorized',
      );
      expect(screen.getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/transactions?review=1');
    });
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

/**
 * Owner report (item 3): the visible "Search" label pushed the field down a line, which left the
 * Filters icon beside it floating above centre with a dead band around it -- the label added
 * nothing the new placeholder does not already say, so it is gone, and the field keeps its
 * accessible name through `aria-label` instead of a visible <span>.
 */
describe('Owner report (item 3): the search field has no visible label but keeps an accessible name', () => {
  it('has an accessible name a screen reader can still compute, with no visible "Search" text', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const input = screen.getByRole('textbox', { name: 'Search by merchant name or description' }) as HTMLInputElement;
    expect(input.name).toBe('q');
    expect(input.getAttribute('placeholder')).toBe('Search by merchant name or description');
    // The old visible label text is gone outright, not merely restyled -- ruling: a placeholder
    // this specific is not a second copy of it.
    expect(screen.queryByText('Search', { selector: 'span' })).toBeNull();
  });

  it('sits on the same row as the Filters button, both clearing the 44px touch floor', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const input = screen.getByRole('textbox', { name: 'Search by merchant name or description' });
    const filterButton = screen.getByRole('button', { name: 'Filters' });
    // Same immediate row container -- the fix for "the icon floats above centre" is that both
    // controls are direct children of the one flex row, not one of them nested inside an extra
    // label wrapper a line taller than the other.
    expect(input.parentElement).toBe(filterButton.parentElement);
    expect(input.className).toContain('min-h-11');
    expect(filterButton.className).toContain('h-11');
  });
});

/**
 * v1.19.0 Lane 2 item 2 (ruling D6). TOP-LEVEL categories only, wrapping, with a "+n" expander,
 * and never a second `category` form field beside the existing select -- every assertion here is
 * scoped `within` the chip group specifically, because the existing Category select (still inside
 * the Filters(N) disclosure, untouched by this task) renders the very same category NAMES as
 * plain <option> text, and an unscoped screen.getByText would find both.
 */
describe('Chip filters (ruling D6): top-level categories, wrapping, no picker duplication', () => {
  const categories = [
    { id: 1, name: 'Housing', parentId: null, isArchived: false, sortOrder: 0 },
    { id: 2, name: 'Rent', parentId: 1, isArchived: false, sortOrder: 0 },
    { id: 3, name: 'Groceries', parentId: null, isArchived: false, sortOrder: 1 },
    { id: 4, name: 'Old Category', parentId: null, isArchived: true, sortOrder: 2 },
  ];

  it('renders "All" plus every active top-level category, never a child or an archived one', () => {
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={categories} people={[]} today="2026-08-16" />,
    );
    const chips = within(screen.getByRole('group', { name: 'Filter by category' }));
    expect(chips.getByText('All')).toBeTruthy();
    expect(chips.getByText('Housing')).toBeTruthy();
    expect(chips.getByText('Groceries')).toBeTruthy();
    expect(chips.queryByText('Rent')).toBeNull();
    expect(chips.queryByText('Old Category')).toBeNull();
  });

  it('folds anything past the visible count behind a "+n" expander that reveals the rest', () => {
    const manyCategories = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `Category ${i + 1}`,
      parentId: null,
      isArchived: false,
      sortOrder: i,
    }));
    render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={manyCategories} people={[]} today="2026-08-16" />,
    );
    const chips = within(screen.getByRole('group', { name: 'Filter by category' }));
    expect(chips.getByText('Category 8')).toBeTruthy();
    expect(chips.queryByText('Category 9')).toBeNull();
    expect(chips.getByText('+2')).toBeTruthy();
    fireEvent.click(chips.getByText('+2'));
    expect(chips.getByText('Category 9')).toBeTruthy();
    expect(chips.getByText('Category 10')).toBeTruthy();
  });

  // Bug fix (owner report): chip hrefs are now built from the `currentQuery` prop page.tsx hands
  // down (already parsed server-side), not from `window.location.search` -- so these three pass
  // it directly instead of faking the browser URL with pushState, the same way the real server
  // render never has a `window.location` to read in the first place.
  it('a chip link changes only the category param, preserving everything else already active', () => {
    render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        reviewMode
        currentQuery="account=3&review=1"
      />,
    );
    const chips = within(screen.getByRole('group', { name: 'Filter by category' }));
    const link = chips.getByText('Housing').closest('a');
    expect(link?.getAttribute('href')).toBe('/transactions?account=3&review=1&category=1');
  });

  it('"All" clears the category param but keeps everything else', () => {
    render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        currentQuery="account=3&category=1"
      />,
    );
    const chips = within(screen.getByRole('group', { name: 'Filter by category' }));
    const link = chips.getByText('All').closest('a');
    expect(link?.getAttribute('href')).toBe('/transactions?account=3');
  });

  it('marks the chip matching the current ?category param active, and All otherwise', () => {
    render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-08-16"
        currentQuery="category=3"
      />,
    );
    const chips = within(screen.getByRole('group', { name: 'Filter by category' }));
    expect(chips.getByText('Groceries').className).toContain('bg-accent-soft');
    expect(chips.getByText('All').className).not.toContain('bg-accent-soft');
  });
});

/**
 * v1.19.0 Lane 2 item 3. Rows are already sorted by date (desc outside review mode, asc inside
 * it -- listTransactions' own ORDER BY), so grouping is a same-date-as-the-previous-row check,
 * never a second sort. `2026-08-29` is a Saturday and `2026-08-28` a Friday -- picked because the
 * plan's own example ("SAT, AUG 29") is exactly this date, so a wrong weekday calculation fails
 * loudly here instead of quietly matching whatever the test happened to assert.
 */
describe('Date grouping (item 3): rows group under a day header', () => {
  function twoDaysPage(): TransactionPage {
    const a = pageWithRow({ id: 1, date: '2026-08-29' }).rows[0];
    const b = pageWithRow({ id: 2, date: '2026-08-29', rawDescription: 'SECOND', normalizedMerchant: 'SECOND' }).rows[0];
    const c = pageWithRow({ id: 3, date: '2026-08-28', rawDescription: 'THIRD', normalizedMerchant: 'THIRD' }).rows[0];
    return { total: 3, page: 1, pageSize: 50, pageCount: 1, rows: [a, b, c] };
  }

  it('the table prints one day header per date, not one per row', () => {
    const { container } = render(
      <TransactionsClient page={twoDaysPage()} accounts={[]} categories={[]} people={[]} today="2026-08-29" />,
    );
    // rowScope(): day headers now print once in the table AND once in the mobile card list
    // (both iterate the same page.rows outside review mode -- see transactionCard's own
    // docblock), so an unscoped query finds each date's header twice.
    expect(rowScope().getByText('SAT, AUG 29')).toBeTruthy();
    expect(rowScope().getByText('FRI, AUG 28')).toBeTruthy();
    // A day header is the only `colspan` cell here (no note/loan/apply-all sub-row is open), so
    // this counts headers, not data rows -- 2 headers for 3 rows across 2 distinct dates.
    const headers = container.querySelectorAll('tbody td[data-label=""][colspan]');
    expect(headers.length).toBe(2);
  });

  it('the day header is a full-width <tr><td colSpan>, so the existing phone-stack reflow (which already handles a colSpan cell) keeps working with no new CSS', () => {
    const { container } = render(
      <TransactionsClient page={twoDaysPage()} accounts={[]} categories={[]} people={[]} today="2026-08-29" />,
    );
    // rowScope(): the card list's own day header is a <li>, not a <td> -- .closest('td') on it
    // would just return null -- so this must land on the TABLE's header specifically, not
    // whichever of the two an unscoped query happens to find first.
    const cell = rowScope().getByText('SAT, AUG 29').closest('td') as HTMLTableCellElement;
    expect(cell.getAttribute('data-label')).toBe('');
    expect(cell.colSpan).toBeGreaterThan(1);
  });

  it('the review card list groups under the same day header, as a plain <li> rather than a second .card', () => {
    const { container } = render(
      <TransactionsClient page={twoDaysPage()} accounts={[]} categories={[]} people={[]} today="2026-08-29" reviewMode />,
    );
    expect(screen.getByText('SAT, AUG 29')).toBeTruthy();
    expect(screen.getByText('FRI, AUG 28')).toBeTruthy();
    // Every real transaction still gets its own card -- the header is an extra sibling, not a
    // replacement for any row.
    expect(container.querySelectorAll('ul > li.card').length).toBe(3);
    const header = screen.getByText('SAT, AUG 29').closest('li') as HTMLLIElement;
    expect(header.className).not.toContain('card');
  });
});

/** v1.19.0 Lane 2 item 4. Money already colours the amount by sign (money-pos/money-neg); the
 *  circled direction glyph is the one piece of "row rhythm" the review card lacked. */
describe('Row rhythm (item 4): the review card gets a circled money-direction glyph', () => {
  it('a positive amount gets the positive-toned "in" circle', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ amountCents: 500 })} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(container.querySelector('li.card span[aria-hidden="true"].bg-positive-soft')).toBeTruthy();
  });

  it('a negative amount gets the plain "out" circle', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ amountCents: -500 })} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(container.querySelector('li.card span[aria-hidden="true"].bg-surface-2')).toBeTruthy();
  });
});

/** v1.19.0 Lane 2 item 5: the per-row confirm button. Disabled state is gated on `categoryId`
 *  alone, not `source` -- unlike the kebab's "Accept <category>" item, a hand-picked category
 *  deserves the same one-click confirm as a bayes guess does. */
describe('Review mode: per-row confirm button (item 5)', () => {
  it('is disabled while the row has no category', () => {
    render(
      <TransactionsClient
        page={pageWithRow({ id: 1, source: 'none', categoryId: null, categoryName: null })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    const button = screen.getByRole('button', { name: /Choose a category before confirming/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('is enabled once the row has a category, and confirming posts the transaction id to acceptGuessAction', async () => {
    const { acceptGuessAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(acceptGuessAction).mockClear();
    render(
      <TransactionsClient
        page={pageWithRow({ id: 9, source: 'bayes', categoryId: 1, categoryName: 'Dining' })}
        accounts={[]}
        categories={[{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }]}
        people={[]}
        today="2026-08-16"
        reviewMode
      />,
    );
    const button = screen.getByRole('button', { name: /Confirm Dining for/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(acceptGuessAction).toHaveBeenCalled());
    const sent = (acceptGuessAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('transactionId')).toBe('9');
  });
});

/**
 * v1.19.0 Lane 2 item 5: the confirm-progress bar and "Accept all suggestions". Session-local by
 * design (transactions-client.tsx's own comment on queueCeiling explains why -- this task touches
 * no src/lib file, so there is nowhere to keep a persisted count), so every fresh render starts
 * back at 0 confirmed against whatever the current filtered total is.
 */
describe('Review mode: confirm-progress bar and Accept all suggestions (item 5)', () => {
  const diningCategory = [{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }];

  function reviewPageOf(total: number, bayesGuessed: number): TransactionPage {
    const rows: TransactionRow[] = [];
    for (let i = 0; i < total; i += 1) {
      rows.push(
        pageWithRow({
          id: i + 1,
          rawDescription: `MERCHANT ${i}`,
          normalizedMerchant: `MERCHANT ${i}`,
          source: i < bayesGuessed ? 'bayes' : 'none',
          categoryId: i < bayesGuessed ? 1 : null,
          categoryName: i < bayesGuessed ? 'Dining' : null,
        }).rows[0],
      );
    }
    return { total, page: 1, pageSize: 50, pageCount: 1, rows };
  }

  it('reads 0/M confirmed on first render, M being the filtered total', () => {
    render(
      <TransactionsClient page={reviewPageOf(3, 2)} accounts={[]} categories={diningCategory} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.getByText('0/3 confirmed')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Review queue confirmed' })).toBeTruthy();
  });

  it('offers "Accept all suggestions (N)" only for rows the categorizer guessed with a category', () => {
    render(
      <TransactionsClient page={reviewPageOf(3, 2)} accounts={[]} categories={diningCategory} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.getByRole('button', { name: /Accept all suggestions \(2\)/ })).toBeTruthy();
  });

  it('is absent when nothing on the page has a guess to accept', () => {
    render(
      <TransactionsClient page={reviewPageOf(3, 0)} accounts={[]} categories={[]} people={[]} today="2026-08-16" reviewMode />,
    );
    expect(screen.queryByRole('button', { name: /Accept all suggestions/ })).toBeNull();
  });

  it('clicking it posts every eligible id to acceptAllGuessesAction', async () => {
    const { acceptAllGuessesAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(acceptAllGuessesAction).mockClear();
    render(
      <TransactionsClient page={reviewPageOf(3, 2)} accounts={[]} categories={diningCategory} people={[]} today="2026-08-16" reviewMode />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Accept all suggestions \(2\)/ }));
    await waitFor(() => expect(acceptAllGuessesAction).toHaveBeenCalled());
    const sent = (acceptAllGuessesAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('ids')).toBe('1,2');
  });

  it('never renders outside review mode', () => {
    render(
      <TransactionsClient page={reviewPageOf(3, 2)} accounts={[]} categories={diningCategory} people={[]} today="2026-08-16" />,
    );
    expect(screen.queryByText(/confirmed$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Accept all suggestions/ })).toBeNull();
  });
});

/**
 * Coordinator fix (2026-08-30, card-density task): a screenshot comparison against an older
 * build showed the card losing on density for three concrete reasons -- the kebab and review
 * mode's confirm button stranded on a trailing line of their own, both selects stretching to
 * fill a two-column grid cell, and each control's label on its own line above it -- all fixed in
 * transactionCard's own docblock (src/app/(app)/transactions/transactions-client.tsx). These
 * prove the resulting shape structurally rather than by counting pixels, which jsdom cannot
 * measure: three lines exactly, the kebab sharing the identity line with the amount, the confirm
 * button sharing the controls line with category/person instead of being orphaned, a capped
 * (never `w-full`) select width, and each label sitting beside its own control rather than above
 * it.
 */
describe('Coordinator fix (2026-08-30): card density -- three lines, not four', () => {
  it('the card renders exactly three top-level lines (identity, meta, controls) -- no trailing actions-only line', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ id: 1 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const card = container.querySelector('li.card') as HTMLLIElement;
    const lines = Array.from(card.children).filter((el) => el.tagName === 'DIV');
    expect(lines).toHaveLength(3);
  });

  it('the kebab shares the identity line (line 1) with the amount, not a trailing line of its own', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ id: 1 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const card = container.querySelector('li.card') as HTMLLIElement;
    const [line1] = Array.from(card.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
    expect(within(line1).getByText('-$5.00')).toBeTruthy();
    expect(within(line1).getByRole('button', { name: /^Actions for TIM HORTONS/ })).toBeTruthy();
  });

  it("review mode's confirm button shares the controls line (line 3) with category/person -- not orphaned with the kebab", () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1, source: 'bayes', categoryId: 1, categoryName: 'Dining' })}
        accounts={[]}
        categories={[{ id: 1, name: 'Dining', parentId: null, isArchived: false, sortOrder: 0 }]}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    const card = container.querySelector('li.card') as HTMLLIElement;
    const [, , line3] = Array.from(card.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
    expect(within(line3).getByRole('button', { name: /Confirm Dining for/ })).toBeTruthy();
    expect(within(line3).getByLabelText(/Category for TIM HORTONS/)).toBeTruthy();
  });

  it('the note indicator sits on the meta line (line 2, with date/account), not beside the merchant name, on the card', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1, notes: 'paid in cash', normalizedMerchant: 'TIM HORTONS' })}
        accounts={[{ id: 1, name: 'Joint Chequing' }]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    const card = container.querySelector('li.card') as HTMLLIElement;
    const [, line2] = Array.from(card.children).filter((el) => el.tagName === 'DIV') as HTMLDivElement[];
    expect(within(line2).getByText('Joint Chequing')).toBeTruthy();
    expect(within(line2).getByRole('button', { name: 'Edit note for TIM HORTONS' })).toBeTruthy();
  });

  it('category and person selects keep their natural capped width, never stretched full-width', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1 })}
        accounts={[]}
        categories={[]}
        people={[{ id: 7, name: 'Alice' }]}
        today="2026-03-02"
      />,
    );
    const selects = container.querySelectorAll('li.card select');
    expect(selects.length).toBeGreaterThan(0);
    for (const select of Array.from(selects)) {
      expect(select.className).not.toContain('w-full');
      expect(select.className).toContain('max-w-[11rem]');
    }
  });

  it("each control's label sits inline beside it, not stacked on its own line above it", () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow({ id: 1 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    const card = container.querySelector('li.card') as HTMLLIElement;
    const label = within(card).getByText('This transaction only');
    const controlGroup = label.parentElement as HTMLElement;
    expect(within(controlGroup).getByLabelText(/Category for transaction/)).toBeTruthy();
    expect(controlGroup.className).toContain('items-center');
  });
});

/**
 * Owner report (item 4): the placeholder task. `.field-control::placeholder` used to be a bare
 * `color: var(--subtle)` -- a readable secondary-TEXT colour, so a hinted field read almost as
 * strongly as one that already had a real value typed into it. This proves the fix at the TOKEN
 * level, not just the rule: `--placeholder` exists in BOTH themes (a colour tuned for one theme
 * is not tuned for the other), each one's contrast against that theme's own `--field-bg` clears
 * a legible floor, and each is clearly lower than that same theme's own `--subtle` -- "recede
 * without vanishing". Computed straight from globals.css's own hex values (the same WCAG
 * relative-luminance formula this design system already grades every other colour pair by, per
 * that file's own docblock on --positive-solid/--warning-solid/--negative-solid), so a future
 * edit to any of these tokens is checked against the rule itself, not a hardcoded ratio that
 * would drift out of sync with it.
 */
describe('Owner report (item 4): placeholder text recedes but stays legible, in both themes', () => {
  const css = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/app/globals.css'),
    'utf8',
  );

  function tokenIn(block: string, name: string): string {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    if (!match) throw new Error(`--${name} not found in the given block of globals.css`);
    return match[1];
  }

  // Both :root and .dark are flat custom-property lists in this file (no nested rule inside
  // either), so a non-greedy match up to the first `\n}` after the opening brace is exactly that
  // block and nothing past it.
  function themeBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
    if (!match) throw new Error(`no ${selector} block found in globals.css`);
    return match[1];
  }

  function luminance(hex: string): number {
    const int = parseInt(hex.slice(1), 16);
    const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(a: string, b: string): number {
    const l1 = luminance(a) + 0.05;
    const l2 = luminance(b) + 0.05;
    return Math.max(l1, l2) / Math.min(l1, l2);
  }

  it('the placeholder rule reads --placeholder, never --subtle', () => {
    const rule = /\.field-control::placeholder\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, 'no .field-control::placeholder rule found in globals.css').toBeTruthy();
    expect(rule).toMatch(/color:\s*var\(--placeholder\)/);
    expect(rule).not.toMatch(/color:\s*var\(--subtle\)/);
  });

  it('never renders italic, and never lets a browser dim it a second time on top of that', () => {
    const rule = /\.field-control::placeholder\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // No italics, ever -- a hinted field must look like an empty field, not a stylised one.
    expect(rule).toMatch(/font-style:\s*normal/);
    // Firefox's UA stylesheet applies opacity: 0.54 to ::placeholder by default -- left alone,
    // that would dim --placeholder a SECOND time on top of the contrast this task tuned it to,
    // landing Firefox users below every other browser's rendering of the same value.
    expect(rule).toMatch(/opacity:\s*1\b/);
  });

  for (const selector of [':root', '.dark']) {
    const theme = selector === ':root' ? 'light' : 'dark';
    it(`${theme} theme: --placeholder clears a legible floor but recedes below --subtle`, () => {
      const block = themeBlock(selector);
      const fieldBg = tokenIn(block, 'field-bg');
      const placeholder = tokenIn(block, 'placeholder');
      const subtle = tokenIn(block, 'subtle');

      const placeholderRatio = contrastRatio(placeholder, fieldBg);
      const subtleRatio = contrastRatio(subtle, fieldBg);

      // Legible: at or above the 3:1 floor WCAG sets for large text/UI components -- fainter
      // than that is not "receding", it is "gone", which is its own defect.
      expect(placeholderRatio).toBeGreaterThanOrEqual(3);
      // Receded: clearly below the real secondary-text colour it replaced, so a value someone
      // actually typed still reads as the stronger thing on the field.
      expect(placeholderRatio).toBeLessThan(subtleRatio);
    });
  }
});

/**
 * Coordinator's screenshot review (2026-08-30): an uncategorized row APPEARED to show "Income"
 * pre-selected in the card's category picker, which would be a real bug (a null category must
 * never render as though it were already filed under a real one). Reproduced directly rather
 * than guessed at: a row with `categoryId: null, source: 'none'` against a category list whose
 * FIRST real option is Income. In both modes the select's own `.value`/`selectedIndex` land on
 * the placeholder option, not on Income -- React sets a controlled <select>'s value by matching
 * it against an option's `value` attribute, and that match applies even when the matching option
 * also carries `disabled` (disabled only blocks a person from choosing it via click/keyboard; it
 * has no effect on which option is programmatically selected). So this is not happening: the
 * screenshot's "Income" was a row the categorizer actually guessed Income for (`source: 'bayes',
 * categoryId: <Income id>`), which is legitimate, reviewable state -- exactly what review mode's
 * "guessed Income" badge beside the select exists to surface. Left alone, as instructed.
 */
describe('Coordinator check: an uncategorized row never pre-selects the first real category', () => {
  const categories = [
    { id: 1, name: 'Income', parentId: null, isArchived: false, sortOrder: 0 },
    { id: 2, name: 'Dining', parentId: null, isArchived: false, sortOrder: 1 },
  ];

  it('review mode: shows the disabled placeholder, not Income', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1, categoryId: null, categoryName: null, source: 'none' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    const select = container.querySelector('li.card select[name="categoryId"]') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[select.selectedIndex].textContent).toBe('Choose for this one…');
  });

  it('plain Transactions: shows "Uncategorized", not Income', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({ id: 1, categoryId: null, categoryName: null, source: 'none' })}
        accounts={[]}
        categories={categories}
        people={[]}
        today="2026-03-02"
      />,
    );
    const select = container.querySelector('li.card select[name="categoryId"]') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[select.selectedIndex].textContent).toBe('Uncategorized');
  });
});

/**
 * v1.26.0 Lane 1 (owner report: a row reading "Amazon" with a small blue `rule` badge --
 * "shows amazon i dont know what orignal entry was so maybe its wrong maybe its not"). Covers the
 * whole task's brief: the card shows a rule-renamed row's bank text unconditionally, the table
 * hides it behind the badge-turned-button (noteIndicator's own touch-target mechanics, copied not
 * reinvented), `?bank=1` reveals it table-wide, the dialog wording is honest per display_source,
 * and "Rename just this one" reaches the existing manual-rename path rather than a second one.
 */
describe('v1.26.0 Lane 1: bank text (owner report -- "shows amazon i dont know what orignal entry was")', () => {
  it('review mode: a rule-renamed row shows the bank text with no interaction', () => {
    const { container } = render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        reviewMode
      />,
    );
    expect(container.querySelector('li.card')!.textContent).toContain('AMZN MKTP CA*5H1CF8BE0');
  });

  it('table: a rule-renamed row shows no bank text by default; the rule badge is a button; activating it opens a dialog with the full bank text', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    // rowScope(): outside review mode the mobile card carries the SAME badge-button, so an
    // unscoped query would find two -- see rowScope's own doc comment above.
    expect(rowScope().queryByText(/AMZN MKTP CA\*5H1CF8BE0/)).toBeNull();

    const badge = rowScope().getByRole('button', { name: 'Why AMAZON shows this name' });
    expect(badge.textContent).toBe('rule');
    fireEvent.click(badge);

    expect(screen.getByRole('dialog', { name: /Renamed by a rule/ })).toBeTruthy();
    expect(screen.getByText('AMZN MKTP CA*5H1CF8BE0')).toBeTruthy();
  });

  it('a row that was never renamed renders no badge button at all', () => {
    render(<TransactionsClient page={pageWithRow({ id: 1 })} accounts={[]} categories={[]} people={[]} today="2026-03-02" />);
    expect(rowScope().queryByRole('button', { name: /shows this name/ })).toBeNull();
  });

  function bankTextFixture(): TransactionPage {
    return {
      total: 3,
      page: 1,
      pageSize: 50,
      pageCount: 1,
      rows: [
        pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        }).rows[0],
        pageWithRow({
          id: 2,
          displayDescription: 'Coffee run',
          displaySource: 'manual',
          rawDescription: 'TIM HORTONS #4021',
          normalizedMerchant: 'TIM HORTONS',
        }).rows[0],
        pageWithRow({ id: 3, rawDescription: 'GROCERY MART', normalizedMerchant: 'GROCERY MART' }).rows[0],
      ],
    };
  }

  it('?bank=1 reveals bank text for every renamed row in the table; absent, none; a junk value behaves as absent', () => {
    render(
      <TransactionsClient page={bankTextFixture()} accounts={[]} categories={[]} people={[]} today="2026-03-02" currentQuery="bank=1" />,
    );
    expect(rowScope().getByText(/AMZN MKTP CA\*5H1CF8BE0/)).toBeTruthy();
    expect(rowScope().getByText(/TIM HORTONS #4021/)).toBeTruthy();

    cleanup();
    render(<TransactionsClient page={bankTextFixture()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />);
    expect(rowScope().queryByText(/AMZN MKTP CA\*5H1CF8BE0/)).toBeNull();
    expect(rowScope().queryByText(/TIM HORTONS #4021/)).toBeNull();

    cleanup();
    render(
      <TransactionsClient
        page={bankTextFixture()}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        currentQuery="bank=nonsense"
      />,
    );
    expect(rowScope().queryByText(/AMZN MKTP CA\*5H1CF8BE0/)).toBeNull();
    expect(rowScope().queryByText(/TIM HORTONS #4021/)).toBeNull();
  });

  it('the table-level toggle link flips ?bank=1 through filterHref, preserving other params', () => {
    const { unmount } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" currentQuery="account=3" />,
    );
    // Not scoped to rowScope(): unlike the badge, this control renders once (table-only, never
    // duplicated for the mobile card list), so it is unambiguous to query unscoped.
    expect(screen.getByRole('link', { name: 'Show bank text' }).getAttribute('href')).toBe('/transactions?account=3&bank=1');
    unmount();

    render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        currentQuery="account=3&bank=1"
      />,
    );
    expect(screen.getByRole('link', { name: 'Hide bank text' }).getAttribute('href')).toBe('/transactions?account=3');
  });

  it('the dialog resolves and shows the rule line + Edit/Delete links when renameRules identifies one', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        renameRules={{ 1: { pattern: 'AMAZON', matchType: 'contains', renameTo: 'Amazon', ruleId: 9 } }}
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Why AMAZON shows this name' }));
    expect(screen.getByText('Rule: contains AMAZON → "Amazon"')).toBeTruthy();
    const editLink = screen.getByRole('link', { name: 'Edit the rule' });
    const deleteLink = screen.getByRole('link', { name: 'Delete the rule' });
    expect(editLink.getAttribute('href')).toBe('/settings/merchant-rules?kind=rename&q=AMAZON');
    expect(deleteLink.getAttribute('href')).toBe('/settings/merchant-rules?kind=rename&q=AMAZON');
  });

  it('omits the rule line and Edit/Delete links when no rule could be identified (renameRules empty)', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Why AMAZON shows this name' }));
    expect(screen.getByText('AMZN MKTP CA*5H1CF8BE0')).toBeTruthy();
    expect(screen.queryByText(/^Rule:/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit the rule' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Delete the rule' })).toBeNull();
  });

  it('display_source "manual" says the household set it, with no rule line or rule links', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Coffee run',
          displaySource: 'manual',
          rawDescription: 'TIM HORTONS #4021',
          normalizedMerchant: 'TIM HORTONS',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Why TIM HORTONS shows this name' }));
    expect(screen.getByRole('dialog', { name: /Renamed by the household/ })).toBeTruthy();
    expect(screen.getByText(/typed this name in by hand/)).toBeTruthy();
    expect(screen.queryByText(/^Rule:/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit the rule' })).toBeNull();
  });

  it('display_source "loan" says a linked loan set it, distinct wording from manual/rename, reached through the existing loan badge', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Repayment from Civic',
          displaySource: 'loan',
          rawDescription: 'ETRNSFR RECV 1234',
          normalizedMerchant: 'ETRNSFR',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        loanOptions={[{ id: 7, name: 'Civic' }]}
        loanLinks={{
          1: [{ id: 1, txnId: 1, itemId: 7, itemName: 'Civic', amountCents: 45000, appliedCents: 45000, source: 'manual' }],
        }}
      />,
    );
    const badge = rowScope().getByRole('button', { name: 'Why ETRNSFR shows this name' });
    expect(badge.textContent).toBe('Civic');
    fireEvent.click(badge);
    expect(screen.getByRole('dialog', { name: /Named by a linked loan/ })).toBeTruthy();
    expect(screen.getByText(/loan this transaction is linked to/)).toBeTruthy();
    expect(screen.queryByText(/typed this name in by hand/)).toBeNull();
    expect(screen.queryByText(/^Rule:/)).toBeNull();
  });

  it('"Rename just this one" closes the bank-text dialog and opens the existing manual-rename path, wired to renameTransactionAction', async () => {
    const { renameTransactionAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(renameTransactionAction).mockClear();
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    fireEvent.click(rowScope().getByRole('button', { name: 'Why AMAZON shows this name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename just this one' }));

    // The bank-text dialog is gone; the SAME rename dialog the row's own kebab "Rename…" item
    // opens (renameDialog, prefilled with the current display name) takes its place -- not a
    // second rename path.
    expect(screen.queryByRole('dialog', { name: /Renamed by a rule/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: /Rename Amazon/ })).toBeTruthy();
    const nameInput = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(nameInput.value).toBe('Amazon');

    fireEvent.change(nameInput, { target: { value: 'Amazon.ca' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(renameTransactionAction).toHaveBeenCalled());
    const sent = (renameTransactionAction as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as FormData;
    expect(sent.get('transactionId')).toBe('1');
    expect(sent.get('displayName')).toBe('Amazon.ca');
  });

  it('the badge is a real, focusable <button> (not a div/span with onClick), reachable and activated by keyboard', () => {
    render(
      <TransactionsClient
        page={pageWithRow({
          id: 1,
          displayDescription: 'Amazon',
          displaySource: 'rename',
          rawDescription: 'AMZN MKTP CA*5H1CF8BE0',
          normalizedMerchant: 'AMAZON',
        })}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
      />,
    );
    const badge = rowScope().getByRole('button', { name: 'Why AMAZON shows this name' }) as HTMLButtonElement;
    // A native <button type="button">, never disabled and never pulled out of the tab order --
    // the one thing that guarantees every real browser translates a focused Enter/Space press
    // into the very click event this test then fires, the same event a pointer sends.
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.type).toBe('button');
    expect(badge.disabled).toBe(false);
    expect(badge.tabIndex).toBe(0);

    badge.focus();
    expect(document.activeElement).toBe(badge);

    fireEvent.keyDown(badge, { key: 'Enter' });
    fireEvent.click(badge);
    expect(screen.getByRole('dialog', { name: /Renamed by a rule/ })).toBeTruthy();
  });
});

/**
 * v1.26.0 Lane 3a items 1-4, the client half. The server half (that these params reach the real
 * queries and change the real order/clusters) lives in tests/app/transactions-page.test.tsx; this
 * file asserts what the COMPONENT does with what it is handed -- the hrefs, the copy, the counts it
 * states, and which dialogs post what.
 */
const CATEGORIES = [
  { id: 42, name: 'Groceries', parentId: null, isArchived: false, sortOrder: 0 },
  { id: 43, name: 'Coffee', parentId: null, isArchived: false, sortOrder: 1 },
];

function groupPage(overrides: Partial<CategoryGroupPage> = {}): CategoryGroupPage {
  const groups: CategoryGroupRow[] = [
    { categoryId: 42, categoryName: 'Groceries', parentId: null, count: 37, totalCents: -166_00 },
    { categoryId: 43, categoryName: 'Coffee', parentId: null, count: 4, totalCents: -15_00 },
  ];
  return {
    groups,
    page: 1,
    pageSize: 25,
    pageCount: 1,
    groupCount: groups.length,
    totalCount: 41,
    totalCents: -181_00,
    ...overrides,
  };
}

function renderGrouped(overrides: Partial<CategoryGroupPage> = {}, currentQuery = 'import=7&source=rule&group=category') {
  return render(
    <TransactionsClient
      page={pageWithRow({ id: 1 })}
      accounts={[{ id: 1, name: 'Joint Chequing' }]}
      categories={CATEGORIES}
      people={[]}
      today="2026-03-02"
      groups={groupPage(overrides)}
      currentQuery={currentQuery}
    />,
  );
}

describe('v1.26.0 Lane 3a item 2: the grouped-by-category view', () => {
  it('renders one header per cluster, each with its name, row count and subtotal', () => {
    const { container } = renderGrouped();
    const headers = Array.from(container.querySelectorAll('ul[data-category-groups] summary')).map((node) =>
      (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('Groceries');
    expect(headers[0]).toContain('37 transactions');
    expect(headers[0]).toContain('$166.00');
    expect(headers[1]).toContain('Coffee');
    expect(headers[1]).toContain('4 transactions');
    expect(headers[1]).toContain('$15.00');
  });

  it('keeps the order it was handed -- largest absolute total first, never re-sorted here', () => {
    const { container } = renderGrouped();
    const headers = Array.from(container.querySelectorAll('ul[data-category-groups] summary')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(headers[0]).toContain('Groceries');
    expect(headers[1]).toContain('Coffee');
  });

  it('shows the clusters INSTEAD of the rows -- no table, no card list', () => {
    const { container } = renderGrouped();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-transaction-cards]')).toBeNull();
  });

  it('a group header links through to that one cluster in the flat list, exactly and un-grouped', () => {
    const { container } = renderGrouped();
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.textContent ?? '').startsWith('See all 37 in the list'),
    );
    const href = link?.getAttribute('href') ?? '';
    expect(href).toContain('category=42');
    expect(href).toContain('exact=1');
    expect(href).toContain('import=7');
    expect(href).toContain('source=rule');
    expect(href).not.toContain('group=');
  });

  it('the uncategorized cluster drills down on ?category=uncategorized, with no exact flag to be wrong about', () => {
    const { container } = renderGrouped({
      groups: [{ categoryId: null, categoryName: 'Uncategorized', parentId: null, count: 5, totalCents: -900 }],
      groupCount: 1,
    });
    const link = Array.from(container.querySelectorAll('a')).find((a) =>
      (a.textContent ?? '').startsWith('See all 5 in the list'),
    );
    expect(link?.getAttribute('href')).toContain('category=uncategorized');
    expect(link?.getAttribute('href')).not.toContain('exact=');
  });

  it('the pager counts GROUPS, in words that cannot be read as rows', () => {
    const { container } = renderGrouped({ page: 1, pageSize: 25, pageCount: 2, groupCount: 40, totalCount: 312 });
    expect(container.textContent).toContain('Groups 1–25 of 40');
    expect(container.textContent).toContain('312 transactions in this view');
    // The shape that would be misread: a bare page number over a list of categories.
    expect(container.textContent).not.toContain('Page 1 of 2');
  });

  it('the pager links move gpage and leave every other filter alone', () => {
    const { container } = renderGrouped({ page: 2, pageSize: 25, pageCount: 3, groupCount: 60, totalCount: 500 });
    const links = Array.from(container.querySelectorAll('a'));
    const previous = links.find((a) => (a.textContent ?? '').trim() === 'Previous groups');
    const next = links.find((a) => (a.textContent ?? '').trim() === 'Next groups');
    expect(previous?.getAttribute('href')).toContain('gpage=1');
    expect(next?.getAttribute('href')).toContain('gpage=3');
    expect(next?.getAttribute('href')).toContain('source=rule');
  });

  it('offers no pager links at either end of the group list', () => {
    const { container } = renderGrouped();
    const links = Array.from(container.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim());
    expect(links).not.toContain('Previous groups');
    expect(links).not.toContain('Next groups');
  });

  it('an ordinary render (no groups prop) still shows the table, unchanged', () => {
    const { container } = render(
      <TransactionsClient page={pageWithRow()} accounts={[]} categories={[]} people={[]} today="2026-03-02" />,
    );
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('ul[data-category-groups]')).toBeNull();
  });
});

describe('v1.26.0 Lane 3a item 4: the group bulk actions', () => {
  it('states the group’s TRUE count, not the number of rows rendered on this page', async () => {
    renderGrouped();
    // The page prop carries exactly ONE row; the group carries 37. The dialog must say 37.
    fireEvent.click(screen.getAllByRole('button', { name: 'These are all correct' })[0]);
    expect(screen.getByRole('dialog', { name: /Confirm 37 transactions in Groceries/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm all 37' })).toBeTruthy();
    expect(screen.getByText(/whole group of 37, not only what is on screen/)).toBeTruthy();
  });

  it('confirm posts the page’s filter and the cluster, never a list of rendered row ids', async () => {
    const { bulkConfirmGroupAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkConfirmGroupAction);
    spy.mockClear();
    const { container } = renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'These are all correct' })[0]);
    fireEvent.submit(container.querySelector('[data-testid="group-confirm-dialog-backdrop"] form') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('scope')).toBe('import=7&source=rule&group=category');
    expect(submitted.get('groupCategoryId')).toBe('42');
    expect(submitted.get('ids')).toBeNull();
  });

  it('confirm: Cancel closes the dialog and writes nothing', async () => {
    const { bulkConfirmGroupAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkConfirmGroupAction);
    spy.mockClear();
    renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'These are all correct' })[0]);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('offers no confirm on the uncategorized cluster -- there is no category there to agree with', () => {
    renderGrouped({
      groups: [{ categoryId: null, categoryName: 'Uncategorized', parentId: null, count: 5, totalCents: -900 }],
      groupCount: 1,
    });
    expect(screen.queryByRole('button', { name: 'These are all correct' })).toBeNull();
    // Recategorize IS offered for it: filing what the rules had no opinion about is the useful case.
    expect(screen.getByRole('button', { name: 'Recategorize the group…' })).toBeTruthy();
  });

  it('recategorize states the true count and names the destination it is about to post', async () => {
    renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recategorize the group…' })[0]);
    expect(screen.getByRole('dialog', { name: /Recategorize 37 transactions in Groceries/ })).toBeTruthy();
    // Opens with nothing chosen: no destination is ever pre-armed, and Save is refused until the
    // household answers -- see the Recategorize button's own comment for why neither the first
    // category nor the group's own is a safe default here.
    expect(screen.getByText('Pick a category to move all 37 transactions into.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move all 37' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Move them to'), { target: { value: '43' } });
    expect(screen.getByText('All 37 transactions move from Groceries to Coffee.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move all 37' })).toHaveProperty('disabled', false);
  });

  it('recategorize posts the filter, the cluster, the target category and the rule choice', async () => {
    const { bulkRecategorizeGroupAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkRecategorizeGroupAction);
    spy.mockClear();
    const { container } = renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recategorize the group…' })[0]);
    fireEvent.change(screen.getByLabelText('Move them to'), { target: { value: '43' } });
    fireEvent.submit(
      container.querySelector('[data-testid="group-recategorize-dialog-backdrop"] form') as HTMLFormElement,
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('scope')).toBe('import=7&source=rule&group=category');
    expect(submitted.get('groupCategoryId')).toBe('42');
    expect(submitted.get('categoryId')).toBe('43');
    // Ticked by default: a correction that does not teach a rule leaves the next import to be
    // misfiled the same way.
    expect(submitted.get('createRules')).toBe('on');
  });

  it('recategorize: Cancel closes the dialog and writes nothing', async () => {
    const { bulkRecategorizeGroupAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkRecategorizeGroupAction);
    spy.mockClear();
    renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'Recategorize the group…' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('both dialogs warn that a split transaction is left alone, before anything is written', () => {
    renderGrouped();
    fireEvent.click(screen.getAllByRole('button', { name: 'These are all correct' })[0]);
    expect(screen.getByText(/A split transaction is left\s+alone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Recategorize the group…' })[0]);
    expect(screen.getByText(/A split transaction is left\s+alone/)).toBeTruthy();
  });
});

describe('v1.26.0 Lane 3a item 1: the sort control', () => {
  function renderSortable(currentQuery: string) {
    return render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        currentQuery={currentQuery}
      />,
    );
  }

  it('offers each sort field as a link that changes only ?sort=', () => {
    renderSortable('account=3');
    expect(screen.getByRole('link', { name: 'Date' }).getAttribute('href')).toBe('/transactions?account=3&sort=date');
    expect(screen.getByRole('link', { name: 'Amount' }).getAttribute('href')).toBe('/transactions?account=3&sort=amount');
    expect(screen.getByRole('link', { name: 'Category' }).getAttribute('href')).toBe(
      '/transactions?account=3&sort=category',
    );
  });

  it('"Default" is the active option with no ?sort=, and its link DELETES the param rather than spelling it', () => {
    renderSortable('account=3');
    const fallback = screen.getByRole('link', { name: 'Default' });
    expect(fallback.getAttribute('aria-current')).toBe('page');
    expect(fallback.getAttribute('href')).toBe('/transactions?account=3');
  });

  it('shows no direction control until a sort is chosen -- a direction alone changes nothing', () => {
    renderSortable('');
    expect(screen.queryByRole('link', { name: 'Newest first' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Oldest first' })).toBeNull();
  });

  it('labels the direction pair for the field being sorted, and marks desc active by default', () => {
    renderSortable('sort=date');
    expect(screen.getByRole('link', { name: 'Newest first' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Oldest first' }).getAttribute('href')).toContain('dir=asc');
  });

  it('says "Highest/Lowest" for a SIGNED amount rather than promising largest-first', () => {
    renderSortable('sort=amount');
    expect(screen.getByRole('link', { name: 'Highest first' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lowest first' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Largest first' })).toBeNull();
  });

  it('says A–Z for category, with the alphabetical direction offered first', () => {
    renderSortable('sort=category&dir=asc');
    expect(screen.getByRole('link', { name: 'A–Z' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Z–A' })).toBeTruthy();
  });

  it('a junk ?sort= value leaves "Default" active and no direction row, exactly as if absent', () => {
    renderSortable('sort=sideways');
    expect(screen.getByRole('link', { name: 'Default' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('link', { name: 'Newest first' })).toBeNull();
  });

  it('carries the sort through the filter form, so re-filtering does not silently reset it', () => {
    const { container } = renderSortable('sort=amount&dir=asc');
    expect(container.querySelector('input[type="hidden"][name="sort"]')?.getAttribute('value')).toBe('amount');
    expect(container.querySelector('input[type="hidden"][name="dir"]')?.getAttribute('value')).toBe('asc');
  });
});

describe('v1.26.0 Lane 3a item 3: the source filter and the source badge', () => {
  function renderWithQuery(currentQuery: string, row: Partial<TransactionRow> = {}) {
    return render(
      <TransactionsClient
        page={pageWithRow(row)}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        currentQuery={currentQuery}
      />,
    );
  }

  it('offers each source as a link that changes only ?source=', () => {
    renderWithQuery('account=3');
    expect(screen.getByRole('link', { name: 'Rules' }).getAttribute('href')).toBe('/transactions?account=3&source=rule');
    expect(screen.getByRole('link', { name: 'Guesses' }).getAttribute('href')).toBe('/transactions?account=3&source=bayes');
    expect(screen.getByRole('link', { name: 'By hand' }).getAttribute('href')).toBe('/transactions?account=3&source=manual');
    expect(screen.getByRole('link', { name: 'Nothing yet' }).getAttribute('href')).toBe('/transactions?account=3&source=none');
  });

  it('clears itself with "Any" -- not a second pill named "All", which the transfer row already owns', () => {
    renderWithQuery('source=rule');
    expect(screen.getByRole('link', { name: 'Any' }).getAttribute('href')).toBe('/transactions');
    expect(screen.getByRole('link', { name: 'Rules' }).getAttribute('aria-current')).toBe('page');
    // Exactly one "All" on the card: the transfer view's own.
    expect(screen.getAllByRole('link', { name: 'All' })).toHaveLength(1);
  });

  it('a junk ?source= value leaves "Any" active rather than refusing', () => {
    renderWithQuery('source=nonsense');
    expect(screen.getByRole('link', { name: 'Any' }).getAttribute('aria-current')).toBe('page');
  });

  it('renders a quiet badge per source on both the table row and the card', () => {
    const { container } = renderWithQuery('', { source: 'rule' });
    const badges = Array.from(container.querySelectorAll('span.badge')).filter(
      (node) => (node.textContent ?? '').trim() === 'set by rule',
    );
    // One in the table, one in the card list -- the two renderers this file deliberately keeps in
    // step (transactionCard's own docblock).
    expect(badges).toHaveLength(2);
    expect(badges[0].className).toContain('badge--muted');
    expect(badges[0].className).not.toContain('badge--amber');
    expect(badges[0].className).not.toContain('badge--red');
  });

  it('words each source differently, and never as the bare noun the rename badge uses', () => {
    for (const [source, label] of [
      ['rule', 'set by rule'],
      ['bayes', 'set by guess'],
      ['manual', 'set by hand'],
    ] as const) {
      const { container } = renderWithQuery('', { source });
      const table = container.querySelector('table')!;
      expect(
        Array.from(table.querySelectorAll('span.badge')).some((node) => (node.textContent ?? '').trim() === label),
      ).toBe(true);
      // The rename badge's own text, which must never be what this badge says.
      expect(Array.from(table.querySelectorAll('span.badge')).map((node) => node.textContent)).not.toContain('rule');
      cleanup();
    }
  });

  it('renders no badge for a row nothing has categorized -- the empty category select already says it', () => {
    const { container } = renderWithQuery('', { source: 'none', categoryId: null, categoryName: null });
    const texts = Array.from(container.querySelectorAll('span.badge')).map((node) => (node.textContent ?? '').trim());
    expect(texts.filter((text) => text.startsWith('set by'))).toEqual([]);
  });

  it('stays a plain span, while the rename badge stays a button -- different in the accessibility tree, not only in colour', () => {
    const { container } = renderWithQuery('', {
      source: 'rule',
      displayDescription: 'Greenfield Market',
      displaySource: 'rename',
    });
    const table = container.querySelector('table')!;
    const rename = within(table).getByRole('button', { name: 'Why TIM HORTONS shows this name' });
    expect(rename.textContent).toBe('rule');
    expect(rename.className).toContain('badge--blue');
    expect(within(table).queryByRole('button', { name: /set by rule/ })).toBeNull();
  });
});

describe('v1.26.0 Lane 3a: what the review filter does and does not offer', () => {
  function renderReview() {
    return render(
      <TransactionsClient
        page={pageWithRow()}
        accounts={[]}
        categories={[]}
        people={[]}
        today="2026-03-02"
        reviewMode
        currentQuery="review=1"
      />,
    );
  }

  it('offers sort in the queue -- ordering a queue by amount is as reasonable as ordering the list by it', () => {
    renderReview();
    expect(screen.getByRole('link', { name: 'Amount' })).toBeTruthy();
  });

  it('offers neither the grouped view nor the source filter, whose options would be lies inside REVIEW_WHERE', () => {
    renderReview();
    expect(screen.queryByRole('link', { name: 'By category' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Rules' })).toBeNull();
  });
});
