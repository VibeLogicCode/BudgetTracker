# Row controls redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every editable table cell in the app saves itself, and every row with more than one
action collapses those actions into a single `⋯` menu — so the tables carry data, not buttons.

**Architecture:** Two new client components do all the work. `AutoSave.tsx` wraps the EXISTING
server actions in a hook that builds the FormData itself and reports success or failure beside
the control. `RowMenu.tsx` is a `position: fixed` kebab menu (fixed, because every table lives
inside `TableWrap`'s `overflow-x-auto`, which clips an absolutely positioned child). Nine pages
then swap their per-cell Save buttons and their actions columns for those two components, the
freed width comes out of each `colgroup`, and a grep guard stops the old idiom coming back.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript 6.0.3, Tailwind 4, Vitest 3 +
`@testing-library/react` + jsdom (per-file `// @vitest-environment jsdom` — the suite default is
`node`).

**Spec:** `docs/superpowers/specs/2026-08-23-row-controls-redesign-design.md` — read it first.
Rulings R1–R3 and the Safety rule are binding.

## Global Constraints

- **Auto-save is for single-row, reversible edits ONLY.** Anything destructive, multi-row, or a
  judgment call keeps a deliberate button: review's "Apply to all N matching…", "Mark as
  transfer", "Accept", deactivate / delete / archive / undo, and budgets' "Use $X" suggestion.
- **`RowMenu` positions itself with `position: fixed`, computed from the trigger's
  `getBoundingClientRect()` — never `absolute`.** Every table sits inside `TableWrap`'s
  `overflow-x-auto`; an absolutely positioned menu inside an overflow container is clipped,
  which is the exact defect this redesign removes.
- **Every `fixed` TableWrap keeps a `minWidth` equal to its column total.** The existing guard
  in `tests/ops/table-layout.test.ts` enforces the pairing; a changed `colgroup` means a
  recomputed `minWidth` in the same edit.
- **No new npm dependencies.** No menu library, no toast library, no spinner library.
- **No server action changes and no new endpoints.** The existing actions keep their
  `(prevState, formData)` signatures; call sites bind the first argument
  (`(formData) => setCategoryAction({}, formData)`).
- **Text inputs save on Enter and on blur, and only when the value changed** — never while
  typing, and an untouched blur fires no request.
- **Failure is never silent:** on error the control reverts to its last saved value and the
  server's own message renders beside it. There is no toast system and none is added.
- **PUBLIC REPO.** No owner name, employer, real statement data, real merchant names, or
  absolute Windows paths in any file. Test fixtures use generic names ("Groceries", "Card A",
  "user-1").
- **Commit messages: conventional commits** (`feat:` / `fix:` / `test:` / `docs:`). **Never add
  a `Co-Authored-By` line or any Claude attribution** — repo rule.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that say *why*.
  A comment stating a false reason is worse than no comment.
- TDD: failing test, run it, implement, green, commit.
- Run `npx vitest run <your own test files>` per task. Do not run the full suite until Task 8.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/ui/AutoSave.tsx` | the save engine + the three controls | T1 |
| `tests/unit/auto-save.test.tsx` | the five behaviours of the engine | T1 |
| `src/components/ui/RowMenu.tsx` | the kebab: trigger, fixed positioning, menu semantics | T2 |
| `tests/unit/row-menu.test.tsx` | open / focus / keyboard / dismiss / fixed | T2 |
| `src/app/(app)/transactions/transactions-client.tsx` | two auto-save selects, one kebab, 68rem colgroup | T3 |
| `src/app/(app)/budgets/budgets-client.tsx` | auto-save limit + rollover, 56rem colgroup | T4 |
| `src/app/(app)/review/review-client.tsx` | auto-save fix-category | T5 |
| `src/app/(app)/import/import-client.tsx` | auto-save cardholder person | T5 |
| `src/app/(app)/settings/accounts/accounts-manager.tsx` | kebab, 60.5rem colgroup | T6 |
| `src/app/(app)/settings/users/users-manager.tsx` | kebab + inline password sub-row | T6 |
| `src/app/(app)/settings/item-types/item-types-manager.tsx` | auto-save name + kind | T7 |
| `src/app/(app)/settings/managers/managers-client.tsx` | auto-save category name + tax | T7 |
| `tests/ops/row-controls.test.ts` | the old idiom cannot creep back | T8 |
| `CHANGELOG.md`, `package.json`, `tests/ops/docker.test.ts` | v1.11.0 | T9 |

**Explicitly out of scope** (the spec lists these as untouched — do not "improve" them while
you are in the file): the notifications preference matrix (one shared Save for the whole
matrix is a different and sound pattern), recent deliveries, the warranties list, warranty
detail rules and receipts, goal contributions, every read-only dashboard and reports table, the
import preview and wizard tables, the transactions checkbox column and bulk toolbar, the
accounts editor row, the merchant-rules table and the import-profiles list.

---

# Wave 1 — the two components (parallel-safe: no shared files)

### Task 1: `AutoSave.tsx` — the save engine and its three controls

**Files:**
- Create: `src/components/ui/AutoSave.tsx`
- Create: `tests/unit/auto-save.test.tsx`

**Interfaces — Produces (T3–T7 consume these exactly):**

```tsx
export interface AutoSaveResult { error?: string }
export type AutoSaveAction = (formData: FormData) => Promise<AutoSaveResult>;
export type AutoSaveStatus = 'idle' | 'saved' | 'error';

/** The dense row control class every table already uses for its inline selects. */
export const AUTO_SAVE_CONTROL: string;

export function useAutoSave(
  action: AutoSaveAction,
  fields: Record<string, string>,
): {
  /** `value === null` OMITS the field, which is what an unchecked checkbox does. */
  save: (
    name: string,
    value: string | null,
    hooks?: { onSuccess?: () => void; onError?: () => void },
  ) => void;
  pending: boolean;
  status: AutoSaveStatus;
  error: string | null;
};

export function AutoSaveSelect(props: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string; disabled?: boolean }[];
  fields: Record<string, string>;
  action: AutoSaveAction;
  ariaLabel: string;
  className?: string;
}): React.ReactElement;

export function AutoSaveCheckbox(props: {
  name: string;
  defaultChecked: boolean;
  fields: Record<string, string>;
  action: AutoSaveAction;
  label: string;
  /** Keep the label as the accessible name but hide it visually (`sr-only`). */
  labelHidden?: boolean;
}): React.ReactElement;

