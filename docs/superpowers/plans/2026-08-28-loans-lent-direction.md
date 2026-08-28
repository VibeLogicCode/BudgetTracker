# v1.14.0 — loans with direction "lent" — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close backlog item **BU** (`docs/PENDING-FIXES.md`, "Owner feature requests after
v1.13.3") and nothing else. A loan item gains a direction. `'owed'` is what every loan means today —
a debt the household owes. `'lent'` is money someone owes the household, and it flips one thing: the
sign convention. Money OUT raises a lent loan's balance, money IN lowers it. Everything downstream —
the dashboard card, the debt report, the net-worth debt line — follows from that one flip.

**Architecture:** One additive migration, one pure helper that owns the flip, and then five surfaces
that read the new column. Work is grouped by the FILE it touches, never by the feature it serves, so
two agents never open the same file. The two read-model SHAPES (`LoanSummary.loanDirection`,
`DebtPoint.lentCents`) are declared by the foundation task before any lane starts, which is the only
reason the maths lane and the surfaces lane can run at the same time.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6.0.3, Drizzle ORM over better-sqlite3,
Tailwind 4, Vitest 3 + `@testing-library/react` + jsdom (per-file `// @vitest-environment jsdom`;
the suite default is `node`, and `globals: false` means every file imports `describe`/`it`/`expect`
from `'vitest'` explicitly).

**Spec:** `docs/superpowers/specs/2026-08-28-loans-lent-direction-design.md` — **read it first.**
Rulings **P1–P16** are the planner's and are cited by number throughout. The standing rulings from
v1.12.1 and v1.13.0 (R1–R11) are in force and are not reopened.

**Concurrent work outside this plan.** Another agent is editing
`src/app/(app)/review/review-client.tsx` and `tests/app/review-page.test.ts` in this same checkout
for the same release. **No task here may open either file.** Task 7 carries one CHANGELOG bullet
describing that agent's change; that bullet is the whole of this plan's contact with it.

---

## Standing rules for every implementer

Copy these into your working memory before you touch anything. They are not negotiable.

> Never run `git stash`. Never override git identity. Never add a `Co-Authored-By` line or any
> Claude/AI attribution to a commit. Run vitest in the FOREGROUND with a 600000 ms timeout, never in
> the background. Never open or delete `.tmp-data/`. Never write an owner name, an employer name, an
> email or an absolute Windows path into any file. Next's dev server may drop an `AGENTS.md` /
> `CLAUDE.md` at the repo root — delete it, never commit it. Local vitest may exit 1 with every test
> passing (a worker RPC teardown stall, a known backlog item): read the pass/fail counts, not the
> exit code.

**Committing (shared index — this is the race that eats work).** Three lanes run concurrently in one
checkout. Every commit is ONE command:

```
git status --short
git add <the exact paths this task owns> && git commit -m "<message>"
```

Never `git add -A`, never `git add .`, never `git commit -a`. If `git status --short` shows a file
you do not own as modified, that is another lane (or the review-page agent) working — leave it
alone and do not stage it.

## Global Constraints

Every task's requirements implicitly include this section.

- **No Playwright and no browser test.** Vitest + `npx tsc --noEmit` are the whole gate.
- **Exactly one migration**, `drizzle/0014_loan_direction.sql`, written by Task 1 and by nobody
  else. `drizzle/**` and `src/db/schema.ts` are opened by Task 1 only. If a later task thinks it
  needs a schema change, STOP and report it instead.
- **Additive only.** No table rebuild, no dropped column, no changed default. Every existing row
  takes `'owed'` and must behave EXACTLY as it does today — that is a test obligation (Task 3), not
  an aspiration.
- **No new npm dependency**, no new API route, no new server action file.
- **Integer cents only.** No floats, no `parseFloat`. `parseAmountToCents` (`src/lib/money.ts:11`)
  is the one parser, `formatCents` (`:50`) the one formatter.
- **ISO date strings**, `YYYY-MM-DD`. Date arithmetic goes through `src/lib/dates.ts`. **No
  `new Date()` inside any `src/lib/**` function** — `today` is a parameter.
- **PUBLIC REPO.** No owner name, no employer name, no real statement data, no real merchant
  strings, no absolute Windows paths — in code, comments, tests or fixtures. Use the fixtures this
  repo already uses: `'Alice'`, `'Bob'`, `'Admin Owner'`, `'Chequing'`, `'Civic'`, `'TIM HORTONS'`.
  A lent-loan fixture is named `'Loan to a friend'` and the borrower is never a real person.
- **Kids' `self` scope.** No balances and no net worth reach a self viewer, ever. `ownerScope` and
  `isSelfScoped` (`src/lib/auth/viewer.ts:21, :25`) are the only way to ask. The "Who owes us" card
  is the one balance-bearing card a self viewer sees, and ONLY because every row in it is a row that
  viewer owns (ruling P11) — its copy must never imply a household total. A control a self viewer
  cannot use is **not rendered**, never shown-and-refused.
- **MUST-13.1 (interest is display only) and MUST-13.2 (loan-linked rows stay in their category and
  in every budget) are untouched.** Nothing in this release multiplies, accrues or projects with
  `interest_rate_bps`; nothing in this release writes `is_transfer`, `category_id`,
  `attributed_user_id`, or the `transactions` table at all. `transactions.amount_cents` stays
  immutable and direction is derived at read time. Read the header of `src/lib/loans.ts` and
  `tests/lib/loans/invariants.test.ts` before you touch either.
- **44px minimum touch target** on any control you add or move on mobile. `selectClass`
  (`src/components/ui/form.tsx`) already carries it — use it, do not hand-roll classes.
- **Conventional commits** (`feat:` / `fix:` / `test:` / `docs:` / `chore:` / `refactor:`).
- **Run only your own test files** (`npx vitest run <paths> --reporter=dot`) until Task 8, which is
  the first task that runs the whole suite.
- **Match the surrounding code.** This codebase writes load-bearing docblocks that say *why*. A
  comment arguing for behaviour the code no longer has is worse than no comment — rewrite it, do not
  trim it.
- TDD: write the failing test, run it and watch it fail, implement the minimum, watch it pass,
  commit.

## Ops guards you can trip

| Guard | What it does | What it means for you |
|---|---|---|
| `tests/ops/loan-invariants.test.ts` | MUST-13.1's "no arithmetic on `interestRateBps` in `src/lib/loans.ts`" scan; MUST-13.16's single-delete-site scan | Task 3 ADDS ruling P4's grep (no literal `'lent'` in `src/lib/loans.ts`). No other task edits this file. Nothing you add may put `interestRateBps` next to `*`, `/`, `+` or `-`. |
| `tests/lib/loans/invariants.test.ts` | scans for an update that sets `transactions.amountCents` — the column is immutable | No task writes the `transactions` table. If you find yourself needing to, you have mis-read the spec. |
| `tests/ops/visibility-invariants.test.ts` | named `REQUIRE_VIEWER` / `EXEMPT` / `HOUSEHOLD_ONLY_AT_PAGE` lists; floors of 27 and 4 | **No task edits this file.** `listLoans(today, viewer)` keeps its exact signature (stays in `REQUIRE_VIEWER`), `debtOverTime` gains NO viewer (stays in `HOUSEHOLD_ONLY_AT_PAGE`), and no new library function takes a viewer. If you think you need one, you have drifted from ruling P11 — the dashboard partitions rows `listLoans` has already scoped. |
| `tests/ops/client-bundle.test.ts` | no `'use client'` file may value-import `@/db/client`, `@/lib/env`, `better-sqlite3` or a `node:` builtin, directly or transitively | This is why `loanSignedDelta` and the labels live in `src/lib/warranty/constants.ts` (pure, already imported by both item clients) and NOT in `src/lib/loans.ts`. A client component may import from `@/lib/warranty/constants`; it may **never** import a value from `@/lib/loans` — `import type { LoanSummary }` / `import type { DebtPoint }` only. |
| `tests/ops/use-server-exports.test.ts` | every export of a `'use server'` file must be an async function | Task 6 adds `readLoanDirection` to `src/app/(app)/warranties/actions.ts` as a **module-private** function (no `export`), exactly as `readBillingCycle` (`:138`) already is. |
| `tests/ops/row-controls.test.ts` | scans `src/app/**/*.tsx`; a `<form>` with exactly one `<select>`, hidden-only `<input>`s, no `<textarea>` and a submit control is an offence; floor of `>= 5` `<AutoSaveSelect` occurrences | Task 6's Direction select lands inside the big item forms (many inputs, a textarea), so it cannot trip rule 1, and it removes no `<AutoSaveSelect`. Do **not** reach for `AutoSaveSelect` here — both item forms are plain `<form action={…}>` submits. |
| `tests/ops/table-layout.test.ts` | every `<TableWrap … fixed …>` must carry `minWidth=` | No task adds or edits a table. |
| `tests/ops/onboarding-coverage.test.ts` | guards over `NAV`, every `EmptyState` call site, and `help/content.tsx` | Task 7 adds a help paragraph (fine). Task 4's card renders **no** `EmptyState` — it self-hides (ruling P11), which keeps it out of guard 1 entirely. |
| `tests/db/loan-schema.test.ts:90` | the four loan money columns are contiguous and in order | `ALTER TABLE ADD COLUMN` appends past them, so this stays true and the file is **not** edited. |
| `tests/ops/docker.test.ts` | MUST-7.1's append-only release ledger | Task 8 only. Task 7 writes the CHANGELOG entry Task 8 then asserts. |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `drizzle/0014_loan_direction.sql` | the one `ALTER TABLE ADD COLUMN` (**new**) | T1 |
| `drizzle/meta/_journal.json` | the `idx: 14` entry | T1 |
| `src/db/schema.ts` | `warrantyItems.loanDirection` | T1 |
| `src/lib/warranty/constants.ts` | `LOAN_DIRECTIONS`, `LoanDirection`, labels, `loanSignedDelta`, `isLoanRepayment`, `LOAN_DIRECTION_KIND_ERROR` | T1 |
| `src/lib/warranty/items.ts` | read/write the column, zod, the kind rule | T1 |
| `src/lib/warranty/types.ts` | `setItemTypeKind` resets to `'owed'` (P3) | T1 |
| `src/lib/loans.ts` | **shape only** in T1 (`LoanSummary.loanDirection`, `DebtPoint.lentCents`); all behaviour in T2/T3 | T1, then lane A |
| `src/components/WhoOwesUsCard.tsx` | the dashboard card (**new**) | T4 |
| `src/app/(app)/dashboard/page.tsx` | partition the rows, wire the card | T4 |
| `src/app/(app)/reports/page.tsx` | `hasLoans` + `hasLent` from ONE `listLoans` call | T5 |
| `src/app/(app)/reports/reports-client.tsx` | the card description and `showLent` | T5 |
| `src/components/charts/DebtTrendChart.tsx` | the second line and the legend | T5 |
| `src/app/(app)/warranties/new/new-warranty-client.tsx` | the Direction control | T6 |
| `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` | the Direction control (EditForm) + the "Direction" detail row | T6 |
| `src/app/(app)/warranties/actions.ts` | `readLoanDirection` | T6 |
| `src/app/(app)/transactions/transactions-client.tsx` | the direction-neutral unassign confirm (P15) | T6 |
| `src/app/(app)/help/content.tsx` | one paragraph | T7 |
| `CHANGELOG.md` | `## [1.14.0]` incl. the "Before updating" block | T7 |
| `package.json`, `tests/ops/docker.test.ts`, `docs/PENDING-FIXES.md` | the release | T8 |

## Lane table

Task 1 runs **alone, first**. Then three lanes run **concurrently in one checkout**; tasks inside a
lane run in the listed order. Task 8 runs **alone, after all three lanes are done**.

| Lane | Tasks, in order | Every file the lane touches |
|---|---|---|
| **foundation** | T1 (alone, first) | `drizzle/0014_loan_direction.sql` (new), `drizzle/meta/_journal.json`, `src/db/schema.ts`, `src/lib/warranty/constants.ts`, `src/lib/warranty/items.ts`, `src/lib/warranty/types.ts`, `src/lib/loans.ts` (two shape lines only), `tests/db/migration-0014.test.ts` (new), `tests/lib/warranty/constants.test.ts`, `tests/lib/warranty/items.test.ts`, `tests/lib/warranty/types.test.ts` |
| **A — maths** | T2 → T3 | `src/lib/loans.ts`, `tests/lib/loans/fixtures.ts`, `tests/lib/loans/manual-assign.test.ts`, `tests/lib/loans/reversal.test.ts`, `tests/lib/loans/payment-matchers.test.ts`, `tests/lib/loans/backfill.test.ts`, `tests/lib/loans/summary.test.ts`, `tests/lib/loans/debt-over-time.test.ts`, `tests/ops/loan-invariants.test.ts` |
| **B — read surfaces** | T4 → T5 | `src/components/WhoOwesUsCard.tsx` (new), `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/reports/page.tsx`, `src/app/(app)/reports/reports-client.tsx`, `src/components/charts/DebtTrendChart.tsx`, `tests/components/who-owes-us-card.test.tsx` (new), `tests/app/dashboard.test.tsx`, `tests/app/loans-card.test.tsx`, `tests/app/reports-client.test.tsx`, `tests/app/reports.test.tsx` |
| **C — write surfaces + docs** | T6 → T7 | `src/app/(app)/warranties/new/new-warranty-client.tsx`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx`, `src/app/(app)/warranties/actions.ts`, `src/app/(app)/transactions/transactions-client.tsx`, `src/app/(app)/help/content.tsx`, `CHANGELOG.md`, `tests/app/new-warranty-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`, `tests/app/warranties-actions.test.ts`, `tests/app/transactions-client.test.tsx`, `tests/app/help.test.tsx` |
| **release** | T8 (alone, last) | `package.json`, `tests/ops/docker.test.ts`, `docs/PENDING-FIXES.md` |

**Disjointness.** No path appears in two concurrent lanes — verified file-by-file in the self-review
at the end of this plan. `src/lib/loans.ts` appears twice in the table above and that is the ONE
exception, deliberately: Task 1 opens it for two type lines while nothing else is running, and from
the moment the lanes start it belongs to lane A alone. Lanes B and C never open it (they
`import type` from it and nothing more).

**No contingency is expected.** Task 1 makes `loanDirection` a REQUIRED field on `LoanSummary` and
`WarrantyItemRow`, which will break any test fixture that builds one as a literal. A grep at plan
time found exactly one: `tests/app/loans-card.test.tsx` (lane B, listed above). Task 1 must run
`npx tsc --noEmit` and report every other file it breaks; if that list is longer than that one file,
the lane that owns each file fixes it in its first task and says so in its report.

---

# Foundation

### Task 1: the column, the helper, and the shapes every later task consumes

Runs **alone**, before any lane starts. Small on purpose: one migration, one helper, one column
read and written, and two type lines in `src/lib/loans.ts` that carry no behaviour.

**Files:**
- Create: `drizzle/0014_loan_direction.sql`, `tests/db/migration-0014.test.ts`
- Modify: `drizzle/meta/_journal.json`, `src/db/schema.ts`, `src/lib/warranty/constants.ts`,
  `src/lib/warranty/items.ts`, `src/lib/warranty/types.ts`, `src/lib/loans.ts` (two shape lines
  only — see step 6)
- Test: `tests/lib/warranty/constants.test.ts` (extend), `tests/lib/warranty/items.test.ts`
  (extend), `tests/lib/warranty/types.test.ts` (extend)

**Interfaces.** This block is the contract. Every later task consumes exactly what is listed here
and nothing else; nothing here may be renamed, made optional, or moved to another module without
re-planning.

```ts
// ---- src/lib/warranty/constants.ts  (PURE + client-safe: this module imports no @/db)
export const LOAN_DIRECTIONS = ['owed', 'lent'] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

