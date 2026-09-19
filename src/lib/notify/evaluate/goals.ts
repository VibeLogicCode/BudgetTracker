/**
 * Savings-goal notifications (ledger spec N6).
 *
 * Two events off the pace figures `listGoals` already computes, so the message and the Goals page
 * can never disagree: reaching a target, and falling behind one that has a date on it.
 *
 * A goal with no target date has no pace to be behind -- it is a pot, not a plan -- so only the
 * first event can ever fire for it.
 */
import { todayIso } from '@/lib/dates';
import { listGoals } from '@/lib/goals';
import { viewerFor } from '@/lib/auth/users';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS } from '@/lib/notify/events';
import { familyChannelNeedsOwnPass } from '@/lib/notify/family-pass';
import { enqueue, kickOutbox } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * How far behind counts as behind. A quarter over the average, not a penny over: a goal drifts by
 * a few pounds every month and a message about that is noise, not news.
 */
const BEHIND_FACTOR = 1.25;

/**
 * The subscription gate, with the event id spelled out rather than passed through -- see the same
 * note in evaluate/loans.ts. tests/ops/family-channel-pass.test.ts reads these literals.
 */
function subscribed(eventId: 'goal_reached' | 'goal_off_pace', userId: number | null): boolean {
  if (userId === null) {
    return eventId === 'goal_reached'
      ? familyChannelNeedsOwnPass('goal_reached')
      : familyChannelNeedsOwnPass('goal_off_pace');
  }
  return CHANNELS.some((channel) => isEventEnabled(userId, eventId, channel));
}

/**
 * N6. Both goal events for one recipient, evaluated together because they read the same rows.
 *
 * `goal_reached` is keyed on the goal alone, so it is said once and never again. `goal_off_pace`
 * carries the month, so it asks once a month while the goal stays behind rather than every day.
 */
export function evaluateGoals(input: { userId: number | null; now: Date; tz: string }): number {
  const today = todayIso(input.now, input.tz);
  // A user who has gone since the tick was scheduled has no goals to report on.
  const viewer = input.userId === null ? HOUSEHOLD_VIEWER : viewerFor(input.userId);
  if (viewer === null) return 0;
  const goals = listGoals({ today }, viewer);
  if (goals.length === 0) return 0;

  let sent = 0;

  if (subscribed('goal_reached', input.userId)) {
    for (const goal of goals) {
      if (!goal.pace.met) continue;
      const { subject, body } = renderEvent({
        event: 'goal_reached',
        goalName: goal.name,
        targetCents: goal.targetCents,
      });
      sent += enqueue({
        userId: input.userId,
        eventId: 'goal_reached',
        dedupKey: `goal:met:${goal.id}`,
        subject,
        body,
        at: input.now,
      }).inserted.length;
    }
  }

  if (subscribed('goal_off_pace', input.userId)) {
    for (const goal of goals) {
      if (goal.pace.met || goal.targetDate === null) continue;
      const required = goal.pace.requiredMonthlyCents;
      if (required === null) continue;
      // A goal nothing has been put into yet is behind by definition; that is still worth saying,
      // which is why the comparison is against the average rather than against zero contributions.
      if (required <= goal.pace.avgMonthlyCents * BEHIND_FACTOR) continue;
      const { subject, body } = renderEvent({
        event: 'goal_off_pace',
        goalName: goal.name,
        requiredMonthlyCents: required,
        avgMonthlyCents: goal.pace.avgMonthlyCents,
        targetDate: goal.targetDate,
      });
      sent += enqueue({
        userId: input.userId,
        eventId: 'goal_off_pace',
        dedupKey: `goal:pace:${goal.id}:${today.slice(0, 7)}`,
        subject,
        body,
        at: input.now,
      }).inserted.length;
    }
  }

  if (sent > 0) kickOutbox(input.now);
  return sent;
}
