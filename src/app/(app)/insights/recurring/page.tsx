import Link from 'next/link';
import { RecurringFilters } from '@/components/insights/RecurringFilters';
import { RecurringTable } from '@/components/insights/RecurringTable';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { insightsHref, readRecurringParams, recurringHref, type RecurringLinkScope } from '@/lib/insights-links';
import { RECURRING_LATE_GRACE_DAYS } from '@/lib/predict/constants';
import { recurringCharges } from '@/lib/recurring';
import { recurringRows } from '@/lib/recurring-view';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-06 §2.2–§2.4. Every merchant on a rhythm, in every tier, with no row cap. No nav entry
 * of its own: activeNavItem keeps Insights lit, and insights/loading.tsx is its skeleton (this page
 * never sends a 404, tests/ops/loading-boundaries.test.ts). The person scope follows ruling R2's
 * S-01 order; the Account filter accepts only an account named on a listed row (the read model
 * decides); Show and Sort are read from fixed lists, anything else as the default.
 */
export default async function RecurringChargesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readRecurringParams(await searchParams);
  const today = todayIso();
  const selfScoped = isSelfScoped(viewer);
  const person = ownerScope(viewer) ?? asked.person;
  const result = recurringCharges({ today, ownerUserId: person, viewer, accountId: asked.account });
  // The filter the read model actually applied, so the select and every link agree with the rows.
  const scope: RecurringLinkScope = { person, account: result.accountId, show: asked.show, sort: asked.sort };
  const rows = recurringRows(result, scope);
  const total = result.known.length + result.looks.length + result.forming.length;
  const personName = selfScoped || person === null ? null : (findUserById(person)?.name ?? null);
  return (
    <div data-page-width="wide" className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="Recurring charges"
        description="Every merchant that bills on a rhythm: what it usually costs, about how much that is a month, when it last charged and when its rhythm says the next charge is expected."
        actions={
          <Link href={insightsHref({ person: selfScoped ? null : person, account: null })} className={buttonClass('secondary', 'sm')}>
            All insights
          </Link>
        }
      />

      {personName === null ? null : (
        <Notice tone="info">
          Recurring charges here are {personName}&rsquo;s.{' '}
          <Link href={recurringHref({ ...scope, person: null })} className="font-medium text-accent-text underline underline-offset-2">
            Show the whole household
          </Link>
        </Notice>
      )}

      <Card>
        <CardHeader
          title={`${rows.length} of ${total} ${total === 1 ? 'merchant' : 'merchants'}`}
          description="Known recurring is what you said: a merchant you marked, or one an item covers. Looks recurring is what the dates show. Forming is two charges about a month or a year apart, one short of a rhythm."
        />
        <CardBody padded={false}>
          <div className="border-b border-line px-4 pb-4 sm:px-5">
            <RecurringFilters accounts={result.accounts} scope={scope} />
          </div>
          {rows.length > 0 ? (
            <RecurringTable rows={rows} person={person} today={today} />
          ) : (
            <p className="px-4 py-4 text-sm text-muted sm:px-5">
              {total === 0
                ? 'Nothing charges on a rhythm yet. A merchant appears here after two charges about a month or a year apart, or as soon as you mark it recurring from its row menu on Transactions.'
                : 'Nothing here matches these choices. Show All, or pick All accounts.'}
            </p>
          )}
          {rows.some((row) => row.late) ? (
            <p className="border-t border-line px-4 py-3 text-sm text-muted sm:px-5">
              Late: a merchant you marked or track that has not charged for more than {RECURRING_LATE_GRACE_DAYS} days past the date its
              rhythm gives. After a card is replaced, pick it under Account and show Late: these are the merchants
              that charged that card and have gone quiet.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
