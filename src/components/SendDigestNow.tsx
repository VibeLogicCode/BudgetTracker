'use client';

import { useActionState, useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { SubmitButton } from '@/components/SubmitButton';
import { RowDialog } from '@/components/ui/RowDialog';
// A RELATIVE import, deliberately -- see DismissImportForm.tsx's own comment on the identical
// line for why the client-bundle guard needs it that way for a 'use server' module.
import { sendDigestNowAction, type SendDigestState } from '../app/(app)/dashboard/actions';

const initial: SendDigestState = {};

/**
 * 2026-09-08, docs/superpowers/specs/2026-09-08-manual-digest-send-design.md. "Send me a summary
 * now", in the dashboard header row beside Add a transaction.
 *
 * WHY HERE and not in Settings → Notifications, where the digest's schedule lives: this is not
 * configuration, it is a thing somebody wants to DO, usually right after looking at the numbers on
 * this very page. The settings screen is where you go once to set a weekday; the dashboard is the
 * page every login lands on, which is the same reasoning RuleReviewCard's own docblock gives for
 * living here rather than on Import.
 *
 * WHY A DIALOG rather than a button that just sends. "Notify myself" and "notify everyone" are
 * genuinely different acts and the second one puts a message in front of other people, so the
 * choice has to be made deliberately rather than discovered afterwards. That is RowDialog's own
 * stated line for a page-level decision with a consequence (see its docblock) -- and "safe" would
 * be a reason for calmer copy inside the dialog, never for skipping it.
 *
 * The household option is simply ABSENT for a self-scoped member rather than present-and-refused.
 * The action refuses it too (that route is reachable directly), but a control that exists only to
 * say no is a worse explanation than the control not being there.
 */
export function SendDigestNow({ canNotifyHousehold }: { canNotifyHousehold: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useActionState(sendDigestNowAction, initial);

  // Closes on success only. A refusal -- rate limited, or a scope this account cannot use -- keeps
  // the dialog open so its FormError is somewhere the person is still looking; closing on every
  // settle would throw the one sentence explaining the refusal off screen at the moment it was
  // written. `state.sent` is the success signal rather than `!state.error`, because the initial
  // state has neither and must not count as a send.
  useEffect(() => {
    if (state.sent !== undefined) setOpen(false);
  }, [state.sent]);

  return (
    /**
     * Owner report, 2026-09-08: "doesnt fit the width or height of add transaction, seems out of
     * place". Two separate mistakes, both here.
     *
     * HEIGHT: the button carried `btn btn--secondary btn--sm` and stopped there, while
     * QuickAddTrigger beside it also carries `min-h-11 sm:min-h-0` -- the 44px touch floor this
     * codebase applies globally. Two buttons on one row, one of them 44px and one of them not, is
     * exactly as obvious as it sounds.
     *
     * WIDTH: this component returned a FRAGMENT whose siblings were the button, a status line and
     * an error line. The dashboard drops that fragment straight into a flex ROW, so the status text
     * became a flex item beside the buttons and stretched the row. A column wrapper keeps the row
     * holding buttons only, with anything this control has to say stacked underneath it.
     */
    <span className="inline-flex flex-col items-start gap-1 sm:items-end">
      <button
        type="button"
        className="btn btn--secondary btn--sm min-h-11 sm:min-h-0"
        onClick={() => setOpen(true)}
      >
        Send me a summary…
      </button>
      {/* Below the button, never beside it. The dialog is gone by the time this renders, and a
          person who just pressed a button is owed a visible answer naming who got it. */}
      {state.sent !== undefined ? (
        <span role="status" className="text-xs text-muted">
          {state.sent === 'household' ? 'Summary sent to you and the household channel.' : 'Summary sent to you.'}
        </span>
      ) : null}
      {!open && state.error !== undefined ? <span className="text-xs text-danger">{state.error}</span> : null}
      {open ? (
        <RowDialog
          dialogId="send-digest-dialog"
          title="Send a spending summary now"
          description="The same weekly summary, sent to whichever channels you have switched on."
          onClose={() => setOpen(false)}
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink">
              It covers the last seven days, ending yesterday — spending by category, top merchants,
              budget progress, and anything waiting to be reviewed.
            </p>
            <div className="flex flex-wrap gap-2">
              <form action={dispatch}>
                <input type="hidden" name="scope" value="self" />
                <SubmitButton size="sm">Just me</SubmitButton>
              </form>
              {canNotifyHousehold ? (
                <form action={dispatch}>
                  <input type="hidden" name="scope" value="household" />
                  <SubmitButton variant="secondary" size="sm">
                    Everyone in the household
                  </SubmitButton>
                </form>
              ) : null}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
            {/* Stated inside the dialog, where the household button is, rather than discovered by
                pressing it and getting nothing: routing is an admin setting, and a member who has
                not set it up should not read the silence as a bug. */}
            {canNotifyHousehold ? (
              <p className="text-xs text-muted">
                The household copy goes to the family channel, if one is set up in Settings →
                Notifications.
              </p>
            ) : null}
            <FormError message={state.error} />
          </div>
        </RowDialog>
      ) : null}
    </span>
  );
}
