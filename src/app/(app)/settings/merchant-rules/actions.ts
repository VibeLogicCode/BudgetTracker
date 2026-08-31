'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import {
  applyCanadianPackUpdate,
  installCanadianPack,
  removeCanadianPack,
} from '@/lib/canadian-pack';
import {
  applyRuleNow,
  deleteRenameRule,
  eligibleForRerun,
  previewRerun,
  rerunEngine,
  setRuleDisabled,
  upsertRenameRule,
} from '@/lib/categorize/engine';
import {
  deleteRule,
  listRules,
  ruleOwnedError,
  upsertRuleFromCorrection,
  type MerchantRuleRecord,
} from '@/lib/categorize/rules';

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
      matchType: z.enum(['exact', 'contains']),
      ruleKind: z.enum(['category', 'transfer', 'rename', 'not_transfer']),
      categoryId: z.string(),
      renameTo: z.string().trim().max(200),
    })
    .safeParse({
      pattern: formData.get('pattern') ?? '',
      matchType: formData.get('matchType') ?? 'exact',
      ruleKind: formData.get('ruleKind') ?? 'category',
      categoryId: String(formData.get('categoryId') ?? ''),
      renameTo: String(formData.get('renameTo') ?? ''),
    });
  if (!parsed.success) return { error: 'Invalid rule.' };

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
    revalidatePath('/settings/merchant-rules');
    revalidatePath('/transactions');
    return { message: `Rename rule saved and applied to ${result.rowsUpdated} transaction${result.rowsUpdated === 1 ? '' : 's'}.` };
  }

  const upserted = upsertRuleFromCorrection({
    pattern: parsed.data.pattern,
    matchType: parsed.data.matchType,
    ruleKind: parsed.data.ruleKind,
    categoryId:
      parsed.data.ruleKind === 'transfer' || parsed.data.ruleKind === 'not_transfer' || parsed.data.categoryId === ''
        ? null
        : Number(parsed.data.categoryId),
    createdBy: admin.id,
    actorRole: admin.role,
  });
  if (!upserted.ok) return { error: ruleOwnedError(upserted.ownerName) };
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

  let deleted = 0;
  let transactionsReverted = 0;
  for (const id of parsed.data) {
    const target = findRuleOr(id);
    if (!target) continue;
    if (target.ruleKind === 'rename') {
      const result = deleteRenameRule({ pattern: target.pattern, matchType: target.matchType });
      transactionsReverted += result.rowsCleared;
    } else {
      deleteRule(target.id);
    }
    deleted += 1;
  }

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

  let touched = 0;
  let rowsChanged = 0;
  for (const id of parsed.data.ids) {
    const result = setRuleDisabled({ ruleId: id, disabled: parsed.data.disabled === '1' });
    touched += 1;
    rowsChanged += result.rowsChanged;
  }
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
 */
export async function previewRerunAllAction(): Promise<{ eligible: number; wouldChange: number }> {
  await requireAdmin();
  return previewRerun(eligibleForRerun());
}

export async function rerunAllAction(_prev: RuleActionState, _formData: FormData): Promise<RuleActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const result = rerunEngine();
  revalidatePath('/settings/merchant-rules');
  revalidatePath('/transactions');
  if (result.processed === 0) return { message: 'Nothing to re-run -- no eligible transaction is waiting.' };
  return { message: `Re-ran the rules: ${result.changed} of ${result.processed} eligible transaction${result.processed === 1 ? '' : 's'} changed.` };
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
  return { message: `Installed ${result.rulesAdded} preset rule${result.rulesAdded === 1 ? '' : 's'}.${keptNote}` };
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
  if (result.removedDeleted > 0) bits.push(`${result.removedDeleted} deleted (no longer in the pack)`);
  else if (result.removedOffered > 0) bits.push(`${result.removedOffered} no longer in the pack (kept, un-tracked)`);
  const revertedNote =
    result.transactionsReverted > 0
      ? ` ${result.transactionsReverted} transaction${result.transactionsReverted === 1 ? '' : 's'} went back to the bank's wording.`
      : '';
  return { message: `Updated preset rules to v${result.toVersion}: ${bits.join(', ')}.${revertedNote}` };
}
