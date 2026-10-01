// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { SuggestedFieldsDto } from '@/components/warranty/ReceiptUploader';
import { NewWarrantyClient } from '@/app/(app)/warranties/new/new-warranty-client';

/*
  The receipt reader is replaced by a stand-in that hands its onSuggestions prop to the test, so a
  suggestion can be delivered directly. The real uploader only calls it after staging, OCR and
  polling, none of which this file is about.
*/
const uploader = vi.hoisted(() => ({
  onSuggestions: undefined as ((fields: SuggestedFieldsDto) => void) | undefined,
  onPickAmount: undefined as ((cents: number) => void) | undefined,
  onPickDate: undefined as ((iso: string) => void) | undefined,
}));

vi.mock('@/components/warranty/ReceiptUploader', () => ({
  ReceiptUploader: (props: {
    onSuggestions?: (fields: SuggestedFieldsDto) => void;
    onPickAmount?: (cents: number) => void;
    onPickDate?: (iso: string) => void;
  }) => {
    uploader.onSuggestions = props.onSuggestions;
    uploader.onPickAmount = props.onPickAmount;
    uploader.onPickDate = props.onPickDate;
    return null;
  },
}));

vi.mock('@/app/(app)/warranties/actions', () => ({
  createWarrantyAction: vi.fn(async () => ({})),
}));

afterEach(() => {
  cleanup();
  uploader.onSuggestions = undefined;
  uploader.onPickAmount = undefined;
  uploader.onPickDate = undefined;
});

const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Streaming plan', kind: 'subscription' as const },
  { id: 3, name: 'Car loan', kind: 'loan' as const },
  { id: 4, name: 'Riverside Water', kind: 'bill' as const },
];

function renderForm() {
  const view = render(
    <NewWarrantyClient
      people={[{ id: 7, name: 'Alice' }]}
      types={types}
      currentUserId={7}
      today="2026-08-16"
      prefill={{}}
      isAdmin
    />,
  );
  const field = (name: string) => view.container.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  const pick = (id: string) => fireEvent.change(field('typeId')!, { target: { value: id } });
  const type = (name: string, value: string) => fireEvent.change(field(name)!, { target: { value } });
  const marks = () => (view.container.textContent ?? '').split('suggested from receipt').length - 1;
  return { field, pick, type, marks };
}

function suggest(fields: SuggestedFieldsDto) {
  act(() => uploader.onSuggestions!(fields));
}

/** Spec 2026-09-30 §2.3: a suggestion goes to the field the kind actually has. */
describe('a receipt suggestion lands in the field the kind has', () => {
  it('a bill: the amount goes to Amount due and the due date to Due date', () => {
    const form = renderForm();
    form.pick('4');
    suggest({ priceCents: 8217, dueDate: '2026-10-15' });
    expect(form.field('amountDue')!.value).toBe('82.17');
    expect(form.field('dueDate')!.value).toBe('2026-10-15');
  });

  it('a subscription: the amount goes to its billing amount', () => {
    const form = renderForm();
    form.pick('2');
    suggest({ priceCents: 1599 });
    expect(form.field('billingAmount')!.value).toBe('15.99');
  });

  it('a warranty: the amount goes to Price', () => {
    const form = renderForm();
    form.pick('1');
    suggest({ priceCents: 34950 });
    expect(form.field('price')!.value).toBe('349.50');
  });

  it('a bill whose Amount due was typed first keeps what was typed', () => {
    const form = renderForm();
    form.pick('4');
    form.type('amountDue', '90.00');
    suggest({ priceCents: 8217, dueDate: '2026-10-15' });
    expect(form.field('amountDue')!.value).toBe('90.00');
    // Only the typed field is protected; the untouched due date is still filled.
    expect(form.field('dueDate')!.value).toBe('2026-10-15');
  });

  it('a loan: a balance date set by hand survives a date read off the receipt', () => {
    const form = renderForm();
    form.pick('3');
    form.type('balanceAsOfDate', '2026-03-01');
    suggest({ purchaseDate: '2026-01-15' });
    expect(form.field('purchaseDate')!.value).toBe('2026-01-15');
    expect(form.field('balanceAsOfDate')!.value).toBe('2026-03-01');
  });
});

/*
  The Receipt card sits above the Type select and the page says to attach first, so the reader
  often answers before a type is picked -- when the form still reads as a warranty.
*/
describe('attaching before picking the type', () => {
  it('picking Bill afterwards moves the amount and the due date into the bill fields', () => {
    const form = renderForm();
    suggest({ priceCents: 8217, dueDate: '2026-10-15' });
    expect(form.field('price')!.value).toBe('82.17');

    form.pick('4');
    expect(form.field('amountDue')!.value).toBe('82.17');
    expect(form.field('dueDate')!.value).toBe('2026-10-15');
    expect(form.marks()).toBe(2);
  });

  it('switching back to a warranty does not overwrite a price that was typed', () => {
    const form = renderForm();
    form.type('price', '10.00');
    suggest({ priceCents: 8217 });
    form.pick('4');
    expect(form.field('amountDue')!.value).toBe('82.17');

    form.pick('1');
    expect(form.field('price')!.value).toBe('10.00');
  });
});

describe('the "suggested from receipt" mark', () => {
  it('goes away from Amount due and Due date once a person types over them', () => {
    const form = renderForm();
    form.pick('4');
    suggest({ priceCents: 8217, dueDate: '2026-10-15' });
    expect(form.marks()).toBe(2);

    form.type('amountDue', '82.00');
    expect(form.marks()).toBe(1);
    form.type('dueDate', '2026-10-20');
    expect(form.marks()).toBe(0);
  });
});

/** Spec 2026-09-30 §2.3: a chip the person taps is their choice, routed like a suggestion. */
describe('a tapped chip', () => {
  it('puts the amount in the field the kind has, over what was there', () => {
    const form = renderForm();
    form.pick('4');
    form.type('amountDue', '90.00');
    act(() => uploader.onPickAmount!(46667));
    expect(form.field('amountDue')!.value).toBe('466.67');

    form.pick('2');
    act(() => uploader.onPickAmount!(1599));
    expect(form.field('billingAmount')!.value).toBe('15.99');

    form.pick('1');
    act(() => uploader.onPickAmount!(34950));
    expect(form.field('price')!.value).toBe('349.50');
  });

  it("puts the date in a bill's Due date, and in the start date for any other kind", () => {
    const form = renderForm();
    form.pick('4');
    act(() => uploader.onPickDate!('2026-10-31'));
    expect(form.field('dueDate')!.value).toBe('2026-10-31');
    expect(form.field('purchaseDate')!.value).toBe('');

    form.pick('1');
    act(() => uploader.onPickDate!('2026-08-01'));
    expect(form.field('purchaseDate')!.value).toBe('2026-08-01');
  });

  /** Review focus 5: a second receipt finishing later must not take back what the person chose. */
  it('is not overwritten by a read that finishes afterwards', () => {
    const form = renderForm();
    form.pick('4');
    act(() => uploader.onPickAmount!(46667));
    act(() => uploader.onPickDate!('2026-10-31'));
    suggest({ priceCents: 44443, dueDate: '2026-11-15' });
    expect(form.field('amountDue')!.value).toBe('466.67');
    expect(form.field('dueDate')!.value).toBe('2026-10-31');
    // A chosen figure is not marked as a guess.
    expect(form.marks()).toBe(0);
  });
});
