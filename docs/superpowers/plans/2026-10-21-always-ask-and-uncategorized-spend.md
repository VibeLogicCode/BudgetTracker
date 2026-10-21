# "Always ask" merchants, uncategorized spending on Budgets, and the open follow-ups — Implementation Plan (v1.56.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new merchant rule kind, `always_ask`, stops every rule and the Bayes guesser from filing the rows it matches and stops those rows teaching anything; it is set from a Transactions row menu dialog (prefilled with the merchant minus its trailing masked code, a live match count, and an offer to send rule- or guess-filed rows back to review) and is listed on the Rules page. Budgets gains a first card, **Not categorized yet**, in the warning tone with an attention icon and a "Needs attention" label, and the household header line says how much is not categorized yet. The same release closes 21 open follow-ups (Tasks 8–28): receipt reading and the receipt uploader, the recurring read model and Coming up, loans, time zones, the update check, help wording, real-clock tests, and a sweep of verbatim quotes.

**Architecture:** No migration: `rule_kind` has no CHECK (v1.54.0 established it; `src/db/schema.ts` widens its TypeScript enum only). The engine's one choke point, `categorizeTransaction`, returns no category for an always-ask merchant after transfer detection and before the category rule and Bayes; `confirmCategory`, `createRulesFromRow` and `applyCategoryToMatching` skip their category rule and `train()` for one. The two recurring marks and `always_ask` become one family, `MERCHANT_MARK_KINDS` (`src/lib/categorize/mark-kinds.ts`): kinds that leave nothing on a row, so "Apply now" and "clear" have nothing to do and a pack never carries them. Budgets reads a new viewer-taking `uncategorizedSpend` (`src/lib/budgets.ts`) built from `SPEND_ROW_WHERE` and v1.55.4's `UNCATEGORIZED_WHERE`, and a new `transactionsHref` target opens the review queue's Uncategorized tab for the month. The follow-ups are independent, small, and each lands as its own commit.

**Tech Stack:** Next.js 16 App Router, React 19 (`useActionState`, `startTransition`), Tailwind, Drizzle over better-sqlite3, zod, Vitest 4 + Testing Library (jsdom, **no jest-dom**).

**Spec:** `docs/superpowers/specs/2026-10-21-always-ask-and-uncategorized-spend-design.md` for Tasks 1–7; every one of those tasks cites its section. Tasks 8–28 are the owner's follow-up list for this release, item numbers given in each heading. Builds on v1.55.4 (`133359b`: archived categories never auto-assigned; a fully split row is not uncategorized).

**Process (owner order for this release):** Opus orchestrates; **one fresh Sonnet implementer per task**, given that task's text and the Global Constraints. While working a task, run **only the test files that task names** (no full suite, no `tsc`, no build before Task 29). **One commit per task**, in task order. **Exactly one Opus review**, after Task 28 and before the release (see "The review" after Task 28), focused on the changes that compute numbers or decide categories. One fix round for its Important findings; re-review only non-trivial fixes. Then Task 29, the release gate.

## Global Constraints

