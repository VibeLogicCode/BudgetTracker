import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { billInstallments, loanMatcherRules, loanPayments, transactions, users, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { canActOnOwner, ownerScope, NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { addDaysIso, addMonths, addMonthsClamped, daysBetweenIso, monthEnd, monthOf, monthRange, todayIso } from '@/lib/dates';
import type { RateVerdict } from '@/lib/notify/ratelimit';
import { meanCents } from '@/lib/predict/stats';
import { getTransaction } from '@/lib/transactions';
import {
  isLoanRepayment,
  loanSignedDelta,
  LOAN_ALREADY_LINKED_ERROR,
  LOAN_LENT_FIRST_ENTRY_ERROR,
  type BillingCycle,
  type LoanDirection,
} from '@/lib/warranty/constants';
import { createWarrantyItem, type WarrantyInput } from '@/lib/warranty/items';
import { createItemType, listItemTypes } from '@/lib/warranty/types';

/**
 * Loan money-tracking (spec 2026-08-17 §13).
 *
 * MUST-13.1: interest_rate_bps is DISPLAY ONLY. Nothing in this file multiplies, accrues,
 * projects or amortises with it. Task 14 is expected to lock that in with its own grep-style
 * invariant test, the same way tests/lib/loans/invariants.test.ts (added by Task 10's round-3
 * fix) locks in transactions.amount_cents' immutability.
 *
 * MUST-13.2: loan payments STAY in their spending category and in every budget. Nothing here
 * writes is_transfer, category_id or attributed_user_id, and nothing here touches the
 * `transactions` table at all. A car payment is money that left the household this month;
 * hiding it from the budget would make the budget wrong.
 */
export const MAX_RULES_PER_LOAN = 5;
export const LOAN_BACKFILL_DAYS = 365;
export const LOAN_BACKFILL_MAX = 500;

/**
 * Ruling R2's window, in one place. A payment further than this from every unpaid installment is
 * not evidence about which one it paid, so the earliest-unpaid fallback (the v1.12.0 behaviour)
 * takes over rather than the code guessing.
 */
export const INSTALLMENT_MATCH_WINDOW_DAYS = 45;

/** F6 fix-round: the repo's chunking convention (src/lib/import/commit.ts, categorize/engine.ts)
 * applied to the id lists this file receives from callers, which are never capped in advance. */
const ID_CHUNK = 400;

function chunkIds(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) out.push(ids.slice(offset, offset + ID_CHUNK));
  return out;
}

/**
 * MUST-14.12 / MUST-14.13: the third in-memory bucket in the codebase (notify's, update's,
 * this one). They stay separate because their windows, scopes and reset semantics differ and
 * a shared abstraction over three call sites would be one abstraction and three special
 * cases. If a fourth appears, extract then.
 *
 * This is the ONE loan action that carries a limit: ordinary loan CRUD and assign/unassign
 * carry none, consistent with every existing warranty and transaction action. The backfill
 * is the only expensive one. It scans up to a year of transactions.
 */
export const BACKFILL_WINDOW_MS = 10 * 60_000;
export const BACKFILL_MAX_GLOBAL = 5;

let backfillClock: () => number = () => Date.now();
const backfillStamps: number[] = [];

export function setLoanRateLimitClockForTests(next: (() => number) | null): void {
  backfillClock = next ?? (() => Date.now());
}

export function resetLoanRateLimitsForTests(): void {
  backfillStamps.length = 0;
}

export function checkLoanBackfill(now: number = backfillClock()): RateVerdict {
  while (backfillStamps.length > 0 && (backfillStamps[0] as number) <= now - BACKFILL_WINDOW_MS) backfillStamps.shift();
  if (backfillStamps.length >= BACKFILL_MAX_GLOBAL) {
    const oldest = backfillStamps[0] ?? now;
    const waitMs = Math.max(0, oldest + BACKFILL_WINDOW_MS - now);
    return { allowed: false, retryAfterMinutes: Math.max(1, Math.ceil(waitMs / 60_000)) };
  }
  backfillStamps.push(now);
  return { allowed: true, retryAfterMinutes: 0 };
}

// ---------------------------------------------------------------- matcher rules

export interface LoanRule {
  id: number;
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  enabled: boolean;
}

export function listLoanRules(itemId: number): LoanRule[] {
  return getDb()
    .select({
      id: loanMatcherRules.id,
      itemId: loanMatcherRules.itemId,
      merchantContains: loanMatcherRules.merchantContains,
      accountId: loanMatcherRules.accountId,
      enabled: loanMatcherRules.enabled,
    })
    .from(loanMatcherRules)
    .where(eq(loanMatcherRules.itemId, itemId))
    .orderBy(asc(loanMatcherRules.id))
    .all();
}

/**
 * MUST-11.11: merchant_contains is stored UPPERCASED, because it is compared against
 * transactions.normalized_merchant and normalizeMerchant() uppercases. No lower() wrapper on
 * either side. (This is the same normalizer-casing trap the notify build hit in its R1
 * review finding; it is called out here so it is not hit twice.)
 *
 * MUST-11.12: MAX_RULES_PER_LOAN is enforced here as well as in the action, so a caller that
 * does not route through the action cannot exceed it either.
 */
export function saveLoanRule(input: {
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  enabled: boolean;
  at?: Date;
}): number {
  const at = nowIso(input.at ?? new Date());
  const merchant = input.merchantContains.trim().toUpperCase();
  if (merchant.length < 3) throw new Error('Use at least three characters, or this will match almost everything.');
  if (listLoanRules(input.itemId).length >= MAX_RULES_PER_LOAN) throw new Error('Five rules per loan is the limit.');
  const row = getDb()
    .insert(loanMatcherRules)
    .values({
      itemId: input.itemId,
      merchantContains: merchant,
      accountId: input.accountId,
      enabled: input.enabled,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: loanMatcherRules.id })
    .get();
  return row.id;
}

export function deleteLoanRule(id: number): boolean {
  return getDb().delete(loanMatcherRules).where(eq(loanMatcherRules.id, id)).run().changes > 0;
}

// ---------------------------------------------------------------- links

export interface LoanLink {
  id: number;
  txnId: number;
  itemId: number;
  itemName: string;
  amountCents: number;
  appliedCents: number;
  source: 'rule' | 'manual';
}

/** One query, served by loan_payments_txn_idx. Used by the transactions page. */
export function loanLinksForTransactions(txnIds: number[]): Map<number, LoanLink[]> {
  const out = new Map<number, LoanLink[]>();
  if (txnIds.length === 0) return out;
  const db = getDb();
  for (const chunk of chunkIds(txnIds)) {
    const rows = db
      .select({
        id: loanPayments.id,
        txnId: loanPayments.txnId,
        itemId: loanPayments.itemId,
        itemName: warrantyItems.name,
        amountCents: loanPayments.amountCents,
        appliedCents: loanPayments.appliedCents,
        source: loanPayments.source,
      })
      .from(loanPayments)
      .innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))
      .where(inArray(loanPayments.txnId, chunk))
      .orderBy(asc(loanPayments.id))
      .all();
    for (const row of rows) {
      const list = out.get(row.txnId) ?? [];
      list.push(row);
      out.set(row.txnId, list);
    }
  }
  return out;
}

interface ActiveRule {
  ruleId: number;
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  /** NULL for a bill, and for a loan whose balance was never anchored. */
  balanceCents: number | null;
  kind: 'loan' | 'bill';
  /** v1.14.0 (spec BU). 'owed' for every bill row -- a bill has no direction of its own, and
   *  loanFieldsAllowedForKind gates the other value to loan-kind items only (ruling P3). */
  direction: LoanDirection;
}

/**
 * Every ENABLED rule whose item is a loan-kind OR bill-kind item, in ONE query. This is the
 * dormancy bail: a household with neither pays one indexed read per import and nothing else
 * (AC5).
 *
 * v1.12.0: the balance requirement is a LOAN dormancy condition, not a general one. A bill has
 * no balance to move, so requiring a non-null one would make every bill rule permanently inert
 * -- the rule would save, report success, and never fire.
 */
