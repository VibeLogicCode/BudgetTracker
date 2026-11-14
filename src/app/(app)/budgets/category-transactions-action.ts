'use server';

import { headers } from 'next/headers';
import { isSameOrigin, CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { categoryTransactions, type BudgetScope, type CategoryTransactionRow } from '@/lib/budgets';
import { isBounded } from '@/lib/categorize/amount-bounds';
import { buildContext, categoryRuleThatFiled } from '@/lib/categorize/engine';
import { alwaysAskRuleFor, listRules, type MatchType } from '@/lib/categorize/rules';
import { isMonthKey } from '@/lib/dates';
import { splitsForTransactions, type SplitRow } from '@/lib/splits';
import { effectivePartPerson } from '@/lib/split-person';
import { NOT_YOURS_ERROR, ownerScope } from '@/lib/auth/viewer';
import { z } from '@/lib/zod';
import { transactionOwners } from '@/lib/transactions';
import { listAttributablePeople } from '@/lib/auth/users';

/** `bounded`: the rule has an amount window, so a new exact rule would not outrank it. */
export interface FiledByRule { ruleId: number; pattern: string; matchType: MatchType; bounded: boolean }
export interface CategoryPanelRow extends CategoryTransactionRow {
  /** Spec 2026-10-21 (fix from Budgets) §2.3. The category rule that filed the row, when one still stands behind it. */
  filedBy: FiledByRule | null;
  /** An enabled Always ask rule already covers the merchant (alwaysAskRuleFor). */
  alwaysAsked: boolean;
  /**
   * v1.63.0. False for a self viewer's row that belongs to someone else (the viewer holds a part of
   * it): every change to it is refused server-side, so the card offers none. True otherwise.
   */
  yours?: boolean;
  /** v1.63.0. The transaction's own person, for the split editor; null for Household and for a self viewer. */
  personName?: string | null;
}
export interface CategoryPanelResult { rows: CategoryPanelRow[]; splits: Record<number, SplitRow[]> }

/** v1.64.1. The posted request, parsed before anything is read: a known scope, a month, positive ids. */
const requestSchema = z
  .object({
    scope: z.enum(['household', 'personal']),
    userId: z.number().int().positive().nullable(),
    month: z.string().max(7).refine(isMonthKey),
    categoryId: z.number().int().positive(),
  })
  .refine((input) => input.scope !== 'personal' || input.userId !== null);

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
 * `categoryTransactions` (src/lib/budgets.ts) appends that clause itself, as a second layer.
 *
 * v1.64.1: the request is parsed with a schema first, and a self-scoped viewer who names household
 * scope or another person is refused with NOT_YOURS_ERROR rather than answered over a narrowed or
 * rewritten scope. The Budgets page only ever asks for their own personal card.
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
}): Promise<CategoryPanelResult | { error: string }> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid request.' };
  const request = parsed.data;
  const own = ownerScope(user);
  if (own !== null && (request.scope !== 'personal' || request.userId !== own)) return { error: NOT_YOURS_ERROR };

  const rows = categoryTransactions(
    request.month,
    request.categoryId,
    {
      scope: request.scope,
      attributedUserId: request.scope === 'personal' ? request.userId : undefined,
    },
    user,
  );
  const ctx = buildContext();
  const askRules = listRules('always_ask');
  // v1.63.0: the transaction's own person decides who may act on a row and whose parts a self viewer may read.
  const owners = transactionOwners([...new Set(rows.map((row) => row.id))]);
  const names = new Map(listAttributablePeople().map((person) => [person.id, person.name]));
  const panelRows: CategoryPanelRow[] = rows.map((row) => {
    const owner = owners.get(row.id) ?? null;
    const yours = own === null || owner === own;
    const rule = categoryRuleThatFiled(
      { normalizedMerchant: row.normalizedMerchant, amountCents: row.parentAmountCents, categoryId: request.categoryId, source: row.source },
      ctx,
    );
    return {
      ...row,
      // A self viewer never receives the whole of a charge that is someone else's.
      parentAmountCents: yours ? row.parentAmountCents : row.amountCents,
      yours,
      personName: own === null && owner !== null ? (names.get(owner) ?? null) : null,
      filedBy: rule ? { ruleId: rule.id, pattern: rule.pattern, matchType: rule.matchType, bounded: isBounded(rule) } : null,
      alwaysAsked: alwaysAskRuleFor(row.normalizedMerchant, askRules) !== null,
    };
  });
  const splitIds = [...new Set(rows.filter((row) => row.splitId !== null).map((row) => row.id))];
  const byTxn = splitsForTransactions(splitIds);
  // v1.63.0 (S4): a self viewer receives only the parts that are theirs.
  if (own !== null) {
    for (const [id, parts] of byTxn) {
      byTxn.set(id, parts.filter((part) => effectivePartPerson(part, owners.get(id) ?? null) === own));
    }
  }
  return { rows: panelRows, splits: Object.fromEntries(byTxn) };
}
