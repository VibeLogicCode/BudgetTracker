# Kids' scope, ownership and the household features — design

**Date:** 2026-08-27
**Status:** Approved by owner (rulings R1–R16 below); planner micro-rulings M1–M9 recorded here
**Target release:** v1.13.0 (built AFTER v1.12.1)
**Answers:** `docs/PENDING-FIXES.md` items **AF, AG, AH, AI** (privacy) and **AJ, AK, AL, AM, AN,
AO, AP, AQ, AR** (household features). Item **AS is DROPPED** by the owner and is not in scope.
**Evidence:** `docs/reviews/2026-08-27-fresh-eyes-review.md` — SEC-1, SEC-2, SEC-6, PROD-1 … PROD-11.
**Migration:** `drizzle/0013_household_scope.sql` — the only migration in this release.

---

## Problem

Two problems ship together because the second is only reachable through the first.

**The app has no reader boundary.** `requireUser()` checks that a session exists and nothing else.
Every owner column in the schema — `accounts.owner_user_id`, `transactions.attributed_user_id`,
`goals.owner_user_id`, `warranty_items.owner_user_id` — is a *label plumbed as an optional query
parameter*, never a filter derived from the session. A fourteen-year-old with a login reads the
adults' whole ledger (`src/lib/transactions.ts:113-142`), every loan balance and interest rate
(`src/lib/loans.ts:867-890`), every other member's personal budget in one page load
(`src/app/(app)/budgets/page.tsx:70-81`), and any item detail page by incrementing an integer
(`src/app/(app)/warranties/[id]/page.tsx:17-21`). Deletion is as unscoped as reading and no row
records who did it: `deleteWarrantyAction` (`src/app/(app)/warranties/actions.ts:411-431`) and
`POST /api/import/undo` (`src/app/api/import/undo/route.ts:18-29`) both stop at `requireUser()`.

**The household features that would make a kid's account worth having do not exist.** Insights are
computed and never rendered (`src/lib/predict/anomalies.ts` has exactly one importer, and it is a
notification evaluator). Hand entry — the main loop for a household with no bank sync — is a
seven-field form at the bottom of a long page
(`src/app/(app)/transactions/transactions-client.tsx:617-666`). `saveNoteAction`
(`src/app/(app)/transactions/actions.ts:169-190`) has no call sites while the help page promises
notes are editable. A bill that comes due cannot become a transaction. Only four bank presets exist
and only CSV is accepted. Net worth cannot hold a savings account or a house.

This release does not build multi-tenancy, an allowance subsystem, a scheduler, envelope budgeting,
or a per-user export. Each of those was considered and each is refused by a ruling below.

---

## Rulings

Rulings **R1–R16** are the owner's and are binding; they are reproduced verbatim and must not be
reopened. Rulings **M1–M9** are the planner's, each marked **PLANNER ruling — owner may reverse**,
and each states the code fact that forced it.

| # | Ruling |
|---|---|
| **R1** | One family per instance. Multi-tenancy permanently out of scope; no household/tenant id anywhere. |
| **R2** | Kids scope: `users.visibility` = `'household' \| 'self'`, default `'household'`, admin-set on Settings → Users. A `self` user sees ONLY: transactions attributed to them, their own personal budgets, their own goals, items/bills they own, their own Coming-up. NO account balances, NO net worth, NO reports of household totals, NO other members' rows. Dashboard renders only the cards that survive. Admin/household users' experience is byte-identical to today. |
| **R3** | Ownership checks land regardless of visibility: `/warranties/[id]`, receipts route, delete item/receipt, undo import → owner-or-admin (reuse `canActOnOwner()` shape from goals actions). Audit log: minimal append-only `audit_log(id, at, user_id, action, entity, entity_id)` written by delete paths and undo import; read-only list on an admin page. Keep it small. |
| **R4** | Members may no longer silently overwrite merchant rules (AH): member-level rule writes require the rule to be absent or created by the same user; otherwise return `{error}` telling them an admin owns the rule. |
| **R5** | Person without login (AI): `users.can_sign_in` boolean, default true; admin can create a user with it false (no password required); such users appear in attribution pickers, never on the login path, and cannot be made admin. |
| **R6** | Insights card (AJ): dashboard "Needs a look" card reusing `src/lib/predict/anomalies.ts`; self-hides when empty; respects R2 for self users. |
| **R7** | Quick-add (AK): a compact form at the top of /transactions and on the dashboard (amount, description, date default today, account, optional category, optional person). Default account = last account this user used, stored per user (`users.last_account_id` or a small settings table — planner chooses, prefer the column). Manifest `shortcuts` entry to /transactions#quick-add. |
| **R8** | Bill → transaction bridge (AN): "Record payment" on a Coming-up installment row and on the item's Installments card creates a manual transaction (amount = installment, date today, account = last used per R7, category = item's category if any) and marks the installment paid with that transaction in ONE db transaction. Must respect one-link-per-transaction. |
| **R9** | Bank presets (AO): RBC, BMO, CIBC — CSV presets plus OFX/QFX import. OFX parser must handle both SGML-style (OFX 1.x, no closing tags) and XML-style (2.x); map to the existing import row shape so dedupe/commit/undo are unchanged; FITID used as the dedupe key when present. No new dependencies — write the parser in-repo with tests on synthetic fixtures only. |
| **R10** | Account types (AP): add `savings` and `asset`. `savings` behaves like chequing for balances and transactions but is excluded from safe-to-spend. `asset` has a manual balance only (no transactions/import), counts in net worth. Widening the CHECK is a table rebuild — follow 0011's pattern and the CHANGELOG "Before updating" backup block. |
| **R11** | Sinking fund (AQ): no new concept — a per-category "target by month" is out; instead surface the existing rollover as an envelope: on the budgets page, a bill kind item may be linked to a category, and the budgets row shows "accumulating for &lt;bill&gt; — $X of $Y by &lt;date&gt;". Smallest useful version; planner may downscope to a documented how-to plus one UI hint if the linkage is more than one task. |
| **R12** | Kids' lane (AR): satisfied by R2 + R5 + goals already per-user; no allowance subsystem. Spec states this explicitly. |
| **R13** | Notes/search (AL): wire the existing `saveNoteAction` into the row kebab ("Note…") with an inline sub-row; transactions search includes notes and merchant; no full-text index. |
| **R14** | Stale import per account (AM): group by account over active accounts that have at least one import; one notification per stale account; existing event key pattern. |
| **R15** | INSTALL.md gains one paragraph: one family per instance; run a second container with its own data volume for another household. |
| **R16** | No new dependencies anywhere. |

### Planner micro-rulings

- **M1 — `visibility = 'self'` and `role = 'admin'` are mutually exclusive. PLANNER ruling — owner
  may reverse.** R2 says an admin's experience is byte-identical to today and R5 says a
  non-signing-in user can never be made admin; leaving `admin` + `self` reachable creates a third,
  undesigned state where `ownerScope()` has to choose between two rulings. `setUserVisibility()` and
  `createUserAction` refuse the combination. Enforced in application code, **not** as a SQL CHECK:
  this is a cross-column invariant and `ALTER TABLE ADD COLUMN` does not re-validate existing rows
  against a CHECK added that way — exactly the argument `drizzle/0007_loans.sql`'s header makes and
  `assertBalanceAnchorPairing` (`src/lib/warranty/items.ts:352-354`) already implements.

