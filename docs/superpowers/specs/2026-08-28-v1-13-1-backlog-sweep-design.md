# v1.13.1 — the backlog sweep — design

**Date:** 2026-08-28
**Status:** Scope fixed by the owner (the 23 open items listed below); planner rulings P1–P22 recorded
here and reversible
**Target release:** v1.13.1
**Answers:** `docs/PENDING-FIXES.md` items **A, B, C, D, F** (v1.10.0 leftovers), **H, I, J, K**,
**L, M** (v1.11.0 leftovers), **P, Q, R** (v1.12.0 leftovers), and **BI–BQ** (v1.13.0 leftovers) —
23 items.
**Supersedes nothing.** Every v1.12.1 and v1.13.0 ruling stays in force — R1 (one family per
instance), R2 (the reader boundary), R3 (append-only audit log), R4 (rule ownership), R5 (a person
without a login), R10 (asset accounts take no transactions). This release fixes defects inside them.

**No schema change.** Nothing in these 23 items needs a column, a table or a migration. `drizzle/**`
and `src/db/schema.ts` are untouched by every task in this release; if an implementer finds
themselves reaching for either, they have misread their brief and must stop.

---

## Problem

Three releases (v1.11.0, v1.12.0, v1.13.0) each left a short tail of findings that were deliberately
not fixed mid-release, plus five older v1.10.0 notes that were parked. Nothing here is a feature and
nothing here is large: the biggest item is an hour, most are twenty minutes, and eight of them close
a gap that a reviewer already wrote the fix for.

What they have in common is that each one is a place where the app **tells someone something that is
not true**, or **offers a control that cannot work**:

- Settings → Updates greys out its own button and then looks identical whether an update was found
  or not (**H**).
- A child on a `self` scope is told in prose about an Export CSV button that is not on their page
  (**BM**), is shipped the whole household's roster of names (**BO**), and is shown attribution
  selects where every choice is refused (**BO**).
- A bill three weeks overdue reads "Ongoing" on the one page people actually navigate to (**Q**),
  and its detail card shows four guaranteed em-dashes for fields the kind can never hold (**R**).
- A screen reader is told the hint sentence is the field's *name* (**J**), is told nothing at all
  when an auto-save succeeds while being told when one fails (**L**), and cannot tell two identical
  coffee-shop charges apart from their kebab menus (**M**).
- "Nothing to split yet" is written, styled, given an action — and unreachable (**A**).

Two are security-shaped. A member re-flagging one transaction can delete an admin's rule with no
ownership check at all (**BJ**) — the one place in ruling R4's family that refuses nothing. And a
scheduled digest whose recipient's row vanished mid-batch is sent with a **household-scoped viewer**,
which is the one thing ruling R2 exists to prevent (**BK**).

The rest are hygiene with a stated reason: two tables one long value away from starving a control
(**I**), an uncapped and unbounded dashboard list (**P**), a missing admin toggle for a flag that
already exists in the library (**BI**), an O(n) ownership pre-check (**BL**), a preview route that
accepts an account its own commit route refuses (**BQ**), a CSV mapping editor rendered over an OFX
file (**BP**), and three test-shaped items (**B**, **K**, **BN**).

Three items — **C**, **D** and **F** — resolve to *no code*, and each says so in its own analysis.
They are closed with the reason recorded rather than left open to be re-read next release.

---

## Rulings

There are no new owner rulings in this release; the owner's contribution was the scope list. Every
ruling below is the **planner's**, each marks a place where a backlog item was silent, offered a
choice, or was mechanically wrong about the working tree, and each is flagged so the owner can
reverse it without a re-plan.

