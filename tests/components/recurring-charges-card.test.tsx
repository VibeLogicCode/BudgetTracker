// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import type { RecurringSummary } from '@/lib/recurring-view';

afterEach(cleanup);

/** Spec 2026-10-06 §2.1. The card counts; the rows live on /insights/recurring. */
const SOME: RecurringSummary = { known: 3, knownPriced: 2, knownMonthlyCents: 4708, late: 1, looks: 4, forming: 2 };
const NONE: RecurringSummary = { known: 0, knownPriced: 0, knownMonthlyCents: 0, late: 0, looks: 0, forming: 0 };

function lineFor(term: string): string {
  const dt = screen.getByText(term, { selector: 'dt' });
  return (dt.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('RecurringChargesCard', () => {
  it('states each tier as one line', () => {
    render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(lineFor('Known recurring')).toBe('3 merchants · about $47.08 a month · 1 late');
    expect(lineFor('Looks recurring')).toBe('4 to review');
    expect(lineFor('Forming')).toBe('2 one more charge from a rhythm');
  });

  it('still shows a tier at zero, so the card reads as alive', () => {
    render(<RecurringChargesCard summary={NONE} person={null} />);
    expect(lineFor('Known recurring')).toBe('0 merchants');
    expect(lineFor('Looks recurring')).toBe('0 to review');
    expect(lineFor('Forming')).toBe('0 one more charge from a rhythm');
  });

  /** Review Focus 5. */
  it('leaves the monthly figure out when no Known merchant has a rhythm', () => {
    render(<RecurringChargesCard summary={{ ...NONE, known: 1 }} person={null} />);
    expect(lineFor('Known recurring')).toBe('1 merchant');
  });

  it('links the late count to the page filtered to late rows, carrying the person', () => {
    render(<RecurringChargesCard summary={SOME} person={7} />);
    expect(screen.getByRole('link', { name: '1 late' }).getAttribute('href')).toBe('/insights/recurring?person=7&show=late&sort=next');
  });

  it('opens the full page from See all recurring charges, carrying the person', () => {
    render(<RecurringChargesCard summary={SOME} person={7} />);
    expect(screen.getByRole('link', { name: 'See all recurring charges' }).getAttribute('href')).toBe('/insights/recurring?person=7');
  });

  it('lists no merchant rows and offers no Account filter', () => {
    const { container } = render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('never says subscription, wasted, forgotten, cancel or missed payment', () => {
    const { container } = render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
