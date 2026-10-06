import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { recurringHref } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
import type { UpcomingBill } from '@/lib/bills';
import type { ExpectedCharge } from '@/lib/recurring';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { DaysRemainingPill } from '@/components/ui/DaysRemainingPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListRow } from '@/components/ui/ListRow';
import { RecordPaymentForm } from '@/components/RecordPaymentForm';
import { buttonClass } from '@/components/ui/Button';

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

/** Spec 2026-10-06 §2.6, the line under the list whenever an expected row is shown. */
export const COMING_UP_EXPECTED_NOTE = 'Expected charges are estimates from past charges and are not in the totals above.';

/**
 * Spec 2026-10-06 §2.6. What the list renders, built AFTER the totals. The two kinds are separate
 * props of separate types, so the header total (bills only) and safeToSpend's billsDueCents (which
 * never sees this card's input) cannot include an expected charge by accident: a recurring charge
 * is usually already inside a category budget, and subtracting it again would count it twice.
 */
type ComingUpEntry = { kind: 'bill'; date: string; bill: UpcomingBill } | { kind: 'expected'; date: string; charge: ExpectedCharge };

/**
 * Task 9 (spec 2026-08-22, v1.7.0): SELF-HIDING, in the manner of LoansCard -- the dashboard
 * renders it unconditionally, and it is absent when there is nothing to say (no bills coming
 * up AND no budgeted limits at all this month). Spec 2026-10-06 §2.6: expected rows alone are
 * enough to show it.
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
  expected = [],
  budgetedRemainingCents,
  billsDueCents,
  hasBudgetedLimits,
  monthEndDate,
  canRecord,
  today,
}: {
  /** Already filtered by the caller to a fixed lookahead window (the next 30 days). */
  bills: UpcomingBill[];
  /**
   * Spec 2026-10-06 §2.6. Marked merchants' next charges (expectedRecurringCharges), the same 30-day
   * lookahead. Listed beside the bills, never in a total.
   */
  expected?: ExpectedCharge[];
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
  // Spec 2026-10-06 §2.6: the same overdue bound, applied to a late expected charge.
  const expectedWithinBound = expected.filter((charge) => daysBetweenIso(charge.expectedDate, today) <= COMING_UP_OVERDUE_DAYS);
  if (withinBound.length === 0 && expectedWithinBound.length === 0 && !hasBudgetedLimits) return null;

  // Bills only, by construction: `expected` is a different type with no amountCents (spec 2026-10-06 §2.6).
  const listTotalCents = withinBound.reduce((sum, bill) => sum + bill.amountCents, 0);
  const hasOverdue = withinBound.some((bill) => bill.overdue);
  // One list, by date; on the same date a bill sorts before an expected charge. The cap covers both.
  const entries: ComingUpEntry[] = [
    ...withinBound.map((bill) => ({ kind: 'bill' as const, date: bill.dueDate, bill })),
    ...expectedWithinBound.map((charge) => ({ kind: 'expected' as const, date: charge.expectedDate, charge })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'bill' ? -1 : 1));
  const shown = entries.slice(0, COMING_UP_ROW_LIMIT);
  const hiddenBills = withinBound.length - shown.filter((entry) => entry.kind === 'bill').length;
  const hiddenExpected = expectedWithinBound.length - shown.filter((entry) => entry.kind === 'expected').length;
  const showsExpected = shown.some((entry) => entry.kind === 'expected');
  const EXPECTED_SOURCE_SENTENCE = ' Expected rows are the next charges of merchants you marked recurring.';
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
              `Bills due in the next 30 days, and anything overdue in the last 90 days.${showsExpected ? EXPECTED_SOURCE_SENTENCE : ''}`
            : `Bills due in the next 30 days.${showsExpected ? EXPECTED_SOURCE_SENTENCE : ''}`
        }
        action={
          withinBound.length > 0 ? (
            <span className="money-lg" aria-label={`Total due ${formatCents(listTotalCents)}`}>
              {formatCents(listTotalCents)}
            </span>
          ) : null
        }
      />
      {withinBound.length === 0 && expectedWithinBound.length === 0 ? (
        <CardBody>
          {/* Item 2 (2026-08-30 plan): the shared EmptyState, `size="compact"` -- see that
              component's own docblock for why a card-scoped empty box drops the icon circle and
              bold title the page-level default carries. Review B fix round (item 4):
              withinBound can be empty while `bills` is not -- every unpaid bill fell outside the
              90-day overdue bound. Saying "No bills due" there is worse than the flood of rows
              the bound exists to prevent: it reads as nothing owed, when the opposite is true.
              Guard 1 (tests/ops/onboarding-coverage.test.ts) requires a real action on every
              EmptyState; the two branches below get two different ones, because they are two
              different situations -- `bills.length > 0` means real bills exist just outside this
              card's own window (the same "view the unfiltered list" fix the title's own inline
              link already offers, repeated here as the actual action button), while
              `bills.length === 0` is a true cold start, so the fix is creating the first one
              (the same "Add the first one" convention warranties-client.tsx's own empty state
              uses for /warranties/new). */}
          <EmptyState
            size="compact"
            title={
              bills.length > 0 ? (
                <>
                  Nothing due in the next 30 days. Older overdue bills are on the{' '}
                  <Link href="/warranties" className="font-medium text-accent-text">
                    Loans &amp; Coverage page
                  </Link>
                  .
                </>
              ) : (
                'No bills due in the next 30 days.'
              )
            }
            action={
              bills.length > 0 ? (
                <Link href="/warranties" className={buttonClass('secondary', 'sm')}>
                  View bills
                </Link>
              ) : (
                <Link href="/warranties/new" className={buttonClass('primary', 'sm')}>
                  Add a bill
                </Link>
              )
            }
          />
        </CardBody>
      ) : (
        <>
          <ul className="border-t border-line text-sm">
            {withinBound.length === 0 && bills.length > 0 ? (
              // Checkpoint 2 ruling: the empty state's Review B item 4 hint, kept when expected rows fill the list.
              <li className="border-b border-line px-4 py-3 text-sm text-muted sm:px-5">
                Nothing due in the next 30 days. Older overdue bills are on the{' '}
                <Link href="/warranties" className="font-medium text-accent-text">
                  Loans &amp; Coverage page
                </Link>
                .
              </li>
            ) : null}
            {/* Ruling D1: ListRow (Lane 0) -- its own docblock names this exact <li> as one of the
                hand-rolled rows it generalises. Item 3 adds the days-remaining pill for a
                not-yet-overdue bill; an overdue one keeps its existing red badge instead (more
                urgent, and a negative day count would just be confusing). */}
            {shown.map((entry) => {
              if (entry.kind === 'expected') {
                const { charge } = entry;
                // Spec 2026-10-06 §2.6: tagged Expected, "about" its typical charge, no Record payment
                // (it is not an installment). A past date reads "nothing since" -- a fact, not a verdict.
                return (
                  <ListRow
                    key={`expected-${charge.merchant}`}
                    title={
                      <Link
                        href={transactionsHref({ range: null, person: null }, { kind: 'merchant', merchant: charge.merchant })}
                        className="hover:text-accent-text"
                      >
                        {charge.merchant}
                      </Link>
                    }
                    meta={
                      <>
                        <span className={charge.late ? 'text-danger' : undefined}>{charge.expectedDate}</span>{' '}
                        <span className="badge badge--slate">Expected</span>{' '}
                        {charge.expectedDate >= today ? (
                          <DaysRemainingPill days={daysBetweenIso(today, charge.expectedDate)} />
                        ) : (
                          <span className={charge.late ? 'text-danger' : undefined}>nothing since</span>
                        )}
                        {charge.accountName === '' ? null : <> · {charge.accountName}</>}
                      </>
                    }
                    amount={`about ${formatCents(charge.typicalCents)}`}
                  />
                );
              }
              const { bill } = entry;
              const pill = bill.overdue ? null : <DaysRemainingPill days={daysBetweenIso(today, bill.dueDate)} />;
              return (
                <ListRow
                  // v1.12.0: ONE item can contribute several rows now (a bill's installments), so
                  // itemId alone is no longer a key. installmentId identifies a schedule row; a
                  // cadence row has at most one occurrence per item in this window, so its item id
                  // still does.
                  key={bill.installmentId === null ? `item-${bill.itemId}` : `installment-${bill.installmentId}`}
                  title={bill.name}
                  meta={
                    <>
                      <span className={bill.overdue ? 'text-danger' : undefined}>{bill.dueDate}</span>{' '}
                      {bill.overdue ? <span className="badge badge--red">Overdue</span> : pill}
                    </>
                  }
                  amount={formatCents(bill.amountCents)}
                  trailing={
                    // Ruling R8: only a SCHEDULE row can be recorded. A cadence bill (a
                    // subscription) has no installment row to mark, so the button would have
                    // nothing to write against -- which is why installmentId is the discriminator
                    // here, not the kind.
                    canRecord && bill.installmentId !== null ? (
                      <RecordPaymentForm installmentId={bill.installmentId} />
                    ) : undefined
                  }
                />
              );
            })}
            {hiddenBills > 0 ? (
              <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
                {/* Ruling P10: there is no "+N more" pattern in this app yet and the Card's `action` slot
                    already holds the money total, so the affordance goes in the list. This is the shape
                    the next card copies. */}
                <Link href="/warranties" className="text-sm font-medium text-accent-text">
                  +{hiddenBills} more due
                </Link>
              </li>
            ) : null}
            {hiddenExpected > 0 ? (
              <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
                <Link
                  href={recurringHref({ person: null, account: null, show: 'known', sort: 'next' })}
                  className="text-sm font-medium text-accent-text"
                >
                  +{hiddenExpected} more expected
                </Link>
              </li>
            ) : null}
          </ul>
          {showsExpected ? <p className="border-t border-line px-4 py-3 text-xs text-subtle sm:px-5">{COMING_UP_EXPECTED_NOTE}</p> : null}
        </>
      )}
      <CardFooter>
        {budgetPhrase}, and {billsPhrase}.
      </CardFooter>
    </Card>
  );
}
