// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { WhoOwesUsCard } from '@/components/WhoOwesUsCard';
import type { LoanSummary } from '@/lib/loans';

afterEach(() => cleanup());

/** A local helper, modelled on tests/app/loans-card.test.tsx's literal fixture style -- this
 *  file does not import a fixture from another test file. */
function lent(over: Partial<LoanSummary> = {}): LoanSummary {
  return {
    itemId: 1,
    name: 'Loan to a friend',
    ownerUserId: 1,
    ownerName: 'Alice',
    principalCents: 80_000,
    interestRateBps: null,
    currentBalanceCents: 50_000,
    balanceUpdatedAt: '2026-08-01T00:00:00.000Z',
    billingCycle: null,
    billingAmountCents: null,
    loanDirection: 'lent',
    startDate: '2026-01-15',
    expiryDate: null,
    isLifetime: false,
    payoffFraction: null,
    nextPaymentDate: null,
    lastPaymentAt: null,
    paymentCount: 0,
    ...over,
  };
}

describe('WhoOwesUsCard (spec BU, ruling P11)', () => {
  it('renders nothing when no lent loan has a balance above zero', () => {
    const { container } = render(<WhoOwesUsCard loans={[]} totalLentCents={0} selfScoped={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every lent loan has been repaid', () => {
    // Stricter than LoansCard's "has a balance OR a principal": a fully repaid loan should stop
    // asking to be chased, which is what BU means by "hides at zero".
    const { container } = render(
      <WhoOwesUsCard loans={[lent({ currentBalanceCents: 0 })]} totalLentCents={0} selfScoped={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists each borrower row and the total, household wording', () => {
    // Deliberately different from the single row's balance, same reasoning as
    // tests/app/loans-card.test.tsx's own "the total is not any one shown row" fixture -- a
    // household total need not equal any single loan, so the two must render independently
    // rather than coincide on the same text (which would make this assertion ambiguous).
    render(
      <WhoOwesUsCard
        loans={[lent({ name: 'Loan to a friend', currentBalanceCents: 50_000 })]}
        totalLentCents={80_000}
        selfScoped={false}
      />,
    );
    expect(screen.getByText('Who owes us')).toBeTruthy();
    expect(screen.getByText('Loan to a friend')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
    expect(screen.getByLabelText('Total $800.00')).toBeTruthy();
  });

  it('a self viewer gets their own wording and no household claim', () => {
    render(
      <WhoOwesUsCard
        loans={[lent({ name: 'Loan to a friend', currentBalanceCents: 50_000 })]}
        totalLentCents={50_000}
        selfScoped
      />,
    );
    expect(screen.getByText('Owed to you')).toBeTruthy();
    expect(screen.queryByText('Who owes us')).toBeNull();
    // The copy must not imply a household total to a child (Global Constraints, ruling P11).
    expect(document.body.textContent).not.toMatch(/household/i);
  });
});
