# Collapsible budget groups, one month control, and a limit that tells you the truth — plan (v1.18.0)

> **For agentic workers:** two lanes, disjoint file sets. No Playwright. Vitest + `npx tsc --noEmit`.

**Goal:** the month is stated once instead of three times, the budgets page is eight rows instead of
forty, and a parent limit that its children have outgrown says so.

**Spec:** this file. It follows a screenshot review of v1.17.0 running on the owner's own data.

## Global constraints

- No Playwright. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths or real statement data in code, comments,
  tests, fixtures or commit messages. Invented sample data only.
- Conventional commits. NO `Co-Authored-By`, no Claude attribution. Never change git identity.
- `no new Date()` in `src/lib/**`. Integer cents, ISO dates, months as `YYYY-MM`.
- 44px minimum touch targets. Never `git stash`, never `git add -A`, never touch `.tmp-data/`,
  never create a worktree, never copy or delete anything under `node_modules`.
- Lanes run NO git commands. The orchestrator stages and commits.
- No migration in this release. Nothing is added to the database.

## Rulings

- **U1. One control states the month, once.** v1.17.0 shipped an eyebrow (`AUGUST 2026`), a pill nav
  (`August 2026`) and a native month input (`August, 2026`) in the same header strip — three
  statements of one fact, two of them interactive. The nav's centre pill BECOMES the picker; the
  separate input goes.
- **U2. A collapsed group still carries its numbers.** Collapsing that hides the totals just moves
  the information further away. A closed group header shows the group's limit, spend, remaining and
  bar — all of which the rollup already computes.
- **U3. Everything collapsed by default, marked when it needs attention.** A page visited once a
  month should have the same shape every time, so the default does not depend on the data. An
  over-budget group carries a marker on its closed header, which is how the signal survives the
  default.
- **U4. Household and Personal do NOT collapse.** They are the two halves of the page's answer;
  putting either behind a toggle hides half of why someone opened it.
- **U5. Open/closed is a viewing preference, not household data.** It lives in the browser, per
  person, never in the database.
- **U6. A parent limit its children have outgrown is disclosed, never blocked.** The owner's first
  instinct was to refuse the child edit; the decision after discussion is to warn. Three reasons,
  recorded so this is not relitigated: (a) blocking traps rebalancing — moving $200 from one child
  to another is refused unless done in one specific order; (b) lowering the PARENT below its
  children's total produces the same inconsistent state, so either that is blocked too (making a
  parent nearly uneditable) or the warning has to exist anyway; (c) this page auto-saves with no
  Save button (v1.11.0 ruling R1), and a rejected value in an auto-saving field has no good resting
  state. The warning is inline and persistent, never a toast, and it offers the two repairs.

## Lane 1 — one month control, and the dashboard header

**Files:** `src/components/ui/MonthNav.tsx`, `src/app/(app)/dashboard/page.tsx`; tests
`tests/app/dashboard.test.tsx` and whichever test covers `MonthNav` (find it; Lane 3 of v1.17.0
added coverage in the budgets or dashboard tests).

1. **`MonthNav` loses its separate `<input type="month">`** (ruling U1). The centre pill becomes the
   picker: it reads `August 2026` with a chevron, and activating it opens a native month input —
   keep the real `<input type="month">` in the DOM for keyboard and mobile pickers, visually
   collapsed behind the pill rather than sitting beside it as a second control. Prev/next stay, but
   they show `Jul` / `Sep`, never `2026-07` / `2026-09`: one control must not print two date
   formats.
2. **The dashboard header stops repeating itself.** Delete the `AUGUST 2026` eyebrow above the
   greeting — the nav says it, in the place where it can be changed. Drop "this month" from the
   subtitle, which is wrong the moment someone navigates anyway.
3. Budgets picks both up for free through the shared component. Do NOT edit `budgets-client.tsx` —
   Lane 2 owns that file. If the budgets page has its own month eyebrow, report it and leave it.

