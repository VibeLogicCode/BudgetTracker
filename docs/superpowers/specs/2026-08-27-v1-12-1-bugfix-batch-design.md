# v1.12.1 — the fresh-eyes bugfix batch — design

**Date:** 2026-08-27
**Status:** Approved in scope by the owner (rulings R1–R8 below, copied verbatim); planner rulings
P1–P11 recorded here and reversible
**Target release:** v1.12.1
**Answers:** `docs/PENDING-FIXES.md` items **S–AE** (13) and **AT–BH** (15) — 28 items, every one of
them sourced from `docs/reviews/2026-08-27-fresh-eyes-review.md`
**Supersedes nothing.** Every v1.11.0 auto-save ruling and every v1.12.0 bill ruling stays in force;
this release fixes defects inside them.

---

## Problem

A full fresh-eyes review of v1.12.0 on 2026-08-27 produced 35 findings across four lenses. The owner
ruled the privacy work (SEC-1 / PROD-1 and its family) out to v1.13.0 on a one-family-per-instance
model, dropped one item outright, and moved everything else that was small into one release: the
money-math defects, the auto-save safety gaps, the security hardenings, the touch and focus work,
and the missing app chrome.

Nothing here is a feature. Every item is a place where the app already does something and does it
wrong, or promises something and does not do it at all. Four of them lose money:

- a household that budgets at the child level is told it has budgeted **$0.00** (S);
- one transaction can pay a bill installment *and* a loan, recording the same money against the
  household's debt twice (T);
- undoing an import into the wrong account leaves that account anchored on the wrong bank's balance,
  for ever (AE);
- un-marking a bill installment does not stick, so the matcher silently re-marks it (BA).

Three of them lose *edits*: a thrown server action fails invisibly (V), an emptied budget field
deletes a recurring limit (X), and the loser of a concurrent edit goes on seeing their own stale
value with a green tick beside it (AT).

Two are the kind of security gap a household never finds out about: changing your password does not
sign out the session you changed it because of (Z), and two-factor can be switched off from a stolen
session in one click with no notification (AA).

The rest are smaller and are here because the owner said "no harm in completing them".

---

## Rulings

Rulings **R1–R8** are the owner's and were decided before this document. They are not reopened.
Rulings **P1–P11** are the planner's — each marks a place where a backlog item or the review was
silent, mechanically wrong, or in conflict with R6/R8 — and each is flagged so the owner can reverse
it.

| # | Ruling |
|---|---|
| **R1** | One family per instance; multi-tenancy permanently out of scope. |
| **R2** | BD/MON-7: a rule-matched bill payment marks the unpaid installment whose due_date is nearest the transaction date when within 45 days; else the earliest unpaid. No amount check. |
| **R3** | AT/UX-5: fix inside v1.12.1; controls remount/resync when the server value changes. |
| **R4** | U/UX-2: the transactions-row category select passes `createRule: false` (single-row edit only). The Review page keeps creating rules — that screen exists to teach the categorizer. Rule deletion via "Uncategorized" must require a deliberate control, never a select change. |
| **R5** | Confirmations (AU/UX-6): follow the existing backups-page confirm pattern; no new dialog library. |
| **R6** | No new dependencies. No new endpoints unless an item's fix says so. |
| **R7** | Error boundaries (W/UX-1): plain-language sentence, "Try again" via `reset()`, link to dashboard; never render the raw error message in production. |
| **R8** | TOTP replay (BF): store last accepted counter per user; this is the ONLY schema change in v1.12.1 → migration `drizzle/0012_totp_last_counter.sql` (additive column, no table rebuild), journal entry, schema.ts mirror, header inventory comment continuing the numbered list in 0011. |
| **P1** — PLANNER ruling — owner may reverse | **Migration 0012 carries two additive columns, not one.** R8 authorises one schema change; BA (MON-3) cannot be fixed without a suppression record, and no existing column can hold one — `bill_installments`' third CHECK forbids `paid_txn_id` on a row whose `paid_at` is NULL. So `0012_totp_last_counter.sql` — the filename R8 names, kept verbatim — carries `users.totp_last_counter` **and** `bill_installments.unlinked_at`: two `ALTER TABLE … ADD COLUMN` statements, one file, one journal entry, no table rebuild, nothing regenerated. Read strictly as one column, BA's suppression half drops out of the release and its PENDING-FIXES entry stays OPEN; nothing else in the release is affected. |
| **P1 — RULED 2026-08-27** | **Accepted.** 0012 carries both additive columns (`users.totp_last_counter`, `bill_installments.unlinked_at`); one file, one journal entry, no rebuild. BA ships in full. Owner may still reverse before Task 1 starts. |
| **P2** — PLANNER ruling — owner may reverse | **`flattenBudgetRows` lives at `src/lib/notify/evaluate/pace.ts:17`, not in `budget.ts`** as item S says (`budget.ts` has a private `flatten()` at `:16`). It MOVES to `src/lib/budgets.ts` beside `budgetProgress`, and `pace.ts` re-exports it, so `src/lib/budgets.ts` never imports from `src/lib/notify/**`. `monthly.ts:6` and `budgets/page.tsx:6` keep importing from `pace.ts` and need no edit. |
| **P3** — PLANNER ruling — owner may reverse | **S's overlap rule: a parent's own `limitCents` SUPERSEDES its children's when it is set; when it is null, the children's limits sum.** `spentCents` already rolls children into the parent, so a naive flatten-and-sum double-counts whenever both levels carry a limit. This is the review's own recommendation, recorded as a ruling because it is a money decision. |
| **P4** — PLANNER ruling — owner may reverse | **T ships the refusal, not the warning.** Item T offers "refuse with a named error, or at minimum feed the bill leg into the existing over-link warning". The refusal is chosen: it is the behaviour `alreadyLinked()` already enforces on the rule path, and it keeps the whole fix inside `src/lib/loans.ts` — `assignLoanAction` already catches and surfaces named errors from that function (`src/app/(app)/transactions/actions.ts:271-274`). |
| **P5** — PLANNER ruling — owner may reverse | **R4's "deliberate control" for rule deletion is the one that already exists:** Settings → Rules, `deleteRuleAction` (`src/app/(app)/settings/managers/actions.ts:173-176`). `clearCategory` gains a **required** `deleteRule: boolean` so the compiler forces every call site to decide, and its only caller — `setCategoryAction` — passes `false`. No new endpoint (R6). |
| **P6** — PLANNER ruling — owner may reverse | **AC ships HSTS plus a log warning, not an admin banner.** `securityHeaders()` gains an `https` flag and emits `Strict-Transport-Security` only when the connection resolves to HTTPS; `src/proxy.ts` resolves it and logs once per process when `TRUST_PROXY` is off but the request carries `X-Forwarded-Proto: https`. A banner on `/settings` would need state shared from `proxy.ts` into a server component, which is new storage (R6). |
| **P7** — PLANNER ruling — owner may reverse | **AX ships the two `loading.tsx` files only.** The "narrow the whole-page `revalidatePath` calls" half is dropped: the App Router has no sub-page revalidation, so the only available "narrowing" would be deleting a `revalidatePath` a second page genuinely needs (`setCategoryAction` revalidates `/review` because the row leaves that queue). |
| **P8** — PLANNER ruling — owner may reverse | **AE deletes every `source='csv'` snapshot on the import's account whose date is among the deleted transactions' dates**, with no per-date survivorship check. Losing an anchor is recoverable by re-importing; keeping a wrong one is not, and `balancesAsOf` simply falls back to the previous snapshot. |
| **P9** — PLANNER ruling — owner may reverse | **X's blank-is-a-no-op is the DEFAULT for `AutoSaveTextInput`, not opt-in.** All three call sites (`budgets-client.tsx:104`, `item-types-manager.tsx:119`, `managers-client.tsx:169`) are fields where a blank value is already refused by the server, so the default is safe, and the review asked for the general behaviour. |
| **P10** — PLANNER ruling — owner may reverse | **BH's two documentation halves already shipped.** `src/app/(app)/help/content.tsx:328-336` and the warranties `PageGuide` (`warranties-client.tsx:104-108`) already carry the "make an item type of kind Bill under Settings → Item types" sentence, added in v1.12.0. BH therefore adds only the `/warranties/new` hint; the two paragraphs are re-read and confirmed, not edited. |
| **P11** — PLANNER note | **The release is 28 items, not 27.** S–AE is 13 (S, T, U, V, W, X, Y, Z, AA, AB, AC, AD, AE); AT–BH is 15 (AT, AU, AV, AW, AX, AY, AZ, BA, BB, BC, BD, BE, BF, BG, BH). The owner re-scope block's own count ("26 items") is short by one for the same reason. Nothing is added or dropped — this is arithmetic, and all 28 are mapped to tasks. |

