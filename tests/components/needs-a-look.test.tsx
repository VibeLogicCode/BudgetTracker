// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import type { InsightRow } from '@/lib/insights';

const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  kind: 'unusual',
  key: 'unusual:7',
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

  /**
   * Reported 2026-09-20: there was no way to clear a finding that had been looked at and judged
   * fine. Per ROW -- the card itself still has no dismiss, for the reason its own docblock gives.
   */
  it('offers a verdict on each row, named for a screen reader', () => {
    render(<NeedsALookCard rows={[row()]} />);
    const button = screen.getByRole('button', { name: /Mark the \$920\.00 charge at GROCERY STORE as fine/ });
    expect(button.textContent).toBe('That’s fine');
  });

  it('sends the finding key, not the merchant, so a later charge is still its own question', () => {
    const { container } = render(<NeedsALookCard rows={[row({ key: 'dupe:7:9' })]} />);
    const field = container.querySelector('input[name="key"]');
    expect(field?.getAttribute('value')).toBe('dupe:7:9');
  });

  it('keeps Look as a link, because looking is not judging', () => {
    render(<NeedsALookCard rows={[row()]} />);
    expect(screen.getByRole('link').textContent).toBe('Look');
  });

  it('labels each kind so a reader knows what they are being told', () => {
    render(<NeedsALookCard rows={[row({ kind: 'duplicate' }), row({ kind: 'creep', key: 'creep:8', transactionId: 8 })]} />);
    expect(screen.getByText('Charged twice')).toBeTruthy();
    expect(screen.getByText('Went up')).toBeTruthy();
  });
});