- **M2 — `accounts.type` is NOT rebuilt; 0013 contains no table rebuild. PLANNER ruling — owner may
  reverse.** R10 assumes a CHECK constraint exists. There is none: `drizzle/0000_init.sql:55-64`
  declares `` `type` text NOT NULL `` with no CHECK, and no later migration adds one (verified by
  grep across every file in `drizzle/`). The three-value enum is a Drizzle/TypeScript construct only
  (`src/db/schema.ts:85`) plus a zod enum (`src/lib/accounts.ts:26`). Adding `savings` and `asset`
  is therefore a TS-side widen with **zero DDL for that column**. Rebuilding `accounts` to *add* a
  CHECK was considered and rejected: six tables carry foreign keys into it (`transactions`,
  `imports`, `account_card_people`, `simplefin_account_links`, `account_balance_snapshots`,
  `loan_matcher_rules`), which would make the safest item in this release the riskiest, for a
  constraint the app already enforces at both the zod and the TypeScript boundary. The CHANGELOG
  **Before updating** backup block still ships — 0013 alters four shipped tables and creates one.

- **M3 — the `tests/ops/` visibility guard is a NAMED require-list, not a blanket `get*`/`list*`
  scan. PLANNER ruling — owner may reverse.** AF's fix text asks that "every exported
  `get*`/`list*` in those modules takes a viewer id". Taken literally that pulls in internal
  resolvers no page ever calls with a user-supplied id — `getAccount(id)` is called by
  `createManualTransaction` (`src/lib/transactions.ts:187`), `commitImport`
  (`src/lib/import/commit.ts:97-102`) and `commitStagedImport` (`src/lib/import/flow.ts:40`), none of
  which has a viewer to pass. The guard therefore holds a named list of the read-model helpers a page
  or route calls, plus a documented exempt list of internal resolvers with the reason beside each.

- **M4 — the "Needs a look" reader lives at `src/lib/insights.ts`, not under `src/lib/predict/`.
  PLANNER ruling — owner may reverse.** `tests/ops/predict-invariants.test.ts:18-28` fails any file
  under `src/lib/predict/` except `history.ts` that imports `@/db`, `@/lib/env` or a `node:` builtin.
  The card's reader needs the database, so it cannot live there. It owns its own slice query rather
  than refactoring `src/lib/notify/evaluate/anomalies.ts:100-116`, whose queries are entangled with a
  module-level fingerprint cache and per-user enqueue caps that a shared helper would have to carry
  into a page render.

- **M5 — `users.last_account_id` is the column (R7's stated preference), with no `ON DELETE`
  clause.** NO ACTION matches every other direct reference to `accounts` in this schema
  (`imports.account_id`, `account_card_people.account_id`). Accounts are soft-deleted via
  `is_active`, never dropped, so nothing can orphan it; quick-add re-resolves the id and falls back
  to the first account the viewer can list when it no longer resolves.

- **M6 — a `self` viewer's nav hides Import, Review and Settings; Reports stays, force-scoped.
  PLANNER ruling — owner may reverse.** `listAccounts` returns only the viewer's own accounts for a
  `self` user, so an unhidden Import page would offer a picker that is empty or wrong, and Review is a
  household-wide categorization queue by construction. `NAV` itself is **not** edited — a new
  `visibleNav(viewer)` filters at render, so `tests/ops/onboarding-coverage.test.ts` guard 2 (every
  NAV href documented on the help page) keeps passing untouched.

- **M7 — the RBC, BMO and CIBC presets ship UNVERIFIED.** `real-statements/` holds three files and
  all three are already-supported layouts (a TD Chequing/Debit export, a second TD-shaped chequing
  export, and an Amex Canada export). There is no RBC, BMO or CIBC sample anywhere in this repo, so
  each new preset is defined from the bank's publicly documented "download to CSV" layout, carries an
  `UNVERIFIED` docblock naming exactly what is guessed, and Task 9 opens with a step asking the owner
  for one **redacted header line** per bank.

- **M8 — `safeToSpend` takes a viewer and reads the PERSONAL budget scope for a `self` user.** Today
  it calls `budgetTotals(budgetProgress(month))`, which is the household scope by default
  (`src/lib/bills.ts:171`). Leaving that unscoped would put a household total on a kid's dashboard
  through the Coming-up card, which R2 forbids.

- **M9 — AQ ships at its smaller end.** One nullable `warranty_items.budget_category_id`, one
  `<select>` on the bill detail page, one read-side helper, one line on the budgets row. No
  per-category monthly target, no new table, and no change to `effectiveBudget`.

---

## Data model

### Migration `drizzle/0013_household_scope.sql`

All statements are additive. **No table rebuild** (ruling M2), so this migration has no pragma
concern of its own — `openDatabase()` (`src/db/client.ts:51-68`) already disables foreign keys
around the whole migration pass, re-enables them, and runs `foreign_key_check`, which v1.12.0 added
for 0011's rebuild and which 0013 simply inherits. **Do not** put a pragma into the `.sql` file:
Drizzle runs every pending migration inside one `BEGIN … COMMIT` and SQLite documents
`PRAGMA foreign_keys` as a no-op inside a transaction.

`drizzle/meta/_journal.json` gains
`{ "idx": 13, "version": "6", "when": 1756339200000, "tag": "0013_household_scope", "breakpoints": true }`.
There is no `0012` entry to write here — v1.12.1 adds `drizzle/0012_totp_last_counter.sql` and its
own journal entry. **0013 must not renumber, edit or absorb it**, and if the tree does not yet
contain 0012 when this release is built, the implementer stops and says so rather than taking the
number.

```sql
ALTER TABLE `users` ADD COLUMN `visibility` text NOT NULL DEFAULT 'household'
  CHECK (`visibility` IN ('household', 'self'));
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `can_sign_in` integer NOT NULL DEFAULT 1
  CHECK (`can_sign_in` IN (0, 1));
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

Three notes the migration header must carry:

1. **The two `users` CHECKs are forward-only.** `ALTER TABLE ADD COLUMN` does not re-validate
   existing rows against a CHECK added that way — the fact `drizzle/0007_loans.sql`'s header already
   records. It is harmless here precisely because these are *new* columns: every pre-existing row
   receives the `DEFAULT`, which satisfies both CHECKs by construction. A cross-column rule (M1's
   `admin` + `self`) is deliberately **not** attempted in SQL for the same reason.
2. **`action` and `entity` carry a LENGTH check, never a value enum.** An enum CHECK on `action`
   would make every future audited operation a table rebuild, and R3's instruction is "keep it
   small".
3. **`audit_log` has no `ON DELETE`.** Users are soft-deleted (`setUserActive`,
   `src/lib/auth/users.ts:186-194` — "Deactivate, never delete"), so `user_id` can never dangle, and
   an audit row that outlived its actor would be worse than one keeping the reference.

### Header inventory continuation (MUST-3.4)

`drizzle/0011_bill_installments.sql`'s header numbers the objects that live only in raw SQL, ending
at **31**. 0013's header restates 1–31 unchanged (0012 adds nothing to the list — a plain
`ALTER TABLE users ADD COLUMN totp_last_counter integer` with no constraint) and appends:

- **32.** the `visibility` CHECK on `users`, and the column arriving by ALTER TABLE ADD COLUMN (0013)
- **33.** the `can_sign_in` CHECK on `users`, and the column arriving by ALTER TABLE ADD COLUMN (0013)
- **34.** `users.last_account_id` arriving by ALTER TABLE ADD COLUMN (0013)
- **35.** `merchant_rules.last_modified_by` arriving by ALTER TABLE ADD COLUMN (0013)
- **36.** `warranty_items.budget_category_id` arriving by ALTER TABLE ADD COLUMN (0013)
- **37.** both CHECK constraints on `audit_log` (0013)

`audit_log_at_idx` and `audit_log_entity_idx` are plain indexes and **are** mirrored in
`src/db/schema.ts`, so they do not appear in the inventory — the rule `bill_installments_txn_uq`
already follows.

### Schema mirror — `src/db/schema.ts`

Every new column is declared **last** in its table, matching the documented convention that keeps the
TS mirror readable against `pragma table_info(...)`.

```ts
// users, appended after mustChangePassword (and after v1.12.1's totpLastCounter):
    /**
     * v1.13.0 ruling R2, added by drizzle/0013_household_scope.sql. 'self' scopes every read this
     * person makes to rows they own. This is a READER boundary, not a role: role still gates
     * actions. Micro-ruling M1: 'self' and role 'admin' are mutually exclusive, enforced in
     * setUserVisibility()/createUserAction rather than as a SQL CHECK, because a cross-column
     * CHECK added by ALTER TABLE ADD COLUMN does not re-validate existing rows.
     */
    visibility: text('visibility', { enum: ['household', 'self'] }).notNull().default('household'),
    /**
     * v1.13.0 ruling R5. false = a person the money is attributed to who has no login: they appear
     * in every attribution picker and never on the login path. attemptLogin refuses them before the
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

```ts
// merchantRules, appended last:
    /**
     * v1.13.0 ruling R4 (item AH / SEC-6). created_by is no longer overwritten on conflict; this
     * records who last changed the rule instead. NULL on every row written before v1.13.0 and on
     * any rule never edited since it was created.
     */
    lastModifiedBy: integer('last_modified_by').references(() => users.id),
```

```ts
// warrantyItems, appended last:
    /**
     * v1.13.0 ruling R11 (item AQ), micro-ruling M9. Bill-kind items only: the budget category this
     * bill accumulates against, so the budgets row can say what it is saving toward. A read-side
     * link and nothing else -- it changes no limit, no rollover and no total. NULL means "not
     * linked", which is every row before v1.13.0.
     */
    budgetCategoryId: integer('budget_category_id').references(() => categories.id),
```

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

`accounts.type`'s enum widens in place with no DDL (micro-ruling M2):

```ts
    type: text('type', { enum: ['chequing', 'credit', 'cash', 'savings', 'asset'] }).notNull(),
```

Its docblock records that this column has never carried a SQL CHECK, that the enum is therefore a
TypeScript-and-zod construct only, and that widening it in v1.13.0 needed no migration for exactly
that reason — so the next reader does not go looking for the rebuild.

---

## Visibility model

`role` keeps gating *actions*. `visibility` gates *reads*, and only reads.

### The viewer

`SessionUser` (`src/lib/auth/session.ts:13-18`) gains one field and `validateSession` (`:55-92`)
selects it, so every existing `requireUser()` call site already holds a viewer:

```ts
export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  /** v1.13.0 ruling R2. 'self' scopes every read to rows this person owns. */
  visibility: 'household' | 'self';
}
```

`src/lib/auth/viewer.ts` (new, pure — no `@/db` import, so a client component may import the type
and `tests/ops/client-bundle.test.ts` stays green):

```ts
export interface Viewer {
  id: number;
  role: 'admin' | 'member';
  visibility: 'household' | 'self';
}

