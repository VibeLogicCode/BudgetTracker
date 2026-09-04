import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts, categories, transactions, transactionSplits, users } from '@/db/schema';
import { getAccount } from '@/lib/accounts';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import {
  REVIEW_SUGGESTED_WHERE,
  REVIEW_UNCATEGORIZED_WHERE,
  REVIEW_WHERE,
  confirmCategory,
  runEngine,
  setTransferFlag,
} from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { ruleOwnedError } from '@/lib/categorize/rules';
import { nowIso } from '@/lib/clock';
import { isIsoDate } from '@/lib/dates';
import { applyPaymentMatchers, assignTransactionToLoan } from '@/lib/loans';
// F-07 (v1.31.0). See buildWhere's search clause below for why this is the ONLY new import the
// feature needs -- the split editor already proved this parser handles a person's typed amount.
import { parseAmountToCents } from '@/lib/money';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY } from '@/lib/splits';

/**
 * v1.13.0 ruling R4 (item I4). Thrown by createManualTransaction when the row's own category
 * would silently overwrite a merchant rule someone else in the household owns -- confirmCategory
 * refuses (`owned_by_another`) rather than write it. A plain thrown Error is enough for the
 * common caller (manualEntryAction already turns any thrown Error's `.message` into `{ error }`),
 * but a typed subclass lets a caller that needs to tell this refusal apart from any other failure
 * (recordInstallmentPayment, src/lib/warranty/installments.ts) catch it by type instead of
 * matching message text.
 */
export class RuleOwnedRefusal extends Error {
  constructor(readonly ownerName: string) {
    super(ruleOwnedError(ownerName));
  }
}

export interface TransactionFilter {
  accountId?: number | null;
  categoryId?: number | 'uncategorized' | null;
  /**
   * v1.21.0 item 3 (owner's screenshot of the chip row: "filter on page transactions only
   * filter where i directly assign parent and ignore all child"). Only meaningful when
   * `categoryId` is a number:
   *   - false/omitted (what a chip does) -- `categoryId` AND its children match. The category
   *     tree is two levels deep (src/lib/categories.ts), so "children" here means exactly
   *     that: this id plus its direct children, never a general recursive walk for a depth
   *     this app does not have.
   *   - true -- `categoryId` alone matches, no children. What the Budgets "Not in a
   *     sub-category" row's drill-down wants (its own categoryTransactions call, in
   *     src/lib/budgets.ts, already does this filtering a different way for a different
   *     surface -- this is the same answer for the Transactions page).
   * One filter, two stated meanings, neither inferred -- see buildWhere's own comment on
   * categoryMatchClause below for the rest of the reasoning, including why this is also
   * split-aware.
   */
  categoryExact?: boolean;
  attributedUserId?: number | 'unattributed' | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  uncategorizedOnly?: boolean;
  /**
   * v1.24.0 Lane A item 2 (owner report: "currently once i apply a trasnfer its hard to find
   * that data again"). Three states, not a boolean -- a mis-tagged transfer needs a way BACK.
   * REVIEW_WHERE (src/lib/categorize/engine.ts) excludes every transfer unconditionally, so a
   * row wrongly flagged a transfer was already invisible to the review queue before this field
   * existed; the old two-state "hide transfers" checkbox then ALSO hid it from the default list
   * the moment it was flagged, which left no filter anywhere on this page that could ever surface
   * that row again. `'only'` is that recovery path -- the one view that shows transfers and
   * nothing else, so the row can be found and un-flagged.
   *   - `'all'` (default; `undefined` behaves the same) -- no clause, today's behaviour unchanged.
   *   - `'none'` -- ordinary spending only, transfers excluded (the old `includeTransfers: false`).
   *   - `'only'` -- transfers only, nothing else.
   */
  transferView?: 'all' | 'only' | 'none';
  /**
   * v1.14.1 ruling R1. `?review=1` is a filter, not a page: this pushes engine.ts's own
   * REVIEW_WHERE into buildWhere (never restated here) and flips listTransactions to oldest-first
   * order, same as listReviewQueue below always has. Ruling R2 (a self viewer never sees the
   * household-wide queue) is enforced by the CALLER forcing this false, not here -- buildWhere's
   * ownerScope clause below is unconditional regardless, so even an unforced call still narrows to
   * the viewer's own rows.
   */
  reviewOnly?: boolean;
  /**
   * v1.25.0 Lane R item R1 (deferred from v1.20.0). `?queue=suggested` / `?queue=uncategorized`,
   * a chip filter ALONGSIDE `reviewOnly` -- meaningless (and ignored, see buildWhere below) when
   * `reviewOnly` is not also set, since these two states only partition REVIEW_WHERE's own scope.
   * `undefined` (absent, or a hand-edited junk value -- readFilter, page.tsx, never lets anything
   * else through) means both, today's behaviour. See REVIEW_SUGGESTED_WHERE/
   * REVIEW_UNCATEGORIZED_WHERE (src/lib/categorize/engine.ts) for what each one actually means
   * and why it is safe to AND onto REVIEW_WHERE rather than a second, independent definition.
   */
  reviewQueue?: 'suggested' | 'uncategorized';
  /**
   * v1.26.0 Lane 2 item 2. Restrict to rows carrying one `categorization_source` value. The full
   * set the column allows (src/db/schema.ts: the enum is the whole storage domain, and there is no
   * SQL CHECK behind it) -- not just `'rule'` -- because a filter that accepts only the value
   * today's caller wants is a filter the next caller has to widen, and the other three are all
   * answerable questions ("what did Bayes guess", "what have we confirmed by hand", "what has
   * nothing said anything about").
   *
   * `'rule'` is the audit case this release exists for: REVIEW_WHERE (src/lib/categorize/engine.ts)
   * is `category IS NULL OR source = 'bayes'`, so a rule-assigned row is treated as settled and
   * NEVER enters the review queue -- which is correct (rules must not create as much work as they
   * save) and left the household with no surface at all that showed what the rules had done. This
   * field plus `importId` below is that surface: "show me what the rules did to that import".
   *
   * Deliberately one value, not an array. Every caller so far asks about exactly one source, and a
   * set-valued filter would need its own empty-set decision (no rows? all rows?) for no question
   * anybody has.
   */
  source?: CategorizationSource;
  /**
   * v1.26.0 Lane 2 item 2. Restrict to one import batch, served by the existing
   * `transactions_import_idx` (migration 0000, on import_id alone) with no join and no new index.
   *
   * `transactions.import_id` -- the import that INSERTED the row -- is authoritative here, NOT the
   * `transaction_imports` join table, and the two genuinely can disagree. commitImport
   * (src/lib/import/commit.ts) writes import_id once, on insert, and additionally links EVERY row
   * it handled into transaction_imports including rows it recognised as duplicates of an earlier
   * import -- deliberately, because that association is what makes undo safe for overlapping
   * date-range exports (partitionByAssociation). So re-importing an overlapping statement gives an
   * already-present row a second transaction_imports row while its import_id still names the
   * import that first brought it in.
   *
   * The household's question is "what happened in that import" -- the rows it ADDED, which is
   * exactly `imports.rows_added` and exactly what the import summary screen already told them.
   * A duplicate row was not added by the second import; it was already there and its rule
   * assignment was already part of the first import's batch. Auditing it again under the second
   * import would show the household rows they had already dismissed, which is the one thing a
   * dismissible batch must not do.
   *
   * One consequence, stated rather than hidden: undoing an import sets import_id to NULL on any row
   * that SURVIVES the undo (imports.import_id is ON DELETE SET NULL, and a row shared with a second
   * import is kept). Such a row keeps its transaction_imports link to the surviving import but
   * belongs to no batch by this filter. That is the honest answer -- the batch it was audited under
   * no longer exists, and the surviving import never added it -- and it is a row the household has
   * already seen twice.
   */
  importId?: number | null;
  /**
   * v1.26.0 Lane 2 item 1. Which column orders the list. `undefined` -- the ONLY default -- leaves
   * listTransactions' order exactly as it has always been: newest first, or oldest first while
   * `reviewOnly` is set (working a queue front-to-back). `direction` below is read only when this
   * is set, so a caller that passes a direction and no sort changes nothing.
   *
   * `'category'` sorts by category NAME, never by id -- an id order is meaningless to a person. It
   * needs no join of its own: baseQuery already LEFT JOINs `categories` on `transactions.categoryId`
   * to select `categoryName` for the row, and that join is on a primary key so it matches at most
   * one row and cannot fan a transaction out into several. A correlated `(select name from
   * categories where id = category_id)` in the ORDER BY would have produced the identical order at
   * the cost of a second lookup per row for a column already in hand.
   *
   * That also settles which category a SPLIT transaction sorts by: its own `category_id`, the same
   * value the list DISPLAYS in that row's category cell -- not its parts'. A split has no single
   * category (that is what makes it a split), so sorting it by anything other than what the row
   * shows would put it somewhere the reader cannot account for. In practice a split row's own
   * category_id is usually NULL (setTransactionSplits never invents or overwrites it, see
   * src/lib/splits.ts), so it lands with the uncategorized rows -- last, per `direction` below.
   * The GROUPED aggregate is the surface that decomposes a split across its parts'
   * categories (groupTransactionsByCategory, below); the flat list is one row per transaction.
   */
  sort?: TransactionSort;
  /**
   * v1.26.0 Lane 2 item 1. Read only when `sort` is set (see above); defaults to `'desc'` there,
   * matching the page's own long-standing newest-first default rather than inventing a second one.
   *
   * Under `sort: 'category'` an UNCATEGORIZED row sorts LAST in BOTH directions, which is why this
   * is not simply an ASC/DESC flip. "No category" is not a name: it does not belong at either end
   * of an alphabet, and SQLite would otherwise put it first under ASC and last under DESC purely
   * because NULL sorts low -- so half the time the reader's first screenful would be rows with
   * nothing in the column they just asked to sort by. Last in both directions makes the answer to
   * "sort by category" the same shape whichever way it is pointed: named categories in the order
   * asked, then the rows that have none.
   */
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
}

