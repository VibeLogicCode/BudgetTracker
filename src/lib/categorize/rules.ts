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
 * 'not_transfer' is an override: it teaches the engine that a pattern which
 * CARD_PAYMENT_PATTERNS would otherwise auto-flag is NOT actually a transfer for
 * this merchant, without disabling the pattern list for anyone else (see
 * detectTransfer in engine.ts).
 *
 * EXACT BY DEFAULT, NOT EXACT-ONLY, and the distinction cost a P1 (v1.31.0, R-01). setTransferFlag
 * is the only path that LEARNS one and it hard-codes matchType: 'exact'; the rules form can write
 * a 'contains' one, and matchRule honours it. A pack cannot -- IMPORTABLE_RULE_KINDS (packs.ts)
 * excludes this kind in both directions, because it describes one install's own account wiring.
 */
export type RuleKind = 'category' | 'transfer' | 'rename' | 'not_transfer';

/**
 * v1.25.0 (item 16). The ONLY two kinds a 'word' rule may carry, and this is a deliberate
 * restriction rather than an unfinished one.
 *
 * WHAT THIS DOES NOT SAY, since it said it until v1.31.0 and the claim was false the whole time:
 * transfer and not_transfer are NOT exact-match-only kinds. The check below refuses exactly one
 * thing -- 'word' -- so the rules form and the pack importer have always accepted a 'contains'
 * transfer rule, and matchRule has always fired it as a substring match. This docblock used to
 * assert the opposite and cite four functions in src/lib/categorize/engine.ts
 * (eligibleForRuleReapply, ruleImpactCounts, ruleImpactIds, ruleClearIds) as DEPENDING on it,
 * because each looked its rows up by `normalized_merchant = rule.pattern`. Nothing enforced the
 * invariant those four rested on, so a 'contains' transfer rule read as "Affects 0" and, worse,
 * "Delete rule and clear from transactions" un-flagged only the exact-text rows and stranded every
 * substring-matched one as a transfer -- outside every report and budget -- with the rule gone.
 * Review finding R-01 (P1). All four now simulate the match (attributedRuleId, engine.ts), so
 * attribution is honest for whatever match type a rule actually carries, and nothing in engine.ts
 * depends on this list any more.
 *
 * THE OTHER FIX WAS CONSIDERED AND REFUSED (controller ruling R22): narrowing this check so
 * transfer kinds accept only 'exact' would have made the old claim true. Rejected, and not
 * closely. 'contains' transfer rules are a shipped capability with existing household rows and
 * this repo's own tests behind them, so narrowing needed a hygiene migration and would break them;
 * and a docblock asserting an invariant nothing enforces is precisely the failure shape this
 * release lineage keeps paying for, so making the claim true once would have left the identical
 * trap armed for the next match type somebody adds.
 *
 * SO WHY DOES THE 'word' RESTRICTION SURVIVE? On the half of the original argument that never
 * relied on the shortcut: nobody wants a `word` transfer rule. A transfer rule is learned from one
 * specific e-transfer/payment description (setTransferFlag hard-codes matchType: 'exact' and says
 * why: "a contains rule learned from an e-transfer description would over-match every unrelated
 * e-transfer"), and a not_transfer rule is a targeted veto of ONE pattern the card-payment list
 * would otherwise catch. Broadening either by token is the opposite of what both are for. The
 * feature item 16 asked for -- a short merchant acronym that stays broad without colliding -- is
 * entirely a category-and-rename need, which is also exactly what packs/canadian-merchants.json
 * carries. That is a product argument, and it stands on its own; it is no longer load-bearing for
 * correctness anywhere.
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
  'Whole word applies to category and rename rules only. A transfer or not-a-transfer rule is about one description you have actually seen, so it takes Exact or Contains.';

/**
 * v1.31.0 review finding R-02 (P2). One wording, one place (MUST-19.11) -- saveRuleAction and the
 * pack importer's schema both say exactly this, the same discipline WORD_MATCH_KIND_ERROR above
 * already keeps for the other refusal a person can walk into on the rules form.
 *
 * The defect it closes was SILENT, which is the whole reason it needed a sentence rather than a
 * tolerated null: the form's Category select offers "(none)" for every kind (it has to -- transfer,
 * not_transfer and rename rules genuinely have no category), so picking "category" and leaving the
 * select alone saved a rule that matchRule then returned as the WINNER for its merchant while
 * having nothing to file it as. categorizeTransaction fell through to Bayes, a shorter rule that
 * WOULD have categorized the merchant never got asked, and the rule's own "Affects" column read 0
 * -- so the household saw a rule, no error, and a merchant that had quietly stopped being
 * categorised by anything.
 */
