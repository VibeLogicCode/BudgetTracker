import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { loanPayments, transactions, transactionSplits } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { applyPaymentMatchers } from '@/lib/loans';
import { classify, train, untrain } from './bayes';
import { tokenize } from './normalize';
import {
  bumpRuleUsage,
  deleteExactRule,
  deleteRule,
  exactRuleOwner,
  listRules,
  matchRule,
  setRuleDisabledFlag,
  upsertRuleFromCorrection,
  type MatchType,
  type MerchantRuleRecord,
  type RuleKind,
} from './rules';

/**
 * Card-payment patterns ONLY (spec section 4).
 * E-transfers are deliberately absent: an e-transfer to your own account is
 * textually indistinguishable from rent to a landlord or a gift, and
 * auto-flagging would silently erase real spending from every report.
 */
export const CARD_PAYMENT_PATTERNS: readonly string[] = [
  'PAYMENT - THANK YOU',
  'PAYMENT THANK YOU',
  'PAIEMENT - MERCI',
  'TD VISA PAYMENT',
  'VISA PAYMENT',
  'MASTERCARD PAYMENT',
  'AMEX PAYMENT',
  'AMERICAN EXPRESS PAYMENT',
  'CREDIT CARD PAYMENT',
  'CREDIT CARD/LOC PAY',
  'TFR-TO',
  'TFR-FR',
  'TRANSFER TO C/C',
  'TRANSFER FROM C/C',
];

export interface EngineTxn {
  id: number;
  normalizedMerchant: string;
}

export interface CategorizeOutcome {
  categoryId: number | null;
  source: 'rule' | 'bayes' | 'none';
  confidence: number | null;
  isTransfer: boolean;
  matchedRuleId: number | null;
}

export interface CategorizeContext {
  rules: MerchantRuleRecord[];
}

/**
 * v1.13.0 ruling R4, fix round 1 (reviewer finding: R4 was unimplemented for three of the four
 * rule-writing entry points). Shared by confirmCategory and setTransferFlag, which each write at
 * most one transaction row and, on some paths, learn or refuse a merchant rule.
 *
 * `has_splits` is this function family's pre-R4 `false` (a split row is never touched -- see each
 * function's own docblock for why). `owned_by_another` is R4's refusal. Both leave every row and
 * every rule exactly as they were: ownership is always resolved BEFORE any row write below, never
 * after, so a refusal can never half-apply a category or a transfer flag alongside a rule nobody
 * agreed to.
 */
export type RuleGuardedWriteResult =
  | { ok: true }
  | { ok: false; reason: 'has_splits' }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** applyCategoryToMatching's own shape: success also reports how many rows it touched. */
export type CategoryMatchResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

export function buildContext(): CategorizeContext {
  return { rules: listRules() };
}

export function detectTransfer(normalizedMerchant: string, ctx: CategorizeContext): boolean {
  // An exact 'not_transfer' override wins outright and skips the pattern list
  // entirely: it exists specifically to undo a manual "not a transfer" toggle
  // on a merchant the CARD_PAYMENT_PATTERNS list would otherwise re-catch on
  // every future import/re-run.
  if (matchRule(normalizedMerchant, 'not_transfer', ctx.rules) !== null) return false;

  for (const pattern of CARD_PAYMENT_PATTERNS) {
    if (normalizedMerchant.includes(pattern)) return true;
  }
  // Whatever match type the transfer rule carries -- setTransferFlag only ever LEARNS an exact
  // one, but the rules form and a pack may both write a 'contains' transfer rule and matchRule
  // fires it as a substring match. attributedRuleId (below) is what keeps attribution honest
  // about that, rather than a docblock asking every reader to assume otherwise.
  return matchRule(normalizedMerchant, 'transfer', ctx.rules) !== null;
}

export function categorizeTransaction(txn: EngineTxn, ctx: CategorizeContext): CategorizeOutcome {
  if (detectTransfer(txn.normalizedMerchant, ctx)) {
    return { categoryId: null, source: 'none', confidence: null, isTransfer: true, matchedRuleId: null };
  }

  const rule = matchRule(txn.normalizedMerchant, 'category', ctx.rules);
  if (rule && rule.categoryId !== null) {
    return { categoryId: rule.categoryId, source: 'rule', confidence: null, isTransfer: false, matchedRuleId: rule.id };
  }

  const guess = classify(tokenize(txn.normalizedMerchant));
  if (guess) {
    return { categoryId: guess.categoryId, source: 'bayes', confidence: guess.margin, isTransfer: false, matchedRuleId: null };
  }

  return { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };
}

export interface EngineResult {
  processed: number;
  categorized: number;
  transfers: number;
  skipped: number;
  /**
   * v1.21.0 (item 11). How many of the `processed` rows actually ended up with a different
   * category_id or is_transfer than they carried going in -- distinct from `processed`, which
   * counts every row the engine LOOKED AT regardless of whether anything changed (a bayes-guessed
   * row that gets re-guessed to the identical category is processed but not changed). This is the
   * figure a re-run confirmation actually needs: "this will change N transactions", not "this will
   * look at N transactions".
   */
  changed: number;
}

/**
 * Only rows with category_id IS NULL or source = 'bayes' are ever touched -- and, per spec
 * ruling 2a (v1.7.0), never a row that has splits. A split row is categorized by its parts
 * (transaction_splits, see src/lib/splits.ts), even though setTransactionSplits deliberately
 * leaves the parent's OWN category_id untouched -- so an uncategorized-before-split row would
 * otherwise stay eligible here forever. That is not merely cosmetic: if this row's merchant
 * later matches a transfer rule, rerunEngine (below) would set is_transfer = 1 on it, and
 * every report/budget aggregate excludes transfers, so that one flag would silently erase
 * every one of its split parts everywhere. Served by transaction_splits_txn_idx (migration
 * 0009).
 */
const ELIGIBLE = and(
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
  sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
);

/** Chunked well under SQLite's bound-parameter ceiling — see the note in dedup.ts. */
const ID_CHUNK = 400;

function selectRowsByIds(ids: number[]) {
  const db = getDb();
  const rows: {
    id: number;
    normalizedMerchant: string;
    categoryId: number | null;
    source: 'rule' | 'bayes' | 'manual' | 'none';
    /** v1.21.0 (item 11). Selected alongside categoryId so runEngine/previewRerun can tell
     *  "this row changed" from "this row was merely looked at" -- see EngineResult.changed. */
    isTransfer: boolean;
    /**
     * v1.12.1 (item BC / MON-6). ELIGIBLE (above) carries the splits half of the predicate and its
     * docblock explains at length why. runEngine re-derived eligibility in JavaScript and
     * reproduced only the category half, so the guard the comment describes as living on ELIGIBLE
     * did not apply on that path at all. Selecting the flag here means ONE predicate serves both
     * paths, instead of two that agree today and drift tomorrow.
     */
    hasSplits: number;
  }[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_CHUNK);
    const chunkRows = db
      .select({
        id: transactions.id,
        normalizedMerchant: transactions.normalizedMerchant,
        categoryId: transactions.categoryId,
        source: transactions.categorizationSource,
        isTransfer: transactions.isTransfer,
      })
      .from(transactions)
      .where(inArray(transactions.id, chunk))
      .all();
    // A drizzle column reference interpolated into a raw sql fragment is not table-qualified
    // when that fragment sits in the SELECT list (only in a .where() condition -- see the
    // identical warning on transactionHasSplits, below). A correlated `hasSplits` subquery
    // written directly into this .select() would have its bare `id` resolve against
    // transaction_splits' OWN id column instead of this outer transactions row, so it would
    // come back true for every row in the chunk the moment ANY split exists anywhere in the
    // database. Querying transaction_splits' txn_id directly, scoped to this same chunk, keeps
    // the same "not exists (select 1 from transaction_splits where txn_id = transactions.id)"
    // predicate ELIGIBLE (above) uses -- just resolved as a second membership query instead of
    // an unqualified correlated one.
    const splitTxnIds = new Set(
      db
        .select({ txnId: transactionSplits.txnId })
        .from(transactionSplits)
        .where(inArray(transactionSplits.txnId, chunk))
        .all()
        .map((row) => row.txnId),
    );
    rows.push(...chunkRows.map((row) => ({ ...row, hasSplits: splitTxnIds.has(row.id) ? 1 : 0 })));
  }
  return rows;
}

