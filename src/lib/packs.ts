import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { merchantRules } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { todayIso } from '@/lib/dates';
import { categoryLabel, createCategory, listCategories, type CategoryRecord } from '@/lib/categories';
// applyRenameRules/buildContext: required care item 2 -- an imported rename has to be applied
// retroactively, exactly as upsertRenameRule does for the form path (src/lib/categorize/engine.ts).
import { applyRenameRules, buildContext } from '@/lib/categorize/engine';
import {
  listRules,
  upsertRuleFromCorrection,
  type MatchType,
  type MerchantRuleRecord,
  type PackProvenance,
  type RuleKind,
} from '@/lib/categorize/rules';
import { importMappingSchema, type ImportMapping } from '@/lib/import/mapping';
import { createProfile, getProfileByName, hasReadableMapping, listProfiles } from '@/lib/import/presets';

export const RULES_PACK_FORMAT = 'budget-tracker-rules';
export const PROFILES_PACK_FORMAT = 'budget-tracker-profiles';
export const PACK_VERSION = 1;

export class PackFormatError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PackFormatError';
  }
}

export interface PackCategory {
  name: string;
  parent: string | null;
  is_income: boolean;
  icon: string | null;
  color: string | null;
}

export interface PackRule {
  pattern: string;
  match_type: MatchType;
  rule_kind: RuleKind;
  category: string | null;
  category_parent: string | null;
  /**
   * Only meaningful when rule_kind = 'rename'. A rename entry with no non-empty rename_to is
   * rejected at parse time (see packRuleSchema's superRefine below) -- the same "a rename rule
   * needs a display name" guard the form applies in settings/merchant-rules/actions.ts, just
   * enforced at the pack boundary instead of a form field.
   */
  rename_to: string | null;
}

export interface RulesPack {
  format: typeof RULES_PACK_FORMAT;
  version: number;
  exported_at: string;
  categories: PackCategory[];
  rules: PackRule[];
}

export interface PackProfile {
  name: string;
  institution: string;
  mapping: ImportMapping;
}

export interface ProfilesPack {
  format: typeof PROFILES_PACK_FORMAT;
  version: number;
  exported_at: string;
  profiles: PackProfile[];
}

// ---------------------------------------------------------------- envelopes

/**
 * Controller ruling (a) — revised 2026-08-31 (owner decision, after the original "renames never
 * leave the system" framing was pushed back on): a rename rule's target ('rename_to') is free
 * text a household member typed to turn an opaque bank string into something meaningful —
 * "Loan to <name>", "Rent from <name>", "<name>'s birthday gift". Unlike a category rule (a
 * pattern plus a category id) or a transfer rule (kind is the whole outcome), that text can
 * carry a private person's name straight into a file handed to someone else. That is a
 * DISCLOSURE risk, not a difference of taste, so export treats rename the same shape 'transfer'
 * already has: excluded by default, included only on an explicit includeRenameRules opt-in, with
 * the actual text surfaced in previewRulesPackExport's RulesExportRow BEFORE it leaves — an
 * opt-in without seeing the text first is a checkbox, not informed consent. See exportableRules
 * below.
 *
 * On IMPORT the calculus is different: installing someone else's "WALMART" -> "Walmart" rename
 * cannot leak anything of the RECEIVING household's own data, and it is fully reversible —
 * deleting the rule reverts the rows (applyRenameRules clears back to raw). So rename is
 * importable unconditionally, listed in IMPORTABLE_RULE_KINDS below, and applied retroactively
 * the same way saving one on the form does (see importRulesPack).
 *
 * 'not_transfer' stays excluded in BOTH directions: it describes this install's own account
 * wiring (which of ITS OWN patterns CARD_PAYMENT_PATTERNS would otherwise wrongly auto-flag as a
 * transfer, per engine.ts's detectTransfer) and means nothing on a different install with
 * different accounts — there is no version of "share this" that makes sense for it. On import,
 * an entry with 'not_transfer' or any rule_kind this install doesn't recognise is skipped
 * gracefully and counted (user-friendliness watch-item from spec review) — it must never fail
 * the whole pack.
 */
