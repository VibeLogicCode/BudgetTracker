import { formatCents } from '@/lib/money';
import type { LoanSummary } from '@/lib/loans';
import { Card, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';

/**
 * v1.14.0 (spec BU, ruling P11). The mirror of LoansCard, for the loans a household has pointed
 * the OTHER way: money someone owes US, not money we owe.
 *
 * Self-hide: stricter than LoansCard's "has a balance or a principal". A lent loan that has been
 * fully repaid (currentBalanceCents === 0) has nothing left to chase, so it drops out here even
 * though LoansCard would still list an owed loan at zero (a debt paid off is still shown as
 * "paid off" there; a friend who has repaid in full is simply not on this card's radar anymore).
 *
 * Ruling P11: this card is NOT behind the `selfScoped ? null : ...` gate LoansCard carries. Net
 * worth and the household's own debt total are hidden from a self viewer because there is no
 * honest per-person share of a household balance to show instead (ruling R2) -- but every row
 * this card ever receives is a row `listLoans(today, viewer)` has ALREADY scoped to that
 * viewer's own items, so there is no household figure being computed and then discarded. A self
 * viewer sees exactly, and only, what they themselves are owed.
 *
 * Two wordings, chosen by the caller (dashboard/page.tsx), never guessed here:
 *   - household: title "Who owes us", description "Money the household has lent and not been
 *     repaid."
 *   - self:      title "Owed to you", description "Money you have lent and not been repaid."
 * Neither description may say "household" to a self viewer -- that would imply a total wider
 * than their own rows, which ruling P11 forbids.
 *
 * No progress bar, no rate, no payoff month: ruling P9 means a lent loan has no payoff
 * projection at all, and "fraction repaid" reads as a chase-list distraction here -- that detail
 * belongs on the item's own page. Ruling P7: the borrower is never a separate field, only the
 * item's own name (e.g. "Loan to a friend"), so no owner/borrower name is rendered on a row.
 */
export function WhoOwesUsCard({
  loans,
  totalLentCents,
  selfScoped,
}: {
  loans: LoanSummary[];
  totalLentCents: number;
  selfScoped: boolean;
}) {
  // Review fix-round: matches LoansCard's own rule. A lent loan with a NULL (untracked) balance
  // used to be silently dropped by the old `> 0` filter, the same as if it had been fully repaid
  // -- those are not the same thing, and the household should still see "there's a loan here, we
  // just don't have a balance for it" rather than nothing at all. Only a loan actually repaid to
  // zero drops off the list.
  const shown = loans.filter((loan) => loan.currentBalanceCents !== 0);
  if (shown.length === 0) return null;

  const hasUntrackedBalance = shown.some((loan) => loan.currentBalanceCents === null);

  return (
    <Card>
      <CardHeader
        title={selfScoped ? 'Owed to you' : 'Who owes us'}
        description={selfScoped ? 'Money you have lent and not been repaid.' : 'Money the household has lent and not been repaid.'}
        action={
          <span className="flex items-center gap-2">
            {hasUntrackedBalance ? (
              <span className="text-xs text-subtle">(excludes loans without a tracked balance)</span>
            ) : null}
            <span className="money-lg" aria-label={`Total ${formatCents(totalLentCents)}`}>
              {formatCents(totalLentCents)}
            </span>
          </span>
        }
      />
      {/* Ruling D1: ListRow (Lane 0) rather than a hand-rolled <li> -- this row is exactly its
          contract (a title and a right-aligned amount, nothing else), the case ListRow exists
          for. */}
      <ul className="border-t border-line text-sm">
        {shown.map((loan) => (
          <ListRow
            key={loan.itemId}
            title={loan.name}
            amount={loan.currentBalanceCents === null ? '—' : formatCents(loan.currentBalanceCents)}
          />
        ))}
      </ul>
    </Card>
  );
}
