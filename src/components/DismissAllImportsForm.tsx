'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, deliberately -- see DismissImportForm.tsx for why (the client-bundle guard).
import { dismissAllRuleImportsAction, type DismissRuleImportState } from '../app/(app)/dashboard/actions';

const initial: DismissRuleImportState = {};

/**
 * The "Dismiss all" footer of RuleReviewCard. A small client child for the same reason
 * DismissImportForm is one: the card stays a server component.
 *
 * It posts the ids the card rendered, one hidden input each, so the action dismisses exactly
 * what the person was looking at and nothing that arrived since.
 */
export function DismissAllImportsForm({ importIds }: { importIds: number[] }) {
  const [state, dispatch] = useActionState(dismissAllRuleImportsAction, initial);
  return (
    <form
      action={dispatch}
      className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
    >
      {importIds.map((id) => (
        <input key={id} type="hidden" name="importId" value={id} />
      ))}
      <p className="text-xs text-muted">
        {`Marks all ${importIds.length} imports as checked. The transactions are not changed.`}
      </p>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        <SubmitButton variant="ghost" size="sm">
          Dismiss all
        </SubmitButton>
        <FormError message={state.error} />
      </div>
    </form>
  );
}
