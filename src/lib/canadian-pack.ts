import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { merchantRules } from '@/db/schema';
// Server-only bundled import (backlog item 17's "install from inside the app"). packs/ sits
// outside src/, exactly like package.json does for src/lib/version.ts's APP_VERSION -- see that
// file's own docblock for why a build-time import, not a runtime fs.readFileSync, is what keeps
// this correct in dev, in tests AND in the Docker container's standalone output alike (the
// container's working directory is not the project root, and Next's output tracing only follows
// what code actually imports -- an untracked runtime file read is precisely the class of bug
// docs/OPS notes elsewhere as "missing in the container only"). This module is imported only from
// server code (a page.tsx server component, 'use server' actions, the notify evaluator and the
// scheduler) -- see tests/ops/client-bundle.test.ts, which walks every 'use client' file's value
// imports and would fail if one of them ever reached this module or the JSON it carries.
import rawCanadianPack from '../../packs/canadian-merchants.json';
import { categoryLabel, listCategories, type CategoryRecord } from '@/lib/categories';
import {
  listRules,
  upsertRuleFromCorrection,
  type MatchType,
  type MerchantRuleRecord,
  type PackProvenance,
  type RuleKind,
} from '@/lib/categorize/rules';
// v1.31.0 R-10: deleteRules replaces this file's former per-rule deleteRule/deleteRenameRule
// calls -- one retroactive rename pass for a whole removal set instead of one per rename rule.
import { applyRenameRules, buildContext, deleteRules, ruleImpactCounts } from '@/lib/categorize/engine';
import { nowIso } from '@/lib/clock';
import { adminUserIds } from '@/lib/notify/config';
import { packUpdateAvailableKey } from '@/lib/notify/events';
import { enqueue, kickOutbox } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import {
  findCategory,
  importRulesPack,
  packOriginKeyById,
  parseRulesPack,
  previewRulesPackImport,
  rememberPackOrigin,
  resolveParentName,
  ruleKeyOf,
  type PackRule,
  type RulesPack,
} from '@/lib/packs';

/** The one identifier every stamped row and every setting key below is scoped to. */
export const CANADIAN_PACK_ID = 'canadian-merchants';

/**
 * Read once, at module load, off the bundled JSON -- a genuinely compile-time constant (the
 * import above is resolved by the bundler, not a runtime file read). Deliberately a SEPARATE
 * field from the file's own `version` (the RulesPack envelope/format version parseRulesPack
 * checks against PACK_VERSION): that field answers "can this install's parser read this JSON
 * shape at all", and has to stay stable for as long as the shape does, regardless of how many
 * times the CONTENT of this specific curated pack is revised. `pack_version` is the other
 * question -- "which edition of the Canadian merchant list is this" -- and it is expected to move
 * independently (a future release can add merchants without touching the format at all). Reusing
 * one field for both would mean a content-only revision could accidentally trip the format's own
 * forward-compat gate (checkEnvelope in src/lib/packs.ts refuses a pack whose `version` is newer
 * than this install's PACK_VERSION), which has nothing to do with whether the CONTENT changed.
 *
 * Throws at import time on a malformed file rather than returning a fallback: a pack this app
 * ships without a valid version of its own is a build defect, not a household-facing condition to
 * degrade gracefully for.
 */
export const CANADIAN_PACK_VERSION: number = readPackVersion(rawCanadianPack);

function readPackVersion(raw: unknown): number {
  const value = (raw as { pack_version?: unknown } | null)?.pack_version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('packs/canadian-merchants.json is missing a valid top-level "pack_version".');
  }
  return value;
}

let parsed: RulesPack | null = null;
/** Parsed once and cached -- the same static JSON every call, so re-parsing on every read buys nothing. */
export function canadianRulesPack(): RulesPack {
  if (parsed === null) parsed = parseRulesPack(rawCanadianPack);
  return parsed;
}