export const CATEGORY_RULE_NEEDS_CATEGORY_ERROR =
  'A category rule needs a category. Pick one, or change the kind to transfer, not-a-transfer or rename.';

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
 * callers that walk every transaction all cache their verdict per DISTINCT merchant, which is the
 * larger win and is already taken -- ruleImpactCounts and ruleImpactIds always did, and as of
 * v1.31.0 (R-01) ruleClearIds and eligibleForRuleReapply do too, through the one shared
 * ruleAttributor in engine.ts.
 */
/**
 * v1.31.0 R-02. Does this row carry the OUTCOME its kind needs in order to do anything at all?
 *
 * A category rule's outcome is a category id; a rename rule's is a non-empty target text. A row
 * missing its own outcome is dead on arrival -- and, worse than merely dead, it SHADOWS: matchRule
 * ranks by pattern length and returns one winner per (merchant, kind), so an empty
 * `exact TIM HORTONS` category rule beat `contains TIM -> Coffee` and left TIM HORTONS
 * uncategorized with nothing on screen to explain it (see CATEGORY_RULE_NEEDS_CATEGORY_ERROR).
 *
 * transfer and not_transfer are absent from this check on purpose: for those two the KIND is the
 * whole outcome, exactly as findRedundantRules' "identical outcome" test already says, so there is
 * nothing further for such a row to be missing.
 *
 * This is the read-side half of a rule refused at three points, deliberately, and the three are
 * not redundant: saveRuleAction refuses it with a sentence a person can act on, the pack schema
 * refuses the file, and matchRule (the choke point every match funnels through, the same argument
 * the disabled-row and WORD_MATCH_KINDS skips make) makes a row that reached the table by some
 * other route -- a hand-edited database, a backup from a build that allowed it -- unable to fire
 * or to shadow. Skipping is right rather than "match and fall through" because falling through is
 * precisely what hid the defect: the row won and then declined to act.
 */
export function ruleOutcomeMissing(rule: Pick<MerchantRuleRecord, 'ruleKind' | 'categoryId' | 'renameTo'>): boolean {
  if (rule.ruleKind === 'category') return rule.categoryId === null;
  if (rule.ruleKind === 'rename') return rule.renameTo === null || rule.renameTo.trim().length === 0;
  return false;
}

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
    // v1.31.0 R-02: a rule with no outcome must not WIN and then do nothing -- see
    // ruleOutcomeMissing above for the merchant that stopped being categorised because it did.
    if (ruleOutcomeMissing(rule)) continue;
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
  /** The rule that already produces this rule's exact same outcome -- exact, contains or word. */
  coveredByRuleId: number;
  /** Denormalized off the covering rule so a caller (the merchant-rules page) can name it on the
   *  redundant row without a second lookup -- see this file's `findRedundantRules` for why the
   *  household needs to see WHICH rule and HOW it matches, not just that a covering rule exists. */
  coveredByPattern: string;
  coveredByMatchType: MatchType;
}