export function runEngine(txnIds: number[]): EngineResult {
  if (txnIds.length === 0) return { processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 };

  const db = getDb();
  let result: EngineResult = { processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 };

  // The rename pass, the categorization pass and the rule-hit bumps must land
  // atomically as one unit of work, not three independent commits — a crash
  // between them would otherwise leave categorization and display state (or
  // rule hit counts) inconsistent. better-sqlite3 nests via SAVEPOINT when a
  // transaction is opened while one is already active (applyRenameRules opens
  // its own), so this composes safely.
  db.transaction((tx) => {
    const rows = selectRowsByIds(txnIds);
    const ctx = buildContext();

    // Display renames are a presentation pass over ALL the given rows — independent
    // of the categorization eligibility filter, because a row whose category is
    // already confirmed can still need its display name refreshed.
    applyRenameRules(txnIds, ctx);

    const eligible = rows.filter(
      (row) => (row.categoryId === null || row.source === 'bayes') && row.hasSplits === 0,
    );
    const skipped = rows.length - eligible.length;

    const at = new Date();
    let categorized = 0;
    let transfers = 0;
    let changed = 0;
    const ruleHits = new Map<number, number>();

    for (const row of eligible) {
      const outcome = categorizeTransaction({ id: row.id, normalizedMerchant: row.normalizedMerchant }, ctx);
      if (outcome.isTransfer) transfers += 1;
      if (outcome.categoryId !== null) categorized += 1;
      if (outcome.matchedRuleId !== null) {
        ruleHits.set(outcome.matchedRuleId, (ruleHits.get(outcome.matchedRuleId) ?? 0) + 1);
      }
      // v1.21.0 (item 11): EngineResult.changed. Compared against what the row ALREADY carried,
      // not against what this loop just wrote to a different row -- so a re-guess that lands on
      // the same category, or a row that was already flagged a transfer, does not inflate the count.
      if (outcome.categoryId !== row.categoryId || outcome.isTransfer !== row.isTransfer) changed += 1;
      tx.update(transactions)
        .set({
          categoryId: outcome.categoryId,
          categorizationSource: outcome.source,
          confidence: outcome.confidence,
          isTransfer: outcome.isTransfer,
          updatedAt: nowIso(at),
        })
        .where(eq(transactions.id, row.id))
        .run();
    }

    for (const [ruleId, hits] of ruleHits) {
      for (let i = 0; i < hits; i += 1) bumpRuleUsage(ruleId, at);
    }

    result = { processed: eligible.length, categorized, transfers, skipped, changed };
  });

  return result;
}

/**
 * v1.24.0 (owner ask: "can we do date range on this... date should be on re-apply logic too").
 * Inclusive ISO `YYYY-MM-DD` bounds on transactions.date; null/undefined on either side means
 * unbounded on that side, so `{}` is "all time" and stays the default everywhere.
 *
 * One shape for both directions of the same question -- what a rule is about to ADD (a scoped
 * re-apply: eligibleForRerun/rerunEngine/eligibleForRuleReapply/previewRuleReapply/applyRuleNow)
 * and what it is about to REMOVE (ruleImpactIds/ruleClearIds/clearRuleFromTransactions) -- because
 * a person setting "from / to" in one dialog and then the other must not have to learn that the
 * two ends of the range mean something different depending on which button they pressed.
 *
 * Always applied as SQL `gte`/`lte`, never as a JavaScript filter over materialized ids: the
 * bounded case exists precisely because the unbounded one is large, and narrowing after fetching
 * every id would give up the whole point (transactions_date_idx, schema.ts, serves it).
 */
export interface RuleScope {
  /** Inclusive lower bound on transactions.date, or null/undefined for "no lower bound". */
  from?: string | null;
  /** Inclusive upper bound on transactions.date, or null/undefined for "no upper bound". */
  to?: string | null;
}

/**
 * The two optional date predicates, ready to spread into an `and(...)`. drizzle's `and` drops
 * `undefined` members, so an unbounded side costs nothing and no caller needs a branch.
 * Deliberately one helper rather than the same two ternaries repeated at each of the six call
 * sites below -- the bug this shape prevents is one call site quietly using `>` where the others
 * use `>=`, which is invisible until somebody's boundary transaction goes missing.
 */
function dateBounds(scope: RuleScope) {
  return [
    scope.from ? gte(transactions.date, scope.from) : undefined,
    scope.to ? lte(transactions.date, scope.to) : undefined,
  ] as const;
}

export function eligibleForRerun(scope: RuleScope & { accountId?: number } = {}): number[] {
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        ELIGIBLE,
        scope.accountId === undefined ? undefined : eq(transactions.accountId, scope.accountId),
        ...dateBounds(scope),
      ),
    )
    .orderBy(asc(transactions.id))
    .all()
    .map((row) => row.id);
}

export function rerunEngine(scope: RuleScope & { accountId?: number } = {}): EngineResult {
  return runEngine(eligibleForRerun(scope));
}

export interface RerunPreview {
  /** Rows runEngine(txnIds) would look at (same count as the eventual EngineResult.processed). */
  eligible: number;
  /** Rows whose category_id or is_transfer would actually differ afterward. */
  wouldChange: number;
}

/**
 * v1.21.0 (item 11): "report a count before and after... that is the difference between a
 * useful button and a frightening one". A read-only dry run over exactly the rows
 * runEngine(txnIds) would touch, so a confirm step can say "this will change N transactions"
 * BEFORE anything is written.
 *
 * Deliberately duplicates runEngine's per-row simulation rather than sharing a helper with it:
 * runEngine's loop composes its write inside the very same pass as the count on purpose (one
 * transaction, one pass over `eligible` -- see its own docblock on why the rename pass, the
 * categorize pass and the rule-hit bumps all land atomically together), so splitting "compute
 * outcome" from "write outcome" there would cost that guarantee for every REAL run just so this
 * preview could reuse three lines. This function does no `db.transaction`, no `tx.update`, no
 * `bumpRuleUsage` -- nothing it does can race or invalidate the write runEngine performs moments
 * later when a person clicks through, and calling it twice in a row is exactly as safe as calling
 * it once.
 */
export function previewRerun(txnIds: number[]): RerunPreview {
  if (txnIds.length === 0) return { eligible: 0, wouldChange: 0 };
  const rows = selectRowsByIds(txnIds);
  const ctx = buildContext();
  const eligible = rows.filter((row) => (row.categoryId === null || row.source === 'bayes') && row.hasSplits === 0);
  let wouldChange = 0;
  for (const row of eligible) {
    const outcome = categorizeTransaction({ id: row.id, normalizedMerchant: row.normalizedMerchant }, ctx);
    if (outcome.categoryId !== row.categoryId || outcome.isTransfer !== row.isTransfer) wouldChange += 1;
  }
  return { eligible: eligible.length, wouldChange };
}

/**
 * WHICH RULE OF `kind` A MERCHANT TEXT CURRENTLY RESOLVES TO -- the single definition of
 * attribution, for every kind, that all four attribution surfaces below share
 * (eligibleForRuleReapply, ruleImpactCounts, ruleImpactIds, ruleClearIds).
 *
 * v1.31.0 (review finding R-01, P1). Until now this was one idea with two implementations. The
 * category branch simulated: it asked categorizeTransaction what would really happen and kept the
 * winner. The transfer and not_transfer branches took a SHORTCUT -- `normalized_merchant =
 * rule.pattern`, exact text only -- on the strength of six docblocks (this one's predecessor
 * included) asserting that "transfer and not_transfer are exact-match-only kinds". Nothing
 * enforced that. matchTypeAllowedForKind (rules.ts) refuses only 'word' on those kinds, so the
 * rules form and the pack importer have both always accepted a `contains` transfer rule, and
 * matchRule has always fired it on every merchant containing its text.
 *
 * What that cost, in the household's terms: for a `contains E-TRANSFER` rule, "Affects" read
 * near-zero, "Apply now" processed only the rows whose text was exactly `E-TRANSFER`, and -- the
 * one that loses data -- "Delete rule and clear from transactions" previewed N, un-flagged those
 * N, and left every other substring-matched row still flagged as a transfer, which means excluded
 * from every report and every budget, with the rule gone and nothing left to attribute it to.
 *
 * THE ALTERNATIVE WAS CONSIDERED AND REFUSED. Narrowing matchTypeAllowedForKind so transfer kinds
 * accept only 'exact' would have made the six claims true instead of making the code honest. It
 * was rejected on two counts. First, `contains` transfer rules are a shipped capability that this
 * repo's own tests exercise (tests/lib/categorize/rules.test.ts, tests/lib/categorize/engine.test.ts),
 * so narrowing would break existing household rows and need a hygiene migration to list them.
 * Second, and the reason it is not close: the shortcut IS the defect. An invariant asserted in six
 * places and enforced in none is this codebase's most-repeated failure shape, and "make the claim
 * true this once" leaves the identical trap armed for whatever match type somebody adds next.
 *
 * Per kind:
 *  - category: the full categorizeTransaction simulation, unchanged -- a transfer is checked
 *    FIRST, so a merchant a transfer rule also claims must never be attributed to a category rule
 *    that would in fact never fire for it.
 *  - transfer: the winning transfer rule, AND detectTransfer must actually come out true. matchRule
 *    alone is not enough: a not_transfer override vetoes the merchant outright, so a rule counted
 *    on such a row would promise a flip that can never happen. (The CARD_PAYMENT_PATTERNS list does
 *    NOT veto -- it flags the same row for its own reasons, and the rule still genuinely claims it,
 *    exactly as an exact rule on that text has always been treated.)
 *  - not_transfer / rename: the winning rule of that kind. Nothing can pre-empt either: a
 *    not_transfer match is the first thing detectTransfer honours, and a rename resolves on its own.
 *
 * Cheap by construction, and bounded the same way the category branch already bounds itself: one
 * verdict per DISTINCT merchant (ruleAttributor, below), and matchRule's per-rule work for a
 * non-matching kind is a single `ruleKind !==` comparison.
 */
