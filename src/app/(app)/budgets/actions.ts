'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { clearBudget, copyBudgetsFromPreviousMonth, resolveBudget, setRollover, upsertBudget, type BudgetScope } from '@/lib/budgets';
import { currentMonth, isMonthKey } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { suggestionsFor } from '@/lib/predict/history';
import { copySavingsTargetForward, saveSavingsTarget } from '@/lib/savings-target';

export interface BudgetActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const STALE_SUGGESTION_ERROR = 'That suggestion is no longer available. Reload the page.';
const NOT_CURRENT_MONTH_ERROR = 'Suggestions are only available for the current month.';

const scopeSchema = z.enum(['household', 'personal']);
const monthSchema = z.string().refine(isMonthKey, { message: 'Month must be YYYY-MM.' });
const categoryIdSchema = z.coerce.number().int().positive();
// '' means "the acting user" for a personal scope; anything else must be a positive integer id.
const userIdField = z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), { message: 'Invalid person selection.' });

export async function setLimitAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  const amountRaw = String(formData.get('amount') ?? '').trim();

  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  // Members may edit household budgets and their OWN personal budgets (spec section 6).
  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  if (amountRaw === '') {
    clearBudget({ scope: scope.data, userId, categoryId: categoryId.data, month: month.data });
    revalidatePath('/budgets');
    return { message: 'Budget cleared from this month forward.' };
  }

  const cents = parseAmountToCents(amountRaw);
  if (cents === null || cents < 0) return { error: 'Enter a positive amount, or leave it blank to clear the budget.' };

  upsertBudget({ scope: scope.data, userId, categoryId: categoryId.data, month: month.data, amountCents: cents });
  revalidatePath('/budgets');
  return { message: 'Budget saved.' };
}

export async function copyPreviousMonthAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !rawUserId.success) return { error: 'Invalid request.' };

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only copy your own personal budgets.' };
  }

  const copied = copyBudgetsFromPreviousMonth(month.data, scope.data as BudgetScope, userId);
  // Lane 3 item 1 / ruling T4 ("one row per month, seeded by copy-forward"): the savings target
  // rides along on the SAME button rather than getting a second one, exactly the way the
  // budgets themselves are seeded. Household scope only -- ruling T3 gives the target no
  // per-person copy of its own, so a personal-scope copy has nothing of this kind to bring
  // forward.
  const targetCopied = scope.data === 'household' ? copySavingsTargetForward(month.data) : false;
  revalidatePath('/budgets');
  revalidatePath('/dashboard');
  return {
    message: `Copied ${copied} budgets${targetCopied ? ' and the savings target' : ''} from the previous month.`,
  };
}

const savingsTargetModeSchema = z.enum(['percent', 'amount']);

/**
 * Ruling T6: set on Budgets, beside the month it applies to. Ruling T3: household scope only,
 * so unlike setLimitAction there is no personal-scope branch and no per-user ownership check --
 * every household member may set it, the same permission model household budget LIMITS already
 * use (Row's `editable` is unconditionally true for household scope), not the stricter
 * admin-only rule "Roll over unspent" carries. Nothing in the rulings asks for that stricter
 * gate here, and inventing one this release would be exactly the kind of unwritten rule ruling
 * T2 already warns against ("a rule nobody can restate is a rule nobody can act on").
 *
 * Ruling T2: mode and value travel together, always -- there is no partial update, because a
 * bare `value` with no `mode` (or vice versa) is not a number anyone could act on.
 */
export async function setSavingsTargetAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireUser();
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const mode = savingsTargetModeSchema.safeParse(formData.get('mode'));
  if (!month.success || !mode.success) return { error: 'Invalid request.' };

  const rawValue = String(formData.get('value') ?? '').trim();
  if (rawValue === '') return { error: 'Enter a value.' };

  let value: number;
  if (mode.data === 'percent') {
    // A whole percent, 1-100 -- ruling T2 rules out "whichever is greater" and any other
    // compound rule, and a target of 0% or over 100% is not a rule a household could restate
    // either.
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return { error: 'Enter a whole percent from 1 to 100.' };
    }
    value = parsed;
  } else {
    const cents = parseAmountToCents(rawValue);
    if (cents === null || cents <= 0) return { error: 'Enter a positive amount.' };
    value = cents;
  }

  saveSavingsTarget({ month: month.data, mode: mode.data, value });
  revalidatePath('/budgets');
  // The dashboard's Saved this month tile reads the same row (savingsProgress) -- without this
  // it would keep showing whatever target was in force before this save until its own
  // force-dynamic reload happened to run anyway.
  revalidatePath('/dashboard');
  return { message: 'Savings target saved.' };
}

