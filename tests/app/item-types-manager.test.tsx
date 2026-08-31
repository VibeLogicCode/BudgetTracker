// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
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
    // 2026-08-30 Settings disclosure sweep: "Add a type" is now a disclosure, closed by
    // default (see item-types-manager.tsx's own docblock), so the create form has to be
    // opened before it can be queried at all -- getByRole excludes anything hidden via the
    // `hidden` attribute, same as every other accessibility-tree query in this suite.
    fireEvent.click(screen.getByRole('button', { name: 'Add a type' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Add a type' }));
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

// 2026-08-30 Settings disclosure sweep: "Add a type" folds behind a button, same shape as
// "Add an account" / "New category" / "Save rule" / "Add a user".
describe('ItemTypesManager — "Add a type" is a disclosure (2026-08-30 Settings sweep)', () => {
  it('is closed on first paint: the toggle reads "Add a type" and the create form is not queryable', () => {
    render(<ItemTypesManager types={[]} />);
    const toggle = screen.getByRole('button', { name: 'Add a type' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('add-type-body');
    // getByRole excludes anything hidden via the `hidden` attribute -- this is the same check
    // a screen reader or a keyboard user would hit, not just an implementation detail.
    expect(screen.queryByRole('textbox', { name: /type name/i })).toBeNull();
  });

  it('opens on click, revealing the Type name field, and the toggle becomes Close', () => {
    render(<ItemTypesManager types={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a type' }));
    const toggle = screen.getByRole('button', { name: 'Close' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByPlaceholderText('Appliance')).toBeTruthy();
  });
});
