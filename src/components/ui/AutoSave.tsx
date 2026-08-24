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
      {/* `relative` here (harmless for a flex layout) is load-bearing when labelHidden: the
          sr-only span below is `position: absolute` with no positioned ancestor between it
          and this label, so without one its containing block becomes the initial containing
          block instead of this label. That escapes this row's own TableWrap `overflow-x-auto`
          clipping for scroll-region purposes even though the span paints invisibly, and on a
          table with one of these per row it was inflating `document.documentElement.
          scrollWidth` well past the viewport at narrow widths -- a real, user-reachable
          horizontal page scroll (confirmed by `window.scrollTo` actually moving `scrollX`),
          not just a stray metric. Scoping the containing block here keeps the sr-only span (and
          therefore its layout footprint) inside the same clipped box as everything else in the
          row. */}
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
      <ErrorLine error={error} />
    </span>
  );
}
