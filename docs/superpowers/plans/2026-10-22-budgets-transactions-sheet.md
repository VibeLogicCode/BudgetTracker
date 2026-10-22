# A card's transactions in a Sheet — Implementation Plan (v1.58.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Budgets, **View transactions** (a leaf card's footer, and each row inside **View breakdown**) opens the card's rows in a Sheet instead of expanding them under the card: full height from the bottom on a phone, a drawer on the right at `sm` and up with the page visible beside it. The Sheet's header names the category (with its parent), the month and what was spent against the limit, and that figure follows each fix. Each row is one button with a chevron that opens the same three fixes; a row a rule or a guess filed carries a small tag. The page behind does not move.

**Architecture:** RowDialog's modal internals (opener capture, focus in, focus trap, Escape, body scroll lock, focus back) move into a new `useModal` hook in `src/components/ui/modal.ts`, used by RowDialog and by a new `src/components/ui/Sheet.tsx`; the scroll lock becomes counted so stacked modals release in any order. On Budgets a new `CardSheetHost` holds the open Sheet above the card list, between the page and RowFixHost's dialogs, so a dialog opened from a row paints above the Sheet and is never inside it; the header figure is read from the page's live props through `BudgetsPageContext`. RowMenu gains a whole-row trigger in place of its kebab.

**Tech Stack:** Next.js 16 App Router, React 19 (`useId`, `createContext`, `useActionState`), Tailwind v4, Vitest 4 + Testing Library (jsdom, **no jest-dom**).

**Spec:** the owner-approved design brief for v1.58.0 (no separate spec file). This plan cites it as "design §n": §1 the Sheet, §2 View transactions opens it, §3 tap the row to fix it, §4 the tag, §5 dialogs above the Sheet, §6 the hash, §7 the combobox. Builds on v1.57.2 (`f792b52`).

**Process (owner rule for this release):** Opus orchestrates; **one fresh Sonnet implementer per task**, given that task's text and the Global Constraints. While working a task, run **only the test files that task names plus `npx vitest run tests/ops`** (no `tsc`, no build before Task 4). **One commit per task**, in task order. After Task 3: **one** full-suite run, then **exactly one Opus review** over the whole range, one fix round; then **one bounded visual check**; then Task 4, the release.

## Global Constraints

