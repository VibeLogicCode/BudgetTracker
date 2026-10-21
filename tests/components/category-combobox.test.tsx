// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CategoryCombobox, filterCategoryOptions } from '@/components/CategoryCombobox';
import { RowDialog } from '@/components/ui/RowDialog';
import type { CategoryOption } from '@/lib/category-order';

afterEach(cleanup);

/** The shape categoryOptions() produces: parent at depth 0, its children at depth 1 beneath it. */
const OPTIONS: CategoryOption[] = [
  { id: 1, label: 'Food', depth: 0 },
  { id: 2, label: 'Groceries', depth: 1 },
  { id: 3, label: 'Restaurants', depth: 1 },
  { id: 4, label: 'Home', depth: 0 },
  { id: 5, label: 'Home Insurance', depth: 1 },
  { id: 6, label: 'Transport', depth: 0 },
];

function open(): HTMLInputElement {
  const input = screen.getByRole('combobox') as HTMLInputElement;
  fireEvent.focus(input);
  return input;
}

function type(value: string): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
}

describe('filterCategoryOptions: what typing narrows to', () => {
  it('keeps everything for an empty query', () => {
    expect(filterCategoryOptions(OPTIONS, '')).toHaveLength(OPTIONS.length);
  });

  it('matches case-insensitively, anywhere in the label -- not just from the start, which is all a native select can do', () => {
    // 'Home' rides along because a matched child keeps its parent: see the rule below.
    expect(filterCategoryOptions(OPTIONS, 'ins').map((o) => o.label)).toEqual(['Home', 'Home Insurance']);
  });

  /**
   * A child kept on its own would read as a top-level category of the same name -- "Groceries"
   * with nothing above it. Keeping the parent as context is what makes a filtered list still
   * describe the tree it came from.
   */
  it('keeps a matched child under its parent', () => {
    expect(filterCategoryOptions(OPTIONS, 'grocer').map((o) => o.label)).toEqual(['Food', 'Groceries']);
  });

  it('keeps every child of a matched parent, so picking the whole branch stays possible', () => {
    expect(filterCategoryOptions(OPTIONS, 'food').map((o) => o.label)).toEqual(['Food', 'Groceries', 'Restaurants']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(filterCategoryOptions(OPTIONS, 'zzz')).toEqual([]);
  });
});

describe('CategoryCombobox: choosing with the keyboard', () => {
  it('renders the current value as the input text', () => {
    render(<CategoryCombobox options={OPTIONS} value={2} onChange={vi.fn()} label="Category" />);
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Groceries');
  });

  it('opens on focus and lists the options', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" />);
    open();
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBe(OPTIONS.length + 1); // + Uncategorized
  });

  it('narrows the list as you type', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" />);
    open();
    type('rest');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Food', 'Restaurants']);
  });

  it('reports the chosen id on Enter', () => {
    const onChange = vi.fn();
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={onChange} label="Category" />);
    const input = open();
    type('rest');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Food
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // Restaurants
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('reports null when Uncategorized is chosen', () => {
    const onChange = vi.fn();
    render(<CategoryCombobox options={OPTIONS} value={2} onChange={onChange} label="Category" />);
    const input = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reports the clicked option', () => {
    const onChange = vi.fn();
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={onChange} label="Category" />);
    open();
    fireEvent.mouseDown(screen.getByText('Transport'));
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('abandons the typed text on Escape and shows the value again', () => {
    render(<CategoryCombobox options={OPTIONS} value={2} onChange={vi.fn()} label="Category" />);
    const input = open();
    type('zzz');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('Groceries');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says so rather than showing an empty box when nothing matches', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" />);
    open();
    type('zzz');
    expect(screen.getByText(/No category matches/i)).toBeTruthy();
  });
});

/**
 * v1.57.2: an assignment picker on a since-archived category carries that ONE category as a
 * disabled option (categoryOptions in src/lib/category-order.ts). It reads as the current value,
 * is listed so the household can see it, and cannot be chosen.
 */
describe('CategoryCombobox: the current archived category', () => {
  const WITH_ARCHIVED: CategoryOption[] = [...OPTIONS, { id: 9, label: 'Lanterns (archived)', depth: 0, disabled: true }];

  it('shows it as the current value and lists it as a disabled option', () => {
    render(<CategoryCombobox options={WITH_ARCHIVED} value={9} onChange={vi.fn()} label="Category" />);
    const input = open();
    expect(input.value).toBe('Lanterns (archived)');
    const option = screen.getByRole('option', { name: 'Lanterns (archived)' });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.getAttribute('aria-selected')).toBe('true');
  });

  it('will not choose it by click or by Enter', () => {
    const onChange = vi.fn();
    render(<CategoryCombobox options={WITH_ARCHIVED} value={2} onChange={onChange} label="Category" />);
    const input = open();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Lanterns (archived)' }));
    type('lant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CategoryCombobox: the wiring a screen reader needs', () => {
  it('marks itself as a combobox over a listbox, and says whether it is open', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" />);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('points aria-activedescendant at the highlighted option', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" />);
    const input = open();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toBe('Food');
  });

  it('carries a name, so the field is announced', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category for the selected transactions" />);
    expect(screen.getByLabelText('Category for the selected transactions')).toBeTruthy();
  });

  /**
   * Every call site sits inside a <form> that posts a category id. The combobox is a text input,
   * so the id travels in a hidden field beside it -- without this the form would post the typed
   * text, or nothing at all.
   */
  it('posts the chosen id through a hidden field when given a name', () => {
    const { container } = render(
      <CategoryCombobox options={OPTIONS} value={3} onChange={vi.fn()} label="Category" name="categoryId" />,
    );
    const hidden = container.querySelector('input[type="hidden"][name="categoryId"]') as HTMLInputElement;
    expect(hidden.value).toBe('3');
  });
});

/**
 * Not every category picker offers "Uncategorized", and not every one starts on a value. The
 * bulk-categorize toolbar assigns a category to a batch -- offering Uncategorized there would be
 * offering to un-file work somebody has already filed -- while the split and recategorize dialogs
 * start deliberately unchosen, so that neither pre-arms a destination nobody picked.
 */
describe('CategoryCombobox: pickers that do not offer Uncategorized', () => {
  it('leaves Uncategorized out of the list when asked to', () => {
    render(
      <CategoryCombobox options={OPTIONS} value={null} onChange={vi.fn()} label="Category" includeUncategorized={false} />,
    );
    open();
    expect(screen.queryByText('Uncategorized')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length);
  });

  it('shows the placeholder rather than a category name while nothing is chosen', () => {
    render(
      <CategoryCombobox
        options={OPTIONS}
        value={null}
        onChange={vi.fn()}
        label="Category"
        includeUncategorized={false}
        placeholder="Choose a category"
      />,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.getAttribute('placeholder')).toBe('Choose a category');
  });

  it('posts an empty hidden field while nothing is chosen, so a form cannot submit a category nobody picked', () => {
    const { container } = render(
      <CategoryCombobox
        options={OPTIONS}
        value={null}
        onChange={vi.fn()}
        label="Category"
        name="categoryId"
        includeUncategorized={false}
      />,
    );
    expect((container.querySelector('input[type="hidden"]') as HTMLInputElement).value).toBe('');
  });
});

/**
 * 2026-09-15, found by the `$impeccable critique` evidence pass and confirmed by reading the DOM
 * chain: the listbox was `position: absolute`, and EVERY call site renders inside `RowDialog`,
 * whose panel wraps `<Card as="div">` -- and `.card` carries `overflow-hidden`. So a category list
 * opened low in a dialog was clipped by its own container: the split editor, the recategorize
 * dialog, and the Create-a-rule dialog shipped in v1.39.0.
 *
 * `RowMenu` had already solved this exact problem and its docblock says so in capitals
 * ("POSITIONING IS THE WHOLE DESIGN ... it is NOT absolute, and must never become absolute"),
 * naming the clipped-label defect it was written to remove. The combobox simply never inherited
 * the fix. These tests are what stop it regressing a third time.
 */
describe('CategoryCombobox: the listbox escapes its container', () => {
  it('is fixed, not absolute, so an overflow-hidden ancestor cannot clip it', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    open();
    const listbox = screen.getByRole('listbox');
    // The class is what a reviewer greps for; the inline style is what the browser honours.
    expect(listbox.className).not.toMatch(/\babsolute\b/);
    expect(listbox.style.position).toBe('fixed');
  });

  it('places itself from the input own rect, the way RowMenu does', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    const input = open();
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      top: 100, bottom: 140, left: 40, right: 240, width: 200, height: 40, x: 40, y: 100, toJSON: () => ({}),
    } as DOMRect);
    // Re-open so the placement runs against the mocked rect.
    fireEvent.blur(input);
    fireEvent.focus(input);
    const listbox = screen.getByRole('listbox');
    expect(listbox.style.width).toBe('200px');
    expect(parseFloat(listbox.style.top)).toBeGreaterThanOrEqual(140);
  });

  function rect(top: number): DOMRect {
    return { top, bottom: top + 40, left: 40, right: 240, width: 200, height: 40, x: 40, y: top, toJSON: () => ({}) } as DOMRect;
  }

  it('stays open while its own list is scrolled', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    open();
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(screen.queryByRole('listbox')).toBeTruthy();
  });

  it('keeps focus in the field when the list itself (its scrollbar, its padding) is pressed', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    open();
    // fireEvent returns false when the handler called preventDefault -- which is what stops the
    // browser moving focus off the input, and so stops blur from closing the list.
    expect(fireEvent.mouseDown(screen.getByRole('listbox'))).toBe(false);
    expect(screen.queryByRole('listbox')).toBeTruthy();
  });

  it('follows its field when the page scrolls, instead of closing', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    expect(screen.getByRole('listbox').style.top).toBe('344px');

    spy.mockReturnValue(rect(200));
    fireEvent.scroll(window);
    expect(screen.getByRole('listbox').style.top).toBe('244px');
  });

  it('follows its field when the window resizes, as a phone keyboard does', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    spy.mockReturnValue(rect(120));
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('listbox').style.top).toBe('164px');
  });

  it('closes once its field has scrolled out of a clipping ancestor, though still inside the window', () => {
    const { container } = render(
      <div data-testid="panel" style={{ overflow: 'auto' }}>
        <CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />
      </div>,
    );
    const panel = container.querySelector('[data-testid="panel"]') as HTMLElement;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
      { top: 200, bottom: 600, left: 0, right: 800, width: 800, height: 400, x: 0, y: 200, toJSON: () => ({}) } as DOMRect,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    // Scrolled up past the panel's top edge: on screen, but under the panel's clip.
    spy.mockReturnValue(rect(120));
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  /**
   * v1.57.1. A dialog's fixed layer rendered inside a card that clips: the card's rect is on the
   * page, not around the centred dialog, and it must not decide whether the field can be seen.
   */
  function fixedPanelInClippingCard(outerStyle: React.CSSProperties = { overflow: 'hidden' }) {
    const { container } = render(
      <div data-testid="card" style={outerStyle}>
        <div data-testid="panel" style={{ position: 'fixed', overflowY: 'auto' }}>
          <CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />
        </div>
      </div>,
    );
    const card = container.querySelector('[data-testid="card"]') as HTMLElement;
    const panel = container.querySelector('[data-testid="panel"]') as HTMLElement;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(
      { top: 900, bottom: 1000, left: 0, right: 800, width: 800, height: 100, x: 0, y: 900, toJSON: () => ({}) } as DOMRect,
    );
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
      { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500, x: 0, y: 100, toJSON: () => ({}) } as DOMRect,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    return { panel, spy };
  }

  it('inside a fixed panel, an ancestor above the panel does not clip it, so a scroll keeps the list open', () => {
    const { panel } = fixedPanelInClippingCard();
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeTruthy();
  });

  it('inside a fixed panel, still closes once the field scrolls out of the panel itself', () => {
    const { panel, spy } = fixedPanelInClippingCard();
    spy.mockReturnValue(rect(40));
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('an ancestor that holds fixed elements itself (a transform) still clips a fixed panel inside it', () => {
    const { panel } = fixedPanelInClippingCard({ overflow: 'hidden', transform: 'translateX(0px)' });
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  // Tailwind v4's scale-*, translate-* and rotate-* utilities set these properties, not `transform`.
  it('the individual scale, translate and rotate properties hold fixed elements too', () => {
    const { panel } = fixedPanelInClippingCard({ overflow: 'hidden', scale: '1' });
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('past a non-clipping ancestor that holds fixed elements, a clipping ancestor above it still counts', () => {
    const { container } = render(
      <div data-testid="card" style={{ overflow: 'hidden' }}>
        <div style={{ transform: 'translateX(0px)' }}>
          <div data-testid="panel" style={{ position: 'fixed', overflowY: 'auto' }}>
            <CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />
          </div>
        </div>
      </div>,
    );
    vi.spyOn(container.querySelector('[data-testid="card"]') as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      { top: 900, bottom: 1000, left: 0, right: 800, width: 800, height: 100, x: 0, y: 900, toJSON: () => ({}) } as DOMRect,
    );
    const panel = container.querySelector('[data-testid="panel"]') as HTMLElement;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(
      { top: 100, bottom: 600, left: 0, right: 800, width: 800, height: 500, x: 0, y: 100, toJSON: () => ({}) } as DOMRect,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    fireEvent.scroll(panel);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is not a Tab stop, so Tab leaves the field instead of landing on the list', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    open();
    expect(screen.getByRole('listbox').getAttribute('tabindex')).toBe('-1');
  });

  it('flips above its field when there is no room below, and re-checks as it follows', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    const listHeight = vi.spyOn(HTMLUListElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    try {
      const input = screen.getByRole('combobox') as HTMLInputElement;
      const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(700));
      fireEvent.focus(input);
      expect(screen.getByRole('listbox').style.top).toBe('496px');
      spy.mockReturnValue(rect(100));
      fireEvent.scroll(window);
      expect(screen.getByRole('listbox').style.top).toBe('144px');
    } finally {
      listHeight.mockRestore();
    }
  });

  it('closes once its field has scrolled fully out of view', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    const spy = vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(rect(300));
    fireEvent.focus(input);
    spy.mockReturnValue(rect(-60));
    fireEvent.scroll(window);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('CategoryCombobox: Escape, mouse button and layer', () => {
  function renderInDialog(onClose: () => void, onChange: (next: number | null) => void = () => {}) {
    render(
      <RowDialog dialogId="d" title="T" onClose={onClose}>
        <CategoryCombobox options={OPTIONS} value={null} onChange={onChange} label="Category" />
      </RowDialog>,
    );
  }

  it('Escape inside a dialog closes only the open list', () => {
    const onClose = vi.fn();
    renderInDialog(onClose);
    const input = open();
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a second Escape, with the list closed, reaches the dialog', () => {
    const onClose = vi.fn();
    renderInDialog(onClose);
    const input = open();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a right or middle click does not pick an option', () => {
    const onChange = vi.fn();
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={onChange} label="Category" />);
    open();
    const option = () => screen.getByRole('option', { name: 'Groceries' });
    fireEvent.mouseDown(option(), { button: 2 });
    fireEvent.mouseDown(option(), { button: 1 });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.mouseDown(option(), { button: 0 });
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('its list sits below the sticky app header', () => {
    render(<CategoryCombobox options={OPTIONS} value={null} onChange={() => {}} label="Category" />);
    open();
    const listClass = screen.getByRole('listbox').className;
    expect(listClass).toMatch(/\bz-20\b/);
    const shell = readFileSync(join(process.cwd(), 'src/components/app-shell/AppShell.tsx'), 'utf8');
    const header = /<header[^>]*className="[^"]*\bsticky\b[^"]*\bz-(\d+)\b/.exec(shell);
    expect(header).not.toBeNull();
    expect(Number(header![1])).toBeGreaterThan(20);
  });
});
