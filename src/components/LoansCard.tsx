import Link from 'next/link';
import { monthLabel } from '@/lib/dates';
import { formatCents, formatRateBps } from '@/lib/money';
import type { LoanSummary } from '@/lib/loans';
import { Card, CardHeader } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';

/**
 * MUST-15.1: SELF-HIDING, in the manner of ExpiringSoonCard. The dashboard renders it
 * unconditionally; a household with no loans sees no card and no gap.
 *
 * MUST-15.2 / MUST-15.3: one row per loan carrying either field, the total in the header, the
 * payoff bar when a fraction exists, and the next-payment date / display-only interest rate when
 * set.
 *
 * Task 16 (v1.7.0): payoffProjection is computed by listLoans() (loans.ts) and arrives already
 * attached to each row, so this stays a pure presentational component -- no new prop, no DB
 * access of its own. A loan with no projection (null or the field simply absent on an older
 * fixture) renders no extra line.
 *
 * Ruling D1 (2026-08-30 plan): the bar is now the shared ProgressBar (Lane 0), `tone="calm"`
 * fixed rather than derived from `pct` -- more paid off is unambiguously good here, the same
 * reasoning LoanProgressBar.tsx's own docblock gave for never reading this as a warning-system
 * bar. Item 3 of the same plan later migrated warranty-detail-client.tsx's own loan bar to this
 * same ProgressBar and deleted LoanProgressBar.tsx once nothing else called it -- this file's own
 * conversion just got there first.
 *
 * The ROW ITSELF stays a hand-authored `<li>`, not ListRow (Lane 0): a loan's row is three
 * stacked lines -- name+balance, the payoff bar, then a meta sentence -- and ListRow's own
 * contract is title + ONE meta line + amount, with no slot for a bar in between. Forcing the bar
 * into `meta` (rendered inside a `<p>`) would nest a block element inside a paragraph, and
 * dropping the bar to fit would lose information the tile currently shows -- ruling D1's own
 * escape valve ("reports it rather than forking it") is why this row keeps its own markup while
 * still adopting the shared bar.
 */
export function LoansCard({ loans, totalOwedCents }: { loans: LoanSummary[]; totalOwedCents: number }) {
  // Summed from the loans already on screen, so the caption can never disagree with the rows.
  const interestThisMonthCents = loans.reduce((total, loan) => total + (loan.interest?.thisMonthChargeCents ?? 0), 0);
  const shown = loans.filter((loan) => loan.currentBalanceCents !== null || loan.principalCents !== null);
  if (shown.length === 0) return null;

  // Review fix-round: a listed loan with a NULL balance renders a dash placeholder below rather than being
  // silently folded into totalOwedCents at 0 -- the hint says so next to the figure, so the
  // total doesn't read as "everything" when it is actually "everything we're tracking".
  const hasUntrackedBalance = shown.some((loan) => loan.currentBalanceCents === null);

  return (
    <Card>
      <CardHeader
        title="What we owe"
        /*
          v1.48.0, G3. What this month's interest is costing, across the loans that have a rate and
          a way of charging it. A household paying four loans has no other place to see that figure
          in one line, and it is the number that makes the total above worth looking at twice.
        */
        /*
          B10 (review): "this cycle", not "this month". The figure is what the CURRENT billing cycle
          costs -- a loan whose cycle starts on the 12th is not describing a calendar month -- and
          the loan page's own card already says "this cycle". Two words for one quantity is how a
          household ends up believing neither.
        */
        /*
          Reported 2026-09-20: the total ran off the right edge of the card. The caveat used to sit
          INSIDE the action slot, beside the figure -- and that slot is shrink-0, deliberately, so a
          figure is never squeezed. A long sentence in there cannot shrink either, so the pair
          overflowed instead of wrapping. The caveat is a fact about the total, so it belongs in the
          sentence that describes it; the slot holds the number alone.
        */
        description={
          <>
            {interestThisMonthCents > 0
              ? `Loans the household is paying back. About ${formatCents(interestThisMonthCents)} in interest this cycle.`
              : 'Loans the household is paying back.'}
            {hasUntrackedBalance ? ' The total excludes loans without a tracked balance.' : ''}
          </>
        }
        action={
          <span className="money-lg" aria-label={`Total owed today ${formatCents(totalOwedCents)}`}>
            {formatCents(totalOwedCents)}
          </span>
        }
      />
      <ul className="border-t border-line text-sm">
        {shown.map((loan) => (
          <li key={loan.itemId} className="flex flex-col gap-1.5 border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
            <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              {/*
                F4 (review): the row is a way IN. A household reading "Civic $18,266" on the
                dashboard has exactly one next question -- what is this made of -- and the answer
                was four clicks away through a menu entry with no word about loans in it.
              */}
              <Link href={`/warranties/${loan.itemId}`} className="font-medium text-accent-text hover:underline">
                {loan.name}
              </Link>
              {/*
                B6: the SAME quantity the header totals, so the rows can never add up to something
                else. This printed the stored balance while the header summed owing-today.
              */}
              <span className="money whitespace-nowrap">
                {loan.owingTodayCents === null ? '—' : formatCents(loan.owingTodayCents)}
              </span>
            </span>
            {loan.payoffFraction === null ? null : (
              // Math.round, not the raw fraction * 100: `aria-valuenow` prints `pct` verbatim
              // (ProgressBar's own contract), and a fraction like 0.3 does not always survive
              // floating-point multiplication back to an exact whole percent.
              <ProgressBar pct={Math.round(loan.payoffFraction * 100)} tone="calm" label={`${loan.name} paid off`} />
            )}
            <span className="flex flex-wrap gap-x-3 text-xs text-subtle">
              {loan.nextPaymentDate === null ? null : <span>Next payment {loan.nextPaymentDate}</span>}
              {loan.interestRateBps === null ? null : <span>Rate {formatRateBps(loan.interestRateBps)}%</span>}
              {loan.payoffProjection == null ? null : (
                <span>Paid off around {monthLabel(loan.payoffProjection.projectedPayoffMonth)} at this pace</span>
              )}
              {/*
                v1.47.0. One word of qualification -- "est." -- and no disclaimer sentence: the
                explanation belongs where the numbers are explained, one tap away on the loan
                itself (ruling I19). Absent entirely until somebody sets a basis.
              */}
              {loan.interest == null || loan.interest.thisMonthChargeCents === 0 ? null : (
                // B10: "this cycle", matching the header above and the loan's own page.
                <span>~{formatCents(loan.interest.thisMonthChargeCents)} interest this cycle, est.</span>
              )}
              {/*
                Ruling R10: staleness is INFORMATION, not a scolding. One muted phrase, only when
                two statements have been missed, and never a banner or a notification.
              */}
              {loan.reconciliation?.stale !== true || loan.reconciliation.newest === null ? null : (
                <span>Not checked since {monthLabel(loan.reconciliation.newest.asOfDate.slice(0, 7))}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
