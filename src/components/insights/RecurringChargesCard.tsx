import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { recurringHref } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
import type { RecurringSummary } from '@/lib/recurring-view';

/**
 * Spec 2026-10-06 §2.1. "Recurring charges" on Insights, as a summary: one line per tier and the way
 * to the full list on /insights/recurring, where the rows, the Account filter and the marks live.
 *
 * THE WORDING IS STILL THE FEATURE (spec §2.7). Cadence detection cannot tell a once-a-month shop
 * from a bill, so every string states what was measured or what the household said. The monthly
 * figure is Known recurring only (a Looks row may be a monthly shop), and says "about" because it is
 * a sum of medians.
 */
export function RecurringChargesCard({ summary, person }: { summary: RecurringSummary; person: number | null }) {
  const merchants = `${summary.known} ${summary.known === 1 ? 'merchant' : 'merchants'}`;
  const monthly = summary.knownPriced === 0 ? '' : ` · about ${formatCents(summary.knownMonthlyCents)} a month`;
  return (
    <Card>
      <CardHeader
        title="Recurring charges"
        description="Merchants that bill on a rhythm, read from about three years of the ledger. Known recurring is what you said; Looks recurring is what the dates show; Forming is one charge short of a rhythm."
        action={
          <Link href={recurringHref({ person, account: null, show: 'all', sort: 'monthly' })} className={buttonClass('secondary', 'sm')}>
            See all recurring charges
          </Link>
        }
      />
      <CardBody>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Known recurring</dt>
            <dd className="text-muted">
              {merchants}
              {monthly}
              {summary.late === 0 ? null : (
                <>
                  {' · '}
                  <Link
                    href={recurringHref({ person, account: null, show: 'late', sort: 'next' })}
                    className="font-medium text-accent-text underline underline-offset-2"
                  >
                    {summary.late} late
                  </Link>
                </>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Looks recurring</dt>
            <dd className="text-muted">{summary.looks} to review</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Forming</dt>
            <dd className="text-muted">{summary.forming} one more charge from a rhythm</dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}

/**
 * The Contracts & Coverage header line: what the household has RECORDED as recurring billing.
 *
 * Lives in this module, beside the Recurring charges card, rather than inlined in
 * warranties-client.tsx, because the card's whole argument is about the difference between a recorded figure and a detected one --
 * the two wordings have to be read together to stay honest, and a reader changing one should
 * have the other on screen.
 *
 * The dashboard tile deliberately does NOT reuse this sentence: its VALUE already is the monthly
 * figure, so a hint repeating it would print the same number twice in one tile. It carries the
 * same two nouns ("Recorded billing", "recorded items") and the same never-blend-the-cycles rule
 * in its own hint instead.
 *
 * "Recorded", every time. The figure is the sum of billing amounts somebody typed into items;
 * it is emphatically NOT what the household actually pays, and the Recurring charges card on Insights exists precisely
 * because the two differ. A line reading "Recurring: $412/month" -- the proposal's own wording
 * -- would have been read as the second thing while only ever being the first.
 */
export function recordedBillingSentence(load: { monthlyCents: number; annualCents: number; itemCount: number }): string | null {
  if (load.itemCount === 0) return null;
  const items = `${load.itemCount} recorded ${load.itemCount === 1 ? 'item' : 'items'}`;
  // The two cycles are never folded into one figure: dividing an annual bill by twelve invents
  // a monthly payment nobody makes, and adding it to the monthly total double-counts it.
  if (load.annualCents === 0) return `${formatCents(load.monthlyCents)} a month across ${items}.`;
  if (load.monthlyCents === 0) return `${formatCents(load.annualCents)} a year across ${items}.`;
  return `${formatCents(load.monthlyCents)} a month, plus ${formatCents(load.annualCents)} a year billed annually, across ${items}.`;
}
