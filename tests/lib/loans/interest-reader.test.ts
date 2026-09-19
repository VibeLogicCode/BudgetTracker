import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createManualTransaction } from '@/lib/transactions';
import { assignTransactionToLoan, listLoans, loanLedger, postDueInterest, setLoanAnchor } from '@/lib/loans';
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
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });

    /*
      v1.48.0. This figure MOVED, and the move is the release.

      v1.47.0 charged a full month on the opening balance: 30,000,000 x 5%/12 = 125,000, giving
      29,945,000. Interest now accrues on what was actually owed each day, so the 180,000 paid on
      the 15th lowers the second half of the month -- and the 31st is not over, so thirty days are
      counted rather than thirty-one. Both pull the same way, and the estimate comes out lower.

      Lower is not the point; being checkable is. This is the figure a household can reproduce from
      the ledger's own posting row, which carries the rate, the average balance and the day count.
    */
    /*
      v1.49.0 re-pins this by hand. The v1.48.0 figure (29,934,841) came out of a row walk that
      clamped differently from the period walk beside it, and was 5,740 low; the review's finding B5
      is that exact disagreement. Worked out on paper:

        fourteen days at 30,000,000 and sixteen at 29,820,000  = 897,120,000
        average daily balance                                   = 29,904,000
        5% a year, one twelfth a month, thirty of thirty-one days = 120,581
        29,820,000 + 120,581                                    = 29,940,581

      Still below the old calendar-month answer of 29,945,000, for the reason v1.48.0 gave: the
      payment on the 15th lowers the second half of the month, and the 31st is not over.
    */
    const interest = loanOf(itemId, '2026-01-31').interest!;
    expect(interest.owingCents).toBe(29_940_581);
    expect(interest.owingCents).toBeLessThan(29_945_000);
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

  /**
   * v1.48.0. The "how it grew" view moved OFF this summary and onto the ledger, which shows it
   * per posting rather than per calendar month -- LoanLedgerCard and tests/lib/loans/postings own
   * it now. What the summary still has to guarantee is that it agrees with that ledger, because a
   * dashboard and a loan page printing different balances is the failure this consolidation
   * exists to prevent.
   */
  it('agrees with the loan ledger, figure for figure', () => {
    const { itemId, user } = mortgage();
    setBasis(itemId, 'apr_monthly');
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'reconcile', actorUserId: user });
    current!.sqlite
      .prepare(
        `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
         values (?, '2026-01-01', 500, 'apr_monthly', '2026-01-01T00:00:00.000Z')`,
      )
      .run(itemId);
    const summary = loanOf(itemId, '2026-03-31').interest!;
    const ledger = loanLedger(itemId, '2026-03-31')!;
    expect(summary.owingCents).toBe(ledger.owingCents);
    expect(summary.yearAtCurrentBalanceCents).toBe(ledger.yearAtThisBalanceCents);
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

/**
 * Review B2. potCents read `owing - posted + accrued`, and owing IS posted + accrued, so the figure
 * was exactly twice this cycle's accrual -- it ignored every period already written down and
 * counted the open one twice. interestSinceAnchorCents added what had been PAID to what had been
 * charged, so making a payment appeared to increase the interest charged.
 *
 * Both now come off the ledger's own totals, which is the only way the loan page and the dashboard
 * can agree about one loan.
 */
describe('listLoans: the interest figures come off the ledger', () => {
  function charged(): { itemId: number; user: number; accountId: number } {
    const made = mortgage();
    setLoanAnchor({
      itemId: made.itemId,
      asOfDate: '2026-01-01',
      balanceCents: 30_000_000,
      source: 'reconcile',
      actorUserId: made.user,
    });
    setBasis(made.itemId, 'apr_monthly');
    return made;
  }

  it('counts interest charged and unpaid once, not twice', () => {
    const { itemId } = charged();
    const ledger = loanLedger(itemId, '2026-04-20')!;
    // Periods have closed since the statement and nothing has been paid against any of them.
    expect(ledger.interestPostedSinceStartCents).toBeGreaterThan(0);
    expect(loanOf(itemId, '2026-04-20').interest!.potCents).toBe(
      ledger.interestPostedSinceStartCents + ledger.accruedCents,
    );
  });

  it('reports everything charged since the statement, paid or not', () => {
    const { itemId, user, accountId } = charged();
    const txnId = createManualTransaction({
      accountId,
      date: '2026-03-10',
      description: 'MORTGAGE PAYMENT',
      amountCents: -200_000,
      categoryId: null,
      attributedUserId: user,
      userId: user,
      actorRole: 'admin',
    });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });

    const ledger = loanLedger(itemId, '2026-04-20')!;
    const interest = loanOf(itemId, '2026-04-20').interest!;
    expect(ledger.interestPaidToDateCents).toBeGreaterThan(0);
    expect(interest.interestSinceAnchorCents).toBe(ledger.interestPostedSinceStartCents + ledger.accruedCents);
    // A payment pays interest first, so the pot is smaller than the total charged -- never larger.
    expect(interest.potCents).toBeLessThan(interest.interestSinceAnchorCents);
    expect(interest.potCents).toBe(
      Math.max(0, ledger.interestPostedSinceStartCents - ledger.interestPaidToDateCents) + ledger.accruedCents,
    );
  });
});

/**
 * Review A7. When a loan has a basis but no rate-history row, the item's own columns are the
 * fallback -- deliberately, because a period with no rate charges nothing and the loan would
 * otherwise stop earning interest silently. But the fallback substituted 0 for a MISSING rate,
 * which writes "this loan is interest-free" into closed periods forever. A missing rate has no
 * ledger at all.
 */
describe('a rate that is missing, not zero', () => {
  function rateless(): { itemId: number; user: number } {
    const { itemId, user } = mortgage();
    setLoanAnchor({ itemId, asOfDate: '2026-01-01', balanceCents: 30_000_000, source: 'form', actorUserId: user });
    setBasis(itemId, 'apr_monthly');
    current!.sqlite.prepare('update warranty_items set interest_rate_bps = null where id = ?').run(itemId);
    current!.sqlite.prepare('delete from loan_rate_history where item_id = ?').run(itemId);
    current!.sqlite.prepare('delete from loan_postings where item_id = ?').run(itemId);
    return { itemId, user };
  }

  it('shows no ledger rather than claiming nothing is owed in interest', () => {
    const { itemId } = rateless();
    expect(loanLedger(itemId, '2026-04-20')).toBeNull();
    expect(loanOf(itemId, '2026-04-20').interest).toBeNull();
  });

  it('posts nothing into the history', () => {
    const { itemId } = rateless();
    expect(postDueInterest(itemId, '2026-04-20').posted).toEqual([]);
    expect(current!.sqlite.prepare('select count(*) as n from loan_postings where item_id = ?').get(itemId)).toEqual({
      n: 0,
    });
  });

  /** A rate of zero that somebody actually typed is a different claim, and it still computes. */
  it('still computes for a rate that really is zero', () => {
    const { itemId } = rateless();
    current!.sqlite.prepare('update warranty_items set interest_rate_bps = 0 where id = ?').run(itemId);
    expect(loanLedger(itemId, '2026-04-20')).not.toBeNull();
  });
});
