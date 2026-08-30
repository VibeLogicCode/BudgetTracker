# Card polish, warranties desktop, and the item ledger — implementation plan (v1.16.0)

> **For agentic workers:** three lanes, disjoint file sets. No Playwright. Vitest + `npx tsc --noEmit`.

**Goal:** finish the job v1.15.0 started. The phone cards work but read like a spec sheet; the
Warranties table scrolls sideways on every desktop; and an item's detail page tells you a payment
count instead of showing the payments.

**Spec:** this file. It follows a screenshot review of v1.15.0 running on the owner's own data.

## Global constraints

- No Playwright. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths, or real statement data anywhere — in code,
  comments, docs, fixtures or commit messages. Invented sample data only.
- Conventional commits. NO `Co-Authored-By`, no Claude attribution. Never change git identity.
- `no new Date()` in `src/lib/**` (an `at: Date = new Date()` default parameter is the pattern).
- Integer cents, ISO dates. 44px minimum touch targets.
- Never `git stash`, never `git add -A`, never touch `.tmp-data/`, never create a worktree, never
  copy or delete anything under `node_modules`.
- Lanes run NO git commands. The orchestrator stages and commits.

## The one rule behind items 1, 7

> **Content is always visible. A form that CREATES something sits behind a button.**

Quick add on Transactions already works this way (v1.15.0 ruling S6). The dashboard's Quick add,
the loan "Payment matching" rule form and the "Add receipt" picker do not, and each is the largest
block on its card while being the least-used control on it.

## Lane A — the card stylesheet (item 2)

**Files:** `src/app/globals.css` only.

Everything here is inside the existing `@media (max-width: 639.98px)` block that holds the
`.data-table--stack` rules. Six changes, all CSS, no markup:

1. **The headline never prints its label.** `.cell-stack-headline` is `display: block`, so its
   `::before` renders inline with no gap — every card in the app currently reads `CATEGORYHousing`,
   `FILEreceipts.csv`, `DESCRIPTIONpayroll deposit`. Suppress it: the headline IS what the card is
   about, so naming it is noise even once the spacing is fixed.
2. **Labels stop shouting.** The `::before` inherits a table-header treatment — 0.6875rem,
   uppercase, 0.06em tracking. Correct in a `<thead>`, noise five times over inside one card.
   Becomes `0.75rem`, `font-weight: 500`, `letter-spacing: normal`, `text-transform: none`, colour
   unchanged (`--subtle`). Desktop headers are untouched — they are a different selector.
3. **A hairline per row, and a 2.5rem row.** Label left, value right, with `border-top: 1px solid
   var(--line)` on every full-width cell and `padding-block: 0.5rem`. Without a rule the 200px
   between a label and its value on a 390px screen reads as dead space; with one it reads as a row.
   The three row-1 roles (`.cell-stack-lead`, `.cell-stack-headline`, `.cell-stack-amount`) get
   `border-top: 0` — they are placed on row 1 by explicit grid placement, so a DOM-order border
   would draw in the wrong place.
4. **A cell holding a control puts its label above and the control full width.** Selector:
   `td:has(select, textarea, input:not([type='checkbox']))` — flex column, `align-items: stretch`,
   and the control itself `width: 100%`. This is what stops a `<select>` or a number input hanging
   off the right edge of the card with its label marooned opposite. A checkbox is excluded on
   purpose: "☐ Roll over unspent" reads correctly inline. Use `:has()` rather than a new class so
   no page has to be edited — the stylesheet already depends on `:has()` (`main:has(...)`,
   `div:has(> .data-table--stack)`), and a browser without it simply keeps today's layout.
5. **`cell-stack-block`**, a new opt-in class for a cell whose value is neither text nor a form
   control — a progress bar. Same treatment as 4: label above, content full width. Lane C applies
   it to the budgets progress cell.
6. **The row menu becomes a visible button.** In stacked mode the `RowMenu` trigger is a 44px
   target with no border, so it reads as three grey dots floating in whitespace. Give
   `.cell-stack-actions button` (and the same trigger wherever it sits in a stacked row)
   `border: 1px solid var(--line)`, `border-radius: var(--radius-md)`, `background: var(--surface)`.
   Do not change its size — 44px is already correct.

