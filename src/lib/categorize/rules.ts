import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { merchantRules, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';

export type MatchType = 'exact' | 'contains';
/**
 * 'not_transfer' is an exact-match-only override: it teaches the engine that a
 * pattern which CARD_PAYMENT_PATTERNS would otherwise auto-flag is NOT actually
 * a transfer for this merchant, without disabling the pattern list for anyone
 * else (see detectTransfer in engine.ts).
 */
export type RuleKind = 'category' | 'transfer' | 'rename' | 'not_transfer';

export interface MerchantRuleRecord {
  id: number;
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  /** Set only on rule_kind = 'rename'. */
  renameTo: string | null;
  createdBy: number | null;
  hitCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  /** v1.13.0 ruling R4. Who last changed the rule; NULL before v1.13.0 or if never edited since. */
  lastModifiedBy: number | null;
}

export function listRules(kind?: RuleKind): MerchantRuleRecord[] {
  const query = getDb().select().from(merchantRules);
  const rows = kind ? query.where(eq(merchantRules.ruleKind, kind)).all() : query.all();
  return rows.sort((a, b) => a.id - b.id);
}

/** Exact wins; otherwise the longest contains pattern wins; ties break on lowest id. */
export function matchRule(
  normalizedMerchant: string,
  kind: RuleKind,
  rules: MerchantRuleRecord[],
): MerchantRuleRecord | null {
  let bestContains: MerchantRuleRecord | null = null;
  for (const rule of rules) {
    if (rule.ruleKind !== kind) continue;
    if (rule.matchType === 'exact') {
      if (rule.pattern === normalizedMerchant) return rule;
      continue;
    }
    if (rule.pattern.length === 0) continue;
    if (!normalizedMerchant.includes(rule.pattern)) continue;
    if (
      bestContains === null ||
      rule.pattern.length > bestContains.pattern.length ||
      (rule.pattern.length === bestContains.pattern.length && rule.id < bestContains.id)
    ) {
      bestContains = rule;
    }
  }
  return bestContains;
}

/**
 * v1.13.0 ruling R4 (item AH / SEC-6). Until now this upsert put `createdBy` in its `set` object, so
 * a member correcting a category silently rewrote an admin's household-global rule AND the row then
 * claimed the member authored it -- a privilege asymmetry pointing the wrong way, since only an admin
 * can reach the delete control on /settings/managers.
 *
 * Now: a member-level write needs the rule to be ABSENT or to be their own. `createdBy` is never in
 * the `set` object again; `lastModifiedBy` records the change instead, so an overwrite by an admin is
 * attributable without erasing who thought of it.
 */
export type RuleUpsertResult =
  | { ok: true; ruleId: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** One wording, one place (MUST-19.11). */
export const ruleOwnedError = (ownerName: string) =>
  `${ownerName} set up this rule. Ask an admin to change it under Settings → Categories & rules.`;

export function upsertRuleFromCorrection(input: {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  /** Only meaningful for rule_kind = 'rename'; ignored (stored NULL) otherwise. */
  renameTo?: string | null;
  createdBy: number | null;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): RuleUpsertResult {
  const db = getDb();
  const renameTo = input.ruleKind === 'rename' ? (input.renameTo ?? null) : null;

  const existing = db
    .select({ id: merchantRules.id, createdBy: merchantRules.createdBy, ownerName: users.name })
    .from(merchantRules)
    .leftJoin(users, eq(users.id, merchantRules.createdBy))
    .where(
      and(
        eq(merchantRules.pattern, input.pattern),
        eq(merchantRules.matchType, input.matchType),
        eq(merchantRules.ruleKind, input.ruleKind),
      ),
    )
    .get();

  if (
    existing !== undefined &&
    input.actorRole !== 'admin' &&
    existing.createdBy !== null &&
    existing.createdBy !== input.createdBy
  ) {
    // Nothing is written. The caller turns this into a plain sentence for the person who tried.
    return { ok: false, reason: 'owned_by_another', ownerName: existing.ownerName ?? 'Another member' };
  }

  db.insert(merchantRules)
    .values({
      pattern: input.pattern,
      matchType: input.matchType,
      ruleKind: input.ruleKind,
      categoryId: input.categoryId,
      renameTo,
      createdBy: input.createdBy,
      // A brand-new rule created by an admin starts with no attribution trail at all -- exactly
      // how every pre-v1.13.0 row and every system/pack-authored rule already reads (schema
      // comment: NULL "before v1.13.0 ... or [if] never edited since"). A MEMBER's first write
      // records itself immediately, because ownership is exactly what this member might need
      // proof of the next time someone else's edit reaches this same row.
      lastModifiedBy: input.actorRole === 'admin' ? null : input.createdBy,
      hitCount: 0,
      lastUsedAt: null,
      createdAt: nowIso(input.at ?? new Date()),
    })
    .onConflictDoUpdate({
      target: [merchantRules.pattern, merchantRules.matchType, merchantRules.ruleKind],
      // createdBy is DELIBERATELY absent from this set object -- that is the whole of ruling R4.
      set: { categoryId: input.categoryId, renameTo, lastModifiedBy: input.createdBy },
    })
    .run();

  const row = db
    .select({ id: merchantRules.id })
    .from(merchantRules)
    .where(
      and(
        eq(merchantRules.pattern, input.pattern),
        eq(merchantRules.matchType, input.matchType),
        eq(merchantRules.ruleKind, input.ruleKind),
      ),
    )
    .get();
  return { ok: true, ruleId: row?.id ?? 0 };
}

export function deleteRule(id: number): void {
  getDb().delete(merchantRules).where(eq(merchantRules.id, id)).run();
}

export function deleteExactRule(pattern: string, kind: RuleKind): number {
  const result = getDb()
    .delete(merchantRules)
    .where(and(eq(merchantRules.pattern, pattern), eq(merchantRules.matchType, 'exact'), eq(merchantRules.ruleKind, kind)))
    .run();
  return Number(result.changes ?? 0);
}

export function bumpRuleUsage(id: number, at: Date = new Date()): void {
  getDb()
    .update(merchantRules)
    .set({ hitCount: sql`${merchantRules.hitCount} + 1`, lastUsedAt: nowIso(at) })
    .where(eq(merchantRules.id, id))
    .run();
}
