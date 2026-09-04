import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { budgetRollover, budgets, transactions } from '@/db/schema';
import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { isSelfScoped } from '@/lib/auth/viewer';
import { currentMonth } from '@/lib/dates';
import { getUserSettings, isEventEnabled, notifiableUsers } from '@/lib/notify/config';
import { CHANNELS, budgetExceededKey, budgetThresholdKey, type BudgetScopeKey } from '@/lib/notify/events';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * MUST-6.18: the fingerprint guard. Budget events are evaluated on EVERY tick so an
 * afternoon import is reported in minutes rather than tomorrow morning (decision 6); the
 * fingerprint is what keeps that cheap.
 *
 * A restart clears this cache and costs exactly one extra evaluation, which is dedup-safe.
 */
let lastBudgetKey: string | null = null;

export function resetBudgetFingerprintForTests(): void {
  lastBudgetKey = null;
}

interface Participant {
  userId: number;
  thresholdPct: number;
  /**
   * S-18 fix (v1.13.0 ruling R2, applied one layer down): carried straight off
   * notifiableUsers()'s own `visibility` column (config.ts), which is the ONLY thing that made
   * this bug possible to fix -- nothing downstream could ask before it existed.
   *
   * Round 1: it feeds enqueue()'s familyChannelOnly flag at the point of firing, NOT a skipped
   * household loop. A household-scope send on a routed channel becomes the FAMILY-CHANNEL row
   * (userId null, householdTarget) and is the whole household's message; what a self-scoped
   * participant must not receive is a PERSONAL delivery carrying household figures. Skipping the
   * loop outright, as round 0 did, silenced the family channel in a household whose opted-in
   * participants are all self-scoped. Their personal loop is untouched either way, so they keep
   * every alert about their own budgets.
   */
  selfScoped: boolean;
}

/** Flatten budgetProgress()'s parent/child tree: parents and children are independent rows. */
function flatten(rows: BudgetRow[], acc: BudgetRow[] = []): BudgetRow[] {
  for (const row of rows) {
    acc.push(row);
    if (row.children.length > 0) flatten(row.children, acc);
  }
  return acc;
}

/**
 * Everything the alertable state (src/lib/budgets.ts effectiveBudget -> buildRow ->
 * BudgetRow.limitCents/pct/spentCents, which fireFor reads verbatim) actually depends on,
 * folded into one comparable string:
 *
 *   - transactions, whole table, unscoped: count + max(id) catch an inserted/deleted row
 *     ANYWHERE, not just the current month; max(updated_at) catches a RE-CATEGORISATION of
 *     an existing row anywhere too (same count, same max id, spentCents still moves because
 *     it's keyed by category). Whole-table rather than scoped to `month` (review fix,
 *     2026-08-23): since rollover shipped, effectiveBudget()'s carry walk
 *     (categorySpendWithRollupSeries in src/lib/budgets.ts) reads up to 24 PRIOR months of
 *     transactions, so a category's CURRENT-month effective limit can change because of a
 *     transaction dated in a month the current-month window never touches. That's the
 *     ROUTINE case for this app's main data-entry paths -- a CSV statement import (a bank
 *     export always covers a past period) or a SimpleFIN lookback sync -- not a rare
 *     coincidence, so a month-scoped aggregate would miss it on every ordinary backdated
 *     import and keep alerting against a stale limit until an unrelated current-month write
 *     happened to move the fingerprint. Deliberately whole-table rather than a rolling
 *     24-month window: a windowed version would have to mirror effectiveBudget's
 *     `addMonths(month, -24)` lookback-floor arithmetic here too, and the two copies
 *     drifting apart later (the constant changing, or becoming per-category) would silently
 *     reopen a narrower version of this same gap. Whole-table has no boundary to get subtly
 *     wrong, still costs one indexed aggregate read -- never a query per category or per
 *     month -- and still collapses to an identical string, preserving the dedup guard,
 *     whenever nothing in the table has actually changed.
 *   - budgets, whole table, unscoped: count + max(id) catch a NEW (scope, user, category,
 *     month) row -- e.g. "set a budget mid-month" firing the same tick rather than waiting
 *     for the next transaction. sum(amount_cents) is the extra piece (review fix,
 *     2026-08-22): budgets has no updated_at column, so an in-place UPDATE to an
 *     ALREADY-EXISTING row -- a changed amount, or a clear to NULL -- moves neither count
 *     nor max(id); it DOES move the sum whenever the new value differs from the old one, in
 *     either direction, including a clear (coalesce(sum(...), 0) below means a row's NULL
 *     contributes 0 to the running total rather than the whole aggregate going NULL, which
 *     is what a bare sum() would return once every row happened to be NULL, or the table
 *     were empty).
 *   - budget_rollover, whole table, unscoped: count + max(id). A row's existence IS
 *     rollover being on for that (scope, user, category) (see the table's doc comment in
 *     src/db/schema.ts) and setRollover only ever inserts or deletes a whole row, never
 *     edits one in place, so count alone already catches a toggle in EITHER direction --
 *     enabling raises it, disabling lowers it. This is the fix for the reviewer's defect:
 *     rollover changes effectiveBudget()'s carry, and therefore limitCents, without
 *     touching transactions or budgets at all, so it needed its own line here.
 *   - participants: a user who just enabled the event, moved their threshold, or had their
 *     VISIBILITY changed is evaluated on the very next tick. selfScoped joined the string in
 *     review round 1 (minor 1) because it changes what that participant is sent: without it a
 *     self-to-household flip left the member with no household alerts until some unrelated
 *     transaction, budget or rollover write happened to move the fingerprint, which on a quiet
 *     install can be days.
 *
 * KNOWN REMAINING GAP, accepted rather than fixed here: sum(amount_cents) is not injective.
 * Two edits landing in the SAME tick whose deltas exactly cancel (row A's amount drops by
 * $5 while row B's rises by $5, nothing else in the table changing) would leave count,
 * max(id) AND sum all unchanged, and so stay invisible until some other transaction/
 * budget/rollover write moves the fingerprint. Closing that would need a per-row
 * updated_at column (a migration -- out of scope for this fix) or a per-row hash (not a
 * cheap aggregate). Judged astronomically unlikely relative to the bug fixed here: it
 * requires two DIFFERENT budget rows edited in the exact same evaluation tick to values
 * whose sum happens to net to zero change.
 */
