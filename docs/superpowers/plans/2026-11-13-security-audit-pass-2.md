# Security audit pass 2 — Audit Plan (base v1.64.0, fixes in v1.64.1)

**Goal:** Finish what the first audit (October 2026, fixes shipped in v1.58.1) left open, and review
everything that shipped since: v1.59.0 to v1.63.0 now, v1.64.0 (local AI) through the slot at the end.
The audit produces findings only. Fixes ship in one release, v1.64.1, through the lean process below.

**Base:** the v1.64.0 tag, after its gate has finished. Line numbers below (`~:N`) are from `main` at
v1.62.0 with v1.63.0 in progress, so every reviewer re-reads before citing.

## What this audit covers

Pass 1 deferred seven units and left six availability leads marked "needs validation". Each one maps
to a unit below, and each unit's report closes it with a verdict.

| Open item | Unit |
| --- | --- |
| D1 loan rule matcher paths from import, bank sync and nightly jobs | U7 (nightly: U6.2) |
| D2 read helpers that take no viewer | U11, with U12 and U13 |
| D3 migrations | U5 |
| D4 sweeps (scheduled maintenance) | U6 |
| D5 unauthenticated pages and routes | U1, with U2 |
| D6 the reset-admin CLI | U4 |
| D7 settings and audit-log writers | U15 |
| L1 argon2 work before authentication | U1.2 |
| L2 mapping arrays (import profile mappings) | U8.1 |
| L3 statement regexes | U9 |
| L4 tesseract pixel limits | U10.1 |
| L5 receipt staging quota | U10.2 |
| L6 multipart FormData buffered before size checks | U1.3 (unauthenticated), U8.2 and U10.3 (signed in) |

Shipped since v1.58.1, and where it is reviewed:

- v1.59.0 card holder attribution, affordances, Budgets income: U7.1, U8.5, U11.
- v1.59.1 update-token panel: U15.6.
- v1.60.0 backup health and archive checks, SimpleFIN backoff, import history paging, migration 0030:
  U16.7, U6.4, U8.5, U5.
- v1.60.1 zod 4 behind `src/lib/zod.ts`: X3 (R2).
- v1.61.0 row origin, `set_aside_rows`, cross-source duplicates, delete one imported row, SimpleFIN
  link start date, migration 0031: U8.5, U14.5, U5, U17.
- v1.62.0 bulk undo, transfer pairs, review by merchant, month check-in, setup suggestions: U14, U11.
- v1.63.0 split by person and migration 0032, year-end pack with a streamed receipts zip,
  self-scoped exports, restore by chunked upload up to 4 GiB: U11.3, U14.6, U5, U12.3, U16.
- v1.64.0 local AI: U18 (slot).

Out of scope: code pass 1 reviewed that has not changed since v1.58.1 apart from the zod import
(warranty item create, edit and delete, merchant rule authoring, category and item-type managers,
accounts), the release workflow and tessdata checksum (pass 1 lane B), and dependency advisories,
which Dependabot and code scanning track (the orchestrator checks both are at zero before starting).

## The household-trust model

Every finding names its actor. From most to least trusted:

1. **Operator:** shell and Docker access to the host, the data folder and the environment. Not an
   attacker here; in scope only as someone whose secrets must not leak and whom logs and docs must
   not mislead.
2. **Admin** (role `admin`): trusted with all household data, users, backups, restore, connections
   and updates. Not trusted to escape the app: no admin input may run code, read or write outside
   `DATA_DIR`, reach a host the feature does not need, or take the install down from an
   ordinary-looking input. Files and tokens an admin brings from elsewhere (a backup archive, a
   SimpleFIN setup token, a pack) are untrusted data handled by a trusted person.
3. **Household member** (role `member`, visibility `household`): reads all household money, writes
   shared data through guarded actions, does nothing admin-only.
4. **Self-scoped member** (visibility `self`): reads and writes only their own rows. Never receives
   another person's row, split part, amount, name, receipt or count, rendered or not: RSC props,
   JSON, CSV, zip entries, notifications and error text all count.
5. **Person without login, deactivated user:** no session; an existing session is refused at read
   time (`validateSession`).
6. **Unauthenticated client:** anyone on the LAN; on an internet-facing install, anyone, through a
   reverse proxy. A server action id is callable as a POST to any page, `/login` included, and the
   origin check is not authentication: a client outside a browser sends any `Origin` it likes.
7. **Remote services and files:** the SimpleFIN bridge, GitHub, Telegram, the SMTP server,
   Watchtower, uploaded statements, receipts, packs and backups, and (v1.64.0) the LAN model server.
   Every byte is untrusted.
8. **The data folder:** written by the app, but on a NAS bind mount other accounts can write it too.
   Anything read back from it (sidecars, `upload.json`, restore markers, staged files) is validated
   on read.

## Severity

- **blocker:** actor 6 or 7 reads or changes household data, signs in as someone, runs code, reads
  or writes outside `DATA_DIR`, or stops the app with a handful of requests; a self-scoped member
  reads or changes another person's money; a restore installs something other than what was
  checked; a secret leaves the server. Fixed in v1.64.1. The reviewer tells the orchestrator at once.
- **should-fix:** a signed-in member (or an admin handling an untrusted file) causes harm beyond
  their role; availability loss that takes sustained effort from a member, or a one-off modest cost
  from actor 6; a missing second layer where the first holds but is one helper change from breaking.
  Fixed in v1.64.1.
- **minor:** hardening, consistency, misleading text, defence in depth with no current path. In
  v1.64.1 only when its file is already in a lane; otherwise it goes on the backlog, worded as a
  check.

## Rules for reviewers

- **Read-only.** No edits outside `tests/_audit/`, no git writes (no add, commit, stash, checkout,
  restore), no `npm install`, no build, no server, no full test suite.
- **Probes** are vitest files `tests/_audit/<reviewer>-<topic>.test.ts` (untracked, never staged),
  run one at a time with `npx vitest run tests/_audit/<file>`, or node scripts in the reviewer's own
  scratch directory. Route handlers are plain functions that take a `Request`, and server actions run
  under a mocked `next/headers` (the patterns in `tests/api/*.route.test.ts` and
  `tests/app/*-actions.test.ts`). Probes never touch a real data folder; they set `DATA_DIR` to a
  temp directory. The orchestrator deletes `tests/_audit/` before any fix lane starts.
- **Fixtures:** `tests/helpers/db.ts` (`createSeededTestDb`, `insertTestUser`,
  `insertTestAccount`) and `tests/helpers/split-person-fixture.ts`. People `Alex` and `Sam`,
  merchants `MAPLE GROCER`, `FUEL STOP 12`, invented amounts and explicit dates. No real data.
- **Start** with `git diff --stat v1.58.1 v1.64.0 -- <owned paths>`, so the changed surface is known
  before reading.
- **Ownership:** a reviewer reports findings only in the files and functions it owns (table below),
  plus anywhere for its cross-cutting sweeps. Anything else goes in its report's Handoffs list
  (`file:line` and a one-line question) for the owner.
- **Stop rule:** every question gets a verdict: a finding, `holds` (with `file:line` evidence), or
  `not reached` (with the reason). Not reached is allowed; silence is not.
- **Public repo:** a finding describes the missing check and its effect in terms of roles. No request
  bodies, payload strings, command lines, step lists or timings that add up to a recipe. Probe code
  never enters a commit. A fix's regression test is named after the check it pins.

## Reviewers and ownership

Four fresh reviewers (Opus) run in parallel. R5 runs once v1.64.0 is tagged and its slot is
filled, in parallel with the other four.

