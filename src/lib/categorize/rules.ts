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
  /** v1.21.0 (item 11). NULL = enabled (every row ever, until someone flips it). See the
   *  docblock on schema.ts's merchantRules.disabledAt for the full reasoning. */
  disabledAt: string | null;
}

export function listRules(kind?: RuleKind): MerchantRuleRecord[] {
  const query = getDb().select().from(merchantRules);
  const rows = kind ? query.where(eq(merchantRules.ruleKind, kind)).all() : query.all();
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * Exact wins; otherwise the longest contains pattern wins; ties break on lowest id.
 *
 * v1.21.0 (item 11): a disabled rule (disabledAt !== null) is skipped outright, before its
 * matchType is even looked at. This is the ONE place every caller's match ultimately funnels
 * through -- buildContext()/listRules() deliberately still return disabled rows (the settings
 * page needs to list and re-enable them), so the filter has to live here rather than at every
 * call site, or a caller that forgets to pre-filter would let a disabled rule match anyway.
 */
export function matchRule(
  normalizedMerchant: string,
  kind: RuleKind,
  rules: MerchantRuleRecord[],
): MerchantRuleRecord | null {
  let bestContains: MerchantRuleRecord | null = null;
  for (const rule of rules) {
    if (rule.ruleKind !== kind) continue;
    if (rule.disabledAt !== null) continue;
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

/**
 * Who owns the exact rule on (pattern, kind), or null if there is none.
 *
 * v1.13.1 (item BJ, ruling P13). upsertRuleFromCorrection has asked this question inline since
 * v1.13.0 (:96-107) for the rule it WRITES; setTransferFlag now needs the same answer about the
 * rule it DELETES, and two copies of a leftJoin whose fallback string has to match is exactly
 * how the two answers drift apart. Same query, same 'Another member' fallback, one definition.
 */
export function exactRuleOwner(
  pattern: string,
  kind: RuleKind,
): { createdBy: number | null; ownerName: string } | null {
  const row = getDb()
    .select({ createdBy: merchantRules.createdBy, ownerName: users.name })
    .from(merchantRules)
    .leftJoin(users, eq(users.id, merchantRules.createdBy))
    .where(
      and(
        eq(merchantRules.pattern, pattern),
        eq(merchantRules.matchType, 'exact'),
        eq(merchantRules.ruleKind, kind),
      ),
    )
    .get();
  return row === undefined ? null : { createdBy: row.createdBy, ownerName: row.ownerName ?? 'Another member' };
}

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
  // v1.21.0 (item 9): normalized_merchant is always uppercase (normalizeMerchant() calls
  // .toUpperCase()) and matchRule compares patterns with no case folding on either side -- a
  // pattern saved as `walmart` was therefore accepted, listed, and dead forever, with no error.
  // This is the ONE place every write path funnels through (the admin form, upsertRenameRule,
  // confirmCategory, setTransferFlag, applyCategoryToMatching, pack import), so uppercasing here
  // once makes every one of them correct rather than needing the same fix repeated at each call
  // site. drizzle/0016_rule_hygiene.sql is the one-time catch-up for rows already in the table.
  const pattern = input.pattern.trim().toUpperCase();

  const existing = db
    .select({ id: merchantRules.id, createdBy: merchantRules.createdBy, ownerName: users.name })
    .from(merchantRules)
    .leftJoin(users, eq(users.id, merchantRules.createdBy))
    .where(
      and(
        eq(merchantRules.pattern, pattern),
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
      pattern,
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
        eq(merchantRules.pattern, pattern),
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

/**
 * v1.21.0 (item 11). The raw column flip -- "disable, not delete", a switch that can always be
 * flipped back, unlike deleteRule. This is the ONLY writer of disabled_at. It deliberately does
 * NOT touch anything else: a rename rule's rows are cleared/restored by
 * src/lib/categorize/engine.ts's setRuleDisabled, which calls this and then re-runs
 * applyRenameRules -- kept as two functions in two files because this one has no business
 * knowing about transactions at all, the same separation rules.ts already keeps from engine.ts
 * everywhere else in this module.
 */
export function setRuleDisabledFlag(id: number, disabled: boolean, at: Date = new Date()): void {
  getDb()
    .update(merchantRules)
    .set({ disabledAt: disabled ? nowIso(at) : null })
    .where(eq(merchantRules.id, id))
    .run();
}

export interface RedundantRule {
  ruleId: number;
  /** The contains rule that already produces this rule's exact same outcome. */
  coveredByRuleId: number;
}

/**
 * v1.21.0 (item 10): "once `contains WALMART` exists, every exact `WALMART <store> <city>` rule
 * under it is dead weight still evaluated on every match". matchRule already gives an exact rule
 * priority over any contains rule (see its own docblock), so an exact rule flagged here changes
 * NOTHING if deleted -- the covering contains rule already resolves every transaction that exact
 * rule ever did, to the identical outcome. "Identical outcome" is kind-specific: the same
 * categoryId for a category rule, the same renameTo for a rename rule; transfer and not_transfer
 * carry no further outcome to disagree on, so kind alone (and the substring relationship) is
 * enough for those two.
 *
 * Deliberately pure (no DB access): the merchant-rules page calls this once per render over the
 * rules it already has, the same way it already computes impact counts, rather than this
 * function re-fetching its own copy of the list.
 */
export function findRedundantExactRules(rules: MerchantRuleRecord[]): RedundantRule[] {
  const out: RedundantRule[] = [];
  for (const exact of rules) {
    if (exact.matchType !== 'exact' || exact.disabledAt !== null) continue;
    let best: MerchantRuleRecord | null = null;
    for (const contains of rules) {
      if (contains.matchType !== 'contains' || contains.ruleKind !== exact.ruleKind) continue;
      if (contains.disabledAt !== null || contains.pattern.length === 0) continue;
      if (!exact.pattern.includes(contains.pattern)) continue;
      const sameOutcome =
        exact.ruleKind === 'category'
          ? contains.categoryId === exact.categoryId
          : exact.ruleKind === 'rename'
            ? contains.renameTo === exact.renameTo
            : true; // transfer / not_transfer: kind is the whole outcome
      if (!sameOutcome) continue;
      if (best === null || contains.pattern.length > best.pattern.length) best = contains;
    }
    if (best !== null) out.push({ ruleId: exact.id, coveredByRuleId: best.id });
  }
  return out;
}