function activeRules(tx: ReturnType<typeof getDb>): ActiveRule[] {
  return tx
    .select({
      ruleId: loanMatcherRules.id,
      itemId: loanMatcherRules.itemId,
      merchantContains: loanMatcherRules.merchantContains,
      accountId: loanMatcherRules.accountId,
      balanceCents: sql<number | null>`${warrantyItems.currentBalanceCents}`,
      kind: sql<'loan' | 'bill'>`${warrantyItemTypes.kind}`,
      direction: warrantyItems.loanDirection,
    })
    .from(loanMatcherRules)
    .innerJoin(warrantyItems, eq(warrantyItems.id, loanMatcherRules.itemId))
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(
      and(
        eq(loanMatcherRules.enabled, true),
        inArray(warrantyItemTypes.kind, ['loan', 'bill']),
        sql`(${warrantyItemTypes.kind} = 'bill' OR ${warrantyItems.currentBalanceCents} is not null)`,
      ),
    )
    .orderBy(asc(loanMatcherRules.id))
    .all();
}

/**
 * MUST-11.15: the link row IS the guard. INSERT ... ON CONFLICT DO NOTHING, and the balance
 * move runs in the SAME statement sequence, conditional on changes > 0, so a crash between
 * "decide to apply" and "record that we applied" is impossible.
 *
 * F1 fix-round (sign-aware apply): `signedAmountCents` carries the transaction's real sign.
 * A NEGATIVE **signed delta in the loan's own frame** (see loanSignedDelta, v1.14.0 below) is a
 * REPAYMENT and DECREMENTS the balance, clamped at zero exactly as before
 * (MUST-11.14 / MUST-13.6). A POSITIVE one GROWS the balance by its full magnitude; there is no
 * ceiling to clamp against on that side.
 *
 * v1.14.0 (spec BU, ruling P4): `input.direction` re-expresses `signedAmountCents` into the
 * loan's own frame via `loanSignedDelta` before any of the above is decided. For an `owed` loan
 * (every loan before this release) `loanSignedDelta` is the identity, so this paragraph and
 * every line below it describe EXACTLY today's behaviour, unchanged. For a `lent` loan the frame
 * is flipped: money OUT (a negative transaction) GROWS what is owed to the household, and money
 * IN (a positive transaction) is a REPAYMENT that shrinks it.
 *
 * `applied_cents` always stores the UNSIGNED size of the move (never negative, so the
 * existing `applied_cents >= 0 AND applied_cents <= amount_cents` CHECK in drizzle/0007
 * needs no migration). The DIRECTION is therefore never read back off this row. It is
 * recovered at reversal time from the linked transaction's own (immutable) sign instead, by
 * `unassignTransactionFromLoan` and `reverseLoanLinksForTransactions` below. A payment
 * against a loan already at zero still produces a link row with applied_cents = 0: the
 * payment is recorded, the balance stays at zero, and nothing is silently swallowed.
 *
 * NEW-2 fix-round: `balanceCents` is `number | null` because `assignTransactionToLoan` can
 * target a loan whose balance is genuinely UNKNOWN (never anchored). An unknown balance
 * cannot be moved in either direction, so `applied` is forced to 0, recording the link (the
 * assignment itself is still real and still shown) without ever fabricating a move. Treating
 * null as 0 here was the exact bug: a disbursement against an unset balance would otherwise
 * record a phantom `applied_cents`, and a LATER unassign, after a person finally anchors the
 * balance, would subtract that phantom figure off a real number it had nothing to do with.
 *
 * Review round (Lane A, v1.14.0): returns BOTH `appliedCents` (unsigned, what's stored in
 * loan_payments.applied_cents) and `deltaCents` (the SIGNED move actually applied to the
 * balance, in the loan's own frame). `applyPaymentMatchers` and `backfillLoanRule` add
 * `deltaCents` straight onto their own running total instead of re-deriving the sign a second
 * time via `isLoanRepayment(direction, txn.amountCents)` -- this function already decided that
 * once, right here, and a caller re-deriving it is a second place that sign logic could drift
 * from this one. `assignTransactionToLoan` (which reports appliedCents unsigned) uses only the
 * other field.
 */
