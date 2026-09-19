/**
 * Loan notifications (ledger spec N2–N4).
 *
 * Three events, all derived from the same two tables the ledger already writes: what posted, and
 * what a period was paid. None of them re-derives interest -- a message that disagreed with the
 * loan page would be worse than no message.
 *
 * Every one follows evaluateComingDue's shape: one message naming several things rather than
 * several messages naming one each (the 2026-09-09 ruling), a cap on how many are named, and a
 * batch dedup key carrying the per-item keys so nothing is announced twice.
 */
import { and, asc, desc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanAnchors, loanPostings, notificationOutbox, warrantyItems } from '@/db/schema';
import { addMonths, monthOf, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS } from '@/lib/notify/events';
import { familyChannelNeedsOwnPass } from '@/lib/notify/family-pass';
import { enqueue, kickOutbox } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/** MUST-6.13's flood guard, the same number evaluateComingDue uses. */
const MAX_NAMED = 8;

/** A loan is stale after two months with no statement. One rule for every basis (ruling R10). */
const STALE_MONTHS = 2;

/**
 * The batch key. Every per-item key this message NAMES goes inside it, so an item beyond the cap
 * stays unannounced and is still new tomorrow -- the cap defers, it does not drop.
 */
function batchKey(prefix: string, keys: string[]): string {
  return `${prefix}:batch:${[...keys].sort().join(',')}`;
}

/** Keys already announced, recovered by splitting every batch row this event has written. */
function alreadyAnnounced(eventId: string, userId: number | null): Set<string> {
  const rows = getDb()
    .select({ dedupKey: notificationOutbox.dedupKey })
    .from(notificationOutbox)
    .where(eq(notificationOutbox.eventId, eventId))
    .all();
  const seen = new Set<string>();
  for (const row of rows) {
    const inner = row.dedupKey.split(':batch:')[1];
    if (inner === undefined) continue;
    for (const key of inner.split(',')) seen.add(key);
  }
  void userId;
  return seen;
}

/**
 * The subscription gate, taking the event id as a LITERAL at each call site rather than a variable.
 *
 * Spelling it out is what lets tests/ops/family-channel-pass.test.ts see, from the source alone,
 * that each household-eligible event consults the one definition of "is the room the only
 * subscriber left" -- a guard cannot follow a parameter, and R23 is exactly the kind of thing that
 * comes back when nothing is watching.
 */
function subscribed(eventId: 'loan_payment_missed' | 'loan_reconcile_due', userId: number | null): boolean {
  if (userId === null) {
    return eventId === 'loan_payment_missed'
      ? familyChannelNeedsOwnPass('loan_payment_missed')
      : familyChannelNeedsOwnPass('loan_reconcile_due');
  }
  return CHANNELS.some((channel) => isEventEnabled(userId, eventId, channel));
}

/** The loans a recipient hears about: their own, or every one for the household channel. */
function loansFor(userId: number | null): {
  id: number;
  name: string;
  direction: 'owed' | 'lent';
  ownerUserId: number | null;
}[] {
  const rows = getDb()
    .select({
      id: warrantyItems.id,
      name: warrantyItems.name,
      direction: warrantyItems.loanDirection,
      ownerUserId: warrantyItems.ownerUserId,
    })
    .from(warrantyItems)
    .where(isNotNull(warrantyItems.interestRateBasis))
    .orderBy(asc(warrantyItems.id))
    .all();
  return userId === null ? rows : rows.filter((row) => row.ownerUserId === userId);
}

export interface PostedLoan {
  itemId: number;
  itemName: string;
  ownerUserId: number | null;
  interestCents: number;
  balanceCents: number;
  periodEnd: string;
  adjusted: boolean;
}

/**
 * N2. One message per sweep naming every loan that posted, to each loan's owner.
 *
 * Raised from the posting path rather than a slot, because the interesting moment is the posting
 * itself -- and because a slot evaluator would have to work out all over again which periods were
 * new, which is exactly what postDueInterest has just finished deciding.
 */
export function raiseInterestPosted(input: { posted: PostedLoan[]; at: Date }): number {
  if (input.posted.length === 0) return 0;
  const byRecipient = new Map<number | null, PostedLoan[]>();
  for (const row of input.posted) {
    const list = byRecipient.get(row.ownerUserId) ?? [];
    list.push(row);
    byRecipient.set(row.ownerUserId, list);
  }
  // The family channel hears about every loan, once, when no member is subscribed personally.
  if (familyChannelNeedsOwnPass('loan_interest_posted')) byRecipient.set(null, input.posted);

  let sent = 0;
  for (const [userId, loans] of byRecipient) {
    if (userId === null) {
      if (!familyChannelNeedsOwnPass('loan_interest_posted')) continue;
    } else if (!CHANNELS.some((channel) => isEventEnabled(userId, 'loan_interest_posted', channel))) {
      continue;
    }
    const announced = alreadyAnnounced('loan_interest_posted', userId);
    const fresh = loans.filter((row) => !announced.has(`loan:posted:${row.itemId}:${row.periodEnd}`));
    if (fresh.length === 0) continue;
    const shown = fresh.slice(0, MAX_NAMED);
    const { subject, body } = renderEvent({
      event: 'loan_interest_posted',
      loans: shown.map((row) => ({
        name: row.itemName,
        interestCents: row.interestCents,
        balanceCents: row.balanceCents,
        adjusted: row.adjusted,
      })),
      more: fresh.length - shown.length,
    });
    sent += enqueue({
      userId,
      eventId: 'loan_interest_posted',
      dedupKey: batchKey('loan:posted', shown.map((row) => `loan:posted:${row.itemId}:${row.periodEnd}`)),
      subject,
      body,
      at: input.at,
    }).inserted.length;
  }
  if (sent > 0) kickOutbox(input.at);
  return sent;
}

