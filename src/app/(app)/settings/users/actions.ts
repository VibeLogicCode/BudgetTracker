'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { destroyAllSessionsForUser } from '@/lib/auth/session';
import { clearAttemptsFor } from '@/lib/auth/ratelimit';
import { clearTotpEnrollment } from '@/lib/auth/totp';
import {
  createPersonSchema,
  createPersonWithoutLogin,
  createUser,
  createUserSchema,
  findUserById,
  setMustChangePassword,
  setUserActive,
  setUserCanSignIn,
  setUserPassword,
  setUserVisibility,
} from '@/lib/auth/users';
import { passwordSchema } from '@/lib/auth/password';

export interface UsersFormState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

export async function createUserAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = createUserSchema.safeParse({
    name: formData.get('name') ?? '',
    username: formData.get('username') ?? '',
    password: formData.get('password') ?? '',
    role: formData.get('role') ?? 'member',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  try {
    // Spec v1.5: the admin typed this password, so the new user is gated on
    // /change-password until they replace it with one only they know.
    await createUser({ ...parsed.data, mustChangePassword: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the user.' };
  }
  revalidatePath('/settings/users');
  return {
    message: `Created ${parsed.data.username}. Share the temporary password privately — they must change it at first sign-in.`,
  };
}

export async function setActiveAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive(), active: z.enum(['0', '1']) }).safeParse({
    userId: formData.get('userId'),
    active: formData.get('active'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    setUserActive(parsed.data.userId, parsed.data.active === '1');
    if (parsed.data.active === '0') destroyAllSessionsForUser(parsed.data.userId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update the user.' };
  }
  revalidatePath('/settings/users');
  return { message: 'User updated.' };
}

export async function resetPasswordAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive(), password: passwordSchema }).safeParse({
    userId: formData.get('userId'),
    password: formData.get('password') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  await setUserPassword(parsed.data.userId, parsed.data.password);
  // Same reasoning as createUserAction: an admin-known password is a temporary one.
  setMustChangePassword(parsed.data.userId, true);
  destroyAllSessionsForUser(parsed.data.userId);
  const target = findUserById(parsed.data.userId);
  if (target) clearAttemptsFor(target.username);
  revalidatePath('/settings/users');
  return { message: 'Password reset. All their sessions were signed out, and they must choose a new password to sign in.' };
}

export async function resetMfaAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z.object({ userId: z.coerce.number().int().positive() }).safeParse({ userId: formData.get('userId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  clearTotpEnrollment(parsed.data.userId);
  // Mirrors resetPasswordAction: an admin action that lowers this account's
  // authentication bar must not leave already-open sessions running behind it —
  // a live session on a lost phone would otherwise outlive the MFA it was granted under.
  destroyAllSessionsForUser(parsed.data.userId);
  revalidatePath('/settings/users');
  return { message: 'MFA cleared and their sessions were signed out. They can enroll a new authenticator at their next sign-in.' };
}

/**
 * v1.13.0 ruling R5: "Add a person without a login". createPersonWithoutLogin() itself sets
 * role: 'member', canSignIn: false and a throwaway password hash nobody knows — this action's
 * only job is form parsing and the same isSameOrigin/requireAdmin/try-catch shape every other
 * action in this file follows.
 */
export async function createPersonAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = createPersonSchema.safeParse({
    name: formData.get('name') ?? '',
    username: formData.get('username') ?? '',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  try {
    await createPersonWithoutLogin(parsed.data);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not add that person.' };
  }
  revalidatePath('/settings/users');
  return { message: `${parsed.data.name} added. They cannot sign in and cannot be made an admin.` };
}

/**
 * v1.13.0 ruling R2, micro-ruling M1. setUserVisibility() itself is the one place the
 * admin-on-self refusal is enforced ("Make them a member first.") — this action only surfaces
 * that message on the form the same way every other action's try/catch does.
 */
export async function setVisibilityAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ userId: z.coerce.number().int().positive(), visibility: z.enum(['household', 'self']) })
    .safeParse({ userId: formData.get('userId'), visibility: formData.get('visibility') });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    setUserVisibility(parsed.data.userId, parsed.data.visibility);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that person.' };
  }
  revalidatePath('/settings/users');
  return { message: 'Updated.' };
}

/**
 * v1.13.1 (item BI). setUserCanSignIn has existed since v1.13.0 (src/lib/auth/users.ts:265) with
 * no server action and no control anywhere, so an admin could create a no-login person at signup
 * (createPersonWithoutLogin) but could not convert an existing member into one, or back, without
 * editing the database by hand. Shaped exactly like setVisibilityAction above; the last-admin
 * refusal is the library's own throw, surfaced verbatim.
 */
export async function setCanSignInAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const userIdParsed = z.coerce.number().int().positive().safeParse(formData.get('userId'));
  if (!userIdParsed.success) return { error: 'Invalid request.' };
  // Accepts both an explicit '0'/'1' (this action's own test contract, and setActiveAction's
  // convention) and AutoSaveCheckbox's native shape ('on' when checked, the field OMITTED
  // entirely when not) -- the same "absent means off" rule an unchecked HTML checkbox has
  // always followed.
  const raw = formData.get('canSignIn');
  const canSignIn = raw === '1' || raw === 'on';
  try {
    setUserCanSignIn(userIdParsed.data, canSignIn);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update the user.' };
  }
  revalidatePath('/settings/users');
  return { message: 'Updated.' };
}
