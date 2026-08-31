import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanPayments, transactions, transactionSplits } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { applyPaymentMatchers } from '@/lib/loans';
import { classify, train, untrain } from './bayes';
import { tokenize } from './normalize';
import {
  bumpRuleUsage,
  deleteExactRule,
  deleteRule,
  exactRuleOwner,
  listRules,
  matchRule,
  upsertRuleFromCorrection,
  type MatchType,
  type MerchantRuleRecord,
  type RuleKind,
} from './rules';

/**
 * Card-payment patterns ONLY (spec section 4).
 * E-transfers are deliberately absent: an e-transfer to your own account is
 * textually indistinguishable from rent to a landlord or a gift, and
 * auto-flagging would silently erase real spending from every report.
 */
export const CARD_PAYMENT_PATTERNS: readonly string[] = [
  'PAYMENT - THANK YOU',
  'PAYMENT THANK YOU',
  'PAIEMENT - MERCI',
  'TD VISA PAYMENT',
  'VISA PAYMENT',
  'MASTERCARD PAYMENT',
  'AMEX PAYMENT',
  'AMERICAN EXPRESS PAYMENT',
  'CREDIT CARD PAYMENT',
  'CREDIT CARD/LOC PAY',
  'TFR-TO',
  'TFR-FR',
  'TRANSFER TO C/C',
  'TRANSFER FROM C/C',
];

export interface EngineTxn {
  id: number;
  normalizedMerchant: string;
}

export interface CategorizeOutcome {
  categoryId: number | null;
  source: 'rule' | 'bayes' | 'none';
  confidence: number | null;
  isTransfer: boolean;
  matchedRuleId: number | null;
}

export interface CategorizeContext {
  rules: MerchantRuleRecord[];
}

/**
 * v1.13.0 ruling R4, fix round 1 (reviewer finding: R4 was unimplemented for three of the four
 * rule-writing entry points). Shared by confirmCategory and setTransferFlag, which each write at
 * most one transaction row and, on some paths, learn or refuse a merchant rule.
 *
 * `has_splits` is this function family's pre-R4 `false` (a split row is never touched -- see each
 * function's own docblock for why). `owned_by_another` is R4's refusal. Both leave every row and
 * every rule exactly as they were: ownership is always resolved BEFORE any row write below, never
 * after, so a refusal can never half-apply a category or a transfer flag alongside a rule nobody
 * agreed to.
 */
export type RuleGuardedWriteResult =
  | { ok: true }
  | { ok: false; reason: 'has_splits' }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** applyCategoryToMatching's own shape: success also reports how many rows it touched. */
export type CategoryMatchResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

export function buildContext(): CategorizeContext {
  return { rules: listRules() };
}

export function detectTransfer(normalizedMerchant: string, ctx: CategorizeContext): boolean {
  // An exact 'not_transfer' override wins outright and skips the pattern list
  // entirely: it exists specifically to undo a manual "not a transfer" toggle
  // on a merchant the CARD_PAYMENT_PATTERNS list would otherwise re-catch on
  // every future import/re-run.
  if (matchRule(normalizedMerchant, 'not_transfer', ctx.rules) !== null) return false;

  for (const pattern of CARD_PAYMENT_PATTERNS) {
    if (normalizedMerchant.includes(pattern)) return true;
  }
  // Learned transfer rules are exact-match only, by design.
  return matchRule(normalizedMerchant, 'transfer', ctx.rules) !== null;
}

export function categorizeTransaction(txn: EngineTxn, ctx: CategorizeContext): CategorizeOutcome {
  if (detectTransfer(txn.normalizedMerchant, ctx)) {
    return { categoryId: null, source: 'none', confidence: null, isTransfer: true, matchedRuleId: null };
  }

  const rule = matchRule(txn.normalizedMerchant, 'category', ctx.rules);
  if (rule && rule.categoryId !== null) {
    return { categoryId: rule.categoryId, source: 'rule', confidence: null, isTransfer: false, matchedRuleId: rule.id };
  }

  const guess = classify(tokenize(txn.normalizedMerchant));
  if (guess) {
    return { categoryId: guess.categoryId, source: 'bayes', confidence: guess.margin, isTransfer: false, matchedRuleId: null };
  }

  return { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };
}

