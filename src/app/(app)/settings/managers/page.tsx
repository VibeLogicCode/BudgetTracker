import { requireAdmin } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import { listRules } from '@/lib/categorize/rules';
import { getProfileUsage, listProfiles, type ProfileUsage } from '@/lib/import/presets';
import { previewProfilesPackExport, previewRulesPackExport } from '@/lib/packs';
import { ManagersClient } from './managers-client';

export const dynamic = 'force-dynamic';

export default async function ManagersPage() {
  await requireAdmin();
  const profiles = listProfiles();
  // Read path for both the delete confirm step and the v1.6.0 deactivate confirm step: the
  // confirm text must say what an action will do BEFORE the admin commits to it, so these
  // counts come from getProfileUsage() here, not from whatever the mutation last returned.
  // Computed for every profile, including built-ins -- deactivation (MUST-4.3), unlike
  // deletion, is allowed on a built-in and needs the same honest pinned-account count.
  const profileUsage: Record<number, ProfileUsage> = {};
  for (const profile of profiles) {
    profileUsage[profile.id] = getProfileUsage(profile.id);
  }
  return (
    <ManagersClient
      categories={listCategories({ includeArchived: true })}
      rules={listRules()}
      profiles={profiles}
      profileUsage={profileUsage}
      rulesPackRows={previewRulesPackExport({ includeTransferRules: true })}
      profilePackRows={previewProfilesPackExport()}
    />
  );
}