/**
 * v1.26.0 Lane 2 item 2. The whole domain of `transactions.categorization_source`, mirrored from
 * src/db/schema.ts and identical to TransactionRow.source below -- exported so a caller
 * (a route's zod schema, a URL reader) can enumerate the accepted values instead of restating them.
 */
export type CategorizationSource = 'rule' | 'bayes' | 'manual' | 'none';

/** v1.26.0 Lane 2 item 1. See TransactionFilter.sort. */
export type TransactionSort = 'date' | 'amount' | 'category';

/** v1.26.0 Lane 2 item 1. See TransactionFilter.direction. */
export type SortDirection = 'asc' | 'desc';

export interface TransactionRow {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  rawDescription: string;
  /** Spec v1.4: what the UI shows when set; raw_description is the fallback. */
  displayDescription: string | null;
  displaySource: 'manual' | 'rename' | 'loan' | null;
  normalizedMerchant: string;
  amountCents: number;
  categoryId: number | null;
  categoryName: string | null;
  source: 'rule' | 'bayes' | 'manual' | 'none';
  confidence: number | null;
  isTransfer: boolean;
  attributedUserId: number | null;
  attributedUserName: string | null;
  notes: string | null;
  importId: number | null;
}

export interface TransactionPage {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /**
   * F-02 (v1.31.0, owner's question: "how much went on the Visa this month?"). Signed sums over
   * the WHOLE filtered set (every page, not just `rows`), same `where` as `total` -- see
   * listTransactions for why that is one query, not two.
   *
   * `outCents` is spending: the sum of every NEGATIVE `amountCents` row, so it is itself negative
   * (or zero). `inCents` is the sum of every POSITIVE row. Two figures, never netted into one,
   * because a `transferView: 'all'` view of a credit card includes the payment TO the card as a
   * positive row -- netting it against the card's own spending would make that payment vanish
   * into a smaller "spent" number instead of showing up as the money it plainly is. See
   * groupTransactionsByCategory's own doc comment for why this pair is NOT `SPEND_ROW_WHERE`
   * (src/lib/spend-where.ts): that module answers "does this count as spend at all" for budgets
   * and reports, a question this filtered view deliberately does not ask -- a `transfers=all`
   * reader wants to see every row the list shows summed, not a curated subset of them.
   *
   * NOT split-aware -- the parent row's own `amountCents`, the same column the flat list itself
   * displays and the same one `total`'s `where` already runs over. `groupTransactionsByCategory`'s
   * `outCents`/`inCents` are the split-aware pair for the surface that decomposes a transaction
   * across categories; this is the flat list's own total, on purpose (see that function's doc
   * comment for the fuller reasoning it already carries about the two surfaces).
   */
  outCents: number;
  inCents: number;
}

export const manualTransactionSchema = z.object({
  accountId: z.number().int().positive(),
  date: z.string().refine(isIsoDate, 'Date must be YYYY-MM-DD'),
  description: z.string().trim().min(1, 'Description is required').max(300),
  amountCents: z.number().int(),
  categoryId: z.number().int().positive().nullable(),
  attributedUserId: z.number().int().positive().nullable(),
  notes: z.string().trim().max(500).nullable().optional(),
});

/** Spec v1.4: display_description when set, raw_description otherwise. */
export function displayNameOf(row: Pick<TransactionRow, 'rawDescription' | 'displayDescription'>): string {
  return row.displayDescription !== null && row.displayDescription.length > 0 ? row.displayDescription : row.rawDescription;
}

const SELECTION = {
  id: transactions.id,
  date: transactions.date,
  accountId: transactions.accountId,
  accountName: accounts.name,
  rawDescription: transactions.rawDescription,
  displayDescription: transactions.displayDescription,
  displaySource: transactions.displaySource,
  normalizedMerchant: transactions.normalizedMerchant,
  amountCents: transactions.amountCents,
  categoryId: transactions.categoryId,
  categoryName: categories.name,
  source: transactions.categorizationSource,
  confidence: transactions.confidence,
  isTransfer: transactions.isTransfer,
  attributedUserId: transactions.attributedUserId,
  attributedUserName: users.name,
  notes: transactions.notes,
  importId: transactions.importId,
} as const;

