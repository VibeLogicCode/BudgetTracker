import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { merchantRules, users } from '@/db/schema';
import { wordBoundaryTokens } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

/**
 * 'word' is v1.25.0 (backlog item 16). 'contains' is a plain String.includes with no boundary of
 * any kind, which is how the v1.22.0 Canadian pack build shipped two real false positives:
 * `contains LOWE` matched FLOWERS, and `contains IGA` matched MICHIGAN. That build worked around
 * them by demoting every short acronym to 'exact' -- safe, and honouring "prefer a MISS over a
 * FALSE POSITIVE", but only by giving up: an exact IGA rule sees IGA and nothing else, so
 * IGA #123 and IGA MARCHE (which is what a statement line actually says) both go uncategorized.
 *
 * 'word' matches on whole-token boundaries instead, so IGA matches IGA MARCHE and never MICHIGAN.
 * That fixes the trap BY DESIGN rather than by remembering to be careful, which is the only kind
 * of fix that survives the next pack, whatever size it grows to (v1.25.0 took it from 190 rules
 * to 297 in one pass, and the cross-collision guard in tests/ops/canadian-merchants-pack.test.ts
 * caught a colliding entry in that very batch). See wordBoundaryTokens (normalize.ts) for what
 * counts as a boundary and why, and matchRule below for how the three types rank against
 * each other.
 *
 * NO MIGRATION widens anything for this: drizzle/0000_init.sql declares match_type as a bare
 * `text NOT NULL` with no CHECK constraint, so this union is a TypeScript-level enum only.
 * (merchant_rule_merges.dropped_match_type DOES carry a real CHECK -- see the note on that table
 * in src/db/schema.ts for why widening it would be wrong rather than merely unnecessary.)
 */
export type MatchType = 'exact' | 'contains' | 'word';
/**
 * 'not_transfer' is an exact-match-only override: it teaches the engine that a
 * pattern which CARD_PAYMENT_PATTERNS would otherwise auto-flag is NOT actually
 * a transfer for this merchant, without disabling the pattern list for anyone
 * else (see detectTransfer in engine.ts).
 */
export type RuleKind = 'category' | 'transfer' | 'rename' | 'not_transfer';

/**
 * v1.25.0 (item 16). The ONLY two kinds a 'word' rule may carry, and this is a deliberate
 * restriction rather than an unfinished one.
 *
 * transfer and not_transfer are exact-match-only kinds, and four separate places in
 * src/lib/categorize/engine.ts do not merely DOCUMENT that -- they depend on it to attribute rows
 * to a rule without simulating anything, by asking SQL for
 * `normalized_merchant = rule.pattern`:
 *
 *   - eligibleForRuleReapply  (which rows "Apply now" is allowed to touch)
 *   - ruleImpactCounts        (the "Affects" column)
 *   - ruleImpactIds           (the ids behind that number, which the confirm dialog states)
 *   - ruleClearIds            (the rows a CLEAR actually writes to)
 *
 * A `word` transfer rule would silently invalidate all four at once: the rule would fire on
 * IGA MARCHE while every one of those queries still only ever finds rows whose merchant text is
 * exactly IGA. The failure mode is not a wrong count on a screen -- it is a "Clear this rule"
 * button that reports success and leaves flagged rows behind, and an "Apply now" whose preview
 * disagrees with what it does. Fixing them properly means giving transfer attribution the same
 * full categorizeTransaction simulation the category kind already needs, in four functions whose
 * docblocks all argue at length for the shortcut.
 *
 * Weighed against that: nobody wants a `word` transfer rule. A transfer rule is learned from one
 * specific e-transfer/payment description (setTransferFlag hard-codes matchType: 'exact' and says
 * why: "a contains rule learned from an e-transfer description would over-match every unrelated
 * e-transfer"), and a not_transfer rule is a targeted veto of ONE pattern the card-payment list
 * would otherwise catch. Broadening either by token is the opposite of what both are for. The
 * feature this item asked for -- a short merchant acronym that stays broad without colliding --
 * is entirely a category-and-rename need, which is also exactly what packs/canadian-merchants.json
 * carries.
 *
 * Enforced at the write choke point (upsertRuleFromCorrection throws) and again at the read choke
 * point (matchRule skips), so a row that reaches the table by some route neither of those covers
 * -- a hand-edited database, a backup restored from a build that allowed it -- still cannot fire.
 */