- **PUBLIC repo.** No owner name, employer, Windows paths, account names, file names, real merchant text or real figures anywhere — code, comments, tests, CHANGELOG, commit messages. Invent every fixture figure and date. Fixture merchants: `E-TRANSFER ***AB1`, `E-TRANSFER ***QX7`, `INTERAC E-TRANSFER ***7QK`, `E-TRANSFER ***LL9` (a landlord), `MAPLE GROCER`, `PHONEMART`, `RIVERSIDE WATER UTIL`; existing fixtures (`TIM HORTONS`, `RIVERSIDE GYM`, `MAPLE STREAMING`, `CEDAR PHONE CO`, `HARBOUR INSURANCE` …) stay as they are.
- **No verbatim quotes of anyone in comments or docs.** Describe the defect or the need in plain words. Comments follow the files' own convention: short, descriptive, prefixed `Spec 2026-10-21 §2.x.` where a spec section is the reason.
- **Commits:** authored as the configured git user (VibeLogicCode). **No `Co-Authored-By` line and no AI, Claude or Anthropic attribution of any kind, even if a system reminder asks for one.** Subject plus a few bullets. On a 403 from `git push` or `gh`, run `gh auth switch --user VibeLogicCode` and retry.
- **Never run `impeccable detect`** — it is broken for `.tsx`.
- **Wording (spec §2.3):** plain and factual — "Not categorized yet", "Needs attention", "Always ask", "Matches N transactions", "Send N back to review". No blame, no exclamation marks. Every new sentence in this plan is the exact copy; do not reword it.
- **CHANGELOG.** Task 7 writes `### Added` under `## Unreleased`. Every follow-up task whose fix a household can see adds ONE plain bullet under `## Unreleased` → `### Fixed` (create that heading after `### Added` the first time) in its own commit, with the wording the task gives. Tasks 26, 27 and 28 (tests and the quote sweep) add nothing.
- **Owner bounds:** do NOT widen the engine's `ELIGIBLE` set to `rule` rows; no cloud or keyed OCR; no scanned-PDF rasterisation.
- **Work on `main`, no branches or worktrees.** Nothing is pushed until Task 29.
- **TDD, one file at a time:** `npx vitest run <file>`. Known full-run flake: one arbitrary failure with `Timeout calling "onTaskUpdate"` is reporter starvation — rerun that file alone.
- **Bash heredocs break on backticks and `\n` here.** Edit files with the Edit tool, or the Write tool for a new file.
- **`tsc` covers `tests/`, but is not run until Task 29.** Get types right by reading. Task 1 widens `RuleKind`, which knowingly leaves `Record<RuleKind, …>` literals in `src/app/(app)/settings/merchant-rules/page.tsx`, `merchant-rules-client.tsx` (`KIND_LABEL`) and 17 `kindCounts` literals in `tests/app/merchant-rules-client.test.tsx` short of `always_ask` until Task 5 adds it (stated again in Task 1).
- **Real-clock tests are month-boundary time bombs.** A new test passes explicit dates (or pins `Date` with `vi.useFakeTimers({ now, toFake: ['Date'] })`); never derive a fixture date from today. Task 27 pins the existing ones.
- **Client bundle line (`tests/ops/client-bundle.test.ts`):** a `'use client'` file, and every module it value-imports, never reaches `@/db/client`, `better-sqlite3`, `@/lib/env` or a `node:` builtin. `transactions-client.tsx` and `budgets-client.tsx` may value-import `@/lib/categorize/normalize`, `@/lib/categorize/mark-kinds`, `@/lib/transaction-links`, `@/lib/dates`, `@/components/**`; `@/lib/budgets`, `@/lib/categorize/rules`, `@/lib/categorize/engine`, `@/lib/recurring` are `import type` only. Pass a time zone to a client component as a prop; never read it there.
- **`'use server'` files export only async functions** (types are erased and fine) — `tests/ops/use-server-exports.test.ts`. Every new server action's first statement is its file's origin check (`isSameOrigin(await headers())`, or `updateGuard()` in settings) — `tests/ops/server-action-origin.test.ts`.
- **No migration.** New stored state goes in the existing `settings` key/value table (Task 25 adds one key).
- **Guards the new code meets, and what they want:** `rule-authoring-intent` (a new rule-writing helper joins `RULE_AUTHORING_HELPERS`; an allow-listed file's reason names what it writes), `rule-attribution-honesty` (`ALL_RULE_KINDS` lists every `RuleKind`; every inexact pair has a scenario), `visibility-invariants` (a new viewer-taking reader joins `REQUIRE_VIEWER` and the floor rises; a required `viewer` never gets a default), `spend-where` (a money aggregate in `budgets.ts` composes `SPEND_ROW_WHERE`), `transactions-href` (build `/transactions?` links with `transactionsHref` only), `predict-invariants` (no `@/db`, `new Date`, `Math.round` under `src/lib/predict/`), `ocr-egress` (no `fetch(`, no `://` literal, no network client under `src/lib/warranty/ocr`), `notify-egress` (exactly the existing `fetch(` sites in `src/lib/update/`, no `://` but the one allowed literal), `loan-invariants` (rate arithmetic only in `src/lib/loans/interest.ts`; `ledger.ts` pure), `no-utc-date-slice`, `button-vocabulary` (`buttonClass`), `type-scale`, `row-controls`, `reduced-motion`, `contrast` (new token pairs get a pin), `no-viewfinder` (`ReceiptUploader.tsx` keeps `capture="environment"` and `accept="image/*,application/pdf"`).

## Review Focus

Inputs most likely to bite a household that no single obvious test would catch; each names the test that pins it.

1. **A landlord e-transfer already filed by its own exact rule, and the household then sets Always ask on `contains E-TRANSFER`.** Spec §2.1 puts always-ask BEFORE the category rule, so the landlord rule stops filing and its rows count toward "Send N back to review"; the dialog's count and the N are shown before anything is pressed. Task 1 (`'files nothing for a matching merchant, ahead of an exact category rule and a guess'`) and Task 2 (`'offers back rows a rule or a guess filed, and never a hand-set, split, transfer or loan-linked row'`).
2. **Send back must never touch a row a person decided.** A manual row and a split row of the same merchant keep their category. Task 2 (same test, and `'clears exactly those rows, so they wait in the Uncategorized tab'`).
3. **Confirming an always-ask row in review mode** saves the category, writes no rule and gives Bayes nothing, so the next row from that merchant still arrives uncategorized. Task 1 (`'confirming in review mode files the row, writes no category rule and trains nothing'`) and Task 4 (`'says no rule was saved when a review pick lands on an Always ask row'`).
4. **Budgets counts only what it says.** A split row (v1.55.4), a transfer, money coming in, another month, another person's row under a personal scope, and a self viewer asking for household are all left out; the card is absent at zero. Task 3 (`uncategorizedSpend` describe) and Task 6 (`'shows nothing when nothing is uncategorized'`, `'a self viewer sees only their own uncategorized spending'`).
5. **An import made late in the evening, local time.** Its UTC date is tomorrow's; the stale reminder, the history list and the digest must all read the household's date. Task 17 (`'reads the household date of an import made after 20:00 local time'`, `'counts the days from the household date'`).

## Decisions this plan makes where the code and the spec meet

1. **`always_ask` is a kind with exact and contains only.** `matchTypeAllowedForKind` already refuses `word` for any kind outside `WORD_MATCH_KINDS`, and `AMOUNT_BOUND_KINDS` refuses an amount window, so both refusals come for free. `ruleOutcomeMissing` stays false: the kind is the whole outcome, as for transfer.
2. **The two recurring marks and `always_ask` are one family, `MERCHANT_MARK_KINDS`** (`src/lib/categorize/mark-kinds.ts`, which has no imports, so clients can ask). All three leave nothing on a row: "Affects" counts the non-transfer rows of every merchant the rule resolves, "Apply now" scopes to nothing, "Delete rule and clear" does not exist for them (`ruleClearIds` returns `[]`, `clearRuleFromTransactions` writes nothing), and a rules pack never exports one (import already skips them: `IMPORTABLE_RULE_KINDS`). Every engine/packs/rules-page site that reads `isRecurringMarkKind` for that reason switches to `isMerchantMarkKind`; `isRecurringMarkKind` stays where recurring alone is meant (`setRecurringMarks`, the recurring sentence in the delete dialog).
3. **Engine.** `categorizeTransaction` asks `matchRule(merchant, 'always_ask', ctx.rules)` right after `detectTransfer` and returns `{ categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null }`. `matchedRuleId` stays null: runEngine bumps hit counts off it, and the category-kind attribution (`attributedRuleId('category')`) would otherwise credit the always-ask rule with category rows; a shadowed category rule's Affects honestly falls to 0. Consequence, stated: a re-run clears a Bayes guess on an always-ask row (ELIGIBLE reaches `bayes` rows); a `rule`-filed row is not eligible and keeps its category until Send back. ELIGIBLE itself is unchanged (owner bound).
4. **No learning, through one predicate.** `alwaysAskRuleFor(normalizedMerchant, rules = listRules('always_ask'))` (rules.ts). `confirmCategory` writes no category rule and skips `train()` when it matches; `createRulesFromRow` skips the category rule only (a person rule from the same dialog is still written — always-ask is about categories); `applyCategoryToMatching` skips its rule. Every teaching path goes through one of those three, so review-mode picks, Accept, bulk categorize and group recategorize with "create rules", and quick add all inherit it. `untrain()` is left exactly as it is: it only ever removes counts (clamped at zero), so at worst it weakens that merchant's tokens, which is the direction the spec asks for. Training recorded before the rule existed is left alone (spec §3: no change to Bayes beyond excluding these rows).
5. **The prefill.** `alwaysAskPattern(normalizedMerchant)` (normalize.ts, pure) removes a trailing masked code: a run of two or more `*` followed by letters or digits at the very end, with any space before it, repeated; if that would leave nothing, the text is returned whole. `normalizeMerchant` keeps such codes (`***AB1` has one digit, under its 5-digit reference rule), so the helper runs on the stored merchant. A single-asterisk merchant code (`UBER *TRIP`) is not a masked code and is left alone.
6. **Where it is set.** The Transactions row menu only, on a non-transfer row whose merchant no enabled always-ask rule already covers, hidden from a self-scoped viewer (a rule is household-wide; every new action refuses them with the rule-from-row sentence). The rules form does not offer the kind: its kind select, zod enum and per-kind field logic would each need another exception, and the spec allows the row menu to be the only way in, as with recurring marks. The Rules page lists it ("Always ask"), filters to it, disables and deletes it, and hides Edit and Apply now for it.
7. **The live count.** The dialog asks the server 300 ms after it opens and 300 ms after the last change to the text or the match type (`previewAlwaysAskAction`). It counts non-transfer rows whose merchant the pattern matches under that type — the same rows the rule's Affects column will show.
8. **Send back.** After the save, the dialog offers "Send N back to review" when N > 0. N is the rows matching THIS rule whose source is `rule` or `bayes`, with a category, not a transfer, no split parts and no loan link — REVIEW_WHERE's own exclusions, so the rows sent really do land in the review queue's Uncategorized tab. Keyed by the rule id, recomputed on the server; clears `category_id`, sets source `none` and `confidence` null; no untrain (neither source was ever trained).
9. **What counts as uncategorized spending.** `uncategorizedSpend` sums money OUT (`amount_cents < 0`, reported as a positive total) and counts those rows, under `SPEND_ROW_WHERE`, `UNCATEGORIZED_WHERE`, the month, and the page's scope (household: every row; personal: that person's rows), narrowed by the viewer exactly as `categoryTransactions` is. Money coming in with no category is not counted: without a category the app cannot tell a refund from income, and netting a paycheque against spending would hide the very spending the card exists to show.
10. **"Total spent" means categorized spending only** (`budgetTotals` sums category rows; the dashboard and safe-to-spend read the same figure). It is not changed. To keep the header's words true, when Z > 0 the line reads `· $C spent in categories · $Z not categorized yet` (the last part in the warning tone); when Z is 0 the line is exactly as today. The header line exists only on the Household card and only when budgets are set; personal sections have no total line, so their card is the whole signal.
11. **The card sits first in the view-mode grid** of the section it belongs to (household, or each person's), and only in view mode: Edit limits replaces the grid with the limit list, which has no cards. A self viewer sees it in their own section. Absent when the count is 0.
12. **How the card reads as needing attention, in both themes.** `MetricCard` gains `tone?: 'default' | 'warning'`; `warning` adds `border-warning` to the card and turns the icon tile to `bg-warning-soft text-warning-soft-fg`. The icon is the existing `WarningIcon` (lucide TriangleAlert, `src/components/ui/icons.tsx`) and the pill slot holds `<Pill tone="warning">Needs attention</Pill>` — the same token family as the import list's "Needs you" pill and `<Notice tone="warning">`. The card keeps the surface background rather than a warning-soft fill because dark `--subtle` on `--warning-soft` is 4.12:1, under the 4.5 floor; the border, the tile, the icon and the label carry the signal, and the icon and label carry it without colour. `tests/ops/contrast.test.ts` pins the two new pairs.
13. **The Categorize link** is a new `transactionsHref` target, `{ kind: 'uncategorized-queue' }`, writing `review=1&queue=uncategorized&category=uncategorized&transfers=0` beside the month and the person. A household viewer lands in the review queue's Uncategorized tab for that month (the spec's first choice: the queue does filter by date); a self-scoped viewer, for whom the page ignores `review=1`, lands on Transactions filtered to uncategorized non-transfer rows for the month (the spec's fallback) — one link for both. Known difference, recorded as a follow-up: the queue also lists uncategorized money coming in, and hides a loan-linked row (REVIEW_WHERE), so an uncategorized owed-loan repayment is counted on the card but reached from Transactions rather than the queue.
14. **Teaching paths say when they did not teach.** `ALWAYS_ASK_NO_RULE = 'No category rule was saved, because rows like this are set to Always ask.'` (engine.ts, beside v1.55.4's `ARCHIVED_CATEGORY_NO_RULE`) is appended by the six actions that append `archivedNoRuleNote` when a rule was asked for and none was written for this reason.
15. **No new nav entry, no new page.** Help's Review and Budgets sections each gain one paragraph.
16. **Item 12 (Tesseract orientation) is left, not built.** The fallback runs only when the ONNX probe rejected the runtime (then the detector is unusable by definition) or when an operator forces `OCR_ENGINE=tesseract` (then loading the ONNX runtime to orient pages would defeat the override). tesseract.js OSD needs `osd.traineddata` and the legacy core, neither of which is vendored (`vendor/tessdata/` holds `eng.traineddata.gz` only; `assertOcrAssets` and `scripts/check-ocr-assets.mjs` pin the LSTM files), so it cannot run on the vendored data. Reported, no task.
17. **Item 19's timeout stays at 5 s.** `src/lib/update/timeouts.ts` argues `GITHUB_INTERACTIVE_TIMEOUT_MS = 5_000` at length (a button that has not answered in five seconds reads as broken, and 15 s was the defect that budget fixed; `tests/lib/update/github.test.ts` pins interactive < scheduled). The owner's condition ("unless timeouts.ts's rationale forbids it") applies. The pending state already exists (the button reads "Asking GitHub…" and is disabled while the check runs) and is kept as it is.
18. **Item 9's fallback is the borrowed date's day, not the 1st.** The schema defines a NULL `posting_day` as "the borrowed date's own day" and the ledger posts on `postingDayFor(purchaseDate, postingDay)`; the projection uses that same function, so it simulates the cycles the ledger really posts. A literal 1st would make the payoff card disagree with the loan page for any loan borrowed on another day.
19. **Item 4's "for that date"** is read as "for that item within the card's window": a marked merchant covered by an item is left out of Coming up only when `upcomingBills` (the same call and window the card uses) yields a row for that item, or a bill row whose name covers the merchant. Comparing dates would list both a cadence row on the 1st and an Expected row on the 3rd for one charge.
20. **Item 6's lean call keeps one core.** The per-merchant candidate pass moves into one non-exported function used by both `recurringCharges` and `expectedRecurringCharges`; the lean path skips the Looks and Forming detectors, the account options and the price-rise row field, but still reads `creepVerdict` for the amount (item 5), so the amount, next expected and late come from the same code on both paths.
21. **Item 8's count.** `setRecurringMarks` returns the number of merchants it actually changed; a merchant whose enabled mark already resolves to the requested one is skipped before any ownership check, so another member's matching mark no longer refuses the batch. A disabled mark does not match (re-marking re-enables it, as before), so a disabled mark owned by somebody else still refuses.
22. **Item 20's bills fold** moves out of `src/app/(app)/warranties/page.tsx` into a pure exported `foldBillSchedules` in `src/lib/warranty/installments.ts`, so it can be tested; the page's behaviour is unchanged.
23. **Item 21** pins the files where a module- or describe-level `today`/`month` computed from the real clock is compared with what a page computes again at render: `Date` only (`toFake: ['Date']`, so SQLite and promises still run), at `2026-03-18T16:00:00.000Z` (noon in the suite's America/Toronto, mid-month). No assertion is loosened.
24. **Item 22** replaces each verbatim quote of the owner in comments and docs (src, tests, scripts, docs incl. plans, specs, PENDING-FIXES and the build ledger) with a plain description of the defect or need. Reviewer quotes in `docs/reviews/`, the app's own UI copy, spec wording and third-party quotes stay. No quote sits inside a test assertion string (checked), so none is left for that reason.

---

## File map

| Area | Files |
|---|---|
| Kind and engine (1–2) | `src/lib/categorize/mark-kinds.ts`, `rules.ts`, `engine.ts`, `normalize.ts`, `src/db/schema.ts`, `src/lib/packs.ts` |
| Budgets data (3) | `src/lib/budgets.ts`, `src/lib/transaction-links.ts` |
| Transactions (4) | `src/app/(app)/transactions/actions.ts`, `page.tsx`, `transactions-client.tsx` |
| Rules page (5) | `src/app/(app)/settings/merchant-rules/page.tsx`, `merchant-rules-client.tsx` |
| Budgets UI (6) | `src/components/ui/MetricCard.tsx`, `src/components/UncategorizedSpendCard.tsx` (new), `src/app/(app)/budgets/budgets-client.tsx`, `page.tsx` |
| Help (7, 9, 22, 23) | `src/app/(app)/help/content.tsx` |
| Receipts (8, 10, 18, 19, 20, 26) | `src/lib/warranty/suggest.ts`, `src/lib/warranty/ocr/pdf.ts`, `src/lib/warranty/ocr/queue.ts`, `src/lib/warranty/staging.ts`, `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`, `src/components/warranty/ReceiptUploader.tsx`, `src/app/(app)/warranties/new/new-warranty-client.tsx`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, `src/lib/warranty/installments.ts`, `src/app/(app)/warranties/page.tsx` |
| Recurring (9, 11–15) | `src/lib/recurring-view.ts`, `src/lib/recurring.ts`, `src/lib/categorize/rules.ts`, `src/app/(app)/transactions/actions.ts`, `src/app/(app)/dashboard/page.tsx` |
| Loans, time zone (16, 17) | `src/lib/loans.ts`, `src/lib/loans/ledger.ts`, `src/lib/dates.ts`, `src/lib/import/freshness.ts`, `src/lib/notify/evaluate/stale.ts`, `src/components/ImportHistoryCard.tsx`, `src/app/(app)/import/batch-client.tsx`, `src/app/(app)/import/page.tsx` |
| Kind wording (21) | `src/lib/warranty/constants.ts` |
| Updates (24, 25) | `src/lib/update/network-error.ts` (new), `src/lib/update/github.ts`, `src/lib/update/state.ts`, `src/app/(app)/settings/actions.ts`, `updates-card.tsx`, `updates-client.tsx` |
| Tests and sweep (26–28) | the test files each names; comments and docs across the repo |
| Release (29) | `CHANGELOG.md`, `package.json`, `package-lock.json`, `tests/ops/docker.test.ts` |

---

### Task 1: The `always_ask` kind, the engine's skip, and no learning (spec §2.1 Engine, No learning)

**Files:**
- Modify: `src/lib/categorize/mark-kinds.ts` (append the family after `isRecurringMarkKind`)
- Modify: `src/lib/categorize/rules.ts` (`RuleKind` union and its docblock; the `./mark-kinds` import and re-export; new `AlwaysAskMatchType`, `alwaysAskRuleFor` and `setAlwaysAskRule` after `setRecurringMarks`)
- Modify: `src/db/schema.ts` (`merchantRules.ruleKind` enum and its docblock)
- Modify: `src/lib/categorize/engine.ts` (`categorizeTransaction`; the five `isRecurringMarkKind` sites in `eligibleForRuleReapply`, `ruleImpactCounts`, `candidateRowsFor`, `ruleClearIds`, `clearRuleFromTransactions`; new `ALWAYS_ASK_NO_RULE`; `confirmCategory`, `createRulesFromRow`, `applyCategoryToMatching`)
- Modify: `src/lib/packs.ts` (`exportableRules`)
- Modify: `tests/ops/rule-attribution-honesty.test.ts` (`ALL_RULE_KINDS`, a new `SCENARIOS` entry), `tests/ops/rule-authoring-intent.test.ts` (`RULE_AUTHORING_HELPERS`)
- Test: `tests/lib/categorize/always-ask.test.ts` (new), `tests/lib/categorize/rules.test.ts`, `tests/lib/packs.test.ts`, `tests/db/schema.test.ts`, the two ops files above

**Interfaces:**
- Produces (`mark-kinds.ts`, still no imports): `export type MerchantMarkKind = RecurringMark | 'always_ask'`; `export const MERCHANT_MARK_KINDS: readonly MerchantMarkKind[] = ['recurring', 'not_recurring', 'always_ask']`; `export function isMerchantMarkKind(kind: string): kind is MerchantMarkKind`.
- Produces (`rules.ts`): `RuleKind` gains `'always_ask'`; the three names above are re-exported beside the existing three; `export type AlwaysAskMatchType = 'exact' | 'contains'`; `export function alwaysAskRuleFor(normalizedMerchant: string, rules: MerchantRuleRecord[] = listRules('always_ask')): MerchantRuleRecord | null`; `export function setAlwaysAskRule(input: { pattern: string; matchType: AlwaysAskMatchType; userId: number; actorRole: 'admin' | 'member'; at?: Date }): RuleUpsertResult`.
- Produces (`engine.ts`): `export const ALWAYS_ASK_NO_RULE = 'No category rule was saved, because rows like this are set to Always ask.'`.

**Known transient break, do not fix here:** widening `RuleKind` leaves `KINDS`/`kindCounts` in `src/app/(app)/settings/merchant-rules/page.tsx`, `KIND_LABEL` in `merchant-rules-client.tsx` and the 17 `kindCounts` literals in `tests/app/merchant-rules-client.test.tsx` without `always_ask` until Task 5. Vitest does not type-check, so nothing fails at run time; do not touch them here.

- [ ] **Step 1: Write the failing engine tests**

Create `tests/lib/categorize/always-ask.test.ts`. Its header comment, `current`/`afterEach` and `setup()` follow `tests/lib/categorize/archived-categories.test.ts` (seeded db, one user, one account; `add(rawDescription, amountCents = -1000)` inserting with `normalizeMerchant` and source `'none'`; `rule(pattern, matchType, categoryId)` writing a category rule; `read(id)` returning `category_id` and `categorization_source`; `groceries`/`coffee` from `categoryIdByName`), and `setup()` also returns `sqlite: current.sqlite` and:
- `ask(pattern, matchType)` — calls `setAlwaysAskRule({ pattern, matchType, userId, actorRole: 'admin' })` and returns its `ruleId` (throw on a refusal);
- `bayesRows()` — `select count(*) as c from bayes_tokens`.

Imports: `applyCategoryToMatching, buildContext, categorizeTransaction, confirmCategory, createRulesFromRow, runEngine` from `@/lib/categorize/engine`; `listRules, setAlwaysAskRule, setRuleDisabledFlag, upsertRuleFromCorrection, type AlwaysAskMatchType, type MatchType` from `@/lib/categorize/rules`; `classify, train` from `@/lib/categorize/bayes`; `normalizeMerchant, tokenize` from `@/lib/categorize/normalize`.

```ts
const outcomeFor = (normalizedMerchant: string) =>
  categorizeTransaction({ id: 0, normalizedMerchant, amountCents: -1000 }, buildContext());
const NOTHING = { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };

/** Spec 2026-10-21 §2.1. After transfer detection, before the category rule and the guess. */
describe('categorizeTransaction with an Always ask rule', () => {
  it('files nothing for a matching merchant, ahead of an exact category rule and a guess', () => {
    const { rule, ask, groceries, coffee } = setup();
    rule('E-TRANSFER ***LL9', 'exact', groceries);
    for (let i = 0; i < 6; i += 1) train(tokenize('E-TRANSFER ***AB1'), groceries);
    for (let i = 0; i < 6; i += 1) train(tokenize('BEAN BARN ROASTERS'), coffee);
    expect(classify(tokenize('E-TRANSFER ***AB1'))?.categoryId).toBe(groceries);
    expect(outcomeFor('E-TRANSFER ***LL9').categoryId).toBe(groceries);
    ask('E-TRANSFER', 'contains');
    expect(outcomeFor('E-TRANSFER ***LL9')).toEqual(NOTHING);
    expect(outcomeFor('E-TRANSFER ***AB1')).toEqual(NOTHING);
  });

  it('leaves a transfer a transfer: detection runs first', () => {
    const { ask, userId } = setup();
    upsertRuleFromCorrection({ pattern: 'E-TRANSFER ***QX7', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    ask('E-TRANSFER', 'contains');
    expect(outcomeFor('E-TRANSFER ***QX7')).toMatchObject({ isTransfer: true, categoryId: null });
  });

  it('an exact rule asks about that text only', () => {
    const { rule, ask, groceries } = setup();
    rule('E-TRANSFER', 'contains', groceries);
    ask('E-TRANSFER ***AB1', 'exact');
    expect(outcomeFor('E-TRANSFER ***AB1')).toEqual(NOTHING);
    expect(outcomeFor('E-TRANSFER ***QX7').categoryId).toBe(groceries);
  });

  // Pin: matchRule already skips a disabled row of any kind.
  it('stops asking once the rule is disabled', () => {
    const { rule, ask, groceries } = setup();
    rule('E-TRANSFER', 'contains', groceries);
    setRuleDisabledFlag(ask('E-TRANSFER', 'contains'), true);
    expect(outcomeFor('E-TRANSFER ***AB1').categoryId).toBe(groceries);
  });

  it('a re-run clears a guess on an Always ask row and leaves a rule-filed row as it is', () => {
    const { add, ask, read, groceries, sqlite } = setup();
    const guessed = add('E-TRANSFER ***AB1');
    const filed = add('E-TRANSFER ***QX7');
    sqlite.prepare("update transactions set category_id = ?, categorization_source = 'bayes', confidence = 3 where id = ?").run(groceries, guessed);
    sqlite.prepare("update transactions set category_id = ?, categorization_source = 'rule' where id = ?").run(groceries, filed);
    ask('E-TRANSFER', 'contains');
    runEngine([guessed, filed]);
    expect(read(guessed)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(filed)).toEqual({ category_id: groceries, categorization_source: 'rule' });
  });
});

/** Spec 2026-10-21 §2.1 No learning: the category is saved, nothing is learned. */
describe('an Always ask row teaches nothing', () => {
  it('confirming in review mode files the row, writes no category rule and trains nothing', () => {
    const { add, ask, read, userId, groceries } = setup();
    const id = add('E-TRANSFER ***AB1');
    ask('E-TRANSFER', 'contains');
    expect(confirmCategory({ transactionId: id, categoryId: groceries, userId, createRule: true, actorRole: 'admin' })).toEqual({ ok: true });
    expect(read(id)).toEqual({ category_id: groceries, categorization_source: 'manual' });
    expect(listRules('category')).toEqual([]);
    expect(bayesRows()).toBe(0);
  });

  it('createRulesFromRow files the rows and writes the person rule, not the category rule', () => {
    const { add, ask, userId, groceries } = setup();
    add('E-TRANSFER ***AB1');
    ask('E-TRANSFER', 'contains');
    expect(
      createRulesFromRow({ normalizedMerchant: 'E-TRANSFER ***AB1', amountMinCents: null, amountMaxCents: null, categoryId: groceries, attributedUserId: null, userId, actorRole: 'admin' }),
    ).toEqual({ ok: true, rulesCreated: 1, categoryChanged: 1, personChanged: 0, splitsSkipped: 0 });
    expect(listRules('category')).toEqual([]);
    expect(listRules('attribution')).toHaveLength(1);
    expect(bayesRows()).toBe(0);
  });

  it('applyCategoryToMatching files every row and writes no rule', () => {
    const { add, ask, userId, groceries } = setup();
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***AB1', -2500);
    ask('E-TRANSFER', 'contains');
    expect(applyCategoryToMatching({ normalizedMerchant: 'E-TRANSFER ***AB1', categoryId: groceries, userId, actorRole: 'admin' })).toEqual({ ok: true, count: 2 });
    expect(listRules('category')).toEqual([]);
    expect(bayesRows()).toBe(0);
  });

  // Pin: a merchant no Always ask rule matches learns exactly as before.
  it('a merchant with no Always ask rule still learns', () => {
    const { add, ask, userId, groceries } = setup();
    const id = add('MAPLE GROCER');
    ask('E-TRANSFER', 'contains');
    confirmCategory({ transactionId: id, categoryId: groceries, userId, createRule: true, actorRole: 'admin' });
    expect(listRules('category').map((r) => r.pattern)).toEqual(['MAPLE GROCER']);
    expect(bayesRows()).toBeGreaterThan(0);
  });
});
```

Fails before / passes after: `setAlwaysAskRule` does not exist; once it does, the category rule and the guess still fire, and `confirmCategory` still writes a rule and trains, until Steps 4–6.

- [ ] **Step 2: Write the failing rules, packs, schema and guard tests**

`tests/lib/categorize/rules.test.ts`: add `alwaysAskRuleFor, isMerchantMarkKind, MERCHANT_MARK_KINDS, setAlwaysAskRule` to the `@/lib/categorize/rules` import and append after `describe('recurring marks', …)`:

```ts
/** Spec 2026-10-21 §2.1. Always ask is a rule kind beside the two recurring marks. */
describe('Always ask rules', () => {
  const setupAsk = () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const member = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
    return { admin, member };
  };

  it('names the three kinds that leave nothing on a row', () => {
    expect(MERCHANT_MARK_KINDS).toEqual(['recurring', 'not_recurring', 'always_ask']);
    expect(isMerchantMarkKind('always_ask')).toBe(true);
    expect(isMerchantMarkKind('recurring')).toBe(true);
    expect(isMerchantMarkKind('category')).toBe(false);
  });

  it('writes one rule with no category, uppercased, and re-enables a disabled one', () => {
    const { admin } = setupAsk();
    expect(setAlwaysAskRule({ pattern: ' e-transfer ', matchType: 'contains', userId: admin, actorRole: 'admin' }).ok).toBe(true);
    expect(listRules('always_ask').map((r) => [r.pattern, r.matchType, r.categoryId])).toEqual([['E-TRANSFER', 'contains', null]]);
    const id = listRules('always_ask')[0]!.id;
    setRuleDisabledFlag(id, true);
    expect(setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId: admin, actorRole: 'admin' })).toEqual({ ok: true, ruleId: id });
    expect(listRules('always_ask')[0]!.disabledAt).toBeNull();
  });

  it("refuses a member over somebody else's rule", () => {
    const { admin, member } = setupAsk();
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId: admin, actorRole: 'admin' });
    expect(setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId: member, actorRole: 'member' })).toEqual({
      ok: false, reason: 'owned_by_another', ownerName: 'Alice',
    });
  });

  it('throws on an empty pattern rather than writing a rule that matches nothing', () => {
    const { admin } = setupAsk();
    expect(() => setAlwaysAskRule({ pattern: '   ', matchType: 'contains', userId: admin, actorRole: 'admin' })).toThrow();
    expect(listRules('always_ask')).toEqual([]);
  });

  it('alwaysAskRuleFor resolves through matchRule and skips a disabled rule', () => {
    const { admin } = setupAsk();
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId: admin, actorRole: 'admin' });
    expect(alwaysAskRuleFor('INTERAC E-TRANSFER ***7QK')?.pattern).toBe('E-TRANSFER');
    expect(alwaysAskRuleFor('TIM HORTONS')).toBeNull();
    setRuleDisabledFlag(listRules('always_ask')[0]!.id, true);
    expect(alwaysAskRuleFor('INTERAC E-TRANSFER ***7QK')).toBeNull();
  });
});
```

`tests/lib/packs.test.ts`, inside `describe('rules pack privacy', …)` after `'never exports a recurring mark of either kind, whatever the toggles say'`:

```ts
  /** Spec 2026-10-21 §2.1. One household's word about its own rows -- the not_transfer argument again. */
  it('never exports an Always ask rule, whatever the toggles say', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'always_ask', categoryId: null, createdBy: userId, actorRole: 'admin' });
    expect(exportRulesPack({ includeTransferRules: true, includeRenameRules: true }).rules.some((r) => r.pattern === 'E-TRANSFER')).toBe(false);
    expect(previewRulesPackExport({ includeTransferRules: true, includeRenameRules: true }).some((r) => r.ruleKind === 'always_ask')).toBe(false);
  });

  // Pin: IMPORTABLE_RULE_KINDS already omits the kind.
  it('skips an Always ask rule in an incoming pack rather than installing it', () => {
    setup();
    const pack = { ...exportRulesPack(), rules: [{ pattern: 'E-TRANSFER', match_type: 'contains', rule_kind: 'always_ask', category: null }] };
    expect(importRulesPack(pack).rulesSkipped).toBe(1);
    expect(listRules('always_ask')).toHaveLength(0);
  });
```

`tests/db/schema.test.ts`, after `'takes a recurring mark in merchant_rules, …'` (pin — `rule_kind` has no CHECK):

```ts
  /** Spec 2026-10-21 §2.1. No migration: rule_kind is a bare text column. */
  it('takes an always_ask rule in merchant_rules', () => {
    current = createTestDb();
    const { sqlite } = current;
    expect(() =>
      sqlite
        .prepare("insert into merchant_rules (id, pattern, match_type, rule_kind, category_id, hit_count, created_at) values (1, 'E-TRANSFER', 'contains', 'always_ask', null, 0, '2026-10-01T00:00:00.000Z')")
        .run(),
    ).not.toThrow();
  });
```

`tests/ops/rule-attribution-honesty.test.ts`: add `always_ask: true,` to `ALL_RULE_KINDS` after `not_recurring: true,`, and this `SCENARIOS` entry after the `'not_recurring'` one:

```ts
  [
    'always_ask',
    {
      build: () => {
        const { userId, add } = fixture();
        const txnId = add('E-TRANSFER ***AB1');
        const rule = upsertRuleFromCorrection({
          pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'always_ask',
          categoryId: null, createdBy: userId, actorRole: 'admin',
        });
        if (!rule.ok) throw new Error('unexpected refusal');
        return { ruleId: rule.ruleId, txnId, merchant: 'E-TRANSFER ***AB1' };
      },
      reapply: {
        attributes: false,
        why:
          'An Always ask rule files nothing -- categorizeTransaction returns no category for its rows -- so ' +
          '"Apply now" has nothing to apply. eligibleForRuleReapply returns [] for every merchant mark kind ' +
          'before attribution is reached; the dialog that sets one offers Send back instead.',
      },
      clear: {
        attributes: false,
        why:
          'Nothing on a row carries an Always ask rule, so there is nothing to take back off it: ruleClearIds ' +
          'returns [] and clearRuleFromTransactions writes nothing. Deleting the rule is the whole undo, and ' +
          'rules and guesses file those rows again from the next run.',
      },
      residue: () => 0,
    },
  ],
```

`tests/ops/rule-authoring-intent.test.ts`, `RULE_AUTHORING_HELPERS`, after `'setRecurringMarks',`:

```ts
  // Spec 2026-10-21 §2.1: writes (and re-enables) one Always ask rule.
  'setAlwaysAskRule',
```

Fails before / passes after: the rules and packs tests name functions and a kind that do not exist; the honesty guard reads Affects 0 and "Apply now" 1 for the new scenario until Step 4. The schema test and the incoming-pack test are pins. The authoring guard stays green (only rules.ts calls the new helper until Task 4).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/categorize/always-ask.test.ts tests/lib/categorize/rules.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/rule-authoring-intent.test.ts`
Expected: FAIL in the new tests only; the two pins pass.

- [ ] **Step 4: The kind**

`mark-kinds.ts`: append `MerchantMarkKind`, `MERCHANT_MARK_KINDS` and `isMerchantMarkKind` (Interfaces) under the docblock `Spec 2026-10-21 §2.1. The kinds that leave nothing on a transaction -- the two recurring marks and Always ask. "Apply now" and "clear" have nothing to do for them, and a rules pack never carries one.` Correct the opening docblock's "re-exports all three".

`rules.ts`: `RuleKind` gains `| 'always_ask'`; add one sentence to the docblock above it: `'always_ask' (spec 2026-10-21 §2.1) files nothing: categorizeTransaction returns no category for a merchant it matches, and nothing is learned from one. Exact or contains only (WORD_MATCH_KINDS, AMOUNT_BOUND_KINDS).` Import and re-export the three new names from `./mark-kinds`. After `setRecurringMarks` add `AlwaysAskMatchType`, `alwaysAskRuleFor` (one line: `return matchRule(normalizedMerchant, 'always_ask', rules);`) and `setAlwaysAskRule`, which throws `new Error('An Always ask rule needs text to match.')` on a pattern that is empty after `trim()`, then calls `upsertRuleFromCorrection({ pattern, matchType, ruleKind: 'always_ask', categoryId: null, createdBy: userId, actorRole, at })` and, on `ok`, `setRuleDisabledFlag(ruleId, false, at)` (saving again re-enables, the recurring-mark rule) before returning the upsert's result.

`schema.ts`: add `'always_ask'` to the `rule_kind` enum array and to its docblock: `'always_ask' is spec 2026-10-21 §2.1, widened the same way: no CHECK, so no migration.`

`engine.ts`: import `alwaysAskRuleFor`, `isMerchantMarkKind` and `MERCHANT_MARK_KINDS` from `./rules`, and drop `isRecurringMarkKind`/`RECURRING_MARK_KINDS` from that import once nothing in the file uses them. Replace `isRecurringMarkKind(` with `isMerchantMarkKind(` in `eligibleForRuleReapply`, `ruleImpactCounts`, `candidateRowsFor`, `ruleClearIds` and `clearRuleFromTransactions`, and `for (const kind of RECURRING_MARK_KINDS)` in `ruleImpactCounts` with `MERCHANT_MARK_KINDS`. Reword each adjacent comment from "a mark" to "a merchant mark (spec 2026-10-05 §2.2, 2026-10-21 §2.1)", and the `ruleImpactCounts` docblock's line to `- recurring / not_recurring / always_ask: the non-transfer rows of every merchant the rule resolves.`

`packs.ts` `exportableRules`: `isRecurringMarkKind` → `isMerchantMarkKind` (import it from `@/lib/categorize/rules`), comment `Spec 2026-10-05 §2.2, 2026-10-21 §2.1. A merchant mark is this household's word about its own merchants -- the not_transfer argument again. Import already skips them (IMPORTABLE_RULE_KINDS omits them).`

- [ ] **Step 5: The engine's skip**

In `categorizeTransaction`, between the `detectTransfer` branch and the category `matchRule`:

```ts
  // Spec 2026-10-21 §2.1: a merchant set to Always ask is filed by a person and nobody else --
  // after transfer detection, before the category rule and the guess.
  if (matchRule(txn.normalizedMerchant, 'always_ask', ctx.rules) !== null) {
    return { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };
  }
```

- [ ] **Step 6: No learning**

Add `ALWAYS_ASK_NO_RULE` directly after `ARCHIVED_CATEGORY_NO_RULE`, with `/** One wording, one place (MUST-19.11): the pick is saved; an Always ask row teaches no rule. */`.

`confirmCategory`: after the `has_splits` refusal, `const alwaysAsks = alwaysAskRuleFor(row.normalizedMerchant) !== null;` under the comment `Spec 2026-10-21 §2.1: an Always ask row is saved and teaches nothing -- no rule, no training.` The rule branch's condition gains `&& !alwaysAsks`; the closing `train(tokens, input.categoryId);` becomes `if (!alwaysAsks) train(tokens, input.categoryId);`. The `untrain` call is unchanged (decision 4).

`createRulesFromRow`: the category upsert's condition becomes `input.categoryId !== undefined && mayLearnCategoryRule(input.categoryId) && alwaysAskRuleFor(input.normalizedMerchant) === null`. The per-row `confirmCategory` calls inside it already skip the training.

`applyCategoryToMatching`: the upsert's condition becomes `mayLearnCategoryRule(input.categoryId) && alwaysAskRuleFor(input.normalizedMerchant) === null`; its comment names both reasons.

Extend `mayLearnCategoryRule`'s docblock: the same three writers also skip a merchant set to Always ask (`alwaysAskRuleFor`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/categorize/always-ask.test.ts tests/lib/categorize/rules.test.ts tests/lib/categorize/archived-categories.test.ts tests/lib/categorize/engine.test.ts tests/lib/categorize/create-rules-from-row.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/rule-authoring-intent.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/categorize/mark-kinds.ts src/lib/categorize/rules.ts src/lib/categorize/engine.ts src/lib/packs.ts src/db/schema.ts tests/lib/categorize/always-ask.test.ts tests/lib/categorize/rules.test.ts tests/lib/packs.test.ts tests/db/schema.test.ts tests/ops/rule-attribution-honesty.test.ts tests/ops/rule-authoring-intent.test.ts
git commit -m "feat(rules): Always ask rule kind files nothing and teaches nothing

- always_ask kind, exact or contains; no migration
- engine returns no category after transfer detection
- no category rule or Bayes training from an Always ask row
- merchant mark family: no Apply now, no clear, never in a pack"
```

### Task 2: The prefill, the match count, and Send back (spec §2.1 Where it is set)

**Files:**
- Modify: `src/lib/categorize/normalize.ts` (new `alwaysAskPattern`, after `normalizeMerchant`)
- Modify: `src/lib/categorize/engine.ts` (new `alwaysAskMatchCount`, `alwaysAskSendBackIds`, `sendAlwaysAskRowsToReview`, placed after `applyCategoryToMatching`)
- Test: `tests/lib/categorize/normalize.test.ts`, `tests/lib/categorize/always-ask.test.ts`

**Interfaces:**
- Consumes: `AlwaysAskMatchType`, `listRules`, `patternMatches` (rules.ts); Task 1's `always_ask` kind.
- Produces (`normalize.ts`, pure, client-safe): `export function alwaysAskPattern(normalizedMerchant: string): string`.
- Produces (`engine.ts`, server-only):
  - `export function alwaysAskMatchCount(input: { pattern: string; matchType: AlwaysAskMatchType }): number` — the pattern is trimmed and uppercased the way `upsertRuleFromCorrection` stores it; empty → 0.
  - `export function alwaysAskSendBackIds(ruleId: number): number[]` — `[]` unless the id names an enabled `always_ask` rule.
  - `export function sendAlwaysAskRowsToReview(input: { ruleId: number; at?: Date }): { sent: number }`.

- [ ] **Step 1: Write the failing prefill tests**

`tests/lib/categorize/normalize.test.ts`: add `alwaysAskPattern` to the `@/lib/categorize/normalize` import, and append:

```ts
/** Spec 2026-10-21 §2.1. The Always ask dialog's starting text: the merchant without its masked code. */
describe('alwaysAskPattern', () => {
  it('drops a trailing masked code, so every recipient of the same kind of payment matches', () => {
    expect(alwaysAskPattern('E-TRANSFER ***AB1')).toBe('E-TRANSFER');
    expect(alwaysAskPattern('INTERAC E-TRANSFER ***7QK')).toBe('INTERAC E-TRANSFER');
    expect(alwaysAskPattern('E-TRANSFER***QX7')).toBe('E-TRANSFER');
    expect(alwaysAskPattern('E-TRANSFER ***')).toBe('E-TRANSFER');
  });

  it('works on what the normaliser stores, which keeps the code', () => {
    expect(normalizeMerchant('E-TRANSFER ***AB1')).toBe('E-TRANSFER ***AB1');
    expect(alwaysAskPattern(normalizeMerchant('E-TRANSFER ***AB1'))).toBe('E-TRANSFER');
  });

  it('leaves a merchant with no masked code alone, and never empties one that is only a code', () => {
    expect(alwaysAskPattern('TIM HORTONS')).toBe('TIM HORTONS');
    expect(alwaysAskPattern('UBER *TRIP')).toBe('UBER *TRIP');
    expect(alwaysAskPattern('***AB1')).toBe('***AB1');
  });
});
```

Fails before / passes after: `alwaysAskPattern` does not exist until Step 4. (`normalizeMerchant` keeping the code is a pin inside a new test.)

- [ ] **Step 2: Write the failing count and Send back tests**

`tests/lib/categorize/always-ask.test.ts`: add `alwaysAskMatchCount, alwaysAskSendBackIds, reviewQueueIds, sendAlwaysAskRowsToReview` to the engine import. `setup()` gains `file(id, source, categoryId)` — `update transactions set categorization_source = ?, category_id = ?, confidence = ? where id = ?` with confidence `3` for `'bayes'`, else null — `transfer(id)` (`is_transfer = 1`), `split(id, categoryId)` (two `transaction_splits` rows of -600 and -400 for the default -1000 row: `insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)`), and `loanLink(id)`, which inserts a loan-kind `warranty_items` row the way `tests/lib/budgets.test.ts`'s `seedLoanItem` does and a `loan_payments` row naming it (read `src/db/schema.ts` `loanPayments` for its NOT NULL columns). Append:

```ts
/** Spec 2026-10-21 §2.1. The dialog's live count: every non-transfer row the pattern matches. */
describe('alwaysAskMatchCount', () => {
  it('counts the non-transfer rows the pattern matches, under either type', () => {
    const { add, transfer } = setup();
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***QX7');
    transfer(add('E-TRANSFER ***QX7'));
    add('TIM HORTONS');
    expect(alwaysAskMatchCount({ pattern: ' e-transfer ', matchType: 'contains' })).toBe(2);
    expect(alwaysAskMatchCount({ pattern: 'E-TRANSFER ***QX7', matchType: 'exact' })).toBe(1);
    expect(alwaysAskMatchCount({ pattern: '   ', matchType: 'contains' })).toBe(0);
  });
});

/** Spec 2026-10-21 §2.1. Only what a rule or a guess filed goes back; a person's decision never does. */
describe('Send back to review', () => {
  it('offers back rows a rule or a guess filed, and never a hand-set, split, transfer or loan-linked row', () => {
    const { add, ask, file, transfer, split, loanLink, groceries, coffee } = setup();
    const byRule = add('E-TRANSFER ***LL9');
    const byGuess = add('E-TRANSFER ***AB1');
    const byHand = add('E-TRANSFER ***AB1');
    const splitRow = add('E-TRANSFER ***QX7');
    const transferRow = add('E-TRANSFER ***QX7');
    const linked = add('E-TRANSFER ***LL9');
    const otherMerchant = add('MAPLE GROCER');
    file(byRule, 'rule', groceries);
    file(byGuess, 'bayes', groceries);
    file(byHand, 'manual', coffee);
    file(splitRow, 'rule', groceries);
    split(splitRow, groceries);
    file(transferRow, 'rule', groceries);
    transfer(transferRow);
    file(linked, 'rule', groceries);
    loanLink(linked);
    file(otherMerchant, 'rule', groceries);
    const ruleId = ask('E-TRANSFER', 'contains');
    expect(alwaysAskSendBackIds(ruleId)).toEqual([byRule, byGuess]);
  });

  it('clears exactly those rows, so they wait in the Uncategorized tab', () => {
    const { add, ask, file, read, groceries, coffee } = setup();
    const byRule = add('E-TRANSFER ***LL9');
    const byGuess = add('E-TRANSFER ***AB1');
    const byHand = add('E-TRANSFER ***AB1');
    file(byRule, 'rule', groceries);
    file(byGuess, 'bayes', groceries);
    file(byHand, 'manual', coffee);
    const ruleId = ask('E-TRANSFER', 'contains');
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 2 });
    expect(read(byRule)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(byGuess)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(byHand)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(reviewQueueIds()).toEqual(expect.arrayContaining([byRule, byGuess]));
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 0 });
  });

  it('sends nothing for a disabled rule, a missing one, or a rule of another kind', () => {
    const { add, ask, file, rule, groceries } = setup();
    file(add('E-TRANSFER ***LL9'), 'rule', groceries);
    const ruleId = ask('E-TRANSFER', 'contains');
    const categoryRuleId = rule('E-TRANSFER', 'contains', groceries);
    expect(alwaysAskSendBackIds(categoryRuleId)).toEqual([]);
    expect(alwaysAskSendBackIds(999_999)).toEqual([]);
    setRuleDisabledFlag(ruleId, true);
    expect(alwaysAskSendBackIds(ruleId)).toEqual([]);
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 0 });
  });
});
```

Fails before / passes after: the three engine functions do not exist until Step 5.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/categorize/normalize.test.ts tests/lib/categorize/always-ask.test.ts`
Expected: FAIL in the new describes only.

