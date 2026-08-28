import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import type { CandidateRow } from './parse';

/**
 * FROZEN. Do not add rules here.
 *
 * This normalization is versioned by DEDUP_HASH_VERSION and is deliberately
 * independent of the (evolvable) merchant-learning normalizer elsewhere in the
 * codebase. That normalizer's strip-list will grow over time; if this depended
 * on it, every upgrade would silently break duplicate detection for existing rows.
 *
 * If this ever MUST change, bump DEDUP_HASH_VERSION, add a migration that
 * recomputes every stored dedup_hash, and leave this function's old behaviour
 * available for rows still on the old version.
 */
export const DEDUP_HASH_VERSION = 1;

export function dedupDescription(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, ' ').trim();
}

export function dedupHash(input: {
  accountId: number;
  rawDate: string;
  amountCents: number;
  rawDescription: string;
  occurrenceIndex: number;
}): string {
  const parts = [
    String(DEDUP_HASH_VERSION),
    String(input.accountId),
    input.rawDate.trim(),
    String(input.amountCents),
    dedupDescription(input.rawDescription),
    String(input.occurrenceIndex),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Counts identical (rawDate, amountCents, dedupDesc) rows WITHIN THE SAME FILE,
 * in row order, starting at 0. Rows that failed to parse never reach this
 * function, so they cannot consume an index.
 */
export function assignOccurrenceIndexes<T extends { rawDate: string; amountCents: number; rawDescription: string }>(
  rows: T[],
): (T & { occurrenceIndex: number })[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.rawDate.trim()}|${row.amountCents}|${dedupDescription(row.rawDescription)}`;
    const occurrenceIndex = seen.get(key) ?? 0;
    seen.set(key, occurrenceIndex + 1);
    return { ...row, occurrenceIndex };
  });
}

export interface HashedRow extends CandidateRow {
  occurrenceIndex: number;
  dedupHash: string;
  hashVersion: typeof DEDUP_HASH_VERSION;
}

export function computeRowHashes(accountId: number, rows: CandidateRow[]): HashedRow[] {
  return assignOccurrenceIndexes(rows).map((row) => ({
    ...row,
    dedupHash: dedupHash({
      accountId,
      rawDate: row.rawDate,
      amountCents: row.amountCents,
      rawDescription: row.rawDescription,
      occurrenceIndex: row.occurrenceIndex,
    }),
    // Stamped explicitly so a future DEDUP_HASH_VERSION bump can't be silently
    // masked by the schema's DEFAULT 1 on insert (Task 10 writes this column).
    hashVersion: DEDUP_HASH_VERSION,
  }));
}

/**
 * v1.13.0 ruling R9 (item C2). externalId -> existing transaction id, scoped to one account --
 * the same lookup commitImport (src/lib/import/commit.ts) already ran inline to decide whether a
 * provider-id row (OFX FITID, SimpleFIN transaction id) is a duplicate. Extracted here so
 * buildPreview (src/lib/import/preview.ts) can run the identical check at preview time: a CSV
 * row's dedupHash-based check (findExistingByHashes above) never matches a provider-id row,
 * because commitImport stores NULL in dedup_hash for those (see CommitRow's own doc comment) --
 * so an OFX preview that only ever called findExistingByHashes would report every row as new,
 * commit or not, which is exactly the C2 bug this pairs with.
 */
export function findExistingByExternalIds(accountId: number, externalIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (externalIds.length === 0) return result;

  const db = getDb();
  const CHUNK = 400;
  for (let offset = 0; offset < externalIds.length; offset += CHUNK) {
    const chunk = externalIds.slice(offset, offset + CHUNK);
    const rows = db
      .select({ id: transactions.id, externalId: transactions.externalId })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.externalId), inArray(transactions.externalId, chunk)))
      .all();
    for (const row of rows) {
      if (row.externalId) result.set(row.externalId, row.id);
    }
  }
  return result;
}

/** hash -> existing transaction id, scoped to one account. Manual rows (NULL hash) can never match. */
export function findExistingByHashes(accountId: number, hashes: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (hashes.length === 0) return result;

  const db = getDb();
  // Chunked to stay well under SQLite's bound-parameter ceiling. That ceiling is
  // SQLITE_MAX_VARIABLE_NUMBER, which is 32766 in the builds better-sqlite3 ships
  // (it was 999 before SQLite 3.32) — 400 is conservative against either, and is
  // kept as-is: the point of the chunking is a predictable statement size, not the
  // exact limit. src/lib/categorize/engine.ts uses the same 400.
  const CHUNK = 400;
  for (let offset = 0; offset < hashes.length; offset += CHUNK) {
    const chunk = hashes.slice(offset, offset + CHUNK);
    const rows = db
      .select({ id: transactions.id, dedupHash: transactions.dedupHash })
      .from(transactions)
      .where(
        and(eq(transactions.accountId, accountId), isNotNull(transactions.dedupHash), inArray(transactions.dedupHash, chunk)),
      )
      .all();
    for (const row of rows) {
      if (row.dedupHash) result.set(row.dedupHash, row.id);
    }
  }
  return result;
}
