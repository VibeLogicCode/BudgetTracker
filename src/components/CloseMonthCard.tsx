'use client';

import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
// A RELATIVE import, deliberately — see DismissImportForm.tsx's comment on the identical line for
// why the client-bundle guard needs it that way for a 'use server' module.
import { closeMonthAction, type CloseMonthState } from '../app/(app)/import/actions';

const initial: CloseMonthState = {};

export interface OpenMonthView {
  month: string;
  label: string;
  accounts: { name: string; linked: boolean; synced: boolean; lastSyncAt: string | null }[];
  waiting: string[];
  needsConfirmation: boolean;
}

/**
 * 2026-09-08. "September is not closed" — the one place the household says last month's data is
 * all in, so the monthly summary can wait for it instead of firing on a calendar date.
 *
 * WHY A BUTTON AND NOT A RULE, in the owner's words: "what happens if 1 of the accounts doesnt have
 * any entry for 15 days in next month and there is nothing to import ... because we have simplefin
 * too transactions can auto come in too using logic we have not is not reliable."
 *
 * He is right. A quiet savings account with nothing to import is indistinguishable, from the data,
 * from one whose statement has not arrived — so any inference either stalls the summary forever or
 * eventually sends figures that are wrong. A person knows. One press covers every manual account.
 *
 * ON THE IMPORT PAGE because this is where somebody is standing the moment they have finished
 * importing, which is the only moment the question is easy to answer.
 *
 * SELF-HIDING, like every other attention card in this app: absent when there is no open month, and
 * absent for a household whose accounts are all SimpleFIN-linked (those close themselves, so
 * `needsConfirmation` is false and the app never asks).
 */
export function CloseMonthCard({ months }: { months: OpenMonthView[] }) {
  const [state, dispatch] = useActionState(closeMonthAction, initial);
  const pending = months.filter((row) => row.needsConfirmation);
  if (pending.length === 0) return null;

  return (
    <Card as="section">
      <CardHeader
        title={pending.length === 1 ? `${pending[0].label} is not closed` : `${pending.length} months are not closed`}
        description="Closing a month sends its summary. Until then the app waits, rather than reporting a month it only has part of."
      />
      <CardBody>
        <div className="flex flex-col gap-4">
          {/* Oldest first — the order they happened, which is the order they should be confirmed. */}
          {pending.map((row) => (
            <div key={row.month} className="flex flex-col gap-2 border-b border-line pb-4 last:border-b-0 last:pb-0">
              <ul className="flex flex-col gap-1 text-sm">
                {row.accounts.map((account) => (
                  <li key={account.name} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-ink">{account.name}</span>
                    <span className="text-muted">
                      {/* A linked account states what the app knows; a manual one states that only
                          the person does. Saying "imported Sep 6" next to a manual account would
                          imply the app had drawn a conclusion from that date, which is exactly the
                          inference this design refuses to make. */}
                      {!account.linked
                        ? 'imported by hand'
                        : account.synced
                          ? `synced ${(account.lastSyncAt ?? '').slice(0, 10)}, current`
                          : `synced ${(account.lastSyncAt ?? 'never').slice(0, 10)}, waiting`}
                    </span>
                  </li>
                ))}
              </ul>
              {row.waiting.length > 0 ? (
                <p className="text-xs text-muted">
                  {`${row.waiting.join(', ')} ${row.waiting.length === 1 ? 'has' : 'have'} not synced past the end of ${row.label} yet. You can still close it — the summary will say so.`}
                </p>
              ) : null}
              <form action={dispatch} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="month" value={row.month} />
                <SubmitButton size="sm">{`Close ${row.label} and send the summary`}</SubmitButton>
              </form>
            </div>
          ))}
          {state.closed !== undefined ? (
            <p role="status" className="text-sm text-muted">
              Closed. The summary is on its way to everyone who takes it.
            </p>
          ) : null}
          <FormError message={state.error} />
        </div>
      </CardBody>
    </Card>
  );
}
