/**
 * The two GitHub request budgets, and the one place either number is written down.
 *
 * PURE (MUST-2.1): no import of any kind, for the same reason src/lib/update/semver.ts is —
 * src/app/(app)/settings/updates-client.tsx imports GITHUB_INTERACTIVE_TIMEOUT_MS to tell the
 * reader how long the button may sit there, and github.ts itself pulls @/lib/notify/render,
 * which reaches the database client. Splitting these two integers out of github.ts is what lets
 * the sentence on screen and the AbortSignal that enforces it be the SAME number rather than a
 * copy kept in step by a comment. Rejected alternative: hardcoding "a few seconds" in the copy,
 * which would have gone stale the first time either budget moved.
 *
 * v1.32.0 (UP-1). Until this release there was one 15-second budget for both callers, and a
 * person pressing Check now could watch a button say "Working…" for fifteen seconds beside a
 * "last checked" line still showing a stamp from hours earlier. The two callers are not alike:
 */

/**
 * The daily scheduled check (src/lib/scheduler.ts -> runUpdateCheck with no `manual` flag).
 *
 * Nobody is waiting at 04:00, and the next automatic attempt is a full 24 hours away
 * (MUST-5.5), so giving up early here costs the household a whole day's check to save a wait
 * that no one is sitting through. A slow DNS resolution on a home connection, a NAS that has
 * just woken its disks, a GitHub edge having a bad minute — all of them are worth waiting out
 * when the alternative is silence until tomorrow. Unchanged from v1.3.1.
 */
export const GITHUB_SCHEDULED_TIMEOUT_MS = 15_000;

/**
 * Every request a person is watching: Check now (runUpdateCheck with `manual: true`) and the
 * Review and update panel's changelog read.
 *
 * Five seconds, because a button that has not answered in five is indistinguishable from a
 * button that is never going to — the owner's own recording of a real update shows them
 * reloading the page at about 22 seconds, which is exactly the reflex the previous release set
 * out to remove. The worst case a household now sees is five seconds of a labelled wait and
 * then a plain sentence saying GitHub did not answer, with the button right there to press
 * again. api.github.com answers this endpoint in well under a second when it answers at all,
 * so the requests this gives up on are overwhelmingly the ones that were not going to arrive.
 *
 * Rejected alternative: one budget for both, tuned to some middle value. That trades a real
 * cost on the unattended path (a missed day) against a real cost on the attended one (a person
 * who thinks the app has hung) to avoid naming two numbers, and the two paths genuinely do
 * want different answers.
 */
export const GITHUB_INTERACTIVE_TIMEOUT_MS = 5_000;

/**
 * Whole seconds, for copy and for error messages. One definition so the number the card
 * promises and the number an expired request reports can never disagree by a rounding rule.
 */
export function timeoutSeconds(ms: number): number {
  return Math.round(ms / 1000);
}
