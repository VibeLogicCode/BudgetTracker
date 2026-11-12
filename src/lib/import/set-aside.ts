import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { cache } from 'react';
import { getDb } from '@/db/client';
import { accounts, imports, setAsideRows, transactionImports, transactions, users } from '@/db/schema';
import { appendAudit } from '@/lib/audit';
import { canActOnOwner, isSelfScoped, NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import { runEngine } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { applyPaymentMatchers } from '@/lib/loans';
import { formatCents } from '@/lib/money';
import { getImportHooks } from './hooks';
import type { DuplicateCandidate, ImportOrigin } from './origin';

/**
 * v1.61.0. The imported rows the app is deliberately not counting (set_aside_rows,
 * drizzle/0031_no_double_counting.sql), and the two decisions Needs review makes about them.
 *
 * A `waiting` row is held: an import or the sync met it with no person there to say whether it is
 * a second copy of a row already in the account. It is not a transaction, so no report, budget,
 * digest or balance can count it until somebody presses Keep both. A `dismissed` row is one a
 * person left out, or a transaction they deleted; its key stays here so the next import of the
 * same statement, or the sync's overlap, leaves it out again.
 *
 * Imports nothing from commit.ts: commit, the single delete and Needs review all call in here.
 */

export type SetAsideState = 'waiting' | 'dismissed';
export type SetAsideReason = 'possible_duplicate' | 'deleted';

const CHUNK = 400;

const SELF_SCOPED_ERROR = 'Ask an admin to decide on a possible duplicate.';
const GONE_ERROR = 'That row has already been decided.';

/** What an import path needs to know about a key it met again. */
export interface SetAsideHit {
  id: number;
  state: SetAsideState;
  reason: SetAsideReason;
  decidedAt: string | null;
  candidateTxnId: number | null;
}

/**
 * key -> record, for one account. A key is what commitImport keys a row by: the provider id when
 * there is one, else the CSV hash. Both columns are searched because a key does not say which one
 * it is; a sha256 hex hash and a bank's id do not collide.
 */
export function findSetAsideByKeys(accountId: number, keys: string[]): Map<string, SetAsideHit> {
  const result = new Map<string, SetAsideHit>();
  const unique = [...new Set(keys.filter((key) => key.length > 0))];
  const db = getDb();
  for (let offset = 0; offset < unique.length; offset += CHUNK) {
    const chunk = unique.slice(offset, offset + CHUNK);
    const rows = db
      .select({
        id: setAsideRows.id,
        state: setAsideRows.state,
        reason: setAsideRows.reason,
        decidedAt: setAsideRows.decidedAt,
        candidateTxnId: setAsideRows.candidateTxnId,
        dedupHash: setAsideRows.dedupHash,
        externalId: setAsideRows.externalId,
      })
      .from(setAsideRows)
      .where(
        and(
          eq(setAsideRows.accountId, accountId),
          or(
            and(isNotNull(setAsideRows.externalId), inArray(setAsideRows.externalId, chunk)),
            and(isNotNull(setAsideRows.dedupHash), inArray(setAsideRows.dedupHash, chunk)),
          ),
        ),
      )
      .all();
    for (const row of rows) {
      const key = row.externalId ?? row.dedupHash;
      if (key === null) continue;
      result.set(key, {
        id: row.id,
        state: row.state,
        reason: row.reason,
        decidedAt: row.decidedAt,
        candidateTxnId: row.candidateTxnId,
      });
    }
  }
  return result;
}

export interface RecordSetAsideInput {
  accountId: number;
  importId: number | null;
  state: SetAsideState;
  reason: SetAsideReason;
  origin: ImportOrigin;
  date: string;
  amountCents: number;
  rawDescription: string;
  attributedUserId: number | null;
  dedupHash: string | null;
  externalId: string | null;
  hashVersion: number;
  candidateTxnId: number | null;
  /** Who decided, for a dismissed record. A waiting record has nobody yet. */
  decidedBy?: number | null;
  at?: Date;
}

/**
 * Write one record and return its id. Keyed as commitImport keys a transaction: a provider id wins
 * and the hash is then stored as NULL; '' counts as no id. A record already holding the key on
 * this account is replaced in place, so a caller never has to look first.
 *
 * Runs on getDb(), so a caller inside a db.transaction (commitImport) writes inside it.
 */
export function recordSetAside(input: RecordSetAsideInput): number {
  const externalId = input.externalId || null;
  const dedupHash = externalId ? null : input.dedupHash || null;
  if (externalId === null && dedupHash === null) throw new Error('A set-aside row needs a hash or a provider id.');
  const timestamp = nowIso(input.at);
  const dismissed = input.state === 'dismissed';
  const values = {
    accountId: input.accountId,
    importId: input.importId,
    state: input.state,
    reason: input.reason,
    origin: input.origin,
    date: input.date,
    amountCents: input.amountCents,
    rawDescription: input.rawDescription,
    attributedUserId: input.attributedUserId,
    dedupHash,
    externalId,
    hashVersion: input.hashVersion,
    candidateTxnId: input.candidateTxnId,
    decidedBy: dismissed ? (input.decidedBy ?? null) : null,
    decidedAt: dismissed ? timestamp : null,
    createdAt: timestamp,
  };
  const db = getDb();
  const existing = findSetAsideByKeys(input.accountId, [externalId ?? (dedupHash as string)]).get(externalId ?? (dedupHash as string));
  if (existing !== undefined) {
    db.update(setAsideRows).set(values).where(eq(setAsideRows.id, existing.id)).run();
    return existing.id;
  }
  return db.insert(setAsideRows).values(values).returning({ id: setAsideRows.id }).get().id;
}

/** Remove one record: the person chose to import a row they had left out before. */
export function removeSetAside(id: number): void {
  getDb().delete(setAsideRows).where(eq(setAsideRows.id, id)).run();
}

/**
 * D5. Run BEFORE any transaction is deleted (single delete or undo), while candidate_txn_id still
 * points at it: every row left out as a copy of one of these goes back to waiting, so leaving out a
 * copy can never end with neither copy counted. The delete's ON DELETE SET NULL then clears the
 * pointer, and Needs review shows the row with its match gone. Returns how many reopened.
 */
export function reopenSetAsideFor(txnIds: number[]): number {
  const db = getDb();
  let reopened = 0;
  for (let offset = 0; offset < txnIds.length; offset += CHUNK) {
    const result = db
      .update(setAsideRows)
      .set({ state: 'waiting', decidedBy: null, decidedAt: null })
      .where(and(inArray(setAsideRows.candidateTxnId, txnIds.slice(offset, offset + CHUNK)), eq(setAsideRows.state, 'dismissed')))
      .run();
    reopened += Number(result.changes ?? 0);
  }
  return reopened;
}

/** The waiting rows one import set aside: what its undo removes with it. */
export function countWaitingForImport(importId: number): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(setAsideRows)
      .where(and(eq(setAsideRows.importId, importId), eq(setAsideRows.state, 'waiting')))
      .get()?.n ?? 0
  );
}

