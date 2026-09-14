/**
 * 2026-09-13. ONE predicate for "does this amount fall inside that window", and the arithmetic
 * that proposes a window from a single charge.
 *
 * The owner's report: "insurance is with same company but different amount but imported
 * categorizes the last setting i do so everything goes to home or auto. can i set in rule vendor +
 * amount rule?" Two policies with one insurer differ only by premium, so a rule that sees the
 * merchant text alone cannot tell them apart. merchant_rules.amount_min_cents/amount_max_cents
 * (drizzle/0024) is where such a rule stores its window, and everything below is what reads it.
 *
 * NO `@/db` IMPORT, and none may be added. The kebab dialog on the transactions page is a client
 * component and calls defaultBoundsAround to prefill; tests/ops/client-bundle.test.ts is the guard
 * that keeps a value-import of the database out of anything a client file reaches.
 *
 * WHY THESE LIVE TOGETHER RATHER THAN INSIDE rules.ts: three callers need the comparison --
 * matchRule, the authoring dialog, and (PENDING-FIXES R27a) the loan matcher, which today has no
 * amount check at all. A second `>=`/`<=` pair written in any of them is the failure shape
 * src/lib/display-source.ts already paid for once, so tests/ops/amount-bounds.test.ts refuses one.
 *
 * Spec: docs/superpowers/specs/2026-09-13-vendor-amount-person-rules-design.md, ruling P6.
 */

/** A rule's stored window. Both null is "about the merchant, whatever the amount". */
export interface AmountBounds {
  amountMinCents: number | null;
  amountMaxCents: number | null;
}

const CENTS_PER_DOLLAR = 100;
/** The prefill's half-width, as a fraction of the charge. Ruling Q6: 10%, not a fixed +/- $5. */
const DEFAULT_TOLERANCE = 0.1;
/** The smallest half-width worth storing. A 48-cent window around a $4.85 coffee is one price
 *  rise from matching nothing, with no error to say so. */
const MINIMUM_HALF_WIDTH_CENTS = 100;

/**
 * Both null = unbounded, so every rule written before migration 0024 answers `true` here and
 * nothing already stored changes behaviour.
 *
 * COMPARED AGAINST THE MAGNITUDE, deliberately. transactions.amount_cents is negative for a
 * charge and positive for a refund of it; a household writing "$125 to $155" is describing the
 * premium, and the refund of that premium is the same policy by any reading. Signed comparison
 * would instead mean a refund silently falls out of the rule and gets filed by whatever broader
 * rule catches the merchant -- the same silent fall-through the range exists to stop.
 *
 * Both ends are INCLUSIVE: the numbers on screen are the ones the household typed, and a window
 * that excluded its own endpoints would refuse the very charge it was prefilled from.
 */
export function amountWithinBounds(
  amountCents: number,
  amountMinCents: number | null,
  amountMaxCents: number | null,
): boolean {
  const magnitude = Math.abs(amountCents);
  if (amountMinCents !== null && magnitude < amountMinCents) return false;
  if (amountMaxCents !== null && magnitude > amountMaxCents) return false;
  return true;
}

/**
 * What is WRONG with a window somebody is trying to save, or null when nothing is.
 *
 * Lives here rather than at the write choke point for the reason the whole module exists: this is
 * the second question about the two columns, and the rules form, the authoring dialog and
 * upsertRuleFromCorrection all have to answer it identically. drizzle/0024's triggers refuse both
 * shapes at the table as well, so this is the sentence a person gets INSTEAD of a constraint
 * failure, not the only thing standing between the household and a bad row.
 *
 * 'order' -- a window whose minimum is above its maximum matches nothing, for ever, silently. It
 * is never what anybody meant; the rules page's Affects column would just read 0 for ever.
 * 'negative' -- the comparison is against a magnitude, which cannot be below zero, so a negative
 * bound could never match either.
 */
export function boundsProblem(
  amountMinCents: number | null,
  amountMaxCents: number | null,
): 'negative' | 'order' | null {
  if (amountMinCents !== null && amountMinCents < 0) return 'negative';
  if (amountMaxCents !== null && amountMaxCents < 0) return 'negative';
  if (amountMinCents !== null && amountMaxCents !== null && amountMinCents > amountMaxCents) return 'order';
  return null;
}

/** Does this rule say anything about the amount at all? False for every pre-0024 row. */
export function isBounded(bounds: AmountBounds): boolean {
  return bounds.amountMinCents !== null || bounds.amountMaxCents !== null;
}

/**
 * How wide a rule's claim is, for the "narrower wins" tie-break in outranks (ruling P4).
 *
 * An OPEN side is Infinity rather than some large number: `[$125, up]` claims every larger charge
 * the merchant will ever make, which is not narrower than `[$125, $155]` by any amount that could
 * be computed -- it is a different kind of claim. Making it Infinity lets the same `<` comparison
 * rank both cases without a branch at the call site.
 */
export function boundsWidth(bounds: AmountBounds): number {
  if (bounds.amountMinCents === null || bounds.amountMaxCents === null) return Number.POSITIVE_INFINITY;
  return bounds.amountMaxCents - bounds.amountMinCents;
}

/**
 * The window the authoring dialog prefills from the row it was opened on: 10% either side of the
 * charge, at least a dollar each way, rounded OUTWARD to whole dollars.
 *
 * Outward and not nearest, which matters for exactly one reason: the row the household is looking
 * at must fall inside the window they are about to create. Rounding $126.108 to $126.00 keeps
 * $140.12 inside; rounding it to the nearest dollar would too, here, but not for every charge --
 * and a dialog that sometimes proposes a rule excluding its own transaction is a defect nobody
 * would think to look for.
 *
 * Whole dollars because the two numbers go straight into money inputs a person then edits. "$126
 * to $155" reads as a decision; "$126.11 to $154.13" reads as arithmetic nobody asked for.
 *
 * Never negative: the table refuses a negative bound (drizzle/0024's triggers) and a magnitude can
 * never be below zero anyway, so the floor is 0 rather than a refusal.
 */
export function defaultBoundsAround(amountCents: number): { minCents: number; maxCents: number } {
  const magnitude = Math.abs(amountCents);
  const halfWidth = Math.max(magnitude * DEFAULT_TOLERANCE, MINIMUM_HALF_WIDTH_CENTS);
  const minCents = Math.max(0, Math.floor((magnitude - halfWidth) / CENTS_PER_DOLLAR) * CENTS_PER_DOLLAR);
  const maxCents = Math.ceil((magnitude + halfWidth) / CENTS_PER_DOLLAR) * CENTS_PER_DOLLAR;
  return { minCents, maxCents };
}
