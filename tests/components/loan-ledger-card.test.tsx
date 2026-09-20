// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent } from '@testing-library/react';
import { LoanLedgerCard } from '@/components/LoanLedgerCard';
import type { Ledger } from '@/lib/loans/ledger';

afterEach(cleanup);

/** No @testing-library/jest-dom in this repo, so text is read off the node directly. */
const textOf = (node: Element | null | undefined): string => node?.textContent ?? '';

/**
 * The ledger card (ledger spec U1–U8), rebuilt in v1.49.0 against review F2/F5/F7.
 *
 * The figures below are the worked example -- $10,000 at 10% with $5,000 paid on the 15th -- so the
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
        interestCents: null,
        principalCents: null,
        balanceCents: 500_000,
        detail: { paidToInterestCents: 3_763, accruedToDayCents: 3_763 },
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
    recutFromPeriodStart: null,
    postedBalanceCents: 506_048,
    accruedCents: 2_312,
    owingCents: 508_360,
    interestThisPeriodCents: 4_217,
    interestPaidToDateCents: 6_048,
    interestPostedSinceStartCents: 6_048,
    principalPaidToDateCents: 493_952,
    yearAtThisBalanceCents: 50_605,
    ...over,
  };
}

/** The card's own table is the PREVIEW. The whole ledger lives in the dialog, reached below. */
const table = () => screen.getAllByRole('table')[0]!;
const bodyRows = () => within(table()).getAllByRole('row').slice(1);
const dialog = () => screen.getByRole('dialog');
const dialogRows = () => within(within(dialog()).getByRole('table')).getAllByRole('row').slice(1);
const openLedger = () => fireEvent.click(screen.getByRole('button', { name: 'Show the full ledger' }));

/**
 * Review F2, and the owner's ruling on it. The card printed seven figures of equal weight, three of
 * them balances, beside a MetricCard on the same page carrying a fourth. There is one number that
 * answers "what do I owe"; the parts belong under it as arithmetic.
 */
describe('F2: one hero, and the parts as a sentence under it', () => {
  it('puts owing-today in display type and nothing else', () => {
    const { container } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const heroes = container.querySelectorAll('.money-xl');
    expect(heroes).toHaveLength(1);
    expect(textOf(heroes[0])).toBe('$5,083.60');
    expect(textOf(screen.getByText('Owing today'))).toBe('Owing today');
  });

  it('shows the arithmetic once, as a sentence', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const sentence = screen.getByText(/balance \+/);
    expect(textOf(sentence)).toBe('$5,060.48 balance + $23.12 building up this cycle');
  });

  it('carries exactly three figures in the footer strip, and two when interest-free', () => {
    const { container, rerender } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(container.querySelectorAll('.stat-grid > *')).toHaveLength(3);
    expect(textOf(screen.getByText('This cycle').parentElement)).toContain('$42.17');
    expect(textOf(screen.getByText('Paid in interest').parentElement)).toContain('$60.48');
    expect(textOf(screen.getByText('Paid off the loan').parentElement)).toContain('$4,939.52');

    rerender(<LoanLedgerCard ledger={ledger()} direction="owed" interestFree />);
    expect(container.querySelectorAll('.stat-grid > *')).toHaveLength(2);
    expect(screen.queryByText('This cycle')).toBeNull();
  });

  /** An interest-free loan has no arithmetic to show either: every payment is principal. */
  it('drops the sentence for an interest-free loan', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" interestFree />);
    expect(screen.queryByText(/building up this cycle/)).toBeNull();
  });
});

describe('F5: the card is built from the house primitives', () => {
  it('renders exactly one table, not one nested in another', () => {
    const { container } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(container.querySelectorAll('table')).toHaveLength(1);
  });

  it('gives every column header a scope and stacks on a phone', () => {
    const { container } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const headers = container.querySelectorAll('thead th');
    expect(headers).toHaveLength(6);
    expect([...headers].every((th) => th.getAttribute('scope') === 'col')).toBe(true);
    expect(textOf(headers[5])).toBe('Running balance');
    expect(container.querySelector('table')?.className).toContain('data-table--stack');
  });

  it('labels every money cell for the stacked layout', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const labels = [...bodyRows()[0]!.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Date', 'Description', 'Payment', 'Interest', 'Principal', 'Running balance']);
  });

  /** F7: the currency sign is printed once, in the hero -- not ninety times down the table. */
  it('prints amounts without a currency sign, and a dash for nothing', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const opening = [...bodyRows()[0]!.querySelectorAll('td')].map((td) => textOf(td));
    expect(opening[2]).toBe('—');
    expect(opening[5]).toBe('10,000.00');
  });

  it('has no title attribute anywhere', () => {
    const { container } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });
});

/**
 * F5 again. The working behind a charge was in a `title` -- a hover tooltip, which a phone cannot
 * reach, a keyboard cannot reach and most screen readers do not announce. It is a disclosure now.
 */
describe('F5: the working opens instead of hovering', () => {
  it('opens a row naming the rate, the basis and the balance it was charged on', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    const toggle = screen.getByRole('button', { name: 'Interest posted' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const working = screen.getByText(/Rate 10.00%/);
    expect(textOf(working)).toContain('Yearly rate, one twelfth charged each month');
    expect(textOf(working)).toContain('on an average balance of $7,258.06 over 31 days');
  });

  it('offers no disclosure on a row with no working to show', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.queryByRole('button', { name: 'Opening balance' })).toBeNull();
  });
});

/**
 * Reported 2026-09-19: "i click on month and view changes by date range but label stays same." It
 * was one button carrying aria-pressed -- which a screen reader announces and a sighted reader
 * cannot see. Two options now, so the control shows which view is on rather than only knowing it.
 */