---

## Item by item

Every subsection states the current behaviour with a `path:line` from the working tree at HEAD, the
target behaviour, the exact change, and the test that pins it.

### S — sub-category budget limits are dropped from every household total (MON-1)

**Current.** `budgetProgress()` returns top-level rows only (`src/lib/budgets.ts:449-458`) and
`budgetTotals()` iterates that array without descending into `row.children`
(`src/lib/budgets.ts:471-488`). A parent with no limit of its own contributes `limitCents === null`
and is skipped, taking every child limit under it with it. Separately, `renderChildren`
(`src/lib/budgets.ts:456`) drops archived children while `allChildren` (`:455`, used for the spend
rollup) keeps them — so an archived child's spend counts against its parent while its limit
vanishes. Consumers of the wrong pair: `src/lib/bills.ts:170-171`,
`src/app/(app)/dashboard/page.tsx:44,91`, `src/app/(app)/budgets/page.tsx:123`,
`src/app/(app)/budgets/budgets-client.tsx:376,411-416`, `src/lib/notify/evaluate/monthly.ts:171`.

**Target.** `budgetTotals()` folds over the whole tree under ruling P3: a parent's own limit
supersedes its children's when set; when the parent's limit is null, the children's limits sum. An
archived child carrying a limit or non-zero spend renders as a read-only row instead of being
dropped, mirroring the archived-top-level rule at `src/lib/budgets.ts:453`.

**Change.** `flattenBudgetRows` moves from `src/lib/notify/evaluate/pace.ts:17` into
`src/lib/budgets.ts` (P2) and `pace.ts` re-exports it; `budgetTotals` is rewritten to walk parents
and descend only where the parent's own limit is null; `budgetProgress`'s `renderChildren` filter
widens to keep an archived child with a limit or spend.

**Test.** `tests/lib/budgets.test.ts`: a parent with no limit plus two limited children asserts
`budgetedLimitCents === 80000`; a parent with its own limit plus limited children asserts no double
count; an archived child with a limit and spend asserts the limit still appears in the total and the
row still renders.

### T — manual loan assign ignores an existing bill-installment link (MON-2)

**Current.** `alreadyLinked()` (`src/lib/loans.ts:322-341`) unions `loan_payments.txn_id` and
`bill_installments.paid_txn_id` and is the rule path's exclusivity guard.
`assignTransactionToLoan()` (`src/lib/loans.ts:540-575`) reads `transactions` and `warranty_items`
only, so a transaction that already marked an installment paid can be hand-assigned to a loan and
decrement its balance by the same money. The over-link warning
(`src/app/(app)/transactions/actions.ts:284-289`) sums `loan_payments` links only, so it is blind to
it.

**Target (P4).** The manual path refuses with a named error, which the existing catch at
`src/app/(app)/transactions/actions.ts:271-274` already surfaces to the person.

**Change.** The union behind `alreadyLinked` is extracted into an exported
`paymentLinksForTransaction(txnId: number): { loans: number; bills: number }`; `alreadyLinked` keeps
its chunked bulk shape and `assignTransactionToLoan` calls the single-id helper, throwing
`'That transaction already pays a bill installment. Unmark that installment first.'` when
`bills > 0`.

**Test.** `tests/lib/loans/manual-assign.test.ts`: rule-mark an installment with transaction T, then
`assignTransactionToLoan({ txnId: T, itemId: loan })` throws the named error and the loan's
`currentBalanceCents` is unchanged.

### U — the transactions row select creates and deletes household rules (UX-2)

**Current.** `upsertRuleFromCorrection` runs whenever `createRule !== false`
(`src/lib/categorize/engine.ts:321-330`) and the transactions caller passes no `createRule`
(`src/app/(app)/transactions/actions.ts:112`). The "Uncategorized" branch calls `clearCategory`
(`:108`), which calls `deleteExactRule` unconditionally (`src/lib/categorize/engine.ts:387`). The
action's own confirming sentence is discarded because `AutoSave` reads only `result.error`.

