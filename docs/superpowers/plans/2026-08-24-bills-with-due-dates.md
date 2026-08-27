# Bills with due dates (and collapsed page guides) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A household can record a property-tax bill as a list of due dates and amounts, be
reminded before each one and told when one goes past — and every "What is this page for?" panel
starts collapsed instead of springing open on an empty page.

**Architecture:** A fifth `ItemKind`, `bill`, whose reminder data is an explicit schedule rather
than a cadence: a new `bill_installments` child table of `warranty_items`. Migration 0011 widens
`warranty_item_types.kind`'s CHECK by rebuilding that table, then creates the schedule table. Four
`*AllowedForKind` gates decide what a bill offers. Everything downstream is a **reader**: the
Coming-up card, the existing `coming_due` notification and the existing merchant-matching rules all
learn to see installments; no new notification event, no new channel, no new machinery.

**Tech Stack:** Next.js 16 App Router, React 19.2, TypeScript 6.0.3, Drizzle ORM over
better-sqlite3 (SQLite 3.53), Tailwind 4, Vitest 3 + `@testing-library/react` + jsdom (per-file
`// @vitest-environment jsdom`; the suite default is `node`).

**Spec:** `docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md` — read it first.
Rulings **C1–C8** and **B1–B16** are binding, and this plan cites them by number throughout.

## Global Constraints

Every task's requirements implicitly include this section.

- **Integer cents only.** Every amount in this feature is an `integer` column and a `number` of
  cents in TypeScript. No floats, no `parseFloat`, no currency strings in the database.
  `parseAmountToCents` (`src/lib/money.ts:11`) is the one parser and `formatCents`
  (`src/lib/money.ts:50`) the one formatter.
- **ISO date strings.** Due dates are `YYYY-MM-DD` text, validated by `isIsoDate`
  (`src/lib/dates.ts:143`); `paid_at` is a full ISO timestamp from `nowIso()`. Date arithmetic goes
  through `addDaysIso` / `daysBetweenIso` (`src/lib/dates.ts:223`, `:230`). No `new Date()` inside
  a `src/lib/**` function — `today` is always a parameter (the project-wide v1.4.0 clock-free rule,
  stated in `src/lib/bills.ts`'s own header).
- **Kind `bill` gets no product fields, no billing cadence fields and no loan fields** (ruling C4).
  The schedule replaces the cadence. `billingAllowedForKind('bill')`,
  `productFieldsAllowedForKind('bill')` and `loanFieldsAllowedForKind('bill')` are all **false**.
- **Mark-paid is a deliberate button, never an auto-save** (ruling C8 and the v1.11.0 safety rule).
  So is Unmark and so is Remove. Nothing in this feature saves on change or on blur.
- **Two or more row actions collapse into a `RowMenu`** (v1.11.0 ruling R2), and its `label` is
  row-identifying: `Actions for the {amount} installment due {dueDate}` (ruling B9) — amount *and*
  date, because a repeated single field is exactly the defect PENDING-FIXES item M records.
- **Migrations are append-only and `0011` is the ONLY table rebuild in this release.** No shipped
  `.sql` file is edited. The rebuild runs with foreign keys disabled around the whole migration
  pass — see Task 2, which changes `src/db/client.ts` for this and explains, with evidence, why the
  spec's "`PRAGMA foreign_keys` off/on pair inside the SQL" cannot work.
- **No new npm dependencies.** No date library, no menu library, no scheduling library.
- **PUBLIC REPO.** No owner name, no employer name, no real statement data, no real merchant
  strings and no absolute Windows paths in any file — including comments and test fixtures. Use
  generic fixtures: `'Property tax'`, `'CITY TAX OFFICE'`, `'Chequing'`, `'user-1'`.
- **Conventional commits** (`feat:` / `fix:` / `test:` / `docs:` / `refactor:`). **NEVER add a
  `Co-Authored-By` line or any Claude/AI attribution line to a commit** — repo rule, no exceptions.
- **Never `git stash`.** If the tree is dirty in a way that blocks you, stop and report it.
- **Run only your own test files** (`npx vitest run <paths>`) until Task 8, which is the first task
  that runs the whole suite.
- **Foreground test runs, `timeout 600000`, never a background run you then poll.** The local
  vitest worker pool intermittently hangs when a run is backgrounded and waited on; a foreground
  run with a generous timeout is the known-good shape in this repo.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that say *why*. A
  comment that argues for behaviour the code no longer has is worse than no comment — that is
  precisely what ruling B1 is about.
- TDD: write the failing test, run it and watch it fail, implement the minimum, watch it pass,
  commit.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/ui/PageGuide.tsx` | the panel, now unconditionally collapsed | T1 |
| the nine `<PageGuide` call sites | drop the `empty` prop | T1 |
| `tests/components/page-guide.test.tsx` | the reversal, pinned | T1 |
| `drizzle/0011_bill_installments.sql` | widen the kind CHECK; create the schedule table | T2 |
| `drizzle/meta/_journal.json` | the idx-11 entry | T2 |
| `src/db/client.ts` | foreign keys off around the migration pass | T2 |
| `tests/db/migration-0011.test.ts` | the rebuild preserves everything; the new table bites | T2 |
| `src/db/schema.ts` | `billInstallments`; `kind` enum gains `'bill'`; two docblocks | T3 |
| `src/lib/warranty/constants.ts` | the fifth kind, four gates, all new wording | T3 |
| `src/lib/warranty/types.ts` | `setItemTypeKind`'s asymmetric clearing pass (B6) | T3 |
| `src/lib/warranty/installments.ts` | list / add / remove / mark / unmark / unpaid reader | T3 |
| `tests/lib/warranty/constants.test.ts` | five kinds × five gates, as a table | T3 |
| `tests/lib/warranty/installments.test.ts` | CRUD, ordering, state derivation, idempotency | T3 |
| `tests/lib/warranty/types.test.ts` | the kind flip keeps installment rows | T3 |
| `src/app/(app)/warranties/[id]/page.tsx` | loads the rows | T4 |
| `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` | the Installments card | T4 |
| `src/app/(app)/warranties/actions.ts` | three new actions; the matching gate | T4 |
| `tests/app/warranty-installments.test.ts` | the three actions | T4 |
| `src/lib/bills.ts` | installments in `upcomingBills`; `includeOverdue` | T5 |
| `src/components/ComingUpCard.tsx` | the Overdue badge and the header clause | T5 |
| `src/app/(app)/dashboard/page.tsx` | passes `includeOverdue: true` | T5 |
| `tests/lib/bills.test.ts`, `tests/components/ComingUpCard.test.tsx` | both halves | T5 |
| `src/lib/notify/render.ts` | the `variant` discriminator (B15) | T6 |
| `src/lib/notify/events.ts` | two dedup keys; the reworded blurb | T6 |
| `src/lib/notify/evaluate/coming-due.ts` | the installment source | T6 |
| `tests/lib/notify/render.test.ts`, `tests/lib/notify/evaluate/coming-due.test.ts` | both | T6 |
| `src/lib/loans.ts` | `applyPaymentMatchers`; `reverseInstallmentLinksForTransactions` | T7 |
| the five rename call sites + `src/lib/import/commit.ts` | the rename and the undo reversal | T7 |
| `tests/lib/loans/payment-matchers.test.ts` | the bill branch, end to end | T7 |
| `src/app/(app)/help/content.tsx`, `warranties-client.tsx`, `docs/PENDING-FIXES.md` | the copy | T8 |
| `tests/ops/loan-invariants.test.ts` | the B10 no-alias guard | T8 |
| `CHANGELOG.md`, `package.json`, `tests/ops/docker.test.ts` | v1.12.0 | T9 |

**Explicitly out of scope** — the spec's "What this does NOT build" list. Do not add any of these
while you are in the file: a recurring-schedule generator, partial payments, interest or penalty
maths, new `BILLING_CYCLES` values, calendar/`.ics` export, backfill for bill rules, inline editing
of an installment, bill entry from the transactions page, a new notification channel or event id,
and any seeded item type (`src/db/seed.ts` seeds no item types today and gains none — spec
Component 8).

## Wave map

| Wave | Tasks | Parallel? |
|---|---|---|
| 0 | T1 | standalone; shippable on its own |
| 1 | T2 → T3 | disjoint files, but **T3's tests need T2's migration**, so run T2 first |
| 2 | T4, T5, T6, T7 | fully parallel — disjoint files, all four consume T2+T3 |
| 3 | T8 | after T4–T7; full suite, typecheck, build, browser check |
| 4 | T9 | release commit only. **No tag, no push.** |

---

# Wave 0 — item N, standalone

### Task 1: `PageGuide` starts collapsed everywhere

**Files:**
- Modify: `src/components/ui/PageGuide.tsx:1-21` (the whole file)
- Modify: `src/app/(app)/dashboard/page.tsx:130`
- Modify: `src/app/(app)/budgets/budgets-client.tsx:347-352`
- Modify: `src/app/(app)/goals/goals-client.tsx:52-54`
- Modify: `src/app/(app)/import/import-client.tsx:357-360`
- Modify: `src/app/(app)/reports/reports-client.tsx:129-134`
- Modify: `src/app/(app)/review/review-client.tsx:57-60`
- Modify: `src/app/(app)/settings/page.tsx:51-54`
- Modify: `src/app/(app)/transactions/transactions-client.tsx:195-200`
- Modify: `src/app/(app)/warranties/warranties-client.tsx:85-88`
- Modify: `tests/components/page-guide.test.tsx:9-56`
- Run unedited: `tests/ops/onboarding-coverage.test.ts`

**Interfaces:**
- Consumes: `GuidePanel({ summary, open, children })` from `src/components/ui/GuidePanel.tsx` —
  unchanged, and it keeps its `open` prop because the notification setup guides still pass one
  (ruling B2).
- Produces: `PageGuide({ children }: { children: React.ReactNode })` — **no `empty` prop**. Every
  call site in the repo must stop passing one, or it will not compile.

- [ ] **Step 1: Replace the two derivation tests with the reversal test.**

Ruling B1 and spec Testing item 8: the derivation tests are *replaced*, not deleted — a deleted
test leaves no record that the behaviour was once the opposite. Rewrite the first `describe` block
of `tests/components/page-guide.test.tsx` (lines 9–56) to exactly this, leaving the `GuidePanel`
`describe` below it untouched:

```tsx
/**
 * v1.12.0 REVERSAL (spec docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md,
 * item N / ruling B1). This panel used to derive its open state from the page being empty, and
 * two tests here pinned that derivation in both directions. The owner lived with it and
 * disagreed: a panel that opens itself is a panel in the way, and an empty page is already
 * explained by its EmptyState and its action button. The derivation is gone, the `empty` prop
 * is gone with it, and the single test below replaces both -- kept as a test rather than a
 * deletion so the record shows the behaviour was once the opposite.
 */
describe('PageGuide: the per-page "what is this for?" panel', () => {
  it('is collapsed on every page, whether or not the page has data', () => {
    const { container } = render(
      <PageGuide>
        <p>body</p>
      </PageGuide>,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('asks exactly one question, on every page that carries it', () => {
    const { container } = render(
      <PageGuide>
        <p>body</p>
      </PageGuide>,
    );
    expect(container.querySelector('summary')?.textContent).toBe('What is this page for?');
  });

  it('renders its children as the panel body', () => {
    const { container } = render(
      <PageGuide>
        <p>what this screen summarises</p>
      </PageGuide>,
    );
    expect(container.textContent).toContain('what this screen summarises');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/components/page-guide.test.tsx`
Expected: FAIL — TypeScript/React complains that `empty` is required, or the first test fails
because `details.open` is still `true` when the (now missing) prop defaults to undefined.

- [ ] **Step 3: Rewrite `PageGuide.tsx`.** The docblock is rewritten, not trimmed: it currently
  argues *for* the derivation at length. Replace the whole file with:

```tsx
import { GuidePanel } from '@/components/ui/GuidePanel';

/**
 * The "What is this page for?" panel that sits under a nav section's `PageHeader`.
 *
 * It starts CLOSED, always. The v1.10.0 onboarding spec derived the open state from the page
 * having nothing on it -- "a screen with nothing on it is exactly when a reader needs the
 * explanation" -- and the owner reversed that on 2026-08-24 after living with it: a panel that
 * opens itself is a panel in the way, and an empty page is already explained by its `EmptyState`
 * and the action button on it. There is no `empty` prop, deliberately: a prop nothing reads is
 * the stale claim this repo's docblocks keep warning about (ruling B1).
 *
 * Nothing is persisted, so this panel needs no dismiss control, no per-user flag, and therefore
 * no migration -- the two sentences of the old docblock that still hold.
 *
 * `GuidePanel` keeps its `open` prop: the notification setup guides pass one for their own
 * reasons (ruling B2). Only this component's derivation is gone.
 */
export function PageGuide({ children }: { children: React.ReactNode }) {
  return (
    <GuidePanel summary="What is this page for?" open={false}>
      {children}
    </GuidePanel>
  );
}
```

- [ ] **Step 4: Run the test again.**

Run: `npx vitest run tests/components/page-guide.test.tsx`
Expected: PASS.

- [ ] **Step 5: Drop the prop at all nine call sites, and delete the locals that only fed it.**

Each of these becomes a bare `<PageGuide>`. Ruling B1: delete any local or comment that existed
only to feed the prop; three pages keep their expression because the page uses it elsewhere.

| File | Line | Change |
|---|---|---|
| `dashboard/page.tsx` | 130 | `<PageGuide empty={monthIsEmpty}>` → `<PageGuide>`. **KEEP** `const monthIsEmpty = merchants.length === 0;` at line 102 — it is used elsewhere on the page. |
| `budgets/budgets-client.tsx` | 347–352 | `<PageGuide empty={householdTotals.budgetedLimitCents === 0}>` → `<PageGuide>`, and **delete the three-line `{/* ... */}` comment above it**, which explains the derivation. `householdTotals` stays; it is the page's own totals object. |
| `goals/goals-client.tsx` | 52–54 | `<PageGuide empty={goals.length === 0}>` → `<PageGuide>`, and delete the two-line comment above it. |
| `import/import-client.tsx` | 357–360 | `<PageGuide empty={historyRows.length === 0}>` → `<PageGuide>`, and delete the three-line comment above it. `historyRows` stays — the History card renders it. |
| `reports/reports-client.tsx` | 129–134 | `<PageGuide empty={breakdown.length === 0}>` → `<PageGuide>`, and delete the comment block above it. `breakdown` stays; the page renders it. |
| `review/review-client.tsx` | 57–60 | `<PageGuide empty={rows.length === 0}>` → `<PageGuide>`, and delete the three-line comment above it. `rows` stays. |
| `settings/page.tsx` | 51–54 | `<PageGuide empty={false}>` → `<PageGuide>`, and delete the three-line comment above it — it explains why `false` was passed, and there is no longer a value to explain. |
| `transactions/transactions-client.tsx` | 195–200 | `<PageGuide empty={page.rows.length === 0}>` → `<PageGuide>`, and delete the comment block above it. `page.rows` stays. |
| `warranties/warranties-client.tsx` | 85–88 | `<PageGuide empty={result.rows.length === 0}>` → `<PageGuide>`, and delete the three-line comment above it. `result.rows` stays. |

Verify none is missed:

Run: `npx grep -rn "PageGuide empty" src` — or `git grep -n "PageGuide empty"`.
Expected: no output.

- [ ] **Step 6: Confirm the ops guard still matches, unedited.**

Guard 3 of `tests/ops/onboarding-coverage.test.ts:163` greps for the literal `<PageGuide`, which a
bare `<PageGuide>` still matches. The spec says this is worth *confirming* rather than assuming.

Run: `npx vitest run tests/ops/onboarding-coverage.test.ts`
Expected: PASS, with **no edit to that file**. If it fails, you deleted a `<PageGuide` you should
not have; do not edit the guard.

- [ ] **Step 7: Typecheck.** Nine call sites changed signature; the compiler is the check that none
  was missed.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/PageGuide.tsx "src/app/(app)" tests/components/page-guide.test.tsx
git commit -m "fix(ui): page guides start collapsed on every page"
```

---
# Wave 1 — foundations

**Ordering inside this wave:** T2 and T3 touch disjoint files, but T3's tests open a migrated test
database, so **T2 must land first**. Do not start T3 until T2 is green.

### Task 2: migration 0011 — widen the kind CHECK, add `bill_installments`

**Files:**
- Create: `drizzle/0011_bill_installments.sql`
- Modify: `drizzle/meta/_journal.json` (append the idx-11 entry after idx 10)
- Modify: `src/db/client.ts:30-43` (`openDatabase`)
- Create: `tests/db/migration-0011.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. `openDatabase(filePath)` and `migrationsFolder()` already
  exist in `src/db/client.ts`; `createTestDb()`, `insertTestUser(db, { username })` and
  `insertTestAccount(db, { name })` already exist in `tests/helpers/db.ts`, and `TestDb` exposes
  `{ db, sqlite, path, cleanup }`.
- Produces, for T3 and everything after it:
  - `warranty_item_types.kind` accepts `'bill'` as a fifth value; every other constraint on that
    table (`is_subscription IN (0,1)`, `length(trim(name)) BETWEEN 1 AND 60`, the `COLLATE NOCASE`
    unique index on `name`, `AUTOINCREMENT`) still bites, and every existing row survives.
  - table `bill_installments (id, item_id, due_date, amount_cents, paid_at, paid_txn_id,
    created_at)` with indexes `bill_installments_txn_uq` (UNIQUE on `paid_txn_id`),
    `bill_installments_item_idx` on `(item_id, due_date)` and `bill_installments_due_idx` on
    `(paid_at, due_date)`.

#### Read this before writing any SQL

**The spec's "foreign-key-off/on pair around the rename" cannot work, and the reason is
mechanical.** Drizzle's SQLite dialect wraps every migration in an explicit transaction —
`node_modules/drizzle-orm/sqlite-core/dialect.cjs:676` issues `BEGIN`, runs each statement of each
pending migration, then `COMMIT`. SQLite documents `PRAGMA foreign_keys` as a **no-op inside a
transaction**. So a `PRAGMA foreign_keys=OFF;` line at the top of `0011.sql` silently does nothing,
`DROP TABLE warranty_item_types` then performs its implicit `DELETE FROM` against rows that
`warranty_items.type_id` references, and the migration dies with `FOREIGN KEY constraint failed`.

Three alternatives were tried against SQLite 3.53.2 and all three fail:

| attempt | outcome |
|---|---|
| `PRAGMA foreign_keys=OFF` inside the file (drizzle's generated style) | fails at `DROP TABLE`: the pragma is a no-op inside the transaction |
| `PRAGMA defer_foreign_keys=ON` inside the file | gets past `DROP` and `RENAME`, then fails at `COMMIT` — the deferred violation counter is incremented by the implicit delete and nothing decrements it |
| `PRAGMA legacy_alter_table=ON`, to stop the rename rewriting the child's `REFERENCES` clause | does not stop it: with `foreign_keys` ON, SQLite rewrites `REFERENCES` clauses on rename regardless of `legacy_alter_table`, so `warranty_items` ends up pointing at the renamed-away old table |

The working shape — verified end to end on 3.53.2, preserving rows, the `COLLATE NOCASE` index,
all three surviving CHECKs, the FK and `sqlite_sequence` — is to disable foreign keys **outside**
the transaction, which is only possible where the transaction is opened: `openDatabase()`. That is
Step 3. The `.sql` file then contains no pragmas at all.

- [ ] **Step 1: Write the failing runner test.** Create `tests/db/migration-0011.test.ts` with
  just this, for now:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('the migration pass runs with foreign keys disabled', () => {
  it('openDatabase turns them off around migrate() and back on after, then checks for orphans', () => {
    // Not a style preference: drizzle's SQLite dialect wraps every migration in BEGIN ... COMMIT
    // (node_modules/drizzle-orm/sqlite-core/dialect.cjs), and PRAGMA foreign_keys is a NO-OP
    // inside a transaction. A table rebuild -- 0011 is the first one this schema has needed on a
    // table that HAS children -- is therefore impossible unless the pragma is set out here.
    const source = fs.readFileSync(path.join(root, 'src/db/client.ts'), 'utf8');
    const off = source.indexOf('foreign_keys = OFF');
    const migrateCall = source.indexOf('migrate(db,');
    const on = source.indexOf('foreign_keys = ON');
    const check = source.indexOf('foreign_key_check');
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(migrateCall);
    expect(migrateCall).toBeLessThan(on);
    expect(on).toBeLessThan(check);
  });

  it('0011 contains no PRAGMA at all, because a pragma in that file would be a lie', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0011_bill_installments.sql'), 'utf8');
    const statements = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(/PRAGMA/i.test(statements)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/db/migration-0011.test.ts`
Expected: FAIL — `drizzle/0011_bill_installments.sql` does not exist, and `client.ts` has no
`foreign_keys = OFF`.

- [ ] **Step 3: Change `openDatabase`.** Replace `src/db/client.ts:30-43` with:

```ts
/**
 * The ONLY place a better-sqlite3 Database is constructed.
 * Every connection gets journal_mode=WAL, busy_timeout=5000 and foreign_keys=ON,
 * with Drizzle migrations applied (idempotent) in between.
 *
 * v1.12.0: foreign keys are OFF for the migration pass and back ON immediately after. This is
 * required, not defensive. Drizzle's SQLite dialect runs every pending migration inside one
 * explicit BEGIN ... COMMIT, and SQLite documents `PRAGMA foreign_keys` as a NO-OP inside a
 * transaction -- so the pragma cannot be set from inside a .sql file at all, and a table rebuild
 * is impossible unless it is set here. drizzle/0011_bill_installments.sql is the first migration
 * that needs one: SQLite cannot ALTER a CHECK, and warranty_item_types has a child table.
 *
 * `foreign_key_check` runs immediately afterwards and refuses to start on any orphan. Turning
 * enforcement off for a window means a bad migration could leave one behind silently; this makes
 * that loud on the very next boot rather than at some unrelated read months later.
 */
export function openDatabase(filePath: string): DbInstance {
  const sqlite = new BetterSqlite3(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  sqlite.pragma('foreign_keys = ON');
  const orphans = sqlite.pragma('foreign_key_check') as unknown[];
  if (orphans.length > 0) {
    sqlite.close();
    throw new Error(`Database has ${orphans.length} orphaned row(s) after migration; refusing to start.`);
  }
  return { db, sqlite };
}
```

- [ ] **Step 4: Write `drizzle/0011_bill_installments.sql`.** Exactly this file. The breakpoint
  marker between statements is the literal string drizzle splits on; it must never appear inside a
  comment, which is why the header describes it rather than quoting it (0009's own convention).

```sql
-- WARNING: this migration is hand-maintained, not drizzle-kit-generated.
-- Read the header of drizzle/0000_init.sql and the docblock in drizzle.config.ts before
-- adding another one: there is no 0000_snapshot.json, so `drizzle-kit generate` would
-- diff against an empty baseline and re-emit the whole schema. Hand-author the SQL,
-- append the matching entry to drizzle/meta/_journal.json, and mirror the tables in
-- src/db/schema.ts -- in that order.
--
-- NOTE ON SEPARATORS: drizzle's migrator splits this file on the breakpoint marker written
-- between each statement below, and on nothing else, and it does NOT skip comments. That
-- marker must therefore never appear inside a comment -- including this one, which is why
-- it is described here rather than quoted -- or the file is shredded into fragments that
-- will not parse.
--
-- Bills with due dates (spec docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md,
-- v1.12.0). Two parts, in this order because the second cannot be pointed at until the first
-- has made the new kind legal:
--   Part 1: widen warranty_item_types.kind to admit 'bill'. A full table rebuild.
--   Part 2: bill_installments -- the explicit schedule that replaces a cadence for a bill.
--
-- ============================================================================================
-- WHY PART 1 IS A REBUILD, AND WHY IT IS NOT 0010'S SHORTCUT.
--
-- warranty_item_types.kind carries CHECK (kind IN ('warranty','subscription','contract','loan'))
-- from 0004, and SQLite cannot ALTER a CHECK. 0010 answered the same problem by dropping and
-- recreating its table, and its own header forbids copying that anywhere the data cannot be
-- regenerated. Item types are exactly that: a person types them, nothing else stores them, and
-- warranty_items.type_id points at them. So this is the real thing -- a __new_ table,
-- INSERT ... SELECT, DROP, RENAME, and every surviving constraint and index re-declared:
--   * both 0003 CHECKs (is_subscription IN (0,1); length(trim(name)) BETWEEN 1 AND 60)
--   * the widened kind CHECK, now five values
--   * AUTOINCREMENT, so ids keep climbing rather than being reused
--   * warranty_item_types_name_uq, WITH its COLLATE NOCASE collation
-- The explicit id column in the INSERT is what keeps warranty_items.type_id resolving.
--
-- THE FOREIGN-KEY PRAGMA IS NOT IN THIS FILE, ON PURPOSE. Drizzle's SQLite dialect runs every
-- pending migration inside one BEGIN ... COMMIT, and SQLite documents PRAGMA foreign_keys as a
-- no-op inside a transaction; a pragma written here would look like protection and provide
-- none. src/db/client.ts's openDatabase() disables foreign keys around the whole migration
-- pass and re-enables them (plus a foreign_key_check) immediately after. Do not put a pragma
-- back into this file.
-- ============================================================================================
--
-- Objects that exist ONLY in SQL and have NO Drizzle representation now number, after this
-- migration:
--   1. the categories.parent_id self-referencing foreign key             (0000)
--   2. the COALESCE(display_description, raw_description) index          (0000)
--   3. the COALESCE month expression index                               (0000)
--   4. every CHECK constraint on warranty_items                          (0002, extended by 0007)
--   5. every CHECK constraint on warranty_receipts                       (0002)
--   6. the warranty_search FTS5 contentless virtual table                (0002)
--   7. its six triggers, which are its ONLY writer                       (0002)
--   8. the is_subscription/name CHECK constraints on warranty_item_types (0003, re-declared 0011)
--   9. the COLLATE NOCASE collation on warranty_item_types_name_uq       (0003, re-declared 0011)
--  10. warranty_items.type_id arriving by ALTER TABLE ADD COLUMN         (0003)
--  11. the CHECK constraint on warranty_item_types.kind                  (0004, SUPERSEDED by 31)
--  12. warranty_item_types.kind itself, by ALTER TABLE ADD COLUMN        (0004)
--  13. the CHECK constraints on billing_cycle and billing_amount_cents,
--      and both columns arriving by ALTER TABLE ADD COLUMN               (0005)
--  14. the id = 1 singleton CHECK on notification_smtp                   (0006)
--  15. every other CHECK constraint on notification_smtp                 (0006)
--  16. every CHECK constraint on notification_targets, including the     (0006)
--      channel/secret_encrypted pairing rule
--  17. every CHECK constraint on notification_prefs                      (0006)
--  18. every CHECK constraint on notification_user_settings              (0006)
--  19. every CHECK constraint on notification_outbox                     (0006)
--  20. notification_prefs' WITHOUT ROWID storage class                   (0006)
--  21. the CHECK constraints on the four loan money columns, and all
--      four columns arriving by ALTER TABLE ADD COLUMN                   (0007)
--  22. every CHECK constraint on loan_matcher_rules                      (0007)
--  23. the coalesce(account_id, -1) EXPRESSION in loan_matcher_rules_uq  (0007)
--  24. every CHECK constraint on loan_payments                           (0007)
--  25. the CHECK constraint on transaction_splits                        (0009)
--  26. the CHECK constraint on account_balance_snapshots                 (0009, superseded by 0010)
--  27. both CHECK constraints on budget_rollover, including the          (0009)
--      scope/user_id pairing rule
--  28. the coalesce(user_id, -1) EXPRESSION in budget_rollover_uq        (0009)
--  29. categories.tax_relevant arriving by ALTER TABLE ADD COLUMN        (0009)
--  30. every CHECK constraint on bill_installments                       (0011)
--  31. the widened kind CHECK on warranty_item_types, now five values,   (0011)
--      SUPERSEDING entry 11
--
-- bill_installments_txn_uq is a plain unique index and IS mirrored in src/db/schema.ts, so it
-- does not appear in the list above.
--
-- ON DELETE SET NULL on paid_txn_id follows warranty_items.transaction_id's precedent
-- (MUST-3.7: an import undo must not take the evidence with it) and is a BACKSTOP ONLY. What
-- actually keeps a row honest is the explicit reversal in
-- reverseInstallmentLinksForTransactions(), because a cascade can drop the link but cannot
-- restore paid_at (ruling B14).
--
-- There is deliberately NO unique index on (item_id, due_date): two parcels can fall due on
-- the same day for the same bill, at different amounts. Ordering is due_date ASC, id ASC
-- everywhere, so "the earliest unpaid installment" stays total and deterministic.
CREATE TABLE `__new_warranty_item_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_subscription` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`kind` text NOT NULL DEFAULT 'warranty' CHECK (`kind` IN ('warranty', 'subscription', 'contract', 'loan', 'bill')),
	CHECK (`is_subscription` IN (0, 1)),
	CHECK (length(trim(`name`)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
INSERT INTO `__new_warranty_item_types` (`id`, `name`, `is_subscription`, `created_at`, `kind`)
	SELECT `id`, `name`, `is_subscription`, `created_at`, `kind` FROM `warranty_item_types`;
--> statement-breakpoint
DROP TABLE `warranty_item_types`;
--> statement-breakpoint
ALTER TABLE `__new_warranty_item_types` RENAME TO `warranty_item_types`;
--> statement-breakpoint
CREATE UNIQUE INDEX `warranty_item_types_name_uq` ON `warranty_item_types` (`name` COLLATE NOCASE);
--> statement-breakpoint
CREATE TABLE `bill_installments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
	`due_date` text NOT NULL CHECK (`due_date` GLOB '____-__-__'),
	`amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
	`paid_at` text,
	`paid_txn_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
	`created_at` text NOT NULL,
	CHECK (`paid_txn_id` IS NULL OR `paid_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_installments_txn_uq` ON `bill_installments` (`paid_txn_id`);
--> statement-breakpoint
CREATE INDEX `bill_installments_item_idx` ON `bill_installments` (`item_id`, `due_date`);
--> statement-breakpoint
CREATE INDEX `bill_installments_due_idx` ON `bill_installments` (`paid_at`, `due_date`);
```

- [ ] **Step 5: Append the journal entry.** In `drizzle/meta/_journal.json`, after the idx-10
  object, add:

```json
    {
      "idx": 11,
      "version": "6",
      "when": 1756166400000,
      "tag": "0011_bill_installments",
      "breakpoints": true
    }
```

`1756166400000` is `1756080000000 + 86_400_000` — one day after 0010, matching the file's existing
one-per-day cadence, which `tests/db/migration-0010.test.ts:53` already asserts for its own entry.

- [ ] **Step 6: Run the two tests from Step 1.**

Run: `npx vitest run tests/db/migration-0011.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the rest of the migration test — the spec's Testing item 1, in full.**
  Add these imports at the top of the file: `import os from 'node:os';`, `afterEach` to the
  `vitest` import, `import { openDatabase } from '@/db/client';` and
  `import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';`.
  Then append:

```ts
const REAL_MIGRATIONS_DIR = path.join(root, 'drizzle');
const NOW = '2026-08-24T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  // Same belt-and-braces as the 0009 and 0010 suites: the upgrade-path test below points this
  // at a temp folder. Clear it here too, so a failed assertion mid-test cannot leak the
  // override into a later test in this same process.
  delete process.env.BUDGET_MIGRATIONS_DIR;
});

function insertType(sqlite: TestDb['sqlite'], name: string, kind: string, isSubscription = 0): number {
  const row = sqlite
    .prepare(
      `insert into warranty_item_types (name, is_subscription, kind, created_at)
       values (?, ?, ?, ?) returning id`,
    )
    .get(name, isSubscription, kind, NOW) as { id: number };
  return row.id;
}

function insertItem(sqlite: TestDb['sqlite'], ownerUserId: number, typeId: number | null, name = 'Home'): number {
  const row = sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(name, ownerUserId, typeId, NOW, NOW) as { id: number };
  return row.id;
}

function insertInstallment(
  sqlite: TestDb['sqlite'],
  itemId: number,
  dueDate: string,
  amountCents: number,
  paidAt: string | null = null,
  paidTxnId: number | null = null,
): void {
  sqlite
    .prepare(
      `insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(itemId, dueDate, amountCents, paidAt, paidTxnId, NOW);
}

describe('the journal entry', () => {
  it('records idx 11 / when 1756166400000 / tag 0011_bill_installments', () => {
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.idx === 11);
    expect(entry).toEqual({
      idx: 11,
      version: '6',
      when: 1756166400000,
      tag: '0011_bill_installments',
      breakpoints: true,
    });
    const prior = journal.entries.find((e) => e.idx === 10);
    expect(entry!.when - prior!.when).toBe(86_400_000);
    // Append-only: 0010 keeps its slot.
    expect(prior?.tag).toBe('0010_balances');
    expect(Math.max(...journal.entries.map((e) => e.idx))).toBe(11);
  });
});

describe('the breakpoint marker never appears inside a comment', () => {
  it('every occurrence is a statement separator', () => {
    const sqlText = fs.readFileSync(path.join(root, 'drizzle/0011_bill_installments.sql'), 'utf8');
    const marker = ['-->', 'statement-breakpoint'].join(' ');
    const total = sqlText.split(marker).length - 1;
    const withoutComments = sqlText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--') || line.trimStart().startsWith(marker))
      .join('\n');
    expect(withoutComments.split(marker).length - 1).toBe(total);
    expect(total).toBeGreaterThan(0);
  });
});

describe('the warranty_item_types rebuild', () => {
  it('leaves exactly one table of that name behind, not a stray __new_ one', () => {
    current = createTestDb();
    const names = current.sqlite
      .prepare(
        `select name from sqlite_master where type = 'table'
           and name like '%warranty_item_types%' order by name`,
      )
      .all() as { name: string }[];
    expect(names).toEqual([{ name: 'warranty_item_types' }]);
  });

  it('keeps the same columns, types and nullability, in the same physical order', () => {
    current = createTestDb();
    const cols = current.sqlite.prepare('pragma table_info(warranty_item_types)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];
    // kind stays LAST: it arrived by ALTER TABLE ADD COLUMN in 0004 and src/db/schema.ts declares
    // it last for exactly that reason. A rebuild that reordered it would make the mirror lie.
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'is_subscription', 'created_at', 'kind']);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('id')!.pk).toBe(1);
    expect(byName.get('name')!.notnull).toBe(1);
    expect(byName.get('is_subscription')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
    expect(byName.get('kind')!.notnull).toBe(1);
    expect(byName.get('kind')!.dflt_value).toBe("'warranty'");
  });

  it('re-creates warranty_item_types_name_uq and it still folds case', () => {
    current = createTestDb();
    insertType(current.sqlite, 'Laptop A', 'warranty');
    expect(() => insertType(current!.sqlite, 'laptop a', 'warranty')).toThrowError(/UNIQUE constraint failed/);
  });

  it('still enforces both 0003 CHECKs', () => {
    current = createTestDb();
    expect(() => insertType(current!.sqlite, '   ', 'warranty')).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!.sqlite, 'X'.repeat(61), 'warranty')).toThrowError(/CHECK constraint failed/);
    expect(() => insertType(current!.sqlite, 'Odd flag', 'warranty', 5)).toThrowError(/CHECK constraint failed/);
  });

  it("accepts 'bill' and still refuses anything outside the five", () => {
    current = createTestDb();
    for (const kind of ['warranty', 'subscription', 'contract', 'loan', 'bill']) {
      insertType(current.sqlite, `Type ${kind}`, kind, kind === 'subscription' ? 1 : 0);
    }
    const { n } = current.sqlite
      .prepare(`select count(*) as n from warranty_item_types where name like 'Type %'`)
      .get() as { n: number };
    expect(n).toBe(5);
    expect(() => insertType(current!.sqlite, 'Nonsense', 'nonsense')).toThrowError(/CHECK constraint failed/);
  });

  it('keeps warranty_items.type_id resolving after the rename, in both directions', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    const itemId = insertItem(current.sqlite, userId, typeId);
    const joined = current.sqlite
      .prepare(
        `select t.kind as kind from warranty_items i join warranty_item_types t on t.id = i.type_id where i.id = ?`,
      )
      .get(itemId) as { kind: string };
    expect(joined.kind).toBe('bill');
    // And the constraint is LIVE, not merely re-declared in text.
    expect(() =>
      current!.sqlite
        .prepare(
          `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
           values ('Orphan', '2024-01-15', 0, ?, 99999, ?, ?)`,
        )
        .run(userId, NOW, NOW),
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it('carries the AUTOINCREMENT sequence across, so ids are never reused', () => {
    current = createTestDb();
    const first = insertType(current.sqlite, 'Alpha', 'warranty');
    current.sqlite.prepare('delete from warranty_item_types where id = ?').run(first);
    const second = insertType(current.sqlite, 'Beta', 'warranty');
    expect(second).toBeGreaterThan(first);
  });
});

describe('bill_installments', () => {
  function seedBill(): { itemId: number; userId: number } {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    return { itemId: insertItem(current.sqlite, userId, typeId), userId };
  }

  it('exists with the expected columns', () => {
    const { itemId } = seedBill();
    expect(itemId).toBeGreaterThan(0);
    const cols = (current!.sqlite.prepare('pragma table_info(bill_installments)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['id', 'item_id', 'due_date', 'amount_cents', 'paid_at', 'paid_txn_id', 'created_at']);
  });

  it('refuses a non-positive amount', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', 0)).toThrowError(/CHECK constraint failed/);
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', -1)).toThrowError(/CHECK constraint failed/);
  });

  it('refuses a malformed due date and accepts a well-formed one', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-9-30', 100)).toThrowError(/CHECK constraint failed/);
    expect(() => insertInstallment(current!.sqlite, itemId, 'soon', 100)).toThrowError(/CHECK constraint failed/);
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 100);
  });

  it('refuses a paid_txn_id with no paid_at', () => {
    const { itemId } = seedBill();
    expect(() => insertInstallment(current!.sqlite, itemId, '2026-09-30', 100, null, 1)).toThrowError(
      /CHECK constraint failed/,
    );
  });

  it('accepts many NULL paid_txn_id rows but only one row per real transaction', () => {
    const { itemId, userId } = seedBill();
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txn = current!.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, '2026-09-30', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ?, ?, ?) returning id`,
      )
      .get(accountId, userId, NOW, NOW) as { id: number };
    // Hand-marked rows carry NULL, and SQLite treats NULLs as distinct in a unique index, so
    // there is no partial index to maintain (ruling B12).
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 120000, NOW, null);
    insertInstallment(current!.sqlite, itemId, '2026-11-30', 120000, NOW, null);
    insertInstallment(current!.sqlite, itemId, '2027-01-30', 120000, NOW, txn.id);
    expect(() => insertInstallment(current!.sqlite, itemId, '2027-03-30', 120000, NOW, txn.id)).toThrowError(
      /UNIQUE constraint failed/,
    );
  });

  it('cascades away when its item is deleted', () => {
    const { itemId } = seedBill();
    insertInstallment(current!.sqlite, itemId, '2026-09-30', 120000);
    current!.sqlite.prepare('delete from warranty_items where id = ?').run(itemId);
    const { n } = current!.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
    expect(n).toBe(0);
  });

  it('has all three indexes', () => {
    seedBill();
    const names = (
      current!.sqlite
        .prepare(`select name from sqlite_master where type = 'index' and tbl_name = 'bill_installments' order by name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(['bill_installments_due_idx', 'bill_installments_item_idx', 'bill_installments_txn_uq']);
  });
});
```

- [ ] **Step 8: Write the upgrade-path test — the one that actually proves the rebuild.** Append:

```ts
/**
 * Builds a database that has only ever seen migrations 0000-0010 (a v1.11.x household database
 * the moment before this release), by pointing BUDGET_MIGRATIONS_DIR at a temp folder holding
 * copies of just those eleven files plus a journal trimmed to their entries. Reopening the SAME
 * file with the default (real, 0011-including) folder reproduces exactly what happens the first
 * time this release boots against an existing database. Same shape as migration-0009's and
 * migration-0010's own buildPreMigrationDb().
 */
function buildPreMigrationDb(): { file: string; tempMigrationsDir: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0010-migrations-'));
  for (const name of [
    '0000_init.sql',
    '0001_add_must_change_password.sql',
    '0002_warranty_tracker.sql',
    '0003_warranty_item_types.sql',
    '0004_item_type_kinds.sql',
    '0005_billing_cycle.sql',
    '0006_notifications.sql',
    '0007_loans.sql',
    '0008_import_attribution.sql',
    '0009_finish_line.sql',
    '0010_balances.sql',
  ]) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, name), path.join(stageDir, name));
  }
  fs.mkdirSync(path.join(stageDir, 'meta'));
  const journal = JSON.parse(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number }[];
  };
  fs.writeFileSync(
    path.join(stageDir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 10) }),
  );
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracker-0010-db-'));
  return { file: path.join(dbDir, 'budget.db'), tempMigrationsDir: stageDir };
}

