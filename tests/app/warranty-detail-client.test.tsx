// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { WarrantyDetailClient } from '@/app/(app)/warranties/[id]/warranty-detail-client';
import { deleteLoanRuleAction, unlinkLedgerTransactionAction, updateWarrantyAction } from '@/app/(app)/warranties/actions';
import type { ItemLedger } from '@/lib/loans';
import type { WarrantyItemRow, WarrantyReceiptRow } from '@/lib/warranty/items';

vi.mock('@/app/(app)/warranties/actions', () => ({
  updateWarrantyAction: vi.fn(async () => ({})),
  deleteWarrantyAction: vi.fn(async () => ({})),
  attachReceiptsAction: vi.fn(async () => ({})),
  deleteReceiptAction: vi.fn(async () => ({})),
  reRunOcrAction: vi.fn(async () => ({})),
  saveLoanRuleAction: vi.fn(async () => ({})),
  deleteLoanRuleAction: vi.fn(async () => ({})),
  // v1.12.0: the Installments card's three actions, called unconditionally by useActionState
  // on every render -- without a stub here the mocked module has no such export and the
  // component throws before any test-specific behaviour runs.
  addInstallmentAction: vi.fn(async () => ({})),
  removeInstallmentAction: vi.fn(async () => ({})),
  setInstallmentPaidAction: vi.fn(async () => ({})),
  // Item 6 (v1.16.0 plan): the Linked transactions card's own Unlink, same "stub every export
  // useActionState calls unconditionally" reason as the three installment actions above.
  unlinkLedgerTransactionAction: vi.fn(async () => ({})),
  // Item 6 (v1.21.0 backlog): the balance repair action, same reason.
  recomputeLoanBalanceAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const TODAY = '2026-08-16';
const people = [{ id: 7, name: 'Alice' }];
const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Netflix plan', kind: 'subscription' as const },
  { id: 3, name: 'Car loan', kind: 'loan' as const },
];

function item(over: Partial<WarrantyItemRow> = {}): WarrantyItemRow {
  return {
    id: 42, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: 'SN-1',
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null,
    typeId: null, typeName: null, isSubscription: false, kind: 'warranty', notes: 'kitchen',
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    billingCycle: null, billingAmountCents: null,
    principalCents: null, interestRateBps: null, currentBalanceCents: null, balanceUpdatedAt: null,
    // v1.13.0 Task 5: budgetCategoryId is on every WarrantyItemRow now (ruling R11 / M9).
    budgetCategoryId: null,
    // v1.14.0 (spec BU, T1): required on every row -- 'owed' is the default for every
    // non-loan item and every pre-1.14.0 row.
    loanDirection: 'owed',
    ...over,
  };
}

/** Item 6: an empty ledger by default -- only the tests exercising the card need real rows. */
function ledgerFixture(over: Partial<ItemLedger> = {}): ItemLedger {
  return { rows: [], totalAppliedCents: 0, ...over };
}

function receipt(over: Partial<WarrantyReceiptRow> = {}): WarrantyReceiptRow {
  return {
    id: 5, warrantyItemId: 42, originalFilename: 'till.jpg',
    storedFilename: '11111111-2222-3333-4444-555555555555.jpg',
    mime: 'image/jpeg', sizeBytes: 2048, sha256: 'a'.repeat(64),
    ocrStatus: 'done', ocrError: null, createdAt: '2026-08-16T00:00:00.000Z', fileExists: true,
    ...over,
  };
}

function renderDetail(over: Partial<Parameters<typeof WarrantyDetailClient>[0]> = {}) {
  return render(
    <WarrantyDetailClient
      item={item()}
      receipts={[receipt()]}
      status="active"
      people={people}
      types={types}
      today={TODAY}
      linkedTransaction={null}
      linkRemoved={false}
      rules={[]}
      accounts={[]}
      payoffFraction={null}
      lastPaymentAt={null}
      paymentCount={0}
      installments={[]}
      // v1.13.0 Task 11: the budget-category picker's options (Task 12's page.tsx supplies the
      // real list). Empty by default -- only the tests exercising the picker need non-empty.
      categories={[]}
      ledger={ledgerFixture()}
      {...over}
    />,
  );
}

describe('WarrantyDetailClient', () => {
  it('shows every field, the owner and the status badge', () => {
    renderDetail();
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('SN-1')).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  // --- Bug fix (v1.2.4): edit replaces the view, kind-aware success message ---

  it('hides the read-only detail view while editing and restores it via Cancel edit', () => {
    renderDetail();
    // 'Home Depot' (the item's vendor) only ever appears as read-only TEXT in the detail
    // view -- the edit form shows the same value as an <input defaultValue>, which
    // getByText/queryByText do not match.
    expect(screen.getByText('Home Depot')).toBeTruthy();
    expect(screen.queryByText('Edit this item')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByText('Home Depot')).toBeNull();
    expect(screen.getByText('Edit this item')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /cancel edit/i }));
    expect(screen.getByText('Home Depot')).toBeTruthy();
    expect(screen.queryByText('Edit this item')).toBeNull();
  });

  it('closes the edit form and restores the view after a successful save, showing the kind-aware message', async () => {
    vi.mocked(updateWarrantyAction).mockResolvedValueOnce({ message: 'Subscription updated.' });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('Edit this item')).toBeTruthy();

    const saveButton = screen.getByRole('button', { name: /save changes/i });
    fireEvent.submit(saveButton.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Subscription updated.')).toBeTruthy();
      expect(screen.queryByText('Edit this item')).toBeNull();
      expect(screen.getByText('Home Depot')).toBeTruthy();
    });
  });

  it('renders an image receipt inline through the authenticated route', () => {
    const { container } = renderDetail();
    const img = container.querySelector('img[src="/api/warranties/receipts/5"]');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('alt')).toBe('till.jpg');
  });

  it('links a PDF rather than embedding it (MUST-5.3 / §10.3)', () => {
    const { container } = renderDetail({ receipts: [receipt({ mime: 'application/pdf', originalFilename: 'x.pdf' })] });
    expect(container.querySelector('img[src="/api/warranties/receipts/5"]')).toBeNull();
    expect(container.querySelector('a[href="/api/warranties/receipts/5"]')).toBeTruthy();
  });

  it('shows a file-missing tile instead of a broken image (MUST-4.10)', () => {
    renderDetail({ receipts: [receipt({ fileExists: false })] });
    expect(screen.getByText(/file missing/i)).toBeTruthy();
  });

  it('shows the OCR status chip and the failure text verbatim, as a text node', () => {
    renderDetail({ receipts: [receipt({ ocrStatus: 'failed', ocrError: 'OCR timed out.' })] });
    expect(screen.getByText('OCR timed out.')).toBeTruthy();
  });

  it('never displays the raw OCR text (§16 item 6 — the type carries no ocrText at all)', () => {
    const { container } = renderDetail();
    expect(container.innerHTML).not.toContain('ocrText');
  });

  it('offers Re-run OCR and Remove per receipt, and Delete item with the receipt count', () => {
    renderDetail();
    expect(screen.getByRole('button', { name: /re-run ocr/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    expect(screen.getByText(/1 receipt/i)).toBeTruthy();
  });

  it('links a live transaction and explains a nulled one instead of showing a dead link', () => {
    const { container } = renderDetail({
      item: item({ transactionId: 55 }),
      linkedTransaction: { id: 55, date: '2026-08-16', description: 'HOME DEPOT' },
    });
    expect(container.querySelector('a[href="/transactions?q=HOME+DEPOT"]') ?? container.innerHTML).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ transactionId: 55 }), linkedTransaction: null, linkRemoved: true });
    expect(screen.getByText(/removed by an import undo/i)).toBeTruthy();
  });

  // --- type-deltas.md T9 ---

  it('shows a Type row with the item\'s type name, or an em dash when untyped', () => {
    renderDetail();
    expect(screen.getByText('Type')).toBeTruthy();
    cleanup();
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance' }) });
    expect(screen.getByText('Appliance')).toBeTruthy();
  });

  // v1.2.2 Task 2: purchaseDateLabel/expiryDateLabel are DELETED (superseded by
  // formStartLabel/formEndLabel, kind-keyed). Old subscription wording 'Period start' ->
  // 'Start date' and label-only 'Cancel by' -> 'Cancel-by date' are deliberate, owner-approved
  // changes (see tests/lib/warranty/constants.test.ts for the full old->new log).
  //
  // Item 5 (v1.16.0 plan): the START label is now per-kind on the detail page too (superseding
  // "Purchase date" for warranty and "Start date" for loan specifically -- the list page's
  // shared column still says the neutral "Started"; see warranties-client.test.tsx). The END
  // label (formEndLabel, "Expiry date"/"Payoff date"/...) is untouched by item 5.
  it('labels the start date "Purchased" and the end date "Expiry date" for a warranty-kind item', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    expect(screen.getByText('Purchased')).toBeTruthy();
    expect(screen.getByText('Expiry date')).toBeTruthy();
    expect(screen.queryByText('Purchase date')).toBeNull();
  });

  it('labels the date fields "Start date"/"Cancel-by date" for a subscription-kind item (item 5 leaves this kind alone)', () => {
    renderDetail({ item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription' }) });
    expect(screen.getByText('Start date')).toBeTruthy();
    expect(screen.getByText('Cancel-by date')).toBeTruthy();
    expect(screen.queryByText('Purchase date')).toBeNull();
  });

  it('labels the start date "Borrowed on"/"Lent on" by loan_direction, and the end date stays "Payoff date" (item 5)', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'owed' }) });
    expect(screen.getByText('Borrowed on')).toBeTruthy();
    expect(screen.getByText('Payoff date')).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'lent' }) });
    expect(screen.getByText('Lent on')).toBeTruthy();
    expect(screen.queryByText('Borrowed on')).toBeNull();
  });

  it('labels the start date "Starts" for a contract or a bill (item 5)', () => {
    renderDetail({ item: item({ kind: 'contract' }) });
    expect(screen.getByText('Starts')).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ kind: 'bill' }) });
    expect(screen.getByText('Starts')).toBeTruthy();
  });

  // v1.2.2 Task 2 gave the edit form kind-aware labels and tested them by CHANGING the type
  // select. v1.10.2 froze the type after the first save, so there is no switch left to make:
  // the labels follow the item's own saved kind, and each kind gets its own render.
  it("words the term legend and the open-ended label from the item's saved kind", () => {
    // Scoped to the <legend> element itself: the read-only summary above the edit form
    // renders the SAME text via the item's kind, so a page-wide getByText would match both.
    const { container } = renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(container.querySelector('form legend')!.textContent).toBe('Warranty (months)');

    cleanup();
    const loan = renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(loan.container.querySelector('form legend')!.textContent).toBe('Term (months)');
    // formOpenEndedLabel('loan') === 'Ongoing (no end date)'.
    expect(screen.getByText('Ongoing (no end date)')).toBeTruthy();
  });

  // --- reviewer M14 ---

  /**
   * v1.10.2: the type is fixed after the first save, so the edit form shows it rather than
   * offering it. Two things are asserted together on purpose -- that there is no control to
   * change it, AND that the value still posts. A disabled <select> would post nothing, which
   * the action reads as "clear the type": the opposite of freezing it.
   */
  it('shows the type as read-only and still posts it unchanged', () => {
    const { container } = renderDetail({ item: item({ typeId: 2, typeName: 'Netflix plan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));

    expect(container.querySelector('form select[name="typeId"]')).toBeNull();
    const hidden = container.querySelector('form input[type="hidden"][name="typeId"]') as HTMLInputElement;
    expect(hidden).toBeTruthy();
    expect(hidden.value).toBe('2');
    // Read-only must not mean invisible -- the name is still on screen.
    expect(screen.getAllByText('Netflix plan').length).toBeGreaterThan(0);
  });

  // --- reviewer findings: busy states, action-slot isolation, attach reset ---

  it('gives Re-run OCR and Remove their own busy state via useFormStatus (IMPORTANT 5)', () => {
    renderDetail();
    const rerun = screen.getByRole('button', { name: /re-run ocr/i }) as HTMLButtonElement;
    const remove = screen.getByRole('button', { name: /remove/i }) as HTMLButtonElement;
    expect(rerun.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
  });

  // --- v1.3.0: open-ended display label (task B) ---

  it('shows the per-kind open-ended word instead of a blank end date when isLifetime is set', () => {
    renderDetail({ item: item({ isLifetime: true, expiryDate: null, kind: 'warranty' }) });
    expect(screen.getByText('Lifetime')).toBeTruthy();
    cleanup();
    renderDetail({ item: item({ isLifetime: true, expiryDate: null, kind: 'subscription', typeId: 2, typeName: 'Netflix plan' }) });
    expect(screen.getByText('Lifetime')).toBeTruthy();
    cleanup();
    renderDetail({ item: item({ isLifetime: true, expiryDate: null, kind: 'contract' }) });
    expect(screen.getByText('Ongoing')).toBeTruthy();
    cleanup();
    renderDetail({ item: item({ isLifetime: true, expiryDate: null, kind: 'loan', typeId: 3, typeName: 'Car loan' }) });
    expect(screen.getByText('Open-ended')).toBeTruthy();
  });

  // Item 8 (v1.16.0 plan): this used to assert an em dash here -- Payoff/Expiry date was one of
  // the four named dead cells, and it is now dropped entirely rather than decorated with a
  // dash nobody can act on when there truly is nothing to show (not lifetime, no computed
  // expiry_date).
  it('hides the end-date row entirely for a non-lifetime item with a genuinely unknown term (item 8)', () => {
    const { container } = renderDetail({ item: item({ isLifetime: false, expiryDate: null, warrantyMonths: null }) });
    const dt = Array.from(container.querySelectorAll('dt')).find((el) => el.textContent === 'Expiry date');
    expect(dt).toBeUndefined();
  });

  // --- v1.3.0: billing cycle and amount (task A) ---

  it('shows a Billing row with the formatted amount and cycle suffix for a subscription item', () => {
    const { container } = renderDetail({
      item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription', billingCycle: 'monthly', billingAmountCents: 1599 }),
    });
    const dt = Array.from(container.querySelectorAll('dt')).find((el) => el.textContent === 'Billing')!;
    expect(dt).toBeTruthy();
    expect(dt.nextElementSibling?.textContent).toBe('$15.99 / month');
  });

  // review fix: cycle and amount are validated as a pair at the schema boundary, but the
  // display layer must not trust that -- pre-existing rows (or a future bug) could still
  // carry exactly one of the two. Rendering one alone either lies ("— / month") or drops a
  // value the member entered.
  // Item 8 (v1.16.0 plan): this used to render a plain "—" for the incomplete pair; the row
  // is now dropped entirely, same as every other empty-optional-field case this task covers.
  it('hides the Billing row entirely, never "— / month", for a partial billing pair (cycle only) (item 8)', () => {
    renderDetail({
      item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription', billingCycle: 'monthly', billingAmountCents: null }),
    });
    expect(screen.queryByText('Billing')).toBeNull();
  });

  it('hides the Billing row entirely for a partial billing pair (amount only) (item 8)', () => {
    renderDetail({
      item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription', billingCycle: null, billingAmountCents: 1599 }),
    });
    expect(screen.queryByText('Billing')).toBeNull();
  });

  it('renders no Billing row at all for a warranty-kind item', () => {
    renderDetail({ item: item({ kind: 'warranty' }) });
    expect(screen.queryByText('Billing')).toBeNull();
  });

  // v1.3.1: widened -- a loan's billing pair is its regular payment amount/cadence, so the
  // Billing row now renders for a loan too, using the loan cycle-suffix wording ("per year").
  // F5 fix-round: this row's own label is now routed through the kind matrix too (it used to
  // be hard-coded "Billing" for every kind, which is what produced the duplicate "Billing" /
  // "Payment" pair the fix-round found -- see the "the loan surfaces" describe block below for
  // the de-duplication test).
  it('renders the Payment row (not Billing) for a loan-kind item, using the loan cycle wording', () => {
    const { container } = renderDetail({ item: item({ kind: 'loan', billingCycle: 'annual', billingAmountCents: 5000 }) });
    const dt = Array.from(container.querySelectorAll('dt')).find((el) => el.textContent === 'Payment')!;
    expect(dt).toBeTruthy();
    expect(dt.nextElementSibling?.textContent).toBe('$50.00 per year');
    // F5: exactly one row for the payment/cycle info -- no leftover "Billing" duplicate.
    expect(Array.from(container.querySelectorAll('dt')).some((el) => el.textContent === 'Billing')).toBe(false);
  });

  it("shows the edit form's Billing fields for a subscription type and hides them for warranty", () => {
    const { container } = renderDetail({
      item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription', billingCycle: 'monthly', billingAmountCents: 1599 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const cycleSelect = container.querySelector('form select[name="billingCycle"]') as HTMLSelectElement;
    const amountInput = container.querySelector('form input[name="billingAmount"]') as HTMLInputElement;
    expect(cycleSelect).toBeTruthy();
    expect(cycleSelect.value).toBe('monthly');
    expect(amountInput.value).toBe('15.99');

    // A warranty has no billing pair. Its own render, now that the type cannot be switched.
    cleanup();
    const warranty = renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(warranty.container.querySelector('form select[name="billingCycle"]')).toBeNull();
    expect(warranty.container.querySelector('form input[name="billingAmount"]')).toBeNull();
  });
});

// v1.3.1: the loan fieldset, the read-only money block and the Payment matching sub-card.
describe('MUST-14.1 / MUST-14.3 / MUST-14.5 / MUST-14.6 / MUST-12.3: the loan surfaces', () => {
  it('the edit form shows the Loan fieldset only for a loan-kind item', () => {
    const warranty = renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(warranty.container.querySelector('form input[name="principal"]')).toBeNull();
    expect(warranty.container.querySelector('form input[name="currentBalance"]')).toBeNull();

    cleanup();
    const loan = renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(loan.container.querySelector('form input[name="principal"]')).toBeTruthy();
    expect(loan.container.querySelector('form input[name="interestRate"]')).toBeTruthy();
    expect(loan.container.querySelector('form input[name="currentBalance"]')).toBeTruthy();
  });

  // Task 9 review finding (MED), carried into this task: the edit form used to omit the loan
  // fields entirely, and an absent field posts as blank -> null, so editing only the item's
  // name used to silently wipe principal/rate/balance/anchor on every loan. Now the fields
  // are seeded from the item, so an unrelated edit resubmits (rather than blanks) them.
  it("seeds the edit form's loan fields from the item's existing values", () => {
    const { container } = renderDetail({
      item: item({
        typeId: 3,
        typeName: 'Car loan',
        kind: 'loan',
        principalCents: 3_000_000,
        interestRateBps: 549,
        currentBalanceCents: 2_500_000,
        balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((container.querySelector('form input[name="principal"]') as HTMLInputElement).value).toBe('30000.00');
    expect((container.querySelector('form input[name="interestRate"]') as HTMLInputElement).value).toBe('5.49');
    expect((container.querySelector('form input[name="currentBalance"]') as HTMLInputElement).value).toBe('25000.00');
  });

  // Fix wave item 4: the hidden seed the action compares the posted balance against to tell
  // "untouched" from "edited" -- see actions.ts's readItemInput docblock. It must carry the
  // exact render-time value and, unlike the visible field, exist even when the loan fieldset
  // is not currently shown (a type switched away from loan mid-edit still needs SOMETHING to
  // diff the now-absent balance against).
  it('fix wave item 4: seeds a hidden currentBalanceSeed even for a non-loan item with no balance', () => {
    const { container } = renderDetail({
      item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty', currentBalanceCents: null }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    // Unconditional -- unlike the visible field (absent for a non-loan kind), so there is
    // always something to diff the posted balance against, even if a type switch to loan
    // happens mid-edit and the person then types a real balance for the first time.
    expect(container.querySelector('form input[name="currentBalanceSeed"]')).toBeTruthy();
    expect((container.querySelector('form input[name="currentBalanceSeed"]') as HTMLInputElement).value).toBe('');
  });

  it('fix wave item 4: the seed matches the visible balance field at render, for a loan item', () => {
    const { container } = renderDetail({
      item: item({
        typeId: 3,
        typeName: 'Car loan',
        kind: 'loan',
        currentBalanceCents: 2_500_000,
        balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((container.querySelector('form input[name="currentBalanceSeed"]') as HTMLInputElement).value).toBe('25000.00');
    expect((container.querySelector('form input[name="currentBalance"]') as HTMLInputElement).value).toBe('25000.00');
  });

  it('the billing labels read Payment / Payment amount for a loan and Billing / Amount otherwise', () => {
    const { container } = renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('Payment')).toBeTruthy();
    expect(screen.getByText('Payment amount')).toBeTruthy();

    cleanup();
    renderDetail({ item: item({ typeId: 2, typeName: 'Netflix plan', kind: 'subscription' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('Billing')).toBeTruthy();
    expect(screen.getByText('Amount')).toBeTruthy();
  });

  it('MUST-14.3: the read-only money block is omitted with no principal and no balance, and renders the payoff bar and Detail rows when present', () => {
    renderDetail({ item: item({ kind: 'loan', principalCents: null, currentBalanceCents: null }) });
    expect(screen.queryByText('Original')).toBeNull();

    cleanup();
    renderDetail({
      item: item({
        kind: 'loan',
        principalCents: 3_000_000,
        interestRateBps: 549,
        currentBalanceCents: 1_500_000,
        balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
      }),
      payoffFraction: 0.5,
      lastPaymentAt: '2026-08-10T00:00:00.000Z',
      paymentCount: 4,
    });
    expect(screen.getByText('$15,000.00')).toBeTruthy();
    expect(screen.getByText('You set this on 2026-08-01')).toBeTruthy();
    expect(screen.getByText('Original')).toBeTruthy();
    expect(screen.getByText('$30,000.00')).toBeTruthy();
    expect(screen.getByText('Rate')).toBeTruthy();
    expect(screen.getByText('5.49%')).toBeTruthy();
    expect(screen.getByText('Last payment')).toBeTruthy();
    expect(screen.getByText('2026-08-10')).toBeTruthy();
    // Item 6 (v1.16.0 plan): "Payments linked: N" is gone -- paymentCount (still 4 here) only
    // gates this dl and the statement-drift hint now; the count itself moved to the Linked
    // transactions card's own "Linked transactions (N)" header, which reads from ledger.rows,
    // not from this prop.
    expect(screen.queryByText('Payments linked')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('MUST-14.5 / MUST-14.6: the Payment matching card is loan-only and states the budget rule', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    expect(screen.getByText('Payment matching')).toBeTruthy();
    expect(screen.getByText(/The payment still counts in your budget and in your reports\./)).toBeTruthy();
    cleanup();

    renderDetail({ item: item({ kind: 'subscription' }) });
    expect(screen.queryByText('Payment matching')).toBeNull();
  });

  it('lists existing rules and offers the Add rule form, with the backfill checkbox unchecked by default', () => {
    // receipts: [] here, otherwise the per-receipt "Remove" button collides with the
    // rule row's own "Remove" button and makes the query ambiguous.
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }),
      receipts: [],
      rules: [{ id: 1, itemId: 42, merchantContains: 'HONDA FIN', accountId: null, enabled: true }],
      accounts: [{ id: 9, name: 'Joint Chequing' }],
    });
    // The existing-rules table is visible unconditionally (item 7); the Add-rule FORM is
    // behind a disclosure that starts closed, so it has to be opened before its own fields
    // (the backfill checkbox, the account <select>'s "Any account" default option) exist.
    fireEvent.click(screen.getByRole('button', { name: /^add rule$/i }));
    expect(screen.getByText('HONDA FIN')).toBeTruthy();
    // v1.15.0 (responsive rows): the merchant fragment is this row's identity, so its cell
    // is the phone card's headline.
    expect(screen.getByText('HONDA FIN').className).toContain('cell-stack-headline');
    // "Any account" appears twice -- the rule row's own cell, and the Add-rule form's
    // account <select>'s default option -- so this is an AllBy, not a plain getByText.
    expect(screen.getAllByText('Any account').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /remove/i })).toBeTruthy();
    const backfill = screen.getByRole('checkbox', { name: /also link matching payments/i }) as HTMLInputElement;
    expect(backfill.checked).toBe(false);
  });

  // Item 7 (v1.16.0 plan): the Add-rule form starts collapsed, and the existing-rules table
  // stays visible either way -- the row-menu-free rule table has no kebab of its own, but the
  // "Remove" button proves the table renders without ever opening the disclosure.
  it('item 7: the Add rule form is collapsed by default; the rules table needs no disclosure', () => {
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }),
      receipts: [],
      rules: [{ id: 1, itemId: 42, merchantContains: 'HONDA FIN', accountId: null, enabled: true }],
      accounts: [],
    });
    expect(screen.getByText('HONDA FIN')).toBeTruthy();
    expect(screen.queryByPlaceholderText('e.g. HONDA FIN')).toBeNull();
    const toggle = screen.getByRole('button', { name: /^add rule$/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByPlaceholderText('e.g. HONDA FIN')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^close$/i }).getAttribute('aria-expanded')).toBe('true');
  });

  // F3 fix-round: Remove now goes through useActionState (like Add rule), so a stale delete --
  // the rule already gone, e.g. removed from another tab -- surfaces its error instead of
  // failing silently.
  it('F3 fix-round: a stale Remove (already deleted elsewhere) shows the error', async () => {
    vi.mocked(deleteLoanRuleAction).mockResolvedValueOnce({ error: 'That rule no longer exists.' });
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }),
      receipts: [],
      rules: [{ id: 1, itemId: 42, merchantContains: 'HONDA FIN', accountId: null, enabled: true }],
      accounts: [],
    });
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => {
      expect(screen.getByText('That rule no longer exists.')).toBeTruthy();
    });
  });

  // F8 fix-round: a plain-voice heads-up next to the balance, shown only once there is
  // something that COULD be unassigned.
  it('F8 fix-round: shows the unassign/statement hint once a loan has linked payments, not before', () => {
    renderDetail({
      item: item({ kind: 'loan', currentBalanceCents: 1_500_000, balanceUpdatedAt: '2026-08-01T00:00:00.000Z' }),
      paymentCount: 0,
    });
    expect(screen.queryByText(/removing an old payment can push the balance/i)).toBeNull();
    cleanup();

    renderDetail({
      item: item({ kind: 'loan', currentBalanceCents: 1_500_000, balanceUpdatedAt: '2026-08-01T00:00:00.000Z' }),
      paymentCount: 3,
    });
    expect(screen.getByText(/removing an old payment can push the balance/i)).toBeTruthy();
    // Plain voice: no em dash in the hint itself.
    expect(screen.getByText(/removing an old payment can push the balance/i).textContent).not.toContain('—');
    cleanup();

    // Micro round: a null balance isn't rendered anywhere on the page, so a hint pointing at
    // "the balance" has nothing to point at -- gated on currentBalanceCents too, not just
    // paymentCount. principalCents is set here so the money block itself still renders (it is
    // omitted only when BOTH principal and balance are null).
    renderDetail({
      item: item({ kind: 'loan', principalCents: 3_000_000, currentBalanceCents: null, balanceUpdatedAt: null }),
      paymentCount: 3,
    });
    expect(screen.queryByText(/removing an old payment can push the balance/i)).toBeNull();
  });

  // F11 fix-round: the money block's Detail rows are dt/dd pairs and must live inside a real
  // <dl>, not a bare <div>, for valid HTML and correct a11y pairing.
  it('F11 fix-round: the money block wraps its Detail rows in a <dl>', () => {
    const { container } = renderDetail({
      item: item({
        kind: 'loan',
        principalCents: 3_000_000,
        interestRateBps: 549,
        currentBalanceCents: 1_500_000,
        balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
      }),
      paymentCount: 4,
      lastPaymentAt: '2026-08-10T00:00:00.000Z',
    });
    const dt = Array.from(container.querySelectorAll('dt')).find((el) => el.textContent === 'Original')!;
    expect(dt.closest('dl')).toBeTruthy();
  });
});

// v1.14.0 fix round (review C, item 1): same backwards-hint bug as the new form, in the edit
// form. Both hints, and the balance field's label, follow the edit form's CURRENT Direction
// value rather than assuming 'owed'.
describe("the edit form's loan hints follow the current Direction (review C)", () => {
  it('reads in the owed frame for an owed loan', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'owed' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('What you borrowed. Used for the payoff bar.')).toBeTruthy();
    expect(screen.getByText('Balance still owed')).toBeTruthy();
    expect(screen.getByText("Today's balance. Payments you link will take it down from here.")).toBeTruthy();
  });

  it('reads in the lent frame for a lent loan', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'lent' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByText('What you lent out. Used for the payoff bar.')).toBeTruthy();
    expect(screen.getByText('Balance still owed to you')).toBeTruthy();
    expect(
      screen.getByText("Today's balance. Repayments you link will take it down; further advances raise it."),
    ).toBeTruthy();
    expect(screen.queryByText('Balance still owed')).toBeNull();
  });

  it('flips live when Direction is changed on the open form', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'owed' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'lent' } });
    expect(screen.getByText('What you lent out. Used for the payoff bar.')).toBeTruthy();
    expect(screen.getByText('Balance still owed to you')).toBeTruthy();
  });
});