export function isLoanDirection(value: string): value is LoanDirection;

/** { owed: 'We owe this', lent: 'Owed to us' } */
export const LOAN_DIRECTION_LABELS: Record<LoanDirection, string>;

/**
 * The transaction's amount re-expressed in the loan's own frame. NEGATIVE always means
 * "this balance goes DOWN", whichever way the loan points.
 *   owed, -100 -> -100 | owed, +100 -> +100 | lent, -100 -> +100 | lent, +100 -> -100
 */
export function loanSignedDelta(direction: LoanDirection, amountCents: number): number;

/** Sugar for loanSignedDelta(direction, amountCents) < 0. */
export function isLoanRepayment(direction: LoanDirection, amountCents: number): boolean;

/** 'Only a loan can be owed to us.' — thrown beside LOAN_KIND_ERROR (ruling P3). */
export const LOAN_DIRECTION_KIND_ERROR: string;

// ---- src/db/schema.ts
warrantyItems.loanDirection; // text('loan_direction', { enum: ['owed','lent'] }).notNull().default('owed')

// ---- src/lib/warranty/items.ts
export interface WarrantyItemRow { /* …existing… */ loanDirection: LoanDirection }   // REQUIRED
export interface WarrantyInput   { /* …existing… */ loanDirection?: LoanDirection }  // optional in, defaults 'owed'
// warrantyInputSchema(today) gains: loanDirection: z.enum(LOAN_DIRECTIONS).default('owed')

// ---- src/lib/loans.ts  (SHAPE ONLY in this task; behaviour is lane A's)
export interface LoanSummary { /* …existing… */ loanDirection: LoanDirection }       // REQUIRED
export interface DebtPoint { month: string; owedCents: number | null; lentCents: number | null }
```

**Explicitly NOT in the interface, and no task may add it:** a `lent`-specific balances query, a
viewer-taking loan function, a borrower column, a person on a split. Ruling P11 gets the dashboard's
total by partitioning the rows `listLoans(today, viewer)` already scopes; ruling P7 puts the
borrower's name in the item's own name.

**Consumes:** `loanFieldsAllowedForKind` (`constants.ts:287`), `kindForTypeId` /
`assertLoanFieldsMatchKind` (`items.ts:335-350`), the `ITEM_COLUMNS` select map (`items.ts:270-292`).

- [ ] **Step 1: Write the failing tests.**

New file `tests/db/migration-0014.test.ts`, following `tests/db/migration-0013.test.ts` exactly
(same `columns()` helper, same `createTestDb()` lifecycle):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSqlite } from '@/db/client';
import { createTestDb, type TestDb } from '../helpers/db';

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(table: string): Map<string, ColumnInfo> {
  const rows = getSqlite().pragma(`table_info(${table})`) as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

let current: TestDb | null = null;

describe('drizzle/0014_loan_direction.sql', () => {
  beforeEach(() => { current = createTestDb(); });
  afterEach(() => { current?.cleanup(); current = null; });

  it('adds loan_direction to warranty_items, NOT NULL, defaulting to owed', () => {
    const cols = columns('warranty_items');
    expect(cols.get('loan_direction')?.notnull).toBe(1);
    expect(cols.get('loan_direction')?.dflt_value).toBe("'owed'");
  });

  it('appends PAST the four loan money columns, which stay contiguous and in order', () => {
    // tests/db/loan-schema.test.ts pins this and must keep passing unedited: ALTER TABLE ADD
    // COLUMN appends physically, so 0014's column lands after budget_category_id.
    const names = [...columns('warranty_items').keys()];
    const start = names.indexOf('principal_cents');
    expect(names.slice(start, start + 4)).toEqual([
      'principal_cents', 'interest_rate_bps', 'current_balance_cents', 'balance_updated_at',
    ]);
    expect(names.indexOf('loan_direction')).toBeGreaterThan(names.indexOf('budget_category_id'));
  });

  it('a row inserted without naming the column takes owed, so the CHECK holds by construction', () => {
    const db = getSqlite();
    const user = db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Alice', 'alice', 'x', 'member', 0, 1, '2026-08-28T00:00:00.000Z') returning id`,
    ).get() as { id: number };
    db.prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
    ).run(user.id);
    const row = db.prepare('select loan_direction from warranty_items').get() as { loan_direction: string };
    expect(row.loan_direction).toBe('owed');
  });

  it('the CHECK refuses a third value', () => {
    const db = getSqlite();
    const user = db.prepare(
      `insert into users (name, username, password_hash, role, totp_enabled, is_active, created_at)
       values ('Alice', 'alice', 'x', 'member', 0, 1, '2026-08-28T00:00:00.000Z') returning id`,
    ).get() as { id: number };
    db.prepare(
      `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, created_at, updated_at)
       values ('Civic', '2024-01-15', 0, ?, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z')`,
    ).run(user.id);
    expect(() => db.prepare(`update warranty_items set loan_direction = 'given'`).run()).toThrow(/CHECK/i);
  });

  it('records itself in the journal', () => {
    const journal = JSON.parse(
      require('node:fs').readFileSync('drizzle/meta/_journal.json', 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1];
    expect(last).toMatchObject({ idx: 14, tag: '0014_loan_direction' });
  });
});
```

Append to `tests/lib/warranty/constants.test.ts` (pure, no DB):

```ts
describe('loanSignedDelta (ruling P4)', () => {
  it('is the identity for an owed loan, so today’s behaviour is unchanged by construction', () => {
    expect(loanSignedDelta('owed', -50_000)).toBe(-50_000);
    expect(loanSignedDelta('owed', 50_000)).toBe(50_000);
    expect(loanSignedDelta('owed', 0)).toBe(0);
  });

  it('negates for a lent loan: money out lends more, money in repays', () => {
    expect(loanSignedDelta('lent', -50_000)).toBe(50_000);
    expect(loanSignedDelta('lent', 50_000)).toBe(-50_000);
    expect(loanSignedDelta('lent', 0)).toBe(0);
  });

  it('isLoanRepayment reads "this balance goes down" in either frame', () => {
    expect(isLoanRepayment('owed', -50_000)).toBe(true);
    expect(isLoanRepayment('owed', 50_000)).toBe(false);
    expect(isLoanRepayment('lent', -50_000)).toBe(false);
    expect(isLoanRepayment('lent', 50_000)).toBe(true);
  });

  it('labels are written in the household’s voice and cover every value', () => {
    expect(LOAN_DIRECTIONS.map((d) => LOAN_DIRECTION_LABELS[d])).toEqual(['We owe this', 'Owed to us']);
    expect(isLoanDirection('owed')).toBe(true);
    expect(isLoanDirection('lent')).toBe(true);
    expect(isLoanDirection('given')).toBe(false);
  });
});
```

Append to `tests/lib/warranty/items.test.ts` — the round trip, and the kind rule:

```ts
describe('loan_direction round trip (spec BU, ruling P3)', () => {
  it('defaults to owed when the input omits it entirely', () => {
    const id = createWarrantyItem({ ...baseInput(), typeId: loanTypeId }, NOW);
    expect(getWarrantyItem(id, HOUSEHOLD)?.loanDirection).toBe('owed');
  });

  it('stores and reads back lent for a loan, and updates back to owed', () => {
    const id = createWarrantyItem({ ...baseInput(), typeId: loanTypeId, loanDirection: 'lent' }, NOW);
    expect(getWarrantyItem(id, HOUSEHOLD)?.loanDirection).toBe('lent');
    updateWarrantyItem(id, { ...baseInput(), typeId: loanTypeId, loanDirection: 'owed' }, NOW);
    expect(getWarrantyItem(id, HOUSEHOLD)?.loanDirection).toBe('owed');
  });

  it('refuses lent on an item whose kind is not loan', () => {
    // Ruling P3: 'owed' is the honest value for an item that is not a loan at all, so writing
    // 'lent' onto one is a refusal, not a silent coercion -- the same shape LOAN_KIND_ERROR has.
    expect(() =>
      createWarrantyItem({ ...baseInput(), typeId: warrantyTypeId, loanDirection: 'lent' }, NOW),
    ).toThrow(LOAN_DIRECTION_KIND_ERROR);
  });

  it('accepts an explicit owed on a non-loan item (it is the default, not a loan field)', () => {
    const id = createWarrantyItem({ ...baseInput(), typeId: warrantyTypeId, loanDirection: 'owed' }, NOW);
    expect(getWarrantyItem(id, HOUSEHOLD)?.loanDirection).toBe('owed');
  });
});
```

Reuse whatever `baseInput()` / `loanTypeId` / `warrantyTypeId` / viewer fixture that file already
has; do not invent a second set.

Append to `tests/lib/warranty/types.test.ts`:

```ts
it('a type moving away from loan resets its items to direction owed (MUST-12.5, ruling P3)', () => {
  const id = createWarrantyItem({ ...baseInput(), typeId: loanTypeId, loanDirection: 'lent' }, NOW);
  setItemTypeKind(loanTypeId, 'warranty');
  const row = getWarrantyItem(id, HOUSEHOLD);
  expect(row?.loanDirection).toBe('owed');
  // The four money columns are cleared by the same .set() -- unchanged behaviour, asserted
  // here so a future edit cannot drop one of the five.
  expect(row?.currentBalanceCents).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/db/migration-0014.test.ts tests/lib/warranty/constants.test.ts tests/lib/warranty/items.test.ts tests/lib/warranty/types.test.ts --reporter=dot
```
Expected: the migration file does not exist, `loanSignedDelta` is not exported, `loanDirection` is
not a field.

- [ ] **Step 3: Write the migration.**

`drizzle/0014_loan_direction.sql`. **Copy `drizzle/0013_household_scope.sql`'s header structure
verbatim** and then adapt: the hand-maintained warning, the separator note (the breakpoint marker is
*described*, never quoted, or the migrator shreds the file), the "this CHECK is forward-only and
that is harmless because the column is NEW" paragraph, and the running inventory of **objects that
exist ONLY in SQL and have NO Drizzle representation**. Entries **1–39 are restated verbatim from
0013's header** and exactly one entry is appended:

```
--  40. the loan_direction CHECK on warranty_items, and the column arriving   (0014)
--      by ALTER TABLE ADD COLUMN
```

The whole body is one statement, so there is no breakpoint marker in this file at all:

```sql
ALTER TABLE `warranty_items` ADD COLUMN `loan_direction` text NOT NULL DEFAULT 'owed' CHECK (`loan_direction` IN ('owed', 'lent'));
```

Do **not** put a foreign-key pragma in this file (0011's header explains why: `openDatabase()` in
`src/db/client.ts` handles foreign keys around the whole migration pass).

Then append to `drizzle/meta/_journal.json`, after 0013's entry, matching its shape exactly:

```json
    {
      "idx": 14,
      "version": "6",
      "when": 1756425600000,
      "tag": "0014_loan_direction",
      "breakpoints": true
    }
```

- [ ] **Step 4: Mirror it in `src/db/schema.ts`.**

Declared **last** in `warrantyItems`, after `budgetCategoryId`, with the docblock the spec gives
(§ Data model → Schema mirror) — the "NOT represented here — SQL only: the CHECK" note is
load-bearing and must survive.

```ts
loanDirection: text('loan_direction', { enum: ['owed', 'lent'] }).notNull().default('owed'),
```

- [ ] **Step 5: Add the helper and the labels to `src/lib/warranty/constants.ts`.**

Place them next to the `BILLING_CYCLES` block (`:253-261`), which is the module's precedent for a
value set + type guard + labels. Use the exact bodies from the spec's "The one helper" section,
including its worked four-line sign table in the docblock. Add `LOAN_DIRECTION_KIND_ERROR` beside
the existing kind-error constants (`:426-429`).

- [ ] **Step 6: Read and write the column in `src/lib/warranty/items.ts`, and reset it in
`src/lib/warranty/types.ts`.**

1. `ITEM_COLUMNS` (`:270-292`) gains `loanDirection: warrantyItems.loanDirection,`.
2. `WarrantyItemRow` gains `loanDirection: LoanDirection` (required).
3. `WarrantyInput` gains `loanDirection?: LoanDirection`.
4. `warrantyInputSchema(today)` gains, beside `billingCycle` (`:213-216`):
   ```ts
   // Shape only, exactly like billingCycle above: whether 'lent' is ALLOWED for this item's
   // kind needs a DB lookup and therefore lives in the writers, not in a synchronous schema.
   loanDirection: z.enum(LOAN_DIRECTIONS).default('owed'),
   ```
5. A new assertion beside `assertLoanFieldsMatchKind` (`:335`), called from both
   `createWarrantyItem` and `updateWarrantyItem` right after it:
   ```ts
   /**
    * Ruling P3. 'owed' is the value every non-loan row carries forever, so only 'lent' is a
    * cross-table claim worth refusing. Deliberately NOT folded into assertLoanFieldsMatchKind:
    * that one asks "are all four money columns absent?", and direction is never absent.
    */
   function assertLoanDirectionMatchesKind(typeId: number | null, direction: LoanDirection): void {
     if (direction === 'owed') return;
     if (!loanFieldsAllowedForKind(kindForTypeId(typeId))) throw new Error(LOAN_DIRECTION_KIND_ERROR);
   }
   ```
6. Both writers pass `loanDirection: input.loanDirection ?? 'owed'` into their `.values({...})` /
   `.set({...})`.
7. `src/lib/warranty/types.ts`'s `setItemTypeKind`: the existing `if (!loanFieldsAllowedForKind(cleanKind))`
   branch that nulls the four money columns adds `loanDirection: 'owed'` to the SAME `.set({...})`.
   Extend that branch's docblock to say so — it currently enumerates what MUST-12.5 clears.

- [ ] **Step 7: Declare the two shapes in `src/lib/loans.ts` — and nothing else.**

This is the whole of Task 1's contact with that file. Behaviour belongs to lane A.

1. `LoanSummary` gains `loanDirection: LoanDirection;` (import the type from
   `@/lib/warranty/constants`, where `BillingCycle` already comes from), and `listLoans`'s
   `.select({...})` gains `loanDirection: warrantyItems.loanDirection,`.
2. `DebtPoint` gains `lentCents: number | null;` with the docblock the spec gives, and BOTH return
   paths of `debtOverTime` gain `lentCents: null` — the early `loans.length === 0` map and the final
   `keys.map`. Add one comment saying why it is a placeholder:
   ```ts
   // v1.14.0 shape-first (plan T1): declared here so the dashboard/report lane and the maths
   // lane are type-independent. The second accumulator lands in the same fold below; until it
   // does, null is the honest value -- no lent loan can exist before the item forms ship.
   ```
   Do **not** touch `link()`, the two SQL queries, or any sign decision.

- [ ] **Step 8: Run the tests and `tsc`.**

```
npx vitest run tests/db/migration-0014.test.ts tests/lib/warranty/constants.test.ts tests/lib/warranty/items.test.ts tests/lib/warranty/types.test.ts tests/db/loan-schema.test.ts tests/db/schema.test.ts --reporter=dot
npx tsc --noEmit
```
`tests/db/loan-schema.test.ts` and `tests/db/schema.test.ts` are run (not edited) to prove the
migration broke nothing. `tsc` WILL report `tests/app/loans-card.test.tsx` (its `LoanSummary`
literals now lack `loanDirection`) — that file belongs to lane B, Task 4 fixes it. **List every
other file `tsc` names in your report**; if there are any, name the lane that owns each.

- [ ] **Step 9: Commit.**

```
git status --short
git add drizzle/0014_loan_direction.sql drizzle/meta/_journal.json src/db/schema.ts src/lib/warranty/constants.ts src/lib/warranty/items.ts src/lib/warranty/types.ts src/lib/loans.ts tests/db/migration-0014.test.ts tests/lib/warranty/constants.test.ts tests/lib/warranty/items.test.ts tests/lib/warranty/types.test.ts && git commit -m "feat(loans): record which way a loan points (migration 0014)"
```

---

# Lane A — the maths

Owns `src/lib/loans.ts` from here on, plus every file under `tests/lib/loans/` and
`tests/ops/loan-invariants.test.ts`. Touches no component, no page and no action.

### Task 2: every balance move reads the loan's direction

**Files:**
- Modify: `src/lib/loans.ts` — `link()` (`:255-289`), its three call sites (`:529`, `:606`, `:670`),
  the two running-balance lines (`:537`, `:612`), `unassignTransactionFromLoan` (`:703`),
  `reverseLoanLinksForTransactions` (`:745`), `payoffProjection` (`:905`), `loansTotalOwedCents`
  (`:1033`)
- Test: `tests/lib/loans/fixtures.ts` (extend), `tests/lib/loans/manual-assign.test.ts`,
  `tests/lib/loans/reversal.test.ts`, `tests/lib/loans/payment-matchers.test.ts`,
  `tests/lib/loans/backfill.test.ts`, `tests/lib/loans/summary.test.ts`

**Interfaces:**
- Consumes: `loanSignedDelta`, `isLoanRepayment`, `LoanDirection` from `@/lib/warranty/constants`
  (Task 1); `LoanSummary.loanDirection` (Task 1).
- Produces: no new export. `link()` grows one required field on its private input object
  (`direction: LoanDirection`); it is module-private, so nothing outside this file sees it.

**Ruling P4 is the design constraint:** `src/lib/loans.ts` must not contain the literal `'lent'` at
all when you are done. Every sign decision calls the helper; any partition tests `=== 'owed'`.

- [ ] **Step 1: Extend the fixture, without changing the existing seed.**

`tests/lib/loans/fixtures.ts`. `seedLoan`'s INSERT must keep NOT naming `loan_direction` on the
default path — that omission is what Task 3's byte-identical proof rests on.

```ts
  function seedLoan(
    over: {
      name?: string;
      balanceCents?: number | null;
      principalCents?: number | null;
      /** v1.14.0. Omitted => the INSERT does not name loan_direction at all, so the row takes
       *  the column DEFAULT exactly as every pre-migration row does. */
      direction?: 'owed' | 'lent';
    } = {},
  ): { itemId: number; accountId: number } {
```

Implement it as two prepared statements — the existing one untouched, and a second that names the
column — chosen on `over.direction === undefined`. Do not add the column to the existing statement
"with a default parameter"; that would destroy the proof.

- [ ] **Step 2: Write the failing tests.**

Append to `tests/lib/loans/manual-assign.test.ts`:

```ts
describe('assignTransactionToLoan on a lent loan (spec BU)', () => {
  it('money OUT raises the balance and money IN lowers it', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 0, direction: 'lent' });

    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(50_000);

    const repayment = ctx.spend('E TRANSFER', 20_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 20_000 });
    expect(ctx.balanceOf(itemId)).toBe(30_000);
  });

  it('a repayment larger than the outstanding balance clamps at zero, never below', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 30_000, direction: 'lent' });
    const repayment = ctx.spend('E TRANSFER', 50_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 30_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
  });

  it('an UNKNOWN balance still applies nothing in either direction (NEW-2, unchanged)', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: null, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 0 });
    expect(ctx.balanceOf(itemId)).toBeNull();
  });

  it('an owed loan is untouched: money OUT still pays it down', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000);
    expect(assignTransactionToLoan({ txnId: payment, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(150_000);
  });
});
```

Append to `tests/lib/loans/reversal.test.ts`:

```ts
describe('reversal on a lent loan (spec BU)', () => {
  it('unassigning an advance takes the balance back down', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    assignTransactionToLoan({ txnId: advance, itemId });
    expect(ctx.balanceOf(itemId)).toBe(50_000);

    expect(unassignTransactionFromLoan({ txnId: advance, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(0);
  });

  it('unassigning a repayment puts it back on', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 50_000, direction: 'lent' });
    const repayment = ctx.spend('E TRANSFER', 20_000);
    assignTransactionToLoan({ txnId: repayment, itemId });
    expect(ctx.balanceOf(itemId)).toBe(30_000);

    unassignTransactionFromLoan({ txnId: repayment, itemId });
    expect(ctx.balanceOf(itemId)).toBe(50_000);
  });

  it('reverseLoanLinksForTransactions restores both signs in one batch', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -80_000);
    const repayment = ctx.spend('E TRANSFER', 30_000);
    assignTransactionToLoan({ txnId: advance, itemId });
    assignTransactionToLoan({ txnId: repayment, itemId });
    expect(ctx.balanceOf(itemId)).toBe(50_000);

    expect(reverseLoanLinksForTransactions([advance, repayment])).toBe(2);
    expect(ctx.balanceOf(itemId)).toBe(0);
  });

  it('a NULL balance stays NULL through a reversal (F2 guard, unchanged)', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: null, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    assignTransactionToLoan({ txnId: advance, itemId });
    unassignTransactionFromLoan({ txnId: advance, itemId });
    expect(ctx.balanceOf(itemId)).toBeNull();
  });
});
```

Append to `tests/lib/loans/payment-matchers.test.ts` — the running-balance line is the trap:

```ts
it('two matched advances on a lent loan accumulate, they do not cancel (ruling P8)', () => {
  // The defect this pins: applyPaymentMatchers keeps a running balance per item and used to
  // SUBTRACT every applied amount, which is only right for an owed loan. On a lent loan the
  // first advance raises the balance, and the second must be clamped against the RAISED figure.
  const ctx = setupLoanTest();
  const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 0, direction: 'lent' });
  saveLoanRule({ itemId, merchantContains: 'E TRANSFER', accountId: null, enabled: true });
  const first = ctx.spend('E TRANSFER', -20_000);
  const second = ctx.spend('E TRANSFER', -30_000);

  expect(applyPaymentMatchers([first, second])).toBe(2);
  expect(ctx.balanceOf(itemId)).toBe(50_000);
});