/** Every currently-stamped row this pack wrote and nobody has since edited or deleted. */
export function installedCanadianPackRows(): MerchantRuleRecord[] {
  return listRules().filter((rule) => rule.packSource === CANADIAN_PACK_ID);
}

export interface CanadianPackState {
  installed: boolean;
  /** The LOWEST pack_version among currently-stamped rows -- see applyCanadianPackUpdate's
   *  docblock for why every stamped row is bumped uniformly on a successful update, which is what
   *  keeps this single number an honest answer instead of an average of a partially-applied one. */
  installedVersion: number | null;
  bundledVersion: number;
  updateAvailable: boolean;
  /** How many stamped rows are present right now. */
  presentCount: number;
  /**
   * How many rules the CURRENTLY BUNDLED pack defines. Read live off the pack this build ships,
   * not a snapshot of what an older installed version once had -- there is nowhere that count is
   * durably recorded once individual rows are deleted (the whole reason this feature stamps rows
   * instead of trying to reverse-engineer "what did I originally write" later). While an update is
   * pending (installedVersion < bundledVersion) this is therefore the NEW version's total, shown
   * next to the OLD version's own label -- an honest, clearly-labelled approximation rather than a
   * number this install cannot actually produce. It is exact once installedVersion === bundledVersion.
   */
  totalCount: number;
}

/**
 * `pack`/`bundledVersion` default to the real bundled pack and are overridable only so
 * tests/lib/canadian-pack.test.ts can exercise "an update is available" / diff / apply against a
 * synthetic newer pack, without a second real JSON file shipping in the repo just to prove the
 * comparison logic -- the same optional-context-with-a-real-default idiom
 * src/lib/categorize/engine.ts's `ctx: CategorizeContext = buildContext()` already uses. No
 * production call site ever passes either argument.
 */
export function canadianPackState(pack: RulesPack = canadianRulesPack(), bundledVersion: number = CANADIAN_PACK_VERSION): CanadianPackState {
  const rows = installedCanadianPackRows();
  const totalCount = pack.rules.length;
  if (rows.length === 0) {
    return { installed: false, installedVersion: null, bundledVersion, updateAvailable: false, presentCount: 0, totalCount };
  }
  const installedVersion = Math.min(...rows.map((row) => row.packVersion ?? bundledVersion));
  return {
    installed: true,
    installedVersion,
    bundledVersion,
    updateAvailable: installedVersion < bundledVersion,
    presentCount: rows.length,
    totalCount,
  };
}

export interface CanadianPackInstallPreview {
  totalRules: number;
  categoryRules: number;
  renameRules: number;
  /** How many rows this install would actually write right now (previewRulesPackImport's newRules
   *  -- some patterns may already exist, kept as the household's own). */
  wouldWrite: number;
  alreadyPresent: number;
}

export function previewCanadianPackInstall(): CanadianPackInstallPreview {
  const pack = canadianRulesPack();
  const plan = previewRulesPackImport(rawCanadianPack);
  return {
    totalRules: pack.rules.length,
    categoryRules: pack.rules.filter((rule) => rule.rule_kind === 'category').length,
    renameRules: pack.rules.filter((rule) => rule.rule_kind === 'rename').length,
    wouldWrite: plan.newRules,
    alreadyPresent: plan.unchanged + plan.conflicts.length,
  };
}

/**
 * Install (or re-install after a partial removal). Always 'keep' on conflict -- there is no UI
 * path that offers 'overwrite' for this preset (Part 3's disclaimer promises "conflicts keep the
 * household's own rules", full stop) -- so a household rule with the same pattern is NEVER
 * touched, and per importRulesPack's `stamp` contract, never stamped either.
 *
 * `input`/`version` default to the real bundle -- see canadianPackState's docblock for why they
 * are overridable at all (tests only; no production call site ever passes either).
 */