export function AutoSaveTextInput(props: {
  name: string;
  defaultValue: string;
  fields: Record<string, string>;
  action: AutoSaveAction;
  ariaLabel: string;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
  className?: string;
}): React.ReactElement;
```

Three deliberate extensions to the spec's signatures, each load-bearing — do not "simplify"
them away:
1. `save`'s third argument. The spec requires "on error the control reverts to the last saved
   value", and the hook does not own the control's value, so it cannot revert anything on its
   own. The hooks are how the revert happens.
2. `value: string | null`. `setRolloverAction` and `setCategoryTaxRelevantAction` both read
   their checkbox as `formData.get(name) === 'on'`, so an unchecked box must be ABSENT, exactly
   as a real form submission leaves it — not the string `'off'`.
3. `disabled?: boolean` on an option, and `className?`. The transactions category select
   renders archived categories as disabled options, review's placeholder must be unpickable,
   and the budgets limit input is a narrow right-aligned field.
4. `labelHidden?: boolean` on the checkbox. Budgets wants the words "Roll over unspent" beside
   the box; the managers Tax column already has a column header, so repeating
   "Mark Groceries tax-relevant" down the column would be visual noise — but that row-specific
   sentence is still the only accessible name worth having, so it is hidden, not shortened.

The status slot carries `data-autosave-status="idle" | "pending" | "saved" | "error"`. That
attribute is the stable test hook — assert on it, not on glyph text.

- [ ] **Step 1: Write the failing tests** in `tests/unit/auto-save.test.tsx`. `tests/unit/`
  does not exist yet; create it. Mirror the conventions in
  `tests/components/ReceiptUploader.test.tsx`: the jsdom pragma on line 1,
  `@testing-library/react`, `cleanup()` in `afterEach`.

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AutoSaveSelect, AutoSaveTextInput } from '@/components/ui/AutoSave';

afterEach(() => cleanup());

const CATEGORIES = [
  { value: '', label: 'Uncategorized' },
  { value: '1', label: 'Groceries' },
  { value: '2', label: 'Transport' },
];

function statusOf(): string | null {
  return document.querySelector('[data-autosave-status]')?.getAttribute('data-autosave-status') ?? null;
}

describe('AutoSaveSelect', () => {
  it('saves on change, sending the hidden fields plus the control name and value', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    fireEvent.change(screen.getByLabelText('Category for transaction 42'), { target: { value: '1' } });

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const sent = action.mock.calls[0][0] as FormData;
    expect(sent.get('transactionId')).toBe('42');
    expect(sent.get('categoryId')).toBe('1');
  });

  it('shows the saved tick when the action returns no error', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    fireEvent.change(screen.getByLabelText('Category for transaction 42'), { target: { value: '1' } });

    await waitFor(() => expect(statusOf()).toBe('saved'));
  });

  it('reverts the value and shows the server message when the action fails', async () => {
    const action = vi.fn(async () => ({ error: 'This transaction is split — clear its split first.' }));
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue="2"
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    const select = screen.getByLabelText('Category for transaction 42') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('clear its split first'));
    // The whole point of the revert: the control must not keep showing a value the server
    // refused, or the row lies about what is stored.
    expect(select.value).toBe('2');
    expect(statusOf()).toBe('error');
  });

  it('ends on the last write when a second change arrives while the first is still in flight', async () => {
    const seen: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const action = vi.fn(async (formData: FormData) => {
      const value = String(formData.get('categoryId'));
      seen.push(value);
      if (releaseFirst === null) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {};
    });
    render(
      <AutoSaveSelect
        name="categoryId"
        defaultValue=""
        options={CATEGORIES}
        fields={{ transactionId: '42' }}
        action={action}
        ariaLabel="Category for transaction 42"
      />,
    );

    const select = screen.getByLabelText('Category for transaction 42') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(seen).toEqual(['1']));
    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() => expect(seen).toEqual(['1', '2']));

    releaseFirst?.();

    // The stale first response must not overwrite the second: last write wins, and the
    // control keeps the value the person actually chose last.
    await waitFor(() => expect(statusOf()).toBe('saved'));
    expect(select.value).toBe('2');
  });
});

describe('AutoSaveTextInput', () => {
  it('saves on Enter', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
        inputMode="decimal"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0][0] as FormData).get('amount')).toBe('250.00');
  });

  it('saves on blur when the value changed', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.blur(input);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it('never fires on an untouched blur, and never twice for one Enter-then-blur', async () => {
    const action = vi.fn(async () => ({}));
    render(
      <AutoSaveTextInput
        name="amount"
        defaultValue="100.00"
        fields={{ categoryId: '1', month: '2026-08', scope: 'household', userId: '' }}
        action={action}
        ariaLabel="Monthly limit for Groceries"
      />,
    );

    const input = screen.getByLabelText('Monthly limit for Groceries');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(action).not.toHaveBeenCalled();

    // Enter then blur is one edit, not two: tabbing away after pressing Enter must not
    // re-send the same value.
    fireEvent.change(input, { target: { value: '250.00' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/auto-save.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/ui/AutoSave"`.

- [ ] **Step 3: Write `src/components/ui/AutoSave.tsx`**

```tsx
'use client';

import { useRef, useState, useTransition } from 'react';
import { CheckIcon } from '@/components/icons';

/**
 * Auto-save row controls (spec 2026-08-23, ruling R1). Every editable table cell used to drag
 * its own Save button; the buttons, not the data, were what made the tables too wide to fit.
 *
 * These components wrap the EXISTING server actions. Nothing on the server changed: the actions
 * still take `(prevState, formData)`, and every call site binds the first argument. What moved
 * is who builds the FormData -- the hook does, from `fields` plus the control's own name and
 * value, so a cell no longer needs a <form> and a submit button to describe one edit.
 *
 * Auto-save is ONLY for single-row, reversible edits. Anything destructive, multi-row, or a
 * judgment call keeps its deliberate button (review's "Apply to all N matching...", "Mark as
 * transfer", deactivate, delete, archive, undo). That is the spec's safety rule, and it is the
 * line these components must never be pushed across.
 */
export interface AutoSaveResult {
  error?: string;
}

/** What a bound server action looks like from here. */
export type AutoSaveAction = (formData: FormData) => Promise<AutoSaveResult>;

export type AutoSaveStatus = 'idle' | 'saved' | 'error';

/** The dense inline control the tables already use (transactions' old `rowControl`). */
export const AUTO_SAVE_CONTROL = 'field-control w-auto max-w-[11rem] px-2 py-1 text-xs';

const SAVED_TICK_MS = 2000;

export function useAutoSave(action: AutoSaveAction, fields: Record<string, string>) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  /** Request sequence. Two changes in flight at once must settle as "last write wins", so a
   *  response that is no longer the newest request is dropped rather than rendered. */
  const sequence = useRef(0);
  const tick = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = (
    name: string,
    value: string | null,
    hooks?: { onSuccess?: () => void; onError?: () => void },
  ) => {
    const mine = ++sequence.current;
    const formData = new FormData();
    for (const [key, hidden] of Object.entries(fields)) formData.set(key, hidden);
    // null OMITS the field. An unchecked checkbox is absent from a real submission, and the
    // server actions read theirs as `formData.get(name) === 'on'` -- sending 'off' would be a
    // value they have never seen.
    if (value !== null) formData.set(name, value);

    startTransition(async () => {
      const result = await action(formData);
      if (mine !== sequence.current) return;
      if (result?.error) {
        setStatus('error');
        setError(result.error);
        hooks?.onError?.();
        return;
      }
      setStatus('saved');
      setError(null);
      hooks?.onSuccess?.();
      if (tick.current !== null) clearTimeout(tick.current);
      tick.current = setTimeout(() => setStatus('idle'), SAVED_TICK_MS);
    });
  };

  return { save, pending, status, error };
}

/**
 * Fixed-width feedback slot. Fixed width because the tick appears and disappears on its own:
 * a slot that collapsed would reflow the row two seconds after a save, under the cursor of
 * whoever is editing the next cell.
 */
function StatusSlot({ pending, status }: { pending: boolean; status: AutoSaveStatus }) {
  const shown = pending ? 'pending' : status;
  return (
    <span
      data-autosave-status={shown}
      aria-hidden="true"
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
    >
      {shown === 'pending' ? (
        <span className="h-3 w-3 animate-spin rounded-full border border-line border-t-transparent" />
      ) : shown === 'saved' ? (
        <CheckIcon className="h-3.5 w-3.5 text-positive-soft-fg" />
      ) : shown === 'error' ? (
        <span className="text-xs font-semibold text-negative-soft-fg">!</span>
      ) : null}
    </span>
  );
}

/** The server's own words, under the control. No toast system exists and none is added. */
function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <span role="alert" className="text-xs font-medium text-negative-soft-fg">
      {error}
    </span>
  );
}

export function AutoSaveSelect({
  name,
  defaultValue,
  options,
  fields,
  action,
  ariaLabel,
  className = AUTO_SAVE_CONTROL,
}: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string; disabled?: boolean }[];
  fields: Record<string, string>;
  action: AutoSaveAction;
  ariaLabel: string;
  className?: string;
}) {
  const { save, pending, status, error } = useAutoSave(action, fields);
  const [value, setValue] = useState(defaultValue);
  const saved = useRef(defaultValue);

  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        {/* NOT disabled while pending: disabling a focused <select> closes it on some mobile
            browsers, mid-choice. Further changes simply queue and the last one wins. */}
        <select
          name={name}
          value={value}
          aria-label={ariaLabel}
          className={className}
          onChange={(event) => {
            const next = event.target.value;
            setValue(next);
            save(name, next, {
              onSuccess: () => {
                saved.current = next;
              },
              onError: () => setValue(saved.current),
            });
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <StatusSlot pending={pending} status={status} />
      </span>
      <ErrorLine error={error} />
    </span>
  );
}

export function AutoSaveCheckbox({
  name,
  defaultChecked,
  fields,
  action,
  label,
  labelHidden = false,
}: {
  name: string;
  defaultChecked: boolean;
  fields: Record<string, string>;
  action: AutoSaveAction;
  label: string;
  labelHidden?: boolean;
}) {
  const { save, pending, status, error } = useAutoSave(action, fields);
  const [checked, setChecked] = useState(defaultChecked);
  const saved = useRef(defaultChecked);

  return (
    <span className="flex flex-col gap-0.5">
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          onChange={(event) => {
            const next = event.target.checked;
            setChecked(next);
            save(name, next ? 'on' : null, {
              onSuccess: () => {
                saved.current = next;
              },
              onError: () => setChecked(saved.current),
            });
          }}
        />
        {/* Hidden, never dropped: a checkbox column with a header still needs a per-row
            accessible name, and "Tax" repeated down the column is not one. */}
        <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
        <StatusSlot pending={pending} status={status} />
      </label>
      <ErrorLine error={error} />
    </span>
  );
}

export function AutoSaveTextInput({
  name,
  defaultValue,
  fields,
  action,
  ariaLabel,
  inputMode = 'text',
  placeholder,
  className = AUTO_SAVE_CONTROL,
}: {
  name: string;
  defaultValue: string;
  fields: Record<string, string>;
  action: AutoSaveAction;
  ariaLabel: string;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
  className?: string;
}) {
  const { save, pending, status, error } = useAutoSave(action, fields);
  const input = useRef<HTMLInputElement | null>(null);
  /** The value the server has accepted -- what a failed save reverts to. */
  const saved = useRef(defaultValue);
  /** The value most recently SENT. Enter fires a save and the blur that follows it must not
   *  fire the same edit again, so the comparison is against what was sent, not what was
   *  acknowledged (the acknowledgement arrives after the blur). */
  const sent = useRef(defaultValue);

  const commit = () => {
    const element = input.current;
    if (element === null) return;
    const next = element.value;
    if (next === sent.current) return;
    sent.current = next;
    save(name, next, {
      onSuccess: () => {
        saved.current = next;
      },
      onError: () => {
        sent.current = saved.current;
        if (input.current !== null) input.current.value = saved.current;
      },
    });
  };

  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        {/* Uncontrolled on purpose, the idiom this codebase already uses for row controls: the
            submitted value lives in the DOM, so typing never re-renders the row and a stale
            render can never disagree with what will be sent. No debounce -- Enter and blur
            only, which is the spec's "never while typing". */}
        <input
          ref={input}
          name={name}
          defaultValue={defaultValue}
          inputMode={inputMode}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={className}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit();
          }}
          onBlur={commit}
        />
        <StatusSlot pending={pending} status={status} />
      </span>
      <ErrorLine error={error} />
    </span>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/auto-save.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/AutoSave.tsx tests/unit/auto-save.test.tsx
git commit -m "feat(ui): auto-save row controls that wrap the existing server actions"
```

