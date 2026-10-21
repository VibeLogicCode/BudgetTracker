/**
 * Spec 2026-10-05 §2.2. The two recurring-mark rule kinds, in a module with no imports so a client
 * component can ask "is this a mark" without pulling @/db into its bundle. rules.ts re-exports the
 * names here, and server code imports them from there.
 */
export type RecurringMark = 'recurring' | 'not_recurring';

export const RECURRING_MARK_KINDS: readonly RecurringMark[] = ['recurring', 'not_recurring'];

export function isRecurringMarkKind(kind: string): kind is RecurringMark {
  return (RECURRING_MARK_KINDS as readonly string[]).includes(kind);
}

/**
 * Spec 2026-10-21 §2.1. The kinds that leave nothing on a transaction -- the two recurring marks and
 * Always ask. "Apply now" and "clear" have nothing to do for them, and a rules pack never carries one.
 */
export type MerchantMarkKind = RecurringMark | 'always_ask';

export const MERCHANT_MARK_KINDS: readonly MerchantMarkKind[] = ['recurring', 'not_recurring', 'always_ask'];

export function isMerchantMarkKind(kind: string): kind is MerchantMarkKind {
  return (MERCHANT_MARK_KINDS as readonly string[]).includes(kind);
}
