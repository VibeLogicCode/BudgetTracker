// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ComingUpCard } from '@/components/ComingUpCard';
import type { UpcomingBill } from '@/lib/bills';

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
        bills={[
          { itemId: 1, name: 'Streaming', kind: 'subscription', dueDate: '2026-09-14', amountCents: 7700, installmentId: null, overdue: false },
        ]}
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
        bills={[
          { itemId: 1, name: 'Streaming', kind: 'subscription', dueDate: '2026-08-28', amountCents: 7700, installmentId: null, overdue: false },
        ]}
        budgetedRemainingCents={120000}
        billsDueCents={7700}
        hasBudgetedLimits
        monthEndDate="2026-08-31"
      />,
    );
    expect(screen.getByText(/\$77\.00 of that falls before Aug 31/i)).toBeTruthy();
  });
});

describe('ComingUpCard with overdue rows', () => {
  const base = { budgetedRemainingCents: 50_000, billsDueCents: 12_000, hasBudgetedLimits: true, monthEndDate: '2026-09-30' };

  function bill(over: Partial<UpcomingBill> & { dueDate: string; amountCents: number }): UpcomingBill {
    return {
      itemId: 1,
      name: 'Municipal tax',
      kind: 'bill',
      installmentId: null,
      overdue: false,
      ...over,
    } as UpcomingBill;
  }

  it('appends the overdue clause to the header only when an overdue row is present', () => {
    const { container: without } = render(
      <ComingUpCard {...base} bills={[bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 })]} />,
    );
    expect(without.textContent).toContain('Bills due in the next 30 days.');
    expect(without.textContent).not.toContain('anything overdue');
    cleanup();

    const { container: with_ } = render(
      <ComingUpCard
        {...base}
        bills={[bill({ dueDate: '2024-05-01', amountCents: 70_000, installmentId: 4, overdue: true })]}
      />,
    );
    expect(with_.textContent).toContain('and anything overdue');
    expect(with_.textContent).toContain('Overdue');
  });

  it('keeps the header total summing EVERY listed row, overdue included', () => {
    const { container } = render(
      <ComingUpCard
        {...base}
        bills={[
          bill({ dueDate: '2024-05-01', amountCents: 70_000, installmentId: 4, overdue: true }),
          bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 }),
        ]}
      />,
    );
    // An overdue bill is money still owed and belongs in the total; the aria-label stays honest.
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe('Total due $1,900.00');
  });

  it('gives every row a distinct key even when one item contributes several', () => {
    // Two installments on ONE item: keying on itemId alone would collide, and React would drop
    // a row. This is the defect the composite key exists to prevent.
    const { container } = render(
      <ComingUpCard
        {...base}
        bills={[
          bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 }),
          bill({ dueDate: '2026-11-15', amountCents: 120_000, installmentId: 6 }),
        ]}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});
