# In-app onboarding and help — implementation plan

> **For agentic workers:** implement one task at a time. Steps use checkbox (`- [ ]`) syntax.
> **Do NOT run `git commit`.** Tasks run in parallel waves; the orchestrator commits per wave.

**Goal:** A stranger who installs this app learns the order of operations and discovers the
features no screen advertises, without the author being reachable.

**Architecture:** Four surfaces, ordered by payoff-per-hour — action buttons on every empty
state, a database-derived setup card on the Dashboard, one flat printable help page, and a
per-page "what is this for?" panel. Three grep guard tests make the content impossible to leave
behind when a feature ships.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript 6.0.3, Drizzle + better-sqlite3,
Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-in-app-onboarding-and-help-design.md` — read it
first. Every ruling A1–A9 is binding.

## Global Constraints

- **No migration, no new dependency, no new network egress** (ruling A3). If a task seems to
  need any of the three, stop and report instead.
- **PUBLIC REPO.** No owner name, employer, real statement data, or absolute Windows paths in
  any file. Sample data must be anonymous where it enters a doc.
- **No copy may tell a reader to contact the author or file an issue instead of documenting
  something** (ruling A1).
- **No financial advice** — no suggested spending limits, savings rates, or opinions about a
  reader's money (ruling A2).
- **External addresses are plain text, never anchors** — the existing `guides.tsx` rule, which
  keeps the zero-egress claim trivially auditable.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that explain *why*,
  not *what*. A comment that states a false reason is worse than no comment — v1.9.0 had to fix
  exactly that in `proxy.ts`.
- TDD: failing test, then implementation, then green.
- Run `npx vitest run <your test files>` for your own task. Do not run the full 3,695-test suite.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/onboarding.ts` | the only module that knows what "set up" means | T1 |
| `src/components/ui/GuidePanel.tsx` | shared collapsible info-panel shell | T2 |
| `src/components/ui/PageGuide.tsx` | the per-page "what is this for?" panel | T2 |
| `src/app/(app)/help/content.tsx` | all help prose, one reviewable module | T3 |
| `src/app/(app)/help/page.tsx` | help page layout + sticky table of contents | T3 |
| `src/app/globals.css` | `@media print` block | T3 |
| `src/components/GettingStartedCard.tsx` | dumb, props-only setup card | T6 |
| `src/components/app-shell/nav.ts` | tenth nav entry + honest docblock | T8 |
| `tests/ops/onboarding-coverage.test.ts` | the three drift guards | T9 |

---

# Wave 1 — five independent tasks, no shared files

### Task 1: `onboardingSteps()`

**Files:**
- Create: `src/lib/onboarding.ts`
- Test: `tests/lib/onboarding.test.ts`

**Interfaces — Produces (T6 consumes this exactly):**

```ts
export interface OnboardingStep {
  key: 'account' | 'import' | 'review';
  title: string;
  body: string;
  href: string;
  cta: string;
}
export function onboardingSteps(): OnboardingStep[];
```

Returns only the steps still undone, in the order `account`, `import`, `review`. An empty array
means setup is complete.

- [ ] **Step 1: Write the failing tests.** Use whatever in-memory DB harness
  `tests/lib/transactions.test.ts` already uses — follow it, do not invent a new one.

Cases, all required:
1. Empty database returns all three steps.
2. One row in `accounts` drops the `account` step, keeps the other two.
3. Accounts plus one row in `imports`, review queue non-empty: only `review` remains.
4. **Accounts plus a row in `imports` plus an empty review queue returns `[]`.**
5. **Accounts but NO import, with an empty review queue, still returns the `review` step.** This
   is the case the extra condition exists for: an empty database trivially has an empty review
   queue, so without it `review` would read as done before any data existed.

- [ ] **Step 2: Run them, confirm they fail** with a module-not-found error.

