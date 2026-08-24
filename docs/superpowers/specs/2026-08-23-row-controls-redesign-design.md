# Row Controls Redesign — Design

**Date:** 2026-08-23
**Status:** Approved by owner (rulings R1–R3 below)
**Supersedes:** the per-cell Save idiom used since v1.0.0; the v1.10.1/v1.10.3 table-width
work stays in force (this design narrows tables further, it does not undo those rules).

## Problem

Every editable cell in the app drags its own Save button, and the transactions table adds a
whole actions column of mixed idioms (link + button + select-with-button). Consequences the
owner reported with screenshots:

1. The transactions table needs `minWidth: 76rem`, so it horizontally scrolls even on a
   desktop where the card is nearly that wide — while most of that width is buttons, not data.
2. The action controls clip at the card edge mid-scroll ("Cre…", "Spli…", "Assign to l…").
3. The budgets table stacks two Save buttons per row (limit, rollover) plus a suggestion
   button, three independent forms deep.
4. The same idiom repeats on review, import, and five settings tables, so the mess is
   app-wide, not a transactions bug.

The controls are the width problem. This is an interaction redesign, not column arithmetic.

## Rulings

- **R1 — Save model: auto-save on change.** Selects and checkboxes persist immediately on
  change; text inputs persist on Enter or blur when the value changed. No per-cell Save
  buttons remain in any table row.
- **R2 — Row actions: kebab menu.** Rows with two or more actions collapse them into one
  `⋯` menu button. Rows with a single action keep one compact button — a menu of one is
  worse than a button.
- **R3 — Scope: every row-control table in one pass.** One consistent pattern, one release
  (v1.11.0). The inventory below is the complete list; nothing waits for a later pass.

## Safety rule (constrains everything else)

Auto-save applies ONLY to single-row, reversible edits. An action that is destructive,
affects multiple rows, or is a judgment call keeps a deliberate button:

- Review's "Apply to all N matching…" writes many rows — button stays.
- "Mark as transfer", "Accept", deactivate/delete/archive/undo — buttons stay.
- Failure is never silent: on error the control reverts to its previous value and shows the
  server's error message next to the control.

## Component 1: auto-save controls

**Files:** `src/components/ui/AutoSave.tsx` (one file: shared hook + three thin components).
Client component (`'use client'`).

```tsx
interface AutoSaveResult { error?: string }

// Shared engine. `action` is an existing server action; the hook builds the FormData
// from `fields` plus the control's own name/value, calls the action inside
// useTransition, and manages status.
function useAutoSave(
  action: (formData: FormData) => Promise<AutoSaveResult>,
  fields: Record<string, string>,
): {
  save: (name: string, value: string) => void;
  pending: boolean;
  status: 'idle' | 'saved' | 'error';
  error: string | null;
}

export function AutoSaveSelect(props: {
  name: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  fields: Record<string, string>;          // hidden fields, e.g. { txId: '42' }
  action: (formData: FormData) => Promise<AutoSaveResult>;
  ariaLabel: string;
})

export function AutoSaveCheckbox(props: {
  name: string; defaultChecked: boolean;
  fields: Record<string, string>;
  action: (formData: FormData) => Promise<AutoSaveResult>;
  label: string;                           // rendered visible label
})

export function AutoSaveTextInput(props: {
  name: string; defaultValue: string;
  fields: Record<string, string>;
  action: (formData: FormData) => Promise<AutoSaveResult>;
  ariaLabel: string;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
})
```

Behaviour contract:

- **Select / checkbox:** `onChange` fires the save. During the transition the control is
  NOT disabled (disabling a focused select on some mobile browsers closes it), but further
  changes queue behind the pending one: last write wins.
- **Text input:** saves on Enter and on blur, and only when the value differs from the last
  saved value — blurring an untouched field never fires a request.
- **Feedback:** while pending, a small inline spinner replaces the status slot; on success a
  `✓` shows for 2 seconds then fades (the slot keeps its width so the row never reflows);
  on error the control reverts to the last saved value and the error message renders in red
  under the control, cleared on the next successful save.
