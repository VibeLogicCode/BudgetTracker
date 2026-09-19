// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent } from '@testing-library/react';
import { LoanLedgerCard } from '@/components/LoanLedgerCard';
import type { Ledger } from '@/lib/loans/ledger';

afterEach(cleanup);

/** No @testing-library/jest-dom in this repo, so text is read off the node directly. */
const textOf = (node: Element | null | undefined): string => node?.textContent ?? '';

/**
 * The ledger card (ledger spec U1–U8): the bank-statement view the owner asked for.
 *
 * The figures below are the worked example, $10,000 at 10% with $5,000 paid on the 15th, so the
 * numbers this file asserts are the same ones the engine's own tests pin.
 */
function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    rows: [
      {
        kind: 'opening',
        date: '2026-07-01',
        description: 'Opening balance',
        paymentCents: null,
        interestCents: null,
        principalCents: null,
        balanceCents: 1_000_000,
      },
      {
        kind: 'payment',
        date: '2026-07-15',
        description: 'Payment',
        paymentCents: 500_000,
        interestCents: 3_763,
        principalCents: null,
        balanceCents: 500_000,
      },
      {
        kind: 'interest',
        date: '2026-08-01',
        description: 'Interest posted. Of 5000.00 paid this period, 60.48 covered interest.',
        paymentCents: null,
        interestCents: 6_048,
        principalCents: null,
        balanceCents: 506_048,
        detail: {
          rateBps: 1000,
          basis: 'apr_monthly',
          averageDailyBalanceCents: 725_806,
          daysCounted: 31,
          cycleDays: 31,
          paidToInterestCents: 6_048,
        },
      },
      {
        kind: 'accrued',
        date: '2026-08-18',
        description: 'Accrued so far (17 of 31 days)',
        paymentCents: null,
        interestCents: 2_312,
        principalCents: null,
        balanceCents: 508_360,
      },
    ],
    duePostings: [],
    dueAdjustment: null,
    postedBalanceCents: 506_048,
    accruedCents: 2_312,
    owingCents: 508_360,
    interestThisPeriodCents: 4_217,
    interestPaidToDateCents: 6_048,
    principalPaidToDateCents: 493_952,
    yearAtThisBalanceCents: 50_605,
    ...over,
  };
}

const table = () => screen.getByRole('table', { name: /ledger/i });
const bodyRows = () => within(table()).getAllByRole('row').slice(1);

describe('the header figures (P6, U4)', () => {
  it('names the three balances the way the rest of the app does', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(textOf(screen.getByText('Owing today').parentElement)).toContain('$5,083.60');
    // "Balance" is also a column header, so the figure is read off the dt in the summary list.
    const balance = screen.getAllByText('Balance').find((node) => node.tagName === 'DT');
    expect(textOf(balance?.parentElement)).toContain('$5,060.48');
    expect(textOf(screen.getByText('Accrued so far').parentElement)).toContain('$23.12');
  });

  it('shows what a year costs, and what has gone on interest so far', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(textOf(screen.getByText('A year at this balance').parentElement)).toContain('$506.05');
    expect(textOf(screen.getByText('Paid in interest').parentElement)).toContain('$60.48');
    expect(textOf(screen.getByText('Paid off the loan').parentElement)).toContain('$4,939.52');
  });

  /** The whole card is an estimate on top of a confirmed figure, and says so once. */
  it('says the figures are an estimate', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.getAllByText(/estimate/i).length).toBeGreaterThan(0);
  });
});

describe('the rows (U2, U3)', () => {
  it('has the six columns a statement has', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(within(table()).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Date',
      'Description',
      'Payment',
      'Interest',
      'Principal',
      'Balance',
    ]);
  });

  it('lists every row oldest first, ending on what has accrued', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const rows = bodyRows();
    expect(rows).toHaveLength(4);
    expect(textOf(rows[0])).toContain('Opening balance');
    expect(textOf(rows[3])).toContain('Accrued so far');
  });

  /** U3: a payment shows what had built up by the day it landed, so the split is visible. */
  it('shows the payment, what had accrued by then, and the balance after', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const payment = textOf(bodyRows()[1]);
    expect(payment).toContain('$5,000.00');
    expect(payment).toContain('$37.63');
  });

  it('states on the posting row how much of the period went on interest', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(textOf(bodyRows()[2])).toContain('covered interest');
  });

  /** U8: enough to check the charge by hand against a statement. */
  it('carries the rate, the balance charged on and the day count on the posting row', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const title = screen.getByTitle(/10\.00%/).getAttribute('title') ?? '';
    expect(title).toContain('$7,258.06');
    expect(title).toContain('31 days');
  });
});

describe('by month (U5)', () => {
  it('collapses to one row per period, and back again', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    fireEvent.click(screen.getByRole('button', { name: /by month/i }));
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain('2026-07-01');
    expect(textOf(rows[0])).toContain('$5,000.00');
    expect(textOf(rows[1])).toContain('Accrued so far');

    fireEvent.click(screen.getByRole('button', { name: /every entry/i }));
    expect(bodyRows()).toHaveLength(4);
  });
});

describe('wording by direction (U6)', () => {
  it('says earned rather than charged for money lent out', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="lent" />);
    expect(screen.getAllByText(/Interest earned/i).length).toBeGreaterThan(0);
    expect(textOf(screen.getByText('They have paid').parentElement)).toContain('$60.48');
  });
});

describe('an interest-free loan', () => {
  it('shows the ledger without an interest column full of zeroes being the point', () => {
    render(
      <LoanLedgerCard
        ledger={ledger({ accruedCents: 0, yearAtThisBalanceCents: 0, interestPaidToDateCents: 0 })}
        direction="owed"
        interestFree
      />,
    );
    expect(screen.getAllByText(/every payment/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('A year at this balance')).toBeNull();
  });
});

describe('the download (U7)', () => {
  it('offers the rows as a file when a link is given', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" downloadHref="/api/loans/7/ledger.csv" />);
    expect(screen.getByRole('link', { name: /download/i }).getAttribute('href')).toBe('/api/loans/7/ledger.csv');
  });

  it('offers nothing when there is no link', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });
});