/**
 * null means "no owner restriction" -- a household viewer, or an admin (micro-ruling M1 makes
 * admin+self unreachable through the UI, and the role check is kept anyway so a hand-edited
 * database row cannot lock an admin out of their own install).
 * A number means "every row this query returns must be owned by this user id".
 */
export function ownerScope(viewer: Viewer): number | null {
  return viewer.visibility === 'self' && viewer.role !== 'admin' ? viewer.id : null;
}

export function isSelfScoped(viewer: Viewer): boolean {
  return ownerScope(viewer) !== null;
}

/**
 * Ruling R3. Moved here from src/app/(app)/goals/actions.ts:27-29 so both actions files import one
 * copy: members may act on their OWN rows and on shared (null-owner) rows; admins may act on any.
 */
export function canActOnOwner(ownerUserId: number | null, viewer: Viewer): boolean {
  return ownerUserId === null || ownerUserId === viewer.id || viewer.role === 'admin';
}

/** One wording for a refused cross-owner read or write (MUST-19.11: one place per rule). */
export const NOT_YOURS_ERROR = 'That belongs to someone else in the household.';
```

### Entity × visibility matrix

`own` = rows whose owner column equals the viewer; `—` = the surface is not rendered at all for that
viewer. Write columns describe what the *action layer* permits and are unchanged for `household`
viewers.

| Entity | household: read | household: write | self: read | self: write |
|---|---|---|---|---|
| Transactions | all | all | own (`attributed_user_id`) | own only |
| Accounts | all | admin | own (`owner_user_id`), no balances rendered | none |
| Account balances / net worth | all | admin | — | — |
| Budgets — household scope | all | member (own rows) / admin | — | — |
| Budgets — personal scope | every member's | own / admin | own | own |
| Goals + contributions | all | own or shared / admin | own or shared | own or shared |
| Loans | all | any member | own | own |
| Warranty / subscription / contract / bill items | all | any member | own | own |
| Warranty receipts | all | any member | own item's | own item's |
| Bill installments | all | any member | own item's | own item's |
| Coming-up / safe-to-spend | household figures | — | own bills + own personal totals (M8) | — |
| Reports aggregates | all, `?person=` free | — | forced to own | — |
| Import history | all | any member | — (nav hidden, M6) | — |
| Review queue | all | any member | — (nav hidden, M6) | — |
| Merchant rules | admin page only | member upsert, own-or-absent (R4) | same | same |
| Insights ("Needs a look") | household | — | own transactions only | — |
| Audit log | admin page only | append-only | — | — |
| Users (attribution picker) | all active people | admin | all active people | — |

**Ownership checks (R3) land for every viewer, `household` included.** `canActOnOwner()` is reused
verbatim for delete-item, delete-receipt, `/warranties/[id]` and undo-import. One adjustment:
`warranty_items.owner_user_id` is `NOT NULL` (`src/db/schema.ts:497-499`), so the "owner is null
means shared" arm is unreachable there and the helper is always called with a non-null owner.

### The six query chokepoints

Each gains a **required trailing `viewer: Viewer` parameter**. Required, not optional: an optional
one lets a forgotten call site compile into a silent leak, and the compiler naming every call site is
the mechanism — the same argument ruling B15 made about `variant` in v1.12.0.

**1. `src/lib/transactions.ts`**

```ts
export function listTransactions(filter: TransactionFilter, viewer: Viewer): TransactionPage;
export function getTransaction(id: number, viewer: Viewer): TransactionRow | null;
```

`buildWhere` gains, unconditionally, `const scope = ownerScope(viewer); if (scope !== null)
clauses.push(eq(transactions.attributedUserId, scope));` — appended AFTER the caller's own
`attributedUserId` clause, so a self viewer who asks for someone else gets an unsatisfiable `AND`
rather than a silently rewritten filter. `getTransaction` returns `null` (never a throw) for a row
outside the scope, so `/warranties/[id]`'s linked-transaction lookup degrades to "no link" exactly as
it already does for a deleted transaction.

**2. `src/lib/accounts.ts`**

```ts
export function listAccounts(opts: { includeInactive?: boolean }, viewer: Viewer): AccountRecord[];
```

Self viewers get `eq(accounts.ownerUserId, scope)`. `getAccount(id)` is **unchanged** — micro-ruling
M3's exempt list, with its reason in the docblock.

**3. `src/lib/goals.ts`**

```ts
export function listGoals(opts: { includeArchived?: boolean; today?: string }, viewer: Viewer): GoalWithProgress[];
export function getGoal(goalId: number, viewer: Viewer, today?: string): GoalWithProgress | null;
export function listContributions(goalId: number, viewer: Viewer): ContributionRecord[];
```

A self viewer sees goals whose `ownerUserId` is their id **or NULL** — a shared household goal has no
other owner to leak, and R2's "their own goals" reads naturally to include the one everybody shares.
`listContributions` returns `[]` for a goal the viewer cannot see.

**4. `src/lib/loans.ts`**

```ts
export function listLoans(today: string, viewer: Viewer): LoanSummary[];
```

`eq(warrantyItems.ownerUserId, scope)` added to the existing query. Nothing else in `loans.ts`
changes — `applyPaymentMatchers`, `link()` and the reversal helpers are background machinery with no
viewer.

**5. `src/lib/warranty/search.ts` + `src/lib/warranty/items.ts`**

```ts
export function searchWarrantyItems(filter: WarrantySearchFilter, viewer: Viewer): WarrantySearchResult;
export function expiringSoonItems(limit: number, ownerUserId: number | null, today: string, viewer: Viewer): WarrantyListItem[];
export function getWarrantyItem(id: number, viewer: Viewer): WarrantyItemRow | null;
```

`searchWarrantyItems` pushes `i.owner_user_id = ?` with the scope in addition to any
`filter.ownerUserId` the caller supplied. `getWarrantyItem` returns `null` for another owner's id,
which is what turns `/warranties/[id]` into a `notFound()` with no extra branch on the page.

**6. `src/lib/reports.ts`**

```ts
export function categoryBreakdown(input: DateRange & { attributedUserId?: PersonScope; rollup?: boolean; includeIncome?: boolean }, viewer: Viewer): CategoryBreakdownRow[];
export function cashflowTrend(months: number, opts: { endMonth?: string; attributedUserId?: PersonScope }, viewer: Viewer): MonthTrendRow[];
export function categoryMonthOverMonth(input: { month: string; limit?: number; attributedUserId?: PersonScope }, viewer: Viewer): CategoryMonthTrend[];
export function categoryYearOverYear(input: { month: string; attributedUserId?: PersonScope }, viewer: Viewer): YoYRow[];
export function personSpendSplit(input: DateRange, viewer: Viewer): PersonSplitRow[];
export function topMerchants(input: DateRange & { limit?: number; attributedUserId?: PersonScope }, viewer: Viewer): TopMerchantRow[];
export function transactionsCsv(filter: TransactionFilter, viewer: Viewer): string;
```

All seven route through one new private helper so the rule is written once:

```ts
/** Ruling R2: a self viewer's person scope is their own id, whatever the URL asked for. */
function scopeFor(requested: PersonScope, viewer: Viewer): PersonScope {
  const own = ownerScope(viewer);
  return own === null ? requested : own;
}
```

`personSpendSplit` returns a single row for a self viewer; the reports page renders that section only
for household viewers, because a one-row split is not a split.

### Two more readers that carry a viewer

Not chokepoints in AF's sense, but they render household money and so must scope:

```ts
// src/lib/bills.ts
export function upcomingBills(input: { today: string; days: number; includeOverdue?: boolean; viewer: Viewer }): UpcomingBill[];
export function safeToSpend(input: { month: string; today: string; viewer: Viewer }): {
  budgetedRemainingCents: number; projectedSpendCents: number | null; billsDueCents: number;
};
```

`upcomingBills` passes `ownerScope(viewer)` into `unpaidInstallments`'s existing `ownerUserId` option
and adds the same predicate to the cadence half. `safeToSpend` reads
`budgetProgress(month, 'personal', scope)` when scoped (micro-ruling M8), household otherwise.

```ts
// src/lib/insights.ts (new)
export function householdInsights(input: { today: string; viewer: Viewer }): InsightRow[];
```

---

## Per-item design

### AF — the per-user data boundary (SEC-1, PROD-1)

**Current behaviour.** `src/lib/transactions.ts:113-142` applies a person clause only when a caller
passes one; `src/lib/accounts.ts:33-43`, `src/lib/goals.ts:190-227`, `src/lib/loans.ts:867-890`,
`src/lib/warranty/search.ts:217-220` and `src/lib/warranty/items.ts:356-367` carry no owner predicate
at all. `src/app/(app)/budgets/page.tsx:72-81` renders every active member's personal budget.
`src/app/(app)/dashboard/page.tsx:39-40,113-124` derives the person scope from `?person=`.

**Target.** `users.visibility='self'` scopes every read to the viewer; a household viewer's screens
are byte-identical to v1.12.1.

**Change.** The six chokepoints above. `budgets/page.tsx` narrows `people` to `[viewer]` when scoped;
`dashboard/page.tsx` forces `scopeUserId = ownerScope(viewer) ?? urlScope`, drops the person pills,
and omits the net-worth tile, `LoansCard`, the top-merchants card and the household budget totals for
a scoped viewer; `reports/page.tsx` forces the same and hides `personSpendSplit`; `visibleNav(viewer)`
hides Import, Review and Settings (M6).

**Tests.** One `tests/lib/visibility/*.test.ts` file per chokepoint, each asserting a `household`
viewer's result is byte-identical to today's and a `self` viewer sees only its own rows;
`tests/ops/visibility-invariants.test.ts` (M3's named require-list);
`tests/api/receipt-ownership.test.ts` (user B's session gets 404 on user A's receipt).

### AG — destructive actions and the audit log (SEC-2, R3)

**Current behaviour.** `deleteWarrantyAction` (`src/app/(app)/warranties/actions.ts:411-431`) and
`deleteReceiptAction` (`:469-489`) stop at `requireUser()`; `POST /api/import/undo`
(`src/app/api/import/undo/route.ts:18-29`) checks only session + `importExists`. No audit table
exists anywhere in the schema.

**Target.** Owner-or-admin on all four destructive paths, and one append-only row per event.

**Change.** `canActOnOwner` moves to `src/lib/auth/viewer.ts`. `deleteWarrantyAction` reads the item
first and refuses with `NOT_YOURS_ERROR`; `deleteReceiptAction` resolves the receipt's parent item and
does the same; `/warranties/[id]/page.tsx` passes the viewer to `getWarrantyItem` and `notFound()`s;
`api/warranties/receipts/[id]/route.ts` resolves the parent item and returns **404, not 403**, so a
guessed id cannot confirm the row exists; the undo route requires the import's `importedBy` to be the
caller, or the caller to be an admin. Each writes one row through:

```ts
// src/lib/audit.ts
export type AuditAction = 'delete_item' | 'delete_receipt' | 'undo_import';

export function appendAudit(input: {
  userId: number;
  action: AuditAction;
  entity: string;
  entityId: number;
  detail?: string | null;
  at?: string;
}): number;

export interface AuditRow {
  id: number; at: string; userId: number; userName: string;
  action: string; entity: string; entityId: number; detail: string | null;
}

/** Newest first. Admin page only. There is deliberately no update and no delete in this module. */
export function listAudit(limit?: number): AuditRow[];
```

The undo route calls `appendAudit` **before** `undoImport`, because the delete cascades and the row's
`detail` ("142 transactions removed") is only knowable from `previewUndoImport`.

**Tests.** User B's delete of user A's item returns `{error}` and leaves the row present; each of the
three paths appends exactly one row; `listAudit` is newest-first; an ops grep asserts nothing under
`src/` issues an `update` or `delete` against `auditLog`.

### AH — merchant rules (SEC-6, R4)

**Current behaviour.** `src/lib/categorize/rules.ts:85-88` —
`.onConflictDoUpdate({ target: […], set: { categoryId, renameTo, createdBy: input.createdBy } })`
overwrites the previous author. Member write paths:
`src/app/(app)/transactions/actions.ts:226` (rename-for-all) and
`src/app/(app)/review/actions.ts:35-38,53-56,65-68`.

**Target.** A member-level write succeeds only when the rule is absent or the same user created it.

**Change.**

```ts
export type RuleUpsertResult =
  | { ok: true; ruleId: number }
  | { ok: false; reason: 'owned_by_another'; ownerName: string };

