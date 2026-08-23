import { asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories, transactions, transactionSplits } from '@/db/schema';
import { runEngine } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { formatCents, sumCents } from '@/lib/money';

/**
 * Transaction splits (spec 2026-08-22, v1.7.0, Task 2). A split divides one transaction's
 * amount across more than one category; see the doc comment on `transactionSplits` in
 * src/db/schema.ts for the storage shape and why the sum-of-parts invariant is enforced
 * here rather than by a CHECK (SQLite cannot express a cross-row sum constraint).
 *
 * Design ruling 1 (spec): a split carries category + amount + note only. Attribution stays
 * whole-transaction -- there is no per-part owner.
 *
 * Design ruling 2 (spec): splits do NOT train the categorizer. Nothing here calls
 * confirmCategory, teaches a Bayes token or writes a merchant rule -- a split is a fact
 * about THIS transaction, not a claim that this merchant always divides this way.
 *
 * transactions.amount_cents is IMMUTABLE after insert (see the comment on that column in
 * schema.ts, and the grep invariant in tests/lib/loans/invariants.test.ts): a split ADDS
 * rows to transaction_splits, it never rewrites the parent's own amount.
 */

export interface SplitPart {
  categoryId: number;
  amountCents: number;
  note?: string | null;
}

export interface SplitRow extends SplitPart {
  id: number;
  txnId: number;
}

/** Same chunking convention as loanLinksForTransactions (src/lib/loans.ts) / dedup.ts. */
const ID_CHUNK = 400;

const SPLIT_SELECTION = {
  id: transactionSplits.id,
  txnId: transactionSplits.txnId,
  categoryId: transactionSplits.categoryId,
  amountCents: transactionSplits.amountCents,
  note: transactionSplits.note,
} as const;

/**
 * The split-aware row source (consumed by Task 3's aggregate rewrites). LEFT JOIN
 * transaction_splits onto transactions: a split part's own category/amount wins via
 * coalesce, and a transaction with no splits falls through to its own columns -- so a
 * caller that adds this join and swaps in these two fragments gets one row per split part
 * for a split transaction, and unchanged behavior for one that was never split.
 *
 * Consumers add the join themselves --
 *   .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
 * -- so this file exports the coalesce fragments only, not a join helper: the join belongs
 * next to whatever WHERE/GROUP BY each aggregate already has.
 */
export const EFFECTIVE_CATEGORY = sql<number | null>`coalesce(${transactionSplits.categoryId}, ${transactions.categoryId})`;
export const EFFECTIVE_AMOUNT = sql<number>`coalesce(${transactionSplits.amountCents}, ${transactions.amountCents})`;

export function getSplits(txnId: number): SplitRow[] {
  return getDb().select(SPLIT_SELECTION).from(transactionSplits).where(eq(transactionSplits.txnId, txnId)).orderBy(asc(transactionSplits.id)).all();
}

/**
 * One query per chunk, same shape as loanLinksForTransactions: a txnId with no splits is
 * simply absent from the map (callers read it back with `.get(id) ?? []`), and an empty
 * input returns immediately without touching the db.
 */
export function splitsForTransactions(txnIds: number[]): Map<number, SplitRow[]> {
  const out = new Map<number, SplitRow[]>();
  if (txnIds.length === 0) return out;
  const db = getDb();
  for (let offset = 0; offset < txnIds.length; offset += ID_CHUNK) {
    const chunk = txnIds.slice(offset, offset + ID_CHUNK);
    const rows = db.select(SPLIT_SELECTION).from(transactionSplits).where(inArray(transactionSplits.txnId, chunk)).orderBy(asc(transactionSplits.id)).all();
    for (const row of rows) {
      const list = out.get(row.txnId) ?? [];
      list.push(row);
      out.set(row.txnId, list);
    }
  }
  return out;
}

