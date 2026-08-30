import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Pill } from '@/components/ui/Pill';
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
      {/* Ruling D1: ListRow (Lane 0). The kind label moves from `.badge` to the shared Pill --
          this is the newer, semantic-tone vocabulary (see Pill.tsx's own docblock), and a second
          badge system next to it is the exact thing ruling D1 exists to prevent. `tone="neutral"`
          on purpose: the card's own description says "Nothing here is a problem on its own", so a
          warning-toned pill would contradict the copy sitting right above it. */}
      <ul className="border-t border-line text-sm">
        {rows.map((row) => (
          <ListRow
            key={`${row.kind}-${row.transactionId}`}
            title={
              <>
                <Pill tone="neutral" className="mr-1.5">
                  {KIND_LABEL[row.kind]}
                </Pill>
                {row.sentence}
              </>
            }
            trailing={
              // A search link, not /transactions/<id>: there is no per-transaction page, and the
              // merchant search lands on the charge WITH its neighbours, which is what somebody
              // checking a duplicate actually wants to see. URLSearchParams (not
              // encodeURIComponent) so a space becomes `+`, matching the query-string convention
              // the rest of the app's links already use.
              <Link
                href={`/transactions?${new URLSearchParams({ q: row.merchant }).toString()}`}
                className="text-accent-text"
              >
                Look
              </Link>
            }
          />
        ))}
      </ul>
    </Card>
  );
}
