'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { listCategories } from '@/lib/categories';
import {
  applyCanadianPackUpdate,
  installCanadianPack,
  removeCanadianPack,
} from '@/lib/canadian-pack';
import {
  applyRuleNow,
  clearRuleFromTransactions,
  deleteRenameRule,
  deleteRules,
  eligibleForRerun,
  previewRerun,
  rerunEngine,
  ruleClearIds,
  setRuleDisabled,
  setRulesDisabled,
  upsertRenameRule,
  type RuleScope,
} from '@/lib/categorize/engine';
import {
  CATEGORY_RULE_NEEDS_CATEGORY_ERROR,
  deleteRule,
  listRules,
  matchTypeAllowedForKind,
  ruleOwnedError,
  upsertRuleFromCorrection,
  WORD_MATCH_KIND_ERROR,
  type MerchantRuleRecord,
  type RuleKind,
} from '@/lib/categorize/rules';
import { applyPackOriginCarry, planPackOriginCarry } from '@/lib/packs';

export interface RuleActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/**
 * v1.21.0 (item 10). This route replaces the flat "Merchant rules" card that used to live on
 * /settings/managers -- moved here rather than left as a second surface for the same data.
 * saveRuleAction/deleteRuleAction below are the same bodies that card's updateRuleAction/
 * deleteRuleAction used to run (src/app/(app)/settings/managers/actions.ts, removed there),
 * unchanged in substance; everything past them (bulk actions, disable, Apply now, Re-run) is new.
 */
