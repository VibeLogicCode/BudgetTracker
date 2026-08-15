# Budget Tracker — Design Spec

**Date:** 2026-08-15
**Status:** Approved design, pending implementation plan
**Working name:** Budget Tracker (final name TBD by user, cosmetic only)

## 1. Overview

Self-hosted household budget tracker replacing Mint. Family members import bank CSV exports (Canadian banks), the app categorizes spending and learns vendor→category mappings from corrections, tracks monthly budgets per category, and tracks savings goals. Runs as a single Docker container on a Synology NAS (or any Docker host), LAN-only, with secure local authentication.

### Goals

- Import CSV exports from TD (debit + Visa), Scotiabank (debit), Amex Canada, and any other Canadian bank via a one-time column-mapping wizard.
- Auto-categorize transactions; learn from user corrections over time (Mint-like behavior).
- Track spend by category: monthly budgets at household level and per-person level.
- Savings goals: shared or per-person, with pace projections.
- Scalable user count: start with 1–2, grow to 4+ family members. Admin creates accounts as needed.
- Secure login (password + optional TOTP MFA) even though hosting is LAN-only.
- One-file database, trivial backups, zero cloud dependencies at runtime.

### Non-goals (v1)

- Bank API sync (Plaid/Flinks) — CSV import only, by design.
- Google/OIDC login — rejected: requires public HTTPS domain + internet at login.
- Passkeys/WebAuthn — clean v1.5 candidate, requires HTTPS on LAN; not in v1.
- Email/push notifications, receipts/attachments, investments, multi-currency (CAD integer cents only), recurring-subscription detection (v2 candidate), regex rules editor, public internet exposure, native mobile apps (responsive web instead).

## 2. Architecture

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript. Single codebase: UI, API route handlers / server actions, background jobs.
- **Database:** SQLite file at `/data/budget.db`, accessed via better-sqlite3 + Drizzle ORM. Drizzle migrations run automatically on startup.
- **UI:** Tailwind CSS, Recharts for charts. Responsive (phone/tablet/desktop browsers).
- **Runtime:** Node 22, single Docker container (multi-stage build, `node:22-alpine`, non-root user). Multi-arch: x86_64 + ARM64.
- **Scheduler:** in-process nightly job (node-cron) for backups.
- **No runtime network calls** to any external service. No telemetry.
- **Validation:** zod on all inputs (API + forms + CSV rows).

### Deployment targets

Synology Container Manager (primary), any Linux with Docker/Podman, QNAP, Unraid, TrueNAS SCALE, Raspberry Pi 4/5, Docker Desktop on Windows/Mac. Bare Node possible but Docker is the documented path.

Optional HTTPS via Synology reverse proxy; optional remote access via Tailscale. Both documented in README, neither required.

### Configuration (env vars)

- `SECRET_KEY` — required; 32+ byte random string. Used for TOTP-secret encryption (AES-256-GCM). Generated once by user at install (README shows command).
- `TZ` — timezone for date handling and nightly jobs (default `America/Toronto`).
- `PORT` — default 3000.
- `DATA_DIR` — default `/data`.

## 3. Data model

All money stored as **integer cents**, spend negative, income positive. All dates stored as ISO `YYYY-MM-DD` strings (SQLite TEXT). Timestamps as ISO datetime.

### users
`id, name, username (unique), password_hash (argon2id), role ('admin'|'member'), totp_secret_encrypted (nullable), totp_enabled (bool), is_active (bool), created_at`

- First-run setup wizard creates the first user as admin.
- Admin creates additional users (name + temporary password); user sets own password (+ optional TOTP) at first login.
- Deactivate, never delete — preserves attribution history.

### accounts
`id, name, institution, type ('chequing'|'credit'|'cash'), owner_user_id (nullable FK users), import_profile_id (nullable FK), is_active, created_at`

- `owner_user_id = NULL` means joint/household account.
- **Ownership flows account → transaction.** Personal views = transactions in accounts owned by that user. Joint-account transactions appear only in household view.
- Each user gets a personal Cash account (created on demand) for manual entries.

### import_profiles
`id, name, institution, is_builtin (bool), mapping (JSON), created_at`

`mapping` JSON fields: `hasHeader (bool), headerRows (int), dateCol, dateFormat, descCols (array, joined with space), amountMode ('signed'|'debit_credit'), amountCol / debitCol+creditCol, signConvention ('negative_is_spend'|'positive_is_spend'), skipRules (optional)`.

