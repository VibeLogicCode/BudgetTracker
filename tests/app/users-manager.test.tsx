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
  setActiveAction: vi.fn(async () => ({})),
  resetPasswordAction: vi.fn(async () => ({})),
  resetMfaAction: vi.fn(async () => ({})),
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
    ...over,
  };
}

function openUserMenu(userName: string) {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${userName}` }));
}

// Fix wave (2026-08-23 review, finding I4): the RowMenuForm dispatch paths on this page had
// zero coverage that clicking the menuitem actually fires the bound server action.
describe('UsersManager — Deactivate/Reactivate and Reset MFA via kebab', () => {
  it('an active user shows "Deactivate"; clicking it calls setActiveAction with active=0', async () => {
    const { setActiveAction } = await import('@/app/(app)/settings/users/actions');
    render(<UsersManager users={[user({ id: 7, isActive: true })]} />);
    openUserMenu('Alex');

    expect(screen.getByRole('menuitem', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Reactivate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }));

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

  it('clicking "Reset MFA" calls resetMfaAction with that user\'s id', async () => {
    const { resetMfaAction } = await import('@/app/(app)/settings/users/actions');
    render(<UsersManager users={[user({ id: 9, totpEnabled: true })]} />);
    openUserMenu('Alex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset MFA' }));

    await waitFor(() => expect(resetMfaAction).toHaveBeenCalled());
    const sent = (resetMfaAction as ReturnType<typeof vi.fn>).mock.calls[0][1] as FormData;
    expect(sent.get('userId')).toBe('9');
  });
});
