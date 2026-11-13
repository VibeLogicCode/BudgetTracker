import { budgetProgress, budgetTotals, flattenBudgetRows, type BudgetRow } from '@/lib/budgets';
import { viewerFor } from '@/lib/auth/users';
import { HOUSEHOLD_VIEWER, isSelfScoped } from '@/lib/auth/viewer';
import { currentMonth, todayIso } from '@/lib/dates';
import { monthCheckIn, type CheckIn } from '@/lib/month-checkin';
import { isEventEnabled } from '@/lib/notify/config';
import { familyChannelNeedsOwnPass } from '@/lib/notify/family-pass';
import { CHANNELS, budgetPaceKey, type BudgetScopeKey } from '@/lib/notify/events';
import { householdRoutedChannels } from '@/lib/notify/household';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { PACE_MAX_PER_EVALUATION, PACE_MIN_DAY_OF_MONTH, PACE_OVERSHOOT_MIN_PCT } from '@/lib/predict/constants';

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
  /** v1.62.0: the scope's month check-in, one per scope per evaluation (src/lib/month-checkin.ts). */
  checkIns: ReadonlyMap<number, CheckIn>;
}): PaceCandidate | null {
  const { row } = input;
  // Condition 2: a zero limit is budget_exceeded's business, not a projection's.
  if (row.limitCents === null || row.limitCents <= 0) return null;
  // Condition 3: a budget already over is budget_exceeded's message. The two are mutually
  // exclusive by construction, not by ordering.
  if (row.spentCents > row.limitCents) return null;

  // MUST-8.7: the check-in starts from spentCents, the number already on the progress bar. v1.62.0:
  // the same figure the Budgets card reads as "Heading for" -- spent, plus what is still due, plus
  // the usual rest of the month -- so a rent paid on the 1st no longer projects as several rents.
  const projectedCents = input.checkIns.get(row.categoryId)?.projectedCents ?? null;
  if (projectedCents === null) return null;
  // Condition 4: a projected 3 percent overshoot on the 7th is noise; 10 percent is a number
  // worth acting on. Integer comparison, no float ratio (MUST-3.5).
  if (projectedCents * 100 < row.limitCents * PACE_OVERSHOOT_MIN_PCT) return null;

  return { scope: input.scope, row, projectedCents, overshootCents: projectedCents - row.limitCents };
}

