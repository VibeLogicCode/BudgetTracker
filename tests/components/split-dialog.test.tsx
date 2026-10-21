// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { SplitDialog } from '@/components/transactions/SplitDialog';

afterEach(cleanup);

const OPTIONS = [
  { id: 1, label: 'Groceries', depth: 0 as const },
  { id: 2, label: 'Phone', depth: 0 as const },
];

describe('SplitDialog', () => {
  it('posts the whole transaction id and the parts it was given through the action handed to it, then closes', () => {
    const action = vi.fn();
    const onClose = vi.fn();
    render(
      <SplitDialog
        target={{ id: 77, merchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217 }}
        existing={[
          { id: 501, txnId: 77, categoryId: 1, amountCents: -2000, note: null },
          { id: 502, txnId: 77, categoryId: 2, amountCents: -2217, note: 'the case' },
        ]}
        options={OPTIONS}
        action={action}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: /^Split PHONEMART 884/ })).toBeTruthy();
    expect(screen.getByText('Remaining to assign: $0.00')).toBeTruthy();
    const form = screen.getByRole('button', { name: 'Save split' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(onClose).toHaveBeenCalled();
    const data = new FormData(form);
    expect(data.get('txnId')).toBe('77');
    expect(JSON.parse(String(data.get('parts')))).toEqual([
      { categoryId: 1, amountCents: -2000, note: null },
      { categoryId: 2, amountCents: -2217, note: 'the case' },
    ]);
  });

  it('opens two blank parts for an unsplit row and keeps Save disabled until the parts add up', () => {
    render(
      <SplitDialog
        target={{ id: 78, merchant: 'MAPLE GROCER', date: '2026-03-14', amountCents: -5000 }}
        existing={[]}
        options={OPTIONS}
        action={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Save split' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
