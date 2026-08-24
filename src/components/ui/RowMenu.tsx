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

const ITEM_CLASS =
  'flex w-full items-center rounded-xs px-2.5 py-1.5 text-left text-xs text-ink hover:bg-surface-2 focus:bg-surface-2 focus:outline-none';

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
    <RowMenuContext.Provider value={{ close: () => close(false) }}>
      <span className="inline-flex">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => (open ? close(false) : show())}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"
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
            className="z-40 flex flex-col gap-0.5 rounded-md border border-line bg-surface p-1 shadow-card"
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
  children,
}: {
  action: (formData: FormData) => void | Promise<unknown>;
  fields: Record<string, string>;
  children: ReactNode;
}) {
  const close = useRowMenuClose();
  return (
    // role="none" because a <form> sitting between role="menu" and role="menuitem" breaks the
    // parent/child relationship assistive tech relies on; the form is plumbing, not structure.
    // Closing in onSubmit (not onClick) so the submission has already started -- the same idiom
    // accounts-manager.tsx uses for its editor row, `onSubmit={() => setEditing(null)}`.
    // Wrapped so the return type matches <form>'s own `action` prop (void | Promise<void>):
    // the public `action` signature stays `Promise<unknown>` because that is what
    // useActionState's dispatcher returns, and callers must not have to narrow it themselves.
    <form
      action={(formData: FormData) => {
        void action(formData);
      }}
      role="none"
      onSubmit={() => close()}
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