Keep the "Viewing <Month>" banner for a non-current month exactly as it is; that one is not
redundant, it is a state change.

Run `npx vitest run tests/app/dashboard.test.tsx tests/app/budgets-client.test.tsx tests/ops` and
`npx tsc --noEmit`.

Commit: `fix(ui): the month is stated once, by the control that changes it`.

## Lane 2 — collapsible groups, the zero state, and the parent-limit warning

**Files:** `src/app/(app)/budgets/budgets-client.tsx`; tests `tests/app/budgets-client.test.tsx`,
`tests/app/budgets-rollover-ui.test.tsx`.

Everything here is client-side over data the page already receives: `BudgetRow` carries
`children: BudgetRow[]`, and a parent's spend already includes its children's (`foldRollup`,
`src/lib/budgets.ts:165`). No library change, no new query.

1. **Groups collapse** (rulings U2–U5). A parent category with children becomes a disclosure. Closed,
   its header shows: the group name, the parent's own limit, the rolled-up spend, remaining, and the
   progress bar the row already renders — plus a marker when the group is over its limit. Open, the
   children render as they do today. A parent with NO children stays an ordinary row: a disclosure
   that reveals nothing is a control that does nothing.
2. **All groups start collapsed**, and Household/Personal never collapse (U3, U4). One
   **Expand all / Collapse all** control in the card header. Open/closed state persists per browser
   via `localStorage`, keyed so Household and Personal do not share a key; wrap every read and write
   in try/catch and render correctly when it throws or returns nothing (a private window, cleared
   site data). It is a convenience, never a correctness dependency.
3. **The zero state stops doing arithmetic on nothing.** The card header currently reads
   `Household — spent $0.00 of $0.00 budgeted · $0.00 total spent` when no budget exists at all.
   When there are no limits set for the month, say what to do instead:
   `No budgets set for August.` followed by the existing Copy previous month button and a sentence
   pointing at the rows below. Keep today's header for a month that HAS budgets.
4. **The parent-limit warning** (ruling U6). When a parent has a limit AND its children's limits sum
   to more than it, show inline on the group — visible both open and closed, since the closed header
   is where most people will be:

   > **Children add up to $2,400 — $400 over Housing's limit.**
   > [ Raise Housing to $2,400 ] [ Undo ]

   "Raise Housing to $2,400" writes the parent's limit through the existing auto-save path. "Undo"
   restores the previous value of the field that was last edited; if that is not available (a fresh
   page load), omit the button rather than shipping one that lies. Nothing is ever refused, and no
   editing order is ever required. A parent whose children sum UNDER its limit shows nothing — that
   is a deliberate, ordinary choice (slack for un-itemised spending in the group), not a problem.

Wording rules for this lane: sentence case, name the amounts, no exclamation marks, and the button
says exactly what it will do. "Children cannot exceed the parent" is a rule the app no longer
enforces, so it must not appear anywhere in the copy.

Tests: a group renders collapsed by default and its header carries the rolled-up figures; expanding
reveals the children; a parent without children renders no disclosure; Household and Personal are
never collapsible; the over-limit warning appears with the right amounts and does not appear when
children sum under the parent; "Raise <parent> to $X" submits the parent's limit; the zero state
replaces the three-zeros header only when nothing is budgeted.

Run `npx vitest run tests/app/budgets-client.test.tsx tests/app/budgets-rollover-ui.test.tsx tests/app/budgets-page.test.tsx tests/ops` and `npx tsc --noEmit`.

Commit: `feat(budgets): groups fold away, and a parent limit says when its children outgrew it`.

## Release (after both lanes)

`package.json` → `1.18.0`; `tests/ops/docker.test.ts` gains a 1.18.0 block and renames the 1.17.0
one; `CHANGELOG.md` gains `## [1.18.0]` saying plainly that there is NO migration this time (the
previous release had one, so the contrast is the information). Then the full `npx vitest run`,
`npx tsc --noEmit`, tag `v1.18.0`, image.
