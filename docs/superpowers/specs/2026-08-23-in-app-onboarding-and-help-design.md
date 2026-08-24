# In-app onboarding and help — design

**Status:** approved design, ready for an implementation plan
**Date:** 2026-08-23
**Target release:** v1.10.0

## Goal

A stranger who clones this repo, installs it, and logs in for the first time should learn the
order of operations without asking anyone, and should discover the features that no screen
advertises. Nothing in this design requires the author to be reachable.

## The gap this closes

Installation is already covered hard: `README.md` (348 lines), `INSTALL.md` (642),
`docs/INSTALL-SYNOLOGY.md` (228). The gap is the hour *after* install — the app is running,
the database is empty, and nothing states the dependency chain (account, then import, then
review) or names the features that are invisible until someone tells you they exist.

Two measured facts drive the design:

1. **`EmptyState` has 21 call sites and 2 of them pass `action=`.** The component's own docblock
   says "An empty screen is an invitation to act". The component keeps that promise; 19 call
   sites do not, so a new user meets nineteen dead ends.
2. **The Dashboard already has the pattern a progress card needs.** `LoansCard` and
   `ComingUpCard` render unconditionally and self-hide when they have nothing to say. A card
   that disappears once setup is done is that same pattern, not a new one.

## Rulings

- **A1 — Audience is strangers from the public repo.** Every persona named by the owner is a
  real reader: an IT-savvy self-hoster, an IT beginner, a finance expert, and someone who needs
  hand-holding. No copy anywhere may direct a reader to contact the author, open an issue as a
  substitute for documentation, or assume prior knowledge of the codebase.
- **A2 — Scope is mechanics plus one suggested routine.** How each feature works, plus an
  opinionated operating rhythm (import monthly, clear Review, glance Budgets). **No financial
  advice**: no suggested grocery limit, no target savings rate, no opinion about what a reader
  should do with their money. The finance expert skips the routine; the beginner lives on it.
- **A3 — No migration, no new dependency, no new network egress.** The zero-egress claim is a
  product feature. Every byte of this content ships inside the image and is served from it.
  External addresses, if any appear, follow the existing `guides.tsx` rule: plain text, never a
  clickable anchor.
- **A4 — Progress is derived from the database, never described in prose.** The checklist runs
  count queries. It therefore cannot go stale, which is the whole reason it is preferred over a
  written "first steps" document.
- **A5 — Help is a tenth nav item, plus a footer link.** Discoverability beats taxonomy for a
  beginner audience. The `nav.ts` docblock currently claims "The nine sections, in the order money
  moves through the app"; that sentence is rewritten to state the truth, because a false
  justification left in place invites the next reader to mis-order the list.
- **A6 — The panel shell is extracted and shared.** The `GuidePanel` in `guides.tsx` and the new
  `PageGuide` use one primitive in `src/components/ui/`. Two divergent info-panel styles in one
  app is a real inconsistency. The extraction is mechanical and the existing MUST-11.5 /
  MUST-11.6 / MUST-11.8 tests are the safety net.
- **A7 — All nine nav sections get a guide panel.** No allowlist. An allowlist is itself a thing
  that drifts, and a guard test over the whole of `NAV` is the only version of that test that
  cannot be quietly narrowed.
- **A8 — The help page uses no `<details>`.** Forcing collapsed `<details>` open in print CSS is
  unreliable across engines: some hide the closed content with `content-visibility`, others with
  `display`. Flat sections plus a sticky table of contents make Print-to-PDF correct by default,
  which is how the printable handbook gets delivered without a PDF toolchain.
- **A9 — The checklist has exactly three steps and no dismiss button.** See Component 2.

## Component 1 — onboardingSteps()

**File:** `src/lib/onboarding.ts` (new, server-only)

The single place that knows what "set up" means. Three `count(*)` queries in the idiom already
used by `reviewQueueCount()` and `countMatchingMerchant()` — not `listAccounts()` /
`listImportHistory()`, because the card needs existence, not rows.

```ts
export interface OnboardingStep {
  key: 'account' | 'import' | 'review';
  title: string;
  body: string;
  href: string;
  cta: string;
}

/** The steps still undone, in dependency order. Empty array means setup is complete. */
export function onboardingSteps(): OnboardingStep[];
```