export function upsertRuleFromCorrection(input: {
  pattern: string; matchType: MatchType; ruleKind: RuleKind;
  categoryId: number | null; renameTo?: string | null;
  createdBy: number | null; actorRole: 'admin' | 'member'; at?: Date;
}): RuleUpsertResult;
```

It reads the existing row first; when one exists, `created_by` is not the actor and the actor is not
an admin, it writes nothing and returns `{ ok: false, reason: 'owned_by_another', ownerName }`.
Otherwise it upserts with `set: { categoryId, renameTo, lastModifiedBy: input.createdBy }` —
**`createdBy` is no longer in the `set` object.** `upsertRenameRule` propagates the result;
`renameTransactionAction`, `fixCategoryAction`, `applyToAllMatchingAction` and `markTransferAction`
return the refusal as `{ error }`. One wording, one place:

```ts
export const ruleOwnedError = (ownerName: string) =>
  `${ownerName} set up this rule. Ask an admin to change it under Settings → Categories & rules.`;
```

**Tests.** An admin-authored rule survives a member upsert with `created_by` unchanged and no category
change; the same upsert by its own author succeeds and stamps `last_modified_by`; an admin upsert over
anyone's rule succeeds; a first-time write is unaffected.

### AI — a person without a login (PROD-8, R5)

**Current behaviour.** `createUserSchema` (`src/lib/auth/users.ts:35-40`) requires a password, so
every person is a login. `src/app/(app)/transactions/page.tsx:69` lists **all** users in the
attribution picker while `src/app/(app)/budgets/page.tsx:72` filters to active ones.

**Target.** An admin can create an attribution-only person who never reaches the login path and can
never be made admin.

**Change.**

```ts
// src/lib/auth/users.ts
export interface UserRecord {
  id: number; name: string; username: string; role: 'admin' | 'member';
  totpEnabled: boolean; isActive: boolean; mustChangePassword: boolean; createdAt: string;
  /** v1.13.0. */
  visibility: 'household' | 'self';
  canSignIn: boolean;
  lastAccountId: number | null;
}

