import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories, transactions, transactionSplits, users } from '@/db/schema';
import { runEngine } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { formatCents, sumCents } from '@/lib/money';
import type { SplitPerson } from '@/lib/split-person';

export type { SplitPerson } from '@/lib/split-person';

/**
 * Transaction splits (spec 2026-08-22, v1.7.0, Task 2). A split divides one transaction's
 * amount across more than one category; see the doc comment on `transactionSplits` in
 * src/db/schema.ts for the storage shape and why the sum-of-parts invariant is enforced
 * here rather than by a CHECK (SQLite cannot express a cross-row sum constraint).
 *
 * Design ruling 1 (spec), as amended by v1.63.0 (plan 2026-11-12, S1): a part carries a category,
 * an amount, a note and a person. The person FOLLOWS the transaction unless someone set it
 * (person_set = 1), so Set person, the attribution rules and bulk undo still write only the
 * transaction: the following parts move with it and a deliberately set part stays. Who may act on
 * the transaction (transactionOwners, canActOnOwner) is still the transaction's own person.
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
  /** v1.63.0. Omitted is 'follow', so every caller from before 0032 writes what it always did. */
  person?: SplitPerson;
}

export interface SplitRow extends SplitPart {
  id: number;
  txnId: number;
  /**
   * v1.63.0. The stored pair (see effectivePartPerson, src/lib/split-person.ts). Optional in the
   * type so fixtures built before 0032 still compile; getSplits/splitsForTransactions always fill
   * both.
   */
  personSet?: boolean;
  attributedUserId?: number | null;
}

/** v1.63.0. setTransactionSplits' refusal for a part set to an id with no users row. */
export const UNKNOWN_SPLIT_PERSON_ERROR = 'That person is not in this household.';

/** Same chunking convention as loanLinksForTransactions (src/lib/loans.ts) / dedup.ts. */
const ID_CHUNK = 400;

