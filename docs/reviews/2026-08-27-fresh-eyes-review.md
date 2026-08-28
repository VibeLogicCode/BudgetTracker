# Fresh-eyes review — 2026-08-27

Four independent review lenses (security/privacy, money-math/data integrity, UX/resilience, product gaps) run against v1.12.0 (commit e78a9e4). Findings are evidence-cited; 'Unverified' sections are hypotheses not confirmed in code. Owner rulings and release grouping live in PENDING-FIXES.md items S onward.

## Security lens

Read-only audit, 2026-08-27. Every finding below was read in source; no file was modified, no
server started, no test run, `.tmp-data/budget.db` never opened. Backlog items A–R (feature map
§9) are excluded.

Verdict up front: **the auth *mechanics* are unusually good for a self-hosted app** — the guard
coverage is complete, CSRF is applied uniformly, the crypto is correct, and the file/backup
handling is genuinely hardened. The problem is not a missing check. It is that the app has no
concept of "my data" at all, and the deployment (friends and extended family with their own
logins) is not the deployment its design assumed.

---

### Visibility model (built from code)

`requireUser()` establishes only "a session exists" (`src/lib/auth/session.ts:179-183`). No guard
compares the session user against any row's owner column at read time. The only read-path filter
enforced in SQL anywhere is budgets' scope predicate and the notification tables.

| Entity | Owner column? | Read scope, non-admin | Write scope, non-admin | Evidence |
|---|---|---|---|---|
| `transactions` | `attributedUserId` (nullable) | **All rows.** Filter applied only if the caller passes one; `getTransaction(id)` has none. | **All rows** — categorize, rename, split, attribute, transfer-flag, loan-link | `src/lib/transactions.ts:144,166-168`; `src/app/(app)/transactions/actions.ts:99-451` |
| `transaction_splits` | none | All | All | `src/lib/splits.ts:63-83`; `src/app/(app)/transactions/actions.ts:395-398` |
| `accounts` | `ownerUserId` (nullable) | **All rows**, owned or not | none (admin-only) | `src/lib/accounts.ts:33-43`; `src/app/(app)/settings/accounts/actions.ts:65,103,167` |
| `account_balance_snapshots` | none (structurally) | All | via import only | `src/db/schema.ts:439-452` |
| `warranty_items` (warranty/subscription/contract/**loan**/bill) | `ownerUserId` **NOT NULL** | **All rows**, incl. direct `/warranties/<id>` | **All rows** — create, edit, **delete** | `src/lib/warranty/items.ts:356-367`; `src/app/(app)/warranties/[id]/page.tsx:17-21`; `src/app/(app)/warranties/actions.ts:69-76` |
| `warranty_receipts` (files) | inherits | **All** — `/api/warranties/receipts/<id>` resolves any id for any session | **All** — delete, re-OCR | `src/app/api/warranties/receipts/[id]/route.ts:55-66`; `src/lib/warranty/items.ts:525` |
| `loan_matcher_rules`, `bill_installments`, `loan_payments` | via item | All | All | `src/app/(app)/warranties/actions.ts:527,586,633,665,691` |
| `goals` | `ownerUserId` (nullable) | **All rows + every contribution** (amount, contributor, date) | **Own or shared only** — `canActOnOwner()` | read: `src/lib/goals.ts:173,217-227`; write: `src/app/(app)/goals/actions.ts:27-29,38,68,91,110` |
| `budgets` / `budget_rollover` | `userId` (personal scope) | Scoped in SQL, **but `/budgets` renders every active member's personal budgets in one page load** | Own personal + any household amount; admin for others' personal and for household rollover | `src/lib/budgets.ts:41-45`; `src/app/(app)/budgets/page.tsx:72-81`; `src/app/(app)/budgets/actions.ts:45,73,110,150,195,198` |
| `imports` (history + undo) | `importedBy` (audit only) | All | **Any member can undo any import**, deleting its transactions | `src/lib/import/commit.ts:308-324,369,390`; `src/app/api/import/undo/route.ts:18-29` |
| `categories`, `merchant_rules`, `bayes_*`, `import_profiles`, `warranty_item_types`, `settings` | none | All | admin via `/settings/managers` — **but members write `merchant_rules` through the rename/categorize/transfer paths** (see SEC-6) | `src/app/(app)/settings/managers/actions.ts:125,176`; `src/lib/categorize/engine.ts:657-677`; `src/lib/categorize/rules.ts:61-89` |
| Reports / exports (`/api/reports/export`, `/api/reports/tax-export`) | n/a | **Whole household ledger**, any member | n/a | `src/app/api/reports/export/route.ts:18-55`; `src/app/api/reports/tax-export/route.ts:17-26` |
| Backup download (whole DB + all receipts) | n/a | admin only | n/a | `src/app/api/backup/download/route.ts:27-29` |
| `notification_targets` / `_prefs` / `_user_settings` | `userId` | **Own only** — id always from session | Own only | `src/app/(app)/settings/notifications/actions.ts:166,228,244,257,363`; page `:39,43,72,75` |
| `notification_outbox` (delivery history) | `userId` | Own for member; **all users for admin**, with `subject`/`attempts` deliberately stripped, `lastError` kept | n/a | `src/app/(app)/settings/notifications/page.tsx:12-35,59` |
| `simplefin_connections` (bank credential) | none | admin only; access URL never returned | admin only | `src/app/api/simplefin/claim/route.ts:18,33` |
| `sessions`, `login_attempts`, `totp_recovery_codes` | `userId` | not exposed in any UI | self only | `src/lib/auth/session.ts`, `src/lib/auth/totp.ts` |

**Summary:** every owner column except `budgets.userId` and the notification tables is a *label*,
not a filter. This is documented intent, not an oversight — `src/app/(app)/warranties/actions.ts:69-76`
states it explicitly ("owner_user_id is ATTRIBUTION, not access control"), as does
`src/app/(app)/transactions/actions.ts:241-247`. See SEC-1.

---

### Guard audit

Guard order in every mutating handler is: origin check → auth → validation. No exceptions found.

#### Server actions (`'use server'`)

| File / export | Guard | isSameOrigin | User-scoped |
|---|---|---|---|
| `budgets/actions.ts` `setLimitAction` :29 | requireUser :32 | y :30 | y (`:45`) |
| `budgets/actions.ts` `copyPreviousMonthAction` :63 | requireUser :66 | y :64 | y (`:73`) |
| `budgets/actions.ts` `applySuggestionAction` :87 | requireUser :90 | y :88 | y (`:110`) |
| `budgets/actions.ts` `applyAllSuggestionsAction` :135 | requireUser :138 | y :136 | y (`:150`) |
| `budgets/actions.ts` `setRolloverAction` :182 | requireUser :185 | y :183 | y (`:195,198`) |
| `goals/actions.ts` `createGoalAction` :31 | requireUser :33 | y :32 | y (`:38`) |
| `goals/actions.ts` `addContributionAction` :60 | requireUser :62 | y :61 | y (`:68`) |
| `goals/actions.ts` `archiveGoalAction` :82 | requireUser :84 | y :83 | y (`:91`) |
| `goals/actions.ts` `deleteContributionAction` :99 | requireUser :101 | y :100 | y (`:110,115-116`) |
| `import/actions.ts` `saveWizardProfileAction` :34 | requireUser :37 | y :35 | n-a (global profile) |
| `import/actions.ts` `setCardPersonAction` :75 | requireUser :78 | y :76 | **n** — any member maps any card to any user (documented :66-67) |
| `review/actions.ts` `acceptGuessAction` :18 | requireUser :21 | y :19 | n (household) |
| `review/actions.ts` `fixCategoryAction` :35 | requireUser :38 | y :36 | n (household + writes a global rule) |
| `review/actions.ts` `applyToAllMatchingAction` :53 | requireUser :56 | y :54 | n (writes a global rule) |
| `review/actions.ts` `markTransferAction` :65 | requireUser :68 | y :66 | n (writes a global rule) |
| `settings/accounts/actions.ts` create/setActive/update :62,100,164 | requireAdmin :65,103,167 | y :63,101,165 | n-a |
| `settings/actions.ts` `changePasswordAction` :80 | requireUser :83 | y :81 | y (self) — **no session invalidation, SEC-3** |
| `settings/actions.ts` `beginTotpEnrollmentAction` :98 | requireUser :101 | y :99 | y (self) |
| `settings/actions.ts` `confirmTotpEnrollmentAction` :108 | requireUser :111 | y :109 | y (self) |
| `settings/actions.ts` `disableTotpAction` :131 | requireUser :134 | y :132 | y (self) — **no re-auth, SEC-4** |
| `settings/actions.ts` enable/disableUpdateChecks, setAutoApply, checkForUpdateNow :172,182,192,203 | requireAdmin :175,185,195,206 | y (via `updateGuard()` :164-170) | n-a |
| `settings/actions.ts` `reviewUpdateAction` :230, `applyUpdateAction` :255, `dismissUpdateAction` :303 | requireAdmin :232,258,306 | y :231 / guard | n-a |
| `settings/backups/actions.ts` `setRetentionAction` :20 | requireAdmin :22 | y :21 | n-a |
| `settings/backups/actions.ts` `runBackupNowAction` :32 | requireAdmin :34 | y :33 | n-a |
| `settings/backups/actions.ts` `stageRestoreAction` :60 | requireAdmin :68 | y :64 | n-a |
| `settings/connections/actions.ts` `forgetConnectionAction` :26, `setSimplefinAutoSyncAction` :59 | requireAdmin :29,62 | y :27,60 | n-a |
| `settings/item-types/actions.ts` create/rename/setKind/delete :43,63,84,105 | requireAdmin :49,69,90,111 | y :47,67,88,109 | n-a |
| `settings/managers/actions.ts` 9 category/rule/profile actions :45-261 | requireAdmin (all) | y (all) | n-a |
| `settings/notifications/actions.ts` `saveSmtpAction` :120, `removeSmtpAction` :147, `testSmtpAction` :156 | requireAdmin :123,150,159 | y (`guard()` :113-117) | n-a |
| `settings/notifications/actions.ts` saveTelegram/saveEmail/removeTarget/testTarget/savePreferences/detectTelegramChatId :163,225,241,254,360,414 | requireUser :166,228,244,257,363,416 | y | **y — id from session, never a field** (:166) |
| `settings/users/actions.ts` create/setActive/resetPassword/resetMfa :28,52,71,90 | requireAdmin :31,55,74,93 | y :29,53,72,91 | n-a; destroys target sessions on :62,84,97 |
| `transactions/actions.ts` `manualEntryAction` :51 | requireUser :54 | y :52 | n (household) |
| `transactions/actions.ts` `setCategoryAction` :99 | requireUser :102 | y :100 | n |
| `transactions/actions.ts` `setAttributionAction` :125 | requireUser :128 | y :126 | **n** — any member re-attributes any transaction to anyone |
| `transactions/actions.ts` `bulkCategorizeAction` :137, `bulkTransferAction` :153 | requireUser :140,156 | y :138,154 | n |
| `transactions/actions.ts` `saveNoteAction` :169 | requireUser :172 | y :170 | n |
| `transactions/actions.ts` `renameTransactionAction` :192 | requireUser :195 | y :193 | **n** — writes a global rule (SEC-6) |
| `transactions/actions.ts` `assignToLoanAction` :252, `unassignFromLoanAction` :316 | requireUser :254,318 | y :253,317 | n (documented :241-247) |
| `transactions/actions.ts` `saveSplitsAction` :395 | requireUser :398 | y :396 | n |
| `warranties/actions.ts` create/update/delete/attachReceipts/deleteReceipt/reRunOcr/saveLoanRule/deleteLoanRule/add-remove-setPaid Installment :339,366,411,434,469,491,525,584,627,660,686 | requireUser (all) | y (all) | **n — by design** (:69-76) |
| `change-password/actions.ts` `forcedChangePasswordAction` :31 | requireUser :37 | y :35 | y (self); destroys other sessions :56 |
| `login/actions.ts` `loginAction` :26 | **none — public by design** | y :32 | n-a |
| `setup/accounts/actions.ts` `saveSetupAccountsAction` :31 | requireAdmin :34 | y :32 | n-a |
| `setup/actions.ts` `setupAction` :24 | **none — gated by `isSetupRequired()` :32**, race-safe via `createFirstAdmin`'s transaction (`src/lib/auth/users.ts:136-162`) | y :28 | n-a |

#### API route handlers