function enqueuePaceCandidate(input: {
  /** v1.32.0 (R23): null is THE HOUSEHOLD'S own pass. See enqueue()'s `userId` docblock. */
  userId: number | null;
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
 * v1.32.0 (ruling R23): also called ONCE PER TICK-SLOT WITH `userId: null`, from the household's
 * own block in evaluate/index.ts, when the family channel is subscribed and nobody in the household
 * is. That pass reads through HOUSEHOLD_VIEWER and projects the household scope alone -- see the
 * `recipient` branches below, and src/lib/notify/family-pass.ts for why the family channel is a
 * subscriber in its own right rather than a fan-out of the members'.
 *
 * MEDIUM fix (final-fix-wave item 3): capped at PACE_MAX_PER_EVALUATION, largest overshoot
 * first, mirroring UNUSUAL_MAX_PER_EVALUATION / CREEP_MAX_PER_EVALUATION /
 * DUPLICATE_MAX_PER_EVALUATION. Without it, day 7 of a 31-day month fires the moment spend
 * reaches 24.8 percent of the limit, which roughly half of all budgeted categories clear on
 * the very first day the projection is allowed to run.
 */
export function evaluateBudgetPace(input: { userId: number | null; now: Date; tz: string }): number {
  // v1.32.0 (ruling R23). A null userId is THE HOUSEHOLD'S own pass, run from the household's own
  // daily slot in evaluate/index.ts: the family channel subscribes to budget_pace in its own right,
  // and before this ruling a household where nobody had the event switched on personally returned
  // on the line below and the family channel got nothing, for ever, with nothing to say why.
  const recipient = input.userId;
  if (recipient === null) {
    if (!familyChannelNeedsOwnPass('budget_pace')) return 0;
  } else if (!CHANNELS.some((channel) => isEventEnabled(recipient, 'budget_pace', channel))) {
    return 0;
  }

  const today = todayIso(input.now, input.tz);
  const dayOfMonth = Number(today.slice(8, 10));
  // MUST-9.6 condition 1, checked before any budget or user read. Review round 1 (minor 2): the
  // viewerFor() lookup below used to sit ABOVE this line, which made the old wording ("before any
  // query") false -- viewerFor's own user read ran on the 1st of the month for every user, only
  // to be thrown away. The enabled-ness check above is now the one query that precedes this
  // guard, and it is the check that decides whether this evaluation happens at all.
  if (dayOfMonth < PACE_MIN_DAY_OF_MONTH) return 0;

  // The household reads as HOUSEHOLD_VIEWER, which is what "no owner restriction" means
  // (src/lib/auth/viewer.ts) and the same viewer the family channel's digests are already rendered
  // through. It is never self-scoped: there is no person for a household figure to be withheld
  // from, which is also why the personal scope below is skipped for it entirely.
  const viewer = recipient === null ? HOUSEHOLD_VIEWER : viewerFor(recipient);
  // Item BK precedent (see viewerFor's docblock, src/lib/auth/users.ts): 0 already means "nothing
  // enqueued" to every caller.
  if (viewer === null) return 0;
  const selfScoped = isSelfScoped(viewer);

  const month = currentMonth(input.now, input.tz);

  // S-18 fix (v1.13.0 ruling R2), round 1: for a self-scoped recipient the household rows exist
  // SOLELY to feed the family channel (enqueue's familyChannelOnly, set below), so with nothing
  // routed there is no room to feed and the up-to-24-month household read is skipped outright
  // rather than run and discarded -- HOUSEHOLD_ONLY_AT_PAGE's own "no household figure leaves
  // this file, even unrendered" rule, and the same routed-first ordering evaluate/digest.ts uses.
  // Everyone else keeps both scopes unconditionally, exactly as before either round of this fix.
  const wantsHousehold = !selfScoped || householdRoutedChannels('budget_pace').length > 0;
  const scopes: { scope: BudgetScopeKey; rows: BudgetRow[] }[] = [
    ...(wantsHousehold ? [{ scope: 'household' as const, rows: budgetProgress(month, 'household', null) }] : []),
    // R23: the household has no personal budgets to project, and a personal-scope send is not
    // routable at all (enqueue's subjectScope), so its pass reads the household scope alone.
    ...(recipient === null ? [] : [{ scope: 'personal' as const, rows: budgetProgress(month, 'personal', recipient) }]),
  ];

  const candidates: PaceCandidate[] = [];
  for (const { scope, rows } of scopes) {
    // v1.62.0: one month check-in per scope per evaluation, over the rows already read. The
    // household's is read as HOUSEHOLD_VIEWER whoever the recipient is: it is the household's own
    // figure, and for a self-scoped recipient it only ever reaches the family channel (below).
    const checkIn =
      scope === 'household'
        ? monthCheckIn({ month, today, scope, userId: null, rows, viewer: HOUSEHOLD_VIEWER, spentTotalCents: budgetTotals(rows).totalSpentCents })
        : monthCheckIn({ month, today, scope, userId: recipient, rows, viewer, spentTotalCents: budgetTotals(rows).totalSpentCents });
    const checkIns = checkIn?.byCategory ?? new Map<number, CheckIn>();
    for (const row of flattenBudgetRows(rows)) {
      const candidate = candidateFor({ scope, row, checkIns });
      if (candidate !== null) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.overshootCents - a.overshootCents);

  let fired = 0;
  for (const candidate of candidates.slice(0, PACE_MAX_PER_EVALUATION)) {
    fired += enqueuePaceCandidate({ userId: recipient, month, dayOfMonth, now: input.now, candidate, selfScoped });
  }
  return fired;
}
