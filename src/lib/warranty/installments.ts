import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { billInstallments, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, isIsoDate } from '@/lib/dates';
import { paymentLinksForTransaction } from '@/lib/loans';
import { createManualTransaction } from '@/lib/transactions';
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
 * on the three writers (addInstallment, markInstallmentPaid, and -- as of v1.12.1's suppression
 * stamp, item BA / MON-3 -- unmarkInstallmentPaid too), which defaults to nowIso() the way every
 * other writer in this codebase does.
 *
 * THREE READERS, THREE DELIBERATELY DIFFERENT KIND FILTERS. This asymmetry is the feature, not
 * an inconsistency to clean up:
 *   - listInstallments() (below) applies NO kind filter at all. Ruling B7: a gate decides what a
 *     form offers, never what it may hide, and a row must stay reachable on the item's own page
 *     after its type's kind is flipped away from bill, or ruling B6's "kept, never deleted" rows
 *     would be unreachable as well as invisible.
 *   - unpaidInstallments() (below) INNER JOINs warrantyItemTypes on kind = 'bill'. Ruling B6:
 *     once a type stops being kind bill, its items' installments go quiet on the dashboard and in
 *     notifications -- a reader that is no longer offering the bill UI has no business nagging
 *     about it either.
 *   - the payment matcher's activeRules() (src/lib/loans.ts) admits kind IN ('loan', 'bill'), but
 *     makes the non-null-balance requirement LOAN-only (ruling B10/B11). A bill has no balance to
 *     move, so inheriting the loan dormancy condition unchanged would make every bill rule save
 *     successfully and then never fire -- silently, since nothing about creating the rule would
 *     complain.
 *
 * Tightening the first (adding a kind filter to listInstallments) turns a kind flip into data
 * loss: a person could no longer even see, let alone recover, installments they typed while the
 * type was still kind bill. Loosening the second (dropping unpaidInstallments' kind filter, or
 * giving it a bill-shaped balance requirement copied from the loan side) turns it into phantom
 * nagging: reminders for installments whose item no longer presents as a bill anywhere a person
 * would look, or rules that appear configured but can never fire.
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
 * removing a stored row must stay possible after a type's kind has been flipped away from bill --
 * otherwise ruling B6's "kept, never deleted" rows would be unreachable as well as invisible.
 *
 * v1.12.1 (item BA / MON-3): a PAID or LINKED row is refused, though. This was the second half of
 * MON-3 -- deleting a paid, transaction-linked installment discarded the payment record AND
 * re-opened that transaction to the matcher, with no guard and no confirmation. Un-mark first, then
 * remove: two deliberate acts for two different decisions. Returns false, which the detail page
 * already surfaces as an error line.
 */
export function removeInstallment(id: number): boolean {
  return (
    getDb()
      .delete(billInstallments)
      .where(and(eq(billInstallments.id, id), isNull(billInstallments.paidAt), isNull(billInstallments.paidTxnId)))
      .run().changes > 0
  );
}

/**
 * Manual mark-paid: paid_at is set and paid_txn_id is left NULL, which is what "a person marked
 * this" MEANS in this schema (ruling B13).
 *
 * Idempotent, and the `paid_at IS NULL` guard is why: two people marking the same installment
 * make the second UPDATE a no-op, and the desired state still holds, so this reports true. It
 * returns false only when the row is genuinely not there -- the case the action turns into
 * "That installment no longer exists."
 *
 * v1.12.1 (item BA / MON-3): this also CLEARS unlinked_at. A hand mark is the deliberate act the
 * suppression exists to protect, so it must be able to undo one -- otherwise un-marking a row once
 * would make it permanently unmarkable-again by a rule AND leave a person unable to say "actually,
 * this one is paid".
 */
export function markInstallmentPaid(id: number, at: string = nowIso()): boolean {
  const db = getDb();
  const changed = db
    .update(billInstallments)
    .set({ paidAt: at, unlinkedAt: null })
    .where(and(eq(billInstallments.id, id), isNull(billInstallments.paidAt)))
    .run().changes;
  if (changed > 0) return true;
  return db.select({ id: billInstallments.id }).from(billInstallments).where(eq(billInstallments.id, id)).get() !== undefined;
}