**Built-in presets (4):**
| Preset | Shape (best-effort default) |
|---|---|
| TD Chequing/Debit | Headerless: `MM/DD/YYYY, Description, Debit, Credit, Balance`. Debit column = money out. |
| TD Visa | Same headerless 5-column shape as TD chequing. |
| Scotiabank Chequing/Debit | Signed-amount CSV; negative = money out; description column(s) per export. |
| Amex Canada | Headered; date, description, amount; positive = charge. |

Presets are **best-effort defaults**: every first import of an account runs through the preview step, where the user confirms parsing looks right and can adjust the mapping (saved back to the profile). During implementation, presets are validated against fixture files built from the user's real exports (numbers redacted/replaced). Format drift is self-correcting via the preview step.

**New-bank wizard:** upload sample CSV → app shows first ~10 raw rows → user assigns columns (date, description, amount or debit/credit), date format, sign convention → saved as a new named profile. This is how "any Canadian lender" is supported without hardcoding.

### imports
`id, account_id, profile_id, filename, imported_by (FK users), rows_added, rows_duplicate, rows_error, created_at`

One row per import run. **Undo import** deletes all transactions with that `import_id` (and their Bayes contributions are reversed).

### transactions
`id, account_id, import_id (nullable — NULL = manual entry), date, raw_description, normalized_merchant, amount_cents, category_id (nullable), categorization_source ('rule'|'bayes'|'manual'|'none'), confidence (real, nullable), is_transfer (bool), notes (nullable), dedup_hash, created_by (FK users), created_at, updated_at`

- Unique index on `(account_id, dedup_hash)`.
- `dedup_hash = sha256(account_id | date | amount_cents | normalized_desc | occurrence_index)` where `occurrence_index` counts identical (date, amount, normalized_desc) rows *within the same file* in order — makes re-imports and overlapping exports idempotent while allowing two genuinely identical same-day purchases in one file.
- `is_transfer = true` excludes the row from all spend/income reporting.

### categories
`id, name, parent_id (nullable, max depth 2), icon, color, is_income (bool), is_archived (bool), sort_order`

Seeded on setup (editable): Income (Salary, Other Income); Housing (Rent/Mortgage, Property Tax, Home Insurance, Utilities, Internet & Phone); Food (Groceries, Restaurants, Coffee); Transport (Gas, Car Payment, Car Insurance, Maintenance, Transit, Parking); Shopping (Clothing, Electronics, General); Health (Pharmacy, Dental, Fitness); Personal (Subscriptions, Entertainment, Gifts, Travel); Kids; Fees (Bank Fees, Interest); Uncategorized. Transfers are a flag, not a category.

### merchant_rules
`id, pattern (normalized string), match_type ('exact'|'contains'), rule_kind ('category'|'transfer'), category_id (nullable — NULL for transfer rules), created_by, hit_count, last_used_at, created_at`

The learned memory. Created/updated automatically from user corrections — category corrections create category rules; transfer-flag toggles create transfer rules. Manageable in Settings (list, edit, delete).

### bayes_tokens
`token, category_id, count` (composite PK) plus a `bayes_category_totals (category_id, doc_count)` table.

### budgets
`id, scope ('household'|'personal'), user_id (nullable — required when scope='personal'), category_id, amount_cents, effective_month ('YYYY-MM'), created_at`

- A budget row applies from `effective_month` forward until a newer row exists for the same (scope, user_id, category_id). Monthly amounts therefore persist without re-entry; "copy last month" is only needed after edits.
- Household budget progress counts **all** non-transfer spend in the category. Personal budget progress counts spend in accounts owned by that user (including their cash account). Joint-account spend counts toward household budgets only.

### goals
`id, name, owner_user_id (nullable — NULL = shared), target_cents, target_date (nullable), archived, created_at`

### goal_contributions
`id, goal_id, user_id, amount_cents, date, note (nullable), created_at`

Contributions are manual log entries (money set aside), not linked to transactions in v1.

**Pace math:** saved = Σ contributions; remaining = target − saved; required monthly = remaining ÷ months until target_date; projected finish = based on average monthly contribution over trailing 3 months (or all history if < 3 months). Both shown on the goal card.

