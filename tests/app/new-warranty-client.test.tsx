// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { NewWarrantyClient } from '@/app/(app)/warranties/new/new-warranty-client';
import type { ItemKind } from '@/lib/warranty/constants';

vi.mock('@/app/(app)/warranties/actions', () => ({
  createWarrantyAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];
const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Netflix plan', kind: 'subscription' as const },
  { id: 3, name: 'Car loan', kind: 'loan' as const },
];

function renderForm(
  over: {
    prefill?: object;
    typeId?: number | null;
    types?: { id: number; name: string; kind: ItemKind }[];
    isAdmin?: boolean;
  } = {},
) {
  return render(
    <NewWarrantyClient
      people={people}
      types={over.types ?? types}
      currentUserId={7}
      today="2026-08-16"
      prefill={over.prefill ?? {}}
      isAdmin={over.isAdmin ?? true}
    />,
  );
}

describe('NewWarrantyClient', () => {
  it('renders every field of §10.3 and defaults the owner to the current user', () => {
    const { container } = renderForm();
    for (const name of ['name', 'vendor', 'model', 'serial', 'purchaseDate', 'warrantyMonths', 'price', 'notes']) {
      expect(container.querySelector(`[name="${name}"]`), `missing ${name}`).toBeTruthy();
    }
    expect((container.querySelector('[name="ownerUserId"]') as HTMLSelectElement).value).toBe('7');
    expect(container.querySelector('input[name="isLifetime"][type="checkbox"]')).toBeTruthy();
    expect((container.querySelector('[name="name"]') as HTMLInputElement).required).toBe(true);
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).type).toBe('date');
  });

  it('caps the purchase date input at today so a future date cannot be picked', () => {
    const { container } = renderForm();
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).max).toBe('2026-08-16');
  });

  it('shows the live computed expiry beside the months input (MUST-10.4)', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="purchaseDate"]')!, { target: { value: '2026-01-31' } });
    fireEvent.change(container.querySelector('[name="warrantyMonths"]')!, { target: { value: '1' } });
    expect(screen.getByText('Covered through 2026-02-28')).toBeTruthy();
  });

  it('disables and clears the months input when Lifetime is ticked (MUST-3.5)', () => {
    const { container } = renderForm();
    const months = container.querySelector('[name="warrantyMonths"]') as HTMLInputElement;
    fireEvent.change(months, { target: { value: '24' } });
    fireEvent.click(container.querySelector('input[name="isLifetime"]')!);
    expect(months.disabled).toBe(true);
    expect(months.value).toBe('');
  });

  it('keeps the Save button enabled while a receipt is still being read (MUST-10.2)', () => {
    renderForm();
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('applies server-computed prefill from a transaction and posts the id back (MUST-11.3)', () => {
    const { container } = renderForm({
      prefill: {
        purchaseDate: '2026-08-16',
        vendor: 'HOME DEPOT',
        priceCents: 129999,
        transactionId: 55,
      },
    });
    expect((container.querySelector('[name="purchaseDate"]') as HTMLInputElement).value).toBe('2026-08-16');
    expect((container.querySelector('[name="vendor"]') as HTMLInputElement).value).toBe('HOME DEPOT');
    expect((container.querySelector('[name="price"]') as HTMLInputElement).value).toBe('1299.99');
    expect((container.querySelector('[name="transactionId"]') as HTMLInputElement).value).toBe('55');
  });

  it('carries a hidden staged field so the action always receives valid JSON', () => {
    const { container } = renderForm();
    const staged = container.querySelector('input[name="staged"]') as HTMLInputElement;
    expect(staged.value).toBe('[]');
  });

  // --- type-deltas.md T9 ---

  it('offers a type dropdown with a "none" option plus every seeded type', () => {
    const { container } = renderForm();
    const select = container.querySelector('select[name="typeId"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual(['— none —', 'Appliance', 'Netflix plan', 'Car loan']);
    // Unset by default: nothing is selected until the member chooses one.
    expect(select.value).toBe('');
  });

  // v1.2.2 Task 2: coveredThroughLabel(isSubscription) is DELETED, superseded by
  // coveredThroughLabelForKind(kind). Old subscription wording 'Cancel by' -> 'Active through'
  // is a deliberate, owner-approved change (see tests/lib/warranty/constants.test.ts).
  it('reads "Covered through" with no type selected, and follows the SELECTED type kind live', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="purchaseDate"]')!, { target: { value: '2026-01-31' } });
    fireEvent.change(container.querySelector('[name="warrantyMonths"]')!, { target: { value: '1' } });
    expect(screen.getByText('Covered through 2026-02-28')).toBeTruthy();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } });
    expect(screen.getByText('Active through 2026-02-28')).toBeTruthy();
    expect(screen.queryByText('Covered through 2026-02-28')).toBeNull();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    expect(screen.getByText('Term runs through 2026-02-28')).toBeTruthy();
  });

  // --- v1.3.0: billing cycle and amount (task A) ---

  it('hides the Billing fields until a subscription/contract type is selected', () => {
    const { container } = renderForm();
    expect(container.querySelector('select[name="billingCycle"]')).toBeNull();
    expect(container.querySelector('input[name="billingAmount"]')).toBeNull();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } }); // Netflix plan, subscription
    expect(container.querySelector('select[name="billingCycle"]')).toBeTruthy();
    expect(container.querySelector('input[name="billingAmount"]')).toBeTruthy();
  });

  it('clears the Billing fields and removes them from the form when the kind switches away', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } }); // subscription
    fireEvent.change(container.querySelector('select[name="billingCycle"]')!, { target: { value: 'monthly' } });
    fireEvent.change(container.querySelector('input[name="billingAmount"]')!, { target: { value: '15.99' } });
    expect((container.querySelector('select[name="billingCycle"]') as HTMLSelectElement).value).toBe('monthly');

    // v1.3.1: billingAllowedForKind widened to include 'loan' (a loan's billing pair is its
    // regular payment) -- '1' (Appliance, kind warranty) is the only kind left that does NOT
    // carry billing, so it's the one that proves the fields actually clear.
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '1' } }); // warranty
    expect(container.querySelector('select[name="billingCycle"]')).toBeNull();
    expect(container.querySelector('input[name="billingAmount"]')).toBeNull();

    // Switching back to a subscription/contract type starts the fields blank again --
    // the earlier value was cleared, not just hidden.
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } });
    expect((container.querySelector('select[name="billingCycle"]') as HTMLSelectElement).value).toBe('');
    expect((container.querySelector('input[name="billingAmount"]') as HTMLInputElement).value).toBe('');
  });

  it('offers a "Not set" default plus Monthly/Annual options', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } });
    const select = container.querySelector('select[name="billingCycle"]') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option')).map((o) => [o.getAttribute('value'), o.textContent]);
    expect(options).toEqual([['', 'Not set'], ['monthly', 'Monthly'], ['annual', 'Annual']]);
  });

  // v1.2.2 Task 2: dynamic form labels -- the Purchase-date field label, the term-length
  // legend and the Lifetime checkbox's own label all follow the SELECTED type's kind live.
  it('follows the SELECTED type kind live for the date label, term legend and open-ended label', () => {
    const { container } = renderForm();
    expect(screen.getByText('Purchase date')).toBeTruthy();
    expect(container.querySelector('legend')!.textContent).toBe('Warranty (months)');
    expect(screen.getByText('Lifetime warranty')).toBeTruthy();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    expect(screen.getByText('Start date')).toBeTruthy();
    expect(screen.queryByText('Purchase date')).toBeNull();
    expect(container.querySelector('legend')!.textContent).toBe('Term (months)');
    expect(screen.getByText('Ongoing (no end date)')).toBeTruthy();
  });
});

