import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { aiSuggestions, transactions } from '@/db/schema';
import { isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { categoryLabel, listCategories } from '@/lib/categories';
import { REVIEW_WHERE, UNCATEGORIZED_WHERE } from '@/lib/categorize/engine';
import { alwaysAskRuleFor, listRules } from '@/lib/categorize/rules';
import { nowIso } from '@/lib/clock';
import type { MerchantPromptRow } from '@/lib/ai/prompts';
import type { AiSuggestionCounts, AiSuggestionView } from '@/lib/ai/types';

/**
 * v1.64.0 (plan 2026-11-12, A7 and L8). THE ONE WRITER OF ai_suggestions, and the one definition of
 * which merchants the model may be asked about. Nothing here writes a transaction or a rule
 * (tests/ops/ai-suggest-only): a suggestion is used only when a person presses a button that posts
 * to an existing category or rename action.
 *
 * A target is a merchant with at least one row that is in the review queue, uncategorized and
 * unsplit (REVIEW_WHERE with UNCATEGORIZED_WHERE: no transfer, no loan link, no Bayes guess, no
 * rule), with a non-empty normalized merchant, no ai_suggestions row yet (of any status), and no
 * Always ask rule (such a merchant gets no guess from the engine either). Most rows first, then the
 * newest. One question per merchant, never per row.
 */

const TARGET_WHERE = and(REVIEW_WHERE, UNCATEGORIZED_WHERE, ne(transactions.normalizedMerchant, ''));
const NO_ROW_YET = sql`not exists (select 1 from ${aiSuggestions} where ${aiSuggestions.normalizedMerchant} = ${transactions.normalizedMerchant})`;

export const MAX_FAILURE_REASON_CHARS = 200;

/** Every target merchant, in asking order, Always ask merchants left out. */
function allTargets(): string[] {
  const rows = getDb()
    .select({ merchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(TARGET_WHERE, NO_ROW_YET))
    .groupBy(transactions.normalizedMerchant)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${transactions.date})`), transactions.normalizedMerchant)
    .all();
  const alwaysAsk = listRules('always_ask');
  return rows.map((row) => row.merchant).filter((merchant) => alwaysAskRuleFor(merchant, alwaysAsk) === null);
}

/** Up to `limit` merchants to ask about next (one grouped read; Always ask filtered in memory). */
export function aiMerchantTargets(limit: number): string[] {
  return allTargets().slice(0, Math.max(0, limit));
}

/**
 * The one row a merchant prompt carries: the newest target row of that merchant, as its raw
 * description, signed amount and date only. Null when the merchant is no longer a target (filed,
 * marked Always ask, or already holding a row), so the queue skips it without a call.
 */
export function merchantPromptRow(merchant: string): MerchantPromptRow | null {
  if (typeof merchant !== 'string' || merchant.length === 0) return null;
  if (aiSuggestionFor(merchant) !== null) return null;
  if (alwaysAskRuleFor(merchant) !== null) return null;
  const row = getDb()
    .select({ rawDescription: transactions.rawDescription, amountCents: transactions.amountCents, date: transactions.date })
    .from(transactions)
    .where(and(TARGET_WHERE, eq(transactions.normalizedMerchant, merchant)))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** A model's suggestion for a merchant. False when the merchant already has a row (nothing written). */
export function recordMerchantSuggestion(input: {
  merchant: string;
  categoryId: number | null;
  cleanName: string | null;
  model: string;
  at: Date;
}): boolean {
  const result = getDb()
    .insert(aiSuggestions)
    .values({
      normalizedMerchant: input.merchant,
      status: 'suggested',
      categoryId: input.categoryId,
      cleanName: input.cleanName,
      model: input.model,
      createdAt: nowIso(input.at),
    })
    .onConflictDoNothing({ target: aiSuggestions.normalizedMerchant })
    .run();
  return result.changes > 0;
}

/** An answer that could not be used. The merchant is not asked again until failed rows are cleared. */
export function recordMerchantFailure(input: { merchant: string; model: string; reason: string; at: Date }): boolean {
  const result = getDb()
    .insert(aiSuggestions)
    .values({
      normalizedMerchant: input.merchant,
      status: 'failed',
      model: input.model,
      reason: input.reason.slice(0, MAX_FAILURE_REASON_CHARS) || null,
      createdAt: nowIso(input.at),
    })
    .onConflictDoNothing({ target: aiSuggestions.normalizedMerchant })
    .run();
  return result.changes > 0;
}

/** A person set the merchant's suggestion aside. It stays ignored until Forget all AI suggestions. */
export function ignoreAiSuggestion(input: { merchant: string; userId: number; at: Date }): boolean {
  const result = getDb()
    .update(aiSuggestions)
    .set({ status: 'ignored', decidedBy: input.userId, decidedAt: nowIso(input.at) })
    .where(and(eq(aiSuggestions.normalizedMerchant, input.merchant), ne(aiSuggestions.status, 'ignored')))
    .run();
  return result.changes > 0;
}

/** Every row, of every status. Returns how many were deleted. The caller audits it. */
export function forgetAiSuggestions(): number {
  return getDb().delete(aiSuggestions).run().changes;
}

/** Failed rows only, so those merchants are asked again (a new address or model). */
export function clearFailedAiSuggestions(): number {
  return getDb().delete(aiSuggestions).where(eq(aiSuggestions.status, 'failed')).run().changes;
}

const READ_CHUNK = 500;

/**
 * Review's suggestions for the merchants on the page: `suggested` rows only, an archived (or gone)
 * category read as no category, and a row with neither part left out. A self-scoped viewer gets
 * none: Review is household-only, and a suggestion names a household merchant.
 */
export function aiSuggestionsForMerchants(merchants: readonly string[], viewer: Viewer): Record<string, AiSuggestionView> {
  if (isSelfScoped(viewer)) return {};
  const wanted = [...new Set(merchants.filter((merchant) => typeof merchant === 'string' && merchant.length > 0))];
  if (wanted.length === 0) return {};
  const all = listCategories({ includeArchived: true });
  const live = new Set(all.filter((category) => !category.isArchived).map((category) => category.id));
  const entries: [string, AiSuggestionView][] = [];
  for (let i = 0; i < wanted.length; i += READ_CHUNK) {
    const rows = getDb()
      .select({ merchant: aiSuggestions.normalizedMerchant, categoryId: aiSuggestions.categoryId, cleanName: aiSuggestions.cleanName })
      .from(aiSuggestions)
      .where(and(eq(aiSuggestions.status, 'suggested'), inArray(aiSuggestions.normalizedMerchant, wanted.slice(i, i + READ_CHUNK))))
      .all();
    for (const row of rows) {
      const categoryId = row.categoryId !== null && live.has(row.categoryId) ? row.categoryId : null;
      if (categoryId === null && row.cleanName === null) continue;
      entries.push([row.merchant, { categoryId, categoryLabel: categoryId === null ? null : categoryLabel(categoryId, all), cleanName: row.cleanName }]);
    }
  }
  // fromEntries defines own properties, so a merchant spelled like a prototype key stays a key.
  return Object.fromEntries(entries);
}

export interface AiSuggestionRecord {
  merchant: string;
  status: 'suggested' | 'failed' | 'ignored';
  categoryId: number | null;
  cleanName: string | null;
  model: string;
}

/** The merchant's row, whatever its status, for the accept action to check. */
export function aiSuggestionFor(merchant: string): AiSuggestionRecord | null {
  const row = getDb()
    .select({
      merchant: aiSuggestions.normalizedMerchant,
      status: aiSuggestions.status,
      categoryId: aiSuggestions.categoryId,
      cleanName: aiSuggestions.cleanName,
      model: aiSuggestions.model,
    })
    .from(aiSuggestions)
    .where(eq(aiSuggestions.normalizedMerchant, merchant))
    .get();
  return row ?? null;
}

/** Settings' counts: rows by status, and how many merchants are still to ask. */
export function aiSuggestionCounts(): AiSuggestionCounts {
  const rows = getDb()
    .select({ status: aiSuggestions.status, n: sql<number>`count(*)` })
    .from(aiSuggestions)
    .groupBy(aiSuggestions.status)
    .all();
  const count = (status: string) => rows.find((row) => row.status === status)?.n ?? 0;
  return { suggested: count('suggested'), ignored: count('ignored'), failed: count('failed'), toAsk: allTargets().length };
}