function attributedRuleId(normalizedMerchant: string, kind: RuleKind, ctx: CategorizeContext): number | null {
  if (kind === 'category') {
    const outcome = categorizeTransaction({ id: 0, normalizedMerchant }, ctx);
    return outcome.isTransfer ? null : outcome.matchedRuleId;
  }
  const rule = matchRule(normalizedMerchant, kind, ctx.rules);
  if (rule === null) return null;
  if (kind === 'transfer' && !detectTransfer(normalizedMerchant, ctx)) return null;
  return rule.id;
}

/**
 * attributedRuleId memoized per distinct merchant text, which is the bound every caller here needs:
 * all four walk a whole table, and a household's transactions collapse to far fewer distinct
 * merchants than rows. Safe to cache because attribution reads NOTHING but the merchant text and
 * the rule list `ctx` was built from -- the same assumption ruleImpactCounts' `group by
 * normalized_merchant` has always rested on.
 */
function ruleAttributor(kind: RuleKind, ctx: CategorizeContext): (normalizedMerchant: string) => number | null {
  const cache = new Map<string, number | null>();
  return (normalizedMerchant) => {
    if (!cache.has(normalizedMerchant)) cache.set(normalizedMerchant, attributedRuleId(normalizedMerchant, kind, ctx));
    return cache.get(normalizedMerchant) ?? null;
  };
}

/**
 * v1.21.0 (item 11): the rows eligibleForRerun() would already touch (so a human decision --
 * categorization_source = 'manual' -- is never in scope; see ELIGIBLE's own docblock), narrowed
 * to the ones that CURRENTLY resolve to this one specific rule, so "Apply now" on one row can
 * never reach past that rule's own pattern into what a different rule already reconciled.
 *
 * Rename rules return an empty scope: they are already retroactive on every save/disable/delete
 * (upsertRenameRule / setRuleDisabled / deleteRenameRule all call applyRenameRules), so there is
 * nothing left for "Apply now" to do that saving the rule did not already do the moment it was
 * saved.
 *
 * v1.31.0 (R-01): every remaining kind resolves through attributedRuleId, so a `contains` transfer
 * rule scopes "Apply now" to the rows it will really flag rather than to the one row whose text
 * happens to equal its pattern. See attributedRuleId's docblock for what the shortcut cost.
 *
 * v1.24.0: takes a RuleScope. A BOUNDED re-apply is safe for every kind because re-applying only
 * ever ADDS -- a row outside the range is simply not looked at, and nothing about it is left
 * inconsistent by having been skipped. (That is exactly the asymmetry that makes a bounded CLEAR
 * unsafe for renames; see clearRuleFromTransactions' own docblock.) The bound is handed to
 * eligibleForRerun, so it is applied in SQL before any id is materialized.
 */
function eligibleForRuleReapply(rule: MerchantRuleRecord, scope: RuleScope = {}): number[] {
  if (rule.ruleKind === 'rename') return [];
  const ids = eligibleForRerun(scope);
  if (ids.length === 0) return [];
  const rows = selectRowsByIds(ids);
  const eligible = rows.filter((row) => (row.categoryId === null || row.source === 'bayes') && row.hasSplits === 0);
  const attributedTo = ruleAttributor(rule.ruleKind, buildContext());
  return eligible.filter((row) => attributedTo(row.normalizedMerchant) === rule.id).map((row) => row.id);
}

/** Per-rule "Apply now" preview: the confirm text before the click. */
export function previewRuleReapply(ruleId: number, scope: RuleScope = {}): RerunPreview {
  const rule = listRules().find((r) => r.id === ruleId);
  if (!rule) return { eligible: 0, wouldChange: 0 };
  return previewRerun(eligibleForRuleReapply(rule, scope));
}

/**
 * Per-rule "Apply now" (item 11): re-runs the engine scoped to exactly the rows
 * eligibleForRuleReapply resolved for this one rule. Reuses runEngine wholesale rather than
 * writing a second categorization loop -- the "never overwrite a human decision" invariant lives
 * in ELIGIBLE/eligibleForRerun once, and every caller of runEngine inherits it for free.
 */
export function applyRuleNow(ruleId: number, scope: RuleScope = {}): EngineResult {
  const rule = listRules().find((r) => r.id === ruleId);
  if (!rule) return { processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 };
  return runEngine(eligibleForRuleReapply(rule, scope));
}

/**
 * v1.21.0 (item 11): "disable, not delete". The composed, retroactive-aware version of
 * setRuleDisabledFlag (src/lib/categorize/rules.ts), which is the raw column write and nothing
 * else. This is the version every caller (the merchant-rules page's action) should use.
 *
 * Disabling a RENAME rule must revert its rows exactly as deleteRenameRule does, or a display
 * name is left behind with no rule to explain it -- so this reapplies the rename pass immediately
 * afterward, which naturally clears every row the now-invisible rule used to set (matchRule skips
 * a disabled row, so resolveRename returns null for it, and applyRenameRules already clears
 * anything a rule no longer resolves). Re-enabling is the same call in reverse and just as
 * symmetric: the rule becomes visible to matchRule again and the very same reapply pass restores
 * whatever it used to set.
 *
 * Every other rule kind (category, transfer, not_transfer) reports rowsChanged: 0 here on
 * purpose. Disabling one of those changes nothing retroactively by itself -- matchRule simply
 * stops offering it to the NEXT match, whether that is the next import or an explicit "Apply
 * now"/"Re-run rules" click. Making a category disable ALSO silently revert already-categorized
 * rows would be the opposite of item 11's own invariant: a person's confirmed category is a human
 * decision, and disabling the rule that originally suggested it is not un-deciding anything.
 */
export function setRuleDisabled(input: { ruleId: number; disabled: boolean; at?: Date }): { rowsChanged: number } {
  const rule = listRules().find((r) => r.id === input.ruleId);
  if (!rule) return { rowsChanged: 0 };
  setRuleDisabledFlag(input.ruleId, input.disabled, input.at);
  if (rule.ruleKind !== 'rename') return { rowsChanged: 0 };
  return { rowsChanged: applyRenameRules(undefined, buildContext()) };
}

/**
 * "Currently affects N transactions" (item 12), computed on demand rather than stored.
 * `hit_count` is import-time history -- bumpRuleUsage's only caller is runEngine's tail
 * (fired during import-time categorization), and the retroactive rename-reapply pass
 * (applyRenameRules) sits outside that loop entirely and never touches it. So a rename rule
 * reads hit_count = 0 forever, however well it is matching, and the household cannot tell
 * "this rule matches nothing" (item 9's lowercase trap) from "this rule works but never bumped a
 * counter". Rather than bumping usage from a second call site (which would still only describe
 * PAST import events), this answers the question a person actually has: what is this rule doing
 * to my data RIGHT NOW. The honest definition of "affects" differs by kind:
 *
 *  - category: every non-manual, non-split transaction, re-simulated fresh through
 *    categorizeTransaction (the same function runEngine itself calls -- so this can never
 *    silently disagree with what a real run would do) and attributed to whichever rule wins.
 *    Deliberately WIDER than ELIGIBLE/eligibleForRerun (which excludes an already-'rule'-sourced
 *    row as "already settled", so an import does not reprocess it): a rule that already set 200
 *    rows is still affecting all 200 of them right now, and telling "matches nothing" from
 *    "works" needs exactly that number, not the (always smaller, often zero) count of rows still
 *    waiting for a re-run.
 *  - transfer / not_transfer: the same simulation, through attributedRuleId, counted against the
 *    transaction's CURRENT stored is_transfer flag: 'transfer' counts currently-NOT-flagged rows
 *    this rule would flag (what applying it would change), 'not_transfer' counts currently-flagged
 *    rows it releases (what clearing the override would change back). v1.31.0 (R-01): this used to
 *    look rows up by exact merchant text, which read near-zero for the `contains` transfer rules
 *    the form and the pack importer have always been able to write.
 *  - rename: transactions currently carrying display_source = 'rename' whose normalized merchant
 *    this rule resolves -- always in sync already (every rename save/disable/delete reapplies),
 *    so this is the one kind that needs no re-run to become accurate; it just reads what already
 *    happened.
 *
 * Read-only; never called from a path that writes.
 */