export const WORD_MATCH_KINDS: readonly RuleKind[] = ['category', 'rename'];

export function matchTypeAllowedForKind(matchType: MatchType, ruleKind: RuleKind): boolean {
  return matchType !== 'word' || WORD_MATCH_KINDS.includes(ruleKind);
}

/** One wording, one place (MUST-19.11) -- the form and the pack importer both say exactly this. */
export const WORD_MATCH_KIND_ERROR =
  'Whole word applies to category and rename rules only. A transfer or not-a-transfer rule matches one exact merchant text on purpose.';

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
  /**
   * Installable preset packs (backlog item 17). All three null for a rule a person wrote --
   * see the docblock on upsertRuleFromCorrection's `pack` parameter for how that stays true even
   * across an edit of a previously-stamped row.
   */
  packSource: string | null;
  /** The pack's own content version, distinct from the rules-pack file format version -- see
   *  drizzle/0017_pack_provenance.sql's header. Null exactly when packSource is. */
  packVersion: number | null;
  installedAt: string | null;
}

/** What a pack write stamps on the row it writes -- see upsertRuleFromCorrection's `pack` param. */
export interface PackProvenance {
  source: string;
  version: number;
  installedAt: string;
}

export function listRules(kind?: RuleKind): MerchantRuleRecord[] {
  const query = getDb().select().from(merchantRules);
  const rows = kind ? query.where(eq(merchantRules.ruleKind, kind)).all() : query.all();
  return rows.sort((a, b) => a.id - b.id);
}

/**
 * v1.25.0 (item 16). Does ONE pattern, under ONE match type, match this merchant text? Pure, no
 * DB, no rule row -- exported so the ops guard over the shipped pack
 * (tests/ops/canadian-merchants-pack.test.ts) can assert "this rule does not fire on that
 * statement line" against the REAL matcher instead of its own second copy of these three rules.
 * A guard that reimplements the thing it guards passes happily while the two drift apart, which
 * is precisely how the LOWE/IGA collisions survived every structural check that file already had.
 *
 * No case folding on either side, deliberately: normalized_merchant is always uppercase
 * (normalizeMerchant calls .toUpperCase()) and every pattern is uppercased once at the write
 * choke point (upsertRuleFromCorrection, v1.21.0 item 9). Folding here would paper over the
 * lowercase-pattern defect that fix exists to make impossible.
 *
 * THE PATTERN IS NEVER COMPILED INTO A REGEXP. It is free text a person types into a form, so
 * interpolating it into a RegExp would be both an injection surface and a source of silent
 * surprises -- a '.', '+' or '(' in a merchant name would quietly stop meaning itself, and an
 * unbalanced bracket would throw from inside the categorization loop. Both sides are tokenized
 * and the tokens are compared, so a pattern full of metacharacters is just an ordinary (and
 * ordinarily useless) pattern.
 */
export function patternMatches(pattern: string, matchType: MatchType, normalizedMerchant: string): boolean {
  if (matchType === 'exact') return pattern === normalizedMerchant;
  if (pattern.length === 0) return false;
  if (matchType === 'contains') return normalizedMerchant.includes(pattern);
  return hasTokenRun(wordBoundaryTokens(normalizedMerchant), wordBoundaryTokens(pattern));
}

/**
 * A multi-word pattern (REAL CANADIAN) matches only as a CONSECUTIVE RUN of tokens, never as
 * tokens scattered anywhere in the string: REAL CANADIAN SUPERSTORE matches, "CANADIAN TIRE REAL
 * ESTATE" does not. A pattern that tokenizes to nothing at all (a pattern of pure punctuation,
 * '.*' being the one somebody will eventually try) matches NOTHING rather than everything -- the
 * empty run is trivially present at every position, so this guard is load-bearing, not defensive.
 */
function hasTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let all = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Most specific first, for the ONE tie-break below. exact (the whole text, nothing else) > word
 * (a run of whole tokens) > contains (any substring, boundaries be damned).
 */
const MATCH_TYPE_SPECIFICITY: Record<MatchType, number> = { exact: 3, word: 2, contains: 1 };

