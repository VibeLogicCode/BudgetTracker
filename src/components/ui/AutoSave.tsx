'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
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

/**
 * The dense inline control the tables already use (transactions' old `rowControl`).
 *
 * v1.12.1 (item AV / UX-7): `py-2 text-sm` below the `sm:` breakpoint, because a `text-xs` control
 * with 4px of vertical padding is well under the 44px minimum on the phones this household uses --
 * and it is exactly where the destructive row actions and the category select live. Every new value
 * is scoped back to today's at `sm:`, so desktop rendering is byte-identical. TableWrap already
 * scrolls horizontally on a phone, so the extra height costs nothing.
 *
 * v1.12.1 fix round 1: `py-2 text-sm` alone still rendered under 44px. `.field-control`'s own
 * `line-height: 1.4` and `padding: 0.5rem 0.75rem` come from the `components` layer, and Tailwind's
 * `utilities` layer (which `py-2`/`text-sm` belong to) loads after it and wins on equal specificity
 * -- but a UTILITY value only wins where it sets the SAME property; here `.field-control`'s
 * `line-height` utility (1.4, i.e. ~19.6px of text) combines with `py-2`'s 2x8px to clear only
 * ~38px, short of the 44px this item is actually about. `min-h-11` (2.75rem = 44px) sets a floor
 * that padding and line-height can't be undercut by regardless of layer order, and `sm:min-h-0`
 * lifts the floor back off at the breakpoint where the original, smaller control returns.
 */
export const AUTO_SAVE_CONTROL =
  'field-control w-auto max-w-[11rem] px-2 py-2 text-sm min-h-11 sm:min-h-0 sm:py-1 sm:text-xs';

/**
 * What a THROWN action says (item V / UX-3). Deliberately NOT the thrown message: Next redacts
 * real messages in production, so what a person would actually see there is a digest hash in a
 * table cell. Exported so a test can assert the constant rather than a copied literal.
 */
export const AUTO_SAVE_THROW_ERROR = 'Could not save — the app may be busy. Try again.';

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
      let result: AutoSaveResult;
      try {
        result = await action(formData);
      } catch (error) {
        // v1.12.1 (item V / UX-3). This hook used to handle only an action that RETURNS {error}.
        // An action that THROWS -- SQLITE_BUSY while the nightly backup runs, a full disk,
        // confirmCategory's own `No transaction N` -- stopped the spinner with no tick, no
        // message and no revert, and the control went on displaying a value the database never
        // accepted. The person found out on the next page load, if ever.
        //
        // The sequence guard is applied here too: a stale rejection must not overwrite the state
        // of a newer save that has already landed.
        if (mine !== sequence.current) return;
        console.error('[auto-save] action threw', error);
        setStatus('error');
        setError(AUTO_SAVE_THROW_ERROR);
        hooks?.onError?.();
        return;
      }
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
 *
 * v1.13.1 (item L, ruling P8). The visual half stays aria-hidden -- a decorative tick beside a
 * control someone is looking at needs no announcement.
 *
 * Review B fix round (items 1-2): this used to ALSO render the sr-only aria-live region right
 * here, which put it inside AutoSaveCheckbox's wrapping <label> -- so after a save the
 * checkbox's accessible name became "TaxSaved", the exact defect item J removed from Field's
 * hint. StatusSlot now returns only the visual half; each caller renders the live region itself
 * via LiveStatus, as a SIBLING of the label/control rather than a child of it.
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

/**
 * The announcing half StatusSlot used to carry (item L, ruling P8): a live region that is
 * always in the tree -- a region created at the same moment it gets its text is not announced
 * at all -- and says one word on success, so a control someone edits repeatedly does not turn
 * into chatter. A refusal says nothing here; ErrorLine's role="alert" already carries it.
 *
 * Review B fix round (items 1-2). Rendered as a SIBLING of the label/control, never inside a
 * <label>, so it can never become part of a control's accessible name. Every call site places
 * it inside a `relative` ancestor: `.sr-only` is `position: absolute`, and an unpositioned
 * ancestor makes the region's containing block the page itself -- which can inflate
 * `document.documentElement.scrollWidth` on a table with one of these per row (the same
 * horizontal-scroll bug AutoSaveCheckbox's docblock records for the labelHidden text span).
 */
