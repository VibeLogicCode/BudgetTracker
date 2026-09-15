'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, deliberately, for the reason DismissImportForm.tsx states at length: the
// client-bundle guard walks `@/`-qualified value imports looking for a path back to @/db/client,
// and it cannot tell a 'use server' file (whose body Next elides from the client bundle) apart
// from an ordinary module. A relative specifier is outside what that guard resolves.
import { unlinkRulePaymentAction, type UnlinkRulePaymentState } from '../app/(app)/dashboard/actions';

const initial: UnlinkRulePaymentState = {};

/**
 * R27b. The one piece of client interactivity RuleLinkedPaymentsCard needs, so that card stays a
 * server component — the same boundary-minimising move DismissImportForm and RecordPaymentForm
 * already make for their own cards.
 *
 * Unlink, not dismiss. The other review card on this page offers "Dismiss", because a
 * rule-categorized import is a thing to acknowledge; a wrong LOAN link is a thing to undo, and it
 * has already moved a balance. Offering only "seen it" would leave the household reading a wrong
 * balance with the app's blessing. Unlinking is the existing reversal (unlinkItemTransaction),
 * which puts the balance back.
 */
export function UnlinkRulePaymentForm({
  txnId,
  itemId,
  itemName,
}: {
  txnId: number;
  itemId: number;
  itemName: string;
}) {
  const [state, dispatch] = useActionState(unlinkRulePaymentAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-end gap-1">
      <input type="hidden" name="txnId" value={txnId} />
      <input type="hidden" name="itemId" value={itemId} />
      <SubmitButton variant="ghost" size="sm">
        {`Not ${itemName}`}
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