/**
 * v1.21.0 (item 10): "once `contains WALMART` exists, every exact `WALMART <store> <city>` rule
 * under it is dead weight still evaluated on every match". matchRule already gives the LONGEST
 * matching pattern priority (see its own docblock), so a rule flagged here changes NOTHING if
 * deleted -- the covering rule already resolves every transaction the narrower rule ever did, to
 * the identical outcome. "Identical outcome" is kind-specific: the same categoryId for a category
 * rule, the same renameTo for a rename rule; transfer and not_transfer carry no further outcome
 * to disagree on, so kind alone is enough for those two.
 *
 * Deliberately pure (no DB access): the merchant-rules page calls this once per render over the
 * rules it already has, the same way it already computes impact counts, rather than this
 * function re-fetching its own copy of the list.
 *
 * v1.25.0 (item 16) shipped the 'word' match type and left it OUT OF SCOPE here on purpose --
 * "widen it when somebody actually has a shelf of word rules to tidy". 'word' is now the DEFAULT
 * for pack brand rules (297 of them), so an exact rule sitting under a word rule is the common
 * case, not an edge case, and the old exact-under-contains-only check missed every one of them.
 * This widens the check to ask the REAL matcher (patternMatches) whether one rule covers another,
 * for every pair of match types where that question has a sound, general answer -- not by
 * re-deriving a second string test the way the old `.includes()` line did, which is exactly the
 * kind of parallel implementation that drifted from matchRule once 'word' shipped.
 *
 * THE COVERAGE MATRIX, and the proof behind each cell (rows = the NARROWER rule being checked for
 * redundancy, columns = the BROADER rule that might cover it):
 *
 *              covered by exact   covered by contains   covered by word
 *   exact            --                 YES                  YES
 *   contains          NO                YES                   NO
 *   word              NO                 NO                   YES
 *
 * The check for every YES cell is the SAME formula: does `patternMatches(broad.pattern,
 * broad.matchType, narrow.pattern)` -- i.e. does the broad rule match the narrow rule's OWN
 * pattern text, treated as if it were a transaction's normalized merchant text? That formula is
 * only trustworthy when it is provably equivalent to "the broad rule matches EVERY text the
 * narrow rule could ever match", not merely this one text -- which is exactly why the NO cells
 * are refused despite nothing stopping the same formula from being *computed* there too:
 *
 *   - exact (narrow) x anything (broad): an exact rule matches exactly ONE text -- its own
 *     pattern. Checking the broad rule against that one text is therefore both NECESSARY and
 *     SUFFICIENT, whatever the broad type. Always sound.
 *
 *   - contains (narrow) x contains (broad): a contains rule matches every text that has its
 *     pattern as a raw substring, which is an unbounded family, but substring-of is transitive --
 *     if broad.pattern is a substring of narrow.pattern, and narrow.pattern is a substring of
 *     some transaction text T (that is what "narrow matches T" means), then broad.pattern is a
 *     substring of T too. Sound for ALL T, not just narrow.pattern itself.
 *
 *   - word (narrow) x word (broad): the same transitivity argument, one level up: word matching
 *     is "the pattern's tokens are a consecutive run within the text's tokens" (hasTokenRun). If
 *     broad's tokens are a consecutive run within narrow's tokens, and narrow's tokens are a
 *     consecutive run within T's tokens, then broad's tokens are a consecutive run within T's
 *     tokens too -- a run-within-a-run is still a run, at the offset the two runs compose to.
 *     Sound for ALL T.
 *
 *   - contains (narrow) x word (broad): UNSOUND, and the shipped pack proves why. `word MART`
 *     matches the pack's own pattern text `contains MART` under the naive formula (MART's tokens
 *     are trivially "a run" within MART's own tokens) -- but `contains MART` also matches
 *     "WALMART", where MART sits INSIDE a larger token with no boundary on either side, which
 *     `word MART` by design does not match (that boundary check is the entire point of 'word' --
 *     see this file's own docblock on the type). A text the narrow rule matches is not
 *     necessarily one the broad rule matches, so this cell would produce a false "redundant"
 *     claim -- exactly the failure this widening must not introduce.
 *
 *   - word (narrow) x contains (broad): also UNSOUND, for a different reason -- normalization.
 *     wordBoundaryTokens treats '-', '/', '.' and space alike as boundaries (see normalize.ts),
 *     so `word PETRO CANADA` matches both "PETRO-CANADA" and "PETRO CANADA" in the transaction
 *     text. But `contains PETRO CANADA` (the narrow pattern's own text, space-joined) is a raw
 *     substring test: it matches "PETRO CANADA" and NOT "PETRO-CANADA" (different literal
 *     characters). So a text the narrow word rule matches (the hyphenated spelling) can be one no
 *     contains rule built from the same pattern text would ever reach -- the two match types
 *     disagree about what a "boundary" even is, so pattern text alone cannot answer the question.
 *     (A single-TOKEN word pattern happens to be safe here, since its one token IS a literal
 *     substring of anything it matches -- but this function does not special-case it: adding a
 *     token-count branch just to reach a case no test in this codebase asks for is exactly the
 *     kind of unproven cleverness the brief warns against. Under-reporting that case is a correct,
 *     honest miss.)
 *
 * Every case where certainty is not provable is left unflagged, per the guiding rule: a false
 * "redundant" claim invites someone to delete a rule that was doing real work, so the conservative
 * direction is the only safe one.
 */
function coverageEligible(narrowType: MatchType, broadType: MatchType): boolean {
  if (narrowType === 'exact') return true;
  if (narrowType === 'contains') return broadType === 'contains';
  return broadType === 'word'; // narrowType === 'word'
}

export function findRedundantRules(rules: MerchantRuleRecord[]): RedundantRule[] {
  const out: RedundantRule[] = [];
  for (const narrow of rules) {
    if (narrow.disabledAt !== null) continue;
    let best: MerchantRuleRecord | null = null;
    for (const broad of rules) {
      if (broad.id === narrow.id) continue;
      if (broad.disabledAt !== null || broad.ruleKind !== narrow.ruleKind) continue;
      if (!coverageEligible(narrow.matchType, broad.matchType)) continue;
      // The real matcher, not a second hand-rolled string test -- see this function's own
      // docblock for why treating narrow.pattern as "the text" is a sound proof of full coverage
      // for exactly the cells the coverage matrix marks YES, and only those.
      if (!patternMatches(broad.pattern, broad.matchType, narrow.pattern)) continue;
      const sameOutcome =
        narrow.ruleKind === 'category'
          ? broad.categoryId === narrow.categoryId
          : narrow.ruleKind === 'rename'
            ? broad.renameTo === narrow.renameTo
            : true; // transfer / not_transfer: kind is the whole outcome
      if (!sameOutcome) continue;
      if (best === null || broad.pattern.length > best.pattern.length) best = broad;
    }
    if (best !== null) {
      out.push({ ruleId: narrow.id, coveredByRuleId: best.id, coveredByPattern: best.pattern, coveredByMatchType: best.matchType });
    }
  }
  return out;
}
