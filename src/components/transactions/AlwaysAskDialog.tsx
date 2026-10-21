'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { RowDialog } from '@/components/ui/RowDialog';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { buttonClass } from '@/components/ui/Button';
import { alwaysAskPattern } from '@/lib/categorize/normalize';
// RELATIVE, like RecurringMarkForm.tsx and QuickAddTransaction.tsx: the client-bundle guard walks
// only @/ value imports, and cannot tell a 'use server' file from an ordinary module.
import {
  previewAlwaysAskAction,
  sendBackToReviewAction,
  setAlwaysAskAction,
  type AlwaysAskState,
} from '../../app/(app)/transactions/actions';

const initial: AlwaysAskState = {};

/**
 * The "Always ask for rows like this" dialog, shared by the Transactions page and the Budgets card
 * (spec 2026-10-21 (fix from Budgets) §2.2). Moved out of the Transactions page unchanged.
 *
 * Spec 2026-10-21 §2.1. The live count runs once on open and after each change, 300 ms after the
 * last keystroke, and never once the rule is saved. `saved` flips to the send-back offer on the SAVE
 * action's success only; a refusal leaves the text on screen. Count, save and send back are three
 * separate action states so none can show another's error. The dialog closes once the rows are sent
 * back, after `onSent` lets the caller refresh what it lists. Mount it with `key` per row.
 */
export function AlwaysAskDialog({
  merchant,
  onClose,
  onSent,
}: {
  /** normalizedMerchant; the pattern starts at alwaysAskPattern(merchant), Contains. */
  merchant: string;
  onClose: () => void;
  /** Rows went back to review: the caller refreshes what it lists and shows the action's message. Called before onClose. */
  onSent?: (message: string) => void;
}) {
  const [pattern, setPattern] = useState(() => alwaysAskPattern(merchant));
  const [matchType, setMatchType] = useState<'contains' | 'exact'>('contains');
  const [saved, setSaved] = useState(false);
  const [previewState, preview] = useActionState(previewAlwaysAskAction, initial);
  const [saveState, save] = useActionState<AlwaysAskState, FormData>(setAlwaysAskAction, initial);
  const [sendBackState, sendBack] = useActionState(sendBackToReviewAction, initial);

  useEffect(() => {
    if (saved) return;
    const timer = setTimeout(() => {
      const fd = new FormData();
      fd.set('pattern', pattern);
      fd.set('matchType', matchType);
      startTransition(() => preview(fd));
    }, 300);
    return () => clearTimeout(timer);
    // preview is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, matchType, saved]);

  useEffect(() => {
    if (saveState.ruleId !== undefined && !saveState.error) setSaved(true);
  }, [saveState]);

  useEffect(() => {
    if (sendBackState.message && !sendBackState.error) {
      onSent?.(sendBackState.message);
      onClose();
    }
    // onSent/onClose are the caller's inline closures; only a new send result should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendBackState]);

  const sendBackCount = saveState.sendBackCount ?? 0;
  return (
    <RowDialog dialogId="always-ask-dialog" title="Always ask for rows like this" onClose={onClose}>
      {saved ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{saveState.message}</p>
          {sendBackCount > 0 ? (
            <>
              <p className="text-sm text-muted">
                {sendBackCount === 1 ? '1 of them was filed by a rule or a guess.' : `${sendBackCount} of them were filed by a rule or a guess.`}
              </p>
              <form action={sendBack} className="flex flex-col gap-3">
                <input type="hidden" name="ruleId" value={saveState.ruleId ?? ''} />
                <SubmitButton size="sm" className="w-fit">
                  {`Send ${sendBackCount} back to review`}
                </SubmitButton>
              </form>
            </>
          ) : null}
          <FormError message={sendBackState.error} />
          <div className="flex gap-2">
            <button type="button" className={buttonClass('secondary', 'sm')} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">No rule or guess will file a matching row. Each one waits in review for you to choose.</p>
          <FormError message={saveState.error ?? previewState.error} />
          <form action={save} className="flex flex-col gap-3" data-testid="always-ask-form">
            <Field label="Text to match">
              <input name="pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Match">
              <select
                name="matchType"
                value={matchType}
                onChange={(e) => setMatchType(e.target.value === 'exact' ? 'exact' : 'contains')}
                className={selectClass}
              >
                <option value="contains">Contains</option>
                <option value="exact">Exact</option>
              </select>
            </Field>
            {previewState.message ? (
              <p role="status" className="text-sm text-ink" data-testid="always-ask-count">
                {previewState.message}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button type="button" className={buttonClass('ghost', 'sm')} onClick={onClose}>
                Cancel
              </button>
              <SubmitButton size="sm" className="w-fit">
                Always ask
              </SubmitButton>
            </div>
          </form>
        </>
      )}
    </RowDialog>
  );
}