export function ruleImpactCounts(ctx: CategorizeContext = buildContext()): Map<number, number> {
  const db = getDb();
  const counts = new Map<number, number>();
  const bump = (ruleId: number | null, n: number) => {
    if (ruleId === null || n === 0) return;
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + n);
  };

  // category: every row a human has not decided, re-simulated fresh (see docblock above for why
  // this is wider than ELIGIBLE).
  const reachable = db
    .select({ normalizedMerchant: transactions.normalizedMerchant, c: sql<number>`count(*)` })
    .from(transactions)
    .where(
      and(
        ne(transactions.categorizationSource, 'manual'),
        sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
      ),
    )
    .groupBy(transactions.normalizedMerchant)
    .all();
  const attributedCategory = ruleAttributor('category', ctx);
  for (const row of reachable) bump(attributedCategory(row.normalizedMerchant), row.c);

  // transfer / not_transfer: the same simulation, read against the CURRENT stored flag. Grouping by
  // (merchant, is_transfer) already collapses the table to one row per distinct merchant per flag
  // value, so this is one attribution verdict per group and NOT one per rule per merchant -- the
  // rule list is walked inside matchRule, where a kind that does not match costs one comparison.
  const byMerchantAndFlag = db
    .select({ normalizedMerchant: transactions.normalizedMerchant, isTransfer: transactions.isTransfer, c: sql<number>`count(*)` })
    .from(transactions)
    .groupBy(transactions.normalizedMerchant, transactions.isTransfer)
    .all();
  const attributedTransfer = ruleAttributor('transfer', ctx);
  const attributedNotTransfer = ruleAttributor('not_transfer', ctx);
  for (const row of byMerchantAndFlag) {
    const attributed = row.isTransfer ? attributedNotTransfer : attributedTransfer;
    bump(attributed(row.normalizedMerchant), row.c);
  }

  // rename: rows already carrying display_source = 'rename', attributed to whichever rename rule
  // currently resolves for their merchant.
  const renamed = db
    .select({ normalizedMerchant: transactions.normalizedMerchant, c: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.displaySource, 'rename'))
    .groupBy(transactions.normalizedMerchant)
    .all();
  const attributedRename = ruleAttributor('rename', ctx);
  for (const row of renamed) bump(attributedRename(row.normalizedMerchant), row.c);

  return counts;
}

/**
 * v1.24.0 (owner ask: "user deletes the rule but nothing gets fixed... delete rule and remove it
 * from transactions"). The IDS behind ruleImpactCounts' figure for ONE rule, optionally bounded to
 * a date range. Not a second definition of "affects": each branch below is the same predicate
 * ruleImpactCounts' own branch for that kind uses, narrowed from `count(*)` to a list of ids and
 * from every rule to this one. That sameness is the whole point -- the dialog that says "41
 * transactions were categorized by this rule" reads its 41 from here, and the rules table's
 * "Affects" column reads its 41 from ruleImpactCounts, so a divergence between the two functions
 * would be a number on screen that the button underneath it does not honour.
 * tests/lib/categorize/engine.test.ts pins the equality directly for exactly that reason.
 *
 * v1.31.0 (R-01) collapsed what were three near-identical branches into ONE shape: a per-kind
 * candidate-row query, then attributedRuleId over its distinct merchants. The kind now decides
 * only WHICH ROWS ARE CANDIDATES; who a candidate belongs to is one definition for everybody.
 * Before, the transfer kinds skipped attribution entirely and matched exact merchant text, which
 * is the P1 this release fixes -- see attributedRuleId's docblock for what that cost.
 *
 *  - category: non-manual, non-split rows. Deliberately WIDER than ELIGIBLE (which treats an
 *    already-'rule'-sourced row as settled) -- see ruleImpactCounts' own docblock: a rule that
 *    already set 200 rows is affecting all 200 right now, and a 'rule'-sourced row is precisely
 *    what somebody clearing this rule wants cleared.
 *  - transfer: rows whose stored is_transfer is currently FALSE -- what applying the rule would
 *    change. Note this is the FORWARD-looking set, which is what "Affects" means for this kind and
 *    is NOT the set a clear writes to; ruleClearIds (below) explains that polarity flip at length.
 *  - not_transfer: rows currently flagged TRUE.
 *  - rename: rows currently carrying display_source = 'rename'.
 *
 * One attribution verdict per DISTINCT merchant (ruleAttributor), which is what keeps this cheap
 * on a whole-table scan: attribution reads nothing but the merchant text and `ctx`, exactly as
 * ruleImpactCounts' `group by normalized_merchant` already assumes.
 *
 * The splits check stays inside `.where()`, never the select list -- a drizzle column reference
 * interpolated into a raw `sql` fragment used as a SELECT-list value is not table-qualified, so
 * the correlated subquery's bare `id` would resolve against transaction_splits' OWN id column and
 * match every row the moment ANY split exists anywhere. transactionHasSplits' docblock (below)
 * carries the long version of this warning; selectRowsByIds carries the version for the same trap
 * hit from the other direction.
 *
 * Read-only; never called from a path that writes (clearRuleFromTransactions calls it BEFORE
 * opening its transaction, and passes the resulting ids in).
 */