function link(
  tx: ReturnType<typeof getDb>,
  input: {
    txnId: number;
    itemId: number;
    signedAmountCents: number;
    balanceCents: number | null;
    source: 'rule' | 'manual';
    at: string;
    direction: LoanDirection;
  },
): { appliedCents: number; deltaCents: number } | null {
  const magnitude = Math.abs(input.signedAmountCents);
  // v1.14.0 (spec BU, ruling P4): the loan's own frame, not the account's. For an owed loan
  // loanSignedDelta is the identity and every line below is byte-for-byte what it was.
  const signed = loanSignedDelta(input.direction, input.signedAmountCents);
  const isRepayment = signed < 0;
  // Repayments clamp at zero; growth applies in full (no ceiling exists for how much can be
  // added back onto an outstanding balance) -- except when the balance is unknown, in which
  // case neither direction applies anything (NEW-2).
  const applied = input.balanceCents === null ? 0 : isRepayment ? Math.max(0, Math.min(magnitude, input.balanceCents)) : magnitude;
  const delta = isRepayment ? -applied : applied;
  const result = tx
    .insert(loanPayments)
    .values({
      txnId: input.txnId,
      itemId: input.itemId,
      amountCents: magnitude,
      appliedCents: applied,
      source: input.source,
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .run();
  if (result.changes === 0) return null;
  if (delta !== 0) {
    tx.update(warrantyItems)
      .set({ currentBalanceCents: sql`${warrantyItems.currentBalanceCents} + ${delta}` })
      // MUST-11.8: balance_updated_at is NOT touched. It is the human anchor.
      .where(eq(warrantyItems.id, input.itemId))
      .run();
  }
  return { appliedCents: applied, deltaCents: delta };
}

interface Candidate {
  id: number;
  accountId: number;
  normalizedMerchant: string;
  amountCents: number;
  isTransfer: boolean;
  /** v1.12.1 (item BD / MON-7, ruling R2): the bill branch needs the transaction's OWN date. */
  date: string;
}

function candidates(tx: ReturnType<typeof getDb>, txnIds: number[]): Candidate[] {
  const out: Candidate[] = [];
  for (const chunk of chunkIds(txnIds)) {
    out.push(
      ...tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          normalizedMerchant: transactions.normalizedMerchant,
          amountCents: transactions.amountCents,
          isTransfer: transactions.isTransfer,
          date: transactions.date,
        })
        .from(transactions)
        .where(inArray(transactions.id, chunk))
        .orderBy(asc(transactions.id))
        .all(),
    );
  }
  // NEW-6 fix-round: each chunk is sorted internally, but the CALLER's id list is chunked by
  // position, not by value, so ids above ID_CHUNK were no longer globally ascending once
  // concatenated. Restoring it here keeps "first rule by id wins" (MUST-13.4) and
  // "first match by date" style guarantees stable regardless of list size.
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * How many payment links, of each kind, already name this transaction.
 *
 * v1.12.1 (item T / MON-2, ruling P4). The union behind alreadyLinked() below is the rule path's
 * exclusivity guard -- "a loan and a bill whose rules both match one merchant string cannot both
 * take the payment" (MUST-13.4, ruling B11). The MANUAL assign path never had it:
 * assignTransactionToLoan read transactions and warranty_items and nothing else, so a transaction
 * the matcher had already used to mark an installment paid could be hand-assigned to a loan and
 * decrement its balance by the same money -- $1,200 of payment recorded as $2,400 of debt
 * reduction, with the action returning a plain "Assigned." The DB cannot catch it either:
 * bill_installments_txn_uq and loan_payments_txn_item_uq are each unique within one table and
 * nothing spans the two.
 */
export function paymentLinksForTransaction(txnId: number): { loans: number; bills: number } {
  const db = getDb();
  const loans = db
    .select({ n: sql<number>`count(*)` })
    .from(loanPayments)
    .where(eq(loanPayments.txnId, txnId))
    .get();
  const bills = db
    .select({ n: sql<number>`count(*)` })
    .from(billInstallments)
    .where(eq(billInstallments.paidTxnId, txnId))
    .get();
  return { loans: Number(loans?.n ?? 0), bills: Number(bills?.n ?? 0) };
}

/**
 * MUST-13.4, across both kinds (ruling B11): the union of loan_payments.txn_id and
 * bill_installments.paid_txn_id over the same chunked id set. A loan and a bill whose rules
 * both match one merchant string cannot both take the payment, and that is only expressible if
 * both branches read ONE set.
 */
function alreadyLinked(tx: ReturnType<typeof getDb>, txnIds: number[]): Set<number> {
  const out = new Set<number>();
  for (const chunk of chunkIds(txnIds)) {
    for (const row of tx.select({ txnId: loanPayments.txnId }).from(loanPayments).where(inArray(loanPayments.txnId, chunk)).all()) {
      out.add(row.txnId);
    }
    for (const row of tx
      .select({ txnId: billInstallments.paidTxnId })
      .from(billInstallments)
      .where(inArray(billInstallments.paidTxnId, chunk))
      .all()) {
      if (row.txnId !== null) out.add(row.txnId);
    }
  }
  return out;
}

/**
 * The bill arm of the rule path (ruling C7, amended by v1.12.1 ruling R2). Marks ONE unpaid
 * installment on this item and records which transaction paid it.
 *
 * WHICH one changed in v1.12.1 (item BD / MON-7). It used to be, always, the earliest unpaid, and
 * that is defensible right up until somebody forgets to mark one: from then on every payment is
 * recorded against the previous period's installment and the whole schedule is permanently offset
 * by one, compounding silently -- the Coming-up card shows September still due after September was
 * paid, and the March row shows a payment that arrived three months late. So: the unpaid
 * installment whose due_date is NEAREST this transaction's own date wins, when that distance is
 * within INSTALLMENT_MATCH_WINDOW_DAYS; otherwise the earliest unpaid, exactly as before. Ties go
 * to the earlier due date, because the candidate list is ordered due_date ASC, id ASC and the
 * comparison below is strict -- so the choice is total and deterministic even for two parcels
 * falling due on one day.
 *
 * THE AMOUNT IS STILL NOT COMPARED, deliberately, and R2 restates it. A tax bill arrives with
 * penalties, discounts and rounding, and refusing to match on a few dollars' difference would leave
 * the household with an installment that is paid and a reminder that says it is not. The
 * transaction is recorded so the difference is VISIBLE on the detail page instead of being decided
 * here.
 *
 * SUPPRESSION (item BA / MON-3) is checked against the NEAREST row, not against a pre-filtered
 * candidate list -- and that distinction is the fix for MON-3's actual loop. An installment a
 * person has deliberately un-marked (`unlinked_at` set) is read here alongside every other unpaid
 * row so its distance can still be compared, but if IT turns out to be the nearest -- the row this
 * transaction's own date is evidence for -- the match is DECLINED entirely rather than substituted
 * with a worse guess. Falling back to some other, farther installment would repeat the very
 * "wrong period" failure item BD exists to prevent, just one suppression later: the person told us
 * this transaction does not pay the installment closest to it, and picking a different, less
 * plausible one instead is not a correction, it is a second wrong guess. (`unlinked_at` only
 * excludes a row from being MARKED here, in the UPDATE below -- it never excludes a row from being
 * READ, or the nearest-row comparison above would be blind to the one row that matters.) Only when
 * the WINDOW itself rules out every unpaid row (the plain earliest-unpaid fallback, unchanged from
 * v1.12.0) does suppression instead simply skip a suppressed row in favour of the next earliest
 * unsuppressed one -- there the code was never claiming this transaction's date as evidence for
 * any particular installment, suppressed or not.
 *
 * `AND paid_at IS NULL` in the UPDATE, plus bill_installments_txn_uq (ruling B12), are together the
 * idempotency guard -- the same pairing loan_payments uses. A re-run cannot double-mark, and one
 * transaction can never mark two installments.
 *
 * Neither current_balance_cents nor balance_updated_at is touched: a bill has no balance, and
 * MUST-11.8's human anchor stays a loan concept.
 */
function markMatchingUnpaid(
  tx: ReturnType<typeof getDb>,
  input: { txnId: number; itemId: number; txnDate: string; at: string },
): boolean {
  const unpaid = tx
    .select({ id: billInstallments.id, dueDate: billInstallments.dueDate, unlinkedAt: billInstallments.unlinkedAt })
    .from(billInstallments)
    .where(and(eq(billInstallments.itemId, input.itemId), isNull(billInstallments.paidAt)))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all();
  // Nothing scheduled, or all paid: no link and no error. The transaction is a normal
  // transaction, the household sees it on /transactions, and nothing is fabricated.
  if (unpaid.length === 0) return false;

  let nearest = unpaid[0]!;
  let best = Math.abs(daysBetweenIso(nearest.dueDate, input.txnDate));
  for (const row of unpaid.slice(1)) {
    const distance = Math.abs(daysBetweenIso(row.dueDate, input.txnDate));
    // Strictly less than: a tie leaves the earlier due date in place.
    if (distance < best) {
      best = distance;
      nearest = row;
    }
  }

  let target: typeof nearest;
  if (best <= INSTALLMENT_MATCH_WINDOW_DAYS) {
    // The nearest row IS this transaction's date acting as evidence. A suppressed nearest row
    // means a person has already looked at exactly this pairing and said no; see the docblock.
    if (nearest.unlinkedAt !== null) return false;
    target = nearest;
  } else {
    // Nothing is close enough to BE evidence either way: the v1.12.0 fallback, minus any row a
    // person has deliberately suppressed.
    const fallback = unpaid.find((row) => row.unlinkedAt === null);
    if (fallback === undefined) return false;
    target = fallback;
  }

  const result = tx
    .update(billInstallments)
    .set({ paidAt: input.at, paidTxnId: input.txnId })
    .where(and(eq(billInstallments.id, target.id), isNull(billInstallments.paidAt)))
    .run();
  return result.changes > 0;
}

/**
 * MUST-13.3: the rule matcher, in one db.transaction.
 *
 * MUST-13.4 (one link per transaction, from the rule path): step 3's "already has any link"
 * check and step 4's "first rule by id wins" together guarantee the rule path creates at most
 * one link per transaction, EVER. Without it, two loans whose rules both match one merchant
 * string would each take the full payment off their balance and the household would appear
 * to have paid twice.
 *
 * MUST-13.5: this function NEVER throws into its caller. A loan-matching failure may not
 * break an import, a SimpleFIN sync, a manual entry or a category confirmation.
 *
 * F5 fix-round: the optional `report` out-param is how a caller learns the catch below fired,
 * without widening this function's own return type (still a plain `number`, unchanged for
 * the many call sites and tests that only care about the count). Only import/flow.ts and
 * simplefin/sync.ts pass one, to surface `loanMatchFailed` alongside `engineFailed`. The
 * other three call sites (createManualTransaction, confirmCategory) have nowhere spec'd for
 * that signal to go and don't need it.
 *
 * v1.12.0: this function matches BILLS too, which is why it is no longer called
 * applyLoanMatchers (ruling B10 -- there is no alias; a name that lies is worse than a rename).
 * The bill branch is inside the SAME db.transaction, the SAME dormancy bail and the SAME
 * try/catch, so MUST-13.5 (never throws into an import, a sync, a manual entry or a category
 * confirmation) holds for it unchanged.
 */
export function applyPaymentMatchers(txnIds: number[], at: Date = new Date(), report?: { failed: boolean }): number {
  if (txnIds.length === 0) return 0;
  try {
    const stamp = nowIso(at);
    return getDb().transaction((tx) => {
      const rules = activeRules(tx);
      if (rules.length === 0) return 0; // the loans-side dormancy bail
      const balances = new Map(rules.map((rule) => [rule.itemId, rule.balanceCents]));
      // v1.14.0 (spec BU, ruling P4): the running balance below moves the way the LOAN moves,
      // not the way the account does, so the sign flip needs each item's own direction on hand.
      const directions = new Map(rules.map((rule) => [rule.itemId, rule.direction]));
      const linked = alreadyLinked(tx, txnIds);

      let created = 0;
      for (const txn of candidates(tx, txnIds)) {
        if (txn.isTransfer) continue;
        // F1 ruling: rules auto-link PAYMENTS only. A positive transaction (a disbursement or
        // an adjustment) is manual-assign only (assignTransactionToLoan, below). A rule
        // silently deciding that an unrelated deposit is a loan disbursement would be a much
        // worse mistake than a household having to link one by hand.
        if (txn.amountCents >= 0) continue;
        if (linked.has(txn.id)) continue;

        const match = rules.find(
          (rule) =>
            txn.normalizedMerchant.includes(rule.merchantContains) &&
            (rule.accountId === null || rule.accountId === txn.accountId),
        );
        if (match === undefined) continue;

        if (match.kind === 'bill') {
          if (!markMatchingUnpaid(tx, { txnId: txn.id, itemId: match.itemId, txnDate: txn.date, at: stamp })) continue;
          linked.add(txn.id);
          created += 1;
          continue;
        }

        const direction = directions.get(match.itemId) ?? 'owed';
        const result = link(tx, {
          txnId: txn.id,
          itemId: match.itemId,
          signedAmountCents: txn.amountCents,
          balanceCents: balances.get(match.itemId) ?? 0,
          source: 'rule',
          at: stamp,
          direction,
        });
        if (result === null) continue;
        // Review round (Lane A): link() already decided the sign once (deltaCents, in the
        // loan's own frame) -- add THAT straight to the running total instead of re-deriving
        // it here a second time. A second place computing the same sign is a second place it
        // could drift from the first, silently.
        balances.set(match.itemId, (balances.get(match.itemId) ?? 0) + result.deltaCents);
        linked.add(txn.id);
        created += 1;
      }
      return created;
    });
  } catch (error) {
    console.error('[loans] matcher failed', error);
    if (report) report.failed = true;
    return 0;
  }
}

/**
 * MUST-13.9 / MUST-13.10: the opt-in historical pass. Scans transactions with
 * date >= addDaysIso(today, -LOAN_BACKFILL_DAYS) (served by transactions_date_idx), applies
 * the same matching and clamping rules, and stops after LOAN_BACKFILL_MAX links. One
 * transaction, and it reports both the count and the total applied so a mistake is visible
 * immediately rather than discovered a month later.
 */
export function backfillLoanRule(
  ruleId: number,
  opts: { days?: number; max?: number; at?: Date } = {},
): { linked: number; appliedCents: number } {
  const at = opts.at ?? new Date();
  const since = addDaysIso(todayIso(at), -(opts.days ?? LOAN_BACKFILL_DAYS));
  const cap = opts.max ?? LOAN_BACKFILL_MAX;
  try {
    const stamp = nowIso(at);
    return getDb().transaction((tx) => {
      // v1.12.0: backfill stays loan-only (design doc, Component 5) -- a bill ruleId is simply
      // not found here, same "no link, no error" shape as every other dormant-rule case.
      const rule = activeRules(tx).find((candidate) => candidate.ruleId === ruleId && candidate.kind === 'loan');
      if (rule === undefined) return { linked: 0, appliedCents: 0 };
      // activeRules' WHERE clause requires a non-null balance for every loan-kind row it
      // returns, so this is never actually null; the fallback only satisfies the type after
      // ActiveRule.balanceCents was widened to number | null for the bill branch.
      const anchoredBalance = rule.balanceCents ?? 0;

      const rows = tx
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          amountCents: transactions.amountCents,
        })
        .from(transactions)
        .where(
          and(
            gte(transactions.date, since),
            eq(transactions.isTransfer, false),
            sql`${transactions.amountCents} < 0`,
            sql`instr(${transactions.normalizedMerchant}, ${rule.merchantContains}) > 0`,
            rule.accountId === null ? sql`1 = 1` : eq(transactions.accountId, rule.accountId),
            sql`not exists (select 1 from ${loanPayments} lp where lp.txn_id = ${transactions.id})`,
          ),
        )
        .orderBy(asc(transactions.date), asc(transactions.id))
        .limit(cap)
        .all();

      let balance = anchoredBalance;
      let linked = 0;
      let appliedTotal = 0;
      for (const row of rows) {
        // The query above already filters to amount_cents < 0 (an outgoing transaction, same
        // rule as applyPaymentMatchers -- ruling P8), so row.amountCents is always negative
        // here. Ruling P4: pass the loan's OWN direction through link(), and move the running
        // balance the way the loan moves, not the way the account does.
        //
        // Review round (Lane A): `balance` is advanced by link()'s own returned deltaCents,
        // the SAME sign decision applyPaymentMatchers now consumes, rather than this loop
        // re-deriving isLoanRepayment(rule.direction, row.amountCents) a second time.
        const result = link(tx, {
          txnId: row.id,
          itemId: rule.itemId,
          signedAmountCents: row.amountCents,
          balanceCents: balance,
          source: 'rule',
          at: stamp,
          direction: rule.direction,
        });
        if (result === null) continue;
        balance += result.deltaCents;
        appliedTotal += result.appliedCents;
        linked += 1;
      }
      return { linked, appliedCents: appliedTotal };
    });
  } catch (error) {
    console.error('[loans] backfill failed', error);
    return { linked: 0, appliedCents: 0 };
  }
}