export interface EngineResult {
  processed: number;
  categorized: number;
  transfers: number;
  skipped: number;
}

/**
 * Only rows with category_id IS NULL or source = 'bayes' are ever touched -- and, per spec
 * ruling 2a (v1.7.0), never a row that has splits. A split row is categorized by its parts
 * (transaction_splits, see src/lib/splits.ts), even though setTransactionSplits deliberately
 * leaves the parent's OWN category_id untouched -- so an uncategorized-before-split row would
 * otherwise stay eligible here forever. That is not merely cosmetic: if this row's merchant
 * later matches a transfer rule, rerunEngine (below) would set is_transfer = 1 on it, and
 * every report/budget aggregate excludes transfers, so that one flag would silently erase
 * every one of its split parts everywhere. Served by transaction_splits_txn_idx (migration
 * 0009).
 */
const ELIGIBLE = and(
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
  sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
);

/** Chunked well under SQLite's bound-parameter ceiling — see the note in dedup.ts. */
const ID_CHUNK = 400;

function selectRowsByIds(ids: number[]) {
  const db = getDb();
  const rows: {
    id: number;
    normalizedMerchant: string;
    categoryId: number | null;
    source: 'rule' | 'bayes' | 'manual' | 'none';
    /**
     * v1.12.1 (item BC / MON-6). ELIGIBLE (above) carries the splits half of the predicate and its
     * docblock explains at length why. runEngine re-derived eligibility in JavaScript and
     * reproduced only the category half, so the guard the comment describes as living on ELIGIBLE
     * did not apply on that path at all. Selecting the flag here means ONE predicate serves both
     * paths, instead of two that agree today and drift tomorrow.
     */
    hasSplits: number;
  }[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    const chunkRows = db
      .select({
        id: transactions.id,
        normalizedMerchant: transactions.normalizedMerchant,
        categoryId: transactions.categoryId,
        source: transactions.categorizationSource,
      })
      .from(transactions)
      .where(inArray(transactions.id, chunk))
      .all();
    // A drizzle column reference interpolated into a raw sql fragment is not table-qualified
    // when that fragment sits in the SELECT list (only in a .where() condition -- see the
    // identical warning on transactionHasSplits, below). A correlated `hasSplits` subquery
    // written directly into this .select() would have its bare `id` resolve against
    // transaction_splits' OWN id column instead of this outer transactions row, so it would
    // come back true for every row in the chunk the moment ANY split exists anywhere in the
    // database. Querying transaction_splits' txn_id directly, scoped to this same chunk, keeps
    // the same "not exists (select 1 from transaction_splits where txn_id = transactions.id)"
    // predicate ELIGIBLE (above) uses -- just resolved as a second membership query instead of
    // an unqualified correlated one.
    const splitTxnIds = new Set(
      db
        .select({ txnId: transactionSplits.txnId })
        .from(transactionSplits)
        .where(inArray(transactionSplits.txnId, chunk))
        .all()
        .map((row) => row.txnId),
    );
    rows.push(...chunkRows.map((row) => ({ ...row, hasSplits: splitTxnIds.has(row.id) ? 1 : 0 })));
  }
  return rows;
}

