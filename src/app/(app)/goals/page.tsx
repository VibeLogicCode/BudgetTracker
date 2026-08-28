import { requireUser } from '@/lib/auth/session';
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
      people={listAttributablePeople().map((u) => ({ id: u.id, name: u.name }))}
    />
  );
}
