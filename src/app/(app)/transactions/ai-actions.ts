'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isSameOrigin, CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped, NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { aiSuggestionFor, ignoreAiSuggestion } from '@/lib/ai/suggestions';
import { getTransaction } from '@/lib/transactions';
import { z } from '@/lib/zod';
import { renameTransactionAction, setCategoryAction, type ActionState } from './actions';

/**
 * v1.64.0 (plan 2026-11-12, lane C1). Using or ignoring a local AI suggestion in Review.
 *
 * A suggestion is never filed on its own: Use only re-checks that the suggestion is still there and
 * then hands the existing category or rename action the same form a person would have posted, the
 * way acceptAllGuessesAction hands acceptGuessAction its rows. Every guard, rule write and note
 * (archived, Always ask, rule-owned, split) therefore stays in that one place.
 */
const REVIEW_REFUSED = 'Review is not available on this account.';
const GONE = 'That suggestion is no longer available.';

const useSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  part: z.enum(['category', 'name']),
  remember: z.enum(['1']).optional(),
});

export async function acceptAiSuggestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  if (isSelfScoped(user)) return { error: REVIEW_REFUSED };

  const parsed = useSchema.safeParse({
    transactionId: formData.get('transactionId'),
    part: formData.get('part'),
    remember: formData.get('remember') ?? undefined,
  });
  if (!parsed.success) return { error: 'Invalid request.' };
  const { transactionId, part } = parsed.data;
  const remember = parsed.data.remember === '1';

  const row = getTransaction(transactionId, user);
  if (row === null) return { error: NOT_YOURS_ERROR };
  const suggestion = aiSuggestionFor(row.normalizedMerchant);
  if (suggestion === null || suggestion.status !== 'suggested') return { error: GONE };

  const forward = new FormData();
  forward.set('transactionId', String(transactionId));
  if (part === 'category') {
    if (row.categoryId !== null) return { error: 'This row was filed meanwhile; nothing changed.' };
    if (suggestion.categoryId === null) return { error: GONE };
    const live = listCategories().some((category) => category.id === suggestion.categoryId);
    if (!live) return { error: 'That suggested category is archived now, so it cannot be used.' };
    forward.set('categoryId', String(suggestion.categoryId));
    if (remember) forward.set('teach', '1');
    return setCategoryAction({}, forward);
  }

  if (suggestion.cleanName === null) return { error: GONE };
  forward.set('displayName', suggestion.cleanName);
  forward.set('scope', remember ? 'all' : 'one');
  return renameTransactionAction({}, forward);
}

const ignoreSchema = z.object({ merchant: z.string().min(1).max(200) });

export async function ignoreAiSuggestionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  if (isSelfScoped(user)) return { error: REVIEW_REFUSED };

  const parsed = ignoreSchema.safeParse({ merchant: formData.get('merchant') });
  if (!parsed.success) return { error: 'Invalid request.' };
  const { merchant } = parsed.data;
  if (aiSuggestionFor(merchant)?.status !== 'suggested') return { error: GONE };
  ignoreAiSuggestion({ merchant, userId: user.id, at: new Date() });
  revalidatePath('/transactions');
  return { message: `Ignored. No more AI suggestions for ${merchant}.` };
}
