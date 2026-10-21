# Fix a misfiled row from the Budgets card — Implementation Plan (v1.57.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A row in a Budgets card's transaction panel gets a menu with **Change category…**, **Split…** (or **Edit split…**) and **More in Transactions**; the first two open the dialogs Transactions already uses, post the same server actions, and the card's figure and list update in place. A row a rule filed says which rule, and changing its category offers to change this transaction only, to also file the merchant that way from now on, or to always ask about the merchant. Every panel links to the exact rows it sums on Transactions, which shows **← Back to Budgets** to the same month, scope and card. The filter form stops dropping `exact=1`. One flagged, droppable task sends Not categorized yet's Categorize to the review queue when the queue shows the same rows.

**Architecture:** Three client components under `src/components/transactions/` — `SplitDialog` and `AlwaysAskDialog` moved out of `transactions-client.tsx` byte-for-byte, and a new `RecategorizeDialog` (`CategoryCombobox` plus the rule choice) — used by both pages, which post the same `setCategoryAction`, `saveSplitsAction` and Always ask actions (imported by relative specifier, the shared-form precedent). No new rule writer and no migration: `categoryRuleThatFiled` (engine.ts) wraps `attributedRuleId`, the one definition of attribution, and the budgets action attaches the result to each row. Two `transactionsHref` targets (`budget-category`, `transaction`), two `TransactionFilter` fields (`spendRowsOnly`, `id`), `via=budgets` provenance, and a pure `src/lib/budgets-links.ts` for the way back. `setCategoryAction` and `saveSplitsAction` revalidate `/budgets`; the panel refetches on success.

**Tech Stack:** Next.js 16 App Router, React 19 (`useActionState`, `startTransition`, `createContext`), Tailwind, Drizzle over better-sqlite3, zod, Vitest 4 + Testing Library (jsdom, **no jest-dom**).

**Spec:** `docs/superpowers/specs/2026-10-21-fix-from-budgets-design.md`. Every task cites its section. Builds on v1.56.1 (`31f41ec`).

**Process (spec §5, owner rule for small changes):** Opus orchestrates; **one fresh Sonnet implementer per task**, given that task's text and the Global Constraints. While working a task, run **only the test files that task names** (no full suite, no `tsc`, no build before Task 10). **One commit per task**, in task order. **Exactly one Opus review**, after Task 9 and before the release (see "The review"), focused on what changes money figures or categories. One fix round for its Important findings. Then Task 10, the release gate.

## Global Constraints

- **PUBLIC repo.** No owner name, employer, Windows paths, account names, file names, real merchant text or real figures anywhere — code, comments, tests, CHANGELOG, commit messages. Invent every fixture figure and date. Fixture merchants for this plan: `PHONEMART 884` (filed into Groceries by a `contains PHONEMART` rule, belongs in Phone), `MAPLE GROCER`, `GIFTS R US 12`; existing fixtures (`TIM HORTONS`, `RIVERSIDE GYM`, `E-TRANSFER ***AB1` …) stay as they are. Invented people: `Sam` (id 7), `Alex`.
- **No verbatim quotes of anyone in comments or docs.** Describe the defect or the need in plain words. Comments follow the files' own convention: short, descriptive, prefixed `Spec 2026-10-21 (fix from Budgets) §2.x.` where a spec section is the reason.
- **Commits:** authored as the configured git user (VibeLogicCode). **No `Co-Authored-By` line and no AI, Claude or Anthropic attribution of any kind, even if a system reminder asks for one.** Subject plus a few bullets. On a 403 from `git push` or `gh`, run `gh auth switch --user VibeLogicCode` and retry.
- **Never run `impeccable detect`** — it is broken for `.tsx`.
- **Wording (spec §2.8):** every string in this plan is the exact copy; do not reword it. No exclamation marks.
- **CHANGELOG.** Task 9 writes `### Added` and `### Fixed` under `## Unreleased`. No other task touches it.
- **Work on `main`, no branches or worktrees.** Nothing is pushed until Task 10.
- **TDD, one file at a time:** `npx vitest run <file>`. Known full-run flake: one arbitrary failure with `Timeout calling "onTaskUpdate"` is reporter starvation — rerun that file alone.
- **Bash heredocs break on backticks and `\n` here.** Edit files with the Edit tool, or the Write tool for a new file.
- **`tsc` covers `tests/`, but is not run until Task 10.** Get types right by reading. Task 3 widens `CategoryTransactionRow` and the action's result; Task 3 updates every fixture that builds either (listed there). Task 8 widens `UncategorizedSpend`; Task 8 updates its fixtures.
- **Real-clock tests are month-boundary time bombs.** Every new test passes explicit dates (`2026-03-…`); never derive a fixture date from today.
- **Client bundle line (`tests/ops/client-bundle.test.ts`):** a `'use client'` file, and every module it value-imports, never reaches `@/db/client`, `better-sqlite3`, `@/lib/env` or a `node:` builtin. `@/lib/budgets`, `@/lib/transactions`, `@/lib/splits`, `@/lib/categorize/rules`, `@/lib/categorize/engine` are **`import type` only** in any client file. A `'use server'` actions module is imported by a **relative specifier** (`'../transactions/actions'` from `budgets-client.tsx`; `'../../app/(app)/transactions/actions'` from `src/components/transactions/*`), with the one-line comment `QuickAddTransaction.tsx:8-10` carries. `@/lib/category-order`, `@/lib/transaction-links`, `@/lib/budgets-links`, `@/lib/dates`, `@/lib/money`, `@/lib/categorize/normalize`, `@/components/**` are client-safe.
- **`'use server'` files export only async functions** (types are erased and fine) — `tests/ops/use-server-exports.test.ts`. Every server action's first statement is its file's origin check — `tests/ops/server-action-origin.test.ts`. No new `'use server'` file is created.
- **Guards the new code meets, and what they want:** `rule-authoring-intent` (no file outside its allow-list calls a rule-authoring helper; every `confirmCategory(` call names `createRule:`; a new engine export that calls none is fine), `rule-attribution-honesty` (no `normalizedMerchant === rule.pattern` in engine.ts — resolve through `attributedRuleId`), `transactions-href` (build every `/transactions?` link with `transactionsHref`; a `/budgets?` or `/settings/merchant-rules?` link is not scanned), `spend-where` (compose `SPEND_ROW_WHERE`, never a bare `eq(transactions.isTransfer, false)`), `visibility-invariants` (no new viewer-taking reader; `categoryTransactions` and `uncategorizedSpend` are already listed), `row-controls` (no form under `src/app` with one `<select>`, only hidden inputs and a submit — the new dialogs live under `src/components/` and carry a combobox input or a radio), `button-vocabulary` (`buttonClass`, never `className="btn …"`), `type-scale` (no arbitrary `text-[…]`), `reduced-motion` (no new `animate-*`), `onboarding-coverage` (no new NAV entry, no new `<EmptyState`), `th-scope`/`table-layout`/`title-only-info` (no new table).

## Review Focus

Inputs most likely to bite a household that no single obvious test would catch; each names the test that pins it.

1. **"Also file this way" on a merchant whose exact rule another member owns.** `confirmCategory` refuses (`owned_by_another`) BEFORE any write; the panel must show `ruleOwnedError`'s sentence and the row must stay where it was. Task 5 (`'a refusal from the action is shown in the panel and nothing moves'`).
2. **A split row on the card.** Change category must never be offered (the action would refuse with the split sentence), and Edit split must open with the WHOLE transaction's amount and ALL its parts, not the part the card listed. Task 4 (`'a split part offers Edit split with the whole amount and every part, never Change category'`).
3. **Open in Transactions must list the rows the card summed.** A categorized refund stays (the card nets it in); a transfer and a loan-principal row carrying the category go. Task 6 (`'spendRowsOnly keeps a categorized refund and drops a transfer and a loan principal row'`).
4. **The way back after the person changes the range on Transactions.** The breadcrumb must not send them to a stale month; with `from` and `to` in different months it carries no month. Task 7 (`'carries no month once the range no longer sits in one month'`).
5. **A self-scoped viewer on the card.** No rule choice, no Always ask, no Rules link, whatever the row's source; the actions refuse them regardless. Task 5 (`'a self viewer gets no rule choice, and an admin gets the Rules page link'`).

## Decisions this plan makes where the code and the spec meet

