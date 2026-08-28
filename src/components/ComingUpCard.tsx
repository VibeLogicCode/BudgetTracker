import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { UpcomingBill } from '@/lib/bills';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { RecordPaymentForm } from '@/components/RecordPaymentForm';

/**
 * Item P (ruling P9). The notification evaluator has had a flood guard since v1.4
 * (MAX_NEW_ROWS_PER_USER_PER_EVALUATION, notify/evaluate/coming-due.ts:18); this card had
 * nothing, so a household several bills behind got a wall of rows instead of a card.
 */
export const COMING_UP_ROW_LIMIT = 8;

/**
 * And nothing bounded the other end: with includeOverdue, an installment from years ago was
 * exactly as eligible as one from last week. Most-overdue-first with a cutoff, not literally
 * everything ever missed.
 */
export const COMING_UP_OVERDUE_DAYS = 90;

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
  canRecord,
  today,
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
  /**
   * v1.13.0 ruling R8: false for a self viewer with no account they can post to, true otherwise
   * (Task 13 computes it -- this card does not re-derive account eligibility itself).
   */
  canRecord: boolean;
  /** Item P: the reference date for COMING_UP_OVERDUE_DAYS. The dashboard already has it. */
  today: string;
}) {
  const withinBound = bills.filter(
    (b) => !b.overdue || daysBetweenIso(b.dueDate, today) <= COMING_UP_OVERDUE_DAYS,
  );
  if (withinBound.length === 0 && !hasBudgetedLimits) return null;

  const listTotalCents = withinBound.reduce((sum, bill) => sum + bill.amountCents, 0);
  const hasOverdue = withinBound.some((bill) => bill.overdue);
  const shown = withinBound.slice(0, COMING_UP_ROW_LIMIT);
  const hiddenCount = withinBound.length - shown.length;
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
          hasOverdue
            ? // Review B fix round (item 4): the bare "and anything overdue" overpromised -- a
              // bill overdue by more than COMING_UP_OVERDUE_DAYS is dropped from this card
              // entirely (see withinBound above), so the clause now names the actual bound
              // rather than reading as "every overdue bill, no matter how old".
              'Bills due in the next 30 days, and anything overdue in the last 90 days.'
            : 'Bills due in the next 30 days.'
        }
        action={
          withinBound.length > 0 ? (
            <span className="money-lg" aria-label={`Total due ${formatCents(listTotalCents)}`}>
              {formatCents(listTotalCents)}
            </span>
          ) : null
        }
      />
      {withinBound.length === 0 ? (
        <CardBody>
          <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
            {/* Review B fix round (item 4): withinBound can be empty while `bills` is not --
                every unpaid bill fell outside the 90-day overdue bound. Saying "No bills due"
                there is worse than the flood of rows the bound exists to prevent: it reads as
                nothing owed, when the opposite is true. */}
            {bills.length > 0 ? (
              <>
                Nothing due in the next 30 days. Older overdue bills are on the{' '}
                <Link href="/warranties" className="font-medium text-accent-text">
                  Warranties &amp; bills page
                </Link>
                .
              </>
            ) : (
              'No bills due in the next 30 days.'
            )}
          </p>
        </CardBody>
      ) : (
        <ul className="border-t border-line text-sm">
          {shown.map((bill) => (
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
              <span className="flex shrink-0 items-center gap-3">
                <span className="money">{formatCents(bill.amountCents)}</span>
                {/* Ruling R8: only a SCHEDULE row can be recorded. A cadence bill (a subscription)
                    has no installment row to mark, so the button would have nothing to write
                    against -- which is why installmentId is the discriminator here, not the kind. */}
                {canRecord && bill.installmentId !== null ? (
                  <RecordPaymentForm installmentId={bill.installmentId} />
                ) : null}
              </span>
            </li>
          ))}
          {hiddenCount > 0 ? (
            <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
              {/* Ruling P10: there is no "+N more" pattern in this app yet and the Card's `action` slot
                  already holds the money total, so the affordance goes in the list. This is the shape
                  the next card copies. */}
              <Link href="/warranties" className="text-sm font-medium text-accent-text">
                +{hiddenCount} more due
              </Link>
            </li>
          ) : null}
        </ul>
      )}
      <CardFooter>
        {budgetPhrase}, and {billsPhrase}.
      </CardFooter>
    </Card>
  );
}