const IMPORTABLE_RULE_KINDS: readonly RuleKind[] = ['category', 'transfer', 'rename'];
function isImportableRuleKind(kind: string): kind is RuleKind {
  return (IMPORTABLE_RULE_KINDS as readonly string[]).includes(kind);
}

const packCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  parent: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
  is_income: z.boolean().optional().transform((v) => v ?? false),
  icon: z.string().max(16).nullable().optional().transform((v) => v ?? null),
  color: z.string().max(32).nullable().optional().transform((v) => v ?? null),
});

// rule_kind and category_parent are documented supersets of the section 11
// example: the example shows the default case only. Both default cleanly, so a
// pack written straight from the spec still imports.
//
// rule_kind deliberately accepts ANY string here (not just 'category' | 'transfer' | 'rename'):
// per controller ruling (a), a pack entry carrying 'not_transfer', or some value this install
// has never heard of, is not a malformed pack — it's skipped gracefully downstream
// (previewRulesPackImport / importRulesPack), never rejected. 'rename' IS validated at this
// layer (see the superRefine below): a rename with no target is a genuinely malformed entry, not
// an unsupported kind.
const packRuleSchema = z
  .object({
    pattern: z.string().trim().min(1).max(200),
    match_type: z.enum(['exact', 'contains']),
    rule_kind: z
      .string()
      .trim()
      .min(1)
      .optional()
      .transform((v) => (v ?? 'category') as RuleKind),
    category: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
    category_parent: z.string().trim().min(1).max(60).nullable().optional().transform((v) => v ?? null),
    // Renames have never travelled through this schema before (controller ruling (a) used to
    // reject the kind outright). max(200) matches the renameTo column's own practical limit
    // (see the form's saveRuleAction); empty/whitespace-only collapses to null so the superRefine
    // below has one shape to check rather than two ('' and null meaning the same "no target").
    rename_to: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .transform((v) => {
        const trimmed = (v ?? '').trim();
        return trimmed.length > 0 ? trimmed : null;
      }),
  })
  .superRefine((rule, ctx) => {
    // Mirrors the form's own guard ("A rename rule needs a display name.", saveRuleAction) at the
    // pack boundary: a rename entry with no target is a malformed pack entry, not a gracefully
    // skippable kind, so this fails the whole pack's parse with a clear message rather than
    // silently importing a rule with an empty renameTo (a corrected empty rename to a non-empty
    // rename is a strictly different design than the null grey area).
    if (rule.rule_kind === 'rename' && rule.rename_to === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A rename rule needs a non-empty rename_to (pattern "${rule.pattern}").`,
        path: ['rename_to'],
      });
    }
  });

function checkEnvelope(input: unknown, format: string, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PackFormatError(`This file is not a Budget Tracker ${label} pack (expected a JSON object).`);
  }
  const record = input as Record<string, unknown>;
  if (record.format !== format) {
    throw new PackFormatError(
      `This file is not a Budget Tracker ${label} pack (found format ${JSON.stringify(record.format ?? null)}, expected "${format}").`,
    );
  }
  const version = record.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new PackFormatError(`This ${label} pack has an invalid version (${JSON.stringify(version ?? null)}).`);
  }
  if (version > PACK_VERSION) {
    throw new PackFormatError(
      `This ${label} pack was made by a newer version of Budget Tracker (pack version ${version}; this install understands ${PACK_VERSION}). Update this install first.`,
    );
  }
  return record;
}

const lower = (value: string) => value.trim().toLowerCase();

/**
 * Defensive guard against a hand-crafted (or malicious) pack that declares a
 * category nesting more than two levels deep, or a parent/child cycle. This
 * app's category model is hard-limited to two levels (createCategory throws if
 * asked to create a grandchild); without this check a deep pack would still
 * parse successfully and only blow up later, mid-import, as a raw uncaught
 * Error once the writer reaches the offending row. Rejecting up front, with a
 * clear message, keeps the whole pack format-rejection story consistent.
 */
function assertNoDeepNesting(pack: { categories: PackCategory[]; rules: PackRule[] }): void {
  const declaredParentOf = new Map<string, string>();
  for (const category of pack.categories) {
    if (category.parent !== null) declaredParentOf.set(lower(category.name), category.parent);
  }
  const usedAsParent = new Set<string>();
  for (const category of pack.categories) {
    if (category.parent !== null) usedAsParent.add(lower(category.parent));
  }
  for (const rule of pack.rules) {
    if (rule.category_parent !== null) usedAsParent.add(lower(rule.category_parent));
  }
  for (const parentName of usedAsParent) {
    const grandparent = declaredParentOf.get(parentName);
    if (grandparent !== undefined) {
      throw new PackFormatError(
        `This rules pack nests categories more than two levels deep ("${parentName}" is used as a parent, but is itself declared under "${grandparent}"), which isn't supported.`,
      );
    }
  }
}

