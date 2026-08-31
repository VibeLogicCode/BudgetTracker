import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { listAttributablePeople } from '@/lib/auth/users';
import { NewGoalClient } from './new-goal-client';

export const dynamic = 'force-dynamic';

/**
 * v1.20.0: "New goal" moves off /goals onto its own route, the same shape /warranties/new
 * already uses (see new-goal-client.tsx's own docblock for the fuller reasoning). This page
 * carries forward exactly the one thing the form on /goals needed from GoalsPage -- the owner
 * roster for the "Owner" <select> -- computed the SAME way, so a self-scoped viewer sees no
 * more of the household here than they did on the old disclosure.
 *
 * Ruling R5: every attribution picker reads listAttributablePeople(), which also surfaces
 * people who cannot sign in -- unlike the old listUsers().filter(isActive).
 * v1.13.1 review A (item 2): a self viewer must never receive the household roster --
 * canActOnOwner already refuses any owner other than themselves or "shared" server-side
 * (../actions.ts), so the "Owner" dropdown narrows to just their own name instead of leaking
 * every other member's.
 */
export default async function NewGoalPage() {
  const user = await requireUser();
  return (
    <NewGoalClient
      people={
        isSelfScoped(user)
          ? [{ id: user.id, name: user.name }]
          : listAttributablePeople().map((u) => ({ id: u.id, name: u.name }))
      }
    />
  );
}