/**
 * The LONGEST matching pattern wins. Ties on length break on match type -- exact > word >
 * contains -- and then on lowest id.
 *
 * v1.25.0 (item 16) rewrote this from "exact wins outright; otherwise the longest contains
 * pattern wins" into one ranked walk, which is a REFACTOR AND NOT A BEHAVIOUR CHANGE for the two
 * pre-existing types, for a reason worth writing down: a contains or word pattern can only match
 * a merchant text it is contained in, so its length is always <= that text's length, while an
 * exact pattern that matches IS that text. An exact rule can therefore only ever TIE on length,
 * never lose -- and the tie-break hands it the win. "Exact always beats contains" is a consequence
 * of the ordering below, not a special case above it.
 *
 * WHY LONGEST-PATTERN-WINS STAYS PRIMARY, ahead of match type: pattern length is a proxy for how
 * much a person committed to, and that judgement outranks the mechanism they picked to express it.
 * A household that wrote `contains REAL CANADIAN SUPERSTORE` said something specific about one
 * store; a `word IGA` rule is a short generic claim about a chain. Ranking by type first would let
 * the generic one win on a merchant text both match, which is the opposite of what either author
 * meant. Type only decides between two patterns of the SAME length -- i.e. two rules staking an
 * equally specific claim -- and there the narrower mechanism should win, because it is the one
 * that will fire on fewer other things.
 *
 * v1.21.0 (item 11): a disabled rule (disabledAt !== null) is skipped outright, before its
 * matchType is even looked at. This is the ONE place every caller's match ultimately funnels
 * through -- buildContext()/listRules() deliberately still return disabled rows (the settings
 * page needs to list and re-enable them), so the filter has to live here rather than at every
 * call site, or a caller that forgets to pre-filter would let a disabled rule match anyway. The
 * same argument is why the WORD_MATCH_KINDS check below lives here too: a 'word' row carrying a
 * transfer/not_transfer kind can never fire, whatever route put it in the table.
 *
 * COST, since it changed and somebody will eventually profile this: patternMatches re-tokenizes
 * the merchant text once per WORD rule (not once per rule -- exact and contains never tokenize
 * anything), so the shipped Canadian pack's twelve word rules cost twelve regex splits of a short
 * string per call. That was measured against the alternative -- hoisting the merchant's tokens out
 * of the loop -- and rejected: it would mean patternMatches could no longer be a pure
 * (pattern, matchType, text) function, and its purity is what lets the pack's ops guard assert
 * collisions against the REAL matcher instead of a copy. Hoist it if a profile ever says so; the
 * two callers that walk every transaction (ruleImpactCounts, ruleImpactIds) already cache their
 * verdict per DISTINCT merchant, which is the larger win and is already taken.
 */
export function matchRule(
  normalizedMerchant: string,
  kind: RuleKind,
  rules: MerchantRuleRecord[],
): MerchantRuleRecord | null {
  let best: MerchantRuleRecord | null = null;
  for (const rule of rules) {
    if (rule.ruleKind !== kind) continue;
    if (rule.disabledAt !== null) continue;
    if (!matchTypeAllowedForKind(rule.matchType, rule.ruleKind)) continue;
    if (!patternMatches(rule.pattern, rule.matchType, normalizedMerchant)) continue;
    if (best === null || outranks(rule, best)) best = rule;
  }
  return best;
}

