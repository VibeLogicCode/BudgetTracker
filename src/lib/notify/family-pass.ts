import { DEFAULT_USER_SETTINGS, isEventEnabled, notifiableUsers, type UserSettings } from '@/lib/notify/config';
import { CHANNELS } from '@/lib/notify/events';
import { householdRoutedChannels } from '@/lib/notify/household';

/**
 * v1.32.0, RULING R23. "A family-channel notification row is only ever written during some
 * individual's evaluation pass, so an event nobody has enabled personally produces no family row
 * at all." The family channel was configured, enabled and silent, and nothing told the household
 * why. v1.31.0 made it likelier by narrowing the two anomaly events to admins: fewer people
 * evaluating means more events with nobody to trigger the family row.
 *
 * THE DESIGN QUESTION, ANSWERED: a family-channel subscription is A THING IN ITS OWN RIGHT, not a
 * fan-out of individual subscriptions. The data model already said so and only the evaluators
 * disagreed -- notification_household_prefs is keyed by (event_id, channel) with no user column,
 * setHouseholdEventPref is an admin action about the household, isHouseholdRouted consults no
 * person, and the outbox row it produces carries user_id NULL and is addressed to a room. The
 * settings matrix renders that household column straight from the registry. Everything about the
 * family channel was already first-class EXCEPT the moment its row got written, which was borrowed
 * from whichever member happened to be evaluating.
 *
 * So the household gets what a subscriber has: its own pass. `userId: null` through enqueue()
 * (src/lib/notify/outbox.ts), reads through HOUSEHOLD_VIEWER (src/lib/auth/viewer.ts), and the
 * settings below for the two per-person numbers a household message needs and the family channel
 * has no preferences page to supply.
 *
 * THE ALTERNATIVE REJECTED, and it was close: make the household the SOLE writer of every family
 * row -- enqueue stops writing one during a member's pass entirely, and all fourteen
 * household-eligible events get a household pass. That is the purer shape of the same decision and
 * it fixes one thing this does not (see the budget_threshold note below). It was rejected because
 * it changes the writer of the family row for coming_due and weekly_digest, the two eligible events
 * that have NO defect here -- both evaluators run for every notifiable user regardless of that
 * user's preferences, so their family row was never missing -- and because it would rewrite the
 * delivery path of fourteen events, and the tests that pin last release's S-18 and finding-I-1
 * rulings to them, inside a defects release. What this ships instead is mutually exclusive with the
 * member path by construction (see below), which is the property that actually matters: no message
 * can be sent twice.
 *
 * KNOWN LIMIT, stated rather than hidden: when at least one member IS subscribed, the family row is
 * still written during that member's pass, and for budget_threshold alone its dedup key carries
 * that member's own threshold percentage (budgetThresholdKey, src/lib/notify/events.ts). Two members
 * with different thresholds have always been able to put two rows for one category into the family
 * channel that way. That is a pre-existing defect of the member path, untouched here and not
 * widened by anything below; the household pass uses HOUSEHOLD_PASS_SETTINGS.budgetThresholdPct and
 * runs only when no member is subscribed, so it can never be the second of such a pair.
 */

/**
 * The household's own settings. The family channel is not a person: it has no row in
 * notification_user_settings, no preferences page and nobody whose numbers it could borrow without
 * becoming the fan-out this ruling rejects. It uses the app's documented defaults -- which is also
 * what every member who has never touched their own settings uses (§3.5), so the family channel's
 * daily report lands at the same hour as the household's, and its budget threshold is the same 80
 * percent the app has always meant by "getting close".
 *
 * Deliberately NOT the lowest, highest or most common threshold among the members: all three are
 * derived from a roster that changes, so the family row's dedup key would change with it and a
 * member editing their own settings would conjure a second alert about the same category into the
 * group chat. A constant cannot do that.
 */
export const HOUSEHOLD_PASS_SETTINGS: UserSettings = DEFAULT_USER_SETTINGS;

/**
 * "Does the family channel need to evaluate this event itself?" -- true when an admin has routed
 * the event to a family channel AND nobody in the household has it switched on personally.
 *
 * BOTH HALVES ARE LOAD-BEARING. The first is the household's subscription: with nothing routed
 * there is no family channel to write to, and a household pass would render a message for nobody.
 * The second is what makes the household pass and the member path MUTUALLY EXCLUSIVE, which is how
 * "no duplicate sends" is established here -- not by relying on the outbox's unique index to
 * collapse two writers' rows, but by there never being two writers. A household that has both the
 * family channel and a member subscribed takes exactly the path it took before this ruling.
 *
 * Deliberately "nobody, on any channel" rather than per channel: the member path's enqueue() writes
 * the family row on EVERY routed channel once it is reached (its routed branch does not consult
 * isEventEnabled, by design -- the household row is the household's decision, not the sum of five
 * people's toggles), so one member subscribed on email alone is already enough to write the family
 * TELEGRAM row too. A per-channel test here would therefore find "telegram unserved", run a second
 * pass, and be wrong.
 *
 * COST: one notifiableUsers() read plus up to two isEventEnabled() calls per user, and it
 * short-circuits on the routing check first -- so a household that has routed nothing (the default,
 * and the common case) pays one indexed read per event and nothing else.
 */
export function familyChannelNeedsOwnPass(eventId: string): boolean {
  if (householdRoutedChannels(eventId).length === 0) return false;
  return !notifiableUsers().some((user) =>
    CHANNELS.some((channel) => isEventEnabled(user.id, eventId, channel)),
  );
}