Also add, at the same time: **`cell-stack-meta`**, a class for a cell that belongs under the
headline as small muted context rather than as its own labelled row (a date, an account name).
Rules: grid row 2, `grid-column: 2 / -1`, no label, `font-size: 0.75rem`, `color: var(--subtle)`,
`border-top: 0`, `min-height: 0`, `justify-content: flex-start`. Lanes B and C apply it.

Run `npx vitest run tests/ops` and `npx tsc --noEmit`. CSS is not asserted by tests; the guard is
that nothing else breaks.

## Lane B — Warranties list, item detail, and the ledger (items 4, 5, 6, 7, 8)

**Files:** `src/app/(app)/warranties/warranties-client.tsx`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, that route's `page.tsx` and its actions
file, `src/lib/loans.ts`, plus `tests/app/warranties-client.test.tsx`,
`tests/app/warranty-detail-client.test.tsx`, `tests/app/warranties-actions.test.ts` and a new
`tests/lib/item-ledger.test.ts`.

### Item 4 — the desktop table stops scrolling

The `<colgroup>` totals **85rem** while the page sits in the shell's standard **72rem** cap, so
every desktop shows a horizontal scrollbar and hides the last two columns, at any window size, even
with one row. Three parts:

- **Vendor stops being a column.** It is `—` on every loan and every contract. It moves under the
  item name as a muted sub-line (and gets `cell-stack-meta` on the phone), which is 9rem back and
  one less column to scan.
- **Trim the rest.** Expiry is allotted 13rem for a date; Type 9rem for a small badge. Bring the
  colgroup to roughly 72rem, and keep `minWidth` equal to the new total (the ops guard in
  `tests/ops/table-layout.test.ts` requires `fixed` and `minWidth` together, and the sum is the
  whole point of that prop).
- **Mark the page wide.** Add `data-page-width="wide"` to the client's root element, exactly as
  `transactions-client.tsx` and `reports-client.tsx` do, so eight columns get the 96rem shell.

Also on this page: the Search field is `flex-1` beside four ~150px selects, so it takes ~400px and
the row looks lopsided — give it a `max-w-sm`. And the status chip reading **"Term unknown"** reads
like an error; it means no end date was recorded. Reword to **"No end date"** (find every place
that string is produced; it is a status label, not free text).

### Item 5 — "Purchase date" is wrong for a loan

The column is shared by four kinds, so it cannot be per-row. Rename the column header to
**"Started"** and the sort option "Newest purchase" to "Newest start". On the DETAIL page, where
the kind IS known, label it per kind: *Purchased* (warranty), *Lent on* / *Borrowed on* (loan, by
`loan_direction`), *Starts* (contract or bill). Keep the underlying field name unchanged.

### Item 6 — the Linked transactions card (the main work)

Today the detail page shows the rules that create links and a bare hyperlink whose text is the
count — "Payments linked: 2". The links themselves are never listed. Everything needed is already
stored and already indexed: `loan_payments (txnId, itemId, amountCents, appliedCents, source)` with
`loan_payments_item_idx (itemId, id)`, and `bill_installments.paidTxnId` with
`bill_installments_item_idx (itemId, dueDate)`. **No migration.**

New in `src/lib/loans.ts`:

```ts
export interface ItemLedgerRow {
  txnId: number;
  date: string;
  merchant: string;
  accountName: string;
  amountCents: number;
  appliedCents: number;
  source: 'rule' | 'manual' | 'installment';
}
export interface ItemLedger {
  rows: ItemLedgerRow[];
  /** Signed, direction-aware for a loan; total paid for anything else. */
  totalAppliedCents: number;
}
export function itemLedger(itemId: number): ItemLedger;
```

It unions the two link tables, newest first, and joins `transactions` + `accounts` for the merchant
and account name. Reuse the direction maths already in this file (`loanSignedDelta`,
`isLoanRepayment`) rather than restating a sign rule — ruling P4 still stands: no literal `'lent'`
in `src/lib/loans.ts`.

The card, rendered for every item kind, replacing the "Payments linked" line:

- Header: `Linked transactions (N)`, and for a loan a summary line in the item's own direction —
  lent/borrowed, repaid, outstanding — built from the existing loan summary maths.
- One row per link: date, merchant, account, amount, applied, and a `rule` / `by hand` marker so a
  wrong automatic match is obvious. `TableWrap bare responsive` with `data-label` on every cell,
  merchant as `cell-stack-headline`, applied as `cell-stack-amount`, date+account as
  `cell-stack-meta`.
