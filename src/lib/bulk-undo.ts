import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { appendAudit } from '@/lib/audit';
import { HOUSEHOLD_VIEWER, NOT_YOURS_ERROR, ownerScope, type Viewer } from '@/lib/auth/viewer';
import { train, untrain } from '@/lib/categorize/bayes';
import { tokenize } from '@/lib/categorize/normalize';
import {
  alwaysAskRuleFor,
  exactRuleRows,
  listRules,
  restoreExactRules,
  type ExactRuleRow,
  type RuleKind,
} from '@/lib/categorize/rules';
import { nowIso } from '@/lib/clock';
import { loanLinksForTransactions, unassignTransactionFromLoan } from '@/lib/loans';
import { deleteSetting, getSetting, setSetting } from '@/lib/settings';
import { transactionOwners } from '@/lib/transactions';
import { z } from '@/lib/zod';

/**
 * v1.62.0 (plan item 3). Undo for the last bulk change, per person, for 15 minutes.
 *
 * WHY LAST-ONLY, PER PERSON, 15 MINUTES. Undo is for the wrong pick noticed at once, on the screen
 * where it was made. Within 15 minutes later imports, engine runs and other members rarely touch
 * the same rows, so a faithful restore is almost always possible; past that a restore would often
 * have to refuse. Last only, because two stacked undos over overlapping rows need an ordering model
 * the app does not have. Per person, so one member's undo can never reverse another member's work:
 * the record lives under that person's own settings key and nothing reads another person's.
 *
 * WHAT IS RECORDED. The rows the change moved (category, source, confidence, transfer flag, person),
 * the exact rules it created, removed or rewrote (every column, ids included), the Bayes training
 * confirmCategory did for each row, and the loan links applyPaymentMatchers added. An undo restores
 * all of it in one transaction, or refuses whole with nothing written.
 *
 * In `settings` with no migration, as insight dismissals and the sync backoff are: one record per
 * person, replaced by their next change and gone 15 minutes later.
 */
export const BULK_UNDO_MINUTES = 15;
export const BULK_UNDO_MAX_ROWS = 2000;

export type BulkUndoKind = 'categorize' | 'transfer' | 'person' | 'recurring' | 'transfer_pair';

/** One wording, one place: no record, or one older than the window. */
export const BULK_UNDO_EXPIRED_ERROR = 'That change is more than 15 minutes old, so it can no longer be undone.';
/** One wording, one place: something the change wrote has moved since. */
export const BULK_UNDO_STALE_ERROR = 'Something in that change was edited since, so it cannot be undone. Nothing was changed.';

const KEY_PREFIX = 'bulk_undo:';
const settingKey = (userId: number) => `${KEY_PREFIX}${userId}`;

/** Every kind a bulk path can write an exact rule of. rename and always_ask are never touched. */
const UNDO_RULE_KINDS: readonly RuleKind[] = ['category', 'transfer', 'not_transfer', 'attribution', 'recurring', 'not_recurring'];

const SOURCES = ['rule', 'bayes', 'manual', 'none'] as const;

/** The columns of a row an undo puts back, and the ones its staleness check compares. */
const rowColumnsSchema = z.object({
  categoryId: z.number().int().nullable(),
  categorizationSource: z.enum(SOURCES),
  confidence: z.number().nullable(),
  isTransfer: z.boolean(),
  attributedUserId: z.number().int().nullable(),
});
type RowColumns = z.infer<typeof rowColumnsSchema>;

/**
 * Every merchant_rules column. Typed against the table's own row type, so a column added to the
 * table and not here fails to compile rather than being dropped from a restore.
 */
