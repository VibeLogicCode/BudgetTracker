import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { listImportHistory } from '@/lib/import/commit';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { monthLabel } from '@/lib/dates';
import { monthState, openMonths } from '@/lib/month-close';
import { CloseMonthCard, type OpenMonthView } from '@/components/CloseMonthCard';
import { SendDigestNow } from '@/components/SendDigestNow';
import { ImportClient } from './import-client';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const user = await requireUser();
  // Controller ruling: nav hiding alone is insufficient -- the review-queue/import-account
  // queries this page touches are unscoped, so a self viewer must be refused server-side too.
  if (isSelfScoped(user)) redirect('/dashboard');
  // Ruling R10: an asset account takes no transactions and no imports, so it is never an
  // import target.
  const allAccounts = listAccounts({}, user).filter((a) => acceptsTransactions(a.type));
  const csvAccounts = allAccounts.filter((a) => !isSimplefinManaged(a.id));
  const managed = allAccounts.filter((a) => isSimplefinManaged(a.id));

  /**
   * 2026-09-08. Months that have ended and nobody has confirmed complete. The card self-hides when
   * there are none and for a household whose accounts are all SimpleFIN-linked (those close
   * themselves — see src/lib/month-close.ts), so this costs an idle household nothing on screen.
   */
  const openMonthViews: OpenMonthView[] = openMonths().map((month) => {
    const state = monthState(month);
    return {
      month,
      label: monthLabel(month),
      accounts: state.accounts.map((a) => ({
        name: a.name,
        linked: a.linked,
        synced: a.synced,
        lastSyncAt: a.lastSyncAt,
      })),
      waiting: state.waiting,
      needsConfirmation: state.needsConfirmation,
    };
  });

  return (
    <>
    <CloseMonthCard months={openMonthViews} />
    {/*
      2026-09-09. The SAME control as the dashboard's, on the page somebody is standing on the
      moment they have just finished importing.

      That moment is the whole point. The summary only sends when transactions have arrived since
      the last one, so an import is exactly when there is something new to say -- and "I have just
      loaded this week's statements, tell everyone where we are" is one press rather than a trip
      back to the dashboard. It is the same act as closing a month directly above it.

      No self-scoped case to handle here: this page redirects a self viewer at the top, so
      canNotifyHousehold is unconditionally true by the time this renders.
    */}
    <div className="flex justify-end">
      <SendDigestNow canNotifyHousehold />
    </div>
    <ImportClient
      accounts={csvAccounts.map((a) => ({ id: a.id, name: a.name, importProfileId: a.importProfileId }))}
      // A profile with an unreadable stored mapping (see ProfileRecord.mappingError) is not
      // offered here — there is nothing usable to import a file with. Nor is a DEACTIVATED
      // profile (v1.6.0, MUST-4.1) — the whole point of is_active is to let a household get
      // an unused built-in bank preset off this exact list. Both keep showing on the managers
      // page: an unreadable one so it can be deleted, an inactive one so it can be reactivated.
      profiles={listProfiles()
        .filter(hasReadableMapping)
        .filter((p) => p.isActive)
        .map((p) => ({ id: p.id, name: p.name, isBuiltin: p.isBuiltin, mapping: p.mapping }))}
      history={listImportHistory(25)}
      simplefinManaged={managed.map((a) => a.name)}
      // Active users, offered on each card value's person select (v1.6.0, MUST-6.1). An
      // assignment to a since-deactivated user still shows correctly (ImportClient injects it
      // as an extra option) — this list only decides what a NEW assignment may pick.
      people={listUsers()
        .filter((u) => u.isActive)
        .map((u) => ({ id: u.id, name: u.name }))}
    />
  </>
  );
}
