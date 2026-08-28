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
import { createProfile, getProfileByName } from '@/lib/import/presets';
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
