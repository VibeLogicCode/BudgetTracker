// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ItemTypesManager } from '@/app/(app)/settings/item-types/item-types-manager';
import type { ItemTypeWithUsage } from '@/lib/warranty/types';

// Server actions aren't under test here -- only the form the reviewer's 5b lesson is about.
vi.mock('@/app/(app)/settings/item-types/actions', () => ({
  createItemTypeAction: vi.fn(async () => ({})),
  renameItemTypeAction: vi.fn(async () => ({})),
  setKindAction: vi.fn(async () => ({})),
  deleteItemTypeAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

function type(over: Partial<ItemTypeWithUsage> = {}): ItemTypeWithUsage {
  return {
    id: 1,
    name: 'Laptop',
    isSubscription: false,
    kind: 'warranty',
    createdAt: '2026-08-16T00:00:00.000Z',
    usageCount: 0,
    ...over,
  };
}

describe('ItemTypesManager — create form (5b lesson, made enforceable)', () => {
  it('renders exactly ONE [name="kind"] control in the create form', () => {
    const { container } = render(<ItemTypesManager types={[]} />);
    // 5b regression: a hidden input sharing the same `name` as the real control silently wins
    // over the admin's choice via FormData.get()'s first-value semantics. A plain <select> has
    // no such sibling, but this pins the invariant directly: exactly one element named "kind"
    // inside the "Add a type" form, full stop.
    const createForm = screen.getByRole('button', { name: /add type/i }).closest('form')!;
    const kindControls = createForm.querySelectorAll('[name="kind"]');
    expect(kindControls).toHaveLength(1);
    expect(kindControls[0].tagName).toBe('SELECT');
    expect(container.querySelectorAll('form [name="kind"]').length).toBeGreaterThanOrEqual(1);
  });

  it('offers all five kinds as options, defaulting to Warranty', () => {
    render(<ItemTypesManager types={[]} />);
    const select = screen.getByRole('button', { name: /add type/i }).closest('form')!.querySelector('select[name="kind"]') as HTMLSelectElement;
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual(['Warranty', 'Subscription', 'Contract', 'Loan', 'Bill']);
    expect(select.value).toBe('warranty');
  });

  it('lists a row per type, with its own name input and kind select carrying the current value', () => {
    render(<ItemTypesManager types={[type({ id: 5, name: 'Netflix', kind: 'subscription', isSubscription: true })]} />);
    const nameInput = screen.getByRole('textbox', { name: /rename netflix/i }) as HTMLInputElement;
    expect(nameInput.value).toBe('Netflix');
    const rowSelect = screen.getByRole('combobox', { name: /kind of netflix/i }) as HTMLSelectElement;
    expect(rowSelect.value).toBe('subscription');
  });

  // Fix wave (2026-08-23 review, finding M2): the auto-save conversion dropped this input's
  // maxLength, silently lifting the 60-character limit itemTypeNameSchema enforces server-side.
  it('caps the row name input at 60 characters, matching itemTypeNameSchema', () => {
    render(<ItemTypesManager types={[type({ id: 5, name: 'Netflix' })]} />);
    const nameInput = screen.getByRole('textbox', { name: /rename netflix/i }) as HTMLInputElement;
    expect(nameInput.maxLength).toBe(60);
  });
});

describe('ItemTypesManager — responsive rows (v1.15.0, ruling S3)', () => {
  it('the Name cell of the first row carries cell-stack-headline', () => {
    const { container } = render(<ItemTypesManager types={[type({ id: 5, name: 'Netflix' })]} />);
    const headlineCell = container.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });
});
