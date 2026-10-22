'use client';

import type { ReactElement, ReactNode } from 'react';
import { buttonClass } from '@/components/ui/Button';
import { useModal } from '@/components/ui/modal';

/**
 * A modal sheet: full height from the bottom on a phone, a drawer on the right from `sm` up with the
 * page visible beside it (v1.58.0, design §1). It shares RowDialog's focus, Tab trap, Escape and
 * counted scroll lock through `useModal` (decision 4), so the two stack and release in any order.
 * It is meant to sit as a sibling above the page and below any dialog opened from it, so that dialog
 * keeps its own Escape, Tab trap and fixed layer (decisions 1 and 4). Its slide is a CSS animation
 * that ends on no transform (decision 5), so a `position: fixed` menu inside it is placed against
 * the window, and it never carries a backdrop blur.
 */
export interface SheetProps {
  /** Ids `${sheetId}-heading` / `-description`; test ids `${sheetId}-backdrop` / `-body`. */
  sheetId: string;
  /** The accessible name (aria-labelledby). */
  title: ReactNode;
  /** A line under the title, read as the description (aria-describedby), not as the name. */
  description?: ReactNode;
  onClose: () => void;
  /** The body; it scrolls on its own. */
  children: ReactNode;
  /** Pinned under the body. Omitted, there is no footer. */
  footer?: ReactNode;
}

export function Sheet({ sheetId, title, description, onClose, children, footer }: SheetProps): ReactElement {
  const { ref, onKeyDown } = useModal(onClose);
  const headingId = `${sheetId}-heading`;
  const descriptionId = `${sheetId}-description`;

  return (
    <div
      data-testid={`${sheetId}-backdrop`}
      className="fixed inset-0 z-50 flex justify-end bg-black/50 sm:bg-black/20"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        // A click anywhere inside must not reach the backdrop above, which closes the sheet.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="sheet-panel flex h-full w-full flex-col bg-surface shadow-pop outline-none pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] sm:pl-0 sm:w-[30rem] sm:max-w-[calc(100%-3rem)] sm:border-l sm:border-line"
      >
        <div className="flex items-start gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className={buttonClass('ghost', 'sm', 'min-h-11 shrink-0 sm:min-h-0')}>
            Close
          </button>
        </div>
        <div data-testid={`${sheetId}-body`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
        {footer ? (
          <div className="border-t border-line px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
