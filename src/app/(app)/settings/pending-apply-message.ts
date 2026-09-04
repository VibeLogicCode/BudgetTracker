/**
 * ONE wording for "an apply is already in flight for this version" (MUST-19.11: one place per
 * wording rule), read by both surfaces that have to say it.
 *
 * v1.31.0 item M-2. It used to be written out twice: as a template literal in
 * settings/actions.ts's `pendingApplyMessage` (returned when applyUpdate()'s single-flight guard
 * fires on a double-click, a second tab or a stale form resubmit) and as JSX prose in
 * settings/updates-client.tsx's pending notice (rendered for the same condition read from state).
 * actions.ts's own docblock said "Duplicated rather than shared, because a 'use server' file may
 * only export async functions -- there is no way to hand a plain string-builder across that
 * boundary. Keep the two wordings in lockstep."
 *
 * The constraint was real; the conclusion was not. A 'use server' module cannot EXPORT a plain
 * function, but it can freely IMPORT one from a module with no directive at all -- which is the
 * idiom this repo already uses for the mirror-image problem (settings/notifications/tabs.ts, so a
 * Server Component can reach a value without going through the client boundary;
 * src/lib/savings-rate.ts, src/lib/networth-constants.ts, src/lib/notify/events.ts,
 * src/lib/env-tz.ts, so a client component can reach a value without dragging the server's module
 * graph into the browser bundle). A module with no directive belongs to neither side, so one
 * definition serves the server action and the client component at once. Both wordings were
 * separately pinned by tests (update-actions.test.ts asserted the string exactly,
 * updates-card.test.tsx matched /Watchtower is pulling 1\.4\.0/) and nothing asserted they were
 * the SAME sentence -- so drift would have shown one user two different sentences for one state
 * and every test would still have passed. That is ruling R17's shape exactly, one file over.
 *
 * Rejected alternative: extending tests/ops/client-bundle.test.ts's DUPLICATES table to string
 * duplicates and keeping both copies. That table exists for a duplicate that CANNOT be shared
 * (APPLY_CONFIRM_MAX_AGE_MS, whose server home reaches @/db/client and would pull better-sqlite3
 * into the browser build -- MUST-2.1). This one can be shared, and pinning a duplicate you could
 * have deleted is the weaker of the two fixes.
 *
 * `currentVersion` is a parameter rather than an import of APP_VERSION because the two callers
 * already hold it from opposite directions -- actions.ts imports @/lib/version, the client
 * component receives it as a prop -- and keeping this module import-free is what makes it safe for
 * both sides.
 */
export function pendingApplyMessage(version: string, currentVersion: string): string {
  return (
    `Watchtower is pulling ${version}. This page will stop responding for a minute while the ` +
    'container restarts, then come back on the new version. Reload in a minute or two. If this ' +
    `card still says v${currentVersion} after 30 minutes, the update did not land and the reason ` +
    'will appear here.'
  );
}