---

### Task 2: `RowMenu.tsx` — the kebab

**Files:**
- Create: `src/components/ui/RowMenu.tsx`
- Create: `tests/unit/row-menu.test.tsx`

**Interfaces — Produces (T3, T6 consume these exactly):**

```tsx
export function RowMenu(props: { label: string; children: React.ReactNode }): React.ReactElement;
export function RowMenuLink(props: { href: string; children: React.ReactNode }): React.ReactElement;
export function RowMenuButton(props: { onSelect: () => void; children: React.ReactNode }): React.ReactElement;
export function RowMenuForm(props: {
  action: (formData: FormData) => void | Promise<unknown>;
  fields: Record<string, string>;
  children: React.ReactNode;
}): React.ReactElement;
```

`label` is the trigger's accessible name AND the menu's — it must identify the ROW
(`Actions for ${description}`), never a bare "Actions" repeated identically down a column.
`RowMenuForm`'s `action` accepts a `useActionState` dispatcher, which is how a row keeps
surfacing its server errors through the page's existing `FormError`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/row-menu.test.tsx`

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RowMenu, RowMenuButton } from '@/components/ui/RowMenu';

afterEach(() => cleanup());

function renderMenu(onSplit = vi.fn(), onRename = vi.fn()) {
  render(
    <RowMenu label="Actions for Card A payment">
      <RowMenuButton onSelect={onRename}>Rename…</RowMenuButton>
      <RowMenuButton onSelect={onSplit}>Split…</RowMenuButton>
    </RowMenu>,
  );
  return screen.getByRole('button', { name: 'Actions for Card A payment' });
}

describe('RowMenu', () => {
  it('opens on click, tracks aria-expanded, and focuses the first item', () => {
    const trigger = renderMenu();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Rename…', 'Split…']);
    expect(document.activeElement).toBe(items[0]);
  });

  it('is positioned fixed, not absolute — an absolute menu is clipped by the table wrapper', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu.style.position).toBe('fixed');
    expect(menu.className).not.toContain('absolute');
  });

  it('moves focus with the arrow keys and jumps with Home/End', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside pointer down', () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeNull();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs the item handler and closes when an item is chosen', () => {
    const onSplit = vi.fn();
    const trigger = renderMenu(onSplit);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split…' }));

    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps only one menu open at a time', () => {
    render(
      <>
        <RowMenu label="Actions for row one">
          <RowMenuButton onSelect={vi.fn()}>One</RowMenuButton>
        </RowMenu>
        <RowMenu label="Actions for row two">
          <RowMenuButton onSelect={vi.fn()}>Two</RowMenuButton>
        </RowMenu>
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Actions for row one' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for row two' }));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByRole('menuitem').textContent).toBe('Two');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/row-menu.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/ui/RowMenu"`.

- [ ] **Step 3: Write `src/components/ui/RowMenu.tsx`**

```tsx
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
    <form action={action} role="none" onSubmit={() => close()}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" role="menuitem" tabIndex={-1} className={ITEM_CLASS}>
        {children}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/row-menu.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/RowMenu.tsx tests/unit/row-menu.test.tsx
git commit -m "feat(ui): row kebab menu positioned fixed so the table wrapper cannot clip it"
```

---

# Wave 2 — the page conversions (each consumes Wave 1; disjoint files)

### Task 3: Transactions — two auto-save selects, one kebab, a 68rem table

**Files:**
- Modify: `src/app/(app)/transactions/transactions-client.tsx`
  - `:50` the `rowControl` constant (delete — all three of its users go)
  - `:83` `const [rowState, rowAction] = useActionState(setCategoryAction, initial);` (delete)
  - `:127-133` the `notice` / `error` chains (drop `rowState`)
  - `:437-469` the TableWrap `minWidth` and `colgroup`
  - `:500-514` the description cell (the rename button moves into the kebab)
  - `:516-556` the category cell
  - `:557-573` the person cell
  - `:574-644` the actions cell (becomes the kebab)

**Interfaces — Consumes:**
- `AutoSaveSelect` from `@/components/ui/AutoSave` (T1)
- `RowMenu`, `RowMenuLink`, `RowMenuButton`, `RowMenuForm` from `@/components/ui/RowMenu` (T2)
- Unchanged server actions in `./actions`: `setCategoryAction(_prev, formData)`,
  `setAttributionAction(_prev, formData)`, `assignToLoanAction(formData)`,
  `unassignFromLoanAction(formData)`

**Produces:** nothing other tasks consume.

- [ ] **Step 1: Add the imports and the two bound actions.** `useActionState` stays (the bulk
  toolbar, the rename card, the split editor and the manual form all still use it).

```tsx
import { AutoSaveSelect } from '@/components/ui/AutoSave';
import { RowMenu, RowMenuButton, RowMenuForm, RowMenuLink } from '@/components/ui/RowMenu';
```

Then, at module level beside `const initial: ActionState = {};`:

```tsx
/**
 * The auto-save controls take `(formData) => Promise<{ error?: string }>`. Both actions are
 * declared `(prevState, formData)` for useActionState, so the first argument is bound here --
 * once, at module level, rather than in a closure whose identity changes on every render.
 */
const saveCategory = (formData: FormData) => setCategoryAction({}, formData);
const saveAttribution = (formData: FormData) => setAttributionAction({}, formData);
```

Delete the `rowControl` constant (its three users all go in this task) and the
`const [rowState, rowAction] = useActionState(setCategoryAction, initial);` line, then remove
`rowState.message ??` and `rowState.error ??` from the two chains at `:127-133`.

- [ ] **Step 2: Replace the colgroup and the minWidth.** The `fixed` + `minWidth` pairing is
  guarded by `tests/ops/table-layout.test.ts`, so both change in this one edit.

