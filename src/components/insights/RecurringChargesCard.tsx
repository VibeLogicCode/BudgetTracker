import { formatCents } from '@/lib/money';

/**
 * The Contracts & Coverage header line: what the household has RECORDED as recurring billing.
 *
 * Kept in this module beside the card rather than inlined in warranties-client.tsx, because the
 * card's whole argument is about the difference between a recorded figure and a detected one --
 * the two wordings have to be read together to stay honest, and a reader changing one should
 * have the other on screen.
 *
 * The dashboard tile deliberately does NOT reuse this sentence: its VALUE already is the monthly
 * figure, so a hint repeating it would print the same number twice in one tile. It carries the
 * same two nouns ("Recorded billing", "recorded items") and the same never-blend-the-cycles rule
 * in its own hint instead.
 *
 * "Recorded", every time. The figure is the sum of billing amounts somebody typed into items;
 * it is emphatically NOT what the household actually pays, and the Recurring charges card on Insights exists precisely
 * because the two differ. A line reading "Recurring: $412/month" -- the proposal's own wording
 * -- would have been read as the second thing while only ever being the first.
 */
export function recordedBillingSentence(load: { monthlyCents: number; annualCents: number; itemCount: number }): string | null {
  if (load.itemCount === 0) return null;
  const items = `${load.itemCount} recorded ${load.itemCount === 1 ? 'item' : 'items'}`;
  // The two cycles are never folded into one figure: dividing an annual bill by twelve invents
  // a monthly payment nobody makes, and adding it to the monthly total double-counts it.
  if (load.annualCents === 0) return `${formatCents(load.monthlyCents)} a month across ${items}.`;
  if (load.monthlyCents === 0) return `${formatCents(load.annualCents)} a year across ${items}.`;
  return `${formatCents(load.monthlyCents)} a month, plus ${formatCents(load.annualCents)} a year billed annually, across ${items}.`;
}
