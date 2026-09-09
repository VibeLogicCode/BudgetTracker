import { formatSemver, parseSemver } from '@/lib/update/semver';

/**
 * v1.32.0 (UP-2). The one definition of "this browser was told, a moment ago, that the app is
 * about to be replaced".
 *
 * The symptom, from the owner's recording of a real update on their NAS: press Update now,
 * Watchtower pulls the new image and kills the container, the tab is still sitting on the app,
 * and Next renders src/app/(app)/error.tsx — which says "The app could not finish loading this
 * screen… this usually clears on its own". Every word of that is right for a crash and wrong
 * for a restart the household authorised thirty seconds earlier. Then the socket dies and the
 * browser shows its own ERR_CONNECTION_RESET page, which nothing in this repo can change and
 * which this module does not pretend to.
 *
 * MUST-9.9 forbids polling a container that is about to be replaced, and nothing here does:
 * updates-client.tsx writes one entry when an apply is accepted, error.tsx reads it once, and
 * the household reloads when they are ready. No timer, no interval, no auto-reload.
 *
 * PURE, and imports only @/lib/update/semver (itself pure): both callers are 'use client'
 * modules, so anything reaching @/db or a node builtin from here would fail the client webpack
 * build outright (Ruling P4, and tests/ops/client-bundle.test.ts).
 *
 * The clock is a PARAMETER, never read here: no `new Date()` and no `Date.now()` anywhere under
 * src/lib. The callers pass Date.now(), which is also what makes every rule below testable
 * without touching a real clock.
 */

/** Matches src/components/theme/theme.ts's `bt-theme` naming: a `bt-` prefix, kebab-case. */
export const RESTART_NOTICE_KEY = 'bt-update-restarting';

/**
 * Five minutes.
 *
 * A Watchtower pull-and-recreate on a NAS is 30 to 90 seconds when the image is small and the
 * connection is ordinary; five minutes covers a slow pull over a home upstream with room to
 * spare. It is deliberately NOT MUST-7.6's 30-minute apply-confirm window, which exists to stop
 * the server double-firing a request and is far too generous for a person staring at a blank
 * screen right now — half an hour of "the app is restarting" on top of a genuine crash would be
 * the same class of lie this fix exists to remove, just pointed the other way.
 *
 * The bound is applied SYMMETRICALLY (see readRestartExpected): an entry stamped in the future,
 * which is what a clock jump or a hand-edited localStorage value looks like, is refused rather
 * than treated as permanently fresh.
 */
export const RESTART_NOTICE_MAX_AGE_MS = 5 * 60_000;

interface StoredNotice {
  /** The version being installed, as a bare "1.32.0". */
  version: string;
  /** Epoch milliseconds, from the browser that pressed the button. */
  at: number;
}

/**
 * Called from updates-client.tsx when an apply has actually been accepted by the server — never
 * on a click, because a click that is then refused (rate-limited, a stale version, a
 * cross-origin POST) is not a restart, and an entry written for one would suppress a real crash
 * message for five minutes on the strength of a button press that did nothing.
 *
 * Silent on failure by design: a private window, cleared site data, or a browser configured to
 * block storage all make this throw, and none of them is a reason to break the page the reader
 * is looking at. The cost of losing the write is that error.tsx falls back to today's copy,
 * which is exactly the behaviour every install had before this release.
 */
export function markRestartExpected(version: string, nowMs: number): void {
  const parsed = parseSemver(version);
  if (parsed === null) return;
  try {
    const notice: StoredNotice = { version: formatSemver(parsed), at: nowMs };
    window.localStorage.setItem(RESTART_NOTICE_KEY, JSON.stringify(notice));
  } catch {
    // See the docblock: unavailable storage is not an error worth showing anybody.
  }
}

/** Best-effort removal. Used wherever this module has decided an entry is spent. */
export function clearRestartExpected(): void {
  try {
    window.localStorage.removeItem(RESTART_NOTICE_KEY);
  } catch {
    // Same reasoning as markRestartExpected.
  }
}

/**
 * Returns the version to name on the error page, or null to render the ordinary crash copy.
 *
 * Null is the safe answer and every unclear case returns it, because the failure this guards
 * against is one-directional: a household that updated yesterday and hits a genuine error today
 * must see the genuine error. Four separate things have to be true before the restart copy is
 * shown:
 *
 *  1. There is a parseable entry with a version this app can compare and a finite stamp.
 *     localStorage is a place a person can write anything, and this string is rendered into a
 *     sentence — so the version is re-serialised from parseSemver's integers, never passed
 *     through (the same discipline github.ts applies to a release tag).
 *  2. The stamp is within RESTART_NOTICE_MAX_AGE_MS, in EITHER direction. An entry from the
 *     future is a clock jump or a hand edit, not a restart in progress.
 *  3. `runningVersion` is not the version being installed. If the code answering this render IS
 *     the new version, the restart already finished and whatever went wrong now is a real
 *     fault — this is what closes the several-minute window in which a successful update would
 *     otherwise have gone on blaming itself for an unrelated error.
 *  4. …and that is all. There is no request, no poll, no second opinion asked of a container
 *     that may not exist any more.
 *
 * Cases 2 and 3 also CLEAR the entry: both mean it is spent, and leaving it to rot is how a
 * stale key ends up suppressing something real. A malformed entry is deliberately left alone —
 * it is already refused, and a value this function could not understand is not one it should be
 * confident enough to delete.
 */
export function readRestartExpected(input: { nowMs: number; runningVersion: string }): string | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(RESTART_NOTICE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let notice: StoredNotice;
  try {
    notice = JSON.parse(raw) as StoredNotice;
  } catch {
    return null;
  }
  if (typeof notice !== 'object' || notice === null) return null;
  if (typeof notice.version !== 'string' || typeof notice.at !== 'number' || !Number.isFinite(notice.at)) return null;

  const parsed = parseSemver(notice.version);
  if (parsed === null) return null;
  const version = formatSemver(parsed);

  if (Math.abs(input.nowMs - notice.at) >= RESTART_NOTICE_MAX_AGE_MS) {
    clearRestartExpected();
    return null;
  }
  const running = parseSemver(input.runningVersion);
  if (running !== null && formatSemver(running) === version) {
    clearRestartExpected();
    return null;
  }
  return version;
}
