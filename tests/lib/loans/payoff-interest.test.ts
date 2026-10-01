import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createManualTransaction } from '@/lib/transactions';
import { assignTransactionToLoan, payoffProjection, setLoanAnchor } from '@/lib/loans';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

function loanWith(over: Record<string, unknown> = {}): { itemId: number; user: number; accountId: number } {
  current = createSeededTestDb();
  const user = insertTestUser(current.db, { role: 'admin' });
  const accountId = insertTestAccount(current.db, { name: 'Chequing' });
  const itemId = createWarrantyItem({
    name: 'Mortgage',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2025-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: user,
    transactionId: null,
    typeId: loanTypeId(),
    notes: null,
    // v1.48.0, D1: a rate needs a basis to be SAVED. setBasis below moves it afterwards, which is
    // how this file reproduces the loans an existing install holds with no basis at all.
    interestRateBps: 500, interestRateBasis: 'apr_monthly',
    ...over,
  } as Parameters<typeof createWarrantyItem>[0]);
  setBasis(itemId, null);
  return { itemId, user, accountId };
}

const setBasis = (itemId: number, basis: string | null): void => {
  current!.sqlite.prepare('update warranty_items set interest_rate_basis = ? where id = ?').run(basis, itemId);
};

function movement(accountId: number, user: number, itemId: number, date: string, amountCents: number): void {
  const txnId = createManualTransaction({
    accountId,
    date,
    description: 'MORTGAGE',
    amountCents,
    categoryId: null,
    attributedUserId: user,
    userId: user,
    actorRole: 'admin',
  });
  assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
}

/** Six months of payments, so the projection has a mean to work from. */
function sixMonthsOfPayments(accountId: number, user: number, itemId: number, amountCents: number): void {
  for (const month of ['01', '02', '03', '04', '05', '06']) {
    movement(accountId, user, itemId, `2026-${month}-15`, amountCents);
  }
}

/**
 * Ruling I18. The projection divided the balance by the mean payment, which on a mortgage is
 * optimistic by YEARS once interest is on the page -- and the dashboard would then contradict the
 * detail page about the same loan. With a basis set it simulates forward instead.
 */
describe('payoffProjection: unchanged when no basis is set', () => {
  it('still divides the balance by the mean payment', () => {
    const { itemId, user, accountId } = loanWith();
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 1_200_000, source: 'form', actorUserId: user });
    sixMonthsOfPayments(accountId, user, itemId, -100_000);
    const projection = payoffProjection(itemId, '2026-07-15')!;
    expect(projection.monthlyAppliedCents).toBe(100_000);
    // $12,000 less six payments of $1,000 = $6,000 left, six months at that pace.
    expect(projection.projectedPayoffMonth).toBe('2027-01');
  });
});

describe('payoffProjection: interest-aware once a basis is set', () => {
  it('takes longer than the interest-blind estimate, because interest is being added', () => {
    const { itemId, user, accountId } = loanWith();
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 1_200_000, source: 'reconcile', actorUserId: user });
    sixMonthsOfPayments(accountId, user, itemId, -100_000);

    const blind = payoffProjection(itemId, '2026-07-15')!;
    setBasis(itemId, 'apr_monthly');
    const aware = payoffProjection(itemId, '2026-07-15')!;
    expect(aware.projectedPayoffMonth > blind.projectedPayoffMonth).toBe(true);
  });

  /** An interest-free loan charges nothing, so its projection is the plain division again. */
  it('matches the plain division for an interest-free loan', () => {
    const { itemId, user, accountId } = loanWith({ interestRateBps: 0 });
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 1_200_000, source: 'reconcile', actorUserId: user });
    sixMonthsOfPayments(accountId, user, itemId, -100_000);
    const blind = payoffProjection(itemId, '2026-07-15')!;
    setBasis(itemId, 'none');
    expect(payoffProjection(itemId, '2026-07-15')!.projectedPayoffMonth).toBe(blind.projectedPayoffMonth);
  });

  /**
   * The case that must not print a date: a payment that does not cover the month's interest. The
   * balance is growing, and "paid off around March 2031" would be a lie.
   */
  it('returns nothing when the payment does not even cover the interest', () => {
    const { itemId, user, accountId } = loanWith();
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    setBasis(itemId, 'apr_monthly');
    // $1,250 a month of interest against a $100 payment.
    sixMonthsOfPayments(accountId, user, itemId, -10_000);
    expect(payoffProjection(itemId, '2026-07-15')).toBeNull();
  });
});

