# One row layout that works on a phone and a laptop — implementation plan (v1.15.0)

> **For agentic workers:** four lanes, disjoint file sets. No Playwright. Vitest + `npx tsc --noEmit`.

**Goal:** every data table in the app reflows into a readable card on a phone and stays a table on
a laptop, using ONE DOM tree and one stylesheet rule — plus the three screen-eating defects the
"before" screenshots turned up on Transactions.

**Why:** on a phone the Transactions table shows checkbox / date / account / a description cut
mid-word, and the amount and category are off-screen behind a sideways scroll. The Review queue
already reads well because it renders bespoke cards. Two hand-written layouts for the same data is
the thing to fix, not one more bespoke card list.

**Spec:** this file.

## Global constraints

- No Playwright. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths, or real statement data anywhere.
- Conventional commits. NO `Co-Authored-By`, no Claude attribution. Never change git identity.
- `no new Date()` in `src/lib/**`. Integer cents, ISO dates.
- 44px minimum touch targets on anything new (`min-h-11 sm:min-h-0`, or `.field-control`).
- Never `git stash`, never `git add -A`, never touch `.tmp-data/`, never create a worktree, never
  copy or delete anything under `node_modules`.
- Stage and commit as ONE command: `git status --short` first, then
  `git add <exact files> && git commit -m "..."`.

## Rulings

- **S1. One DOM, CSS reflows it.** No branch renders cards and a table for the same rows. A second
  DOM tree gives every control two nodes in the document and breaks the label/role queries in ~25
  test files (this is why v1.14.1 ruling R5 exists). The table markup stays; a media query restyles
  it.
- **S2. Every `<td>` in a responsive table carries `data-label`,** whose value is that column's
  header text. `data-label=""` means "no label" (a checkbox cell, an actions cell).
- **S3. Three cell roles**, placed on row 1 of the phone card by explicit grid placement, so source
  order does not matter: `.cell-stack-lead` (checkbox), `.cell-stack-headline` (the row's identity
  — merchant, category, account name), `.cell-stack-amount` (the money). Every other cell becomes a
  full-width label/value line beneath. `.cell-stack-hide` drops a cell on the phone entirely, and
  is ONLY for a value that repeats identically down the column and is already filterable.
- **S4. Spreadsheet previews stay tables.** The import wizard's column preview and the import
  preview grid show raw CSV columns; a stacked card would be nonsense. They keep sideways scroll.
- **S5. Triage stays cards at every width.** The review card list is not migrated — a queue you work
  through top to bottom is a list, not a table, on a 27-inch monitor too. It gets capped to a
  reading measure instead so it stops stretching to 1100px.
- **S6. Quick add is a disclosure on Transactions,** closed by default, hidden entirely in review
  mode. It is ~600px of form above the first data row on a page whose job is reading rows. The
  dashboard's `variant="card"` is UNCHANGED. `#quick-add` (the PWA manifest shortcut, ruling R7)
  must still open it.
- **S7. Filters are a disclosure below `sm`,** open when any filter is set, plain always-visible
  markup at `sm` and up. Same reason.

## Lane 1 — the primitive and the stylesheet (everyone else depends on this)

**Files:** modify `src/components/ui/Table.tsx`, `src/app/globals.css`,
`tests/ops/table-layout.test.ts`; create `tests/unit/table-wrap.test.tsx`.

**Produces** (lanes 2–4 consume these names verbatim):

```tsx
<TableWrap responsive ...>        // adds `data-table--stack` to the <table>
<td data-label="Amount" className="cell-stack-amount">
// classes: cell-stack-lead | cell-stack-headline | cell-stack-amount | cell-stack-hide
//          cell-stack-actions
```

1. `TableWrap` gains `responsive?: boolean`. When set, the table's className gains
   `data-table--stack`. It composes with `fixed` and `minWidth` (both are desktop concerns).
2. Add to `globals.css`, inside the same `@layer components` block the other `.data-table` rules
   live in — this exact CSS:

```css
  /* ----- One row, two shapes (v1.15.0) -----
     Below `sm` a `responsive` TableWrap stops being a table and becomes a list of cards, using
     the SAME DOM: the header row is hidden and each <td> reprints its column name from
     `data-label`. The alternative -- rendering a card list beside the table -- gives every
     control two nodes in the document and breaks label-based queries across the test suite,
     which is why v1.14.1 ruling R5 refused it and why this is done in CSS. */
  @media (max-width: 639.98px) {
    .data-table--stack,
    .data-table--stack thead,
    .data-table--stack tbody,
    .data-table--stack tr,
    .data-table--stack td {
      display: block;
    }

    /* `minWidth` is an inline style on the <table> (see TableWrap) and inline beats a class, so
       the stacked table can only shed the horizontal scroll with !important. Without this the
       card list would still sit inside a 68rem box and scroll sideways -- the exact bug being
       fixed. */
    .data-table--stack {
      min-width: 0 !important;
      table-layout: auto;
      font-size: 0.875rem;
    }

    /* Column names move into the cells, so the header row is dead weight. */
    .data-table--stack thead {
      display: none;
    }

    .data-table--stack tbody tr {
      display: grid;
      /* lead (a checkbox, or nothing) | headline | amount. `auto` collapses to zero when a table
         has no lead cell, so one rule covers both shapes. */
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 0.375rem 0.5rem;
      padding: 0.875rem 1rem;
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: var(--surface);
    }

    .data-table--stack tbody tr + tr {
      margin-top: 0.625rem;
    }

    /* Hover tinting is a pointer affordance; on a card list it just looks like a stuck row. */
    .data-table--stack tbody tr:hover td {
      background: transparent;
    }

    .data-table--stack tbody td {
      /* Every cell that is not on row 1 is a full-width label/value line. */
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0;
      border-bottom: 0;
      min-height: 1.75rem;
      text-align: left;
    }

    .data-table--stack tbody td::before {
      content: attr(data-label);
      flex: 0 0 auto;
      color: var(--subtle);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    /* An empty label would still print an empty box and eat the gap. */
    .data-table--stack tbody td[data-label='']::before {
      display: none;
    }

    /* Row 1: identity and money, placed explicitly so the DOM order of the columns (checkbox,
       date, account, description, amount, ...) does not decide what a person sees first. */
    .data-table--stack tbody td.cell-stack-lead {
      grid-column: 1;
      grid-row: 1;
      justify-content: flex-start;
      min-height: 0;
    }

    .data-table--stack tbody td.cell-stack-headline {
      grid-column: 2;
      grid-row: 1;
      display: block;
      min-width: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--ink);
      line-height: 1.35;
    }

    .data-table--stack tbody td.cell-stack-amount {
      grid-column: 3;
      grid-row: 1;
      justify-content: flex-end;
      font-size: 0.9375rem;
      font-weight: 600;
      white-space: nowrap;
      min-height: 0;
    }

    /* A value that repeats identically down the column -- and is already a filter -- is worth
       less than the width it costs on a 390px screen. */
    .data-table--stack tbody td.cell-stack-hide {
      display: none;
    }

    /* A cell holding the row menu or a pair of buttons: no label, hard right. */
    .data-table--stack tbody td.cell-stack-actions {
      justify-content: flex-end;
    }

    /* Clipping to an ellipsis is a desktop compromise for a fixed column width. In a card the
       row has all the width it needs, so the full value wraps instead of hiding. */
    .data-table--stack tbody td.cell-truncate {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
    }

    /* Controls inside a card get the full width rather than a column's share. */
    .data-table--stack tbody td .field-control {
      max-width: 100%;
    }
  }
```

3. `tests/unit/table-wrap.test.tsx` (new): `responsive` puts `data-table--stack` on the table;
   without it the class is absent; `responsive` + `fixed` + `minWidth` compose (both classes
   present, `min-width` inline style still set). jsdom does not apply media queries, so these are
   class assertions, not layout assertions — say so in a comment.
4. `tests/ops/table-layout.test.ts` gains one guard: **any file containing a `<TableWrap` opening
   tag with `responsive` must contain at least as many `data-label=` occurrences as it has
   `<th scope="col"` occurrences.** A floor, not a count — several pages render more than one
   table per file, so an exact match would cry wolf. Its job is catching a responsive table whose
   cells were never labelled, which on a phone prints values with no idea what they are.
5. `npx vitest run tests/unit/table-wrap.test.tsx tests/ops/table-layout.test.ts` and
   `npx tsc --noEmit`.
6. Commit: `feat(ui): a table can reflow into cards on a phone without a second DOM tree`.

## Lane 2 — Transactions, Quick add, filters

**Files:** modify `src/app/(app)/transactions/transactions-client.tsx`,
`src/components/QuickAddTransaction.tsx`, `tests/app/transactions-client.test.tsx`,
`tests/components/quick-add.test.tsx`.

1. The transactions table: `<TableWrap bare fixed minWidth="68rem" responsive>`; `data-label` on
   every `<td>` in the row (`Date`, `Account`, `Description`, `Amount`, `Category`, `Person`, and
   `""` for the checkbox and the menu). Cell roles: checkbox `cell-stack-lead`, description
   `cell-stack-headline`, amount `cell-stack-amount`, account `cell-stack-hide` (it repeats down
   the column and is already a filter — the date is NOT hidden), menu cell `cell-stack-actions`.
   `AmountCell` must accept the extra props it needs (`data-label`; `className` already exists).
   Sub-rows that span the table (`colSpan`) — the note editor, the new-loan editor, the
   apply-to-all editor, the split rows — keep working: give their single `<td>` `data-label=""`,
   which with the default `grid-column: 1 / -1` is all they need. Verify the editors still render
   in BOTH branches.
2. Ruling S6 — Quick add. `QuickAddTransaction` gains `collapsible?: boolean` (default false, so
   the dashboard is untouched). When `collapsible` and `variant === 'page'`, render the card with a
   header button that toggles the form: closed by default, `aria-expanded`, `aria-controls`, label
   "Add a transaction" / "Close". `useEffect` on mount opens it when `window.location.hash ===
   '#quick-add'` so the PWA shortcut still lands on an open form (do not read `location` during
   render — that is a hydration mismatch). The `#quick-add` id stays on the wrapper.
   `transactions-client.tsx` passes `collapsible` and renders it ONLY when `!reviewMode`.
