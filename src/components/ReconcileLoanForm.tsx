'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Notice } from '@/components/ui/Notice';
import { Field, inputClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
import { formatCents } from '@/lib/money';
import { reconcileLoanAction } from '@/app/(app)/warranties/actions';
import type { LoanInterest } from '@/lib/loans';
import type { LoanDirection } from '@/lib/warranty/constants';

/**
 * Correct a loan from its statement, and log what the drift turned out to be.
 *
 * This is the answer to the fact that the app's estimate will never match a lender exactly. Rather
 * than chase accuracy it cannot reach, the app makes itself CORRECTABLE: type what the statement
 * says, and that figure becomes the new starting point. Everything before it becomes a closed
 * period with its own record of how far the estimate was out (rulings R1, R6, R8).
 *
 * The preview below the fields is the honest part. Before anything is written it says what the app
 * currently believes and how that compares with what has been typed, so a mistyped figure is
 * visible as an implausible difference rather than silently becoming the truth.
 *
 * WHY THERE IS NO UNDO. A reconciliation is a record that a person read a statement and it said
 * this. Deleting one would make the log lie about what was seen; correcting it is another
 * reconciliation, which is what the note field is prefilled for.
 */
export function ReconcileLoanForm({
  itemId,
  direction,
  interest,
  today,
  onClose,
}: {
  itemId: number;
  direction: LoanDirection;
  /** What the app currently believes, so the preview has something to compare against. */
  interest: LoanInterest | null;
  today: string;
  onClose?: () => void;
}) {
  const [state, action] = useActionState(reconcileLoanAction, {} as Awaited<ReturnType<typeof reconcileLoanAction>>);
  const [asOfDate, setAsOfDate] = useState(today);
  const [statementBalance, setStatementBalance] = useState('');

  const typed = parseLoose(statementBalance);
  const estimate = interest?.owingCents ?? null;
  const difference = typed === null || estimate === null ? null : typed - estimate;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="itemId" value={itemId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Statement date" hint="The date the statement is for, not the day you are typing it.">
          <input
            name="asOfDate"
            type="date"
            required
            value={asOfDate}
            onChange={(event) => setAsOfDate(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field
          label={direction === 'lent' ? 'Balance you both agree on' : 'Balance on the statement'}
          hint="Everything up to and including that day is treated as already inside this figure."
        >
          <input
            name="statementBalance"
            inputMode="decimal"
            required
            placeholder="e.g. 199037.12"
            value={statementBalance}
            onChange={(event) => setStatementBalance(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      {/*
        The single most valuable field here when a statement prints it. Everything else on this
        screen is an estimate; this is the lender's own figure, so summing it across statements
        answers "how much interest have I actually paid" with no rate and no convention involved.
      */}
      <Field
        label={direction === 'lent' ? 'Interest they paid you this period (optional)' : 'Interest charged this statement (optional)'}
        hint="If the statement prints it, this is the one interest figure the app never has to estimate."
      >
        <input name="statedInterest" inputMode="decimal" placeholder="e.g. 1251.04" className={inputClass} />
      </Field>

      <Field label="Note (optional)">
        <input name="note" maxLength={500} placeholder="e.g. rate changed at renewal" className={inputClass} />
      </Field>

      {difference === null ? null : (
        <Notice tone={Math.abs(difference) > 50_00 ? 'warning' : 'info'}>
          {estimate === null ? null : (
            <>
              Our estimate for {asOfDate} is {formatCents(estimate)}. You have typed{' '}
              {formatCents(typed!)} —{' '}
              {difference === 0
                ? 'exactly what we expected.'
                : `${formatCents(Math.abs(difference))} ${difference > 0 ? 'more' : 'less'}.`}{' '}
              Saving makes the statement the new starting point.
            </>
          )}
        </Notice>
      )}

      <FormError message={state.error} />
      {state.message === undefined ? null : <Notice tone="info">{state.message}</Notice>}

      <div className="flex flex-wrap gap-2">
        <SubmitButton>Save this statement</SubmitButton>
        {onClose === undefined ? null : (
          <button type="button" onClick={onClose} className={buttonClass('secondary')}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * A typed amount, in cents, for the PREVIEW only -- the server parses the real one with the app's
 * own money parser. Deliberately forgiving of what a person types off a statement: commas, a
 * currency symbol, spaces. Returns null while the field is still being typed, which is why the
 * preview simply does not appear yet rather than flashing a wrong comparison.
 */
function parseLoose(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.abs(value) * 100);
}
