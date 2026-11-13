'use client';

import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { Card, CardHeader } from '@/components/ui/Card';
// RELATIVE, like RecurringMarkForm.tsx: the client-bundle guard walks only @/ value imports.
import { setRecurringMarkAction, type ActionState } from '../app/(app)/transactions/actions';
// Type-only, so @/lib/setup-suggestions (which imports @/db) never becomes a bundle edge.
import type { SetupSuggestion } from '@/lib/setup-suggestions';

const initial: ActionState = {};

function SuggestionRow({ suggestion, onDone }: { suggestion: SetupSuggestion; onDone: (merchant: string, message: string) => void }) {
  const [state, dispatch] = useActionState(setRecurringMarkAction, initial);
  useEffect(() => {
    if (state.message) onDone(suggestion.merchant, state.message);
  }, [state.message, suggestion.merchant, onDone]);
  const button = (mark: 'recurring' | 'not_recurring', label: string) => (
    <form action={dispatch}>
      <input type="hidden" name="transactionId" value={String(suggestion.transactionId)} />
      <input type="hidden" name="mark" value={mark} />
      <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`${label}: ${suggestion.merchant}`}>
        {label}
      </SubmitButton>
    </form>
  );
  return (
    <li className="flex flex-col gap-2 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p className="min-w-0 text-sm text-ink">{suggestion.sentence}</p>
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        {button('recurring', 'Mark recurring')}
        {button('not_recurring', 'Not recurring')}
        <FormError message={state.error} />
      </div>
    </li>
  );
}

/**
 * v1.62.0 lane E2. "Make your numbers sharper", the anchor Lane D's month-check-in line links to
 * (`/insights#sharper`). Quiet: a plain card with rows, no banner. Hidden when there is nothing to
 * suggest and nothing just done. A finished row leaves the list at once and the result is read out
 * through the live region; the server list catches up when the action revalidates the page.
 */
export function SetupSuggestionsCard({ suggestions, recurringHref }: { suggestions: SetupSuggestion[]; recurringHref: string }) {
  const [done, setDone] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const onDone = (merchant: string, message: string) => {
    setDone((prev) => (prev[merchant] === message ? prev : { ...prev, [merchant]: message }));
    setAnnouncement(message);
  };
  const open = suggestions.filter((suggestion) => done[suggestion.merchant] === undefined);
  return (
    <div id="sharper" className={open.length === 0 && announcement === '' ? 'hidden' : 'scroll-mt-4'}>
      <p role="status" aria-live="polite" className={announcement ? 'px-1 pb-2 text-sm text-muted' : 'sr-only'}>
        {announcement}
      </p>
      {open.length === 0 ? null : (
        <Card>
          <CardHeader
            title="Make your numbers sharper"
            description="Merchants whose dates show a rhythm. Telling the app which are real recurring charges keeps the month check-in honest."
            className="pb-3"
          />
          <ul>
            {open.map((suggestion) => (
              <SuggestionRow key={suggestion.merchant} suggestion={suggestion} onDone={onDone} />
            ))}
          </ul>
          <p className="border-t border-line px-4 py-3 text-sm sm:px-5">
            <Link href={recurringHref} className="font-medium text-accent-text underline underline-offset-2">
              Full Recurring list
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