/** R5: no password, never admin, never a session. username is still required and still unique. */
export const createPersonSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80),
  username: usernameSchema,
});
export function createPersonWithoutLogin(input: { name: string; username: string }): Promise<UserRecord>;

export function setUserVisibility(userId: number, visibility: 'household' | 'self'): void;
export function setUserCanSignIn(userId: number, canSignIn: boolean): void;
export function setLastAccountId(userId: number, accountId: number | null): void;
/** Attribution pickers. R5: includes people who cannot sign in; excludes deactivated people. */
export function listAttributablePeople(): UserRecord[];
```

`createPersonWithoutLogin` hashes 32 random bytes and discards them — `password_hash` is `NOT NULL`
and a fixed sentinel would be a shared, guessable value across installs. `attemptLogin`
(`src/lib/auth/login.ts:69`) becomes `if (!user || !user.isActive || !user.canSignIn)`, inside the
existing branch, so the dummy-hash timing defence still runs and a no-login username is
indistinguishable from an unknown one. `validateSession` adds `if (!row.canSignIn) return null`, which
kills any session predating the flag being cleared. `setUserVisibility` refuses `self` on an admin
(M1); `setUserCanSignIn(id, false)` refuses on an admin; promoting a `canSignIn: false` user to admin
is refused symmetrically. Both attribution pickers switch to `listAttributablePeople()`, resolving the
transactions/budgets inconsistency in favour of "active people, login or not".

**Tests.** A no-login person appears in `listAttributablePeople()` and `attemptLogin` refuses them
with `status: 'invalid'`; `setUserVisibility(adminId, 'self')` throws; a live session for a user whose
`canSignIn` is cleared stops validating; `createPersonWithoutLogin` stores a hash that no empty or
fixed string verifies against.

### AJ — the "Needs a look" card (PROD-2, R6)

**Current behaviour.** `src/lib/predict/anomalies.ts` exports `unusualVerdict`, `creepVerdict`,
`findDuplicates` and `hasEnoughHouseholdHistory`; the only importer in the repo is
`src/lib/notify/evaluate/anomalies.ts:10`.

**Target.** A self-hiding dashboard card listing this month's unusual charges, duplicate pairs and
crept subscriptions, each row linking to the transaction.

**Change.** `src/lib/insights.ts` (micro-ruling M4) reads one spend slice — the same
`(date >= sliceStart, is_transfer = 0, amount_cents < 0)` shape the evaluator uses at
`src/lib/notify/evaluate/anomalies.ts:100-116` — scoped by `ownerScope(viewer)`, and calls the three
pure verdict functions:

```ts
export type InsightKind = 'unusual' | 'duplicate' | 'creep';

export interface InsightRow {
  kind: InsightKind;
  /** The transaction the row links to. A duplicate pair links to the SECOND charge. */
  transactionId: number;
  date: string;
  merchant: string;
  amountCents: number;
  /** One sentence, already formatted. The card renders it verbatim. */
  sentence: string;
}

export const INSIGHTS_MAX_ROWS = 8;
export function householdInsights(input: { today: string; viewer: Viewer }): InsightRow[];
```

Returns `[]` — so the card renders nothing — when `hasEnoughHouseholdHistory(earliest, today)` is
false. `NeedsALookCard` follows `LoansCard`'s self-hiding shape exactly: rendered unconditionally,
absent when `rows.length === 0`.

**Tests.** Three fixtures (an outlier charge, a same-merchant same-amount pair inside the duplicate
window, a subscription whose amount stepped up) each produce exactly one row of the expected `kind`; a
thin history produces `[]`; a self viewer sees only rows from their own transactions.

### AK — quick-add (PROD-4, R7)

**Current behaviour.** The only entry form is at
`src/app/(app)/transactions/transactions-client.tsx:617-666`, below the table;
`src/app/manifest.ts:19-32` declares no `shortcuts`.

**Target.** A compact form at the **top** of `/transactions` (anchored `#quick-add`) and on the
dashboard, defaulting to the account this person last used.