export function installCanadianPack(
  at: Date = new Date(),
  input: unknown = rawCanadianPack,
  version: number = CANADIAN_PACK_VERSION,
): ReturnType<typeof importRulesPack> {
  const installedAt = nowIso(at);
  const result = importRulesPack(input, {
    onConflict: 'keep',
    stamp: { source: CANADIAN_PACK_ID, version, installedAt },
  });
  // v1.25.0 (item 18). Record where every row this pack now claims was put, so a later form save
  // that re-keys one can pass that origin to the row it creates and the update flow can tell "you
  // replaced this rule" apart from "you have never seen this rule". Runs AFTER the import rather
  // than inside it because it is keyed off pack_source, which is exactly the set of rows the import
  // decided to write: a conflict-kept row was never stamped, so it is never given an origin either
  // and stays wholly the household's. See rememberPackOrigin (src/lib/packs.ts).
  rememberPackOrigin(CANADIAN_PACK_ID);
  return result;
}

export interface CanadianPackRemovalPreview {
  ruleCount: number;
  transactionsRevert: number;
}

/** Reuses ruleImpactCounts, the SAME figure the rules page's bulk-delete confirmation already
 *  computes for "N transactions will revert to the bank's wording" -- not a second version. */
export function previewCanadianPackRemoval(): CanadianPackRemovalPreview {
  const rows = installedCanadianPackRows();
  const impact = ruleImpactCounts();
  const transactionsRevert = rows
    .filter((rule) => rule.ruleKind === 'rename')
    .reduce((sum, rule) => sum + (impact.get(rule.id) ?? 0), 0);
  return { ruleCount: rows.length, transactionsRevert };
}

export interface CanadianPackRemovalResult {
  deleted: number;
  transactionsReverted: number;
}

/**
 * Deletes ONLY currently-stamped rows -- a rule the household edited since install lost its
 * stamp the moment it was edited (see upsertRuleFromCorrection's `pack` docblock) and is
 * therefore invisible to installedCanadianPackRows(), so this can never delete a rule that is,
 * by this point, theirs.
 *
 * v1.25.0 (item 18) does NOT widen that. pack_origin_key is deliberately not consulted here, and
 * both previewCanadianPackRemoval above and this function still filter on pack_source alone: a row
 * carrying an origin but no stamp is a rule the household re-keyed and now depends on, so "Remove
 * all" must leave it -- and its count must not appear in the dialog's "Remove N preset rules"
 * either, or the sentence would promise a deletion that does not happen. The origin is read at
 * exactly one decision point (walkCanadianPackUpdate below), where its only power is to make an
 * update write LESS than it otherwise would.
 */
export function removeCanadianPack(): CanadianPackRemovalResult {
  const rows = installedCanadianPackRows();
  // v1.31.0 (R-10). One call, one retroactive rename pass. This loop used to call
  // deleteRenameRule once per stamped rename rule, and the shipped pack carries eighteen of them
  // -- eighteen full passes over every non-manual transaction, each reading the table twice and
  // committing its own transaction. That is why "Remove all" felt slow on a real household. The
  // batching lives in deleteRules (src/lib/categorize/engine.ts), beside the pass it batches;
  // its docblock carries the measured before/after and explains why the single pass's count is a
  // truer answer than the per-rule sum this function used to add up.
  const { deleted, rowsCleared } = deleteRules(rows.map((rule) => rule.id));
  return { deleted, transactionsReverted: rowsCleared };
}

// ------------------------------------------------------------- version updates

export interface CanadianPackDiffEntry {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryLabel: string | null;
  renameTo: string | null;
}

export interface CanadianPackChangedEntry {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  before: string;
  after: string;
}

/**
 * v1.25.0 (backlog item 18). A pack rule that has NO row under its own key, but which the
 * household demonstrably still has -- under a pattern (or match type, or kind) of their own,
 * recorded in merchant_rules.pack_origin_key when the form save re-keyed it. Never written by an
 * update: reported so the confirm screen can say "not added back, you have your own version of
 * this" instead of offering the pack's original as a fresh addition and quietly reinstating a rule
 * that was deliberately replaced.
 */
