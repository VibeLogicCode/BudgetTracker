'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CROSS_ORIGIN_ERROR, isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { markImportRulesReviewed } from '@/lib/import/commit';
import { readEnv } from '@/lib/env';
import { isEventEnabled } from '@/lib/notify/config';
import { CHANNELS } from '@/lib/notify/events';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { flushMonthSummaries } from '@/lib/notify/evaluate/monthly';
import { householdRoutedChannels } from '@/lib/notify/household';
import { kickOutbox } from '@/lib/notify/outbox';
import { checkManualDigest } from '@/lib/notify/ratelimit';

/**
 * v1.26.0 Lane 3b. Dismisses one row of the dashboard's "rules did this, nobody has looked"
 * card (src/components/RuleReviewCard.tsx) -- the standing notice for an import whose rule
 * assignments nobody has checked, per unreviewedRuleImports (src/lib/import/commit.ts).
 *
 * Its own file rather than an addition to an existing actions.ts for the same reason
 * ComingUpCard's BillActionState lives in src/app/(app)/bills/actions.ts: the card that calls
 * this is the dashboard's own, so the action belongs to the page that renders it.
 *
 * tests/ops/use-server-exports.test.ts requires every export here to be an async function, so
 * the state interface below is a type (erased at compile time, exempt).
 */
export interface DismissRuleImportState {
  error?: string;
}

const importIdField = z.coerce.number().int().positive();

/**
 * No confirm dialog on purpose -- markImportRulesReviewed is reversible in the library
 * (`reviewed: false` clears the marker) and destroys nothing, the same reasoning the doc
 * comment on that function gives for why it needs a way back at all. There is no UI for the
 * reverse direction here (see RuleReviewCard's own doc comment for why), but the data itself
 * is never lost by a dismiss.
 *
 * Same guard order every action in this codebase uses: origin first, then auth, then
 * validation, before any write.
 */
export async function dismissRuleImportAction(
  _prev: DismissRuleImportState,
  formData: FormData,
): Promise<DismissRuleImportState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  // unreviewedRuleImports() is deliberately not viewer-scoped (an import is a household-level
  // event, not a per-person one -- see its own doc comment), so dismissing one is likewise not
  // something a self-scoped viewer should be able to do; the card itself is never rendered for
  // one (dashboard/page.tsx), but this route is reachable directly.
  if (isSelfScoped(user)) return { error: 'Not available on this account.' };

  const parsed = importIdField.safeParse(formData.get('importId'));
  if (!parsed.success) return { error: 'Invalid request.' };

  markImportRulesReviewed({ importId: parsed.data });
  revalidatePath('/dashboard');
  return {};
}

/**
 * 2026-09-08, docs/superpowers/specs/2026-09-08-manual-digest-send-design.md. "Send me a summary
 * now" from the dashboard header. The weekly digest already existed; what did not was any way to
 * ask for it between schedules.
 *
 * The SAME report, deliberately -- evaluateWeeklyDigest with a manual token, not a second
 * "spending right now" template. Two reports that mostly agree is a maintenance trap and, worse,
 * a household reading two different numbers for the same week.
 */
export interface SendDigestState {
  error?: string;
  sent?: 'self' | 'household';
}

const digestScopeField = z.enum(['self', 'household']);

/**
 * Guard order, unchanged from every other action here: origin, then auth, then the rate bucket,
 * then validation, then the write. The limiter goes BEFORE the evaluation on purpose -- a refused
 * press must cost nothing, and this evaluation is the expensive one on the page (category
 * breakdown, top merchants, budget progress, review count, and for the household option a query
 * per member).
 *
 * `slotDate` is TODAY in the household's configured timezone, which makes the report cover the
 * seven days ending yesterday -- evaluateWeeklyDigest's own §10.2 window, applied to now instead
 * of to a scheduled slot. A person pressing this on a Wednesday gets last Wednesday to Tuesday,
 * which is the same trailing week the scheduled digest would have given them on that day.
 *
 * The token is minute-precision, so a double-click enqueues one message (the outbox's unique
 * index collapses the second) while a genuine re-send a few minutes later still goes out. That is
 * also why a duplicate press reports success rather than an error: nothing failed, and the person
 * asking twice in one minute wanted one digest, which is what they got.
 */