export function runEngine(txnIds: number[]): EngineResult {
  if (txnIds.length === 0) return { processed: 0, categorized: 0, transfers: 0, skipped: 0 };

  const db = getDb();
  let result: EngineResult = { processed: 0, categorized: 0, transfers: 0, skipped: 0 };

  // The rename pass, the categorization pass and the rule-hit bumps must land
  // atomically as one unit of work, not three independent commits — a crash
  // between them would otherwise leave categorization and display state (or
  // rule hit counts) inconsistent. better-sqlite3 nests via SAVEPOINT when a
  // transaction is opened while one is already active (applyRenameRules opens
  // its own), so this composes safely.
  db.transaction((tx) => {
    const rows = selectRowsByIds(txnIds);
    const ctx = buildContext();

    // Display renames are a presentation pass over ALL the given rows — independent
    // of the categorization eligibility filter, because a row whose category is
    // already confirmed can still need its display name refreshed.
    applyRenameRules(txnIds, ctx);

    const eligible = rows.filter(
      (row) => (row.categoryId === null || row.source === 'bayes') && row.hasSplits === 0,
    );
    const skipped = rows.length - eligible.length;

    const at = new Date();
    let categorized = 0;
    let transfers = 0;
    const ruleHits = new Map<number, number>();

    for (const row of eligible) {
      const outcome = categorizeTransaction({ id: row.id, normalizedMerchant: row.normalizedMerchant }, ctx);
      if (outcome.isTransfer) transfers += 1;
      if (outcome.categoryId !== null) categorized += 1;
      if (outcome.matchedRuleId !== null) {
        ruleHits.set(outcome.matchedRuleId, (ruleHits.get(outcome.matchedRuleId) ?? 0) + 1);
      }
      tx.update(transactions)
        .set({
          categoryId: outcome.categoryId,
          categorizationSource: outcome.source,
          confidence: outcome.confidence,
          isTransfer: outcome.isTransfer,
          updatedAt: nowIso(at),
        })
        .where(eq(transactions.id, row.id))
        .run();
    }

    for (const [ruleId, hits] of ruleHits) {
      for (let i = 0; i < hits; i += 1) bumpRuleUsage(ruleId, at);
    }

    result = { processed: eligible.length, categorized, transfers, skipped };
  });

  return result;
}

export function eligibleForRerun(scope: { accountId?: number } = {}): number[] {
  const where = scope.accountId === undefined ? ELIGIBLE : and(ELIGIBLE, eq(transactions.accountId, scope.accountId));
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(where)
    .orderBy(asc(transactions.id))
    .all()
    .map((row) => row.id);
}

export function rerunEngine(scope: { accountId?: number } = {}): EngineResult {
  return runEngine(eligibleForRerun(scope));
}

/**
 * Same "not exists (select 1 from transaction_splits ...)" shape as ELIGIBLE/REVIEW_WHERE
 * above -- polarity flipped (this asks whether a split EXISTS, they ask whether one does
 * not) and scoped to one row instead of filtering a table scan. Used by confirmCategory,
 * setTransferFlag and clearCategory to refuse a write on a transaction that has splits; see
 * their doc comments for why. Deliberately a `.where()` predicate rather than a computed
 * `.select()` field: a
 * drizzle column reference interpolated into a raw `sql` fragment used as a SELECT-list value
 * is not table-qualified the way the same reference is when it appears in a `.where()`
 * condition, so embedding it as a select field here would let the correlated subquery's bare
 * `id` resolve against transaction_splits' OWN id column instead of the outer transactions
 * row -- silently matching every row once ANY split exists anywhere. Served by
 * transaction_splits_txn_idx (migration 0009).
 */