```tsx
        {/* minWidth is the colgroup's own total (3+7+9+15+7+13+11+3 = 68rem). Without it this
            table could not exceed its container, so the scroll container had nothing to scroll
            and the browser shrank every column instead -- see TableWrap's minWidth docblock. */}
        <TableWrap bare fixed minWidth="68rem">
          <colgroup>
            {/* Just the checkbox, plus the 1rem of cell padding either side. */}
            <col style={{ width: '3rem' }} />
            {/* An ISO date in tabular figures, which is the same width on every row. */}
            <col style={{ width: '7rem' }} />
            {/* Wide enough to READ an account name -- a `title` is no answer on a phone. */}
            <col style={{ width: '9rem' }} />
            {/* An explicit width, NOT elastic: left unsized this collapsed to one character on
                a narrow screen and spelled merchant names vertically (v1.10.1). */}
            <col style={{ width: '15rem' }} />
            {/* A signed five-figure amount on one line. */}
            <col style={{ width: '7rem' }} />
            {/* The category select plus its 1rem status slot. It no longer carries a Save
                button, which is where part of this table's old width went. */}
            <col style={{ width: '13rem' }} />
            {/* Same shape, shorter values -- a person's name or "Household". */}
            <col style={{ width: '11rem' }} />
            {/* The kebab: one 2rem button plus padding. This column used to be 11rem of link,
                button and select, and it was the column that clipped at the card's edge. The
                menu itself is position:fixed, so it is not constrained by this width. */}
            <col style={{ width: '3rem' }} />
          </colgroup>
```

- [ ] **Step 3: Replace the description cell.** Rename moves into the kebab, so this cell is
  text again — keeping the `title` that reveals the bank's original wording.

```tsx
                <td>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* Renaming happens from the row menu now. The title stays: it is the only
                        place the bank's own text is visible once a row has been renamed. */}
                    <span
                      className="font-medium text-ink"
                      title={row.displayDescription ? `Bank text: ${row.rawDescription}` : undefined}
                    >
                      {row.displayDescription ?? row.rawDescription}
                    </span>
                    {row.displaySource === 'manual' ? <span className="badge badge--blue">renamed</span> : null}
                    {row.displaySource === 'rename' ? <span className="badge badge--blue">rule</span> : null}
                    {row.isTransfer ? <span className="badge badge--slate">transfer</span> : null}
                    {row.source === 'bayes' ? <span className="badge badge--amber">guess</span> : null}
                  </span>
                </td>
```

- [ ] **Step 4: Replace the category cell.**

```tsx
                <td>
                  {/* v1.7.0 Task 4: a split transaction has no ONE category -- its money is
                      divided across its parts -- so it shows a badge instead of a control.
                      Editing the parts happens through Split… in the row menu. */}
                  {(splits[row.id] ?? []).length > 0 ? (
                    <span className="badge badge--blue">{`Split · ${(splits[row.id] ?? []).length} parts`}</span>
                  ) : (
                    <AutoSaveSelect
                      name="categoryId"
                      defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                      /* Live categories grouped under their parent, then the ARCHIVED ones flat
                         and disabled. That coverage is deliberate: a row whose category was
                         archived after the fact must still have a real <option>, or the browser
                         silently selects "Uncategorized" -- and with auto-save a stray change
                         would then clear (and untrain) a legitimate historical categorization. */
                      options={[
                        { value: '', label: 'Uncategorized' },
                        ...groupedCategories.map((opt) => ({
                          value: String(opt.id),
                          label: '\u00A0\u00A0'.repeat(opt.depth) + opt.label,
                        })),
                        ...categories
                          .filter((c) => c.isArchived)
                          .map((c) => ({ value: String(c.id), label: `${label(c.id)} (archived)`, disabled: true })),
                      ]}
                      fields={{ transactionId: String(row.id) }}
                      action={saveCategory}
                      ariaLabel={`Category for transaction ${row.id}`}
                    />
                  )}
                </td>
```

- [ ] **Step 5: Replace the person cell.** `setAttributionAction` reads `ids` as a comma list,
  so one row is a list of one — that is the existing contract, not a new one.

```tsx
                <td>
                  <AutoSaveSelect
                    name="attributedUserId"
                    defaultValue={row.attributedUserId === null ? '' : String(row.attributedUserId)}
                    options={[
                      { value: '', label: 'Household' },
                      ...people.map((person) => ({ value: String(person.id), label: person.name })),
                    ]}
                    fields={{ ids: String(row.id) }}
                    action={saveAttribution}
                    ariaLabel={`Person for transaction ${row.id}`}
                  />
                </td>
```

- [ ] **Step 6: Replace the whole actions cell with the kebab.**

```tsx
                {/* One menu instead of a link, a button and a select-with-button. The label
                    names the ROW, not the column: "Actions" repeated identically down a table
                    tells a screen reader nothing about which row it is on.
                    MUST-11.1/11.2: a purchase can carry a warranty, a transfer cannot.
                    MUST-11.3: the URL carries ONLY the id; the add page derives the rest.
                    MUST-14.8: a transfer never carries a loan control. MUST-14.10 stays
                    reachable because assign items are always offered alongside existing links,
                    never replaced by them. */}
                <td className="text-right">
                  <RowMenu label={`Actions for ${row.displayDescription ?? row.rawDescription}`}>
                    <RowMenuButton
                      onSelect={() =>
                        setRenaming({
                          id: row.id,
                          current: row.displayDescription ?? row.rawDescription,
                          merchant: row.normalizedMerchant,
                        })
                      }
                    >
                      Rename…
                    </RowMenuButton>
                    {row.isTransfer ? null : (
                      <>
                        <RowMenuButton onSelect={() => openSplitEditor(row)}>Split…</RowMenuButton>
                        <RowMenuLink href={`/warranties/new?transactionId=${row.id}`}>Create warranty</RowMenuLink>
                      </>
                    )}
                    {row.isTransfer
                      ? null
                      : (loanLinks[row.id] ?? []).map((link) => (
                          <RowMenuForm
                            key={`unassign-${link.id}`}
                            action={unassignLoan}
                            fields={{ transactionId: String(row.id), itemId: String(link.itemId) }}
                          >
                            {`Unassign from ${link.itemName}`}
                          </RowMenuForm>
                        ))}
                    {row.isTransfer
                      ? null
                      : loanOptions.map((loan) => (
                          <RowMenuForm
                            key={`assign-${loan.id}`}
                            action={assignLoan}
                            fields={{ transactionId: String(row.id), itemId: String(loan.id) }}
                          >
                            {`Assign to ${loan.name}`}
                          </RowMenuForm>
                        ))}
                  </RowMenu>
                </td>
```

  `assignLoan` and `unassignLoan` are the existing `useActionState` dispatchers at `:88-99` —
  passing them (not the raw actions) is what keeps `assignState.error` / `unassignState.error`
  flowing into the page's `FormError`. The old select-plus-Assign pair becomes one menu item
  per loan, which also removes the "pick a loan first" failure mode: a menu item cannot be
  submitted empty.

- [ ] **Step 7: Leave the kebab column's header empty.** The header row at `:470-481` already
  ends with `<th scope="col"></th>`. The kebab buttons carry their own per-row accessible
  names, so the column needs no label, and a 3rem column could not hold one
  (`.data-table thead th` is `white-space: nowrap`).

- [ ] **Step 8: Typecheck and run the existing render tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/app tests/components`
Expected: PASS. If a test asserted on a per-row "Save" button or on `minWidth="76rem"`, update
that assertion to the new markup and say so in your report — do not weaken it to pass.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/transactions/transactions-client.tsx"
git commit -m "feat(transactions): auto-save the row selects and collapse the actions column into a kebab"
```

---

### Task 4: Budgets — auto-save limit and rollover, a 56rem table

**Files:**
- Modify: `src/app/(app)/budgets/budgets-client.tsx`
  - `:36-67` the `Row` props (drop `action` and `rolloverAction`)
  - `:96-121` the limit form and its suggestion button
  - `:146-159` the rollover form
  - `:160-176` the recursive `<Row>` call (drop the two props)
  - `:214-240` `BudgetTable`'s `minWidth` and `colgroup`
  - `:265-296` the action wrappers and the `latest` banner slot
  - `:450`, `:535` the two section `<Row>` call sites

**Interfaces — Consumes:**
- `AutoSaveTextInput`, `AutoSaveCheckbox` from `@/components/ui/AutoSave` (T1)
- Unchanged `setLimitAction(_prev, formData)` and `setRolloverAction(_prev, formData)` from
  `./actions`

- [ ] **Step 1: Add the import and the two bound actions.**

```tsx
import { AutoSaveCheckbox, AutoSaveTextInput } from '@/components/ui/AutoSave';
```

At module level beside `const initial: BudgetActionState = {};`:

```tsx
/** Bound once: both actions are `(prevState, formData)` for useActionState, and the auto-save
 *  controls want `(formData)`. No server-side change of any kind. */
const saveLimit = (formData: FormData) => setLimitAction({}, formData);
const saveRollover = (formData: FormData) => setRolloverAction({}, formData);
```

- [ ] **Step 2: Drop `action` and `rolloverAction` from `Row`.** The row now binds the server
  actions itself, so those two props (and the wrappers that fed them) disappear. `applyAction`
  STAYS — the "Use $X" suggestion is a single deliberate apply, and the safety rule keeps it a
  button. Remove both props from the interface at `:36-67`, from the recursive call at
  `:160-176`, and from the two section call sites at `:450` and `:535`.

