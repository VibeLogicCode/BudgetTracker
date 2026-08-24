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
vi.mock('@/app/(app)/settings/managers/actions', () => ({
  createCategoryAction: vi.fn(async () => ({})),
  renameCategoryAction: vi.fn(async () => ({})),
  archiveCategoryAction: vi.fn(async () => ({})),
  setCategoryTaxRelevantAction: vi.fn(async () => ({})),
  updateRuleAction: vi.fn(async () => ({})),
  deleteRuleAction: vi.fn(async () => ({})),
  saveProfileMappingAction: vi.fn(async () => ({})),
  deleteProfileAction: vi.fn(async () => ({})),
  setProfileActiveAction: vi.fn(async () => ({})),
}));

beforeEach(() => vi.clearAllMocks());
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
  overrides: { profiles?: ProfileRecord[]; profileUsage?: Record<number, ProfileUsage>; categories?: CategoryRecord[] } = {},
) {
  return {
    categories: overrides.categories ?? [],
    rules: [],
    profiles: overrides.profiles ?? [profile()],
    profileUsage: overrides.profileUsage ?? {},
    rulesPackRows: [],
    profilePackRows: [],
  };
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
  it('renders a Tax column header with a hint about the tax year report', () => {
    render(<ManagersClient {...baseProps({ categories: [category()] })} />);
    expect(screen.getByRole('columnheader', { name: /tax/i })).toBeTruthy();
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
