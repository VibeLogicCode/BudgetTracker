import { formatCents } from '@/lib/money';
import type { UpcomingBill } from '@/lib/bills';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';

/**
 * Task 9 (spec 2026-08-22, v1.7.0): SELF-HIDING, in the manner of LoansCard -- the dashboard
 * renders it unconditionally, and it is absent when there is nothing to say (no bills coming
 * up AND no budgeted limits at all this month).
 *
 * The list total (header) and the footer sentence's "bills still to come" figure are
 * deliberately different numbers when they differ: the list is a fixed 30-day lookahead, a
 * simple "what's coming soon" convenience view, while `billsDueCents` (from safeToSpend) is
 * scoped to the END OF THIS MONTH -- the number that actually answers "is what's left in my
 * budget enough to cover what the rest of this month still owes." They usually land close
 * together, but they are not required to match.
 *
 * Task 1 (spec 2026-08-23, v1.8.0, ruling R8): the two windows are staying different, so the
 * fix is naming them rather than reconciling them. The footer now says "before <month end>"
 * so it reads as its own, narrower window instead of contradicting the header's 30-day total.
 */
export function ComingUpCard({
  bills,
  budgetedRemainingCents,
  billsDueCents,
  hasBudgetedLimits,
  monthEndDate,
}: {
  /** Already filtered by the caller to a fixed lookahead window (the next 30 days). */
  bills: UpcomingBill[];
  budgetedRemainingCents: number;
  /** Bills due on or before the end of the current month (safeToSpend's own window). */
  billsDueCents: number;
  hasBudgetedLimits: boolean;
  /** ISO YYYY-MM-DD, the same month end safeToSpend scoped billsDueCents to. Display only --
   *  this component formats it, it does not derive a month end client-side. */
  monthEndDate: string;
}) {
  if (bills.length === 0 && !hasBudgetedLimits) return null;

  const listTotalCents = bills.reduce((sum, bill) => sum + bill.amountCents, 0);
  const hasOverdue = bills.some((bill) => bill.overdue);
  const budgetPhrase = hasBudgetedLimits
    ? `Budgets have ${formatCents(budgetedRemainingCents)} left this month`
    : 'No category limits set yet';
  const cutoff = new Date(`${monthEndDate}T00:00:00`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
  });
  const billsPhrase =
    billsDueCents === 0
      ? `nothing more due before ${cutoff}`
      : `${formatCents(billsDueCents)} of that falls before ${cutoff}`;

  return (
    <Card>
      <CardHeader
        title="Coming up"
        description={
          hasOverdue ? 'Bills due in the next 30 days, and anything overdue.' : 'Bills due in the next 30 days.'
        }
        action={
          bills.length > 0 ? (
            <span className="money-lg" aria-label={`Total due ${formatCents(listTotalCents)}`}>
              {formatCents(listTotalCents)}
            </span>
          ) : null
        }
      />
      {bills.length === 0 ? (
        <CardBody>
          <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
            No bills due in the next 30 days.
          </p>
        </CardBody>
      ) : (
        <ul className="border-t border-line text-sm">
          {bills.map((bill) => (
            <li
              // v1.12.0: ONE item can contribute several rows now (a bill's installments), so
              // itemId alone is no longer a key. installmentId identifies a schedule row; a
              // cadence row has at most one occurrence per item in this window, so its item id
              // still does.
              key={bill.installmentId === null ? `item-${bill.itemId}` : `installment-${bill.installmentId}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-3 last:border-b-0 sm:px-6"
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink">{bill.name}</span>
                <span className={bill.overdue ? 'text-xs text-danger' : 'text-xs text-subtle'}>{bill.dueDate}</span>
                {bill.overdue ? <span className="badge badge--red">Overdue</span> : null}
              </span>
              <span className="money shrink-0">{formatCents(bill.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      <CardFooter>
        {budgetPhrase}, and {billsPhrase}.
      </CardFooter>
    </Card>
  );
}
