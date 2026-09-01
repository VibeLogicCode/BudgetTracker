'use client';

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';

/**
 * Unify-the-editors task (2026-08-30). Every "edit one thing about this row" control on
 * Transactions used to pick between two idioms: the split editor was a real modal (backdrop,
 * focus trap, Escape, scroll lock, focus restored to the trigger), while note/rename/assign-to-
 * loan/apply-to-all were inline sub-rows wedged between a row and the next. The owner's report
 * was exactly that split: pressing "Add note" did not bring up the dialog they expected -- it
 * shoved the table down the page instead. This component is the one idiom the fix settles on,
 * factored out of the split editor's own implementation (transactions-client.tsx's previous
 * `onSplitDialogKeyDown`/the two focus-management effects that used to live beside `splitting`)
 * rather than rewritten, so every property that editor's own tests already prove -- role,
 * aria-modal, a labelled title, a focus trap, Escape, backdrop-click-only dismissal, body-scroll
 * lock, and focus restored to the trigger on close -- carries over unchanged to every caller.
 *
 * MOVED HERE v1.21.0 (item 10): this file used to live at src/app/(app)/transactions/RowDialog.tsx,
 * with its own docblock explicitly asking to be moved to src/components/ui/ "once that directory
 * is not held by a concurrent lane" -- nothing about the component is Transactions-specific, it
 * only lived there because that was the one directory an earlier task was allowed to touch. This
 * merchant-rules page needed the exact same "edit one thing about this row" dialog and was not
 * allowed to edit transactions-client.tsx or its sibling files, so rather than copy the ~150 lines
 * of focus-trap/scroll-lock/Escape logic a second time, this is the real move the old docblock was
 * waiting for. The transactions/ copy has since been deleted and that page repointed here, so this
 * is now the ONE implementation both callers share -- which was the point.
 *
 * Mount-once contract: the opener capture runs once at render (see its own comment below for why
 * it cannot wait for an effect), and the initial focus move plus the scroll lock run in a
 * `useEffect` with an EMPTY dependency array -- deliberately, in both cases: this component is
 * only ever rendered while its dialog is open (each caller conditionally renders it,
 * `{state ? <RowDialog ...>...</RowDialog> : null}`), so a fresh mount already IS a fresh open.
 * A caller switching which ROW this dialog acts on without an intervening close must pass a `key`
 * that changes with the row id, forcing a remount rather than re-using one instance across two
 * different rows -- see transactions-client.tsx's own call sites.
 */

/**
 * Owner report (item 1): nothing native (no <dialog>.showModal() here -- this app hand-rolls its
 * own overlays rather than take on a dialog library) keeps Tab cycling inside a dialog on its
 * own. `input[type="hidden"]` is excluded even though the plain tag-name selectors below would
 * otherwise match it: a hidden field can never actually receive focus in a real browser, and
 * counting it as a focus stop just breaks the wrap-around math by one at both ends. The element
 * list is read fresh on every Tab press (not cached once at open) because a dialog's own
 * "Add a part"/"Remove part"-style buttons can change how many focusable controls exist while it
 * stays open.
 */