| Route | Guard | Origin check | User-scoped |
|---|---|---|---|
| `POST /api/auth/logout` :15 | none — no-op without a session | `assertSameOrigin` :17 | acts on caller's own token only :27-37 |
| `GET /api/health` :23 | **none — public by design** :24 | n-a | n-a |
| `GET /api/backup/download` :24 | `userFromRequest` + 401 + **role==='admin'** :27-29 | `isSameOriginOrHeaderless` :25 | n-a |
| `POST /api/import/raw-preview` :13 | userFromRequest+401 :20-21 | `assertSameOrigin` :14 | n |
| `POST /api/import/preview` :23 | userFromRequest+401 :30-31 | `assertSameOrigin` :24 | n |
| `POST /api/import/commit` :19 | userFromRequest+401 :26-27 | `assertSameOrigin` :20 | n (records `userId` as importer :44) |
| `POST /api/import/undo` :11 | userFromRequest+401 :18-19 | `assertSameOrigin` :12 | **n — any member undoes any import** |
| `GET /api/packs/rules/export` :19, `GET /api/packs/profiles/export` :12 | 401 + admin :23-24 / :16-17 | `isSameOriginOrHeaderless` :20 / :13 | n-a |
| `POST /api/packs/rules/import` :30, `POST /api/packs/profiles/import` :8 | 401 + admin :38-39 / :16-17 | `assertSameOrigin` :32 / :10 | n-a |
| `GET /api/reports/export` :18 | userFromRequest+401 :21-22 | `isSameOriginOrHeaderless` :19 | **n — whole household ledger** |
| `GET /api/reports/tax-export` :17 | userFromRequest+401 :20-21 | `isSameOriginOrHeaderless` :18 | **n** (deliberate, :9-11) |
| `GET /api/simplefin/accounts` :24 | 401 + admin :27-29 | `isSameOriginOrHeaderless` :25 | n-a |
| `POST /api/simplefin/claim` :9, `/link` :15, `/sync` :10 | 401 + admin :17-18 / :23-24 / :18-19 | `assertSameOrigin` :12/:17/:12 | n-a |
| `GET /api/warranties/receipts/[id]` :47 | userFromRequest+401 :55-56 | `isSameOriginOrHeaderless` :52 | **n — any receipt, any session** |
| `POST /api/warranties/receipts/stage` :51 | userFromRequest+401 :61-62 | `assertSameOrigin` :55 | n-a |
| `GET /api/warranties/receipts/stage/[stagingId]` :24 | userFromRequest+401 :27-28 | `isSameOriginOrHeaderless` :25 | n (UUIDv4 id, unguessable) |

**No unguarded mutating action or route handler exists.** Two public endpoints (`/api/health`,
`/api/auth/logout`) and two public actions (`loginAction`, `setupAction`) are intentional and
correctly bounded. Outer layers: `src/proxy.ts:63-90` (coarse cookie-presence redirect + security
headers), `src/app/(app)/layout.tsx:20-22` (`requireUser` + forced-password-change redirect).

---

### Findings (ranked, most severe first)

#### SEC-1. Every signed-in person — including friends and extended family — can read the entire household's finances — Severity: Critical — Effort: L

**What:** There is no per-user data boundary. Any account on this install can open `/transactions`
and read every transaction the household has ever imported or typed; open `/warranties/<id>` for
any id and read anyone's loan balances, interest rates, subscriptions and contracts; download any
receipt image by incrementing an integer at `/api/warranties/receipts/<id>` (receipts routinely
carry a home address, a card's last four digits and a full itemised purchase); pull the complete
ledger as CSV from `/api/reports/export`, and a whole tax year from `/api/reports/tax-export`;
and see every other member's personal budget limits and per-category spend, because `/budgets`
renders all of them in one page load. This is documented design intent — the code states plainly
that `owner_user_id` is attribution and not access control — and it is a defensible design for a
two-adult household. It is the wrong design for the stated user population, where friends and
extended family each hold their own login. Nothing about a friend's account distinguishes it from
a spouse's.

**Evidence:**
- `src/app/(app)/warranties/actions.ts:69-76` — *"Warranty items are household-shared (§1.3): every signed-in member may create, edit or delete any item or receipt. owner_user_id is ATTRIBUTION, not access control, so there is deliberately no requireAdmin() anywhere in this file."*
- `src/lib/warranty/items.ts:356-367` — `getWarrantyItem(id)` joins on the owner only to fetch the owner's *name*; no owner predicate. `src/app/(app)/warranties/[id]/page.tsx:17-21`: `await requireUser(); … const item = getWarrantyItem(Number(raw)); if (!item) notFound();` — no ownership comparison.
- `src/app/api/warranties/receipts/[id]/route.ts:65-66` — `const receipt = getWarrantyReceipt(id); if (!receipt) return new Response('Not found', { status: 404 });` — session checked, ownership never.
- `src/lib/transactions.ts:166-168` — `getTransaction` has no filter; `src/lib/transactions.ts:144` applies `attributedUserId` only when the caller supplies it.
- `src/lib/accounts.ts:33-43`, `src/lib/goals.ts:173,217-227`, `src/lib/loans.ts:867`, `src/lib/import/commit.ts:308` — same shape, no owner predicate anywhere.
- `src/app/(app)/budgets/page.tsx:72-81` — loops `listUsers().filter(u => u.isActive)` and renders each person's `budgetProgress(month, 'personal', person.id)`.
- `src/app/api/reports/export/route.ts:21-55` — session only, then `transactionsCsv(filter)` over everything.

**Fix:** Decide the model explicitly rather than letting it stay implicit. Cheapest option that
matches the stated reality: introduce a third role (`guest`) and a `households`/`circle` id, then
add the predicate in the *query layer*, not the page layer — `src/lib/transactions.ts`,
`src/lib/warranty/items.ts`, `src/lib/goals.ts`, `src/lib/loans.ts`, `src/lib/accounts.ts`, and
`src/lib/reports.ts` are the six chokepoints. If a full boundary is too much, the 80% mitigation
is to stop giving friends accounts on this install at all and document that in `INSTALL.md` — the
app is safe for one household and is not built to be safe for two. Whichever path: add a
`tests/ops/` invariant guard in the style of `balance-invariants.test.ts` asserting that every
exported `get*`/`list*` in those six modules takes a viewer id, so the boundary cannot rot back
out. Also add a route-level test that user B's session gets 404 (not 200) from
`/api/warranties/receipts/<A's receipt id>`.

---

#### SEC-2. Any signed-in person can permanently destroy anyone else's records, and nothing records who did it — Severity: High — Effort: M

**What:** Deletion is as unscoped as reading, and there is no audit table anywhere in the schema.
A member (or a friend) can delete any warranty/loan/subscription item and, by cascade, its
receipts; delete any individual receipt file; and undo any import — which deletes every
transaction that import solely introduced, together with its Bayes training, loan links and
bill-installment links. The restore path exists, but a restore is an all-or-nothing rollback of
the whole database and the family would first have to notice. Because no row records the actor,
after the fact nobody can tell which account did it. Note this is not merely theoretical mischief:
`undoImport` is a one-request operation against a plain integer id.

**Evidence:**
- `src/app/(app)/warranties/actions.ts:411-433` — `deleteWarrantyAction`: `isSameOrigin` → `await requireUser();` → `deleteWarrantyItem(id.data)`. No owner check. Same at `:469-490` (`deleteReceiptAction`, which resolves the receipt by id alone at `:477`).
- `src/app/api/import/undo/route.ts:18-29` — `userFromRequest` + `importExists(importId)` are the only checks before `undoImport(parsed.data.importId)`.
- `src/lib/import/commit.ts:390-435` — `undoImport` deletes the "sole" transactions.
- `src/db/schema.ts` — no audit/event-log table; `transactions.createdBy` and `imports.importedBy` record creation only, and `merchant_rules.createdBy` is *overwritten* on upsert (see SEC-6).

**Fix:** Gate destructive operations behind ownership-or-admin (reuse `canActOnOwner()` from
`src/app/(app)/goals/actions.ts:27-29` — it is already the right shape) in
`warranties/actions.ts` delete/deleteReceipt and in `api/import/undo/route.ts`. Independently, add
a minimal append-only `audit_log(id, at, userId, action, entity, entityId)` written by the delete
paths and `undoImport`, surfaced on an admin page. Test: user B calling `deleteWarrantyAction` on
user A's item returns an error and leaves the row present.

---

#### SEC-3. Changing your own password does not sign out any other session — Severity: Medium — Effort: S

**What:** If someone's session cookie is captured (shared laptop, a browser left signed in, a
phone lent to a child, plain-HTTP traffic on the LAN), the victim's instinctive remedy — change my
password in Settings — does not help. The attacker's session keeps working for up to 30 more days
because nothing deletes it. Two sibling flows in the same codebase do this correctly, which makes
the omission look like an oversight rather than a decision: the forced first-login change destroys
every other session, and an admin password reset destroys all of them. The Settings path destroys
none. There is also no session list in the UI, so the victim cannot see or revoke the stale
session — the only escape is the "sign out everywhere" scope on the logout POST, which is not
what a person reaches for after a password change.

**Evidence:**
- `src/app/(app)/settings/actions.ts:80-96` — the whole action: verify current password, `await setUserPassword(user.id, parsed.data.newPassword);`, `revalidatePath('/settings')`, return. No session call.
- `src/lib/auth/users.ts:169-173` — `setUserPassword` writes the hash and nothing else (its own docblock at `:164-168` confirms it deliberately touches only the hash).
- Contrast `src/app/(auth)/change-password/actions.ts:55-56` — `const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value; if (token) destroyOtherSessionsForUser(user.id, token);` — and its docblock at `:25-29`, which describes itself as the Settings action "with two additions".
- Contrast `src/app/(app)/settings/users/actions.ts:84` — `destroyAllSessionsForUser(parsed.data.userId);`.
- Session TTL is 30 days with sliding renewal: `src/lib/auth/session-constants.ts:3`, `src/lib/auth/session.ts:81-89`.

**Fix:** In `src/app/(app)/settings/actions.ts:93`, after `setUserPassword`, read the session
cookie and call `destroyOtherSessionsForUser(user.id, token)` — the same three lines as
`change-password/actions.ts:55-56`. Add a test asserting a second session row for that user is
gone after `changePasswordAction` succeeds and the caller's own row survives.

---

#### SEC-4. Two-factor authentication can be switched off from a live session with no re-authentication and no alert — Severity: Medium — Effort: S

**What:** `disableTotpAction` takes no password, no current TOTP code, and no confirmation beyond
the button. Anyone sitting at an unlocked browser, or holding a stolen session cookie, can strip
the account's second factor in one click, and the account owner is never told: the notification
event registry has no MFA-changed or password-changed event, so nothing is sent. The account is
then a password-only account, and the attacker (who already had the session) has converted a
temporary foothold into a durable one. Enrollment is done carefully by comparison — the candidate
secret is held server-side in an encrypted, short-lived httpOnly cookie precisely so a client
cannot supply its own — which makes the unprotected teardown the weak half of the pair.

**Evidence:**
- `src/app/(app)/settings/actions.ts:131-139` — the entire action:
  `if (!isSameOrigin(await headers())) …; const user = await requireUser(); clearTotpEnrollment(user.id); await clearPendingTotpSecret(); revalidatePath('/settings'); return { message: 'Two-factor authentication is off.' };`
- `src/lib/auth/totp.ts:158-164` — `clearTotpEnrollment` nulls the secret and deletes every recovery code, with no session teardown.
- Contrast `src/app/(app)/settings/users/actions.ts:96` — the *admin* MFA reset calls `destroyAllSessionsForUser`, with a comment explaining that lowering the authentication bar must not leave sessions running.
- `src/lib/notify/events.ts:47-184` — 17 events; none covers MFA or password change (`new_signin` is the only account-security event).

**Fix:** Require the current password in `disableTotpAction` (mirror the `verifyPassword` block at
`src/app/(app)/settings/actions.ts:87-90`), and call `destroyOtherSessionsForUser` after it
succeeds. Separately, add `mfa_disabled` and `password_changed` immediate events to
`src/lib/notify/events.ts` with `defaultEnabled: true`, raised from these actions — the
`raiseNewSignin` pattern in `src/lib/notify/raise.ts:35-71` is the template. Test: the action
returns an error when the password field is absent or wrong, and `totpEnabled` stays true.

---

#### SEC-5. Login rate limiting and the sign-in alert both key on a header the client controls — Severity: Medium — Effort: S

**What:** A server action has no socket, so the login action substitutes the `X-Real-IP` *request
header* for the client's address — and passes it as the `socketIp` argument, the parameter that
`clientIpFromHeaders` uses precisely because it is supposed to be untrusted-input-free. With
`TRUST_PROXY` off (the default, and what a plain LAN install runs), that header is accepted
verbatim from whoever sent it. Two consequences. First, the per-(username, IP) lockout layer —
5 failures in 15 minutes — never fires against an attacker who varies the header, so only the
username-only layer (10 failures per 15-minute burst) actually constrains a password-guessing run.
Second, and worse for a household that relies on the alert: the same forged value is stored on the
session row and rendered verbatim into the "New sign-in to your account" message, so an attacker
who succeeds chooses what IP the family is told they signed in from — including the owner's own
LAN address. The value is also unbounded in length and never validated as an address.

**Evidence:**
- `src/app/(auth)/login/actions.ts:51` — `const ip = clientIpFromHeaders(requestHeaders, requestHeaders.get('x-real-ip'));`
- `src/lib/auth/ratelimit.ts:140-150` — the docblock says *"Socket IP unless TRUST_PROXY is on"*; the function returns `socketIp` unconditionally when `trustProxy` is false, so the header is the socket IP as far as it knows.
- `src/lib/auth/ratelimit.ts:103-113` — Layer A is `failuresSince(username, input.ip, …)`, keyed on that value.
- `src/lib/auth/login.ts:117` — `createSession(user.id, { userAgent: …, ip: input.ip, at })`; `src/lib/auth/login.ts:125-132` passes the same `input.ip` to `raiseNewSignin`.
- `src/lib/notify/render.ts:392-398` — ``` `${truncateText(input.name, NAME_MAX)} signed in at ${input.atLabel} (${input.tz}) from ${input.ip}.` ``` — `name` and `userAgent` are length-bounded; `ip` is not.

**Fix:** In `src/lib/auth/ratelimit.ts:141`, ignore `x-real-ip` unless `env.trustProxy` is on —
treat it the same way `x-forwarded-for` already is — and have `login/actions.ts:51` pass `null`
when the proxy is not trusted, so the bucket falls back to the literal `'unknown'` and Layer A
degrades to a shared bucket rather than an attacker-partitioned one. Validate and truncate the
value before it reaches `sessions.ip` or `renderEvent` (an `isIP()` check plus a 45-char cap).
Test: two failed logins with different `X-Real-IP` values land in the same Layer A bucket when
`TRUST_PROXY=0`.

