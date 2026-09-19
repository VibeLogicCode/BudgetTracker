'use client';

import { memo, useMemo, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { buttonClass } from '@/components/ui/Button';
import { formatCents, formatRateBps } from '@/lib/money';
import { BASIS_LABELS, INTEREST_WORDING, LEDGER_ROW_WORDS } from '@/lib/loans/basis-labels';
import type { Ledger, LedgerRow } from '@/lib/loans/ledger';
import type { LoanDirection } from '@/lib/warranty/constants';

/**
 * The loan ledger, laid out the way a statement is (ledger spec U1–U8).
 *
 * The owner asked for this in as many words: a table showing the original amount, the monthly
 * interest, the payments and the part-months, "similar to what a bank would show". For a personal
 * loan there is no statement to compare against, so this IS the record -- which is why every row
 * carries where its figure came from, and why the posting rows can be checked by hand.
 *
 * ONE HERO (review F2, owner ruling). v1.48.0's card printed seven figures of equal weight, three
 * of which were balances -- "Owing today", "Balance", and a Balance column whose last cell was a
 * third figure again -- beside a MetricCard on the same page showing a fourth. A household cannot
 * hold four balances for one loan, and it should not have to: there is one number that answers
 * "what do I owe", and the parts belong under it as arithmetic, not beside it as rivals.
 *
 * F5: the card is built from the house primitives now -- .eyebrow labels, .money-xl for the hero,
 * AmountCell for every money cell, TableWrap's own <table> rather than a second one nested inside
 * it, and a disclosure row in place of the `title` attribute nobody on a phone could reach.
 */
/**
 * C12 (review). MEMOISED, and the reason is the page it sits on.
 *
 * warranty-detail-client.tsx is one 1,500-line client component holding the edit form, so every
 * keystroke in a field re-rendered this card: the collapse walked again, and a long line of credit
 * re-rendered several hundred rows. Nothing this card shows can change while somebody types a
 * vendor name, and its props are stable objects from the server render.
 */
export const LoanLedgerCard = memo(function LoanLedgerCard({
  ledger,
  direction,
  interestFree = false,
  downloadHref,
  onReconcile,
  children,
}: {
  ledger: Ledger;
  direction: LoanDirection;
  /** Basis 'none': the rate figures are meaningless and are left off rather than shown as zero. */
  interestFree?: boolean;
  /** U7. Omitted when the caller has no route to offer. */
  downloadHref?: string;
  /** The Reconcile button, when the viewer may open the form. */
  onReconcile?: React.ReactNode;
  /**
   * F1: the panel that button discloses, mounted directly under the header rather than below the
   * whole table. The card does not own the form -- the page does -- but it does own where a
   * disclosure opened from its own header belongs.
   */
  children?: React.ReactNode;
}) {
  const [byMonth, setByMonth] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const words = INTEREST_WORDING[direction];
  // C12: the collapse walks every row, and nothing about it changes while the toggle sits still.
  const all = useMemo(() => (byMonth ? collapseToPeriods(ledger.rows) : ledger.rows), [byMonth, ledger.rows]);
  /*
    C12. THE MOST RECENT HUNDRED, unless asked otherwise.

    A line of credit three years in has upwards of a thousand rows, and the ledger is read from the
    bottom -- what happened lately, and what is building up now. Rendering all of it costs a flight
    payload of 60-100 KB and a re-render nobody sees the value of. "Show all" is one press, and the
    by-month view usually makes it unnecessary.
  */
  const rows = showAll || all.length <= ROW_CAP ? all : all.slice(-ROW_CAP);
  const hidden = all.length - rows.length;

  return (
    <Card>
      <CardHeader
        title={interestFree ? words.free : words.charged}
        description={
          interestFree
            ? 'Every payment comes off the loan.'
            : 'Estimated between statements, from the rate and what has been paid.'
        }
        action={onReconcile}
      />
      <CardBody className="flex flex-col gap-5">
        {children}
        {/*
          THE HERO, and the only figure on this card in display type. The two parts underneath are
          a sentence rather than two more tiles: they are how this number is arrived at, and a tile
          each is what made three balances look like three separate facts (F2).
        */}
        <div className="flex flex-col gap-1">
          <p className="eyebrow">{words.owingToday}</p>
          <p className="money-xl text-ink">{formatCents(ledger.owingCents)}</p>
          {interestFree ? null : (
            <p className="text-sm text-muted">
              {formatCents(ledger.postedBalanceCents)} {words.balance.toLowerCase()} +{' '}
              {formatCents(ledger.accruedCents)} {words.accruing}
            </p>
          )}
        </div>

        {/*
          The footer strip: exactly three figures, or two when the loan is interest-free. Both
          counts are ones .stat-grid tunes (globals.css); the seven the old card rendered were laid
          out 3/3/1, which is the shape that made the hero look like one of seven equal things.
        */}
        <dl className="stat-grid">
          {interestFree ? null : <Figure label="This cycle" value={formatCents(ledger.interestThisPeriodCents)} />}
          <Figure label={words.paid} value={formatCents(ledger.interestPaidToDateCents)} />
          <Figure label={words.paidOff} value={formatCents(ledger.principalPaidToDateCents)} />
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          {/*
            Reported 2026-09-19: "i click on month and view changes by date range but label stays
            same". It was one button reading "By month" with aria-pressed -- which a screen reader
            announces and a sighted reader cannot see, so after pressing it there was nothing on the
            page saying which of the two views was on. Two options, the active one filled: the
            control now shows the state instead of only carrying it.
          */}
          <div role="group" aria-label="How to group the ledger" className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-pressed={!byMonth}
              onClick={() => setByMonth(false)}
              className={buttonClass(byMonth ? 'ghost' : 'secondary', 'sm', 'min-h-11 sm:min-h-0')}
            >
              Every entry
            </button>
            <button
              type="button"
              aria-pressed={byMonth}
              onClick={() => setByMonth(true)}
              className={buttonClass(byMonth ? 'secondary' : 'ghost', 'sm', 'min-h-11 sm:min-h-0')}
            >
              By month
            </button>
          </div>
          {downloadHref === undefined ? null : (
            <a href={downloadHref} className={buttonClass('ghost', 'sm', 'min-h-11 sm:min-h-0')}>
              Download as a spreadsheet
            </a>
          )}
        </div>

        {/*
          F5: TableWrap renders the <table> itself, so thead/tbody are its direct children. The old
          card nested a second <table> inside it -- invalid, and it also meant `responsive` could
          not reach the rows, so this table scrolled sideways on a phone while the narrower table
          below it stacked into cards.
        */}
        {hidden === 0 ? null : (
          <p className="text-sm text-muted">
            Showing the most recent {rows.length} of {all.length} entries.{' '}
            <button type="button" onClick={() => setShowAll(true)} className="text-accent-text hover:underline">
              Show all {all.length}
            </button>
          </p>
        )}

        <TableWrap bare responsive minWidth="52rem">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Description</th>
              <th scope="col" className="text-right">
                Payment
              </th>
              <th scope="col" className="text-right">
                Interest
              </th>
              <th scope="col" className="text-right">
                Principal
              </th>
              <th scope="col" className="text-right">
                Running balance
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <Row key={`${row.kind}-${row.date}-${index}`} row={row} direction={direction} />
            ))}
          </tbody>
        </TableWrap>
      </CardBody>
    </Card>
  );
});

