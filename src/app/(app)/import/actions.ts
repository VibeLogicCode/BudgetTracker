'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { getAccount } from '@/lib/accounts';
import { findUserById } from '@/lib/auth/users';
import { deleteAccountCardPerson, upsertAccountCardPerson } from '@/lib/import/card-people';
import { importMappingSchema } from '@/lib/import/mapping';
import { createProfile, forkProfileIfBuiltin, getProfile, getProfileByName, mappingsEqual, setAccountProfile } from '@/lib/import/presets';
import { deleteStagedFile } from '@/lib/import/staging';

export interface WizardState {
  error?: string;
  message?: string;
}

export interface CardPersonState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
// Controller ruling (Task 14 fix round 1): this page is gated for a self viewer, but the
// action file underneath it never was -- a self viewer could POST directly. Same refusal
// wording review/import/settings already use.
const NOT_AVAILABLE_ERROR = 'Import is not available on this account.';

const saveSchema = z.object({
  name: z.string().trim().min(1, 'Give the profile a name').max(80),
  institution: z.string().trim().min(1, 'Which bank is this?').max(80),
  mapping: importMappingSchema,
  stagingId: z.string().uuid().optional(),
});

export async function saveWizardProfileAction(_prev: WizardState, formData: FormData): Promise<WizardState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: NOT_AVAILABLE_ERROR };
  const parsed = saveSchema.safeParse({
    name: formData.get('name') ?? '',
    institution: formData.get('institution') ?? '',
    mapping: JSON.parse(String(formData.get('mapping') ?? '{}')),
    stagingId: (formData.get('stagingId') as string | null) ?? undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the mapping.' };
  if (getProfileByName(parsed.data.name)) return { error: `A profile named "${parsed.data.name}" already exists.` };

  createProfile({ name: parsed.data.name, institution: parsed.data.institution, mapping: parsed.data.mapping });
  if (parsed.data.stagingId) deleteStagedFile(parsed.data.stagingId);
  revalidatePath('/import');
  return { message: `Saved "${parsed.data.name}". Pick it on the Import page and upload the real file.` };
}

export interface SaveMappingState {
  error?: string;
  message?: string;
}

const saveMappingSchema = z.object({
  profileId: z.coerce.number().int().positive(),
  accountId: z.coerce.number().int().positive(),
  // The variable slot in presets.ts's copy-on-write naming template (`<profile> (<account>)`,
  // forkProfileIfBuiltin) -- editable in the preview panel so a household can name the fork
  // something other than the literal account name, but it still only ever fills this one slot;
  // the surrounding "<profile> (" / ")" is never something this form can rewrite.
  accountName: z.string().trim().min(1, 'Give the forked profile a name').max(80),
  mapping: importMappingSchema,
});

/**
 * Lane 5 (2026-08-30 savings-targets plan, ruling T8/T9/T10). Before this action existed, the
 * ONLY place forkProfileIfBuiltin ever ran was inside a SUCCESSFUL commitStagedImport
 * (src/lib/import/flow.ts:75-83) -- so a file whose preview reported 0 rows and 117 errors
 * could never save the corrected mapping that would make it parse; the fix a person most needed
 * to keep was exactly the one the app threw away. This action is the earlier door: it persists
 * the mapping and repoints the account WITHOUT importing a single row (ruling T10) --
 * commitStagedImport's own fork-at-commit call is untouched and still runs exactly as it always
 * has, every time an import is actually committed.
 *
 * A built-in is still never overwritten (ruling T9) -- that refusal lives in
 * updateProfileMapping (presets.ts:343) and is exactly why this calls forkProfileIfBuiltin
 * rather than writing the profile directly: forking is the only path a built-in's mapping can
 * take here, same as at commit time.
 *
 * Same guard sequence as saveWizardProfileAction just above: isSameOrigin, then requireUser +
 * isSelfScoped with the identical refusal wording, then the same importMappingSchema parse --
 * this is a second door into the same profile store, and it must be exactly as locked as the
 * first one.
 */
export async function saveMappingAction(_prev: SaveMappingState, formData: FormData): Promise<SaveMappingState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: NOT_AVAILABLE_ERROR };

  const parsed = saveMappingSchema.safeParse({
    profileId: formData.get('profileId'),
    accountId: formData.get('accountId'),
    accountName: formData.get('accountName') ?? '',
    mapping: JSON.parse(String(formData.get('mapping') ?? '{}')),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the mapping.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  const existing = getProfile(parsed.data.profileId);
  if (!existing) return { error: 'That import profile no longer exists.' };
  // A row whose stored JSON is unreadable (ProfileRecord's own doc comment, presets.ts) is never
  // offered by the profile picker, so this is a defensive fallthrough rather than the normal
  // path -- same reasoning forkProfileIfBuiltin's own null check gives it.
  if (existing.mapping === null) return { error: existing.mappingError ?? 'This mapping could not be read.' };

  // Decided BEFORE the write: forkProfileIfBuiltin returns the SAME id for an unchanged mapping
  // whether the profile is built-in or custom, which would otherwise be indistinguishable from
  // "updated in place" below and leave the no-op silently unreported.
  const unchanged = mappingsEqual(existing.mapping, parsed.data.mapping);

  const resultId = forkProfileIfBuiltin({
    profileId: parsed.data.profileId,
    accountName: parsed.data.accountName,
    mapping: parsed.data.mapping,
  });
  // Repointed in every case, including the no-op: an account that was never pinned to this
  // profile before saving a mapping for it should leave pinned to whichever profile now holds
  // that mapping, the same way a successful commit already does (flow.ts:84).
  setAccountProfile(parsed.data.accountId, resultId);
  revalidatePath('/import');

  const resultName = getProfile(resultId)?.name ?? existing.name;
  if (unchanged) return { message: `"${resultName}" already matches this mapping -- nothing new to save.` };
  if (existing.isBuiltin) return { message: `Saved "${resultName}" as a new profile, and pointed this account at it.` };
  return { message: `Updated "${resultName}", and pointed this account at it.` };
}

/** '' = unassigned, which just means "fall back to the account owner" (MUST-6.2) — not an error. */
const personField = z.string().refine((value) => value === '' || /^\d+$/.test(value), 'Pick a person, or the account owner.');

const cardPersonSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  cardValue: z.string().trim().min(1, 'No card value to assign.').max(200),
  person: personField,
});

