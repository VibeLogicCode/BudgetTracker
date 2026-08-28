'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { isSameOrigin } from '@/lib/auth/csrf';
import {
  applyCategoryToMatching,
  confirmCategory,
  setTransferFlag,
  type CategoryMatchResult,
  type RuleGuardedWriteResult,
} from '@/lib/categorize/engine';
import { ruleOwnedError } from '@/lib/categorize/rules';
import { getTransaction } from '@/lib/transactions';

export interface ReviewState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const SPLIT_ROW_ERROR = 'That transaction has splits and cannot be recategorized this way.';

/** One place to turn a guarded write's refusal into the sentence a form shows. */
function guardedWriteError(result: RuleGuardedWriteResult | CategoryMatchResult): string {
  return result.ok
    ? ''
    : result.reason === 'owned_by_another'
      ? ruleOwnedError(result.ownerName)
      : SPLIT_ROW_ERROR;
}

export async function acceptGuessAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  // Controller ruling: the review queue is household-wide by construction and unscoped, so a
  // self viewer's action must be refused here too, not just kept off the nav / the page.
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const transactionId = Number(formData.get('transactionId'));
  const row = getTransaction(transactionId, user);
  if (!row || row.categoryId === null) return { error: 'There is no guess to accept on that row.' };
  const result = confirmCategory({ transactionId, categoryId: row.categoryId, userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: guardedWriteError(result) };
  revalidatePath('/review');
  return { message: 'Accepted.' };
}

const idFieldsSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive(),
});

export async function fixCategoryAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const parsed = idFieldsSchema.safeParse({
    transactionId: formData.get('transactionId'),
    categoryId: formData.get('categoryId'),
  });
  if (!parsed.success) return { error: 'Pick a category.' };
  try {
    const result = confirmCategory({
      transactionId: parsed.data.transactionId,
      categoryId: parsed.data.categoryId,
      userId: user.id,
      actorRole: user.role,
    });
    if (!result.ok) return { error: guardedWriteError(result) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that transaction.' };
  }
  revalidatePath('/review');
  return { message: 'Category set and rule created.' };
}

export async function applyToAllMatchingAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const normalizedMerchant = String(formData.get('normalizedMerchant') ?? '');
  const categoryId = Number(formData.get('categoryId'));
  if (normalizedMerchant.length === 0 || !Number.isInteger(categoryId) || categoryId <= 0) return { error: 'Pick a category.' };
  const result = applyCategoryToMatching({ normalizedMerchant, categoryId, userId: user.id, actorRole: user.role });
  if (!result.ok) return { error: guardedWriteError(result) };
  revalidatePath('/review');
  return { message: `Applied to ${result.count} transactions and created a rule.` };
}

export async function markTransferAction(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  if (isSelfScoped(user)) return { error: 'Review is not available on this account.' };

  const parsed = z.object({ transactionId: z.coerce.number().int().positive() }).safeParse({
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    const result = setTransferFlag({
      transactionId: parsed.data.transactionId,
      isTransfer: true,
      userId: user.id,
      actorRole: user.role,
    });
    if (!result.ok) return { error: guardedWriteError(result) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update that transaction.' };
  }
  revalidatePath('/review');
  return { message: 'Marked as a transfer and learned an exact rule.' };
}
