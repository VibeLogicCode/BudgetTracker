# v1.6.0 — Per-card attribution, mapping deactivation, account-pinned mappings

Spec version 1.0, 2026-08-22. Owner-approved scope, estimated 5–7 hours.
Execute as an SDD build: ledger at `.superpowers/sdd/2026-08-22-import-attribution/progress.md`.

## 0. Why, in one paragraph each

**Per-card attribution.** A joint credit-card statement carries rows for two cardholders
(owner's real Amex: column D `Card Member` = names, column E `Account #` = card suffix
`-1001` / `-1002`). Today `commit.ts` stamps every imported row with
`attributedUserId: account.ownerUserId ?? null` — one person for the whole file — so joint
statements attribute wrongly and personal budgets/reports lie. The mapping gains an optional
`cardCol`; the account gains a card-value → person map; commit attributes per row.

**Mapping deactivation.** `import_profiles` has no way off the import picker. Built-in
presets cannot be deleted by design, so a household that does not bank with Scotia sees
Scotia forever. An `is_active` flag hides a profile (built-in or custom) from the picker
while keeping it on the managers page for reactivation. Fully reversible.

**Account-pinned mappings.** `accounts.import_profile_id` + `setAccountProfile()`
(`src/lib/import/flow.ts:65`) already remember the last successfully used profile per
account, and `import-client.tsx` preselects it. What is missing is visibility and control:
nothing shows which mapping an account is pinned to, and there is no way to set or clear it
without running an import. Surface it on Settings → Accounts.

All three share migration 0008, which is why they ship together.

## 1. Verified ground truth (do not re-derive; correct the spec in place if wrong)

Real SQLite column names (differ from Drizzle field names; verified by pragma on a live DB):

- `import_profiles(id, name, institution, is_builtin, mapping, created_at)` — NO is_active today
- `accounts(id, name, institution, type, owner_user_id, import_profile_id, is_active, created_at)`
- `imports(id, account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)`
- `users(id, name, username, password_hash, role, totp_secret_encrypted, totp_enabled, is_active, created_at, must_change_password)`
- `sessions(token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)`

Key files:

- Mapping schema: `src/lib/import/mapping.ts` (`baseSchema` fields: hasHeader, headerRows,
  dateCol, dateFormat, descCols, amountMode, amountCol, debitCol, creditCol, signConvention,
  encoding, skipRules; `importMappingSchema` superRefine; `parseImportMapping`;
  `serializeImportMapping`)
- Profiles library: `src/lib/import/presets.ts` (`listProfiles` — since v1.5.1 returns
  `mapping: ImportMapping | null` + `mappingError`, with `hasReadableMapping` guard;
  `createProfile`, `updateProfileMapping`, `deleteProfile`, `getProfileUsage`,
  `setAccountProfile` ~line 311, `forkProfileIfBuiltin`, `mappingsEqual`)
- Commit: `src/lib/import/commit.ts` (~line 145 is the attribution line; `listImportHistory`;
  undo via `transaction_imports`)
- Parse: `src/lib/import/parse.ts` (header-skip rule line ~71; `skipRules` joins ALL cells,
  lines 83–89)
- Preview: `src/lib/import/preview.ts` (`PreviewResult`, `dateFormatDetection` computed at
  ~line 119)
- Dedup: `src/lib/import/dedup.ts` — FROZEN, versioned (`DEDUP_HASH_VERSION`). Its header
  comment explains why it is independent of the evolvable merchant normalizer. Nothing in
  this feature may alter its inputs or output.
- Import UI: `src/app/(app)/import/import-client.tsx` (`AccountOption {id, name,
  importProfileId}`; preselect at line ~59 and ~266 falls back to `profiles[0]`),
  `src/app/(app)/import/page.tsx`, wizard at `src/app/(app)/import/wizard/wizard-client.tsx`
- Mapping editor: `src/components/MappingEditor.tsx` (carries the v1.5.1 date-format
  detection notices — do not disturb them)
- Managers: `src/app/(app)/settings/managers/{page.tsx, actions.ts, managers-client.tsx,
  revalidation-routes.ts}`
- Accounts settings: `src/app/(app)/settings/accounts/{page.tsx, actions.ts,
  accounts-manager.tsx}`
- Packs: `src/lib/packs.ts` (`PROFILES_PACK_FORMAT`, `parseProfilesPack`; packs carry NO
  personal data — this is a hard project rule)
- Migrations: `drizzle/0000..0007` (0007 is loans; the NEXT free index is 0008, journal idx 8); 0002/0003 are the hand-authored pattern to copy.

## 2. Requirements

### Migration (Task 1)

- MUST-1.1 Migration `0008` adds `is_active INTEGER NOT NULL DEFAULT 1` to
  `import_profiles`, and creates `account_card_people(id INTEGER PK, account_id INTEGER NOT
  NULL REFERENCES accounts(id), card_value TEXT NOT NULL, user_id INTEGER NOT NULL
  REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(account_id, card_value))`.
  Hand-authored in the 0002/0003 style; `src/db/schema.ts` updated to match; journal updated.