export function parseRulesPack(input: unknown): RulesPack {
  const record = checkEnvelope(input, RULES_PACK_FORMAT, 'rules');
  const parsed = z
    .object({
      exported_at: z.string().optional().transform((v) => v ?? ''),
      categories: z.array(packCategorySchema),
      rules: z.array(packRuleSchema),
    })
    .safeParse(record);
  if (!parsed.success) {
    throw new PackFormatError(`This rules pack is malformed: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}.`);
  }
  assertNoDeepNesting(parsed.data);
  return {
    format: RULES_PACK_FORMAT,
    version: record.version as number,
    exported_at: parsed.data.exported_at,
    categories: parsed.data.categories,
    rules: parsed.data.rules,
  };
}

export function parseProfilesPack(input: unknown): ProfilesPack {
  const record = checkEnvelope(input, PROFILES_PACK_FORMAT, 'profiles');
  const parsed = z
    .object({
      exported_at: z.string().optional().transform((v) => v ?? ''),
      profiles: z.array(
        z.object({
          name: z.string().trim().min(1).max(80),
          institution: z.string().trim().min(1).max(80),
          mapping: importMappingSchema,
        }),
      ),
    })
    .safeParse(record);
  if (!parsed.success) {
    throw new PackFormatError(`This profiles pack is malformed: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}.`);
  }
  return {
    format: PROFILES_PACK_FORMAT,
    version: record.version as number,
    exported_at: parsed.data.exported_at,
    profiles: parsed.data.profiles,
  };
}

export function packFilename(format: string, at: Date = new Date()): string {
  return `${format}-${todayIso(at)}.json`;
}

// ------------------------------------------------------------- rules export

export interface RulesExportRow {
  ruleId: number;
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryLabel: string | null;
  /**
   * Only meaningful for ruleKind = 'rename'. Set regardless of the includeRenameRules toggle —
   * this is what makes the opt-in informed consent rather than a bare checkbox: the panel shows
   * the actual text a rename would carry BEFORE the household ticks the box that lets it leave.
   */
  renameTo: string | null;
  hitCount: number;
}

function exportableRules(opts: { includeTransferRules: boolean; includeRenameRules: boolean }): MerchantRuleRecord[] {
  const rules = listRules();
  return rules.filter((rule) => {
    // Controller ruling (a): not_transfer describes this install's own account wiring and is
    // never shareable, in either direction. rename now has its own opt-in below — same shape as
    // transfer's — rather than being excluded outright.
    if (rule.ruleKind === 'not_transfer') return false;
    if (rule.ruleKind === 'rename') return opts.includeRenameRules;
    return rule.ruleKind === 'transfer' ? opts.includeTransferRules : true;
  });
}

export function previewRulesPackExport(
  opts: { includeTransferRules?: boolean; includeRenameRules?: boolean } = {},
): RulesExportRow[] {
  const all = listCategories({ includeArchived: true });
  return exportableRules({
    includeTransferRules: opts.includeTransferRules === true,
    includeRenameRules: opts.includeRenameRules === true,
  }).map((rule) => ({
    ruleId: rule.id,
    pattern: rule.pattern,
    matchType: rule.matchType,
    ruleKind: rule.ruleKind,
    categoryLabel: rule.categoryId === null ? null : categoryLabel(rule.categoryId, all),
    renameTo: rule.renameTo,
    hitCount: rule.hitCount,
  }));
}