export interface CanadianPackEditedAwayEntry {
  /** The PACK's pattern -- the entry this is about, as the pack itself names it. */
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryLabel: string | null;
  renameTo: string | null;
  /**
   * The live rule(s) the household now has this pack entry saved as. Never empty (an entry only
   * exists because at least one such row was found), and a list rather than a single value because
   * nothing stops a rule being re-keyed twice, each save leaving another row that descends from the
   * same pack entry.
   *
   * Carries matchType alongside the pattern because a re-key is not always a pattern change: the
   * origin is a whole key, so promoting the pack's `IGA` from exact to whole-word through the form
   * lands here too, with the SAME pattern. The confirm screen needs both to write a true sentence
   * about it rather than "you have IGA" under a heading about IGA.
   */
  savedAs: { pattern: string; matchType: MatchType }[];
}

export interface CanadianPackUpdateDiff {
  fromVersion: number | null;
  toVersion: number;
  added: CanadianPackDiffEntry[];
  changed: CanadianPackChangedEntry[];
  /** A pattern the new pack no longer carries at all -- offered for deletion, never removed here. */
  removed: CanadianPackDiffEntry[];
  /**
   * A pack pattern that already has a row in merchant_rules, but NOT one this pack still claims
   * (its stamp is gone -- an edit through the form, confirmCategory, setTransferFlag or
   * applyCategoryToMatching all clear it; see upsertRuleFromCorrection). Never written to by an
   * update -- reported so the confirm screen can say "left alone because you edited it" instead
   * of silently doing nothing.
   */
  skippedEdited: CanadianPackDiffEntry[];
  /**
   * v1.25.0 (item 18). The same promise skippedEdited makes -- "your version is left alone" -- on
   * different evidence, and a separate list rather than folded into that one because the two need
   * different sentences. skippedEdited means A ROW EXISTS UNDER THIS PACK PATTERN and the pack no
   * longer claims it; this means NO ROW EXISTS under the pack pattern at all, and the reason to
   * leave it alone is a row somewhere else that came from it.
   */
  editedAway: CanadianPackEditedAwayEntry[];
  unchangedCount: number;
}

interface ResolvedPackRule {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  categoryLabel: string | null;
  renameTo: string | null;
}

/** Every pack rule, normalized and category-resolved exactly the way importRulesPack resolves one
 *  (reusing findCategory/resolveParentName from packs.ts, not a second copy of that logic). */
function resolvePackRules(pack: RulesPack, categories: CategoryRecord[]): ResolvedPackRule[] {
  return pack.rules.map((rule: PackRule) => {
    const pattern = rule.pattern.trim().toUpperCase();
    const category = rule.category === null ? null : findCategory(categories, rule.category, resolveParentName(pack, rule));
    return {
      pattern,
      matchType: rule.match_type,
      ruleKind: rule.rule_kind,
      categoryId: category?.id ?? null,
      categoryLabel: rule.rule_kind === 'category' ? (category ? categoryLabel(category.id, categories) : null) : null,
      renameTo: rule.rule_kind === 'rename' ? rule.rename_to : null,
    };
  });
}

/**
 * Classifies every currently-bundled pack rule against what is in the database RIGHT NOW, shared
 * by canadianPackUpdateDiff (reporting) and applyCanadianPackUpdate (writing) -- one walk, one
 * definition of added/changed/unchanged/skipped, rather than the preview and the apply drifting
 * apart because they were computed two different ways.
 *
 * v1.25.0 (item 18) adds a SECOND lookup beside byKey, and the order the two are consulted in is
 * the whole fix. A rule's key is its identity, so a pack rule with no row under its key used to be
 * an addition, full stop -- which is right for a genuinely new merchant and wrong for one the
 * household re-keyed and then deleted the pack's original of, exactly as the form's own hint tells
 * them to. movedByOrigin catches the second case by asking merchant_rules.pack_origin_key "does
 * some row here descend from this pack entry", and it is consulted ONLY when byKey has already come
 * up empty, so it can never override, reclassify or lay claim to a row that is sitting under the
 * pack's own key.
 */