| # | Ruling |
|---|---|
| **P1** — planner, reversible | **C, D and F ship as documentation-only closures — no code.** Each item's own analysis forbids the code change: C's fix "means naming which file counts, which is what ruling A7 forbids"; D says "no action needed"; F says "do not chase it as a product bug", and its two suggested levers are already spent (`pool` is pinned at `vitest.config.ts:18`) or unverifiable on a machine whose OneDrive filter driver is the cause. Task 9 marks all three CLOSED in `docs/PENDING-FIXES.md` with that reason. `vitest.config.ts` is not edited by any task. |
| **P2** — planner, reversible | **A's dead branch is the GATE, not the push and not the EmptyState.** Item A offers two options ("either the push is wrong or the empty state should go") and instructs the implementer to read `personSpendSplit` and decide. Read: the unconditional push at `src/lib/reports.ts:361-362` carries its own reason ("The unattributed bucket is always present — never silently dropped") and that reason is sound — a bucket that disappears at zero hides the difference between "nobody unattributed" and "we stopped counting". The EmptyState is worth keeping — a virgin database should not render a lone `$0.00` row. So neither goes: the gate at `reports-client.tsx:415` changes from `split.length === 0` to "every row is zero", which makes the branch reachable on exactly the month it was written for. `src/lib/reports.ts` is **not modified** (its `viewer: Viewer` signature is pinned by `tests/ops/visibility-invariants.test.ts`); one test is added there to pin the always-present bucket so a future reader does not delete it. |
| **P3** — planner, reversible | **I converts BOTH at-risk tables, not just the merchant-rules one.** Item I says "do not pre-emptively convert all of them" and calls `warranties-client.tsx` "the least urgent of the two". Item **Q**, in this same release, adds content to that table's Expiry cell — which is precisely the "one long value away" event item I is waiting for. Converting it now, in the same task that widens its content, is cheaper and safer than converting it after a regression. |
| **P4** — planner, reversible | **Q surfaces the schedule in the Expiry cell, and dates only — never amounts.** The Expiry cell is already kind-phrased (`expiryPhraseForKind` / `openEndedDisplayLabel`), so it is where a bill's schedule belongs; the Status cell keeps `StatusBadge` untouched. No amount is rendered: a due *date* and an *overdue count* are enough to stop the row lying, and keeping money out of the cell keeps the column narrow and keeps ruling R2 trivially satisfied. The wording lives in `src/lib/warranty/constants.ts` (MUST-19.11: one place per wording rule), not inline in the component. |
| **P5** — planner, reversible | **Q reads the schedule in `warranties/page.tsx`, via the existing `unpaidInstallments()`. No lib change.** `searchWarrantyItems` is in `REQUIRE_VIEWER` and its row shape carries no installment data; widening it would touch a guarded read-model for a display detail. The page already has `viewer` and `today`, so it builds a `Map<itemId, {nextDueDate, overdueCount}>` itself and passes it as one new prop. `src/lib/warranty/installments.ts` is not modified by any task in this release. |
| **P6** — planner, reversible | **R hides an inapplicable field only when it is also EMPTY.** `productFieldsAllowedForKind`'s own docblock (`src/lib/warranty/constants.ts:272-286`) is explicit: "this decides what a form OFFERS, never what it may hide… a field with a value in it must stay on screen — hiding a stored value is how data gets silently dropped on the next save." Item R's fix as written ("hide inapplicable fields via the same kind gates") would violate that for an item whose type was changed after it was saved. The rule is therefore `gate(kind) || value !== null` — for a Bill, all four are null and all four disappear; for a re-typed item that still holds a model, the row stays. |
| **P7** — planner, reversible | **J moves the hint OUT of the `<label>` and adds `aria-describedby` only where a document-unique id already exists.** `src/components/ui/form.tsx` has no `'use client'` directive and `Field` is rendered from server components (`dashboard/page.tsx` among them), so `useId()` is unavailable and no id can be generated. Moving the hint out of the label element fully fixes the reported defect — the accessible name stops carrying the hint sentence — and touches one file. In the `htmlFor` branch, where the caller has already supplied a unique id, the hint additionally gets `id={`${htmlFor}-hint`}` and the single child element is cloned with `aria-describedby`. The 17 call sites that pass `hint` without `htmlFor` are **not edited** (they span all three lanes); the remaining gap — hint present, not programmatically associated — is recorded as new backlog item **BS**. |
| **P8** — planner, reversible | **L announces "Saved" from a dedicated `sr-only` polite region, and the decorative slot keeps `aria-hidden`.** `StatusSlot` returns a fragment: the existing fixed-width `aria-hidden` span, unchanged, plus a `<span className="sr-only" aria-live="polite">` that is always in the tree (a live region added at the same moment its content changes does not announce) and whose text is `'Saved'` only in the saved state. One word, so a control someone edits repeatedly does not turn into chatter. |
| **P9** — planner, reversible | **P caps at 8 rows, bounds overdue at 90 days, and the header total sums the WINDOW, not the page.** Three decisions the item left open. `COMING_UP_ROW_LIMIT = 8` and `COMING_UP_OVERDUE_DAYS = 90` are exported named constants in `src/components/ComingUpCard.tsx`. The overdue bound needs a reference date the card does not have, so `ComingUpCard` gains a `today: string` prop that `dashboard/page.tsx` already has in hand. The `aria-label` total sums every row **inside the window** — including the ones the "+N more" line stands for — because a total that stopped at the eighth row would understate what is owed. Rows dropped by the 90-day bound are not summed, which is the point of bounding them. |
| **P10** — planner, reversible | **P's overflow affordance is a footer line, not a header link.** There is no "+N more" pattern anywhere in this codebase; the nearest is `ExpiringSoonCard`'s `slice()` plus a "View all" link in the Card's `action` slot — which `ComingUpCard` already uses for its money total. So the affordance is a final `<li>` reading "+N more due" and linking to `/warranties`, in the same list, and it becomes the pattern the next card copies. |
| **P11** — planner, reversible | **BI's control is an `AutoSaveCheckbox` in a new "Sign-in" column, not a kebab item.** The row already carries an `AutoSaveSelect` for "Sees" (`users-manager.tsx:150-160`) and this flag is the same shape of edit: single row, reversible, refused server-side with a sentence. It is a checkbox rather than a select, which also keeps `tests/ops/row-controls.test.ts` out of the question (that guard keys on `<select>` inside a `<form>` with a submit button). The table goes from 7 to 8 columns, so both `colSpan={7}` at `:195` and `:231` become `colSpan={8}`. |
| **P12** — planner, reversible | **BJ refuses the whole action, verbatim as the item's reviewer wording pass demands, and the check moves ABOVE the `is_transfer` write.** The two `deleteExactRule` calls are at `engine.ts:552` and `:556`, *after* `db.update(transactions)` at `:543`. A check left where the deletes are could only refuse after the flag was already flipped, which every sibling R4 writer forbids. So the opposite-kind rule's owner is resolved in the same block as the existing R4 check (`engine.ts:512-541`), and a refusal returns `{ ok: false, reason: 'owned_by_another', ownerName }` with no row and no rule touched. `RuleGuardedWriteResult` already carries that shape — no type change, and both existing call sites (`src/lib/transactions.ts:404`, `src/app/(app)/review/actions.ts:110`) already surface it. |
| **P13** — planner, reversible | **BJ's owner lookup is a new exported helper in `src/lib/categorize/rules.ts`, not a copy of `upsertRuleFromCorrection`'s inline query.** `exactRuleOwner(pattern, kind)` returns `{ createdBy, ownerName } | null` using the same `leftJoin(users, …)` and the same `'Another member'` fallback. One definition, two readers. |
| **P14** — planner, reversible | **BL keeps refusing a NONEXISTENT id, not only a foreign one.** `getTransaction(id, viewer)` returns null for both cases and `allTransactionsVisible` currently refuses on either. A narrow owners query must not lose the existence half — a household viewer POSTing a bogus id is refused today and must stay refused. The new helper is `transactionOwners(ids): Map<number, number | null>` in `src/lib/transactions.ts`, returning **only** id and owner: no amount, no description, no merchant. It is added to `tests/ops/visibility-invariants.test.ts`'s `EXEMPT` list with a written reason, because that guard's whole discipline is that an un-viewered reader in `src/lib/transactions.ts` is a decision somebody writes down. |
| **P15** — planner, reversible | **BM gates the person-split clause as well as the Export CSV clause.** The paragraph at `reports-client.tsx:150-157` makes two promises a self viewer cannot keep: "how the household's split by person works out" and "Export CSV gives you the same rows in a spreadsheet". Both props (`showPersonSplit`, `showExport`) are computed identically from `!isSelfScoped(viewer)`, so gating both is the same one-line ternary shape and removes both false promises. Fixing only the one BM names would leave the paragraph still lying in the same sentence. |
| **P16** — planner, reversible | **BO passes `people = []` for a self viewer, exactly as the item writes it, and hides the two selects PLUS quick-add's Person field.** `/transactions` renders `QuickAddTransaction`, which takes the same `people` prop (`transactions-client.tsx:239`). With an empty list its Person select degenerates to a lone "Account default" option — shown-but-ineffective, the thing the file's own rule at `:382-384` forbids. It is hidden on `people.length === 0`, no new prop. The per-row cell renders the attributed name as plain text rather than vanishing, so the column keeps its width and the row keeps its meaning. |
| **P17** — planner, note (not reversible without new scope) | **`dashboard/page.tsx:65` and `goals/page.tsx:28` pass the full roster to a self viewer too. Out of scope.** BO names `/transactions` only; `budgets/page.tsx:78-79` already filters. Recorded as new backlog item **BR** rather than fixed here. |
| **P18** — planner, reversible | **BP adds `source: 'csv' \| 'ofx'` to `PreviewResult`.** `src/lib/import/preview.ts:52-94` carries no format field at all, so "when the preview reports an OFX source" describes something that does not yet exist. The alternative — inferring OFX in the client from `columnOptions.length === 0 && dateFormatDetection.status === 'none'` — encodes two unrelated implementation details into a UI condition. One additive field, set from the `ofx` local already computed at `preview.ts:109`. |
| **P19** — planner, reversible | **BQ returns 400 with the sentence the other three refusals already use.** `'That account only holds a balance you type in.'` is written identically at `api/import/commit/route.ts:50`, `api/simplefin/link/route.ts:47`, `lib/import/flow.ts:49` and `transactions/actions.ts:89`. The gate goes immediately after the existing `!account` 404 at `preview/route.ts:73`, so nothing is staged or parsed for an asset account. |
| **P20** — planner, reversible | **B's whole-segment match is a negative lookahead, and the guard is run before the help content is touched.** `!content.includes(item.href)` becomes a regex requiring the href not be followed by a word character, `-` or `/`. `src/app/(app)/help/content.tsx:402` already carries `<Where path="/settings">`, so `/settings` passes on its own merit; the other eight are expected to as well. If any href fails the tightened guard, the fix is to document that route in `help/content.tsx` — never to loosen the guard back. |
| **P21** — planner, reversible | **BN ships two test files: one that partial-mocks the library to pin the action layer's forwarding, one that exercises the asset skip for real.** `linked_elsewhere` is raised deep inside `recordInstallmentPayment`'s transaction by a loan rule claiming the payment's own transaction; reproducing that end-to-end would test the library again, which is already covered. BN's stated risk is "a future refactor of the ACTION layer could silently stop forwarding either result" — so the test that catches it forces the result and asserts the sentence. The asset-skip half needs no mock: `insertTestAccount` takes `type: 'asset'`, and `accountForPayment` must walk past it. |
| **P22** — planner, note | **The release is 23 items and 20 of them touch code.** A, B, C, D, F (5) + H, I, J, K (4) + L, M (2) + P, Q, R (3) + BI, BJ, BK, BL, BM, BN, BO, BP, BQ (9) = 23. C, D and F are the three that do not (P1). All 23 are mapped to a task in the plan's item→task table. |

