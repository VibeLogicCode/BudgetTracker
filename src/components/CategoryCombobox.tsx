'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CategoryOption } from '@/lib/category-order';

/** What "no category" is called everywhere else on these screens. */
const UNCATEGORIZED = 'Uncategorized';

/** The breathing room between the field and the list it opens, matching RowMenu's own. */
const GAP_PX = 4;

/**
 * The options a query leaves, with the tree still intact.
 *
 * Two rules beyond a plain substring test, both about keeping the result readable as a TREE
 * rather than as a bag of labels:
 *   - a matched child keeps its parent, because "Groceries" alone reads as a top-level category
 *     and the household cannot see which branch it came from;
 *   - a matched parent keeps its children, because typing a branch name is how somebody asks to
 *     see that branch.
 *
 * Order is never rearranged: whatever survives stays in categoryOptions()' own order, which is
 * the Budgets page's order (see src/lib/category-order.ts). A filter that also re-ranked would
 * move a category out from under the finger already heading for it.
 */
export function filterCategoryOptions(options: CategoryOption[], query: string): CategoryOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;

  const matches = (option: CategoryOption) => option.label.toLowerCase().includes(needle);
  const keep = new Set<number>();

  let currentParent: CategoryOption | null = null;
  for (const option of options) {
    if (option.depth === 0) currentParent = option;
    if (!matches(option)) continue;
    keep.add(option.id);
    if (option.depth === 1 && currentParent !== null) keep.add(currentParent.id);
  }

  // A second pass for "a matched parent keeps its children": children follow their parent, so
  // this cannot be folded into the walk above without looking ahead.
  let parentKept = false;
  for (const option of options) {
    if (option.depth === 0) parentKept = keep.has(option.id) && matches(option);
    else if (parentKept) keep.add(option.id);
  }

  return options.filter((option) => keep.has(option.id));
}

export interface CategoryComboboxProps {
  /** From categoryOptions() -- parents at depth 0, their children at depth 1 beneath them. */
  options: CategoryOption[];
  /** The chosen category, or null for Uncategorized. */
  value: number | null;
  onChange: (next: number | null) => void;
  /** The accessible name. Rendered as the input's own <label>. */
  label: string;
  /** When given, the chosen id is posted under this name from the surrounding <form>. */
  name?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Whether null is offered as a choice ("Uncategorized"). False for a picker that assigns a
   * category to something already filed -- bulk categorize, a split part -- where offering to
   * un-file it is not a choice anybody wants on that screen. Default true.
   */
  includeUncategorized?: boolean;
  /**
   * What an unchosen field reads as when Uncategorized is not on offer. With
   * includeUncategorized false, null means "nothing picked yet" rather than "no category", so the
   * input shows this rather than a value it does not have.
   */
  placeholder?: string;
}

/**
 * A category picker you can type into.
 *
 * The deferred half of backlog BZ. The optgroup half shipped in v1.14.2 and made the list
 * READABLE; this makes a long one REACHABLE, which is the part a household with sixty categories
 * actually feels. Native <select> type-ahead only matches from the start of a label, so finding
 * "Home Insurance" means knowing it begins with "Home" -- this matches anywhere.
 *
 * Deliberately NOT used for the per-row select inside the transactions table. That control
 * changes one row in place and auto-saves on change (AutoSaveSelect); a native select is both
 * better suited to it -- the browser's own popup escapes the table's overflow, which a
 * div-based listbox has to fight -- and the thing whose save semantics are already proven. The
 * combobox is for the places where somebody is picking from the whole tree while filling
 * something in: the filter bar, bulk categorize, a manual entry, a split.
 *
 * Keyboard contract (WAI-ARIA combobox): ArrowDown/ArrowUp move the highlight and open the list,
 * Enter takes the highlighted option, Escape closes and restores the current value, Tab leaves
 * the field as it was. aria-activedescendant carries the highlight, so focus never leaves the
 * input and a screen reader announces each option as it is reached.
 */
