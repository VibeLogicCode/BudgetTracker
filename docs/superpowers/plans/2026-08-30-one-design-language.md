# One design language, across every page — implementation plan (v1.19.0)

> **For agentic workers:** five lanes. Lane 0 lands FIRST and defines everything the others use.
> No Playwright. Vitest + `npx tsc --noEmit`.

**Goal:** every page in the app is built from the same small set of components, so the product reads
as one thing rather than nine pages that each invented their own card.

**Why this is one release and not four.** Converting a page at a time leaves the app speaking two
languages at once, which looks worse than either language alone. The system lands first; every page
converts against it before anything ships.

**Spec:** this file, plus the design references the owner supplied (a card-based budget grid, a
date-grouped transaction list, a review queue with confirm-progress, a dashboard with deltas).
Those references are gitignored and excluded from the typecheck — read them, never import from them.

## Global constraints

- No Playwright. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths or real statement data in code, comments,
  tests, fixtures or commit messages. Invented sample data only.
- Conventional commits. NO `Co-Authored-By`, no Claude attribution. Never change git identity.
- `no new Date()` in `src/lib/**`. Integer cents, ISO dates. 44px minimum touch targets.
- Never `git stash`, never `git add -A`, never touch `.tmp-data/`, never create a worktree, never
  copy or delete anything under `node_modules`.
- Lanes run NO git commands. The orchestrator stages and commits.
- **No migration.** Nothing in the database changes.
- Keep every existing test green. The suite is ~4,750 tests and the ops guards in `tests/ops/` are
  the contract — `row-controls`, `table-layout`, `client-bundle`, `use-server-exports`,
  `visibility-invariants`, `loan-invariants` all still apply.

## Rulings

- **D1. One component per idea, no local variants.** If a page needs a card with a number and a
  bar, it imports `MetricCard`. It does not write its own. A page that needs something the shared
  component cannot express reports it rather than forking it.
- **D2. `lucide-react` is adopted; shadcn and `@base-ui/react` are not.** Icons are a real gap.
  A second component system beside our own `Card`/`Button`/`Table`/`AutoSave` primitives is how a
  design language breaks in half, which is the entire problem this release exists to fix.
- **D3. Their tokens map to ours; theirs are never copied.** `bg-card` → `--surface`,
  `text-muted-foreground` → `--muted`/`--subtle`, `bg-destructive` → `--negative`,
  `bg-success`/`bg-primary` → `--positive-solid`/`--accent`. The references are single-theme; we
  ship light and dark from one set of tokens and that must keep working.
- **D4. A bar clamps at 100%; the pill tells the truth.** A category at 138% shows a full bar and a
  pill reading `138%`. A bar that overflows its track is a rendering bug in every browser.
- **D5. Three states, one scale, everywhere:** under 80% is calm, 80-100% is warning, over 100% is
  negative. 80 is already the app's `budget_threshold` default, so the UI and the alerts agree.
- **D6. No horizontal scrollbars.** Chip rows wrap or collapse into a `+n` expander. The reference
  scrolls its chips only because it lists every category flat; ours has a parent/child tree, so
  chips show TOP-LEVEL categories only (about eight) and the long tail stays in a picker.
- **D7. Containers differ by what a page does; components never differ.** Budgets is a card grid
  because a category is a state you assess. Transactions stays a table on desktop because a ledger
  is scanned down a column. Both use the same bars, pills, money colours and icons.

## Lane 0 — the system (MUST land before lanes 1-4 start)

**Files:** create `src/components/ui/MetricCard.tsx`, `src/components/ui/ProgressBar.tsx`,
`src/components/ui/Pill.tsx`, `src/components/ui/SectionHeader.tsx`, `src/components/ui/ListRow.tsx`,
`src/components/ui/icons.tsx`; modify `src/components/ui/StatTile.tsx`, `src/components/ui/Card.tsx`,
`src/app/globals.css`, `package.json`; create `tests/unit/metric-card.test.tsx`,
`tests/unit/list-row.test.tsx`.

Install `lucide-react` (ruling D2). It must be a plain dependency and must not break the offline
invariant — icons are bundled SVG components, no network fetch, and `tests/ops/csp.test.ts` /
`scanner-assets.test.ts` still pass.

**Produces — lanes 1-4 consume these names verbatim:**

