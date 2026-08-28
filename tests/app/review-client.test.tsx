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
    // Matched narrowly (plural "transactions," + count) rather than on "plus future imports"
    // alone: fix round on 5439851 (item 5) put that same phrase in PageGuide's always-rendered
    // copy too, so a loose match against it would false-pass this assertion regardless of
    // whether the apply-to-all group itself is actually absent.
    expect(screen.queryByText(/\d+ transactions, plus future imports/)).toBeNull();
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

  // Fix round on 5439851, item 3: normalizeMerchant uppercases and collapses whitespace, so a raw
  // description that differs from the normalized merchant only by case/underscore-vs-space still
  // rendered twice ("King of the Nor_f — KING OF THE NOR_F") even though nothing meaningful
  // changed. The dedupe must compare on the same footing: trim + collapse whitespace + uppercase.
  it('renders the name once when the raw description differs from the normalized merchant only by case', () => {
    const { container } = render(
      <ReviewClient
        total={1}
        rows={[
          row({
            id: 6,
            normalizedMerchant: 'KING OF THE NOR_F',
            rawDescription: 'King of the Nor_f',
            matchingCount: 1,
          }),
        ]}
        categories={categories}
      />,
    );
    expect(container.textContent).not.toContain('—');
    expect(screen.getByText('KING OF THE NOR_F')).toBeTruthy();
  });

  // Fix round on 5439851, item 1: bulk options must keep NBSP indentation (ASCII spaces collapse
  // in rendered text), so a depth-1 category's rendered option text still starts with two NBSPs.
  it('renders bulk-select depth-1 category options with NBSP indentation', () => {
    const nestedCategories: CategoryRecord[] = [
      { id: 1, name: 'Dining', parentId: null, icon: null, color: null, isIncome: false, isArchived: false, sortOrder: 0, taxRelevant: false },
      { id: 2, name: 'Coffee', parentId: 1, icon: null, color: null, isIncome: false, isArchived: false, sortOrder: 0, taxRelevant: false },
    ];
    const { container } = render(
      <ReviewClient
        total={1}
        rows={[row({ id: 7, normalizedMerchant: 'CITY GROCER', matchingCount: 2 })]}
        categories={nestedCategories}
      />,
    );
    const options = Array.from(container.querySelectorAll('option')).filter((option) =>
      (option.textContent ?? '').startsWith('  '),
    );
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((option) => option.textContent === '  Coffee')).toBe(true);
  });

  // Fix round on 5439851, item 4 (WCAG 2.5.3 label-in-name): the accessible name must fully name
  // the select's scope, not leave "this transaction only" / "every transaction" unstated.
  it('names the per-row select fully, including its single-transaction scope', () => {
    render(<ReviewClient total={1} rows={[row()]} categories={categories} />);
    expect(screen.getByLabelText('Category for TIM HORTONS — this transaction only')).toBeTruthy();
  });

  it('names the bulk select fully, including its every-transaction scope', () => {
    render(
      <ReviewClient
        total={1}
        rows={[row({ id: 8, normalizedMerchant: 'CITY GROCER', matchingCount: 3 })]}
        categories={categories}
      />,
    );
    expect(screen.getByLabelText('Category for all 3 matching CITY GROCER — every transaction')).toBeTruthy();
  });

  // Fix round on 5439851, item 5: matchingCount counts every non-transfer row with that merchant,
  // categorised rows included -- not just "other unsorted rows". PageGuide's copy must match.
  it('describes the apply-to-all count as every transaction with that merchant, not just unsorted ones', () => {
    render(<ReviewClient total={1} rows={[row()]} categories={categories} />);
    expect(screen.getByText(/every transaction with that merchant, plus future imports/)).toBeTruthy();
  });
});
