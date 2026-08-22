import { requireUser } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { listUsers } from '@/lib/auth/users';
import { hasReadableMapping, listProfiles } from '@/lib/import/presets';
import { listImportHistory } from '@/lib/import/commit';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
import { ImportClient } from './import-client';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  const allAccounts = listAccounts();
  const csvAccounts = allAccounts.filter((a) => !isSimplefinManaged(a.id));
  const managed = allAccounts.filter((a) => isSimplefinManaged(a.id));
  return (
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
  );
}
