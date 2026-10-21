# Fix a misfiled row where it was found: actions on the Budgets card, the rule behind the row, and a way back

Date: 2026-10-21
Status: proposed (written from the code; the owner was not available, so every assumption is marked)
Release: v1.57.0
Depends on: v1.56.1 (Not categorized yet card, Always ask rules, `uncategorized-spending` link)

## 1. What was found

1. **The card's transaction list is read-only.** `CategoryTransactionsPanel`
   (`src/app/(app)/budgets/budgets-client.tsx:421-482`) renders each row as a `ListRow` with the
   merchant, the date and the amount, and nothing a person can act on. `CategoryTransactionRow`
   (`src/lib/budgets.ts:215-220`) is id, date, merchant and amountCents: the smallest useful shape
   when the card only had to show what made up a total. Fixing a row a rule filed in the wrong
   category means leaving Budgets, finding the row on Transactions, fixing it, and coming back to
   see whether the figure moved.
2. **Transactions holds every control inline, in one 4,234-line client.** The per-row category
   control is an `AutoSaveSelect` (table `transactions-client.tsx:4145`, card `:2427`) posting
   `setCategoryAction` (`transactions/actions.ts:257-304`), which teaches a rule only when the form
   sends `teach=1` (review mode). The split editor is a `RowDialog` whose form, draft state and
   remainder maths live in the client (`:572-582`, `:1151-1197`, `:3276-3357`) and post
   `saveSplitsAction` (`actions.ts:1265-1299`). The Always ask dialog (`:1837-1906`) and its three
   effects (`:1100-1130`) do the same. None of the three is importable by another page.
3. **Which rule filed a row is not stored.** `transactions` has `categorization_source`
   (`src/db/schema.ts:242-246`) but no rule id; `CategorizeOutcome.matchedRuleId`
   (`src/lib/categorize/engine.ts:102`) lives for the engine run only. The Rules page's Affects
   column answers "which rule owns this row" by re-simulating the match through `attributedRuleId`
   (`engine.ts:536-563`), the one definition of attribution that `tests/ops/rule-attribution-
   honesty.test.ts` guards. The bank-text dialog does the same for rename rules
   (`transactions/page.tsx:121-138`) and shows nothing rather than name a rule that may be wrong.
4. **Links.** `transactionsHref` (`src/lib/transaction-links.ts:112-132`) owns every
   `/transactions?` link (`tests/ops/transactions-href.test.ts`); its targets are `category` (with
   `exact`), `merchant`, `import` and `uncategorized-spending`. There is no single-transaction
   target. `?via=groups` is navigation provenance, not a filter (`transactions-client.tsx:926-943`),
   and `groupsBreadcrumb` (`:2769-2800`) renders a way back out of a drill-down from it. The GET
   filter form (`:3390-3425`) carries review, transfers, queue, group, via, sort, dir, source,
   import and spending as hidden fields so a submit keeps them, but not `exact`: submitting the
   form after arriving with `category=<id>&exact=1` drops `exact` and widens the list to the
   category's children.
5. **Revalidation.** `setCategoryAction` revalidates `/transactions` and `/review` only
   (`actions.ts:298-299`); `saveSplitsAction` the same (`:1296-1297`). Budgets re-renders in place
   only when an action revalidates `/budgets`: its own actions do (`budgets/actions.ts:74,82,108`),
   and the SavingsTargetControl relies on it (`budgets-client.tsx:93-96`). The panel's rows are
   client state fetched by `categoryTransactionsAction` in an effect (`:440-454`), so they would not
   refresh with the page even then.
6. **The card's figure and Transactions' list ask different questions.** `categoryTransactions`
   filters `SPEND_ROW_WHERE` (no transfers, no loan principal) and `EFFECTIVE_CATEGORY = id` exactly
   (`budgets.ts:256-261`); refunds net in because it sums signed effective amounts. Transactions'
   `categoryMatchClause` (`src/lib/transactions.ts:367-376`) is split-aware and exact-capable but
   applies no spend rule, and `spending=1` is money out only (`SPENDING_OUT_WHERE`). No filter lists
   exactly the rows a card summed.