/**
 * Ruling L6. A line of credit being drawn on has no payoff month at all, and printing one from the
 * repayments alone would ignore the draws entirely.
 */
describe('payoffProjection: a balance being drawn on', () => {
  it('returns nothing when an advance was linked in the window', () => {
    const { itemId, user, accountId } = loanWith();
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 1_200_000, source: 'reconcile', actorUserId: user });
    setBasis(itemId, 'apr_daily');
    sixMonthsOfPayments(accountId, user, itemId, -100_000);
    movement(accountId, user, itemId, '2026-04-10', 500_000);
    expect(payoffProjection(itemId, '2026-07-15')).toBeNull();
  });

  it('still projects when every movement in the window was a repayment', () => {
    const { itemId, user, accountId } = loanWith();
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 1_200_000, source: 'reconcile', actorUserId: user });
    setBasis(itemId, 'apr_daily');
    sixMonthsOfPayments(accountId, user, itemId, -100_000);
    expect(payoffProjection(itemId, '2026-07-15')).not.toBeNull();
  });
});

/**
 * Review B1. ratePpb(bps, 'apr_daily') is a DAY's rate, and the projection charged it once per
 * MONTH -- a thirtieth of what the loan costs. A line of credit at 19.99% was told it would be paid
 * off in five years against a payment that does not cover its interest.
 *
 * The projection now asks periodCharge for each month, the same function the ledger asks, so the
 * dashboard's payoff date and the ledger's cycle charge cannot describe different loans.
 */
describe('payoffProjection: a daily rate costs a month, not a day', () => {
  /*
    setLoanAnchor and assignTransactionToLoan post due interest up to their own `at`, which defaults
    to the real clock. Unpinned, the ledger runs past 2026-07-15 to whatever day the suite happens to
    run, the stored balance grows by every month since, and the projection below charges those
    months a second time -- so the payoff month drifted later as the calendar moved. Pinned to the
    day the projection is asked about, the ledger holds what it would hold then.
  */
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-15T12:00:00Z'), toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function lineOfCredit(monthlyPaymentCents: number): number {
    const { itemId, user, accountId } = loanWith({ interestRateBps: 1999 });
    setLoanAnchor({ itemId, asOfDate: '2025-12-31', balanceCents: 2_000_000, source: 'reconcile', actorUserId: user });
    setBasis(itemId, 'apr_daily');
    sixMonthsOfPayments(accountId, user, itemId, -monthlyPaymentCents);
    return itemId;
  }

  /** $20,000 at 19.99% is about $10.95 a day: $335 a month, which $100 does not touch. */
  it('projects nothing when the payment cannot cover a month of daily interest', () => {
    expect(payoffProjection(lineOfCredit(10_000), '2026-07-15')).toBeNull();
  });

  it('still projects when the payment clears the month', () => {
    expect(payoffProjection(lineOfCredit(70_000), '2026-07-15')).not.toBeNull();
  });

  /**
   * Pinned against a hand simulation, because the whole point of B1 is that the app was confidently
   * printing the wrong month.
   *
   * Balance at 2026-07-15 is $17,661.65: the $20,000 anchor, plus the postings through 2026-07-01,
   * less six payments of $700. The daily rate is round(1999 x 100_000 / 365) = 547,671 parts per
   * billion, so a 31-day month at that balance costs $299.86 and a 30-day month $290.18, falling as
   * the balance does. Against $700 a month, the balance reaches zero in the 34th month: May 2029.
   * Charging a single day per month instead -- the defect -- reached zero in 26 months,
   * September 2028, eight months early.
   *
   * (This used to pin $18,266.46 and June 2029. That balance is $17,661.65 plus the July and August
   * postings: the unpinned clock had posted them before the projection charged them again.)
   */
  it('lands where a month of daily charges puts it', () => {
    expect(payoffProjection(lineOfCredit(70_000), '2026-07-15')!.projectedPayoffMonth).toBe('2029-05');
  });
});
