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
import type { RecurringCharges } from '@/lib/recurring';

/**
 * Spec 2026-10-05 §2.1. Recurring charges, then the full Needs a look list. Plain data in, nothing
 * fetched here; page.tsx resolved the scope and the filter.
 */
export function InsightsClient({
  recurring,
  findings,
  person,
  personName,
}: {
  recurring: RecurringCharges;
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
          lists the merchants that bill you on a rhythm and the accounts they charge. Pick a card under{' '}
          <strong className="font-semibold text-ink">Account</strong> to see everything that bills it — the list to work
          through when a card is replaced.
        </p>
        <p>
          <strong className="font-semibold text-ink">Known recurring</strong> is what you said: a merchant you marked, or one an
          item on Loans &amp; Coverage covers. <strong className="font-semibold text-ink">Looks recurring</strong> is what the
          dates show, and a rhythm is not a verdict. A new ledger shows little here for its first few months, because a
          rhythm takes three charges.
        </p>
        <p>
          <strong className="font-semibold text-ink">Needs a look</strong> is every charge that stands out, not just the few the
          Dashboard shows.
        </p>
      </PageGuide>

      {personName === null ? null : (
        <Notice tone="info">
          Recurring charges here are {personName}&rsquo;s.{' '}
          <Link href={insightsHref({ person: null, account: recurring.accountId })} className="font-medium text-accent-text underline underline-offset-2">
            Show the whole household
          </Link>
        </Notice>
      )}

      <RecurringChargesCard result={recurring} person={person} />

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
