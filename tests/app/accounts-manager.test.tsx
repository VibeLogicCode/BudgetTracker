// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { AccountsManager, type AccountRow, type PersonRow, type ProfileOption } from '@/app/(app)/settings/accounts/accounts-manager';

// Server actions aren't under test here -- only the UI. The v1.6.0 pinned-mapping display
// (spec 2026-08-22, MUST-5.1: show each account's pinned mapping by name, or "none") and the
// v1.7.0 Task 1b "Update account" editor that replaced the three separate row forms.
vi.mock('@/app/(app)/settings/accounts/actions', () => ({
  createAccountAction: vi.fn(async () => ({})),
  updateAccountAction: vi.fn(async () => ({})),
  setAccountActiveAction: vi.fn(async () => ({})),
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
    // v1.7.0 Task 6 (spec 2026-08-22): null means no balance snapshot exists yet.
    latestBalanceCents: null,
    latestBalanceDate: null,
    ...over,
  };
}

describe('AccountsManager — pinned mapping display (spec 2026-08-22 v1.6.0, MUST-5.1)', () => {
  it('shows "none" for an account with no pin', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    // getAllByText because the editor's own "None" <option> would also match case-
    // insensitively once open -- the editor is closed here, but the helper stays generous.
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
    // Still shown by name, dormant-pin style -- nothing about it is hidden or nulled just
    // because the editor is closed.
    expect(screen.getByText('Old Scotia (custom)')).toBeTruthy();
  });
});