1. **Who owns the action state.** `SplitDialog` and `RecategorizeDialog` take the caller's `useActionState` dispatcher as `action` and close on submit; the caller reads the result (Transactions in its banner chains, the panel in its status line). `AlwaysAskDialog` owns its three states because its result is shown inside it; it reports a send-back through `onSent`.
2. **Page-wide facts through one context.** `budgets-client.tsx` gets `BudgetsPageContext` (`categories`, `canAuthorRules`, `isAdmin`) provided by `BudgetsClient` and read by `CategoryTransactionsPanel`, instead of threading three props through `BudgetSectionBody`, `BudgetCategoryCard`, `ChildBreakdownRow` and `DirectSpendRow`. `canAuthorRules` is `household !== null` (ruling R2's own gate: null exactly for a self-scoped viewer).
3. **`filedBy` is resolved in the action, not the lib.** `categoryTransactions` stays a column read (four new columns); `categoryTransactionsAction` builds one `CategorizeContext` and one `listRules('always_ask')` per request and decorates the rows. `FiledByRule`, `CategoryPanelRow` and `CategoryPanelResult` are declared in the action file (interfaces are erased, as `AlwaysAskState` already is in `transactions/actions.ts`).
4. **The row key.** A split transaction with two parts in one category produced two panel rows with one key; rows are keyed `${row.id}:${row.splitId ?? 0}`.
5. **The panel's link is exact and spend-only.** `{ kind: 'budget-category', categoryId }` writes `category=<id>&exact=1&spend=1&via=budgets`; `spend=1` is `TransactionFilter.spendRowsOnly`, `SPEND_ROW_WHERE` composed in `buildWhere`. `{ kind: 'transaction', transactionId, via?: 'budgets' }` writes `id=<n>` and `via=budgets` when asked, no range, no person.
6. **The way back is derived.** `budgetsHref` takes `{ month, personId, cardId }`, each nullable, and writes only what it is given. Transactions derives month from `from` only when `from.slice(0, 7) === to.slice(0, 7)`, person from `person`, and the card from the category's top-level ancestor (`parentId ?? id`) over its `categories` prop; `scope` is `'personal'` when a person is present, else `'household'`.
7. **Opening on the hash.** `BudgetCategoryCard` reads `window.location.hash` once after mount; when it equals `#${budgetCardId(scope, userId, row.categoryId)}` a leaf sets `leafTxOpen`, a parent calls `groupState.toggle` if `!groupState.isOpen`. Nothing reopens a child row's own panel.
8. **Revalidation.** `setCategoryAction` and `saveSplitsAction` add `revalidatePath('/budgets')` after their existing two. Nothing else is added.
9. **Refetch.** `CategoryTransactionsPanel` keeps `version` state; the fetch effect's dependency list gains it; an effect per action state bumps it when `state.message && !state.error`; `onSent` bumps it too. The newest message renders in `<p role="status">`, the newest error in `<p role="alert">`, above the list.
10. **The `exact` fix.** `categoryChoice` state seeded from `formDefaults.category` and updated by the Category select's `onChange`; the hidden `exact=1` renders while `exactActive && categoryChoice === formDefaults.category`.
11. **Who gets the rule choice.** Rows whose `source` is `rule` or `bayes`, for `canAuthorRules` viewers; option 3 is hidden when `alwaysAsked`. A `manual` or `none` row gets the combobox alone.
12. **Task 8's condition is two counts.** `queueShowsSameRows = hidden === 0 && extra === 0`: `hidden` counts the card's rows that carry a `loan_payments` link (the clause `REVIEW_WHERE` excludes them by); `extra` counts rows in the month and scope matching `REVIEW_WHERE`, `UNCATEGORIZED_WHERE` and `amount_cents > 0`. Both reuse the function's own month and person clauses.
13. **Row menu label** mirrors Transactions': `Actions for ${merchant} on ${date}, ${formatCents(amountCents)}`.
14. **MetricCard gains `id?: string`**, set on its `<article>`; nothing else changes there.
15. **The Rules page link** is `/settings/merchant-rules?kind=category&q=${encodeURIComponent(pattern)}`, the shape the bank-text dialog already builds (`transactions-client.tsx:2206`).

---

## File map

| Area | Files |
|---|---|
| Shared dialogs (1, 2, 4) | `src/components/transactions/SplitDialog.tsx` (new), `AlwaysAskDialog.tsx` (new), `RecategorizeDialog.tsx` (new), `src/app/(app)/transactions/transactions-client.tsx` |
| Data (3) | `src/lib/budgets.ts`, `src/lib/categorize/engine.ts`, `src/app/(app)/budgets/category-transactions-action.ts`, `src/app/(app)/transactions/actions.ts`, `src/app/(app)/budgets/page.tsx` |
| The card (4, 5, 7) | `src/app/(app)/budgets/budgets-client.tsx`, `src/components/ui/MetricCard.tsx` |
| Links (6, 7, 8) | `src/lib/transaction-links.ts`, `src/lib/budgets-links.ts` (new), `src/lib/transactions.ts`, `src/app/(app)/transactions/filter-params.ts`, `transactions-client.tsx` |
| Open decision (8) | `src/lib/budgets.ts`, `src/lib/transaction-links.ts`, `budgets-client.tsx` |
| Help, release (9, 10) | `src/app/(app)/help/content.tsx`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `tests/ops/docker.test.ts` |

---

### Task 1: Extract the split editor into `SplitDialog` (spec §2.2)

**Files:**
- Create: `src/components/transactions/SplitDialog.tsx`
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (`SplitPartDraft`/`blankSplitPart` :114-123, `splitting` state :572-582, `openSplitEditor` and the draft helpers :1148-1197, the dialog :3276-3357)
- Test: `tests/components/split-dialog.test.tsx` (new), `tests/app/transactions-client.test.tsx` (pins)

**Interfaces:**
- Produces (`src/components/transactions/SplitDialog.tsx`, `'use client'`):
  ```ts
  export interface SplitTarget { id: number; merchant: string; date: string; amountCents: number }
  export function SplitDialog(props: {
    target: SplitTarget;
    /** Existing parts; [] opens two blank parts. */
    existing: SplitRow[];
    /** categoryOptions(categories): live categories only. */
    options: CategoryOption[];
    /** The caller's useActionState dispatcher for saveSplitsAction; the caller reads the result. */
    action: (formData: FormData) => void;
    onClose: () => void;
  }): React.ReactElement
  ```
  `SplitRow` is `import type` from `@/lib/splits`; `CategoryOption` from `@/lib/category-order`. The dialog keeps `dialogId="split-dialog"`, the title `Split ${target.merchant}`, the description, the hidden `txnId` and `parts` fields, the part rows (`CategoryCombobox` with `includeUncategorized={false}` and `placeholder="Choose a category"`, the amount and note inputs, `Remove part`), `Add a part`, `Remaining to assign: …`, `Save split` disabled until the remainder is zero, and the second form's `Remove split` — the JSX at `:3277-3356` moved whole. The draft state (`SplitPartDraft`, `blankSplitPart`, `updateSplitPart`, `addSplitPart`, `removeSplitPart`, the sign rule, `splitPartsPayload`, `splitRemainderCents`) moves with it; the draft is seeded from `existing` exactly as `openSplitEditor` seeds it today.

**Pins (pass before and after; do not edit):** `tests/app/transactions-client.test.tsx` `describe('Split editor (v1.7.0 Task 4)')` (5 tests, `:532-676`) and `describe('Split editor is a modal dialog, not a card at the top of the page (item 1)')` (8 tests, `:677-800`).

- [ ] **Step 1: Write the failing component test**

Create `tests/components/split-dialog.test.tsx` (`// @vitest-environment jsdom`, `cleanup` after each). Options fixture: `[{ id: 1, label: 'Groceries', depth: 0 }, { id: 2, label: 'Phone', depth: 0 }]`; target `{ id: 77, merchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217 }`.

```tsx
describe('SplitDialog', () => {
  it('posts the whole transaction id and the parts it was given through the action handed to it, then closes', () => {
    const action = vi.fn();
    const onClose = vi.fn();
    render(
      <SplitDialog
        target={{ id: 77, merchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217 }}
        existing={[
          { id: 501, txnId: 77, categoryId: 1, amountCents: -2000, note: null },
          { id: 502, txnId: 77, categoryId: 2, amountCents: -2217, note: 'the case' },
        ]}
        options={OPTIONS}
        action={action}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Split PHONEMART 884' })).toBeTruthy();
    expect(screen.getByText('Remaining to assign: $0.00')).toBeTruthy();
    const form = screen.getByRole('button', { name: 'Save split' }).closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(onClose).toHaveBeenCalled();
    const data = new FormData(form);
    expect(data.get('txnId')).toBe('77');
    expect(JSON.parse(String(data.get('parts')))).toEqual([
      { categoryId: 1, amountCents: -2000, note: null },
      { categoryId: 2, amountCents: -2217, note: 'the case' },
    ]);
  });

  it('opens two blank parts for an unsplit row and keeps Save disabled until the parts add up', () => {
    render(<SplitDialog target={{ id: 78, merchant: 'MAPLE GROCER', date: '2026-03-14', amountCents: -5000 }} existing={[]} options={OPTIONS} action={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Save split' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

(`fireEvent.submit` on a React 19 `<form action={fn}>` calls the dispatcher with the form's data in jsdom; the `onSubmit` closes. If the environment does not invoke the action on `submit`, assert on `new FormData(form)` only, as above — the assertions are about what the form holds.)

Fails before / passes after: the module does not exist.

- [ ] **Step 2: Run the new test and the pins to see the state**

Run: `npx vitest run tests/components/split-dialog.test.tsx tests/app/transactions-client.test.tsx`
Expected: the new file FAILS (module not found); the 13 pins PASS.

- [ ] **Step 3: Create `SplitDialog` and repoint Transactions**

Move, do not rewrite. In `transactions-client.tsx`: `splitting` becomes `useState<SplitTarget | null>(null)`; `openSplitEditor(row)` sets `{ id: row.id, merchant: row.normalizedMerchant, date: row.date, amountCents: row.amountCents }` (the `existing` seeding moves into the dialog, read from `splits[splitting.id] ?? []` at the call site); the dialog block at `:3276-3357` becomes

```tsx
{splitting ? (
  <SplitDialog key={splitting.id} target={splitting} existing={splits[splitting.id] ?? []} options={groupedCategories} action={splitAction} onClose={() => setSplitting(null)} />
) : null}
```

Delete `SplitPartDraft`, `blankSplitPart`, `updateSplitPart`, `addSplitPart`, `removeSplitPart`, `splitSign`, `draftPartCents`, `activeSplitParts`, `splitPartsPayload` and `splitRemainderCents` from the page. Keep `parseAmountToCents`/`sumCents` imported only if another use remains in the file (search before removing). The dialog's docblock: the "Unify-the-editors" paragraph the block carried, plus one line: spec 2026-10-21 (fix from Budgets) §2.2, shared with the Budgets card.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/split-dialog.test.tsx tests/app/transactions-client.test.tsx tests/ops/client-bundle.test.ts tests/ops/row-controls.test.ts tests/ops/button-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/transactions/SplitDialog.tsx "src/app/(app)/transactions/transactions-client.tsx" tests/components/split-dialog.test.tsx
git commit -m "refactor(transactions): the split editor is a shared SplitDialog

- form, draft parts and remainder maths moved whole
- Transactions passes its dispatcher; behaviour pinned by the existing tests"
```

---

### Task 2: Extract the Always ask dialog into `AlwaysAskDialog` (spec §2.2)

**Files:**
- Create: `src/components/transactions/AlwaysAskDialog.tsx`
- Modify: `transactions-client.tsx` (`askRow` :643, the three `useActionState` :710-712, the effects :1100-1130, the menu item :1517-1523, `alwaysAskDialog()` :1837-1906 and its render :3366, the banner chains :1048 and :1057)
- Test: `tests/components/always-ask-dialog.test.tsx` (new), `tests/app/transactions-client.test.tsx` (pins)

**Interfaces:**
- Produces (`'use client'`):
  ```ts
  export function AlwaysAskDialog(props: {
    /** normalizedMerchant; the pattern starts at alwaysAskPattern(merchant), Contains. */
    merchant: string;
    onClose: () => void;
    /** Rows went back to review: the caller refreshes what it lists. Called before onClose. */
    onSent?: () => void;
  }): React.ReactElement
  ```
  Imports `previewAlwaysAskAction`, `setAlwaysAskAction`, `sendBackToReviewAction`, `type AlwaysAskState` from `'../../app/(app)/transactions/actions'` (relative; the `RecurringMarkForm.tsx:6-8` comment). Owns `{ pattern, matchType, saved }`, the three `useActionState`s, the 300 ms preview effect, the saved flip and the close-on-sent effect (which calls `onSent?.()` then `onClose()`). `dialogId="always-ask-dialog"`, `data-testid="always-ask-form"` and `"always-ask-count"`, and every string stay as they are.

**Pins:** `tests/app/transactions-client.test.tsx` `describe('TransactionsClient — Always ask for rows like this')` (5 tests, `:4764-4831`).

- [ ] **Step 1: Write the failing component test**

Create `tests/components/always-ask-dialog.test.tsx` (jsdom; mock `'@/app/(app)/transactions/actions'` with `previewAlwaysAskAction: vi.fn(async () => ({ message: 'Matches 3 transactions.' }))`, `setAlwaysAskAction: vi.fn(async () => ({ message: 'Rows matching "PHONEMART" will always be asked about.', ruleId: 41, sendBackCount: 2 }))`, `sendBackToReviewAction: vi.fn(async () => ({ message: 'Sent 2 transactions back to review.' }))`):

```tsx
it('starts from the merchant minus its code, saves, offers Send back, then reports the send and closes', async () => {
  const onSent = vi.fn();
  const onClose = vi.fn();
  render(<AlwaysAskDialog merchant="PHONEMART ***884" onClose={onClose} onSent={onSent} />);
  expect((screen.getByLabelText('Text to match') as HTMLInputElement).value).toBe('PHONEMART');
  expect(await screen.findByTestId('always-ask-count')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Always ask' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send 2 back to review' }));
  await waitFor(() => expect(onSent).toHaveBeenCalled());
  expect(onClose).toHaveBeenCalled();
});
```

(`alwaysAskPattern('PHONEMART ***884')` is `PHONEMART`: a run of two or more asterisks plus a code at the end is removed.)

- [ ] **Step 2: Run to verify it fails and the pins pass**

Run: `npx vitest run tests/components/always-ask-dialog.test.tsx tests/app/transactions-client.test.tsx`
Expected: new file FAILS (module not found); pins PASS.

- [ ] **Step 3: Create the dialog and repoint Transactions**

`askRow` becomes `useState<{ id: number; merchant: string } | null>(null)`; the menu item at `:1517-1523` sets `{ id: row.id, merchant: row.normalizedMerchant }` (its gating is unchanged); `alwaysAskDialog()` and the three effects are deleted; render `{askRow ? <AlwaysAskDialog key={askRow.id} merchant={askRow.merchant} onClose={() => setAskRow(null)} /> : null}` where `{alwaysAskDialog()}` was. Remove `askPreviewState`/`askSave`/`sendBackState` and their imports (`previewAlwaysAskAction`, `setAlwaysAskAction`, `sendBackToReviewAction`, `AlwaysAskState`, `alwaysAskPattern`) from the page when no other use remains; drop `sendBackState.message`/`.error` from the banner chains at `:1048`/`:1057`. `startTransition` stays only if another use remains.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/always-ask-dialog.test.tsx tests/app/transactions-client.test.tsx tests/ops/client-bundle.test.ts tests/ops/rule-authoring-intent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/transactions/AlwaysAskDialog.tsx "src/app/(app)/transactions/transactions-client.tsx" tests/components/always-ask-dialog.test.tsx
git commit -m "refactor(transactions): the Always ask dialog is a shared AlwaysAskDialog

- owns its pattern, live count, save and send-back states
- onSent lets a caller refresh what it lists"
```

---

### Task 3: The data behind the card (spec §2.3, §2.5)

**Files:**
- Modify: `src/lib/budgets.ts` (`CategoryTransactionRow` :215-220, the select :276-287)
- Modify: `src/lib/categorize/engine.ts` (new export after `attributedRuleId`'s helpers, i.e. after `withArchivedRulesVisible` :583)
- Modify: `src/app/(app)/budgets/category-transactions-action.ts`
- Modify: `src/app/(app)/transactions/actions.ts` (`setCategoryAction` :298-299, `saveSplitsAction` :1296-1297)
- Modify: `src/app/(app)/budgets/page.tsx` (one import, one prop), `budgets-client.tsx` (one prop, one context)
- Modify fixtures: `tests/app/budgets-client.test.tsx:28`, `tests/app/budgets-rollover-ui.test.tsx:34` (the mock returns `{ rows: [], splits: {} }`)
- Test: `tests/lib/budgets.test.ts`, `tests/lib/categorize/engine.test.ts`, `tests/app/budgets-actions.test.ts`, `tests/app/transactions-actions.test.ts`, `tests/app/transactions-splits-action.test.ts`

**Interfaces:**
- Produces (`src/lib/budgets.ts`): `CategoryTransactionRow` gains
  ```ts
  /** The text rules match on: names the filing rule and prefills Always ask. */
  normalizedMerchant: string;
  /** The transaction's own source; 'rule' is what the card calls out. A split part's parent is always 'manual'. */
  source: 'rule' | 'bayes' | 'manual' | 'none';
  /** transaction_splits.id for a part, null for an unsplit row. A part's parts are its categorization: the card offers Edit split, not Change category. */
  splitId: number | null;
  /** The whole transaction's amount, what a split divides. Equals amountCents on an unsplit row. */
  parentAmountCents: number;
  ```
  Selected as `transactions.normalizedMerchant`, `transactions.categorizationSource`, `transactionSplits.id`, `transactions.amountCents`.
- Produces (`src/lib/categorize/engine.ts`):
  ```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.3. The category rule that filed a row, by the one definition the Rules page's Affects column uses (attributedRuleId), or null: not a rule-filed row, or no current rule accounts for its category (edited, deleted or shadowed since). Never names a rule it cannot stand behind. */
  export function categoryRuleThatFiled(
    row: { normalizedMerchant: string; amountCents: number | null; categoryId: number | null; source: 'rule' | 'bayes' | 'manual' | 'none' },
    ctx: CategorizeContext = buildContext(),
  ): MerchantRuleRecord | null
  ```
  Body: return null unless `source === 'rule'` and `categoryId !== null`; `const id = attributedRuleId(row.normalizedMerchant, row.amountCents, 'category', ctx, row.categoryId)`; the rule from `ctx.rules` whose id matches, returned only when `rule.categoryId === row.categoryId`.
- Produces (`category-transactions-action.ts`):
  ```ts
  export interface FiledByRule { ruleId: number; pattern: string; matchType: MatchType }
  export interface CategoryPanelRow extends CategoryTransactionRow {
    filedBy: FiledByRule | null;
    /** An enabled Always ask rule already covers the merchant (alwaysAskRuleFor). */
    alwaysAsked: boolean;
  }
  export interface CategoryPanelResult { rows: CategoryPanelRow[]; splits: Record<number, SplitRow[]> }
  export async function categoryTransactionsAction(input): Promise<CategoryPanelResult | { error: string }>
  ```
  After `categoryTransactions(...)`: `const ctx = buildContext(); const askRules = listRules('always_ask');` then per row `filedBy` from `categoryRuleThatFiled({ normalizedMerchant, amountCents: parentAmountCents, categoryId: input.categoryId, source }, ctx)` mapped to `{ ruleId: rule.id, pattern: rule.pattern, matchType: rule.matchType }`, and `alwaysAsked: alwaysAskRuleFor(normalizedMerchant, askRules) !== null`; `splits` from `splitsForTransactions(ids of rows with splitId !== null)` (`@/lib/splits`), as a plain object.
- Produces (`transactions/actions.ts`): `setCategoryAction` and `saveSplitsAction` each call `revalidatePath('/budgets')` after their existing revalidations, with the comment `Spec 2026-10-21 (fix from Budgets) §2.5: the card a fixed row sat on re-renders in place.`
- Produces (`budgets-client.tsx`): `BudgetsClient` gains `categories?: CategoryLike[]` (default `[]`, `import type { CategoryLike } from '@/lib/category-order'`); `const BudgetsPageContext = createContext<{ categories: CategoryLike[]; canAuthorRules: boolean; isAdmin: boolean }>({ categories: [], canAuthorRules: false, isAdmin: false })` provided around the root `<div>` with `{ categories, canAuthorRules: household !== null, isAdmin: currentUserIsAdmin }`. `page.tsx` passes `categories={listCategories()}` (`@/lib/categories`, live only). The panel reads the context in Task 4.

- [ ] **Step 1: Write the failing lib tests**

`tests/lib/budgets.test.ts`, inside `describe('categoryTransactions — the Lane 1 breakdown drill-down')`:

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.3: what the card needs to offer a fix and name the rule. */
  it('carries the merchant text, the source, the whole transaction amount and the split part id', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const plain = spend({ categoryId: groceries, amountCents: -4217, date: '2026-03-12' });
    const split = spend({ categoryId: groceries, amountCents: -10000, date: '2026-03-05' });
    setTransactionSplits({ txnId: split, parts: [{ categoryId: groceries, amountCents: -6000 }, { categoryId: coffee, amountCents: -4000 }], userId: alice });
    const rows = categoryTransactions('2026-03', groceries, {}, HOUSEHOLD_VIEWER);
    expect(rows.map((r) => [r.id, r.amountCents, r.parentAmountCents, r.source, r.splitId === null])).toEqual([
      [plain, -4217, -4217, 'none', true],
      [split, -6000, -10000, 'manual', false],
    ]);
    expect(rows[0].normalizedMerchant).toBe('X');
  });
```

(`spend()` writes `categorization_source 'none'`; `setTransactionSplits` stamps the parent `manual`.)

`tests/lib/categorize/engine.test.ts`, a new describe using the file's `createSeededTestDb`/`insertTestUser`/`insertTestAccount` idiom and a row inserted like `rule-attribution-honesty.test.ts:128-134` does:

```ts
describe('categoryRuleThatFiled (spec 2026-10-21, fix from Budgets §2.3)', () => {
  it('names the contains rule that filed the row, and the exact rule when that is the winner', () => {
    // seed: a 'PHONEMART 884' row; a contains PHONEMART → Coffee rule; runEngine([id]); expect categoryRuleThatFiled(row) to be that rule.
    // then upsert an exact 'PHONEMART 884' → Groceries rule, runEngine again; expect the exact rule (longer pattern wins).
  });
  it('says nothing for a guess, a hand pick, or a rule-filed row whose rule has since changed', () => {
    // source 'bayes' and 'manual' rows → null (whatever rules exist);
    // a rule-filed Coffee row after the rule is retargeted to Groceries → null (the winner's category is not the row's);
    // after deleteRule → null.
  });
  it('credits a rule whose category was archived after it filed the row', () => {
    // mirror tests/ops/rule-attribution-honesty.test.ts:519-538: runEngine, archiveCategory(coffee, true); expect the rule.
  });
});
```

Write the three with real assertions (`expect(result?.id).toBe(ruleId)`, `toBeNull()`); the comments above say which fixture each needs.

- [ ] **Step 2: Write the failing action tests**

`tests/app/budgets-actions.test.ts`, inside the `categoryTransactionsAction` describe. First widen `seedWithTransactions()`'s `spend` (`:81-86`): it gains optional `categoryId` (default `base.groceries`) and `source` (default `'manual'`) and returns the inserted id (`base.db.get<{ id: number }>(sql\`… returning id\`).id`); its existing callers ignore the return and pass neither, so they are unchanged. Add `runEngine` (`@/lib/categorize/engine`), `upsertRuleFromCorrection`, `setAlwaysAskRule` (`@/lib/categorize/rules`) and `setTransactionSplits` (`@/lib/splits`) to the imports.

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.3. */
  it("names the rule that filed a row, flags an Always ask merchant, and returns a split row's parts", async () => {
    const { db, alice, groceries, spend } = seedWithTransactions();
    const ruled = spend({ attributedUserId: null, amountCents: -4217, merchant: 'PHONEMART 884', categoryId: null, source: 'none' });
    const asked = spend({ attributedUserId: null, amountCents: -1500, merchant: 'GIFTS R US 12' });
    const split = spend({ attributedUserId: null, amountCents: -10000, merchant: 'MAPLE GROCER' });
    const rule = upsertRuleFromCorrection({ pattern: 'PHONEMART', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: alice, actorRole: 'admin' });
    if (!rule.ok) throw new Error('unexpected refusal');
    runEngine([ruled]);
    setAlwaysAskRule({ pattern: 'GIFTS R US', matchType: 'contains', userId: alice, actorRole: 'admin' });
    setTransactionSplits({ txnId: split, parts: [{ categoryId: groceries, amountCents: -6000 }, { categoryId: categoryIdByName(db, 'Coffee'), amountCents: -4000 }], userId: alice });
    const result = await categoryTransactionsAction({ scope: 'household', userId: null, month: '2026-03', categoryId: groceries });
    if ('error' in result) throw new Error(result.error);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get(ruled)?.filedBy).toEqual({ ruleId: rule.ruleId, pattern: 'PHONEMART', matchType: 'contains' });
    expect(byId.get(asked)).toMatchObject({ filedBy: null, alwaysAsked: true });
    expect(byId.get(split)).toMatchObject({ filedBy: null, splitId: expect.any(Number), parentAmountCents: -10000 });
    expect(result.splits[split]?.map((part) => part.amountCents)).toEqual([-6000, -4000]);
  });
