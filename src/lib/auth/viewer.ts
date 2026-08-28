/**
 * v1.13.0, spec docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md.
 *
 * The reader boundary. `role` gates ACTIONS and always has; `visibility` gates READS and only reads.
 * Keep this module PURE -- no @/db import, no node builtin -- so a client component may import the
 * Viewer type without dragging better-sqlite3 into the browser bundle
 * (tests/ops/client-bundle.test.ts).
 */
export interface Viewer {
  id: number;
  role: 'admin' | 'member';
  visibility: 'household' | 'self';
}

/**
 * null means "no owner restriction" -- a household viewer, or an admin. Micro-ruling M1 makes
 * admin + self unreachable through the UI; the role check stays anyway so a hand-edited database row
 * cannot lock an admin out of their own install.
 * A number means "every row this query returns must be owned by this user id".
 */
export function ownerScope(viewer: Viewer): number | null {
  return viewer.visibility === 'self' && viewer.role !== 'admin' ? viewer.id : null;
}

export function isSelfScoped(viewer: Viewer): boolean {
  return ownerScope(viewer) !== null;
}

/**
 * Ruling R3. Moved here from src/app/(app)/goals/actions.ts so both actions files import one copy:
 * members may act on their OWN rows and on shared (null-owner) rows; admins may act on any.
 * warranty_items.owner_user_id is NOT NULL, so the shared arm is unreachable for items -- that is
 * correct, not an oversight: an item always has exactly one owner.
 */
export function canActOnOwner(ownerUserId: number | null, viewer: Viewer): boolean {
  return ownerUserId === null || ownerUserId === viewer.id || viewer.role === 'admin';
}

/** One wording for a refused cross-owner read or write (MUST-19.11: one place per wording rule). */
export const NOT_YOURS_ERROR = 'That belongs to someone else in the household.';