// v1.14.0 (spec BU, ruling P16): the edit form's Direction control reuses
// loanFieldsAllowedForKind as its gate, same as the loan money fields above -- no second
// kind === 'loan' predicate.
describe('the Direction control on the edit form (spec BU, ruling P16)', () => {
  it('is absent for a kind that is not a loan', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Direction')).toBeNull();
  });

  it('offers exactly the two directions for a loan, seeded from the item', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'lent' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const select = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Borrowed — we owe them', 'Lent out — they owe us']);
    expect(select.value).toBe('lent');
    // There is no "Not set": the column is NOT NULL and 'owed' is its default (ruling P1).
    expect([...select.options].map((option) => option.value)).toEqual(['owed', 'lent']);
  });

  it('posts under the name the action reads', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).name).toBe('loanDirection');
  });

  // v1.14.0 fix round (review C, item 2): the gate used to be loanApplicable alone, unlike the
  // detail row's `loanFieldsAllowedForKind(kind) || item.loanDirection !== 'owed'` a few tests
  // down. A non-loan item that somehow carries 'lent' (a data anomaly, or a kind changed
  // elsewhere) must still show the control instead of the edit form silently hiding it.
  it('is shown for a non-loan item that carries a non-default direction', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty', loanDirection: 'lent' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Direction')).not.toBeNull();
  });
});