function baseQuery() {
  return getDb()
    .select(SELECTION)
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(users, eq(users.id, transactions.attributedUserId));
}

/**
 * SQL LIKE gives % and _ wildcard meaning, so a user searching for "50%" was matching
 * "50" followed by anything, and "_" matched any single character. Neither is a security
 * hole (the needle is still a bound parameter), but both are silently wrong results.
 * Escaping them (and the escape character itself, first) with an explicit ESCAPE clause
 * makes the search literal, which is what a search box in a finance app should be.
 */
const LIKE_ESCAPE = '\\';

function escapeLikeNeedle(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

/**
 * v1.21.0 item 3. `categoryId`'s children -- this id plus every category with it as a
 * `parentId` (src/db/schema.ts). The tree is two levels deep, so this is deliberately a flat
 * lookup, not a recursive walk: there is no grandchild to find. Archived children are
 * included on purpose, matching foldRollup's own archived-inclusive child list in
 * src/lib/budgets.ts -- a chip for "Health" must still find a transaction filed under a
 * since-archived "Dental" before it was archived, the same way the Health budget card's own
 * total already counts that spend.
 */
function descendantCategoryIds(categoryId: number): number[] {
  const children = getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId))
    .all();
  return [categoryId, ...children.map((row) => row.id)];
}

/**
 * "Which rows are in this category?" -- the same question foldRollup (src/lib/budgets.ts) and
 * categoryBreakdown's `parentId ?? categoryId` (src/lib/reports.ts) already answer for a
 * budget total and a report total. This is that answer for the Transactions list: `exact`
 * false matches `categoryId` and its children (descendantCategoryIds above); `exact` true
 * matches `categoryId` alone (see TransactionFilter.categoryExact's own doc comment).
 *
 * Split-aware, matching every other total in the app (EFFECTIVE_CATEGORY, src/lib/splits.ts):
 * a transaction with splits is tested on its PARTS' own categories, never on its own
 * (possibly stale, possibly absent) top-level categoryId, and a transaction with no splits
 * falls back to that column exactly as before -- so a $50 split to Health now shows up when
 * Transactions is filtered by Health, the same way it already counted toward the Health
 * budget.
 *
 * Built as two correlated EXISTS/NOT EXISTS checks, the same idiom REVIEW_WHERE (engine.ts)
 * already uses for the same reason: a LEFT JOIN onto transaction_splits would return one row
 * per split PART for a split transaction, which is right for an aggregate's GROUP BY
 * (categorySpend, categoryBreakdown) but wrong here -- listTransactions returns one row per
 * TRANSACTION, and a join would silently duplicate a split row's parent across the page and
 * inflate `total`/pageCount along with it.
 */
function categoryMatchClause(categoryId: number, exact: boolean): SQL {
  const ids = exact ? [categoryId] : descendantCategoryIds(categoryId);
  return sql`(
    exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id} and ${inArray(transactionSplits.categoryId, ids)})
    or (
      not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})
      and ${inArray(transactions.categoryId, ids)}
    )
  )`;
}

function buildWhere(filter: TransactionFilter, viewer: Viewer): SQL | undefined {
  const clauses: SQL[] = [];
  if (typeof filter.accountId === 'number') clauses.push(eq(transactions.accountId, filter.accountId));

  if (filter.categoryId === 'uncategorized') clauses.push(isNull(transactions.categoryId));
  else if (typeof filter.categoryId === 'number')
    clauses.push(categoryMatchClause(filter.categoryId, filter.categoryExact === true));

  if (filter.attributedUserId === 'unattributed') clauses.push(isNull(transactions.attributedUserId));
  else if (typeof filter.attributedUserId === 'number') clauses.push(eq(transactions.attributedUserId, filter.attributedUserId));

  // v1.13.0 ruling R2. Appended AFTER the caller's own person clause, never instead of it: a self
  // viewer who asks for somebody else must get an unsatisfiable AND (zero rows), not a filter
  // silently rewritten to themselves. A rewrite would show them their own spending under another
  // person's name, which is a worse answer than an empty page.
  const scope = ownerScope(viewer);
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));

  if (filter.from) clauses.push(gte(transactions.date, filter.from));
  if (filter.to) clauses.push(lte(transactions.date, filter.to));

  if (filter.search && filter.search.trim().length > 0) {
    const trimmedSearch = filter.search.trim();
    const needle = `%${escapeLikeNeedle(trimmedSearch.toUpperCase())}%`;
    /**
     * F-07 (v1.31.0, owner's question: "Where is that $47.13 charge the bank called about?"). The
     * bank gives a person an amount, not a name, and the search box only ever matched text -- so
     * one more OR arm, added only when the trimmed query itself parses as money.
     *
     * `parseAmountToCents` (src/lib/money.ts) is reused rather than re-derived: it is already the
     * app's one reader of "money a person typed" (the split editor's own amount fields), so a typed
     * "$47.13", "47.13" or "(47.13)" all resolve to the same 4713 this reaches for. `abs()` on the
     * column, not a signed match, because a person calling about a charge does not know or care
     * whether the ledger stores it negative -- the bank told them a magnitude, and $47.13 flags both
     * a $47.13 purchase and, on the rare chance one exists, a $47.13 refund.
     *
     * Rejected: a SEPARATE amount field/URL parameter alongside `q`. The controller notes are
     * explicit that this needs no new control -- sort-by-amount (v1.26.0) already exists for
     * someone scanning by eye, and a second box would just be a second place to type the same
     * number the search box already accepts every other kind of query in. `parseAmountToCents`
     * returning null for plain text (e.g. "COSTCO") is exactly what keeps this arm silent for
     * every search that was never about an amount, with no extra state to keep in sync.
     */
    const amountCents = parseAmountToCents(trimmedSearch);
    const clause = or(
      sql`upper(${transactions.rawDescription}) like ${needle} escape ${LIKE_ESCAPE}`,
      sql`upper(${transactions.normalizedMerchant}) like ${needle} escape ${LIKE_ESCAPE}`,
      // Search what the user can actually see, too (spec v1.4 display names).
      sql`upper(coalesce(${transactions.displayDescription}, '')) like ${needle} escape ${LIKE_ESCAPE}`,
      // v1.13.0 ruling R13. The merchant half of that ruling needed no edit -- normalizedMerchant is
      // already in this OR, one line above, and a second clause over the same column would be a
      // duplicate rather than a fix. No FTS5 index: ruling R13 says LIKE, and the warranty side's
      // index exists because it also covers OCR'd receipt text, which has no analogue here.
      sql`upper(coalesce(${transactions.notes}, '')) like ${needle} escape ${LIKE_ESCAPE}`,
      // or() drops `undefined` arms silently (drizzle-orm), so a non-money query adds nothing here.
      amountCents === null ? undefined : sql`abs(${transactions.amountCents}) = ${amountCents}`,
    );
    if (clause) clauses.push(clause);
  }

  if (filter.uncategorizedOnly) clauses.push(isNull(transactions.categoryId));
  // v1.24.0 Lane A item 2: see TransactionFilter.transferView's own doc comment for why 'only'
  // exists at all -- it is the recovery path for a transfer REVIEW_WHERE (below) can never show.
  if (filter.transferView === 'none') clauses.push(eq(transactions.isTransfer, false));
  else if (filter.transferView === 'only') clauses.push(eq(transactions.isTransfer, true));
  // Ruling R1: the queue definition lives in engine.ts and is imported, never restated. and()'s
  // return type is `SQL | undefined` regardless of argument count -- REVIEW_WHERE is built from
  // three fixed clauses and is never actually undefined at runtime, but the guard keeps this
  // array's element type honest.
  if (filter.reviewOnly && REVIEW_WHERE) {
    clauses.push(REVIEW_WHERE);
    // v1.25.0 Lane R item R1: NARROWS REVIEW_WHERE (this file's own `and(...)` below combines
    // every pushed clause), never stands in for it -- a `?queue=` value only ever adds a clause
    // on top of the queue REVIEW_WHERE already defines, so a row REVIEW_WHERE excludes (a
    // transfer, a split, a loan-linked row) stays excluded no matter which chip is active.
    // Same `and()`-returns-`SQL | undefined` guard as REVIEW_WHERE above: REVIEW_SUGGESTED_WHERE
    // is built from two fixed clauses and is never actually undefined at runtime either.
    if (filter.reviewQueue === 'suggested' && REVIEW_SUGGESTED_WHERE) clauses.push(REVIEW_SUGGESTED_WHERE);
    else if (filter.reviewQueue === 'uncategorized') clauses.push(REVIEW_UNCATEGORIZED_WHERE);
  }

  // v1.26.0 Lane 2 item 2. Both plain equality on an indexed transactions column, both pushed onto
  // the same array every other filter uses -- so they compose with the rest (and with each other:
  // `{ source: 'rule', importId: 7 }` is the audit view's whole query) rather than being a second
  // entry point with its own rules. See their own doc comments on TransactionFilter above for why
  // import_id and not transaction_imports.
  if (filter.source !== undefined) clauses.push(eq(transactions.categorizationSource, filter.source));
  if (typeof filter.importId === 'number') clauses.push(eq(transactions.importId, filter.importId));

  if (clauses.length === 0) return undefined;
  return and(...clauses);
}