export function exportRulesPack(
  opts: {
    includeTransferRules?: boolean;
    /** Off by default (controller ruling (a)): a rename's text may name a real person. */
    includeRenameRules?: boolean;
    excludeRuleIds?: number[];
    at?: Date;
  } = {},
): RulesPack {
  const excluded = new Set(opts.excludeRuleIds ?? []);
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const selected = exportableRules({
    includeTransferRules: opts.includeTransferRules === true,
    includeRenameRules: opts.includeRenameRules === true,
  }).filter((rule) => !excluded.has(rule.id));

  const referenced = new Map<string, PackCategory>();
  const remember = (category: CategoryRecord) => {
    const parent = category.parentId === null ? null : byId.get(category.parentId) ?? null;
    const key = `${parent?.name ?? ''}|${category.name}`;
    if (!referenced.has(key)) {
      referenced.set(key, {
        name: category.name,
        parent: parent?.name ?? null,
        is_income: category.isIncome,
        icon: category.icon,
        color: category.color,
      });
    }
    // Emit the parent too so nothing in the pack dangles.
    if (parent) remember(parent);
  };

  const rules: PackRule[] = selected.map((rule) => {
    const category = rule.categoryId === null ? null : byId.get(rule.categoryId) ?? null;
    if (category) remember(category);
    const parent = category?.parentId ? byId.get(category.parentId) ?? null : null;
    return {
      pattern: rule.pattern,
      match_type: rule.matchType,
      rule_kind: rule.ruleKind,
      category: category?.name ?? null,
      category_parent: parent?.name ?? null,
      rename_to: rule.ruleKind === 'rename' ? rule.renameTo : null,
    };
  });

  return {
    format: RULES_PACK_FORMAT,
    version: PACK_VERSION,
    exported_at: nowIso(opts.at ?? new Date()),
    categories: [...referenced.values()],
    rules,
  };
}

// ------------------------------------------------------------- rules import

/**
 * Exported (not just used internally) so src/lib/canadian-pack.ts's update-diff/apply can resolve
 * a pack rule's target category exactly the way an import does, rather than a second copy of the
 * same name/parent matching logic drifting from this one over time.
 */
export function findCategory(all: CategoryRecord[], name: string, parentName: string | null): CategoryRecord | null {
  const candidates = all.filter((row) => lower(row.name) === lower(name));
  if (candidates.length === 0) return null;
  if (parentName === null) {
    return candidates.find((row) => row.parentId === null) ?? candidates[0];
  }
  const parent = all.find((row) => lower(row.name) === lower(parentName) && row.parentId === null);
  if (!parent) return candidates.find((row) => row.parentId === null) ?? null;
  return candidates.find((row) => row.parentId === parent.id) ?? null;
}

/** Resolve the parent a rule's category should sit under, using the pack's own category list. */
export function resolveParentName(pack: RulesPack, rule: PackRule): string | null {
  if (rule.category_parent !== null) return rule.category_parent;
  if (rule.category === null) return null;
  const entry = pack.categories.find((c) => lower(c.name) === lower(rule.category as string));
  return entry?.parent ?? null;
}

export interface RulesImportConflict {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  existingCategory: string | null;
  incomingCategory: string | null;
  /** Only set when ruleKind = 'rename' — the two texts that disagree, instead of a category. */
  existingRenameTo?: string | null;
  incomingRenameTo?: string | null;
}

export interface RulesImportPlan {
  totalRules: number;
  newRules: number;
  unchanged: number;
  transferRules: number;
  /** Controller ruling (a): entries with an unsupported/unrecognised rule_kind (not_transfer, or anything this install doesn't know) — never written, always counted. rename is importable and never counted here. */
  skippedRules: number;
  conflicts: RulesImportConflict[];
  newCategories: string[];
}