/**
 * Sets or clears one account's card-value -> person assignment (spec 2026-08-22 v1.6.0,
 * MUST-6.1). Writes immediately, independent of any staged/committed import — these are
 * account facts (like the account's owner), not import history, so they must survive an
 * import the user never actually commits. `requireUser` (not `requireAdmin`) because any
 * user who can run an import can already see and adjust this account's mapping.
 *
 * Deliberately does NOT require the target user to be active: upsertAccountCardPerson
 * already permits assigning to a since-deactivated user (src/lib/import/card-people.ts,
 * MUST-3.1's "remains valid and resolvable for display"), and this action only re-checks
 * that the id refers to a real user at all, the same existence-only check
 * updateAccountAction applies to a submitted owner id.
 */
export async function setCardPersonAction(_prev: CardPersonState, formData: FormData): Promise<CardPersonState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: NOT_AVAILABLE_ERROR };
  const parsed = cardPersonSchema.safeParse({
    accountId: formData.get('accountId'),
    cardValue: formData.get('cardValue') ?? '',
    person: String(formData.get('person') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  if (parsed.data.person === '') {
    deleteAccountCardPerson(parsed.data.accountId, parsed.data.cardValue);
    revalidatePath('/import');
    return { message: 'Unassigned. These rows fall back to the account owner at import.' };
  }

  const userId = Number(parsed.data.person);
  if (!findUserById(userId)) return { error: 'That person no longer exists.' };

  upsertAccountCardPerson({ accountId: parsed.data.accountId, cardValue: parsed.data.cardValue, userId });
  revalidatePath('/import');
  return { message: 'Saved. This assignment is remembered for every future import into this account too.' };
}
