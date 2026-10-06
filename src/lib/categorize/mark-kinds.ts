/**
 * Spec 2026-10-05 §2.2. The two recurring-mark rule kinds, in a module with no imports so a client
 * component can ask "is this a mark" without pulling @/db into its bundle. rules.ts re-exports all
 * three, and server code imports them from there.
 */
export type RecurringMark = 'recurring' | 'not_recurring';

export const RECURRING_MARK_KINDS: readonly RecurringMark[] = ['recurring', 'not_recurring'];

export function isRecurringMarkKind(kind: string): kind is RecurringMark {
  return (RECURRING_MARK_KINDS as readonly string[]).includes(kind);
}