7. **Scope.** The panel asks with the card's `scope`, `userId` and `month`; the action narrows by
   the viewer (`category-transactions-action.ts:37-61`; `tests/ops/visibility-invariants.test.ts`
   lists `categoryTransactions`). A self viewer's `household` is null (ruling R2), the gate the
   client already uses for everything household-only.
8. **Guards that shape the structure.** A `'use client'` file may not value-import a module that
   reaches `@/db/client`; a `'use server'` module is imported by a RELATIVE specifier for that reason
   (`src/components/QuickAddTransaction.tsx:10`, `src/components/insights/RecurringMarkForm.tsx:8`,
   `budgets-client.tsx:45`). No lone select-plus-submit form under `src/app` (`row-controls`). No
   new rule writer, and every `confirmCategory` call names `createRule` (`rule-authoring-intent`).
   A `'use server'` module exports only async functions, each origin-checked first.
9. **The Not categorized yet card's Categorize link** opens the plain Transactions list
   (v1.56.1) because `REVIEW_WHERE` hides every loan-linked row (`engine.ts:2097-2102`) and a
   repayment on a loan the household owes is spending the card counts. The queue also lists
   uncategorized money IN, which the card leaves out (`uncategorizedSpend`, `budgets.ts:316-346`).
   In the queue a pick teaches a rule (`teach=1`) and the row menu offers Apply to all; the plain
   list offers neither.

## 2. Decisions

### 2.1 Fixes happen on the card, from a row menu

Each row in a card's transaction panel gains a `RowMenu` kebab in the `ListRow` trailing slot with
**Change category…**, **Split…** (or **Edit split…** on a split part), and **More in Transactions**.
The two frequent fixes open a dialog on the Budgets page; everything rarer (person, note, transfer,
recurring mark, loan link, receipt, rename) goes to that one row on Transactions and comes back
(§2.6).

Why a menu and dialogs rather than an inline select: a `ListRow` on a phone holds a glyph, the
merchant, the amount and one 44 px control, not a category select; the rule choice (§2.4) needs a
sentence of its own; `RowDialog` is the app's documented idiom for editing one thing about a row
(rename, note, split all use it); and a mis-scroll over a native select on a phone is the v1.12.1
defect. The Transactions page keeps its inline select; nothing there changes.

### 2.2 One implementation of each control

Three components under `src/components/transactions/`, used by both pages:

