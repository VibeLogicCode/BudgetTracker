'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { acceptsTransactions, getAccount, listAccounts } from '@/lib/accounts';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { findUserById, setLastAccountId } from '@/lib/auth/users';
import { canActOnOwner, NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { getWarrantyItem, setBudgetCategory } from '@/lib/warranty/items';
import { findInstallmentItem, recordInstallmentPayment } from '@/lib/warranty/installments';
import { listCategories } from '@/lib/categories';

/**
 * v1.13.0 rulings R8 and R11. Its own 'use server' file rather than an addition to
 * warranties/actions.ts because BOTH the dashboard's Coming-up card and the item detail page invoke
 * it, and a shared action that lives inside one page's folder reads as belonging to that page.
 *
 * tests/ops/use-server-exports.test.ts requires every export here to be an async function -- so the
 * state interface below is a type, and CROSS_ORIGIN_ERROR is imported from @/lib/auth/csrf (the
 * canonical constant every 'use server' module shares) rather than redefined here.
 */
export interface BillActionState {
  error?: string;
  message?: string;
}

const idField = z.coerce.number().int().positive();

/**
 * Ruling R7/M5: the account this person last used, falling back to the first account they can list.
 * Re-resolved every time rather than trusted, because last_account_id has no ON DELETE and an
 * account can be deactivated between one payment and the next.
 */
function accountForPayment(userId: number, viewer: Parameters<typeof listAccounts>[1]): number | null {
  const remembered = findUserById(userId)?.lastAccountId ?? null;
  if (remembered !== null) {
    const account = getAccount(remembered);
    if (account && account.isActive && acceptsTransactions(account.type)) return account.id;
  }
  const first = listAccounts({}, viewer).find((account) => acceptsTransactions(account.type));
  return first?.id ?? null;
}

export async function recordBillPaymentAction(
  _prev: BillActionState,
  formData: FormData,
): Promise<BillActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = idField.safeParse(formData.get('installmentId'));
  if (!parsed.success) return { error: 'Invalid request.' };

  // Ruling R3: ownership lands regardless of visibility. A household member cannot record a payment
  // against somebody else's bill, because doing so writes a transaction in their name.
  const target = findInstallmentItem(parsed.data);
  if (target === null) return { error: 'That installment no longer exists.' };
  if (!canActOnOwner(target.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  const accountId = accountForPayment(user.id, user);
  if (accountId === null) {
    return { error: 'Add a bank or cash account first — a payment has to land somewhere.' };
  }

  const result = recordInstallmentPayment({
    installmentId: parsed.data,
    accountId,
    userId: user.id,
    today: todayIso(new Date(), readEnv().tz),
    // v1.13.0 ruling R4 (item I4): the ACTOR's role, not an implicit admin -- see
    // createManualTransaction's own doc comment (src/lib/transactions.ts).
    actorRole: user.role,
  });

  if (!result.ok) {
    if (result.reason === 'gone') return { error: 'That installment no longer exists.' };
    if (result.reason === 'no_account') {
      return { error: 'Add a bank or cash account first — a payment has to land somewhere.' };
    }
    if (result.reason === 'linked_elsewhere') {
      // A loan-matching rule claimed the new transaction before this call's own targeted mark ran,
      // so the whole payment was rolled back rather than double-counted against a loan.
      return { error: 'That payment matched an existing loan rule instead of this bill, so nothing was recorded.' };
    }
    if (result.reason === 'rule_owned') return { error: result.error };
    // The matcher may have marked it from an imported transaction between the page load and the
    // click. Saying so is more honest than marking a second row (spec, item AN).
    return { error: 'That installment is already marked paid.' };
  }

  // Ruling R7/M5: remembered only on success, so a failed attempt never nudges the default away
  // from where it already pointed.
  setLastAccountId(user.id, accountId);

  revalidatePath('/dashboard');
  revalidatePath('/transactions');
  revalidatePath('/warranties');
  revalidatePath(`/warranties/${target.itemId}`);
  return { message: 'Payment recorded and the installment marked paid.' };
}

export async function setBillCategoryAction(
  _prev: BillActionState,
  formData: FormData,
): Promise<BillActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = idField.safeParse(formData.get('itemId'));
  if (!parsed.success) return { error: 'Invalid request.' };
  const item = getWarrantyItem(parsed.data, user);
  if (!item) return { error: 'That item no longer exists.' };
  if (!canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  const raw = String(formData.get('categoryId') ?? '').trim();
  const categoryId = raw === '' ? null : Number(raw);
  if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return { error: 'Invalid request.' };
  }
  // M-a (v1.13.0 whole-branch review): a categoryId that parses fine but names no real row
  // (deleted between page load and submit, or simply hand-crafted) used to reach setBudgetCategory
  // unchecked and throw a raw foreign-key error instead of a normal form message. Archived
  // categories are still valid targets here -- a bill can stay linked to a category someone later
  // archived, the same as every other budget-category reference in this codebase.
  if (categoryId !== null && !listCategories({ includeArchived: true }).some((category) => category.id === categoryId)) {
    return { error: 'That category no longer exists.' };
  }

  setBudgetCategory(parsed.data, categoryId);
  revalidatePath('/budgets');
  revalidatePath(`/warranties/${parsed.data}`);
  return { message: categoryId === null ? 'Budget link removed.' : 'Budget category linked.' };
}
