# Loan Ledger, Interest Posting and Loan Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loan with a rate shows a bank-style ledger — posted interest each cycle, daily accrual on the actual balance, corrections as adjustment rows — kept current by the scheduler and by every payment, with loan and goal notifications and CSV statement intake.

**Architecture:** A new pure engine `src/lib/loans/ledger.ts` turns facts (start point, rate history, movements, stored postings) into closed periods, an open-period accrual and ledger rows; it reads no DB and no clock. `src/lib/loans.ts` gains `postDueInterest`, the one function that turns closed periods into `loan_postings` rows and then calls the existing `recomputeBalance`. Every other surface (loan page card, dashboard, reports, notifications) reads the engine's output. Posted rows are facts; a late movement produces an adjustment row, never a rewrite.

**Tech Stack:** Next.js 16 App Router, React 19, server actions, Drizzle over better-sqlite3, hand-written SQL migrations, Vitest + Testing Library, Tailwind v4, node-cron.

**Spec:** `docs/superpowers/specs/2026-09-18-loan-ledger-design.md` (rulings D, C, A, P, K, R, U, N, S, G, M, T). The interest spec `docs/superpowers/specs/2026-09-18-loan-interest-design.md` still governs everything this one does not withdraw.

## Global Constraints

- Integer cents everywhere; rates in basis points; derived rates in parts-per-billion (`PPB = 1_000_000_000`). No floats stored.
- The engine files `src/lib/loans/interest.ts` and `src/lib/loans/ledger.ts` import nothing from `@/db`, call no `Date`/`todayIso`, and never spell `'lent'` or `'owed'` (guards G1–G2). `loanSignedDelta` is the only place direction lives (ruling P4).
- `recomputeBalance` remains the only writer of `warranty_items.current_balance_cents` (guard G3). `postDueInterest` writes `loan_postings` and *calls* `recomputeBalance`.
- Migrations: `drizzle/00NN_name.sql` with `--> statement-breakpoint` between statements, mirrored in `src/db/schema.ts`, journal entry appended to `drizzle/meta/_journal.json` with a `when` later than idx 25's `1758153600000`. Drizzle applies by `when`, not hash.
- Public repo: no owner name, employer, Windows paths, real statement figures, or verbatim owner quotes in code or comments. Commit messages: subject + a few bullets. No Co-Authored-By lines (repo rule overrides harness default).
- Every new production behaviour starts with a failing test. Run one file at a time: `npx vitest run <file>`. A single arbitrary failure under the full parallel run is the known reporter flake; rerun that file alone.
- Wording fixed by the spec is copied verbatim (banner text, event labels, blurbs, message lines).
- Release: bump `package.json` to `1.48.0`, CHANGELOG entry, update the MUST-7.1 guard in `tests/ops/docker.test.ts`, commit `chore(release): v1.48.0`, push `main`, push tag `v1.48.0`.

---

## File map

| File | Responsibility |
|---|---|
| `drizzle/0026_loan_ledger.sql` + journal | tables `loan_postings`, `loan_rate_history`; columns `posting_day`, `statement_csv_columns`; rate-history backfill |
| `src/db/schema.ts` | Drizzle mirror of the above; `warranty_receipts.mime` gains `text/csv` |
| `src/lib/loans/ledger.ts` **(new)** | pure engine: cycle dates, daily balances, period charges, closed/open periods, adjustments, ledger rows |
| `src/lib/loans/interest.ts` | unchanged except `ratePpb`/`chargeCents` reused; `simulate` deleted in Task 12 once nothing calls it |
| `src/lib/loans.ts` | `postDueInterest`, `postAllDueInterest`, `loanLedger` (DB → engine), `listRateHistory`, `addRateChange`, `recomputeBalance` replaying postings, `debtOverTime` from segments, `loan_paid_off` raise |
| `src/lib/warranty/items.ts` | D1 validation, first anchor on create (D3), `postingDay`, `statementCsvColumns` |
| `src/app/(app)/warranties/actions.ts` | form parsing for basis default, as-of date, posting day, effective-from, keep-statement |
| `src/app/(app)/warranties/new/new-warranty-client.tsx`, `[id]/warranty-detail-client.tsx` | D1–D6 form changes, banner, Ledger card |
| `src/components/LoanLedgerCard.tsx` **(new)** | U1–U8 |
| `src/app/api/loans/statement-prefill/route.ts` | CSV branch (S1) |
| `src/lib/loans/statement-csv.ts` **(new)** | header detection + mapping for a statement CSV |
| `src/app/(app)/warranties/[id]/reconcile-loan-form.tsx` | column picker (S2), keep checkbox (S4) |
| `src/lib/notify/events.ts`, `render.ts`, `evaluate/loans.ts` **(new)**, `evaluate/goals.ts` **(new)**, `evaluate/coming-due.ts`, `evaluate/index.ts`, `raise.ts` | N1–N9 |
| `src/lib/scheduler.ts`, `src/lib/backup.ts` | P3 call sites |
| `src/app/(app)/settings/notifications/*` | "Loans and goals" group (N8) |
| `src/app/(app)/help/content.tsx` | ledger paragraph |
| `tests/ops/loan-invariants.test.ts` | T4 |

---

### Task 1: Migration 0026 and schema mirror

**Files:**
- Create: `drizzle/0026_loan_ledger.sql`
- Modify: `drizzle/meta/_journal.json` (append idx 26)
- Modify: `src/db/schema.ts` (after `loanAnchors`, ~line 940; `warrantyItems` near line 867; `warrantyReceipts.mime` line 952)
- Test: `tests/db/migration-0026.test.ts`

**Interfaces:**
- Produces: tables `loan_postings`, `loan_rate_history`; Drizzle exports `loanPostings`, `loanRateHistory`; `warrantyItems.postingDay`, `warrantyItems.statementCsvColumns`.

- [ ] **Step 1: Write the failing migration test**

```ts
// tests/db/migration-0026.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, type TestDb } from '../helpers/db';

let t: TestDb | undefined;
afterEach(() => t?.close());

describe('migration 0026: loan ledger tables', () => {
  it('creates loan_postings with a partial unique index on postings only', () => {
    t = createSeededTestDb();
    const cols = t.sqlite.prepare(`pragma table_info('loan_postings')`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual([
      'id', 'item_id', 'kind', 'period_start', 'period_end', 'opening_cents', 'interest_cents',
      'payments_cents', 'advances_cents', 'closing_cents', 'rate_bps', 'basis',
      'average_daily_balance_cents', 'note', 'created_at', 'created_by_user_id',
    ]);
    const idx = t.sqlite.prepare(`select sql from sqlite_master where name = 'loan_postings_item_period_uq'`).get() as { sql: string };
    expect(idx.sql).toMatch(/where kind = 'posting'/i);
  });

  it('creates loan_rate_history and the two new item columns', () => {
    t = createSeededTestDb();
    const cols = t.sqlite.prepare(`pragma table_info('loan_rate_history')`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(['id', 'item_id', 'effective_from', 'rate_bps', 'basis', 'created_at', 'created_by_user_id']);
    const items = (t.sqlite.prepare(`pragma table_info('warranty_items')`).all() as { name: string }[]).map((c) => c.name);
    expect(items).toContain('posting_day');
    expect(items).toContain('statement_csv_columns');
  });

  it('backfills one rate-history row per loan that has a basis, dated at its newest anchor', () => {
    t = createSeededTestDb({ stopAtMigration: '0025_loan_interest' });
    t.sqlite.exec(`
      insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Loan', 0, 'loan', '2026-01-01T00:00:00.000Z');
      insert into users (username, password_hash, role, created_at) values ('u', 'x', 'admin', '2026-01-01T00:00:00.000Z');
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, interest_rate_bps, interest_rate_basis, current_balance_cents, created_at, updated_at)
        values ('With basis', '2026-07-01', 0, 1, 1, 1000000, 1000, 'apr_monthly', 1000000, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
               ('No basis',   '2026-07-01', 0, 1, 1, 1000000, 1000, null,          1000000, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      insert into loan_anchors (item_id, as_of_date, balance_cents, source, created_at) values (1, '2026-08-05', 1000000, 'migrated', '2026-08-05T00:00:00.000Z');
    `);
    t.applyRemainingMigrations();
    const rows = t.sqlite.prepare(`select item_id, effective_from, rate_bps, basis from loan_rate_history order by item_id`).all();
    expect(rows).toEqual([{ item_id: 1, effective_from: '2026-08-05', rate_bps: 1000, basis: 'apr_monthly' }]);
  });
});
```

If `createSeededTestDb` has no `stopAtMigration`/`applyRemainingMigrations`, look at how `tests/db/migration-0025.test.ts` seeds pre-migration rows and copy that mechanism instead; the assertion is what matters.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/migration-0026.test.ts`
Expected: FAIL — `loan_postings` has no columns / `loan_rate_history` missing.

- [ ] **Step 3: Write the migration**

```sql
-- drizzle/0026_loan_ledger.sql
--
-- Posted interest becomes a stored fact (ledger spec P1). A row is written once per closed
-- posting period; a correction is a second row of kind 'adjustment' dated the day it was
-- discovered (K2), never an update to the first. The partial unique index lets several
-- adjustments land on one day while keeping one posting per period.
create table loan_postings (
  id integer primary key autoincrement,
  item_id integer not null references warranty_items(id) on delete cascade,
  kind text not null check (kind in ('posting', 'adjustment')),
  period_start text not null check (period_start like '____-__-__'),
  period_end text not null check (period_end like '____-__-__'),
  opening_cents integer not null,
  interest_cents integer not null,
  payments_cents integer not null default 0,
  advances_cents integer not null default 0,
  closing_cents integer not null,
  rate_bps integer,
  basis text check (basis is null or basis in ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily')),
  average_daily_balance_cents integer,
  note text,
  created_at text not null,
  created_by_user_id integer references users(id) on delete set null
);
--> statement-breakpoint
create unique index loan_postings_item_period_uq on loan_postings (item_id, period_end) where kind = 'posting';
--> statement-breakpoint
create index loan_postings_item_idx on loan_postings (item_id, period_end, id);
--> statement-breakpoint
-- The rate in force from a date (R1). warranty_items keeps the CURRENT rate and basis so every
-- existing reader stays correct; this table is what lets a closed period keep its own rate.
create table loan_rate_history (
  id integer primary key autoincrement,
  item_id integer not null references warranty_items(id) on delete cascade,
  effective_from text not null check (effective_from like '____-__-__'),
  rate_bps integer not null,
  basis text not null check (basis in ('none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily')),
  created_at text not null,
  created_by_user_id integer references users(id) on delete set null
);
--> statement-breakpoint
create index loan_rate_history_item_idx on loan_rate_history (item_id, effective_from, id);
--> statement-breakpoint
-- Day of the month interest posts (C1). NULL means the borrowed date's day.
alter table warranty_items add column posting_day integer check (posting_day is null or (posting_day between 1 and 31));
--> statement-breakpoint
-- The confirmed CSV column mapping for this loan's statements (S3), as JSON {date, balance, interest?}.
alter table warranty_items add column statement_csv_columns text;
--> statement-breakpoint
-- One history row per loan that already has a basis, dated at its newest anchor (or the
-- borrowed date when it has none). Loans without a basis get nothing: nothing is assumed (D2).
insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
select i.id,
       coalesce((select a.as_of_date from loan_anchors a where a.item_id = i.id order by a.as_of_date desc, a.id desc limit 1), i.purchase_date),
       i.interest_rate_bps,
       i.interest_rate_basis,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
from warranty_items i
where i.interest_rate_basis is not null and i.interest_rate_bps is not null;
```

Journal entry (append inside `entries`):

```json
{
  "idx": 26,
  "version": "6",
  "when": 1758240000000,
  "tag": "0026_loan_ledger",
  "breakpoints": true
}
```

- [ ] **Step 4: Mirror in `src/db/schema.ts`**

Add to `warrantyItems` after `interestRateBasis`:

```ts
    /** Day of the month interest posts (ledger spec C1). NULL: the borrowed date's day. */
    postingDay: integer('posting_day'),
    /** Confirmed CSV column mapping for statements (S3): JSON {date, balance, interest?}. */
    statementCsvColumns: text('statement_csv_columns'),
```

Add after `loanAnchors`:

```ts
export const loanPostings = sqliteTable(
  'loan_postings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id').notNull().references(() => warrantyItems.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['posting', 'adjustment'] }).notNull(),
    periodStart: text('period_start').notNull(),
    /** The posting date. For an adjustment, the day it was discovered (K2). */
    periodEnd: text('period_end').notNull(),
    openingCents: integer('opening_cents').notNull(),
    interestCents: integer('interest_cents').notNull(),
    paymentsCents: integer('payments_cents').notNull().default(0),
    advancesCents: integer('advances_cents').notNull().default(0),
    closingCents: integer('closing_cents').notNull(),
    rateBps: integer('rate_bps'),
    basis: text('basis', { enum: ['none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily'] }),
    averageDailyBalanceCents: integer('average_daily_balance_cents'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('loan_postings_item_period_uq').on(t.itemId, t.periodEnd).where(sql`kind = 'posting'`),
    index('loan_postings_item_idx').on(t.itemId, t.periodEnd, t.id),
  ],
);

export const loanRateHistory = sqliteTable(
  'loan_rate_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id').notNull().references(() => warrantyItems.id, { onDelete: 'cascade' }),
    effectiveFrom: text('effective_from').notNull(),
    rateBps: integer('rate_bps').notNull(),
    basis: text('basis', { enum: ['none', 'apr_monthly', 'apr_semiannual', 'per_month', 'simple_on_principal', 'apr_daily'] }).notNull(),
    createdAt: text('created_at').notNull(),
    createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('loan_rate_history_item_idx').on(t.itemId, t.effectiveFrom, t.id)],
);
```

Change `warrantyReceipts.mime` enum to include `'text/csv'`. Check `tests/db/schema.test.ts` for a snapshot of table names and add the two.

- [ ] **Step 5: Run the migration test, the schema test, and the restore-backup test**

Run: `npx vitest run tests/db/migration-0026.test.ts tests/db/schema.test.ts tests/lib/restore-backup.test.ts`
Expected: PASS. If the restore fixture's drop order fails on the new FKs, add `drop table loan_postings; drop table loan_rate_history;` before `loan_anchors` in that fixture (same fix v1.47.0 made for `loan_anchors`).

- [ ] **Step 6: Commit**

```bash
git add drizzle/0026_loan_ledger.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/migration-0026.test.ts tests/db/schema.test.ts
git commit -m "feat(loans): postings and rate history tables