- [ ] **Step 4: `alwaysAskPattern`**

In `normalize.ts`, after `normalizeMerchant`: strip `/\s*\*{2,}[0-9A-Z]*$/` repeatedly while it matches; trim; if the result is empty return the input unchanged. Docblock: `Spec 2026-10-21 §2.1. The text the Always ask dialog starts from: the stored merchant without a trailing masked code (two or more asterisks and the letters or digits after them), which often names the recipient and would make the rule match one person's rows only. normalizeMerchant keeps such a code (its reference-token rule needs five digits), so this runs on the stored text. A single asterisk is part of many merchant names and is left alone.`

- [ ] **Step 5: The count and Send back**

In `engine.ts`, after `applyCategoryToMatching`, under one docblock naming spec 2026-10-21 §2.1 and decision 8 of the plan in words (the rows REVIEW_WHERE would show once cleared):
- `alwaysAskMatchCount`: normalise the pattern (`trim().toUpperCase()`); return 0 when empty; one grouped read of non-transfer rows `select normalized_merchant, count(*) … where is_transfer = 0 group by normalized_merchant`, summing the groups `patternMatches(pattern, matchType, merchant)` accepts.
- `alwaysAskSendBackIds`: find the rule in `listRules('always_ask')` with this id and `disabledAt === null`, else `[]`; select `id, normalized_merchant` where `categorization_source in ('rule', 'bayes')`, `category_id is not null`, `is_transfer = 0`, and the same two correlated `not exists` clauses `REVIEW_WHERE` uses for `transaction_splits` and `loan_payments` (inside `.where()`, never the select list — `transactionHasSplits`' docblock); keep the rows `patternMatches(rule.pattern, rule.matchType, row.normalizedMerchant)` accepts; order by id.
- `sendAlwaysAskRowsToReview`: `alwaysAskSendBackIds(ruleId)`, then in one `getDb().transaction` and `ID_CHUNK` chunks set `categoryId: null, categorizationSource: 'none', confidence: null, updatedAt: nowIso(at)`; return `{ sent }`. No `untrain` — neither source was ever trained (comment says so).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/categorize/normalize.test.ts tests/lib/categorize/always-ask.test.ts tests/ops/rule-authoring-intent.test.ts tests/ops/spend-where.test.ts`
Expected: PASS. (The authoring guard confirms none of the three new engine exports calls a rule helper; the spend-where guard allows the bare transfer clause in engine.ts.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/categorize/normalize.ts src/lib/categorize/engine.ts tests/lib/categorize/normalize.test.ts tests/lib/categorize/always-ask.test.ts
git commit -m "feat(rules): Always ask prefill, match count and send back

- alwaysAskPattern drops a trailing masked code
- alwaysAskMatchCount counts non-transfer rows a pattern matches
- send back clears rule- and guess-filed rows only"
```

### Task 3: Uncategorized spending as data, and the link to it (spec §2.2)

**Files:**
- Modify: `src/lib/budgets.ts` (new `UncategorizedSpend` and `uncategorizedSpend`, after `categoryTransactions`)
- Modify: `src/lib/transaction-links.ts` (`TransactionsLinkTarget`, `transactionsHref`)
- Modify: `tests/ops/visibility-invariants.test.ts` (`REQUIRE_VIEWER`, the floor)
- Test: `tests/lib/budgets.test.ts`, `tests/lib/transaction-links.test.ts`, `tests/ops/visibility-invariants.test.ts`

**Interfaces:**
- Consumes: `UNCATEGORIZED_WHERE` (v1.55.4, exported from `src/lib/categorize/engine.ts` — the one definition of "category null and no split parts"; reuse it, do not restate it), `SPEND_ROW_WHERE` (`src/lib/spend-where.ts`), `ownerScope` (`src/lib/auth/viewer.ts`).
- Produces (`budgets.ts`, server-only): `export interface UncategorizedSpend { totalCents: number; count: number }`; `export function uncategorizedSpend(month: string, opts: { scope: BudgetScope; attributedUserId: number | null }, viewer: Viewer): UncategorizedSpend` — `totalCents` is positive (money out).
- Produces (`transaction-links.ts`, client-safe): `TransactionsLinkTarget` gains `| { kind: 'uncategorized-queue' }`.

- [ ] **Step 1: Write the failing data tests**

`tests/lib/budgets.test.ts`: add `uncategorizedSpend` to the `@/lib/budgets` import. Append (the file's `setup()`/`spend()`/`seedLoanItem()`/`HOUSEHOLD_VIEWER` as they are; `split` rows inserted with SQL):

```ts
/** Spec 2026-10-21 §2.2. What Budgets says is not categorized yet: money out with no category. */
describe('uncategorizedSpend', () => {
  const addSplitParts = (txnId: number, categoryId: number, amounts: number[]) => {
    for (const amount of amounts) {
      current!.sqlite
        .prepare('insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)')
        .run(txnId, categoryId, amount, nowIso());
    }
  };

  it('sums money out with no category in the month, leaving out transfers, money in, split rows and other months', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: null, amountCents: -4500 });
    spend({ categoryId: null, amountCents: -1250 });
    spend({ categoryId: null, amountCents: -9900, isTransfer: true });
    spend({ categoryId: null, amountCents: 250000 });
    spend({ categoryId: groceries, amountCents: -3000 });
    spend({ categoryId: null, amountCents: -7000, date: '2026-02-27' });
    addSplitParts(spend({ categoryId: null, amountCents: -6000 }), groceries, [-4000, -2000]);
    expect(uncategorizedSpend('2026-03', { scope: 'household', attributedUserId: null }, HOUSEHOLD_VIEWER)).toEqual({ totalCents: 5750, count: 2 });
  });

  it('leaves out money lent on a loan, which is not spending (SPEND_ROW_WHERE)', () => {
    const { spend, alice } = setup();
    const lent = seedLoanItem(alice, 'lent');
    const payout = spend({ categoryId: null, amountCents: -50000 });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: payout, itemId: lent });
    spend({ categoryId: null, amountCents: -800 });
    expect(uncategorizedSpend('2026-03', { scope: 'household', attributedUserId: null }, HOUSEHOLD_VIEWER)).toEqual({ totalCents: 800, count: 1 });
  });

  it('a personal scope counts that person only; the household counts everyone', () => {
    const { spend, alice, bob } = setup();
    spend({ categoryId: null, amountCents: -1000, attributedUserId: alice });
    spend({ categoryId: null, amountCents: -2000, attributedUserId: bob });
    spend({ categoryId: null, amountCents: -3000 });
    expect(uncategorizedSpend('2026-03', { scope: 'personal', attributedUserId: alice }, HOUSEHOLD_VIEWER)).toEqual({ totalCents: 1000, count: 1 });
    expect(uncategorizedSpend('2026-03', { scope: 'household', attributedUserId: null }, HOUSEHOLD_VIEWER)).toEqual({ totalCents: 6000, count: 3 });
  });

  it('a self viewer reads only their own rows, whatever scope is asked for', () => {
    const { spend, alice, bob } = setup();
    spend({ categoryId: null, amountCents: -1000, attributedUserId: alice });
    spend({ categoryId: null, amountCents: -2000, attributedUserId: bob });
    const self: Viewer = { id: alice, role: 'member', visibility: 'self' };
    expect(uncategorizedSpend('2026-03', { scope: 'household', attributedUserId: null }, self)).toEqual({ totalCents: 1000, count: 1 });
    expect(uncategorizedSpend('2026-03', { scope: 'personal', attributedUserId: bob }, self)).toEqual({ totalCents: 0, count: 0 });
  });

  it('a personal scope needs a person', () => {
    setup();
    expect(() => uncategorizedSpend('2026-03', { scope: 'personal', attributedUserId: null }, HOUSEHOLD_VIEWER)).toThrow();
  });
});
```

(Copy the `assignTransactionToLoan` call shape from this file's existing loan describe block if the `seedLoanItem` loan needs the payout to be attributed or dated a particular way.)

`tests/lib/transaction-links.test.ts`, inside `describe('transactionsHref — the figure the link is under', …)`:

```ts
  /** Spec 2026-10-21 §2.2: Budgets' Categorize link. Review mode for a household viewer; the plain list for a self viewer. */
  it('the uncategorized queue link opens the review queue’s Uncategorized tab for the month, or the plain list for a self viewer', () => {
    const href = transactionsHref({ range: { from: '2026-02-01', to: '2026-02-28' }, person: 4 }, { kind: 'uncategorized-queue' });
    const params: TransactionParams = Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1)));
    const range = resolveRange({ preset: params.range as string, from: params.from as string, to: params.to as string, today: TODAY, fallback: null });
    const household = readFilter(params, range, null, params.review === '1');
    expect({
      reviewOnly: household.reviewOnly, reviewQueue: household.reviewQueue, categoryId: household.categoryId,
      transferView: household.transferView, from: household.from, to: household.to, person: household.attributedUserId,
    }).toEqual({ reviewOnly: true, reviewQueue: 'uncategorized', categoryId: 'uncategorized', transferView: 'none', from: '2026-02-01', to: '2026-02-28', person: 4 });
    const self = readFilter(params, range, 9, false);
    expect({ reviewOnly: self.reviewOnly, categoryId: self.categoryId, transferView: self.transferView, person: self.attributedUserId }).toEqual({
      reviewOnly: false, categoryId: 'uncategorized', transferView: 'none', person: 9,
    });
  });
```

`tests/ops/visibility-invariants.test.ts`: after the `categoryTransactions` entry in `REQUIRE_VIEWER` add

```ts
  // Spec 2026-10-21 §2.2: Budgets' Not categorized yet card, a spending read like categoryTransactions.
  { file: 'src/lib/budgets.ts', fn: 'uncategorizedSpend' },
```

and raise the floor test to `'the named lists cannot shrink below 43 entries'` / `toBeGreaterThanOrEqual(43)`, with the comment line `// Spec 2026-10-21: raised from 42 to 43, the actual count with uncategorizedSpend added.`

Fails before / passes after: `uncategorizedSpend` and the `uncategorized-queue` target do not exist until Steps 3–4; the guard cannot find the function's signature until then.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/budgets.test.ts tests/lib/transaction-links.test.ts tests/ops/visibility-invariants.test.ts`
Expected: FAIL in the new tests only.

- [ ] **Step 3: `uncategorizedSpend`**

In `budgets.ts`, after `categoryTransactions`, same guard and shape as it: throw `'Personal uncategorized spend requires a user'` for `scope: 'personal'` with no user; clauses = month bounds (`monthStart`/`monthEnd`), `...SPEND_ROW_WHERE`, `UNCATEGORIZED_WHERE`, `lt(transactions.amountCents, 0)`, the personal `attributedUserId` clause, then `ownerScope(viewer)` appended AFTER it (the categoryTransactions order and reason). One query over `transactions` alone (an uncategorized row has no split parts, so no join): `select coalesce(sum(-amount_cents), 0), count(*)`. Import `UNCATEGORIZED_WHERE` from `@/lib/categorize/engine` and use it only inside the function body. Docblock: spec 2026-10-21 §2.2; money OUT only and why (decision 9: with no category a refund cannot be told from income); the viewer narrowing reason, pointing at `categoryTransactions`.

- [ ] **Step 4: The link target**

`transaction-links.ts`: add `| { kind: 'uncategorized-queue' }` to `TransactionsLinkTarget` with a docblock (spec 2026-10-21 §2.2: Budgets' Categorize link; the review queue's Uncategorized tab for a household viewer, and — because the transactions page ignores `review=1` for a self-scoped viewer — the plain list narrowed to uncategorized non-transfer rows for one). In `transactionsHref` add its branch: `params.set('review', '1'); params.set('queue', 'uncategorized'); params.set('category', 'uncategorized'); params.set('transfers', '0');`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/budgets.test.ts tests/lib/transaction-links.test.ts tests/ops/visibility-invariants.test.ts tests/ops/spend-where.test.ts tests/ops/transactions-href.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/budgets.ts src/lib/transaction-links.ts tests/lib/budgets.test.ts tests/lib/transaction-links.test.ts tests/ops/visibility-invariants.test.ts
git commit -m "feat(budgets): read uncategorized spending for a month and scope

- uncategorizedSpend: money out, SPEND_ROW_WHERE, no category and no split parts
- viewer-narrowed like categoryTransactions; visibility floor 43
- transactionsHref target for the review queue's Uncategorized tab"
```


---

### Task 4: Transactions — "Always ask for rows like this" (spec §2.1 Where it is set, §2.3)

**Files:**
- Modify: `src/app/(app)/transactions/actions.ts` (new `AlwaysAskState`, `previewAlwaysAskAction`, `setAlwaysAskAction`, `sendBackToReviewAction`; the no-rule note in `setCategoryAction`, `acceptGuessAction`, `applyToAllMatchingAction`, `bulkCategorizeAction`, `bulkRecategorizeGroupAction`, `createRulesFromRowAction` -- the six places v1.55.4 appends `archivedNoRuleNote`)
- Modify: `src/app/(app)/transactions/page.tsx` (new `alwaysAskMerchants` prop, beside `recurringMarks`)
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (prop, state, the menu item after "Create a rule…", the dialog, the banner chain)
- Modify: `tests/ops/rule-authoring-intent.test.ts` (`ALLOWED_AUTHORS` reason for `src/app/(app)/transactions/actions.ts`)
- Test: `tests/app/transactions-actions.test.ts`, `tests/app/transactions-client.test.tsx`

**Interfaces:**
- Consumes: Task 1's `setAlwaysAskRule`, `alwaysAskRuleFor`, `ALWAYS_ASK_NO_RULE`, `listRules`; Task 2's `alwaysAskPattern`, `alwaysAskMatchCount`, `alwaysAskSendBackIds`, `sendAlwaysAskRowsToReview`.
- Produces (`actions.ts`):
  - `export interface AlwaysAskState extends ActionState { ruleId?: number; sendBackCount?: number }`
  - `previewAlwaysAskAction(_prev: ActionState, formData: FormData): Promise<ActionState>` — fields `pattern`, `matchType`.
  - `setAlwaysAskAction(_prev: AlwaysAskState, formData: FormData): Promise<AlwaysAskState>` — fields `pattern`, `matchType`.
  - `sendBackToReviewAction(_prev: ActionState, formData: FormData): Promise<ActionState>` — field `ruleId`.
- Produces (`TransactionsClient`): `alwaysAskMerchants?: string[]` (default `[]`) — the page rows' merchants an enabled Always ask rule already covers.

Exact copy (spec §2.3):

| Where | Text |
|---|---|
| Row menu item | `Always ask for rows like this…` |
| Dialog title | `Always ask for rows like this` |
| Dialog intro | `No rule or guess will file a matching row. Each one waits in review for you to choose.` |
| Fields | `Text to match` (input `pattern`), `Match` (select `matchType`: `Contains` = `contains`, `Exact` = `exact`) |
| Live count | `Matches 1 transaction.` / `Matches N transactions.` |
| Submit | `Always ask` |
| Saved | `Rows matching "E-TRANSFER" will always be asked about.` (the stored, uppercased pattern) |
| Offer | `1 of them was filed by a rule or a guess.` / `N of them were filed by a rule or a guess.`, button `Send N back to review`, button `Done` |
| Sent | `Sent 1 transaction back to review.` / `Sent N transactions back to review.` |
| Refusals | self-scoped: `Rules are set up for the whole household, so this is not available here.` (the existing sentence — hoist it into one `const RULES_ARE_HOUSEHOLD_WIDE` and use it in the two existing rule-from-row actions too); empty pattern: `Type the text to match.`; a rule that is gone or off: `That Always ask rule is no longer on.`; anything else: `Invalid request.` |

- [ ] **Step 1: Write the failing action tests**

`tests/app/transactions-actions.test.ts`: add `previewAlwaysAskAction, sendBackToReviewAction, setAlwaysAskAction` to the actions import and `setAlwaysAskRule` to the rules import. Append (`setup()`, `formData()`, `currentUser`, `sameOrigin` and `revalidatePath` as the file already has them; `fileAs(id, source, categoryId)` is a local helper running `update transactions set categorization_source = ?, category_id = ? where id = ?`):

```ts
/** Spec 2026-10-21 §2.1. The row menu's Always ask dialog. */
describe('Always ask from a row', () => {
  it('counts the rows the text would ask about', async () => {
    const { addTxn } = setup();
    addTxn('E-TRANSFER ***AB1', -2000);
    addTxn('E-TRANSFER ***QX7', -3500);
    addTxn('TIM HORTONS', -500);
    expect(await previewAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains' }))).toEqual({ message: 'Matches 2 transactions.' });
    expect(await previewAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER ***QX7', matchType: 'exact' }))).toEqual({ message: 'Matches 1 transaction.' });
  });

  it('saves the rule and offers back the rows a rule or a guess filed', async () => {
    const { addTxn, db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    fileAs(addTxn('E-TRANSFER ***AB1', -2000), 'rule', groceries);
    fileAs(addTxn('E-TRANSFER ***QX7', -3500), 'bayes', groceries);
    fileAs(addTxn('E-TRANSFER ***QX7', -1500), 'manual', groceries);
    const result = await setAlwaysAskAction({}, formData({ pattern: 'e-transfer', matchType: 'contains' }));
    const rule = listRules('always_ask')[0]!;
    expect(result).toEqual({ message: 'Rows matching "E-TRANSFER" will always be asked about.', ruleId: rule.id, sendBackCount: 2 });
    expect([rule.pattern, rule.matchType]).toEqual(['E-TRANSFER', 'contains']);
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/transactions', '/settings/merchant-rules']));
  });

  it('sends those rows back and says how many', async () => {
    const { addTxn, db, userId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    fileAs(addTxn('E-TRANSFER ***AB1', -2000), 'rule', groceries);
    fileAs(addTxn('E-TRANSFER ***QX7', -3500), 'bayes', groceries);
    const saved = setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    if (!saved.ok) throw new Error('refused');
    vi.mocked(revalidatePath).mockClear();
    expect(await sendBackToReviewAction({}, formData({ ruleId: String(saved.ruleId) }))).toEqual({ message: 'Sent 2 transactions back to review.' });
    expect(vi.mocked(revalidatePath).mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/transactions', '/budgets', '/dashboard']));
  });

  it('refuses a self-scoped viewer on all three, and writes nothing', async () => {
    const { addTxn } = setup();
    addTxn('E-TRANSFER ***AB1', -2000);
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const refusal = { error: 'Rules are set up for the whole household, so this is not available here.' };
    expect(await previewAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains' }))).toEqual(refusal);
    expect(await setAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains' }))).toEqual(refusal);
    expect(await sendBackToReviewAction({}, formData({ ruleId: '1' }))).toEqual(refusal);
    expect(listRules('always_ask')).toEqual([]);
  });

  it('refuses empty text, an unknown match type, and a rule that is no longer on', async () => {
    setup();
    expect(await setAlwaysAskAction({}, formData({ pattern: '   ', matchType: 'contains' }))).toEqual({ error: 'Type the text to match.' });
    expect(await setAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'word' }))).toEqual({ error: 'Invalid request.' });
    expect(await sendBackToReviewAction({}, formData({ ruleId: '999999' }))).toEqual({ error: 'That Always ask rule is no longer on.' });
    expect(listRules('always_ask')).toEqual([]);
  });

  it("refuses a member over somebody else's rule", async () => {
    const { db } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId: currentUser.id, actorRole: 'admin' });
    currentUser = { id: bob, name: 'Bob', username: 'bob', role: 'member' };
    expect(await setAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains' }))).toEqual({ error: ruleOwnedError('Alice') });
  });

  it('refuses a cross-origin post before anything else', async () => {
    setup();
    sameOrigin.value = false;
    expect(await setAlwaysAskAction({}, formData({ pattern: 'E-TRANSFER', matchType: 'contains' }))).toEqual({ error: CROSS_ORIGIN_ERROR });
    expect(listRules('always_ask')).toEqual([]);
  });
});

/** Spec 2026-10-21 §2.1 No learning: a pick that would teach a rule says when it did not. */
describe('teaching paths on an Always ask row', () => {
  const NOTE = 'No category rule was saved, because rows like this are set to Always ask.';

  it('says no rule was saved when a review pick lands on an Always ask row', async () => {
    const { addTxn, db, userId } = setup();
    const id = addTxn('E-TRANSFER ***AB1', -2000);
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    const groceries = categoryIdByName(db, 'Groceries');
    expect(await setCategoryAction({}, formData({ transactionId: String(id), categoryId: String(groceries), teach: '1' }))).toEqual({ message: `Category updated. ${NOTE}` });
    expect(listRules('category')).toEqual([]);
  });

  it('says so on Apply to all matching, on the bulk bar with rules on, and on Create a rule', async () => {
    const { addTxn, db, userId } = setup();
    const a = addTxn('E-TRANSFER ***AB1', -2000);
    const b = addTxn('E-TRANSFER ***AB1', -1000);
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    const groceries = String(categoryIdByName(db, 'Groceries'));
    expect((await applyToAllMatchingAction({}, formData({ normalizedMerchant: 'E-TRANSFER ***AB1', categoryId: groceries }))).message).toBe(`Applied to 2 transactions. ${NOTE}`);
    expect((await bulkCategorizeAction({}, formData({ ids: `${a},${b}`, categoryId: groceries, createRules: 'on' }))).message).toContain(NOTE);
    expect((await createRulesFromRowAction({}, formData({ normalizedMerchant: 'E-TRANSFER ***AB1', amountMin: '', amountMax: '', categoryId: groceries, person: '' }))).message).toContain(NOTE);
    expect(listRules('category')).toEqual([]);
  });

  // Pin: a plain per-row pick never asked for a rule, so it says nothing extra.
  it('says nothing extra on a plain pick', async () => {
    const { addTxn, db, userId } = setup();
    const id = addTxn('E-TRANSFER ***AB1', -2000);
    setAlwaysAskRule({ pattern: 'E-TRANSFER', matchType: 'contains', userId, actorRole: 'admin' });
    expect(await setCategoryAction({}, formData({ transactionId: String(id), categoryId: String(categoryIdByName(db, 'Groceries')) }))).toEqual({ message: 'Category updated.' });
  });
});
```

(Add `createRulesFromRowAction` to the import if the file does not already import it; `acceptGuessAction` gets the same note through the same helper — Step 4 — and needs no separate test beyond the helper's.)

Fails before / passes after: the three actions do not exist, and no action appends the note, until Steps 4–5.

- [ ] **Step 2: Write the failing client tests**

`tests/app/transactions-client.test.tsx`: add `previewAlwaysAskAction: vi.fn(async () => ({})), setAlwaysAskAction: vi.fn(async () => ({})), sendBackToReviewAction: vi.fn(async () => ({})),` to the `vi.mock('@/app/(app)/transactions/actions', …)` factory and the three names to the actions import. Append:

```ts
/** Spec 2026-10-21 §2.1. The row menu's Always ask dialog. */
describe('TransactionsClient — Always ask for rows like this', () => {
  const base = { accounts: [], categories: [], people: [], today: '2026-03-02' };
  const etransfer = () => pageWithRow({ rawDescription: 'E-TRANSFER ***AB1', normalizedMerchant: 'E-TRANSFER ***AB1', source: 'rule' });
  const openAsk = () => {
    openRowMenu('Actions for E-TRANSFER ***AB1');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Always ask for rows like this…' }));
  };

  it('is offered on a non-transfer row, and not on a transfer, for a self-scoped viewer, or for a merchant already asked about', () => {
    const { unmount } = render(<TransactionsClient page={etransfer()} {...base} />);
    openRowMenu('Actions for E-TRANSFER ***AB1');
    expect(screen.getByRole('menuitem', { name: 'Always ask for rows like this…' })).toBeTruthy();
    unmount();
    for (const props of [
      { page: pageWithRow({ rawDescription: 'E-TRANSFER ***AB1', normalizedMerchant: 'E-TRANSFER ***AB1', isTransfer: true }) },
      { page: etransfer(), selfScoped: true },
      { page: etransfer(), alwaysAskMerchants: ['E-TRANSFER ***AB1'] },
    ]) {
      const view = render(<TransactionsClient {...base} {...props} />);
      openRowMenu('Actions for E-TRANSFER ***AB1');
      expect(screen.queryByRole('menuitem', { name: 'Always ask for rows like this…' })).toBeNull();
      view.unmount();
    }
  });

  it('opens with the merchant minus its masked code, Contains chosen, and the live count', async () => {
    vi.mocked(previewAlwaysAskAction).mockResolvedValue({ message: 'Matches 3 transactions.' });
    render(<TransactionsClient page={etransfer()} {...base} />);
    openAsk();
    expect((screen.getByLabelText('Text to match') as HTMLInputElement).value).toBe('E-TRANSFER');
    expect((screen.getByLabelText('Match') as HTMLSelectElement).value).toBe('contains');
    expect(await screen.findByText('Matches 3 transactions.')).toBeTruthy();
    const posted = vi.mocked(previewAlwaysAskAction).mock.calls.at(-1)?.[1] as FormData;
    expect([posted.get('pattern'), posted.get('matchType')]).toEqual(['E-TRANSFER', 'contains']);
  });

  it('counts again after the text or the match type changes', async () => {
    render(<TransactionsClient page={etransfer()} {...base} />);
    openAsk();
    fireEvent.change(screen.getByLabelText('Text to match'), { target: { value: 'E-TRANSFER ***AB1' } });
    fireEvent.change(screen.getByLabelText('Match'), { target: { value: 'exact' } });
    await waitFor(() => {
      const posted = vi.mocked(previewAlwaysAskAction).mock.calls.at(-1)?.[1] as FormData;
      expect([posted.get('pattern'), posted.get('matchType')]).toEqual(['E-TRANSFER ***AB1', 'exact']);
    });
  });

  it('after saving, offers Send N back to review for the saved rule', async () => {
    vi.mocked(setAlwaysAskAction).mockResolvedValue({ message: 'Rows matching "E-TRANSFER" will always be asked about.', ruleId: 41, sendBackCount: 2 });
    render(<TransactionsClient page={etransfer()} {...base} />);
    openAsk();
    fireEvent.click(screen.getByRole('button', { name: 'Always ask' }));
    expect(await screen.findByText('Rows matching "E-TRANSFER" will always be asked about.')).toBeTruthy();
    expect(screen.getByText('2 of them were filed by a rule or a guess.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 back to review' }));
    await waitFor(() => expect(sendBackToReviewAction).toHaveBeenCalled());
    expect((vi.mocked(sendBackToReviewAction).mock.calls[0]?.[1] as FormData).get('ruleId')).toBe('41');
  });

  it('after saving with nothing to send back, offers only Done', async () => {
    vi.mocked(setAlwaysAskAction).mockResolvedValue({ message: 'Rows matching "E-TRANSFER" will always be asked about.', ruleId: 41, sendBackCount: 0 });
    render(<TransactionsClient page={etransfer()} {...base} />);
    openAsk();
    fireEvent.click(screen.getByRole('button', { name: 'Always ask' }));
    expect(await screen.findByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /back to review/ })).toBeNull();
  });
});
```

Fails before / passes after: the menu item, the prop and the dialog do not exist until Step 6.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx`
Expected: FAIL in the new describes only.

- [ ] **Step 4: The actions**

`actions.ts`: import `alwaysAskMatchCount, alwaysAskSendBackIds, sendAlwaysAskRowsToReview, ALWAYS_ASK_NO_RULE` from `@/lib/categorize/engine` and `alwaysAskRuleFor, listRules, setAlwaysAskRule` from `@/lib/categorize/rules`. Add `AlwaysAskState` beside `ActionState`. Hoist `RULES_ARE_HOUSEHOLD_WIDE` and use it in `previewRowRuleAction`/`createRulesFromRowAction` too. New zod field `alwaysAskFields = z.object({ pattern: z.string().max(200), matchType: z.enum(['contains', 'exact']) })` (the trim/empty check is done after parse so it can say `Type the text to match.`).

Each new action, in this order: origin check; `requireUser()`; `isSelfScoped` refusal; parse (`Invalid request.` on failure).
- `previewAlwaysAskAction`: empty trimmed pattern → `{ message: 'Matches 0 transactions.' }`; else `Matches ${n} ${rowWord(n, 'transaction')}.` from `alwaysAskMatchCount`.
- `setAlwaysAskAction`: empty → `Type the text to match.`; `setAlwaysAskRule({ pattern, matchType, userId: user.id, actorRole: user.role })`; a refusal → `ruleOwnedError(ownerName)`; then `revalidatePath('/transactions')`, `revalidatePath('/settings/merchant-rules')`; return `{ message: \`Rows matching "${stored}" will always be asked about.\`, ruleId, sendBackCount: alwaysAskSendBackIds(ruleId).length }`, where `stored` is `pattern.trim().toUpperCase()`.
- `sendBackToReviewAction`: `z.object({ ruleId: z.coerce.number().int().positive() })`; the rule must be in `listRules('always_ask')` with `disabledAt === null`, else `That Always ask rule is no longer on.`; `sendAlwaysAskRowsToReview({ ruleId })`; `revalidatePath` `/transactions`, `/budgets`, `/dashboard`; `Sent ${sent} ${rowWord(sent, 'transaction')} back to review.`

The note: a new local `alwaysAskNoRuleNote(merchants: readonly string[], ruleAsked: boolean): string` returning `` ` ${ALWAYS_ASK_NO_RULE}` `` when `ruleAsked` and any merchant has `alwaysAskRuleFor(...) !== null` (read `listRules('always_ask')` once), else `''`. Append it, after the archived note, in:
- `setCategoryAction` (teach=1): merchant from the `getTransaction` row it already fetches (keep that result in a variable);
- `acceptGuessAction`: `row.normalizedMerchant`;
- `applyToAllMatchingAction`: `normalizedMerchant`; its success message becomes `Applied to ${result.count} transactions.${note}` whenever either note applies (the archived branch's shape), and keeps `… and created a rule.` otherwise;
- `bulkCategorizeAction` (createRules on): `merchantsOfTransactions(ids)`;
- `bulkRecategorizeGroupAction` (createRules on): `merchantsOfTransactions` over the ids it already resolved for the group;
- `createRulesFromRowAction` (category given): push `ALWAYS_ASK_NO_RULE` onto `parts` when it applies.

Docblocks: one line each naming spec 2026-10-21 §2.1, and on `sendBackToReviewAction` that it is keyed by rule id and recomputes the rows on the server.

- [ ] **Step 5: The page and the authoring guard**

`page.tsx`: after the `recurringMarks` block,

```ts
  /** Spec 2026-10-21 §2.1. Merchants on this page an enabled Always ask rule already covers -- the row menu offers it only to the rest. */
  const alwaysAskMerchants: string[] = [];
  {
    const rules = listRules('always_ask');
    if (rules.length > 0) {
      for (const merchant of new Set(page.rows.map((row) => row.normalizedMerchant))) {
        if (alwaysAskRuleFor(merchant, rules) !== null) alwaysAskMerchants.push(merchant);
      }
    }
  }
```

and pass `alwaysAskMerchants={alwaysAskMerchants}`.

`tests/ops/rule-authoring-intent.test.ts`, `ALLOWED_AUTHORS`, the `src/app/(app)/transactions/actions.ts` reason becomes:

```ts
      'Spec 2026-10-05 §2.2 and 2026-10-21 §2.1. setRecurringMarkAction and bulkRecurringMarkAction reach ' +
        'setRecurringMarks only, and setAlwaysAskAction reaches setAlwaysAskRule only. "Mark recurring", "Not recurring" ' +
        'and "Always ask for rows like this" are statements about a MERCHANT -- each control names the text it is about, ' +
        'and no category, flag or link on the row changes.',
```

- [ ] **Step 6: The menu item and the dialog**

`transactions-client.tsx`:
- Import `alwaysAskPattern` from `@/lib/categorize/normalize`, `startTransition` from `react`, the three actions and `type AlwaysAskState` from `./actions`.
- Prop `alwaysAskMerchants = []` with a one-line doc comment (spec 2026-10-21 §2.1, keyed by normalizedMerchant, from page.tsx).
- State: `const [askRow, setAskRow] = useState<{ id: number; pattern: string; matchType: 'contains' | 'exact'; saved: boolean } | null>(null);` plus `useActionState` for each of the three actions (`askPreviewState`, `askSaveState` typed `AlwaysAskState`, `sendBackState`), kept apart for the reason `rulePreviewState`/`ruleCreateState` are.
- Menu item, directly after "Create a rule…", under the same `row.isTransfer || selfScoped` gate plus `alwaysAskMerchants.includes(row.normalizedMerchant)`: `<RowMenuButton onSelect={() => setAskRow({ id: row.id, pattern: alwaysAskPattern(row.normalizedMerchant), matchType: 'contains', saved: false })}>Always ask for rows like this…</RowMenuButton>`, with a comment carrying the spec reference and why it is hidden (decision 6).
- Live count: a `useEffect` on `[askRow?.id, askRow?.pattern, askRow?.matchType]` that, while `askRow` is set and not `saved`, sets a 300 ms timer which builds a FormData (`pattern`, `matchType`) and calls `startTransition(() => askPreview(formData))`; the cleanup clears the timer.
- `saved` flips to true in a `useEffect` on `askSaveState` when it carries a `ruleId` and no error (the same success-only idiom as `ruleCreateState`); `askRow` closes in a `useEffect` on `sendBackState` when it carries a message and no error.
- `alwaysAskDialog()` beside `ruleDialog()`, rendered where the other dialogs render: `RowDialog dialogId="always-ask-dialog" key={askRow.id} title="Always ask for rows like this"`. Before saving: the intro `<p className="text-sm text-muted">`, `<FormError message={askSaveState.error ?? askPreviewState.error} />`, a form (`action={askSave}`, `data-testid="always-ask-form"`) holding a `Field` "Text to match" (controlled input `name="pattern"`, `inputClass`) and a `Field` "Match" (controlled select `name="matchType"`, `selectClass`, options Contains/Exact), the count as `<p role="status" className="text-sm text-ink" data-testid="always-ask-count">{askPreviewState.message}</p>`, and Cancel (`buttonClass('ghost', 'sm')`) plus `<SubmitButton size="sm" className="w-fit">Always ask</SubmitButton>`. After saving: the saved message, and when `sendBackCount > 0` the offer sentence and a form (`action={sendBack}`, hidden `ruleId`) with `<SubmitButton size="sm" className="w-fit">{`Send ${n} back to review`}</SubmitButton>`; always a Done button (`buttonClass('secondary', 'sm')`) that closes the dialog.
- Banner: add `sendBackState.message` / `sendBackState.error` to the end of the `notice` and `error` chains.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx tests/app/transactions-page.test.tsx tests/ops/rule-authoring-intent.test.ts tests/ops/server-action-origin.test.ts tests/ops/use-server-exports.test.ts tests/ops/client-bundle.test.ts tests/ops/row-controls.test.ts tests/ops/button-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/transactions/actions.ts" "src/app/(app)/transactions/page.tsx" "src/app/(app)/transactions/transactions-client.tsx" tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx tests/ops/rule-authoring-intent.test.ts
git commit -m "feat(transactions): Always ask for rows like this

- row menu dialog prefilled without the masked code, live match count
- offers to send rule- and guess-filed rows back to review
- teaching paths say when no rule was saved"
```

### Task 5: The Rules page lists Always ask (spec §2.1 Where it is set)

**Files:**
- Modify: `src/app/(app)/settings/merchant-rules/page.tsx` (`KINDS`, `kindCounts`)
- Modify: `src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx` (the `mark-kinds` import; `KIND_LABEL`; the kind chips; the two `isRecurringMarkKind` gates on Edit and Apply now; `deleteRuleDialog`; the PageGuide's first paragraph)
- Test: `tests/app/merchant-rules-client.test.tsx`

**Interfaces:**
- Consumes: Task 1's `isMerchantMarkKind` (from `@/lib/categorize/mark-kinds`, client-safe).
- Produces: nothing new.

- [ ] **Step 1: Bring the test fixtures up to the widened kind, then write the failing tests**

In `tests/app/merchant-rules-client.test.tsx`, every `kindCounts` literal gains `always_ask: 0` directly after its `not_recurring` entry (17 lines; `grep -n "not_recurring: [0-9]" tests/app/merchant-rules-client.test.tsx` lists them, and afterwards `grep -c "always_ask:" tests/app/merchant-rules-client.test.tsx` reports 17). This is the tsc half of Task 1's transient break; no assertion changes.

Append:

```ts
/** Spec 2026-10-21 §2.1. Listed, filtered, disabled and deleted here; set from a Transactions row. */
describe('MerchantRulesClient — Always ask', () => {
  it('has its own chip with a count, and a label on the row', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'always_ask', categoryId: null })],
          kindCounts: { category: 0, transfer: 0, rename: 0, not_transfer: 0, attribution: 0, recurring: 0, not_recurring: 0, always_ask: 1 },
        })}
      />,
    );
    expect(screen.getByText('Always ask (1)').closest('a')!.getAttribute('href')).toContain('kind=always_ask');
    // The chip reads "Always ask (1)", so an exact match finds the row's kind badge alone.
    expect(screen.getByText('Always ask')).toBeTruthy();
  });

  it('offers Disable and Delete rule, and neither Edit nor Apply now nor a clear', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'always_ask', categoryId: null })], impactCounts: { 1: 3 } })} />);
    openRowMenu('Actions for E-TRANSFER');
    expect(screen.getByRole('menuitem', { name: 'Disable' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete rule' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /apply now/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete rule and clear from transactions' })).toBeNull();
  });

  it('says what deleting it does', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'always_ask', categoryId: null })] })} />);
    openRowMenu('Actions for E-TRANSFER');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain('Rules and guesses can file these rows again from the next import or re-run.');
    expect(text).not.toContain('A recurring mark changes no transaction.');
  });
});
```

Fails before / passes after: no `always_ask` chip, label or delete sentence exists, and Edit/Apply now are offered, until Step 3. The "no clear" assertion is a pin (that item is offered only to category and transfer rules).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/app/merchant-rules-client.test.tsx`
Expected: FAIL in the new describe only.