export async function saveRuleAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const admin = await requireAdmin();
  const parsed = z
    .object({
      pattern: z.string().trim().min(1).max(200),
      matchType: z.enum(['exact', 'contains', 'word']),
      ruleKind: z.enum(['category', 'transfer', 'rename', 'not_transfer']),
      /**
       * v1.31.0 (review finding R-13, P3). Was `z.string()`, and the value was then handed to a
       * bare `Number(...)`. '' means "(none)" and is normalized to null before zod sees it
       * (blankToNull, the same '' -> null step fromRuleId uses); anything else must be a positive
       * integer, so 'abc' becomes 'Invalid rule.' here rather than `NaN` reaching a column with
       * `foreign_keys = ON` behind it. EXISTENCE and ARCHIVED-ness are checked below, in words --
       * see the block after the parse.
       */
      categoryId: z.coerce.number().int().positive().nullable(),
      renameTo: z.string().trim().max(200),
      /**
       * v1.25.0 (item 18). The row the dialog was OPENED on, when it was opened on one -- '' for
       * "New merchant rule". This action is, and stays, an upsert on (pattern, match_type,
       * rule_kind) with no row id in its write: nothing here selects a row to update, and the form
       * says as much ("Changing the pattern, match or kind creates a separate rule rather than
       * renaming this one in place"). This field is not a step toward changing that -- it answers a
       * narrower question the write itself cannot: if this save creates a NEW row because the key
       * moved, what did the person think they were editing? That is the only way a rule the pack
       * installed can pass its origin on to the household's replacement, which is what stops the
       * next pack update offering the original back as a fresh addition. Optional, and a stale or
       * bogus id degrades to exactly the pre-v1.25.0 behaviour rather than an error -- see
       * planPackOriginCarry (src/lib/packs.ts), which returns null for every case it cannot vouch for.
       */
      fromRuleId: z.coerce.number().int().positive().nullable(),
    })
    .safeParse({
      pattern: formData.get('pattern') ?? '',
      matchType: formData.get('matchType') ?? 'exact',
      ruleKind: formData.get('ruleKind') ?? 'category',
      categoryId: blankToNull(formData.get('categoryId')),
      renameTo: String(formData.get('renameTo') ?? ''),
      fromRuleId: blankToNull(formData.get('fromRuleId')),
    });
  if (!parsed.success) return { error: 'Invalid rule.' };

  // v1.25.0 (item 16). Checked here rather than folded into the zod object above so the person
  // gets the actual sentence instead of this action's generic 'Invalid rule.' -- the whole point
  // of the restriction is that it needs explaining, and "invalid" explains nothing. The form's
  // two selects are independent (plain HTML, no cross-field JS), so this combination is genuinely
  // reachable by picking "Whole word" and then "transfer". See WORD_MATCH_KINDS' docblock for why
  // it is refused rather than supported.
  if (!matchTypeAllowedForKind(parsed.data.matchType, parsed.data.ruleKind)) {
    return { error: WORD_MATCH_KIND_ERROR };
  }

  // v1.25.0 (item 18). Decided BEFORE either write below, because the answer depends on whether a
  // row already exists under the key this save is about to write, and the upsert is precisely what
  // makes that unanswerable afterward. See planPackOriginCarry (src/lib/packs.ts) for every case it
  // declines -- among them "a row is already there", which is what keeps a rule the household wrote
  // themselves from ever being handed a pack origin it did not come from.
  const originCarry = planPackOriginCarry({
    fromRuleId: parsed.data.fromRuleId,
    pattern: parsed.data.pattern,
    matchType: parsed.data.matchType,
    ruleKind: parsed.data.ruleKind,
  });
  /** Called only on a write that actually happened -- never after a refusal, which wrote no row. */
  const carryOrigin = () => {
    if (originCarry === null) return;
    applyPackOriginCarry({
      pattern: parsed.data.pattern,
      matchType: parsed.data.matchType,
      ruleKind: parsed.data.ruleKind,
      originKey: originCarry,
    });
  };

  // Rename rules go through the engine so the change is applied retroactively.
  if (parsed.data.ruleKind === 'rename') {
    if (parsed.data.renameTo.length === 0) return { error: 'A rename rule needs a display name.' };
    const result = upsertRenameRule({
      pattern: parsed.data.pattern,
      matchType: parsed.data.matchType,
      renameTo: parsed.data.renameTo,
      userId: admin.id,
      actorRole: admin.role,
    });
    if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
    carryOrigin();
    revalidatePath('/settings/merchant-rules');
    revalidatePath('/transactions');
    return { message: `Rename rule saved and applied to ${result.rowsUpdated} transaction${result.rowsUpdated === 1 ? '' : 's'}.` };
  }

  // v1.31.0 R-02 (P2). The Category select offers "(none)" for every kind, because transfer,
  // not_transfer and rename rules genuinely have none -- so "category" plus an untouched select
  // was accepted, and produced a rule that WON its merchant in matchRule and then had nothing to
  // file it as: the merchant silently stopped being categorised by anything, including by the
  // shorter rule that would have. Refused here in words rather than folded into the zod object
  // above, for the same reason as the WORD_MATCH_KIND_ERROR check: 'Invalid rule.' explains
  // nothing, and the whole failure was that nothing was explained. matchRule skips such a row too
  // (ruleOutcomeMissing, src/lib/categorize/rules.ts) -- this is the boundary that stops one being
  // saved in the first place.
  const categoryId =
    parsed.data.ruleKind === 'transfer' || parsed.data.ruleKind === 'not_transfer' ? null : parsed.data.categoryId;
  if (parsed.data.ruleKind === 'category' && categoryId === null) {
    return { error: CATEGORY_RULE_NEEDS_CATEGORY_ERROR };
  }

  // v1.31.0 (review finding R-13, P3). The id is checked to EXIST and to be UNARCHIVED before it
  // is written, and refused with a sentence.
  //
  // Nothing checked either before. The picker the form renders drops archived rows
  // (categoryTree/category-order.ts), so the happy path was fine -- but the row it rendered goes
  // stale the moment somebody archives that category in another tab, and a POST can name any
  // number at all. A nonexistent id then reached a column with `foreign_keys = ON` behind it
  // (src/db/client.ts), so SQLite raised a constraint error, nothing caught it, and the person
  // got a 500 from a form submission -- the same "the panel simply did nothing" failure shape
  // R-04 fixed on the import route, arriving through the rules form instead.
  //
  // ARCHIVED is refused rather than tolerated because archiving is how this app retires a
  // category -- there is no delete (archiveCategory, src/lib/categories.ts: "Archive only --
  // transactions, rules and budgets reference categories forever"). A rule that files future
  // statements into a retired category files them where no spend report shows them, which is the
  // R-02 defect's own signature: a rule that looks saved and quietly stops money being visible.
  if (categoryId !== null) {
    const category = listCategories({ includeArchived: true }).find((row) => row.id === categoryId);
    if (!category) return { error: 'That category no longer exists. Pick another one.' };
    if (category.isArchived) {
      return { error: `"${category.name}" is archived, so a rule cannot file anything into it. Un-archive it first, or pick another category.` };
    }
  }

  const upserted = upsertRuleFromCorrection({
    pattern: parsed.data.pattern,
    matchType: parsed.data.matchType,
    ruleKind: parsed.data.ruleKind,
    categoryId,
    createdBy: admin.id,
    actorRole: admin.role,
  });
  if (!upserted.ok) return { error: ruleOwnedError(upserted.ownerName) };
  carryOrigin();
  revalidatePath('/settings/merchant-rules');
  return { message: 'Rule saved.' };
}

