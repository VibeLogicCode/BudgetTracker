'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardHeader } from '@/components/ui/Card';
import { Money } from '@/components/ui/Money';
import { dayLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { PairSide, TransferPair } from '@/lib/transfer-pairs';
// A RELATIVE import, for the reason PossibleDuplicatesCard.tsx states: the client-bundle guard
// walks `@/`-qualified value imports and cannot tell a 'use server' file from an ordinary module.
import type { ActionState } from '../../app/(app)/transactions/actions';
import { confirmTransferPairAction, dismissTransferPairAction } from '../../app/(app)/transactions/transfer-pair-actions';

const initial: ActionState = {};

/** The action, with its message handed up: the pair leaves the list once the page revalidates. */
function reporting(
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>,
  onDone: (message: string | null) => void,
): (prev: ActionState, formData: FormData) => Promise<ActionState> {
  return async (prev, formData) => {
    const result = await action(prev, formData);
    onDone(result.message ?? null);
    return result;
  };
}

function Side({ side, today }: { side: PairSide; today: string }) {
  const person = side.personName ? ` · ${side.personName}` : '';
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
          <span className="min-w-0 break-words">{side.accountName}</span>
          {side.isTransfer ? <span className="badge badge--muted">already a transfer</span> : null}
        </p>
        <p className="text-xs text-muted">
          {dayLabel(side.date, today)} · {side.description}
          {person}
        </p>
      </div>
      <Money cents={side.amountCents} showSign className="text-sm font-semibold" />
    </div>
  );
}

function PairRow({ pair, today, onDone }: { pair: TransferPair; today: string; onDone: (message: string | null) => void }) {
  const [confirmState, confirmAction] = useActionState(reporting(confirmTransferPairAction, onDone), initial);
  const [dismissState, dismissAction] = useActionState(reporting(dismissTransferPairAction, onDone), initial);
  const which = `${formatCents(Math.abs(pair.out.amountCents))} from ${pair.out.accountName} to ${pair.in.accountName}`;
  const ids = (
    <>
      <input type="hidden" name="outId" value={pair.out.id} />
      <input type="hidden" name="inId" value={pair.in.id} />
    </>
  );
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
      <Side side={pair.out} today={today} />
      <Side side={pair.in} today={today} />
      <div className="flex flex-wrap items-start gap-2">
        <form action={confirmAction}>
          {ids}
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Mark both as a transfer: ${which}`}>
            Mark both as a transfer
          </SubmitButton>
        </form>
        <form action={dismissAction}>
          {ids}
          <SubmitButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Not a transfer: ${which}`}>
            Not a transfer
          </SubmitButton>
        </form>
      </div>
      <FormError message={confirmState.error ?? dismissState.error} />
    </li>
  );
}

/**
 * v1.62.0 lane C. Possible transfers: equal and opposite amounts on two household accounts within
 * three days (src/lib/transfer-pairs.ts). Props only; page.tsx loads suggestTransferPairs and a
 * self-scoped viewer is never handed any. Renders nothing visible when there are no pairs, only the
 * live region that carries the last decision's message, so it stays mounted while the pair leaves.
 */
export function TransferPairsCard({ pairs, total, today }: { pairs: TransferPair[]; total: number; today: string }) {
  const [done, setDone] = useState<string | null>(null);
  const remaining = total - pairs.length;
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={done === null ? 'sr-only' : 'rounded-md bg-positive-soft px-3.5 py-3 text-sm text-positive-soft-fg'}
      >
        {done}
      </p>
      {pairs.length > 0 ? (
        <Card>
          <CardHeader
            title={`Possible transfers (${total})`}
            description="Each pair is the same amount leaving one account and arriving in another within three days."
          />
          <ul className="border-t border-line">
            {pairs.map((pair) => (
              <PairRow key={`${pair.out.id}:${pair.in.id}`} pair={pair} today={today} onDone={setDone} />
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-xs text-subtle sm:px-5">
            No rule is saved, so the next pair like this is suggested again.
            {remaining > 0 ? ` ${remaining} more after these are done.` : ''}
          </p>
        </Card>
      ) : null}
    </>
  );
}