export function previewRulesPackImport(input: unknown): RulesImportPlan {
  const pack = parseRulesPack(input);
  const all = listCategories({ includeArchived: true });
  const existing = listRules();

  const newCategories: string[] = [];
  const seenNew = new Set<string>();
  const noteCategory = (name: string, parentName: string | null) => {
    if (findCategory(all, name, parentName)) return;
    const key = `${lower(parentName ?? '')}|${lower(name)}`;
    if (seenNew.has(key)) return;
    seenNew.add(key);
    newCategories.push(name);
  };

  for (const category of pack.categories) {
    if (category.parent !== null) noteCategory(category.parent, null);
    noteCategory(category.name, category.parent);
  }

  let newRules = 0;
  let unchanged = 0;
  let transferRules = 0;
  let skippedRules = 0;
  const conflicts: RulesImportConflict[] = [];

  for (const rule of pack.rules) {
    if (!isImportableRuleKind(rule.rule_kind)) {
      skippedRules += 1;
      continue;
    }
    if (rule.rule_kind === 'transfer') transferRules += 1;
    // v1.21.0 (item 9) uppercases every pattern at the write choke point (upsertRuleFromCorrection),
    // so a stored row is always uppercase. A hand-authored pack (this shipped Canadian pack among
    // them) is expected to already be uppercase, but comparing against the raw incoming pattern
    // here would misreport a lowercase entry as "new" on every re-import rather than "unchanged" --
    // normalizing here keeps the preview's counts honest regardless of the pack's own casing.
    const pattern = rule.pattern.trim().toUpperCase();
    const match = existing.find(
      (row) => row.pattern === pattern && row.matchType === rule.match_type && row.ruleKind === rule.rule_kind,
    );
    if (!match) {
      newRules += 1;
      continue;
    }
    if (rule.rule_kind === 'rename') {
      if ((match.renameTo ?? null) === (rule.rename_to ?? null)) {
        unchanged += 1;
        continue;
      }
      conflicts.push({
        pattern,
        matchType: rule.match_type,
        ruleKind: rule.rule_kind,
        existingCategory: null,
        incomingCategory: null,
        existingRenameTo: match.renameTo,
        incomingRenameTo: rule.rename_to,
      });
      continue;
    }
    const incoming = rule.category === null ? null : findCategory(all, rule.category, resolveParentName(pack, rule));
    if ((match.categoryId ?? null) === (incoming?.id ?? null)) {
      unchanged += 1;
      continue;
    }
    conflicts.push({
      pattern,
      matchType: rule.match_type,
      ruleKind: rule.rule_kind,
      existingCategory: match.categoryId === null ? null : categoryLabel(match.categoryId, all),
      incomingCategory: rule.category,
    });
  }

  return { totalRules: pack.rules.length, newRules, unchanged, transferRules, skippedRules, conflicts, newCategories };
}

export interface RulesImportResult {
  rulesAdded: number;
  rulesOverwritten: number;
  rulesKept: number;
  /** Controller ruling (a): entries skipped because their rule_kind isn't importable (not_transfer, or unrecognised). rename is importable and never counted here. */
  rulesSkipped: number;
  categoriesCreated: number;
}

