# Kids' scope, ownership and the household features — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A child on this install sees only their own money, nobody can delete another member's
records unrecorded, and the household gains the nine features the 2026-08-27 review found missing —
insights on screen, quick-add, notes, per-account stale alerts, a bill→transaction button, three more
bank presets plus OFX/QFX, savings and asset accounts, and a sinking-fund line.

**Architecture:** One new column, `users.visibility`, turns the session user into a **viewer**, and
six query chokepoints take that viewer as a required trailing parameter. Ownership checks
(`canActOnOwner`) land on four destructive paths regardless of visibility and write to a new
append-only `audit_log`. Everything else is a reader or a small form over machinery that already
exists. Migration 0013 is additive — five `ALTER TABLE ADD COLUMN`s, one `CREATE TABLE`, two indexes,
**no table rebuild**.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript 6.0.3, Drizzle ORM over better-sqlite3
(SQLite 3.53), Tailwind 4, Vitest 3 + `@testing-library/react` + jsdom (per-file
`// @vitest-environment jsdom`; the suite default is `node`).

**Spec:** `docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md` — read it
first. Rulings **R1–R16** (owner) and **M1–M9** (planner) are binding and this plan cites them by
number throughout.

**Built after v1.12.1.** That release ships in parallel and is a prerequisite for three things named
below: `drizzle/0012_totp_last_counter.sql` (so this migration may take the number 13), try/catch +
resync in `src/components/ui/AutoSave.tsx`, and confirm dialogs on destructive kebab items. If the
tree does not contain `drizzle/0012_totp_last_counter.sql` when Task 1 starts, **stop and report it**
— do not take the number.

## Standing implementer rules

Every task's requirements implicitly include this block, verbatim:

> Never run `git stash`. Never override git identity or add Co-Authored-By. Run vitest in the
> foreground with a 600000 ms timeout; never in the background. Never open `.tmp-data/budget.db`.
> Never write the owner's name, employer, email or Windows paths into any file. Next dev server may
> drop `AGENTS.md`/`CLAUDE.md` at repo root — delete, never commit. Local vitest may exit 1 with all
> tests passing (worker RPC teardown) — read the pass/fail counts, not the exit code.

## Global Constraints

- **Integer cents only.** Every amount is an `integer` column and a `number` of cents in TypeScript.
  `parseAmountToCents` (`src/lib/money.ts:11`) is the one parser and `formatCents` (`src/lib/money.ts:50`)
  the one formatter. No floats, no `parseFloat`, no currency strings in the database.
- **ISO date strings.** `YYYY-MM-DD` validated by `isIsoDate` (`src/lib/dates.ts:143`); timestamps
  from `nowIso()`. Date arithmetic goes through `addDaysIso` / `daysBetweenIso`
  (`src/lib/dates.ts:223`, `:230`). No `new Date()` inside a `src/lib/**` function — `today` is
  always a parameter (the project-wide v1.4.0 clock-free rule).
- **The viewer parameter is REQUIRED, never optional.** An optional `viewer?` lets a forgotten call
  site compile into a silent leak. The compiler naming every call site is the enforcement mechanism.
- **`0013_household_scope.sql` is the ONLY migration in this release, and it rebuilds nothing.**
  `accounts.type` has never carried a SQL CHECK (`drizzle/0000_init.sql:55-64`), so widening it to
  five values is a TypeScript-and-zod change with zero DDL (spec micro-ruling M2). No shipped `.sql`
  file is edited. No `PRAGMA` goes inside the `.sql` — `src/db/client.ts:51-68` already handles it.
- **No new npm dependencies** (R16). No XML parser, no date library, no menu library. The OFX reader
  is written in-repo.
- **PUBLIC REPO.** No owner name, employer name, email, absolute Windows path, real merchant string
  or real statement value in any file — comments and fixtures included. Use generic fixtures:
  `'Chequing'`, `'GROCERY STORE'`, `'CITY TAX OFFICE'`, `'PAYROLL DEPOSIT'`, `'Property tax'`,
  `'user-1'`.
- **`real-statements/` is read-only reference and git-ignored.** You may read a header row from it.
  Never copy a value row, an account number or a merchant name into any tracked file.
- **Conventional commits** (`feat:` / `fix:` / `test:` / `docs:` / `refactor:`). **NEVER add a
  `Co-Authored-By` line or any Claude/AI attribution line.**
- **Run only your own test files** (`npx vitest run <paths> --reporter=dot`) until Task 15, which is
  the first task that runs the whole suite.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that say *why*. A
  comment arguing for behaviour the code no longer has is worse than no comment.
- TDD: write the failing test, run it and watch it fail, implement the minimum, watch it pass, commit.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `drizzle/0013_household_scope.sql` | five ADD COLUMNs, `audit_log`, two indexes | T1 |
| `drizzle/meta/_journal.json` | the idx-13 entry | T1 |
| `src/db/schema.ts` | four column mirrors, `auditLog`, the widened `accounts.type` enum | T1 |
| `tests/db/migration-0013.test.ts` | the columns exist, the CHECKs bite, the defaults land | T1 |
| `src/lib/auth/viewer.ts` | `Viewer`, `ownerScope`, `isSelfScoped`, `canActOnOwner`, `NOT_YOURS_ERROR` | T2 |
| `src/lib/auth/session.ts` | `SessionUser.visibility`; `validateSession` refuses `canSignIn: false` | T2 |
| `src/lib/auth/users.ts` | three flags on `UserRecord`; the person-without-login writers | T2 |
| `src/lib/auth/login.ts` | `attemptLogin` refuses `canSignIn: false` | T2 |
| `src/lib/audit.ts` | `appendAudit`, `listAudit` | T2 |
| `src/lib/transactions.ts` | viewer chokepoint; notes in the search `OR` | T3 |
| `src/lib/accounts.ts`, `src/lib/networth.ts`, `src/lib/goals.ts`, `src/lib/loans.ts` | four viewer chokepoints; the five account types | T4 |
| `src/lib/warranty/items.ts`, `search.ts`, `installments.ts` | viewer chokepoint; `recordInstallmentPayment`; `budgetCategoryId` | T5 |
| `src/lib/reports.ts` | viewer chokepoint on seven aggregates | T6 |
| `src/lib/bills.ts`, `src/lib/budgets.ts`, `src/lib/insights.ts` | scoped bills, `sinkingFundsFor`, the insights reader | T7 |
| `src/lib/categorize/rules.ts`, `engine.ts`, `src/lib/notify/evaluate/stale.ts`, `src/lib/notify/events.ts` | rule ownership (AH); stale-per-account (AM) | T8 |
| `src/lib/import/ofx.ts`, `parse.ts`, `presets.ts`, `flow.ts`, `mapping.ts` | the OFX reader; three UNVERIFIED presets | T9 |
| `src/app/(app)/transactions/*`, `src/components/QuickAddTransaction.tsx`, `src/app/manifest.ts` | quick-add, "Note…", the shortcut | T10 |
| `src/app/(app)/bills/actions.ts`, `src/components/ComingUpCard.tsx`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` | the Record-payment button, both surfaces | T11 |
| `src/app/(app)/warranties/{actions.ts,page.tsx,[id]/page.tsx}`, `src/app/api/warranties/receipts/[id]/route.ts`, `src/app/api/import/undo/route.ts` | ownership gates + audit writes | T12 |
| `src/app/(app)/dashboard/page.tsx`, `src/components/NeedsALookCard.tsx`, `src/app/(app)/budgets/*`, `src/app/(app)/reports/*` | the self dashboard, the insights card, the sinking-fund line | T13 |
| `src/app/(app)/settings/users/*`, `src/app/(app)/settings/audit/page.tsx`, `src/components/app-shell/nav.ts`, `src/app/(app)/{goals,review,import,settings/accounts}/*` | admin controls, audit page, nav filter, remaining wiring | T14 |
| `src/app/(app)/help/content.tsx`, `INSTALL.md`, `docs/PENDING-FIXES.md`, `tests/ops/visibility-invariants.test.ts` | docs, the ops guard, full verification, Playwright | T15 |
| `CHANGELOG.md`, `package.json`, `tests/ops/docker.test.ts` | v1.13.0 | T16 |

**Explicitly out of scope** — do not add any of these while you are in the file: a household/tenant
id (R1), an allowance or chore subsystem (R12), a recurring/scheduled-transaction generator (R8), a
per-category monthly sinking-fund target (R11), envelope budgeting, a per-user data export or user
deletion (item AS is DROPPED), a third role, a full-text index on transactions (R13), a new
notification event id (R14), any new npm dependency (R16).

## Wave map

| Wave | Tasks | Parallel? |
|---|---|---|
| **A** | T1 → T2 | **Alone.** Everything consumes it. Disjoint files, but T2's tests need T1's migration, so run T1 first. |
| **B** | T3, T4, T5, T6, T7, T8, T9 | Fully parallel — disjoint file sets, all seven consume Wave A only. |
| **C** | T10, T11, T12, T13, T14 | Fully parallel — disjoint file sets, all five consume Waves A+B only. |
| **D** | T15 → T16 | Sequential. T15 is the full suite, typecheck, build and browser check; T16 is the release commit. **No tag, no push.** |

Wave-disjointness was verified file by file in this plan's self-review; the per-wave file sets are
listed at the end.

---

# Wave A — the foundation

### Task 1: migration 0013, the journal entry, and the schema mirror

**Files:**
- Create: `drizzle/0013_household_scope.sql`
- Modify: `drizzle/meta/_journal.json` (append one entry after the `0012` one)
- Modify: `src/db/schema.ts:12-31` (users), `:79-92` (accounts type enum), the `merchantRules` table,
  the `warrantyItems` table, and the end of the file (new `auditLog`)
- Create: `tests/db/migration-0013.test.ts`

**Interfaces:**
- Consumes: nothing. This is the first task.
- Produces: the Drizzle tables `users` (with `visibility: 'household' | 'self'`,
  `canSignIn: boolean`, `lastAccountId: number | null`), `merchantRules.lastModifiedBy: number | null`,
  `warrantyItems.budgetCategoryId: number | null`, `accounts.type` widened to
  `'chequing' | 'credit' | 'cash' | 'savings' | 'asset'`, and:
  ```ts
  export const auditLog: SQLiteTable; // columns: id, at, userId, action, entity, entityId, detail
  ```

- [ ] **Step 1: Confirm 0012 exists, then write the failing migration test.**

First run `ls drizzle/*.sql`. If `drizzle/0012_totp_last_counter.sql` is absent, **stop and report
it** — v1.12.1 owns that number and this plan must not take it.

Create `tests/db/migration-0013.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getSqlite } from '@/db/client';
import { resetTestDb } from '../helpers/db';

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(table: string): Map<string, ColumnInfo> {
  const rows = getSqlite().pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

describe('drizzle/0013_household_scope.sql', () => {
  beforeEach(() => {
    resetTestDb();
  });

  it('adds visibility, can_sign_in and last_account_id to users with the documented defaults', () => {
    const cols = columns('users');
    expect(cols.get('visibility')?.notnull).toBe(1);
    expect(cols.get('visibility')?.dflt_value).toBe("'household'");
    expect(cols.get('can_sign_in')?.notnull).toBe(1);
    expect(cols.get('can_sign_in')?.dflt_value).toBe('1');
    expect(cols.has('last_account_id')).toBe(true);
    expect(cols.get('last_account_id')?.notnull).toBe(0);
  });

  it('a pre-existing row receives the defaults, so both CHECKs hold by construction', () => {
    const db = getSqlite();
    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    const row = db.prepare('select visibility, can_sign_in, last_account_id from users').get() as {
      visibility: string; can_sign_in: number; last_account_id: number | null;
    };
    expect(row).toEqual({ visibility: 'household', can_sign_in: 1, last_account_id: null });
  });

  it('the visibility CHECK refuses a third value', () => {
    const db = getSqlite();
    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    expect(() => db.prepare(`update users set visibility = 'guest'`).run()).toThrow(/CHECK/i);
  });

  it('adds merchant_rules.last_modified_by and warranty_items.budget_category_id', () => {
    expect(columns('merchant_rules').has('last_modified_by')).toBe(true);
    expect(columns('warranty_items').has('budget_category_id')).toBe(true);
  });

  it('creates audit_log with its two indexes and a length CHECK, not a value enum', () => {
    const db = getSqlite();
    const cols = columns('audit_log');
    expect([...cols.keys()]).toEqual(['id', 'at', 'user_id', 'action', 'entity', 'entity_id', 'detail']);
    const indexes = (db.pragma('index_list(audit_log)') as { name: string }[]).map((row) => row.name);
    expect(indexes).toContain('audit_log_at_idx');
    expect(indexes).toContain('audit_log_entity_idx');

    db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Person One', 'user-1', 'x', 'member', 0, 1, '2026-08-27T00:00:00.000Z')`,
    ).run();
    // A value this release does not know about is accepted -- a future audited action must never
    // need a migration (spec, Data model note 2).
    expect(() =>
      db
        .prepare(`insert into audit_log (at, user_id, action, entity, entity_id) values (?, 1, 'future_action', 'accounts', 7)`)
        .run('2026-08-27T00:00:00.000Z'),
    ).not.toThrow();
    // An empty action is refused by the length CHECK.
    expect(() =>
      db
        .prepare(`insert into audit_log (at, user_id, action, entity, entity_id) values (?, 1, '   ', 'accounts', 7)`)
        .run('2026-08-27T00:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it('accounts.type still carries no SQL CHECK, which is why widening it needed no migration', () => {
    const sql = (getSqlite()
      .prepare(`select sql from sqlite_master where type = 'table' and name = 'accounts'`)
      .get() as { sql: string }).sql;
    expect(sql).not.toMatch(/CHECK/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/db/migration-0013.test.ts --reporter=dot`
Expected: FAIL — `no such column: visibility` / `no such table: audit_log`.

- [ ] **Step 3: Write the migration.**

Create `drizzle/0013_household_scope.sql`. Its header follows 0011's shape: the warning about
hand-authoring, the separator warning (never write the breakpoint marker inside a comment), the
reason for each statement, and the numbered inventory of SQL-only objects continued from 31 to 37.
Copy 0011's first two header paragraphs verbatim, then:

```sql
-- Kids' scope, ownership and the household features
-- (spec docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md, v1.13.0).
--
-- ADDITIVE ONLY. Five ALTER TABLE ADD COLUMNs, one CREATE TABLE, two indexes. There is NO table
-- rebuild in this file, and that is deliberate:
--
--   accounts.type is widened from three values to five ('savings' and 'asset', ruling R10) with NO
--   DDL AT ALL, because that column has never carried a CHECK. drizzle/0000_init.sql declares it as
--   `type` text NOT NULL and no migration since has touched it -- the three-value enum lives only in
--   src/db/schema.ts's Drizzle definition and in the zod schema in src/lib/accounts.ts. Rebuilding
--   accounts to ADD a CHECK was considered and rejected: six tables carry foreign keys into it
--   (transactions, imports, account_card_people, simplefin_account_links, account_balance_snapshots,
--   loan_matcher_rules), which would make the safest change in this release the riskiest one, for a
--   constraint the app already enforces at two boundaries. Planner micro-ruling M2.
--
-- THE FOREIGN-KEY PRAGMA IS NOT IN THIS FILE, ON PURPOSE -- see 0011's header. src/db/client.ts's
-- openDatabase() disables foreign keys around the whole migration pass and re-enables them (plus a
-- foreign_key_check) immediately after. Do not put a pragma here.
--
-- THE THREE ADDED CHECKS ARE FORWARD-ONLY. SQLite's ALTER TABLE ADD COLUMN does not re-validate
-- existing rows against a CHECK added that way -- the same fact drizzle/0007_loans.sql's header
-- records. Harmless here precisely because these are NEW columns: every pre-existing row takes the
-- DEFAULT, which satisfies both users CHECKs by construction. The cross-column rule that visibility
-- 'self' and role 'admin' are mutually exclusive is therefore NOT attempted in SQL at all; it lives
-- in setUserVisibility() beside assertBalanceAnchorPairing's precedent (micro-ruling M1).
--
-- audit_log.action and .entity carry a LENGTH check and never a value enum: an enum CHECK would make
-- every future audited operation a table rebuild, and ruling R3 says keep it small. audit_log has no
-- ON DELETE for the same reason src/lib/auth/users.ts:186 gives -- this project deactivates users and
-- never deletes them, so user_id cannot dangle.
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after this migration
-- (entries 1-31 are restated verbatim from drizzle/0011_bill_installments.sql's header; 0012 adds
-- none -- a plain ALTER TABLE users ADD COLUMN totp_last_counter integer with no constraint):
--   [restate 1-31 from 0011 here, unchanged]
--  32. the visibility CHECK on users, and the column arriving by ALTER TABLE ADD COLUMN  (0013)
--  33. the can_sign_in CHECK on users, and the column arriving by ALTER TABLE ADD COLUMN  (0013)
--  34. users.last_account_id arriving by ALTER TABLE ADD COLUMN                           (0013)
--  35. merchant_rules.last_modified_by arriving by ALTER TABLE ADD COLUMN                 (0013)
--  36. warranty_items.budget_category_id arriving by ALTER TABLE ADD COLUMN               (0013)
--  37. both CHECK constraints on audit_log                                                (0013)
--
-- audit_log_at_idx and audit_log_entity_idx are plain indexes and ARE mirrored in src/db/schema.ts,
-- so they do not appear in the list above -- the same rule bill_installments_txn_uq follows.
ALTER TABLE `users` ADD COLUMN `visibility` text NOT NULL DEFAULT 'household' CHECK (`visibility` IN ('household', 'self'));
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `can_sign_in` integer NOT NULL DEFAULT 1 CHECK (`can_sign_in` IN (0, 1));
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `last_account_id` integer REFERENCES `accounts`(`id`);
--> statement-breakpoint
ALTER TABLE `merchant_rules` ADD COLUMN `last_modified_by` integer REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `warranty_items` ADD COLUMN `budget_category_id` integer REFERENCES `categories`(`id`);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`),
	`action` text NOT NULL CHECK (length(trim(`action`)) BETWEEN 1 AND 40),
	`entity` text NOT NULL CHECK (length(trim(`entity`)) BETWEEN 1 AND 40),
	`entity_id` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`, `entity_id`);
```

Append to `drizzle/meta/_journal.json`'s `entries` array, after the `0012` object:

```json
    {
      "idx": 13,
      "version": "6",
      "when": 1756339200000,
      "tag": "0013_household_scope",
      "breakpoints": true
    }
```

- [ ] **Step 4: Mirror it in `src/db/schema.ts`.**

Append to the `users` column object, after `mustChangePassword` and after v1.12.1's
`totpLastCounter` (the ALTER-TABLE-ADD-COLUMN-appends-physically convention this file documents):

```ts
    /**
     * v1.13.0 ruling R2, added by drizzle/0013_household_scope.sql. 'self' scopes every read this
     * person makes to rows they own. This is a READER boundary, not a role: role still gates actions.
     * Micro-ruling M1: 'self' and role 'admin' are mutually exclusive, enforced in
     * setUserVisibility()/createUserAction rather than as a SQL CHECK, because a cross-column CHECK
     * added by ALTER TABLE ADD COLUMN does not re-validate existing rows.
     */
    visibility: text('visibility', { enum: ['household', 'self'] }).notNull().default('household'),
    /**
     * v1.13.0 ruling R5. false = a person the money is attributed to who has no login: they appear in
     * every attribution picker and never on the login path. attemptLogin refuses them before the
     * password check, and validateSession refuses an existing session.
     */
    canSignIn: integer('can_sign_in', { mode: 'boolean' }).notNull().default(true),
    /**
     * v1.13.0 ruling R7 / micro-ruling M5: the account this person last posted a manual transaction
     * to, so quick-add can default to it. No onDelete clause -- NO ACTION matches imports.account_id
     * and account_card_people.account_id, and accounts are soft-deleted via is_active, never dropped.
     */
    lastAccountId: integer('last_account_id').references(() => accounts.id),
```

Widen `accounts.type` and rewrite its neighbours' understanding of it:

```ts
    /**
     * v1.13.0 ruling R10: five values, up from three. This column has NEVER carried a SQL CHECK --
     * drizzle/0000_init.sql:59 declares it as plain `type` text NOT NULL -- so the enum is a
     * TypeScript-and-zod construct only and widening it needed no migration at all (micro-ruling M2).
     * Do not go looking for the rebuild; there isn't one. 'savings' behaves like 'chequing' but is
     * excluded from safe-to-spend; 'asset' carries a manually-typed balance and takes no transactions
     * and no imports (src/lib/accounts.ts, acceptsTransactions/countsTowardSafeToSpend).
     */
    type: text('type', { enum: ['chequing', 'credit', 'cash', 'savings', 'asset'] }).notNull(),
```

Append to `merchantRules`:

```ts
    /**
     * v1.13.0 ruling R4 (item AH / SEC-6). created_by is no longer overwritten on conflict; this
     * records who last changed the rule instead. NULL on every row written before v1.13.0 and on any
     * rule never edited since it was created.
     */
    lastModifiedBy: integer('last_modified_by').references(() => users.id),
```

Append to `warrantyItems`:

```ts
    /**
     * v1.13.0 ruling R11 (item AQ), micro-ruling M9. Bill-kind items only: the budget category this
     * bill accumulates against, so the budgets row can say what it is saving toward. A read-side link
     * and nothing else -- it changes no limit, no rollover and no total. NULL means "not linked",
     * which is every row before v1.13.0.
     */
    budgetCategoryId: integer('budget_category_id').references(() => categories.id),
```

Add the new table at the end of the file:

```ts
/**
 * v1.13.0 ruling R3. Append-only. Nothing in src/ updates or deletes a row here; the only writer is
 * appendAudit() in src/lib/audit.ts and the only reader is the admin page at /settings/audit.
 * `action` and `entity` carry a LENGTH check in SQL and never a value enum, so a future audited
 * operation is a code change and not a migration.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO timestamp from nowIso(). */
    at: text('at').notNull(),
    userId: integer('user_id').notNull().references(() => users.id),
    /** 'delete_item' | 'delete_receipt' | 'undo_import' today. Free text by design. */
    action: text('action').notNull(),
    /** The table entity_id belongs to: 'warranty_items' | 'warranty_receipts' | 'imports'. */
    entity: text('entity').notNull(),
    entityId: integer('entity_id').notNull(),
    /** One short human sentence, or NULL. Never a payload dump and never a secret. */
    detail: text('detail'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_entity_idx').on(t.entity, t.entityId)],
);
```

- [ ] **Step 5: Run the test and watch it pass.**

Run: `npx vitest run tests/db/migration-0013.test.ts --reporter=dot`
Expected: PASS, 6 tests.

Then run the existing schema/migration suite so the mirror is confirmed against every other table:
Run: `npx vitest run tests/db --reporter=dot`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add drizzle/0013_household_scope.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/migration-0013.test.ts
git commit -m "feat(db): migration 0013 -- visibility, can_sign_in, audit_log, five account types"
```

---

### Task 2: the viewer, the session, people without a login, and the audit writer

**Files:**
- Create: `src/lib/auth/viewer.ts`
- Create: `src/lib/audit.ts`
- Modify: `src/lib/auth/session.ts:13-18` (`SessionUser`), `:55-92` (`validateSession`)
- Modify: `src/lib/auth/users.ts:8-18` (`UserRecord`), `:35-40` (schemas), `:41-50` (`PUBLIC_COLUMNS`),
  `:68-70` (`listUsers`), and the end of the file (new writers)
- Modify: `src/lib/auth/login.ts:69` (the inactive branch)
- Create: `tests/lib/auth/viewer.test.ts`, `tests/lib/audit.test.ts`
- Modify: `tests/lib/auth/users.test.ts`, `tests/lib/auth/login.test.ts`, `tests/lib/auth/session.test.ts`

**Interfaces:**
- Consumes: `users`, `auditLog` from `@/db/schema` (Task 1).
- Produces:
  ```ts
  // src/lib/auth/viewer.ts
  export interface Viewer { id: number; role: 'admin' | 'member'; visibility: 'household' | 'self' }
  export function ownerScope(viewer: Viewer): number | null;
  export function isSelfScoped(viewer: Viewer): boolean;
  export function canActOnOwner(ownerUserId: number | null, viewer: Viewer): boolean;
  export const NOT_YOURS_ERROR: string;

  // src/lib/auth/session.ts -- SessionUser gains `visibility: 'household' | 'self'`
  // and therefore satisfies Viewer structurally.

  // src/lib/auth/users.ts
  export interface UserRecord { /* … */ visibility: 'household' | 'self'; canSignIn: boolean; lastAccountId: number | null }
  export const createPersonSchema: z.ZodType<{ name: string; username: string }>;
  export function createPersonWithoutLogin(input: { name: string; username: string }): Promise<UserRecord>;
  export function setUserVisibility(userId: number, visibility: 'household' | 'self'): void;
  export function setUserCanSignIn(userId: number, canSignIn: boolean): void;
  export function setLastAccountId(userId: number, accountId: number | null): void;
  export function listAttributablePeople(): UserRecord[];

  // src/lib/audit.ts
  export type AuditAction = 'delete_item' | 'delete_receipt' | 'undo_import';
  export function appendAudit(input: { userId: number; action: AuditAction; entity: string; entityId: number; detail?: string | null; at?: string }): number;
  export interface AuditRow { id: number; at: string; userId: number; userName: string; action: string; entity: string; entityId: number; detail: string | null }
  export function listAudit(limit?: number): AuditRow[];
  ```

- [ ] **Step 1: Write the failing viewer test.**

Create `tests/lib/auth/viewer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canActOnOwner, isSelfScoped, ownerScope, NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';

const household: Viewer = { id: 2, role: 'member', visibility: 'household' };
const child: Viewer = { id: 5, role: 'member', visibility: 'self' };
const admin: Viewer = { id: 1, role: 'admin', visibility: 'household' };
/** Unreachable through the UI (micro-ruling M1) -- pinned so a hand-edited row cannot lock an admin out. */
const adminSelf: Viewer = { id: 1, role: 'admin', visibility: 'self' };

describe('ownerScope (ruling R2)', () => {
  it('is null for a household member and for an admin', () => {
    expect(ownerScope(household)).toBeNull();
    expect(ownerScope(admin)).toBeNull();
  });

  it('is the viewer id for a self-scoped member', () => {
    expect(ownerScope(child)).toBe(5);
  });

  it('is null for an admin even when the row says self (micro-ruling M1)', () => {
    expect(ownerScope(adminSelf)).toBeNull();
  });

  it('isSelfScoped agrees with ownerScope in every case', () => {
    for (const viewer of [household, child, admin, adminSelf]) {
      expect(isSelfScoped(viewer)).toBe(ownerScope(viewer) !== null);
    }
  });
});

describe('canActOnOwner (ruling R3)', () => {
  it('lets a member act on their own rows and on shared rows', () => {
    expect(canActOnOwner(2, household)).toBe(true);
    expect(canActOnOwner(null, household)).toBe(true);
  });

  it('refuses a member acting on someone else', () => {
    expect(canActOnOwner(7, household)).toBe(false);
  });

  it('lets an admin act on anyone', () => {
    expect(canActOnOwner(7, admin)).toBe(true);
  });

  it('names no person in the refusal wording', () => {
    expect(NOT_YOURS_ERROR).toBe('That belongs to someone else in the household.');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/auth/viewer.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '@/lib/auth/viewer'`.