it('a rule still only ever matches OUTGOING money, in either direction (ruling P8)', () => {
  // An incoming repayment on a lent loan is manual-assign only in v1.14.0: the >= 0 skip is
  // shared with the bill-installment branch and widening it is not this release's job.
  const ctx = setupLoanTest();
  const { itemId } = ctx.seedLoan({ balanceCents: 50_000, direction: 'lent' });
  saveLoanRule({ itemId, merchantContains: 'E TRANSFER', accountId: null, enabled: true });
  const repayment = ctx.spend('E TRANSFER', 20_000);
  expect(applyPaymentMatchers([repayment])).toBe(0);
  expect(ctx.balanceOf(itemId)).toBe(50_000);
});
```

Append to `tests/lib/loans/backfill.test.ts` — the same trap, other loop:

```ts
it('backfill accumulates advances on a lent loan (the running balance is signed)', () => {
  const ctx = setupLoanTest();
  const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
  const ruleId = saveLoanRule({ itemId, merchantContains: 'E TRANSFER', accountId: null, enabled: true });
  ctx.spend('E TRANSFER', -20_000, { date: '2026-07-01' });
  ctx.spend('E TRANSFER', -30_000, { date: '2026-07-15' });

  expect(backfillLoanFromRule(ruleId, { today: '2026-08-18' })).toEqual({ linked: 2, appliedCents: 50_000 });
  expect(ctx.balanceOf(itemId)).toBe(50_000);
});
```

(Match `backfillLoanFromRule`'s real signature and this file's existing call style — read the file
before writing the call.)

Append to `tests/lib/loans/summary.test.ts`:

```ts
describe('direction on the read model (rulings P6, P9, P10)', () => {
  it('listLoans reports each loan’s direction', () => {
    const ctx = setupLoanTest();
    ctx.seedLoan({ name: 'Civic', balanceCents: 200_000 });
    ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 50_000, direction: 'lent' });
    const rows = listLoans('2026-08-18', HOUSEHOLD);
    expect(rows.map((row) => [row.name, row.loanDirection])).toEqual([
      ['Civic', 'owed'],
      ['Loan to a friend', 'lent'],
    ]);
  });

  it('loansTotalOwedCents counts owed loans only — money lent out is not a debt', () => {
    const ctx = setupLoanTest();
    ctx.seedLoan({ balanceCents: 200_000 });
    ctx.seedLoan({ balanceCents: 50_000, direction: 'lent' });
    expect(loansTotalOwedCents()).toBe(200_000);
  });

  it('payoffProjection is null for a lent loan (ruling P9)', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 50_000, principalCents: 80_000, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -10_000, { date: '2026-07-01' });
    assignTransactionToLoan({ txnId: advance, itemId });
    expect(payoffProjection(itemId, '2026-08-18')).toBeNull();
  });

  it('payoffFraction is kept, and reads as "fraction repaid" (ruling P10)', () => {
    const ctx = setupLoanTest();
    ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 20_000, principalCents: 80_000, direction: 'lent' });
    const row = listLoans('2026-08-18', HOUSEHOLD).find((r) => r.name === 'Loan to a friend');
    expect(row?.payoffFraction).toBeCloseTo(0.75, 5);
  });
});
```

- [ ] **Step 3: Run them and watch them fail.**

```
npx vitest run tests/lib/loans --reporter=dot
```
Expected: every lent assertion fails with the mirrored number (a `-50_000` advance takes the balance
DOWN, clamped to 0), and `loansTotalOwedCents` returns 250000.

- [ ] **Step 4: Make `link()` direction-aware.**

`link()`'s input object gains `direction: LoanDirection`, and the three sign lines become:

```ts
  const magnitude = Math.abs(input.signedAmountCents);
  // v1.14.0 (spec BU, ruling P4): the loan's own frame, not the account's. For an owed loan
  // loanSignedDelta is the identity and every line below is byte-for-byte what it was.
  const signed = loanSignedDelta(input.direction, input.signedAmountCents);
  const isRepayment = signed < 0;
  const applied = input.balanceCents === null ? 0 : isRepayment ? Math.max(0, Math.min(magnitude, input.balanceCents)) : magnitude;
  const delta = isRepayment ? -applied : applied;
```

Rewrite the docblock's "F1 fix-round (sign-aware apply)" paragraph so it describes the frame, not
the account: a NEGATIVE **signed delta** is a repayment and DECREMENTS the balance; a POSITIVE one
grows it. Keep every existing sentence about `applied_cents` being unsigned and about direction
being recovered at reversal time — both are still exactly true and are now doing more work.

- [ ] **Step 5: Feed the direction in at the three call sites, and sign the two running balances.**

1. `applyPaymentMatchers` (`:490` ff): the `rules` select gains
   `direction: warrantyItems.loanDirection` (it already joins `warrantyItems` for `balanceCents`);
   build a `directions` map beside the existing `balances` map, pass
   `direction: directions.get(match.itemId) ?? 'owed'`, and replace `:537` with the signed move:
   ```ts
   // v1.14.0: the running balance moves the way the LOAN moves, not the way the account does.
   const moved = isLoanRepayment(direction, txn.amountCents) ? -applied : applied;
   balances.set(match.itemId, (balances.get(match.itemId) ?? 0) + moved);
   ```
2. `backfillLoanFromRule` (`:580` ff): select the direction alongside `anchoredBalance`, pass it to
   `link()`, and replace `balance -= applied` (`:612`) with the same signed move. The query's
   `amount_cents < 0` filter is unchanged (ruling P8).
3. `assignTransactionToLoan` (`:645` ff): the `item` select gains
   `direction: warrantyItems.loanDirection` and passes it through. Note in a comment that this is
   the ONLY path an incoming repayment on a lent loan can take today (ruling P8).

- [ ] **Step 6: Make the two reversal paths direction-aware.**

Both currently recover the sign from `row.txnAmountCents < 0`. Both now join `warrantyItems` and
recover it from the loan's frame:

```ts
    const restore = isLoanRepayment(row.direction, row.txnAmountCents) ? row.appliedCents : -row.appliedCents;