export function ruleImpactIds(ruleId: number, scope: RuleScope = {}, ctx: CategorizeContext = buildContext()): number[] {
  const db = getDb();
  const rule = ctx.rules.find((r) => r.id === ruleId);
  if (!rule) return [];
  const bounds = dateBounds(scope);

  return db
    .select({ id: transactions.id, normalizedMerchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(candidateRowsFor(rule.ruleKind), ...bounds))
    .orderBy(asc(transactions.id))
    .all()
    .filter(attributedToRule(rule, ctx))
    .map((row) => row.id);
}

/**
 * Which rows are even CANDIDATES for a rule of this kind -- the only thing the kind decides now
 * that attribution is shared (attributedRuleId). Written as one expression per kind rather than a
 * chain of early returns so ruleImpactIds and ruleClearIds cannot drift on the candidate set the
 * way they once drifted on attribution.
 *
 * The splits check stays inside `.where()`, never a select-list field -- a drizzle column
 * reference interpolated into a raw `sql` fragment used as a SELECT-list value is not
 * table-qualified, so the correlated subquery's bare `id` would resolve against
 * transaction_splits' OWN id column and match every row the moment ANY split exists anywhere.
 * transactionHasSplits' docblock carries the long version of this warning.
 */
function candidateRowsFor(kind: RuleKind) {
  if (kind === 'transfer') return eq(transactions.isTransfer, false);
  if (kind === 'not_transfer') return eq(transactions.isTransfer, true);
  if (kind === 'rename') return eq(transactions.displaySource, 'rename');
  return and(
    ne(transactions.categorizationSource, 'manual'),
    sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
  );
}

/** attributedRuleId as a row predicate, memoized per distinct merchant across the whole scan. */
function attributedToRule(rule: MerchantRuleRecord, ctx: CategorizeContext) {
  const attributedTo = ruleAttributor(rule.ruleKind, ctx);
  return (row: { normalizedMerchant: string }) => attributedTo(row.normalizedMerchant) === rule.id;
}

/**
 * The rows a CLEAR would actually write to -- which is ruleImpactIds for a category rule and
 * deliberately NOT ruleImpactIds for a transfer rule.
 *
 * v1.24.0 finding, worth spelling out because it looks like an inconsistency and is not: "affects"
 * and "clear" point in OPPOSITE directions for the transfer kind. ruleImpactCounts defines a
 * transfer rule's impact as the currently-UNFLAGGED rows it would flag -- what applying it would
 * change -- because that column exists to answer "is this rule doing anything?" for a rule whose
 * work is still ahead of it. Un-applying it is the mirror image: the rows it already flagged, i.e.
 * the currently-FLAGGED ones. Using the "affects" set to clear would set is_transfer = false on
 * rows where it is already false and leave every genuinely flagged row alone -- a button that
 * reports success and changes nothing. So the polarity flips here, and previewRuleClearAction
 * states THIS count rather than the "Affects" column's, so the dialog's number and the write agree.
 * For every other kind the two sets coincide and this is a pass-through.
 *
 * ONLY THE POLARITY FLIPS. v1.31.0 (R-01): the transfer branch below is the same attribution
 * everything else here uses (attributedRuleId, via attributedToRule), against the flagged rows
 * instead of the unflagged ones. It used to match exact merchant text, which is what made
 * "Delete rule and clear from transactions" preview N rows, un-flag those N, and strand every
 * substring-matched row still flagged as a transfer -- out of every report and budget -- with the
 * rule deleted and nothing left to attribute it to. That was the P1.
 *
 * ONE RESIDUAL CASE, stated rather than hidden: attribution requires detectTransfer to be true, so
 * if somebody adds a not_transfer override for a merchant this rule already flagged, clearing this
 * rule no longer reaches those rows. They are not this rule's any more -- the override, not this
 * rule, now decides that merchant -- and "Re-run rules" un-flags them, because a flagged row has
 * category_id NULL and so ELIGIBLE reaches it. Deliberately NOT special-cased: a second definition
 * of attribution living in the clear path is exactly the drift this release removed.
 *
 * `rename` drops the scope on the floor (see clearRuleFromTransactions for why a bounded rename
 * revert is not a thing this codebase offers), so the preview count and the write agree there too.
 * `not_transfer` is empty because clearing it is refused outright.
 */
export function ruleClearIds(ruleId: number, scope: RuleScope = {}, ctx: CategorizeContext = buildContext()): number[] {
  const rule = ctx.rules.find((r) => r.id === ruleId);
  if (!rule) return [];
  if (rule.ruleKind === 'not_transfer') return [];
  if (rule.ruleKind === 'rename') return ruleImpactIds(ruleId, {}, ctx);
  if (rule.ruleKind === 'category') return ruleImpactIds(ruleId, scope, ctx);
  return getDb()
    .select({ id: transactions.id, normalizedMerchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(eq(transactions.isTransfer, true), ...dateBounds(scope)))
    .orderBy(asc(transactions.id))
    .all()
    .filter(attributedToRule(rule, ctx))
    .map((row) => row.id);
}

/**
 * v1.24.0, the owner's actual ask: "when we add a merchant rule and reapply, if the user messes up
 * the transactions get updated. User deletes the rule but nothing gets fixed... delete rule and
 * remove it from transactions, all or for a date range."
 *
 * THERE IS NO UNDO, and that is a fact about the schema, not a choice: nothing anywhere records a
 * transaction's category from BEFORE a rule touched it (categorization_source is only
 * 'rule' | 'bayes' | 'manual' | 'none' and no rule id is ever stored -- schema.ts's transactions
 * table), so "put it back the way it was" is not information this application has. Clearing
 * therefore means UNCATEGORIZED: category_id = NULL, source = 'none', confidence = NULL, which is
 * exactly the state REVIEW_WHERE (below) selects, so every cleared row reappears in Needs review
 * for a person to decide deliberately. The dialogs say all of this in plain words before the click
 * -- that is the only "safety" available here, and pretending otherwise would be worse.
 *
 * Nothing is re-run afterward. Asked for literally ("we can set those transactions as
 * uncategorized"), and right on its own terms: re-running the remaining rules would let a broader
 * rule immediately re-categorize the very rows just cleared, so the button would look like it had
 * done nothing at all. A person who wants the other rules applied presses Run rules, deliberately,
 * and can see what that will do first.
 *
 * By kind:
 *  - category: clears the ruleClearIds/ruleImpactIds rows. Does NOT untrain: every row in scope is
 *    non-manual by construction, and the Bayes training set is only ever fed by a MANUAL decision
 *    (confirmCategory's train() call is its only writer), so there is nothing of this rule's doing
 *    in it to remove -- untraining here would corrupt counts that some human's confirmation, not
 *    this rule, put there.
 *  - transfer: writes is_transfer = false directly, on the currently-flagged rows (ruleClearIds'
 *    polarity note). Deliberately NOT routed through setTransferFlag: that function does RULE
 *    HOUSEKEEPING as part of its job (it creates the opposite-kind 'not_transfer' override, or
 *    deletes the 'transfer' rule, per merchant), which is exactly right for one person un-flagging
 *    one row and exactly wrong for a bulk revert whose whole purpose is to remove ONE rule and
 *    leave the rest of the rule set untouched -- it would invent a brand-new override rule as a
 *    side effect of deleting one.
 *  - not_transfer: NOT SUPPORTED, returns 0 and writes nothing. "Clearing" a not_transfer override
 *    would mean re-flagging its rows AS transfers, which is not a revert but a stronger positive
 *    claim -- and transfers are excluded from every report and budget, so it would silently move
 *    money out of every total. Delete-only for this kind; the UI does not offer the option, and
 *    this guard is here so a stale form or a second session cannot reach it anyway.
 *  - rename: the scope is IGNORED, always all rows, delegating to the deleteRenameRule flow (delete
 *    the rule, then applyRenameRules over everything). A rename is stored as display_description +
 *    display_source = 'rename' and applyRenameRules recomputes that from the rule set on every
 *    pass, clearing any row whose rule no longer resolves. So a "bounded" rename revert would
 *    leave the out-of-range rows carrying a display name whose rule is gone, and the NEXT rename
 *    pass -- triggered by saving, disabling or deleting any other rename rule -- would clear them
 *    too, silently, days later. All-or-nothing is the only stable answer, so the rename dialog
 *    shows no date fields at all. It is also the one kind that is genuinely reversible in fact:
 *    the bank's own text lives untouched in transactions.raw_description and a rename
 *    only ever wrote the display columns, which is why that dialog's copy promises the original
 *    descriptions back instead of warning about a category that cannot be recovered.
 */
export function clearRuleFromTransactions(input: { ruleId: number; scope?: RuleScope; at?: Date }): { rowsCleared: number } {
  const ctx = buildContext();
  const rule = ctx.rules.find((r) => r.id === input.ruleId);
  if (!rule) return { rowsCleared: 0 };
  if (rule.ruleKind === 'not_transfer') return { rowsCleared: 0 };
  if (rule.ruleKind === 'rename') {
    return { rowsCleared: deleteRenameRule({ pattern: rule.pattern, matchType: rule.matchType }).rowsCleared };
  }

  const ids = ruleClearIds(input.ruleId, input.scope ?? {}, ctx);
  if (ids.length === 0) return { rowsCleared: 0 };

  const at = nowIso(input.at ?? new Date());
  let rowsCleared = 0;
  // One unit of work: a crash midway through a 4000-row clear must not leave half the range
  // uncategorized and half still carrying the rule's category, which is a state no screen in the
  // app would explain.
  getDb().transaction((tx) => {
    for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
      const chunk = ids.slice(offset, offset + ID_CHUNK);
      // Chunked because SQLite has a bound-parameter ceiling and an unchunked id list has already
      // bitten this codebase once (see the note in dedup.ts that ID_CHUNK itself points at).
      rowsCleared +=
        rule.ruleKind === 'category'
          ? tx
              .update(transactions)
              .set({ categoryId: null, categorizationSource: 'none', confidence: null, updatedAt: at })
              .where(
                and(
                  inArray(transactions.id, chunk),
                  // Only rows that actually still carry something to clear, so the count returned
                  // is the honest "N transactions changed" the result message states. The id set
                  // is deliberately wider than this (it is the "Affects" set -- see
                  // ruleImpactIds): a row this rule WOULD categorize but has not yet, because
                  // nobody has re-run since the rule was written, is genuinely affected by the
                  // rule and genuinely has nothing to clear.
                  or(isNotNull(transactions.categoryId), ne(transactions.categorizationSource, 'none')),
                ),
              )
              .run().changes
          : tx
              .update(transactions)
              .set({ isTransfer: false, updatedAt: at })
              .where(and(inArray(transactions.id, chunk), eq(transactions.isTransfer, true)))
              .run().changes;
    }
  });

  return { rowsCleared };
}

/**
 * Same "not exists (select 1 from transaction_splits ...)" shape as ELIGIBLE/REVIEW_WHERE
 * above -- polarity flipped (this asks whether a split EXISTS, they ask whether one does
 * not) and scoped to one row instead of filtering a table scan. Used by confirmCategory,
 * setTransferFlag and clearCategory to refuse a write on a transaction that has splits; see
 * their doc comments for why. Deliberately a `.where()` predicate rather than a computed
 * `.select()` field: a
 * drizzle column reference interpolated into a raw `sql` fragment used as a SELECT-list value
 * is not table-qualified the way the same reference is when it appears in a `.where()`
 * condition, so embedding it as a select field here would let the correlated subquery's bare
 * `id` resolve against transaction_splits' OWN id column instead of the outer transactions
 * row -- silently matching every row once ANY split exists anywhere. Served by
 * transaction_splits_txn_idx (migration 0009).
 */
function transactionHasSplits(transactionId: number): boolean {
  const row = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.id, transactionId),
        sql`exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * The confirmed state. Sets source = 'manual' (the Bayes training set),
 * upserts an exact merchant rule, and updates token counts, decrementing the
 * previous category on a recategorization.
 *
 * Returns `{ ok: false, reason: 'has_splits' }`, and does NOTHING (no category write, no rule, no
 * Bayes training), for a transaction that has splits. Spec ruling 2a: a split row is categorized
 * BY ITS PARTS (transaction_splits, see src/lib/splits.ts), never by the parent's own category_id,
 * so overwriting that column here would misrepresent what the transaction "is" AND poison the
 * categorizer -- this function trains Bayes and writes an exact merchant rule from whatever ONE
 * category it is given, which would then mis-categorize every OTHER, unsplit transaction from
 * this merchant on a signal that was only ever true for one arbitrarily-chosen part of this one.
 * Task 2b (v1.7.0) closed this same hole for the AUTOMATIC engine path (ELIGIBLE/REVIEW_WHERE,
 * below); this closes it for the MANUAL confirm path -- the per-row and bulk "Categorize" actions
 * -- which those predicates never touched. Callers that bulk-confirm must check this return value
 * and report the skip; see bulkSetCategory in src/lib/transactions.ts.
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }`, and does NOTHING (same "nothing written" guarantee as the
 * has_splits case above), when `actorRole` is `'member'` and this merchant's exact category rule
 * was created by somebody else. The ownership check runs BEFORE the transaction row is touched at
 * all -- untraining the old category, writing the new one and training it are all downstream of a
 * successful rule write, never upstream of it -- so a refusal can never leave a half-applied
 * category sitting on a rule nobody agreed to.
 */
export function confirmCategory(input: {
  transactionId: number;
  categoryId: number;
  userId: number;
  createRule?: boolean;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): RuleGuardedWriteResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return { ok: false, reason: 'has_splits' };

  const tokens = tokenize(row.normalizedMerchant);

  if (row.source === 'manual' && row.categoryId !== null && row.categoryId === input.categoryId) {
    // Already confirmed to the same category: nothing to retrain, and nothing about the rule
    // changes either, so there is nothing for R4 to check.
    //
    // MUST-13.8: the matcher call sits on THIS path too. A transaction confirmed before a
    // loan rule existed could otherwise never be picked up by re-confirming it -- which is
    // exactly what a person does when they notice a payment did not get assigned. It is
    // cheap: applyPaymentMatchers bails on its first query when no loan rules exist.
    //
    // The cost is worth stating rather than hiding: bulkCategorizeAction loops
    // confirmCategory, so a 50-row bulk confirm makes 50 applyPaymentMatchers calls and, on a
    // household with no loans, 50 single-row indexed reads against an empty join. That is
    // a bounded, sub-millisecond cost on a user-initiated action, and it buys the property
    // that a person can always fix a missed assignment by re-confirming the row. Batching
    // it into the action layer would put a fifth caller in a sixth place and is the change
    // to make if that cost ever shows up in a profile.
    applyPaymentMatchers([input.transactionId], at);
    return { ok: true };
  }

  // R4 ownership check FIRST: resolved (and can refuse) before anything else below is touched.
  if (input.createRule !== false && row.normalizedMerchant.length > 0) {
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: input.categoryId,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  }

  if (row.source === 'manual' && row.categoryId !== null) {
    untrain(tokens, row.categoryId);
  }

  db.update(transactions)
    .set({
      categoryId: input.categoryId,
      categorizationSource: 'manual',
      confidence: null,
      updatedAt: nowIso(at),
    })
    .where(eq(transactions.id, input.transactionId))
    .run();

  train(tokens, input.categoryId);
  applyPaymentMatchers([input.transactionId], at);
  return { ok: true };
}

/**
 * Returns false, and does NOTHING (no category write, no rule deletion, no untraining), for a
 * transaction that has splits. Final pre-release review finding (2026-08-22): this is the
 * third sibling of confirmCategory/setTransferFlag above, and the one Task 2b's guard missed --
 * it is reached through the OTHER half of setCategoryAction's if/else (the empty-selection
 * branch), the same action confirmCategory's guard already protects the other half of.
 *
 * Why this one is dangerous rather than merely inconsistent: setTransactionSplits (see
 * src/lib/splits.ts) stamps categorization_source = 'manual' on the parent when splitting --
 * that is what pulls an auto-assigned Bayes row out of the review queue -- but, per design
 * ruling 2, it NEVER calls train(). So a split parent that a rule or Bayes had already
 * categorized before being split ends up 'manual' with a real category_id and NO training
 * behind it, breaking the one invariant this function's untrain() call relied on (that
 * 'manual' + a non-null category_id means THIS row's own tokens were the ones trained -- true
 * before splits existed, when confirmCategory was the only writer of 'manual' and always
 * paired it with a real train()). Left unguarded, clearing such a row untrains whatever OTHER,
 * unsplit transaction at the same merchant actually earned that training, and -- unconditionally,
 * regardless of category_id -- deletes that merchant's exact category rule too, poisoning the
 * categorizer for every future transaction from that merchant. Reproduced: confirm a control
 * transaction to a category (real training), then confirm/split a second transaction at the
 * SAME merchant and clear its category -- the control's own training and rule are erased even
 * though it was never touched.
 *
 * The blast radius stops at the categorizer, not the ledger: every split-aware aggregate reads
 * EFFECTIVE_CATEGORY (src/lib/splits.ts), which ignores the parent's own category_id entirely,
 * so a stray write here would not corrupt any total. But it WOULD leave category_id null on a
 * row whose split parts still carry real categories -- an inconsistent record for a column a
 * person was never shown a way to edit in the first place (the transactions page hides this
 * form for a split row; only a stale resubmit or a second household member's unrefreshed
 * session can still reach it). Refusing outright, like confirmCategory/setTransferFlag, avoids
 * both problems at once. Callers must check this return value; see setCategoryAction in
 * src/app/(app)/transactions/actions.ts, its only caller.
 */
export function clearCategory(input: {
  transactionId: number;
  userId: number;
  /**
   * v1.12.1 (item U / UX-2, rulings R4 and P5). REQUIRED, with no default, so the compiler makes
   * every call site say what it means. Picking "Uncategorized" from the row select on
   * /transactions used to delete that merchant's household-wide exact rule -- a change to how
   * everyone's future statements are filed, made by a mis-scroll over a <select> on a phone, with
   * nothing on screen to say it had happened. The deliberate control for deleting a rule is the
   * one that already exists: Settings -> Rules (deleteRuleAction, admin-only).
   */
  deleteRule: boolean;
  at?: Date;
}): boolean {
  const db = getDb();
  const row = db
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      source: transactions.categorizationSource,
    })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return false;

  if (row.source === 'manual' && row.categoryId !== null) {
    untrain(tokenize(row.normalizedMerchant), row.categoryId);
  }
  if (input.deleteRule) deleteExactRule(row.normalizedMerchant, 'category');

  db.update(transactions)
    .set({ categoryId: null, categorizationSource: 'none', confidence: null, updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
  return true;
}

/**
 * Returns `{ ok: false, reason: 'has_splits' }`, and does NOTHING (no is_transfer write, no rule
 * created or removed), for a transaction that has splits. Spec ruling 2a: a split's parts ARE its
 * categorization, and setTransactionSplits already refuses to split a transfer in the first place
 * (a transfer has no "category" to divide) -- so a split row should never legitimately reach
 * is_transfer = 1. Without this guard, flagging one a transfer anyway silently drops every one of
 * its split parts out of every report and budget (all of which exclude transfers, per
 * categoryBreakdown/categorySpend and friends), while the row keeps displaying its own
 * "Split - N parts" badge -- the money is gone with no visible sign why. Worse, marking it also
 * upserts a merchant rule, so the NEXT unsplit transaction from the same merchant would be
 * auto-flagged a transfer on the next import too. Task 2b (v1.7.0) closed the automatic-engine
 * side of this (ELIGIBLE/REVIEW_WHERE, above); this closes the manual "Mark transfer" side, which
 * those predicates never touched. Callers that bulk-flag must check this return value and report
 * the skip; see bulkSetTransfer in src/lib/transactions.ts.
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }`, and does NOTHING (is_transfer untouched), when `actorRole` is
 * `'member'` and the transfer/not_transfer rule this flip would learn was created by somebody
 * else. Whichever rule the flip needs is resolved -- and can refuse -- BEFORE is_transfer is ever
 * written, so a refusal never leaves the flag flipped alongside a rule nobody agreed to.
 *
 * v1.13.1 ruling R4, fix round 2 (item BJ). The check above gates the rule this action WRITES;
 * the OPPOSITE-kind rule it removes as housekeeping (the two deleteExactRule calls below) was
 * deleted unconditionally, so a member re-flagging one transaction could delete an
 * admin-authored not_transfer or transfer rule with no ownership check at all. That rule is
 * now resolved HERE, in the same block and before is_transfer is written, and a member who
 * does not own it gets the whole action refused -- no row touched, no rule deleted -- exactly
 * as confirmCategory and upsertRuleFromCorrection already refuse for the rule they write.
 *
 * v1.27.0 item 1 (the owner's report, verbatim: "when i add items to loan they are marked
 * transfer by default but it also adds a rule ... next time i buy from best buy woodbridge i
 * dont want it to automatically caretgorize it as transfer"). `learnRule` splits the two things
 * this function used to do as one -- see its own docblock just below.
 */
export function setTransferFlag(input: {
  transactionId: number;
  isTransfer: boolean;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  /**
   * v1.27.0 item 1 (the owner's report). REQUIRED, with no default, so the compiler makes every
   * call site say what it means -- the same shape, for the same bug class, as clearCategory's
   * `deleteRule` above: a per-row UI action silently rewriting household-wide rules.
   *
   * Assigning one transaction to a loan used to arrive here with the assign editor's "Also mark
   * as a transfer" checkbox pre-armed ON, and this function does not only set `is_transfer` -- it
   * upserts an EXACT transfer rule for the merchant. So filing one reimbursement against a work
   * loan permanently taught the household that everything from that shop is a transfer, and the
   * next unrelated purchase there was auto-flagged out of spending on import. Nothing on screen
   * said a rule had been written.
   *
   * The distinction the flag encodes: a transfer rule is MERCHANT-driven -- a payroll deposit or
   * a credit-card payment is a transfer every single time, so learning the merchant is exactly
   * right. A loan payment is LINK-driven -- what makes it not-spending is the loan link, and the
   * merchant is incidental. Only the merchant-driven case may author a rule.
   *
   * `false` does NO rule work whatsoever: no upsert of a transfer/not_transfer rule, and no
   * housekeeping delete of the opposite-kind rule either. Both halves matter. Leaving only the
   * delete active would still mutate household rules from a loan assignment -- quietly removing
   * somebody's deliberate "not a transfer" override -- which is the same defect wearing the other
   * sign. Nothing being read or written about rules also means there is nothing to OWN, so the
   * `owned_by_another` refusal cannot arise on this path; the split refusal still does, and
   * `is_transfer` is still written exactly as before.
   *
   * `true` is today's behaviour, byte for byte, ownership refusals included.
   */
  learnRule: boolean;
  at?: Date;
}): RuleGuardedWriteResult {
  const db = getDb();
  const at = input.at ?? new Date();
  const row = db
    .select({ normalizedMerchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .get();
  if (!row) throw new Error(`No transaction ${input.transactionId}`);
  if (transactionHasSplits(input.transactionId)) return { ok: false, reason: 'has_splits' };

  const matchesCardPattern = CARD_PAYMENT_PATTERNS.some((pattern) => row.normalizedMerchant.includes(pattern));

  // v1.13.1 ruling R4, fix round 2 (item BJ): the OPPOSITE-kind rule this flip would remove as
  // housekeeping below (deleteExactRule at the end of this function) -- 'not_transfer' when
  // re-flagging as a transfer, 'transfer' when un-flagging -- is resolved and can refuse FIRST,
  // before the rule this flip WRITES (the block below) or is_transfer itself is ever touched. It
  // has to run before the write-side upsertRuleFromCorrection call, not after: that call both
  // checks AND WRITES the rule it owns in one step, so checking housekeeping ownership only
  // after it ran could refuse the whole action while still leaving a freshly-created rule behind
  // -- the "optional owner check that still deletes on a refusal" this fix explicitly rejects,
  // applied to a create instead of a delete.
  const housekeepingKind: RuleKind = input.isTransfer ? 'not_transfer' : 'transfer';
  if (input.learnRule && input.actorRole !== 'admin') {
    const owner = exactRuleOwner(row.normalizedMerchant, housekeepingKind);
    if (owner !== null && owner.createdBy !== null && owner.createdBy !== input.userId) {
      return { ok: false, reason: 'owned_by_another', ownerName: owner.ownerName };
    }
  }

  // R4 ownership check: whichever rule this flip would learn is resolved -- and can
  // refuse -- before is_transfer itself is ever written.
  //
  // v1.27.0 item 1: `learnRule` gates BOTH rule halves, and this is the write half. It is the
  // OUTERMOST condition on purpose rather than an `&& input.learnRule` bolted onto each branch --
  // the card-payment branch below is easy to read as "not really a rule write, just an override"
  // and would be exactly the kind of half-suppressed case this parameter exists to make
  // impossible. The housekeeping delete half is gated the same way, after the is_transfer write.
  if (input.learnRule && input.isTransfer) {
    // EXACT match only: a contains rule learned from an e-transfer description
    // would over-match every unrelated e-transfer.
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'transfer',
      categoryId: null,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  } else if (input.learnRule && matchesCardPattern) {
    // The card-payment pattern list would re-catch this merchant on the very
    // next runEngine/rerun. Merely deleting a (nonexistent) transfer rule would
    // not stop that, so teach an exact 'not_transfer' override instead.
    const upserted = upsertRuleFromCorrection({
      pattern: row.normalizedMerchant,
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: input.userId,
      actorRole: input.actorRole,
      at,
    });
    if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };
  }

  db.update(transactions)
    .set({ isTransfer: input.isTransfer, updatedAt: nowIso(at) })
    .where(eq(transactions.id, input.transactionId))
    .run();

  // v1.27.0 item 1: the housekeeping DELETE half, gated by the same `learnRule` as the write half
  // above. `learnRule: false` reaches here having touched no rule at all and leaves with the same
  // guarantee -- see the parameter's own docblock for why suppressing only the upsert would still
  // let a loan assignment delete a rule the household deliberately made.
  if (!input.learnRule) {
    return { ok: true };
  }
  if (input.isTransfer) {
    // Re-flagging as a transfer must undo any earlier "not a transfer" override
    // on this exact merchant, or detectTransfer's not_transfer check (which runs
    // first) would keep silently vetoing this very rule on every future re-run.
    // Ownership of this rule was already settled above (item BJ) -- a refusal never reaches here.
    deleteExactRule(row.normalizedMerchant, 'not_transfer');
  } else if (!matchesCardPattern) {
    // Only a learned transfer rule (or a purely manual flag) could have flagged
    // this row — today's behaviour is unchanged: remove that rule.
    // Ownership of this rule was already settled above (item BJ) -- a refusal never reaches here.
    deleteExactRule(row.normalizedMerchant, 'transfer');
  }
  return { ok: true };
}

/**
 * "Apply category to all N matching transactions + create rule" (bulk action).
 *
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). Returns `{ ok: false, reason:
 * 'owned_by_another', ownerName }` and touches NO row at all when `actorRole` is `'member'` and
 * this merchant's exact category rule was created by somebody else. The rule is resolved -- and
 * can refuse -- BEFORE the loop over matching transaction ids even starts, so a refusal can never
 * leave some rows categorized against a rule the household never agreed to and others not (a
 * half-applied bulk action would be worse than an all-or-nothing refusal).
 */
export function applyCategoryToMatching(input: {
  normalizedMerchant: string;
  categoryId: number;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): CategoryMatchResult {
  const ids = getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.normalizedMerchant, input.normalizedMerchant),
        eq(transactions.isTransfer, false),
        or(ne(transactions.categoryId, input.categoryId), isNull(transactions.categoryId)),
      ),
    )
    .all()
    .map((row) => row.id);

  if (ids.length === 0) return { ok: true, count: 0 };

  // R4 ownership check FIRST: resolved -- and can refuse -- before any of the matching rows
  // below are touched.
  const upserted = upsertRuleFromCorrection({
    pattern: input.normalizedMerchant,
    matchType: 'exact',
    ruleKind: 'category',
    categoryId: input.categoryId,
    createdBy: input.userId,
    actorRole: input.actorRole,
    at: input.at,
  });
  if (!upserted.ok) return { ok: false, reason: 'owned_by_another', ownerName: upserted.ownerName };

  for (const id of ids) {
    // createRule: false -- the rule for this merchant was just resolved above, once, for the
    // whole batch; confirmCategory must not attempt (and re-check ownership on) it again per row.
    confirmCategory({
      transactionId: id,
      categoryId: input.categoryId,
      userId: input.userId,
      createRule: false,
      actorRole: input.actorRole,
      at: input.at,
    });
  }
  return { ok: true, count: ids.length };
}