---

#### SEC-6. Any member can create and silently overwrite the household-global merchant rules that only admins can see and delete — Severity: Medium — Effort: S

**What:** Rule management at `/settings/managers` is admin-only, but four member-level actions
write the same `merchant_rules` table through the back door: renaming a transaction "for all",
fixing a category and applying it to all matching rows, and marking something a transfer. The
upsert overwrites an existing rule's category, its rename text *and its `createdBy`* on conflict,
so a member can silently rewrite an admin's rule and the row will then claim the member authored
it. Practical effect: one account can change how every household member's transactions are named
and categorised going forward, and `markTransferAction` can flag a merchant as a transfer, which
removes those transactions from every spend aggregate, budget and report. The member who did it
cannot undo it — only an admin can reach the delete control. It is a privilege asymmetry pointing
the wrong way: write without read, write without revoke.

**Evidence:**
- Admin-only management: `src/app/(app)/settings/managers/actions.ts:122-125` (`updateRuleAction` → `requireAdmin()`), `:173-176` (`deleteRuleAction` → `requireAdmin()`).
- Member write paths: `src/app/(app)/transactions/actions.ts:192-195` → `upsertRenameRule` at `:226`; `src/app/(app)/review/actions.ts:35-38,53-56,65-68` — all `requireUser()`.
- `src/lib/categorize/engine.ts:657-677` — `upsertRenameRule` → `upsertRuleFromCorrection`.
- `src/lib/categorize/rules.ts:85-88` — `.onConflictDoUpdate({ target: [pattern, matchType, ruleKind], set: { categoryId: input.categoryId, renameTo, createdBy: input.createdBy } })` — overwrites the previous author.

**Fix:** Either (a) let members read `/settings/managers`' rule list in read-only mode so a rule
they created is visible and reportable, or (b) preserve `createdBy` on conflict (drop it from the
`set` object at `src/lib/categorize/rules.ts:87`) and add a `lastModifiedBy` column so overwrites
are attributable. (b) is the smaller change and should happen regardless. Test: a member upsert
over an admin-authored rule leaves `created_by` unchanged.

---

#### SEC-7. The session cookie is never marked Secure unless `TRUST_PROXY` is explicitly turned on — Severity: Medium — Effort: S

**What:** The login and setup actions pass the literal string `'http:'` as the request protocol,
so the only path to a `Secure` cookie is `TRUST_PROXY=1` plus a matching `X-Forwarded-Proto`. That
is a deliberate and well-argued choice (a server action has no raw request, and inferring the
protocol from a client header would be worse), but it produces a quiet failure mode for exactly
the deployment the brief describes as possible: the app put behind an HTTPS reverse proxy while
`TRUST_PROXY` is left at its default `0`. Everything appears to work, and the 30-day session cookie
is sent over any plain-HTTP request to the same host — a downgrade or a mixed-content path leaks
it. Nothing in the app detects or warns about the mismatch, and there is no HSTS header to close
the gap from the browser side. The compose file's comment tells the operator when to enable the
flag but nothing enforces it.

**Evidence:**
- `src/app/(auth)/login/actions.ts:83-92` — the comment states it outright: *"a direct-HTTPS-without-a-reverse-proxy deployment of this app will not get a Secure cookie"*; `:92` calls `shouldUseSecureCookie('http:', requestHeaders)`. Identical at `src/app/(auth)/setup/actions.ts:46-51`.
- `src/lib/auth/session.ts:131-137` — `shouldUseSecureCookie` returns false immediately unless the protocol is `https:` or `env.trustProxy` is set.
- `src/lib/env.ts:186` — `trustProxy: TRUTHY.has((source.TRUST_PROXY ?? '').trim().toLowerCase())`, default off; `docker-compose.yml:15` — `TRUST_PROXY: ${TRUST_PROXY:-0}`.
- `src/lib/auth/security-headers.ts:37-48` — no `Strict-Transport-Security`.

**Fix:** Detect the mismatch instead of documenting it: if `TRUST_PROXY` is off but an incoming
request carries `X-Forwarded-Proto: https`, log a loud boot/first-request warning and surface a
banner on `/settings` for admins. Emit `Strict-Transport-Security` from
`src/lib/auth/security-headers.ts` only when the resolved connection is HTTPS (never on the plain
LAN default, where it would brick the install). Consider the `__Host-` cookie prefix once Secure
is reliable. Test: `securityHeaders()` includes HSTS under the HTTPS branch and omits it otherwise.

---

#### SEC-8. A backup archive is the whole ledger, every receipt and every password hash — but not the key that would unlock the stored credentials — Severity: Low — Effort: S

**What:** Worth stating precisely because the intuition ("the backup carries the bank credentials")
is half right. `/api/backup/download` is admin-only and produces a `VACUUM INTO` snapshot of
`budget.db` plus the entire `receipts/` directory. That means one file carries every transaction,
every receipt image, every argon2 password hash (offline-crackable at leisure) and every session
token hash. It also carries the *ciphertext* of the SMTP password, each user's Telegram bot token,
every TOTP secret and the SimpleFIN access URL — but the HKDF root key those are derived from
lives at `${DATA_DIR}/secret.key`, and `buildArchive` adds only `budget.db` and `receipts`, so the
key does not travel with the archive. A stolen backup therefore does not yield the notification or
bank credentials; it yields everything else. The archive is unencrypted on disk and the download
allows a header-less GET (a deliberate, reasoned relaxation for the plain-HTTP LAN case).

**Evidence:**
- `src/lib/backup/archive.ts:99-141` — `tarCreate({...}, ['budget.db', 'receipts'])` at `:135-138`; nothing else is staged.
- `src/lib/env.ts:93-137` — the key is read from or generated into `${dataDir}/secret.key` (mode `0600`), a sibling of `budget.db`, not inside it.
- `src/db/schema.ts:19` (`passwordHash`, `totpSecretEncrypted`), `:104` (`notification_smtp.passwordEncrypted`), `:105` (`notification_targets.secretEncrypted`), `:97` (`simplefin_connections.accessUrlEncrypted`) — all inside the snapshot.
- `src/app/api/backup/download/route.ts:25-29` — `isSameOriginOrHeaderless` then admin; `src/lib/auth/csrf.ts:71-77` for the relaxation's reasoning.

**Fix:** Mostly a documentation change: `INSTALL.md` should say plainly that a downloaded backup is
the complete household financial record plus password hashes, must be stored encrypted, and that
restoring it onto a *different* install will not recover Telegram/SMTP/TOTP unless `secret.key`
is copied too (which is the current behaviour and the safe default). If you want defence in depth,
offer an optional passphrase on the on-demand download.

---

#### SEC-9. A user who has not yet completed the forced password change can still export the whole ledger — Severity: Low — Effort: S

**What:** The forced-password-change gate lives in the app layout, so it blocks pages only; the
layout's own docblock states `/api/*` is deliberately exempt. The consequence that probably was not
weighed: `/api/reports/export` and `/api/reports/tax-export` are `/api/*` routes that stream the
entire household ledger to any authenticated session. So an account still holding the temporary
password an admin typed — the exact window the flag exists to close — can pull everything before
ever choosing a password of its own. The threat is narrow (the admin knows that password anyway),
but it widens if the temporary password was shared over a channel someone else can read.

**Evidence:**
- `src/app/(app)/layout.tsx:10-22` — *"Forced password change … is gated HERE — at the page layer only, on purpose. /api/* routes keep working normally under the same session."*
- `src/app/api/reports/export/route.ts:21-22` — session check only; `:55` — `transactionsCsv(filter)`.
- `src/app/(app)/settings/users/actions.ts:41,81` — both admin paths set `mustChangePassword: true`.

**Fix:** Add a `mustChangePassword` check to the two report-export routes and to
`/api/backup/download` (the three routes that emit bulk household data), returning 403 with a
"finish setting your password first" message. Leave logout and the in-flight fetches exempt, as the
docblock intends. Test: an export request under a `mustChangePassword` session returns 403.

---

#### SEC-10. A TOTP code stays valid for its full ±30 s window and can be replayed — Severity: Low — Effort: S

**What:** `verifyTotp` runs otplib with `window: 1`, so a code is accepted for roughly 90 seconds,
and nothing records that a code has already been spent. Anyone who observes a code in that window —
shoulder-surfing, a screenshot in a chat, a phishing relay — can reuse it on a second login. The
password is still required, so this only matters once the password is already known; and a wrong
code does count as a failed attempt, so the lockout layers apply. Recovery codes, by contrast, are
correctly single-use via an atomic conditional update, which shows the pattern is understood.

**Evidence:**
- `src/lib/auth/totp.ts:22` — `const totp = authenticator.clone({ window: 1 });`
- `src/lib/auth/totp.ts:71-79` — `verifyTotp` checks format then `totpAt(at).check(cleaned, secret)`; no store of consumed counters.
- Contrast `src/lib/auth/totp.ts:113-128` — `consumeRecoveryCode` uses `UPDATE … WHERE codeHash = ? AND usedAt IS NULL` and returns `changes === 1`.
- Failure path is counted: `src/lib/auth/login.ts:110` → `fail()` → `recordLoginAttempt` (`:64-67`).

**Fix:** Record the last accepted TOTP counter per user (a `users.totpLastCounter` column) and
reject any code whose counter is less than or equal to it, in `src/lib/auth/login.ts:110`. Test:
the same code accepted once is rejected on an immediate second attempt.

---

#### SEC-11. `/api/health` tells an unauthenticated caller the exact build version — Severity: Low — Effort: S

**What:** The healthcheck is public by design and correctly returns nothing about the data. It does
return `version` on every response, including the 200. Anyone who can reach the app — which, if it
is reverse-proxied to the internet, is anyone — learns the exact release without a session, which
is the first step in matching a known advisory to this install. The in-app footer shows the same
string, but only after signing in. The route's comment argues the leak is nil for that reason; the
pre-auth/post-auth distinction is what it misses.

**Evidence:**
- `src/app/api/health/route.ts:24` — *"Unauthenticated by design: this is the container healthcheck."*
- `src/app/api/health/route.ts:62` — `Response.json({ status: 'ok', db: 'ok', dataDir: 'ok', version: APP_VERSION, time: time() })`.
- `src/app/api/health/route.ts:27-29` — the reasoning: *"it leaks nothing the footer of every page does not already show to anyone who can reach the app."*
- `Dockerfile:124-125` — the healthcheck only reads `r.ok`, never the body.

**Fix:** Drop `version` from the 200 response and keep it on the 503 responses, where its stated
purpose ("which build is broken?") actually applies. The Docker healthcheck needs no change since
it only inspects the status. Test: the 200 body has no `version` key; the 503 bodies still do.

---

### Unverified

Listed because they could not be confirmed from source alone under the read-only/no-run constraint.

1. **Whether server actions also bypass the forced-password-change gate.** The gate is in
   `src/app/(app)/layout.tsx:22`, and in the App Router a server action executes before any layout
   re-render, which would mean a `mustChangePassword` account can perform every mutation, not just
   read `/api/*` as the docblock says. *To confirm:* sign in as a user with the flag set and invoke
   `saveNoteAction` (or any action) directly; observe whether it succeeds. If it does, SEC-9's fix
   should extend to a check inside the actions, not only the routes.
2. **Whether the deployed reverse proxy overwrites `X-Real-IP`.** Many proxies set it themselves,
   which would neutralise the forgery half of SEC-5 in that specific deployment. The app cannot tell,
   and with `TRUST_PROXY=0` it does not try. *To confirm:* inspect the actual Synology/NAS proxy
   config, or send a request with a bogus `X-Real-IP` and read `sessions.ip` (which needs DB access
   — out of scope here).
3. **Whether `notification_outbox.lastError` can carry another member's email address into the
   admin-wide delivery table.** `subject` and `attempts` are explicitly stripped
   (`src/app/(app)/settings/notifications/page.tsx:12-35`) but `lastError` is not, and an SMTP
   rejection commonly quotes the recipient. `scrubForRow` removes configured secrets, not
   addresses. *To confirm:* trigger a bounce against a member's address and read the admin view.
4. **The SimpleFIN sync path end-to-end.** The routes and crypto read correctly and the owner does
   not use the feature, so it was audited statically only. *To confirm:* claim a sandbox token and
   exercise `/api/simplefin/sync`.
5. **Actual on-disk permissions of `${DATA_DIR}` on the NAS.** `secret.key` is created `0600`
   (`src/lib/env.ts:124`) and the container runs as `node` (`Dockerfile:118`), but the bind mount
   `./data:/data` (`docker-compose.yml:23`) inherits host permissions. *To confirm:* `ls -la` the
   host data directory.

---

### Things that are done well

1. **The origin check is the literal first statement of every mutating action and route**, with a
   single narrow, documented relaxation for read-only download GETs on plain-HTTP LANs (`src/lib/auth/csrf.ts:47-77`) — a rare case of a CSRF exception that is reasoned rather than assumed.