function transactionHasSplits(transactionId: number): boolean {
  const row = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, transactionId),
        sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * The confirmed state. Sets source = 'manual' (the Bayes training set),
 * upserts an exact merchant rule, and updates token counts, decrementing the
 * previous category on a recategorization.
 *
 * Returns `{ ok: false, reason: 'has_splits' }`, and does NOTHING (no category write, no rule, no
 * Bayes training), for a transaction that has splits. Spec ruling 2a: a split row is categorized
 * BY ITS PARTS (transaction_splits, see src/lib/splits.ts), never by the parent's own category_id,
 * so overwriting that column here would misrepresent what the transaction "is" AND poison the
 * categorizer -- this function trains Bayes and writes an exact merchant rule from whatever ONE
 * category it is given, which would then mis-categorize every OTHER, unsplit transaction from
 * this merchant on a signal that was only ever true for one arbitrarily-chosen part of this one.
 * Task 2b (v1.7.0) closed this same hole for the AUTOMATIC engine path (ELIGIBLE/REVIEW_WHERE,
 * below); this closes it for the MANUAL confirm path -- the per-row and bulk "Categorize" actions
 * -- which those predicates never touched. Callers that bulk-confirm must check this return value
 * and report the skip; see bulkSetCategory in src/lib/transactions.ts.
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }`, and does NOTHING (same "nothing written" guarantee as the
 * has_splits case above), when `actorRole` is `'member'` and this merchant's exact category rule
 * was created by somebody else. The ownership check runs BEFORE the transaction row is touched at
 * all -- untraining the old category, writing the new one and training it are all downstream of a
 * successful rule write, never upstream of it -- so a refusal can never leave a half-applied
 * category sitting on a rule nobody agreed to.
 */
export function confirmCategory(input: {
  transactionId: number;
  categoryId: number;
  userId: number;
  createRule?: boolean;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): RuleGuardedWriteResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return { ok: false, reason: 'has_splits' };

  const tokens = tokenize(row.normalizedMerchant);

  if (row.source === 'manual' && row.categoryId !== null && row.categoryId === input.categoryId) {
    // Already confirmed to the same category: nothing to retrain, and nothing about the rule
    // changes either, so there is nothing for R4 to check.
    //
    // MUST-13.8: the matcher call sits on THIS path too. A transaction confirmed before a
    // loan rule existed could otherwise never be picked up by re-confirming it -- which is
    // exactly what a person does when they notice a payment did not get assigned. It is
    // cheap: applyPaymentMatchers bails on its first query when no loan rules exist.
    //
    // The cost is worth stating rather than hiding: bulkCategorizeAction loops
    // confirmCategory, so a 50-row bulk confirm makes 50 applyPaymentMatchers calls and, on a
    // household with no loans, 50 single-row indexed reads against an empty join. That is
    // a bounded, sub-millisecond cost on a user-initiated action, and it buys the property
    // that a person can always fix a missed assignment by re-confirming the row. Batching
    // it into the action layer would put a fifth caller in a sixth place and is the change
    // to make if that cost ever shows up in a profile.
    applyPaymentMatchers([input.transactionId], at);
    return { ok: true };
  }

  // R4 ownership check FIRST: resolved (and can refuse) before anything else below is touched.
  if (input.createRule !== false && row.normalizedMerchant.length > 0) {
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: input.categoryId,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  }

  if (row.source === 'manual' && row.categoryId !== null) {
    untrain(tokens, row.categoryId);
  }

  db.update(transactions)
    .set({
      categoryId: input.categoryId,
      categorizationSource: 'manual',
      confidence: null,
      updatedAt: nowIso(at),
    })
    .where(eq(transactions.id, input.transactionId))
    .run();

  train(tokens, input.categoryId);
  applyPaymentMatchers([input.transactionId], at);
  return { ok: true };
}

/**
 * Returns false, and does NOTHING (no category write, no rule deletion, no untraining), for a
 * transaction that has splits. Final pre-release review finding (2026-08-22): this is the
 * third sibling of confirmCategory/setTransferFlag above, and the one Task 2b's guard missed --
 * it is reached through the OTHER half of setCategoryAction's if/else (the empty-selection
 * branch), the same action confirmCategory's guard already protects the other half of.
 *
 * Why this one is dangerous rather than merely inconsistent: setTransactionSplits (see
 * src/lib/splits.ts) stamps categorization_source = 'manual' on the parent when splitting --
 * that is what pulls an auto-assigned Bayes row out of the review queue -- but, per design
 * ruling 2, it NEVER calls train(). So a split parent that a rule or Bayes had already
 * categorized before being split ends up 'manual' with a real category_id and NO training
 * behind it, breaking the one invariant this function's untrain() call relied on (that
 * 'manual' + a non-null category_id means THIS row's own tokens were the ones trained -- true
 * before splits existed, when confirmCategory was the only writer of 'manual' and always
 * paired it with a real train()). Left unguarded, clearing such a row untrains whatever OTHER,
 * unsplit transaction at the same merchant actually earned that training, and -- unconditionally,
 * regardless of category_id -- deletes that merchant's exact category rule too, poisoning the
 * categorizer for every future transaction from that merchant. Reproduced: confirm a control
 * transaction to a category (real training), then confirm/split a second transaction at the
 * SAME merchant and clear its category -- the control's own training and rule are erased even
 * though it was never touched.
 *
 * The blast radius stops at the categorizer, not the ledger: every split-aware aggregate reads
 * EFFECTIVE_CATEGORY (src/lib/splits.ts), which ignores the parent's own category_id entirely,
 * so a stray write here would not corrupt any total. But it WOULD leave category_id null on a
 * row whose split parts still carry real categories -- an inconsistent record for a column a
 * person was never shown a way to edit in the first place (the transactions page hides this
 * form for a split row; only a stale resubmit or a second household member's unrefreshed
 * session can still reach it). Refusing outright, like confirmCategory/setTransferFlag, avoids
 * both problems at once. Callers must check this return value; see setCategoryAction in
 * src/app/(app)/transactions/actions.ts, its only caller.
 */
export function clearCategory(input: {
  transactionId: number;
  userId: number;
  /**
   * v1.12.1 (item U / UX-2, rulings R4 and P5). REQUIRED, with no default, so the compiler makes
   * every call site say what it means. Picking "Uncategorized" from the row select on
   * /transactions used to delete that merchant's household-wide exact rule -- a change to how
   * everyone's future statements are filed, made by a mis-scroll over a <select> on a phone, with
   * nothing on screen to say it had happened. The deliberate control for deleting a rule is the
   * one that already exists: Settings -> Rules (deleteRuleAction, admin-only).
   */
  deleteRule: boolean;
  at?: Date;
}): boolean {
  const db = getDb();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return false;

  if (row.source === 'manual' && row.categoryId !== null) {
    untrain(tokenize(row.normalizedMerchant), row.categoryId);
  }
  if (input.deleteRule) deleteExactRule(row.normalizedMerchant, 'category');

  db.update(transactions)
    .set({ categoryId: null, categorizationSource: 'none', confidence: null, updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
  return true;
}

/**
 * Returns `{ ok: false, reason: 'has_splits' }`, and does NOTHING (no is_transfer write, no rule
 * created or removed), for a transaction that has splits. Spec ruling 2a: a split's parts ARE its
 * categorization, and setTransactionSplits already refuses to split a transfer in the first place
 * (a transfer has no "category" to divide) -- so a split row should never legitimately reach
 * is_transfer = 1. Without this guard, flagging one a transfer anyway silently drops every one of
 * its split parts out of every report and budget (all of which exclude transfers, per
 * categoryBreakdown/categorySpend and friends), while the row keeps displaying its own
 * "Split - N parts" badge -- the money is gone with no visible sign why. Worse, marking it also
 * upserts a merchant rule, so the NEXT unsplit transaction from the same merchant would be
 * auto-flagged a transfer on the next import too. Task 2b (v1.7.0) closed the automatic-engine
 * side of this (ELIGIBLE/REVIEW_WHERE, above); this closes the manual "Mark transfer" side, which
 * those predicates never touched. Callers that bulk-flag must check this return value and report
 * the skip; see bulkSetTransfer in src/lib/transactions.ts.
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }`, and does NOTHING (is_transfer untouched), when `actorRole` is
 * `'member'` and the transfer/not_transfer rule this flip would learn was created by somebody
 * else. Whichever rule the flip needs is resolved -- and can refuse -- BEFORE is_transfer is ever
 * written, so a refusal never leaves the flag flipped alongside a rule nobody agreed to.
 *
 * v1.13.1 ruling R4, fix round 2 (item BJ). The check above gates the rule this action WRITES;
 * the OPPOSITE-kind rule it removes as housekeeping (the two deleteExactRule calls below) was
 * deleted unconditionally, so a member re-flagging one transaction could delete an
 * admin-authored not_transfer or transfer rule with no ownership check at all. That rule is
 * now resolved HERE, in the same block and before is_transfer is written, and a member who
 * does not own it gets the whole action refused -- no row touched, no rule deleted -- exactly
 * as confirmCategory and upsertRuleFromCorrection already refuse for the rule they write.
 */