/**
 * Undo removes its import's waiting rows: they never counted, and the import they wait under is
 * going. Its dismissed rows stay, with import_id nulled by the foreign key, so the same statement
 * imported again still leaves out what a person decided against.
 */
export function deleteWaitingForImport(importId: number): number {
  const result = getDb()
    .delete(setAsideRows)
    .where(and(eq(setAsideRows.importId, importId), eq(setAsideRows.state, 'waiting')))
    .run();
  return Number(result.changes ?? 0);
}

/** One held row as Needs review shows it. */
export interface WaitingSetAsideRow {
  id: number;
  accountId: number;
  accountName: string;
  origin: ImportOrigin;
  importId: number | null;
  importFilename: string | null;
  date: string;
  amountCents: number;
  rawDescription: string;
  attributedUserId: number | null;
  personName: string | null;
  reason: SetAsideReason;
  createdAt: string;
  /** The row it looks like, or null when that row has since been deleted. */
  candidate: DuplicateCandidate | null;
}

/**
 * Every waiting row, oldest first. Needs review is household-only, so a self-scoped viewer gets
 * nothing at all: not the rows, not the candidates, not their people.
 */
export function listWaitingSetAside(viewer: Viewer): WaitingSetAsideRow[] {
  if (isSelfScoped(viewer)) return [];
  const person = alias(users, 'set_aside_person');
  const candidate = alias(transactions, 'set_aside_candidate');
  const candidatePerson = alias(users, 'set_aside_candidate_person');
  const rows = getDb()
    .select({
      id: setAsideRows.id,
      accountId: setAsideRows.accountId,
      accountName: accounts.name,
      origin: setAsideRows.origin,
      importId: setAsideRows.importId,
      importFilename: imports.filename,
      date: setAsideRows.date,
      amountCents: setAsideRows.amountCents,
      rawDescription: setAsideRows.rawDescription,
      attributedUserId: setAsideRows.attributedUserId,
      personName: person.name,
      reason: setAsideRows.reason,
      createdAt: setAsideRows.createdAt,
      candidateId: candidate.id,
      candidateDate: candidate.date,
      candidateDescription: sql<string | null>`coalesce(${candidate.displayDescription}, ${candidate.rawDescription})`,
      candidateAmountCents: candidate.amountCents,
      candidateOrigin: candidate.origin,
      candidatePersonName: candidatePerson.name,
    })
    .from(setAsideRows)
    .innerJoin(accounts, eq(accounts.id, setAsideRows.accountId))
    .leftJoin(imports, eq(imports.id, setAsideRows.importId))
    .leftJoin(person, eq(person.id, setAsideRows.attributedUserId))
    .leftJoin(candidate, eq(candidate.id, setAsideRows.candidateTxnId))
    .leftJoin(candidatePerson, eq(candidatePerson.id, candidate.attributedUserId))
    .where(sql`${setAsideRows.state} = 'waiting'`)
    .orderBy(asc(setAsideRows.createdAt), asc(setAsideRows.id))
    .all();
  return rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    origin: row.origin,
    importId: row.importId,
    importFilename: row.importFilename,
    date: row.date,
    amountCents: row.amountCents,
    rawDescription: row.rawDescription,
    attributedUserId: row.attributedUserId,
    personName: row.personName,
    reason: row.reason,
    createdAt: row.createdAt,
    candidate:
      row.candidateId === null ||
      row.candidateDate === null ||
      row.candidateAmountCents === null ||
      row.candidateOrigin === null
        ? null
        : {
            id: row.candidateId,
            date: row.candidateDate,
            description: row.candidateDescription ?? '',
            amountCents: row.candidateAmountCents,
            origin: row.candidateOrigin,
            personName: row.candidatePersonName,
          },
  }));
}

