'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { createAccount, getAccount, renameAccount, setAccountActive, setAccountOwner } from '@/lib/accounts';
import { findUserById } from '@/lib/auth/users';
import { hasReadableMapping, listProfiles, setAccountPinnedProfile } from '@/lib/import/presets';
import { PROFILE_RENDERING_ROUTES } from '@/app/(app)/settings/managers/revalidation-routes';

export interface AccountsFormState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

/** '' = Joint/household (spec section 3: owner_user_id NULL means joint). */
const ownerField = z.string().refine((value) => value === '' || /^\d+$/.test(value), 'Pick an owner, or Joint.');

function ownerIdOf(value: string): number | null {
  return value === '' ? null : Number(value);
}

/** The FK would throw a raw SQLite error; check first so the form gets a sentence instead. */
function ownerError(ownerUserId: number | null): string | null {
  if (ownerUserId === null) return null;
  return findUserById(ownerUserId) ? null : 'That person no longer exists.';
}

/** '' = no pin (spec 2026-08-22 v1.6.0, MUST-5.1: the select can clear the pin, not just set it). */
const profileField = z.string().refine((value) => value === '' || /^\d+$/.test(value), 'Pick a mapping, or None.');

function profileIdOf(value: string): number | null {
  return value === '' ? null : Number(value);
}

/**
 * Loops PROFILE_RENDERING_ROUTES (src/app/(app)/settings/managers/revalidation-routes.ts) --
 * the SAME list managers/actions.ts's setProfileActiveAction loops (MUST-4.4) -- rather than
 * a fresh array here, per that module's doc comment: a route added there without a matching
 * revalidatePath call is caught by tests/app/managers-actions.test.ts, so a second, divergent
 * copy of the list in this file would defeat that guard.
 */
function revalidateProfileRoutes(): void {
  for (const route of PROFILE_RENDERING_ROUTES) revalidatePath(route);
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the account a name').max(80),
  institution: z.string().trim().max(80),
  type: z.enum(['chequing', 'credit', 'cash']),
  owner: ownerField,
});

export async function createAccountAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = createSchema.safeParse({
    name: formData.get('name') ?? '',
    institution: formData.get('institution') ?? '',
    type: formData.get('type') ?? 'chequing',
    owner: String(formData.get('owner') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };

  const ownerUserId = ownerIdOf(parsed.data.owner);
  const invalidOwner = ownerError(ownerUserId);
  if (invalidOwner) return { error: invalidOwner };

  try {
    createAccount({
      name: parsed.data.name,
      institution: parsed.data.institution,
      type: parsed.data.type,
      ownerUserId,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the account.' };
  }

  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  revalidatePath('/dashboard');
  return { message: `Added ${parsed.data.name}. It is now selectable on the Import page.` };
}

export async function renameAccountAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), name: z.string().trim().min(1, 'Give the account a name').max(80) })
    .safeParse({ accountId: formData.get('accountId'), name: formData.get('name') ?? '' });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  renameAccount(parsed.data.accountId, parsed.data.name);
  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  return { message: `Renamed to ${parsed.data.name}. Transactions and import history are untouched.` };
}

export async function setAccountOwnerAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), owner: ownerField })
    .safeParse({ accountId: formData.get('accountId'), owner: String(formData.get('owner') ?? '') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  const ownerUserId = ownerIdOf(parsed.data.owner);
  const invalidOwner = ownerError(ownerUserId);
  if (invalidOwner) return { error: invalidOwner };

  setAccountOwner(parsed.data.accountId, ownerUserId);
  revalidatePath('/settings/accounts');
  // Attribution of NEW transactions follows the owner; existing rows keep the
  // person they were already attributed to, which is why nothing is rewritten here.
  return { message: ownerUserId === null ? 'Owner set to Joint.' : 'Owner updated.' };
}

/**
 * Archive-only, exactly like categories and users: an account id is referenced
 * by transactions, imports and SimpleFIN links forever, so deactivating hides
 * it from the pickers and nothing more. There is deliberately no delete.
 */
export async function setAccountActiveAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), active: z.enum(['0', '1']) })
    .safeParse({ accountId: formData.get('accountId'), active: formData.get('active') });
  if (!parsed.success) return { error: 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  setAccountActive(parsed.data.accountId, parsed.data.active === '1');
  revalidatePath('/settings/accounts');
  revalidatePath('/import');
  revalidatePath('/dashboard');
  return {
    message:
      parsed.data.active === '1'
        ? 'Account reactivated.'
        : 'Account deactivated. Its transactions and history stay exactly where they are.',
  };
}

/**
 * Set-or-clear the mapping an account is pinned to, without running an import (spec
 * 2026-08-22 v1.6.0, MUST-5.1). Complements setAccountProfile in src/lib/import/presets.ts,
 * which only ever WRITES a pin, automatically, right after a successful commit
 * (src/lib/import/flow.ts) -- that remembering behaviour is untouched by this action. The
 * select on screen only ever offers active+readable profiles (the same two conditions
 * import/page.tsx's picker applies, MUST-4.1), and this re-checks that server-side rather than
 * trusting the submitted value, the same way setAccountOwnerAction above re-checks that a
 * chosen owner id still exists.
 */
export async function setAccountProfileAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ accountId: z.coerce.number().int().positive(), profile: profileField })
    .safeParse({ accountId: formData.get('accountId'), profile: String(formData.get('profile') ?? '') });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  if (!getAccount(parsed.data.accountId)) return { error: 'That account no longer exists.' };

  const profileId = profileIdOf(parsed.data.profile);
  if (profileId !== null) {
    const offered = listProfiles().filter(hasReadableMapping).filter((p) => p.isActive);
    if (!offered.some((p) => p.id === profileId)) {
      return { error: 'That mapping is not available to pin — it may have been deactivated.' };
    }
  }

  setAccountPinnedProfile(parsed.data.accountId, profileId);
  revalidateProfileRoutes();
  return { message: profileId === null ? 'Mapping pin cleared.' : 'Mapping pin set.' };
}