2. **CSV export defuses formula injection without breaking spreadsheets** — it prefixes `=`/`+`/`-`/`@`/tab cells with an apostrophe but exempts genuine numeric literals, so the Amount column still sums (`src/lib/reports.ts:390-411`).
3. **Receipt handling is textbook**: type decided by leading bytes not extension or declared MIME (`src/lib/warranty/sniff.ts:48-62`), stored names are server-generated UUIDs with a double regex+resolved-path guard (`src/lib/warranty/receipts.ts:40-50,65-72`), and `Content-Disposition: inline` is an allowlist of three image types so a PDF or any future type falls to `attachment` by default (`src/app/api/warranties/receipts/[id]/route.ts:18,88-90`).
4. **Restore refuses anything it did not write**: no upload-a-backup path exists at all, names are matched to an anchored regex and re-resolved inside the backups directory (`src/lib/backup/archive.ts:56-64`), tar extraction accepts only `budget.db`, `receipts/` and `receipts/<uuid>.<ext>` entries (`scripts/restore-core.ts:69-109`), and the commit journal's paths are re-checked to resolve inside `DATA_DIR` (`src/lib/backup/restore.ts:132-155`).
5. **Notification egress is allowlisted at the URL level, and the allowlist anticipates the clever attack** — the path pattern `^/bot[^/]+/(sendMessage|getUpdates)$` exists specifically because `new URL()` collapses `../` before an origin check would run (`src/lib/notify/egress.ts:15-44`); email is `text`-only and Telegram sends no `parse_mode`, removing the HTML/markdown injection surface entirely (`src/lib/notify/send/email.ts:59-66`, `src/lib/notify/send/telegram.ts:50`).

*(Honourable mention, since the brief asked: every SQL fragment in the codebase binds its
parameters — the `sql\`\`` uses are drizzle column references and bound values, with the one raw
interpolation being a `VACUUM INTO` target built only from `todayIso()` or `randomUUID()` and
single-quote-escaped: `src/lib/backup/archive.ts:70-73`.)*

## Money-math and data integrity lens

Scope: import correctness, splits/transfers, budgets, loans/bills, reports/safe-to-spend,
concurrency, schema invariants, backup/restore. Read-only audit. Backlog items A–R skipped.

### Findings (ranked, most severe first)

#### MON-1. Sub-category budget limits are silently dropped from every household total — Severity: High — Effort: S