function findRuleOr(id: number): MerchantRuleRecord | null {
  return listRules().find((rule) => rule.id === id) ?? null;
}

export async function deleteRuleAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ ruleId: z.coerce.number().int().positive() }).safeParse({ ruleId: formData.get('ruleId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const target = findRuleOr(parsed.data.ruleId);
  if (!target) return { error: 'That rule no longer exists.' };

  if (target.ruleKind === 'rename') {
    const result = deleteRenameRule({ pattern: target.pattern, matchType: target.matchType });
    revalidatePath('/settings/merchant-rules');
    revalidatePath('/transactions');
    return { message: `Rename rule deleted; ${result.rowsCleared} transaction${result.rowsCleared === 1 ? '' : 's'} went back to the bank text.` };
  }

  deleteRule(target.id);
  revalidatePath('/settings/merchant-rules');
  return { message: 'Rule deleted.' };
}

/**
 * An absent or empty form field as null, for every zod field on this route that is genuinely
 * optional. Hoisted out of optionalDate below (v1.25.0, item 18) once saveRuleAction's fromRuleId
 * needed the same '' -> null step for something that is not a date at all -- one definition of
 * "blank means nothing was submitted", rather than a second copy that could drift from it.
 */
function blankToNull(value: FormDataEntryValue | string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? null : text;
}

/**
 * v1.24.0. An `<input type="date">` submits '' when empty and a real `YYYY-MM-DD` otherwise, so
 * '' is normalized to null (unbounded) BEFORE zod sees it -- otherwise every "All time" submission
 * would fail the format check it is not supposed to be subject to.
 */
function optionalDate(value: FormDataEntryValue | string | null | undefined): string | null {
  return blankToNull(value);
}

/**
 * Both ends optional; both, when present, a real ISO date. `from > to` is REFUSED with a sentence
 * rather than accepted as an empty range: an empty range silently clears/re-runs nothing, so a
 * transposed pair would look exactly like "there was nothing to do" -- which is the one answer a
 * person cannot tell from a bug. ISO `YYYY-MM-DD` strings compare correctly as strings, so this
 * needs no Date parsing (and must not do any: it would drag a timezone into a pure text
 * comparison -- see src/lib/dates.ts on why this codebase keeps dates as ISO text).
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const scopeSchema = z
  .object({
    from: z.string().regex(ISO_DATE, 'Use a YYYY-MM-DD date.').nullable(),
    to: z.string().regex(ISO_DATE, 'Use a YYYY-MM-DD date.').nullable(),
  })
  .refine((scope) => scope.from === null || scope.to === null || scope.from <= scope.to, {
    message: 'That date range ends before it starts -- swap the From and To dates.',
  });

function parseScope(from: unknown, to: unknown): { ok: true; scope: RuleScope } | { ok: false; error: string } {
  const parsed = scopeSchema.safeParse({ from: optionalDate(from as string | null), to: optionalDate(to as string | null) });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid date range.' };
  return { ok: true, scope: parsed.data };
}

/** "All time" or "between X and Y", for a result message that repeats back what was actually done. */
function scopeWording(scope: RuleScope): string {
  if (scope.from && scope.to) return ` between ${scope.from} and ${scope.to}`;
  if (scope.from) return ` dated ${scope.from} or later`;
  if (scope.to) return ` dated ${scope.to} or earlier`;
  return '';
}

const plural = (n: number) => (n === 1 ? '' : 's');

/**
 * v1.24.0. The count the "Delete rule and clear it from transactions" dialog states, recomputed
 * every time the date range changes. Plain RPC, not form-bound, exactly like previewRerunAllAction
 * below -- it writes nothing and is called from client code on every range edit.
 *
 * Reads ruleClearIds, NOT ruleImpactCounts: for a transfer rule those two point in opposite
 * directions (see ruleClearIds' own docblock -- "affects" is the rows the rule would still flag,
 * clearing touches the rows it already flagged), and the number in the dialog has to be the one
 * the button underneath it will actually honour.
 *
 * `kind` comes back so the dialog can pick its wording from the server's own view of the rule
 * rather than only from the row it was rendered with; `null` means the rule is already gone. An
 * unusable range (transposed, or a malformed date the date input cannot actually produce) reports
 * 0 with the reason in `error` -- the client refuses to submit while that is set, and
 * deleteRuleAndClearAction refuses again server-side, so nothing rests on this preview alone.
 */
export async function previewRuleClearAction(
  ruleId: number,
  from: string | null,
  to: string | null,
): Promise<{ affected: number; kind: RuleKind | null; error?: string }> {
  await requireAdmin();
  const target = findRuleOr(ruleId);
  if (!target) return { affected: 0, kind: null, error: 'That rule no longer exists.' };
  const scope = parseScope(from, to);
  if (!scope.ok) return { affected: 0, kind: target.ruleKind, error: scope.error };
  // v1.31.0 (R-08): the scope is passed through UNCHANGED. "A rename revert ignores the date
  // range" is the engine's decision and the engine enforces it in both directions -- ruleClearIds
  // drops the scope for a rename, and clearRuleFromTransactions delegates that kind to
  // deleteRenameRule, which never had a range to begin with. This action used to restate it, as
  // did deleteRuleAndClearAction below, so one decision was written in four places and a future
  // "bounded rename revert is supported now" change would have had to find all four. The
  // preview still counts exactly what the write will touch, because both read the same authority.
  return { affected: ruleClearIds(target.id, scope.scope).length, kind: target.ruleKind };
}

/**
 * v1.24.0, the owner's ask in full: "delete rule and un-apply from transactions... showing user
 * this cannot be undone, this will update transactions, all date ranges or user chooses".
 *
 * CLEAR FIRST, DELETE SECOND, and the order is load-bearing: attribution is derived, never stored
 * (no rule id lives on a transaction -- see ruleImpactIds), so the rule must still exist for
 * categorizeTransaction to resolve `matchedRuleId` to it. Deleting first would leave the rows it
 * set completely unattributable and clear nothing at all.
 *
 * A rename rule takes today's path unchanged and ignores the dates: clearRuleFromTransactions
 * delegates to deleteRenameRule, which deletes the rule and then reapplies the rename pass over
 * every row -- so the deleteRule below is a no-op for that kind (a delete of an id that is already
 * gone), kept unconditional rather than branched so no future kind can slip through undeleted.
 */
export async function deleteRuleAndClearAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ ruleId: z.coerce.number().int().positive() }).safeParse({ ruleId: formData.get('ruleId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  const scope = parseScope(formData.get('from'), formData.get('to'));
  if (!scope.ok) return { error: scope.error };

  const target = findRuleOr(parsed.data.ruleId);
  if (!target) return { error: 'That rule no longer exists.' };
  if (target.ruleKind === 'not_transfer') {
    // Never offered by the UI; refused here so a stale form or a second session cannot reach it.
    // Re-flagging rows AS transfers would move money out of every report -- see
    // clearRuleFromTransactions' docblock. Delete-only for this kind.
    return { error: 'A "not a transfer" rule can only be deleted -- clearing it would re-flag those transactions as transfers.' };
  }

  // R-08: passed through unchanged, for the reason previewRuleClearAction states -- the engine
  // is the one authority on a rename ignoring the range.
  const { rowsCleared } = clearRuleFromTransactions({ ruleId: target.id, scope: scope.scope });
  deleteRule(target.id);
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');

  if (target.ruleKind === 'rename') {
    return { message: `Rename rule deleted; ${rowsCleared} transaction${plural(rowsCleared)} went back to the bank text.` };
  }
  // R-08 leaves the WORDING branch exactly where it was: the rename message is returned above
  // and never reaches this line, so from here `scope.scope` and the old `effective` are the same
  // value. What the sentence says about a range is a message concern; what the write does with
  // one is the engine's.
  const where = scopeWording(scope.scope);
  if (rowsCleared === 0) return { message: `Rule deleted. No transaction${where} needed clearing.` };
  if (target.ruleKind === 'transfer') {
    return { message: `Rule deleted and the transfer flag cleared on ${rowsCleared} transaction${plural(rowsCleared)}${where}.` };
  }
  return {
    message: `Rule deleted and cleared from ${rowsCleared} transaction${plural(rowsCleared)}${where} -- ${rowsCleared === 1 ? 'it is' : 'they are'} back in Needs review.`,
  };
}

const idList = z
  .string()
  .transform((value) => value.split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0));

/**
 * v1.21.0 (item 10): "bulk delete must state its real consequence... how many TRANSACTIONS
 * change, not just how many rules". The client already has ruleImpactCounts for every visible
 * row (it is what the "Affects" column shows), so the confirm text is composed there, before
 * this action ever runs; this action just does the deletes and reports the REAL total
 * afterward, the same honesty deleteRuleAction already gives a single rename delete.
 */
export async function bulkDeleteRulesAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = idList.safeParse(formData.get('ids') ?? '');
  if (!parsed.success || parsed.data.length === 0) return { error: 'No rules selected.' };

  // v1.31.0 (R-10): ONE call, ONE retroactive rename pass. This loop used to call
  // deleteRenameRule per selected rule, and each of those runs a full pass over every non-manual
  // transaction -- so deleting fourteen preset renames after a pack install read the whole table
  // twenty-eight times. deleteRules (src/lib/categorize/engine.ts) is where that batching now
  // lives, beside the pass it batches and beside importRulesPack's identical argument for doing
  // it; its docblock carries the measured before/after and the reason its single count is a
  // truer number than the sum this action used to build.
  const { deleted, rowsCleared: transactionsReverted } = deleteRules(parsed.data);

  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  if (deleted === 0) return { error: 'None of the selected rules could be found -- they may already be gone.' };
  const revertedNote = transactionsReverted > 0 ? ` ${transactionsReverted} transaction${transactionsReverted === 1 ? '' : 's'} went back to the bank text.` : '';
  return { message: `Deleted ${deleted} rule${deleted === 1 ? '' : 's'}.${revertedNote}` };
}