export function setTransferFlag(input: {
  transactionId: number;
  isTransfer: boolean;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): RuleGuardedWriteResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({ normalizedMerchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return { ok: false, reason: 'has_splits' };

  const matchesCardPattern = CARD_PAYMENT_PATTERNS.some((pattern) => row.normalizedMerchant.includes(pattern));

  // v1.13.1 ruling R4, fix round 2 (item BJ): the OPPOSITE-kind rule this flip would remove as
  // housekeeping below (deleteExactRule at the end of this function) -- 'not_transfer' when
  // re-flagging as a transfer, 'transfer' when un-flagging -- is resolved and can refuse FIRST,
  // before the rule this flip WRITES (the block below) or is_transfer itself is ever touched. It
  // has to run before the write-side upsertRuleFromCorrection call, not after: that call both
  // checks AND WRITES the rule it owns in one step, so checking housekeeping ownership only
  // after it ran could refuse the whole action while still leaving a freshly-created rule behind
  // -- the "optional owner check that still deletes on a refusal" this fix explicitly rejects,
  // applied to a create instead of a delete.
  const housekeepingKind: RuleKind = input.isTransfer ? 'not_transfer' : 'transfer';
  if (input.actorRole !== 'admin') {
    const owner = exactRuleOwner(row.normalizedMerchant, housekeepingKind);
    if (owner !== null && owner.createdBy !== null && owner.createdBy !== input.userId) {
      return { ok: false, reason: 'owned_by_another', ownerName: owner.ownerName };
    }
  }

  // R4 ownership check: whichever rule this flip would learn is resolved -- and can
  // refuse -- before is_transfer itself is ever written.
  if (input.isTransfer) {
    // EXACT match only: a contains rule learned from an e-transfer description
    // would over-match every unrelated e-transfer.
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'transfer',
      categoryId: null,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  } else if (matchesCardPattern) {
    // The card-payment pattern list would re-catch this merchant on the very
    // next runEngine/rerun. Merely deleting a (nonexistent) transfer rule would
    // not stop that, so teach an exact 'not_transfer' override instead.
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  }

  db.update(transactions)
    .set({ isTransfer: input.isTransfer, updatedAt: nowIso(at) })
    .where(eq(transactions.id, input.transactionId))
    .run();

  if (input.isTransfer) {
    // Re-flagging as a transfer must undo any earlier "not a transfer" override
    // on this exact merchant, or detectTransfer's not_transfer check (which runs
    // first) would keep silently vetoing this very rule on every future re-run.
    // Ownership of this rule was already settled above (item BJ) -- a refusal never reaches here.
    deleteExactRule(row.normalizedMerchant, 'not_transfer');
  } else if (!matchesCardPattern) {
    // Only a learned transfer rule (or a purely manual flag) could have flagged
    // this row — today's behaviour is unchanged: remove that rule.
    // Ownership of this rule was already settled above (item BJ) -- a refusal never reaches here.
    deleteExactRule(row.normalizedMerchant, 'transfer');
  }
  return { ok: true };
}

/**
 * "Apply category to all N matching transactions + create rule" (bulk action).
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }` and touches NO row at all when `actorRole` is `'member'` and
 * this merchant's exact category rule was created by somebody else. The rule is resolved -- and
 * can refuse -- BEFORE the loop over matching transaction ids even starts, so a refusal can never
 * leave some rows categorized against a rule the household never agreed to and others not (a
 * half-applied bulk action would be worse than an all-or-nothing refusal).
 */
export function applyCategoryToMatching(input: {
  normalizedMerchant: string;
  categoryId: number;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): CategoryMatchResult {
  const ids = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.normalizedMerchant, input.normalizedMerchant),
        eq(transactions.isTransfer, false),
        or(ne(transactions.categoryId, input.categoryId), isNull(transactions.categoryId)),
      ),
    )
    .all()
    .map((row) => row.id);

  if (ids.length === 0) return { ok: true, count: 0 };

  // R4 ownership check FIRST: resolved -- and can refuse -- before any of the matching rows
  // below are touched.
  const upserted = upsertRuleFromCorrection({
    pattern: input.normalizedMerchant,
    matchType: 'exact',
    ruleKind: 'category',
    categoryId: input.categoryId,
    createdBy: input.userId,
    actorRole: input.actorRole,
    at: input.at,
  });
  if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };

  for (const id of ids) {
    // createRule: false -- the rule for this merchant was just resolved above, once, for the
    // whole batch; confirmCategory must not attempt (and re-check ownership on) it again per row.
    confirmCategory({
      transactionId: id,
      categoryId: input.categoryId,
      userId: input.userId,
      createRule: false,
      actorRole: input.actorRole,
      at: input.at,
    });
  }
  return { ok: true, count: ids.length };
}

