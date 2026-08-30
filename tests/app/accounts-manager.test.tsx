// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  AccountsManager,
  discrepancyMessage,
  type AccountRow,
  type PersonRow,
  type ProfileOption,
} from '@/app/(app)/settings/accounts/accounts-manager';

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

/** Task 6 (spec 2026-08-23): "Update account" moved behind the row kebab, so every test that
 *  used to reach it with one click now opens "Actions for <name>" first -- the same two-step
 *  tests/unit/row-menu.test.tsx already uses for the menu component itself. */
function openAccountMenu(accountName: string) {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${accountName}` }));
}

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
    // v1.8.0: 0 means nothing moved since the anchor, so the anchor date is a truthful "as of"
    // label. Every fixture below that overrides only the cents/date pair inherits this and
    // therefore keeps the pre-v1.8.0 wording, which is correct for those cases.
    latestBalanceMovedCents: 0,
    // v1.8.0 Task 5 (spec 2026-08-23): empty means clean -- nothing renders. Every fixture that
    // does not care about reconciliation inherits this, which is the common case.
    discrepancies: [],
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
  it('renders one Update account item and no Rename, Set owner or Set mapping items', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Joint Chequing');

    expect(screen.getByRole('menuitem', { name: 'Update account' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Set owner' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Set mapping' })).toBeNull();
  });

  it('opening the editor pre-fills name, owner and mapping with the account current values', () => {
    render(
      <AccountsManager
        accounts={[account({ id: 42, name: 'Old Name', ownerUserId: 1, importProfileId: 10, importProfileName: 'TD Chequing/Debit' })]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );

    openAccountMenu('Old Name');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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
    openAccountMenu('First');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));
    expect(screen.getByLabelText(/Name for First/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Name for Second/i)).toBeNull();

    openAccountMenu('Second');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));
    expect(screen.queryByLabelText(/Name for First/i)).toBeNull();
    expect(screen.getByLabelText(/Name for Second/i)).toBeTruthy();
  });

  it('Cancel closes the editor without submitting', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);

    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));
    expect(screen.getByLabelText(/Name for Joint Chequing/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText(/Name for Joint Chequing/i)).toBeNull();
    expect(updateAccountAction).not.toHaveBeenCalled();
  });

  it('offers only the given active+readable profiles in the mapping select, plus a None option', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    const select = screen.getByLabelText(/Mapping for Joint Chequing/i) as HTMLSelectElement;
    expect(select.value).toBe('99');
    // getAllByText because the dormant name also still renders in the read-only Mapping
    // column outside the editor -- both places are correct, so presence is what matters.
    expect(screen.getAllByText('Old Scotia (custom)').length).toBeGreaterThan(0);
  });

  it('submits name, owner and mapping together via updateAccountAction', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42 })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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

  it('does NOT label a balance that includes movement with its anchor date', () => {
    // v1.8.0 review defect. latestSnapshots resolves through balanceAsOf, so the figure is
    // current while the date stays the ANCHOR's. Rendering "<current figure> as of <old date>"
    // is a today number wearing a July label -- exactly what ruling R7 exists to prevent. When
    // movement is non-zero the date must read as provenance, not as the balance's own date.
    render(
      <AccountsManager
        accounts={[account({ latestBalanceCents: 97500, latestBalanceDate: '2026-08-01', latestBalanceMovedCents: -2500 })]}
        people={PEOPLE}
        profiles={PROFILES}
        today="2026-08-15"
      />,
    );
    expect(screen.queryByText('$975.00 as of 2026-08-01')).toBeNull();
    expect(screen.getByText('$975.00 now · from a balance recorded 2026-08-01')).toBeTruthy();
  });

  it('the editor has no separate button or second form: Balance and Balance date are two fields inside the same Update account editor', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} today="2026-08-22" />);
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

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
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    expect((screen.getByLabelText(/Balance for Joint Chequing/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Balance date for Joint Chequing/i) as HTMLInputElement).value).toBe('2026-08-22');
  });

  it('submits balance and asOfDate together with the rest of the form', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42 })]} people={PEOPLE} profiles={PROFILES} today="2026-08-22" />);
    openAccountMenu('Joint Chequing');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    const balanceInput = screen.getByLabelText(/Balance for Joint Chequing/i) as HTMLInputElement;
    fireEvent.change(balanceInput, { target: { value: '500.00' } });

    const form = balanceInput.closest('form')!;
    fireEvent.submit(form);

    expect(updateAccountAction).toHaveBeenCalled();
    expect((form.querySelector('[name="balance"]') as HTMLInputElement).value).toBe('500.00');
    expect((form.querySelector('[name="asOfDate"]') as HTMLInputElement).value).toBe('2026-08-22');
  });
});

describe('AccountsManager — Deactivate/Reactivate via kebab (fix wave 2026-08-23 review, finding I4)', () => {
  it('an active account shows "Deactivate" in the kebab; clicking it calls setAccountActiveAction with active=0', async () => {
    const { setAccountActiveAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42, isActive: true })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Joint Chequing');

    expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Reactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }));

    await waitFor(() => expect(setAccountActiveAction).toHaveBeenCalled());
    // Bound directly to useActionState (`useActionState(setAccountActiveAction, ...)`), so the
    // FormData the kebab form built is the mock's SECOND argument (state is the first).
    const sent = (setAccountActiveAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('accountId')).toBe('42');
    expect(sent.get('active')).toBe('0');
  });

  it('a deactivated account shows "Reactivate" in the kebab; clicking it calls setAccountActiveAction with active=1', async () => {
    const { setAccountActiveAction } = await import('@/app/(app)/settings/accounts/actions');
    render(<AccountsManager accounts={[account({ id: 42, isActive: false })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Joint Chequing');

    expect(screen.getByRole('menuitem', { name: 'Reactivate' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Deactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate' }));

    await waitFor(() => expect(setAccountActiveAction).toHaveBeenCalled());
    const sent = (setAccountActiveAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('accountId')).toBe('42');
    expect(sent.get('active')).toBe('1');
  });
});

describe('discrepancyMessage (spec 2026-08-23 v1.8.0 Task 5, ruling R7)', () => {
  it('says "lower" when the imported transactions add up to more than the statement', () => {
    expect(
      discrepancyMessage({
        accountId: 1,
        fromDate: '2026-07-01',
        toDate: '2026-07-20',
        expectedCents: 95000,
        impliedCents: 100000,
        deltaCents: 5000,
      }),
    ).toBe(
      'Your statement balance for 2026-07-20 is $50.00 lower than your imported transactions account for — an import is probably missing rows between 2026-07-01 and 2026-07-20.',
    );
  });

  it('says "higher" when the imported transactions add up to less than the statement', () => {
    expect(
      discrepancyMessage({
        accountId: 1,
        fromDate: '2026-05-01',
        toDate: '2026-05-15',
        expectedCents: 20000,
        impliedCents: 19000,
        deltaCents: -1000,
      }),
    ).toBe(
      'Your statement balance for 2026-05-15 is $10.00 higher than your imported transactions account for — an import is probably missing rows between 2026-05-01 and 2026-05-15.',
    );
  });
});

describe('AccountsManager — reconciliation diagnostics (spec 2026-08-23 v1.8.0 Task 5)', () => {
  it('renders nothing extra for an account with no discrepancies', () => {
    render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    expect(screen.queryByText(/probably missing rows/i)).toBeNull();
  });

  it('renders one line per discrepancy under the account, and names both dates', () => {
    render(
      <AccountsManager
        accounts={[
          account({
            discrepancies: [
              {
                accountId: 100,
                fromDate: '2026-07-01',
                toDate: '2026-07-20',
                expectedCents: 95000,
                impliedCents: 100000,
                deltaCents: 5000,
              },
              {
                accountId: 100,
                fromDate: '2026-05-01',
                toDate: '2026-05-15',
                expectedCents: 20000,
                impliedCents: 19000,
                deltaCents: -1000,
              },
            ],
          }),
        ]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );

    expect(screen.getByText(/\$50\.00 lower than your imported transactions account for/)).toBeTruthy();
    expect(screen.getByText(/\$10\.00 higher than your imported transactions account for/)).toBeTruthy();
    expect(screen.getByText(/between 2026-07-01 and 2026-07-20/)).toBeTruthy();
    expect(screen.getByText(/between 2026-05-01 and 2026-05-15/)).toBeTruthy();
  });

  it('adds no badge -- the row keeps exactly the SimpleFIN/CSV source badge and the active/deactivated status badge it already had', () => {
    // Task 5 Step 4: diagnostic, not an alert. document.querySelectorAll rather than
    // screen.getByRole('status') or similar: a `.badge` span here carries no accessible role of
    // its own, only a class, so counting the class is the direct way to prove reconciliation did
    // not add a third one alongside the two the row already renders.
    const { container } = render(
      <AccountsManager
        accounts={[
          account({
            discrepancies: [
              {
                accountId: 100,
                fromDate: '2026-07-01',
                toDate: '2026-07-20',
                expectedCents: 95000,
                impliedCents: 100000,
                deltaCents: 5000,
              },
            ],
          }),
        ]}
        people={PEOPLE}
        profiles={PROFILES}
      />,
    );
    expect(container.querySelectorAll('.badge').length).toBe(2);
  });
});

describe('AccountsManager — responsive rows (v1.15.0, ruling S3)', () => {
  it('the Name cell of the first row carries cell-stack-headline', () => {
    const { container } = render(<AccountsManager accounts={[account()]} people={PEOPLE} profiles={PROFILES} />);
    const headlineCell = container.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });
});
