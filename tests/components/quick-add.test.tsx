// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';

vi.mock('@/app/(app)/transactions/actions', () => ({
  manualEntryAction: vi.fn(async () => ({ message: 'Transaction added.' })),
}));

afterEach(() => {
  cleanup();
  // Ruling S6 tests below set this to prove the PWA-shortcut effect; reset it so a later test in
  // this file never inherits it.
  window.location.hash = '';
});

/**
 * Sets an <input>'s value through the NATIVE value setter rather than the plain `el.value = x`
 * assignment, then dispatches a real 'input' event. React 19 wraps the DOM property setter with
 * its own tracker so it can tell a real user keystroke apart from a programmatic set; a bare
 * `el.value = x` goes through that same wrapped setter, which updates the tracker's own record of
 * "last known value" as a side effect -- so the dispatched event that follows looks like a no-op
 * change and React's onInput handler never runs. Reaching the *native* setter first (the one
 * React itself wraps) is the standard workaround.
 */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const props = {
  accounts: [
    { id: 1, name: 'Chequing' },
    { id: 2, name: 'Pocket money' },
  ],
  categories: [{ id: 3, name: 'Groceries', parentId: null, sortOrder: 0, isArchived: false }],
  people: [{ id: 1, name: 'Person One' }],
  today: '2026-08-27',
  defaultAccountId: 2,
  variant: 'page' as const,
};

describe('QuickAddTransaction (ruling R7)', () => {
  it('preselects the account this person used last', () => {
    render(<QuickAddTransaction {...props} />);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('2');
  });

  it('falls back to the cash option when there is no last account', () => {
    render(<QuickAddTransaction {...props} defaultAccountId={null} />);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('cash');
  });

  it('defaults the date to today', () => {
    render(<QuickAddTransaction {...props} />);
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-08-27');
  });

  it('carries the #quick-add anchor on the page variant and not on the card variant', () => {
    const { container, rerender } = render(<QuickAddTransaction {...props} />);
    expect(container.querySelector('#quick-add')).not.toBeNull();
    rerender(<QuickAddTransaction {...props} variant="card" />);
    expect(container.querySelector('#quick-add')).toBeNull();
  });

  it('sends direction=income only when the amount is typed with a leading plus', () => {
    render(<QuickAddTransaction {...props} />);
    const direction = document.querySelector('input[name="direction"]') as HTMLInputElement;
    // exact: false -- Field puts its `hint` text inside the same wrapping <label> as the
    // control (docs/PENDING-FIXES.md item J, a known and separately-tracked defect this task
    // does not fix), so the Amount field's accessible label text is actually "AmountStart with
    // + for money in", not "Amount" alone.
    const amount = screen.getByLabelText('Amount', { exact: false }) as HTMLInputElement;
    setNativeInputValue(amount, '12.34');
    expect(direction.value).toBe('spend');
    setNativeInputValue(amount, '+12.34');
    expect(direction.value).toBe('income');
  });

  it('lists only the accounts it was given (asset accounts are filtered out upstream, ruling R10)', () => {
    render(<QuickAddTransaction {...props} />);
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['cash', '1', '2']);
  });

  it('groups a child category under its parent in an <optgroup> (backlog BZ)', () => {
    render(
      <QuickAddTransaction
        {...props}
        categories={[
          { id: 1, name: 'Fees', parentId: null, sortOrder: 0, isArchived: false },
          { id: 2, name: 'Bank Fees', parentId: 1, sortOrder: 1, isArchived: false },
        ]}
      />,
    );
    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    const optgroup = select.querySelector('optgroup');
    expect(optgroup?.label).toBe('Fees');
    expect(Array.from(optgroup?.querySelectorAll('option') ?? []).map((o) => o.value)).toEqual(['1', '2']);
  });

  it('renders no Person field when there is nobody to attribute to (item BO)', () => {
    render(<QuickAddTransaction {...props} people={[]} />);
    // With people: [] the select degenerated to a lone "Account default" option -- a control
    // that cannot do anything, which is what item BO is about.
    expect(screen.queryByLabelText('Person')).toBeNull();
  });

  it('still renders it for a household viewer', () => {
    render(<QuickAddTransaction {...props} />);
    expect(screen.getByLabelText('Person')).toBeTruthy();
  });
});

/**
 * v1.15.0 ruling S6: `collapsible` folds Quick add into a disclosure, closed by default, on
 * Transactions. Default false, so every test above (which never passes it) proves BOTH variants'
 * render stays exactly as it was before this ruling.
 */
describe('QuickAddTransaction (ruling S6): the collapsible disclosure', () => {
  it('with collapsible and variant="page", starts closed and shows only the toggle', () => {
    render(<QuickAddTransaction {...props} collapsible />);
    const toggle = screen.getByRole('button', { name: 'Add a transaction' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Description')).toBeNull();
  });

  it('clicking the toggle opens the form, relabels itself "Close", and closing it again removes the form', () => {
    render(<QuickAddTransaction {...props} collapsible />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a transaction' }));

    const closeToggle = screen.getByRole('button', { name: 'Close' });
    expect(closeToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Description', { exact: false })).toBeTruthy();

    fireEvent.click(closeToggle);
    expect(screen.getByRole('button', { name: 'Add a transaction' })).toBeTruthy();
    expect(screen.queryByLabelText('Description')).toBeNull();
  });

  it('opens on mount when the hash matches #quick-add, so the PWA manifest shortcut (ruling R7) still lands on an open form', () => {
    window.location.hash = '#quick-add';
    render(<QuickAddTransaction {...props} collapsible />);
    expect(screen.getByRole('button', { name: 'Close' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Description', { exact: false })).toBeTruthy();
  });

  it('does not open on mount when the hash does not match', () => {
    window.location.hash = '#something-else';
    render(<QuickAddTransaction {...props} collapsible />);
    expect(screen.getByRole('button', { name: 'Add a transaction' })).toBeTruthy();
  });

  it('with collapsible and variant="card", also starts closed behind the same toggle (v1.16.0 Lane C item 1)', () => {
    render(<QuickAddTransaction {...props} variant="card" collapsible />);
    const toggle = screen.getByRole('button', { name: 'Add a transaction' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Description')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Description', { exact: false })).toBeTruthy();
  });

  it('without collapsible, the card variant stays exactly as it was before this ruling -- the form is always mounted, with no toggle', () => {
    render(<QuickAddTransaction {...props} variant="card" />);
    expect(screen.queryByRole('button', { name: 'Add a transaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    // The form is there, unconditionally, exactly as the pre-Lane-C-item-1 render needs.
    expect(screen.getByLabelText('Description', { exact: false })).toBeTruthy();
  });
});
