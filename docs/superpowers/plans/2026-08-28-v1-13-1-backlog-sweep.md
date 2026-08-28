# v1.13.1 backlog sweep — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 23 open backlog items left by v1.10.0 through v1.13.0 — the unreachable empty
state, the update card that needs a refresh, two tables one long value away from breaking, three
accessibility gaps, an uncapped dashboard list, two bill surfaces that lie about a bill, the last
un-gated rule delete in ruling R4's family, an over-scoped digest fallback, an O(n) ownership check,
and five small self-scope and import asymmetries — with **no migration and no new dependency**.

**Architecture:** All surgery on existing functions and components. Work is grouped by the FILE it
touches, never by the item it fixes, so two agents never open the same file. Three items (C, D, F)
resolve to no code and are closed in the release task with their reason recorded.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6.0.3, Drizzle ORM 0.45.2 over
better-sqlite3, Tailwind 4, Vitest 3 + `@testing-library/react` + jsdom (per-file
`// @vitest-environment jsdom`; the suite default is `node`, and `globals: false` means every file
imports `describe`/`it`/`expect` from `'vitest'` explicitly).

**Spec:** `docs/superpowers/specs/2026-08-28-v1-13-1-backlog-sweep-design.md` — read it first.
Rulings **P1–P22** are the planner's and are cited by number throughout. There are no owner rulings
in this release; the standing rulings from v1.12.1 and v1.13.0 (R1–R11) are in force and are not
reopened.

---

## Standing rules for every implementer

Copy these into your working memory before you touch anything. They are not negotiable.

> Never run `git stash`. Never override git identity. Never add a `Co-Authored-By` line or any
> Claude/AI attribution to a commit. Run vitest in the FOREGROUND with a 600000 ms timeout, never in
> the background. Never open or delete `.tmp-data/`. Never edit `drizzle/**` or `src/db/schema.ts` —
> there is no migration in this release, and if you think you need one, STOP and report it instead.
> Never write an owner name, an employer name, an email or an absolute Windows path into any file.
> Next's dev server may drop an `AGENTS.md` / `CLAUDE.md` at the repo root — delete it, never commit
> it. Local vitest may exit 1 with every test passing (a worker RPC teardown stall, backlog item F):
> read the pass/fail counts, not the exit code.

**Committing (shared index — this is the race that eats work).** Three lanes run concurrently in one
checkout. Every commit is ONE command:

```
git status --short
git add <the exact paths this task owns> && git commit -m "<message>"
```

Never `git add -A`, never `git add .`, never `git commit -a`. If `git status --short` shows a file
you do not own as modified, that is another lane working — leave it alone and do not stage it.

## Global Constraints

Every task's requirements implicitly include this section.

- **No Playwright and no browser test.** Vitest + `tsc --noEmit` are the whole gate.
- **No schema change.** `drizzle/**` and `src/db/schema.ts` are edited by no task.
- **No new npm dependency** and **no new API endpoint**. One additive field on an existing response
  type (`PreviewResult.source`, item BP) is not an endpoint.
- **Integer cents only.** No floats, no `parseFloat`. `parseAmountToCents` (`src/lib/money.ts:11`)
  is the one parser, `formatCents` (`:50`) the one formatter.
- **ISO date strings**, `YYYY-MM-DD`. Date arithmetic goes through `addDaysIso` / `daysBetweenIso`
  (`src/lib/dates.ts`). **No `new Date()` inside any `src/lib/**` function** — `today` is a
  parameter.
- **PUBLIC REPO.** No owner name, no employer name, no real statement data, no real merchant
  strings, no absolute Windows paths — in code, comments, tests or fixtures. Use the fixtures this
  repo already uses: `'Alice'`, `'Bob'`, `'Admin Owner'`, `'Chequing'`, `'TIM HORTONS'`,
  `'Property tax'`, `'CITY TAX OFFICE'`.
- **Kids' `self` scope.** No balances and no net worth reach a self viewer, ever. `ownerScope` and
  `isSelfScoped` (`src/lib/auth/viewer.ts:21, :25`) are the only way to ask. A control a self viewer
  cannot use is **not rendered**, never shown-and-refused.
- **The SimpleFIN access URL is a credential.** It must never reach a log line, a notification body
  or a page prop. No task in this release reads it; if you find yourself near it, you are lost.
- **44px minimum touch target** on any control you add or move on mobile
  (`AUTO_SAVE_CONTROL` at `src/components/ui/AutoSave.tsx:47` already carries `min-h-11`), and keep
  the existing a11y patterns — an `aria-label` that names the ROW, not the column.
- **Conventional commits** (`feat:` / `fix:` / `test:` / `docs:` / `chore:` / `refactor:`).
- **Run only your own test files** (`npx vitest run <paths> --reporter=dot`) until Task 9, which is
  the first task that runs the whole suite.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that say *why*. A
  comment arguing for behaviour the code no longer has is worse than no comment — rewrite it, do not
  trim it.
- TDD: write the failing test, run it and watch it fail, implement the minimum, watch it pass,
  commit.

## Ops guards you can trip

| Guard | What it does | What it means for you |
|---|---|---|
| `tests/ops/table-layout.test.ts:75` | Every `<TableWrap … fixed …>` opening tag must also carry `minWidth=` | Task 2 only. It deliberately does NOT count `<col>` against `<th>` (two-table files false-fail) — that count is your review obligation. |
| `tests/ops/row-controls.test.ts` | Scans `src/app/**/*.tsx` only. A `<form>` with exactly one `<select>`, hidden-only `<input>`s, no `<textarea>` and a submit control is an offence. Also a floor: `<AutoSaveSelect` occurrences `>= 5` | Task 4 must keep the `<AutoSaveSelect` element in `transactions-client.tsx` (conditional render, not deletion). Task 7's new control is a **checkbox**, so it cannot trip rule 1 and only raises the floor. `src/components/**` is out of this guard's reach. |
| `tests/ops/client-bundle.test.ts` | No `'use client'` file may value-import `@/db/client`, `@/lib/env`, `better-sqlite3` or a `node:` builtin, directly or transitively | Task 7: `users-manager.tsx` must keep `import type { UserRecord }`. Task 3: `form.tsx` must stay import-pure. Task 2: `warranties-client.tsx` may import from `@/lib/warranty/constants` (already sanctioned) but not from `@/lib/warranty/installments`. |
| `tests/ops/visibility-invariants.test.ts` | Named REQUIRE_VIEWER / EXEMPT / HOUSEHOLD_ONLY_AT_PAGE lists; floors of 27 and 4 | Task 5 ADDS one EXEMPT entry with a written reason over 40 chars. No task may remove an entry or make a `viewer: Viewer` parameter optional. `personSpendSplit`, `searchWarrantyItems` and `upcomingBills` are all on the list and none of their signatures change. |
| `tests/ops/use-server-exports.test.ts` | Every export of a `'use server'` file must be an async function | Task 7's new `setCanSignInAction` is async; any constant or type it needs lives elsewhere. |
| `tests/ops/onboarding-coverage.test.ts` | Guards 1–3 over `NAV` and `help/content.tsx` | Task 8 owns and tightens guard 2. No other task edits it. |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/app/(app)/reports/reports-client.tsx` | the split card's gate (A); the guide's two clauses (BM) | T1 |
| `src/app/(app)/warranties/warranties-client.tsx` | colgroup (I); the bill Expiry cell (Q) | T2 |
| `src/app/(app)/warranties/page.tsx` | the `billSchedules` map (Q) | T2 |
| `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` | four kind-gated Detail rows (R) | T2 |
| `src/lib/warranty/constants.ts` | `billScheduleLabel` (Q) | T2 |
| `src/app/(app)/settings/managers/managers-client.tsx` | colgroup on the rules table (I) | T2 |
| `src/components/ui/form.tsx` | hint out of the label, `aria-describedby` (J) | T3 |
| `src/components/ui/AutoSave.tsx` | the polite "Saved" region (L) | T3 |
| `src/components/ComingUpCard.tsx` | cap, overdue bound, "+N more" (P) | T3 |
| `src/app/(app)/dashboard/page.tsx` | pass `today` to the card (P) | T3 |
| `src/app/(app)/transactions/transactions-client.tsx` | kebab name (M); the two hidden controls (BO) | T4 |
| `src/app/(app)/transactions/page.tsx` | `people = []` for a self viewer (BO) | T4 |
| `src/components/QuickAddTransaction.tsx` | hide the Person field on an empty roster (BO) | T4 |
| `src/lib/categorize/rules.ts` | `exactRuleOwner` (BJ) | T5 |
| `src/lib/categorize/engine.ts` | `setTransferFlag` refuses (BJ) | T5 |
| `src/lib/transactions.ts` | `transactionOwners` (BL) | T5 |
| `src/app/(app)/transactions/actions.ts` | `allTransactionsVisible` (BL) | T5 |
| `tests/ops/visibility-invariants.test.ts` | one EXEMPT entry (BL) | T5 |
| `src/lib/import/preview.ts` | `PreviewResult.source` (BP) | T6 |
| `src/app/(app)/import/import-client.tsx` | no mapping editor for OFX (BP) | T6 |
| `src/app/api/import/preview/route.ts` | refuse an asset account (BQ) | T6 |
| `src/app/(app)/settings/actions.ts` | five action signatures (H) | T7 |
| `src/app/(app)/settings/updates-client.tsx` | pass the actions directly (H) | T7 |
| `src/app/(app)/settings/users/actions.ts` | `setCanSignInAction` (BI) | T7 |
| `src/app/(app)/settings/users/users-manager.tsx` | the Sign-in column (BI) | T7 |
| `src/lib/notify/evaluate/digest.ts` `monthly.ts` | skip instead of falling back (BK) | T8 |
| `tests/ops/onboarding-coverage.test.ts` | whole-segment href match (B) | T8 |
| `tests/lib/warranty/ocr/onnx/engine.test.ts` | stub the heavy path (K) | T8 |
| `tests/app/bills-actions.test.ts` + new refusals file | action-level coverage (BN) | T8 |
| `package.json` `CHANGELOG.md` `docs/PENDING-FIXES.md` `tests/ops/docker.test.ts` | release; C, D, F closed | T9 |

## Lane table

Three lanes run **concurrently in one checkout**. Tasks inside a lane run in the listed order.
Task 9 runs **alone, after all three lanes are done**.

| Lane | Tasks, in order | Items | Every file the lane touches |
|---|---|---|---|
| **A** | T4 → T5 → T6 | M, BO, BJ, BL, BP, BQ | `src/app/(app)/transactions/transactions-client.tsx`, `src/app/(app)/transactions/page.tsx`, `src/components/QuickAddTransaction.tsx`, `src/app/(app)/transactions/actions.ts`, `src/lib/transactions.ts`, `src/lib/categorize/engine.ts`, `src/lib/categorize/rules.ts`, `src/lib/import/preview.ts`, `src/app/(app)/import/import-client.tsx`, `src/app/api/import/preview/route.ts`, `tests/ops/visibility-invariants.test.ts`, `tests/app/transactions-client.test.tsx`, `tests/app/transactions-page.test.tsx` (new), `tests/components/quick-add.test.tsx`, `tests/app/transactions-actions.test.ts`, `tests/lib/transactions.test.ts`, `tests/lib/categorize/engine.test.ts`, `tests/app/import-client.test.tsx`, `tests/lib/import/preview.test.ts`, `tests/api/import.route.test.ts` |
| **B** | T1 → T2 → T3 | A, BM, I, Q, R, J, L, P | `src/app/(app)/reports/reports-client.tsx`, `src/app/(app)/warranties/warranties-client.tsx`, `src/app/(app)/warranties/page.tsx`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, `src/lib/warranty/constants.ts`, `src/app/(app)/settings/managers/managers-client.tsx`, `src/components/ui/form.tsx`, `src/components/ui/AutoSave.tsx`, `src/components/ComingUpCard.tsx`, `src/app/(app)/dashboard/page.tsx`, `tests/app/reports-client.test.tsx`, `tests/lib/reports.test.ts`, `tests/app/warranties-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`, `tests/lib/warranty/constants.test.ts`, `tests/app/managers-client.test.tsx`, `tests/components/form-field.test.tsx` (new), `tests/unit/auto-save.test.tsx`, `tests/components/ComingUpCard.test.tsx`, `tests/app/dashboard.test.tsx` |
| **C** | T7 → T8 | H, BI, BK, BN, B, K | `src/app/(app)/settings/actions.ts`, `src/app/(app)/settings/updates-client.tsx`, `src/app/(app)/settings/users/actions.ts`, `src/app/(app)/settings/users/users-manager.tsx`, `src/lib/notify/evaluate/digest.ts`, `src/lib/notify/evaluate/monthly.ts`, `src/app/(app)/help/content.tsx` (contingency, see T8 step 3), `tests/app/updates-card.test.tsx`, `tests/app/update-actions.test.ts`, `tests/app/users-manager.test.tsx`, `tests/app/users-actions.test.ts`, `tests/lib/notify/evaluate/digest.test.ts`, `tests/lib/notify/evaluate/monthly.test.ts`, `tests/ops/onboarding-coverage.test.ts`, `tests/lib/warranty/ocr/onnx/engine.test.ts`, `tests/app/bills-actions.test.ts`, `tests/app/bills-actions-refusals.test.ts` (new) |
| **release** | T9 | C, D, F closed; all 23 recorded | `package.json`, `CHANGELOG.md`, `docs/PENDING-FIXES.md`, `tests/ops/docker.test.ts` |

**Disjointness is verified file-by-file in the self-review at the end of this plan.** No path appears
in two lanes.

**The one contingency, and it is expected to stay empty.** Task 3 changes `src/components/ui/form.tsx`
and `src/components/ui/AutoSave.tsx`, which every lane's pages render. Both changes only *shorten* an
accessible name or *add* an `sr-only` node, and a grep at plan time found no test querying a label by
a string containing hint prose — so no other lane's test should break. If one does, Task 3 fixes only
the **query string** in that test, commits it with its exact path in the same one-line
`git add … && git commit` form, and says so in its report. It may not change any other file.

---

# Lane B

### Task 1: the Reports page tells a self viewer the truth, and its empty state is reachable

Items **A** (ruling P2) and **BM** (ruling P15).

**Files:**
- Modify: `src/app/(app)/reports/reports-client.tsx:150-157` (the guide paragraph), `:415` (the
  split gate)
- Test: `tests/app/reports-client.test.tsx` (extend), `tests/lib/reports.test.ts` (extend, one
  assertion, **no source change to `src/lib/reports.ts`**)

**Interfaces:**
- Produces: nothing. No prop is added, no signature changes.
- Consumes: `showExport` and `showPersonSplit`, both already props (`:71`, `:111-115`).

`src/lib/reports.ts` is **not modified**. `personSpendSplit` is in
`tests/ops/visibility-invariants.test.ts`'s `REQUIRE_VIEWER` list and its `viewer: Viewer` parameter
must stay exactly as it is.

- [ ] **Step 1: Write the failing tests.**

Append to `tests/app/reports-client.test.tsx`. Note the file's own docblock warning: every query that
touches a card's content is scoped with `within(...)`, because the person filter's static
`<option>Household/unattributed</option>` carries the same text as `UNATTRIBUTED_LABEL`.

```tsx
describe('ReportsClient — the "Who spent it" card (item A, ruling P2)', () => {
  function splitCard(container: HTMLElement): HTMLElement {
    const heading = [...container.querySelectorAll('h2, h3')].find((node) => node.textContent === 'Who spent it');
    const card = heading?.closest('div[class*="card"], section, article') ?? heading?.parentElement?.parentElement;
    if (!card) throw new Error('the "Who spent it" card is not on the page');
    return card as HTMLElement;
  }

  it('shows the empty state when every row is zero', () => {
    // The defect: personSpendSplit ALWAYS pushes the unattributed bucket (src/lib/reports.ts:361),
    // so split.length was never 0 for the only viewer who sees this card, and "Nothing to split
    // yet" -- written, styled and given an action -- could never render.
    const { container } = render(
      <ReportsClient {...baseProps()} split={[{ userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 }]} />,
    );
    expect(within(splitCard(container)).getByText('Nothing to split yet')).toBeTruthy();
  });

  it('shows the rows when any row carries spend', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        split={[
          { userId: 7, label: 'Alice', spentCents: 42000 },
          { userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 },
        ]}
      />,
    );
    const card = within(splitCard(container));
    expect(card.queryByText('Nothing to split yet')).toBeNull();
    expect(card.getByText('Alice')).toBeTruthy();
    // The zero bucket still renders once there is anything to compare it against.
    expect(card.getByText(UNATTRIBUTED_LABEL)).toBeTruthy();
  });
});

