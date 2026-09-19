'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Notice } from '@/components/ui/Notice';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
// Relative, like every other client component in this route folder: a '@/' edge into a
// 'use server' module is one tests/ops/client-bundle.test.ts follows into better-sqlite3.
import { recordLoanPaymentAction } from '../actions';
import type { LoanDirection } from '@/lib/warranty/constants';

/**
 * Record a payment on a loan by hand, on any past date.
 *
 * Reported 2026-09-19: a payment that never came through a bank import -- cash, an e-transfer the
 * household has not imported yet, a month of payments being entered after the fact -- had no route
 * in at all. The only way to move a loan's balance was to import the transaction first and link it.
 *
 * WHAT IT WRITES is an ordinary transaction, linked to the loan. A loan payment is spending
 * (MUST-13.2: the car payment still belongs in the Transport budget), so a loan-only row would
 * quietly take the money out of every other total in the app. The date is free to be in the past;
 * the ledger replays payments and postings together, so a back-dated payment lands in the cycle it
 * belongs to and the interest is worked out again from there.
 */
export function RecordLoanPaymentForm({
  itemId,
  direction,
  accounts,
  today,
  startDate,
  onClose,
}: {
  itemId: number;
  direction: LoanDirection;
  accounts: { id: number; name: string }[];
  today: string;
  /** The day the loan started: a payment cannot predate it. */
  startDate: string;
  onClose: () => void;
}) {
  const [state, action] = useActionState(
    recordLoanPaymentAction,
    {} as Awaited<ReturnType<typeof recordLoanPaymentAction>>,
  );

  if (accounts.length === 0) {
    return (
      <Notice tone="warning">
        Add a bank or cash account first — a payment has to come from somewhere.
      </Notice>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="itemId" value={itemId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={direction === 'lent' ? 'Amount they paid you' : 'Amount paid'}
          hint="What actually left the account, interest included."
        >
          <input name="amount" inputMode="decimal" required placeholder="e.g. 450.00" className={inputClass} />
        </Field>
        <Field label="Paid on" hint="Any date back to the day the loan started.">
          <input
            type="date"
            name="paidOn"
            required
            defaultValue={today}
            min={startDate}
            max={today}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label={direction === 'lent' ? 'Account it landed in' : 'Account it came from'}
        hint="The payment is recorded there as an ordinary transaction, so budgets and reports still see it."
      >
        <select name="accountId" defaultValue={String(accounts[0]?.id ?? '')} className={selectClass}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description (optional)" hint="Left blank, the transaction is named after the loan.">
        <input name="note" maxLength={200} placeholder="e.g. extra payment on the principal" className={inputClass} />
      </Field>

      <FormError message={state.error} />
      {state.message === undefined ? null : <Notice tone="success">{state.message}</Notice>}

      <div className="flex flex-wrap gap-2">
        <SubmitButton>Record this payment</SubmitButton>
        <button type="button" onClick={onClose} className={buttonClass('secondary')}>
          {state.message === undefined ? 'Cancel' : 'Close'}
        </button>
      </div>
    </form>
  );
}