**Target (R4, P5).** The transactions row select tags one row and nothing else. Review is untouched
(`src/app/(app)/review/actions.ts:45` keeps its rule creation and its "Category set and rule
created." sentence). Rule deletion moves behind the admin control that already exists.

**Change.** `setCategoryAction` passes `createRule: false` at
`src/app/(app)/transactions/actions.ts:112` and `deleteRule: false` at `:108`. `clearCategory`'s
input gains a **required** `deleteRule: boolean`, so the compiler names every call site rather than
a default deciding quietly.

**Test.** `tests/app/transactions-actions.test.ts`: after `setCategoryAction` sets a category the
`merchant_rules` table has gained no row, and after it clears one the merchant's exact rule survives.
`tests/lib/categorize/engine.test.ts`: `clearCategory({ …, deleteRule: true })` still deletes.

### V — `useAutoSave` has no try/catch (UX-3)

**Current.** `src/components/ui/AutoSave.tsx:56-70` awaits the action inside `startTransition` with
no catch; `onError` is reachable only from the `result.error` branch. Throwing callers include
`confirmCategory` (throws at `src/lib/categorize/engine.ts:284`) and
`src/app/(app)/budgets/actions.ts:50,58,204`.

**Target.** A thrown action reads exactly like a returned `{ error }`: status `error`, the control
reverts through `hooks.onError()`, and a generic sentence appears.

**Change.** The transition body is wrapped in try/catch. The catch sets the module constant
`AUTO_SAVE_THROW_ERROR = 'Could not save — the app may be busy. Try again.'` rather than the thrown
message, because Next redacts real messages in production and a digest in a table cell helps nobody.
The sequence guard (`mine !== sequence.current`) is checked in the catch too, so a stale rejection
cannot overwrite a newer save's state.

**Test.** `tests/unit/auto-save.test.tsx`: an action that rejects leaves
`data-autosave-status="error"`, renders the sentence in a `role="alert"`, and puts the select back to
its previous value.

### W — no error / not-found / global-error boundary (UX-1)

**Current.** No `error.tsx`, `not-found.tsx` or `global-error.tsx` exists under `src/app`; the only
files matching the boundary conventions are the three layouts. `notFound()` is nevertheless called
from `src/app/(app)/warranties/[id]/page.tsx:19,21` and `src/app/(app)/warranties/new/page.tsx:17`.

**Target (R7).** Three boundaries, in the app's own chrome, each with a plain sentence, a "Try
again" button wired to `reset()` and a link to `/dashboard`. The raw error message is never
rendered; `error.digest` is, because that string is what a support conversation needs.

**Change.** `src/app/(app)/error.tsx` and `src/app/(app)/not-found.tsx` (both new, rendering inside
the app shell the `(app)` layout already provides) and `src/app/global-error.tsx` (new, which must
render its own `<html>` and `<body>` because it replaces the root layout).

**Test.** `tests/app/error-boundaries.test.tsx`: the error boundary renders the sentence, calls
`reset` on click, links to `/dashboard`, and does **not** contain the thrown message.

### X — blanking a budget limit wipes it for all future months (UX-4)

**Current.** `AutoSaveTextInput` commits on blur (`src/components/ui/AutoSave.tsx:291`) and an empty
value reaches `setLimitAction`, which calls `clearBudget` (`src/app/(app)/budgets/actions.ts:49-53`
→ `src/lib/budgets.ts:101-103`). The action's own sentence, "Budget cleared from this month
forward.", never reaches the screen; the only feedback is a tick. Control at
`src/app/(app)/budgets/budgets-client.tsx:104-118`.

**Target (P9).** An emptied field whose last saved value was non-empty is a **no-op**: nothing is
sent, and the input is put back to the saved value so the person sees their number return. Clearing
a budget becomes an explicit small button in the same cell.

**Change.** `commit()` in `AutoSaveTextInput` gains the blank guard;
`src/app/(app)/budgets/budgets-client.tsx` gains a "clear" button beside the input — a plain
`<form action={saveLimit}>` carrying the same four hidden fields plus `amount=""`, rendered only
when the row currently has a base limit.

**Test.** `tests/unit/auto-save.test.tsx`: blanking a non-empty field fires no action and restores
the value; blanking an already-empty field is still a no-op.
`tests/app/budgets-client.test.tsx`: the clear button exists on a limited row, is absent on an
unlimited one, and submits `amount=''`.

### Y — three money inputs lack `inputMode="decimal"` (UX-9)

**Current.** `src/app/(app)/transactions/transactions-client.tsx:637`,
`src/app/(app)/goals/goals-client.tsx:110` and `src/app/(app)/goals/goals-client.tsx:184` carry no
`inputMode`. Every other amount field in the app sets it — compare
`src/app/(app)/budgets/budgets-client.tsx:115`.

**Target / change.** `inputMode="decimal"` on all three.

**Test.** `tests/app/transactions-client.test.tsx` and `tests/app/goals-client.test.tsx` assert the
attribute on each field, found by its accessible name.

### Z — password change does not revoke other sessions (SEC-3)

**Current.** `changePasswordAction` verifies, calls `setUserPassword`, revalidates and returns
(`src/app/(app)/settings/actions.ts:80-96`). `src/app/(auth)/change-password/actions.ts:55-56`
already does it right, and `src/app/(app)/settings/users/actions.ts:84` destroys all of them on an
admin reset. Session TTL is 30 days with sliding renewal.

**Target / change.** After `setUserPassword` at `src/app/(app)/settings/actions.ts:93`, read the
session cookie and call `destroyOtherSessionsForUser(user.id, token)` (`src/lib/auth/session.ts:108`)
— the same two lines `change-password/actions.ts` already uses. The message becomes "Password
updated. Every other session was signed out." The new `password_changed` event (below) is raised
from the same place.

**Test.** `tests/app/settings-actions.test.ts`: a second session row for that user is gone after the
action succeeds, and the caller's own row survives.

### AA — disabling TOTP requires no re-auth (SEC-4)

**Current.** `disableTotpAction()` (`src/app/(app)/settings/actions.ts:131-139`) takes no arguments
at all and is invoked as a bare async call from `src/app/(app)/settings/profile-forms.tsx:62`.
`src/lib/auth/totp.ts:158-164`'s `clearTotpEnrollment` nulls the secret and deletes every recovery
code with no session teardown. `src/lib/notify/events.ts` carries 17 events and none covers MFA or
password change.

**Target.** Turning two-factor off costs the current password, kills every other session, and tells
the account owner.

**Change.** `disableTotpAction` becomes a `(prevState, formData)` action taking `currentPassword`,
mirroring the `verifyPassword` block at `src/app/(app)/settings/actions.ts:87-90`, then calling
`destroyOtherSessionsForUser`. `profile-forms.tsx` turns the "Turn off" button into a small form with
a password field driven by `useActionState`. Two events are added to `src/lib/notify/events.ts` —
`mfa_disabled` and `password_changed`, both `audience: 'all'`, `trigger: 'immediate'`,
`defaultEnabled: true` — with dedup keys `mfa_disabled:<atIso>` and `password_changed:<atIso>` (a
never-recurring timestamp, so MUST-3.12 is satisfied by the key's shape), two `RenderInput` members
and two cases in `src/lib/notify/render.ts`, and one raiser `raiseAccountSecurityEvent` in
`src/lib/notify/raise.ts` modelled line-for-line on `raiseNewSignin` (`src/lib/notify/raise.ts:36-73`).

**Test.** `tests/app/settings-actions.test.ts`: the action errors with no password and with a wrong
password and `totpEnabled` stays true in both cases; a correct password disables it and destroys the
other session. `tests/lib/notify/render.test.ts`: both bodies render.

### AB — the rate limiter trusts `X-Real-IP` without `TRUST_PROXY` (SEC-5)

**Current.** `src/app/(auth)/login/actions.ts:51` passes `requestHeaders.get('x-real-ip')` as
`clientIpFromHeaders`' *trusted* `socketIp` argument, and `src/lib/auth/ratelimit.ts:141-150`
returns `socketIp` unconditionally when `trustProxy` is false. Layer A
(`src/lib/auth/ratelimit.ts:103-113`) is keyed on that value, and the same forged value reaches
`sessions.ip` (`src/lib/auth/login.ts:117`) and is rendered verbatim, unbounded, into the sign-in
alert (`src/lib/notify/render.ts:394`).

**Target / change.** `clientIpFromHeaders` treats `x-real-ip` exactly as it already treats
`x-forwarded-for` — read only when `env.trustProxy` is on — and validates and truncates whatever it
returns, falling back to `'unknown'` for anything that is not an IP address or is longer than 45
characters. `login/actions.ts:51` passes `null` as `socketIp`, because a server action has no socket.

**Test.** `tests/lib/auth/ratelimit.test.ts`: with `TRUST_PROXY=0`, two calls with different
`X-Real-IP` values both return `'unknown'`, so Layer A shares one bucket; with `TRUST_PROXY=1` the
header is honoured; a 300-character value and a non-IP string both come back `'unknown'`.

### AC — the session cookie is Secure only under `TRUST_PROXY` (SEC-7)

**Current.** `src/app/(auth)/login/actions.ts:83-92` passes the literal `'http:'` to
`shouldUseSecureCookie` (`src/lib/auth/session.ts:131-137`), and
`src/lib/auth/security-headers.ts:37-48` emits no `Strict-Transport-Security`. Nothing detects the
"HTTPS proxy in front, `TRUST_PROXY` left at 0" configuration.

**Target (P6).** The mismatch is detected and logged loudly; HSTS is emitted only when the connection
actually resolves to HTTPS, never on the plain-LAN default, where it would brick the install.

**Change.** `securityHeaders(nonce?: string, options?: { https?: boolean })` adds
`Strict-Transport-Security: max-age=31536000; includeSubDomains` when `options.https === true` and
nothing otherwise. `src/proxy.ts` resolves HTTPS from `request.nextUrl.protocol` plus, when
`readEnv().trustProxy` is on, `x-forwarded-proto`; and it logs once per process when `TRUST_PROXY`
is off and the request carries `X-Forwarded-Proto: https`. The `'http:'` literal in
`login/actions.ts` is **not** changed — its docblock's reasoning still holds and this release adds no
way to read a real protocol inside a server action.

**Test.** `tests/ops/csp.test.ts`: `securityHeaders()` has no HSTS key, `securityHeaders(undefined,
{ https: true })` has it, and no other header moves. `tests/proxy.test.ts`: an `https:` URL gets
HSTS; a plain-HTTP request does not; `X-Forwarded-Proto: https` with `TRUST_PROXY` off does not, and
warns exactly once.

### AD — the forced-password-change gate misses the export routes (SEC-9)

**Current.** The gate is page-layer only and `/api/*` is exempt by design
(`src/app/(app)/layout.tsx:10-22`). `src/app/api/reports/export/route.ts:21-22,55`,
`src/app/api/reports/tax-export/route.ts:20-21` and `src/app/api/backup/download/route.ts:27-29`
check the session (and, for backup, the admin role) and nothing else.

**Target / change.** All three bulk-data routes call `mustChangePassword(user.id)`
(`src/lib/auth/users.ts:180`) immediately after the session check and return
`403 'Finish setting your password first.'`. Logout and in-flight fetches stay exempt, as the
layout's docblock intends.

**Test.** `tests/api/export-guard.test.ts`: each of the three routes returns 403 under a
`mustChangePassword` session and its normal status without the flag.

### AE — `undoImport` leaves balance snapshots behind (MON-5)

**Current.** `commitImport` writes one `source='csv'` snapshot per statement date
(`src/lib/import/commit.ts:257-259`). `undoImport` (`src/lib/import/commit.ts:390-435`) reverses
Bayes, loan links and installment links, then deletes the rows — snapshots are never touched, and
there is no delete path for `account_balance_snapshots` anywhere in `src/`. `balancesAsOf`
(`src/lib/balance.ts:117-171`) anchors on the newest snapshot at or before a date, so a stale row is
authoritative for ever rather than merely stale.

**Target (P8).** Undo removes the csv snapshots that import anchored.

**Change.** `src/lib/networth.ts` gains
`deleteCsvSnapshotsForAccountDates(accountId: number, dates: string[]): number`. `undoImport` reads
the distinct date set of the transactions it is about to delete, plus the import's own `accountId`,
and calls it inside the same transaction, before `tx.delete(transactions)` — the same position and
the same argument the loan and installment reversals already make. `UndoResult` gains
`snapshotsDeleted: number`.

**Test.** `tests/lib/import/commit.test.ts`: commit an import that writes a snapshot, undo it, assert
no snapshot rows remain for that account/date and `snapshotsDeleted === 1`; a hand-typed
`source='manual'` snapshot on the same day is left alone.

### AT — concurrent edits leave the loser's screen stale (UX-5)

**Current.** `useState(defaultValue)` at `src/components/ui/AutoSave.tsx:128`,
`useState(defaultChecked)` at `:181`, and an uncontrolled `defaultValue` at `:280` with the
`saved`/`sent` refs at `:247` and `:251`. No `useEffect` resync and no `key` reset anywhere; rows keep
stable keys (`src/app/(app)/transactions/transactions-client.tsx:466`), so a `revalidatePath` refresh
never remounts them. The same staleness breaks the single-user Budgets flow: "Use $487" writes the
suggestion server-side (`src/app/(app)/budgets/actions.ts:119-127`) and the typed-in limit input
writes the old number straight back on the next blur.

**Target (R3).** When the server's value changes, and nothing is pending, and the control is not
focused, the control resyncs to the server's value.

**Change.** All three controls gain a resync `useEffect` keyed on the incoming prop. The guards are
the ruling's own: `pending === false` for every control, and additionally
`document.activeElement !== input.current` for the text input. The refs (`saved`, `sent`) move with
the state — without that, the next blur writes the pre-resync value back over the server's.

**Test.** `tests/unit/auto-save.test.tsx`: a rerender with a new `defaultValue` moves the select, the
checkbox and the input; a rerender while a save is in flight does not; a rerender while the input is
focused does not.

### AU — four destructive actions fire on one tap (UX-6)

**Current.** `src/app/(app)/settings/users/users-manager.tsx:108-113` (Deactivate) and `:115-117`
(Reset MFA), `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:520-525` (Remove an
installment), `src/app/(app)/transactions/transactions-client.tsx:574-581` (Unassign from a loan).
The comparison points are `src/app/(app)/settings/backups/backups-client.tsx:30-82` (inline confirm
panel) and `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:691` (plain `confirm()` on a
receipt delete).

**Target (R5).** The two account-level actions get an inline confirm sub-row naming the person, in
the backups idiom. Remove and Unassign get a plain `confirm()`, matching the receipt-delete idiom in
the same file.

**Change.** `RowMenuForm` (`src/components/ui/RowMenu.tsx:212-247`) gains an optional
`confirm?: string`; when present, its `onSubmit` calls `window.confirm` first and
`event.preventDefault()` on a refusal, before the existing `close()`. `users-manager.tsx` gains a
`confirming` state and an inline confirm row modelled on its own `resetting` row at `:121-130`.

**Test.** `tests/unit/row-menu.test.tsx`: a `RowMenuForm` with `confirm` does not submit when
`window.confirm` returns false and does when it returns true.
`tests/app/users-manager.test.tsx`: Deactivate opens a confirm row naming the person, and no form is
posted until it is confirmed.

### AV — touch targets under 44 px (UX-7)

**Current.** `src/components/ui/RowMenu.tsx:162` (`h-8 w-8`), `src/components/ui/RowMenu.tsx:47-48`
(the shared item class, `px-2.5 py-1.5 text-xs`), `src/components/ui/AutoSave.tsx:30`
(`AUTO_SAVE_CONTROL = 'field-control w-auto max-w-[11rem] px-2 py-1 text-xs'`).

**Target / change.** The trigger becomes `h-11 w-11 sm:h-8 sm:w-8`; the shared item class becomes
`px-2.5 py-2.5 text-sm sm:py-1.5 sm:text-xs`; `AUTO_SAVE_CONTROL` becomes
`'field-control w-auto max-w-[11rem] px-2 py-2 text-sm sm:py-1 sm:text-xs'`. The menu is
`position: fixed` at 14 rem so it has the room, and `TableWrap` already scrolls horizontally on a
phone, so the extra height costs nothing. Desktop is byte-identical because every change is
`sm:`-scoped back to today's values.

**Test.** `tests/unit/row-menu.test.tsx` asserts `h-11` and `w-11` on the trigger and `py-2.5` on an
item; `tests/unit/auto-save.test.tsx` asserts `py-2` on a default-classed control.

### AW — kebab actions drop keyboard focus to the page body (UX-8)

**Current.** The provider supplies `close: () => close(false)` (`src/components/ui/RowMenu.tsx:153`)
and `refocus` is only ever true on the Escape path (`:122-126`). All three item components use that
context close (`:186`, `:198`, `:221`).

**Target / change.** The provider supplies `close: () => close(true)`, so the trigger is refocused on
every close path. The pointer-outside and scroll/resize paths (`:104`, `:106`) keep `close(false)` —
stealing focus back when somebody clicked elsewhere is its own defect. The success/error `Notice`
banners are already live regions, so the announcement follows for free.

**Test.** `tests/unit/row-menu.test.tsx`: activating a `RowMenuButton`, a `RowMenuLink` and a
`RowMenuForm` each leaves `document.activeElement` on the trigger; Escape still does; a click outside
does not.

### AX — nothing on screen while a slow page loads (UX-10)

**Current.** No `loading.tsx` anywhere; `src/app/(app)/reports/page.tsx:22` and
`src/app/(app)/transactions/page.tsx:13` are both `force-dynamic`, and Reports runs a dozen
aggregates plus a tax-year report per request.

**Target (P7).** A card-shaped skeleton appears immediately on both.

**Change.** `src/app/(app)/reports/loading.tsx` and `src/app/(app)/transactions/loading.tsx`, both
new, both plain server components rendering the app's own `Card`/`CardBody` shell with pulsing
placeholder bars and a `role="status"` region carrying "Loading…" for a screen reader. The
`revalidatePath` narrowing named in the item is dropped (P7).

**Test.** `tests/app/loading-skeletons.test.tsx`: each renders a `role="status"` element and at least
one skeleton bar.

### AY — no safe-area insets on an installed iPhone (UX-11)

**Current.** `src/app/manifest.ts:24` declares `display: 'standalone'`, `src/app/layout.tsx:14-17`
sets `appleWebApp`, and `grep -rn "safe-area\|env(safe" src/` returns nothing. Header at
`src/components/app-shell/AppShell.tsx:108`, `<main>` at `:155`, footer at `:166`.

**Target / change.** `viewportFit: 'cover'` is added to the `Viewport` export at
`src/app/layout.tsx:24-29`; the sticky header gains `pt-[env(safe-area-inset-top)]`, the footer
`pb-[calc(2rem+env(safe-area-inset-bottom))]` (replacing its `pb-8`), and `<main>` gains
`pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]`.

**Test.** `tests/components/AppShell.test.tsx` asserts the three class strings are present;
`tests/app/manifest.test.ts` is re-run unedited, because the manifest itself does not change.

### AZ — shutdown kills in-flight writes; a boot failure is a silent crash loop (UX-12)

**Current.** `src/instrumentation-node.ts:95-106` clears the OCR marker, logs one line and calls
`process.exit(0)` — no `closeDb()`, and `closeDb` exists unused at `src/db/client.ts:105-108`. A
throw out of `getDb()` at `src/instrumentation-node.ts:39` leaves nothing but a stack trace in
`docker logs`.

**Target / change.** The signal handler calls `closeDb()` inside its own try/catch after the OCR
marker and before exiting, and arms a hard 10-second `setTimeout(…).unref()` so a wedged close cannot
hang the container. The `getDb()` call is wrapped in a try/catch that prints a framed, multi-line
message naming the failure and the rescue command
(`node --experimental-strip-types scripts/restore-backup.ts <archive>`), then exits 1.

**Test.** `tests/ops/shutdown.test.ts` (new; a source-grep guard in the style of
`tests/ops/loan-invariants.test.ts`, because importing this module boots the app): the handler
mentions `closeDb()` before `process.exit`, the boot path wraps `getDb()` in a try/catch, and the
framed message names `restore-backup.ts`.

### BA — un-marking a bill installment does not stick (MON-3)

**Current.** `unmarkInstallmentPaid` clears both columns
(`src/lib/warranty/installments.ts:226-234`), and `paid_txn_id` is `alreadyLinked`'s only record
(`src/lib/loans.ts:322-341`), so the transaction becomes a fresh candidate and `confirmCategory`'s
two exits (`src/lib/categorize/engine.ts:305,333`) both re-run the matcher over it.
`removeInstallment` (`src/lib/warranty/installments.ts:200-202`) takes no paid/linked guard, so
deleting a paid, linked installment discards the payment record and re-opens the transaction too.

**Target (P1).** The suppression is recorded rather than erased, and a paid, linked installment
cannot be deleted out from under its payment record.

**Change.** `bill_installments` gains a nullable `unlinked_at` column (migration 0012, ruling P1).
`unmarkInstallmentPaid(id, at)` clears `paid_at` and `paid_txn_id` **and** stamps `unlinked_at`; the
matcher's target query gains `AND unlinked_at IS NULL`, so an installment a person has deliberately
un-marked is never auto-marked again. A person can still mark it paid by hand — `markInstallmentPaid`
clears `unlinked_at` in the same UPDATE, because a hand mark is the deliberate act the suppression
exists to protect. `removeInstallment` refuses a row with a non-null `paid_at` or `paid_txn_id`,
returning false, which the detail page already surfaces through `installmentRowState.error`
(`src/app/(app)/warranties/[id]/warranty-detail-client.tsx:534`).

**Test.** `tests/lib/warranty/installments.test.ts`: rule-mark an installment, un-mark it, call
`applyPaymentMatchers` on the same transaction again, assert the installment is still unpaid;
`removeInstallment` on a paid row returns false and the row survives; un-mark then hand-mark works and
clears `unlinked_at`.

### BB — balance-snapshot source authority is documented, not implemented (MON-4)

**Current.** Three docblocks claim `simplefin > csv > manual` (`src/lib/networth.ts:41-47`,
`src/db/schema.ts:434-437`, `drizzle/0010_balances.sql:9-11`) and `recordBalanceSnapshot`'s
`onConflictDoUpdate` sets `{ balanceCents, source }` unconditionally (`src/lib/networth.ts:76-82`).
The one test that touches it (`tests/lib/import/commit.test.ts:492`) asserts the csv-over-manual
direction, which passes for the wrong reason.

**Target / change.** The rank is implemented once, as an exported constant
`SNAPSHOT_SOURCE_RANK = { manual: 1, csv: 2, simplefin: 3 }`, and the upsert gains a `setWhere`
(available on drizzle-orm 0.45.2) so the write lands only when the incoming source's rank is greater
than or equal to the stored row's. Equal rank is still last-write, which is what a re-import of the
same statement needs.

**Test.** `tests/lib/networth-snapshots.test.ts`: write `csv` then `manual` for one `(account, date)`
and assert the csv figure survives; `manual` then `csv` and assert csv wins; `csv` twice and assert
the second value wins.

### BC — `runEngine`'s in-memory filter drops the splits guard (MON-6)

**Current.** `ELIGIBLE` (`src/lib/categorize/engine.ts:113-116`) carries the
`not exists (select 1 from transaction_splits …)` half and its docblock (`:102-112`) explains at
length why. `runEngine`'s JS filter (`src/lib/categorize/engine.ts:168`) reproduces only the category
half. Latent today, because every caller passes just-inserted ids — and the next call site added
anywhere inherits the hole.

**Target / change.** `selectRowsByIds` (`:121-145`) selects a `hasSplits` flag and `runEngine`'s
filter adds `row.hasSplits === 0`, so one predicate serves both paths.

**Test.** `tests/lib/splits-engine.test.ts`: split a transaction whose parent `category_id` is NULL,
call `runEngine([id])` directly, assert `is_transfer` and `category_id` are unchanged and
`skipped === 1`.

### BD — a bill payment marks the earliest unpaid installment regardless of date (MON-7)

**Current.** `markEarliestUnpaid` (`src/lib/loans.ts:355-375`) orders `due_date ASC, id ASC` and
never reads the transaction's own date; `candidates()` (`src/lib/loans.ts:290-315`) does not even
select `transactions.date`.

**Target (R2).** The unpaid installment whose `due_date` is nearest the transaction's date wins when
that distance is 45 days or less; otherwise the earliest unpaid, as today. No amount check.

**Change.** `Candidate` (`src/lib/loans.ts:282-288`) gains `date: string` and `candidates()` selects
it. `markEarliestUnpaid` is renamed `markMatchingUnpaid` and takes `txnDate`; it reads every unpaid,
non-suppressed installment for the item ordered `due_date ASC, id ASC`, picks the minimum
`Math.abs(daysBetweenIso(dueDate, txnDate))` — ties broken by that order, so the earlier due date
wins — and falls back to the first row when that minimum exceeds
`INSTALLMENT_MATCH_WINDOW_DAYS = 45`.

**Test.** `tests/lib/loans/payment-matchers.test.ts`: three installments and a transaction dated near
the second marks the second; a transaction a year away from all three marks the first; exactly 45
days from the nearest marks it (boundary inclusive) and 46 days falls back to the earliest.

### BE — the backup archive is the whole ledger plus password hashes (SEC-8)

**Current.** `buildArchive` stages `budget.db` and `receipts` only
(`src/lib/backup/archive.ts:99-141`); `secret.key` lives beside them and does not travel
(`src/lib/env.ts:93-137`). `INSTALL.md:322-334` describes what an archive contains but not what that
means.

**Target / change.** Documentation only. `INSTALL.md`'s "Restoring from a backup" section gains one
paragraph stating plainly that a downloaded archive is the complete household financial record plus
every password hash, that it must be stored encrypted, and that restoring it onto a different install
will not recover Telegram/SMTP/TOTP unless `secret.key` is copied too — which is the current
behaviour and the safe default.

**Test.** `tests/ops/install.test.ts` gains one assertion that the section names both "password
hashes" and "secret.key".

### BF — a TOTP code can be replayed inside its ±30 s window (SEC-10)

**Current.** `const totp = authenticator.clone({ window: 1 })` (`src/lib/auth/totp.ts:22`) and
`verifyTotp` (`:71-79`) checks format then `totpAt(at).check(...)` with no record of a spent code.
`src/lib/auth/login.ts:110` is the login call site. Recovery codes are correctly single-use at
`src/lib/auth/totp.ts:113-128`, which is the pattern to copy.

**Target (R8).** The last accepted counter is stored per user and any code at or before it is
refused.

**Change.** `users.totp_last_counter` (integer, nullable) arrives in migration 0012.
`src/lib/auth/totp.ts` gains `TOTP_STEP_SECONDS = 30` and
`verifyTotpCounter(secret, token, at?): number | null`, which uses otplib's `checkDelta(token, secret)`
(present on `@otplib/core`'s Authenticator, `node_modules/@otplib/core/authenticator.d.ts:132`) and
returns `Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS) + delta`; plus
`consumeTotpCounter(userId, counter): boolean`, an atomic
`UPDATE users SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`
returning `changes === 1` — the same shape `consumeRecoveryCode` already uses.
`src/lib/auth/login.ts:110` becomes a counter verify plus a consume, and a failed consume takes the
existing `fail()` path so the lockout layers still count it. `verifyTotp` stays for the enrollment
confirmation at `src/app/(app)/settings/actions.ts:120`, where there is nothing to replay against —
the user is not enrolled yet.

**Test.** `tests/lib/auth/totp.test.ts`: the same code accepted once is refused on an immediate
second attempt; a code from the next step is accepted; a code from a step at or below the stored
counter is refused.

### BG — `/api/health` reveals the build version to anyone (SEC-11)

**Current.** `src/app/api/health/route.ts:62` returns `version: APP_VERSION` on the 200; the two 503
branches (`:35-46`, `:49-59`) return it too. The Docker healthcheck reads only `r.ok`
(`Dockerfile:124-125`), so it needs no change.

**Target / change.** `version` is dropped from the 200 body and kept on both 503 bodies, where its
stated purpose ("which build is broken?") applies. The comment at `:27-29` is rewritten: it argues
the leak is nil because the footer shows the same string, and the point it misses is that the footer
is behind a session.

**Test.** `tests/api/health.test.ts`: the 200 body has no `version` key and both 503 bodies still do.

### BH — the Bill kind is undiscoverable on `/warranties/new` (owner report)

**Current.** `drizzle/0011_bill_installments.sql:116` copies existing types only and seeds nothing;
`src/app/(app)/warranties/new/new-warranty-client.tsx:200-207` renders the type select from the
caller's list with no empty-kind hint.

**Target (P10, R6).** One line under the type select when no item type of kind `bill` exists. No row
is seeded into a user-managed table.

**Change.** `NewWarrantyClient` gains an `isAdmin: boolean` prop, supplied from
`src/app/(app)/warranties/new/page.tsx` (`user.role === 'admin'`). Under the Type field, when
`!types.some((t) => t.kind === 'bill')`, it renders: "Tracking a bill with due dates? First add an
item type with kind Bill under Settings → Item types." — with `Settings → Item types` as a
`<Link href="/settings/item-types">` for an admin and as plain text for a member. The help page and
the warranties page guide already carry the same sentence (P10) and are confirmed unedited.

**Test.** `tests/app/new-warranty-client.test.tsx`: a type list with no `bill` renders the hint, with
a link for an admin and no link for a member; a list containing one does not render it.

---

## Safety

### The migration

`drizzle/0012_totp_last_counter.sql` is two `ALTER TABLE … ADD COLUMN` statements and nothing else.
Both columns are nullable with no default, so SQLite rewrites no rows and holds no long lock; neither
table is recreated; no index, CHECK, trigger or view is touched. This is deliberately the opposite of
0011, whose `warranty_item_types` rebuild was the riskiest step of the previous release.

The file's header follows 0007's, 0009's and 0011's convention — the numbered inventory of objects
that live in raw SQL only (MUST-3.4) — restating entries **1–31** from 0011 unchanged and adding:

- **32.** `users.totp_last_counter` arriving by ALTER TABLE ADD COLUMN (0012)
- **33.** `bill_installments.unlinked_at` arriving by ALTER TABLE ADD COLUMN (0012)

`drizzle/meta/_journal.json` gains
`{ "idx": 12, "version": "6", "when": 1756252800000, "tag": "0012_totp_last_counter", "breakpoints": true }`
— one day after 0011's `when`, the file's existing cadence. `src/db/schema.ts` mirrors both columns
**last** in their tables, because ALTER TABLE ADD COLUMN appends physically and the mirror has to stay
readable against `pragma table_info`.

Forward-only, as every migration in this project is. Downgrading is a restore, and both columns being
additive means an older image reading a newer database simply never selects them — the changelog's
**Before updating** note says so in those words.

### `AutoSave.tsx`

Four items land in one 298-line file (V, X, AT, and AV's control class), which is why they are one
task rather than four. The risks, and what pins each:

- The **AT resync** can undo an edit that has not been acknowledged yet. It is guarded on
  `pending === false` for every control and additionally on
  `document.activeElement !== input.current` for the text input, and the `saved` and `sent` refs move
  with the state — without that, the next blur writes the pre-resync value straight back over the
  server's, which is exactly the Budgets defect UX-5 describes.
- The **X blank guard** must not swallow a legitimate blank. It fires only when the *last saved* value
  was non-empty, so a field that was always empty behaves exactly as it does today, and the input's
  DOM value is restored so nothing looks accepted that was not.
- The **V catch** must not hide a real message. It sets one constant sentence, never the thrown
  message, because Next redacts messages in production and a digest in a table cell helps nobody. The
  sequence guard is applied in the catch too, so a stale rejection cannot overwrite a newer save.
- The **AV class change** is the only visual change, and it widens every row control on phones. Every
  new value is `sm:`-scoped back to today's, so desktop rendering is unchanged.

All four are covered by `tests/unit/auto-save.test.tsx`, which already exercises all three controls,
and none of the twelve call sites changes signature — `AutoSaveTextInput`'s new behaviour is a
default, not a prop (P9), and `AUTO_SAVE_CONTROL` is a constant those call sites do not name.

---

## Release

**Version.** `package.json:3` `"1.12.0"` → `"1.12.1"`. That field is the single source of truth;
`install/update.sh`, `install/update.ps1`, Settings → About and `/api/health` all read it.

**Changelog.** Insert between `## Unreleased` and `## [1.12.0]` in `CHANGELOG.md`:

```markdown
## [1.12.1] - 2026-08-27

**Before updating:** this release adds one new piece of information to each of two existing tables
and does not rebuild either of them, so it is a much smaller step than 1.12.0 was. Take a backup
anyway — **Settings → Backups → Download backup now**, or confirm last night's scheduled backup
succeeded — because a backup is the only way back to 1.12.0 if you want it.

### Fixed

- **Budgets set on sub-categories are counted again.** If you budget at the child level — Food ›
  Groceries $600, Food › Restaurants $200 — the household summary, the Dashboard tile and
  safe-to-spend all said you had budgeted $0.00. They now add up the limits you actually set. A
  category you archived keeps its limit visible for as long as it still carries spend, instead of
  quietly dropping the limit while the spend kept counting against its parent.
- **One payment can no longer pay a bill and a loan at the same time.** Assigning a transaction to a
  loan by hand now checks whether it has already marked a bill installment paid, and refuses. The
  automatic rules always checked; the manual button did not.
- **Un-marking a bill installment sticks.** The app used to forget that the transaction had ever been
  used, so the next time anything re-ran the matcher — even just picking the same category again —
  the installment was silently marked paid all over again. Removing an installment that has a payment
  recorded against it is refused too; un-mark it first.
- **A bill payment marks the right installment.** A matched payment now marks the installment whose
  due date is nearest the payment's own date, within 45 days, instead of always the oldest unpaid
  one. One missed mark used to shift the whole schedule by one, permanently.
- **Undoing an import no longer leaves the wrong balance behind.** Importing a statement into the
  wrong account and pressing Undo used to delete the transactions but keep the balance that statement
  had written, leaving the account anchored on another account's figure for ever. Undo now removes
  those balances too.
- **A bank's own balance outranks a typed one, as documented.** A balance read from a statement is no
  longer overwritten by a hand-typed correction for the same account and day. This rule was written
  down in three places and implemented in none.
- **A save that fails now says so.** If the app is busy — the nightly backup, a full disk — an
  auto-saving control used to stop spinning and go on showing a value the database never accepted. It
  now says "Could not save — the app may be busy. Try again." and puts the value back.
- **Emptying a budget box no longer deletes the budget.** Selecting the number to retype it and
  getting distracted used to clear that limit for every future month. An empty box is now treated as
  "no change", and there is a small **clear** button in the cell for when you really mean it.
- **Two people editing the same row.** Whoever's change lost used to go on seeing their own value,
  with a tick beside it, until they reloaded. Controls now follow the server.
- **Error and "not found" screens are the app's own.** A server-side failure or a stale bookmark to a
  deleted item used to show the framework's bare error page — no navigation, no theme, no way back.
  Both now render inside the app with a plain sentence, a **Try again** button and a link to the
  Dashboard.
- **Something happens on screen while Reports and Transactions load.** Both show a skeleton
  immediately instead of nothing at all.
- **Bigger tap targets, and the keyboard goes back where it was.** The row ⋯ button and its menu
  items are finger-sized on a phone, the row controls are taller, and choosing a menu item returns
  focus to the button you opened it from instead of dropping it at the top of the page.
- **Deactivate, Reset MFA, Remove and Unassign ask first.** Every other destructive action in the app
  already did.
- **The number pad opens for three more money fields:** adding a transaction, contributing to a goal,
  and a new goal's target amount.
- **Installed on an iPhone home screen, the app stays clear of the notch and the home indicator.**
- **A clean container stop closes the database.** Stopping or restarting the container used to exit
  the instant the signal arrived, without closing SQLite. And a migration that fails at boot now
  prints a framed message naming the problem and the rescue command, instead of a bare stack trace.
- **Picking a category on the Transactions page changes that row and nothing else.** It used to
  create or overwrite a household-wide rule for that merchant, and picking "Uncategorized" deleted
  one, with nothing on screen to say so. The Review page still teaches the categorizer — that is what
  it is for.
- **The New item page points at the Bill kind.** If you have no item type of kind Bill yet, it now
  says where to make one instead of leaving you to guess.

### Security

- **Changing your password signs out every other session.** A captured session cookie used to keep
  working for up to 30 more days after you changed the password because of it.
- **Turning off two-factor authentication asks for your password** and signs out every other session.
  Turning it off, and changing your password, now also send you a notification.
- **Sign-in rate limiting no longer trusts a header the client controls.** Unless `TRUST_PROXY` is
  on, `X-Real-IP` is ignored, and the address recorded on a session and shown in the "New sign-in"
  alert is validated and length-capped.
- **HSTS is sent when the connection really is HTTPS**, and the app warns in its log when it is
  behind an HTTPS proxy with `TRUST_PROXY` left off — the configuration where the session cookie
  silently is not marked Secure.
- **Bulk exports are blocked until a temporary password has been changed.** The transactions export,
  the tax-year export and the backup download now honour the same "finish setting your password" gate
  the pages do.
- **A two-factor code can only be used once.** It used to stay valid for its full ±30-second window
  and could be replayed.
- **`/api/health` no longer tells an unauthenticated caller the exact build version.** It still
  reports it on the 503 responses, where the question is "which build is broken?".
- **INSTALL.md now says plainly what a downloaded backup contains:** the complete household financial
  record plus every password hash. Store it encrypted.
```

**`docs/PENDING-FIXES.md`.** All 28 items — **S, T, U, V, W, X, Y, Z, AA, AB, AC, AD, AE** and
**AT, AU, AV, AW, AX, AY, AZ, BA, BB, BC, BD, BE, BF, BG, BH** — flip their `Status:` line from
`OPEN` to `SHIPPED in v1.12.1`. The two section headings above them are re-titled from "candidates"
to "SHIPPED in v1.12.1". Nothing is deleted: the entries stay as the record of what was wrong and
why.

**Release guard.** `tests/ops/docker.test.ts:248-268` (the 1.12.0 MUST-7.1 block) keeps its slice
bounds and has its version assertion flipped to `not.toBe`, per the file's append-only discipline; a
new 1.12.1 block goes above it.

**No tag, no push.** A tag push repoints GHCR `:latest`, which the NAS pulls. That is the owner's to
make.

---

## What this does NOT build

- **No per-user data boundary, no `users.visibility`, no audit log, no ownership gates.** That is
  v1.13.0, under ruling R1.
- **No per-user export and no user deletion.** Dropped by the owner with R1.
- **No new notification channel, no new dependency, no new endpoint** (R6). Two new *event ids* are
  added (AA), which is a row in an existing registry, not a channel.
- **No second migration and no table rebuild.** One file, two additive columns (R8, P1).
- **No admin banner for the TRUST_PROXY mismatch** (P6) and **no `revalidatePath` narrowing** (P7).
- **No seeded item type of kind Bill** — BH is a hint, not a row in a user-managed table.
- **No change to the `'http:'` literal in `login/actions.ts`.** Its docblock's reasoning still holds;
  AC closes the gap from the browser side and from the log, not by guessing a protocol.
- **No amount comparison in bill matching.** R2 says so, and C7 of the v1.12.0 spec said so first.
