# Budget Tracker — review report for Opus

Date: 2026-09-02. Codebase at v1.29.1 (`1bbb787`). Read-only audit; nothing in the repo was changed
to produce this.

**Do not commit this file until the P0 and P1 fixes have shipped.** It is a ranked list of unpatched
authorisation holes in a public repository.

---

## 0. How this was produced, and how to work it

Four independent read-only lanes (security, data correctness, ops/robustness, UI/consistency) each
audited the tree and wrote an evidence-backed report. The controller then re-read the source for
every High and for every finding whose fix changes a design decision, and verified them independently:
S-01, S-02, S-04, S-05, C-01, C-02, O-03, O-04, and UI known item 4 were all confirmed by reading the
cited lines. Where a lane executed code to prove a finding (C-01, C-02, C-03, C-04, C-05, C-06, S-03,
S-08, the flake investigation), the input and both outputs are in the appendix.

The four full lane reports are appended verbatim (§A–§D). They carry the `file:line` evidence and the
concrete fix, including which test file and which assertion proves each one. This top section is the
ranking, the rulings, and the work order. Read a finding here, then go to its appendix entry for the
fix.

**Work order.** P0 is one release. P1 is one release. P2 and P3 can be batched however is convenient,
but nothing from P2 or P3 goes ahead of anything in P0 or P1.

**Standing constraints — every one applies to every fix:**

- No `Co-Authored-By` or any Claude attribution in commits. Commit per reviewed task; release commit
  `chore(release): vX.Y.Z`; annotated tag; push tag; confirm both GHCR runs green.
- Public repo. Never commit an owner name, employer, Windows path, or real statement data. Anonymise
  sample data at the point it enters a doc or a test.
- Never touch `.tmp-data/budget.db`. Never `git stash`. Never `git add -A`. Never override git identity.
- No `new Date()` under `src/lib/**`; use `todayIso()` (`src/lib/dates.ts`) / `nowIso()`
  (`src/lib/clock.ts`). Money is integer cents. Dates are ISO strings.
- Bearer credentials (SimpleFIN access URL, Telegram tokens, SMTP password, Watchtower token) never
  reach a log line, an error message, a notification body, a page prop, or an API response.
- One idea, one implementation. If a fix would create a second copy of an existing idea, lift the
  existing one and share it. The runway fix (v1.29.0) and the `PillNav` unification (v1.25.0) are the
  models.
- Every fix ships with a test that was shown to FAIL before the fix and PASS after. Report the failure
  message. A test that passes both ways is not evidence.
- Where a finding is an instance of a class (S-01/S-02 are one class; C-01/C-05 are one class; O-03 is a
  third instance of a class already fixed twice), the fix ships with an ops guard in `tests/ops/` that
  fails on the class, not just the instance. The guards in `tests/ops/client-bundle.test.ts`,
  `visibility-invariants.test.ts`, and `rule-authoring-intent.test.ts` are the models.
- The newest migration's own test suite owns the `Math.max(...idxs)` "I am newest" assertion. If a fix
  adds migration 0022 (C-03 does), hand it on from 0021's suite.
- `tests/ops/docker.test.ts` MUST-7.1 pins the newest release's version and changelog. Hand it on at
  each release, converting the previous newest to an "append-only discipline" check.
- Subagents run no git commands, create no worktrees, and never copy/move/delete under `node_modules`.

**Dedupe first.** `docs/PENDING-FIXES.md` (118 KB) and `docs/reviews/2026-08-27-fresh-eyes-review.md`
exist. Before starting any item below, grep both for it. If it is already tracked there with a
decision, follow the decision; if it is tracked as open, close it there when the fix lands.

---

## 1. Rulings — decisions already made

These resolve choices the lanes left open. Do not relitigate them; if one turns out to be wrong in
practice, stop and say why rather than silently picking the other branch.

**R1 — C-02, where the shared spend clause lives.** Create `src/lib/spend-where.ts` exporting one
composed `SPEND_ROW_WHERE: SQL` = *not a transfer* AND `NOT_PRINCIPAL_MOVEMENT`, plus the two parts
individually. Move `NOT_PRINCIPAL_MOVEMENT` there from `reports.ts`. `reports.ts`, `budgets.ts`
(`categorySpend`, `categorySpendWithRollupSeries`, `categoryTransactions`), `predict/history.ts`,
`tax.ts`, and `insights.ts` all compose from it. Do NOT have `budgets.ts` import `reports.ts`. Then add
an ops guard: the literal `eq(transactions.isTransfer, false)` may appear only in `spend-where.ts`.
That guard is what stops the fourth copy.

**R2 — C-05, income parent with a non-income child.** Both halves, because they answer different
questions: make `budgetProgress`'s walk tolerant (a category whose parent is absent from `all` is
treated as top-level) so existing databases render correctly with no migration, AND validate in
`createCategory`/`renameCategory` that a non-income category cannot be given an income parent, so no
new ones are made. Ship C-01 and C-05 together; they are the same function.

**R3 — C-03 and C-09, the normaliser.** One change, one migration. Add a `MULTI_WORD_CITIES` set to
`normalize.ts` (Canadian focus; the nine cities in C-03's table plus the obvious others — Saint John,
Quebec City, Thunder Bay, Richmond Hill, St Catharines, North York, Niagara Falls, Red Deer, Grande
Prairie, Fort McMurray, Prince George, Prince Albert, Medicine Hat, Sault Ste Marie, Trois-Rivières,
White Rock, Maple Ridge, Port Coquitlam, New Westminster, North Vancouver, West Vancouver, Mount Pearl,
Corner Brook, Cape Breton, Moose Jaw, Swift Current, North Bay, Owen Sound, Fort Erie, Port Colborne,
Halton Hills, Whitchurch-Stouffville, East Gwillimbury, Kawartha Lakes) and pop the longest matching
tail, defaulting to one token. Widen the bare-digit rule to strip a trailing all-digit token of 3+
digits when it is not the only token. Migration `0022_normalizer_backfill.sql` recomputes
`normalized_merchant` from `raw_description` for every row — same shape as 0016's catch-up — then boot
calls `rerunEngine()` once, flagged so it does not repeat. The 0022 test suite takes the newest-migration
assertion. Test: table-driven over the nine inputs in C-03 plus `LOBLAWS 1042 TORONTO ON` → `LOBLAWS`.

**R4 — O-07, outbox at-least-once.** Accept it. A duplicate Telegram message after a crash mid-send is
a far smaller harm than a lost budget alert, and exactly-once over SMTP is not achievable anyway.
Document the guarantee in `outbox.ts`'s docblock, stop stripping `attempts` before Recent deliveries
renders so a person can see a retry happened, and add nothing else.

**R5 — S-14, TOTP `===`.** Decline. Add a comment at `totp.ts:100-103` recording that the comparison
is otplib's, that it is not constant-time, and why that is acceptable here (6 digits, 90 s window, two
rate-limit layers, network jitter ≫ the timing signal). Do not replace `checkDelta`.

**R6 — S-08.** Fix the two IPv6 regexes (b). For (a), fix the documentation — soften `README.md:287` and
`INSTALL.md:88-89` to `.env.example`'s honest wording. Do not narrow the bare-label branch in code; an
operator-listed allowlist is a feature, not a fix, and belongs in PENDING-FIXES if wanted.

**R7 — U-02, charts.** Now: `role="img"` and a one-sentence `aria-label` computed from the data each
chart already receives, on all five components. Later (PENDING-FIXES): a visually-hidden data table per
chart, on the Month-over-month model.

