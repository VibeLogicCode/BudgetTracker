import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { mustChangePassword } from '@/lib/auth/users';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { waitingSetAsideCount } from '@/lib/import/set-aside';
import { APP_VERSION } from '@/lib/version';
import { AppShell } from '@/components/app-shell/AppShell';

export const dynamic = 'force-dynamic';

/**
 * Forced password change (spec v1.5). Since v1.64.1 it is a boundary everywhere, not only here:
 * `requireUser` sends a flagged user to /change-password and `userFromRequest` refuses them on
 * every route, so no action or API works until the admin-issued password is replaced. Only the
 * change-password page and action (through `requireUserForPasswordChange`) and logout stay open.
 * The redirect below is the page-layer half of the same rule.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (mustChangePassword(user.id)) redirect('/change-password');
  // v1.13.0 ruling R2 (item I1): reviewQueueCount() is a household-wide figure with no owner
  // scoping of its own (src/lib/categorize/engine.ts) -- computing it unconditionally serialized
  // a household total into AppShell's props even for a self viewer, whose nav never renders the
  // review badge at all. Same "no household figure leaves this file, even unrendered" reasoning
  // already applied to budgets/page.tsx and reports/page.tsx. v1.60.0: one count per request --
  // reviewQueueCount is React-cached, so a page under this layout that asks again reuses it.
  // v1.61.0 item 4b: plus the rows held as possible duplicates, which wait in Needs review too
  // (waitingSetAsideCount, cached the same way). Neither count is computed for a self viewer.
  const reviewCount = isSelfScoped(user) ? 0 : reviewQueueCount() + waitingSetAsideCount();
  return (
    <AppShell
      user={{ id: user.id, name: user.name, role: user.role, visibility: user.visibility }}
      reviewCount={reviewCount}
      version={APP_VERSION}
    >
      {children}
    </AppShell>
  );
}