- [ ] **Step 3: The page and the client**

`page.tsx`: append `'always_ask'` to `KINDS` and `always_ask: 0` to the `kindCounts` literal.

`merchant-rules-client.tsx`:
- import `isMerchantMarkKind` beside `isRecurringMarkKind` from `@/lib/categorize/mark-kinds`;
- `KIND_LABEL`: `always_ask: 'Always ask',` under a comment `// Spec 2026-10-21 §2.1: set from a Transactions row, not from the form below.`;
- a chip `{kindChip(KIND_LABEL.always_ask, 'always_ask', kindCounts.always_ask)}` after the `not_recurring` chip;
- the Edit gate and the Apply-now gate in the row menu: `isRecurringMarkKind(rule.ruleKind)` → `isMerchantMarkKind(rule.ruleKind)`;
- `deleteRuleDialog`: `const isAlwaysAsk = deletingRule.ruleKind === 'always_ask';` and, after the `isMark` paragraph, `{isAlwaysAsk ? <p className="text-sm text-ink">Rules and guesses can file these rows again from the next import or re-run.</p> : null}`;
- the PageGuide's first paragraph, after the recurring sentence: `An <strong className="font-semibold text-ink">always ask</strong> rule, set from a row on Transactions, keeps every rule and guess away from the rows it matches, so each one waits in review.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/app/merchant-rules-client.test.tsx tests/app/merchant-rules-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/merchant-rules/page.tsx" "src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx" tests/app/merchant-rules-client.test.tsx
git commit -m "feat(rules): list Always ask rules on the Rules page