/**
 * MUST-13.11: the same insert-and-decrement as the rule path, with source 'manual' and two
 * differences: it does NOT skip a transaction that already has a link to a DIFFERENT loan
 * (MUST-11.16: a combined payment is legitimate), and it does NOT require the transaction
 * to be negative, because a household may want a loan disbursement or an adjustment on the
 * record. It still refuses a transaction already linked to THIS loan; the unique index makes
 * that a no-op, reported as linked: false.
 */
export function assignTransactionToLoan(input: { txnId: number; itemId: number; at?: Date }): {
  linked: boolean;
  appliedCents: number;
} {
  const stamp = nowIso(input.at ?? new Date());
  return getDb().transaction((tx) => {
    const txn = tx
      .select({ amountCents: transactions.amountCents })
      .from(transactions)
      .where(eq(transactions.id, input.txnId))
      .get();
    if (!txn) throw new Error('That transaction no longer exists.');

    const item = tx
      .select({ balance: warrantyItems.currentBalanceCents, direction: warrantyItems.loanDirection })
      .from(warrantyItems)
      .where(eq(warrantyItems.id, input.itemId))
      .get();
    if (!item) throw new Error('That loan no longer exists.');

    // v1.12.1 (item T / MON-2, ruling P4). Ruling P4 chose the refusal over the weaker option of
    // feeding the bill leg into the over-link WARNING: the rule path already refuses this exact
    // situation, and a warning that appears after the balance has already moved is not the same
    // guarantee. assignToLoanAction's existing generic `catch (error) { return { error:
    // error.message } }` (src/app/(app)/transactions/actions.ts) already surfaces this without any
    // change there. MUST-11.16 is untouched: a transaction may still be assigned to a SECOND loan,
    // because a combined payment is legitimate. Only the cross-table case is refused.
    if (paymentLinksForTransaction(input.txnId).bills > 0) {
      throw new Error('That transaction already pays a bill installment. Unmark that installment first.');
    }

    if (txn.amountCents === 0) throw new Error('A zero-amount transaction cannot be a loan payment.');
    // F1 ruling: manual assign supports BOTH signs. A negative txn decrements the balance
    // (a payment), a positive one increments it (a disbursement or an adjustment) -- for an
    // OWED loan. v1.14.0 (ruling P8): this is the ONLY path an incoming repayment on a LENT
    // loan can take today -- applyPaymentMatchers' rules only ever match outgoing money.
    // NEW-2 fix-round: item.balance is passed through UNCOALESCED -- `?? 0` here used to
    // treat "unknown balance" as "zero balance", see link()'s docblock.
    const result = link(tx, {
      txnId: input.txnId,
      itemId: input.itemId,
      signedAmountCents: txn.amountCents,
      balanceCents: item.balance,
      source: 'manual',
      at: stamp,
      direction: item.direction,
    });
    return result === null ? { linked: false, appliedCents: 0 } : { linked: true, appliedCents: result.appliedCents };
  });
}

