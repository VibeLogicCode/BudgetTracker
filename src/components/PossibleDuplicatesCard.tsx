'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { CheckIcon } from '@/components/icons';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { dayLabel } from '@/lib/dates';
import { originLabel, type DuplicateCandidate } from '@/lib/import/origin';
import type { WaitingSetAsideRow } from '@/lib/import/set-aside';
import { formatCents } from '@/lib/money';
// A RELATIVE import, deliberately, for the reason DismissImportForm.tsx states at length: the
// client-bundle guard walks `@/`-qualified value imports looking for a path back to @/db/client,
// and it cannot tell a 'use server' file (whose body Next elides from the client bundle) apart
// from an ordinary module. A relative specifier is outside what that guard resolves.
import {
  dismissPossibleDuplicateAction,
  keepPossibleDuplicateAction,
  type ActionState,
} from '../app/(app)/transactions/actions';

const initial: ActionState = {};

const DELETE_CONFIRM =
  'Delete this possible duplicate? It stays out of every figure, and importing the same statement again or the next bank sync will leave it out too.';

/** `MAPLE GROCER -42.17 on Mar 9, added by hand, Alex`: the import preview's candidate line. */
function candidateLine(candidate: DuplicateCandidate, today: string): string {
  const person = candidate.personName ? `, ${candidate.personName}` : '';
  return `${candidate.description} ${formatCents(candidate.amountCents, { currency: false })} on ${dayLabel(candidate.date, today)}, ${originLabel(candidate.origin)}${person}`;
}

/**
 * The server action, with its success message handed up to the card. The row itself is gone once
 * the page revalidates, so a message kept in the row would vanish unread; the card's live region
 * stays and says it.
 */
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

function HeldRow({
  row,
  today,
  mayDelete,
  onDone,
}: {
  row: WaitingSetAsideRow;
  today: string;
  mayDelete: boolean;
  onDone: (message: string | null) => void;
}) {
  const [keepState, keepAction] = useActionState(reporting(keepPossibleDuplicateAction, onDone), initial);
  const [dismissState, dismissAction] = useActionState(reporting(dismissPossibleDuplicateAction, onDone), initial);
  const where = [dayLabel(row.date, today), row.accountName, originLabel(row.origin), row.importFilename]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  // Every row has the same two buttons, so each says which row it acts on when read on its own.
  const which = `${row.rawDescription} on ${dayLabel(row.date, today)}`;
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            <span className="min-w-0 break-words">{row.rawDescription}</span>
            <span className="badge badge--amber">Possible duplicate</span>
          </p>
          <p className="text-xs text-muted">{where}</p>
        </div>
        <Money cents={row.amountCents} className="text-sm font-semibold" />
      </div>
      <p className="text-sm text-muted">
        {row.candidate === null ? 'The matching row was deleted' : `Looks like: ${candidateLine(row.candidate, today)}`}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <form action={keepAction}>
          <input type="hidden" name="setAsideId" value={row.id} />
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Keep both: ${which}`}>
            Keep both
          </SubmitButton>
        </form>
        {mayDelete ? (
          <form
            action={dismissAction}
            onSubmit={(event) => {
              if (!window.confirm(DELETE_CONFIRM)) event.preventDefault();
            }}
          >
            <input type="hidden" name="setAsideId" value={row.id} />
            <SubmitButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Delete this one: ${which}`}>
              Delete this one
            </SubmitButton>
          </form>
        ) : null}
      </div>
      {row.candidate?.origin === 'manual' ? (
        <p className="text-xs text-subtle">
          To keep the bank&apos;s copy instead, choose Keep both, then delete the hand-typed row.
        </p>
      ) : null}
      <FormError message={keepState.error ?? dismissState.error} />
    </li>
  );
}

/**
 * v1.61.0 item 4a. Possible duplicates in Needs review: the rows an import or the bank sync held
 * because they look like a row already in the account from another road (src/lib/import/
 * cross-source.ts). A held row is not a transaction, so it counts in no figure until somebody
 * presses Keep both; Delete this one leaves it out for good, and the next import of the same
 * statement, or the sync's overlap, leaves it out again.
 *
 * Each row shows the held copy beside the row it may duplicate, because the decision is "are these
 * the same purchase", and that needs both in view. Data arrives as props (page.tsx loads
 * listWaitingSetAside, which hands a self-scoped viewer nothing); the labels come from the pure
 * origin.ts, so nothing here reaches @/db.
 *
 * Delete this one is offered to whoever the server would let do it (canActOnOwner: an admin, the
 * row's person, anyone for a shared row). The server check in dismissSetAsideRow is the guarantee;
 * hiding the button only keeps a person from finding a control that would then say no.
 *
 * Renders nothing visible when nothing waits, so the review queue looks as it always did (only the
 * empty live region that carries a decision's message). Under `?queue=duplicates` (`standalone`)
 * an empty list says so instead.
 */
export function PossibleDuplicatesCard({
  rows,
  today,
  viewerId = null,
  isAdmin = false,
  standalone = false,
}: {
  rows: WaitingSetAsideRow[];
  today: string;
  viewerId?: number | null;
  isAdmin?: boolean;
  standalone?: boolean;
}) {
  // The last Keep both / Delete this one's message. Kept here, not in the row, because the row
  // leaves the list when the page revalidates. The live region is always rendered first, empty until
  // then, and stays mounted whatever follows it, so a screen reader announces the message.
  const [done, setDone] = useState<string | null>(null);
  let body: React.ReactNode = null;
  if (rows.length > 0) {
    body = (
      <Card>
        <CardHeader
          title={`Possible duplicates (${rows.length})`}
          description="Each of these arrived from an import or the bank sync and looks like a row already in the account. It counts in no figure until you choose Keep both."
        />
        <ul className="border-t border-line">
          {rows.map((row) => (
            <HeldRow
              key={row.id}
              row={row}
              today={today}
              mayDelete={isAdmin || row.attributedUserId === null || row.attributedUserId === viewerId}
              onDone={setDone}
            />
          ))}
        </ul>
      </Card>
    );
  } else if (standalone) {
    body = (
      <Card>
        <EmptyState
          icon={CheckIcon}
          title="No possible duplicates are waiting."
          noAction="Held rows arrive from imports and the bank sync on their own, so there is nothing to start from here."
        >
          When an import or the bank sync meets a row that may already be here, it waits here for you to decide.
        </EmptyState>
      </Card>
    );
  }
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        className={done === null ? 'sr-only' : 'rounded-md bg-positive-soft px-3.5 py-3 text-sm text-positive-soft-fg'}
      >
        {done}
      </p>
      {body}
    </>
  );
}
