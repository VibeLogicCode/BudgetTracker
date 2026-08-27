import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { billInstallments, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, isIsoDate } from '@/lib/dates';
import { MIN_PURCHASE_DATE } from '@/lib/warranty/items';
import {
  INSTALLMENT_KIND_ERROR,
  installmentsAllowedForKind,
  type InstallmentState,
  type ItemKind,
} from '@/lib/warranty/constants';

/**
 * A bill's due-date schedule (spec 2026-08-24, ruling C3). SERVER-ONLY: this module imports
 * @/db, so it must never be imported by a client component -- the detail page takes
 * InstallmentRow[] as a PROP, and a `import type` is fine because it is erased. That is the same
 * Ruling P4 boundary constants.ts documents, seen from the other side.
 *
 * Clock-free in the project-wide sense (the rule src/lib/bills.ts's header states): `today` and
 * the window are always parameters, never `new Date()`. The one exception is the OPTIONAL `at`
 * on the two writers, which defaults to nowIso() the way every other writer in this codebase
 * does.
 */

/** The lookahead the DETAIL PAGE uses for its "Due soon" badge. The notification evaluator
 *  passes the user's own comingDueDays instead, deliberately: a reader's window is its own. */
export const INSTALLMENT_DUE_SOON_DAYS = 30;

export interface InstallmentTxn {
  id: number;
  date: string;
  description: string;
  amountCents: number;
}

export interface InstallmentRow {
  id: number;
  itemId: number;
  dueDate: string;
  amountCents: number;
  paidAt: string | null;
  paidTxnId: number | null;
  /** Only when paidTxnId is set: what the matched transaction actually was. Ruling C7 shows the
   *  difference between this amount and the installment's rather than suppressing the match. */
  paidTxn: InstallmentTxn | null;
  state: InstallmentState;
}

export interface UnpaidInstallment {
  installmentId: number;
  itemId: number;
  itemName: string;
  ownerUserId: number;
  dueDate: string;
  amountCents: number;
  overdue: boolean;
}

/**
 * DERIVED, never stored: paid_at wins; else strictly before today is overdue; else on or before
 * today + dueSoonDays is due soon; else scheduled. Both boundaries are inclusive on the near
 * side -- an installment due TODAY is due soon, not overdue -- because a bill due today has not
 * been missed yet.
 */
export function installmentStateFor(
  dueDate: string,
  paidAt: string | null,
  today: string,
  dueSoonDays: number,
): InstallmentState {
  if (paidAt !== null) return 'paid';
  if (dueDate < today) return 'overdue';
  if (dueDate <= addDaysIso(today, dueSoonDays)) return 'due_soon';
  return 'scheduled';
}

function kindOfItem(itemId: number): ItemKind {
  // LEFT join, then normalise: an untyped item is 'warranty' everywhere else in this codebase
  // (see toItemRow in items.ts), and an item that does not exist at all is equally not a bill.
  const row = getDb()
    .select({ kind: warrantyItemTypes.kind })
    .from(warrantyItems)
    .leftJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(eq(warrantyItems.id, itemId))
    .get();
  return (row?.kind ?? 'warranty') as ItemKind;
}

/** due_date ASC, id ASC. The total order every other function in this file relies on. */
export function listInstallments(itemId: number, today: string, dueSoonDays: number): InstallmentRow[] {
  const rows = getDb()
    .select({
      id: billInstallments.id,
      itemId: billInstallments.itemId,
      dueDate: billInstallments.dueDate,
      amountCents: billInstallments.amountCents,
      paidAt: billInstallments.paidAt,
      paidTxnId: billInstallments.paidTxnId,
      txnDate: transactions.date,
      txnRaw: transactions.rawDescription,
      txnDisplay: transactions.displayDescription,
      txnAmountCents: transactions.amountCents,
    })
    .from(billInstallments)
    .leftJoin(transactions, eq(transactions.id, billInstallments.paidTxnId))
    .where(eq(billInstallments.itemId, itemId))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    paidAt: row.paidAt,
    paidTxnId: row.paidTxnId,
    paidTxn:
      row.paidTxnId === null || row.txnDate === null
        ? null
        : {
            id: row.paidTxnId,
            date: row.txnDate,
            // Same precedence displayNameOf() uses on the transactions page: a renamed
            // transaction shows the name a person gave it.
            description: row.txnDisplay ?? row.txnRaw ?? '',
            amountCents: row.txnAmountCents ?? 0,
          },
    state: installmentStateFor(row.dueDate, row.paidAt, today, dueSoonDays),
  }));
}

