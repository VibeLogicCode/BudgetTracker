import type { SuggestedFields } from '@/lib/warranty/suggest';

/**
 * v1.64.0 (plan 2026-11-12, D2). What the local AI may add to a receipt the pattern reader already
 * read. The vendor comes from the AI whenever it has one (the pattern's is only the first line of
 * the receipt); the purchase date, total and due date come from the AI only when the pattern found
 * none, so a figure the pattern found by its own rules wins. The forms' touched checks then keep
 * anything a person typed. PURE: no I/O, safe for a client component.
 */
export function mergeAiReceiptFields(pattern: SuggestedFields, ai: SuggestedFields): SuggestedFields {
  const out: SuggestedFields = {};
  if (ai.vendor) out.vendor = ai.vendor;
  if (ai.purchaseDate && !pattern.purchaseDate) out.purchaseDate = ai.purchaseDate;
  if (ai.priceCents !== undefined && pattern.priceCents === undefined) out.priceCents = ai.priceCents;
  if (ai.dueDate && !pattern.dueDate) out.dueDate = ai.dueDate;
  return out;
}