- **Server contract:** the wrapped server actions are the EXISTING actions
  (`setCategoryAction`, `setAttributionAction`, `setLimitAction`, `setRolloverAction`,
  `fixCategoryAction`, `setCardPersonAction`, `renameItemTypeAction`, `setKindAction`,
  `renameCategoryAction`, `setCategoryTaxRelevantAction`) — bound so the component-facing
  signature is `(formData) => Promise<{error?}>`. Existing `useActionState` signatures are
  `(prevState, formData)`; call sites bind the first argument. No server action changes.
- Revalidation stays whatever each action already does (`revalidatePath`); the component's
  optimistic value is the UI until the refresh lands.

## Component 2: RowMenu (kebab)

**Files:** `src/components/ui/RowMenu.tsx`. Client component. No third-party library — the
repo has none for this and does not gain one.

```tsx
export function RowMenu(props: { label: string; children: ReactNode })
// label: accessible name, e.g. `Actions for ${description}` — NEVER just "Actions"
// repeated identically down the column.

export function RowMenuLink(props: { href: string; children: ReactNode })
export function RowMenuButton(props: { onSelect: () => void; children: ReactNode })
export function RowMenuForm(props: {
  action: (formData: FormData) => void | Promise<unknown>;
  fields: Record<string, string>;
  children: ReactNode;                     // the item label; renders a submit button
})
```

- Trigger: a 2rem-square button rendering `⋯`, `aria-haspopup="menu"`,
  `aria-expanded`, the `label` as its accessible name.
- **Positioning: `position: fixed`, computed from the trigger's `getBoundingClientRect()`
  when opened.** This is load-bearing: every table sits inside TableWrap's
  `overflow-x-auto`, and an absolutely-positioned menu inside an overflow container gets
  clipped — the exact defect this redesign removes. Fixed positioning escapes the clip
  without a portal. If the menu would overflow the viewport bottom, it opens upward.
- Menu semantics: `role="menu"` / `role="menuitem"`, ArrowUp/ArrowDown move focus, Home/End
  jump, Escape closes and refocuses the trigger, click/tap outside closes, Tab closes.
  Opening focuses the first item. Scroll or resize while open closes the menu (cheaper and
  sturdier than repositioning).
- One menu open at a time (module-level close-others is fine at this scale).

## Per-page treatments

Column widths in rem; every `fixed` TableWrap keeps a `minWidth` equal to its column total
(the existing ops guard enforces the pairing).

### Transactions (`transactions-client.tsx`)

- Category cell: `AutoSaveSelect` on `setCategoryAction` — Save button removed. Split rows
  keep the badge instead of a select, unchanged.
- Person cell: `AutoSaveSelect` on `setAttributionAction` — Save button removed.
- Actions column becomes a kebab (3rem, right-aligned): **Rename…** (moves here from the
  description cell, same rename card), **Split…** (same split editor), **Create warranty**
  (link), **Assign to loan → one item per active loan** ("Assign to {loan name}",
  `RowMenuForm` on `assignToLoanAction` — replaces the select+Assign pair), **Unassign from
  {loan}** per assigned loan (`RowMenuForm` on `unassignFromLoanAction`). Menu items appear
  only when applicable (no loans → no assign items), mirroring today's conditionals.
- Colgroup: checkbox 3, date 7, account 9, description 15, amount 7, category 13, person 11,
  kebab 3 = **68rem** total; `minWidth="68rem"`. Card is 72rem (96rem wide opt-in stays):
  no horizontal scroll at desktop widths; phones scroll the container as designed.
- Checkbox column and bulk toolbar: untouched.

### Budgets (`budgets-client.tsx`)

- Limit: `AutoSaveTextInput` (`inputMode="decimal"`) on `setLimitAction` — Save removed.
- "Use $X" suggestion: stays a one-click button (single deliberate apply), same form.
- Rollover: `AutoSaveCheckbox` on `setRolloverAction` — Save removed.
- Recompute colgroup/minWidth after the two Saves die (target ≤ 56rem).

### Review (`review-client.tsx`)

- Fix-category select: `AutoSaveSelect` on `fixCategoryAction` — "Set" button removed.
- "Accept {category}", "Apply to all N matching…" (keeps its own select + button),
  "Mark as transfer": unchanged, per the safety rule.