export async function sendDigestNowAction(
  _prev: SendDigestState,
  formData: FormData,
): Promise<SendDigestState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();

  const parsed = digestScopeField.safeParse(formData.get('scope'));
  if (!parsed.success) return { error: 'Invalid request.' };
  // A self-scoped member sees only their own money everywhere else in the app (ruling R2), so
  // letting them address the whole family channel here would be the one screen that leaks out of
  // that scope. Their own digest is unaffected -- only the household option is refused.
  if (parsed.data === 'household' && isSelfScoped(user)) {
    return { error: 'Not available on this account.' };
  }

  const verdict = checkManualDigest(user.id);
  if (!verdict.allowed) {
    return {
      error: `Too many summaries sent just now. Try again in ${verdict.retryAfterMinutes} minute${verdict.retryAfterMinutes === 1 ? '' : 's'}.`,
    };
  }

  const now = new Date();
  const { tz } = readEnv();

  /**
   * 2026-09-09. The button reports EVERYTHING that is waiting, not just the week.
   *
   * A monthly summary only goes out once its month has been closed, and it is enqueued by whatever
   * pass happens to run next. Somebody who closes September and then presses Send is asking "tell
   * me where we are" -- and a reply that covers the week while September's summary is still
   * pending, unmentioned, is a worse answer than the one they could have waited for.
   *
   * Idempotent and safe to run from a button: every month-boundary key carries the month, so a
   * summary already sent is a no-op, and flushMonthSummaries returns immediately when no month is
   * waiting. It runs BEFORE the weekly send so the two arrive in the order they happened.
   */
  try {
    flushMonthSummaries(now, tz);
  } catch (error) {
    // Never let a pending monthly stop the weekly the person actually pressed the button for.
    console.error('[notify] month summary flush failed on manual send', error);
  }

  const enqueued = evaluateWeeklyDigest({
    userId: user.id,
    slotDate: todayIso(now, tz),
    now,
    manual: { token: now.toISOString().slice(0, 16), includeHousehold: parsed.data === 'household' },
  });

  /**
   * Owner report, 2026-09-08: "i tried pressing send notification and it didnt do anything", for
   * BOTH options. Two separate defects, both in this function, both fixed here.
   *
   * FIRST: the return value was discarded and this returned `sent` unconditionally, so the card
   * said "Summary sent to you" whether or not a single row had been written. 0 means nothing was
   * enqueued, and the person is owed that fact rather than a cheerful lie. The likeliest cause is
   * named in the message, because "nothing happened" with no reason is unactionable: a channel
   * that is configured but switched off entirely has nowhere to deliver to.
   *
   * SECOND, and the reason the household option ALSO did nothing: enqueue() only writes a pending
   * row. Delivery is the scheduler's five-minute tick, so a correctly enqueued digest arrived
   * minutes after the button, long after anybody had stopped looking. kickOutbox() is the existing
   * fire-and-forget drain that every other server action already calls for exactly this reason
   * (see its docblock) -- this action simply never called it.
   */
  if (enqueued === 0) {
    /**
     * Nothing was written, and the two reasons need OPPOSITE messages.
     *
     * No deliverable channel is a real failure with a real fix, and saying so is the whole point of
     * checking the return value at all.
     *
     * A DUPLICATE is not a failure. The manual token is minute-precision, so a second press inside
     * the same minute is collapsed by the outbox's unique index -- deliberately, so an impatient
     * double-click sends one digest rather than two. Reporting that as "Nothing was sent. Check
     * Settings" would send somebody debugging a working feature, which is a worse outcome than the
     * silence this whole fix set out to remove. So: if they CAN receive it, the digest they asked
     * for is on its way, and that is what they are told.
     */
    const canReceive =
      CHANNELS.some((channel) => isEventEnabled(user.id, 'weekly_digest', channel, { ignorePreference: true })) ||
      (parsed.data === 'household' && householdRoutedChannels('weekly_digest').length > 0);
    if (!canReceive) {
      return {
        error:
          'Nothing was sent. Check Settings → Notifications: the summary needs at least one channel ' +
          'switched on, and the household option also needs a family channel set up.',
      };
    }
    // Already queued this minute. Drain anyway -- the earlier press may still be sitting there.
    kickOutbox(now);
    return { sent: parsed.data };
  }

  kickOutbox(now);

  // Still not revalidating /dashboard: nothing this page renders changes.
  return { sent: parsed.data };
}