const SPLIT_SELECTION = {
  id: transactionSplits.id,
  txnId: transactionSplits.txnId,
  categoryId: transactionSplits.categoryId,
  amountCents: transactionSplits.amountCents,
  note: transactionSplits.note,
  personSet: transactionSplits.personSet,
  attributedUserId: transactionSplits.attributedUserId,
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

/**
 * v1.63.0 (plan 2026-11-12, S2). The person a joined row's money belongs to: a set part's own
 * person, otherwise the transaction's. THE one definition of a part's person in SQL; every reader
 * that splits money by person filters and groups on this, never on transactions.attributed_user_id
 * (tests/ops/split-person.test.ts).
 *
 * An unsplit row has no joined part, so person_set is NULL and the transaction's person wins. Not
 * `coalesce`: a set part's NULL is a real answer (Household), not a missing one.
 *
 * Inside a correlated subquery over transaction_splits (the clause builders below), the same
 * fragment reads that subquery's part: SQLite resolves a qualified column against the innermost
 * FROM first, and the transactions reference reaches out to the enclosing row.
 */
export const EFFECTIVE_PERSON = sql<number | null>`(case when ${transactionSplits.personSet} = 1 then ${transactionSplits.attributedUserId} else ${transactions.attributedUserId} end)`;

/**
 * A person scope: a user id, or 'unattributed' for Household (the shape reports.ts and the
 * Transactions filter already use for a person filter).
 */
export type SplitPersonScope = number | 'unattributed';

/** EFFECTIVE_PERSON is this person. NULL-safe for Household; never matches NULL for an id. */
export function effectivePersonIs(person: SplitPersonScope): SQL {
  return person === 'unattributed' ? sql`(${EFFECTIVE_PERSON} is null)` : sql`(${EFFECTIVE_PERSON} = ${person})`;
}

/** EFFECTIVE_PERSON is anyone but this person, Household included. */
function effectivePersonIsNot(person: SplitPersonScope): SQL {
  return person === 'unattributed' ? sql`(${EFFECTIVE_PERSON} is not null)` : sql`(${EFFECTIVE_PERSON} is not ${person})`;
}

/**
 * v1.63.0 (S3, one row per transaction). A transaction is in `person`'s scope when it is theirs and
 * not wholly given away (it is unsplit, or at least one part follows it), or when any part is set
 * to them. A charge whose every part is set to someone else is no longer its own person's.
 *
 * Two arms, each with an index: the first is the transaction's person (transactions_attributed_
 * date_idx) plus one lookup on transaction_splits_txn_idx -- min(person_set) is NULL with no parts,
 * 0 with a following part and 1 when every part is set -- and the second is the partial
 * transaction_splits_person_idx (0032).
 */
export function personRowClause(person: SplitPersonScope): SQL {
  const own =
    person === 'unattributed' ? sql`${transactions.attributedUserId} is null` : sql`${transactions.attributedUserId} = ${person}`;
  const setTo =
    person === 'unattributed' ? sql`${transactionSplits.attributedUserId} is null` : sql`${transactionSplits.attributedUserId} = ${person}`;
  return sql`((${own} and coalesce((select min(${transactionSplits.personSet}) from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id}), 0) = 0) or ${transactions.id} in (select ${transactionSplits.txnId} from ${transactionSplits} where ${transactionSplits.personSet} = 1 and ${setTo}))`;
}

/**
 * v1.63.0 (S3, split-joined aggregates). Over `LEFT JOIN transaction_splits`: the joined rows whose
 * money is `person`'s. The row clause adds nothing to the result (a row holding the person's part is
 * always in their row scope); it is there so the read keeps its index access instead of evaluating
 * the CASE over every joined row.
 */
export function partPersonClause(person: SplitPersonScope): SQL {
  return sql`(${personRowClause(person)} and ${effectivePersonIs(person)})`;
}

/**
 * v1.63.0 (S3, whole-charge reads: insights, recurring charges). The transaction is `person`'s and
 * no part of it is set to anybody else, so the whole charge -- its merchant, its amount, its cadence
 * -- is theirs alone. A shared charge stays in household reads only; a part set to the person
 * themselves does not make it shared.
 */
export function soleOwnerClause(person: number): SQL {
  return sql`(${transactions.attributedUserId} = ${person} and not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id} and ${transactionSplits.personSet} = 1 and ${transactionSplits.attributedUserId} is not ${person}))`;
}

/**
 * v1.63.0 (S3). A row's amount for `person`: the whole amount when it is unsplit, else the sum of
 * the parts whose effective person is theirs (0 when none is). Over transactions WITHOUT the split
 * join; the parts are read in correlated subqueries.
 *
 * The columns sit inside a nested fragment on purpose: drizzle strips the table name from a column
 * at the TOP level of a select-list fragment when the query reads one table (see
 * transactionHasSplits below), and an unqualified `id` inside the subquery would resolve to
 * transaction_splits.id.
 */
export function scopedAmountSql(person: SplitPersonScope): SQL<number> {
  const share = sql`(case when exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id}) then coalesce((select sum(${transactionSplits.amountCents}) from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id} and ${effectivePersonIs(person)}), 0) else ${transactions.amountCents} end)`;
  return sql<number>`${share}`;
}

/**
 * v1.63.0 (S3). True when the row is split and some part belongs to someone other than `person`:
 * what a person scope shows of this row is only part of the charge. Over transactions without the
 * split join, nested for the reason scopedAmountSql gives.
 */
export function hasPartOutsideSql(person: SplitPersonScope): SQL<boolean> {
  const outside = sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id} and ${effectivePersonIsNot(person)})`;
  return sql<boolean>`${outside}`.mapWith((value: unknown) => Number(value) === 1);
}

/**
 * Does this transaction have splits?
 *
 * Lives here, beside the table it asks about, because two modules need the answer for the same
 * reason: a split row's category is not what its parts say it is, so anything that reads the
 * parent's own category as a fact about the household's spending is reading a placeholder. The
 * engine refuses to confirm, clear or flag such a row; the delete path had to stop UNTRAINING one
 * (review E3), and a second hand-written copy of the subquery is how those two would drift.
 *
 * Deliberately a `.where()` predicate rather than a computed `.select()` field: a drizzle column
 * reference interpolated into a raw `sql` fragment is not table-qualified in a SELECT list the way
 * it is in a condition, so as a select field the correlated subquery's bare `id` would resolve
 * against transaction_splits' OWN id and match every row the moment any split exists anywhere.
 * Served by transaction_splits_txn_idx (migration 0009).
 */
export function transactionHasSplits(transactionId: number): boolean {
  return (
    getDb()
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.id, transactionId),
          sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
        ),
      )
      .get() !== undefined
  );
}

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

/** The stored pair for an editor choice: follow is (0, NULL), household (1, NULL), a person (1, id). */
function storedPerson(person: SplitPerson | undefined): { personSet: boolean; attributedUserId: number | null } {
  if (person === undefined || person === 'follow') return { personSet: false, attributedUserId: null };
  if (person === 'household') return { personSet: true, attributedUserId: null };
  return { personSet: true, attributedUserId: person };
}

/**
 * Replaces all splits for a txn in ONE db transaction. Empty array clears splits.
 *
 * v1.63.0: each part's `person` is stored as storedPerson says. An id with no users row is refused
 * (UNKNOWN_SPLIT_PERSON_ERROR) before anything is written. Who may set which person (plan S4) is
 * the calling action's decision, not this function's.
 */
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

    // One query for every distinct person named, the same shape as the category check above.
    const personIds = [...new Set(parts.map((part) => part.person).filter((person): person is number => typeof person === 'number'))];
    if (personIds.length > 0) {
      const known = new Set(
        tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, personIds))
          .all()
          .map((row) => row.id),
      );
      if (personIds.some((id) => !known.has(id))) throw new Error(UNKNOWN_SPLIT_PERSON_ERROR);
    }

    tx.delete(transactionSplits).where(eq(transactionSplits.txnId, txnId)).run();
    for (const part of parts) {
      const { personSet, attributedUserId } = storedPerson(part.person);
      tx.insert(transactionSplits)
        .values({
          txnId,
          categoryId: part.categoryId,
          amountCents: part.amountCents,
          note: normalizeNote(part.note),
          personSet,
          attributedUserId,
          createdAt: at,
        })
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