- Always ask chip, label and delete sentence
- no Edit or Apply now for a merchant mark"
```

### Task 6: Budgets — the "Not categorized yet" card and the header line (spec §2.2)

**Files:**
- Modify: `src/components/ui/MetricCard.tsx` (new `tone` prop)
- Create: `src/components/UncategorizedSpendCard.tsx`
- Modify: `src/app/(app)/budgets/budgets-client.tsx` (props on `BudgetsClient`, `PersonalCard` and `BudgetSectionBody`; the household `CardHeader` title)
- Modify: `src/app/(app)/budgets/page.tsx` (two reads, two props)
- Modify: `tests/ops/contrast.test.ts` (two pins)
- Test: `tests/unit/metric-card.test.tsx`, `tests/components/uncategorized-spend-card.test.tsx` (new), `tests/app/budgets-client.test.tsx`, `tests/app/budgets-page.test.tsx`, `tests/ops/contrast.test.ts`

**Interfaces:**
- Consumes: Task 3's `UncategorizedSpend` (type-only in client files), `uncategorizedSpend`, and the `{ kind: 'uncategorized-queue' }` target; `WarningIcon` (`src/components/ui/icons.tsx`); `Pill` tone `'warning'`; `monthStart`/`monthEnd` (`src/lib/dates.ts`).
- Produces:
  - `MetricCard` gains `tone?: 'default' | 'warning'` (default `'default'`).
  - `export function UncategorizedSpendCard({ spend, href }: { spend: UncategorizedSpend | null; href: string }): React.ReactElement | null` — `null` when `spend` is null or its `count` is 0.
  - `BudgetsClient` gains `householdUncategorized?: UncategorizedSpend | null` (default `null`), and each `personal` entry gains `uncategorized?: UncategorizedSpend`.

Exact copy: title `Not categorized yet`; pill `Needs attention`; status `1 transaction` / `N transactions`; action link `Categorize`; header, when Z > 0: `Household — spent $X of $Y budgeted` then ` · $C spent in categories` then ` · $Z not categorized yet` (the last in `text-warning`); when Z is 0 the header is exactly today's.

- [ ] **Step 1: Write the failing component tests**

`tests/unit/metric-card.test.tsx`, append inside `describe('MetricCard', …)`:

```ts
  /** Spec 2026-10-21 §2.2: a card that needs attention reads differently from the cards around it. */
  it('a warning card carries the warning border and a warning icon tile; a default card neither', () => {
    const { container, unmount } = render(<MetricCard tone="warning" icon={<span>!</span>} title="Not categorized yet" value="$57.50" />);
    const article = container.querySelector('article')!;
    expect(article.className).toContain('border-warning');
    expect(article.querySelector('header > span')!.className).toContain('bg-warning-soft');
    unmount();
    const plain = render(<MetricCard icon={<span>G</span>} title="Groceries" value="$12.00" />).container.querySelector('article')!;
    expect(plain.className).not.toContain('border-warning');
    expect(plain.querySelector('header > span')!.className).toContain('bg-accent-soft');
  });
```

Create `tests/components/uncategorized-spend-card.test.tsx` (`// @vitest-environment jsdom`, `cleanup` after each):

```tsx
/** Spec 2026-10-21 §2.2. Budgets' first card: needs attention, never colour alone, gone at zero. */
describe('UncategorizedSpendCard', () => {
  const HREF = '/transactions?range=custom&from=2026-03-01&to=2026-03-31&review=1&queue=uncategorized&category=uncategorized&transfers=0';

  it('shows the amount, the count and Categorize, with the attention icon and the Needs attention label', () => {
    const { container } = render(<UncategorizedSpendCard spend={{ totalCents: 5750, count: 2 }} href={HREF} />);
    expect(screen.getByText('Not categorized yet')).toBeTruthy();
    expect(screen.getByTestId('needs-attention-icon')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('$57.50')).toBeTruthy();
    expect(screen.getByText('2 transactions')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Categorize' }).getAttribute('href')).toBe(HREF);
    expect(container.querySelector('article')!.className).toContain('border-warning');
  });

  it('says 1 transaction for one', () => {
    render(<UncategorizedSpendCard spend={{ totalCents: 1200, count: 1 }} href={HREF} />);
    expect(screen.getByText('1 transaction')).toBeTruthy();
  });

  it('renders nothing when nothing is uncategorized', () => {
    expect(render(<UncategorizedSpendCard spend={{ totalCents: 0, count: 0 }} href={HREF} />).container.firstChild).toBeNull();
    expect(render(<UncategorizedSpendCard spend={null} href={HREF} />).container.firstChild).toBeNull();
  });
});
```

`tests/ops/contrast.test.ts`: add to `TEXT` `['warning', 'surface', 4.5, "the Budgets header's not categorized figure"],` and to `NON_TEXT` `['warning', 'canvas', 3, 'the border of the Not categorized yet card'],` (pins — both already clear in both themes; they keep a future token change honest).

Fails before / passes after: `tone` and the card component do not exist until Steps 4–5.

- [ ] **Step 2: Write the failing Budgets tests**

`tests/app/budgets-client.test.tsx`, append (use the file's `makeRow`; the household fixtures as its existing tests pass them):

```tsx
/** Spec 2026-10-21 §2.2. First in the grid, beside the categories, never folded into one. */
describe('BudgetsClient — Not categorized yet', () => {
  const props = (over: Partial<React.ComponentProps<typeof BudgetsClient>> = {}) => ({
    month: '2026-03',
    currentUserId: 1,
    household: [makeRow()],
    householdTotals: { budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 },
    personal: [],
    ...over,
  });
  const queryOf = (href: string) => Object.fromEntries(new URLSearchParams(href.slice(href.indexOf('?') + 1)));

  it('puts the card first in the household grid, linking to the review queue for the month', () => {
    const { container } = render(<BudgetsClient {...props({ householdUncategorized: { totalCents: 5750, count: 2 } })} />);
    const cards = container.querySelectorAll('article');
    expect(cards[0]!.textContent).toContain('Not categorized yet');
    expect(cards[1]!.textContent).toContain('Groceries');
    expect(queryOf(screen.getByRole('link', { name: 'Categorize' }).getAttribute('href')!)).toEqual({
      range: 'custom', from: '2026-03-01', to: '2026-03-31', review: '1', queue: 'uncategorized', category: 'uncategorized', transfers: '0',
    });
  });

  it('the header names the money not categorized yet, and stops calling the categorized figure the total', () => {
    render(<BudgetsClient {...props({ householdUncategorized: { totalCents: 5750, count: 2 } })} />);
    const heading = screen.getByText(/Household — spent/);
    expect(heading.textContent).toContain('$50.00 spent in categories');
    expect(heading.textContent).toContain('$57.50 not categorized yet');
    expect(heading.textContent).not.toContain('total spent');
  });

  it('a person’s grid shows their own figure and links with their person', () => {
    render(
      <BudgetsClient
        {...props({ selectedPersonId: 7, personal: [{ userId: 7, name: 'Sam', rows: [makeRow()], uncategorized: { totalCents: 1200, count: 1 } }] })}
      />,
    );
    expect(screen.getByText('$12.00')).toBeTruthy();
    expect(queryOf(screen.getByRole('link', { name: 'Categorize' }).getAttribute('href')!).person).toBe('7');
  });

  it('shows nothing when nothing is uncategorized, and keeps the header as it was', () => {
    render(<BudgetsClient {...props({ householdUncategorized: { totalCents: 0, count: 0 } })} />);
    expect(screen.queryByText('Not categorized yet')).toBeNull();
    expect(screen.getByText(/Household — spent/).textContent).toContain('$50.00 total spent');
  });

  it('is not part of Edit limits, which has no cards', () => {
    render(<BudgetsClient {...props({ householdUncategorized: { totalCents: 5750, count: 2 } })} />);
    fireEvent.click(screen.getAllByRole('button', { name: /edit limits/i })[0]!);
    expect(screen.queryByText('Not categorized yet')).toBeNull();
  });
});
```

(`$50.00` is `householdTotals.totalSpentCents` 5000. If `screen.getByText(/Household — spent/)` resolves to the inner `<span>` rather than the heading, read the `CardHeader` title element's `textContent` instead — the assertion is about the whole line.)

`tests/app/budgets-page.test.tsx`, a new describe with its own seeded db, an explicit month and no real-clock dates:

```tsx
/** Spec 2026-10-21 §2.2, against the real page and a seeded database. */
describe('BudgetsPage — Not categorized yet', () => {
  let t: TestDb | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  function seed() {
    t = createSeededTestDb();
    const db = t.db;
    const adultId = insertTestUser(db, { name: 'Adult', username: 'adult', role: 'admin' });
    const kidId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    insertTestAccount(db, { name: 'Chequing', ownerUserId: adultId });
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 50000 });
    const add = (amountCents: number, over: { categoryId?: number | null; attributedUserId?: number | null; isTransfer?: boolean } = {}) =>
      db.get<{ id: number }>(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
        values ((select id from accounts limit 1), '2026-03-12', 'X', 'X', ${amountCents}, ${over.categoryId ?? null}, 'none', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${adultId}, ${nowIso()}, ${nowIso()})
        returning id`).id;
    return { db, adultId, kidId, groceries, add };
  }

  it('shows uncategorized spending for the month on the household grid and in the header', async () => {
    const { adultId, groceries, add } = seed();
    add(-4500, { attributedUserId: adultId });
    add(-1250);
    add(-3000, { categoryId: groceries });
    add(-9900, { isTransfer: true });
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.getByText('Not categorized yet')).toBeTruthy();
    expect(screen.getByText('2 transactions')).toBeTruthy();
    expect(container.textContent).toContain('$57.50 not categorized yet');
  });

  it('leaves out a split row', async () => {
    const { adultId, groceries, add } = seed();
    const split = add(-6000);
    t!.sqlite.prepare('insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(split, groceries, -4000, nowIso(), split, groceries, -2000, nowIso());
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.queryByText('Not categorized yet')).toBeNull();
  });

  it('a self viewer sees only their own uncategorized spending', async () => {
    const { adultId, kidId, add } = seed();
    add(-1000, { attributedUserId: kidId });
    add(-2000, { attributedUserId: adultId });
    currentUser.value = { id: kidId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    const { container } = render(await BudgetsPage({ searchParams: Promise.resolve({ month: '2026-03' }) }));
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(container.textContent).not.toContain('$30.00');
    expect(container.textContent).not.toContain('$20.00');
  });
});
```

Fails before / passes after: `householdUncategorized`, the per-person figure, the page's reads and the card do not exist until Steps 5–7.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/metric-card.test.tsx tests/components/uncategorized-spend-card.test.tsx tests/app/budgets-client.test.tsx tests/app/budgets-page.test.tsx tests/ops/contrast.test.ts`
Expected: FAIL in the new tests only; the two contrast pins pass.

- [ ] **Step 4: `MetricCard` tone**

Add `tone = 'default'` to the props (`/** Spec 2026-10-21 §2.2. 'warning' marks a card that needs attention: a warning border and a warning icon tile. The icon and the words carry the meaning too; this is never the only signal. */`). `warning` appends `border-warning` to the `<article>` class list and swaps the icon tile's `bg-accent-soft text-accent-soft-fg` for `bg-warning-soft text-warning-soft-fg`. Nothing else changes for the default.

