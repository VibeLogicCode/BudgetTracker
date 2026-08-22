import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { AccountsManager } from './accounts-manager';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  await requireAdmin();

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

  const accounts = listAccounts({ includeInactive: true }).map((account) => ({
    id: account.id,
    name: account.name,
    institution: account.institution,
    type: account.type,
    ownerUserId: account.ownerUserId,
    isActive: account.isActive,
    isSimplefinManaged: isSimplefinManaged(account.id),
    importProfileId: account.importProfileId,
    importProfileName: account.importProfileId === null ? null : profileNameById.get(account.importProfileId) ?? null,
  }));
  const people = listUsers().map((user) => ({ id: user.id, name: user.name, isActive: user.isActive }));
  return <AccountsManager accounts={accounts} people={people} profiles={offeredProfiles} />;
}