export interface NewLoanFromTransaction {
  txnId: number;
  name: string;
  direction: LoanDirection;
  at?: Date;
}

export interface NewLoanResult {
  itemId: number;
  name: string;
  direction: LoanDirection;
  /** Unsigned, exactly as assignTransactionToLoan reports it. */
  appliedCents: number;
  /** The balance after the assign: |txn.amountCents| in every accepted case (ruling A3). */
  balanceAfterCents: number;
}

/** Ruling A6: the first `kind: 'loan'` type in listItemTypes()'s own order (name collate
 *  nocase) -- the exact order the New item form's dropdown renders. No second `order by`. */
function firstLoanTypeId(): number | null {
  return listItemTypes().find((type) => type.kind === 'loan')?.id ?? null;
}

/**
 * Addendum A. Creates a loan item and assigns `txnId` as its first entry, in ONE db transaction
 * (ruling A4). Throws -- never returns an error shape -- so the action's existing catch surfaces
 * every refusal the same way assignToLoanAction already surfaces assignTransactionToLoan's.
 *
 * `viewer` is REQUIRED (ruling A12) and is the only source of the new item's owner_user_id
 * (ruling A10): a self viewer's own id, otherwise the transaction's attributed_user_id falling
 * back to the viewer's own.
 */
export function createLoanFromTransaction(input: NewLoanFromTransaction, viewer: Viewer): NewLoanResult {
  const at = input.at ?? new Date();
  const stamp = nowIso(at);
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Give the loan a name.');

  const txn = getTransaction(input.txnId, viewer);
  if (txn === null) throw new Error('That transaction no longer exists.');
  // Ruling A10: a self viewer's loan is theirs, full stop; a household viewer's follows the row's
  // attribution and falls back to their own id. canActOnOwner then refuses a member acting on
  // somebody else's row, exactly as warranties/actions.ts does.
  const ownerUserId = ownerScope(viewer) === null ? (txn.attributedUserId ?? viewer.id) : viewer.id;
  if (!canActOnOwner(ownerUserId, viewer)) throw new Error(NOT_YOURS_ERROR);

  // Ruling A2 + P4: for a non-'owed' loan, "the first entry is a repayment" and "the money came
  // IN" are the same statement -- said once, through the helper that owns the flip, so the other
  // direction's value is never spelled out in this file.
  if (input.direction !== 'owed' && isLoanRepayment(input.direction, txn.amountCents)) {
    throw new Error(LOAN_LENT_FIRST_ENTRY_ERROR);
  }
  // Ruling A7: the double-submit guard.
  if (paymentLinksForTransaction(input.txnId).loans > 0) throw new Error(LOAN_ALREADY_LINKED_ERROR);

  const magnitude = Math.abs(txn.amountCents);
  // Ruling A3: seed = target - delta. link() is still the only code that moves the balance.
  const seedCents = isLoanRepayment(input.direction, txn.amountCents) ? magnitude * 2 : 0;

  return getDb().transaction((): NewLoanResult => {
    const typeId = firstLoanTypeId() ?? createItemType('Loan', 'loan').id; // rulings A5, A6
    const itemId = createWarrantyItem(
      {
        name,
        vendor: null,
        model: null,
        serial: null,
        purchaseDate: txn.date,
        warrantyMonths: null,
        isLifetime: false,
        priceCents: null,
        ownerUserId,
        transactionId: input.txnId,
        typeId,
        notes: null,
        currentBalanceCents: seedCents,
        balanceUpdatedAt: stamp, // MUST-11.7: both, or neither
        loanDirection: input.direction,
      } satisfies WarrantyInput,
      [],
      stamp,
    );
    const result = assignTransactionToLoan({ txnId: input.txnId, itemId, at });
    return {
      itemId,
      name,
      direction: input.direction,
      appliedCents: result.appliedCents,
      balanceAfterCents:
        seedCents + (isLoanRepayment(input.direction, txn.amountCents) ? -result.appliedCents : result.appliedCents),
    };
  });
}

/**
 * MUST-13.12: deletes the link row and restores current_balance_cents in the SAME
 * transaction. Neither operation touches balance_updated_at (MUST-11.8).
 *
 * F1 fix-round: undoes the SIGNED delta `link()` applied, recovered from the linked
 * transaction's own (immutable) sign, not from this row. A payment link (a decrement) is
 * restored by adding applied_cents back; a disbursement link (an increment) is restored by
 * subtracting it back.
 *
 * F2 fix-round: an UNKNOWN balance must stay unknown. The old `coalesce(..., 0)` fabricated
 * a balance out of NULL the moment any link was reversed; the `is not null` guard instead
 * makes the update match zero rows when the balance is already unknown, same as every other
 * read here treating NULL as "we don't track this loan's balance", not "it is zero".
 *
 * NEW-1 fix-round: the restore is clamped at zero (`max(0, ...)`), the same inexactness trade
 * the forward payment clamp already makes. Two links against one loan do not commute when the
 * balance has moved in between (a disbursement followed by a payment that clamped can leave
 * less room than the disbursement's own applied_cents), so undoing just one of them in
 * isolation can ask for a balance below zero, which used to hit the `current_balance_cents
 * >= 0` CHECK and throw a raw SqliteError instead of ever reaching a state a person could see.
 * Clamping trades perfect reconstruction for "never crash, never go negative", which is the
 * same trade every other clamp in this file already makes.
 */
export function unassignTransactionFromLoan(input: { txnId: number; itemId: number }): boolean {
  return getDb().transaction((tx) => {
    const row = tx
      .select({
        appliedCents: loanPayments.appliedCents,
        txnAmountCents: transactions.amountCents,
        direction: warrantyItems.loanDirection,
      })
      .from(loanPayments)
      .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
      .innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .get();
    if (!row) return false;
    tx.delete(loanPayments)
      .where(and(eq(loanPayments.txnId, input.txnId), eq(loanPayments.itemId, input.itemId)))
      .run();
    if (row.appliedCents > 0) {
      // v1.14.0 (ruling P4): recovered from the loan's own frame, not the account's.
      const restore = isLoanRepayment(row.direction, row.txnAmountCents) ? row.appliedCents : -row.appliedCents;
      tx.update(warrantyItems)
        .set({ currentBalanceCents: sql`max(0, ${warrantyItems.currentBalanceCents} + ${restore})` })
        .where(and(eq(warrantyItems.id, input.itemId), sql`${warrantyItems.currentBalanceCents} is not null`))
        .run();
    }
    return true;
  });
}

/**
 * MUST-13.14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
 *
 * The ON DELETE CASCADE on loan_payments.txn_id would remove the rows anyway, but a cascade
 * cannot restore a balance, so the explicit reversal must run first. Returns rows reversed.
 *
 * F1 fix-round: joins back to the (still-existing, not-yet-deleted) transaction to recover
 * each link's sign, same as unassignTransactionFromLoan, and sums SIGNED restores per item
 * before applying. A batch can legitimately reverse a payment and a disbursement on the
 * same loan in one undo.
 *
 * F2 fix-round: same "don't fabricate a balance out of NULL" guard as unassign.
 *
 * NEW-1 fix-round: same zero-clamp as unassign, and for the same reason it matters MORE
 * here: this runs inside undoImport's own transaction, and an uncaught CHECK-constraint
 * SqliteError would abort that ENTIRE transaction, rolling back the delete of every OTHER
 * sole transaction the undo was supposed to remove, not just this loan's. Clamping makes
 * that abort structurally impossible rather than merely unlikely.
 */