/**
 * Review queue = uncategorized rows plus auto-assigned-but-unconfirmed Bayes rows.
 * Transfers are excluded: spec section 3 removes them from all spend/income
 * reporting, so they never need a category. Split rows are excluded too (spec ruling 2a,
 * v1.7.0): a split row is categorized by its parts (see the comment on ELIGIBLE above, and
 * src/lib/splits.ts), so a transaction that was genuinely uncategorized before being split --
 * category_id stays NULL, since a split never invents or overwrites the parent's own category
 * -- must not nag here forever just because that column is still empty. Served by
 * transaction_splits_txn_idx (migration 0009).
 *
 * A row with any loan_payments link is excluded too (2026-08-30 fix). Assigning a transaction to
 * a loan writes a loan_payments row and, by design (MUST-13.2, src/lib/loans.ts), never touches
 * category_id or categorization_source -- a loan payment stays in its spending category and in
 * every budget. Without this clause a loan-linked row a person had already dealt with kept
 * coming back to this queue forever, because nothing about ITS category ever changed even
 * though a decision about the row plainly had been made. A loan link IS that decision, the same
 * way confirming a category or splitting a row already is one -- so it takes the row out of the
 * queue for the same reason those do. Unassigning the link (unassignTransactionFromLoan,
 * src/lib/loans.ts) undoes the decision, so a row with no link left is undecided again and comes
 * right back. This is like the not-a-split-row clause immediately above -- a correlated `not
 * exists` in a `.where()` predicate, never a computed `.select()` field: the same warning
 * applies (see transactionHasSplits' own docblock, below) -- a bare `txn_id` interpolated into a
 * raw `sql` fragment used as a SELECT-list value is not table-qualified the way it is inside a
 * `.where()` condition, so putting this in a select list would let the correlated subquery's
 * `txn_id` resolve against loan_payments' OWN row instead of this outer transactions row,
 * matching every transaction the moment ANY loan link exists anywhere. Served by
 * loan_payments_txn_idx (migration 0007) -- no new index, no migration needed.
 */
