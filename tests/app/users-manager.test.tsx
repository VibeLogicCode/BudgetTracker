// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { UsersManager } from '@/app/(app)/settings/users/users-manager';
import type { UserRecord } from '@/lib/auth/users';

// Server actions aren't under test here -- only that the kebab wires each menuitem to the
// right bound action, the same idiom accounts-manager.test.tsx and transactions-client.test.tsx
// use for their own RowMenuForm items.
vi.mock('@/app/(app)/settings/users/actions', () => ({
  createUserAction: vi.fn(async () => ({})),
  createPersonAction: vi.fn(async () => ({})),
  setActiveAction: vi.fn(async () => ({})),
  setVisibilityAction: vi.fn(async () => ({})),
  resetPasswordAction: vi.fn(async () => ({})),
  resetMfaAction: vi.fn(async () => ({})),
  setCanSignInAction: vi.fn(async () => ({})),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function user(over: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 1,
    name: 'Alex',
    username: 'alex',
    role: 'member',
    totpEnabled: false,
    isActive: true,
    mustChangePassword: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    visibility: 'household',
    canSignIn: true,
    lastAccountId: null,
    ...over,
  };
}

function openUserMenu(userName: string) {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${userName}` }));
}

const member = {
  id: 2,
  name: 'Bob',
  username: 'bob',
  role: 'member',
  totpEnabled: true,
  isActive: true,
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  visibility: 'household',
  canSignIn: true,
  lastAccountId: null,
} as UserRecord;

// Fix wave (2026-08-23 review, finding I4): the RowMenuForm dispatch paths on this page had
// zero coverage that clicking the menuitem actually fires the bound server action.
describe('UsersManager — Deactivate/Reactivate and Reset MFA via kebab', () => {
  it('an active user shows "Deactivate"; confirming it calls setActiveAction with active=0', async () => {
    // v1.12.1 (item AU / UX-6, ruling R5): Deactivate now opens an inline confirm row rather
    // than posting straight from the menuitem -- see the describe block below for the panel
    // itself. This test still covers the eventual dispatch, one click further in.
    const { setActiveAction } = await import('@/app/(app)/settings/users/actions');
    render(<UsersManager users={[user({ id: 7, isActive: true })]} />);
    openUserMenu('Alex');

    expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Reactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(setActiveAction).toHaveBeenCalled());
    // Bound directly to useActionState (`useActionState(setActiveAction, ...)`), so the
    // FormData the kebab form built is the mock's SECOND argument (state is the first).
    const sent = (setActiveAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('userId')).toBe('7');
    expect(sent.get('active')).toBe('0');
  });

  it('a deactivated user shows "Reactivate"; clicking it calls setActiveAction with active=1', async () => {
    const { setActiveAction } = await import('@/app/(app)/settings/users/actions');
    render(<UsersManager users={[user({ id: 7, isActive: false })]} />);
    openUserMenu('Alex');

    expect(screen.getByRole('menuitem', { name: 'Reactivate' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Deactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate' }));

    await waitFor(() => expect(setActiveAction).toHaveBeenCalled());
    const sent = (setActiveAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('userId')).toBe('7');
    expect(sent.get('active')).toBe('1');
  });

  it('confirming "Reset MFA" calls resetMfaAction with that user\'s id', async () => {
    // v1.12.1 (item AU / UX-6, ruling R5): same confirm-row detour as Deactivate, above.
    const { resetMfaAction } = await import('@/app/(app)/settings/users/actions');
    render(<UsersManager users={[user({ id: 9, totpEnabled: true })]} />);
    openUserMenu('Alex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset MFA' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset MFA' }));

    await waitFor(() => expect(resetMfaAction).toHaveBeenCalled());
    const sent = (resetMfaAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('userId')).toBe('9');
  });
});

describe('v1.12.1: Deactivate and Reset MFA ask first (item AU / UX-6, ruling R5)', () => {
  it('Deactivate opens a confirm row naming the person, and posts nothing until confirmed', async () => {
    render(<UsersManager users={[member]} />);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${member.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));

    const panel = await screen.findByText(/They will not be able to sign in/);
    expect(panel.textContent).toContain(member.name);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // The confirm row carries the submit; the menu item itself posted nothing.
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
  });

  it('Cancel closes the confirm row', async () => {
    render(<UsersManager users={[member]} />);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${member.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Deactivate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(/They will not be able to sign in/)).toBeNull());
  });

  it('Reset MFA opens its own confirm row, worded for what it actually does', async () => {
    render(<UsersManager users={[member]} />);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${member.name}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset MFA' }));

    expect((await screen.findByText(/Every one of their sessions is signed out/)).textContent).toContain(member.name);
  });
});

describe('item BI: a sign-in toggle on every row', () => {
  it('offers a sign-in toggle on every row (item BI)', () => {
    render(<UsersManager users={[user({ id: 2, name: 'Bob', canSignIn: true })]} />);
    const toggle = screen.getByLabelText('Bob can sign in') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('reflects an attribution-only person', () => {
    render(<UsersManager users={[user({ id: 3, name: 'Robin', canSignIn: false })]} />);
    expect((screen.getByLabelText('Robin can sign in') as HTMLInputElement).checked).toBe(false);
  });
});

describe('UsersManager — responsive rows (v1.15.0, ruling S3)', () => {
  it('the Name cell of the first row carries cell-stack-headline', () => {
    const { container } = render(<UsersManager users={[user()]} />);
    const headlineCell = container.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });
});

// 2026-08-30 Settings disclosure sweep: ONE toggle reveals BOTH "Add a user" and "Add a person
// without a login" -- see the addUserOpen docblock in users-manager.tsx for why the pair shares
// a control instead of getting one each.
describe('UsersManager — "Add a user" is a disclosure covering both create cards (2026-08-30 Settings sweep)', () => {
  it('is closed on first paint: the toggle reads "Add a user" and both create forms are hidden', () => {
    const { container } = render(<UsersManager users={[user()]} />);
    const toggle = screen.getByRole('button', { name: 'Add a user' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('add-user-body');
    // `queryByPlaceholderText` finds a node whether or not it is hidden (only `byRole` respects
    // the accessibility tree by default), so closedness is checked directly on the wrapper's
    // `hidden` property -- one wrapper covers both cards (see the addUserOpen docblock in
    // users-manager.tsx for why this pair shares a single toggle and a single wrapper).
    expect((container.querySelector('#add-user-body') as HTMLElement).hidden).toBe(true);
  });

  it('opens on click, revealing both create forms, and the toggle becomes Close', () => {
    render(<UsersManager users={[user()]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a user' }));
    const toggle = screen.getByRole('button', { name: 'Close' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByPlaceholderText('Alex')).toBeTruthy();
    expect(screen.getByPlaceholderText('Robin')).toBeTruthy();
  });
});