---

## Item by item

Every subsection states the current behaviour with a `path:line` from the working tree at
`cd3b037`, the target behaviour, the exact change, and the test that pins it.

### A — `personSpendSplit`'s empty state is unreachable (~10 min)

**Current.** `src/app/(app)/reports/reports-client.tsx:415` gates the "Nothing to split yet"
`EmptyState` (`:416-424`) on `split.length === 0`. `personSpendSplit`
(`src/lib/reports.ts:338-366`) pushes the unattributed bucket unconditionally at `:361-362`
(`spendByUser.get(null) ?? 0`), so for the only viewer who sees this card at all — the card is
dropped entirely for a self viewer at `:412` — the array is never empty and the branch never runs.

**Target (P2).** The EmptyState renders when every row is zero, which is the month it was written
for. The unattributed bucket keeps being pushed at zero.

**Change.** `reports-client.tsx:415`: `split.length === 0` →
`split.every((row) => row.spentCents === 0)`. No change to `src/lib/reports.ts`.

**Test.** `tests/app/reports-client.test.tsx`: with `split: [{ userId: null, label:
UNATTRIBUTED_LABEL, spentCents: 0 }]` the card shows "Nothing to split yet" (fails today — the
row renders instead); with one non-zero row it shows the list and not the empty state. Both queries
scoped with `within()` on the card, because the person filter's static
`<option>Household/unattributed</option>` carries the same text as `UNATTRIBUTED_LABEL` — the
collision that file's own docblock warns about. `tests/lib/reports.test.ts` gains one assertion that
the unattributed row is present with `spentCents === 0` on a range with no unattributed spend.

### B — onboarding guard 2 matches href prefixes (~15 min)

**Current.** `tests/ops/onboarding-coverage.test.ts:158`:
`guardedNav.filter((item) => !content.includes(item.href))`. `/settings` is satisfied six times over
by `/settings/accounts` and friends. A future `/report` or `/budget` route would be silently
satisfied by the already-documented `/reports` / `/budgets`, which is the one failure this guard
exists to prevent.

**Target.** The href must appear as a whole path segment.

**Change (P20).** Replace the `includes` filter with a negative-lookahead regex per href: the href,
not followed by `[\w-]` or `/`. The href is regex-escaped before use.

**Test.** The guard is the test. It must be run and pass unchanged against today's
`help/content.tsx`; a self-check is added asserting that a synthetic `'/report'` is NOT satisfied by
a content string containing only `'/reports'`, so the tightening cannot silently rot back.

### C — onboarding guard 3 searches every local module a page imports — CLOSED, no code (P1)

**Current and target are the same.** `tests/ops/onboarding-coverage.test.ts:164-174` resolves
`${dir}/page.tsx` plus every relative import it makes, so for `/settings` four files can satisfy one
route. Item C's own analysis: "Tightening it means naming which file counts, which is what ruling A7
forbids, so the broad version shipped and the failure message prints the searched set. Revisit only
if a false pass actually happens." No false pass has happened.

**Change.** None. Task 9 records it CLOSED with that reason.

### D — Budgets and Settings guide panels use a derived `empty` — CLOSED, no code (P1)

Item D is a note, not a defect: "Recorded so a future reader does not mistake either for an
oversight." `PageGuide` lost its `empty` prop entirely in v1.12.0 (item N), so the condition the item
describes no longer exists in the component's API at all. **Change:** none. Task 9 records it CLOSED.

### F — `onTaskUpdate` RPC timeout makes a passing local suite exit 1 — CLOSED, no code (P1)

**Current.** A full local run reports every file and every test passing plus one unhandled error from
inside `node_modules/vitest/dist/chunks/rpc.*.js`, setting exit 1. Linux CI on the same commits does
not report it; the working copy sits inside a OneDrive-synced directory.

**Target.** Unchanged, with the standing rule already in force: read the pass/fail counts, not the
exit code, and treat CI as the gate.

**Change.** None. Item F's two levers are spent or unverifiable: `pool: 'forks'` is already pinned
(`vitest.config.ts:18`), and raising a worker RPC timeout to mask a filter-driver stall cannot be
verified from the machine that has the stall. `vitest.config.ts` is edited by no task. Task 9 records
it CLOSED with that reason and keeps the standing rule in the plan.

### H — Settings → Updates needs a page refresh (~1h)

**Current.** `src/app/(app)/settings/updates-client.tsx:53-58` hands `useActionState` an inline
`async` closure for five of the six update actions; only `setAutoApplyAction` (`:55`) is passed
directly. A closure defined in a `'use client'` module is a CLIENT function, so React never processes
a server-action response for those five: the server cache is invalidated by
`revalidatePath(UPDATE_PATH)` (`settings/actions.ts:232, 242, 272, 329, 345, 364, 377`) while the
client keeps the props from the original render, and the availability UI is driven by
`props.latestVersion` / `props.severity` (`:93-110`), not by the returned `message`.