- loan_postings with a partial unique index on postings
- loan_rate_history backfilled from the current basis
- posting_day and statement_csv_columns on items"
```

---

### Task 2: Pure engine — cycle dates and daily balances

**Files:**
- Create: `src/lib/loans/ledger.ts`
- Test: `tests/lib/loans/ledger-cycle.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function postingDayFor(purchaseDate: string, postingDay: number | null): number;
  export function nextPostingDate(afterIso: string, postingDay: number): string;   // strictly after afterIso, day clamped to month end
  export function periodBoundaries(startIso: string, postingDay: number, todayIso: string): { start: string; end: string; closed: boolean }[];
  export function dailyBalances(startIso: string, endIsoExclusive: string, openingCents: number, movements: Movement[]): number[];
  ```
  `Movement` is the existing `{ date: string; amountCents: number }` from `interest.ts` (negative = repayment, positive = advance, loan frame).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/loans/ledger-cycle.test.ts
import { describe, it, expect } from 'vitest';
import { postingDayFor, nextPostingDate, periodBoundaries, dailyBalances } from '@/lib/loans/ledger';

describe('posting cycle (C1–C3)', () => {
  it('defaults the posting day to the borrowed date, and an explicit day wins', () => {
    expect(postingDayFor('2026-07-17', null)).toBe(17);
    expect(postingDayFor('2026-07-17', 1)).toBe(1);
  });

  it('clamps a 31st to the month end', () => {
    expect(nextPostingDate('2026-01-31', 31)).toBe('2026-02-28');
    expect(nextPostingDate('2026-02-28', 31)).toBe('2026-03-31');
    expect(nextPostingDate('2028-01-31', 31)).toBe('2028-02-29');
  });

  it('a period is closed when its end is on or before today', () => {
    expect(periodBoundaries('2026-07-01', 1, '2026-09-18')).toEqual([
      { start: '2026-07-01', end: '2026-08-01', closed: true },
      { start: '2026-08-01', end: '2026-09-01', closed: true },
      { start: '2026-09-01', end: '2026-10-01', closed: false },
    ]);
  });

  it('a start point on the posting day itself begins a full period there', () => {
    expect(periodBoundaries('2026-09-01', 1, '2026-09-01')).toEqual([{ start: '2026-09-01', end: '2026-10-01', closed: false }]);
  });

  it('a mid-cycle start point yields one short first period (C2)', () => {
    expect(periodBoundaries('2026-08-20', 1, '2026-09-18')[0]).toEqual({ start: '2026-08-20', end: '2026-09-01', closed: true });
  });
});

describe('daily balances (A1)', () => {
  it('a payment counts from the day it lands', () => {
    const days = dailyBalances('2026-07-01', '2026-08-01', 1_000_000, [{ date: '2026-07-15', amountCents: -500_000 }]);
    expect(days).toHaveLength(31);
    expect(days[13]).toBe(1_000_000); // Jul 14
    expect(days[14]).toBe(500_000); // Jul 15
    expect(days[30]).toBe(500_000);
  });

  it('never goes below zero', () => {
    const days = dailyBalances('2026-07-01', '2026-07-03', 100, [{ date: '2026-07-02', amountCents: -500 }]);
    expect(days).toEqual([100, 0]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/loans/ledger-cycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/loans/ledger.ts
/**
 * The loan ledger engine (ledger spec §4–§7). Pure: no database, no clock, no direction value.
 * Everything here is in the loan's frame -- a magnitude -- and the caller applies loanSignedDelta.
 */
import { addDaysIso, daysBetweenIso } from '@/lib/dates';
import { chargeCents, ratePpb, type InterestBasis, type Movement } from '@/lib/loans/interest';

export function postingDayFor(purchaseDate: string, postingDay: number | null): number {
  return postingDay ?? Number(purchaseDate.slice(8, 10));
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function clampedDate(year: number, month1: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The first posting date strictly after `afterIso`. */
export function nextPostingDate(afterIso: string, postingDay: number): string {
  let year = Number(afterIso.slice(0, 4));
  let month = Number(afterIso.slice(5, 7));
  let candidate = clampedDate(year, month, postingDay);
  while (candidate <= afterIso) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    candidate = clampedDate(year, month, postingDay);
  }
  return candidate;
}

export interface PeriodBoundary { start: string; end: string; closed: boolean }

export function periodBoundaries(startIso: string, postingDay: number, todayIso: string): PeriodBoundary[] {
  const out: PeriodBoundary[] = [];
  let start = startIso;
  for (;;) {
    const end = nextPostingDate(start, postingDay);
    const closed = end <= todayIso;
    out.push({ start, end, closed });
    if (!closed) return out;
    start = end;
  }
}

/** One entry per day in [start, endExclusive): the balance after that day's movements. */
export function dailyBalances(startIso: string, endIsoExclusive: string, openingCents: number, movements: Movement[]): number[] {
  const byDate = new Map<string, number>();
  for (const m of movements) {
    if (m.date < startIso || m.date >= endIsoExclusive) continue;
    byDate.set(m.date, (byDate.get(m.date) ?? 0) + m.amountCents);
  }
  const days = daysBetweenIso(startIso, endIsoExclusive);
  const out: number[] = [];
  let balance = openingCents;
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(startIso, i);
    balance = Math.max(0, balance + (byDate.get(date) ?? 0));
    out.push(balance);
  }
  return out;
}
```

Confirm `daysBetweenIso(a, b)` returns `b − a` in days (it is used that way in `loans.ts`); if it returns an absolute value, that is fine here since `end > start`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/loans/ledger-cycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans/ledger.ts tests/lib/loans/ledger-cycle.test.ts
git commit -m "feat(loans): posting cycle and daily balances"
```

---

### Task 3: Pure engine — period charges (A2–A8)

**Files:**
- Modify: `src/lib/loans/ledger.ts`
- Test: `tests/lib/loans/ledger-charge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateInForce { effectiveFrom: string; rateBps: number; basis: InterestBasis }
  export function rateOn(date: string, history: RateInForce[]): RateInForce | null;
  export interface PeriodCharge { interestCents: number; averageDailyBalanceCents: number; daysCounted: number; daysInPeriod: number }
  export function periodCharge(input: {
    start: string; end: string;            // end exclusive = posting date
    upTo?: string;                         // for the open period: count days < upTo (A5)
    openingCents: number; principalCents: number | null;
    movements: Movement[]; rate: RateInForce | null;
  }): PeriodCharge;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/loans/ledger-charge.test.ts
import { describe, it, expect } from 'vitest';
import { periodCharge, rateOn } from '@/lib/loans/ledger';

const apr10 = { effectiveFrom: '2026-01-01', rateBps: 1000, basis: 'apr_monthly' as const };

describe('period charge (A2–A5)', () => {
  it('an unchanged balance reproduces rate/12 exactly (A3)', () => {
    const c = periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 1_000_000, principalCents: 1_000_000, movements: [], rate: apr10 });
    expect(c.interestCents).toBe(8_333);
    expect(c.averageDailyBalanceCents).toBe(1_000_000);
    expect(c.daysInPeriod).toBe(31);
  });

  it('pins the spec figures for the other bases', () => {
    const big = (basis: 'apr_monthly' | 'apr_semiannual' | 'per_month', bps: number) =>
      periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 30_000_000, principalCents: 30_000_000, movements: [], rate: { effectiveFrom: '2026-01-01', rateBps: bps, basis } }).interestCents;
    expect(big('apr_monthly', 500)).toBe(125_000);
    expect(big('per_month', 50)).toBe(150_000);
    expect(big('apr_semiannual', 500)).toBeGreaterThanOrEqual(123_600);
    expect(big('apr_semiannual', 500)).toBeLessThanOrEqual(123_800);
    const flat = periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 400_000, principalCents: 1_000_000, movements: [], rate: { effectiveFrom: '2026-01-01', rateBps: 500, basis: 'simple_on_principal' } });
    expect(flat.interestCents).toBe(4_167); // on the original, not the balance
    const daily = periodCharge({ start: '2026-07-01', end: '2026-07-31', openingCents: 2_000_000, principalCents: null, movements: [], rate: { effectiveFrom: '2026-01-01', rateBps: 800, basis: 'apr_daily' } });
    expect(daily.interestCents).toBe(13_151);
  });

  it('a mid-period payment lowers the average daily balance (A8 second table)', () => {
    const c = periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 1_000_000, principalCents: 1_000_000, movements: [{ date: '2026-07-15', amountCents: -500_000 }], rate: apr10 });
    expect(c.averageDailyBalanceCents).toBe(725_806);
    expect(c.interestCents).toBe(6_048);
  });

  it('accrued so far counts days before today only (A5)', () => {
    const c = periodCharge({ start: '2026-09-01', end: '2026-10-01', upTo: '2026-09-18', openingCents: 1_016_736, principalCents: 1_000_000, movements: [], rate: apr10 });
    expect(c.daysCounted).toBe(17);
    expect(c.daysInPeriod).toBe(30);
    expect(c.interestCents).toBe(4_801);
  });

  it('no rate, or basis none, charges nothing but still reports the balance', () => {
    expect(periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 1_000_000, principalCents: null, movements: [], rate: null }).interestCents).toBe(0);
    expect(periodCharge({ start: '2026-07-01', end: '2026-08-01', openingCents: 1_000_000, principalCents: null, movements: [], rate: { ...apr10, basis: 'none' } }).interestCents).toBe(0);
  });
});

