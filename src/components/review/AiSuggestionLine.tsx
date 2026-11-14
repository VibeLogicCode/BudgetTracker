'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/SubmitButton';
import type { AiSuggestionView } from '@/lib/ai/types';
// RELATIVE, as MerchantGroups.tsx does: the client-bundle guard follows `@/` value imports and
// cannot tell a 'use server' file from an ordinary module.
import { acceptAiSuggestionAction, ignoreAiSuggestionAction } from '../../app/(app)/transactions/ai-actions';
import type { ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

type Report = (state: ActionState) => void;

/** The server action, with its result handed up to the page's own message line. */
function reporting(
  run: (prev: ActionState, formData: FormData) => Promise<ActionState>,
  onResult: Report | undefined,
): (prev: ActionState, formData: FormData) => Promise<ActionState> {
  return async (prev, formData) => {
    const result = await run(prev, formData);
    onResult?.(result);
    return result;
  };
}

/**
 * v1.64.0 (plan lane C3). One quiet line under a Review row: what the local AI suggests for the
 * row's merchant, each part with its own Use, and Ignore. Nothing here files anything by itself:
 * Use posts to acceptAiSuggestionAction, which hands the existing category or rename action the
 * form. "Remember for future rows" is ticked by default, as the bulk Categorize bar's is, and not
 * offered for a merchant with no text or one marked Always ask (no rule would be written).
 * Results go to `onResult`, so the page's existing banner says them.
 */
export function AiSuggestionLine({
  transactionId,
  merchant,
  suggestion,
  canRemember,
  alwaysAsk,
  onResult,
}: {
  transactionId: number;
  merchant: string;
  suggestion: AiSuggestionView;
  canRemember: boolean;
  alwaysAsk: boolean;
  onResult?: Report;
}) {
  const [, useAction] = useActionState(reporting(acceptAiSuggestionAction, onResult), initial);
  const [, ignoreAction] = useActionState(reporting(ignoreAiSuggestionAction, onResult), initial);
  const offerRemember = canRemember && !alwaysAsk && merchant !== '';
  const [remember, setRemember] = useState(true);
  const label = merchant === '' ? 'this row' : merchant;
  const hasCategory = suggestion.categoryLabel !== null;
  const hasName = suggestion.cleanName !== null;
  if (!hasCategory && !hasName) return null;

  const hidden = (part: 'category' | 'name') => (
    <>
      <input type="hidden" name="transactionId" value={String(transactionId)} />
      <input type="hidden" name="part" value={part} />
      {offerRemember && remember ? <input type="hidden" name="remember" value="1" /> : null}
    </>
  );

  return (
    <div data-ai-suggestion className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
      <span className="badge badge--slate">AI</span>
      <span>AI suggests:</span>
      {hasCategory ? (
        <form action={useAction} className="flex items-center gap-1.5">
          {hidden('category')}
          <span className="font-medium text-ink">{suggestion.categoryLabel}</span>
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Use ${suggestion.categoryLabel} for ${label}`}>
            Use
          </SubmitButton>
        </form>
      ) : null}
      {hasCategory && hasName ? <span aria-hidden="true">·</span> : null}
      {hasName ? (
        <form action={useAction} className="flex items-center gap-1.5">
          {hidden('name')}
          <span className="font-medium text-ink">{`Name: ${suggestion.cleanName}`}</span>
          <SubmitButton variant="secondary" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Use the name ${suggestion.cleanName}`}>
            Use
          </SubmitButton>
        </form>
      ) : null}
      {offerRemember ? (
        <label className="flex min-h-11 items-center gap-2 text-ink sm:min-h-0">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="accent-accent"
          />
          {`Remember for future ${merchant} rows`}
        </label>
      ) : null}
      <form action={ignoreAction}>
        <input type="hidden" name="merchant" value={merchant} />
        <SubmitButton variant="ghost" size="sm" className="min-h-11 sm:min-h-0" ariaLabel={`Ignore the AI suggestion for ${label}`}>
          Ignore
        </SubmitButton>
      </form>
    </div>
  );
}