export function CategoryCombobox({
  options,
  value,
  onChange,
  label,
  name,
  disabled = false,
  className = '',
  includeUncategorized = true,
  placeholder,
}: CategoryComboboxProps): React.ReactElement {
  const inputId = useId();
  const listId = useId();
  const optionIdPrefix = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  /**
   * Which option the keyboard is on, or null for "none yet". Null rather than 0 on purpose: an
   * opened list with its first row already highlighted turns a stray Enter into a silent
   * recategorization, and the first ArrowDown would then skip the first option.
   */
  const [highlight, setHighlight] = useState<number | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /**
   * 2026-09-15. Where the listbox is painted, in VIEWPORT coordinates.
   *
   * POSITIONING IS THE WHOLE DESIGN, and this is RowMenu's docblock repeated because the lesson
   * was learned there first and not inherited here. The listbox used to be `position: absolute`.
   * Every call site renders inside RowDialog, whose panel wraps `<Card as="div">`, and `.card`
   * carries `overflow-hidden` -- so a category list opened low in a dialog was CLIPPED by its own
   * container. Fixed positioning, placed from the input's own getBoundingClientRect(), escapes
   * the clip without a portal. The price is that it does not track the container as it scrolls,
   * so scrolling closes it instead (below) -- cheaper and sturdier than repositioning a dropdown
   * the reader has already scrolled away from.
   */
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  const chosen = value === null ? null : (options.find((option) => option.id === value) ?? null);
  // With Uncategorized off the list, null is "nothing picked yet" and the box stays empty so the
  // placeholder can say so -- naming a value the field does not hold is how a dialog ends up
  // pre-armed with a destination nobody chose.
  const chosenLabel = chosen === null ? (includeUncategorized ? UNCATEGORIZED : '') : chosen.label;

  // `query === null` means "showing the current value"; a string means the household is typing.
  // Two states rather than one, so Escape can put the value back without remembering it twice.
  const text = query ?? chosenLabel;

  const visible = useMemo(() => {
    const filtered = filterCategoryOptions(options, query ?? '');
    // Uncategorized leads the list, exactly as it does in every <select> this replaces -- and it
    // is filterable by name like anything else, so typing "unc" reaches it.
    const uncategorizedMatches =
      includeUncategorized &&
      ((query ?? '').trim().length === 0 || UNCATEGORIZED.toLowerCase().includes((query ?? '').trim().toLowerCase()));
    return [
      ...(uncategorizedMatches ? [{ id: null as number | null, label: UNCATEGORIZED, depth: 0 as const }] : []),
      ...filtered.map((option) => ({ id: option.id as number | null, label: option.label, depth: option.depth })),
    ];
  }, [options, query, includeUncategorized]);

  const close = useCallback((): void => {
    setOpen(false);
    setQuery(null);
    setHighlight(null);
    setBox(null);
  }, []);

  /** Measures the input and opens the list under it. */
  const place = useCallback((): void => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setBox({ top: rect.bottom + GAP_PX, left: rect.left, width: rect.width });
    setOpen(true);
  }, []);

  // Flip upward when there is no room below -- the last field in a tall dialog is exactly where a
  // downward list would open past the bottom of the window.
  useLayoutEffect(() => {
    if (!open || box === null) return;
    const element = listRef.current;
    const rect = inputRef.current?.getBoundingClientRect();
    if (element === null || rect === undefined) return;
    const height = element.getBoundingClientRect().height;
    if (height > 0 && rect.bottom + GAP_PX + height > window.innerHeight) {
      const top = Math.max(GAP_PX, rect.top - GAP_PX - height);
      if (top !== box.top) setBox({ ...box, top });
    }
    // `box` is deliberately absent: including it re-runs this on the very state it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A fixed list cannot follow its field, so anything that moves the field closes the list. Same
  // trade RowMenu makes, for the same reason.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => close();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, close]);

  function choose(index: number | null): void {
    const option = index === null ? undefined : visible[index];
    if (option === undefined) return;
    onChange(option.id);
    close();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        place();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((current) => {
        if (visible.length === 0) return null;
        if (current === null) return step === 1 ? 0 : visible.length - 1;
        const next = current + step;
        if (next < 0) return visible.length - 1;
        if (next >= visible.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === 'Enter') {
      // Nothing highlighted means nothing has been chosen here, so Enter belongs to the form
      // around this field -- taking it would either pick an option nobody looked at or swallow a
      // submit the household meant.
      if (!open || highlight === null) return;
      event.preventDefault();
      choose(highlight);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && highlight !== null ? `${optionIdPrefix}-${highlight}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink"
        ref={inputRef}
        onFocus={place}
        onBlur={() => {
          // A click on an option fires blur before the click lands, so closing is deferred by a
          // tick. mouseDown on the option (below) is what actually chooses, which makes this a
          // safety net rather than the mechanism.
          blurTimer.current = setTimeout(close, 0);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!open) place();
          setHighlight(null);
        }}
        onKeyDown={onKeyDown}
      />
      {name === undefined ? null : <input type="hidden" name={name} value={value === null ? '' : String(value)} />}
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          style={
            box === null
              ? undefined
              : { position: 'fixed', top: box.top, left: box.left, width: box.width }
          }
          className="z-50 max-h-64 overflow-y-auto rounded border border-line bg-surface shadow-pop"
        >
          {visible.length === 0 ? (
            <li className="px-2 py-1 text-sm text-muted">No category matches that.</li>
          ) : (
            visible.map((option, index) => (
              <li
                key={option.id === null ? 'none' : option.id}
                id={`${optionIdPrefix}-${index}`}
                role="option"
                aria-selected={option.id === value}
                className={`cursor-pointer px-2 py-1 text-sm ${index === highlight ? 'bg-surface-2 text-ink' : 'text-ink'} ${
                  option.depth === 1 ? 'pl-6' : ''
                }`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => {
                  // mouseDown, not click: the input's blur would otherwise close the list first
                  // and the click would land on nothing.
                  event.preventDefault();
                  if (blurTimer.current !== null) clearTimeout(blurTimer.current);
                  choose(index);
                }}
              >
                {option.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
