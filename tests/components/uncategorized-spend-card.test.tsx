// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UncategorizedSpendCard } from '@/components/UncategorizedSpendCard';

afterEach(() => cleanup());

/** Spec 2026-10-21 §2.2. Budgets' first card: needs attention, never colour alone, gone at zero. */
describe('UncategorizedSpendCard', () => {
  const HREF = '/transactions?range=custom&from=2026-03-01&to=2026-03-31&review=1&queue=uncategorized&category=uncategorized&transfers=0';

  it('shows the amount, the count and Categorize, with the attention icon and the Needs attention label', () => {
    const { container } = render(<UncategorizedSpendCard spend={{ totalCents: 5750, count: 2 }} href={HREF} />);
    expect(screen.getByText('Not categorized yet')).toBeTruthy();
    expect(screen.getByTestId('needs-attention-icon')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('$57.50')).toBeTruthy();
    expect(screen.getByText('2 transactions')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Categorize' }).getAttribute('href')).toBe(HREF);
    expect(container.querySelector('article')!.className).toContain('border-warning');
  });

  it('says 1 transaction for one', () => {
    render(<UncategorizedSpendCard spend={{ totalCents: 1200, count: 1 }} href={HREF} />);
    expect(screen.getByText('1 transaction')).toBeTruthy();
  });

  it('renders nothing when nothing is uncategorized', () => {
    expect(render(<UncategorizedSpendCard spend={{ totalCents: 0, count: 0 }} href={HREF} />).container.firstChild).toBeNull();
    expect(render(<UncategorizedSpendCard spend={null} href={HREF} />).container.firstChild).toBeNull();
  });
});
