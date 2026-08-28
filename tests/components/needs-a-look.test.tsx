// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import type { InsightRow } from '@/lib/insights';

const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  kind: 'unusual',
  transactionId: 7,
  date: '2026-08-20',
  merchant: 'GROCERY STORE',
  amountCents: -92000,
  sentence: '$920.00 at GROCERY STORE — usually about $42.00.',
  ...over,
});

afterEach(cleanup);

describe('NeedsALookCard (ruling R6)', () => {
  it('renders nothing at all when there is nothing to say', () => {
    // No @testing-library/jest-dom in this repo (not an added dependency), so this checks the
    // same thing toBeEmptyDOMElement() would: the render produced no DOM at all.
    const { container } = render(<NeedsALookCard rows={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders one row per insight, with the sentence verbatim', () => {
    render(<NeedsALookCard rows={[row()]} />);
    expect(screen.getByText('$920.00 at GROCERY STORE — usually about $42.00.')).toBeTruthy();
  });

  it('links each row to the transaction it is about', () => {
    render(<NeedsALookCard rows={[row()]} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/transactions?q=GROCERY+STORE');
  });

  it('labels each kind so a reader knows what they are being told', () => {
    render(<NeedsALookCard rows={[row({ kind: 'duplicate' }), row({ kind: 'creep', transactionId: 8 })]} />);
    expect(screen.getByText('Charged twice')).toBeTruthy();
    expect(screen.getByText('Went up')).toBeTruthy();
  });
});