```tsx
// ProgressBar: clamps the bar, never the label (ruling D4/D5)
export type BarTone = 'calm' | 'warning' | 'over';
export function ProgressBar(props: {
  pct: number;              // true percentage; the fill is clamped internally
  tone?: BarTone;           // omit to derive from pct via the D5 scale
  label: string;            // accessible name, e.g. "Groceries budget used"
  className?: string;
}): JSX.Element;

// Pill: the verdict, top-right of a card
export function Pill(props: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'negative';
  className?: string;
}): JSX.Element;

// MetricCard: the app's card. Generalised OUT OF GoalCard -- read that file first.
export function MetricCard(props: {
  icon?: React.ReactNode;          // rendered inside the 40px rounded tile
  title: React.ReactNode;
  subtitle?: React.ReactNode;      // "6 categories · 2 over" -- say something real, not a count
  pill?: React.ReactNode;
  value: React.ReactNode;          // the hero number
  compare?: React.ReactNode;       // "of $500.00", small and muted, same baseline
  bar?: React.ReactNode;           // a ProgressBar
  status?: React.ReactNode;        // "$87.65 remaining" / "$173.10 over budget"
  action?: React.ReactNode;        // footer strip behind a hairline
  children?: React.ReactNode;      // expanded content, below the footer strip
  className?: string;
}): JSX.Element;

// SectionHeader: small-caps title with a right-aligned action
export function SectionHeader(props: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): JSX.Element;

// ListRow: one line in any list -- transactions, review, subscriptions, receipts
export function ListRow(props: {
  direction?: 'in' | 'out';        // renders the circled arrow; omit for a non-money row
  icon?: React.ReactNode;          // used instead of the arrow when direction is absent
  title: React.ReactNode;
  meta?: React.ReactNode;          // date, category, account -- small and muted, under the title
  amount?: React.ReactNode;        // right-aligned, tabular
  trailing?: React.ReactNode;      // a control: a picker, a menu, a confirm button
  leading?: React.ReactNode;       // a checkbox
  className?: string;
}): JSX.Element;
```

`StatTile` gains `delta?: React.ReactNode` and `deltaTone?: 'positive' | 'negative' | 'default'`,
rendered under the value — this is the `+2.4% vs last month` line the dashboard reference has and
we do not. Everything else about `StatTile` stays.

**The shell tightening**, in `Card.tsx` and `globals.css`: card padding drops to `p-4 sm:p-5`
(from `p-5 sm:p-6`), `.card` loses `box-shadow` in favour of the hairline border alone, and the
page-level stack gap drops from `gap-6` to `gap-4 sm:gap-5`. This is most of the "wasted space"
complaint and it lands on every page at once, which is the point.

`icons.tsx` re-exports the lucide icons the app uses under house names, plus a
`categoryIcon(name: string)` helper mapping a top-level category to an icon with a sensible
fallback. One import site, so an icon swap is a one-file change.

Tests: `MetricCard` renders each slot and omits the footer strip when `action` is absent;
`ProgressBar` clamps the fill at 100% while reporting the true `aria-valuenow`, and derives the
right tone at 79/80/100/138; `ListRow` renders the in/out arrow and puts the amount last.

Run `npx vitest run tests/unit tests/ops` and `npx tsc --noEmit`.
Commit: `feat(ui): one card, one bar, one row -- the components every page is built from`.

## Lane 1 — Budgets and Goals

**Files:** `src/app/(app)/budgets/budgets-client.tsx`, `src/app/(app)/goals/goals-client.tsx`,
`src/components/GoalCard.tsx`; tests `tests/app/budgets-client.test.tsx`,
`tests/app/budgets-rollover-ui.test.tsx`, `tests/app/goals-client.test.tsx`,
`tests/components/GoalCard.test.tsx`.

Budgets stops being a table at every width and becomes a `MetricCard` grid: `grid gap-4
md:grid-cols-2 lg:grid-cols-3`, the same grid `goals-client.tsx:99` already uses. Each top-level
category is a card — icon, name, `N categories · M over` subtitle, percentage pill, spent as the
hero with `of $X` beside it, a `ProgressBar`, and `$X remaining` / `$X over budget`. The footer
action is `View breakdown`, which expands the children as `ListRow`s with their own small bars, and
a child expands to its own transactions.

**An expanded card spans the full grid row** (`lg:col-span-3` when open), so children and
transactions are not squeezed into a third of the width.

Everything the table did must survive: the limit input, roll-over, the v1.18.0 collapse state and
`localStorage` keys, the parent-limit warning (ruling U6 of the previous plan — WARN, never block),
the zero state, Copy previous month, and the savings target control. Limits move behind an
**Edit limits** toggle that turns the grid into a compact name + input + roll-over list; that is
the one thing the table did better and it keeps its own mode.

`GoalCard` becomes a thin wrapper over `MetricCard` — same visual result, one implementation.

Transactions inside a category is a new read: add it to `src/lib/budgets.ts` ONLY if nothing
existing serves it, keep it viewer-scoped exactly as `categorySpend` is, and take the smallest
query that works.

Run `npx vitest run tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx tests/app/budgets-page.test.tsx tests/app/goals-client.test.tsx tests/components/GoalCard.test.tsx tests/ops` and `npx tsc --noEmit`.
Commit: `feat(budgets): budgets and goals speak one card language`.

## Lane 2 — Transactions and the review queue

**Files:** `src/app/(app)/transactions/transactions-client.tsx`,
`src/app/(app)/transactions/page.tsx`, `src/app/(app)/transactions/actions.ts`; tests
`tests/app/transactions-client.test.tsx`, `tests/app/transactions-page.test.tsx`,
`tests/app/transactions-actions.test.ts`.

