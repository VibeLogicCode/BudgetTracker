// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ManagersClient } from '@/app/(app)/settings/managers/managers-client';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ProfileRecord, ProfileUsage } from '@/lib/import/presets';
import type { CategoryRecord } from '@/lib/categories';

// Server actions aren't under test here -- only the UI the v1.6.0 deactivation feature adds
// (spec 2026-08-22, MUST-4.1: an inactive badge and an activate/deactivate toggle on every
// profile, built-in or not, plus a warn-first confirm step when accounts are pinned, MUST-4.3)
// and the v1.7.0 Task 15a Tax checkbox.
//
// v1.21.0 (item 10): updateRuleAction/deleteRuleAction moved off this file entirely, to
// /settings/merchant-rules -- see tests/app/merchant-rules-client.test.tsx and
// tests/app/merchant-rules-actions.test.ts for their coverage now.
vi.mock('@/app/(app)/settings/managers/actions', () => ({
  createCategoryAction: vi.fn(async () => ({})),
  renameCategoryAction: vi.fn(async () => ({})),
  archiveCategoryAction: vi.fn(async () => ({})),
  setCategoryTaxRelevantAction: vi.fn(async () => ({})),
  saveProfileMappingAction: vi.fn(async () => ({})),
  deleteProfileAction: vi.fn(async () => ({})),
  setProfileActiveAction: vi.fn(async () => ({})),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // 2026-08-30 plan item 2: the categories disclosure remembers its open set in localStorage
  // (key 'managers:categoryGroups') -- cleared so one test's toggle never leaks into the next.
  try {
    window.localStorage.clear();
  } catch {
    // Not what this suite is testing -- covered explicitly below.
  }
});
afterEach(() => cleanup());

function profile(over: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: 1,
    name: 'Scotiabank Chequing/Debit',
    institution: 'Scotiabank',
    isBuiltin: true,
    mapping: getBuiltinPreset('Scotiabank Chequing/Debit'),
    mappingError: null,
    isActive: true,
    ...over,
  };
}

function baseProps(
  overrides: {
    profiles?: ProfileRecord[];
    profileUsage?: Record<number, ProfileUsage>;
    categories?: CategoryRecord[];
  } = {},
) {
  return {
    categories: overrides.categories ?? [],
    profiles: overrides.profiles ?? [profile()],
    profileUsage: overrides.profileUsage ?? {},
    profilePackRows: [],
  };
}

function renderManagers(overrides: Parameters<typeof baseProps>[0] = {}) {
  return render(<ManagersClient {...baseProps(overrides)} />);
}

function category(over: Partial<CategoryRecord> = {}): CategoryRecord {
  return {
    id: 1,
    name: 'Groceries',
    parentId: null,
    icon: null,
    color: null,
    isIncome: false,
    isArchived: false,
    sortOrder: 0,
    taxRelevant: false,
    ...over,
  };
}

