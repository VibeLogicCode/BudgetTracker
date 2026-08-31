'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { canActOnOwner } from '@/lib/auth/viewer';
import { addContribution, archiveGoal, createGoal, deleteContribution, getGoal, listContributions } from '@/lib/goals';
import { isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';

export interface GoalActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';

// '' or 'shared' means a household goal; anything else must be a positive integer user id.
const ownerField = z.string().trim().refine((v) => v === '' || v === 'shared' || /^\d+$/.test(v), { message: 'Invalid owner selection.' });
const idField = z.coerce.number().int().positive();

export async function createGoalAction(_prev: GoalActionState, formData: FormData): Promise<GoalActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const ownerParsed = ownerField.safeParse(String(formData.get('owner') ?? 'shared'));
  if (!ownerParsed.success) return { error: 'Invalid request.' };
  const ownerUserId = ownerParsed.data === '' || ownerParsed.data === 'shared' ? null : Number(ownerParsed.data);
  if (!canActOnOwner(ownerUserId, user)) return { error: 'You can only create goals for yourself or shared.' };

  const targetCents = parseAmountToCents(String(formData.get('target') ?? ''));
  if (targetCents === null || targetCents <= 0) return { error: 'Enter a target amount greater than zero.' };

  const rawDate = String(formData.get('targetDate') ?? '').trim();
  if (rawDate !== '' && !isIsoDate(rawDate)) return { error: 'Target date must be YYYY-MM-DD.' };

  try {
    createGoal({
      name: String(formData.get('name') ?? ''),
      ownerUserId,
      targetCents,
      targetDate: rawDate === '' ? null : rawDate,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create the goal.' };
  }
  revalidatePath('/goals');
  // v1.20.0 (goal creation moves to its own route, /goals/new, matching /warranties/new):
  // redirect() rather than a returned message, the same shape createWarrantyAction already
  // uses -- the "New goal" form no longer lives on a page it can leave a notice on top of, so
  // there is nowhere for a returned `message` to be read. Landing back on /goals shows the new
  // card directly, which says "created" more plainly than a banner would. Outside the try:
  // redirect() signals by throwing, and catching it would swallow it.
  redirect('/goals');
}

export async function addContributionAction(_prev: GoalActionState, formData: FormData): Promise<GoalActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const goalIdParsed = idField.safeParse(formData.get('goalId'));
  if (!goalIdParsed.success) return { error: 'Invalid goal.' };

  const goal = getGoal(goalIdParsed.data, user);
  if (!goal) return { error: 'Goal not found.' };
  if (!canActOnOwner(goal.ownerUserId, user)) return { error: 'You can only log contributions to your own or shared goals.' };

  const amountCents = parseAmountToCents(String(formData.get('amount') ?? ''));
  const date = String(formData.get('date') ?? '');
  if (amountCents === null || amountCents === 0) return { error: 'Enter an amount.' };
  if (!isIsoDate(date)) return { error: 'Date must be YYYY-MM-DD.' };

  const note = String(formData.get('note') ?? '').trim();
  addContribution({ goalId: goal.id, userId: user.id, amountCents, date, note: note === '' ? null : note });
  revalidatePath('/goals');
  return { message: 'Contribution logged.' };
}

export async function archiveGoalAction(_prev: GoalActionState, formData: FormData): Promise<GoalActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const goalIdParsed = idField.safeParse(formData.get('goalId'));
  if (!goalIdParsed.success) return { error: 'Invalid goal.' };

  const goal = getGoal(goalIdParsed.data, user);
  if (!goal) return { error: 'Goal not found.' };
  if (!canActOnOwner(goal.ownerUserId, user)) return { error: 'You can only archive your own or shared goals.' };

  const archived = formData.get('archived') === '1';
  archiveGoal(goal.id, archived);
  revalidatePath('/goals');
  return { message: archived ? 'Goal archived.' : 'Goal restored.' };
}

export async function deleteContributionAction(_prev: GoalActionState, formData: FormData): Promise<GoalActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const goalIdParsed = idField.safeParse(formData.get('goalId'));
  const contributionIdParsed = idField.safeParse(formData.get('contributionId'));
  if (!goalIdParsed.success || !contributionIdParsed.success) return { error: 'Invalid request.' };

  const goal = getGoal(goalIdParsed.data, user);
  if (!goal) return { error: 'Goal not found.' };
  if (!canActOnOwner(goal.ownerUserId, user)) return { error: 'You can only remove contributions from your own or shared goals.' };

  // Cross-check that the contribution actually belongs to this goal, so a caller cannot
  // pair a goal they own with a contributionId that belongs to someone else's goal.
  const contribution = listContributions(goal.id, user).find((row) => row.id === contributionIdParsed.data);
  if (!contribution) return { error: 'Contribution not found.' };

  deleteContribution(contribution.id);
  revalidatePath('/goals');
  return { message: 'Contribution removed.' };
}