### Import (`import-client.tsx`)

- Cardholder assignment person select: `AutoSaveSelect` on `setCardPersonAction` — Save
  removed. The `onSaved` local-state patch moves into the auto-save success path.
- Import-history Undo, preview tables: untouched.

### Settings → Accounts (`accounts-manager.tsx`)

- Row buttons collapse into a kebab: **Update account** (opens the existing editor row),
  **Deactivate/Reactivate** (`RowMenuForm`).
- The expandable editor row keeps its single Save + Cancel — it is one form, already right.
- Recompute colgroup/minWidth (kebab column 3rem).

### Settings → Users (`users-manager.tsx`)

- Kebab per row: **Deactivate/Reactivate**, **Reset MFA** (both `RowMenuForm`),
  **Reset password…** — opens an inline sub-row (the accounts editor-row pattern) holding
  the password input + its submit; the input never lives in the menu itself.
- This was the worst AT-RISK table (three button-forms side by side); it becomes
  Name/Username/Role/MFA/Status/⋯.

### Settings → Item types (`item-types-manager.tsx`)

- Name: `AutoSaveTextInput` on `renameItemTypeAction` — "Rename" button removed.
- Kind: `AutoSaveSelect` on `setKindAction` — "Update kind" button removed. (Type
  immutability on saved ITEMS is server-side and unaffected; this renames the TYPE's kind.)
- Delete: stays a lone compact button (single action, R2).

### Settings → Managers (`managers-client.tsx`)

- Categories: name `AutoSaveTextInput` on `renameCategoryAction`; tax `AutoSaveCheckbox` on
  `setCategoryTaxRelevantAction`; archive/restore stays a lone button.
- Merchant rules (delete only) and import profiles list: untouched.

### Untouched (for the record)

Notifications preference matrix (one shared Save for the whole matrix — a different, sound
pattern), recent deliveries, warranties list, warranty-detail rules/receipts, goals
contributions, dashboard/reports read-only tables, import preview/wizard tables.

## Failure and concurrency

- Auto-save error ⇒ revert control to last saved value + show server error inline. No toast
  system exists and none is added.
- Rapid successive changes on one control: last write wins; the status slot reflects the
  latest request only.
- Two controls in the same row are independent transitions (as today, where they were
  independent forms).

## Testing

1. **Unit — AutoSave** (`tests/unit/auto-save.test.tsx`): select saves on change; input
   saves on Enter and blur but not on untouched blur; success shows ✓; failure reverts value
   and shows the message; second change while pending ends with last write.
2. **Unit — RowMenu** (`tests/unit/row-menu.test.tsx`): opens on click, focuses first item,
   arrow-key traversal, Escape closes and restores trigger focus, outside click closes,
   `aria-expanded` tracks state.
3. **Ops guard** (`tests/ops/row-controls.test.ts`): inside `src/app`, no table cell (or
   review/import list item) pairs a `<select` with a `SubmitButton` in the same JSX element —
   the old idiom cannot creep back. Grep-based like `table-layout.test.ts`, opening-tag
   parsing, with a non-vacuous floor asserting the scanner finds the auto-save controls.
4. **Existing guards stay green:** every `fixed` TableWrap keeps `minWidth`;
   `cell-truncate` keeps `title`.
5. **Visual verification before any push (non-negotiable, v1.10.1 lesson):** Playwright
   against a running dev build at 390, 768, 1280, and 1900 px — transactions, budgets,
   review, settings/users. Check: no horizontal scroll at 1280+; kebab menu opens un-clipped
   from the last table row; auto-save tick visible; no control starved below usable width.

## What this does NOT build

- No toast/notification system; feedback is inline per control.
- No optimistic rollback beyond value-revert (no undo stack).
- No row-click detail panel (rejected option).
- No debounced text auto-save while typing — Enter/blur only.
- No third-party menu/dropdown dependency.
- No server action signature changes and no new endpoints.

## Release

v1.11.0. Build by Opus/Sonnet subagents per the implementation plan; owner reviews between
tasks. Same tag/GHCR flow as prior releases.
