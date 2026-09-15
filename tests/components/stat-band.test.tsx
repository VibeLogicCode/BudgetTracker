// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { StatTile } from '@/components/ui/StatTile';

afterEach(cleanup);

/**
 * 2026-09-15, `$impeccable critique` P0: "the dashboard has no hierarchy -- thirteen equal cards
 * in one column." `.card` lost its shadow in an earlier pass, correctly (nine drop shadows per
 * page was noise), but nothing replaced it, so the page lost its last mechanism for ranking one
 * thing above another and gained nothing back. "7 transactions need review" and "a warranty
 * expires in 83 days" rendered at identical weight.
 *
 * The first move is the cheapest and the most visible: the month's headline figure stops being
 * one card among four and gets a GROUND. `money-xl` on a surface reads as the page's subject;
 * `money-xl` inside a bordered box identical to "Top merchants" reads as one of a list.
 */
describe('StatTile: the headline figure sits on a ground, not in a box', () => {
  it('draws the card chrome by default, as every other tile does', () => {
    const { container } = render(<StatTile label="Net worth" value="$1,000.00" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain('card');
  });

  it('drops the border and radius when it is the band, so the figure is not boxed', () => {
    const { container } = render(<StatTile variant="bare" label="Spent this month" value="$2,410.00" emphasis />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).not.toMatch(/\bcard\b/);
    expect(tile.className).toContain('bg-surface-2');
  });

  it('keeps the eyebrow and the money treatment either way -- only the container changed', () => {
    render(<StatTile variant="bare" label="Spent this month" value="$2,410.00" emphasis hint="of $3,000 budgeted" />);
    expect(screen.getByText('Spent this month').className).toContain('eyebrow');
    expect(screen.getByText('$2,410.00').className).toContain('money-xl');
    expect(screen.getByText('of $3,000 budgeted')).toBeTruthy();
  });

  /** A tone still has to reach the figure: the headline is the one most likely to be bad news. */
  it('still colours the figure by tone when bare', () => {
    render(<StatTile variant="bare" label="Net" value="-$40.00" tone="negative" />);
    expect(screen.getByText('-$40.00').className).toContain('money-neg');
  });
});