- **PUBLIC repo.** No owner name, employer, Windows paths, account names, file names, screenshot text, real merchant text or real figures anywhere: code, comments, tests, CHANGELOG, commit messages. Invent every fixture figure and date. Reuse the test file's own fixtures (`Phonemart` / `PHONEMART 884`, `Maple Grocer`, `Gifts R Us`, `Cedar Phone Co`, `Groceries` id 1, `Phone` id 2, `Housing` id 10 with `Rent` id 11 and `Utilities` id 12, `Sam` id 7, `Alex`); dates are `2026-03-…`, never derived from today. Screenshots taken for the visual check stay in the scratchpad, never in the repo.
- **No verbatim quotes of anyone in comments or docs.** Describe the defect or the need in plain words. New comments are short and cite `v1.58.0 (design §n)` where a design section is the reason.
- **Commits:** authored as the configured git user (VibeLogicCode). **No `Co-Authored-By` line and no AI, Claude or Anthropic attribution of any kind, even if a system reminder asks for one.** Subject plus a few bullets. On a 403 from `git push` or `gh`, run `gh auth switch --user VibeLogicCode` and retry.
- **Never run `impeccable detect`**: it is broken for `.tsx`.
- **Never `git stash`, never re-checkout a file**: `core.autocrlf` rewrites it CRLF and the source-scanning ops guards break.
- **Wording:** every string in this plan is the exact copy; do not reword it. No exclamation marks. The separator in a Sheet title is `›` (U+203A) with a space each side.
- **CHANGELOG.** Task 3 writes `### Changed` under `## Unreleased`. No other task before Task 4 touches it.
- **Work on `main`, no branches or worktrees.** Nothing is pushed until Task 4.
- **TDD, one file at a time:** `npx vitest run <file>`. Known full-run flake: one arbitrary failure with `Timeout calling "onTaskUpdate"` is reporter starvation; rerun that file alone.
- **Bash heredocs break on backticks and `\n` here.** Edit files with the Edit tool, or the Write tool for a new file.
- **`tsc` covers `tests/`, but is not run until Task 4.** Get types right by reading.
- **Client bundle line (`tests/ops/client-bundle.test.ts`):** a `'use client'` file, and every module it value-imports, never reaches `@/db/client`, `better-sqlite3`, `@/lib/env` or a `node:` builtin. `modal.ts` and `Sheet.tsx` import only `react`, `@/components/ui/Button` and each other. `@/lib/budgets` stays `import type` in `budgets-client.tsx`.
- **Guards the new code meets:** `reduced-motion` (no `animate-pulse`/`animate-spin`, no `motion-keep`: the Sheet's slide is decoration, a CSS animation the global reset in `globals.css` already shortens to nothing), `type-scale` (no `text-[…]`; `sm:w-[30rem]` and `pt-[max(…)]` are not font sizes), `button-vocabulary` (`buttonClass`, never `className="btn …"`), `transactions-href` (both Transactions links keep `transactionsHref`), `title-only-info` (nothing a person needs only in a `title`), `row-controls` (no new `<form>`), `onboarding-coverage` (no new `<EmptyState`, no NAV entry), `contrast` (only existing token pairs: `badge--slate`, `text-ink`/`text-muted`/`text-subtle` on `bg-surface`, `bg-black/50` as RowDialog has it), `visibility-invariants` (no new viewer-taking reader, so its floor stands), `client-bundle`, `docker` (the release guard, Task 4 only).

## Review Focus

Inputs most likely to bite a household that no single obvious test would catch; each names the test that pins it.

1. **A fix that takes the card off the page** (an archived category's last row moves out). The Sheet stays open, its header reads `spent $0.00`, and the dialog in use stays until closed. Task 2 (`'a card whose rows all move away keeps its open dialog until it is closed'`, extended).
2. **Focus after a fix.** When the fix takes the focused row off the list, or the Always ask dialog that follows a category change closes, focus stays in the Sheet rather than falling to the page behind it. Task 1 (`'when the focused element inside it is removed, focus comes back to it'`, `'when the opener is gone, focus goes to the modal underneath'`); Task 2 (`'after the Always ask dialog that follows a category change closes, focus is back in the sheet'`, `'a fix that takes the focused row off the list keeps focus in the sheet'`).
3. **Escape inside the Sheet** closes only the innermost layer: a row's open menu, or a dialog over the Sheet. Task 1 (`'Escape closes it; an Escape something inside already handled does not'`); Task 3 (`"Escape on a row's open menu closes the menu and leaves the sheet open"`).
4. **A category picker in a dialog over the Sheet** stays open when the page scrolls, whatever clips the Sheet (v1.57.1's fixed-layer rule, design §7). Task 2 (`'a category picker in a dialog opened from the sheet stays open when the page scrolls, whatever clips the sheet'`).
5. **Leaving the page with a dialog open over the Sheet** (an admin's Edit the rule under Settings link) must not leave the next page unable to scroll: stacked scroll locks release in either order. Task 1 (`'locks the page scroll while open, and stacked modals release it in either order'`).

## Decisions this plan makes where the code and the design meet

1. **Where the Sheet lives.** A new `CardSheetHost` inside `RowFixHost`, wrapping the page: DOM order is page, then Sheet, then RowFixHost's dialogs. A fix can take its card off the page (RowFixHost's own docblock), so the Sheet cannot live in the card; and a dialog that is the Sheet's sibling, not its child, keeps its Escape, its Tab trap and its fixed layer to itself (design §5, §7). Both are `z-50`; the later sibling paints on top.
2. **The live figure.** `BudgetsPageContext` gains `rowOf(scope, userId, categoryId)`, built from this render's `household` and `personal` rows, children included. The Sheet reads its figure through it on every render, so the revalidation `setCategoryAction` and `saveSplitsAction` already trigger updates it in place (design §2). A row that has left the page reads `spent $0.00` with no limit: a card leaves the page only once nothing is left on it.
3. **The row's actions: RowMenu opened from the row** (design §3). RowMenu gains a `row` trigger: the whole row is its `<button>`, holding only spans and an icon, and the menu renders as the button's sibling, so nothing interactive nests. Chosen over an inline action list because it is the menu, item set and keyboard model (arrows, Home/End, Escape back to the row, one menu open at a time) the card and Transactions already use and test; its `position: fixed` menu escapes the Sheet body's scroll clip; and a list opening under a row would push the rows below it down, the behaviour this release takes off the page.
4. **Shared modal behaviour** (design §1: extract, not copy). `useModal` in `modal.ts` owns the opener capture, focus in, `trapDialogTab`, Escape and focus back for both RowDialog and Sheet. Four changes ride with the move and apply to every RowDialog: the body scroll lock is counted (the first lock saves, the last release restores); while locked, the body's right padding grows by the scrollbar's width so the page behind does not shift sideways; when the opener has gone, focus goes to the topmost modal still open; and when focus falls to the body while a modal is topmost, that modal takes it back. The key handler ignores a key something inside already handled (`event.defaultPrevented`: RowMenu's Escape, CategoryCombobox's Escape).
5. **Motion.** Two keyframes in `globals.css` (`sheet-from-bottom`, and `sheet-from-right` from `min-width: 40rem`) on `.sheet-panel`, each with a `from` only, so the panel ends on no transform and RowMenu's fixed menu inside it is placed against the window. No backdrop blur on the Sheet (a blurred backdrop would hide the page the drawer sits beside, and a backdrop filter holds fixed elements). Reduced motion: the existing global reset (`*:not(.motion-keep)`) shortens it to nothing; the Sheet never carries `motion-keep`.
6. **A leaf card's six-month strip moves into its Sheet.** A parent's strip stays inline in View breakdown (design §2). A leaf card has no inline region once its transactions go to the Sheet, and opening the strip on the card as well would move the page behind (design §1), so a leaf's Sheet shows the card's own six months at the top of its body. Sub-category rows never had a strip and get none. `CategoryHistoryStrip` gains `narrow` (three columns at every width: a 30rem drawer is narrower than its `sm:` breakpoint assumes).
7. **The hash** (design §6). A parent card named by the hash opens its breakdown, as before; a leaf card has nothing inline left to open, so the hash only lands the page on it (the browser's own scroll to the id) and is cleared. Neither opens the Sheet.
8. **Names.** The Sheet's accessible name is its title (`aria-labelledby`); the month and figure are its description (`aria-describedby`), so the name stays put while the figure changes. Row button: `Fix ${merchant}, ${date}, ${formatCents(amountCents)}`; its tag is its `aria-describedby`.
9. **The tag** (design §4) is a `Pill tone="neutral"` holding the existing words (`Set by rule: PHONEMART (contains)`, `Set by a rule`, `Set by guess`), truncated with an ellipsis inside the row's width on a phone; the full words stay in the row's description. A `manual` or `none` row has none.
10. **View transactions buttons** carry `aria-haspopup="dialog"`, no `aria-expanded`, and always read `View transactions`.
11. **No direction arrow in a Sheet row:** the amount's sign and colour already say it, and on a 390px phone that width is what the tag needs.
12. **Open in Transactions** moves to the Sheet's footer, unchanged (exact, `spend=1`, `via=budgets`), present only when the list has rows, as today. Newest first is already `categoryTransactions`' own order (`desc(date), desc(id)`, `src/lib/budgets.ts`); nothing changes there.

---

## File map

| Area | Files |
|---|---|
| Modal behaviour and the Sheet (1) | `src/components/ui/modal.ts` (new), `src/components/ui/RowDialog.tsx`, `src/components/ui/Sheet.tsx` (new), `src/app/globals.css` |
| View transactions opens the Sheet (2) | `src/app/(app)/budgets/budgets-client.tsx` |
| Rows as fix buttons, help, notes (3) | `src/components/ui/RowMenu.tsx`, `budgets-client.tsx`, `src/app/(app)/help/content.tsx`, `CHANGELOG.md` |
| Release (4) | `CHANGELOG.md`, `package.json`, `package-lock.json`, `tests/ops/docker.test.ts` |

---

### Task 1: Shared modal behaviour, and the Sheet (design §1, §5)

**Files:**
- Create: `src/components/ui/modal.ts`, `src/components/ui/Sheet.tsx`
- Modify: `src/components/ui/RowDialog.tsx` (`DIALOG_FOCUSABLE_SELECTOR` and `trapDialogTab` :101-117 move out with their docblock :39-48; the opener capture :169-172, the effect :174-199 and `onDialogKeyDown` :201-210 become `useModal`)
- Modify: `src/app/globals.css` (the keyframes and `.sheet-panel`, beside `.auth-wash`)
- Test: `tests/components/sheet.test.tsx` (new)
- Pins (pass before and after; do not edit): `tests/app/transactions-client.test.tsx` `describe('Split editor is a modal dialog, not a card at the top of the page (item 1)')`; `tests/components/category-combobox.test.tsx` `'Escape inside a dialog closes only the open list'` and `'a second Escape, with the list closed, reaches the dialog'`; `tests/app/merchant-rules-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`, `tests/app/notifications-client.test.tsx` whole files.

**Interfaces:**
- Produces (`src/components/ui/modal.ts`, no directive; imported only by client components):
  ```ts
  export const DIALOG_FOCUSABLE_SELECTOR: string; // moved from RowDialog.tsx, unchanged
  export function trapDialogTab(container: HTMLElement, event: ReactKeyboardEvent<HTMLElement>): void; // moved, unchanged
  /** Counted. The first lock keeps body's inline overflow and padding-right, sets overflow hidden and grows
   *  padding-right by the scrollbar's width (innerWidth - documentElement.clientWidth, only when clientWidth > 0)
   *  so the page behind does not shift; the last release puts both back. Calling one release twice is a no-op. */
  export function lockBodyScroll(): () => void;
  /** The last [role="dialog"][aria-modal="true"] in document order, or null. */
  export function topmostModal(): HTMLElement | null;
  /** What a hand-rolled modal owes a keyboard and screen-reader user. */
  export function useModal(onClose: () => void): {
    ref: RefObject<HTMLDivElement | null>;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  };
  ```
  `useModal`, in this order: (a) captures `document.activeElement` as the opener during the FIRST render (RowDialog's comment on why render and not an effect moves with it); (b) on mount, focuses the container unless it already holds focus, then `lockBodyScroll()`; on unmount, releases, then focuses the opener when `opener.isConnected`, else `topmostModal()`; (c) after every render (an effect with no dependency list), when `document.activeElement` is `null` or `document.body` and `topmostModal() === ref.current`, focuses the container; (d) `onKeyDown` returns at once when `event.defaultPrevented`; Escape → `preventDefault()`, `onClose()`; any other key → `trapDialogTab`.
- Produces (`RowDialog.tsx`): the same props, DOM, ids and classes; the body calls `useModal(onClose)` and puts `ref`/`onKeyDown` on the panel. Its top docblock gains one line: the modal behaviour lives in `modal.ts`, shared with Sheet.
- Produces (`src/components/ui/Sheet.tsx`, `'use client'`):
  ```ts
  export interface SheetProps {
    /** Ids `${sheetId}-heading` / `-description`; test ids `${sheetId}-backdrop` / `-body`. */
    sheetId: string;
    /** The accessible name (aria-labelledby). */
    title: ReactNode;
    /** A line under the title, read as the description (aria-describedby), not as the name. */
    description?: ReactNode;
    onClose: () => void;
    /** The body; it scrolls on its own. */
    children: ReactNode;
    /** Pinned under the body. Omitted, there is no footer. */
    footer?: ReactNode;
  }
  export function Sheet(props: SheetProps): React.ReactElement
  ```
  Markup: backdrop `fixed inset-0 z-50 flex justify-end bg-black/50 sm:bg-black/20` with `onClick={onClose}`; panel `role="dialog" aria-modal="true" aria-labelledby aria-describedby tabIndex={-1}`, `onClick` stops propagation, `onKeyDown` from `useModal`, classes `sheet-panel flex h-full w-full flex-col bg-surface shadow-pop outline-none sm:w-[30rem] sm:max-w-[calc(100%-3rem)] sm:border-l sm:border-line`. Header `flex items-start gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5`: `<h2 id=…-heading className="text-base font-semibold text-ink">`, the description in `<p id=…-description className="mt-0.5 text-sm text-muted">`, then a **Close** button (`type="button"`, `buttonClass('ghost', 'sm', 'min-h-11 shrink-0 sm:min-h-0')`). Body `min-h-0 flex-1 overflow-y-auto overscroll-contain` (`data-testid=…-body`). Footer `border-t border-line px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-5`. Docblock: design §1 and decisions 1, 4 and 5, a sentence each.
- Produces (`globals.css`), with a two-line comment naming decision 5:
  ```css
  @keyframes sheet-from-bottom { from { transform: translateY(100%); } }
  @keyframes sheet-from-right { from { transform: translateX(100%); } }
  .sheet-panel { animation: sheet-from-bottom 220ms cubic-bezier(0.32, 0.72, 0, 1); }
  @media (min-width: 40rem) { .sheet-panel { animation-name: sheet-from-right; } }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/components/sheet.test.tsx` (`// @vitest-environment jsdom`; `afterEach`: `cleanup()`, then `document.body.style.overflow = ''` and `document.body.style.paddingRight = ''`). A small harness renders an opener button and, when open, `<Sheet sheetId="t" title="Groceries" description="March 2026 · spent $50.00 of $200.00" onClose={onClose} footer={<a href="/x">Open in Transactions</a>}><button>First row</button><button>Last row</button></Sheet>`. A second root, where a test needs one, renders `<RowDialog dialogId="d" title="Over" onClose={…}><button>Inside</button></RowDialog>` into its own container. Every test fails first because the module does not exist.

```tsx
describe('Sheet', () => {
  it('is a labelled modal dialog: the title names it, the description describes it', () => {
    // getByRole('dialog', { name: 'Groceries' }); aria-modal 'true';
    // document.getElementById(aria-describedby)!.textContent === 'March 2026 · spent $50.00 of $200.00'
  });
  it('takes focus on open and gives it back to the opener on close', () => {
    // opener focused, open: activeElement === the dialog; close: activeElement === the opener
  });
  it('Escape closes it; an Escape something inside already handled does not', () => {
    // keyDown Escape on 'First row' -> onClose called once.
    // A child <div onKeyDown={(e) => e.preventDefault()}> receiving Escape -> onClose not called.
  });
  it('Tab wraps inside it', () => {
    // Tab on the footer link -> 'Close'; Shift+Tab on 'Close' -> the footer link
  });
  it('a click on the backdrop closes it, a click inside does not, and Close closes it', () => {
    // click getByTestId('t-backdrop') -> onClose; click the dialog -> not; click 'Close' -> onClose
  });
  /** Review Focus 5. */
  it('locks the page scroll while open, and stacked modals release it in either order', () => {
    // Sheet and RowDialog both open -> 'hidden'; unmount the Sheet first -> still 'hidden'; unmount the dialog -> ''.
    // Again, unmounting the dialog first -> 'hidden'; then the Sheet -> ''.
  });
  it('keeps the page from shifting: the scrollbar width goes onto the body padding while locked', () => {
    // Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: window.innerWidth - 15 });
    // open -> body.style.paddingRight === '15px'; close -> ''. Delete the override after.
  });
  /** Review Focus 2. */
  it('when the opener is gone, focus goes to the modal underneath', () => {
    // Sheet open; focus 'First row'; open the RowDialog (its opener is 'First row');
    // rerender the Sheet without 'First row'; unmount the RowDialog -> activeElement === the Sheet's dialog
  });
  /** Review Focus 2. */
  it('when the focused element inside it is removed, focus comes back to it', () => {
    // focus 'Last row'; rerender the Sheet without it -> activeElement === the Sheet's dialog
  });
  it('arrives without leaving a transform behind', () => {
    // the dialog's className contains 'sheet-panel'; neither the backdrop's nor the panel's className matches
    //   /(^|\s)(backdrop-blur\S*|blur\S*|transform|translate-\S+|scale-\S+|rotate-\S+|motion-keep)(\s|$)/
    // globals.css: the '@keyframes sheet-from-bottom' and '@keyframes sheet-from-right' blocks each contain 'from'
    //   and neither 'to {' nor '100%'; a '.sheet-panel' rule declares 'animation'
  });
});
```

- [ ] **Step 2: Run to verify the new file fails and the pins pass**

Run: `npx vitest run tests/components/sheet.test.tsx tests/app/transactions-client.test.tsx tests/components/category-combobox.test.tsx`
Expected: the new file FAILS (module not found); the pins PASS.

- [ ] **Step 3: Implement** `modal.ts`, then repoint RowDialog, then `Sheet.tsx` and the CSS, as in Interfaces.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/sheet.test.tsx tests/app/transactions-client.test.tsx tests/components/category-combobox.test.tsx tests/app/merchant-rules-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/notifications-client.test.tsx tests/ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/modal.ts src/components/ui/Sheet.tsx src/components/ui/RowDialog.tsx src/app/globals.css tests/components/sheet.test.tsx
git commit -m "feat(ui): a Sheet that shares RowDialog's modal behaviour

- useModal: focus in and back, trap, Escape, counted scroll lock
- focus falls back to the modal underneath when its opener is gone
- Sheet: full height on a phone, a right-hand drawer from sm"
```

---

### Task 2: View transactions opens the Sheet (design §1, §2, §5, §6, §7)

**Files:**
- Modify: `src/app/(app)/budgets/budgets-client.tsx`: `CategoryHistoryStrip` (:342-429, gains `narrow`), `CategoryTransactionsPanel` (:431-604, becomes `CategoryTransactionsSheet`), `RowFixHost`'s docblock (:622-629), `ChildBreakdownRow` (:703-783), `DirectSpendRow` (:785-842), `BudgetCategoryCard` (:844-1012), `BudgetsPageContext` (:1654-1663), `BudgetsClient`'s provider tree (:1816-1819 and :2053-2056)
- Test: `tests/app/budgets-client.test.tsx`
- Pins (pass before and after; do not edit): `describe('F-06: the six-month history strip')` (4 tests: they open a leaf's strip with View transactions, which now shows it at the top of the Sheet), `describe("v1.21.0 item 2: a parent's own direct spend gets its own row")`, `describe('v1.18.0 Lane 2 items 1-2: a group collapses, and its header already carries the numbers')`.

**Interfaces:**
- Consumes: Task 1's `Sheet`, with `sheetId="card-transactions"`.
- Produces (`budgets-client.tsx`):
  ```ts
  /** v1.58.0 (design §2). What a card's Sheet lists, and the figure it heads with. */
  interface CardSheetTarget {
    scope: BudgetScope;
    userId: number | null;
    month: string;
    /** Whose rows: the category's own id; the parent's for Not in a sub-category. */
    categoryId: number;
    /** 'Groceries', 'Housing › Rent', 'Housing › Not in a sub-category'. */
    title: string;
    /** The empty line's name: 'No transactions in Rent this month.' */
    categoryName: string;
    /** 'direct' heads with the parent row's directSpentCents and no limit. */
    figure: 'category' | 'direct';
    /** A leaf card's own six months at the top (decision 6). */
    history: boolean;
  }
  const CardSheetContext = createContext<(target: CardSheetTarget) => void>(() => {});
  function CardSheetHost({ children }: { children: ReactNode }): React.ReactElement
  function CategoryTransactionsSheet({ target, onClose }: { target: CardSheetTarget; onClose: () => void }): React.ReactElement
  /** Pure. A row that has left the page reads as nothing spent and no limit (decision 2). */
  function sheetFigure(target: CardSheetTarget, row: BudgetRow | null): { spentCents: number; limitCents: number | null }
  ```
  `BudgetsPageContext` gains `rowOf: (scope: BudgetScope, userId: number | null, categoryId: number) => BudgetRow | null` (default `() => null`). `BudgetsClient` builds it per render from `household ?? []` (scope `'household'`, userId `null`) and each `personal[i].rows` (scope `'personal'`, that `userId`), every row and its `children`, in a `Map` keyed `${scope}:${userId ?? 'h'}:${categoryId}`. Provider tree: `BudgetsPageContext.Provider` › `RowFixHost` › `CardSheetHost` › the page `<div>` (decision 1).
  `CardSheetHost` keeps `target: CardSheetTarget | null`, provides `setTarget` through `CardSheetContext`, and renders `{children}` then `{target ? <CategoryTransactionsSheet key={`${target.scope}:${target.userId}:${target.categoryId}:${target.figure}`} target={target} onClose={() => setTarget(null)} /> : null}`.
  `CategoryTransactionsSheet` is the panel's state, fetch effect, `owner` and list moved whole (its props come from `target`), rendered as `<Sheet sheetId="card-transactions" title={target.title} description={…} footer={…} onClose={onClose}>`:
  - description: `<><span>{monthLabel(target.month)}</span> · <span className="font-semibold text-ink">spent {formatCents(spentCents)}{limitCents !== null ? ` of ${formatCents(limitCents)}` : ''}</span></>` from `sheetFigure(target, rowOf(target.scope, target.userId, target.categoryId))`; its text reads `March 2026 · spent $50.00 of $200.00`, or `March 2026 · spent $42.17` with no limit;
  - body: `{target.history ? <div className="pt-3"><CategoryHistoryStrip … narrow /></div> : null}`, then the panel's notice, loading, error, empty line and list exactly as it renders them today (rows stay `ListRow` with the kebab in this task);
  - footer: the existing **Open in Transactions** `Link` (same `transactionsHref` call), class `buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')`, only when loaded with rows; otherwise no `footer`.
  `CategoryHistoryStrip` gains `narrow?: boolean`: `grid-cols-3` at every width instead of `grid-cols-3 sm:grid-cols-6`.
  The three View transactions buttons (the leaf card's `action`, `ChildBreakdownRow`'s and `DirectSpendRow`'s `trailing`): `aria-haspopup="dialog"`, no `aria-expanded`, text `View transactions`, `onClick` opening the Sheet with the row's `scope`, `userId` and `month` plus, respectively: `{ categoryId: row.categoryId, title: row.categoryName, categoryName: row.categoryName, figure: 'category', history: true }`; `{ categoryId: child.categoryId, title: `${parentName} › ${child.categoryName}`, categoryName: child.categoryName, figure: 'category', history: false }` (`ChildBreakdownRow` gains `parentName: string`, passed `row.categoryName`); `{ categoryId: row.categoryId, title: `${row.categoryName} › Not in a sub-category`, categoryName: 'Not in a sub-category', figure: 'direct', history: false }`. `txOpen`, `leafTxOpen`, the inline `<li className="bg-surface-2">` panels and the leaf branch under the card are deleted.
  `BudgetCategoryCard`: `isOpen = hasChildren && groupState.isOpen(row.categoryId)` (the strip and `lg:col-span-3` follow it, so a leaf card never changes shape); the hash effect keeps its one-shot and its `replaceState`, opens a parent's group, and opens nothing for a leaf (decision 7). The docblocks of the card, the two rows, the Sheet and RowFixHost say the transactions open in the Sheet, one line each citing `v1.58.0 (design §2)`.

- [ ] **Step 1: Name the dialogs the second one makes ambiguous**

With the Sheet open, an unnamed `screen.getByRole('dialog')` matches two dialogs. In `describe('BudgetsClient — fixing a row from the card')`, name it wherever it is unnamed: `screen.getByRole('dialog', { name: /^Category for/ })` (:1390, :1435, :1439) and `screen.getByRole('dialog', { name: /^Split Phonemart/ })` (:1413, :1457). Nothing else in those tests changes.

- [ ] **Step 2: Write the failing tests**

Replace the two v1.57.1 hash tests (`'a card named by the URL hash opens itself on mount'`, `'clears the hash after opening the card from it, keeping the path and query, and a remount does not reopen it'`) with the two below; extend `'a card whose rows all move away keeps its open dialog until it is closed'`; add the rest in a new `describe('BudgetsClient — the transactions sheet (v1.58.0)')`. Each fails first because View transactions expands the list under the card. Read a Sheet's description with `const described = (name: string) => document.getElementById(screen.getByRole('dialog', { name }).getAttribute('aria-describedby')!)!.textContent;`.

```tsx
/** Review Focus 1 (extended): before the rerender the Sheet reads the archived card's own figure; after it, nothing. */
// …the existing body, plus: before the rerender, described('Groceries') === 'March 2026 · spent $42.17';
// after it, the Sheet 'Groceries' is still open and described('Groceries') === 'March 2026 · spent $0.00'.

it('a leaf card named by the URL hash is where the page lands; its sheet does not open and the hash is cleared', async () => {
  // window.history.replaceState(null, '', '/budgets?month=2026-03#budget-card-household-h-1'); mockClear; renderBudgets(null);
  // await waitFor(() => expect(window.location.hash).toBe(''));
  // { path, query } === { path: '/budgets', query: '?month=2026-03' }; queryByRole('dialog') null;
  // categoryTransactionsAction not called; finally replaceState(null, '', '/')
});

it('a parent card named by the URL hash opens its breakdown once, and a remount leaves it closed', async () => {
  // '#budget-card-household-h-10' with household={[housingGroupRow()]}: 'Hide breakdown' present, no dialog, hash '';
  // cleanup(); render again: 'View breakdown' present
});

describe('BudgetsClient — the transactions sheet (v1.58.0)', () => {
  it('View transactions on a leaf card opens a sheet named for the category, with the month and the spend against the limit, and the card keeps its shape', async () => {
    // await renderWithRows([panelRow()]): dialog 'Groceries' with aria-modal 'true';
    // described('Groceries') === 'March 2026 · spent $50.00 of $200.00';
    // the button still reads 'View transactions' and has aria-haspopup 'dialog', no aria-expanded;
    // document.getElementById('budget-card-household-h-1')!.className does not contain 'lg:col-span-3';
    // within(sheet).findByText('Phonemart'); within(sheet).getByRole('link', { name: 'Open in Transactions' })
  });

  it("a sub-category row's sheet names its parent and reads the sub-category's own figure; Not in a sub-category reads spend with no limit", async () => {
    // housingGroupRow() with directSpentCents 30000 and spentCents 180000; View breakdown;
    // the Rent row's View transactions -> described('Housing › Rent') === 'March 2026 · spent $1,000.00 of $1,000.00',
    //   categoryTransactionsAction last called with categoryId 11; Close;
    // the Not in a sub-category row's View transactions -> described('Housing › Not in a sub-category') === 'March 2026 · spent $300.00',
    //   last called with categoryId 10; findByText('No transactions in Not in a sub-category this month.')
  });

  it('the header figure follows the card when a fix revalidates the page, and the sheet stays open', async () => {
    // render with household={[makeRow()]} and categories, open; rerender with makeRow({ spentCents: 750, remainingCents: 19250, pct: 4 })
    // -> described('Groceries') === 'March 2026 · spent $7.50 of $200.00'; categoryTransactionsAction still called once
  });

  it('Escape, Close and the backdrop each close the sheet, and focus goes back to View transactions', async () => {
    // three openings; after each close: queryByRole('dialog') null and activeElement === the View transactions button;
    // Escape is a keyDown on the dialog; the backdrop is getByTestId('card-transactions-backdrop')
  });

  it('a dialog opened from a sheet row sits above the sheet, not inside it, and Cancel leaves the sheet open with focus on the row', async () => {
    // open the row menu (/Actions for Phonemart/), Change category…;
    // const recat = getByRole('dialog', { name: /^Category for/ }); sheet.contains(recat) === false;
    // sheet.compareDocumentPosition(recat) & Node.DOCUMENT_POSITION_FOLLOWING is truthy;
    // Cancel -> the Sheet is still open and activeElement === the row's menu trigger
  });

  /** Review Focus 2. */
  it('after the Always ask dialog that follows a category change closes, focus is back in the sheet', async () => {
    // Change category… -> 'Always ask about PHONEMART 884' -> Save category -> the Always ask dialog -> its Cancel
    // -> activeElement === getByRole('dialog', { name: 'Groceries' })
  });

  /** Review Focus 2. */
  it('a fix that takes the focused row off the list keeps focus in the sheet', async () => {
    // second categoryTransactionsAction result { rows: [], splits: {} }; Change category… to Phone; Save category;
    // await findByText('No transactions in Groceries this month.');
    // activeElement === getByRole('dialog', { name: 'Groceries' })
  });

  /** Review Focus 4. Fails first, and again if RowFixHost's dialogs ever render inside the Sheet's panel. */
  it('a category picker in a dialog opened from the sheet stays open when the page scrolls, whatever clips the sheet', async () => {
    // await renderWithRows([panelRow()]); const sheet = getByRole('dialog', { name: 'Groceries' });
    // What a browser computes for a clipping, fixed-holding Sheet away from the centred dialog (jsdom computes no classes):
    // sheet.style.transform = 'translateX(0px)'; const body = getByTestId('card-transactions-body'); body.style.overflowY = 'auto';
    // vi.spyOn(body, 'getBoundingClientRect') -> { top: 0, bottom: 800, left: 900, right: 1280, width: 380, height: 800, x: 900, y: 0 };
    // open Change category…; const input = within(getByRole('dialog', { name: /^Category for/ })).getByRole('combobox');
    // vi.spyOn(input, 'getBoundingClientRect') -> { top: 300, bottom: 330, left: 300, right: 600, width: 300, height: 30, x: 300, y: 300 };
    // fireEvent.focus(input): a listbox; fireEvent.scroll(window): the listbox is still there
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/app/budgets-client.test.tsx`
Expected: the new and extended tests FAIL; everything else PASSES.

- [ ] **Step 4: Implement** as in Interfaces.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx tests/app/budgets-page.test.tsx tests/components/sheet.test.tsx tests/ops`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/budgets/budgets-client.tsx" tests/app/budgets-client.test.tsx
git commit -m "feat(budgets): View transactions opens the card's rows in a sheet

- leaf cards, sub-category rows and Not in a sub-category
- header: category, month, spent against the limit, live after a fix
- the page behind keeps its shape; the hash never opens the sheet"
```

---

### Task 3: Each row is one button that opens its fixes, with a tag (design §3, §4)

**Files:**
- Modify: `src/components/ui/RowMenu.tsx` (`RowMenu` :66-202)
- Modify: `src/app/(app)/budgets/budgets-client.tsx` (the list inside `CategoryTransactionsSheet`)
- Modify: `src/app/(app)/help/content.tsx` (the Budgets paragraph :348-354), `CHANGELOG.md` (`## Unreleased`)
- Test: `tests/unit/row-menu.test.tsx`, `tests/app/budgets-client.test.tsx`
- Pins (pass before and after; do not edit): every existing test in `tests/unit/row-menu.test.tsx`; `'a rule-filed row names the rule, a guessed row says guess, a hand-set row says nothing'` (the three tags' words, counted by text).

**Interfaces:**
- Produces (`RowMenu.tsx`): `RowMenu` gains
  ```ts
  /**
   * v1.58.0 (design §3). The whole row is the button that opens the menu, in place of the ⋯ kebab.
   * `content` is phrasing content only (spans, an icon): it renders inside the <button>, and the menu renders
   * beside the button, never inside it. `describedBy` is the id of an element inside `content`, read after the label.
   */
  row?: { content: ReactNode; describedBy?: string };
  ```
  With `row`: the wrapper `<span>` is `flex` instead of `inline-flex`; the trigger keeps its `ref`, `type`, `aria-haspopup`, `aria-expanded`, `aria-label={label}` and `onClick`, adds `aria-describedby={row.describedBy}`, renders `row.content`, and uses a new `ROW_TRIGGER_CLASS = 'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:-outline-offset-2 sm:px-5'`. Without `row`, nothing changes.
- Produces (`budgets-client.tsx`):
  ```ts
  /** v1.58.0 (design §4). The tag on a row a rule or a guess filed; null for a hand-set row. */
  function filedTag(row: CategoryPanelRow): string | null
  /** v1.58.0 (design §3). One row of a card's Sheet: the whole row opens Change category, Split and More in Transactions. */
  function FixRow({ row, categoryId, splits, owner }: { row: CategoryPanelRow; categoryId: number; splits: CategoryPanelResult['splits']; owner: RowFixOwner }): React.ReactElement
  ```
  `filedTag` is the panel's `detail` expression moved whole. `FixRow` renders `<li className="border-b border-line last:border-b-0">` holding `<RowMenu label={`Fix ${row.merchant}, ${row.date}, ${formatCents(row.amountCents)}`} row={{ content, describedBy: tag ? tagId : undefined }}>` with the three menu items exactly as today (the same `fixes.recategorize` and `fixes.split` calls, the same `RowMenuLink` href). `tagId` comes from `useId()`. `content`:
  ```tsx
  <>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm font-semibold text-ink">{row.merchant}</span>
      <span className="truncate text-xs text-subtle">{row.date}</span>
      {tag ? (
        <Pill tone="neutral" className="mt-0.5 max-w-full self-start">
          <span id={tagId} className="min-w-0 truncate">{tag}</span>
        </Pill>
      ) : null}
    </span>
    <span className="money shrink-0 text-sm font-semibold text-ink"><Money cents={row.amountCents} /></span>
    <ExpandIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-muted" />
  </>
  ```
  The list becomes `<ul className="flex flex-col">` of `<FixRow key={`${row.id}:${row.splitId ?? 0}`} … />`. Remove the `ListRow` import only if nothing else in the file uses it.
- Copy, help (`content.tsx`, replacing the paragraph that starts `Open a card&rsquo;s transactions and each row has a menu`):
  > <B>View transactions</B> opens a card&rsquo;s rows in a panel: over the page on a phone, beside it on a wider screen, and the page stays where it was. Its header says what was spent against the limit, and the figure updates as you fix rows. Tap a row for <B>Change category&hellip;</B>, <B>Split&hellip;</B> or <B>More in Transactions</B>. A row a rule or a guess filed carries a tag saying so, and changing its category offers to change this transaction only, to file that merchant the same way from now on, or to always ask about it. <B>Open in Transactions</B>, at the foot of the panel, lists exactly the rows the card adds up, with a way back to the same card.
- Copy, CHANGELOG under `## Unreleased`:
  ```md
  ### Changed

  - Budgets: View transactions opens a card's rows in a panel instead of under the card, so the page
    stays where it was. On a phone the panel fills the screen; on a wider screen it sits at the right
    with the page beside it. Its header names the category, the month and what was spent against the
    limit, and the figure updates after each fix.
  - Budgets: each row in that panel is one button with an arrow at its end, and tapping it offers
    Change category, Split and More in Transactions. A row a rule or a guess filed carries a small tag
    saying so.
  - Budgets: a category with no sub-categories shows its six-month history at the top of that panel;
    View breakdown still opens a parent's history and sub-categories on the card.
  ```

- [ ] **Step 1: Rename the row trigger in the existing Budgets tests**

In `tests/app/budgets-client.test.tsx` replace every `/Actions for Phonemart/` with `/^Fix Phonemart/`, `/Actions for Phonemart on 2026-03-12/` with `/^Fix Phonemart, 2026-03-12/`, and `/Actions for Phonemart on 2026-03-19/` with `/^Fix Phonemart, 2026-03-19/`. Nothing else in those tests changes.

- [ ] **Step 2: Write the failing tests**

`tests/unit/row-menu.test.tsx`, a new describe (each fails first because `row` is ignored and the kebab renders):

```tsx
describe('v1.58.0: the whole row as the trigger', () => {
  it('is one button holding the row, named by the label, and the menu opens beside it, not inside it', () => {
    // <RowMenu label="Fix Phonemart, 2026-03-12, -$42.17" row={{ content: <span>Phonemart</span> }}>…two RowMenuButtons…</RowMenu>
    // button 'Fix Phonemart, 2026-03-12, -$42.17': textContent contains 'Phonemart' and not '⋯'; aria-haspopup 'menu';
    // click -> a menu; button.contains(menu) === false; menu.style.position === 'fixed'
  });
  it('is described by the part of the row it names, and Escape hands the key back handled with focus on the row', () => {
    // row={{ content: <span id="tag-1">Set by guess</span>, describedBy: 'tag-1' }}: aria-describedby 'tag-1';
    // open; fireEvent.keyDown(menu, { key: 'Escape' }) returns false (default prevented); activeElement === the row button
  });
});
```

`tests/app/budgets-client.test.tsx`, in `describe('BudgetsClient — the transactions sheet (v1.58.0)')` (each fails first because the row is a ListRow with a kebab):

```tsx
it('each row is one button named for the fix, holding its tag and a chevron and no other control', async () => {
  // await renderWithRows([panelRow()]); const row = await findByRole('button', { name: 'Fix Phonemart, 2026-03-12, -$42.17' });
  // aria-haspopup 'menu'; document.getElementById(row.getAttribute('aria-describedby')!)!.textContent === 'Set by rule: PHONEMART (contains)';
  // row.querySelectorAll('a, button, input, select, textarea, [tabindex]').length === 0;
  // row.lastElementChild is an <svg> with aria-hidden 'true';
  // within(getByRole('dialog', { name: 'Groceries' })).queryByText('⋯') === null
});

it('a hand-set row carries no tag and no description', async () => {
  // panelRow({ source: 'manual', filedBy: null }): the row button has no aria-describedby; queryByText(/^Set by/) === null
});

/** Review Focus 3. Fails first, and again if useModal stops ignoring a key already handled inside. */
it("Escape on a row's open menu closes the menu and leaves the sheet open", async () => {
  // click the row; keyDown Escape on getByRole('menu') -> no menu, the dialog 'Groceries' still open, activeElement === the row
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/unit/row-menu.test.tsx tests/app/budgets-client.test.tsx`
Expected: the new tests and the renamed ones FAIL; the pins PASS.

- [ ] **Step 4: Implement** RowMenu's `row`, `filedTag`, `FixRow`, then the help paragraph and the CHANGELOG entry, as in Interfaces.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/row-menu.test.tsx tests/app/budgets-client.test.tsx tests/app/help.test.tsx tests/lib/changelog.test.ts tests/ops`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/RowMenu.tsx "src/app/(app)/budgets/budgets-client.tsx" "src/app/(app)/help/content.tsx" CHANGELOG.md tests/unit/row-menu.test.tsx tests/app/budgets-client.test.tsx
git commit -m "feat(budgets): tap a row in the sheet to fix it; filed rows carry a tag

- RowMenu can take the whole row as its trigger, no kebab
- rule and guess rows show their tag; hand-set rows none
- help and release notes"
```

---

## After Task 3: the full run, the review and the visual check

**Full run (once):** `npx vitest run` exits 0 (a lone `Timeout calling "onTaskUpdate"` failure is the known flake: rerun that file alone).

**The review (exactly one).** One Opus reviewer, given `git diff f792b52..HEAD`, this plan and the design, asked to check:
- correctness: the Sheet lists the rows of the card or row it was opened from (category id, scope, person, month; the parent's own id for Not in a sub-category); the header figure is read live and matches what the card or row shows (a sub-category's own; `directSpentCents` for the direct bucket); the list refetches after a saved fix and not after a refused one; focus returns to the row, or into the Sheet when the row or the opener has gone; no interactive element inside a row button; the dialogs are siblings of the Sheet;
- accessibility: the keyboard path (View transactions → Sheet → row → menu → dialog, and back), names and descriptions, the Tab trap, Escape closing only the innermost layer, the counted scroll lock, reduced motion (no `motion-keep`, no transform at rest);
- phone layout: no horizontal overflow at 390px with a long merchant and a long rule tag; the amount and chevron never squeezed out; safe-area padding.
Not reviewed: wording, help, the CHANGELOG. One fix round for Important findings, committed as `fix(budgets): review round` with bullets; re-review only a non-trivial fix.

**The visual check (one round, plus one confirming round).** Reuse `npm run smoke`'s boot (`scripts/smoke-test.mjs`): after `npm run build`, a scratchpad script migrates a fresh temp database, calls `seedFixtureDb` (`scripts/smoke-fixtures.mjs`), inserts invented categories (a parent with two children, a leaf), limits, one category rule and about ten invented transactions this month (rule, guess and hand-set; one long merchant; one long rule pattern), and starts `.next/standalone/server.js` with the smoke script's environment. Playwright sets the `bt_session` cookie and opens `/budgets`; screenshots with the Sheet open (a leaf card's, and a sub-category row's) at 390x844 and 1280x800, light and dark (`localStorage['bt-theme']`). Look for: the chevron visible on every row; nothing overflowing; the header figure readable; the drawer leaving the page visible on desktop; a row's menu placed under its row. Fix what they show in one batch (`fix(budgets): sheet layout` with bullets) and take one confirming round. Screenshots stay in the scratchpad. If the boot needs more than this, skip the check and say so.

---

### Task 4: Release v1.58.0

**Files:** Modify `tests/ops/docker.test.ts` (`'MUST-7.1: the 1.57.2 release'` and every remaining `toBe('1.57.2')`), `CHANGELOG.md`, `package.json`, `package-lock.json`.

- [ ] **Step 1: Update the release guard first.** Replace `it('MUST-7.1: the 1.57.2 release', …)` with a `1.58.0` test of the same shape (package.json, both lockfile fields, the dated heading below `## Unreleased` and above `## [1.57.2]`, Unreleased emptied), whose section checks are:

```ts
    const current = changelog.slice(changelog.indexOf('## [1.58.0]'), changelog.indexOf('## [1.57.2]'));
    expect(current).toMatch(/### Changed/);
    expect(current).not.toMatch(/### Added/);
    expect(current).toMatch(/View transactions opens a card's rows in a panel/);
    expect(current).toMatch(/small tag/);
    expect(current).toMatch(/six-month history/);
    expect(current).not.toMatch(/!/);
    // Unreleased was emptied into this section.
    expect(changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('## [1.58.0]'))).not.toMatch(/small tag/);
```

and add, directly after it, `it('MUST-7.1: the 1.57.2 release is still recorded intact (append-only discipline)', …)` in the shape of the 1.57.0 one: `## [1.57.2] - <its date>` present and before `## [1.57.1]`, with the section phrases the replaced 1.57.2 test asserted. Then change every remaining `toBe('1.57.2')` to `toBe('1.58.0')`; `grep -c "toBe('1.57.2')" tests/ops/docker.test.ts` → `0`.

- [ ] **Step 2:** `npx vitest run tests/ops/docker.test.ts` → FAIL on the version pins and the missing `## [1.58.0]` heading.

- [ ] **Step 3: Date the notes and bump the version.** Insert `## [1.58.0] - <output of date +%F>` and a blank line between `## Unreleased` and the notes, so `## Unreleased` is empty again. `package.json` and both `"version"` fields near the top of `package-lock.json`: `1.57.2` → `1.58.0`. If `package-lock.json` changed anywhere beyond those two fields, verify with `npx npm@10.9.9 ci --dry-run`. Run `npx vitest run tests/ops/docker.test.ts tests/lib/changelog.test.ts` → PASS.

- [ ] **Step 4: The release gate.**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
rm -rf .next && npm run build
npm run smoke
```

Expected: vitest exit 0; tsc clean; build exit 0 with the 8 known Turbopack warnings; smoke passes with the 2 known Windows skips.

- [ ] **Step 5: Commit and push.**

```bash
git add CHANGELOG.md package.json package-lock.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.58.0

- a card's transactions open in a sheet; the page stays put
- tap a row to fix it; filed rows carry a tag"
git push origin main
```

- [ ] **Step 6:** `gh run list --workflow test.yml --limit 3`, then `gh run watch <id> --exit-status` → `Test suite` succeeds on the pushed SHA. Do not tag until it does; fix forward on a failure, never force-push.

- [ ] **Step 7:** `git tag -a v1.58.0 -m "v1.58.0" <the SHA Test suite passed on>`, `git push origin v1.58.0`, `gh run list --workflow release-image.yml --limit 3`, `gh run watch <id> --exit-status` → `Release image` for v1.58.0 succeeds. Never move or delete a tag.