- [ ] **Step 3: Write `src/lib/auth/viewer.ts`.**

```ts
/**
 * v1.13.0, spec docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md.
 *
 * The reader boundary. `role` gates ACTIONS and always has; `visibility` gates READS and only reads.
 * Keep this module PURE -- no @/db import, no node builtin -- so a client component may import the
 * Viewer type without dragging better-sqlite3 into the browser bundle
 * (tests/ops/client-bundle.test.ts).
 */
export interface Viewer {
  id: number;
  role: 'admin' | 'member';
  visibility: 'household' | 'self';
}

/**
 * null means "no owner restriction" -- a household viewer, or an admin. Micro-ruling M1 makes
 * admin + self unreachable through the UI; the role check stays anyway so a hand-edited database row
 * cannot lock an admin out of their own install.
 * A number means "every row this query returns must be owned by this user id".
 */
export function ownerScope(viewer: Viewer): number | null {
  return viewer.visibility === 'self' && viewer.role !== 'admin' ? viewer.id : null;
}

export function isSelfScoped(viewer: Viewer): boolean {
  return ownerScope(viewer) !== null;
}

/**
 * Ruling R3. Moved here from src/app/(app)/goals/actions.ts so both actions files import one copy:
 * members may act on their OWN rows and on shared (null-owner) rows; admins may act on any.
 * warranty_items.owner_user_id is NOT NULL, so the shared arm is unreachable for items -- that is
 * correct, not an oversight: an item always has exactly one owner.
 */
export function canActOnOwner(ownerUserId: number | null, viewer: Viewer): boolean {
  return ownerUserId === null || ownerUserId === viewer.id || viewer.role === 'admin';
}

/** One wording for a refused cross-owner read or write (MUST-19.11: one place per wording rule). */
export const NOT_YOURS_ERROR = 'That belongs to someone else in the household.';
```

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run tests/lib/auth/viewer.test.ts --reporter=dot`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing users/login/session test.**

Add to `tests/lib/auth/users.test.ts` (new describe block at the end of the file):

```ts
describe('v1.13.0: people without a login, and the visibility flag', () => {
  beforeEach(() => {
    resetTestDb();
  });

  it('a person created without a login is attributable but cannot sign in', async () => {
    const person = await createPersonWithoutLogin({ name: 'Person Two', username: 'user-2' });
    expect(person.canSignIn).toBe(false);
    expect(person.role).toBe('member');
    expect(person.visibility).toBe('household');
    expect(listAttributablePeople().map((row) => row.username)).toContain('user-2');
  });

  it('stores a hash nothing can verify against, not a shared sentinel', async () => {
    const a = await createPersonWithoutLogin({ name: 'Person Two', username: 'user-2' });
    const b = await createPersonWithoutLogin({ name: 'Person Three', username: 'user-3' });
    const hashes = [a, b].map((row) => findUserByUsername(row.username)?.passwordHash);
    expect(hashes[0]).toBeTruthy();
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('refuses visibility self on an admin (micro-ruling M1)', async () => {
    const admin = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    expect(() => setUserVisibility(admin.id, 'self')).toThrow(/admin/i);
  });

  it('refuses clearing can_sign_in on an admin', async () => {
    const admin = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    expect(() => setUserCanSignIn(admin.id, false)).toThrow(/admin/i);
  });

  it('listAttributablePeople excludes a deactivated person but keeps a no-login one', async () => {
    const member = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'member' });
    await createPersonWithoutLogin({ name: 'Person Two', username: 'user-2' });
    setUserActive(member.id, false);
    expect(listAttributablePeople().map((row) => row.username)).toEqual(['user-2']);
  });

  it('setLastAccountId round-trips and accepts null', async () => {
    const member = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'member' });
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: member.id });
    setLastAccountId(member.id, accountId);
    expect(findUserById(member.id)?.lastAccountId).toBe(accountId);
    setLastAccountId(member.id, null);
    expect(findUserById(member.id)?.lastAccountId).toBeNull();
  });
});
```

Add to `tests/lib/auth/login.test.ts`:

```ts
it('v1.13.0 ruling R5: a person without a login is refused, indistinguishably from an unknown name', async () => {
  await createPersonWithoutLogin({ name: 'Person Two', username: 'user-2' });
  const result = await attemptLogin({ username: 'user-2', password: 'correct horse 9', ip: '127.0.0.1' });
  expect(result.status).toBe('invalid');
});
```

Add to `tests/lib/auth/session.test.ts`:

```ts
it('v1.13.0: a live session stops validating once can_sign_in is cleared', async () => {
  const member = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'member' });
  const { token } = createSession(member.id);
  expect(validateSession(token)?.visibility).toBe('household');
  setUserCanSignIn(member.id, false);
  expect(validateSession(token)).toBeNull();
});
```

- [ ] **Step 6: Run them and watch them fail.**

Run: `npx vitest run tests/lib/auth --reporter=dot`
Expected: FAIL — `createPersonWithoutLogin is not a function`, and `visibility` missing from
`SessionUser`.

- [ ] **Step 7: Implement the session change.**

In `src/lib/auth/session.ts`, extend the interface and both places that build it:

```ts
export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  /**
   * v1.13.0 ruling R2. 'self' scopes every read this person makes to rows they own. Carried on the
   * session so that every existing requireUser() call site already holds a Viewer and no page has to
   * fetch the flag separately -- which is what keeps the six chokepoints' viewer argument free at
   * every call site.
   */
  visibility: 'household' | 'self';
}
```

In `validateSession`, add `visibility: users.visibility` and `canSignIn: users.canSignIn` to the
select, then:

```ts
  if (!row) return null;
  if (!row.isActive) return null;
  // v1.13.0 ruling R5: a person whose login was withdrawn must not keep the session they had when it
  // was granted -- the same argument resetMfaAction makes about destroying sessions on an auth
  // downgrade, expressed here as a read-time refusal so no sweep is needed.
  if (!row.canSignIn) return null;
```

and return `{ id: row.id, name: row.name, username: row.username, role: row.role, visibility: row.visibility }`.

- [ ] **Step 8: Implement the users changes.**

In `src/lib/auth/users.ts`:

```ts
export interface UserRecord {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  totpEnabled: boolean;
  isActive: boolean;
  /** Spec v1.5: true until the user completes the forced /change-password step. */
  mustChangePassword: boolean;
  createdAt: string;
  /** v1.13.0 ruling R2. Admin-set on Settings -> Users. */
  visibility: 'household' | 'self';
  /** v1.13.0 ruling R5. false = attribution-only person, never on the login path. */
  canSignIn: boolean;
  /** v1.13.0 ruling R7: quick-add's default account for this person. */
  lastAccountId: number | null;
}

/** R5: no password, never admin, never a session. username is still required and still unique. */
export const createPersonSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
});
```

Add the three columns to `PUBLIC_COLUMNS`. Then the writers:

```ts
/**
 * v1.13.0 ruling R5. A person the money is attributed to who has no login: a young child, a relative
 * living with the household, a housemate who does not want an account. They appear in every
 * attribution picker and never on the login path.
 *
 * password_hash is NOT NULL, so a row still needs one. It hashes 32 random bytes and throws them
 * away rather than storing a fixed sentinel: a sentinel would be the SAME value on every install, so
 * anybody who read this source could try it, and argon2 would happily verify it.
 */
export async function createPersonWithoutLogin(input: { name: string; username: string }): Promise<UserRecord> {
  const parsed = createPersonSchema.parse(input);
  if (usernameTaken(parsed.username)) throw new Error(`Username "${parsed.username}" is already taken`);
  const passwordHash = await hashPassword(randomBytes(32).toString('base64'));
  return getDb()
    .insert(users)
    .values({
      name: parsed.name,
      username: parsed.username,
      passwordHash,
      role: 'member',
      totpSecretEncrypted: null,
      totpEnabled: false,
      isActive: true,
      mustChangePassword: false,
      visibility: 'household',
      canSignIn: false,
      lastAccountId: null,
      createdAt: nowIso(),
    })
    .returning(PUBLIC_COLUMNS)
    .get();
}

/**
 * Micro-ruling M1: 'self' and role 'admin' are mutually exclusive. Enforced here and not as a SQL
 * CHECK, because it is a CROSS-COLUMN invariant and a CHECK added by ALTER TABLE ADD COLUMN does not
 * re-validate existing rows -- the same argument assertBalanceAnchorPairing makes in
 * src/lib/warranty/items.ts.
 */
export function setUserVisibility(userId: number, visibility: 'household' | 'self'): void {
  if (visibility === 'self' && findUserById(userId)?.role === 'admin') {
    throw new Error('An admin cannot be limited to their own records. Make them a member first.');
  }
  getDb().update(users).set({ visibility }).where(eq(users.id, userId)).run();
}

/** Ruling R5: an admin must always be able to sign in, so the flag can never be cleared on one. */
export function setUserCanSignIn(userId: number, canSignIn: boolean): void {
  if (!canSignIn && findUserById(userId)?.role === 'admin') {
    throw new Error('An admin must be able to sign in. Make them a member first.');
  }
  getDb().update(users).set({ canSignIn }).where(eq(users.id, userId)).run();
}

/** Ruling R7 / micro-ruling M5. Called by manualEntryAction after a successful write. */
export function setLastAccountId(userId: number, accountId: number | null): void {
  getDb().update(users).set({ lastAccountId: accountId }).where(eq(users.id, userId)).run();
}

/**
 * The ONE list every attribution picker reads (ruling R5). Active people, login or not -- which
 * resolves the pre-v1.13.0 inconsistency where transactions/page.tsx:69 listed deactivated members
 * and budgets/page.tsx:72 did not. listUsers() stays as-is for Settings -> Users, which must show
 * deactivated rows so they can be reactivated.
 */
