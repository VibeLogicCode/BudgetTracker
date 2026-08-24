// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutoSaveSelect, AutoSaveTextInput } from '@/components/ui/AutoSave';

afterEach(() => cleanup());

const CATEGORIES = [
  { value: '', label: 'Uncategorized' },
  { value: '1', label: 'Groceries' },
  { value: '2', label: 'Transport' },
];

function statusOf(): string | null {
  return document.querySelector('[data-autosave-status]')?.getAttribute('data-autosave-status') ?? null;
}

describe('AutoSaveSelect', () => {
  it('saves on change, sending the hidden fields plus the control name and value', async () => {
    // Typed explicitly (not just `async () => ({})`): otherwise vitest infers a zero-arg
    // mock, and `.mock.calls[0][0]` below has no such index under strict mode -- the mock's
    // OWN inferred arity, not the component's declared action type, decides that.
    const action = vi.fn(async (_formData: FormData) => ({}));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    fireEvent.change(screen.getByLabelText('Category for transaction 42'), { target: { value: '1' } });

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get('transactionId')).toBe('42');
    expect(sent.get('categoryId')).toBe('1');
  });

  it('shows the saved tick when the action returns no error', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    fireEvent.change(screen.getByLabelText('Category for transaction 42'), { target: { value: '1' } });

    await waitFor(() => expect(statusOf()).toBe('saved'));
  });

  it('reverts the value and shows the server message when the action fails', async () => {
    const action = vi.fn(async () => ({ error: 'This transaction is split — clear its split first.' }));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue="2"
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    const select = screen.getByLabelText('Category for transaction 42') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('clear its split first'));
    // The whole point of the revert: the control must not keep showing a value the server
    // refused, or the row lies about what is stored.
    expect(select.value).toBe('2');
    expect(statusOf()).toBe('error');
  });

  it('ends on the last write when a second change arrives while the first is still in flight', async () => {
    const seen: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const action = vi.fn(async (formData: FormData) => {
      const value = String(formData.get('categoryId'));
      seen.push(value);
      if (releaseFirst === null) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {};
    });
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    const select = screen.getByLabelText('Category for transaction 42') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(seen).toEqual(['1']));
    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() => expect(seen).toEqual(['1', '2']));

    // Cast, not a bare reference: `releaseFirst` is reassigned only inside the mock's
    // closure above, which TS's control-flow analysis can't see across -- left as `let ...
    // | null`, it narrows this read to the literal `null` and an optional call on `null`
    // alone (no callable member left) is itself a type error, not a pass-through no-op.
    (releaseFirst as (() => void) | null)?.();

    // The stale first response must not overwrite the second: last write wins, and the
    // control keeps the value the person actually chose last.
    await waitFor(() => expect(statusOf()).toBe('saved'));
    expect(select.value).toBe('2');
  });
});

describe('AutoSaveTextInput', () => {
  it('saves on Enter', async () => {
    // Explicit param, same reason as AutoSaveSelect's first test above.
    const action = vi.fn(async (_formData: FormData) => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
        inputMode="decimal"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0][0] as FormData).get('amount')).toBe('250.00');
  });

  it('saves on blur when the value changed', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.blur(input);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it('never fires on an untouched blur, and never twice for one Enter-then-blur', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(action).not.toHaveBeenCalled();

    // Enter then blur is one edit, not two: tabbing away after pressing Enter must not
    // re-send the same value.
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});
