import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/**
 * The modal behaviour RowDialog and Sheet share (v1.58.0, design §1: extract, not copy). It was
 * RowDialog's own opener capture, focus-in, Tab trap, Escape, scroll lock and focus-back; it moved
 * here so a second shell does not need a second copy. Imported only by client components.
 */

/**
 * Reported (item 1): nothing native (no <dialog>.showModal() here -- this app hand-rolls its
 * own overlays rather than take on a dialog library) keeps Tab cycling inside a dialog on its
 * own. `input[type="hidden"]` is excluded even though the plain tag-name selectors below would
 * otherwise match it: a hidden field can never actually receive focus in a real browser, and
 * counting it as a focus stop just breaks the wrap-around math by one at both ends. The element
 * list is read fresh on every Tab press (not cached once at open) because a dialog's own
 * "Add a part"/"Remove part"-style buttons can change how many focusable controls exist while it
 * stays open.
 *
 * v1.59.1: `summary` is a stop too, since a <details> disclosure's summary takes focus in a real
 * browser. A control inside a CLOSED <details> (other than its summary) is left out, because the
 * browser cannot focus it: counted, it would become the "last" stop, Tab from the real last stop
 * would leave the dialog, and Shift+Tab from the first would aim at something that cannot take focus.
 */
export const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Matches an element that sits inside a closed <details> and is not that details' summary. */
const INSIDE_CLOSED_DETAILS = 'details:not([open]) > :not(summary)';

/** The dialog's Tab stops in document order, leaving out what a closed disclosure hides. */
function dialogTabStops(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (element) => element.closest(INSIDE_CLOSED_DETAILS) === null,
  );
}

export function trapDialogTab(container: HTMLElement, event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = dialogTabStops(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  // The container itself counts as "before the first": a sheet's panel holds focus on open.
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

let lockCount = 0;
let savedOverflow = '';
let savedPaddingRight = '';

/**
 * Counted. The first lock keeps body's inline overflow and padding-right, sets overflow hidden and
 * grows padding-right by the scrollbar's width (innerWidth - documentElement.clientWidth, only when
 * clientWidth > 0) so the page behind does not shift; the last release puts both back. Calling one
 * release twice is a no-op. Counted so stacked modals (a dialog over a Sheet) release in any order.
 */
export function lockBodyScroll(): () => void {
  const body = document.body;
  if (lockCount === 0) {
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    const clientWidth = document.documentElement.clientWidth;
    const scrollbar = clientWidth > 0 ? window.innerWidth - clientWidth : 0;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) {
      const current = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbar}px`;
    }
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount === 0) {
      body.style.overflow = savedOverflow;
      body.style.paddingRight = savedPaddingRight;
    }
  };
}

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

/** The last [role="dialog"][aria-modal="true"] in document order, or null. */
export function topmostModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** What a hand-rolled modal owes a keyboard and screen-reader user. */
export function useModal(onClose: () => void): {
  ref: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  // Who had focus right before this modal opened, so closing it (Escape, the backdrop, Cancel,
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
   * The behaviours a real modal owes a keyboard/screen-reader user:
   *   - focus moves INTO the modal on open -- but only when nothing inside it has already claimed
   *     focus (a rename or assign-to-loan editor carries its own `autoFocus` input, a better
   *     default than the shell, and it must not be overridden a moment later);
   *   - the page behind stops scrolling while it is open;
   *   - focus returns to whatever had it before the modal opened when it closes; when that element
   *     has gone (a fix took its row off the list), to the modal still open underneath instead of
   *     the page behind.
   * Mount-once on purpose: each caller renders the modal only while it is open.
   */
  useEffect(() => {
    const self = ref.current;
    if (!self?.contains(document.activeElement)) self?.focus();
    const release = lockBodyScroll();
    return () => {
      release();
      const opener = openerRef.current;
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      // This modal's own element is normally detached by now; excluded anyway so the answer does
      // not depend on that ordering.
      const remaining = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).filter((el) => el !== self);
      remaining[remaining.length - 1]?.focus();
    };
  }, []);

  // When focus has fallen to the page (the focused row was removed), the topmost modal takes it
  // back rather than leaving the keyboard behind the backdrop.
  useEffect(() => {
    const active = document.activeElement;
    if ((active === null || active === document.body) && topmostModal() === ref.current) {
      ref.current?.focus();
    }
  });

  /** Escape closes the modal from anywhere inside it; every other key falls through to the focus
   *  trap. A key something inside already handled (a menu's or a list's own Escape) is left alone. */
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (ref.current) trapDialogTab(ref.current, event);
  }

  return { ref, onKeyDown };
}