export const REVIEW_WHERE = and(
  eq(transactions.isTransfer, false),
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
  sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
  sql`not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})`,
);

export function reviewQueueIds(limit = 100, offset = 0): number[] {
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(REVIEW_WHERE)
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all()
    .map((row) => row.id);
}

export function reviewQueueCount(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(REVIEW_WHERE)
    .get();
  return row?.c ?? 0;
}

// ------------------------------------------------- merchant renames (v1.4)

/** The rename text a merchant resolves to, or null when no rename rule matches. */
export function resolveRename(normalizedMerchant: string, ctx: CategorizeContext): string | null {
  const rule = matchRule(normalizedMerchant, 'rename', ctx.rules);
  if (!rule || rule.renameTo === null || rule.renameTo.length === 0) return null;
  return rule.renameTo;
}

/**
 * Applies rename rules to the given rows (all rows when txnIds is omitted).
 *
 * Precedence is manual > rename > unset:
 *   - display_source = 'manual' rows are NEVER read or written here.
 *   - a matching rule sets display_description + display_source = 'rename'.
 *   - a row previously set by a rule that no longer matches is cleared back to raw.
 *
 * raw_description and normalized_merchant are never written, so the frozen dedup
 * hash and every categorizer input are untouched by anything in this function.
 */
export function applyRenameRules(txnIds?: number[], ctx: CategorizeContext = buildContext()): number {
  const db = getDb();
  const scope = txnIds === undefined ? undefined : txnIds;
  if (scope !== undefined && scope.length === 0) return 0;

  const columns = {
    id: transactions.id,
    normalizedMerchant: transactions.normalizedMerchant,
    displayDescription: transactions.displayDescription,
    displaySource: transactions.displaySource,
  } as const;

  const rows: {
    id: number;
    normalizedMerchant: string;
    displayDescription: string | null;
    displaySource: 'manual' | 'rename' | null;
  }[] = [];

  if (scope === undefined) {
    rows.push(...db.select(columns).from(transactions).where(ne(transactions.displaySource, 'manual')).all());
    // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
    rows.push(...db.select(columns).from(transactions).where(isNull(transactions.displaySource)).all());
  } else {
    for (let offset = 0; offset < scope.length; offset += ID_CHUNK) {
      const chunk = scope.slice(offset, offset + ID_CHUNK);
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), ne(transactions.displaySource, 'manual')))
          .all(),
      );
      // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), isNull(transactions.displaySource)))
          .all(),
      );
    }
  }

  const at = nowIso();
  let changed = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      const rename = resolveRename(row.normalizedMerchant, ctx);

      if (rename === null) {
        // Only clear what a rule set; a NULL display_source row has nothing to clear.
        if (row.displaySource === 'rename') {
          tx.update(transactions)
            .set({ displayDescription: null, displaySource: null, updatedAt: at })
            .where(eq(transactions.id, row.id))
            .run();
          changed += 1;
        }
        continue;
      }

      if (row.displaySource === 'rename' && row.displayDescription === rename) continue;

      tx.update(transactions)
        .set({ displayDescription: rename, displaySource: 'rename', updatedAt: at })
        .where(eq(transactions.id, row.id))
        .run();
      changed += 1;
    }
  });

  return changed;
}

