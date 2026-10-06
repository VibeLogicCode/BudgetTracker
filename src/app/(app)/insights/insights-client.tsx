'use client';

import Link from 'next/link';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import { RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import { Card, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import type { InsightRow } from '@/lib/insights';
import { insightsHref } from '@/lib/insights-links';
import type { RecurringSummary } from '@/lib/recurring-view';

/**
 * Spec 2026-10-05 §2.1. Recurring charges, then the full Needs a look list. Plain data in, nothing
 * fetched here; page.tsx resolved the scope and the filter.
 */
export function InsightsClient({
  summary,
  findings,
  person,
  personName,
}: {
  summary: RecurringSummary;
  findings: InsightRow[];
  person: number | null;
  /** Set only when a household viewer narrowed the page to one person, so the narrowing is stated. */
  personName: string | null;
}) {
  return (
    <div data-page-width="wide" className="flex flex-col gap-4 sm:gap-5">
      <PageHeader title="Insights" description="What the ledger shows arriving on a rhythm, and the charges that stand out." />

      <PageGuide>
        <p>
          Two lists, both worked out from your own transactions. <strong className="font-semibold text-ink">Recurring charges</strong>{' '}
          counts the merchants that bill you on a rhythm. <strong className="font-semibold text-ink">See all recurring charges</strong>{' '}
          opens every one of them: pick a card under <strong className="font-semibold text-ink">Account</strong> to see everything
          that bills it — the list to work through when a card is replaced — and show <strong className="font-semibold text-ink">Late</strong>{' '}
          for the ones that have not charged since.
        </p>
        <p>
          <strong className="font-semibold text-ink">Known recurring</strong> is what you said: a merchant you marked, or one an
          item on Loans &amp; Coverage covers. <strong className="font-semibold text-ink">Looks recurring</strong> is what the
          dates show, and a rhythm is not a verdict. A new ledger shows little here for its first few months; Forming counts the merchants one charge away.
        </p>
        <p>
          <strong className="font-semibold text-ink">Needs a look</strong> is every charge that stands out, not just the few the
          Dashboard shows.
        </p>
      </PageGuide>

      {personName === null ? null : (
        <Notice tone="info">
          Recurring charges here are {personName}&rsquo;s.{' '}
          <Link href={insightsHref({ person: null, account: null })} className="font-medium text-accent-text underline underline-offset-2">
            Show the whole household
          </Link>
        </Notice>
      )}

      <RecurringChargesCard summary={summary} person={person} />

      {findings.length === 0 ? (
        <Card>
          <CardHeader
            title="Needs a look"
            description="Nothing stands out right now. Unusually large, doubled and raised charges show here once there is about two months of history to compare against."
          />
        </Card>
      ) : (
        <NeedsALookCard rows={findings} />
      )}
    </div>
  );
}