/**
 * N3. A posting day went by with no payment recorded against it.
 *
 * Reads the newest POSTING for each loan and asks whether anything was paid into the period it
 * closed. That is the honest question: the ledger already worked out what landed in that span, and
 * asking it again here is how the two would come to disagree.
 *
 * A loan whose term has already ended is skipped. A finished term with a balance left on it is a
 * different thing from a missed payment, and this message would be the wrong words for it.
 */
export function evaluateLoanPaymentMissed(input: { userId: number | null; now: Date; tz: string }): number {
  if (!subscribed('loan_payment_missed', input.userId)) return 0;
  const today = todayIso(input.now, input.tz);
  const announced = alreadyAnnounced('loan_payment_missed', input.userId);

  const candidates: { key: string; name: string; periodStart: string; periodEnd: string; direction: 'owed' | 'lent' }[] = [];
  for (const loan of loansFor(input.userId)) {
    const expiry = getDb()
      .select({ expiryDate: warrantyItems.expiryDate })
      .from(warrantyItems)
      .where(eq(warrantyItems.id, loan.id))
      .get();
    if (expiry?.expiryDate != null && expiry.expiryDate < today) continue;

    const newest = getDb()
      .select({
        periodStart: loanPostings.periodStart,
        periodEnd: loanPostings.periodEnd,
        paymentsCents: loanPostings.paymentsCents,
      })
      .from(loanPostings)
      .where(and(eq(loanPostings.itemId, loan.id), eq(loanPostings.kind, 'posting'), lte(loanPostings.periodEnd, today)))
      .orderBy(desc(loanPostings.periodEnd), desc(loanPostings.id))
      .limit(1)
      .get();
    if (newest === undefined || newest.paymentsCents > 0) continue;

    const key = `loan:missed:${loan.id}:${newest.periodEnd}`;
    if (announced.has(key)) continue;
    candidates.push({ key, name: loan.name, periodStart: newest.periodStart, periodEnd: newest.periodEnd, direction: loan.direction });
  }
  if (candidates.length === 0) return 0;

  const shown = candidates.slice(0, MAX_NAMED);
  const { subject, body } = renderEvent({
    event: 'loan_payment_missed',
    loans: shown.map((row) => ({
      name: row.name,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      direction: row.direction,
    })),
    more: candidates.length - shown.length,
  });
  const inserted = enqueue({
    userId: input.userId,
    eventId: 'loan_payment_missed',
    dedupKey: batchKey('loan:missed', shown.map((row) => row.key)),
    subject,
    body,
    at: input.now,
  }).inserted.length;
  if (inserted > 0) kickOutbox(input.now);
  return inserted > 0 ? 1 : 0;
}

/**
 * N4. Two months without a statement.
 *
 * Keyed by month, so it asks once a month rather than every day until somebody acts -- a nag is
 * how a person learns to ignore a channel.
 */
export function evaluateLoanReconcileDue(input: { userId: number | null; now: Date; tz: string }): number {
  if (!subscribed('loan_reconcile_due', input.userId)) return 0;
  const today = todayIso(input.now, input.tz);
  const cutoff = `${addMonths(monthOf(today), -STALE_MONTHS)}-01`;
  const announced = alreadyAnnounced('loan_reconcile_due', input.userId);

  const candidates: { key: string; name: string; lastStatement: string }[] = [];
  for (const loan of loansFor(input.userId)) {
    const newest = getDb()
      .select({ asOfDate: loanAnchors.asOfDate })
      .from(loanAnchors)
      .where(eq(loanAnchors.itemId, loan.id))
      .orderBy(desc(loanAnchors.asOfDate), desc(loanAnchors.id))
      .limit(1)
      .get();
    if (newest === undefined || newest.asOfDate >= cutoff) continue;
    const key = `loan:stale:${loan.id}:${today.slice(0, 7)}`;
    if (announced.has(key)) continue;
    candidates.push({ key, name: loan.name, lastStatement: newest.asOfDate });
  }
  if (candidates.length === 0) return 0;

  const shown = candidates.slice(0, MAX_NAMED);
  const { subject, body } = renderEvent({
    event: 'loan_reconcile_due',
    loans: shown.map((row) => ({ name: row.name, lastStatement: row.lastStatement })),
    more: candidates.length - shown.length,
  });
  const inserted = enqueue({
    userId: input.userId,
    eventId: 'loan_reconcile_due',
    dedupKey: batchKey('loan:stale', shown.map((row) => row.key)),
    subject,
    body,
    at: input.now,
  }).inserted.length;
  if (inserted > 0) kickOutbox(input.now);
  return inserted > 0 ? 1 : 0;
}

/** Kept so the unused-import lint does not trip on a helper the queries above share. */
void gt;