- [ ] **Step 3: Implement.** Three `count(*)` queries in the idiom of `reviewQueueCount()`
  (`src/lib/categorize/engine.ts:526`) and `countMatchingMerchant()`
  (`src/lib/transactions.ts:303`) — `getDb().select({ c: sql<number>`count(*)` }).from(x).get()`.
  **Do not call `listAccounts()` or `listImportHistory()`** — the card needs existence, not rows,
  and loading rows to check a boolean is the N+1 shape this codebase already fixed once.

  Copy for the three steps, verbatim:

  | key | title | body | href | cta |
  |---|---|---|---|---|
  | `account` | `Add a bank account` | `Every import lands in an account, so this comes first. One row per real-world account — chequing, credit card, cash.` | `/settings/accounts` | `Add an account` |
  | `import` | `Import your first statement` | `Download a CSV from your bank and drop it in. Built-in profiles cover several Canadian banks; any other bank works through the same mapping wizard.` | `/import` | `Start an import` |
  | `review` | `Clear the review queue` | `The categorizer flags anything it was unsure about. Accept or correct each one and it remembers that merchant next time.` | `/review` | `Open Review` |

  Write a docblock explaining ruling A4 — that this module runs queries rather than describing
  state precisely so the card cannot go stale.

- [ ] **Step 4: Run tests, confirm green.**

---

### Task 2: extract the shared panel, add `PageGuide`

**Files:**
- Create: `src/components/ui/GuidePanel.tsx`, `src/components/ui/PageGuide.tsx`
- Modify: `src/app/(app)/settings/notifications/guides.tsx`
- Test: `tests/components/page-guide.test.tsx`

**Interfaces — Produces (T6 and T7 consume):**

```ts
// GuidePanel.tsx — the shell, extracted from guides.tsx
export function GuidePanel(props: {
  summary: string;
  open: boolean;
  children: React.ReactNode;
}): React.ReactElement;

// PageGuide.tsx — the per-page application of it
export function PageGuide(props: {
  /** True when the page currently has no data to show. Drives the open state (ruling A4-style
   *  derivation: no persistence, no per-user flag). */
  empty: boolean;
  children: React.ReactNode;
}): React.ReactElement;
```

`PageGuide` renders `GuidePanel` with `summary="What is this page for?"` and `open={empty}`.

- [ ] **Step 1: Read `src/app/(app)/settings/notifications/guides.tsx` lines 44–60** — the
  existing `GuidePanel`. It is a `<details>` with `rounded-md bg-info-soft px-3.5 py-3 text-sm
  text-info-soft-fg`, a `cursor-pointer font-semibold` summary, and `mt-3 flex flex-col gap-3`
  content. That markup moves to `ui/GuidePanel.tsx` unchanged; only the summary text becomes a
  prop.

- [ ] **Step 2: Write the failing `PageGuide` tests.** Two cases: `empty` true renders the
  `<details>` with the `open` attribute present; `empty` false renders it without. Assert the
  summary text is exactly `What is this page for?`.

- [ ] **Step 3: Run them, confirm they fail.**

- [ ] **Step 4: Create `ui/GuidePanel.tsx`**, then rewrite the `GuidePanel` in `guides.tsx` as a
  thin wrapper that passes `summary="How do I set this up?"` — preserving that exact string,
  because MUST-11.5 asserts the shared summary shape.

- [ ] **Step 5: Create `ui/PageGuide.tsx`.**

- [ ] **Step 6: Run `npx vitest run tests/components/page-guide.test.tsx` and every existing
  notification-guide test file.**

  **GATE (ruling A6):** the existing MUST-11.5 / MUST-11.6 / MUST-11.8 tests must pass
  **completely unchanged**. If any of them needs editing to go green, the extraction was not
  mechanical: revert `guides.tsx` to its original state, leave `PageGuide.tsx` as an independent
  sibling that duplicates the six-line shell, and say so in your report.

---

### Task 3: the help page