Signals, in order:

| key | done when | points at |
|---|---|---|
| `account` | at least one row in `accounts` | `/settings/accounts` |
| `import` | at least one row in `imports` | `/import` |
| `review` | `reviewQueueCount() === 0` **and** the `import` step is done | `/review` |

The extra condition on `review` matters: an empty database has an empty review queue, so without
it the step would read as already done before any data exists.

## Component 2 — GettingStartedCard

**File:** `src/components/GettingStartedCard.tsx` (new)
**Modified:** `src/app/(app)/dashboard/page.tsx`

Props-only and dumb: it receives `steps: OnboardingStep[]` and renders nothing when the array is
empty. Placed first in the Dashboard card stack, rendered unconditionally, following the
`LoansCard` / `ComingUpCard` self-hiding comment already in that file.

**Why three steps and not six (ruling A9).** Budgets and goals are where this app's value is, and
the temptation is to make them steps four and five. They are not steps, because a household that
only wants transaction tracking would face a card it can never complete, and a per-step "skip"
requires a per-user flag, which requires a migration — spending schema on a dismiss button.
Instead the card's final state, rendered when the three steps are done and immediately before it
disappears for good, is a single handoff line pointing at the help page: budgets, goals and
coverage are what to explore next. One-shot, no persistence, no migration, no dismiss control.

## Component 3 — the help page

**Files:** `src/app/(app)/help/page.tsx`, `src/app/(app)/help/content.tsx` (both new)

Content lives in its own module for the reason `guides.tsx` states about itself: it is content,
not placeholder text, so it should be reviewable as prose and testable by string match.

Auth-gated by sitting inside the `(app)` route group, which also gives it the shell and nav. A
reader who cannot log in yet is served by `README.md` and `INSTALL.md`.

Two parts, flat sections with a sticky table of contents:

**Part 1 — the routine.** The operating rhythm, stated once: export a statement from each bank
monthly, import it, clear whatever Review flags, then look at Budgets. Explicitly labelled as one
suggested rhythm rather than a requirement, per ruling A2.

**Part 2 — the feature index.** One short section per nav section, plus explicit coverage of the
features no screen advertises:

- sharing packs — a redacted slice for an accountant or co-owner
- the cardholder column, so a joint card's rows attribute to the right person
- deactivating a mapping without deleting it
- statement balances, and how a balance resolves from a snapshot plus movement
- receipt OCR making every word on a receipt searchable, entirely on the server
- SimpleFIN being optional, with CSV import always working without it
- backups, and where a restore can be verified

**Print.** A `@media print` block in `src/app/globals.css` (the app's only stylesheet, which
currently has no print rules) hides the nav rail, the sticky header, the mobile menu button and
the version footer. Nothing else is needed, because of ruling A8.

## Component 4 — the nav entry and footer link

**Modified:** `src/components/app-shell/nav.ts`, `src/components/app-shell/AppShell.tsx`

`NAV` gains a tenth entry, `{ href: '/help', label: 'Help' }`, placed last after Settings. Its
docblock — currently "The nine sections, in the order money moves through the app: see the month,
check the transactions behind it, fix what the categorizer was unsure of, bring more in, then the
planning surfaces, then the back office" — is rewritten so the count is right and Help is named as
sitting outside that flow rather than at the end of it. Per ruling A5 the reason is stated, not
just the fact: a docblock that describes a list it no longer matches is how the next reader
mis-orders it.

