// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
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

  it('shows the first RULE_REVIEW_ROW_LIMIT rows and opens the rest in place, never a link away', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT + 4 }, (_, i) =>
      row({ importId: i + 1, filename: `statement-${i}.csv` }),
    );
    const { container } = render(<RuleReviewCard imports={rows} />);

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    const summary = details!.querySelector('summary');
    expect(summary?.textContent).toBe('+4 more to check');
    expect(summary?.className).toContain('text-accent-text');

    // The first five sit outside the disclosure, the other four inside it -- each with the same
    // Check link and Dismiss control as the rows above.
    const outside = Array.from(container.querySelectorAll('a')).filter((a) => !details!.contains(a));
    expect(outside.filter((a) => a.textContent === 'Check')).toHaveLength(RULE_REVIEW_ROW_LIMIT);
    const inside = within(details!);
    const insideChecks = inside.getAllByRole('link', { name: 'Check', hidden: true });
    expect(insideChecks.map((a) => a.getAttribute('href'))).toEqual(
      [6, 7, 8, 9].map((id) => `/transactions?import=${id}&source=rule&group=category`),
    );
    expect(inside.getAllByRole('button', { name: 'Dismiss', hidden: true })).toHaveLength(4);
    for (const i of [5, 6, 7, 8]) expect(details!.textContent).toContain(`statement-${i}.csv`);

    // The Import screen never listed which imports still need a check, so nothing points there.
    expect(container.querySelector('a[href="/import"]')).toBeNull();
  });

  it('renders no overflow line when everything fits inside the cap', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT }, (_, i) => row({ importId: i + 1 }));
    const { container } = render(<RuleReviewCard imports={rows} />);
    expect(screen.queryByText(/more to check/)).toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });

  it('offers Dismiss all, carrying every listed import id, once there are two or more', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT + 2 }, (_, i) => row({ importId: (i + 1) * 10 }));
    const { container } = render(<RuleReviewCard imports={rows} />);
    const button = screen.getByRole('button', { name: 'Dismiss all' });
    const form = button.closest('form')!;
    const ids = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="importId"]')).map(
      (input) => input.value,
    );
    // Every row on the card, the hidden ones included -- and only those, so an import that
    // arrives after the page loaded is never dismissed unseen.
    expect(ids).toEqual(rows.map((r) => String(r.importId)));
    expect(container.textContent).toContain('Marks all 7 imports as checked. The transactions are not changed.');
  });

  it('keeps an opened disclosure open when a dismiss re-renders the card', () => {
    const rows = Array.from({ length: RULE_REVIEW_ROW_LIMIT + 3 }, (_, i) => row({ importId: i + 1 }));
    const { container, rerender } = render(<RuleReviewCard imports={rows} />);
    const details = container.querySelector('details')!;
    details.open = true;

    // One of the first five dismissed, then one inside the disclosure.
    rerender(<RuleReviewCard imports={rows.filter((r) => r.importId !== 2)} />);
    expect(container.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    rerender(<RuleReviewCard imports={rows.filter((r) => r.importId !== 2 && r.importId !== 7)} />);
    expect(container.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')?.textContent).toBe('+1 more to check');
  });

  it('has no Dismiss all with a single import', () => {
    render(<RuleReviewCard imports={[row()]} />);
    expect(screen.queryByRole('button', { name: 'Dismiss all' })).toBeNull();
  });
});