// v1.3.1: the Loan fieldset and the billing-label kind matrix (MUST-14.1 / MUST-12.3).
describe('MUST-14.1 / MUST-12.3: the loan surfaces', () => {
  it('the loan fieldset appears only for a loan-kind type and disappears live', () => {
    const { container } = renderForm();
    expect(screen.queryByText('Balance still owed')).toBeNull();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } }); // Car loan
    expect(screen.getByText('Balance still owed')).toBeTruthy();
    expect(screen.getByText('Shown for reference only — this app does no interest math.')).toBeTruthy();
    expect(container.querySelector('input[name="principal"]')).toBeTruthy();
    expect(container.querySelector('input[name="interestRate"]')).toBeTruthy();
    expect(container.querySelector('input[name="currentBalance"]')).toBeTruthy();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '1' } }); // Appliance
    expect(screen.queryByText('Balance still owed')).toBeNull();
    expect(container.querySelector('input[name="currentBalance"]')).toBeNull();
  });

  it('clears the loan fields when the kind switches away', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    fireEvent.change(container.querySelector('input[name="currentBalance"]')!, { target: { value: '19550.00' } });
    expect((container.querySelector('input[name="currentBalance"]') as HTMLInputElement).value).toBe('19550.00');

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '1' } });
    expect(container.querySelector('input[name="currentBalance"]')).toBeNull();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    expect((container.querySelector('input[name="currentBalance"]') as HTMLInputElement).value).toBe('');
  });

  it('the billing labels read Payment / Payment amount / per month for a loan', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } }); // loan
    expect(screen.getByText('Payment')).toBeTruthy();
    expect(screen.getByText('Payment amount')).toBeTruthy();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '2' } }); // subscription
    expect(screen.getByText('Billing')).toBeTruthy();
    expect(screen.getByText('Amount')).toBeTruthy();
  });
});

