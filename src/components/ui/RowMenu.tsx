'use client';

import Link from 'next/link';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * The row kebab (spec 2026-08-23, ruling R2). A row with two or more actions collapses them
 * into one ⋯ button; a row with a single action keeps that button, because a menu of one is
 * worse than a button.
 *
 * POSITIONING IS THE WHOLE DESIGN. The menu is `position: fixed`, placed from the trigger's
 * getBoundingClientRect() at open time. It is NOT absolute, and must never become absolute:
 * every table in this app sits inside TableWrap's `overflow-x-auto`, and an absolutely
 * positioned child of an overflow container is CLIPPED at the container's edge -- the defect
 * this redesign exists to remove ("Cre...", "Spli...", "Assign to l..."). Fixed positioning
 * escapes the clip without a portal, at the price of not tracking the container as it scrolls;
 * so scroll and resize close the menu instead, which is cheaper and sturdier than repositioning
 * something the reader has already scrolled away from.
 *
 * No third-party menu library. The repo has none for this and does not gain one.
 */
const MENU_WIDTH_REM = '14rem';
const MENU_WIDTH_PX = 224;
const GAP_PX = 4;

/** One menu open at a time. Module-level because the trigger being clicked has to shut a menu
 *  belonging to a DIFFERENT row, and two table rows share no React ancestor that knows both. */
let closeOpenMenu: (() => void) | null = null;

const RowMenuContext = createContext<{ close: () => void } | null>(null);

function useRowMenuClose(): () => void {
  const context = useContext(RowMenuContext);
  return context === null ? () => {} : context.close;
}

/**
 * v1.12.1 (item AV / UX-7): `py-2.5 text-sm` below the `sm:` breakpoint. Menu items were roughly
 * 26px tall stacked 4px apart -- well under the 44px minimum, and exactly where the destructive
 * items and the rule-writing select live. The menu is `position: fixed` at 14rem, so it has the
 * room. Every new value is scoped back to today's at `sm:`, so desktop is unchanged.
 *
 * Fix round 1: `py-2.5 text-sm` alone renders ~40px (20px padding + 20px line-height), 4px short
 * of the 44px floor -- the padding literal was a faithful copy of a spec value that was itself
 * wrong; the requirement is the rendered height. `min-h-11` (44px) is the explicit floor, the
 * same idiom the trigger button already uses (`h-11 w-11 ... sm:h-8 sm:w-8`); `sm:min-h-0` lets
 * desktop fall back to its unconstrained, padding-driven height exactly as before.
 */
const ITEM_CLASS =
  'flex w-full min-h-11 items-center rounded-xs px-2.5 py-2.5 text-left text-sm text-ink hover:bg-surface-2 focus:bg-surface-2 focus:outline-none sm:min-h-0 sm:py-1.5 sm:text-xs';