/** The grouping control belongs with the full table, which since 2026-09-20 is in the dialog. */
describe('the grouping control', () => {
  it('shows which view is on, and folds the payments into the period when grouped', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    openLedger();
    const everyEntry = screen.getByRole('button', { name: 'Every entry' });
    const byMonth = screen.getByRole('button', { name: 'By month' });
    expect(everyEntry.getAttribute('aria-pressed')).toBe('true');
    expect(byMonth.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(byMonth);

    expect(screen.getByRole('button', { name: 'By month' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Every entry' }).getAttribute('aria-pressed')).toBe('false');
    // Opening and the standalone payment are folded away; the period and the accrual remain.
    expect(dialogRows()).toHaveLength(2);
    expect(textOf(dialogRows()[0])).toContain('2026-07-01 to 2026-08-01');
  });

  it('goes back to every entry', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Every entry' }));
    expect(dialogRows()).toHaveLength(4);
  });

  it('is not on the card itself, where there is nothing long enough to group', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.queryByRole('button', { name: 'By month' })).toBeNull();
  });
});

/** U6: every word on the card comes from INTEREST_WORDING, chosen by direction. */
describe('a loan pointed the other way', () => {
  it('reads as money owed TO the household', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="lent" />);
    expect(screen.getByText('Owed to you today')).toBeTruthy();
    expect(screen.getByText('Interest they have paid you')).toBeTruthy();
    expect(screen.getByText('They have paid off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Interest earned' })).toBeTruthy();
    expect(within(table()).getByText('They paid')).toBeTruthy();
  });

  it('titles the card by direction', () => {
    const { rerender } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.getByText('Interest charged')).toBeTruthy();
    rerender(<LoanLedgerCard ledger={ledger()} direction="lent" />);
    expect(screen.getAllByText('Interest earned').length).toBeGreaterThan(0);
  });
});

describe('the toolbar', () => {
  it('offers the download only when a route was given', () => {
    const { rerender } = render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.queryByRole('link', { name: /spreadsheet/i })).toBeNull();
    rerender(<LoanLedgerCard ledger={ledger()} direction="owed" downloadHref="/api/loans/1/ledger.csv" />);
    expect(screen.getByRole('link', { name: /spreadsheet/i }).getAttribute('href')).toBe('/api/loans/1/ledger.csv');
  });

  it('renders the reconcile control the caller passes', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" onReconcile={<button type="button">Reconcile…</button>} />);
    expect(screen.getByRole('button', { name: 'Reconcile…' })).toBeTruthy();
  });
});

/**
 * Review C12. A line of credit three years in has upwards of a thousand rows, and the ledger is
 * read from the bottom: what happened lately, and what is building up now. Rendering every row cost
 * a 60-100 KB flight payload and a re-render on every keystroke in the edit form beside it.
 */
describe('the ledger opens on demand (reported 2026-09-20)', () => {
  function longLedger(count: number): Ledger {
    const rows = Array.from({ length: count }, (_, index) => ({
      kind: 'payment' as const,
      date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      description: 'Payment',
      paymentCents: 1_000 + index,
      interestCents: null,
      principalCents: null,
      balanceCents: 1_000_000 - index,
    }));
    return ledger({ rows });
  }

  it('shows the last four entries on the card, and says what it is showing', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText(/The last 4 of 250 entries/)).toBeTruthy();
    // The newest rows are the ones kept: the last payment is the biggest index.
    expect(textOf(bodyRows().at(-1))).toContain('12.49');
  });

  it('says nothing about a preview when the whole ledger already fits', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    expect(screen.queryByText(/The last 4 of/)).toBeNull();
    expect(bodyRows()).toHaveLength(4);
  });

  /** The owner asked for the shell the rest of the app uses: a dialog over a blurred page. */
  it('opens the whole ledger in a modal dialog', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    const trigger = screen.getByRole('button', { name: 'Show the full ledger' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);

    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('loan-ledger-dialog-backdrop').className).toContain('backdrop-blur-sm');
  });

  it('pages the dialog, opening on the newest page', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    openLedger();
    expect(dialogRows()).toHaveLength(25);
    expect(textOf(within(dialog()).getByText(/^Page /))).toBe('Page 10 of 10 — 250 entries');
    expect(textOf(dialogRows().at(-1))).toContain('12.49');
  });

  it('walks back a page and forward again', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(textOf(within(dialog()).getByText(/^Page /))).toBe('Page 9 of 10 — 250 entries');
    expect(textOf(dialogRows().at(-1))).toContain('12.24');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(textOf(dialogRows().at(-1))).toContain('12.49');
  });

  /**
   * Both buttons are always rendered, the unreachable one disabled -- unlike the Transactions
   * pager, which omits them. That pager is made of real links to a server render, so an absent
   * one is an absent page. This one opens on the LAST page, where omitting would mean the control
   * the owner asked for by name is missing at the very moment the dialog opens.
   */
  it('keeps both pager buttons on the page, disabling the one with nowhere to go', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    openLedger();
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no pager at all when everything fits on one page', () => {
    render(<LoanLedgerCard ledger={ledger()} direction="owed" />);
    openLedger();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    expect(textOf(within(dialog()).getByText(/entries$/))).toBe('4 entries');
  });

  it('closes on Escape', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    openLedger();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the full ledger' }).getAttribute('aria-expanded')).toBe('false');
  });

  /** A page that no longer exists must not be left showing an empty table. */
  it('clamps to a page that exists when the grouping changes under it', () => {
    render(<LoanLedgerCard ledger={longLedger(250)} direction="owed" />);
    openLedger();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    // This fixture is payments only, and a stretch with no posting in it collapses to no period
    // row at all -- so grouped it is one (empty) page, and the pager has nothing left to offer.
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();
    expect(textOf(dialog())).toContain('0 entries');
  });
});