describe('AccountsManager — one Update account editor (spec 2026-08-22 v1.7.0, Task 1b)', () => {
  it('renders one Update account button and no Rename, Set owner or Set mapping buttons', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);

    expect(screen.getByRole('button', { name: 'Update account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set owner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set mapping' })).toBeNull();
  });

  it('opening the editor pre-fills name, owner and mapping with the account current values', () => {
    render(
      <AccountsManager
        accounts={[account({ id: 42, name: 'Old Name', ownerUserId: 1, importProfileId: 10, importProfileName: 'TD Chequing/Debit' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    expect((screen.getByLabelText(/Name for Old Name/i) as HTMLInputElement).value).toBe('Old Name');
    expect((screen.getByLabelText(/Owner of Old Name/i) as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText(/Mapping for Old Name/i) as HTMLSelectElement).value).toBe('10');
  });

  it('only one row editor is open at a time', () => {
    render(
      <AccountsManager
        accounts={[account({ id: 1, name: 'First' }), account({ id: 2, name: 'Second' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    const buttons = screen.getAllByRole('button', { name: 'Update account' });

    fireEvent.click(buttons[0]);
    expect(screen.getByLabelText(/Name for First/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Name for Second/i)).toBeNull();

    fireEvent.click(buttons[1]);
    expect(screen.queryByLabelText(/Name for First/i)).toBeNull();
    expect(screen.getByLabelText(/Name for Second/i)).toBeTruthy();
  });

  it('Cancel closes the editor without submitting', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));
    expect(screen.getByLabelText(/Name for Joint Chequing/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText(/Name for Joint Chequing/i)).toBeNull();
    expect(updateAccountAction).not.toHaveBeenCalled();
  });

  it('offers only the given active+readable profiles in the mapping select, plus a None option', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['None', 'TD Chequing/Debit', 'TD Visa']);
  });

  it('preselects the mapping select to the pin when it is one of the offered profiles', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 11, importProfileName: 'TD Visa' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    expect(select.value).toBe('11');
  });

  it('preselects a dormant pin as its own option, so a save that does not touch it does not clear it', () => {
    render(
      <AccountsManager
        accounts={[account({ importProfileId: 99, importProfileName: 'Old Scotia (custom)' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    expect(select.value).toBe('99');
    // getAllByText because the dormant name also still renders in the read-only Mapping
    // column outside the editor -- both places are correct, so presence is what matters.
    expect(screen.getAllByText('Old Scotia (custom)').length).toBeGreaterThan(0);
  });

  it('submits name, owner and mapping together via updateAccountAction', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42 })]} people={PEOPLE} profiles={PROFILES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const nameInput = screen.getByLabelText(/Name for Joint Chequing/i) as HTMLInputElement;
    const ownerSelect = screen.getByLabelText(/Owner of Joint Chequing/i) as HTMLSelectElement;
    const mappingSelect = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed Chequing' } });
    fireEvent.change(ownerSelect, { target: { value: '1' } });
    fireEvent.change(mappingSelect, { target: { value: '10' } });

    const form = nameInput.closest('form')!;
    fireEvent.submit(form);

    expect(updateAccountAction).toHaveBeenCalled();
    expect((form.querySelector('[name="accountId"]') as HTMLInputElement).value).toBe('42');
    expect((form.querySelector('[name="name"]') as HTMLInputElement).value).toBe('Renamed Chequing');
    expect((form.querySelector('[name="owner"]') as HTMLSelectElement).value).toBe('1');
    expect((form.querySelector('[name="profile"]') as HTMLSelectElement).value).toBe('10');
  });

  it('offers no mapping field for a SimpleFIN-managed account, even inside the editor', () => {
    render(<AccountsManager accounts={[account({ isSimplefinManaged: true })]} people={PEOPLE} profiles={PROFILES} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    expect(screen.getByLabelText(/Name for Joint Chequing/i)).toBeTruthy();
    expect(screen.getByLabelText(/Owner of Joint Chequing/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Mapping for Joint Chequing/i)).toBeNull();
  });
});

describe('AccountsManager — latest balance display and manual entry (spec 2026-08-22 v1.7.0 Task 6)', () => {
  it('shows "no balance yet" for an account with no balance snapshot', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    expect(screen.getByText('no balance yet')).toBeTruthy();
  });

  it('shows the latest balance and its as-of date for an account that has one', () => {
    render(
      <AccountsManager
        accounts={[account({ latestBalanceCents: 123456, latestBalanceDate: '2026-08-15' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    expect(screen.getByText('$1,234.56 as of 2026-08-15')).toBeTruthy();
  });

  it('shows a negative balance for a credit card without flipping its sign', () => {
    render(
      <AccountsManager
        accounts={[account({ latestBalanceCents: -45000, latestBalanceDate: '2026-08-15' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    expect(screen.getByText('-$450.00 as of 2026-08-15')).toBeTruthy();
  });

  it('the editor has no separate button or second form: Balance and Balance date are two fields inside the same Update account editor', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} today="2026-08-22" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const balanceInput = screen.getByLabelText(/Balance for Joint Chequing/i);
    const dateInput = screen.getByLabelText(/Balance date for Joint Chequing/i);
    expect(balanceInput.closest('form')).toBe(dateInput.closest('form'));
    expect(balanceInput.closest('form')).toBe(screen.getByLabelText(/Name for Joint Chequing/i).closest('form'));
    expect(screen.queryAllByRole('button', { name: /save balance/i })).toHaveLength(0);
  });

  it('opening the editor always starts Balance blank and defaults Balance date to today, regardless of the latest snapshot', () => {
    render(
      <AccountsManager
        accounts={[account({ latestBalanceCents: 999999, latestBalanceDate: '2020-01-01' })]}
        people={PEOPLE}
        profiles={PROFILES}
        today="2026-08-22"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    expect((screen.getByLabelText(/Balance for Joint Chequing/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Balance date for Joint Chequing/i) as HTMLInputElement).value).toBe('2026-08-22');
  });

  it('submits balance and asOfDate together with the rest of the form', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42 })]} people={PEOPLE} profiles={PROFILES} today="2026-08-22" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update account' }));

    const balanceInput = screen.getByLabelText(/Balance for Joint Chequing/i) as HTMLInputElement;
    fireEvent.change(balanceInput, { target: { value: '500.00' } });

    const form = balanceInput.closest('form')!;
    fireEvent.submit(form);

    expect(updateAccountAction).toHaveBeenCalled();
    expect((form.querySelector('[name="balance"]') as HTMLInputElement).value).toBe('500.00');
    expect((form.querySelector('[name="asOfDate"]') as HTMLInputElement).value).toBe('2026-08-22');
  });
});
