// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RuleReviewCard, RULE_REVIEW_ROW_LIMIT } from '@/components/RuleReviewCard';
import type { UnreviewedImportRow } from '@/lib/import/commit';

afterEach(cleanup);

const row = (over: Partial<UnreviewedImportRow> = {}): UnreviewedImportRow => ({
  importId: 1,
  accountId: 10,
  accountName: 'Joint Chequing',
  filename: 'march.csv',
  createdAt: '2026-03-04T12:00:00.000Z',
  ruleRowCount: 3,
  ...over,
});

/**
 * v1.26.0 Lane 3b. Props-only, in the manner of NeedsALookCard/GettingStartedCard: every
 * signal is computed by unreviewedRuleImports() (src/lib/import/commit.ts), so this component
 * cannot disagree with the database. The Dismiss button is rendered but never clicked here --
 * clicking it would run the real 'use server' dismissRuleImportAction, which touches next/headers
 * and the DB; that round trip is exercised for real in tests/app/dashboard.test.tsx instead,
 * against a seeded test DB (the same division of labour ComingUpCard.test.tsx and
 * RecordPaymentForm already draw for the "Record payment" button).
 */
describe('RuleReviewCard (v1.26.0 Lane 3b)', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<RuleReviewCard imports={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists the account, filename and count for one unreviewed import', () => {
    render(<RuleReviewCard imports={[row()]} />);
    expect(screen.getByText('Joint Chequing')).toBeTruthy();
    expect(screen.getByText(/march\.csv/)).toBeTruthy();
    expect(screen.getByText(/3 transactions categorized by a rule/)).toBeTruthy();
  });

  it('says "transaction" singular for a count of one', () => {
    render(<RuleReviewCard imports={[row({ ruleRowCount: 1 })]} />);
    expect(screen.getByText(/1 transaction categorized by a rule/)).toBeTruthy();
  });

  it('links each row to the fixed audit contract URL, verbatim -- never a param this card invents', () => {
    render(<RuleReviewCard imports={[row({ importId: 42 })]} />);
    const link = screen.getByRole('link', { name: 'Check' });
    expect(link.getAttribute('href')).toBe('/transactions?import=42&source=rule&group=category');
  });

  it('offers a Dismiss control per row', () => {
    render(<RuleReviewCard imports={[row()]} />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });

  it('caps the list at RULE_REVIEW_ROW_LIMIT and reports how many more there are', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT + 3 }, (_, i) =>
      row({ importId: i + 1, filename: `statement-${i}.csv` }),
    );
    render(<RuleReviewCard imports={rows} />);
    expect(screen.getAllByRole('link', { name: 'Check' })).toHaveLength(RULE_REVIEW_ROW_LIMIT);
    expect(screen.getByText('+3 more to check')).toBeTruthy();
  });

  it('renders no overflow line when everything fits inside the cap', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT }, (_, i) => row({ importId: i + 1 }));
    render(<RuleReviewCard imports={rows} />);
    expect(screen.queryByText(/more to check/)).toBeNull();
  });
});