- MUST-1.2 A v1.5.x database (no 0008) boots and migrates cleanly, and a restored pre-0008
  backup does the same through the existing boot-apply path. Follow the existing
  migration/restore test patterns.
- MUST-1.3 No other schema change. `amount_cents` immutability and dedup columns untouched.

### Mapping gains cardCol (Task 2)

- MUST-2.1 `baseSchema` gains `cardCol: z.number().int().min(0).max(200).nullable()`
  **with a parse-time default of null for absent input** (`.nullable().default(null)` or
  equivalent). CRITICAL back-compat: every mapping JSON stored by ≤1.5.1 lacks `cardCol` and
  MUST still parse. v1.5.1 just shipped "unreadable mapping" handling — a required field here
  would flip every existing profile to unreadable. Test: a verbatim 1.5.x mapping JSON parses
  with `cardCol: null`.
- MUST-2.2 `serializeImportMapping` includes `cardCol`. `mappingsEqual`/`forkProfileIfBuiltin`
  must still see an unchanged old mapping as equal to itself after round-tripping (both sides
  pass through the schema, so both get `cardCol: null` — prove it with a test, don't assume).
- MUST-2.3 `MappingEditor` gains an optional "Cardholder column" select (column index or
  "none"), same visual conventions as the existing column selects. The v1.5.1 date-format
  detection notices are byte-untouched. The wizard's mapping editor path gets it too.
- MUST-2.4 Card values normalize as: trim, collapse internal runs of whitespace to one
  space, uppercase. One exported `normalizeCardValue()` in the import lib, used by every
  reader and writer of `account_card_people.card_value`. (The owner's Amex has both a
  `Card Member` name column and an `Account #` suffix column; either works, the docs example
  should recommend the suffix column as the stabler key.)

### Card-value → person map (Task 3)

- MUST-3.1 Library functions in `src/lib/import/` (new file or presets.ts, implementer's
  call): list assignments for an account, upsert one (`account_id + normalized value →
  user_id`), delete one. Values stored normalized. Person must be an existing user;
  assignments to since-deactivated users remain valid and resolvable for display.
- MUST-3.2 Packs never carry `account_card_people` rows. `cardCol` travels inside the
  mapping JSON automatically and that is correct (it is a file-format fact, not a person).
  Test asserts a profiles-pack export of a profile whose mapping has `cardCol` set contains
  the field but no card assignments, no user ids, no card values.

### Commit attribution (Task 3)

- MUST-3.3 In `commit.ts`, per row: if `mapping.cardCol` is null → today's behaviour
  byte-identical (`account.ownerUserId ?? null`). Else `value =
  normalizeCardValue(cells[cardCol] ?? '')`; empty value or index beyond the row's cells →
  fallback to owner; value found in the account's map → that person; value not in the map →
  fallback to owner.
- MUST-3.4 THE DEDUP HASH DOES NOT CHANGE. Test: the same staged file committed under the
  same mapping with and without `cardCol` produces identical `dedup_hash` values, and
  `DEDUP_HASH_VERSION` is untouched (assert the constant's value).
- MUST-3.5 Undo-import is unaffected (it keys off `transaction_imports`); the integration
  test in Task 6 proves undo after a per-card import.
- SHOULD-3.6 The commit result message reports the attribution split (e.g. "8 rows to
  Alex, 5 to Sam, 2 to the account owner (no card match)") so a wrong map is visible
  immediately.

### Deactivation (Task 4)

- MUST-4.1 `listProfiles` exposes `isActive`. The import picker (`import/page.tsx` →
  `import-client.tsx`) and the wizard's profile offerings filter to active AND readable
  (`hasReadableMapping`). The managers page lists ALL profiles with an inactive badge and an
  activate/deactivate toggle.
- MUST-4.2 Deactivation works on built-in profiles (that is the point — it is the only way
  to get an unused bank preset off the picker). `deleteProfile`'s built-in refusal is
  unchanged.
- MUST-4.3 Deactivating a profile that accounts are pinned to warns first with the real
  count (reuse the `getProfileUsage` read-path pattern). If confirmed, the pins REMAIN in
  the database, dormant: while inactive, the import picker treats those accounts as
  unpinned; on reactivation the pins resume working with no further action. Nothing is
  nulled. Test both directions.
- MUST-4.4 Server actions follow the managers actions.ts shape (`isSameOrigin` →
  `requireAdmin` → validate → act → `revalidatePath`). Revalidate every route that renders
  profile lists: `/settings/managers`, `/import`, `/import/wizard`, `/settings/accounts`.
  Any shared constant lives in `revalidation-routes.ts` or a lib file — **NEVER in a
  'use server' file**. `tests/ops/use-server-exports.test.ts` enforces this; it exists
  because v1.5.0 shipped exactly that mistake and the entire managers page 500ed in
  production while build and suite stayed green.

### Account-pinned mapping surfacing (Task 5)

- MUST-5.1 Settings → Accounts shows each CSV-importable account's pinned mapping by name
  (or "none"), with a select to set or clear it offering only active+readable profiles.
  Follow `accounts/actions.ts` conventions.
- MUST-5.2 `import-client.tsx` preselect honors the pin only when that profile is in the
  offered (active+readable) list; otherwise it behaves exactly as an unpinned account does
  today. No other change to the import flow's remembering behaviour (`setAccountProfile`
  after successful commit stays).

### Preview assignment UI (Task 6)

- MUST-6.1 When the selected mapping has a `cardCol`, `PreviewResult` gains the distinct
  normalized card values of the parsed file with row counts, and the preview screen lists
  them with a person select each (active users + "account owner (default)"). Saving writes
  `account_card_people` via a server action immediately (assignments are account facts and
  survive an abandoned import). When `cardCol` is null, the preview is byte-identical to
  today.
- MUST-6.2 Values already assigned show their person preselected. An unassigned value is
  allowed at commit (falls back to owner) — the UI says so rather than blocking.
- MUST-6.3 Integration test: stage a two-card CSV shaped like the owner's Amex (a Card
  Member name column AND an Account # suffix column), map `cardCol` to the suffix column,
  assign both suffixes, commit, assert per-row `attributed_user_id`; then undo; then
  re-import the same file and assert full dedup. Scope note: the wizard sets `cardCol` but
  the assignment UI lives only on the main import preview this release.

### Release (Task 7)

- MUST-7.1 Version 1.6.0. CHANGELOG section dated on the actual ship day, written like a
  human, NO em dashes, no OCR-engine names (docker.test.ts asserts this). Move the
  `tests/ops/docker.test.ts` version-pin tripwire to 1.6.0. Check README/INSTALL for import
  docs worth touching.
- MUST-7.2 Full gates: `npx vitest run --no-file-parallelism` (bare runs can exit 1 from a
  worker-teardown flake AFTER all tests pass — check which before believing a failure),
  `npx tsc --noEmit`, `npm run build` (an `EINVAL readlink` on `.next/` is OneDrive syncing:
  `rm -rf .next`, rebuild), `node scripts/check-ocr-assets.mjs`.
- MUST-7.3 Runtime smoke against the REAL standalone server, because this class of defect is
  invisible to vitest and next build: `npm run build`, then `node .next/standalone/server.js`
  with `DATA_DIR` pointed at a scratch dir, seed via raw better-sqlite3 SQL (the `@/` alias
  does not resolve outside the bundler; the real column names are in §1; password
  `argon2.hash(pw, {type: argon2.argon2id})`; session cookie `bt_session`, stored
  `token_hash` = sha256 hex of a `randomBytes(32).toString('base64url')` token), and GET
  `/settings/managers`, `/settings/accounts`, `/import` expecting 200s. v1.5.1's lesson:
  `next start` does NOT enforce 'use server' semantics — only the standalone server does.
- MUST-7.4 Do NOT tag, do NOT push. Report done and stop; the owner triggers tag/push.

## 3. Process instructions (controller = Opus, implementers = Sonnet)

1. **Models.** Controller and the final review run on Opus. All implementation tasks run on
   Sonnet (owner token ruling, standing since v1.4.0). No per-task review agents: each
   implementer self-verifies with targeted vitest + `tsc --noEmit`; one Opus whole-branch
   review runs after Task 7 and before reporting done.
2. **One committing implementer at a time.** Three agents collided on the git index on
   2026-08-22 (a broad `git add` swept two other agents' staged files; the recovery
   un-committed a third's work). Explicit pathspecs are necessary but NOT sufficient.
   Serialize commits or use isolated worktrees.
3. **Commits.** One per task, explicit pathspecs only (never `git add -A` / `git add .`),
   conventional messages with real bodies. **NO attribution footers of any kind — no
   Co-Authored-By, no Claude or AI mention anywhere in any commit message.** Firm standing
   owner order. Identity is the repo-configured VibeLogicCode.
4. **TDD.** Failing test first, then implementation, per task. No knowingly-vacuous tests;
   a test that cannot run on Windows reports as skipped, never as a silent green.
5. **Task order.** 1 (migration) → 2 (mapping) → 3 (map lib + commit) → 4 (deactivation)
   → 5 (account pin UI) → 6 (preview + integration) → 7 (release). 4 and 5 may build in
   parallel but commit serially.
6. **Ledger.** Append per-task state (commit SHA, test counts, deviations with reasons) to
   `.superpowers/sdd/2026-08-22-import-attribution/progress.md` as tasks land. Read
   `.superpowers/sdd/2026-08-18-ocr-engine-swap/progress.md` first for the standing rulings
   and postmortems this spec cites.
7. **The two untouchables.** The dedup hash (`src/lib/import/dedup.ts`, frozen + versioned)
   and the profile-pack no-personal-data rule. A change to either is a stop-and-ask, not a
   judgment call.
8. **Final review mandate.** Every release of this project to date had its ship-blocker
   caught by the final whole-branch review, always at a cross-task seam, never by the
   per-task gates. The Opus review examines the seams: migration × restore, cardCol ×
   pack export, deactivation × pinned accounts, attribution × dedup, and every new server
   action file against the 'use server' guard. Fix wave, re-gate, then stop for the owner.
