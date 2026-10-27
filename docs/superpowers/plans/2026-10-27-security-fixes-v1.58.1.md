# Security checks and hardening — Implementation Plan (v1.58.1)

**Goal:** Add the missing authorization and isolation checks for self-scoped members, tighten sign-in,
second-factor and restore handling, and harden the install for a deployment that may face the internet.
Each fix is a check the code now performs; every one lands with a test that fails on v1.58.0.

**Base:** v1.58.0 (`fad8fdf`). Work on `main`, no branches or worktrees.

**Process:** one fresh implementer per lane (four lanes, run in parallel; file sets are disjoint except
the docs noted below). Implementers run only the tests they touch plus `tests/ops`, and do not commit;
the orchestrator commits each lane by file name. Then ONE Opus review over the whole range, one fix
round, then the release gate once.

## Global constraints

- PUBLIC repo: no owner name, employer, Windows paths, account names or real figures. Invent every
  fixture value (people `Alex` / `Sam`, merchants like `MAPLE GROCER`, `FUEL STOP 12`). No quotes of
  anyone in comments. No exploit narrative in comments, commits or docs: describe the check.
- Reuse the app's helpers: `getWarrantyItem(id, viewer)`, `canActOnOwner`, `isSelfScoped`,
  `ownerScope`, `listAccounts({}, viewer)`, `acceptsTransactions`, `RULES_ARE_HOUSEHOLD_WIDE`,
  `NOT_YOURS_ERROR`. Mirror sibling actions' guards, messages and `ActionState` shapes.
- `'use server'` files export only async functions; every action's first statement is its origin
  check (`tests/ops/use-server-exports`, `tests/ops/server-action-origin`).
- Tests use explicit dates, never today. Vitest 4 + Testing Library, no jest-dom.
- Never `git stash`, `git checkout -- <file>` or `git restore` (CRLF rewrite breaks ops guards).

## Lane A — authorization for self-scoped members (items 1-6)

1. **Assign a transaction to a bill** (`transactions/actions.ts` `assignToBillAction`, `loans.ts`
   `assignTransactionToBill`): resolve the item through `getWarrantyItem(itemId, user)` before
   linking; an item the viewer cannot see answers `That item no longer exists.`; refusal text never
   carries an item name the viewer cannot see. Test: a self member posting another member's bill id
   is refused and the installment stays unpaid.
2. **Withdraw a loan statement** (`warranties/actions.ts` `retractLoanAnchorAction`, `loans.ts`
   `retractLoanAnchor`): the anchor lookup also matches the item id that passed the viewer gate; a
   mismatch returns false. Test: own item id plus another loan's anchor id changes nothing.
3. **Payment matcher rules**: when the rule's item owner is self-scoped, `loanRuleReach`,
   `backfillLoanRule` and `applyPaymentMatchers` (import, SimpleFIN sync, categorize and manual-entry
   callers alike) consider only transactions attributed to that owner. `saveLoanRuleAction` checks
   `rule.accountId` against `listAccounts({}, user)` for a self-scoped viewer. Household and admin
   owners keep household-wide matching. Tests: reach count, backfill and import-time matching ignore
   another member's matching rows; an account outside the viewer's list is refused.
4. **Record a loan payment** (`recordLoanPaymentAction`): validate the account through the viewer
   (`listAccounts({}, user)` for self-scoped) and `acceptsTransactions` before
   `createManualTransaction`, with `manualEntryAction`'s messages. Test: refused, no row inserted.
5. **Edit an item**: changing `ownerUserId` requires `canActOnOwner(existing.ownerUserId, user)`;
   otherwise `NOT_YOURS_ERROR` and nothing is written. Test: a non-owner member cannot reassign.
6. **Rename with scope "all"**: refused for self-scoped viewers with `RULES_ARE_HOUSEHOLD_WIDE`, as
   the sibling rule actions do. Test: refused, no rule written, no other row renamed.

## Lane B — household figures, bank sync, release workflow, tessdata (items 7, 8, 14, 15, 16)

7. **Price-rise alert** (`notify/evaluate`): the personal pass skips self-scoped recipients, matching
   the existing admin-only ruling for the unusual-charge alerts; the family-channel pass is unchanged.
8. **Needs-review count**: self-scoped viewers get 0 on the dashboard, the transactions page props and
   the personal weekly digest, as `layout.tsx` already does.
14. **SimpleFIN fetches**: a named timeout constant via `AbortSignal.timeout`, `redirect: 'error'`, and
   a streamed response byte cap that stops reading past it; each failure has a plain message. Tests
   with a mocked `fetch`.
15. **Release workflow**: a manual dispatch publishes only from `refs/heads/main` or a `refs/tags/v*`
    ref (the guard job fails with a clear message otherwise); tag pushes stay as they are. Every
    third-party action in `.github/workflows` is pinned by full commit SHA with its version in a
    comment. The release guard, test gate and GitHub-release step keep working.