/**
 * v1.26.0 Lane 2 item 1. The ORDER BY for listTransactions, in one place so the default and the
 * three chosen sorts cannot drift apart.
 *
 * `filter.sort === undefined` returns EXACTLY what this function's caller did before this release:
 * `desc(date), desc(id)`, or `asc(date), asc(id)` while reviewOnly is set. Ruling R1's oldest-first
 * queue order is a property of the queue, not a sort the reader picked, so it stays the default for
 * that filter and is overridable by an explicit `sort` like any other default.
 *
 * EVERY branch ends in `id`, and that is not decoration. Without a unique final key, SQLite is free
 * to return rows with equal sort keys in any order it likes, and it does not have to pick the same
 * order twice -- so two rows on the same date (extremely common: one statement, one day) or with the
 * same amount (a $4.50 coffee twice) can swap places between the query for page 1 and the query for
 * page 2, which means LIMIT/OFFSET can show one of them on both pages and the other on neither. The
 * household would see a duplicated row and a silently missing row, on a page whose `total` says
 * neither happened. `id` is the primary key, so appending it makes the full ordering a total order
 * and pagination reproducible. Same reason the pre-existing default already carried it.
 *
 * The tiebreaker follows the requested direction rather than being pinned ascending, matching the
 * existing default's own desc/desc and asc/asc pairs: determinism is what pagination needs, and
 * either choice is deterministic.
 */
function orderByFor(filter: TransactionFilter): SQL[] {
  if (filter.sort === undefined) {
    return filter.reviewOnly
      ? [asc(transactions.date), asc(transactions.id)]
      : [desc(transactions.date), desc(transactions.id)];
  }
  const dir = filter.direction === 'asc' ? asc : desc;
  switch (filter.sort) {
    case 'amount':
      return [dir(transactions.amountCents), dir(transactions.id)];
    case 'category':
      // Uncategorized last in BOTH directions (see TransactionFilter.direction). A leading
      // always-ascending 0/1 rank does that in one expression: named rows rank 0 and sort among
      // themselves by name in the asked-for direction, and the nameless ones all rank 1 and land
      // after them whichever way `dir` points. `categories.name` is the column baseQuery already
      // left-joins for the row's own categoryName -- no second join, no correlated lookup.
      return [sql`case when ${categories.name} is null then 1 else 0 end`, dir(categories.name), dir(transactions.id)];
    case 'date':
      return [dir(transactions.date), dir(transactions.id)];
  }
}

/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED, not optional. An optional parameter lets a forgotten call
 * site compile into a silent leak; a required one makes the compiler name every page that has to
 * decide what it is showing and to whom.
 */
