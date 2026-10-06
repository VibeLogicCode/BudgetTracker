'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { RecurringMarkForm } from '@/components/insights/RecurringMarkForm';
import { buttonClass } from '@/components/ui/Button';
import { RowMenu, RowMenuForm, RowMenuLink } from '@/components/ui/RowMenu';
// Type-only, so @/lib/recurring (which imports @/db) never becomes a bundle edge.
import type { RecurringChargeRow } from '@/lib/recurring';
import { recurringRowActions } from '@/lib/recurring-view';
// RELATIVE, like RecurringMarkForm.tsx: the client-bundle guard walks only @/ value imports.
import { setRecurringMarkAction, type ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

/**
 * Spec 2026-10-06 §2.2. A row's actions on the recurring page, the same in the table and the phone
 * list. Ruling R2's kebab rule: one action is a button, two or more are a RowMenu. A mark posts the
 * merchant's newest charge, so setRecurringMarkAction checks that row against the viewer.
 */
export function RecurringRowActions({ row }: { row: RecurringChargeRow }) {
  const [state, dispatch] = useActionState(setRecurringMarkAction, initial);
  const actions = recurringRowActions(row);
  if (actions.length === 1) {
    const only = actions[0];
    return only.kind === 'mark' ? (
      <RecurringMarkForm transactionId={row.transactionId} mark={only.mark} label={only.label} ariaLabel={only.ariaLabel} />
    ) : (
      <Link href={only.href} className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        {only.label}
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <RowMenu label={`Actions for ${row.merchant}`}>
        {actions.map((action) =>
          action.kind === 'mark' ? (
            <RowMenuForm key={action.mark} action={dispatch} fields={{ transactionId: String(row.transactionId), mark: action.mark }}>
              {action.label}
            </RowMenuForm>
          ) : (
            <RowMenuLink key={action.href} href={action.href}>
              {action.label}
            </RowMenuLink>
          ),
        )}
      </RowMenu>
      <FormError message={state.error} />
    </div>
  );
}
