'use server';

import { headers } from 'next/headers';
import { isSameOrigin, CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { categoryTransactions, type BudgetScope, type CategoryTransactionRow } from '@/lib/budgets';
import { isMonthKey } from '@/lib/dates';

/**
 * Backs the Lane 1 (2026-08-30 plan) "View breakdown" drill-down: a card names a category's
 * total, and this is what a household member actually sees when they ask what made it up.
 *
 * A NEW file rather than an addition to ./actions.ts (untouched by this lane, per the plan's own
 * file list) -- budgets-client.tsx already imports that module via a RELATIVE specifier, and this
 * one is imported the same way, so tests/ops/client-bundle.test.ts's walk of a 'use client' file's
 * @/-qualified value imports never has a reason to follow either into src/lib/budgets.ts (the
 * same reasoning that already lets budgets-client.tsx import ./actions today).
 *
 * Read-only, but still origin- and auth-checked like every mutating action in this app: a
 * household's transaction detail is not public data just because the request has no side effect.
 * Permission mirrors what the page ALREADY renders -- BudgetsClient shows another member's
 * read-only spend by design (polish item 5), so this refuses only a malformed request, never "you
 * are not that person": the numbers this returns are a breakdown of a total the viewer can already
 * see in full.
 */
export async function categoryTransactionsAction(input: {
  scope: BudgetScope;
  userId: number | null;
  month: string;
  categoryId: number;
}): Promise<{ rows: CategoryTransactionRow[] } | { error: string }> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  if (!isMonthKey(input.month) || !Number.isInteger(input.categoryId) || input.categoryId <= 0) {
    return { error: 'Invalid request.' };
  }
  if (input.scope === 'personal' && input.userId === null) return { error: 'Invalid request.' };

  const rows = categoryTransactions(input.month, input.categoryId, {
    scope: input.scope,
    attributedUserId: input.scope === 'personal' ? input.userId : undefined,
  });
  return { rows };
}
