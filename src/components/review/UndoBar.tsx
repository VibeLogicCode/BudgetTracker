'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
// A RELATIVE import, for the reason PossibleDuplicatesCard.tsx gives: the client-bundle guard
// follows `@/`-qualified value imports and cannot tell a 'use server' file from an ordinary module.
import { undoBulkAction, type ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

/** What the Undo bar shows: the change's own label, and the time it stops being undoable. */
export interface UndoOffer {
  /** `Categorized 12 transactions as Groceries.` -- the first sentence of that change's message. */
  label: string;
  /** `14:32`, or `Mar 11 at 00:20` past midnight -- formatted on the server in the household zone. */
  until: string;
}

/**
 * v1.62.0 (plan item 3). Undo for the signed-in person's own last bulk change, for 15 minutes.
 *
 * Props only, nothing read here: page.tsx hands the offer down (lastBulkUndo, src/lib/bulk-undo.ts)
 * already formatted, so this component reaches no database and knows no time zone. It sits above
 * the bulk toolbar in every view of the Transactions page, because the change it offers to take
 * back was made from that toolbar, a group card or a group dialog on this same page.
 *
 * The live region is ALWAYS rendered, empty until an undo answers. A successful undo revalidates
 * the page, the offer comes back null and the bar goes -- so the sentence saying what was put back
 * has to live in something that stays, or it would vanish before anyone heard it.
 */
export function UndoBar({ undo }: { undo: UndoOffer | null }) {
  const [state, action] = useActionState(undoBulkAction, initial);
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={state.message ? 'rounded-md bg-positive-soft px-3.5 py-3 text-sm text-positive-soft-fg' : 'sr-only'}
      >
        {state.message ?? ''}
      </p>
      <FormError message={state.error} />
      {undo === null ? null : (
        <form
          action={action}
          data-undo-bar
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface-2 px-4 py-3"
        >
          <span className="min-w-0 flex-1 text-sm text-ink">{undo.label}</span>
          <span className="text-xs text-muted">{`Until ${undo.until}.`}</span>
          {/* One Undo on the page, beside the sentence it takes back, so its name stays the one word. */}
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0">
            Undo
          </SubmitButton>
        </form>
      )}
    </>
  );
}