**R8 — the flake.** The ops lane's diagnosis is accepted: the `[vitest-worker]: Timeout calling
"onTaskUpdate"` error is the reporter RPC starving under full parallel load, and it attributes the
loss to whichever test's update was in flight — an arbitrary single test that then passes alone. Fix
in this order, each its own commit: (1) `poolOptions.forks.maxForks` at half the cores; (2)
`--reporter=dot` in CI; (3) a test-only argon2 profile via env var read in `src/lib/auth/password.ts`,
set in `vitest.config.ts`, production constants unchanged; (4) per-worker `DATA_DIR`
(`.tmp-data/<VITEST_WORKER_ID>`); (5) the `tests/helpers/db.ts` `rmSync` try/catch and the
`backup-restore.test.ts` teardown reordering (`current = null` BEFORE `cleanup()`, restores in
`finally`); (6) freeze the clock in `reports.test.tsx`. Then, and only then, drop
`--no-file-parallelism` from `test.yml` and update `test-suite-workflow.test.ts:147` deliberately.

**R9 — O-01, the smoke test.** Build exactly what §C's "Proposed smoke test" specifies: a second job in
`test.yml` that builds, seeds, boots the standalone server, logs in, GETs all 28 pages and 8 safe API
GETs with the cookie, asserts the unauthenticated 307/401 split, asserts a nonce'd CSP header arrives
on a real response, asserts the server log has no `console.error`, and asserts SIGTERM exits 0 with the
shutdown line. Because `release-image.yml` already calls `test.yml`, this one job gates both. The
`docker run` variant against the built image is a second phase, not part of this item. Accept the
3–5 minutes.

**R10 — O-01 also puts `next build` in CI for the first time.** That is intended. Keep it.

**R11 — S-01 and S-02 fix shape.** Capture the user from `requireUser()` and resolve the target through
the viewer, exactly as `transactions/actions.ts:63-87` and `warranties/actions.ts:689-696` already do.
For S-01 specifically: `categoryTransactions()` in `budgets.ts` gains a required `viewer` parameter,
applies `ownerScope`/`isSelfScoped` the same way `budgets/page.tsx` does, and the action passes the
user through. Then teach `tests/ops/visibility-invariants.test.ts` that the function exists — the lane
ran that suite with the hole open and it passed. Update its docblock exemptions for `getWarrantyReceipt`
and `listLoanRules` so they list every caller, or remove the exemptions.

**R12 — the eleven server-only packages.** Widen `FORBIDDEN_EXACT` in `client-bundle.test.ts` to read
`next.config.ts`'s `serverExternalPackages` array rather than a hand-typed list of three. One list.

**R13 — the Updates card (UX-1, §2b).** MUST-9.9 ("no spinner, no polling, no auto-reload") stands:
never poll a container that is about to be replaced. It does NOT license leaving the Update button
live after a request has been recorded. The card renders the apply-pending state the database already
holds, the action refuses a duplicate request for the same version inside the confirm window without
touching Watchtower or the rate-limit bucket, and every update action returns the availability it
just computed so the client does not depend on a server-component refresh it cannot observe. "Reload
this page in a minute or two" remains the instruction.

---

## 2. Ranked findings

Severity is the lane's, confirmed by the controller. Effort: S < 2 h, M half a day, L more. Full detail
under the appendix ID.

### P0 — one release. Wrong numbers and a read-anyone's-data hole.

| ID | Sev | Title | Where | Effort |
|---|---|---|---|---|
| S-01 | High | Self-scoped member reads any member's transactions via the budgets drill-down action | `budgets/category-transactions-action.ts:33-43`, `lib/budgets.ts:198-229` | S |
| S-02 | Med | Four warranty/bill actions skip the viewer gate every sibling applies | `warranties/actions.ts:552,642,721,767` | S |
| C-01 | High | Archiving a parent category erases its live children from every budget number and every budget alert | `lib/budgets.ts:527-531` | S |
| C-05 | Med | A non-income child under an income parent is dropped from every budget number | `lib/budgets.ts:521` | S |
| C-02 | High | Loan-principal exclusion enforced in `reports.ts` only; Budgets shows a $6,000 lend-out as spend and a repayment as a −$5,950 refund | `lib/reports.ts:93-116` vs `lib/budgets.ts:148-155,282-289`, `predict/history.ts:57-66`, `tax.ts:97` | M |
| O-03 | High | `runNotifyTick`'s two dormancy reads sit before its `try` — the third instance of a defect fixed in two sibling ticks; a throw there kills the cron callback | `lib/scheduler.ts:73` | S |

**S-01 in one paragraph.** `categoryTransactionsAction` awaits `requireUser()` and discards the
result. Its docblock justifies the absence of scoping with "a breakdown of a total the viewer can
already see in full" — true when written, false since v1.13.0 ruling R2 introduced self-scoped
viewers who cannot see household totals at all. A member with `visibility: 'self'` posts
`{ scope: 'household', userId: null, month, categoryId }` and receives every household transaction in
that category with merchant, date, and amount. The page enforces R2; the action reachable underneath
it does not. Fix per R11.

**C-01 in one paragraph.** `budgetProgress` keeps an archived top-level category only if
`spendByCategory.get(category.id) !== 0` — but that map holds each category's own direct spend, not
the rollup, so a parent whose spend sits in its children reads 0 and the whole subtree is dropped
before the child-level filter (which is correct) ever runs. Measured: Food → {Groceries $600 with a
$500 limit, Restaurants $200}; archive Food; Budgets totals go from
`{limit 50000, spent 60000, total 80000}` to `{0, 0, 0}` while Reports still shows $600 of Groceries.
Every budget threshold and pace notification for those children stops firing. Fix: apply the child
predicate's question over the rollup before deciding to drop the parent.

**C-02 in one paragraph.** v1.21.0 item 8a ruled that three of the four loan movements are principal,
not spend. `NOT_PRINCIPAL_MOVEMENT` implements it and only `reports.ts` applies it. Loan-linked rows
are still eligible for auto-categorisation, so an e-transfer picks up Groceries at import, then gets
linked to a loan, and the dashboard shows "Spent this month" (from `cashflowTrend`, excludes it) next
to the Budgets card (from `budgetProgress`, includes it). Two definitions of "spend". Fix per R1.

**O-03 in one paragraph.** `hasAnyEnabledTarget() && countPendingOutbox() === 0` runs before
`ticking = true; try {`. Either read throwing (locked DB, disk) propagates out of the cron callback
uncaught. The file's own comments record fixing exactly this in `runNightlyJob` and its sibling. Move
the dormancy check inside the `try`, keeping the single-flight guard first. Guard: an ops test that
every `run*Tick`/`run*Job` in `scheduler.ts` has no DB call before its `try`.

### P1 — one release. The pipeline that let v1.29.0 ship, and the upgrade path.

| ID | Sev | Title | Where | Effort |
|---|---|---|---|---|
| O-01 | High | No CI step boots the built app; `next build` never runs on push; one GET would have caught v1.29.0 | `.github/workflows/test.yml:53-61`, `release-image.yml:139-149` | M |
| O-02 | High | `.dockerignore` is a denylist; `UI Component/`, `.claude/`, `.vscode/`, `packs/`, `fixtures/`, `*.tsbuildinfo` unlisted and would ship in a local build | `.dockerignore`, `tests/ops/docker.test.ts:181-189` | S |
| O-04 | High | No boot-time downgrade guard; `assertNotNewerThanCode` exists but is called only on the restore path, and `:latest` makes "re-pull the old tag" the natural rollback | `db/client.ts:51-83`, `scripts/restore-core.ts:259-283` | S |
| O-05 | High | No fresh backup before an upgrade on any path; Watchtower path also deletes the old image | `install/update.sh:180-228`, `lib/update/check.ts:74-98` | M |
| O-11 | Med | No `unhandledRejection`/`uncaughtException` handler; a stray rejection bypasses the WAL checkpoint the SIGTERM handler exists for | `src/instrumentation-node.ts` | S |
| UX-1 | Med | Updates card: "Check now" result needs a page reload; "Update now" stays clickable after the request and re-posts to Watchtower on every click — owner-reported, see §2b | `settings/updates-card.tsx`, `settings/updates-client.tsx`, `settings/actions.ts:266-353`, `lib/update/check.ts:74-98` | S |
| — | — | Flake fixes, per R8, six commits | `vitest.config.ts`, `tests/helpers/db.ts`, `tests/lib/backup-restore.test.ts`, `tests/app/reports.test.tsx`, `src/lib/auth/password.ts` | M |
| — | — | Guard widening per R12, plus `process.env` in client files and `cookies()/headers()` in the scheduler closure (§C coverage map items 3 and 4) | `tests/ops/client-bundle.test.ts` | S |

### P2 — mediums and the cheap accessibility wins. Batch freely.

| ID | Sev | Title | Where | Effort |
|---|---|---|---|---|
| S-03 | Med | A Watchtower redirect refusal is classified as "container being replaced" and shown to the admin as success | `lib/update/watchtower.ts:143,174` | S |
| S-04 | Med | `/api/health` 503 returns raw `error.message` unauthenticated — table names, row ids, absolute paths | `api/health/route.ts:46` | S |
| S-05 | Med | Body caps check `Content-Length` only; chunked bypasses; pack imports never check `file.size` | `api/packs/rules/import/route.ts:16,46`, `profiles/import/route.ts:35`, `warranties/receipts/stage/route.ts:66-69` | S |
| S-06 | Med | PDF OCR has no page cap and the timeout cannot cancel it; queue concurrency is 1 | `lib/warranty/ocr/pdf.ts:42` | S |
| C-03 + C-09 | Med | Normaliser leaves a city fragment on every two-word city; bare 4-digit store numbers survive; stored column needs backfill (migration 0022) | `lib/categorize/normalize.ts:98,146-150` | M |
| C-04 | Med | Dashboard "Needs a look" credits a category baseline to the merchant; `render.ts` gets it right | `lib/insights.ts:101-110` | S |
| C-07 | Low | Anomaly/insight category baselines read the split parent's stale `category_id` | `lib/insights.ts:47-61`, `notify/evaluate/anomalies.ts:105-166,325-345` | M |
| C-08 | Low | `cashRunwayHint` blames a missing month whenever `months` is null, even with six months of zero-net history | `lib/runway.ts:157-159` | S |
| O-06 | Med | No `onRequestError`; the digest a user reads back cannot be tied to a route in the log | `src/instrumentation*.ts` | S |
| O-07 | Med | Outbox at-least-once across a restart mid-send; `attempts` stripped before Recent deliveries — per R4, document and expose only | `lib/notify/outbox.ts`, `settings/notifications/page.tsx` | S |
| O-08 | Med | CLI restore documents "stop the container first" but does not enforce it | `scripts/restore-backup.ts` | S |
| O-09 | Med | No preflight free-space check before backup or restore | `lib/backup/archive.ts`, `scripts/restore-core.ts` | S |
| O-10 | Med | Unwritable volume during restore commit restarts the container forever; acknowledged in source, undocumented for users | `lib/backup/restore.ts`, `INSTALL.md` | S |
| U-01 | High (a11y) | Eleven `<th>` cells across four tables lack `scope="col"`; also blinds `table-layout.test.ts`'s guard to those tables | `reports-client.tsx:303-307`, `notifications-client.tsx:1084-1086,1175-1177,1240-1244` | S |
| U-02 | Med (a11y) | Five chart components have no text alternative — per R7 | `components/charts/*.tsx` | M |
| UI-K1 | — | `about-panel.tsx:120` keys changelog groups by title; `[1.23.0]` has two `### Added` | `settings/about-panel.tsx:120`, `CHANGELOG.md:286,309` | S |
| UI-K2 | — | Dashboard "+N more to check" links to `/import`, which cannot answer the question; correct target is `/transactions?source=rule&group=category` | `components/RuleReviewCard.tsx:82` | S |
| UI-K3 | — | Rule-delete dialog's shadowing paragraph is conditional; `ruleShadowCount` beside `ruleClearIds` gives the real number | `merchant-rules-client.tsx:367-371`, `lib/categorize/engine.ts:672` | S |
| UI-K4 | — | `confirmCategory.createRule` optional and defaults to **creating** a rule; drop the `?`, promote to `REQUIRED_FLAGS` in `rule-authoring-intent.test.ts` | `lib/categorize/engine.ts:845,887`, `tests/ops/rule-authoring-intent.test.ts:370` | S |

### P3 — lows. Do when adjacent code is already open.

| ID | Title | Where |
|---|---|---|
| S-07 | SimpleFIN is the only outbound path without `redirect: 'error'` | `lib/simplefin/client.ts:51-54` |
| S-08 | Watchtower guard looser than docs claim (fix docs, R6); IPv6 regexes accept `fc::1` (fix regex) | `lib/update/egress.ts:87-89`, `README.md:287`, `INSTALL.md:88-89` |
| S-09 | `/api/health` does an unauthenticated filesystem write per request, unrate-limited — memoise with a short TTL | `api/health/route.ts:13-16` |
| S-10 | Staged receipts have no aggregate quota | `lib/warranty/staging.ts:78` |
| S-11 | Email `From` interpolates `fromName` unquoted — hand nodemailer the `{ name, address }` object | `lib/notify/send/email.ts:62` |
| S-12 | Two admin preview actions skip `isSameOrigin` — the only two of 21 `'use server'` modules | `settings/merchant-rules/actions.ts:249,440` |
| S-13 | `assertTelegramUrl` ignores query/fragment; adjacency scanner does not cover `telegram.ts` | `lib/notify/egress.ts:27-43`, `tests/ops/notify-egress.test.ts:179-182` |
| S-14 | TOTP `===` — declined per R5, comment only | `lib/auth/totp.ts:100-103` |
| S-15 | Restore has no uncompressed-size/entry-count cap; validation and extraction are separate passes | `scripts/restore-core.ts:344-371,462` |
| S-16 | Pack schemas unbounded; conflict scan quadratic | `lib/packs.ts:251-252,475-487` |
| C-06 | `cashflowTrend` default `endMonth` reads the wall clock in UTC — latent, every caller passes it; make the parameter required | `lib/reports.ts:222` |
| C-10 | Bayes trains on a rule's own verdict when a rule-assigned row is confirmed to the same category | `lib/categorize/engine.ts:866,900,914` |
| C-11 | Bare `new Date()` in `runEngine` with no injectable `at`, unlike every sibling | `lib/categorize/engine.ts:235` |
| C-12 | Import help text misstates the dedup key | `help/content.tsx:233-234` |
| O-12 | No `.nvmrc`; `engines.node` is a floor | `package.json` |
| O-13 | Installers validate no disk space, port, or Docker version | `install/*.sh`, `install/*.ps1` |
| O-14 | `expireStalePending` runs once per process lifetime; `countPendingOutbox` ignores `next_attempt_at` | `lib/scheduler.ts`, `lib/notify/outbox.ts` |
| U-03 | Dashboard states the viewed month twice when not current | `dashboard/page.tsx:350,357` |
| U-04 | Per-connection `getAccount` inside `.map` | `settings/connections/actions.ts:35` |
| UI-G | No guard ties `SubmitButton variant="danger"` to a `RowDialog` or a documented exemption | `tests/ops/` (new) |

---

## 2b. Owner-reported after the audit — UX-1, the Updates card

Reported by the owner on 2026-09-02, on the live install, after the four lanes had finished. Not in any
lane's scope (S-03 touched the Watchtower call's error classification, not the card). Diagnosed by
reading; not reproduced in a browser — nothing in this repo has ever been, see O-01.

**Symptom A.** Press *Check now*. The green message "Version X is available" appears, but the card
header still reads "Up to date" and there is no *Update now* button until the page is reloaded.

**Cause A.** The availability UI — header text, severity badge, the *Update now* / *Not now* row — is
driven entirely by **props** (`updates-client.tsx:129-138`, `offered`/`severity`/`dismissed`), which
`UpdatesCard` (`updates-card.tsx:27-58`) computes from `readUpdateState()` in the server component.
`checkForUpdateNowAction` (`actions.ts:266-286`) writes the new state, calls
`revalidatePath('/settings')`, and returns only `{ message }`. The design bets that Next re-renders
the server tree as part of the action response and streams new props to the client; the v1.13.1
item-H comment at `actions.ts:228-233` records making exactly that bet, and says the availability UI
"is driven by props, not by the message these return." The owner's report says the props do not
arrive. That fix was never verified in a browser (Playwright was declined for both releases). Whether
the refresh fails because of `force-dynamic` + `revalidatePath` semantics, the reverse proxy in front
of the NAS, or something else is not knowable from source — and does not need to be: the fix below
is correct under every one of those.

**Symptom B.** Press *Update now*. The message "Update requested. Watchtower is pulling X…" appears.
The *Update now* button is still there and still enabled. Pressing it again sends the request again.

**Cause B.** `applyUpdate` (`check.ts:74-98`) writes `update.apply_requested_version` and
`update.apply_requested_at` BEFORE the fetch (MUST-7.4, `recordApplyRequested`), so the database
knows an apply is in flight. `UpdatesCard` never passes those two fields to the client
(`updates-card.tsx:41-58` — `applyRequestedVersion` and `applyRequestedAt` are absent from the prop
list), so the client cannot know, and re-renders the same button. Server-side there is no
single-flight check: a second request for the same version inside the 30-minute confirm window
(`APPLY_CONFIRM_MAX_AGE_MS`, `state.ts:54`) consumes another rate-limit token and posts to Watchtower
again. The only brake is `APPLY_MAX = 3` per hour (`ratelimit.ts:18`), whose message — "Too many
attempts" — reads as an error for something that is working. The card's own comment at
`updates-client.tsx:293-294` cites MUST-9.9, "no spinner, no polling, no auto-reload", as the reason
nothing happens after the click. That ruling is about not polling a dying container. It was never a
ruling to leave the button live. See R13.

**Fix — one task, one commit per bullet, all small.**

1. **Actions return what they computed.** Extend `UpdateActionState` (`actions.ts:195-198`) with
   optional `latestVersion`, `latestPublishedAt`, `lastCheckedAt`, `severity`, `applyRequestedVersion`,
   `applyRequestedAt`. `checkForUpdateNowAction` and `applyUpdateAction` populate them from
   `readUpdateState()` after their write. Keep `revalidatePath` — it is still right for the next
   navigation.
2. **Client prefers the freshest action result over props.** In `UpdatesClient`, derive the
   availability inputs as `checkState.latestVersion ?? applyState.latestVersion ?? props.latestVersion`
   (same for the other fields), then compute `offered`/`severity`/`dismissed` from those. One helper,
   `resolveView(props, states)`, so the rule is written once.
3. **Card passes the pending state.** `UpdatesCard` adds `applyRequestedVersion={state.applyRequestedVersion}`
   and `applyRequestedAt={state.applyRequestedAt}`; `UpdatesViewProps` gains both.
4. **Pending block replaces the buttons.** When `applyRequestedVersion === offered` and
   `applyRequestedAt` is younger than `APPLY_CONFIRM_MAX_AGE_MS` (export it from `state.ts`; it is
   already `export const`), render — in place of the *Update now* / *Not now* row AND in place of the
   major-version panel's *Install X* button — a `<Notice tone="info" title="Update requested at HH:MM">`
   whose body is: "Watchtower is pulling {offered}. This page will stop responding for a minute while
   the container restarts, then come back on the new version. Reload in a minute or two. If this card
   still says v{current} after 30 minutes, the update did not land and the reason will appear here."
   No button. No polling. `reconcilePendingApply` (`state.ts:271`) already clears the flag on the
   next boot or check tick, so the block retires itself.
5. **Server single-flight.** In `applyUpdate`, before `checkUpdateApply()`: if
   `state.applyRequestedVersion === input.version` and `at - applyRequestedAt < APPLY_CONFIRM_MAX_AGE_MS`,
   return `{ outcome: 'already-pending', retryAfterMinutes: 0 }` — add `'already-pending'` to
   `ApplyOutcome.outcome`'s union (`check.ts:41-43`) — without consuming the rate-limit bucket and
   without calling `triggerUpdate`. `applyUpdateAction` maps it to the same sentence as the pending
   block. This is what makes the button-less UI honest: even a stale tab that still shows the button
   cannot fire a second Watchtower request.

**Tests — each shown failing first.**

- `tests/app/updates-card.test.tsx`: (a) props say up to date; mock `checkForUpdateNowAction` to
  resolve `{ message, latestVersion: '9.9.9', severity: 'minor', lastCheckedAt }`; submit *Check now*;
  assert the header reads "Version 9.9.9 is available" and an *Update now* button exists — with no
  prop change. (b) props carry `applyRequestedVersion === latestVersion` and an `applyRequestedAt`
  five minutes old: assert no *Update now* button, assert the pending notice names the version.
  (c) same but `applyRequestedAt` thirty-one minutes old: assert *Update now* is back.
- `tests/app/update-actions.test.ts` (or `tests/lib/update/`): two `applyUpdate` calls for the same
  version inside the window — the Watchtower fetch stub is called exactly once, the second returns
  `'already-pending'`, and `checkUpdateApply`'s bucket shows one token spent, not two.
- Extend the O-01 smoke test's route list with nothing — it is GET-only — but note in its spec that
  Settings must render the *Updates* card for the seeded admin without error.

**A question only the owner can answer, worth asking before starting:** after pressing *Update now*
on v1.29.0 and waiting a few minutes, did the version at the bottom of the card change to 1.29.1? If
it did, Watchtower is replacing the container and this is purely the card. If it did not, the
request is being accepted and never acted on — check that the compose file pins `:latest` (not a
version tag; see the "Fix wave item 1(b)" comment at `check.ts:104-112` for why a pinned tag never
reboots) and that `WATCHTOWER_TOKEN` matches `WATCHTOWER_HTTP_API_TOKEN`. That would be a separate
finding and O-04's downgrade guard becomes more urgent, not less.

---

## 3. Verified clean — do not re-audit

Recorded so the next review starts from here rather than from zero. Evidence for each is in the
appendix "Verified clean" sections.

- **Bearer credentials.** SimpleFIN access URL, Telegram tokens (personal and household), SMTP password,
  Watchtower token: AES-256-GCM at rest under per-purpose HKDF keys; decrypted only at the point of use;
  basic-auth credentials moved from the URL into a header before any fetch; every string that reaches
  `last_error`, `console.*`, or the browser passes `scrubSecrets`; the household target projection drops
  `secret_encrypted` before the RSC payload. Chased end to end. Clean.
- **CSRF.** Every mutating server action but two (S-12, both read-only previews) opens with
  `isSameOrigin`. API routes are `/api/*`-exempt from the proxy redirect by design and return 401.
- **Raw SQL.** Every `sql\`` interpolation is a Drizzle parameter, not text concatenation. LIKE patterns
  are escaped.
- **Tar / path handling.** `assertArchiveEntriesAreSafe` refuses traversal and symlinks; restore is a
  staged boot-time swap with an attempt cap and atomic `.partial` rename; backups use `VACUUM INTO`,
  not a file copy, so the WAL is consistent.
- **XSS / message injection.** One `dangerouslySetInnerHTML` in the repo, the static theme script at
  `src/components/theme/theme-script.tsx:18`, with no user input in it; zero `insertAdjacentHTML`,
  `srcdoc`, `eval`, or `Function(`. Telegram sends **no** `parse_mode` (plain text, so a merchant named
  `<b>` cannot inject markup — there is no markup mode to inject into) and email sends a `text` body
  only, no HTML. Subject lines are CRLF-stripped.
- **Money and dates (I4, I5, I6).** Month arithmetic is string-based; no float accumulation in cents;
  migrations 0000–0021 idempotent and ordered; table rebuilds preserve every column and index;
  `drizzle-orm@0.45.2` wraps the whole pending set in one transaction, so a half-applied migration set
  does not occur on this version.
- **Rule engine.** `matchRule` precedence is as documented. `findRedundantRules` coverage matrix is as
  documented — `word SHELL` is correctly not flagged against `contains SHELL`. Bayes never overwrites a
  `source='rule'` row (prediction side clean; training side is C-10).
- **Budget rollover, payoff projection, digest column agreement, dedup key, pace day-1 guard** — all
  cleared with the specific cases in §B.
- **Runtime boundary shapes.** All seven shapes in §C's coverage map swept against the current tree: no
  live defect. Clean by construction in three cases (no `Date` columns; all-optional `useActionState`
  state; no default exports in client files).
- **Dialogs.** All fourteen `variant="danger"` buttons sit behind `RowDialog` or one of the two
  documented row-level exemptions.

---

## 4. Appendices — full lane reports, verbatim

Each appendix carries the lane's own summary, every finding with `file:line` evidence and the concrete
fix including test file and assertion, the "Verified clean" coverage list, and an "Unconfirmed" section
for suspicions that could not be proven. The controller's rulings in §1 override any choice a lane
left open.


---

## §A — Security lane (Opus)

### Summary

16 findings: 1 High, 5 Medium, 10 Low. No Critical.
**Fix S-01 first**: a self-scoped ("kids scope") member can read every other member's individual
transactions — merchant, date and amount — by calling the budgets drill-down server action directly
with a `scope` and `userId` of their choosing. The whole v1.13.0 R2 reader boundary is enforced on
the budgets *page* and on nothing in that action, and the invariant suite that exists to catch this
does not know the function exists. S-02 is the same class in four warranty/bill actions, two of
which contradict an exemption already written down in those tests.
The bearer-credential handling, CSRF posture, raw SQL, tar/path handling and XSS surface are
genuinely clean — **Verified clean** records what that covers, including several bypasses tested and
confirmed blocked.

### Findings

#### S-01 · High · A self-scoped member can read any household member's transactions via the budgets drill-down action

**Where:** `src/app/(app)/budgets/category-transactions-action.ts:26-44`, backed by
`src/lib/budgets.ts:198-229`

**What:** `categoryTransactionsAction` takes `scope` and `userId` straight from the caller and passes
them to `categoryTransactions()`, which has no `viewer` parameter and applies no owner scoping of its
own. The budgets *page* enforces ruling R2 meticulously — it computes `isSelfScoped(viewer)`, forces
the household scope to null for a self viewer "regardless of the URL", and filters
`listAttributablePeople()` down to the viewer's own id — but a server action is reachable
independently of the page that renders it, and the action repeats none of that. A member with
`visibility: 'self'` can post `{ scope: 'household', userId: null, month, categoryId }` and receive
every household transaction in that category, or `{ scope: 'personal', userId: <another member's id> }`
to read one named person's rows. The returned rows carry `merchant`, `date` and `amountCents` — the
exact spend detail the self scope exists to withhold. This is the identical defect that
`src/app/(app)/transactions/actions.ts:63-87` documents having fixed ("ruling R2 fix round 2
(controller finding): none of the write actions in this file resolved their target row(s) through the
viewer"); the 2026-08-30 budgets lane reintroduced it on a read path.

**Evidence:**
- `category-transactions-action.ts:33` is `await requireUser();` — the return value is discarded, so
  no viewer ever exists inside this function.
- `category-transactions-action.ts:40-43` passes the caller's own values through verbatim:
  `categoryTransactions(input.month, input.categoryId, { scope: input.scope, attributedUserId: input.scope === 'personal' ? input.userId : undefined })`
- `src/lib/budgets.ts:198-202` — the signature has no viewer:
  `export function categoryTransactions(month: string, categoryId: number, opts: { attributedUserId?: number | null; scope?: BudgetScope } = {}): CategoryTransactionRow[]`
  and `:213` shows the only owner filter is the caller-supplied one:
  `if (opts.scope !== 'household' && opts.attributedUserId !== undefined && opts.attributedUserId !== null) { clauses.push(eq(transactions.attributedUserId, opts.attributedUserId)); }`
- What the page does instead: `src/app/(app)/budgets/page.tsx:73` `const selfScoped = isSelfScoped(viewer);`,
  `:82` `listAttributablePeople().filter((person) => person.id === viewer.id)`, `:96` "Ruling R2:
  forced null for a self viewer regardless of the URL."
- The guard that should have caught it does not know this function exists. I read all three named
  lists in `tests/ops/visibility-invariants.test.ts` — `REQUIRE_VIEWER` (:21-50), `EXEMPT` (:53-77),
  `HOUSEHOLD_ONLY_AT_PAGE` (:89-114). `src/lib/budgets.ts :: categoryTransactions` is in none of them.
  I ran `npx vitest run tests/ops/visibility-invariants.test.ts`: **34 tests passed**, so the
  invariant suite is green today with this hole open.
- The action has no server-side test: `grep -rn categoryTransactionsAction src/ tests/` returns only
  the client import (`budgets-client.tsx:43,330`) and two `vi.fn()` mocks
  (`tests/app/budgets-client.test.tsx:28`, `tests/app/budgets-rollover-ui.test.tsx:34`).

**Fix:** In `src/lib/budgets.ts`, give `categoryTransactions` a required `viewer: Viewer` parameter and
push `eq(transactions.attributedUserId, scope)` into `clauses` when `ownerScope(viewer)` is non-null,
mirroring `listTransactions`. In `category-transactions-action.ts:33`, keep the return value
(`const viewer = await requireUser();`), pass it through, and refuse `scope: 'household'` outright for
`isSelfScoped(viewer)` as the page already does. Then add
`{ file: 'src/lib/budgets.ts', fn: 'categoryTransactions' }` to `REQUIRE_VIEWER`
(`tests/ops/visibility-invariants.test.ts:21-50`) and bump the "cannot shrink below 28 entries"
assertion at `:161`. Prove it with a new case in `tests/app/budgets-actions.test.ts` following the
shape at `tests/app/warranties-actions.test.ts:1122-1128`: set
`currentUser = { ..., role: 'member', visibility: 'self' }`, call
`categoryTransactionsAction({ scope: 'household', userId: null, month, categoryId })` against a
category seeded with another member's transaction, and assert `rows` is empty; add a second case
asserting `scope: 'personal'` with a foreign `userId` also returns empty.

**Effort:** S
**Confidence:** High

---

#### S-02 · Medium · Four warranty/bill actions skip the viewer gate every sibling action applies

**Where:** `src/app/(app)/warranties/actions.ts:552` (`reRunOcrAction`), `:642` (`deleteLoanRuleAction`),
`:721` (`removeInstallmentAction`), `:767-768` (`setInstallmentPaidAction`, unmark branch)

**What:** Each calls `await requireUser()` and **discards the user**, then resolves its target by an id
taken from the form with no `getWarrantyItem(itemId, viewer)` and no `canActOnOwner`. For a
self-scoped member, `getWarrantyItem` is the only thing that returns null for another owner's item, so
with it absent these four operate on any household member's rows: re-run OCR on a stranger's receipt,
delete a stranger's loan matching rule, delete a stranger's bill installment, un-mark a stranger's
installment as paid. Two of them break a precondition the codebase has already written down as the
*reason* their helper is exempt from the viewer requirement. `reRunOcrAction` is also an existence
oracle for receipt ids ("That receipt no longer exists." vs. a success message) — the same leak
`src/app/api/warranties/receipts/[id]/route.ts:69-73` deliberately closed for SEC-1 by answering 404
instead of 403.

**Evidence:**
- `actions.ts:552` `await requireUser();` → `:556` `const receipt = getWarrantyReceipt(id.data);` →
  `:562` `resetReceiptForReOcr(id.data);`. No item lookup, no owner check anywhere between.
- `actions.ts:642` `await requireUser();` → `:652`
  `const rule = listLoanRules(parsed.data.itemId).find((r) => r.id === parsed.data.id);` → `:654`
  `deleteLoanRule(parsed.data.id);`. The itemId is never checked against the viewer.
- `actions.ts:721` `await requireUser();` → `:728`
  `if (findInstallment(parsed.data.itemId, parsed.data.id) === undefined) return { error: INSTALLMENT_GONE };`
  where `findInstallment` (`:675-678`) calls `listInstallments(itemId, ...)`, whose signature
  (`src/lib/warranty/installments.ts:117`) takes no viewer.
- `actions.ts:759-769` — the check sits inside the `if (paid)` branch only:
  `if (paid) { const item = getWarrantyItem(parsed.data.itemId, user); if (!item) return ...; ... } else { unmarkInstallmentPaid(parsed.data.id); }`
- The recorded exemptions these violate, both in `tests/ops/visibility-invariants.test.ts`: `:59-62`
  exempts `getWarrantyReceipt` because *"warranties/actions.ts (deleteReceiptAction) and
  api/warranties/receipts/[id]/route.ts use it only to find the receipt's parent item id, then check
  canActOnOwner(getWarrantyItem(item.id, viewer))"* — `reRunOcrAction` is a third caller that does not.
  `:69-72` exempts `listLoanRules` because *"warranties/[id]/page.tsx and warranties/actions.ts call it
  only with item.id after getWarrantyItem(id, viewer) already confirmed the viewer may see this item"* —
  `deleteLoanRuleAction` does not.
- The correct shape is two functions away, `addInstallmentAction` (`actions.ts:689,695-696`):
  `const user = await requireUser(); ... const item = getWarrantyItem(parsed.data.itemId, user); if (!item) return { error: 'That item no longer exists.' };`

**Fix:** Capture the user in all four and add the standard gate before the mutation. For
`reRunOcrAction`:
`const item = getWarrantyItem(receipt.warrantyItemId, user); if (!item || !canActOnOwner(item.ownerUserId, user)) return { error: 'That receipt no longer exists.' };`
— reusing the existing wording closes the oracle at the same time. For the other three,
`if (!getWarrantyItem(parsed.data.itemId, user)) return { error: 'That item no longer exists.' };`
immediately after the zod parse; in `setInstallmentPaidAction` hoist it above the `if (paid)` branch.
Prove each with a `refuses for a self-scoped viewer who cannot see the item` case in
`tests/app/warranties-actions.test.ts` and `tests/app/warranty-installments.test.ts`, copying the
existing assertion at `tests/app/warranties-actions.test.ts:1122-1128`
(`expect(result.error).toBe('That item no longer exists.')`).

**Effort:** S
**Confidence:** High

---

#### S-03 · Medium · A Watchtower redirect refusal is reported to the admin as a successful update

**Where:** `src/lib/update/watchtower.ts:143`, consumed at `:174`

**What:** `redirect: 'error'` is correctly set on the Watchtower call, so the bearer token genuinely
cannot follow a hop off-host. But the classification of that refusal is wrong: `isReplacementSignal()`
ends in a catch-all that treats undici's generic `TypeError: fetch failed` as "the container is being
replaced, this is success", and undici's redirect refusal produces exactly that shape. So the one
control preventing `WATCHTOWER_TOKEN` from leaving the validated host fires **silently** and is
indistinguishable from a successful apply. `check.ts:91` then calls `recordApplyOutcome({ at })` with
no error and the UI shows the update as accepted. An operator whose "Watchtower" is an open
redirector, a hostile sidecar, or a misrouted reverse proxy gets zero signal. The same fallback also
swallows every DNS/TLS/connect failure whose cause it does not recognise.

**Evidence:**
- `src/lib/update/watchtower.ts:143`: `return error.name === 'TypeError' && error.message === 'fetch failed';`
- `src/lib/update/watchtower.ts:174`: `if (isReplacementSignal(error)) return 'accepted-unconfirmed';`
- Proved empirically against a local `http.createServer` returning `302 Location: http://example.com/`,
  fetched with `redirect: 'error'` and run through a verbatim copy of `isReplacementSignal`:
  `depth 0: name=TypeError message="fetch failed"` / `depth 1: name=Error message="unexpected redirect"`
  / `isReplacementSignal(redirect error) => true`.
- `redirect: 'error'` itself is present and working — `watchtower.ts:169`.

**Fix:** Short-circuit the redirect cause before the fallback, inside the `while` loop at
`watchtower.ts:135-142`: `if (/unexpected redirect|redirect count exceeded/i.test(current.message)) return false;`
so it falls through to the `throw new WatchtowerError(...)` at `:176`. Give it its own sentence and
mark it permanent — a redirect is a configuration or attack signal, not a transient blip. Prove it in
`tests/lib/update/watchtower.test.ts` with a fetch stub that rejects with a `TypeError('fetch failed')`
whose `cause` is `new Error('unexpected redirect')`, asserting `triggerUpdate` throws rather than
returning `'accepted-unconfirmed'`.

**Effort:** S
**Confidence:** High

---

#### S-04 · Medium · The health endpoint's 503 returns raw internal error text — table names, row ids, and absolute paths — unauthenticated

**Where:** `src/app/api/health/route.ts:46`

**What:** The 200 response is minimal and correct (`{ status, db, dataDir, time }`, version
deliberately withheld per SEC-11). The 503 path returns the exception message verbatim to an
unauthenticated caller. The `try` at `:37-39` wraps `getSqlite()`, which on a cold call runs
`ensureInstance()` → `openDatabase(databasePath())` → `readEnv()`, so every message on that chain
reaches a stranger — including a migration-integrity error that publishes up to five private table
names *with row ids*, and secret-key errors that name the absolute data directory. This fires exactly
when an operator (and anyone watching) is hammering `/api/health` because the install is broken. The
sibling 503 branch already shows the right pattern: a fixed string.

**Evidence:**
- `src/app/api/health/route.ts:46`: `error: error instanceof Error ? error.message : 'unknown',`
- Reachable content 1, `src/db/client.ts:78-80`:
  `` throw new Error(`Database has ${orphans.length} orphaned row(s) after migration; refusing to start. First ${Math.min(orphans.length, 5)}: ${sample}`) ``
  with `sample` built at `:74-77` as `` `${o.table}#${o.rowid}→${o.parent}` ``.
- Reachable content 2, `src/lib/env.ts:80-81`: `` `${keyPath} contains a key shorter than ${MIN_SECRET_KEY_BYTES} bytes...` `` where `keyPath = path.join(dataDir, SECRET_KEY_FILENAME)` (`env.ts:95`).
  `env.ts:102` and `:113` rethrow raw `ErrnoException`s of the form
  `EACCES: permission denied, open '/data/secret.key'`.
- Reachable content 3, probed against the repo's own better-sqlite3:
  `SqliteError code=SQLITE_ERROR message="no such table: nope"`.
- Unauthenticated by design and confirmed: `grep requireUser src/app/api/health/route.ts` → no match;
  `src/proxy.ts:45-47` makes `isApiPath('/api/health')` true and `:112`
  `if (!isPublic && !isApiPath(pathname) && !hasCookie)` skips the redirect for it.
- The right pattern, already in the same file at `:60`: `error: 'data directory is not writable',`
- Nothing pins the field: `tests/api/health.route.test.ts:39,41` asserts only `body.status` and
  `body.version`, never `body.error`.
- The consumer does not need it: the compose healthcheck is
  `fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1))` — `r.ok` only.

**Fix:** Replace `route.ts:46` with a sentinel (`error: 'database check failed'`) and `console.error`
the real message server-side, where the operator reading container logs already has it — the same
split `src/lib/notify/crypto.ts:58-64` uses for credential failures. Reconsider `version` on the 503
too; the file's own comment at `:30-35` argues it should not be on the 200, and the same argument
applies. Prove it in `tests/api/health.route.test.ts` by forcing the DB probe to throw with a message
containing `/data/` and asserting the response body does not contain it.

**Effort:** S
**Confidence:** High

---

#### S-05 · Medium · Declared-size body caps are bypassable with chunked encoding; the pack import routes have no post-parse size check at all

**Where:** `src/app/api/packs/rules/import/route.ts:46-47` + `:16`,
`src/app/api/packs/profiles/import/route.ts:25,35`,
`src/app/api/warranties/receipts/stage/route.ts:66-69`

**What:** These routes cap the body on the **declared** `Content-Length` only. A request sent with
`Transfer-Encoding: chunked` carries no `Content-Length`, so `Number('')` is `NaN`,
`Number.isFinite(NaN)` is false, and the guard is skipped — after which `request.formData()` fully
materialises the body in memory before any other check runs. Next 16 sets no route-handler body limit
(`next.config.ts` has none; I read all 28 lines) and App Router route handlers have no default. For
the two pack routes it is worse than a transient spike: neither ever checks `file.size`, so
`file.text()` and `JSON.parse` run on an unbounded string. The app's own CSV route documents and
closes exactly this gap, so this is a known-and-solved pattern two newer routes did not copy.

**Evidence:**
- `packs/rules/import/route.ts:46-47`:
  `const contentLength = Number(request.headers.get('content-length') ?? ''); if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) return tooLarge();`
  and `readPack` (`:12-22`) goes straight from `form.get('file')` to `:16` `const text = await file.text();`
  to `:19` `pack = JSON.parse(text);` with no size check between.
- `packs/profiles/import/route.ts:35`: `pack = JSON.parse(await file.text());` — same, no `file.size`.
- The sibling that gets it right, `src/app/api/import/raw-preview/route.ts:36-38`:
  `// content-length can be absent/wrong (e.g. chunked transfer); the file's` / `// own size is authoritative and is known without reading its bytes yet.`
  followed by `if (file.size > MAX_FILE_BYTES) return tooLarge();`
- `warranties/receipts/stage/route.ts:69` `const form = await request.formData();` runs before the
  part-count check at `:72` and the per-part `part.size` check at `:83`.
- `MAX_FILE_BYTES = 5 * 1024 * 1024` at `src/lib/import/parse.ts:7`.

**Fix:** In both pack import routes add `if (file.size > MAX_FILE_BYTES) return tooLarge();`
immediately after the `instanceof File` check — for rules that means inside `readPack`
(`route.ts:15-16`). In `warranties/receipts/stage/route.ts`, move the part-count check above the
per-part loop and add a summed check after `:70`:
`const total = parts.reduce((n, p) => n + p.size, 0); if (total > MAX_UPLOAD_BYTES) return requestTooLarge();`
Prove it in `tests/api/packs.route.test.ts` and `tests/api/warranty-stage.route.test.ts` with a request
built from a `ReadableStream` body (no `content-length`) carrying an oversized file, asserting 413
rather than 200.

**Effort:** S
**Confidence:** High

---

#### S-06 · Medium · PDF OCR has no page cap and the job timeout provably cannot cancel it

**Where:** `src/lib/warranty/ocr/pdf.ts:42`, `src/lib/warranty/ocr/queue.ts:126-135`

**What:** `extractPdfText` iterates every page of an uploaded PDF with no upper bound, calling
`page.getTextContent()` on each. The queue's `recognizeWithTimeout` is a `Promise.race`, which
abandons the caller's `await` but does not cancel the work — and the code says so — and its recovery
step `releaseOcrEngine()` is documented as a no-op on the PDF path specifically. Queue concurrency is
1, so a crafted 10 MB PDF with a very large page count keeps burning CPU in-process past
`OCR_TIMEOUT_MS` and starves every subsequent OCR job. `MAX_OCR_TEXT_CHARS` truncates the result, not
the work.

**Evidence:**
- `src/lib/warranty/ocr/pdf.ts:42`: `for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {`
- `src/lib/warranty/ocr/queue.ts:126-128` (its own docblock): *"Promise.race only abandons the
  caller's `await` — it does NOT cancel the call itself"*.
- `src/lib/warranty/ocr/queue.ts:134-135`: *"(a no-op when the active job never touched a real worker,
  e.g. the PDF path or a test's fake engine) so the NEXT job builds a fresh one."*
- `MAX_OCR_TEXT_CHARS = 100_000` at `src/lib/warranty/ocr/engine.ts:18` bounds the returned string only.

**Fix:** In `src/lib/warranty/ocr/pdf.ts` add `export const MAX_PDF_PAGES = 50;` and loop to
`Math.min(doc.numPages, MAX_PDF_PAGES)`; also break once accumulated text exceeds
`MAX_OCR_TEXT_CHARS`. Prove it with a case in the OCR test file that stubs a `doc` with
`numPages: 500` and asserts `getTextContent` was called at most `MAX_PDF_PAGES` times.

**Effort:** S
**Confidence:** High

---

#### S-07 · Low · SimpleFIN is the only outbound path without `redirect: 'error'`

**Where:** `src/lib/simplefin/client.ts:51-54`

**What:** `defaultFetcher` calls `fetch(url, init)` with no `redirect` option, so the default
`'follow'` applies. Every other egress path in the app sets `redirect: 'error'` — `watchtower.ts:169`,
`github.ts:120` and `:165`, `telegram.ts:72` and `:135` — so this is a lone deviation from a house rule
on the path that carries the app's highest-value credential. There is also no origin allowlist, no
private-IP refusal and no path pinning here; the only validation is scheme, and that governs the first
hop only. A `302` from the claim URL to `http://192.168.x.x/` is followed, the body is accepted as the
access URL on shape alone, and `fetchAccounts` then targets whatever host that names. Reachability is
narrow — admin-only and initiated by an admin pasting a token they chose — which is why this is Low.

**Evidence:**
- `src/lib/simplefin/client.ts:51-54`:
  `const defaultFetcher: Fetcher = async (url, init) => { const response = await fetch(url, init);`
  — no `redirect` key anywhere in the file.
- The only scheme check, `:71-73`: `if (!/^https:\/\//i.test(decoded)) { throw new SimplefinError('bad_token', 'The claim URL is not https. Refusing to send a credential over plain HTTP.'); }`
- The returned access URL is accepted on shape alone, `:113`: `if (!/^https:\/\/[^\s]+$/i.test(body))`
- Admin gate confirmed: `src/app/api/simplefin/claim/route.ts:11,16,18`.

**Fix:** Add `redirect: 'error'` to `defaultFetcher` in `src/lib/simplefin/client.ts:52` — one line,
matching house style. If the LAN pivot matters, also refuse a decoded claim URL or returned access URL
whose hostname is a private literal, reusing the shape of `isPrivateIpv4`/`isPrivateIpv6` from
`src/lib/update/egress.ts`. Prove it in `tests/api/simplefin.route.test.ts` with an injected `Fetcher`
asserting the option is set, plus a case where a redirecting stub causes a `SimplefinError` rather
than a stored connection.

**Effort:** S
**Confidence:** High

---

#### S-08 · Low · The Watchtower URL guard is looser than README/INSTALL claim, and the IPv6 predicate accepts non-private literals

**Where:** `src/lib/update/egress.ts:87-89`, `:124-129`; `README.md:286-287`; `INSTALL.md:88-89`

**What:** Two related claim-vs-behaviour gaps. (a) `README.md` and `INSTALL.md` state the Watchtower
endpoint "lives on the compose project's private network and is never published to the host, so it is
not a fourth egress destination", and `egress.ts:94-96` claims the function "is what makes the
Watchtower exemption ... enforceable rather than asserted". What it actually enforces is "not a dotted
public name": any single-label host (including public dotless TLDs such as `ai` and `com`, and any
label a `resolv.conf` search domain expands into a public FQDN), any RFC1918 or link-local address on
the operator's LAN, any port, and `https`. `.env.example:18-20` is the honest version and does match
behaviour. (b) `isPrivateIpv6`'s regexes allow a short first hextet, so `fc::1`, `fd:1::1` and `fe8::1`
are accepted as "private" when they are actually in reserved `::/8` space — not exploitable, since that
space is unroutable, but a straight divergence from the comment directly above it.

**Evidence:**
- `src/lib/update/egress.ts:124-129`:
  `const host = parsed.hostname; const internal = host === 'localhost' || (!host.includes('.') && !host.includes(':') && BARE_LABEL.test(host)) || isPrivateIpv4(host) || isPrivateIpv6(host);`
- Executed against a scratchpad copy of the real function:
  `ACCEPT | ai | http://ai/v1/update`, `ACCEPT | com | http://com/v1/update`,
  `ACCEPT | 192.168.1.9 | http://192.168.1.9:8080/v1/update`,
  `ACCEPT | watchtower | https://watchtower:8080/v1/update`.
- `src/lib/update/egress.ts:87-89`, with the comment it contradicts:
  `// fc00::/7 is fc.. or fd..; fe80::/10 is fe8./fe9./fea./feb.` /
  `if (/^f[cd][0-9a-f]{0,2}:/i.test(inner)) return true;` / `if (/^fe[89ab][0-9a-f]?:/i.test(inner)) return true;`
  Executed: `ACCEPT | [fc::1]`, `ACCEPT | [fd:1::1]`, `ACCEPT | [fe8::1]`.
- The over-claims: `README.md:287` "…never published to the host, so it is not a fourth egress
  destination"; `INSTALL.md:88-89` same sentence; `egress.ts:100-103` already concedes the hole in prose.

**Fix:** Tighten the hextet regexes at `egress.ts:87-89` to `/^f[cd][0-9a-f]{2}:/i` and
`/^fe[89ab][0-9a-f]:/i`. For (a), either soften `README.md:287` and `INSTALL.md:88-89` to
`.env.example`'s wording, or narrow the bare-label branch to an operator-listed service name rather than
any `BARE_LABEL`. Prove the IPv6 fix in `tests/lib/update/egress.test.ts` with cases asserting
`[fc::1]` and `[fe8::1]` are now rejected while `[fd00::1]` and `[fe80::1]` are still accepted.

**Effort:** S
**Confidence:** High

---

#### S-09 · Low · `/api/health` performs an unauthenticated filesystem write on every request, unrate-limited

**Where:** `src/app/api/health/route.ts:13-16`

**What:** `isDataDirWritable()` runs `mkdirSync` + `writeFileSync` + `rmSync` in the data directory on
**every** unauthenticated GET. Nothing rate-limits the route — `src/proxy.ts` applies no limiter and
the handler calls none. A remote caller who can reach the app can drive unbounded mkdir/write/unlink
churn against the NAS disk that also holds `budget.db`.

**Evidence:** `src/app/api/health/route.ts:13-16`:
`fs.mkdirSync(dir, { recursive: true });` / `` const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`); `` /
`fs.writeFileSync(probe, '');` / `fs.rmSync(probe, { force: true });` — with `export async function GET()`
at `:23` and no auth check in the file.

**Fix:** Memoise the writability verdict in a module-level variable with a short TTL (10–30 s is far
finer-grained than the 30 s healthcheck interval in `docker-compose.yml`), so repeated requests reuse
it. Prove it in `tests/api/health.route.test.ts` by spying on `fs.writeFileSync` and asserting two
back-to-back requests produce one write.

**Effort:** S
**Confidence:** High

---

#### S-10 · Low · Staged receipts have no aggregate quota; only a 24 h sweep

**Where:** `src/lib/warranty/staging.ts:78`

**What:** `MAX_RECEIPT_BYTES` (10 MB) and `MAX_FILES_PER_UPLOAD` (5) are per-request only. There is no
global or per-user ceiling on accumulated staged files, and the purge TTL is 24 h. Any authenticated
member can write ~50 MB per request, unbounded requests per day, into `${DATA_DIR}/tmp` — the same
volume that holds `budget.db`. Filling it takes the database down.

**Evidence:** `src/lib/warranty/staging.ts:78`
`` fs.writeFileSync(path.join(dir, `${stagingId}.${extForMime(mime)}`), buf); `` — no quota check
precedes it anywhere in the file (127 lines, read in full). `DEFAULT_TTL_MS = 24 * 60 * 60 * 1000` at
`src/lib/import/staging.ts:14`.

**Fix:** In `src/lib/warranty/staging.ts`, have `writeStagedReceipt` sum the staging directory's
existing bytes and throw `ReceiptStagingError` above a ceiling (1 GB is generous here), or call
`purgeStagedFiles` opportunistically on each stage request with a much shorter TTL for staged receipts.
Prove it in `tests/api/warranty-stage.route.test.ts` by pre-filling the staging dir past the ceiling
and asserting the next stage request is refused rather than written.

**Effort:** S
**Confidence:** High

---

#### S-11 · Low · The email `From` header interpolates `fromName` unquoted, so an admin-set name can inject a second address

**Where:** `src/lib/notify/send/email.ts:62`

**What:** `from` is built by string template with the display name inside hand-written quotes, and
`fromName` is validated for length only. A `"` closes the quoted display-name early: a `fromName` of
`A" <evil@example.com>, "B` yields `"A" <evil@example.com>, "B" <real@host>`, which nodemailer's
address parser reads as **two** addresses and re-emits as a two-address `From`. Bounded — the SMTP form
is admin-only and an admin already owns `fromEmail` — and CRLF does not escape, so this is hardening,
not a boundary crossing.

**Evidence:**
- `src/lib/notify/send/email.ts:62`: ``from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,``
- The schema at `src/app/(app)/settings/notifications/actions.ts:76` bounds length only:
  `z.string().min(1).max(64)` — no character class.
- Admin gate at `src/app/(app)/settings/notifications/actions.ts:163` `await requireAdmin(); // MUST-12.3`.
- CRLF is neutralised by the library: `node_modules/nodemailer/lib/mime-node/index.js:1378` tests
  `/^[\x20-\x7e]*$/` and forces anything failing it into an RFC 2047 encoded-word. nodemailer 9.0.5.

**Fix:** Hand nodemailer the structured form at `email.ts:62` so it does the quoting it already knows:
`from: { name: input.smtp.fromName, address: input.smtp.fromEmail }` (this routes through
`_encodeAddressName` → `mimeFuncs.quoteString`, which escapes `"` and `\`). Optionally add
`.regex(/^[^"\\\r\n]*$/)` to the `fromName` schema. Prove it in
`tests/app/notifications-actions.test.ts` (or the email transport unit test) with a `fromName`
containing `"`, asserting the captured `sendMail` argument's `from` resolves to a single address.

**Effort:** S
**Confidence:** High

---

#### S-12 · Low · Two admin server actions skip the app's own same-origin gate

**Where:** `src/app/(app)/settings/merchant-rules/actions.ts:249-254` (`previewRuleClearAction`),
`:440-444` (`previewRerunAllAction`)

**What:** Every other server action in the repo opens with
`if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };` before anything else — the
codebase states this as a binding rule and explains why Next's built-in Server Action origin check is
not considered a substitute (it is not `TRUST_PROXY`-aware). These two open with `await requireAdmin();`
and never call it. Both are read-only previews, both are admin-gated, and Next's own check still stands
behind them, so the practical exposure is small. The defect is that the stated invariant is not
actually uniform, which is how the next mutating action added beside them inherits the omission.

**Evidence:**
- `merchant-rules/actions.ts:249-254`: `export async function previewRuleClearAction(ruleId: number, from: string | null, to: string | null): Promise<...> { await requireAdmin();` — no `isSameOrigin`.
- `merchant-rules/actions.ts:440-444`: `export async function previewRerunAllAction(from: string | null = null, to: string | null = null): Promise<...> { await requireAdmin();` — no `isSameOrigin`.
- The invariant, stated at `src/app/(auth)/login/actions.ts:29-31`: *"Binding ruling: every mutating
  Server Action must call the same-origin check first thing, before any other logic — Next's own
  built-in Server Action origin check is not a substitute for this app's TRUST_PROXY-aware
  isSameOrigin."* I swept all 21 `'use server'` modules; these two are the only exceptions.

**Fix:** Add the check as the first statement of both, matching each function's own return shape
(`{ affected: 0, kind: null, error: CROSS_ORIGIN_ERROR }` and `{ eligible: 0, wouldChange: 0 }`).
Prove it in `tests/app/merchant-rules-actions.test.ts` with a cross-origin headers stub asserting the
refusal, matching the existing cross-origin cases in that file.

**Effort:** S
**Confidence:** High

---

#### S-13 · Low · `assertTelegramUrl` does not reject query or fragment, and nothing enforces its adjacency to the fetch

**Where:** `src/lib/notify/egress.ts:27-43`; `tests/ops/notify-egress.test.ts:179-182`

**What:** The Telegram guard checks origin, userinfo and pathname, but unlike its GitHub sibling it
checks neither `search` nor `hash`. Not exploitable today — both call sites build a fixed query, and a
token containing `?` or `#` truncates the pathname and fails `TELEGRAM_PATH_PATTERN` — but the guard
would not stop a future caller appending attacker-influenced query text. Related: the MUST-8.5
guard-adjacency scanner covers only `github.ts` and `watchtower.ts`, so nothing mechanically keeps
`telegram.ts`'s guard (`:62`) next to its fetch (`:68`).

**Evidence:**
- `src/lib/notify/egress.ts:27-43` — origin, userinfo and pathname checks only; no `search`/`hash`.
- The sibling that does check, `src/lib/update/egress.ts:47-49`:
  `if (parsed.hash !== '') { throw new Error('refusing a GitHub request carrying a fragment'); }`
- `tests/ops/notify-egress.test.ts:179-182`:
  `{ file: 'src/lib/update/github.ts', guard: 'assertGithubUrl(' },` /
  `{ file: 'src/lib/update/watchtower.ts', guard: 'assertWatchtowerUrl(' },` — `telegram.ts` absent.

**Fix:** Add `if (parsed.search !== '' || parsed.hash !== '') throw new Error(...)` to
`assertTelegramUrl` — note `fetchTelegramChats` builds a query, so either allowlist that exact query
string or move the guard to run on the origin+path portion. Add
`{ file: 'src/lib/notify/send/telegram.ts', guard: 'assertTelegramUrl(' }` to the adjacency list at
`tests/ops/notify-egress.test.ts:179-182`.

**Effort:** S
**Confidence:** High

---

#### S-14 · Low · TOTP code comparison is not constant-time

**Where:** `src/lib/auth/totp.ts:84,112` via `node_modules/@otplib/core/index.js:169,301`

**What:** `verifyTotp` and `verifyTotpCounter` delegate to otplib's `check`/`checkDelta`, which compare
the submitted token against the generated one with `===`. String equality short-circuits on the first
differing byte, so it is not constant-time. Practical exploitability is very low: a 6-digit code valid
for ~90 s, with every failure rate-limited through both lockout layers, and network jitter swamping a
nanosecond-scale difference. Reported because the audit asked, not because it is reachable.

**Evidence:**
- `src/lib/auth/totp.ts:84` `return totpAt(at).check(cleaned, secret);` and `:112`
  `const delta = totpAt(at).checkDelta(cleaned, secret);`
- `node_modules/@otplib/core/index.js:169` `return token === systemToken;` (in `hotpCheck`) and `:301`
  `return token === systemToken;` (in `totpCheck`).

**Fix:** If worth closing at all: in `src/lib/auth/totp.ts`, generate the expected token per candidate
step and compare with `crypto.timingSafeEqual(Buffer.from(cleaned), Buffer.from(expected))` after a
length check. Note this replaces otplib's `checkDelta`, which the code deliberately uses precisely to
avoid a hand-rolled comparison (`totp.ts:100-103`) — so the trade is explicit and reasonable to decline
with a comment instead. If changed, `tests/lib/totp.test.ts` should assert the accepted counter is
unchanged for a valid code and that a `window: 1` code one step old still verifies.

**Effort:** S
**Confidence:** High (that the comparison is `===`); Medium (that closing it is worth the churn)

---

#### S-15 · Low · Restore has no uncompressed-size or entry-count limit, and validates in a pass separate from extraction

**Where:** `scripts/restore-core.ts:344-345`, `:365`, `:371`, `:462`

**What:** Two small gaps in an otherwise very well-defended restore path. (a) `validateArtifact` checks
only "is a regular file" and "is not empty" — no maximum archive size, no total uncompressed-bytes
ceiling, no entry count cap, so a gzip bomb whose `budget.db` entry expands to hundreds of GB fills the
data volume. (b) `assertArchiveEntriesAreSafe` opens and parses the archive, and `tar.extract` then
opens and parses the *same path* again with no `filter` option — validation and extraction are not
atomic. Both are Low because the GUI can only restore a file the server itself wrote (the backups page
has no file input at all), so a hostile tarball requires shell access to the container.

**Evidence:**
- `scripts/restore-core.ts:344-345`:
  `if (!stats.isFile()) throw new RestoreError('That backup is not a regular file. Nothing was changed.'); if (stats.size === 0) throw new RestoreError('That backup is empty. Nothing was changed.');`
  — the whole of the size validation.
- `:365` `assertArchiveEntriesAreSafe(artifactPath); // MUST-12.6, before a byte is written` then `:371`
  `tar.extract({ file: artifactPath, cwd: probe, sync: true, preservePaths: false, strip: 0 });` —
  two reads of the same path, `filter` absent from both extract calls (`:371`, `:462`).
- GUI cannot supply an archive: `src/lib/backup/restore.ts:365-372` resolves only names matching
  `ARCHIVE_NAME_RE` inside `backupsDir()`, and `src/app/(app)/settings/backups/` contains no file input
  (only `actions.ts`, `backups-client.tsx`, `page.tsx`).

**Fix:** Add a `MAX_ARCHIVE_BYTES` check beside `restore-core.ts:345`, and accumulate `entry.size` plus
an entry counter inside `assertArchiveEntriesAreSafe`'s `onReadEntry` (`:86-108`), throwing
`RestoreError` past a total-uncompressed and an entry-count ceiling. For (b), extract the per-entry
predicate into a shared `isAllowedEntry(entry)` and pass it as `filter` to both `tar.extract` calls.
Prove it in `tests/ops/restore-seams.test.ts` with a fixture tarball declaring an oversized entry,
asserting `RestoreError`.

**Effort:** M
**Confidence:** High

---

#### S-16 · Low · Pack schemas have unbounded arrays and the conflict scan is quadratic

**Where:** `src/lib/packs.ts:251-252`, `:475-487`

**What:** `categories` and `rules` are `z.array(...)` with no `.max(n)`, and `previewRulesPackImport`
calls `existing.find(...)` inside a loop over every pack rule — O(pack × existing). A 5 MB pack holds
tens of thousands of rules. Admin-only and (with `Content-Length` present) bounded by `MAX_FILE_BYTES`,
so Low — but it compounds S-05, where that bound is skippable.

**Evidence:** `src/lib/packs.ts:251-252` `categories: z.array(packCategorySchema),` /
`rules: z.array(packRuleSchema),` and `:487` `const match = existing.find(` inside the loop opened at `:475`.

**Fix:** Add `.max(5000)` to both arrays at `src/lib/packs.ts:251-252`, and build a `Map` keyed by
`ruleKeyOf(row)` before the loop instead of calling `existing.find` inside it. Prove the cap in
`tests/api/packs.route.test.ts` with a pack of 5001 rules asserting a validation refusal.

**Effort:** S
**Confidence:** High

---

### Verified clean

### Bearer credentials (scope 1)

- SimpleFIN access URL is AES-256-GCM at rest under an HKDF-derived per-purpose key, decrypted only at
  the moment of use — `src/lib/simplefin/crypto.ts:26-41`, `src/lib/simplefin/connection.ts:106-110`.
- The URL's embedded basic-auth credentials are moved out of the URL into an `Authorization` header
  before any fetch, so the URL that could appear in an error or a log carries no credential —
  `src/lib/simplefin/client.ts:78-94`, used at `:129-132`.
- `getConnection()` projects the encrypted column away; the claim route returns only `claimedAt` and
  `enabled` — `src/lib/simplefin/connection.ts:70-81`, `src/app/api/simplefin/claim/route.ts:33-34`.
- Telegram bot token and SMTP password: same AES-256-GCM construction under two distinct HKDF info
  strings, so neither is interchangeable with the other or with a TOTP secret —
  `src/lib/notify/crypto.ts:15-16,37-43`.
- The notifications page hands the client `passwordSet` / `secretSet` booleans, never the values —
  `src/lib/notify/config.ts:77-78,96,196-197,220`, `src/app/(app)/settings/notifications/page.tsx:120-125`.
  I specifically chased the household path, where `listHouseholdTargets()` uses a bare `.select()` that
  fetches every column including `secret_encrypted`: the projection `toRow`
  (`src/lib/notify/household.ts:62-76`) drops it and emits
  `secretSet: (row.secretEncrypted ?? '').length > 0`, so no ciphertext reaches the RSC payload.
- Every string written to `last_error`, to `console.error`, or returned to the browser from a send path
  passes `scrubSecrets` — `src/lib/notify/crypto.ts:87-97`, applied at
  `src/lib/notify/send/telegram.ts:31-33,77,87,139,147,157`, `src/lib/notify/send/email.ts:71-74`
  (which also scrubs the base64 AUTH PLAIN payload nodemailer quotes back, via `authPlainBase64`), and
  centrally at `src/lib/notify/outbox.ts:359-366`.
- The Watchtower token is sent as a header, never a query string — `src/lib/update/watchtower.ts:168`
  `` headers: { Authorization: `Bearer ${config.token}` }, ``, asserted by
  `tests/lib/update/watchtower.test.ts:90-91`. `tests/ops/notify-egress.test.ts:276-279` enforces that
  exactly one `Authorization` literal exists in all of `src/lib/update/` and that it is this line, and
  `:273` guards against any `console.*` interpolating a token. Every error string reaching the DB,
  console or browser is scrubbed with the token (`watchtower.ts:151-153,176,183`; `check.ts:62,95`),
  proved by `tests/lib/update/watchtower.test.ts:106-112`.
- No `Authorization`, cookie or telemetry field is sent to GitHub at all —
  `src/lib/update/github.ts:73-82`; the `User-Agent` at `:80` carries product + version only.
- A credential decrypt failure logs only `{ info, reason: error.name }`, never the payload —
  `src/lib/notify/crypto.ts:58-64`. Same discipline for TOTP at `src/lib/auth/login.ts:109`.
- The sync-failure notification reads `error.message` only, never `.stack` or a re-serialised error —
  `src/lib/notify/raise.ts:213-231`, reasoning written out at `:212-219`.
- The audit log is structurally incapable of holding a secret: no request body, no IP, one short
  sentence, and no update or delete anywhere in `src/` (asserted by
  `tests/ops/visibility-invariants.test.ts:166-185`) — `src/lib/audit.ts:6-38`.
- I enumerated all 101 `console.*` calls under `src/` and traced every one that receives an error
  object on a credential-carrying path. None passes a secret.

### Authorization (scope 2)

- All 20 API routes require a session (`userFromRequest` + 401), checked individually. The admin-only
  ones do check `role !== 'admin'`: backup download, both packs exports, both packs imports, and all
  four SimpleFIN routes.
- Receipt image serving is correctly ownership-checked and does not leak existence —
  `src/app/api/warranties/receipts/[id]/route.ts:72-73`
  `const item = getWarrantyItem(receipt.warrantyItemId, user); if (!item || !canActOnOwner(item.ownerUserId, user)) return new Response('Not found', { status: 404 });`
  — 404, byte-identical to the unknown-id case, with the reasoning at `:69-71`. This was flagged as a
  prime candidate; it is correct.
- The staging poll route resolves an unguessable UUID and returns OCR suggestions only, never the raw
  text — `src/app/api/warranties/receipts/stage/[stagingId]/route.ts:33-40`.
- Import commit and undo both refuse a self-scoped viewer outright, and undo additionally checks
  `canActOnOwner(record.importedBy, user)` — `src/app/api/import/commit/route.ts:31`,
  `src/app/api/import/undo/route.ts:24,36-41`.
- Every write action in `src/app/(app)/transactions/actions.ts` resolves its target through the viewer:
  `allTransactionsVisible` (`:80-87`) on the bulk paths (`:361,403,417,438,491,522`) and
  `getTransaction(id, user)` on the single-row paths (`:211,263,461,742,868,959,981,1056`).
- Budget scope writes check `userId !== user.id && user.role !== 'admin'` for personal scope and
  `user.role !== 'admin'` for household scope — `src/app/(app)/budgets/actions.ts:46,74,170,210,255,258`.
- Goals and bills gate on `canActOnOwner` at every mutation —
  `src/app/(app)/goals/actions.ts:32,69,91,109`, `src/app/(app)/bills/actions.ts:63,118`.
- Update actions accept no `userId`; the actor id comes from the session and the version is re-checked
  against server state before acting — `src/app/(app)/settings/actions.ts:211-215,239,331-333`.

### CSRF (scope 3)

- All 8 mutating API routes call `assertSameOrigin(request)` as their first statement and return 403 on
  `CsrfError`: auth/logout, import commit/preview/raw-preview/undo, packs rules+profiles import,
  simplefin claim/link/sync, warranties receipts stage.
- 19 of 21 `'use server'` modules call `isSameOrigin(await headers())` before auth, before validation
  and before any read — S-12 covers the two that do not.
- **The `TRUST_PROXY` bypass does not exist.** `X-Forwarded-Host` is honoured only when `TRUST_PROXY`
  is on — `src/lib/auth/csrf.ts:31`
  `const host = env.trustProxy ? (headers.get('x-forwarded-host') ?? headers.get('host')) : headers.get('host');`
  with the reasoning at `:26-29`, so a client-settable header cannot spoof a matching Host.
- The relaxed `isSameOriginOrHeaderless` is confined to read-only auth-gated download GETs and still
  refuses a present-but-mismatched header; `Origin: null` counts as present —
  `src/lib/auth/csrf.ts:71-77`.

### Session and auth hardening (scope 4)

- Cookie is `httpOnly: true, sameSite: 'lax', path: '/'`, with `secure` resolved from the real request
  protocol or `X-Forwarded-Proto` only under `TRUST_PROXY` — `src/lib/auth/session.ts:144-166`.
- No session fixation: a fresh 32-byte `base64url` token per login, and only its SHA-256 hash is stored
  — `src/lib/auth/session.ts:27-33,35-60`.
- Sessions are invalidated on every credential change: self password change destroys all others
  (`src/app/(app)/settings/actions.ts:104-105`), forced change does the same
  (`src/app/(auth)/change-password/actions.ts`), admin password reset destroys all
  (`src/app/(app)/settings/users/actions.ts:87`), admin MFA reset destroys all (`:104`). Withdrawn login
  rights are refused at read time — `src/lib/auth/session.ts:89`.
- Rate limiting is keyed on nothing a client controls when `TRUST_PROXY` is off: `x-real-ip` and
  `x-forwarded-for` are read only under `TRUST_PROXY`, and whatever survives is validated as an address
  and length-bounded before it can reach `sessions.ip` or a notification —
  `src/lib/auth/ratelimit.ts:157-198`. Two layers, (username, ip) and username-only with exponential
  backoff — `:98-133`. The forged-header partitioning attack this replaced is documented at `:172-185`.
- Login pays a constant argon2 cost on the unknown / deactivated / no-login path, so there is no timing
  enumeration oracle — `src/lib/auth/login.ts:21,72-79`. Lockout is re-checked after verification to
  close the concurrent-overshoot window — `:89-92`. A wrong TOTP code takes the same `fail()` path and
  therefore counts toward both lockout layers — `:122-127`.
- argon2id, 64 MiB, t=3, p=1 — `src/lib/auth/password.ts:8-13`. Meets OWASP guidance.
- TOTP codes are single-use via an atomic conditional UPDATE, closing the ~90 s replay window; recovery
  codes likewise — `src/lib/auth/totp.ts:133-140,174-189`. Recovery codes are 16 base32 chars (~80 bits),
  so the unsalted SHA-256 at `:158-160` is the right call.

### Raw SQL (scope 5) — audited in full, no findings

- `sql.raw`, `sql.identifier`, `sql.join` and `sql.fromList` do not exist anywhere in `src/`, `scripts/`
  or `drizzle/`. That absence removes the injection class by construction, since `sql.raw` is the only
  Drizzle API that promotes a string into query text.
- All **138** Drizzle `sql` template sites across 30 files were reviewed. (The naive `` sql` `` grep
  misses generic-typed templates like `` sql<number>` `` and reports only 58; the corrected pattern
  finds 138.) Every one interpolates either a Drizzle column/table object or a JS value that Drizzle
  binds as a parameter.
- The one dynamic `ORDER BY` is allow-listed twice — at the page boundary
  (`src/app/(app)/warranties/page.tsx:30`) and again inside the query builder
  (`src/lib/warranty/search.ts:201`) against `WARRANTY_SORTS`
  (`src/lib/warranty/constants.ts:245-247`). `src/lib/transactions.ts:426-445` returns Drizzle
  `asc()`/`desc()` objects from a `switch`, so no string reaches ORDER BY there at all.
- The only literal concatenation into query text is `VACUUM INTO` at `src/lib/backup/archive.ts:73`,
  whose target is `resolveSafeTarget(tmp, \`${randomUUID()}.db\`, SNAPSHOT_NAME_RE)` — no user input
  reaches it, and the quote-doubling is correct SQLite escaping regardless.
- LIKE is escaped with an explicit ESCAPE clause: `src/lib/transactions.ts:279-281` escapes the escape
  character first, then `%` and `_`, and `:357` supplies `escape ${LIKE_ESCAPE}` as a bound parameter.
  Regression test at `tests/lib/transactions.test.ts:176`. Merchant-rule matching never touches LIKE —
  it is JS `===`/`includes` (`src/lib/categorize/rules.ts:144-149`) and `instr()` with a bound parameter
  (`src/lib/loans.ts:772`) — so the ReDoS avenue is closed too.
- FTS5 input is a bound parameter (`src/lib/warranty/search.ts:219`) with correct phrase escaping and a
  NUL/control-character scrub in front of it.

### File handling (scope 6)

- Tar extraction is guarded by a strict entry allow-list running before a byte is written: symlinks,
  hardlinks and device nodes rejected (`scripts/restore-core.ts:88-91`), absolute paths and `..`
  segments rejected (`:92`), and only three exact shapes accepted (`:96-107`). Both `tar.extract` calls
  pass `preservePaths: false, strip: 0`. Backup creation uses `follow: false`
  (`src/lib/backup/archive.ts:132`).
- The allow-list actually fires: `onReadEntry` is a real option in the pinned tar 7.5.22
  (`node_modules/tar/dist/esm/options.d.ts:257`). Worth checking — tar 6 named it `onentry`, and a
  silent rename would have made the whole defence a no-op.
- Restore never overwrites in place: everything is built under a scratch dir and committed by rename,
  with the live DB moved aside rather than deleted (`scripts/restore-core.ts:487`). The payload is
  validated by magic bytes, `PRAGMA quick_check` and a required-table check (`:295-318`), format is
  detected by magic bytes not extension (`:65-66`), and a tampered `commit.json` cannot become a rename
  primitive (`src/lib/backup/restore.ts:143`). Restore is admin-gated with origin-first ordering
  (`src/app/(app)/settings/backups/actions.ts:64,68`).
- Receipt type is decided by leading bytes only, never by extension or the browser's Content-Type —
  `src/lib/warranty/sniff.ts:48-61`, `src/app/api/warranties/receipts/stage/route.ts:90`, re-sniffed at
  commit (`src/lib/warranty/items.ts:665`).
- On-disk receipt names are server-generated UUIDs (`src/lib/warranty/receipts.ts:54`) and every path is
  double-guarded by a name regex plus a resolved-dirname equality check (`:41,46`), including the
  adoption source (`:68`) — which stops `adoptReceiptFile` being pointed at `budget.db`.
- Stored XSS via an uploaded receipt is closed on three levels: `Content-Type` is the stored mime
  (`receipts/[id]/route.ts:108`) constrained by a DB CHECK to four values
  (`drizzle/0002_warranty_tracker.sql:66`); PDFs are forced to `attachment` by an inline allow-list
  (`receipts/[id]/route.ts:19,95-97`); and `X-Content-Type-Options: nosniff` genuinely reaches `/api/*`
  (`src/lib/auth/security-headers.ts:53` plus the proxy matcher at `src/proxy.ts:128`).
- The `Content-Disposition` filename cannot carry a traversal token or a header break —
  `receipts/[id]/route.ts:41-43` strips to `[A-Za-z0-9._-]`, collapses `\.{2,}` to `_`, caps at 100.
- No prototype pollution in pack import: every field passes a zod object schema in default *strip* mode
  (`src/lib/packs.ts:132-138,150-189,248-254,270-281`), and grepping that file plus
  `src/lib/import/mapping.ts` for `passthrough`, `z.record`, `z.any`, `z.unknown`, `Object.assign` and
  `__proto__` returns zero hits. Deep-nesting bombs are rejected up front (`src/lib/packs.ts:224-244`).
- No zip/unzip/decompress library exists anywhere; `tar` is the only archive reader. No server action
  touches `fs`. Every request-derived path under `src/app/api/**` resolves through a UUID or a validated
  integer id.

### XSS and notification injection (scope 7)

- One `dangerouslySetInnerHTML` in the entire repo, `src/components/theme/theme-script.tsx:18`, whose
  content is a module constant interpolating only `JSON.stringify('bt-theme')`
  (`src/components/theme/theme.ts:11`). No user data reaches it.
- Zero hits for `insertAdjacentHTML`, `srcdoc`, `createContextualFragment`, `Function(` or `eval(`.
- No `javascript:` URL surface: every dynamic `href` is root-relative with a hard-coded path prefix and
  a `URLSearchParams`-encoded query (e.g.
  `src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx:69`), so the string can never begin
  with a scheme. `src/db/schema.ts` has no user-supplied URL column to render as a link.
- **Telegram sends no `parse_mode`** — `src/lib/notify/send/telegram.ts:71` posts
  `{ chat_id, text, disable_web_page_preview }` and nothing else, so a merchant literally named `<b>`
  or `_x_` or `[a](url)` renders as those characters and cannot alter or reject the message. A
  repo-wide grep for `parse_mode|parseMode|MarkdownV2` returns exactly one hit: the comment at `:50`
  saying there is none. No escape helper is needed because no markup mode is in use.
- **Email sends no HTML body** — `src/lib/notify/send/email.ts:61-66` passes `text` only. Subject CRLF
  injection is neutralised by nodemailer's own `_encodeHeaderValue`
  (`node_modules/nodemailer/lib/mime-node/index.js:1259`), which replaces `/\r?\n|\r/` with a space.
- Every user- or import-derived string reaching `src/lib/notify/render.ts` is length-bounded by
  `truncateText(value, 80)` before interpolation (~20 call sites), `userAgent` at 120, and `ip` is
  pre-validated by `clientIpFromHeaders`.
- The untrusted GitHub changelog renders through `src/components/render-emphasis.tsx:13`, which returns
  React text nodes and `<strong>` elements only — no HTML sink.

### Outbound-URL restriction (scope 8) — bypasses tested and blocked

Executed against a scratchpad copy of `src/lib/update/egress.ts` (39 hostile URLs), plus
`npx vitest run tests/lib/update/egress.test.ts tests/lib/notify/egress.test.ts tests/lib/update/watchtower.test.ts`
→ 32 passed:

- `2130706433`, `0x7f.1`, `127.1`, `0177.0.0.1` normalise to `127.0.0.1` and are accepted as loopback —
  correct, these *are* loopback, not a bypass. The public decimal form `134744072` → `8.8.8.8` is
  **rejected** (pinned by `tests/lib/update/egress.test.ts:123-125`).
- `::ffff:127.0.0.1` (IPv4-mapped) is **rejected** — it fails closed. `::ffff:8.8.8.8` and
  `::ffff:192.168.1.1` are also rejected, so there is no mapped-address bypass in either direction.
- `64:ff9b::8.8.8.8` (NAT64) **rejected**. `[2606:4700::1]`, `[fec0::1]`, `100.64.0.1`, `0.0.0.0`,
  `8.8.8.8` all **rejected**.
- `localhost.` (trailing dot) is **rejected** — `egress.ts:126` `host === 'localhost'` is exact, and the
  `.` disqualifies the bare-label branch. Uppercase `LOCALHOST` is accepted because WHATWG lowercases
  the domain first — correct handling, not a bypass.
- Userinfo `http://watchtower@evil.com/` **rejected** (`egress.ts:115-117`,
  `tests/lib/update/egress.test.ts:127-129`), and so is the reverse form `http://evil.com@watchtower/`.
- Path `/v1/update/`, `//v1/update`, query `?x=1`, fragment `#x`, and `ftp://` all **rejected**
  (`egress.ts:112-114,118-123`).
- `redirect: 'error'` is set on **all five** outbound call sites — `watchtower.ts:169`,
  `github.ts:120` and `:165`, `telegram.ts:72` and `:135` — so no credential can be carried to a second
  host by a 3xx. (S-03 is about the *classification* of that refusal; the refusal itself works.)
- `assertGithubUrl` pins the full origin, rejects userinfo and fragments, and pins two exact pathnames
  plus an anchored `^\?ref=v\d+\.\d+\.\d+$` query (`egress.ts:32-61`), with
  `tests/lib/update/egress.test.ts:30-74` covering prefix-walking, `%2e%2e`/`%2F` traversal,
  protocol-relative URLs and duplicate/reordered `ref`.
- Telegram path smuggling is defeated by the anchored `^\/bot[^/]+\/(sendMessage|getUpdates)$` at
  `src/lib/notify/egress.ts:25`, which catches a token like `123:abc/../../@evil.com` that `new URL()`
  would otherwise collapse — pinned by `tests/lib/notify/egress.test.ts:28-33`.
- DNS rebinding is structurally out of scope for `assertWatchtowerUrl`, which is a pure string check by
  design (`egress.ts:98-99`), and this is acceptable because `WATCHTOWER_URL` is never
  attacker-controlled: the only readers repo-wide are `src/lib/env.ts:188` and
  `src/lib/update/watchtower.ts:70` — no DB column, no settings row, no UI writer.

### Health endpoint (scope 9)

- The 200 body carries no version — `src/app/api/health/route.ts:68` and
  `tests/api/health.route.test.ts:70-78` (`expect('version' in body).toBe(false)`). No user counts, no
  row counts, no env values, no hostname, no uptime, no setup flag, and no stack trace anywhere in the
  route (only `.message`, never `.stack`).
- The dataDir 503 branch already uses a fixed string — `route.ts:60`
  `error: 'data directory is not writable',`. S-04 is only about the DB branch.

### Headers and deployment (scope 10)

- A full header set is applied to every response including `/api/*` —
  `src/lib/auth/security-headers.ts:48-63`: CSP with a per-request nonce, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, and a `Permissions-Policy` denying
  camera/microphone/geolocation. **Nothing is absent.** HSTS is correctly conditional on a real HTTPS
  connection (`:60-62`) — unconditional HSTS would brick the documented plain-HTTP LAN install.
- The nonce is freshly generated per request and forwarded to the root layout via `x-nonce` —
  `src/proxy.ts:56-62,102-109`. `'unsafe-inline'` is present only as a legacy fallback that nonce-aware
  browsers ignore, and `'wasm-unsafe-eval'` is scoped to the scanner's WebAssembly need and does not
  re-enable `eval`.
- `poweredByHeader: false` in `next.config.ts`.
- Container hardening is real: `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`,
  `tmpfs /tmp` with `noexec,nosuid`, and `USER node` (`docker-compose.yml`, `Dockerfile:118`).
- `.dockerignore` excludes `.superpowers`, `real-statements/`, `.git`, `docs` and `tests` from the
  public GHCR image, with `tests/ops/docker.test.ts` asserting it stays that way. `real-statements/` is
  also gitignored.
- `SECRET_KEY` is generated with `mode: 0o600` and exclusive-create (`'wx'`) so a boot race cannot
  clobber it, and a present-but-too-short key is a hard error, never silently regenerated —
  `src/lib/env.ts:78-138`.

### Unconfirmed

- **Whether the SimpleFIN `Basic` credential actually follows a cross-origin redirect (S-07).** The
  missing `redirect: 'error'` is proven by reading `src/lib/simplefin/client.ts:51-54`. What is *not*
  proven is what a `https → http://192.168.x.x` hop transmits: the fetch spec requires
  `Authorization` to be stripped on a cross-origin redirect, and undici implements that, so the bank
  credential itself most likely does **not** follow the hop — leaving the residual risk as an
  admin-authenticated SSRF reflection primitive rather than credential exfiltration. S-07 is written to
  that narrower claim. *To confirm:* stand up a local server issuing a `302` from an https claim
  endpoint to a plain-http private address, point `claimSetupToken` at it, and inspect the second
  request's headers.
- **Whether the path-bearing `env.ts` messages actually reach the wire in S-04.** The
  `src/lib/env.ts:80-81` and `:102`/`:113` messages are reachable *on the code path*
  `getSqlite() → databasePath() → readEnv()`, traced by reading. The `src/db/client.ts:78-80` orphan
  message and the SQLite `no such table` message were both confirmed by direct probe; these two were
  not. *To confirm:* set `DATA_DIR` to a directory containing a 4-byte `secret.key`, clear the
  module-level `cachedKeyPath` (`env.ts:96`), and `GET /api/health`, asserting the response `error`
  contains the path.
- **`claimSetupToken` network errors are not wrapped.** `src/lib/simplefin/client.ts:97-99` calls
  `fetcher(claimUrl, ...)` with no try/catch, and `decodeSetupToken` (`:57-75`) validates only that the
  decoded value starts with `https://` — it never runs `new URL()`. A malformed-but-https setup token
  would therefore make undici throw `TypeError: Failed to parse URL from <claimUrl>`, which is not a
  `SimplefinError`, so `src/app/api/simplefin/claim/route.ts:37` rethrows and Next logs the full message
  server-side. The claim URL is a one-shot credential, so the value of that log line is near zero, and I
  did not execute the path to confirm undici's exact message on Node 22. *To confirm:* call
  `claimSetupToken(Buffer.from('https://a b c').toString('base64'))` in a scratch script and inspect the
  thrown error's `message`. If it does embed the URL, wrap the `fetch` at `client.ts:99` and rethrow as
  `SimplefinError('claim_failed', ...)`.
- **Dotless-TLD resolvability (S-08).** `http://ai/v1/update` and `http://com/v1/update` are provably
  *accepted by the guard* (executed). Whether they resolve to a routable address depends on the
  container's resolver and `search` domains, which was not tested. This affects how bad the over-claim
  is, not whether it is one.
- **Setup-completeness is disclosed unauthenticated, by design, on a different route.** `src/proxy.ts:43`
  puts `'/'` in `PUBLIC_PREFIXES` and `src/app/page.tsx:7`
  `redirect(isSetupRequired() ? '/setup' : '/dashboard');` — so an unauthenticated `GET /` reveals by its
  redirect target whether the install is unclaimed and therefore takeable. `/api/health` itself is clean
  of this. Noting it because it is the exact disclosure the brief asked about, just on another route,
  and it is deliberate (`proxy.ts:31-33`): the root path has to run unauthenticated to be a
  setup-vs-login dispatcher at all. Closing it would mean a different first-run design, not a patch.
- **Newlines in user-supplied names are cosmetic today.** `truncateText`
  (`src/lib/notify/render.ts:22-25`) bounds length but does not strip `\n`, so a category name with a
  newline breaks the column alignment of `padded()` (`:321`) in a digest. In plain-text Telegram and a
  `text`-only email this has no security consequence, and nodemailer collapses it in a subject. It would
  matter only if a markup mode were added. `.replace(/\s+/g, ' ')` inside `truncateText` would close it
  pre-emptively.

---

## §B — Data-correctness lane (Opus)

### Summary

Twelve confirmed findings: 2 High, 3 Medium, 7 Low. Both High findings are the same shape —
a spend rule that is enforced on one surface and not on its sibling, so the Budgets page and
the Reports page report different numbers for the same month from the same rows.

**Fix first: C-01.** Archiving a top-level category silently deletes its whole subtree from
`budgetProgress`, even when its children are un-archived and still carry spend *and* limits.
Measured: an $800 month with a $500 Groceries limit collapses from
`{limit 50000, spent 60000, total 80000}` to `{0, 0, 0}` the instant the parent is archived,
while Reports still reports the same $600 of Groceries spend. It also silently stops every
budget-threshold and pace notification for those children.

C-02 is second: the loan-principal exclusion lives only in `reports.ts`, so a lent-loan
repayment filed against a category shows on Budgets as a $5,950 phantom refund.

Invariants: I1 has 2 violations, I2 has 2, I3 has 1 (the C-02 family), I4/I5/I6 hold.
Suspects 2, 4, 5, 6, 7, 8, 10 cleared; 1, 3 (partially), 9 produced findings.

---

### Findings

#### C-01 · High · Archiving a parent category erases its live children from every budget number and every budget alert

**Where:** `src/lib/budgets.ts:527-531` (`budgetProgress`)

**What:** `budgetProgress` walks top-level categories and drops an archived one unless it
carries direct spend of its own:

```
.filter((category) => category.parentId === null)
.filter((category) => !category.isArchived || (spendByCategory.get(category.id) ?? 0) !== 0)
```

`spendByCategory` is the *raw per-category* map — a category's own transactions only, never
the rollup. A parent whose spend all sits in its children reads as 0 here and the entire
subtree is dropped before the child-level filter one line below (`budgets.ts:536-541`, which
*does* correctly keep a child that still has a limit or spend) ever runs. `archiveCategory`
(`src/lib/categories.ts:88-90`) has no cascade and no guard — it is a bare
`update categories set is_archived = ?` reachable from Settings → Managers
(`src/app/(app)/settings/managers/actions.ts:91`), so archiving a parent while its children
stay active is a one-click operation.

Everything downstream of `budgetProgress` inherits the hole: the Budgets page and its header
totals, `budgetTotals` (so `safeToSpend().budgetedRemainingCents` on the dashboard's Coming-up
card, `src/lib/bills.ts:199-200`), the monthly digest's budgeted pair
(`src/lib/notify/evaluate/monthly.ts:197`), `predicted_vs_actual`
(`monthly.ts:69`), the weekly digest's over-budget list
(`src/lib/notify/evaluate/digest.ts:108`), the budget-threshold evaluator
(`src/lib/notify/evaluate/budget.ts:241,247`) and the pace evaluator
(`src/lib/notify/evaluate/pace.ts:116-117`). Reports (`categoryBreakdown`, `cashflowTrend`)
is unaffected, so the two surfaces disagree.

**Evidence:** ran against a seeded tree (Food → Groceries, Restaurants), March 2026:
$600 Groceries, $200 Restaurants, Groceries household limit $500.

```
BEFORE archiving Food : {"budgetedLimitCents":50000,"budgetedSpentCents":60000,"totalSpentCents":80000}
AFTER  archiving Food : {"budgetedLimitCents":0,"budgetedSpentCents":0,"totalSpentCents":0}
  Food row present?   : false
  Groceries row found?: false
  categorySpend still sees Groceries: 60000
  reports categoryBreakdown Groceries: 60000
```

Wrong output: Budgets says the household budgeted $0.00 and spent $0.00.
Right output: `{budgetedLimit 50000, budgetedSpent 60000, totalSpent 80000}` — unchanged by
archiving a parent whose children are still live. Groceries is $100 over its limit and no
`budget_threshold` notification will ever fire for it again.

**Fix:** in `src/lib/budgets.ts`, make the top-level archived filter ask the same question the
child-level one already asks, over the rollup rather than the direct map. Concretely, keep an
archived parent when `foldRollup(category.id, allChildren.map(c => c.id), spendByCategory) !== 0`
**or** any child survives the existing `budgets.ts:536-541` predicate — i.e. compute
`allChildren`/`renderChildren` before the archived test, not inside `.map()`. Test:
`tests/lib/budgets.test.ts`, new case "an archived parent keeps its live children's rows and
limits" asserting `budgetTotals(budgetProgress('2026-03'))` is
`{budgetedLimitCents: 50000, budgetedSpentCents: 60000, totalSpentCents: 80000}` both before
and after `archiveCategory(food, true)`, and that the Groceries child row is still present.

**Effort:** S **Confidence:** High

---

#### C-02 · High · The loan-principal exclusion is enforced in reports.ts only, so Budgets counts money the Reports page does not

**Where:** `src/lib/reports.ts:93-116` (`NOT_PRINCIPAL_MOVEMENT`, `rangeClauses`) vs
`src/lib/budgets.ts:148-155` (`categorySpend`), `src/lib/budgets.ts:282-289`
(`categorySpendWithRollupSeries`), `src/lib/predict/history.ts:57-66` (`cells`),
`src/lib/tax.ts:97` (`taxYearReport`)

**What:** v1.21.0 item 8a established the rule that three of the four loan movements
(lending out, being repaid on a lent loan, borrowing on an owed loan) are principal, not
spend or income. `NOT_PRINCIPAL_MOVEMENT` implements it, and `rangeClauses` applies it to
every `reports.ts` aggregate. No other module applies it. `budgets.ts`, `predict/history.ts`
and `tax.ts` filter on `is_transfer = 0` only.

A loan-linked transaction is *not* excluded from auto-categorization — `ELIGIBLE`
(`src/lib/categorize/engine.ts:146-149`) only excludes rows that already have a category or
splits; the loan-payments `not exists` guard lives in `REVIEW_WHERE`
(`engine.ts:1244-1247`), which governs the review queue, not eligibility. So an
"E TRANSFER" row picks up a category from a rule or Bayes at import and *then* gets linked to
a loan — the exact path that makes this divergence common rather than exotic.

**Evidence:** ran two cases in March 2026.

*Case 1 — lending $6,000 out on a `lent` loan, transaction filed under Groceries:*
```
 reports categoryBreakdown  : 0
 reports cashflowTrend spend: 0
 budgets categorySpend      : 600000
 budgets budgetTotals spent : 600000
```
Wrong output: the Budgets page shows Groceries at $6,000.00 spent against a $500.00 limit
(1200% over, a `budget_over` notification fires). Right output: $0.00, matching Reports.

*Case 2 — $50.00 of real Groceries spend, plus a $6,000 repayment on a `lent` loan that the
categorizer had filed under Groceries:*
```
 reports Groceries spend: 5000    budgets Groceries spend: -595000
```
Wrong output: Budgets reports Groceries as **−$5,950.00** — a phantom refund that wipes out
the category, and (with rollover on) manufactures a $5,950 carry into next month via
`effectiveBudget`'s `carry = max(0, carry + base - spent)` walk (`budgets.ts:451-456`).
Right output: $50.00.

Both numbers land on the dashboard side by side: the "Spent this month" tile reads
`cashflowTrend` (`src/app/(app)/dashboard/page.tsx:141,245`) while the Budgets card below it
reads `budgetProgress` (`page.tsx:99`).

**Fix:** export `NOT_PRINCIPAL_MOVEMENT` from `src/lib/reports.ts` (or lift it to a small
shared module so `budgets.ts` does not import `reports.ts`) and push it into the clause arrays
at `budgets.ts:148-155`, `budgets.ts:282-289`, `budgets.ts:207-213` (`categoryTransactions`,
so the drill-down still lists exactly the rows its total summed), `predict/history.ts:57-66`
and `tax.ts:97`. Test: `tests/lib/budgets.test.ts`, mirroring the five cases already in
`tests/lib/reports.test.ts:778-845` — assert `categorySpend('2026-03').get(groceries)` is `0`
for a categorized lend-out, `5000` for the repayment case, and still `50000` for the
MUST-13.2 owed-loan repayment that must stay spend.

**Effort:** M **Confidence:** High

---

#### C-03 · Medium · normalizeMerchant leaves a city fragment glued to every two-word Canadian city, and the value is stored

**Where:** `src/lib/categorize/normalize.ts:146-150`

**What:** The trailing `CITY PROVINCE` strip pops exactly two tokens — one for the province,
one for "the city" — with no loop and no multi-word city list:

```
if (tokens.length >= 2 && PROVINCE_SET.has(tokens[tokens.length - 1])) {
  tokens.pop();
  if (tokens.length >= 2) tokens.pop();
}
```

Every two-word Canadian city therefore leaves its first word attached to the merchant name.

**Evidence:** ran `normalizeMerchant` directly:

| input | actual | should be |
|---|---|---|
| `IRVING #1042 SAINT JOHN NB` | `IRVING SAINT` | `IRVING` |
| `TIM HORTONS #123 THUNDER BAY ON` | `TIM HORTONS THUNDER` | `TIM HORTONS` |
| `LOBLAWS 1042 QUEBEC CITY QC` | `LOBLAWS 1042 QUEBEC` | `LOBLAWS` |
| `SHELL C12345 RICHMOND HILL ON` | `SHELL RICHMOND` | `SHELL` |
| `METRO #55 NORTH YORK ON` | `METRO NORTH` | `METRO` |
| `NO FRILLS ST CATHARINES ON` | `NO FRILLS ST` | `NO FRILLS` |
| `PETRO CANADA NIAGARA FALLS ON` | `PETRO CANADA NIAGARA` | `PETRO CANADA` |
| `STARBUCKS #4 TORONTO ON` (control) | `STARBUCKS` | correct |
| `WALMART CALGARY AB` (control) | `WALMART` | correct |

The single-word-city controls are correct, which is why this survives ad-hoc testing. The
visible damage is on Reports → Top merchants and the weekly/monthly digest merchant lines
(`src/lib/reports.ts:571`, `digest.ts:102`, `monthly.ts:198`), where one chain splits into a
row per city, and on merchant rules, whose patterns are matched against this stored text.

**Backfill required: yes.** `normalized_merchant` is a stored `NOT NULL` column
(`src/db/schema.ts:226`) written once at insert time by
`src/lib/import/commit.ts:213` and `src/lib/transactions.ts:770`; nothing recomputes it on
read. A fix needs a one-time recompute pass over `raw_description` (same shape as
`drizzle/0016_rule_hygiene.sql`'s catch-up), followed by `rerunEngine()`
(`src/lib/categorize/engine.ts:326`) because both `matchRule` and the Bayes tokenizer read the
stored text.

**Fix:** in `src/lib/categorize/normalize.ts`, replace the fixed second `pop()` with a
longest-match check against a `MULTI_WORD_CITIES` set (or, cheaper and rule-shaped: pop
tokens while the accumulated tail matches a known city, defaulting to one token). Add the
backfill migration + `rerunEngine`. Test: `tests/lib/categorize/normalize.test.ts`, a
table-driven case asserting each of the nine inputs above maps to the "should be" column.

**Effort:** M **Confidence:** High

---

#### C-04 · Medium · The dashboard's "Needs a look" card credits a category baseline to the merchant

**Where:** `src/lib/insights.ts:101-110`

**What:** `unusualVerdict` (`src/lib/predict/anomalies.ts:62-73`) picks a merchant baseline
when there are ≥ 5 prior charges at that merchant and otherwise falls back to a **category**
baseline, returning which one it used as `baselineKind`. `insights.ts` discards
`baselineKind` and always renders the merchant phrasing:

```
sentence: `${formatCents(...)} at ${candidate.merchant} — usually about ${formatCents(verdict.baselineCents)}.`
```

The notification renderer gets this right (`src/lib/notify/render.ts:653-657` branches to
"the $X that <category> charges usually run"); only the on-screen card is wrong.

**Evidence:** household with eight $100.00 LOBLAWS grocery charges and one $1,000.00 COSTCO
charge — COSTCO has *zero* prior history, so the baseline is the Groceries category median.
`householdInsights({today:'2026-03-15'})` returned:

```
[{"kind":"unusual","amt":-100000,"s":"$1,000.00 at COSTCO — usually about $100.00."}]
```

Wrong output: asserts the household usually spends about $100 *at COSTCO*, a merchant they
have never used. Right output: "$1,000.00 at COSTCO — about 10 times what Groceries charges
usually run." (`render.ts`'s own wording).

**Fix:** add `baselineKind` (and the category name) to `InsightRow` in `src/lib/insights.ts`
and branch the sentence the way `render.ts:653-657` does. Test:
`tests/lib/insights.test.ts`, assert the sentence for a first-ever-merchant charge names the
category, and that a merchant with ≥ 5 prior charges still names the merchant.

**Effort:** S **Confidence:** High

---

#### C-05 · Medium · A non-income child under an income parent is dropped from every budget number

**Where:** `src/lib/budgets.ts:521`

**What:** `const all = listCategories({ includeArchived: true }).filter((category) => !category.isIncome);`
removes income categories *before* the parent/child walk. A spend category whose parent is an
income category therefore has no surviving top-level ancestor, so it never becomes a row — and
`budgetProgress` only ever iterates `parentId === null` (`budgets.ts:528`), so it cannot
surface on its own either. Same root shape as C-01, different trigger.

**Evidence:** created a non-income child "Work expenses" under the seeded income category
"Salary", March 2026: $123.45 spent, $200.00 limit.

```
income-parent case totals: {"budgetedLimitCents":0,"budgetedSpentCents":0,"totalSpentCents":0}
  child row present?: false
  categorySpend sees child: 12345
```

Wrong output: Budgets shows nothing budgeted and nothing spent. Right output:
`{budgetedLimitCents: 20000, budgetedSpentCents: 12345, totalSpentCents: 12345}`.

**Fix:** either forbid the shape (validate in `createCategory`/`renameCategory` that a
non-income category cannot have an income parent — `src/lib/categories.ts`), or make the walk
tolerant: treat a category whose parent is absent from `all` as top-level. Test:
`tests/lib/budgets.test.ts`, assert a non-income child of an income parent still yields a row
with its own limit and spend.

**Effort:** S **Confidence:** High

---

#### C-06 · Low · cashflowTrend's default endMonth reads the wall clock in UTC, not the configured TZ

**Where:** `src/lib/reports.ts:222`

**What:** `const endMonth = opts.endMonth ?? monthOf(new Date().toISOString().slice(0, 10));`
— the only `.toISOString().slice(0,10)` in `src/lib`, and one of only two bare wall-clock
reads there. `toISOString()` is UTC; every other "today" in this codebase goes through
`todayIso`/`currentMonth`, which format in `readTz()` (`src/lib/dates.ts:269-282`).

**Evidence:**
```
at 2026-03-31 21:00 America/Toronto
UTC path  monthOf(new Date().toISOString().slice(0,10)) = 2026-04
TZ  path  currentMonth()                                = 2026-03
```
Wrong output: a 12-month trend ending in a month that has not started, with the current month
one column back. Right output: `2026-03`.

**Reachability: currently nil.** Every caller in `src/` passes `endMonth` explicitly
(`dashboard/page.tsx:105,141,152`, `reports/page.tsx:84`, `monthly.ts:196`, `runway.ts:111`,
`savings-target.ts:178`). This is a latent trap for the next caller, not a live wrong number —
hence Low.

**Fix:** `src/lib/reports.ts:222` → `const endMonth = opts.endMonth ?? currentMonth();`
(already imported region; add `currentMonth` to the `@/lib/dates` import on line 7). Better
still, make `endMonth` required so the module keeps its no-clock property. Test:
`tests/ops/*` grep invariant asserting `src/lib/**` contains no `toISOString().slice(0, 10)`,
alongside the existing `new Date()` scans.

**Effort:** S **Confidence:** High

---

#### C-07 · Low · Anomaly/insight category baselines read the split parent's stale category_id

**Where:** `src/lib/insights.ts:47-61,97-100`; `src/lib/notify/evaluate/anomalies.ts:325-345`,
`:137-149`, `:105-113`

**What:** These four queries select `transactions.categoryId` and `transactions.amountCents`
directly, with no `transaction_splits` join. `setTransactionSplits` deliberately leaves
`transactions.category_id` untouched (`src/lib/splits.ts:187-197`), so for a split transaction
the category baseline files the **whole parent amount** under whatever category the row
carried before it was split — and a parent whose `category_id` was NULL contributes to no
category baseline at all.

Using the parent's *amount* is right (a $1,000 charge is a $1,000 charge however it is
divided), so this is not a total that double-counts; it is a baseline sample that is
mis-filed, which can suppress or manufacture an "unusual charge" finding.

**Evidence:** a $1,000 COSTCO charge split 50/50 Groceries/Restaurants keeps
`transactions.category_id = Groceries` (verified by direct SQL read: `category_id` still
`11`, the Groceries id), while `categoryBreakdown` and `categorySpend` both correctly report
`Groceries 50000 / Restaurants 50000`. The Groceries anomaly baseline therefore sees a
$1,000 Groceries data point that no report agrees exists.

**Fix:** join `transaction_splits` and read `EFFECTIVE_CATEGORY` for the *category sample*
queries only (`insights.ts:47-61` `readSlice`'s categoryId column and its
`row.categoryId === candidate.categoryId` filter; `anomalies.ts`'s
`categoryBaselineRows`), keeping `transactions.amountCents` for the candidate's own magnitude.
Test: `tests/lib/insights.test.ts`, assert a split transaction contributes only its part's
amount to the category sample.

**Effort:** M **Confidence:** High

---

#### C-08 · Low · cashRunwayHint blames a missing month whenever months is null, even with six months of history

**Where:** `src/lib/runway.ts:118` and `src/lib/runway.ts:157-159`

**What:** `months` is null whenever `avgMonthlySpendCents <= 0`, but `cashRunwayHint`'s null
branch is unconditional:

```
if (runway.months === null) {
  return `Needs one complete month of spending before this can be estimated — check back once ${monthLabel(runway.readyAfterMonth)} begins.`;
}
```

A household with six complete months of history that net-refunded to zero (or a household
with history but no *spend*) is told to check back next month, and `monthsOfHistory` — the
one field the non-null branch exists to disclose — is never consulted.

**Evidence:** decisive lines quoted above; `monthsOfHistory` (`runway.ts:123`) is
`trend.length`, which is 6 in that case, while `runway.ts:157` ignores it.

**Fix:** branch on `monthsOfHistory === 0` for the "check back once X begins" sentence and use
a distinct one ("no net spending to average over these N months") when history exists but the
average is not positive. Test: `tests/lib/runway.test.ts`, a household with six months of
zero-net spend asserts the second sentence, not the first.

**Effort:** S **Confidence:** High

---

#### C-09 · Low · A bare four-digit store number survives normalization

**Where:** `src/lib/categorize/normalize.ts:98` (`stripWithinToken`'s `isDigitRun` test,
`/^\d{5,}$/`)

**What:** A digit run is only stripped at five digits or more unless it carries a
`#`/`STORE`/`UNIT` prefix, so a bare four-digit store number stays in the merchant identity and
splits one chain into a bucket per store.

**Evidence:** `normalizeMerchant('LOBLAWS 1042 QUEBEC CITY QC')` → `LOBLAWS 1042 QUEBEC`
(the `1042` survives; `STARBUCKS #4 TORONTO ON` → `STARBUCKS`, because the `#` prefix path
handles it).

**Fix:** same file, same backfill as C-03 — widen the bare-digit-run rule to 3+ digits, or
strip a trailing all-digit token when it is not the only token. Test:
`tests/lib/categorize/normalize.test.ts` asserting `LOBLAWS 1042 TORONTO ON` → `LOBLAWS`.

**Effort:** S **Confidence:** High

---

#### C-10 · Low · Bayes can be trained on a rule's own verdict

**Where:** `src/lib/categorize/engine.ts:866`, `:900`, `:914` (`confirmCategory`)

**What:** `train()`'s only call site is `confirmCategory`. Both of that function's guards
special-case `row.source === 'manual'` only — the early return at `:866` and the `untrain` at
`:900`. A row whose category came from a *rule* falls straight through to the unconditional
`train(tokens, input.categoryId)` at `:914`, so clicking through (or bulk-confirming) a
rule-assigned row teaches Bayes the rule's own answer rather than an independent human
judgement.

Prediction is clean: `ELIGIBLE` (`engine.ts:146-149`) and its in-memory mirror
(`engine.ts:230-232`) both require `categoryId === null || source === 'bayes'`, so Bayes
never overwrites a `source = 'rule'` row.

**Fix:** in `src/lib/categorize/engine.ts`, gate `train()` on the confirmation actually
changing something a rule did not already assert — e.g. skip training when
`row.source === 'rule' && row.categoryId === input.categoryId`. Test:
`tests/lib/categorize/engine.test.ts`, assert the Bayes token table is unchanged after
confirming a rule-assigned row to the category the rule already chose.

**Effort:** S **Confidence:** Medium (read from code and the call-site grep; not executed)

---

#### C-11 · Low · Two bare wall-clock reads under src/lib (I1)

**Where:** `src/lib/categorize/engine.ts:235`; `src/lib/reports.ts:222` (also C-06)

**What:** `const at = new Date();` in `runEngine` has no injectable `at` parameter, unlike
every sibling in the file (`engine.ts:749,851,985,1062` all use `input.at ?? new Date()`).
It feeds `updated_at` stamps (`engine.ts:258`) and `bumpRuleUsage` (`:265`), so no
household-visible number is wrong — it is an untestable clock read, not a defect. Listed for
the I1 sweep's completeness.

Cleared as legitimate on inspection: every `new Date(iso)` / `new Date(ms)` parse
(`auth/ratelimit.ts:64,108,116`, `auth/session.ts:91,94,97,164`, `backup.ts:55,81`,
`simplefin/connection.ts:53`, `simplefin/sync.ts:32,39`, `notify/send/telegram.ts:181`,
`notify/outbox.ts:199,210,521`, `backup/restore.ts:254,262`) and every
`input.at ?? new Date()` default parameter. `src/lib/warranty/receipts.ts:119` (fs.utimes)
and `src/lib/warranty/ocr/onnx/probe.ts:75` (a probe timestamp setting) are bare but touch no
displayed date.

**Fix:** give `runEngine` an optional `at` the way its siblings have. Test: extend the existing
`tests/ops/` clock-invariant grep to flag a bare `new Date()` not preceded by `?? `.

**Effort:** S **Confidence:** High

---

#### C-12 · Low · The import help text overstates how dedup matches, and does not disclose the trade-off

**Where:** `src/app/(app)/help/content.tsx:233-234`; `src/lib/import/dedup.ts:21-41`

**What:** The help says "Duplicate detection hashes the raw row as the bank wrote it".
It does not: `dedupDescription` uppercases and collapses whitespace
(`dedup.ts:21-23`), so casing/whitespace variance *is* tolerated — better than advertised —
while a bank that re-exports the same transaction with genuinely different description *text*
produces a different hash and imports as a second copy, which is not advertised at all.

**Evidence:** the key is
`sha256(version | accountId | rawDate.trim() | amountCents | UPPERCASE-whitespace-collapsed description | occurrenceIndex)`
(`dedup.ts:32-40`), scoped to one account (`dedup.ts:129-131`). `occurrenceIndex`
(`dedup.ts:48-58`) counts identical `(date, amount, description)` rows within the file, so two
genuine coffees on the same day at the same price both survive — index 0 and 1 hash
differently. The trade-off the code chose is explicit and reasonable ("FROZEN. Do not add
rules here", `dedup.ts:8-18`); only the UI sentence is off.

**Fix:** reword `content.tsx:233-234` to "hashes the date, amount and description, ignoring
capitalisation and spacing — a bank that reworded a description between exports can produce a
second copy." Test: none needed (copy change); the dedup behaviour itself is already pinned by
`tests/lib/import/dedup.test.ts`.

**Effort:** S **Confidence:** High

---

### Invariant sweep results

- **I1 (no wall-clock `new Date()` under `src/lib`, and server pages go through `todayIso`)** —
  **2 violations**, see C-06 (`reports.ts:222`, also the only `.toISOString().slice(0,10)` in
  the tree) and C-11 (`engine.ts:235`). Every other hit is either `new Date(supplied)` parsing
  or an injectable `input.at ?? new Date()` default. Server components are clean:
  `dashboard/page.tsx:96,185` uses `currentMonth()`/`todayIso()` whose tz default is
  `readTz()`; `budgets/page.tsx:111,142`, `reports/page.tsx:40`, `transactions/page.tsx:53`,
  `transactions/filter-params.ts:179` and `api/reports/export/route.ts:49` all pass
  `readEnv().tz` explicitly. `readEnv().tz` and `dates.ts`'s `safeTz()` both resolve through
  `readTz()` (`src/lib/env.ts:185`, `src/lib/env-tz.ts:15`), so they cannot diverge.
  `review/page.tsx` reads no clock at all.
- **I2 (splits use `EFFECTIVE_*`)** — **2 violations**, both in the anomaly family, see C-07.
  Every money total is split-aware and verified: `budgets.ts` `categorySpend`/
  `categoryTransactions`/`categorySpendWithRollupSeries`, `reports.ts` `categoryBreakdown`/
  `cashflowTrend`/`categoryMonthOverMonth`/`categoryYearOverYear`/`personSpendSplit`/
  `topMerchants`/`transactionsCsv`, `tax.ts` `taxYearReport`, `predict/history.ts` `cells`,
  `transactions.ts:611`. Legitimate parent-row reads (correctly *not* split-aware, each with a
  stated reason): `balance.ts:151,208` and `movementBetween` (ruling R1 — a bank movement is
  the parent's amount), `loans.ts` throughout (`loan_payments.txn_id` names a whole
  transaction), `savings-target.ts:152-157` (transfers, which cannot be split at all —
  `splits.ts:147`), `reports.ts:100` (`NOT_PRINCIPAL_MOVEMENT`'s direction test).
  `topMerchants` correctly uses `count(distinct transactions.id)` so an N-part split is one
  charge, not N (`reports.ts:576`).
- **I3 (transfers excluded; loan payments handled consistently)** — transfers: **holds**,
  `eq(transactions.isTransfer, false)` is present in every spend/income aggregate
  (`budgets.ts:151,210,285`, `reports.ts:110`, `tax.ts:56,97`, `predict/history.ts:62,176`,
  `insights.ts:48`, `anomalies.ts:113,142,165,326,343`), and `setTransactionSplits` refuses to
  split one. Loan payments: **1 violation, the C-02 family.** The rule (three of four loan
  movements are principal, not spend; an owed-loan repayment *is* spend, MUST-13.2) lives only
  in `reports.ts:93-116`; `budgets.ts`, `predict/history.ts` and `tax.ts` do not apply it.
- **I4 (month boundaries are string arithmetic)** — **holds.** `monthStart`, `monthEnd`,
  `monthOf`, `addMonths`, `addMonthsClamped`, `addDaysIso`, `daysBetweenIso`, `monthRange`,
  `monthsBetween` are all pure integer/string math over `daysFromCivil`/`civilFromDays`
  (`dates.ts:172-267`) — no `Date` object anywhere in the arithmetic path, so no DST or zone
  can shift a day. `parseDateString` is likewise Date-free (`dates.ts:74-155`). The single
  `.toISOString().slice(0,10)` in `src/lib` is C-06.
- **I5 (rounding)** — **holds.** No path accumulates fractional cents: `netSpentCents` is a
  negation, `sumCents` is integer accumulation, `divRound`/`meanCents`/`medianCents` are
  integer with sign applied once (`predict/stats.ts:20-54`). `tax.ts` does no rate arithmetic
  at all (there is no `amount * 0.13` anywhere), and `loans.ts` never touches
  `interest_rate_bps` in any computation (MUST-13.1). Every `Math.round` in the money path
  divides integers and is used for a percentage or an average, never re-fed into a cents total
  (`runway.ts:113,118`, `savings-rate.ts:40`, `savings-target.ts:127,184`,
  `notify/evaluate/savings.ts:115`, `goals.ts:90`). One cosmetic asymmetry worth knowing:
  `Math.round` is half-toward-+∞ while `divRound` is half-away-from-zero, so a negative
  exactly-.5 average rounds differently in `runway.ts` than in `predict/`. No comparison uses
  `===` on a derived float.
- **I6 (migration idempotency and ordering)** — **holds.** 22 `.sql` files matching 22 journal
  entries 1:1, `idx` exactly 0..21 in order, `when` strictly increasing. Only `0011` and
  `0021` rebuild a table (0019 is a single `ALTER TABLE … ADD COLUMN` + backfill; 0020 is a
  conditional `INSERT … WHERE NOT EXISTS`). Both rebuilds preserve every column the reconstructed
  history says the old table had, copy them with explicit matching column lists, and re-create
  every pre-existing index (`warranty_item_types_name_uq`;
  `notification_targets_user_channel_uq`, `notification_outbox_dedup_uq` — deliberately
  changed to `COALESCE(user_id,-1)` — `notification_outbox_due_idx`,
  `notification_outbox_user_idx`). No FK points at either rebuilt notification table; the one
  pointing at `warranty_item_types` re-resolves by name after the rename. `PRAGMA foreign_keys`
  is handled exactly as `src/db/client.ts:30-50` documents (OFF at `:55`, `migrate()` at
  `:59`, ON in the `finally` at `:63`, handle closed and error rethrown at `:65-68`,
  `foreign_key_check` sweep at `:69-81`) — and drizzle's SQLite dialect really does wrap all
  pending migrations in one `BEGIN…COMMIT`, which is what makes the pragma un-settable from
  inside a `.sql` file. `tests/db/migration-0021.test.ts:264-275` owns the
  `expect(Math.max(...idxs)).toBe(21)` assertion, matching the actual newest index.

---

### Verified clean

1. **normalizeMerchant** — *not* clean; see C-03 and C-09.
2. **`matchRule` precedence (`src/lib/categorize/rules.ts:234-242`, `MATCH_TYPE_SPECIFICITY`
   at `:177`)** — the code is exactly the documented longest-pattern → exact > word > contains
   → lowest-id. Executed four constructed tie-breaks: equal length exact(id 202) beat
   contains(id 101); exact(id 5) still beat contains(id 9) with the *lower* id on the loser, so
   type genuinely outranks id; equal length + equal type, contains(id 7) beat contains(id 50);
   and a 24-char `contains` pattern beat a 10-char `word` one, confirming length is primary.
3. **`findRedundantRules` (`src/lib/categorize/rules.ts:554-558`, `coverageEligible`)** — a
   `word SHELL` rule is correctly **not** flagged against `contains SHELL`; the `word × contains`
   and `contains × word` cells are never evaluated at all. Executed: all four documented YES
   cells fire, both NO cells return `[]`. Note the *reason* stated in the brief is not the real
   one — for a single-token pattern, `contains SHELL` does cover everything `word SHELL`
   matches (`SHELLEY` matching only the broad rule does not break superset coverage). The sound
   reason is multi-token patterns: `word "PETRO CANADA"` matches `PETRO-CANADA` but
   `contains "PETRO CANADA"` does not, so the cell is unsound in general and the code refuses
   all of it — under-flagging, which is the safe direction and the file's own stated principle.
4. **`effectiveBudget` rollover / carry (`src/lib/budgets.ts:441-460`)** — executed all four
   requested cases plus the lookback cap. (a) Jan $500 unspent, Feb budget *cleared* with $100
   spent → `{base 50000, carry 40000, effective 90000}` (the cleared month contributes base 0
   and still consumes carry, exactly as documented). (b) $2,000 on a $500 January →
   `{carry 0}`, no debt carried. (c) Nov + Dec 2025 unspent $500 each → `{carry 100000}` at
   2026-01, so the year boundary is clean. (d) Jan $300 of $500 then Feb $600 of $800 →
   `{base 80000, carry 40000, effective 120000}`, the mid-stream limit change resolved per
   month. (e) 26 months of $100 unspent → `carry 240000`, the 24-month cap holding exactly.
5. **`payoffProjection` (`src/lib/loans.ts:1463-1512`)** — a 0% loan and "payment smaller than
   the monthly interest" are not expressible: there is no interest term at all
   (`interest_rate_bps` is display-only, MUST-13.1, grep-guarded by
   `tests/ops/loan-invariants.test.ts`). No loop: `Math.ceil(balance / monthlyApplied)` with a
   1200-month cap returning null (`:1509-1511`). A zero pace returns null (`:1507`). An extra
   one-off payment mid-month simply raises that month's bucket and therefore the six-month
   mean by a sixth. Correctly paced on `applied_cents` with a `transactions.amount_cents < 0`
   direction join (`:1497`) and bucketed by `transactions.date`, not `created_at` (`:1487`).
6. **`cashRunway` (`src/lib/runway.ts:111-127`)** — `monthsOfHistory: trend.length` is read
   back from the exact array the divisor used (`:113` vs `:123`), never re-derived. A household
   whose only data is the current partial month: `lastFullMonth = monthOf(today) - 1`, the
   trailing window is all zeros, `trimLeadingEmptyMonths` empties it, `avgMonthlySpendCents = 0`
   → `months: null`; `readyAfterMonth = monthOf(today) + 1` (`:127`), which is exactly the
   month whose arrival advances `lastFullMonth` to include today's month. The hint points at
   the right month. (One separate wording defect in the same function: C-08.)
7. **Family digest partition (`src/lib/notify/evaluate/digest.ts:154-190`)** — household total
   = Σ members + unattributed, exactly. The three calls share one `WHERE` by construction: all
   are `categoryBreakdown` through `rangeClauses` (`reports.ts:104-118`), differing only in
   `personClause`, which is `= id` per person and `IS NULL` for unattributed — exhaustive and
   disjoint because there is no user-deletion path anywhere in `src/lib/auth/users.ts` (only
   deactivation) and `listUsers()` returns every row. Executed with splits, a transfer, income,
   an uncategorized row, a deactivated member and a lent-loan disbursement all in one window:
   `12345 + 26000 + 9900 + 3333 = 51578 = household`.
8. **`src/lib/import/dedup.ts`** — key and trade-off as described in C-12; two genuine coffees
   on the same day at the same price are both kept via `occurrenceIndex`, and a re-export with
   different casing or whitespace *is* caught. Only the UI sentence is off (C-12).
9. **Bayes** — prediction is clean (see C-10's second half: `ELIGIBLE` at
   `engine.ts:146-149` and the mirror at `:230-232` can never fire on a `source = 'rule'` row).
   Training is not (C-10).
10. **`projectMonthEnd` minimum-day guard (`src/lib/predict/pace.ts:20`)** —
    `if (input.dayOfMonth < PACE_MIN_DAY_OF_MONTH) return null;` with
    `PACE_MIN_DAY_OF_MONTH = 7` (`src/lib/predict/constants.ts:28`), so the day-1 31× blow-up
    cannot be reached; a net-refunded month returns 0 rather than a negative projection
    (`pace.ts:23`), and MUST-8.3's divisor is the day number itself, which is correct.

Also checked and clean, outside the numbered suspects:

- **`src/lib/balance.ts:120-210`** — `balancesAsOf` / `movementBetween` deliberately sum raw
  `transactions.amount_cents` with no transfer, split or category predicate (ruling R1), which
  is right: a bank balance moves by the whole transaction. The per-account anchor join
  (`:145-155`) correctly compares each row's date against *its own* account's anchor.
- **`src/lib/budgets.ts:597-615` `budgetTotals`** — the parent-limit-supersedes-children rule
  (ruling P3) is applied without double-counting, and `totalSpentCents` sums top-level rows
  only, which is correct because `spentCents` already rolls children in.
- **`src/lib/reports.ts:640-651` CSV injection guard** — `FORMULA_TRIGGER` with the
  `PLAIN_NUMBER` exemption correctly leaves `-45.00` unquoted while guarding `-2+3`.
- **`src/lib/bills.ts:191-216` `safeToSpend`** — computed for whatever month the dashboard is
  viewing, including a past one, where `dayOfMonth` (today's) against that month's
  `daysInMonth` would produce a nonsense projection and a negative bills window. Not a defect
  today: the dashboard renders these figures only when `isCurrentMonth`
  (`dashboard/page.tsx:609-613`) and `projectedSpendCents` has no consumer anywhere in `src/`.
  Worth a guard if either ever changes.
- **`src/lib/notify/evaluate/monthly.ts:135-150` `refreshFor`** — the "10% and $10" threshold
  is integer (`delta * 100 < |was| * 10`), no float comparison.

---

### Unconfirmed

- **OFX `DTPOSTED` timezone suffix is discarded** (`src/lib/import/ofx.ts:69,117`). The parser
  takes the first eight characters (`YYYYMMDD`) and drops the `[±h:TZ]` offset. For a bank that
  stamps UTC, a late-evening Eastern transaction would file one day late. I could not determine
  from the repo which convention Canadian OFX exports actually use, and there is no fixture
  carrying a non-local offset, so I cannot say whether any real statement is affected. The
  behaviour is at least stated in the comment on `:69`.
- **`payoffProjection` with a negative `current_balance_cents`** (`src/lib/loans.ts:1470`)
  returns null only for exactly `0`; a negative balance would yield a negative `monthsNeeded`
  and a payoff month in the past. Payment application clamps at zero
  (`loans.ts:336`, `:1095`, `:1162`), so I could not construct a negative balance through any
  code path — but I did not exhaustively audit the manual balance-edit forms.
- **`goals.ts:90`** `Math.round(windowSum / monthsCounted)` on a contribution average would
  round a negative half-value toward zero rather than away, unlike `divRound`. I did not
  establish whether a negative contribution is reachable.

---

## §C — Ops and robustness lane (Opus)

### Summary

Nothing in CI has ever started this application. `test.yml` runs `tsc` and `vitest`; `release-image.yml` builds and pushes a multi-arch image without once running it. Every defect that only exists after Next draws the server/client boundary at runtime — the v1.29.0 class — is therefore structurally invisible to the pipeline, and the two source-level guards that exist cover two shapes out of about seven. I swept all seven against the current tree and found **no live defect** in any of them; the exposure is in the guards' scope, not in today's code, and the general remedy is a boot-and-request smoke test, because that is the only check in this class that does not have to enumerate shapes in advance. The runtime code itself is unusually well hardened: `VACUUM INTO` (not a file copy) for backups, a staged boot-time restore with an attempt cap, per-tick single-flight guards, an atomic `.partial` rename. The gaps are at the edges — one scheduler tick whose dormancy pre-check still sits outside its own try/catch, an outbox that is at-least-once across a restart mid-send, no boot-time downgrade guard, no fresh backup before an unattended upgrade, and a `.dockerignore` denylist that lets any new top-level directory into a public image. The two reported flakes are almost certainly one flake and it is not in either test: two full parallel suite runs both ended with `[vitest-worker]: Timeout calling "onTaskUpdate"` — the result-reporting RPC starving under load, which Vitest itself warns "might cause false positive tests". That is the signature of "one arbitrary test fails under full load and passes alone", and it is why `--no-file-parallelism` makes CI green.

### Findings

#### O-01 · High · No CI step ever boots the built app, so the v1.29.0 defect class cannot be caught
**Where:** `.github/workflows/test.yml:53-61`, `.github/workflows/release-image.yml:139-149`, `tests/ops/release-image.test.ts:147`

**What:** The test workflow's entire gate is `npx tsc --noEmit` plus `npx vitest run --no-file-parallelism`. `next build` is deliberately excluded and the file says so in its own header comment (`test.yml:1-7`: "`next build` stays a release-time step ... because it is slow"). The release workflow calls `test.yml` as a reusable workflow, runs an OCR-asset guard, then goes straight to `docker/build-push-action` and pushes to GHCR. Nothing between "image exists" and "image is `:latest`" executes `node server.js` or issues a single HTTP request.

**Evidence:** Read both workflow files end to end. `test.yml` has exactly one job with six steps (checkout, setup-node, `npm ci`, vendor scanner assets, tsc, vitest) — confirmed by `tests/ops/test-suite-workflow.test.ts:119`, which asserts "has exactly one job". `release-image.yml:103-149` has `build` needing `[guard, test]`, then build-and-push, then `gh release create`. Grepped the repo for `playwright`, `puppeteer`, `supertest`, `next start`, `server.js`: the only hits are `package.json` scripts and `tests/ops/docker.test.ts`, which reads the Dockerfile as *text* — it does not run it.

**Why this would have caught v1.29.0:** a Server Component calling a value imported from a `'use client'` module compiles fine and type-checks fine; the error is thrown by the React server renderer when the route is actually rendered. `next build` only pre-renders static routes, and every page here is `export const dynamic = 'force-dynamic'` (`src/app/(app)/layout.tsx:9`, `src/app/page.tsx:4`), so the build never rendered the broken page either. One authenticated `GET` against the running standalone server would have returned 500 on that route and nothing else. That is the whole test.

**Fix:** see "Proposed smoke test". Add it as a job in `test.yml` (so it gates `main` and every PR) — because `release-image.yml` already calls `test.yml`, that one addition also gates the image push, with no second copy of the steps.

One nice surprise: `tests/ops/release-image.test.ts:147` is titled "still exactly two platforms and no emulated smoke-test job", but its body only asserts `toContain('linux/amd64,linux/arm64')` and `not.toContain('cortex-a53')` — it pins the *emulated* smoke test out, which was the actual ruling (a QEMU arm64 run to answer the onnxruntime kernel question, genuinely undecidable in CI). A native amd64 boot-and-GET job passes that assertion unchanged. Nothing in the existing guards blocks this work.

**Effort:** M
**Confidence:** High

#### O-02 · High · `.dockerignore` is a denylist, so any new top-level directory ships into a public image
**Where:** `.dockerignore:1-40`, `Dockerfile:66`, `tests/ops/docker.test.ts:181-189`, `.gitignore:24`

**What:** Next 16's Turbopack tracing for `output: 'standalone'` copies the project tree, and `Dockerfile:66` does `COPY --from=builder /app/.next/standalone ./`. Whatever survives `.dockerignore` lands in the shipped, public GHCR image. `.dockerignore` names 16 specific entries. It does **not** name:

- `UI Component/` — 20+ files, a third-party design prototype with its own `pnpm-lock.yaml` and `components.json`. `.gitignore:24` calls it "Design references (mockups and exported prototypes). Never shipped, never published."
- `.claude/` — local agent configuration (`.claude/settings.local.json`).
- `.vscode/` — 12 KB, gitignored.
- `packs/` (68 KB) and `fixtures/` (27 KB) — verified **not** runtime inputs: grepped `src/` and `scripts/` for any read of those directories and found none (the `@/lib/packs` hits are a source module, not the `packs/` folder).
- `*.tsbuildinfo` — 359 KB at the repo root.

**Evidence:** Read `.dockerignore` in full. Its own comment block (lines 18-40) documents that exactly this leak already happened once on the 16.3.2 upgrade (".git (25 MB), docs/, tests/ and .superpowers/ inside .next/standalone/") and that `.superpowers` "is the one that actually matters: it is GITIGNORED working notes, and this image is PUBLIC on GHCR." `tests/ops/docker.test.ts:183` guards the fix by asserting four literal strings: `['.superpowers', 'tests', '.git', 'docs']`. That guard pins the four entries someone happened to notice in August. It cannot notice a fifth.

The gitignored entries never reach a *CI* build (clean checkout), so nothing has leaked publicly. A **local** `docker build` — which the `.dockerignore` header itself says must be safe, and which is why `real-statements/` is listed — would publish `UI Component/`, `.claude/` and `.vscode/`.

**Fix:** invert the guard. In `tests/ops/docker.test.ts`, enumerate the repo's top-level entries (`fs.readdirSync('.')`) and assert every one is either matched by `.dockerignore` or on an explicit `REQUIRED_IN_BUILD_CONTEXT` allowlist (`src`, `public`, `drizzle`, `scripts`, `vendor`, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `CHANGELOG.md`, `Dockerfile`, `.dockerignore`, `next-env.d.ts`). A new directory then fails the suite until someone classifies it. Add `UI Component/`, `.claude`, `.vscode`, `packs`, `fixtures`, `*.tsbuildinfo` to `.dockerignore` at the same time. Optionally also set `outputFileTracingExcludes` in `next.config.ts` so a bare `next build` outside Docker is clean too.

**Effort:** S
**Confidence:** High

#### O-03 · High · `runNotifyTick`'s dormancy pre-check sits outside its try/catch — the exact defect already fixed in two sibling ticks
**Where:** `src/lib/scheduler.ts:66-91` (the bug is line 73); boot call at `src/lib/scheduler.ts:231`; unguarded `startScheduler()` at `src/instrumentation-node.ts:113`

**What:**

```ts
export function runNotifyTick(now: Date = new Date()): void {
  if (ticking) return;
  if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;   // <-- line 73, unguarded
  ticking = true;
  try { ... } catch (error) { console.error('[notify] tick failed', error); } finally { ticking = false; }
```

`hasAnyEnabledTarget()` and `countPendingOutbox()` are both database reads (`src/lib/notify/outbox.ts:182-189` runs a `count(*)` through `getDb()`). If either throws — a locked database while the 02:00 `VACUUM INTO` holds a write lock past `busy_timeout=5000`, a full volume, a mid-restore window — the throw escapes the cron callback entirely. node-cron swallows it, so nothing crashes and **nothing is logged**: notifications silently stop for that tick with no diagnostic.

**Evidence:** This is not speculative drift — the same file fixed this exact shape twice. `src/lib/scheduler.ts:107-114` ("a throw here used to escape uncaught. node-cron swallows an uncaught throw from a scheduled callback, so the process never crashed, but nothing was ever logged either") and `src/lib/scheduler.ts:169-177` ("this gate used to sit outside any try/catch, unlike every sibling job in this file"). `runNotifyTick` is the sibling that was missed. It is worse than the other two, because it is also called directly at boot (`scheduler.ts:231`) from inside `startScheduler()`, which is called unguarded from `src/instrumentation-node.ts:113` — the three reconcilers immediately above it (lines 84-111) each have their own try/catch, `startScheduler()` has none. So a throw at line 73 fails `register()` and takes the whole boot down, at the one moment (`applyStagedRestoreOnBoot` just ran, `getDb()` just migrated) when the database is most likely to be unhappy.

**Fix:** move line 73 inside the `try`, matching `runSimplefinTick`'s structure exactly — `ticking` is not set until after the gate, so a throw there can never leave the flag stuck. Add a test to `tests/lib/scheduler.test.ts` that mocks `countPendingOutbox` to throw and asserts `runNotifyTick()` does not throw and does log `[notify] tick failed`. Independently, wrap `startScheduler()` at `instrumentation-node.ts:113` in the same try/catch its three neighbours already have — a scheduler that fails to arm must not stop the app from serving pages.

**Effort:** S
**Confidence:** High

#### O-04 · High · No boot-time downgrade guard: rolling the image back over a migrated database boots silently mismatched
**Where:** `src/db/client.ts:51-83`, `scripts/restore-core.ts:259-283`, `INSTALL.md:371-375`, `install/synology-compose-pull.yml:64`

**What:** `openDatabase()` calls `migrate()` (forward-only, idempotent) and then `foreign_key_check`. It never asks whether `__drizzle_migrations` already contains a migration newer than what `migrationsFolder()` ships. Drizzle's dialect compares each local migration's timestamp against the database's single latest `created_at`, so on a downgraded image every local migration looks already applied, none re-run, and the boot succeeds. The old code then serves a schema it does not know about — usually benign extra columns, but also a column an older `INSERT` omits or an older query shape that now returns wrong results.

**Evidence:** The guard **exists** and is well written — `assertNotNewerThanCode()` at `scripts/restore-core.ts:259-270`, reachable only from the restore/validation flow, with a deliberate CLI-only `--allow-newer` bypass (`scripts/restore-backup.ts:87-91`). It is referenced nowhere in `src/db/client.ts` or `src/instrumentation-node.ts`. `INSTALL.md:371-375` states downgrading "is not supported and never was" — documentation, not enforcement. This matters more than usual here because `install/synology-compose-pull.yml:64` pins `:latest` and a tag push repoints it, so "roll back to the previous tag" is the natural recovery move and is exactly the unguarded path.

**Fix:** call the same check from `openDatabase()` before `migrate()`, reusing the restore path's message. Boot must fail loudly with "this database was written by a newer version; restore a backup or upgrade the image again" rather than serve. Test: seed `__drizzle_migrations` with a `created_at` beyond the newest file in `drizzle/`, call `openDatabase()`, assert it throws.

**Effort:** S
**Confidence:** High

#### O-05 · High · No fresh backup is taken before an upgrade, on any path
**Where:** `install/update.sh:180-228,215,12,58,248`, `install/update.ps1`, `src/lib/update/check.ts:74-98`, `src/lib/update/watchtower.ts:155-184`, `install/synology-compose-pull.yml:118`

**What:** The source-build updater tags the previous **image** (`install/update.sh:215`) and never touches `/data` — it says so at `install/update.sh:12,58,248`. The new container starts and runs migrations against the live database *before* the health check at `install/update.sh:230-237` has a verdict; the rollback path (`install/update.sh:137-170`) only re-tags and restarts the old image, it never restores the database. The in-app path (`applyUpdate()`, `src/lib/update/check.ts:74-98`) records intent then calls Watchtower's `/v1/update`; there is no backup call anywhere in `src/lib/update/*`. `install/synology-compose-pull.yml:118` sets `WATCHTOWER_CLEANUP: "true"`, which deletes the superseded image, so the prebuilt path has no image-level rollback either. The most recent restore point at any upgrade is the previous night's nightly archive — up to ~24 hours stale.

**Evidence:** Read both updaters end to end and grepped `src/lib/update/` for `buildArchive`, `runNightlyBackup` and every backup module name; no hits.

**Mitigating context worth recording:** `drizzle-orm@0.45.2` wraps the **whole pending set** in one `BEGIN…COMMIT` (`node_modules/drizzle-orm/sqlite-core/dialect.js:643-676` — a single `BEGIN` at line 657, one `try { for (...) } catch { ROLLBACK }` spanning every pending file), and SQLite DDL is transactional. So the "0020 fails, 0019 stays applied, no image can boot" state the brief worried about **does not occur** on this version. `src/db/client.ts:57-68` closes the handle and rethrows rather than handing back a half-migrated connection. The real exposure is a migration that *succeeds* and an app that then misbehaves: schema is forward, code must go back, and O-04 says that rollback boots silently.

**Fix:** call `createOnDemandArchive()` (`src/lib/backup/archive.ts:147-153`) synchronously from `applyUpdate()` and from both updater scripts, verify the artifact (non-zero size plus the existing `preflightSqliteFile` `quick_check`, `scripts/restore-core.ts:295-318`), and abort the upgrade if it fails. Add a residual guard: a source check over `drizzle/*.sql` refusing `VACUUM` / `PRAGMA writable_schema`, since the single-transaction guarantee above holds only for pure transactional SQL and would break silently the first time a migration needs one.

**Effort:** M
**Confidence:** High

#### O-06 · Medium · The digest a user is shown is never correlated to a route in the server log
**Where:** `src/app/(app)/error.tsx:37-41`, `src/app/global-error.tsx:38-42`, `src/instrumentation.ts:8-12`

**What:** Both boundaries render `Reference: <digest>` and deliberately hide the message — correct, and the reasoning at `error.tsx:13-16` is right. But `instrumentation.ts` exports only `register()`. There is no `onRequestError`, the App Router hook that receives `(error, request, { routerKind, routePath, routeType })`. Grepped `src/` and `next.config.ts` for `onRequestError`, `onCaughtError`, `onUncaughtError`, `reportError`: zero hits. So the only server-side record is whatever Next itself prints, which carries the stack and the digest but **no route path**. On a headless NAS the admin's workflow is "a family member reads me a digest over the phone, I grep `docker logs`" — and that grep lands on a stack trace that does not say which page.

**Fix:** add to `src/instrumentation.ts`:

```ts
export async function onRequestError(err, request, context) {
  const digest = (err as { digest?: string })?.digest ?? '(none)';
  console.error(`[error] digest=${digest} route=${context.routePath} type=${context.routeType} method=${request.method}`);
  console.error(err);
}
```

Do not try to read the session here — it is outside the request scope `cookies()` needs, and the session token must never be logged. Route path plus method is enough to correlate. Test: assert `src/instrumentation.ts` exports `onRequestError`, and have the smoke test (O-01) hit a route rigged to throw and assert the captured log contains a `[error] digest=` line naming that route.

**Effort:** S
**Confidence:** High

#### O-07 · Medium · Outbox delivery is at-least-once across a restart mid-send; the dedup index does not prevent a double send
**Where:** `src/lib/notify/outbox.ts:495-501`; unique index `notification_outbox_dedup_uq` on `COALESCE(user_id,-1), channel, dedup_key`

**What:**

```ts
const attempts = row.attempts + 1;
try {
  await deliver(built.request);     // line 497 — the message is on the wire here
  markSent(row.id, attempts, at);   // line 498 — the row is only marked here
```

If the process dies between those two lines — SIGKILL, OOM, a NAS power cut — the row is still `status='pending'`, `attempts=0`, `next_attempt_at <= now`. On the next boot `startScheduler()` runs `runNotifyTick()` immediately (`src/lib/scheduler.ts:231`), `drain()` selects the row again, and **sends it a second time**. The dedup index is doing its job correctly and is simply answering a different question: it deduplicates *enqueue* (`enqueue()`'s `.onConflictDoNothing()` at `outbox.ts:140,163`), not delivery. There is no `sending` state, no claim, no in-flight marker. Answering the brief directly: the row is **retried, not stuck** — and the retry is a duplicate send.

Two things bound the damage, and the brief asks about both. `expireStalePending` (`outbox.ts:198-206`) kills anything pending for >24 h on the first tick after boot, so a row cannot resurrect a week later. And there **is** a retry cap — `MAX_ATTEMPTS = 8` (`outbox.ts:26`), exponential backoff 2→256 minutes capped at 6 h (`outbox.ts:51-53`), a permanent-failure fast path that skips backoff entirely (`outbox.ts:512-518`) — with a real dead-letter state: `markFailed` sets `status='failed'` plus a secret-scrubbed `last_error` (`outbox.ts:377-383`, scrubbed via `outbox.ts:360-367`).

**One gap in the surfacing.** `listRecentDeliveries` selects `status`, `attempts` and `lastError` (`outbox.ts:241-262`), and the Recent deliveries card renders the status and the error (`src/app/(app)/settings/notifications/notifications-client.tsx:1222,1260`) — but `attempts` is deliberately **stripped server-side** before it reaches the client (`notifications-client.tsx:80-85`: "`subject` and `attempts` are stripped server-side"). So an admin looking at a failed row can see *that* it died and *why*, but not whether it died on attempt 1 (a permanent rejection — a bad address, a revoked token) or attempt 8 (an exhausted ladder against a relay that was merely down). Those call for different actions. Worth re-adding `attempts` to the projection, or rendering a derived label ("gave up after 8 tries" vs "rejected outright"), which leaks nothing the `lastError` string does not already.

**Fix:** the cheap, honest fix is to increment `attempts` in the database **before** `await deliver()` rather than after, so a crash mid-send costs one rung of the ladder instead of being invisible. The complete fix is a claim step: a third status (`sending`) written before the await, reconciled at boot alongside `expireStalePending`. A row found in `sending` at boot is genuinely ambiguous, and for a notification the safe default is `failed` with "delivery status unknown after a restart" rather than a re-send. Test: in `tests/lib/notify/outbox.test.ts`, stub `deliver` to resolve and then simulate process death before `markSent`, re-run `drain`, assert the message is not delivered twice.

**Effort:** M
**Confidence:** High

#### O-08 · Medium · The CLI restore documents "stop the container first" but does not enforce it
**Where:** `scripts/restore-backup.ts:73-79`, `scripts/restore-core.ts:488-489`

**What:** The usage text says "Run this with the container STOPPED — restoring under a live SQLite connection is how you corrupt a database." Nothing checks. `commitRestore` renames `budget.db`, `budget.db-wal` and `budget.db-shm` aside (`scripts/restore-core.ts:488-489`) and moves the restored file into place. A running server holds an open fd on the *renamed* inode and keeps writing to a file that is no longer the database — every subsequent request reads and writes the old data, and the next restart throws that work away silently. This is the disaster-recovery tool, run by someone already having a bad day, from a shell inside a container that `docker compose run` will happily start alongside a running one.

**Fix:** probe before committing. `fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health')` with a 1s timeout: if anything answers, refuse with "Budget Tracker is still running on port N. Stop it first: `docker compose down`." Add `--force` for the operator who knows the responder is a different container. Test: in `tests/scripts/restore-backup.test.ts`, stand up a one-line HTTP server on the port and assert `main()` exits non-zero without touching the data directory.

**Effort:** S
**Confidence:** High

#### O-09 · Medium · No preflight free-space check before a backup or a restore
**Where:** `src/lib/backup/archive.ts:70-74,131-134`; `scripts/restore-core.ts`

**What:** `VACUUM INTO` writes a full second copy of the database, then `tarCreate` gzips it alongside hard-linked receipts. On a NAS whose volume is nearly full, both fail with a raw `SQLITE_FULL`/`ENOSPC`. Repo-wide grep for `statfs`, `freeSpace`, `ENOSPC`, `EROFS`, `SQLITE_FULL`, `disk` returns only comment text (`src/lib/backup.ts:164`, `src/lib/backup/restore.ts:229,627`) — no code anywhere.

**Mitigating:** the failure is *safe*. `buildArchive`'s `finally` (`archive.ts:139-143`) removes the snapshot, the staging directory and the `.partial` with `force: true`, and the atomic-rename design (`archive.ts:85-97,138`) means a truncated archive never takes the final name and never displaces a good older backup in retention. `runNightlyJob` (`src/lib/backup.ts:177-187`) deliberately runs the maintenance sweep even when the backup throws, then rethrows. So this is "the backup silently does not exist", not "the data is damaged" — and `raiseBackupFailed` (`src/lib/scheduler.ts:62`) does notify.

**Fix:** `fs.statfsSync(dataDir)` before `buildArchive()` and before `commitRestore()`; require free bytes > database size × 2.2 plus the receipts total, and fail with a message naming both numbers. Same check in the installers (O-13).

**Effort:** S
**Confidence:** High

#### O-10 · Medium · An unwritable volume during a restore commit loops the container forever, by design
**Where:** `src/lib/backup/restore.ts:625-652`, `src/instrumentation-node.ts:32-35`, `docker-compose.yml:6`

**What:** `applyStagedRestoreOnBoot()` returns `'restart'` while a commit is mid-flight and has not exhausted `MAX_COMMIT_ATTEMPTS = 3` (`restore.ts:35`); `instrumentation-node.ts:34` exits with `RESTART_EXIT_CODE` (75, `restore.ts:33`) and `restart: unless-stopped` brings the container back. The attempt counter is what terminates this loop. But `persistAttemptsOrTerminal`'s own docblock (`restore.ts:646-652`) states that if the *journal write* keeps failing — read-only or full volume — while reads keep succeeding, `attempts` never increments, so the process "restarts indefinitely, BY DESIGN". Docker's internal backoff throttles the rate; nothing stops it. No compose file sets `max_attempts`.

`INSTALL.md:599-607` and `README.md:291-296` document the restart loop only for the `exit(1)` database-open case. Grepped `INSTALL.md`, `README.md` and `docs/INSTALL-SYNOLOGY.md` for "exit code", "75", "RESTART_EXIT_CODE", "restart loop": the exit-75 restore path appears nowhere.

**Fix:** give the journal-write failure its own independent ceiling (persist a boot counter in the commit marker itself, since the process restarts) so a permanently unwritable volume converges to a terminal failed state with a printed diagnostic instead of looping. Document the exit-75 case in INSTALL.md's troubleshooting section next to the existing exit-1 entry.

**Effort:** M
**Confidence:** High

#### O-11 · Medium · No `unhandledRejection` or `uncaughtException` handler, so a stray rejection kills the process without checkpointing the WAL
**Where:** `src/instrumentation-node.ts:123-163`

**What:** Node's default for an unhandled rejection has been "crash the process" since v15. The shutdown handler installed at `instrumentation-node.ts:162-163` covers `SIGTERM` and `SIGINT` only, and its whole point (documented at lines 129-133) is that `closeDb()` finishes the in-flight statement and checkpoints the WAL, and that `clearOcrInFlightMarkerOnShutdown()` runs. An unhandled rejection bypasses both: the process dies with the WAL uncheckpointed and the OCR in-flight marker uncleared, so `reconcileOcrCrashOnBoot()` cannot tell a stray rejection from a real crash — precisely the ambiguity the SIGTERM handler was added to remove.

**Evidence:** grepped `src/` for `unhandledRejection` and `uncaughtException`: zero hits. The scheduler's floating promises are all correctly `.catch`ed (`scheduler.ts:90,116-120,181-185`; `outbox.ts:429-432`), so this is a backstop for the unknown one, not a known leak.

**Fix:** register both listeners in `instrumentation-node.ts`, logging with a distinguishing prefix and then running the same `handleShutdownSignal` body before exiting non-zero. `tests/ops/shutdown.test.ts` already exercises the signal handlers — extend it to assert both listeners are registered.

**Effort:** S
**Confidence:** High

#### O-12 · Low · Node is pinned by image tag but not by repo metadata
**Where:** `package.json:5-7`, `Dockerfile:7,31,49`, `.github/workflows/test.yml:33`, `.github/workflows/release-image.yml:56`

**What:** `engines.node` is `">=22"` — a floor, not a pin. There is no `.nvmrc` (confirmed absent from the repo root). The Dockerfile uses `node:22-bookworm-slim` in all three stages and both workflows set `node-version: '22'`, so CI and the image agree; a contributor's local Node 24 does not, and `better-sqlite3`, `argon2` and `onnxruntime-node` are all native addons where that difference is real.

Dependency hygiene is otherwise good: `package-lock.json` is committed, `Dockerfile:24` uses `npm ci`, and the four packages whose ABI/API generation actually matters are exact-pinned with a written rationale (`package.json` `//ocr-pins`). `next`, `react` and `better-sqlite3` take carets, which `npm ci` makes reproducible.

**Fix:** add `.nvmrc` containing `22`, set `engines.node` to `">=22 <23"`, and add an assertion in `tests/ops/docker.test.ts` that the Dockerfile base tag, `.nvmrc` and both workflows' `node-version` all name the same major.

**Effort:** S
**Confidence:** High

#### O-13 · Low · The installers validate almost nothing before writing
**Where:** `install/install-linux.sh:103-125,216`; `install/install-synology.sh:166-179,208`; `install/install-windows.ps1:59-91,254`

**What:** No free-space check in any of the three. No port-conflict probe in any of the three (INSTALL.md tells the user to check with `lsof`/`netstat` *after* it fails). Docker presence is checked but no minimum version. The architecture check exists only in `install-linux.sh:120-125` (`uname -m`, rejecting anything outside x86_64/amd64/aarch64/arm64) and is missing from the Synology and Windows scripts — Synology being the platform most likely to be ARM.

**Fix:** hoist `install-linux.sh:120-125`'s architecture check into the other two; add a free-space floor and a port-bind probe to all three, before `docker compose build`/`up`.

**Effort:** S
**Confidence:** High

#### O-14 · Low · `expireStalePending` runs once per process lifetime, never again
**Where:** `src/lib/scheduler.ts:36,77-81`; `src/lib/notify/outbox.ts:182-206`

**What:** `bootExpiryDone` is set on the first tick and only reset by `stopScheduler()`. A container that runs for months never expires a stale pending row again. Combined with O-07 (a row can be stranded `pending` by a crash mid-send with `attempts` still 0), a row stranded at hour 1 of a 90-day uptime is never aged out.

Related and smaller: `countPendingOutbox()` (`outbox.ts:182-189`) counts every `pending` row regardless of `next_attempt_at`, so a single row in a 6-hour backoff defeats the dormancy bail and the full evaluator runs every 5 minutes for those 6 hours. Cost, not correctness.

**Fix:** run `expireStalePending` on every tick — it is one indexed `UPDATE ... WHERE status='pending' AND created_at < cutoff`, cheap enough — and drop `bootExpiryDone`; or keep the boot special case and add a daily pass in `runMaintenanceSweep`. For the dormancy bail, add `AND next_attempt_at <= now` to `countPendingOutbox`.

**Effort:** S
**Confidence:** Medium

### Runtime-only defect shapes: coverage map

The two existing guards, read in full:

| Guard | File | What it actually asserts |
| --- | --- | --- |
| Client bundle | `tests/ops/client-bundle.test.ts:210,228` | No `'use client'` file, directly or transitively through its own **value** imports, reaches `@/db/client`, `@/lib/env`, `better-sqlite3` or a `node:` builtin. BFS over the `@/` value-import graph, fails closed on unrecognised import shapes. |
| Server→client values | `tests/ops/client-bundle.test.ts:44,116` | No server file value-imports a **non-component** binding from a client module. **This is the v1.29.0 shape.** |
| `'use server'` exports | `tests/ops/use-server-exports.test.ts:182,193` | Every export of every `'use server'` module is an `async function`. **This covers the "Next refuses at build" shape the brief asks about.** |

Stated gaps in those guards, from their own docblocks: they do not understand dynamic `import(...)` expressions (`client-bundle.test.ts:76-78`), and `resolveAtImport` follows only `@/`-prefixed specifiers, not relative ones (`client-bundle.test.ts:150-158`). A third gap is not stated anywhere: `FORBIDDEN_EXACT` (`client-bundle.test.ts:132`) is three specifiers — `@/db/client`, `@/lib/env`, `better-sqlite3` — plus `node:` builtins. The other server-only native packages named in `next.config.ts:16-25` (`node-cron`, `onnxruntime-node`, `tesseract.js`, `tesseract.js-core`, `pdfjs-dist`, `sharp`, `argon2`) are **not** on that list, so a client file reaching one of them by a path that avoids the three named modules would not be caught. Widening `FORBIDDEN_EXACT` to reuse `next.config.ts`'s own `serverExternalPackages` array is a one-line change that keeps the two lists from drifting.

**Live-defect sweep: clean.** I walked all seven shapes against the current tree (top-level client component prop signatures against every `page.tsx`/`layout.tsx` render site; every `catch` and return path in all 21 `'use server'` files; all 24 `useActionState` state interfaces against their initial values; every `await import(...)` in the tree; `process.env` in every `'use client'` file; the `next/headers` call graph from `scheduler.ts` and `instrumentation-node.ts`; barrels, default exports, and `dynamic`/`revalidate` usage). **No live defect found in any of them.** `npx tsc --noEmit` also passes clean on the working tree.

Several of those are clean *by construction*, which is worth recording because it is what makes the residual risk low:

- Every date/timestamp column in `src/db/schema.ts` is `text(...)` — no `{ mode: 'timestamp' }` anywhere — so Drizzle never produces a `Date` to hand across a boundary in the first place.
- Every `useActionState` state interface declares all fields optional and every initial value is `{}` typed to that interface. That convention is the reason shape 3 cannot bite: it makes the mismatch a *type* error, which `tsc` does catch.
- Every `'use client'` component is a named export; there are zero default exports in client-component files, so "server imports the client module's default and calls it" has no surface here.
- `src/app/(app)/budgets/page.tsx:191-193` converts a `Map` to a `Record` before it crosses, with a comment saying why. This class has clearly been thought about.

So the remaining exposure is in the guards' scope, not in today's code. Shapes with **no** guard, ranked by whether one is worth writing:

1. **Non-serialisable prop crossing server→client** — worth a guard, and the highest-value one. Same failure signature as v1.29.0 (throws at render, invisible to `tsc` and to `next build` on `force-dynamic` routes) and it is source-detectable. Walk `page.tsx`/`layout.tsx` JSX for elements whose tag resolves to a `'use client'` module and flag any prop whose declared type in the target's props interface is a function type, `Map`, `Set`, or a class instance. Note the function-typed props that legitimately exist today (`RowMenuButton.onSelect`, the `AutoSave*` family) are only ever instantiated *inside* other client files, so the guard must key on the server→client edge, not on the prop type alone.
2. **`useActionState` initial-state shape mismatch** — **no guard needed.** The all-optional-fields + `{}`-initial convention already makes this a type error, and `tsc` runs in CI. Keep the convention; a source guard would add nothing.
3. **`process.env` read in a client component** — **clean today, and cheap to keep clean.** I walked every `'use client'` file under `src/` and grepped each for `process.env`: zero hits. Worth pinning anyway: extend `client-bundle.test.ts`'s existing file walk with a regex allowing only `NEXT_PUBLIC_`-prefixed reads. Two lines, catches a silent-`undefined` class before it ships.
4. **`cookies()`/`headers()` outside a request scope** — **clean today, but the module edge that would allow it already exists.** `src/lib/auth/session.ts:2` is the only importer of `next/headers` outside `app/**/actions.ts`, and all three `await cookies()` call sites are inside request-scoped exported async functions (`session.ts:186,205,210`); nothing is called at module top level. But `src/lib/backup.ts:4` imports `purgeExpiredSessions` from that same module and `src/lib/scheduler.ts:2` imports `@/lib/backup` — so `next/headers` **is** inside the scheduler's module closure, and a future refactor that reaches for `getCurrentUser()` from a sweep would compile, type-check, and throw only on a real cron tick at 02:00. Worth a guard: assert no module in the `src/lib/scheduler.ts` or `src/instrumentation-node.ts` closure *calls* `cookies()`/`headers()`. The BFS machinery already exists in `client-bundle.test.ts`; only the roots and the forbidden set change.
5. **Server action returning a non-serialisable value** — lower value. `use-server-exports.test.ts` forces every export to be an `async function` but never inspects what it returns; the return types are declared in TypeScript, though, so a reviewer sees them, and every action today translates errors to `{ error: string }` through a `failure()` helper. A guard here needs real type analysis to be worth anything.
6. **Dynamic `import()` of a server-only module from client code** — a known, stated hole in the existing BFS. Close it by teaching `parseImportEdges` to treat a dynamic `import('...')` with a literal specifier as a value edge and to fail closed on a computed one.
7. **Relative import edges** — `resolveAtImport` follows only `@/`-prefixed specifiers. Nothing under `src/` reaches a forbidden module by a relative path today, but that is a survey result, not an invariant. Cheapest durable fix: add a separate assertion that no file under `src/` uses a relative import that climbs out of its own directory (`../../`), so the `@/`-only assumption the guard rests on becomes enforced rather than observed.

**The general remedy, and the one that subsumes all six:** a guard that reads source can only ever pin the shapes someone has already thought of. Every entry above is a hypothesis about how the boundary might be crossed next. The boot-and-request smoke test below is the only check in this class that is *complete*: it does not enumerate shapes, it renders every route the way a person does, and any boundary violation on any route fails it. The source guards remain valuable because they name the defect precisely and run in two seconds; the smoke test is the backstop that catches the seventh shape nobody listed.

### Flake investigation

**What I ran** (all against the working tree, no edits):

1. `npx vitest run tests/lib/backup-restore.test.ts` — 3 consecutive runs. **3/3 passed**, 33 tests each, 10.6–12.1 s.
2. `npx vitest run` over 12 files chosen as the heaviest DB users (`backup-restore`, `reports`, `restore-core`, `restore-backup`, `backup`, `migration-0009/0010/0011/0021`, `schema`, `notify/evaluate/anomalies`, `reset-admin-password`) with default file parallelism — 3 consecutive runs. **3/3 passed**, 12 files each, 22.8–36.3 s wall against 94–106 s of test time (genuinely parallel, genuinely contended).
3. `npx vitest run` — the **full suite, with file parallelism enabled** — 2 consecutive runs.

### The full-suite runs found the actual cause, and it is not a test bug

Both full runs: **321 files passed, 5614 passed / 1 skipped** — and both also reported:

```
⎯⎯⎯ Unhandled Errors ⎯⎯⎯
Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.
⎯⎯⎯ Unhandled Error ⎯⎯⎯
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.<hash>.js:53:10
 ❯ Timeout._onTimeout node_modules/vitest/dist/chunks/index.<hash>.js:59:62
 ❯ listOnTimeout node:internal/timers:605:17
```

**2 runs, 2 reproductions.** Run 1: 228.46 s wall, 1849 s of test time, 1 error. Run 2: 206.62 s wall, 1748 s of test time, 1 error. Identical stack both times.

`onTaskUpdate` is the RPC a forked worker uses to report per-test results back to the main process. This is not a test failing — it is the **reporting channel** timing out because the main process's event loop is saturated by task-update traffic from every fork at once, across 5,614 tests. Vitest's own message says the quiet part out loud: *"This might cause false positive tests."* A dropped or late `onTaskUpdate` means the main process's view of one test's result is lost or stale, and the reporter attributes the loss to whichever test's update was in flight — an essentially arbitrary single test.

**That is the signature of both reported flakes, exactly.** "Fails intermittently under full parallel load, passes alone", one test at a time, no consistent test, no error message that points at the assertion. `tests/lib/backup-restore.test.ts` and `tests/app/reports.test.tsx` are both slow, chatty files (33 and 40-odd tests, heavy per-test setup) running while every other fork is also reporting — they are simply likelier than average to be the one holding an in-flight update when the RPC times out.

This also explains why CI has never seen it. `.github/workflows/test.yml:61` runs `npx vitest run --no-file-parallelism`, and its own comment (lines 57-59) already names this: *"a known Vitest worker-teardown flake that can exit the process nonzero after every test has already passed."* The workaround is in place, the diagnosis was half-right, and the cost is real — serialising the files turns ~1,850 s of test work from a 3.5-minute parallel run into a serial one.

**The fix is to stop saturating the reporter, not to serialise the suite:**

1. **Cap the pool.** `vitest.config.ts` sets `pool: 'forks'` with `singleFork: false` and no `maxForks`, so it defaults to CPU count. Set `poolOptions.forks.maxForks` to roughly half the cores. Fewer producers on the RPC channel, most of the parallel speed retained.
2. **Cut the chatter.** The default reporter emits an `onTaskUpdate` per test transition. `--reporter=dot` (or `basic`) for CI cuts that traffic by a large factor for free.
3. **Cut the work.** See the argon2 point below — the suite hashes passwords at 64 MiB × 3 passes hundreds of times. That is most of the CPU contention that starves the main thread in the first place.
4. Once 1-3 are in, drop `--no-file-parallelism` from `.github/workflows/test.yml:61` and let CI run parallel again. `tests/ops/test-suite-workflow.test.ts:147` currently asserts the flag is present ("runs the full test suite with the worker-teardown-flake workaround") and would need updating with it — deliberately, so the change is a decision rather than a drift.

**Everything below remains worth fixing on its own merits**, and I am no longer claiming either is the cause of the reported flakes.

### `tests/lib/backup-restore.test.ts`

**It is not the temp-directory-collision class.** Both this file's `beforeEach` (`tests/lib/backup-restore.test.ts:45`) and the shared helper (`tests/helpers/db.ts:18`) use `fs.mkdtempSync`, so every file and every test gets a unique path. There is no fixed DB filename shared across workers.

**It is not currently the EPERM-cascade class either, but it is one line away from it.** The teardown is:

```ts
afterEach(() => {
  current?.cleanup();          // line 68
  current = null;              // line 69
  ...restore DATA_DIR / BUDGET_DB_PATH...
  fs.rmSync(dataDir, { recursive: true, force: true });   // line 76
});
```

`cleanup()` (`tests/helpers/db.ts:26-34`) calls `setDbForTests(null)` first, then wraps `sqlite.close()` in try/catch — so a double-close cannot throw. But its **final** statement, `fs.rmSync(dir, { recursive: true, force: true })`, is **not** wrapped. On Windows, `force: true` suppresses ENOENT, not EPERM/EBUSY: if any handle on that directory is still open — and this file's tests deliberately open second connections to the restored database — `rmSync` throws out of `cleanup()`, out of `afterEach`, and lines 69-76 never run. `current` stays non-null, `DATA_DIR` and `BUDGET_DB_PATH` stay pointed at the dead temp directory, and that temp directory leaks. That is the *precise* shape of the cascade described in the brief, with the ordering hazard intact — `current = null` is on the line *after* the call that can throw.

The next `beforeEach` does reassign `current` and `DATA_DIR`, so within this file a single EPERM produces one failed teardown rather than an unbounded cascade. But it does record `originalDataDir` from the leaked value, so the file's final restore puts a dead path into `process.env.DATA_DIR` for whatever runs next in that worker.

**Fix (worth doing whether or not it is the cause):**

- In `tests/helpers/db.ts`, wrap the final `fs.rmSync(dir, ...)` in its own try/catch, or retry it: `for (let i = 0; i < 5; i++) { try { fs.rmSync(...); break; } catch { Atomics.wait(...) /* short sync sleep */ } }`. A leaked temp directory under `os.tmpdir()` is a far smaller problem than a teardown that throws.
- In `tests/lib/backup-restore.test.ts:67-77`, move every restore statement into a `finally` so a throw from `cleanup()` cannot skip the environment restoration: null `current` **before** calling `cleanup()`, not after.
- Add `tests/lib/backup-restore.test.ts` to a `sequence.hooks` audit: there is no `sequence` or `fileParallelism` exception for it in `vitest.config.ts` today (read in full — the file sets `pool: 'forks'`, `singleFork: false`, `restoreMocks: true`, `testTimeout`/`hookTimeout` 20000, and nothing else). If the flake persists after the teardown fix, the next step is `poolOptions.forks.isolate` and a `sequence.concurrent: false` audit, not more guessing.

**One shared resource that is real and worth flagging:** `vitest.config.ts:23` sets `DATA_DIR` to a single repo-relative `.tmp-data` for *every* test file in *every* forked worker. Six test files import backup/restore machinery without overriding it — `tests/app/backups-actions.test.ts`, `tests/app/backups-client.test.tsx`, `tests/lib/notify/raise.test.ts`, `tests/lib/scheduler.test.ts`, `tests/ops/restore-seams.test.ts`, `tests/scripts/restore-core.test.ts`. Any of those that writes into `${DATA_DIR}/backups` or `${DATA_DIR}/tmp` is sharing one directory with five other worker processes running concurrently. That is a genuine cross-file race and it is exactly the kind that only appears under full parallel load. It is not `backup-restore.test.ts`'s own bug — that file overrides `DATA_DIR` correctly — but a colliding neighbour writing into the shared `.tmp-data/backups` while `backup-restore` enumerates or prunes is a plausible mechanism, and it is cheap to eliminate.

**Recommended structural fix, one line, removes the whole class:** give each worker its own data directory. In `vitest.config.ts`, replace the fixed `DATA_DIR` with a `globalSetup`/`setupFiles` assignment of `path.resolve(rootDir, '.tmp-data', String(process.env.VITEST_WORKER_ID ?? '0'))`. No two workers can then collide on `backups/`, `tmp/`, `receipts/` or `secret.key`, and the six files above stop being able to interfere with each other or with anything else.

### `tests/app/reports.test.tsx > a self viewer sees no "Who spent it" card`

Beyond the RPC saturation above, two secondary mechanisms are worth fixing here:

**(a) argon2 contention.** `setup()` (`tests/app/reports.test.tsx:55-95`) calls `createUser` twice, and `createUser` hashes with argon2id at `memoryCost: 65536` (64 MiB), `timeCost: 3` (`src/lib/auth/password.ts:9-12`). That is ~64 MiB of transient allocation and three passes over it, twice per test, and this file has at least four tests that each call `setup()`. Under full file parallelism every fork is doing this at once — on an 8- or 16-way pool that is 0.5–1 GB of concurrent argon2 buffers plus full CPU contention. `testTimeout` is 20000 (`vitest.config.ts:25`). A hash that normally costs ~80 ms can cost seconds under that contention, and this is the *first* test in the describe block, so it pays the cold-start cost of `await import('@/app/(app)/reports/page')` on top. A timeout here would be reported against exactly this test name.

**(b) A midnight rollover.** `const today = todayIso();` is evaluated once at describe-collection time (`tests/app/reports.test.tsx:53`), and every seeded transaction is dated with it (lines 61-79). The failing assertion's last line is `expect(container.textContent).toContain('$12.00')` (line 107) — the seeded amount. If collection happens just before local midnight (TZ is `America/Toronto`, `vitest.config.ts:22`) and the render happens after, the page's own "today"-derived period no longer contains the seeded rows and that assertion fails. A slow full-load run is exactly what widens that window. This is date-dependent and would explain "once".

**Fix for both, neither of which requires reproducing it:**

- Add a cheap test-only argon2 profile. `src/lib/auth/password.ts:9-12` is the single place; read the cost parameters from an env var that `vitest.config.ts` sets to a minimal profile (`memoryCost: 8192, timeCost: 1`). The production constant stays exactly as specified — the tests are not testing argon2's cost, and paying it 300 times across a parallel suite is pure contention. This alone will materially cut the whole suite's wall time.
- Freeze the clock. Replace `const today = todayIso()` with a `vi.setSystemTime(new Date('2026-...T12:00:00'))` in `beforeEach` and derive `today` from that, so the seeded date and the rendered period are computed from the same instant and the test cannot straddle midnight. This file already mocks `@/lib/auth/session` (line 39), so the pattern is established.

### Run tally

8 runs total: 3 solo (`backup-restore`, all passed), 3 contended 12-file parallel (all passed), 2 full-suite parallel (all 5,614 tests passed, both ending with the `onTaskUpdate` RPC timeout quoted above). Plus one `npx tsc --noEmit`, exit 0.

### Proposed smoke test

### Shape

A new job in `.github/workflows/test.yml`, `needs: [test]`, running on `ubuntu-latest`:

1. `npm ci` and `node scripts/vendor-scanner-assets.mjs` (same as the existing job).
2. `npm run build` — this is also the first time `next build` runs in CI at all, which closes a second gap.
3. Create a fixture data directory and seed one admin. The machinery already exists and is already shipped in the image: `scripts/reset-admin-password.ts` is self-contained by design (`scripts/restore-backup.ts:17-21` explains why) and `src/db/seed.ts` seeds categories. Simplest reliable path: run a tiny node script that calls `openDatabase()` on `$FIXTURE/budget.db` (which applies every migration), `seedDatabase()`, and inserts one admin with a known password via the same `hashPassword` the app uses.
4. Start the standalone server: `DATA_DIR=$FIXTURE SECRET_KEY=<32+ bytes> PORT=3100 node .next/standalone/server.js`, backgrounded, with stdout+stderr tee'd to a file. Wait for `/api/health` to return 200 (it checks the database is openable *and* the data directory is writable — `src/app/api/health/route.ts:37-68`, which is exactly the readiness signal wanted here).
5. `POST /login` with the seeded credentials, capture the session cookie (`SESSION_COOKIE_NAME` = `bt_session`, `src/lib/auth/session-constants.ts:2`).

   Auth is enforced in two layers, and the smoke test should exercise both. `src/proxy.ts` — Next 16's renamed `middleware` convention, which now runs on the **Node** runtime, not Edge (`src/proxy.ts:6-20`) — checks only for the *presence* of the session cookie and 307s to `/login` (`proxy.ts:112-116`), with `/api/*` deliberately exempt so route handlers can return 401 JSON rather than an HTML redirect (`proxy.ts:26-29`). Actual session *validation* happens server-side in `src/app/(app)/layout.tsx:22` via `requireUser()`. So: an unauthenticated page GET is a 307 from the proxy; an unauthenticated API GET should be a **401, not a 307**; a GET carrying a garbage cookie value passes the proxy and must still be redirected by `requireUser()`. That third case is the one only an end-to-end request can check, and it is worth one assertion.

   The proxy also sets the CSP nonce and every security header on every response (`proxy.ts:102-123`). Assert `content-security-policy` is present with a `nonce-` value on a page response — `tests/ops/csp.test.ts` checks the header builder in isolation; nothing checks that the header actually arrives on a real response.
6. GET every route below with the cookie; assert the expected status.
7. Assert the captured server log contains no `console.error` output and no `⨯`/`Error:` line. This is the assertion that turns a 200-only check into a real one: a page can render its error boundary and still return 200.
8. `kill -TERM` the server and assert it exits 0 and logs `[shutdown] received SIGTERM, database closed, exiting` (`src/instrumentation-node.ts:158`) — the shutdown path is currently only unit-tested against source text.

### Route list

**28 page routes** (walked `src/app/**/page.tsx`; route-group segments stripped). All expect **200** with a session, **307 → /login** without one, except as noted:

`/` (307 → `/dashboard`, or `/setup` when no admin exists — `src/app/page.tsx:6-7`), `/login` (200, unauthenticated), `/setup` (307 once seeded), `/setup/accounts`, `/change-password`, `/dashboard`, `/transactions`, `/budgets`, `/reports`, `/review`, `/goals`, `/goals/new`, `/import`, `/import/wizard`, `/warranties`, `/warranties/new`, `/warranties/[id]` (needs one seeded row, or assert 404 via `not-found.tsx`), `/help`, `/settings`, `/settings/accounts`, `/settings/audit`, `/settings/backups`, `/settings/connections`, `/settings/item-types`, `/settings/managers`, `/settings/merchant-rules`, `/settings/notifications`, `/settings/users`.

**20 API routes** (walked `src/app/**/route.ts`). Eight have a GET and are safe to call:

- `GET /api/health` → 200, unauthenticated (the readiness probe from step 4).
- `GET /api/backup/download` → 200 (`content-type: application/gzip`); exercises `createOnDemandArchive` → `VACUUM INTO` → `tarCreate` end to end, which no test currently does against a running server.
- `GET /api/reports/export` → 200 `text/csv`.
- `GET /api/reports/tax-export` → 200.
- `GET /api/packs/rules/export` → 200.
- `GET /api/packs/profiles/export` → 200.
- `GET /api/simplefin/accounts` → expect the "not connected" response, not a 500.
- `GET /api/warranties/receipts/[id]` → 404 for an unknown id (asserts the guard, not the happy path).

The twelve POST-only routes (`/api/auth/logout`, `/api/import/{preview,raw-preview,commit,undo}`, `/api/packs/{rules,profiles}/import`, `/api/simplefin/{claim,link,sync}`, `/api/warranties/receipts/stage`) are out of scope for a GET smoke test; assert each returns **405**, which still proves the module loaded and the route was registered.

Also worth asserting once, unauthenticated: every `(app)` page returns 307 rather than 200 or 500, and every authenticated-only API GET returns 401 rather than 307. That is ~36 more requests and it is the cheapest possible authorisation regression test.

### Where it runs

`.github/workflows/test.yml`, as a second job. `release-image.yml:39-41` already calls `test.yml` as a reusable workflow and `build` already needs it (`release-image.yml:105`), so adding the job to `test.yml` gates **both** push-to-main and the image push with one edit and no duplicated steps — the same reasoning `release-image.yml:28-38` gives for the existing `test` job.

Optionally add a second invocation against the **built image** in `release-image.yml`, after the amd64 build and before the push: `docker run` the image with a tmpfs `/data`, wait on the healthcheck, and hit the same route list. That catches the class the source-level smoke test cannot — a missing `COPY` line, a file the Dockerfile forgot (`drizzle/`, `CHANGELOG.md`, the native addons), read-only-rootfs violations. It is a real second gate and it is what would catch a tracing miss that `check-ocr-assets.mjs` does not cover.

### Cost

- `npm ci` + vendor: ~60-90 s (already paid by the existing job; a separate job pays it again, or use `actions/cache` / an artifact upload of `node_modules` + `.next` from the first job).
- `npm run build`: ~90-180 s. This is the dominant cost and the reason `next build` was excluded from CI in the first place.
- Seed + boot + wait for health: ~10-15 s.
- 48 page GETs + 28 unauthenticated GETs + 8 API GETs + 12 405 checks, sequential: ~20-40 s (these are `force-dynamic` server-rendered pages against SQLite; each is tens of milliseconds after the first compile).
- Shutdown assertion: ~2 s.

**Total: roughly 3-5 minutes added to the test workflow**, dominated by `next build`. On the release path it is closer to free in wall-clock terms, because `release-image.yml` already runs `guard` and `test` in parallel and `build` waits on the slower of them.

**This would have caught v1.29.0 outright.** The broken page was one of the 28 above. It threw on every request. Step 6 would have returned 500 and step 7 would have captured the server-side stack. Total detection cost: one HTTP GET, at a stage where the fix is a commit rather than a retag, a rebuild, a republish and a NAS re-pull.

### Verified clean

Things I looked at specifically because the brief asked, and which are correct:

- **Backup uses the right primitive.** `src/lib/backup/archive.ts:70-74` uses `VACUUM INTO`, not a file copy. Under WAL a plain `copyFileSync` of `budget.db` misses everything still in the `-wal` sidecar; `VACUUM INTO` reads through the live connection and writes a fully consistent, WAL-free standalone database, so no separate checkpoint step is needed and the `.db` in the archive is consistent on its own. The test file's own comment (`tests/lib/backup-restore.test.ts:57-63`) records that a `copyFileSync` there produced "a 4096-byte file with zero tables", so this was learned the hard way and is pinned.
- **Restore never swaps the file under a live connection.** `applyStagedRestoreOnBoot()` runs at `src/instrumentation-node.ts:21` — first, before anything can open the database, with the ordering pinned by `tests/ops/restore-seams.test.ts` and explained at lines 17-20. A `'restart'` outcome exits with code 75 rather than calling `getDb()` (lines 32-35), so the app never serves from a half-committed database. There are no in-flight requests to worry about: Next awaits `register()` before accepting the first one. This is the correct design and it is better than a close-swap-reopen would be.
- **Single connection, correct pragmas, one construction site.** `src/db/client.ts:51-83` is the only place a `better-sqlite3` handle is built; WAL, `busy_timeout=5000` and `foreign_keys=ON` are applied every time, with the documented and necessary OFF window across `migrate()` and a `foreign_key_check` sweep afterwards that refuses to start on an orphan.
- **The scheduler runs once per process, and the assumption holds.** `startScheduler()` is idempotent (`scheduler.ts:206`), called only from `src/instrumentation-node.ts:113`, reached only via `instrumentation.ts`'s `NEXT_RUNTIME === 'nodejs'` guard. Next standalone is one Node process (`Dockerfile:127` `CMD ["node", "server.js"]`, no cluster, no PM2, no `replicas` in any compose file), so it is one scheduler per container. Confirmed there is no `setInterval` anywhere in `src/` — node-cron is the only timer.
- **A throwing tick does not kill the interval.** node-cron keeps the schedule regardless, and four of the five tick bodies catch internally (`runOcrSweep` 42-49, `runNightlyTick` 52-64, `runUpdateTick` 99-121, `runCanadianPackUpdateTick` 135-141, `runSimplefinTick` 151-186). O-03 is the one exception.
- **Overlap protection exists where it can matter.** `ticking` (`scheduler.ts:34`), `updateTicking` (38), `simplefinTicking` (40), and the pump's own `Promise | null` single-flight (`outbox.ts:406-425`). The nightly job has none, which is correct: it fires once a day, and both it and the on-demand path are fully synchronous (`buildArchive` uses `tarCreate({sync:true})` and `getSqlite().exec`), so two invocations on one event loop serialise rather than interleave. Fragile if anything in that path ever becomes async, but sound today.
- **Retry cap and dead-letter are real and visible.** `MAX_ATTEMPTS = 8`, exponential backoff capped at six hours, `status='failed'` with a secret-scrubbed `last_error`, surfaced by `listRecentDeliveries` with `status`, `attempts` and `lastError` (`outbox.ts:26,51-53,241-262,377-383`). The per-channel circuit break (`outbox.ts:467-475`) is a nice touch — a dead relay costs one connect timeout per tick, not fifty.
- **`/api/health` is used by the container and is a real check.** `Dockerfile:124-125` and `docker-compose.yml:32-41` both call it. It executes `select 1` through the live handle *and* writes-then-deletes a probe file in `DATA_DIR` (`src/app/api/health/route.ts:10-21,37-52`) — so it fails a read-only volume, not just a dead process. It returns 503 with a reason and deliberately omits the version from the 200 (`route.ts:27-35`).
- **The backup archive is written atomically.** `.partial` sibling in the same directory, `renameSync` into place only after `tarCreate` returns, `finally` cleanup of all three artifacts, and the `$`-anchored name patterns mean an orphaned `.partial` can never be listed, counted toward retention, or evicted in place of a good backup (`archive.ts:33-39,85-97,107-143`).
- **Migrations are one transaction, not one per file.** `node_modules/drizzle-orm/sqlite-core/dialect.js:643-676`. The "0020 fails, 0019 applied" state does not occur on `drizzle-orm@0.45.2`.
- **The `.superpowers` leak that motivated the memory note is genuinely fixed** for CI builds and for local builds: `.dockerignore:38` lists it and `tests/ops/docker.test.ts:183` pins it. O-02 is about the *next* directory, not this one.
- **Lockfile and `npm ci`.** `package-lock.json` is committed; `Dockerfile:24` and both workflows use `npm ci`. The four ABI-sensitive packages are exact-pinned with a written rationale in `package.json`.
- **`npx tsc --noEmit` passes** on the working tree (ran it; exit 0). Stated so the "tsc is green and the app is still broken" premise is anchored to a measurement rather than assumed.
- **The proxy is cheap and correctly scoped.** `src/proxy.ts` runs on every non-static request and does exactly two things — attach security headers and bounce cookie-less requests off app pages — with no database access, deliberately (`proxy.ts:15-20` explains that Next 16's move from Edge to the Node runtime removed the *restriction* but not the *reason*). `/api/*` is exempt from the redirect so handlers can return 401 JSON (`proxy.ts:26-29,45-47`). Session validation stays in `requireUser()`, once per page rather than once per request. This is the right split and the reasoning is written down.
- **No `generateMetadata`, `unstable_cache` or `cache()` anywhere in `src/`**, so there is no cached-render path that could replay a stale `cookies()` read outside its request.
- **All 5,614 tests pass** on the full parallel suite (twice), and 321 of 321 files. The suite is real and it is green; O-01 is about what it structurally cannot see, not about its quality.

### Unconfirmed

Suspicions I could not close, stated as suspicions:

1. **That the `onTaskUpdate` timeout is what produced the two specific reported failures.** The timeout reproduced 2/2 on the full parallel suite and its signature matches both reports precisely, but I never captured either named test failing — in my 8 runs everything passed. The causal link between "the reporting RPC timed out" and "this particular test was reported failed" is inference from Vitest's own warning ("This might cause false positive tests"), not from a captured instance. It is the strongest available explanation and it is independently worth fixing, but it is not proof.
2. **The two secondary test hazards.** The `tests/helpers/db.ts:33` unwrapped `rmSync` and the `tests/app/reports.test.tsx:53` describe-time `todayIso()` are real and worth fixing, but neither was observed firing.
3. **Whether `.claude/` is tracked in git.** It is not in `.gitignore` and it contains `settings.local.json`. I could not run `git` to check whether it is committed. If it is tracked, it reaches a CI Docker build too, not only a local one — which would raise O-02's severity for that entry specifically.
4. **Whether the six no-override test files actually write into the shared `.tmp-data`.** I identified them by import (they import backup/restore machinery and never set `process.env.DATA_DIR`) but did not trace each one's call graph to confirm a write reaches `${DATA_DIR}/backups` or `${DATA_DIR}/tmp`. The per-worker `DATA_DIR` fix makes the question moot, which is why I recommend it either way.
5. **Whether Next 16 logs the digest itself.** O-06 assumes the current server-side log line lacks the route path. I read `instrumentation.ts` and confirmed no `onRequestError` exists; I did not capture a real production error log to confirm exactly what Next prints alongside it. The fix is worth applying regardless, since the route path is definitely not in there.
6. **The exact behaviour of an unhandled rejection under Next's standalone server.** Next may install its own `unhandledRejection` handler in `server.js`. If it does, O-11's severity drops from "the process dies uncleanly" to "the process survives but `closeDb()` still never runs on the eventual crash". I did not read the generated `server.js`.
7. **Whether a `sequence`/`fileParallelism` exception for the two flaky files would help.** `vitest.config.ts` has none today (read in full). I did not test adding one, because doing so would mask the cause rather than fix it, and the per-worker `DATA_DIR` and cheap-argon2 changes address the two mechanisms I can actually name.

---

## §D — UI, UX and consistency lane (Sonnet)

### Summary
The four flagged items are all real, each with a small, targeted fix. The strongest new finding is an
accessibility drift: three tables (Reports' baselines table, all three notification-settings matrices)
use bare `<th>` while every other table in the app uses `<th scope="col">` — proven by the fact the
repo's own `table-layout.test.ts` guard counts `<th scope="col">` specifically, so these tables sit
outside a check the team already built. Charts have no text alternative anywhere in the app. Outside
that, the codebase is unusually self-auditing: most places I suspected a duplicate-implementation or a
guard gap turned out to already carry a docblock explaining why the apparent divergence is intentional
(RowDialog's row-vs-page-level rule, StatTile's tone/sign decoupling, the merchant-rules ScopeChoice vs
DateRangePicker split), so those are recorded below as verified-clean rather than findings.

### Findings

#### U-01 · Impact: High · Three tables skip `scope="col"` while the rest of the app uses it everywhere
**Where:** `src/app/(app)/reports/reports-client.tsx:303-307` (baselines table); `src/app/(app)/settings/notifications/notifications-client.tsx:1084-1086`, `:1175-1177`, `:1240-1244` (three separate tables)
**What:** Every other table in the app (including three other tables in `reports-client.tsx` itself, at lines 402-406, 450-454, 527-528+) renders `<th scope="col">`. These four tables render bare `<th>`/`<th className=...>` with no `scope`. A screen reader announcing a cell in these four tables gets no column-header association; everywhere else in the app it does.
**Evidence:** `grep -n "<th\b" src/app src/components | grep -v 'scope='` returns exactly these 11 header cells, all inside `<TableWrap responsive>` (notifications) or `<TableWrap bare responsive>` (reports). `tests/ops/table-layout.test.ts`'s own responsive-table guard (`data-label= count >= <th scope="col"> count`) literally regexes for `<th scope="col"` — so these four tables' true header count is invisible to that guard. That's a real blind spot: a `<td>` under one of these tables that is missing its `data-label` would not be caught by the guard that exists specifically to catch that failure mode, because the guard never counts these headers at all.
**Fix:** Add `scope="col"` to all 11 header cells. That alone also closes the guard blind spot noted above, since `table-layout.test.ts` needs no change — it will simply start counting these headers once they carry the same attribute every other table does.
**Effort:** S

#### U-02 · Impact: Medium · Charts have no text alternative anywhere in the app
**Where:** `src/components/charts/NetWorthChart.tsx`, `CategoryBarChart.tsx`, `SavingsChart.tsx`, `DebtTrendChart.tsx`, `CashflowChart.tsx` (all 5); rendered at `src/app/(app)/reports/reports-client.tsx:361,380,567,706` and `src/app/(app)/dashboard/page.tsx:738`
**What:** All five chart components render a bare Recharts `<ResponsiveContainer>`/SVG with no `role`, `aria-label`, `<title>`/`<desc>`, or adjacent data table. A screen-reader user gets the card's title/description and (for two of the four Reports chart cards) one line of prose about methodology — never the actual series values. This is a real gap, not a style nit: the same page's "Month over month" table (`reports-client.tsx:388+`) covers materially the same kind of data (spend by category, by month) through a real `<table>`, proving the team already knows how to make this data accessible — the four chart cards just never got the same treatment.
**Evidence:** `grep -n "aria-label\|role=\"img\"\|sr-only\|<table\|scope=" src/components/charts/*.tsx` returns nothing across all 5 files.
**Fix:** Cheapest fix that doesn't require redesigning the charts: give each chart card's wrapping `<div>` (or the `ResponsiveContainer`'s parent) `role="img"` and an `aria-label` summarizing the trend in one sentence (e.g. `aria-label="Net worth line chart, {N} months, ending at {formatCents(latest)}"`), computed once from the same data already passed in as `data`. A fuller fix (a visually-hidden `<table>` mirroring each chart's rows, on the same model as "Month over month") is the correct long-term answer but is a bigger lift across 5 components.
**Effort:** M

#### U-03 · Impact: Low-Medium · Dashboard states the viewed month twice when it isn't the current month
**Where:** `src/app/(app)/dashboard/page.tsx:344-353` (always-visible info banner) and `:355-361` (PageGuide's explanatory paragraph)
**What:** When `!isCurrentMonth`, the page shows a `role="status"` banner: "Viewing {monthLabel(month)}. Net worth, loans, goals..." (line 350). The PageGuide panel just below it ("What is this page for?", collapsed by default) opens to: "This is {monthLabel(month)} at a glance..." (line 357) — restating the exact fact the banner above it already stated. This is the same "one fact stated twice, reader has to work out which is authoritative" defect `page.tsx:282-284`'s own comment says ruling U1 (v1.18.0) already fixed once, for the `PageHeader` eyebrow vs `MonthNav` — it has quietly recurred one level down, between the status banner and the guide text. Lower severity than the original bug because `PageGuide` starts closed (`src/components/ui/PageGuide.tsx:20`, `open={false}` always) — a reader only sees both at once if they deliberately expand the guide.
**Evidence:** `dashboard/page.tsx:350` vs `:357`, both firing on the same `!isCurrentMonth` condition, both naming `monthLabel(month)`.
**Fix:** Drop the month restatement from the guide's sentence, the same way ruling U1 dropped "this month" from the `PageHeader` description — change line 357 to `This is the selected month at a glance: what...` (the banner immediately above already named which month, whenever it isn't the current one; on the current month there is nothing to restate in the first place).
**Effort:** S

#### U-04 · Impact: Low · Per-connection account name lookup inside `.map`
**Where:** `src/app/(app)/settings/connections/actions.ts:35` — `.map((link) => getAccount(link.accountId)?.name)`
**What:** One query per linked SimpleFIN account rather than a single batched lookup. Textbook N+1 shape, but the list this runs over is a household's own bank connections (never more than a handful in practice), so the real-world cost is negligible today.
**Fix:** Only worth batching if this list ever grows past a handful of rows (e.g. a future multi-institution feature) — not urgent. If touched anyway, replace with one `listAccounts` call and a lookup map keyed by id.
**Effort:** S

### Known items — verified

**1. `about-panel.tsx:120` changelog group-key collision**
Confirmed. `CHANGELOG.md`'s `[1.23.0]` release (lines 281-322) contains two `### Added` headings (line 286 and line 309) — the second `### Added` group was accidentally left in when the release notes were revised, immediately followed by a leftover duplicate migration-note paragraph. `parseChangelog` (`src/lib/changelog.ts:89-95`) pushes both as separate `{ title: 'Added', items: [...] }` groups onto the same release, and `about-panel.tsx:120` keys the `release.groups.map(...)` render by `group.title` alone — both groups render with `key="Added"`, producing a duplicate-key warning for the v1.23.0 timeline entry specifically.
**Fix:** `release.groups.map((group, index) => (<div key={`${group.title}-${index}`} ...`. The index is stable per release (groups render in file order, never reordered), so this is a minimal change that also survives any future release repeating a group title again.

**2. Dashboard's "+N more to check" import-audit link**
Confirmed. `src/components/RuleReviewCard.tsx:82` links the overflow ("+N more to check") to `/import`. The comment right above it (lines 78-81) acknowledges this was a deliberate fallback because "there is no page that lists only the unreviewed ones" — but `/import`'s History table (`src/app/(app)/import/import-client.tsx:786-864`) lists every import ever made with no reviewed/unreviewed column and no per-row link into the rule-review view, so a household clicking through lands on a page that cannot answer the question the card raised.
Each individual row's own "Check" link already points at `/transactions?import=${row.importId}&source=rule&group=category` (line 66), and `filter-params.ts:149-150` shows `source` and `importId` are independent filters — `source=rule` alone (no `import=`) surfaces every not-yet-recategorized rule-assigned transaction across every import, which is the one existing surface actually built for this purpose.
**Fix:** Change the overflow link to `/transactions?source=rule&group=category` (drop the import scope, keep everything else). Verified safe against the existing test: `tests/components/RuleReviewCard.test.tsx:49` pins the per-row Check link's exact href but never asserts the overflow link's destination, so this change breaks nothing already pinned.

**3. Rule-delete dialog's shadowing paragraph**
Confirmed. `src/app/(app)/settings/merchant-rules/merchant-rules-client.tsx:367-371`: "If another rule also matches one of these, it will not take over automatically..." — stated conditionally rather than with a real count. The file's own comment immediately above (lines 350-366) already diagnoses this precisely: computing the real number needs re-simulating the affected rows with this rule removed from the rule set (re-running `matchRule` per remaining rule against each row's `normalized_merchant`), which the comment says "would cost one full pass per rule on every keystroke in the date field" if done the expensive way (`ruleImpactIds`), and says the cheap version "belongs beside `ruleClearIds` in `src/lib/categorize/engine.ts`."
**Fix:** A `ruleShadowCount(ruleId, scope)` helper living next to `ruleClearIds` (`src/lib/categorize/engine.ts:672`) and `ruleImpactIds` (`:582`) — for the same row set `ruleClearIds` already resolves, run each row's `normalized_merchant` through `matchRule` against the rule list with this rule excluded, and count how many still hit a different rule. Reuses the exact query `ruleClearIds` already runs; the added cost is one extra `matchRule` pass over rows already fetched, not a new pass per remaining rule. The dialog then renders `${count} will also be caught by another rule and keep a category` instead of the conditional sentence.

**4. `confirmCategory`'s optional `createRule`**
Confirmed, with one correction to the framing: the default (`input.createRule !== false`, `src/lib/categorize/engine.ts:887`) is **on** when omitted — a caller forgetting the flag silently *authors* a household-wide merchant rule, not silently skips one. That is exactly the v1.27.0 bug class (a loan assignment silently teaching a merchant rule nobody asked for), and the project already knows it: `tests/ops/rule-authoring-intent.test.ts:346-349` grep-scans every call site in `src/` for a literal `createRule:` and fails the build if one is missing, with the comment "confirmCategory's createRule is typed OPTIONAL and defaults to ON, so the compiler will not catch an omission." Lines 366-368 of the same file say plainly: "createRule is deliberately not in this list [of required-with-no-default flags]... tightening its type is a separate change with its own callers to audit." All 4 real call sites today already pass it explicitly (`transactions/actions.ts:232,270`, `src/lib/transactions.ts:804-810,911`), so there is no live bug — only a weaker-than-necessary guard (a text scan instead of the type system) for exactly the bug class `setTransferFlag`'s `learnRule` (`engine.ts:1058`, required, no default) and `clearCategory`'s `deleteRule` were hardened against.
**Fix:** Drop the `?` — `createRule: boolean;` (no default) on `confirmCategory`'s input type, matching `learnRule`/`deleteRule`. The 4 existing call sites need no change (all already pass the flag explicitly); `tests/ops/rule-authoring-intent.test.ts`'s `REQUIRED_FLAGS` list (line 370) should gain a `{ fn: 'confirmCategory', flag: 'createRule' }` entry to promote it from the text-scan check to the same structural "declared with no `?` and no default" check `clearCategory`/`setTransferFlag` already get.

### Guard gaps
- **`table-layout.test.ts`'s responsive-table label guard undercounts on unscoped tables.** Its floor check (`data-label=` count `>=` `<th scope="col">` count) only recognizes a header cell that already carries `scope="col"`. The four tables in U-01 above have zero scoped headers, so the guard silently treats them as contributing 0 to the header count — a `<td>` missing its `data-label` under one of *these* tables specifically would not be caught, even though the guard exists precisely to catch that. Fixing U-01 (adding `scope="col"`) closes this without touching the test.
- **No guard ties a destructive `SubmitButton variant="danger"` to a confirm of any kind.** Manually walked every `variant="danger"` call site (14 total): all either sit inside a `RowDialog` or inside one of the two documented row-level inline-panel exceptions (`RowDialog.tsx`'s own "WHEN TO USE" docblock, lines 50-99, names both: the backup-restore panel in `backups-client.tsx` and Deactivate/Reset-MFA in `users-manager.tsx`). So there is no live defect today — but the rule that a page-level destructive action must be a dialog, and a row-level one may stay inline only for a stated reason, lives entirely in that docblock's prose. Nothing greps for it the way Guard 1 (`onboarding-coverage.test.ts`) greps for `EmptyState`'s `action=`/`noAction=` pair. A future page-level delete button could ship with no confirmation at all — not even `window.confirm` — and nothing in CI would catch it before review.
- **`confirmCategory`'s `createRule`** — covered under Known item 4 above; the project's own test file already names this as deferred work.

### Verified clean
- **Money rendering.** One canonical `<Money>` component (`src/components/ui/Money.tsx`) applies sign + colour + tabular figures consistently; `StatTile`'s separate `tone` prop is a deliberate, documented decoupling (spending-up is bad news though not a negative number) rather than a drifted duplicate.
- **Date-range pickers.** `src/components/ui/DateRangePicker.tsx` (page-level `?range=` GET form) and `merchant-rules-client.tsx`'s inline `ScopeChoice` (controlled inputs feeding a live dialog count) are two different modes for two different jobs, and the latter's docblock (`merchant-rules-client.tsx:116-129`) explains exactly why reusing the former would have been wrong.
- **Dialogs.** `RowDialog` is the only blurred-backdrop overlay in the app; the other `backdrop-blur` hits (`help/page.tsx`, `AppShell.tsx`) are sticky headers, not dialogs.
- **Toast/flash.** No competing toast library; `AutoSave.tsx`'s self-clearing "Saved" tick and `Notice` banners serve different, non-overlapping cases (inline field autosave vs. full-form submit result).
- **Icon-only buttons.** Every one checked (`AppShell.tsx` menu toggle, `RowMenu.tsx` kebab, `accounts-step.tsx` remove-row) carries a correct, specific `aria-label`.
- **URL-driven state.** No `useState` found holding a tab/view/scope choice that should survive reload — the notifications settings page's four tabs are `?tab=`-driven with a safe fallback (`page.tsx:57-62`); Budgets/Dashboard person-scope pills and month are both URL params; `filter-params.ts`'s readers (`readSource`, `readSort`, `readGroupMode`, etc.) uniformly fall back to a default on malformed input, never throw.
- **Budgets page month-stated-once.** Already fixed by ruling U1 (`budgets-client.tsx:1431-1433`) — no eyebrow beside `MonthNav` anymore. (See U-03 for where the same pattern has since recurred, on Dashboard.)
- **Forms / stale `defaultValue` after success.** The accounts editor (`accounts-manager.tsx:385`) and the merchant-rules dialogs both close their editor optimistically `onSubmit`, so the `defaultValue`-bound inputs unmount rather than sit stale.
- **Pagination.** Transactions (`pageSize: 50`), review queue (`limit = 100`), import history (`limit = 25/50`), and audit log (`limit = 200`) are all bounded; nothing found rendering an unbounded, ever-growing list.