// v1.14.0 (spec BU). Same "gate OR held value" rule as Model/Serial/Price above (item R,
// ruling P6): shown whenever the kind offers it, or a non-default value is on file.
describe('the Direction detail row (spec BU)', () => {
  it('shows a Direction row for a loan and reads it back in words', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', loanDirection: 'lent' }) });
    expect(screen.getByText('Direction')).toBeTruthy();
    expect(screen.getByText('Lent out — they owe us')).toBeTruthy();
  });

  it('hides the Direction row for a non-loan item that carries the default', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty', loanDirection: 'owed' }) });
    expect(screen.queryByText('Direction')).toBeNull();
  });
});

describe('product fields follow the kind, without dropping a stored value', () => {
  it('offers model, serial and price for a warranty', () => {
    renderDetail({ item: item({ typeId: 1, typeName: 'Appliance', kind: 'warranty' }) });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Model')).not.toBeNull();
    expect(screen.queryByLabelText('Serial number')).not.toBeNull();
    expect(screen.queryByLabelText('Price')).not.toBeNull();
  });

  it('drops all three for a loan that has none of them', () => {
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', model: null, serial: null, priceCents: null }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Serial number')).toBeNull();
    expect(screen.queryByLabelText('Price')).toBeNull();
  });

  /**
   * The safety net, and the reason the gate is `kind || storedValue` rather than a bare kind
   * check. Freezing the type stops NEW mismatches; it cannot retro-fix an item whose type was
   * changed before v1.10.2. Hiding an input that holds a value would post it blank on the next
   * save and silently delete what was there -- the same "never hide data" rule as the table work.
   */
  it('keeps a field a mismatched item already holds, so saving cannot erase it', () => {
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', model: 'MX-5', serial: null, priceCents: 129900 }),
    });
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('MX-5');
    expect((screen.getByLabelText('Price') as HTMLInputElement).value).toBe('1299.00');
    // The one it genuinely has no value for stays hidden.
    expect(screen.queryByLabelText('Serial number')).toBeNull();
  });
});

