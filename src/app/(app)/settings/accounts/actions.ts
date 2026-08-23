'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireAdmin } from '@/lib/auth/session';
import { createAccount, getAccount, renameAccount, setAccountActive, setAccountOwner } from '@/lib/accounts';
import { findUserById } from '@/lib/auth/users';
import { isIsoDate } from '@/lib/dates';
import { hasReadableMapping, listProfiles, setAccountPinnedProfile } from '@/lib/import/presets';
import { parseAmountToCents } from '@/lib/money';
import { recordBalanceSnapshot } from '@/lib/networth';
import { isSimplefinManaged } from '@/lib/simplefin/connection';
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

const updateAccountSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Give the account a name').max(80),
  owner: ownerField,
  profile: profileField,
});

/**
 * v1.7.0 Task 1b (spec 2026-08-22): one save replaces the three row forms that used to sit
 * side by side (Rename / Set owner / Set mapping). This is the union of the old
 * renameAccountAction, setAccountOwnerAction and setAccountProfileAction, so every guard those
 * three carried has to survive here too:
 *
 * - Mapping: the select only ever offers active+readable profiles (the same two conditions
 *   import/page.tsx's picker applies, MUST-4.1), re-checked server-side rather than trusted
 *   from the submitted value, same as the owner check below. But this check only runs when the
 *   submitted profile actually DIFFERS from the account's current pin -- the editor's <select>
 *   always defaults to the current pin, dormant or not (spec 2026-08-22 v1.6.0's dormant-pin
 *   rule), so a save aimed at the name or owner and just echoing the pin back must not fail, or
 *   silently clear, a pin that has since gone unoffered.
 * - SimpleFIN: setAccountProfileAction itself carried no isSimplefinManaged check at all --
 *   the old UI simply never rendered the mapping form for one of those accounts
 *   (accounts-manager.tsx omitted it outright). Now that mapping shares a submit with name and
 *   owner, that omission has to be enforced here instead: a SimpleFIN-managed account's pin is
 *   left exactly as it was, no matter what the combined form happened to send.
 *
 * v1.7.0 Task 6 (spec 2026-08-22) rides the same submit: `balance` (dollars, sign allowed) and
 * `asOfDate` are two MORE fields on this one form, not a fourth button or a second form --
 * that is the entire point of the Task 1b refactor above. `balance` blank means "leave alone"
 * and is deliberately NOT part of updateAccountSchema: unlike ownerField/profileField, whose ''
 * selects a real state (Joint, None), a blank balance selects no operation at all, so it is
 * read and validated by hand, the same way goals/actions.ts's addContributionAction handles its
 * optional amount/date pair. Both balance and its date are validated BEFORE any write below,
 * so an unparseable balance rejects the whole submit (including the name/owner/mapping the
 * admin may also have changed) rather than silently applying part of it.
 *
 * v1.8.0 ruling R9 (spec 2026-08-23): for a `type === 'credit'` account, the form's `balance`
 * field means "amount currently owed" (see accounts-manager.tsx's label switch) and is negated
 * on write, so typing 500.00 stores -50000. chequing/cash accounts are untouched by this --
 * they keep "Balance" and store the sign exactly as typed. See the comment at the write site
 * below for why the negation lives here and not in src/lib/networth.ts.
 */
export async function updateAccountAction(_prev: AccountsFormState, formData: FormData): Promise<AccountsFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = updateAccountSchema.safeParse({
    accountId: formData.get('accountId'),
    name: formData.get('name') ?? '',
    owner: String(formData.get('owner') ?? ''),
    profile: String(formData.get('profile') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  const account = getAccount(parsed.data.accountId);
  if (!account) return { error: 'That account no longer exists.' };

  const ownerUserId = ownerIdOf(parsed.data.owner);
  const invalidOwner = ownerError(ownerUserId);
  if (invalidOwner) return { error: invalidOwner };

  const managedBySimplefin = isSimplefinManaged(parsed.data.accountId);
  const profileId = profileIdOf(parsed.data.profile);
  if (!managedBySimplefin && profileId !== null && profileId !== account.importProfileId) {
    const offered = listProfiles().filter(hasReadableMapping).filter((p) => p.isActive);
    if (!offered.some((p) => p.id === profileId)) {
      return { error: 'That mapping is not available to pin — it may have been deactivated.' };
    }
  }

  const rawBalance = String(formData.get('balance') ?? '').trim();
  let balanceCents: number | null = null;
  let asOfDate: string | null = null;
  if (rawBalance !== '') {
    balanceCents = parseAmountToCents(rawBalance);
    if (balanceCents === null) return { error: 'Enter a valid balance, like 1234.56 or -1234.56, or leave it blank.' };
    asOfDate = String(formData.get('asOfDate') ?? '').trim();
    if (!isIsoDate(asOfDate)) return { error: 'Balance date must be YYYY-MM-DD.' };
  }

  renameAccount(parsed.data.accountId, parsed.data.name);
  setAccountOwner(parsed.data.accountId, ownerUserId);
  // Attribution of NEW transactions follows the owner; existing rows keep the
  // person they were already attributed to, which is why nothing is rewritten here.
  if (!managedBySimplefin) setAccountPinnedProfile(parsed.data.accountId, profileId);
  if (balanceCents !== null && asOfDate !== null) {
    // Ruling R9 (spec 2026-08-23, v1.8.0): the form asks a credit account's owner "how much do
    // you owe" -- a POSITIVE figure by the field's own label -- and this is the one place that
    // flips it to the negative balance net worth needs (a card owing $500 stores -50000, never
    // +50000). Accepting the raw typed sign here is exactly how a $500 debt would become a $500
    // asset and move net worth by $1,000 in the wrong direction. chequing/cash accounts keep the
    // sign exactly as typed -- an overdrawn chequing account is still legitimately negative, and
    // the person types it that way on purpose. The negation happens HERE, in the action, and
    // deliberately not inside recordBalanceSnapshot/src/lib/networth.ts: that file's own docblock
    // states nothing in the lib layer normalizes a sign, and moving the negation there would make
    // that no longer true.
    const signedBalanceCents = account.type === 'credit' ? -balanceCents : balanceCents;
    recordBalanceSnapshot({ accountId: parsed.data.accountId, date: asOfDate, balanceCents: signedBalanceCents, source: 'manual' });
  }

  revalidateProfileRoutes();
  return { message: `${parsed.data.name} updated.` };
}