/**
 * Returns the new row's id.
 *
 * The kind assertion is HERE, in the data layer, not only in the action -- the same argument
 * assertBillingMatchesKind() makes about createWarrantyItem staying correct for every caller.
 * The three CHECK constraints in drizzle/0011 are the backstop underneath these three refusals,
 * not a substitute for them: a CHECK cannot see across to warranty_item_types.kind.
 *
 * A due date in the PAST is allowed on purpose. A household enters a bill it is already behind
 * on, and that is exactly the case the overdue state exists to surface. MIN_PURCHASE_DATE's
 * 1970-01-01 floor still applies, because a date below it is a typo rather than a history.
 */
export function addInstallment(input: {
  itemId: number;
  dueDate: string;
  amountCents: number;
  at?: string;
}): number {
  if (!installmentsAllowedForKind(kindOfItem(input.itemId))) throw new Error(INSTALLMENT_KIND_ERROR);
  if (!isIsoDate(input.dueDate)) throw new Error('Due date must be YYYY-MM-DD');
  if (input.dueDate < MIN_PURCHASE_DATE) throw new Error('Due date is before 1970-01-01');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('Amount must be more than zero.');
  }
  const row = getDb()
    .insert(billInstallments)
    .values({
      itemId: input.itemId,
      dueDate: input.dueDate,
      amountCents: input.amountCents,
      paidAt: null,
      paidTxnId: null,
      createdAt: input.at ?? nowIso(),
    })
    .returning({ id: billInstallments.id })
    .get();
  return row.id;
}

/**
 * Ruling B7: NO kind assertion. A gate decides what a form offers, never what it may hide, and
 * removing a stored row must stay possible after a type's kind has been flipped away from bill
 * -- otherwise ruling B6's "kept, never deleted" rows would be unreachable as well as invisible.
 */
export function removeInstallment(id: number): boolean {
  return getDb().delete(billInstallments).where(eq(billInstallments.id, id)).run().changes > 0;
}

/**
 * Manual mark-paid: paid_at is set and paid_txn_id is left NULL, which is what "a person marked
 * this" MEANS in this schema (ruling B13).
 *
 * Idempotent, and the `paid_at IS NULL` guard is why: two people marking the same installment
 * make the second UPDATE a no-op, and the desired state still holds, so this reports true. It
 * returns false only when the row is genuinely not there -- the case the action turns into
 * "That installment no longer exists."
 */
export function markInstallmentPaid(id: number, at: string = nowIso()): boolean {
  const db = getDb();
  const changed = db
    .update(billInstallments)
    .set({ paidAt: at })
    .where(and(eq(billInstallments.id, id), isNull(billInstallments.paidAt)))
    .run().changes;
  if (changed > 0) return true;
  return db.select({ id: billInstallments.id }).from(billInstallments).where(eq(billInstallments.id, id)).get() !== undefined;
}

/** Clears BOTH columns -- unmarking a rule-marked row also drops the link, because a paid_txn_id
 *  on an unpaid row is exactly what drizzle/0011's third CHECK forbids. */
export function unmarkInstallmentPaid(id: number): boolean {
  return (
    getDb()
      .update(billInstallments)
      .set({ paidAt: null, paidTxnId: null })
      .where(eq(billInstallments.id, id))
      .run().changes > 0
  );
}

/**
 * The reader ruling C6 needs: unpaid rows on BILL-KIND items, joined to their item's name and
 * owner. Ordered due_date ASC, id ASC, so overdue rows sort ahead of upcoming ones with no
 * second sort key.
 *
 * MUST-6.11's ownership rule needs no new column: an installment's owner is its item's
 * owner_user_id. Omitting ownerUserId spans the whole household, which is what the dashboard
 * card wants (a bill is not attributed to one person the way a transaction is).
 */
export function unpaidInstallments(input: {
  today: string;
  windowEnd: string;
  includeOverdue: boolean;
  ownerUserId?: number;
}): UnpaidInstallment[] {
  const conditions = [
    isNull(billInstallments.paidAt),
    eq(warrantyItemTypes.kind, 'bill'),
    lte(billInstallments.dueDate, input.windowEnd),
  ];
  if (!input.includeOverdue) conditions.push(gte(billInstallments.dueDate, input.today));
  if (input.ownerUserId !== undefined) conditions.push(eq(warrantyItems.ownerUserId, input.ownerUserId));

  return getDb()
    .select({
      installmentId: billInstallments.id,
      itemId: warrantyItems.id,
      itemName: warrantyItems.name,
      ownerUserId: warrantyItems.ownerUserId,
      dueDate: billInstallments.dueDate,
      amountCents: billInstallments.amountCents,
    })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    // INNER, not LEFT: an untyped item normalises to kind 'warranty' everywhere else and can
    // never be a bill, so it is correctly dropped by requiring a matching type row at all --
    // the same argument upcomingBills() already makes for its own join.
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(...conditions))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all()
    .map((row) => ({ ...row, overdue: row.dueDate < input.today }));
}
