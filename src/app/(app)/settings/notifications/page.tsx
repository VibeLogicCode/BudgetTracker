import { requireUser } from '@/lib/auth/session';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import { PageHeader } from '@/components/ui/PageHeader';
import { SMTP_PRESETS, getPrefs, getSmtp, getTarget, getUserSettings } from '@/lib/notify/config';
import { eventsFor } from '@/lib/notify/events';
// v1.28.0 Lane 2 (family channels): the household-scoped reads, one import path per that
// module's own docblock. listHouseholdTargets/householdEventPrefs/householdEligibleEvents are
// reads for this page; householdTarget/upsertHouseholdTarget/deleteHouseholdTarget/
// setHouseholdEventPref (the write paths) live in actions.ts, not here.
import { listHouseholdTargets, householdEventPrefs, householdEligibleEvents } from '@/lib/notify/household';
import { listRecentDeliveries, type DeliveryRow } from '@/lib/notify/outbox';
import { NotificationsClient, isNotificationTab, type NotificationsPageData } from './notifications-client';

export const dynamic = 'force-dynamic';

/**
 * Review fix (MED): `subject` is a rendered message line (for coming_due it names the
 * warranty/subscription, for budget events the category) and `attempts` is internal retry
 * bookkeeping. Neither is ever displayed by the client (see NotificationsClient's Recent
 * deliveries table), yet an admin's "household-wide view" spread every OTHER member's row
 * wholesale into their own RSC flight payload, leaking other members' subjects to the admin's
 * browser even though nothing on the page shows them. Narrowed explicitly, field by field, so
 * a future spread can't reintroduce it silently.
 */
export function toDeliveryForClient(
  row: DeliveryRow,
  userName: string,
): Omit<DeliveryRow, 'subject' | 'attempts'> & { userName: string } {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    eventId: row.eventId,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    userName,
  };
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();

  // v1.29.0 (four URL-driven tabs, replacing six long cards on one scroll). Same
  // fallback-on-malformed-input idiom dashboard/page.tsx already uses for `?month=`: a missing
  // or garbage `?tab=` is a reason to show the default tab, never a reason to throw. See
  // notifications-client.tsx's own docblock on NotificationTab for why this is a URL at all
  // rather than client state.
  const params = await searchParams;
  const rawTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab = isNotificationTab(rawTab) ? rawTab : 'email';

  // MUST-3.7: the page renders EFFECTIVE values, resolved once here so the client never
  // re-implements the fallback rule.
  const stored = getPrefs(user.id);
  const prefs: Record<string, boolean> = {};
  for (const event of eventsFor(user.role)) {
    for (const channel of ['telegram', 'email'] as const) {
      prefs[`${event.id}:${channel}`] = stored[`${event.id}:${channel}`] ?? event.defaultEnabled;
    }
  }

  // §11.6: admins get the household-wide view with a name column.
  const nameById = new Map(
    getDb()
      .select({ id: users.id, name: users.name })
      .from(users)
      .all()
      .map((row) => [row.id, row.name] as const),
  );
  const deliveries = listRecentDeliveries({ userId: user.role === 'admin' ? null : user.id }).map((row) =>
    // v1.28.0: a household send carries user_id NULL (src/lib/notify/outbox.ts's own docblock
    // on DeliveryRow: "render it with a household label, never by looking a user up") -- a
    // member never sees one of these rows at all (listRecentDeliveries' own userId filter
    // excludes them), so this branch is reachable only in the admin's household-wide view.
    toDeliveryForClient(row, row.userId === null ? 'Household' : (nameById.get(row.userId) ?? 'Unknown')),
  );

  const relay = getSmtp();

  // v1.28.0 Lane 2 (family channels). MUST-4.3-style narrowing, extended to this new section:
  // a member's payload only ever carries the eligible events THEIR OWN role could otherwise
  // receive personally -- routing an admin-only event to the family channel can never replace
  // a personal copy a member was never going to get in the first place, so there is nothing
  // for a member to be told about it.
  const householdList = listHouseholdTargets();
  const householdTelegram = householdList.find((row) => row.channel === 'telegram') ?? null;
  const householdEmail = householdList.find((row) => row.channel === 'email') ?? null;
  const householdEligible = householdEligibleEvents().filter(
    (event) => user.role === 'admin' || event.audience === 'all',
  );
  const householdPrefsRaw = householdEventPrefs();
  // Resolved to a plain boolean per (event, channel), default OFF when unset -- unlike the
  // personal matrix's `event.defaultEnabled` fallback above, a routing switch nobody has ever
  // touched must default to "not routed": silently moving a household's messages the moment
  // this feature ships would be the opposite of decision 4 (a routed event REPLACES the
  // personal copy -- an admin has to choose that, it cannot be the shipped default).
  const householdPrefs: Record<string, { telegram: boolean; email: boolean }> = {};
  for (const event of householdEligible) {
    householdPrefs[event.id] = {
      telegram: householdPrefsRaw[event.id]?.telegram ?? false,
      email: householdPrefsRaw[event.id]?.email ?? false,
    };
  }

  const data: NotificationsPageData = {
    role: user.role,
    tab,
    // MUST-5.3: getSmtp() returns passwordSet, never the password; getTarget() returns
    // secretSet, never the token. §11.3: members see none of the relay's configuration,
    // only whether one exists, so their email card can explain itself.
    smtp: user.role === 'admin' ? relay : null,
    relayConfigured: relay?.enabled === true,
    targets: { telegram: getTarget(user.id, 'telegram'), email: getTarget(user.id, 'email') },
    events: eventsFor(user.role),
    prefs,
    settings: getUserSettings(user.id),
    deliveries,
    presets: SMTP_PRESETS,
    household: {
      // Admin only -- a member never learns the family channel's destination or secret
      // state, the same withholding §11.3 already applies to `smtp` just above.
      targets: user.role === 'admin' ? { telegram: householdTelegram, email: householdEmail } : null,
      eligibleEvents: householdEligible,
      prefs: householdPrefs,
    },
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <PageHeader title="Notifications" description="Nothing is sent anywhere until you set up a channel below." />
      <NotificationsClient {...data} />
    </div>
  );
}
