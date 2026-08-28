import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports } from '@/db/schema';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { daysBetweenIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import { staleImportKey } from '@/lib/notify/events';
import { mondayOfIsoWeek } from '@/lib/notify/evaluate/slots';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * Mirrors digest.ts's own viewerFor exactly (kept local rather than shared for the same reason
 * that module's docblock gives): falls back to a household-scoped viewer if the recipient's own
 * row is somehow gone by the time this evaluator runs, reproducing the pre-R2 unscoped behaviour
 * rather than crashing a scheduled run over one missing row.
 */
function viewerFor(userId: number): Viewer {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : { id: userId, role: 'admin', visibility: 'household' };
}

/**
 * Decision 10 (unchanged): an install with ZERO imports never fires. A brand-new install must not nag
 * before it has anything to be stale about -- which now means, per account: an account that has never
 * been imported into is not stale, it is new, and the group-by below simply never produces a row for
 * it.
 *
 * MUST-14.8 (unchanged): SimpleFIN syncs create `imports` rows too, so a SimpleFIN-managed account is
 * never nagged. The query still looks at every import against an account rather than only the ones
 * this user made: staleness is a property of the data, not of who last pressed the button.
 *
 * v1.13.0 ruling R14 (item AM / PROD-10). This used to take the single most recent import ACROSS THE
 * WHOLE HOUSEHOLD, so importing TD on the 3rd silenced the alert for the Amex nobody had touched
 * since February -- exactly backwards for a household on manual CSV across five accounts.
 *
 * MUST-3.11/3.12: still one message per calendar week while stale, but the key now carries the
 * account id so each lagging account nags at most once a week and they cannot mask each other. No new
 * event id: notification_prefs keys on the event id string, so a second id would mean a migration, a
 * new default and a second switch a household has to find, for what is one idea.
 *
 * v1.13.0 ruling R2 (item I5). This evaluator took no viewer at all and queried EVERY account in
 * the install unconditionally -- so a self-visibility recipient got nagged about accounts they
 * cannot even see on any page. Unlike the weekly/monthly digests (digest.ts, monthly.ts), there is
 * no honest re-scoped version of "which account is stale" to send a self viewer instead: a stale
 * account is a household fact about data the self viewer has no page that shows, not a personal
 * total that can be narrowed to their own attribution. So this returns 0 -- no message enqueued at
 * all -- rather than trying to scope the account list down.
 */
export function evaluateStaleImport(input: { userId: number; now: Date; tz: string }): number {
  if (isSelfScoped(viewerFor(input.userId))) return 0;

  const rows = getDb()
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      newest: sql<string>`max(${imports.createdAt})`,
    })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .where(eq(accounts.isActive, true))
    .groupBy(accounts.id)
    .all();
  if (rows.length === 0) return 0;

  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const monday = mondayOfIsoWeek(today);
  let enqueued = 0;

  for (const row of rows) {
    const lastImportIso = row.newest.slice(0, 10);
    const daysAgo = daysBetweenIso(lastImportIso, today);
    if (daysAgo < settings.staleImportWeeks * 7) continue;

    const { subject, body } = renderEvent({
      event: 'stale_import',
      weeks: settings.staleImportWeeks,
      lastImportIso,
      daysAgo,
      accountName: row.accountName,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'stale_import',
      dedupKey: staleImportKey(monday, row.accountId),
      subject,
      body,
      at: input.now,
    });
    if (result.inserted.length > 0) enqueued += 1;
  }
  return enqueued;
}