function walkCanadianPackUpdate(pack: RulesPack): {
  added: ResolvedPackRule[];
  changed: { rule: ResolvedPackRule; existing: MerchantRuleRecord }[];
  unchanged: { rule: ResolvedPackRule; existing: MerchantRuleRecord }[];
  skippedEdited: ResolvedPackRule[];
  editedAway: { rule: ResolvedPackRule; rows: MerchantRuleRecord[] }[];
  removed: MerchantRuleRecord[];
} {
  const categories = listCategories({ includeArchived: true });
  const resolved = resolvePackRules(pack, categories);

  const allRules = listRules();
  const byKey = new Map(allRules.map((row) => [ruleKeyOf(row), row]));
  const stampedKeys = new Set(installedCanadianPackRows().map((row) => ruleKeyOf(row)));

  // Rows that record an origin DIFFERENT from where they now sit -- i.e. rows the household
  // re-keyed. A row still sitting on its own origin is excluded on purpose: it is found by byKey
  // above and classified there, and admitting it here would give a second, weaker path to the same
  // row. Grouped into a list because a rule can be re-keyed more than once, each save leaving
  // another descendant of the same pack entry.
  const originKeys = packOriginKeyById();
  const movedByOrigin = new Map<string, MerchantRuleRecord[]>();
  for (const row of allRules) {
    const origin = originKeys.get(row.id);
    if (origin === undefined || origin === ruleKeyOf(row)) continue;
    const group = movedByOrigin.get(origin);
    if (group === undefined) movedByOrigin.set(origin, [row]);
    else group.push(row);
  }

  const added: ResolvedPackRule[] = [];
  const changed: { rule: ResolvedPackRule; existing: MerchantRuleRecord }[] = [];
  const unchanged: { rule: ResolvedPackRule; existing: MerchantRuleRecord }[] = [];
  const skippedEdited: ResolvedPackRule[] = [];
  const editedAway: { rule: ResolvedPackRule; rows: MerchantRuleRecord[] }[] = [];
  const packKeys = new Set<string>();

  for (const rule of resolved) {
    const key = ruleKeyOf(rule);
    packKeys.add(key);
    const existing = byKey.get(key);

    if (!existing) {
      const moved = movedByOrigin.get(key);
      if (moved !== undefined) {
        // The household has this pack rule, re-keyed. Adding the pack's original back would
        // resurrect a rule they deliberately replaced and set the two competing through matchRule's
        // longest-pattern-wins -- the defect item 18 exists to fix.
        editedAway.push({ rule, rows: moved });
        continue;
      }
      added.push(rule);
      continue;
    }
    if (!stampedKeys.has(key)) {
      // A row exists but this pack does not currently claim it -- edited away, or a household
      // rule that happened to coincide with this pattern. Either way, leave it alone.
      skippedEdited.push(rule);
      continue;
    }
    const sameOutcome =
      rule.ruleKind === 'rename' ? (existing.renameTo ?? null) === rule.renameTo : (existing.categoryId ?? null) === rule.categoryId;
    if (sameOutcome) unchanged.push({ rule, existing });
    else changed.push({ rule, existing });
  }

  const removed = installedCanadianPackRows().filter((row) => !packKeys.has(ruleKeyOf(row)));

  return { added, changed, unchanged, skippedEdited, editedAway, removed };
}

/** `pack`/`toVersion` default to the real bundle -- see canadianPackState's docblock for why they
 *  are overridable at all (tests only). */