describe('a v1.11.x database (no 0011 applied) boots and migrates cleanly', () => {
  it('PRESERVES every item type and every item across the rebuild', () => {
    const { file, tempMigrationsDir } = buildPreMigrationDb();
    process.env.BUDGET_MIGRATIONS_DIR = tempMigrationsDir;
    const staged = openDatabase(file);

    const userId = insertTestUser(staged.db, { username: 'user-1' });
    // 0003 and 0004 already seed Laptop / Appliance / Subscription / Contract / Loan; add one
    // hand-made type and one item pointing at it, which is the data nobody can regenerate.
    const typeId = insertType(staged.sqlite, 'Extended contract', 'contract');
    const itemId = insertItem(staged.sqlite, userId, typeId, 'Boiler cover');
    const before = staged.sqlite.prepare('select id, name, kind from warranty_item_types order by id').all();
    // A real pre-0011 database: 'bill' is not yet an accepted kind.
    expect(() => insertType(staged.sqlite, 'Property tax', 'bill')).toThrowError(/CHECK constraint failed/);
    staged.sqlite.close();

    delete process.env.BUDGET_MIGRATIONS_DIR; // falls back to the real drizzle/, which includes 0011
    const upgraded = openDatabase(file);
    try {
      // EVERY row survives, with the same ids. This is what makes 0011 a real rebuild rather
      // than 0010's deliberate row loss -- read 0010_balances.sql's header for why that
      // shortcut was allowed exactly once and must not be copied.
      const after = upgraded.sqlite.prepare('select id, name, kind from warranty_item_types order by id').all();
      expect(after).toEqual(before);

      // The item still resolves through its type.
      const joined = upgraded.sqlite
        .prepare(
          `select t.name as typeName from warranty_items i join warranty_item_types t on t.id = i.type_id where i.id = ?`,
        )
        .get(itemId) as { typeName: string };
      expect(joined.typeName).toBe('Extended contract');

      // openDatabase's own post-migration sweep found nothing, or it would have thrown above.
      expect(upgraded.sqlite.pragma('foreign_key_check')).toEqual([]);
      // ...and foreign keys are back ON for the app's own connection.
      expect(upgraded.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);

      // And the whole point of the migration.
      const billTypeId = insertType(upgraded.sqlite, 'Property tax', 'bill');
      const billItemId = insertItem(upgraded.sqlite, userId, billTypeId, 'Municipal tax');
      insertInstallment(upgraded.sqlite, billItemId, '2026-09-30', 120000);
      const { n } = upgraded.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
      expect(n).toBe(1);
    } finally {
      upgraded.sqlite.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });

  it('reopening an already-migrated file applies 0011 exactly once', () => {
    current = createTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertType(current.sqlite, 'Property tax', 'bill');
    const itemId = insertItem(current.sqlite, userId, typeId);
    insertInstallment(current.sqlite, itemId, '2026-09-30', 120000);
    const file = current.path;
    current.sqlite.close();

    const again = openDatabase(file);
    try {
      // A row written AFTER 0011 had already run must survive a reboot -- if the rebuild
      // re-applied, DROP TABLE would have taken the type (and, by cascade, its item and its
      // installments) with it.
      const { n } = again.sqlite.prepare('select count(*) as n from bill_installments').get() as { n: number };
      expect(n).toBe(1);
      const types = again.sqlite.prepare(`select count(*) as n from warranty_item_types where kind = 'bill'`).get() as {
        n: number;
      };
      expect(types.n).toBe(1);
    } finally {
      again.sqlite.close();
    }
  });
});
```

- [ ] **Step 9: Run the whole migration test file.**

Run: `npx vitest run tests/db/migration-0011.test.ts`
Expected: PASS. If the upgrade-path test fails with `FOREIGN KEY constraint failed`, the pragma in
`openDatabase` is in the wrong place — re-read "Read this before writing any SQL" above.

- [ ] **Step 10: Run the neighbouring schema tests, which all open a migrated database.**

Run: `npx vitest run tests/db/`
Expected: PASS, all of them **unedited**. `tests/db/warranty-item-type-kinds.test.ts` and
`tests/db/warranty-item-types.test.ts` exercise the rebuilt table directly and are the tightest
check that nothing was lost.

- [ ] **Step 11: Commit**

```bash
git add drizzle/0011_bill_installments.sql drizzle/meta/_journal.json src/db/client.ts tests/db/migration-0011.test.ts
git commit -m "feat(db): widen item-type kinds to admit bills and add bill_installments"
```

---
### Task 3: the fifth kind, the four gates, the wording, and the installments data layer

**Depends on Task 2** — every test here opens a migrated database, and `bill` is not a legal kind
until 0011 has run.

**Files:**
- Modify: `src/lib/warranty/constants.ts:18-33` (`ITEM_KINDS`, `ITEM_KIND_LABELS`), `:52-100`
  (`KIND_WORDING`), `:227-264` (the three gates), `:283-288` (`BILLING_WORDING`), `:311-316`
  (`OPEN_ENDED_DISPLAY_LABEL`), and new exports at the end of the file
- Modify: `src/db/schema.ts:600-621` (the `warrantyItemTypes` docblock and its `kind` enum),
  `:795-820` (the `loanMatcherRules` docblock), and a new `billInstallments` table at the end
- Modify: `src/lib/warranty/types.ts:160-208` (`setItemTypeKind`)
- Create: `src/lib/warranty/installments.ts`
- Modify: `tests/lib/warranty/constants.test.ts` (append one describe block)
- Create: `tests/lib/warranty/installments.test.ts`
- Modify: `tests/lib/warranty/types.test.ts` (append one describe block)

**Interfaces:**

- Consumes (from Task 2): the `bill_installments` table and the widened `kind` CHECK.
- Consumes (existing): `parseAmountToCents` / `formatCents` from `@/lib/money`; `isIsoDate`,
  `addDaysIso`, `todayIso` from `@/lib/dates`; `nowIso` from `@/lib/clock`; `MIN_PURCHASE_DATE`
  (`'1970-01-01'`) from `@/lib/warranty/items:31`; `getDb` from `@/db/client`.
- **Produces — every later task depends on these exact names and types:**

```ts
// src/lib/warranty/constants.ts  (CLIENT-SAFE: no @/db, no I/O -- Ruling P4)
export const ITEM_KINDS = ['warranty', 'subscription', 'contract', 'loan', 'bill'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABELS: Record<ItemKind, string>;      // bill: 'Bill'

export function billingAllowedForKind(kind: ItemKind): boolean;      // allowlist now (B4)
export function loanFieldsAllowedForKind(kind: ItemKind): boolean;   // 'loan'
export function productFieldsAllowedForKind(kind: ItemKind): boolean;// 'warranty'
export function installmentsAllowedForKind(kind: ItemKind): boolean; // 'bill'
export function matchingAllowedForKind(kind: ItemKind): boolean;     // 'loan' | 'bill'

export type InstallmentState = 'paid' | 'overdue' | 'due_soon' | 'scheduled';
export const INSTALLMENT_STATES: readonly InstallmentState[];
export const INSTALLMENT_SECTION_LABEL: string;                      // 'Installments'
export function installmentStateLabel(state: InstallmentState): string;
export const MATCHING_KIND_ERROR: string;
export const INSTALLMENT_KIND_ERROR: string;
export function matchingBlurbForKind(kind: ItemKind): string;

// src/lib/warranty/installments.ts  (SERVER-ONLY: imports @/db)
export const INSTALLMENT_DUE_SOON_DAYS = 30;

export interface InstallmentTxn { id: number; date: string; description: string; amountCents: number }

export interface InstallmentRow {
  id: number;
  itemId: number;
  dueDate: string;
  amountCents: number;
  paidAt: string | null;
  paidTxnId: number | null;
  paidTxn: InstallmentTxn | null;
  state: InstallmentState;
}

export interface UnpaidInstallment {
  installmentId: number;
  itemId: number;
  itemName: string;
  ownerUserId: number;
  dueDate: string;
  amountCents: number;
  overdue: boolean;
}

export function installmentStateFor(
  dueDate: string, paidAt: string | null, today: string, dueSoonDays: number,
): InstallmentState;
export function listInstallments(itemId: number, today: string, dueSoonDays: number): InstallmentRow[];
/** Returns the new row's id. Throws INSTALLMENT_KIND_ERROR on a non-bill item. */
export function addInstallment(input: {
  itemId: number; dueDate: string; amountCents: number; at?: string;
}): number;
export function removeInstallment(id: number): boolean;
export function markInstallmentPaid(id: number, at?: string): boolean;
export function unmarkInstallmentPaid(id: number): boolean;
export function unpaidInstallments(input: {
  today: string; windowEnd: string; includeOverdue: boolean; ownerUserId?: number;
}): UnpaidInstallment[];

// src/db/schema.ts
export const billInstallments: SQLiteTable;   // columns: id, itemId, dueDate, amountCents,
                                              // paidAt, paidTxnId, createdAt
```

**Two resolutions this task locks in, both flagged in "Spec ambiguities resolved" at the end of
this plan.** (1) `InstallmentState` is declared in `constants.ts`, not in `installments.ts`, so
that `installmentStateLabel()` — a *value* the client component calls — can live in the
client-safe module Ruling P4 requires; `installments.ts` imports the type from there. (2)
`addInstallment` returns the new **id**, not an `InstallmentRow`: deriving a row's `state` needs a
`today` and a `dueSoonDays` that a create call has no business taking, the caller revalidates and
re-reads anyway, and an id is what the caller can actually use.

- [ ] **Step 1: Write the failing gate test.** Append this describe block to
  `tests/lib/warranty/constants.test.ts`, and add
  `installmentsAllowedForKind, matchingAllowedForKind, installmentStateLabel,
  INSTALLMENT_SECTION_LABEL, INSTALLMENT_KIND_ERROR, MATCHING_KIND_ERROR, matchingBlurbForKind,
  INSTALLMENT_STATES, openEndedDisplayLabel` to its import list.

```ts
/**
 * v1.12.0: five kinds against five gates, written as a TABLE rather than as five assertions.
 * The table is the point. billingAllowedForKind used to read `kind !== 'warranty'`, and a
 * negative gate silently admits every kind nobody has thought of yet -- adding 'bill' under it
 * would have handed a bill the cadence fields ruling C4 forbids. A table fails loudly the moment
 * a sixth kind is added without a decision about each gate (ruling B4).
 */
describe('the five kinds against the five applicability gates', () => {
  const expected: Record<
    string,
    { billing: boolean; loan: boolean; product: boolean; installments: boolean; matching: boolean }
  > = {
    warranty: { billing: false, loan: false, product: true, installments: false, matching: false },
    subscription: { billing: true, loan: false, product: false, installments: false, matching: false },
    contract: { billing: true, loan: false, product: false, installments: false, matching: false },
    loan: { billing: true, loan: true, product: false, installments: false, matching: true },
    bill: { billing: false, loan: false, product: false, installments: true, matching: true },
  };

  it('has a row for every kind and a kind for every row', () => {
    expect([...ITEM_KINDS].sort()).toEqual(Object.keys(expected).sort());
  });

  for (const kind of ITEM_KINDS) {
    it(`${kind}`, () => {
      const row = expected[kind];
      expect({
        billing: billingAllowedForKind(kind),
        loan: loanFieldsAllowedForKind(kind),
        product: productFieldsAllowedForKind(kind),
        installments: installmentsAllowedForKind(kind),
        matching: matchingAllowedForKind(kind),
      }).toEqual(row);
    });
  }

  it('every Record<ItemKind, ...> matrix is total, which is what the compiler enforces', () => {
    for (const kind of ITEM_KINDS) {
      expect(typeof ITEM_KIND_LABELS[kind]).toBe('string');
      expect(ITEM_KIND_LABELS[kind].length).toBeGreaterThan(0);
      expect(typeof formStartLabel(kind)).toBe('string');
      expect(typeof formTermLabel(kind)).toBe('string');
      expect(typeof formEndLabel(kind)).toBe('string');
      expect(typeof formOpenEndedLabel(kind)).toBe('string');
      expect(typeof coveredThroughLabelForKind(kind)).toBe('string');
      expect(typeof billingSectionLabelForKind(kind)).toBe('string');
      expect(typeof billingAmountLabelForKind(kind)).toBe('string');
      expect(typeof openEndedDisplayLabel(kind)).toBe('string');
    }
    expect(Object.keys(ITEM_KIND_LABELS)).toHaveLength(5);
  });

  it("bill's label is Bill, and reuses contract's date wording (ruling B5)", () => {
    expect(ITEM_KIND_LABELS.bill).toBe('Bill');
    expect(formStartLabel('bill')).toBe('Start date');
    expect(formTermLabel('bill')).toBe('Term (months)');
    expect(formEndLabel('bill')).toBe('End date');
    expect(expiryNounForKind('bill')).toBe('ends on');
    expect(coveredThroughLabelForKind('bill')).toBe('In effect through');
    expect(openEndedDisplayLabel('bill')).toBe('Ongoing');
    // The one place B5's enumeration parts from `contract`: the open-ended checkbox label.
    expect(formOpenEndedLabel('bill')).toBe('Ongoing (no end date)');
    // Those dates describe the ITEM's life ("we have owned this property since..."), never the
    // schedule -- warranty_items.purchase_date is NOT NULL and stays so.
  });

  it('names the four installment states in one place', () => {
    expect(INSTALLMENT_SECTION_LABEL).toBe('Installments');
    expect(INSTALLMENT_STATES).toEqual(['paid', 'overdue', 'due_soon', 'scheduled']);
    expect(installmentStateLabel('paid')).toBe('Paid');
    expect(installmentStateLabel('overdue')).toBe('Overdue');
    expect(installmentStateLabel('due_soon')).toBe('Due soon');
    expect(installmentStateLabel('scheduled')).toBe('Scheduled');
  });

  it('names both refusals and both matching blurbs in one place (MUST-19.11)', () => {
    expect(MATCHING_KIND_ERROR).toBe('Payment matching only applies to loans and bills.');
    expect(INSTALLMENT_KIND_ERROR).toBe('A due-date schedule only applies to bills.');
    expect(matchingBlurbForKind('loan')).toContain('takes it off the balance');
    expect(matchingBlurbForKind('bill')).toContain('next unpaid installment');
    expect(matchingBlurbForKind('bill')).not.toContain('balance');
    // Both blurbs must keep the budget promise MUST-14.6 requires above the rules table.
    expect(matchingBlurbForKind('loan')).toContain('still counts in your budget');
    expect(matchingBlurbForKind('bill')).toContain('still counts in your budget');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/lib/warranty/constants.test.ts`
Expected: FAIL — the new exports do not exist, and `billingAllowedForKind('bill')` would be `true`
under the old negative gate.

- [ ] **Step 3: Edit `src/lib/warranty/constants.ts`.** Six edits, in file order.

**3a — `ITEM_KINDS` and its docblock (lines 18–21):**

```ts
/** v1.2.2: the kinds an item type can be. Loans are dates + documents only -- no balance math
 * (spec section 17, decision recorded there). v1.12.0 adds a fifth, `bill`: an item whose
 * reminder data is an explicit SCHEDULE of due dates (bill_installments) rather than a cadence,
 * because a property tax bill falls due on irregular dates a municipality picks and no interval
 * expresses that. */
export const ITEM_KINDS = ['warranty', 'subscription', 'contract', 'loan', 'bill'] as const;
```

**3b — `ITEM_KIND_LABELS` (lines 27–33):**

```ts
/** Human labels for the admin page's kind <select> (five options, one per kind). */
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  warranty: 'Warranty',
  subscription: 'Subscription',
  contract: 'Contract',
  loan: 'Loan',
  bill: 'Bill',
};
```

**3c — `KIND_WORDING` gains a `bill` row** after the `loan` row (before the closing `};` at line
100), and the docblock's four-line kind table (lines 39–42) gains a fifth line:

```
 *   bill:         Start date    / Term (months)      / ends on   / End date     / In effect through  / Ongoing (no end date)
```

```ts
  // Ruling B5: `contract`'s row, because a bill's own dates describe the ITEM's life ("we have
  // owned this property since...") and never the schedule -- purchase_date is NOT NULL and
  // stays so. Duplicating one row of a wording matrix is not a MUST-19.11 violation: that rule
  // forbids a second PLACE, not a fifth row. The one departure from `contract` is `openEnded`:
  // "Open-ended" reads as a contract with no fixed term, and a bill that is simply ongoing is
  // better named the way a subscription and a loan already name it.
  bill: {
    start: 'Start date',
    term: 'Term (months)',
    expiryVerb: 'ends on',
    expiringVerb: 'Ends',
    end: 'End date',
    coveredThrough: 'In effect through',
    openEnded: 'Ongoing (no end date)',
  },
```

**3d — the gates (replace lines 227–264's `billingAllowedForKind` and add two more after
`productFieldsAllowedForKind`).** Keep `loanFieldsAllowedForKind` and
`productFieldsAllowedForKind` and their docblocks exactly as they are.

```ts
/**
 * v1.3.1: widened to include 'loan'. A loan's billing pair is its regular PAYMENT
 * (see BILLING_WORDING) -- the amount and the cadence, not an interest calculation.
 *
 * v1.12.0 (ruling B4): an ALLOWLIST, not a negation. This read `kind !== 'warranty'`, and a
 * negative gate is a gate that admits every kind nobody has thought of yet: adding 'bill' under
 * it would silently have handed a bill the cadence fields ruling C4 forbids, with no compiler
 * error and no test failure. A bill's schedule REPLACES the cadence; it never sits beside it.
 *
 * This is still the ENTIRE server-side rule. assertBillingMatchesKind() in items.ts calls this
 * predicate, setItemTypeKind()'s clearing pass calls it, and both forms gate their fieldset on
 * it -- so one edit moves every one of them together. The rule lives here, in the app layer,
 * rather than in SQL, because a CHECK on warranty_items cannot see across to
 * warranty_item_types.kind; drizzle/0005_billing_cycle.sql's own header says so, which is why
 * widening it needs no DDL and no table rebuild (MUST-11.6).
 */
export function billingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'subscription' || kind === 'contract' || kind === 'loan';
}
```

...and, immediately after `productFieldsAllowedForKind`:

```ts
/**
 * v1.12.0: a due-date SCHEDULE instead of a cadence, and bills only. Property tax is two to six
 * installments a year on fixed, irregular dates a municipality sets; no cadence expresses that,
 * and a reminder that fires on the wrong day is worse than no reminder.
 *
 * Same "a gate decides what a form OFFERS, never what it may HIDE" note productFieldsAllowedForKind
 * carries: the detail page renders the Installments section whenever the item HAS installments,
 * whatever the kind (ruling B7). This predicate gates ADD and MARK PAID, not the section.
 */
export function installmentsAllowedForKind(kind: ItemKind): boolean {
  return kind === 'bill';
}

/**
 * v1.12.0: which kinds may carry merchant-matching rules at all. A matched transaction takes a
 * payment off a loan's balance, or marks a bill's earliest unpaid installment paid; for the
 * other three kinds there is nothing for a match to do.
 */
export function matchingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'loan' || kind === 'bill';
}
```

**3e — `BILLING_WORDING` and `OPEN_ENDED_DISPLAY_LABEL` each gain a `bill` row.** Both are
`Record<ItemKind, ...>`, so the compiler names them; this is the mechanism, not a checklist.

```ts
  // Present only so the record is total, and unreachable: billingAllowedForKind('bill') is
  // false, exactly as the `warranty` row's own comment above explains.
  bill: { section: 'Billing', amount: 'Amount', monthly: '/ month', annual: '/ year' },
```

```ts
  bill: 'Ongoing',
```

**3f — the new wording and the two refusals, appended at the end of the file:**

```ts
/**
 * v1.12.0: the four states an installment can be in. Declared HERE rather than beside the data
 * layer in installments.ts for the Ruling P4 reason that governs this whole module: the detail
 * page is a client component and calls installmentStateLabel(), so both the labels and the type
 * they are keyed by have to live somewhere that never imports @/db. installments.ts imports the
 * type from here; it does not redeclare it.
 *
 * The state is DERIVED at read time, never stored -- see installmentStateFor() -- so there is no
 * column that can disagree with the dates it is computed from.
 */
export type InstallmentState = 'paid' | 'overdue' | 'due_soon' | 'scheduled';
export const INSTALLMENT_STATES: readonly InstallmentState[] = ['paid', 'overdue', 'due_soon', 'scheduled'];

/** MUST-19.11: the one place the section is named. */
export const INSTALLMENT_SECTION_LABEL = 'Installments';

const INSTALLMENT_STATE_LABELS: Record<InstallmentState, string> = {
  paid: 'Paid',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  scheduled: 'Scheduled',
};

export function installmentStateLabel(state: InstallmentState): string {
  return INSTALLMENT_STATE_LABELS[state];
}

/**
 * v1.12.0. Replaces the string literal 'Payment matching only applies to loans.' that was
 * hard-coded in warranties/actions.ts. Lives here with the rest of the kind wording, not in the
 * action: MUST-19.11 keeps user-facing kind wording in one place, and actions.ts has a test
 * asserting its exports are all actions -- a string constant exported from there breaks that
 * guard for no reason. Same argument as ITEM_TYPE_IMMUTABLE_ERROR above.
 */
export const MATCHING_KIND_ERROR = 'Payment matching only applies to loans and bills.';

/** v1.12.0: refused by addInstallment() in the data layer and by addInstallmentAction. */
export const INSTALLMENT_KIND_ERROR = 'A due-date schedule only applies to bills.';

/**
 * The sentence above the Payment matching rules table. Both arms keep MUST-14.6's budget
 * promise, because that is the thing a person is most likely to get wrong about this feature:
 * a matched payment is still a real transaction in the budget and in the reports.
 *
 * Only 'loan' and 'bill' are reachable -- matchingAllowedForKind() gates the whole card -- and
 * the other three fall through to the loan sentence rather than inventing a fourth string for a
 * screen nobody can reach.
 */
export function matchingBlurbForKind(kind: ItemKind): string {
  if (kind === 'bill') {
    return (
      "When a transaction's merchant contains this text, the app marks the next unpaid installment on this bill " +
      'as paid and records which transaction paid it. The payment still counts in your budget and in your reports.'
    );
  }
  return (
    "When a transaction's merchant contains this text, the app treats it as a payment on this loan and takes it " +
    'off the balance. The payment still counts in your budget and in your reports.'
  );
}
```

- [ ] **Step 4: Run the gate test.**

Run: `npx vitest run tests/lib/warranty/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Mirror the table in `src/db/schema.ts`.** Three edits.

**5a** — `warrantyItemTypes.kind`'s enum (line 617) gains `'bill'`, and the docblock above the
table (ending at line 608) gains one paragraph:

```ts
    kind: text('kind', { enum: ['warranty', 'subscription', 'contract', 'loan', 'bill'] }).notNull().default('warranty'),
```

```
 * v1.12.0: `kind` gains a fifth value, 'bill'. SQLite cannot ALTER a CHECK, so
 * drizzle/0011_bill_installments.sql REBUILT this table -- the second time a shipped table in
 * this schema has been recreated, and the first time one carrying data nobody can regenerate
 * has been. Unlike 0010's drop-and-recreate, 0011 does the full INSERT ... SELECT rebuild and a
 * test asserts every row survives, because a hand-typed item type exists nowhere else and
 * warranty_items.type_id points at it.
```

**5b** — the `loanMatcherRules` docblock (above line 800) gains one paragraph (ruling B10):

```
 * v1.12.0: this table now also carries rules for BILL-kind items, whose matched transactions
 * mark an installment paid instead of moving a balance. The name is historical and stays: the
 * rule row's shape did not change by one column, and renaming a shipped table for accuracy is a
 * migration with a cost and no benefit. The FUNCTION that reads it was renamed
 * (applyLoanMatchers -> applyPaymentMatchers) because a function name is free to change and a
 * table name is not.
```

**5c** — append the new table at the end of the file:

```ts
/**
 * A bill's explicit schedule (spec 2026-08-24, ruling C3). Mirrors
 * drizzle/0011_bill_installments.sql.
 *
 * NOT represented here; SQL only:
 *   - CHECK (due_date GLOB '____-__-__')
 *   - CHECK (amount_cents > 0)
 *   - CHECK (paid_txn_id IS NULL OR paid_at IS NOT NULL)
 *
 * Named after the FEATURE that owns it, not after its parent table (ruling B3) -- the same way
 * loan_matcher_rules and loan_payments both hang off warranty_items and neither is called
 * warranty_item_*.
 *
 * bill_installments_txn_uq IS the idempotency guard (ruling B12), the same shape
 * loan_payments_txn_item_uq takes. SQLite treats NULLs as distinct in a unique index, so the
 * many hand-marked rows need no partial index, and a matched transaction can mark at most one
 * installment, for ever, whatever re-runs.
 *
 * There is deliberately NO unique index on (item_id, due_date): two parcels can fall due on the
 * same day for one bill at different amounts. Ordering is due_date ASC, id ASC everywhere, so
 * "the earliest unpaid installment" is total and deterministic even then.
 */
export const billInstallments = sqliteTable(
  'bill_installments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** ISO YYYY-MM-DD. The municipality's date, typed by a person. */
    dueDate: text('due_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** ISO timestamp, or NULL for unpaid. The one field every reader filters on. */
    paidAt: text('paid_at'),
    /** NULL means a PERSON marked this paid (ruling B13). Non-NULL means a rule matched. There
     *  is deliberately no `source` column: this link column already answers the question, and a
     *  second column that must agree with it is a second column that can disagree with it. */
    paidTxnId: integer('paid_txn_id').references(() => transactions.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bill_installments_txn_uq').on(t.paidTxnId),
    index('bill_installments_item_idx').on(t.itemId, t.dueDate),
    index('bill_installments_due_idx').on(t.paidAt, t.dueDate),
  ],
);
```

- [ ] **Step 6: Write the failing installments test.** Create
  `tests/lib/warranty/installments.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { INSTALLMENT_KIND_ERROR } from '@/lib/warranty/constants';
import {
  addInstallment,
  installmentStateFor,
  listInstallments,
  markInstallmentPaid,
  removeInstallment,
  unmarkInstallmentPaid,
  unpaidInstallments,
} from '@/lib/warranty/installments';

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup(): { userId: number } {
  current = createTestDb();
  return { userId: insertTestUser(current.db, { username: 'user-1' }) };
}

function typeOfKind(kind: string, name: string): number {
  const row = current!.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, ?, ?, ?) returning id`)
    .get(name, kind === 'subscription' ? 1 : 0, kind, NOW) as { id: number };
  return row.id;
}

