/**
 * Form field styling, in one place.
 *
 * The class constants exist alongside the <Field> wrapper because plenty of the
 * app's forms are dense inline grids (the import wizard's mapping editor, the
 * accounts table) where a stacked label/control block would be wrong — those
 * take the class and keep their own layout.
 */

import React from 'react';

export const inputClass = 'field-control';
export const selectClass = 'field-control';
export const textareaClass = 'field-control';
export const labelClass = 'field-label';
export const hintClass = 'field-hint';

/**
 * Stacked label + control + optional hint — the default shape for a form.
 *
 * v1.13.1 (item J, ruling P7). The hint used to render INSIDE the wrapper, and when no htmlFor
 * was given that wrapper was the <label> itself — so the hint became part of the control's
 * accessible NAME ("Original amount What you borrowed. Used for the payoff bar.") and a screen
 * reader read the whole sentence every time it landed on the field. The wrapper is now always a
 * <div>; the implicit branch nests only the label text and the control inside a <label>, and the
 * hint is a sibling of that <label> in both branches.
 *
 * Why the description is only wired up in the htmlFor branch: aria-describedby needs a
 * document-unique id, this module has no 'use client' directive and is rendered from server
 * components (dashboard/page.tsx among them), so useId() is unavailable and no id can be
 * generated here. Where the caller already supplied one, the hint takes `${htmlFor}-hint` and the
 * single child is cloned to point at it. The 17 call sites that pass a hint without an htmlFor
 * keep a hint that is visible and correctly excluded from the name but not programmatically
 * associated — backlog item BS, and the fix is to give those call sites an id, not to reach for a
 * hook here.
 */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className = '',
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const hintId = hint !== undefined && hint !== null && htmlFor ? `${htmlFor}-hint` : undefined;
  const described =
    hintId !== undefined && React.isValidElement<{ 'aria-describedby'?: string }>(children) &&
    children.props['aria-describedby'] === undefined
      ? React.cloneElement(children, { 'aria-describedby': hintId })
      : children;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {htmlFor ? (
        <>
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
          {described}
        </>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>{label}</span>
          {children}
        </label>
      )}
      {hint ? (
        <span id={hintId} className={hintClass}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