3. Ruling S7 — filters. Wrap the existing `<form method="get">` controls in a disclosure that is
   only chrome below `sm`: a button reading `Filters` plus the number of active ones, with `hidden
   sm:…` handling so at `sm` and up the controls are always shown and the button is not rendered.
   Open by default when any filter is set. Do not change any field name, any default, or the submit
   behaviour — the query string is the source of truth and page.tsx already parses it.
4. Ruling S5 — the review card list: add `mx-auto w-full max-w-4xl` to the `<ul>` (and to the pager
   paragraph and the empty state so they line up), give the merchant `<span>` `min-w-0 flex-1` so a
   long name cannot push the amount onto its own line, and DELETE the
   `<span className="badge badge--slate">uncategorized</span>` fallback — in a queue defined as
   "not categorized yet" it labels every card with the one thing they all share. The
   guessed-category badge stays. With no guess the meta line simply ends after the account.
5. Tests: the table row's amount cell carries `data-label="Amount"`; the account cell carries
   `cell-stack-hide`; Quick add is absent in review mode and present (collapsed, with its toggle)
   outside it; the filter form still submits every existing field; no card in review mode renders
   the text `uncategorized`. Keep every existing assertion in both files passing — if one asserted
   the old always-open Quick add, update it deliberately and say why in a comment.
6. `npx vitest run tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx
   tests/components/quick-add.test.tsx tests/app/dashboard.test.tsx tests/ops` and
   `npx tsc --noEmit`.
7. Commit: `feat(transactions): rows read as cards on a phone, quick add and filters fold away`.

## Lane 3 — Budgets, Warranties, Reports

**Files:** modify `src/app/(app)/budgets/budgets-client.tsx`,
`src/app/(app)/warranties/warranties-client.tsx`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx`,
`src/app/(app)/reports/reports-client.tsx`; tests `tests/app/budgets-client.test.tsx`,
`tests/app/budgets-rollover-ui.test.tsx`, `tests/app/warranties-client.test.tsx`,
`tests/app/warranty-detail-client.test.tsx`, `tests/app/reports-client.test.tsx`.

For each table: add `responsive` to its `TableWrap`, `data-label` to every `<td>`, and pick exactly
one `cell-stack-headline` (the name/category/merchant column) and one `cell-stack-amount` (the
primary money column — where a table has several money columns, only the one a person scans for).
`cell-stack-hide` only where a value repeats identically down the column. Budgets rows are a tree:
the indent is inline padding on the label cell and must survive, so keep whatever produces it on
the headline cell.

Add ONE assertion per file to its existing test — the headline cell of the first row carries
`cell-stack-headline` — and keep every existing assertion green.

`npx vitest run tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx
tests/app/warranties-client.test.tsx tests/app/warranty-detail-client.test.tsx
tests/app/reports-client.test.tsx tests/ops` and `npx tsc --noEmit`.

Commit: `feat(ui): budgets, warranties and reports read as cards on a phone`.

## Lane 4 — Settings, Dashboard, Import history

**Files:** modify `src/app/(app)/settings/accounts/accounts-manager.tsx`,
`src/app/(app)/settings/users/users-manager.tsx`,
`src/app/(app)/settings/item-types/item-types-manager.tsx`,
`src/app/(app)/settings/managers/managers-client.tsx`,
`src/app/(app)/settings/audit/page.tsx`,
`src/app/(app)/settings/notifications/notifications-client.tsx`,
`src/app/(app)/dashboard/page.tsx`, `src/app/(app)/import/import-client.tsx`; tests
`tests/app/accounts-manager.test.tsx`, `tests/app/users-manager.test.tsx`,
`tests/app/item-types-manager.test.tsx`, `tests/app/managers-client.test.tsx`,
`tests/app/settings-audit.test.tsx`, `tests/app/notifications-client.test.tsx`,
`tests/app/dashboard.test.tsx`, `tests/app/import-client.test.tsx`.

Same treatment as Lane 3. Two exceptions, both ruling S4: in `import-client.tsx` the **preview**
table (the one showing parsed rows before an import) stays a plain table — it is a spreadsheet
preview and a stacked card destroys the comparison — while the **import history** table below it
gets `responsive`. Do not touch `import/wizard/wizard-client.tsx` at all.

An editor row that spans the table with `colSpan` (the accounts manager has one) needs
`data-label=""` on that cell and nothing else.

Add ONE assertion per file to its existing test, and keep every existing assertion green.

`npx vitest run tests/app tests/ops` and `npx tsc --noEmit`.

Commit: `feat(ui): settings, dashboard and import history read as cards on a phone`.

## Release (after all four lanes)

`package.json` → `1.15.0`; `tests/ops/docker.test.ts` gains a 1.15.0 block and renames the 1.14.2
one; `CHANGELOG.md` gains `## [1.15.0] - 2026-08-29` (no migration); `docs/PENDING-FIXES.md` marks
backlog **BW** SHIPPED. Then the full `npx vitest run`, `npx tsc --noEmit`, tag `v1.15.0`, image.