- [ ] **Step 3: Replace the limit form with an auto-save input**, keeping the suggestion form
  and the carried-forward line exactly as they are.

```tsx
            <>
              {/* This must default to the BASE limit, never the effective `limitCents`: a save
                  writes the base (setLimitAction -> upsertBudget), so defaulting to the
                  effective number would bake the carry into the base on the next edit. */}
              <AutoSaveTextInput
                name="amount"
                defaultValue={row.baseLimitCents === null ? '' : (row.baseLimitCents / 100).toFixed(2)}
                fields={{
                  scope,
                  userId: userId === null ? '' : String(userId),
                  month,
                  categoryId: String(row.categoryId),
                }}
                action={saveLimit}
                ariaLabel={`Monthly limit for ${row.categoryName}`}
                inputMode="decimal"
                placeholder="none"
                className="field-control w-24 px-2 py-1 text-right text-xs"
              />
              {row.baseLimitCents !== null && row.carryCents > 0 ? (
                <p className="mt-1 text-xs text-muted">
                  {formatCents(row.baseLimitCents)} plus {formatCents(row.carryCents)} carried
                </p>
              ) : null}
              {suggestion ? (
                <form action={applyAction}>
                  <input type="hidden" name="scope" value={scope} />
                  <input type="hidden" name="userId" value={userId ?? ''} />
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="categoryId" value={row.categoryId} />
                  <button
                    type="submit"
                    className="btn btn--ghost btn--sm px-2 text-xs"
                    title={`Median of the last ${suggestion.monthsUsed} full months${
                      suggestion.trend.direction === 'rising'
                        ? ', adjusted for a rising trend'
                        : suggestion.trend.direction === 'falling'
                          ? ', adjusted for a falling trend'
                          : ''
                    }${suggestion.seasonalApplied ? ', adjusted for the same month last year' : ''}. Confidence: ${suggestion.confidence}.`}
                  >
                    Use {formatCents(suggestion.suggestedCents, { currency: true })}
                  </button>
                </form>
              ) : null}
            </>
```

- [ ] **Step 4: Replace the rollover form with an auto-save checkbox.**

```tsx
          {!row.isArchived && canToggleRollover ? (
            <span className="mt-1 flex">
              {/* An unchecked box is ABSENT from the request, which is exactly what
                  setRolloverAction reads (`formData.get('enabled') === 'on'`). */}
              <AutoSaveCheckbox
                name="enabled"
                defaultChecked={rolloverOn.has(row.categoryId)}
                fields={{
                  scope,
                  userId: userId === null ? '' : String(userId),
                  month,
                  categoryId: String(row.categoryId),
                }}
                action={saveRollover}
                label="Roll over unspent"
              />
            </span>
          ) : null}
```

- [ ] **Step 5: Trim the banner slot.** Delete
  `const [limitState, dispatchLimit] = useActionState(setLimitAction, initial);` and
  `const [rolloverState, dispatchRollover] = useActionState(setRolloverAction, initial);`,
  delete the `action` and `rolloverAction` wrappers, and narrow the slot union and the `banner`
  chain to what is left:

```tsx
  const [latest, setLatest] = useState<'copy' | 'apply' | 'applyAll' | null>(null);
```

```tsx
  const banner: BudgetActionState =
    latest === 'copy' ? copyState : latest === 'apply' ? applyState : latest === 'applyAll' ? applyAllState : initial;
```

  The limit and rollover controls report themselves, inline, beside the control that failed —
  which is strictly better than the shared banner they used to share with Copy: a per-row
  failure now names its own row by position instead of appearing at the top of the page.

- [ ] **Step 6: Recompute `BudgetTable`'s colgroup and minWidth** (18+12+7+7+12 = 56rem).

```tsx
    <TableWrap bare fixed minWidth="56rem">
      <colgroup>
        {/* Deepest label plus its indent (16px + 20px per level, see Row). Longer names wrap
            rather than truncate, so nothing is hidden. */}
        <col style={{ width: '18rem' }} />
        {/* Was 16rem to fit checkbox + "Roll over unspent" + Save on one line. The Save is
            gone, so the widest line here is now the checkbox, its label and the 1rem status
            slot -- 4rem narrower, and the table fits a 1280px viewport without scrolling. */}
        <col style={{ width: '12rem' }} />
        {/* Two money columns; a formatted amount with a minus sign is the widest thing in them. */}
        <col style={{ width: '7rem' }} />
        <col style={{ width: '7rem' }} />
        {/* Progress bar over the "On pace for ..." sentence, which wraps to two lines happily. */}
        <col style={{ width: '12rem' }} />
      </colgroup>
```

- [ ] **Step 7: Typecheck and run the existing tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/app tests/components`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/budgets/budgets-client.tsx"
git commit -m "feat(budgets): auto-save the limit and rollover controls, narrowing the table to 56rem"
```

---

### Task 5: Review and Import — one auto-save select each

**Files:**
- Modify: `src/app/(app)/review/review-client.tsx`
  - `:34` `const [fixState, fix] = useActionState(fixCategoryAction, initial);` (delete)
  - `:44-45` the `notice` / `error` chains (drop `fixState`)
  - `:135-150` the fix-category form
- Modify: `src/app/(app)/import/import-client.tsx`
  - `:3` the React import (`useActionState` has no other user in this file)
  - `:18` the `./actions` import, `:24` `CARD_PERSON_INITIAL`
  - `:71-97` `saveAndNotify` + its `useActionState`
  - `:112-136` the form and the two result spans

**Interfaces — Consumes:** `AutoSaveSelect` and the `AutoSaveResult` type from
`@/components/ui/AutoSave` (T1); unchanged `fixCategoryAction(_prev, formData)` and
`setCardPersonAction(_prev, formData)`.

**Do NOT touch:** review's "Accept {category}", "Apply to all N matching… + create rule" (it
keeps its own select AND its button — it writes many rows, so the safety rule applies), "Mark
as transfer", the import-history Undo, or the import preview tables.

- [ ] **Step 1: Review — add the import and the bound action.**

```tsx
import { AutoSaveSelect } from '@/components/ui/AutoSave';
```

At module level beside `const initial: ReviewState = {};`:

```tsx
/** Bound for the auto-save select; fixCategoryAction itself is unchanged. */
const saveFixCategory = (formData: FormData) => fixCategoryAction({}, formData);
```

Delete the `fixState` line and remove `fixState.message ??` / `fixState.error ??` from the two
chains. `pickerClass` stays — the apply-to-all select still uses it.

- [ ] **Step 2: Review — replace the fix-category form.**

```tsx
              {/* The "Set" button is gone: picking a category IS the decision, and holding it
                  behind a second click was the idiom this release removes. The placeholder is
                  `disabled` so it can only ever be the starting state -- fixCategoryAction
                  answers an empty categoryId with "Pick a category.", and with no Set button to
                  hold back there would be nothing to stop a person selecting it. The same
                  guard the transactions loan select already used. */}
              <AutoSaveSelect
                name="categoryId"
                defaultValue={row.categoryId === null ? '' : String(row.categoryId)}
                options={[
                  { value: '', label: 'Choose a category…', disabled: true },
                  ...options.map((opt) => ({
                    value: String(opt.id),
                    label: '\u00A0\u00A0'.repeat(opt.depth) + opt.label,
                  })),
                ]}
                fields={{ transactionId: String(row.id) }}
                action={saveFixCategory}
                ariaLabel={`Category for ${row.normalizedMerchant}`}
                className={pickerClass}
              />
```

- [ ] **Step 3: Import — rewrite `CardValueRow`'s save path.** Replace `saveAndNotify` and its
  `useActionState` with a plain async function, delete `CARD_PERSON_INITIAL`, drop
  `type CardPersonState` and `useActionState` from the imports, and add:

```tsx
import { AutoSaveSelect, type AutoSaveResult } from '@/components/ui/AutoSave';
```

