import Link from 'next/link';
import type { UnreviewedImportRow } from '@/lib/import/commit';
import { Card, CardHeader } from '@/components/ui/Card';
import { DismissAllImportsForm } from '@/components/DismissAllImportsForm';
import { DismissImportForm } from '@/components/DismissImportForm';
import { ListRow } from '@/components/ui/ListRow';
import { buttonClass } from '@/components/ui/Button';
import { DisclosureSummary } from '@/components/ui/Disclosure';

/**
 * v1.26.0 Lane 3b. The standing notice for an import whose rules ran and whose results nobody
 * has looked at yet. Rules are applied automatically on import, and the household still needs a
 * way to see what they did and confirm or correct it afterwards. A rule-assigned row
 * never enters the review queue (REVIEW_WHERE treats `source = 'rule'` as settled), so without
 * this card the only way to find out what a rule did was to remember to go looking.
 *
 * WHY THE DASHBOARD. It considered three places: the Import page (only seen when someone is
 * about to import again -- exactly the households that forget are the ones who import rarely
 * and then close the tab), the existing "what's new" mechanism in Settings (a changelog,
 * checked even less often than Import), and here. The dashboard is the one page every login
 * lands on (every redirect after auth, setup and password-change points at it), so it is the
 * surface most likely to actually be seen -- the same reasoning NeedsALookCard, GettingStartedCard
 * and LoansCard already rely on for their own self-hiding cards.
 *
 * SELF-HIDING, in the manner of every other attention card on this page: rendered unconditionally
 * by the dashboard and absent the moment unreviewedRuleImports() (src/lib/import/commit.ts) has
 * nothing to report. No "all caught up" badge for the same reason GettingStartedCard's own doc
 * comment gives for not having a finished state -- a control that is always on screen stops being
 * read, and a household that dismisses every import promptly should see this page exactly as it
 * would if the feature did not exist.
 *
 * NOT PAIRED WITH THE POST-IMPORT OFFER. import-client.tsx's own offer (rendered right after a
 * commit, on the Import page) and this card can never be on screen at the same moment: the
 * offer lives only in that page's local React state and is gone the instant the household
 * navigates anywhere else, including here. This card is the durable fallback for exactly the
 * case the offer cannot cover -- imported, then closed the tab without reading it.
 *
 * UN-DISMISS. markImportRulesReviewed (src/lib/import/commit.ts) supports `reviewed: false` as
 * a recovery path, but there is no button for it here: every other control on this row already
 * does two things (a look, a dismiss), and a third for undoing a dismiss nobody has asked to
 * undo would be a feature invented to justify itself. The data is never destroyed -- only
 * unreachable from this UI -- so adding the control later costs nothing already built.
 *
 * DISMISS ALL. Offered once two or more imports are listed. It posts the ids this card rendered
 * (DismissAllImportsForm), so an import that arrives after the page loaded is never dismissed
 * without having been on screen.
 */
export const RULE_REVIEW_ROW_LIMIT = 5;

function ImportRow({ row }: { row: UnreviewedImportRow }) {
  return (
    <ListRow
      title={row.accountName}
      meta={`${row.filename} · ${row.ruleRowCount} transaction${row.ruleRowCount === 1 ? '' : 's'} categorized by a rule`}
      trailing={
        <>
          {/* The fixed contract URL (v1.26.0 Lane 3a/3b): a sibling lane builds this exact
              screen against these exact params -- never invent or rename one here. */}
          <Link
            href={`/transactions?import=${row.importId}&source=rule&group=category`}
            className={buttonClass('secondary', 'sm')}
          >
            Check
          </Link>
          <DismissImportForm importId={row.importId} />
        </>
      }
    />
  );
}

export function RuleReviewCard({ imports }: { imports: UnreviewedImportRow[] }) {
  if (imports.length === 0) return null;

  const shown = imports.slice(0, RULE_REVIEW_ROW_LIMIT);
  const hidden = imports.slice(RULE_REVIEW_ROW_LIMIT);

  return (
    <Card>
      <CardHeader
        title="Rules categorized these on import"
        description="Rules sort transactions automatically, but nobody has confirmed what they did on these imports yet. Nothing is blocked while this sits here."
      />
      <ul className="border-t border-line text-sm">
        {shown.map((row) => (
          <ImportRow key={row.importId} row={row} />
        ))}
      </ul>
      {hidden.length > 0 ? (
        // The overflow opens in place: the remaining imports, each with the same Check and Dismiss
        // controls as the rows above. No other page lists only the imports that still need a
        // check, so a link away would land somewhere with nothing to do. A native <details> so the
        // card stays a server component and needs no script; React does not own its `open`
        // attribute, so a Dismiss inside it re-renders the card without closing it. The summary
        // is the shared DisclosureSummary, whose chevron follows the open state.
        <details className="group/disclosure border-t border-line text-sm">
          <DisclosureSummary className="min-h-11 px-4 py-3 sm:min-h-0 sm:px-5">{`+${hidden.length} more to check`}</DisclosureSummary>
          <ul className="border-t border-line">
            {hidden.map((row) => (
              <ImportRow key={row.importId} row={row} />
            ))}
          </ul>
        </details>
      ) : null}
      {imports.length >= 2 ? <DismissAllImportsForm importIds={imports.map((row) => row.importId)} /> : null}
    </Card>
  );
}
