import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { householdInsights } from '@/lib/insights';
import { readInsightsParams, recurringHref } from '@/lib/insights-links';
import { recurringCharges } from '@/lib/recurring';
import { recurringSummary } from '@/lib/recurring-view';
import { InsightsClient } from './insights-client';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-05 §2.1 and 2026-10-06 §2.1. Two read models, nothing stored. The person scope follows
 * ruling R2's S-01 order -- a self viewer's own scope wins over whatever ?person= asks. The Recurring
 * charges card is a summary over every account; the Account filter moved to /insights/recurring, and
 * a v1.54.0 link that still carries ?account= is sent there (that release promised a filtered list
 * could be bookmarked or sent).
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readInsightsParams(await searchParams);
  if (asked.account !== null) redirect(recurringHref({ person: asked.person, account: asked.account, show: 'all', sort: 'monthly' }));
  const today = todayIso();
  const person = ownerScope(viewer) ?? asked.person;
  const summary = recurringSummary(recurringCharges({ today, ownerUserId: person, viewer, accountId: null }));
  // The full list: the Dashboard's card is the capped summary of this one.
  const findings = householdInsights({ today, viewer, limit: null });
  const personName = isSelfScoped(viewer) || person === null ? null : (findUserById(person)?.name ?? null);
  return <InsightsClient summary={summary} findings={findings} person={person} personName={personName} />;
}
