import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { accounts, categories, transactions, users } from '@/db/schema';
import { getAccount } from '@/lib/accounts';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { REVIEW_WHERE, confirmCategory, runEngine, setTransferFlag } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { isIsoDate } from '@/lib/dates';
import { applyPaymentMatchers } from '@/lib/loans';

export interface TransactionFilter {
  accountId?: number | null;
  categoryId?: number | 'uncategorized' | null;
  attributedUserId?: number | 'unattributed' | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  uncategorizedOnly?: boolean;
  includeTransfers?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TransactionRow {
  id: number;
  date: string;
  accountId: number;
  accountName: string;
  rawDescription: string;
  /** Spec v1.4: what the UI shows when set; raw_description is the fallback. */
  displayDescription: string | null;
  displaySource: 'manual' | 'rename' | null;
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

function buildWhere(filter: TransactionFilter, viewer: Viewer): SQL | undefined {
  const clauses: SQL[] = [];
  if (typeof filter.accountId === 'number') clauses.push(eq(transactions.accountId, filter.accountId));

  if (filter.categoryId === 'uncategorized') clauses.push(isNull(transactions.categoryId));
  else if (typeof filter.categoryId === 'number') clauses.push(eq(transactions.categoryId, filter.categoryId));

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
    const needle = `%${escapeLikeNeedle(filter.search.trim().toUpperCase())}%`;
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
    );
    if (clause) clauses.push(clause);
  }

  if (filter.uncategorizedOnly) clauses.push(isNull(transactions.categoryId));
  if (filter.includeTransfers === false) clauses.push(eq(transactions.isTransfer, false));

  if (clauses.length === 0) return undefined;
  return and(...clauses);
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

  const totalRow = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get();
  const total = totalRow?.c ?? 0;

  const query = baseQuery();
  const rows = (where ? query.where(where) : query)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
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

export function createManualTransaction(input: {
  accountId: number;
  date: string;
  description: string;
  amountCents: number;
  categoryId: number | null;
  attributedUserId: number | null;
  notes?: string | null;
  userId: number;
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

  const row = getDb()
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
    // actorRole: 'admin' -- createManualTransaction does not yet take its own caller's role
    // (Wave C threads that through src/app/(app)/transactions/actions.ts, which this task does
    // not touch); this reproduces the pre-R4 behaviour of an unconditional overwrite, unchanged.
    confirmCategory({ transactionId: row.id, categoryId: parsed.categoryId, userId: input.userId, actorRole: 'admin' });
  }
  // MUST-13.7: a hand-typed loan payment is a loan payment. Runs after confirmCategory so
  // the row is in its final state, and is cheap when no loan rules exist.
  applyPaymentMatchers([row.id]);
  return row.id;
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
        const result = setTransferFlag({ transactionId: id, isTransfer, userId, actorRole });
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