- **`SplitDialog`**: the split editor moved out of `transactions-client.tsx` with its form, draft
  parts, sign rule, remainder maths and Remove split, byte-for-byte. Props: the target row (id,
  merchant, date, the whole transaction's amount), the existing parts, the category options, the
  caller's `useActionState` dispatcher for `saveSplitsAction`, and `onClose`. The caller reads the
  action's result as it does today.
- **`AlwaysAskDialog`**: the Always ask dialog moved out, owning its pattern/match state, the
  300 ms live count, the saved flip and the send-back offer. Props: the merchant, `onClose`, and
  `onSent` (fired after rows went back to review, so a caller can refresh what it shows). It
  imports `previewAlwaysAskAction`, `setAlwaysAskAction` and `sendBackToReviewAction` itself, by
  the relative specifier the shared forms already use.
- **`RecategorizeDialog`** (new): `CategoryCombobox` plus the rule choice of §2.4, posting
  `setCategoryAction` with the same fields the Transactions controls post (`transactionId`,
  `categoryId`, `teach`). Uncategorized is offered: clearing a category is a real fix, and the
  action's clear path already refuses a split row and never deletes a rule
  (`clearCategory(deleteRule: false)`).

Both pages post the SAME server actions. `budgets-client.tsx` imports them from
`'../transactions/actions'` (finding 8). No budgets-side action wraps `confirmCategory` or
`setTransactionSplits`: a second action layer would be a second copy of the origin check, the
viewer check, the split refusal wording, the teach rule and the archived/always-ask notes.

### 2.3 The rule behind a row

`categoryRuleThatFiled(row, ctx)` in `engine.ts` wraps `attributedRuleId('category', …)`, the
Affects definition, and returns the rule only when the row's source is `rule` and the winning
rule's category equals the row's stored category. Otherwise it returns null and the card says
nothing about which rule: a rule edited, deleted or shadowed since must not be named, exactly as
the rename attribution behaves. No migration, no stored rule id (§3).

`categoryTransactionsAction` resolves this per row and returns it as `filedBy` (rule id, pattern,
match type), together with `alwaysAsked` (an enabled Always ask rule already covers the merchant)
and the parts of any split row. `CategoryTransactionRow` gains `normalizedMerchant`, `source`,
`splitId` and `parentAmountCents`.

On the row, a second small line (`ListRow`'s `detail` slot) says where the category came from, in
the words Transactions' source badge uses: **Set by rule: PHONEMART (contains)**; **Set by a rule**
when the source is `rule` but no current rule accounts for it; **Set by guess** for a Bayes row;
nothing for a hand-set row.

### 2.4 Changing the category, and what happens to future rows

The dialog is titled **Category for <merchant>** with the date and amount under it. For a row the
app filed on its own (source `rule` or `bayes`) and a viewer who may author rules (not
self-scoped), it adds a radio group **Future <MERCHANT> rows** with three choices:

1. **Change this transaction only** (default). Posts no `teach`. Rules and the guesser are left
   alone, the plain Transactions behaviour.
2. **Also file <MERCHANT> this way from now on.** Posts `teach=1`: `confirmCategory(createRule:
   true)` writes or updates the EXACT unbounded rule for this merchant text (or the one bounded
   exact rule covering the amount, `teachTarget`), the review-mode path. The sentence under the
   option says what that does, computed from `filedBy`:
   - the filing rule is exact on this merchant text: **Changes the rule PHONEMART 884 → Phone to
     the category you pick.**
   - the filing rule is wider (`contains` or `word`): **Adds a rule for PHONEMART 884 that wins
     over PHONEMART (contains). Other PHONEMART rows keep their rule.** This is true by
     `outranks` (`rules.ts:453-469`): the longer pattern wins, then exact over word over contains.
   - a guess: **Adds a rule for PHONEMART 884; the guesser learns from it too.**
   The action's own refusals and notes come through unchanged: another member's rule
   (`ruleOwnedError`), an archived category (`ARCHIVED_CATEGORY_NO_RULE`), an Always ask merchant
   (`ALWAYS_ASK_NO_RULE`).
3. **Always ask about <MERCHANT> from now on.** Saves the category for this transaction only, then
   opens `AlwaysAskDialog` prefilled (`alwaysAskPattern`, Contains). The rule is written only on its
   own **Always ask** press, as v1.56.0 settled: a rule write is a deliberate second click. Hidden
   when `alwaysAsked` is already true.

For an admin, the rule sentence ends with a link **Edit the rule under Settings** to
`/settings/merchant-rules?kind=category&q=<pattern>` (the filtered Rules page, the same shape the
bank-text dialog links). Retargeting a wider rule itself changes every merchant it matches, so it
stays on the Rules page (§3).

The dialog closes on submit, like the rename and note dialogs. The panel shows the action's
message as a status line and its error as an alert, and refetches its rows on success (§2.5).

### 2.5 The figures update

`setCategoryAction` and `saveSplitsAction` add `revalidatePath('/budgets')`, so the card's spent
figure, bar and pill re-render in place (finding 5). The panel bumps a `version` after each
successful category change, split save or send-back, and its fetch effect depends on it, so the
moved row leaves the list and a newly split row shows its parts. One source of truth, refetched;
no optimistic edit.

### 2.6 Open in Transactions, one row, and the way back

- **Open in Transactions** at the foot of every panel: `transactionsHref` gains
  `{ kind: 'budget-category', categoryId }`, writing `category=<id>&exact=1&spend=1&via=budgets`
  beside the month range and the person (personal scope). `exact=1` because every panel is exact
  (`categoryTransactions` filters `EFFECTIVE_CATEGORY = id`; a parent card has children rows and a
  direct bucket, not a flat list). `spend=1` is a new `TransactionFilter.spendRowsOnly` composing
  `SPEND_ROW_WHERE`, so the list is the rows the card summed: refunds included, transfers and loan
  principal out. Transactions shows a clearing chip, **Counted in budgets — clear**, with the title
  **Rows that count toward a budget: no transfers, no loan principal**.
- **More in Transactions** on a row: `{ kind: 'transaction', transactionId, via: 'budgets' }`
  writing `id=<n>&via=budgets`; `TransactionFilter.id` narrows to that row; chip **One transaction
  — clear**. The id is the whole question, so no range or person rides along (the `import` target's
  reasoning).
- **Back to Budgets.** `via=budgets` renders a breadcrumb above the list, **← Back to Budgets**
  followed by **<Category> — <Month>** as text, at every width and never behind the filter fold
  (the `groupsBreadcrumb` precedent). Its href is derived, not carried: month from `from` when
  `from` and `to` share a month, person from `person`, and the card from the category's top-level
  ancestor (`categories` carries `parentId`): `/budgets?month=2026-03&person=7#budget-card-personal-7-12`.
  `src/lib/budgets-links.ts` (new, pure) owns `budgetCardId` and `budgetsHref`; `MetricCard` gains
  `id`; a card named by the URL hash opens itself on mount (a leaf shows its panel, a parent opens
  its breakdown) and the browser scrolls to it. A child row's own panel is not reopened; the card
  is.
- `via` rides the GET form whatever its value, so refining a search keeps the way back; the
  active-filter badge still ignores it.
- **The `exact` fix.** The form carries `exact=1` as a hidden field while the Category select
  still holds the category the URL arrived with, and drops it once another category is chosen.

### 2.7 OPEN DECISION for the owner: where Categorize on Not categorized yet goes

Recommendation: open the review queue when the queue would show exactly the rows the card counts,
and the plain list otherwise. `uncategorizedSpend` returns `queueShowsSameRows`, true when no
counted row is loan-linked (the rows `REVIEW_WHERE` would hide) AND no uncategorized money-in row
sits in the month and scope (the rows the queue would add). `transactionsHref` regains
`{ kind: 'uncategorized-queue' }` (`review=1&queue=uncategorized&category=uncategorized&transfers=0`
with the month and person). The label stays **Categorize**.

Why not always the queue: v1.56.0 did that and v1.56.1 had to stop, because the count and the list
disagreed for a household with an uncategorized loan repayment. Why not always the list: a pick in
the queue teaches a rule and offers Apply to all, which is most of what categorizing a month's
rows needs; the usual month has no loan-linked or money-in uncategorized row, so the usual month
would lose that for the sake of the unusual one. Why the condition is both halves: equal counts do
not prove equal sets (one hidden loan row and one extra deposit cancel out).

This is the one item in the plan the owner can drop without touching the rest (plan Task 8); the
current behaviour stays if it is dropped.

### 2.8 Wording

Menu: **Change category…**, **Split…**, **Edit split…**, **More in Transactions**. Panel link:
**Open in Transactions**. Dialog: **Category for <merchant>**, **Save category**, **Cancel**; legend
**Future <MERCHANT> rows**; the three options and their sentences as in §2.4; **Edit the rule under
Settings**. Row line: **Set by rule: <pattern> (<match type>)**, **Set by a rule**, **Set by guess**.
Status lines are the actions' own messages (**Category updated.**, **Split saved.**, **Split
removed.**, **Sent N transactions back to review.**). Chips: **Counted in budgets — clear**, **One
transaction — clear**. Breadcrumb: **← Back to Budgets**. Plain and factual, no exclamation marks.

### 2.9 Phone layout

A panel row is `ListRow`: the direction glyph, the merchant (truncated) over the date and the
source line (wraps), the amount, and the 44 px kebab. The dialogs are `RowDialog`s, which already
trap focus, lock scroll and sit above the page on a phone; the split editor's part rows already
wrap. The breadcrumb never folds. The Rules page link opens a full page, as every Settings link
does.

### 2.10 Who sees what

A self-scoped viewer sees the menu, Change category and Split, and no rule choice (a rule is
household-wide; the actions refuse them anyway). Only an admin sees the Rules page link. The
personal section's panels post with the person's scope as today; the viewer narrowing in
`categoryTransactions` is unchanged.

### 2.11 Assumptions recorded (the owner was not asked)

- Recategorize and split are the two frequent fixes; the rest can go through one row on
  Transactions.
- A fix teaches nothing unless chosen: the default option changes one transaction, as the
  Transactions select does.
- "Back to the card" means the top-level card scrolled into view and opened; reopening a child
  row's own panel is not required.
- Dashboard and Reports are not revalidated by a recategorize (they never were).

## 3. Alternatives rejected

- **A popup holding the whole Transactions page** (or a copy of it) on Budgets. `TransactionsClient`
  is built around a server-rendered route: filters are real navigations, `currentQuery`, `page`,
  `groups`, `splits`, `loanLinks` and nine more props come from `page.tsx`, and the row menu's
  actions revalidate that route. Mounting it needs a second data load with pagination and every
  prop; copying it is the drift the coordinator ruled out. The shared instance IS the page.
- **A link only** (a button that opens Transactions pre-filtered). It keeps the round trip the
  owner wants gone; the breadcrumb would make it shorter, not absent. Kept as the path for the rare
  actions.
- **An inline auto-save select per row**, the Transactions control. Phone width, no room for the
  rule choice, and the control the v1.12.1 defect was about. The `ListRow` trailing slot holds the
  kebab instead.
- **Storing `matched_rule_id` on `transactions`.** A migration, and a stored id goes stale the
  moment a rule is edited or deleted, contradicting the Affects column that re-simulates. The
  simulation is the one definition and already exists.
- **Retargeting the filing `contains` rule from the card.** A dialog about one row would rewrite a
  household-wide rule for every merchant it matches, the principle `rule-authoring-intent` guards;
  and `saveRuleAction` is admin-only. The teach path writes the exact rule for this merchant text,
  which wins by specificity, and the Rules page link is where the wider rule is changed.
- **A budgets-side server action** wrapping `confirmCategory` and `setTransactionSplits`. A second
  copy of every guard; rejected for the reason in §2.2.
- **Optimistic removal** of the fixed row. The figure comes from the server; one refetch keeps one
  source of truth.
- **`?back=<url>` for the breadcrumb.** An open-redirect-shaped parameter for a value the page can
  derive.
- **Reusing `spending=1`** for Open in Transactions. It is money out only, so a categorized refund
  the card nets in would be missing from the list; a link that lists a different set than its
  figure is worse than no link (the `transactionsHref` docblock's own rule).

## 4. Out of scope

Person, note, transfer, recurring mark, loan link, receipt and rename from the card (one row on
Transactions does them); bulk actions on the card; undo; a rollup link on a parent card (its
breakdown rows each have their own); changing Transactions' inline select; a category chip keeping
`exact=1` when it names another category (a pre-existing quirk, recorded as a follow-up);
revalidating Dashboard or Reports after a recategorize.

## 5. Process

One plan (docs/superpowers/plans/2026-10-21-fix-from-budgets.md). Lean, the owner's standing rule
for small changes: Sonnet implementers, one per task, touched test files only while working; ONE
Opus review after the last feature task, focused on what changes money figures or categories
(recategorize from the card, the rule-change offers, split totals, revalidation and refetch, the
`spend=1` set); one full gate at release.
