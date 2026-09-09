import { and, asc, eq, gte, isNotNull, isNull, like, lte, or } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { notificationOutbox, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { addDaysIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import {
  comingDueBatchKey,
  comingDueBatchMembers,
  comingDueKey,
  installmentDueKey,
  installmentOverdueKey,
} from '@/lib/notify/events';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
import { renderEvent, type ComingDueEntry } from '@/lib/notify/render';
import { unpaidInstallments } from '@/lib/warranty/installments';
import { isItemKind, type ItemKind } from '@/lib/warranty/constants';

/**
 * MUST-6.13: the flood guard. A single evaluation names at most this many things in one message.
 * Anything over the cap is counted in an "And N more" line instead; the items are still inside the
 * window tomorrow and are named once something ahead of them drops out. This bounds both the
 * message and the dedup key it is written under (comingDueBatchKey carries the item keys).
 */
export const MAX_NEW_ROWS_PER_USER_PER_EVALUATION = 20;

/**
 * MUST-6.10: at the user's daily slot: items where is_lifetime = 0, expiry_date IS NOT
 * NULL, and expiry_date BETWEEN todayIso AND addDaysIso(todayIso, coming_due_days).
 *
 * MUST-6.11: a user is notified about items where owner_user_id is that user.
 * warranty_items.owner_user_id is NOT NULL and defaults to the creator, so every item
 * notifies exactly one person and nothing is orphaned. Broadcasting every member's
 * expiring items to everybody is nagging, not visibility.
 *
 * v1.12.0 (ruling C6): a SECOND source, read before the item-expiry loop -- unpaid installments
 * on this user's bill-kind items. No new event id and no new channel (ruling B15); the same
 * coming_due payload carries a variant.
 *
 * 2026-09-09: ONE MESSAGE, NOT ONE PER ITEM.
 *
 * MUST-6.12 used to be the whole design: one outbox row per item, key `due:<itemId>:<expiryDate>`,
 * so an item was announced once and never nagged again. The property was right; the delivery was
 * not. Three bills and two warranties inside the window meant five notifications in the same
 * minute, each with its own subject line, which is the complaint the owner made about budgets
 * ("1 message per budget ... can we not send a summary message") and which applies here word for
 * word.
 *
 * The announced-once property is KEPT, and this is the part worth reading. The per-item keys are
 * still the ledger -- they are simply carried INSIDE the batch row's dedup key (comingDueBatchKey)
 * instead of each having a row of their own. Every `due:batch:` key already written is read back,
 * split, and unioned into "already announced"; a batch is sent only when something in the window
 * is not in that union. So:
 *
 *   - nothing new in the window        -> no message, however long the items sit there
 *   - one new bill joins four old ones -> ONE message, and it names all five, because a list of
 *                                         what is due is more use than a note about the newcomer
 *   - an item drops out of the window  -> nothing, since a shrinking set contains nothing new
 *   - an overdue installment           -> re-announced monthly, because installmentOverdueKey
 *                                         carries the month and next month's token is new
 *
 * The read includes rows with `user_id IS NULL` deliberately: when the event is routed to the
 * family channel on every channel there IS no personal row, and the household row is the only
 * record that the announcement happened. Tokens cannot cross between members -- every source below
 * filters on this user's ownership -- so unioning the household's rows in is safe.
 *
 * ORDER MATTERS ONLY BECAUSE OF THE CAP, which is shared across all three sources. Overdue
 * installments come first, then upcoming installments, then item expiries: when the cap bites the
 * household should lose the least urgent line, not the most.
 */
export function evaluateComingDue(input: { userId: number; now: Date; tz: string }): number {
  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const horizon = addDaysIso(today, settings.comingDueDays);
  const month = today.slice(0, 7);

  // Every candidate, in the order the cap should keep them.
  const candidates: { key: string; entry: ComingDueEntry }[] = [];

  // This evaluator's window is the user's own comingDueDays (settings, above), deliberately not
  // shared with the detail page's INSTALLMENT_DUE_SOON_DAYS constant -- that is a separate,
  // fixed lookahead the detail page uses for its own "Due soon" badge. Neither reader invents
  // a third window; each just uses its own.
  const installments = unpaidInstallments({
    today,
    windowEnd: horizon,
    includeOverdue: true,
    ownerUserId: input.userId,
  });
  // Overdue first (see the docblock). unpaidInstallments returns due_date ASC, so a stable
  // partition preserves date order inside each group.
  for (const row of [...installments.filter((r) => r.overdue), ...installments.filter((r) => !r.overdue)]) {
    candidates.push({
      key: row.overdue ? installmentOverdueKey(row.installmentId, month) : installmentDueKey(row.installmentId, row.dueDate),
      entry: {
        kind: 'installment',
        name: row.itemName,
        dateIso: row.dueDate,
        overdue: row.overdue,
        amountCents: row.amountCents,
        itemKind: null,
        vendor: null,
        priceCents: null,
      },
    });
  }

  const rows = getDb()
    .select({
      id: warrantyItems.id,
      name: warrantyItems.name,
      vendor: warrantyItems.vendor,
      priceCents: warrantyItems.priceCents,
      expiryDate: warrantyItems.expiryDate,
      kind: warrantyItemTypes.kind,
    })
    .from(warrantyItems)
    .leftJoin(warrantyItemTypes, eq(warrantyItems.typeId, warrantyItemTypes.id))
    .where(
      and(
        eq(warrantyItems.ownerUserId, input.userId),
        eq(warrantyItems.isLifetime, false),
        isNotNull(warrantyItems.expiryDate),
        gte(warrantyItems.expiryDate, today),
        lte(warrantyItems.expiryDate, horizon),
      ),
    )
    .orderBy(asc(warrantyItems.expiryDate), asc(warrantyItems.id))
    .all();

  for (const row of rows) {
    const expiryDate = row.expiryDate;
    if (expiryDate === null) continue;
    // MUST-6.14: the verb comes from expiryPhraseForKind() through render.ts. An item with
    // no type is 'warranty', matching the app's own unclassified default.
    const kind: ItemKind = row.kind !== null && isItemKind(row.kind) ? row.kind : 'warranty';
    candidates.push({
      key: comingDueKey(row.id, expiryDate),
      entry: {
        kind: 'expiry',
        name: row.name,
        dateIso: expiryDate,
        overdue: false,
        amountCents: null,
        itemKind: kind,
        vendor: row.vendor,
        priceCents: row.priceCents,
      },
    });
  }

  if (candidates.length === 0) return 0;
  // One read, before the loop that asks about it: the answer cannot change mid-evaluation, and
  // no cache outlives the call -- a batch enqueued below MUST be visible to the next evaluation.
  const announced = announcedKeys(input.userId);
  const fresh = candidates.filter(({ key }) => !announced.has(key));
  if (fresh.length === 0) return 0;

  /**
   * THE CAP MUST NEVER CROWD OUT A NEW ITEM. Taking the first 20 candidates in priority order
   * looks right and is wrong: with 20 already-announced items ahead of it, a genuinely new
   * twenty-first would produce a key identical to the one already in the outbox, the unique index
   * would discard it, and that item would never be announced at all -- silently, for ever.
   *
   * So the new ones claim their places first, and any remaining room goes to the rest. The message
   * is then re-ordered back into candidate order, because what the household should read is the
   * board as it stands -- overdue, then coming up, by date -- not "the new ones, then the others".
   */
  const claimed = new Set(
    (fresh.length >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION
      ? fresh.slice(0, MAX_NEW_ROWS_PER_USER_PER_EVALUATION)
      : [...fresh, ...candidates.filter(({ key }) => announced.has(key))].slice(0, MAX_NEW_ROWS_PER_USER_PER_EVALUATION)
    ).map(({ key }) => key),
  );
  const shown = candidates.filter(({ key }) => claimed.has(key));
  const { subject, body } = renderEvent({
    event: 'coming_due',
    variant: 'batch',
    todayIso: today,
    entries: shown.map(({ entry }) => entry),
    omitted: candidates.length - shown.length,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'coming_due',
    // Only the keys this message actually NAMES go in. An item beyond the cap is counted in the
    // "And N more" line and stays unannounced, so it is still new tomorrow -- which is what makes
    // the cap a deferral rather than a silent drop.
    dedupKey: comingDueBatchKey(shown.map(({ key }) => key)),
    subject,
    body,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * Every per-item key this user has already been told about, unioned out of the batch rows.
 *
 * NOT CACHED between calls, deliberately. The row this evaluation is about to write is the record
 * that these items were announced, and a cache surviving the call would hide it from the next one
 * -- which would send the same batch again tomorrow, the exact failure the whole design avoids.
 *
 * Bounded by the retention sweep, which prunes outbox rows at 400 days -- and pruning is safe here
 * for exactly the reason MUST-3.12 gives: every token inside these keys is itself bounded to a date
 * or a month that the evaluation window has long since passed, so a pruned batch row can only
 * resurrect an announcement for something no longer in the window.
 */
function announcedKeys(userId: number): Set<string> {
  const out = new Set<string>();
  for (const row of getDb()
    .select({ dedupKey: notificationOutbox.dedupKey })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.eventId, 'coming_due'),
        like(notificationOutbox.dedupKey, 'due:batch:%'),
        // The household row (user_id NULL) is the ONLY record of the announcement when the event
        // is routed to the family channel on every channel -- see the docblock.
        or(eq(notificationOutbox.userId, userId), isNull(notificationOutbox.userId)),
      ),
    )
    .all()) {
    for (const token of comingDueBatchMembers(row.dedupKey)) out.add(token);
  }
  return out;
}
