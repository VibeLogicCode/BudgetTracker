# Fold the Review queue into Transactions — implementation plan (v1.14.1)

> **For agentic workers:** two lanes, disjoint file sets. Lane 1 owns the library + actions, Lane 2
> owns the UI + navigation + docs. No Playwright. Vitest + `tsc` only.

**Goal:** `/transactions?review=1` becomes the review queue — same rows, same teaching behaviour,
same card layout — so every feature built for Transactions is automatically available while
reviewing, and `/review` stops being a second surface that has to be kept in step.

**Why:** the Transactions page gained splits, notes, people, loans and "Assign to new loan…" while
Review kept only a category picker. The gap was invisible until it bit. One page, one row renderer,
one set of actions.

**Spec:** this file (the inventory below is the requirement).

## Global constraints

- No Playwright / browser tests. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths, or real statement data in code, docs or fixtures.
- Conventional commits. NO `Co-Authored-By` and no Claude attribution. Never change git identity.
- `no new Date()` in `src/lib/**` (an `at: Date = new Date()` default parameter is the repo's pattern).
- Integer cents, ISO dates.
- 44px minimum touch targets on anything new (`min-h-11 sm:min-h-0`, or `.field-control` which now
  carries the mobile floor).
- Never `git stash`, never `git add -A`, never touch `.tmp-data/`, never create worktrees, never
  copy or delete anything under `node_modules`.
- Stage and commit as ONE command: `git status --short` first, then
  `git add <exact files> && git commit -m "..."`.

## Inventory — everything `/review` can do, and where it lands

Taken from `src/app/(app)/review/{page,review-client,actions}.tsx|ts` before deletion. Nothing in
this table may be lost.

| # | Review capability | Where it goes |
|---|---|---|
| 1 | Queue = not a transfer AND (uncategorised OR `source='bayes'`) AND not split (`REVIEW_WHERE`, `src/lib/categorize/engine.ts`) | `TransactionFilter.reviewOnly` (Lane 1) |
| 2 | Oldest-first order | `listTransactions` orders `asc` when `reviewOnly` (Lane 1) |
| 3 | "N waiting" eyebrow + nav badge | Chip label + existing `reviewCount` badge, repointed (Lane 2) |
| 4 | Guess badge `guessed <category> (margin 0.82)` | Card badge in review mode (Lane 2) |
| 5 | **Accept guess** button | Kebab item, review mode only (Lane 2 + `acceptGuessAction`, Lane 1) |
| 6 | Category pick **creates a rule** (teaches the categorizer) | `setCategoryAction` gains a `teach` field; review mode sends `teach=1` (ruling R3) |
| 7 | **Apply to all N matching + create rule** | Kebab item opening an inline editor (Lane 2 + `applyToAllMatchingAction`, Lane 1) |
| 8 | Per-row **Mark as transfer** (+ learns an exact rule) | Kebab item, BOTH directions, every row, not just review mode (ruling R4) |
| 9 | `matchingCount` per row | Computed for review-mode rows only (Lane 1) |
| 10 | "Nothing to review" empty state with next-step links | Review-mode empty state (Lane 2) |
| 11 | Three paragraphs of teaching copy | Review-mode `PageGuide` (Lane 2) |
| 12 | Page refuses a `self` viewer (the queue is household-wide) | Ruling R2 — chip hidden, `review=1` ignored for a self viewer |
| 13 | Card layout (stacked `<li>`, no sideways scroll) | Review mode renders cards INSTEAD of the table (ruling R5) |

## Rulings

- **R1.** `?review=1` is a filter, not a page. `TransactionFilter.reviewOnly?: boolean`; `buildWhere`
  pushes `REVIEW_WHERE`; `listTransactions` flips to `asc(date), asc(id)` when it is set. The queue
  definition stays in `engine.ts` and is imported — never restated.
- **R2.** Review mode is household-only, exactly as the page was. For `isSelfScoped(viewer)` the
  filter is forced off (`reviewOnly: false`) and the chip is not rendered. No redirect, no error:
  a kid who hand-edits the URL simply gets their normal transactions list.
- **R3.** A category pick means two different things and the filter decides which:
  in review mode it teaches (`confirmCategory({ createRule: true })`), outside it does not
  (`createRule: false`, today's behaviour, deliberately). The row sends `teach=1` in review mode;
  `setCategoryAction` reads it. Absent or any other value means no rule.
- **R4.** Per-row transfer toggle is offered on EVERY row, both directions — "Mark as transfer" and
  "Not a transfer" — because the gap it fills (bulk toolbar only) is not review-specific. The
  rule-ownership refusal from `setTransferFlag` surfaces as the row's error, never silently.
- **R5.** Review mode renders a card list instead of the table. It does NOT render both: duplicating
  rows would give every control two DOM nodes and break label-based queries across the suite.
  Full-page mobile cards is out of scope and is recorded as backlog **BW**.
- **R6.** `/review` stays as a route and redirects to `/transactions?review=1`. Bookmarks, the
  dashboard callout, the import link and the nav item all keep working.
- **R7.** The nav keeps its "Review" entry and its count badge; only the `href` changes. Muscle
  memory and the badge are the point of the entry.
- **R8.** `applyCategoryToMatching` and `confirmCategory` keep their `actorRole` argument. No
  authorization behaviour changes anywhere in this release.

## Lane 1 — library and actions

**Files**
- Modify: `src/lib/transactions.ts` (filter + order), `src/app/(app)/transactions/actions.ts`
  (port the four review actions, `teach` flag, per-row transfer)
- Test: `tests/lib/transactions.test.ts`, `tests/app/transactions-actions.test.ts`

**Produces** (Lane 2 consumes these names verbatim):

```ts
// src/lib/transactions.ts
export interface TransactionFilter { /* …existing… */ reviewOnly?: boolean }

// src/app/(app)/transactions/actions.ts
export async function acceptGuessAction(_prev: ActionState, formData: FormData): Promise<ActionState>;
export async function applyToAllMatchingAction(_prev: ActionState, formData: FormData): Promise<ActionState>;
export async function setRowTransferAction(_prev: ActionState, formData: FormData): Promise<ActionState>;
// setCategoryAction unchanged in signature; now reads formData.get('teach') === '1'
```

**Steps**

1. RED: a `listTransactions` test asserting `reviewOnly: true` returns exactly the rows
   `listReviewQueue` returns, in the same (oldest-first) order, and that it still honours a
   `self` viewer's owner scope.
2. Implement: `reviewOnly` on the filter, `REVIEW_WHERE` pushed in `buildWhere`, `asc` ordering
   when set. Import `REVIEW_WHERE` from `@/lib/categorize/engine` (already imported in this file).
3. RED: action tests — accept a guess; apply to all matching (creates the rule); mark a row a
   transfer and un-mark it; a category pick with `teach=1` creates a rule and without it does not;
   a rule owned by another member refuses with the existing message and writes nothing.
4. Implement: port `acceptGuessAction`, `applyToAllMatchingAction` and `markTransferAction`
   (renamed `setRowTransferAction`, reading an `isTransfer` field so it works both ways) from
   `src/app/(app)/review/actions.ts` into `src/app/(app)/transactions/actions.ts`, keeping their
   guards, messages and `actorRole` arguments byte-identical. Replace `revalidatePath('/review')`
   with `revalidatePath('/transactions')` in the ported actions; leave every other existing
   `revalidatePath('/review')` in this file alone (Lane 2 removes them with the route).
   Add the `teach` read to `setCategoryAction` per ruling R3.
5. Run `npx vitest run tests/lib/transactions.test.ts tests/app/transactions-actions.test.ts
   tests/ops/use-server-exports.test.ts tests/ops/visibility-invariants.test.ts` and
   `npx tsc --noEmit`.
6. Commit: `feat(transactions): a review filter, and the review actions move here`.

## Lane 2 — UI, navigation, docs

**Files**
- Modify: `src/app/(app)/transactions/page.tsx`, `src/app/(app)/transactions/transactions-client.tsx`,
  `src/app/(app)/review/page.tsx` (becomes a redirect), `src/components/app-shell/nav.ts`,
  `src/app/(app)/dashboard/page.tsx` (callout href), `src/app/(app)/import/import-client.tsx`
  (link href), `src/app/(app)/help/content.tsx`, `src/app/(app)/settings/managers/revalidation-routes.ts`,
  `CHANGELOG.md`
- Delete: `src/app/(app)/review/review-client.tsx`, `src/app/(app)/review/actions.ts`,
  `tests/app/review-client.test.tsx`, `tests/app/review-actions.test.ts`
- Test: `tests/app/transactions-client.test.tsx`, `tests/app/transactions-page.test.tsx`,
  `tests/app/review-page.test.ts` (rewritten as a redirect test), `tests/app/help.test.tsx`

**Steps**

1. `page.tsx`: parse `review=1` into `reviewOnly`, forced `false` for a self viewer (R2); compute
   `matchingCount` per row with `countMatchingMerchant` only when in review mode; pass
   `reviewMode` and the review count to the client.
2. RED then implement the review-mode card list in `transactions-client.tsx`: port the `<li>`
   markup from `review-client.tsx` (merchant + raw description with the NFC-safe dedupe, amount,
   date · account · guess-or-uncategorised badge, the "This transaction only" labelled select),
   and hang every other action off the existing `RowMenu`.
3. Kebab additions — **every row**: "Mark as transfer" / "Not a transfer" (R4).
   **Review mode only**: "Accept <category>" when `source === 'bayes'` and a category is guessed;
   "Apply a category to all N…" opening an inline editor row (the `Note…` / new-loan disclosure
   pattern) with a labelled select and an Apply button that posts to `applyToAllMatchingAction`.
   The inline editor stays open on a refusal and shows the error inline.
4. "Needs review (N)" filter chip beside the existing chips, hidden for a self viewer; review-mode
   `PageGuide` carrying Review's three teaching paragraphs; review-mode empty state
   ("Nothing to review. Everything is categorized.") with the two links Review had.
5. `review/page.tsx` → `redirect('/transactions?review=1')`, nothing else. Repoint `nav.ts`
   (keep the label, the icon and the badge), the dashboard callout, the import link, the help
   `<Where path=...>` copy, and `revalidation-routes.ts`.
6. Delete the two review client/action files and their two test files after porting their
   assertions into the transactions tests. Rewrite `tests/app/review-page.test.ts` to assert the
   redirect.
7. `CHANGELOG.md`: new `## [1.14.1] - 2026-08-29` section, no migration, describing the merge and
   the per-row transfer toggle.
8. Run `npx vitest run tests/app tests/ops` and `npx tsc --noEmit`.
9. Commit: `feat(transactions): the review queue is a filter here now, not a second page`.

## Release (after both lanes)

`package.json` → `1.14.1`; `tests/ops/docker.test.ts` gains a 1.14.1 block and renames the 1.14.0
one to "still recorded intact"; `docs/PENDING-FIXES.md` records backlog **BW** (full-page mobile
card layout for every table, ~3–4 h, needs one responsive row component rather than duplicated
markup). Then the full suite, `tsc`, tag `v1.14.1`, image.