export function reverseLoanLinksForTransactions(txnIds: number[]): number {
  if (txnIds.length === 0) return 0;
  const db = getDb();
  const rows: { itemId: number; appliedCents: number; txnAmountCents: number; direction: LoanDirection }[] = [];
  for (const chunk of chunkIds(txnIds)) {
    rows.push(
      ...db
        .select({
          itemId: loanPayments.itemId,
          appliedCents: loanPayments.appliedCents,
          txnAmountCents: transactions.amountCents,
          direction: warrantyItems.loanDirection,
        })
        .from(loanPayments)
        .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
        .innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))
        .where(inArray(loanPayments.txnId, chunk))
        .all(),
    );
  }
  if (rows.length === 0) return 0;

  const byItem = new Map<number, number>();
  for (const row of rows) {
    // v1.14.0 (ruling P4): recovered from the loan's own frame, not the account's.
    const restore = isLoanRepayment(row.direction, row.txnAmountCents) ? row.appliedCents : -row.appliedCents;
    byItem.set(row.itemId, (byItem.get(row.itemId) ?? 0) + restore);
  }
  for (const [itemId, restore] of byItem) {
    if (restore === 0) continue;
    db.update(warrantyItems)
      .set({ currentBalanceCents: sql`max(0, ${warrantyItems.currentBalanceCents} + ${restore})` })
      .where(and(eq(warrantyItems.id, itemId), sql`${warrantyItems.currentBalanceCents} is not null`))
      .run();
  }
  for (const chunk of chunkIds(txnIds)) {
    db.delete(loanPayments).where(inArray(loanPayments.txnId, chunk)).run();
  }
  return rows.length;
}

/**
 * Ruling B14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
 *
 * The ON DELETE SET NULL on paid_txn_id would drop the link anyway -- but a cascade cannot
 * restore paid_at, so without this an installment would be left marked paid by a transaction
 * that no longer exists. That is the same argument reverseLoanLinksForTransactions already makes
 * about balances, which is why the two are called from the same place, one after the other.
 *
 * Keyed on paid_txn_id IN (...), so it can NEVER touch a hand-marked row: a hand-marked row has
 * paid_txn_id NULL, and that is precisely what "a person marked this" means here (ruling B13).
 *
 * Returns the number of installments un-marked. Uses getDb() rather than a passed handle for the
 * reason the note below reverseLoanLinksForTransactions states -- do not change one without the
 * other.
 */
export function reverseInstallmentLinksForTransactions(txnIds: number[]): number {
  if (txnIds.length === 0) return 0;
  const db = getDb();
  let reversed = 0;
  for (const chunk of chunkIds(txnIds)) {
    reversed += db
      .update(billInstallments)
      .set({ paidAt: null, paidTxnId: null })
      .where(inArray(billInstallments.paidTxnId, chunk))
      .run().changes;
  }
  return reversed;
}

// Note on reverseLoanLinksForTransactions and the enclosing transaction: it uses getDb()
// rather than a passed-in tx handle. better-sqlite3 transactions are synchronous and
// db.transaction() nests statements on the same connection, so calls made through getDb()
// inside an open transaction join it. That is the same pattern undoImport's untrain() hook
// already relies on; do not change it to take a tx parameter without also changing the Bayes
// hook, or the two will disagree about what "inside the transaction" means.

// ---------------------------------------------------------------- read model (summary)

/**
 * MUST-15.4: payoffFraction = clamp(1 - balance / principal, 0, 1), null unless both are set
 * and principal > 0. A zero principal would divide by zero; null is the honest answer.
 */
function payoff(principalCents: number | null, balanceCents: number | null): number | null {
  if (principalCents === null || balanceCents === null || principalCents <= 0) return null;
  return Math.min(1, Math.max(0, 1 - balanceCents / principalCents));
}

/**
 * MUST-15.4: the first date on or after today in addMonthsClamped(startDate, k) for 'monthly'
 * or addMonthsClamped(startDate, 12k) for 'annual'; null when billing_cycle is null, and
 * capped at expiry_date when that is set -- there is no next payment after the payoff date.
 * addMonthsClamped is the EXISTING helper, so month-end clamping (a loan that started on the
 * 31st) is already solved and no new date arithmetic is written here.
 */
function nextPayment(input: {
  startDate: string;
  cycle: BillingCycle | null;
  expiryDate: string | null;
  today: string;
}): string | null {
  if (input.cycle === null) return null;
  const step = input.cycle === 'monthly' ? 1 : 12;
  // A loan that started decades ago must not spin: 1200 steps is a century of months.
  for (let k = 1; k <= 1200; k += 1) {
    const date = addMonthsClamped(input.startDate, step * k);
    if (date < input.today) continue;
    if (input.expiryDate !== null && date > input.expiryDate) return null;
    return date;
  }
  return null;
}

/** The shape payoffProjection() returns below; also embedded (optionally) in LoanSummary. */
export interface PayoffProjection {
  monthlyAppliedCents: number;
  projectedPayoffMonth: string;
}

/**
 * Task 16 (v1.7.0): a payoff projection, DISPLAY ONLY -- like payoffFraction and
 * nextPaymentDate above it, this never writes to the database and is never read back into any
 * balance-affecting code in this file. It deliberately never touches interest_rate_bps: that
 * column is display only (MUST-13.1, guarded by tests/ops/loan-invariants.test.ts's whole-file
 * regex scan, and re-guarded function-scoped by tests/lib/loan-payoff.test.ts). A projection
 * built only from what the household has actually paid needs no rate at all.
 *
 * The pace is read from loan_payments.applied_cents, never amount_cents: applied_cents is the
 * piece of a linked transaction that actually moved current_balance_cents (see link()'s
 * docblock far above), while amount_cents is the size of the transaction itself and can be
 * larger than what the loan absorbed (a payment that also covered a fee, or one that landed
 * after the balance had already reached zero and so applied nothing further). A projection of
 * when the BALANCE reaches zero has to be paced by the number that actually moves the balance.
 *
 * DIRECTION RULE (fix-round, F-payoff): applied_cents alone is not enough, because it is stored
 * UNSIGNED IN BOTH DIRECTIONS. A payment (a negative transaction) decrements the balance, but a
 * disbursement or upward adjustment (a positive transaction, linked via assignTransactionToLoan)
 * INCREMENTS it, and BOTH write a positive applied_cents (see link()'s docblock far above). A
 * plain sum(applied_cents) therefore counts money drawn AGAINST the loan as though it had been
 * paid off it -- one linked disbursement can make a barely-paid loan look nearly paid off. The
 * query below joins `transactions` and counts a loan_payments row only when
 * transactions.amount_cents < 0, the SAME "re-derive direction from the linked transaction's own
 * immutable sign, never from applied_cents itself" rule applyPaymentMatchers's own
 * `if (txn.amountCents >= 0) continue` guard, unassignTransactionFromLoan and debtOverTime all
 * already follow. Do not simplify this join away: a bare sum(applied_cents) is exactly the
 * defect this comment exists to keep from coming back.
 *
 * The window is the six FULL calendar months immediately before today's month -- the same
 * "completed months only, never the one still in progress" convention
 * notify/evaluate/monthly.ts's comparePredicted already uses for its own six-month lookback --
 * so running this on the 2nd of the month is never skewed low by a mostly-empty in-progress
 * month. A month with no payment posted counts as a ZERO in the mean, not as a data point to
 * skip over: a loan paid once in six months must project at one sixth of that payment's size,
 * not at the full amount, or a household that pays twice a year would be told its loan behaves
 * like one paid every month.
 *
 * ABSURD-PACE BOUND (fix-round, F-payoff): a projection more than 1200 months (100 years) out
 * returns null instead of a month. A pace of a few cents against a large balance divides out to
 * a payoff centuries away; isMonthKey (src/lib/dates.ts) requires EXACTLY a 4-digit year, so a
 * year that far out fails it and monthLabel silently hands back the raw "YYYYYYYYY-MM" storage
 * key instead of a formatted month. "We cannot meaningfully project this" is the honest call at
 * that point, and a garbled year is not, so null wins over displaying one. 1200 is not a new
 * number invented for this fix -- it is the same "a century of months" cap nextPayment() above
 * already uses for the same reason (a loan that started decades ago must not spin).
 *
 * Clock-free (v1.4.0 rule): `today` arrives as a parameter; nothing here reads the clock.
 */
