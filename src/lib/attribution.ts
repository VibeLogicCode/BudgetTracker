/**
 * 2026-09-13. WHO A TRANSACTION BELONGS TO, decided once at insert -- the order, in one place.
 *
 * The report: "think about person too so its not just on vendor rule, even sets household, or
 * individual person."
 *
 * THE ORDER, and the argument for it (ruling P11):
 *
 *   rule > card > account owner > nobody
 *
 * A rule names a merchant, and may name an amount as well: it describes THIS charge. The per-card
 * map (account_card_people) names a whole card, and the account owner names a whole account. The
 * specific beats the general -- which is the same argument src/lib/display-source.ts makes about
 * which label wins, and the same direction. Concretely: a payment for Sam's policy charged to
 * Alex's card lands on Sam.
 *
 * A RULE THAT NAMES HOUSEHOLD IS STILL A RULE. `ruleUserId: null` with `ruleMatched: true` means
 * "put this on nobody in particular", and it must STOP the chain rather than fall through it --
 * that is the entire value of the Household option, since falling through would hand the row
 * straight back to the card map the rule was written to overrule. The two flags exist because
 * "Household" and "no rule matched" both carry a null user id and mean opposite things.
 *
 * WHAT HAPPENS AFTER INSERT: nothing automatic. attributed_user_id has no source column, so
 * nothing downstream could tell a person somebody chose by hand from the account owner the
 * importer fell back to -- which is exactly why the engine never writes this column and why a
 * hand edit is final unless somebody deliberately presses "Apply now" on a rule (ruling P10).
 * tests/ops/attribution-writers.test.ts enumerates every writer there is.
 *
 * NO DATABASE ACCESS. Each caller has already looked up its own three candidates -- commitImport
 * loads the rule list and the card map once per commit, never per row -- so this stays a pure
 * function of them, and the ORDER is the only thing it decides.
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, ruling P17.
 */

/** Which of the three said so. Reported so an import can tell the household honestly. */
export type AttributionSource = 'rule' | 'card' | 'owner';

export interface AttributionInput {
  /** The person a matching attribution rule names; null there means Household. */
  ruleUserId: number | null;
  /** Whether a rule matched at all. Null userId means Household only when this is true. */
  ruleMatched: boolean;
  /** The person the per-card map names for this row's card cell, or null for no card match. */
  cardUserId: number | null;
  /** The account's owner, itself nullable -- an account may have none. */
  ownerUserId: number | null;
}

export function resolveAttribution(input: AttributionInput): { userId: number | null; source: AttributionSource } {
  if (input.ruleMatched) return { userId: input.ruleUserId, source: 'rule' };
  if (input.cardUserId !== null) return { userId: input.cardUserId, source: 'card' };
  return { userId: input.ownerUserId, source: 'owner' };
}
