import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { warrantyItems } from '@/db/schema';
import type { WarrantyStatus } from '@/lib/warranty/expiry';

/**
 * R25 (v1.32.0). The SQL half of src/lib/warranty/expiry.ts's rule, and the ONE place the
 * status ladder is written in SQL. Two renderings come out of it and nothing else may write a
 * third: `STATUS_CASE_SQL`, the raw `i.`-aliased CASE the list query splices into its own SQL
 * text, and `notEnded()`, the composable drizzle predicate every server-side "is this item still
 * live" filter takes.
 *
 * MUST-2.2: SERVER-ONLY, and that is the entire reason this file exists instead of the ladder
 * living next to warrantyStatus(). Three `'use client'` files reach expiry.ts -- warranties-client
 * and new-warranty-client directly, warranty-detail-client through StatusBadge (which carries no
 * directive of its own but is only ever rendered from a client component, so it lands in the
 * bundle all the same) -- and exporting a drizzle predicate FROM expiry.ts would put @/db/schema
 * and drizzle's SQL builder in that bundle for the sake of a badge: the MUST-2.1 hazard, and
 * controller ruling V2's reason for a new leaf module. The dependency runs ONE WAY: this module
 * imports expiry.ts, never the reverse.
 *
 * Worth knowing, because the ruling's stated mechanism is not the real one:
 * tests/ops/client-bundle.test.ts does NOT catch a `@/db/schema` import (verified by adding one
 * and watching the guard stay green). It walks to @/db/client, better-sqlite3, @/lib/env and
 * node: builtins, and schema.ts reaches none of them -- it imports drizzle-orm and nothing else,
 * so a client component pulling it in is bundle weight, not a broken `next build`. The rule this
 * module keeps is therefore guarded HERE, by name, in
 * tests/ops/not-ended-agreement.test.ts: no client file may reach this file at all.
 *
 * Imports only drizzle-orm, @/db/schema and expiry.ts's type -- a leaf, for the same reason
 * src/lib/spend-where.ts is one: any server module can take it with no cycle.
 */

/**
 * The two bound values the ladder needs. Symbols rather than strings so a piece can never be
 * mistaken for literal SQL text, and so an unbound one is a thrown error rather than a silent
 * `null` comparison that matches nothing.
 */
const TODAY = Symbol('today');
const SOON = Symbol('soon');

/**
 * A condition is a list of pieces: literal SQL text, a column of `warranty_items`, or one of the
 * two bound values above.
 *
 * WHY NOT A PLAIN TEMPLATE STRING, and why not drizzle's own dialect. The two renderings below
 * disagree about all three kinds of piece: the raw one qualifies columns with the list query's
 * `i` alias and writes a positional `?`; drizzle qualifies them itself (and would rewrite them
 * again under an `alias()`) and binds a Param. A template string can produce the first and not
 * the second. `SQLiteSyncDialect.sqlToQuery` can produce the second and not the first, because it
 * quotes identifiers -- `"i"."expiry_date"` -- and tests/lib/warranty/expiry.test.ts asserts the
 * list query's CASE contains the unquoted `i.expiry_date`. So the definition is neither of them,
 * and both are generated from it.
 */
type Piece = string | AnyColumn | typeof TODAY | typeof SOON;

/** Open-ended: no term was ever agreed, so there is nothing to run out (MUST-3.5). */
const OPEN_ENDED: readonly Piece[] = [warrantyItems.isLifetime, ' = 1'];

/** No end date recorded -- the normal state of a loan between friends and of an open contract. */
const NO_END_RECORDED: readonly Piece[] = [warrantyItems.expiryDate, ' is null'];

/**
 * THE boundary, written once for all of SQL. MUST-3.14: coverage is INCLUSIVE of expiry_date, so
 * an item has ended only strictly after it -- an item whose expiry_date is today is still live.
 * This is the comparison R25 exists about; every other SQL expression of "ended" or "not ended"
 * in this app is derived from this line rather than restating it.
 */
const ENDED: readonly Piece[] = [warrantyItems.expiryDate, ' < ', TODAY];

/** §3.7 / §17.1: `soon` is the caller's addDaysIso(today, EXPIRING_SOON_DAYS), never recomputed here. */
const ENDING_SOON: readonly Piece[] = [warrantyItems.expiryDate, ' <= ', SOON];