**Change.** `src/components/QuickAddTransaction.tsx` (client): amount, description, date
(`defaultValue={today}`), account (`defaultValue={String(defaultAccountId ?? 'cash')}`), optional
category, optional person. It posts to the **existing** `manualEntryAction`, which gains one line —
`setLastAccountId(user.id, accountId)` after a successful `createManualTransaction` — plus
`revalidatePath('/dashboard')`. The long form at the bottom of `/transactions` stays: it carries
Direction, and quick-add is money-out unless the amount is typed with a leading `+`. The manifest
gains:

```ts
    shortcuts: [
      { name: 'Add a transaction', short_name: 'Add', url: '/transactions#quick-add' },
    ],
```

**Tests.** The component renders with the account preselected from `defaultAccountId`; a submit with a
leading `+` posts `direction=income`; `manualEntryAction` stamps `last_account_id`; `manifest()`
returns exactly one shortcut whose `url` is `/transactions#quick-add`.

### AL — notes and search (PROD-6, R13)

**Current behaviour.** `saveNoteAction` (`src/app/(app)/transactions/actions.ts:169-190`) has no call
sites; the row menu (`transactions-client.tsx:553-593`) offers Rename, Split, Create warranty, Assign
loan; search covers `rawDescription`, `normalizedMerchant` and `displayDescription`
(`src/lib/transactions.ts:126-137`); manual entry hard-codes `notes: null` (`actions.ts:79`).

**Target.** A "Note…" kebab item opening an inline sub-row under that transaction, and notes in the
search `OR`.

**Change.** One clause added to `buildWhere`'s existing `or(...)`:
`` sql`upper(coalesce(${transactions.notes}, '')) like ${needle} escape ${LIKE_ESCAPE}` ``. R13's
"merchant" half needs no edit — `normalizedMerchant` is already in that `or(...)`, and this spec
records that rather than adding a duplicate clause. `RowMenuButton` "Note…" sets a `noting` state
mirroring the existing `renaming` state; the sub-row is a `<tr>` with a textarea and a Save button
wired to `saveNoteAction`. **Not** an auto-save: v1.11.0's rule is that a free-text field which saves
on blur loses a half-typed sentence. `manualEntryAction` and quick-add pass the typed note instead of
the hard-coded `null`.

**Tests.** A search term matching only a note returns that row; the kebab exposes "Note…" with the
row-identifying accessible name; saving an empty note stores NULL; `tests/app/help.test.tsx` stays
green with no edit, because the help page's claim is now true.

### AM — stale import per account (PROD-10, R14)

**Current behaviour.** `src/lib/notify/evaluate/stale.ts:24-30` — one
`order by created_at desc limit 1` across every import; dedup key
`staleImportKey(mondayOfIsoWeek(today))` (`src/lib/notify/events.ts:272-274`), week-only.

**Target.** One message per stale account per week.

**Change.** The query becomes a group-by over active accounts that have at least one import:

```ts
const rows = getDb()
  .select({ accountId: accounts.id, accountName: accounts.name, newest: sql<string>`max(${imports.createdAt})` })
  .from(imports)
  .innerJoin(accounts, eq(accounts.id, imports.accountId))
  .where(eq(accounts.isActive, true))
  .groupBy(accounts.id)
  .all();
```

Each row over the threshold enqueues once. The dedup key gains the account id, keeping the existing
shape and the calendar bound MUST-3.12 requires:

```ts
export function staleImportKey(mondayIso: string, accountId: number): string {
  return `stale:${mondayIso}:${accountId}`;
}
```

Both arguments are required, so the compiler names the one call site. No new event id, so
`notification_prefs` needs no migration and the household gains no second toggle. `renderEvent`'s
`stale_import` member gains `accountName: string` and the body names the account.

**Tests.** Two accounts, one imported yesterday and one four weeks ago, enqueue exactly one message
naming the stale account; a second evaluation the same week enqueues nothing; the same account on a
later Monday enqueues again; an inactive account never fires; an install with zero imports still fires
nothing (Decision 10 survives).

### AN — bill → transaction (PROD-3, R8)

**Current behaviour.** `bill_installments.paidTxnId` exists and `markEarliestUnpaid`
(`src/lib/loans.ts:355-375`) is the only writer besides the manual mark. Nothing creates a transaction
from a bill; `src/lib/bills.ts:81-146` produces reminders only.

**Target.** "Record payment" on a Coming-up installment row and on the item's Installments card.

**Change.** One primitive in `src/lib/warranty/installments.ts`, one `db.transaction`:

```ts
export type RecordPaymentResult =
  | { ok: true; transactionId: number; installmentId: number }
  | { ok: false; reason: 'gone' | 'already_paid' | 'no_account' };

/**
 * Ruling R8. Creates the manual transaction and marks the installment paid with it, atomically.
 * One-link-per-transaction is STRUCTURAL, not checked: the transaction is created inside this call,
 * so it can carry no prior loan_payments or bill_installments link, and bill_installments_txn_uq
 * (drizzle/0011) refuses a second installment against the same transaction id for ever.
 */
export function recordInstallmentPayment(input: {
  installmentId: number;
  accountId: number;
  userId: number;
  today: string;
}): RecordPaymentResult;
```

Amount `-installment.amountCents` (a payment is money out). Date `input.today`. Description the item's
name. Category `warranty_items.budget_category_id ?? null`. Account the caller's
`users.last_account_id`, falling back to the first account they can list, `'no_account'` when they
have none.

`applyPaymentMatchers` runs inside `createManualTransaction` (`src/lib/transactions.ts:230`) and could
mark a *different* installment on the same bill first. The answer: the targeted mark runs **after**
that call and is a conditional `UPDATE … WHERE id = ? AND paid_at IS NULL`, the same guard
`markEarliestUnpaid` uses. If the matcher already took the row, the result is `already_paid` and the
page says so — which is honest: the payment is recorded and the schedule is marked, just not by this
button.

**Tests.** The happy path writes exactly one transaction and one `paid_at`/`paid_txn_id` pair; a
second click returns `already_paid` and writes nothing; the transaction carries the item's budget
category when linked and NULL otherwise; a user with no account gets `no_account` and no write;
`bill_installments_txn_uq` still refuses a second installment against that transaction id.

### AO — bank presets and OFX/QFX (PROD-5, R9)

**Current behaviour.** Four `BUILTIN_PRESETS` (`src/lib/import/presets.ts:27-142`); no `ofx|qfx`
anywhere in `src/`; the upload input is `accept=".csv,text/csv"`
(`src/app/(app)/import/import-client.tsx:508`).

**Target.** RBC, BMO and CIBC CSV presets, plus an in-repo OFX/QFX reader.

**Change, part 1 — presets. All three ship UNVERIFIED (micro-ruling M7)** and say so in their own
docblocks. Each is defined from the bank's publicly documented export layout; only header rows and
field names are recorded here, never a value.

| Preset | Header rows | Documented header fields | Mapping |
|---|---|---|---|
| `RBC Chequing/Visa` | 1 | `Account Type, Account Number, Transaction Date, Cheque Number, Description 1, Description 2, CAD$, USD$` | `dateCol 2`, `MM/DD/YYYY`, `descCols [4,5]`, `signed`, `amountCol 6`, `negative_is_spend` |
| `BMO Chequing/Mastercard` | 3 (a preamble line, a blank line, then the header) | `First Bank Card, Transaction Type, Date Posted, Transaction Amount, Description` | `dateCol 2`, `YYYYMMDD`, `descCols [4]`, `signed`, `amountCol 3`, `negative_is_spend` |
| `CIBC Chequing/Visa` | 0 (CIBC exports no header row) | `Date, Description, Debit, Credit[, Card Number]` | `dateCol 0`, `YYYY-MM-DD`, `descCols [1]`, `debit_credit`, `debitCol 2`, `creditCol 3` |