/**
 * v1.21.0 (item 11): "disable, not delete". Single-row toggle; a rename rule's rows revert (or
 * restore) as part of the same call -- see setRuleDisabled's own docblock.
 */
export async function setRuleDisabledAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ ruleId: z.coerce.number().int().positive(), disabled: z.enum(['0', '1']) })
    .safeParse({ ruleId: formData.get('ruleId'), disabled: formData.get('disabled') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const result = setRuleDisabled({ ruleId: parsed.data.ruleId, disabled: parsed.data.disabled === '1' });
  revalidatePath('/settings/merchant-rules');
  if (parsed.data.disabled === '1') {
    revalidatePath('/transactions');
    const revertedNote = result.rowsChanged > 0 ? ` ${result.rowsChanged} transaction${result.rowsChanged === 1 ? '' : 's'} went back to the bank text.` : '';
    return { message: `Rule disabled.${revertedNote}` };
  }
  revalidatePath('/transactions');
  const restoredNote = result.rowsChanged > 0 ? ` ${result.rowsChanged} transaction${result.rowsChanged === 1 ? '' : 's'} restored.` : '';
  return { message: `Rule enabled.${restoredNote}` };
}

export async function bulkSetDisabledAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ ids: idList, disabled: z.enum(['0', '1']) })
    .safeParse({ ids: formData.get('ids') ?? '', disabled: formData.get('disabled') });
  if (!parsed.success || parsed.data.ids.length === 0) return { error: 'No rules selected.' };

  // R-10, the same fix as bulkDeleteRulesAction above: one pass for the whole selection instead
  // of one per rename rule in it. See setRulesDisabled's docblock.
  const { touched, rowsChanged } = setRulesDisabled({ ruleIds: parsed.data.ids, disabled: parsed.data.disabled === '1' });
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  const verb = parsed.data.disabled === '1' ? 'Disabled' : 'Enabled';
  const note = rowsChanged > 0 ? ` ${rowsChanged} transaction${rowsChanged === 1 ? '' : 's'} affected.` : '';
  return { message: `${verb} ${touched} rule${touched === 1 ? '' : 's'}.${note}` };
}