describe('ReportsClient — the page guide names no absent control (item BM, ruling P15)', () => {
  function guideText(container: HTMLElement): string {
    return container.querySelector('details')?.textContent ?? '';
  }

  it('does not promise Export CSV to a viewer who has no Export CSV button', () => {
    const { container } = render(<ReportsClient {...baseProps()} showExport={false} />);
    expect(guideText(container)).not.toContain('Export CSV');
  });

  it('does not promise a per-person split to a viewer who has no split card', () => {
    const { container } = render(<ReportsClient {...baseProps()} showPersonSplit={false} />);
    expect(guideText(container)).not.toContain('split by person');
  });

  it('still says both to a household viewer', () => {
    const { container } = render(<ReportsClient {...baseProps()} />);
    const text = guideText(container);
    expect(text).toContain('Export CSV');
    expect(text).toContain('split by person');
  });
});
```

Append to `tests/lib/reports.test.ts` (this pins ruling P2's *other* half — that the bucket stays):

```ts
it('always returns the unattributed bucket, even at zero (item A, ruling P2)', () => {
  // Deliberate: a bucket that disappears at zero hides the difference between "nobody
  // unattributed" and "we stopped counting". reports-client.tsx's empty state is gated on every
  // row being zero BECAUSE of this, not the other way round.
  const rows = personSpendSplit({ from: '2099-01-01', to: '2099-01-31' }, HOUSEHOLD);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 });
});
```

Reuse whatever `HOUSEHOLD`/viewer fixture and `describe` block `tests/lib/reports.test.ts` already
uses for `personSpendSplit`; do not invent a second one.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/app/reports-client.test.tsx tests/lib/reports.test.ts --reporter=dot
```
Expected: the three new client tests fail (the empty state does not render at zero; the guide still
says "Export CSV" and "split by person"). The lib assertion should PASS already — if it does not,
stop: ruling P2's premise is wrong and the item needs re-reading.

- [ ] **Step 3: Fix the split gate.**

`src/app/(app)/reports/reports-client.tsx:415`, replacing `{split.length === 0 ? (`:

```tsx
{/* item A (ruling P2): NOT split.length === 0 -- personSpendSplit always pushes the
    unattributed bucket (src/lib/reports.ts:361-362), deliberately, so this array is never
    empty for the only viewer who sees this card and the branch below was unreachable. The
    honest condition is "there is nothing to split", which is every row at zero. */}
{split.every((row) => row.spentCents === 0) ? (
```

- [ ] **Step 4: Gate the two guide clauses.**

Replace the first `<p>` of the `<PageGuide>` (`:150-157`) with:

```tsx
<p>
  Reports answers questions about a stretch of time rather than the current month: where
  the money went by category, how one month compares with the last, how a year compares
  with the year before
  {showPersonSplit ? ", and how the household's split by person works out" : ''}. The date
  range and person at the top drive every card below at once
  {showExport ? (
    <>
      , and <strong className="font-semibold text-ink">Export CSV</strong> gives you the same
      rows in a spreadsheet
    </>
  ) : null}
  .
</p>
```

Add above the `<PageGuide>`:

```tsx
{/* item BM (ruling P15): both clauses are gated, not just the Export one the backlog named.
    showExport and showPersonSplit are both !isSelfScoped(viewer) (reports/page.tsx:169,176),
    and this paragraph made two promises a self viewer cannot keep -- a control that is not on
    their page (:140-146) and a card that is dropped for them (:412). */}
```

Check the rendered sentence reads correctly in both states before moving on: with both false it must
end "…how a year compares with the year before. The date range and person at the top drive every
card below at once." — one sentence, one full stop, no stray comma.

- [ ] **Step 5: Watch them pass.**

```
npx vitest run tests/app/reports-client.test.tsx tests/lib/reports.test.ts --reporter=dot
```

- [ ] **Step 6: Commit.**

```
git status --short
git add src/app/(app)/reports/reports-client.tsx tests/app/reports-client.test.tsx tests/lib/reports.test.ts && git commit -m "fix(reports): reach the split card's empty state and stop naming absent controls in the guide (A, BM)"
```

---

### Task 2: the two bill surfaces stop lying, and the two at-risk tables get their widths

Items **Q** (rulings P4, P5), **R** (ruling P6) and **I** (ruling P3).

**Files:**
- Modify: `src/lib/warranty/constants.ts` (add `billScheduleLabel` beside the other wording helpers,
  near `expiryPhraseForKind` at `:171`)
- Modify: `src/app/(app)/warranties/page.tsx:1-7` (imports), `:30-44` (build the map), `:46-58`
  (the new prop)
- Modify: `src/app/(app)/warranties/warranties-client.tsx:195` (TableWrap + colgroup), `:197-207`
  (drop width classes from the `<th>`s if any), `:231-237` (the Expiry cell), plus the props block
- Modify: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:338-340, :354`
- Modify: `src/app/(app)/settings/managers/managers-client.tsx:254` (TableWrap + colgroup)
- Test: `tests/lib/warranty/constants.test.ts`, `tests/app/warranties-client.test.tsx`,
  `tests/app/warranty-detail-client.test.tsx`, `tests/app/managers-client.test.tsx`

**Interfaces:**
- Produces: `billScheduleLabel(nextDueDate: string | null, overdueCount: number): string`, exported
  from `@/lib/warranty/constants`. Pure, no db, no date arithmetic — the caller has already decided
  what is overdue.
- Produces: `WarrantiesClient` gains `billSchedules: Record<number, { nextDueDate: string;
  overdueCount: number }>` — a plain object, not a `Map`, because it crosses the server/client
  boundary as a prop.
- Consumes: `unpaidInstallments` (`src/lib/warranty/installments.ts:274`) and `ownerScope`
  (`src/lib/auth/viewer.ts:21`), both from the SERVER page only.

`src/lib/warranty/installments.ts` and `src/lib/warranty/search.ts` are **not modified** (ruling P5).
`warranties-client.tsx` is a `'use client'` file — it must not import from
`@/lib/warranty/installments` (`tests/ops/client-bundle.test.ts`); `@/lib/warranty/constants` is
already a sanctioned import for it.

- [ ] **Step 1: Write the failing wording test.**

Append to `tests/lib/warranty/constants.test.ts`:

```ts
describe('billScheduleLabel (item Q, ruling P4)', () => {
  it('names the next due date when nothing is overdue', () => {
    expect(billScheduleLabel('2026-09-30', 0)).toBe('Next due 2026-09-30');
  });

  it('leads with the overdue count when there is one', () => {
    // A bill three weeks late used to read "Ongoing" on this row, which is the whole defect.
    expect(billScheduleLabel('2026-06-30', 2)).toBe('2 overdue · next 2026-06-30');
  });

  it('says "1 overdue", singular', () => {
    expect(billScheduleLabel('2026-06-30', 1)).toBe('1 overdue · next 2026-06-30');
  });

  it('falls back to the open-ended word when there is no unpaid installment left', () => {
    expect(billScheduleLabel(null, 0)).toBe(openEndedDisplayLabel('bill'));
  });

  it('renders no amount (ruling P4: dates and counts only)', () => {
    expect(billScheduleLabel('2026-09-30', 3)).not.toMatch(/\$|\d+\.\d\d/);
  });
});
```

Widen the file's import from `@/lib/warranty/constants` to include `billScheduleLabel` (and
`openEndedDisplayLabel` if it is not already there).

- [ ] **Step 2: Run it and watch it fail.**

```
npx vitest run tests/lib/warranty/constants.test.ts --reporter=dot
```
Expected: `billScheduleLabel is not a function`.

- [ ] **Step 3: Add the wording helper.**

In `src/lib/warranty/constants.ts`, immediately after `expiryPhraseForKind` (`:171-173`):

```ts
/**
 * The /warranties list row for a Bill (item Q, v1.13.1). MUST-19.11: the one place this wording
 * is written -- warranties-client.tsx composes nothing of its own.
 *
 * Dates and counts only, never an amount (ruling P4). The cell this feeds is a fixed-width
 * column beside eight others, and a bill's money already has a home on its own detail page; a
 * due date and an overdue count are what stop the row reading "Ongoing" while the bill is three
 * weeks late.
 *
 * nextDueDate null means every installment on this bill is paid, which is genuinely open-ended
 * from the list's point of view -- so it falls back to the same word every other open-ended kind
 * uses rather than inventing a second one.
 */
export function billScheduleLabel(nextDueDate: string | null, overdueCount: number): string {
  if (nextDueDate === null) return openEndedDisplayLabel('bill');
  if (overdueCount > 0) return `${overdueCount} overdue · next ${nextDueDate}`;
  return `Next due ${nextDueDate}`;
}
```

- [ ] **Step 4: Write the failing list-row tests.**

`tests/app/warranties-client.test.tsx` — first widen the `renderList` helper so the new required prop
has a default, then add the cases:

```tsx
// In renderList's JSX, before {...over}:
//   billSchedules={{}}

describe('WarrantiesClient — a Bill row shows its schedule (item Q)', () => {
  const bill = () => item({ id: 42, name: 'Property tax', kind: 'bill', isLifetime: true, expiryDate: null, typeName: 'Tax bill' });

  it('shows the next due date instead of "Ongoing"', () => {
    renderList(result([bill()]), { billSchedules: { 42: { nextDueDate: '2026-09-30', overdueCount: 0 } } });
    expect(screen.getByText('Next due 2026-09-30')).toBeTruthy();
    expect(screen.queryByText('Ongoing')).toBeNull();
  });

  it('leads with the overdue count when the bill is behind', () => {
    renderList(result([bill()]), { billSchedules: { 42: { nextDueDate: '2026-06-30', overdueCount: 2 } } });
    expect(screen.getByText('2 overdue · next 2026-06-30')).toBeTruthy();
  });

  it('still reads "Ongoing" when every installment is paid', () => {
    renderList(result([bill()]), { billSchedules: {} });
    expect(screen.getByText('Ongoing')).toBeTruthy();
  });

  it('leaves a non-bill kind alone', () => {
    renderList(result([item({ id: 42, kind: 'contract', isLifetime: true, expiryDate: null })]), {
      billSchedules: { 42: { nextDueDate: '2026-09-30', overdueCount: 0 } },
    });
    expect(screen.getByText('Ongoing')).toBeTruthy();
    expect(screen.queryByText('Next due 2026-09-30')).toBeNull();
  });
});

describe('WarrantiesClient — the table declares its own widths (item I, ruling P3)', () => {
  it('is a fixed table with one <col> per column', () => {
    const { container } = renderList(result([item()]));
    const table = container.querySelector('table');
    expect(table?.className).toContain('data-table--fixed');
    expect(container.querySelectorAll('colgroup > col')).toHaveLength(9);
    expect(container.querySelectorAll('thead th')).toHaveLength(9);
  });
});
```

- [ ] **Step 5: Run it and watch it fail.**

```
npx vitest run tests/app/warranties-client.test.tsx --reporter=dot
```

- [ ] **Step 6: Wire the schedule map in the server page.**

`src/app/(app)/warranties/page.tsx` — add to the imports at the top:

```ts
import { addDaysIso, todayIso } from '@/lib/dates';
import { ownerScope } from '@/lib/auth/viewer';
import { unpaidInstallments } from '@/lib/warranty/installments';
```
(`todayIso` is already imported at `:3`; widen that line rather than adding a second one.)

After the `searchWarrantyItems` call (`:32-44`):

```ts
  /**
   * Item Q (ruling P5). The list's row shape (WarrantyListItem) carries no schedule and
   * searchWarrantyItems is a REQUIRE_VIEWER read-model -- widening it for a display detail would
   * touch a guarded reader, so the page folds the schedule itself. unpaidInstallments already
   * orders due_date ASC, so the FIRST row per item is its next due date.
   *
   * ownerUserId is what keeps a self viewer to their own bills: unpaidInstallments takes no
   * viewer of its own (its own docblock says omitting the id spans the household), so the scope
   * has to be passed in here or a child would see a sibling's bill dates.
   *
   * A ten-year window is effectively unbounded, which is right for a LIST: the row should name
   * the next due date however far out it is. The dashboard card is the one with a horizon.
   */
  const scope = ownerScope(viewer);
  const billSchedules: Record<number, { nextDueDate: string; overdueCount: number }> = {};
  for (const row of unpaidInstallments({
    today,
    windowEnd: addDaysIso(today, 3650),
    includeOverdue: true,
    ownerUserId: scope ?? undefined,
  })) {
    const entry = billSchedules[row.itemId];
    if (entry === undefined) {
      billSchedules[row.itemId] = { nextDueDate: row.dueDate, overdueCount: row.dueDate < today ? 1 : 0 };
    } else if (row.dueDate < today) {
      entry.overdueCount += 1;
    }
  }
```

Pass `billSchedules={billSchedules}` in the `<WarrantiesClient …>` block.

- [ ] **Step 7: Render it, and give the table its colgroup.**

`src/app/(app)/warranties/warranties-client.tsx`:

1. Add `billSchedules` to the destructured props and to the props type:
   `billSchedules: Record<number, { nextDueDate: string; overdueCount: number }>;`
2. Widen the `@/lib/warranty/constants` import to include `billScheduleLabel`.
3. Replace the Expiry cell (`:231-237`):

```tsx
<td className="whitespace-nowrap text-muted">
  {/* Item Q: a bill has no expiry, it has a schedule. Every other kind falls through
      unchanged -- this is one arm added ahead of the existing three, not a rewrite. */}
  {row.kind === 'bill'
    ? billScheduleLabel(
        billSchedules[row.id]?.nextDueDate ?? null,
        billSchedules[row.id]?.overdueCount ?? 0,
      )
    : row.isLifetime
      ? openEndedDisplayLabel(row.kind)
      : row.expiryDate === null
        ? '—'
        : expiryPhraseForKind(row.kind, row.expiryDate)}
</td>
```

4. Replace `<TableWrap bare>` at `:195` with the fixed form. The `minWidth` string is the arithmetic
   sum of the `<col>` widths — that is the house convention and
   `tests/ops/table-layout.test.ts:75` requires `minWidth` on the same opening tag as `fixed`:

```tsx
{/* Item I (ruling P3). minWidth is the colgroup's own total (14+9+9+7+13+8+9+7+9 = 85rem).
    Without it .data-table's width:100% means the overflow-x-auto wrapper has nothing to
    scroll and the browser crushes every column instead -- see TableWrap's minWidth docblock. */}
