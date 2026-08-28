import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import {
  AUTO_SYNC_INTERVALS,
  DAILY_REQUEST_LIMIT,
  SETTING_AUTO_SYNC,
  getConnection,
  isAutoSyncInterval,
  listLinks,
  remainingRequestsToday,
} from '@/lib/simplefin/connection';
import { getSetting } from '@/lib/settings';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const user = await requireAdmin();
  const connection = getConnection();
  const storedAutoSync = getSetting(SETTING_AUTO_SYNC);
  const autoSync = storedAutoSync !== null && isAutoSyncInterval(storedAutoSync) ? storedAutoSync : null;
  return (
    <ConnectionsClient
      connection={connection}
      links={listLinks()}
      // This page is requireAdmin()-only, so the viewer is always household-scoped --
      // passed through anyway because listAccounts now requires one (ruling R2).
      accounts={listAccounts({}, user).map((a) => ({ id: a.id, name: a.name }))}
      remainingRequests={connection ? remainingRequestsToday() : DAILY_REQUEST_LIMIT}
      dailyLimit={DAILY_REQUEST_LIMIT}
      autoSync={autoSync}
      // Server Component computes this FROM the constant and passes plain strings down --
      // the client component never imports @/lib/simplefin/connection as a VALUE (only its
      // types, which are erased at build time), because that module pulls in @/db/client
      // (better-sqlite3) and would break the client bundle. See connections-client.tsx.
      autoSyncOptions={Object.entries(AUTO_SYNC_INTERVALS).map(([value, cfg]) => ({ value, label: cfg.label }))}
    />
  );
}