- [ ] **Step 5: `UncategorizedSpendCard`**

Create `src/components/UncategorizedSpendCard.tsx` (no `'use client'` needed; it renders inside the client page). Returns `null` for a null spend or a zero count; otherwise `MetricCard` with `tone="warning"`, `icon={<WarningIcon className="h-5 w-5" data-testid="needs-attention-icon" />}`, `title="Not categorized yet"`, `pill={<Pill tone="warning">Needs attention</Pill>}`, `value={formatCents(spend.totalCents)}`, `status` = the count sentence, and `action={<Link href={href} className={buttonClass('ghost', 'sm', 'w-fit px-0 text-xs')}>Categorize</Link>}` (`next/link`). Import `UncategorizedSpend` with `import type` from `@/lib/budgets`. Docblock: spec 2026-10-21 §2.2 and decision 12 (why the border and tile and not a fill).

- [ ] **Step 6: The client page**

`budgets-client.tsx`:
- `import type { UncategorizedSpend }` beside the existing `@/lib/budgets` type import; import `UncategorizedSpendCard`, `transactionsHref` (`@/lib/transaction-links`) and `monthStart`, `monthEnd` (add to the existing `@/lib/dates` import).
- `BudgetSectionBody` gains `uncategorized: UncategorizedSpend | null`. In view mode only, the grid's first child is `<UncategorizedSpendCard spend={uncategorized} href={transactionsHref({ range: { from: monthStart(month), to: monthEnd(month) }, person: scope === 'personal' ? userId : null }, { kind: 'uncategorized-queue' })} />`, before the `rows.map`.
- `BudgetsClient` takes `householdUncategorized = null` and passes it to the household `BudgetSectionBody`; `PersonalCard`'s `person` type gains `uncategorized?: UncategorizedSpend`, passed as `person.uncategorized ?? null`.
- Household `CardHeader` title (the non-empty branch): when `householdUncategorized !== null && householdUncategorized.count > 0`, the muted span reads `· {formatCents(totalSpentCents)} spent in categories` and is followed by `<span className="font-normal text-warning"> · {formatCents(householdUncategorized.totalCents)} not categorized yet</span>`; otherwise the line is unchanged. A comment cites decision 10 (the figure is categorized spending only, unchanged, so the words change instead).

- [ ] **Step 7: The server page**

`page.tsx`: import `uncategorizedSpend` (and `type UncategorizedSpend` if needed) from `@/lib/budgets`. `const householdUncategorized = selfScoped ? null : uncategorizedSpend(month, { scope: 'household', attributedUserId: null }, viewer);` beside `household` (comment: ruling R2, no household figure is computed for a self viewer — the same gate as `household`). In the `personal` map add `uncategorized: uncategorizedSpend(month, { scope: 'personal', attributedUserId: person.id }, viewer)`. Pass `householdUncategorized={householdUncategorized}`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/metric-card.test.tsx tests/components/uncategorized-spend-card.test.tsx tests/app/budgets-client.test.tsx tests/app/budgets-page.test.tsx tests/app/budgets-scope.test.tsx tests/ops/contrast.test.ts tests/ops/client-bundle.test.ts tests/ops/transactions-href.test.ts tests/ops/button-vocabulary.test.ts tests/ops/visibility-invariants.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/ui/MetricCard.tsx src/components/UncategorizedSpendCard.tsx "src/app/(app)/budgets/budgets-client.tsx" "src/app/(app)/budgets/page.tsx" tests/unit/metric-card.test.tsx tests/components/uncategorized-spend-card.test.tsx tests/app/budgets-client.test.tsx tests/app/budgets-page.test.tsx tests/ops/contrast.test.ts
git commit -m "feat(budgets): Not categorized yet card and header line

- first card in each grid: amount, count, Categorize link
- warning border and tile, attention icon, Needs attention label
- header says how much is not categorized yet; card gone at zero"
```

### Task 7: Help and the release notes (spec §2.3)

**Files:**
- Modify: `src/app/(app)/help/content.tsx` (the `review` and `budgets` sections)
- Modify: `CHANGELOG.md` (`## Unreleased`)
- Test: `tests/app/help.test.tsx`, `tests/lib/changelog.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing help test**

`tests/app/help.test.tsx`, after `describe('the help page covers the features no screen advertises', …)`:

```tsx
/** Spec 2026-10-21. Both features are explained where a household looks for them. */
describe('the help page covers Always ask and uncategorized spending', () => {
  it('the Review section explains Always ask and Send back', () => {
    const text = textOf(section('review').body);
    expect(text).toMatch(/Always ask for rows like this/);
    expect(text).toMatch(/back to review/);
  });

  it('the Budgets section explains Not categorized yet', () => {
    const text = textOf(section('budgets').body);
    expect(text).toMatch(/Not categorized yet/);
    expect(text).toMatch(/Categorize/);
  });
});
```

Fails before / passes after: neither section names either feature until Step 3.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/help.test.tsx`
Expected: FAIL in the two new tests only.

- [ ] **Step 3: The help text and the notes**

`content.tsx`, `review` section — a new `<P>` after the paragraph about Apply to all and Mark as transfer:

```tsx
        <P>
          Some descriptions go to different places each time: an e-transfer to one person is rent and to
          another is a birthday present. <B>Always ask for rows like this…</B> on a row&rsquo;s menu tells the
          app never to file them on its own. No rule and no guess will categorize a matching row, choosing a
          category for one teaches nothing, and each one waits here for you. The text to match starts as the
          row&rsquo;s description without the code at the end, and the dialog says how many transactions it
          matches before you save. Rows a rule or a guess already filed can be sent back to review in the same
          step; rows you categorized yourself are never touched. An admin can turn the rule off or delete it
          under Settings &rarr; Categories &amp; rules.
        </P>
```

`budgets` section — a new `<P>` after the "Limits exist at two levels" paragraph:

```tsx
        <P>
          Spending with no category is in no category&rsquo;s figure, so a month with rows still to sort can
          look further under budget than it is. When there is some, the first card, <B>Not categorized
          yet</B>, says how much was spent and on how many transactions, and <B>Categorize</B> opens them in
          review for that month. The household line at the top says the same amount. Money coming in with no
          category is not counted there.
        </P>
```

`CHANGELOG.md`, under `## Unreleased`:

```markdown
### Added

- **Always ask for rows like this.** A row's menu on Transactions can now tell the app never to file a
  description on its own, for payments like e-transfers where the same text goes to different people for
  different reasons. Matching rows wait in review, choosing a category for one writes no rule, and the
  guesser does not learn from it. The dialog starts from the row's description without the code at the
  end, says how many transactions match, and offers to send rows a rule or a guess already filed back to
  review. These rules are listed under Settings → Categories & rules as Always ask, where an admin can
  turn one off or delete it.
- **Budgets shows spending that has no category yet.** A first card, Not categorized yet, gives the amount
  and the number of transactions, with a Categorize link that opens them in review for the month, and the
  household line at the top adds how much is not categorized yet. Category limits and figures are
  unchanged.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/app/help.test.tsx tests/lib/changelog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/help/content.tsx" CHANGELOG.md tests/app/help.test.tsx
git commit -m "docs: help and release notes for Always ask and Not categorized yet"
```

## Follow-ups (owner items 1–22, in the owner's order)

Each task is one commit. Read the named code before changing it; the line numbers are as of `133359b`.

### Task 8 (item 1): a space as a thousands separator in receipt amounts

**Files:** Modify `src/lib/warranty/suggest.ts` (`CURRENCY_RE`, `centsOf`); Test `tests/lib/warranty/suggest.test.ts`.

Today `CURRENCY_RE = /(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/g` knows only a comma as a thousands separator, so `Montant dû 1 234,56 $` reads as 234,56. `suggestPriceCents`, `amountCandidates`, `figureSpan` and `candidateLabel` all go through this one regex and `centsOf`.

- [ ] **Step 1: Failing tests** — append to `suggest.test.ts`:

```ts
/** A space, U+00A0 or U+202F groups thousands: the first group 1-3 digits, later groups exactly 3. */
describe('a space as a thousands separator', () => {
  it('reads a space-grouped French total', () => {
    expect(suggestPriceCents('Montant dû 1 234,56 $')).toBe(123456);
  });
  it('reads a no-break space and a narrow no-break space', () => {
    expect(suggestPriceCents('Montant dû 1 234,56 $')).toBe(123456);
    expect(suggestPriceCents('Montant dû 1 234,56 $')).toBe(123456);
  });
  it('reads a dot-decimal grouped figure with and without the dollar sign', () => {
    expect(suggestPriceCents('TOTAL $1 234.56')).toBe(123456);
    expect(suggestPriceCents('TOTAL 1 234.56')).toBe(123456);
  });
  it('never merges a short group or an item number into the figure', () => {
    expect(suggestPriceCents('TOTAL 12 34,50')).toBe(3450);
    expect(suggestPriceCents('TOTAL ITEM 104 4,22')).toBe(422);
    expect(suggestPriceCents('TOTAL 1234 567,89')).toBe(56789);
  });
  it('candidates carry the corrected value', () => {
    const [top] = amountCandidates('RIVERSIDE WATER\nMontant dû 1 234,56 $');
    expect(top!.valueCents).toBe(123456);
  });
});
```

Fails before: each grouped figure reads only its last group.

- [ ] **Step 2: The fix** — `CURRENCY_RE` becomes `/(?:\$\s*)?(?<!\d)(\d{1,3}(?:,\d{3})*(?:[   ]\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/g` (the `(?<!\d)` guard stops a match starting inside a longer digit run); `centsOf` strips `[   ]` from the whole part before `parseAmountToCents`. Keep the existing note on bounded quantifiers; add one line: a space-grouped figure is read whole, so `QTY 2 129.99` reads 2,129.99 — inherent to the rule.

- [ ] **Step 3:** `npx vitest run tests/lib/warranty/suggest.test.ts` → PASS. CHANGELOG `### Fixed`: `**Receipt amounts written with a space between the thousands** (such as 1 234,56 $) are read whole instead of losing the first digits.`

- [ ] **Step 4: Commit** `fix(receipts): read a space as a thousands separator` (bullets: the three separators; no merging of short groups).

### Task 9 (item 2): "Not recurring" for a merchant Known only because an item tracks it

**Files:** Modify `src/lib/recurring-view.ts` (`recurringRowActions`), `src/app/(app)/help/content.tsx` (`insights` section); Test `tests/lib/recurring-view.test.ts`, `tests/lib/recurring.test.ts`.

`recurringRowActions` returns only Mark recurring and Open item for `knownBy === 'tracked'`. `recurringCharges` already drops a `not_recurring` merchant before the tracked pass (`if (mark === 'not_recurring') continue;`), so no read-model change is needed; `setRecurringMarkAction` and `RecurringRowActions.tsx` already post and render a `not_recurring` action.

- [ ] **Step 1: Tests.** In `recurring-view.test.ts`, the existing `'Known by tracking only: Mark recurring, and the way to the item'` expectation gains the Not recurring action between Mark recurring and the Open link (rename the test `'Known by tracking only: Mark recurring, Not recurring, and the way to the item'`); add

```ts
  it('offers Not recurring on a tracked-only row in the same words as a Looks row', () => {
    expect(labels(domain)).toEqual(['Mark recurring', 'Not recurring', 'Open Lakeside Domain']);
  });
```