```

`unassignTransactionFromLoan`: add `.innerJoin(warrantyItems, eq(warrantyItems.id, loanPayments.itemId))`
and `direction: warrantyItems.loanDirection` to its select. `reverseLoanLinksForTransactions`: the
same join on its chunked select, then the existing per-item fold is unchanged. **Keep the `max(0, …)`
clamp and the `is not null` guard exactly as they are** — the NEW-1 and F2 fix-round docblocks above
each function still apply verbatim and must not be trimmed.

- [ ] **Step 7: Guard `payoffProjection`, filter `loansTotalOwedCents`.**

`payoffProjection`: one early return after it loads the item, with the reason:

```ts
  // Ruling P9: this sums applied cents over transactions with amount_cents < 0, which for a
  // LENT loan is the balance GROWING. A projection built from that would read advances as
  // repayments and print a payoff month that means nothing, so there is no projection to make.
  if (row.loanDirection !== 'owed') return null;
```

`loansTotalOwedCents`: `.filter((loan) => loan.loanDirection === 'owed')` before the reduce, with a
comment citing ruling P6 (money someone owes the household is not a debt the household owes, so
`src/lib/networth.ts` correctly stops counting it without being edited).

- [ ] **Step 8: Run the tests.**

```
npx vitest run tests/lib/loans tests/lib/warranty --reporter=dot
npx tsc --noEmit
```

- [ ] **Step 9: Commit.**

```
git status --short
git add src/lib/loans.ts tests/lib/loans/fixtures.ts tests/lib/loans/manual-assign.test.ts tests/lib/loans/reversal.test.ts tests/lib/loans/payment-matchers.test.ts tests/lib/loans/backfill.test.ts tests/lib/loans/summary.test.ts && git commit -m "feat(loans): balance maths follows the loan's direction"
```

### Task 3: the debt report gets a second series, and owed loans are proved unchanged

**Files:**
- Modify: `src/lib/loans.ts` — `debtOverTime` (`:1095`) only
- Test: `tests/lib/loans/debt-over-time.test.ts` (extend), `tests/ops/loan-invariants.test.ts`
  (extend)

**Interfaces:**
- Consumes: `loanSignedDelta` (Task 1), `DebtPoint.lentCents` (declared by Task 1, filled in here).
- Produces: no signature change. `debtOverTime(months, opts)` still takes **no viewer** — the page
  gates it (`reports/page.tsx:152`), and `tests/ops/visibility-invariants.test.ts` fails if that
  ever changes.

**Ruling P5 is the design constraint:** the two SQL queries stay **byte-identical**. The per-month
`case when amount_cents < 0 …` sum already computes the undo delta *for an owed loan*, and a lent
loan's undo delta is exactly its negation — so the flip happens in the in-memory fold, never in SQL.
That is what makes "existing owed loans behave identically" structural rather than a claim,
including the documented clamp drift the docblock at `:1077-1093` pins.

- [ ] **Step 1: Write the failing tests.**

Append to `tests/lib/loans/debt-over-time.test.ts`:

```ts
describe('debtOverTime splits the two directions (rulings P5, P6)', () => {
  it('an owed loan reconstructs exactly as before and contributes nothing to lentCents', () => {
    // The byte-identical proof. seedLoan() with no `direction` does not name loan_direction in
    // its INSERT at all, so this row is shaped exactly like every pre-1.14.0 row on disk.
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000, { date: '2026-08-05' });
    assignTransactionToLoan({ txnId: payment, itemId });

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([200_000, 200_000, 150_000]);
    expect(points.map((p) => p.lentCents)).toEqual([null, null, null]);
  });

  it('a lent loan is excluded from owedCents and reconstructed as its own series', () => {
    const ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 50_000, direction: 'lent' });
    // A repayment in the current month: walking BACKWARDS, it is added back on.
    const repayment = ctx.spend('E TRANSFER', 20_000, { date: '2026-08-05' });
    assignTransactionToLoan({ txnId: repayment, itemId });

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([null, null, null]);
    expect(points.map((p) => p.lentCents)).toEqual([50_000, 50_000, 30_000]);
  });

  it('the two series are computed independently: one unknown lent loan does not break the debt line', () => {
    const ctx = setupLoanTest();
    ctx.seedLoan({ name: 'Civic', balanceCents: 200_000 });
    // Anchored in the FUTURE relative to the earlier months, which is what makes it unknown there.
    ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 50_000, direction: 'lent' });
    ctx.anchorBalanceAt('Loan to a friend', '2026-08-10T00:00:00.000Z');

    const points = debtOverTime(3, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points.map((p) => p.owedCents)).toEqual([200_000, 200_000, 200_000]);
    expect(points.map((p) => p.lentCents)).toEqual([null, null, 50_000]);
  });

  it('a household with no loans at all still returns both series as null', () => {
    setupLoanTest();
    const points = debtOverTime(2, { endMonth: '2026-08', today: '2026-08-18' });
    expect(points).toEqual([
      { month: '2026-07', owedCents: null, lentCents: null },
      { month: '2026-08', owedCents: null, lentCents: null },
    ]);
  });
});
```

The third test needs a way to move one item's `balance_updated_at`. If this file already has such a
helper, use it; otherwise write the `update warranty_items set balance_updated_at = ? where name = ?`
one-liner **inside this test file** (not in `fixtures.ts`, which lane A shares across four suites)
and name it `anchorBalanceAt`.

Append to `tests/ops/loan-invariants.test.ts`:

```ts
describe('ruling P4: one helper owns the sign flip', () => {
  it('src/lib/loans.ts never spells the direction value itself', () => {
    // Every sign decision goes through loanSignedDelta/isLoanRepayment (src/lib/warranty/
    // constants.ts), and every partition tests === 'owed'. A literal 'lent' in this file is a
    // second place the convention lives, which is how the two drift apart.
    const offenders = read('src/lib/loans.ts')
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => /'lent'|"lent"/.test(entry.line));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/lib/loans/debt-over-time.test.ts tests/ops/loan-invariants.test.ts --reporter=dot
```
Expected: `lentCents` is `null` everywhere (Task 1's placeholder) and `owedCents` still includes the
lent loan.

- [ ] **Step 3: Split the fold.**

`debtOverTime`. The `loans` select gains `direction: warrantyItems.loanDirection`. The two SQL
queries are otherwise **unchanged** (P5). The fold becomes two accumulators over the same month
axis:

```ts
  return keys.map((month) => {
    const end = monthEnd(month);
    // v1.14.0 (spec BU, ruling P6): two independent reconstructions over one month axis. A loan
    // contributes to exactly one of them, and one series going unknown must never break the
    // other -- so `unknown` is tracked per series rather than returned early as it was before.
    let owedTotal: number | null = null;
    let lentTotal: number | null = null;
    for (const loan of loans) {
      const owedSide = loan.direction === 'owed';
      if (end < loan.createdAt.slice(0, 10)) continue;
      if (loan.balanceCents === null || loan.anchorAt === null) continue;
      if (end < loan.anchorAt.slice(0, 10)) { /* mark THIS series unknown and continue */ }
      let balance = loan.balanceCents;
      for (const [paymentMonth, cents] of byItem.get(loan.itemId) ?? []) {
        // The SQL sum is the undo delta in the ACCOUNT's frame; loanSignedDelta re-expresses
        // it in the loan's. For 'owed' it is the identity, which is why the query above did
        // not have to change (ruling P5).
        if (paymentMonth > month) balance += loanSignedDelta(loan.direction, cents);
      }
      /* add `balance` onto the matching accumulator */
    }
    return { month, owedCents: owedTotal, lentCents: lentTotal };
  });
```

Two structural notes you must honour, because the old code took a shortcut the two-series version
cannot:

1. The old `if (end < loan.anchorAt.slice(0, 10)) return { month, owedCents: null };` returned from
   the whole month. Now it must mark **only that loan's series** unknown and keep folding, or one
   unknown lent loan silently breaks the household-debt line (the third test above pins this).
2. The old code started `total = 0` and returned `0` for a month with no contributing loan. Keep
   that meaning **per series**: a series with at least one contributing loan sums them; a series
   with none is `null`, matching today's `loans.length === 0` early return. `null` breaks the line,
   `0` draws it at zero, and those are different claims.

Also update the early `if (loans.length === 0)` return to `{ month, owedCents: null, lentCents: null }`
(Task 1 already put `lentCents: null` there — confirm it, do not duplicate it), and extend the
MUST-15.7 docblock with one paragraph naming the second series and citing P5/P6.

- [ ] **Step 4: Run the tests.**

```
npx vitest run tests/lib/loans tests/ops/loan-invariants.test.ts tests/lib/networth.test.ts --reporter=dot
npx tsc --noEmit
```
`tests/lib/networth.test.ts` is run (not edited) to prove ruling P6 landed as designed: net worth's
debt line now excludes lent loans because `loansTotalOwedCents` does, with no edit to
`src/lib/networth.ts`. **If a networth test fails, stop and report it** — that would mean P6's
premise is wrong.

- [ ] **Step 5: Commit.**

```
git status --short
git add src/lib/loans.ts tests/lib/loans/debt-over-time.test.ts tests/ops/loan-invariants.test.ts && git commit -m "feat(loans): reconstruct lent loans as their own debt-report series"
```

---

# Lane B — the read surfaces

Owns the dashboard card, the reports wiring and the chart. Never opens `src/lib/loans.ts` — it
`import type`s `LoanSummary` and `DebtPoint` and nothing else (`tests/ops/client-bundle.test.ts`).

### Task 4: the "Who owes us" card

**Files:**
- Create: `src/components/WhoOwesUsCard.tsx`, `tests/components/who-owes-us-card.test.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx` (`:94-101` the loans read, `:277` the card row,
  `:160-175` the PageGuide)
- Test: `tests/app/dashboard.test.tsx` (extend), `tests/app/loans-card.test.tsx` (fixture field only)

**Interfaces:**
- Consumes: `LoanSummary.loanDirection` (Task 1), `isSelfScoped` (`src/lib/auth/viewer.ts:25`),
  `listLoans(today, viewer)` — **unchanged signature**.
- Produces: `export function WhoOwesUsCard({ loans, totalLentCents, selfScoped }: { loans: LoanSummary[]; totalLentCents: number; selfScoped: boolean })`.

No new viewer-taking library function, so `tests/ops/visibility-invariants.test.ts` is **not
edited** (ruling P11: a self viewer's rows are already scoped by `listLoans`, and the total is
derived from those rows, so no household figure is ever computed and discarded).

- [ ] **Step 1: Write the failing tests.**

New file `tests/components/who-owes-us-card.test.tsx`, modelled on `tests/app/loans-card.test.tsx`
(same `// @vitest-environment jsdom` header, same `afterEach(cleanup)`, same literal fixture style):

```tsx
describe('WhoOwesUsCard (spec BU, ruling P11)', () => {
  it('renders nothing when no lent loan has a balance above zero', () => {
    const { container } = render(<WhoOwesUsCard loans={[]} totalLentCents={0} selfScoped={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every lent loan has been repaid', () => {
    // Stricter than LoansCard's "has a balance OR a principal": a fully repaid loan should stop
    // asking to be chased, which is what BU means by "hides at zero".
    const { container } = render(
      <WhoOwesUsCard loans={[lent({ currentBalanceCents: 0 })]} totalLentCents={0} selfScoped={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists each borrower row and the total, household wording', () => {
    render(
      <WhoOwesUsCard
        loans={[lent({ name: 'Loan to a friend', currentBalanceCents: 50_000 })]}
        totalLentCents={50_000}
        selfScoped={false}
      />,
    );
    expect(screen.getByText('Who owes us')).toBeTruthy();
    expect(screen.getByText('Loan to a friend')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
  });

  it('a self viewer gets their own wording and no household claim', () => {
    render(
      <WhoOwesUsCard
        loans={[lent({ name: 'Loan to a friend', currentBalanceCents: 50_000 })]}
        totalLentCents={50_000}
        selfScoped
      />,
    );
    expect(screen.getByText('Owed to you')).toBeTruthy();
    expect(screen.queryByText('Who owes us')).toBeNull();
    // The copy must not imply a household total to a child (Global Constraints, ruling P11).
    expect(document.body.textContent).not.toMatch(/household/i);
  });
});
```

`lent(over)` is a local helper in this file returning a full `LoanSummary` with
`loanDirection: 'lent'`. Do not import a fixture from another test file.

Append to `tests/app/dashboard.test.tsx`, in the style that file already uses for the Loans card:

```tsx
it('partitions loans: owed to the Loans card, lent to the "Who owes us" card', async () => {
  // …seed one owed loan with a balance and one lent loan with a balance, render the page as a
  // household admin, then assert BOTH cards render and neither total includes the other's rows.
});

it('a self viewer sees "Owed to you" but never the Loans card (ruling R2 + P11)', async () => {
  // …seed a lent loan owned by the self viewer and an owed loan owned by someone else; assert
  // the self viewer's page shows the lent card, does not show the Loans card, and does not show
  // the other person's loan at all.
});
```

Write those two out fully against the seeding helpers `tests/app/dashboard.test.tsx` already has —
read the file first and reuse its `vi.mock('@/lib/auth/session', …)` viewer switch rather than
inventing a second one.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/components/who-owes-us-card.test.tsx tests/app/dashboard.test.tsx --reporter=dot
```
Expected: the component does not exist; the dashboard renders one card.

- [ ] **Step 3: Fix `tests/app/loans-card.test.tsx`.**

Task 1 made `loanDirection` required on `LoanSummary`, so every literal fixture in that file needs
`loanDirection: 'owed',`. That is the whole change to it — no new assertion belongs there
(`LoansCard` is fed only owed rows now, and the card itself is unchanged).

- [ ] **Step 4: Write the card.**

`src/components/WhoOwesUsCard.tsx`, a **server component** (no `'use client'`), built from
`LoansCard`'s skeleton: `Card` / `CardHeader` with a `money-lg` total in the `action` slot / a
`<ul className="border-t border-line text-sm">` of rows. Import `formatCents` from `@/lib/money` and
`import type { LoanSummary } from '@/lib/loans'` (**type-only**).

- Self-hide: `const shown = loans.filter((loan) => (loan.currentBalanceCents ?? 0) > 0); if (shown.length === 0) return null;`
- Copy, exactly: `selfScoped` → title **"Owed to you"**, description *"Money you have lent and not
  been repaid."*; otherwise title **"Who owes us"**, description *"Money the household has lent and
  not been repaid."*
- Rows: the item's name and its outstanding balance. **No owner name and no borrower name**
  (ruling P7 — the item's name is the borrower). No progress bar, no rate, no projection: a lent
  loan has no payoff month (ruling P9) and a progress bar reading "fraction repaid" belongs on the
  item's own page, not on a chase-list card.
- A docblock stating the self-hide rule, the two wordings and why this card is NOT behind the
  `selfScoped ? null :` gate the Loans card carries.

- [ ] **Step 5: Wire the dashboard.**

`src/app/(app)/dashboard/page.tsx`, replacing the loans block at `:94-101` (keep the existing
comment about not re-reading the model — it is still the reason there is one `listLoans` call):

```tsx
  const loans = listLoans(today, viewer);
  // v1.14.0 (spec BU): one scan, partitioned. LoansCard's "What the household still owes" is now
  // true rather than accidentally true, and the lent rows are a different question entirely.
  const owedLoans = loans.filter((loan) => loan.loanDirection === 'owed');
  const lentLoans = loans.filter((loan) => loan.loanDirection !== 'owed');
  const totalOwedCents = owedLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
  const totalLentCents = lentLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
```

Feed `LoansCard` `owedLoans` (`:277`, gate unchanged), and render directly under it:

```tsx
      {/* v1.14.0: NOT behind selfScoped -- ruling R2 hides household balances from a child, and
          every row here is a row that child owns (listLoans has already scoped them). */}
      <WhoOwesUsCard loans={lentLoans} totalLentCents={totalLentCents} selfScoped={selfScoped} />
```

The `PageGuide`'s second paragraph currently says "Loans, net worth and upcoming bills stay
household-wide whichever pill is chosen". Add a clause naming the second card, so the guide does not
describe a page with one loan card when there are two.

- [ ] **Step 6: Run the tests and `tsc`.**

```
npx vitest run tests/components/who-owes-us-card.test.tsx tests/app/dashboard.test.tsx tests/app/loans-card.test.tsx tests/ops/client-bundle.test.ts tests/ops/onboarding-coverage.test.ts tests/ops/visibility-invariants.test.ts --reporter=dot
npx tsc --noEmit
```

- [ ] **Step 7: Commit.**

```
git status --short
git add src/components/WhoOwesUsCard.tsx src/app/\(app\)/dashboard/page.tsx tests/components/who-owes-us-card.test.tsx tests/app/dashboard.test.tsx tests/app/loans-card.test.tsx && git commit -m "feat(dashboard): a \"Who owes us\" card for money lent out"
```

### Task 5: the debt report plots the two series separately

**Files:**
- Modify: `src/app/(app)/reports/page.tsx` (`:152-153`),
  `src/app/(app)/reports/reports-client.tsx` (the props type ~`:80`, the debt card `:627-660`),
  `src/components/charts/DebtTrendChart.tsx`
- Test: `tests/app/reports-client.test.tsx` (extend), `tests/app/reports.test.tsx` (extend)

**Interfaces:**
- Consumes: `DebtPoint.lentCents` (Task 1 declares it, Task 3 fills it),
  `LoanSummary.loanDirection` (Task 1).
- Produces: `DebtTrendChart({ data, showLent }: { data: DebtPoint[]; showLent: boolean })`;
  `ReportsClient` gains a `hasLent: boolean` prop beside `hasLoans`.

**Ruling P12 is the design constraint:** `hasLoans` keeps its exact meaning (any loan with a tracked
balance, either direction), so the card's visibility does not change for any existing install. A
second line and a `<Legend>` appear only when a lent loan has a balance — a legend over one line is
noise.

- [ ] **Step 1: Write the failing tests.**

Append to `tests/app/reports-client.test.tsx`. Note the file's existing `ResizeObserverStub` at the
top — recharts' `ResponsiveContainer` needs it in jsdom, and it is already installed, so a test that
renders the debt chart with data works without adding anything.

```tsx
describe('ReportsClient — the debt card carries both series (rulings P12, P14)', () => {
  const twoSeries = [
    { month: '2026-06', owedCents: 200_000, lentCents: 50_000 },
    { month: '2026-07', owedCents: 190_000, lentCents: 50_000 },
    { month: '2026-08', owedCents: 180_000, lentCents: 30_000 },
  ];

  it('names both lines in the card description when a lent loan has a balance', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} debt={twoSeries} hasLoans hasLent />,
    );
    expect(container.textContent).toContain('what it has lent out');
  });

  it('says nothing about lending when the household has lent nothing', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        debt={twoSeries.map((p) => ({ ...p, lentCents: null }))}
        hasLoans
        hasLent={false}
      />,
    );
    expect(container.textContent).not.toContain('lent out');
  });

  it('the card is still hidden from a self viewer, whichever series exist (ruling R2)', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} debt={twoSeries} hasLoans hasLent showHouseholdTotals={false} />,
    );
    expect(container.textContent).not.toContain('Debt over time');
  });

  it('the empty state is still driven by the OWED series alone', () => {
    // A household with one lent loan and no debt history has nothing to draw on the debt line,
    // and that is what the "Not enough history yet" state is about -- ruling P12 keeps the gate.
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        debt={twoSeries.map((p) => ({ ...p, owedCents: null }))}
        hasLoans
        hasLent
      />,
    );
    expect(container.textContent).toContain('Not enough history yet');
  });
});
```

Add `hasLent: false` to `baseProps()` in that file while you are there.

Append to `tests/app/reports.test.tsx` (the page test) a case proving `hasLoans` and `hasLent` come
from ONE `listLoans` call and that `hasLoans` did not change meaning: seed one owed loan with a
balance and one lent loan with a balance, and assert both flags are true; then seed only a lent
loan, and assert `hasLoans` is **still true** (P12: any loan with a tracked balance) while a
household with no loans at all gets both false. Write it against that file's existing page-render
helper.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/app/reports-client.test.tsx tests/app/reports.test.tsx --reporter=dot
```