// v1.14.0 (spec BU, ruling P16): the Direction control reuses loanFieldsAllowedForKind as its
// gate -- no second kind === 'loan' predicate -- and defaults to 'owed', the column's own
// default, so an untouched form posts exactly what a pre-1.14.0 form always posted.
describe('the Direction control (spec BU, ruling P16)', () => {
  it('is absent for a kind that is not a loan', () => {
    renderForm();
    expect(screen.queryByLabelText('Direction')).toBeNull();
  });

  it('offers exactly the two directions for a loan, defaulting to "We owe this"', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } }); // Car loan
    const select = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['We owe this', 'Owed to us']);
    expect(select.value).toBe('owed');
    // There is no "Not set": the column is NOT NULL and 'owed' is its default (ruling P1).
    expect([...select.options].map((option) => option.value)).toEqual(['owed', 'lent']);
  });

  it('posts under the name the action reads', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).name).toBe('loanDirection');
  });

  it('resets to "We owe this" when the kind switches away from loan and back', () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'lent' } });
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).value).toBe('lent');

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '1' } }); // Appliance
    expect(screen.queryByLabelText('Direction')).toBeNull();

    fireEvent.change(container.querySelector('select[name="typeId"]')!, { target: { value: '3' } });
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).value).toBe('owed');
  });
});

describe('fields and the submit button follow the selected type', () => {
  /** Picking the type is what drives everything below; id 3 is the loan fixture. */
  function selectType(id: number) {
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: String(id) } });
  }

  it('offers a model, a serial and a price for a warranty', () => {
    renderForm();
    selectType(1);
    expect(screen.queryByLabelText('Model')).not.toBeNull();
    expect(screen.queryByLabelText('Serial number')).not.toBeNull();
    expect(screen.queryByLabelText('Price')).not.toBeNull();
  });

  it('drops all three for a loan, whose money is its own amounts', () => {
    renderForm();
    selectType(3);
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Serial number')).toBeNull();
    // The reported bug: a bare "Price" sitting beside "Original amount" asked for the same
    // fact twice, and stored neither answer where the loan record keeps it.
    expect(screen.queryByLabelText('Price')).toBeNull();
    // Regex, not an exact string: Field puts the hint INSIDE the <label>, so the input's
    // accessible name is the label plus its hint sentence.
    expect(screen.queryByLabelText(/Original amount/)).not.toBeNull();
  });

  it('drops all three for a subscription too', () => {
    renderForm();
    selectType(2);
    expect(screen.queryByLabelText('Model')).toBeNull();
    expect(screen.queryByLabelText('Serial number')).toBeNull();
    expect(screen.queryByLabelText('Price')).toBeNull();
  });

  it('names the kind on the submit button, so it cannot contradict the type select above it', () => {
    renderForm();
    selectType(3);
    expect(screen.queryByRole('button', { name: 'Save loan' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Save warranty' })).toBeNull();

    selectType(2);
    expect(screen.queryByRole('button', { name: 'Save subscription' })).not.toBeNull();

    selectType(1);
    expect(screen.queryByRole('button', { name: 'Save warranty' })).not.toBeNull();
  });
});

const HINT = /Tracking a bill with due dates\?/;

describe('v1.12.1: the Bill kind is findable from /warranties/new (item BH)', () => {
  it('hints at Settings → Item types when no bill-kind type exists, with a link for an admin', () => {
    renderForm({ types: [{ id: 1, name: 'Appliance', kind: 'warranty' }], isAdmin: true });
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Item types/ }).getAttribute('href')).toBe('/settings/item-types');
  });

  it('gives a member the sentence and no link, because that page is admin-only', () => {
    renderForm({ types: [{ id: 1, name: 'Appliance', kind: 'warranty' }], isAdmin: false });
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Item types/ })).toBeNull();
  });

  it('says nothing once a bill-kind type exists', () => {
    renderForm({ types: [{ id: 2, name: 'Property tax', kind: 'bill' }], isAdmin: true });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('says nothing about bills when there are no types at all — that case has its own empty state', () => {
    renderForm({ types: [], isAdmin: true });
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