const ruleRowSchema: z.ZodType<ExactRuleRow> = z.object({
  id: z.number().int(),
  pattern: z.string(),
  matchType: z.enum(['exact', 'contains', 'word']),
  ruleKind: z.enum(['category', 'transfer', 'rename', 'not_transfer', 'attribution', 'recurring', 'not_recurring', 'always_ask']),
  categoryId: z.number().int().nullable(),
  renameTo: z.string().nullable(),
  createdBy: z.number().int().nullable(),
  hitCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  lastModifiedBy: z.number().int().nullable(),
  disabledAt: z.string().nullable(),
  packSource: z.string().nullable(),
  packVersion: z.number().int().nullable(),
  installedAt: z.string().nullable(),
  packOriginKey: z.string().nullable(),
  amountMinCents: z.number().int().nullable(),
  amountMaxCents: z.number().int().nullable(),
  attributedUserId: z.number().int().nullable(),
});

const recordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['categorize', 'transfer', 'person', 'recurring', 'transfer_pair']),
  label: z.string(),
  at: z.string(),
  expiresAt: z.string(),
  rows: z.array(
    z.object({
      id: z.number().int(),
      merchant: z.string(),
      before: rowColumnsSchema,
      after: rowColumnsSchema,
      /** The category confirmCategory trained for this row, which the undo untrains. */
      trained: z.number().int().nullable(),
      /** The category confirmCategory untrained for this row, which the undo trains back. */
      untrained: z.number().int().nullable(),
    }),
  ),
  rules: z.object({
    /** As the change left them; the undo deletes them. */
    created: z.array(ruleRowSchema),
    /** As they were before the change deleted them; the undo re-inserts them. */
    removed: z.array(ruleRowSchema),
    modified: z.array(z.object({ before: ruleRowSchema, after: ruleRowSchema })),
  }),
  loanLinks: z.array(z.object({ txnId: z.number().int(), itemId: z.number().int() })),
});
type BulkUndoRecord = z.infer<typeof recordSchema>;

interface RowState extends RowColumns {
  id: number;
  normalizedMerchant: string;
}

/** What captureBulkBefore saw. Opaque to callers: they hand it straight to recordBulkUndo. */
export type BulkBefore =
  | { tooLarge: true }
  | {
      tooLarge: false;
      ids: number[];
      rows: RowState[];
      patterns: string[];
      rules: ExactRuleRow[];
      linkedIds: number[];
      alwaysAskMerchants: string[];
    };

export type BulkUndoRecordOutcome = 'recorded' | 'unchanged' | 'too_large';

export interface BulkUndoSummary {
  label: string;
  /** How many transactions an undo would put back. */
  rows: number;
  /** ISO instant; past it the change can no longer be undone. */
  expiresAt: string;
}

export type BulkUndoResult =
  | { ok: true; rows: number; rulesRemoved: number; rulesRestored: number }
  | { ok: false; error: string };

/** Trimmed and uppercased, as setRecurringMarks and the rule write choke point store a pattern. */
function asPattern(merchant: string): string {
  return merchant.trim().toUpperCase();
}

function readRows(ids: readonly number[]): RowState[] {
  if (ids.length === 0) return [];
  return getDb()
    .select({
      id: transactions.id,
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      categorizationSource: transactions.categorizationSource,
      confidence: transactions.confidence,
      isTransfer: transactions.isTransfer,
      attributedUserId: transactions.attributedUserId,
    })
    .from(transactions)
    .where(inArray(transactions.id, [...ids]))
    .all();
}

function columnsOf(row: RowState): RowColumns {
  return {
    categoryId: row.categoryId,
    categorizationSource: row.categorizationSource,
    confidence: row.confidence,
    isTransfer: row.isTransfer,
    attributedUserId: row.attributedUserId,
  };
}

function sameColumns(a: RowColumns, b: RowColumns): boolean {
  return (
    a.categoryId === b.categoryId &&
    a.categorizationSource === b.categorizationSource &&
    a.confidence === b.confidence &&
    a.isTransfer === b.isTransfer &&
    a.attributedUserId === b.attributedUserId
  );
}

/** Every column, hit count and last use included: a rule that fired since has done work on rows this record never saw. */
function sameRule(a: ExactRuleRow, b: ExactRuleRow): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ExactRuleRow>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/**
 * Snapshot before a bulk change: the rows (one read), every exact rule on their merchants plus
 * `merchants` (a recurring mark names merchants, not rows), which of the rows already carry a loan
 * link, and which merchants an enabled Always ask rule covers (confirmCategory trains nothing for
 * those). Over BULK_UNDO_MAX_ROWS it reads nothing and says so.
 */
