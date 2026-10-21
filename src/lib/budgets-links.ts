import type { BudgetScope } from '@/lib/budgets';

/**
 * Spec 2026-10-21 (fix from Budgets) §2.6. The two halves of the round trip between a Budgets
 * card and the Transactions page it links to.
 *
 * The way back is DERIVED on the Transactions side from what that page already carries (the
 * range, the person and the category), not carried as a `?back=` value: a stored return address
 * would be one more parameter every filter form must remember to pass through, and a stale or
 * hand-edited one would send somebody to a page the link never named. The card's DOM id is the
 * one fact both pages must agree on, so it is built here and nowhere else.
 */

/** The DOM id of a top-level Budgets card: what Transactions' Back to Budgets scrolls to. */
export function budgetCardId(scope: BudgetScope, userId: number | null, categoryId: number): string {
  return `budget-card-${scope}-${userId ?? 'h'}-${categoryId}`;
}

/** A /budgets link carrying only what it was given: `/budgets`, `?month=`, `&person=`, `#card`. */
export function budgetsHref(input: { month: string | null; personId: number | null; cardId: string | null }): string {
  const params: string[] = [];
  if (input.month !== null) params.push(`month=${input.month}`);
  if (input.personId !== null) params.push(`person=${input.personId}`);
  return `/budgets${params.length > 0 ? `?${params.join('&')}` : ''}${input.cardId !== null ? `#${input.cardId}` : ''}`;
}
