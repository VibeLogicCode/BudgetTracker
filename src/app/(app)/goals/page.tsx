import { requireUser } from '@/lib/auth/session';
import { listContributions, listGoals } from '@/lib/goals';
import { todayIso } from '@/lib/dates';
import { GoalsClient } from './goals-client';

export const dynamic = 'force-dynamic';

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.archived) ? params.archived[0] : params.archived;
  // ?archived=1 is a plain link, not client state: archiving reloads the page via
  // revalidatePath, so a useState toggle would reset itself on every action anyway.
  const showArchived = raw === '1';
  const goals = listGoals({ includeArchived: showArchived }, user);
  // v1.20.0: the owner roster this page used to compute for the "New goal" form's Owner
  // <select> moved to goals/new/page.tsx along with the form itself -- this page no longer
  // renders that control, so isSelfScoped/listAttributablePeople have nothing left to feed
  // here (see goals/new/page.tsx's own docblock for where that computation now lives).
  return (
    <GoalsClient
      today={todayIso()}
      showArchived={showArchived}
      goals={goals.map((goal) => ({ goal, contributions: listContributions(goal.id, user) }))}
    />
  );
}
