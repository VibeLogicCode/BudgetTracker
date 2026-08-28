import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { listAttributablePeople } from '@/lib/auth/users';
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
  return (
    <GoalsClient
      today={todayIso()}
      showArchived={showArchived}
      goals={goals.map((goal) => ({ goal, contributions: listContributions(goal.id, user) }))}
      // Ruling R5: every attribution picker reads listAttributablePeople(), which also
      // surfaces people who cannot sign in -- unlike the old listUsers().filter(isActive).
      // v1.13.1 review A (item 2): a self viewer must never receive the household roster --
      // canActOnOwner already refuses any owner other than themselves or "shared" server-side
      // (./actions.ts), so the "Owner" dropdown narrows to just their own name instead of
      // leaking every other member's.
      people={
        isSelfScoped(user)
          ? [{ id: user.id, name: user.name }]
          : listAttributablePeople().map((u) => ({ id: u.id, name: u.name }))
      }
    />
  );
}