/**
 * Review queue = uncategorized rows plus auto-assigned-but-unconfirmed Bayes rows.
 * Transfers are excluded: spec section 3 removes them from all spend/income
 * reporting, so they never need a category. Split rows are excluded too (spec ruling 2a,
 * v1.7.0): a split row is categorized by its parts (see the comment on ELIGIBLE above, and
 * src/lib/splits.ts), so a transaction that was genuinely uncategorized before being split --
 * category_id stays NULL, since a split never invents or overwrites the parent's own category
 * -- must not nag here forever just because that column is still empty. Served by
 * transaction_splits_txn_idx (migration 0009).
 *
 * A row with any loan_payments link is excluded too (2026-08-30 fix). Assigning a transaction to
 * a loan writes a loan_payments row and, by design (MUST-13.2, src/lib/loans.ts), never touches
 * category_id or categorization_source -- a loan payment stays in its spending category and in
 * every budget. Without this clause a loan-linked row a person had already dealt with kept
 * coming back to this queue forever, because nothing about ITS category ever changed even
 * though a decision about the row plainly had been made. A loan link IS that decision, the same
 * way confirming a category or splitting a row already is one -- so it takes the row out of the
 * queue for the same reason those do. Unassigning the link (unassignTransactionFromLoan,
 * src/lib/loans.ts) undoes the decision, so a row with no link left is undecided again and comes
 * right back. This is like the not-a-split-row clause immediately above -- a correlated `not
 * exists` in a `.where()` predicate, never a computed `.select()` field: the same warning
 * applies (see transactionHasSplits' own docblock, below) -- a bare `txn_id` interpolated into a
 * raw `sql` fragment used as a SELECT-list value is not table-qualified the way it is inside a
 * `.where()` condition, so putting this in a select list would let the correlated subquery's
 * `txn_id` resolve against loan_payments' OWN row instead of this outer transactions row,
 * matching every transaction the moment ANY loan link exists anywhere. Served by
 * loan_payments_txn_idx (migration 0007) -- no new index, no migration needed.
 */
