import { budgetProgress, flattenBudgetRows, type BudgetRow } from '@/lib/budgets';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, type Viewer } from '@/lib/auth/viewer';
import { currentMonth, monthEnd, todayIso } from '@/lib/dates';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS, budgetPaceKey, type BudgetScopeKey } from '@/lib/notify/events';
import { householdRoutedChannels } from '@/lib/notify/household';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { PACE_MAX_PER_EVALUATION, PACE_MIN_DAY_OF_MONTH, PACE_OVERSHOOT_MIN_PCT } from '@/lib/predict/constants';
import { projectMonthEnd } from '@/lib/predict/pace';

/**
 * S-18 fix (v1.13.0 ruling R2, applied one layer down). This evaluator runs once per user
 * (unlike evaluate/budget.ts, which batches every participant in one pass), so it has no
 * NotifiableUser row of its own to read visibility off -- it needs its own lookup instead.
 *
 * Deliberately its OWN copy rather than importing digest.ts's or monthly.ts's identical-looking
 * helper: each of these four evaluators is investigated and fixed independently, and none
 * exports the other three's internals as test-only surface. See digest.ts's own viewerFor
 * docblock for the fuller reasoning; monthly.ts's copy states the same "kept local rather than
 * shared" choice explicitly.
 *
 * Returns null when the recipient's own row is gone by the time this runs (a deleted account
 * mid-batch) -- matching the other three evaluators' item BK precedent: sending nothing is safe,
 * guessing a scope for a viewer this function cannot identify is not.
 */
function viewerFor(userId: number): Viewer | null {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : null;
}

/**
 * MUST-10.8: no fingerprint. This runs at most once per user per day by construction, and its
 * dedup key makes a second run inside the catch-up window a no-op.
 *
 * v1.12.1 (ruling P2): flattenBudgetRows now LIVES in src/lib/budgets.ts, beside budgetProgress
 * and budgetTotals, because budgetTotals needs it too and a money helper importing from
 * src/lib/notify/** would be the wrong way round. It is re-exported here so monthly.ts's import
 * and budgets/page.tsx's import keep resolving unchanged -- one definition, two names for the same
 * path, and no third traversal anywhere.
 */
export { flattenBudgetRows } from '@/lib/budgets';

/** One row that cleared every fire condition except the per-evaluation cap. */
interface PaceCandidate {
  scope: BudgetScopeKey;
  row: BudgetRow;
  projectedCents: number;
  /** How far over the limit the projection lands. Sorting on this picks the worst overshoots. */
  overshootCents: number;
}

/**
 * MEDIUM fix (final-fix-wave item 3): the fire conditions only, with no enqueue. Split out so
 * evaluateBudgetPace can collect every qualifying row across both scopes before deciding which
 * ones to send, the same shape findUnusual/findDuplicates/creepVerdict already use for their own
 * MAX_PER_EVALUATION caps.
 */
function candidateFor(input: {
  scope: BudgetScopeKey;
  row: BudgetRow;
  dayOfMonth: number;
  daysInMonth: number;
}): PaceCandidate | null {
  const { row } = input;
  // Condition 2: a zero limit is budget_exceeded's business, not a projection's.
  if (row.limitCents === null || row.limitCents <= 0) return null;
  // Condition 3: a budget already blown is budget_exceeded's message. The two are mutually
  // exclusive by construction, not by ordering.
  if (row.spentCents > row.limitCents) return null;

  // MUST-8.7: spentCents is the number already on the progress bar, not a re-query.
  const projectedCents = projectMonthEnd({
    spentCents: row.spentCents,
    dayOfMonth: input.dayOfMonth,
    daysInMonth: input.daysInMonth,
  });
  if (projectedCents === null) return null;
  // Condition 4: a projected 3 percent overshoot on the 7th is noise; 10 percent is a number
  // worth acting on. Integer comparison, no float ratio (MUST-3.5).
  if (projectedCents * 100 < row.limitCents * PACE_OVERSHOOT_MIN_PCT) return null;

  return { scope: input.scope, row, projectedCents, overshootCents: projectedCents - row.limitCents };
}

