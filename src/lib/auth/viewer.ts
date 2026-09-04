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

/**
 * The synthetic household-scoped viewer: "ask this question with no owner restriction at all".
 * `visibility: 'household'` is what ownerScope above resolves to null, so nothing ever reads the
 * id -- 0 is not a user, and deliberately cannot be one (SQLite's rowid ids start at 1).
 *
 * v1.31.0 item M-1. This shipped THREE times before this constant existed:
 * `HOUSEHOLD_VIEWER` exported from notify/evaluate/digest.ts (v1.28.0, for the family-channel
 * digest -- one message addressed to a ROOM must not be rendered through whichever member's slot
 * happened to fire first, or a household with one self-scoped member would read that member's
 * spend as the household total), `HOUSEHOLD_WIDE` in notify/evaluate/savings.ts, and a local
 * `householdWide` inside loans.ts's loansTotalOwedCents (a loan total has no per-person
 * attribution to restrict). Three hand-built copies of one security-relevant literal with nothing
 * tying them together is item M-1's own shape, which digest.ts's docblock had already named
 * without acting on it.
 *
 * digest.ts rejected "a new shared module for one constant, which buys nothing this export does
 * not". That was right about a NEW module and wrong about the home: this module already exists,
 * already owns the Viewer type, is already imported by all three call sites for `ownerScope` /
 * `isSelfScoped` / the type itself, and is deliberately dependency-free so a client component can
 * import it. Nothing new is dragged anywhere by putting the constant beside the rule that reads
 * it, and tests/ops/viewer-construction.test.ts now stops a fourth copy.
 */
export const HOUSEHOLD_VIEWER: Viewer = { id: 0, role: 'admin', visibility: 'household' };