/**
 * MUST-7.4: takes scope, userId, month and categoryId, and NO amount. The suggestion is
 * recomputed server-side from the same inputs the page used, so a crafted request cannot
 * write an arbitrary number through a path labelled "suggestion".
 */
export async function applySuggestionAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  // MUST-6.6: this release only ever suggests against the current month. A month key is a
  // client-supplied input like any other, and MUST-7.4's discipline against a client choosing
  // the AMOUNT applies just as much to a client choosing which month's window computes it: a
  // future month's window pulls in the current, partial month (see historyMonths), and a past
  // month is a suggestion nobody asked to apply retroactively.
  if (month.data !== currentMonth(new Date(), readEnv().tz)) {
    return { error: NOT_CURRENT_MONTH_ERROR };
  }

  // MUST-7.6: setLimitAction's rule, verbatim.
  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  const result = suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory.get(categoryId.data);
  // MUST-7.5: never fall back to a stale number.
  if (result === undefined || !('suggestion' in result)) return { error: STALE_SUGGESTION_ERROR };

  // MUST-7.7: the existing write, so the existing effective-month semantics apply unchanged.
  upsertBudget({
    scope: scope.data,
    userId,
    categoryId: categoryId.data,
    month: month.data,
    amountCents: result.suggestion.suggestedCents,
  });
  revalidatePath('/budgets');
  return { message: `Budget set to ${formatCents(result.suggestion.suggestedCents, { currency: true })} from the suggestion.` };
}

/**
 * MUST-7.8: applies every available suggestion ONLY to categories whose resolved limit for
 * that month is currently null. A category with a limit somebody typed is skipped, always,
 * with no confirmation dialog and no override flag.
 */
export async function applyAllSuggestionsAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !rawUserId.success) return { error: 'Invalid request.' };

  // MUST-6.6: the same current-month-only rule as applySuggestionAction, verbatim.
  if (month.data !== currentMonth(new Date(), readEnv().tz)) {
    return { error: NOT_CURRENT_MONTH_ERROR };
  }

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only edit your own personal budgets.' };
  }

  let set = 0;
  let skipped = 0;
  for (const [categoryId, result] of suggestionsFor({ targetMonth: month.data, scope: scope.data, userId }).byCategory) {
    if (!('suggestion' in result)) continue;
    if (resolveBudget(scope.data as BudgetScope, userId, categoryId, month.data) !== null) {
      skipped += 1;
      continue;
    }
    upsertBudget({ scope: scope.data, userId, categoryId, month: month.data, amountCents: result.suggestion.suggestedCents });
    set += 1;
  }

  revalidatePath('/budgets');
  return { message: `Set ${set} budgets from suggestions. Skipped ${skipped} categories that already had a limit.` };
}

/**
 * The "Roll over unspent" toggle (v1.7.0, Task 11). Permission is deliberately STRICTER than
 * setLimitAction's for household scope: any member may set a household budget's amount, but
 * rollover is a policy choice about how a shared budget behaves across months, so turning it
 * on or off there is admin-only. A personal budget's own owner may still toggle it for
 * themselves without being an admin, same as they may set their own limit.
 *
 * Enabling always writes startMonth = the page's currently displayed month (the `month`
 * field); setRollover's own no-op rule (src/lib/budgets.ts) leaves an already-on row's
 * original startMonth untouched, so re-submitting this form never moves it. Disabling deletes
 * the row regardless of `month` -- setRollover ignores startMonth on that path.
 */
export async function setRolloverAction(_prev: BudgetActionState, formData: FormData): Promise<BudgetActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const scope = scopeSchema.safeParse(formData.get('scope'));
  const month = monthSchema.safeParse(String(formData.get('month') ?? ''));
  const categoryId = categoryIdSchema.safeParse(formData.get('categoryId'));
  const rawUserId = userIdField.safeParse(String(formData.get('userId') ?? ''));
  if (!scope.success || !month.success || !categoryId.success || !rawUserId.success) {
    return { error: 'Invalid request.' };
  }

  const userId = scope.data === 'personal' ? (rawUserId.data === '' ? user.id : Number(rawUserId.data)) : null;
  if (scope.data === 'household' && user.role !== 'admin') {
    return { error: 'Only an admin can change rollover for a household budget.' };
  }
  if (scope.data === 'personal' && userId !== user.id && user.role !== 'admin') {
    return { error: 'You can only change rollover for your own personal budgets.' };
  }

  // An unchecked checkbox is simply absent from the submitted form.
  const enabled = formData.get('enabled') === 'on';
  setRollover({ scope: scope.data, userId, categoryId: categoryId.data, enabled, startMonth: month.data });
  revalidatePath('/budgets');
  return { message: enabled ? 'Roll over unspent turned on.' : 'Roll over unspent turned off.' };
}