export function importRulesPack(
  input: unknown,
  opts: {
    onConflict?: 'keep' | 'overwrite';
    /**
     * Installable preset packs (backlog item 17). Undefined for every caller of this function
     * except src/lib/canadian-pack.ts's install path: the file-upload flow this function was
     * originally written for (RulesPackPanel, /api/packs/rules/import) shares another household's
     * export, which carries no tracked pack identity this install recognises, so it must never be
     * stamped. Only a row this call actually WRITES gets stamped -- a conflict resolved as 'keep'
     * `continue`s before reaching the write below, so the household's own kept rule is never
     * touched, exactly as backlog item 17's "a conflict-kept row is theirs" requires.
     */
    stamp?: PackProvenance | null;
  } = {},
): RulesImportResult {
  const pack = parseRulesPack(input);
  // Default stays 'keep' (required care item 4): an import must never replace a rule the
  // household wrote themselves unless they explicitly asked for 'overwrite'.
  const onConflict = opts.onConflict ?? 'keep';
  const stamp = opts.stamp ?? null;

  let all = listCategories({ includeArchived: true });
  let categoriesCreated = 0;

  const ensureCategory = (name: string, parentName: string | null, meta?: PackCategory): CategoryRecord => {
    const found = findCategory(all, name, parentName);
    if (found) return found;

    let parentId: number | null = null;
    if (parentName !== null) {
      const parent = findCategory(all, parentName, null);
      if (parent) {
        parentId = parent.id;
      } else {
        const created = ensureCategory(parentName, null);
        parentId = created.id;
      }
    }
    createCategory({
      name: name.trim(),
      parentId,
      icon: meta?.icon ?? null,
      color: meta?.color ?? null,
      isIncome: meta?.is_income ?? false,
    });
    categoriesCreated += 1;
    all = listCategories({ includeArchived: true });
    const created = findCategory(all, name, parentName);
    if (!created) throw new Error(`Failed to create category ${name}`);
    return created;
  };

  // Parents first, then children, so a child never races its parent.
  for (const category of pack.categories.filter((c) => c.parent === null)) {
    ensureCategory(category.name, null, category);
  }
  for (const category of pack.categories.filter((c) => c.parent !== null)) {
    ensureCategory(category.name, category.parent, category);
  }

  const db = getDb();
  let rulesAdded = 0;
  let rulesOverwritten = 0;
  let rulesKept = 0;
  let rulesSkipped = 0;
  // Required care item 2: an imported rename has to be APPLIED retroactively, the same way
  // saving one on the form does (upsertRenameRule runs applyRenameRules after its write). The
  // import path writes straight to the table via upsertRuleFromCorrection below, which does NOT
  // run the engine's reapply pass, so without this flag a freshly imported rename would sit in
  // merchant_rules changing nothing until the next unrelated re-run. Tracked once and applied a
  // single time after the loop, rather than per-row, so a pack with many renames pays for one
  // full pass instead of one per rule.
  let renameRulesWritten = false;

  for (const rule of pack.rules) {
    if (!isImportableRuleKind(rule.rule_kind)) {
      rulesSkipped += 1;
      continue;
    }

    // Same normalization as previewRulesPackImport, and for the same reason: the actual write
    // below (upsertRuleFromCorrection) uppercases internally regardless, but the "does this row
    // already exist" check has to agree with that or a lowercase-authored pack would report a
    // fresh "added" on every re-import instead of "kept"/"unchanged".
    const pattern = rule.pattern.trim().toUpperCase();
    const parentName = resolveParentName(pack, rule);
    const category = rule.category === null ? null : ensureCategory(rule.category, parentName);

    const existing = db
      .select({ id: merchantRules.id, categoryId: merchantRules.categoryId, renameTo: merchantRules.renameTo })
      .from(merchantRules)
      .where(
        and(
          eq(merchantRules.pattern, pattern),
          eq(merchantRules.matchType, rule.match_type),
          eq(merchantRules.ruleKind, rule.rule_kind),
        ),
      )
      .get();

    if (existing) {
      // A rename's outcome is its target text, not a category -- category_id is always NULL on
      // both sides for this kind, so comparing categoryId alone (as before rename was importable)
      // would call every re-imported rename "unchanged" even when the text actually differs.
      const sameOutcome =
        rule.rule_kind === 'rename'
          ? (existing.renameTo ?? null) === (rule.rename_to ?? null)
          : (existing.categoryId ?? null) === (category?.id ?? null);
      if (sameOutcome) continue;
      if (onConflict === 'keep') {
        rulesKept += 1;
        continue;
      }
      rulesOverwritten += 1;
    } else {
      rulesAdded += 1;
    }

    // Reuse the Task 12 upsert so the unique key stays the single source of truth.
    // actorRole: 'admin' -- pack import already resolved its own keep/overwrite conflict above
    // (this line is unreached under 'keep' when a rule exists and differs), so R4's ownership
    // check has nothing left to add here; the outcome must be unconditional either way.
    //
    // v1.13.0 ruling R4 changed what "reset the provenance columns" can mean here: the shared
    // upsert never puts created_by in its own UPDATE branch any more (that is the whole of R4 --
    // see rules.ts), so re-importing a pack over a rule a household member already set up no
    // longer erases who that was. lastModifiedBy: null still lands (createdBy: null, above,
    // flows straight into it), recording the import itself as a system action rather than a
    // personal edit -- it is only created_by, on an existing row, that this can no longer touch.
    upsertRuleFromCorrection({
      pattern,
      matchType: rule.match_type,
      ruleKind: rule.rule_kind,
      categoryId: category?.id ?? null,
      renameTo: rule.rename_to,
      createdBy: null,
      actorRole: 'admin',
      // Only a row this loop actually writes reaches this call at all (a 'keep'-resolved
      // conflict `continue`s above, before ever getting here) -- see this function's `stamp`
      // option docblock for why that is exactly what backlog item 17 needs.
      pack: stamp,
    });
    db.update(merchantRules)
      .set({ hitCount: 0, lastUsedAt: null })
      .where(
        and(
          eq(merchantRules.pattern, pattern),
          eq(merchantRules.matchType, rule.match_type),
          eq(merchantRules.ruleKind, rule.rule_kind),
        ),
      )
      .run();
    if (rule.rule_kind === 'rename') renameRulesWritten = true;
  }

  // Required care item 2, continued: apply once, after every row is written, so a pack mixing
  // renames with category/transfer rules pays for exactly one reapply pass. applyRenameRules
  // (src/lib/categorize/engine.ts) already refuses to touch a display_source = 'manual' row --
  // the household's own hand-typed rename always wins over an imported rule, with no special
  // case needed here.
  if (renameRulesWritten) applyRenameRules(undefined, buildContext());

  return { rulesAdded, rulesOverwritten, rulesKept, rulesSkipped, categoriesCreated };
}

