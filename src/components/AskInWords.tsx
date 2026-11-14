'use client';

import { useActionState, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { inputClass } from '@/components/ui/form';
import type { AskState } from '@/lib/ai/ask';
// A RELATIVE import, for the reason DismissImportForm.tsx gives: the client-bundle guard follows
// `@/`-qualified value imports and cannot tell a 'use server' file from an ordinary module.
import { askInWordsAction } from '../app/(app)/transactions/ask-action';

const initial: AskState = {};

/**
 * v1.64.0 (plan 2026-11-12, E4). Ask in words, on the Transactions page's filter card. A typed
 * question goes to askInWordsAction, which answers with a /transactions link and how the app read
 * the question; this box shows the reading and opens the link. Every figure on the page is still
 * the page's own sum over that filter: the model only chooses filters.
 *
 * Props only. The page mounts it only while local AI is active, so with AI off there is no box
 * at all; if the server stops answering after the page loaded, the action says so in one line.
 * `maxChars` is the server's own limit (ASK_MAX_QUESTION_CHARS), handed down rather than repeated.
 */
export function AskInWords({ maxChars }: { maxChars: number }) {
  const router = useRouter();
  const hintId = useId();
  // Controlled, so the question stays in the box after the form's action resets it.
  const [question, setQuestion] = useState('');
  const [state, dispatch] = useActionState(async (previous: AskState, formData: FormData): Promise<AskState> => {
    const next = await askInWordsAction(previous, formData);
    if (next.href) router.push(next.href);
    return next;
  }, initial);

  return (
    <form action={dispatch} data-ask-in-words className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={maxChars}
          autoComplete="off"
          placeholder="Ask in words, like: what did we spend on groceries last month?"
          aria-label="Ask in words"
          aria-describedby={hintId}
          className={`${inputClass} min-h-11 min-w-[12rem] flex-1 sm:min-h-0`}
        />
        <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0">
          Ask
        </SubmitButton>
      </div>
      <p id={hintId} className="text-xs text-muted">
        Local AI on your network turns the question into the filters below. Totals are the app’s own sums.
      </p>
      <p role="status" aria-live="polite" className={state.reading ? 'text-sm text-ink' : 'sr-only'}>
        {state.reading ? `Read as: ${state.reading}.` : ''}
      </p>
      <FormError message={state.error} />
    </form>
  );
}