export function canadianPackUpdateDiff(pack: RulesPack = canadianRulesPack(), toVersion: number = CANADIAN_PACK_VERSION): CanadianPackUpdateDiff {
  const categories = listCategories({ includeArchived: true });
  const state = canadianPackState(pack, toVersion);
  const walk = walkCanadianPackUpdate(pack);

  const toEntry = (rule: ResolvedPackRule): CanadianPackDiffEntry => ({
    pattern: rule.pattern,
    matchType: rule.matchType,
    ruleKind: rule.ruleKind,
    categoryLabel: rule.categoryLabel,
    renameTo: rule.renameTo,
  });
  const rowLabel = (row: MerchantRuleRecord): string =>
    row.ruleKind === 'rename' ? (row.renameTo ?? '(no rename)') : categoryLabel(row.categoryId, categories);
  const ruleLabel = (rule: ResolvedPackRule): string => (rule.ruleKind === 'rename' ? (rule.renameTo ?? '(no rename)') : (rule.categoryLabel ?? '(no category)'));

  return {
    fromVersion: state.installedVersion,
    toVersion,
    added: walk.added.map(toEntry),
    changed: walk.changed.map(({ rule, existing }) => ({
      pattern: rule.pattern,
      matchType: rule.matchType,
      ruleKind: rule.ruleKind,
      before: rowLabel(existing),
      after: ruleLabel(rule),
    })),
    removed: walk.removed.map((row) => ({
      pattern: row.pattern,
      matchType: row.matchType,
      ruleKind: row.ruleKind,
      categoryLabel: row.ruleKind === 'category' ? categoryLabel(row.categoryId, categories) : null,
      renameTo: row.renameTo,
    })),
    skippedEdited: walk.skippedEdited.map(toEntry),
    editedAway: walk.editedAway.map(({ rule, rows }) => ({
      ...toEntry(rule),
      savedAs: rows.map((row) => ({ pattern: row.pattern, matchType: row.matchType })),
    })),
    unchangedCount: walk.unchanged.length,
  };
}

export interface CanadianPackUpdateResult {
  added: number;
  changed: number;
  unchanged: number;
  skippedEdited: number;
  /** v1.25.0 (item 18). Pack rules NOT added back because the household has them re-keyed. */
  editedAway: number;
  removedOffered: number;
  removedDeleted: number;
  transactionsReverted: number;
  toVersion: number;
}

/**
 * Never auto-applied (see this feature's spec, Part 4): this is only ever called from
 * applyCanadianPackUpdateAction, which only ever runs after an admin has been SHOWN
 * canadianPackUpdateDiff() and pressed a confirm button naming the version. There is no cron tick,
 * no boot hook and no "while we're here" call site for this function anywhere in this codebase --
 * a version comparison alone (canadianPackState().updateAvailable) is never enough to decide with,
 * because a rule's outcome decides how money gets categorized, and this app never recategorizes
 * anything without a human's say-so (rerunEngine/applyRuleNow follow the identical discipline for
 * an ordinary rule edit). If a future session is tempted to wire this into the update tick or the
 * install path "for convenience", that is the exact regression this docblock exists to stop.
 *
 * `deleteRemoved` mirrors `removed` in canadianPackUpdateDiff: when false (the default a
 * confirm screen should offer unchecked, since deleting is destructive), a rule the new pack no
 * longer defines is left exactly as it is, EXCEPT its stamp is cleared -- the pack no longer
 * claims it, so it becomes an ordinary household rule from this point on, the same way an edited
 * one already does. When true, it is deleted the same way removeCanadianPack() deletes one
 * (rename rules revert their transactions; the returned transactionsReverted covers exactly this).
 *
 * v1.25.0 (item 18): walk.editedAway has no loop below, and that absence is the feature. A pack
 * rule the household re-keyed is not added, not changed and not stamped -- their row is left exactly
 * as it is, and the count is returned only so the confirm screen's "not added back" line and this
 * function's behaviour cannot disagree.
 *
 * Every row this function WRITES (added + changed + unchanged) is stamped/re-stamped at
 * `toVersion`, INCLUDING the unchanged ones whose content does not actually change -- a cheap
 * extra write, but it is what keeps canadianPackState()'s installedVersion (the lowest stamped
 * version) a single honest number after a successful update, rather than a mix of old and new
 * stamps that would make "installed vN" a half-truth. A disabled rule's disabled_at is never part
 * of this function's writes (it stamps via upsertRuleFromCorrection, which has no disabled_at
 * field at all), so "keep a disabled rule disabled" holds for free.
 *
 * `pack`/`toVersion` default to the real bundle -- see canadianPackState's docblock for why they
 * are overridable at all (tests only; no production call site ever passes either).
 */