function enqueuePaceCandidate(input: {
  userId: number;
  month: string;
  dayOfMonth: number;
  now: Date;
  candidate: PaceCandidate;
  /** The RECIPIENT's own scope, resolved once by the caller. See the familyChannelOnly line. */
  selfScoped: boolean;
}): number {
  const { candidate } = input;
  const { subject, body } = renderEvent({
    event: 'budget_pace',
    scope: candidate.scope,
    categoryName: candidate.row.categoryName,
    month: input.month,
    // limitCents is non-null by construction: candidateFor() already refused a null one.
    limitCents: candidate.row.limitCents as number,
    spentCents: candidate.row.spentCents,
    dayOfMonth: input.dayOfMonth,
    projectedCents: candidate.projectedCents,
  });
  const result = enqueue({
    userId: input.userId,
    eventId: 'budget_pace',
    dedupKey: budgetPaceKey(candidate.scope, candidate.row.categoryId, input.month),
    subject,
    body,
    // v1.28.0: same reasoning as evaluate/budget.ts -- a personal-scope projection is one
    // member's business and its key is not per-user, so it is never routable.
    subjectScope: candidate.scope,
    // S-18 round 1: a self-scoped recipient's HOUSEHOLD projection may become the family-channel
    // row but never a personal delivery to them. Guarded on the candidate's scope, not on
    // selfScoped alone: a personal-scope send is not routable at all, so pairing the two would
    // enqueue nothing and delete this recipient's own pace alerts along with the leak.
    familyChannelOnly: input.selfScoped && candidate.scope === 'household',
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * MUST-9.6: the user's daily slot, the CURRENT MONTH only, over the same two scopes
 * evaluateBudgets() walks. Household rows are delivered to every HOUSEHOLD-VISIBILITY (or
 * admin) user with the event enabled (this function is called once per user, so that happens
 * across calls); personal rows are evaluated per user and delivered only to that user.
 *
 * S-18 fix (v1.13.0 ruling R2, applied one layer down), round 1: a self-scoped recipient's
 * household projections still fire, because on a routed channel that send IS the family-channel
 * row -- one message to the room, not to them (enqueue's userId: null branch). What they never
 * get is the PERSONAL delivery carrying those figures, withheld by enqueue's familyChannelOnly.
 * Round 0 dropped the household scope from their `scopes` array outright, which removed a
 * family-channel contribution and protected nobody. With NO routed channel there is no room to
 * feed, so the household read is skipped entirely rather than run and discarded -- see below.
 *
 * MEDIUM fix (final-fix-wave item 3): capped at PACE_MAX_PER_EVALUATION, largest overshoot
 * first, mirroring UNUSUAL_MAX_PER_EVALUATION / CREEP_MAX_PER_EVALUATION /
 * DUPLICATE_MAX_PER_EVALUATION. Without it, day 7 of a 31-day month fires the moment spend
 * reaches 24.8 percent of the limit, which roughly half of all budgeted categories clear on
 * the very first day the projection is allowed to run.
 */
export function evaluateBudgetPace(input: { userId: number; now: Date; tz: string }): number {
  if (!CHANNELS.some((channel) => isEventEnabled(input.userId, 'budget_pace', channel))) return 0;

  const today = todayIso(input.now, input.tz);
  const dayOfMonth = Number(today.slice(8, 10));
  // MUST-9.6 condition 1, checked before any budget or user read. Review round 1 (minor 2): the
  // viewerFor() lookup below used to sit ABOVE this line, which made the old wording ("before any
  // query") false -- findUserById ran on the 1st of the month for every user, only to be thrown
  // away. The enabled-ness check above is now the one query that precedes this guard, and it is
  // the check that decides whether this evaluation happens at all.
  if (dayOfMonth < PACE_MIN_DAY_OF_MONTH) return 0;

  const viewer = viewerFor(input.userId);
  // Item BK precedent (see this file's own viewerFor docblock): 0 already means "nothing
  // enqueued" to every caller.
  if (viewer === null) return 0;
  const selfScoped = isSelfScoped(viewer);

  const month = currentMonth(input.now, input.tz);
  // MUST-8.2: from monthEnd, so February is 29 days in 2028 without a leap-year rule here.
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  // S-18 fix (v1.13.0 ruling R2), round 1: for a self-scoped recipient the household rows exist
  // SOLELY to feed the family channel (enqueue's familyChannelOnly, set below), so with nothing
  // routed there is no room to feed and the up-to-24-month household read is skipped outright
  // rather than run and discarded -- HOUSEHOLD_ONLY_AT_PAGE's own "no household figure leaves
  // this file, even unrendered" rule, and the same routed-first ordering evaluate/digest.ts uses.
  // Everyone else keeps both scopes unconditionally, exactly as before either round of this fix.
  const wantsHousehold = !selfScoped || householdRoutedChannels('budget_pace').length > 0;
  const scopes: { scope: BudgetScopeKey; rows: BudgetRow[] }[] = [
    ...(wantsHousehold
      ? [{ scope: 'household' as const, rows: flattenBudgetRows(budgetProgress(month, 'household', null)) }]
      : []),
    { scope: 'personal', rows: flattenBudgetRows(budgetProgress(month, 'personal', input.userId)) },
  ];

  const candidates: PaceCandidate[] = [];
  for (const { scope, rows } of scopes) {
    for (const row of rows) {
      const candidate = candidateFor({ scope, row, dayOfMonth, daysInMonth });
      if (candidate !== null) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.overshootCents - a.overshootCents);

  let fired = 0;
  for (const candidate of candidates.slice(0, PACE_MAX_PER_EVALUATION)) {
    fired += enqueuePaceCandidate({ userId: input.userId, month, dayOfMonth, now: input.now, candidate, selfScoped });
  }
  return fired;
}