- [ ] **Step 3: Compute both flags from one read.**

`src/app/(app)/reports/page.tsx`. Replace the inline `listLoans` at `:153` with one call above the
`<ReportsClient>` element:

```tsx
  // v1.14.0 (ruling P12): ONE read, two flags. hasLoans keeps its exact meaning -- any loan with
  // a tracked balance, either direction -- so the card's visibility does not change for any
  // existing install; hasLent decides only whether a second LINE and a legend appear.
  const loansForFlags = showHouseholdTotals ? listLoans(today, viewer) : [];
  const hasLoans = loansForFlags.some((loan) => loan.currentBalanceCents !== null);
  const hasLent = loansForFlags.some((loan) => loan.loanDirection !== 'owed' && loan.currentBalanceCents !== null);
```

`debt={showHouseholdTotals ? debtOverTime(24) : []}` is unchanged — a lent series is still a
household figure on this page, and the dashboard card is where a self viewer sees their own
(ruling P11). `debtOverTime` gains no viewer.

- [ ] **Step 4: Pass it through the client.**

`reports-client.tsx`: add `hasLent: boolean` to the props type beside `hasLoans`, destructure it,
widen the card description to *"What the household owes, and what it has lent out, as separate
lines."* when `hasLent` (keep today's *"Total owed across every loan with a balance."* otherwise),
and pass `showLent={hasLent}` to `<DebtTrendChart>`. The `!showHouseholdTotals || !hasLoans` gate and
the `debt.filter((point) => point.owedCents !== null).length < 2` empty-state gate are **unchanged**
(P12) — keep both comments.

- [ ] **Step 5: Add the second line.**

`src/components/charts/DebtTrendChart.tsx`. Copy `NetWorthChart`'s multi-series skeleton:

```tsx
export function DebtTrendChart({ data, showLent }: { data: DebtPoint[]; showLent: boolean }) {
  const series = data.map((point) => ({
    month: point.month,
    Owed: point.owedCents === null ? null : point.owedCents / 100,
    Lent: point.lentCents === null ? null : point.lentCents / 100,
  }));
```

The existing `Owed` line (`var(--negative-solid)`, `connectNulls={false}`, its dot marker) is
**untouched**. Add, only when `showLent`, a `Lent` line in `var(--positive-solid)` with the same
`strokeWidth`, the same dot treatment and `connectNulls={false}`, plus
`<Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)', paddingTop: 8 }} />`. Extend the
component's docblock: the second series is money owed TO the household, which is why it is the
positive token, and the legend exists only because there are now two lines to tell apart.

- [ ] **Step 6: Run the tests and `tsc`.**

```
npx vitest run tests/app/reports-client.test.tsx tests/app/reports.test.tsx tests/ops/client-bundle.test.ts tests/ops/visibility-invariants.test.ts --reporter=dot
npx tsc --noEmit
```

- [ ] **Step 7: Commit.**

```
git status --short
git add src/app/\(app\)/reports/page.tsx src/app/\(app\)/reports/reports-client.tsx src/components/charts/DebtTrendChart.tsx tests/app/reports-client.test.tsx tests/app/reports.test.tsx && git commit -m "feat(reports): plot lent loans as their own line on the debt report"
```

---

# Lane C — the write surfaces and the docs

### Task 6: a Direction control on both item forms, a Direction row on the detail

**Files:**
- Modify: `src/app/(app)/warranties/new/new-warranty-client.tsx` (the `loanApplicable` block,
  `:370` ff), `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (the detail `<dl>` at
  `:450` ff and `EditForm`'s `loanApplicable` block at `:963` ff),
  `src/app/(app)/warranties/actions.ts` (`readItemInput`, `:256` ff),
  `src/app/(app)/transactions/transactions-client.tsx` (`:637`, one string)
- Test: `tests/app/new-warranty-client.test.tsx`, `tests/app/warranty-detail-client.test.tsx`,
  `tests/app/warranties-actions.test.ts`, `tests/app/transactions-client.test.tsx` (all extend)

**Interfaces:**
- Consumes: `LOAN_DIRECTIONS`, `LOAN_DIRECTION_LABELS`, `isLoanDirection`, `LoanDirection` from
  `@/lib/warranty/constants` (Task 1); `WarrantyInput.loanDirection` and
  `WarrantyItemRow.loanDirection` (Task 1); `loanFieldsAllowedForKind` — **the gate**, reused, not
  duplicated (ruling P16).
- Produces: a module-private `readLoanDirection(formData: FormData): LoanDirection` in
  `actions.ts`. **No new export** from that `'use server'` file
  (`tests/ops/use-server-exports.test.ts`).

- [ ] **Step 1: Write the failing tests.**

Append to `tests/app/new-warranty-client.test.tsx` and, with the same three cases, to
`tests/app/warranty-detail-client.test.tsx` (against `EditForm`):

```tsx
describe('the Direction control (spec BU, ruling P16)', () => {
  it('is absent for a kind that is not a loan', () => {
    render(<NewWarrantyClient {...baseProps()} />);   // default type kind: warranty
    expect(screen.queryByLabelText('Direction')).toBeNull();
  });

  it('offers exactly the two directions for a loan, defaulting to "We owe this"', () => {
    renderWithKind('loan');
    const select = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['We owe this', 'Owed to us']);
    expect(select.value).toBe('owed');
    // There is no "Not set": the column is NOT NULL and 'owed' is its default (ruling P1).
    expect([...select.options].map((option) => option.value)).toEqual(['owed', 'lent']);
  });

  it('posts under the name the action reads', () => {
    renderWithKind('loan');
    expect((screen.getByLabelText('Direction') as HTMLSelectElement).name).toBe('loanDirection');
  });
});
```

Append to `tests/app/warranty-detail-client.test.tsx`:

```tsx
it('shows a Direction row for a loan and reads it back in words', () => {
  render(<WarrantyDetailClient {...baseProps({ kind: 'loan', loanDirection: 'lent' })} />);
  expect(screen.getByText('Direction')).toBeTruthy();
  expect(screen.getByText('Owed to us')).toBeTruthy();
});

it('hides the Direction row for a non-loan item that carries the default', () => {
  render(<WarrantyDetailClient {...baseProps({ kind: 'warranty', loanDirection: 'owed' })} />);
  expect(screen.queryByText('Direction')).toBeNull();
});
```

Append to `tests/app/warranties-actions.test.ts`:

```ts
it('an empty loanDirection field means owed (the same shape readBillingCycle has)', async () => {
  // An old cached page, or a form this app did not render, posts nothing at all -- that must
  // mean the default, not a refusal.
  const form = itemFormData({ loanDirection: '' });
  await createItemAction(form);
  expect(latestItem().loanDirection).toBe('owed');
});

it('stores lent when the form says so', async () => {
  await createItemAction(itemFormData({ typeId: loanTypeId, loanDirection: 'lent' }));
  expect(latestItem().loanDirection).toBe('lent');
});

it('refuses a value that is neither', async () => {
  const result = await createItemAction(itemFormData({ typeId: loanTypeId, loanDirection: 'given' }));
  expect(result?.error).toMatch(/direction/i);
});
```

Append to `tests/app/transactions-client.test.tsx`:

```tsx
it('the unassign confirm is direction-neutral (ruling P15)', () => {
  // "moves back up" was only ever true for a loan the household owes. Rather than plumb a
  // direction through LoanLink and loanLinksForTransactions for one sentence, the sentence says
  // what is true in both frames.
  const { container } = render(
    <TransactionsClient {...baseProps({ loanLinks: [{ txnId: 1, itemId: 9, itemName: 'Loan to a friend' }] })} />,
  );
  // This file already reads confirm copy off the rendered row somewhere -- reuse that query
  // rather than inventing a second one. `container.textContent` is the fallback if the confirm
  // string is rendered inline.
  expect(container.textContent).toContain('moves back to what it was');
  expect(container.textContent).not.toContain('moves back up');
});
```

Read each file's existing helpers before writing these — every `baseProps`, `renderWithKind`,
`itemFormData` and `latestItem` above must be that file's real helper (or a small local one in its
established style), not a new convention.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/warranties-actions.test.ts tests/app/transactions-client.test.tsx --reporter=dot
```

