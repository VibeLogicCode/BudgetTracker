'use client';

import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { TableWrap } from '@/components/ui/Table';
import { formatCents, formatRateBps } from '@/lib/money';
import { BASIS_LABELS, INTEREST_WORDING } from '@/lib/loans/basis-labels';
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
 * It replaces LoanInterestCard, whose month table answered a narrower question (what has interest
 * done since the last statement) and could not show a payment at all.
 */
export function LoanLedgerCard({
  ledger,
  direction,
  interestFree = false,
  downloadHref,
  onReconcile,
}: {
  ledger: Ledger;
  direction: LoanDirection;
  /** Basis 'none': the rate figures are meaningless and are left off rather than shown as zero. */
  interestFree?: boolean;
  /** U7. Omitted when the caller has no route to offer. */
  downloadHref?: string;
  /** The Reconcile button, when the viewer may open the form. */
  onReconcile?: React.ReactNode;
}) {
  const [byMonth, setByMonth] = useState(false);
  const words = INTEREST_WORDING[direction];
  const rows = byMonth ? collapseToPeriods(ledger.rows) : ledger.rows;

  return (
    <Card>
      <CardHeader
        title={interestFree ? words.free : `Ledger — ${words.charged.toLowerCase()}`}
        description={
          interestFree
            ? 'Every payment comes off the loan.'
            : 'Every figure here is an estimate between statements, worked out from the rate and what you have paid.'
        }
        action={onReconcile}
      />
      <CardBody className="flex flex-col gap-5">
        <dl className="stat-grid">
          <Figure label="Owing today" value={formatCents(ledger.owingCents)} strong />
          <Figure label="Balance" value={formatCents(ledger.postedBalanceCents)} />
          <Figure label="Accrued so far" value={formatCents(ledger.accruedCents)} />
          {interestFree ? null : (
            <>
              <Figure label="This cycle" value={formatCents(ledger.interestThisPeriodCents)} />
              <Figure label="A year at this balance" value={formatCents(ledger.yearAtThisBalanceCents)} />
            </>
          )}
          <Figure label={direction === 'lent' ? 'They have paid' : 'Paid in interest'} value={formatCents(ledger.interestPaidToDateCents)} />
          <Figure label="Paid off the loan" value={formatCents(ledger.principalPaidToDateCents)} />
        </dl>

        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <button type="button" onClick={() => setByMonth(!byMonth)} className="text-sm text-accent hover:underline">
            {byMonth ? 'Show every entry' : 'Show by month'}
          </button>
          {downloadHref === undefined ? null : (
            <a href={downloadHref} className="text-sm text-accent hover:underline">
              Download as a spreadsheet
            </a>
          )}
        </div>

        <TableWrap bare>
          <table className="data-table" aria-label="Ledger">
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
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <Row key={`${row.kind}-${row.date}-${index}`} row={row} direction={direction} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      </CardBody>
    </Card>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className={strong ? 'text-xl font-semibold text-ink' : 'text-lg text-ink'}>{value}</dd>
    </div>
  );
}

function Row({ row, direction }: { row: LedgerRow; direction: LoanDirection }) {
  const accrued = row.kind === 'accrued';
  /*
    U8. Rate, the balance it was charged on, and the day count: the three numbers somebody needs to
    reproduce the charge on paper when a statement disagrees. A title rather than a visible column,
    because five loans' worth of it would bury the ledger.
  */
  const detail =
    row.detail === undefined
      ? undefined
      : `${formatRateBps(row.detail.rateBps)}% · ${BASIS_LABELS[row.detail.basis]} · on an average balance of ` +
        `${formatCents(row.detail.averageDailyBalanceCents)} over ${row.detail.daysCounted} days`;

  return (
    <tr className={accrued ? 'italic text-muted' : undefined}>
      <td>{row.date}</td>
      <td title={detail}>{describe(row, direction)}</td>
      <td className="text-right tabular-nums">{row.paymentCents === null ? '' : formatCents(row.paymentCents)}</td>
      <td className="text-right tabular-nums">{row.interestCents === null ? '' : formatCents(row.interestCents)}</td>
      <td className="text-right tabular-nums">{row.principalCents === null ? '' : formatCents(row.principalCents)}</td>
      <td className="text-right tabular-nums">{formatCents(row.balanceCents)}</td>
    </tr>
  );
}

/** U6. The engine writes one wording; the direction decides which words a person reads. */
function describe(row: LedgerRow, direction: LoanDirection): string {
  if (direction === 'owed') return row.description;
  return row.description
    .replace('Interest posted', INTEREST_WORDING.lent.charged)
    .replace('Payment', 'They paid')
    .replace('Advance', 'Lent out');
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