```

(The fixture writes `normalized_merchant` equal to `merchant`, so the pattern `PHONEMART` matches `PHONEMART 884` as a `contains` rule.)

`tests/app/transactions-actions.test.ts`, inside `describe("setCategoryAction: ruling R3 …")`:

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.5: the Budgets card a fixed row sat on re-renders in place. */
  it('revalidates /budgets after a category change', async () => {
    // seed one row as the describe's other tests do; post setCategoryAction with a category; then
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith('/budgets');
  });
```

`tests/app/transactions-splits-action.test.ts`, inside `describe('saveSplitsAction')`: the same assertion after the happy-path post (add the `next/cache` mock the way `transactions-actions.test.ts:46-49` has it, if the file lacks one).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/budgets.test.ts tests/lib/categorize/engine.test.ts tests/app/budgets-actions.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-splits-action.test.ts`
Expected: FAIL — missing fields, `categoryRuleThatFiled is not a function`, `filedBy` undefined, `/budgets` never revalidated.

- [ ] **Step 4: Implement**

`budgets.ts`: the four fields and the four selected columns (the `leftJoin(transactionSplits…)` is already there; `transactionSplits.id` is null on an unsplit row). `engine.ts`: `categoryRuleThatFiled` as in Interfaces. The action: as in Interfaces (`buildContext`, `listRules`, `alwaysAskRuleFor` from `@/lib/categorize/rules`; `splitsForTransactions` from `@/lib/splits`; `type MatchType`). `actions.ts`: the two revalidations. `page.tsx` and `budgets-client.tsx`: the `categories` prop and the context (provided, not yet read). Update the two fixture mocks to `{ rows: [], splits: {} }`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/lib/budgets.test.ts tests/lib/categorize/engine.test.ts tests/app/budgets-actions.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-splits-action.test.ts tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx tests/app/budgets-page.test.tsx tests/ops/rule-authoring-intent.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/use-server-exports.test.ts tests/ops/visibility-invariants.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/budgets.ts src/lib/categorize/engine.ts "src/app/(app)/budgets/category-transactions-action.ts" "src/app/(app)/transactions/actions.ts" "src/app/(app)/budgets/page.tsx" "src/app/(app)/budgets/budgets-client.tsx" tests/lib/budgets.test.ts tests/lib/categorize/engine.test.ts tests/app/budgets-actions.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-splits-action.test.ts tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx
git commit -m "feat(budgets): the card's rows carry their source, the rule that filed them and their parts

- categoryRuleThatFiled resolves through attributedRuleId, never a stored id
- setCategoryAction and saveSplitsAction revalidate /budgets"
```