/**
 * Per-rule "Apply now" (item 11). No separate preview round-trip -- unlike the household-wide
 * re-run below, this is already scoped to one rule's own matches and can never touch a manually
 * decided row (eligibleForRuleReapply/ELIGIBLE), so the brief's own wording calls it "scoped,
 * understandable, safe" without asking for the heavier confirm the global action gets. The row
 * already shows ruleImpactCounts' own live figure (item 12) right on its "Affects" column and in
 * this menu item's own label, which doubles as the "before" figure; this action's result message
 * gives the real "after" count once it has actually run.
 */
export async function applyRuleNowAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ ruleId: z.coerce.number().int().positive() }).safeParse({ ruleId: formData.get('ruleId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const result = applyRuleNow(parsed.data.ruleId);
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  if (result.processed === 0) return { message: 'Nothing to apply -- no eligible transaction currently matches this rule.' };
  return { message: `Applied: ${result.changed} of ${result.processed} eligible transaction${result.processed === 1 ? '' : 's'} changed.` };
}

/**
 * v1.21.0 (item 11): "report a count before and after... the difference between a useful
 * button and a frightening one." The household-wide action gets the full two-step treatment
 * (preview, then confirm) precisely because it is the broad one -- eligibleForRerun() has no
 * per-rule scope to keep it narrow the way Apply now's does. Not bound to a <form> the way the
 * mutating actions above are -- called directly from client code as a plain RPC (any exported
 * async function in a 'use server' file is callable that way, form or no form).
 *
 * v1.24.0: takes an optional date range ("so when we click re-run it should open a dialogue saying
 * re-runs rules for all or specific date range"). Both parameters default to null, so every
 * existing caller and the unbounded case are unchanged. An unusable range reports zeros -- the
 * dialog refuses to submit while its own check says the range is backwards, and rerunAllAction
 * refuses again with a sentence, so nothing rests on this preview alone.
 */
export async function previewRerunAllAction(
  from: string | null = null,
  to: string | null = null,
): Promise<{ eligible: number; wouldChange: number }> {
  await requireAdmin();
  const scope = parseScope(from, to);
  if (!scope.ok) return { eligible: 0, wouldChange: 0 };
  return previewRerun(eligibleForRerun(scope.scope));
}

export async function rerunAllAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const scope = parseScope(formData.get('from'), formData.get('to'));
  if (!scope.ok) return { error: scope.error };

  const result = rerunEngine(scope.scope);
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  const where = scopeWording(scope.scope);
  if (result.processed === 0) return { message: `Nothing to re-run -- no eligible transaction${where} is waiting.` };
  return {
    message: `Re-ran the rules${where}: ${result.changed} of ${result.processed} eligible transaction${plural(result.processed)} changed.`,
  };
}

/**
 * Backlog item 17 ("an imported pack cannot be un-imported"): install the bundled Canadian
 * merchant pack. The page's own disclaimer (CanadianPackPanel) is what makes this an INFORMED
 * click -- rule counts, the "renames apply immediately, categories only affect future imports"
 * distinction, and the FORTIS/ATCO caveat are all shown BEFORE this form ever submits. Always
 * 'keep' on conflict (installCanadianPack's own default) -- a household rule with a matching
 * pattern is never touched or stamped.
 */
export async function installCanadianPackAction(_prev: RuleActionState, _formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const result = installCanadianPack();
  revalidatePath('/settings/merchant-rules');
  const keptNote =
    result.rulesKept > 0
      ? ` ${result.rulesKept} pattern${result.rulesKept === 1 ? '' : 's'} you already had ${result.rulesKept === 1 ? 'was' : 'were'} left as-is.`
      : '';
  // v1.31.0 M-3: a preset rule the household already has AND has switched off takes the pack
  // importer's "same outcome, nothing to write" path. Leaving it off is correct -- switching a
  // rule off is a decision -- but this message used to report the install as a plain success with
  // no hint that one of its rules is inert, which is a true sentence that leaves a false
  // impression. The inert entries are named for the same reason the skipped ones are.
  const inert = result.rulesInertDetail.map((entry) => entry.pattern);
  const inertNote =
    inert.length > 0
      ? ` ${inert.length} rule${inert.length === 1 ? '' : 's'} you already had ${inert.length === 1 ? 'is' : 'are'} switched off and stayed off: ${inert.join(', ')}.`
      : '';
  return { message: `Installed ${result.rulesAdded} preset rule${result.rulesAdded === 1 ? '' : 's'}.${keptNote}${inertNote}` };
}

/**
 * Deletes only the currently-stamped rows (installedCanadianPackRows() -- a row the household
 * edited since install already lost its stamp, so this can never touch it). Reports how many
 * transactions revert, the same honesty bulkDeleteRulesAction already gives an ordinary bulk
 * delete of rename rules.
 */
export async function removeCanadianPackAction(_prev: RuleActionState, _formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const result = removeCanadianPack();
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  const revertedNote =
    result.transactionsReverted > 0
      ? ` ${result.transactionsReverted} transaction${result.transactionsReverted === 1 ? '' : 's'} went back to the bank's wording.`
      : '';
  return { message: `Removed ${result.deleted} preset rule${result.deleted === 1 ? '' : 's'}.${revertedNote}` };
}

/**
 * Backlog item 17 / Part 4 (version awareness): applies a reviewed diff, never a bare version
 * bump -- this action only ever runs after the page has shown canadianPackUpdateDiff() and an
 * admin pressed a button naming the target version (see applyCanadianPackUpdate's own docblock
 * for why nothing in this codebase ever calls it any other way). `deleteRemoved` defaults to NOT
 * deleting: a rule the new pack no longer defines is kept, just no longer tracked as a preset,
 * unless the admin explicitly ticked the box offering its removal.
 */
export async function applyCanadianPackUpdateAction(_prev: RuleActionState, formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const deleteRemoved = formData.get('deleteRemoved') === '1';
  const result = applyCanadianPackUpdate({ deleteRemoved });
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');

  const bits = [`${result.added} added`, `${result.changed} updated`, `${result.unchanged} unchanged`];
  if (result.skippedEdited > 0) bits.push(`${result.skippedEdited} left alone (you had edited them)`);
  // v1.25.0 (item 18). Reported here as well as in the review dialog, and separately from
  // skippedEdited, because the two are different facts about what this run just did: one rule was
  // present and left untouched, the other was NOT ADDED at all. Rolling them together would make
  // "N added" the only line an admin could check the outcome against, and that number deliberately
  // excludes these.
  if (result.editedAway > 0) bits.push(`${result.editedAway} not added back (you have your own version)`);
  if (result.removedDeleted > 0) bits.push(`${result.removedDeleted} deleted (no longer in the pack)`);
  else if (result.removedOffered > 0) bits.push(`${result.removedOffered} no longer in the pack (kept, un-tracked)`);
  const revertedNote =
    result.transactionsReverted > 0
      ? ` ${result.transactionsReverted} transaction${result.transactionsReverted === 1 ? '' : 's'} went back to the bank's wording.`
      : '';
  return { message: `Updated preset rules to v${result.toVersion}: ${bits.join(', ')}.${revertedNote}` };
}