```tsx
  /**
   * F1 (post-1.6.0): the action's return value only ever carries a message or an error, never
   * the person that was submitted -- but that is exactly what is needed to patch local state
   * without a second request. Reading back the FormData the control just built keeps this
   * honest about what was really sent. Patching locally beats re-running `rePreview(mapping)`,
   * which would re-read and re-parse the whole staged file to refresh a value this row already
   * knows. Not called on error, so a failed save leaves the row exactly as it was.
   */
  async function savePerson(formData: FormData): Promise<AutoSaveResult> {
    const result = await setCardPersonAction({}, formData);
    if (!result.error) {
      const raw = formData.get('person');
      const newUserId = raw === null || raw === '' ? null : Number(raw);
      // A re-save of the SAME assignee keeps their existing name rather than re-deriving it:
      // `people` holds only ACTIVE users, so re-deriving would overwrite a since-deactivated
      // assignee's real name with undefined.
      const newUserName =
        newUserId === null
          ? null
          : newUserId === assignedUserId
            ? assignedUserName
            : people.find((p) => p.id === newUserId)?.name ?? null;
      onSaved(cardValue, newUserId, newUserName);
    }
    return result;
  }
```

- [ ] **Step 4: Import — replace the form and the two result spans.** The auto-save control
  reports its own success and failure, so the `state.message` / `state.error` spans go with it.

```tsx
      {/* `options` is `people` PLUS the currently assigned person when they are not in that
          list: an assignment can point at a since-deactivated user (MUST-3.1), and without the
          extra option the select's value would match no <option>, which the browser resolves by
          selecting the FIRST one -- making a real assignment look unassigned. */}
      <span className="ml-auto flex items-center gap-2">
        <AutoSaveSelect
          name="person"
          defaultValue={assignedUserId === null ? '' : String(assignedUserId)}
          options={[
            { value: '', label: 'Account owner (default)' },
            ...options.map((person) => ({ value: String(person.id), label: person.name })),
          ]}
          fields={{ accountId: String(accountId), cardValue }}
          action={savePerson}
          ariaLabel={`Person for ${cardValue}`}
          className={selectClass}
        />
      </span>
```

  Also update `CardValueRow`'s own docblock at `:26-44`: it currently explains why the row has
  "its own useActionState" and why the select is uncontrolled with `defaultValue`. Both reasons
  changed shape — say that each row's save is still independent because each row holds its own
  auto-save state, and that the select is now controlled by `AutoSaveSelect` so it can be
  reverted to the last saved value when the server refuses.

- [ ] **Step 5: Typecheck and run the existing tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/app tests/components`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/review/review-client.tsx" "src/app/(app)/import/import-client.tsx"
git commit -m "feat(review,import): auto-save the category and cardholder selects"
```

---

### Task 6: Settings → Accounts and Users — kebabs

**Files:**
- Modify: `src/app/(app)/settings/accounts/accounts-manager.tsx`
  - `:211` the TableWrap `minWidth`, `:216-232` the colgroup, `:244` the Actions header
  - `:277-290` the actions cell
- Modify: `src/app/(app)/settings/users/users-manager.tsx`
  - `:3` the React import (add `Fragment`, `useState`), `:10` the form import (add `labelClass`)
  - `:78-127` the row: the actions cell becomes a kebab and gains a password sub-row

**Interfaces — Consumes:** `RowMenu`, `RowMenuButton`, `RowMenuForm` from
`@/components/ui/RowMenu` (T2). No auto-save on either table: every action here is
destructive or a credential change, so all of them keep a deliberate submit.

**Do NOT touch** the accounts editor row (`:306-405`). It is one form with five fields and one
Save — already the right shape, and the spec says so explicitly.

- [ ] **Step 1: Accounts — add the import.**

```tsx
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
```

- [ ] **Step 2: Accounts — replace the actions cell.** `setActive` is the existing
  `useActionState` dispatcher, so the row keeps reporting its errors through the page's
  `FormError`.

```tsx
                    <td className="text-right">
                      <RowMenu label={`Actions for ${account.name}`}>
                        <RowMenuButton onSelect={() => openEditor(account)}>Update account</RowMenuButton>
                        <RowMenuForm
                          action={setActive}
                          fields={{ accountId: String(account.id), active: account.isActive ? '0' : '1' }}
                        >
                          {account.isActive ? 'Deactivate' : 'Reactivate'}
                        </RowMenuForm>
                      </RowMenu>
                    </td>
```

- [ ] **Step 3: Accounts — recompute the width.** Two buttons that used to need 9.5rem (and
  stacked anyway) become one 2rem trigger, so the last column is 3rem and the total drops from
  67rem to 60.5rem: 8 + 7.5 + 4.5 + 5.5 + 6.5 + 11 + 7 + 7.5 + 3.

```tsx
          <TableWrap bare fixed minWidth="60.5rem">
```

```tsx
              {/* The kebab: one 2rem button plus padding. It replaced "Update account" and
                  "Deactivate" side by side, which is where the other 6.5rem went. */}
              <col style={{ width: '3rem' }} />
```

  And blank the header, `:244`: `<th scope="col">Actions</th>` becomes `<th scope="col" />`.
  `.data-table thead th` is `white-space: nowrap`, so the word "Actions" would spill out of a
  3rem column; the triggers carry their own per-row accessible names, and this matches what
  the transactions table already does with its kebab column.

- [ ] **Step 4: Users — add the imports and the sub-row state.**

```tsx
import { Fragment, useActionState, useState } from 'react';
```

```tsx
import { Field, inputClass, labelClass, selectClass } from '@/components/ui/form';
import { RowMenu, RowMenuButton, RowMenuForm } from '@/components/ui/RowMenu';
```

Inside `UsersManager`, beside the existing `useActionState` calls:

```tsx
  /**
   * Which row (if any) has its password sub-row open. A password field must not live inside a
   * menu -- a menu closes on Escape, on an outside click and on scroll, all of which would
   * discard a half-typed credential -- so "Reset password…" opens the expandable row instead,
   * the pattern accounts-manager.tsx already uses for its editor.
   */
  const [resetting, setResetting] = useState<number | null>(null);
```

- [ ] **Step 5: Users — replace the row.** Two `<tr>`s now, so the map body wraps in a
  `Fragment` keyed by user id (exactly as `accounts-manager.tsx` does).

```tsx
            {users.map((user) => (
              <Fragment key={user.id}>
                <tr className="align-top">
                  <td className="font-medium text-ink">{user.name}</td>
                  <td className="font-mono text-xs text-muted">{user.username}</td>
                  <td>
                    <span className={user.role === 'admin' ? 'badge badge--accent' : 'badge badge--slate'}>{user.role}</span>
                  </td>
                  <td>
                    <span className={user.totpEnabled ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.totpEnabled ? 'on' : 'off'}
                    </span>
                  </td>
                  <td>
                    <span className={user.isActive ? 'badge badge--green' : 'badge badge--muted'}>
                      {user.isActive ? 'active' : 'deactivated'}
                    </span>
                  </td>
                  {/* Three button-forms used to sit side by side here -- the widest actions cell
                      in the app, and the one that pushed this table past its card. */}
                  <td className="text-right">
                    <RowMenu label={`Actions for ${user.name}`}>
                      <RowMenuForm
                        action={rowAction}
                        fields={{ userId: String(user.id), active: user.isActive ? '0' : '1' }}
                      >
                        {user.isActive ? 'Deactivate' : 'Reactivate'}
                      </RowMenuForm>
                      <RowMenuButton onSelect={() => setResetting(user.id)}>Reset password…</RowMenuButton>
                      <RowMenuForm action={resetMfa} fields={{ userId: String(user.id) }}>
                        Reset MFA
                      </RowMenuForm>
                    </RowMenu>
                  </td>
                </tr>
                {resetting === user.id ? (
                  <tr>
                    <td colSpan={6} className="bg-surface-2">
                      <form
                        action={resetPassword}
                        onSubmit={() => setResetting(null)}
                        className="flex flex-wrap items-end gap-3 py-2"
                      >
                        <input type="hidden" name="userId" value={user.id} />
                        <div className="flex flex-col gap-1">
                          <span className={labelClass}>New password</span>
                          <input
                            name="password"
                            placeholder="At least 10 characters"
                            aria-label={`New password for ${user.name}`}
                            className={`w-52 ${rowInput}`}
                          />
                        </div>
                        <div className="flex gap-2">
                          <SubmitButton size="sm">Reset password</SubmitButton>
                          <button type="button" onClick={() => setResetting(null)} className={rowButton}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
```

  `resetPassword`, `resetMfa` and `rowAction` are the existing dispatchers at `:21-24`, so
  `pwState` / `mfaState` / `rowState` keep feeding the page's `FormError` and `Notice` — the
  "all their sessions were signed out" message in particular must still appear.

  This table is `<TableWrap bare>` with no `colgroup` and no `minWidth` (auto layout), so
  there is no width to recompute. Do not add one.

- [ ] **Step 6: Typecheck and run the existing tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/app tests/components`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/settings/accounts/accounts-manager.tsx" "src/app/(app)/settings/users/users-manager.tsx"
git commit -m "feat(settings): collapse account and user row actions into kebab menus"
```

