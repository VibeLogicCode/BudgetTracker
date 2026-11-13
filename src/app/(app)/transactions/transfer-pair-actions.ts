'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isSameOrigin, CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { captureBulkBefore, recordBulkUndo } from '@/lib/bulk-undo';
import { todayIso } from '@/lib/dates';
import { confirmTransferPair, dismissTransferPair } from '@/lib/transfer-pairs';
import { z } from '@/lib/zod';
import type { ActionState } from './actions';

/**
 * v1.62.0 lane C. The two buttons on a possible transfer. Both take the pair as two row ids, and
 * the server re-asks the same predicate the card was built from (src/lib/transfer-pairs.ts), so a
 * pair that changed after the page loaded is refused, never half written.
 */
const pairIds = z.object({
  outId: z.coerce.number().int().positive(),
  inId: z.coerce.number().int().positive(),
});

function revalidateMoney(): void {
  for (const path of ['/transactions', '/dashboard', '/budgets', '/reports']) revalidatePath(path);
}

export async function confirmTransferPairAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const parsed = pairIds.safeParse({ outId: formData.get('outId'), inId: formData.get('inId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const at = new Date();
  const before = captureBulkBefore({ ids: [parsed.data.outId, parsed.data.inId] });
  const result = confirmTransferPair({ ...parsed.data, viewer: user, at });
  if (!result.ok) return { error: result.error };
  // Counts only the rows this changed: one side of a pair may already have been a transfer.
  const label =
    result.marked === 2
      ? 'Marked 2 transactions as a transfer pair.'
      : 'Marked 1 transaction as a transfer; the other side already was one.';
  recordBulkUndo({ userId: user.id, kind: 'transfer_pair', label, before, at });
  revalidateMoney();
  return { message: label };
}

export async function dismissTransferPairAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const parsed = pairIds.safeParse({ outId: formData.get('outId'), inId: formData.get('inId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const result = dismissTransferPair({ ...parsed.data, viewer: user, on: todayIso() });
  if (!result.ok) return { error: result.error };
  revalidatePath('/transactions');
  return { message: 'Okay, that pair will not be suggested again.' };
}