**Files:**
- Create: `src/app/(app)/help/content.tsx`, `src/app/(app)/help/page.tsx`
- Modify: `src/app/globals.css`
- Test: `tests/app/help.test.tsx`

**Interfaces — Produces (T9 greps this):**

```ts
// content.tsx
export interface HelpSection { id: string; title: string; body: React.ReactNode }
export const HELP_ROUTINE: HelpSection;
export const HELP_SECTIONS: HelpSection[];
```

`HELP_SECTIONS` must contain one entry per nav section — `/dashboard`, `/transactions`,
`/review`, `/import`, `/budgets`, `/goals`, `/warranties`, `/reports`, `/settings` — and **the
href string itself must appear in that section's rendered output**, because T9's guard greps for
it. Put it in a "where to find it" line rather than contriving a link.

- [ ] **Step 1: Write the failing tests.** Assert: the routine section renders; every one of the
  nine hrefs appears in the page output; each of the seven undiscoverable features below is named.

- [ ] **Step 2: Run them, confirm they fail.**

- [ ] **Step 3: Write `content.tsx`.** Prose is the deliverable here, not scaffolding. Open the
  docblock the way `guides.tsx` opens its own — stating that this is content, not placeholder
  text, and that it lives in one module so it is reviewable as prose and testable by string match.

  **Part 1, `HELP_ROUTINE`** — the operating rhythm, in this order: export a CSV from each bank
  once a month; import it; clear whatever Review flags; then look at Budgets. Label it plainly as
  one suggested rhythm, not a requirement. **Per ruling A2 it must not say what to spend or save.**

  **Part 2, `HELP_SECTIONS`** — one short section per nav section, each answering "what is this
  screen for and when would I open it". Plus explicit coverage of the seven features no screen
  advertises. Read the README bullets for the accurate description of each before writing:
  1. sharing packs — a redacted slice for an accountant or co-owner
  2. the cardholder column, so a joint card's rows attribute to the right person
  3. deactivating a mapping without deleting it, when you stop using that bank
  4. statement balances, and that a balance resolves as a snapshot plus movement since it
  5. receipt OCR making every word on a receipt searchable, entirely on the server
  6. SimpleFIN being optional — CSV import always works without it
  7. backups, and where a restore can be verified

  Aim for three to six sentences per section. Assume a reader who has never seen the app and may
  not know what a CSV is; do not assume they know what Dataverse, ONNX, or a WAL file is.

- [ ] **Step 4: Write `page.tsx`.** `PageHeader` at the top, then a sticky table of contents
  linking each section `id`, then every section rendered **expanded**.

  **Ruling A8 is binding: do NOT use `<details>` anywhere on this page.** Forcing collapsed
  `<details>` open in print CSS is unreliable across engines — some hide closed content with
  `content-visibility`, others with `display`. Flat sections are what make Print-to-PDF correct
  by default, and that is how the printable handbook ships without a PDF toolchain.

- [ ] **Step 5: Add the `@media print` block to `src/app/globals.css`.** The file currently has
  no print rules. Hide the desktop nav rail, the sticky header, the mobile menu button and the
  version footer. Comment it with the reason: this is what makes the browser's Print-to-PDF the
  deliverable, so nothing else is needed.

- [ ] **Step 6: Run tests, confirm green.**

---

### Task 4: empty-state actions — `reports-client.tsx`

**Files:**
- Modify: `src/app/(app)/reports/reports-client.tsx` (11 call sites)

Read the spec's Component 6 table first. Every `<EmptyState>` here is either
**filter-excluded** or **insufficient-history** — none is cold-start, because Reports never has
its own data to create.

- [ ] **Step 1: Classify each of the eleven** at lines 165, 169, 217, 230, 242, 279, 309, 328,
  358, 391, 457. For each, read the surrounding conditional to see whether it fires because a
  filter excluded existing data or because not enough months exist.

