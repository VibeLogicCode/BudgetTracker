import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { householdInsights } from '@/lib/insights';
import { readInsightsParams } from '@/lib/insights-links';
import { recurringCharges } from '@/lib/recurring';
import { InsightsClient } from './insights-client';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-05 §2.1, §2.4. Two read models, nothing stored. The person scope follows ruling R2's
 * S-01 order -- a self viewer's own scope wins over whatever ?person= asks -- and the Account
 * filter accepts only an account named on the viewer's own listed rows; anything else reads as
 * every account (the read model decides).
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readInsightsParams(await searchParams);
  const today = todayIso();
  const person = ownerScope(viewer) ?? asked.person;
  const recurring = recurringCharges({ today, ownerUserId: person, viewer, accountId: asked.account });
  // The full list: the Dashboard's card is the capped summary of this one.
  const findings = householdInsights({ today, viewer, limit: null });
  const personName = isSelfScoped(viewer) || person === null ? null : (findUserById(person)?.name ?? null);
  return (
    <InsightsClient
      recurring={recurring}
      findings={findings}
      person={person}
      personName={personName}
    />
  );
}