**What:** A household that budgets at the child level ("Food > Groceries $600", "Food >
Restaurants $200") sees each child's limit and progress bar correctly on `/budgets`, but the
household summary line, the dashboard's budget tile and safe-to-spend all report **$0.00
budgeted**. `budgetProgress()` returns only top-level rows (children hang off `row.children`),
and `budgetTotals()` iterates that array without ever descending into `row.children`. Its own
comment — "children are already rolled into their parent" — is true for **spend**
(`foldRollup`) but false for **limits**: a parent with no limit of its own contributes
`limitCents === null` and is skipped entirely, taking every child limit underneath it with it.

The same defect has a second face: `budgetProgress` builds child rows from `renderChildren`,
which excludes archived children, while `rollupChildren` (used for spend) includes them. So
archiving a child category makes its **limit** disappear from every number while its **spend**
keeps counting against the parent — the parent flips to over-budget for no visible reason.

**Example:** Categories `Food` (top level, no limit), children `Groceries` (limit $600) and
`Restaurants` (limit $200). August spend: $500 groceries, $150 restaurants, nothing else.
- `budgetProgress('2026-08')` returns one top-level row: `Food`, `limitCents = null`,
  `spentCents = 65000`, with two child rows carrying `limitCents` 60000 and 20000.
- `budgetTotals(rows)` returns `budgetedLimitCents = 0`, `budgetedSpentCents = 0`,
  `totalSpentCents = 65000`.
- `safeToSpend()` returns `budgetedRemainingCents = 0 - 0 = 0`.

Dashboard shows "$0.00 left in budgets" and the budgets header shows "spent $0.00 of $0.00
budgeted · $650.00 total spent". The true figure is $150.00 remaining of $800.00 budgeted.

**Evidence:**
- `src/lib/budgets.ts:471-488` — `budgetTotals` loops `rows` only; never touches `row.children`.
- `src/lib/budgets.ts:449-458` — `budgetProgress` returns `all.filter(parentId === null)`, so
  the array handed to `budgetTotals` is top-level only.
- `src/lib/budgets.ts:419,426` — each child row does get its own `effectiveBudget(...)`, so the
  limits exist and are rendered; only the totals lose them.
- `src/lib/budgets.ts:455-457` — `renderChildren` drops archived children; `allChildren`
  (rollup) keeps them.
- Consumers of the wrong pair: `src/lib/bills.ts:170-171` (safe-to-spend),
  `src/app/(app)/dashboard/page.tsx:44,91`, `src/app/(app)/budgets/page.tsx:123`,
  `src/app/(app)/budgets/budgets-client.tsx:376,411-416`,
  `src/lib/notify/evaluate/monthly.ts:171` (month-end digest).
- Contrast: the notification evaluators do it right — `src/lib/notify/evaluate/budget.ts:29,236`
  and `src/lib/notify/evaluate/pace.ts:116-117` flatten parents *and* children before scoring,
  so budget alerts fire on a child limit the dashboard claims does not exist.

**Fix:** Have `budgetTotals` fold over a flattened row list, and decide the parent/child overlap
rule explicitly (recommended: a parent's own `limitCents` supersedes its children's when set,
otherwise sum the children's — a naive flatten-and-sum double-counts whenever both levels carry
a limit, because the parent's `spentCents` already includes the children's). Reuse
`flattenBudgetRows` from `src/lib/notify/evaluate/budget.ts` rather than writing a third
traversal. Separately, render archived children as read-only rows when they carry a limit or
non-zero spend, mirroring the archived-top-level rule at `budgets.ts:453`.
**Test:** in `tests/lib/budgets.test.ts` — parent with no limit plus two limited children asserts
`budgetedLimitCents === 80000`; parent with a limit plus limited children asserts no double
count; archived child with a limit and spend asserts the limit still appears in the total.

#### MON-2. One transaction can pay a bill installment and a loan at the same time — Severity: High — Effort: S

**What:** The rule matcher enforces cross-table exclusivity: `alreadyLinked()` reads the union
of `loan_payments.txn_id` **and** `bill_installments.paid_txn_id`, exactly so "a loan and a bill
whose rules both match one merchant string cannot both take the payment". The **manual** assign
path does not. `assignTransactionToLoan()` never looks at `bill_installments`, so a transaction
the matcher already used to mark a bill installment paid can be hand-assigned to a loan and
decrement that loan's balance by the same money. Worse, the over-link warning that exists for
exactly this class of mistake is blind to it: it sums `loanLinksForTransactions(...)` only, so
the bill leg is invisible and the user gets a plain "Assigned." with no caution.

The DB cannot catch it either: `bill_installments_txn_uq` is unique on `paid_txn_id` and
`loan_payments_txn_item_uq` is unique on `(txn_id, item_id)`, but nothing spans the two tables.

**Example:** Property-tax bill with a $1,200 installment due 2026-08-15, and a car loan with
`current_balance_cents = 1800000` ($18,000). A $1,200 payment transaction T imports and a bill
rule matches, so the `bill_installments` row is marked paid with `paid_txn_id = T`. A household
member on `/transactions` then picks the same row and assigns it to the car loan. `link()`
applies `min(120000, 1800000) = 120000`, so the loan balance drops to $16,800. The household has
now recorded $2,400 of debt reduction from a single $1,200 payment, and the action returns
"Assigned. $1,200.00 came off the balance." with no warning.

**Evidence:**
- `src/lib/loans.ts:322-341` — `alreadyLinked()`, the union that *does* enforce exclusivity, and
  its docblock ("MUST-13.4, across both kinds (ruling B11)").
- `src/lib/loans.ts:540-575` — `assignTransactionToLoan()` reads `transactions` and
  `warranty_items` only; no `bill_installments` query anywhere in the function.
- `src/app/(app)/transactions/actions.ts:284-289` — the over-link warning sums `loan_payments`
  links only.
- `src/db/schema.ts:870,920` — the two unique indexes; neither spans tables.

**Fix:** Extract the union query behind `alreadyLinked` into an exported
`paymentLinksForTransaction(txnId)` and call it from `assignTransactionToLoan` — either refuse
with a named error ("this transaction is already recorded against bill X") or, at minimum, feed
the bill leg into the over-link total so the existing warning fires.
**Test:** in `tests/lib/loans/*` — rule-mark an installment with T, then
`assignTransactionToLoan({ txnId: T, itemId: loan })` and assert the refusal (or the warning
path) plus an unchanged loan balance.

#### MON-3. Un-marking a bill installment does not stick — the matcher silently re-marks it — Severity: Medium — Effort: M

**What:** `unmarkInstallmentPaid()` clears both `paid_at` and `paid_txn_id`, which is what the
schema's third CHECK requires. But `paid_txn_id` is the *only* record that transaction T was
ever consumed by a bill, and `alreadyLinked()` is keyed on exactly that column. So the moment
the columns are cleared, T becomes a fresh matcher candidate again. Any later action that
re-runs the matcher over T re-marks the **earliest unpaid** installment — usually the very row
the person just un-marked, or a different one entirely if an older one is outstanding.
`confirmCategory()` calls `applyPaymentMatchers([id])` on **both** of its exits, including the
"already confirmed to the same category, nothing to retrain" fast path, so simply re-picking the
same category on `/transactions` or `/review` is enough to trigger it. There is no way to make
one transaction stay unlinked short of disabling the whole rule.

`removeInstallment()` is the same hole with the row deleted instead of cleared: it takes no
guard on `paid_at`/`paid_txn_id`, so deleting a paid, transaction-linked installment discards
the payment record *and* re-opens T to the matcher.

**Example:** Bill "City tax" with installments 2026-03-15 $800, 2026-06-15 $800, 2026-09-15
$800. The March one was paid by cheque and nobody marked it. Transaction T (2026-06-14, −$800)
imports and the rule fires, so `markEarliestUnpaid` marks the **March** row paid by T (amounts
are deliberately not compared). A person notices and un-marks March. Later they re-categorize T
to "Property tax" on `/review`: `confirmCategory` calls `applyPaymentMatchers([T])`, T is no
longer in `alreadyLinked`, and `markEarliestUnpaid` marks March paid by T again. The tax
schedule now permanently disagrees with reality and no UI action can fix it.

**Evidence:**
- `src/lib/warranty/installments.ts:226-234` — `unmarkInstallmentPaid` clears both columns.
- `src/lib/warranty/installments.ts:200-202` — `removeInstallment`, no paid/linked guard.
- `src/lib/loans.ts:322-341` — `alreadyLinked` derives "already used" solely from
  `loan_payments.txn_id` union `bill_installments.paid_txn_id`.
- `src/lib/loans.ts:355-375` — `markEarliestUnpaid`, earliest-unpaid, amount never compared.
- `src/lib/categorize/engine.ts:305` and `:333` — both `confirmCategory` exits call
  `applyPaymentMatchers([input.transactionId], at)`.
- `src/app/(app)/warranties/actions.ts:686-708` — `setInstallmentPaidAction` exposes the unmark.

**Fix:** Record the suppression rather than erasing it. Cheapest shape that fits the existing
schema: keep `paid_txn_id` and add a nullable `unlinked_at` (or a small
`payment_match_exclusions(txn_id)` table) that `alreadyLinked()` also unions in, so an un-marked
transaction stays out of the candidate set. Add a `paid_at IS NULL` guard, or an explicit
confirm, to `removeInstallment`.
**Test:** rule-mark an installment, un-mark it, call `confirmCategory` on the same transaction,
assert the installment is still unpaid.

#### MON-4. Balance-snapshot "source authority" (ruling R3) is documented in three places and implemented in none — Severity: Medium — Effort: S

**What:** Three separate docblocks state that snapshots for the same `(account, date)` rank
`simplefin > csv > manual`, and migration 0010 exists *specifically* so that ordering is
expressible ("'csv' is a DISTINCT source value ... because ruling R3 ranks a bank's own
statement figure above a hand-typed one"). `recordBalanceSnapshot`'s `onConflictDoUpdate` sets
`{ balanceCents, source }` unconditionally — last writer wins regardless of rank. Every balance
in the app anchors on these rows (`balancesAsOf` feeds Settings › Accounts, net worth over time,
reconciliation), so the wrong anchor propagates everywhere. The only test covering this
(`tests/lib/import/commit.test.ts:492`) asserts the csv-over-manual direction, which passes for
the wrong reason; the manual-over-csv and manual-over-simplefin inversions are untested.

**Example:** A statement CSV with a mis-mapped `balanceCol` writes `source='csv'`,
`balance_cents = 341218` for 2026-08-20. An admin corrects it by hand to $3,102.44, storing
`source='manual'`, 310244. Per R3 the csv figure should have won; per the code the manual one
does. Re-importing the same overlapping statement flips it back to 341218 — `commitImport`
re-asserts closing balances for **every** row it is handed, duplicates included
(`commit.ts:257`) — so the two writers ping-pong the anchor with no rule and no warning, and net
worth moves $309.74 each time.

**Evidence:**
- `src/lib/networth.ts:63-84` — `recordBalanceSnapshot`, unconditional `set`.
- `src/lib/networth.ts:41-47` — the R3 claim in the same file's own type doc.
- `src/db/schema.ts:434-437` and `drizzle/0010_balances.sql:9-11` — the same claim restated.
- `src/lib/import/commit.ts:247-259` — csv snapshots re-asserted on duplicate-only re-imports.

**Fix:** Either implement the rank (`ON CONFLICT ... DO UPDATE ... WHERE rank(excluded.source)
>= rank(account_balance_snapshots.source)`, with the rank as one exported constant) or delete
the ruling from all three docblocks and state "last write wins" instead — but not the present
state, where the schema carries a column that exists only to serve a rule nothing enforces.
**Test:** write `csv` then `manual` for one `(account, date)`; assert the csv figure survives.

#### MON-5. Undoing an import leaves the balance snapshots it wrote behind — Severity: Medium — Effort: S

**What:** `commitImport` writes one `source='csv'` snapshot per statement date. `undoImport`
carefully reverses everything a cascade cannot restore — Bayes training, loan balances, bill
`paid_at` — and its own comment enumerates them, but balance snapshots are not in the list, and
there is no delete path for `account_balance_snapshots` anywhere in `src/` (the table's only
writer is `recordBalanceSnapshot`; a grep across `src/` finds no delete against it). Undo
therefore cannot reverse the single most consequential thing an import into the wrong account
does: it leaves that account permanently anchored on a foreign bank's balance, and
`balancesAsOf` will faithfully sum every subsequent transaction forward from it.

**Example:** A member imports the joint chequing statement while the Visa account is selected.
Commit writes `('visa', '2026-08-31', 412755, 'csv')` and 60 transactions. They notice
immediately and click Undo: all 60 transactions are deleted, loan links reversed, rows counted.
The Visa snapshot stays. Settings › Accounts and the net-worth chart now show the Visa card
holding **+$4,127.55** (an asset) instead of the card's real −$1,830.00 debt — a $5,957.55 swing
in net worth that no amount of re-importing the correct file will clear, because the wrong row
is dated 2026-08-31 and re-anchors everything on and after that date (ruling R2).

**Evidence:**
- `src/lib/import/commit.ts:257-259` — the snapshot write inside the commit transaction.
- `src/lib/import/commit.ts:390-435` — `undoImport`; reverses Bayes (`:410-412`), loan links
  (`:417`), installment links (`:421`), deletes transactions and the `imports` row. No snapshot
  handling.
- `src/lib/balance.ts:117-171` — `balancesAsOf` anchors on the newest snapshot at or before the
  date, so a stale row is authoritative forever, not merely stale.

**Fix:** Record which import wrote each snapshot (an `import_id` column, or capture the
`(account_id, date)` set in the `CommitResult`) and delete exactly those rows in `undoImport`,
inside the same transaction and before the transaction delete — the same argument the
loan/installment reversals already make. Short of that, at minimum offer an admin "delete this
snapshot" control on Settings › Accounts so the state is recoverable at all.
**Test:** commit an import that writes a snapshot, undo it, assert no snapshot rows remain for
that account/date.

#### MON-6. `runEngine`'s in-memory eligibility filter silently drops the splits guard — Severity: Low (latent) — Effort: S

**What:** `ELIGIBLE` is the SQL predicate that keeps the categorization engine off split
transactions, and its docblock spells out why in unusually strong terms: "if this row's merchant
later matches a transfer rule, rerunEngine would set `is_transfer = 1` on it, and every
report/budget aggregate excludes transfers, so that one flag would silently erase every one of
its split parts everywhere." `rerunEngine` honours it. But `runEngine(txnIds)` does **not** use
`ELIGIBLE` — it re-derives eligibility in JavaScript as
`rows.filter((row) => row.categoryId === null || row.source === 'bayes')`, reproducing the first
half of the predicate and dropping the `not exists (select 1 from transaction_splits ...)` half
entirely. Splitting deliberately leaves an uncategorized parent's `category_id` NULL
(`splits.ts:187-196`), so such rows satisfy the JS filter.

Today every `runEngine` caller happens to pass ids that cannot have splits — import commit and
SimpleFIN sync pass just-inserted ids, `createManualTransaction` passes a just-inserted id, and
`splits.ts:140` calls it only after deleting the parts inside the same transaction — so this is
latent, not live. It is reported because the guard is documented as living on `ELIGIBLE`, and
the next `runEngine([id])` call site added anywhere inherits the hole with nothing (no test, no
type, no comment at the filter) to catch it.

**Evidence:**
- `src/lib/categorize/engine.ts:102-115` — `ELIGIBLE` and its warning.
- `src/lib/categorize/engine.ts:168` — the JS filter that omits the splits clause.
- `src/lib/categorize/engine.ts:205-217` — `eligibleForRerun`/`rerunEngine`, the only path that
  does apply `ELIGIBLE`.
- Callers: `src/lib/import/flow.ts:95`, `src/lib/simplefin/sync.ts:235`,
  `src/lib/splits.ts:140`, `src/lib/transactions.ts:229`.

**Fix:** Have `selectRowsByIds` carry the splits check (an `ELIGIBLE`-shaped `not exists` in its
WHERE, or a selected `hasSplits` flag) and filter on it, so one predicate serves both paths.
**Test:** split a transaction whose parent `category_id` is NULL, call `runEngine([id])`
directly, assert `is_transfer` and `category_id` are unchanged and `skipped === 1`.

#### MON-7. A bill payment marks the earliest unpaid installment regardless of amount or date — Severity: Low (by design, but the ledger reads as wrong) — Effort: M

**What:** `markEarliestUnpaid` picks `ORDER BY due_date ASC, id ASC` and never compares the
transaction's amount to the installment's. The docblock defends this ("a tax bill arrives with
penalties, discounts and rounding, and refusing to match on a few dollars' difference would
leave the household with an installment that is paid and a reminder that says it is not"), and
the detail page does show the matched transaction so the difference is visible. The cost is that
a single missed mark permanently offsets the whole schedule by one: every subsequent payment is
recorded against the previous period's installment, and the discrepancy compounds silently.
Combined with MON-3 (an un-mark does not stick) there is no user-reachable way to re-align it.

**Example:** Installments 2026-03-15 $800, 2026-06-15 $800, 2026-09-15 $800. March is paid by
cheque and never marked. June's −$800 transaction marks **March** paid (dated 2026-06-14).
September's −$800 marks **June**. The dashboard's Coming-up card then shows the September
installment as still due on 2026-09-15 after it has been paid, and the March row shows a payment
that arrived three months late.

**Evidence:** `src/lib/loans.ts:355-375` (`markEarliestUnpaid`), `src/lib/loans.ts:437-441` (the
bill branch of `applyPaymentMatchers`), `src/lib/warranty/installments.ts:245-277`
(`unpaidInstallments`, the reader the Coming-up card and notifications use).

**Fix:** Prefer the installment whose `due_date` is nearest the transaction's own date within a
window (say ±45 days) before falling back to earliest-unpaid, and surface the fallback in the
match record so the detail page can say "matched to the oldest unpaid installment". Pair with
MON-3's suppression record so a wrong match can be corrected once.
**Test:** three installments, mark none, feed a transaction dated near the second — assert the
second is the one marked.

### Unverified

- **Wrong `signConvention` on a credit-card profile.** A profile set to `negative_is_spend`
  against an Amex-style export (charges positive) inverts every row: charges become
  income-signed and `netSpentCents` reports negative spend, which then inflates rollover carry
  without bound in `effectiveBudget` (`budgets.ts:375-380`). The preview screen does display
  parsed `amountCents` per row (`preview.ts:122-137`), so a person *can* see it — I did not
  verify whether the preview or commit step warns when, say, every row in a credit-account file
  is positive. Worth a targeted look at `import-client.tsx`'s preview table.
- **Un-flagged transfer legs double-count.** `CARD_PAYMENT_PATTERNS` (`engine.ts:25-40`) is an
  English/French literal list. A card payment whose description matches nothing (a bank's own
  reference-number format) lands as two ordinary rows: a large negative on chequing and a large
  positive on the card. If the household categorizes only the chequing leg, budgets overstate
  spend by the payment amount. The review queue is the intended catch; I did not confirm how
  visible that is for the owner's specific Scotiabank descriptions.
- **Scotiabank preset date format.** `Scotiabank Chequing/Debit` ships `MM/DD/YYYY`
  (`presets.ts:89`) with no "fixture-validated" note, unlike TD Chequing and Amex which carry
  one. `detectDateFormat` correctly reports `ambiguous` and `MappingEditor` surfaces it
  (`MappingEditor.tsx:57-73`), so a genuinely ambiguous file asks the user — but I had no real
  Scotiabank export to confirm the shipped default is right. The failure mode is the good one
  (ask, not guess).
- **`transactionsCsv` pagination under concurrent writes.** `page.pageCount` is computed from
  page 1 and reused across the loop (`reports.ts:435-438`); an insert during the export shifts
  offsets. Single-container synchronous better-sqlite3 makes this very narrow, and I did not
  construct a case.
- **Lost updates through auto-save.** Two browsers with stale forms will last-write-wins on the
  same budget row (`budgets/actions.ts:28-61` into `upsertBudget`, no version check). There is
  no *interleaving* risk — better-sqlite3 is synchronous in a single Node process, so the
  select-then-insert in `upsertBudget` cannot be split, and `budgets_scope_user_category_month_uq`
  (an expression unique index, `drizzle/0000_init.sql:171`) blocks a duplicate row — but a stale
  form still overwrites a fresh value. I did not assess how likely that is at this household
  size.

### Done well (max 5 lines)

- **Dates are pure string math end to end** (`src/lib/dates.ts:69-141`) — no `Date` is ever
  constructed for a statement date, so no timezone or DST boundary can shift a day; `todayIso`
  goes through `Intl` with an explicit zone, and `addMonthsClamped` clamps rather than overflows.
- **`parseAmountToCents`** (`money.ts:11-48`) handles `$1,234.56`, `(12.34)`, U+2212, NBSP and
  CAD/USD prefixes and rounds half-away-from-zero with an epsilon nudge — verified against 20
  inputs including `8.165 → 817` and `0.615 → 62`; malformed text fails closed to `null`.
- **Dedup's `occurrenceIndex`** (`dedup.ts:48-58`) is the right answer to two identical coffees:
  it distinguishes them within a file, stays stable across overlapping re-exports, and is backed
  by a real partial unique index rather than app-level checking.
- **Ruling R1 in `src/lib/balance.ts`** — one implementation of the raw `amount_cents` sum, an
  explanation of every filter that must never be added, and a source-grep ops test enforcing it.
- **Backups use `VACUUM INTO`** (`backup/archive.ts:73`), not a file copy, so no WAL-checkpoint
  race exists; restore runs magic-bytes, `quick_check`, required-table and one-way-migration
  checks before touching anything (`scripts/restore-core.ts:219-276`).

## UX / accessibility / resilience lens

Static review only. Paths are repo-relative to the Budget Tracker root. Backlog items A–R
(`docs/PENDING-FIXES.md`) are deliberately excluded — notably L (auto-save success silent to AT),
M (kebab name collisions), I and J — so nothing below repeats a known item.

### Findings (ranked by user impact, max 12)

#### UX-1. No error, 404 or global-error boundary exists anywhere in the app — Severity: High — Effort: S
**What:** When anything fails on the server — SQLite locked while the 02:00 backup runs, the NAS
volume full, a bad row — a family member gets Next's built-in error screen: unstyled black text,
"Application error: a server-side exception has occurred", a digest hash, no navigation, no theme,
no way back. Same for a stale bookmark to a deleted item: `notFound()` renders the framework's
default "404 | This page could not be found" outside the app shell, with no link home.
**Evidence:** `find src/app -name "error.tsx" -o -name "not-found.tsx" -o -name "global-error.tsx"`
returns nothing — the only files matching the boundary conventions are `src/app/layout.tsx`,
`src/app/(app)/layout.tsx`, `src/app/(auth)/layout.tsx`. `notFound()` is nevertheless called from
`src/app/(app)/warranties/[id]/page.tsx:19`, `src/app/(app)/warranties/[id]/page.tsx:21` and
`src/app/(app)/warranties/new/page.tsx:17`.
**Fix:** Add `src/app/(app)/error.tsx` (plain sentence, a "Try again" `reset()` button, a link to
/dashboard), `src/app/(app)/not-found.tsx` (same chrome, "That item is gone" plus a link back), and
`src/app/global-error.tsx` for the root-layout case. Verify by temporarily throwing in
`src/app/(app)/reports/page.tsx` and by visiting `/warranties/999999`.

#### UX-2. Changing a category from the row select silently rewrites household-wide categorization rules — Severity: High — Effort: M
**What:** On Transactions and Review the category cell is now an auto-save select. Picking a
category does not just tag that one row: it creates or overwrites an exact merchant rule that will
apply to every future import for the whole household, and it trains the Bayes classifier. Picking
"Uncategorized" goes the other way — it untrains and *deletes* that merchant's rule. One mis-scroll
over a `<select>` on a phone (the classic mobile mis-tap) can change how everyone's future
statements are filed, and the user is told nothing: the action's own sentence, "Category set and
rule created.", is discarded because `AutoSave` only reads `result.error` and renders a tick.
This is what the spec's safety rule forbids — "auto-save applies ONLY to single-row, reversible
edits" (`docs/superpowers/specs/2026-08-23-row-controls-redesign-design.md:37-44`).
**Evidence:** `src/lib/categorize/engine.ts:321-330` (`upsertRuleFromCorrection` runs whenever
`createRule !== false`) and `src/lib/categorize/engine.ts:332` (`train`); the destructive
counterpart is documented at `src/lib/categorize/engine.ts:337-360`. Callers pass no `createRule`:
`src/app/(app)/transactions/actions.ts:112` and `src/app/(app)/review/actions.ts:45`. The select is
wired at `src/app/(app)/transactions/transactions-client.tsx:507-529` and
`src/app/(app)/review/review-client.tsx:140-152`. The message is dropped at
`src/components/ui/AutoSave.tsx:59-70`.
**Fix:** Two options, both cheap. (a) Pass `createRule: false` from the transactions select (leave
Review alone — that screen is *about* teaching the categorizer) so the row edit is genuinely
single-row and reversible; or (b) surface the consequence: extend `AutoSaveResult` with an optional
`note` and render it under the control for two seconds ("...and future charges from this merchant
will go here"). Either way, make `clearCategory`'s rule-deletion require a deliberate control rather
than a select change. Verify: change one row's category, then confirm `merchant_rules` gained no row
(option a) or that the sentence appears (option b).

#### UX-3. useAutoSave has no catch, so a thrown action fails invisibly and the control keeps the unsaved value — Severity: High — Effort: S
**What:** The hook handles an action that *returns* `{error}`. It does not handle an action that
*throws*. SQLITE_BUSY (the NAS's nightly backup and a member's edit colliding), a full disk, or one
of the several library calls that throw by design all take that path. The result: no error message,
no red text, no revert — the spinner just stops, no tick appears, and the select or checkbox goes on
displaying a value the database never accepted. The person finds out on the next page load, if ever.
**Evidence:** `src/components/ui/AutoSave.tsx:56-70` — `const result = await action(formData);`
inside `startTransition`, with no try/catch, and `onError` reachable only from the `result.error`
branch. Wrapped actions with uncaught throw paths: `src/app/(app)/transactions/actions.ts:112`
(`confirmCategory`, which throws at `src/lib/categorize/engine.ts:284`),
`src/app/(app)/transactions/actions.ts:132` (`bulkSetAttribution`),
`src/app/(app)/budgets/actions.ts:50`, `src/app/(app)/budgets/actions.ts:58` and
`src/app/(app)/budgets/actions.ts:204`. Contrast with
`src/app/(app)/settings/item-types/actions.ts:28-41`, which does this properly.
**Fix:** Wrap the await in try/catch inside `useAutoSave`, set `status: 'error'`, call
`hooks.onError()`, and show a generic sentence ("Could not save — the app may be busy. Try again."),
since Next redacts real messages in production anyway. Verify with the existing
`tests/unit/auto-save.test.tsx` plus one new case whose action rejects.

#### UX-4. Emptying a budget field and tabbing away wipes that limit for every future month — Severity: Medium — Effort: S
**What:** The budget limit is an auto-save text input that commits on blur. A blank value is not
"no change" — it clears the budget from this month forward. Someone who selects the number to retype
it, gets distracted and taps elsewhere has silently deleted a recurring limit. The only feedback is
a tick; the action's own sentence, which is the part that says *how far* the change reached
("Budget cleared from this month forward."), never reaches the screen.
**Evidence:** `src/app/(app)/budgets/actions.ts:49-53` calls `clearBudget`
(`src/lib/budgets.ts:101-103`, an upsert of `amountCents: null`). Control:
`src/app/(app)/budgets/budgets-client.tsx:104-118`, committing on blur at
`src/components/ui/AutoSave.tsx:291`.
**Fix:** Treat an emptied field as a no-op in `AutoSaveTextInput` when the previous value was
non-empty, and move "clear this budget" to an explicit small button in the cell — a single
deliberate action, which is ruling R2's own logic. Verify: clear a limit, reload, confirm the number
is still there; then press the clear button and confirm it is gone.

#### UX-5. Two people editing at once: the loser's screen keeps showing their own value forever — Severity: Medium — Effort: M
**What:** The auto-save controls seed their state from props exactly once and never resync. So when
a parent and a teenager both have Transactions open and both change the same row's category, the
server correctly takes the last write — but the first person's browser goes on displaying *their*
choice indefinitely, with a green tick beside it, until they hard-reload. The same staleness breaks
a single-user flow on Budgets: clicking "Use $487" writes the suggestion server-side, but a limit
input the person has already typed in keeps its old text, and the next blur writes that old number
straight back over the suggestion.
**Evidence:** `src/components/ui/AutoSave.tsx:128` (`useState(defaultValue)`),
`src/components/ui/AutoSave.tsx:181` (`useState(defaultChecked)`),
`src/components/ui/AutoSave.tsx:280` (uncontrolled `defaultValue`) with the `saved`/`sent` refs at
`src/components/ui/AutoSave.tsx:247` and `:251` — no `useEffect` sync and no `key` reset anywhere.
Rows keep stable keys (`src/app/(app)/transactions/transactions-client.tsx:466`,
`src/app/(app)/settings/managers/managers-client.tsx:167`), so the `revalidatePath` refresh never
remounts them. Suggestion write: `src/app/(app)/budgets/actions.ts:119-127`.
**Fix:** Reset the control when the server's value changes — either a `key` at each call site that
includes the server value, or a `useEffect` in the hook that resyncs state and refs when
`defaultValue` changes *and* nothing is pending *and* the field is not focused. Verify with two
browser profiles editing one row.

#### UX-6. Deactivate, Reset MFA, Remove and Unassign fire on a single tap, no confirmation — Severity: Medium — Effort: S
**What:** The kebab collapsed row actions into a stack of ~26px items 4px apart, and four of the
most consequential ones now go through on one tap with nothing in between. Deactivating a household
member locks them out; Reset MFA destroys every one of their sessions; Remove deletes a bill
installment; Unassign moves a loan balance. Import undo, forgetting a bank connection, removing SMTP
settings and deleting a receipt all ask first — these four do not.
**Evidence:** `src/app/(app)/settings/users/users-manager.tsx:108-117`,
`src/app/(app)/settings/accounts/accounts-manager.tsx:282-287`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx:520-525`,
`src/app/(app)/transactions/transactions-client.tsx:574-580`. Existing confirmations for
comparison: `src/app/(app)/import/import-client.tsx:325`,
`src/app/(app)/settings/connections/connections-client.tsx:229`,
`src/app/(app)/settings/notifications/notifications-client.tsx:213`,
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx:691`.
**Fix:** Follow the backups pattern (`src/app/(app)/settings/backups/backups-client.tsx:30-82`) for
the two account-level ones — an inline confirm sub-row naming the person — and a plain `confirm()`
for Remove and Unassign, matching the receipt-delete idiom already in that same file. Verify by
tapping each and confirming a step appears.

#### UX-7. Touch targets throughout the new row controls are ~32px and smaller — Severity: Medium — Effort: S
**What:** On the phones this household mostly uses, the kebab trigger is a 32px square, its menu
items are roughly 26px tall stacked 4px apart, and every auto-save select, checkbox and text input
is a `text-xs` control with 4px of vertical padding. That is well under the 44px minimum, and it is
precisely where the destructive items from UX-6 and the rule-writing select from UX-2 live.
**Evidence:** `src/components/ui/RowMenu.tsx:162` (`h-8 w-8`), `src/components/ui/RowMenu.tsx:47-48`
(the shared item class, `px-2.5 py-1.5 text-xs`), `src/components/ui/AutoSave.tsx:30`
(`AUTO_SAVE_CONTROL = 'field-control w-auto max-w-[11rem] px-2 py-1 text-xs'`).
**Fix:** Give the trigger `h-11 w-11` below the `sm:` breakpoint and the menu items `py-2.5` (the
menu is `position: fixed` at 14rem, so it has the room); bump the auto-save controls to
`py-2 text-sm` under `sm:`. `TableWrap` already scrolls horizontally on a phone, so the extra height
costs nothing. Verify at 390px against the spec's own visual checklist
(`docs/superpowers/specs/2026-08-23-row-controls-redesign-design.md:241-244`).

#### UX-8. Every kebab action drops keyboard focus to the page body — Severity: Medium — Effort: S
**What:** Escape correctly returns focus to the kebab button. Choosing an item does not: the menu
closes, the page re-renders, and focus lands on `document.body`. A keyboard or screen-reader user
who deactivates a member or opens the split editor is dumped at the top of the document with no
announcement of what happened and a long tab back to where they were.
**Evidence:** `src/components/ui/RowMenu.tsx:153` — the context supplies
`close: () => close(false)`, and `refocus` is only ever `true` on the Escape path
(`src/components/ui/RowMenu.tsx:122-126`). All three item components use that context close:
`src/components/ui/RowMenu.tsx:186`, `:198`, `:221`. `RowMenuButton`'s targets partly compensate —
the rename card autofocuses its input, `src/app/(app)/transactions/transactions-client.tsx:228` —
but the `RowMenuForm` path has nothing.
**Fix:** Pass `close: () => close(true)` in the provider so the trigger is refocused on every close
path, and keep focus on the trigger after a `RowMenuForm` submit. The success/error `Notice` banners
already exist and are live regions, so the announcement follows for free. Verify with the existing
`tests/unit/row-menu.test.tsx` plus one case asserting focus after item activation.

#### UX-9. Three money fields open the letter keyboard on a phone — Severity: Medium — Effort: S
**What:** "Add a transaction → Amount", "Contribution amount" and "New goal → Target amount" have no
`inputMode`, so iOS and Android show the full QWERTY keyboard instead of the number pad. These are
exactly the fields a kid logging cash spending or a relative dropping money into a savings goal
touches; every other amount field in the app (row controls, warranty forms) already sets it.
**Evidence:** `src/app/(app)/transactions/transactions-client.tsx:637`,
`src/app/(app)/goals/goals-client.tsx:110`, `src/app/(app)/goals/goals-client.tsx:184`. Compare
`src/app/(app)/budgets/budgets-client.tsx:115` and
`src/app/(app)/warranties/[id]/warranty-detail-client.tsx:545`.
**Fix:** Add `inputMode="decimal"` to all three. Verify on a phone, or by asserting the attribute in
the existing component tests.

#### UX-10. Nothing happens on screen while a slow page loads — Severity: Medium — Effort: M
**What:** There is no `loading.tsx` in the tree and every page is `force-dynamic`. Tapping Reports —
which runs a dozen aggregates plus a tax-year report per request — produces no spinner, no skeleton
and no change of any kind until the whole payload arrives from the NAS. On a slow disk the app looks
frozen and people tap again. The same applies to Transactions with a wide date range.
**Evidence:** the `find` in UX-1 returns no `loading.tsx`; `src/app/(app)/reports/page.tsx:22`
(`force-dynamic`) with the aggregate calls at `src/app/(app)/reports/page.tsx:1-20,61-80`;
`src/app/(app)/transactions/page.tsx:13,59`.
**Fix:** Add `loading.tsx` to `(app)/reports` and `(app)/transactions` — a card-shaped skeleton is
enough — and a pending affordance on the nav links. Related and worth folding into the same pass:
every auto-save calls `revalidatePath` for the whole page
(`src/app/(app)/transactions/actions.ts:115-116`), so re-categorizing ten rows re-renders all 50
rows plus their splits and loan links ten times; narrowing those revalidations is the cheap win.
Verify by throttling and watching for the skeleton.

#### UX-11. Installed on an iPhone home screen, the app runs under the notch and the home indicator — Severity: Low — Effort: S
**What:** The manifest declares `display: standalone` and the root layout sets `appleWebApp`, so
adding the app to an iPhone home screen launches it chromeless. Nothing in the stylesheet accounts
for the safe area, so the sticky header sits under the status bar and the footer under the home
indicator — the two pieces of chrome a phone-first household touches most.
**Evidence:** `src/app/manifest.ts:24` (`display: 'standalone'`), `src/app/layout.tsx:14-17`
(`appleWebApp`), header and footer at `src/components/app-shell/AppShell.tsx:108` and
`src/components/app-shell/AppShell.tsx:166`. `grep -rn "safe-area\|env(safe" src/` returns nothing.
**Fix:** Add `viewportFit: 'cover'` to the `Viewport` export in `src/app/layout.tsx:24-29` and
`env(safe-area-inset-top)` / `env(safe-area-inset-bottom)` padding to the header and footer, plus
left/right insets on `main`. Verify on an installed iOS home-screen shortcut.

#### UX-12. Shutdown kills in-flight writes; a migration failure is a silent crash loop — Severity: Low — Effort: M
**What:** Two operability edges for the owner's "pull a new image tag" update flow. First, the
SIGTERM handler exits the process immediately without closing the HTTP server or the SQLite handle,
so whoever was mid-save when the container stopped just loses the request and WAL is never
checkpointed. Second, if `openDatabase()` throws at boot — a broken migration, an orphaned row after
an upgrade — `register()` fails, the container restarts, the healthcheck keeps failing, and the only
record of *why* is a line in `docker logs` the owner has to know to go read.
**Evidence:** `src/instrumentation-node.ts:95-106` — `process.exit(0)` with no `closeDb()` and no
server drain; `closeDb` exists at `src/db/client.ts:105-108` and is never called here.
`src/db/client.ts:65-81` throws out of `openDatabase`, reached from `src/instrumentation-node.ts:39`.
The healthcheck itself is sound (`Dockerfile:124-125`).
**Fix:** In the signal handler, call `closeDb()` after the OCR marker and before exiting, and give
in-flight requests a short grace period with a hard 10s timeout. For the boot failure, catch around
`getDb()` in `src/instrumentation-node.ts`, log a framed multi-line message naming the migration and
the rescue command (`scripts/restore-backup.ts`), then exit — so the log is unmissable rather than a
bare stack trace. Verify with `docker compose stop` during a save, and by pointing
`BUDGET_MIGRATIONS_DIR` at a deliberately broken migration.

### Unverified

- **How React 19 disposes of a rejected async transition** (UX-3). I did not run it, so I cannot say
  whether the rejection reaches an error boundary, the window `unhandledrejection` handler, or is
  swallowed. What *is* certain from the code is that `useAutoSave` never reacts to it: no status, no
  message, no revert. The fix is the same either way.
- **Whether a changed `defaultValue` visibly updates the budget limit input** (UX-5). Per the HTML
  spec a non-dirty input follows the value attribute, so the "Use $X" regression is certain only
  once the person has typed in that field. The select and checkbox staleness needs no such caveat —
  those are local state with no sync path at all.
- **Contrast ratios.** `--subtle` is `#6e6e88` on `#ffffff` (light) and `#868ba6` on `#171826`
  (dark) — `src/app/globals.css:40` and `:106` — used for footer text, table meta and
  `badge--muted`. Both sit near the 4.5:1 line at the `text-xs` sizes they carry, but I did not
  compute them.
- **Rendered widths and horizontal scroll at 390px.** No browser was run, per the review's
  constraints. The colgroup arithmetic in `TableWrap` and the spec's own 390/768/1280/1900 checklist
  (`docs/superpowers/specs/2026-08-23-row-controls-redesign-design.md:241-244`) are the only
  evidence I have; whether the transactions table's 68rem still scrolls acceptably on a phone is a
  visual question.
- **Scroll position after `revalidatePath`.** Nothing in the code pushes a route or calls
  `scrollTo` after an auto-save, and the filter state lives in the URL rather than component state,
  so neither should reset — but I did not confirm it in a browser.
- **Image optimisation.** The app ships only the generated PWA icon set and user-uploaded receipts;
  I found no `next/image` usage to audit and did not look at how receipt files are served.
- **N+1 queries in server components.** Transactions, Reports and the dashboard all batch
  (`loanLinksForTransactions`, `splitsForTransactions`, one `suggestionsFor` call). I did not trace
  every dashboard card, and `docs/PENDING-FIXES.md` item 5a already records a known N+1 in
  reconciliation.

### Done well (max 5 lines)

- **Backup restore is the model the destructive actions in UX-6 should copy**: an inline confirm panel that replaces the row, an explicit acknowledgement checkbox, a named safety copy, a staged restart rather than an in-place write, and the refusal rendered where the admin is looking rather than in a banner a stale message could mask (`src/app/(app)/settings/backups/backups-client.tsx:30-82,154-160`).
- **The shell's accessibility fundamentals are all present and deliberate**: skip link, `<html lang="en">`, `aria-current="page"`, both navs labelled, Escape and outside-tap on both menus with focus returned to the opener, and a body-scroll lock while the phone menu is open (`src/components/app-shell/AppShell.tsx:86-91,102,144,62-81,51-58`).
- **Every date and amount goes through one helper with an explicit locale** (`src/lib/dates.ts:258-288`, `src/lib/money.ts:1`) and "today" is always resolved server-side in the configured TZ and passed down (`src/app/(app)/reports/page.tsx:36-38`) — no ad-hoc `toLocaleString`, so no hydration mismatch anywhere.
- **`SubmitButton` gives every server-action form double-submit protection for free** via `useFormStatus` (`src/components/SubmitButton.tsx:30-34`), and `Notice` is a real live region with `alert` for errors and `status` for success (`src/components/ui/Notice.tsx:36`).
- **The container is well-behaved**: non-root `USER node`, `NODE_ENV=production`, a real healthcheck against `/api/health`, a read-only-rootfs note, and WAL plus `busy_timeout=5000` set in the single place a SQLite connection is ever opened (`Dockerfile:52-57,118-125`, `src/db/client.ts:51-56`).

## Product lens

Reviewed read-only on 2026-08-27 against `feature-map.md`, `docs/PENDING-FIXES.md`, the twelve
design specs, `src/app/(app)/help/content.tsx`, and the page components. Backlog items A–R from
feature-map §9 are not repeated here.

### How the household model actually works today (from code, path:line)

There is exactly **one** concept, not three. There is no `households` table anywhere in
`src/db/schema.ts`. "Household" is not an entity — it is the word the app uses for *the whole
database*. Everyone who can sign in is in it, and the help page says so plainly:
"**Household** — everyone who can sign in here" (`src/app/(app)/help/content.tsx:574-576`).

- **Login user = person.** `users` (`src/db/schema.ts:19`) carries `role` with exactly two values,
  `admin` and `member`. Every "person" picker in the app is just the user list:
  `src/app/(app)/transactions/page.tsx:69` and `src/app/(app)/budgets/page.tsx:72` both call
  `listUsers()`. So a person the household wants to track spending for **must** be issued a
  password and a login. There is no attribution-only person.
- **Attribution is a label, not a boundary.** `transactions.attributedUserId` is set at import
  from the card column or the account owner, and it filters a query **only when the caller asks
  it to**: `src/lib/transactions.ts:113-125` adds the clause only if the filter carries one, and
  the filter comes from the `?person=` URL parameter, which any signed-in user can set to any
  value. `getTransaction(id)` (`src/lib/transactions.ts:166-168`) has no owner clause at all.
- **The other "owner" columns are the same.** `listAccounts`/`getAccount`
  (`src/lib/accounts.ts:33-43`), `listGoals`/`getGoal` (`src/lib/goals.ts:217-228`) and
  `listLoans` (`src/lib/loans.ts:867`) carry no owner filter in any code path. Goal
  *contributions* — who put in how much, and when — are listed unfiltered for every goal
  (`src/lib/goals.ts:173-190`).
- **Budgets are the one real exception**, and only on the write side. `scopeCondition`
  (`src/lib/budgets.ts:41-45`) is a genuine SQL predicate, but
  `src/app/(app)/budgets/page.tsx:72-81` then deliberately loops over **every active member** and
  renders each one's personal budget on the same page.
- **Direct-URL reach.** `src/app/(app)/warranties/[id]/page.tsx:16-22` calls `requireUser()` and
  then `getWarrantyItem(Number(raw))` with no comparison against the signed-in user. Any member
  can read any other member's warranty, subscription, contract, **loan balance and interest
  rate**, or property-tax bill by incrementing the number in the URL.
- **Roles gate actions only.** `requireAdmin()` (`src/lib/auth/session.ts:185-189`) protects
  Accounts, Users, Categories, Rules, Backups, Item types, SimpleFIN and the pack routes. It
  protects no read.

This is not an accident: base spec §6 says "Family-trust model — the household sees everything by
design," and the warranty spec §1.3 repeats it. **The model is internally coherent for the
population it was drawn for — two adults.** It stops being coherent the moment kids and friends
have logins, because the design ruling assumed a trust boundary that those users sit outside of.

**Friends on the same instance get one shared pot, with no way to separate them.** Categories,
merchant rules, the Bayes classifier, import profiles, item types, SMTP config and the settings
table have no per-user column at all (`src/db/schema.ts`), so even a filtered read model could not
separate two households' *reference* data. Separation is a container-level problem here, not a
query-level one.

---

### Findings (ranked by value to this family, max 12)

#### PROD-1. Kids and friends see the household's whole financial life — Value: High — Effort: M

**Gap:** A friend, an in-law or a fourteen-year-old with a login can open `/transactions` and read
every purchase the owner and their partner ever made, `/goals` and see exactly what each person
has contributed to each goal, `/reports` and see the household's income and savings rate, and
`/dashboard` and see net worth. Switching the person pill to someone else is not a restriction —
it is a *feature* available to everyone. Nothing in the app hides anything from anyone.

**Evidence:** `src/lib/transactions.ts:113-125` (person clause applied only when the caller passes
one, and the caller is the URL); `src/lib/accounts.ts:33-43`; `src/lib/goals.ts:173-190, 217-228`;
`src/lib/loans.ts:867`; `src/app/(app)/budgets/page.tsx:72-81`;
`src/app/(app)/warranties/[id]/page.tsx:16-22` (any item id resolves for any caller).
`requireAdmin()` (`src/lib/auth/session.ts:185-189`) appears on no read path.

**Recommendation:** Two moves, in this order, and neither is multi-tenancy.

1. **Friends get their own container.** This is a self-hosted app with a one-file database and a
   `/data` volume. A second container on the same NAS with its own `/data` is a compose-file
   change and zero code, and it is the only thing that actually separates two households, because
   categories, rules and the classifier are household-global with no user column. Document it in
   INSTALL.md as "one household per instance". Actual Budget takes exactly this line (one budget
   file, no user model); YNAB and Monarch solve it by giving each household its own tenant. Do
   *not* build tenancy into this schema — it would touch every table and every query.
2. **Kids get a `self` scope flag.** Add one column, `users.visibility` (`'household' | 'self'`,
   default `'household'`). When it is `'self'`: derive the person filter from the session instead
   of the URL on `/transactions`, `/reports` and `/dashboard`; add an owner clause to `listGoals`
   and `searchWarrantyItems`; render only that member's own row in the personal-budgets loop; and
   add the missing ownership check on `/warranties/[id]`. That is roughly six list helpers and one
   detail page — it is not a redesign, and it leaves the adults' experience byte-identical.

The `/warranties/[id]` check is worth doing on its own regardless of the rest — it is a one-line
comparison and today it is the only screen where the *list* offers an owner filter while the
*detail page* ignores ownership entirely.

#### PROD-2. The app already computes real insights and then never shows them on screen — Value: High — Effort: S

**Gap:** Unusual-charge detection, duplicate-charge detection and subscription price-creep are all
implemented and tested — and they are reachable **only** as a Telegram or email notification. A
household member who has not set up a channel (which is every member until they do) will never
learn that Netflix went up, that the same restaurant charged twice, or that a merchant billed four
times its usual amount. For a household that is deliberately not using bank sync, these are
precisely the things a human eye misses in a CSV.

**Evidence:** `src/lib/predict/anomalies.ts` exports `unusualVerdict`, `creepVerdict`,
`findDuplicates`, `hasEnoughHouseholdHistory`. A repo-wide search for importers of
`predict/anomalies` returns exactly one file: `src/lib/notify/evaluate/anomalies.ts:10`. No page
or component under `src/app/` imports it.

**Recommendation:** A self-hiding "Needs a look" card on the dashboard — the same pattern
`LoansCard` and `ComingUpCard` already use — listing this month's unusual charges, duplicate
pairs and crept subscriptions, each row linking to the transaction. The maths is done; this is a
read-only card over functions that already exist and already have tests. Best value per hour in
this whole review. Lunch Money and Monarch both lead with exactly this surface.

#### PROD-3. Nothing turns a bill that is due into a transaction — Value: High — Effort: M

**Gap:** The app knows rent, the property-tax installment and the insurance renewal are coming
(`upcomingBills`, `bill_installments`), and it will remind someone. But when the money actually
moves, the household still has to either wait for the statement or retype it by hand — and for
rent paid by e-transfer or anything on the cash account, the statement will never bring it. There
are no recurring or scheduled transactions of any kind: a search for `recurring|scheduled
transaction|auto-create` across `src/` returns only bill-cadence and normalizer hits.

**Evidence:** absent — searched `src/**/*.{ts,tsx}` for recurring/scheduled-transaction creation;
`src/lib/bills.ts:81-146` produces *reminders* only; `bill_installments` is marked paid either by
hand or by a matched imported transaction (`markEarliestUnpaid`, `src/lib/loans.ts:355-375`).

**Recommendation:** Do not build a scheduler. Build the smallest bridge: on the Coming-up card and
on the bill's detail page, a **"Record this payment"** button that opens the manual-entry form
pre-filled with the bill's amount, date, description and category, and on save marks the
installment paid and links the transaction (`bill_installments.paidTxnId` already exists for
exactly this). That covers rent, the property-tax installment and every regular cash payment with
no new table, no new job, and no risk of the app inventing transactions the bank never made — which
is the failure mode a real scheduler has and the reason to avoid one here. YNAB's scheduled
transactions land as "approve this" rows for the same reason.

#### PROD-4. Adding a cash transaction is a long scroll to a seven-field form — Value: High — Effort: S

**Gap:** With no bank sync, hand entry is the main loop for cash, e-transfers and anything between
statements. Today the only way in is `/transactions`, scroll past the filter bar, the bulk toolbar
and fifty table rows, to a form at the very bottom of the page
(`src/app/(app)/transactions/transactions-client.tsx:617-666`) with date, account, description,
amount, direction, category and person. On a phone that is a lot of thumb. Nothing remembers the
last account or category. The PWA manifest is installable but declares no `shortcuts`
(`src/app/manifest.ts:19-38`), so the home-screen icon lands on the dashboard, and there is no
service worker, so a coffee bought where there is no wifi cannot be entered at all.

**Evidence:** `src/app/(app)/transactions/transactions-client.tsx:617-666` (form position and
fields); `src/app/manifest.ts` (no `shortcuts`, and its own docblock records "no service worker,
no offline caching" as ruling 9); `src/components/app-shell/nav.ts` (no add affordance in the
nav).

**Recommendation:** Three small things, any one of which helps: (a) a manifest `shortcuts` entry
"Add a transaction" pointing at `/transactions#add` so the home-screen icon long-press goes
straight there; (b) an "Add" button in the page header that scrolls to and focuses the form;
(c) default the account and category selects to whatever that user picked last time. Leave the
offline question alone — ruling 9 is defensible and a sync-conflict model is not worth it for a
$4 coffee.

#### PROD-5. Four bank presets, CSV only, and no OFX/QFX — Value: High — Effort: M

**Gap:** The built-ins are TD Chequing, TD Visa, Scotiabank Chequing and Amex Canada
(`src/lib/import/presets.ts:29,63,87,109`). RBC — the largest bank in the country — BMO, CIBC,
Tangerine, Simplii, EQ and Desjardins all have none. The wizard can build a profile for any of
them and profile packs can be shared, so this is friction rather than a wall, but every friend or
in-law joining the instance pays that friction on day one. Separately, the app accepts only
`.csv` (`transactions-client`'s upload is `accept=".csv,text/csv"`,
`src/app/(app)/import/import-client.tsx:508`) and one file at a time, and PDF statements are
explicitly declined in the help text.

**Evidence:** `src/lib/import/presets.ts:7-142` (four `BUILTIN_PRESETS`); repo-wide search for
`ofx|qfx|qif` across `src/` and `docs/` returns **nothing**.

**Recommendation:** Two independent pieces.
- **Cheap:** add RBC, BMO, CIBC and Tangerine preset objects. Each is a `ImportMapping` literal in
  the same file, validated the same way the existing four were (against one real scrubbed export).
  A day's work at most, and it makes the app usable by the extended family without a wizard
  session.
- **Higher value:** an OFX/QFX reader. Most Canadian banks still publish "download for Quicken",
  and OFX carries a bank-assigned `FITID` — a stable per-transaction id. That would make dedup
  across overlapping statement periods **exact** instead of hash-heuristic, and the machinery is
  already in the database: `transactions.externalId` and the partial unique index
  `transactions_external_id_uq` on `(account_id, external_id)` (`src/db/schema.ts:175,184-186`)
  exist for SimpleFIN and would take OFX rows with **no migration at all**. OFX also carries the
  account type and sign convention, so a credit-card file stops needing a sign-convention
  decision. Firefly III and Actual both treat OFX as the more reliable path for this reason.
- Leave PDF alone. The help page's explanation of why a PDF will not work is honest and correct.

#### PROD-6. Notes are promised, unreachable, and unsearchable; search itself is thin — Value: Medium — Effort: S

**Gap:** The help page tells the household that a transaction's "category, the person it is
attributed to, **a note**, a friendlier display name" are all editable
(`src/app/(app)/help/content.tsx:161-168`). There is no note UI. The column exists, the server
action exists, and **nothing calls it** — `saveNoteAction` has exactly one occurrence in the whole
repo, its own definition. Manual entry hard-codes `notes: null`. Notes are exported to CSV
(`src/lib/reports.ts:459`), always empty. Meanwhile the transaction search is `LIKE` over
description and merchant only — not notes, not amount — while the warranty side already has a
proper FTS5 index that even covers OCR'd receipt text.

**Evidence:** `src/app/(app)/transactions/actions.ts:169-190` (`saveNoteAction`, no call sites);
`src/app/(app)/transactions/actions.ts:79` (`notes: null` on every manual entry);
`src/app/(app)/transactions/transactions-client.tsx:553-593` (row menu offers Rename, Split,
Create warranty, Assign/Unassign loan — no note); `src/lib/transactions.ts:126-137` (search
covers `rawDescription`, `normalizedMerchant`, `displayDescription`); contrast
`drizzle/0002_warranty_tracker.sql:76-84` (`warranty_search` FTS5 over name, vendor, model,
notes **and** `ocr_text`).

**Recommendation:** Add "Note…" to the row menu wired to the action that already exists, add a
note field to manual entry, and include notes in the search `OR`. That is an afternoon and it
makes the help page true. A note is also the cheapest answer to "why was this $340 charge okay" —
the question a household actually asks three months later. If receipts on ordinary transactions
ever matter (a tax-relevant expense, say), note that today the only path is to create a warranty
item for the purchase from the row menu, which works but is a strange thing to ask someone to do.

#### PROD-7. Kids have no lane of their own — Value: Medium — Effort: M

**Gap:** Nothing in the app is built for a child. There is no allowance, no chore money, no
view-only role, and no "what's mine" home screen. A search for `allowance|chore|kid` across `src/`
returns no feature code (only a seeded *category* named Kids, and unrelated uses of "anchored").
A per-child savings goal does work — `goals.ownerUserId` supports it — but every other child can
see it, and so can every friend (PROD-1).

**Evidence:** absent — searched `src/**/*.{ts,tsx}` for allowance/chore/kid features;
`src/db/schema.ts:19` (roles are `admin` and `member`, there is no third role);
`src/lib/goals.ts:217-228` (goals list unfiltered).

**Recommendation:** Do not build an allowance subsystem. The honest primitives are already here:
a per-child **cash account** (`getOrCreateCashAccount` already creates one on demand), a **goal**
owned by that child, and manual entries for allowance in and spending out. What is missing is
only the *view*: with PROD-1's `visibility: 'self'` flag, a child signing in would land on a dashboard
scoped to themselves — their cash balance, their goal, their spending — which is exactly the
"what's mine" screen. That makes PROD-1 pay for itself twice. Revisit chore tracking only if the
family actually asks; it is a to-do app, not a budget feature, and most tools that bolt it on end
up with a dead screen.

#### PROD-8. A person can only exist if you give them a password — Value: Medium — Effort: S

**Gap:** Attribution pickers are built from `listUsers()`
(`src/app/(app)/transactions/page.tsx:69`, `src/app/(app)/budgets/page.tsx:72`), so tracking what
was spent on or by someone — a young child, a parent living with the household, a housemate who
does not want an account — requires creating a login for them, setting a temporary password, and
carrying `mustChangePassword` on an account nobody will ever sign into. Conversely, every login
you create for a real person immediately gets full read of everything (PROD-1).

**Evidence:** `src/app/(app)/transactions/page.tsx:69`; `src/app/(app)/budgets/page.tsx:72`;
`src/lib/auth/users.ts` has no notion of a non-login person; `src/db/schema.ts:19,22` (only `role`
and `isActive`).

**Recommendation:** Allow a user row with logins disabled — either a `canSignIn` boolean or, more
cheaply, treat `isActive = false` users as still selectable for attribution while
`attemptLogin` continues to refuse them (check the current behaviour of the active filters on the
people pickers first — `budgets/page.tsx:72` filters to active, `transactions/page.tsx:69` does
not, which is itself an inconsistency worth resolving either way). This separates "a person the
money belongs to" from "someone who can sign in", which is the distinction the household actually
has.

#### PROD-9. Net worth cannot hold a savings account, a TFSA, an RRSP or a house — Value: Medium — Effort: M

**Gap:** An account can only be `chequing`, `credit` or `cash` (`src/db/schema.ts:85`). So the net
worth figure on the dashboard and in Reports is chequing plus cash, minus credit cards, minus
tracked loans. For a Canadian household the two largest numbers on the balance sheet — the
registered accounts (TFSA/RRSP/RESP) and the house against the mortgage — cannot be entered at
all, which makes the "net worth" label optimistic in the unhelpful direction. The machinery to
support them already exists: `account_balance_snapshots` accepts a `manual` source, and the
Accounts page already lets an admin type a balance.

**Evidence:** `src/db/schema.ts:85` (`type` enum, three values);
`src/lib/networth.ts:217-250` (`netWorthOverTime` = `balancesAsOf` over `listAccounts()` minus
`debtOverTime`); ruling 6 in `src/lib/networth.ts:24-33` (signs are taken as given, which is
exactly what an asset account needs).

**Recommendation:** Add two account types — `savings` and `asset` — with `asset` accounts excluded
from import and from spend reporting, carrying only a manually-typed balance you update once a
quarter. That is an enum widen, a migration, and a filter on the import account picker. It turns
the net-worth chart from "what's in the chequing account" into something worth watching for a
household with a mortgage. Mortgages themselves already work as a `loan` item, so the liability
side is covered.

#### PROD-10. "You haven't imported in a while" cannot tell which account is behind — Value: Medium — Effort: S

**Gap:** The owner asked for exactly this. Today the stale-import alert looks at the single most
recent import **across the whole household** — so importing TD on the 3rd silences the alert for
the Amex nobody has touched since February. With five accounts on manual CSV, this is the alert
that matters most and it is the one most easily fooled.

**Evidence:** `src/lib/notify/evaluate/stale.ts:24-30` — one `select ... from imports order by
created_at desc limit 1`, with no `accountId` grouping and no per-account key. The dedup key is
`staleImportKey(mondayOfIsoWeek(today))` (line 46), keyed on the week only, so a per-account
message could not currently be distinguished anyway.

**Recommendation:** Group the query by `accountId` over active, CSV-managed accounts, compare each
account's newest import against the user's `staleImportWeeks`, and extend the dedup key to carry
the account id so each lagging account nags at most once a week. No migration — `notification_prefs`
keys on the event id string, which does not change. This also composes with PENDING-FIXES item 3
(the balance-pipeline alert the owner declined), which is a *different* signal and stays declined.

#### PROD-11. An irregular annual bill has nowhere to accumulate — Value: Medium — Effort: M

**Gap:** Property tax, insurance renewals and the annual subscriptions are all knowable months in
advance, and the app knows their dates. But budgets and bills are two separate systems that never
meet: `safeToSpend` deliberately reports `budgetedRemainingCents`, `projectedSpendCents` and
`billsDueCents` as three numbers side by side rather than one, and a budget row has no idea an
installment is coming. So the month the $1,800 tax bill lands, the budget simply blows.

**Evidence:** `src/lib/bills.ts:164-185` (three separate figures, never combined);
`src/lib/budgets.ts:424-480` (budget rows are per-category caps with no bill input);
`src/lib/budgets.ts:352-383` (`effectiveBudget`'s rollover carry — the closest thing to a sinking
fund that exists).

**Recommendation:** The rollover mechanism is already 80% of an envelope: set a $150/month limit
on Property Tax with rollover on, and the carry accumulates and is displayed
(`budgets-client.tsx:119-122`). What is missing is the *connection*: when a category has a bill
installment due, show the required monthly set-aside beside the limit ("$1,800 due 30 Jun — set
aside $150/month, $900 carried so far"). That is a read-side join between `bill_installments` and
the budget row, no new storage. It is also the smallest step toward the zero-based/envelope
question without adopting envelope budgeting wholesale — which, given the household is happy with
category caps, would be a large change for a method they have not asked for.

#### PROD-12. A friend who leaves cannot take their data or have it removed — Value: Medium — Effort: M

**Gap:** Two related holes. First, export: the only complete export is the admin's whole-database
`.tar.gz` (`src/app/api/backup/download/route.ts`), which is everyone's data in a format only this
app reads; the CSV exports cover transactions and the tax year only, so budgets, goals, item and
loan history, and balances have no export at all. Second, deletion: users are deactivate-only
(`src/lib/auth/users.ts:185`, "Deactivate, never delete — attribution history must survive"), and
`settings/users/actions.ts` exposes create, activate/deactivate, reset password and reset MFA —
there is no delete, and no way to remove or hand over one person's transactions, goals and
warranty items.

**Evidence:** `src/app/api/backup/download/route.ts:26-45`; `src/app/api/reports/export/route.ts`
and `tax-export/route.ts` (transactions and tax year only);
`src/app/(app)/settings/users/actions.ts` (four exported actions, no delete);
`src/lib/auth/users.ts:185`.

**Recommendation:** Two modest pieces. (a) A "download everything" JSON export — one file, one
object per table, admin-only, reusing the query helpers that already exist. It is the honest
answer to "it's my data" and it is also the only current way to check the app is not losing
something. (b) A per-user offboarding action: export that user's rows, then either reassign their
attribution to Household or delete their owned rows, then deactivate. Note that PROD-1's
container-per-household recommendation removes most of the urgency here — if the friend was never
in this database, there is nothing to remove.

---

### Disagreements with prior rulings

**The "family-trust model — the household sees everything by design" ruling
(`docs/superpowers/specs/2026-08-15-budget-tracker-design.md:243`, restated in the warranty spec
§1.3 and its deferred item 5).** I do not think the ruling was wrong; I think its premise expired.
It was written for a two-adult household where "everyone sees everything" is not a leak, it is a
convenience — and for that population it is still the right call, and the code implements it
cleanly and consistently. But the population described for this review is family **plus kids plus
friends and extended family, each with their own login**, and the ruling contains no boundary for
people outside the trust circle because there were none when it was made. The right response is
not to abandon the ruling — it is to keep it as the default (`visibility: 'household'`) and add
the narrow opt-out for the users it was never meant to cover, plus a separate instance for anyone
who is not in the household at all. See PROD-1.

**Warranty spec deferred item 5, "per-person private visibility ... would be the app's first
private-data surface and needs its own design."** Agreed that it needs a design. But the missing
ownership check on `/warranties/[id]` (`src/app/(app)/warranties/[id]/page.tsx:16-22`) is a
different thing from private visibility: the list view already offers an owner filter, so the app
already presents ownership as if it meant something on that screen while the detail page ignores
it. That inconsistency is worth closing whether or not private visibility is ever built.

### Done well

- **Import correctness is genuinely good** — versioned dedup hashing with an occurrence index,
  `transaction_imports` so overlapping statement re-imports stay safe, and an undo that reverses
  classifier training, loan balances and installment marks rather than just deleting rows.
- **The help page is better than most commercial products'** — it explains the *rhythm* and the
  order of operations, not just the buttons, and it never assumes prior knowledge.
- **Warranty search is a proper FTS5 index over name, vendor, model, notes and OCR'd receipt
  text** — a pattern the transactions side should copy (PROD-6).
- **Reports are deep for a self-hosted app** — category breakdown, cashflow with savings rate,
  month-over-month, this-month-against-last-year, per-person split, top merchants, net worth,
  category baselines, and a Canadian tax-year report driven by `taxRelevant` categories.
- **Notifications are unusually well built** — seventeen events, per-user thresholds, an outbox
  with unique-key dedup and exponential backoff, and credentials encrypted under per-purpose
  derived keys.
