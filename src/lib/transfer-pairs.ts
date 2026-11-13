import { and, eq, gte, inArray, like, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, loanPayments, settings, transactions, transactionSplits, users } from '@/db/schema';
import { acceptsTransactions } from '@/lib/accounts';
import { isSelfScoped, NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import { REVIEW_WHERE, setTransferFlag } from '@/lib/categorize/engine';
import { addDaysIso, daysBetweenIso } from '@/lib/dates';
import { deleteSetting, setSetting } from '@/lib/settings';

/**
 * v1.62.0 (plan lane C). Possible transfers: one outgoing and one incoming row of the same amount
 * on two different household accounts, a few days apart. A chequing-to-savings move or an e-transfer
 * between the household's own accounts lands twice, once as spending and once as income, and
 * neither row is a transfer until somebody says so.
 *
 * THE WINDOW is 3 days, the same as the app's other "same money, two rows" window
 * (DUPLICATE_WINDOW_DAYS): a bank posts the two halves of one move on different days, and a longer
 * window starts pairing unrelated repeat amounts such as two rent-sized payments.
 *
 * THE ONE PREDICATE is `isPairCandidate`. The suggester and the confirm both ask it, so a pair that
 * was offered and one that is accepted can never disagree. Confirm asks again with fresh reads,
 * which is what makes a stale card harmless.
 *
 * CONFIRMING SAVES NO RULE. A pair is a transfer because of its other half, the link-driven case
 * setTransferFlag's `learnRule` docblock describes. E-transfer descriptions are shared with
 * payments to people outside the household, so a learned rule would misfile them.
 *
 * Held possible duplicates (set_aside_rows) are not transactions and are never read here.
 */
export const TRANSFER_PAIR_WINDOW_DAYS = 3;
export const TRANSFER_PAIR_LIMIT = 20;

export const TRANSFER_PAIR_STALE_ERROR = 'That pair has changed since it was suggested. Nothing was changed.';

const DISMISSED_PREFIX = 'transfer_pair_dismissed:';
const DISMISSED_KEY = /^transfer_pair_dismissed:(\d+):(\d+)$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface PairSide {
  id: number;
  date: string;
  accountName: string;
  description: string;
  amountCents: number;
  isTransfer: boolean;
  personName: string | null;
}

export interface TransferPair {
  out: PairSide;
  in: PairSide;
}

export interface TransferPairSuggestions {
  /** Newest first, at most `limit`. */
  pairs: TransferPair[];
  /** Every pair found, so the card can say how many more wait. */
  total: number;
}

/** What the predicate needs to know about one row. */
export interface PairRow {
  id: number;
  accountId: number;
  date: string;
  amountCents: number;
  isTransfer: boolean;
  /** Filed by hand to a category and not a transfer: the household called it spending. */
  filedByHand: boolean;
  /** In the review queue (REVIEW_WHERE). */
  inQueue: boolean;
}

export interface PairAccount {
  isActive: boolean;
  type: Parameters<typeof acceptsTransactions>[0];
  ownerUserId: number | null;
  /** The owner is a member scoped to their own rows. */
  ownerIsSelfScoped: boolean;
}

export interface PairContext {
  accounts: ReadonlyMap<number, PairAccount>;
  dismissed: ReadonlySet<string>;
}

export const dismissalKey = (outId: number, inId: number): string => `${DISMISSED_PREFIX}${outId}:${inId}`;

/** Splits and loan links are excluded in the reads themselves, so rows reaching the predicate carry neither. */
export function isPairCandidate(out: PairRow, inc: PairRow, ctx: PairContext): boolean {
  if (out.amountCents >= 0 || out.amountCents !== -inc.amountCents) return false;
  if (out.accountId === inc.accountId) return false;
  const a = ctx.accounts.get(out.accountId);
  const b = ctx.accounts.get(inc.accountId);
  if (a === undefined || b === undefined) return false;
  for (const account of [a, b]) if (!account.isActive || !acceptsTransactions(account.type)) return false;
  if (Math.abs(daysBetweenIso(out.date, inc.date)) > TRANSFER_PAIR_WINDOW_DAYS) return false;
  if (out.filedByHand || inc.filedByHand) return false;
  if (!out.inQueue && !inc.inQueue) return false;
  if (out.isTransfer && inc.isTransfer) return false;
  if (a.ownerIsSelfScoped || b.ownerIsSelfScoped) {
    if (a.ownerUserId === null || a.ownerUserId !== b.ownerUserId) return false;
  }
  return !ctx.dismissed.has(dismissalKey(out.id, inc.id));
}

interface RawRow extends PairRow {
  description: string;
  personName: string | null;
}

const NO_SPLIT = sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`;
const NO_LOAN = sql`not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})`;

const PAIR_COLUMNS = {
  id: transactions.id,
  accountId: transactions.accountId,
  date: transactions.date,
  amountCents: transactions.amountCents,
  isTransfer: transactions.isTransfer,
  source: transactions.categorizationSource,
  categoryId: transactions.categoryId,
  rawDescription: transactions.rawDescription,
  displayDescription: transactions.displayDescription,
  personName: users.name,
};

interface ReadRow {
  id: number;
  accountId: number;
  date: string;
  amountCents: number;
  isTransfer: boolean;
  source: 'rule' | 'bayes' | 'manual' | 'none';
  categoryId: number | null;
  rawDescription: string;
  displayDescription: string | null;
  personName: string | null;
}

function toRaw(row: ReadRow, queue: ReadonlySet<number>): RawRow {
  return {
    id: row.id,
    accountId: row.accountId,
    date: row.date,
    amountCents: row.amountCents,
    isTransfer: row.isTransfer,
    filedByHand: row.source === 'manual' && row.categoryId !== null && !row.isTransfer,
    inQueue: queue.has(row.id),
    description: row.displayDescription ?? row.rawDescription,
    personName: row.personName,
  };
}

const CHUNK = 500;

function readAccounts(): Map<number, PairAccount & { name: string }> {
  const rows = getDb()
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      isActive: accounts.isActive,
      ownerUserId: accounts.ownerUserId,
      visibility: users.visibility,
      role: users.role,
    })
    .from(accounts)
    .leftJoin(users, eq(users.id, accounts.ownerUserId))
    .all();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.name,
        type: row.type,
        isActive: row.isActive,
        ownerUserId: row.ownerUserId,
        ownerIsSelfScoped: row.visibility === 'self' && row.role !== 'admin',
      },
    ]),
  );
}

function dismissalKeys(): string[] {
  return getDb()
    .select({ key: settings.key })
    .from(settings)
    .where(like(settings.key, `${DISMISSED_PREFIX}%`))
    .all()
    .map((row) => row.key);
}

/** Rows without splits or loan links, by id, with the queue membership marked. */
function readRowsById(ids: number[]): RawRow[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db
    .select(PAIR_COLUMNS)
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.attributedUserId))
    .where(and(inArray(transactions.id, ids), NO_SPLIT, NO_LOAN))
    .all();
  const queue = new Set(
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(inArray(transactions.id, ids), REVIEW_WHERE))
      .all()
      .map((row) => row.id),
  );
  return rows.map((row) => toRaw(row, queue));
}

/**
 * Pairs the household should look at. A self-scoped viewer gets nothing: needs review is
 * household-only, and a pair names two accounts. Matching is one-to-one: outgoing rows in
 * (date, id) order each claim the nearest unclaimed incoming row, the lower id on a tie; a
 * dismissed pair is skipped and leaves both rows free for another partner.
 */
export function suggestTransferPairs(viewer: Viewer, opts: { limit?: number } = {}): TransferPairSuggestions {
  const limit = opts.limit ?? TRANSFER_PAIR_LIMIT;
  if (isSelfScoped(viewer)) return { pairs: [], total: 0 };
  const db = getDb();

  const queueRows = db
    .select(PAIR_COLUMNS)
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.attributedUserId))
    .where(REVIEW_WHERE)
    .all();
  const queueIds = new Set(queueRows.map((row) => row.id));
  const byId = new Map<number, RawRow>(queueRows.map((row) => [row.id, toRaw(row, queueIds)]));
  const accountMap = readAccounts();
  const ctx: PairContext = { accounts: accountMap, dismissed: new Set(dismissalKeys()) };

  const negated = [...new Set(queueRows.map((row) => -row.amountCents).filter((cents) => cents !== 0))];
  if (negated.length > 0) {
    const first = queueRows.reduce((min, row) => (row.date < min ? row.date : min), queueRows[0].date);
    const last = queueRows.reduce((max, row) => (row.date > max ? row.date : max), queueRows[0].date);
    for (let start = 0; start < negated.length; start += CHUNK) {
      const rows = db
        .select(PAIR_COLUMNS)
        .from(transactions)
        .leftJoin(users, eq(users.id, transactions.attributedUserId))
        .where(
          and(
            gte(transactions.date, addDaysIso(first, -TRANSFER_PAIR_WINDOW_DAYS)),
            lte(transactions.date, addDaysIso(last, TRANSFER_PAIR_WINDOW_DAYS)),
            inArray(transactions.amountCents, negated.slice(start, start + CHUNK)),
            NO_SPLIT,
            NO_LOAN,
          ),
        )
        .all();
      for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, toRaw(row, queueIds));
    }
  }

  const all = [...byId.values()];
  const outgoing = all
    .filter((row) => row.amountCents < 0)
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  const incoming = all.filter((row) => row.amountCents > 0);
  const claimed = new Set<number>();
  const found: Array<{ out: RawRow; in: RawRow }> = [];
  for (const out of outgoing) {
    let best: RawRow | null = null;
    let bestDistance = Infinity;
    for (const inc of incoming) {
      if (claimed.has(inc.id) || !isPairCandidate(out, inc, ctx)) continue;
      const distance = Math.abs(daysBetweenIso(out.date, inc.date));
      if (distance < bestDistance || (distance === bestDistance && best !== null && inc.id < best.id)) {
        best = inc;
        bestDistance = distance;
      }
    }
    if (best === null) continue;
    claimed.add(best.id);
    found.push({ out, in: best });
  }

  const later = (pair: { out: RawRow; in: RawRow }) => (pair.out.date > pair.in.date ? pair.out.date : pair.in.date);
  found.sort((a, b) => (later(a) === later(b) ? b.out.id - a.out.id : later(a) < later(b) ? 1 : -1));
  const side = (row: RawRow): PairSide => ({
    id: row.id,
    date: row.date,
    accountName: accountMap.get(row.accountId)?.name ?? '',
    description: row.description,
    amountCents: row.amountCents,
    isTransfer: row.isTransfer,
    personName: row.personName,
  });
  return { pairs: found.slice(0, limit).map((pair) => ({ out: side(pair.out), in: side(pair.in) })), total: found.length };
}

class PairRefused extends Error {}

export type ConfirmTransferPairResult = { ok: true; marked: number } | { ok: false; error: string };

/**
 * Marks the rows of a pair that are not yet transfers, in one db transaction, and writes no rule.
 * Refuses a self viewer, and refuses unless the same predicate the suggester used still holds on
 * fresh reads.
 */
export function confirmTransferPair(input: { outId: number; inId: number; viewer: Viewer; at?: Date }): ConfirmTransferPairResult {
  if (isSelfScoped(input.viewer)) return { ok: false, error: NOT_YOURS_ERROR };
  if (input.outId === input.inId) return { ok: false, error: TRANSFER_PAIR_STALE_ERROR };
  const rows = new Map(readRowsById([input.outId, input.inId]).map((row) => [row.id, row]));
  const out = rows.get(input.outId);
  const inc = rows.get(input.inId);
  const ctx: PairContext = { accounts: readAccounts(), dismissed: new Set(dismissalKeys()) };
  if (out === undefined || inc === undefined || !isPairCandidate(out, inc, ctx)) {
    return { ok: false, error: TRANSFER_PAIR_STALE_ERROR };
  }
  let marked = 0;
  try {
    getDb().transaction(() => {
      for (const row of [out, inc]) {
        if (row.isTransfer) continue;
        const result = setTransferFlag({
          transactionId: row.id,
          isTransfer: true,
          userId: input.viewer.id,
          actorRole: input.viewer.role,
          learnRule: false,
          at: input.at,
        });
        if (!result.ok) throw new PairRefused();
        marked += 1;
      }
    });
  } catch (error) {
    if (error instanceof PairRefused) return { ok: false, error: TRANSFER_PAIR_STALE_ERROR };
    throw error;
  }
  return { ok: true, marked };
}

/** Drops every remembered dismissal that names a row which no longer exists. */
export function pruneTransferPairDismissals(): void {
  const keys = dismissalKeys();
  if (keys.length === 0) return;
  const ids = new Set<number>();
  for (const key of keys) {
    const match = DISMISSED_KEY.exec(key);
    if (match !== null) ids.add(Number(match[1])).add(Number(match[2]));
  }
  const existing = new Set<number>();
  const all = [...ids];
  for (let start = 0; start < all.length; start += CHUNK) {
    const rows = getDb()
      .select({ id: transactions.id })
      .from(transactions)
      .where(inArray(transactions.id, all.slice(start, start + CHUNK)))
      .all();
    for (const row of rows) existing.add(row.id);
  }
  for (const key of keys) {
    const match = DISMISSED_KEY.exec(key);
    if (match === null || !existing.has(Number(match[1])) || !existing.has(Number(match[2]))) deleteSetting(key);
  }
}

/** Remembers that this pair is not a transfer. The value is the household day it was said. */
export function dismissTransferPair(input: {
  outId: number;
  inId: number;
  viewer: Viewer;
  on: string;
}): { ok: true } | { ok: false; error: string } {
  if (isSelfScoped(input.viewer)) return { ok: false, error: NOT_YOURS_ERROR };
  if (!ISO_DAY.test(input.on) || input.outId === input.inId) return { ok: false, error: TRANSFER_PAIR_STALE_ERROR };
  const found = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(inArray(transactions.id, [input.outId, input.inId]))
    .all();
  if (found.length !== 2) return { ok: false, error: TRANSFER_PAIR_STALE_ERROR };
  setSetting(dismissalKey(input.outId, input.inId), input.on);
  pruneTransferPairDismissals();
  return { ok: true };
}