### sessions
`token_hash (PK — SHA-256 of the random 256-bit cookie token), user_id, created_at, expires_at, last_seen_at, user_agent, ip`

### login_attempts
`id, username, ip, success (bool), created_at` — rate limiting: ≥5 failures for a (username, ip) pair within 15 minutes → lockout for 15 minutes.

### settings
`key, value` — misc app settings (e.g., backup retention count).

## 4. Categorization engine ("the learning")

Runs on every imported or manually-entered transaction, and re-runs on demand.

1. **Normalize** `raw_description` → `normalized_merchant`:
   - Uppercase; collapse whitespace.
   - Strip POS/channel prefixes: `POS PURCHASE`, `PREAUTHORIZED`, `PRE-AUTH`, `CONTACTLESS`, `INTERAC PURCHASE`, `VISA DEBIT`, etc. (maintained list).
   - Strip store numbers (`#1234`, `STORE 042`), long digit/reference runs (≥5 digits), and trailing `CITY PROVINCE` tails (two-letter Canadian province codes).
2. **Exact rule match** on `normalized_merchant` → category, confidence 1.0, source `rule`.
3. **Contains rule match** (longest pattern wins) → confidence 0.9, source `rule`.
4. **Naive Bayes** over tokens of `normalized_merchant` with Laplace smoothing, trained on all confirmed (manually categorized or accepted) transactions. Assign if top category probability ≥ 0.8 **and** ≥ 2× runner-up; confidence = probability, source `bayes`.
5. Otherwise: uncategorized, source `none` → lands in Review queue.

**Transfer detection** runs before categorization: contains-match against transfer patterns (`PAYMENT - THANK YOU`, `TD VISA PAYMENT`, `AMEX PAYMENT`, `TFR-TO`, `TFR-FR`, e-transfer between own accounts, etc.) sets `is_transfer`. User can toggle any transaction's transfer flag; toggling teaches a transfer rule the same way categories do.