function LiveStatus({ status }: { status: AutoSaveStatus }) {
  return (
    <span className="sr-only" aria-live="polite">
      {status === 'saved' ? 'Saved' : ''}
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
  /** The prop value this control has already reacted to. See the effect below. */
  const serverValue = useRef(defaultValue);

  /**
   * v1.12.1 (item AT / UX-5, ruling R3). State was seeded from props exactly once, so the LOSER of
   * a concurrent edit went on seeing their own value -- with a green tick beside it -- until they
   * hard-reloaded. Rows keep stable keys, so revalidatePath's refresh re-renders without
   * remounting, and nothing else would ever correct it.
   *
   * Three guards, each load-bearing:
   *  - `pending`: an edit still in flight has not been decided yet; resyncing over it would
   *    discard a keystroke the server is about to accept.
   *  - `defaultValue === serverValue.current`: the effect acts only when the PROP itself moved.
   *    Without this, the window between our own save resolving and its revalidate landing (when
   *    the prop is still the OLD value) would flip the control straight back.
   *  - `saved.current` moves with the state, or the next failed save would revert to a value the
   *    server has not held since somebody else wrote over it.
   */
  useEffect(() => {
    if (pending) return;
    if (defaultValue === serverValue.current) return;
    serverValue.current = defaultValue;
    saved.current = defaultValue;
    setValue(defaultValue);
  }, [defaultValue, pending]);

  return (
    // `relative`: LiveStatus below is `.sr-only` (position: absolute) and sits as a sibling of
    // this inner control span, not inside it -- see LiveStatus's docblock for why it must have
    // a positioned ancestor here rather than escaping to the page (review B fix round, item 2).
    <span className="relative flex flex-col gap-0.5">
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
      <LiveStatus status={status} />
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
  /** The prop value this control has already reacted to. Same three guards as AutoSaveSelect;
   *  see that component's effect for why each one is there (item AT / UX-5, ruling R3). */
  const serverChecked = useRef(defaultChecked);

  useEffect(() => {
    if (pending) return;
    if (defaultChecked === serverChecked.current) return;
    serverChecked.current = defaultChecked;
    saved.current = defaultChecked;
    setChecked(defaultChecked);
  }, [defaultChecked, pending]);

  return (
    // `relative`: LiveStatus below is `.sr-only` (position: absolute) and is deliberately a
    // SIBLING of the <label>, not a child of it -- rendering it inside the label is what made
    // the accessible name "TaxSaved" (review B fix round, item 1). This wrapper gives it a
    // positioned ancestor of its own, same reasoning as the label's own `relative` below.
    <span className="relative flex flex-col gap-0.5">
      {/* `relative` here (harmless for a flex layout) is load-bearing when labelHidden: the
          sr-only label-text span below is `position: absolute` with no positioned ancestor
          between it and this label, so without one its containing block becomes the initial
          containing block instead of this label. That escapes this row's own TableWrap
          `overflow-x-auto` clipping for scroll-region purposes even though the span paints
          invisibly, and on a table with one of these per row it was inflating
          `document.documentElement.scrollWidth` well past the viewport at narrow widths -- a
          real, user-reachable horizontal page scroll (confirmed by `window.scrollTo` actually
          moving `scrollX`), not just a stray metric. Scoping the containing block here keeps the
          sr-only span (and therefore its layout footprint) inside the same clipped box as
          everything else in the row. */}
      <label className="relative flex items-center gap-1.5 text-xs text-muted">
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
      <LiveStatus status={status} />
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
  maxLength,
  className = AUTO_SAVE_CONTROL,
}: {
  name: string;
  defaultValue: string;
  fields: Record<string, string>;
  action: AutoSaveAction;
  ariaLabel: string;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
  maxLength?: number;
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
  /** The prop value this control has already reacted to. See the effect below. */
  const serverValue = useRef(defaultValue);

  /**
   * v1.12.1 (item AT / UX-5, ruling R3). The same resync AutoSaveSelect gets, with one extra
   * guard: this input is UNCONTROLLED, so resyncing means writing element.value, and writing
   * element.value under somebody's cursor is worse than the staleness it fixes. A focused field
   * is therefore left alone -- the blur that follows will commit whatever the person typed, which
   * is the behaviour they expect from the field they are standing in.
   *
   * Both refs move with the value. `sent` in particular: without it the next blur would compare
   * against the pre-resync string, decide the field had changed, and write the old number straight
   * back over the server's -- which is exactly the Budgets "Use $487" defect UX-5 describes.
   */
  useEffect(() => {
    if (pending) return;
    if (defaultValue === serverValue.current) return;
    if (input.current !== null && document.activeElement === input.current) return;
    serverValue.current = defaultValue;
    saved.current = defaultValue;
    sent.current = defaultValue;
    if (input.current !== null) input.current.value = defaultValue;
  }, [defaultValue, pending]);

  const commit = () => {
    const element = input.current;
    if (element === null) return;
    const next = element.value;
    if (next === sent.current) {
      // v1.12.1 fix round 1 (item AT / UX-5, ruling R3). The resync effect above deliberately
      // skips a FOCUSED field so a live edit is never overwritten -- but if the field is then
      // blurred with nothing typed, that skip is the only thing that ran, and nothing else was
      // ever going to catch this field up: the effect's dependencies (`defaultValue`, `pending`)
      // don't change again on blur, so `serverValue.current` would otherwise sit on the stale
      // value forever. `defaultValue` here is the prop from THIS render, so it already reflects
      // whatever landed while the field was focused. Catching up now -- and only when nothing was
      // typed -- means a field left alone shows what the server actually holds, and a field that
      // WAS edited still goes through the normal save path below untouched.
      if (defaultValue !== serverValue.current) {
        serverValue.current = defaultValue;
        saved.current = defaultValue;
        sent.current = defaultValue;
        element.value = defaultValue;
      }
      return;
    }
    // v1.12.1 (item X / UX-4). An emptied field is NOT "clear this". Somebody who selected the
    // number to retype it and got distracted used to delete a recurring budget limit -- from this
    // month FORWARD, not just this month -- with a tick as the only feedback. Blanking a field
    // that held something is now a no-op and the number comes back; clearing is a deliberate
    // button in the cell (src/app/(app)/budgets/budgets-client.tsx). A field that was ALWAYS empty
    // is unaffected, so nothing that legitimately submits a blank changes behaviour.
    if (next.trim() === '' && saved.current.trim() !== '') {
      element.value = saved.current;
      sent.current = saved.current;
      return;
    }
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
    // `relative`: see AutoSaveSelect's identical wrapper for why LiveStatus needs it here
    // (review B fix round, item 2).
    <span className="relative flex flex-col gap-0.5">
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
          maxLength={maxLength}
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
      <LiveStatus status={status} />
      <ErrorLine error={error} />
    </span>
  );
}