function fingerprint(month: string, participants: Participant[]): string {
  // Whole table, unscoped -- see doc comment above for why. Still one aggregate query,
  // same shape as the budgets/budget_rollover reads below.
  const row = getDb()
    .select({
      n: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${transactions.id}), 0)`,
      maxUpdated: sql<string>`coalesce(max(${transactions.updatedAt}), '')`,
    })
    .from(transactions)
    .get();

  const budgetRow = getDb()
    .select({
      n: sql<number>`count(*)`,
      maxId: sql<number>`coalesce(max(${budgets.id}), 0)`,
      sumAmt: sql<number>`coalesce(sum(${budgets.amountCents}), 0)`,
    })
    .from(budgets)
    .get();

  const rolloverRow = getDb()
    .select({ n: sql<number>`count(*)`, maxId: sql<number>`coalesce(max(${budgetRollover.id}), 0)` })
    .from(budgetRollover)
    .get();

  const people = participants
    .slice()
    .sort((a, b) => a.userId - b.userId)
    .map((p) => `${p.userId}:${p.thresholdPct}:${p.selfScoped}`)
    .join(',');
  return (
    `${month}|${row?.n ?? 0}|${row?.maxId ?? 0}|${row?.maxUpdated ?? ''}` +
    `|${budgetRow?.n ?? 0}|${budgetRow?.maxId ?? 0}|${budgetRow?.sumAmt ?? 0}` +
    `|${rolloverRow?.n ?? 0}|${rolloverRow?.maxId ?? 0}|${people}`
  );
}

/**
 * The participant set is the union of both budget events: the threshold value only
 * matters for budget_threshold, but a user who has only budget_exceeded on still has to
 * appear in the fingerprint so enabling it re-evaluates on the next tick.
 *
 * Single pass over notifiableUsers(): the original two-loop version (once per event id)
 * called notifiableUsers() twice and, for a user enabled on both events, getUserSettings()
 * twice. This walks the list once and resolves both events' enabled-ness per user before
 * deciding whether to include them, so neither is ever queried more than once per user.
 */
function computeParticipants(): Map<number, Participant> {
  const everyone = new Map<number, Participant>();
  for (const user of notifiableUsers()) {
    const thresholdEnabled = CHANNELS.some((channel) => isEventEnabled(user.id, 'budget_threshold', channel));
    const exceededEnabled = CHANNELS.some((channel) => isEventEnabled(user.id, 'budget_exceeded', channel));
    if (!thresholdEnabled && !exceededEnabled) continue;
    everyone.set(user.id, {
      userId: user.id,
      thresholdPct: getUserSettings(user.id).budgetThresholdPct,
      // Review round 1 (minor 3): isSelfScoped() itself, not a second copy of its rule. Viewer is
      // structural (src/lib/auth/viewer.ts) so a NotifiableUser projects straight onto it, and the
      // admin clause -- an admin's row can never legitimately carry 'self' (setUserVisibility
      // refuses it), but a hand-edited database row must not lock a self-scoped reading onto an
      // admin either -- now lives in one place rather than two that could drift apart.
      selfScoped: isSelfScoped({ id: user.id, role: user.role, visibility: user.visibility }),
    });
  }
  return everyone;
}

function fireFor(input: {
  userId: number;
  scope: BudgetScopeKey;
  row: BudgetRow;
  month: string;
  thresholdPct: number;
  now: Date;
  /** S-18 round 1: set for a self-scoped participant's HOUSEHOLD rows only. See enqueue(). */
  familyChannelOnly?: boolean;
}): number {
  const { row, scope, month, userId, thresholdPct, now, familyChannelOnly } = input;
  if (row.limitCents === null || row.pct === null) return 0;

  let fired = 0;

  // MUST-6.16: both use the pct budgetProgress() already computed, including its $0-limit
  // branch, so the notification can never disagree with the progress bar the user is
  // looking at. MUST-6.17: both may fire in the same evaluation: a single import that
  // jumps straight past 100% still owes the threshold message, so pct is deliberately NOT
  // capped below 100 here; the exceeded check below is independent.
  if (row.pct >= thresholdPct) {
    const { subject, body } = renderEvent({
      event: 'budget_threshold',
      scope,
      categoryName: row.categoryName,
      month,
      pct: row.pct,
      spentCents: row.spentCents,
      limitCents: row.limitCents,
    });
    const result = enqueue({
      userId,
      eventId: 'budget_threshold',
      dedupKey: budgetThresholdKey(scope, row.categoryId, month, thresholdPct),
      subject,
      body,
      // v1.28.0: a PERSONAL budget is one member's, and its dedup key carries no user id (the
      // outbox index supplies that), so routing it to the family channel would collapse two
      // members' alerts into one row and drop the second. See enqueue()'s subjectScope docblock.
      subjectScope: scope,
      familyChannelOnly,
      at: now,
    });
    if (enqueuedAnything(result)) fired += 1;
  }

  if (row.spentCents > row.limitCents) {
    const { subject, body } = renderEvent({
      event: 'budget_exceeded',
      scope,
      categoryName: row.categoryName,
      month,
      spentCents: row.spentCents,
      limitCents: row.limitCents,
    });
    const result = enqueue({
      userId,
      eventId: 'budget_exceeded',
      dedupKey: budgetExceededKey(scope, row.categoryId, month),
      subject,
      body,
      subjectScope: scope,
      familyChannelOnly,
      at: now,
    });
    if (enqueuedAnything(result)) fired += 1;
  }

  return fired;
}

/**
 * MUST-6.15: evaluated on every tick, for the CURRENT MONTH only, over:
 *   - household scope: budgetProgress(month, 'household', null), delivered to every user
 *     with the event enabled;
 *   - personal scope: budgetProgress(month, 'personal', userId), delivered only to that user.
 * Only rows with a resolved limitCents participate. Parents and children are independent
 * (budgetProgress already applies the rollup rule to the parent's spentCents), so a parent
 * and one of its children may each cross and each gets its own message.
 */
export function evaluateBudgets(input: { now: Date; tz: string }): number {
  const month = currentMonth(input.now, input.tz);

  const everyone = computeParticipants();
  if (everyone.size === 0) {
    lastBudgetKey = null;
    return 0;
  }

  const key = fingerprint(month, [...everyone.values()]);
  if (key === lastBudgetKey) return 0;

  let fired = 0;
  const householdRows = flatten(budgetProgress(month, 'household', null));

  for (const person of everyone.values()) {
    // S-18 fix (v1.13.0 ruling R2), round 1: the household rows are fired for EVERY participant,
    // self-scoped or not, because on a routed channel that send IS the family-channel row -- one
    // message to the room, addressed to nobody (enqueue's userId: null / householdTarget branch).
    // What familyChannelOnly withholds is the per-user delivery on the channels where the family
    // channel did not take it, which is the only path by which a household category name, amount
    // or limit could reach a self-scoped member's own inbox. Round 0 skipped this loop entirely
    // for them, which removed a family-channel contribution and protected nobody: in a household
    // where every opted-in participant is self-scoped it stopped family budget alerts outright.
    // Their personal loop below is untouched either way.
    for (const row of householdRows) {
      fired += fireFor({
        userId: person.userId,
        scope: 'household',
        row,
        month,
        thresholdPct: person.thresholdPct,
        now: input.now,
        familyChannelOnly: person.selfScoped,
      });
    }
    for (const row of flatten(budgetProgress(month, 'personal', person.userId))) {
      fired += fireFor({ userId: person.userId, scope: 'personal', row, month, thresholdPct: person.thresholdPct, now: input.now });
    }
  }

  // Review fix (MINOR): recorded only once every participant has been processed without
  // throwing. Setting this before the loop meant one participant's row throwing (a
  // transient error, say) burned the fingerprint for the WHOLE household until the
  // underlying data changed again, silently suppressing everyone else's notifications
  // until then. A retried evaluation with the same fingerprint is dedup-safe: every
  // enqueue() is itself idempotent (MUST-3.9), so re-running it costs nothing.
  lastBudgetKey = key;
  return fired;
}