/** "This transaction only": manual always wins and is never overwritten by a rule. */
export function setTransactionDisplayName(input: {
  transactionId: number;
  displayDescription: string | null;
  userId: number;
  at?: Date;
}): void {
  const trimmed = input.displayDescription === null ? null : input.displayDescription.trim();
  const db = getDb();

  if (trimmed === null || trimmed.length === 0) {
    // Clearing a manual rename hands the row back to the rules.
    db.update(transactions)
      .set({ displayDescription: null, displaySource: null, updatedAt: nowIso(input.at ?? new Date()) })
      .where(eq(transactions.id, input.transactionId))
      .run();
    applyRenameRules([input.transactionId]);
    return;
  }

  db.update(transactions)
    .set({ displayDescription: trimmed, displaySource: 'manual', updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
}

/**
 * "All matching + future": create/update the rule, then bulk-apply it retroactively.
 *
 * v1.13.0 ruling R4 (item AH / SEC-6). Now threads `actorRole` through to `upsertRuleFromCorrection`
 * and can refuse. A refused upsert must not bulk-apply anything: the rule the household has is
 * unchanged, so a retroactive pass would rewrite rows to a name nobody agreed on.
 */
export function upsertRenameRule(input: {
  pattern: string;
  matchType: MatchType;
  renameTo: string;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): { ok: true; ruleId: number; rowsUpdated: number } | { ok: false; reason: 'owned_by_another'; ownerName: string } {
  const renameTo = input.renameTo.trim();
  if (renameTo.length === 0) throw new Error('A rename rule needs a non-empty display name');
  if (input.pattern.trim().length === 0) throw new Error('A rename rule needs a pattern');

  const result = upsertRuleFromCorrection({
    pattern: input.pattern,
    matchType: input.matchType,
    ruleKind: 'rename',
    categoryId: null,
    renameTo,
    createdBy: input.userId,
    actorRole: input.actorRole,
    at: input.at,
  });
  if (!result.ok) return result;
  const rowsUpdated = applyRenameRules(undefined, buildContext());
  return { ok: true, ruleId: result.ruleId, rowsUpdated };
}

export function deleteRenameRule(input: { pattern: string; matchType: MatchType }): {
  ruleId: number | null;
  rowsCleared: number;
} {
  const existing = listRules('rename').find((rule) => rule.pattern === input.pattern && rule.matchType === input.matchType);
  if (!existing) return { ruleId: null, rowsCleared: 0 };
  deleteRule(existing.id);
  const rowsCleared = applyRenameRules(undefined, buildContext());
  return { ruleId: existing.id, rowsCleared };
}
