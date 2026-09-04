'use server';

import { headers } from 'next/headers';
import { isSameOrigin, CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { ownerScope } from '@/lib/auth/viewer';
import { categorySpendWithRollupSeries, resolveBudget, type BudgetScope } from '@/lib/budgets';
import { addMonths, isMonthKey, monthRange } from '@/lib/dates';

/**
 * One column of the F-06 six-month strip: a month, what this category (and its rollup) spent,
 * and the limit that was resolved for it.
 *
 * `limitCents` is `resolveBudget`'s BASE figure, deliberately not `effectiveBudget`'s
 * rollover-adjusted one. `effectiveBudget`'s carry walk is priced for ONE month -- the month the
 * card itself is showing -- by reading its own up-to-24-month window in two batched queries
 * (src/lib/budgets.ts's own doc comment on `effectiveBudget`). Re-running that walk five more
 * times, once per historical column, would multiply an already-bounded cost by six for a strip
 * whose own job is "over or under", not a rollover audit -- the alternative this rejects. A
 * rolling category's CURRENT month (the row this strip sits under) still reads its carried
 * figure correctly; the five months behind it read the same base limit `resolveBudget` has
 * always reported for a month before rollover carries into it.
 */
export interface CategoryHistoryMonth {
  month: string;
  spentCents: number;
  limitCents: number | null;
}

/**
 * Backs the F-06 six-month "spent vs limit" strip inside a budget card's expanding region --
 * "is Groceries always over, or was August a one-off", answered on the card instead of six
 * MonthNav clicks back, or Reports' Month over month, which shows spend with no limit beside it
 * (2026-09-02 review). Six months ending at and including `month`.
 *
 * A NEW file, not an addition to ./actions.ts, imported by budgets-client.tsx the same relative
 * way category-transactions-action.ts already is -- see that file's own doc comment for why:
 * tests/ops/client-bundle.test.ts's walk of a 'use client' file's @/-qualified value imports
 * never follows a relative specifier, so this never drags src/lib/budgets.ts's @/db/client
 * import into the browser bundle.
 *
 * `categorySpendWithRollupSeries` and `resolveBudget` (src/lib/budgets.ts) both take scope/userId
 * directly and no viewer of their own -- categorySpendWithRollupSeries joined the
 * HOUSEHOLD_ONLY_AT_PAGE reasoning (tests/ops/visibility-invariants.test.ts) the moment this task
 * exported it, same shape as budgetProgress: the CALLER carries the gate, because the function
 * structurally cannot. Task-3 (S-01) already found the one bug shaped exactly like this --
 * categoryTransactionsAction posting the caller's scope/userId straight through with no owner
 * narrowing of its own -- and fixed it by having categoryTransactions append ownerScope(viewer)
 * AFTER the caller's own clause, so a mismatched request becomes an unsatisfiable AND (zero rows)
 * rather than a rewrite to the viewer's own id (which would show them their own spending
 * relabelled under someone else's card). There is no query here to append a clause to -- this
 * assembles two aggregate reads, not a row filter -- so the same "zero rows, never a rewrite"
 * answer is produced here instead: a self-scoped, non-admin viewer whose request does not already
 * name their OWN personal scope gets an empty strip, never the real household or another
 * member's figures, and never their own figures silently standing in for someone else's card.
 */
export async function categoryHistoryAction(input: {
  scope: BudgetScope;
  userId: number | null;
  month: string;
  categoryId: number;
}): Promise<{ months: CategoryHistoryMonth[] } | { error: string }> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const viewer = await requireUser();

  if (!isMonthKey(input.month) || !Number.isInteger(input.categoryId) || input.categoryId <= 0) {
    return { error: 'Invalid request.' };
  }
  if (input.scope === 'personal' && input.userId === null) return { error: 'Invalid request.' };

  const viewerOwner = ownerScope(viewer);
  if (viewerOwner !== null && (input.scope !== 'personal' || input.userId !== viewerOwner)) {
    return { months: [] };
  }

  const months = monthRange(addMonths(input.month, -5), input.month);
  const spentByMonth = categorySpendWithRollupSeries(input.scope, input.userId, input.categoryId, months);
  return {
    months: months.map((m) => ({
      month: m,
      spentCents: spentByMonth.get(m) ?? 0,
      limitCents: resolveBudget(input.scope, input.userId, input.categoryId, m),
    })),
  };
}
