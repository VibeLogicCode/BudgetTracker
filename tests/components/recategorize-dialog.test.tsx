// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { RecategorizeDialog, type RecategorizeRow } from '@/components/transactions/RecategorizeDialog';

afterEach(() => cleanup());

const ROW: RecategorizeRow = { id: 77, merchant: 'Phonemart', normalizedMerchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217, categoryId: 1, source: 'rule', filedBy: { ruleId: 9, pattern: 'PHONEMART', matchType: 'contains', bounded: false }, alwaysAsked: false };
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

describe('the rule choice (spec §2.4)', () => {
  const base = { options: OPTIONS, action: vi.fn(), onClose: vi.fn(), onAlwaysAsk: vi.fn() };

  it('offers the three choices on a rule-filed row, says a wider rule is outranked, and posts teach=1 for Also file', () => {
    render(<RecategorizeDialog {...base} row={ROW} canAuthorRules isAdmin={false} />);
    expect(screen.getByRole('group', { name: 'Future PHONEMART 884 rows' })).toBeTruthy();
    expect((screen.getByLabelText(/Change this transaction only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Adds a rule for PHONEMART 884 that wins over PHONEMART (contains). Other PHONEMART rows keep their rule.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Also file PHONEMART 884 this way from now on/));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    expect(new FormData(form).get('teach')).toBe('1');
  });

  it('says the rule itself changes when it is exact on this merchant', () => {
    render(<RecategorizeDialog {...base} row={{ ...ROW, filedBy: { ruleId: 9, pattern: 'PHONEMART 884', matchType: 'exact', bounded: false } }} canAuthorRules isAdmin={false} />);
    expect(screen.getByText('Changes the rule PHONEMART 884 → Groceries to the category you pick.')).toBeTruthy();
  });

  /** v1.57.1: no rule can be named, and the row was not a guess. */
  it('a rule-filed row whose rule has changed since says so, not the guess hint, and keeps the three choices', () => {
    render(<RecategorizeDialog {...base} row={{ ...ROW, filedBy: null }} canAuthorRules isAdmin />);
    expect(screen.getByRole('group', { name: 'Future PHONEMART 884 rows' })).toBeTruthy();
    expect(screen.getByLabelText(/Change this transaction only/)).toBeTruthy();
    expect(screen.getByLabelText(/Always ask about PHONEMART 884 from now on/)).toBeTruthy();
    const teach = screen.getByLabelText(/Also file PHONEMART 884 this way from now on/).closest('label') as HTMLElement;
    expect(teach.textContent).toBe('Also file PHONEMART 884 this way from now onSet by a rule (it has changed since). Saves an exact rule for PHONEMART 884 with the category you pick.');
    expect(screen.queryByText(/guesser/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit the rule under Settings' })).toBeNull();
  });

  it('offers no Also file option when the filing rule is amount-bounded, and keeps the other two and the admin link', () => {
    render(<RecategorizeDialog {...base} row={{ ...ROW, filedBy: { ruleId: 9, pattern: 'PHONEMART', matchType: 'contains', bounded: true } }} canAuthorRules isAdmin />);
    expect(screen.queryByLabelText(/Also file/)).toBeNull();
    expect(screen.queryByText(/wins over/)).toBeNull();
    expect((screen.getByLabelText(/Change this transaction only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText(/Always ask about PHONEMART 884 from now on/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit the rule under Settings' }).getAttribute('href')).toBe('/settings/merchant-rules?kind=category&q=PHONEMART');
  });

  it('posts no teach once Uncategorized is picked after Also file was chosen, and disables the option meanwhile', () => {
    render(<RecategorizeDialog {...base} row={ROW} canAuthorRules isAdmin={false} />);
    fireEvent.click(screen.getByLabelText(/Also file PHONEMART 884 this way from now on/));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    expect(new FormData(form).get('teach')).toBe('1');
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Uncat' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Uncategorized/ }));
    expect(new FormData(form).get('categoryId')).toBe('');
    expect(new FormData(form).get('teach')).toBeNull();
    expect((screen.getByLabelText(/Also file PHONEMART 884 this way from now on/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Change this transaction only/) as HTMLInputElement).checked).toBe(true);
  });

  it('Always ask posts no teach and tells the caller to open the Always ask dialog; it is absent once the merchant is already asked about', () => {
    const onAlwaysAsk = vi.fn();
    const { unmount } = render(<RecategorizeDialog {...base} onAlwaysAsk={onAlwaysAsk} row={ROW} canAuthorRules isAdmin={false} />);
    fireEvent.click(screen.getByLabelText(/Always ask about PHONEMART 884 from now on/));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    expect(new FormData(form).get('teach')).toBeNull();
    fireEvent.submit(form);
    expect(onAlwaysAsk).toHaveBeenCalled();
    unmount();
    render(<RecategorizeDialog {...base} row={{ ...ROW, alwaysAsked: true }} canAuthorRules isAdmin={false} />);
    expect(screen.queryByLabelText(/Always ask about/)).toBeNull();
  });

  it('a self viewer gets no rule choice, a hand-set row gets none, and an admin gets the Rules page link', () => {
    const { unmount } = render(<RecategorizeDialog {...base} row={ROW} canAuthorRules={false} isAdmin={false} />);
    expect(screen.queryByRole('group')).toBeNull();
    unmount();
    const second = render(<RecategorizeDialog {...base} row={{ ...ROW, source: 'manual', filedBy: null }} canAuthorRules isAdmin />);
    expect(screen.queryByRole('group')).toBeNull();
    second.unmount();
    render(<RecategorizeDialog {...base} row={ROW} canAuthorRules isAdmin />);
    expect(screen.getByRole('link', { name: 'Edit the rule under Settings' }).getAttribute('href')).toBe('/settings/merchant-rules?kind=category&q=PHONEMART');
  });
});