function item(userId: number, typeId: number, name = 'Municipal tax'): number {
  const row = current!.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values (?, '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(name, userId, typeId, NOW, NOW) as { id: number };
  return row.id;
}

function billItem(userId: number, name = 'Municipal tax'): number {
  return item(userId, typeOfKind('bill', `Property tax ${name}`), name);
}

describe('addInstallment', () => {
  it('adds to a bill item and reads back in due_date, id order', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000, at: NOW });
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 95_000, at: NOW });
    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-09-30', '2026-11-30']);
    expect(rows.map((r) => r.amountCents)).toEqual([95_000, 120_000]);
    expect(rows.every((r) => r.paidAt === null && r.paidTxnId === null && r.paidTxn === null)).toBe(true);
  });

  it('breaks a same-date tie by id, so "earliest unpaid" is a total order', () => {
    // Two parcels, same bill, same day, different amounts -- which is exactly why there is no
    // unique index on (item_id, due_date).
    const { userId } = setup();
    const itemId = billItem(userId);
    const first = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 300_000, at: NOW });
    const second = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 10_000, at: NOW });
    expect(listInstallments(itemId, TODAY, 30).map((r) => r.id)).toEqual([first, second]);
  });

  it('refuses a non-bill item, in the DATA layer and not only in the action', () => {
    const { userId } = setup();
    for (const kind of ['warranty', 'subscription', 'contract', 'loan']) {
      const itemId = item(userId, typeOfKind(kind, `Type ${kind}`), `Item ${kind}`);
      expect(() => addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 100, at: NOW })).toThrowError(
        INSTALLMENT_KIND_ERROR,
      );
    }
  });

  it('refuses a malformed date, a non-positive amount and a date before 1970', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    expect(() => addInstallment({ itemId, dueDate: '2026-9-30', amountCents: 100, at: NOW })).toThrow();
    expect(() => addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 0, at: NOW })).toThrow();
    expect(() => addInstallment({ itemId, dueDate: '1969-12-31', amountCents: 100, at: NOW })).toThrow();
  });

  it('ALLOWS a due date in the past -- that is the case the overdue state exists for', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    addInstallment({ itemId, dueDate: '2025-03-01', amountCents: 100_000, at: NOW });
    expect(listInstallments(itemId, TODAY, 30)[0]?.state).toBe('overdue');
  });
});