---

### Task 4: The card's row menu: Change category and Split (spec §2.1, §2.2, §2.5)

**Files:**
- Create: `src/components/transactions/RecategorizeDialog.tsx`
- Modify: `budgets-client.tsx` (`CategoryTransactionsPanel` :421-482; imports :1-50)
- Test: `tests/components/recategorize-dialog.test.tsx` (new), `tests/app/budgets-client.test.tsx`

**Interfaces:**
- Consumes: Task 1's `SplitDialog`, Task 3's `CategoryPanelRow`/`CategoryPanelResult` (`import type` from `'./category-transactions-action'`), `BudgetsPageContext`; `setCategoryAction`, `saveSplitsAction`, `type ActionState` from `'../transactions/actions'` (relative); `RowMenu`, `RowMenuButton`, `RowMenuLink` (`@/components/ui/RowMenu`); `categoryOptions` (`@/lib/category-order`).
- Produces (`RecategorizeDialog.tsx`, `'use client'`):
  ```ts
  export interface RecategorizeRow {
    id: number; merchant: string; normalizedMerchant: string; date: string; amountCents: number;
    categoryId: number | null; source: 'rule' | 'bayes' | 'manual' | 'none';
    filedBy: FiledByRule | null; alwaysAsked: boolean;
  }
  export type RuleChoice = 'keep' | 'teach' | 'ask';
  export function RecategorizeDialog(props: {
    row: RecategorizeRow;
    options: CategoryOption[];
    /** The caller's useActionState dispatcher for setCategoryAction. */
    action: (formData: FormData) => void;
    /** False for a self-scoped viewer: no rule choice at all (Task 5). */
    canAuthorRules: boolean;
    /** The Rules page link (Task 5). */
    isAdmin: boolean;
    onClose: () => void;
    /** Task 5: 'ask' was chosen and the category posted. */
    onAlwaysAsk: () => void;
  }): React.ReactElement
  ```
  This task renders: `RowDialog` `dialogId="recategorize-dialog"`, title `Category for ${row.merchant}`, description `${row.date} · ${formatCents(row.amountCents)}`; a form with hidden `transactionId`, `<CategoryCombobox name="categoryId" label="Category" options={options} value={picked} onChange={setPicked} />` seeded from `row.categoryId` (Uncategorized offered), `SubmitButton` **Save category**, a ghost **Cancel**; `onSubmit` calls `onClose()`. The rule choice is Task 5's; this task posts no `teach`.
- Produces (`budgets-client.tsx`): `CategoryTransactionsPanel` reads the context; state `version`, `recat: CategoryPanelRow | null`, `splitting: SplitTarget | null`; `const [fixState, fixAction] = useActionState(setCategoryAction, initial)`, `const [splitState, splitAction] = useActionState(saveSplitsAction, initial)`; result `splits` kept beside `rows` in the loaded state. Each row renders `ListRow` with `key={`${row.id}:${row.splitId ?? 0}`}` and `trailing={<RowMenu label={`Actions for ${row.merchant} on ${row.date}, ${formatCents(row.amountCents)}`}>…</RowMenu>}` holding **Change category…** (unsplit rows only), **Split…** (unsplit) or **Edit split…** (`splitId !== null`), and nothing else yet. Above the list: `{fixState.error ?? splitState.error ? <p role="alert" …> : null}` and `<p role="status">` with the newest message (decision 9). The dialogs render inside the panel: `{recat ? <RecategorizeDialog key={recat.id} … action={fixAction} onClose={() => setRecat(null)} onAlwaysAsk={() => {}} /> : null}` and `{splitting ? <SplitDialog key={splitting.id} target={splitting} existing={state.splits[splitting.id] ?? []} options={options} action={splitAction} onClose={() => setSplitting(null)} /> : null}` where `splitting` is built from the row as `{ id, merchant, date, amountCents: parentAmountCents }`.

- [ ] **Step 1: Write the failing component test**

`tests/components/recategorize-dialog.test.tsx` (jsdom):