/** How many entries the expanded view renders before it offers the rest behind a press (C12). */
const ROW_CAP = 100;

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow">{label}</dt>
      <dd className="money-lg text-ink">{value}</dd>
    </div>
  );
}

/**
 * One ledger row, plus -- on a row that carries the working -- a disclosure holding it.
 *
 * U8 wants the rate, the balance it was charged on and the day count available: the three numbers
 * somebody needs to reproduce a charge on paper when a statement disagrees. v1.48.0 put them in a
 * `title` attribute, which is a hover tooltip: unreachable by touch, unreachable by keyboard, and
 * invisible to a screen reader in most combinations. A button that opens a row says the same thing
 * to everybody.
 */
function Row({ row, direction }: { row: LedgerRow; direction: LoanDirection }) {
  const [open, setOpen] = useState(false);
  const accrued = row.kind === 'accrued';
  const working = workingOf(row);
  // The currency sign is printed once, in the hero. Ninety cells of "$" is noise (F7).
  const money = (cents: number | null) => (cents === null ? '—' : formatCents(cents, { currency: false }));

  return (
    <>
      <tr className={accrued ? 'italic text-muted' : undefined}>
        <td data-label="Date">{row.date}</td>
        <td data-label="Description">
          {working === null ? (
            describe(row, direction)
          ) : (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="text-left text-accent-text hover:underline"
            >
              {describe(row, direction)}
            </button>
          )}
        </td>
        <AmountCell data-label="Payment">{money(row.paymentCents)}</AmountCell>
        <AmountCell data-label="Interest">{money(row.interestCents)}</AmountCell>
        <AmountCell data-label="Principal">{money(row.principalCents)}</AmountCell>
        <AmountCell data-label="Running balance">{money(row.balanceCents)}</AmountCell>
      </tr>
      {working === null || !open ? null : (
        <tr className="text-sm text-muted">
          <td colSpan={6}>{working}</td>
        </tr>
      )}
    </>
  );
}

/** The sentence behind a charge, or null when this row has no working to show. */
function workingOf(row: LedgerRow): string | null {
  const detail = row.detail;
  if (detail?.rateBps === undefined || detail.basis === undefined) return null;
  const parts = [`Rate ${formatRateBps(detail.rateBps)}%`, BASIS_LABELS[detail.basis]];
  if (detail.averageDailyBalanceCents !== undefined && detail.daysCounted !== undefined) {
    parts.push(`on an average balance of ${formatCents(detail.averageDailyBalanceCents)} over ${detail.daysCounted} days`);
  }
  return parts.join(' · ');
}

/** U6/F7: a lookup on the row's kind, never a rewrite of the sentence the engine wrote. */
function describe(row: LedgerRow, direction: LoanDirection): string {
  return LEDGER_ROW_WORDS[direction][row.kind] ?? row.description;
}

/**
 * U5. One row per posting period: opening to posting day, with the payments folded in.
 *
 * Built from the rows rather than from the periods, so the collapsed view can never disagree with
 * the expanded one -- they are the same numbers, added up differently.
 */
function collapseToPeriods(rows: LedgerRow[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  let payments = 0;
  let principal = 0;
  let start: string | null = null;

  for (const row of rows) {
    if (row.kind === 'opening') {
      start = row.date;
      continue;
    }
    if (row.kind === 'payment') {
      payments += row.paymentCents ?? 0;
      continue;
    }
    if (row.kind === 'advance') {
      principal += row.principalCents ?? 0;
      continue;
    }
    if (row.kind === 'interest' || row.kind === 'adjustment') {
      out.push({
        ...row,
        date: start === null ? row.date : `${start} to ${row.date}`,
        paymentCents: payments === 0 ? null : payments,
        principalCents: principal === 0 ? null : principal,
      });
      payments = 0;
      principal = 0;
      start = row.date;
      continue;
    }
    // The accrued line stays as it is: it is not a period, it is what is running now.
    out.push(
      payments === 0 && principal === 0
        ? row
        : { ...row, paymentCents: payments, principalCents: principal === 0 ? null : principal },
    );
  }
  return out;
}