describe('the derived state', () => {
  it('is paid / overdue / due_soon / scheduled, with both boundaries inclusive', () => {
    // paid wins over everything, including an overdue date.
    expect(installmentStateFor('2020-01-01', NOW, TODAY, 30)).toBe('paid');
    // strictly before today is overdue; today itself is not.
    expect(installmentStateFor('2026-08-23', null, TODAY, 30)).toBe('overdue');
    expect(installmentStateFor('2026-08-24', null, TODAY, 30)).toBe('due_soon');
    // the window's far edge is inclusive: today + 30 is still due_soon, today + 31 is not.
    expect(installmentStateFor('2026-09-23', null, TODAY, 30)).toBe('due_soon');
    expect(installmentStateFor('2026-09-24', null, TODAY, 30)).toBe('scheduled');
    // and the window is the CALLER's, so a different reader gets a different answer for the
    // same row -- that is the point, not a bug.
    expect(installmentStateFor('2026-09-24', null, TODAY, 45)).toBe('due_soon');
  });
});

describe('marking paid', () => {
  it('sets paid_at, leaves paid_txn_id NULL (ruling B13) and is idempotent', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    // Second call: the desired state already holds, so it reports success rather than failure.
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    const row = listInstallments(itemId, TODAY, 30)[0]!;
    expect(row.state).toBe('paid');
    expect(row.paidAt).toBe(NOW);
    expect(row.paidTxnId).toBeNull();
    expect(row.paidTxn).toBeNull();
  });

  it('unmark clears BOTH columns, including a rule-set link', () => {
    const { userId } = setup();
    const itemId = billItem(userId);
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txn = current!.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, '2026-09-30', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ?, ?, ?) returning id`,
      )
      .get(accountId, userId, NOW, NOW) as { id: number };
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    current!.sqlite.prepare('update bill_installments set paid_at = ?, paid_txn_id = ? where id = ?').run(NOW, txn.id, id);

    const linked = listInstallments(itemId, TODAY, 30)[0]!;
    expect(linked.paidTxn).toEqual({ id: txn.id, date: '2026-09-30', description: 'CITY TAX OFFICE', amountCents: -120_000 });

    expect(unmarkInstallmentPaid(id)).toBe(true);
    const after = listInstallments(itemId, TODAY, 30)[0]!;
    expect(after.paidAt).toBeNull();
    expect(after.paidTxnId).toBeNull();
    expect(after.paidTxn).toBeNull();
    // mark -> unmark -> mark is a cycle, not a one-way door.
    expect(markInstallmentPaid(id, NOW)).toBe(true);
    expect(listInstallments(itemId, TODAY, 30)[0]!.state).toBe('paid');
  });

  it('reports false for an installment that is not there', () => {
    setup();
    expect(markInstallmentPaid(9999, NOW)).toBe(false);
    expect(unmarkInstallmentPaid(9999)).toBe(false);
    expect(removeInstallment(9999)).toBe(false);
  });
});

describe('removeInstallment', () => {
  it('does NOT assert the kind (ruling B7): a row kept on a flipped type is still removable', () => {
    const { userId } = setup();
    const typeId = typeOfKind('bill', 'Property tax');
    const itemId = item(userId, typeId);
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: NOW });
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract' where id = ?`).run(typeId);
    expect(removeInstallment(id)).toBe(true);
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });
});

describe('unpaidInstallments', () => {
  function seedTwoHouseholds(): { mine: number; itemId: number } {
    const { userId } = setup();
    const other = insertTestUser(current!.db, { username: 'user-2' });
    const itemId = billItem(userId);
    const theirs = billItem(other, 'Their tax');
    addInstallment({ itemId, dueDate: '2026-08-30', amountCents: 120_000, at: NOW });  // inside
    addInstallment({ itemId, dueDate: '2026-12-30', amountCents: 120_000, at: NOW });  // outside
    const paid = addInstallment({ itemId, dueDate: '2026-08-26', amountCents: 5_000, at: NOW });
    markInstallmentPaid(paid, NOW);
    addInstallment({ itemId: theirs, dueDate: '2026-08-30', amountCents: 999, at: NOW });
    return { mine: userId, itemId };
  }

  it('returns unpaid rows inside the window, with the item name and owner', () => {
    const { mine, itemId } = seedTwoHouseholds();
    const rows = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId,
      itemName: 'Municipal tax',
      ownerUserId: mine,
      dueDate: '2026-08-30',
      amountCents: 120_000,
      overdue: false,
    });
  });

  it('omits overdue rows unless asked, and marks them when asked', () => {
    const { mine, itemId } = seedTwoHouseholds();
    addInstallment({ itemId, dueDate: '2024-05-01', amountCents: 70_000, at: NOW });
    const without = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine });
    expect(without.map((r) => r.dueDate)).toEqual(['2026-08-30']);
    const withOverdue = unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true, ownerUserId: mine });
    expect(withOverdue.map((r) => r.dueDate)).toEqual(['2024-05-01', '2026-08-30']);
    expect(withOverdue.map((r) => r.overdue)).toEqual([true, false]);
  });

  it('scopes to one owner when asked and spans the household when not', () => {
    const { mine } = seedTwoHouseholds();
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false, ownerUserId: mine })).toHaveLength(1);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: false })).toHaveLength(2);
  });

  it('never returns a row whose item type is not a bill', () => {
    const { userId } = setup();
    const typeId = typeOfKind('bill', 'Property tax');
    const itemId = item(userId, typeId);
    addInstallment({ itemId, dueDate: '2026-08-30', amountCents: 120_000, at: NOW });
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toHaveLength(1);
    // Ruling B6: flipping the kind KEEPS the rows; every reader joins on kind = 'bill', so they
    // simply go quiet -- and come back when the type is flipped back.
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract' where id = ?`).run(typeId);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toEqual([]);
    current!.sqlite.prepare(`update warranty_item_types set kind = 'bill' where id = ?`).run(typeId);
    expect(unpaidInstallments({ today: TODAY, windowEnd: '2026-09-23', includeOverdue: true })).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run it and watch it fail.**

Run: `npx vitest run tests/lib/warranty/installments.test.ts`
Expected: FAIL — `Cannot find module '@/lib/warranty/installments'`.

- [ ] **Step 8: Write `src/lib/warranty/installments.ts`.**

```ts
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { billInstallments, transactions, warrantyItemTypes, warrantyItems } from '@/db/schema';
import { nowIso } from '@/lib/clock';
import { addDaysIso, isIsoDate } from '@/lib/dates';
import { MIN_PURCHASE_DATE } from '@/lib/warranty/items';
import {
  INSTALLMENT_KIND_ERROR,
  installmentsAllowedForKind,
  type InstallmentState,
  type ItemKind,
} from '@/lib/warranty/constants';

/**
 * A bill's due-date schedule (spec 2026-08-24, ruling C3). SERVER-ONLY: this module imports
 * @/db, so it must never be imported by a client component -- the detail page takes
 * InstallmentRow[] as a PROP, and a `import type` is fine because it is erased. That is the same
 * Ruling P4 boundary constants.ts documents, seen from the other side.
 *
 * Clock-free in the project-wide sense (the rule src/lib/bills.ts's header states): `today` and
 * the window are always parameters, never `new Date()`. The one exception is the OPTIONAL `at`
 * on the two writers, which defaults to nowIso() the way every other writer in this codebase
 * does.
 */

/** The lookahead the DETAIL PAGE uses for its "Due soon" badge. The notification evaluator
 *  passes the user's own comingDueDays instead, deliberately: a reader's window is its own. */
export const INSTALLMENT_DUE_SOON_DAYS = 30;

export interface InstallmentTxn {
  id: number;
  date: string;
  description: string;
  amountCents: number;
}

export interface InstallmentRow {
  id: number;
  itemId: number;
  dueDate: string;
  amountCents: number;
  paidAt: string | null;
  paidTxnId: number | null;
  /** Only when paidTxnId is set: what the matched transaction actually was. Ruling C7 shows the
   *  difference between this amount and the installment's rather than suppressing the match. */
  paidTxn: InstallmentTxn | null;
  state: InstallmentState;
}

export interface UnpaidInstallment {
  installmentId: number;
  itemId: number;
  itemName: string;
  ownerUserId: number;
  dueDate: string;
  amountCents: number;
  overdue: boolean;
}

/**
 * DERIVED, never stored: paid_at wins; else strictly before today is overdue; else on or before
 * today + dueSoonDays is due soon; else scheduled. Both boundaries are inclusive on the near
 * side -- an installment due TODAY is due soon, not overdue -- because a bill due today has not
 * been missed yet.
 */
export function installmentStateFor(
  dueDate: string,
  paidAt: string | null,
  today: string,
  dueSoonDays: number,
): InstallmentState {
  if (paidAt !== null) return 'paid';
  if (dueDate < today) return 'overdue';
  if (dueDate <= addDaysIso(today, dueSoonDays)) return 'due_soon';
  return 'scheduled';
}

function kindOfItem(itemId: number): ItemKind {
  // LEFT join, then normalise: an untyped item is 'warranty' everywhere else in this codebase
  // (see toItemRow in items.ts), and an item that does not exist at all is equally not a bill.
  const row = getDb()
    .select({ kind: warrantyItemTypes.kind })
    .from(warrantyItems)
    .leftJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(eq(warrantyItems.id, itemId))
    .get();
  return (row?.kind ?? 'warranty') as ItemKind;
}

/** due_date ASC, id ASC. The total order every other function in this file relies on. */
export function listInstallments(itemId: number, today: string, dueSoonDays: number): InstallmentRow[] {
  const rows = getDb()
    .select({
      id: billInstallments.id,
      itemId: billInstallments.itemId,
      dueDate: billInstallments.dueDate,
      amountCents: billInstallments.amountCents,
      paidAt: billInstallments.paidAt,
      paidTxnId: billInstallments.paidTxnId,
      txnDate: transactions.date,
      txnRaw: transactions.rawDescription,
      txnDisplay: transactions.displayDescription,
      txnAmountCents: transactions.amountCents,
    })
    .from(billInstallments)
    .leftJoin(transactions, eq(transactions.id, billInstallments.paidTxnId))
    .where(eq(billInstallments.itemId, itemId))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    paidAt: row.paidAt,
    paidTxnId: row.paidTxnId,
    paidTxn:
      row.paidTxnId === null || row.txnDate === null
        ? null
        : {
            id: row.paidTxnId,
            date: row.txnDate,
            // Same precedence displayNameOf() uses on the transactions page: a renamed
            // transaction shows the name a person gave it.
            description: row.txnDisplay ?? row.txnRaw ?? '',
            amountCents: row.txnAmountCents ?? 0,
          },
    state: installmentStateFor(row.dueDate, row.paidAt, today, dueSoonDays),
  }));
}

/**
 * Returns the new row's id.
 *
 * The kind assertion is HERE, in the data layer, not only in the action -- the same argument
 * assertBillingMatchesKind() makes about createWarrantyItem staying correct for every caller.
 * The three CHECK constraints in drizzle/0011 are the backstop underneath these three refusals,
 * not a substitute for them: a CHECK cannot see across to warranty_item_types.kind.
 *
 * A due date in the PAST is allowed on purpose. A household enters a bill it is already behind
 * on, and that is exactly the case the overdue state exists to surface. MIN_PURCHASE_DATE's
 * 1970-01-01 floor still applies, because a date below it is a typo rather than a history.
 */
export function addInstallment(input: {
  itemId: number;
  dueDate: string;
  amountCents: number;
  at?: string;
}): number {
  if (!installmentsAllowedForKind(kindOfItem(input.itemId))) throw new Error(INSTALLMENT_KIND_ERROR);
  if (!isIsoDate(input.dueDate)) throw new Error('Due date must be YYYY-MM-DD');
  if (input.dueDate < MIN_PURCHASE_DATE) throw new Error('Due date is before 1970-01-01');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error('Amount must be more than zero.');
  }
  const row = getDb()
    .insert(billInstallments)
    .values({
      itemId: input.itemId,
      dueDate: input.dueDate,
      amountCents: input.amountCents,
      paidAt: null,
      paidTxnId: null,
      createdAt: input.at ?? nowIso(),
    })
    .returning({ id: billInstallments.id })
    .get();
  return row.id;
}

/**
 * Ruling B7: NO kind assertion. A gate decides what a form offers, never what it may hide, and
 * removing a stored row must stay possible after a type's kind has been flipped away from bill
 * -- otherwise ruling B6's "kept, never deleted" rows would be unreachable as well as invisible.
 */
export function removeInstallment(id: number): boolean {
  return getDb().delete(billInstallments).where(eq(billInstallments.id, id)).run().changes > 0;
}

/**
 * Manual mark-paid: paid_at is set and paid_txn_id is left NULL, which is what "a person marked
 * this" MEANS in this schema (ruling B13).
 *
 * Idempotent, and the `paid_at IS NULL` guard is why: two people marking the same installment
 * make the second UPDATE a no-op, and the desired state still holds, so this reports true. It
 * returns false only when the row is genuinely not there -- the case the action turns into
 * "That installment no longer exists."
 */
export function markInstallmentPaid(id: number, at: string = nowIso()): boolean {
  const db = getDb();
  const changed = db
    .update(billInstallments)
    .set({ paidAt: at })
    .where(and(eq(billInstallments.id, id), isNull(billInstallments.paidAt)))
    .run().changes;
  if (changed > 0) return true;
  return db.select({ id: billInstallments.id }).from(billInstallments).where(eq(billInstallments.id, id)).get() !== undefined;
}

/** Clears BOTH columns -- unmarking a rule-marked row also drops the link, because a paid_txn_id
 *  on an unpaid row is exactly what drizzle/0011's third CHECK forbids. */
export function unmarkInstallmentPaid(id: number): boolean {
  return (
    getDb()
      .update(billInstallments)
      .set({ paidAt: null, paidTxnId: null })
      .where(eq(billInstallments.id, id))
      .run().changes > 0
  );
}

/**
 * The reader ruling C6 needs: unpaid rows on BILL-KIND items, joined to their item's name and
 * owner. Ordered due_date ASC, id ASC, so overdue rows sort ahead of upcoming ones with no
 * second sort key.
 *
 * MUST-6.11's ownership rule needs no new column: an installment's owner is its item's
 * owner_user_id. Omitting ownerUserId spans the whole household, which is what the dashboard
 * card wants (a bill is not attributed to one person the way a transaction is).
 */
export function unpaidInstallments(input: {
  today: string;
  windowEnd: string;
  includeOverdue: boolean;
  ownerUserId?: number;
}): UnpaidInstallment[] {
  const conditions = [
    isNull(billInstallments.paidAt),
    eq(warrantyItemTypes.kind, 'bill'),
    lte(billInstallments.dueDate, input.windowEnd),
  ];
  if (!input.includeOverdue) conditions.push(gte(billInstallments.dueDate, input.today));
  if (input.ownerUserId !== undefined) conditions.push(eq(warrantyItems.ownerUserId, input.ownerUserId));

  return getDb()
    .select({
      installmentId: billInstallments.id,
      itemId: warrantyItems.id,
      itemName: warrantyItems.name,
      ownerUserId: warrantyItems.ownerUserId,
      dueDate: billInstallments.dueDate,
      amountCents: billInstallments.amountCents,
    })
    .from(billInstallments)
    .innerJoin(warrantyItems, eq(warrantyItems.id, billInstallments.itemId))
    // INNER, not LEFT: an untyped item normalises to kind 'warranty' everywhere else and can
    // never be a bill, so it is correctly dropped by requiring a matching type row at all --
    // the same argument upcomingBills() already makes for its own join.
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(and(...conditions))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .all()
    .map((row) => ({ ...row, overdue: row.dueDate < input.today }));
}
```

- [ ] **Step 9: Run the installments test.**

Run: `npx vitest run tests/lib/warranty/installments.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing kind-flip test.** Append to `tests/lib/warranty/types.test.ts`
  (its `setup()`, `insertItem()` and `idOf()` helpers already exist at the top of that file; add
  `addInstallment, listInstallments` to its imports from `@/lib/warranty/installments`, and
  `createItemType` is already imported):

```ts
/**
 * Ruling B6. setItemTypeKind() clears disallowed COLUMNS on a flip, and that is right for a
 * cadence nobody typed. Installment ROWS are dates and amounts a person entered by hand, and
 * deleting them because someone changed a dropdown on the Settings page is silent data loss. So
 * the clearing pass is deliberately ASYMMETRIC, and this pins both halves.
 */
describe('flipping a type to and from bill', () => {
  it('flipping TO bill clears the billing pair and the four loan columns on its items', () => {
    const { userId } = setup();
    const typeId = createItemType('Municipal', 'loan').id;
    const itemId = insertItem(typeId, userId, 'Car');
    current!.sqlite
      .prepare(
        `update warranty_items set billing_cycle = 'monthly', billing_amount_cents = 45000,
           principal_cents = 2000000, interest_rate_bps = 550, current_balance_cents = 1500000,
           balance_updated_at = ? where id = ?`,
      )
      .run(ISO, itemId);

    setItemTypeKind(typeId, 'bill');

    const after = getWarrantyItem(itemId)!;
    expect(after.kind).toBe('bill');
    expect(after.billingCycle).toBeNull();
    expect(after.billingAmountCents).toBeNull();
    expect(after.principalCents).toBeNull();
    expect(after.interestRateBps).toBeNull();
    expect(after.currentBalanceCents).toBeNull();
    expect(after.balanceUpdatedAt).toBeNull();
  });

  it('flipping AWAY from bill deletes NO installment row, and they come back', () => {
    const { userId } = setup();
    const typeId = createItemType('Property tax', 'bill').id;
    const itemId = insertItem(typeId, userId, 'Municipal tax');
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000, at: ISO });
    addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000, at: ISO });

    setItemTypeKind(typeId, 'contract');
    // The rows are KEPT. Every reader joins on kind = 'bill', so they simply go quiet.
    expect(listInstallments(itemId, '2026-08-24', 30)).toHaveLength(2);

    setItemTypeKind(typeId, 'bill');
    expect(listInstallments(itemId, '2026-08-24', 30).map((r) => r.dueDate)).toEqual(['2026-09-30', '2026-11-30']);
  });
});
```

- [ ] **Step 11: Run it and watch it fail.**

Run: `npx vitest run tests/lib/warranty/types.test.ts`
Expected: FAIL — `setItemTypeKind(typeId, 'bill')` does not clear the loan columns yet, because
`loanFieldsAllowedForKind('bill')` is already false but `billingAllowedForKind('bill')` was true
before Task 3's Step 3d. If Step 3d has landed, the first test may already pass; the second is the
one that matters, and it must be run to confirm it is green rather than assumed.

- [ ] **Step 12: Update `setItemTypeKind`'s docblock** in `src/lib/warranty/types.ts`. No code
  change is needed — `billingAllowedForKind` and `loanFieldsAllowedForKind` already drive the two
  clearing passes and both now return false for `'bill'`, so a flip *to* `bill` clears both sets
  with no edit. What must change is the docblock, because the asymmetry is now deliberate and
  undocumented asymmetry reads as an oversight. Add, after the existing MUST-12.6 paragraph
  (around line 189):

```
     * v1.12.0 (ruling B6): the asymmetry is deliberate. A flip TO 'bill' clears the billing pair
     * and the four loan columns, because both gates say false for a bill and the schedule
     * replaces the cadence. A flip AWAY FROM 'bill' clears nothing and deletes NOTHING: a
     * bill_installments row is a date and an amount a person typed by hand, and dropping it
     * because somebody changed a Settings-page dropdown is silent data loss. Every reader joins
     * on kind = 'bill', so kept rows go quiet and come back if the type is flipped back.
```

- [ ] **Step 13: Run the type tests.**

Run: `npx vitest run tests/lib/warranty/types.test.ts`
Expected: PASS.

- [ ] **Step 14: Typecheck.** Widening `ITEM_KINDS` makes the compiler name every exhaustive
  `Record<ItemKind, ...>` that is now short a row — that is the mechanism this task relies on.

Run: `npx tsc --noEmit`
Expected: clean. Any error is a matrix that needs its fifth row; add it, do not cast.

- [ ] **Step 15: Run all four of this task's test files together.**

Run: `npx vitest run tests/lib/warranty/constants.test.ts tests/lib/warranty/installments.test.ts tests/lib/warranty/types.test.ts tests/lib/warranty/items.test.ts`
Expected: PASS.

- [ ] **Step 16: Commit**

```bash
git add src/lib/warranty/constants.ts src/lib/warranty/installments.ts src/lib/warranty/types.ts src/db/schema.ts tests/lib/warranty
git commit -m "feat(warranty): add the bill kind, its gates and the installments data layer"
```

---
# Wave 2 — the consumers (T4, T5, T6, T7 are fully parallel: disjoint files)

All four consume Tasks 2 and 3 and nothing from each other. Do not edit a file listed under
another task in this wave.

### Task 4: the Installments card, its three actions, and the widened matching gate

**Files:**
- Modify: `src/app/(app)/warranties/[id]/page.tsx:1-50`
- Modify: `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (imports at `:1-44`; props at
  `:82-112`; new `useActionState` hooks beside the rule ones at `:156-168`; the new card and the
  Payment matching card at `:383-467`)
- Modify: `src/app/(app)/warranties/actions.ts` (imports at `:12-43`; `saveLoanRuleAction`'s kind
  refusal at `:531`; three new actions at the end of the file)
- Create: `tests/app/warranty-installments.test.ts`
- Modify: `tests/app/warranty-detail-client.test.tsx` (one prop added to its render helper — the
  only edit permitted to it)
- Read only, to confirm ruling C5 needs no edit: `src/app/(app)/warranties/new/new-warranty-client.tsx`

**Interfaces:**
- Consumes from T3, exactly:
  `listInstallments(itemId, today, dueSoonDays) => InstallmentRow[]`,
  `addInstallment({ itemId, dueDate, amountCents, at? }) => number`,
  `removeInstallment(id) => boolean`, `markInstallmentPaid(id, at?) => boolean`,
  `unmarkInstallmentPaid(id) => boolean`, `INSTALLMENT_DUE_SOON_DAYS`, `type InstallmentRow`,
  and from `constants.ts`: `installmentsAllowedForKind`, `matchingAllowedForKind`,
  `installmentStateLabel`, `INSTALLMENT_SECTION_LABEL`, `INSTALLMENT_KIND_ERROR`,
  `MATCHING_KIND_ERROR`, `matchingBlurbForKind`, `type InstallmentState`.