1. **Three tiles** above the list — Money in, Money out, Net for the filtered range. `StatTile`.
2. **Chip filters** (ruling D6): top-level categories only, wrapping, with a `+n` expander. No
   horizontal scroll at any width. `All` is the default chip. The remaining filters — account,
   person, dates, uncategorised only, hide transfers — stay behind the existing `Filters (N)`
   disclosure. Do not change any query-string field name; `page.tsx` parses them.
3. **Date grouping**: rows group under a `SAT, AUG 29` header, one card per day. The table stays
   the desktop layout (ruling D7) — the day header becomes a full-width `<tr>` inside it, and the
   phone stacking already in `.data-table--stack` continues to work.
4. **Row rhythm**: the circled in/out arrow, merchant bold, category with its icon beneath, amount
   right and positive-toned when money came in. Every existing control stays — checkbox, category
   picker, person, row menu, the note/loan/apply-all editors.
5. **Review mode** gains what the reference has and we lack: a **progress bar with `N/M
   confirmed`**, an **Accept all suggestions** action for every row whose source is `bayes` with a
   guess, and a per-row **confirm** button that is disabled while the row has no category. Accept
   all reuses the existing `acceptGuessAction` semantics — it must teach the categorizer exactly as
   a single accept does (v1.14.1 ruling R3), and must refuse for a self-scoped viewer like every
   other review action.

Run `npx vitest run tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx tests/app/transactions-actions.test.ts tests/ops` and `npx tsc --noEmit`.
Commit: `feat(transactions): grouped by day, filtered by chips, and a review queue you can finish`.

## Lane 3 — Dashboard

**Files:** `src/app/(app)/dashboard/page.tsx`, and the dashboard card components it renders
(`src/components/*Card.tsx` for loans, who-owes-us, updates, getting-started — convert each to
`MetricCard`/`ListRow`/`SectionHeader` as its shape suggests); tests `tests/app/dashboard.test.tsx`,
`tests/components/*.test.tsx` for the cards you touch.

1. Every tile gains a **delta** — `+2.4% vs last month` — computed from the trend data the page
   already fetches. Spending up is negative-toned, income up is positive-toned; be careful that the
   sign and the tone agree, because "spending rose" is bad news shown in red.
2. Every section gets a `SectionHeader` with a right-aligned action (`Add goal`, `Manage`, `Upload`).
3. Anything with a date gets a **days-remaining pill** — `92d`, `22d`, and `⚠ 7d` in warning tone
   inside a week. Upcoming bills, expiring items, goal target dates.
4. Goals on the dashboard render the same `MetricCard` as the Goals page.

Do not change what the dashboard computes, only how it reads. The v1.17.0 month filter, the
"as of today" notes and the self-viewer gating all stay exactly as they are.

Run `npx vitest run tests/app/dashboard.test.tsx tests/components tests/ops` and `npx tsc --noEmit`.
Commit: `feat(dashboard): tiles that say which way things moved`.

## Lane 4 — everything else, so no page is left behind

**Files:** `src/app/(app)/warranties/warranties-client.tsx`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx`,
`src/app/(app)/reports/reports-client.tsx`, `src/app/(app)/import/import-client.tsx`,
`src/app/(app)/settings/accounts/accounts-manager.tsx`,
`src/app/(app)/settings/managers/managers-client.tsx`,
`src/app/(app)/settings/users/users-manager.tsx`,
`src/app/(app)/settings/item-types/item-types-manager.tsx`,
`src/app/(app)/settings/notifications/notifications-client.tsx`, plus their existing tests.

This lane is what stops the app speaking two languages. Every page here adopts the tightened shell,
`SectionHeader`, `Pill`, `ProgressBar` and lucide icons — even where the page keeps its table.

- **Settings → Accounts** converts to a `MetricCard` grid: one card per account, balance as the
  hero, type as the pill, and the staleness note as the status line. Its table needed a `60.5rem`
  minWidth for nine columns; cards remove that entirely.
- **Warranties** keeps its table (ruling D7 — sorted by soonest expiry, scanned down a column) but
  gains the days-remaining pill, the status pill and icons. Its detail page uses `MetricCard` for
  the summary and `ListRow` for the linked-transactions ledger.
- **Reports** keeps its charts and tables; it adopts `SectionHeader` and the tightened shell.
- **Settings → Managers, Users, Item types, Notifications; Import** keep their tables and adopt the
  shell, headers and icons only.

Run `npx vitest run tests/app tests/ops` and `npx tsc --noEmit`.
Commit: `feat(ui): settings, warranties, reports and import join the same language`.

## Release (after all five lanes)

`package.json` → `1.19.0` (and `lucide-react` in dependencies); `tests/ops/docker.test.ts` gains a
1.19.0 block and renames the 1.18.0 one; `CHANGELOG.md` gains `## [1.19.0]` stating there is no
migration. Then the full `npx vitest run`, `npx tsc --noEmit`, tag `v1.19.0`, image.