The wrapping is not arbitrary: `useActionState` calls its action as `(prevState, formData)` and four
of these take no parameters, so passing them directly is a type error.

**Target.** All five are passed directly, matching `setAutoApplyAction`, and the returned message is
asserted to render.

**Change (item H's fix option 1, the cause not the symptom).** In
`src/app/(app)/settings/actions.ts`, give the four no-arg actions and the two formData-only actions
the `(_prev: UpdateActionState, formData: FormData)` signature:
`enableUpdateChecksAction` (`:226`), `disableUpdateChecksAction` (`:236`),
`checkForUpdateNowAction` (`:257`), `applyUpdateAction` (`:309`), `dismissUpdateAction` (`:357`).
`reviewUpdateAction` (`:284`) is **left alone** — it revalidates nothing by design (docblock
`:280-283`) and returns a different state type. Then `updates-client.tsx:53-58` passes each action
reference directly. `tests/app/update-actions.test.ts` call sites gain the `{}` first argument.

**Also in scope, from the item's own last paragraph:** pressing **Check now** on the newest version
returns `'You are on the newest published version.'`, and the test must assert that *sentence*
renders — a control that greys out and then looks identical is indistinguishable from one that did
nothing.

**Test.** `tests/app/updates-card.test.tsx`: a static assertion that no `useActionState` call in
`updates-client.tsx` wraps its action in an inline `async` closure (source read, the same shape
`tests/ops/*` guards use), plus a render test that a `checkState.message` of
`'You are on the newest published version.'` reaches the success `Notice`.
`tests/app/update-actions.test.ts`: each of the five actions is called as `(prevState, formData)` and
still returns its message and still calls `revalidatePath('/settings')`.

### I — two tables that fit only because the data is short (~20 min each)

**Current.** Both are `<TableWrap bare>` with no `fixed`, no `minWidth`, no `<colgroup>`:
`src/app/(app)/settings/managers/managers-client.tsx:254` (merchant rules, 7 columns, ~926px today —
a long monospace pattern beside a "Parent › Child" label reaches ~1100px and squeezes the trailing
delete button) and `src/app/(app)/warranties/warranties-client.tsx:195` (9 columns, ~1090px, already
at the edge).

**Target (P3).** Both get `TableWrap bare fixed minWidth="…"` plus a `<colgroup>` whose `<col>` count
matches the header, following the house convention set by
`src/app/(app)/transactions/transactions-client.tsx:459-497`: the `minWidth` string is the arithmetic
sum of the `<col>` widths, stated in a comment above the tag; each `<col>` carries a comment
justifying its width; width utility classes come off the `<th>`s.

**Change.** Merchant rules — 7 cols summing **58rem**: Pattern 14, Match 6, Kind 7, Category 13,
Renames to 10, Hits 5, actions 3. Warranties — 9 cols summing **85rem**: Item 14, Type 9, Vendor 9,
Purchase date 7, Expiry 13 (widened for item Q's schedule text), Status 8, Owner 9, Price 7,
Billing 9. The categories table in the same managers file is **not** converted — it is not on item
I's list.

**Guard.** `tests/ops/table-layout.test.ts:75` requires `minWidth` in the same opening tag as
`fixed`; its docblock states it deliberately does **not** count `<col>` against `<th>` because
two-table files (exactly this one) produce false failures, so the count is a review obligation.

**Test.** `tests/app/managers-client.test.tsx` and `tests/app/warranties-client.test.tsx`: each
asserts the table carries a `<colgroup>` with the right number of `<col>` children and that the
`data-table--fixed` class is present.

### J — `Field` puts its hint inside the `<label>` (~30 min)

**Current.** `src/components/ui/form.tsx:30` makes the wrapper a `<label>` when no `htmlFor` is
given, and the hint renders inside it at `:41`. The input's accessible name becomes "Original amount
What you borrowed. Used for the payoff bar." 17 of the 30 `hint`-bearing call sites take that branch.

**Target (P7).** The hint is never part of the accessible name. Where a unique id exists, it is the
accessible *description*.

**Change.** Restructure `Field` so the wrapper is always a `<div>`; the implicit branch nests only
the label text and the control inside a `<label>`, and the hint renders as a sibling of that
`<label>`. In the `htmlFor` branch the hint gets `id={`${htmlFor}-hint`}` and the single child
element is cloned with `aria-describedby` — guarded on `React.isValidElement(children)` and on the
child not already carrying one. No call site is edited.

**Consequence to state in the docblock:** `getByLabelText('Original amount')` now matches those
fields where a regex was previously required. That is the symptom item J names disappearing, not a
test to loosen.

**Test.** New `tests/components/form-field.test.tsx` (there is no existing test for `form.tsx`): the
implicit branch's input has accessible name exactly `'Original amount'` and the hint text is present
in the document but outside the `<label>`; the `htmlFor` branch's input carries
`aria-describedby="loan-original-hint"` pointing at the hint's id.

### K — a second load-sensitive OCR test (~30 min)

**Current.** `tests/lib/warranty/ocr/onnx/engine.test.ts:89-107` — "runs no inference at all for a
PDF" — calls `receiptFile()` (`:19-31`, a 1400×900 raw RGB buffer through `sharp().png()`) and
`fakeSessions(image)` (`:41-74`, whose first line runs the real `preprocessReceipt`), then writes a
16-byte fake PDF into the temp dir and asserts no session was touched. Everything expensive is dead
weight: the PNG is never recognized and `runDet` is overwritten immediately.

**Target.** The test measures the code, not the machine.

**Change.** Replace both helpers in this one test with `fs.mkdtempSync` plus a hand-built
`OnnxOcrSessions` (`src/lib/warranty/ocr/onnx/session.ts:30-40`: `runDet`, `runCls`, `runRec`,
`clsInputHeight`, `clsInputWidth`, `recClassCount`, `dictionary`) whose three runners increment a
counter and throw. No `sharp`, no `preprocessReceipt`, no PNG. The other six tests in the file keep
`receiptFile()`/`fakeSessions()` — their docblock reason (the detection tensor must agree with the
real preprocess or `detectBoxes` throws) genuinely applies to them and not to this one.

**Test.** The test itself, with the same two assertions (`rejects.toThrow()` and the counter at 0)
and a run in isolation to confirm it no longer loads anything heavy.

### L — auto-save success is silent to assistive tech (~20 min)

**Current.** `src/components/ui/AutoSave.tsx:124-141` — `StatusSlot` carries the only
`aria-hidden="true"` in the file, at `:129`, over the spinner, the tick and the `!`. A refused save
IS announced (`ErrorLine`, `:144-151`, `role="alert"`). Success is announced to nobody. The asymmetry
is the bug.

**Target (P8).** Success and failure are both observable.

**Change.** `StatusSlot` returns a fragment: the existing `aria-hidden` span unchanged, plus
`<span className="sr-only" aria-live="polite">{shown === 'saved' ? 'Saved' : ''}</span>` — always in
the tree, one word, no interruption. `AutoSaveSelect` (`:228`), `AutoSaveCheckbox` (`:297`) and
`AutoSaveTextInput` (`:425`) all render `StatusSlot`, so all three gain it with no call-site change.

**Test.** `tests/unit/auto-save.test.tsx`: after a successful save the live region's text is `'Saved'`
and its `aria-live` is `'polite'`; before any save it is empty but the element exists; after a
refused save the live region is empty and `role="alert"` carries the server's sentence.

### M — kebab accessible names collide for identical descriptions (~15 min)

**Current.** `src/app/(app)/transactions/transactions-client.tsx:588`:
`<RowMenu label={`Actions for ${row.displayDescription ?? row.rawDescription}`}>`. `RowMenu`
(`src/components/ui/RowMenu.tsx:66`) uses `label` as the trigger's `aria-label` and the menu's
`aria-label`, and the `⋯` glyph is `aria-hidden`, so `label` is the whole accessible name. Two
identical coffee-shop charges on the same statement produce two identical names.

**Target.** Unique per row, quiet in the common case.

**Change.** Append the row's date **and** amount:
`` `Actions for ${desc} on ${row.date}, ${formatCents(row.amountCents)}` ``. Date alone is not
enough — the named collision case (two identical charges on one statement) is usually same-merchant,
same-date. `formatCents` is already imported in this file for the Money cell's neighbours; if not,
it comes from `@/lib/money`.

**Test.** `tests/app/transactions-client.test.tsx`: two rows with the same
`displayDescription` and different amounts produce two buttons whose accessible names differ, and
`getAllByRole('button', { name: /^Actions for TIM HORTONS/ })` returns two. The file's local
`openRowMenu(name)` helper (`:28`) switches from an exact string to
`new RegExp('^Actions for ' + escaped)`, so its 16 existing call sites keep passing a bare
description.

### P — the Coming-up card has no row cap and no lower date bound (~20 min)

**Current.** `src/components/ComingUpCard.tsx:83-109` renders every element of `bills`; there is no
`slice` and no cap, unlike the notification evaluator's
`MAX_NEW_ROWS_PER_USER_PER_EVALUATION = 20` (`src/lib/notify/evaluate/coming-due.ts:18`). The
`aria-label` total at `:70` sums every element, so the announced figure is as unbounded as the list.
`dashboard/page.tsx:107` calls `upcomingBills({ today, days: 30, includeOverdue: true, viewer })`,
and `includeOverdue` carries no lower bound (`src/lib/warranty/installments.ts:285` simply omits the
`>= today` condition), so an installment from years ago is exactly as eligible as one from last week.

**Target (P9, P10).** At most 8 rows, overdue bounded to 90 days, an honest total, and a visible
affordance for the rest.

**Change.** All of it inside `ComingUpCard.tsx` plus one new prop:
- export `COMING_UP_ROW_LIMIT = 8` and `COMING_UP_OVERDUE_DAYS = 90`;
- add `today: string` to the props and pass it from `dashboard/page.tsx:278-285` (the page already
  has `today`);
- `withinBound` drops an overdue row whose `dueDate` is more than `COMING_UP_OVERDUE_DAYS` before
  `today`, using `daysBetweenIso` from `@/lib/dates`;
- `listTotalCents` sums `withinBound`, so the `aria-label` describes the window;
- rows render `withinBound.slice(0, COMING_UP_ROW_LIMIT)`, followed by a final `<li>` reading
  "+N more due" linking to `/warranties` when `withinBound.length` exceeds the limit.

`upcomingBills` is in `tests/ops/visibility-invariants.test.ts`'s `REQUIRE_VIEWER` list and is **not**
modified — its `viewer: Viewer` parameter must not become optional or disappear.

**Test.** `tests/components/ComingUpCard.test.tsx`: 10 in-window bills render 8 rows plus a
"+2 more due" link; the header `aria-label` equals the sum of all 10; an overdue row 400 days old is
neither rendered nor summed while one 30 days overdue is both. The existing assertion at `:89`
("keeps the header total summing EVERY listed row") is rewritten to say "every row inside the
window", with the reason. `tests/app/dashboard.test.tsx` is re-run because it renders this card.

### Q — the `/warranties` row for a Bill says "Ongoing" (~30 min)

**Current.** `warranties-client.tsx:231-237`'s Expiry cell falls through to
`openEndedDisplayLabel(row.kind)`, which is `'Ongoing'` for a bill
(`src/lib/warranty/constants.ts:361-367`). `warranties/page.tsx` loads no installment data at all —
`WarrantyListItem` (`src/lib/warranty/search.ts:85-88`) has no due date and no schedule. A bill three
weeks overdue is silent on the list.

**Target (P4, P5).** The Expiry cell reads the earliest unpaid due date, or an overdue count.

**Change.**
- `src/lib/warranty/constants.ts` gains
  `billScheduleLabel(nextDueDate: string | null, overdueCount: number): string` beside the other
  wording helpers (MUST-19.11) — `'Next due 2026-09-30'`, `'2 overdue · next 2026-06-30'`, and
  `openEndedDisplayLabel('bill')` when there is no unpaid installment at all.
- `warranties/page.tsx` calls the existing `unpaidInstallments({ today, windowEnd: addDaysIso(today,
  3650), includeOverdue: true, ownerUserId: ownerScope(viewer) ?? undefined })` and folds the
  (already `dueDate ASC`) rows into `Map<itemId, { nextDueDate: string; overdueCount: number }>`,
  passed as a new `billSchedules` prop. The `ownerUserId` argument is what keeps a self viewer to
  their own bills.
- `warranties-client.tsx:231-237` adds a `row.kind === 'bill'` arm reading
  `billScheduleLabel(...)` from that map.

No amount is rendered (P4). `src/lib/warranty/installments.ts` and `src/lib/warranty/search.ts` are
not modified.

**Test.** `tests/lib/warranty/constants.test.ts`: the three shapes of `billScheduleLabel`.
`tests/app/warranties-client.test.tsx`: a `kind: 'bill'` row with a schedule entry renders
`'Next due …'` instead of `'Ongoing'`; with two overdue it renders the overdue count; with no entry
it still renders `'Ongoing'`.

### R — the bill detail header renders four guaranteed em-dashes (~15 min)

**Current.** `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:338-340` and `:354` render
Vendor, Model, Serial number and Price unconditionally. Only the billing row (`:355-375`) is
kind-gated. `productFieldsAllowedForKind` is `kind === 'warranty'`
(`src/lib/warranty/constants.ts:287-289`), so for a Bill all four can never hold a value.

**Target (P6).** An inapplicable field disappears only when it is also empty.

**Change.** Each of the four rows becomes conditional on
`productFieldsAllowedForKind(item.kind) || item.<field> !== null` — Price uses
`loanFieldsAllowedForKind(item.kind) || productFieldsAllowedForKind(item.kind) || item.priceCents !==
null`, since a loan legitimately carries a price-shaped figure. `Detail` (`:99-107`) and the `<dl>`
grid (`:336-392`) are otherwise untouched; the grid reflows on its own.

**Test.** `tests/app/warranty-detail-client.test.tsx`: a `kind: 'bill'` item with all four null
renders none of the four labels; a `kind: 'bill'` item that still holds a `model` (a type changed
after saving) still renders the Model row; a `kind: 'warranty'` item renders all four including the
em-dashes, unchanged.

### BI — no `can_sign_in` toggle in the users UI (S)

**Current.** `src/lib/auth/users.ts:265-269` — `setUserCanSignIn(userId, canSignIn)`, which throws
`'An admin must be able to sign in. Make them a member first.'` when clearing the flag on an admin —
has **no call site anywhere in the repo**. `UserRecord.canSignIn` is already selected
(`users.ts:22, :66`) and already on the row `users-manager.tsx` renders. An admin can create a
no-login person at signup but cannot convert an existing member either way without editing the
database.

**Target (P11).** A control beside each row, refusing the last-admin case the way the library
already does.

**Change.**
- `src/app/(app)/settings/users/actions.ts`: `setCanSignInAction(_prev, formData)`, shaped exactly
  like `setVisibilityAction` (`:137-152`) — `isSameOrigin` → `await requireAdmin()` → zod
  (`userId` positive int, `canSignIn` enum `['0','1']`) → try/catch surfacing `error.message` →
  `revalidatePath('/settings/users')` → `{ message: 'Updated.' }`.
- `users-manager.tsx`: a new "Sign-in" `<th>` after "Sees", and per row an `AutoSaveCheckbox`
  (`defaultChecked={user.canSignIn}`, `fields={{ userId: String(user.id) }}`,
  `label={`${user.name} can sign in`}`, `labelHidden`). Both `colSpan={7}` (`:195`, `:231`) become
  `colSpan={8}`.

The action file is `'use server'`, so the new export must be an async function
(`tests/ops/use-server-exports.test.ts`). `users-manager.tsx` is a `'use client'` file: it must keep
importing `UserRecord` as `import type` and must not value-import `@/lib/auth/users`
(`tests/ops/client-bundle.test.ts`).

**Test.** `tests/app/users-actions.test.ts`: an admin flips a member's flag off and the row reads
false; flipping an admin's own flag off returns the library's sentence and changes nothing; a member
caller is refused by `requireAdmin`; a cross-origin request returns `CROSS_ORIGIN_ERROR`.
`tests/app/users-manager.test.tsx`: the checkbox is present per row, reflects `canSignIn`, and
changing it calls the mocked action once.

### BJ — `setTransferFlag`'s housekeeping delete is not ownership-gated (S)

**Current.** `src/lib/categorize/engine.ts:492-559`. The R4 check at `:512-541` gates the rule this
action WRITES. The opposite-kind rule it then removes as housekeeping is deleted unconditionally:
`deleteExactRule(row.normalizedMerchant, 'not_transfer')` at `:552` and
`deleteExactRule(..., 'transfer')` at `:556`, both after the `is_transfer` write at `:543-546`.
`deleteExactRule` (`src/lib/categorize/rules.ts:162-168`) takes no actor and no owner. A member
re-flagging one transaction can delete an admin-authored rule.

**Target (P12, and the item's own reviewer wording pass).** The correct fix REFUSES. When
`actorRole` is `'member'` and the opposite-kind rule belongs to somebody else, the WHOLE action
returns `{ ok: false, reason: 'owned_by_another', ownerName }` — no row touched, no rule deleted —
exactly as `confirmCategory` and `upsertRuleFromCorrection` already refuse for the rule they write.
An "optional owner check" that still deletes after a refusal is not this fix.

**Change.**
- `src/lib/categorize/rules.ts`: new `exactRuleOwner(pattern: string, kind: RuleKind): { createdBy:
  number | null; ownerName: string } | null` (P13), the same `leftJoin(users, eq(users.id,
  merchantRules.createdBy))` keyed on `(pattern, matchType: 'exact', ruleKind)` with the same
  `'Another member'` fallback `upsertRuleFromCorrection` uses at `:116`.
- `src/lib/categorize/engine.ts`: inside the existing R4 block at `:512-541`, after the write-side
  check, resolve the opposite kind (`'not_transfer'` when `input.isTransfer`, `'transfer'` when not
  and `!matchesCardPattern` — mirroring the delete branches at `:548-557` exactly) and refuse if
  `input.actorRole !== 'admin'` and the rule's `createdBy` is non-null and not `input.userId`. The
  two `deleteExactRule` calls stay exactly where they are and are now unreachable on a refusal.

No type change: `RuleGuardedWriteResult` (`engine.ts:70-73`) already carries the shape, and both
call sites — `src/lib/transactions.ts:404` (which throws `BulkOwnershipRefusal` inside its
transaction so the whole batch rolls back) and `src/app/(app)/review/actions.ts:110-116` (which
renders `guardedWriteError`) — already surface it.

**Test.** `tests/lib/categorize/engine.test.ts`, extending the R4 suite at `:596`: an admin creates
an exact `not_transfer` rule on a merchant; a member flags that merchant's transaction AS a transfer;
the call returns `{ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' }`, the
`not_transfer` rule still exists, no `transfer` rule was created, and `is_transfer` on the row is
unchanged. The mirror case: a member un-flagging a card-pattern merchant whose `transfer` rule an
admin owns. And the passes-through cases: an admin does the same and it succeeds; a member whose own
rule it is succeeds; an ownerless (`createdBy IS NULL`) rule is deleted as before.

### BK — `viewerFor`'s null-fallback defaults to household scope (S)

**Current.** `src/lib/notify/evaluate/digest.ts:27-30` and
`src/lib/notify/evaluate/monthly.ts:30-33` are byte-identical: if `findUserById` returns nothing,
they return `{ id: userId, role: 'admin', visibility: 'household' }`. A self-scoped user whose row
vanishes in the window their digest fires could, in that one delivery, carry household-wide figures —
the one thing ruling R2 exists to prevent.

**Target.** Skip the send rather than fall back. Silence is safer than an over-scoped send.

**Change.** Both `viewerFor` functions return `Viewer | null`. `evaluateWeeklyDigest`
(`digest.ts:55-100`) returns `0` at `:58` when it is null; `fireMonthlyDigest`
(`monthly.ts:181-217`) returns `0` at `:184`. `0` already means "no outbox row was enqueued" in both
files, so no caller changes — `evaluateMonthBoundary` (`monthly.ts:224-235`) sums the `fire*` returns
unchanged. The docblocks that currently argue for the fallback are rewritten to argue for the skip;
the third copy at `stale.ts:19` is **out of scope** (item BK names two files) and its docblock gains
no edit.

**Test.** `tests/lib/notify/evaluate/digest.test.ts` and `.../monthly.test.ts`: with the recipient's
user row deleted, the evaluator returns `0` and the outbox is empty. Existing tests, which all have a
live recipient row, are unaffected.

### BL — `allTransactionsVisible` is an O(n) `getTransaction` per bulk action (S)

**Current.** `src/app/(app)/transactions/actions.ts:50-52` —
`ids.every((id) => getTransaction(id, viewer) !== null)` — called from `setAttributionAction`
(`:212`), `bulkCategorizeAction` (`:226`) and `bulkTransferAction` (`:247`). `getTransaction`
(`src/lib/transactions.ts:207-213`) runs `baseQuery()`: three joins and the full `SELECTION`, once
per id, for a check that needs one column.

**Target (P14).** One round trip, id and owner only, and the same two refusals as today.

**Change.**
- `src/lib/transactions.ts`: `transactionOwners(ids: number[]): Map<number, number | null>` — a
  single `getDb().select({ id: transactions.id, attributedUserId: transactions.attributedUserId
  }).from(transactions).where(inArray(transactions.id, ids)).all()` (both `inArray` and `getDb()` are
  already the file's idiom) folded into a Map. Returns an empty Map for an empty `ids`. Its docblock
  states that it is not a read-model: no amount, no description, no merchant, no joins, and that it
  exists so a bulk ownership pre-check costs one query.
- `src/app/(app)/transactions/actions.ts`: `allTransactionsVisible` becomes — fetch the map; refuse
  if any distinct id is missing from it (the existence half, which `getTransaction`'s null already
  covered today and which a naive scope-only rewrite would silently drop); then, when
  `ownerScope(viewer)` is non-null, refuse if any owner differs from it. `ownerScope` is added to the
  existing `@/lib/auth/viewer` import.
- `tests/ops/visibility-invariants.test.ts`: one `EXEMPT` entry for
  `src/lib/transactions.ts::transactionOwners` with a written reason over 40 characters. The guard's
  floor (`>= 27`) rises, which is the safe direction.

**Test.** `tests/lib/transactions.test.ts`: `transactionOwners` returns one entry per existing id
with the right owner, omits ids that do not exist, and returns an empty Map for `[]`.
`tests/app/transactions-actions.test.ts`: the three bulk actions still return `NOT_YOURS_ERROR` for a
self viewer given somebody else's id and write nothing; **and** a household viewer given a
nonexistent id is still refused and still writes nothing (the regression this ruling exists to pin).

### BM — the reports PageGuide promises Export CSV to a self viewer (S)

**Current.** `src/app/(app)/reports/reports-client.tsx:150-157` is unconditional prose: "…how the
household's split by person works out. The date range and person at the top drive every card below
at once, and **Export CSV** gives you the same rows in a spreadsheet." The button itself is correctly
dropped for a self viewer at `:140-146` via `showExport`, and the split card at `:412` via
`showPersonSplit`. Both props are `!isSelfScoped(viewer)` (`reports/page.tsx:169, :176`).

**Target (P15).** The paragraph names no control and no card that is absent for this reader.

**Change.** The Export CSV clause becomes conditional on `showExport` — when false, the sentence ends
at "…drive every card below at once." The "how the household's split by person works out" clause
becomes conditional on `showPersonSplit`. Two ternaries, one file, no new prop.

**Test.** `tests/app/reports-client.test.tsx`: with `showExport: false` the guide text does not
contain "Export CSV"; with `showPersonSplit: false` it does not contain "split by person"; with both
true the paragraph is unchanged (a full-sentence assertion, so a future edit that drops the clause
for everybody fails too).

### BN — `linked_elsewhere` and the asset skip are untested at the action level (S)

**Current.** `src/app/(app)/bills/actions.ts:85-89` is the only action-level handling of
`linked_elsewhere` and returns `'That payment matched an existing loan rule instead of this bill, so
nothing was recorded.'`; `:90` is the only handling of `rule_owned`. `accountForPayment` (`:38-46`)
is the only place that skips an asset account when resolving where a recorded payment lands. Both are
exercised at the library level (`src/lib/warranty/installments.ts`) and neither goes through the
action, so a refactor of the action layer could silently stop forwarding either result.

**Target (P21).** Both forwardings are pinned at the action layer.

**Change.** Tests only. No source file is modified for BN.
- New `tests/app/bills-actions-refusals.test.ts`: partial-mocks `@/lib/warranty/installments`
  (spreading `importActual` so `findInstallmentItem` and `addInstallment` stay real) and forces
  `recordInstallmentPayment` to return `{ ok: false, reason: 'linked_elsewhere' }` and then
  `{ ok: false, reason: 'rule_owned', error: 'Alice set up this rule…' }`, asserting the exact
  sentence the action returns for each and that the installment is still unpaid.
- `tests/app/bills-actions.test.ts`: one unmocked test where the caller's `lastAccountId` points at
  an `type: 'asset'` account — `accountForPayment` must walk past it to the first
  `acceptsTransactions` account, the payment is recorded there, and `setLastAccountId` remembers
  that account rather than the asset one.

### BO — `/transactions` serializes the household roster to a self viewer (S)

**Current.** `src/app/(app)/transactions/page.tsx:90` passes
`listAttributablePeople().map(...)` for every viewer. `listAttributablePeople()` takes no viewer.
Downstream, `transactions-client.tsx` feeds `people` to `QuickAddTransaction` (`:239`), the bulk
attribute form (`:440-449`) and the per-row `AutoSaveSelect` (`:566-578`) — none of the three guarded
by `selfScoped`, which is used in exactly one place in the file (`:385`, the person filter). For a
self viewer every attribution choice is refused server-side (`NOT_YOURS_ERROR`), so the controls are
inert and the names travel anyway.

**Target (P16).** No roster, and no inert control — the file's own rule at `:382-384`: "not rendered
rather than shown-but-ineffective".

**Change.**
- `transactions/page.tsx:90`: `people={isSelfScoped(viewer) ? [] :
  listAttributablePeople().map(...)}`. `isSelfScoped` is already imported at `:2`.
- `transactions-client.tsx`: wrap the bulk-attribute `<form>` (`:440-449`) in
  `{selfScoped ? null : (…)}`; replace the per-row `AutoSaveSelect` (`:566-578`) with
  `selfScoped ? <span className="text-muted">{row.attributedUserName ?? 'Household'}</span> : <AutoSaveSelect … />`
  so the column keeps its width and the row keeps its meaning. The `<AutoSaveSelect` element **stays
  in the file** — `tests/ops/row-controls.test.ts:86` counts occurrences of that token in
  `src/app/**` against a floor of 5, and this is a conditional render, not a deletion.
- `src/components/QuickAddTransaction.tsx:92-101`: the Person `Field` renders only when
  `people.length > 0`. No new prop.

**Test.** New `tests/app/transactions-page.test.tsx`, following
`tests/app/budgets-page.test.tsx`'s render-the-real-page-with-a-seeded-db pattern (mutable
`vi.hoisted` `currentUser`, `vi.mock('@/lib/auth/session')`): for a `visibility: 'self'` member the
rendered markup contains no other household member's name; for a household admin it does.
`tests/app/transactions-client.test.tsx`: with `selfScoped` the bulk toolbar has no "Attribute"
button and a row has no person select; without it, both are present.
`tests/components/quick-add.test.tsx`: `people: []` renders no Person field.

### BP — OFX/QFX import still renders the CSV mapping editor (S)

**Current.** `src/app/(app)/import/import-client.tsx:552-558` renders `MappingEditor` whenever
`preview && mapping`. For an OFX file `buildPreview` sets
`dateFormatDetection: { candidates: [], status: 'none', detected: null }`
(`src/lib/import/preview.ts:191`) and `columnOptions: []` (`:192`), and
`MappingEditor.tsx:73-86` turns `status: 'none'` into a warning banner — "Could not recognize this
column's date format" — over a file whose dates parsed fine. Every control in the editor is inert:
preview and commit both ignore the mapping for OFX (ruling R9).

**Target (P18).** No editor and no banner for an OFX preview.

**Change.**
- `src/lib/import/preview.ts`: add `source: 'csv' | 'ofx'` to `PreviewResult` (`:52-94`) and set it
  from the `ofx` local already computed at `:109` — `source: ofx ? 'ofx' : 'csv'`. Additive; the
  MUST-6.1 `'cardValues' in preview` guarantee is untouched.
- `import-client.tsx`: render the `MappingEditor` block only when `preview.source === 'csv'`. For an
  OFX preview the Step-2 card keeps its header and its row table and gains one sentence explaining
  that an OFX file carries its own columns so there is nothing to map.

**Test.** `tests/lib/import/preview.test.ts`: `source` is `'ofx'` for the OFX fixture and `'csv'`
for the CSV one. `tests/app/import-client.test.tsx`: with `source: 'ofx'` the "Could not recognize
this column's date format" banner is absent and the date-column input is not rendered; with
`source: 'csv'` and `status: 'none'` the banner is still there.

### BQ — `/api/import/preview` does not refuse asset accounts (S)

**Current.** `src/app/api/import/preview/route.ts:72-73` resolves the account and 404s an unknown
one, then goes straight to the profile check. Commit (`api/import/commit/route.ts:49-51`), SimpleFIN
link (`api/simplefin/link/route.ts:46-48`), `lib/import/flow.ts:49` and
`transactions/actions.ts:89` all refuse an `asset` account with the same sentence. Preview accepts
one and only fails at commit.

**Target (P19).** Symmetric refusal, before anything is staged.

**Change.** Import `acceptsTransactions` from `@/lib/accounts` (the file already imports
`getAccount` from there at `:5`) and add, immediately after the `!account` 404 at `:73`:
`if (!acceptsTransactions(account.type)) return Response.json({ error: 'That account only holds a
balance you type in.' }, { status: 400 });` — the sentence copied verbatim, with a comment naming
ruling R10 and the three sibling call sites.

**Test.** `tests/api/import.route.test.ts`, in the existing `describe('POST
/api/import/preview')`: an `insertTestAccount`-created `type: 'asset'` account returns 400 with that
sentence and leaves the staging directory empty.

---

## Safety

**Nothing here touches money math.** No item changes an amount, a total, a balance or a snapshot.
The two that come nearest are P (which stops *summing* overdue rows older than 90 days, and says so
in the card's own footer) and Q (which deliberately renders no amounts at all).

**Two items touch the reader boundary and both tighten it.** BK stops an over-scoped send; BO stops a
roster reaching a self viewer. Neither widens anything. `tests/ops/visibility-invariants.test.ts` is
edited once, by BL, and only to ADD an exemption entry with a written reason — its two floors
(`>= 27`, `>= 4`) rise or stay.

**One item touches an ownership refusal.** BJ is the last unguarded writer in ruling R4's family. It
adds a refusal; it removes none, and the refusal shape is the one three sibling functions already
return.

**The SimpleFIN access URL is not in scope anywhere in this release.** No item reads it, logs it,
renders it or passes it as a prop. BQ touches the preview route, which never sees it.

**No new dependency, no new endpoint, no new notification event, no schema change.**

---

## Release

`package.json` goes to `1.13.1`. `CHANGELOG.md` gains a `## [1.13.1] - 2026-08-28` section between
`## Unreleased` and `## [1.13.0]`, and `tests/ops/docker.test.ts:248` flips: a new
`MUST-7.1: the 1.13.1 release` block asserting the version and the headline claims, and the existing
1.13.0 block becomes a `still recorded intact (append-only discipline)` block with
`expect(pkg.version).not.toBe('1.13.0')`, exactly the pattern the 1.12.1 block at `:269` already
follows.

**No "Before updating" schema warning is needed** — this release changes no table — and the changelog
must say so plainly rather than omitting the paragraph, because a reader who has just come from
1.13.0 is expecting one.

`docs/PENDING-FIXES.md`: all 20 code items marked `SHIPPED in v1.13.1`; C, D and F marked `CLOSED`
with the reason from ruling P1; the "Status for all six below: OPEN" line at `:1484` corrected (it
governs nine items, not six) and retired. Two new items are appended: **BR** (dashboard and goals
pass the full roster to a self viewer, from P17) and **BS** (`Field`'s implicit branch still has no
`aria-describedby`, from P7).

**No tag and no push.** A tag push repoints GHCR `:latest`, which the NAS pulls. The release commit
lands on `main` and stops there.

## What this does NOT build

- **A migration.** Nothing in the 23 items needs one, and no task may edit `drizzle/**` or
  `src/db/schema.ts`.
- **A vitest config change** (F, ruling P1) — the two suggested levers are spent or unverifiable.
- **A tightened onboarding guard 3** (C, ruling P1) — ruling A7 forbids the only available fix.
- **`aria-describedby` on the 17 `hint`-without-`htmlFor` call sites** (J, ruling P7) — no id exists
  to point at and `useId` is unavailable in a module server components render. Backlog item BS.
- **A self-viewer roster fix on `/dashboard` and `/goals`** (ruling P17) — BO names `/transactions`.
  Backlog item BR.
- **A third `viewerFor` fix in `src/lib/notify/evaluate/stale.ts`** — item BK names two files.
- **Any change to `src/lib/reports.ts`, `src/lib/warranty/installments.ts`,
  `src/lib/warranty/search.ts` or `src/lib/bills.ts`** — three items were tempted toward one of these
  and each is answered at the page or the component instead (P2, P5, P9).
- **Playwright or any browser test.** Vitest and `tsc` are the whole gate.