- Consumes (existing): `RowMenu`, `RowMenuForm` from `@/components/ui/RowMenu`; `TableWrap` from
  `@/components/ui/Table`; `EmptyState` from `@/components/ui/EmptyState`; `FormError`;
  `SubmitButton`; `Field`, `inputClass` from `@/components/ui/form`; `WarrantyActionState`
  (`{ error?: string; message?: string }`) and `revalidateAll(itemId?)` from `warranties/actions.ts`.
- Produces (used by no other task, but named here so a reviewer can check them):
  `addInstallmentAction(prev, formData)`, `removeInstallmentAction(prev, formData)`,
  `setInstallmentPaidAction(prev, formData)`, all
  `(prev: WarrantyActionState, formData: FormData) => Promise<WarrantyActionState>` and all plain
  `export async function` declarations (`tests/ops/use-server-exports.test.ts` requires that).

- [ ] **Step 1: Write the failing action test.** Create `tests/app/warranty-installments.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

const USER = { id: 1, name: 'Alice', username: 'user-1', role: 'admin' as const };
const SAME_ORIGIN = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
const CROSS_ORIGIN = new Headers({ origin: 'http://evil.local', host: 'nas.local:3000' });
let mockHeaders = SAME_ORIGIN;

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => USER),
  requireAdmin: vi.fn(async () => USER),
}));
vi.mock('next/headers', () => ({ headers: async () => mockHeaders }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import {
  addInstallmentAction,
  removeInstallmentAction,
  setInstallmentPaidAction,
  saveLoanRuleAction,
} from '@/app/(app)/warranties/actions';
import { INSTALLMENT_KIND_ERROR, MATCHING_KIND_ERROR } from '@/lib/warranty/constants';
import { listInstallments } from '@/lib/warranty/installments';

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  mockHeaders = SAME_ORIGIN;
});

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function setup(kind = 'bill'): { itemId: number; userId: number } {
  current = createTestDb();
  const userId = insertTestUser(current.db, { username: 'user-1' });
  const type = current.sqlite
    .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, ?, ?) returning id`)
    .get(`Type ${kind}`, kind, NOW) as { id: number };
  const item = current.sqlite
    .prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
       values ('Municipal tax', '2024-01-15', 0, ?, ?, ?, ?) returning id`,
    )
    .get(userId, type.id, NOW, NOW) as { id: number };
  return { itemId: item.id, userId };
}

describe('addInstallmentAction', () => {
  it('adds one row and reports what happened', async () => {
    const { itemId } = setup();
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBeUndefined();
    expect(result.message).toContain('2026-09-30');
    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(120_000);
  });

  it('refuses cross-origin before touching the database (MUST-13.1)', async () => {
    const { itemId } = setup();
    mockHeaders = CROSS_ORIGIN;
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBeTruthy();
    mockHeaders = SAME_ORIGIN;
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });

  it('refuses a non-bill item with the one shared sentence', async () => {
    const { itemId } = setup('contract');
    const result = await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    expect(result.error).toBe(INSTALLMENT_KIND_ERROR);
  });

  it('refuses a bad amount and a bad date, each with its own sentence', async () => {
    const { itemId } = setup();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: 'lots' }))).error)
      .toBeTruthy();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '0' }))).error)
      .toBeTruthy();
    expect((await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: 'soon', amount: '10.00' }))).error)
      .toBeTruthy();
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
  });
});

describe('setInstallmentPaidAction', () => {
  it('marks and unmarks through one action with a paid field', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;

    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }));
    expect(listInstallments(itemId, TODAY, 30)[0]!.state).toBe('paid');
    // Hand-marked: paid_txn_id stays NULL, which is what "a person did this" means (B13).
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidTxnId).toBeNull();

    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'false' }));
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidAt).toBeNull();
  });

  it('refuses to mark an installment on a non-bill item, but still allows unmarking one', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }));
    current!.sqlite.prepare(`update warranty_item_types set kind = 'contract'`).run();

    expect((await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'true' }))).error)
      .toBe(INSTALLMENT_KIND_ERROR);
    // Unmark is not an add: ruling B7 says a gate never hides or strands a stored value.
    expect((await setInstallmentPaidAction({}, fd({ id: String(id), itemId: String(itemId), paid: 'false' }))).error)
      .toBeUndefined();
    expect(listInstallments(itemId, TODAY, 30)[0]!.paidAt).toBeNull();
  });

  it('refuses an installment that does not belong to the claimed item', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    const result = await setInstallmentPaidAction({}, fd({ id: String(id), itemId: '9999', paid: 'true' }));
    expect(result.error).toBe('That installment no longer exists.');
  });
});

describe('removeInstallmentAction', () => {
  it('removes it and says the stale case out loud', async () => {
    const { itemId } = setup();
    await addInstallmentAction({}, fd({ itemId: String(itemId), dueDate: '2026-09-30', amount: '1200.00' }));
    const id = listInstallments(itemId, TODAY, 30)[0]!.id;
    expect((await removeInstallmentAction({}, fd({ id: String(id), itemId: String(itemId) }))).message).toBeTruthy();
    expect(listInstallments(itemId, TODAY, 30)).toEqual([]);
    // F3-fix-round treatment, same as the loan rules table: a second click has somewhere to land.
    expect((await removeInstallmentAction({}, fd({ id: String(id), itemId: String(itemId) }))).error).toBe(
      'That installment no longer exists.',
    );
  });
});

describe('the payment-matching gate widened to bills', () => {
  it('accepts a rule on a bill and refuses one on a contract, with the shared sentence', async () => {
    const { itemId } = setup();
    insertTestAccount(current!.db, { name: 'Chequing' });
    const ok = await saveLoanRuleAction({}, fd({ itemId: String(itemId), merchantContains: 'CITY TAX', accountId: '' }));
    expect(ok.error).toBeUndefined();

    const contract = setup('contract');
    const refused = await saveLoanRuleAction(
      {},
      fd({ itemId: String(contract.itemId), merchantContains: 'CITY TAX', accountId: '' }),
    );
    expect(refused.error).toBe(MATCHING_KIND_ERROR);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx vitest run tests/app/warranty-installments.test.ts`
Expected: FAIL — the three actions do not exist.

- [ ] **Step 3: Add the three actions to `src/app/(app)/warranties/actions.ts`.** First extend the
  imports: add
  `import { addInstallment, listInstallments, markInstallmentPaid, removeInstallment, unmarkInstallmentPaid, INSTALLMENT_DUE_SOON_DAYS } from '@/lib/warranty/installments';`
  and add `INSTALLMENT_KIND_ERROR, MATCHING_KIND_ERROR, installmentsAllowedForKind, matchingAllowedForKind`
  to the existing `@/lib/warranty/constants` import block at `:37-43`. Then append at the end of
  the file:

```ts
/**
 * v1.12.0: a bill's due-date schedule (spec 2026-08-24, Component 7).
 *
 * Each of these takes requireUser(), not requireAdmin -- deliberately, and matching every other
 * action in this file: an item's own household member manages that item's paperwork.
 *
 * The installment is always looked up THROUGH its claimed itemId rather than by id alone, the
 * same F10-fix-round discipline deleteLoanRuleAction uses: a mismatched pair (tampered, or a
 * stale tab racing a row that moved) would otherwise mutate an unrelated bill and revalidate the
 * wrong page.
 */
const installmentRefSchema = z.object({
  id: z.coerce.number().int().positive(),
  itemId: z.coerce.number().int().positive(),
});

function findInstallment(itemId: number, id: number) {
  // The window is irrelevant to a lookup, but listInstallments' signature asks for one; today's
  // date and the page's own window keep the derived state honest if a caller ever reads it.
  return listInstallments(itemId, todayIso(), INSTALLMENT_DUE_SOON_DAYS).find((row) => row.id === id);
}

const INSTALLMENT_GONE = 'That installment no longer exists.';

export async function addInstallmentAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  // MUST-13.1: origin FIRST, before auth, before validation, before any read.
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();

  const parsed = z
    .object({ itemId: z.coerce.number().int().positive() })
    .safeParse({ itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const item = getWarrantyItem(parsed.data.itemId);
  if (!item) return { error: 'That item no longer exists.' };
  if (!installmentsAllowedForKind(item.kind)) return { error: INSTALLMENT_KIND_ERROR };

  const dueDate = str(formData, 'dueDate').trim();
  const cents = parseAmountToCents(str(formData, 'amount').trim());
  if (cents === null) return { error: 'Amount is not a number.' };
  // Magnitude, the same normalisation readPriceCents() applies: a person typing -1,200.00 for a
  // bill means the size of the bill, and the CHECK in drizzle/0011 refuses anything else anyway.
  const amountCents = Math.abs(cents);

  try {
    addInstallment({ itemId: item.id, dueDate, amountCents });
  } catch (error) {
    return failure(error, 'Could not add that installment.');
  }
  revalidateAll(item.id);
  return { message: `Installment added for ${dueDate}.` };
}

export async function removeInstallmentAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = installmentRefSchema.safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };

  // Ruling B7: NO kind check here. Removing a stored row must stay possible after a type's kind
  // has been flipped away from bill, or ruling B6's kept rows would be unreachable as well as
  // invisible.
  if (findInstallment(parsed.data.itemId, parsed.data.id) === undefined) return { error: INSTALLMENT_GONE };
  removeInstallment(parsed.data.id);
  revalidateAll(parsed.data.itemId);
  return { message: 'Installment removed.' };
}

/**
 * ONE action for mark and unmark. Two actions differing by a boolean are one action, and a single
 * revalidate path is easier to keep honest than two.
 *
 * Marking is gated on the kind; UNMARKING is not, for ruling B7's reason -- a gate decides what a
 * form offers, never what it may hide, and a person must always be able to undo a mark on a row
 * that already exists.
 */
export async function setInstallmentPaidAction(
  _prev: WarrantyActionState,
  formData: FormData,
): Promise<WarrantyActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  await requireUser();
  const parsed = installmentRefSchema.safeParse({ id: formData.get('id'), itemId: formData.get('itemId') });
  if (!parsed.success) return { error: 'Invalid request.' };
  const paid = str(formData, 'paid') === 'true';

  if (findInstallment(parsed.data.itemId, parsed.data.id) === undefined) return { error: INSTALLMENT_GONE };

  if (paid) {
    const item = getWarrantyItem(parsed.data.itemId);
    if (!item) return { error: 'That item no longer exists.' };
    if (!installmentsAllowedForKind(item.kind)) return { error: INSTALLMENT_KIND_ERROR };
    // Two people marking the same row: the second UPDATE is a no-op and markInstallmentPaid
    // still reports true, because the desired state holds. That is success, not a race to
    // report.
    markInstallmentPaid(parsed.data.id, nowIso());
  } else {
    unmarkInstallmentPaid(parsed.data.id);
  }
  revalidateAll(parsed.data.itemId);
  return { message: paid ? 'Marked as paid.' : 'Marked as unpaid.' };
}
```

- [ ] **Step 4: Widen the matching gate.** In `saveLoanRuleAction` (line 531), replace

```ts
  if (item.kind !== 'loan') return { error: 'Payment matching only applies to loans.' };
```

with

```ts
  // v1.12.0: bills carry matching rules too -- a match marks their earliest unpaid installment
  // paid instead of moving a balance. MUST-19.11: the sentence lives in constants.ts now.
  if (!matchingAllowedForKind(item.kind)) return { error: MATCHING_KIND_ERROR };
```