export function captureBulkBefore(input: { ids: readonly number[]; merchants?: readonly string[] }): BulkBefore {
  const ids = [...new Set(input.ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length > BULK_UNDO_MAX_ROWS) return { tooLarge: true };
  const rows = readRows(ids);
  const patterns = [
    ...new Set([...rows.map((row) => row.normalizedMerchant), ...(input.merchants ?? [])].map(asPattern).filter((p) => p.length > 0)),
  ];
  const alwaysAsk = listRules('always_ask');
  const merchants = [...new Set(rows.map((row) => row.normalizedMerchant))];
  return {
    tooLarge: false,
    ids,
    rows,
    patterns,
    rules: exactRuleRows(patterns, UNDO_RULE_KINDS),
    linkedIds: [...loanLinksForTransactions(ids).keys()],
    alwaysAskMerchants: merchants.filter((merchant) => alwaysAskRuleFor(merchant, alwaysAsk) !== null),
  };
}

/**
 * The Bayes pair confirmCategory made for a row it moved: it untrains the old category when the
 * row was already `manual` with one, and trains the new one unless the merchant is Always ask. A
 * row reaches `manual` with a different category or source only through confirmCategory, so any
 * other change (a transfer flag, a person) has no pair.
 */
function bayesPair(before: RowColumns, after: RowColumns, alwaysAsk: boolean): { trained: number | null; untrained: number | null } {
  const confirmed =
    after.categorizationSource === 'manual' &&
    after.categoryId !== null &&
    (before.categorizationSource !== 'manual' || before.categoryId !== after.categoryId);
  if (!confirmed) return { trained: null, untrained: null };
  return {
    trained: alwaysAsk ? null : after.categoryId,
    untrained: before.categorizationSource === 'manual' && before.categoryId !== null ? before.categoryId : null,
  };
}

/**
 * After a bulk change: reads the same rows and rules again, keeps only what changed, and stores it
 * as this person's one undo record until `at` + 15 minutes. A change that moved nothing writes
 * nothing and leaves the previous record. A change too large to record deletes the previous one,
 * so Undo can never name an older action than the latest.
 */
export function recordBulkUndo(input: {
  userId: number;
  kind: BulkUndoKind;
  label: string;
  before: BulkBefore;
  at: Date;
}): BulkUndoRecordOutcome {
  const key = settingKey(input.userId);
  const before = input.before;
  if (before.tooLarge) {
    deleteSetting(key);
    return 'too_large';
  }

  const alwaysAsk = new Set(before.alwaysAskMerchants);
  const afterRows = new Map(readRows(before.ids).map((row) => [row.id, row]));
  const rows: BulkUndoRecord['rows'] = [];
  for (const prior of before.rows) {
    const now = afterRows.get(prior.id);
    if (now === undefined) continue;
    const was = columnsOf(prior);
    const is = columnsOf(now);
    if (sameColumns(was, is) && prior.normalizedMerchant === now.normalizedMerchant) continue;
    rows.push({ id: prior.id, merchant: now.normalizedMerchant, before: was, after: is, ...bayesPair(was, is, alwaysAsk.has(prior.normalizedMerchant)) });
  }

  const priorRules = new Map(before.rules.map((rule) => [rule.id, rule]));
  const afterRules = new Map(exactRuleRows(before.patterns, UNDO_RULE_KINDS).map((rule) => [rule.id, rule]));
  const rules: BulkUndoRecord['rules'] = { created: [], removed: [], modified: [] };
  for (const [id, rule] of afterRules) {
    const prior = priorRules.get(id);
    if (prior === undefined) rules.created.push(rule);
    else if (!sameRule(prior, rule)) rules.modified.push({ before: prior, after: rule });
  }
  for (const [id, prior] of priorRules) if (!afterRules.has(id)) rules.removed.push(prior);

  const linkedBefore = new Set(before.linkedIds);
  const loanLinks: BulkUndoRecord['loanLinks'] = [];
  for (const [txnId, links] of loanLinksForTransactions(before.ids)) {
    if (linkedBefore.has(txnId)) continue;
    for (const link of links) if (link.source === 'rule') loanLinks.push({ txnId, itemId: link.itemId });
  }

  if (rows.length === 0 && rules.created.length + rules.removed.length + rules.modified.length === 0 && loanLinks.length === 0) {
    return 'unchanged';
  }
  const record: BulkUndoRecord = {
    v: 1,
    kind: input.kind,
    label: input.label,
    at: nowIso(input.at),
    expiresAt: nowIso(new Date(input.at.getTime() + BULK_UNDO_MINUTES * 60_000)),
    rows,
    rules,
    loanLinks,
  };
  setSetting(key, JSON.stringify(record));
  return 'recorded';
}

function readRecord(userId: number): BulkUndoRecord | null {
  const raw = getSetting(settingKey(userId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = recordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Over the window once more than 15 minutes have passed; at exactly 15 it can still be undone. */
function expired(record: BulkUndoRecord, now: Date): boolean {
  return now.getTime() > Date.parse(record.expiresAt);
}

/** The transactions an undo puts back: the moved rows and the rows that lost a loan link. */
function restoredIds(record: BulkUndoRecord): number[] {
  return [...new Set([...record.rows.map((row) => row.id), ...record.loanLinks.map((link) => link.txnId)])].sort((a, b) => a - b);
}

/** What the Undo bar shows, or null. Reading an expired (or unreadable) record deletes it. */
export function lastBulkUndo(userId: number, now: Date): BulkUndoSummary | null {
  const record = readRecord(userId);
  if (record === null || expired(record, now)) {
    if (getSetting(settingKey(userId)) !== null) deleteSetting(settingKey(userId));
    return null;
  }
  return { label: record.label, rows: restoredIds(record).length, expiresAt: record.expiresAt };
}

/** Thrown inside the undo transaction to unwind it; never escapes this file. */
class StaleUndo extends Error {
  constructor() {
    super('stale');
  }
}

/** better-sqlite3 names a constraint failure SQLITE_CONSTRAINT_*; drizzle may wrap it in a cause. */
function isConstraintError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Is everything the record wrote still exactly as the change left it? */
function stillAsRecorded(record: BulkUndoRecord): boolean {
  const current = new Map(readRows(record.rows.map((row) => row.id)).map((row) => [row.id, row]));
  for (const row of record.rows) {
    const now = current.get(row.id);
    if (now === undefined || now.normalizedMerchant !== row.merchant || !sameColumns(columnsOf(now), row.after)) return false;
  }

  const recorded = [...record.rules.created, ...record.rules.removed, ...record.rules.modified.map((pair) => pair.after)];
  if (recorded.length > 0) {
    const rules = new Map(exactRuleRows([...new Set(recorded.map((rule) => rule.pattern))], UNDO_RULE_KINDS).map((rule) => [rule.id, rule]));
    for (const rule of record.rules.created) {
      const now = rules.get(rule.id);
      if (now === undefined || !sameRule(now, rule)) return false;
    }
    for (const rule of record.rules.removed) if (rules.has(rule.id)) return false;
    for (const pair of record.rules.modified) {
      const now = rules.get(pair.after.id);
      if (now === undefined || !sameRule(now, pair.after)) return false;
    }
  }

  if (record.loanLinks.length > 0) {
    const links = loanLinksForTransactions(record.loanLinks.map((link) => link.txnId));
    for (const link of record.loanLinks) {
      if (!(links.get(link.txnId) ?? []).some((row) => row.itemId === link.itemId && row.source === 'rule')) return false;
    }
  }
  return true;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `Undid: Categorized 12 transactions as Groceries (1 rule removed)`. */
function auditDetail(label: string, removed: number, restored: number): string {
  const parts: string[] = [];
  if (removed > 0) parts.push(`${plural(removed, 'rule', 'rules')} removed`);
  if (restored > 0) parts.push(`${plural(restored, 'rule', 'rules')} restored`);
  const sentence = label.trim().replace(/\.+$/, '');
  return parts.length === 0 ? `Undid: ${sentence}` : `Undid: ${sentence} (${parts.join(', ')})`;
}

/**
 * Takes back the viewer's own last bulk change. Refuses, with nothing written, when there is no
 * record or it is over 15 minutes old; when a self-scoped viewer would restore a row that is no
 * longer theirs; and when anything the change wrote has been edited since (a row's tracked
 * columns, a rule it created, removed or rewrote, a loan link it added). Otherwise restores all of
 * it in one transaction -- rows, Bayes training, rules, loan links -- deletes the record and writes
 * one audit row. A constraint failure partway rolls everything back and reads as the stale refusal.
 *
 * The person column is written back as the exact value this person's own change replaced minutes
 * earlier, never re-resolved: asking the attribution order again would move rows nobody asked
 * about.
 */
export function undoLastBulkAction(input: { viewer: Viewer; now: Date }): BulkUndoResult {
  const userId = input.viewer.id;
  const record = readRecord(userId);
  if (record === null || expired(record, input.now)) return { ok: false, error: BULK_UNDO_EXPIRED_ERROR };

  const ids = restoredIds(record);
  const scope = ownerScope(input.viewer);
  if (scope !== null) {
    // A row that no longer exists is not someone else's; the staleness check refuses it below.
    for (const owner of transactionOwners(ids).values()) if (owner !== scope) return { ok: false, error: NOT_YOURS_ERROR };
  }

  const stamp = nowIso(input.now);
  try {
    return getDb().transaction((tx) => {
      if (!stillAsRecorded(record)) throw new StaleUndo();

      for (const row of record.rows) {
        tx.update(transactions)
          .set({
            categoryId: row.before.categoryId,
            categorizationSource: row.before.categorizationSource,
            confidence: row.before.confidence,
            isTransfer: row.before.isTransfer,
            attributedUserId: row.before.attributedUserId,
            updatedAt: stamp,
          })
          .where(eq(transactions.id, row.id))
          .run();
        // The mirror of confirmCategory's pair: it untrained the old category, then trained the new.
        const tokens = tokenize(row.merchant);
        if (row.trained !== null) untrain(tokens, row.trained);
        if (row.untrained !== null) train(tokens, row.untrained);
      }

      const rules = restoreExactRules({
        before: [...record.rules.removed, ...record.rules.modified.map((pair) => pair.before)],
        createdIds: record.rules.created.map((rule) => rule.id),
      });

      // The links were made by the matcher inside this person's change, with no viewer at all, so
      // they come off the same way: a self-scoped person's payment can match a loan they cannot
      // open, and leaving that link behind would be half an undo.
      for (const link of record.loanLinks) {
        if (!unassignTransactionFromLoan({ txnId: link.txnId, itemId: link.itemId, viewer: HOUSEHOLD_VIEWER, at: input.now })) {
          throw new StaleUndo();
        }
      }

      deleteSetting(settingKey(userId));
      const ruleIds = [
        ...record.rules.created.map((rule) => rule.id),
        ...record.rules.removed.map((rule) => rule.id),
        ...record.rules.modified.map((pair) => pair.after.id),
      ].sort((a, b) => a - b);
      appendAudit({
        userId,
        action: 'undo_bulk_action',
        entity: ids.length > 0 ? 'transactions' : 'merchant_rules',
        entityId: ids.length > 0 ? (ids[0] as number) : (ruleIds[0] ?? 0),
        detail: auditDetail(record.label, rules.removed, rules.restored),
        at: stamp,
      });
      return { ok: true as const, rows: ids.length, rulesRemoved: rules.removed, rulesRestored: rules.restored };
    });
  } catch (error) {
    if (error instanceof StaleUndo || isConstraintError(error)) return { ok: false, error: BULK_UNDO_STALE_ERROR };
    throw error;
  }
}