describe('ManagersClient — profile deactivation (spec 2026-08-22 v1.6.0, MUST-4.1/MUST-4.3)', () => {
  it('shows an inactive badge only for a deactivated profile', () => {
    render(<ManagersClient {...baseProps({ profiles: [profile({ isActive: false })] })} />);
    expect(screen.getByText(/inactive/i)).toBeTruthy();
  });

  it('shows no inactive badge for an active profile', () => {
    render(<ManagersClient {...baseProps({ profiles: [profile({ isActive: true })] })} />);
    expect(screen.queryByText(/inactive/i)).toBeNull();
  });

  it('offers a deactivate control on a BUILT-IN profile, unlike delete which built-ins never get (MUST-4.2)', () => {
    render(<ManagersClient {...baseProps({ profiles: [profile({ isBuiltin: true, isActive: true })] })} />);
    expect(screen.getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });

  it('offers an activate control on a deactivated profile, with no confirmation needed', async () => {
    const { setProfileActiveAction } = await import('@/app/(app)/settings/managers/actions');
    render(<ManagersClient {...baseProps({ profiles: [profile({ id: 7, isActive: false })] })} />);
    const activateForm = screen.getByRole('button', { name: /^activate$/i }).closest('form')!;
    expect((activateForm.querySelector('[name="profileId"]') as HTMLInputElement).value).toBe('7');
    expect((activateForm.querySelector('[name="isActive"]') as HTMLInputElement).value).toBe('1');
    fireEvent.submit(activateForm);
    expect(setProfileActiveAction).toHaveBeenCalled();
  });

  it('deactivates immediately, with no confirm step, when no account is pinned to the profile', async () => {
    const { setProfileActiveAction } = await import('@/app/(app)/settings/managers/actions');
    render(
      <ManagersClient
        {...baseProps({
          profiles: [profile({ id: 3, isActive: true })],
          profileUsage: { 3: { accounts: 0, imports: 0 } },
        })}
      />,
    );
    const deactivateForm = screen.getByRole('button', { name: /^deactivate$/i }).closest('form')!;
    expect((deactivateForm.querySelector('[name="isActive"]') as HTMLInputElement).value).toBe('0');
    fireEvent.submit(deactivateForm);
    expect(setProfileActiveAction).toHaveBeenCalled();
  });

  it('warns with the REAL pinned-account count before deactivating a profile accounts are pinned to, and does not submit until confirmed (MUST-4.3)', async () => {
    const { setProfileActiveAction } = await import('@/app/(app)/settings/managers/actions');
    render(
      <ManagersClient
        {...baseProps({
          profiles: [profile({ id: 4, isActive: true })],
          profileUsage: { 4: { accounts: 2, imports: 0 } },
        })}
      />,
    );

    // The first click on a pinned profile's "deactivate" is a plain button, not a form submit --
    // it only reveals the warning; nothing has been sent to the server yet.
    fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
    expect(setProfileActiveAction).not.toHaveBeenCalled();
    expect(screen.getByText(/2 account/i)).toBeTruthy();

    const confirmForm = screen.getByRole('button', { name: /deactivate anyway/i }).closest('form')!;
    expect((confirmForm.querySelector('[name="profileId"]') as HTMLInputElement).value).toBe('4');
    expect((confirmForm.querySelector('[name="isActive"]') as HTMLInputElement).value).toBe('0');
    fireEvent.submit(confirmForm);
    expect(setProfileActiveAction).toHaveBeenCalled();
  });

  it('cancelling the deactivate warning submits nothing and hides the warning again', async () => {
    const { setProfileActiveAction } = await import('@/app/(app)/settings/managers/actions');
    render(
      <ManagersClient
        {...baseProps({
          profiles: [profile({ id: 5, isActive: true })],
          profileUsage: { 5: { accounts: 1, imports: 0 } },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
    expect(screen.getByText(/1 account/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('button', { name: /deactivate anyway/i })).toBeNull();
    expect(setProfileActiveAction).not.toHaveBeenCalled();
  });
});

// v1.7.0, Task 15a (spec 2026-08-22): each category row gains a Tax checkbox that reports to
// the tax year report (src/lib/tax.ts).
describe('ManagersClient — Tax checkbox', () => {
  // 2026-08-30 plan item 2: the categories table folded into a Budgets-style disclosure list,
  // which has no shared column header left to hang a hint off (there is no <thead> any more) --
  // the same sentence now lives in the Categories card's own description instead.
  it('mentions the tax year report in the Categories card description', () => {
    render(<ManagersClient {...baseProps({ categories: [category()] })} />);
    expect(screen.getByText(/tax year report/i)).toBeTruthy();
  });

  it('checks the box for a tax-relevant category and leaves an unflagged one unchecked', () => {
    render(
      <ManagersClient
        {...baseProps({
          categories: [
            category({ id: 1, name: 'Medical', taxRelevant: true }),
            category({ id: 2, name: 'Coffee', taxRelevant: false }),
          ],
        })}
      />,
    );
    expect((screen.getByRole('checkbox', { name: /medical/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /coffee/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('checking a row\'s Tax checkbox calls setCategoryTaxRelevantAction with that category\'s id', async () => {
    const { setCategoryTaxRelevantAction } = await import('@/app/(app)/settings/managers/actions');
    render(<ManagersClient {...baseProps({ categories: [category({ id: 9, name: 'Medical', taxRelevant: false })] })} />);
    const checkbox = screen.getByRole('checkbox', { name: /medical/i });
    fireEvent.click(checkbox);
    await waitFor(() => expect(setCategoryTaxRelevantAction).toHaveBeenCalled());
    // Bound as `(formData) => setCategoryTaxRelevantAction({}, formData)`, so the FormData the
    // hook built is the mock's SECOND argument, not its first.
    const sent = (setCategoryTaxRelevantAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('categoryId')).toBe('9');
  });

  it('each category row\'s Tax checkbox saves with its own category id', async () => {
    const { setCategoryTaxRelevantAction } = await import('@/app/(app)/settings/managers/actions');
    render(
      <ManagersClient
        {...baseProps({
          categories: [category({ id: 1, name: 'Medical' }), category({ id: 2, name: 'Coffee' })],
        })}
      />,
    );
    const medicalCheckbox = screen.getByRole('checkbox', { name: /medical/i });
    const coffeeCheckbox = screen.getByRole('checkbox', { name: /coffee/i });
    expect(medicalCheckbox).not.toBe(coffeeCheckbox);

    fireEvent.click(medicalCheckbox);
    await waitFor(() => expect(setCategoryTaxRelevantAction).toHaveBeenCalledTimes(1));
    const mock = setCategoryTaxRelevantAction as ReturnType<typeof vi.fn>;
    expect((mock.mock.calls[0][1] as FormData).get('categoryId')).toBe('1');

    fireEvent.click(coffeeCheckbox);
    await waitFor(() => expect(setCategoryTaxRelevantAction).toHaveBeenCalledTimes(2));
    expect((mock.mock.calls[1][1] as FormData).get('categoryId')).toBe('2');
  });
});

// 2026-08-30 plan item 2: the flat table folded into the same parent/children disclosure
// Budgets' Edit-limits list already uses. Every row -- parent or child, open or closed -- stays
// mounted (hidden via the real `hidden` attribute, never unmounted, same ruling U2/U3 reasoning
// budgets-client.tsx's own EditRow documents), so a plain DOM query still finds every category
// without opening anything, exactly as `container.querySelector('table')` used to.
function categoryRowFor(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll('[id^="category-row-"]')).find(
    (node) => (node.querySelector('input[name="name"]') as HTMLInputElement | null)?.defaultValue === name,
  );
  if (!row) throw new Error(`no category row for ${name}`);
  return row as HTMLElement;
}

describe('ManagersClient — the categories list groups children under their parent (backlog 2a)', () => {
  it('lists a late-created child right after its parent, not at the end', () => {
    const { container } = renderManagers({
      categories: [
        category({ id: 1, name: 'Kids', sortOrder: 0 }),
        category({ id: 2, name: 'Fees', sortOrder: 1 }),
        category({ id: 3, name: 'Bank Fees', parentId: 2, sortOrder: 2 }),
        category({ id: 4, name: 'Interest', parentId: 2, sortOrder: 3 }),
        category({ id: 5, name: 'Education', parentId: 1, sortOrder: 4 }),
        category({ id: 6, name: 'Activities', parentId: 1, sortOrder: 5, isArchived: true }),
      ],
    });
    // Every row stays in the DOM whether its group is open or not (ruling U2/U3), so this reads
    // the whole list's order with nothing clicked open.
    const names = Array.from(container.querySelectorAll('[id^="category-row-"] input[name="name"]')).map(
      (el) => (el as HTMLInputElement).defaultValue,
    );
    expect(names).toEqual(['Kids', 'Education', 'Activities', 'Fees', 'Bank Fees', 'Interest']);
  });

  it('tints a parent row but not its child (backlog BZ)', () => {
    const { container } = renderManagers({
      categories: [
        category({ id: 1, name: 'Fees', sortOrder: 0 }),
        category({ id: 2, name: 'Bank Fees', parentId: 1, sortOrder: 1 }),
      ],
    });
    expect(categoryRowFor(container, 'Fees').className).toContain('bg-surface-2');
    expect(categoryRowFor(container, 'Bank Fees').className).not.toContain('bg-surface-2');
  });
});

describe('ManagersClient — the categories list folds like Budgets\' Edit-limits list (2026-08-30 plan item 2)', () => {
  const parentPlusChild = [
    category({ id: 1, name: 'Fees', sortOrder: 0 }),
    category({ id: 2, name: 'Bank Fees', parentId: 1, sortOrder: 1 }),
  ];

  it('renders closed by default, with the child row present but hidden', () => {
    const { container, getByRole } = renderManagers({ categories: parentPlusChild });
    const toggle = getByRole('button', { name: /Expand Fees/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('category-row-2');
    expect(categoryRowFor(container, 'Bank Fees').hidden).toBe(true);
  });

  it('clicking the chevron reveals the child, and renames the button to Collapse', () => {
    const { container, getByRole } = renderManagers({ categories: parentPlusChild });
    fireEvent.click(getByRole('button', { name: /Expand Fees/i }));
    expect(getByRole('button', { name: /Collapse Fees/i }).getAttribute('aria-expanded')).toBe('true');
    expect(categoryRowFor(container, 'Bank Fees').hidden).toBe(false);
  });

  it('a top-level category with no children renders no disclosure chevron', () => {
    const { queryByRole } = renderManagers({ categories: [category({ id: 1, name: 'Insurance' })] });
    expect(queryByRole('button', { name: /Expand Insurance/i })).toBeNull();
  });

  it('remembers an open group across a remount (own storage key, separate from Budgets\')', () => {
    const { getByRole, unmount } = renderManagers({ categories: parentPlusChild });
    fireEvent.click(getByRole('button', { name: /Expand Fees/i }));
    unmount();

    const { getByRole: getByRoleAfterRemount } = renderManagers({ categories: parentPlusChild });
    expect(getByRoleAfterRemount('button', { name: /Collapse Fees/i }).getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem('managers:categoryGroups')).toBe('[1]');
  });

  it('renders correctly (closed) when localStorage throws on read', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      const { getByRole } = renderManagers({ categories: parentPlusChild });
      expect(getByRole('button', { name: /Expand Fees/i }).getAttribute('aria-expanded')).toBe('false');
    } finally {
      getItem.mockRestore();
    }
  });

  it('a toggle click does not throw when localStorage.setItem throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      const { getByRole } = renderManagers({ categories: parentPlusChild });
      expect(() => fireEvent.click(getByRole('button', { name: /Expand Fees/i }))).not.toThrow();
      expect(getByRole('button', { name: /Collapse Fees/i }).getAttribute('aria-expanded')).toBe('true');
    } finally {
      setItem.mockRestore();
    }
  });

  it('is not a MetricCard -- no hero number or progress bar rides along with a category row', () => {
    const { container } = renderManagers({ categories: parentPlusChild });
    // MetricCard's own hero-number class (src/components/ui/MetricCard.tsx) and its footer
    // strip marker -- a category has no number to be the hero and no progress bar, so neither
    // should ever appear here.
    expect(container.querySelector('.money-lg')).toBeNull();
    expect(container.querySelector('[data-testid="metric-card-footer"]')).toBeNull();
  });
});

// 2026-08-30 Settings disclosure sweep: "New category" folds behind its own button.
// v1.21.0 (item 10): the sibling "Add rule" toggle/table this comment used to describe moved off
// this file entirely, to /settings/merchant-rules -- see tests/app/merchant-rules-client.test.tsx.
describe('ManagersClient — "Add category" is a disclosure (2026-08-30 Settings sweep)', () => {
  it('is closed on first paint: the toggle reads "Add category" and the create form is hidden', () => {
    const { container } = renderManagers();
    const toggle = screen.getByRole('button', { name: 'Add category' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('add-category-body');
    // `queryByPlaceholderText` finds a node whether or not it is hidden (only `byRole` respects
    // the accessibility tree by default), so closedness is checked directly on the wrapper's
    // `hidden` property, the same idiom `categoryRowFor(...).hidden` already uses above.
    expect((container.querySelector('#add-category-body') as HTMLElement).hidden).toBe(true);
  });

  it('opens on click, revealing the New category field, and the toggle becomes Close', () => {
    renderManagers();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    const toggle = screen.getByRole('button', { name: 'Close' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByPlaceholderText('Groceries')).toBeTruthy();
  });
});
