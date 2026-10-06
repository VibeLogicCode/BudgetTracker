'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// RELATIVE, like DismissInsightForm.tsx: the client-bundle guard walks only @/ value imports, and
// cannot tell a 'use server' file from an ordinary module.
import { setRecurringMarkAction, type ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

/**
 * Spec 2026-10-05 §2.3. One mark button on the Recurring charges card. It posts the merchant's
 * newest charge, so the action checks that row against the viewer the way the row menu's does.
 */
export function RecurringMarkForm({
  transactionId,
  mark,
  label,
  ariaLabel,
}: {
  transactionId: number;
  mark: 'recurring' | 'not_recurring' | 'clear';
  label: string;
  ariaLabel: string;
}) {
  const [state, dispatch] = useActionState(setRecurringMarkAction, initial);
  return (
    <form action={dispatch} className="flex flex-col items-start gap-1">
      <input type="hidden" name="transactionId" value={String(transactionId)} />
      <input type="hidden" name="mark" value={mark} />
      <SubmitButton variant="secondary" size="sm" ariaLabel={ariaLabel}>
        {label}
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}
