// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';
import { RowDialog } from '@/components/ui/RowDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
  document.body.innerHTML = '';
});

function SheetView({ withFirst = true, onClose = () => {} }: { withFirst?: boolean; onClose?: () => void }) {
  return (
    <Sheet
      sheetId="t"
      title="Groceries"
      description="March 2026 · spent $50.00 of $200.00"
      onClose={onClose}
      footer={<a href="/x">Open in Transactions</a>}
    >
      {withFirst ? <button>First row</button> : null}
      <button>Last row</button>
    </Sheet>
  );
}

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div>
      <button>Opener</button>
      {open ? <SheetView onClose={onClose} /> : null}
    </div>
  );
}

function mountRoot(node: ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { root, container };
}

function unmountRoot(root: Root) {
  act(() => root.unmount());
}

describe('Sheet', () => {
  it('is a labelled modal dialog: the title names it, the description describes it', () => {
    render(<SheetView />);
    const dialog = screen.getByRole('dialog', { name: 'Groceries' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)!.textContent).toBe('March 2026 · spent $50.00 of $200.00');
  });

  it('takes focus on open and gives it back to the opener on close', () => {
    const { rerender } = render(<Harness open={false} onClose={() => {}} />);
    const opener = screen.getByText('Opener');
    opener.focus();
    rerender(<Harness open onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    rerender(<Harness open={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes it; an Escape something inside already handled does not', () => {
    const onClose = vi.fn();
    render(<SheetView onClose={onClose} />);
    fireEvent.keyDown(screen.getByText('First row'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();

    const again = vi.fn();
    render(
      <Sheet sheetId="t" title="Groceries" onClose={again}>
        <div onKeyDown={(e) => e.preventDefault()}>
          <button>Inner</button>
        </div>
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByText('Inner'), { key: 'Escape' });
    expect(again).not.toHaveBeenCalled();
  });

  it('Tab wraps inside it', () => {
    render(<SheetView />);
    const close = screen.getByText('Close');
    const link = screen.getByText('Open in Transactions');
    link.focus();
    fireEvent.keyDown(link, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(link);
  });

  it('Shift+Tab from the focused panel wraps to the last stop instead of leaving it', () => {
    render(<SheetView />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText('Open in Transactions'));
  });

  it('a click on the backdrop closes it, a click inside does not, and Close closes it', () => {
    const onClose = vi.fn();
    render(<SheetView onClose={onClose} />);
    fireEvent.click(screen.getByTestId('t-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  /** Review Focus 5. */
  it('locks the page scroll while open, and stacked modals release it in either order', () => {
    const dialog = () => (
      <RowDialog dialogId="d" title="Over" onClose={() => {}}>
        <button>Inside</button>
      </RowDialog>
    );

    let sheet = mountRoot(<SheetView />);
    let over = mountRoot(dialog());
    expect(document.body.style.overflow).toBe('hidden');
    unmountRoot(sheet.root);
    expect(document.body.style.overflow).toBe('hidden');
    unmountRoot(over.root);
    expect(document.body.style.overflow).toBe('');

    sheet = mountRoot(<SheetView />);
    over = mountRoot(dialog());
    expect(document.body.style.overflow).toBe('hidden');
    unmountRoot(over.root);
    expect(document.body.style.overflow).toBe('hidden');
    unmountRoot(sheet.root);
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps the page from shifting: the scrollbar width goes onto the body padding while locked', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: window.innerWidth - 15,
    });
    try {
      const { rerender } = render(<Harness open={false} onClose={() => {}} />);
      expect(document.body.style.paddingRight).toBe('');
      rerender(<Harness open onClose={() => {}} />);
      expect(document.body.style.paddingRight).toBe('15px');
      rerender(<Harness open={false} onClose={() => {}} />);
      expect(document.body.style.paddingRight).toBe('');
    } finally {
      delete (document.documentElement as { clientWidth?: number }).clientWidth;
    }
  });

  /** Review Focus 2. */
  it('when the opener is gone, focus goes to the modal underneath', () => {
    const { rerender } = render(<SheetView />);
    screen.getByText('First row').focus();
    const over = mountRoot(
      <RowDialog dialogId="d" title="Over" onClose={() => {}}>
        <button>Inside</button>
      </RowDialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Over' }));
    rerender(<SheetView withFirst={false} />);
    unmountRoot(over.root);
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Groceries' }));
  });

  /** Review Focus 2. */
  it('when the focused element inside it is removed, focus comes back to it', () => {
    const { rerender } = render(<SheetView />);
    screen.getByText('Last row').focus();
    expect(document.activeElement).toBe(screen.getByText('Last row'));
    rerender(
      <Sheet sheetId="t" title="Groceries" onClose={() => {}}>
        <button>First row</button>
      </Sheet>,
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Groceries' }));
  });

  it('arrives without leaving a transform behind', () => {
    render(<SheetView />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('sheet-panel');
    const banned = /(^|\s)(backdrop-blur\S*|blur\S*|transform|translate-\S+|scale-\S+|rotate-\S+|motion-keep)(\s|$)/;
    expect(banned.test(dialog.className)).toBe(false);
    expect(banned.test(screen.getByTestId('t-backdrop').className)).toBe(false);

    const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    for (const name of ['sheet-from-bottom', 'sheet-from-right']) {
      const start = css.indexOf(`@keyframes ${name}`);
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', css.indexOf('}', start) + 1) + 1);
      expect(block).toContain('from');
      expect(block).not.toContain('to {');
      expect(block).not.toContain('100%;\n');
      expect(/(^|[^\w-])100%\s*\{/.test(block)).toBe(false);
    }
    expect(/\.sheet-panel\s*\{[^}]*animation/.test(css)).toBe(true);
  });
});
