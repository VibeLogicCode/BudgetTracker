import { and, eq, gte, lte, ne, notExists, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { setAsideRows, transactions, users } from '@/db/schema';
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
 *
 * A transaction an earlier row of the SAME origin was already set aside against (waiting or
 * dismissed) is not a candidate either: that row is its copy from this road, so a later row from
 * the same road is a different purchase. A record from another road does not take it out: a
 * SimpleFIN copy still matches the CSV row a QFX copy was left out against.
 *
 * Leave out starts ticked (`defaultSkip`) unless the row is ambiguous, judged AFTER every row has
 * claimed. A claim on the row's own date is certain: candidates sharing a date and amount are
 * interchangeable, so two identical coffees against two identical coffees, or a week of daily
 * coffees against the same week from another file, are all ticked. A claim on another date is
 * ambiguous as soon as one more unclaimed candidate sits on a different date in the window: a row
 * with a copy the day before and another three days later is left for the person to decide
 * (owner decision 4: never auto-skip genuinely different matches).
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
        // Already the copy of an earlier row from this road (through set_aside_rows_candidate_idx).
        notExists(
          getDb()
            .select({ id: setAsideRows.id })
            .from(setAsideRows)
            .where(and(eq(setAsideRows.candidateTxnId, transactions.id), eq(setAsideRows.origin, input.origin))),
        ),
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

  // Pass 1, the claim: each row in turn takes its nearest unclaimed candidate (tie: lower id).
  const claimed = new Set<number>();
  const claims: { row: (typeof open)[number]; claim: DuplicateCandidate; distance: number }[] = [];
  for (const row of open) {
    let best: DuplicateCandidate | null = null;
    let bestDistance = Infinity;
    for (const candidate of byAmount.get(row.amountCents) ?? []) {
      if (claimed.has(candidate.id)) continue;
      const distance = Math.abs(daysBetweenIso(candidate.date, row.date));
      if (distance > MATCH_WINDOW_DAYS) continue;
      if (distance < bestDistance || (distance === bestDistance && best !== null && candidate.id < best.id)) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best === null) continue;
    claimed.add(best.id);
    claims.push({ row, claim: best, distance: bestDistance });
  }

  // Pass 2, once every claim is known: the row's own claim first, then the candidates nobody
  // claimed, nearest first. A same-date claim is certain; any other claim is ambiguous when one of
  // those sits on a different date.
  for (const { row, claim, distance } of claims) {
    const distanceOf = (candidate: DuplicateCandidate) => Math.abs(daysBetweenIso(candidate.date, row.date));
    const others = (byAmount.get(row.amountCents) ?? [])
      .filter((candidate) => !claimed.has(candidate.id) && distanceOf(candidate) <= MATCH_WINDOW_DAYS)
      .sort((a, b) => distanceOf(a) - distanceOf(b) || a.id - b.id);
    const ambiguous = distance > 0 && others.some((candidate) => candidate.date !== claim.date);
    result.set(row.key, {
      kind: 'possible_duplicate',
      candidates: [claim, ...others].slice(0, MAX_LISTED_CANDIDATES),
      defaultSkip: !ambiguous,
    });
  }
  return result;
}