---

### Task 7: Settings → Item types and Managers — four auto-save controls

**Files:**
- Modify: `src/app/(app)/settings/item-types/item-types-manager.tsx`
  - `:3` the React import (`useState` loses its only user), `:29-34` `type RowActionSlot`
  - `:36-56` the `activeSlot` machinery and the three `useActionState` calls
  - `:135-141` the name, kind and usage cells; `:142-189` the actions cell
    (rename form, kind form; the Delete form stays)
- Modify: `src/app/(app)/settings/managers/managers-client.tsx`
  - `:81`, `:83` the rename and tax `useActionState` calls
  - `:102-120` the `notice` / `error` chains
  - `:170-181` the name cell, `:188-198` the tax cell

**Interfaces — Consumes:** `AutoSaveTextInput`, `AutoSaveCheckbox` from
`@/components/ui/AutoSave` (T1). Unchanged `renameItemTypeAction(_prev, formData)`,
`setKindAction(_prev, formData)`, `renameCategoryAction(_prev, formData)`,
`setCategoryTaxRelevantAction(_prev, formData)`.

- [ ] **Step 1: Item types — add the import and the bound actions.**

```tsx
import { AutoSaveSelect, AutoSaveTextInput } from '@/components/ui/AutoSave';
```

```tsx
/** Bound for the auto-save controls. Type immutability on saved ITEMS is enforced server-side
 *  and is unaffected: this renames the TYPE and changes the TYPE's kind. */
const saveItemTypeName = (formData: FormData) => renameItemTypeAction({}, formData);
const saveItemTypeKind = (formData: FormData) => setKindAction({}, formData);
```

- [ ] **Step 2: Item types — delete the slot machinery.** With rename and kind reporting
  themselves inline, only Delete is left, so the "which of three actions ran last" bookkeeping
  has nothing to arbitrate. Remove `type RowActionSlot`, `activeSlot`/`setActiveSlot`, the
  `rename` and `changeKind` wrappers, and `useState` from the React import. What remains:

```tsx
  const [deleteState, remove] = useActionState(deleteItemTypeAction, initialState);

  const rowError = deleteState.error;
  const rowMessage = deleteState.message;
```

- [ ] **Step 3: Item types — replace the actions cell.** Delete stays a lone compact button:
  it is a single action, and ruling R2 says a menu of one is worse than a button.

```tsx
                  <td className="font-medium text-ink">
                    <AutoSaveTextInput
                      name="name"
                      defaultValue={type.name}
                      fields={{ typeId: String(type.id) }}
                      action={saveItemTypeName}
                      ariaLabel={`Rename ${type.name}`}
                      className={`w-36 ${rowInput}`}
                    />
                  </td>
                  <td>
                    <AutoSaveSelect
                      name="kind"
                      defaultValue={type.kind}
                      options={ITEM_KINDS.map((kind) => ({ value: kind, label: ITEM_KIND_LABELS[kind] }))}
                      fields={{ typeId: String(type.id) }}
                      action={saveItemTypeKind}
                      ariaLabel={`Kind of ${type.name}`}
                      className={rowInput}
                    />
                  </td>
                  <td className="tabnum text-right text-muted">{type.usageCount}</td>
                  <td>
                    <form action={remove}>
                      <input type="hidden" name="typeId" value={type.id} />
                      <button
                        type="submit"
                        disabled={type.usageCount > 0}
                        title={type.usageCount > 0 ? `${type.usageCount} item(s) use this type` : undefined}
                        className={rowButton}
                      >
                        Delete
                      </button>
                    </form>
                  </td>
```

  Note what moved: the Name column used to show plain text with the rename control living in
  the Actions cell, and the Kind column showed a badge with its select likewise stranded in
  Actions. Each control now sits in the column it edits, which is why the Actions cell shrinks
  to one button. The kind badge disappears with the select that replaces it — the select shows
  the same word, and two renderings of one value in one row is the redundancy this removes.

- [ ] **Step 4: Managers — add the import and the bound actions.**

```tsx
import { AutoSaveCheckbox, AutoSaveTextInput } from '@/components/ui/AutoSave';
```

```tsx
const saveCategoryName = (formData: FormData) => renameCategoryAction({}, formData);
const saveCategoryTaxRelevant = (formData: FormData) => setCategoryTaxRelevantAction({}, formData);
```

Delete `const [renameState, renameCategory] = useActionState(renameCategoryAction, initial);`
and `const [taxState, saveCategoryTax] = useActionState(setCategoryTaxRelevantAction, initial);`,
then drop `renameState.message ??` / `taxState.message ??` and `renameState.error ??` /
`taxState.error ??` from the two chains at `:102-120`.

- [ ] **Step 5: Managers — replace the name and tax cells.** Archive/restore stays a lone
  button (destructive-ish, and a single action).

```tsx
                <td style={{ paddingLeft: category.parentId ? 36 : 16 }}>
                  <AutoSaveTextInput
                    name="name"
                    defaultValue={category.name}
                    fields={{ categoryId: String(category.id) }}
                    action={saveCategoryName}
                    ariaLabel={`Rename ${category.name}`}
                    className={`w-44 ${rowInput}`}
                  />
                </td>
```

```tsx
                <td>
                  {/* labelHidden: the column header already says "Tax", but the accessible name
                      has to name the ROW, so the sentence stays and only its pixels go. */}
                  <AutoSaveCheckbox
                    name="taxRelevant"
                    defaultChecked={category.taxRelevant}
                    fields={{ categoryId: String(category.id) }}
                    action={saveCategoryTaxRelevant}
                    label={`Mark ${category.name} tax-relevant`}
                    labelHidden
                  />
                </td>
```

  Leave the merchant-rules table and the import-profiles list alone — the spec lists both as
  untouched.

- [ ] **Step 6: Typecheck and run the existing tests**

Run: `npx tsc --noEmit`
Run: `npx vitest run tests/app tests/components`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/settings/item-types/item-types-manager.tsx" "src/app/(app)/settings/managers/managers-client.tsx"
git commit -m "feat(settings): auto-save item type and category row controls"
```

---

# Wave 3 — the guard

### Task 8: `tests/ops/row-controls.test.ts` + the full suite

**Files:**
- Create: `tests/ops/row-controls.test.ts`

**Depends on** Tasks 3–7. Run it only once every conversion has landed — before that it fails
by design, because the six sites it flags are exactly the six those tasks convert.

**Interfaces — Consumes:** nothing at runtime. It reads files from disk and asserts on their
text, the idiom `tests/ops/table-layout.test.ts` and `tests/ops/balance-invariants.test.ts`
already use.

- [ ] **Step 1: Write the guard.**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (entry.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

const SUBMIT = /<SubmitButton\b|type="submit"/;

/**
 * The idiom v1.11.0 removed, and the one way it comes back.
 *
 * A per-row edit used to be a <form> holding one <select> and a Save button. Ruling R1 replaced
 * every one of those with an auto-save control, and the width that freed is what let four
 * tables stop scrolling sideways on a desktop. Nothing stops a future row control being written
 * the old way, though -- it is the obvious shape if you have not read the spec -- and each one
 * silently re-widens its table. So the shape is asserted against, not the outcome.
 *
 * The unit scanned is a <form> block. HTML forms cannot nest, so an open-tag-to-close-tag
 * non-greedy match is an unambiguous block rather than a guess -- which a <td>-to-</td> match
 * would not be, since cells nest inside rows inside tables inside cells (the accounts editor
 * row is a <td colSpan={9}> containing a whole form). Attributes are read off opening tags
 * only, the same discipline table-layout.test.ts applies to <TableWrap.
 *
 * A form is an offence when ALL of these hold:
 *   - it contains exactly one <select
 *   - every <input in it is type="hidden" (so the select is its only editable control -- this
 *     is what exempts real editor forms like the accounts row, which carries four fields and
 *     one Save, and the "Add a user" card, which carries three)
 *   - it has no <textarea
 *   - it has a submit control
 *   - it writes ONE row
 *
 * That last clause is the spec's safety rule, not a convenience: an action that writes many
 * rows KEEPS its deliberate button, so it cannot be an offence. Two such forms exist and must
 * stay -- review's "Apply to all N matching" (keyed by a merchant, not a row) and the
 * transactions bulk toolbar (`value={selected.join(',')}`) -- and they are recognised by what
 * they submit rather than by being named in a list here. A per-row form reintroduced in either
 * of those files is still caught, which an allowlist of files would not manage.
 */
describe('no table row pairs a lone select with a Save button', () => {
  const offenders: string[] = [];
  let autoSaveSelects = 0;
  let filesScanned = 0;

  for (const rel of tsxFiles('src/app')) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    filesScanned += 1;
    autoSaveSelects += [...source.matchAll(/<AutoSaveSelect\b/g)].length;

    for (const match of source.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
      const block = match[0];
      if ([...block.matchAll(/<select\b/g)].length !== 1) continue;
      const inputs = [...block.matchAll(/<input\b[^>]*>/g)].map((tag) => tag[0]);
      const hidden = inputs.filter((tag) => /type="hidden"/.test(tag));
      if (inputs.length !== hidden.length) continue;
      if (/<textarea\b/.test(block)) continue;
      if (!SUBMIT.test(block)) continue;
      // A joined id list, or a merchant key rather than a row id: a multi-row write, which the
      // safety rule says keeps its button.
      if (hidden.some((tag) => /\.join\(/.test(tag) || /name="normalizedMerchant"/.test(tag))) continue;
      const line = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
      offenders.push(`${rel}:${line}`);
    }
  }

  it('every single-row select control saves itself instead of carrying a Save button', () => {
    expect(offenders).toEqual([]);
  });

  it('finds the auto-save controls, so the check above cannot pass vacuously', () => {
    // A floor, not a count. Five conversions land in src/app: the transactions category and
    // person cells, review's fix-category, import's cardholder person, and the item-type kind.
    // Adding a sixth must not fail here -- removing the guard's ability to see any of them
    // must.
    expect(filesScanned).toBeGreaterThan(0);
    expect(autoSaveSelects).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/ops/row-controls.test.ts`
