// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ComingUpCard } from '@/components/ComingUpCard';

afterEach(() => cleanup());

// Task 1 (spec 2026-08-23, v1.8.0, ruling R8). The header total is a fixed 30-day lookahead
// and the footer's billsDueCents is scoped to month end (src/lib/bills.ts) -- two genuinely
// different windows that used to read as a contradiction because the footer never said which
// one it meant. These tests pin the copy that names the month-end cutoff rather than pinning
// the two figures matching, which they are not required to do.
describe('ComingUpCard', () => {
  it('names the month-end window so the footer cannot read as contradicting the header', () => {
    const { container } = render(
      <ComingUpCard
        bills={[{ itemId: 1, name: 'Streaming', kind: 'subscription', dueDate: '2026-09-14', amountCents: 7700 }]}
        budgetedRemainingCents={120000}
        billsDueCents={0}
        hasBudgetedLimits
        monthEndDate="2026-08-31"
      />,
    );
    // The one $77 bill renders "$77.00" twice (header total + its own list row), so the
    // header figure is checked via its aria-label rather than getByText, which would
    // otherwise match both and throw "multiple elements found".
    expect(container.querySelector('[aria-label="Total due $77.00"]')).toBeTruthy();
    expect(screen.getByText(/nothing more due before Aug 31/i)).toBeTruthy();
  });

  it('states the amount and the cutoff when bills do fall before month end', () => {
    render(
      <ComingUpCard
        bills={[{ itemId: 1, name: 'Streaming', kind: 'subscription', dueDate: '2026-08-28', amountCents: 7700 }]}
        budgetedRemainingCents={120000}
        billsDueCents={7700}
        hasBudgetedLimits
        monthEndDate="2026-08-31"
      />,
    );
    expect(screen.getByText(/\$77\.00 of that falls before Aug 31/i)).toBeTruthy();
  });
});
