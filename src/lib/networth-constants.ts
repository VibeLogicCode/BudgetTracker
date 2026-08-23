/**
 * Client-safe net worth constants -- deliberately split out of @/lib/networth (client-bundle
 * fix, 2026-08-23; same Ruling P4 constraint documented in src/lib/warranty/constants.ts,
 * src/lib/notify/events.ts and src/lib/env-tz.ts). networth.ts imports getDb from @/db/client at
 * module scope for its query functions, so a client component that value-imports ANYTHING from
 * networth.ts -- even a plain re-exported number -- drags that whole module into the browser
 * bundle: webpack must resolve a value-imported module's own top-level imports before it can
 * even attempt to tree-shake the unused parts, and @/db/client's better-sqlite3 pulls in
 * node:fs/node:crypto, which the client webpack build cannot resolve at all ("Module not found:
 * Can't resolve 'fs'").
 *
 * This module has no @/db import, no @/lib/env import and no node builtin, so it is safe for
 * both bundles. networth.ts imports STALE_SNAPSHOT_DAYS from here and re-exports it, so every
 * existing server-side importer of '@/lib/networth' keeps working unchanged (same shape as
 * @/lib/env re-exporting DEFAULT_TZ from @/lib/env-tz) -- there is exactly one definition.
 * reports-client.tsx (a 'use client' component) imports it from HERE directly, not from
 * '@/lib/networth', because re-exporting through networth.ts would not change what webpack has
 * to resolve for that specifier -- the whole point of this split.
 */

/**
 * Adversarial-review fix (2026-08-23): the threshold for "too old to trust", not merely "not
 * from this exact month". An account that syncs automatically or gets a manual update once a
 * month should always have a snapshot inside 31 days; 45 leaves slack for exactly one missed
 * cycle (a skipped sync, a forgotten manual entry) without concealing a gap that has gone on
 * longer than that.
 */
export const STALE_SNAPSHOT_DAYS = 45;