export function applyCanadianPackUpdate(input: {
  deleteRemoved: boolean;
  at?: Date;
  pack?: RulesPack;
  toVersion?: number;
}): CanadianPackUpdateResult {
  const at = input.at ?? new Date();
  const installedAt = nowIso(at);
  const pack = input.pack ?? canadianRulesPack();
  const toVersion = input.toVersion ?? CANADIAN_PACK_VERSION;
  const walk = walkCanadianPackUpdate(pack);
  const db = getDb();
  const stamp: PackProvenance = { source: CANADIAN_PACK_ID, version: toVersion, installedAt };

  /**
   * v1.31.0 (R-10). REMOVALS FIRST, and the order is what makes the count honest.
   *
   * This loop used to sit AFTER the added/changed writes and call deleteRenameRule per removed
   * rename rule -- one full retroactive pass each -- and then the whole function paid for one
   * MORE pass at the end. So the shipped pack's own update ran (removed renames + 1) passes over
   * every non-manual transaction where two are enough.
   *
   * Simply batching them where the loop used to sit would have been wrong, not just tidy: with
   * the new renames already written, the single removal pass's `changed` count would include rows
   * this update RENAMED, and `transactionsReverted` is reported to the admin as "N transactions
   * went back to the bank's wording". Removing first means this pass sees only the reverts, and
   * the trailing pass at the end of the function picks up everything the added/changed renames
   * now claim. walk.removed and walk.added/changed are disjoint by construction (keyOf: removed
   * is "stamped here, not in the new pack", added is "in the new pack, not here"), so nothing
   * depends on which of the two runs first.
   *
   * rememberPackOrigin still runs after BOTH, for the reason its own comment gives.
   */
  const removedIds: number[] = [];
  for (const row of walk.removed) {
    if (!input.deleteRemoved) {
      // The pack no longer claims this row -- clear its stamp so it becomes an ordinary household
      // rule (same treatment an edited row already gets), rather than leaving a stale pointer at a
      // pack version that no longer lists it.
      db.update(merchantRules)
        .set({ packSource: null, packVersion: null, installedAt: null })
        .where(eq(merchantRules.id, row.id))
        .run();
      continue;
    }
    removedIds.push(row.id);
  }
  const removal = deleteRules(removedIds);
  const removedDeleted = removal.deleted;
  const transactionsReverted = removal.rowsCleared;

  let renameTouched = false;

  for (const rule of walk.added) {
    upsertStamped(rule, stamp);
    if (rule.ruleKind === 'rename') renameTouched = true;
  }
  for (const { rule } of walk.changed) {
    upsertStamped(rule, stamp);
    if (rule.ruleKind === 'rename') renameTouched = true;
  }
  for (const { existing } of walk.unchanged) {
    // Content is identical; only the stamp needs bumping. A raw UPDATE (not the shared upsert) is
    // correct here specifically because there is nothing else to write and no conflict to resolve
    // -- the row unambiguously already belongs to this pack.
    db.update(merchantRules)
      .set({ packSource: stamp.source, packVersion: stamp.version, installedAt: stamp.installedAt })
      .where(eq(merchantRules.id, existing.id))
      .run();
  }

  // v1.25.0 (item 18), same reason as installCanadianPack's call: an ADDED row has just acquired a
  // stamp and no origin yet, so record where the pack put it. Placed after the removal loop rather
  // than beside the writes because that loop clears the stamp on a row the pack no longer names --
  // and a row this pack does not claim must not be given an origin by a pass keyed off pack_source.
  // (v1.31.0 R-10 moved that loop ABOVE the writes; this call still runs after both, which is what
  // the sentence was actually protecting.)
  // Its own origin, if it had one, is untouched: rememberPackOrigin only ever fills in a NULL.
  rememberPackOrigin(CANADIAN_PACK_ID);

  if (renameTouched) applyRenameRules(undefined, buildContext());

  return {
    added: walk.added.length,
    changed: walk.changed.length,
    unchanged: walk.unchanged.length,
    skippedEdited: walk.skippedEdited.length,
    editedAway: walk.editedAway.length,
    removedOffered: walk.removed.length,
    removedDeleted,
    transactionsReverted,
    toVersion,
  };
}