`cardCol` and `balanceCol` are `null` on all three, matching every non-TD-Chequing built-in: a card
column is account-specific and belongs on the per-account fork, not in a shared preset. `YYYYMMDD`
must exist in `DATE_FORMATS` (`src/lib/dates.ts`) before BMO's entry is added; if it does not, the
task adds it there and nowhere else.

**Change, part 2 — the OFX reader.** `src/lib/import/ofx.ts` (new, no dependencies):

```ts
export interface OfxParseResult {
  rows: CandidateRow[];
  errors: RowError[];
  /** From <CURDEF>, uppercased, or null. Recorded for the preview banner; never enforced. */
  currency: string | null;
  /** 'sgml' for OFX 1.x (unclosed tags), 'xml' for 2.x. Reported so the preview can say so. */
  dialect: 'sgml' | 'xml';
  dateOrder: ParseResult['dateOrder'];
}

/** Throws ImportLimitError for an oversized file, exactly as parseCsv does. Never throws otherwise. */
export function parseOfx(buf: Buffer): OfxParseResult;
```

The parser is a small tag scanner, not an XML library: it strips the header block up to `<OFX>`, then
walks `<TAG>value` pairs, treating a tag immediately followed by another opening tag as a container
and everything else as a leaf — which reads OFX 1.x's unclosed SGML and 2.x's fully closed XML with
one loop. Per `<STMTTRN>` it reads `FITID`, `DTPOSTED` (first 8 characters, `YYYYMMDD`), `TRNAMT`
(through `parseAmountToCents`, sign as stated — OFX signs debits negative, so no sign convention is
asked for), and `NAME` then `MEMO` for the description.

`CandidateRow` (`src/lib/import/parse.ts:19-37`) gains one optional field so OFX rows flow through the
existing pipeline untouched:

```ts
  /**
   * v1.13.0 ruling R9: the provider's stable per-transaction id (OFX FITID). null for every CSV row.
   * commitImport ALREADY dedups on this when set and stores NULL in dedup_hash for such a row
   * (src/lib/import/commit.ts:196-198,231-233) -- the SimpleFIN path built that, and OFX needs no
   * change there at all.
   */
  externalId?: string | null;
```

`commitStagedImport` gains a branch: a staged `.ofx`/`.qfx` file parses through `parseOfx` and its
rows still go through `computeRowHashes` (a hash is computed and then ignored for rows carrying an
`externalId`, which is exactly what `commitImport` already does at `commit.ts:196-198`). The upload
input accepts `.csv,.ofx,.qfx,text/csv`. Undo is unchanged: `undoImport` partitions by
`transaction_imports` and has never looked at how a row was deduped.

**Tests.** Synthetic fixtures **only** — an SGML OFX 1.x buffer and an XML 2.x buffer, both written by
the test file itself with invented merchants (`GROCERY STORE`, `CITY TAX OFFICE`, `PAYROLL DEPOSIT`)
and invented account ids. Assertions: both dialects yield identical `CandidateRow[]`; FITIDs land on
`externalId`; a re-import of the same buffer adds zero rows and reports three duplicates; a file with
no `<STMTTRN>` returns `rows: []` and does not throw; an oversized buffer throws `ImportLimitError`.

### AP — savings and asset accounts (PROD-9, R10)

**Current behaviour.** `src/db/schema.ts:85` and `src/lib/accounts.ts:7,26` — three types.
`netWorthOverTime` (`src/lib/networth.ts:217-250`) sums `balancesAsOf` over `listAccounts()` minus
`debtOverTime`.

**Target.** `savings` behaves like `chequing`; `asset` carries a manually-typed balance only.

**Change.** The Drizzle enum and the zod enum widen (no DDL — M2). Two predicates in
`src/lib/accounts.ts` so each rule is written once:

```ts
export type AccountType = 'chequing' | 'credit' | 'cash' | 'savings' | 'asset';

/** R10: an asset holds a manually-typed balance and never transactions or an import. */
export function acceptsTransactions(type: AccountType): boolean {
  return type !== 'asset';
}

/** R10: savings is excluded from safe-to-spend; an asset is not spendable at all. */
export function countsTowardSafeToSpend(type: AccountType): boolean {
  return type === 'chequing' || type === 'cash';
}
```

`asset` accounts are filtered out of the import account picker, quick-add and manual entry;
`getOrCreateCashAccount` is untouched. `netWorthOverTime` needs **no change** — it already sums every
account's resolved balance and `account_balance_snapshots` already accepts `source: 'manual'`, which
is precisely what an asset account is. Settings → Accounts' type `<select>` gains the two options and
its existing reconcile control is the manual-balance path an asset uses.

**Tests.** An `asset` account is absent from the import picker and both entry forms;
`countsTowardSafeToSpend` is false for `savings` and `asset`; net worth includes a manual `asset`
snapshot; creating an account with each of the five types round-trips.

### AQ — the sinking-fund line (PROD-11, R11, M9)

**Current behaviour.** `src/lib/bills.ts:164-185` reports three separate figures;
`src/app/(app)/budgets/budgets-client.tsx:119-122` already renders "`$X` plus `$Y` carried" for a
rollover row; `src/lib/budgets.ts:352-383` is the rollover carry.

**Target.** A budgets row that names the bill it is accumulating for.

**Change.** The bill detail page gains a "Budget category" `<select>` (bill kind only) writing
`warranty_items.budget_category_id`. One read-side helper:

```ts
// src/lib/bills.ts
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

/** Ruling R11: read-side only. Never changes a limit, a rollover or a total. */
export function sinkingFundsFor(input: {
  month: string; today: string; rows: BudgetRow[]; viewer: Viewer;
}): Map<number, SinkingFund>;
```

`budgets-client.tsx` renders one extra line under the existing carry line:
`Accumulating for {itemName} — {formatCents(carriedCents)} of {formatCents(targetCents)} by {dueDate}`.

**Tests.** A bill linked to a category with one unpaid installment produces one map entry; an unlinked
bill produces none; a fully-paid schedule produces none; the helper performs no write.

### AR — the kids' lane (PROD-7, R12)

**No feature code.** R12 is satisfied by AF's `visibility: 'self'` (a child's dashboard is their own
cash balance, their own goal, their own spending), R5's attribution-only people (a younger sibling who
does not sign in), and `goals.ownerUserId`, which has been per-user since v1.0.0. There is no
allowance table, no chore list and no third role. This paragraph is the deliverable: the help page
gains a short "Someone's own view" section describing what a `self` account sees, and
`docs/PENDING-FIXES.md` item AR is closed pointing at it.

---

## Safety

- **Migration.** 0013 is additive: five `ALTER TABLE ADD COLUMN`s, one `CREATE TABLE`, two indexes. No
  rebuild, no data movement, no `DROP`. A failed run leaves the v1.12.1 database untouched because
  Drizzle wraps the whole pending set in one `BEGIN … COMMIT`. Rolling back to v1.12.1 with the new
  columns present is harmless — SQLite ignores columns the older code never selects — but the
  CHANGELOG still tells the household to take a backup first.