- [ ] **Step 3: Add the control to both forms.**

Inside each file's existing `loanApplicable` block (ruling P16 — reuse that gate, do not add a
second `kind === 'loan'` predicate), as the FIRST field in the block, so a reader picks the
direction before typing amounts. A plain `<select>` in a `<Field>`, copying the billing-cycle select
in the same file verbatim — **not** `AutoSaveSelect`:

```tsx
<Field label="Direction" hint="Which way this loan points.">
  <select
    name="loanDirection"
    value={loanDirection}
    onChange={(event) => setLoanDirection(event.target.value)}
    className={selectClass}
  >
    {LOAN_DIRECTIONS.map((direction) => (
      <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
    ))}
  </select>
</Field>
```

`selectClass` already carries the 44px target — do not hand-roll classes. Add
`const [loanDirection, setLoanDirection] = useState('owed')` (the edit form seeds it from
`item.loanDirection`), and reset it to `'owed'` in the SAME `useEffect` that already nulls the loan
money fields when `loanApplicable` goes false (`new-warranty-client.tsx:144-149`,
`warranty-detail-client.tsx:860-865`).

- [ ] **Step 4: Read it in the action.**

`src/app/(app)/warranties/actions.ts`, beside `readBillingCycle` (`:138`) and following its shape
exactly:

```ts
/** v1.14.0 (spec BU). Same shape as readBillingCycle above: '' means "no seed" -> the default. */
function readLoanDirection(formData: FormData): LoanDirection {
  const raw = String(formData.get('loanDirection') ?? '').trim();
  if (raw === '') return 'owed';
  if (!isLoanDirection(raw)) throw new Error('Direction must be "We owe this" or "Owed to us".');
  return raw;
}
```

`readItemInput` (`:283`, beside `billingCycle`) gains `loanDirection: readLoanDirection(formData),`.
Do **not** export it.

- [ ] **Step 5: Add the detail row.**

`warranty-detail-client.tsx`, inside the loan money block's `<dl>` (`:450` ff), following that
block's own rule — *show when the kind's gate allows it OR a value is stored*:

```tsx
{!loanFieldsAllowedForKind(item.kind) && item.loanDirection === 'owed' ? null : (
  <Detail label="Direction">{LOAN_DIRECTION_LABELS[item.loanDirection]}</Detail>
)}
```

Leave the block's "Removing an old payment can push the balance above your latest statement figure."
hint as written: it is true in both directions, and rewording it per direction is more churn than
the sentence is worth.

- [ ] **Step 6: Neutralise the unassign confirm (ruling P15).**

`src/app/(app)/transactions/transactions-client.tsx:637`:

```tsx
confirm={`Unassign this transaction from ${link.itemName}? That loan's balance moves back to what it was.`}
```

That is the whole change to that file. Do not plumb a direction through `LoanLink`.

- [ ] **Step 7: Run the tests and `tsc`.**

```
npx vitest run tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/warranties-actions.test.ts tests/app/transactions-client.test.tsx tests/ops/row-controls.test.ts tests/ops/use-server-exports.test.ts tests/ops/client-bundle.test.ts --reporter=dot
npx tsc --noEmit
```

- [ ] **Step 8: Commit.**

```
git status --short
git add src/app/\(app\)/warranties/new/new-warranty-client.tsx src/app/\(app\)/warranties/\[id\]/warranty-detail-client.tsx src/app/\(app\)/warranties/actions.ts src/app/\(app\)/transactions/transactions-client.tsx tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx tests/app/warranties-actions.test.ts tests/app/transactions-client.test.tsx && git commit -m "feat(warranties): choose which way a loan points"
```

### Task 7: the help paragraph and the 1.14.0 release notes

**Files:**
- Modify: `src/app/(app)/help/content.tsx` (the `coverage` section, after the loan paragraph at
  `:348-353` and before the `bill` paragraph), `CHANGELOG.md`
- Test: `tests/app/help.test.tsx` (extend)

**Interfaces:** consumes nothing, produces nothing. Prose only.

**`INSTALL.md` is deliberately NOT edited** (ruling P13): that file has no per-migration and no
per-version section — grep for `0013`, `0012` and `Before updating` returns nothing in it. The
CHANGELOG's "Before updating" paragraph is this repo's only migration-note convention.

- [ ] **Step 1: Write the failing test.**

Append to `tests/app/help.test.tsx`, in that file's existing style:

```tsx
it('explains that a loan can point either way (spec BU)', () => {
  const text = renderHelpText();   // the file's existing whole-page text helper
  expect(text).toContain('A loan can point either way');
  expect(text).toContain('We owe this');
  expect(text).toContain('Owed to us');
  // Rulings A1/A2 for this file: mechanics only. No figures, no advice.
  expect(text).not.toMatch(/you should|we recommend/i);
});
```

- [ ] **Step 2: Run it and watch it fail.**

```
npx vitest run tests/app/help.test.tsx --reporter=dot
```

- [ ] **Step 3: Write the paragraph.**

One `<P>` in the `coverage` section, immediately after the existing loan paragraph. Plain mechanics,
no figures, no advice, `<B>` for the two control labels exactly as they appear on the form:

> A loan can point either way. **We owe this** is the usual one — money leaving the account pays it
> down. **Owed to us** is for money you lent someone: money leaving the account adds to what they
> owe you, and money coming back takes it off again. Loans you lent out are kept out of the debt
> figures and get their own card on the Dashboard and their own line on the debt report.

- [ ] **Step 4: Write the CHANGELOG entry.**

A new `## [1.14.0] - 2026-08-28` section directly under `## Unreleased`. **This release has a
migration, so the "Before updating" block is mandatory** — copy v1.13.0's wording
(`CHANGELOG.md:141` ff) and re-point it at 1.13.3: the backup paragraph (Settings → Backups →
Download backup now, and why a file copy off a WAL-mode database is not a backup), **Stop the old
container before starting the new one**, **The migration is all-or-nothing** (one transaction, an
interrupted update leaves your v1.13.3 database exactly as it was), and **To roll back** (restore
that backup, then run the v1.13.3 image). Say plainly that the change is one added column on
`warranty_items` and that nothing is rebuilt or dropped.

Groups, in Keep a Changelog order:

- **Added** — the Direction control on the loan forms (**We owe this** / **Owed to us**, with the
  sign rule stated in one sentence); the **Who owes us** card on the Dashboard, which hides itself
  when nobody owes you anything and, for a member who only sees their own records, is titled **Owed
  to you** and lists only their own; the second line on the Reports debt chart.
- **Changed** — money you have lent out no longer counts toward the household debt total or the
  debt side of net worth. Say this outright: someone whose net worth figure moves after the update
  is entitled to know why, and it is the one number this release changes without being asked.
- **Fixed** — one bullet for the review-page work landing in this same release from another agent,
  worded from the reader's side:
  > **Review page:** the per-row category select and the "apply to all matching + create rule"
  > select now carry visible labels and a hint, and a row title that repeated the merchant name is
  > collapsed to one.

Every existing loan keeps its meaning — say that too, in the Added block's first bullet.

- [ ] **Step 5: Run the tests.**

```
npx vitest run tests/app/help.test.tsx tests/ops/onboarding-coverage.test.ts tests/app/about-panel.test.tsx --reporter=dot
```
`tests/app/about-panel.test.tsx` renders the changelog and is run (not edited) to prove the new
section parses.

- [ ] **Step 6: Commit.**

```
git status --short
git add src/app/\(app\)/help/content.tsx CHANGELOG.md tests/app/help.test.tsx && git commit -m "docs: explain loan direction in Help and record 1.14.0"
```

---

# Release

### Task 8: v1.14.0

Runs **alone, after all three lanes report done**. First command in this task is
`git status --short`: it must show a clean tree apart from the review-page agent's own files. If any
file this plan owns is still modified, a lane did not commit — stop and report it.

**Files:**
- Modify: `package.json`, `tests/ops/docker.test.ts`, `docs/PENDING-FIXES.md`

- [ ] **Step 1: Bump the version.**

`package.json` → `"version": "1.14.0"`.

- [ ] **Step 2: Add the release block and demote the last one.**

`tests/ops/docker.test.ts`, following the file's own append-only pattern exactly. Insert the new
block ABOVE the current head, and rewrite the 1.13.3 block's title and version assertion:

```ts
  it('MUST-7.1: the 1.14.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.14.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.14\.0\] - 2026-08-28$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.14.0]'));
    expect(changelog.indexOf('## [1.14.0]')).toBeLessThan(changelog.indexOf('## [1.13.3]'));
    const entry = changelog.slice(changelog.indexOf('## [1.14.0]'), changelog.indexOf('## [1.13.3]'));
    expect(entry).toMatch(/### Added/);
    expect(entry).toMatch(/### Changed/);
    expect(entry).toMatch(/### Fixed/);
    // Unlike the last three releases, this one DOES change the schema. A reader coming from
    // 1.13.3 must be told to take a backup, and must not find the "no migration" line here.
    expect(entry).not.toMatch(/no migration/i);
    expect(entry).toMatch(/Before updating/);
    expect(entry).toMatch(/all-or-nothing/i);
    expect(entry).toMatch(/roll back/i);
    // The headline claims, asserted as claims and not just as a version number.
    expect(entry).toMatch(/Owed to us/);
    expect(entry).toMatch(/Who owes us/);
    expect(entry).toMatch(/net worth/i);
    expect(entry).toMatch(/Review page/);
  });

  it('MUST-7.1: the 1.13.3 release is still recorded intact (append-only discipline)', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).not.toBe('1.13.3');
    // …the rest of the existing block, unchanged, with its slice end still '## [1.13.2]'
  });
```

- [ ] **Step 3: Close item BU.**

`docs/PENDING-FIXES.md`: item **BU**'s heading gains `— SHIPPED in v1.14.0` and a `Status:` line
naming this spec, in the exact form every shipped item above it uses.

- [ ] **Step 4: The full gate.**