**Learning loop:** every manual categorization/correction (a) upserts an exact `merchant_rule` for that normalized merchant, (b) incrementally updates Bayes token counts (decrementing the old category's counts on recategorization). Bulk action in UI: "apply category to all N matching transactions + create rule."

**Review queue:** all transactions with source `none`, plus `bayes` assignments with confidence < 0.9. One-click accept (confirms Bayes guess → becomes training data + rule) or fix.

## 5. CSV import pipeline

1. Upload file (drag-drop), pick account — account remembers its profile; first time, pick preset or run wizard.
2. Parse server-side with papaparse. Handle UTF-8 BOM and windows-1252 (TD exports). Reject files > 5 MB or > 10,000 rows.
3. Apply profile mapping → candidate rows (date, description, amount_cents). Row-level errors (unparseable date/amount) collected, not fatal.
4. **Preview screen:** parsed table, duplicate rows flagged (dedup_hash already in DB), predicted category per row, error rows listed. User confirms (or adjusts mapping → re-preview).
5. Commit: insert non-duplicates, create `imports` row, run transfer detection + categorizer.
6. Result summary: "N added, M duplicates skipped, E errors, K need review" with link to Review queue.
7. **Undo import** available from import history (deletes its transactions, reverses Bayes counts).

## 6. Users, auth, security

Threat model: LAN-only app; protect against nosy guests on wifi, a stolen/lost device with a saved session, and accidental port exposure. Not defending against nation-states.

- **Passwords:** argon2id (64 MB memory, time cost 3), min length 10, no composition rules (NIST-style).
- **Sessions:** random 256-bit token in httpOnly cookie, `SameSite=Lax`, `Secure` auto-enabled when serving HTTPS; server stores SHA-256 of token; 30-day sliding expiry; "log out everywhere" per user.
- **Rate limiting:** login attempts table as above; generic error messages (no user enumeration).
- **TOTP MFA (optional per user):** otplib; QR enrollment; secret encrypted at rest (AES-256-GCM, key derived from `SECRET_KEY`); 8 single-use recovery codes shown once, stored argon2-hashed; ±1 time-step tolerance.
- **Roles:** `admin` — user management, categories, import profiles, rules, backups, all-member visibility; `member` — full household visibility, edits own transactions/budgets/goals, manages own MFA/password. (All adults can be admins; role mainly gates user management.)
- **First-run:** if `users` is empty, `/setup` wizard: create admin → seed categories → optionally create accounts. Registration closed otherwise; only admins add users.
- **Transport:** plain HTTP acceptable on trusted LAN; README documents Synology reverse-proxy HTTPS and Tailscale as recommended upgrades.
- **Headers/CSRF:** strict CSP (self-only), `X-Frame-Options: DENY`, Referrer-Policy; server actions rely on Next.js origin checking; custom API route handlers verify `Origin`/`Sec-Fetch-Site`.
- **Container hardening:** non-root user, read-only root FS except `/data`, no capabilities added.
- **Backups are unencrypted SQLite copies** (LAN-only threat model accepted); README notes Hyper Backup client-side encryption for offsite copies.

## 7. Pages / UI

| Page | Contents |
|---|---|
| Dashboard | Person scope switcher (Household / each member). Current-month category budget bars (budget vs actual), 12-month cashflow trend (income vs spend, transfers excluded), top merchants this month, goals progress cards, review-queue count badge. |
| Transactions | Paginated table; filters: account, category, person, date range, text search, uncategorized-only. Inline category editing, bulk select → categorize / mark transfer. Manual entry form (date, account, description, amount, category). |
| Review queue | Low-confidence + uncategorized list; accept / fix / bulk-apply + rule creation. |
| Import | Upload → preview → commit flow; import history with undo; new-bank mapping wizard. |
| Budgets | Month picker. Household section + per-person section: category rows with limit, spent, remaining, progress bar; add/edit limits; copy-previous-month. |
| Goals | Goal cards (owner badge: member name or Shared): saved / target, target date, required-monthly, projected finish; add contribution; archive. |
| Reports | Category breakdown (pie/bar) for arbitrary date range; month-over-month category trends; per-person spend split; CSV export of any filtered view. |
| Settings | Profile (password, TOTP). Admin: users (create/deactivate/reset password), categories manager, merchant rules manager, import profiles, backup (download now, view nightly history). |

Design language: clean, data-dense, Mint-adjacent. Dark/light per system preference. (Visual design decided at implementation time; not a spec concern beyond "responsive, accessible, charts readable".)

## 8. Backup & operations

- Nightly (02:00 local) in-process job: `VACUUM INTO '/data/backups/budget-YYYY-MM-DD.db'`; retain most recent 14 (configurable).
- Settings → "Download backup now" streams a fresh `VACUUM INTO` copy to the browser.
- Restore procedure (README): stop container → replace `/data/budget.db` with backup → start.
- Synology guidance: put `/data` on a share covered by Hyper Backup / Snapshot Replication for offsite.
- Logs to stdout (docker logs). Health endpoint `/api/health` for container healthcheck.

## 9. Repository & delivery

- Git repo in project folder. Structure: standard Next.js (`src/app`, `src/lib`, `src/db`, `src/components`), `fixtures/` for CSV test files, `docs/` for specs/plans, `Dockerfile`, `docker-compose.yml`, `README.md` (install on Synology + generic Docker, backup/restore, HTTPS/Tailscale, troubleshooting).
- `docker-compose.yml` builds from source (Synology Container Manager "Project" supports this) — no registry account needed. README also documents `docker build` on a PC + `docker save`/`load` transfer as an alternative.

## 10. Testing strategy

- **Unit (Vitest):** description normalizer; each built-in preset parser against fixture CSVs (built from user's real exports, values scrubbed); mapping wizard parser; dedup hashing (incl. same-day duplicates and re-import idempotency); categorizer rules + Bayes (train/correct/reclassify flows); transfer detection; budget effective-month resolution and scoped progress math; goal pace math; TOTP encrypt/decrypt; rate-limit lockout.
- **Integration:** full import pipeline (upload → preview → commit → undo) against a temp SQLite file; auth flows (login, lockout, TOTP enroll + login, session expiry); setup wizard.
- **Process:** TDD (superpowers workflow) during implementation. Manual QA checklist for UI flows in lieu of browser-automation suite (v1 token/effort economy); Playwright smoke tests are a v2 candidate.

## 11. v2 candidates (explicitly deferred)

Recurring-subscription detection, passkeys/WebAuthn, Playwright suite, receipt attachments, CSV export of rules/backup of learning state (rules already in DB backup), net-worth/account-balance tracking from CSV balance columns, per-category rollover budgets.
