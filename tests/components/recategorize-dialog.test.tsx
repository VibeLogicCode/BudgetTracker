// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { RecategorizeDialog, type RecategorizeRow } from '@/components/transactions/RecategorizeDialog';

afterEach(() => cleanup());

const ROW: RecategorizeRow = { id: 77, merchant: 'Phonemart', normalizedMerchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217, categoryId: 1, source: 'rule', filedBy: { ruleId: 9, pattern: 'PHONEMART', matchType: 'contains' }, alwaysAsked: false };
const OPTIONS: { id: number; label: string; depth: 0 | 1 }[] = [{ id: 1, label: 'Groceries', depth: 0 }, { id: 2, label: 'Phone', depth: 0 }];

describe('RecategorizeDialog', () => {
  it('names the row, starts at its category, posts the picked one with the row id, and closes', () => {
    const onClose = vi.fn();
    render(<RecategorizeDialog row={ROW} options={OPTIONS} action={vi.fn()} canAuthorRules={false} isAdmin={false} onClose={onClose} onAlwaysAsk={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /^Category for Phonemart/ })).toBeTruthy();
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('Groceries');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Pho' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Phone' }));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    const data = new FormData(form);
    expect({ transactionId: data.get('transactionId'), categoryId: data.get('categoryId'), teach: data.get('teach') }).toEqual({ transactionId: '77', categoryId: '2', teach: null });
    fireEvent.submit(form);
    expect(onClose).toHaveBeenCalled();
  });
});