// ------------------------------------------------------------------ profiles

export interface ProfilesExportRow {
  profileId: number;
  name: string;
  institution: string;
  isBuiltin: boolean;
}

export function previewProfilesPackExport(): ProfilesExportRow[] {
  // A profile whose stored mapping cannot be parsed (see ProfileRecord.mappingError) has
  // nothing portable to offer — it is excluded here rather than listed and then failing when
  // exportProfilesPack actually tries to serialize it.
  return listProfiles()
    .filter(hasReadableMapping)
    .map((profile) => ({
      profileId: profile.id,
      name: profile.name,
      institution: profile.institution,
      isBuiltin: profile.isBuiltin,
    }));
}

export function exportProfilesPack(opts: { profileIds?: number[]; at?: Date } = {}): ProfilesPack {
  const wanted = opts.profileIds ? new Set(opts.profileIds) : null;
  const profiles = listProfiles()
    .filter(hasReadableMapping)
    .filter((profile) => (wanted ? wanted.has(profile.id) : true))
    // name, institution and mapping only — pure column-layout knowledge.
    .map((profile) => ({ name: profile.name, institution: profile.institution, mapping: profile.mapping }));

  return {
    format: PROFILES_PACK_FORMAT,
    version: PACK_VERSION,
    exported_at: nowIso(opts.at ?? new Date()),
    profiles,
  };
}

function availableProfileName(name: string): string {
  if (getProfileByName(name) === null) return name;
  let suffix = 2;
  while (getProfileByName(`${name} (${suffix})`) !== null) suffix += 1;
  return `${name} (${suffix})`;
}

export function previewProfilesPackImport(input: unknown): { totalProfiles: number; willRename: { from: string; to: string }[] } {
  const pack = parseProfilesPack(input);
  const willRename: { from: string; to: string }[] = [];
  const taken = new Set(listProfiles().map((p) => p.name));
  for (const profile of pack.profiles) {
    if (!taken.has(profile.name)) {
      taken.add(profile.name);
      continue;
    }
    let suffix = 2;
    while (taken.has(`${profile.name} (${suffix})`)) suffix += 1;
    const renamed = `${profile.name} (${suffix})`;
    taken.add(renamed);
    willRename.push({ from: profile.name, to: renamed });
  }
  return { totalProfiles: pack.profiles.length, willRename };
}

export interface ProfilesImportResult {
  added: { name: string; renamedFrom: string | null }[];
}

export function importProfilesPack(input: unknown): ProfilesImportResult {
  const pack = parseProfilesPack(input);
  const added: { name: string; renamedFrom: string | null }[] = [];
  for (const profile of pack.profiles) {
    const name = availableProfileName(profile.name);
    // Imported profiles are always non-builtin: createProfile hard-codes isBuiltin=false.
    createProfile({ name, institution: profile.institution, mapping: profile.mapping });
    added.push({ name, renamedFrom: name === profile.name ? null : profile.name });
  }
  return { added };
}