- [ ] **Step 2: Add `action=` to all eleven.**
  - **filter-excluded** ("Nothing spent in this range", "Nothing to show for this range", "No
    merchant charges in this range", "Nothing marked tax-relevant yet") → a button that widens or
    resets the date range using the handler the page already has. Do not invent new state.
  - **insufficient-history** ("Not enough history yet", "No months to compare yet", "Nothing to
    compare yet", "Nothing to split yet", "No balances recorded yet", "No category has enough
    regular spend for a baseline yet") → a `Link` to `/import` labelled so it says *why* it helps,
    e.g. `Import older statements`.

  **The wrong action is worse than none.** Do not put "get started" nudges on a screen whose data
  exists but is filtered out — that reads as though the import failed.

- [ ] **Step 3: Run `npx vitest run tests/` for any existing reports test files** and confirm
  still green. Report any test that asserted on the absence of a button.

---

### Task 5: empty-state actions — the remaining eight files

**Files (10 call sites total):**
- `src/app/(app)/goals/goals-client.tsx:56` — cold-start
- `src/app/(app)/import/import-client.tsx:606` — cold-start
- `src/app/(app)/review/review-client.tsx:57` — **success state, see below**
- `src/app/(app)/settings/accounts/accounts-manager.tsx:199` — cold-start
- `src/app/(app)/settings/backups/backups-client.tsx:204` — cold-start
- `src/app/(app)/settings/item-types/item-types-manager.tsx:109` — cold-start
- `src/app/(app)/settings/notifications/notifications-client.tsx:634` — cold-start
- `src/app/(app)/transactions/transactions-client.tsx:571` — filter-excluded
- `src/app/(app)/warranties/warranties-client.tsx:141` — filter-excluded
- `src/app/(app)/warranties/warranties-client.tsx:145` — **already has `action=`; leave it, and
  use it as the model for the others**

- [ ] **Step 1: Add `action=` to the nine that lack one.**
  - **cold-start** → the button or `Link` that creates the first one. Several of these pages
    already have a "New …" control above the list; reuse it rather than adding a second path.
  - **filter-excluded** → clear the filter / clear the search using the handler already present.
  - **`review-client.tsx:57`** is neither: `"Nothing to review. Everything is categorized."` is a
    *success* message, not a dead end. Its action is a `Link` onward — to `/transactions` to see
    what was categorized, or `/import` to bring in more. Do not reword the title; it is the tone
    the rest of this work is matched to.

- [ ] **Step 2: Run the existing test files for each page you touched** and confirm green.

---

# Wave 2 — three tasks, disjoint files, all depend on Wave 1

### Task 6: `GettingStartedCard` + Dashboard

**Files:**
- Create: `src/components/GettingStartedCard.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`
- Test: `tests/components/getting-started-card.test.tsx`

**Interfaces — Consumes:** `OnboardingStep` and `onboardingSteps()` from T1
(`src/lib/onboarding.ts`); `PageGuide` from T2 (`src/components/ui/PageGuide.tsx`).

**This task owns the whole of `dashboard/page.tsx`** — both the card and the Dashboard's
`PageGuide`. T7 deliberately skips Dashboard so the two never touch the same file.

```ts
export function GettingStartedCard(props: { steps: OnboardingStep[] }): React.ReactElement | null;
```

- [ ] **Step 1: Write the failing tests.** Three cases: `steps: []` renders nothing at all; two
  steps renders exactly those two with their `cta` labels and `href`s; and the **final state** —
  when `steps` is empty the card is absent, so the handoff line must be attached to the *last*
  populated render instead. Read Step 3 before writing this third test.

- [ ] **Step 2: Run them, confirm they fail.**

- [ ] **Step 3: Implement.** Props-only and dumb — it does no queries. Returns `null` for `[]`.

  **The handoff (ruling A9).** The card must, before it disappears for good, point the reader at
  budgets, goals and coverage as what to explore next. It cannot do that in a state where it
  renders nothing, so put the handoff line inside the card as a permanent footer, shown alongside
  whatever steps remain: one sentence naming those three and linking `/help`. That way it is seen
  during setup rather than in a state that never renders.

  **Do not add a dismiss button and do not add persistence.** Ruling A9: three completable steps
  and a self-hiding card achieve the same thing without spending a migration on a dismiss button.

- [ ] **Step 4: Wire into `dashboard/page.tsx`.** Call `onboardingSteps()` server-side, render
  `<GettingStartedCard>` **first** in the card stack, unconditionally. Follow the self-hiding
  comment already in that file for `LoansCard` (line ~181) and `ComingUpCard` (line ~183) — same
  pattern, so reference it rather than restating it.

- [ ] **Step 5: Add the Dashboard `PageGuide`** under the page's `PageHeader`. `empty` is true
  when there are no transactions in the selected month. Three to six sentences: what the
  Dashboard summarises, that the person pills scope it to one household member, and that the
  cards hide themselves when they have nothing to say.

- [ ] **Step 6: Run your tests plus any existing dashboard test files.**

---

### Task 7: `PageGuide` on the other eight nav pages

**Files (modify):** `transactions/page.tsx`, `review/page.tsx`, `import/page.tsx`,
`budgets/page.tsx`, `goals/page.tsx`, `warranties/page.tsx`, `reports/page.tsx`,
`settings/page.tsx` — or each page's client component, wherever `PageHeader` is rendered.

**Do NOT touch `dashboard/page.tsx`** — Task 6 owns it.

**Interfaces — Consumes:** `PageGuide` from T2.

- [ ] **Step 1: For each of the eight, find where `PageHeader` renders** and add `<PageGuide>`
  directly below it.

- [ ] **Step 2: Pass a real `empty`.** True when that page has no data to show — reuse the same
  condition the page already uses to decide whether to render its `EmptyState`, rather than
  computing a second, subtly different notion of empty. If a page has no such condition
  available at that level, pass `empty={false}` and note it in your report; do not add a query.

- [ ] **Step 3: Write the copy.** Three to six sentences each, answering "what is this page for
  and when would I open it". Match the tone of the notification guides in
  `settings/notifications/guides.tsx` — plain, second person, no exclamation marks. Cover the
  non-obvious thing on each page specifically:
  - **Transactions** — filters compose; splits exist; the amount is immutable after import
  - **Review** — accepting or correcting teaches the categorizer that merchant
  - **Import** — built-in bank profiles, the mapping wizard for any other bank, duplicate
    detection, and the cardholder column for a joint card
  - **Budgets** — household versus per-person scope, and that a limit carries forward until changed
  - **Goals** — logging money set aside, and the pace projection
  - **Contracts & Coverage** — warranties, subscriptions, contracts and loans in one place;
    attach a receipt and every word printed on it becomes searchable
  - **Reports** — needs a few months of history before most panels say anything
  - **Settings** — bank accounts first, then the optional things: notifications, backups, users

- [ ] **Step 4: Run existing test files for each page touched.**

---

### Task 8: nav entry and footer link

**Files:**
- Modify: `src/components/app-shell/nav.ts`, `src/components/app-shell/AppShell.tsx`
- Test: existing app-shell test files

**Depends on** T3 having created the `/help` route, so the link does not 404.

- [ ] **Step 1: Add `{ href: '/help', label: 'Help', Icon: InfoIcon }` last in `NAV`,** after
  Settings. `InfoIcon` is already exported from `src/components/icons` — **do not add a new icon.**

- [ ] **Step 2: Rewrite the `NAV` docblock.** It currently reads "The nine sections, in the order
  money moves through the app: see the month, check the transactions behind it, fix what the
  categorizer was unsure of, bring more in, then the planning surfaces, then the back office."
  The count is now wrong and Help is not part of that flow. Fix the count and say that Help sits
  outside the sequence rather than at the end of it.

  **Ruling A5: state the reason, not just the fact.** A docblock describing a list it no longer
  matches is how the next reader mis-orders it — the same failure v1.9.0 had to fix in
  `proxy.ts`, where a stale rationale had outlived the rule it justified.

- [ ] **Step 3: Add a help link to the `AppShell` page footer**, which currently renders
  `Budget Tracker v{version} · what's new`. Same style, same separator.

- [ ] **Step 4: Check `activeNavItem()` still behaves.** It picks the longest matching prefix, so
  `/help` needs no special case — confirm by reading it, and add a test case if the existing
  app-shell tests enumerate `NAV`.

- [ ] **Step 5: Run existing app-shell test files.**

---

# Wave 3 — the guards

### Task 9: the three drift guards

**Files:**
- Create: `tests/ops/onboarding-coverage.test.ts`

**Depends on all of Waves 1 and 2.**

Follow the idiom in `tests/ops/balance-invariants.test.ts` and `tests/ops/docker.test.ts`: read
files from disk and assert on their text. A grep guard is used rather than a rendering test for
the reason `balance-invariants` states — a rule about what must be present in *every* file of a
set cannot be enforced by fixture-driven tests, which only ever cover the files someone
remembered to write a fixture for.

- [ ] **Step 1: Export the exclusion constant.** One named constant, in the test file:

```ts
/**
 * The help page is the only route excluded from guards 2 and 3, and the reason is structural,
 * not editorial: it would otherwise have to document itself in its own feature index and carry a
 * panel explaining what a help page is. Ruling A7's "no allowlist" still stands — this is one
 * route excluded for a stated reason, not a set of pages someone judged self-evident. Anything
 * added here needs the same kind of justification.
 */
const GUIDE_EXEMPT_HREFS = ['/help'] as const;
```

- [ ] **Step 2: Guard 1 — every `<EmptyState` call site passes `action=`.** Walk every `.tsx`
  under `src/`, find each `<EmptyState` occurrence, and assert an `action=` appears before that
  element closes. Fail with the `file:line` of any that does not. There are 21 call sites today
  and the count must not be hardcoded — a 22nd added without an action must fail.

- [ ] **Step 3: Guard 2 — every non-exempt `NAV` href appears in the help content.** Import
  `NAV` from `src/components/app-shell/nav.ts`, read
  `src/app/(app)/help/content.tsx` as text, and assert each href string is present.

- [ ] **Step 4: Guard 3 — every non-exempt `NAV` href has a page rendering `<PageGuide`.** Map
  each href to its file under `src/app/(app)/`, and assert `<PageGuide` appears either in
  `page.tsx` or in the client component that page renders. Resolve the client component by
  reading the page's imports rather than hardcoding filenames.

- [ ] **Step 5: Run the new file. Then deliberately break each of the three** — remove one
  `action=`, delete one href from the help content, remove one `<PageGuide` — and confirm each
  guard actually fails. **A guard that cannot fail is worse than no guard**, because it reads as
  coverage. Restore afterwards and confirm green.

---

# Wave 4 — release (orchestrator only, not a subagent task)

- [ ] Full suite, `tsc`, clean `next build`
- [ ] `package.json` version `1.9.0` → `1.10.0`
- [ ] `CHANGELOG.md`: move Unreleased into `## [1.10.0] - <date>`, leaving Unreleased empty.
      Group under `### Added`. Say plainly that this adds documentation and guidance surfaces and
      changes no financial calculation — a reader must not think their balances moved.
- [ ] `tests/ops/docker.test.ts`: repoint MUST-7.1 to 1.10.0, keeping the 1.9.0 assertions as an
      append-only test. Assert the changelog's headline claims, not just the version.
- [ ] Commit, tag `v1.10.0`, push. **The tag push repoints GHCR `:latest`, which the NAS pulls.**
