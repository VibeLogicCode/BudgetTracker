/**
 * 2026-09-13. WHO A TRANSACTION BELONGS TO, decided once at insert -- the order, in one place.
 *
 * The report: a rule should be able to name a person too, not only a vendor, and even set
 * household or an individual person.
 *
 * THE ORDER, and the argument for it (ruling P11, first half reversed in v1.59.0):
 *
 *   card > rule > account owner > nobody
 *
 * A linked card value (account_card_people) names the person holding the card this charge was
 * made on -- a fact the bank wrote into this row of this file. A rule names a merchant, and may
 * name an amount as well, so it is a judgement about every charge that looks like this one; the
 * account owner names a whole account. The card holder therefore comes first, and a rule decides
 * only a row whose card cell is blank or carries a value nobody is linked to. Concretely: a
 * payment for Sam's policy charged to Alex's linked card lands on Alex, and a rule for it still
 * decides the same payment on an account with no cardholder column.
 *
 * Only a CSV mapping with a cardholder column ever supplies a card. OFX passes no mapping and
 * SimpleFIN has none, so for both the order is still rule > owner, exactly as before v1.59.0.
 *
 * A RULE THAT NAMES HOUSEHOLD IS STILL A RULE. `ruleUserId: null` with `ruleMatched: true` means
 * "put this on nobody in particular", and it must STOP the chain before the account owner rather
 * than fall through to it -- that is the value of the Household option. A linked card still beats
 * it, the same as it beats a rule naming a person. The two flags exist because "Household" and "no
 * rule matched" both carry a null user id and mean opposite things.
 *
 * WHAT HAPPENS AFTER INSERT: nothing automatic. attributed_user_id has no source column, so
 * nothing downstream could tell a person somebody chose by hand from the account owner the
 * importer fell back to -- which is exactly why the engine never writes this column and why a
 * hand edit is final unless somebody deliberately presses "Apply now" on a rule (ruling P10).
 * The card value itself is never stored on a transaction either, so nothing can re-run this order
 * on rows already imported: linking a card value changes future imports only.
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
  if (input.cardUserId !== null) return { userId: input.cardUserId, source: 'card' };
  if (input.ruleMatched) return { userId: input.ruleUserId, source: 'rule' };
  return { userId: input.ownerUserId, source: 'owner' };
}