<TableWrap bare fixed minWidth="85rem">
  <colgroup>
    {/* The item name, the one column people scan. Left unsized it took whatever the other
        eight left over, which on a long name meant a vertical column of characters. */}
    <col style={{ width: '14rem' }} />
    {/* An item-type name. */}
    <col style={{ width: '9rem' }} />
    {/* A vendor name. */}
    <col style={{ width: '9rem' }} />
    {/* An ISO date in tabular figures: the same width on every row. */}
    <col style={{ width: '7rem' }} />
    {/* Widened from a date to fit item Q's "2 overdue · next 2026-06-30" on one line. */}
    <col style={{ width: '13rem' }} />
    {/* One badge. */}
    <col style={{ width: '8rem' }} />
    {/* A person's name, or "Household". */}
    <col style={{ width: '9rem' }} />
    {/* A five-figure amount, right-aligned, on one line. */}
    <col style={{ width: '7rem' }} />
    {/* An amount plus its cycle suffix ("/mo"). */}
    <col style={{ width: '9rem' }} />
  </colgroup>
```

Remove any width utility class from the nine `<th>`s (`:197-207`) — the colgroup owns the widths now.
Count the `<col>`s against the `<th>`s by hand: the guard deliberately does not (its docblock says
two-table files false-fail), so this count is yours.

- [ ] **Step 8: Write the failing detail-card tests.**

Append to `tests/app/warranty-detail-client.test.tsx` (this file mocks all nine warranties actions —
add no new action, so no new stub is needed):

```tsx
describe('WarrantyDetailClient — inapplicable product fields (item R, ruling P6)', () => {
  it('drops Vendor, Model, Serial and Price for a Bill that holds none of them', () => {
    renderDetail(detailItem({ kind: 'bill', vendor: null, model: null, serial: null, priceCents: null }));
    // Four guaranteed em-dashes above the Installments section is what this fixes.
    expect(screen.queryByText('Vendor')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.queryByText('Serial number')).toBeNull();
    expect(screen.queryByText('Price')).toBeNull();
  });

  it('KEEPS a stored value on a kind that can no longer hold it (constants.ts:272-286)', () => {
    // The gates decide what a form OFFERS, never what a page may hide: an item whose type
    // changed after it was saved still holds a model, and hiding a stored value is how data
    // gets silently dropped on the next save.
    renderDetail(detailItem({ kind: 'bill', vendor: null, model: 'GDT645SYNFS', serial: null, priceCents: null }));
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.queryByText('Vendor')).toBeNull();
  });

  it('leaves a warranty untouched, em-dashes and all', () => {
    renderDetail(detailItem({ kind: 'warranty', vendor: null, model: null, serial: null, priceCents: null }));
    for (const label of ['Vendor', 'Model', 'Serial number', 'Price']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
```

Use the file's existing render helper and item factory rather than writing new ones; if they are
named differently from `renderDetail`/`detailItem`, use the existing names.

- [ ] **Step 9: Gate the four Detail rows.**

`src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, replacing `:338-340` and `:354`. Add
`productFieldsAllowedForKind` and `loanFieldsAllowedForKind` to the `@/lib/warranty/constants`
import.

```tsx
{/* Item R (ruling P6). The gate alone is NOT the condition: productFieldsAllowedForKind's own
    docblock says it decides what a form OFFERS, never what a page may hide, because an item
    whose type changed after it was saved can still hold a model. So a row disappears only when
    the kind forbids it AND it is empty -- which for a Bill is all four, every time. */}
{productFieldsAllowedForKind(item.kind) || item.vendor !== null ? (
  <Detail label="Vendor">{item.vendor ?? '—'}</Detail>
) : null}
{productFieldsAllowedForKind(item.kind) || item.model !== null ? (
  <Detail label="Model">{item.model ?? '—'}</Detail>
) : null}
{productFieldsAllowedForKind(item.kind) || item.serial !== null ? (
  <Detail label="Serial number">{item.serial ?? '—'}</Detail>
) : null}
```

and for Price at `:354` (a loan legitimately carries a price-shaped figure, so its gate is in the
condition too):

```tsx
{productFieldsAllowedForKind(item.kind) || loanFieldsAllowedForKind(item.kind) || item.priceCents !== null ? (
  <Detail label="Price">{item.priceCents === null ? '—' : <Money cents={item.priceCents} plain />}</Detail>
) : null}
```

- [ ] **Step 10: Write the failing merchant-rules table test.**

Append to `tests/app/managers-client.test.tsx` (no test covers the rules table today):

```tsx
describe('ManagersClient — the merchant rules table declares its own widths (item I)', () => {
  it('is a fixed table with one <col> per column', () => {
    const { container } = renderManagers();
    const tables = [...container.querySelectorAll('table')];
    // Two tables in this file: categories (5 cols) then merchant rules (7 cols). Item I converts
    // only the second -- the categories table is not on its list.
    const rules = tables[1];
    expect(rules?.className).toContain('data-table--fixed');
    expect(rules?.querySelectorAll('colgroup > col')).toHaveLength(7);
    expect(rules?.querySelectorAll('thead th')).toHaveLength(7);
  });
});
```

Use the file's existing render helper (it renders with a `rules` fixture); pass at least one rule so
the table body is non-empty.

- [ ] **Step 11: Give the rules table its colgroup.**

`src/app/(app)/settings/managers/managers-client.tsx:254`, replacing `<TableWrap bare>`:

```tsx
{/* Item I. minWidth is the colgroup's own total (14+6+7+13+10+5+3 = 58rem); without it the
    scroll container has nothing to scroll and the columns crush instead. A long monospace
    pattern beside a "Parent › Child" label reached ~1100px and squeezed the delete button. */}
<TableWrap bare fixed minWidth="58rem">
  <colgroup>
    {/* A monospace merchant pattern -- the widest thing in this table by a distance. */}
    <col style={{ width: '14rem' }} />
    {/* "exact" / "contains". */}
    <col style={{ width: '6rem' }} />
    {/* A rule kind: category / transfer / rename / not_transfer. */}
    <col style={{ width: '7rem' }} />
    {/* "Parent › Child" -- the cell that used to starve the button on the right. */}
    <col style={{ width: '13rem' }} />
    {/* A rename target, usually shorter than the pattern it replaces. */}
    <col style={{ width: '10rem' }} />
    {/* A hit count in tabular figures, right-aligned. */}
    <col style={{ width: '5rem' }} />
    {/* The delete button: one small button plus padding. */}
    <col style={{ width: '3rem' }} />
  </colgroup>
```

Leave the categories table at `:152` as `<TableWrap bare>` — it is not on item I's list.

- [ ] **Step 12: Watch them all pass.**

```
npx vitest run tests/lib/warranty/constants.test.ts tests/app/warranties-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/managers-client.test.tsx tests/ops/table-layout.test.ts --reporter=dot
```

- [ ] **Step 13: Commit.**

```
git status --short
git add src/lib/warranty/constants.ts src/app/(app)/warranties/page.tsx src/app/(app)/warranties/warranties-client.tsx "src/app/(app)/warranties/[id]/warranty-detail-client.tsx" src/app/(app)/settings/managers/managers-client.tsx tests/lib/warranty/constants.test.ts tests/app/warranties-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/managers-client.test.tsx && git commit -m "fix(warranties): show a bill's schedule on the list, hide fields its kind cannot hold, and pin two table widths (Q, R, I)"
```

---

### Task 3: the shared UI — a hint that is not a name, a save that is announced, a card with a horizon

Items **J** (ruling P7), **L** (ruling P8) and **P** (rulings P9, P10).

**Files:**
- Modify: `src/components/ui/form.tsx:16-44` (the whole `Field`)
- Modify: `src/components/ui/AutoSave.tsx:119-141` (`StatusSlot`)
- Modify: `src/components/ComingUpCard.tsx:22-44` (props), `:47-59` (derived values), `:83-109`
  (the list)
- Modify: `src/app/(app)/dashboard/page.tsx:278-285` (one new prop)
- Create: `tests/components/form-field.test.tsx`
- Test: `tests/unit/auto-save.test.tsx`, `tests/components/ComingUpCard.test.tsx`,
  `tests/app/dashboard.test.tsx` (re-run; edit only if it breaks)

**Interfaces:**
- Produces: `Field` — same props, same names. The `<label>` no longer wraps the hint. In the
  `htmlFor` branch the hint gets `id={`${htmlFor}-hint`}` and the single child is cloned with
  `aria-describedby`. **No call site is edited.**
- Produces: `StatusSlot` returns a fragment. Not exported; no call site changes.
- Produces: `COMING_UP_ROW_LIMIT = 8` and `COMING_UP_OVERDUE_DAYS = 90`, exported from
  `@/components/ComingUpCard`; `ComingUpCard` gains a required `today: string` prop.
- Consumes: `daysBetweenIso` from `@/lib/dates` (server component, so no bundle constraint).

`src/lib/bills.ts` is **not modified** — `upcomingBills` is in `REQUIRE_VIEWER` and keeps its
`viewer: Viewer` parameter exactly as it is (ruling P9).

- [ ] **Step 1: Write the failing `Field` tests.**

Create `tests/components/form-field.test.tsx` (there is no test for `form.tsx` today):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { Field, inputClass } from '@/components/ui/form';

afterEach(() => cleanup());

const HINT = 'What you borrowed. Used for the payoff bar.';

describe('Field — the hint is a description, never part of the name (item J, ruling P7)', () => {
  it('names the implicit-label input by its label alone', () => {
    render(
      <Field label="Original amount" hint={HINT}>
        <input className={inputClass} name="principal" />
      </Field>,
    );
    // Before this fix the accessible name was "Original amount What you borrowed. Used for the
    // payoff bar." and an exact getByLabelText could not find the field at all.
    expect(screen.getByLabelText('Original amount')).toBeTruthy();
  });

  it('still shows the hint, outside the <label>', () => {
    const { container } = render(
      <Field label="Original amount" hint={HINT}>
        <input className={inputClass} name="principal" />
      </Field>,
    );
    const hint = screen.getByText(HINT);
    expect(hint).toBeTruthy();
    expect(hint.closest('label')).toBeNull();
    expect(container.querySelector('label')).toBeTruthy();
  });

  it('describes the control when the caller supplied an id', () => {
    render(
      <Field label="Original amount" hint={HINT} htmlFor="loan-original">
        <input id="loan-original" className={inputClass} name="principal" />
      </Field>,
    );
    const input = screen.getByLabelText('Original amount');
    expect(input.getAttribute('aria-describedby')).toBe('loan-original-hint');
    expect(document.getElementById('loan-original-hint')?.textContent).toBe(HINT);
  });

  it('leaves a child that already describes itself alone', () => {
    render(
      <Field label="Original amount" hint={HINT} htmlFor="loan-original">
        <input id="loan-original" aria-describedby="something-else" className={inputClass} name="principal" />
      </Field>,
    );
    expect(screen.getByLabelText('Original amount').getAttribute('aria-describedby')).toBe('something-else');
  });

  it('renders unchanged with no hint at all', () => {
    render(
      <Field label="Name">
        <input className={inputClass} name="name" />
      </Field>,
    );
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

```
npx vitest run tests/components/form-field.test.tsx --reporter=dot
```
Expected: the first test fails (the name carries the hint), the third fails (no
`aria-describedby`).

- [ ] **Step 3: Rewrite `Field`.**

Replace `src/components/ui/form.tsx:16-44` entirely:

```tsx
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
```

Add `import React from 'react';` at the top if the file does not already have it (it uses
`React.ReactNode` in types today, which TypeScript resolves from the global JSX namespace; the
runtime `React.isValidElement` / `React.cloneElement` calls need a real import).

- [ ] **Step 4: Watch the Field tests pass, then run the broad jsdom sweep.**

```
npx vitest run tests/components/form-field.test.tsx --reporter=dot
npx vitest run tests/app tests/components tests/unit --reporter=dot
```

The sweep is expected to be green: the change only ever SHORTENS an accessible name, and no test in
this repo queries a label by a string containing hint prose (checked at plan time). If something
fails, fix only the **query string** in that test file and note it in your report — you may not
change any other source file. This is the plan's one declared contingency.

- [ ] **Step 5: Write the failing AutoSave test.**

Append to `tests/unit/auto-save.test.tsx`:

```tsx
describe('AutoSave announces success, not only failure (item L, ruling P8)', () => {
  function liveRegion(): HTMLElement | null {
    return document.querySelector('[aria-live="polite"]');
  }

  it('has an empty live region before anything is saved', () => {
    render(<AutoSaveSelect name="x" defaultValue="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} fields={{}} action={async () => ({})} ariaLabel="Pick one" />);
    // The region must exist BEFORE its content changes -- one added at the same moment it gets
    // text is not announced by any screen reader.
    expect(liveRegion()).toBeTruthy();
    expect(liveRegion()?.textContent).toBe('');
  });

  it('announces "Saved" after a successful save', async () => {
    render(<AutoSaveSelect name="x" defaultValue="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} fields={{}} action={async () => ({})} ariaLabel="Pick one" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'b' } });
    await waitFor(() => expect(statusOf()).toBe('saved'));
    expect(liveRegion()?.textContent).toBe('Saved');
  });

  it('says nothing on a refusal - role="alert" already carries the server's words', async () => {
    render(<AutoSaveSelect name="x" defaultValue="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} fields={{}} action={async () => ({ error: 'Nope.' })} ariaLabel="Pick one" />);
    fireEvent.change(screen.getByLabelText('Pick one'), { target: { value: 'b' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Nope.'));
    expect(liveRegion()?.textContent).toBe('');
  });
});
```

Widen the file's imports to whatever it needs (`fireEvent`, `waitFor`, `screen`); it already has
`statusOf()` at `:19-21`.

- [ ] **Step 6: Add the live region.**

`src/components/ui/AutoSave.tsx`, replacing `StatusSlot` (`:119-141`):

```tsx
/**
 * Fixed-width feedback slot. Fixed width because the tick appears and disappears on its own:
 * a slot that collapsed would reflow the row two seconds after a save, under the cursor of
 * whoever is editing the next cell.
 *
 * v1.13.1 (item L, ruling P8). The visual half stays aria-hidden -- a decorative tick beside a
 * control someone is looking at needs no announcement. But that reasoning only ever covered
 * SIGHT: a refused save was announced (ErrorLine's role="alert") and a successful one was
 * announced to nobody, and the asymmetry was the bug. The sr-only polite region below is always
 * in the tree, because a live region created at the same moment it gets its text is not
 * announced at all, and it says one word so a control someone edits repeatedly does not turn
 * into chatter.
 */
function StatusSlot({ pending, status }: { pending: boolean; status: AutoSaveStatus }) {
  const shown = pending ? 'pending' : status;
  return (
    <>
      <span
        data-autosave-status={shown}
        aria-hidden="true"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
      >
        {shown === 'pending' ? (
          <span className="h-3 w-3 animate-spin rounded-full border border-line border-t-transparent" />
        ) : shown === 'saved' ? (
          <CheckIcon className="h-3.5 w-3.5 text-positive-soft-fg" />
        ) : shown === 'error' ? (
          <span className="text-xs font-semibold text-negative-soft-fg">!</span>
        ) : null}
      </span>
      <span className="sr-only" aria-live="polite">
        {shown === 'saved' ? 'Saved' : ''}
      </span>
    </>
  );
}
```

- [ ] **Step 7: Write the failing ComingUpCard tests.**

In `tests/components/ComingUpCard.test.tsx`, add `today: TODAY` to the shared `base` props object
(pick the file's existing today-like constant, or add `const TODAY = '2026-08-16';`), then append:

```tsx
describe('ComingUpCard caps its rows and bounds its overdue (item P, rulings P9/P10)', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      bill({ installmentId: i + 1, itemId: i + 1, name: `Bill ${i + 1}`, dueDate: '2026-09-01', amountCents: 10000, overdue: false }),
    );

  it('renders at most COMING_UP_ROW_LIMIT rows and offers the rest', () => {
    const { container } = render(<ComingUpCard {...base} today={TODAY} bills={many(10)} />);
    // A household several bills behind used to get a wall of rows instead of a card.
    expect(container.querySelectorAll('li')).toHaveLength(COMING_UP_ROW_LIMIT + 1);
    expect(screen.getByText('+2 more due')).toBeTruthy();
    expect(screen.getByRole('link', { name: /more due/ }).getAttribute('href')).toBe('/warranties');
  });

  it('renders no overflow row when everything fits', () => {
    render(<ComingUpCard {...base} today={TODAY} bills={many(3)} />);
    expect(screen.queryByText(/more due/)).toBeNull();
  });

  it('the header total sums every row inside the window, capped or not', () => {
    render(<ComingUpCard {...base} today={TODAY} bills={many(10)} />);
    // Ruling P9: NOT the eight rendered rows. A total that stopped at the cap would understate
    // what is owed, which is worse than a long list.
    expect(screen.getByLabelText('Total due $1,000.00')).toBeTruthy();
  });

  it('drops an installment overdue by more than COMING_UP_OVERDUE_DAYS, from the list AND the total', () => {
    const ancient = bill({ installmentId: 99, itemId: 99, name: 'Forgotten', dueDate: '2025-01-01', amountCents: 50000, overdue: true });
    const recent = bill({ installmentId: 1, itemId: 1, name: 'Property tax', dueDate: '2026-07-30', amountCents: 20000, overdue: true });
    render(<ComingUpCard {...base} today={TODAY} bills={[ancient, recent]} />);
    expect(screen.queryByText('Forgotten')).toBeNull();
    expect(screen.getByText('Property tax')).toBeTruthy();
    expect(screen.getByLabelText('Total due $200.00')).toBeTruthy();
  });
});
```

Rewrite the existing assertion at `:89` — "keeps the header total summing EVERY listed row, overdue
included" — to say "every row inside the window, including the ones the +N more line stands for
(ruling P9)", keeping its fixtures unchanged. Use the file's own local `bill(over)` factory.

- [ ] **Step 8: Cap, bound and offer.**

`src/components/ComingUpCard.tsx`:

Add near the top:

```tsx
import { daysBetweenIso } from '@/lib/dates';

/**
 * Item P (ruling P9). The notification evaluator has had a flood guard since v1.4
 * (MAX_NEW_ROWS_PER_USER_PER_EVALUATION, notify/evaluate/coming-due.ts:18); this card had
 * nothing, so a household several bills behind got a wall of rows instead of a card.
 */
export const COMING_UP_ROW_LIMIT = 8;

/**
 * And nothing bounded the other end: with includeOverdue, an installment from years ago was
 * exactly as eligible as one from last week. Most-overdue-first with a cutoff, not literally
 * everything ever missed.
 */
export const COMING_UP_OVERDUE_DAYS = 90;
```

Add `today: string;` to the props type and `today,` to the destructuring, with:

```tsx
  /** Item P: the reference date for COMING_UP_OVERDUE_DAYS. The dashboard already has it. */
```

Replace the derived-values block so `listTotalCents` reads the bounded set:

```tsx
  const withinBound = bills.filter(
    (b) => !b.overdue || daysBetweenIso(b.dueDate, today) <= COMING_UP_OVERDUE_DAYS,
  );
  const listTotalCents = withinBound.reduce((sum, b) => sum + b.amountCents, 0);
  const hasOverdue = withinBound.some((b) => b.overdue);
  const shown = withinBound.slice(0, COMING_UP_ROW_LIMIT);
  const hiddenCount = withinBound.length - shown.length;
```

`bills.length === 0` in the self-hide at `:45` becomes `withinBound.length === 0`. Every later
reference to `bills` inside the render (`bills.length > 0` at `:69`, the `.map` at `:84`) reads
`withinBound` for the total/emptiness and `shown` for the rows. After the `.map`, before `</ul>`:

```tsx
{hiddenCount > 0 ? (
  <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
    {/* Ruling P10: there is no "+N more" pattern in this app yet and the Card's `action` slot
        already holds the money total, so the affordance goes in the list. This is the shape
        the next card copies. */}
    <Link href="/warranties" className="text-sm font-medium text-accent-text">
      +{hiddenCount} more due
    </Link>
  </li>
) : null}
```

Import `Link` from `next/link` if the file does not already.

- [ ] **Step 9: Pass `today` from the dashboard.**

`src/app/(app)/dashboard/page.tsx:278-285` — add `today={today}` to the `<ComingUpCard …>` props.
`today` is already in scope on that page. Change nothing else there.

- [ ] **Step 10: Watch them pass.**

```
npx vitest run tests/components/form-field.test.tsx tests/unit/auto-save.test.tsx tests/components/ComingUpCard.test.tsx tests/app/dashboard.test.tsx --reporter=dot
```

- [ ] **Step 11: Commit.**

```
git status --short
git add src/components/ui/form.tsx src/components/ui/AutoSave.tsx src/components/ComingUpCard.tsx src/app/(app)/dashboard/page.tsx tests/components/form-field.test.tsx tests/unit/auto-save.test.tsx tests/components/ComingUpCard.test.tsx tests/app/dashboard.test.tsx && git commit -m "fix(ui): hints stop naming their fields, saves are announced, and the coming-up card has a horizon (J, L, P)"
```

If step 4's sweep forced a query-string fix in another file, add that file's exact path to this
command and say so in your report.

---

# Lane A

### Task 4: /transactions stops naming rows ambiguously and stops shipping the roster

Items **M** and **BO** (ruling P16).

**Files:**
- Modify: `src/app/(app)/transactions/page.tsx:90`
- Modify: `src/app/(app)/transactions/transactions-client.tsx:440-449` (the bulk form), `:566-578`
  (the per-row select), `:588` (the kebab label)
- Modify: `src/components/QuickAddTransaction.tsx:92-101` (the Person field)
- Create: `tests/app/transactions-page.test.tsx`
- Test: `tests/app/transactions-client.test.tsx`, `tests/components/quick-add.test.tsx`

**Interfaces:**
- Produces: no new prop anywhere. `selfScoped` is already a prop of `TransactionsClient`
  (`:79, :95-97`) and is used at `:385` today; it gains two more uses.
  `QuickAddTransaction` reads `people.length`.
- Consumes: `isSelfScoped` (already imported at `transactions/page.tsx:2`), `formatCents`
  (`@/lib/money`).

**Guard:** `tests/ops/row-controls.test.ts:86` counts `<AutoSaveSelect` occurrences in `src/app/**`
against a floor of 5. The per-row select must be **conditionally rendered, not deleted** — the token
stays in the file.

- [ ] **Step 1: Write the failing client tests.**

In `tests/app/transactions-client.test.tsx`, first change the local `openRowMenu` helper at `:28` so
its 16 existing call sites keep passing a bare description:

```tsx
function openRowMenu(name: string): HTMLElement {
  // Item M: the label now carries the row's date and amount too, so an exact-string match no
  // longer finds it. The 16 call sites below still pass just the description.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const button = screen.getByRole('button', { name: new RegExp(`^Actions for ${escaped}`) });
  fireEvent.click(button);
  return button;
}
```

Then append:

```tsx
describe('TransactionsClient — two identical charges are tellable apart (item M)', () => {
  it('puts the row date and amount in the kebab name', () => {
    renderClient({
      page: pageOf([
        row({ id: 1, displayDescription: 'TIM HORTONS', date: '2026-08-03', amountCents: -412 }),
        row({ id: 2, displayDescription: 'TIM HORTONS', date: '2026-08-03', amountCents: -1099 }),
      ]),
    });
    // Sighted users disambiguate by position, amount and date; none of that was in the name.
    expect(screen.getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$4.12' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Actions for TIM HORTONS on 2026-08-03, -$10.99' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Actions for TIM HORTONS/ })).toHaveLength(2);
  });
});

describe('TransactionsClient — a self viewer gets no attribution controls (item BO)', () => {
  it('renders no bulk Attribute form and no per-row person select', () => {
    renderClient({ selfScoped: true, people: [], page: pageOf([row({ id: 1, displayDescription: 'TIM HORTONS' })]) });
    expect(screen.queryByRole('button', { name: 'Attribute' })).toBeNull();
    expect(screen.queryByLabelText('Person for transaction 1')).toBeNull();
    // Not rendered rather than shown-but-ineffective -- this file's own rule at :382-384.
    expect(screen.queryByLabelText('Person for the selected transactions')).toBeNull();
  });

  it('still shows who the row belongs to', () => {
    renderClient({ selfScoped: true, people: [], page: pageOf([row({ id: 1, attributedUserName: 'Alice' })]) });
    expect(screen.getByText('Alice')).toBeTruthy();
  });

  it('keeps both controls for a household viewer', () => {
    renderClient({ selfScoped: false, people: [{ id: 7, name: 'Alice' }], page: pageOf([row({ id: 1 })]) });
    expect(screen.getByLabelText('Person for transaction 1')).toBeTruthy();
  });
});
```

Use the file's own render helper and row factory names; if the bulk toolbar only appears once rows
are selected, select one first the way the file's existing bulk tests do.

Append to `tests/components/quick-add.test.tsx`:

```tsx
it('renders no Person field when there is nobody to attribute to (item BO)', () => {
  renderQuickAdd({ people: [] });
  // With people: [] the select degenerated to a lone "Account default" option -- a control that
  // cannot do anything, which is what item BO is about.
  expect(screen.queryByLabelText('Person')).toBeNull();
});

it('still renders it for a household viewer', () => {
  renderQuickAdd({ people: [{ id: 7, name: 'Alice' }] });
  expect(screen.getByLabelText('Person')).toBeTruthy();
});
```

Create `tests/app/transactions-page.test.tsx`, following
`tests/app/budgets-page.test.tsx`'s render-the-real-page-with-a-seeded-db pattern:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * Item BO. No transactions-page test existed before this task -- transactions-client.test.tsx
 * covers the client and transactions-actions.test.ts the writes, but nothing asserted what the
 * SERVER page hands the client, which is where the roster leaked.
 */
const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'member' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('TransactionsPage (item BO)', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function renderPage() {
    const { default: TransactionsPage } = await import('@/app/(app)/transactions/page');
    return render(await TransactionsPage({ searchParams: Promise.resolve({}) }));
  }

  it('does not serialize another household member to a self viewer', async () => {
    t = createSeededTestDb();
    const child = insertTestUser(t.db, { name: 'Robin', username: 'robin', role: 'member' });
    insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };

    const { container } = await renderPage();
    expect(container.innerHTML).not.toContain('Alice');
  });

  it('still hands a household viewer the roster', async () => {
    t = createSeededTestDb();
    const admin = insertTestUser(t.db, { name: 'Alice', username: 'alice', role: 'admin' });
    insertTestUser(t.db, { name: 'Bob', username: 'bob', role: 'member' });
    insertTestAccount(t.db, { type: 'chequing', ownerUserId: null });
    currentUser.value = { id: admin, name: 'Alice', username: 'alice', role: 'admin', visibility: 'household' };

    const { container } = await renderPage();
    expect(container.innerHTML).toContain('Bob');
  });
});
```

Mock any other module the page pulls in that jsdom cannot run (follow `budgets-page.test.tsx`'s own
mock list); if the page proves too heavy to render, keep the client tests and drop this file rather
than adding a Playwright test — say so in your report.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/app/transactions-client.test.tsx tests/components/quick-add.test.tsx tests/app/transactions-page.test.tsx --reporter=dot
```

- [ ] **Step 3: Name the kebab by more than the description.**

`src/app/(app)/transactions/transactions-client.tsx:579-588` — extend the existing intent comment and
the label:

```tsx
{/* The label names the ROW, not the column: "Actions" repeated identically down a table tells
    a screen reader nothing about which row it is on.
    v1.13.1 (item M): the description alone was not enough either -- two identical coffee-shop
    charges on one statement produced two buttons with the same name and nothing else to tell
    them apart. Date AND amount, because the named collision case is usually same-merchant
    AND same-date. */}
<RowMenu
  label={`Actions for ${row.displayDescription ?? row.rawDescription} on ${row.date}, ${formatCents(row.amountCents)}`}
>
```

Add `formatCents` to the `@/lib/money` import if it is not already there.

- [ ] **Step 4: Stop rendering the two inert controls.**

Wrap the bulk-attribute `<form>` (`:440-449`):

```tsx
{/* Item BO: for a self viewer every choice here returns NOT_YOURS_ERROR, so it is not
    rendered at all rather than shown-but-ineffective -- the same rule as the person filter
    at :382-384. */}
{selfScoped ? null : (
  <form action={attrAction} className="flex flex-wrap items-center gap-2">
    …unchanged…
  </form>
)}
```

Replace the per-row cell contents (`:566-578`):

```tsx
{selfScoped ? (
  // Item BO: plain text, not nothing -- the column keeps its width and the row keeps its
  // meaning. The <AutoSaveSelect below stays in this file on purpose: it is a conditional
  // render, and tests/ops/row-controls.test.ts counts the token.
  <span className="text-muted">{row.attributedUserName ?? 'Household'}</span>
) : (
  <AutoSaveSelect
    …unchanged…
  />
)}
```

- [ ] **Step 5: Stop building the roster for a self viewer.**

`src/app/(app)/transactions/page.tsx:87-90`:

```tsx
      // Ruling R5: every attribution picker reads the same list -- active people, login or not.
      // v1.13.1 (item BO): except for a self viewer, who gets none. Every attribution choice is
      // refused for them server-side, so the names were travelling into the client for controls
      // that could never work.
      people={isSelfScoped(viewer) ? [] : listAttributablePeople().map((person) => ({ id: person.id, name: person.name }))}
```

- [ ] **Step 6: Hide quick-add's Person field on an empty roster.**

`src/components/QuickAddTransaction.tsx`, wrapping the Person `Field` (`:92-101`):

```tsx
{/* Item BO: /transactions passes people: [] for a self viewer, which left this select with a
    lone "Account default" option -- a control that cannot do anything. No new prop: an empty
    roster is exactly the condition. */}
{people.length > 0 ? (
  <Field label="Person" className="sm:col-span-1">
    …unchanged…
  </Field>
) : null}
```

- [ ] **Step 7: Watch them pass.**

```
npx vitest run tests/app/transactions-client.test.tsx tests/components/quick-add.test.tsx tests/app/transactions-page.test.tsx tests/ops/row-controls.test.ts --reporter=dot
```

- [ ] **Step 8: Commit.**

```
git status --short
git add src/app/(app)/transactions/page.tsx src/app/(app)/transactions/transactions-client.tsx src/components/QuickAddTransaction.tsx tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx tests/components/quick-add.test.tsx && git commit -m "fix(transactions): name row menus uniquely and keep the household roster from a self viewer (M, BO)"
```

---

### Task 5: the last un-gated rule delete, and one query instead of N

Items **BJ** (rulings P12, P13) and **BL** (ruling P14).

**Files:**
- Modify: `src/lib/categorize/rules.ts` (add `exactRuleOwner` beside `upsertRuleFromCorrection`)
- Modify: `src/lib/categorize/engine.ts:512-541` (the R4 block), docblock at `:471-491`
- Modify: `src/lib/transactions.ts` (add `transactionOwners`)
- Modify: `src/app/(app)/transactions/actions.ts:38-52`
- Modify: `tests/ops/visibility-invariants.test.ts:48-69` (one EXEMPT entry)
- Test: `tests/lib/categorize/engine.test.ts`, `tests/lib/transactions.test.ts`,
  `tests/app/transactions-actions.test.ts`

**Interfaces:**
- Produces: `exactRuleOwner(pattern: string, kind: RuleKind): { createdBy: number | null; ownerName:
  string } | null`, exported from `@/lib/categorize/rules`.
- Produces: `transactionOwners(ids: number[]): Map<number, number | null>`, exported from
  `@/lib/transactions`. Id and owner only.
- Produces: no change to `RuleGuardedWriteResult` (`engine.ts:70-73`) — the refusal shape already
  exists and both `setTransferFlag` call sites (`src/lib/transactions.ts:404`,
  `src/app/(app)/review/actions.ts:110-116`) already surface it.

- [ ] **Step 1: Write the failing ownership tests.**

Append to `tests/lib/categorize/engine.test.ts`, inside (or immediately after) the existing R4 suite
at `:596`:

```ts
describe('ruling R4, fix round 2 (item BJ): setTransferFlag refuses over the rule it would DELETE', () => {
  it('refuses a member re-flagging a merchant whose not_transfer rule an admin owns', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: adminId, actorRole: 'admin',
    });

    const result = setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' });

    // The whole action refuses. An "optional owner check" that still deletes on a refusal is
    // not this fix -- every sibling R4 writer leaves every row and every rule untouched.
    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });
    expect(exactRuleOwner(merchant, 'not_transfer')).not.toBeNull();
    expect(exactRuleOwner(merchant, 'transfer')).toBeNull();
    expect(isTransferOf(txnId)).toBe(false);
  });

  it('refuses a member un-flagging a card-pattern merchant whose transfer rule an admin owns', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule({ cardPattern: true, startFlagged: true });
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: adminId, actorRole: 'admin',
    });

    const result = setTransferFlag({ transactionId: txnId, isTransfer: false, userId: memberId, actorRole: 'member' });

    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });
    expect(exactRuleOwner(merchant, 'transfer')).not.toBeNull();
    expect(isTransferOf(txnId)).toBe(true);
  });

  it('lets an admin delete anyone\'s opposite-kind rule', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: memberId, actorRole: 'member',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: adminId, actorRole: 'admin' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('lets a member delete their OWN opposite-kind rule', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: memberId, actorRole: 'member',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('deletes an ownerless rule as before', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: null, actorRole: 'admin',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });
});
```

Write `setupOwnedRule` and `isTransferOf` as small local helpers built on whatever seeded-db fixture
the R4 suite at `:596` already uses (it produces an `'Admin Owner'` user, which is where that string
comes from). `cardPattern: true` must give the transaction a `normalizedMerchant` containing one of
`CARD_PAYMENT_PATTERNS`, since that is the branch that takes the `not_transfer` upsert path.

Append to `tests/lib/transactions.test.ts`:

```ts
describe('transactionOwners (item BL)', () => {
  it('returns one entry per existing id, owner only', () => {
    const { aliceTxn, unattributedTxn, aliceId } = seedTwo();
    const owners = transactionOwners([aliceTxn, unattributedTxn]);
    expect(owners.get(aliceTxn)).toBe(aliceId);
    expect(owners.get(unattributedTxn)).toBeNull();
    expect(owners.size).toBe(2);
  });

  it('omits an id that does not exist, so a caller can still tell the two apart', () => {
    const { aliceTxn } = seedTwo();
    const owners = transactionOwners([aliceTxn, 999999]);
    expect(owners.has(999999)).toBe(false);
  });

  it('returns an empty map for no ids', () => {
    expect(transactionOwners([]).size).toBe(0);
  });
});
```

Append to `tests/app/transactions-actions.test.ts`:

```ts
describe('bulk ownership pre-check (item BL, ruling P14)', () => {
  it('still refuses a household viewer a nonexistent id and writes nothing', () => {
    // The regression this ruling exists to pin: getTransaction(id, viewer) returned null for
    // "no such row" as well as "not yours", and allTransactionsVisible refused on both. A
    // scope-only rewrite would quietly start accepting bogus ids from a household viewer.
    const before = categoryOf(txnId);
    return bulkCategorizeAction({}, formData({ ids: `${txnId},999999`, categoryId: String(groceriesId) })).then((result) => {
      expect(result.error).toBe(NOT_YOURS_ERROR);
      expect(categoryOf(txnId)).toBe(before);
    });
  });

  it('still refuses a self viewer somebody else\'s id and writes nothing', () => {
    currentUser = { ...currentUser, visibility: 'self' };
    const before = categoryOf(bobsTxnId);
    return bulkCategorizeAction({}, formData({ ids: String(bobsTxnId), categoryId: String(groceriesId) })).then((result) => {
      expect(result.error).toBe(NOT_YOURS_ERROR);
      expect(categoryOf(bobsTxnId)).toBe(before);
    });
  });
});
```

Reuse the file's existing `currentUser` box, `formData()` helper and seeded ids; add a `categoryOf`
helper only if the file has no equivalent.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/lib/categorize/engine.test.ts tests/lib/transactions.test.ts tests/app/transactions-actions.test.ts --reporter=dot
```
Expected: `exactRuleOwner` and `transactionOwners` are not exported; the two BJ refusal tests report
`{ ok: true }` with the admin's rule already deleted; the nonexistent-id test may pass today (it
pins existing behaviour) — that is correct and it must still pass after step 5.

- [ ] **Step 3: Add `exactRuleOwner`.**

In `src/lib/categorize/rules.ts`, immediately above `upsertRuleFromCorrection` (`:81`):

```ts
/**
 * Who owns the exact rule on (pattern, kind), or null if there is none.
 *
 * v1.13.1 (item BJ, ruling P13). upsertRuleFromCorrection has asked this question inline since
 * v1.13.0 (:96-107) for the rule it WRITES; setTransferFlag now needs the same answer about the
 * rule it DELETES, and two copies of a leftJoin whose fallback string has to match is exactly
 * how the two answers drift apart. Same query, same 'Another member' fallback, one definition.
 */
export function exactRuleOwner(
  pattern: string,
  kind: RuleKind,
): { createdBy: number | null; ownerName: string } | null {
  const row = getDb()
    .select({ createdBy: merchantRules.createdBy, ownerName: users.name })
    .from(merchantRules)
    .leftJoin(users, eq(users.id, merchantRules.createdBy))
    .where(
      and(
        eq(merchantRules.pattern, pattern),
        eq(merchantRules.matchType, 'exact'),
        eq(merchantRules.ruleKind, kind),
      ),
    )
    .get();
  return row === undefined ? null : { createdBy: row.createdBy, ownerName: row.ownerName ?? 'Another member' };
}
```

- [ ] **Step 4: Make `setTransferFlag` refuse.**

`src/lib/categorize/engine.ts`. Add `exactRuleOwner` to the `@/lib/categorize/rules` import (or the
relative one the file uses). Extend the docblock at `:486-491`:

```
   * v1.13.1 ruling R4, fix round 2 (item BJ). The check above gates the rule this action WRITES;
   * the OPPOSITE-kind rule it removes as housekeeping (the two deleteExactRule calls below) was
   * deleted unconditionally, so a member re-flagging one transaction could delete an
   * admin-authored not_transfer or transfer rule with no ownership check at all. That rule is
   * now resolved HERE, in the same block and before is_transfer is written, and a member who
   * does not own it gets the whole action refused -- no row touched, no rule deleted -- exactly
   * as confirmCategory and upsertRuleFromCorrection already refuse for the rule they write.
```

Then, at the end of the R4 block (after the `else if (matchesCardPattern)` arm closes at `:541` and
**before** the `db.update(transactions)` at `:543`):

```ts
    // The kind whichever delete below would remove. Mirrors the branches at :548-557 exactly:
    // re-flagging as a transfer removes the not_transfer override; un-flagging a
    // non-card-pattern merchant removes the learned transfer rule; un-flagging a card-pattern
    // merchant removes nothing (it wrote an override instead, above).
    const housekeepingKind: RuleKind | null = input.isTransfer
      ? 'not_transfer'
      : matchesCardPattern
        ? null
        : 'transfer';
    if (housekeepingKind !== null && input.actorRole !== 'admin') {
      const owner = exactRuleOwner(row.normalizedMerchant, housekeepingKind);
      if (owner !== null && owner.createdBy !== null && owner.createdBy !== input.userId) {
        return { ok: false, reason: 'owned_by_another', ownerName: owner.ownerName };
      }
    }
```

The two `deleteExactRule` calls at `:552` and `:556` stay exactly where they are. Add a one-line
comment above each noting that ownership was settled above.

- [ ] **Step 5: Add `transactionOwners` and rewrite the pre-check.**

In `src/lib/transactions.ts`, beside `getTransaction` (`:200-213`):

```ts
/**
 * Owner ids for a set of transaction ids, in ONE query.
 *
 * v1.13.1 (item BL, ruling P14). This is NOT a read-model and deliberately returns no money, no
 * description and no merchant -- it is the narrow half of an ownership pre-check that used to
 * run getTransaction (three joins and the full SELECTION) once per selected id on every bulk
 * action, for a check that needs one column.
 *
 * An id with no row is ABSENT from the map rather than present with a null owner, because the
 * caller has to keep telling those two apart: "no such row" and "not yours" are the same
 * refusal (see getTransaction's own comment) and a household viewer POSTing a bogus id is
 * refused today and must stay refused.
 */
export function transactionOwners(ids: number[]): Map<number, number | null> {
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .select({ id: transactions.id, attributedUserId: transactions.attributedUserId })
    .from(transactions)
    .where(inArray(transactions.id, ids))
    .all();
  return new Map(rows.map((row) => [row.id, row.attributedUserId]));
}
```

Then `src/app/(app)/transactions/actions.ts`, replacing `:50-52` (keep the existing docblock at
`:38-49` and append to it):

```ts
 * v1.13.1 (item BL, ruling P14): the loop above was one full-row fetch per id. It is now one
 * narrow query, and BOTH refusals it used to make are kept explicitly -- an id with no row at
 * all, and an id owned by somebody else. Losing the first would have let a household viewer
 * bulk-write against ids that do not exist.
 */
function allTransactionsVisible(ids: number[], viewer: SessionUser): boolean {
  const owners = transactionOwners(ids);
  for (const id of ids) if (!owners.has(id)) return false;
  const scope = ownerScope(viewer);
  if (scope === null) return true;
  for (const owner of owners.values()) if (owner !== scope) return false;
  return true;
}
```

Add `transactionOwners` to the `@/lib/transactions` import and `ownerScope` to the
`@/lib/auth/viewer` import. Remove `getTransaction` from the imports only if nothing else in the file
still uses it — the single-row actions at `:159`, `:270`, `:292`, `:382`, `:425`, `:500` may.

- [ ] **Step 6: Record the exemption.**

`tests/ops/visibility-invariants.test.ts`, appending to the `EXEMPT` array (`:48-69`):

```ts
  {
    file: 'src/lib/transactions.ts',
    fn: 'transactionOwners',
    why: 'not a read-model: returns transaction id and attributed_user_id only -- no amount, no description, no merchant, no joins. It exists so the bulk ownership pre-check in transactions/actions.ts costs one query instead of one getTransaction per selected id, and its callers compare the owners it returns against ownerScope(viewer) themselves before any write (item BL, v1.13.1).',
  },
```

The guard's floor (`>= 27`) rises to 28 real entries, which is the safe direction. Do not change the
floor number.

- [ ] **Step 7: Watch them pass.**

```
npx vitest run tests/lib/categorize/engine.test.ts tests/lib/transactions.test.ts tests/app/transactions-actions.test.ts tests/lib/visibility tests/ops/visibility-invariants.test.ts --reporter=dot
```

Also run the two other suites that exercise `setTransferFlag` indirectly:

```
npx vitest run tests/lib/splits-bulk.test.ts tests/app/review-actions.test.ts --reporter=dot
```

- [ ] **Step 8: Commit.**

```
git status --short
git add src/lib/categorize/rules.ts src/lib/categorize/engine.ts src/lib/transactions.ts src/app/(app)/transactions/actions.ts tests/ops/visibility-invariants.test.ts tests/lib/categorize/engine.test.ts tests/lib/transactions.test.ts tests/app/transactions-actions.test.ts && git commit -m "fix(security): refuse a transfer flip that would delete another member's rule; check bulk ownership in one query (BJ, BL)"
```

---

### Task 6: the import path stops offering a mapping OFX has no use for, and refuses what commit refuses

Items **BP** (ruling P18) and **BQ** (ruling P19).

**Files:**
- Modify: `src/lib/import/preview.ts:52-94` (the `PreviewResult` interface), `:170-193` (the result
  literal)
- Modify: `src/app/(app)/import/import-client.tsx:551-558`
- Modify: `src/app/api/import/preview/route.ts:5` (import), `:72-74` (the gate)
- Test: `tests/lib/import/preview.test.ts`, `tests/app/import-client.test.tsx`,
  `tests/api/import.route.test.ts`

**Interfaces:**
- Produces: `PreviewResult.source: 'csv' | 'ofx'` — additive, required, set for every preview. It
  does not affect MUST-6.1's `'cardValues' in preview` guarantee.
- Consumes: `acceptsTransactions` (`src/lib/accounts.ts:31-33`) in the route.

- [ ] **Step 1: Write the failing tests.**

Append to `tests/lib/import/preview.test.ts` (the file already imports `parseOfx` and has an OFX
fixture path):

```ts
it('reports the source so the client can stop offering a CSV mapping (item BP)', () => {
  const csv = buildPreview({ stagingId: csvStagingId, filename: 'td-chequing.csv', accountId, profileId, mapping });
  expect(csv.source).toBe('csv');
  const ofx = buildPreview({ stagingId: ofxStagingId, filename: 'statement.ofx', accountId, profileId, mapping });
  expect(ofx.source).toBe('ofx');
  // The two fields the client was inferring OFX from remain what they were -- source replaces
  // the inference, it does not change the data.
  expect(ofx.dateFormatDetection.status).toBe('none');
  expect(ofx.columnOptions).toEqual([]);
});
```

Use the file's existing staging/fixture setup rather than inventing one; if it has no OFX staging
helper, write the OFX fixture through the same `writeStagedFile` the CSV cases use.

Append to `tests/app/import-client.test.tsx`:

```tsx
it('renders no mapping editor and no date-format banner for an OFX preview (item BP)', async () => {
  const { queryByText } = await renderWithPreview({ source: 'ofx', dateFormatDetection: { candidates: [], status: 'none', detected: null }, columnOptions: [] });
  // The banner told people their dates were unreadable over a file whose dates parsed fine,
  // beside controls that preview and commit both ignore for OFX (ruling R9).
  expect(queryByText(/Could not recognize this column's date format/)).toBeNull();
  expect(queryByText(/Date column/)).toBeNull();
});

it('still renders both for a CSV preview whose dates did not parse', async () => {
  const { getByText } = await renderWithPreview({ source: 'csv', dateFormatDetection: { candidates: [], status: 'none', detected: null } });
  expect(getByText(/Could not recognize this column's date format/)).toBeTruthy();
});
```

`renderWithPreview` is whatever this file already does to get a preview on screen (it stubs `fetch`
per test with `vi.stubGlobal`); add `source` to its preview fixture and thread the override through.

Append to `tests/api/import.route.test.ts`, inside `describe('POST /api/import/preview')`:

```ts
it('400s an asset account, the same refusal commit already makes (item BQ)', async () => {
  const assetId = insertTestAccount(current!.db, { name: 'House', type: 'asset', ownerUserId: null });
  const form = new FormData();
  form.append('file', new File([fixture('td-chequing.csv')], 'td-chequing.csv', { type: 'text/csv' }));
  form.append('accountId', String(assetId));
  form.append('profileId', String(profileId));
  const response = await previewRoute(
    new Request('http://nas.local:3000/api/import/preview', { method: 'POST', headers: headers(), body: form }),
  );
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe('That account only holds a balance you type in.');
  // Nothing staged: the refusal lands before the file is written.
  expect(fs.readdirSync(path.join(tempDir, 'tmp')).length === 0 || !fs.existsSync(path.join(tempDir, 'tmp'))).toBe(true);
});
```

Add `insertTestAccount` to this file's `../helpers/db` import.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/lib/import/preview.test.ts tests/app/import-client.test.tsx tests/api/import.route.test.ts --reporter=dot
```

- [ ] **Step 3: Add `source` to the preview.**

`src/lib/import/preview.ts` — in the interface (`:52-94`), after `truncated`:

```ts
  /**
   * Which reader produced this preview. v1.13.1 (item BP, ruling P18): the client had no way to
   * ask, so it rendered the CSV mapping editor over an OFX file -- whose controls preview and
   * commit both ignore (ruling R9) -- and MappingEditor turned dateFormatDetection.status
   * 'none' into a "could not recognize this column's date format" warning about dates that
   * parsed perfectly. Inferring it from columnOptions.length and that status would encode two
   * unrelated implementation details into a UI condition; one field says it outright.
   */
  source: 'csv' | 'ofx';
```

And in the result literal (`:170-193`), beside `skipped`:

```ts
    source: ofx ? 'ofx' : 'csv',
```

- [ ] **Step 4: Stop rendering the editor for OFX.**

`src/app/(app)/import/import-client.tsx:551-558`:

```tsx
{preview.source === 'csv' ? (
  <MappingEditor
    mapping={mapping}
    onChange={(next) => void rePreview(next)}
    dateFormatDetection={preview.dateFormatDetection}
    busy={busy}
    cardColumnOptions={preview.columnOptions}
  />
) : (
  // Item BP: an OFX file carries its own columns (DTPOSTED / NAME / TRNAMT / FITID), so there
  // is nothing to map and every control in the editor was inert.
  <p className="text-sm text-muted">
    This file carries its own columns, so there is nothing to map — check the rows below and
    commit.
  </p>
)}
```

- [ ] **Step 5: Refuse an asset account at preview.**

`src/app/api/import/preview/route.ts` — widen the `@/lib/accounts` import at `:5` to
`import { acceptsTransactions, getAccount } from '@/lib/accounts';`, then after the `!account` 404 at
`:73`:

```ts
  // v1.13.1 ruling R10 (item BQ): commit (api/import/commit/route.ts:49), the SimpleFIN link
  // (api/simplefin/link/route.ts:46) and commitStagedImport (lib/import/flow.ts:49) all refuse an
  // asset account with this exact sentence; preview accepted one and only failed at commit.
  if (!acceptsTransactions(account.type)) {
    return Response.json({ error: 'That account only holds a balance you type in.' }, { status: 400 });
  }
```

- [ ] **Step 6: Watch them pass.**

```
npx vitest run tests/lib/import/preview.test.ts tests/app/import-client.test.tsx tests/api/import.route.test.ts tests/api/import-raw-preview.route.test.ts tests/integration/import-flow.test.ts --reporter=dot
```

- [ ] **Step 7: Commit.**

```
git status --short
git add src/lib/import/preview.ts src/app/(app)/import/import-client.tsx src/app/api/import/preview/route.ts tests/lib/import/preview.test.ts tests/app/import-client.test.tsx tests/api/import.route.test.ts && git commit -m "fix(import): hide the CSV mapping editor for OFX and refuse asset accounts at preview (BP, BQ)"
```

---

# Lane C

### Task 7: Settings tells you what happened, and an admin can turn a login off

Items **H** and **BI** (ruling P11).

**Files:**
- Modify: `src/app/(app)/settings/actions.ts:226, :236, :257, :309, :357` (five signatures)
- Modify: `src/app/(app)/settings/updates-client.tsx:53-58`
- Modify: `src/app/(app)/settings/users/actions.ts` (add `setCanSignInAction`)
- Modify: `src/app/(app)/settings/users/users-manager.tsx:124-134` (header), `:144-171` (the new
  cell), `:195`, `:231` (two colSpans)
- Test: `tests/app/update-actions.test.ts`, `tests/app/updates-card.test.tsx`,
  `tests/app/users-actions.test.ts`, `tests/app/users-manager.test.tsx`

**Interfaces:**
- Produces: `enableUpdateChecksAction`, `disableUpdateChecksAction`, `checkForUpdateNowAction`,
  `applyUpdateAction`, `dismissUpdateAction` all become
  `(_prev: UpdateActionState, formData: FormData) => Promise<UpdateActionState>`.
  `reviewUpdateAction` (`:284`) is **not** touched — it revalidates nothing by design and returns a
  different state type.
- Produces: `setCanSignInAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState>`,
  exported from `src/app/(app)/settings/users/actions.ts`.
- Consumes: `setUserCanSignIn` (`src/lib/auth/users.ts:265-269`), which **throws** on the
  last-admin case; the action catches and returns `error.message`.

Both action files are `'use server'`: every export must be an async function
(`tests/ops/use-server-exports.test.ts`). `users-manager.tsx` is `'use client'` and must keep
`import type { UserRecord }` — a value import from `@/lib/auth/users` would trip
`tests/ops/client-bundle.test.ts`.

- [ ] **Step 1: Write the failing update tests.**

Append to `tests/app/update-actions.test.ts`:

```ts
describe('the update actions take (prevState, formData) so React can process them (item H)', () => {
  it('checkForUpdateNowAction still returns its message and still revalidates', async () => {
    const result = await actions.checkForUpdateNowAction({}, new FormData());
    expect(typeof result.message === 'string' || typeof result.error === 'string').toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith('/settings');
  });

  it('says so when there is nothing new, rather than looking identical', async () => {
    // A control that greys out and then looks the same is indistinguishable from one that did
    // nothing. The SENTENCE is the fix, not just the props refresh.
    const result = await actions.checkForUpdateNowAction({}, new FormData());
    expect(result.message).toBe('You are on the newest published version.');
  });

  it('enable/disable/apply/dismiss all accept the same call shape', async () => {
    await expect(actions.enableUpdateChecksAction({}, new FormData())).resolves.toBeTruthy();
    await expect(actions.disableUpdateChecksAction({}, new FormData())).resolves.toBeTruthy();
    const fd = new FormData();
    fd.set('version', '9.9.9');
    await expect(actions.applyUpdateAction({}, fd)).resolves.toBeTruthy();
    await expect(actions.dismissUpdateAction({}, fd)).resolves.toBeTruthy();
  });
});
```

Adjust the "nothing new" case to whatever state the file's existing fixtures put `readUpdateState()`
in; the point of the assertion is the exact sentence, not the setup.

Append to `tests/app/updates-card.test.tsx`:

```tsx
it('passes every server action to useActionState directly (item H)', () => {
  // The cause, asserted as source shape, because the symptom (stale props after Check now) is
  // not observable in jsdom: a closure defined in a 'use client' module is a CLIENT function,
  // so React never processes a server-action response for it and the router never refreshes.
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/(app)/settings/updates-client.tsx'),
    'utf8',
  );
  const wrapped = [...source.matchAll(/useActionState\(\s*async\s*\(/g)];
  // reviewUpdateAction is the one deliberate exception: it revalidates nothing and returns a
  // different state type (settings/actions.ts:280-284).
  expect(wrapped).toHaveLength(1);
});

it('shows the action's own message when nothing changed', () => {
  render(<UpdatesClient {...base} />);
  // …drive the mocked checkForUpdateNowAction to resolve { message: 'You are on the newest
  // published version.' } and assert the success Notice carries it…
});
```

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/app/update-actions.test.ts tests/app/updates-card.test.tsx --reporter=dot
```
Expected: type errors / arity failures on the action calls, and the source-shape assertion counting
five wrapped closures instead of one.

- [ ] **Step 3: Change the five signatures.**

`src/app/(app)/settings/actions.ts`. Each of `enableUpdateChecksAction` (`:226`),
`disableUpdateChecksAction` (`:236`), `checkForUpdateNowAction` (`:257`), `applyUpdateAction`
(`:309`) and `dismissUpdateAction` (`:357`) becomes:

```ts
export async function xAction(_prev: UpdateActionState, formData: FormData): Promise<UpdateActionState> {
```

`applyUpdateAction` and `dismissUpdateAction` already read `formData` — their bodies are unchanged
past the signature. The three that take nothing simply ignore both parameters. Add one comment above
the group:

```ts
/**
 * v1.13.1 (item H). All five take (prevState, formData) — including the three that read
 * neither — so updates-client.tsx can hand React the server action ITSELF rather than an inline
 * async closure. A closure defined in a 'use client' module is a client function, so React never
 * processes a server-action response for it: revalidatePath below invalidated the server cache
 * while the client kept the props from the original render, and the availability UI is driven by
 * props, not by the message these return. reviewUpdateAction keeps its own shape — it revalidates
 * nothing and returns a different state type.
 */
```

- [ ] **Step 4: Pass them directly.**

`src/app/(app)/settings/updates-client.tsx:53-58`:

```tsx
const [enableState, enable] = useActionState(enableUpdateChecksAction, initial);
const [disableState, disable] = useActionState(disableUpdateChecksAction, initial);
const [autoState, saveAuto] = useActionState(setAutoApplyAction, initial);
const [checkState, checkNow] = useActionState(checkForUpdateNowAction, initial);
const [applyState, apply] = useActionState(applyUpdateAction, initial);
const [dismissState, dismiss] = useActionState(dismissUpdateAction, initial);
```

`reviewUpdateAction` at `:59-62` stays wrapped. Leave `messages` (`:65-67`) and the `Notice` at
`:123` exactly as they are — they already render the returned message; item H's complaint was that
the props around them never moved.

- [ ] **Step 5: Write the failing sign-in tests.**

Append to `tests/app/users-actions.test.ts`:

```ts
describe('setCanSignInAction (item BI)', () => {
  it('turns a member into an attribution-only person', async () => {
    const result = await setCanSignInAction({}, formData({ userId: String(memberId), canSignIn: '0' }));
    expect(result.message).toBeTruthy();
    expect(listUsers().find((u) => u.id === memberId)?.canSignIn).toBe(false);
  });

  it('turns them back', async () => {
    await setCanSignInAction({}, formData({ userId: String(memberId), canSignIn: '0' }));
    await setCanSignInAction({}, formData({ userId: String(memberId), canSignIn: '1' }));
    expect(listUsers().find((u) => u.id === memberId)?.canSignIn).toBe(true);
  });

  it('refuses to lock an admin out, in the library's own words', async () => {
    const result = await setCanSignInAction({}, formData({ userId: String(adminId), canSignIn: '0' }));
    expect(result.error).toBe('An admin must be able to sign in. Make them a member first.');
    expect(listUsers().find((u) => u.id === adminId)?.canSignIn).toBe(true);
  });

  it('rejects a cross-origin request before touching anything', async () => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const result = await setCanSignInAction({}, formData({ userId: String(memberId), canSignIn: '0' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });
});
```

Append to `tests/app/users-manager.test.tsx`:

```tsx
it('offers a sign-in toggle on every row (item BI)', () => {
  render(<UsersManager users={[user({ id: 2, name: 'Bob', canSignIn: true })]} />);
  const toggle = screen.getByLabelText('Bob can sign in') as HTMLInputElement;
  expect(toggle.checked).toBe(true);
});

it('reflects an attribution-only person', () => {
  render(<UsersManager users={[user({ id: 3, name: 'Robin', canSignIn: false })]} />);
  expect((screen.getByLabelText('Robin can sign in') as HTMLInputElement).checked).toBe(false);
});
```

Add `setCanSignInAction: vi.fn(async () => ({}))` to this file's existing `vi.mock` of
`@/app/(app)/settings/users/actions`.

- [ ] **Step 6: Add the action.**

`src/app/(app)/settings/users/actions.ts`, immediately after `setVisibilityAction`:

```ts
/**
 * v1.13.1 (item BI). setUserCanSignIn has existed since v1.13.0 (src/lib/auth/users.ts:265) with
 * no server action and no control anywhere, so an admin could create a no-login person at signup
 * (createPersonWithoutLogin) but could not convert an existing member into one, or back, without
 * editing the database by hand. Shaped exactly like setVisibilityAction above; the last-admin
 * refusal is the library's own throw, surfaced verbatim.
 */
export async function setCanSignInAction(_prev: UsersFormState, formData: FormData): Promise<UsersFormState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  await requireAdmin();
  const parsed = z
    .object({ userId: z.coerce.number().int().positive(), canSignIn: z.enum(['0', '1']) })
    .safeParse({ userId: formData.get('userId'), canSignIn: formData.get('canSignIn') });
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    setUserCanSignIn(parsed.data.userId, parsed.data.canSignIn === '1');
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not update the user.' };
  }
  revalidatePath('/settings/users');
  return { message: 'Updated.' };
}
```

Add `setUserCanSignIn` to the `@/lib/auth/users` import.

- [ ] **Step 7: Add the column.**

`src/app/(app)/settings/users/users-manager.tsx`:

1. Header (`:124-134`) — a `<th scope="col">Sign-in</th>` after "Sees".
2. Per row, after the "Sees" cell (`:144-161`):

```tsx
<td>
  {/* Item BI (ruling P11). A checkbox, not a select: it is a boolean, and the row already
      auto-saves its visibility one cell to the left. Reversible, single-row, refused
      server-side with a sentence -- the auto-save safety rule's own definition. */}
  <AutoSaveCheckbox
    name="canSignIn"
    defaultChecked={user.canSignIn}
    fields={{ userId: String(user.id) }}
    action={(formData) => setCanSignInAction({}, formData)}
    label={`${user.name} can sign in`}
    labelHidden
  />
</td>
```

3. Both `colSpan={7}` (`:195`, `:231`) become `colSpan={8}`.
4. Add `AutoSaveCheckbox` to the `@/components/ui/AutoSave` import and `setCanSignInAction` to the
   `./actions` import.

- [ ] **Step 8: Watch them pass.**

```
npx vitest run tests/app/update-actions.test.ts tests/app/updates-card.test.tsx tests/app/users-actions.test.ts tests/app/users-manager.test.tsx tests/ops/use-server-exports.test.ts tests/ops/client-bundle.test.ts tests/ops/row-controls.test.ts --reporter=dot
```

- [ ] **Step 9: Commit.**

```
git status --short
git add src/app/(app)/settings/actions.ts src/app/(app)/settings/updates-client.tsx src/app/(app)/settings/users/actions.ts src/app/(app)/settings/users/users-manager.tsx tests/app/update-actions.test.ts tests/app/updates-card.test.tsx tests/app/users-actions.test.ts tests/app/users-manager.test.tsx && git commit -m "fix(settings): update actions refresh the card, and an admin can turn a login off (H, BI)"
```

---

### Task 8: a digest that would over-scope is not sent, and three guards start testing what they claim

Items **BK**, **BN** (ruling P21), **B** (ruling P20) and **K**.

**Files:**
- Modify: `src/lib/notify/evaluate/digest.ts:14-30, :58`
- Modify: `src/lib/notify/evaluate/monthly.ts:22-33, :184`
- Modify: `tests/ops/onboarding-coverage.test.ts:156-160`
- Modify: `tests/lib/warranty/ocr/onnx/engine.test.ts:89-107`
- Modify: `tests/app/bills-actions.test.ts` (one new test)
- Create: `tests/app/bills-actions-refusals.test.ts`
- Test: `tests/lib/notify/evaluate/digest.test.ts`, `tests/lib/notify/evaluate/monthly.test.ts`
- Contingency: `src/app/(app)/help/content.tsx` — only if step 3's tightened guard finds an
  undocumented route

**Interfaces:**
- Produces: both `viewerFor` functions return `Viewer | null`. They are module-private; no export
  changes and no caller outside their own files.
- Produces: nothing for BN — tests only, no source file is modified for it.

`src/lib/notify/evaluate/stale.ts` has a third copy of `viewerFor` and is **out of scope** (item BK
names two files). Do not touch it.

- [ ] **Step 1: Write the failing digest tests.**

Append to `tests/lib/notify/evaluate/digest.test.ts`:

```ts
it('sends nothing when the recipient\'s own row is gone (item BK)', () => {
  const userId = seedRecipient();
  deleteUserRow(userId);
  // The fallback was { role: 'admin', visibility: 'household' }, so a self-scoped child whose
  // account was deleted mid-batch could have carried household-wide figures in that one
  // delivery. Silence is safer than an over-scoped send.
  expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-24', now: new Date('2026-08-24T10:00:00Z') })).toBe(0);
  expect(outboxCount(userId)).toBe(0);
});
```

And the same shape in `tests/lib/notify/evaluate/monthly.test.ts` against `evaluateMonthBoundary`.
Build `seedRecipient` / `deleteUserRow` / `outboxCount` on whatever fixtures those two files already
use.

- [ ] **Step 2: Skip instead of falling back.**

`src/lib/notify/evaluate/digest.ts` — rewrite the docblock's third paragraph and the function:

```ts
/**
 * …first two paragraphs unchanged…
 *
 * v1.13.1 (item BK). Returns null — and the evaluator sends NOTHING — if the user row is gone by
 * the time this runs (a deleted account mid-batch). It used to fall back to a household-scoped
 * admin viewer so one missing row could not crash the batch, which is still the right instinct;
 * the wrong part was the shape of the fallback. A self-scoped recipient whose row vanished in
 * the window their digest fired would have carried household-wide figures in that one delivery,
 * which is the single thing ruling R2 exists to prevent. Skipping still cannot crash the batch.
 */
function viewerFor(userId: number): Viewer | null {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : null;
}
```

At `digest.ts:58`:

```ts
  const viewer = viewerFor(input.userId);
  // Item BK: 0 already means "no outbox row was enqueued" to every caller of this function.
  if (viewer === null) return 0;
```

Do exactly the same in `src/lib/notify/evaluate/monthly.ts` (`:30-33` and `:184`, inside
`fireMonthlyDigest`), with a docblock that says the same thing in that file's own words rather than
a copy-paste — the two docblocks already differ deliberately.

- [ ] **Step 3: Tighten onboarding guard 2.**

`tests/ops/onboarding-coverage.test.ts:156-160`:

```ts
  it('each non-exempt NAV href appears as a WHOLE PATH SEGMENT in the help feature index', () => {
    const content = read('src/app/(app)/help/content.tsx');
    // Item B (ruling P20). This was content.includes(item.href), so /settings was satisfied six
    // times over by /settings/accounts and friends -- and a future /report or /budget route
    // would have been silently satisfied by the already-documented /reports or /budgets, which
    // is the one failure this guard exists to prevent.
    const documented = (href: string) =>
      new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-/])`).test(content);
    const undocumented = guardedNav.filter((item) => !documented(item.href));
    expect(undocumented.map((item) => `${item.href} (${item.label})`)).toEqual([]);
  });

  it('does not accept a strict prefix as documentation (the failure this guard is for)', () => {
    const documented = (href: string, content: string) =>
      new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-/])`).test(content);
    expect(documented('/report', '<Where path="/reports">Reports —</Where>')).toBe(false);
    expect(documented('/reports', '<Where path="/reports">Reports —</Where>')).toBe(true);
  });
```

Run it. `src/app/(app)/help/content.tsx:402` already carries `<Where path="/settings">`, so
`/settings` passes on its own merit; the other eight are expected to as well. **If any href fails,
the fix is to document that route in `help/content.tsx` — never to loosen the guard back.**

- [ ] **Step 4: Stop the PDF test doing work it does not need.**

`tests/lib/warranty/ocr/onnx/engine.test.ts:89-107`, replacing the whole test:

```ts
  it('runs no inference at all for a PDF (MUST-4.2, MUST-7.1)', async () => {
    // v1.13.1 (item K). This used to call receiptFile() -- a 1400x900 raw RGB buffer through
    // sharp().png() -- and fakeSessions(), whose first line runs the real preprocessReceipt.
    // Both were dead weight: the PNG is never recognized and runDet is overwritten immediately,
    // and the cost is what made this test hit the 20s testTimeout in one full-suite run and
    // pass 7/7 in isolation straight after. Same family as item E, different mechanism: a
    // genuine wall-clock timeout on a test that loads the PDF stack while 249 other files
    // compete for the CPU. The fix is not a bigger timeout -- it is to measure the code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-pdf-'));
    try {
      let touched = 0;
      const refuse = async (): Promise<never> => {
        touched += 1;
        throw new Error('the PDF path must never reach a session');
      };
      setOnnxSessionsForTests({
        runDet: refuse,
        runCls: refuse,
        runRec: refuse,
        clsInputHeight: 48,
        clsInputWidth: 192,
        recClassCount: DICT.length,
        dictionary: DICT,
      });

      const pdf = path.join(dir, 'not-a-pdf.pdf');
      fs.writeFileSync(pdf, Buffer.from('not really a pdf'));
      await expect(onnxOcrEngine.recognize(pdf, 'application/pdf')).rejects.toThrow();
      expect(touched).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
```

The other six tests in the file keep `receiptFile()`/`fakeSessions()` — their docblock reason (the
detection tensor must agree with the real preprocess or `detectBoxes` throws) genuinely applies to
them and not to this one. `maxRetries`/`retryDelay` on the `rmSync` is the same Windows-handle
answer item E landed on.

- [ ] **Step 5: Pin the two bill-action forwardings.**

Create `tests/app/bills-actions-refusals.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * Item BN. recordInstallmentPayment's linked_elsewhere refusal and the rule_owned refusal are
 * both exercised at the library level; neither goes through the ACTION, which is the layer a
 * future refactor could silently stop forwarding. Reproducing linked_elsewhere end-to-end would
 * re-test the library (it is raised deep inside the payment's own db.transaction by a loan rule
 * claiming the transaction), so this file forces each result and asserts the sentence the person
 * is shown. Partial mock: findInstallmentItem and everything else stay real.
 */
const recordInstallmentPayment = vi.hoisted(() => vi.fn());

vi.mock('@/lib/warranty/installments', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/warranty/installments')>()),
  recordInstallmentPayment,
}));

let currentUser = { id: 1, name: 'Alice', username: 'alice', role: 'admin' as const, visibility: 'household' as const };
let originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

vi.mock('@/lib/auth/session', () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(originHeaders) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { recordBillPaymentAction } from '@/app/(app)/bills/actions';

// …the beforeEach/afterEach block from tests/app/bills-actions.test.ts, unchanged: mkdtempSync
// into DATA_DIR, createSeededTestDb, an admin, a chequing account with setLastAccountId, a bill
// item type, a bill item and one unpaid installment. Reuse it verbatim rather than inventing a
// second fixture shape.…

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe('recordBillPaymentAction forwards the library\'s refusals (item BN)', () => {
  it('turns linked_elsewhere into a sentence about the loan rule', async () => {
    recordInstallmentPayment.mockReturnValue({ ok: false, reason: 'linked_elsewhere' });
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe('That payment matched an existing loan rule instead of this bill, so nothing was recorded.');
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('passes a rule_owned refusal through in the library\'s own words', async () => {
    recordInstallmentPayment.mockReturnValue({
      ok: false,
      reason: 'rule_owned',
      error: 'Alice set up this rule. Ask an admin to change it under Settings → Categories & rules.',
    });
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe('Alice set up this rule. Ask an admin to change it under Settings → Categories & rules.');
    expect(unpaidCount(itemId)).toBe(1);
  });
});
```

And append to `tests/app/bills-actions.test.ts` (unmocked, real path):

```ts
it('skips an asset account when resolving where the payment lands (item BN)', async () => {
  // Ruling R10: an asset holds a balance somebody types in; it takes no transactions. If the
  // person's remembered account is one, accountForPayment must walk past it rather than record
  // a payment against a house.
  const assetId = insertTestAccount(current!.db, { name: 'House', type: 'asset', ownerUserId: null });
  setLastAccountId(adminId, assetId);

  const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));

  expect(result.message).toBeTruthy();
  expect(accountOfLastTransaction()).toBe(accountId);
  expect(findUserById(adminId)?.lastAccountId).toBe(accountId);
});
```

Add `accountOfLastTransaction` as a small local helper if the file has no equivalent.

- [ ] **Step 6: Watch them all pass.**

```
npx vitest run tests/lib/notify/evaluate/digest.test.ts tests/lib/notify/evaluate/monthly.test.ts tests/ops/onboarding-coverage.test.ts tests/lib/warranty/ocr/onnx/engine.test.ts tests/app/bills-actions.test.ts tests/app/bills-actions-refusals.test.ts --reporter=dot
```

Then run the OCR file **in isolation** and note its wall-clock time, which is the whole point of
item K:

```
npx vitest run tests/lib/warranty/ocr/onnx/engine.test.ts --reporter=verbose
```

- [ ] **Step 7: Commit.**

```
git status --short
git add src/lib/notify/evaluate/digest.ts src/lib/notify/evaluate/monthly.ts tests/lib/notify/evaluate/digest.test.ts tests/lib/notify/evaluate/monthly.test.ts tests/ops/onboarding-coverage.test.ts tests/lib/warranty/ocr/onnx/engine.test.ts tests/app/bills-actions.test.ts tests/app/bills-actions-refusals.test.ts && git commit -m "fix(notify): skip a digest whose recipient is gone rather than sending it household-scoped (BK, BN, B, K)"
```

If step 3 required a `help/content.tsx` edit, add that path to the command and say so in your
report.

---

# Release

### Task 9: v1.13.1

**Alone.** Nothing else may be in flight while this runs, because it asserts the state of the whole
tree. All three lanes must be finished and committed first.

**Files:**
- Modify: `package.json:3` (`"version": "1.13.0"` → `"1.13.1"`)
- Modify: `CHANGELOG.md` (insert between `## Unreleased` and `## [1.13.0]`)
- Modify: `docs/PENDING-FIXES.md` (23 items; two new items appended)
- Modify: `tests/ops/docker.test.ts:248-267` (the 1.13.0 block, flipped) and a new 1.13.1 block
  above it

**This task does NOT tag and does NOT push.** A tag push repoints GHCR `:latest`, which the NAS
pulls. The owner's own session cuts the tag. Stop after the commit and say so in your report.

**Interfaces:** none.

- [ ] **Step 1: Bump the version.**

`package.json` line 3: `"version": "1.13.1",`

- [ ] **Step 2: Write the changelog entry.**

Read the header comment at the top of `CHANGELOG.md` first — it is the rule, not decoration. Keep
`## Unreleased` in place and empty above the new section. Date it `2026-08-28`. Insert between
`## Unreleased` and `## [1.13.0]`:

```markdown
## [1.13.1] - 2026-08-28

**Before updating:** this release changes no tables at all — it is the smallest kind of update
this app has. You do not need a backup for the migration's sake because there is no migration;
take one anyway if it is easy, because it is the only way back to 1.13.0.

### Fixed

- **Settings → Updates tells you what it found.** Pressing **Check now** used to grey the button
  out, settle, and leave the card looking exactly as it did — you had to refresh the page to find
  out whether an update existed. It now updates in place, and when you are already on the newest
  version it says so instead of looking identical to a button that did nothing.
- **A bill shows its schedule on the Contracts & Coverage list.** A bill three weeks overdue used
  to read "Ongoing" on the one page most people navigate to. It now shows the next due date, or an
  overdue count, in the same column.
- **A bill's detail page stops showing four blanks.** Vendor, Model, Serial number and Price are
  fields a bill can never hold, and the card rendered an em-dash for each of them above the
  installments. They are hidden now — unless the item actually has a value stored, in which case it
  stays on screen rather than being quietly dropped.
- **The dashboard's Coming-up card has a limit.** A household several bills behind got a wall of
  rows instead of a card, and an installment missed years ago counted exactly as much as one missed
  last week. It now shows the eight nearest with a "+N more due" link, and stops counting anything
  more than 90 days overdue.
- **Import refuses an account it cannot import into, at the preview.** Choosing an asset account —
  a house, a TFSA — used to preview happily and only fail when you pressed commit.
- **An OFX or QFX file no longer shows a column-mapping editor.** Those files carry their own
  columns, so every control in that panel was ignored, and the warning about an unreadable date
  column was about dates that had parsed perfectly.

### Security

- **Re-flagging a transfer can no longer delete somebody else's rule.** Marking a transaction as a
  transfer (or un-marking it) tidies up the opposite rule for that merchant. That tidy-up ran with
  no ownership check at all, so a member could remove a rule an admin had set up. It now refuses
  the whole action and changes nothing, the same way every other rule edit already does.
- **A scheduled digest is skipped rather than sent household-wide.** If a person's account was
  deleted in the same window their weekly or monthly digest fired, that one message was built with
  a household-wide view — even for someone who is only supposed to see their own records. It is now
  not sent at all.
- **A child's Transactions page no longer carries the household roster.** The names of everyone in
  the household were being sent to the browser to fill in attribution menus that refused every
  choice. The menus are gone for that account and so are the names.

### Changed

- **An admin can turn a person's sign-in off and back on.** Settings → Users has a new Sign-in
  column. Turning it off leaves the person in every attribution menu — their share of the spending
  still counts — while taking away their login. An admin's own sign-in cannot be turned off; make
  them a member first.
- **Screen readers are told when an auto-saving field saved.** A refused save was announced and a
  successful one was not, which is the wrong way round.
- **Field hints stop being read as part of the field's name.** A hint under an input was being
  read as though it were the label, so "Original amount" was announced as "Original amount What you
  borrowed. Used for the payoff bar." every time.
- **Row menus on Transactions name their row unambiguously.** Two identical charges on the same
  statement produced two menu buttons a screen reader could not tell apart; the button now carries
  the row's date and amount too.
- **The Reports page stops describing things that are not on it.** For an account that only sees
  its own records, the page's own explanation used to promise an Export CSV button and a
  per-person split card that were correctly absent.
```

- [ ] **Step 3: Flip the docker ops test.**

`tests/ops/docker.test.ts` — change the existing `MUST-7.1: the 1.13.0 release` block (`:248-267`)
into `MUST-7.1: the 1.13.0 release is still recorded intact (append-only discipline)`: swap
`expect(pkg.version).toBe('1.13.0')` for `expect(pkg.version).not.toBe('1.13.0')` and keep every
other assertion in it exactly as written. Then add above it:

```ts
  it('MUST-7.1: the 1.13.1 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.13.1');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.1\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.1]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.1]'), changelog.indexOf('## [1.13.0]'));
    expect(entry).toMatch(/### Fixed/);
    expect(entry).toMatch(/### Security/);
    expect(entry).toMatch(/### Changed/);
    // A reader coming from 1.13.0 is expecting a schema warning. Saying there is none is the
    // information; omitting the paragraph is not.
    expect(entry).toMatch(/changes no tables at all/i);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Check now/);
    expect(entry).toMatch(/next due date, or an overdue count/i);
    expect(entry).toMatch(/\+N more due/);
    expect(entry).toMatch(/no ownership check at all/i);
    expect(entry).toMatch(/skipped rather than sent household-wide/i);
    expect(entry).toMatch(/no longer carries the household roster/i);
    expect(entry).toMatch(/Sign-in column/);
  });
```

- [ ] **Step 4: Record all 23 items in `docs/PENDING-FIXES.md`.**

Twenty are SHIPPED and three are CLOSED. Use the file's own conventions: the item's bold heading gets
`— SHIPPED in v1.13.1`, and where the item has a `Status:` line, that line becomes
`Status: SHIPPED in v1.13.1 — see docs/superpowers/specs/2026-08-28-v1-13-1-backlog-sweep-design.md`.

| Items | Where | Mark |
|---|---|---|
| A, B | `## v1.10.0 leftovers`, `:460`, `:467` | SHIPPED in v1.13.1 |
| C, D, F | same section, `:475`, `:481`, `:505` | **CLOSED in v1.13.1 — no code** (see below) |
| H, I, J, K | `:599`, `:650`, `:675`, `:690` | SHIPPED in v1.13.1 |
| L, M | `## v1.11.0 leftovers`, `:706`, `:718` | SHIPPED in v1.13.1 |
| P, Q, R | `## v1.12.0 leftovers`, `:761`, `:772`, `:780` | SHIPPED in v1.13.1 |
| BI–BQ | `## v1.13.0 leftovers`, `:1486`+ | SHIPPED in v1.13.1 |

Also:
- The line at `:1484`, "Status for all six below: OPEN — from the v1.13.0 build review", is wrong
  (it governs nine items, not six) and is now spent. Replace it with
  `Status for all nine below: SHIPPED in v1.13.1.`
- C, D and F each get one added paragraph carrying ruling P1's reason verbatim: C because its only
  available fix is what ruling A7 forbids and no false pass has happened; D because it is a note and
  `PageGuide` lost the `empty` prop it describes in v1.12.0; F because `pool` is already pinned
  (`vitest.config.ts:18`) and a worker RPC timeout raised to mask a OneDrive filter-driver stall
  cannot be verified from the machine that has the stall — the standing rule (read the counts, not
  the exit code; CI is the gate) stays in force.
- Append two new OPEN items after BQ:

```markdown
**BR. `/dashboard` and `/goals` still serialize the household roster to a self viewer.**
Status: OPEN — from the v1.13.1 planning pass (ruling P17). `dashboard/page.tsx:65` and
`goals/page.tsx:28` both call `listAttributablePeople()` unconditionally; `budgets/page.tsx:78-79`
already filters to the viewer's own row and `/transactions` was fixed in v1.13.1 (item BO). Same
fix, two more pages. Effort: S.

**BS. `Field`'s implicit-label branch still has no `aria-describedby`.**
Status: OPEN — from the v1.13.1 planning pass (ruling P7). Item J moved the hint out of the
`<label>`, so a hint is no longer part of the accessible name anywhere; but 17 call sites pass a
`hint` with no `htmlFor`, and `src/components/ui/form.tsx` has no `'use client'` directive and is
rendered from server components, so `useId()` is unavailable and no id can be generated for those.
The fix is to give those 17 call sites an `htmlFor` and their inputs an `id`, at which point the
existing `${htmlFor}-hint` wiring covers them. Effort: M, mechanical, spread across nine files.
```

- [ ] **Step 5: Run the whole suite and the type check.**

```
npx vitest run
npx tsc --noEmit
```

`tsc` must be clean. Vitest may exit 1 with everything passing (backlog item F) — read the counts.
Every failure that is a real failure gets fixed here, in this task, before the commit.

- [ ] **Step 6: Commit.**

```
git status --short
git add package.json CHANGELOG.md docs/PENDING-FIXES.md tests/ops/docker.test.ts && git commit -m "chore(release): v1.13.1"
```

**Do not tag. Do not push.** Report that the release commit is on `main` and that the tag and the
push are the owner's to make.

---

## Item → task mapping

All 23 items in scope, and where each is built.

| Item | Task | Lane | File(s) that carry it |
|---|---|---|---|
| A | **T1** | B | `src/app/(app)/reports/reports-client.tsx` |
| B | **T8** | C | `tests/ops/onboarding-coverage.test.ts` |
| C | **T9** | release | `docs/PENDING-FIXES.md` — CLOSED, no code (P1) |
| D | **T9** | release | `docs/PENDING-FIXES.md` — CLOSED, no code (P1) |
| F | **T9** | release | `docs/PENDING-FIXES.md` — CLOSED, no code (P1) |
| H | **T7** | C | `settings/actions.ts`, `settings/updates-client.tsx` |
| I | **T2** | B | `warranties-client.tsx`, `settings/managers/managers-client.tsx` |
| J | **T3** | B | `src/components/ui/form.tsx` |
| K | **T8** | C | `tests/lib/warranty/ocr/onnx/engine.test.ts` |
| L | **T3** | B | `src/components/ui/AutoSave.tsx` |
| M | **T4** | A | `transactions-client.tsx` |
| P | **T3** | B | `src/components/ComingUpCard.tsx`, `dashboard/page.tsx` |
| Q | **T2** | B | `src/lib/warranty/constants.ts`, `warranties/page.tsx`, `warranties-client.tsx` |
| R | **T2** | B | `warranties/[id]/warranty-detail-client.tsx` |
| BI | **T7** | C | `settings/users/actions.ts`, `settings/users/users-manager.tsx` |
| BJ | **T5** | A | `src/lib/categorize/rules.ts`, `src/lib/categorize/engine.ts` |
| BK | **T8** | C | `notify/evaluate/digest.ts`, `notify/evaluate/monthly.ts` |
| BL | **T5** | A | `src/lib/transactions.ts`, `transactions/actions.ts`, `tests/ops/visibility-invariants.test.ts` |
| BM | **T1** | B | `src/app/(app)/reports/reports-client.tsx` |
| BN | **T8** | C | `tests/app/bills-actions.test.ts`, `tests/app/bills-actions-refusals.test.ts` (tests only) |
| BO | **T4** | A | `transactions/page.tsx`, `transactions-client.tsx`, `QuickAddTransaction.tsx` |
| BP | **T6** | A | `src/lib/import/preview.ts`, `import-client.tsx` |
| BQ | **T6** | A | `src/app/api/import/preview/route.ts` |

Every item appears exactly once. No item is split across two tasks, and no task spans two lanes.

## Self-review

Run against the spec with fresh eyes, before handing this to anybody.

**1. Spec coverage.** All 23 of the spec's "item by item" subsections map to a task in the table
above. Every ruling has somewhere it is applied: P1 → T9 step 4. P2 → T1 steps 1/3. P3 → T2 steps
7/11. P4, P5 → T2 steps 3/6/7. P6 → T2 step 9. P7 → T3 steps 1–4. P8 → T3 steps 5–6. P9, P10 → T3
steps 7–9. P11 → T7 steps 5–7. P12, P13 → T5 steps 3–4. P14 → T5 steps 5–6. P15 → T1 step 4. P16 →
T4 steps 4–6. P17 → T9 step 4 (item BR). P18 → T6 step 3. P19 → T6 step 5. P20 → T8 step 3. P21 →
T8 step 5. P22 → this mapping table's 23 rows.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Four
places name an existing helper rather than writing it out — `renderList` (T2),
`renderDetail`/`detailItem` (T2), `setupOwnedRule`/`isTransferOf` (T5), and the bills fixture block
(T8) — and each is explicitly identified as "the helper that file already uses", with what it must
produce, because inventing a second fixture beside an existing one is a worse outcome than reusing
the first. Two steps (T7 step 1's second `updates-card` case, T8 step 5's `beforeEach`) carry an
ellipsis where the brief instructs the implementer to copy an existing block verbatim rather than
retype it; both say which block and where.

**3. Type consistency across tasks.** `billScheduleLabel(nextDueDate, overdueCount)` is defined in
T2 and called in T2 only. `billSchedules` is `Record<number, {nextDueDate, overdueCount}>` in both
the producing page and the consuming client, and is a plain object, not a `Map`, because it crosses
a server/client boundary. `exactRuleOwner` returns `{createdBy, ownerName} | null` in T5's
definition and is read that way in T5's engine change and T5's tests. `transactionOwners` returns
`Map<number, number | null>` in T5's definition and is consumed as a Map in T5's caller.
`PreviewResult.source` is declared in T6 and read in T6. `COMING_UP_ROW_LIMIT` /
`COMING_UP_OVERDUE_DAYS` are declared and used in T3 only. The five update actions gain the same
`(_prev, formData)` shape in T7's source change and T7's tests. No symbol crosses a lane.

**4. Lane disjointness — verified path by path.** No path below appears in more than one lane.

*Lane A* (T4, T5, T6): `src/app/(app)/transactions/transactions-client.tsx`,
`src/app/(app)/transactions/page.tsx`, `src/components/QuickAddTransaction.tsx`,
`src/app/(app)/transactions/actions.ts`, `src/lib/transactions.ts`, `src/lib/categorize/engine.ts`,
`src/lib/categorize/rules.ts`, `src/lib/import/preview.ts`,
`src/app/(app)/import/import-client.tsx`, `src/app/api/import/preview/route.ts`,
`tests/ops/visibility-invariants.test.ts`, `tests/app/transactions-client.test.tsx`,
`tests/app/transactions-page.test.tsx`, `tests/components/quick-add.test.tsx`,
`tests/app/transactions-actions.test.ts`, `tests/lib/transactions.test.ts`,
`tests/lib/categorize/engine.test.ts`, `tests/app/import-client.test.tsx`,
`tests/lib/import/preview.test.ts`, `tests/api/import.route.test.ts`.

*Lane B* (T1, T2, T3): `src/app/(app)/reports/reports-client.tsx`,
`src/app/(app)/warranties/warranties-client.tsx`, `src/app/(app)/warranties/page.tsx`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, `src/lib/warranty/constants.ts`,
`src/app/(app)/settings/managers/managers-client.tsx`, `src/components/ui/form.tsx`,
`src/components/ui/AutoSave.tsx`, `src/components/ComingUpCard.tsx`,
`src/app/(app)/dashboard/page.tsx`, `tests/app/reports-client.test.tsx`,
`tests/lib/reports.test.ts`, `tests/app/warranties-client.test.tsx`,
`tests/app/warranty-detail-client.test.tsx`, `tests/lib/warranty/constants.test.ts`,
`tests/app/managers-client.test.tsx`, `tests/components/form-field.test.tsx`,
`tests/unit/auto-save.test.tsx`, `tests/components/ComingUpCard.test.tsx`,
`tests/app/dashboard.test.tsx`.

*Lane C* (T7, T8): `src/app/(app)/settings/actions.ts`,
`src/app/(app)/settings/updates-client.tsx`, `src/app/(app)/settings/users/actions.ts`,
`src/app/(app)/settings/users/users-manager.tsx`, `src/lib/notify/evaluate/digest.ts`,
`src/lib/notify/evaluate/monthly.ts`, `src/app/(app)/help/content.tsx` (contingency),
`tests/app/updates-card.test.tsx`, `tests/app/update-actions.test.ts`,
`tests/app/users-manager.test.tsx`, `tests/app/users-actions.test.ts`,
`tests/lib/notify/evaluate/digest.test.ts`, `tests/lib/notify/evaluate/monthly.test.ts`,
`tests/ops/onboarding-coverage.test.ts`, `tests/lib/warranty/ocr/onnx/engine.test.ts`,
`tests/app/bills-actions.test.ts`, `tests/app/bills-actions-refusals.test.ts`.

*Release* (T9): `package.json`, `CHANGELOG.md`, `docs/PENDING-FIXES.md`,
`tests/ops/docker.test.ts`.

Four near-misses, resolved deliberately and worth naming so a reviewer does not re-derive them:
- **`transactions-client.tsx` (A/T4) vs `transactions/actions.ts` (A/T5)** — different files, same
  lane, sequenced T4 then T5. That sequencing also means item M's kebab change lands before item
  BL's ownership rewrite, and the two never meet.
- **`src/app/(app)/settings/managers/managers-client.tsx` (B/T2) vs
  `src/app/(app)/settings/users/users-manager.tsx` and `settings/actions.ts` (C/T7)** — three
  different files under `settings/`. No shared symbol: T2 adds a `<colgroup>`, T7 adds a column and
  an action.
- **`src/components/QuickAddTransaction.tsx` (A/T4) vs `src/components/ComingUpCard.tsx` and
  `src/components/ui/*` (B/T3)** — different files. `QuickAddTransaction` renders `Field`, which T3
  edits; that is a render-time dependency, not a file conflict, and it is the plan's one declared
  contingency (T3 step 4's sweep).
- **`src/lib/warranty/constants.ts` (B/T2) vs `tests/lib/warranty/ocr/onnx/engine.test.ts` (C/T8)** —
  different files under `warranty/`, and neither reads the other.

**5. No schema change, verified.** `drizzle/**` and `src/db/schema.ts` appear in no task's file set
and in no `git add` command. Grep this plan for `schema.ts`: every mention is a citation of an
existing column, never a Modify line.

**6. Guards, verified against their actual assertions.** `table-layout` requires `minWidth` beside
`fixed` — both of T2's conversions carry it, and the `<col>`/`<th>` counts are asserted in T2's own
tests since the guard deliberately does not. `row-controls` counts `<AutoSaveSelect` against a floor
of 5 — T4 conditionally renders rather than deletes, and T7 adds a checkbox, so the count only
rises. `visibility-invariants` gains one `EXEMPT` entry with a 40+ character reason and loses
nothing; no `viewer: Viewer` parameter is removed or made optional anywhere in this release.
`client-bundle` — no `'use client'` file gains a value import: T7 keeps `import type { UserRecord }`,
T2's `warranties-client.tsx` imports only from `@/lib/warranty/constants` (already sanctioned) while
the `unpaidInstallments` call lives in the server page. `use-server-exports` — T7's new export is an
async function.

**7. Items that lose a claim.** Three fixes named in the backlog are deliberately not built, each
recorded as a planner ruling in the spec and repeated in Task 9's PENDING-FIXES paragraphs so the
record survives the release: guard 3's tightening (C, P1), the vitest worker timeout (F, P1), and
`aria-describedby` on the 17 `hint`-without-`htmlFor` call sites (J, P7 → backlog BS). One item is
narrowed: BO fixes `/transactions` and the same leak on `/dashboard` and `/goals` becomes backlog BR
(P17). If the owner reverses any of these, each is a small addition to the task named in the mapping
table, not a re-plan.
