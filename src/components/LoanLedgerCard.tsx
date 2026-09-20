'use client';

import { memo, useMemo, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { buttonClass } from '@/components/ui/Button';
import { RowDialog } from '@/components/ui/RowDialog';
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
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const words = INTEREST_WORDING[direction];
  // C12: the collapse walks every row, and nothing about it changes while the toggle sits still.
  const all = useMemo(() => (byMonth ? collapseToPeriods(ledger.rows) : ledger.rows), [byMonth, ledger.rows]);

  /*
    THE LEDGER ON DEMAND (reported 2026-09-20). The card used to print the whole table -- capped at
    the most recent hundred rows, with "Show all" under it -- and the report was that the page grew
    until everything else on it was below the fold, for a table nobody wanted open all the time:
    "you only want to look at the ledger on demand, otherwise it's wasted space".

    So the card keeps the last few entries, which is the question it gets asked most often (what has
    happened lately), and the whole thing moves behind one press into the same dialog shell the rest
    of the app edits rows in -- backdrop, blur, focus trap, Escape. Paginated inside, because a
    thousand rows in a dialog is the same problem moved.

    The GROUPING control goes with the table rather than staying on the card: it is a way of reading
    the full history, and on a four-row preview there is nothing to group.
  */
  const preview = ledger.rows.slice(-PREVIEW_ROWS);
  const hidden = ledger.rows.length - preview.length;
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  // Clamped rather than reset: switching to the by-month view can leave the page number past the
  // end, and an out-of-range page renders an empty table with no hint of why.
  const current = Math.min(page, pageCount);
  const pageRows = all.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  /** Opens on the NEWEST page: a ledger is read from the bottom, and that is where the card left off. */
  function openLedger() {
    setPage(Math.max(1, Math.ceil(all.length / PAGE_SIZE)));
    setOpen(true);
  }

  function group(next: boolean) {
    setByMonth(next);
    setPage(Math.max(1, Math.ceil((next ? collapseToPeriods(ledger.rows) : ledger.rows).length / PAGE_SIZE)));
  }

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
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={openLedger}
            className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}
          >
            Show the full ledger
          </button>
          {downloadHref === undefined ? null : (
            <a href={downloadHref} className={buttonClass('ghost', 'sm', 'min-h-11 sm:min-h-0')}>
              Download as a spreadsheet
            </a>
          )}
        </div>

        {hidden === 0 ? null : (
          <p className="text-sm text-muted">
            The last {preview.length} of {ledger.rows.length} entries.
          </p>
        )}

        <LedgerTable rows={preview} direction={direction} />
      </CardBody>

      {open ? (
        <RowDialog
          dialogId="loan-ledger-dialog"
          title="The full ledger"
          description={`Every entry since the statement, oldest first. ${all.length} in total.`}
          maxWidthClassName="max-w-5xl"
          onClose={() => setOpen(false)}
        >
          <div role="group" aria-label="How to group the ledger" className="flex flex-wrap items-center gap-1">
            {/*
              Reported 2026-09-19: "i click on month and view changes by date range but label stays
              same". It was one button reading "By month" with aria-pressed -- which a screen reader
              announces and a sighted reader cannot see, so after pressing it there was nothing on
              the page saying which of the two views was on. Two options, the active one filled.
            */}
            <button
              type="button"
              aria-pressed={!byMonth}
              onClick={() => group(false)}
              className={buttonClass(byMonth ? 'ghost' : 'secondary', 'sm', 'min-h-11 sm:min-h-0')}
            >
              Every entry
            </button>
            <button
              type="button"
              aria-pressed={byMonth}
              onClick={() => group(true)}
              className={buttonClass(byMonth ? 'secondary' : 'ghost', 'sm', 'min-h-11 sm:min-h-0')}
            >
              By month
            </button>
          </div>

          <LedgerTable rows={pageRows} direction={direction} />

          {/*
            The pager, at the bottom where the owner asked for it and where a reader who has just
            walked to the end of a page is looking.

            BOTH buttons are always rendered, the unreachable one disabled -- where the Transactions
            pager omits them. That one is made of real links to a server render, so a missing link
            is a page that is not there; this one opens on the LAST page, so omitting would mean the
            control is absent at the exact moment the dialog opens.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted">
              {pageCount === 1 ? '' : `Page ${current} of ${pageCount} \u2014 `}
              {all.length} {all.length === 1 ? 'entry' : 'entries'}
            </p>
            {pageCount === 1 ? null : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                  className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}
                >
                  Previous page
                </button>
                <button
                  type="button"
                  disabled={current === pageCount}
                  onClick={() => setPage(current + 1)}
                  className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}
                >
                  Next page
                </button>
              </div>
            )}
          </div>
        </RowDialog>
      ) : null}
    </Card>
  );
});

/** What the card itself shows: enough to answer "what happened lately", and no more. */
const PREVIEW_ROWS = 4;

/** How many entries one page of the dialog holds. */
const PAGE_SIZE = 25;

/**
 * F5: TableWrap renders the <table> itself, so thead/tbody are its direct children. The old card
 * nested a second <table> inside it -- invalid, and it also meant `responsive` could not reach the
 * rows, so this table scrolled sideways on a phone while the narrower table below it stacked into
 * cards.
 *
 * One component for both the preview and the dialog, so the two can never drift into showing the
 * same row two different ways.
 */
function LedgerTable({ rows, direction }: { rows: LedgerRow[]; direction: LoanDirection }) {
  return (
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
  );
}

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