/**
 * WHEN TO USE THIS vs a plain inline confirm (owner ask, 2026-08-31). The question came up because
 * v1.23.0's Canadian merchant pack panel (settings/merchant-rules/canadian-pack-panel.tsx) shipped
 * its install/remove-all/review-update confirmations as three inline `useState` disclosures --
 * not because that was a considered choice, but because the brief that produced that file spelled
 * out exactly what each confirmation had to SAY and DO and never named an idiom, so the file fell
 * back to copying the nearest existing pattern in the same directory instead of reaching for this
 * component. "Make every confirm a dialog" would have been the wrong fix, though -- this codebase
 * already has plenty of confirms that are correctly inline, on purpose, so the line has to be
 * drawn on what the confirm is ABOUT, not on how much it says:
 *
 *   - A confirm that belongs to ONE ROW -- the decision is "does THIS row survive, yes or no", and
 *     the person needs to keep seeing which row while they decide -- stays inline, anchored at
 *     that row. RowMenuForm's own `confirm` prop docblock (RowMenu.tsx) draws this line for the
 *     two lightest cases (Remove an installment, Unassign a loan: a plain `window.confirm`, no
 *     room needed). The heavier row-level ones that need more room than `confirm()` can hold --
 *     Deactivate / Reset MFA in settings/users/users-manager.tsx, the restore panel in
 *     settings/backups/backups-client.tsx -- stay inline too, as a panel that REPLACES or sits
 *     directly under that one row (users-manager.tsx spans every column, ruling S2), specifically
 *     BECAUSE turning them into a dialog would hide the one thing the decision turns on: which
 *     row. Word count never enters into it -- the backup restore panel is the longest confirm
 *     copy in the app and is still correctly inline for exactly this reason.
 *
 *   - A confirm that is PAGE-LEVEL -- there is no single row left for it to anchor to, because it
 *     acts on the page's data as a whole (install/remove/update an entire rule pack) or on a
 *     multi-row SELECTION (a bulk delete) rather than one row someone can keep looking at -- and
 *     carries wording that has to be read before agreeing, belongs in a dialog. It is one focused
 *     decision with a consequence, the same reason the split editor became a dialog instead of a
 *     card at the top of the page (this component's own top-of-file docblock): nothing else on
 *     the page competes for attention while it is open, Escape/backdrop/focus-trap all apply, and
 *     it does not silently push the rest of the page down the way an inline disclosure did.
 *
 * canadian-pack-panel.tsx's install/remove-all/review-update confirmations and
 * merchant-rules-client.tsx's bulk-delete confirmation are the worked example of the second case
 * (see their own docblocks for the conversion). Their PERSISTENT status line ("installed, v1 ·
 * 182 of 190 present") is not a decision at all and deliberately stays outside any dialog --
 * only the yes/no moment belongs in one.
 *
 * The one carve-out this docblock used to name -- "a page-level panel that only ever previews a
 * safe, reversible, non-destructive operation with nothing to lose has no obligation to become a
 * dialog", with merchant-rules-client.tsx's inline "Re-run rules" preview as its worked example --
 * was RETIRED in v1.24.0 at the owner's ask, and the reason is worth keeping rather than quietly
 * deleting. The reasoning was locally sound: a re-run only ever adds, so there was nothing
 * destructive to weigh. What it could not see is that the same page's Delete-and-clear now asks
 * the SAME question ("all time, or a date range?") in a dialog, and leaving the re-run inline
 * would teach that the two idioms signal different degrees of seriousness when they do not. So
 * the line above is now simply: page-level decisions are dialogs. "Safe" is a reason to write
 * calmer COPY inside the dialog, not a reason to use a different shell -- and a page-level
 * READOUT that asks for no decision at all still belongs outside one, exactly as the pack's
 * status line does. See RunRulesDialog in merchant-rules-client.tsx for the conversion.
 */