export function listTransactions(filter: TransactionFilter, viewer: Viewer): TransactionPage {
  const pageSize = Math.min(200, Math.max(1, filter.pageSize && filter.pageSize > 0 ? filter.pageSize : 50));
  const page = Math.max(1, filter.page ?? 1);
  const where = buildWhere(filter, viewer);

  // F-02 (v1.31.0): the count and the two filtered sums ride the SAME query as `where` -- one more
  // pass over an already-scanned set of rows, not a second query, and (the point of doing it here
  // rather than in a caller) the identical `where` the row page below runs, so the footer can never
  // sum a wider or narrower set than the rows it sits under.
  const totalRow = getDb()
    .select({
      c: sql<number>`count(*)`,
      outCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} < 0 then ${transactions.amountCents} else 0 end), 0)`,
      inCents: sql<number>`coalesce(sum(case when ${transactions.amountCents} > 0 then ${transactions.amountCents} else 0 end), 0)`,
    })
    .from(transactions)
    .where(where)
    .get();
  const total = totalRow?.c ?? 0;
  const outCents = totalRow?.outCents ?? 0;
  const inCents = totalRow?.inCents ?? 0;

  const query = baseQuery();
  // v1.26.0 Lane 2 item 1: the order moved into orderByFor (above), which returns the identical
  // default -- ruling R1's oldest-first while working the queue, newest-first otherwise -- when no
  // `sort` is asked for. See that function for why every ordering ends in `id`.
  const rows = (where ? query.where(where) : query)
    .orderBy(...orderByFor(filter))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), outCents, inCents };
}

/** v1.26.0 Lane 2 item 3. One category cluster within a filtered set. See CategoryGroupPage. */
export interface CategoryGroupRow {
  /** null is the uncategorized cluster; `categoryName` is already labelled for it. */
  categoryId: number | null;
  /**
   * The DISPLAY label, not the raw column: 'Uncategorized' for the null group, and
   * '<name> — not in a sub-category' for a parent category that also has children. Both labels are
   * lifted verbatim from categoryBreakdown (src/lib/reports.ts) rather than reinvented -- see
   * groupTransactionsByCategory's own comment for why the second one matters here too.
   */
  categoryName: string;
  /** The category's own parent, for a caller that wants to nest. null for a top-level or the null group. */
  parentId: number | null;
  /** DISTINCT transactions in this cluster, not join rows -- see groupTransactionsByCategory. */
  count: number;
  /** Signed net, integer cents. Negative is spending, matching every other total in this app. */
  totalCents: number;
}

/**
 * v1.26.0 Lane 2 item 3. A page of category clusters, plus the totals for the WHOLE filtered set.
 * See groupTransactionsByCategory for what is and is not double-counted.
 */
export interface CategoryGroupPage {
  groups: CategoryGroupRow[];
  /** Group pagination -- NOT row pagination. `filter.page`/`filter.pageSize` are ignored. */
  page: number;
  pageSize: number;
  pageCount: number;
  /** How many clusters the filter produces in total, across every page. */
  groupCount: number;
  /**
   * DISTINCT transactions in the whole filtered set -- byte-identical to
   * listTransactions(filter, viewer).total for the same filter and viewer, because it is the same
   * count query. Deliberately NOT the sum of `groups[].count`, which can be larger: a split
   * transaction is one row in the list and a member of every one of its parts' clusters.
   */
  totalCount: number;
  /**
   * Signed net across every cluster, integer cents. This one DOES equal the sum of
   * `groups[].totalCents`: a split's parts sum exactly to its parent's amount (the invariant
   * setTransactionSplits enforces, src/lib/splits.ts), so decomposing a transaction across
   * categories moves money between clusters without creating or destroying any.
   */
  totalCents: number;
  /**
   * F-02 (v1.31.0). The split-aware pair of TransactionPage.outCents/inCents -- see that field's
   * own doc comment for why the two figures are never netted into one. `totalCents` above already
   * exists and IS split-aware (its own doc comment), but it is a net; recovering "how much went
   * out" from a net figure alone is impossible the moment a `transfers: 'all'` view mixes spending
   * with an incoming card payment, which is the exact case this pair exists to keep visible.
   *
   * Deliberately NOT `groups.reduce` over each cluster's own `totalCents`, bucketed by that
   * cluster's sign. A single category can hold both a purchase and a refund (a return filed to the
   * same category it was bought under), and a cluster's own net could land positive while still
   * containing real spending -- bucketing at the CLUSTER level would silently fold that spending
   * into "in". These are summed the same way TransactionPage's pair is: bucketed by the SIGN OF
   * EACH ROW (here, each split PART, via EFFECTIVE_AMOUNT) before summing, which is the only
   * bucketing that cannot disagree with what a person would get by tallying the list by hand.
   */
  outCents: number;
  inCents: number;
}

/**
 * v1.26.0 Lane 2 item 3. "For this filter, which categories, how many rows each, how much each" --
 * ordered largest absolute total first, so the cluster most worth checking is at the top.
 *
 * The audit view's reason for existing: a filter of `{ source: 'rule', importId: N }` answers "what
 * did the rules do to that import" as a handful of clusters a person can scan and dismiss, instead
 * of 300 rows they will not read. Largest ABSOLUTE total, not largest negative: a rule that
 * misfiled an income deposit is exactly as worth checking as one that misfiled a big expense, and
 * signed ordering would bury it at the bottom under every ordinary purchase.
 *
 * A SEPARATE function from listTransactions, on purpose. The paginated row query returns one row
 * per TRANSACTION and its `total`/`pageCount` depend on that; grouping needs a LEFT JOIN onto
 * transaction_splits that returns one row per split PART. Making one query serve both would mean
 * either a grouped query that cannot page rows or a row query whose totals are inflated by splits
 * -- the exact double-count this codebase has already paid for. Two queries, two shapes, one shared
 * `buildWhere`.
 *
 * SPLIT-AWARE, which is the thing most likely to be silently wrong here. `EFFECTIVE_CATEGORY` /
 * `EFFECTIVE_AMOUNT` (src/lib/splits.ts) over a LEFT JOIN of transaction_splits is the same idiom
 * categoryBreakdown (src/lib/reports.ts) and personSpendSplit already use: a split transaction
 * contributes each PART to that part's own category at that part's own amount, and a transaction
 * with no splits falls through the coalesce to its own two columns unchanged. A $50 transaction
 * split $30 Health / $20 Groceries therefore adds $30 to Health and $20 to Groceries -- never $50
 * to both (which is what a naive join plus `sum(amount_cents)` does, and it looks plausible in
 * every test that has no split in it), and never $50 to its own stale top-level category.
 *
 * `count` is `count(distinct transactions.id)`, not `count(*)`. Two things force it: nothing forbids
 * a split from putting two parts in the SAME category (setTransactionSplits dedupes categoryIds only
 * for its existence/archived check), so `count(*)` would report one transaction as two rows in that
 * cluster; and "count" on a screen that says "N transactions, $X" has to mean transactions. The sum
 * still adds BOTH parts, which is correct -- the money really is doubled up in that category, the
 * transaction is not.
 *
 * EVERY existing filter is honoured, because the WHERE comes from `buildWhere` -- the identical
 * clause list listTransactions builds, from the identical `filter` object, including the viewer's
 * ownerScope. There is no second filter path to keep in step and therefore no way for the groups to
 * describe a different set than the list: if they could disagree, the numbers on screen would be a
 * lie, which is the failure mode this codebase has paid for repeatedly. The one restatement is
 * `totalCount`, which runs the same `count(*)` query listTransactions runs for its own `total`.
 *
 * One consequence of being split-aware while the filter is split-aware, stated rather than
 * discovered: `categoryId` (categoryMatchClause) selects a split transaction if ANY of its parts
 * match, and this function then decomposes that whole transaction, so the OTHER parts' categories
 * appear as clusters too. That is the honest breakdown of the transactions in view -- the list shows
 * that transaction, and this says where its money actually went -- and it is what categoryBreakdown
 * already does for a filtered date range. It cannot arise in the audit case at all: splitting a row
 * stamps `categorization_source = 'manual'` (src/lib/splits.ts), so no row with splits can ever
 * match `source: 'rule'`.
 *
 * PAGINATION IS BY GROUP, never by row, and it is driven by the THIRD argument -- `filter.page` and
 * `filter.pageSize` are ignored here. That separation is the point: the caller passes ONE filter
 * object to both listTransactions and this function, and the row page it is currently showing must
 * not silently decide which clusters it is told about. Paging by group is also the only option that
 * does not defeat the feature: the row list pages at 50, so a cluster straddling a row-page boundary
 * would show the household half of it with no sign there was more -- whereas a group is the unit
 * being scanned, and every group here carries its FULL count and subtotal no matter how many pages
 * of rows it spans. `pageSize` defaults to 25 groups and clamps to 1..200, the same clamp
 * listTransactions applies to rows.
 *
 * Grouping happens in ONE query with no LIMIT, and the page is sliced in memory. That is
 * deliberate, not laziness: the number of clusters is bounded by the size of the category tree plus
 * one (a household-managed list of tens -- the seed ships about forty), so a second COUNT query for
 * `groupCount` would cost more than materialising the groups, and slicing locally is what lets
 * `groupCount`/`totalCents` describe the whole filtered set rather than just the visible page.
 *
 * `viewer` is REQUIRED for the same reason it is on listTransactions (v1.13.0 ruling R2): an
 * optional viewer lets a forgotten call site compile into a silent leak.
 */
export function groupTransactionsByCategory(
  filter: TransactionFilter,
  viewer: Viewer,
  paging?: { page?: number; pageSize?: number },
): CategoryGroupPage {
  const pageSize = Math.min(200, Math.max(1, paging?.pageSize && paging.pageSize > 0 ? paging.pageSize : 25));
  const page = Math.max(1, paging?.page ?? 1);
  const where = buildWhere(filter, viewer);

  const rows = getDb()
    .select({
      categoryId: EFFECTIVE_CATEGORY,
      categoryName: categories.name,
      parentId: categories.parentId,
      count: sql<number>`count(distinct ${transactions.id})`,
      totalCents: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    // Joined on EFFECTIVE_CATEGORY, not on transactions.categoryId: a split part's cluster must be
    // named after the PART's category. No isArchived filter -- a since-archived category still has
    // to name the money already filed under it, the same archived-inclusive choice
    // descendantCategoryIds and foldRollup (src/lib/budgets.ts) already make.
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(where)
    // Grouped by id AND name so two categories that happen to share a name stay two clusters.
    .groupBy(EFFECTIVE_CATEGORY, categories.name)
    .all();

  // The same count listTransactions computes for its own `total`, over the same WHERE and with no
  // splits join -- so "N transactions" on the group header and "N" on the list can never disagree.
  const totalRow = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get();

  // F-02 (v1.31.0). CategoryGroupRow.outCents/inCents's own doc comment argues why this cannot be
  // `groups.reduce` bucketed by each cluster's net -- so it is instead its own query, joined and
  // bucketed the same way the `rows` query above is (EFFECTIVE_AMOUNT over the transactionSplits
  // LEFT JOIN), just with no GROUP BY: one pass bucketing every PART by its own sign, over the
  // identical `where` every other total in this function already shares.
  const totalsBySignRow = getDb()
    .select({
      outCents: sql<number>`coalesce(sum(case when ${EFFECTIVE_AMOUNT} < 0 then ${EFFECTIVE_AMOUNT} else 0 end), 0)`,
      inCents: sql<number>`coalesce(sum(case when ${EFFECTIVE_AMOUNT} > 0 then ${EFFECTIVE_AMOUNT} else 0 end), 0)`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(where)
    .get();

  // v1.21.0 item 2's label, carried here for the same reason reports.ts carries it: a cluster keyed
  // by a PARENT category id is only the money filed DIRECTLY on that parent, never on its children,
  // and printing the parent's bare name next to that figure reads exactly like the parent's total.
  // `parentIds` is "category ids that are somebody's parentId"; a top-level category with no
  // children has nothing to be confused with and keeps its plain name.
  const parentIds = new Set(
    getDb()
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(isNotNull(categories.parentId))
      .all()
      .map((row) => row.parentId as number),
  );

  const groups: CategoryGroupRow[] = rows.map((row) => {
    const name = row.categoryName;
    const label =
      name === null
        ? 'Uncategorized'
        : row.categoryId !== null && parentIds.has(row.categoryId)
          ? `${name} — not in a sub-category`
          : name;
    return {
      categoryId: row.categoryId,
      categoryName: label,
      parentId: row.parentId,
      count: row.count,
      // sum() over an empty group cannot happen (a group exists because a row is in it), but SQLite
      // types it nullable, so coalesce in TS rather than pretend.
      totalCents: row.totalCents ?? 0,
    };
  });

  // Largest absolute total first. Then name, then id -- a total order, for exactly the reason the
  // row list's ORDER BY ends in `id` (see orderByFor): without it, two clusters with equal absolute
  // totals could swap between the call that renders group page 1 and the call that renders page 2,
  // and the slice below would show one twice and the other never.
  groups.sort(
    (a, b) =>
      Math.abs(b.totalCents) - Math.abs(a.totalCents) ||
      a.categoryName.localeCompare(b.categoryName) ||
      (a.categoryId ?? -1) - (b.categoryId ?? -1),
  );

  const groupCount = groups.length;
  return {
    groups: groups.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(groupCount / pageSize)),
    groupCount,
    totalCount: totalRow?.c ?? 0,
    totalCents: groups.reduce((sum, group) => sum + group.totalCents, 0),
    outCents: totalsBySignRow?.outCents ?? 0,
    inCents: totalsBySignRow?.inCents ?? 0,
  };
}

/**
 * null for a row outside the viewer's scope -- deliberately the same answer as "no such row", and
 * deliberately not a throw. The warranty detail page looks a linked transaction up by id
 * (src/app/(app)/warranties/[id]/page.tsx), and it already renders "no link" for a transaction that
 * no longer exists; a foreign transaction takes the same path with no extra branch, and the caller
 * cannot tell the two apart, which is the point.
 */
export function getTransaction(id: number, viewer: Viewer): TransactionRow | null {
  const scope = ownerScope(viewer);
  const where = scope === null
    ? eq(transactions.id, id)
    : and(eq(transactions.id, id), eq(transactions.attributedUserId, scope));
  return baseQuery().where(where).get() ?? null;
}

/**
 * Owner ids for a set of transaction ids, in ONE query.
 *
 * v1.13.1 (item BL, ruling P14). This is NOT a read-model and deliberately returns no money, no
 * description and no merchant -- it is the narrow half of an ownership pre-check that used to
 * run getTransaction (three joins and the full SELECTION) once per selected id on every bulk
 * action, for a check that needs one column.
 *
 * An id with no row is ABSENT from the map rather than present with a null owner, because the
 * caller has to keep telling those two apart: "no such row" and "not yours" are the same
 * refusal (see getTransaction's own comment) and a household viewer POSTing a bogus id is
 * refused today and must stay refused.
 */
export function transactionOwners(ids: number[]): Map<number, number | null> {
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .select({ id: transactions.id, attributedUserId: transactions.attributedUserId })
    .from(transactions)
    .where(inArray(transactions.id, ids))
    .all();
  return new Map(rows.map((row) => [row.id, row.attributedUserId]));
}

export function createManualTransaction(input: {
  accountId: number;
  date: string;
  description: string;
  amountCents: number;
  categoryId: number | null;
  attributedUserId: number | null;
  notes?: string | null;
  userId: number;
  /**
   * v1.13.0 ruling R4 (item I4). The ACTOR's role, threaded to confirmCategory below exactly
   * the way transactions/actions.ts already threads it for setCategoryAction/bulkCategorizeAction
   * -- without this, a member's quick-add (createRule defaults ON here) could silently overwrite
   * a merchant rule someone else in the household owns. Required, not optional, so a forgotten
   * call site fails to compile instead of silently defaulting to admin.
   */
  actorRole: 'admin' | 'member';
}): number {
  const parsed = manualTransactionSchema.parse({
    accountId: input.accountId,
    date: input.date,
    description: input.description,
    amountCents: input.amountCents,
    categoryId: input.categoryId,
    attributedUserId: input.attributedUserId,
    notes: input.notes ?? null,
  });

  const account = getAccount(parsed.accountId);
  if (!account) throw new Error(`No account ${parsed.accountId}`);
  const timestamp = nowIso();
  const db = getDb();

  // v1.13.0 ruling R4 (item I4): the insert, the engine run and the category confirm are all
  // one db.transaction() so a rule-ownership refusal below can roll the ROW ITSELF back, not
  // just skip setting its category -- "no row" is what a refused quick-add must leave behind,
  // not an uncategorized one. Same pattern bulkSetCategory (this file) and recordInstallmentPayment
  // (src/lib/warranty/installments.ts) already use for the same reason.
  return db.transaction(() => {
    const row = db
      .insert(transactions)
      .values({
        accountId: parsed.accountId,
        importId: null,
        attributedUserId: parsed.attributedUserId ?? account.ownerUserId ?? null,
        date: parsed.date,
        rawDescription: parsed.description,
        normalizedMerchant: normalizeMerchant(parsed.description),
        amountCents: parsed.amountCents,
        categoryId: null,
        categorizationSource: 'none',
        confidence: null,
        isTransfer: false,
        notes: parsed.notes ?? null,
        // Manual entries are exempt from dedup: two identical $5 coffees are legitimate.
        dedupHash: null,
        hashVersion: 1,
        createdBy: input.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: transactions.id })
      .get();

    // The engine runs on manual entries too, always. A hand-typed "TD VISA PAYMENT" is
    // just as much a transfer as an imported one, and rename rules should apply to the
    // display name either way. Previously a manual entry that arrived WITH a category
    // skipped the engine entirely, so it could never be flagged as a transfer.
    //
    // Order matters: runEngine's eligibility filter only touches rows that are
    // uncategorized or Bayes-guessed, so it has to see this row before confirmCategory
    // stamps source='manual' on it. confirmCategory then overwrites whatever the engine
    // guessed with the user's explicit choice, and never touches is_transfer or the
    // display columns, so the manual category survives and the transfer flag sticks.
    runEngine([row.id]);
    if (parsed.categoryId !== null) {
      // v1.27.0 item 1: `createRule` spelled out rather than left to confirmCategory's `!== false`
      // default. Behaviour is identical -- hand-typing a transaction with a category has always
      // taught that merchant's rule -- but tests/ops/rule-authoring-intent.test.ts requires every
      // call site that can author a merchant rule to say so at the call, and an omitted optional
      // flag is exactly the silence that made the v1.27.0 loan bug invisible.
      const result = confirmCategory({
        transactionId: row.id,
        categoryId: parsed.categoryId,
        userId: input.userId,
        createRule: true,
        actorRole: input.actorRole,
      });
      if (!result.ok) {
        if (result.reason === 'owned_by_another') throw new RuleOwnedRefusal(result.ownerName);
        // 'has_splits' is unreachable for a row this function just inserted (it has no splits
        // yet) -- handled rather than silently ignored, so a future change to confirmCategory's
        // guard cannot silently drop this branch on the floor.
        throw new Error('Could not set the category.');
      }
    }
    // MUST-13.7: a hand-typed loan payment is a loan payment. Runs after confirmCategory so
    // the row is in its final state, and is cheap when no loan rules exist.
    applyPaymentMatchers([row.id]);
    return row.id;
  });
}

export function updateTransactionNotes(id: number, notes: string | null): void {
  getDb().update(transactions).set({ notes, updatedAt: nowIso() }).where(eq(transactions.id, id)).run();
}

/** Attribution edits never touch created_by (who entered it). Only who spent it. */
export function bulkSetAttribution(ids: number[], attributedUserId: number | null): number {
  if (ids.length === 0) return 0;
  const result = getDb()
    .update(transactions)
    .set({ attributedUserId, updatedAt: nowIso() })
    .where(inArray(transactions.id, ids))
    .run();
  return Number(result.changes ?? 0);
}

/**
 * v1.25.0 Lane R item R3. Bulk note: sets the same note on every selected row. Like
 * bulkSetAttribution just above (and for the same reason -- see that function's own doc
 * comment), this is NOT subject to the split guard confirmCategory/setTransferFlag enforce: a
 * note is metadata ABOUT the transaction record, never a claim about which category the money
 * belongs to or whether it is a transfer, so it carries none of the risk that guard exists to
 * prevent (poisoning the categorizer, or erasing a split's own per-part categorization). The
 * per-row "Note…" kebab item (transactions-client.tsx) already writes a split row's note today
 * with no guard of its own -- this is that same behaviour, applied to N rows in one call rather
 * than a new restriction invented for the bulk path. Every selected id is written, hence the
 * plain `number` return, the same shape bulkSetAttribution uses above.
 */
export function bulkSetNotes(ids: number[], notes: string | null, at?: Date): number {
  if (ids.length === 0) return 0;
  const result = getDb()
    .update(transactions)
    .set({ notes, updatedAt: nowIso(at) })
    .where(inArray(transactions.id, ids))
    .run();
  return Number(result.changes ?? 0);
}

/**
 * Return shape for the two bulk actions below. A split transaction's per-row write can be
 * refused outright (see the guard on confirmCategory/setTransferFlag in
 * src/lib/categorize/engine.ts -- the manual counterpart of Task 2b's automatic-engine
 * exclusion, spec ruling 2a) -- that refusal is not a failure of the whole batch: the row is
 * skipped and counted separately so the caller can report the truth instead of either
 * silently corrupting that row or aborting everyone else's change. Bulk attribution has no
 * such guard -- attribution is legitimately whole-transaction even for a split row (ruling 1)
 * -- and keeps its plain `number` return.
 *
 * v1.13.0 ruling R4 fix round 2 (controller finding): `owned_by_another` is NOT a per-row skip
 * like `has_splits` is. A bulk selection can span several different merchants, each with its own
 * rule ownership; treating an ownership refusal the same as a split-skip would let a member's
 * batch quietly categorize/flag every row EXCEPT the one merchant somebody else owns, which is
 * still an overwrite of nothing (fine) alongside a silent partial success the person never asked
 * for. Every other R4 refusal in this codebase (confirmCategory/setTransferFlag/
 * applyCategoryToMatching/upsertRenameRule) is resolved -- and can refuse -- before ANY row in
 * its own scope is touched; this is that same guarantee for a bulk id list: the whole call is
 * wrapped in one DB transaction, and hitting `owned_by_another` on any id throws to roll back
 * every write this call already made, so a refusal always leaves the entire selection exactly as
 * it was.
 */
export type BulkResult =
  | { ok: true; changed: number; skipped: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** Thrown only inside the transactions below, to unwind via ROLLBACK; never escapes this file. */
class BulkOwnershipRefusal extends Error {
  constructor(readonly ownerName: string) {
    super('owned_by_another');
  }
}

export function bulkSetCategory(
  ids: number[],
  categoryId: number,
  userId: number,
  createRules: boolean,
  /** The ACTOR's role, not any one rule's. Threaded from the caller (v1.13.0 ruling R4 fix
   *  round 2) -- see confirmCategory's own doc comment for what an admin may do that a member
   *  may not. */
  actorRole: 'admin' | 'member',
): BulkResult {
  let changed = 0;
  let skipped = 0;
  try {
    getDb().transaction(() => {
      for (const id of ids) {
        const result = confirmCategory({ transactionId: id, categoryId, userId, createRule: createRules, actorRole });
        if (result.ok) {
          changed += 1;
        } else if (result.reason === 'owned_by_another') {
          throw new BulkOwnershipRefusal(result.ownerName);
        } else {
          skipped += 1;
        }
      }
    });
  } catch (error) {
    if (error instanceof BulkOwnershipRefusal) return { ok: false, reason: 'owned_by_another', ownerName: error.ownerName };
    throw error;
  }
  return { ok: true, changed, skipped };
}

/**
 * v1.27.0 item 1. setTransferFlag's `learnRule` is REQUIRED with no default, so this call site has
 * to answer the question the parameter asks. It passes TRUE -- today's behaviour, unchanged --
 * and the reasoning is worth recording, because the loan fix in the same release answers the same
 * question the other way.
 *
 * Twenty statements about twenty merchants, not one statement about twenty rows. Three things
 * decide it:
 *
 *   1. The CONTROL is the statement. The bulk bar's transfer button is the per-row "Mark as
 *      transfer" applied to a hand-ticked selection; nothing is pre-armed and nothing rides along
 *      with some other action. Selecting a run of payroll deposits or card payments and pressing
 *      it is a person saying what those merchants ARE -- the merchant-driven case exactly. That is
 *      the opposite of the loan path, where the rule write was a side effect of a checkbox
 *      defaulted ON underneath an assign-to-loan submit.
 *   2. Transfers are the recurring kind of thing. The reason a person has twenty of them to select
 *      at once is that the same merchant keeps producing them, which is the argument FOR learning
 *      the merchant, not against it.
 *   3. Passing false would strand this function's own machinery. The `owned_by_another` branch
 *      below, BulkOwnershipRefusal, the whole-batch ROLLBACK, and bulkTransferAction's
 *      ruleOwnedError message all exist for one reason: bulk transfer authors rules. Suppressing
 *      the rules would leave that entire refusal path unreachable -- dead code that still reads
 *      like a live protection, which is the same failure mode the v1.27.0 ops guard was written
 *      to prevent.
 *
 * No parameter is threaded for it. There is one caller (bulkTransferAction) and one right answer;
 * an unexercised knob here would be configuration nobody sets and every test has to guess at.
 */
export function bulkSetTransfer(
  ids: number[],
  isTransfer: boolean,
  userId: number,
  /** The ACTOR's role, not any one rule's (v1.13.0 ruling R4 fix round 2). */
  actorRole: 'admin' | 'member',
): BulkResult {
  let changed = 0;
  let skipped = 0;
  try {
    getDb().transaction(() => {
      for (const id of ids) {
        const result = setTransferFlag({ transactionId: id, isTransfer, userId, actorRole, learnRule: true });
        if (result.ok) {
          changed += 1;
        } else if (result.reason === 'owned_by_another') {
          throw new BulkOwnershipRefusal(result.ownerName);
        } else {
          skipped += 1;
        }
      }
    });
  } catch (error) {
    if (error instanceof BulkOwnershipRefusal) return { ok: false, reason: 'owned_by_another', ownerName: error.ownerName };
    throw error;
  }
  return { ok: true, changed, skipped };
}

/** Return shape for bulkAssignToLoan, below -- a plain object rather than BulkResult: nothing
 *  here can be refused as `owned_by_another` (loans carry no per-merchant rule ownership), so
 *  that variant of BulkResult would be dead code a caller still had to handle. */
export interface BulkLoanResult {
  changed: number;
  skipped: number;
}

/**
 * v1.25.0 Lane R item R3. Bulk assign-to-loan: links every selected transaction to one loan by
 * calling assignTransactionToLoan (src/lib/loans.ts) once per id -- the SAME single-transaction
 * entry point the per-row "Assign to loan…" editor already posts to
 * (assignToLoanAction/assignLoan, src/app/(app)/transactions/actions.ts +
 * transactions-client.tsx). MUST-13.2, MUST-13.16 and rulings P4/B10 (tests/ops/
 * loan-invariants.test.ts) all live inside that one function; calling it per row gets every one
 * of them for free rather than re-deriving any of them here, and src/lib/loans.ts is a
 * concurrent lane's file this task does not edit.
 *
 * NOT subject to the split guard bulkSetCategory/bulkSetTransfer (above) honour.
 * assignTransactionToLoan writes to loan_payments only -- never to category_id or is_transfer,
 * MUST-13.2's own boundary ("a loan payment stays in its spending category") -- and the existing
 * per-row control already offers "Assign to loan…" on a split transaction with no guard at all
 * (rowMenu in transactions-client.tsx gates Split…/Create warranty/Mark-transfer-adjacent items
 * on `row.isTransfer`, never on whether the row has splits, and "Assign to loan…" isn't gated at
 * all). Skipping a split row here would be a NEW restriction this codebase has never actually
 * asked for, not a consistency fix -- see this task's own report for the fuller justification.
 *
 * `skipped` counts a genuine no-op instead: a row already linked to THIS loan
 * (assignTransactionToLoan's own `{ linked: false }`, backed by loan_payments' unique index on
 * (txn_id, item_id)) or a row assignTransactionToLoan refuses outright (a zero-amount
 * transaction, a row that already pays a bill installment, MUST-13.16) -- both caught here and
 * counted rather than left to throw and abort every id after them, so one row's refusal never
 * silently drops the rest of a bulk selection's own changes. Deliberately NOT one
 * `db.transaction()` the way bulkSetCategory/bulkSetTransfer are: assignTransactionToLoan already
 * wraps EACH row's own read-balance/link/describe sequence in its own transaction (ruling A4's
 * "one db transaction" is per assign, not per batch), and unlike an owned-rule refusal (which
 * must roll back the WHOLE selection, ruling R4 fix round 2) a per-row loan refusal has nothing
 * to roll back for any OTHER row -- each id's link is independent of every other id's, the same
 * reasoning acceptAllGuessesAction (src/app/(app)/transactions/actions.ts) already gives for not
 * wrapping its own per-id loop in one transaction.
 */
export function bulkAssignToLoan(ids: number[], itemId: number, at?: Date): BulkLoanResult {
  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      const result = assignTransactionToLoan({ txnId: id, itemId, at });
      if (result.linked) changed += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { changed, skipped };
}

/**
 * The queue definition itself lives in engine.ts (REVIEW_WHERE) and is imported, not
 * restated: this function, reviewQueueIds and reviewQueueCount must agree on what
 * "needs review" means, and a copy here had already been maintained twice.
 */
export function listReviewQueue(limit = 100, offset = 0): TransactionRow[] {
  return baseQuery()
    .where(REVIEW_WHERE)
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all();
}

export function countMatchingMerchant(normalizedMerchant: string): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(and(eq(transactions.normalizedMerchant, normalizedMerchant), eq(transactions.isTransfer, false)))
    .get();
  return row?.c ?? 0;
}

/** Exported for the transactions page's "not this category" filter chips. */
export function countExcludingCategory(categoryId: number): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(or(ne(transactions.categoryId, categoryId), isNull(transactions.categoryId)))
    .get();
  return row?.c ?? 0;
}