export const REVIEW_WHERE = and(
  eq(transactions.isTransfer, false),
  or(isNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes')),
  sql`not exists (select 1 from ${transactionSplits} where ${transactionSplits.txnId} = ${transactions.id})`,
  sql`not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})`,
);

/**
 * v1.25.0 Lane R item R1 (deferred from v1.20.0). The review queue mixes two different jobs --
 * a row the classifier GUESSED (confirm or correct it) and a row it had no idea about (pick a
 * category from scratch) -- and REVIEW_WHERE's own second clause, just above, already says
 * these are the only two ways into the queue: `isNull(categoryId) OR categorizationSource =
 * 'bayes'`. categorizeTransaction (top of this file) never returns `{ categoryId: null, source:
 * 'bayes' }` -- its bayes branch only fires when `classify()` returns a guess, and that guess's
 * categoryId is never null -- and every writer that clears category_id in this codebase
 * (clearCategory, setTransactionDisplayName's sibling paths, runEngine's own transfer branch)
 * pairs it with categorization_source = 'none' in the same write, never 'bayes'. So within
 * REVIEW_WHERE's own scope, "categoryId is set AND source is bayes" and "categoryId is null"
 * are the two states that OR covers, and they are mutually exclusive and exhaustive.
 *
 * These two constants are that split, narrowing REVIEW_WHERE rather than restating or replacing
 * it -- every caller composes them as `and(REVIEW_WHERE, REVIEW_SUGGESTED_WHERE)` or
 * `and(REVIEW_WHERE, REVIEW_UNCATEGORIZED_WHERE)` (buildWhere, src/lib/transactions.ts), never
 * standalone. REVIEW_SUGGESTED_WHERE checks BOTH `categoryId IS NOT NULL` and `source = 'bayes'`
 * rather than just the source column, so a hypothetical future writer that broke the pairing
 * above would fall out of both chips instead of silently miscounting into "suggested".
 */
export const REVIEW_SUGGESTED_WHERE = and(isNotNull(transactions.categoryId), eq(transactions.categorizationSource, 'bayes'));
export const REVIEW_UNCATEGORIZED_WHERE = isNull(transactions.categoryId);

export function reviewQueueIds(limit = 100, offset = 0): number[] {
  return getDb()
    .select({ id: transactions.id })
    .from(transactions)
    .where(REVIEW_WHERE)
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all()
    .map((row) => row.id);
}

export function reviewQueueCount(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(transactions)
    .where(REVIEW_WHERE)
    .get();
  return row?.c ?? 0;
}

// ------------------------------------------------- merchant renames (v1.4)

/** The rename text a merchant resolves to, or null when no rename rule matches. */
export function resolveRename(normalizedMerchant: string, ctx: CategorizeContext): string | null {
  const rule = matchRule(normalizedMerchant, 'rename', ctx.rules);
  if (!rule || rule.renameTo === null || rule.renameTo.length === 0) return null;
  return rule.renameTo;
}

/**
 * Applies rename rules to the given rows (all rows when txnIds is omitted).
 *
 * Precedence is manual > rename > unset:
 *   - display_source = 'manual' rows are NEVER read or written here.
 *   - a matching rule sets display_description + display_source = 'rename'.
 *   - a row previously set by a rule that no longer matches is cleared back to raw.
 *
 * raw_description and normalized_merchant are never written, so the frozen dedup
 * hash and every categorizer input are untouched by anything in this function.
 */
export function applyRenameRules(txnIds?: number[], ctx: CategorizeContext = buildContext()): number {
  const db = getDb();
  const scope = txnIds === undefined ? undefined : txnIds;
  if (scope !== undefined && scope.length === 0) return 0;

  const columns = {
    id: transactions.id,
    normalizedMerchant: transactions.normalizedMerchant,
    displayDescription: transactions.displayDescription,
    displaySource: transactions.displaySource,
  } as const;

  const rows: {
    id: number;
    normalizedMerchant: string;
    displayDescription: string | null;
    displaySource: 'manual' | 'rename' | 'loan' | null;
  }[] = [];

  if (scope === undefined) {
    rows.push(...db.select(columns).from(transactions).where(ne(transactions.displaySource, 'manual')).all());
    // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
    rows.push(...db.select(columns).from(transactions).where(isNull(transactions.displaySource)).all());
  } else {
    for (let offset = 0; offset < scope.length; offset += ID_CHUNK) {
      const chunk = scope.slice(offset, offset + ID_CHUNK);
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), ne(transactions.displaySource, 'manual')))
          .all(),
      );
      // ne() drops NULLs in SQL three-valued logic, so fetch NULL display_source rows too.
      rows.push(
        ...db
          .select(columns)
          .from(transactions)
          .where(and(inArray(transactions.id, chunk), isNull(transactions.displaySource)))
          .all(),
      );
    }
  }

  const at = nowIso();
  let changed = 0;

  db.transaction((tx) => {
    for (const row of rows) {
      const rename = resolveRename(row.normalizedMerchant, ctx);

      if (rename === null) {
        // Only clear what a rule set; a NULL display_source row has nothing to clear.
        if (row.displaySource === 'rename') {
          tx.update(transactions)
            .set({ displayDescription: null, displaySource: null, updatedAt: at })
            .where(eq(transactions.id, row.id))
            .run();
          changed += 1;
        }
        continue;
      }

      if (row.displaySource === 'rename' && row.displayDescription === rename) continue;

      tx.update(transactions)
        .set({ displayDescription: rename, displaySource: 'rename', updatedAt: at })
        .where(eq(transactions.id, row.id))
        .run();
      changed += 1;
    }
  });

  return changed;
}

