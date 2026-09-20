'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, deliberately -- not '@/app/(app)/dashboard/actions'. Same reasoning
// DismissImportForm.tsx gives for its own identical import: the client-bundle guard
// (tests/ops/client-bundle.test.ts) only walks `@/`-qualified value imports looking for a path
// back to @/db/client et al., and actions.ts is a 'use server' file (Next elides its real body
// from the client bundle) that the guard's regex scan cannot tell apart from an ordinary module.
import { dismissInsightAction, type DismissInsightState } from '../app/(app)/dashboard/actions';

const initial: DismissInsightState = {};

/**
 * Reported 2026-09-20. The one bit of client interactivity NeedsALookCard needs -- that card is a
 * server component whose props arrive already computed, so this is a tiny client child rather than
 * a reason to convert the whole card, the same boundary-minimising move DismissImportForm makes.
 *
 * "That's fine" rather than "Dismiss": the press is a VERDICT on a charge somebody has looked at,
 * not a request to be left alone, and the copy is what decides which of the two it becomes.
 */
export function DismissInsightForm({ insightKey, label }: { insightKey: string; label: string }) {
  const [state, dispatch] = useActionState(dismissInsightAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-end gap-1">
      <input type="hidden" name="key" value={insightKey} />
      <SubmitButton variant="ghost" size="sm" ariaLabel={label}>
        That&rsquo;s fine
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