export function listAttributablePeople(): UserRecord[] {
  return getDb().select(PUBLIC_COLUMNS).from(users).where(eq(users.isActive, true)).orderBy(users.id).all();
}
```

`createUser` gains `visibility: 'household', canSignIn: true, lastAccountId: null` in its `values`,
and `createFirstAdmin` gains the same. Import `randomBytes` from `node:crypto`.

In `src/lib/auth/login.ts:69`, the branch becomes:

```ts
  // v1.13.0 ruling R5: canSignIn is checked INSIDE this branch, not before it, so a
  // no-login username still pays the dummy-hash cost and cannot be distinguished by timing.
  if (!user || !user.isActive || !user.canSignIn) {
```

`UserWithSecrets` extends `UserRecord`, so `findUserByUsername`'s select needs no change beyond
`PUBLIC_COLUMNS` already carrying the new columns.

- [ ] **Step 9: Write the failing audit test, then `src/lib/audit.ts`.**

Create `tests/lib/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { appendAudit, listAudit } from '@/lib/audit';
import { createUser } from '@/lib/auth/users';
import { resetTestDb } from '../helpers/db';

describe('audit_log (ruling R3)', () => {
  beforeEach(() => {
    resetTestDb();
  });

  it('appends a row and reads it back with the actor name', async () => {
    const user = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    const id = appendAudit({
      userId: user.id,
      action: 'delete_item',
      entity: 'warranty_items',
      entityId: 42,
      detail: 'Property tax',
      at: '2026-08-27T10:00:00.000Z',
    });
    expect(id).toBeGreaterThan(0);
    expect(listAudit()).toEqual([
      {
        id,
        at: '2026-08-27T10:00:00.000Z',
        userId: user.id,
        userName: 'Person One',
        action: 'delete_item',
        entity: 'warranty_items',
        entityId: 42,
        detail: 'Property tax',
      },
    ]);
  });

  it('lists newest first and honours the limit', async () => {
    const user = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    for (const [n, at] of [[1, '2026-08-25T00:00:00.000Z'], [2, '2026-08-26T00:00:00.000Z'], [3, '2026-08-27T00:00:00.000Z']] as const) {
      appendAudit({ userId: user.id, action: 'undo_import', entity: 'imports', entityId: n, at });
    }
    expect(listAudit(2).map((row) => row.entityId)).toEqual([3, 2]);
  });

  it('stores NULL when no detail is given', async () => {
    const user = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    appendAudit({ userId: user.id, action: 'delete_receipt', entity: 'warranty_receipts', entityId: 9 });
    expect(listAudit()[0]?.detail).toBeNull();
  });
});
```

Run: `npx vitest run tests/lib/audit.test.ts --reporter=dot` — FAIL, module not found. Then create
`src/lib/audit.ts`:

```ts
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { auditLog, users } from '@/db/schema';
import { nowIso } from '@/lib/clock';

/**
 * v1.13.0 ruling R3: a minimal, append-only record of the three destructive operations a household
 * member can perform. There is deliberately NO update and NO delete in this module, and
 * tests/ops/visibility-invariants.test.ts greps the whole of src/ to keep it that way.
 *
 * This is NOT a security log. It stores no request body, no IP (sessions already carries that) and
 * no secret -- one short sentence at most. R3 says keep it small, and a log that grows a payload
 * column is a log that eventually holds a card number.
 */
export type AuditAction = 'delete_item' | 'delete_receipt' | 'undo_import';

export function appendAudit(input: {
  userId: number;
  action: AuditAction;
  entity: string;
  entityId: number;
  detail?: string | null;
  at?: string;
}): number {
  const row = getDb()
    .insert(auditLog)
    .values({
      at: input.at ?? nowIso(),
      userId: input.userId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      detail: input.detail ?? null,
    })
    .returning({ id: auditLog.id })
    .get();
  return row.id;
}

export interface AuditRow {
  id: number;
  at: string;
  userId: number;
  userName: string;
  action: string;
  entity: string;
  entityId: number;
  detail: string | null;
}

/** Newest first. Read by the admin page at /settings/audit and by nothing else. */
export function listAudit(limit = 200): AuditRow[] {
  return getDb()
    .select({
      id: auditLog.id,
      at: auditLog.at,
      userId: auditLog.userId,
      userName: users.name,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      detail: auditLog.detail,
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(Math.min(1000, Math.max(1, limit)))
    .all();
}
```

- [ ] **Step 10: Run every test this task touches.**

Run: `npx vitest run tests/lib/auth tests/lib/audit.test.ts tests/db --reporter=dot`
Expected: PASS. Existing `users.test.ts` assertions that compare a whole `UserRecord` object will
need the three new fields added to their expected shapes — do that, do not loosen the assertion to
`objectContaining`.

- [ ] **Step 11: Commit.**

```bash
git add src/lib/auth/viewer.ts src/lib/audit.ts src/lib/auth/session.ts src/lib/auth/users.ts src/lib/auth/login.ts tests/lib/auth tests/lib/audit.test.ts
git commit -m "feat(auth): the viewer, people without a login, and the append-only audit log"
```

---

# Wave B — the query layer (seven parallel tasks)

Every task in this wave consumes Wave A only. Their file sets are disjoint. Each ends with the whole
repo still failing to typecheck (call sites in `src/app/` have not been updated yet) — **that is
expected and correct**: the required `viewer` parameter is what makes the compiler list every page
that must change in Wave C. Run only your own test files; do **not** run `npx tsc --noEmit` in this
wave.

### Task 3: transactions — the viewer chokepoint and notes in search

**Files:**
- Modify: `src/lib/transactions.ts:1-10` (imports), `:113-141` (`buildWhere`), `:144-163`
  (`listTransactions`), `:166-168` (`getTransaction`)
- Modify: `tests/lib/transactions.test.ts`
- Create: `tests/lib/visibility/transactions.test.ts`

**Interfaces:**
- Consumes: `ownerScope`, `type Viewer` from `@/lib/auth/viewer` (Task 2).
- Produces:
  ```ts
  export function listTransactions(filter: TransactionFilter, viewer: Viewer): TransactionPage;
  export function getTransaction(id: number, viewer: Viewer): TransactionRow | null;
  ```
  Both parameters are required. `TransactionFilter`, `TransactionRow` and `TransactionPage` are
  unchanged. `createManualTransaction` and `updateTransactionNotes` are unchanged.

- [ ] **Step 1: Write the failing test.**

Create `tests/lib/visibility/transactions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createManualTransaction, getTransaction, listTransactions } from '@/lib/transactions';
import { resetTestDb } from '../../helpers/db';

const HOUSEHOLD: Viewer = { id: 1, role: 'member', visibility: 'household' };

describe('ruling R2: listTransactions and getTransaction take a viewer', () => {
  let adultId = 0;
  let childId = 0;
  let accountId = 0;
  let adultTxn = 0;
  let childTxn = 0;

  beforeEach(async () => {
    resetTestDb();
    const adult = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    const child = await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' });
    adultId = adult.id;
    childId = child.id;
    accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    adultTxn = createManualTransaction({
      accountId, date: '2026-08-10', description: 'GROCERY STORE', amountCents: -4210,
      categoryId: null, attributedUserId: adultId, userId: adultId,
    });
    childTxn = createManualTransaction({
      accountId, date: '2026-08-11', description: 'CORNER SHOP', amountCents: -500,
      categoryId: null, attributedUserId: childId, userId: adultId,
    });
  });

  const childViewer = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adultViewer = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('a household viewer sees both rows, exactly as before v1.13.0', () => {
    const page = listTransactions({}, adultViewer());
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id).sort()).toEqual([adultTxn, childTxn].sort());
  });

  it('a self viewer sees only rows attributed to them', () => {
    const page = listTransactions({}, childViewer());
    expect(page.total).toBe(1);
    expect(page.rows[0]?.id).toBe(childTxn);
  });

  it('a self viewer asking for someone else gets nothing, not that person rewritten', () => {
    const page = listTransactions({ attributedUserId: adultId }, childViewer());
    expect(page.total).toBe(0);
    expect(page.rows).toEqual([]);
  });

  it('getTransaction returns null for another person row, and the row for their own', () => {
    expect(getTransaction(adultTxn, childViewer())).toBeNull();
    expect(getTransaction(childTxn, childViewer())?.id).toBe(childTxn);
    expect(getTransaction(adultTxn, adultViewer())?.id).toBe(adultTxn);
  });

  it('ruling R13: the search box matches a note as well as a description', () => {
    const { updateTransactionNotes } = require('@/lib/transactions') as typeof import('@/lib/transactions');
    updateTransactionNotes(adultTxn, 'reimbursed by the school trip fund');
    const page = listTransactions({ search: 'school trip' }, HOUSEHOLD);
    expect(page.rows.map((row) => row.id)).toEqual([adultTxn]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/visibility/transactions.test.ts --reporter=dot`
Expected: FAIL — "Expected 2 arguments, but got 1" at runtime shows as every self assertion
returning both rows, and the note search returns `[]`.

- [ ] **Step 3: Implement.**

In `src/lib/transactions.ts`, add to the imports:

```ts
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
```

`buildWhere` takes the viewer and appends the scope clause **after** the caller's own person clause:

```ts
function buildWhere(filter: TransactionFilter, viewer: Viewer): SQL | undefined {
  const clauses: SQL[] = [];
  if (typeof filter.accountId === 'number') clauses.push(eq(transactions.accountId, filter.accountId));

  if (filter.categoryId === 'uncategorized') clauses.push(isNull(transactions.categoryId));
  else if (typeof filter.categoryId === 'number') clauses.push(eq(transactions.categoryId, filter.categoryId));

  if (filter.attributedUserId === 'unattributed') clauses.push(isNull(transactions.attributedUserId));
  else if (typeof filter.attributedUserId === 'number') clauses.push(eq(transactions.attributedUserId, filter.attributedUserId));

  // v1.13.0 ruling R2. Appended AFTER the caller's own person clause, never instead of it: a self
  // viewer who asks for somebody else must get an unsatisfiable AND (zero rows), not a filter
  // silently rewritten to themselves. A rewrite would show them their own spending under another
  // person's name, which is a worse answer than an empty page.
  const scope = ownerScope(viewer);
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));

  if (filter.from) clauses.push(gte(transactions.date, filter.from));
  if (filter.to) clauses.push(lte(transactions.date, filter.to));

  if (filter.search && filter.search.trim().length > 0) {
    const needle = `%${escapeLikeNeedle(filter.search.trim().toUpperCase())}%`;
    const clause = or(
      sql`upper(${transactions.rawDescription}) like ${needle} escape ${LIKE_ESCAPE}`,
      sql`upper(${transactions.normalizedMerchant}) like ${needle} escape ${LIKE_ESCAPE}`,
      // Search what the user can actually see, too (spec v1.4 display names).
      sql`upper(coalesce(${transactions.displayDescription}, '')) like ${needle} escape ${LIKE_ESCAPE}`,
      // v1.13.0 ruling R13. The merchant half of that ruling needed no edit -- normalizedMerchant is
      // already in this OR, one line above, and a second clause over the same column would be a
      // duplicate rather than a fix. No FTS5 index: ruling R13 says LIKE, and the warranty side's
      // index exists because it also covers OCR'd receipt text, which has no analogue here.
      sql`upper(coalesce(${transactions.notes}, '')) like ${needle} escape ${LIKE_ESCAPE}`,
    );
    if (clause) clauses.push(clause);
  }

  if (filter.uncategorizedOnly) clauses.push(isNull(transactions.categoryId));
  if (filter.includeTransfers === false) clauses.push(eq(transactions.isTransfer, false));

  if (clauses.length === 0) return undefined;
  return and(...clauses);
}
```

```ts
/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED, not optional. An optional parameter lets a forgotten call
 * site compile into a silent leak; a required one makes the compiler name every page that has to
 * decide what it is showing and to whom.
 */
export function listTransactions(filter: TransactionFilter, viewer: Viewer): TransactionPage {
  const pageSize = Math.min(200, Math.max(1, filter.pageSize && filter.pageSize > 0 ? filter.pageSize : 50));
  const page = Math.max(1, filter.page ?? 1);
  const where = buildWhere(filter, viewer);
  // ... body unchanged from here down
}

/**
 * null for a row outside the viewer's scope -- deliberately the same answer as "no such row", and
 * deliberately not a throw. The warranty detail page looks a linked transaction up by id
 * (src/app/(app)/warranties/[id]/page.tsx), and it already renders "no link" for a transaction that
 * no longer exists; a foreign transaction takes the same path with no extra branch, and the caller
 * cannot tell the two apart, which is the point.
 */
export function getTransaction(id: number, viewer: Viewer): TransactionRow | null {
  const scope = ownerScope(viewer);
  const where = scope === null
    ? eq(transactions.id, id)
    : and(eq(transactions.id, id), eq(transactions.attributedUserId, scope));
  return baseQuery().where(where).get() ?? null;
}
```

- [ ] **Step 4: Run both test files and watch them pass.**

Run: `npx vitest run tests/lib/visibility/transactions.test.ts tests/lib/transactions.test.ts --reporter=dot`
Expected: PASS. `tests/lib/transactions.test.ts`'s existing calls need a household viewer added —
add `const VIEWER: Viewer = { id: 1, role: 'admin', visibility: 'household' };` at the top of that
file and pass it; do not weaken any existing assertion.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/transactions.ts tests/lib/transactions.test.ts tests/lib/visibility/transactions.test.ts
git commit -m "feat(transactions): scope reads to the viewer and search notes"
```

---

### Task 4: accounts, net worth, goals and loans — four chokepoints and five account types

**Files:**
- Modify: `src/lib/accounts.ts:1-43` (types, schema, `listAccounts`), and the end of the file
- Modify: `src/lib/networth.ts:217-250` (`netWorthOverTime`'s `listAccounts` call only)
- Modify: `src/lib/goals.ts:173-227` (`listContributions`, `listGoals`, `getGoal`), `:236-238`
  (`totalSavedAcrossGoals`)
- Modify: `src/lib/loans.ts:867-890` (`listLoans`)
- Modify: `tests/lib/accounts.test.ts`, `tests/lib/goals.test.ts`, `tests/lib/networth.test.ts`,
  `tests/lib/loans/*.test.ts` call sites
- Create: `tests/lib/visibility/accounts-goals-loans.test.ts`

**Interfaces:**
- Consumes: `ownerScope`, `type Viewer` from `@/lib/auth/viewer` (Task 2).
- Produces:
  ```ts
  export type AccountType = 'chequing' | 'credit' | 'cash' | 'savings' | 'asset';
  export function acceptsTransactions(type: AccountType): boolean;
  export function countsTowardSafeToSpend(type: AccountType): boolean;
  export function listAccounts(opts: { includeInactive?: boolean }, viewer: Viewer): AccountRecord[];
  // getAccount(id) is UNCHANGED -- micro-ruling M3's exempt list.

  export function listGoals(opts: { includeArchived?: boolean; today?: string }, viewer: Viewer): GoalWithProgress[];
  export function getGoal(goalId: number, viewer: Viewer, today?: string): GoalWithProgress | null;
  export function listContributions(goalId: number, viewer: Viewer): ContributionRecord[];
  export function totalSavedAcrossGoals(viewer: Viewer, today?: string): number;

  export function listLoans(today: string, viewer: Viewer): LoanSummary[];
  ```

- [ ] **Step 1: Write the failing test.**

Create `tests/lib/visibility/accounts-goals-loans.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { acceptsTransactions, countsTowardSafeToSpend, createAccount, listAccounts } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createGoal, listContributions, listGoals, addContribution } from '@/lib/goals';
import { resetTestDb } from '../../helpers/db';

describe('ruling R2: accounts, goals and loans take a viewer', () => {
  let adultId = 0;
  let childId = 0;

  beforeEach(async () => {
    resetTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
  });

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('a self viewer lists only the accounts they own', () => {
    createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    const theirs = createAccount({ name: 'Pocket money', type: 'cash', ownerUserId: childId });
    expect(listAccounts({}, child()).map((row) => row.id)).toEqual([theirs]);
    expect(listAccounts({}, adult())).toHaveLength(2);
  });

  it('a shared (un-owned) account is not visible to a self viewer', () => {
    createAccount({ name: 'Joint chequing', type: 'chequing', ownerUserId: null });
    expect(listAccounts({}, child())).toEqual([]);
  });

  it('ruling R10: the five account types round-trip and their two predicates hold', () => {
    for (const type of ['chequing', 'credit', 'cash', 'savings', 'asset'] as const) {
      const id = createAccount({ name: `A ${type}`, type, ownerUserId: adultId });
      expect(listAccounts({}, adult()).find((row) => row.id === id)?.type).toBe(type);
    }
    expect(acceptsTransactions('asset')).toBe(false);
    expect(acceptsTransactions('savings')).toBe(true);
    expect(countsTowardSafeToSpend('savings')).toBe(false);
    expect(countsTowardSafeToSpend('asset')).toBe(false);
    expect(countsTowardSafeToSpend('chequing')).toBe(true);
    expect(countsTowardSafeToSpend('cash')).toBe(true);
    expect(countsTowardSafeToSpend('credit')).toBe(false);
  });

  it('a self viewer sees their own goals and shared goals, never another person goal', () => {
    const mine = createGoal({ name: 'Bike', ownerUserId: childId, targetCents: 20000, targetDate: null });
    const shared = createGoal({ name: 'Holiday', ownerUserId: null, targetCents: 500000, targetDate: null });
    createGoal({ name: 'New roof', ownerUserId: adultId, targetCents: 900000, targetDate: null });
    expect(listGoals({}, child()).map((row) => row.id).sort()).toEqual([mine, shared].sort());
    expect(listGoals({}, adult())).toHaveLength(3);
  });

  it('listContributions returns nothing for a goal the viewer cannot see', () => {
    const theirs = createGoal({ name: 'New roof', ownerUserId: adultId, targetCents: 900000, targetDate: null });
    addContribution({ goalId: theirs, userId: adultId, amountCents: 10000, date: '2026-08-01', note: null });
    expect(listContributions(theirs, child())).toEqual([]);
    expect(listContributions(theirs, adult())).toHaveLength(1);
  });
});
```

Add to `tests/lib/loans/summary.test.ts` (or whichever existing file covers `listLoans`):

```ts
it('v1.13.0 ruling R2: a self viewer sees only loans on items they own', () => {
  // fixture: two loan items, one owned by each person, both with a balance
  expect(listLoans('2026-08-27', { id: childId, role: 'member', visibility: 'self' }).map((row) => row.name))
    .toEqual(['Student loan']);
  expect(listLoans('2026-08-27', { id: adultId, role: 'admin', visibility: 'household' })).toHaveLength(2);
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run tests/lib/visibility/accounts-goals-loans.test.ts --reporter=dot`
Expected: FAIL — `acceptsTransactions is not a function`, and every self assertion returning
household rows.

- [ ] **Step 3: Implement accounts.**

```ts
import { ownerScope, type Viewer } from '@/lib/auth/viewer';

/**
 * v1.13.0 ruling R10. Five values, up from three. This column has never carried a SQL CHECK
 * (drizzle/0000_init.sql:59), so widening it took no migration -- micro-ruling M2.
 */
export type AccountType = 'chequing' | 'credit' | 'cash' | 'savings' | 'asset';

/**
 * Ruling R10: an asset (a house, a TFSA, an RRSP) holds a balance a person types in once a quarter.
 * It takes no transactions and no imports, so it is filtered out of every account picker that leads
 * to a write. It is NOT filtered out of net worth -- being in net worth is the whole reason it
 * exists.
 */
export function acceptsTransactions(type: AccountType): boolean {
  return type !== 'asset';
}

/**
 * Ruling R10: savings behaves like chequing for balances and transactions but is deliberately left
 * out of safe-to-spend -- money set aside is not money available this month, and folding it in is
 * how a safe-to-spend figure starts lying. Credit was never in it either.
 */
export function countsTowardSafeToSpend(type: AccountType): boolean {
  return type === 'chequing' || type === 'cash';
}

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'Account name is required').max(80),
  institution: z.string().trim().max(80).default(''),
  type: z.enum(['chequing', 'credit', 'cash', 'savings', 'asset']),
  ownerUserId: z.number().int().positive().nullable(),
  importProfileId: z.number().int().positive().nullable().optional(),
});

/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED. A self viewer sees only accounts they own -- including
 * NOT the joint account, because an un-owned account is the household's shared money and R2 says a
 * self user sees no account balances that are not theirs.
 */
export function listAccounts(opts: { includeInactive?: boolean }, viewer: Viewer): AccountRecord[] {
  const scope = ownerScope(viewer);
  const clauses: SQL[] = [];
  if (!opts.includeInactive) clauses.push(eq(accounts.isActive, true));
  if (scope !== null) clauses.push(eq(accounts.ownerUserId, scope));
  const query = getDb().select().from(accounts);
  return (clauses.length === 0 ? query : query.where(and(...clauses))).orderBy(asc(accounts.id)).all();
}

/**
 * NO viewer parameter, on purpose (micro-ruling M3). This is an internal resolver, not a read model:
 * createManualTransaction (src/lib/transactions.ts), commitImport (src/lib/import/commit.ts) and
 * commitStagedImport (src/lib/import/flow.ts) all call it with an id they produced themselves and
 * have no viewer to pass. No page or route resolves a user-supplied account id through it.
 * tests/ops/visibility-invariants.test.ts names it on the exempt list with this reason.
 */
export function getAccount(id: number): AccountRecord | null {
  return getDb().select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
}
```

Import `and` and `type SQL` from `drizzle-orm`.

- [ ] **Step 4: Implement goals and loans.**

In `src/lib/goals.ts`:

```ts
import { ownerScope, type Viewer } from '@/lib/auth/viewer';

/**
 * v1.13.0 ruling R2. A self viewer sees goals they own AND shared (null-owner) goals: a shared goal
 * has no other person's name on it, and "the holiday we are all saving for" is exactly the kind of
 * thing a child is part of. Their own goal and the family's, and nothing else.
 */
function visibleGoalCondition(viewer: Viewer): SQL | undefined {
  const scope = ownerScope(viewer);
  if (scope === null) return undefined;
  return or(eq(goals.ownerUserId, scope), isNull(goals.ownerUserId));
}

export function listGoals(opts: { includeArchived?: boolean; today?: string }, viewer: Viewer): GoalWithProgress[] {
  const today = opts.today ?? todayIso();
  const where = visibleGoalCondition(viewer);
  const query = baseGoals();
  const rows = (where ? query.where(where) : query).orderBy(asc(goals.id)).all();
  return rows.filter((row) => opts.includeArchived || !row.archived).map((row) => attachProgress(row, today));
}

export function getGoal(goalId: number, viewer: Viewer, today?: string): GoalWithProgress | null {
  const visible = visibleGoalCondition(viewer);
  const where = visible ? and(eq(goals.id, goalId), visible) : eq(goals.id, goalId);
  const row = baseGoals().where(where).get();
  if (!row) return null;
  return attachProgress(row, today ?? todayIso());
}

/**
 * Empty for a goal the viewer cannot see. Contributions carry a contributor name and an amount, so
 * returning them for a goal the viewer is not allowed to open would leak exactly what R2 protects.
 */
export function listContributions(goalId: number, viewer: Viewer): ContributionRecord[] {
  if (getGoal(goalId, viewer) === null) return [];
  return getDb()
    .select({
      id: goalContributions.id,
      goalId: goalContributions.goalId,
      userId: goalContributions.userId,
      userName: users.name,
      amountCents: goalContributions.amountCents,
      date: goalContributions.date,
      note: goalContributions.note,
    })
    .from(goalContributions)
    .innerJoin(users, eq(users.id, goalContributions.userId))
    .where(eq(goalContributions.goalId, goalId))
    .orderBy(desc(goalContributions.date), desc(goalContributions.id))
    .all();
}

/** Exported for the dashboard's goal cards: total saved across the goals this viewer can see. */
export function totalSavedAcrossGoals(viewer: Viewer, today?: string): number {
  return listGoals({ today }, viewer).reduce((sum, goal) => sum + goal.savedCents, 0);
}
```

In `src/lib/loans.ts`, `listLoans` gains the viewer and one clause. Only the `.where(...)` and the
signature change; every other line of that function stays:

```ts
/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED. A loan's balance and interest rate are the most private
 * numbers in the app, and until now every member could read every one of them.
 *
 * Nothing else in this file takes a viewer. applyPaymentMatchers, link(), markEarliestUnpaid and the
 * reversal helpers are background machinery run by an import or a scheduler, not by a person looking
 * at a screen -- there is no viewer to pass and no screen to protect.
 */
export function listLoans(today: string, viewer: Viewer): LoanSummary[] {
  const scope = ownerScope(viewer);
  const rows = getDb()
    .select({ /* unchanged */ })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    .where(
      scope === null
        ? eq(warrantyItemTypes.kind, 'loan')
        : and(eq(warrantyItemTypes.kind, 'loan'), eq(warrantyItems.ownerUserId, scope)),
    )
    .orderBy(asc(warrantyItems.name), asc(warrantyItems.id))
    .all();
  // ... the map() below is unchanged
}
```

`src/lib/networth.ts:217-250` needs one edit: its internal `listAccounts()` call becomes
`listAccounts({}, viewer)`. `netWorthOverTime` gains `viewer: Viewer` as a required field of its
existing options object — the dashboard and reports pages are the only callers, and both hide the
net-worth figure entirely for a self viewer (Task 13), so passing the viewer through keeps the
function honest rather than relying on the page to remember.

- [ ] **Step 5: Run every affected test file and watch them pass.**

Run: `npx vitest run tests/lib/visibility/accounts-goals-loans.test.ts tests/lib/accounts.test.ts tests/lib/goals.test.ts tests/lib/networth.test.ts tests/lib/loans --reporter=dot`
Expected: PASS. Existing call sites in those files gain a household viewer constant; do not weaken an
assertion to make one pass.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/accounts.ts src/lib/networth.ts src/lib/goals.ts src/lib/loans.ts tests/lib/accounts.test.ts tests/lib/goals.test.ts tests/lib/networth.test.ts tests/lib/loans tests/lib/visibility/accounts-goals-loans.test.ts
git commit -m "feat(lib): scope accounts, goals and loans to the viewer; add savings and asset types"
```

---

### Task 5: warranty items — the chokepoint, the bill category link, and Record payment

**Files:**
- Modify: `src/lib/warranty/items.ts:356-367` (`getWarrantyItem`), the `WarrantyInput`/`ITEM_COLUMNS`
  shapes, and the update path
- Modify: `src/lib/warranty/search.ts:186-247` (`searchWarrantyItems`), `:277-283` (`expiringSoonItems`)
- Modify: `src/lib/warranty/installments.ts` — add `recordInstallmentPayment` at the end
- Modify: `tests/lib/warranty/items.test.ts`, `tests/lib/warranty/search.test.ts`,
  `tests/lib/warranty/installments.test.ts`
- Create: `tests/lib/visibility/warranty.test.ts`

**Interfaces:**
- Consumes: `ownerScope`, `type Viewer` from `@/lib/auth/viewer` (Task 2);
  `createManualTransaction(input)` from `@/lib/transactions` — **unchanged** by Task 3, so this task
  may call it as it stands.
- Produces:
  ```ts
  export function getWarrantyItem(id: number, viewer: Viewer): WarrantyItemRow | null;
  export function searchWarrantyItems(filter: WarrantySearchFilter, viewer: Viewer): WarrantySearchResult;
  export function expiringSoonItems(limit: number, ownerUserId: number | null, today: string, viewer: Viewer): WarrantyListItem[];
  export function setBudgetCategory(itemId: number, categoryId: number | null): void;

  export type RecordPaymentResult =
    | { ok: true; transactionId: number; installmentId: number }
    | { ok: false; reason: 'gone' | 'already_paid' | 'no_account' };
  export function recordInstallmentPayment(input: {
    installmentId: number; accountId: number; userId: number; today: string;
  }): RecordPaymentResult;
  /** One query, two answers: the ownership check AND the revalidate path Task 11 needs. */
  export function findInstallmentItem(installmentId: number): { itemId: number; ownerUserId: number } | null;
  ```
  `WarrantyItemRow` gains `budgetCategoryId: number | null`.

- [ ] **Step 1: Write the failing test.**

Create `tests/lib/visibility/warranty.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { getWarrantyItem } from '@/lib/warranty/items';
import { searchWarrantyItems } from '@/lib/warranty/search';
import { makeItem, makeType } from '../../helpers/warranty';
import { resetTestDb } from '../../helpers/db';

describe('ruling R2 + R3: warranty reads take a viewer', () => {
  let adultId = 0;
  let childId = 0;
  let adultItem = 0;
  let childItem = 0;

  beforeEach(async () => {
    resetTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
    const typeId = makeType({ name: 'Appliance', kind: 'warranty' });
    adultItem = makeItem({ name: 'Dishwasher', ownerUserId: adultId, typeId });
    childItem = makeItem({ name: 'Bicycle', ownerUserId: childId, typeId });
  });

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('getWarrantyItem returns null for another owner id -- this is what makes /warranties/[id] 404', () => {
    expect(getWarrantyItem(adultItem, child())).toBeNull();
    expect(getWarrantyItem(childItem, child())?.id).toBe(childItem);
    expect(getWarrantyItem(adultItem, adult())?.id).toBe(adultItem);
  });

  it('searchWarrantyItems lists only the viewer own items for a self viewer', () => {
    expect(searchWarrantyItems({}, child()).rows.map((row) => row.id)).toEqual([childItem]);
    expect(searchWarrantyItems({}, adult()).total).toBe(2);
  });

  it('a self viewer asking for another owner gets nothing, not that owner rows', () => {
    expect(searchWarrantyItems({ ownerUserId: adultId }, child()).rows).toEqual([]);
  });
});
```

Add to `tests/lib/warranty/installments.test.ts`:

```ts
describe('recordInstallmentPayment (ruling R8)', () => {
  it('writes one transaction and marks the installment, in one step', () => {
    // fixture: a bill item owned by user 1, one unpaid installment of 180000 due 2026-06-30,
    // budgetCategoryId set to the Property tax category, and a chequing account.
    const result = recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    expect(result).toEqual({ ok: true, transactionId: expect.any(Number), installmentId });

    const txn = getTransaction((result as { transactionId: number }).transactionId, HOUSEHOLD);
    expect(txn?.amountCents).toBe(-180000);
    expect(txn?.date).toBe('2026-08-27');
    expect(txn?.rawDescription).toBe('Property tax');
    expect(txn?.categoryId).toBe(propertyTaxCategoryId);

    const row = listInstallments(itemId, '2026-08-27', 30).find((r) => r.id === installmentId);
    expect(row?.paidAt).not.toBeNull();
    expect(row?.paidTxnId).toBe((result as { transactionId: number }).transactionId);
  });

  it('a second click writes nothing and says so', () => {
    recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    const before = countTransactions();
    expect(recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' }))
      .toEqual({ ok: false, reason: 'already_paid' });
    expect(countTransactions()).toBe(before);
  });

  it('leaves the category NULL when the bill is not linked to one', () => {
    setBudgetCategory(itemId, null);
    const result = recordInstallmentPayment({ installmentId, accountId, userId, today: '2026-08-27' });
    expect(getTransaction((result as { transactionId: number }).transactionId, HOUSEHOLD)?.categoryId).toBeNull();
  });

  it('refuses when the installment is gone', () => {
    expect(recordInstallmentPayment({ installmentId: 999999, accountId, userId, today: '2026-08-27' }))
      .toEqual({ ok: false, reason: 'gone' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run tests/lib/visibility/warranty.test.ts tests/lib/warranty/installments.test.ts --reporter=dot`
Expected: FAIL — every self assertion returns household rows; `recordInstallmentPayment is not a
function`.

- [ ] **Step 3: Implement the chokepoints.**

`src/lib/warranty/items.ts` — `ITEM_COLUMNS` gains `budgetCategoryId: warrantyItems.budgetCategoryId`,
`WarrantyItemRow` gains `budgetCategoryId: number | null`, and:

```ts
/**
 * v1.13.0 ruling R2/R3: `viewer` is REQUIRED, and null for another owner id. That null is what turns
 * src/app/(app)/warranties/[id]/page.tsx into a notFound() with no extra branch on the page -- the
 * review's confirmed-exploitable finding (SEC-1) closes here, in the query, rather than in a check a
 * future page could forget to copy.
 */
export function getWarrantyItem(id: number, viewer: Viewer): WarrantyItemRow | null {
  const scope = ownerScope(viewer);
  const where = scope === null
    ? eq(warrantyItems.id, id)
    : and(eq(warrantyItems.id, id), eq(warrantyItems.ownerUserId, scope));
  const row = getDb()
    .select(ITEM_COLUMNS)
    .from(warrantyItems)
    .innerJoin(users, eq(users.id, warrantyItems.ownerUserId))
    .leftJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(where)
    .get();
  return row ? toItemRow(row) : null;
}

/**
 * v1.13.0 ruling R11 / micro-ruling M9. The read-side link between a bill and a budget category.
 * Deliberately its own tiny writer rather than a field on updateWarrantyItem: it changes no limit, no
 * rollover and no total, and folding it into the big item update would invite a future reader to
 * think it does.
 */
export function setBudgetCategory(itemId: number, categoryId: number | null): void {
  getDb()
    .update(warrantyItems)
    .set({ budgetCategoryId: categoryId, updatedAt: nowIso() })
    .where(eq(warrantyItems.id, itemId))
    .run();
}
```

`src/lib/warranty/search.ts` — one clause added inside the existing raw-SQL `where` builder, right
after `filter.ownerUserId`'s:

```ts
  if (filter.ownerUserId != null) {
    where.push('i.owner_user_id = ?');
    whereParams.push(filter.ownerUserId);
  }
  // v1.13.0 ruling R2. Pushed IN ADDITION to the caller's own owner filter, never instead of it, so
  // a self viewer who asks for somebody else gets an unsatisfiable AND rather than their own rows
  // relabelled -- the same rule buildWhere follows in src/lib/transactions.ts.
  const scope = ownerScope(viewer);
  if (scope !== null) {
    where.push('i.owner_user_id = ?');
    whereParams.push(scope);
  }
```

`expiringSoonItems` passes the viewer straight through:

```ts
export function expiringSoonItems(
  limit: number,
  ownerUserId: number | null,
  today: string,
  viewer: Viewer,
): WarrantyListItem[] {
  return searchWarrantyItems({ status: 'expiring', ownerUserId, sort: 'expiry', today }, viewer).rows.slice(0, limit);
}
```

- [ ] **Step 4: Implement `recordInstallmentPayment`.**

At the end of `src/lib/warranty/installments.ts`:

```ts
export type RecordPaymentResult =
  | { ok: true; transactionId: number; installmentId: number }
  | { ok: false; reason: 'gone' | 'already_paid' | 'no_account' };

/**
 * The ownership answer AND the revalidate path, in one query. Ruling R3's check on the Record-payment
 * action (Task 11) needs the owner; its revalidatePath needs the item id; two lookups for two fields
 * of the same row is a round trip nobody needs.
 */
export function findInstallmentItem(installmentId: number): { itemId: number; ownerUserId: number } | null {
  const row = getDb()
    .select({ itemId: warrantyItems.id, ownerUserId: warrantyItems.ownerUserId })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    .where(eq(billInstallments.id, installmentId))
    .get();
  return row ?? null;
}

/**
 * v1.13.0 ruling R8: the bridge from a bill that is due to a transaction that happened. Not a
 * scheduler -- a person presses this after the money actually moved, so the app never invents a
 * transaction the bank never made.
 *
 * ONE-LINK-PER-TRANSACTION IS STRUCTURAL HERE, NOT CHECKED. The transaction is created inside this
 * call, so it can carry no prior loan_payments or bill_installments link, and
 * bill_installments_txn_uq (drizzle/0011) makes a second installment against that id impossible for
 * ever, whatever re-runs.
 *
 * THE ORDER MATTERS. createManualTransaction runs applyPaymentMatchers on the new row
 * (src/lib/transactions.ts), and a merchant rule on this same bill could mark the EARLIEST unpaid
 * installment -- which may not be the one the person pressed. So the targeted mark runs AFTER that
 * call and is conditional on paid_at IS NULL, the same guard markEarliestUnpaid uses. If the matcher
 * got there first, this returns already_paid: the payment IS recorded and the schedule IS marked,
 * just not by this button, and saying so is more honest than marking a second row.
 */
export function recordInstallmentPayment(input: {
  installmentId: number;
  accountId: number;
  userId: number;
  today: string;
}): RecordPaymentResult {
  const db = getDb();
  const target = db
    .select({
      id: billInstallments.id,
      itemId: billInstallments.itemId,
      amountCents: billInstallments.amountCents,
      paidAt: billInstallments.paidAt,
      itemName: warrantyItems.name,
      budgetCategoryId: warrantyItems.budgetCategoryId,
      ownerUserId: warrantyItems.ownerUserId,
    })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    .where(eq(billInstallments.id, input.installmentId))
    .get();

  if (target === undefined) return { ok: false, reason: 'gone' };
  if (target.paidAt !== null) return { ok: false, reason: 'already_paid' };
  if (!Number.isInteger(input.accountId) || input.accountId <= 0) return { ok: false, reason: 'no_account' };

  return db.transaction((tx) => {
    const transactionId = createManualTransaction({
      accountId: input.accountId,
      date: input.today,
      description: target.itemName,
      // A payment is money OUT. The installment's amount_cents CHECK guarantees it is positive.
      amountCents: -target.amountCents,
      categoryId: target.budgetCategoryId,
      attributedUserId: target.ownerUserId,
      notes: null,
      userId: input.userId,
    });

    const marked = tx
      .update(billInstallments)
      .set({ paidAt: nowIso(), paidTxnId: transactionId })
      .where(and(eq(billInstallments.id, input.installmentId), isNull(billInstallments.paidAt)))
      .run();

    if (marked.changes === 0) return { ok: false, reason: 'already_paid' } as const;
    return { ok: true, transactionId, installmentId: input.installmentId } as const;
  });
}
```

- [ ] **Step 5: Run every affected test file and watch them pass.**

Run: `npx vitest run tests/lib/visibility/warranty.test.ts tests/lib/warranty --reporter=dot`
Expected: PASS. Existing `getWarrantyItem`/`searchWarrantyItems` call sites in those files gain a
household viewer constant.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/warranty/items.ts src/lib/warranty/search.ts src/lib/warranty/installments.ts tests/lib/warranty tests/lib/visibility/warranty.test.ts
git commit -m "feat(warranty): scope item reads to the viewer; record a bill payment as a transaction"
```

---

### Task 6: reports — the viewer chokepoint on seven aggregates

**Files:**
- Modify: `src/lib/reports.ts:18-36` (the scope helpers), `:46-97` (`categoryBreakdown`), `:105-149`
  (`cashflowTrend`), `:157-209` (`categoryMonthOverMonth`), `:233-299` (`categoryYearOverYear`),
  `:306-333` (`personSpendSplit`), `:340-377` (`topMerchants`), `:422-470` (`transactionsCsv`)
- Modify: `tests/lib/reports.test.ts`
- Create: `tests/lib/visibility/reports.test.ts`

**Interfaces:**
- Consumes: `ownerScope`, `type Viewer` from `@/lib/auth/viewer` (Task 2).
- Produces: the seven exported aggregates, each with a required trailing `viewer: Viewer`. Their
  return types (`CategoryBreakdownRow`, `MonthTrendRow`, `CategoryMonthTrend`, `YoYRow`,
  `PersonSplitRow`, `TopMerchantRow`, `string`) are unchanged. `toCsv` and `CsvColumn` are unchanged.

- [ ] **Step 1: Write the failing test.**

Create `tests/lib/visibility/reports.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { cashflowTrend, personSpendSplit, topMerchants, transactionsCsv } from '@/lib/reports';
import { createManualTransaction } from '@/lib/transactions';
import { resetTestDb } from '../../helpers/db';

describe('ruling R2: reports aggregates take a viewer', () => {
  let adultId = 0;
  let childId = 0;

  beforeEach(async () => {
    resetTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    createManualTransaction({
      accountId, date: '2026-08-10', description: 'GROCERY STORE', amountCents: -10000,
      categoryId: null, attributedUserId: adultId, userId: adultId,
    });
    createManualTransaction({
      accountId, date: '2026-08-11', description: 'CORNER SHOP', amountCents: -500,
      categoryId: null, attributedUserId: childId, userId: adultId,
    });
  });

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });
  const range = { from: '2026-08-01', to: '2026-08-31' };

  it('a self viewer total is their own spending, not the household', () => {
    const mine = cashflowTrend(1, { endMonth: '2026-08' }, child());
    const ours = cashflowTrend(1, { endMonth: '2026-08' }, adult());
    expect(mine[0]?.spentCents).toBe(500);
    expect(ours[0]?.spentCents).toBe(10500);
  });

  it('a self viewer cannot re-scope to another person through the options object', () => {
    const spoofed = cashflowTrend(1, { endMonth: '2026-08', attributedUserId: adultId }, child());
    expect(spoofed[0]?.spentCents).toBe(500);
  });

  it('topMerchants is scoped the same way', () => {
    expect(topMerchants({ ...range, limit: 10 }, child()).map((row) => row.normalizedMerchant))
      .toEqual(['CORNER SHOP']);
    expect(topMerchants({ ...range, limit: 10 }, adult())).toHaveLength(2);
  });

  it('personSpendSplit collapses to one row for a self viewer', () => {
    expect(personSpendSplit(range, child()).map((row) => row.userId)).toEqual([childId]);
    expect(personSpendSplit(range, adult())).toHaveLength(2);
  });

  it('the CSV export carries only the viewer own rows', () => {
    const csv = transactionsCsv({ from: range.from, to: range.to }, child());
    expect(csv).toContain('CORNER SHOP');
    expect(csv).not.toContain('GROCERY STORE');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/visibility/reports.test.ts --reporter=dot`
Expected: FAIL — every self assertion returns household figures.

- [ ] **Step 3: Implement.**

Add to the imports of `src/lib/reports.ts`:

```ts
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
```

One private helper, immediately under the existing `personClause`, so the rule is written once and
every aggregate reads the same line:

```ts
/**
 * v1.13.0 ruling R2: a self viewer's person scope is THEIR OWN id, whatever the URL asked for.
 *
 * This is the one place in reports.ts that knows about visibility. Every exported aggregate below
 * runs its requested scope through it before building a clause, so a page cannot forget -- and
 * `viewer` is a required parameter on all seven, so a NEW aggregate cannot forget either: it will
 * not compile until its author decides what scope it is reading.
 */
function scopeFor(requested: PersonScope, viewer: Viewer): PersonScope {
  const own = ownerScope(viewer);
  return own === null ? requested : own;
}
```

Each aggregate takes `viewer: Viewer` as its last parameter and replaces its
`input.attributedUserId` / `opts.attributedUserId` read with `scopeFor(input.attributedUserId, viewer)`.
Worked example for two of them; apply the same shape to the other five:

```ts
export function cashflowTrend(
  months: number,
  opts: { endMonth?: string; attributedUserId?: PersonScope } = {},
  viewer: Viewer,
): MonthTrendRow[] {
  const scope = scopeFor(opts.attributedUserId, viewer);
  // ... the existing body, with `scope` wherever it previously read opts.attributedUserId
}

/**
 * A self viewer gets exactly one row -- their own. The split IS the household comparison otherwise,
 * which is precisely the "reports of household totals" ruling R2 forbids, so the Reports page renders
 * this section only for a household viewer (Task 13). Returning one row rather than throwing keeps
 * this function total for any caller.
 */
export function personSpendSplit(input: DateRange, viewer: Viewer): PersonSplitRow[] {
  const own = ownerScope(viewer);
  const rows = /* ... existing query ... */;
  return own === null ? rows : rows.filter((row) => row.userId === own);
}
```

`transactionsCsv(filter, viewer)` forwards to `listTransactions(filter, viewer)` — Task 3 already
made that the signature, so this is one argument added at one call site.

> Note for the implementer: `opts` with a default value cannot precede a required parameter in
> TypeScript. Keep the default (`= {}`) and put `viewer` after it — TypeScript permits an optional
> parameter before a required one only when the optional has a default AND is not marked `?`, which
> is exactly the shape above. If a signature will not compile, make `opts` required at its call sites
> rather than moving `viewer` earlier: the parameter order is the interface other tasks consume.

- [ ] **Step 4: Run both files and watch them pass.**

Run: `npx vitest run tests/lib/visibility/reports.test.ts tests/lib/reports.test.ts --reporter=dot`
Expected: PASS. `tests/lib/reports.test.ts`'s existing calls gain a household viewer constant.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/reports.ts tests/lib/reports.test.ts tests/lib/visibility/reports.test.ts
git commit -m "feat(reports): every aggregate takes a viewer and cannot be re-scoped by the URL"
```

---

### Task 7: bills, the sinking fund, and the insights reader

**Files:**
- Modify: `src/lib/bills.ts:81-146` (`upcomingBills`), `:164-185` (`safeToSpend`), and the end of the
  file (`sinkingFundsFor`)
- Modify: `src/lib/budgets.ts` — export nothing new; only the `BudgetRow` docblock gains a sentence
  pointing at `sinkingFundsFor` so a reader of `carryCents` finds it
- Create: `src/lib/insights.ts`
- Modify: `tests/lib/bills.test.ts`
- Create: `tests/lib/insights.test.ts`

**Interfaces:**
- Consumes: `ownerScope`, `type Viewer` (Task 2); `unpaidInstallments({ today, windowEnd,
  includeOverdue, ownerUserId })` from `@/lib/warranty/installments` — **already exists at
  `installments.ts:245`, unchanged by Task 5**; `unusualVerdict`, `creepVerdict`, `findDuplicates`,
  `hasEnoughHouseholdHistory`, `type SpendRow` from `@/lib/predict/anomalies` — unchanged.
- Produces:
  ```ts
  export function upcomingBills(input: { today: string; days: number; includeOverdue?: boolean; viewer: Viewer }): UpcomingBill[];
  export function safeToSpend(input: { month: string; today: string; viewer: Viewer }): {
    budgetedRemainingCents: number; projectedSpendCents: number | null; billsDueCents: number;
  };
  export interface SinkingFund { categoryId: number; itemId: number; itemName: string; dueDate: string; targetCents: number; carriedCents: number }
  export function sinkingFundsFor(input: { month: string; today: string; rows: BudgetRow[]; viewer: Viewer }): Map<number, SinkingFund>;

  // src/lib/insights.ts
  export type InsightKind = 'unusual' | 'duplicate' | 'creep';
  export interface InsightRow { kind: InsightKind; transactionId: number; date: string; merchant: string; amountCents: number; sentence: string }
  export const INSIGHTS_MAX_ROWS = 8;
  export function householdInsights(input: { today: string; viewer: Viewer }): InsightRow[];
  ```

- [ ] **Step 1: Write the failing insights test.**

Create `tests/lib/insights.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { householdInsights } from '@/lib/insights';
import { createManualTransaction } from '@/lib/transactions';
import { resetTestDb } from '../helpers/db';

const TODAY = '2026-08-27';

describe('householdInsights (ruling R6)', () => {
  let adultId = 0;
  let childId = 0;
  let accountId = 0;

  beforeEach(async () => {
    resetTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
    accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
  });

  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });
  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });

  const spend = (date: string, description: string, cents: number, person = adultId) =>
    createManualTransaction({
      accountId, date, description, amountCents: -cents,
      categoryId: null, attributedUserId: person, userId: adultId,
    });

  it('says nothing at all on a household with too little history', () => {
    spend('2026-08-20', 'GROCERY STORE', 4210);
    expect(householdInsights({ today: TODAY, viewer: adult() })).toEqual([]);
  });

  it('flags a charge far above that merchant own baseline', () => {
    // Twelve months of ordinary charges, then one outlier inside the lookback window.
    for (let month = 8; month <= 19; month += 1) {
      const iso = `2025-${String(month > 12 ? month - 12 : month).padStart(2, '0')}-05`;
      spend(month > 12 ? iso.replace('2025', '2026') : iso, 'GROCERY STORE', 4200);
    }
    const outlier = spend('2026-08-20', 'GROCERY STORE', 92000);
    const rows = householdInsights({ today: TODAY, viewer: adult() });
    expect(rows.filter((row) => row.kind === 'unusual').map((row) => row.transactionId)).toEqual([outlier]);
  });

  it('flags a duplicate pair and links to the SECOND charge', () => {
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const second = spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const rows = householdInsights({ today: TODAY, viewer: adult() });
    expect(rows.filter((row) => row.kind === 'duplicate').map((row) => row.transactionId)).toEqual([second]);
  });

  it('a self viewer sees only rows from their own transactions', () => {
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    expect(householdInsights({ today: TODAY, viewer: child() })).toEqual([]);
  });

  it('never returns more than INSIGHTS_MAX_ROWS', () => {
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    for (let n = 1; n <= 20; n += 1) {
      spend('2026-08-20', `SHOP ${n}`, 6500);
      spend('2026-08-20', `SHOP ${n}`, 6500);
    }
    expect(householdInsights({ today: TODAY, viewer: adult() }).length).toBeLessThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/insights.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '@/lib/insights'`.

- [ ] **Step 3: Write `src/lib/insights.ts`.**

```ts
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addDaysIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import {
  creepVerdict,
  findDuplicates,
  hasEnoughHouseholdHistory,
  unusualVerdict,
  type SpendRow,
} from '@/lib/predict/anomalies';
import {
  DUPLICATE_LOOKBACK_DAYS,
  UNUSUAL_BASELINE_DAYS,
  UNUSUAL_LOOKBACK_DAYS,
  UNUSUAL_MIN_ABS_CENTS,
} from '@/lib/predict/constants';

/**
 * v1.13.0 ruling R6 (item AJ / PROD-2). The maths already existed and was tested; it was reachable
 * only as a Telegram or email notification, so a household member with no channel configured never
 * learned that a subscription went up. This module is the READ-ONLY surface for it.
 *
 * WHY IT IS NOT UNDER src/lib/predict/ (micro-ruling M4): tests/ops/predict-invariants.test.ts fails
 * any file in that tree except history.ts that imports @/db. This one needs the database, so it
 * cannot live there.
 *
 * WHY IT DOES NOT REUSE src/lib/notify/evaluate/anomalies.ts's queries (micro-ruling M4): that module
 * is built around a module-level fingerprint cache and per-user enqueue caps, both of which exist to
 * stop a notification firing twice. A page render wants neither, and threading them through a shared
 * helper would be a larger and riskier diff than the one query below.
 */
export type InsightKind = 'unusual' | 'duplicate' | 'creep';

export interface InsightRow {
  kind: InsightKind;
  /** The transaction the card row links to. A duplicate pair links to the SECOND charge. */
  transactionId: number;
  date: string;
  merchant: string;
  amountCents: number;
  /** One sentence, already formatted. The card renders it verbatim (MUST-19.11). */
  sentence: string;
}

/** The card is a nudge, not a report. Eight rows is a glance; forty is a second inbox. */
export const INSIGHTS_MAX_ROWS = 8;

function readSlice(sliceStart: string, scope: number | null): SpendRow[] {
  const clauses = [
    gte(transactions.date, sliceStart),
    eq(transactions.isTransfer, false),
    lt(transactions.amountCents, 0),
  ];
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(...clauses))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
}

function earliestDate(scope: number | null): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(scope === null ? undefined : eq(transactions.attributedUserId, scope))
    .get();
  return row?.first ?? null;
}

export function householdInsights(input: { today: string; viewer: Viewer }): InsightRow[] {
  const { today } = input;
  const scope = ownerScope(input.viewer);

  // The same first gate the notification evaluator applies: a household that has been using the app
  // for a fortnight has no baseline, and a "baseline" drawn from three rows is a guess presented as
  // a finding.
  if (!hasEnoughHouseholdHistory(earliestDate(scope), today)) return [];

  const baselineStart = addDaysIso(today, -UNUSUAL_BASELINE_DAYS);
  const slice = readSlice(baselineStart, scope);
  const lookbackStart = addDaysIso(today, -UNUSUAL_LOOKBACK_DAYS);
  const rows: InsightRow[] = [];

  for (const candidate of slice) {
    if (candidate.date < lookbackStart) continue;
    if (Math.abs(candidate.amountCents) < UNUSUAL_MIN_ABS_CENTS) continue;
    const merchantSample = slice
      .filter((row) => row.id !== candidate.id && row.merchant === candidate.merchant)
      .map((row) => Math.abs(row.amountCents));
    const categorySample =
      candidate.categoryId === null
        ? []
        : slice
            .filter((row) => row.id !== candidate.id && row.categoryId === candidate.categoryId)
            .map((row) => Math.abs(row.amountCents));
    const verdict = unusualVerdict({ candidate, merchantSample, categorySample, today });
    if (verdict === null) continue;
    rows.push({
      kind: 'unusual',
      transactionId: candidate.id,
      date: candidate.date,
      merchant: candidate.merchant,
      amountCents: candidate.amountCents,
      sentence: `${formatCents(Math.abs(candidate.amountCents))} at ${candidate.merchant} — usually about ${formatCents(verdict.baselineCents)}.`,
    });
  }

  const duplicateStart = addDaysIso(today, -DUPLICATE_LOOKBACK_DAYS);
  for (const pair of findDuplicates({ rows: slice.filter((row) => row.date >= duplicateStart), today })) {
    rows.push({
      kind: 'duplicate',
      // The SECOND charge: it is the one a person would question, and the one they would reverse.
      transactionId: pair.secondId,
      date: pair.secondDate,
      merchant: pair.merchant,
      amountCents: pair.amountCents,
      sentence: `${pair.merchant} charged ${formatCents(Math.abs(pair.amountCents))} twice on ${pair.secondDate}.`,
    });
  }

  const byMerchant = new Map<string, SpendRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }
  for (const [merchant, charges] of byMerchant) {
    const verdict = creepVerdict({ charges, today });
    if (verdict === null) continue;
    const latest = charges[charges.length - 1];
    if (latest === undefined) continue;
    rows.push({
      kind: 'creep',
      transactionId: latest.id,
      date: latest.date,
      merchant,
      amountCents: latest.amountCents,
      sentence: `${merchant} went from ${formatCents(verdict.baselineCents)} to ${formatCents(verdict.currentCents)}.`,
    });
  }

  // Newest first, so the card leads with what just happened.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.transactionId - a.transactionId));
  return rows.slice(0, INSIGHTS_MAX_ROWS);
}
```

> Implementer note: `unusualVerdict`, `creepVerdict` and `findDuplicates` are already exported with
> tested shapes at `src/lib/predict/anomalies.ts:53`, `:98` and `:145`. Read those three signatures
> and their return types before writing the calls above and adjust the property names to match
> exactly — do not change `anomalies.ts` itself, and do not add a `@/db` import to it.

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx vitest run tests/lib/insights.test.ts --reporter=dot`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing bills test, then implement bills.**

Add to `tests/lib/bills.test.ts`:

```ts
describe('v1.13.0: bills take a viewer, and the sinking-fund reader', () => {
  it('a self viewer sees only bills on items they own', () => {
    // fixture: one bill item owned by each person, each with an unpaid installment inside 30 days
    const mine = upcomingBills({ today: '2026-08-27', days: 30, viewer: { id: childId, role: 'member', visibility: 'self' } });
    expect(mine.map((bill) => bill.name)).toEqual(['Bike insurance']);
    const ours = upcomingBills({ today: '2026-08-27', days: 30, viewer: HOUSEHOLD });
    expect(ours).toHaveLength(2);
  });

  it('safeToSpend reads the PERSONAL budget scope for a self viewer (micro-ruling M8)', () => {
    // fixture: a household limit of 100000 and a personal limit of 5000 for the child
    const mine = safeToSpend({ month: '2026-08', today: '2026-08-27', viewer: { id: childId, role: 'member', visibility: 'self' } });
    expect(mine.budgetedRemainingCents).toBe(5000);
    const ours = safeToSpend({ month: '2026-08', today: '2026-08-27', viewer: HOUSEHOLD });
    expect(ours.budgetedRemainingCents).toBe(100000);
  });

  it('sinkingFundsFor maps a linked bill onto its budget category', () => {
    // fixture: a Property tax bill linked to the Property tax category, one unpaid 180000
    // installment due 2026-06-30, and a budgets row carrying 90000 of rollover carry
    const rows = budgetProgress('2026-08');
    const funds = sinkingFundsFor({ month: '2026-08', today: '2026-08-27', rows, viewer: HOUSEHOLD });
    expect(funds.get(propertyTaxCategoryId)).toEqual({
      categoryId: propertyTaxCategoryId,
      itemId,
      itemName: 'Property tax',
      dueDate: '2026-06-30',
      targetCents: 180000,
      carriedCents: 90000,
    });
  });

  it('an unlinked bill and a fully-paid schedule both produce no entry', () => {
    setBudgetCategory(itemId, null);
    expect(sinkingFundsFor({ month: '2026-08', today: '2026-08-27', rows: budgetProgress('2026-08'), viewer: HOUSEHOLD }).size).toBe(0);
  });
});
```

Then implement in `src/lib/bills.ts`:

```ts
/**
 * v1.13.0 ruling R2: `viewer` is REQUIRED. Both halves are scoped -- the cadence half by the item's
 * owner_user_id, and the schedule half through unpaidInstallments' existing ownerUserId option,
 * which has been there since v1.12.0 and needed no change.
 */
export function upcomingBills(input: {
  today: string; days: number; includeOverdue?: boolean; viewer: Viewer;
}): UpcomingBill[] {
  const { today, days } = input;
  const includeOverdue = input.includeOverdue ?? false;
  const windowEnd = addDaysIso(today, days);
  const scope = ownerScope(input.viewer);

  const clauses = [
    inArray(warrantyItemTypes.kind, RECURRING_KINDS),
    isNotNull(warrantyItems.billingCycle),
    gt(warrantyItems.billingAmountCents, 0),
    or(isNull(warrantyItems.expiryDate), gte(warrantyItems.expiryDate, today)),
  ];
  if (scope !== null) clauses.push(eq(warrantyItems.ownerUserId, scope));

  const rows = getDb()
    .select({ /* unchanged */ })
    .from(warrantyItems)
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(...clauses))
    .all();

  // ... the cadence loop is unchanged ...

  for (const row of unpaidInstallments({ today, windowEnd, includeOverdue, ownerUserId: scope ?? undefined })) {
    // ... unchanged ...
  }

  result.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return result;
}

/**
 * v1.13.0 micro-ruling M8: for a SELF viewer this reads the PERSONAL budget scope, not the household
 * one. Leaving it household would put the family's total on a child's dashboard through the Coming-up
 * card, which ruling R2 forbids -- and it would do so through the one figure on that card nobody
 * would think to check.
 */
export function safeToSpend(input: { month: string; today: string; viewer: Viewer }): {
  budgetedRemainingCents: number; projectedSpendCents: number | null; billsDueCents: number;
} {
  const { month, today } = input;
  const scope = ownerScope(input.viewer);

  const totals = budgetTotals(scope === null ? budgetProgress(month) : budgetProgress(month, 'personal', scope));
  const budgetedRemainingCents = totals.budgetedLimitCents - totals.budgetedSpentCents;

  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd(month).slice(8, 10));
  const projectedSpendCents = projectMonthEnd({ spentCents: totals.totalSpentCents, dayOfMonth, daysInMonth });

  const daysUntilMonthEnd = daysBetweenIso(today, monthEnd(month));
  const billsDueCents = sumCents(
    upcomingBills({ today, days: daysUntilMonthEnd, viewer: input.viewer }).map((bill) => bill.amountCents),
  );

  return { budgetedRemainingCents, projectedSpendCents, billsDueCents };
}

export interface SinkingFund {
  categoryId: number;
  itemId: number;
  itemName: string;
  /** The next unpaid installment on that bill. */
  dueDate: string;
  targetCents: number;
  /** The budgets row's own carryCents -- what rollover has already accumulated. */
  carriedCents: number;
}

/**
 * v1.13.0 ruling R11 (item AQ), micro-ruling M9. READ-SIDE ONLY. It changes no limit, no rollover and
 * no total; it joins what the budgets page already has (a row with a carryCents) to what the bills
 * side already has (an unpaid installment on a linked item) so the row can say what it is saving for.
 *
 * The owner explicitly refused a per-category monthly target: rollover IS the envelope, and this is
 * the sentence that makes it legible. Do not add a target column here later without reopening R11.
 *
 * One entry per category -- the SOONEST unpaid installment wins when two linked bills share one.
 */
export function sinkingFundsFor(input: {
  month: string; today: string; rows: BudgetRow[]; viewer: Viewer;
}): Map<number, SinkingFund> {
  const carryByCategory = new Map<number, number>();
  const walk = (rows: BudgetRow[]) => {
    for (const row of rows) {
      carryByCategory.set(row.categoryId, row.carryCents);
      walk(row.children);
    }
  };
  walk(input.rows);

  const scope = ownerScope(input.viewer);
  const clauses = [
    eq(warrantyItemTypes.kind, 'bill'),
    isNotNull(warrantyItems.budgetCategoryId),
    isNull(billInstallments.paidAt),
  ];
  if (scope !== null) clauses.push(eq(warrantyItems.ownerUserId, scope));

  const rows = getDb()
    .select({
      categoryId: warrantyItems.budgetCategoryId,
      itemId: warrantyItems.id,
      itemName: warrantyItems.name,
      dueDate: billInstallments.dueDate,
      amountCents: billInstallments.amountCents,
    })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(...clauses))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all();

  const out = new Map<number, SinkingFund>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    if (out.has(row.categoryId)) continue;
    if (!carryByCategory.has(row.categoryId)) continue;
    out.set(row.categoryId, {
      categoryId: row.categoryId,
      itemId: row.itemId,
      itemName: row.itemName,
      dueDate: row.dueDate,
      targetCents: row.amountCents,
      carriedCents: carryByCategory.get(row.categoryId) ?? 0,
    });
  }
  return out;
}
```

In `src/lib/budgets.ts`, the only edit is one sentence appended to `BudgetRow.carryCents`'s docblock
(`src/lib/budgets.ts:27-29`): *"v1.13.0 ruling R11: `sinkingFundsFor` in src/lib/bills.ts reads this
figure to say what a category is accumulating toward. It writes nothing here."*

- [ ] **Step 6: Run both files and watch them pass.**

Run: `npx vitest run tests/lib/bills.test.ts tests/lib/insights.test.ts --reporter=dot`
Expected: PASS. Existing `upcomingBills`/`safeToSpend` call sites in `tests/lib/bills.test.ts` gain
`viewer: HOUSEHOLD`.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/bills.ts src/lib/budgets.ts src/lib/insights.ts tests/lib/bills.test.ts tests/lib/insights.test.ts
git commit -m "feat(bills): scope bills to the viewer, add the sinking-fund reader and the insights reader"
```

---

### Task 8: merchant-rule ownership (AH) and the per-account stale alert (AM)

**Files:**
- Modify: `src/lib/categorize/rules.ts:61-105` (`upsertRuleFromCorrection`)
- Modify: `src/lib/categorize/engine.ts:657-680` (`upsertRenameRule`)
- Modify: `src/lib/notify/evaluate/stale.ts:1-53` (the whole file)
- Modify: `src/lib/notify/events.ts:272-274` (`staleImportKey`), and the `stale_import` blurb
- Modify: `src/lib/notify/render.ts` — the `stale_import` member of `RenderInput` gains `accountName`
- Modify: `tests/lib/categorize/rules.test.ts`, `tests/lib/notify/evaluate/stale.test.ts`,
  `tests/lib/notify/render.test.ts`

**Interfaces:**
- Consumes: `merchantRules.lastModifiedBy` from `@/db/schema` (Task 1).
- Produces:
  ```ts
  export type RuleUpsertResult =
    | { ok: true; ruleId: number }
    | { ok: false; reason: 'owned_by_another'; ownerName: string };
  export function upsertRuleFromCorrection(input: {
    pattern: string; matchType: MatchType; ruleKind: RuleKind;
    categoryId: number | null; renameTo?: string | null;
    createdBy: number | null; actorRole: 'admin' | 'member'; at?: Date;
  }): RuleUpsertResult;
  export const ruleOwnedError: (ownerName: string) => string;

  // src/lib/categorize/engine.ts
  export function upsertRenameRule(input: {
    pattern: string; matchType: MatchType; renameTo: string; userId: number;
    actorRole: 'admin' | 'member'; at?: Date;
  }): { ok: true; ruleId: number; rowsUpdated: number } | { ok: false; reason: 'owned_by_another'; ownerName: string };

  // src/lib/notify/events.ts
  export function staleImportKey(mondayIso: string, accountId: number): string;
  ```

- [ ] **Step 1: Write the failing rules test.**

Add to `tests/lib/categorize/rules.test.ts`:

```ts
describe('ruling R4 (item AH / SEC-6): a member cannot overwrite another person rule', () => {
  let adminId = 0;
  let memberId = 0;

  beforeEach(async () => {
    resetTestDb();
    adminId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    memberId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
  });

  const rule = (createdBy: number, actorRole: 'admin' | 'member', categoryId: number | null) =>
    upsertRuleFromCorrection({
      pattern: 'GROCERY STORE', matchType: 'contains', ruleKind: 'category',
      categoryId, renameTo: null, createdBy, actorRole,
    });

  it('a first write succeeds for anyone and records the author', () => {
    const result = rule(memberId, 'member', 3);
    expect(result.ok).toBe(true);
    expect(storedRule('GROCERY STORE')?.createdBy).toBe(memberId);
    expect(storedRule('GROCERY STORE')?.lastModifiedBy).toBe(memberId);
  });

  it('a member overwriting an admin rule writes NOTHING and names the owner', () => {
    rule(adminId, 'admin', 3);
    const result = rule(memberId, 'member', 9);
    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Person One' });
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(3);
    expect(stored?.createdBy).toBe(adminId);
    expect(stored?.lastModifiedBy).toBeNull();
  });

  it('the author may change their own rule, and created_by survives', () => {
    rule(memberId, 'member', 3);
    expect(rule(memberId, 'member', 9).ok).toBe(true);
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(9);
    expect(stored?.createdBy).toBe(memberId);
    expect(stored?.lastModifiedBy).toBe(memberId);
  });

  it('an admin may change anyone rule, and created_by STILL survives', () => {
    rule(memberId, 'member', 3);
    expect(rule(adminId, 'admin', 9).ok).toBe(true);
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(9);
    expect(stored?.createdBy).toBe(memberId);
    expect(stored?.lastModifiedBy).toBe(adminId);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/categorize/rules.test.ts --reporter=dot`
Expected: FAIL — the member overwrite succeeds and `created_by` flips to the member.

- [ ] **Step 3: Implement the rules change.**

```ts
/**
 * v1.13.0 ruling R4 (item AH / SEC-6). Until now this upsert put `createdBy` in its `set` object, so
 * a member correcting a category silently rewrote an admin's household-global rule AND the row then
 * claimed the member authored it -- a privilege asymmetry pointing the wrong way, since only an admin
 * can reach the delete control on /settings/managers.
 *
 * Now: a member-level write needs the rule to be ABSENT or to be their own. `createdBy` is never in
 * the `set` object again; `lastModifiedBy` records the change instead, so an overwrite by an admin is
 * attributable without erasing who thought of it.
 */
export type RuleUpsertResult =
  | { ok: true; ruleId: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

/** One wording, one place (MUST-19.11). */
export const ruleOwnedError = (ownerName: string) =>
  `${ownerName} set up this rule. Ask an admin to change it under Settings → Categories & rules.`;

export function upsertRuleFromCorrection(input: {
  pattern: string;
  matchType: MatchType;
  ruleKind: RuleKind;
  categoryId: number | null;
  renameTo?: string | null;
  createdBy: number | null;
  /** The ACTOR's role, not the rule's. An admin may write over anyone's rule. */
  actorRole: 'admin' | 'member';
  at?: Date;
}): RuleUpsertResult {
  const db = getDb();
  const renameTo = input.ruleKind === 'rename' ? (input.renameTo ?? null) : null;

  const existing = db
    .select({ id: merchantRules.id, createdBy: merchantRules.createdBy, ownerName: users.name })
    .from(merchantRules)
    .leftJoin(users, eq(users.id, merchantRules.createdBy))
    .where(
      and(
        eq(merchantRules.pattern, input.pattern),
        eq(merchantRules.matchType, input.matchType),
        eq(merchantRules.ruleKind, input.ruleKind),
      ),
    )
    .get();

  if (
    existing !== undefined &&
    input.actorRole !== 'admin' &&
    existing.createdBy !== null &&
    existing.createdBy !== input.createdBy
  ) {
    // Nothing is written. The caller turns this into a plain sentence for the person who tried.
    return { ok: false, reason: 'owned_by_another', ownerName: existing.ownerName ?? 'Another member' };
  }

  db.insert(merchantRules)
    .values({
      pattern: input.pattern,
      matchType: input.matchType,
      ruleKind: input.ruleKind,
      categoryId: input.categoryId,
      renameTo,
      createdBy: input.createdBy,
      lastModifiedBy: input.createdBy,
      hitCount: 0,
      lastUsedAt: null,
      createdAt: nowIso(input.at ?? new Date()),
    })
    .onConflictDoUpdate({
      target: [merchantRules.pattern, merchantRules.matchType, merchantRules.ruleKind],
      // createdBy is DELIBERATELY absent from this set object -- that is the whole of ruling R4.
      set: { categoryId: input.categoryId, renameTo, lastModifiedBy: input.createdBy },
    })
    .run();

  const row = db
    .select({ id: merchantRules.id })
    .from(merchantRules)
    .where(
      and(
        eq(merchantRules.pattern, input.pattern),
        eq(merchantRules.matchType, input.matchType),
        eq(merchantRules.ruleKind, input.ruleKind),
      ),
    )
    .get();
  return { ok: true, ruleId: row?.id ?? 0 };
}
```

`upsertRenameRule` (`src/lib/categorize/engine.ts:657`) takes `actorRole` and propagates:

```ts
export function upsertRenameRule(input: {
  pattern: string; matchType: MatchType; renameTo: string; userId: number;
  actorRole: 'admin' | 'member'; at?: Date;
}): { ok: true; ruleId: number; rowsUpdated: number } | { ok: false; reason: 'owned_by_another'; ownerName: string } {
  const renameTo = input.renameTo.trim();
  if (renameTo.length === 0) throw new Error('A rename rule needs a non-empty display name');
  if (input.pattern.trim().length === 0) throw new Error('A rename rule needs a pattern');

  const result = upsertRuleFromCorrection({
    pattern: input.pattern,
    matchType: input.matchType,
    ruleKind: 'rename',
    categoryId: null,
    renameTo,
    createdBy: input.userId,
    actorRole: input.actorRole,
    at: input.at,
  });
  // A refused upsert must not bulk-apply anything: the rule the household has is unchanged, so a
  // retroactive pass would rewrite rows to a name nobody agreed on.
  if (!result.ok) return result;
  const rowsUpdated = applyRenameRules(undefined, buildContext());
  return { ok: true, ruleId: result.ruleId, rowsUpdated };
}
```

Every in-repo caller of `upsertRuleFromCorrection` inside `src/lib/` passes `actorRole: 'admin'` when
it runs on behalf of the admin-only managers page and `actorRole: 'member'` otherwise. The four
member-facing server actions are updated in Wave C (Task 10 for `renameTransactionAction`; the three
review actions are in Task 14's file set).

- [ ] **Step 4: Write the failing stale test, then implement it.**

Rewrite `tests/lib/notify/evaluate/stale.test.ts`'s expectations:

```ts
describe('ruling R14: the stale-import alert names the account', () => {
  it('fires once for the lagging account and not for the fresh one', () => {
    // fixture: account A imported yesterday, account B imported 30 days ago, staleImportWeeks = 3
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' })).toBe(1);
    const queued = pendingOutbox(userId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.body).toContain('Amex');
    expect(queued[0]?.dedupKey).toBe(`stale:2026-08-24:${accountB}`);
  });

  it('a second evaluation in the same week enqueues nothing', () => {
    evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' });
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-28T09:00:00Z'), tz: 'America/Toronto' })).toBe(0);
  });

  it('the next Monday is a new key, so it nags again', () => {
    evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' });
    expect(evaluateStaleImport({ userId, now: new Date('2026-09-03T09:00:00Z'), tz: 'America/Toronto' })).toBe(1);
  });

  it('an inactive account never fires, and an install with no imports still fires nothing', () => {
    setAccountActive(accountB, false);
    expect(evaluateStaleImport({ userId, now: new Date('2026-08-27T09:00:00Z'), tz: 'America/Toronto' })).toBe(0);
  });
});
```

Then `src/lib/notify/evaluate/stale.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports } from '@/db/schema';
import { daysBetweenIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import { staleImportKey } from '@/lib/notify/events';
import { mondayOfIsoWeek } from '@/lib/notify/evaluate/slots';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';

/**
 * Decision 10 (unchanged): an install with ZERO imports never fires. A brand-new install must not nag
 * before it has anything to be stale about -- which now means, per account: an account that has never
 * been imported into is not stale, it is new, and the group-by below simply never produces a row for
 * it.
 *
 * MUST-14.8 (unchanged): SimpleFIN syncs create `imports` rows too, so a SimpleFIN-managed account is
 * never nagged. The query still looks at every import against an account rather than only the ones
 * this user made: staleness is a property of the data, not of who last pressed the button.
 *
 * v1.13.0 ruling R14 (item AM / PROD-10). This used to take the single most recent import ACROSS THE
 * WHOLE HOUSEHOLD, so importing TD on the 3rd silenced the alert for the Amex nobody had touched
 * since February -- exactly backwards for a household on manual CSV across five accounts.
 *
 * MUST-3.11/3.12: still one message per calendar week while stale, but the key now carries the
 * account id so each lagging account nags at most once a week and they cannot mask each other. No new
 * event id: notification_prefs keys on the event id string, so a second id would mean a migration, a
 * new default and a second switch a household has to find, for what is one idea.
 */
export function evaluateStaleImport(input: { userId: number; now: Date; tz: string }): number {
  const rows = getDb()
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      newest: sql<string>`max(${imports.createdAt})`,
    })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .where(eq(accounts.isActive, true))
    .groupBy(accounts.id)
    .all();
  if (rows.length === 0) return 0;

  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const monday = mondayOfIsoWeek(today);
  let enqueued = 0;

  for (const row of rows) {
    const lastImportIso = row.newest.slice(0, 10);
    const daysAgo = daysBetweenIso(lastImportIso, today);
    if (daysAgo < settings.staleImportWeeks * 7) continue;

    const { subject, body } = renderEvent({
      event: 'stale_import',
      weeks: settings.staleImportWeeks,
      lastImportIso,
      daysAgo,
      accountName: row.accountName,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'stale_import',
      dedupKey: staleImportKey(monday, row.accountId),
      subject,
      body,
      at: input.now,
    });
    if (result.inserted.length > 0) enqueued += 1;
  }
  return enqueued;
}
```

```ts
/**
 * v1.13.0 ruling R14. BOTH arguments are required, so the compiler names the one call site -- an
 * optional accountId would leave the old household-wide key reachable, and a stale key that still
 * exists is a stale key somebody will eventually pass.
 */
export function staleImportKey(mondayIso: string, accountId: number): string {
  return `stale:${mondayIso}:${accountId}`;
}
```

`RenderInput`'s `stale_import` member gains `accountName: string` (required, same reasoning), and the
rendered body names the account. The event's blurb in `NOTIFICATION_EVENTS` is reworded from "you
haven't imported in a while" to name per-account behaviour.

- [ ] **Step 5: Run every affected file and watch them pass.**

Run: `npx vitest run tests/lib/categorize tests/lib/notify --reporter=dot`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/categorize/rules.ts src/lib/categorize/engine.ts src/lib/notify tests/lib/categorize tests/lib/notify
git commit -m "feat: preserve merchant-rule authorship and nag per stale account"
```

---

### Task 9: OFX/QFX import and three UNVERIFIED bank presets

**Files:**
- Create: `src/lib/import/ofx.ts`
- Modify: `src/lib/import/parse.ts:19-37` (`CandidateRow` gains `externalId`)
- Modify: `src/lib/import/presets.ts:7-142` (three new presets, `BUILTIN_PRESET_NAMES`)
- Modify: `src/lib/import/flow.ts:32-85` (`commitStagedImport` branches on the file's shape)
- Modify: `src/lib/import/mapping.ts` — no schema change; one docblock sentence naming OFX
- Modify: `src/lib/dates.ts` — add `YYYYMMDD` to `DATE_FORMATS` **only if it is absent**
- Create: `tests/lib/import/ofx.test.ts`
- Modify: `tests/lib/import/presets.test.ts`

**Interfaces:**
- Consumes: `parseAmountToCents` (`@/lib/money`), `ImportLimitError` and `MAX_FILE_BYTES`
  (`@/lib/import/parse`), `CandidateRow`/`RowError`/`ParseResult` types.
- Produces:
  ```ts
  export interface OfxParseResult {
    rows: CandidateRow[]; errors: RowError[];
    currency: string | null; dialect: 'sgml' | 'xml';
    dateOrder: ParseResult['dateOrder'];
  }
  export function parseOfx(buf: Buffer): OfxParseResult;
  export function looksLikeOfx(filename: string, buf: Buffer): boolean;
  // CandidateRow gains: externalId?: string | null
  // BUILTIN_PRESET_NAMES gains: 'RBC Chequing/Visa' | 'BMO Chequing/Mastercard' | 'CIBC Chequing/Visa'
  ```

- [ ] **Step 1: ASK THE OWNER FOR THREE REDACTED HEADER LINES. Do not skip this.**

Report to the owner, before writing any preset:

> The three new presets (RBC, BMO, CIBC) are **UNVERIFIED** — `real-statements/` contains no sample
> for any of them (it holds two TD-shaped chequing exports and one Amex Canada export, all three of
> which already have presets). Each preset below is built from the bank's published "download to CSV"
> layout. If you can paste **one header line per bank, with no value rows**, I will pin them against
> the real thing. Until then the docblocks say UNVERIFIED and the CHANGELOG says so too.

Proceed with the task either way; if the owner supplies a header line, correct the mapping and remove
that preset's `UNVERIFIED` marker in the same commit.

- [ ] **Step 2: Write the failing OFX test.**

Create `tests/lib/import/ofx.test.ts`. The fixtures are **written by the test file itself** — no
tracked fixture file, no real data, invented merchants and account ids only:

```ts
import { describe, it, expect } from 'vitest';
import { parseOfx, looksLikeOfx } from '@/lib/import/ofx';

/** OFX 1.x: SGML, no closing tags on leaves, a colon-delimited header block before <OFX>. */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>CAD
<BANKACCTFROM><BANKID>000000000<ACCTID>0000000<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000<TRNAMT>-42.10<FITID>FIT-0001<NAME>GROCERY STORE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260812120000<TRNAMT>-180.00<FITID>FIT-0002<NAME>CITY TAX OFFICE<MEMO>installment</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260815120000<TRNAMT>2100.00<FITID>FIT-0003<NAME>PAYROLL DEPOSIT</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

/** OFX 2.x: well-formed XML, every leaf closed, an XML declaration and an <?OFX?> processing instruction. */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1><STMTTRNRS><STMTRS>
    <CURDEF>CAD</CURDEF>
    <BANKACCTFROM><BANKID>000000000</BANKID><ACCTID>0000000</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
    <BANKTRANLIST>
      <DTSTART>20260801</DTSTART><DTEND>20260831</DTEND>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260803120000</DTPOSTED><TRNAMT>-42.10</TRNAMT><FITID>FIT-0001</FITID><NAME>GROCERY STORE</NAME></STMTTRN>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260812120000</DTPOSTED><TRNAMT>-180.00</TRNAMT><FITID>FIT-0002</FITID><NAME>CITY TAX OFFICE</NAME><MEMO>installment</MEMO></STMTTRN>
      <STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260815120000</DTPOSTED><TRNAMT>2100.00</TRNAMT><FITID>FIT-0003</FITID><NAME>PAYROLL DEPOSIT</NAME></STMTTRN>
    </BANKTRANLIST>
  </STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('parseOfx (ruling R9)', () => {
  it('reads the SGML dialect', () => {
    const result = parseOfx(Buffer.from(SGML, 'utf8'));
    expect(result.dialect).toBe('sgml');
    expect(result.currency).toBe('CAD');
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      rawDate: '20260803',
      date: '2026-08-03',
      rawDescription: 'GROCERY STORE',
      amountCents: -4210,
      externalId: 'FIT-0001',
      balanceCents: null,
    });
    expect(result.rows[2]?.amountCents).toBe(210000);
  });

  it('reads the XML dialect to the same rows', () => {
    const sgml = parseOfx(Buffer.from(SGML, 'utf8'));
    const xml = parseOfx(Buffer.from(XML, 'utf8'));
    expect(xml.dialect).toBe('xml');
    expect(xml.rows.map(({ rowIndex, cells, ...rest }) => rest))
      .toEqual(sgml.rows.map(({ rowIndex, cells, ...rest }) => rest));
  });

  it('joins NAME and MEMO when both are present', () => {
    expect(parseOfx(Buffer.from(SGML, 'utf8')).rows[1]?.rawDescription).toBe('CITY TAX OFFICE installment');
  });

  it('detects the date order from the first and last parsed row', () => {
    expect(parseOfx(Buffer.from(SGML, 'utf8')).dateOrder).toBe('oldest_first');
  });

  it('returns no rows and does not throw for a file with no transactions', () => {
    const empty = SGML.replace(/<STMTTRN>[\s\S]*?<\/STMTTRN>\n?/g, '');
    const result = parseOfx(Buffer.from(empty, 'utf8'));
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('reports a transaction with an unreadable date as a row error, not a throw', () => {
    const broken = SGML.replace('<DTPOSTED>20260803120000', '<DTPOSTED>not-a-date');
    const result = parseOfx(Buffer.from(broken, 'utf8'));
    expect(result.rows).toHaveLength(2);
    expect(result.errors[0]?.reason).toBe('unparseable date');
  });

  it('looksLikeOfx keys on the extension and on the OFX marker, never on the extension alone', () => {
    expect(looksLikeOfx('statement.ofx', Buffer.from(SGML, 'utf8'))).toBe(true);
    expect(looksLikeOfx('statement.qfx', Buffer.from(XML, 'utf8'))).toBe(true);
    expect(looksLikeOfx('statement.csv', Buffer.from('a,b,c\n1,2,3', 'utf8'))).toBe(false);
    expect(looksLikeOfx('statement.ofx', Buffer.from('a,b,c\n1,2,3', 'utf8'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail.**

Run: `npx vitest run tests/lib/import/ofx.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '@/lib/import/ofx'`.

- [ ] **Step 4: Implement the reader.**

Add to `src/lib/import/parse.ts`'s `CandidateRow`:

```ts
  /**
   * v1.13.0 ruling R9: the provider's stable per-transaction id (OFX FITID). null for every CSV row.
   * commitImport ALREADY dedups on this when set, and stores NULL in dedup_hash for such a row
   * (src/lib/import/commit.ts:196-198,231-233) -- the SimpleFIN path built exactly this machinery and
   * OFX needs no change to commit, undo or the transactions_external_id_uq index at all.
   */
  externalId?: string | null;
```

`parseCsv` stamps `externalId: null` on every row it produces, explicitly, so the two paths differ in
one field and not in whether the field exists.

Create `src/lib/import/ofx.ts`:

```ts
import { isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import { ImportLimitError, MAX_FILE_BYTES, type CandidateRow, type ParseResult, type RowError } from './parse';

/**
 * v1.13.0 ruling R9 (item AO / PROD-5). A reader for OFX 1.x (SGML) and OFX 2.x (XML), written in
 * repo because ruling R16 forbids a new dependency and because the subset we need is small.
 *
 * WHY NOT AN XML PARSER: OFX 1.x is NOT XML. Its leaves have no closing tags -- `<TRNAMT>-42.10`
 * followed by the next `<` is the whole element -- so every XML parser in existence rejects the
 * format the majority of Canadian banks still emit from "download for Quicken". A tag scanner reads
 * both dialects with one loop; an XML parser reads one of them.
 *
 * WHY FITID MATTERS: it is the bank's own stable id for a transaction, so overlapping statement
 * periods dedup EXACTLY instead of by our (date, amount, description, occurrence) fingerprint. The
 * database already has the column and the index for it -- transactions.external_id and
 * transactions_external_id_uq, both shipped for SimpleFIN -- so this needs no migration.
 */
export interface OfxParseResult {
  rows: CandidateRow[];
  errors: RowError[];
  /** From <CURDEF>, uppercased, or null. Recorded for the preview banner; never enforced. */
  currency: string | null;
  dialect: 'sgml' | 'xml';
  dateOrder: ParseResult['dateOrder'];
}

/** Extension AND content. An extension alone is a claim, not evidence. */
export function looksLikeOfx(filename: string, buf: Buffer): boolean {
  if (!/\.(ofx|qfx)$/i.test(filename)) return false;
  const head = buf.subarray(0, 2048).toString('utf8').toUpperCase();
  return head.includes('OFXHEADER') || head.includes('<OFX>');
}

interface Tag {
  name: string;
  /** The text between this tag and the next '<'. Empty for a container. */
  value: string;
  closing: boolean;
}

/** One pass, no allocation per character. Skips the header block and any processing instruction. */
function scan(text: string): Tag[] {
  const body = text.slice(Math.max(0, text.toUpperCase().indexOf('<OFX>')));
  const tags: Tag[] = [];
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf('<', index);
    if (open === -1) break;
    const close = body.indexOf('>', open + 1);
    if (close === -1) break;
    const raw = body.slice(open + 1, close).trim();
    index = close + 1;
    if (raw.startsWith('?') || raw.startsWith('!')) continue;
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/\s/)[0]?.toUpperCase() ?? '';
    if (name.length === 0) continue;
    const nextOpen = body.indexOf('<', index);
    const value = (nextOpen === -1 ? body.slice(index) : body.slice(index, nextOpen)).trim();
    tags.push({ name, value, closing });
  }
  return tags;
}

/** OFX dates are YYYYMMDD[HHMMSS][.MMM][TZ]. Only the first eight characters are a calendar date. */
function toIsoDate(raw: string): string | null {
  const digits = raw.trim().slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return isIsoDate(iso) ? iso : null;
}

export function parseOfx(buf: Buffer): OfxParseResult {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const text = buf.toString('utf8');
  // An XML declaration or a closing leaf tag is the only reliable tell; OFXHEADER:100 vs
  // OFXHEADER="200" is the other. Reported, never acted on -- the scanner reads both.
  const dialect: 'sgml' | 'xml' = /^\s*<\?xml/i.test(text) || /OFXHEADER\s*=\s*"2/i.test(text) ? 'xml' : 'sgml';

  const tags = scan(text);
  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  let currency: string | null = null;
  let current: Record<string, string> | null = null;
  let rowIndex = 0;

  for (const tag of tags) {
    if (tag.name === 'CURDEF' && tag.value.length > 0 && currency === null) {
      currency = tag.value.toUpperCase();
      continue;
    }
    if (tag.name === 'STMTTRN') {
      if (!tag.closing) current = {};
      else if (current !== null) {
        const record = current;
        current = null;
        const cells = [record.DTPOSTED ?? '', record.NAME ?? '', record.TRNAMT ?? '', record.FITID ?? ''];
        const date = toIsoDate(record.DTPOSTED ?? '');
        const description = [record.NAME ?? '', record.MEMO ?? ''].map((part) => part.trim()).filter(Boolean).join(' ');
        const amountCents = parseAmountToCents(record.TRNAMT ?? '');
        if (date === null) {
          errors.push({ rowIndex, cells, reason: 'unparseable date' });
        } else if (description.length === 0) {
          errors.push({ rowIndex, cells, reason: 'missing description' });
        } else if (amountCents === null) {
          errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        } else {
          rows.push({
            rowIndex,
            // The bank's own string, kept verbatim: dedupHash trims it and nothing else reads it.
            rawDate: (record.DTPOSTED ?? '').slice(0, 8),
            date,
            rawDescription: description,
            // OFX signs a debit negative itself, so there is no sign convention to ask a person
            // about -- which is one of the two reasons this format is worth supporting at all.
            amountCents,
            // No running balance per row in OFX. <LEDGERBAL> is one balance for the whole file and
            // deliberately not read: recordBalanceSnapshot keys on (account, date), and one figure
            // whose date is the download time is not a statement date's closing balance.
            balanceCents: null,
            externalId: (record.FITID ?? '').trim() || null,
            cells,
          });
        }
        rowIndex += 1;
      }
      continue;
    }
    if (current !== null && !tag.closing && tag.value.length > 0) current[tag.name] = tag.value;
  }

  const first = rows.at(0)?.date;
  const last = rows.at(-1)?.date;
  const dateOrder: ParseResult['dateOrder'] =
    first !== undefined && last !== undefined && last < first ? 'newest_first' : 'oldest_first';

  return { rows, errors, currency, dialect, dateOrder };
}
```

- [ ] **Step 5: Run the OFX test and watch it pass, then wire it into the flow.**

Run: `npx vitest run tests/lib/import/ofx.test.ts --reporter=dot`
Expected: PASS, 7 tests.

In `src/lib/import/flow.ts`, `commitStagedImport` branches after `readStagedFile`:

```ts
  const buf = readStagedFile(input.stagingId);

  // v1.13.0 ruling R9: an OFX/QFX file skips the CSV mapping entirely -- there is nothing to map,
  // because the format names its own fields. Everything downstream is identical: computeRowHashes
  // still runs (commitImport ignores the hash for a row carrying an externalId, commit.ts:196-198),
  // commitImport is the same call, and undoImport partitions by transaction_imports and has never
  // looked at how a row was deduped.
  const ofx = looksLikeOfx(input.filename, buf) ? parseOfx(buf) : null;
  const parsed = ofx ?? parseCsv(buf, input.mapping);
  const hashed = computeRowHashes(input.accountId, parsed.rows);
```

The fork/repoint pair (`forkProfileIfBuiltin` / `setAccountProfile`) is skipped for an OFX file — an
OFX import has no mapping to fork, so pointing the account at a profile it did not use would be a
lie. `commitImport` is then called with `mapping: ofx ? null : input.mapping` and
`dateOrder: parsed.dateOrder`.

- [ ] **Step 6: Add the three presets.**

In `src/lib/import/presets.ts`, extend `BUILTIN_PRESET_NAMES` and add three entries. Each carries the
UNVERIFIED docblock verbatim in shape:

```ts
  /**
   * UNVERIFIED (v1.13.0, micro-ruling M7). No RBC export has been seen by this repo -- built from
   * RBC's published "download to CSV" layout, whose header row is:
   *   Account Type, Account Number, Transaction Date, Cheque Number, Description 1, Description 2, CAD$, USD$
   * Guessed: that Transaction Date is MM/DD/YYYY (RBC's own docs show both, by locale) and that the
   * CAD$ column is signed with debits negative. Both are the FIRST things to check against a real
   * file. Everything else is read straight off that header. Ask the owner for one redacted header
   * line and delete this paragraph when it matches.
   */
  'RBC Chequing/Visa': {
    name: 'RBC Chequing/Visa',
    institution: 'Royal Bank of Canada',
    mapping: {
      hasHeader: true,
      headerRows: 1,
      dateCol: 2,
      dateFormat: 'MM/DD/YYYY',
      // Two description columns joined with a single space, which is what descCols already does.
      descCols: [4, 5],
      amountMode: 'signed',
      amountCol: 6,
      debitCol: null,
      creditCol: null,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
      // Per-card attribution is account-specific, so it is set on the per-account fork, never baked
      // into a shared built-in -- the same reasoning the Amex preset's own comment gives.
      cardCol: null,
      // No running-balance column in RBC's documented layout.
      balanceCol: null,
    },
  },
  /**
   * UNVERIFIED (v1.13.0, micro-ruling M7). No BMO export has been seen by this repo -- built from
   * BMO's published transaction-history CSV, whose header row is:
   *   First Bank Card, Transaction Type, Date Posted, Transaction Amount, Description
   * Guessed: that the file opens with a one-line "following data is valid as of" preamble and a blank
   * line before that header (hence headerRows 3), and that Date Posted is YYYYMMDD. Both are the
   * FIRST things to check against a real file. Note that headerRows counts LINES, and papaparse's
   * skipEmptyLines: 'greedy' (src/lib/import/parse.ts) drops the blank one before this count is
   * applied -- so if a real file turns out to have no blank line, this becomes 2, not 3.
   */
  'BMO Chequing/Mastercard': {
    name: 'BMO Chequing/Mastercard',
    institution: 'Bank of Montreal',
    mapping: {
      hasHeader: true,
      headerRows: 3,
      dateCol: 2,
      dateFormat: 'YYYYMMDD',
      descCols: [4],
      amountMode: 'signed',
      amountCol: 3,
      debitCol: null,
      creditCol: null,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
      cardCol: null,
      balanceCol: null,
    },
  },
  /**
   * UNVERIFIED (v1.13.0, micro-ruling M7). No CIBC export has been seen by this repo -- built from
   * CIBC's published CSV, which has NO header row at all and whose columns are:
   *   Date, Description, Debit, Credit[, Card Number]
   * Guessed: that Date is YYYY-MM-DD and that the fifth column (present on the Visa export, absent on
   * chequing) is a card number. Both are the FIRST things to check against a real file. The card
   * column is deliberately NOT mapped as cardCol here for the reason every other built-in gives.
   */
  'CIBC Chequing/Visa': {
    name: 'CIBC Chequing/Visa',
    institution: 'CIBC',
    mapping: {
      hasHeader: false,
      headerRows: 0,
      dateCol: 0,
      dateFormat: 'YYYY-MM-DD',
      descCols: [1],
      // Two columns, never both filled: debit is money out, credit is money in. No sign convention
      // question arises in this mode (see ImportMapping.signConvention's own comment).
      amountMode: 'debit_credit',
      amountCol: null,
      debitCol: 2,
      creditCol: 3,
      signConvention: 'negative_is_spend',
      encoding: 'auto',
      skipRules: null,
      cardCol: null,
      balanceCol: null,
    },
  },
```

Before writing BMO's entry, grep `src/lib/dates.ts` for `'YYYYMMDD'`. If it is absent, add it to
`DATE_FORMATS` and its parser there **and nowhere else**, with a test in `tests/lib/dates.test.ts`
asserting `parseDate('20260803', 'YYYYMMDD')` is `'2026-08-03'` and that `'2026080'` fails.

Add to `tests/lib/import/presets.test.ts`:

```ts
it('v1.13.0: the three new presets parse, are marked UNVERIFIED in source, and round-trip', () => {
  for (const name of ['RBC Chequing/Visa', 'BMO Chequing/Mastercard', 'CIBC Chequing/Visa'] as const) {
    const mapping = getBuiltinPreset(name);
    expect(() => parseImportMapping(serializeImportMapping(mapping))).not.toThrow();
    expect(mapping.cardCol).toBeNull();
    expect(mapping.balanceCol).toBeNull();
  }
  const source = fs.readFileSync(path.join(root, 'src/lib/import/presets.ts'), 'utf8');
  expect((source.match(/UNVERIFIED/g) ?? []).length).toBe(3);
});
```

- [ ] **Step 7: Run every affected file and watch them pass.**

Run: `npx vitest run tests/lib/import tests/lib/dates.test.ts --reporter=dot`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/lib/import src/lib/dates.ts tests/lib/import tests/lib/dates.test.ts
git commit -m "feat(import): an in-repo OFX/QFX reader and RBC, BMO and CIBC presets"
```

---

# Wave C — the app layer (five parallel tasks)

Every task in this wave consumes Waves A and B only. Their file sets are disjoint. The repo does not
typecheck cleanly until all five are done — each task fixes the call sites in **its own files** and
leaves the rest failing, which is the point of the required `viewer` parameter.

### Task 10: quick-add, the note sub-row, and the manifest shortcut

**Files:**
- Create: `src/components/QuickAddTransaction.tsx`
- Modify: `src/app/(app)/transactions/page.tsx:1-81` (viewer, pickers, quick-add props)
- Modify: `src/app/(app)/transactions/actions.ts:51-97` (`manualEntryAction`), `:192-250`
  (`renameTransactionAction`), and every `getTransaction`/`listTransactions` call in the file
- Modify: `src/app/(app)/transactions/transactions-client.tsx:62-90` (props/state), `:553-593`
  (the row menu), and the top of the returned tree (the quick-add slot)
- Modify: `src/app/manifest.ts:18-33`
- Create: `tests/components/quick-add.test.tsx`
- Modify: `tests/app/transactions-client.test.tsx`, `tests/app/transactions-actions.test.ts`,
  `tests/app/manifest.test.ts`

**Interfaces:**
- Consumes: `listTransactions(filter, viewer)`, `getTransaction(id, viewer)` (Task 3);
  `listAccounts(opts, viewer)`, `acceptsTransactions(type)`, `listLoans(today, viewer)` (Task 4);
  `listAttributablePeople()`, `setLastAccountId(userId, accountId)` (Task 2);
  `upsertRenameRule({ …, actorRole })` and `ruleOwnedError(ownerName)` (Task 8).
- Produces:
  ```ts
  export function QuickAddTransaction(props: {
    accounts: { id: number; name: string }[];
    categories: CategoryLike[];
    people: { id: number; name: string }[];
    today: string;
    defaultAccountId: number | null;
    /** 'page' anchors it at #quick-add with a heading; 'card' is the dashboard's compact form. */
    variant: 'page' | 'card';
  }): React.ReactElement;
  ```
  Task 13 renders `<QuickAddTransaction variant="card" … />` on the dashboard; **this task owns the
  file**, Task 13 only imports it.

- [ ] **Step 1: Write the failing component test.**

Create `tests/components/quick-add.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';

vi.mock('@/app/(app)/transactions/actions', () => ({
  manualEntryAction: vi.fn(async () => ({ message: 'Transaction added.' })),
}));

const props = {
  accounts: [{ id: 1, name: 'Chequing' }, { id: 2, name: 'Pocket money' }],
  categories: [{ id: 3, name: 'Groceries', parentId: null, isIncome: false, isArchived: false }],
  people: [{ id: 1, name: 'Person One' }],
  today: '2026-08-27',
  defaultAccountId: 2,
  variant: 'page' as const,
};

describe('QuickAddTransaction (ruling R7)', () => {
  it('preselects the account this person used last', () => {
    render(<QuickAddTransaction {...props} />);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('2');
  });

  it('falls back to the cash option when there is no last account', () => {
    render(<QuickAddTransaction {...props} defaultAccountId={null} />);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('cash');
  });

  it('defaults the date to today', () => {
    render(<QuickAddTransaction {...props} />);
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-08-27');
  });

  it('carries the #quick-add anchor on the page variant and not on the card variant', () => {
    const { container, rerender } = render(<QuickAddTransaction {...props} />);
    expect(container.querySelector('#quick-add')).not.toBeNull();
    rerender(<QuickAddTransaction {...props} variant="card" />);
    expect(container.querySelector('#quick-add')).toBeNull();
  });

  it('sends direction=income only when the amount is typed with a leading plus', () => {
    render(<QuickAddTransaction {...props} />);
    const direction = document.querySelector('input[name="direction"]') as HTMLInputElement;
    const amount = screen.getByLabelText('Amount') as HTMLInputElement;
    amount.value = '12.34';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    expect(direction.value).toBe('spend');
    amount.value = '+12.34';
    amount.dispatchEvent(new Event('input', { bubbles: true }));
    expect(direction.value).toBe('income');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/components/quick-add.test.tsx --reporter=dot`
Expected: FAIL — `Cannot find module '@/components/QuickAddTransaction'`.

- [ ] **Step 3: Write the component.**

```tsx
'use client';

import { useActionState, useState } from 'react';
import { manualEntryAction } from '@/app/(app)/transactions/actions';
import { Field } from '@/components/ui/Field';
import { FormError } from '@/components/ui/FormError';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { groupCategories, type CategoryLike } from '@/lib/category-tree';

/**
 * v1.13.0 ruling R7 (item AK / PROD-4). With no bank sync, hand entry is the main loop for cash and
 * e-transfers, and until now the only way in was a seven-field form below fifty table rows.
 *
 * It posts to the EXISTING manualEntryAction rather than a new one: two entry points writing a
 * transaction through two code paths is how the two drift.
 *
 * DIRECTION IS DERIVED, NOT ASKED. Six controls fit on a phone; seven do not, and money-out is the
 * overwhelming majority. A leading '+' means money in -- the same convention a spreadsheet uses --
 * and the hint under the field says so, because a convention nobody is told is a trap.
 */
export function QuickAddTransaction({
  accounts,
  categories,
  people,
  today,
  defaultAccountId,
  variant,
}: {
  accounts: { id: number; name: string }[];
  categories: CategoryLike[];
  people: { id: number; name: string }[];
  today: string;
  /** users.last_account_id, or null on this person's first entry. */
  defaultAccountId: number | null;
  variant: 'page' | 'card';
}) {
  const [state, action] = useActionState(manualEntryAction, {} as { error?: string; message?: string });
  const [direction, setDirection] = useState<'spend' | 'income'>('spend');
  const grouped = groupCategories(categories);
  const accountValue = defaultAccountId === null ? 'cash' : String(defaultAccountId);

  const form = (
    <form action={action} className="grid gap-3 sm:grid-cols-6">
      <input type="hidden" name="direction" value={direction} />
      <Field label="Amount" className="sm:col-span-1" hint="Start with + for money in">
        <input
          name="amount"
          inputMode="decimal"
          placeholder="12.34"
          required
          className="field-control"
          onInput={(event) => setDirection(event.currentTarget.value.trim().startsWith('+') ? 'income' : 'spend')}
        />
      </Field>
      <Field label="Description" className="sm:col-span-2">
        <input name="description" required className="field-control" />
      </Field>
      <Field label="Date" className="sm:col-span-1">
        <input type="date" name="date" defaultValue={today} required className="field-control" />
      </Field>
      <Field label="Account" className="sm:col-span-1">
        <select name="accountId" defaultValue={accountValue} className="field-control">
          <option value="cash">My cash</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>{account.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Category" className="sm:col-span-1">
        <select name="categoryId" className="field-control">
          <option value="">Leave to the categorizer</option>
          {grouped.map((option) => (
            <option key={option.id} value={option.id}>
              {'  '.repeat(option.depth) + option.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Person" className="sm:col-span-1">
        <select name="attributedUserId" className="field-control">
          <option value="">Account default</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.name}</option>
          ))}
        </select>
      </Field>
      <input type="hidden" name="notes" value="" />
      <div className="sm:col-span-6">
        <SubmitButton className="w-fit">Add</SubmitButton>
        <FormError message={state.error} />
        {state.message ? <p role="status" className="mt-1 text-xs text-muted">{state.message}</p> : null}
      </div>
    </form>
  );

  if (variant === 'card') {
    return (
      <Card as="div">
        <CardHeader title="Quick add" description="Cash, an e-transfer, anything the bank will not send you." />
        <CardBody>{form}</CardBody>
      </Card>
    );
  }

  return (
    <Card as="div" id="quick-add">
      <CardHeader title="Quick add" description="Cash, an e-transfer, anything the bank will not send you." />
      <CardBody>{form}</CardBody>
    </Card>
  );
}
```

> Implementer note: `Field`, `FormError`, `SubmitButton`, `Card`/`CardHeader`/`CardBody` and
> `groupCategories` already exist — read their real props before writing the calls above and match
> them exactly. If `Card` does not accept an `id`, put the anchor on a wrapping `<div id="quick-add">`
> rather than adding a prop. Item J of PENDING-FIXES notes `Field` puts its hint inside the `<label>`;
> that is a known, separately-tracked defect and this task does not fix it.

- [ ] **Step 4: Wire the page, the action and the manifest.**

`src/app/(app)/transactions/page.tsx`:

```ts
  const viewer = await requireUser();
  // ...
  const accounts = listAccounts({}, viewer).filter((account) => acceptsTransactions(account.type));
  const page = listTransactions(filter, viewer);
  const lastAccountId = findUserById(viewer.id)?.lastAccountId ?? null;
  // Ruling R5: every attribution picker reads the same list -- active people, login or not. This is
  // also the fix for the pre-v1.13.0 inconsistency where this page listed deactivated members and
  // budgets/page.tsx did not.
  const people = listAttributablePeople().map((person) => ({ id: person.id, name: person.name }));
```

and pass `accounts`, `people`, `lastAccountId` down. `listLoans()` becomes `listLoans(today, viewer)`.

`manualEntryAction` gains three things — the note (R13), the last-account stamp (R7), and a guard
that the account accepts transactions (R10):

```ts
  const accountRaw = String(formData.get('accountId') ?? '');
  const accountId = accountRaw === 'cash' ? getOrCreateCashAccount(user.id, user.name) : Number(accountRaw);
  const account = getAccount(accountId);
  if (!account) return { error: 'Choose an account.' };
  // Ruling R10: an asset account holds a typed balance and nothing else. The picker already filters
  // them out; this is the second gate, because a select is a suggestion and a POST is a fact.
  if (!acceptsTransactions(account.type)) return { error: 'That account only holds a balance you type in.' };

  const rawNote = String(formData.get('notes') ?? '').trim();

  try {
    createManualTransaction({
      accountId,
      date,
      description: String(formData.get('description') ?? ''),
      amountCents: signed,
      categoryId: categoryRaw === '' ? null : Number(categoryRaw),
      attributedUserId: attributedRaw === '' ? null : Number(attributedRaw),
      // Ruling R13: the column, the action and the help page's promise all existed; only this line
      // was missing. It was `notes: null` from v1.0.0 to v1.12.1.
      notes: rawNote.length === 0 ? null : rawNote,
      userId: user.id,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not save the transaction.' };
  }
  // Ruling R7 / micro-ruling M5: remembered per person, so the next quick-add starts where this one
  // finished. Written after the transaction, so a failed write never moves the default.
  setLastAccountId(user.id, accountId);
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  return { message: 'Transaction added.' };
```

`renameTransactionAction` handles the R4 refusal:

```ts
  const outcome = upsertRenameRule({
    pattern: row.normalizedMerchant,
    matchType: 'exact',
    renameTo: trimmed,
    userId: user.id,
    actorRole: user.role,
  });
  if (!outcome.ok) return { error: ruleOwnedError(outcome.ownerName) };
```

Every `getTransaction(id)` in this actions file becomes `getTransaction(id, user)`.

`src/app/manifest.ts`:

```ts
    /**
     * v1.13.0 ruling R7. A home-screen long-press lands on the quick-add form instead of the
     * dashboard. One entry, not a menu: the manifest's own docblock records ruling 9 (no service
     * worker, no offline caching), and a shortcut list is a navigation surface that has to be kept
     * in step with the nav for ever.
     */
    shortcuts: [{ name: 'Add a transaction', short_name: 'Add', url: '/transactions#quick-add' }],
```

- [ ] **Step 5: Add the note sub-row to the row menu.**

In `transactions-client.tsx`, mirroring the existing `renaming` state exactly:

```tsx
  const [noting, setNoting] = useState<{ id: number; current: string } | null>(null);
  const [noteState, noteAction] = useActionState(saveNoteAction, initial);
```

In the `<RowMenu>` at `:553`, after "Rename…":

```tsx
                    <RowMenuButton onSelect={() => setNoting({ id: row.id, current: row.notes ?? '' })}>
                      Note…
                    </RowMenuButton>
```

and, immediately after each row's `</tr>`, the sub-row:

```tsx
                {noting?.id === row.id ? (
                  <tr>
                    {/* Ruling R13: an inline sub-row, not a dialog -- the note is about the row above
                        it and a modal would hide the charge the note is explaining. NOT an auto-save
                        (v1.11.0's rule): a free-text field that saves on blur loses a half-typed
                        sentence, which is the one thing a note must never do. */}
                    <td colSpan={COLUMN_COUNT}>
                      <form
                        action={noteAction}
                        onSubmit={() => setNoting(null)}
                        className="flex flex-col gap-2 py-2"
                      >
                        <input type="hidden" name="transactionId" value={row.id} />
                        <Field label={`Note for ${row.displayDescription ?? row.rawDescription}`}>
                          <textarea name="notes" defaultValue={noting.current} rows={2} className="field-control" />
                        </Field>
                        <div className="flex gap-2">
                          <SubmitButton className="w-fit">Save note</SubmitButton>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNoting(null)}>
                            Cancel
                          </button>
                        </div>
                        <FormError message={noteState.error} />
                      </form>
                    </td>
                  </tr>
                ) : null}
```

`COLUMN_COUNT` is the table's existing column count — read it off the `<thead>` in that file rather
than guessing. Render `<QuickAddTransaction variant="page" … />` immediately under the `PageGuide`,
above the filter bar.

- [ ] **Step 6: Run every affected file and watch them pass.**

Run: `npx vitest run tests/components/quick-add.test.tsx tests/app/transactions-client.test.tsx tests/app/transactions-actions.test.ts tests/app/manifest.test.ts --reporter=dot`
Expected: PASS. Add to `tests/app/manifest.test.ts`:

```ts
it('v1.13.0 ruling R7: exactly one shortcut, pointing at the quick-add anchor', () => {
  expect(manifest().shortcuts).toEqual([
    { name: 'Add a transaction', short_name: 'Add', url: '/transactions#quick-add' },
  ]);
});
```

- [ ] **Step 7: Commit.**

```bash
git add src/components/QuickAddTransaction.tsx "src/app/(app)/transactions" src/app/manifest.ts tests/components/quick-add.test.tsx tests/app/transactions-client.test.tsx tests/app/transactions-actions.test.ts tests/app/manifest.test.ts
git commit -m "feat(transactions): quick add, an inline note row, and a home-screen shortcut"
```

---

### Task 11: the Record-payment button, on both surfaces

**Files:**
- Create: `src/app/(app)/bills/actions.ts`
- Modify: `src/components/ComingUpCard.tsx:21-101`
- Modify: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:495-540` (the installment row menu)
  and the budget-category select block
- Create: `tests/app/bills-actions.test.ts`
- Modify: `tests/components/ComingUpCard.test.tsx`

**Interfaces:**
- Consumes: `recordInstallmentPayment(input)`, `RecordPaymentResult`, `setBudgetCategory(itemId,
  categoryId)`, `getWarrantyItem(id, viewer)` (Task 5); `listAccounts(opts, viewer)`,
  `acceptsTransactions(type)` (Task 4); `canActOnOwner`, `NOT_YOURS_ERROR` (Task 2);
  `findUserById(id).lastAccountId` (Task 2).
- Produces:
  ```ts
  // src/app/(app)/bills/actions.ts -- 'use server'
  export interface BillActionState { error?: string; message?: string }
  export async function recordBillPaymentAction(prev: BillActionState, formData: FormData): Promise<BillActionState>;
  export async function setBillCategoryAction(prev: BillActionState, formData: FormData): Promise<BillActionState>;
  ```
  `ComingUpCard` gains one required prop: `canRecord: boolean`. Task 13 passes it from the dashboard.

- [ ] **Step 1: Write the failing action test.**

Create `tests/app/bills-actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordBillPaymentAction, setBillCategoryAction } from '@/app/(app)/bills/actions';
import { resetTestDb } from '../helpers/db';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ origin: 'http://localhost:3000', host: 'localhost:3000' }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

describe('recordBillPaymentAction (ruling R8)', () => {
  beforeEach(() => {
    resetTestDb();
    // fixture: an admin, a chequing account with last_account_id pointing at it, a Property tax bill
    // item owned by the admin with one unpaid 180000 installment due 2026-06-30.
  });

  it('records the payment and says so', async () => {
    const form = new FormData();
    form.set('installmentId', String(installmentId));
    const result = await recordBillPaymentAction({}, form);
    expect(result.message).toMatch(/recorded/i);
    expect(unpaidCount(itemId)).toBe(0);
  });

  it('refuses on an installment belonging to another person (ruling R3)', async () => {
    mockSession(otherMemberId, 'member');
    const form = new FormData();
    form.set('installmentId', String(installmentId));
    expect((await recordBillPaymentAction({}, form)).error).toBe(NOT_YOURS_ERROR);
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('tells the person plainly when the row was already marked', async () => {
    const form = new FormData();
    form.set('installmentId', String(installmentId));
    await recordBillPaymentAction({}, form);
    expect((await recordBillPaymentAction({}, form)).error).toMatch(/already marked paid/i);
  });

  it('tells the person to add an account when they have none', async () => {
    deactivateEveryAccount();
    const form = new FormData();
    form.set('installmentId', String(installmentId));
    expect((await recordBillPaymentAction({}, form)).error).toMatch(/account/i);
  });

  it('setBillCategoryAction links and unlinks (ruling R11)', async () => {
    const link = new FormData();
    link.set('itemId', String(itemId));
    link.set('categoryId', String(propertyTaxCategoryId));
    expect((await setBillCategoryAction({}, link)).message).toBeTruthy();
    expect(getWarrantyItem(itemId, ADMIN)?.budgetCategoryId).toBe(propertyTaxCategoryId);

    const clear = new FormData();
    clear.set('itemId', String(itemId));
    clear.set('categoryId', '');
    await setBillCategoryAction({}, clear);
    expect(getWarrantyItem(itemId, ADMIN)?.budgetCategoryId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/app/bills-actions.test.ts --reporter=dot`
Expected: FAIL — `Cannot find module '@/app/(app)/bills/actions'`.

- [ ] **Step 3: Write the actions file.**

```ts
'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { acceptsTransactions, getAccount, listAccounts } from '@/lib/accounts';
import { isSameOrigin } from '@/lib/auth/csrf';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { canActOnOwner, NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { getWarrantyItem, setBudgetCategory } from '@/lib/warranty/items';
import { findInstallmentItem, recordInstallmentPayment } from '@/lib/warranty/installments';

/**
 * v1.13.0 rulings R8 and R11. Its own 'use server' file rather than an addition to
 * warranties/actions.ts because BOTH the dashboard's Coming-up card and the item detail page invoke
 * it, and a shared action that lives inside one page's folder reads as belonging to that page.
 *
 * tests/ops/use-server-exports.test.ts requires every export here to be an async function -- so the
 * state interface below is a type, and CROSS_ORIGIN_ERROR is imported, never re-exported.
 */
export interface BillActionState {
  error?: string;
  message?: string;
}

const CROSS_ORIGIN_ERROR = 'Cross-origin request rejected';
const idField = z.coerce.number().int().positive();

/**
 * Ruling R7/M5: the account this person last used, falling back to the first account they can list.
 * Re-resolved every time rather than trusted, because last_account_id has no ON DELETE and an
 * account can be deactivated between one payment and the next.
 */
function accountForPayment(userId: number, viewer: Parameters<typeof listAccounts>[1]): number | null {
  const remembered = findUserById(userId)?.lastAccountId ?? null;
  if (remembered !== null) {
    const account = getAccount(remembered);
    if (account && account.isActive && acceptsTransactions(account.type)) return account.id;
  }
  const first = listAccounts({}, viewer).find((account) => acceptsTransactions(account.type));
  return first?.id ?? null;
}

export async function recordBillPaymentAction(
  _prev: BillActionState,
  formData: FormData,
): Promise<BillActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = idField.safeParse(formData.get('installmentId'));
  if (!parsed.success) return { error: 'Invalid request.' };

  // Ruling R3: ownership lands regardless of visibility. A household member cannot record a payment
  // against somebody else's bill, because doing so writes a transaction in their name.
  const target = findInstallmentItem(parsed.data);
  if (target === null) return { error: 'That installment no longer exists.' };
  if (!canActOnOwner(target.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  const accountId = accountForPayment(user.id, user);
  if (accountId === null) {
    return { error: 'Add a bank or cash account first — a payment has to land somewhere.' };
  }

  const result = recordInstallmentPayment({
    installmentId: parsed.data,
    accountId,
    userId: user.id,
    today: todayIso(new Date(), readEnv().tz),
  });

  if (!result.ok) {
    if (result.reason === 'gone') return { error: 'That installment no longer exists.' };
    if (result.reason === 'no_account') {
      return { error: 'Add a bank or cash account first — a payment has to land somewhere.' };
    }
    // The matcher may have marked it from an imported transaction between the page load and the
    // click. Saying so is more honest than marking a second row (spec, item AN).
    return { error: 'That installment is already marked paid.' };
  }

  revalidatePath('/dashboard');
  revalidatePath('/transactions');
  revalidatePath('/warranties');
  revalidatePath(`/warranties/${target.itemId}`);
  return { message: 'Payment recorded and the installment marked paid.' };
}

export async function setBillCategoryAction(
  _prev: BillActionState,
  formData: FormData,
): Promise<BillActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const parsed = idField.safeParse(formData.get('itemId'));
  if (!parsed.success) return { error: 'Invalid request.' };
  const item = getWarrantyItem(parsed.data, user);
  if (!item) return { error: 'That item no longer exists.' };
  if (!canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  const raw = String(formData.get('categoryId') ?? '').trim();
  const categoryId = raw === '' ? null : Number(raw);
  if (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0)) {
    return { error: 'Invalid request.' };
  }

  setBudgetCategory(parsed.data, categoryId);
  revalidatePath('/budgets');
  revalidatePath(`/warranties/${parsed.data}`);
  return { message: categoryId === null ? 'Budget link removed.' : 'Budget category linked.' };
}
```

> Implementer note: `findInstallmentItem` is produced by Task 5 and is already in
> `src/lib/warranty/installments.ts` when this task starts. Do not add it again and do not edit that
> file in this task — it is not in this task's file set.

- [ ] **Step 4: Add the button to both surfaces.**

`ComingUpCard` gains `canRecord: boolean` and, on installment rows only, a form:

```tsx
              {/* Ruling R8: only a SCHEDULE row can be recorded. A cadence bill (a subscription) has
                  no installment row to mark, so the button would have nothing to write against --
                  which is why installmentId is the discriminator here and not the kind. */}
              {canRecord && bill.installmentId !== null ? (
                <form action={recordAction}>
                  <input type="hidden" name="installmentId" value={bill.installmentId} />
                  <SubmitButton className="btn--ghost btn--sm">Record payment</SubmitButton>
                </form>
              ) : null}
```

`canRecord` is `false` for a self viewer with no account they can post to, and `true` otherwise;
Task 13 computes it. The card stays a client component only if it is not one already — if it is a
server component today, wrap just the form in a tiny client child rather than converting the card.

On the item detail page, add "Record payment" to the installment `RowMenu` (`:502-526`), above
"Mark paid", for unpaid rows on a bill-kind item, plus the budget-category select in the Installments
card header:

```tsx
              {/* Ruling R11 / micro-ruling M9: a read-side link, and the smallest possible UI for it.
                  Changing it changes no limit, no rollover and no total -- it only lets the budgets
                  row say what it is accumulating toward. */}
              <form action={categoryDispatch} className="flex items-end gap-2">
                <input type="hidden" name="itemId" value={item.id} />
                <Field label="Accumulating in budget category">
                  <select name="categoryId" defaultValue={item.budgetCategoryId ?? ''} className="field-control">
                    <option value="">Not linked</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                </Field>
                <SubmitButton className="btn--ghost btn--sm">Save</SubmitButton>
              </form>
```

A deliberate button, not an auto-save — v1.11.0's rule for anything that changes what another page
says. Task 12 owns `[id]/page.tsx`, so it passes `categories` down; **this task consumes that prop**
and the Interfaces block of Task 12 declares it.

- [ ] **Step 5: Run every affected file and watch them pass.**

Run: `npx vitest run tests/app/bills-actions.test.ts tests/components/ComingUpCard.test.tsx --reporter=dot`
Expected: PASS. Existing `ComingUpCard` tests gain `canRecord={false}` unless they are asserting the
button.

- [ ] **Step 6: Commit.**

```bash
git add "src/app/(app)/bills" src/components/ComingUpCard.tsx "src/app/(app)/warranties/[id]/warranty-detail-client.tsx" tests/app/bills-actions.test.ts tests/components/ComingUpCard.test.tsx
git commit -m "feat(bills): record a due installment as a transaction from either surface"
```

---

### Task 12: ownership gates on the four destructive paths, and the audit writes

**Files:**
- Modify: `src/app/(app)/warranties/actions.ts:60-76` (the design docblock), `:411-431`
  (`deleteWarrantyAction`), `:469-489` (`deleteReceiptAction`), and every `getWarrantyItem` call in
  the file
- Modify: `src/app/(app)/warranties/page.tsx:32` (`searchWarrantyItems`)
- Modify: `src/app/(app)/warranties/[id]/page.tsx:17-45`
- Modify: `src/app/api/warranties/receipts/[id]/route.ts:64-66`
- Modify: `src/app/api/import/undo/route.ts:18-29`
- Modify: `tests/app/warranties-actions.test.ts`, `tests/api/import-undo.test.ts`
- Create: `tests/api/receipt-ownership.test.ts`

**Interfaces:**
- Consumes: `canActOnOwner`, `NOT_YOURS_ERROR` (Task 2); `appendAudit` (Task 2);
  `getWarrantyItem(id, viewer)`, `searchWarrantyItems(filter, viewer)` (Task 5);
  `getTransaction(id, viewer)` (Task 3); `listAccounts(opts, viewer)` (Task 4);
  `listInstallments`, `INSTALLMENT_DUE_SOON_DAYS` (unchanged); `listLoans(today, viewer)` (Task 4);
  `listAttributablePeople()` (Task 2).
- Produces: `/warranties/[id]/page.tsx` passes one new prop into `WarrantyDetailClient`:
  `categories: { id: number; name: string }[]` — **Task 11 consumes it** for the budget-category
  select. Its type is `{ id: number; name: string }[]`, sourced from
  `listCategories({ includeArchived: false })`.

- [ ] **Step 1: Write the failing tests.**

Add to `tests/app/warranties-actions.test.ts`:

```ts
describe('ruling R3: destructive actions are owner-or-admin, and are recorded', () => {
  it('a member deleting another person item is refused and the row survives', async () => {
    mockSession(memberId, 'member');
    const form = new FormData();
    form.set('itemId', String(adminOwnedItemId));
    expect((await deleteWarrantyAction({}, form)).error).toBe(NOT_YOURS_ERROR);
    expect(getWarrantyItem(adminOwnedItemId, ADMIN)).not.toBeNull();
    expect(listAudit()).toEqual([]);
  });

  it('an owner deleting their own item succeeds and appends exactly one audit row', async () => {
    mockSession(memberId, 'member');
    const form = new FormData();
    form.set('itemId', String(memberOwnedItemId));
    await expect(deleteWarrantyAction({}, form)).rejects.toThrow(); // redirect() throws by design
    expect(getWarrantyItem(memberOwnedItemId, ADMIN)).toBeNull();
    const audit = listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: memberId, action: 'delete_item', entity: 'warranty_items', entityId: memberOwnedItemId,
    });
  });

  it('an admin may delete anyone item, and the audit row names the admin', async () => {
    mockSession(adminId, 'admin');
    const form = new FormData();
    form.set('itemId', String(memberOwnedItemId));
    await expect(deleteWarrantyAction({}, form)).rejects.toThrow();
    expect(listAudit()[0]?.userId).toBe(adminId);
  });

  it('a member deleting a receipt on another person item is refused', async () => {
    mockSession(memberId, 'member');
    const form = new FormData();
    form.set('receiptId', String(receiptOnAdminItem));
    expect((await deleteReceiptAction({}, form)).error).toBe(NOT_YOURS_ERROR);
    expect(getWarrantyReceipt(receiptOnAdminItem)).not.toBeNull();
  });
});
```

Create `tests/api/receipt-ownership.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/warranties/receipts/[id]/route';

describe('ruling R3 / SEC-1: a receipt is not readable by the household at large', () => {
  it("user B's session gets 404 -- not 403 -- on user A's receipt", async () => {
    const response = await GET(requestAs(memberToken), { params: Promise.resolve({ id: String(receiptOnAdminItem) }) });
    // 404, deliberately: a 403 confirms the row exists, and the whole point of an incrementing
    // integer id is that confirming existence IS the leak.
    expect(response.status).toBe(404);
  });

  it('the owner still gets the bytes', async () => {
    const response = await GET(requestAs(adminToken), { params: Promise.resolve({ id: String(receiptOnAdminItem) }) });
    expect(response.status).toBe(200);
  });

  it('an admin gets any receipt', async () => {
    const response = await GET(requestAs(adminToken), { params: Promise.resolve({ id: String(receiptOnMemberItem) }) });
    expect(response.status).toBe(200);
  });
});
```

Add to `tests/api/import-undo.test.ts`:

```ts
it('ruling R3: a member cannot undo an import somebody else ran', async () => {
  const response = await POST(postAs(memberToken, { importId, confirm: true }));
  expect(response.status).toBe(403);
  expect(transactionCount()).toBe(before);
});

it('ruling R3: the importer can, and one audit row records it with the count', async () => {
  const response = await POST(postAs(adminToken, { importId, confirm: true }));
  expect(response.status).toBe(200);
  const audit = listAudit();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: 'undo_import', entity: 'imports', entityId: importId });
  expect(audit[0]?.detail).toMatch(/\d+ transactions/);
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx vitest run tests/app/warranties-actions.test.ts tests/api --reporter=dot`
Expected: FAIL — every refusal succeeds instead, and `listAudit()` is empty everywhere.

- [ ] **Step 3: Rewrite the design docblock, then gate the two delete actions.**

The docblock at `src/app/(app)/warranties/actions.ts:71-76` currently argues *for* the behaviour this
task removes. Replace it — a comment that argues for behaviour the code no longer has is worse than
no comment:

```ts
/**
 * Warranty items are household-VISIBLE and owner-EDITABLE (v1.13.0, ruling R3, spec
 * docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md).
 *
 * This file used to say: "owner_user_id is ATTRIBUTION, not access control, so there is deliberately
 * no requireAdmin() anywhere in this file." That was defensible for two adults and wrong for a
 * household with a fourteen-year-old and a login each: it meant any signed-in member could delete any
 * other member's item and its receipts, and no row recorded who did it (review 2026-08-27, SEC-2).
 *
 * What changed, and only this: the two DESTRUCTIVE actions are now owner-or-admin, via
 * canActOnOwner() in @/lib/auth/viewer, and both append an audit_log row. Creating and EDITING an
 * item stay open to every member -- a household shares its subscriptions and its contracts, and
 * requiring an admin to fix a typo would be the wrong lesson from a deletion problem. There is still
 * no requireAdmin() in this file, and that is still deliberate.
 */
```

```ts
export async function deleteWarrantyAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('itemId'));
  if (!id.success) return { error: 'Invalid request.' };

  // Ruling R3. Read the item as an ADMIN-equivalent viewer would -- getWarrantyItem(id, user) already
  // returns null for a self viewer, and for a household member it returns the row so canActOnOwner
  // can give the honest refusal below rather than "no longer exists".
  const item = getWarrantyItem(id.data, user);
  if (!item) return { error: 'That item no longer exists.' };
  if (!canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  try {
    if (!deleteWarrantyItem(id.data)) return { error: 'That item no longer exists.' };
  } catch (error) {
    return failure(error, 'Could not delete that item.');
  }

  // AFTER the delete succeeds, so a refused or failed attempt leaves no row. The name is the detail
  // because an entity_id whose row is gone tells a reader nothing on its own.
  appendAudit({ userId: user.id, action: 'delete_item', entity: 'warranty_items', entityId: id.data, detail: item.name });

  revalidateAll();
  // Outside the try: redirect() signals by throwing, and catching it would swallow it.
  redirect('/warranties');
}
```

```ts
export async function deleteReceiptAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();

  const id = idField.safeParse(formData.get('receiptId'));
  if (!id.success) return { error: 'Invalid request.' };
  const receipt = getWarrantyReceipt(id.data);
  if (receipt === null) return { error: 'That receipt no longer exists.' };

  // Ruling R3: a receipt has no owner of its own -- it inherits its parent item's, which is why the
  // check resolves the item rather than guessing from the receipt row.
  const item = getWarrantyItem(receipt.warrantyItemId, user);
  if (!item || !canActOnOwner(item.ownerUserId, user)) return { error: NOT_YOURS_ERROR };

  try {
    deleteWarrantyReceipt(id.data);
  } catch (error) {
    return failure(error, 'Could not remove that receipt.');
  }
  appendAudit({
    userId: user.id,
    action: 'delete_receipt',
    entity: 'warranty_receipts',
    entityId: id.data,
    detail: item.name,
  });
  revalidateAll(receipt.warrantyItemId);
  return { message: 'Receipt removed.' };
}
```

Every other `getWarrantyItem(x)` in this file becomes `getWarrantyItem(x, user)`.

- [ ] **Step 4: Gate the two pages and the two routes.**

`src/app/(app)/warranties/[id]/page.tsx`:

```ts
export default async function WarrantyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireUser();
  const { id: raw } = await params;
  if (!/^\d+$/.test(raw)) notFound();
  // v1.13.0 ruling R2/R3. getWarrantyItem returns null for an item this viewer may not see, so the
  // ownership check IS this line -- there is no second branch to forget, and the confirmed-exploitable
  // finding (review 2026-08-27, SEC-1: incrementing the integer) closes in the query.
  const item = getWarrantyItem(Number(raw), viewer);
  if (!item) notFound();

  const txn = item.transactionId === null ? null : getTransaction(item.transactionId, viewer);
  const today = todayIso();
  const loanSummary = listLoans(today, viewer).find((loan) => loan.itemId === item.id);

  return (
    <WarrantyDetailClient
      item={item}
      // ...
      people={listAttributablePeople().map((person) => ({ id: person.id, name: person.name }))}
      /* v1.13.0 ruling R11: the budget-category select on a bill's Installments card. Archived
         categories are excluded -- linking a bill to a category nobody budgets in would render a
         sinking-fund line against a row the budgets page does not show. */
      categories={listCategories().map((category) => ({ id: category.id, name: category.name }))}
      accounts={listAccounts({}, viewer).map((account) => ({ id: account.id, name: account.name }))}
      // ...
    />
  );
}
```

`src/app/(app)/warranties/page.tsx:32` — `searchWarrantyItems({ … }, viewer)`, with `viewer` from
`requireUser()`.

`src/app/api/warranties/receipts/[id]/route.ts`, replacing the row lookup at `:64-66`:

```ts
  // 4. The row. MUST-4.4: a receipt is only ever located by its database id.
  const receipt = getWarrantyReceipt(id);
  if (!receipt) return new Response('Not found', { status: 404 });

  // 5. v1.13.0 ruling R3. A receipt inherits its parent item's owner. 404 and NOT 403, deliberately:
  //    a 403 confirms the row exists, and with an incrementing integer id, confirming existence is
  //    itself the leak the review found (SEC-1). The body is byte-identical to the unknown-id case.
  const item = getWarrantyItem(receipt.warrantyItemId, user);
  if (!item || !canActOnOwner(item.ownerUserId, user)) return new Response('Not found', { status: 404 });
```

`src/app/api/import/undo/route.ts`:

```ts
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400 });

  const record = getImport(parsed.data.importId);
  if (!record) return Response.json({ error: 'Unknown import' }, { status: 404 });

  // v1.13.0 ruling R3. An undo deletes every transaction the import solely introduced, plus its Bayes
  // training and its loan and bill links -- a one-request operation against a plain integer id. The
  // person who ran the import, or an admin. 403 rather than 404 here: unlike a receipt, the import id
  // came from a list this member can already see, so hiding existence buys nothing.
  if (record.importedBy !== user.id && user.role !== 'admin') {
    return Response.json({ error: 'Only the person who ran this import, or an admin, can undo it.' }, { status: 403 });
  }

  if (!parsed.data.confirm) return Response.json(previewUndoImport(parsed.data.importId));

  // BEFORE the undo: the delete cascades, so the count is only knowable while the rows are still
  // there. An audit row that says "an import was undone" without saying how much it took is not
  // worth writing.
  const preview = previewUndoImport(parsed.data.importId);
  appendAudit({
    userId: user.id,
    action: 'undo_import',
    entity: 'imports',
    entityId: parsed.data.importId,
    detail: `${preview.transactionsToDelete} transactions from ${record.filename}`,
  });
  return Response.json(undoImport(parsed.data.importId));
```

> Implementer note: `importExists(importId)` is replaced by a `getImport(importId)` that returns
> `{ id, importedBy, filename }`. If `src/lib/import/commit.ts` has no such export, add the narrowest
> possible one there — that file is in no other task's set in this wave. Read
> `previewUndoImport`'s real return shape and use its actual count field name in `detail`.

- [ ] **Step 5: Run every affected file and watch them pass.**

Run: `npx vitest run tests/app/warranties-actions.test.ts tests/app/warranty-installments.test.ts tests/api --reporter=dot`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add "src/app/(app)/warranties/actions.ts" "src/app/(app)/warranties/page.tsx" "src/app/(app)/warranties/[id]/page.tsx" src/app/api/warranties/receipts src/app/api/import/undo src/lib/import/commit.ts tests/app/warranties-actions.test.ts tests/api
git commit -m "feat(security): owner-or-admin on every destructive path, recorded in the audit log"
```

---

### Task 13: the dashboard a self user sees, the Needs-a-look card, budgets and reports

**Files:**
- Create: `src/components/NeedsALookCard.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx:32-124` (scope, data), `:172-230` (the tiles and cards),
  `:320-329` (goals)
- Modify: `src/app/(app)/budgets/page.tsx:60-110` (the personal loop), and the props it passes
- Modify: `src/app/(app)/budgets/budgets-client.tsx:110-124` (the carry line)
- Modify: `src/app/(app)/reports/page.tsx` (every aggregate call, the person scope)
- Modify: `src/app/(app)/reports/reports-client.tsx` (hide the person split for a self viewer)
- Create: `tests/components/needs-a-look.test.tsx`
- Modify: `tests/app/dashboard.test.tsx`, `tests/app/budgets-page.test.tsx`, `tests/app/reports.test.tsx`

**Interfaces:**
- Consumes: `householdInsights({ today, viewer })`, `INSIGHTS_MAX_ROWS`, `type InsightRow` (Task 7);
  `upcomingBills({ …, viewer })`, `safeToSpend({ …, viewer })`, `sinkingFundsFor({ …, viewer })`
  (Task 7); `listGoals(opts, viewer)`, `listLoans(today, viewer)`, `listAccounts(opts, viewer)`,
  `netWorthOverTime(n, { today, viewer })` (Task 4); `cashflowTrend`, `topMerchants`,
  `personSpendSplit`, `categoryBreakdown`, `categoryMonthOverMonth`, `categoryYearOverYear`
  (Task 6, each with a trailing `viewer`); `expiringSoonItems(limit, ownerUserId, today, viewer)`
  (Task 5); `isSelfScoped`, `ownerScope` (Task 2);
  `QuickAddTransaction({ accounts, categories, people, today, defaultAccountId, variant })` (Task 10);
  `ComingUpCard({ …, canRecord })` (Task 11).
- Produces:
  ```ts
  export function NeedsALookCard(props: { rows: InsightRow[] }): React.ReactElement | null;
  ```

- [ ] **Step 1: Write the failing card test.**

Create `tests/components/needs-a-look.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import type { InsightRow } from '@/lib/insights';

const row = (over: Partial<InsightRow> = {}): InsightRow => ({
  kind: 'unusual',
  transactionId: 7,
  date: '2026-08-20',
  merchant: 'GROCERY STORE',
  amountCents: -92000,
  sentence: '$920.00 at GROCERY STORE — usually about $42.00.',
  ...over,
});

describe('NeedsALookCard (ruling R6)', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<NeedsALookCard rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per insight, with the sentence verbatim', () => {
    render(<NeedsALookCard rows={[row()]} />);
    expect(screen.getByText('$920.00 at GROCERY STORE — usually about $42.00.')).toBeTruthy();
  });

  it('links each row to the transaction it is about', () => {
    render(<NeedsALookCard rows={[row()]} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/transactions?q=GROCERY+STORE');
  });

  it('labels each kind so a reader knows what they are being told', () => {
    render(<NeedsALookCard rows={[row({ kind: 'duplicate' }), row({ kind: 'creep', transactionId: 8 })]} />);
    expect(screen.getByText('Charged twice')).toBeTruthy();
    expect(screen.getByText('Went up')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then write the card.**

Run: `npx vitest run tests/components/needs-a-look.test.tsx --reporter=dot` — FAIL, module not found.

```tsx
import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/Card';
import type { InsightKind, InsightRow } from '@/lib/insights';

/**
 * v1.13.0 ruling R6 (item AJ / PROD-2). Self-hiding, in the manner of LoansCard and ComingUpCard:
 * rendered unconditionally by the dashboard, absent when there is nothing to say. That is the whole
 * of the dismiss story -- a card with a dismiss button is a card somebody dismisses once and never
 * sees again.
 *
 * MUST-19.11: the SENTENCE is built in src/lib/insights.ts and rendered verbatim here. This component
 * owns only the three labels below, because they are a property of the card's layout and not of the
 * finding.
 */
const KIND_LABEL: Record<InsightKind, string> = {
  unusual: 'Unusually large',
  duplicate: 'Charged twice',
  creep: 'Went up',
};

export function NeedsALookCard({ rows }: { rows: InsightRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Needs a look"
        description="Charges that stand out this month. Nothing here is a problem on its own."
      />
      <ul className="border-t border-line text-sm">
        {rows.map((row) => (
          <li
            key={`${row.kind}-${row.transactionId}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
          >
            <span className="min-w-0">
              <span className="badge">{KIND_LABEL[row.kind]}</span>{' '}
              <span className="text-ink">{row.sentence}</span>
            </span>
            {/* A search link, not /transactions/<id>: there is no per-transaction page, and the
                merchant search lands on the charge WITH its neighbours, which is what somebody
                checking a duplicate actually wants to see. */}
            <Link href={`/transactions?q=${encodeURIComponent(row.merchant)}`} className="text-accent-text shrink-0">
              Look
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

Run it again: PASS, 4 tests.

- [ ] **Step 3: Rework the dashboard.**

```ts
  const viewer = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.person) ? params.person[0] : params.person;
  const urlScope = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  /**
   * v1.13.0 ruling R2. For a self viewer the person scope is THEIR OWN id, whatever the URL says --
   * and the pills that would let them change it are not rendered at all. Everything below reads
   * `scopeUserId`, so there is one place this decision is made.
   */
  const selfScoped = isSelfScoped(viewer);
  const scopeUserId = ownerScope(viewer) ?? urlScope;

  const month = currentMonth();
  const rows = scopeUserId === null ? budgetProgress(month) : budgetProgress(month, 'personal', scopeUserId);
  const totals = budgetTotals(rows);
  const trend = cashflowTrend(12, { endMonth: month, attributedUserId: scopeUserId }, viewer);
  const merchants = topMerchants({ from: monthStart(month), to: monthEnd(month), limit: 8, attributedUserId: scopeUserId }, viewer);
  const goals = listGoals({}, viewer);
  const people = listAttributablePeople();
  const accounts = listAccounts({}, viewer).filter((account) => acceptsTransactions(account.type));
  const hasAccounts = accounts.length > 0;
  const today = todayIso();

  const expiring = expiringSoonItems(EXPIRING_WIDGET_LIMIT, scopeUserId, today, viewer);
  const loans = listLoans(today, viewer);
  const totalOwedCents = loans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);

  /**
   * Ruling R2: NO net worth for a self viewer. Net worth is the household's balance sheet -- accounts
   * and loans have no per-person attribution the way a transaction does -- so there is no honest
   * scoped version of it to render. The query is not even run.
   */
  const netWorthLatest = selfScoped ? null : netWorthOverTime(1, { today, viewer }).at(0) ?? null;

  const bills = upcomingBills({ today, days: 30, includeOverdue: true, viewer });
  const spendPlan = safeToSpend({ month, today, viewer });
  const householdTotals = selfScoped ? totals : scopeUserId === null ? totals : budgetTotals(budgetProgress(month));

  // Ruling R6.
  const insights = householdInsights({ today, viewer });
  const lastAccountId = findUserById(viewer.id)?.lastAccountId ?? null;
```

In the tree:

- The `<nav aria-label="Whose money to show">` block (`:113-124`) renders only when `!selfScoped`.
  For a self viewer the header description becomes `'Your month.'`.
- `<QuickAddTransaction variant="card" accounts={accounts} categories={categories} people={people}
  today={today} defaultAccountId={lastAccountId} />` goes directly under the `PageGuide` — the same
  position it holds on `/transactions`, so the two surfaces are one habit.
- `<NeedsALookCard rows={insights} />` goes above `<ExpiringSoonCard>`: it is the card that asks for
  attention, and the cards below it are reference.
- The Net worth `StatTile` is already guarded by `netWorthLatest === null`, so ruling R2's exclusion
  needs no second branch here.
- `<LoansCard>` renders only when `!selfScoped` — a loan balance is household money.
- `<ComingUpCard … canRecord={hasAccounts} />`.
- The Top merchants card renders only when `!selfScoped`.
- The `{monthLabel(month)} budgets` card keeps rendering: for a self viewer `rows` is already their
  personal scope, and their own budget is exactly what R2 says they may see.

- [ ] **Step 4: Rework budgets and reports.**

`src/app/(app)/budgets/page.tsx`:

```ts
  const viewer = await requireUser();
  // ...
  const selfScoped = isSelfScoped(viewer);
  // Ruling R2: a self viewer sees no household scope at all -- a household limit is a household
  // total, which is the thing R2 names. And the personal loop is themselves and nobody else.
  const household = selfScoped ? null : budgetProgress(month, 'household', null);
  const householdRolloverIds = household === null ? [] : rolloverIdsFor('household', null, household);
  const people = selfScoped
    ? listAttributablePeople().filter((person) => person.id === viewer.id)
    : listAttributablePeople();
  const personal = people.map((person) => { /* unchanged */ });
  // Ruling R11 / micro-ruling M9.
  const today = todayIso(new Date(), tz);
  const sinkingFunds = sinkingFundsFor({
    month,
    today,
    rows: [...(household ?? []), ...personal.flatMap((entry) => entry.rows)],
    viewer,
  });
```

`sinkingFunds` is serialized to the client as a plain object
(`Object.fromEntries(sinkingFunds)`) — a `Map` is not a valid Server-Component prop.

`budgets-client.tsx`, immediately after the existing carry line at `:119-122`:

```tsx
              {sinkingFund ? (
                <p className="mt-1 text-xs text-muted">
                  {/* Ruling R11: rollover IS the envelope; this sentence is what makes it legible.
                      It reports what the carry already is -- it does not set a target and it does not
                      change the limit above it. */}
                  Accumulating for {sinkingFund.itemName} — {formatCents(sinkingFund.carriedCents)} of{' '}
                  {formatCents(sinkingFund.targetCents)} by {sinkingFund.dueDate}
                </p>
              ) : null}
```

where `const sinkingFund = sinkingFunds[row.categoryId] ?? null;` sits beside the existing
`suggestion` lookup.

`src/app/(app)/reports/page.tsx`: every aggregate call gains `viewer`; the person scope becomes
`ownerScope(viewer) ?? urlScope`; the person pills and the `personSpendSplit` section are passed
`showPersonSplit={!isSelfScoped(viewer)}` and `reports-client.tsx` renders that section only when it
is true. The export links to `/api/reports/export` are left alone — that route already reads
`userFromRequest` and Task 6 made `transactionsCsv` take a viewer, so its own handler passes it.

- [ ] **Step 5: Run every affected file and watch them pass.**

Run: `npx vitest run tests/components/needs-a-look.test.tsx tests/app/dashboard.test.tsx tests/app/budgets-page.test.tsx tests/app/reports.test.tsx --reporter=dot`
Expected: PASS. Add one assertion per page that a self viewer's render contains no net-worth figure,
no loans card and no other person's name.

- [ ] **Step 6: Commit.**

```bash
git add src/components/NeedsALookCard.tsx "src/app/(app)/dashboard" "src/app/(app)/budgets" "src/app/(app)/reports" tests/components/needs-a-look.test.tsx tests/app/dashboard.test.tsx tests/app/budgets-page.test.tsx tests/app/reports.test.tsx
git commit -m "feat(dashboard): a self-scoped dashboard, the Needs-a-look card and the sinking-fund line"
```

---

### Task 14: the users admin, the audit page, the nav filter, and the remaining call sites

**Files:**
- Modify: `src/app/(app)/settings/users/page.tsx:1-10`, `users-manager.tsx`, `actions.ts:28-50` and
  the end of the file
- Create: `src/app/(app)/settings/audit/page.tsx`
- Modify: `src/components/app-shell/nav.ts:52-70` (add `visibleNav`, do not touch `NAV`)
- Modify: `src/components/app-shell/AppShell.tsx` (or whichever component renders `NAV` — find it by
  grepping for `NAV.map`) to call `visibleNav(viewer)`
- Modify: `src/app/(app)/goals/page.tsx`, `goals-client.tsx`, `actions.ts` (import `canActOnOwner`
  from `@/lib/auth/viewer`, delete the local copy at `:27-29`)
- Modify: `src/app/(app)/review/page.tsx`, `actions.ts:35-68` (three R4 refusals)
- Modify: `src/app/(app)/import/page.tsx`, `import-client.tsx:508` (the `accept` attribute)
- Modify: `src/app/(app)/settings/accounts/page.tsx`, `accounts-manager.tsx`, `actions.ts` (the two
  new types)
- Modify: `src/app/(app)/settings/page.tsx` (a link to the audit page, admin only)
- Modify: `src/app/api/reports/{export,tax-export}/route.ts` (pass the viewer to `transactionsCsv`)
- Modify: `tests/app/settings-users.test.tsx`, `tests/app/goals-actions.test.ts`,
  `tests/app/review-actions.test.ts`, `tests/app/settings-accounts.test.tsx`
- Create: `tests/app/settings-audit.test.tsx`, `tests/components/nav.test.ts`

**Interfaces:**
- Consumes: `setUserVisibility`, `setUserCanSignIn`, `createPersonWithoutLogin`,
  `createPersonSchema`, `listUsers`, `listAttributablePeople` (Task 2); `listAudit`, `type AuditRow`
  (Task 2); `canActOnOwner`, `isSelfScoped`, `type Viewer` (Task 2); `upsertRuleFromCorrection({ …,
  actorRole })`, `ruleOwnedError` (Task 8); `listGoals/getGoal/listContributions(…, viewer)`
  (Task 4); `listAccounts(opts, viewer)`, `AccountType`, `acceptsTransactions` (Task 4);
  `transactionsCsv(filter, viewer)` (Task 6).
- Produces:
  ```ts
  // src/components/app-shell/nav.ts
  export function visibleNav(viewer: Viewer): NavItem[];
  // src/app/(app)/settings/users/actions.ts -- 'use server'
  export async function createPersonAction(prev: UsersFormState, formData: FormData): Promise<UsersFormState>;
  export async function setVisibilityAction(prev: UsersFormState, formData: FormData): Promise<UsersFormState>;
  ```

- [ ] **Step 1: Write the failing nav test.**

Create `tests/components/nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NAV, visibleNav } from '@/components/app-shell/nav';
import type { Viewer } from '@/lib/auth/viewer';

const household: Viewer = { id: 1, role: 'member', visibility: 'household' };
const child: Viewer = { id: 5, role: 'member', visibility: 'self' };

describe('visibleNav (micro-ruling M6)', () => {
  it('a household member sees the whole nav, byte-identical to before v1.13.0', () => {
    expect(visibleNav(household)).toEqual(NAV);
  });

  it('a self viewer loses Import, Review and Settings and keeps the rest', () => {
    expect(visibleNav(child).map((item) => item.href)).toEqual([
      '/dashboard', '/transactions', '/budgets', '/goals', '/warranties', '/reports', '/help',
    ]);
  });

  it('NAV itself is untouched, so the onboarding-coverage guard still greps the full list', () => {
    expect(NAV.map((item) => item.href)).toContain('/import');
    expect(NAV.map((item) => item.href)).toContain('/settings');
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then implement.**

Run: `npx vitest run tests/components/nav.test.ts --reporter=dot` — FAIL, `visibleNav` is not exported.

```ts
/**
 * v1.13.0 micro-ruling M6. NAV above is DELIBERATELY not filtered in place: guard 2 of
 * tests/ops/onboarding-coverage.test.ts greps the help page for every NAV href, and a nav that
 * shrinks per viewer would make that guard depend on who is asking. The filter lives here instead.
 *
 * A self viewer loses:
 *   Import   -- listAccounts returns only accounts they own, so the picker would be empty or wrong.
 *   Review   -- the categorization queue is household-wide by construction; there is no personal one.
 *   Settings -- every page under it is either admin-only or a household-global list. Their own
 *               notification preferences move nowhere: /settings/notifications is still reachable by
 *               URL and still per-user, it is just not signposted for an account that has no other
 *               reason to visit Settings.
 * Reports STAYS: ruling R2 forbids household totals, and Task 6 force-scopes every aggregate, so
 * what a self viewer sees there is their own spending, which is worth having.
 */
const SELF_HIDDEN_HREFS = new Set(['/import', '/review', '/settings']);

export function visibleNav(viewer: Viewer): NavItem[] {
  if (viewer.visibility !== 'self' || viewer.role === 'admin') return NAV;
  return NAV.filter((item) => !SELF_HIDDEN_HREFS.has(item.href));
}
```

- [ ] **Step 3: Write the failing users-admin test, then implement it.**

Add to `tests/app/settings-users.test.tsx`:

```tsx
it('ruling R5: an admin can add a person with no password at all', async () => {
  const form = new FormData();
  form.set('name', 'Person Three');
  form.set('username', 'user-3');
  expect((await createPersonAction({}, form)).message).toMatch(/added/i);
  const person = listUsers().find((row) => row.username === 'user-3');
  expect(person?.canSignIn).toBe(false);
  expect(person?.role).toBe('member');
});

it('ruling R2: an admin can limit a member to their own records', async () => {
  const form = new FormData();
  form.set('userId', String(memberId));
  form.set('visibility', 'self');
  expect((await setVisibilityAction({}, form)).message).toBeTruthy();
  expect(findUserById(memberId)?.visibility).toBe('self');
});

it('micro-ruling M1: the same call against an admin is refused with a plain sentence', async () => {
  const form = new FormData();
  form.set('userId', String(adminId));
  form.set('visibility', 'self');
  expect((await setVisibilityAction({}, form)).error).toMatch(/member first/i);
  expect(findUserById(adminId)?.visibility).toBe('household');
});

it('ruling R5: a person without a login cannot be promoted to admin', async () => {
  const person = await createPersonWithoutLogin({ name: 'Person Three', username: 'user-3' });
  const form = new FormData();
  form.set('userId', String(person.id));
  form.set('role', 'admin');
  expect((await setRoleAction({}, form)).error).toMatch(/sign in/i);
});
```

Implement the two new actions in `src/app/(app)/settings/users/actions.ts` in the shape of the four
already there — `isSameOrigin` first, `requireAdmin()` second, zod third, try/catch, `revalidatePath`,
message. `UsersManager` grows one column ("Sees") with a two-option select per member wired to
`setVisibilityAction`, and one extra form ("Add a person without a login") beside the existing create
form, with a sentence under it: *"They will show up wherever you choose who a transaction was for.
They cannot sign in and cannot be made an admin."*

If `setRoleAction` does not exist today, the last assertion above moves to `setUserCanSignIn`'s unit
test in Task 2 and the promotion guard lives in `createUser`/`setUserCanSignIn` only — check before
writing the test, and do not invent an action to satisfy it.

- [ ] **Step 4: Add the audit page.**

`src/app/(app)/settings/audit/page.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/session';
import { listAudit } from '@/lib/audit';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  delete_item: 'Deleted an item',
  delete_receipt: 'Deleted a receipt',
  undo_import: 'Undid an import',
};

/**
 * v1.13.0 ruling R3. Read-only, admin-only, and deliberately small: three kinds of destructive
 * action, who did each one and when. It is not a security log and it holds no request data -- see the
 * docblock on src/lib/audit.ts for why that boundary is where it is.
 */
export default async function AuditPage() {
  await requireAdmin();
  const rows = listAudit();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every deletion and every undone import, with who did it."
      />
      <Card>
        <CardHeader title="Recent activity" description="Newest first. Nothing here can be edited or removed." />
        {rows.length === 0 ? (
          <EmptyState title="Nothing to show" description="Nobody has deleted anything yet." />
        ) : (
          <TableWrap bare className="border-t border-line">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Which</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap">{row.at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{row.userName}</td>
                  <td>{ACTION_LABEL[row.action] ?? row.action}</td>
                  <td>{row.detail ?? `${row.entity} #${row.entityId}`}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
```

`ACTION_LABEL` falls back to the raw string because `audit_log.action` is free text by design — a page
that threw on an action it did not recognise would defeat the whole reason the column has no enum
CHECK. `EmptyState` must offer an action per `tests/ops/onboarding-coverage.test.ts` guard 1 — check
that guard's real rule before writing this and add a link back to Settings if it applies. Add a link
to `/settings/audit` from `src/app/(app)/settings/page.tsx`, rendered for admins only.

- [ ] **Step 5: Fix the remaining call sites.**

- `goals/actions.ts` — delete the local `canActOnOwner` (`:27-29`) and import it from
  `@/lib/auth/viewer`; its second parameter is now a `Viewer`, and `SessionUser` satisfies that
  structurally, so every call site is unchanged apart from the import.
- `goals/page.tsx` — `listGoals({ includeArchived }, viewer)`, `listContributions(id, viewer)`,
  people from `listAttributablePeople()`.
- `review/actions.ts` — the three rule-writing actions (`fixCategoryAction`,
  `applyToAllMatchingAction`, `markTransferAction`) pass `actorRole: user.role` and return
  `{ error: ruleOwnedError(result.ownerName) }` when the upsert refuses. `review/page.tsx` passes the
  viewer to `listTransactions`.
- `import/page.tsx` — `listAccounts({}, viewer).filter((account) => acceptsTransactions(account.type))`,
  so an asset account is never an import target (ruling R10).
- `import/import-client.tsx:508` — `accept=".csv,.ofx,.qfx,text/csv"`, and the sentence beside the
  input gains "…or an OFX/QFX file from your bank's *download for Quicken* option."
- `settings/accounts/*` — the type `<select>` gains `savings` and `asset` with one line of help each:
  *"Savings — like a chequing account, but left out of safe-to-spend."* / *"Asset — a house, a TFSA
  or an RRSP. You type the balance in; it takes no transactions and no imports."* `listAccounts` gains
  the viewer (this page is `requireAdmin()`, so the viewer is always household-scoped).
- `api/reports/export/route.ts` and `tax-export/route.ts` — pass the `userFromRequest` result to
  `transactionsCsv(filter, user)`. This is the CSV path SEC-1 named explicitly, so it is not optional.

- [ ] **Step 6: Run every affected file and watch them pass.**

Run: `npx vitest run tests/components/nav.test.ts tests/app/settings-users.test.tsx tests/app/settings-audit.test.tsx tests/app/goals-actions.test.ts tests/app/review-actions.test.ts tests/app/settings-accounts.test.tsx --reporter=dot`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add "src/app/(app)/settings" "src/app/(app)/goals" "src/app/(app)/review" "src/app/(app)/import" src/app/api/reports src/components/app-shell tests/components/nav.test.ts tests/app
git commit -m "feat(settings): visibility and no-login people, the audit page, and the remaining viewer call sites"
```

---

# Wave D — verification and release

### Task 15: docs, the ops guard, the full suite, the build, and the browser

**Files:**
- Create: `tests/ops/visibility-invariants.test.ts`
- Modify: `src/app/(app)/help/content.tsx`
- Modify: `INSTALL.md:216-230`
- Modify: `docs/PENDING-FIXES.md` (thirteen items)
- Modify: `tests/ops/onboarding-coverage.test.ts` **only if** the new `/settings/audit` page needs a
  help-page entry — check first; if `NAV` is unchanged, this file needs no edit and confirming that is
  part of the task

**Interfaces:**
- Consumes: everything. This task adds no new exported interface.

- [ ] **Step 1: Write the ops guard.**

Create `tests/ops/visibility-invariants.test.ts`, in the style of
`tests/ops/balance-invariants.test.ts` (a plain grep beside the behavioural tests, so a future change
that rots the boundary fails a test even when no fixture happens to cover it):

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Ruling R2 / item AF. The reader boundary is six modules deep and nothing in the type system says
 * "this function returns other people's money" -- so this is the second, independent guard: every
 * read-model helper a PAGE OR ROUTE calls must take a viewer.
 *
 * Micro-ruling M3: this is a NAMED require-list, not a blanket scan for every exported get*/list*.
 * Taken literally, a blanket scan pulls in internal resolvers no page ever calls with a user-supplied
 * id, and a guard that fails for a correct reason nobody can act on is a guard people delete. The
 * exempt list below carries the reason for each exemption, and adding to it is a decision somebody
 * has to write down.
 */
const REQUIRE_VIEWER: { file: string; fn: string }[] = [
  { file: 'src/lib/transactions.ts', fn: 'listTransactions' },
  { file: 'src/lib/transactions.ts', fn: 'getTransaction' },
  { file: 'src/lib/accounts.ts', fn: 'listAccounts' },
  { file: 'src/lib/goals.ts', fn: 'listGoals' },
  { file: 'src/lib/goals.ts', fn: 'getGoal' },
  { file: 'src/lib/goals.ts', fn: 'listContributions' },
  { file: 'src/lib/loans.ts', fn: 'listLoans' },
  { file: 'src/lib/warranty/items.ts', fn: 'getWarrantyItem' },
  { file: 'src/lib/warranty/search.ts', fn: 'searchWarrantyItems' },
  { file: 'src/lib/warranty/search.ts', fn: 'expiringSoonItems' },
  { file: 'src/lib/reports.ts', fn: 'categoryBreakdown' },
  { file: 'src/lib/reports.ts', fn: 'cashflowTrend' },
  { file: 'src/lib/reports.ts', fn: 'categoryMonthOverMonth' },
  { file: 'src/lib/reports.ts', fn: 'categoryYearOverYear' },
  { file: 'src/lib/reports.ts', fn: 'personSpendSplit' },
  { file: 'src/lib/reports.ts', fn: 'topMerchants' },
  { file: 'src/lib/reports.ts', fn: 'transactionsCsv' },
  { file: 'src/lib/bills.ts', fn: 'upcomingBills' },
  { file: 'src/lib/bills.ts', fn: 'safeToSpend' },
  { file: 'src/lib/bills.ts', fn: 'sinkingFundsFor' },
  { file: 'src/lib/insights.ts', fn: 'householdInsights' },
];

/** Exempt, WITH the reason. Nothing is exempt without one. */
const EXEMPT: { file: string; fn: string; why: string }[] = [
  {
    file: 'src/lib/accounts.ts',
    fn: 'getAccount',
    why: 'internal resolver: createManualTransaction, commitImport and commitStagedImport call it with an id they produced themselves and have no viewer to pass. No page or route resolves a user-supplied account id through it.',
  },
];

describe('ruling R2: every read-model helper takes a viewer', () => {
  for (const { file, fn } of REQUIRE_VIEWER) {
    it(`${file} :: ${fn}`, () => {
      const source = read(file);
      const signature = new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}?\\)\\s*:`, 'm').exec(source)?.[0];
      expect(signature, `${fn} is not exported from ${file}`).toBeTruthy();
      expect(signature).toMatch(/viewer\s*:\s*Viewer|viewer:\s*Viewer/);
      // Required, not optional: an optional viewer lets a forgotten call site compile into a leak.
      expect(signature).not.toMatch(/viewer\?\s*:/);
    });
  }

  it('every exemption carries a written reason', () => {
    for (const entry of EXEMPT) expect(entry.why.length).toBeGreaterThan(40);
  });
});

describe('ruling R3: the audit log is append-only', () => {
  it('nothing under src/ updates or deletes an audit_log row', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const name = path.relative(root, file).replace(/\\/g, '/');
      expect({ name, bad: /\.update\(\s*auditLog\s*\)|\.delete\(\s*auditLog\s*\)/.test(source) })
        .toEqual({ name, bad: false });
    }
  });
});

describe('ruling R1: no tenancy crept in', () => {
  it('no schema column or table is named for a household or tenant id', () => {
    const schema = read('src/db/schema.ts');
    expect(schema).not.toMatch(/household_id|householdId|tenant_id|tenantId/);
    for (const file of fs.readdirSync(path.join(root, 'drizzle')).filter((n) => n.endsWith('.sql'))) {
      expect(read(`drizzle/${file}`)).not.toMatch(/household_id|tenant_id/);
    }
  });
});
```

Run: `npx vitest run tests/ops/visibility-invariants.test.ts --reporter=dot` — expect PASS; if a
signature regex fails, fix the **signature**, not the regex.

- [ ] **Step 2: The help page.**

Add a short section under the existing accounts/people material, and correct two claims:

```tsx
        <h3>Someone's own view</h3>
        <p>
          On <strong>Settings → Users</strong>, an admin can set anyone to <em>Only their own
          records</em>. From then on that person sees the transactions attributed to them, their own
          budgets and goals, the items they own and their own upcoming bills — and nothing else. No
          account balances, no net worth, no household totals, and no other member's rows. It is the
          right setting for a child's account. It is not a way to run two families on one install:
          categories, merchant rules and the classifier are shared by everyone here, so a second
          household needs its own container (see INSTALL.md).
        </p>
        <h3>People who do not sign in</h3>
        <p>
          The same page can add someone as a <em>person only</em> — no password, no sign-in. They show
          up wherever you choose who a transaction was for, and nowhere else. Useful for a young child
          or a relative living with you.
        </p>
```

The existing "a note" claim (`src/app/(app)/help/content.tsx:161-168`) becomes true this release and
needs no edit — confirm that by reading it rather than assuming. Add one sentence to the import
section naming OFX/QFX and the three new presets, marking the presets as not yet checked against a
real file.

- [ ] **Step 3: INSTALL.md (ruling R15).**

Add item 7 at the end of **After the install** (`INSTALL.md:216-230`), exactly as the spec's Release
section quotes it. Do not put an owner name, an employer name or a Windows path anywhere in it.

- [ ] **Step 4: `docs/PENDING-FIXES.md`.**

Flip thirteen items. Each keeps its original text underneath — that text is the record of why the
alternatives were rejected. The shape, per the v1.12.0 precedent:

```markdown
**AF. No per-user data boundary (SEC-1 + PROD-1 combined) — SHIPPED in v1.13.0.** A `users.visibility`
flag, six query chokepoints that each take a viewer, and a `tests/ops/` guard that keeps them that
way. See `docs/superpowers/specs/2026-08-27-kids-scope-and-household-features-design.md`.
```

`AR` is closed with no code (`CLOSED in v1.13.0 — no code.` plus R12's reason). `AS` is
`DROPPED by the owner, 2026-08-27.` Relabel the two section headings that still say "v1.13.0
candidates" and "v1.14.0 candidates" to name v1.13.0.

- [ ] **Step 5: Run the whole suite. This is the first task that runs everything.**

Run: `npx vitest run` (or `npm test`), foreground, **timeout 600000**. Do not background it and poll.
Expected: all green. Read the pass/fail counts, not the exit code — a fully passing local suite can
still exit 1 on worker RPC teardown. Pay particular attention to:

- `tests/ops/use-server-exports.test.ts` — the new `bills/actions.ts` and the two new users actions.
- `tests/ops/client-bundle.test.ts` — `src/lib/insights.ts` imports `@/db` and must never reach a
  client component; `NeedsALookCard` takes rows as props and imports only the TYPE. `viewer.ts` is
  pure and may be imported anywhere.
- `tests/ops/predict-invariants.test.ts` — unchanged, and `src/lib/predict/` must still contain no
  `@/db` import. If this fails, `insights.ts` was put in the wrong directory (micro-ruling M4).
- `tests/ops/onboarding-coverage.test.ts` — guard 2 greps the help page for every `NAV` href. `NAV`
  is unchanged, so this should pass untouched; confirm that rather than assuming it.
- `tests/ops/row-controls.test.ts` — quick-add and the note sub-row pair no lone `<select>` with a
  Save button.
- `tests/ops/table-layout.test.ts` — the audit table and the note sub-row.
- `tests/ops/loan-invariants.test.ts` — exactly one place deletes a transaction row; `undoImport` is
  still it, and `recordInstallmentPayment` only inserts.

- [ ] **Step 6: Typecheck and build.**

Run: `npx tsc --noEmit`
Run: `npx next build`
Expected: both clean. This is the first point at which the whole repo typechecks — every `viewer`
call site must now be supplied.

- [ ] **Step 7: Real-browser check. NON-NEGOTIABLE.**

Set up the scratch database and dev server:

```bash
mkdir -p scratchpad/test-data
BUDGET_DB_PATH=scratchpad/test-data/budget.db npx next dev -p 3100
```

In a second shell, create the admin through the setup wizard at `http://localhost:3100/setup`
(username `testadmin`), or reset it afterwards with:

```bash
BUDGET_DB_PATH=scratchpad/test-data/budget.db node --experimental-strip-types \
  scripts/reset-admin-password.ts testadmin 'correct horse battery 9'
```

Seed, through the UI as `testadmin`: a chequing account and a cash account; a second member
`user-child` set to **Only their own records**; a person-without-a-login `user-toddler`; two
transactions attributed to each of the adult and the child; a `Property tax` bill item owned by the
adult with one overdue and one due-soon installment, linked to a budget category with rollover on;
and a synthetic OFX file written to `scratchpad/test-data/sample.ofx` containing three
`<STMTTRN>` blocks with invented merchants (`GROCERY STORE`, `CITY TAX OFFICE`, `PAYROLL DEPOSIT`).
**Never point the dev server at `.tmp-data/budget.db`.**

Then drive Playwright at **390** and **1280** px and report what you saw at each width:

1. Sign in as `user-child`. `/dashboard` shows their own figures only: **no** net-worth tile, **no**
   Loans card, **no** Top merchants card, **no** person pills, and no other member's name anywhere on
   the page. The nav has no Import, Review or Settings.
2. As `user-child`, navigate directly to `/warranties/<the adult's item id>` — expect the app's 404,
   not the item. Then `/api/warranties/receipts/<a receipt on the adult's item>` — expect 404.
3. Sign in as `testadmin`. `/dashboard` is byte-identical in structure to v1.12.1 plus two additions:
   the Quick add card and, if the fixtures produced one, the Needs-a-look card.
4. Quick add on `/dashboard`: type `12.34`, a description, submit. The row appears on
   `/transactions`. Reload `/dashboard` — the account select now defaults to the one just used.
5. `/transactions#quick-add` — the anchor scrolls to the form. Open a row kebab → **Note…**, type a
   note, save; then search for a word from that note and confirm the row comes back.
6. `/dashboard` Coming-up card → **Record payment** on the overdue installment. A transaction appears
   on `/transactions` for the right amount and today's date; the installment shows as paid on the
   item's detail page; pressing it a second time (via the detail page's kebab) says it is already
   marked paid rather than writing twice.
7. `/budgets` — the linked category's row shows the *Accumulating for Property tax…* line under the
   carry line, and it wraps rather than overflowing at 390.
8. `/import` — the file input accepts `sample.ofx`; preview shows three rows with sensible
   descriptions and signs; commit; then import the **same file again** and confirm three duplicates
   and zero added. Undo the first import as `testadmin` and confirm the rows go.
9. `/settings/audit` — the undo appears with `testadmin`'s name and a transaction count.
10. Both themes: the Needs-a-look badges and the audit table are legible in each.

If any check fails, fix it before Task 16.

- [ ] **Step 8: Commit.**

```bash
git add tests/ops/visibility-invariants.test.ts "src/app/(app)/help/content.tsx" INSTALL.md docs/PENDING-FIXES.md
git commit -m "docs: the self view, one family per instance, and the visibility ops guard"
```

---

### Task 16: v1.13.0

**Files:**
- Modify: `CHANGELOG.md` (a new section under `## Unreleased`)
- Modify: `package.json:3`
- Modify: `tests/ops/docker.test.ts` (a new `MUST-7.1: the 1.13.0 release` block)

**Interfaces:**
- Consumes: nothing. Release chores only.
- Produces: nothing.

- [ ] **Step 1: Write the failing release guard.**

Add to `tests/ops/docker.test.ts`, above the 1.12.0 block (newest first), in that block's shape:

```ts
  it('MUST-7.1: the 1.13.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.13.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.13\.0\] - 2026-08-27$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.13.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.13.0]'), changelog.indexOf('## [1.12.'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Only their own records/);
    expect(entry).toMatch(/Needs a look/);
    expect(entry).toMatch(/OFX/);
    expect(entry).toMatch(/Record payment/);
    expect(entry).toMatch(/audit/i);
    // A release that changes who may delete what has to say so, or somebody upgrades into a refusal.
    expect(entry).toMatch(/require you to own it/i);
    // The three presets are unverified and the release notes must not imply otherwise.
    expect(entry).toMatch(/have not yet been checked against a real file/i);
  });
```

Run: `npx vitest run tests/ops/docker.test.ts --reporter=dot`
Expected: FAIL — version is still 1.12.x and there is no 1.13.0 section.

- [ ] **Step 2: Write the CHANGELOG section and bump the version.**

Copy the `## [1.13.0] - 2026-08-27` block from the spec's **Release** section verbatim, directly under
`## Unreleased`, leaving `## Unreleased` in place and empty. Set `package.json`'s `"version"` to
`"1.13.0"`. Do not touch the 1.12.x or 1.11.0 sections — append-only discipline.

- [ ] **Step 3: Run the guard and the full suite once more.**

Run: `npx vitest run tests/ops/docker.test.ts --reporter=dot` — PASS.
Run: `npx vitest run` foreground, timeout 600000 — all green (read the counts, not the exit code).

- [ ] **Step 4: Commit. NO TAG. NO PUSH.**

```bash
git add CHANGELOG.md package.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.13.0"
```

Stop here and report. Tagging repoints GHCR `:latest`, and that is the owner's call, not this plan's.

---

# Self-review

## 1. Every scope item maps to a task

| Item | What it is | Tasks |
|---|---|---|
| **AF** (SEC-1, PROD-1) | the per-user data boundary | T1 (column), T2 (viewer + session), T3–T7 (six chokepoints), T10, T13, T14 (pages), T15 (ops guard) |
| **AG** (SEC-2) | owner-or-admin on destructive paths + audit log | T1 (`audit_log`), T2 (`appendAudit`/`listAudit`), T12 (four gates + writes), T14 (the admin page) |
| **AH** (SEC-6) | merchant-rule authorship | T1 (`last_modified_by`), T8 (the upsert), T10 (rename action), T14 (three review actions) |
| **AI** (PROD-8) | a person without a login | T1 (`can_sign_in`), T2 (writers + login + session), T14 (the admin form), T10/T13 (`listAttributablePeople` in both pickers) |
| **AJ** (PROD-2) | the "Needs a look" card | T7 (`src/lib/insights.ts`), T13 (the card + the dashboard) |
| **AK** (PROD-4) | quick-add | T1 (`last_account_id`), T2 (`setLastAccountId`), T10 (component, action, manifest), T13 (the dashboard slot) |
| **AL** (PROD-6) | notes and search | T3 (the search clause), T10 (the kebab item, the sub-row, `notes` on manual entry) |
| **AM** (PROD-10) | stale import per account | T8 |
| **AN** (PROD-3) | bill → transaction | T5 (`recordInstallmentPayment`, `findInstallmentItem`), T11 (the action + both surfaces) |
| **AO** (PROD-5) | OFX/QFX + three presets | T9 |
| **AP** (PROD-9) | savings and asset accounts | T1 (the enum), T4 (`AccountType` + two predicates), T10/T11/T14 (the pickers) |
| **AQ** (PROD-11) | the sinking-fund line | T1 (`budget_category_id`), T5 (`setBudgetCategory`), T7 (`sinkingFundsFor`), T11 (the select), T13 (the budgets line) |
| **AR** (PROD-7) | the kids' lane | **No feature code** (R12). Satisfied by AF + AI + per-user goals; stated on the help page in T15 and closed in `PENDING-FIXES.md` in T15. |
| **AS** | per-user export + user deletion | **DROPPED by the owner.** No task, deliberately. Recorded as dropped in `PENDING-FIXES.md` (T15) and absent from the CHANGELOG. |

Every ruling is also carried: R1 (T15's ops guard asserts no tenancy id), R2 (T1–T7, T10, T13, T14),
R3 (T2, T12, T14), R4 (T8, T10, T14), R5 (T2, T14), R6 (T7, T13), R7 (T1, T2, T10), R8 (T5, T11),
R9 (T9), R10 (T1, T4, T10, T14), R11 (T1, T5, T7, T11, T13), R12 (T15), R13 (T3, T10), R14 (T8),
R15 (T15), R16 (Global Constraints; T9 writes the OFX reader in-repo).

## 2. Wave file sets, and the disjointness check

**Wave A — sequential, T1 then T2.** No overlap: T1 owns `drizzle/*` and `src/db/schema.ts`; T2 owns
`src/lib/auth/*` and `src/lib/audit.ts`.

**Wave B — seven parallel tasks. Every file appears in exactly one row.**

| Task | Source files |
|---|---|
| T3 | `src/lib/transactions.ts` |
| T4 | `src/lib/accounts.ts`, `src/lib/networth.ts`, `src/lib/goals.ts`, `src/lib/loans.ts` |
| T5 | `src/lib/warranty/items.ts`, `src/lib/warranty/search.ts`, `src/lib/warranty/installments.ts` |
| T6 | `src/lib/reports.ts` |
| T7 | `src/lib/bills.ts`, `src/lib/budgets.ts`, `src/lib/insights.ts` |
| T8 | `src/lib/categorize/rules.ts`, `src/lib/categorize/engine.ts`, `src/lib/notify/evaluate/stale.ts`, `src/lib/notify/events.ts`, `src/lib/notify/render.ts` |
| T9 | `src/lib/import/ofx.ts`, `src/lib/import/parse.ts`, `src/lib/import/presets.ts`, `src/lib/import/flow.ts`, `src/lib/import/mapping.ts`, `src/lib/dates.ts` |

Checked: no `src/lib/**` file appears twice. `src/lib/import/commit.ts` is in **no** Wave B set — it
is edited once, in T12 (Wave C), which adds `getImport`. `src/lib/warranty/installments.ts` is T5's
alone; T11 consumes `findInstallmentItem` from it and does not edit it.

**Wave C — five parallel tasks. Every file appears in exactly one row.**

| Task | Source files |
|---|---|
| T10 | `src/components/QuickAddTransaction.tsx`, `src/app/(app)/transactions/{page.tsx,actions.ts,transactions-client.tsx}`, `src/app/manifest.ts` |
| T11 | `src/app/(app)/bills/actions.ts`, `src/components/ComingUpCard.tsx`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` |
| T12 | `src/app/(app)/warranties/{actions.ts,page.tsx,[id]/page.tsx}`, `src/app/api/warranties/receipts/[id]/route.ts`, `src/app/api/import/undo/route.ts`, `src/lib/import/commit.ts` |
| T13 | `src/components/NeedsALookCard.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/budgets/{page.tsx,budgets-client.tsx}`, `src/app/(app)/reports/{page.tsx,reports-client.tsx}` |
| T14 | `src/app/(app)/settings/**`, `src/components/app-shell/*`, `src/app/(app)/goals/*`, `src/app/(app)/review/*`, `src/app/(app)/import/{page.tsx,import-client.tsx}`, `src/app/api/reports/{export,tax-export}/route.ts` |

Checked, and the two near-misses are called out because they look like collisions and are not:
- `src/app/(app)/warranties/[id]/` — T11 owns `warranty-detail-client.tsx`, T12 owns `page.tsx`.
  Different files in one directory. T12's Interfaces block declares the `categories` prop T11 consumes.
- `src/app/(app)/import/` — T14 owns the page and the client; T9 (Wave B, already finished) owned
  `src/lib/import/*`. Different trees.

**Wave D — sequential, T15 then T16.** T15 owns the docs, the help page and the new ops guard; T16
owns `CHANGELOG.md`, `package.json` and `tests/ops/docker.test.ts`. No overlap.

## 3. Signature consistency

Cross-checked every name used in a later task against the task that produces it:

- `Viewer`, `ownerScope`, `isSelfScoped`, `canActOnOwner`, `NOT_YOURS_ERROR` — produced T2, consumed
  T3–T14. `SessionUser` gains `visibility` in T2 and therefore satisfies `Viewer` structurally, which
  is why no page ever constructs one.
- `listTransactions(filter, viewer)` / `getTransaction(id, viewer)` — produced T3, consumed T5
  (`recordInstallmentPayment`'s test), T10, T12, T14.
- `listAccounts(opts, viewer)`, `acceptsTransactions`, `countsTowardSafeToSpend` — produced T4,
  consumed T10, T11, T13, T14.
- `getWarrantyItem(id, viewer)`, `setBudgetCategory`, `recordInstallmentPayment`,
  `findInstallmentItem` — produced T5, consumed T11, T12.
- `upcomingBills({ …, viewer })`, `safeToSpend({ …, viewer })`, `sinkingFundsFor` — produced T7,
  consumed T13.
- `householdInsights`, `InsightRow`, `INSIGHTS_MAX_ROWS` — produced T7, consumed T13.
- `upsertRuleFromCorrection({ …, actorRole })` returning `RuleUpsertResult`, `ruleOwnedError` —
  produced T8, consumed T10 (`renameTransactionAction`) and T14 (three review actions).
- `staleImportKey(mondayIso, accountId)` — produced T8, one call site, in T8.
- `parseOfx`, `looksLikeOfx`, `CandidateRow.externalId` — produced T9, consumed T9 only.
- `QuickAddTransaction` — produced T10, consumed T13.
- `ComingUpCard`'s new `canRecord` prop — produced T11, consumed T13.
- `appendAudit`, `listAudit`, `AuditRow` — produced T2, consumed T12 and T14.
- `visibleNav(viewer)` — produced T14, consumed T14.

No name is used before the task that defines it, and no task defines a name a neighbour also defines.

## 4. Placeholder scan

No "TBD", no "as in Task N", no "add appropriate error handling", no "write tests for the above". Two
places deliberately tell the implementer to read the real code before writing (the `predict/anomalies`
signatures in T7 and the `Field`/`Card` props in T10) — those are instructions to verify against the
tree, not gaps in the plan, and each names the exact file and line to read.

## 5. One migration

`drizzle/0013_household_scope.sql` is created in T1 and no other task creates, edits or renumbers a
migration. `drizzle/0012_totp_last_counter.sql` belongs to v1.12.1 and T1 Step 1 stops the release if
it is missing. No shipped `.sql` file is edited. `accounts.type` widens with no DDL at all
(micro-ruling M2), and T1's test pins that `accounts` still carries no CHECK — so if a future
migration ever adds one, that test fails and the next reader learns why the rebuild was skipped.