describe('rateOn (R1)', () => {
  it('picks the newest row on or before the date', () => {
    const h = [apr10, { effectiveFrom: '2026-08-15', rateBps: 1200, basis: 'apr_monthly' as const }];
    expect(rateOn('2026-08-14', h)?.rateBps).toBe(1000);
    expect(rateOn('2026-08-15', h)?.rateBps).toBe(1200);
    expect(rateOn('2025-12-31', h)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/loans/ledger-charge.test.ts`
Expected: FAIL — `periodCharge` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/loans/ledger.ts`:

```ts
export interface RateInForce { effectiveFrom: string; rateBps: number; basis: InterestBasis }

export function rateOn(date: string, history: RateInForce[]): RateInForce | null {
  let found: RateInForce | null = null;
  for (const row of history) if (row.effectiveFrom <= date && (found === null || row.effectiveFrom >= found.effectiveFrom)) found = row;
  return found;
}

export interface PeriodCharge {
  interestCents: number;
  averageDailyBalanceCents: number;
  daysCounted: number;
  daysInPeriod: number;
}

const PPB = 1_000_000_000;

/**
 * A2/A4/A5. Monthly bases: periodic rate × average daily balance, pro-rated by days counted over
 * days in the period. apr_daily: the daily walk with daily compounding, summed. simple_on_principal:
 * the original amount, balance ignored. Rounded ONCE, at the end (A6).
 */
export function periodCharge(input: {
  start: string;
  end: string;
  upTo?: string;
  openingCents: number;
  principalCents: number | null;
  movements: Movement[];
  rate: RateInForce | null;
}): PeriodCharge {
  const daysInPeriod = daysBetweenIso(input.start, input.end);
  const countUntil = input.upTo === undefined || input.upTo > input.end ? input.end : input.upTo;
  const daysCounted = Math.max(0, daysBetweenIso(input.start, countUntil));
  const balances = dailyBalances(input.start, input.end, input.openingCents, input.movements);
  const counted = balances.slice(0, daysCounted);
  const sum = counted.reduce((a, b) => a + b, 0);
  const averageDailyBalanceCents = daysCounted === 0 ? input.openingCents : Math.floor(sum / daysCounted + 0.5);

  if (input.rate === null || input.rate.basis === 'none' || input.rate.rateBps <= 0 || daysCounted === 0) {
    return { interestCents: 0, averageDailyBalanceCents, daysCounted, daysInPeriod };
  }
  const ppb = ratePpb(input.rate.rateBps, input.rate.basis);

  if (input.rate.basis === 'apr_daily') {
    // Daily compounding: each day's charge joins the balance that the next day is charged on.
    let pot = 0;
    let interest = 0;
    for (const balance of counted) {
      const charge = chargeCents(balance + pot, ppb);
      pot += charge;
      interest += charge;
    }
    return { interestCents: interest, averageDailyBalanceCents, daysCounted, daysInPeriod };
  }

  const base = input.rate.basis === 'simple_on_principal' ? (input.principalCents ?? 0) : sum / daysCounted;
  // periodic rate × base × (daysCounted / daysInPeriod), in one rounding.
  const raw = (base * ppb * daysCounted) / (PPB * daysInPeriod);
  return { interestCents: Math.floor(raw + 0.5), averageDailyBalanceCents, daysCounted, daysInPeriod };
}
```

`chargeCents` must be exported from `interest.ts` (it is). If the `apr_daily` pin ($131.51 over 30 days) differs by a cent because the old walk started accrual differently, keep the old walk's convention: read `simulate`'s daily branch and match it; the pinned test is the authority.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/loans/ledger-charge.test.ts`
Expected: PASS. If `apr_semiannual` lands outside the band, check `ratePpb` is being used unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans/ledger.ts tests/lib/loans/ledger-charge.test.ts
git commit -m "feat(loans): period charge on the average daily balance"
```

---

### Task 4: Pure engine — build the ledger

**Files:**
- Modify: `src/lib/loans/ledger.ts`
- Test: `tests/lib/loans/ledger-build.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StoredPosting { kind: 'posting' | 'adjustment'; periodStart: string; periodEnd: string; openingCents: number; interestCents: number; paymentsCents: number; advancesCents: number; closingCents: number; rateBps: number | null; basis: InterestBasis | null; averageDailyBalanceCents: number | null; note: string | null }
  export interface LedgerInput {
    startDate: string; startBalanceCents: number;      // newest anchor
    principalCents: number | null; postingDay: number;
    rateHistory: RateInForce[]; movements: Movement[];  // movements AFTER startDate only (the wall is applied by the caller)
    stored: StoredPosting[]; today: string;
    anchorsAfterStart?: never;                          // there is exactly one start point: the newest anchor
  }
  export type LedgerRowKind = 'opening' | 'advance' | 'payment' | 'interest' | 'adjustment' | 'accrued';
  export interface LedgerRow { kind: LedgerRowKind; date: string; description: string; paymentCents: number | null; interestCents: number | null; principalCents: number | null; balanceCents: number; detail?: { rateBps: number; basis: InterestBasis; averageDailyBalanceCents: number; daysCounted: number; daysInPeriod: number; paidToInterestCents: number } }
  export interface Ledger {
    rows: LedgerRow[];
    duePostings: StoredPosting[];        // closed periods with no stored posting, oldest first (P2)
    dueAdjustment: StoredPosting | null; // K2: truth − stored closing, when non-zero
    postedBalanceCents: number; accruedCents: number; owingCents: number;
    interestThisPeriodCents: number; interestPaidToDateCents: number; principalPaidToDateCents: number;
    yearAtThisBalanceCents: number;
  }
  export function buildLedger(input: LedgerInput): Ledger;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/loans/ledger-build.test.ts
import { describe, it, expect } from 'vitest';
import { buildLedger, type LedgerInput } from '@/lib/loans/ledger';

const base: LedgerInput = {
  startDate: '2026-07-01', startBalanceCents: 1_000_000, principalCents: 1_000_000, postingDay: 1,
  rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' }],
  movements: [], stored: [], today: '2026-09-18',
};

describe('buildLedger (A8 first table)', () => {
  it('produces two due postings and the accrued line when nothing is stored', () => {
    const l = buildLedger(base);
    expect(l.duePostings.map((p) => [p.periodEnd, p.interestCents, p.closingCents])).toEqual([
      ['2026-08-01', 8_333, 1_008_333],
      ['2026-09-01', 8_403, 1_016_736],
    ]);
    expect(l.postedBalanceCents).toBe(1_016_736);
    expect(l.accruedCents).toBe(4_801);
    expect(l.owingCents).toBe(1_021_537);
    expect(l.rows.map((r) => r.kind)).toEqual(['opening', 'interest', 'interest', 'accrued']);
    expect(l.rows.at(-1)!.balanceCents).toBe(1_021_537);
    expect(l.yearAtThisBalanceCents).toBe(101_674); // 1,016,736 × 10%
  });

  it('is idempotent: stored postings equal to the truth leave nothing due', () => {
    const first = buildLedger(base);
    const second = buildLedger({ ...base, stored: first.duePostings });
    expect(second.duePostings).toEqual([]);
    expect(second.dueAdjustment).toBeNull();
    expect(second.postedBalanceCents).toBe(1_016_736);
  });

  it('a payment row shows the accrued-to-date figure and the interest row states the split (U3)', () => {
    const l = buildLedger({ ...base, movements: [{ date: '2026-07-15', amountCents: -500_000 }] });
    const pay = l.rows.find((r) => r.kind === 'payment')!;
    expect(pay.paymentCents).toBe(500_000);
    expect(pay.balanceCents).toBe(500_000);
    expect(pay.interestCents).toBe(3_763); // 14 of 31 days on 1,000,000 at 10%/12
    const post = l.rows.filter((r) => r.kind === 'interest')[0]!;
    expect(post.interestCents).toBe(6_048);
    expect(post.detail?.paidToInterestCents).toBe(6_048);
    expect(l.interestPaidToDateCents).toBe(6_048);
    expect(l.principalPaidToDateCents).toBe(493_952);
  });

  it('a late payment inside a closed period yields one adjustment (K2), and the total is the recomputed truth', () => {
    const first = buildLedger(base);
    const late = buildLedger({ ...base, stored: first.duePostings, movements: [{ date: '2026-08-10', amountCents: -500_000 }] });
    expect(late.duePostings).toEqual([]);
    expect(late.dueAdjustment).not.toBeNull();
    // Truth: Aug 1 posting 8,333 (unchanged); Aug 1–Sep 1 ADB = (9×1,008,333 + 22×508,333)/31 ...
    const truth = buildLedger({ ...base, movements: [{ date: '2026-08-10', amountCents: -500_000 }] });
    const storedClosing = 1_016_736 - 500_000; // stored postings replayed with the payment applied
    expect(late.dueAdjustment!.interestCents).toBe(truth.postedBalanceCents - storedClosing);
    expect(late.dueAdjustment!.periodEnd).toBe('2026-09-18');
    expect(late.dueAdjustment!.note).toContain('2026-08-10');
    expect(late.dueAdjustment!.note).toContain('2026-09-01');
  });

  it('a stored adjustment is honoured: applying it leaves nothing further due', () => {
    const first = buildLedger(base);
    const movements = [{ date: '2026-08-10', amountCents: -500_000 }];
    const late = buildLedger({ ...base, stored: first.duePostings, movements });
    const settled = buildLedger({ ...base, stored: [...first.duePostings, late.dueAdjustment!], movements });
    expect(settled.dueAdjustment).toBeNull();
    const truth = buildLedger({ ...base, movements });
    expect(settled.postedBalanceCents).toBe(truth.postedBalanceCents);
  });

  it('a rate change applies from its date (R1)', () => {
    const l = buildLedger({ ...base, rateHistory: [...base.rateHistory, { effectiveFrom: '2026-08-01', rateBps: 1200, basis: 'apr_monthly' }] });
    expect(l.duePostings[0]!.interestCents).toBe(8_333);
    expect(l.duePostings[1]!.interestCents).toBe(10_083); // 1,008,333 × 12%/12
  });

  it('interest-free writes $0 postings (A2, basis none)', () => {
    const l = buildLedger({ ...base, rateHistory: [{ effectiveFrom: '2026-07-01', rateBps: 0, basis: 'none' }] });
    expect(l.duePostings.map((p) => p.interestCents)).toEqual([0, 0]);
    expect(l.accruedCents).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/loans/ledger-build.test.ts`
Expected: FAIL — `buildLedger` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/loans/ledger.ts`:

```ts
export interface StoredPosting {
  kind: 'posting' | 'adjustment';
  periodStart: string;
  periodEnd: string;
  openingCents: number;
  interestCents: number;
  paymentsCents: number;
  advancesCents: number;
  closingCents: number;
  rateBps: number | null;
  basis: InterestBasis | null;
  averageDailyBalanceCents: number | null;
  note: string | null;
}

export interface LedgerInput {
  startDate: string;
  startBalanceCents: number;
  principalCents: number | null;
  postingDay: number;
  rateHistory: RateInForce[];
  movements: Movement[];
  stored: StoredPosting[];
  today: string;
}

export type LedgerRowKind = 'opening' | 'advance' | 'payment' | 'interest' | 'adjustment' | 'accrued';

export interface LedgerRow {
  kind: LedgerRowKind;
  date: string;
  description: string;
  paymentCents: number | null;
  interestCents: number | null;
  principalCents: number | null;
  balanceCents: number;
  detail?: {
    rateBps: number;
    basis: InterestBasis;
    averageDailyBalanceCents: number;
    daysCounted: number;
    daysInPeriod: number;
    paidToInterestCents: number;
  };
}

export interface Ledger {
  rows: LedgerRow[];
  duePostings: StoredPosting[];
  dueAdjustment: StoredPosting | null;
  postedBalanceCents: number;
  accruedCents: number;
  owingCents: number;
  interestThisPeriodCents: number;
  interestPaidToDateCents: number;
  principalPaidToDateCents: number;
  yearAtThisBalanceCents: number;
}

/** The truth for every closed period, computed from facts alone (no stored rows). */
function computePostings(input: LedgerInput): { postings: StoredPosting[]; open: { start: string; end: string; openingCents: number } } {
  const postings: StoredPosting[] = [];
  let balance = input.startBalanceCents;
  const bounds = periodBoundaries(input.startDate, input.postingDay, input.today);
  for (const b of bounds) {
    if (!b.closed) return { postings, open: { start: b.start, end: b.end, openingCents: balance } };
    const rate = rateOn(b.start, input.rateHistory);
    const inside = input.movements.filter((m) => m.date >= b.start && m.date < b.end);
    const charge = periodCharge({ start: b.start, end: b.end, openingCents: balance, principalCents: input.principalCents, movements: inside, rate });
    const payments = inside.filter((m) => m.amountCents < 0).reduce((a, m) => a - m.amountCents, 0);
    const advances = inside.filter((m) => m.amountCents > 0).reduce((a, m) => a + m.amountCents, 0);
    const closing = Math.max(0, balance - payments + advances + charge.interestCents);
    postings.push({
      kind: 'posting', periodStart: b.start, periodEnd: b.end, openingCents: balance,
      interestCents: charge.interestCents, paymentsCents: payments, advancesCents: advances, closingCents: closing,
      rateBps: rate?.rateBps ?? null, basis: rate?.basis ?? null, averageDailyBalanceCents: charge.averageDailyBalanceCents, note: null,
    });
    balance = closing;
  }
  // Unreachable: periodBoundaries always ends with an open period.
  throw new Error('periodBoundaries returned no open period');
}

/** Replay the STORED rows plus every movement, the way the balance is actually kept (P5). */
function replayStored(input: LedgerInput): number {
  const postedInterest = input.stored.reduce((a, p) => a + p.interestCents, 0);
  const movementSum = input.movements.reduce((a, m) => a + m.amountCents, 0);
  return Math.max(0, input.startBalanceCents + movementSum + postedInterest);
}

export function buildLedger(input: LedgerInput): Ledger {
  const truth = computePostings(input);
  const storedPostings = input.stored.filter((p) => p.kind === 'posting');
  const storedEnds = new Set(storedPostings.map((p) => p.periodEnd));
  const duePostings = truth.postings.filter((p) => !storedEnds.has(p.periodEnd));

  // K1/K2: compare the truth's balance after the newest stored posting with what the stored rows
  // (plus every movement) replay to. Any gap is one adjustment dated today.
  const afterDue = [...input.stored, ...duePostings];
  const replayed = Math.max(0, input.startBalanceCents + input.movements.reduce((a, m) => a + m.amountCents, 0) + afterDue.reduce((a, p) => a + p.interestCents, 0));
  const truthBalance = truth.open.openingCents;
  const gap = truthBalance - replayed;
  let dueAdjustment: StoredPosting | null = null;
  if (gap !== 0 && storedPostings.length > 0) {
    const newestStored = storedPostings.reduce((a, p) => (p.periodEnd > a.periodEnd ? p : a));
    const late = input.movements.filter((m) => m.date <= newestStored.periodEnd && m.date > input.startDate);
    const described = late.map((m) => `${m.amountCents < 0 ? 'Payment' : 'Advance'} of ${(Math.abs(m.amountCents) / 100).toFixed(2)} dated ${m.date}`).join('; ');
    dueAdjustment = {
      kind: 'adjustment', periodStart: input.today, periodEnd: input.today, openingCents: replayed,
      interestCents: gap, paymentsCents: 0, advancesCents: 0, closingCents: replayed + gap,
      rateBps: null, basis: null, averageDailyBalanceCents: null,
      note: `${described || 'A change'} recorded after the ${newestStored.periodEnd} posting. Interest ${gap < 0 ? '−' : '+'}${(Math.abs(gap) / 100).toFixed(2)}.`,
    };
  }

  // Rows. Truth postings for closed periods, stored adjustments where they fall, movements by date.
  const rows: LedgerRow[] = [{ kind: 'opening', date: input.startDate, description: 'Opening balance', paymentCents: null, interestCents: null, principalCents: null, balanceCents: input.startBalanceCents }];
  let balance = input.startBalanceCents;
  let interestPaid = 0;
  let principalPaid = 0;
  const adjustments = input.stored.filter((p) => p.kind === 'adjustment');
  const events: { date: string; order: number; emit: () => void }[] = [];

  for (const p of truth.postings) {
    const inside = input.movements.filter((m) => m.date >= p.periodStart && m.date < p.periodEnd);
    let running = p.openingCents;
    for (const m of inside) {
      const accruedToDay = periodCharge({ start: p.periodStart, end: p.periodEnd, upTo: m.date, openingCents: p.openingCents, principalCents: input.principalCents, movements: inside, rate: rateOn(p.periodStart, input.rateHistory) }).interestCents;
      running = Math.max(0, running + m.amountCents);
      const after = running;
      events.push({ date: m.date, order: 1, emit: () => {
        rows.push(m.amountCents < 0
          ? { kind: 'payment', date: m.date, description: 'Payment', paymentCents: -m.amountCents, interestCents: accruedToDay, principalCents: null, balanceCents: after }
          : { kind: 'advance', date: m.date, description: 'Advance', paymentCents: null, interestCents: null, principalCents: m.amountCents, balanceCents: after });
      } });
    }
    const paidToInterest = Math.min(p.paymentsCents, p.interestCents);
    interestPaid += paidToInterest;
    principalPaid += p.paymentsCents - paidToInterest;
    events.push({ date: p.periodEnd, order: 0, emit: () => {
      balance = p.closingCents;
      rows.push({
        kind: 'interest', date: p.periodEnd, description: p.paymentsCents > 0 ? `Interest posted. Of ${(p.paymentsCents / 100).toFixed(2)} paid this period, ${(paidToInterest / 100).toFixed(2)} covered interest.` : 'Interest posted',
        paymentCents: null, interestCents: p.interestCents, principalCents: null, balanceCents: p.closingCents,
        detail: p.rateBps === null || p.basis === null ? undefined : { rateBps: p.rateBps, basis: p.basis, averageDailyBalanceCents: p.averageDailyBalanceCents ?? p.openingCents, daysCounted: daysBetweenIso(p.periodStart, p.periodEnd), daysInPeriod: daysBetweenIso(p.periodStart, p.periodEnd), paidToInterestCents: paidToInterest },
      });
    } });
  }
  for (const a of adjustments) {
    events.push({ date: a.periodEnd, order: 2, emit: () => rows.push({ kind: 'adjustment', date: a.periodEnd, description: a.note ?? 'Adjustment', paymentCents: null, interestCents: a.interestCents, principalCents: null, balanceCents: a.closingCents }) });
  }
  // Open-period movements.
  const openMoves = input.movements.filter((m) => m.date >= truth.open.start && m.date <= input.today);
  let openRunning = truth.open.openingCents;
  const openRate = rateOn(truth.open.start, input.rateHistory);
  for (const m of openMoves) {
    const accruedToDay = periodCharge({ start: truth.open.start, end: truth.open.end, upTo: m.date, openingCents: truth.open.openingCents, principalCents: input.principalCents, movements: openMoves, rate: openRate }).interestCents;
    openRunning = Math.max(0, openRunning + m.amountCents);
    const after = openRunning;
    events.push({ date: m.date, order: 1, emit: () => rows.push(m.amountCents < 0
      ? { kind: 'payment', date: m.date, description: 'Payment', paymentCents: -m.amountCents, interestCents: accruedToDay, principalCents: null, balanceCents: after }
      : { kind: 'advance', date: m.date, description: 'Advance', paymentCents: null, interestCents: null, principalCents: m.amountCents, balanceCents: after }) });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  for (const e of events) e.emit();

  const accrued = periodCharge({ start: truth.open.start, end: truth.open.end, upTo: input.today, openingCents: truth.open.openingCents, principalCents: input.principalCents, movements: openMoves, rate: openRate });
  const postedBalance = Math.max(0, truthBalance + openMoves.reduce((a, m) => a + m.amountCents, 0));
  const owing = postedBalance + accrued.interestCents;
  rows.push({ kind: 'accrued', date: input.today, description: `Accrued so far (${accrued.daysCounted} of ${accrued.daysInPeriod} days)`, paymentCents: null, interestCents: accrued.interestCents, principalCents: null, balanceCents: owing });

  const fullPeriod = periodCharge({ start: truth.open.start, end: truth.open.end, openingCents: postedBalance, principalCents: input.principalCents, movements: [], rate: openRate });
  const yearAt = openRate === null ? 0 : Math.floor((postedBalance * ratePpb(openRate.rateBps, openRate.basis === 'apr_daily' ? 'apr_daily' : openRate.basis) * (openRate.basis === 'apr_daily' ? 365 : 12)) / PPB + 0.5);

  return {
    rows, duePostings, dueAdjustment,
    postedBalanceCents: postedBalance, accruedCents: accrued.interestCents, owingCents: owing,
    interestThisPeriodCents: fullPeriod.interestCents,
    interestPaidToDateCents: interestPaid, principalPaidToDateCents: principalPaid,
    yearAtThisBalanceCents: yearAt,
  };
}
```

Note on `yearAtThisBalanceCents`: for `apr_monthly` and `simple_on_principal` this is `balance × bps/10000`; the test pins 1,016,736 × 10% = 101,674. Simplify the expression if the pin fails: compute `12 × chargeCents(postedBalance, ratePpb(...))` for monthly bases and `365 × chargeCents(...)` for `apr_daily`, and use `principalCents` for `simple_on_principal`. The pinned number is the authority.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/loans/ledger-build.test.ts tests/lib/loans/ledger-charge.test.ts tests/lib/loans/ledger-cycle.test.ts`
Expected: PASS. Expect to iterate on the adjustment test — the invariant to hold is `settled.postedBalanceCents === truth.postedBalanceCents`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans/ledger.ts tests/lib/loans/ledger-build.test.ts
git commit -m "feat(loans): build the ledger from facts

- due postings for closed periods, one adjustment for a late movement
- rows for the loan page, header figures"
```

---

### Task 5: `postDueInterest`, rate history readers, and `recomputeBalance` replaying postings

**Files:**
- Modify: `src/lib/loans.ts` (near `setLoanAnchor` ~line 690; `recomputeBalance` line 451; `interestFor` line 2202)
- Test: `tests/lib/loans/postings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function listRateHistory(itemId: number): RateInForce[];
  export function addRateChange(input: { itemId: number; effectiveFrom: string; rateBps: number; basis: InterestBasis; userId: number | null; at?: Date }): void;
  export function loanLedger(itemId: number, today: string): Ledger | null;   // null when no anchor or no basis
  export function postDueInterest(itemId: number, today: string, opts?: { userId?: number | null; at?: Date }): { posted: StoredPosting[]; adjusted: StoredPosting | null };
  export function postAllDueInterest(today: string, at?: Date): { items: number; posted: number; adjusted: number };
  ```
- `recomputeBalance` changes: after the newest anchor, `balance = anchor.balance + Σ signed applied movements after anchor + Σ loan_postings.interest_cents with period_end > anchor.as_of_date`. Keep the wall and the clamp exactly as they are.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/loans/postings.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from './fixtures';
import { assignTransactionToLoan, listRateHistory, addRateChange, loanLedger, postDueInterest, postAllDueInterest, setLoanAnchor } from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => c?.t.close());

function seedInterestLoan(): number {
  c = setupLoanTest();
  const { itemId } = c.seedLoan({ balanceCents: 1_000_000, principalCents: 1_000_000 });
  c.t.sqlite.prepare(`update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`).run(itemId);
  setLoanAnchor({ itemId, asOfDate: '2026-07-01', balanceCents: 1_000_000, source: 'form', userId: c.userId, at: new Date('2026-07-01T12:00:00.000Z') });
  addRateChange({ itemId, effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly', userId: c.userId });
  return itemId;
}

describe('postDueInterest (P2)', () => {
  it('posts every closed period since the anchor, oldest first, and moves the stored balance', () => {
    const itemId = seedInterestLoan();
    const r = postDueInterest(itemId, '2026-09-18');
    expect(r.posted.map((p) => [p.periodEnd, p.interestCents])).toEqual([['2026-08-01', 8_333], ['2026-09-01', 8_403]]);
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  it('is idempotent', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    expect(postDueInterest(itemId, '2026-09-18').posted).toEqual([]);
    expect(c.t.sqlite.prepare(`select count(*) as n from loan_postings where item_id = ?`).get(itemId)).toEqual({ n: 2 });
  });

  it('does nothing for a loan without a basis', () => {
    c = setupLoanTest();
    const { itemId } = c.seedLoan({ balanceCents: 1_000_000 });
    expect(postDueInterest(itemId, '2026-09-18').posted).toEqual([]);
    expect(c.balanceOf(itemId)).toBe(1_000_000);
  });

  it('a payment linked mid-period lowers the next posting (A8 second table)', () => {
    const itemId = seedInterestLoan();
    const txnId = c.spend('LENDER', -500_000, { date: '2026-07-15' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-07-15T12:00:00.000Z') });
    const r = postDueInterest(itemId, '2026-08-02');
    expect(r.posted[0]!.interestCents).toBe(6_048);
    expect(c.balanceOf(itemId)).toBe(506_048);
  });

  it('a payment linked into a closed period writes one adjustment (K2) and the balance equals the truth', () => {
    const itemId = seedInterestLoan();
    postDueInterest(itemId, '2026-09-18');
    const txnId = c.spend('LENDER', -500_000, { date: '2026-08-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-18T12:00:00.000Z') });
    const rows = c.t.sqlite.prepare(`select kind, period_end, interest_cents from loan_postings where item_id = ? order by id`).all(itemId) as { kind: string }[];
    expect(rows.map((r) => r.kind)).toEqual(['posting', 'posting', 'adjustment']);
    const ledger = loanLedger(itemId, '2026-09-18')!;
    expect(ledger.dueAdjustment).toBeNull();
    expect(c.balanceOf(itemId)).toBe(ledger.postedBalanceCents);
  });

  it('postAllDueInterest covers every loan with a basis', () => {
    const itemId = seedInterestLoan();
    c.seedLoan({ name: 'No basis', balanceCents: 500_000 });
    const r = postAllDueInterest('2026-09-18');
    expect(r).toEqual({ items: 1, posted: 2, adjusted: 0 });
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });
});

describe('rate history (R1–R2)', () => {
  it('lists rows oldest first and a change applies from its date', () => {
    const itemId = seedInterestLoan();
    addRateChange({ itemId, effectiveFrom: '2026-08-01', rateBps: 1200, basis: 'apr_monthly', userId: c.userId });
    expect(listRateHistory(itemId).map((r) => r.rateBps)).toEqual([1000, 1200]);
    const r = postDueInterest(itemId, '2026-09-18');
    expect(r.posted[1]!.interestCents).toBe(10_083);
    expect(c.t.sqlite.prepare(`select interest_rate_bps from warranty_items where id = ?`).get(itemId)).toEqual({ interest_rate_bps: 1200 });
  });
});
```

Check `setLoanAnchor`'s actual parameter names at `src/lib/loans.ts:690` and match them; the shape above is illustrative of intent (item, as-of date, balance, source, user, time).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/loans/postings.test.ts`
Expected: FAIL — `postDueInterest` is not exported.

- [ ] **Step 3: Implement in `src/lib/loans.ts`**

Imports: `loanPostings`, `loanRateHistory` from `@/db/schema`; `buildLedger`, `postingDayFor`, type `Ledger`, `RateInForce`, `StoredPosting` from `@/lib/loans/ledger`.

```ts
export function listRateHistory(itemId: number): RateInForce[] {
  return getDb()
    .select({ effectiveFrom: loanRateHistory.effectiveFrom, rateBps: loanRateHistory.rateBps, basis: loanRateHistory.basis })
    .from(loanRateHistory)
    .where(eq(loanRateHistory.itemId, itemId))
    .orderBy(asc(loanRateHistory.effectiveFrom), asc(loanRateHistory.id))
    .all();
}

/** R2: a history row AND the item's current rate, in one transaction, then post what is now due. */
export function addRateChange(input: { itemId: number; effectiveFrom: string; rateBps: number; basis: InterestBasis; userId: number | null; at?: Date }): void {
  const at = input.at ?? new Date();
  const db = getDb();
  db.transaction((tx) => {
    tx.insert(loanRateHistory).values({ itemId: input.itemId, effectiveFrom: input.effectiveFrom, rateBps: input.rateBps, basis: input.basis, createdAt: at.toISOString(), createdByUserId: input.userId }).run();
    tx.update(warrantyItems).set({ interestRateBps: input.rateBps, interestRateBasis: input.basis, updatedAt: at.toISOString() }).where(eq(warrantyItems.id, input.itemId)).run();
  });
  postDueInterest(input.itemId, todayIso(at), { userId: input.userId, at });
}

function ledgerFacts(tx: Tx, itemId: number, today: string): { input: LedgerInput; direction: 'owed' | 'lent' } | null {
  // Newest anchor (start point), item fields, rate history, stored postings after the anchor,
  // movements after the anchor (the wall: movementsBetween already applies it).
  // ...select item (purchaseDate, principalCents, postingDay, loanDirection, interestRateBasis)
  // ...if no anchor or basis === null return null
  // movements: signed in the loan frame via loanSignedDelta over loan_payments joined to transactions, date > anchor.asOfDate
  // stored: loan_postings rows with period_end > anchor.asOfDate, mapped to StoredPosting
  // return { input: { startDate, startBalanceCents, principalCents, postingDay: postingDayFor(purchaseDate, postingDay), rateHistory, movements, stored, today }, direction }
}

export function loanLedger(itemId: number, today: string): Ledger | null {
  const facts = ledgerFacts(getDb(), itemId, today);
  return facts === null ? null : buildLedger(facts.input);
}

export function postDueInterest(itemId: number, today: string, opts: { userId?: number | null; at?: Date } = {}): { posted: StoredPosting[]; adjusted: StoredPosting | null } {
  const at = (opts.at ?? new Date()).toISOString();
  const db = getDb();
  return db.transaction((tx) => {
    const facts = ledgerFacts(tx, itemId, today);
    if (facts === null) return { posted: [], adjusted: null };
    const ledger = buildLedger(facts.input);
    for (const p of ledger.duePostings) {
      tx.insert(loanPostings).values({ itemId, ...toRow(p), createdAt: at, createdByUserId: opts.userId ?? null }).onConflictDoNothing().run();
    }
    if (ledger.dueAdjustment !== null) {
      tx.insert(loanPostings).values({ itemId, ...toRow(ledger.dueAdjustment), createdAt: at, createdByUserId: opts.userId ?? null }).run();
    }
    if (ledger.duePostings.length > 0 || ledger.dueAdjustment !== null) {
      const item = /* select direction + current balance as recomputeBalance's other callers do */;
      recomputeBalance(tx, itemId, item.direction, item.balance);
    }
    return { posted: ledger.duePostings, adjusted: ledger.dueAdjustment };
  });
}

export function postAllDueInterest(today: string, at: Date = new Date()): { items: number; posted: number; adjusted: number } {
  const ids = getDb().select({ id: warrantyItems.id }).from(warrantyItems).where(isNotNull(warrantyItems.interestRateBasis)).all();
  let posted = 0; let adjusted = 0; let items = 0;
  for (const { id } of ids) {
    const r = postDueInterest(id, today, { at });
    if (r.posted.length > 0 || r.adjusted !== null) items += 1;
    posted += r.posted.length;
    if (r.adjusted !== null) adjusted += 1;
  }
  return { items, posted, adjusted };
}
```

`toRow(p: StoredPosting)` maps camelCase to the Drizzle insert shape (same names). `Tx` is whatever type `recomputeBalance` already takes for its first parameter.

`recomputeBalance` change (line ~451): where it computes the replayed balance from the anchor, add the sum of `loan_postings.interest_cents` for rows with `period_end > anchor.as_of_date` (both kinds). Keep the wall and the `applied_cents` clamp untouched. Read the existing function fully before editing; the addition is one query and one `+=`.

Wire P4: at the end of `assignTransactionToLoan`, `unassignTransactionFromLoan`, `applyPaymentMatchers` (per item touched), `reverseLoanLinksForTransactions` (per item touched), and `setLoanAnchor`, call `postDueInterest(itemId, todayIso(at), { at })` **after** the existing transaction commits (not inside it — `postDueInterest` opens its own).

- [ ] **Step 4: Run to verify pass, then the existing loan suites**

Run: `npx vitest run tests/lib/loans/postings.test.ts`
Then: `npx vitest run tests/lib/loans tests/lib/loan-payoff.test.ts tests/ops/loan-invariants.test.ts`
Expected: PASS except guard G1 (rate arithmetic now in `ledger.ts`) and possibly G3 — fixed in Task 13; note the failures and continue.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans.ts tests/lib/loans/postings.test.ts
git commit -m "feat(loans): post due interest and keep rate history

- postDueInterest writes closed periods and one adjustment
- recomputeBalance replays postings after the anchor
- linked payments and reconciles post what is due"
```

---

### Task 6: Scheduler call sites (P3) and `loan_paid_off` raise (N5)

**Files:**
- Modify: `src/lib/backup.ts:173` (`runNightlyJob`), `src/lib/scheduler.ts:66` (`runNotifyTick`)
- Modify: `src/lib/notify/raise.ts`, `src/lib/notify/events.ts`, `src/lib/notify/render.ts`
- Modify: `src/lib/loans.ts` (`recomputeBalance` zero-crossing)
- Test: `tests/lib/scheduler-postings.test.ts`, `tests/notify/loan-paid-off.test.ts` (place under whatever directory holds the existing `raise*` tests — `grep -rl raiseBackupFailed tests`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/scheduler-postings.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from './loans/fixtures';
import { runNightlyJob } from '@/lib/backup';
import { runNotifyTick } from '@/lib/scheduler';
import { setLoanAnchor, addRateChange } from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => { c?.t.close(); vi.restoreAllMocks(); });

function seed(): number {
  c = setupLoanTest();
  const { itemId } = c.seedLoan({ balanceCents: 1_000_000, principalCents: 1_000_000 });
  c.t.sqlite.prepare(`update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`).run(itemId);
  setLoanAnchor({ itemId, asOfDate: '2026-07-01', balanceCents: 1_000_000, source: 'form', userId: c.userId, at: new Date('2026-07-01T12:00:00.000Z') });
  addRateChange({ itemId, effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly', userId: c.userId, at: new Date('2026-07-01T12:00:00.000Z') });
  // addRateChange posts through 2026-07-01: nothing is due yet.
  return itemId;
}

describe('P3: the scheduler posts due interest', () => {
  it('the nightly job posts before it backs up', () => {
    const itemId = seed();
    runNightlyJob(new Date('2026-09-18T02:00:00.000Z'));
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  it('the boot tick catches up a machine that was off', () => {
    const itemId = seed();
    runNotifyTick(new Date('2026-09-18T09:00:00.000Z'), { atBoot: true });
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });
});
```

```ts
// tests/notify/loan-paid-off.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from '../lib/loans/fixtures';
import { assignTransactionToLoan } from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => c?.t.close());

describe('N5: loan_paid_off', () => {
  it('is raised once when the posted balance reaches zero', () => {
    c = setupLoanTest();
    const { itemId } = c.seedLoan({ balanceCents: 50_000 });
    const txnId = c.spend('LENDER', -50_000, { date: '2026-09-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-10T12:00:00.000Z') });
    const rows = c.t.sqlite.prepare(`select event_id, dedup_key from notification_outbox where event_id = 'loan_paid_off'`).all();
    expect(rows).toEqual([{ event_id: 'loan_paid_off', dedup_key: `loan:paidoff:${itemId}` }]);
  });
});
```

The outbox table/column names: confirm in `src/db/schema.ts` (`grep -n "notification_outbox\|outbox" src/db/schema.ts`). A target must be enabled for a row to be written; look at how `tests` for `raiseBackupFailed` arrange that and copy the arrangement.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/scheduler-postings.test.ts tests/notify/loan-paid-off.test.ts`
Expected: FAIL — balance stays 1,000,000; no outbox row.

- [ ] **Step 3: Implement**

`src/lib/backup.ts` `runNightlyJob`, first statement:

```ts
  // Ledger spec P3: post due interest BEFORE the backup so tonight's archive holds tonight's postings.
  try {
    const r = postAllDueInterest(todayIso(at), at);
    if (r.posted > 0 || r.adjusted > 0) console.log(`[loans] posted ${r.posted} period(s), ${r.adjusted} adjustment(s) on ${r.items} loan(s)`);
  } catch (error) {
    console.error('[loans] posting due interest failed; backup will still run', error);
  }
```

Check `backup.ts` does not already import from `loans.ts` in a way that creates a cycle; if it does, put the call in `runNightlyTick` in `scheduler.ts` before `runNightlyJob(now)` instead.

`src/lib/scheduler.ts` `runNotifyTick`: inside the `try`, when `options?.atBoot`, before the evaluators run:

```ts
    if (options?.atBoot) {
      try {
        postAllDueInterest(todayIso(now), now);
      } catch (error) {
        console.error('[loans] boot catch-up of due interest failed', error);
      }
    }
```

Event (N5) in `events.ts`, appended:

```ts
  {
    id: 'loan_paid_off',
    label: 'A loan is paid off',
    blurb: 'The balance on a loan reached zero.',
    audience: 'all',
    trigger: 'immediate',
    defaultEnabled: true,
    householdEligible: true,
  },
```

`raise.ts`:

```ts
export function raiseLoanPaidOff(input: { itemId: number; itemName: string; ownerUserId: number; direction: 'owed' | 'lent'; at: Date }): void {
  try {
    const rendered = renderEvent({ event: 'loan_paid_off', itemName: input.itemName, direction: input.direction });
    enqueue({ userId: input.ownerUserId, eventId: 'loan_paid_off', dedupKey: `loan:paidoff:${input.itemId}`, subject: rendered.subject, body: rendered.body, at: input.at });
  } catch (error) {
    console.error('[notify] loan_paid_off failed', error);
  }
}
```

Follow `raiseBackupFailed` for the household routing call it makes, if any. `render.ts` union member and case:

```ts
  | { event: 'loan_paid_off'; itemName: string; direction: 'owed' | 'lent' }
...
    case 'loan_paid_off':
      return {
        subject: `${truncateText(input.itemName, NAME_MAX)} is paid off`,
        body: input.direction === 'lent'
          ? `${truncateText(input.itemName, NAME_MAX)} has been repaid in full.`
          : `${truncateText(input.itemName, NAME_MAX)} has a zero balance. Nothing more is owed.`,
      };
```

In `recomputeBalance`: capture the previous stored balance before the update; after writing, if `previous > 0 && balance === 0`, call `raiseLoanPaidOff` **after** the enclosing transaction commits (return a flag and let the callers `postDueInterest`/`link`/`unlink` raise it; `recomputeBalance` runs inside `tx`). The direction literal comparison lives in `render.ts`, not `loans.ts` (P4).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/scheduler-postings.test.ts tests/notify/loan-paid-off.test.ts tests/lib/scheduler.test.ts tests/lib/backup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup.ts src/lib/scheduler.ts src/lib/loans.ts src/lib/notify/events.ts src/lib/notify/raise.ts src/lib/notify/render.ts tests/lib/scheduler-postings.test.ts tests/notify/loan-paid-off.test.ts
git commit -m "feat(loans): scheduler posts due interest; paid-off event

- nightly job and boot tick call postAllDueInterest
- loan_paid_off raised once at zero"
```

---

### Task 7: Form and item-layer changes (D1–D6)

**Files:**
- Modify: `src/lib/warranty/items.ts:405` (`assertInterestBasisIsUsable`), `createWarrantyItem` (~489), `updateWarrantyItem` (~558), `WarrantyInput` (~140)
- Modify: `src/app/(app)/warranties/actions.ts` (item create/update parsing, ~line 326 area and `readInterestRateBasis`)
- Modify: `src/app/(app)/warranties/new/new-warranty-client.tsx:425-470`, `src/app/(app)/warranties/[id]/warranty-detail-client.tsx:1360-1410` and the balance card ~line 582
- Test: `tests/lib/warranty/items-interest.test.ts` (or extend the existing items test file), `tests/app/warranties-new-form.test.tsx`, `tests/app/warranty-detail-loan.test.tsx` (find the existing files with `grep -rl "How the rate is charged" tests`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/warranty/items-interest.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from '../loans/fixtures';
import { createWarrantyItem } from '@/lib/warranty/items';
import { listLoanAnchors, listRateHistory } from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => c?.t.close());

const loanInput = (over: Record<string, unknown> = {}) => ({
  name: 'Test', purchaseDate: '2026-07-01', isLifetime: false, ownerUserId: c.userId, typeId: c.typeId,
  principalCents: 1_000_000, interestRateBps: 1000, interestRateBasis: 'apr_monthly', currentBalanceCents: 1_000_000, balanceAsOfDate: '2026-07-01',
  ...over,
});

describe('D1: a rate needs a basis', () => {
  it('rejects a rate with no basis', () => {
    c = setupLoanTest();
    expect(() => createWarrantyItem(loanInput({ interestRateBasis: null }) as never)).toThrow(/how it is charged/i);
  });
});

describe('D3: the form writes the first anchor and rate history', () => {
  it('anchors at the chosen as-of date and posts through today', () => {
    c = setupLoanTest();
    const id = createWarrantyItem(loanInput() as never, [], '2026-09-18T12:00:00.000Z');
    const anchors = listLoanAnchors(id);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.asOfDate).toBe('2026-07-01');
    expect(anchors[0]!.source).toBe('form');
    expect(listRateHistory(id)).toEqual([{ effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly' }]);
    expect(c.balanceOf(id)).toBe(1_016_736);
  });
});
```

Component tests (RTL), in the existing new-loan form test file:

```tsx
it('D1: the basis select has no "Not set" option once a rate is typed, and defaults to yearly', async () => {
  render(<NewWarrantyClient {...loanProps} />);
  await user.type(screen.getByLabelText(/interest rate/i), '10');
  const select = screen.getByLabelText(/how the rate is charged/i) as HTMLSelectElement;
  expect(select.value).toBe('apr_monthly');
  expect(within(select).queryByText(/not set/i)).toBeNull();
});

it('D3: the balance field carries an as-of date defaulting to the borrowed date', async () => {
  render(<NewWarrantyClient {...loanProps} />);
  await user.type(screen.getByLabelText(/borrowed on/i), '2026-07-01');
  expect((screen.getByLabelText(/balance as of/i) as HTMLInputElement).value).toBe('2026-07-01');
});
```

Detail page test:

```tsx
it('D2: a rate without a basis shows the banner', () => {
  render(<WarrantyDetailClient {...props({ interestRateBps: 1000, interestRateBasis: null })} />);
  expect(screen.getByText('This loan has a rate but no charging method. Pick one to see interest.')).toBeInTheDocument();
});

it('D5: "You set this on" shows the anchor date, not the UTC timestamp', () => {
  render(<WarrantyDetailClient {...props({ balanceUpdatedAt: '2026-09-19T01:30:00.000Z' })} anchors={[{ asOfDate: '2026-09-18', /* … */ }]} />);
  expect(screen.getByText(/You set this on 2026-09-18/)).toBeInTheDocument();
});

it('D4: the balance is read-only once an anchor exists', () => {
  render(<WarrantyDetailClient {...props()} anchors={[{ asOfDate: '2026-09-01', /* … */ }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText(/balance/i)).toHaveAttribute('readonly');
  expect(screen.getByText(/Set by your last statement of 2026-09-01\. Reconcile to change it\./)).toBeInTheDocument();
});
```

Match each test's prop shape to the existing tests in the same file; the assertions are what the plan fixes.

- [ ] **Step 2: Run to verify failure**

Run the three files. Expected: FAIL for each new case.

- [ ] **Step 3: Implement**

`items.ts`:
- `WarrantyInput` gains `balanceAsOfDate?: string | null` and `postingDay?: number | null`.
- `assertInterestBasisIsUsable`: before the `basis === null` return, add
  ```ts
  if (basis === null && values.interestRateBps !== null && values.interestRateBps !== 0) {
    throw new Error('Say how the rate is charged. A rate on its own cannot be turned into interest.');
  }
  ```
- `createWarrantyItem`: after the item row is inserted and the transaction commits, when `kind === 'loan'` and `currentBalanceCents !== null`: `setLoanAnchor({ itemId, asOfDate: input.balanceAsOfDate ?? input.purchaseDate, balanceCents: currentBalanceCents, source: 'form', … })`; when `interestRateBasis !== null`: `addRateChange({ itemId, effectiveFrom: that same date, rateBps, basis, userId })` (which posts through today). Both go in the `deferred` list the function already keeps for post-commit work.
- `updateWarrantyItem`: when `interestRateBps` or `interestRateBasis` changed and basis is non-null: `addRateChange` with `effectiveFrom: input.rateEffectiveFrom ?? today`. When an anchor exists, ignore an incoming `currentBalanceCents` (D4). Persist `postingDay`.

`actions.ts`: parse `balanceAsOfDate`, `postingDay` (1–31 or null), `rateEffectiveFrom` (YYYY-MM-DD or null) from the form; pass through. `readInterestRateBasis` returns `'apr_monthly'` when the rate is non-empty and the select value is `''`.

`new-warranty-client.tsx`: replace the basis select with one whose options omit `''` when `interestRate.trim() !== ''`, `value` state defaulting to `'apr_monthly'`; change the balance field label to "Balance as of" with a sibling `<input type="date" name="balanceAsOfDate">` defaulting to the borrowed date (update in `onChange` of purchaseDate while the balance is empty or equals the original).

`warranty-detail-client.tsx`: banner (D2) above the balance card when `item.interestRateBps !== null && item.interestRateBasis === null` with a link to the Edit section; "You set this on" reads `anchors.at(-1)?.asOfDate` (the page already passes anchors for the reconciliation history — check the prop name); Edit form: balance `readOnly` with the D4 sentence when anchors exist; "Interest posts on day" numeric input `name="postingDay"` (D6); "Effective from" date `name="rateEffectiveFrom"` shown when rate or basis differ from the saved values.

- [ ] **Step 4: Run the three files plus the actions tests**

Run: `npx vitest run tests/lib/warranty tests/app/warranties-new-form.test.tsx tests/app/warranty-detail-loan.test.tsx "tests/app/(app)/warranties"`
Expected: PASS. Existing tests that relied on saving a rate with no basis need a basis added to their fixture — that is a spec change (D1), so update them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/warranty/items.ts "src/app/(app)/warranties" tests/lib/warranty tests/app
git commit -m "feat(loans): rate needs a basis; form writes the first anchor

- basis defaults to yearly once a rate is typed
- balance as of a date, posting day, effective-from
- banner for a rate with no basis; anchor date on the balance card"
```

---

### Task 8: `LoanLedgerCard` (U1–U8)

**Files:**
- Create: `src/components/LoanLedgerCard.tsx`
- Modify: `src/app/(app)/warranties/[id]/page.tsx` (compute `loanLedger(itemId, today)` and pass it), `warranty-detail-client.tsx` (~line 653: replace `LoanInterestCard` with the new card above "Linked transactions")
- Delete: `src/components/LoanInterestCard.tsx` and its test once the new card carries the header figures
- Modify: `src/lib/loans/basis-labels.ts` (`INTEREST_WORDING` gains `posted`, `paid`, `accrued` verbs)
- Test: `tests/components/loan-ledger-card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/components/loan-ledger-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { LoanLedgerCard } from '@/components/LoanLedgerCard';
import type { Ledger } from '@/lib/loans/ledger';

const ledger: Ledger = {
  rows: [
    { kind: 'opening', date: '2026-07-01', description: 'Opening balance', paymentCents: null, interestCents: null, principalCents: null, balanceCents: 1_000_000 },
    { kind: 'payment', date: '2026-07-15', description: 'Payment', paymentCents: 500_000, interestCents: 3_763, principalCents: null, balanceCents: 500_000 },
    { kind: 'interest', date: '2026-08-01', description: 'Interest posted. Of 5000.00 paid this period, 60.48 covered interest.', paymentCents: null, interestCents: 6_048, principalCents: null, balanceCents: 506_048, detail: { rateBps: 1000, basis: 'apr_monthly', averageDailyBalanceCents: 725_806, daysCounted: 31, daysInPeriod: 31, paidToInterestCents: 6_048 } },
    { kind: 'accrued', date: '2026-08-18', description: 'Accrued so far (17 of 31 days)', paymentCents: null, interestCents: 2_312, principalCents: null, balanceCents: 508_360 },
  ],
  duePostings: [], dueAdjustment: null,
  postedBalanceCents: 506_048, accruedCents: 2_312, owingCents: 508_360,
  interestThisPeriodCents: 4_217, interestPaidToDateCents: 6_048, principalPaidToDateCents: 493_952, yearAtThisBalanceCents: 50_605,
};

describe('LoanLedgerCard', () => {
  it('shows the header figures with the spec names (P6, U4)', () => {
    render(<LoanLedgerCard ledger={ledger} direction="owed" />);
    expect(screen.getByText('Balance').nextSibling).toHaveTextContent('$5,060.48');
    expect(screen.getByText('Accrued so far').nextSibling).toHaveTextContent('$23.12');
    expect(screen.getByText('Owing today').nextSibling).toHaveTextContent('$5,083.60');
    expect(screen.getByText('A year at this balance').nextSibling).toHaveTextContent('$506.05');
  });

  it('renders one row per ledger entry, oldest first, with the six columns (U2)', () => {
    render(<LoanLedgerCard ledger={ledger} direction="owed" />);
    const table = screen.getByRole('table', { name: /ledger/i });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'Description', 'Payment', 'Interest', 'Principal', 'Balance']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('$5,000.00');
    expect(rows[1]).toHaveTextContent('$37.63');
    expect(rows[3]).toHaveTextContent('Accrued so far');
  });

  it('"By month" collapses to one row per posting period (U5)', () => {
    render(<LoanLedgerCard ledger={ledger} direction="owed" />);
    fireEvent.click(screen.getByRole('switch', { name: /by month/i }));
    const rows = within(screen.getByRole('table', { name: /ledger/i })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2); // Jul 1–Aug 1, and the open period
  });

  it('lent wording (U6)', () => {
    render(<LoanLedgerCard ledger={ledger} direction="lent" />);
    expect(screen.getByText(/Interest earned/)).toBeInTheDocument();
  });

  it('the hover detail on an interest row names rate, basis, average balance and days (U8)', () => {
    render(<LoanLedgerCard ledger={ledger} direction="owed" />);
    expect(screen.getByTitle(/10\.00% .* \$7,258\.06 .* 31 days/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/components/loan-ledger-card.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`LoanLedgerCard.tsx` (client component): props `{ ledger: Ledger; direction: 'owed' | 'lent'; downloadHref?: string }`. Header: a `dl` of the seven figures in the spec's order using `formatCents`. Table `aria-label="Ledger"`, `<thead>` with the six headers, rows from `ledger.rows`; interest-row description replaces "Interest posted" with `INTEREST_WORDING[direction].posted`; `title` on interest rows: `` `${formatRateBps(rateBps)}% ${BASIS_LABELS[basis]} on an average balance of ${formatCents(averageDailyBalanceCents)} over ${daysCounted} days` ``. `accrued` row italic (`className="italic text-muted"`). "By month" `role="switch"` collapses rows into periods: group by consecutive rows up to and including each `interest` row, plus the tail; each group row shows period start–end, payments sum, interest, closing balance. "Download CSV" is a link to `downloadHref` when provided (Task 9 adds the route). Print: `print:hidden` on everything but the table.

`page.tsx`: `const ledger = loanLedger(item.id, today)`; pass `ledger` to the client; the client renders `<LoanLedgerCard>` when `ledger !== null`, else, when `interestRateBps !== null`, the D2 banner already covers it.

Remove `LoanInterestCard` and its imports; move any test assertions still relevant (claim wording by state) into the new test file.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/components/loan-ledger-card.test.tsx tests/app/warranty-detail-loan.test.tsx tests/ops/client-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/LoanLedgerCard.tsx "src/app/(app)/warranties/[id]" src/lib/loans/basis-labels.ts tests/components
git rm -q src/components/LoanInterestCard.tsx tests/components/loan-interest-card.test.tsx
git commit -m "feat(loans): the ledger card

- bank-statement rows, header figures, by-month toggle
- replaces LoanInterestCard"
```

---

### Task 9: Ledger CSV download (U7)

**Files:**
- Create: `src/app/api/loans/[id]/ledger.csv/route.ts`
- Modify: `src/lib/reports.ts` (reuse `toCsv`), `LoanLedgerCard` (`downloadHref`)
- Test: `tests/api/loan-ledger-csv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from '../lib/loans/fixtures';
import { GET } from '@/app/api/loans/[id]/ledger.csv/route';
import { setLoanAnchor, addRateChange } from '@/lib/loans';

let c: LoanTestContext;
afterEach(() => c?.t.close());

it('returns the visible rows as CSV with a BOM', async () => {
  c = setupLoanTest();
  const { itemId } = c.seedLoan({ balanceCents: 1_000_000, principalCents: 1_000_000 });
  c.t.sqlite.prepare(`update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`).run(itemId);
  setLoanAnchor({ itemId, asOfDate: '2026-07-01', balanceCents: 1_000_000, source: 'form', userId: c.userId, at: new Date('2026-07-01T12:00:00.000Z') });
  addRateChange({ itemId, effectiveFrom: '2026-07-01', rateBps: 1000, basis: 'apr_monthly', userId: c.userId, at: new Date('2026-09-18T12:00:00.000Z') });
  const res = await GET(c.authedRequest(`http://test/api/loans/${itemId}/ledger.csv`), { params: Promise.resolve({ id: String(itemId) }) });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain('Date,Description,Payment,Interest,Principal,Balance');
  expect(text).toContain('2026-08-01,Interest posted,,83.33,,10083.33');
});
```

`c.authedRequest` — use whatever the existing API tests use to build an authenticated `Request` (`grep -rn "userFromRequest" tests/api | head`).

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** the route: auth as in `statement-prefill/route.ts` (session, self-scoped check, viewer may see the item), `loanLedger(id, todayIso())`, 404 when null, `toCsv(rows, columns)` with dollars as `(cents/100).toFixed(2)` and blanks for nulls, response headers `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="loan-<id>-ledger.csv"`, body prefixed with `﻿`. Card: `downloadHref={`/api/loans/${item.id}/ledger.csv`}`.

- [ ] **Step 4: Run to verify pass**, plus `tests/ops/api-auth.test.ts` if there is a guard enumerating API routes.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/loans tests/api/loan-ledger-csv.test.ts src/components/LoanLedgerCard.tsx
git commit -m "feat(loans): ledger CSV download"
```

---

### Task 10: Notification events, renderers, evaluators (N1–N4, N6–N9)

**Files:**
- Modify: `src/lib/notify/events.ts`, `src/lib/notify/render.ts`, `src/lib/notify/evaluate/coming-due.ts`, `src/lib/notify/evaluate/index.ts`
- Create: `src/lib/notify/evaluate/loans.ts`, `src/lib/notify/evaluate/goals.ts`
- Modify: `src/lib/loans.ts` (`postDueInterest` raises `loan_interest_posted`), `src/app/(app)/settings/notifications/notifications-client.tsx` (group), `page.tsx`
- Test: `tests/notify/evaluate-loans.test.ts`, `tests/notify/evaluate-goals.test.ts`, `tests/notify/coming-due-recurring.test.ts`, `tests/notify/render-loans.test.ts`, settings page test

- [ ] **Step 1: Write the failing tests**

Event catalogue:

```ts
// tests/notify/events-loans.test.ts
import { NOTIFICATION_EVENTS, eventDef } from '@/lib/notify/events';
it('the six new events exist with the spec triggers and defaults', () => {
  expect(eventDef('loan_interest_posted')).toMatchObject({ label: 'Interest was added to a loan', trigger: 'tick', defaultEnabled: true, householdEligible: true });
  expect(eventDef('loan_payment_missed')).toMatchObject({ label: 'No payment on a loan this period', trigger: 'daily_slot', defaultEnabled: true });
  expect(eventDef('loan_reconcile_due')).toMatchObject({ label: 'Time to check a loan against its statement', trigger: 'daily_slot', defaultEnabled: false });
  expect(eventDef('loan_paid_off')).toMatchObject({ label: 'A loan is paid off', trigger: 'immediate', defaultEnabled: true });
  expect(eventDef('goal_reached')).toMatchObject({ label: 'You reached a savings goal', trigger: 'tick', defaultEnabled: true });
  expect(eventDef('goal_off_pace')).toMatchObject({ label: 'A savings goal is behind pace', trigger: 'daily_slot', defaultEnabled: false });
  expect(eventDef('coming_due')!.blurb).toMatch(/recurring/i);
});
```

Evaluators (shape follows the existing `tests/notify/*coming-due*` tests — copy their arrangement of users, targets and time):

```ts
// tests/notify/evaluate-loans.test.ts
describe('loan_interest_posted (N2)', () => {
  it('one message per tick naming every loan that posted, keyed by item and period', () => {
    // seed two interest loans, call postAllDueInterest('2026-09-18'), then read outbox rows for the owner
    // expect exactly one loan_interest_posted row whose dedup_key contains `loan:posted:${a}:2026-09-01` and `loan:posted:${b}:2026-09-01`
    // expect body to contain 'Interest added:' and both names with amounts and balances
  });
});
describe('loan_payment_missed (N3)', () => {
  it('fires once per closed period with no payment, with lent wording', () => {
    // seed a lent loan with basis none, anchor 2026-07-01, run evaluateLoanPaymentMissed for 2026-09-18
    // expect one row, dedup_key `loan:missed:${itemId}:2026-09-01`, body matching /nothing received for/
    // run again: no second row
  });
  it('does not fire when a payment is linked inside the period', () => { /* … */ });
});
describe('loan_reconcile_due (N4)', () => {
  it('fires monthly when the newest anchor is older than two months', () => {
    // anchor 2026-06-01, basis set, evaluate for 2026-09-18 -> key `loan:stale:${itemId}:2026-09`
  });
});
```

```ts
// tests/notify/evaluate-goals.test.ts
describe('goal_reached / goal_off_pace (N6)', () => {
  it('goal_reached fires once when pace.met is true', () => { /* createGoal target 1000, addContribution 1000, evaluateGoals -> key `goal:met:${goalId}`; again -> no new row */ });
  it('goal_off_pace fires monthly when required monthly exceeds average by more than 25%', () => { /* target 120000 due 2027-09-01, one contribution of 1000 six months ago -> key `goal:pace:${goalId}:2026-09` */ });
});
```

```ts
// tests/notify/coming-due-recurring.test.ts
it('N1: an untracked recurring charge inside the window joins the coming-due message', () => {
  // three monthly charges of 1599 on the 20th (Jun, Jul, Aug 2026), evaluate on 2026-09-15 with comingDueDays 7
  // expect body to contain 'usually charges about $15.99 around 2026-09-20'
});
it('a tracked recurring charge is not repeated', () => { /* same, but create a bill item covering the merchant -> body does not mention it */ });
```

Settings page test: the six labels render under a heading "Loans and goals".

- [ ] **Step 2: Run to verify failure** — events undefined, evaluators missing.

- [ ] **Step 3: Implement**

`events.ts`: append the five remaining defs (N5's `loan_paid_off` was added in Task 6) with the spec's labels; blurbs:

| id | blurb |
|---|---|
| `loan_interest_posted` | `Interest was added to a loan's balance for the period that just closed. One message per night naming every loan.` |
| `loan_payment_missed` | `A loan's posting day passed with no payment recorded for the period.` |
| `loan_reconcile_due` | `A loan with a rate has not been checked against a statement for two months.` |
| `goal_reached` | `A savings goal reached its target.` |
| `goal_off_pace` | `A savings goal with a target date needs more per month than you have been putting in.` |

Update `coming_due.blurb` to: `A warranty, subscription, contract or loan reaches its date soon, a bill installment is due, or a recurring charge is expected. One message listing everything.`

`render.ts` union members and cases:

```ts
  | { event: 'loan_interest_posted'; loans: { name: string; interestCents: number; balanceCents: number; adjusted: boolean }[] }
  | { event: 'loan_payment_missed'; loans: { name: string; periodStart: string; periodEnd: string; direction: 'owed' | 'lent' }[] }
  | { event: 'loan_reconcile_due'; loans: { name: string; lastStatement: string }[] }
  | { event: 'goal_reached'; goalName: string; targetCents: number }
  | { event: 'goal_off_pace'; goalName: string; requiredMonthlyCents: number; avgMonthlyCents: number; targetDate: string }
```

```ts
    case 'loan_interest_posted': {
      const lines = input.loans.map((l) => `${truncateText(l.name, NAME_MAX)} ${l.adjusted ? 'adjusted' : ''}${formatCents(l.interestCents)} (balance ${formatCents(l.balanceCents)})`.replace('  ', ' '));
      return { subject: input.loans.length === 1 ? `Interest added: ${lines[0]}` : `Interest added to ${input.loans.length} loans`, body: ['Interest added:', ...lines].join('\n') };
    }
    case 'loan_payment_missed': {
      const lines = input.loans.map((l) => l.direction === 'lent'
        ? `${truncateText(l.name, NAME_MAX)}: nothing received for ${l.periodStart} – ${l.periodEnd}.`
        : `No payment was recorded on ${truncateText(l.name, NAME_MAX)} for ${l.periodStart} – ${l.periodEnd}.`);
      return { subject: input.loans.length === 1 ? lines[0]! : `${input.loans.length} loans had no payment this period`, body: lines.join('\n') };
    }
    case 'loan_reconcile_due': {
      const lines = input.loans.map((l) => `${truncateText(l.name, NAME_MAX)}: last statement ${l.lastStatement}.`);
      return { subject: 'Time to check a loan against its statement', body: [...lines, '', 'Open the loan and use Reconcile to a statement.'].join('\n') };
    }
    case 'goal_reached':
      return { subject: `You reached ${truncateText(input.goalName, NAME_MAX)}`, body: `${truncateText(input.goalName, NAME_MAX)} hit its ${formatCents(input.targetCents)} target.` };
    case 'goal_off_pace':
      return { subject: `${truncateText(input.goalName, NAME_MAX)} is behind pace`, body: `Reaching it by ${input.targetDate} needs ${formatCents(input.requiredMonthlyCents)} a month; the average so far is ${formatCents(input.avgMonthlyCents)}.` };
```

Add a `coming_due` `variant: 'recurring'` entry `{ merchant, typicalCents, expectedDate }` rendered as `${merchant} usually charges about ${formatCents(typicalCents)} around ${expectedDate}.` inside `renderComingDueBatch`.

`evaluate/loans.ts`:

```ts
export function raiseInterestPosted(input: { at: Date; posted: { itemId: number; ownerUserId: number; name: string; interestCents: number; balanceCents: number; periodEnd: string; adjusted: boolean }[] }): void
// groups by ownerUserId; one enqueue per owner with eventId 'loan_interest_posted', dedupKey = 'loan:posted:batch:' + keys.join(','), keys = `loan:posted:${itemId}:${periodEnd}`; household pass as coming-due does.

export function evaluateLoanPaymentMissed(input: { userId: number; now: Date; tz: string }): number
// for each loan owned by userId with a basis: newest posting row of kind 'posting' whose period_end <= today; if paymentsCents === 0 and no key `loan:missed:${itemId}:${periodEnd}` already enqueued -> candidate. One message, MUST-6.13 cap, batch key like comingDueBatchKey.

export function evaluateLoanReconcileDue(input: { userId: number; now: Date; tz: string }): number
// loans with a basis whose newest anchor.asOfDate < addMonths(monthOf(today), -2) + '-01' -> key `loan:stale:${itemId}:${today.slice(0,7)}`.
```

`postDueInterest` collects `{ posted, adjusted }` and, after commit, calls `raiseInterestPosted` when anything was written (`postAllDueInterest` collects across items and raises once per owner).

`evaluate/goals.ts`:

```ts
export function evaluateGoals(input: { userId: number; now: Date; tz: string }): number
// listGoals({ today }, viewerFor(userId)) -> for met: key `goal:met:${id}` immediate-style enqueue under 'goal_reached';
// for pace: targetDate !== null && !met && requiredMonthlyCents !== null && requiredMonthlyCents > avgMonthlyCents * 1.25 -> key `goal:pace:${id}:${YYYY-MM}` under 'goal_off_pace'.
```

`evaluate/coming-due.ts`: third source before the item-expiry loop: `recurringCharges({ today, ownerUserId: input.userId, viewer })` filtered to `tracked === null`, `expected = addCadence(lastDate, cadence)` (write `addCadence` next to it: monthly → `addMonthsClamped(lastDate, 1)`, weekly → +7 days, yearly → +12 months; other cadences skipped), keep when `today <= expected <= horizon`, key `recurring:${merchant}:${expected}`, entry `{ kind: 'recurring', … }`.

`evaluate/index.ts`: in the per-user daily loop add `evaluateLoanPaymentMissed`, `evaluateLoanReconcileDue`, `evaluateGoals` after `evaluateStaleImport`; in the household pass (where `evaluateSubscriptionCreep({ userId: null, … })` is called) add the same three with `userId: null` if the existing pattern supports it, else only per user.

Settings: in `notifications-client.tsx` where `data.events.map(...)` renders (line ~1091), group by a new `group` field; add `group: 'loans-goals'` to the six defs and `group: 'general'` default; render a heading "Loans and goals" above that group. If a simpler pattern exists (a `section` map keyed by id), follow it.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/notify "tests/app/(app)/settings" tests/lib/notify`
Expected: PASS. Existing snapshot tests of the settings page list will need the new labels added.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notify src/lib/loans.ts "src/app/(app)/settings/notifications" tests/notify tests/app
git commit -m "feat(notify): loan and goal events; recurring charges in coming-due

- interest posted, payment missed, reconcile due, goal reached, goal off pace
- settings group Loans and goals"
```

---

### Task 11: CSV statement intake and keeping the file (S1–S6)

**Files:**
- Create: `src/lib/loans/statement-csv.ts`
- Modify: `src/app/api/loans/statement-prefill/route.ts`, `src/app/(app)/warranties/[id]/reconcile-loan-form.tsx`, `src/app/(app)/warranties/actions.ts` (`reconcileLoanAction`), `src/lib/loans.ts` (`setLoanAnchor` accepts `receiptId`), `src/lib/warranty/receipts.ts` / `sniff.ts` (`text/csv`)
- Test: `tests/lib/loans/statement-csv.test.ts`, `tests/api/statement-prefill-csv.test.ts`, `tests/app/reconcile-loan-form.test.tsx`, `tests/app/reconcile-action-keep.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/loans/statement-csv.test.ts
import { detectStatementColumns, readStatementCsv } from '@/lib/loans/statement-csv';

const csv = 'Date,Description,Amount,Balance,Interest\n2026-08-05,Payment,-500.00,"9,583.33",\n2026-09-01,Interest,83.33,"9,666.66",83.33\n';

it('detects date, balance and interest columns by header', () => {
  expect(detectStatementColumns(csv)).toEqual({ headers: ['Date', 'Description', 'Amount', 'Balance', 'Interest'], mapping: { date: 'Date', balance: 'Balance', interest: 'Interest' }, confident: true });
});

it('reads the chronologically last row as the statement figures', () => {
  expect(readStatementCsv(csv, { date: 'Date', balance: 'Balance', interest: 'Interest' })).toEqual({ statementDate: '2026-09-01', balanceCents: 966_666, interestCents: 8_333, preview: expect.any(Array) });
});

it('is not confident when no header looks like a balance', () => {
  const r = detectStatementColumns('When,What,How much\n2026-09-01,x,1.00\n');
  expect(r.confident).toBe(false);
  expect(r.mapping.balance).toBeNull();
});
```

Route test: POST a CSV `statement` → 200 with `prefilledFrom: 'csv'`, `balance.valueCents === 966_666`, `csv.headers`, `csv.mapping`, `csv.confident`. Form test: with `confident: false` the column picker (three selects labelled Date / Balance / Interest) renders; changing Balance updates the balance field. Action test: `reconcileLoanAction` with `keepStatement=on` and a file stores a `warranty_receipts` row with `mime: 'text/csv'` and sets `loan_anchors.receipt_id`; without it, no receipt.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`statement-csv.ts`: parse with the import module's CSV splitter (`grep -n "export function parseCsv\|splitCsv" src/lib/import/parse.ts`); header scoring: date ∈ {date, posted, transaction date, date du}, balance ∈ {balance, running balance, closing balance, solde, new balance}, interest ∈ {interest, intérêt, finance charge} — fold accents like `statement-extract.ts` does; `confident` when date and balance both matched a single header. `readStatementCsv` parses amounts with `parseAmountToCents` and dates with `parseDateString` from `parse.ts`, sorts by date, takes the last row; `interestCents` = sum of the interest column when present, else null; `preview` = first five rows as string arrays.

Route: sniff by extension/`text/csv` content; CSV branch returns `{ prefilledFrom: 'csv', balance, statementDate, interest, csv: { headers, mapping, confident, preview } }`; when the item id is posted (`itemId` form field), read `statement_csv_columns` first and use it as the mapping (S3).

Form: when `csv && !csv.confident` (or the "Wrong column?" button is pressed) show `<ColumnPicker headers mapping preview onChange>`; on change, POST again with `mapping` fields so the server re-reads (the form never parses the CSV itself). Checkbox `name="keepStatement"` default checked, label "Keep this statement with the loan" (S4). The file input's `name` is `statement`, so the same file travels with the reconcile form post.

Action: after `setLoanAnchor`, when `keepStatement` and a file is present: `writeReceiptFile(buffer, mime)`, insert `warranty_receipts` (fields as the receipts upload action does), update the new anchor's `receipt_id`; persist `statement_csv_columns` when a mapping was confirmed. `sniff.ts`: accept `text/csv` when the first bytes are printable and contain a comma or semicolon in the first line. `warranty_receipts.mime` enum gained `text/csv` in Task 1.

Receipts card: badge "Statement" on receipts referenced by an anchor (`select receipt_id from loan_anchors where item_id = ?`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/loans/statement-csv.test.ts tests/api tests/app/reconcile-loan-form.test.tsx tests/app/reconcile-action-keep.test.ts tests/lib/warranty`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans/statement-csv.ts src/app/api/loans/statement-prefill "src/app/(app)/warranties" src/lib/loans.ts src/lib/warranty tests
git commit -m "feat(loans): CSV statements and keeping the file

- header detection with a column picker fallback, mapping remembered per loan
- keep-this-statement checkbox stores the file as a receipt"
```

---

### Task 12: Reports and dashboard (G1–G3) and retiring `simulate`

**Files:**
- Modify: `src/lib/loans.ts:2466` (`debtOverTime`), `listLoans`/`LoanSummary` (`needsBasis`, `interestThisMonthCents`), `loansTotalOwedCents`
- Modify: the Reports debt chart component (`grep -rl debtOverTime src/app src/components`), the dashboard Loans card
- Modify: `src/lib/loans/interest.ts` — delete `simulate` and its types once `interestFor` uses `buildLedger`; delete `tests/lib/loans/interest-simulation.test.ts` after moving any still-meaningful pins into `ledger-charge.test.ts`
- Test: `tests/lib/loans/debt-over-time.test.ts` (extend), dashboard card test

- [ ] **Step 1: Write the failing tests**

```ts
it('G1: a basis loan contributes posted balance plus accrued at each month end', () => {
  // seed the A8 loan, postAllDueInterest('2026-09-18'), debtOverTime(3, { today: '2026-09-18' })
  // expect Jul point 1_000_000 (opening), Aug point = 1_008_333 + accrued to Aug 31, Sep point = owing today
});
it('G2: the series "of which interest" is cumulative posted interest', () => { /* 0, 8_333, 16_736 */ });
it('a loan without a basis contributes its stored balance as before', () => { /* unchanged existing behaviour */ });
```

Dashboard: `listLoans` returns `needsBasis: true` for a rate-without-basis loan; the Loans card caption reads `+$X interest this month across N loans`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`debtOverTime`: for each loan with a basis and an anchor, call `buildLedger` with `today` = each month end in turn (the engine is pure and cheap; `months ≤ 36`), take `owingCents` and cumulative interest from `rows.filter(kind === 'interest').reduce(...)`; `DebtPoint` gains `interestCents`. Loans without a basis keep the existing replay. `listLoans`: `needsBasis = interestRateBps !== null && interestRateBasis === null`; `interestThisMonthCents = ledger?.interestThisPeriodCents ?? 0`. `interestFor` (line 2202) now derives `LoanInterest` from `loanLedger` so `LoanInterest.owingCents` stays what `loansTotalOwedCents` reads; delete `simulate`.

- [ ] **Step 4: Run** `npx vitest run tests/lib/loans tests/app/reports tests/app/dashboard tests/components` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loans.ts src/lib/loans/interest.ts src/app src/components tests
git commit -m "feat(loans): debt chart from ledger segments; dashboard interest caption

- retires simulate() in favour of buildLedger"
```

---

### Task 13: Guards, help, migration-in-code test (T4, M3)

**Files:**
- Modify: `tests/ops/loan-invariants.test.ts:72-96` (G1), G2 block (~97–126), G3 (~127–150), G4 (~151–174)
- Modify: `src/app/(app)/help/content.tsx` (loans section, after the v1.47.0 interest paragraphs)
- Test: `tests/db/upgrade-posts-in-code.test.ts`

- [ ] **Step 1: Update the guards (they are the tests)**

G1: allow `src/lib/loans/ledger.ts` alongside `interest.ts`. G2: run the three purity checks over both `interest.ts` and `ledger.ts` (no `@/db`, no `new Date`/`todayIso`, no `'lent'`/`'owed'`). G3: add a case — `postDueInterest`'s body (extract by regex from `loans.ts`) contains no `currentBalanceCents:` assignment and contains `recomputeBalance(`. G4: add `'Leave unset to keep the rate for reference only.'` and `'Set how it is charged below to see interest estimates.'` to the stale-copy list (both hints are replaced in Task 7).

Upgrade-in-code test (M3):

```ts
it('the first postAllDueInterest after upgrade posts every closed period since each loan\'s anchor', () => {
  // seed at 0025, insert a loan with basis + anchor 2026-07-01 and one without a basis, apply 0026,
  // postAllDueInterest('2026-09-18') -> two rows for the first loan, none for the second, balances as A8
});
```

- [ ] **Step 2: Run** `npx vitest run tests/ops/loan-invariants.test.ts tests/db/upgrade-posts-in-code.test.ts` — G3's new case and the upgrade test fail until the assertions match the code written in Tasks 5 and 7; fix the *test* only if it asserts something the spec does not say.

- [ ] **Step 3: Help text.** Add one paragraph after the "Reconcile to a statement" paragraph in `help/content.tsx`:

> **The ledger.** Each loan with a rate shows a ledger like a bank statement: every payment, every advance, and one "Interest posted" line each cycle on the day of the month the loan started (you can change the day). Interest builds up daily on whatever is owed that day, so a payment on the 15th lowers what the month costs. Three figures sit above it: **Balance** (with all posted interest), **Accrued so far** (this cycle, not yet added), and **Owing today** (the two together). A payment you record late, inside a cycle that has already posted, does not rewrite that cycle — it adds one "Adjustment" line dated the day you recorded it, so the history stays the history. The app posts interest each night and whenever a payment lands; nothing waits for you.

- [ ] **Step 4: Run** the help test file and the guards — PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ops/loan-invariants.test.ts tests/db/upgrade-posts-in-code.test.ts "src/app/(app)/help/content.tsx"
git commit -m "test(loans): guards cover the ledger engine; help text

- G1/G2 include ledger.ts, G3 checks postDueInterest never writes the balance
- upgrade posts in code, not SQL"
```

---

### Task 14: Full suite, build, smoke, release v1.48.0

- [ ] **Step 1:** `npx vitest run` — expect 0 failures (a single arbitrary failure under the parallel run is the known reporter flake: rerun that file alone).
- [ ] **Step 2:** `rm -rf .next && npm run build` — clean. `npm run smoke` — all passing.
- [ ] **Step 3:** Bump `package.json` to `1.48.0`. CHANGELOG entry:

```
## 1.48.0 — 2026-09-XX

Loan ledger and interest posting
- A loan with a rate shows a bank-style ledger: opening, payments, advances, one interest line per cycle, and what has accrued so far.
- Interest accrues daily on the actual balance and posts on the loan's own day of the month; a payment mid-cycle lowers that cycle's charge.
- Posted interest is a fact. A payment recorded late adds an adjustment line rather than rewriting history.
- A rate now needs a charging method; new loans default to a yearly rate charged monthly. Existing loans with a rate and no method show a banner and do not change.
- Loans with a method already set will show a higher balance after this upgrade: the interest posted since their last statement.
- The new-loan form writes the loan's first statement as of the borrowed date, and "You set this on" shows that date.
- Ledger CSV download; debt chart shows interest growing.

Statements
- CSV statements fill the reconcile form, with a column picker when the headers are unclear; the mapping is remembered per loan.
- "Keep this statement with the loan" stores the file as a receipt (on by default).

Notifications
- New: interest added to a loan, no payment on a loan this period, time to check a loan against its statement, a loan is paid off, you reached a savings goal, a savings goal is behind pace.
- Coming due now includes recurring charges the app has noticed but you have not tracked.
```

Update the MUST-7.1 version guard in `tests/ops/docker.test.ts`; run it.

- [ ] **Step 4:** Commit `chore(release): v1.48.0`, push `main`, push tag `v1.48.0`, then `gh run list --limit 3` and confirm `Release image` and `Test suite` go green (≈30 min). If Linux fails where Windows passed, fix and ship `v1.48.1`.

---

## Self-review against the spec

- D1–D6 → Task 7. C1–C4, A1–A8 → Tasks 2–3 (pins in `ledger-charge.test.ts`, A8 tables in `ledger-build.test.ts` and `postings.test.ts`). P1 → Task 1; P2–P4 → Task 5; P3 → Task 6; P5–P6 → Tasks 5, 8, 12; P7 → existing `setLoanAnchor` comparison, now fed by `loanLedger` (Task 5 wires `postDueInterest` into `setLoanAnchor`). K1–K5 → Task 4 (engine) + Task 5 (storage) — K3 (reversal on undo) is covered by "a stored adjustment is honoured" plus the `unassign` call in P4; K5 (rate change into a closed period) falls out of the same gap computation and is exercised by the R1 test. R1–R3 → Tasks 1, 5, 7. U1–U8 → Tasks 8–9. N1–N9 → Tasks 6, 10. S1–S6 → Task 11. G1–G3 → Task 12. M1–M4 → Tasks 1, 13, 14. T1–T6 → spread as listed.
- Types: `StoredPosting`, `RateInForce`, `Ledger`, `LedgerInput` defined in Tasks 2–4 and used by name in 5, 8, 9, 12. `postDueInterest(itemId, today, opts?)` is the same signature in Tasks 5, 6, 7, 10.
- Open question 1 of the spec (missed-payment after term end): the evaluator in Task 10 does **not** exclude ended terms; add `and (expiry_date is null or expiry_date >= today)` to its query so the assumption in the spec ("no") holds.