const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapDialogTab(container: HTMLElement, event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface RowDialogProps {
  /**
   * Root for this dialog's own `aria-labelledby` ids (`${dialogId}-heading`/`-description`) and
   * its backdrop's `data-testid` (`${dialogId}-backdrop`, unless `backdropTestId` overrides it).
   * A stable per-KIND id (`"split-dialog"`, `"note-dialog"`, ...) is enough -- there is never two
   * instances of the same kind mounted at once (each editor is its own nullable slot of state in
   * the caller), so this needs no per-row uniqueness of its own.
   */
  dialogId: string;
  /** Rendered as the dialog's heading (CardHeader's own `title` slot) AND named by
   *  `aria-labelledby` -- keep this naming the row the dialog acts on ("Split TIM HORTONS",
   *  "Note for SQ *UNKNOWN VENDOR 8841"), the copy pattern the note editor already established. */
  title: ReactNode;
  /** Optional second line under the title (CardHeader's own `description` slot), folded into
   *  `aria-labelledby` alongside the title when present. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** The split editor's multi-column parts table needs real width; a single textarea or a couple
   *  of fields do not, and forcing every dialog to the same 42rem cap would leave a lot of dead
   *  space around a one-line form. Defaults to the split editor's own historical width. */
  maxWidthClassName?: string;
  /** Overrides the default `${dialogId}-backdrop` -- only the split editor's existing tests pin
   *  a literal testid today, and its `dialogId` already produces that exact string, so no caller
   *  needs to pass this. Present for a future caller that must not derive it from `dialogId`. */
  backdropTestId?: string;
}

export function RowDialog({
  dialogId,
  title,
  description,
  onClose,
  children,
  maxWidthClassName = 'max-w-2xl',
  backdropTestId,
}: RowDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Who had focus right before this dialog opened, so closing it (Escape, the backdrop, Cancel,
  // or a real submit) puts focus back exactly where it was -- ported from the split editor's own
  // `splitOpenerRef`. Captured during RENDER, not inside the effect below, and that is load-
  // bearing now that rename/assign-to-loan bring an `autoFocus` input into this shell: React's
  // own handling of `autoFocus` runs synchronously in the COMMIT phase (a real `.focus()` call,
  // not reliance on the native HTML attribute), which happens before ANY `useEffect` -- including
  // this component's own -- gets a chance to run. Reading `document.activeElement` from an effect
  // would therefore capture the just-autofocused INPUT as "the opener", not the row-menu item or
  // note-indicator button that was actually clicked to get here. The render phase runs strictly
  // before commit, so this is the last point at which `document.activeElement` still reliably
  // names the real trigger. `useRef`'s lazy-init pattern (checked, not passed as the initial
  // value) keeps this a one-time read on the FIRST render rather than on every one.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }

  /**
   * The three behaviours a real modal owes a keyboard/screen-reader user, ported from the split
   * editor's own effect (previously keyed on `splitting?.id ?? null`; here it is simply
   * mount/unmount, see this file's own top-of-file docblock for why that is equivalent):
   *   - focus moves INTO the dialog on open -- but only when nothing inside it has already
   *     claimed focus. The split editor has no one obvious "first field" (there is no
   *     `autoFocus` anywhere in its parts table), so the dialog shell itself takes focus, same as
   *     before; the rename and assign-to-loan editors DO carry their own `autoFocus` input (a
   *     more specific, better default than the shell), and that already-focused element must be
   *     left alone rather than overridden a moment later;
   *   - the page behind stops scrolling while it is open, or a touch/wheel scroll would move a
   *     page the person can no longer see behind the dimmed backdrop;
   *   - focus returns to whatever had it before the dialog opened when it closes.
   */
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.focus();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Escape closes the dialog from anywhere inside it; every other key falls through to the
   *  focus trap so Tab still cycles within the dialog while it is open. */
  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (dialogRef.current) trapDialogTab(dialogRef.current, event);
  }

  const headingId = `${dialogId}-heading`;
  const descriptionId = `${dialogId}-description`;

  return (
    <div
      data-testid={backdropTestId ?? `${dialogId}-backdrop`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={description ? `${headingId} ${descriptionId}` : headingId}
        tabIndex={-1}
        // The panel's own onClick stops a click anywhere inside it from bubbling up to the
        // backdrop above, so clicking a control (or empty space) INSIDE the dialog never closes
        // it -- only the backdrop itself does.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className={`max-h-[90vh] w-full ${maxWidthClassName} overflow-y-auto rounded-xl outline-none`}
      >
        <Card as="div">
          <CardHeader
            title={<span id={headingId}>{title}</span>}
            description={description ? <span id={descriptionId}>{description}</span> : undefined}
          />
          <CardBody className="flex flex-col gap-4">{children}</CardBody>
        </Card>
      </div>
    </div>
  );
}
