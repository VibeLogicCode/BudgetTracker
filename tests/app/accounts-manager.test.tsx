// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { AccountsManager, type AccountRow, type PersonRow, type ProfileOption } from '@/app/(app)/settings/accounts/accounts-manager';

// Server actions aren't under test here -- only the UI the v1.6.0 account-pinned-mapping
// surfacing feature adds (spec 2026-08-22, MUST-5.1: show each account's pinned mapping by
// name, or "none", with a select to set or clear it, offering only active+readable profiles).
vi.mock('@/app/(app)/settings/accounts/actions', () => ({
  createAccountAction: vi.fn(async () => ({})),
  renameAccountAction: vi.fn(async () => ({})),
  setAccountOwnerAction: vi.fn(async () => ({})),
  setAccountActiveAction: vi.fn(async () => ({})),
  setAccountProfileAction: vi.fn(async () => ({})),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

const PEOPLE: PersonRow[] = [{ id: 1, name: 'Alex', isActive: true }];
const PROFILES: ProfileOption[] = [
  { id: 10, name: 'TD Chequing/Debit' },
  { id: 11, name: 'TD Visa' },
];

function account(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 100,
    name: 'Joint Chequing',
    institution: 'TD',
    type: 'chequing',
    ownerUserId: null,
    isActive: true,
    isSimplefinManaged: false,
    importProfileId: null,
    importProfileName: null,
    ...over,
  };
}

describe('AccountsManager — pinned mapping (spec 2026-08-22 v1.6.0, MUST-5.1)', () => {
  it('shows "none" for an account with no pin', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    // getAllByText because the select's own "None" <option> also matches case-insensitively.
    expect(screen.getAllByText(/^none$/i).length).toBeGreaterThan(0);
  });

  it('shows the pinned mapping by name for an account with a pin', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 10, importProfileName: 'TD Chequing/Debit' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    // getAllByText because the profile name also appears once as an <option> in the select
    // below -- both places are correct, so presence is what this test checks, not uniqueness.
    expect(screen.getAllByText('TD Chequing/Debit').length).toBeGreaterThan(0);
  });

  it('shows the pinned mapping by name even when it is no longer offered (deactivated or unreadable)', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 99, importProfileName: 'Old Scotia (custom)' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    // Still shown by name, dormant-pin style (Task 4 ledger) -- nothing is nulled or hidden.
    expect(screen.getByText('Old Scotia (custom)')).toBeTruthy();
  });

  it('offers only the given active+readable profiles in the select, plus a None option', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['None', 'TD Chequing/Debit', 'TD Visa']);
  });

  it('preselects the select to the pin when it is one of the offered profiles', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 11, importProfileName: 'TD Visa' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    expect(select.value).toBe('11');
  });

  it('does not preselect an unoffered pin, so the select never lands on a value with no matching option', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 99, importProfileName: 'Old Scotia (custom)' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('submits the chosen mapping via setAccountProfileAction', async () => {
    const { setAccountProfileAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42 })]} people={PEOPLE} profiles={PROFILES} />);
    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    const form = select.closest('form')!;
    fireEvent.change(select, { target: { value: '10' } });
    fireEvent.submit(form);
    expect(setAccountProfileAction).toHaveBeenCalled();
    expect((form.querySelector('[name="accountId"]') as HTMLInputElement).value).toBe('42');
  });

  it('offers no mapping control for a SimpleFIN-managed account -- pinning is meaningless while it is synced', () => {
    render(
      <AccountsManager
        accounts={[account({ isSimplefinManaged: true })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    expect(screen.queryByLabelText(/Mapping for Joint Chequing/i)).toBeNull();
  });
});
