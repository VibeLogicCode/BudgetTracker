import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyItemTypes, warrantyItems } from '@/db/schema';
import { addDaysIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import { comingDueKey, installmentDueKey, installmentOverdueKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { unpaidInstallments } from '@/lib/warranty/installments';
import { isItemKind, type ItemKind } from '@/lib/warranty/constants';

/**
 * MUST-6.13: the flood guard. A single evaluation creates at most this many new outbox
 * ROWS for one user. Anything over the cap is simply not enqueued; the items are still
 * inside the window tomorrow and are picked up at the next slot. This bounds the first-run
 * backfill when somebody with a large library configures a channel for the first time.
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
 * MUST-6.12: one outbox row PER ITEM, key `due:<itemId>:<expiryDate>`, so an item is
 * announced once and then never again rather than nagging daily for the whole window.
 *
 * v1.12.0 (ruling C6): a SECOND source, read before the item-expiry loop -- unpaid installments
 * on this user's bill-kind items. No new event id and no new channel (ruling B15); the same
 * coming_due payload carries a variant.
 *
 * ORDER MATTERS ONLY BECAUSE OF THE CAP. MAX_NEW_ROWS_PER_USER_PER_EVALUATION is shared across
 * all three sources and still counts ROWS, not items. Overdue installments are enqueued first,
 * then upcoming installments, then item expiries: when the cap bites, the household should lose
 * the least urgent message, not the most.
 *
 * MUST-6.11's ownership rule needs no new column -- an installment's owner is its item's
 * owner_user_id, which unpaidInstallments() filters on.
 */
export function evaluateComingDue(input: { userId: number; now: Date; tz: string }): number {
  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const horizon = addDaysIso(today, settings.comingDueDays);
  const month = today.slice(0, 7);

  let enqueuedRows = 0;

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
  const ordered = [...installments.filter((row) => row.overdue), ...installments.filter((row) => !row.overdue)];

  for (const row of ordered) {
    if (enqueuedRows >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION) break;
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: row.itemName,
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      todayIso: today,
      overdue: row.overdue,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'coming_due',
      dedupKey: row.overdue
        ? installmentOverdueKey(row.installmentId, month)
        : installmentDueKey(row.installmentId, row.dueDate),
      subject,
      body,
      at: input.now,
    });
    enqueuedRows += result.inserted.length + result.household.length;
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
    if (enqueuedRows >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION) break;
    const expiryDate = row.expiryDate;
    if (expiryDate === null) continue;
    // MUST-6.14: the verb comes from expiryPhraseForKind() through render.ts. An item with
    // no type is 'warranty', matching the app's own unclassified default.
    const kind: ItemKind = row.kind !== null && isItemKind(row.kind) ? row.kind : 'warranty';
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'item',
      itemName: row.name,
      kind,
      expiryDate,
      todayIso: today,
      vendor: row.vendor,
      priceCents: row.priceCents,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'coming_due',
      dedupKey: comingDueKey(row.id, expiryDate),
      subject,
      body,
      at: input.now,
    });
    enqueuedRows += result.inserted.length + result.household.length;
  }
  return enqueuedRows;
}