/**
 * The ladder, once. THE ORDER IS THE RULE, not presentation: an open-ended item has no expiry
 * date, so `lifetime` has to be decided before `unknown` can claim it, and an ended item is also
 * within the expiring window, so `expired` has to be decided before `expiring`. warrantyStatus()
 * in expiry.ts is the same ladder in the same order; `WarrantyStatus` here is what stops an arm
 * naming a status TypeScript does not have.
 */
const LADDER: readonly { when: readonly Piece[]; then: WarrantyStatus }[] = [
  { when: OPEN_ENDED, then: 'lifetime' },
  { when: NO_END_RECORDED, then: 'unknown' },
  { when: ENDED, then: 'expired' },
  { when: ENDING_SOON, then: 'expiring' },
];

/** Everything no arm claimed: covered, and not close to the edge. */
const LADDER_ELSE: WarrantyStatus = 'active';

/**
 * The alias searchWarrantyItems (src/lib/warranty/search.ts) gives warranty_items in its own raw
 * `from warranty_items i ...`. STATUS_CASE_SQL is spliced into that text, so the two have to
 * agree; the docblock this replaces said "assumes warranty_items is aliased `i`" and left it
 * there. tests/ops/not-ended-agreement.test.ts now reads search.ts's FROM clause and checks it.
 */
const LIST_ALIAS = 'i';

/** Raw SQL text for the list query: `i.`-qualified columns, positional `?` for every bound value. */
function renderRaw(pieces: readonly Piece[]): string {
  return pieces
    .map((piece) => {
      if (typeof piece === 'string') return piece;
      if (piece === TODAY || piece === SOON) return '?';
      return `${LIST_ALIAS}.${piece.name}`;
    })
    .join('');
}

/**
 * The same pieces as a drizzle `SQL`: real column references (so drizzle qualifies them, and
 * `tsc` catches a schema rename) and real bound Params (MUST-9.2 -- a value is never spliced into
 * SQL text here, not even an ISO date this module generated itself).
 */
function renderDrizzle(pieces: readonly Piece[], binds: { today?: string; soon?: string }): SQL {
  return sql.join(
    pieces.map((piece) => {
      if (typeof piece === 'string') return sql.raw(piece);
      if (piece !== TODAY && piece !== SOON) return piece;
      const value = piece === TODAY ? binds.today : binds.soon;
      // Left undefined, drizzle would bind SQL NULL and the comparison would match nothing at
      // all -- a filter that silently returns an empty list, which is the worst way for this to
      // go wrong. Fail loudly instead.
      if (value === undefined) throw new Error(`expiry-sql: no value bound for ${String(piece)}`);
      return sql`${value}`;
    }),
  );
}

/**
 * The SAME rule as warrantyStatus() (src/lib/warranty/expiry.ts), expressed in SQL so the list,
 * the filter counts and the badge can never disagree (§3.7). Binds exactly two parameters, in
 * this order:
 *   1. today  (ISO YYYY-MM-DD)
 *   2. soon   (= addDaysIso(today, EXPIRING_SOON_DAYS))
 * Assumes warranty_items is aliased `i` (LIST_ALIAS above).
 *
 * Generated from LADDER rather than typed out, so it and notEnded() below cannot drift: they are
 * two renderings of one definition now, not two definitions that happen to agree.
 */
export const STATUS_CASE_SQL = [
  'case',
  ...LADDER.map((arm) => `  when ${renderRaw(arm.when)} then '${arm.then}'`),
  `  else '${LADDER_ELSE}'`,
  'end',
].join('\n');

/**
 * "This item has not ended yet", as a composable drizzle predicate: open-ended and no-end-date
 * items are live, and coverage is inclusive of the expiry date itself.
 *
 * It is the COMPLEMENT of the ladder's `expired` arm, spelled `not (...)` rather than as a second
 * comparison with the inequality turned around. `expiry_date >= ?` and `not (expiry_date < ?)`
 * agree on every row, and that is precisely the problem R25 names: a hand-written `>=` is another
 * statement of MUST-3.14's boundary, one that agrees today and is free to stop agreeing after the
 * next edit to either. `not` of the one arm cannot drift from it.
 *
 * Three-valued logic is safe here and the clause order is why: a null expiry_date makes the
 * middle clause TRUE, and `TRUE or NULL` is TRUE, so the row is live exactly as it should be
 * rather than falling into SQL's unknown.
 */
export function notEnded(today: string): SQL {
  return renderDrizzle(['(', ...OPEN_ENDED, ' or ', ...NO_END_RECORDED, ' or not (', ...ENDED, '))'], { today });
}
