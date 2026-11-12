import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions, users } from '@/db/schema';
import { addDaysIso, daysBetweenIso, isIsoDate } from '@/lib/dates';
import type { DuplicateCandidate, ImportOrigin } from './origin';
import { findSetAsideByKeys, type SetAsideReason, type SetAsideState } from './set-aside';

export type { DuplicateCandidate } from './origin';

/**
 * v1.61.0. The one cross-source check. The import preview, every import commit and the bank sync
 * classify their rows with this function, so the preview can never promise what the commit will
 * not do.
 *
 * Callers pass only the rows with no exact match (same hash, same provider id). For each, in order:
 *   1. a key already in set_aside_rows is that record, whatever else is true;
 *   2. otherwise the row is a possible duplicate when the same account holds a transaction from a
 *      DIFFERENT origin with the same signed amount, dated within MATCH_WINDOW_DAYS either side;
 *   3. otherwise it is new.
 *
 * Matching is one-to-one. Incoming rows go in (date, file order); each takes its nearest unclaimed
 * candidate (tie: lower id), and a claimed candidate cannot match a second incoming row. Rows of
 * the incoming origin are never candidates, and the incoming rows are not in the table yet, so two
 * identical same-day purchases from one source both import, and two identical rows against one
 * hand-typed copy give one match and one new row.
 */

export const MATCH_WINDOW_DAYS = 3;
/** How many candidates a possible duplicate lists, nearest first. */
export const MAX_LISTED_CANDIDATES = 3;

export interface ClassifyRow {
  /** externalId || dedupHash: the key commitImport stores the row under. */
  key: string;
  rowIndex: number;
  date: string;
  amountCents: number;
}

export type RowClassification =
  | { kind: 'set_aside'; id: number; state: SetAsideState; reason: SetAsideReason; decidedAt: string | null }
  | { kind: 'possible_duplicate'; candidates: DuplicateCandidate[]; defaultSkip: boolean }
  | { kind: 'new' };

const NEW: RowClassification = { kind: 'new' };

export function classifyNewRows(input: {
  accountId: number;
  origin: ImportOrigin;
  rows: ClassifyRow[];
}): Map<string, RowClassification> {
  const result = new Map<string, RowClassification>();
  const rows = input.rows.filter((row) => typeof row.key === 'string' && row.key.length > 0);
  if (rows.length === 0) return result;

  const setAside = findSetAsideByKeys(
    input.accountId,
    rows.map((row) => row.key),
  );

  // A key met twice is decided once, by its first row. A row without a usable date or amount
  // cannot be compared; it reads as new and the commit's own validation decides its fate.
  const open: (ClassifyRow & { position: number })[] = [];
  rows.forEach((row, position) => {
    if (result.has(row.key)) return;
    const hit = setAside.get(row.key);
    if (hit !== undefined) {
      result.set(row.key, { kind: 'set_aside', id: hit.id, state: hit.state, reason: hit.reason, decidedAt: hit.decidedAt });
      return;
    }
    result.set(row.key, NEW);
    if (isIsoDate(row.date) && Number.isFinite(row.amountCents)) open.push({ ...row, position });
  });
  if (open.length === 0) return result;

  const dates = open.map((row) => row.date).sort();
  const from = addDaysIso(dates[0], -MATCH_WINDOW_DAYS);
  const to = addDaysIso(dates[dates.length - 1], MATCH_WINDOW_DAYS);
  // One read, through transactions_account_date_idx.
  const existing = getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      description: sql<string>`coalesce(${transactions.displayDescription}, ${transactions.rawDescription})`,
      amountCents: transactions.amountCents,
      origin: transactions.origin,
      personName: users.name,
    })
    .from(transactions)
    .leftJoin(users, eq(users.id, transactions.attributedUserId))
    .where(
      and(
        eq(transactions.accountId, input.accountId),
        gte(transactions.date, from),
        lte(transactions.date, to),
        ne(transactions.origin, input.origin),
      ),
    )
    .all();
  if (existing.length === 0) return result;

  const byAmount = new Map<number, DuplicateCandidate[]>();
  for (const row of existing) {
    const pool = byAmount.get(row.amountCents);
    if (pool === undefined) byAmount.set(row.amountCents, [row]);
    else pool.push(row);
  }

  open.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rowIndex - b.rowIndex || a.position - b.position));
  const claimed = new Set<number>();
  for (const row of open) {
    const pool = byAmount.get(row.amountCents);
    if (pool === undefined) continue;
    const distance = (candidate: DuplicateCandidate) => Math.abs(daysBetweenIso(candidate.date, row.date));
    const matches = pool
      .filter((candidate) => !claimed.has(candidate.id) && distance(candidate) <= MATCH_WINDOW_DAYS)
      .sort((a, b) => distance(a) - distance(b) || a.id - b.id);
    if (matches.length === 0) continue;
    claimed.add(matches[0].id);
    result.set(row.key, {
      kind: 'possible_duplicate',
      candidates: matches.slice(0, MAX_LISTED_CANDIDATES),
      defaultSkip: matches.length === 1,
    });
  }
  return result;
}