function menuItems(root: HTMLElement | null): HTMLElement[] {
  return root === null ? [] : Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    closeOpenMenu = null;
    if (refocus) trigger.current?.focus();
  }, []);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect === undefined) return;
    if (closeOpenMenu !== null) closeOpenMenu();
    closeOpenMenu = () => close(false);
    // Right-aligned under the trigger, then clamped inside the viewport: the kebab is the
    // last column, so a left-aligned menu would hang off the right edge.
    const left = Math.max(
      GAP_PX,
      Math.min(rect.right - MENU_WIDTH_PX, window.innerWidth - MENU_WIDTH_PX - GAP_PX),
    );
    setPosition({ top: rect.bottom + GAP_PX, left });
    setOpen(true);
  };

  // Opens upward when there is no room below -- the last row of a long table is exactly where
  // a downward menu would open off-screen.
  useLayoutEffect(() => {
    if (!open) return;
    const element = menu.current;
    const rect = trigger.current?.getBoundingClientRect();
    if (element === null || rect === undefined) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0 && rect.bottom + GAP_PX + height > window.innerHeight) {
      setPosition((previous) => ({ ...previous, top: Math.max(GAP_PX, rect.top - GAP_PX - height) }));
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) === true || trigger.current?.contains(target) === true) return;
      close(false);
    };
    const onMove = () => close(false);
    document.addEventListener('mousedown', onPointerDown);
    // Capture, because the scroll that matters is the TableWrap's own, not the window's.
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, close]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menu.current);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length]?.focus();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    // v1.12.1 (item AW / UX-8): close(TRUE). Escape already returned focus to the trigger;
    // choosing an item did not -- the menu closed, the page re-rendered and focus landed on
    // document.body, so a keyboard or screen-reader user who deactivated a member was dumped at
    // the top of the document with no announcement and a long tab back. The outside-click and
    // scroll/resize paths below deliberately KEEP close(false): stealing focus back from wherever
    // somebody just clicked is its own defect. The success/error Notice banners are already live
    // regions, so the announcement follows for free.
    <RowMenuContext.Provider value={{ close: () => close(true) }}>
      <span className="inline-flex">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => (open ? close(false) : show())}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink sm:h-8 sm:w-8"
        >
          <span aria-hidden="true" className="text-base leading-none">
            ⋯
          </span>
        </button>
        {open ? (
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            style={{ position: 'fixed', top: position.top, left: position.left, width: MENU_WIDTH_REM }}
            className="z-50 flex flex-col gap-0.5 rounded-md border border-line bg-surface p-1 shadow-card"
          >
            {children}
          </div>
        ) : null}
      </span>
    </RowMenuContext.Provider>
  );
}

export function RowMenuLink({ href, children }: { href: string; children: ReactNode }) {
  const close = useRowMenuClose();
  return (
    <Link href={href} role="menuitem" tabIndex={-1} onClick={() => close()} className={ITEM_CLASS}>
      {children}
    </Link>
  );
}

export function RowMenuButton({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  const close = useRowMenuClose();
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        close();
        onSelect();
      }}
      className={ITEM_CLASS}
    >
      {children}
    </button>
  );
}

export function RowMenuForm({
  action,
  fields,
  confirm,
  children,
}: {
  action: (formData: FormData) => void | Promise<unknown>;
  fields: Record<string, string>;
  /**
   * v1.12.1 (item AU / UX-6, ruling R5). When set, this sentence is put to the person before the
   * submission starts. Used by the two ROW-level destructive actions -- Remove an installment,
   * Unassign a loan -- matching the plain confirm() the receipt delete on the warranty detail page
   * already uses. The two ACCOUNT-level ones (Deactivate, Reset MFA) get the heavier inline panel
   * instead, in users-manager.tsx, because "which person" has to stay visible while you decide.
   */
  confirm?: string;
  children: ReactNode;
}) {
  const close = useRowMenuClose();
  return (
    // role="none" because a <form> sitting between role="menu" and role="menuitem" breaks the
    // parent/child relationship assistive tech relies on; the form is plumbing, not structure.
    // Closing in onSubmit (not onClick) so the submission has already started -- the same idiom
    // accounts-manager.tsx uses for its editor row, `onSubmit={() => setEditing(null)}`.
    // Wrapped so the return type matches <form>'s own `action` prop (void | Promise<void>):
    // the public `action` signature stays `Promise<unknown>` because that is the frozen
    // useActionState dispatcher contract this component is built against -- the union is wide
    // enough that any async server action already fits it, so callers must not have to narrow
    // it themselves.
    <form
      action={(formData: FormData) => {
        void action(formData);
      }}
      role="none"
      onSubmit={(event) => {
        // `window.confirm`, spelled out: the PROP is called `confirm` and shadows the global
        // inside this component, so the bare name here would be a call to a string.
        if (confirm !== undefined && !window.confirm(confirm)) {
          event.preventDefault();
          return;
        }
        close();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" role="menuitem" tabIndex={-1} className={ITEM_CLASS}>
        {children}
      </button>
    </form>
  );
}
