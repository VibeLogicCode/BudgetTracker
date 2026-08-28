import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { reconcileAccount } from '@/lib/balance-reconcile';
import { todayIso } from '@/lib/dates';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { latestSnapshots } from '@/lib/networth';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { AccountsManager } from './accounts-manager';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const user = await requireAdmin();

  const today = todayIso();
  // v1.7.0 Task 6 (spec 2026-08-22): one row per account with a snapshot at or before today;
  // an account absent from this map has never had a balance recorded, SimpleFIN or manual.
  // v1.13.0 ruling R2: this page is requireAdmin(), so the viewer is always household-scoped --
  // passed through anyway because latestSnapshots/listAccounts now require one.
  const balanceByAccountId = new Map(
    latestSnapshots(today, user).map((snapshot) => [snapshot.accountId, snapshot] as const),
  );

  const allProfiles = listProfiles();
  // Same two conditions the import picker offers (Task 4, MUST-4.1): a profile that has been
  // deactivated or has an unreadable stored mapping is not something an admin should be able
  // to pin from here either. A profile ALREADY pinned but no longer offered still shows by
  // name below (Task 4's "dormant pin" -- nothing about it is hidden or nulled), just not
  // selectable in the control until it is reactivated/fixed.
  const offeredProfiles = allProfiles
    .filter(hasReadableMapping)
    .filter((p) => p.isActive)
    .map((p) => ({ id: p.id, name: p.name }));
  const profileNameById = new Map(allProfiles.map((p) => [p.id, p.name] as const));

  const accounts = listAccounts({ includeInactive: true }, user).map((account) => {
    const balance = balanceByAccountId.get(account.id) ?? null;
    return {
      id: account.id,
      name: account.name,
      institution: account.institution,
      type: account.type,
      ownerUserId: account.ownerUserId,
      isActive: account.isActive,
      isSimplefinManaged: isSimplefinManaged(account.id),
      importProfileId: account.importProfileId,
      importProfileName: account.importProfileId === null ? null : profileNameById.get(account.importProfileId) ?? null,
      latestBalanceCents: balance?.balanceCents ?? null,
      latestBalanceDate: balance?.date ?? null,
      // Lets the cell tell "this IS the balance on that date" from "this is today's balance,
      // and that date is only where it was anchored" -- see AccountRow.latestBalanceMovedCents.
      latestBalanceMovedCents: balance?.movedSinceCents ?? null,
      // v1.8.0 Task 5 (spec 2026-08-23): computed for every account, active or not, the same
      // way latestSnapshots above is -- a deactivated account's past statements are still worth
      // reconciling. Ruling R7: reconcileAccount only ever reports, so this is safe to compute
      // unconditionally on every page load; there is no write path for it to accidentally
      // trigger.
      discrepancies: reconcileAccount({ accountId: account.id }),
    };
  });
  const people = listUsers().map((user) => ({ id: user.id, name: user.name, isActive: user.isActive }));
  return <AccountsManager accounts={accounts} people={people} profiles={offeredProfiles} today={today} />;
}