- Each row's merchant links to `/transactions?search=<merchant>` so the transaction is one click
  away.
- A row menu with **Unlink** posting to a new action that calls the existing
  `unassignTransactionFromLoan` (loans) or the existing un-mark path (installments). Refusals
  surface inline, never silently — same discipline as every other action on this page.
- Empty state: "No transactions linked yet." plus the sentence explaining that a payment rule or
  the Transactions row menu creates one.

Authorization: this page already resolves a viewer and refuses an item that is not visible. The new
action must reuse that same guard — do not invent a second one, and do not widen what a self-scoped
viewer can see.

### Item 7 — the rule form and the receipt picker fold away

In the "Payment matching" card, the existing-rules table stays exactly as it is and the ADD form
goes behind an **Add rule** button (closed by default, `aria-expanded`, `aria-controls`). Same for
Receipts: the list stays, the file input and Attach button go behind **Add receipt**. Both use the
disclosure shape `QuickAddTransaction` already uses — a `useState` toggle, no `<details>`, so the
open state survives a server action re-render.

### Item 8 — empty optional fields stop rendering

The detail grid prints `—` for Vendor, Payoff date, Payment and Notes on a loan: four dead cells
out of ten. An earlier release hid fields a kind CANNOT hold; this hides fields a kind can hold and
simply does not have. The Edit card remains the way to fill them in, so nothing becomes
unreachable. Fields that are structurally part of the item's identity (Type, Start date, Owner)
still render even when empty.

Tests: `itemLedger` returns loan payments and installment payments together, newest first, with
`appliedCents` per row and a direction-correct total; an item with no links returns an empty ledger;
unlink removes the row and refuses for a viewer who cannot act; the list header says "Started"; the
detail page says "Lent on" for a lent loan and "Purchased" for a warranty; an empty Notes field
renders nothing; the rule form and receipt picker are collapsed by default.

## Lane C — Dashboard, review width, meta lines (items 1, 3)

**Files:** `src/components/QuickAddTransaction.tsx`, `src/app/(app)/dashboard/page.tsx`,
`src/app/(app)/transactions/transactions-client.tsx`, `src/app/(app)/import/import-client.tsx`,
`src/app/(app)/budgets/budgets-client.tsx`, plus `tests/components/quick-add.test.tsx`,
`tests/app/dashboard.test.tsx`, `tests/app/transactions-client.test.tsx`,
`tests/app/import-client.test.tsx`, `tests/app/budgets-client.test.tsx`.

1. **Item 1 — dashboard Quick add behind a button.** `collapsible` currently applies only when
   `variant === 'page'`. Extend it to `'card'`: the dashboard renders the card header plus an
   **Add a transaction** button and nothing else until pressed. Keep the `#quick-add` hash effect
   working for the page variant. Closed by default in both.
2. **Item 3 — the review page is one column.** The transactions root carries
   `data-page-width="wide"` in BOTH modes, so on the review filter the guide and the filter card
   run to 96rem while the card list is capped at `max-w-4xl` — the mismatch in the screenshot. In
   review mode: drop the wide marker and wrap the whole view (guide, filter card, cards, pager) in
   one `mx-auto w-full max-w-4xl` container so every edge lines up. Outside review mode nothing
   changes.
3. **Apply `cell-stack-meta`** (Lane A defines it) to the cells that are context rather than data:
   the transactions Date cell, and the import history When and Account cells. Remove
   `cell-stack-hide` from the transactions Account cell and give it `cell-stack-meta` instead — it
   then appears as part of the meta line rather than vanishing, which is what the owner asked for.
4. **Apply `cell-stack-block`** to the budgets "Progress and pace" cell so the bar spans the card
   instead of being squeezed into the right half.

Tests: dashboard Quick add is collapsed and opens; review mode renders no `data-page-width="wide"`;
the transactions Date cell carries `cell-stack-meta`.

## Release (after all three lanes)

`package.json` → `1.16.0`; `tests/ops/docker.test.ts` gains a 1.16.0 block and renames the 1.15.0
one; `CHANGELOG.md` gains `## [1.16.0]` (no migration). Then the full `npx vitest run`,
`npx tsc --noEmit`, tag `v1.16.0`, image.