`AppShell`'s page footer already reads `Budget Tracker v{version} · what's new` on every page. A
help link joins it there, in the same style, so the affordance exists even for a reader who never
looks at the rail.

**`NAV` growing to ten is load-bearing for the guard tests** — see the exclusion rule under
Testing.

## Component 5 — PageGuide

**Files:** `src/components/ui/PageGuide.tsx` (new), `src/app/(app)/settings/notifications/guides.tsx` (modified per A6)
**Modified:** the nine nav-section page files

A `<details>` rendered under `PageHeader` on each of the nine nav sections, summary "What is this
page for?", three to six sentences of body, tone matched to the notification guides.

**Open state is derived, not stored.** The panel is open while that page has no data to show and
closed once it does. A page with nothing on it is exactly when a reader needs the explanation, and
a page full of data is exactly when the panel is in the way. This reuses the `open` prop the
existing `GuidePanel` already accepts, and needs no persistence.

## Component 6 — the 19 dead-end empty states

Every one of the 21 `EmptyState` call sites passes `action=` when this ships. The call sites are
not all the same kind, and the wrong action is worse than none, so each is classified:

| kind | example call sites | correct action |
|---|---|---|
| **cold-start** — no data exists at all | `goals-client.tsx:56` "No goals yet"; `import-client.tsx:606` "Nothing imported yet"; `settings/item-types` "No item types yet" | the button that creates the first one |
| **filter-excluded** — data exists, the current filter hides it | `transactions-client.tsx:571` "Nothing matches these filters"; `warranties-client.tsx:141` "No matches for that search."; `reports-client.tsx:217` "Nothing spent in this range" | clear the filter / reset the range |
| **insufficient-history** — the feature needs more months than exist | `reports-client.tsx:165` and `:457` "Not enough history yet"; `:242` "No months to compare yet" | a link to Import, to add older statements |

Because every kind has a correct action, the guard test needs no allowlist. The two call sites
that already pass `action=` are the model for the rest.

## Testing

**File:** `tests/ops/onboarding-coverage.test.ts` (new), in the repo's existing grep-guard idiom.

The three guards are the point of this design — they are what stops the content rotting at this
project's release cadence:

1. **Every `<EmptyState` call site passes `action=`.** Locks Component 6 in permanently.
2. **Every `href` in `NAV` appears in the help page feature index.** Ship a new section without
   documenting it and the suite goes red.
3. **Every page file behind a `NAV` href renders a `<PageGuide>`.**

**Guards 2 and 3 exclude `/help` itself, and the exclusion must be a single named constant used by
both.** Component 4 makes `NAV` ten entries long, so read literally these guards would require the
help page to document itself in its own feature index and to carry a "What is this page for?" panel
explaining what a help page is. The exclusion is `/help` and nothing else — spelled as one exported
constant so that a future attempt to quiet a failing guard has to widen a list that is obviously a
list, rather than adding a quiet second condition. Ruling A7's "no allowlist" stands: this is one
route excluded for a stated structural reason, not a set of pages someone decided were self-evident.

A grep guard is used rather than a rendering test for the same reason
`tests/ops/balance-invariants.test.ts` exists: a rule about what must be present in *every* file
of a set cannot be enforced by fixture-driven tests, which only ever cover the files someone
remembered to write a fixture for.

Unit tests:

- `onboardingSteps()` — each of the three transitions; the empty-database case, proving the
  `review` step is not reported done before any import exists; and the all-done case returning `[]`.
- `GettingStartedCard` — renders nothing for `[]`; renders only the undone steps; renders the
  help-page handoff in its final state.
- `PageGuide` — open when the page is empty, closed when it is not.
- The help page — string-match on the routine's key phrases, matching how `guides.tsx` is tested.
- The extracted panel primitive — the existing MUST-11.5 / 11.6 / 11.8 notification-guide tests
  must still pass **unchanged**. If they need editing, the extraction was not mechanical and
  should be reverted to a sibling component.

## What this does NOT build, and why

- **An authored PDF handbook.** Cannot be tested, drifts on every release, is dead weight inside
  the image, and needs a build toolchain. The print CSS in Component 3 produces the same artifact
  through the browser for nothing.
- **A coach-mark guided tour overlay.** Fragile, hostile to keyboard and screen-reader users, high
  complexity — and it teaches which button is where, when the measured gap is the order of
  operations.
- **Budgeting guidance.** Ruled out by A2. Telling strangers what a reasonable grocery limit looks
  like is financial advice, in a public repo, from a household budget tool.
- **A per-user dismiss flag for the checklist.** Ruled out by A9: a migration for a dismiss
  button, when three completable steps and a self-hiding card achieve the same thing.
- **An external documentation site.** Would break the zero-egress claim (A3) and be unreachable on
  a LAN-only install, which is a supported and documented deployment.
