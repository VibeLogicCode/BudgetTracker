import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { expiringSoonLabelForKind, expiryPhraseForKind } from '@/lib/warranty/constants';
import type { WarrantyListItem } from '@/lib/warranty/search';
import { ArrowRightIcon } from '@/components/icons';
import { Card, CardHeader } from '@/components/ui/Card';
import { DaysRemainingPill } from '@/components/ui/DaysRemainingPill';
import { ListRow } from '@/components/ui/ListRow';

/** §17.19 / MUST-10.5: top 5, hidden when empty. */
export const EXPIRING_WIDGET_LIMIT = 5;

/** Sentence-initial capitalization only — the phrase itself (verb + wording) is untouched. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

export function ExpiringSoonCard({ items, today }: { items: WarrantyListItem[]; today: string }) {
  // Hidden entirely when the count is zero — the dashboard already has enough on it.
  if (items.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Coming due"
        action={
          <Link
            href="/warranties?status=expiring"
            className="btn btn--ghost btn--sm text-accent-text hover:text-accent-text"
          >
            View all
            <ArrowRightIcon className="h-4 w-4" />
          </Link>
        }
      />
      {/* Ruling D1: ListRow (Lane 0) rather than a hand-rolled <li>. Item 3's days-remaining
          pill is ADDITIONAL to the existing kind-specific phrase (never a replacement for it) --
          "Expires in N days" and the pill both derive from the same days count, and a
          subscription/contract/loan's own end-date phrase stays exactly as worded, just now
          alongside a pill that reads the same window as a plain day count. */}
      <ul className="border-t border-line text-sm">
        {items.slice(0, EXPIRING_WIDGET_LIMIT).map((row) => {
          const days = daysBetweenIso(today, row.expiryDate as string);
          // Every row here already carries status 'expiring' (expiringSoonItems()'s own filter),
          // which per warrantyStatus() in expiry.ts is only ever reached with a non-null
          // expiryDate. MUST-19.10 / MUST-19.13 / type-deltas.md T10, generalized to `kind` in
          // v1.2.2 Task 2: a warranty row stays a day count ("Expires in N days", via
          // expiringSoonLabelForKind — the same helper StatusBadge uses); a
          // subscription/contract/loan row is the end-DATE itself ("Cancel by 2027-03-01" /
          // "Ends on 2027-03-01" / "Paid off by 2027-03-01", via expiryPhraseForKind(),
          // capitalized to match this card's sentence-initial convention) rather than a day count.
          const phrase =
            row.kind === 'warranty'
              ? expiringSoonLabelForKind('warranty', days)
              : capitalize(expiryPhraseForKind(row.kind, row.expiryDate as string));
          return (
            <ListRow
              key={row.id}
              title={
                <Link href={`/warranties/${row.id}`} className="hover:text-accent-text">
                  {row.name}
                </Link>
              }
              meta={
                <>
                  {row.vendor ? <span>{row.vendor}</span> : null}
                  {/* type-deltas.md T10: a type badge, skipped entirely when the item is
                      untyped — no empty pill left behind. */}
                  {row.typeName ? (
                    <span data-testid="type-badge" className="badge badge--slate ml-2">
                      {row.typeName}
                    </span>
                  ) : null}
                </>
              }
              trailing={
                <div className="flex flex-col items-end gap-1">
                  <DaysRemainingPill days={days} />
                  <span className="whitespace-nowrap text-xs font-medium text-warning">{phrase}</span>
                </div>
              }
            />
          );
        })}
      </ul>
    </Card>
  );
}
