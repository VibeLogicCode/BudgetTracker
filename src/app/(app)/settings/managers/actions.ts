'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { archiveCategory, createCategory, listCategories, renameCategory, setCategoryTaxRelevant } from '@/lib/categories';
import { deleteRule, listRules, ruleOwnedError, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { deleteRenameRule, upsertRenameRule } from '@/lib/categorize/engine';
import {
  createProfile,
  deleteProfile,
  getProfile,
  getProfileUsage,
  setProfileActive,
  updateProfileMapping,
} from '@/lib/import/presets';
import { importMappingSchema } from '@/lib/import/mapping';
import { CATEGORY_RENDERING_ROUTES, PROFILE_RENDERING_ROUTES } from './revalidation-routes';

export interface ManagerState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/**
 * Loops over CATEGORY_RENDERING_ROUTES (src/app/(app)/settings/managers/revalidation-routes.ts)
 * on every category mutation below. See that module's doc comment for why the route list lives
 * there and not in this file: this file starts with 'use server', which may export only async
 * functions, and the route list is an array.
 */
function revalidateCategoryRoutes(): void {
  for (const route of CATEGORY_RENDERING_ROUTES) revalidatePath(route);
}

/** Same idiom as revalidateCategoryRoutes above, for the routes that render a profile list. */
function revalidateProfileRoutes(): void {
  for (const route of PROFILE_RENDERING_ROUTES) revalidatePath(route);
}

export async function createCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ name: z.string().trim().min(1, 'Name is required').max(60), parentId: z.string() })
    .safeParse({ name: formData.get('name') ?? '', parentId: String(formData.get('parentId') ?? '') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  try {
    createCategory({ name: parsed.data.name, parentId: parsed.data.parentId === '' ? null : Number(parsed.data.parentId) });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the category.' };
  }
  revalidateCategoryRoutes();
  return { message: 'Category created.' };
}

export async function renameCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const id = Number(formData.get('categoryId'));
  const name = String(formData.get('name') ?? '').trim();
  if (!Number.isInteger(id) || id <= 0 || name.length === 0) return { error: 'Invalid request.' };
  try {
    renameCategory(id, name);
  } catch (error) {
    // categories_name_parent_uq (drizzle/0000_init.sql) is a UNIQUE index on (name,
    // COALESCE(parent_id, 0)) -- renaming to a sibling's name throws a raw SQLite constraint
    // error here, which reads badly to an admin. Translate it the way item-types/actions.ts's
    // failure() does for the same class of error.
    if (error instanceof BetterSqlite3.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: 'A category with that name already exists here.' };
    }
    return { error: error instanceof Error ? error.message : 'Could not rename the category.' };
  }
  revalidateCategoryRoutes();
  return { message: 'Category renamed.' };
}

/** Archive only — transactions, rules and budgets reference categories forever. */
export async function archiveCategoryAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const id = Number(formData.get('categoryId'));
  const archived = formData.get('archived') === '1';
  if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid request.' };
  archiveCategory(id, archived);
  revalidateCategoryRoutes();
  return { message: archived ? 'Category archived.' : 'Category restored.' };
}

/**
 * Admin-only. The categories manager's Tax checkbox (spec 2026-08-22, v1.7.0, Task 15a) --
 * marks a category relevant for the tax-year report (src/lib/tax.ts). A plain HTML checkbox
 * submits its field only when checked, so an unchecked box simply leaves `taxRelevant` absent
 * from the form data; there is no hidden fallback field to keep in sync the way
 * archiveCategoryAction's toggle button needs one, because here the checkbox itself already
 * carries the admin's intended next state.
 */
export async function setCategoryTaxRelevantAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ categoryId: z.coerce.number().int().positive() }).safeParse({ categoryId: formData.get('categoryId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const target = listCategories({ includeArchived: true }).find((category) => category.id === parsed.data.categoryId);
  if (!target) return { error: 'That category no longer exists.' };

  const taxRelevant = formData.get('taxRelevant') === 'on';
  setCategoryTaxRelevant(parsed.data.categoryId, taxRelevant);
  revalidateCategoryRoutes();
  return { message: taxRelevant ? 'Category marked tax-relevant.' : 'Category no longer marked tax-relevant.' };
}

export async function updateRuleAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const admin = await requireAdmin();
  const parsed = z
    .object({
      pattern: z.string().trim().min(1).max(200),
      matchType: z.enum(['exact', 'contains']),
      // 'not_transfer' added post-brief (controller ruling c): an exact-match-only
      // override that undoes a card-payment pattern's auto-transfer-flag for one merchant.
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
      // v1.13.0 ruling R4. This action is requireAdmin()-gated, so the refusal branch below is
      // unreachable in practice (an admin actor always passes upsertRuleFromCorrection's
      // ownership check) -- the guard exists so the type stays sound if that ever changes.
      actorRole: admin.role,
    });
    if (!result.ok) return { error: ruleOwnedError(result.ownerName) };
    revalidatePath('/settings/managers');
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
  revalidatePath('/settings/managers');
  return { message: 'Rule saved.' };
}

export async function deleteRuleAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ ruleId: z.coerce.number().int().positive() }).safeParse({ ruleId: formData.get('ruleId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const target = listRules().find((rule) => rule.id === parsed.data.ruleId);
  if (!target) return { error: 'That rule no longer exists.' };

  // Deleting a rename rule must also clear the rows it set (spec section 4).
  if (target.ruleKind === 'rename') {
    const result = deleteRenameRule({ pattern: target.pattern, matchType: target.matchType });
    revalidatePath('/settings/managers');
    revalidatePath('/transactions');
    return { message: `Rename rule deleted; ${result.rowsCleared} transaction${result.rowsCleared === 1 ? '' : 's'} went back to the bank text.` };
  }

  deleteRule(target.id);
  revalidatePath('/settings/managers');
  return { message: 'Rule deleted.' };
}

export async function saveProfileMappingAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const profileId = Number(formData.get('profileId'));
  const mapping = importMappingSchema.safeParse(JSON.parse(String(formData.get('mapping') ?? '{}')));
  if (!Number.isInteger(profileId) || !mapping.success) return { error: 'Invalid mapping.' };
  const profile = getProfile(profileId);
  if (!profile) return { error: 'Unknown profile.' };
  if (profile.isBuiltin) {
    // Built-ins are shared rows and are never mutated in place — fork instead.
    createProfile({ name: `${profile.name} (custom)`, institution: profile.institution, mapping: mapping.data });
    revalidatePath('/settings/managers');
    return { message: `Built-in profiles cannot be edited. Saved a copy named "${profile.name} (custom)".` };
  }
  updateProfileMapping(profileId, mapping.data);
  revalidatePath('/settings/managers');
  return { message: 'Profile updated.' };
}

/** Admin-only. deleteProfile() itself refuses only a built-in profile;
 *  an in-use one is deleted with its references cleared, and the counts it reports are turned
 *  into an honest after-the-fact message here, the same way deleteRuleAction reports how many
 *  transactions a deleted rename rule reverted. */
export async function deleteProfileAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const profileId = Number(formData.get('profileId'));
  if (!Number.isInteger(profileId) || profileId <= 0) return { error: 'Invalid request.' };
  let result;
  try {
    result = deleteProfile(profileId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not delete that profile.' };
  }
  revalidatePath('/settings/managers');

  const parts: string[] = [];
  if (result.accountsCleared > 0) {
    parts.push(
      `${result.accountsCleared} account${result.accountsCleared === 1 ? '' : 's'} lost ${result.accountsCleared === 1 ? 'its' : 'their'} remembered mapping`,
    );
  }
  if (result.importsCleared > 0) {
    parts.push(
      `${result.importsCleared} past import${result.importsCleared === 1 ? '' : 's'} lost the record of which mapping was used`,
    );
  }
  return { message: parts.length > 0 ? `Profile deleted; ${parts.join(' and ')}.` : 'Profile deleted.' };
}

/**
 * Admin-only. Deactivation/reactivation share this one action (spec 2026-08-22 v1.6.0,
 * MUST-4.1-4.4). Unlike deleteProfileAction above, this NEVER refuses a built-in -- hiding an
 * unused shared bank preset from the picker is the entire reason is_active exists. It also
 * never clears accounts.importProfileId or imports.profileId the way deleteProfileAction does:
 * getProfileUsage() is called here purely as a READ, to report an honest pinned-account count
 * in the confirmation message, never to justify touching those rows. Deactivation must stay
 * fully reversible, which is exactly what makes it safe to allow on a built-in in the first
 * place.
 */
export async function setProfileActiveAction(_prev: ManagerState, formData: FormData): Promise<ManagerState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const profileId = Number(formData.get('profileId'));
  const isActive = formData.get('isActive') === '1';
  if (!Number.isInteger(profileId) || profileId <= 0) return { error: 'Invalid request.' };
  const profile = getProfile(profileId);
  if (!profile) return { error: 'Unknown profile.' };

  setProfileActive(profileId, isActive);
  revalidateProfileRoutes();

  if (isActive) {
    return { message: `"${profile.name}" reactivated. Any account pinned to it uses it again immediately.` };
  }
  const usage = getProfileUsage(profileId);
  const pinnedNote =
    usage.accounts > 0
      ? ` ${usage.accounts} account${usage.accounts === 1 ? '' : 's'} pinned to it will be treated as unpinned until it is reactivated.`
      : '';
  return { message: `"${profile.name}" deactivated and off the import picker.${pinnedNote}` };
}