/**
 * How many rows wait in Needs review. Wrapped in React `cache` as reviewQueueCount is, so the
 * layout and the page share one count per request. Not viewer-scoped: the callers show it only to
 * household viewers. The literal predicate plans through set_aside_rows_waiting_idx.
 */
export const waitingSetAsideCount = cache((): number => {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(setAsideRows)
    .where(sql`${setAsideRows.state} = 'waiting'`)
    .get();
  return row?.c ?? 0;
});

/** `MAPLE GROCER -42.17 on 2026-03-09`: the audit detail for a decision. */
function auditDetail(record: { rawDescription: string; amountCents: number; date: string }): string {
  return `${record.rawDescription.slice(0, 80)} ${formatCents(record.amountCents, { currency: false })} on ${record.date}`;
}

function loadRecord(id: number) {
  return getDb().select().from(setAsideRows).where(eq(setAsideRows.id, id)).get();
}

/**
 * Keep both. The held row becomes the transaction its import would have written: the stored hash
 * or provider id, hash version, origin and person, the merchant normalized now, and the record's
 * import as its import (linked, and counted in that import's rows_added). Any household viewer may
 * do it; a self-scoped viewer is refused, because Needs review is the household's.
 *
 * The rules engine and the loan matchers run after the commit, the order commitStagedImport uses,
 * so a category rule files it exactly as it would have filed the same row on import.
 */
