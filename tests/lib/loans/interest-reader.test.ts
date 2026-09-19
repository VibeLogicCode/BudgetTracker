import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createManualTransaction } from '@/lib/transactions';
import { assignTransactionToLoan, listLoans, setLoanAnchor } from '@/lib/loans';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

function mortgage(over: Record<string, unknown> = {}): { itemId: number; user: number; accountId: number } {
  current = createSeededTestDb();
  const user = insertTestUser(current.db, { role: 'admin' });
  const accountId = insertTestAccount(current.db, { name: 'Chequing' });
  const itemId = createWarrantyItem({
    name: 'Mortgage',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: user,
    transactionId: null,
    typeId: loanTypeId(),
    notes: null,
    /*
      v1.48.0, D1: a rate cannot be SAVED without a basis any more, so the fixture supplies one and
      the tests below move it with setBasis. The scenarios are unchanged -- an existing install
      still holds loans whose basis is null, and setBasis(itemId, null) is how this file reproduces
      one of those rather than pretending the form can still create it.
    */
    interestRateBps: 500, interestRateBasis: 'apr_monthly',
    ...over,
  } as Parameters<typeof createWarrantyItem>[0]);
  setBasis(itemId, null);
  return { itemId, user, accountId };
}

const setBasis = (itemId: number, basis: string | null): void => {
  current!.sqlite.prepare('update warranty_items set interest_rate_basis = ? where id = ?').run(basis, itemId);
};

const loanOf = (itemId: number, today = '2026-02-28') =>
  listLoans(today, HOUSEHOLD_VIEWER).find((loan) => loan.itemId === itemId)!;

/**
 * Ruling I5, and the promise this release has to keep to every existing install: a loan whose basis
 * nobody has set computes NOTHING. Every rate in the database was typed when the form said the app
 * did no interest maths, so guessing a period now would silently understate a monthly-quoted rate
 * twelve-fold.
 */
describe('listLoans: a loan with no basis is untouched', () => {
  it('reports no interest at all', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'form', actorUserId: user });
    expect(loanOf(itemId).interest).toBeNull();
  });

  it('still reports its balance exactly as before', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'form', actorUserId: user });
    expect(loanOf(itemId).currentBalanceCents).toBe(30_000_000);
  });
});

describe('listLoans: interest once a basis is set', () => {
  it('estimates what is owed now, from the confirmed figure forward', () => {
    const { itemId, user, accountId } = mortgage();
    setBasis(itemId, 'apr_monthly');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    const txnId = createManualTransaction({
      accountId,
      date: '2026-01-15',
      description: 'MORTGAGE',
      amountCents: -180_000,
      categoryId: null,
      attributedUserId: user,
      userId: user,
      actorRole: 'admin',
    });
    assignTransactionToLoan({ txnId, itemId });

    const interest = loanOf(itemId, '2026-01-31').interest!;
    expect(interest.owingCents).toBe(29_945_000);
    expect(interest.interestSinceAnchorCents).toBe(125_000);
  });

  /** The figure a household checks against its statement. */
  it('reports this month, and a year at the balance as it stands', () => {
    const { itemId, user } = mortgage();
    setBasis(itemId, 'apr_monthly');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    const interest = loanOf(itemId, '2026-01-31').interest!;
    expect(interest.thisMonthChargeCents).toBe(125_000);
    expect(interest.yearAtCurrentBalanceCents).toBe(125_000 * 12);
  });

  /** The Canadian convention, about 1% a month below rate/12 -- the reason it is its own basis. */
  it('charges less on the semi-annual basis than on rate over twelve', () => {
    const { itemId, user } = mortgage();
    setBasis(itemId, 'apr_semiannual');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    const charge = loanOf(itemId, '2026-01-31').interest!.thisMonthChargeCents;
    expect(charge).toBeGreaterThan(123_000);
    expect(charge).toBeLessThan(125_000);
  });

  it('reports an interest-free loan as charging nothing, without hiding it', () => {
    const { itemId, user } = mortgage({ interestRateBps: 0 });
    setBasis(itemId, 'none');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    const interest = loanOf(itemId).interest!;
    expect(interest.basis).toBe('none');
    expect(interest.thisMonthChargeCents).toBe(0);
    expect(interest.owingCents).toBe(30_000_000);
  });

  /** Nothing to estimate from: no confirmed figure means no starting point. */
  it('reports nothing for a loan with a basis but no anchor', () => {
    const { itemId } = mortgage();
    setBasis(itemId, 'apr_monthly');
    expect(loanOf(itemId).interest).toBeNull();
  });

  it('gives a month-by-month list, which is the "how it grew" view', () => {
    const { itemId, user } = mortgage();
    setBasis(itemId, 'apr_monthly');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    expect(loanOf(itemId, '2026-03-31').interest!.months.map((month) => month.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
  });
});

/**
 * Rulings R9 and R10: what the screen may claim depends on whether anybody has ever checked the
 * estimate against a statement, and how long ago.
 */
describe('listLoans: the reconciliation state', () => {
  it('knows a loan has never been checked against a statement', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'form', actorUserId: user });
    const state = loanOf(itemId).reconciliation!;
    expect(state.everReconciled).toBe(false);
  });

  it('knows when one has', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-02-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    expect(loanOf(itemId, '2026-02-28').reconciliation!.everReconciled).toBe(true);
  });

  /** Two missed statements. One rule for every loan and every basis. */
  it('calls a loan stale after two months without a statement', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    expect(loanOf(itemId, '2026-02-15').reconciliation!.stale).toBe(false);
    expect(loanOf(itemId, '2026-04-15').reconciliation!.stale).toBe(true);
  });

  /**
   * The figure that needs no caveat at all: what the statements themselves printed. Summed, with
   * the count, because a total over three statements out of six means something different.
   */
  it('totals the interest the statements printed, and counts them', () => {
    const { itemId, user } = mortgage();
    setBasis(itemId, 'apr_monthly');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    setLoanAnchor({
      itemId,
      asOfDate: '2026-02-01',
      balanceCents: 29_950_000,
      source: 'reconcile',
      actorUserId: user,
      statedInterestCents: 125_104,
    });
    const state = loanOf(itemId, '2026-02-28').reconciliation!;
    expect(state.statedInterestTotalCents).toBe(125_104);
    expect(state.statedInterestCount).toBe(1);
  });

  it('reports no stated total when no statement carried one', () => {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    expect(loanOf(itemId).reconciliation!.statedInterestTotalCents).toBeNull();
  });
});