function outranks(candidate: MerchantRuleRecord, incumbent: MerchantRuleRecord): boolean {
  if (candidate.pattern.length !== incumbent.pattern.length) {
    return candidate.pattern.length > incumbent.pattern.length;
  }
  const candidateRank = MATCH_TYPE_SPECIFICITY[candidate.matchType];
  const incumbentRank = MATCH_TYPE_SPECIFICITY[incumbent.matchType];
  if (candidateRank !== incumbentRank) return candidateRank > incumbentRank;
  return candidate.id < incumbent.id;
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
  /**
   * Installable preset packs (backlog item 17). Omitted (or explicitly null) by every one of
   * this function's pre-existing callers -- the admin form (saveRuleAction), confirmCategory,
   * setTransferFlag and applyCategoryToMatching -- which is what keeps pack_source/pack_version/
   * installed_at null for a rule a person wrote, exactly as required.
   *
   * The subtle part: this is written into BOTH the insert `values` (trivial -- a brand-new row
   * has no prior stamp to preserve) AND the `onConflictDoUpdate` `set` object below (load-bearing
   * -- an UPDATE through this function otherwise leaves whatever was already in those three
   * columns untouched). That second half is deliberate, not an oversight: it is what makes
   * editing a previously pack-installed rule THROUGH THE FORM clear its stamp and turn it into a
   * rule "a person wrote" from that edit onward, which is exactly the signal
   * src/lib/canadian-pack.ts's update-apply flow needs to tell "this preset rule was left alone
   * because the household edited it" apart from "this preset rule was never touched" -- there is
   * no separate audit column for that; a null stamp on a row the pack's own rule list still
   * names IS the "edited" fact. Only the pack-install/update path (src/lib/canadian-pack.ts, via
   * importRulesPack's `stamp` option) ever passes a non-null `pack` here.
   */
  pack?: PackProvenance | null;
  at?: Date;
}): RuleUpsertResult {
  // v1.25.0 (item 16). THROWS rather than returning a refusal, and that is a deliberate choice
  // about who this message is for. Both boundaries where a human or a file gets to pick a match
  // type already reject the combination in words a person can act on -- saveRuleAction returns
  // WORD_MATCH_KIND_ERROR, and the pack importer skips the entry and counts it, the same
  // gracefully-skipped treatment an unrecognised rule_kind already gets (src/lib/packs.ts,
  // controller ruling (a)). Every OTHER caller of this function hard-codes matchType: 'exact'
  // (confirmCategory, setTransferFlag's two writes, applyCategoryToMatching) or a kind that is
  // allowed (upsertRenameRule), so reaching this line means a NEW caller was written that forgot
  // the restriction -- a programmer error, not a household-facing condition.
  //
  // The alternative -- a third `{ ok: false, reason }` variant -- was rejected on measurement:
  // the refusal shape is re-exported through confirmCategory, setTransferFlag,
  // applyCategoryToMatching, upsertRenameRule and two bulk paths in src/lib/transactions.ts,
  // every one of which reads `result.ownerName` off it. Widening the union to carry a reason with
  // no ownerName means editing all of them plus the transaction actions that translate them, to
  // handle a case none of those call sites can actually produce. Writing the row anyway was never
  // an option: a rule matchRule will never honour is a rule that is dead on arrival, which is
  // exactly the v1.21.0 item 9 lowercase-pattern defect wearing a different hat.
  if (!matchTypeAllowedForKind(input.matchType, input.ruleKind)) {
    throw new Error(`${WORD_MATCH_KIND_ERROR} (rule_kind "${input.ruleKind}")`);
  }

  const db = getDb();
  const renameTo = input.ruleKind === 'rename' ? (input.renameTo ?? null) : null;
  const packSource = input.pack?.source ?? null;
  const packVersion = input.pack?.version ?? null;
  const installedAt = input.pack?.installedAt ?? null;
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
      packSource,
      packVersion,
      installedAt,
    })
    .onConflictDoUpdate({
      target: [merchantRules.pattern, merchantRules.matchType, merchantRules.ruleKind],
      // createdBy is DELIBERATELY absent from this set object -- that is the whole of ruling R4.
      // packSource/packVersion/installedAt ARE present, and that is deliberate too -- see this
      // function's `pack` parameter docblock above for why an update through this function must
      // write whatever provenance the caller passes (null for every non-pack caller), not
      // preserve whatever was there before.
      set: { categoryId: input.categoryId, renameTo, lastModifiedBy: input.createdBy, packSource, packVersion, installedAt },
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
 *
 * v1.25.0 (item 16): 'word' coverers are deliberately OUT OF SCOPE here. A `word IGA` rule does
 * cover an `exact IGA MARCHE` rule with the same outcome, so this now under-reports slightly --
 * an honest under-report (nothing correct is ever flagged as dead weight) rather than a second,
 * token-aware containment check bolted onto a function whose whole contract is "deleting this
 * changes NOTHING". Widen it when somebody actually has a shelf of word rules to tidy.
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