export function payoffProjection(itemId: number, today: string): PayoffProjection | null {
  const item = getDb()
    .select({ balanceCents: warrantyItems.currentBalanceCents, direction: warrantyItems.loanDirection })
    .from(warrantyItems)
    .where(eq(warrantyItems.id, itemId))
    .get();
  const balanceCents = item?.balanceCents ?? null;
  if (balanceCents === null || balanceCents === 0) return null;
  // Ruling P9: the query below sums applied cents over transactions with amount_cents < 0,
  // which for a LENT loan is the balance GROWING. A projection built from that would read
  // advances as repayments and print a payoff month that means nothing, so there is no
  // projection to make.
  if (item?.direction !== 'owed') return null;

  const thisMonth = monthOf(today);
  const months = monthRange(addMonths(thisMonth, -6), addMonths(thisMonth, -1));

  const rows = getDb()
    .select({
      month: sql<string>`substr(${loanPayments.createdAt}, 1, 7)`,
      total: sql<number>`sum(${loanPayments.appliedCents})`,
    })
    .from(loanPayments)
    .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
    .where(
      and(
        eq(loanPayments.itemId, itemId),
        sql`${transactions.amountCents} < 0`,
        sql`substr(${loanPayments.createdAt}, 1, 7) >= ${months[0]}`,
        sql`substr(${loanPayments.createdAt}, 1, 7) <= ${months[months.length - 1]}`,
      ),
    )
    .groupBy(sql`substr(${loanPayments.createdAt}, 1, 7)`)
    .all();

  const byMonth = new Map(rows.map((row) => [row.month, row.total ?? 0]));
  // meanCents (predict/stats.ts) rounds half away from zero and is what "a month with no
  // payment counts as zero" means in practice: months.map fills every one of the 6 slots.
  const monthlyAppliedCents = meanCents(months.map((month) => byMonth.get(month) ?? 0)) ?? 0;
  if (monthlyAppliedCents === 0) return null;

  const monthsNeeded = Math.ceil(balanceCents / monthlyAppliedCents);
  // See ABSURD-PACE BOUND above: beyond a century out, null is the honest answer.
  if (monthsNeeded > 1200) return null;
  return { monthlyAppliedCents, projectedPayoffMonth: addMonths(thisMonth, monthsNeeded) };
}

export interface LoanSummary {
  itemId: number;
  name: string;
  ownerUserId: number;
  ownerName: string;
  principalCents: number | null;
  interestRateBps: number | null;
  currentBalanceCents: number | null;
  balanceUpdatedAt: string | null;
  billingCycle: BillingCycle | null;
  billingAmountCents: number | null;
  /**
   * v1.14.0 (spec BU, ruling P14): shape declared here in T1 -- selected from the column but
   * carrying no behaviour yet. 'owed' is a debt the household owes (every loan before this
   * release); the other value is money someone owes the household. Lane A's Task 2/3 are the
   * ones that make link(), the reversal paths and debtOverTime actually read it.
   */
  loanDirection: LoanDirection;
  startDate: string;
  expiryDate: string | null;
  isLifetime: boolean;
  payoffFraction: number | null;
  nextPaymentDate: string | null;
  lastPaymentAt: string | null;
  paymentCount: number;
  /** Task 16 (v1.7.0): from payoffProjection() above, DISPLAY ONLY. Optional so pre-existing
   *  LoanSummary fixtures/tests need no changes; absent and null both mean "nothing to show". */
  payoffProjection?: PayoffProjection | null;
}

/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED. A loan's balance and interest rate are the most private
 * numbers in the app, and until now every member could read every one of them.
 *
 * Nothing else in this file takes a viewer. applyPaymentMatchers, link(), markEarliestUnpaid and the
 * reversal helpers are background machinery run by an import or a scheduler, not by a person looking
 * at a screen -- there is no viewer to pass and no screen to protect.
 */