16. **Tessdata checksum**: `check-ocr-assets.mjs` verifies `vendor/tessdata/eng.traineddata.gz`
    against `TESSDATA_SHA256` (the Dockerfile already runs it, so a mismatch fails the image build);
    `fetch-tessdata.mjs` fetches from a pinned upstream commit and reports a mismatch against the
    constant with a non-zero exit.

## Lane C — sign-in, second factor, restore (items 9, 10, 11)

9. **Sign-in lockout.** Decision:
   - The per-address layer applies only to a real address. Next 16 fills `x-forwarded-for` from the
     socket only when the client sent none, so a server action has no trustworthy direct address;
     the only trustworthy source stays `X-Forwarded-For` / `X-Real-IP` with `TRUST_PROXY=1`
     (`clientIpFromHeaders`). `'unknown'` never gets a per-address bucket.
   - The per-username layer stays (10 failures in 15 minutes, then 15 minutes doubling to 24 hours).
     A pure delay cannot both keep that rate limit and let the owner in while someone else keeps
     guessing, so the layer stays a backoff for unrecognised browsers, and a browser that has
     completed a sign-in for that username carries a signed known-device cookie (HMAC from a key
     derived from the secret key, up to five entries) that exempts it from the per-username and
     per-address layers and gives it its own bucket with the same thresholds. A known-device cookie
     never signs anyone in; it only selects the bucket. New nullable `login_attempts.device_id`
     column (migration 0029).
   - Operator reset unchanged: `npm run reset-password` (or the admin's reset) clears the attempts.
   Tests: no per-address lock on `'unknown'`; per-username backoff still locks an unrecognised
   browser; a recognised browser signs in while the username is backed off; a recognised browser's
   own failures lock it; a forged or other-username cookie is ignored.
10. **Replacing two-factor sign-in**: when TOTP is already on, enrolling again or regenerating recovery
    codes requires the current password and a current code; on success other sessions end and an
    account-security event is recorded. Tests: refused without either, accepted with both.
11. **Restore**: once the restored database is in place, every session row is deleted (everyone signs
    in again). Settings → Backups says before and after a restore that users, passwords, two-factor
    settings and deactivations return to the backup's state. Tests: sessions gone after a restore.

## Lane D — first-run token, Watchtower token, secret key (items 12, 13, 17)

12. **Setup token.** While no user exists, boot generates a one-time random token, stores only its
    SHA-256 hash in `settings`, and prints `Budget Tracker setup token: <token>` once; `/setup`
    requires it. An operator `SETUP_TOKEN` (when set) is accepted too. The hash is removed and the
    token stops working once the first admin exists. Existing installs are untouched. Installers and
    docs say where to find the token (`docker logs`, Container Manager log); the Windows quickstart
    reads it from `docker logs` and prints it. Tests: refused without and with a wrong token,
    accepted with the right one (and with `SETUP_TOKEN`), refused once an admin exists.
13. **Watchtower token.** The pull compose file requires the operator's own value
    (`${WATCHTOWER_TOKEN:?…}`) with an `.env` example; the Windows quickstart generates a random one.
    Settings shows an admin notice while the app still sees the old shared literal, with the steps to
    change it; updates keep working. Image pin: `containrrr/watchtower` was archived upstream in
    December 2025 and has no maintained version tag, so the tag stays as it is; moving to a maintained
    fork is left to the owner.
17. **secret.key placement.** Archives already exclude `secret.key` (allow-list `budget.db`,
    `receipts/`, pinned by `tests/lib/backup-archive.test.ts`). Kept: excluding it is the safer option
    and does not make a backup unrestorable (only the encrypted settings need the matching key).
    Restore copy says the target install's key must match for two-factor and connection secrets; the
    install docs say to back up `secret.key` separately and keep it owner-only.

## Shared files

README.md / INSTALL.md / docs may be edited by lanes C and D: re-read right before each edit.
`src/instrumentation-node.ts` belongs to lane D (setup token); lane C does the session purge inside
the restore path, not in that file, unless `tests/ops/restore-seams.test.ts` requires otherwise.

## Review focus (one Opus review)

Every authorization check binds to the viewer and cannot be sidestepped with a different id; the
lockout change does not lower the rate limit for an unrecognised browser; the setup token cannot be
skipped and does not strand a fresh install; restore and second-factor changes; the workflow still
publishes a tagged release and refuses a dispatch from another branch.

## Release

CHANGELOG `## [1.58.1]` under `### Security`, plus an upgrade note (setup token for new installs,
Watchtower token). Release guard `tests/ops/docker.test.ts` pinned to 1.58.1; version fields bumped.
Gate: full suite `--no-file-parallelism`, `tsc`, clean build, smoke. Tag after `Test suite` passes.