| Reviewer | Units | Owns |
| --- | --- | --- |
| **R1** Front door and machine room | U1-U6, sweeps X1, X2 | `src/proxy.ts`, `src/instrumentation*.ts`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/global-error.tsx`, `src/app/manifest.ts`, `src/app/(auth)/**`, `src/app/(app)/layout.tsx`, `src/app/api/health`, `src/app/api/auth/logout`, `src/lib/auth/**` except `users.ts`, the five account-security actions in `settings/actions.ts` (U3), `settings/sessions-list.tsx`, `settings/profile-forms.tsx`, `scripts/reset-admin-password.ts`, `Dockerfile`, compose files (read only), `drizzle/**`, `src/db/**`, `src/lib/db/**`, `src/lib/scheduler.ts`, and the sweep functions U6 lists wherever they live (for U6's questions only) |
| **R2** Untrusted files in, and the loan matcher | U7-U10, sweeps X3, X5 | the matcher and interest functions U7 lists in `src/lib/loans.ts`, `src/lib/import/**`, `src/app/api/import/**`, `src/app/(app)/import/actions.ts`, the three profile actions in `settings/managers/actions.ts`, `src/lib/packs.ts`, `src/app/api/packs/**`, `src/lib/loans/statement-*.ts`, `src/app/api/loans/statement-prefill`, `src/lib/categorize/{normalize,rules}.ts` (pattern matching), `src/lib/warranty/{staging,receipts,sniff,suggest}.ts`, `src/lib/warranty/ocr/**`, `src/app/api/warranties/receipts/**`, the loan and receipt actions U7 and U10 list in `warranties/actions.ts`, `unlinkRulePaymentAction` in `dashboard/actions.ts` |
| **R3** Who sees what | U11-U14 | `src/app/(app)/**/page.tsx` and their client props except the settings pages R4 owns and the import page (R2); `transactions/actions.ts`, `transfer-pair-actions.ts`, `budgets/*action*.ts`, `dashboard/actions.ts` (except `unlinkRulePaymentAction`), `goals/actions.ts`, `bills/actions.ts`; the read models U11 lists; `src/lib/{bulk-undo,transfer-pairs,year-end,zip-stream}.ts`; `src/app/api/reports/**`, `src/app/api/loans/[id]/**`; `src/lib/notify/{evaluate/**,render,household,family-pass,events,raise}.ts` |
| **R4** Admin, recovery and outbound | U15-U17, sweep X4 | `src/lib/settings.ts`, `src/lib/audit.ts`, `src/lib/auth/users.ts`, `settings/page.tsx`, the update functions in `settings/actions.ts`, `settings/{updates-card,updates-client,update-token-helper,about-panel}.tsx`, `settings/{users,audit,backups,connections,notifications}/**`, `src/lib/backup/**`, `src/lib/backup.ts` (except U6's sweep functions), `scripts/{restore-core,restore-backup,create-backup}.ts`, `src/app/api/backup/**`, `src/lib/simplefin/**`, `src/app/api/simplefin/**`, `src/lib/notify/{config,crypto,outbox,egress,ratelimit}.ts`, `src/lib/notify/send/**`, `src/lib/update/**`, `src/lib/env.ts` |
| **R5** SLOT: local AI | U18 | see U18 |

**Three-reviewer fallback:** R1 also takes U15 (settings, users and audit writers); R2 also takes
U16 and U17 and runs U16 last; R3 is unchanged. Ownership moves with the units.

**Cross-cutting sweeps** (the owner may report in any file):

- **X1** authentication, origin and forced-password-change inventory (R1, in U2).
- **X2** SQL built from strings (R1, in U2).
- **X3** input bounds (R2): every action and route input parses through a schema imported from
  `@/lib/zod` (`tests/ops/zod-v4-only`), with a maximum on every string and array and bounds on every
  id, offset and count. Look for zod 4 behaviour that loosens a check the code relied on (coercion of
  empty strings, `z.guid()` versus `z.uuid()`, defaults and optional fields), and for any issue
  message that echoes the input back (a secret typed into the wrong field).
- **X4** secrets in logs, props and markup (R4, in U17).
- **X5** cost inventory (R2): every action and route whose cost per call is large (argon2, file
  parse, PDF parse, OCR enqueue, zip stream, outbound request, whole-table work such as re-running
  every rule or backfilling a loan rule), the role that can call it, and the limit it has
  (`notify/ratelimit.ts`, `update/ratelimit.ts`, sign-in lockout) or `none`.

## R1 — Front door and machine room

### U1. Unauthenticated surface (closes D5; leads L1, and L6 for unauthenticated paths)

Files: `src/proxy.ts` (`PUBLIC_PREFIXES` ~:43, `proxy` ~:98, `matcher` ~:128); `src/app/page.tsx`;
`src/app/layout.tsx`; `src/app/global-error.tsx`; `src/app/manifest.ts`;
`src/app/(auth)/login/actions.ts` (`loginAction` ~:32); `src/app/(auth)/setup/actions.ts`
(`setupAction` ~:26); `src/app/(auth)/setup/accounts/actions.ts` (`saveSetupAccountsAction` ~:31);
the `(auth)` pages; `src/app/api/health/route.ts`; `src/app/api/auth/logout/route.ts`;
`src/lib/auth/login.ts` (`DUMMY_PASSWORD_HASH` ~:21, `attemptLogin` ~:44), `password.ts`
(`ARGON2_OPTIONS` ~:8), `ratelimit.ts`, `known-device.ts`, `setup-token.ts`, `csrf.ts`,
`security-headers.ts`, `cookie-header.ts`; `createFirstAdmin` in `users.ts` (~:201, read only);
`next.config.ts`; read only in `node_modules/next`: `dist/server/body-streams.js`
(`getCloneableBody`, the 10 MB clone) and the server-action body limit.

- **U1.1 Inventory.** Every path that answers without a session: the public prefixes, every
  `/api/*` route up to its session check, and every server action. For each, what runs before the
  session is known: database read or write, argon2, body parse, file write, outbound call. Output a
  table.
- **U1.2 Argon2 before authentication (L1).** An unknown username still pays a full argon2id verify
  (64 MiB, time cost 3), by design, against timing differences. With usernames varied, the
  per-username layer never trips, and the per-address layer exists only with `TRUST_PROXY`. How many
  verifies run at once (the native work runs on the libuv pool, four threads by default, shared with
  file, zlib, crypto and DNS work)? What do memory and latency look like for the rest of the app
  while the pool is saturated (backups, receipt reads, page renders that read files)? Is there a
  global cap on verifies in flight, or a cheap refusal before the verify? Confirm `setupAction` checks
  the token before any hash (~:39), and note the cost of `forcedChangePasswordAction` (two verifies
  and a hash per request, signed in).
- **U1.3 Bodies read before checks (L6).** The logout route parses `formData()` after only the
  origin check (~:25); a server action's body is parsed before its first line runs. Confirm what
  bounds each: the proxy's 10 MB clone (does the matcher cover every path; what does a handler
  receive past 10 MB: a truncated body, an error, a 500?) and Next's default server-action body limit
  (not set in `next.config.ts`).
- **U1.4 Setup.** While no admin exists, `/setup` checks the token before any write; the compare is
  constant-time; the token is single-use and cleared once the first admin exists; `createFirstAdmin`
  cannot create two admins under concurrent requests (transaction, ~:204); the token appears only in
  the one boot line, never in props, error text or a response.
- **U1.5 Error surfaces.** Production `global-error` and server-action failures carry no stack, SQL,
  path or environment value. Health returns only the verdict, and its probe file name cannot be
  steered; note the cost per call.
- **U1.6 Proxy trust.** With `TRUST_PROXY=1`, `isSameOrigin` reads `X-Forwarded-Host` and
  `clientIpFromHeaders` (~:222) reads the leftmost `X-Forwarded-For` entry. Pass 1 settled the address
  source. Check only that the install docs tell an internet-facing operator to have the proxy
  overwrite these headers rather than append to them, and what changes when `TRUST_PROXY=1` but the
  app's port is also reachable directly.
- **U1.7 Headers.** CSP, `frame-ancestors`, `nosniff` and `Referrer-Policy` reach route-handler
  responses and downloads as well as pages (the proxy sets them on `NextResponse.next`; confirm they
  survive a `Response` a handler returns). HSTS only when HTTPS is known.

Verify: read; a scratch node script that measures `fs.readFile` and a small SQLite query latency
while 8, 16 and 32 verifies with the app's argon2 options run (no app server needed); probe tests
that call `loginAction` and `setupAction` under a mocked `next/headers` to confirm the order of
checks; cite Next's source for the two body limits.

### U2. Authentication and SQL inventory (sweeps X1, X2)

- **X1.** For every exported function in the `'use server'` files (23 files, about 142 actions
  while v1.63.0 is built) and every route handler (28 today, including v1.63.0's restore-upload pair;
  then v1.63.0's tax-detail and year-end routes and v1.64.0's), record in order: origin check (strict; the headerless variant only on download GETs),
  session (`requireUser`, `requireAdmin`, `userFromRequest` with a null check, or a local guard that
  calls one), role or visibility gate, `mustChangePassword`, schema parse, body cap. Flag an action
  whose first database read or write comes before the session; a mutating route on the headerless
  variant; a body read before its size check.
- **U2.1 Forced password change.** `src/app/(app)/layout.tsx` (~:24) enforces it for pages, and the
  export, backup, receipt and loan routes check it, but `requireUser` does not, so server actions and
  some routes (`import/*`, `packs/*`, `simplefin/*`, `warranties/receipts/stage`,
  `loans/statement-prefill`) may not. v1.12.1 (SEC-9) treated it as a boundary for exports. List
  every gap.
- **U2.2 Guard feasibility.** Would a `tests/ops/server-action-auth` guard (the brace matching of
  `tests/ops/server-action-origin.test.ts`) hold today with an allow-list of `loginAction` and
  `setupAction` only? Count the exceptions it would need.
- **X2.** Every `sql.raw` (`src/lib/warranty/expiry-sql.ts` ~:117: are all pieces constants?); every
  `prepare` or `exec` built from a template (`src/lib/warranty/search.ts` ~:56-:72, including the
  `ORDER_BY[sort]` key; `vacuumInto` in `src/lib/backup/archive.ts` ~:73 and its path quoting;
  `src/lib/db/migration-state.ts`); every `like()` fed user text (`loanRuleReach` in `loans.ts` ~:280
  does not escape `%` and `_`: semantics or reach?); the FTS5 `MATCH` input and its sanitizer
  (`search.ts` ~:57); any identifier (sort key, column) taken from input. Expected: values bound,
  identifiers from fixed maps.

Verify: a scratch script that lists each action's first guard call, reusing `functionsIn` from the
origin guard; `rg` for `sql.raw|prepare\(\`|exec\(\`|like\(` over `src` and `scripts`.

### U3. Session and credential lifecycle (signed in)

Pass 1 covered the sign-in lockout, replacing two-factor and sign-out on restore.

Files: `src/lib/auth/session.ts` (`validateSession` ~:62, sliding renewal, the `destroy*` helpers),
`src/lib/auth/totp.ts`; in `src/app/(app)/settings/actions.ts` only `changePasswordAction` ~:98,
`beginTotpEnrollmentAction` ~:126, `confirmTotpEnrollmentAction` ~:136, `disableTotpAction` ~:225 and
`signOutSessionAction` ~:266; `src/app/(auth)/change-password/actions.ts`;
`settings/sessions-list.tsx`, `settings/profile-forms.tsx`.

- **U3.1** Changing the password, turning off two-factor and replacing it all verify the current
  password. Are failures counted anywhere (`login_attempts` or a per-user limit), so a session alone
  cannot test passwords without limit?
- **U3.2** Sessions slide for 30 days with no absolute cap. Which changes end other sessions: your
  own password change, an admin reset (the action is R4's; the helper is here), a role or visibility
  change, deactivation and withdrawn sign-in (both refused at read time)?
- **U3.3** Session cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when HTTPS is known; the
  known-device cookie is signed, capped at five entries, and only ever selects a lockout bucket.
- **U3.4** TOTP counters cannot be replayed; recovery codes are hashed and single-use; the secret is
  encrypted under a key derived from `SECRET_KEY`; a decrypt failure fails closed; the QR data is
  never logged.
- **U3.5** `signOutSessionAction` binds the session id to the current user.

Verify: probes for U3.1 (repeated wrong current passwords: is anything refused?) and U3.2 (session
rows after each change).

### U4. Operator CLI and container (closes D6)

Files: `scripts/reset-admin-password.ts` (`resetPassword` ~:52, `usage` ~:131, `main` ~:156);
`package.json` scripts; `Dockerfile` (runner stage, `USER node` ~:118, `HEALTHCHECK` ~:124);
`docker-compose.yml` and `install/synology-compose*.yml` (read only: a finding here is an owner
decision under the app-only rule); secret-key creation in `src/lib/env.ts` (~:92-:126).

- **U4.1** The new password is a command-line argument, so it lands in shell history, the process
  list and NAS task logs. Is there a prompt, stdin or environment path? Same check for any other
  script that takes a secret.
- **U4.2** Policy parity: minimum and maximum length, the argon2 options (pinned by
  `tests/scripts/reset-admin-password.test.ts`). Does a rescue reset set `must_change_password`, and
  should it?
- **U4.3** Side effects: the reset reactivates a deactivated account. Is that also true for an
  account an admin deactivated on purpose, with no trace? Does a reset leave an audit row or raise
  the account-security notice? Are device-bucket login attempts cleared too? Does `--clear-mfa`
  clear the secret, recovery codes and used counters?
- **U4.4** Safe while the app runs (WAL, busy timeout); refuses a missing database (~:80); never
  prints the password or its hash.
- **U4.5** `secret.key` is created owner-only; the log line names the path, never the key.
- **U4.6** Container: runs as `node`, read-only root, `/tmp` a 64 MB tmpfs, all capabilities dropped,
  `no-new-privileges`. List any runtime write outside `DATA_DIR` and `/tmp`, and anything a member can
  use to fill `/tmp` (hand the statement scratch file to U9).

Verify: read; run the CLI against a temp copy of a test database (`BUDGET_DB_PATH`) in a scratch
directory and record its output and side effects.

### U5. Migrations (closes D3)

Files: `drizzle/0000` to `0032` and `meta/_journal.json`, reading closely every migration that adds
or changes an owner, person, visibility, role, session, audit or settings column; `src/db/client.ts`
(`openDatabase` ~:64, the newer-than-code check, `foreign_key_check`); `src/lib/db/migration-state.ts`;
`src/db/schema.ts`; `src/db/seed.ts`; read only: `readAppliedMigrations` and
`assertNotNewerThanCode` in `scripts/restore-core.ts`.

- **U5.1** Every migration that adds an ownership or person column (0013 household scope, 0030
  deactivation, 0031 row origin and `set_aside_rows`, 0032 split person, and any other) leaves each
  existing row exactly as private as before. No backfill moves a person's row to Household (NULL) or
  to someone else.
- **U5.2** CHECKs on role, visibility and every enum; unique username (case-insensitive) and session
  token hash; foreign-key actions on `users` (nothing cascades into audit rows or another person's
  data).
- **U5.3** The count check trusts `__drizzle_migrations` in whatever database is on disk. Does
  anything confirm a restored database's shape (tables, columns, indexes, CHECKs), or does one whose
  journal claims the head run as-is with constraints missing? (Admin-supplied; severity per the
  trust model.)
- **U5.4** Tables actor 6 can grow (`login_attempts`, one row per failure, 30-day retention) and the
  indexes the lockout reads use; tables a member can grow without bound (`set_aside_rows`; settings
  dismissals go to U15).
- **U5.5** The setup seed enables nothing with network reach and relaxes no check.

Verify: read; a probe that builds a database at v1.58.1's migrations with a self-scoped member and
household rows (the `tests/db/migration-*.test.ts` pattern), migrates to the head, and compares a
self viewer's `listTransactions` before and after.

### U6. Scheduled jobs and sweeps (closes D4)

R1 owns these functions for these questions, wherever they live: `src/lib/scheduler.ts`
(`runOcrSweep` ~:54, `runNightlyTick` ~:64, `runNotifyTick` ~:78, `runUpdateTick` ~:134,
`runCanadianPackUpdateTick` ~:170, `runSimplefinTick` ~:201, `syncAsAutoSyncUser` ~:265,
`scheduleBackupCatchUp` ~:299, `startScheduler` ~:332); in `src/lib/backup.ts` `pruneBackups` ~:128,
`runMaintenanceSweep` ~:150, `runNightlyJob` ~:208, `backupCatchUpDue`; `purgeStagedFiles`
(`import/staging.ts` ~:57), `purgeOrphanReceipts` (`warranty/receipts.ts` ~:165),
`purgePreRestoreCopies` (`backup/restore.ts` ~:962), `expireStalePending` and `purgeOldOutboxRows`
(`notify/outbox.ts` ~:302, ~:313), `purgeExpiredSessions` (`auth/session.ts` ~:191),
`purgeOldLoginAttempts` (`auth/ratelimit.ts` ~:236), `pruneInsightDismissals`
(`insight-dismissals.ts` ~:79), `pruneTransferPairDismissals` (`transfer-pairs.ts` ~:341),
`closeMonthsAutomatically` (`month-close.ts` ~:183), `sweepPendingReceipts` (`warranty/ocr/queue.ts`
~:266); the boot order in `src/instrumentation-node.ts`.

- **U6.1** Each deletion removes only entries it can positively identify (name pattern, type, age)
  inside its own directory. `statSync` follows links while `rmSync` acts on the link: with a link or
  a directory planted in `DATA_DIR/tmp` or `receipts/` (the bind mount is writable by other NAS
  accounts), can a sweep remove or recurse outside its directory? Directory age comes from the
  directory's mtime, which does not change while a file inside grows: can the 24-hour rule and the
  60-minute upload idle rule ever disagree about a live `-restore` session or an `-archive` build?
- **U6.2** Unattended identity: SimpleFIN auto-sync runs as the stored admin id, re-checked each tick
  (~:268). Interest posting (its semantics are U7.3) and month auto-close run household-wide: which
  user, if any, is recorded on the rows they write, and can a self-scoped member's view change
  because of them?
- **U6.3** No job writes into a database about to be replaced (restore staged or applying); tick
  guards stop overlapping runs (`tests/ops/scheduler-tick-guard`); one job's throw stops no later
  job.
- **U6.4** Every sweep and tick has an upper bound per run (OCR re-enqueue, outbox pump, accounts
  synced, update check), and a remote that keeps failing backs off rather than looping.
- **U6.5** Failure text stored in settings (`backup_last_failure_reason`, cut to 500) or sent as an
  alert may carry remote text or paths. Who sees it? (Secrets in it: hand to X4.)

Verify: probes with a temp `DATA_DIR`: a planted link to a directory outside, an old-mtime
`-restore` directory holding a fresh file, a non-matching name; run each purge and assert only the
intended entries go.

## R2 — Untrusted files in, and the loan matcher

### U7. Loan rule matcher paths (closes D1)

Files: in `src/lib/loans.ts` `loanRuleReach` ~:259, `postAllDueInterest` ~:1329,
`applyPaymentMatchers` ~:1829, `backfillLoanRule` ~:1908 and their helpers; callers
`import/flow.ts` ~:243, `simplefin/sync.ts` ~:318, `import/set-aside.ts` (`releaseSetAsideRow` ~:322,
call ~:418), `categorize/engine.ts` ~:1411 and ~:1458, `backup.ts` `runNightlyJob` ~:216; in
`warranties/actions.ts` `recordLoanPaymentAction` ~:667, `saveLoanRuleAction` ~:888,
`deleteLoanRuleAction` ~:970; `unlinkRulePaymentAction` in `dashboard/actions.ts` ~:287.

- **U7.1** Every caller reaches the v1.58.1 owner restriction (the rule's owner scope against the
  transaction's person), including paths added since: releasing a set-aside row and keeping a
  possible duplicate (v1.61.0), rows attributed by card holder at import (v1.59.0: does attribution
  happen before matching on every path, or can a row match while still unattributed?), and split
  parts set to another person (v1.63.0: which person does the matcher compare for a split
  transaction?).
- **U7.2** When a row's person changes after it was linked (Set person, bulk undo, split person, a
  card-holder change), the link stays. Can a self-scoped member then see another person's payment on
  their own loan's ledger, or the reverse? (The ledger read is R3's; hand off the read path.)
- **U7.3** Rows written by `postAllDueInterest`: whose are they, are they written once per period
  after a crash mid-run, and is posting skipped while a restore is pending?
- **U7.4** Reach and cost of a broad `merchantContains`: is there a minimum length, and is a backfill
  bounded per save?
- **U7.5** `unlinkRulePaymentAction` and `recordLoanPaymentAction` resolve the item and the account
  through the viewer.

Verify: probes on the split-person fixture with a self-scoped Alex holding a loan rule: drive the
import flow, a SimpleFIN sync with a fake fetcher, a set-aside release and `confirmCategory`; assert
nothing links to Sam's rows.

### U8. Statement imports, profiles and packs (lead L2; L6 signed in)

Files: `src/app/api/import/{detect,batch/detect,preview,raw-preview,commit,batch/commit,undo}/route.ts`;
`src/app/(app)/import/actions.ts` (`saveWizardProfileAction` ~:44, `saveMappingAction` ~:104,
`setCardPersonAction` ~:170, `closeMonthAction` ~:217, `loadImportHistoryAction` ~:265);
`src/lib/import/**` (`mapping.ts` `importMappingSchema` ~:66-:89, `parse.ts`, `decode.ts`, `ofx.ts`,
`zip.ts`, `staging.ts`, `held-file.ts`, `preview.ts`, `commit.ts`, `flow.ts`, `batch.ts`, `dedup.ts`,
`cross-source.ts`, `set-aside.ts`, `origin.ts`, `card-people.ts`, `presets.ts`, `detect-*.ts`);
`saveProfileMappingAction`, `deleteProfileAction`, `setProfileActiveAction` in
`settings/managers/actions.ts`; `src/lib/packs.ts` (`parseRulesPack` ~:435, `parseProfilesPack`
~:463); `src/app/api/packs/**`.

- **U8.1 Mapping arrays (L2).** `importMappingSchema` bounds column indexes but not the length of
  `descCols`, the count or length of `skipRules.containsAny`, or the length of `dateFormat`. Does every
  writer (wizard, managers, profiles pack of up to 200) go through it? Worst-case stored size and the
  per-row cost at import (rows x patterns x length). Propose caps.
- **U8.2 Upload bodies (L6).** Each route checks the declared length before `formData()` or `json()`;
  without one, the body is bounded only by the proxy clone (10 MB, against a 5 MB `MAX_FILE_BYTES`).
  Batch detect with many files; zip entries (25) with the inflated size bounded by the real output,
  not only the declared size (~:183); nested archives refused.
- **U8.3 Parse cost.** Caps on rows, columns per row, cell and line length before work; the OFX/QFX
  parser on deep nesting or entity-like input; charset detection cost.
- **U8.4 Staging.** Staged statements carry no uploader (staged receipts record theirs): can a
  member read or commit another member's staged file by id? How many staged files and bytes can one
  member hold until the 24-hour sweep?
- **U8.5 Authorization since v1.58.1.** Who may map a card to a person (`setCardPersonAction`);
  paging bounds on import history; import undo removes only that import's rows (and what of rows
  someone else changed since); set-aside release and dismiss bind to the viewer.
- **U8.6 Packs.** Admin-only import; caps (5,000 rules, 500 categories, 200 profiles, patterns up to
  200 characters); profile mappings parsed by `importMappingSchema`; exports carry no account numbers
  or people.

Verify: probes calling `parseImportMapping` and `parseProfilesPack` with large arrays (time and
stored size); route probes in the shape of `tests/api/import*.route.test.ts`.

### U9. Text parsers and regular expressions (lead L3)

Files: `src/app/api/loans/statement-prefill/route.ts` (POST; the PDF is written to `os.tmpdir()` ~:49
and parsed in the request); `src/lib/loans/statement-extract.ts`, `statement-csv.ts`;
`src/lib/warranty/ocr/pdf.ts` (`extractPdfText`, 20 pages, `isEvalSupported: false`);
`src/lib/warranty/suggest.ts` (patterns over OCR text of up to 100,000 characters);
`src/lib/import/{detect-date-format,presets,parse,ofx}.ts`; `src/lib/categorize/{normalize,rules}.ts`;
`scrubSecrets` in `src/lib/notify/crypto.ts`.

- **U9.1** List every regular expression applied to uploaded or remote text. Mark each with nested or
  overlapping quantifiers. Is each input line length-capped before matching?
- **U9.2** Statement prefill is open to any member who is not self-scoped, parses PDFs in the request
  with no queue or concurrency cap, and writes its scratch file into a 64 MB tmpfs. What do several
  concurrent 10 MB uploads cost (CPU, `/tmp`)? Is PDF stream decompression bounded?
- **U9.3** Merchant rule patterns are matched as text, never compiled (`patternMatches`); the dynamic
  `RegExp` sources in `normalize.ts` are constants.

Verify: a scratch timing harness that runs each expression against 100,000-character strings built
from its own repeated tokens (flag anything over 100 ms); a probe calling the prefill handler
concurrently with a stubbed `extractPdfText`.

### U10. Receipts, staging and OCR (leads L4, L5)

Files: `src/app/api/warranties/receipts/stage/route.ts` (POST), `stage/[stagingId]/route.ts` (poll),
`receipts/[id]/route.ts` (file); `src/lib/warranty/{staging,receipts,sniff,suggest}.ts`;
`src/lib/warranty/ocr/{engine,queue,tesseract,pdf}.ts`, `ocr/onnx/preprocess.ts`
(`limitInputPixels` 50,000,000 ~:154); in `warranties/actions.ts` `reconcileLoanAction` ~:544 (file
~:593), `attachReceiptsAction` ~:770, `deleteReceiptAction` ~:805, `reRunOcrAction` ~:839,
`recomputeLoanBalanceAction` ~:1172 (file ~:1200).

- **U10.1 Pixel limits (L4).** The ONNX path decodes through sharp under a 50-megapixel limit. When
  preprocessing throws, `recognizeWithTesseract` (~:80-:90) passes the raw file on: does an image
  refused for size then reach a decoder with no limit? Are PDFs ever rasterized, or text layer only?
  What bounds memory per job, and does the OCR timeout free it (worker ended, or promise abandoned)?
- **U10.2 Staging quota (L5).** Per request, 5 files of 10 MB. Per member and in total, how many
  staged receipts and bytes can exist before the 24-hour sweep, and how long can one member keep the
  single OCR queue busy for everyone (staging, re-running OCR)?
- **U10.3 Bodies.** `MAX_UPLOAD_BYTES` (50 MB) is above the proxy's 10 MB clone: what does the route
  see for a five-file upload over 10 MB? Do the file inputs of the two loan actions fit the
  server-action body limit?
- **U10.4 Serving.** The receipt route resolves the file by id only, checks `canActOnOwner` on the
  item, sends the sniffed type with `nosniff`, and chooses attachment or inline deliberately; the poll
  answers only `stagedByViewer`; staging ids are checked as UUIDs before any path join.
- **U10.5 Sidecars.** OCR sidecars and owner files read back from `tmp` are validated; a malformed
  one cannot crash the poll or the sweep.

Verify: a probe with the seeded fake tesseract worker and an image whose header declares more than
50 MP (assert what `recognize` receives); a loop staging receipts as one member, counting files,
bytes and queue length.

## R3 — Who sees what

### U11. Read helpers and page props (closes D2)

Files: every `src/app/(app)/**/page.tsx` that R3 owns, and the props each passes to client
components; read models in `src/lib/`: `transactions.ts`, `accounts.ts`, `reports.ts`, `tax.ts`,
`budgets.ts`, `budget-income.ts`, `recurring.ts`, `recurring-view.ts`, `insights.ts`,
`insight-dismissals.ts` (`dismissalIsInScope`), `networth.ts`, `bills.ts`, `goals.ts`,
`month-checkin.ts`, `month-close.ts` (`accountReadiness` ~:63 takes no viewer), `setup-suggestions.ts`,
`transfer-pairs.ts` (`suggestTransferPairs`), `bulk-undo.ts` (`lastBulkUndo` ~:343 takes a user id),
`splits.ts`, `split-person.ts`, `attribution.ts`, `spend-where.ts`, `runway.ts`, `savings-rate.ts`,
`savings-target.ts`, `onboarding.ts` (`onboardingSteps` ~:81 takes no viewer), `predict/**`, the read
functions of `loans.ts` (`listLoanRows`, `listLoanSummaries`, `loanDetail`, `loanLedger`), reads in
`warranty/items.ts` and `warranty/search.ts`; read only: `listWaitingSetAside` (R2's file);
`tests/ops/visibility-invariants.test.ts` (`REQUIRE_VIEWER`, `EXEMPT`, `HOUSEHOLD_ONLY_AT_PAGE`).

- **U11.1** List every exported read function in these modules that a page, route, action or
  notification calls and that is on none of the three lists. For each, show the viewer reaching it
  or the caller narrowing, with `file:line`.
- **U11.2** For a self-scoped viewer, no page's serialized props hold another person's row, split
  part, amount, name, receipt, merchant or count. Counts included: needs review, waiting set-aside
  rows, possible duplicates, transfer pairs, setup suggestions, onboarding steps, month check-in,
  Year in review.
- **U11.3** v1.63.0 split person: every aggregate a self viewer reaches uses `EFFECTIVE_PERSON` (or
  `personRowClause`, `soleOwnerClause`, `partPersonClause` as the plan's reader shapes say), and
  one-row-per-transaction reads show only the viewer's share.
- **U11.4** Actions that take a scope or person from the client
  (`budgets/category-history-action.ts`, `budgets/category-transactions-action.ts`, and any new one)
  refuse, never rewrite, when a self viewer names someone else.
- **U11.5** `HOUSEHOLD_VIEWER` is used only where a room, not a person, receives the result
  (`tests/ops/viewer-construction`).

Verify: probe tests that build the split-person fixture plus a self-scoped member, render each page
or call its data path as `tests/app/*page*.test.tsx` do, serialize the client props, and search them
for the other person's name, merchants and amounts.

### U12. Exports and downloads

Files: `src/app/api/reports/{export,tax-export}/route.ts` and v1.63.0's `tax-detail` and `year-end`
routes; `toCsv` and `csvCell` in `src/lib/reports.ts` (`FORMULA_TRIGGER` ~:657); `src/lib/tax.ts`;
`src/lib/year-end.ts`, `src/lib/zip-stream.ts` (v1.63.0); `src/app/api/loans/[id]/{estimate,ledger.csv}/route.ts`.

- **U12.1** Each download: the headerless origin variant on GET only, then session, forced password
  change, viewer scope (self viewers get their own rows, per v1.63.0), a filename built from fixed
  parts.
- **U12.2** Every CSV goes through `toCsv`, and the formula guard covers every leading character
  spreadsheet apps read as a formula (`=`, `+`, `-`, `@`, tab and carriage return).
- **U12.3** Year-end zip: entry names follow `zip-stream`'s rule; a receipt is included only when
  `canActOnOwner`; a self viewer's files name nobody else; the 2 GiB cap answers 413 before the
  first byte; the length is exact; a file that changes mid-stream aborts it; handles close when the
  client goes away; what repeated requests by one member cost (each pack reads every receipt twice),
  and whether anything limits them.
- **U12.4** Loan estimate and ledger resolve the item through `getWarrantyItem(id, viewer)`.

Verify: route probes as `tests/api/*` do; a CSV probe with cells starting with each trigger.

### U13. Notification content and recipients

Files: `src/lib/notify/evaluate/**`, `render.ts`, `household.ts`, `family-pass.ts`, `events.ts`,
`raise.ts`; `sendDigestNowAction` in `dashboard/actions.ts` ~:172.

- **U13.1** A personal message to a self-scoped recipient is computed with that recipient's viewer;
  family-channel messages use `HOUSEHOLD_VIEWER` and go only to household targets; v1.63.0 split
  parts count for their own person in digests.
- **U13.2** Member-entered and remote text in messages (merchants, OCR text, notes, bank error
  lists) is plain text (Telegram sends no `parse_mode`; email is text or escaped), with a length cap.
- **U13.3** A self viewer cannot ask for the household digest (~:185); the manual digest limit holds
  (3 an hour per user, 8 overall).

Verify: a probe rendering each evaluator for a self-scoped recipient over the split-person fixture.

### U14. Write surface added since v1.58.1

Files: every hunk of `src/app/(app)/transactions/actions.ts` changed since v1.58.1, in particular
`setAttributionAction` ~:502, `bulkConfirmViewAction` ~:956, `reviewMerchantGroupAction` ~:1028,
`undoBulkAction` ~:1112, `saveSplitsAction` ~:1478, `deleteTransactionAction` ~:1528,
`keepPossibleDuplicateAction` ~:1561, `dismissPossibleDuplicateAction` ~:1580,
`sendBackToReviewAction` ~:1823; `transactions/transfer-pair-actions.ts`; `src/lib/bulk-undo.ts`
(`captureBulkBefore` ~:215, `recordBulkUndo` ~:259, `undoLastBulkAction` ~:425);
`src/lib/transfer-pairs.ts` (`confirmTransferPair` ~:306, `dismissTransferPair` ~:366); changed
hunks of `budgets/actions.ts`, `dashboard/actions.ts`, `goals/actions.ts`, `bills/actions.ts`.

- **U14.1** Each action: origin first, then session, then the viewer gate; every client id resolved
  through the viewer before any write. A self-scoped member posting another person's id changes
  nothing and learns nothing (no name in the refusal).
- **U14.2** Bulk undo: the record belongs to the user who made it, and nobody else can apply it; the
  restored values are checked again against today's visibility and state (a row since deleted or
  reassigned, a rule since edited by someone else); the record has a size cap and is schema-checked
  on read.
- **U14.3** Review by merchant changes only rows the viewer may change; Remember writes a household
  rule and is refused for self viewers (`RULES_ARE_HOUSEHOLD_WIDE`).
- **U14.4** Transfer pairs: both rows visible to and changeable by the viewer (dismissal key growth
  goes to U15).
- **U14.5** Deleting one imported row and deciding a possible duplicate: audited, with no member
  free text beyond the cap; a re-import does not quietly bring a deleted row back; who may decide.
- **U14.6** Split person (v1.63.0 S4): a self viewer may set a part only to follow or to themselves,
  and edit a split only when every part is theirs; a household viewer may name anyone attributable or
  the person a part already carries.

Verify: per-action probes on the split-person fixture (self-scoped Alex posting Sam's ids), each
asserting a refusal and an unchanged database; a two-user bulk-undo probe.

## R4 — Admin, recovery and outbound

### U15. Settings, users and audit-log writers (closes D7)

Files: `src/lib/settings.ts`; every `setSetting` / `setIntSetting` / `deleteSetting` caller
(`settings/connections/actions.ts` ~:74, `auth/setup-token.ts` ~:44, `backup.ts` ~:76 and ~:184,
`bulk-undo.ts` ~:315, `canadian-pack.ts` ~:138, `categorize/bayes.ts` ~:23, `insight-dismissals.ts`
~:71, `simplefin/connection.ts` ~:73, `transfer-pairs.ts` ~:380, `update/state.ts`,
`warranty/ocr/onnx/probe.ts`); `src/lib/audit.ts` (`appendAudit` ~:38, `listAudit` ~:73) and its
callers; `settings/audit/page.tsx`; `src/lib/auth/users.ts`; `settings/users/actions.ts`
(`createUserAction` ~:32, `setActiveAction` ~:56, `resetPasswordAction` ~:75, `resetMfaAction` ~:94,
`createPersonAction` ~:115, `setVisibilityAction` ~:138, `setCanSignInAction` ~:162); the update
functions in `settings/actions.ts` (~:444-:692) and the settings page, updates card, updates client,
update-token helper and about panel; `setRetentionAction` in `settings/backups/actions.ts` ~:19.

- **U15.1** Keys built from member input (insight dismissals, `isDismissalKey` ~:47; transfer-pair
  dismissals; bulk-undo records): can any input produce a key outside its prefix, land on a
  security-relevant key (the setup-token hash, update keys, the auto-sync user, backup keys), or grow
  the table without bound?
- **U15.2** JSON values read back (bulk-undo records, update state) are schema-checked; a hand-edited
  or old-format value fails closed.
- **U15.3** Security-relevant settings (auto-sync user, update checks, auto-apply, retention with a
  floor of 1, OCR engine) are written only by admin actions with an origin check. The audit log holds
  seven destructive actions and no settings change (v1.64.0 adds local AI changes). List the admin
  changes that leave no record: role, visibility, sign-in, reset password, reset two-factor,
  deactivate, auto-apply, forget connection, restore staged. (Owner decision.)
- **U15.4** The audit log stays append-only; its detail is short and never holds a secret or a
  member's free text beyond the cap; `listAudit` is admin-only; rows survive a deactivated user (the
  read inner-joins `users`).
- **U15.5** Users: the last active admin cannot be deactivated, demoted or made self-scoped; an
  admin is never self-scoped (M1); an admin reset sets `must_change_password` and ends sessions;
  resetting two-factor ends sessions; usernames are unique without regard to case; a person without
  login cannot sign in; reactivation brings back no old session.
- **U15.6** Updates: applying is admin-only, goes only to the configured Watchtower address, and
  repeated presses are limited (`update/ratelimit.ts`); the old-token notice carries a boolean only
  (MUST-7.3); the helper's new token never reaches the server.

Verify: probes calling `dismissInsightAction` and `dismissTransferPairAction` with unusual keys (very
long, path-like, another prefix) and counting rows after many calls; user-action probes for the
last-admin rules.

### U16. Restore and backup integrity (includes v1.63.0 restore by upload)

Files: `src/lib/backup/restore.ts` (`stageInto` ~:415, `stageRestore` ~:472, `uploadedSourceName`
~:498, `stageUploadedRestore` ~:509, `applyStagedRestoreOnBoot` ~:892), `restore-upload.ts` (start,
append, finish, cancel ~:171-:309), `archive.ts` (`resolveSafeTarget` ~:56, `vacuumInto` ~:70,
`buildArchive` ~:104), `pre-upgrade.ts`, `restart.ts`; `src/lib/backup.ts` (`runNightlyBackup`
~:88, `createOnDemandBackup` ~:137, `listBackups`, `backupHealth`); `scripts/restore-core.ts`
(`assertArchiveEntriesAreSafe` ~:91, `sha256File` ~:218, `preflightSqliteFile` ~:313,
`validateArtifact` ~:352, `verifyArchive` ~:419, `purgeIncomingSessions` ~:481, `prepareRestore`
~:506, `commitRestore` ~:674); `scripts/restore-backup.ts`, `scripts/create-backup.ts`;
`src/app/api/backup/{download,restore-upload,restore-upload/[id]}/route.ts`;
`src/app/(app)/settings/backups/**` (`runBackupNowAction` ~:31, `stageRestoreAction` ~:59).

- **U16.1** All four upload handlers, in order: origin, session, admin, forced password change,
  schema; the id checked as a UUID before any file call; a session bound to the admin who started
  it; one session at a time; the offset equals the current size; each chunk at most 8 MiB by
  declared length and by bytes read; the 60-minute idle rule.
- **U16.2** What is checked is what is installed: the bytes hashed at staging, the bytes validated
  and the bytes the boot path extracts are the same (the marker's hash is checked again at boot);
  nothing can write into `restore-staged/` after staging; an archive with two `budget.db` entries, or
  `receipts/` entries outside the stored-name pattern, is refused rather than settled by entry order.
- **U16.3** Archive shape: the tar-slip defence aborts, never skips, on absolute paths, `..`, links
  and devices. Entry count and total extracted size are bounded? The free-space check uses the
  compressed size (3 x bytes + 100 MB): can a small archive expand past it and fill the data volume
  during validation or at boot?
- **U16.4** The incoming database is opened read-only for `quick_check`. Is that connection opened
  defensively (untrusted schema off, no extension loading), and does anything refuse a database
  carrying triggers, views or tables outside the app's schema? After a restore, such objects run on
  every app write. (Admin-supplied; owner decision on how far to go.)
- **U16.5** Finishing an upload hashes and extracts up to 4 GiB synchronously inside the request, so
  every other request and the healthcheck wait. Acceptable for an admin action, or should the work
  move to the boot path or a worker?
- **U16.6** After an uploaded restore: every session is deleted (pass 1's rule, on this path too);
  both panels show the same warnings; the source name cannot put a line break into a log;
  pre-restore copies are owner-only.
- **U16.7** Backups at rest: modes of `backups/` and each archive; `secret.key` excluded (pinned by
  `tests/lib/backup-archive.test.ts`); the download streams with an exact length, admin-only, behind
  the forced password change.

Verify: probes with a temp `DATA_DIR`, using archives from `buildArchive` and archives assembled
with `tar` in the probe (two `budget.db` entries, a database with an extra trigger, a highly
compressible payload, many entries); assert refusal or record what is accepted.

### U17. Outbound connections and secrets (sweep X4)

Files: `src/lib/simplefin/{client,connection,sync,crypto}.ts`;
`src/app/api/simplefin/{claim,link,accounts,sync}/route.ts`; `settings/connections/**`
(`forgetConnectionAction` ~:26, `setSimplefinAutoSyncAction` ~:59); `src/lib/notify/{config,crypto,
outbox,egress,ratelimit}.ts`, `src/lib/notify/send/**`; `settings/notifications/**`;
`src/lib/update/**`; `src/lib/env.ts`; `tests/ops/notify-egress.test.ts` (reference).

- **U17.1** Destinations: the SimpleFIN claim URL decoded from an admin-pasted token, the SMTP host,
  Telegram, GitHub, the Watchtower URL. The scheme and host rules for each; which can point at the
  LAN or loopback, and whether that matters under the trust model; redirects refused, timeouts and
  response caps on every one (v1.58.1 did SimpleFIN's).
- **U17.2** Secrets at rest (SimpleFIN access URL, SMTP password, Telegram tokens): AES-256-GCM, a
  fresh IV each time, a key derived from `SECRET_KEY` with a distinct label per purpose; a decrypt
  failure fails closed with a plain message.
- **U17.3 X4.** Every `console.*` call and every thrown message that may carry a URL with
  credentials (a SimpleFIN access URL holds them), a token, an SMTP password, a session token, the
  setup token (allowed once, at boot), `SECRET_KEY`, or a raw remote body; every client prop that
  could carry one (the SMTP and target readers return `passwordSet` / `secretSet`: confirm for every
  settings page); every error a member can see (`scrubSecrets` coverage).
- **U17.4** Remote text (bank error lists, GitHub release notes in the about panel and the update
  review, chat-detection results) is length-capped and rendered as text.
- **U17.5** Manual triggers: is there a cooldown on the SimpleFIN sync route, so repeated presses
  cannot get the bridge to refuse the household; test sends, chat detection and update checks keep
  their limits.

Verify: the `rg` sweep; probes with a fake fetch that throws an error naming the request URL,
asserting that no log line or returned message contains its credential part.

## R5 — SLOT: v1.64.0 local AI (U18)

**Status: SLOT, not ready to run.** Fill it after v1.64.0 is tagged: replace the draft file list with
the as-built one (`git diff --stat v1.63.0 v1.64.0`), keep these questions, and add any the as-built
code raises. R5 owns everything under `src/lib/ai/` and `src/lib/net/`, the AI actions, routes and
components, migration 0033, and the v1.64.0 hunks of shared files (`src/lib/update/egress.ts`,
`src/lib/warranty/staging.ts`, `src/lib/warranty/suggest.ts`, `src/lib/scheduler.ts`, the stage poll
route, the Connections page, the transactions page and client, the review components). R1 to R4
skip v1.64.0 hunks in their files.

Draft files (from `2026-11-12-v1.64.0-local-ai.md`): `drizzle/0033_ai_suggestions.sql`;
`src/lib/net/private-address.ts`; `src/lib/ai/{types,lan,schemas,prompts,client,config,suggestions,
receipt,queue,ask}.ts`; `src/app/(app)/transactions/{ai-actions,ask-action}.ts`;
`src/components/AskInWords.tsx`; the Local AI card and its actions under Settings, Connections;
`tests/ops/ai-suggest-only.test.ts` and the `notify-egress` extension.

- **U18.1 LAN only.** The address check runs on the parsed host: integer, octal, hex and short IPv4
  spellings (the URL parser normalises them), IPv4-mapped and NAT64 IPv6, `0.0.0.0`, zone ids,
  trailing-dot names, names under `localhost`. Every resolved address is checked and the connection
  goes to the address checked (the lookup hook, in both its single and `all` callback forms). No
  redirect is followed. No proxy environment variable changes where `node:http` connects on the
  image's Node version. Only `src/lib/ai/client.ts` makes requests (`tests/ops/notify-egress`).
- **U18.2 Caps.** Connect and answer timeouts, request and response byte caps enforced while
  reading; reply bodies never logged, stored or echoed; no `Authorization` header or cookie, ever.
- **U18.3 Queue.** Bounded per sweep, one request at a time, backoff from 5 minutes to 6 hours; no
  page render waits on the model. Can a member trigger requests at will? Test is admin-only; Ask in
  words: is there a per-user limit or a single request in flight, and what happens to the review
  queue when several members ask at once?
- **U18.4 Prompts built from household data.** Only the fields the v1.64.0 plan's L6 lists: one row
  or one receipt plus the category labels; for Ask, the viewer's own accounts and, for a household
  viewer only, people. Never notes, another row, or another person's data for a self viewer.
- **U18.5 Untrusted output.** Descriptions, OCR text and the question can steer the model, so its
  output may only become a suggestion: a category from the label list, a name through
  `cleanMerchantName`, receipt values that are printed in the text, Ask fields mapped to ids from
  viewer-scoped lists and turned into a link only by `transactionsHref`. No path from model output
  to SQL text, HTML, any other URL, a notification or a log line.
- **U18.6 Suggestion-only writes.** Nothing under `src/lib/ai/` writes transactions, rules or items
  (`tests/ops/ai-suggest-only`); Use goes through `setCategoryAction`, `renameTransactionAction` or
  `reviewMerchantGroupAction` with every guard; Remember writes a rule only on a person's press.
- **U18.7 Visibility.** No suggestion is serialized for a self viewer; Review stays household-only; a
  receipt's AI result reaches only its uploader (`stagedByViewer`); the AI sidecar is swept with the
  OCR sidecar.
- **U18.8 Settings.** Admin-only, origin-checked, audited once per change with no secret; a base URL
  with user info is refused; migration 0033's CHECKs hold.

Verify: probes against `tests/helpers/fake-model-server.ts`: a name resolving to mixed private and
public addresses, a redirect, an oversize body, a slow body; a captured prompt for a self viewer's
Ask.

## Finding format

One block per finding, numbered per reviewer:

```
### R<n>-<nn> <one-line title naming the missing check>   [blocker | should-fix | minor]
- Question: U<n>.<n> (or X<n>)
- Where: <path>:<line> (<function>), plus any second site
- Actor: unauthenticated | remote | self-scoped member | household member | admin
- Check: what the code checks today and what it does not, in one or two sentences
- Scenario: the outcome in terms of roles and data ("a self-scoped member's request returns
  another member's amount"), no payloads and no steps
- Fix: the check to add and the helper to reuse; the test that fails on v1.64.0, named after the
  check
- Evidence: read | probe tests/_audit/<file> (what it showed)
```

## Report format (each reviewer's final message)

1. **Findings**, blockers first.
2. **Holds:** every question answered `holds`, each with its `file:line` evidence, one line apiece.
3. **Leads closed** (R1: L1, L6 unauthenticated; R2: L2-L5, L6 signed in): `confirmed` (finding id),
   `not reachable` (why), or `bounded` (by what, with the figure).
4. **Deferred units closed** (D1-D7 for the owning reviewer): the same three verdicts.
5. **Handoffs:** `file:line` and a one-line question for the owning reviewer.
6. **Not reached:** each question with the reason.
7. **Probe files** left in `tests/_audit/`.

## After the audit: triage

1. The orchestrator merges the five reports, settles every handoff against its owner's report (an
   unanswered one becomes a short follow-up to that owner), and removes duplicates.
2. Every blocker and should-fix is verified by reading the cited lines and running its probe. No
   fix is planned from an unverified finding.
3. Each finding is mapped to the lane that owns its file. The owner decisions it raises are asked
   once, in one list.
4. The merged findings stay outside the working tree until v1.64.1 is tagged.
5. `tests/_audit/` is deleted before any lane starts.

## Fix release v1.64.1 (lean process)

**The plan:** `docs/superpowers/plans/<date>-security-fixes-v1.64.1.md` in the v1.58.1 plan's shape.
Items are grouped by lane, each written as the check the code will perform plus its test that fails
on v1.64.0. No exploit narrative.

**Lanes:** one per reviewer's file set (A = R1, B = R2, C = R3, D = R4, E = R5), so file sets are
disjoint by construction. A lane with no findings is dropped. Shared files: `CHANGELOG.md`,
`tests/ops/docker.test.ts` and the version fields belong to the release step; `README.md`,
`INSTALL.md` and `src/app/(app)/help/content.tsx` go to one named lane, and anyone else re-reads
before editing; a new `tests/ops` guard belongs to the lane whose finding needs it.

**Implementers:** one fresh implementer per lane, all lanes in parallel. Each runs the tests it
touches, `tests/ops`, `tests/db` when it adds a migration, and every test file that imports a module
it changes (`rg -l "<module path>['\"]" tests`). Implementers do not commit; the orchestrator commits
each lane by file name, with commit messages kept terse like earlier releases.

**Constraints carried from v1.58.1 and v1.63.0:** zod only from `@/lib/zod`; `'use server'` files
export only async functions, with the origin check as each action's first statement; reuse
`canActOnOwner`, `isSelfScoped`, `ownerScope`, `NOT_YOURS_ERROR`, `requireAdmin`; explicit dates in
tests; client components import nothing that reaches `@/db`; never `git stash`, `git checkout --` or
`git restore`; TypeScript 6.0.3 and Next 16 stay pinned; no new dependency unless the owner agrees;
app-only (a fix that needs compose, Docker or NAS steps is flagged with its honest size before the
plan is written).

**Review:** ONE Opus review over the whole range. Focus: every new check binds to the viewer or role
and cannot be sidestepped with another id, header or path; each lead's fix holds at its stated bound;
nothing tightened breaks the default plain-HTTP LAN install; no finding text in commits, comments or
docs reads as a recipe. Then one fix round.

**Release:** CHANGELOG `## [1.64.1]` with `### Security` lines in plain words, in the 1.58.1 style
(what the app now checks), plus an upgrade note only if operators must act. Release guard in
`tests/ops/docker.test.ts`: a `MUST-7.1: the 1.64.1 release` test in the shape of the 1.64.0 one, and
the 1.64.0 test becomes `still recorded intact`. Bump `package.json` and both `package-lock.json`
version fields; the lock must still pass `npx -y npm@10.9.9 ci`.

**Gate:** full suite `npx vitest run --no-file-parallelism`, `tsc`, a clean build (remove `.next`,
`npm run build`, check that the standalone trace still leaves out `.superpowers/`), `npm run smoke`.
Tag after `Test suite` passes and push. The next piece of work can start while GitHub builds the
image.

## Owner decisions (defaults in force unless changed)

1. **Publishing.** This plan names places that may turn out to be weak before they are confirmed.
   Default: commit it together with v1.64.1, not before. The findings themselves are never
   committed; only the fix plan (checks) and the CHANGELOG are, as in v1.58.1.
2. **Admin-supplied files.** Default: an admin is trusted, so a finding about an admin's input is
   should-fix only when it escapes the app (code, files outside `DATA_DIR`, a host the feature does
   not need) or wrecks the install, and minor otherwise. Whether restore refuses a database that
   carries objects outside the app's schema (U16.4) is decided at triage.
3. **Forced password change.** Default: a boundary for every action and route, as v1.12.1 made it
   for exports (U2.1).
4. **Settings audit trail.** Default: decide at triage from U15.3's list; no new audit actions
   unless the owner says so.
5. **A blocker found mid-audit.** Default: still one release, v1.64.1. Exception: if actor 6 can
   reach it on an internet-facing install, it ships alone as v1.64.1 straight away and the rest
   becomes v1.64.2.
6. **Fixes outside the app** (a thread-pool size, a tmpfs size, a compose change): listed with their
   honest size and deferred, per the app-only rule.
7. **Reviewers.** Four in parallel, R5 once its slot is filled; the three-reviewer fallback when
   tokens are short.