function upsertStamped(rule: ResolvedPackRule, stamp: PackProvenance): void {
  upsertRuleFromCorrection({
    pattern: rule.pattern,
    matchType: rule.matchType,
    ruleKind: rule.ruleKind,
    categoryId: rule.categoryId,
    renameTo: rule.renameTo,
    createdBy: null,
    actorRole: 'admin',
    pack: stamp,
  });
}

// --------------------------------------------------------------------- notify

/** What the settings-page-notifications.test.tsx and render.test.ts fixtures pin as this pack's
 *  display name -- not the bare id (CANADIAN_PACK_ID reads fine in a stamped row's tooltip, but
 *  "canadian-merchants: version 2 is available" is not a sentence a household should have to
 *  parse). */
export const CANADIAN_PACK_LABEL = 'Canadian merchant pack';

/**
 * Backlog item 17 / Part 4 ("wire a line into the existing notification digest so it can be told
 * once, rather than only on a page visit"). Modelled on src/lib/update/check.ts's
 * notifyUpdateAvailable -- a plain version comparison (no network call, unlike the app's own
 * GitHub-backed check) fanned out to every admin via the SAME enqueue/kickOutbox pair, using the
 * event registry's dedup key so a version already announced is never announced twice. Called from
 * runUpdateTick (src/lib/scheduler.ts) right alongside the app's own update check -- not a new
 * cron entry, not a new channel, per this feature's own "do not invent a new mechanism" brief.
 *
 * Returns false (and enqueues nothing) when no update is pending, or when this specific version
 * has already been announced to every admin (enqueue's own dedup, not re-checked here) -- callers
 * that only care about the boolean can treat it exactly like notifyUpdateAvailable's own return.
 *
 * `state` defaults to the real, live comparison -- overridable only so
 * tests/lib/canadian-pack.test.ts can exercise "an update is pending" without waiting on a second
 * real pack version to exist (see canadianPackState's own docblock for the identical reasoning).
 */
export function notifyCanadianPackUpdateAvailable(at: Date = new Date(), state: CanadianPackState = canadianPackState()): boolean {
  if (!state.updateAvailable || state.installedVersion === null) return false;

  try {
    const { subject, body } = renderEvent({
      event: 'pack_update_available',
      packLabel: CANADIAN_PACK_LABEL,
      installedVersion: state.installedVersion,
      bundledVersion: state.bundledVersion,
    });
    let queued = 0;
    for (const userId of adminUserIds()) {
      queued += enqueue({
        userId,
        eventId: 'pack_update_available',
        dedupKey: packUpdateAvailableKey(CANADIAN_PACK_ID, state.bundledVersion),
        subject,
        body,
        at,
      }).inserted.length;
    }
    if (queued > 0) kickOutbox(at);
    return queued > 0;
  } catch (error) {
    // A notification failure may not break the update tick, exactly as notify_available's own
    // raise cannot (src/lib/update/check.ts) and every notify raiser elsewhere (MUST-6.19).
    console.error('[canadian-pack] pack_update_available raise failed', error);
    return false;
  }
}
