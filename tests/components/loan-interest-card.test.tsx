// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { LoanInterestCard } from '@/components/LoanInterestCard';
import type { LoanAnchor, LoanInterest, LoanReconciliation } from '@/lib/loans';

afterEach(cleanup);

const interest = (over: Partial<LoanInterest> = {}): LoanInterest => ({
  basis: 'apr_monthly',
  anchorDate: '2026-09-01',
  anchorBalanceCents: 20_031_000,
  owingCents: 19_906_000,
  potCents: 0,
  thisMonthChargeCents: 83_462,
  yearAtCurrentBalanceCents: 83_462 * 12,
  interestSinceAnchorCents: 83_462,
  months: [
    {
      month: '2026-09',
      openingCents: 20_031_000,
      chargedCents: 83_462,
      interestPaidCents: 83_462,
      principalPaidCents: 41_538,
      advancedCents: 0,
      closingCents: 19_906_000,
      cumulativeInterestCents: 83_462,
      shortfall: false,
    },
  ],
  ...over,
});

const anchor = (over: Partial<LoanAnchor> = {}): LoanAnchor => ({
  id: 1,
  asOfDate: '2026-09-01',
  balanceCents: 20_031_000,
  source: 'reconcile',
  createdAt: '2026-09-02T00:00:00.000Z',
  createdByUserId: 1,
  note: null,
  interestRateBps: 500,
  interestRateBasis: 'apr_monthly',
  paymentsBetweenCents: -125_000,
  estimatedInterestCents: null,
  appBalanceCents: 20_027_300,
  differenceCents: 3_700,
  statedInterestCents: null,
  prefilledFrom: null,
  prefillBalanceCents: null,
  receiptId: null,
  ...over,
});

const reconciliation = (over: Partial<LoanReconciliation> = {}): LoanReconciliation => ({
  anchors: [anchor()],
  newest: anchor(),
  everReconciled: true,
  stale: false,
  statedInterestTotalCents: null,
  statedInterestCount: 0,
  ...over,
});

/** Ruling I5: no basis, no card. That is every loan on every existing install. */
describe('LoanInterestCard: silence when there is nothing honest to say', () => {
  it('renders nothing at all without an estimate', () => {
    const { container } = render(
      <LoanInterestCard interest={null} reconciliation={reconciliation()} direction="owed" />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('LoanInterestCard: the figures', () => {
  it('leads with what is owed now, and says where that came from', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />,
    );
    // The headline, not the same figure repeated in the month table's closing column.
    expect(container.querySelector('.money-xl')?.textContent).toBe('$199,060.00');
    expect(screen.getByText(/statement 2026-09-01 was \$200,310\.00/)).toBeTruthy();
  });

  /**
   * The label carries the condition. Twelve times this month OVERSTATES a year on any amortising
   * loan, because the balance falls as it is repaid -- so it may never be called "annual interest".
   */
  it('never calls a year at this balance "annual interest"', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />,
    );
    expect(screen.getByText('A year at this balance')).toBeTruthy();
    expect(screen.getByText('if the balance stayed where it is')).toBeTruthy();
    expect(container.textContent).not.toMatch(/annual interest/i);
  });

  it('shows the month-by-month growth', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />,
    );
    expect(screen.getByText('2026-09')).toBeTruthy();
    // This month's charge appears as a figure above AND in the month row; both are correct.
    expect(container.querySelectorAll('td[data-label="Charged"]')[0]?.textContent).toBe('$834.62');
  });

  /** A statement lands inside the list, beside the estimate it corrected (ruling R6). */
  it('shows a statement row inline with what our estimate had been', () => {
    render(<LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />);
    expect(screen.getByText(/statement \$200,310\.00 · \$37\.00 more than our estimate/)).toBeTruthy();
  });

  it('names a month whose payment did not cover the interest', () => {
    const short = interest({ months: [{ ...interest().months[0]!, shortfall: true }] });
    render(<LoanInterestCard interest={short} reconciliation={reconciliation()} direction="owed" />);
    expect(screen.getByText(/Did not cover the month/)).toBeTruthy();
  });
});

/** Ruling I21: the one interest figure that needs no qualification at all. */
describe('LoanInterestCard: what the statements themselves printed', () => {
  it('states it as fact, with how many statements it came from', () => {
    render(
      <LoanInterestCard
        interest={interest()}
        reconciliation={reconciliation({ statedInterestTotalCents: 375_312, statedInterestCount: 3 })}
        direction="owed"
      />,
    );
    expect(screen.getByText(/from your statements/)).toBeTruthy();
    expect(screen.getByText(/3 statements/)).toBeTruthy();
  });

  it('says nothing when no statement carried one', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />,
    );
    expect(container.textContent).not.toMatch(/from your statements/);
  });
});

/** Ruling R9: the claim changes with how recently anybody checked. */
describe('LoanInterestCard: what it claims', () => {
  it('always labels the figures an estimate, dated', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="owed" />,
    );
    expect(container.textContent).toMatch(/Estimated from your rate and the balance of 2026-09-01/);
    expect(container.textContent).toMatch(/Your lender’s statement can differ/);
  });

  it('asks for a statement when none has ever been checked', () => {
    const { container } = render(
      <LoanInterestCard
        interest={interest()}
        reconciliation={reconciliation({ everReconciled: false })}
        direction="owed"
      />,
    );
    expect(container.textContent).toMatch(/Reconcile to a statement to check it/);
  });

  it('says how long it has drifted when it is stale', () => {
    const { container } = render(
      <LoanInterestCard interest={interest()} reconciliation={reconciliation({ stale: true })} direction="owed" />,
    );
    expect(container.textContent).toMatch(/not been checked against a statement since 2026-09-01/);
  });
});

/** Ruling I16: an interest-free loan is a positive claim, not a hidden one. */
describe('LoanInterestCard: interest-free', () => {
  it('says every payment is principal, and shows no rate figures', () => {
    const { container } = render(
      <LoanInterestCard
        interest={interest({ basis: 'none', thisMonthChargeCents: 0, interestSinceAnchorCents: 0 })}
        reconciliation={reconciliation()}
        direction="owed"
      />,
    );
    expect(screen.getByText(/every payment is principal/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/A year at this balance/);
  });

  it('words it for a loan pointing the other way', () => {
    render(
      <LoanInterestCard
        interest={interest({ basis: 'none' })}
        reconciliation={reconciliation()}
        direction="lent"
      />,
    );
    expect(screen.getByText(/every payment reduces what they owe/)).toBeTruthy();
  });
});

describe('LoanInterestCard: direction changes the words, not the figures', () => {
  it('says earned rather than charged for money lent out', () => {
    render(<LoanInterestCard interest={interest()} reconciliation={reconciliation()} direction="lent" />);
    expect(screen.getByText(/Interest earned/)).toBeTruthy();
  });
});
