import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/Card';
import type { InsightKind, InsightRow } from '@/lib/insights';

/**
 * v1.13.0 ruling R6 (item AJ / PROD-2). Self-hiding, in the manner of LoansCard and ComingUpCard:
 * rendered unconditionally by the dashboard, absent when there is nothing to say. That is the whole
 * of the dismiss story -- a card with a dismiss button is a card somebody dismisses once and never
 * sees again.
 *
 * MUST-19.11: the SENTENCE is built in src/lib/insights.ts and rendered verbatim here. This component
 * owns only the three labels below, because they are a property of the card's layout and not of the
 * finding.
 */
const KIND_LABEL: Record<InsightKind, string> = {
  unusual: 'Unusually large',
  duplicate: 'Charged twice',
  creep: 'Went up',
};

export function NeedsALookCard({ rows }: { rows: InsightRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Needs a look"
        description="Charges that stand out this month. Nothing here is a problem on its own."
      />
      <ul className="border-t border-line text-sm">
        {rows.map((row) => (
          <li
            key={`${row.kind}-${row.transactionId}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
          >
            <span className="min-w-0">
              <span className="badge">{KIND_LABEL[row.kind]}</span>{' '}
              <span className="text-ink">{row.sentence}</span>
            </span>
            {/* A search link, not /transactions/<id>: there is no per-transaction page, and the
                merchant search lands on the charge WITH its neighbours, which is what somebody
                checking a duplicate actually wants to see. URLSearchParams (not
                encodeURIComponent) so a space becomes `+`, matching the query-string convention
                the rest of the app's links already use. */}
            <Link
              href={`/transactions?${new URLSearchParams({ q: row.merchant }).toString()}`}
              className="text-accent-text shrink-0"
            >
              Look
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