Expected: PASS. If `offenders` is non-empty, the listed `file:line` is a conversion Tasks 3–7
missed — convert it, do not exempt it.

- [ ] **Step 3: Prove the guard can fail.** A guard that cannot fail is worse than no guard,
  because it reads as coverage. Temporarily restore ONE old-idiom form — the simplest is
  review's fix-category select with a `<button type="submit">Set</button>` beside it inside a
  `<form action={fix}>` carrying `<input type="hidden" name="transactionId" …>` — and confirm
  the first assertion fails naming `review-client.tsx` and its line. Then temporarily rename
  every `<AutoSaveSelect` to `<AutoSaveSelectX` in one file and confirm the floor assertion
  fails. Revert both and confirm green.

- [ ] **Step 4: Run the whole suite and the typecheck and the build.** This is the first task
  that runs everything, and it is where a conversion that broke an unrelated test surfaces.

Run: `npm test`
Run: `npx tsc --noEmit`
Run: `npx next build`
Expected: all green. `tests/ops/table-layout.test.ts` in particular must pass unchanged — every
`fixed` TableWrap still has a `minWidth`, and every `cell-truncate` still has a `title`.

- [ ] **Step 5: Visual verification. Non-negotiable (the v1.10.1 lesson: that release's notes
  promised phone scrolling the table could not do, and only a browser would have shown it).**

Start `npm run dev`, then drive Playwright at 390, 768, 1280 and 1900 px across
`/transactions`, `/budgets`, `/review` and `/settings/users`. Check, at each width:
1. No horizontal scrollbar on the transactions or budgets table at 1280 and above.
2. The kebab on the LAST row of the transactions table opens fully visible and un-clipped —
   this is the whole reason the menu is `position: fixed`, and it is invisible in unit tests.
3. A category change shows the tick, and the row does not reflow when the tick fades.
4. A forced failure (change the category of a split transaction) reverts the select and shows
   the server's sentence.
5. No control is squeezed below a usable width at 390px, and the tables scroll rather than
   crush.

Report what you saw at each width. If any check fails, fix it before Task 9.

- [ ] **Step 6: Commit**

```bash
git add tests/ops/row-controls.test.ts
git commit -m "test(ops): guard against a lone select regaining a Save button in a row"
```

---

# Wave 4 — release

### Task 9: v1.11.0

**Files:**
- Modify: `package.json` (`"version": "1.10.3"` → `"1.11.0"` — that field is the single source
  of truth; `install/update.sh`, `install/update.ps1`, Settings → About and `/api/health` all
  read it)
- Modify: `CHANGELOG.md`
- Modify: `tests/ops/docker.test.ts:248-262` (the MUST-7.1 block)

**This task does NOT tag and does NOT push.** The owner's own session cuts the tag, because a
tag push repoints GHCR `:latest`, which the NAS pulls. Stop after the commit and say so in your
report.

- [ ] **Step 1: Bump the version.** `package.json` line 3: `"version": "1.11.0"`.

- [ ] **Step 2: Write the changelog entry.** Read the header comment at the top of
  `CHANGELOG.md` first — it is the rule, not decoration. Keep the `## Unreleased` heading in
  place and empty above the new section, and use the standard group headings. Date it
  `2026-08-24` or later: 1.10.3 is dated 2026-08-24, and an earlier date would make the file
  read backwards. Write for a reader who has never seen this repo and wants to know what
  changed on their screen.

```markdown
## Unreleased

## [1.11.0] - 2026-08-24

### Changed

- **Editable cells now save themselves.** Choosing a category, a person, a budget limit, a
  cardholder, an item type or its kind used to mean picking a value and then clicking a Save
  button next to it. The value is now saved the moment you pick it — a tick appears beside the
  control — and a text box saves when you press Enter or click away, and only if you changed
  something. Nothing saves while you are still typing.
- **If a save is refused, nothing is silently lost.** The control goes back to its previous
  value and the reason appears in red beside it, instead of the change appearing to stick.
- **Row actions moved into a single ⋯ menu.** On Transactions, that menu holds Rename, Split,
  Create warranty and the loan assignments; on Settings → Accounts and Settings → Users it
  holds the buttons that used to sit side by side in the last column. Reset password opens a
  row beneath instead of living in the menu, so a half-typed password cannot be thrown away by
  a stray click.
- **The wide tables fit on a desktop again.** Transactions went from needing 76rem of width to
  68rem and Budgets from 60rem to 56rem, because the width was going to buttons rather than to
  data. A narrow screen still scrolls sideways, and no column has been narrowed to pay for it.
- **Actions that change more than one row still ask first.** "Apply to all N matching",
  "Mark as transfer", "Accept", and every deactivate, delete, archive and undo keep their own
  button. Only single-row, reversible edits save themselves.

### Fixed

- **The action controls at the end of a transactions row no longer get cut off.** They read
  "Cre…", "Spli…" and "Assign to l…" when the table was scrolled; the menu that replaced them
  is positioned against the window rather than inside the scrolling table, so it cannot be
  clipped — including on the last row of a long table.
```

- [ ] **Step 3: Update the release guard in `tests/ops/docker.test.ts`.** Follow the existing
  append-only pattern exactly: the newest release asserts `pkg.version` IS its number, and the
  one before it is kept, with its assertion flipped to `not.toBe`. Add above the 1.10.3 block:

```ts
  it('MUST-7.1: the 1.11.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.11.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.11\.0\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.11.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.11.0]'), changelog.indexOf('## [1.10.3]'));
    expect(entry).toMatch(/### Changed/);
    // The two headline claims, asserted as claims and not just as a version number: an entry
    // that bumped the version without saying what a reader will see is the gap this guard is
    // for.
    expect(entry).toMatch(/save themselves/i);
    // A save that can be refused must document what happens on refusal, or "it saves itself"
    // reads as "it always works".
    expect(entry).toMatch(/goes back to its previous\s+value/i);
    expect(entry).toMatch(/cut off|clipped/i);
  });
```

  Then edit the existing 1.10.3 block: `expect(pkg.version).toBe('1.10.3')` becomes
  `expect(pkg.version).not.toBe('1.10.3')`, and its slice end changes from
  `changelog.indexOf('## [1.10.2]')` staying as it is — the slice start `## [1.10.3]` and end
  `## [1.10.2]` are both still correct, so ONLY the version assertion changes. Rename the test
  to `'MUST-7.1: the 1.10.3 release is still recorded intact (append-only discipline)'`, the
  same wording the 1.10.2 block uses.

- [ ] **Step 4: Run the release guard and the full suite**

Run: `npx vitest run tests/ops/docker.test.ts`
Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit — and stop.**

```bash
git add package.json CHANGELOG.md tests/ops/docker.test.ts
git commit -m "docs: release v1.11.0 — self-saving row controls and kebab row actions"
```

**Do not run `git tag` and do not run `git push`.** Report that the release commit is on `main`
and waiting for the owner to tag and push it.
