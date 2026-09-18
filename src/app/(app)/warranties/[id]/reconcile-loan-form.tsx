'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Notice } from '@/components/ui/Notice';
import { Field, inputClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
import { formatCents } from '@/lib/money';
// Relative, like every other client component in this route folder: a '@/' edge into a
// 'use server' module is one tests/ops/client-bundle.test.ts follows into better-sqlite3, and
// living beside the route it belongs to is the shape the rest of the app already uses.
import { reconcileLoanAction } from '../actions';
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
  const [statedInterest, setStatedInterest] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [others, setOthers] = useState<Chips | null>(null);

  /**
   * Ruling S1. The file is read, the fields are FILLED IN, and nothing is saved -- a person still
   * presses the button below. The chips show every other figure the reader found with the words
   * around it, because seeing "Minimum payment due $312.00" is how somebody knows why not to pick
   * it, and no scoring function is going to be right about every lender's layout.
   */
  async function readStatement(file: File): Promise<void> {
    setReadError(null);
    setReading(true);
    try {
      const body = new FormData();
      body.set('statement', file);
      const response = await fetch('/api/loans/statement-prefill', { method: 'POST', body });
      const found = (await response.json()) as PrefillResponse;
      if (!response.ok) {
        setReadError(found.error ?? 'That statement could not be read. Type the figures instead.');
        return;
      }
      if (found.balance != null) setStatementBalance(centsToInput(found.balance.valueCents));
      if (found.statementDate != null) setAsOfDate(found.statementDate.date);
      if (found.interest != null) setStatedInterest(centsToInput(found.interest.valueCents));
      setOthers(found.others ?? null);
      if (found.balance == null) {
        setReadError('Could not find a balance in that statement — type it from the page.');
      }
    } catch {
      setReadError('That statement could not be read. Type the figures instead.');
    } finally {
      setReading(false);
    }
  }

  const typed = parseLoose(statementBalance);
  const estimate = interest?.owingCents ?? null;
  const difference = typed === null || estimate === null ? null : typed - estimate;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="itemId" value={itemId} />

      {/*
        Three ways in, one way out: typing, a PDF, or a CSV all fill these same fields and all end
        at the same button. There is no separate "import" path that could write without a person
        looking at what it read (ruling S1).
      */}
      <div className="flex flex-col gap-2">
        <label className="text-sm text-muted">
          Have the statement as a file?{' '}
          <input
            type="file"
            accept=".pdf,application/pdf,.csv,text/csv"
            disabled={reading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void readStatement(file);
            }}
            className="text-sm"
          />
        </label>
        {reading ? <p className="text-sm text-muted">Reading the statement…</p> : null}
        {readError === null ? null : <Notice tone="warning">{readError}</Notice>}
        {others === null ? null : <Chips others={others} onPickBalance={setStatementBalance} onPickDate={setAsOfDate} />}
      </div>

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
        <input
          name="statedInterest"
          inputMode="decimal"
          placeholder="e.g. 1251.04"
          value={statedInterest}
          onChange={(event) => setStatedInterest(event.target.value)}
          className={inputClass}
        />
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

/** Every other figure the reader found, so a person can correct a wrong pick in one click. */
interface Chips {
  balance: { valueCents: number; snippet: string }[];
  statementDate: { date: string; snippet: string }[];
  interest: { valueCents: number; snippet: string }[];
}

interface PrefillResponse {
  balance?: { valueCents: number } | null;
  statementDate?: { date: string } | null;
  interest?: { valueCents: number } | null;
  others?: Chips | null;
  error?: string;
}

function Chips({
  others,
  onPickBalance,
  onPickDate,
}: {
  others: Chips;
  onPickBalance: (value: string) => void;
  onPickDate: (value: string) => void;
}) {
  if (others.balance.length === 0 && others.statementDate.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-subtle">Other figures found — pick one if we chose wrongly:</p>
      <div className="flex flex-wrap gap-2">
        {others.balance.slice(0, 5).map((candidate, index) => (
          <button
            key={`balance-${index}`}
            type="button"
            onClick={() => onPickBalance(centsToInput(candidate.valueCents))}
            className="rounded-md border border-line px-2 py-1 text-left text-xs text-muted hover:border-accent"
            /* The snippet is text from an arbitrary PDF: rendered as a text node and as a title,
               never as markup (MUST-13.3 restated for this surface). */
            title={candidate.snippet}
          >
            {formatCents(candidate.valueCents)}
            <span className="block max-w-56 truncate text-subtle">{candidate.snippet}</span>
          </button>
        ))}
        {others.statementDate.slice(0, 3).map((candidate, index) => (
          <button
            key={`date-${index}`}
            type="button"
            onClick={() => onPickDate(candidate.date)}
            className="rounded-md border border-line px-2 py-1 text-left text-xs text-muted hover:border-accent"
            title={candidate.snippet}
          >
            {candidate.date}
            <span className="block max-w-56 truncate text-subtle">{candidate.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Cents back into something the text field can show, and the server can parse again. */
function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