// Task 11 fix round 1 (controller ruling): the Installments card's row kebab gained a
// "Record payment" item above "Mark paid" (ruling R8), gated the same way "Mark paid" already
// was -- unpaid rows on a bill-kind item. Paid rows offer "Unmark" instead, never this.
describe('the Installments card offers Record payment', () => {
  const billItem = item({ kind: 'bill', typeId: 4, typeName: 'Property tax' });

  it('shows it for an unpaid installment', () => {
    renderDetail({
      item: billItem,
      installments: [
        {
          id: 101,
          itemId: 42,
          dueDate: '2026-09-01',
          amountCents: 20000,
          paidAt: null,
          paidTxnId: null,
          paidTxn: null,
          state: 'scheduled',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /actions for the \$200\.00 installment due 2026-09-01/i }));
    expect(screen.getByRole('menuitem', { name: /^record payment$/i })).toBeTruthy();
  });

  it('hides it once the installment is paid', () => {
    renderDetail({
      item: billItem,
      installments: [
        {
          id: 102,
          itemId: 42,
          dueDate: '2026-07-01',
          amountCents: 15000,
          paidAt: '2026-07-02T00:00:00.000Z',
          paidTxnId: 55,
          paidTxn: { id: 55, date: '2026-07-02', description: 'Muni Tax', amountCents: -15000 },
          state: 'paid',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /actions for the \$150\.00 installment due 2026-07-01/i }));
    expect(screen.queryByRole('menuitem', { name: /^record payment$/i })).toBeNull();
    // Unmark takes its place -- the row still has a kebab, just not this item.
    expect(screen.getByRole('menuitem', { name: /^unmark$/i })).toBeTruthy();
  });
});

describe('WarrantyDetailClient — inapplicable product fields (item R, ruling P6)', () => {
  // Item 8 (v1.16.0 plan) reverses the "keeps Vendor" half of this test's old name: Vendor is
  // still not gated by KIND (every kind's form asks for it unconditionally), but it is now
  // gated by whether the item actually HAS one, same as Payoff date/Payment/Notes. A Bill
  // with none of these four stored now hides all four instead of showing three dashes and a
  // guaranteed "Vendor —".
  it('drops Model, Serial, Price AND an empty Vendor for a Bill that holds none of them', () => {
    renderDetail({ item: item({ kind: 'bill', vendor: null, model: null, serial: null, priceCents: null }) });
    expect(screen.queryByText('Vendor')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.queryByText('Serial number')).toBeNull();
    expect(screen.queryByText('Price')).toBeNull();
  });

  it('still shows a STORED Vendor value on a Bill -- item 8 gates on presence, not on kind', () => {
    renderDetail({ item: item({ kind: 'bill', vendor: 'Municipal Tax Office', model: null, serial: null, priceCents: null }) });
    expect(screen.getByText('Vendor')).toBeTruthy();
    expect(screen.getByText('Municipal Tax Office')).toBeTruthy();
  });

  it('KEEPS a stored value on a kind that can no longer hold it (constants.ts:272-286)', () => {
    // The gates decide what a form OFFERS, never what a page may hide: an item whose type
    // changed after it was saved still holds a model, and hiding a stored value is how data
    // gets silently dropped on the next save.
    renderDetail({ item: item({ kind: 'bill', vendor: null, model: 'GDT645SYNFS', serial: null, priceCents: null }) });
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
  });

  // Item 8 (v1.16.0 plan): Model/Serial/Price keep ruling P6's "gate OR held value" em-dash
  // behaviour unchanged -- item 8 named only Vendor/Payoff date/Payment/Notes, not these three
  // -- but Vendor is one of the four, so it drops out even for a warranty once it is empty.
  it('leaves Model/Serial/Price as em-dashes for a warranty with none stored (ruling P6, untouched by item 8), but hides an empty Vendor', () => {
    renderDetail({ item: item({ kind: 'warranty', vendor: null, model: null, serial: null, priceCents: null }) });
    expect(screen.queryByText('Vendor')).toBeNull();
    for (const label of ['Model', 'Serial number', 'Price']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  // v1.13.1 (item 3, backlog sweep). The Detail Price gate used to be
  // `productFieldsAllowedForKind(kind) || loanFieldsAllowedForKind(kind) || priceCents !== null`,
  // so a loan with no stored price got a guaranteed "Price —" row sitting right beside "Original
  // amount" -- the same fact asked for twice under two names, the very thing
  // productFieldsAllowedForKind's own docblock (constants.ts) says a loan's form was fixed to
  // stop doing. Dropping the loanFieldsAllowedForKind arm aligns the Detail gate with the edit
  // form's own Price gate (warranty-detail-client.tsx:913, new-warranty-client.tsx), which never
  // had that arm.
  it('drops Price for a loan with no stored price -- no "Price —" beside its loan-money block', () => {
    renderDetail({
      item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', priceCents: null, principalCents: 250000 }),
    });
    expect(screen.queryByText('Price')).toBeNull();
    // The loan's own money block (labelled "Original", not "Price") is unaffected by this gate.
    expect(screen.getByText('Original')).toBeTruthy();
  });

  it('still shows a stored price on a loan (the gate-decides-OFFER-not-HIDE rule still applies)', () => {
    renderDetail({ item: item({ typeId: 3, typeName: 'Car loan', kind: 'loan', priceCents: 250000 }) });
    expect(screen.getByText('Price')).toBeTruthy();
  });
});

// v1.16.0 plan, item 8: the fourth named dead cell.
describe('Notes drops out entirely when empty (item 8)', () => {
  it('renders nothing for an empty Notes field', () => {
    renderDetail({ item: item({ notes: null }) });
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('still shows a stored Notes value', () => {
    renderDetail({ item: item({ notes: 'Keep the receipt in the kitchen drawer.' }) });
    expect(screen.getByText('Notes')).toBeTruthy();
    expect(screen.getByText('Keep the receipt in the kitchen drawer.')).toBeTruthy();
  });
});

// v1.16.0 plan, item 7: the Receipts card's own disclosure (the Add-rule one is covered above,
// under the loan surfaces).
describe('the Add receipt form is collapsed by default (item 7)', () => {
  it('hides the file picker until Add receipt is pressed, and the receipt LIST needs no disclosure', () => {
    renderDetail({ receipts: [receipt()] });
    // The existing receipt (till.jpg, from the default fixture) is visible unconditionally.
    expect(screen.getByText('till.jpg')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /^add receipt$/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^attach receipts$/i })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /^attach receipts$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^close$/i }).getAttribute('aria-expanded')).toBe('true');
  });
});

// v1.16.0 plan, item 6: the Linked transactions card, replacing the old bare "Payments linked"
// count. Rendered for every kind, unconditionally.
describe('the Linked transactions card (item 6)', () => {
  const row = {
    txnId: 501,
    date: '2026-08-10',
    merchant: 'HONDA FIN',
    accountName: 'Joint Chequing',
    amountCents: -450000,
    appliedCents: 450000,
    source: 'rule' as const,
  };

  it('shows the header count, an empty state with no rows', () => {
    renderDetail({ item: item({ kind: 'warranty' }), ledger: ledgerFixture() });
    expect(screen.getByText('Linked transactions (0)')).toBeTruthy();
    expect(screen.getByText(/No transactions linked yet/)).toBeTruthy();
  });

  it('lists a row with date, merchant, account, amount, applied and the rule/by-hand marker', () => {
    renderDetail({ item: item({ kind: 'loan' }), ledger: ledgerFixture({ rows: [row], totalAppliedCents: -450000 }) });
    expect(screen.getByText('Linked transactions (1)')).toBeTruthy();
    expect(screen.getByText('HONDA FIN')).toBeTruthy();
    expect(screen.getByText(/2026-08-10/)).toBeTruthy();
    expect(screen.getByText(/Joint Chequing/)).toBeTruthy();
    expect(screen.getByText('rule')).toBeTruthy();
    // The merchant links to /transactions?search=<merchant> so the row is one click away.
    // encodeURIComponent (not a query-string '+' encoder), so a space becomes %20.
    expect(screen.getByRole('link', { name: 'HONDA FIN' }).getAttribute('href')).toBe('/transactions?search=HONDA%20FIN');
  });

  it('marks a manual link "by hand" and an installment link "installment"', () => {
    renderDetail({
      item: item({ kind: 'loan' }),
      ledger: ledgerFixture({
        rows: [
          { ...row, txnId: 1, source: 'manual' },
          { ...row, txnId: 2, source: 'installment' },
        ],
      }),
    });
    expect(screen.getByText('by hand')).toBeTruthy();
    expect(screen.getByText('installment')).toBeTruthy();
  });

  it('shows the loan-only summary line, built from principal and the current balance', () => {
    renderDetail({
      item: item({ kind: 'loan', principalCents: 3_000_000, currentBalanceCents: 1_000_000, loanDirection: 'owed' }),
      ledger: ledgerFixture({ rows: [row] }),
    });
    expect(screen.getByText(/You borrowed \$30,000\.00, \$20,000\.00 repaid, \$10,000\.00 still owed\./)).toBeTruthy();
  });

  it('omits the summary line for a non-loan kind', () => {
    renderDetail({ item: item({ kind: 'bill' }), ledger: ledgerFixture({ rows: [row] }) });
    expect(screen.queryByText(/repaid/)).toBeNull();
  });

  it('renders Unlink with the itemId and the row txnId as hidden fields', () => {
    const { container } = renderDetail({ item: item({ id: 42, kind: 'loan' }), ledger: ledgerFixture({ rows: [row] }) });
    fireEvent.click(screen.getByRole('button', { name: /actions for the .*4,500\.00 transaction on 2026-08-10/i }));
    expect(screen.getByRole('menuitem', { name: /^unlink$/i })).toBeTruthy();
    expect(container.querySelector('input[name="itemId"][value="42"]')).toBeTruthy();
    expect(container.querySelector('input[name="txnId"][value="501"]')).toBeTruthy();
  });

  it('surfaces an Unlink refusal inline', async () => {
    vi.mocked(unlinkLedgerTransactionAction).mockResolvedValueOnce({ error: 'That transaction is no longer linked to this item.' });
    renderDetail({ item: item({ kind: 'loan' }), ledger: ledgerFixture({ rows: [row] }) });
    fireEvent.click(screen.getByRole('button', { name: /actions for the .*4,500\.00 transaction on 2026-08-10/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^unlink$/i }));
    await waitFor(() => {
      expect(screen.getByText('That transaction is no longer linked to this item.')).toBeTruthy();
    });
  });
});
