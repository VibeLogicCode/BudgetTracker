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
 * v1.13.1 (item BS, closing the gap ruling P7 left open). P7 assumed useId() was unavailable
 * because this module has no 'use client' directive and is rendered from server components
 * (dashboard/page.tsx among them) — but React 19's react-server build DOES export useId()
 * (verified: `grep -c useId node_modules/react/cjs/react.react-server.production.js` -> 2), and a
 * Server Component invoking a hook exported by that build is fine; what a Server Component cannot
 * do is carry its OWN state across a re-render, which useId()'s tree-position-derived id never
 * needed. So the implicit (no htmlFor) branch now calls useId() itself and links the hint via
 * aria-describedby exactly like the htmlFor branch, instead of leaving the hint merely visible and
 * unassociated. Since there is no htmlFor id to attach aria-describedby TO in the implicit branch,
 * the label+control are wrapped in a `<div role="group" aria-describedby>` — the control's
 * accessible name still comes from being nested inside the <label>, unaffected, and the group
 * carries the description a plain <label> has no attribute for. (No aria-labelledby on the group:
 * it would give the group its own accessible name equal to the label text, which is redundant
 * with the nested <label> and made `getByLabelText` ambiguous between the group and the control in
 * the test — a real testing-library collision, not a false positive.) The htmlFor branch is
 * untouched (byte-identical markup) since it already had a real id to hang aria-describedby on the
 * control directly.
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
  const autoId = React.useId();
  // Review B fix round (item 5): this used to test `hint !== undefined && hint !== null`, but
  // the hint <span> below renders under `{hint ? ... : null}` -- a truthiness test. hint=''
  // passed the former and failed the latter, so aria-describedby pointed at an id nothing ever
  // rendered. Same truthiness test on both sides closes that gap.
  const hintId = hint ? (htmlFor ? `${htmlFor}-hint` : `${autoId}-hint`) : undefined;
  const described =
    htmlFor && hintId !== undefined && React.isValidElement<{ 'aria-describedby'?: string }>(children) &&
    children.props['aria-describedby'] === undefined
      ? React.cloneElement(children, { 'aria-describedby': hintId })
      : children;

  const implicitLabel = (
    <label className="flex flex-col gap-1.5">
      <span className={labelClass}>{label}</span>
      {children}
    </label>
  );

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {htmlFor ? (
        <>
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
          {described}
        </>
      ) : hint ? (
        <div role="group" aria-describedby={hintId}>
          {implicitLabel}
        </div>
      ) : (
        implicitLabel
      )}
      {hint ? (
        <span id={hintId} className={hintClass}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
