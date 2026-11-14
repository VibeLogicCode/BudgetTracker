import { requireAdmin } from '@/lib/auth/session';
import { listAccounts } from '@/lib/accounts';
import { localTimeLabel, todayIso } from '@/lib/dates';
import {
  AUTO_SYNC_INTERVALS,
  DAILY_REQUEST_LIMIT,
  SETTING_AUTO_SYNC,
  autoSyncBackoff,
  getConnection,
  isAutoSyncInterval,
  listLinks,
  remainingRequestsToday,
} from '@/lib/simplefin/connection';
import { getSetting } from '@/lib/settings';
import { localAiStatus, readLocalAiConfig } from '@/lib/ai/config';
import { ConnectionsClient } from './connections-client';
import { LocalAiCard } from './local-ai-card';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const user = await requireAdmin();
  const connection = getConnection();
  const storedAutoSync = getSetting(SETTING_AUTO_SYNC);
  const autoSync = storedAutoSync !== null && isAutoSyncInterval(storedAutoSync) ? storedAutoSync : null;
  // v1.60.0: only while automatic sync is on and waiting out a failure backoff. The time is the
  // household's clock, HH:mm, with the day named when it is not today (a backoff runs up to 24h).
  const now = new Date();
  const backoff = autoSync !== null && connection !== null ? autoSyncBackoff(now) : null;
  // v1.64.0: the optional local AI card. Reads settings only; nothing here waits on the model server.
  const aiStatus = localAiStatus(now);
  const aiConfig = readLocalAiConfig();
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
    <ConnectionsClient
      connection={connection}
      // v1.61.0: each link carries its start date (syncFrom), shown as `from May 29`; today lets a
      // date in this year read without its year.
      links={listLinks()}
      today={todayIso(now)}
      // This page is requireAdmin()-only, so the viewer is always household-scoped --
      // passed through anyway because listAccounts now requires one (ruling R2).
      accounts={listAccounts({}, user).map((a) => ({ id: a.id, name: a.name }))}
      remainingRequests={connection ? remainingRequestsToday() : DAILY_REQUEST_LIMIT}
      dailyLimit={DAILY_REQUEST_LIMIT}
      autoSync={autoSync}
      autoSyncWaiting={
        backoff ? { failures: backoff.failures, nextTry: localTimeLabel(backoff.nextTryAt.toISOString(), now) } : null
      }
      // Server Component computes this FROM the constant and passes plain strings down --
      // the client component never imports @/lib/simplefin/connection as a VALUE (only its
      // types, which are erased at build time), because that module pulls in @/db/client
      // (better-sqlite3) and would break the client bundle. See connections-client.tsx.
      autoSyncOptions={Object.entries(AUTO_SYNC_INTERVALS).map(([value, cfg]) => ({ value, label: cfg.label }))}
    />
    <LocalAiCard
      status={aiStatus}
      lastOkLabel={aiStatus.lastOkAt ? localTimeLabel(aiStatus.lastOkAt, now) : null}
      nextTryLabel={aiStatus.nextTryAt ? localTimeLabel(aiStatus.nextTryAt, now) : null}
      baseUrl={aiConfig?.baseUrl ?? getSetting('local_ai_base_url') ?? ''}
      model={aiConfig?.model ?? getSetting('local_ai_model') ?? ''}
    />
    </div>
  );
}