/**
 * Clears BOTH columns -- unmarking a rule-marked row also drops the link, because a paid_txn_id on
 * an unpaid row is exactly what drizzle/0011's third CHECK forbids.
 *
 * v1.12.1 (item BA / MON-3, ruling P1): and stamps unlinked_at, which is the whole fix. paid_txn_id
 * was the ONLY record that a transaction had ever been consumed by a bill -- alreadyLinked() reads
 * exactly that column -- so clearing it made the transaction a fresh matcher candidate again, and
 * confirmCategory calls applyPaymentMatchers on BOTH of its exits, including the "already confirmed
 * to the same category, nothing to retrain" fast path. Re-picking the same category on
 * /transactions was therefore enough to silently re-mark the row the person had just un-marked, and
 * no UI action could fix it.
 */
export function unmarkInstallmentPaid(id: number, at: string = nowIso()): boolean {
  return (
    getDb()
      .update(billInstallments)
      .set({ paidAt: null, paidTxnId: null, unlinkedAt: at })
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

export type RecordPaymentResult =
  | { ok: true; transactionId: number; installmentId: number }
  | { ok: false; reason: 'gone' | 'already_paid' | 'no_account' | 'linked_elsewhere' };

/**
 * The ownership answer AND the revalidate path, in one query. Ruling R3's check on the Record-payment
 * action (Task 11) needs the owner; its revalidatePath needs the item id; two lookups for two fields
 * of the same row is a round trip nobody needs.
 */
export function findInstallmentItem(installmentId: number): { itemId: number; ownerUserId: number } | null {
  const row = getDb()
    .select({ itemId: warrantyItems.id, ownerUserId: warrantyItems.ownerUserId })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    .where(eq(billInstallments.id, installmentId))
    .get();
  return row ?? null;
}

/**
 * Internal control-flow signal only -- never exported, never reaches a caller. Thrown inside
 * recordInstallmentPayment's db.transaction() to unwind and roll back when a loan rule (not a bill
 * rule) has already claimed the new transaction; caught immediately below and turned into the typed
 * `linked_elsewhere` result.
 */
class LinkedElsewhereRollback extends Error {}

/**
 * v1.13.0 ruling R8: the bridge from a bill that is due to a transaction that happened. Not a
 * scheduler -- a person presses this after the money actually moved, so the app never invents a
 * transaction the bank never made.
 *
 * ONE-LINK-PER-TRANSACTION IS STRUCTURAL HERE, NOT CHECKED. The transaction is created inside this
 * call, so it can carry no prior loan_payments or bill_installments link, and
 * bill_installments_txn_uq (drizzle/0011) makes a second installment against that id impossible for
 * ever, whatever re-runs.
 *
 * THE ORDER MATTERS, and so does what runs AFTER createManualTransaction, not just that something
 * does. createManualTransaction runs applyPaymentMatchers on the new row (src/lib/transactions.ts),
 * and a merchant rule on this same bill matches on MERCHANT, not on installment id -- so with two or
 * more unpaid installments outstanding it can mark a DIFFERENT one than the row the person pressed
 * (the nearest-due one, per markEarliestUnpaid). Left alone, that is worse than a silent
 * disagreement: bill_installments_txn_uq is unique on paid_txn_id table-wide, so this function's own
 * targeted UPDATE would then collide with the matcher's row and throw a raw UNIQUE constraint error
 * instead of returning a typed result.
 *
 * Fix round 2 (reviewer finding): the person's explicit press is what "record payment" MEANS here,
 * so it wins over whatever the matcher guessed, every time. After createManualTransaction (still
 * inside the same db.transaction, so nothing here is visible until all of it commits):
 *   1. paymentLinksForTransaction(transactionId) answers the cross-kind question CHEAPLY (two
 *      COUNT(*)s, the same helper alreadyLinked()'s callers already share) -- ruling B11's
 *      exclusivity guarantees a loan rule and a bill rule cannot both have matched this same
 *      transaction, so links.loans > 0 here means a LOAN matcher took it, not a bill one. That is a
 *      genuine rule collision across kinds, not this function's problem to silently paper over, so
 *      it throws (rolling the whole transaction back -- the manual transaction row itself is
 *      undone, not just the installment) and reports linked_elsewhere.
 *   2. Otherwise, a direct lookup on bill_installments.paid_txn_id (unique, so at most one row) says
 *      whether a BILL rule marked this transaction, and if so, which installment:
 *        - no row: the matcher didn't touch this bill at all (no rule, or no match) -- proceed to
 *          the targeted mark exactly as before.
 *        - the SAME row the person pressed: the matcher already recorded exactly what was asked for.
 *          Nothing left to do; report ok with the row the matcher (not this function) marked.
 *        - a DIFFERENT row: the matcher guessed wrong. That row's paid_at/paid_txn_id are cleared --
 *          WITHOUT touching unlinked_at, because this is not a person's deliberate un-mark (the
 *          suppression unmarkInstallmentPaid protects against a rule re-marking); it must stay a
 *          perfectly ordinary unpaid row a rule can pick up again next time, on this transaction or
 *          the next. Then the targeted mark below runs exactly as before, now unobstructed.
 */
export function recordInstallmentPayment(input: {
  installmentId: number;
  accountId: number;
  userId: number;
  today: string;
}): RecordPaymentResult {
  const db = getDb();
  const target = db
    .select({
      id: billInstallments.id,
      itemId: billInstallments.itemId,
      amountCents: billInstallments.amountCents,
      paidAt: billInstallments.paidAt,
      itemName: warrantyItems.name,
      budgetCategoryId: warrantyItems.budgetCategoryId,
      ownerUserId: warrantyItems.ownerUserId,
    })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    .where(eq(billInstallments.id, input.installmentId))
    .get();

  if (target === undefined) return { ok: false, reason: 'gone' };
  if (target.paidAt !== null) return { ok: false, reason: 'already_paid' };
  if (!Number.isInteger(input.accountId) || input.accountId <= 0) return { ok: false, reason: 'no_account' };

  try {
    return db.transaction((tx) => {
      const transactionId = createManualTransaction({
        accountId: input.accountId,
        date: input.today,
        description: target.itemName,
        // A payment is money OUT. The installment's amount_cents CHECK guarantees it is positive.
        amountCents: -target.amountCents,
        categoryId: target.budgetCategoryId,
        attributedUserId: target.ownerUserId,
        notes: null,
        userId: input.userId,
      });

      const links = paymentLinksForTransaction(transactionId);
      // A loan rule took this transaction (ruling B11's exclusivity means a bill rule cannot have
      // matched it too) -- roll back rather than let the person's press double-count against a
      // loan's balance as well.
      if (links.loans > 0) throw new LinkedElsewhereRollback();

      if (links.bills > 0) {
        const linked = tx
          .select({ id: billInstallments.id })
          .from(billInstallments)
          .where(eq(billInstallments.paidTxnId, transactionId))
          .get();
        if (linked !== undefined && linked.id === input.installmentId) {
          // The matcher already marked exactly the row the person pressed for.
          return { ok: true, transactionId, installmentId: input.installmentId } as const;
        }
        if (linked !== undefined) {
          // The matcher guessed a different installment on the merchant match. Clear it -- but
          // NOT unlinked_at, which is reserved for a person's own un-mark (see this module's other
          // v1.12.1 docblocks) -- so it stays an ordinary unpaid row a rule can pick up again.
          tx.update(billInstallments)
            .set({ paidAt: null, paidTxnId: null })
            .where(eq(billInstallments.id, linked.id))
            .run();
        }
      }

      const marked = tx
        .update(billInstallments)
        .set({ paidAt: nowIso(), paidTxnId: transactionId })
        .where(and(eq(billInstallments.id, input.installmentId), isNull(billInstallments.paidAt)))
        .run();

      if (marked.changes === 0) return { ok: false, reason: 'already_paid' } as const;
      return { ok: true, transactionId, installmentId: input.installmentId } as const;
    });
  } catch (error) {
    if (error instanceof LinkedElsewhereRollback) return { ok: false, reason: 'linked_elsewhere' };
    throw error;
  }
}
