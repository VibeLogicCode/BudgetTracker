// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ComingUpCard, COMING_UP_ROW_LIMIT } from '@/components/ComingUpCard';
import type { UpcomingBill } from '@/lib/bills';

afterEach(() => cleanup());

// Item P (rulings P9/P10): a reference date most of this file's existing fixtures have no
// opinion about (they only test overdue-bill rendering and the button, not the 90-day bound),
// so one shared constant covers every ComingUpCard render in this file that does not need a
// specific value of its own.
const TODAY = '2026-08-16';

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
        canRecord={false}
        today={TODAY}
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
        canRecord={false}
        today={TODAY}
      />,
    );
    expect(screen.getByText(/\$77\.00 of that falls before Aug 31/i)).toBeTruthy();
  });
});

describe('ComingUpCard with overdue rows', () => {
  const base = {
    budgetedRemainingCents: 50_000,
    billsDueCents: 12_000,
    hasBudgetedLimits: true,
    monthEndDate: '2026-09-30',
    canRecord: false,
    // Item P's 90-day overdue bound (ruling P9) is dated relative to `today`, and this block's
    // own overdue fixture is dueDate: '2024-05-01' -- `today` here stays on that same date so
    // the bound does not silently drop it out of these pre-existing assertions.
    today: '2024-05-01',
  };

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

  it('keeps the header total summing every row inside the window, including the ones the +N more line stands for (ruling P9)', () => {
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

// Task 11 (ruling R8): the Record-payment button. installmentId is the discriminator, not the
// kind, because a cadence bill (subscription) has no schedule row to mark paid.
describe('ComingUpCard record-payment button', () => {
  const base = {
    budgetedRemainingCents: 50_000,
    billsDueCents: 12_000,
    hasBudgetedLimits: true,
    monthEndDate: '2026-09-30',
    today: TODAY,
    // The three tests right below all supply their own canRecord; the nested "caps its rows"
    // describe does not (it is not testing the record-payment button), so this default covers it.
    canRecord: false,
  };

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

  it('renders the button for a schedule row when canRecord is true', () => {
    render(
      <ComingUpCard
        {...base}
        canRecord
        bills={[bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 })]}
      />,
    );
    expect(screen.getByRole('button', { name: /record payment/i })).toBeTruthy();
  });

  it('omits the button when canRecord is false, even for a schedule row', () => {
    render(
      <ComingUpCard
        {...base}
        canRecord={false}
        bills={[bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 })]}
      />,
    );
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  it('omits the button for a cadence row even when canRecord is true, since there is no schedule row to mark', () => {
    render(
      <ComingUpCard
        {...base}
        canRecord
        bills={[
          bill({ dueDate: '2026-09-15', amountCents: 7_700, installmentId: null, kind: 'subscription' }),
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  describe('ComingUpCard caps its rows and bounds its overdue (item P, rulings P9/P10)', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        bill({ installmentId: i + 1, itemId: i + 1, name: `Bill ${i + 1}`, dueDate: '2026-09-01', amountCents: 10000, overdue: false }),
      );

    it('renders at most COMING_UP_ROW_LIMIT rows and offers the rest', () => {
      const { container } = render(<ComingUpCard {...base} today={TODAY} bills={many(10)} />);
      // A household several bills behind used to get a wall of rows instead of a card.
      expect(container.querySelectorAll('li')).toHaveLength(COMING_UP_ROW_LIMIT + 1);
      expect(screen.getByText('+2 more due')).toBeTruthy();
      expect(screen.getByRole('link', { name: /more due/ }).getAttribute('href')).toBe('/warranties');
    });

    it('renders no overflow row when everything fits', () => {
      render(<ComingUpCard {...base} today={TODAY} bills={many(3)} />);
      expect(screen.queryByText(/more due/)).toBeNull();
    });

    it('the header total sums every row inside the window, capped or not', () => {
      render(<ComingUpCard {...base} today={TODAY} bills={many(10)} />);
      // Ruling P9: NOT the eight rendered rows. A total that stopped at the cap would understate
      // what is owed, which is worse than a long list.
      expect(screen.getByLabelText('Total due $1,000.00')).toBeTruthy();
    });

    it('drops an installment overdue by more than COMING_UP_OVERDUE_DAYS, from the list AND the total', () => {
      const ancient = bill({ installmentId: 99, itemId: 99, name: 'Forgotten', dueDate: '2025-01-01', amountCents: 50000, overdue: true });
      const recent = bill({ installmentId: 1, itemId: 1, name: 'Property tax', dueDate: '2026-07-30', amountCents: 20000, overdue: true });
      render(<ComingUpCard {...base} today={TODAY} bills={[ancient, recent]} />);
      expect(screen.queryByText('Forgotten')).toBeNull();
      expect(screen.getByText('Property tax')).toBeTruthy();
      expect(screen.getByLabelText('Total due $200.00')).toBeTruthy();
    });
  });
});
