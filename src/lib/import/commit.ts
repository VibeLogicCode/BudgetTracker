import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports, transactionImports, transactions, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { reverseInstallmentLinksForTransactions, reverseLoanLinksForTransactions } from '@/lib/loans';
import { recordBalanceSnapshot } from '@/lib/networth';
import { listAccountCardPeople } from './card-people';
import { findExistingByHashes, type HashedRow } from './dedup';
import { getImportHooks } from './hooks';
import { normalizeCardValue, type ImportMapping } from './mapping';
import { closingBalancesByDate, type ParseResult, type RowError } from './parse';

export type CommitRow = HashedRow & { externalId?: string | null };

/**
 * SQLite has no strict column typing, so a malformed row (e.g. a non-numeric
 * amountCents) would otherwise be silently written instead of failing the
 * whole import. Validate the fields we're about to persist so corruption
 * throws inside the transaction and rolls back, instead of landing in the DB.
 *
 * A SimpleFIN row dedups on external_id and never carries a CSV dedup hash
 * (it is stamped '' by the caller and written as NULL), so the dedupHash
 * check is skipped for those rows.
 */
function assertInsertable(row: CommitRow): void {
  // '' is not NULL: an empty-string external_id would still satisfy the
  // partial unique index's `where external_id is not null` and could collide
  // across unrelated rows, so it must coalesce to null exactly like nullish.
  const providerId = row.externalId || null;
  if (typeof row.amountCents !== 'number' || !Number.isFinite(row.amountCents)) {
    throw new Error(`Invalid amountCents for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (typeof row.date !== 'string' || row.date.length === 0) {
    throw new Error(`Invalid date for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (typeof row.rawDescription !== 'string' || row.rawDescription.length === 0) {
    throw new Error(`Invalid rawDescription for row with dedupHash ${String(row.dedupHash)}`);
  }
  if (!providerId && (typeof row.dedupHash !== 'string' || row.dedupHash.length === 0)) {
    throw new Error('Invalid dedupHash for row');
  }
  if (typeof row.hashVersion !== 'number') {
    throw new Error(`Invalid hashVersion for row with dedupHash ${row.dedupHash}`);
  }
}

export interface CommitInput {
  accountId: number;
  profileId: number | null;
  filename: string;
  importedBy: number;
  rows: CommitRow[];
  errors: RowError[];
  at?: Date;
  /**
   * Spec 2026-08-22, v1.6.0, MUST-3.3. Optional because the SimpleFIN sync path
   * (src/lib/simplefin/sync.ts) has no CSV mapping at all and its rows carry no `cells` —
   * omitting it (or passing one whose `cardCol` is null, which every CSV mapping was before
   * v1.6.0) is exactly today's behaviour: every row attributes to `account.ownerUserId`.
   */
  mapping?: ImportMapping | null;
  /**
   * v1.8.0 (spec 2026-08-23, Task 3). Which physical row of a same-date group is that date's
   * chronologically LAST (closing) row — see closingBalancesByDate's doc comment. Optional
   * for the same reason `mapping` above is: the SimpleFIN sync path (src/lib/simplefin/sync.ts)
   * has no CSV file to detect a direction from, and every hand-built CommitRow outside the
   * real CSV path stamps balanceCents: null on every row, which makes closingBalancesByDate
   * return an empty map regardless of dateOrder — so 'oldest_first' is a safe, inert default
   * for every caller that omits this.
   */
  dateOrder?: ParseResult['dateOrder'];
}

export interface CommitResult {
  importId: number;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  insertedTransactionIds: number[];
  duplicateTransactionIds: number[];
  /**
   * SHOULD-3.6. Human-readable attribution split for the rows this call actually inserted,
   * e.g. "8 rows to Alex, 5 rows to Sam, 2 rows to the account owner (no card
   * match)" — null whenever there is nothing card-specific to report: `mapping.cardCol` is
   * null/absent, or nothing was inserted (an all-duplicate commit has no NEW attribution to
   * announce; the pre-existing rows keep whatever they already had).
   */
  attributionSummary: string | null;
}

export function commitImport(input: CommitInput): CommitResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const timestamp = nowIso(at);
  const { normalizeMerchant } = getImportHooks();

  const account = db
    .select({ ownerUserId: accounts.ownerUserId })
    .from(accounts)
    .where(eq(accounts.id, input.accountId))
    .get();
  if (!account) throw new Error(`No account ${input.accountId}`);
  // Captured into its own const, rather than referencing `account.ownerUserId` directly
  // inside resolveAttribution below: TS does not carry the `if (!account) throw` narrowing
  // above across a nested function boundary, so the closure would otherwise see `account`
  // as possibly undefined again.
  const ownerUserId = account.ownerUserId ?? null;

  // MUST-3.3: loaded ONCE per commit, never per row. null when the mapping has no cardCol
  // (or no mapping was passed at all, e.g. SimpleFIN) -- in which case cardMap stays null
  // too and resolveAttribution below never consults account_card_people, which is what
  // keeps this byte-identical to pre-v1.6.0 behaviour for every account that has no
  // cardholder column.
  const cardCol = input.mapping?.cardCol ?? null;
  const cardMap =
    cardCol !== null
      ? new Map(listAccountCardPeople(input.accountId).map((row) => [row.cardValue, { userId: row.userId, userName: row.userName }]))
      : null;

  // Tallies for the SHOULD-3.6 attribution-split summary, kept only for rows this call
  // actually INSERTS -- a duplicate row already has whatever attribution it got the first
  // time it was committed, so it has nothing new to report here.
  const matchedTally = new Map<string, number>();
  let fallbackCount = 0;

  /**
   * MUST-3.3's fallback chain, in order: no cardCol/no map -> owner; index beyond this row's
   * cells, or the cell normalizes to empty -> owner; normalized value not in the map ->
   * owner; otherwise the mapped person. `matchedName` is non-null only on the last case, so
   * the caller can tally "matched a real person" separately from every flavour of fallback.
   */
  function resolveAttribution(cells: string[]): { userId: number | null; matchedName: string | null } {
    const fallback = { userId: ownerUserId, matchedName: null };
    if (cardCol === null || cardMap === null) return fallback;
    const raw = cells[cardCol];
    if (raw === undefined) return fallback;
    const value = normalizeCardValue(raw);
    if (value.length === 0) return fallback;
    const match = cardMap.get(value);
    if (!match) return fallback;
    return { userId: match.userId, matchedName: match.userName };
  }

  const existing = findExistingByHashes(
    input.accountId,
    input.rows.map((row) => row.dedupHash),
  );

  const externalIds = input.rows.map((row) => row.externalId ?? null).filter((value): value is string => value !== null && value.length > 0);
  const existingByExternalId = new Map<string, number>();
  if (externalIds.length > 0) {
    const CHUNK = 400;
    for (let offset = 0; offset < externalIds.length; offset += CHUNK) {
      const chunk = externalIds.slice(offset, offset + CHUNK);
      for (const found of db
        .select({ id: transactions.id, externalId: transactions.externalId })
        .from(transactions)
        .where(and(eq(transactions.accountId, input.accountId), isNotNull(transactions.externalId), inArray(transactions.externalId, chunk)))
        .all()) {
        if (found.externalId) existingByExternalId.set(found.externalId, found.id);
      }
    }
  }

  return db.transaction((tx) => {
    const importRow = tx
      .insert(imports)
      .values({
        accountId: input.accountId,
        profileId: input.profileId,
        filename: input.filename,
        importedBy: input.importedBy,
        rowsAdded: 0,
        rowsDuplicate: 0,
        rowsError: input.errors.length,
        createdAt: timestamp,
      })
      .returning({ id: imports.id })
      .get();

    const insertedTransactionIds: number[] = [];
    const duplicateTransactionIds: number[] = [];
    const linked = new Set<number>();

    const link = (transactionId: number) => {
      if (linked.has(transactionId)) return;
      linked.add(transactionId);
      tx.insert(transactionImports)
        .values({ transactionId, importId: importRow.id, createdAt: timestamp })
        .run();
    };

    for (const row of input.rows) {
      // Same '' -> null coalescing as assertInsertable: an empty string must
      // never reach the external_id column, only a real provider id or NULL.
      const providerId = row.externalId || null;
      const existingId = providerId ? existingByExternalId.get(providerId) : existing.get(row.dedupHash);
      if (existingId !== undefined) {
        // Spec section 3: record the association for duplicates too — this is
        // what makes undo safe with overlapping date-range exports.
        duplicateTransactionIds.push(existingId);
        link(existingId);
        continue;
      }

      assertInsertable(row);

      const attribution = resolveAttribution(row.cells);
      if (attribution.matchedName !== null) {
        matchedTally.set(attribution.matchedName, (matchedTally.get(attribution.matchedName) ?? 0) + 1);
      } else if (cardCol !== null) {
        fallbackCount += 1;
      }

      const inserted = tx
        .insert(transactions)
        .values({
          accountId: input.accountId,
          importId: importRow.id,
          attributedUserId: attribution.userId,
          date: row.date,
          rawDescription: row.rawDescription,
          normalizedMerchant: normalizeMerchant(row.rawDescription),
          amountCents: row.amountCents,
          categoryId: null,
          categorizationSource: 'none',
          confidence: null,
          isTransfer: false,
          notes: null,
          // Provider-id rows dedup on external_id; the CSV hash stays NULL on them.
          dedupHash: providerId ? null : row.dedupHash,
          externalId: providerId,
          hashVersion: row.hashVersion,
          createdBy: input.importedBy,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning({ id: transactions.id })
        .get();

      insertedTransactionIds.push(inserted.id);
      if (providerId) existingByExternalId.set(providerId, inserted.id);
      else existing.set(row.dedupHash, inserted.id);
      link(inserted.id);
    }

    // v1.8.0 (spec 2026-08-23, Task 3): one 'csv' balance snapshot per statement date, read
    // straight off the bank's own running-balance column (rulings R4/R5 live entirely inside
    // closingBalancesByDate). Runs over input.rows -- EVERY row this call was handed, not just
    // insertedTransactionIds -- so a duplicate-only re-import of an overlapping statement still
    // re-asserts that statement's balances: the bank's stated balance for a day is true whether
    // or not this call is the first time that day's transactions were seen, and
    // recordBalanceSnapshot's upsert on (accountId, date) makes a repeat write harmless. Called
    // from inside this same db.transaction the way reverseLoanLinksForTransactions is in
    // undoImport below -- getDb() inside recordBalanceSnapshot resolves to the same underlying
    // connection, so this is still atomic with the transaction rows above it.
    for (const [date, balanceCents] of closingBalancesByDate(input.rows, input.dateOrder ?? 'oldest_first')) {
      recordBalanceSnapshot({ accountId: input.accountId, date, balanceCents, source: 'csv' });
    }

    tx.update(imports)
      .set({ rowsAdded: insertedTransactionIds.length, rowsDuplicate: duplicateTransactionIds.length })
      .where(eq(imports.id, importRow.id))
      .run();

    // SHOULD-3.6. Biggest matched bucket first (ties broken by name), the owner-fallback
    // bucket always last regardless of its size -- matching the spec's own example order --
    // and omitted altogether when nothing fell back. null (not "0 rows...") whenever there
    // is genuinely nothing new to report: no cardCol, or an all-duplicate commit.
    let attributionSummary: string | null = null;
    if (cardCol !== null && insertedTransactionIds.length > 0) {
      const parts: string[] = [...matchedTally.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => `${count} ${count === 1 ? 'row' : 'rows'} to ${name}`);
      if (fallbackCount > 0) {
        const label = ownerUserId !== null ? 'the account owner' : 'unattributed';
        parts.push(`${fallbackCount} ${fallbackCount === 1 ? 'row' : 'rows'} to ${label} (no card match)`);
      }
      attributionSummary = parts.length > 0 ? parts.join(', ') : null;
    }

    return {
      importId: importRow.id,
      rowsAdded: insertedTransactionIds.length,
      rowsDuplicate: duplicateTransactionIds.length,
      rowsError: input.errors.length,
      insertedTransactionIds,
      duplicateTransactionIds,
      attributionSummary,
    };
  });
}

export interface ImportHistoryRow {
  id: number;
  accountId: number;
  accountName: string;
  profileId: number | null;
  filename: string;
  importedBy: number;
  importedByName: string;
  rowsAdded: number;
  rowsDuplicate: number;
  rowsError: number;
  createdAt: string;
}

export function listImportHistory(limit = 50): ImportHistoryRow[] {
  return getDb()
    .select({
      id: imports.id,
      accountId: imports.accountId,
      accountName: accounts.name,
      profileId: imports.profileId,
      filename: imports.filename,
      importedBy: imports.importedBy,
      importedByName: users.name,
      rowsAdded: imports.rowsAdded,
      rowsDuplicate: imports.rowsDuplicate,
      rowsError: imports.rowsError,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .innerJoin(users, eq(users.id, imports.importedBy))
    .orderBy(desc(imports.id))
    .limit(limit)
    .all();
}

/** transaction ids associated with this import, split by whether this is their SOLE association. */
function partitionByAssociation(importId: number): { sole: number[]; shared: number[] } {
  const db = getDb();

  // Total associations per transaction, across ALL imports (not just this one),
  // computed as its own grouped subquery and joined back in — a correlated
  // subquery embedded via sql`` here would have its column reference resolve
  // to the subquery's own alias instead of the outer row, silently counting
  // every row in the table for every transaction.
  const counts = db
    .select({
      transactionId: transactionImports.transactionId,
      associations: sql<number>`count(*)`.as('associations'),
    })
    .from(transactionImports)
    .groupBy(transactionImports.transactionId)
    .as('counts');

  const rows = db
    .select({
      transactionId: transactionImports.transactionId,
      associations: counts.associations,
    })
    .from(transactionImports)
    .innerJoin(counts, eq(counts.transactionId, transactionImports.transactionId))
    .where(eq(transactionImports.importId, importId))
    .all();

  const sole: number[] = [];
  const shared: number[] = [];
  for (const row of rows) {
    if (row.associations <= 1) sole.push(row.transactionId);
    else shared.push(row.transactionId);
  }
  return { sole, shared };
}

/** Route-layer guard: an undo of an unknown importId must 404, not silently no-op. */
export function importExists(importId: number): boolean {
  return getDb().select({ id: imports.id }).from(imports).where(eq(imports.id, importId)).get() !== undefined;
}

export interface UndoPreview {
  importId: number;
  willDelete: number;
  willKeep: number;
}

export function previewUndoImport(importId: number): UndoPreview {
  const { sole, shared } = partitionByAssociation(importId);
  return { importId, willDelete: sole.length, willKeep: shared.length };
}

export interface UndoResult {
  deleted: number;
  kept: number;
  loanLinksReversed: number;
}

export function undoImport(importId: number): UndoResult {
  const db = getDb();
  const { tokenize, untrain } = getImportHooks();
  const { sole, shared } = partitionByAssociation(importId);

  return db.transaction((tx) => {
    let loanRowsReversed = 0;
    if (sole.length > 0) {
      // Reverse Bayes training for rows that had reached the confirmed state.
      const confirmed = tx
        .select({ normalizedMerchant: transactions.normalizedMerchant, categoryId: transactions.categoryId })
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, sole),
            eq(transactions.categorizationSource, 'manual'),
            isNotNull(transactions.categoryId),
          ),
        )
        .all();
      for (const row of confirmed) {
        if (row.categoryId !== null) untrain(tokenize(row.normalizedMerchant), row.categoryId);
      }

      // MUST-13.14: BEFORE the delete. The ON DELETE CASCADE on loan_payments.txn_id would
      // remove the rows anyway -- but a cascade cannot restore a balance, so the explicit
      // reversal must run first.
      loanRowsReversed = reverseLoanLinksForTransactions(sole);
      // Ruling B14, same argument one line up and the same position: ON DELETE SET NULL drops
      // the link but cannot restore paid_at, so an installment would be left marked paid by a
      // transaction that no longer exists.
      reverseInstallmentLinksForTransactions(sole);

      // transaction_imports rows cascade away with the transaction.
      tx.delete(transactions).where(inArray(transactions.id, sole)).run();
    }

    // Deleting the imports row is enough to clean up everything else:
    // transaction_imports rows for this import cascade away (onDelete: 'cascade'),
    // and any surviving transaction whose denormalized import_id pointed at this
    // import gets it set to NULL (onDelete: 'set null') — and ONLY when that row's
    // import_id actually was this import, not whichever import happened to share it.
    tx.delete(imports).where(eq(imports.id, importId)).run();
    return { deleted: sole.length, kept: shared.length, loanLinksReversed: loanRowsReversed };
  });
}