- **Foreign keys.** `openDatabase()` (`src/db/client.ts:51-77`) already turns foreign keys off around
  the migration pass, back on immediately after, and runs `foreign_key_check`, refusing to start on
  any orphan. 0013 needs nothing added there and **must not** put a pragma in its `.sql` file.
- **One link per transaction.** `recordInstallmentPayment` creates the transaction inside its own
  `db.transaction`, so it cannot already carry a `loan_payments` or `bill_installments` link, and
  `bill_installments_txn_uq` makes a second installment against that id impossible for ever. The mark
  is a conditional `UPDATE … WHERE paid_at IS NULL`, so a concurrent matcher wins cleanly instead of
  double-writing.
- **Import undo.** Unchanged. `undoImport` partitions by `transaction_imports` and reverses loan and
  installment links explicitly; an OFX row differs only in which column deduped it.
- **No credential in props.** Nothing in this release passes a password hash, a TOTP secret, an
  encrypted destination or a session token into a client component. `PUBLIC_COLUMNS`
  (`src/lib/auth/users.ts:41-50`) gains three plain flags and an integer; `UserWithSecrets` remains the
  only shape carrying `passwordHash`.
- **404, not 403, on a foreign receipt.** A 403 confirms the row exists. The route returns the same
  404 body it already returns for an unknown id.
- **The audit log is not a security log.** Three destructive actions, one short sentence each. No
  request body, no IP (`sessions` already carries that), no secret. R3 says keep it small.
- **PUBLIC REPO.** No owner name, employer, email, absolute Windows path or real statement value
  appears in any file this release adds — fixtures and comments included. Every OFX fixture is
  synthetic; every new preset is described by its header row and field names only.

---

## Release

### `CHANGELOG.md` — a new section directly under `## Unreleased`

```markdown
## [1.13.0] - 2026-08-27

**Before updating:** this release adds columns to four tables and creates one new table
(`audit_log`). Nothing is rebuilt and nothing is dropped, but take a backup first anyway:
**Settings → Backups → Download backup now**, or confirm last night's scheduled backup
succeeded. Use that, not a file copy — the database runs in WAL mode, so copying `budget.db`
off the NAS while the container is running silently leaves out your most recent changes; the
app's own backup is a consistent snapshot.

**Stop the old container before starting the new one** rather than hot-swapping, so only one
process opens the database during the migration.

**The migration is all-or-nothing.** Every statement and its bookkeeping row commit in a single
transaction, so an interrupted update leaves your v1.12.1 database exactly as it was — start the
container again and it will retry.

**To roll back:** restore the backup you took above, then run the v1.12.1 image.

### Added

- **A "just me" view for kids.** Settings → Users can set any member to **Only their own
  records**. That person then sees only transactions attributed to them, their own budgets,
  goals and items, and their own upcoming bills — no account balances, no net worth, and no
  household totals anywhere. Everyone else's screens are unchanged.
- **People without a login.** Settings → Users can add someone as a person only — no password,
  no sign-in. They appear in every "who was this for?" picker and can never be an admin.
- **A "Needs a look" card on the dashboard**, listing this month's unusual charges, duplicate
  charges and subscriptions that went up. The app has computed these since v1.10.0 and could
  only reach you by Telegram or email until now. The card hides itself when there is nothing to
  say.
- **Quick add.** A one-line form at the top of Transactions and on the dashboard, defaulting to
  the account you used last. The installed app's icon gains an "Add a transaction" shortcut.
- **Notes on a transaction.** "Note…" in the row menu opens a box under that row, and the search
  box now searches notes as well as descriptions.
- **Record payment** on an upcoming bill installment: one button writes the transaction and marks
  the installment paid, in one step.
- **RBC, BMO and CIBC import presets, and OFX/QFX files.** OFX carries the bank's own transaction
  id, so re-importing an overlapping statement matches exactly instead of by fingerprint. These
  three presets are built from each bank's published export layout and have not yet been checked
  against a real file — tell us if one needs adjusting.
- **Savings and asset accounts.** An asset (a house, a TFSA, an RRSP) holds a balance you type in
  and counts toward net worth; it takes no transactions and no imports. Savings behaves like a
  chequing account but is left out of safe-to-spend.
- **A sinking-fund line on budgets.** Link a bill to a budget category and that row says what it
  is accumulating for: "Accumulating for Property tax — $900 of $1,800 by 2026-06-30".
- **An audit page** at Settings → Audit log, listing every deleted item, deleted receipt and
  undone import with who did it and when.

### Changed

- **Deleting an item or a receipt, and undoing an import, now require you to own it** (or to be an
  admin). Until now any signed-in member could delete anyone's records and nothing recorded who
  did it.
- **Opening another member's item by its address now shows "not found"** instead of the item.
- **Changing a merchant rule someone else created now tells you so** instead of silently
  overwriting it and recording you as its author. Admins can still change any rule.
- **"You haven't imported in a while" now names the account.** Importing one account no longer
  silences the alert for the four you have not touched.

### Fixed

- The people picker on Transactions listed deactivated members while the one on Budgets did not.
  Both now list every active person, whether or not they can sign in.
```

### Version bump

`package.json` `"version": "1.13.0"`. `tests/ops/docker.test.ts` gains a `MUST-7.1: the 1.13.0
release` block shaped like the existing 1.12.0 one (`tests/ops/docker.test.ts:247-267`), asserting the
version, the dated heading, that `## Unreleased` precedes it, and the headline claims —
`/Only their own records/`, `/Needs a look/`, `/OFX/`, `/audit/i`, `/Record payment/`. The 1.12.0 and
1.11.0 blocks stay untouched (append-only discipline).

### `docs/PENDING-FIXES.md` flips

Thirteen items are resolved. Each keeps its original text underneath as the record of why the
alternatives were rejected:

- **AF** → `SHIPPED in v1.13.0` — `users.visibility`, six query chokepoints, the ops guard.
- **AG** → `SHIPPED in v1.13.0` — owner-or-admin on four destructive paths, `audit_log`.
- **AH** → `SHIPPED in v1.13.0` — `created_by` preserved, `last_modified_by` added, member writes refused.
- **AI** → `SHIPPED in v1.13.0` — `users.can_sign_in`; the picker inconsistency resolved.
- **AJ, AK, AL, AM, AN, AO, AP, AQ** → `SHIPPED in v1.13.0`.
- **AR** → `CLOSED in v1.13.0 — no code.` R12: satisfied by AF + AI + per-user goals.
- **AS** → `DROPPED by the owner, 2026-08-27.` Not built, not scheduled.

All thirteen point at this spec. The two section headings that read "v1.13.0 candidates" and "v1.14.0
candidates" are relabelled to name v1.13.0, since the owner pulled the whole household-features block
forward.

### `INSTALL.md` (R15)

One paragraph at the end of **After the install** (`INSTALL.md:216-230`), as item 7:

> **One family per instance.** Budget Tracker is built for a single household: categories, merchant
> rules and the classifier are shared by everyone with an account here, and there is no tenant
> boundary in the database. If friends or extended family want to use it, run them a second container
> with its own `/data` volume and its own `SECRET_KEY` — a compose-file change and no code. Inside one
> household, Settings → Users can limit a member to **only their own records**, which is the right
> control for a child's account, not for another family.

`tests/ops/install.test.ts` validates shell syntax only and needs no edit.