```
npx tsc --noEmit
npx vitest run
```
Both must pass (read the pass/fail counts, not vitest's exit code). If anything outside this plan's
files fails, report it — do not fix another agent's file.

- [ ] **Step 5: Commit. No tag and no push.**

```
git status --short
git add package.json tests/ops/docker.test.ts docs/PENDING-FIXES.md && git commit -m "chore(release): v1.14.0"
```

---

## Self-review — disjointness, verified path by path

Every path this plan writes, and the single task that owns it. A path appearing twice in the
concurrent phase would be a bug in this plan.

| Path | Owner | Concurrent with |
|---|---|---|
| `drizzle/0014_loan_direction.sql` (new) | T1 | nothing (T1 runs alone) |
| `drizzle/meta/_journal.json` | T1 | nothing |
| `src/db/schema.ts` | T1 | nothing |
| `src/lib/warranty/constants.ts` | T1 | nothing |
| `src/lib/warranty/items.ts` | T1 | nothing |
| `src/lib/warranty/types.ts` | T1 | nothing |
| `src/lib/loans.ts` | T1 (2 type lines), then lane A (T2, T3) | lanes B and C — **neither opens it** |
| `src/components/WhoOwesUsCard.tsx` (new) | T4 (lane B) | lanes A, C |
| `src/app/(app)/dashboard/page.tsx` | T4 (lane B) | lanes A, C |
| `src/app/(app)/reports/page.tsx` | T5 (lane B) | lanes A, C |
| `src/app/(app)/reports/reports-client.tsx` | T5 (lane B) | lanes A, C |
| `src/components/charts/DebtTrendChart.tsx` | T5 (lane B) | lanes A, C |
| `src/app/(app)/warranties/new/new-warranty-client.tsx` | T6 (lane C) | lanes A, B |
| `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` | T6 (lane C) | lanes A, B |
| `src/app/(app)/warranties/actions.ts` | T6 (lane C) | lanes A, B |
| `src/app/(app)/transactions/transactions-client.tsx` | T6 (lane C) | lanes A, B |
| `src/app/(app)/help/content.tsx` | T7 (lane C) | lanes A, B |
| `CHANGELOG.md` | T7 (lane C) | lanes A, B |
| `tests/db/migration-0014.test.ts` (new) | T1 | nothing |
| `tests/lib/warranty/constants.test.ts` · `items.test.ts` · `types.test.ts` | T1 | nothing |
| `tests/lib/loans/fixtures.ts` · `manual-assign` · `reversal` · `payment-matchers` · `backfill` · `summary` · `debt-over-time` | lane A | lanes B, C |
| `tests/ops/loan-invariants.test.ts` | T3 (lane A) | lanes B, C |
| `tests/components/who-owes-us-card.test.tsx` (new) · `tests/app/dashboard.test.tsx` · `tests/app/loans-card.test.tsx` · `tests/app/reports-client.test.tsx` · `tests/app/reports.test.tsx` | lane B | lanes A, C |
| `tests/app/new-warranty-client.test.tsx` · `warranty-detail-client.test.tsx` · `warranties-actions.test.ts` · `transactions-client.test.tsx` · `help.test.tsx` | lane C | lanes A, B |
| `package.json` · `tests/ops/docker.test.ts` · `docs/PENDING-FIXES.md` | T8 | nothing (runs last, alone) |

**Files this plan reads but never writes:** `src/lib/networth.ts` (ruling P6 — it is correct
unedited), `tests/ops/visibility-invariants.test.ts` (no signature changes), `tests/db/loan-schema.test.ts`,
`tests/lib/loans/invariants.test.ts`, `tests/lib/loans/matcher.test.ts`, `INSTALL.md` (ruling P13),
`src/lib/import/commit.ts`, and — belonging to another agent entirely —
`src/app/(app)/review/review-client.tsx` and `tests/app/review-page.test.ts`.

## Definition of done

- `npx tsc --noEmit` clean and `npx vitest run` green, both run in Task 8.
- `drizzle/0014_loan_direction.sql` is the only migration, is additive, and its header carries
  inventory entry 40.
- An existing `owed` loan reconstructs to the same numbers it did in v1.13.3 — asserted by a test
  whose fixture does not name `loan_direction` at all (Task 3, step 1).
- `src/lib/loans.ts` contains no literal `'lent'` (ruling P4, pinned by Task 3's grep).
- A `self` viewer sees "Owed to you" over their own rows only, no household total, no Loans card,
  no debt chart.
- MUST-13.1 and MUST-13.2 hold: nothing accrues interest, no loan-linked row leaves its category or
  its budgets, and `transactions.amount_cents` is never written.
- No tag, no push.

---

## Addendum A — the ninth task

**Spec:** `docs/superpowers/specs/2026-08-28-loans-lent-direction-design.md`, **Addendum A**
(owner-confirmed 2026-08-28). Rulings **A1–A13** are cited by number below and are read alongside
P1–P16, which are unchanged.

**Ordering.** T9 runs **alone**, after lanes A, B and C have all reported done, and **before Task 8**
(the release commit) — it opens `src/lib/loans.ts` (lane A's file), `src/lib/warranty/constants.ts`
(T1's), and `src/app/(app)/transactions/transactions-client.tsx` (T6's), so it can only start once
each of those has been committed by its owner. Task 8's `git status --short` gate then covers T9's
files too.

**Already shipped, do not touch.** `81777b3` landed the help paragraph and the CHANGELOG bullet for
this feature. **T9 must not edit `src/app/(app)/help/content.tsx` or `CHANGELOG.md`** — the copy
there ("Assign to new loan…", "creates the loan right there and assigns that row as its first
entry") is the contract this task implements, not something it writes.

**Path ownership (extends the disjointness table above).**

| Path | Owner | Concurrent with |
|---|---|---|
| `src/lib/loans.ts` | T1, then lane A, **then T9** | nothing — T9 runs alone |
| `src/lib/warranty/constants.ts` | T1, **then T9** | nothing |
| `src/app/(app)/transactions/actions.ts` | **T9 only** | nothing |
| `src/app/(app)/transactions/transactions-client.tsx` | T6 (lane C), **then T9** | nothing |
| `tests/ops/visibility-invariants.test.ts` | **T9 only** (the plan above never writes it) | nothing |

### Task 9: create a loan straight from a transaction row

**Files:**
- Modify: `src/lib/warranty/constants.ts` (two error constants + `loanAssignedMessage`, beside
  `LOAN_DIRECTION_KIND_ERROR` at `:~350`), `src/lib/loans.ts` (one new exported writer, beside
  `assignTransactionToLoan` at `:679`), `src/app/(app)/transactions/actions.ts` (one new action,
  beside `assignToLoanAction` at `:362`, which also switches to the extracted message helper),
  `src/app/(app)/transactions/transactions-client.tsx` (one `RowMenuButton` in the loan block at
  `:645` ff, one state slot beside `noting` at `:104`, one sub-row beside the note sub-row at
  `:665` ff), `tests/ops/visibility-invariants.test.ts` (one `REQUIRE_VIEWER` entry + floor 27 → 28,
  ruling A12)
- Test: `tests/app/transactions-actions.test.ts`, `tests/app/transactions-client.test.tsx`,
  `tests/lib/warranty/constants.test.ts` (all extend)
- Read but never write: `src/lib/warranty/items.ts`, `src/lib/warranty/types.ts`,
  `src/lib/transactions.ts`, `src/lib/auth/viewer.ts`, `src/lib/audit.ts` (ruling A11 — no audit
  row), `src/app/(app)/help/content.tsx` and `CHANGELOG.md` (already shipped in `81777b3`)

**Interfaces:**

- Produces — `src/lib/warranty/constants.ts` (pure; its only new import is `@/lib/money`, which
  imports nothing at all, so `tests/ops/client-bundle.test.ts` is unaffected):

```ts
/** Addendum A, ruling A2. A loan you lent out cannot begin with money arriving. */
export const LOAN_LENT_FIRST_ENTRY_ERROR = 'A loan you lent out starts with money going out.';

/** Addendum A, ruling A7: the double-submit guard for the create-a-loan path only. */
export const LOAN_ALREADY_LINKED_ERROR = 'That transaction is already assigned to a loan.';

/**
 * Addendum A, ruling A8. The wording 3efb23f wrote inline in assignToLoanAction, extracted so the
 * create-a-loan path says the same sentences instead of a second copy of them (MUST-19.11).
 * `balanceAfterCents` is the item's balance READ BACK after the move: null means the balance is
 * unknown (never anchored), 0 means it is now zero.
 */
export function loanAssignedMessage(input: {
  direction: LoanDirection;
  appliedCents: number;
  balanceAfterCents: number | null;
}): string;
```

- Produces — `src/lib/loans.ts` (no literal `'lent'`, ruling P4):

```ts
export interface NewLoanFromTransaction {
  txnId: number;
  name: string;
  direction: LoanDirection;
  at?: Date;
}

export interface NewLoanResult {
  itemId: number;
  name: string;
  direction: LoanDirection;
  /** Unsigned, exactly as assignTransactionToLoan reports it. */
  appliedCents: number;
  /** The balance after the assign: |txn.amountCents| in every accepted case (ruling A3). */
  balanceAfterCents: number;
}

/**
 * Addendum A. Creates a loan item and assigns `txnId` as its first entry, in ONE db transaction
 * (ruling A4). Throws — never returns an error shape — so the action's existing catch surfaces
 * every refusal the same way assignToLoanAction already surfaces assignTransactionToLoan's.
 *
 * `viewer` is REQUIRED (ruling A12) and is the only source of the new item's owner_user_id
 * (ruling A10): a self viewer's own id, otherwise the transaction's attributed_user_id falling
 * back to the viewer's own.
 */
export function createLoanFromTransaction(input: NewLoanFromTransaction, viewer: Viewer): NewLoanResult;
```

- Produces — `src/app/(app)/transactions/actions.ts`: exactly ONE new export,
  `export async function createLoanFromTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState>`.
  An `async function`, which is the only export shape that file allows
  (`tests/ops/use-server-exports.test.ts`). The zod schema and every helper stay module-private.
- Consumes: `LOAN_DIRECTIONS`, `LOAN_DIRECTION_LABELS`, `isLoanDirection`, `isLoanRepayment`,
  `LoanDirection` (T1, `@/lib/warranty/constants`); `createWarrantyItem` + `WarrantyInput`
  (`@/lib/warranty/items`); `listItemTypes`, `createItemType` (`@/lib/warranty/types`);
  `assignTransactionToLoan`, `paymentLinksForTransaction` (already in `loans.ts`); `getTransaction`
  (`@/lib/transactions`); `canActOnOwner`, `ownerScope`, `NOT_YOURS_ERROR`, `Viewer`
  (`@/lib/auth/viewer`); `Field`, `inputClass`, `selectClass`, `SubmitButton`, `RowMenuButton`
  (already imported by `transactions-client.tsx`).
- **Not** produced: no new column, no migration, no audit action, no new component, no change to
  `LoanLink` or `loanLinksForTransactions`.

- [ ] **Step 1: Write the failing tests.**

Append to `tests/lib/warranty/constants.test.ts` (the extraction, pinned before it moves):

```ts
describe('loanAssignedMessage (Addendum A, ruling A8)', () => {
  it('says what came off a loan the household owes', () => {
    expect(loanAssignedMessage({ direction: 'owed', appliedCents: 50_000, balanceAfterCents: 150_000 }))
      .toBe('Assigned. $500.00 came off the balance.');
  });

  it('names the zero when an owed balance lands on it', () => {
    expect(loanAssignedMessage({ direction: 'owed', appliedCents: 50_000, balanceAfterCents: 0 }))
      .toBe('Assigned. $500.00 came off; the balance is now $0.00.');
  });

  it('speaks in the other frame for a loan lent out', () => {
    expect(loanAssignedMessage({ direction: 'lent', appliedCents: 50_000, balanceAfterCents: 50_000 }))
      .toBe('Assigned. $500.00 added to what they owe.');
  });

  it('is honest when nothing moved', () => {
    expect(loanAssignedMessage({ direction: 'owed', appliedCents: 0, balanceAfterCents: null }))
      .toBe('Assigned. The balance was unknown, so it did not move.');
    expect(loanAssignedMessage({ direction: 'owed', appliedCents: 0, balanceAfterCents: 0 }))
      .toBe('Assigned. The balance was already $0.00, so nothing came off.');
  });
});
```

Append to `tests/app/transactions-actions.test.ts`. Reuse that file's own `setup()`, `formData()`,
`balanceOf()` and `currentUser` idioms — every helper below must be the file's real one, plus at
most these two small local ones in its established style:

```ts
/** Addendum A: a transaction with the sign the case under test needs. */
function addSigned(amountCents: number, description = 'E-TRANSFER SAM'): number {
  const { accountId, userId } = ctx!;
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

function loanItems(): { id: number; name: string; balance: number | null; direction: string; type_id: number }[] {
  return current!.sqlite
    .prepare(
      `select i.id, i.name, i.current_balance_cents as balance, i.loan_direction as direction, i.type_id
         from warranty_items i join warranty_item_types t on t.id = i.type_id
        where t.kind = 'loan' order by i.id`,
    )
    .all() as never;
}

describe('createLoanFromTransactionAction — Addendum A', () => {
  it('lends: money out on a new lent loan leaves them owing exactly that amount', async () => {
    setup();
    const txnId = addSigned(-50_000);
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBeUndefined();
    const [loan] = loanItems();
    expect(loan!.name).toBe('Loan to Sam');
    expect(loan!.direction).toBe('lent');
    // Ruling A3: seed 0, link() applies +m, balance after = |amount|.
    expect(loan!.balance).toBe(50_000);
    expect(result.message).toBe('Created Loan to Sam. Assigned. $500.00 added to what they owe.');
  });

  it('borrows, money in: the deposit that arrived becomes the opening balance', async () => {
    setup();
    const txnId = addSigned(50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Bank loan', loanDirection: 'owed' }),
    );
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('borrows, money out: a first payment still leaves |amount| owing (seed 2m, ruling A3)', async () => {
    setup();
    const txnId = addSigned(-50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Family loan', loanDirection: 'owed' }),
    );
    // Seeded at 2m so link()'s repayment of m lands on m: if m is still owed after paying m,
    // 2m was owed before it. NOT a second write -- link() is the only mover.
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('refuses a lent loan opened by money coming IN, and writes nothing at all', async () => {
    setup();
    const txnId = addSigned(50_000);
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe('A loan you lent out starts with money going out.');
    // Ruling A4: one transaction, so a refusal leaves no item, no type and no link behind.
    expect(loanItems()).toEqual([]);
    expect(
      current!.sqlite.prepare('select count(*) as n from loan_payments').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('creates the Loan item type when the household has none, and reuses it next time', async () => {
    setup();
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'First', loanDirection: 'lent' }),
    );
    const types = current!.sqlite
      .prepare("select id, name from warranty_item_types where kind = 'loan'")
      .all() as { id: number; name: string }[];
    expect(types.map((t) => t.name)).toEqual(['Loan']);   // ruling A5
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-25_000)), loanName: 'Second', loanDirection: 'lent' }),
    );
    expect(
      current!.sqlite.prepare("select count(*) as n from warranty_item_types where kind = 'loan'").get(),
    ).toEqual({ n: 1 });
    expect(loanItems().map((loan) => loan.balance)).toEqual([50_000, 25_000]);
  });

  it('uses the first loan-kind type by name when one already exists (ruling A6)', async () => {
    setup();
    createItemType('Zebra loan', 'loan');
    const alpha = createItemType('Alpha loan', 'loan');
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(loanItems()[0]!.type_id).toBe(alpha.id);
  });

  it('refuses a second submit of the same transaction (ruling A7 — the double-submit guard)', async () => {
    setup();
    const txnId = addSigned(-50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const second = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(second.error).toBe('That transaction is already assigned to a loan.');
    expect(loanItems()).toHaveLength(1);
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('refuses a name that is only whitespace', async () => {
    setup();
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: '   ', loanDirection: 'lent' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it('refuses a direction that is neither', async () => {
    setup();
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'given' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(loanItems()).toEqual([]);
  });
});

describe('createLoanFromTransactionAction — scope (rulings A10, A12)', () => {
  it('a self viewer cannot open a loan against somebody else\'s transaction', async () => {
    const { db, accountId } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    currentUser = { id: currentUser.id, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it('a self viewer\'s own loan is owned by them, never by the row\'s attribution', async () => {
    const { db, accountId } = setup();
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(currentUser.id, txnId);
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const owner = current!.sqlite
      .prepare('select owner_user_id as o from warranty_items order by id desc limit 1')
      .get() as { o: number };
    expect(owner.o).toBe(currentUser.id);
  });

  it('a household MEMBER is refused a row attributed to someone else', async () => {
    const { db } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    currentUser = { ...currentUser, role: 'member' };
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(loanItems()).toEqual([]);
  });

  it('a household ADMIN may, and the loan belongs to the person the row is attributed to', async () => {
    const { db } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const owner = current!.sqlite
      .prepare('select owner_user_id as o from warranty_items order by id desc limit 1')
      .get() as { o: number };
    expect(owner.o).toBe(otherId);
  });
});
```

Append to `tests/app/transactions-client.test.tsx` (add `createLoanFromTransactionAction: vi.fn(async () => ({}))`
to the existing `vi.mock` of the actions module first, or every render throws):

```tsx
describe('Assign to new loan — Addendum A', () => {
  it('is offered on a normal row even when the household has no loans yet', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Assign to new loan…' })).toBeTruthy();
  });

  it('is not offered on a transfer (MUST-14.8, ruling A13)', () => {
    render(<TransactionsClient {...transferOnlyProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: 'Assign to new loan…' })).toBeNull();
  });

  it('opens an inline sub-row with a name box and a direction select, defaulting to lent', () => {
    render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to new loan…' }));
    const name = screen.getByLabelText('Loan name') as HTMLInputElement;
    const direction = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect(name.name).toBe('loanName');
    expect(direction.name).toBe('loanDirection');
    expect(direction.value).toBe('lent');
    expect([...direction.options].map((option) => option.textContent)).toEqual([
      'Borrowed — we owe them',
      'Lent out — they owe us',
    ]);
    // The 44px floor lives in the shared control class, not in hand-rolled utilities
    // (Addendum A, guard strategy): both controls must carry it.
    expect(name.className).toContain('field-control');
    expect(direction.className).toContain('field-control');
  });

  it('submits the transaction id, the name and the direction', async () => {
    const spy = vi.mocked(createLoanFromTransactionAction);
    spy.mockClear();
    const { container } = render(<TransactionsClient {...baseProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to new loan…' }));
    fireEvent.change(screen.getByLabelText('Loan name'), { target: { value: 'Loan to Sam' } });
    fireEvent.submit(container.querySelector('form[data-testid="new-loan-form"]') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('transactionId')).toBe('1');
    expect(submitted.get('loanName')).toBe('Loan to Sam');
    expect(submitted.get('loanDirection')).toBe('lent');
  });

  it('opening it on a second row replaces the first, like the note editor', () => {
    render(<TransactionsClient {...twoRowProps} loanOptions={[]} loanLinks={{}} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to new loan…' }));
    openRowMenu('Actions for SECOND ROW');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to new loan…' }));
    expect(screen.getAllByLabelText('Loan name')).toHaveLength(1);
  });
});
```

`baseProps`, `transferOnlyProps` and `openRowMenu` are that file's existing helpers; build
`twoRowProps` from its own `pageWithRow` shape rather than inventing a second convention. If the
existing `saveNoteAction` test reaches its form by a different query than `data-testid`, match that
query instead and drop the `data-testid` from the implementation — do not add a second idiom to the
file.

- [ ] **Step 2: Run them and watch them fail.**

```
npx vitest run tests/lib/warranty/constants.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx --reporter=dot
```

- [ ] **Step 3: The wording, in `src/lib/warranty/constants.ts` (rulings A2, A8).**

Add the two constants beside `LOAN_DIRECTION_KIND_ERROR`, then MOVE the sentences out of
`assignToLoanAction` into one exported function — `import { formatCents } from '@/lib/money';` is the
only new import this file takes.

`isRepayment` is an explicit INPUT, not something this function re-derives: `appliedCents` is
unsigned (see `link()`'s docblock), so a verdict computed from it here would be a second, weaker
copy of the sign logic `isLoanRepayment` already owns — exactly the drift ruling A8 exists to
prevent. Both callers pass `isLoanRepayment(direction, txn.amountCents)`:

```ts
export function loanAssignedMessage(input: {
  direction: LoanDirection;
  isRepayment: boolean;
  appliedCents: number;
  balanceAfterCents: number | null;
}): string {
  if (input.appliedCents === 0) {
    return input.balanceAfterCents === null
      ? 'Assigned. The balance was unknown, so it did not move.'
      : 'Assigned. The balance was already $0.00, so nothing came off.';
  }
  const amount = formatCents(input.appliedCents);
  if (input.isRepayment) {
    if (input.direction !== 'owed') return `Assigned. ${amount} came off what they owe.`;
    if (input.balanceAfterCents === 0) return `Assigned. ${amount} came off; the balance is now $0.00.`;
    return `Assigned. ${amount} came off the balance.`;
  }
  if (input.direction !== 'owed') return `Assigned. ${amount} added to what they owe.`;
  return `Assigned. The balance went up ${amount} (money in).`;
}
```

Update the four test cases in Step 1's `constants.test.ts` block to pass `isRepayment` explicitly —
`true` for the two "came off" cases, `false` for "added to what they owe", either for the
`appliedCents: 0` pair. The sentences themselves must stay byte-for-byte what `3efb23f` shipped;
`tests/app/transactions-actions.test.ts` already pins them through `assignToLoanAction` and that
suite must stay green **without edits to those existing cases** — that is the proof the extraction
changed no behaviour.

- [ ] **Step 4: The writer, in `src/lib/loans.ts` (rulings A3–A7).**

Directly below `assignTransactionToLoan`. No literal `'lent'` anywhere in it (ruling P4):

```ts
export function createLoanFromTransaction(input: NewLoanFromTransaction, viewer: Viewer): NewLoanResult {
  const at = input.at ?? new Date();
  const stamp = nowIso(at);
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Give the loan a name.');

  const txn = getTransaction(input.txnId, viewer);
  if (txn === null) throw new Error('That transaction no longer exists.');
  // Ruling A10: a self viewer's loan is theirs, full stop; a household viewer's follows the row's
  // attribution and falls back to their own id. canActOnOwner then refuses a member acting on
  // somebody else's row, exactly as warranties/actions.ts does.
  const ownerUserId = ownerScope(viewer) === null ? (txn.attributedUserId ?? viewer.id) : viewer.id;
  if (!canActOnOwner(ownerUserId, viewer)) throw new Error(NOT_YOURS_ERROR);

  // Ruling A2 + P4: for a non-'owed' loan, "the first entry is a repayment" and "the money came
  // IN" are the same statement -- said once, through the helper that owns the flip, so the other
  // direction's value is never spelled out in this file.
  if (input.direction !== 'owed' && isLoanRepayment(input.direction, txn.amountCents)) {
    throw new Error(LOAN_LENT_FIRST_ENTRY_ERROR);
  }
  // Ruling A7: the double-submit guard.
  if (paymentLinksForTransaction(input.txnId).loans > 0) throw new Error(LOAN_ALREADY_LINKED_ERROR);

  const magnitude = Math.abs(txn.amountCents);
  // Ruling A3: seed = target - delta. link() is still the only code that moves the balance.
  const seedCents = isLoanRepayment(input.direction, txn.amountCents) ? magnitude * 2 : 0;

  return getDb().transaction((): NewLoanResult => {
    const typeId = firstLoanTypeId() ?? createItemType('Loan', 'loan').id;   // rulings A5, A6
    const itemId = createWarrantyItem(
      {
        name,
        vendor: null,
        model: null,
        serial: null,
        purchaseDate: txn.date,
        warrantyMonths: null,
        isLifetime: false,
        priceCents: null,
        ownerUserId,
        transactionId: input.txnId,
        typeId,
        notes: null,
        currentBalanceCents: seedCents,
        balanceUpdatedAt: stamp,     // MUST-11.7: both, or neither
        loanDirection: input.direction,
      },
      [],
      stamp,
    );
    const result = assignTransactionToLoan({ txnId: input.txnId, itemId, at });
    return {
      itemId,
      name,
      direction: input.direction,
      appliedCents: result.appliedCents,
      balanceAfterCents: seedCents + (isLoanRepayment(input.direction, txn.amountCents) ? -result.appliedCents : result.appliedCents),
    };
  });
}
```

Three things to get right while writing it:

1. **`firstLoanTypeId()`** is a module-private helper — `listItemTypes().find((type) => type.kind === 'loan')?.id ?? null`
   — so the order is the dropdown's own (ruling A6) and no second `order by` is written anywhere.
2. **`balanceAfterCents` is computed, not re-read.** `link()` clamps, and every accepted case here
   applies in full (the repayment case is seeded at `2m`, so the clamp cannot bite) — but if a
   future change makes it bite, this arithmetic and the database would disagree silently. Prefer
   re-reading the row inside the same transaction if that reads more honestly to you; the tests in
   Step 1 assert the DATABASE's value either way.
3. **Nothing here writes `transactions`** (MUST-13.2), touches `interest_rate_bps` (MUST-13.1) or
   appends an audit row (ruling A11).

Then confirm by grep, before moving on:

```
grep -n "'lent'\|\"lent\"" src/lib/loans.ts
```

It must print nothing.

- [ ] **Step 5: The action, in `src/app/(app)/transactions/actions.ts`.**

Beside `assignToLoanAction`, following its shape (origin check first, `requireUser`, zod, one
`try/catch` around the writer, three `revalidatePath` calls):

```ts
const newLoanSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  loanName: z.string().trim().min(1, 'Give the loan a name.').max(200),
  loanDirection: z.enum(LOAN_DIRECTIONS),
});

export async function createLoanFromTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };
  const user = await requireUser();
  const parsed = newLoanSchema.safeParse({
    transactionId: formData.get('transactionId'),
    loanName: formData.get('loanName') ?? '',
    loanDirection: formData.get('loanDirection') ?? 'lent',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  let created: NewLoanResult;
  try {
    created = createLoanFromTransaction(
      { txnId: parsed.data.transactionId, name: parsed.data.loanName, direction: parsed.data.loanDirection },
      user,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not create that loan.' };
  }
  revalidatePath('/transactions');
  revalidatePath('/dashboard');
  revalidatePath('/reports');
  // Ruling A9: both facts, with the second half word-for-word the sentence the plain assign says.
  const txn = getTransaction(parsed.data.transactionId, user);
  return {
    message: `Created ${created.name}. ${loanAssignedMessage({
      direction: created.direction,
      isRepayment: txn !== null && isLoanRepayment(created.direction, txn.amountCents),
      appliedCents: created.appliedCents,
      balanceAfterCents: created.balanceAfterCents,
    })}`,
  };
}
```

In the SAME edit, switch `assignToLoanAction`'s own trailing branches to
`loanAssignedMessage({...})` and delete the inlined sentences (ruling A8). Its over-link warning
branch, its `!result.linked` branch and its `getWarrantyItem` read stay exactly where they are —
the balance it passes as `balanceAfterCents` is `item?.currentBalanceCents ?? null`, read after the
assign, which is what those sentences already meant.

- [ ] **Step 6: The menu item and the sub-row (ruling A1).**

`transactions-client.tsx`. One state slot beside `noting`:

```tsx
const [newLoan, setNewLoan] = useState<{ id: number } | null>(null);
const [newLoanState, newLoanAction] = useActionState(createLoanFromTransactionAction, initial);
```

One `RowMenuButton`, LAST in the existing `row.isTransfer ? null : ...` loan block so the existing
`Assign to <loan>` items keep their order:

```tsx
<RowMenuButton onSelect={() => setNewLoan({ id: row.id })}>Assign to new loan…</RowMenuButton>
```

And one sub-row, directly after the `noting` sub-row and built the same way — a
`colSpan={COLUMN_COUNT}` cell, `onSubmit={() => setNewLoan(null)}`, a hidden `transactionId`, two
`<Field>`s and a `SubmitButton` with a ghost Cancel:

```tsx
{newLoan?.id === row.id ? (
  <tr>
    <td colSpan={COLUMN_COUNT}>
      <form action={newLoanAction} onSubmit={() => setNewLoan(null)} className="flex flex-col gap-2 py-2" data-testid="new-loan-form">
        <input type="hidden" name="transactionId" value={row.id} />
        <Field label="Loan name" hint="Who the loan is with — a name you will recognise later.">
          <input name="loanName" autoFocus className={inputClass} />
        </Field>
        <Field label="Direction">
          <select name="loanDirection" defaultValue="lent" className={selectClass}>
            {LOAN_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
            ))}
          </select>
        </Field>
        <div className="flex gap-2">
          <SubmitButton className="w-fit">Create loan</SubmitButton>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewLoan(null)}>
            Cancel
          </button>
        </div>
      </form>
    </td>
  </tr>
) : null}
```

Render `newLoanState`'s error/message through the same `Notice` / `FormError` the other row actions
on this page already use — do not add a second banner idiom. Any apostrophe or quote mark added to
that hint must be escaped the way the rest of the file escapes them (`&rsquo;`, `&ldquo;`).

**Why this passes `tests/ops/row-controls.test.ts`:** the form holds one `<select>` AND one visible
`<input>` that is not `type="hidden"`, so the scanner's `inputs.length !== hidden.length` line skips
it — the same exemption the accounts editor row takes. Do not "simplify" the name field away into a
prompt, and do not convert the select to `AutoSaveSelect`.

- [ ] **Step 7: Register the new viewer-taking function (ruling A12).**

`tests/ops/visibility-invariants.test.ts`, in `REQUIRE_VIEWER`:

```ts
  // Addendum A: a WRITER, not a read model -- it is listed here for the one guarantee this list
  // mechanically asserts, that the viewer parameter exists and is never optional. That is what
  // stops a future caller compiling a create that skips the owner rules (rulings A10, A12).
  { file: 'src/lib/loans.ts', fn: 'createLoanFromTransaction' },
```

and raise the floor in the same file:

```ts
  it('the named lists cannot shrink below 28 entries', () => {
    expect(REQUIRE_VIEWER.length + EXEMPT.length).toBeGreaterThanOrEqual(28);
  });
```

- [ ] **Step 8: Run the tests, the guards and `tsc`.**

```
npx vitest run tests/lib/warranty/constants.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx tests/lib/loans tests/ops/row-controls.test.ts tests/ops/use-server-exports.test.ts tests/ops/visibility-invariants.test.ts tests/ops/loan-invariants.test.ts tests/ops/client-bundle.test.ts tests/ops/table-layout.test.ts tests/app/help.test.tsx --reporter=dot
npx tsc --noEmit
```

Every one must be green, and `tests/app/help.test.tsx` must pass **without being edited** — it
already asserts the copy `81777b3` shipped, which is the contract this task implements.

- [ ] **Step 9: Commit.**

```
git status --short
git add src/lib/warranty/constants.ts src/lib/loans.ts src/app/\(app\)/transactions/actions.ts src/app/\(app\)/transactions/transactions-client.tsx tests/ops/visibility-invariants.test.ts tests/lib/warranty/constants.test.ts tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx && git commit -m "feat(transactions): create a loan straight from a transaction row"
```

### Definition of done — Task 9

- A row menu on `/transactions` offers **"Assign to new loan…"** on every non-transfer row, even in a
  household with no loans and no loan-kind item type.
- Submitting it creates the loan and the link in ONE transaction, and the new balance is
  `|amountCents|` in all three accepted cases.
- A `lent` loan opened by incoming money is refused, and the refusal leaves no item, no type and no
  link behind.
- A second submit of the same transaction is refused; exactly one loan exists.
- `src/lib/loans.ts` still contains no literal `'lent'`.
- `src/app/(app)/help/content.tsx` and `CHANGELOG.md` are untouched by this task, and
  `tests/app/help.test.tsx` passes unedited.

**Deviation (shipped, review round).** Owner resolution and `canActOnOwner` live in exactly one
place -- `createLoanFromTransaction` (`src/lib/loans.ts`) -- and are never duplicated in
`createLoanFromTransactionAction`; the action only parses the form and calls the lib function with
the signed-in viewer, per ruling A12. And a correction to this doc's own guard-strategy claim
above (Step 6): `.btn` / `SubmitButton` carry **no** phone-height floor of their own -- only
`.field-control` does (`src/app/globals.css`'s `min-height: 2.75rem` rule is scoped to that class
alone). "Both controls must carry it" in the sub-row test (Step 6) means the name `<input>` and the
direction `<select>`, not the `SubmitButton` beside them.
