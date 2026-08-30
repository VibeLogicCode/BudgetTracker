import { monthLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
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
 * reasoning LoanProgressBar.tsx's own docblock gives for never reading this as a warning-system
 * bar. That file itself stays (warranty-detail-client.tsx, outside this lane, still uses it);
 * this is only this card's OWN row no longer forking a second bar component for it.
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
        description="Loans the household is paying back."
        action={
          <span className="flex items-center gap-2">
            {hasUntrackedBalance ? (
              <span className="text-xs text-subtle">(excludes loans without a tracked balance)</span>
            ) : null}
            <span className="money-lg" aria-label={`Total owed ${formatCents(totalOwedCents)}`}>
              {formatCents(totalOwedCents)}
            </span>
          </span>
        }
      />
      <ul className="border-t border-line text-sm">
        {shown.map((loan) => (
          <li key={loan.itemId} className="flex flex-col gap-1.5 border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
            <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="font-medium text-ink">{loan.name}</span>
              <span className="money whitespace-nowrap">
                {loan.currentBalanceCents === null ? '—' : formatCents(loan.currentBalanceCents)}
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
              {loan.interestRateBps === null ? null : <span>Rate {(loan.interestRateBps / 100).toFixed(2)}%</span>}
              {loan.payoffProjection == null ? null : (
                <span>Paid off around {monthLabel(loan.payoffProjection.projectedPayoffMonth)} at this pace</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
