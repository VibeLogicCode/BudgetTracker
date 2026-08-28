// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { ReviewClient } from '@/app/(app)/review/review-client';
import type { TransactionRow } from '@/lib/transactions';
import type { CategoryRecord } from '@/lib/categories';

vi.mock('@/app/(app)/review/actions', () => ({
  acceptGuessAction: vi.fn(async () => ({})),
  applyToAllMatchingAction: vi.fn(async () => ({})),
  fixCategoryAction: vi.fn(async () => ({})),
  markTransferAction: vi.fn(async () => ({})),
}));

afterEach(() => cleanup());

const categories: CategoryRecord[] = [
  {
    id: 1,
    name: 'Dining',
    parentId: null,
    icon: null,
    color: null,
    isIncome: false,
    isArchived: false,
    sortOrder: 0,
    taxRelevant: false,
  },
];

function row(overrides: Partial<TransactionRow & { matchingCount: number }> = {}): TransactionRow & { matchingCount: number } {
  return {
    id: 1,
    date: '2026-08-03',
    accountId: 1,
    accountName: 'Joint Chequing',
    rawDescription: 'TIM HORTONS #4021',
    displayDescription: null,
    displaySource: null,
    normalizedMerchant: 'TIM HORTONS',
    amountCents: -412,
    categoryId: null,
    categoryName: null,
    source: 'none',
    confidence: null,
    isTransfer: false,
    attributedUserId: null,
    attributedUserName: null,
    notes: null,
    importId: null,
    matchingCount: 1,
    ...overrides,
  };
}

describe('ReviewClient — labeling the per-row and apply-to-all category selects', () => {
  it('labels the per-row select "This transaction only"', () => {
    render(<ReviewClient total={1} rows={[row()]} categories={categories} />);
    expect(screen.getByText('This transaction only')).toBeTruthy();
  });

  it('does not show the apply-to-all group for a row with no other matches', () => {
    render(<ReviewClient total={1} rows={[row({ matchingCount: 1 })]} categories={categories} />);
    expect(screen.queryByText(/plus future imports/)).toBeNull();
  });

  it('shows the apply-to-all group with a merchant-and-count heading when matchingCount > 1', () => {
    render(
      <ReviewClient
        total={1}
        rows={[row({ id: 2, normalizedMerchant: 'CITY GROCER', matchingCount: 3 })]}
        categories={categories}
      />,
    );
    expect(screen.getByText('Every "CITY GROCER" — 3 transactions, plus future imports')).toBeTruthy();
  });

  it('carries the hint steering ambiguous merchants back to the per-row select', () => {
    render(
      <ReviewClient
        total={1}
        rows={[row({ id: 3, normalizedMerchant: 'CITY GROCER', matchingCount: 3 })]}
        categories={categories}
      />,
    );
    expect(
      screen.getByText(
        'Only for merchants that are always one category (coffee shop, streaming). Walmart, Amazon, e-transfers: use the select above.',
      ),
    ).toBeTruthy();
  });

  it('renders a merchant name once (no "X — X") when it matches the raw description exactly', () => {
    const { container } = render(
      <ReviewClient
        total={1}
        rows={[row({ id: 4, normalizedMerchant: 'TIM HORTONS', rawDescription: 'TIM HORTONS' })]}
        categories={categories}
      />,
    );
    // matchingCount is 1 for this row, so the apply-to-all group (the only other place an
    // em dash appears) is absent -- any "—" left in the row title itself would be the bug.
    expect(container.textContent).not.toContain('—');
    expect(screen.getByText('TIM HORTONS')).toBeTruthy();
  });

  it('still renders "X — Y" when the merchant and raw description differ', () => {
    const { container } = render(
      <ReviewClient
        total={1}
        rows={[row({ id: 5, normalizedMerchant: 'TIM HORTONS', rawDescription: 'TIM HORTONS #4021' })]}
        categories={categories}
      />,
    );
    expect(container.textContent).toContain('TIM HORTONS — TIM HORTONS #4021');
  });
});