export function listLoans(today: string, viewer: Viewer): LoanSummary[] {
  const scope = ownerScope(viewer);
  const rows = getDb()
    .select({
      itemId: warrantyItems.id,
      name: warrantyItems.name,
      ownerUserId: warrantyItems.ownerUserId,
      ownerName: users.name,
      principalCents: warrantyItems.principalCents,
      interestRateBps: warrantyItems.interestRateBps,
      currentBalanceCents: warrantyItems.currentBalanceCents,
      balanceUpdatedAt: warrantyItems.balanceUpdatedAt,
      billingCycle: warrantyItems.billingCycle,
      billingAmountCents: warrantyItems.billingAmountCents,
      loanDirection: warrantyItems.loanDirection,
      startDate: warrantyItems.purchaseDate,
      expiryDate: warrantyItems.expiryDate,
      isLifetime: warrantyItems.isLifetime,
      // MUST-11.8: the DISPLAY "as of" value the UI shows is max(anchor, newest payment), and
      // the two are labelled differently ("You set this on ..." versus "Last payment ...").
      lastPaymentAt: sql<string | null>`(select max(created_at) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
      paymentCount: sql<number>`(select count(*) from ${loanPayments} lp where lp.item_id = ${warrantyItems.id})`,
    })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    .where(
      scope === null
        ? eq(warrantyItemTypes.kind, 'loan')
        : and(eq(warrantyItemTypes.kind, 'loan'), eq(warrantyItems.ownerUserId, scope)),
    )
    .orderBy(asc(warrantyItems.name), asc(warrantyItems.id))
    .all();

  return rows.map((row) => ({
    ...row,
    payoffFraction: payoff(row.principalCents, row.currentBalanceCents),
    nextPaymentDate: nextPayment({
      startDate: row.startDate,
      cycle: row.billingCycle,
      expiryDate: row.expiryDate,
      today,
    }),
    // Task 16 (v1.7.0): attached here, rather than as a new LoansCard prop, so the card stays
    // a pure presentational component fed by listLoans()'s existing `today` parameter.
    payoffProjection: payoffProjection(row.itemId, today),
  }));
}

/**
 * Whole-household total, same reasoning as netWorthOverTime and safeToSpend: a loan total has no
 * per-person attribution to restrict (dashboard/page.tsx's own comment on the `listLoans` call it
 * makes directly says the same thing). Not in this task's exported-viewer interface list, so this
 * stays viewer-free; the placeholder viewer below is 'household' visibility, which ownerScope
 * (src/lib/auth/viewer.ts) resolves to null -- no restriction -- without ever reading its id.
 */
export function loansTotalOwedCents(): number {
  const householdWide: Viewer = { id: 0, role: 'admin', visibility: 'household' };
  // v1.14.0 (spec BU, ruling P6): money someone owes the household is not a debt the household
  // owes, so a loan pointed the other way does not belong in this total -- src/lib/networth.ts
  // reads this function and correctly stops counting those loans without being edited itself.
  return listLoans(todayIso(), householdWide)
    .filter((loan) => loan.loanDirection === 'owed')
    .reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
}

// ---------------------------------------------------------------- read model (debt over time)

export interface DebtPoint {
  month: string;
  owedCents: number | null;
  /**
   * v1.14.0 (spec BU, ruling P14). The same reconstruction over loans pointed the other way, as
   * its own series -- same null semantics, computed independently -- one unknown such loan must
   * not break the household-debt line and vice versa.
   *
   * v1.14.0 shape-first (plan T1): declared here so the dashboard/report lane and the maths
   * lane are type-independent. The second accumulator lands in the same fold below; until it
   * does, null is the honest value -- no lent loan can exist before the item forms ship.
   */
  lentCents: number | null;
}

/**
 * MUST-15.7: the reconstruction, exactly. One point per calendar month, oldest first. For a
 * month whose last day is E, each loan L contributes:
 *   - E < date(L.created_at)                      -> 0        (the loan did not exist)
 *   - L.current_balance_cents IS NULL, or
 *     L.balance_updated_at IS NULL                -> 0        (no balance is being tracked)
 *   - E < date(L.balance_updated_at)              -> UNKNOWN  (a person typed a balance after
 *       this month, which discarded whatever it was before; anything plotted here would be
 *       invented)
 *   - otherwise -> L.current_balance_cents + SUM(the signed undo of applied_cents) over rows
 *       with created_at > E
 *
 * The month's owedCents is the sum UNLESS any loan contributed unknown, in which case it is
 * null and the line breaks. A total that silently drops a loan for some months and includes
 * it for others is a chart that lies about a trend.
 *
 * MUST-15.9: the walk goes BACKWARDS from the present, never forwards from the principal. The
 * present balance is the one number a person has verified; the principal is a figure from a
 * contract that may never have matched the first statement.
 *
 * MUST-15.8: TWO queries, then a fold in memory over the month axis produced by the existing
 * monthRange/addMonths helpers -- the same pair cashflowTrend uses. No per-month query, no N+1.
 *
 * Task 10's fix round established that loan_payments.applied_cents is UNSIGNED -- a link's
 * direction is only recoverable from its transaction's amount sign, the same way
 * reverseLoanLinksForTransactions reads it back (see that function's doc comment above).
 * Undoing a payment (a negative transaction, which DECREMENTED the balance going forward) ADDS
 * applied_cents back; undoing a disbursement (a positive transaction, which INCREMENTED it)
 * SUBTRACTS applied_cents back. The join below folds that sign into the per-month sum, rather
 * than summing applied_cents unsigned, so a disbursement walked backwards is not mistaken for
 * a payment.
 *
 * v1.14.0 (spec BU, rulings P5, P6): a second, independent reconstruction over loans pointed the
 * other way, as its own series (DebtPoint.lentCents). Of the two SQL queries above, the per-month
 * `case when amount_cents < 0 ...` aggregation is UNCHANGED from before this release (ruling P5)
 * -- it already computes the undo delta in the OWED frame, and the other direction's undo delta
 * is exactly its negation, so the flip happens in the in-memory fold below via loanSignedDelta,
 * never in SQL. The loans query only gained the `direction` column (needed to sort each loan into
 * its own series below). A loan contributes to exactly one series; one series going unknown for
 * a month must never break the other, so "unknown" is now tracked PER SERIES rather than returned
 * early for the whole month as the pre-1.14.0 version did.
 *
 * Task 10 carry (a) -- KNOWN, DOCUMENTED drift after a clamped unassign: unassignTransactionFromLoan
 * and reverseLoanLinksForTransactions clamp their restore at zero (NEW-1 fix-round) rather than
 * ever driving current_balance_cents negative. That clamp is correct for the CURRENT balance --
 * it is the number a person can see and it must never go negative -- but the clamped link row is
 * then DELETED, so the amount the clamp swallowed leaves no trace for this function's backward
 * walk to re-add. Concretely: balance 10,000; a +60,000 disbursement in June takes it to 70,000;
 * a -70,000 payment in July takes it to exactly 0; unassigning the June disbursement afterwards
 * asks for 0 - 60,000 = -60,000, which clamps to 0 and deletes the June link row entirely. The
 * CURRENT month is still exact (0, matching current_balance_cents precisely, because this
 * function anchors every reconstruction on that column). Every month BEFORE the clamped event
 * is off by exactly the amount the clamp swallowed -- here, the reconstructed pre-June balance
 * comes back as 70,000, not the true 10,000, because the deleted June row can no longer be added
 * back on the walk backwards. This is a chart-history inexactness, not a balance-correctness bug
 * (MUST-13.12's own guarantee -- the CURRENT balance is always exactly restored -- still holds);
 * tests/lib/loans/debt-over-time.test.ts pins the exact numbers above as the documented behavior,
 * so a future change to either clamp cannot silently make the drift worse without that test
 * being touched on purpose.
 */
export function debtOverTime(months: number, opts: { endMonth?: string; today?: string } = {}): DebtPoint[] {
  const today = opts.today ?? todayIso();
  const endMonth = opts.endMonth ?? monthOf(today);
  const keys = monthRange(addMonths(endMonth, -(months - 1)), endMonth);

  const loans = getDb()
    .select({
      itemId: warrantyItems.id,
      createdAt: warrantyItems.createdAt,
      balanceCents: warrantyItems.currentBalanceCents,
      anchorAt: warrantyItems.balanceUpdatedAt,
      direction: warrantyItems.loanDirection,
    })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(eq(warrantyItemTypes.kind, 'loan'))
    .all();
  if (loans.length === 0) return keys.map((month) => ({ month, owedCents: null, lentCents: null }));

  const applied = getDb()
    .select({
      itemId: loanPayments.itemId,
      month: sql<string>`substr(${loanPayments.createdAt}, 1, 7)`,
      // Signed undo delta: +applied_cents for a payment (undo a decrement), -applied_cents
      // for a disbursement (undo an increment) -- see the sign-recovery note above.
      total: sql<number>`sum(case when ${transactions.amountCents} < 0 then ${loanPayments.appliedCents} else -${loanPayments.appliedCents} end)`,
    })
    .from(loanPayments)
    .innerJoin(transactions, eq(transactions.id, loanPayments.txnId))
    .groupBy(loanPayments.itemId, sql`substr(${loanPayments.createdAt}, 1, 7)`)
    .all();

  const byItem = new Map<number, Map<string, number>>();
  for (const row of applied) {
    const inner = byItem.get(row.itemId) ?? new Map<string, number>();
    inner.set(row.month, (inner.get(row.month) ?? 0) + (row.total ?? 0));
    byItem.set(row.itemId, inner);
  }

  // v1.14.0: the old code started `total = 0` (never null, once loans.length > 0 was already
  // ruled out above) and a loan that contributed nothing for a given month -- not yet created,
  // or an untracked (null) balance -- left it at that 0. Keep that meaning PER SERIES: a series
  // whose direction has at least one loan in the household starts at 0 and sums into it; a
  // series with NO loan of that direction anywhere defaults to null instead, the same way the
  // whole function would if `loans` were empty. 0 draws the line at zero; null breaks it; those
  // are different claims and a direction nobody uses should make the honest one.
  const hasOwed = loans.some((loan) => loan.direction === 'owed');
  const hasLent = loans.some((loan) => loan.direction !== 'owed');

  return keys.map((month) => {
    const end = monthEnd(month);
    // v1.14.0 (rulings P5, P6): two independent reconstructions over one month axis. A loan
    // contributes to exactly one of them, and one series going unknown must never break the
    // other -- so "unknown" is tracked PER SERIES rather than returned early for the whole
    // month, which is what the pre-1.14.0 single-series version did.
    let owedTotal: number | null = hasOwed ? 0 : null;
    let owedUnknown = false;
    let lentTotal: number | null = hasLent ? 0 : null;
    let lentUnknown = false;
    for (const loan of loans) {
      if (end < loan.createdAt.slice(0, 10)) continue;
      if (loan.balanceCents === null || loan.anchorAt === null) continue;
      const owedSide = loan.direction === 'owed';
      if (end < loan.anchorAt.slice(0, 10)) {
        if (owedSide) owedUnknown = true;
        else lentUnknown = true;
        continue;
      }
      let balance = loan.balanceCents;
      for (const [paymentMonth, cents] of byItem.get(loan.itemId) ?? []) {
        // "created_at > E" is the whole of every LATER month, since E is a month end. The SQL
        // sum is the undo delta in the OWED frame; loanSignedDelta re-expresses it in the loan's
        // own frame. For 'owed' it is the identity, which is why the query above did not have to
        // change (ruling P5).
        if (paymentMonth > month) balance += loanSignedDelta(loan.direction, cents);
      }
      if (owedSide) owedTotal = (owedTotal ?? 0) + balance;
      else lentTotal = (lentTotal ?? 0) + balance;
    }
    return {
      month,
      owedCents: owedUnknown ? null : owedTotal,
      lentCents: lentUnknown ? null : lentTotal,
    };
  });
}
