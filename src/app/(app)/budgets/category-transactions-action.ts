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
 *
 * Returns `input.scope`/`input.userId`'s breakdown NARROWED by the caller's own `ownerScope` --
 * `categoryTransactions` (src/lib/budgets.ts) appends that clause itself now, so a self-scoped
 * viewer asking for `scope: 'household'` gets only their own rows, and asking for another named
 * person gets zero rows, never that person's real rows. Zero rows here is deliberate, matching
 * `getTransaction`'s documented choice (src/lib/transactions.ts) that an out-of-scope row reads
 * exactly like "no such row" -- there is no `NOT_YOURS_ERROR` branch to tell the two apart.
 *
 * This file's own justification used to read "the numbers this returns are a breakdown of a total
 * the viewer can already see in full" and refuse only a malformed request. That was true when
 * BudgetsClient showed every member's spend to every viewer (polish item 5) and stopped being true
 * the moment v1.13.0 introduced self-scoped viewers, who cannot see a household or another
 * member's total at all -- this action kept the old reasoning and the old behaviour past the
 * point where the page itself no longer matched them (`page.tsx`'s `isSelfScoped(viewer)` gate),
 * which is the bug the `viewer` argument below fixes.
 */
export async function categoryTransactionsAction(input: {
  scope: BudgetScope;
  userId: number | null;
  month: string;
  categoryId: number;
}): Promise<{ rows: CategoryTransactionRow[] } | { error: string }> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  if (!isMonthKey(input.month) || !Number.isInteger(input.categoryId) || input.categoryId <= 0) {
    return { error: 'Invalid request.' };
  }
  if (input.scope === 'personal' && input.userId === null) return { error: 'Invalid request.' };

  const rows = categoryTransactions(
    input.month,
    input.categoryId,
    {
      scope: input.scope,
      attributedUserId: input.scope === 'personal' ? input.userId : undefined,
    },
    user,
  );
  return { rows };
}