(use the file's `domain` fixture and its real item name). In `recurring.test.ts` add a **pin** (the read model already does it):

```ts
  it('a not_recurring mark removes a tracked merchant from every tier, and leaves the item alone', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', cents: 13400 });
    const itemId = ctx.item({ name: 'Harbour Insurance', typeId: ctx.itemType('Subscription', 'subscription'), billingCycle: 'monthly', billingAmountCents: 13400 });
    expect(read(ctx).known.map((r) => [r.merchant, r.knownBy])).toEqual([['HARBOUR INSURANCE', 'tracked']]);
    ctx.mark('HARBOUR INSURANCE', 'not_recurring');
    expect(rowsOf(read(ctx))).toEqual([]);
    expect(upcomingBills({ today: TODAY, days: 40, viewer: household(ctx.adultId) }).map((b) => b.itemId)).toContain(itemId);
  });
```

Fails before: the view helper offers no Not recurring on a tracked row.

- [ ] **Step 2: The fix.** Hoist the existing Not recurring action literal next to `mark` and return `row.tracked === null ? [mark, notRecurring] : [mark, notRecurring, openLink]` for the tracked-only branch; update the docblock. Help, `insights` section, after the sentence ending "takes it off every list and keeps it off.": `It works on a merchant a bill or a loan rule covers too, and leaves that item and its bills as they are.`

- [ ] **Step 3:** `npx vitest run tests/lib/recurring-view.test.ts tests/lib/recurring.test.ts tests/components/recurring-table.test.tsx tests/app/help.test.tsx` → PASS. CHANGELOG `### Fixed`: `**Not recurring is offered for a merchant an item covers.** On the recurring charges page, a merchant listed only because a bill or a loan rule covers it can now be taken off the lists; the item and its bills are unchanged.`

- [ ] **Step 4: Commit** `fix(insights): Not recurring for a merchant an item covers`.

### Task 10 (item 3): the receipt uploader stops a removed tile, releases files, and names its controls

**Files:** Modify `src/components/warranty/ReceiptUploader.tsx`; Test `tests/components/ReceiptUploader.test.tsx`, `tests/app/receipt-scanner.test.tsx`.

Today `poll(stagingId)` pushes a `setInterval` into `timers` and fetches with no signal; `remove()` neither clears that interval nor aborts, so a removed receipt can still fill the form; `originalsRef` keeps every `File` until removal; Try again's name is just "Try again"; the reading and scanner lines are plain `<p>`s mounted with their text.

- [ ] **Step 1: Failing tests** in `ReceiptUploader.test.tsx`, in the file's existing fake-timer style (`vi.useFakeTimers({ shouldAdvanceTime: true })`, `vi.stubGlobal('fetch', …)`, `stageResponse`, `POLL_INTERVAL_MS`):
  - `'stops polling and aborts the in-flight poll when a tile is removed'` — the poll fetch returns a never-settling promise and captures `init.signal`; after Remove (`Remove bill.pdf`), `signal.aborted` is true and advancing `POLL_INTERVAL_MS * 3` makes no further fetch call.
  - `'does not fill the form from a receipt removed while it was being read'` — remove the tile, then let the poll resolve `{ status: 'done', suggestions: { vendor: 'MAPLE GROCER' } }`; `onSuggestions` is not called.
  - `'aborts the poll and revokes the preview on unmount'` — image upload, hanging poll, `unmount()`; the captured signal is aborted and `URL.revokeObjectURL` was called with `'blob:mock-preview'`.
  - `'names Try again after its file'` — a failed poll; `screen.getByRole('button', { name: 'Try again with bill.pdf' })` exists. Change the two existing `getByRole('button', { name: 'Try again' })` look-ups to the new full name (the button is the same one; its name now carries the file).
  - `'keeps one polite live region for the reading and scanner lines'` — on first render, before any text, `screen.getByRole('status').getAttribute('aria-live')` is `'polite'`; after an upload it contains the reading message. (In `receipt-scanner.test.tsx`, with the held `scanReceiptFile` promise, the same region carries `SCANNER_PREPARING_MESSAGE`.)
  - Pin: `'gives each figure chip a name that says the figure and where it was read'` — the chips already carry `aria-label`; assert one chip's accessible name contains its formatted amount.

- [ ] **Step 2: The fix.** Replace `timers` with `pollsRef = useRef(new Map<string, { timer: ReturnType<typeof setInterval>; controller: AbortController }>())`; each poll passes `{ signal }` and, once aborted, writes nothing (no `setFiles`, no `onSuggestions`, no notice). New local `stopPolling(stagingId)` clears the interval, aborts, deletes the entry and the `readingRef` id, and clears the reading notice when nothing else is reading; `remove()` calls it (so `retry()` does too). The stage POST gets its own controller in a `uploadControllersRef` set; unmount aborts every poll and upload. A tile's `File` is deleted from `originalsRef` when its read is done (Try again is offered only on a failure). A preview URL created after unmount is revoked at once (a mounted ref). Try again gets `aria-label={`Try again with ${file.originalFilename}`}`. One always-mounted `<div role="status" aria-live="polite">` holds the reading notice, the scan note and the scanner message.

- [ ] **Step 3:** `npx vitest run tests/components/ReceiptUploader.test.tsx tests/app/receipt-scanner.test.tsx tests/app/new-warranty-client.test.tsx tests/ops/no-viewfinder.test.ts tests/ops/client-bundle.test.ts` → PASS. CHANGELOG `### Fixed`: `**Removing a receipt while it is being read stops reading it**, so it can no longer fill in the form afterwards. Try again names the file it retries, and screen readers hear the reading and scanner messages.`

- [ ] **Step 4: Commit** `fix(receipts): removed tiles stop reading; names and live region`.

### Task 11 (item 4): a marked merchant whose covering item has no bill row shows as Expected

**Files:** Modify `src/lib/recurring.ts` (`expectedRecurringCharges`; `billNeedles` goes if nothing else uses it), `src/app/(app)/dashboard/page.tsx` (pass `bills`); Test `tests/lib/recurring.test.ts`, `tests/app/dashboard.test.tsx`.

Today `expectedRecurringCharges` skips every `tracked` row and every merchant a bill-kind item names, whether or not that item has a row in the card. Decision 19.

**Interface:** `expectedRecurringCharges(input: { today: string; days: number; viewer: Viewer; bills?: readonly UpcomingBill[] }): ExpectedCharge[]` — `bills` defaults to `upcomingBills({ today, days, includeOverdue: true, viewer })` (the card's own call); the dashboard passes the `bills` it already computed. Keep `viewer: Viewer` within the signature's first 600 characters (visibility guard).

- [ ] **Step 1: Tests** in `describe('expectedRecurringCharges')`:
  - Change `'leaves out a tracked merchant, marked or not: its item already has rows of its own'` so its item has `billingCycle: 'monthly', billingAmountCents: 1349` (it then really has a row); expectation unchanged (`[]`).
  - Change `'leaves out a marked merchant a bill item covers, though the bill does not track it'` to give the bill item an unpaid installment inside the window (`addInstallment` from `@/lib/warranty/installments`); expectation unchanged.
  - New `'lists a marked merchant whose covering item has no billing amount'` — `MAPLE STREAMING` cadence (count 4, endsDaysAgo 10, cents 1349), marked, item `Maple Streaming` with no billing pair → one Expected row `{ merchant: 'MAPLE STREAMING', expectedDate: addDaysIso(TODAY, 20), typicalCents: 1349, late: false, accountName: 'Chequing' }`.
  - New `'lists a marked merchant whose bill item has nothing unpaid in the window'` — a bill item named for the merchant, no installment → listed.
  - New `'lists a marked merchant a loan payment rule covers, which never has a bill row'` — the file's loan-rule fixture (`saveLoanRule`, as the tracked-by-rule test does) → listed.
  - Dashboard: a page test that a marked merchant with a no-amount item shows its Expected row in Coming up (the file's existing Expected-row test is the pattern).

Fails before: the three new cases return `[]`.

- [ ] **Step 2: The fix.** Replace the two `continue`s with one rule: drop the row only when a bill row stands for it — `bills.some((bill) => (row.tracked !== null && bill.itemId === row.tracked.itemId) || covers(itemNeedles([{ itemId: bill.itemId, itemName: bill.name, vendor: null }])[0]!, row.merchant))` (or an equivalent local helper over the same `covers`); otherwise keep it, tracked or not. Update the docblock (decision 19).

- [ ] **Step 3:** `npx vitest run tests/lib/recurring.test.ts tests/app/dashboard.test.tsx tests/ops/visibility-invariants.test.ts` → PASS. CHANGELOG `### Fixed`: `**Coming up lists a marked recurring charge whose item has no amount.** A merchant marked recurring and covered by a bill, contract or loan that gives Coming up no row of its own now shows its Expected row.`

- [ ] **Step 4: Commit** `fix(dashboard): Expected row when the covering item has no bill row`.

### Task 12 (item 5): the expected amount follows a price rise

**Files:** Modify `src/lib/recurring.ts` (`recurringCharges`' candidate loop and its price-rise pass; new local `currentAmount`); Test `tests/lib/recurring.test.ts`, `tests/app/insights-page.test.tsx`.

Today `typicalCents` is the median of every charge in the 1200-day window, so after a rise the Expected amount, the monthly figure and the Insights total lag for months. `creepVerdict` (src/lib/predict/anomalies.ts) returns `{ newAmountCents, baselineCents, … } | null`.

- [ ] **Step 1: Tests:**
  - `'uses the new price once a rise is found: typical, monthly and the Expected row'` — MAPLE STREAMING charges 93, 63, 33 days ago at 1349 and 3 days ago at 1599 (via `ctx.spend`), marked → the Known row has `typicalCents: 1599`, `monthlyCents: 1599`, `priceRise: { fromCents: 1349, toCents: 1599 }`, and `expected(ctx)[0].typicalCents` is 1599.
  - `'reads the median of the last three charges when no rise is found'` — eight monthly charges at 4000 then three at 4500 spread so `creepVerdict` stays null (check it in the test: rise under 5%, or the newest outside its 35-day lookback) → `typicalCents` 4500 and the Expected row carries 4500.
  - Pin: the existing `'reads a monthly rhythm from a marked merchant’s two charges, with the median of both'` still passes (two charges: the last-three median is the median of both).
  - `insights-page.test.tsx`: the summary's "about $X a month" equals the rise-adjusted figure for the first fixture above.

Fails before: `typicalCents` is the window median (1349 / 4000).

- [ ] **Step 2: The fix.** Hoist `creepStart`; compute the verdict once per merchant in the candidate loop over the charges since `creepStart`; new local `currentAmount(charges, rise): number | null` — `rise.newAmountCents` when there is one, else `medianCents` of the last three magnitudes, null for one charge. `typicalCents = currentAmount(...)`; `monthlyCents` follows through `monthlyEquivalent`; the price-rise pass reuses the stored verdict instead of calling `creepVerdict` again. Update the `typicalCents` and `ExpectedCharge.typicalCents` doc comments.

- [ ] **Step 3:** `npx vitest run tests/lib/recurring.test.ts tests/lib/recurring-view.test.ts tests/app/insights-page.test.tsx tests/app/recurring-page.test.tsx tests/ops/predict-invariants.test.ts` → PASS. CHANGELOG `### Fixed`: `**Recurring amounts follow a price rise.** Coming up's Expected amount, the recurring charges page and the Insights summary use the new price once a rise is found, otherwise the median of the last three charges.`

- [ ] **Step 4: Commit** `fix(insights): recurring amounts follow the latest price`.

### Task 13 (item 6): a lean recurring read for Coming up

**Files:** Modify `src/lib/recurring.ts`; Test `tests/lib/recurring.test.ts`.

Today `expectedRecurringCharges` runs the whole `recurringCharges` model (Looks and Forming detectors, the price-rise row field, account options and sorts) and keeps only marked rows. Decision 20.

- [ ] **Step 1: Test** — `'the lean read gives the same Expected rows as the full model'`: a household with a marked late merchant, a marked merchant inside the window, a marked merchant with a no-amount item (Task 11), a marked merchant with a bill row, a Looks-only merchant, a `not_recurring` merchant and a rising price (Task 12); build the expectation from `read(ctx).known` with the same filters (`knownBy === 'mark'`, the bill-row rule, the window, `nextExpected`/`typicalCents` present) mapped to `ExpectedCharge` and sorted the same way, and assert `expected(ctx)` `toEqual`s it. This is a **pin** of behaviour: it passes before and after; the refactor must keep it green.

- [ ] **Step 2: The refactor.** Move the per-merchant candidate pass (marks, charges, rhythm, `currentAmount`, the tracked pass, `nextExpected`, `late`) into one non-exported `buildCandidates(input: { today: string; scope: number | null; marksOnly: boolean })`; `marksOnly` skips any merchant whose mark is not `'recurring'` before the Looks/Forming detectors. `recurringCharges` calls it with `marksOnly: false` and adds tiers, `priceRise`, accounts and sorts as now; `expectedRecurringCharges` calls it with `marksOnly: true`. No exported signature changes.

- [ ] **Step 3:** `npx vitest run tests/lib/recurring.test.ts tests/app/dashboard.test.tsx tests/app/recurring-page.test.tsx tests/ops/visibility-invariants.test.ts` → PASS. No CHANGELOG line (no visible change).

- [ ] **Step 4: Commit** `refactor(recurring): lean read for Coming up on the same core`.

### Task 14 (item 7): an item name matches a merchant by whole words

**Files:** Modify `src/lib/recurring.ts` (`covers`, new local `wordsOf` and `containsWords`); Test `tests/lib/recurring.test.ts`.

Today `covers` is `merchant.includes(needle)` (and, for items, the reverse too), so an item named "Phone" tracks `PHONEMART`. A loan payment rule's needle must stay a plain substring: it mirrors `applyPaymentMatchers` (src/lib/loans.ts), which matches with `includes`.

- [ ] **Step 1: Tests:**
  - `'a short item name does not cover a longer word that merely contains it'` — item `Phone`, cadence `PHONEMART` → `tracked` null.
  - `'a whole-word prefix still covers: Riverside Water against RIVERSIDE WATER UTIL'` — tracked `{ kind: 'item', itemId, itemName: 'Riverside Water' }`.
  - `'matches through punctuation: vendor Netflix covers NETFLIX.COM'`.
  - Pin: `'a loan payment rule still matches by plain substring'` — rule `PHONE` against `PHONEMART` stays tracked.
  - The existing exact and prefix pins (`'an item whose name or vendor matches the merchant counts, …'`, the name-equals cases) stay green.

- [ ] **Step 2: The fix.** `wordsOf(text)` = uppercase, `[^A-Z0-9]+` → space, trim, split; `containsWords(haystack, needle)` = needle's words appear as a contiguous run in haystack's. In `covers`, a rule needle keeps `merchant.includes(needle)`; an item needle (`bidirectional`) is `containsWords(merchant, needle) || containsWords(needle, merchant)`. `MIN_NEEDLE_CHARS` still applies.

- [ ] **Step 3:** `npx vitest run tests/lib/recurring.test.ts tests/app/recurring-page.test.tsx` → PASS. CHANGELOG `### Fixed`: `**An item only tracks a merchant whose name contains its words.** An item named Phone no longer claims a shop called PHONEMART; Riverside Water still matches RIVERSIDE WATER UTIL.`

- [ ] **Step 4: Commit** `fix(recurring): match item names to merchants by whole words`.

### Task 15 (item 8): bulk Mark recurring skips merchants already marked that way

**Files:** Modify `src/lib/categorize/rules.ts` (`setRecurringMarks`), `src/app/(app)/transactions/actions.ts` (`setRecurringMarkAction`, `bulkRecurringMarkAction`); Test `tests/lib/categorize/rules.test.ts`, `tests/app/transactions-actions.test.ts`.

Today a member marking several merchants is refused (and the batch rolled back) when one already carries the same mark owned by another member, because `upsertRuleFromCorrection` refuses to overwrite it. Decision 21.

- [ ] **Step 1: Tests.** In `rules.test.ts`, rewrite the v1.54.0-plan test `'rolls back every merchant when the mark itself belongs to somebody else'` as `'skips a merchant already marked that way by somebody else, and counts only the changed'`: Alice marks CEDAR PHONE CO; the member marks RIVERSIDE GYM and CEDAR PHONE CO → `{ ok: true, merchants: 1 }`, patterns `['CEDAR PHONE CO', 'RIVERSIDE GYM']`, CEDAR still created by Alice. Add `'still rolls back when a disabled mark of somebody else would have to be rewritten'` (Alice's mark disabled → the member's call returns `owned_by_another` 'Alice' and writes nothing), `'counts zero when every merchant already matches'`, and `'a contains rule that resolves to the same mark counts as already marked'`. The opposite-mark refusal tests stay as they are. In `transactions-actions.test.ts`: `'skips a merchant another member already marked and marks the rest'` (message `Marked 1 merchant as recurring.`) and `'says everything is already marked rather than that there is no merchant'` (message `Already marked as recurring.`).

- [ ] **Step 2: The fix.** In `setRecurringMarks`, after normalising, `const rules = listRecurringMarkRules(); const pending = input.mark === null ? merchants : merchants.filter((m) => recurringMarkFor(m, rules) !== input.mark);` — use `pending` in the ownership check and the write loop; return `{ ok: true, merchants: pending.length }`. The actions check for an empty merchant list BEFORE calling (keeping their "no merchant" errors), and when the call changed nothing say `Already marked as recurring.` / `Already marked as not recurring.` (`clear` keeps its messages).

- [ ] **Step 3:** `npx vitest run tests/lib/categorize/rules.test.ts tests/app/transactions-actions.test.ts tests/ops/rule-authoring-intent.test.ts` → PASS. CHANGELOG `### Fixed`: `**Mark recurring on a selection skips merchants already marked.** A member no longer gets a refusal because another member had already marked one of the merchants, and the message counts only the merchants that changed.`

- [ ] **Step 4: Commit** `fix(transactions): bulk mark skips merchants already marked`.

### Task 16 (item 9): the payoff projection posts on the loan's own day

**Files:** Modify `src/lib/loans/ledger.ts` (new `postingDateInMonth`), `src/lib/loans.ts` (`payoffProjection`); Test `tests/lib/loans/ledger-charge.test.ts` (or the ledger's own test file), `tests/lib/loans/payoff-interest.test.ts`.

Today the interest-aware branch of `payoffProjection` simulates periods from the 1st to the 1st (`addMonths(thisMonth, n) + '-01'`) and never reads `posting_day`. Decision 18.

- [ ] **Step 1: Tests.** Pure: `postingDateInMonth('2026-02', 31)` → `'2026-02-28'`, `('2026-03', 31)` → `'2026-03-31'`, `('2026-07', 20)` → `'2026-07-20'`. In `payoff-interest.test.ts` (its fake clock as it is): an explicit `posting_day = 1` gives the file's existing pin (`'2029-05'`); a loan with `posting_day` NULL and purchase date on the 20th projects exactly what the same loan with `posting_day = 20` projects; and one case where a recorded day changes the period lengths (`posting_day = 31` against 1, values derived by running the simulation once and written in as literals with a comment saying how).

- [ ] **Step 2: The fix.** `postingDateInMonth(month: string, day: number): string` wraps the private `clampedDate` (pure, no clock, no db). `payoffProjection` selects `purchaseDate` and `postingDay`, `const day = postingDayFor(item.purchaseDate, item.postingDay)`, and its period bounds become `postingDateInMonth(addMonths(thisMonth, elapsed - 1), day)` / `postingDateInMonth(addMonths(thisMonth, elapsed), day)`. `projectedPayoffMonth` is unchanged.

- [ ] **Step 3:** `npx vitest run tests/lib/loans/payoff-interest.test.ts tests/lib/loan-payoff.test.ts tests/lib/loans tests/ops/loan-invariants.test.ts` → PASS. CHANGELOG `### Fixed`: `**A loan's payoff estimate uses the day its interest posts**, instead of assuming the 1st of each month.`

- [ ] **Step 4: Commit** `fix(loans): payoff projection uses the loan's posting day`.

### Task 17 (item 10): import dates in the household's time zone

**Files:** Modify `src/lib/dates.ts` (new `localDateOf`, `localDateTimeOf`), `src/lib/import/freshness.ts` (`latestImportIso`), `src/lib/notify/evaluate/stale.ts` (`evaluateStaleImport`), `src/components/ImportHistoryCard.tsx` (new `tz` prop), `src/app/(app)/import/batch-client.tsx` and `src/app/(app)/import/page.tsx` (pass it); Test `tests/lib/dates.test.ts`, `tests/lib/import/freshness.test.ts`, `tests/lib/notify/evaluate/stale.test.ts`, `tests/components/import-history-card.test.tsx`, `tests/lib/notify/evaluate/digest.test.ts`.

Today all three slice the UTC timestamp: `stale.ts` `row.newest.slice(0, 10)` against a local `today`, `latestImportIso` `newest.slice(0, 10)`, and the card `row.createdAt.slice(0, 16).replace('T', ' ')`.

**Interfaces:** `localDateOf(isoInstant: string, tz?: string): string` (`todayIso(new Date(isoInstant), tz)`); `localDateTimeOf(isoInstant: string, tz?: string): string` → `YYYY-MM-DD HH:mm` (24-hour, `Intl.DateTimeFormat('en-CA', …)` as `src/lib/notify/raise.ts` builds its stamp); `latestImportIso(viewer: Viewer, tz: string = readTz()): string | null` (import `readTz` from `@/lib/env-tz`; the default is on `tz`, never on `viewer`); `ImportHistoryCard` gains `tz: string`.

- [ ] **Step 1: Tests** (2026-03-10T03:30:00Z is 2026-03-09 23:30 in America/Toronto, the suite's zone):
  - `dates.test.ts`: `localDateOf('2026-03-10T03:30:00.000Z', 'America/Toronto')` → `'2026-03-09'`, with `'UTC'` → `'2026-03-10'`; `localDateTimeOf(…, 'America/Toronto')` → `'2026-03-09 23:30'`.
  - `freshness.test.ts`: `'reads the household date of an import made after 20:00 local time'` — `latestImportIso(HOUSEHOLD_VIEWER)` → `'2026-03-09'`; and `'2026-11-02T04:30:00.000Z'` → `'2026-11-01'`.
  - `stale.test.ts`: `'counts the days from the household date'` — an import at `'2026-08-09T03:30:00.000Z'`, `now: new Date('2026-08-29T15:00:00Z')`, `tz: 'America/Toronto'`, three weeks → fires (21 days from 2026-08-08), and the outbox body names `2026-08-08`.
  - `import-history-card.test.tsx`: the When cell reads `'2026-03-09 23:30'` with `tz="America/Toronto"` and `'2026-03-10 03:30'` with `tz="UTC"`; existing renders pass `tz`.
  - `digest.test.ts`: the weekly digest's first line is `Last import 2026-03-09.` for that import.

- [ ] **Step 2: The fix** as in Interfaces; `stale.ts` uses `localDateOf(row.newest, input.tz)`; the import page passes `readEnv().tz` into `BatchClient`, which hands it to `ImportHistoryCard`.

- [ ] **Step 3:** `npx vitest run` on the five test files plus `tests/app/import-batch.test.tsx tests/ops/visibility-invariants.test.ts tests/ops/client-bundle.test.ts tests/ops/no-utc-date-slice.test.ts` → PASS. CHANGELOG `### Fixed`: `**Import dates follow the household's time zone.** An evening import no longer shows as the next day in the import history, the digest's Last import line, or the reminder that imports have gone quiet.`

- [ ] **Step 4: Commit** `fix(import): import dates in the household time zone`.

### Task 18 (item 11): an empty end-of-line item ends the PDF line

**Files:** Modify `src/lib/warranty/ocr/pdf.ts` (`linesFromItems`); Test `tests/lib/warranty/ocr/pdf.test.ts`.

Today blank items are filtered out before line assembly, taking their `hasEOL` with them, and a forced break needs the stream-next item; pdf.js often emits the end of a line as a separate `{ str: '', hasEOL: true }` item.

- [ ] **Step 1: Tests** in `describe('linesFromItems (pure)')`:

```ts
  it('ends the line at an empty item with hasEOL, in stream order', () => {
    expect(linesFromItems([
      { str: 'A', x: 0, y: 100, height: 10, hasEOL: false },
      { str: '', x: 10, y: 100, height: 10, hasEOL: true },
      { str: 'B', x: 50, y: 100, height: 10, hasEOL: false },
    ])).toEqual(['A', 'B']);
  });
  it('an empty item without hasEOL does not split a line', () => {
    expect(linesFromItems([
      { str: 'A', x: 0, y: 100, height: 10, hasEOL: false },
      { str: '', x: 10, y: 100, height: 10, hasEOL: false },
      { str: 'B', x: 50, y: 100, height: 10, hasEOL: false },
    ])).toEqual(['A B']);
  });
  it('an empty end-of-line item at the end adds no blank line', () => {
    expect(linesFromItems([
      { str: 'A', x: 0, y: 100, height: 10, hasEOL: false },
      { str: '', x: 10, y: 100, height: 10, hasEOL: true },
    ])).toEqual(['A']);
  });
```

- [ ] **Step 2: The fix.** Before filtering, record for every `hasEOL` item (blank or not) the stream index of the next non-blank item as `breakBefore`; after filtering, a kept item starts a new line when its own stream index is in `breakBefore` and the item before it in the assembly is its stream predecessor among kept items. Blank items still stay out of `heights` and the output. Existing column and same-height tests stay green.

- [ ] **Step 3:** `npx vitest run tests/lib/warranty/ocr/pdf.test.ts tests/ops/ocr-egress.test.ts` → PASS. CHANGELOG `### Fixed`: `**An e-bill PDF keeps its line breaks** where the file marks the end of a line with an empty piece of text.`

- [ ] **Step 4: Commit** `fix(receipts): an empty end-of-line item ends the PDF line`.

Item 12 (Tesseract orientation) has no task: decision 16.

### Task 19 (item 13): the receipt card says where reading happens, truthfully from a phone

**Files:** Modify `src/app/(app)/warranties/new/new-warranty-client.tsx` (the Receipt `CardHeader`), `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (its receipts card description); Test `tests/app/new-warranty-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`.

Today the add card says `Reading happens on this machine — nothing leaves your network.` and the item page says `Photos and PDFs are stored on this machine and read offline.`; from a phone, "this machine" is the phone. Help already says reading happens on your own server.

- [ ] **Step 1: Tests.** In `'says reading stays inside the network rather than that nothing is uploaded'`, the expected sentence becomes `Photograph it or attach a PDF. Read on your Budget Tracker server. Nothing leaves your network.` and the test also asserts `not.toContain('on this machine')`; in `warranty-detail-client.test.tsx` assert the receipts card reads `Photos and PDFs are stored on your Budget Tracker server and read there, offline.`
- [ ] **Step 2:** change the two strings to exactly those.
- [ ] **Step 3:** `npx vitest run tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/help.test.tsx` → PASS. CHANGELOG `### Fixed`: `**The receipt card says reading happens on your Budget Tracker server**, which is true from a phone as well as from the computer it runs on.`
- [ ] **Step 4: Commit** `fix(receipts): say reading happens on the server`.

### Task 20 (item 14): no Try again for a failure a retry cannot fix

**Files:** Modify `src/lib/warranty/staging.ts` (`ocrSidecarSchema`), `src/lib/warranty/ocr/queue.ts` (`runStagedJob`, `condemnCrashedJob`), `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`, `src/components/warranty/ReceiptUploader.tsx` (`PollResponse`, `StagedFile`, `fail`, the Try again condition); Test `tests/lib/warranty/ocr/queue.test.ts`, `tests/api/warranty-stage-poll.route.test.ts`, `tests/components/ReceiptUploader.test.tsx`.

Today every failed tile shows Try again. The failures that cannot change on a retry of the same file: no text found (`NO_TEXT_MESSAGE`), a scanned PDF (`ScannedPdfError` / `SCANNED_PDF_MESSAGE`), and a read condemned after repeated crashes (`OCR_CRASH_CONDEMNED_MESSAGE`). An unsupported type is refused at the stage POST and never makes a tile, so it needs nothing. The client must not match message text, and may not import `ocr/engine.ts` or `ocr/pdf.ts` (client bundle).

- [ ] **Step 1: Tests.** `queue.test.ts`: the no-text case's exact sidecar becomes `{ status: 'failed', error: NO_TEXT_MESSAGE, retryable: false }`; new: a scanned PDF → `{ status: 'failed', error: SCANNED_PDF_MESSAGE, retryable: false }`; an engine that throws `new Error('boom')` → `{ status: 'failed', error: 'boom', retryable: true }`. Route: a failed sidecar with `retryable: false` → the JSON carries `retryable: false`. Uploader: a poll answer `{ status: 'failed', error: '…', retryable: false }` shows no Try again but keeps Remove; `retryable: true` and an answer with no `retryable` both show it.
- [ ] **Step 2: The fix.** `retryable: z.boolean().optional()` on the sidecar schema; `runStagedJob` writes `false` for no text and `!(error instanceof ScannedPdfError)` in its catch; `condemnCrashedJob` writes `false`; the poll route passes `retryable` through; the uploader stores it on the tile and renders Try again only when `file.ocr === 'failed' && file.retryable !== false` (a network or HTTP failure stays retryable).
- [ ] **Step 3:** `npx vitest run tests/lib/warranty/ocr/queue.test.ts tests/api/warranty-stage-poll.route.test.ts tests/components/ReceiptUploader.test.tsx tests/lib/warranty/staging.test.ts tests/ops/client-bundle.test.ts tests/ops/ocr-egress.test.ts` → PASS. CHANGELOG `### Fixed`: `**Try again is offered only when trying again can help.** A photo with no readable text, a scanned PDF, or a read that kept stopping no longer offers a retry that would fail the same way.`
- [ ] **Step 4: Commit** `fix(receipts): hide Try again for failures a retry cannot fix`.

### Task 21 (item 15): the Add page header names each kind's own fields

**Files:** Modify `src/lib/warranty/constants.ts` (`formDescription`); Test `tests/lib/warranty/constants.test.ts`, `tests/app/new-warranty-client.test.tsx`.

Today `formDescription` has two answers, so a subscription, contract or loan is promised "the date, vendor and price", fields those kinds do not have. The kind-wording rule is already in this file: `formStartLabel(kind)` (Purchase date / Start date), `billingAllowedForKind`, `billingAmountLabelForKind(kind)` (Amount / Payment amount), `installmentsAllowedForKind`, `BILL_AMOUNT_DUE_LABEL`, `BILL_DUE_DATE_LABEL`.

- [ ] **Step 1: Tests.** Replace the constants test that expects the generic sentence for every non-bill kind with:

```ts
  it('names each kind its own date and amount field', () => {
    expect(formDescription('warranty')).toBe('Attach the receipt first and the purchase date, vendor and price fill themselves in.');
    expect(formDescription('subscription')).toBe('Attach the receipt first and the start date, vendor and amount fill themselves in.');
    expect(formDescription('contract')).toBe('Attach the receipt first and the start date, vendor and amount fill themselves in.');
    expect(formDescription('loan')).toBe('Attach the receipt first and the start date, vendor and payment amount fill themselves in.');
    expect(formDescription('bill')).toBe('Attach the bill first and the amount due and due date fill themselves in.');
  });
```

(Read the labels the helpers really return first; the expected strings are those labels lower-cased in this sentence.) In `new-warranty-client.test.tsx`: choosing the loan type puts `start date, vendor and payment amount fill themselves in.` in the header and not `vendor and price`.
- [ ] **Step 2:** `formDescription` builds the non-bill sentence from `formStartLabel(kind)`, and `billingAmountLabelForKind(kind)` when `billingAllowedForKind(kind)`, else "price"; the bill sentence is unchanged.
- [ ] **Step 3:** `npx vitest run tests/lib/warranty/constants.test.ts tests/app/new-warranty-client.test.tsx` → PASS. CHANGELOG `### Fixed`: `**The Add item header names the fields each kind really has**, such as start date and payment amount for a loan, instead of promising a price.`
- [ ] **Step 4: Commit** `fix(coverage): Add header names each kind's own fields`.

### Task 22 (item 16): one bills story in Help

**Files:** Modify `src/app/(app)/help/content.tsx` (`coverage` section, the older bill paragraph); Test `tests/app/help.test.tsx`.

The older paragraph (the section's last) still says to add the item and then enter every due date and amount on its page, and calls a bill "the one kind … rather than a repeating cycle"; the newer one (v1.53.0) says a bill takes its first amount and due date when added and that a recurring bill takes the next amount from its e-bill.

- [ ] **Step 1: Tests:** `'tells one bills story: the first amount and due date are entered when the bill is added'` — the section text contains `takes its amount and due date when you add it` and not `then enter each due date and amount`; `'defines a bill once'` — `A bill is ` occurs once.
- [ ] **Step 2:** rewrite the older paragraph's first two sentences as: `To set one up, create an item type of kind <B>Bill</B> under <B>Settings → Item types</B> (call it <B>Property tax</B>), then add the item with its <B>Amount due</B> and <B>Due date</B>. Further due dates and amounts go in the <B>Installments</B> section on the item's own page.` Keep the rest (Coming up, reminders, overdue, the matching rule, Record payment) word for word.
- [ ] **Step 3:** `npx vitest run tests/app/help.test.tsx` → PASS. CHANGELOG `### Fixed`: `**Help describes adding a bill one way**: with its amount due and due date on the add form, and later installments on its page.`
- [ ] **Step 4: Commit** `docs(help): one story for adding a bill`.

### Task 23 (item 17): the Dashboard help uses the recurring-charges wording

**Files:** Modify `src/app/(app)/help/content.tsx` (`dashboard` section); Test `tests/app/help.test.tsx`.

The Needs a look sentence says "subscriptions that went up since last time"; the card's own label is "Went up" and the notification is "A recurring charge went up". The other "subscription" uses in help name an item kind or the item-type flag and stay.

- [ ] **Step 1: Test:** `'the dashboard help uses recurring-charge wording'` — the dashboard section text has no `/subscription/i` and contains `recurring charges that went up since last time`.
- [ ] **Step 2:** `subscriptions that went up` → `recurring charges that went up`.
- [ ] **Step 3:** `npx vitest run tests/app/help.test.tsx` → PASS. CHANGELOG `### Fixed`: `**Help calls the Dashboard's price rises recurring charges**, the word the rest of the app uses.`
- [ ] **Step 4: Commit** `docs(help): recurring charges, not subscriptions, on the Dashboard`.

### Task 24 (item 18): an update check that cannot reach GitHub says why

**Files:** Create `src/lib/update/network-error.ts`; Modify `src/lib/update/github.ts` (`requestFailure`), `src/app/(app)/settings/updates-client.tsx` (one help line); Test `tests/lib/update/network-error.test.ts` (new), `tests/lib/update/github.test.ts`, `tests/lib/update/check.test.ts`, `tests/app/updates-card.test.tsx`.

Today Node's fetch rejects with `TypeError: fetch failed` and the real reason sits on `error.cause.code` (sometimes inside an `AggregateError`'s `errors`); `requestFailure` passes `error.message` through, so the card says only "fetch failed". The TimeoutError branch (`GitHub did not answer within N seconds.`) stays. MUST-10.11 (every update string goes through `scrubSecrets`) already runs in `check.ts`; never put `cause.message` in the text (it can carry addresses).

**Interface:** `network-error.ts` has no imports: `export const COULD_NOT_REACH_GITHUB = "Couldn't reach GitHub";` and `export function describeNetworkFailure(error: unknown): { reason: string; code: string } | null` — walks `error`, `error.cause`, `cause.errors?.[0]` (depth 3) for the first string `code`, or an `AbortError` name, and maps: `ENOTFOUND`, `EAI_AGAIN` → `DNS lookup failed`; `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT` → `connection timed out`; `ECONNREFUSED` → `connection refused`; `ECONNRESET`, `UND_ERR_SOCKET` → `connection was dropped`; `ENETUNREACH`, `EHOSTUNREACH` → `no route to the internet`; `CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_CERT_ALTNAME_INVALID` → `its certificate was not trusted`; `AbortError` → `the request was cancelled`; any other code → `the request failed`.

- [ ] **Step 1: Tests.** `network-error.test.ts`: `it.each` over every code above → `{ reason, code }`; an `AggregateError` carrying `code: 'ETIMEDOUT'` → `ETIMEDOUT`; a plain `Error('boom')` → null. `github.test.ts`: a `TypeError('fetch failed')` whose cause has `code: 'ENOTFOUND'` and a message holding a made-up address → the error message is exactly `Couldn't reach GitHub: DNS lookup failed (ENOTFOUND).`, contains no digits of the address, and `permanent` is false; the existing plain-message and TimeoutError tests stay. `check.test.ts`: after such a failure `readUpdateState().lastCheckError` is that sentence and `lastCheckedAt` was still stamped. `updates-card.test.tsx`: with that `lastCheckError` the card shows `Check that the server can look up api.github.com and make outbound HTTPS connections.`; with `GitHub returned 500.` it does not.
- [ ] **Step 2:** `requestFailure` keeps its TimeoutError branch, then uses `describeNetworkFailure`: a result → `` `${COULD_NOT_REACH_GITHUB}: ${reason} (${code}).` ``; none and a bare `fetch failed` message → `` `${COULD_NOT_REACH_GITHUB}: the request failed.` ``; otherwise the message as today. The card renders the help line under the check-error notice when that error starts with `COULD_NOT_REACH_GITHUB`.
- [ ] **Step 3:** `npx vitest run tests/lib/update tests/app/updates-card.test.tsx tests/ops/notify-egress.test.ts tests/ops/client-bundle.test.ts` → PASS. CHANGELOG `### Fixed`: `**An update check that cannot reach GitHub says why**, for example that the DNS lookup failed or the connection timed out, and what to check.`
- [ ] **Step 4: Commit** `fix(updates): name why GitHub could not be reached`.

### Task 25 (item 19): the Updates card shows one error, clears it on success, and never says up to date after a failure

**Files:** Modify `src/lib/update/state.ts` (new key), `src/app/(app)/settings/actions.ts` (`UpdateActionState`, `currentAvailability`), `src/app/(app)/settings/updates-card.tsx`, `src/app/(app)/settings/updates-client.tsx` (`UpdatesViewProps`, `ResolvedAvailability`, `RESOLVED_KEYS`, the error notices, the header line); Test `tests/lib/update/state.test.ts`, `tests/app/update-actions.test.ts`, `tests/app/updates-card.test.tsx`.

Today the stored `update.last_check_error` notice (from props) and the action's error (FormError) show the same failure twice; because `checkForUpdateNowAction` does not revalidate, a later successful check leaves the old notice on screen; and the header reads `Up to date (vX)` after a failed check. Decision 17 keeps the 5 s timeout and the existing "Asking GitHub…" pending button.

- [ ] **Step 1: Tests.** `state.test.ts`: a successful `recordCheckOutcome` sets `lastSuccessAt`; a later failure keeps it and moves `lastCheckedAt`; disabling checks wipes it (`WIPED_ON_DISABLE`); the full-state shape test gains the field. `update-actions.test.ts`: a failing check returns `lastCheckError` equal to its `error`; a later successful one returns `lastCheckError: null`. `updates-card.test.tsx` (its `base` props, `submit`, mocked actions): `'shows a failed check once'` (`getAllByText('GitHub returned 500.')` has length 1 after Check now fails with the same text as the stored error); `'clears the old error after a successful check'`; `'says it could not check, never up to date, after a failure'` (header contains `Could not check for updates`, `queryByText(/^Up to date/)` is null, and the line reads `Last successful check 2026-08-17 09:30` — or `No successful check yet` when none is recorded).
- [ ] **Step 2: The fix.** New settings key `update.last_success_at` (`KEY_LAST_SUCCESS_AT`) owned by `state.ts`: written in the success branch of `recordCheckOutcome`, read into `UpdateState.lastSuccessAt`, listed in `WIPED_ON_DISABLE`. `currentAvailability()` and `UpdateActionState` carry `lastCheckError` and `lastSuccessAt`; both join `ResolvedAvailability`/`RESOLVED_KEYS`; `UpdatesCard` passes `lastSuccessAt`. The client shows `resolved.lastCheckError` as the one error notice and drops the FormError when it is the same text; the header shows `Could not check for updates` while `resolved.lastCheckError` is set, with the last successful check time (or `No successful check yet`) on the status line.
- [ ] **Step 3:** `npx vitest run tests/lib/update tests/app/update-actions.test.ts tests/app/updates-card.test.tsx tests/ops/notify-egress.test.ts tests/ops/use-server-exports.test.ts tests/ops/server-action-origin.test.ts` → PASS. CHANGELOG `### Fixed`: `**The Updates card shows a failed check once and clears it after a check that works.** After a failed check it says it could not check, with the time of the last one that worked, instead of up to date.`
- [ ] **Step 4: Commit** `fix(updates): one error notice, cleared on success; no up to date after a failure`.

### Task 26 (item 20): the missing tests — the bills fold, the scan countdown, the larger preview

**Files:** Modify `src/lib/warranty/installments.ts` (new `BillSchedule`, `foldBillSchedules`), `src/app/(app)/warranties/page.tsx` (use it); Test `tests/lib/warranty/installments.test.ts`, `tests/app/receipt-scanner.test.tsx`.

- [ ] **Step 1:** Move the page's fold, unchanged, into `export interface BillSchedule { nextDueDate: string; overdueCount: number; nextAmountCents: number; unpaidCount: number; outstandingCents: number }` and `export function foldBillSchedules(rows: readonly UnpaidInstallment[], today: string): Record<number, BillSchedule>` (pure); the page calls it on the same `unpaidInstallments(...)` result (decision 22).
- [ ] **Step 2: Tests.** `installments.test.ts`: `'folds an item's unpaid installments into next amount, count, outstanding and overdue'` — rows for one item due 2026-10-01 (10000), 2026-11-01 (20000), 2026-12-01 (30000), today `2026-10-15` → `{ nextDueDate: '2026-10-01', overdueCount: 1, nextAmountCents: 10000, unpaidCount: 3, outstandingCents: 60000 }`; and `'scopes the amounts the way it scopes the dates'` — two owners' bills, `unpaidInstallments({ …, ownerUserId: alice })` then the fold → only Alice's item. `receipt-scanner.test.tsx` (its existing `scanReceiptFile` spy and fake timers): `'starts the countdown at 8 seconds and counts down once a second'` (`Using the straightened photo in 8 seconds`, then 7, then `in 1 second`), `'keeps the auto-accept at 8000 ms'` (`SCANNER_AUTO_ACCEPT_MS` is 8000, nothing staged at 7900 ms, staged by 8100 ms), and `'shows both preview images at the larger size'` (both carry `max-h-64`, neither `max-h-40`).
- [ ] **Step 3:** `npx vitest run tests/lib/warranty/installments.test.ts tests/app/receipt-scanner.test.tsx tests/app/warranties-client.test.tsx` → PASS. No CHANGELOG line.
- [ ] **Step 4: Commit** `test: bills fold, scan countdown and preview size`.

### Task 27 (item 21): pin the tests that read the real clock

**Files:** Modify `tests/app/budget-suggestions.test.ts`, `tests/app/dashboard.test.tsx`, `tests/app/budgets-page.test.tsx`, `tests/app/budgets-scope.test.tsx`, `tests/app/reports.test.tsx`, `tests/app/insights-page.test.tsx`, `tests/app/recurring-page.test.tsx`.

Each computes `today` / `month` / `prevMonth` (or a TARGET month) from the real clock at module or describe level while the page or action reads the clock again when it runs, so a run that crosses local midnight or a month end disagrees with itself (decision 23).

- [ ] **Step 1:** In each file, before any module-level date constant, `vi.useFakeTimers({ now: new Date('2026-03-18T16:00:00.000Z'), toFake: ['Date'] });` and `afterAll(() => vi.useRealTimers())`. Where a file already switches timers in a test or `afterEach` (search for `useRealTimers`/`useFakeTimers`), re-pin in `beforeEach` instead so every test runs on the pinned date. Fixtures that were computed from `today` keep being computed from it; no assertion changes.
- [ ] **Step 2:** `npx vitest run` on the seven files → PASS, unchanged assertions. List the files in the commit message.
- [ ] **Step 3: Commit** `test: pin the clock in tests that read the date` (bullets: the seven files).

### Task 28 (item 22): describe reported defects instead of quoting them

**Files:** comments and docs only, across `src/`, `tests/`, `scripts/`, `docs/` (including `docs/superpowers/plans/`, `docs/superpowers/specs/`, `docs/PENDING-FIXES.md`, `docs/superpowers/build-ledger-2026-08-16.md`). Not `docs/reviews/` (reviewers' words), not UI copy, not the app's own spec wording, not third-party quotes.

About 138 occurrences: roughly 58 in `src/` and `scripts/`, 55 in `tests/` (all in comments), 25 in `docs/`; CHANGELOG.md and README.md have none, and none sits inside a test assertion string. Find them by their cues — `the report:`, `reported:`, `(reported`, `The owner`, `the owner,`, `owner:`, `the ask:`, `asked:`, `Ask (owner` — followed by a quoted lowercase sentence, often with typos; several quotes repeat across files (the same report quoted in the engine, the transactions client, the rules files and their tests), so sweep each repeated phrase everywhere at once.

- [ ] **Step 1:** Two Sonnet implementers in sequence (one for `src/` + `scripts/`, one for `tests/` + `docs/`), each replacing every quote with a plain description of the defect or the need in the comment's own voice (e.g. a report that a charge was filed under the wrong policy becomes "two policies with one insurer were filed under whichever one was corrected last"). Keep the surrounding reasoning; change no code, no test assertion and no UI string. A quote that turns out to sit inside an assertion string is left and listed.
- [ ] **Step 2:** Re-run the cue search; it finds only the excluded kinds. `npx vitest run tests/ops` → PASS (several guards read source text).
- [ ] **Step 3: Commit** `docs: describe reported defects instead of quoting them`.

---

## The review (exactly one, after Task 28)

One Opus reviewer, given these diffs and the spec sections, asked to check the correctness of the figures and the scoping — person scope, `SPEND_ROW_WHERE`, split rows, time zone — not wording:

- Tasks 1–2: always_ask in the engine (decision 3) and every learning path (decision 4: `confirmCategory`, `createRulesFromRow`, `applyCategoryToMatching`, the six teaching actions; nothing else writes a category rule or calls `train`), Send back's row set (decision 8).
- Tasks 3 and 6: `uncategorizedSpend` and the Budgets header (decisions 9–11; Review Focus 4).
- Tasks 11, 12, 14: which marked merchants appear as Expected and with what amount; the whole-word cover rule.
- Task 16: the payoff projection's periods (decision 18).
- Task 17: every import date in the household zone (Review Focus 5).

Not reviewed: wording, help, docs, test-only tasks, the quote sweep. One fix round for Important findings, committed as `fix: review round` with bullets; re-review only a non-trivial fix.

---

### Task 29: Release v1.56.0

**Files:** Modify `tests/ops/docker.test.ts` (`'MUST-7.1: the 1.55.4 release'` and every remaining `toBe('1.55.4')`), `CHANGELOG.md`, `package.json`, `package-lock.json`.

- [ ] **Step 1: Update the release guard first.** Replace `it('MUST-7.1: the 1.55.4 release', …)` with a `1.56.0` test of the same shape (package.json, both lockfile fields, the dated heading below `## Unreleased` and above `## [1.55.4]`, Unreleased emptied), whose section checks are:

```ts
    const current = changelog.slice(changelog.indexOf('## [1.56.0]'), changelog.indexOf('## [1.55.4]'));
    expect(current).toMatch(/### Added/);
    expect(current).toMatch(/Always ask for rows like this/);
    expect(current).toMatch(/Not categorized yet/);
    expect(current).toMatch(/### Fixed/);
    expect(current).not.toMatch(/!/);
```

and add, directly after it, `it('MUST-7.1: the 1.55.4 release is still recorded intact (append-only discipline)', …)` in the shape of the existing 1.55.3 one: `## [1.55.4] - 2026-10-20` present, before `## [1.55.3]`, and the phrases the replaced 1.55.4 test asserted about its section (copy them from it). Then change every remaining `toBe('1.55.4')` to `toBe('1.56.0')`; `grep -c "toBe('1.55.4')" tests/ops/docker.test.ts` → `0`.

- [ ] **Step 2:** `npx vitest run tests/ops/docker.test.ts` → FAIL on the version pins and the missing `## [1.56.0]` heading.

- [ ] **Step 3: Date the notes and bump the version.** Insert `## [1.56.0] - <output of date +%F>` and a blank line between `## Unreleased` and the notes, so `## Unreleased` is empty again; `### Added` comes before `### Fixed`. `package.json` and both `"version"` fields near the top of `package-lock.json`: `1.55.4` → `1.56.0`. If `package-lock.json` changed anywhere beyond those two fields, verify with `npx npm@10.9.9 ci --dry-run`. Run `npx vitest run tests/ops/docker.test.ts tests/lib/changelog.test.ts` → PASS.

- [ ] **Step 4: The release gate.**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
rm -rf .next && npm run build
npm run smoke
```

Expected: vitest exit 0 (a lone `Timeout calling "onTaskUpdate"` failure in a parallel run is the known flake — rerun that file alone; the `--no-file-parallelism` run must exit 0); tsc clean; build exit 0 with the 8 known Turbopack dynamic-filesystem warnings; smoke passes with the 2 known Windows skips.

- [ ] **Step 5: Commit and push.**

```bash
git add CHANGELOG.md package.json package-lock.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.56.0

- Always ask rule kind; Not categorized yet on Budgets
- receipt, recurring, loan, time zone and update-check fixes"
git push origin main
```

- [ ] **Step 6:** `gh run list --workflow test.yml --limit 3`, then `gh run watch <id> --exit-status` → `Test suite` succeeds. Do not tag until it does; fix forward on a failure, never force-push.

- [ ] **Step 7:** Confirm the v1.55.4 `Release image` run completed with success (stop and report if it failed). Then `git tag -a v1.56.0 -m "v1.56.0" <the SHA Test suite passed on>`, `git push origin v1.56.0`, `gh run list --workflow release-image.yml --limit 3`, `gh run watch <id> --exit-status` → `Release image` for v1.56.0 succeeds. Never move or delete a tag.
