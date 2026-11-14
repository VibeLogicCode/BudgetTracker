'use client';

import { useActionState, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { Field, inputClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
import type { LocalAiStatus } from '@/lib/ai/types';
import {
  forgetAiSuggestionsAction,
  saveLocalAiAction,
  testLocalAiAction,
  turnOffLocalAiAction,
  type LocalAiActionState,
} from './ai-actions';

/**
 * v1.64.0 Lane B. The Local AI card. Props only: the page formats the times in the household's
 * zone, so this file imports no server module as a value.
 */
export interface LocalAiCardProps {
  /** `enabled` true with `state: 'off'`: switched on over an address or model that no longer passes. */
  status: Pick<LocalAiStatus, 'state' | 'failures' | 'lastError' | 'counts'> & Partial<Pick<LocalAiStatus, 'enabled'>>;
  /** Household-clock labels, already formatted (`14:32`, `Tomorrow at 03:10`). */
  lastOkLabel: string | null;
  nextTryLabel: string | null;
  baseUrl: string;
  model: string;
}

const initial: LocalAiActionState = {};

function statusSentence(props: Pick<LocalAiCardProps, 'status' | 'lastOkLabel' | 'nextTryLabel'>): string {
  const { status, lastOkLabel, nextTryLabel } = props;
  if (status.state === 'off' && status.enabled === true) {
    return 'Off. The saved address or model is no longer accepted, so nothing is sent. Save a new one, or turn it off.';
  }
  if (status.state === 'off') return 'Off. Nothing is sent anywhere.';
  if (status.state === 'waiting') {
    const tries = `${status.failures} failed ${status.failures === 1 ? 'try' : 'tries'}`;
    const next = nextTryLabel ? ` Next try about ${nextTryLabel}.` : '';
    const last = status.lastError ? ` Last problem: ${status.lastError}` : '';
    return `Waiting after ${tries}.${next}${last}`;
  }
  if (!lastOkLabel) return 'On. No answer yet.';
  const { suggested, toAsk } = status.counts;
  return `On. Last answer at ${lastOkLabel}. ${suggested} ${suggested === 1 ? 'merchant has' : 'merchants have'} a suggestion; about ${toAsk} ${toAsk === 1 ? 'is' : 'are'} still to ask.`;
}

function Result({ state }: { state: LocalAiActionState }) {
  if (state.error) return <FormError message={state.error} />;
  if (state.message) return <Notice tone="success">{state.message}</Notice>;
  return null;
}

export function LocalAiCard(props: LocalAiCardProps) {
  const [saveState, save, savePending] = useActionState(saveLocalAiAction, initial);
  const [testState, test, testPending] = useActionState(testLocalAiAction, initial);
  const [offState, turnOff, offPending] = useActionState(turnOffLocalAiAction, initial);
  const [forgetState, forget, forgetPending] = useActionState(forgetAiSuggestionsAction, initial);
  const [confirmForget, setConfirmForget] = useState(false);
  const busy = savePending || testPending || offPending || forgetPending;
  // Turn off is offered while the switch is on, even over a saved address that no longer passes
  // (state 'off', enabled true), so the admin can clear it.
  const on = props.status.state !== 'off' || props.status.enabled === true;
  const knownCount = props.status.counts.suggested + props.status.counts.ignored + props.status.counts.failed;
  const models = testState.models ?? [];

  return (
    <Card className="max-w-xl">
      <CardHeader
        title="Local AI (optional)"
        description="Suggestions from a model you run on your own network, with Ollama or llama.cpp. Off until you turn it on. Nothing is sent anywhere else."
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          It runs on your own model server on the home network, sends nothing anywhere else, and only ever suggests: it never files a
          row or changes anything by itself.
        </p>
        <p role="status" className="text-sm font-medium text-ink">
          {statusSentence(props)}
        </p>

        <form action={save} className="flex flex-col gap-3">
          <Field label="Model server address" htmlFor="local-ai-address" hint="An address on your own network, like a 192.168.x.x address.">
            <input
              id="local-ai-address"
              name="baseUrl"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              defaultValue={props.baseUrl}
              placeholder="http://192.168.1.50:11434"
              className={inputClass}
            />
          </Field>
          <Field label="Model name" htmlFor="local-ai-model">
            <input
              id="local-ai-model"
              name="model"
              type="text"
              autoComplete="off"
              spellCheck={false}
              defaultValue={props.model}
              placeholder="llama3.2:3b"
              list={models.length > 0 ? 'local-ai-models' : undefined}
              className={inputClass}
            />
          </Field>
          {models.length > 0 ? (
            <datalist id="local-ai-models">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonClass('primary')}>
              Save and turn on
            </button>
            <button type="submit" formAction={test} disabled={busy} className={buttonClass('secondary')}>
              Test
            </button>
          </div>
          {testPending ? <p className="text-sm text-muted">Testing… the first answer can take a minute while the model loads.</p> : null}
          <Result state={saveState} />
          <Result state={testState} />
          {models.length > 0 ? (
            <p className="text-sm text-muted">The server lists: {models.join(', ')}. Type or pick one in the model name field.</p>
          ) : null}
        </form>

        {on ? (
          <form action={turnOff} className="flex flex-col gap-2">
            <div>
              <button type="submit" disabled={busy} className={buttonClass('secondary')}>
                Turn off
              </button>
            </div>
            <Result state={offState} />
          </form>
        ) : (
          <Result state={offState} />
        )}

        {knownCount > 0 || forgetState.message || forgetState.error ? (
          <form action={forget} className="flex flex-col gap-2 border-t border-line pt-3">
            {knownCount > 0 ? (
              <>
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="confirm"
                    value="1"
                    checked={confirmForget}
                    onChange={(e) => setConfirmForget(e.target.checked)}
                  />
                  Yes, forget every AI suggestion, including the ones I ignored
                </label>
                <div>
                  <button type="submit" disabled={busy || !confirmForget} className={buttonClass('danger')}>
                    Forget all AI suggestions
                  </button>
                </div>
              </>
            ) : null}
            <Result state={forgetState} />
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