export function releaseSetAsideRow(input: {
  id: number;
  userId: number;
  viewer: Viewer;
  at?: Date;
}): { ok: true; transactionId: number } | { error: string } {
  if (isSelfScoped(input.viewer)) return { error: SELF_SCOPED_ERROR };
  const db = getDb();
  const record = loadRecord(input.id);
  if (record === undefined || record.state !== 'waiting') return { error: GONE_ERROR };

  const { normalizeMerchant } = getImportHooks();
  const timestamp = nowIso(input.at);
  const importRow =
    record.importId === null
      ? undefined
      : db.select({ importedBy: imports.importedBy }).from(imports).where(eq(imports.id, record.importId)).get();

  const outcome = db.transaction((tx): { id: number } | { error: string } => {
    // The account's unique keys would refuse the insert anyway; asking first keeps the record.
    const keyTaken = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, record.accountId),
          record.externalId !== null
            ? eq(transactions.externalId, record.externalId)
            : eq(transactions.dedupHash, record.dedupHash ?? ''),
        ),
      )
      .get();
    if (keyTaken !== undefined) return { error: 'That row is already in the account.' };
    const removed = tx
      .delete(setAsideRows)
      .where(and(eq(setAsideRows.id, record.id), eq(setAsideRows.state, 'waiting')))
      .run();
    if (Number(removed.changes ?? 0) !== 1) return { error: GONE_ERROR };

    const inserted = tx
      .insert(transactions)
      .values({
        accountId: record.accountId,
        importId: importRow === undefined ? null : record.importId,
        attributedUserId: record.attributedUserId,
        date: record.date,
        rawDescription: record.rawDescription,
        normalizedMerchant: normalizeMerchant(record.rawDescription),
        amountCents: record.amountCents,
        categoryId: null,
        categorizationSource: 'none',
        confidence: null,
        isTransfer: false,
        notes: null,
        dedupHash: record.dedupHash,
        externalId: record.externalId,
        hashVersion: record.hashVersion,
        origin: record.origin,
        createdBy: importRow?.importedBy ?? input.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: transactions.id })
      .get();

    if (importRow !== undefined && record.importId !== null) {
      tx.insert(transactionImports)
        .values({ transactionId: inserted.id, importId: record.importId, createdAt: timestamp })
        .onConflictDoNothing()
        .run();
      tx.update(imports)
        .set({ rowsAdded: sql`${imports.rowsAdded} + 1` })
        .where(eq(imports.id, record.importId))
        .run();
    }

    appendAudit({
      userId: input.userId,
      action: 'keep_duplicate',
      entity: 'set_aside_rows',
      entityId: record.id,
      detail: auditDetail(record),
      at: timestamp,
    });
    return { id: inserted.id };
  });
  if ('error' in outcome) return outcome;
  const transactionId = outcome.id;

  // After the commit, as commitStagedImport does: the row is in, so a categorizer failure leaves it
  // uncategorized (where the review queue finds it) rather than undoing the decision.
  try {
    runEngine([transactionId]);
  } catch {
    /* the row stays uncategorized */
  }
  applyPaymentMatchers([transactionId], input.at ?? new Date());
  return { ok: true, transactionId };
}

/**
 * Delete this one. The held row is left out for good: dismissed, with who and when. When the row it
 * matched came from an import, that row is linked to this record's import as an exact duplicate
 * would be, so undoing either import keeps it. A hand-typed match is never linked, so no undo can
 * delete a row somebody typed.
 *
 * Refused to a self-scoped viewer, and to anyone who may not act on the row's person
 * (canActOnOwner: an admin, the person, or anyone for a shared row).
 */
export function dismissSetAsideRow(input: {
  id: number;
  userId: number;
  viewer: Viewer;
  at?: Date;
}): { ok: true } | { error: string } {
  if (isSelfScoped(input.viewer)) return { error: SELF_SCOPED_ERROR };
  const db = getDb();
  const record = loadRecord(input.id);
  if (record === undefined || record.state !== 'waiting') return { error: GONE_ERROR };
  if (!canActOnOwner(record.attributedUserId, input.viewer)) return { error: NOT_YOURS_ERROR };

  const timestamp = nowIso(input.at);
  const done = db.transaction((tx) => {
    const changed = tx
      .update(setAsideRows)
      .set({ state: 'dismissed', decidedBy: input.userId, decidedAt: timestamp })
      .where(and(eq(setAsideRows.id, record.id), eq(setAsideRows.state, 'waiting')))
      .run();
    if (Number(changed.changes ?? 0) !== 1) return false;

    if (record.importId !== null && record.candidateTxnId !== null) {
      const match = tx
        .select({ origin: transactions.origin })
        .from(transactions)
        .where(eq(transactions.id, record.candidateTxnId))
        .get();
      if (match !== undefined && match.origin !== 'manual') {
        tx.insert(transactionImports)
          .values({ transactionId: record.candidateTxnId, importId: record.importId, createdAt: timestamp })
          .onConflictDoNothing()
          .run();
      }
    }

    appendAudit({
      userId: input.userId,
      action: 'dismiss_duplicate',
      entity: 'set_aside_rows',
      entityId: record.id,
      detail: auditDetail(record),
      at: timestamp,
    });
    return true;
  });
  return done ? { ok: true } : { error: GONE_ERROR };
}
