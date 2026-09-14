// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { CategoryCombobox, filterCategoryOptions } from '@/components/CategoryCombobox';
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
