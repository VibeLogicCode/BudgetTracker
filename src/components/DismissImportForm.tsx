'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, deliberately -- not '@/app/(app)/dashboard/actions'. Same reasoning
// RecordPaymentForm.tsx gives for its own identical import: the client-bundle guard
// (tests/ops/client-bundle.test.ts) only walks `@/`-qualified value imports looking for a path
// back to @/db/client et al., and actions.ts is a 'use server' file (Next elides its real body
// from the client bundle) that the guard's regex scan cannot tell apart from an ordinary
// module. A relative specifier is outside what the guard resolves further.
import { dismissRuleImportAction, type DismissRuleImportState } from '../app/(app)/dashboard/actions';

const initial: DismissRuleImportState = {};

/**
 * v1.26.0 Lane 3b. The one bit of client interactivity RuleReviewCard needs -- that card stays
 * a server component (every prop it renders arrives already computed), so this is a tiny client
 * child rather than a reason to convert the whole card, the same boundary-minimising move
 * RecordPaymentForm already makes for the Coming-up card.
 */
export function DismissImportForm({ importId }: { importId: number }) {
  const [state, dispatch] = useActionState(dismissRuleImportAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-end gap-1">
      <input type="hidden" name="importId" value={importId} />
      <SubmitButton variant="ghost" size="sm">
        Dismiss
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