Also, in the same action, guard the backfill so it stays loan-only (spec Component 5: "Backfill
stays loan-only"). Replace `if (parsed.data.backfill) {` with:

```ts
  // Loan-only, deliberately. Retroactively marking a year of installments paid from a year of
  // transactions is exactly the mistake the checkbox's own hint warns about, and a bill has
  // three or four installments a year that are one click each. The checkbox is not rendered for
  // a bill either; this is the server half of the same rule.
  if (parsed.data.backfill && item.kind === 'loan') {
```

- [ ] **Step 5: Run the action test.**

Run: `npx vitest run tests/app/warranty-installments.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the ops guard on this file still passes, unedited.**

Run: `npx vitest run tests/ops/use-server-exports.test.ts`
Expected: PASS — all three new exports are `export async function`, and neither
`INSTALLMENT_GONE` nor `installmentRefSchema` nor `findInstallment` is exported.

- [ ] **Step 7: Load the rows on the server.** In `src/app/(app)/warranties/[id]/page.tsx`, add
  `import { INSTALLMENT_DUE_SOON_DAYS, listInstallments } from '@/lib/warranty/installments';` and
  pass one more prop, after `rules`:

```tsx
      rules={listLoanRules(item.id)}
      /* v1.12.0: ALWAYS loaded, whatever the kind -- ruling B7. The card is rendered when the
         kind allows installments OR when the item already has some, and the client cannot make
         that second decision without the rows. INSTALLMENT_DUE_SOON_DAYS is the page's own
         window; the notification evaluator passes the user's comingDueDays instead. */
      installments={listInstallments(item.id, today, INSTALLMENT_DUE_SOON_DAYS)}
```

- [ ] **Step 8: Render the card.** In `warranty-detail-client.tsx`:

**8a — imports.** Add to the existing `@/lib/warranty/constants` import block:
`INSTALLMENT_SECTION_LABEL, installmentStateLabel, installmentsAllowedForKind,
matchingAllowedForKind, matchingBlurbForKind, type InstallmentState`. Add
`import type { InstallmentRow } from '@/lib/warranty/installments';` (a **type-only** import — the
module imports `@/db` and `tests/ops/client-bundle.test.ts` only flags value imports). Add
`import { RowMenu, RowMenuForm } from '@/components/ui/RowMenu';`,
`import { EmptyState } from '@/components/ui/EmptyState';`,
`import { CalendarIcon } from '@/components/icons';` (use whichever icon name that module already
exports for a calendar/date glyph — check `src/components/icons` and pick the closest existing one
rather than adding a new icon), and add
`addInstallmentAction, removeInstallmentAction, setInstallmentPaidAction` to the `'../actions'`
import list.

**8b — the prop.** Add to the destructure at `:82-95` and to the type at `:96-112`:

```tsx
  /** v1.12.0: a bill's due-date schedule. Always supplied; the card decides whether to render
   *  (ruling B7 -- a gate never hides a stored value). */
  installments: InstallmentRow[];
```

**8c — the state map and the two action hooks.** Beside the existing rule hooks (after
`deleteRuleState` at `:168`):

```tsx
  // v1.12.0: the Installments card's own inline results, reported inside the card exactly as
  // the Payment matching card's are -- they are not among the five actions activeSlot
  // disambiguates between.
  const [addInstallmentState, addInstallmentDispatch] = useActionState(addInstallmentAction, initial);
  const [installmentRowState, installmentRowDispatch] = useActionState(
    (_prev: WarrantyActionState, formData: FormData) =>
      formData.get('intent') === 'remove'
        ? removeInstallmentAction(_prev, formData)
        : setInstallmentPaidAction(_prev, formData),
    initial,
  );
```

and, at module scope beside `OCR_CHIP`:

```tsx
/** The `.badge` primitive is the shared thing, not StatusBadge's five hues: StatusBadge is about
 *  an ITEM's own lifecycle, and an installment is not an item. */
const INSTALLMENT_BADGE: Record<InstallmentState, string> = {
  paid: 'badge badge--green',
  overdue: 'badge badge--red',
  due_soon: 'badge badge--amber',
  scheduled: 'badge badge--muted',
};
```

**8d — the card**, inserted immediately ABOVE the Payment matching card (before line 383's
comment):

```tsx
      {/* Ruling B7: rendered when the kind ALLOWS installments, or when the item already HAS
          some -- a gate decides what a form offers, never what it may hide, and an item whose
          type was flipped away from Bill still holds rows a person typed. Add and Mark paid are
          disabled outside kind 'bill'; Remove never is. */}
      {!installmentsAllowedForKind(item.kind) && installments.length === 0 ? null : (
        <Card>
          <CardHeader
            title={
              <>
                {INSTALLMENT_SECTION_LABEL} ({installments.filter((row) => row.paidAt === null).length} unpaid,{' '}
                {formatCents(
                  installments.filter((row) => row.paidAt === null).reduce((sum, row) => sum + row.amountCents, 0),
                )}{' '}
                outstanding)
              </>
            }
          />
          <CardBody className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              Enter each due date the way it appears on the bill. The app reminds you before each one and flags any
              that go past.
            </p>
            {installments.length === 0 ? (
              <EmptyState
                icon={CalendarIcon}
                title="No installments yet"
                action={
                  <a href="#add-installment" className="btn btn--primary btn--sm">
                    Add the first due date
                  </a>
                }
              >
                A bill is a list of dates and amounts. Add the first one below and the reminders follow.
              </EmptyState>
            ) : (
              <>
                {/* Not `fixed`, so tests/ops/table-layout.test.ts's fixed-implies-minWidth pairing
                    does not apply -- same shape as the loan rules table directly below. */}
                <TableWrap bare>
                  <thead>
                    <tr>
                      <th scope="col">Due date</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((row) => (
                      <tr key={row.id}>
                        <td className={row.state === 'overdue' ? 'font-medium text-danger' : 'font-medium text-ink'}>
                          {row.dueDate}
                        </td>
                        <td className="money">{formatCents(row.amountCents)}</td>
                        <td>
                          <span className={INSTALLMENT_BADGE[row.state]}>{installmentStateLabel(row.state)}</span>
                          {row.paidTxn === null ? null : (
                            <span className="mt-1 block text-xs text-muted">
                              Paid by{' '}
                              <Link href={`/transactions?q=${encodeURIComponent(row.paidTxn.description)}`}>
                                {row.paidTxn.date} · {row.paidTxn.description}
                              </Link>
                              {Math.abs(row.paidTxn.amountCents) === row.amountCents ? null : (
                                /* Ruling C7: the amount is NOT compared when matching, because a
                                   tax bill arrives with penalties, discounts and rounding. The
                                   difference is a FACT the household reads and decides about --
                                   not an error, and not a warning colour. */
                                <span className="block">
                                  Transaction was {formatCents(Math.abs(row.paidTxn.amountCents))} (
                                  {formatCents(Math.abs(Math.abs(row.paidTxn.amountCents) - row.amountCents))}{' '}
                                  {Math.abs(row.paidTxn.amountCents) > row.amountCents ? 'more' : 'less'} than
                                  scheduled)
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="text-right">
                          {/* Ruling B9: two actions collapse into one kebab, and the accessible
                              name carries the amount AND the date -- a repeated single field is
                              the defect PENDING-FIXES item M records. */}
                          <RowMenu label={`Actions for the ${formatCents(row.amountCents)} installment due ${row.dueDate}`}>
                            {row.paidAt === null ? (
                              installmentsAllowedForKind(item.kind) ? (
                                <RowMenuForm
                                  action={installmentRowDispatch}
                                  fields={{ intent: 'paid', id: String(row.id), itemId: String(item.id), paid: 'true' }}
                                >
                                  Mark paid
                                </RowMenuForm>
                              ) : null
                            ) : (
                              <RowMenuForm
                                action={installmentRowDispatch}
                                fields={{ intent: 'paid', id: String(row.id), itemId: String(item.id), paid: 'false' }}
                              >
                                Unmark
                              </RowMenuForm>
                            )}
                            <RowMenuForm
                              action={installmentRowDispatch}
                              fields={{ intent: 'remove', id: String(row.id), itemId: String(item.id) }}
                            >
                              Remove
                            </RowMenuForm>
                          </RowMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                {/* Same F3-fix-round treatment as the loan rules table: the stale case ("removed
                    already, in another tab") has somewhere to surface. */}
                <FormError message={installmentRowState.error} />
              </>
            )}
            {installmentsAllowedForKind(item.kind) ? (
              <form action={addInstallmentDispatch} id="add-installment" className="flex flex-col gap-3">
                <input type="hidden" name="itemId" value={item.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Due date">
                    <input type="date" name="dueDate" className={inputClass} required />
                  </Field>
                  <Field label="Amount">
                    <input name="amount" inputMode="decimal" className={inputClass} placeholder="e.g. 1200.00" />
                  </Field>
                </div>
                <FormError message={addInstallmentState.error} />
                {addInstallmentState.message === undefined ? null : (
                  <Notice tone="success">{addInstallmentState.message}</Notice>
                )}
                {/* One form, one submit. No auto-save (ruling B8): correcting an installment is
                    remove and re-add, exactly as the loan rules card next to it works. */}
                <SubmitButton className="btn btn--primary self-start">Add installment</SubmitButton>
              </form>
            ) : null}
          </CardBody>
        </Card>
      )}
```

**8e — the Payment matching card**, three changes and no others:

```tsx
      {!matchingAllowedForKind(item.kind) ? null : (
```

```tsx
            <p className="text-sm text-muted">{matchingBlurbForKind(item.kind)}</p>
```

and the backfill `<label>` block wraps in `{item.kind === 'loan' ? ( ... ) : null}` — the checkbox
is loan-only (spec Component 5), matching the server guard added in Step 4.

- [ ] **Step 9: Confirm the CREATE form needed no edit (ruling C5), rather than assuming it.**
  `src/app/(app)/warranties/new/new-warranty-client.tsx` already computes its three fieldsets from
  `billingAllowedForKind` / `loanFieldsAllowedForKind` / `productFieldsAllowedForKind`, so
  choosing a bill type hides all three with no change — that is the payoff for ruling C4 being
  expressed as gates rather than as `if (kind === ...)` scattered through the form. Per ruling C5
  **no schedule fields are added to it**: the item is saved and the installments go on next.

Run: `npx vitest run tests/app/new-warranty-client.test.tsx`
Expected: PASS, unedited. Then open the file and read the three fieldset conditions to confirm
they are the gate calls and not inlined comparisons. If any of them is an inlined comparison
against a kind literal, change it to the gate call — that is a one-line fix and it belongs here,
not in a later release.

- [ ] **Step 10: Run the detail-client render test and the two ops guards this card could trip.**

Run: `npx vitest run tests/app/warranty-detail-client.test.tsx tests/ops/row-controls.test.ts tests/ops/table-layout.test.ts tests/ops/onboarding-coverage.test.ts`
Expected: PASS, all four **unedited**. Specifically: the new card pairs no `<select` with a
`SubmitButton` (row-controls), the new `TableWrap` is not `fixed` so it needs no `minWidth`
(table-layout), and the new `EmptyState` passes `action=` (onboarding-coverage guard 1).
`warranty-detail-client.test.tsx` renders the client directly, so it will need
`installments={[]}` added to its render helper — that is the only edit permitted to it.

- [ ] **Step 11: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add "src/app/(app)/warranties" tests/app/warranty-installments.test.ts tests/app/warranty-detail-client.test.tsx
git commit -m "feat(warranties): add the installments card and its three actions"
```

---

### Task 5: the Coming-up reader

**Files:**
- Modify: `src/lib/bills.ts:1-109` (`UpcomingBill`, `upcomingBills`) — `safeToSpend` at `:127-148`
  is **not** changed
- Modify: `src/components/ComingUpCard.tsx:1-93`
- Modify: `src/app/(app)/dashboard/page.tsx:87`
- Modify: `tests/lib/bills.test.ts` (append two describe blocks)
- Modify: `tests/components/ComingUpCard.test.tsx` (append one describe block)

**Interfaces:**
- Consumes from T3: `unpaidInstallments({ today, windowEnd, includeOverdue, ownerUserId? })`
  returning `{ installmentId, itemId, itemName, ownerUserId, dueDate, amountCents, overdue }[]`.
- Produces:

```ts
export interface UpcomingBill {
  itemId: number;
  name: string;
  kind: 'subscription' | 'contract' | 'bill';
  dueDate: string;
  amountCents: number;
  /** Present only for schedule-derived rows. Null for a cadence occurrence. */
  installmentId: number | null;
  /** Always false for a cadence occurrence: nextOccurrence() never returns a past date. */
  overdue: boolean;
}
export function upcomingBills(input: { today: string; days: number; includeOverdue?: boolean }): UpcomingBill[];
```

- [ ] **Step 1: Write the failing reader tests.** Append to `tests/lib/bills.test.ts`, and widen
  its local `type Kind` (line 9) to `'warranty' | 'subscription' | 'contract' | 'loan' | 'bill'`.
  Add `import { addInstallment, markInstallmentPaid } from '@/lib/warranty/installments';`.

```ts
describe('upcomingBills — schedule-derived rows', () => {
  function billWithSchedule(dues: { dueDate: string; amountCents: number; paid?: boolean }[]): {
    itemId: number;
    ids: number[];
  } {
    const userId = insertTestUser(current!.db, { username: 'user-1' });
    const typeId = insertItemType(current!.db, 'bill', 'Property tax');
    const itemId = insertItem(current!.db, { ownerUserId: userId, typeId, purchaseDate: '2024-01-15', name: 'Municipal tax' });
    const ids = dues.map((due) => {
      const id = addInstallment({ itemId, dueDate: due.dueDate, amountCents: due.amountCents });
      if (due.paid) markInstallmentPaid(id);
      return id;
    });
    return { itemId, ids };
  }

  it('includes an unpaid installment inside the window, with its id and overdue false', () => {
    current = createSeededTestDb();
    const { itemId, ids } = billWithSchedule([{ dueDate: '2026-09-15', amountCents: 120_000 }]);
    const result = upcomingBills({ today: '2026-09-01', days: 30 });
    expect(result).toEqual([
      {
        itemId,
        name: 'Municipal tax',
        kind: 'bill',
        dueDate: '2026-09-15',
        amountCents: 120_000,
        installmentId: ids[0],
        overdue: false,
      },
    ]);
  });

  it('never includes a paid one', () => {
    current = createSeededTestDb();
    billWithSchedule([{ dueDate: '2026-09-15', amountCents: 120_000, paid: true }]);
    expect(upcomingBills({ today: '2026-09-01', days: 30 })).toEqual([]);
  });

  it('includes an overdue one only when asked, and sorts it ahead of everything', () => {
    current = createSeededTestDb();
    billWithSchedule([
      { dueDate: '2024-05-01', amountCents: 70_000 },
      { dueDate: '2026-09-15', amountCents: 120_000 },
    ]);
    expect(upcomingBills({ today: '2026-09-01', days: 30 }).map((b) => b.dueDate)).toEqual(['2026-09-15']);
    const withOverdue = upcomingBills({ today: '2026-09-01', days: 30, includeOverdue: true });
    expect(withOverdue.map((b) => b.dueDate)).toEqual(['2024-05-01', '2026-09-15']);
    expect(withOverdue.map((b) => b.overdue)).toEqual([true, false]);
  });

  it('leaves the cadence half alone in the same call', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const subType = insertItemType(current.db, 'subscription', 'Streaming');
    insertItem(current.db, {
      name: 'Streaming plan',
      ownerUserId: userId,
      typeId: subType,
      purchaseDate: '2026-01-10',
      billingCycle: 'monthly',
      billingAmountCents: 1_599,
    });
    const { ids } = billWithSchedule([{ dueDate: '2026-09-15', amountCents: 120_000 }]);
    const result = upcomingBills({ today: '2026-09-01', days: 30 });
    expect(result.map((b) => [b.kind, b.dueDate, b.installmentId])).toEqual([
      ['subscription', '2026-09-10', null],
      ['bill', '2026-09-15', ids[0]],
    ]);
  });
});

describe('safeToSpend does not move for an ancient unpaid installment', () => {
  it('keeps includeOverdue at its default false — the regression this default guards', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertItemType(current.db, 'bill', 'Property tax');
    const itemId = insertItem(current.db, { ownerUserId: userId, typeId, purchaseDate: '2024-01-15' });
    const before = safeToSpend({ month: '2026-09', today: '2026-09-01' }).billsDueCents;
    // Two years old and never marked paid. billsDueCents answers "is what is left in my budget
    // enough for what the REST OF THIS MONTH still owes"; folding this in would distort that
    // number permanently, and would do so most for the household worst at housekeeping.
    addInstallment({ itemId, dueDate: '2024-05-01', amountCents: 500_000 });
    expect(safeToSpend({ month: '2026-09', today: '2026-09-01' }).billsDueCents).toBe(before);
  });

  it('but an installment falling INSIDE the month does move it', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { username: 'user-1' });
    const typeId = insertItemType(current.db, 'bill', 'Property tax');
    const itemId = insertItem(current.db, { ownerUserId: userId, typeId, purchaseDate: '2024-01-15' });
    const before = safeToSpend({ month: '2026-09', today: '2026-09-01' }).billsDueCents;
    addInstallment({ itemId, dueDate: '2026-09-15', amountCents: 120_000 });
    expect(safeToSpend({ month: '2026-09', today: '2026-09-01' }).billsDueCents).toBe(before + 120_000);
  });
});
```

- [ ] **Step 2: Run and watch it fail.**

Run: `npx vitest run tests/lib/bills.test.ts`
Expected: FAIL — `upcomingBills` returns no `installmentId`/`overdue` and knows nothing about
schedules.

- [ ] **Step 3: Widen `src/lib/bills.ts`.** Add `unpaidInstallments` to the imports; extend the
  interface and the function. The cadence half — `RECURRING_KINDS`, `nextOccurrence`, the
  `gt(billingAmountCents, 0)` filter and the expiry filter — is untouched.

```ts
export interface UpcomingBill {
  itemId: number;
  name: string;
  kind: 'subscription' | 'contract' | 'bill';
  dueDate: string;
  amountCents: number;
  /** v1.12.0: present only for SCHEDULE-derived rows. Null for a cadence occurrence, which has
   *  no row of its own to point at. Callers key their list on it, because one bill item can
   *  contribute several rows and the item id no longer identifies a row. */
  installmentId: number | null;
  /** v1.12.0: always false for a cadence occurrence -- nextOccurrence() only ever returns a date
   *  strictly after `today`, so a cadence row cannot be in the past by construction. */
  overdue: boolean;
}
```

```ts
/**
 * Bills due within `days` of `today` (inclusive of the boundary day itself), sorted by dueDate
 * ascending. Two sources, one array:
 *
 *   1. the CADENCE half (unchanged since v1.7.0): subscription/contract items with a billing
 *      pair, walked forward from their anchor by nextOccurrence().
 *   2. v1.12.0, the SCHEDULE half: unpaid bill_installments rows on bill-kind items.
 *
 * `includeOverdue` defaults to FALSE, and safeToSpend() keeps that default deliberately. Its
 * billsDueCents answers "is what is left in my budget enough for what the rest of THIS MONTH
 * still owes"; folding in an installment from two years ago that nobody ever marked paid would
 * quietly and permanently distort that number, and it would do so most for the household that is
 * worst at housekeeping. The dashboard card, whose whole job is to surface the thing you forgot,
 * passes true.
 *
 * Overdue rows need no second sort key: their dates are earlier, so the existing ascending sort
 * already puts them first.
 */
export function upcomingBills(input: { today: string; days: number; includeOverdue?: boolean }): UpcomingBill[] {
  const { today, days } = input;
  const includeOverdue = input.includeOverdue ?? false;
  const windowEnd = addDaysIso(today, days);

  // KEEP src/lib/bills.ts:64-90 EXACTLY AS IT IS -- the `const rows = getDb().select({...})`
  // query with its innerJoin onto warrantyItemTypes and its four where-clauses (RECURRING_KINDS,
  // isNotNull(billingCycle), gt(billingAmountCents, 0), the expiry filter). Not one character of
  // the cadence half changes in this task.

  const result: UpcomingBill[] = [];
  for (const row of rows) {
    // KEEP src/lib/bills.ts:94-98 as it is: the two-line narrowing comment, `const stepMonths`,
    // `const dueDate = nextOccurrence(...)` and `if (dueDate > windowEnd) continue;`.
    result.push({
      itemId: row.itemId,
      name: row.name,
      kind: row.kind as 'subscription' | 'contract',
      dueDate,
      amountCents: row.billingAmountCents as number,
      installmentId: null,
      overdue: false,
    });
  }

  for (const row of unpaidInstallments({ today, windowEnd, includeOverdue })) {
    result.push({
      itemId: row.itemId,
      name: row.itemName,
      kind: 'bill',
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      installmentId: row.installmentId,
      overdue: row.overdue,
    });
  }

  result.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return result;
}
```

`safeToSpend` at `:145` is left exactly as it is — it calls `upcomingBills({ today, days })` with
no `includeOverdue`, which is now explicitly the default and is what the test in Step 1 pins.

- [ ] **Step 4: Run the bills tests.**

Run: `npx vitest run tests/lib/bills.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing card test.** Append to `tests/components/ComingUpCard.test.tsx`:

```ts
describe('ComingUpCard with overdue rows', () => {
  const base = { budgetedRemainingCents: 50_000, billsDueCents: 12_000, hasBudgetedLimits: true, monthEndDate: '2026-09-30' };

  function bill(over: Partial<UpcomingBill> & { dueDate: string; amountCents: number }): UpcomingBill {
    return {
      itemId: 1,
      name: 'Municipal tax',
      kind: 'bill',
      installmentId: null,
      overdue: false,
      ...over,
    } as UpcomingBill;
  }

  it('appends the overdue clause to the header only when an overdue row is present', () => {
    const { container: without } = render(
      <ComingUpCard {...base} bills={[bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 })]} />,
    );
    expect(without.textContent).toContain('Bills due in the next 30 days.');
    expect(without.textContent).not.toContain('anything overdue');
    cleanup();

    const { container: with_ } = render(
      <ComingUpCard
        {...base}
        bills={[bill({ dueDate: '2024-05-01', amountCents: 70_000, installmentId: 4, overdue: true })]}
      />,
    );
    expect(with_.textContent).toContain('and anything overdue');
    expect(with_.textContent).toContain('Overdue');
  });

  it('keeps the header total summing EVERY listed row, overdue included', () => {
    const { container } = render(
      <ComingUpCard
        {...base}
        bills={[
          bill({ dueDate: '2024-05-01', amountCents: 70_000, installmentId: 4, overdue: true }),
          bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 }),
        ]}
      />,
    );
    // An overdue bill is money still owed and belongs in the total; the aria-label stays honest.
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe('Total due $1,900.00');
  });

  it('gives every row a distinct key even when one item contributes several', () => {
    // Two installments on ONE item: keying on itemId alone would collide, and React would drop
    // a row. This is the defect the composite key exists to prevent.
    const { container } = render(
      <ComingUpCard
        {...base}
        bills={[
          bill({ dueDate: '2026-09-15', amountCents: 120_000, installmentId: 5 }),
          bill({ dueDate: '2026-11-15', amountCents: 120_000, installmentId: 6 }),
        ]}
      />,
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});
```

Add `import type { UpcomingBill } from '@/lib/bills';` and `cleanup` to that file's imports if
they are not already there.

- [ ] **Step 6: Run and watch it fail.**

Run: `npx vitest run tests/components/ComingUpCard.test.tsx`
Expected: FAIL.

- [ ] **Step 7: Update `src/components/ComingUpCard.tsx`.** Four edits:

```tsx
  const listTotalCents = bills.reduce((sum, bill) => sum + bill.amountCents, 0);
  const hasOverdue = bills.some((bill) => bill.overdue);
```

```tsx
        description={
          hasOverdue ? 'Bills due in the next 30 days, and anything overdue.' : 'Bills due in the next 30 days.'
        }
```

```tsx
            <li
              // v1.12.0: ONE item can contribute several rows now (a bill's installments), so
              // itemId alone is no longer a key. installmentId identifies a schedule row; a
              // cadence row has at most one occurrence per item in this window, so its item id
              // still does.
              key={bill.installmentId === null ? `item-${bill.itemId}` : `installment-${bill.installmentId}`}
```

```tsx
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink">{bill.name}</span>
                <span className={bill.overdue ? 'text-xs text-danger' : 'text-xs text-subtle'}>{bill.dueDate}</span>
                {bill.overdue ? <span className="badge badge--red">Overdue</span> : null}
              </span>
```

The footer sentence is unchanged, and so is `billsDueCents`: that figure comes from
`safeToSpend()`, which keeps `includeOverdue` at its default (Step 3).

- [ ] **Step 8: Pass `includeOverdue` from the dashboard.** `src/app/(app)/dashboard/page.tsx:87`:

```tsx
  // v1.12.0: the CARD wants overdue rows -- surfacing the thing you forgot is its whole job.
  // safeToSpend below deliberately does not; see upcomingBills' docblock.
  const bills = upcomingBills({ today, days: 30, includeOverdue: true });
```

- [ ] **Step 9: Run both test files.**

Run: `npx vitest run tests/lib/bills.test.ts tests/components/ComingUpCard.test.tsx`
Expected: PASS.

- [ ] **Step 10: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/bills.ts src/components/ComingUpCard.tsx "src/app/(app)/dashboard/page.tsx" tests/lib/bills.test.ts tests/components/ComingUpCard.test.tsx
git commit -m "feat(dashboard): show bill installments in Coming up, with overdue surfaced"
```

---
### Task 6: the coming-due notification learns about installments

**Files:**
- Modify: `src/lib/notify/render.ts:47-56` (the `coming_due` member of `RenderInput`) and
  `:309-318` (its `case` arm)
- Modify: `src/lib/notify/events.ts:47-55` (the blurb) and `:216-218` (beside `comingDueKey`)
- Modify: `src/lib/notify/evaluate/coming-due.ts:1-90`
- Modify: `tests/lib/notify/render.test.ts:22, 37, 52, 358, 399` (add `variant: 'item'`) and
  append one describe block
- Modify: `tests/lib/notify/evaluate/coming-due.test.ts` (append one describe block)

**Interfaces:**
- Consumes from T3: `unpaidInstallments({ today, windowEnd, includeOverdue, ownerUserId })`.
- Produces:

```ts
// src/lib/notify/render.ts — a REQUIRED discriminator (ruling B15)
| { event: 'coming_due'; variant: 'item'; itemName: string; kind: ItemKind; expiryDate: string;
    todayIso: string; vendor: string | null; priceCents: number | null }
| { event: 'coming_due'; variant: 'installment'; itemName: string; dueDate: string;
    amountCents: number; todayIso: string; overdue: boolean }

// src/lib/notify/events.ts
export function installmentDueKey(installmentId: number, dueDate: string): string;      // bill:<id>:<date>
export function installmentOverdueKey(installmentId: number, month: string): string;    // overdue:<id>:<YYYY-MM>
```

**The event id `coming_due` does NOT change** — MUST-4.5 makes it permanent, and renaming it would
reset every stored preference. No new event, no new toggle, no new prefs default (ruling B15, C6).

- [ ] **Step 1: Write the failing render tests.** Append to `tests/lib/notify/render.test.ts`:

```ts
describe('coming_due, the installment variant (ruling B15)', () => {
  it('renders an upcoming installment', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'Municipal tax',
      dueDate: '2026-09-30',
      amountCents: 120_000,
      todayIso: '2026-09-23',
      overdue: false,
    });
    expect(subject).toBe('Coming due: Municipal tax');
    expect(body).toBe('Bill "Municipal tax": $1,200.00 due 2026-09-30 (in 7 days).');
  });

  it('renders an overdue installment differently, and says how long', () => {
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'Municipal tax',
      dueDate: '2026-09-30',
      amountCents: 120_000,
      todayIso: '2026-10-05',
      overdue: true,
    });
    expect(subject).toBe('Overdue: Municipal tax');
    expect(body).toBe('Bill "Municipal tax": $1,200.00 was due 2026-09-30 and is still unpaid (5 days ago).');
  });

  it('takes the noun "Bill" from ITEM_KIND_LABELS, not from a literal', () => {
    // MUST-19.11 applied to notifications: if the label ever changes, this body changes with it.
    const { body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: 'X',
      dueDate: '2026-09-30',
      amountCents: 100,
      todayIso: '2026-09-23',
      overdue: false,
    });
    expect(body.startsWith(`${ITEM_KIND_LABELS.bill} "X"`)).toBe(true);
  });
});
```

Add `ITEM_KIND_LABELS` to that file's imports from `@/lib/warranty/constants`.

- [ ] **Step 2: Add `variant: 'item'` to the five existing `coming_due` inputs in that same test
  file** (lines 22, 37, 52, 358, 399). This is the compiler-checked edit ruling B15 chose a
  **required** discriminator to force; a silent default would have let a call site keep the old
  shape and mean something new.

- [ ] **Step 3: Run and watch it fail.**

Run: `npx vitest run tests/lib/notify/render.test.ts`
Expected: FAIL — `variant` is not a known property, and the installment arm does not exist.

- [ ] **Step 4: Split the `RenderInput` member** in `src/lib/notify/render.ts` (replace lines
  48–56):

```ts
  | {
      event: 'coming_due';
      /**
       * Ruling B15: REQUIRED, not optional. Making it required forces every existing call site
       * to write `variant: 'item'`, which is a compiler-checked edit rather than a silent
       * default that would let an old-shaped call quietly mean something new. There is no new
       * event id: "something is coming due" is one idea and stays one switch in the matrix
       * (MUST-4.5 makes the id permanent anyway).
       */
      variant: 'item';
      itemName: string;
      kind: ItemKind;
      expiryDate: string;
      todayIso: string;
      vendor: string | null;
      priceCents: number | null;
    }
  | {
      event: 'coming_due';
      variant: 'installment';
      itemName: string;
      dueDate: string;
      amountCents: number;
      todayIso: string;
      overdue: boolean;
    }
```

- [ ] **Step 5: Split the `case` arm** (replace lines 309–318):

```ts
    case 'coming_due': {
      const name = truncateText(input.itemName, NAME_MAX);
      if (input.variant === 'installment') {
        // The noun comes from ITEM_KIND_LABELS, not from a literal (MUST-19.11): a bill
        // installment is a BILL's installment, and one place names that kind.
        const noun = ITEM_KIND_LABELS.bill;
        const amount = money(input.amountCents);
        if (input.overdue) {
          return {
            subject: `Overdue: ${name}`,
            body:
              `${noun} "${name}": ${amount} was due ${input.dueDate} and is still unpaid ` +
              `(${inDays(input.dueDate, input.todayIso)} ago).`,
          };
        }
        return {
          subject: `Coming due: ${name}`,
          body: `${noun} "${name}": ${amount} due ${input.dueDate} (${inDays(input.todayIso, input.dueDate)}).`,
        };
      }
      // MUST-6.14: the verb comes from expiryPhraseForKind() so notifications never become
      // a second place any of the four verbs is written (MUST-19.11 of the warranty spec).
      const phrase = expiryPhraseForKind(input.kind, input.expiryDate);
      const lines = [`${ITEM_KIND_LABELS[input.kind]} "${name}" ${phrase} (${inDays(input.todayIso, input.expiryDate)}).`];
      if (input.vendor) lines.push(`Vendor: ${truncateText(input.vendor, NAME_MAX)}`);
      if (input.priceCents !== null) lines.push(`Price: ${money(input.priceCents)}`);
      return { subject: `Coming due: ${name}`, body: lines.join('\n') };
    }
```

Check `inDays`'s existing output shape in this file before finalising the two bodies: the tests in
Step 1 assume it renders `in 7 days` and `5 days`. If it renders something else, keep the helper
and adjust the expected strings in Step 1 to match — do NOT write a second day-count formatter.

- [ ] **Step 6: Run the render tests.**

Run: `npx vitest run tests/lib/notify/render.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the two dedup keys** in `src/lib/notify/events.ts`, immediately after
  `comingDueKey` (line 218):

```ts
/**
 * v1.12.0. Once per installment per due date, EVER -- editing the date is a new fact and gets a
 * new key, exactly as comingDueKey treats an edited expiry date.
 *
 * The `bill:` prefix is LOAD-BEARING. comingDueKey is `due:<itemId>:<date>`, and an item's own
 * end date can legitimately equal one of its installment due dates; under a shared prefix one
 * message would silently suppress the other.
 */
export function installmentDueKey(installmentId: number, dueDate: string): string {
  return `bill:${installmentId}:${dueDate}`;
}

/**
 * v1.12.0, ruling B16. MUST-3.12 requires every dedup key to be bounded to a calendar period
 * evaluation only visits within the current few days, or derived from a never-recurring
 * timestamp. An overdue installment stays overdue for ever, so a date-free key
 * (`overdue:<id>`) would be announced once and then RE-announced whenever the 400-day retention
 * sweep pruned it -- the exact resurrection MUST-3.12 forbids. Keying it by calendar month makes
 * it an honest monthly nag with a bounded key.
 *
 * `month` is YYYY-MM.
 */
export function installmentOverdueKey(installmentId: number, month: string): string {
  return `overdue:${installmentId}:${month}`;
}
```

- [ ] **Step 8: Reword the blurb** (line 51). The id is untouched:

```ts
    blurb: 'A warranty, subscription, contract or loan reaches its date soon, or a bill installment is due.',
```

- [ ] **Step 9: Write the failing evaluator tests.** Append to
  `tests/lib/notify/evaluate/coming-due.test.ts`. That file already has `emailUser()`,
  `bothChannelsUser()`, `typeId(kind)` and `item(...)` helpers; widen `typeId`'s parameter type to
  include `'bill'` and add
  `import { addInstallment } from '@/lib/warranty/installments';` plus
  `import { installmentDueKey, installmentOverdueKey } from '@/lib/notify/events';`.

```ts
describe('installments in the coming-due evaluation', () => {
  function billWith(userId: number, dues: string[], amountCents = 120_000): { itemId: number; ids: number[] } {
    const itemId = item({ ownerUserId: userId, name: 'Municipal tax', typeId: typeId('bill'), expiryDate: null });
    return { itemId, ids: dues.map((dueDate) => addInstallment({ itemId, dueDate, amountCents })) };
  }

  function keysFor(userId: number): string[] {
    return (
      t.sqlite
        .prepare('select dedup_key from notification_outbox where user_id = ? order by dedup_key')
        .all(userId) as { dedup_key: string }[]
    ).map((r) => r.dedup_key);
  }

  it('enqueues one row per channel for an installment inside the window, under installmentDueKey', () => {
    const userId = bothChannelsUser();
    const { ids } = billWith(userId, ['2026-08-20']);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(2);
    expect(new Set(keysFor(userId))).toEqual(new Set([installmentDueKey(ids[0]!, '2026-08-20')]));
  });

  it('says nothing the next day about the same installment', () => {
    const userId = emailUser();
    billWith(userId, ['2026-08-20']);
    evaluateComingDue({ userId, now: NOW, tz: TZ });
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
  });

  it('nags monthly about an overdue one, not daily (ruling B16)', () => {
    const userId = emailUser();
    const { ids } = billWith(userId, ['2026-05-01']);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(userId)).toEqual([installmentOverdueKey(ids[0]!, '2026-08')]);
    // Tomorrow: nothing.
    expect(evaluateComingDue({ userId, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(0);
    // Next calendar month: one more, under its own bounded key.
    expect(evaluateComingDue({ userId, now: new Date('2026-09-02T12:00:00Z'), tz: TZ })).toBe(1);
    expect(keysFor(userId).sort()).toEqual(
      [installmentOverdueKey(ids[0]!, '2026-08'), installmentOverdueKey(ids[0]!, '2026-09')].sort(),
    );
  });

  it('an item expiry that falls on one of its own installment dates produces TWO rows, not one', () => {
    // The distinct key prefixes are what make this true; a shared prefix would let one message
    // silently suppress the other.
    const userId = emailUser();
    const itemId = item({ ownerUserId: userId, name: 'Municipal tax', typeId: typeId('bill'), expiryDate: '2026-08-20' });
    const installmentId = addInstallment({ itemId, dueDate: '2026-08-20', amountCents: 120_000 });
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(2);
    expect(keysFor(userId).sort()).toEqual([`bill:${installmentId}:2026-08-20`, `due:${itemId}:2026-08-20`].sort());
  });

  it('never announces a paid installment or another household member’s', () => {
    const mine = emailUser();
    const theirs = emailUser();
    const { ids } = billWith(mine, ['2026-08-20', '2026-08-21']);
    billWith(theirs, ['2026-08-20']);
    t.sqlite.prepare('update bill_installments set paid_at = ? where id = ?').run('2026-08-01T00:00:00.000Z', ids[0]);
    expect(evaluateComingDue({ userId: mine, now: NOW, tz: TZ })).toBe(1);
    expect(keysFor(mine)).toEqual([installmentDueKey(ids[1]!, '2026-08-21')]);
  });

  it('spends the shared flood cap on overdue rows first, then upcoming, then item expiries', () => {
    // The cap counts ROWS across all three sources. When it bites, the household should lose the
    // least urgent message, not the most -- which is the only reason the order matters.
    const userId = emailUser();
    const dues: string[] = [];
    for (let i = 0; i < MAX_NEW_ROWS_PER_USER_PER_EVALUATION + 5; i += 1) {
      dues.push(`2026-08-${String(18 + (i % 10)).padStart(2, '0')}`);
    }
    const { ids } = billWith(userId, ['2026-05-01', ...dues]);
    expect(evaluateComingDue({ userId, now: NOW, tz: TZ })).toBe(MAX_NEW_ROWS_PER_USER_PER_EVALUATION);
    expect(keysFor(userId)).toContain(installmentOverdueKey(ids[0]!, '2026-08'));
  });
});
```

- [ ] **Step 10: Run and watch it fail.**

Run: `npx vitest run tests/lib/notify/evaluate/coming-due.test.ts`
Expected: FAIL — the evaluator has one source.

- [ ] **Step 11: Rewrite `evaluateComingDue`.** Replace `src/lib/notify/evaluate/coming-due.ts`'s
  body (keeping `MAX_NEW_ROWS_PER_USER_PER_EVALUATION` and its docblock exactly as they are):

```ts
import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { warrantyItemTypes, warrantyItems } from '@/db/schema';
import { addDaysIso, todayIso } from '@/lib/dates';
import { getUserSettings } from '@/lib/notify/config';
import { comingDueKey, installmentDueKey, installmentOverdueKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent } from '@/lib/notify/render';
import { unpaidInstallments } from '@/lib/warranty/installments';
import { isItemKind, type ItemKind } from '@/lib/warranty/constants';
```

```ts
/**
 * ... keep the existing MUST-6.10 / MUST-6.11 / MUST-6.12 docblock, and add:
 *
 * v1.12.0 (ruling C6): a SECOND source, read before the item-expiry loop -- unpaid installments
 * on this user's bill-kind items. No new event id and no new channel (ruling B15); the same
 * coming_due payload carries a variant.
 *
 * ORDER MATTERS ONLY BECAUSE OF THE CAP. MAX_NEW_ROWS_PER_USER_PER_EVALUATION is shared across
 * all three sources and still counts ROWS, not items. Overdue installments are enqueued first,
 * then upcoming installments, then item expiries: when the cap bites, the household should lose
 * the least urgent message, not the most.
 *
 * MUST-6.11's ownership rule needs no new column -- an installment's owner is its item's
 * owner_user_id, which unpaidInstallments() filters on.
 */
export function evaluateComingDue(input: { userId: number; now: Date; tz: string }): number {
  const settings = getUserSettings(input.userId);
  const today = todayIso(input.now, input.tz);
  const horizon = addDaysIso(today, settings.comingDueDays);
  const month = today.slice(0, 7);

  let enqueuedRows = 0;

  // dueSoonDays is the caller's, deliberately: the evaluator's window is the user's own
  // comingDueDays, and the detail page uses its own. Neither invents a third.
  const installments = unpaidInstallments({
    today,
    windowEnd: horizon,
    includeOverdue: true,
    ownerUserId: input.userId,
  });
  // Overdue first (see the docblock). unpaidInstallments returns due_date ASC, so a stable
  // partition preserves date order inside each group.
  const ordered = [...installments.filter((row) => row.overdue), ...installments.filter((row) => !row.overdue)];

  for (const row of ordered) {
    if (enqueuedRows >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION) break;
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'installment',
      itemName: row.itemName,
      dueDate: row.dueDate,
      amountCents: row.amountCents,
      todayIso: today,
      overdue: row.overdue,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'coming_due',
      dedupKey: row.overdue
        ? installmentOverdueKey(row.installmentId, month)
        : installmentDueKey(row.installmentId, row.dueDate),
      subject,
      body,
      at: input.now,
    });
    enqueuedRows += result.inserted.length;
  }

  // KEEP src/lib/notify/evaluate/coming-due.ts:36-57 EXACTLY AS IT IS -- the
  // `const rows = getDb().select({ id, name, vendor, priceCents, expiryDate, kind })` query with
  // its leftJoin onto warrantyItemTypes, its five where-clauses (ownerUserId, isLifetime false,
  // isNotNull(expiryDate), gte(expiryDate, today), lte(expiryDate, horizon)) and its
  // `.orderBy(asc(expiryDate), asc(id)).all()`. The item-expiry source is unchanged.
  const rows = getDb() /* ...as above... */ .all();

  for (const row of rows) {
    if (enqueuedRows >= MAX_NEW_ROWS_PER_USER_PER_EVALUATION) break;
    const expiryDate = row.expiryDate;
    if (expiryDate === null) continue;
    const kind: ItemKind = row.kind !== null && isItemKind(row.kind) ? row.kind : 'warranty';
    const { subject, body } = renderEvent({
      event: 'coming_due',
      variant: 'item',
      itemName: row.name,
      kind,
      expiryDate,
      todayIso: today,
      vendor: row.vendor,
      priceCents: row.priceCents,
    });
    const result = enqueue({
      userId: input.userId,
      eventId: 'coming_due',
      dedupKey: comingDueKey(row.id, expiryDate),
      subject,
      body,
      at: input.now,
    });
    enqueuedRows += result.inserted.length;
  }
  return enqueuedRows;
}
```

- [ ] **Step 12: Run the evaluator tests.**

Run: `npx vitest run tests/lib/notify/evaluate/coming-due.test.ts`
Expected: PASS.

- [ ] **Step 13: Run the rest of the notify suite, unedited.**

Run: `npx vitest run tests/lib/notify/ tests/app/notifications-actions.test.ts tests/app/notifications-client.test.tsx`
Expected: PASS. `tests/lib/notify/events.test.ts` asserts the event definition table; the reworded
blurb must not break it — if it asserts the blurb text verbatim, update that one string and
nothing else.

- [ ] **Step 14: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean. Any remaining error is a `coming_due` call site missing `variant`, which is
exactly what the required discriminator is for.

- [ ] **Step 15: Commit**

```bash
git add src/lib/notify tests/lib/notify
git commit -m "feat(notify): remind about bill installments through the coming-due event"
```

---

### Task 7: `applyPaymentMatchers` — one pass, one link per transaction, across both kinds

**Files:**
- Modify: `src/lib/loans.ts:186-212` (`activeRules`), `:309-317` (`alreadyLinked`), `:319-386`
  (`applyLoanMatchers` → `applyPaymentMatchers`), and a new
  `reverseInstallmentLinksForTransactions` beside `reverseLoanLinksForTransactions` at `:565-597`
- Modify: `src/lib/import/commit.ts:5` (the import) and `:417` (the call)
- Modify: `src/lib/categorize/engine.ts:5, 296, 299, 305, 333`
- Modify: `src/lib/import/flow.ts:3, 28, 122, 124, 127`
- Modify: `src/lib/simplefin/sync.ts:7, 78, 243`
- Modify: `src/lib/transactions.ts:10, 235`
- Modify: `src/app/(app)/import/import-client.tsx:297` (a comment) and
  `src/app/(app)/settings/connections/connections-client.tsx:127` (a comment)
- Modify: `tests/integration/loan-flow.test.ts`, `tests/lib/loans/matcher.test.ts`,
  `tests/lib/loans/reversal.test.ts`, `tests/lib/loans/summary.test.ts` (the rename only)
- Create: `tests/lib/loans/payment-matchers.test.ts`

**Interfaces:**
- Consumes from T3: the `billInstallments` table from `@/db/schema`.
- Produces:

```ts
/** RENAMED from applyLoanMatchers. Same signature, same never-throws contract (MUST-13.5). */
export function applyPaymentMatchers(txnIds: number[], at?: Date, report?: { failed: boolean }): number;
/** Ruling B14. Called from undoImport's transaction, BEFORE tx.delete(transactions). */
export function reverseInstallmentLinksForTransactions(txnIds: number[]): number;
```

**There is no alias and no wrapper** (ruling B10). This repo deletes superseded helpers rather than
keeping them — `KIND_WORDING` superseding the four boolean label helpers is the precedent. The
`loan_matcher_rules` TABLE, `LoanRule`, `listLoanRules` and `saveLoanRuleAction` all keep their
names: their shape did not change, and renaming a shipped table for cosmetics is a migration
nobody needs.

- [ ] **Step 1: Do the rename first, mechanically, and prove nothing else moved.** Rename the
  export and all thirteen source references plus the four test files. The two client-side
  references are comments naming the function and must be updated too, or the comments become
  wrong.

Run: `git grep -n "applyLoanMatchers"`
Expected after the rename: no output.

Run: `npx vitest run tests/lib/loans/ tests/integration/loan-flow.test.ts`
Expected: PASS — a pure rename must be green before any behaviour changes underneath it.

- [ ] **Step 2: Commit the rename on its own**, so a bisect can separate "renamed" from
  "changed".

```bash
git add -A
git commit -m "refactor(loans): rename applyLoanMatchers to applyPaymentMatchers"
```

- [ ] **Step 3: Write the failing bill-matching test.** Create
  `tests/lib/loans/payment-matchers.test.ts`. Reuse `tests/lib/loans/matcher.test.ts`'s fixture
  shape (`createSeededTestDb`, `insertTestUser`, `insertTestAccount`, a raw `warranty_item_types`
  insert, a raw `warranty_items` insert, and a `spend()` helper) rather than importing from it —
  test files in this repo are self-contained.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyPaymentMatchers, reverseInstallmentLinksForTransactions, saveLoanRule } from '@/lib/loans';
import { addInstallment, listInstallments, markInstallmentPaid } from '@/lib/warranty/installments';

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let t: TestDb;
let accountId = 0;
let userId = 0;

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'user-1' });
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
});
afterEach(() => t.cleanup());

function typeOfKind(kind: string, name: string): number {
  return (
    t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, ?, ?) returning id`)
      .get(name, kind, NOW) as { id: number }
  ).id;
}

function makeItem(typeId: number, name: string, balanceCents: number | null = null): number {
  return (
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(name, userId, typeId, balanceCents, balanceCents, balanceCents === null ? null : NOW, NOW, NOW) as {
      id: number;
    }
  ).id;
}

function spend(merchant: string, amountCents: number, over: { accountId?: number; date?: string } = {}): number {
  return (
    t.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, 0, ?, ?, ?) returning id`,
      )
      .get(over.accountId ?? accountId, over.date ?? '2026-08-01', merchant, merchant.toUpperCase(), amountCents, userId, NOW, NOW) as {
      id: number;
    }
  ).id;
}

function seedBill(name = 'Municipal tax'): number {
  return makeItem(typeOfKind('bill', `Property tax ${name}`), name);
}

describe('a rule on a bill marks the EARLIEST unpaid installment', () => {
  it('picks by date, not by amount and not by insertion order', () => {
    const itemId = seedBill();
    // Deliberately: the earliest row is the LARGEST, and it is inserted LAST. Neither
    // "nearest by amount" nor "first by id" gives the right answer here.
    const later = addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 50_000 });
    const earliest = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 300_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });

    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);

    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows.find((r) => r.id === earliest)!.paidTxnId).toBe(txnId);
    expect(rows.find((r) => r.id === later)!.paidAt).toBeNull();
  });

  it('records the transaction even when the amount does not match (ruling C7)', () => {
    const itemId = seedBill();
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    // A tax bill arrives with penalties, discounts and rounding. Refusing to match on a few
    // dollars would leave the household with an installment that IS paid and a reminder saying
    // it is not; the difference is shown on the detail page instead.
    const txnId = spend('city tax office', -127_450);
    expect(applyPaymentMatchers([txnId])).toBe(1);
    const row = listInstallments(itemId, TODAY, 30).find((r) => r.id === id)!;
    expect(row.paidTxnId).toBe(txnId);
    expect(row.paidTxn!.amountCents).toBe(-127_450);
  });

  it('is idempotent: a second run over the same transaction marks nothing more', () => {
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);
    expect(applyPaymentMatchers([txnId])).toBe(0);
    expect(listInstallments(itemId, TODAY, 30).filter((r) => r.paidAt !== null)).toHaveLength(1);
  });

  it('creates no link and throws nothing when every installment is already paid', () => {
    const itemId = seedBill();
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    markInstallmentPaid(id, NOW);
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    expect(() => applyPaymentMatchers([txnId])).not.toThrow();
    expect(applyPaymentMatchers([txnId])).toBe(0);
  });

  it('creates no link and throws nothing when the bill has no schedule at all', () => {
    const itemId = seedBill();
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    expect(applyPaymentMatchers([spend('city tax office', -120_000)])).toBe(0);
  });

  it('never moves current_balance_cents on the bill path', () => {
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    applyPaymentMatchers([spend('city tax office', -120_000)]);
    const row = t.sqlite
      .prepare('select current_balance_cents as b, balance_updated_at as u from warranty_items where id = ?')
      .get(itemId) as { b: number | null; u: string | null };
    // A bill has no balance, and MUST-11.8's human anchor stays a loan concept.
    expect(row.b).toBeNull();
    expect(row.u).toBeNull();
  });

  it('matches a bill rule even though the bill has no balance', () => {
    // The regression the loan-conditional balance clause guards: activeRules' dormancy bail used
    // to require a non-null current_balance_cents, which would make every bill rule inert.
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    expect(applyPaymentMatchers([spend('city tax office', -120_000)])).toBe(1);
  });
});

describe('one link per transaction, across both kinds (ruling B11 / MUST-13.4)', () => {
  it('a transaction matching a loan rule AND a bill rule links exactly once', () => {
    const loanId = makeItem(typeOfKind('loan', 'Car loan'), 'Civic', 2_000_000);
    const billId = seedBill();
    addInstallment({ itemId: billId, dueDate: '2026-09-30', amountCents: 120_000 });
    // Same merchant string on both. First rule by id wins; the point is that the SECOND does
    // not also take it, which is only expressible because both branches share alreadyLinked().
    saveLoanRule({ itemId: loanId, merchantContains: 'CITY', accountId: null, enabled: true });
    saveLoanRule({ itemId: billId, merchantContains: 'CITY', accountId: null, enabled: true });

    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);

    const loanLinks = t.sqlite.prepare('select count(*) as n from loan_payments where txn_id = ?').get(txnId) as { n: number };
    const billLinks = t.sqlite
      .prepare('select count(*) as n from bill_installments where paid_txn_id = ?')
      .get(txnId) as { n: number };
    expect(loanLinks.n + billLinks.n).toBe(1);
  });

  it('a transaction already linked to a bill is not then taken by a loan rule', () => {
    const billId = seedBill();
    addInstallment({ itemId: billId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId: billId, merchantContains: 'CITY', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    applyPaymentMatchers([txnId]);

    const loanId = makeItem(typeOfKind('loan', 'Car loan'), 'Civic', 2_000_000);
    saveLoanRule({ itemId: loanId, merchantContains: 'CITY', accountId: null, enabled: true });
    expect(applyPaymentMatchers([txnId])).toBe(0);
  });
});

describe('reverseInstallmentLinksForTransactions (ruling B14)', () => {
  it('un-marks what those transactions paid and leaves hand-marked rows alone', () => {
    const itemId = seedBill();
    const matched = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    const byHand = addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000 });
    markInstallmentPaid(byHand, NOW);
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    applyPaymentMatchers([txnId]);

    expect(reverseInstallmentLinksForTransactions([txnId])).toBe(1);

    const rows = listInstallments(itemId, TODAY, 30);
    const wasMatched = rows.find((r) => r.id === matched)!;
    expect(wasMatched.paidAt).toBeNull();
    expect(wasMatched.paidTxnId).toBeNull();
    // Keyed on paid_txn_id IN (...), so it can never touch a row a person marked (B13).
    expect(rows.find((r) => r.id === byHand)!.paidAt).toBe(NOW);
  });

  it('is a no-op for an empty list and for transactions that paid nothing', () => {
    expect(reverseInstallmentLinksForTransactions([])).toBe(0);
    expect(reverseInstallmentLinksForTransactions([spend('grocery', -5_000)])).toBe(0);
  });
});
```

- [ ] **Step 4: Run and watch it fail.**

Run: `npx vitest run tests/lib/loans/payment-matchers.test.ts`
Expected: FAIL — `reverseInstallmentLinksForTransactions` does not exist and bill rules are
invisible to `activeRules`.

- [ ] **Step 5: Widen `activeRules`.** In `src/lib/loans.ts`, the `ActiveRule` interface gains a
  `kind` and its `balanceCents` becomes nullable:

```ts
interface ActiveRule {
  ruleId: number;
  itemId: number;
  merchantContains: string;
  accountId: number | null;
  /** NULL for a bill, and for a loan whose balance was never anchored. */
  balanceCents: number | null;
  kind: 'loan' | 'bill';
}
```

```ts
/**
 * Every ENABLED rule whose item is a loan-kind OR bill-kind item, in ONE query. This is the
 * dormancy bail: a household with neither pays one indexed read per import and nothing else
 * (AC5).
 *
 * v1.12.0: the balance requirement is a LOAN dormancy condition, not a general one. A bill has
 * no balance to move, so requiring a non-null one would make every bill rule permanently inert
 * -- the rule would save, report success, and never fire.
 */
function activeRules(tx: ReturnType<typeof getDb>): ActiveRule[] {
  return tx
    .select({
      ruleId: loanMatcherRules.id,
      itemId: loanMatcherRules.itemId,
      merchantContains: loanMatcherRules.merchantContains,
      accountId: loanMatcherRules.accountId,
      balanceCents: sql<number | null>`${warrantyItems.currentBalanceCents}`,
      kind: sql<'loan' | 'bill'>`${warrantyItemTypes.kind}`,
    })
    .from(loanMatcherRules)
    .innerJoin(warrantyItems, eq(warrantyItems.id, loanMatcherRules.itemId))
    .innerJoin(warrantyItemTypes, eq(warrantyItemTypes.id, warrantyItems.typeId))
    .where(
      and(
        eq(loanMatcherRules.enabled, true),
        inArray(warrantyItemTypes.kind, ['loan', 'bill']),
        sql`(${warrantyItemTypes.kind} = 'bill' OR ${warrantyItems.currentBalanceCents} is not null)`,
      ),
    )
    .orderBy(asc(loanMatcherRules.id))
    .all();
}
```

- [ ] **Step 6: Widen `alreadyLinked`** so the one-link-per-transaction guarantee spans both kinds
  (ruling B11 — this is the whole reason B10 is a rename and not a sibling function called
  afterwards):

```ts
/**
 * MUST-13.4, across both kinds (ruling B11): the union of loan_payments.txn_id and
 * bill_installments.paid_txn_id over the same chunked id set. A loan and a bill whose rules both
 * match one merchant string cannot both take the payment, and that is only expressible if both
 * branches read ONE set.
 */
function alreadyLinked(tx: ReturnType<typeof getDb>, txnIds: number[]): Set<number> {
  const out = new Set<number>();
  for (const chunk of chunkIds(txnIds)) {
    for (const row of tx.select({ txnId: loanPayments.txnId }).from(loanPayments).where(inArray(loanPayments.txnId, chunk)).all()) {
      out.add(row.txnId);
    }
    for (const row of tx
      .select({ txnId: billInstallments.paidTxnId })
      .from(billInstallments)
      .where(inArray(billInstallments.paidTxnId, chunk))
      .all()) {
      if (row.txnId !== null) out.add(row.txnId);
    }
  }
  return out;
}
```

Add `billInstallments` and `isNull` to this file's imports.

- [ ] **Step 7: Add `markEarliestUnpaid` and branch the apply step.** Insert the helper beside
  `link()`:

```ts
/**
 * The bill arm of the rule path (ruling C7). Marks the EARLIEST unpaid installment on this item
 * and records which transaction paid it.
 *
 * THE AMOUNT IS NOT COMPARED, deliberately. A tax bill arrives with penalties, discounts and
 * rounding, and refusing to match on a few dollars' difference would leave the household with an
 * installment that is paid and a reminder that says it is not. The transaction is recorded so
 * the difference is VISIBLE on the detail page instead of being decided here.
 *
 * `AND paid_at IS NULL` in the UPDATE, plus bill_installments_txn_uq (ruling B12), are together
 * the idempotency guard -- the same pairing loan_payments uses. A re-run cannot double-mark, and
 * one transaction can never mark two installments.
 *
 * Neither current_balance_cents nor balance_updated_at is touched: a bill has no balance, and
 * MUST-11.8's human anchor stays a loan concept.
 */
function markEarliestUnpaid(
  tx: ReturnType<typeof getDb>,
  input: { txnId: number; itemId: number; at: string },
): boolean {
  const target = tx
    .select({ id: billInstallments.id })
    .from(billInstallments)
    .where(and(eq(billInstallments.itemId, input.itemId), isNull(billInstallments.paidAt)))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .limit(1)
    .get();
  // Nothing scheduled, or all paid: no link and no error. The transaction is a normal
  // transaction, the household sees it on /transactions, and nothing is fabricated.
  if (target === undefined) return false;
  const result = tx
    .update(billInstallments)
    .set({ paidAt: input.at, paidTxnId: input.txnId })
    .where(and(eq(billInstallments.id, target.id), isNull(billInstallments.paidAt)))
    .run();
  return result.changes > 0;
}
```

Then, inside `applyPaymentMatchers`'s loop, replace the `const applied = link(...)` block with:

```ts
        if (match.kind === 'bill') {
          if (!markEarliestUnpaid(tx, { txnId: txn.id, itemId: match.itemId, at: stamp })) continue;
          linked.add(txn.id);
          created += 1;
          continue;
        }

        const applied = link(tx, {
          txnId: txn.id,
          itemId: match.itemId,
          signedAmountCents: txn.amountCents,
          balanceCents: balances.get(match.itemId) ?? 0,
          source: 'rule',
          at: stamp,
        });
        if (applied === null) continue;
        balances.set(match.itemId, (balances.get(match.itemId) ?? 0) - applied);
        linked.add(txn.id);
        created += 1;
```

`balances` is built from the rules as before; a bill rule contributes a `null` and is never read,
because the bill branch returns before touching it. Update the `applyPaymentMatchers` docblock:
keep every existing MUST reference and add:

```
 * v1.12.0: this function matches BILLS too, which is why it is no longer called
 * applyLoanMatchers (ruling B10 -- there is no alias; a name that lies is worse than a rename).
 * The bill branch is inside the SAME db.transaction, the SAME dormancy bail and the SAME
 * try/catch, so MUST-13.5 (never throws into an import, a sync, a manual entry or a category
 * confirmation) holds for it unchanged.
```

- [ ] **Step 8: Add the reversal**, immediately after `reverseLoanLinksForTransactions` and BEFORE
  its trailing "Note on ... the enclosing transaction" comment (so that note keeps covering both):

```ts
/**
 * Ruling B14: called INSIDE undoImport's existing transaction, BEFORE tx.delete(transactions).
 *
 * The ON DELETE SET NULL on paid_txn_id would drop the link anyway -- but a cascade cannot
 * restore paid_at, so without this an installment would be left marked paid by a transaction
 * that no longer exists. That is the same argument reverseLoanLinksForTransactions already makes
 * about balances, which is why the two are called from the same place, one after the other.
 *
 * Keyed on paid_txn_id IN (...), so it can NEVER touch a hand-marked row: a hand-marked row has
 * paid_txn_id NULL, and that is precisely what "a person marked this" means here (ruling B13).
 *
 * Returns the number of installments un-marked. Uses getDb() rather than a passed handle for the
 * reason the note below reverseLoanLinksForTransactions states -- do not change one without the
 * other.
 */
export function reverseInstallmentLinksForTransactions(txnIds: number[]): number {
  if (txnIds.length === 0) return 0;
  const db = getDb();
  let reversed = 0;
  for (const chunk of chunkIds(txnIds)) {
    reversed += db
      .update(billInstallments)
      .set({ paidAt: null, paidTxnId: null })
      .where(inArray(billInstallments.paidTxnId, chunk))
      .run().changes;
  }
  return reversed;
}
```

- [ ] **Step 9: Call it from `undoImport`.** In `src/lib/import/commit.ts`, extend the import at
  line 5 to
  `import { reverseInstallmentLinksForTransactions, reverseLoanLinksForTransactions } from '@/lib/loans';`
  and, immediately after line 417:

```ts
      loanRowsReversed = reverseLoanLinksForTransactions(sole);
      // Ruling B14, same argument one line up and the same position: ON DELETE SET NULL drops
      // the link but cannot restore paid_at, so an installment would be left marked paid by a
      // transaction that no longer exists.
      reverseInstallmentLinksForTransactions(sole);
```

`UndoResult` is **not** widened. `loanLinksReversed` keeps its meaning and its name; adding a
second count would change a shipped return shape for a number no caller renders.

- [ ] **Step 10: Run the new test and the whole loans suite.**

Run: `npx vitest run tests/lib/loans/ tests/integration/loan-flow.test.ts tests/lib/import/`
Expected: PASS.

- [ ] **Step 11: Re-read the ops guard that greps this file.**
  `tests/ops/loan-invariants.test.ts` has three greps: MUST-13.16 targets
  `src/lib/import/commit.ts` by path and `tx.delete(transactions)` by symbol; MUST-13.1 targets
  `src/lib/loans.ts` by path and `interestRateBps` by symbol; MUST-13.2 targets three files by
  path and `loan_payments|loanPayments` by symbol. **None of the three names
  `applyLoanMatchers`,** so the rename cannot quietly narrow one of them to nothing — but confirm
  that by running it rather than assuming it.

Run: `npx vitest run tests/ops/loan-invariants.test.ts`
Expected: PASS, unedited.

- [ ] **Step 12: Typecheck.**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add src/lib/loans.ts src/lib/import/commit.ts tests/lib/loans/payment-matchers.test.ts
git commit -m "feat(loans): match transactions to bill installments and reverse them on undo"
```

---
# Wave 3 — the copy, the guard, and everything green at once

### Task 8: documentation, the B10 guard, and the full verification pass

**Depends on Tasks 1–7.** Run it only once every one of them has landed.

**Files:**
- Modify: `src/app/(app)/help/content.tsx:301-327` (the `/warranties` section body)
- Modify: `src/app/(app)/warranties/warranties-client.tsx:88-106` (the `PageGuide` body)
- Modify: `docs/PENDING-FIXES.md:728-751` (items N and O)
- Modify: `tests/ops/loan-invariants.test.ts` (append one describe block)

**Interfaces:**
- Consumes: nothing at runtime. The guard reads files from disk and asserts on their text, the
  idiom `tests/ops/row-controls.test.ts` and `tests/ops/balance-invariants.test.ts` already use.

**No other new ops guard is added.** The spec's Testing item 9 lists five existing guards that
must stay green *unedited* and calls for no new grep guard; inventing one to fill the slot would
be a guard nobody argued for. The one exception below is different: ruling B10 says "there is no
alias", and nothing currently stops a future session adding one back.

- [ ] **Step 1: Write the B10 guard.** Append to `tests/ops/loan-invariants.test.ts`:

```ts
describe('ruling B10: applyLoanMatchers was renamed, not aliased', () => {
  it('the old name appears nowhere in src/, not even as a wrapper or a comment', () => {
    // v1.12.0 renamed applyLoanMatchers to applyPaymentMatchers because it now matches bills
    // too and the old name would be a lie. This repo deletes superseded helpers rather than
    // keeping wrappers -- KIND_WORDING superseding the four boolean label helpers is the
    // precedent. A re-added alias is the obvious "kind" thing to do for a caller you did not
    // notice, and it is exactly what must not happen: two names for one function is two places
    // to read before you know what runs.
    const offenders = srcFiles()
      .filter((file) => /applyLoanMatchers/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('finds the new name, so the check above cannot pass vacuously', () => {
    const users = srcFiles()
      .filter((file) => /applyPaymentMatchers/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).replace(/\\/g, '/'));
    // The definition plus its five call sites plus the two client-side comments that name it.
    expect(users).toContain('src/lib/loans.ts');
    expect(users.length).toBeGreaterThanOrEqual(6);
  });

  it('the loan_matcher_rules TABLE keeps its name, and the schema says why out loud', () => {
    // The other half of ruling B10: the function name was free to change and a shipped table
    // name is not. A future session reading only the rename would reasonably assume the table
    // was renamed too.
    const schema = read('src/db/schema.ts');
    expect(schema).toContain("sqliteTable(\n  'loan_matcher_rules'");
    expect(schema).toMatch(/bill-kind items/i);
  });
});
```

- [ ] **Step 2: Run it.**

Run: `npx vitest run tests/ops/loan-invariants.test.ts`
Expected: PASS. If the first assertion fails, Task 7's rename missed a file — rename it, do not
exempt it.

- [ ] **Step 3: Prove the guard can fail.** A guard that cannot fail reads as coverage without
  being it. Temporarily add `export const applyLoanMatchers = applyPaymentMatchers;` to
  `src/lib/loans.ts` and confirm the first assertion fails naming that file. Then temporarily
  rename `applyPaymentMatchers` to `applyPaymentMatchersX` in `src/lib/transactions.ts` and
  confirm the floor assertion drops. Revert both and confirm green.

- [ ] **Step 4: Document the bill in the help page.** In `src/app/(app)/help/content.tsx`, the
  `/warranties` section: change the opening sentence to name five kinds, and add one paragraph
  after the loan paragraph (around line 326). Spec Component 8: nothing is seeded, so the help
  page is where a person learns to create the type.

```tsx
        <P>
          One list for everything you keep paperwork on: warranties, subscriptions, contracts,
          loans and bills. Which of the five an entry behaves as comes from its <B>item type</B>,
          and the wording follows — a subscription shows a <B>cancel by</B> date where a warranty
          shows an expiry date. The Dashboard reminds you before a date arrives, which is the
          whole reason to record one.
        </P>
```

```tsx
        <P>
          A <B>bill</B> is the one kind that carries its own list of due dates rather than a
          repeating cycle — property tax, which falls due two to six times a year on dates the
          municipality picks. Create an item type of kind <B>Bill</B> under{' '}
          <B>Settings → Item types</B> (call it <B>Property tax</B>), add the item, then enter
          each due date and amount in the <B>Installments</B> section on the item&rsquo;s own
          page. The Dashboard&rsquo;s <B>Coming up</B> card lists them, you are reminded before
          each one, and anything that goes past is flagged as overdue until you mark it paid. If
          you add a payment-matching rule, the transaction that pays it marks the next unpaid
          installment for you.
        </P>
```

- [ ] **Step 5: Update the warranties page guide.** In `warranties-client.tsx`, the `PageGuide`
  body (which Task 1 left with a bare `<PageGuide>`): change "Four kinds of paperwork" to "Five
  kinds of paperwork", name bills in that first sentence, and add one paragraph:

```tsx
        <p>
          Five kinds of paperwork live on this page: warranties on things you bought,
          subscriptions you might want to cancel, contracts with a term, loans, and bills that
          fall due on set dates. They share one screen because the question is the same for all
          of them — what does this cover, and when does it run out?
        </p>
```

```tsx
        <p>
          A bill is the odd one out: instead of a monthly or annual cycle it carries a list of due
          dates you type in, which is what a property tax bill actually looks like. Make an item
          type of kind <strong>Bill</strong> under Settings → Item types, add the item here, and
          enter each due date on the item&rsquo;s own page. You are reminded before each one and
          told when one goes past.
        </p>
```

- [ ] **Step 6: Retire PENDING-FIXES items N and O.** Both are what this release answers, and a
  backlog that still lists shipped work is a backlog nobody trusts. Follow the file's existing
  convention for a closed item (see item 1, "SHIPPED in v1.7.0"): keep the heading, mark it, and
  keep enough of the text that the decision stays readable. Replace the two bullets' opening
  lines with:

```markdown
**N. Page guides should start collapsed everywhere — SHIPPED in v1.12.0.** `PageGuide` lost its
`empty` prop entirely (ruling B1); every one of the nine call sites now renders a bare
`<PageGuide>` and the panel opens only when a reader clicks it.
```

```markdown
**O. Contracts & Coverage: tax bills with due dates — SHIPPED in v1.12.0.** A fifth `ItemKind`,
`bill`, with an explicit `bill_installments` schedule instead of a cadence. See
`docs/superpowers/specs/2026-08-24-bills-with-due-dates-design.md`.
```

Keep the rest of each item's original text underneath, unchanged — it is the record of why the
cheap alternative (Quarterly and Semi-annual cadences) was rejected, and that argument is still
the reason not to add them.

- [ ] **Step 7: Run the whole suite. This is the first task that runs everything.**

Run: `npx vitest run` (or `npm test`), foreground, **timeout 600000**. Do not background it and
poll — the local worker pool intermittently hangs when a run is backgrounded and waited on.
Expected: all green. Pay particular attention to:
- `tests/ops/onboarding-coverage.test.ts` — guards 1, 2 and 3, all unedited. Guard 2 greps the
  help page for every NAV href, which Step 4's edit must not have disturbed.
- `tests/ops/use-server-exports.test.ts` — the three new actions.
- `tests/ops/row-controls.test.ts` — the installments card pairs no lone `<select` with a Save.
- `tests/ops/table-layout.test.ts` — the installments `TableWrap` is not `fixed`, so it needs no
  `minWidth`.
- `tests/ops/client-bundle.test.ts` — `installments.ts` imports `@/db` and must never reach a
  client component. The detail client takes rows as props and imports only the TYPE.
- `tests/app/help.test.tsx` and `tests/app/warranties-client.test.tsx` — the copy edits.

- [ ] **Step 8: Typecheck and build.**

Run: `npx tsc --noEmit`
Run: `npx next build`
Expected: both clean.

- [ ] **Step 9: Real-browser check. NON-NEGOTIABLE — the v1.10.1 lesson.** That release's notes
  promised phone scrolling the table could not do, and only a browser would have shown it.

Start `npm run dev`, seed a bill item that carries **at least one overdue, one due-soon, one
scheduled and one rule-marked installment** (use generic names: a `Property tax` type, a
`Municipal tax` item, a `CITY TAX OFFICE` merchant). Then drive Playwright at **390** and **1280**
px and confirm, reporting what you saw at each width:

1. `/warranties/{id}` has **no horizontal scroll on the page** at 1280; at 390 the installments
   table scrolls **inside its own box** and nothing else on the page does.
2. The row kebab opens **un-clipped from the LAST row**, including when that row is the last thing
   on the page — the `position: fixed` upward-opening path, which no unit test can see.
3. The four status badges are distinguishable and legible in **both themes**.
4. The add form's date and amount inputs are usable at 390 without zoom, and the amount-mismatch
   sentence **wraps** rather than overflowing.
5. `/warranties` — the page guide is **collapsed on load**, on a page with rows and on a page
   without.
6. `/dashboard` — the Coming-up card at both widths with an overdue row present: the badge, the
   red date, and the header clause "…and anything overdue."

If any check fails, fix it before Task 9.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(app)/help/content.tsx" "src/app/(app)/warranties/warranties-client.tsx" docs/PENDING-FIXES.md tests/ops/loan-invariants.test.ts
git commit -m "docs: explain bills on the help page and the warranties guide"
```

---

# Wave 4 — release

### Task 9: v1.12.0

**Files:**
- Modify: `package.json:3` (`"version": "1.11.0"` → `"1.12.0"` — that field is the single source
  of truth; `install/update.sh`, `install/update.ps1`, Settings → About and `/api/health` all read
  it)
- Modify: `CHANGELOG.md:22-24` (insert below the `## Unreleased` heading)
- Modify: `tests/ops/docker.test.ts:248-281` (the MUST-7.1 blocks)

**This task does NOT tag and does NOT push.** The owner's own session cuts the tag, because a tag
push repoints GHCR `:latest`, which the NAS pulls. Stop after the commit and say so in your report.

- [ ] **Step 1: Bump the version.** `package.json` line 3: `"version": "1.12.0",`

- [ ] **Step 2: Write the changelog entry.** Read the header comment at the top of `CHANGELOG.md`
  first — it is the rule, not decoration. Keep the `## Unreleased` heading in place and empty above
  the new section, and use the standard group headings. Date it `2026-08-24` or later: 1.11.0 is
  dated 2026-08-24, and an earlier date would make the file read backwards. Insert exactly this,
  between `## Unreleased` and `## [1.11.0]`:

```markdown
## [1.12.0] - 2026-08-24

### Added

- **Bills with due dates.** A property tax bill is not a monthly or an annual subscription — it
  arrives two to six times a year on dates a municipality picks, and no repeating cycle describes
  that. There is now a fifth kind of item, **Bill**, that carries a list of due dates and amounts
  you type in rather than a billing cycle. Make an item type of kind Bill under Settings → Item
  types, add the item, then enter each due date in the new **Installments** section on the item's
  own page.
- **Reminders before each due date, and a flag on anything that goes past.** Installments coming
  up appear on the Dashboard's **Coming up** card and in the "Something is coming due"
  notification you already have — no new switch to find and nothing new to turn on. An overdue
  installment stays visible until you mark it paid, and it reminds you once a month rather than
  every day.
- **Marking an installment paid.** Each row has a **Mark paid** button, and an **Unmark** if you
  press it by mistake. If you add a payment-matching rule to the bill — the same merchant rules
  loans already use — the transaction that pays it marks the next unpaid installment for you and
  records which transaction it was. The amount does not have to match to the cent: a tax bill
  arrives with penalties and rounding, so the payment is recorded and any difference is shown
  beside it rather than the match being refused.

### Changed

- **The page guides now start collapsed on every page.** The "What is this page for?" panel used
  to open itself on any page with nothing on it. It no longer does, anywhere: it opens when you
  click it and not before. An empty page already explains itself with the message and the button
  in the middle of it.
- **Payment-matching rules work on bills as well as loans.** A matched transaction marks an
  installment instead of moving a balance, and one transaction can still only ever be linked once
  — a loan and a bill whose rules both match the same merchant cannot both claim it.
- **Undoing an import now un-marks the installments that import paid.** Previously the link would
  have been dropped while the installment stayed marked paid by a transaction that no longer
  existed. Installments you marked by hand are never touched by an undo.

### Fixed

- **A bill's own dates and its schedule are kept apart.** Choosing Bill as an item's type hides
  the billing cycle, the product fields and the loan fields, which do not apply to it — and
  changing a type's kind away from Bill keeps every due date you typed rather than deleting them.
  They simply stop being read, and they come back if you change the kind back.
```

- [ ] **Step 3: Update the release guard in `tests/ops/docker.test.ts`.** Follow the existing
  append-only pattern exactly: the newest release asserts `pkg.version` **is** its number, and the
  one before it is kept with its assertion flipped to `not.toBe`. Add above the 1.11.0 block:

```ts
  it('MUST-7.1: the 1.12.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.12.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.12\.0\] - 2026-08-24$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.12.0]'));
    const entry = changelog.slice(changelog.indexOf('## [1.12.0]'), changelog.indexOf('## [1.11.0]'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    // The headline claims, asserted as claims and not just as a version number: an entry that
    // bumped the version without saying what a reader will see is the gap this guard is for.
    expect(entry).toMatch(/Bills with due dates/i);
    expect(entry).toMatch(/Installments/);
    // A release that adds reminders must say what happens when one is missed, or "it reminds you"
    // reads as "nothing can slip".
    expect(entry).toMatch(/overdue/i);
    // The reversal of a shipped behaviour has to be stated, not merely done -- somebody liked it.
    expect(entry).toMatch(/start collapsed/i);
    // \s+ because the sentence wraps in the file.
    expect(entry).toMatch(/un-marks the installments\s+that import paid/i);
  });
```

Then edit the existing 1.11.0 block: `expect(pkg.version).toBe('1.11.0')` becomes
`expect(pkg.version).not.toBe('1.11.0')`, and rename the test to
`'MUST-7.1: the 1.11.0 release is still recorded intact (append-only discipline)'` — the same
wording the 1.10.3 block uses. Its slice start `## [1.11.0]` and end `## [1.10.3]` are both still
correct, so **only** the version assertion and the test name change.

- [ ] **Step 4: Run the release guard and the full suite.**

Run: `npx vitest run tests/ops/docker.test.ts`
Run: `npx vitest run` (foreground, timeout 600000)
Expected: PASS.

- [ ] **Step 5: Commit. Then stop.**

```bash
git add package.json CHANGELOG.md tests/ops/docker.test.ts
git commit -m "chore(release): v1.12.0"
```

**Do not tag. Do not push.** Report that the release commit is on `main` and that the tag and the
push are the controller's to make.

---

## Spec ambiguities resolved

Seven places where the spec was silent, self-contradictory, or mechanically wrong. Each is called
out at the point of use above; they are collected here so a reviewer can accept or overturn them
in one place.

1. **The migration's foreign-key pragma cannot go in the `.sql` file.** The spec asks for "a
   foreign-key-off/on pair around the rename ... matching how Drizzle's own generated rebuilds do
   it." Drizzle's SQLite dialect wraps every migration in `BEGIN ... COMMIT`
   (`sqlite-core/dialect.cjs:676`), and `PRAGMA foreign_keys` is a documented no-op inside a
   transaction. `defer_foreign_keys` and `legacy_alter_table` were both tried and both fail (Task
   2 records how). **Resolved:** `openDatabase()` in `src/db/client.ts` disables foreign keys
   around the whole migration pass and re-enables them, plus a `foreign_key_check` that refuses to
   start on an orphan. The `.sql` file carries no pragma, and a test asserts it never gains one.

2. **The migration header's inventory numbering.** The spec says 0011 "restates entries 1–27 ...
   and adds 28 and 29". 0009's own list already runs to **29**. **Resolved:** 0011 restates 1–29
   and adds **30** (the `bill_installments` CHECKs) and **31** (the widened kind CHECK, superseding
   entry 11).

3. **`bill_installments` has three CHECK constraints, not four.** The spec's Testing item 1 says
   "its four CHECKs" and then lists three (`amount_cents <= 0` refused, malformed `due_date`
   refused, `paid_txn_id` without `paid_at` refused), which is what the SQL in Component 1
   declares. **Resolved:** three, each with its own test.

4. **`KIND_WORDING.bill` is not `contract`'s row verbatim.** B5 says "verbatim" and then
   enumerates seven values whose last is `Ongoing (no end date)`; `contract`'s is `Open-ended`.
   **Resolved:** the enumeration wins — six fields match `contract` and `openEnded` is
   `Ongoing (no end date)`, with the departure commented where it is made.

5. **`addInstallment` cannot return an `InstallmentRow`.** The spec's signature returns one, but
   `InstallmentRow.state` is derived from a `today` and a `dueSoonDays` that a create call has no
   business taking, and the caller revalidates and re-reads anyway. **Resolved:** it returns the
   new row's `id`.

6. **`InstallmentState` is declared in `constants.ts`, not `installments.ts`.** The spec puts the
   type beside the data layer, but the detail page is a client component and calls
   `installmentStateLabel()`, which MUST-19.11 keeps in the wording module and Ruling P4 keeps
   free of `@/db`. **Resolved:** the type and the labels live in `constants.ts`;
   `installments.ts` imports the type. Nothing is declared twice.

7. **`ComingUpCard`'s list key.** The spec does not mention it, but one bill item can now
   contribute several rows and the card keys its `<li>` on `bill.itemId` — which would collide and
   silently drop a row. **Resolved:** the key becomes
   `installment-${installmentId}` for a schedule row and `item-${itemId}` for a cadence one, with
   a test that two installments on one item render two list items.

Two further points, decided rather than ambiguous, recorded so they are not mistaken for
omissions: the **journal's `when` for idx 11** is `1756166400000` (one day after 0010, the file's
existing cadence, which `migration-0010.test.ts` already asserts for its own entry); and
**`UndoResult` is not widened** with an installment count — `loanLinksReversed` keeps its meaning,
and no caller renders a second number.