/** Blank becomes absent, the same idiom setTransactionDisplayName (engine.ts) uses for free text. */
function normalizeNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Replaces all splits for a txn in ONE db transaction. Empty array clears splits. */
export function setTransactionSplits(input: { txnId: number; parts: SplitPart[]; userId: number }): void {
  const { txnId, parts } = input;

  // "0 to clear" is a first-class shape, not a degenerate 1-part split: a single part is
  // just "recategorize this transaction", which confirmCategory already does -- splits
  // deliberately do not grow a second way to do the same thing.
  if (parts.length === 1) {
    throw new Error('A split needs at least 2 parts, or 0 to clear the existing split.');
  }

  const at = nowIso();

  getDb().transaction((tx) => {
    const parent = tx
      .select({ amountCents: transactions.amountCents, isTransfer: transactions.isTransfer, categoryId: transactions.categoryId })
      .from(transactions)
      .where(eq(transactions.id, txnId))
      .get();
    if (!parent) throw new Error(`No transaction ${txnId}`);

    if (parts.length === 0) {
      tx.delete(transactionSplits).where(eq(transactionSplits.txnId, txnId)).run();

      // This write must stay UNCONDITIONAL -- do not fold it back into the categoryId===null
      // branch below. The fingerprint consumer is evaluateBudgets() (src/lib/notify/evaluate/
      // budget.ts), which short-circuits a whole tick when transactions(count, max(id),
      // max(updated_at)) + budgets(count, max(id)) are unchanged since the last evaluation.
      // Clearing a split on a row that already carried a category changes what every
      // aggregate reports for that category (its spend jumps from the split's own part back
      // up to the parent's full amount) without inserting or deleting a transaction row, and
      // -- in that case -- without touching categorization_source either, so updated_at is
      // the ONLY column left that can move the fingerprint and let the evaluator notice. It
      // is also the honest record: the transaction's effective categorization just changed.
      // Losing this (e.g. by "simplifying" it back inside the branch below) lets a split that
      // was keeping a category under budget get cleared, silently overshoot, and never alert
      // until some unrelated transaction happens to change the fingerprint first.
      tx.update(transactions).set({ updatedAt: at }).where(eq(transactions.id, txnId)).run();

      // Design ruling 2 applies to clearing too: this gives the ENGINE (rules/Bayes) another
      // look, exactly as if the row had just arrived, rather than teaching it anything. A
      // row that already carries a real, confirmed category is left alone -- clearing a
      // split must never silently blank out a categorization a person already confirmed.
      if (parent.categoryId === null) {
        tx.update(transactions).set({ categorizationSource: 'none' }).where(eq(transactions.id, txnId)).run();
        runEngine([txnId]);
      }
      return;
    }

    // A transfer is excluded from every spend/income aggregate (Global Constraints) and has
    // no "category" to divide among parts in the first place.
    if (parent.isTransfer) throw new Error('Transfers cannot be split.');

    const parentSign = Math.sign(parent.amountCents);
    for (const part of parts) {
      if (part.amountCents === 0 || Math.sign(part.amountCents) !== parentSign) {
        throw new Error(
          `Each split amount must be nonzero and match the transaction's sign (transaction is ${formatCents(parent.amountCents)}; got ${formatCents(part.amountCents)}).`,
        );
      }
    }

    const total = sumCents(parts.map((part) => part.amountCents));
    if (total !== parent.amountCents) {
      throw new Error(
        `Split parts total ${formatCents(total)} but the transaction is ${formatCents(parent.amountCents)} (difference ${formatCents(total - parent.amountCents)}).`,
      );
    }

    // Existence + archived-status checked together, one query for every distinct category
    // in the split rather than one query per part.
    const categoryIds = [...new Set(parts.map((part) => part.categoryId))];
    const categoryRows = tx
      .select({ id: categories.id, name: categories.name, isArchived: categories.isArchived })
      .from(categories)
      .where(inArray(categories.id, categoryIds))
      .all();
    const byId = new Map(categoryRows.map((row) => [row.id, row]));
    for (const categoryId of categoryIds) {
      const category = byId.get(categoryId);
      if (!category) throw new Error(`No category ${categoryId}`);
      if (category.isArchived) throw new Error(`Category "${category.name}" is archived and cannot be used in a split.`);
    }

    tx.delete(transactionSplits).where(eq(transactionSplits.txnId, txnId)).run();
    for (const part of parts) {
      tx.insert(transactionSplits)
        .values({ txnId, categoryId: part.categoryId, amountCents: part.amountCents, note: normalizeNote(part.note), createdAt: at })
        .run();
    }

    // Stamping 'manual' -- never a rule, never Bayes (ruling 2) -- is what pulls an
    // auto-assigned-but-unconfirmed Bayes row out of the review queue: REVIEW_WHERE
    // (engine.ts) treats source = 'bayes' as needing review. category_id itself is left
    // exactly as it was: a split does not claim to know what "the" category of a
    // multi-category transaction is, so it never invents or overwrites one. One
    // consequence worth being explicit about: a transaction that was truly uncategorized
    // (category_id NULL) before the split stays NULL after it, and REVIEW_WHERE's
    // `isNull(categoryId)` branch means such a row stays in the review queue regardless of
    // categorization_source -- only a row that already carried a category (rule- or
    // Bayes-assigned) actually leaves the queue by being split.
    tx.update(transactions).set({ categorizationSource: 'manual', updatedAt: at }).where(eq(transactions.id, txnId)).run();
  });
}