```tsx
const ROW: RecategorizeRow = { id: 77, merchant: 'Phonemart', normalizedMerchant: 'PHONEMART 884', date: '2026-03-12', amountCents: -4217, categoryId: 1, source: 'rule', filedBy: { ruleId: 9, pattern: 'PHONEMART', matchType: 'contains' }, alwaysAsked: false };
const OPTIONS = [{ id: 1, label: 'Groceries', depth: 0 }, { id: 2, label: 'Phone', depth: 0 }];

it('names the row, starts at its category, posts the picked one with the row id, and closes', () => {
  const onClose = vi.fn();
  render(<RecategorizeDialog row={ROW} options={OPTIONS} action={vi.fn()} canAuthorRules={false} isAdmin={false} onClose={onClose} onAlwaysAsk={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'Category for Phonemart' })).toBeTruthy();
  const input = screen.getByRole('combobox') as HTMLInputElement;
  expect(input.value).toBe('Groceries');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'Pho' } });
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Phone' }));
  const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
  const data = new FormData(form);
  expect({ transactionId: data.get('transactionId'), categoryId: data.get('categoryId'), teach: data.get('teach') }).toEqual({ transactionId: '77', categoryId: '2', teach: null });
  fireEvent.submit(form);
  expect(onClose).toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the failing Budgets tests**

`tests/app/budgets-client.test.tsx`: add the mock

```ts
vi.mock('@/app/(app)/transactions/actions', () => ({
  setCategoryAction: vi.fn(async () => ({ message: 'Category updated.' })),
  saveSplitsAction: vi.fn(async () => ({ message: 'Split saved.' })),
  previewAlwaysAskAction: vi.fn(async () => ({ message: 'Matches 1 transaction.' })),
  setAlwaysAskAction: vi.fn(async () => ({ message: 'Rows matching "PHONEMART" will always be asked about.', ruleId: 41, sendBackCount: 0 })),
  sendBackToReviewAction: vi.fn(async () => ({})),
}));
```

and a fixture `panelRow(over: Partial<CategoryPanelRow> = {}): CategoryPanelRow` returning `{ id: 77, date: '2026-03-12', merchant: 'Phonemart', normalizedMerchant: 'PHONEMART 884', amountCents: -4217, parentAmountCents: -4217, source: 'rule', splitId: null, filedBy: { ruleId: 9, pattern: 'PHONEMART', matchType: 'contains' }, alwaysAsked: false, ...over }`, `CATEGORIES` = `[{ id: 1, name: 'Groceries', parentId: null, isArchived: false, sortOrder: 0 }, { id: 2, name: 'Phone', parentId: null, isArchived: false, sortOrder: 1 }]`, and `renderWithRows(rows, splits = {}, over = {})` that mocks `categoryTransactionsAction` once with `{ rows, splits }`, renders `BudgetsClient` with `categories={CATEGORIES}` plus `over`, and clicks **View transactions**. Then:

```tsx
/** Spec 2026-10-21 (fix from Budgets) §2.1, §2.2, §2.5: the two frequent fixes, where the row was found. */
describe('BudgetsClient — fixing a row from the card', () => {
  it('offers Change category and Split on a row, and changes the category through the Transactions action, then refetches and reports', async () => {
    const { categoryTransactionsAction } = await import('@/app/(app)/budgets/category-transactions-action');
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    renderWithRows([panelRow()]);
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    expect(screen.getByRole('menuitem', { name: 'Split…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change category…' }));
    const input = within(screen.getByRole('dialog')).getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Pho' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Phone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save category' }));
    await waitFor(() => expect(setCategoryAction).toHaveBeenCalled());
    const posted = vi.mocked(setCategoryAction).mock.calls.at(-1)![1] as FormData;
    expect({ id: posted.get('transactionId'), category: posted.get('categoryId'), teach: posted.get('teach') }).toEqual({ id: '77', category: '2', teach: null });
    // By text, not by role: the savings target control on the same page already renders a role="status" span.
    expect(await screen.findByText('Category updated.')).toBeTruthy();
    expect(vi.mocked(categoryTransactionsAction).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  /** Review Focus 2. */
  it('a split part offers Edit split with the whole amount and every part, never Change category', async () => {
    const { saveSplitsAction } = await import('@/app/(app)/transactions/actions');
    const parts = [{ id: 501, txnId: 77, categoryId: 1, amountCents: -2000, note: null }, { id: 502, txnId: 77, categoryId: 2, amountCents: -2217, note: null }];
    renderWithRows([panelRow({ amountCents: -2000, parentAmountCents: -4217, source: 'manual', splitId: 501, filedBy: null })], { 77: parts });
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    expect(screen.queryByRole('menuitem', { name: 'Change category…' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit split…' }));
    expect(screen.getByRole('dialog', { name: 'Split Phonemart' }).textContent).toContain('-$42.17');
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Save split' }));
    await waitFor(() => expect(saveSplitsAction).toHaveBeenCalled());
    expect((vi.mocked(saveSplitsAction).mock.calls.at(-1)![1] as FormData).get('txnId')).toBe('77');
  });

  it('a refused change is reported in the panel', async () => {
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(setCategoryAction).mockResolvedValueOnce({ error: 'This transaction is split — clear its split first, then change its category.' });
    renderWithRows([panelRow()]);
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change category…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save category' }));
    expect(await screen.findByText(/clear its split first/)).toBeTruthy();
  });
});
```

(`formatCents(-4217)` renders `-$42.17`. `Split Phonemart` is the dialog title from the row's display merchant.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx`
Expected: FAIL — the component does not exist; no menu on the rows.

- [ ] **Step 4: Implement**

`RecategorizeDialog.tsx` as in Interfaces (`CategoryCombobox`, `RowDialog`, `Field`, `SubmitButton`, `buttonClass`; `formatCents` from `@/lib/money`). The panel as in Interfaces: the context's `categories` → `useMemo(() => categoryOptions(categories), [categories])`; the fetch effect's deps gain `version`; two effects bump `version` on `fixState`/`splitState` success. The panel's docblock gains the spec reference. `useContext`, `useMemo`, `useActionState` are added to the React import.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx tests/ops/client-bundle.test.ts tests/ops/row-controls.test.ts tests/ops/button-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/transactions/RecategorizeDialog.tsx "src/app/(app)/budgets/budgets-client.tsx" tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx
git commit -m "feat(budgets): change a row's category or split it from the card

- row menu with Change category and Split (Edit split on a part)
- the Transactions actions, the figures update in place, the list refetches"
```

---

### Task 5: The rule behind the row, and what happens to future rows (spec §2.3, §2.4)

**Files:**
- Modify: `src/components/transactions/RecategorizeDialog.tsx`
- Modify: `budgets-client.tsx` (`CategoryTransactionsPanel`: the row's `detail`, the `asking` state, `AlwaysAskDialog`)
- Test: `tests/components/recategorize-dialog.test.tsx`, `tests/app/budgets-client.test.tsx`

**Interfaces:**
- Consumes: Task 2's `AlwaysAskDialog`; `alwaysAskPattern` is applied inside it.
- Produces (`RecategorizeDialog`): when `canAuthorRules && (row.source === 'rule' || row.source === 'bayes')`, a `<fieldset>` with `<legend>` **Future PHONEMART 884 rows** (the `normalizedMerchant`) and radios named `ruleChoice`:
  - `keep` (checked by default): **Change this transaction only**.
  - `teach`: **Also file PHONEMART 884 this way from now on**, with a hint sentence:
    - `filedBy !== null && filedBy.matchType === 'exact' && filedBy.pattern === row.normalizedMerchant`: **Changes the rule PHONEMART 884 → <current category label> to the category you pick.** (the current label is `options.find(o => o.id === row.categoryId)?.label ?? 'its category'`)
    - `filedBy !== null` otherwise: **Adds a rule for PHONEMART 884 that wins over PHONEMART (contains). Other PHONEMART rows keep their rule.**
    - `filedBy === null` (a guess, or a rule no longer accounted for): **Adds a rule for PHONEMART 884; the guesser learns from it too.**
  - `ask` (absent when `row.alwaysAsked`): **Always ask about PHONEMART 884 from now on**, hint **This transaction is filed as you pick; then you set the Always ask rule.**
  A hidden `<input name="teach" value="1" />` renders only while `teach` is chosen. `onSubmit`: `onClose()`, then `onAlwaysAsk()` when `ask` is chosen. For `isAdmin && filedBy !== null`, a `Link` **Edit the rule under Settings** to `/settings/merchant-rules?kind=category&q=${encodeURIComponent(filedBy.pattern)}` after the hint.
- Produces (`budgets-client.tsx`): the row's `detail`: `source === 'rule'` → `filedBy ? \`Set by rule: ${filedBy.pattern} (${filedBy.matchType})\` : 'Set by a rule'`; `'bayes'` → `Set by guess`; else no detail. State `asking: string | null`; `onAlwaysAsk={() => setAsking(recat.normalizedMerchant)}`; `{asking !== null ? <AlwaysAskDialog key={asking} merchant={asking} onClose={() => setAsking(null)} onSent={() => setVersion((v) => v + 1)} /> : null}`. The dialog gets `canAuthorRules`/`isAdmin` from the context.

- [ ] **Step 1: Write the failing component tests**

Append to `tests/components/recategorize-dialog.test.tsx`:

```tsx
describe('the rule choice (spec §2.4)', () => {
  const base = { options: OPTIONS, action: vi.fn(), onClose: vi.fn(), onAlwaysAsk: vi.fn() };

  it('offers the three choices on a rule-filed row, says a wider rule is outranked, and posts teach=1 for Also file', () => {
    render(<RecategorizeDialog {...base} row={ROW} canAuthorRules isAdmin={false} />);
    expect(screen.getByRole('group', { name: 'Future PHONEMART 884 rows' })).toBeTruthy();
    expect((screen.getByLabelText(/Change this transaction only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Adds a rule for PHONEMART 884 that wins over PHONEMART (contains). Other PHONEMART rows keep their rule.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Also file PHONEMART 884 this way from now on/));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    expect(new FormData(form).get('teach')).toBe('1');
  });

  it('says the rule itself changes when it is exact on this merchant', () => {
    render(<RecategorizeDialog {...base} row={{ ...ROW, filedBy: { ruleId: 9, pattern: 'PHONEMART 884', matchType: 'exact' } }} canAuthorRules isAdmin={false} />);
    expect(screen.getByText('Changes the rule PHONEMART 884 → Groceries to the category you pick.')).toBeTruthy();
  });

  it('Always ask posts no teach and tells the caller to open the Always ask dialog; it is absent once the merchant is already asked about', () => {
    const onAlwaysAsk = vi.fn();
    const { unmount } = render(<RecategorizeDialog {...base} onAlwaysAsk={onAlwaysAsk} row={ROW} canAuthorRules isAdmin={false} />);
    fireEvent.click(screen.getByLabelText(/Always ask about PHONEMART 884 from now on/));
    const form = screen.getByRole('button', { name: 'Save category' }).closest('form') as HTMLFormElement;
    expect(new FormData(form).get('teach')).toBeNull();
    fireEvent.submit(form);
    expect(onAlwaysAsk).toHaveBeenCalled();
    unmount();
    render(<RecategorizeDialog {...base} row={{ ...ROW, alwaysAsked: true }} canAuthorRules isAdmin={false} />);
    expect(screen.queryByLabelText(/Always ask about/)).toBeNull();
  });

  /** Review Focus 5. */
  it('a self viewer gets no rule choice, a hand-set row gets none, and an admin gets the Rules page link', () => {
    const { unmount } = render(<RecategorizeDialog {...base} row={ROW} canAuthorRules={false} isAdmin={false} />);
    expect(screen.queryByRole('group')).toBeNull();
    unmount();
    const second = render(<RecategorizeDialog {...base} row={{ ...ROW, source: 'manual', filedBy: null }} canAuthorRules isAdmin />);
    expect(screen.queryByRole('group')).toBeNull();
    second.unmount();
    render(<RecategorizeDialog {...base} row={ROW} canAuthorRules isAdmin />);
    expect(screen.getByRole('link', { name: 'Edit the rule under Settings' }).getAttribute('href')).toBe('/settings/merchant-rules?kind=category&q=PHONEMART');
  });
});
```

- [ ] **Step 2: Write the failing Budgets tests**

Append to the Task 4 describe in `tests/app/budgets-client.test.tsx`:

```tsx
  /** Spec §2.3: the row says where its category came from, in Transactions' own words. */
  it('a rule-filed row names the rule, a guessed row says guess, a hand-set row says nothing', async () => {
    renderWithRows([
      panelRow(),
      panelRow({ id: 78, merchant: 'Maple Grocer', normalizedMerchant: 'MAPLE GROCER', source: 'bayes', filedBy: null }),
      panelRow({ id: 79, merchant: 'Gifts R Us', normalizedMerchant: 'GIFTS R US 12', source: 'manual', filedBy: null }),
      panelRow({ id: 80, merchant: 'Cedar Phone Co', normalizedMerchant: 'CEDAR PHONE CO', source: 'rule', filedBy: null }),
    ]);
    expect(await screen.findByText('Set by rule: PHONEMART (contains)')).toBeTruthy();
    expect(screen.getByText('Set by guess')).toBeTruthy();
    expect(screen.getByText('Set by a rule')).toBeTruthy();
    expect(screen.getAllByText(/^Set by/)).toHaveLength(3);
  });

  it('Always ask saves this transaction only, then opens the Always ask dialog for the merchant', async () => {
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    renderWithRows([panelRow()]);
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change category…' }));
    fireEvent.click(screen.getByLabelText(/Always ask about PHONEMART 884/));
    fireEvent.click(screen.getByRole('button', { name: 'Save category' }));
    await waitFor(() => expect(setCategoryAction).toHaveBeenCalled());
    expect((vi.mocked(setCategoryAction).mock.calls.at(-1)![1] as FormData).get('teach')).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Always ask for rows like this' })).toBeTruthy();
    expect((screen.getByLabelText('Text to match') as HTMLInputElement).value).toBe('PHONEMART 884');
  });

  /** Review Focus 1. */
  it('a refusal from the action is shown in the panel and nothing moves', async () => {
    const { categoryTransactionsAction } = await import('@/app/(app)/budgets/category-transactions-action');
    const { setCategoryAction } = await import('@/app/(app)/transactions/actions');
    vi.mocked(setCategoryAction).mockResolvedValueOnce({ error: 'Alex set up this rule. Ask an admin to change it under Settings → Categories & rules.' });
    renderWithRows([panelRow()]);
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change category…' }));
    fireEvent.click(screen.getByLabelText(/Also file PHONEMART 884/));
    fireEvent.click(screen.getByRole('button', { name: 'Save category' }));
    expect(await screen.findByText(/Alex set up this rule\./)).toBeTruthy();
    expect(screen.getByText('Phonemart')).toBeTruthy();
    expect(vi.mocked(categoryTransactionsAction).mock.calls).toHaveLength(1);
  });

  it('a self viewer sees Change category but no rule choice', async () => {
    renderWithRows([panelRow()], {}, { household: null, householdTotals: null, selectedPersonId: null, personal: [{ userId: 1, name: 'Alex', rows: [makeRow()] }] });
    fireEvent.click(await screen.findByRole('button', { name: /Actions for Phonemart/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change category…' }));
    expect(screen.queryByRole('group', { name: /Future/ })).toBeNull();
  });
```

(`renderWithRows`'s `over` must let `household: null` through: a self viewer's section is their own personal one, so the mocked `categoryTransactionsAction` serves that panel. `PHONEMART 884` has no masked code, so the prefill is the whole text.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx`
Expected: FAIL on every new test.

- [ ] **Step 4: Implement** as in Interfaces. The dialog's docblock states the three outcomes and why the wider rule is not retargeted here (spec §3, the rule-authoring principle); the `outranks` reference (`rules.ts:453-469`) justifies the "wins over" sentence.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx tests/ops/client-bundle.test.ts tests/ops/rule-authoring-intent.test.ts tests/ops/button-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/transactions/RecategorizeDialog.tsx "src/app/(app)/budgets/budgets-client.tsx" tests/components/recategorize-dialog.test.tsx tests/app/budgets-client.test.tsx
git commit -m "feat(budgets): a misfiled row says which rule set it, and the fix can reach the cause

- Change this transaction only, Also file the merchant this way, or Always ask
- teach goes through setCategoryAction's own rule path; Always ask through its dialog"
```

---

### Task 6: Links that ask the card's question, and the `exact` fix (spec §2.6)

**Files:**
- Modify: `src/lib/transaction-links.ts` (the union :68-94, the builder :112-132)
- Modify: `src/lib/transactions.ts` (`TransactionFilter` :52-140, `buildWhere` :378-460)
- Modify: `src/app/(app)/transactions/filter-params.ts` (`readFilter` :90-166)
- Modify: `transactions-client.tsx` (the filter count :746-782, `spendingOnly` :952-954, `formDefaults` :961-970, the hidden fields :3396-3425, the chips :3673-3693, the Category select :3756-3763)
- Test: `tests/lib/transaction-links.test.ts`, `tests/lib/transactions.test.ts`, `tests/app/transactions-client.test.tsx`

**Interfaces:**
- Produces (`transaction-links.ts`):
  ```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.6: a Budgets card's own rows — exactly that category (every panel is exact), the rows that count toward a budget (SPEND_ROW_WHERE), with the way back stamped. */
  | { kind: 'budget-category'; categoryId: number }          // category=<id>&exact=1&spend=1&via=budgets
  /** One transaction. The id is the whole question, like an import: callers pass { range: null, person: null }. */
  | { kind: 'transaction'; transactionId: number; via?: 'budgets' }   // id=<n>[&via=budgets]
  ```
- Produces (`transactions.ts`): `TransactionFilter.spendRowsOnly?: boolean` (`?spend=1`, `...SPEND_ROW_WHERE` pushed in `buildWhere`; `SPEND_ROW_WHERE` joins the existing `@/lib/spend-where` import) and `TransactionFilter.id?: number | null` (`eq(transactions.id, filter.id)` when a number).
- Produces (`filter-params.ts`): `spendRowsOnly: one(params, 'spend') === '1'`, `id: num(params, 'id') ?? null`.
- Produces (`transactions-client.tsx`): `spendRowsOnly` and `singleId` read off `currentQuery` like `spendingOnly`; the filter count adds `params.get('spend') === '1' ? '1' : null` and `/^\d+$/.test(params.get('id') ?? '') ? params.get('id') : null`; hidden inputs `spend=1` and `id=<n>` beside `spending`; chips beside the Spending only one: **Counted in budgets — clear** (`title="Rows that count toward a budget: no transfers, no loan principal"`, href `filterHref(currentQuery, 'spend', null)`) and **One transaction — clear** (href `filterHref(currentQuery, 'id', null)`); `exactActive` and `categoryChoice` (decision 10), the Category select gaining `onChange`, and `{exactActive && categoryChoice === formDefaults.category ? <input type="hidden" name="exact" value="1" /> : null}` among the hidden fields.

- [ ] **Step 1: Write the failing link tests**

`tests/lib/transaction-links.test.ts`, inside `describe('transactionsHref — the figure the link is under')`:

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.6. The card's rows: this category alone, counted toward a budget, with the way back. */
  it('a Budgets card lists exactly its own category, only the rows that count toward a budget, and stamps the way back', () => {
    const href = transactionsHref({ range: { from: '2026-03-01', to: '2026-03-31' }, person: 7 }, { kind: 'budget-category', categoryId: 12 });
    const params: TransactionParams = Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1)));
    expect(params.via).toBe('budgets');
    const filter = filterFromHref(href);
    expect({ categoryId: filter.categoryId, exact: filter.categoryExact, spend: filter.spendRowsOnly, spending: filter.spendingOnly, from: filter.from, to: filter.to, person: filter.attributedUserId })
      .toEqual({ categoryId: 12, exact: true, spend: true, spending: false, from: '2026-03-01', to: '2026-03-31', person: 7 });
  });

  it('one transaction is the whole question: the id, nothing else, and the way back only when asked', () => {
    expect(transactionsHref({ range: null, person: null }, { kind: 'transaction', transactionId: 77 })).toBe('/transactions?id=77');
    const back = transactionsHref({ range: null, person: null }, { kind: 'transaction', transactionId: 77, via: 'budgets' });
    expect(filterFromHref(back).id).toBe(77);
    expect(back).toContain('via=budgets');
  });
```

- [ ] **Step 2: Write the failing filter tests**

`tests/lib/transactions.test.ts`, beside `'categoryExact restricts the match to that category alone, no children'` (`:185`), using that test's fixture idiom; the loan link as `tests/lib/budgets.test.ts:869-952` (C-02) builds one:

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.6, Review Focus 3: the rows categoryTransactions sums. */
  it('spendRowsOnly keeps a categorized refund and drops a transfer and a loan principal row', () => {
    // seed in one category: a spend (-4217), a refund (+1000), a transfer (-900, is_transfer 1), a loan-linked row (-5000);
    // listTransactions({ categoryId, spendRowsOnly: true, page: 1, pageSize: 50 }, HOUSEHOLD_VIEWER).rows ids === [spend, refund] (any order);
    // without spendRowsOnly all four are listed.
  });

  it('id narrows the list to one row, whatever else matches', () => {
    // two rows in the category; listTransactions({ id: second, … }).rows.map(r => r.id) === [second]; total === 1.
  });
```

Write both with real assertions.

- [ ] **Step 3: Write the failing client tests**

`tests/app/transactions-client.test.tsx`, after `'?spending=1 shows a chip that clears only itself, and a submit keeps it'` (`:2553`), in the same describe:

```tsx
  it('?spend=1 and ?id= each show a chip that clears only itself, a submit keeps them, and the funnel counts them', () => {
    window.history.pushState({}, '', '/transactions?category=12&exact=1&spend=1&id=77');
    const { container } = render(<TransactionsClient page={pageWithRow()} accounts={[]} categories={categories} people={[]} today="2026-03-02" currentQuery="category=12&exact=1&spend=1&id=77" />);
    const spend = screen.getByRole('link', { name: 'Counted in budgets — clear' });
    expect(spend.getAttribute('href')).not.toContain('spend=');
    expect(spend.getAttribute('href')).toContain('id=77');
    const one = screen.getByRole('link', { name: 'One transaction — clear' });
    expect(one.getAttribute('href')).not.toContain('id=');
    expect(one.getAttribute('href')).toContain('spend=1');
    const form = container.querySelector('form[method="get"]') as HTMLFormElement;
    const data = new FormData(form);
    expect({ spend: data.get('spend'), id: data.get('id') }).toEqual({ spend: '1', id: '77' });
    // category, spend and id count; exact is a qualifier of category, not a filter of its own.
    expect(screen.getByRole('button', { name: 'Filters (3)' })).toBeTruthy();
  });

  /** Spec §2.6: the pre-existing drop. */
  it('the filter form keeps exact=1 while the category is unchanged, and drops it once another category is chosen', () => {
    const { container } = render(<TransactionsClient page={pageWithRow()} accounts={[]} categories={categories} people={[]} today="2026-03-02" currentQuery="category=42&exact=1" />);
    const form = container.querySelector('form[method="get"]') as HTMLFormElement;
    expect(new FormData(form).get('exact')).toBe('1');
    fireEvent.change(container.querySelector('form[method="get"] select[name="category"]') as HTMLSelectElement, { target: { value: '7' } });
    expect(new FormData(form).get('exact')).toBeNull();
  });
```

(`categories` in that describe has ids 42 and 7.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/transaction-links.test.ts tests/lib/transactions.test.ts tests/app/transactions-client.test.tsx`
Expected: FAIL on the new tests only.

- [ ] **Step 5: Implement** as in Interfaces. Docblocks: the two targets cite spec §2.6 and the `transactionsHref` rule that a link lists the figure's own rows; `spendRowsOnly`'s cites `categoryTransactions` (`budgets.ts:256-261`) as the set it mirrors; `id`'s says the id is the whole question.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/lib/transaction-links.test.ts tests/lib/transactions.test.ts tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx tests/ops/transactions-href.test.ts tests/ops/spend-where.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/transaction-links.ts src/lib/transactions.ts "src/app/(app)/transactions/filter-params.ts" "src/app/(app)/transactions/transactions-client.tsx" tests/lib/transaction-links.test.ts tests/lib/transactions.test.ts tests/app/transactions-client.test.tsx
git commit -m "feat(transactions): links for a Budgets card's own rows and for one transaction

- spend=1 lists the rows that count toward a budget; id= one row
- the filter form keeps exact=1 while the category is unchanged"
```

---

### Task 7: Open in Transactions, More in Transactions, and Back to Budgets (spec §2.6)

**Files:**
- Create: `src/lib/budgets-links.ts`
- Modify: `src/components/ui/MetricCard.tsx` (`id` prop)
- Modify: `budgets-client.tsx` (`CategoryTransactionsPanel`: the link and the menu item; `BudgetCategoryCard` :634-777: `id` and the hash effect)
- Modify: `transactions-client.tsx` (`cameFromGroups` :943, the `via` hidden field :3420, a `budgetsBreadcrumb()` beside `groupsBreadcrumb()` :2769-2800, rendered at :3839)
- Test: `tests/lib/budgets-links.test.ts` (new), `tests/unit/metric-card.test.tsx`, `tests/app/budgets-client.test.tsx`, `tests/app/transactions-client.test.tsx`

**Interfaces:**
- Produces (`src/lib/budgets-links.ts`, pure, no imports but `import type { BudgetScope } from '@/lib/budgets'`):
  ```ts
  /** The DOM id of a top-level Budgets card: what Transactions' Back to Budgets scrolls to. */
  export function budgetCardId(scope: BudgetScope, userId: number | null, categoryId: number): string   // `budget-card-${scope}-${userId ?? 'h'}-${categoryId}`
  /** A /budgets link carrying only what it was given: `/budgets`, `?month=`, `&person=`, `#card`. */
  export function budgetsHref(input: { month: string | null; personId: number | null; cardId: string | null }): string
  ```
- Produces (`MetricCard`): `id?: string` → `<article id={id} …>`.
- Produces (`budgets-client.tsx`): `BudgetCategoryCard` passes `id={budgetCardId(scope, userId, row.categoryId)}` and runs the hash effect (decision 7). The panel's footer: `<Link href={transactionsHref({ range: { from: monthStart(month), to: monthEnd(month) }, person: scope === 'personal' ? userId : null }, { kind: 'budget-category', categoryId })} className={buttonClass('ghost', 'sm', 'w-fit px-0 text-xs')}>Open in Transactions</Link>` under the list (rendered when there are rows); each row's menu gains `<RowMenuLink href={transactionsHref({ range: null, person: null }, { kind: 'transaction', transactionId: row.id, via: 'budgets' })}>More in Transactions</RowMenuLink>` last.
- Produces (`transactions-client.tsx`): `const via = new URLSearchParams(currentQuery).get('via'); const cameFromGroups = via === 'groups'; const cameFromBudgets = via === 'budgets';` the hidden field becomes `{cameFromGroups || cameFromBudgets ? <input type="hidden" name="via" value={via as string} /> : null}`; `budgetsBreadcrumb()` returns null unless `cameFromBudgets`, else `<div data-budgets-breadcrumb className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">` with `<Link href={backHref} className={buttonClass('ghost', 'sm')}>← Back to Budgets</Link>` and, when the category resolves, `<span aria-hidden="true">·</span><span className="font-medium text-ink">{`${name} — ${monthLabel(month)}`}</span>` (name only when no month). `backHref = budgetsHref({ month, personId, cardId })` with: `month` = `range.from.slice(0, 7)` when `range !== null && range.from.slice(0, 7) === range.to.slice(0, 7)`, else null; `personId` = the digits of `person` from `currentQuery`, else null; `cardId` = `budgetCardId(personId === null ? 'household' : 'personal', personId, topId)` where `topId` is the category's `parentId ?? id` from `categories`, null when no category id is in the query. Rendered directly after `{groupsBreadcrumb()}`; `monthLabel` from `@/lib/dates`.

- [ ] **Step 1: Write the failing lib and unit tests**

`tests/lib/budgets-links.test.ts`:

```ts
describe('budgets-links (spec 2026-10-21, fix from Budgets §2.6)', () => {
  it('names a card by scope, person and category', () => {
    expect(budgetCardId('household', null, 12)).toBe('budget-card-household-h-12');
    expect(budgetCardId('personal', 7, 12)).toBe('budget-card-personal-7-12');
  });
  it('writes only what it was given', () => {
    expect(budgetsHref({ month: '2026-03', personId: 7, cardId: 'budget-card-personal-7-12' })).toBe('/budgets?month=2026-03&person=7#budget-card-personal-7-12');
    expect(budgetsHref({ month: '2026-03', personId: null, cardId: null })).toBe('/budgets?month=2026-03');
    expect(budgetsHref({ month: null, personId: null, cardId: 'budget-card-household-h-12' })).toBe('/budgets#budget-card-household-h-12');
    expect(budgetsHref({ month: null, personId: null, cardId: null })).toBe('/budgets');
  });
});
```

`tests/unit/metric-card.test.tsx`, inside `describe('MetricCard')`: `it('passes id through to the article', …)` asserting `container.querySelector('article')!.id === 'budget-card-household-h-1'`.

- [ ] **Step 2: Write the failing Transactions tests**

`tests/app/transactions-client.test.tsx`, a new describe after `'the grouped view: the way back out of a drill-down'`, reusing its `renderDrilled` idiom (`CATEGORIES` there has 42 Groceries; add a child `{ id: 43, name: 'Produce', parentId: 42, … }` locally if the shared fixture has none):

```tsx
describe('Back to Budgets (spec 2026-10-21, fix from Budgets §2.6)', () => {
  it('links back to the month, the person and the top-level card, and names the category and month as text', () => {
    const { container } = renderDrilled('range=custom&from=2026-03-01&to=2026-03-31&person=7&category=43&exact=1&spend=1&via=budgets');
    const back = container.querySelector('[data-budgets-breadcrumb] a');
    expect((back?.textContent ?? '').trim()).toBe('← Back to Budgets');
    expect(back?.getAttribute('href')).toBe('/budgets?month=2026-03&person=7#budget-card-personal-7-42');
    expect(container.querySelector('[data-budgets-breadcrumb]')?.textContent).toContain('Produce — March 2026');
    expect(container.querySelector('[data-budgets-breadcrumb]')?.className).not.toContain('hidden');
    expect(container.querySelector('form[method="get"] input[type="hidden"][name="via"]')?.getAttribute('value')).toBe('budgets');
  });

  /** Review Focus 4. */
  it('carries no month once the range no longer sits in one month, and no card without a category', () => {
    const { container } = renderDrilled('range=last_6_months&from=2025-10-01&to=2026-03-31&via=budgets');
    expect(container.querySelector('[data-budgets-breadcrumb] a')?.getAttribute('href')).toBe('/budgets');
  });

  it('is absent without via=budgets, and the groups breadcrumb is unaffected', () => {
    expect(renderDrilled('category=42&exact=1&spend=1').container.querySelector('[data-budgets-breadcrumb]')).toBeNull();
  });
});
```

(`renderDrilled` passes `currentQuery` only; pass `range` too where the test needs `from`/`to` resolved — `range={{ preset: 'custom', from: '2026-03-01', to: '2026-03-31', label: '' }}` — since the client reads the month off its `range` prop. If `renderDrilled` cannot take it, write a local render.)

- [ ] **Step 3: Write the failing Budgets tests**

Append to the Task 4 describe in `tests/app/budgets-client.test.tsx`:

```tsx
  it('Open in Transactions carries the card’s category exactly, the month, the person and the way back; More in Transactions links to the one row', async () => {
    renderWithRows([panelRow()], {}, { selectedPersonId: 7, personal: [{ userId: 7, name: 'Sam', rows: [makeRow()] }] });
    const open = await screen.findByRole('link', { name: 'Open in Transactions' });
    expect(Object.fromEntries(new URLSearchParams(open.getAttribute('href')!.split('?')[1]))).toEqual({
      range: 'custom', from: '2026-03-01', to: '2026-03-31', person: '7', category: '1', exact: '1', spend: '1', via: 'budgets',
    });
    fireEvent.click(screen.getByRole('button', { name: /Actions for Phonemart/ }));
    expect(screen.getByRole('menuitem', { name: 'More in Transactions' }).getAttribute('href')).toBe('/transactions?id=77&via=budgets');
  });

  it('a card named by the URL hash opens itself on mount', async () => {
    window.location.hash = '#budget-card-household-h-1';
    const { categoryTransactionsAction } = await import('@/app/(app)/budgets/category-transactions-action');
    renderBudgets(null);
    expect(document.getElementById('budget-card-household-h-1')).toBeTruthy();
    await waitFor(() => expect(categoryTransactionsAction).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Hide transactions' })).toBeTruthy();
    window.location.hash = '';
  });
```

(`renderWithRows` must find the person's **View transactions** button when `selectedPersonId` is set — the personal grid is the one mounted.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/budgets-links.test.ts tests/unit/metric-card.test.tsx tests/app/transactions-client.test.tsx tests/app/budgets-client.test.tsx`
Expected: FAIL on the new tests only.

- [ ] **Step 5: Implement** as in Interfaces. `budgets-links.ts`'s docblock: why the way back is derived rather than carried (spec §3, the `?back=` alternative). The hash effect in `BudgetCategoryCard` runs once (`useEffect(() => {…}, [])` with the eslint comment the file already uses for one-shot effects).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/lib/budgets-links.test.ts tests/unit/metric-card.test.tsx tests/app/transactions-client.test.tsx tests/app/budgets-client.test.tsx tests/app/budgets-page.test.tsx tests/ops/client-bundle.test.ts tests/ops/transactions-href.test.ts tests/ops/button-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/budgets-links.ts src/components/ui/MetricCard.tsx "src/app/(app)/budgets/budgets-client.tsx" "src/app/(app)/transactions/transactions-client.tsx" tests/lib/budgets-links.test.ts tests/unit/metric-card.test.tsx tests/app/budgets-client.test.tsx tests/app/transactions-client.test.tsx
git commit -m "feat(budgets): Open in Transactions, More in Transactions, and Back to Budgets

- a panel links to exactly the rows it sums; a row links to itself
- Transactions shows the way back to the same month, scope and card"
```

---

### Task 8 (OWNER MAY DROP — spec §2.7, the open decision): Categorize opens the review queue when it shows the same rows

> Drop this task to keep v1.56.1's behaviour (the plain list, always). Nothing after it depends on it.

**Files:**
- Modify: `src/lib/budgets.ts` (`UncategorizedSpend` :290-294, `uncategorizedSpend` :316-346)
- Modify: `src/lib/transaction-links.ts` (one target)
- Modify: `budgets-client.tsx` (`BudgetSectionBody`'s `UncategorizedSpendCard` href)
- Modify fixtures: every `{ totalCents, count }` literal typed as `UncategorizedSpend` in `tests/app/budgets-client.test.tsx` (5), `tests/components/uncategorized-spend-card.test.tsx` (3) gains `queueShowsSameRows: true`
- Test: `tests/lib/budgets.test.ts`, `tests/lib/transaction-links.test.ts`, `tests/app/budgets-client.test.tsx`

**Interfaces:**
- Produces (`budgets.ts`): `UncategorizedSpend.queueShowsSameRows: boolean` (decision 12; `REVIEW_WHERE` joins the existing `@/lib/categorize/engine` import; `loanPayments` from `@/db/schema` for the hidden count's `exists`).
- Produces (`transaction-links.ts`): `| { kind: 'uncategorized-queue' }` writing `review=1`, `queue=uncategorized`, `category=uncategorized`, `transfers=0` beside the range and person.
- Produces (`budgets-client.tsx`): `href={transactionsHref(scope…, uncategorized?.queueShowsSameRows ? { kind: 'uncategorized-queue' } : { kind: 'uncategorized-spending' })}`.

- [ ] **Step 1: Write the failing tests**

`tests/lib/budgets.test.ts`, inside `describe('uncategorizedSpend')` (its fixture; a loan link as the C-02 test builds one):

```ts
  /** Spec 2026-10-21 (fix from Budgets) §2.7. */
  it('says the review queue shows the same rows only when no counted row is loan-linked and no uncategorized deposit sits in the month', () => {
    // (a) two uncategorized spends → queueShowsSameRows true
    // (b) plus an uncategorized loan-linked repayment (counted, hidden by REVIEW_WHERE) → false
    // (c) fresh fixture: two spends plus an uncategorized +2500 deposit (not counted, shown by the queue) → false
  });
```

`tests/lib/transaction-links.test.ts`: `it('the uncategorized-queue target opens the review queue’s Uncategorized tab for the month and person', …)` asserting, through `filterFromHref`, `reviewOnly` is `false` from the plain reader (review mode is decided by the page) but `params.review === '1'`, `params.queue === 'uncategorized'`, `categoryId === 'uncategorized'`, `transferView === 'none'`, `from`/`to` the month, `attributedUserId` 7.

`tests/app/budgets-client.test.tsx`, in `describe('BudgetsClient — Not categorized yet')`: `it('Categorize opens the review queue when the queue shows the same rows, and the plain list when it would not', …)`: with `{ totalCents: 5750, count: 2, queueShowsSameRows: true }` the href's query equals `{ range: 'custom', from: '2026-03-01', to: '2026-03-31', review: '1', queue: 'uncategorized', category: 'uncategorized', transfers: '0' }`; with `queueShowsSameRows: false` it equals today's `{ …, category: 'uncategorized', spending: '1' }`. Update the existing `'puts the card first…'` test's fixture to `queueShowsSameRows: false` so its assertion stands.

- [ ] **Step 2: Run to verify they fail**, implement, run `npx vitest run tests/lib/budgets.test.ts tests/lib/transaction-links.test.ts tests/app/budgets-client.test.tsx tests/components/uncategorized-spend-card.test.tsx tests/app/budgets-page.test.tsx tests/ops/transactions-href.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/budgets.ts src/lib/transaction-links.ts "src/app/(app)/budgets/budgets-client.tsx" tests/lib/budgets.test.ts tests/lib/transaction-links.test.ts tests/app/budgets-client.test.tsx tests/components/uncategorized-spend-card.test.tsx
git commit -m "feat(budgets): Categorize opens the review queue when it shows the same rows

- the plain list stays when a counted row is loan-linked or a deposit is uncategorized"
```

---

### Task 9: Help, README and the release notes (spec §2.8)

**Files:** `src/app/(app)/help/content.tsx` (the Budgets section :326-359, after the Not categorized yet paragraph), `README.md` (item 5, :174-178), `CHANGELOG.md` (`## Unreleased`).

- [ ] **Step 1:** Help, one paragraph in the Budgets section:

> Open a card&rsquo;s transactions and each row has a menu: <B>Change category&hellip;</B> and <B>Split&hellip;</B> happen right there, and the card&rsquo;s figure updates. A row a rule filed says which rule, and changing its category offers to change this transaction only, to file that merchant the same way from now on, or to always ask about it. <B>Open in Transactions</B> lists exactly the rows the card adds up, with a way back to the same card.

README item 5, appended sentence: `A row filed in the wrong category can be fixed from the card itself, and the card says which rule filed it.`

- [ ] **Step 2:** CHANGELOG, under `## Unreleased`:

```md
### Added

- **Fix a row from the Budgets card.** Each row in a card's transaction list has a menu: change its
  category or split it right there, and the card's figure updates. A row a rule filed says which rule,
  and changing its category offers to change this transaction only, to file that merchant the same way
  from now on, or to always ask about it. Open in Transactions lists exactly the rows the card adds up,
  and Transactions shows a way back to the same month and card.

### Fixed

- Transactions: submitting the filter form after arriving on one category's own rows kept the
  category but widened the list to its sub-categories; it now keeps the list as it was until another
  category is chosen.
```

If Task 8 was built, add under Added: `- Budgets: Categorize on Not categorized yet opens the review queue when the queue shows exactly the rows the card counts, so a pick there can also teach a rule.`

- [ ] **Step 3:** `npx vitest run tests/ops/onboarding-coverage.test.ts tests/app/help.test.tsx tests/lib/changelog.test.ts` → PASS. Commit:

```bash
git add "src/app/(app)/help/content.tsx" README.md CHANGELOG.md
git commit -m "docs: fixing a row from the Budgets card, in Help, the README and the notes"
```

---

## The review (exactly one, after Task 9)

One Opus reviewer, given `git diff 31f41ec..HEAD` and the spec, asked to check what changes money figures or categories, not wording:

- Task 3: `categoryRuleThatFiled` never names a rule whose category is not the row's; the action builds one context per request; `/budgets` revalidated by both actions and nothing else changed in them.
- Tasks 4–5: `setCategoryAction` receives exactly `transactionId`, `categoryId` and (only on the teach choice) `teach=1`; the `ask` choice posts no `teach`; a split part never reaches Change category; `SplitDialog` from the card posts the parent's id and the full amount; the panel refetches after success and only then (Review Focus 1, 2, 5).
- Task 6: `spendRowsOnly` is `SPEND_ROW_WHERE` and the lib test's set matches `categoryTransactions`' (Review Focus 3); `id` cannot widen a self viewer's read (buildWhere's owner clause is unconditional).
- Task 7: the back href is derived and never carried; the hash effect opens only the card whose id matches (Review Focus 4).
- Task 8 (if built): the two counts and the fixtures that prove each alone flips the flag.

Not reviewed: the two extractions beyond their pins, help, docs. One fix round for Important findings, committed as `fix: review round` with bullets; re-review only a non-trivial fix.

---

### Task 10: Release v1.57.0

**Files:** Modify `tests/ops/docker.test.ts` (`'MUST-7.1: the 1.56.1 release'` :477-495 and every remaining `toBe('1.56.1')`), `CHANGELOG.md`, `package.json`, `package-lock.json`.

- [ ] **Step 1: Update the release guard first.** Replace `it('MUST-7.1: the 1.56.1 release', …)` with a `1.57.0` test of the same shape (package.json, both lockfile fields, the dated heading below `## Unreleased` and above `## [1.56.1]`, Unreleased emptied), whose section checks are:

```ts
    const current = changelog.slice(changelog.indexOf('## [1.57.0]'), changelog.indexOf('## [1.56.1]'));
    expect(current).toMatch(/### Added/);
    expect(current).toMatch(/Fix a row from the Budgets card/);
    expect(current).toMatch(/Open in Transactions/);
    expect(current).toMatch(/### Fixed/);
    expect(current).not.toMatch(/!/);
```

and add, directly after it, `it('MUST-7.1: the 1.56.1 release is still recorded intact (append-only discipline)', …)` in the shape of the existing 1.56.0 one: `## [1.56.1] - 2026-10-21` present, before `## [1.56.0]`, and the phrases the replaced 1.56.1 test asserted about its section (`### Fixed`, `Categorize`, `back to review`, `Matches`). Then change every remaining `toBe('1.56.1')` to `toBe('1.57.0')`; `grep -c "toBe('1.56.1')" tests/ops/docker.test.ts` → `0`.

- [ ] **Step 2:** `npx vitest run tests/ops/docker.test.ts` → FAIL on the version pins and the missing `## [1.57.0]` heading.

- [ ] **Step 3: Date the notes and bump the version.** Insert `## [1.57.0] - <output of date +%F>` and a blank line between `## Unreleased` and the notes, so `## Unreleased` is empty again; `### Added` comes before `### Fixed`. `package.json` and both `"version"` fields near the top of `package-lock.json`: `1.56.1` → `1.57.0`. If `package-lock.json` changed anywhere beyond those two fields, verify with `npx npm@10.9.9 ci --dry-run`. Run `npx vitest run tests/ops/docker.test.ts tests/lib/changelog.test.ts` → PASS.

- [ ] **Step 4: The release gate.**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
rm -rf .next && npm run build
npm run smoke
```

Expected: vitest exit 0 (a lone `Timeout calling "onTaskUpdate"` failure in a parallel run is the known flake — rerun that file alone; the `--no-file-parallelism` run must exit 0); tsc clean; build exit 0 with the known Turbopack dynamic-filesystem warnings; smoke passes with the known Windows skips.

- [ ] **Step 5: Commit and push.**

```bash
git add CHANGELOG.md package.json package-lock.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.57.0

- fix a row from the Budgets card; the rule behind it; the way back
- the filter form keeps exact=1"
git push origin main
```

- [ ] **Step 6:** `gh run list --workflow test.yml --limit 3`, then `gh run watch <id> --exit-status` → `Test suite` succeeds. Do not tag until it does; fix forward on a failure, never force-push.

- [ ] **Step 7:** Confirm the v1.56.1 `Release image` run completed with success (stop and report if it failed). Then `git tag -a v1.57.0 -m "v1.57.0" <the SHA Test suite passed on>`, `git push origin v1.57.0`, `gh run list --workflow release-image.yml --limit 3`, `gh run watch <id> --exit-status` → `Release image` for v1.57.0 succeeds. Never move or delete a tag.