/** "This transaction only": manual always wins and is never overwritten by a rule. */
export function setTransactionDisplayName(input: {
  transactionId: number;
  displayDescription: string | null;
  userId: number;
  at?: Date;
}): void {
  const trimmed = input.displayDescription === null ? null : input.displayDescription.trim();
  const db = getDb();

  if (trimmed === null || trimmed.length === 0) {
    // Clearing a manual rename hands the row back to the rules.
    db.update(transactions)
      .set({ displayDescription: null, displaySource: null, updatedAt: nowIso(input.at ?? new Date()) })
      .where(eq(transactions.id, input.transactionId))
      .run();
    applyRenameRules([input.transactionId]);
    return;
  }

  db.update(transactions)
    .set({ displayDescription: trimmed, displaySource: 'manual', updatedAt: nowIso(input.at ?? new Date()) })
    .where(eq(transactions.id, input.transactionId))
    .run();
}

/**
 * "All matching + future": create/update the rule, then bulk-apply it retroactively.
 *
 * v1.13.0 ruling R4 (item AH / SEC-6). Now threads `actorRole` through to `upsertRuleFromCorrection`
 * and can refuse. A refused upsert must not bulk-apply anything: the rule the household has is
 * unchanged, so a retroactive pass would rewrite rows to a name nobody agreed on.
 */
export function upsertRenameRule(input: {
  pattern: string;
  matchType: MatchType;
  renameTo: string;
  userId: number;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): { ok: true; ruleId: number; rowsUpdated: number } | { ok: false; reason: 'owned_by_another'; ownerName: string } {
  const renameTo = input.renameTo.trim();
  if (renameTo.length === 0) throw new Error('A rename rule needs a non-empty display name');
  if (input.pattern.trim().length === 0) throw new Error('A rename rule needs a pattern');

  const result = upsertRuleFromCorrection({
    pattern: input.pattern,
    matchType: input.matchType,
    ruleKind: 'rename',
    categoryId: null,
    renameTo,
    createdBy: input.userId,
    actorRole: input.actorRole,
    at: input.at,
  });
  if (!result.ok) return result;
  const rowsUpdated = applyRenameRules(undefined, buildContext());
  return { ok: true, ruleId: result.ruleId, rowsUpdated };
}

export function deleteRenameRule(input: { pattern: string; matchType: MatchType }): {
  ruleId: number | null;
  rowsCleared: number;
} {
  const existing = listRules('rename').find((rule) => rule.pattern === input.pattern && rule.matchType === input.matchType);
  if (!existing) return { ruleId: null, rowsCleared: 0 };
  deleteRule(existing.id);
  const rowsCleared = applyRenameRules(undefined, buildContext());
  return { ruleId: existing.id, rowsCleared };
}
