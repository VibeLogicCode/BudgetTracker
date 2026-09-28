# Import freshness on the summaries, a per-account import cadence, and confirming a whole review view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.52.0 with three things: the weekly and monthly digests open with `Last import <date>.`; every account can declare how often it is imported and the existing `stale_import` reminder reads that instead of one household number; and the grouped-by-category Transactions view gains **Confirm every group**, which does in one press what ten per-group **These are all correct** presses do today.

**Architecture:** Two independent parts that share one release. **Part A** adds a pure cadence module (`src/lib/import/cadence.ts`), one nullable column on `accounts` (migration 0028), a per-account threshold in `evaluate/stale.ts`, a viewer-scoped `latestImportIso()` reader, and a required `lastImportIso` field on the two digest render inputs so the pure renderer prepends the line and every call site is a compiler-checked edit. **Part B** extracts the paged id sweep the group actions already use into `sweepTransactionRows`, adds `bulkConfirmOwnCategory` beside `bulkSetCategory` (same one-transaction loop over `confirmCategory`, each row to its own category, `createRule: false`), and a `bulkConfirmViewAction` + `view-confirm-dialog` that posts the page's filter, never ids. Nothing in either part changes when a digest fires, what the outbox stores, or which events exist.

**Tech Stack:** Next.js 16 App Router, React 19, server actions (`'use server'`, `useActionState`), Drizzle over better-sqlite3, hand-written SQL migrations, Vitest + Testing Library (jsdom, no jest-dom), zod.

**Spec:** `docs/superpowers/specs/2026-09-28-import-freshness-and-review-confirm-design.md` — every task below cites its section (§2.1 freshness line, §2.2 cadence, §2.3 confirm the view). The plan argues from the spec; read both.

## Global Constraints

- **Public repo.** No owner name, employer, Windows paths, real statement figures, or verbatim owner quotes in code, comments, tests or docs. Paraphrase reports.
- **Commits:** subject + a few bullets, never prose paragraphs. **No `Co-Authored-By` lines** (repo rule overrides the harness default). Author is the repo's configured git user.
- **TDD, one file at a time:** `npx vitest run <file>`. Write the failing test, watch it fail for the stated reason, then implement. A single arbitrary failure under the full parallel run is the known reporter flake (`tests/ops/install.test.ts` most often, with `Timeout calling "onTaskUpdate"`): rerun that file alone.
- **Bash heredocs break on backticks and `\b`/`\n` escapes** in this environment. Write patch scripts to the scratchpad with the Write tool and run them with `python`, or use the Edit tool.
- **Migrations:** `drizzle/00NN_name.sql` with `--> statement-breakpoint` between statements, mirrored in `src/db/schema.ts` with the new column declared **last** in its table (ALTER TABLE ADD COLUMN appends physically), journal `when` strictly later than idx 27's `1758326400000`. The newest migration's test carries the "I am the newest" claim; the previous one hands it off (see `tests/db/migration-0026.test.ts:48`).
- **Ruling R2 (`tests/ops/visibility-invariants.test.ts`):** every read-model helper that can leak another member's figures takes a **required, non-defaulted** `viewer: Viewer` and is listed in `REQUIRE_VIEWER`. `latestImportIso` is one.
- **Client-bundle guard (`tests/ops/client-bundle.test.ts`):** a `'use client'` file may value-import only modules whose import graph never reaches `@/db/client`. `src/lib/import/cadence.ts` therefore imports nothing at all. `src/lib/import/freshness.ts` reaches `@/db` and is imported only by server-side evaluators.
- **`renderEvent` stays pure** (`tests/lib/notify/render.test.ts` "MUST-2.1"): no `@/db`, no `@/lib/env`, no `node:` imports. Freshness is a value the evaluators pass in.
- **No new notification event id.** `NOTIFICATION_EVENTS` stays at 29 (`tests/lib/notify/events.test.ts:52`).
- **Copy is copied verbatim** from the task that names it. Dates in notification bodies are ISO (`2026-09-27`), never localised.
- **Release:** bump `package.json` to `1.52.0`; CHANGELOG under Keep-a-Changelog headings (Added / Changed only here); MUST-7.1 guard in `tests/ops/docker.test.ts`: every `toBe('1.51.0')` becomes `'1.52.0'`, the `1.51.0 release` case hands off to an append-only case, a new `1.52.0 release` case is added; `rm -rf .next && npm run build`; `npm run smoke`; commit `chore(release): v1.52.0`; push `main`; push tag `v1.52.0`; watch the `Release image` workflow.
- **Why v1.52.0 and not v1.51.1:** a migration and a new per-account setting are user-visible changes, not patches.

## Review Focus

Inputs the spec implies but no single task's first test exercises. Each line names the task whose tests pin it.

1. **A SimpleFIN-managed account whose nightly sync silently stops.** Its imports rows stop too, so under its cadence (or the default) it must be named by the reminder like any CSV account — no special-casing by how it was imported. Pinned in Task 5 (`'a SimpleFIN-style account is judged by the same rule'`).
2. **A self-scoped member's digest must never carry a date from an account they cannot see.** A joint account (owner NULL) is not theirs under `listAccounts`' rule. Pinned in Task 7 (`'a self-scoped viewer sees only their own accounts'`) and Task 9 (`'ruling R2: a self-scoped member gets their own account date, not the joint one'`).
3. **A cadence value the select does not offer** — written by SQL, or by a future build with a different list — must survive a save aimed at the name or owner, exactly as a dormant mapping pin does. Pinned in Task 3 (`'accepts a value the select does not offer'`) and Task 4 (`'keeps a stored value the list does not offer as its own option'`).
4. **A grouped view with more rows than one row page and more than one group page.** "Confirm every group" must reach all of them; the sweep is over rows, not over rendered groups. Pinned in Task 11 (`'confirms every row in the view across every cluster, not only a rendered page'`).
5. **A view where nothing can be confirmed** — every row already by hand, or none has a category — must say so, never "Confirmed 0". Pinned in Task 11 (two `'says so when…'` cases).
6. **The empty monthly digest with no imports at all must keep its exact one-line body**, because `tests/lib/notify/evaluate/monthly.test.ts` pins it byte-for-byte. Pinned in Task 9 (`'a household with no imports gets no freshness line, so the empty-month body is unchanged'`).

---

## File map

| Area | Files |
|---|---|
| Cadence (pure) | `src/lib/import/cadence.ts` (new) — `IMPORT_CADENCE_OPTIONS`, `cadenceWeeksFromForm`, `cadenceFormValue`, `cadenceLabel`, `cadenceSubtitle`, `staleThresholdWeeks` |
| Column | `drizzle/0028_account_import_cadence.sql` (new), `drizzle/meta/_journal.json`, `src/db/schema.ts` (`accounts.expectedImportWeeks`), `tests/db/migration-0028.test.ts` (new), `tests/db/migration-0027.test.ts` (hand-off) |
| Account lib | `src/lib/accounts.ts` — `AccountRecord.expectedImportWeeks`, `setAccountImportCadence` |
| Account form | `src/app/(app)/settings/accounts/actions.ts` (`cadence` field), `accounts-manager.tsx` (select + subtitle), `page.tsx` (row mapping) |
| Reminder | `src/lib/notify/evaluate/stale.ts`, `src/lib/notify/render.ts` (`StaleAccountLine.weeks`, batch subject), `src/lib/notify/events.ts` (blurb), `src/app/(app)/settings/notifications/notifications-client.tsx` (hint) |
| Freshness | `src/lib/import/freshness.ts` (new) — `latestImportIso(viewer)`; `tests/ops/visibility-invariants.test.ts` (REQUIRE_VIEWER entry) |
| Digest line | `src/lib/notify/render.ts` (`lastImportIso` on three inputs, `withFreshness`), `src/lib/notify/evaluate/digest.ts`, `src/lib/notify/evaluate/monthly.ts` |
| Confirm the view | `src/lib/transactions.ts` (`bulkConfirmOwnCategory`, `ConfirmOwnResult`), `src/app/(app)/transactions/actions.ts` (`sweepTransactionRows`, `bulkConfirmViewAction`), `src/app/(app)/transactions/transactions-client.tsx` (header row, `view-confirm-dialog`) |
| Release | `CHANGELOG.md`, `package.json`, `tests/ops/docker.test.ts` |

---

# Part A — Import freshness and a per-account cadence

### Task 1: Migration 0028 — `accounts.expected_import_weeks`

**Files:**
- Create: `drizzle/0028_account_import_cadence.sql`
- Modify: `drizzle/meta/_journal.json` (append one entry)
- Modify: `src/db/schema.ts:116-136` (the `accounts` table)
- Create: `tests/db/migration-0028.test.ts`
- Modify: `tests/db/migration-0027.test.ts:41-49` (hand off the "newest" claim)

**Interfaces:**
- Produces: column `accounts.expected_import_weeks integer null`; Drizzle field `accounts.expectedImportWeeks: number | null`. Every later task reads or writes it.

- [ ] **Step 1: Write the failing migration test**

Create `tests/db/migration-0028.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../helpers/db';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const columns = (table: string): string[] =>
  (current!.sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

/**
 * drizzle/0028_account_import_cadence.sql (spec 2026-09-28 §2.2). One nullable column, no
 * backfill: NULL means "the household default", which is what every existing row meant already.
 */
describe('0028: the migration records itself', () => {
  it('sits immediately after 0027 in the journal, and is the newest', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0028_account_import_cadence')).toMatchObject({ idx: 28 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(28)).toBe(idxs.indexOf(27) + 1);
    expect(Math.max(...idxs)).toBe(28);
  });
});

describe('0028: an account can say how often it is imported', () => {
  it('adds expected_import_weeks to accounts, nullable, and null by default', () => {
    current = createSeededTestDb();
    expect(columns('accounts')).toContain('expected_import_weeks');
    const id = insertTestAccount(current.db);
    expect(current.sqlite.prepare('select expected_import_weeks as w from accounts where id = ?').get(id)).toEqual({ w: null });
  });

  it('stores 0 (never) and 53 (yearly): no CHECK, the meaning lives in src/lib/import/cadence.ts', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db);
    for (const weeks of [0, 2, 53]) {
      current.sqlite.prepare('update accounts set expected_import_weeks = ? where id = ?').run(weeks, id);
      expect(current.sqlite.prepare('select expected_import_weeks as w from accounts where id = ?').get(id)).toEqual({ w: weeks });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/migration-0028.test.ts`
Expected: FAIL — the journal has no `0028_account_import_cadence` entry, and `columns('accounts')` lacks `expected_import_weeks`.

- [ ] **Step 3: Write the migration**

Create `drizzle/0028_account_import_cadence.sql`:

```sql
-- 2026-09-28. One staleness number for every account was wrong for most of them.
--
-- stale_import nags when an account has gone `staleImportWeeks` (household-wide, default 3) with no
-- import. A household with ten accounts on different rhythms cannot set that one number: either the
-- account whose statement comes once a year nags forty-nine weeks of it, or the one imported weekly
-- is allowed to go quiet for a month before anyone hears.
--
-- Nullable, and NULL means "the household default" -- so every existing row behaves exactly as it
-- did until somebody picks a cadence. 0 means "never remind me". Any other value is the reminder
-- threshold in weeks, the same semantics staleImportWeeks has always had. The label <-> weeks
-- mapping lives in src/lib/import/cadence.ts, not here: no CHECK, so a future list can widen it
-- without a rebuild (the same reasoning accounts.type has carried since ruling R10).
alter table accounts add column expected_import_weeks integer;
```

Append to `drizzle/meta/_journal.json` `entries` (after the idx 27 entry, keep the JSON valid — trailing comma on the previous entry):

```json
    {
      "idx": 28,
      "version": "6",
      "when": 1758412800000,
      "tag": "0028_account_import_cadence",
      "breakpoints": true
    }
```

In `src/db/schema.ts`, inside the `accounts` table object, add **after** `createdAt: text('created_at').notNull(),`:

```ts
    /**
     * 2026-09-28, drizzle/0028_account_import_cadence.sql (spec §2.2). Declared last because ALTER
     * TABLE ADD COLUMN appends physically -- same convention as importProfiles.isActive. NULL = the
     * household's staleImportWeeks; 0 = never remind; otherwise the reminder threshold in weeks.
     * src/lib/import/cadence.ts owns the label <-> weeks mapping and the one rule that reads it.
     */
    expectedImportWeeks: integer('expected_import_weeks'),
```

- [ ] **Step 4: Hand off the "newest" claim from 0027**

In `tests/db/migration-0027.test.ts`, replace the test at lines 41-49:

```ts
describe('0027: the migration records itself', () => {
  /** The "I am the newest" claim moved on to 0028's suite, as 0027 took it from 0026's. */
  it('sits immediately after 0026 in the journal', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((row) => row.tag === '0027_review_fixes')).toMatchObject({ idx: 27 });
    const idxs = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b);
    expect(idxs.indexOf(27)).toBe(idxs.indexOf(26) + 1);
  });
});
```

(The only change: the title loses `, and is the newest`, the `Math.max` line is deleted, and the hand-off comment is added.)

- [ ] **Step 5: Run the migration tests and the schema guards**

Run: `npx vitest run tests/db/migration-0028.test.ts tests/db/migration-0027.test.ts tests/ops/predict-invariants.test.ts`
Expected: PASS. (`predict-invariants` scans every migration's DDL for banned words; `cadence` is not one.)

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` — expected clean (the new field is optional on insert, so no call site breaks).

```bash
git add drizzle/0028_account_import_cadence.sql drizzle/meta/_journal.json src/db/schema.ts tests/db/migration-0028.test.ts tests/db/migration-0027.test.ts
git commit -m "feat(db): accounts.expected_import_weeks

- migration 0028, nullable; NULL is the household default, 0 is never
- the newest-migration claim moves from 0027's suite to 0028's"
```

---

### Task 2: The cadence module and the account setter

**Files:**
- Create: `src/lib/import/cadence.ts`
- Modify: `src/lib/accounts.ts:14-23` (`AccountRecord`), `:116-119` (add the setter after `setAccountOwner`)
- Create: `tests/lib/import/cadence.test.ts`
- Create: `tests/lib/account-cadence.test.ts`

**Interfaces:**
- Produces:
  - `IMPORT_CADENCE_OPTIONS: readonly { value: string; weeks: number | null; label: string }[]`
  - `cadenceWeeksFromForm(value: string): number | null | undefined` — `''` → `null`, `'0'..'999'` → number, anything else → `undefined`
  - `cadenceFormValue(weeks: number | null): string`
  - `cadenceLabel(weeks: number | null): string`
  - `cadenceSubtitle(weeks: number | null): string | null`
  - `staleThresholdWeeks(accountWeeks: number | null, householdWeeks: number): number`
  - `AccountRecord.expectedImportWeeks: number | null` (returned by `listAccounts` and `getAccount` automatically — both `select()` every column)
  - `setAccountImportCadence(id: number, expectedImportWeeks: number | null): void`

- [ ] **Step 1: Write the failing pure-module test**

Create `tests/lib/import/cadence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMPORT_CADENCE_OPTIONS,
  cadenceFormValue,
  cadenceLabel,
  cadenceSubtitle,
  cadenceWeeksFromForm,
  staleThresholdWeeks,
} from '@/lib/import/cadence';

/** Spec 2026-09-28 §2.2. One module owns the labels, the stored numbers and the one rule. */
describe('the cadence options', () => {
  it('offers exactly the six the spec names, in this order', () => {
    expect(IMPORT_CADENCE_OPTIONS.map((option) => [option.label, option.weeks])).toEqual([
      ['Household default', null],
      ['Weekly', 2],
      ['Every two weeks', 3],
      ['Monthly', 5],
      ['Yearly', 53],
      ['Never remind me', 0],
    ]);
  });

  /** The stored number is a threshold with a week of slack, so a statement a few days late does not nag. */
  it('stores one week more than the cadence named, except never', () => {
    const byLabel = new Map(IMPORT_CADENCE_OPTIONS.map((option) => [option.label, option.weeks]));
    expect(byLabel.get('Weekly')).toBe(1 + 1);
    expect(byLabel.get('Every two weeks')).toBe(2 + 1);
    expect(byLabel.get('Monthly')).toBe(4 + 1);
    expect(byLabel.get('Yearly')).toBe(52 + 1);
  });
});

describe('reading a form value', () => {
  it("'' is the household default and 0 is never -- both real answers, neither invalid", () => {
    expect(cadenceWeeksFromForm('')).toBeNull();
    expect(cadenceWeeksFromForm('0')).toBe(0);
    expect(cadenceWeeksFromForm('5')).toBe(5);
  });

  /** A value the select does not offer (written by SQL, or by another build) must still round-trip. */
  it('accepts any small non-negative integer, not only the offered ones', () => {
    expect(cadenceWeeksFromForm('7')).toBe(7);
  });

  it('rejects anything that is not one', () => {
    for (const bad of ['abc', '-1', '1.5', '1000', ' 5']) expect(cadenceWeeksFromForm(bad)).toBeUndefined();
  });

  it('round-trips through the form value', () => {
    for (const option of IMPORT_CADENCE_OPTIONS) {
      expect(cadenceWeeksFromForm(cadenceFormValue(option.weeks))).toBe(option.weeks);
    }
  });
});

describe('labels', () => {
  it('names an offered value by its label and an unoffered one by its number', () => {
    expect(cadenceLabel(5)).toBe('Monthly');
    expect(cadenceLabel(null)).toBe('Household default');
    expect(cadenceLabel(7)).toBe('Every 7 weeks');
  });

  it('gives the accounts page a subtitle word only when the account has its own cadence', () => {
    expect(cadenceSubtitle(null)).toBeNull();
    expect(cadenceSubtitle(0)).toBe('no import reminders');
    expect(cadenceSubtitle(5)).toBe('imported monthly');
    expect(cadenceSubtitle(3)).toBe('imported every two weeks');
  });
});

describe('the one rule', () => {
  it('uses the account value when set, the household value when not, and passes 0 through', () => {
    expect(staleThresholdWeeks(null, 3)).toBe(3);
    expect(staleThresholdWeeks(5, 3)).toBe(5);
    expect(staleThresholdWeeks(0, 3)).toBe(0);
  });
});

/** accounts-manager.tsx is 'use client' and value-imports this module (tests/ops/client-bundle.test.ts). */
describe('the module is pure', () => {
  it('imports nothing', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/import/cadence.ts'), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/import/cadence.test.ts`
Expected: FAIL — `Cannot find module '@/lib/import/cadence'`.

- [ ] **Step 3: Write the module**

Create `src/lib/import/cadence.ts`:

```ts
/**
 * The import cadence an account can declare (spec 2026-09-28 §2.2), and the one rule the reminder
 * applies to it.
 *
 * PURE, and it must stay that way: no imports at all. settings/accounts/accounts-manager.tsx is
 * 'use client' and value-imports this module for the select, and the client-bundle guard
 * (tests/ops/client-bundle.test.ts) walks every value import from a client file looking for a
 * path to @/db/client. Its sibling files in src/lib/import/ reach the database; this one may not.
 *
 * THE STORED NUMBER IS A THRESHOLD, NOT A CADENCE. accounts.expected_import_weeks carries the same
 * meaning staleImportWeeks (Settings -> Notifications) has always had -- "this many weeks with no
 * import, then remind" -- so the evaluator keeps one rule for both. The labels are what a person
 * means; the numbers carry one week of slack past the cadence they name, so a statement that
 * arrives a few days late does not produce a reminder. One module owns both halves so the accounts
 * page, the action and the evaluator cannot disagree about what "Monthly" means.
 */
export interface ImportCadenceOption {
  /** The form value. '' is the household default, exactly as ownerField's '' is Joint. */
  value: string;
  /** What the column stores. null = household default; 0 = never remind. */
  weeks: number | null;
  label: string;
}

export const IMPORT_CADENCE_OPTIONS: readonly ImportCadenceOption[] = [
  { value: '', weeks: null, label: 'Household default' },
  { value: '2', weeks: 2, label: 'Weekly' },
  { value: '3', weeks: 3, label: 'Every two weeks' },
  { value: '5', weeks: 5, label: 'Monthly' },
  { value: '53', weeks: 53, label: 'Yearly' },
  { value: '0', weeks: 0, label: 'Never remind me' },
];

/**
 * undefined = not a value at all. null and 0 are both real answers.
 *
 * Any small non-negative integer is accepted, not only the offered six: a value written by SQL or
 * by another build must survive a save aimed at the account's name, the same way a dormant mapping
 * pin does (accounts-manager.tsx). The select constrains what is OFFERED; the column accepts what
 * it already holds.
 */
export function cadenceWeeksFromForm(value: string): number | null | undefined {
  if (value === '') return null;
  if (!/^\d{1,3}$/.test(value)) return undefined;
  return Number(value);
}

export function cadenceFormValue(weeks: number | null): string {
  return weeks === null ? '' : String(weeks);
}

export function cadenceLabel(weeks: number | null): string {
  const option = IMPORT_CADENCE_OPTIONS.find((candidate) => candidate.weeks === weeks);
  return option === undefined ? `Every ${weeks} weeks` : option.label;
}

/** The accounts page's subtitle word, or null when the account rides the household default. */
export function cadenceSubtitle(weeks: number | null): string | null {
  if (weeks === null) return null;
  if (weeks === 0) return 'no import reminders';
  return `imported ${cadenceLabel(weeks).toLowerCase()}`;
}

/**
 * THE ONE RULE, and the only place the fallback is spelled. 0 comes back as 0: the caller treats it
 * as "never" and excludes the account rather than comparing against it.
 */
export function staleThresholdWeeks(accountWeeks: number | null, householdWeeks: number): number {
  return accountWeeks === null ? householdWeeks : accountWeeks;
}
```

- [ ] **Step 4: Run the pure test to verify it passes**

Run: `npx vitest run tests/lib/import/cadence.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing setter test**

Create `tests/lib/account-cadence.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../helpers/db';
import { getAccount, listAccounts, setAccountImportCadence } from '@/lib/accounts';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Spec 2026-09-28 §2.2: the account's own threshold, read wherever the account is read. */
describe('setAccountImportCadence', () => {
  it('is null on a fresh account and comes back through getAccount and listAccounts', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db, { name: 'Amex', type: 'credit' });
    expect(getAccount(id)?.expectedImportWeeks).toBeNull();

    setAccountImportCadence(id, 5);
    expect(getAccount(id)?.expectedImportWeeks).toBe(5);
    expect(listAccounts({}, HOUSEHOLD_VIEWER).find((account) => account.id === id)?.expectedImportWeeks).toBe(5);
  });

  it('stores 0 as 0 and null as null -- never is not the same as default', () => {
    current = createSeededTestDb();
    const id = insertTestAccount(current.db);
    setAccountImportCadence(id, 0);
    expect(getAccount(id)?.expectedImportWeeks).toBe(0);
    setAccountImportCadence(id, null);
    expect(getAccount(id)?.expectedImportWeeks).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/lib/account-cadence.test.ts`
Expected: FAIL — `setAccountImportCadence` is not exported (a TypeScript/esbuild import error at load).

- [ ] **Step 7: Add the field and the setter**

In `src/lib/accounts.ts`, add to `AccountRecord` after `createdAt: string;`:

```ts
  /** Spec 2026-09-28 §2.2. null = the household's staleImportWeeks; 0 = never remind; else weeks. */
  expectedImportWeeks: number | null;
```

Add after `setAccountOwner`:

```ts
/**
 * Spec 2026-09-28 §2.2. null = the household default; 0 = never remind; otherwise the reminder
 * threshold in weeks. The label <-> weeks mapping is src/lib/import/cadence.ts's; this writes what
 * it is handed.
 */
export function setAccountImportCadence(id: number, expectedImportWeeks: number | null): void {
  getDb().update(accounts).set({ expectedImportWeeks }).where(eq(accounts.id, id)).run();
}
```

- [ ] **Step 8: Run the setter test, typecheck, commit**

Run: `npx vitest run tests/lib/account-cadence.test.ts` — expected PASS.
Run: `npx tsc --noEmit` — expected clean. If any test fixture builds an `AccountRecord` literal by hand, it now needs `expectedImportWeeks: null`; tsc names each one.

```bash
git add src/lib/import/cadence.ts src/lib/accounts.ts tests/lib/import/cadence.test.ts tests/lib/account-cadence.test.ts
git commit -m "feat(accounts): the import cadence, as one pure module and one setter

- six options; the stored number is the reminder threshold with a week of slack
- staleThresholdWeeks is the one fallback rule
- setAccountImportCadence; AccountRecord carries the field"
```

---

### Task 3: `updateAccountAction` saves the cadence

**Files:**
- Modify: `src/app/(app)/settings/accounts/actions.ts:8` (import), `:123-128` (`updateAccountSchema`), `:165-240` (`updateAccountAction`)
- Modify: `tests/app/accounts-actions.test.ts` (new `describe` after the existing `updateAccountAction` one)

**Interfaces:**
- Consumes: `cadenceWeeksFromForm`, `setAccountImportCadence` (Task 2).
- Produces: `updateAccountAction` reads form field `cadence` (string; `''` = household default) and writes it on every save. The accounts editor (Task 4) always posts it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/accounts-actions.test.ts`:

```ts
/**
 * Spec 2026-09-28 §2.2. The cadence rides the same save as name, owner and mapping -- a fourth
 * field, not a fourth button. '' is the household default, a real state like Joint or None.
 */
describe('updateAccountAction: the import cadence', () => {
  it('saves an offered value, the default, and never', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Amex', type: 'credit' });

    for (const [cadence, stored] of [
      ['5', 5],
      ['', null],
      ['0', 0],
    ] as const) {
      const result = await updateAccountAction({}, formData({ accountId: String(id), name: 'Amex', owner: '', profile: '', cadence }));
      expect(result.error).toBeUndefined();
      expect(getAccount(id)?.expectedImportWeeks).toBe(stored);
    }
  });

  /** Review focus 3: a value the select does not offer must survive a save aimed at the name. */
  it('accepts a value the select does not offer', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Amex', type: 'credit' });
    db.run(sql`update accounts set expected_import_weeks = 7 where id = ${id}`);

    const result = await updateAccountAction({}, formData({ accountId: String(id), name: 'Amex Gold', owner: '', profile: '', cadence: '7' }));

    expect(result.error).toBeUndefined();
    expect(getAccount(id)).toMatchObject({ name: 'Amex Gold', expectedImportWeeks: 7 });
  });

  it('refuses a value that is not one, and changes nothing', async () => {
    const { db } = setup();
    const id = insertTestAccount(db, { name: 'Amex', type: 'credit' });

    const result = await updateAccountAction({}, formData({ accountId: String(id), name: 'Renamed', owner: '', profile: '', cadence: 'soon' }));

    expect(result.error).toBe('Pick how often this account is imported.');
    expect(getAccount(id)).toMatchObject({ name: 'Amex', expectedImportWeeks: null });
  });
});
```

Add `import { sql } from 'drizzle-orm';` to the file's imports.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/accounts-actions.test.ts`
Expected: the three new tests FAIL — `expectedImportWeeks` stays `null` after a save with `cadence: '5'`, and the invalid value is not refused. Every pre-existing test still passes (they post no `cadence`, which reads as `''` → default → `null`, the value those accounts already have).

- [ ] **Step 3: Implement**

In `src/app/(app)/settings/accounts/actions.ts`:

Change the `@/lib/accounts` import to:

```ts
import { createAccount, getAccount, renameAccount, setAccountActive, setAccountImportCadence, setAccountOwner } from '@/lib/accounts';
import { cadenceWeeksFromForm } from '@/lib/import/cadence';
```

Replace `updateAccountSchema`:

```ts
/**
 * Spec 2026-09-28 §2.2. '' is the household default (a real state, like ownerField's Joint), and any
 * small non-negative integer is accepted rather than only the six the select offers -- see
 * cadenceWeeksFromForm for why a value the list does not offer must still round-trip.
 */
const cadenceField = z.string().refine((value) => cadenceWeeksFromForm(value) !== undefined, 'Pick how often this account is imported.');

const updateAccountSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, 'Give the account a name').max(80),
  owner: ownerField,
  profile: profileField,
  cadence: cadenceField,
});
```

In `updateAccountAction`, add `cadence: String(formData.get('cadence') ?? ''),` to the `safeParse` object (after `profile`), and after the line `setAccountOwner(parsed.data.accountId, ownerUserId);` add:

```ts
  // Spec 2026-09-28 §2.2. The refine above already rejected anything cadenceWeeksFromForm cannot
  // read, so `?? null` here can only ever be reached by '' -- it exists to satisfy the type.
  setAccountImportCadence(parsed.data.accountId, cadenceWeeksFromForm(parsed.data.cadence) ?? null);
```

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx vitest run tests/app/accounts-actions.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/accounts/actions.ts" tests/app/accounts-actions.test.ts
git commit -m "feat(accounts): the update form saves the import cadence

- cadence rides the same submit as name, owner and mapping
- '' is the household default; any small integer is accepted so an
  unoffered value survives a save aimed at another field"
```

---

### Task 4: The accounts page — a cadence select in the editor, a word in the subtitle

**Files:**
- Modify: `src/app/(app)/settings/accounts/accounts-manager.tsx:38-45` (`AccountRow`), `:143-160` (`AccountSubtitle`), `:185` (the `editing` state type), `:215-220` (`openEditor`), the editor form after the Owner select (currently `:387-402`)
- Modify: `src/app/(app)/settings/accounts/page.tsx:37-52` (row mapping)
- Modify: `tests/app/accounts-manager.test.tsx:36-50` (`account()` fixture) and append a `describe`

**Interfaces:**
- Consumes: `IMPORT_CADENCE_OPTIONS`, `cadenceFormValue`, `cadenceLabel`, `cadenceSubtitle` (Task 2).
- Produces: `AccountRow.expectedImportWeeks: number | null`; the editor posts `cadence`.

- [ ] **Step 1: Write the failing tests**

In `tests/app/accounts-manager.test.tsx`, add `expectedImportWeeks: null,` to the `account()` fixture (after `importProfileName: null,`). Then append:

```ts
/** Spec 2026-09-28 §2.2. One select in the same editor; a word in the subtitle when it is set. */
describe('the import cadence', () => {
  it('pre-fills the select with the account current value', () => {
    render(<AccountsManager accounts={[account({ id: 42, name: 'Amex', expectedImportWeeks: 5 })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Amex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    const select = screen.getByLabelText(/Import cadence for Amex/i) as HTMLSelectElement;
    expect(select.value).toBe('5');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Household default',
      'Weekly',
      'Every two weeks',
      'Monthly',
      'Yearly',
      'Never remind me',
    ]);
  });

  it('posts the cadence with the rest of the save', async () => {
    const { updateAccountAction } = await import('@/app/(app)/settings/accounts/actions');
    const spy = vi.mocked(updateAccountAction);
    render(<AccountsManager accounts={[account({ id: 42, name: 'Amex' })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Amex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    const select = screen.getByLabelText(/Import cadence for Amex/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5' } });
    fireEvent.submit(select.form as HTMLFormElement);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect((spy.mock.calls.at(-1)![1] as FormData).get('cadence')).toBe('5');
  });

  /** Review focus 3: the dormant-pin idiom, applied to a number the list does not offer. */
  it('keeps a stored value the list does not offer as its own option, so a save does not clear it', () => {
    render(<AccountsManager accounts={[account({ id: 42, name: 'Amex', expectedImportWeeks: 7 })]} people={PEOPLE} profiles={PROFILES} />);
    openAccountMenu('Amex');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update account' }));

    const select = screen.getByLabelText(/Import cadence for Amex/i) as HTMLSelectElement;
    expect(select.value).toBe('7');
    expect(Array.from(select.options).map((option) => option.textContent)).toContain('Every 7 weeks');
  });

  it('says the cadence in the subtitle only when the account has its own', () => {
    const { container, rerender } = render(
      <AccountsManager accounts={[account({ name: 'Amex', expectedImportWeeks: 5 })]} people={PEOPLE} profiles={PROFILES} />,
    );
    expect(container.textContent).toContain('imported monthly');

    rerender(<AccountsManager accounts={[account({ name: 'Amex', expectedImportWeeks: 0 })]} people={PEOPLE} profiles={PROFILES} />);
    expect(container.textContent).toContain('no import reminders');

    rerender(<AccountsManager accounts={[account({ name: 'Amex', expectedImportWeeks: null })]} people={PEOPLE} profiles={PROFILES} />);
    expect(container.textContent).not.toContain('imported ');
    expect(container.textContent).not.toContain('import reminders');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/accounts-manager.test.tsx`
Expected: the four new tests FAIL — no element labelled `Import cadence for Amex`, and the subtitle has no cadence word.

- [ ] **Step 3: Implement**

In `src/app/(app)/settings/accounts/accounts-manager.tsx`:

Add the import beside `import type { AccountType } from '@/lib/accounts';`:

```ts
// Pure (no imports of its own), so this 'use client' file may value-import it -- see the module's
// own docblock and tests/ops/client-bundle.test.ts.
import { IMPORT_CADENCE_OPTIONS, cadenceFormValue, cadenceLabel, cadenceSubtitle } from '@/lib/import/cadence';
```

Add to `AccountRow` after `importProfileName: string | null;`:

```ts
  /** Spec 2026-09-28 §2.2. null = household default; 0 = never; otherwise weeks. */
  expectedImportWeeks: number | null;
```

In `AccountSubtitle`, add a `cadence` const and a segment before the status one:

```tsx
  const cadence = cadenceSubtitle(account.expectedImportWeeks);
  ...
      <span>{mappingLabel}</span>
      <span aria-hidden="true">·</span>
      {cadence === null ? null : (
        <>
          <span>{cadence}</span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span>{statusLabel}</span>
```

Change the `editing` state type to `{ id: number; name: string; owner: string; profile: string; cadence: string }` and in `openEditor` add `cadence: cadenceFormValue(account.expectedImportWeeks),`.

In the editor form, insert this block **between** the Owner `<div>` and the `{account.isSimplefinManaged ? null : (` mapping block:

```tsx
                    <div className="flex flex-col gap-1">
                      <span className={labelClass}>Expect an import</span>
                      {/* Spec 2026-09-28 §2.2. Offered for every account, SimpleFIN-managed included:
                          a sync that silently stops writing imports is exactly what the reminder
                          should catch. The dormant option at the end is the mapping select's own
                          idiom -- a value the list does not offer must stay selected, or saving the
                          name would clear it. */}
                      <select
                        name="cadence"
                        defaultValue={editing.cadence}
                        aria-label={`Import cadence for ${account.name}`}
                        className={rowInput}
                      >
                        {IMPORT_CADENCE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                        {editing.cadence !== '' && !IMPORT_CADENCE_OPTIONS.some((option) => option.value === editing.cadence) ? (
                          <option value={editing.cadence}>{cadenceLabel(Number(editing.cadence))}</option>
                        ) : null}
                      </select>
                    </div>
```

In `src/app/(app)/settings/accounts/page.tsx`, add to the mapped row object after `importProfileName: …,`:

```ts
      expectedImportWeeks: account.expectedImportWeeks,
```

- [ ] **Step 4: Run the manager tests, then the guards that read this file**

Run: `npx vitest run tests/app/accounts-manager.test.tsx tests/ops/client-bundle.test.ts`
Expected: PASS. If `client-bundle` fails naming `src/lib/import/cadence.ts`, the module has grown an import — remove it; the module must stay import-free.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected clean.

```bash
git add "src/app/(app)/settings/accounts/accounts-manager.tsx" "src/app/(app)/settings/accounts/page.tsx" tests/app/accounts-manager.test.tsx
git commit -m "feat(accounts): pick how often each account is imported

- one select in the update editor, offered for every account
- an unoffered stored value stays as its own option, like a dormant pin
- the subtitle says it when the account has its own cadence"
```

---

### Task 5: The reminder reads the per-account threshold

**Files:**
- Modify: `src/lib/notify/evaluate/stale.ts:11` (import), `:48-58` (query), `:80-92` (map/filter/render call)
- Modify: `src/lib/notify/render.ts:84-88` (`StaleAccountLine`), `:259-263` (batch input), `:1006-1020` (batch subject)
- Modify: `tests/lib/notify/evaluate/stale.test.ts` (append a `describe`)
- Modify: `tests/lib/notify/render.test.ts:206-220` (append a batch test)

**Interfaces:**
- Consumes: `staleThresholdWeeks`, `setAccountImportCadence` (Task 2).
- Produces: `StaleAccountLine.weeks: number`; the `stale_import` batch input no longer carries a top-level `weeks`. `stale.ts` is the only producer.

- [ ] **Step 1: Write the failing evaluator tests**

Append to `tests/lib/notify/evaluate/stale.test.ts` (it already imports `insertTestAccount`, `saveUserSettings`, `DEFAULT_USER_SETTINGS`; add `import { setAccountImportCadence } from '@/lib/accounts';` beside the existing `setAccountActive` import):

```ts
/**
 * Spec 2026-09-28 §2.2. One household number was wrong for a household on mixed rhythms. Each
 * account may now carry its own threshold; NULL still means the household's.
 */
describe('spec 2026-09-28 §2.2: a per-account cadence', () => {
  let userId = 0;
  const NOW = new Date('2026-08-27T09:00:00Z');

  beforeEach(() => {
    userId = emailUser();
    saveUserSettings(userId, { ...DEFAULT_USER_SETTINGS, staleImportWeeks: 3 });
  });

  it('an account on a monthly cadence is not named at 30 days, while a default one beside it is', () => {
    const monthly = insertTestAccount(t.db, { name: 'Amex', type: 'credit' });
    setAccountImportCadence(monthly, 5);
    const defaulted = insertTestAccount(t.db, { name: 'Chequing' });
    importAt(userId, '2026-07-28T12:00:00.000Z', monthly); // 30 days: inside 5 weeks
    importAt(userId, '2026-07-28T12:00:00.000Z', defaulted); // 30 days: past the household's 3

    expect(evaluateStaleImport({ userId, now: NOW, tz: 'America/Toronto' })).toBe(1);
    const [row] = pendingOutbox(userId);
    expect(row?.body).toContain('Chequing');
    expect(row?.body).not.toContain('Amex');
  });

  it('never names an account set to never, however long it has been', () => {
    const never = insertTestAccount(t.db, { name: 'Savings', type: 'savings' });
    setAccountImportCadence(never, 0);
    importAt(userId, '2025-07-01T12:00:00.000Z', never); // over a year

    expect(evaluateStaleImport({ userId, now: NOW, tz: 'America/Toronto' })).toBe(0);
  });

  it('names an account on a weekly cadence at 14 days, where the household default would not', () => {
    const weekly = insertTestAccount(t.db, { name: 'Chequing' });
    setAccountImportCadence(weekly, 2);
    importAt(userId, '2026-08-12T12:00:00.000Z', weekly); // 15 days

    expect(evaluateStaleImport({ userId, now: NOW, tz: 'America/Toronto' })).toBe(1);
    const row = t.sqlite.prepare('select subject from notification_outbox').get() as { subject: string };
    // The subject states THAT account's own threshold, not the household's.
    expect(row.subject).toBe('Chequing has not been imported in 2 weeks');
  });

  it('with several overdue accounts the subject says so without a week count, because theirs differ', () => {
    const weekly = insertTestAccount(t.db, { name: 'Chequing' });
    setAccountImportCadence(weekly, 2);
    const monthly = insertTestAccount(t.db, { name: 'Amex', type: 'credit' });
    setAccountImportCadence(monthly, 5);
    importAt(userId, '2026-08-01T12:00:00.000Z', weekly); // 26 days
    importAt(userId, '2026-07-01T12:00:00.000Z', monthly); // 57 days

    expect(evaluateStaleImport({ userId, now: NOW, tz: 'America/Toronto' })).toBe(1);
    const row = t.sqlite.prepare('select subject, body from notification_outbox').get() as { subject: string; body: string };
    expect(row.subject).toBe('2 accounts are overdue for an import');
    expect(row.body).toContain('Amex: last import 2026-07-01 (57 days ago)');
    expect(row.body).toContain('Chequing: last import 2026-08-01 (26 days ago)');
  });

  /** Review focus 1: how the import happened does not enter into it -- only whether one happened. */
  it('a SimpleFIN-style account is judged by the same rule: an imports row is an imports row', () => {
    const synced = insertTestAccount(t.db, { name: 'Synced Chequing' });
    setAccountImportCadence(synced, 2);
    // A nightly sync writes an imports row with rows_added 0 when nothing is new (MUST-14.8).
    t.db.run(
      sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
          values (${synced}, null, ${'simplefin'}, ${userId}, 0, 0, 0, ${'2026-08-26T03:00:00.000Z'})`,
    );
    expect(evaluateStaleImport({ userId, now: NOW, tz: 'America/Toronto' })).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/notify/evaluate/stale.test.ts`
Expected: the first, second and third new tests FAIL (the evaluator still applies the household's 3 weeks to every account; the subject still says `3 weeks`); the fourth fails on the subject; the fifth passes already (it pins existing behaviour under the new setting).

- [ ] **Step 3: Implement the evaluator and the renderer**

In `src/lib/notify/evaluate/stale.ts`:

Add `import { staleThresholdWeeks } from '@/lib/import/cadence';`.

In the query's `select`, add after `newest`:

```ts
      expectedImportWeeks: accounts.expectedImportWeeks,
```

Replace the `stale` computation (the `.map(...).filter(...).sort(...)` chain) with:

```ts
  /**
   * Spec 2026-09-28 §2.2. Each account carries its own threshold, or rides the household's. The
   * account's own value wins when set; 0 is "never remind me" and EXCLUDES the account rather than
   * comparing against it. The stored number has the same meaning staleImportWeeks always had, so
   * this is still one rule -- staleThresholdWeeks is where the fallback is spelled, once.
   */
  const stale = rows
    .map((row) => {
      const lastImportIso = row.newest.slice(0, 10);
      const weeks = staleThresholdWeeks(row.expectedImportWeeks, settings.staleImportWeeks);
      return { name: row.accountName, lastImportIso, daysAgo: daysBetweenIso(lastImportIso, today), weeks };
    })
    .filter((row) => row.weeks > 0 && row.daysAgo >= row.weeks * 7)
    // Quietest first: the account that has been ignored longest is the one worth acting on.
    .sort((a, b) => b.daysAgo - a.daysAgo);
```

In the `renderEvent` call, delete the line `weeks: settings.staleImportWeeks,`.

In `src/lib/notify/render.ts`:

`StaleAccountLine` gains a field:

```ts
export interface StaleAccountLine {
  name: string;
  lastImportIso: string;
  daysAgo: number;
  /** Spec 2026-09-28 §2.2: this account's own threshold, or the household's when it has none. */
  weeks: number;
}
```

In the `stale_import` batch member of `RenderInput` (the one with `variant: 'batch'`), delete `weeks: number;`.

In the `case 'stale_import':` batch branch, replace the `subject:` expression:

```ts
          subject:
            input.accounts.length === 1
              ? `${truncateText(input.accounts[0].name, NAME_MAX)} has not been imported in ${input.accounts[0].weeks} weeks`
              // Spec 2026-09-28 §2.2: several accounts may now carry several thresholds, so a
              // single "in N weeks" would be true of at most one of them.
              : `${input.accounts.length} accounts are overdue for an import`,
```

- [ ] **Step 4: Add the renderer test**

In `tests/lib/notify/render.test.ts`, after the existing `stale_import` single test (ends at line 220), add:

```ts
  it('stale_import batch: one account states its own weeks; several say overdue', () => {
    const line = { lastImportIso: '2026-07-27', daysAgo: 21 };
    const one = renderEvent({ event: 'stale_import', variant: 'batch', accounts: [{ ...line, name: 'Amex', weeks: 2 }] });
    expect(one.subject).toBe('Amex has not been imported in 2 weeks');
    const two = renderEvent({
      event: 'stale_import',
      variant: 'batch',
      accounts: [
        { ...line, name: 'Amex', weeks: 5 },
        { ...line, name: 'Chequing', weeks: 2 },
      ],
    });
    expect(two.subject).toBe('2 accounts are overdue for an import');
    expect(two.body).toContain('Amex: last import 2026-07-27 (21 days ago)');
  });
```

- [ ] **Step 5: Run the three files and typecheck**

Run: `npx vitest run tests/lib/notify/evaluate/stale.test.ts tests/lib/notify/render.test.ts tests/lib/notify/events.test.ts`
Expected: PASS. Run `npx tsc --noEmit`: expected clean — `stale.ts` was the only producer of the batch input, and `tsc` will name any other literal that still passes `weeks` at the top level (fix it by moving `weeks` onto each line).

- [ ] **Step 6: Commit**

```bash
git add src/lib/notify/evaluate/stale.ts src/lib/notify/render.ts tests/lib/notify/evaluate/stale.test.ts tests/lib/notify/render.test.ts
git commit -m "feat(notify): the stale-import reminder reads each account's own cadence

- account value wins, household value is the fallback, 0 excludes
- one overdue account states its own weeks; several say overdue
- body lines unchanged"
```

---

### Task 6: Settings copy — the household field is a default, and the event blurb says so

**Files:**
- Modify: `src/app/(app)/settings/notifications/notifications-client.tsx:1185` (the `hint` of the `staleImportWeeks` field)
- Modify: `src/lib/notify/events.ts:187-196` (the `stale_import` blurb)
- Modify: `tests/app/notifications-client.test.tsx` (one assertion in the `'renders the five knobs…'` test at `:304-311`)

**Interfaces:** none new. The field's `name`/`id` (`staleImportWeeks`) and its label are unchanged — `tests/app/notifications-client.test.tsx:306` pins the `name`.

- [ ] **Step 1: Write the failing assertion**

In `tests/app/notifications-client.test.tsx`, inside the test `'renders the five knobs with their defaults in the hint text'`, add as its last line:

```ts
    // Spec 2026-09-28 §2.2: this number is now the DEFAULT; each account may carry its own.
    expect(container.textContent).toContain('an account can set its own under Settings → Accounts');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/notifications-client.test.tsx`
Expected: that one test FAILS on the new `toContain`.

- [ ] **Step 3: Change the two strings**

In `notifications-client.tsx`, the `staleImportWeeks` `<Field>`'s `hint` becomes:

```tsx
hint="Default 3. The household default — an account can set its own under Settings → Accounts."
```

In `src/lib/notify/events.ts`, the `stale_import` entry's `blurb` becomes:

```ts
    blurb: 'An account has gone past its import cadence — its own, or the household default — with no import. One message a week naming every quiet account.',
```

- [ ] **Step 4: Run both test files and commit**

Run: `npx vitest run tests/app/notifications-client.test.tsx tests/lib/notify/events.test.ts` — expected PASS.

```bash
git add "src/app/(app)/settings/notifications/notifications-client.tsx" src/lib/notify/events.ts tests/app/notifications-client.test.tsx
git commit -m "docs(notify): the stale-import weeks field is the household default

- hint points at the per-account cadence on Settings → Accounts
- event blurb says which threshold applies"
```

---

### Task 7: `latestImportIso(viewer)` — the freshness read

**Files:**
- Create: `src/lib/import/freshness.ts`
- Create: `tests/lib/import/freshness.test.ts`
- Modify: `tests/ops/visibility-invariants.test.ts:21-40` (`REQUIRE_VIEWER`)

**Interfaces:**
- Produces: `latestImportIso(viewer: Viewer): string | null` — the date (`YYYY-MM-DD`) of the newest `imports` row among **active** accounts the viewer may see, or `null` when there is none. Tasks 8-9 consume it.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/import/freshness.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { setAccountActive } from '@/lib/accounts';
import { HOUSEHOLD_VIEWER, type Viewer } from '@/lib/auth/viewer';
import { latestImportIso } from '@/lib/import/freshness';

let t: TestDb;
let userId = 0;
afterEach(() => t.cleanup());

function setup(): void {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'importer' });
}

function importAt(accountId: number, createdAt: string): void {
  t.db.run(
    sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
        values (${accountId}, null, ${'export.csv'}, ${userId}, 0, 0, 0, ${createdAt})`,
  );
}

/**
 * Spec 2026-09-28 §2.1. The one fact the digest line states: when was anything last imported, among
 * accounts this viewer may see. Same ownership rule listAccounts applies (ruling R2).
 */
describe('latestImportIso', () => {
  it('is null when nothing has ever been imported', () => {
    setup();
    insertTestAccount(t.db);
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBeNull();
  });

  it('is the newest import across every active account, as a date', () => {
    setup();
    const a = insertTestAccount(t.db, { name: 'Chequing' });
    const b = insertTestAccount(t.db, { name: 'Amex', type: 'credit' });
    importAt(a, '2026-08-10T12:00:00.000Z');
    importAt(b, '2026-08-16T23:59:00.000Z');
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-16');
  });

  it('ignores a deactivated account', () => {
    setup();
    const a = insertTestAccount(t.db, { name: 'Chequing' });
    const closed = insertTestAccount(t.db, { name: 'Old Card', type: 'credit' });
    importAt(a, '2026-08-10T12:00:00.000Z');
    importAt(closed, '2026-08-16T12:00:00.000Z');
    setAccountActive(closed, false);
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-10');
  });

  /** Review focus 2. A joint account (owner NULL) is not theirs -- listAccounts' own rule. */
  it('a self-scoped viewer sees only their own accounts, never the joint one', () => {
    setup();
    const bob = insertTestUser(t.db, { username: 'bob', role: 'member' });
    const joint = insertTestAccount(t.db, { name: 'Joint Chequing' });
    const bobs = insertTestAccount(t.db, { name: 'Bob Visa', type: 'credit', ownerUserId: bob });
    importAt(joint, '2026-08-16T12:00:00.000Z');
    importAt(bobs, '2026-08-10T12:00:00.000Z');
    const self: Viewer = { id: bob, role: 'member', visibility: 'self' };
    expect(latestImportIso(self)).toBe('2026-08-10');
    expect(latestImportIso(HOUSEHOLD_VIEWER)).toBe('2026-08-16');
  });

  it('is null for a self-scoped viewer whose own accounts have no imports, even when the household has some', () => {
    setup();
    const bob = insertTestUser(t.db, { username: 'bob', role: 'member' });
    const joint = insertTestAccount(t.db, { name: 'Joint Chequing' });
    insertTestAccount(t.db, { name: 'Bob Visa', type: 'credit', ownerUserId: bob });
    importAt(joint, '2026-08-16T12:00:00.000Z');
    expect(latestImportIso({ id: bob, role: 'member', visibility: 'self' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/import/freshness.test.ts`
Expected: FAIL — `Cannot find module '@/lib/import/freshness'`.

- [ ] **Step 3: Write the module**

Create `src/lib/import/freshness.ts`:

```ts
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, imports } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';

/**
 * Spec 2026-09-28 §2.1. When was anything last imported, among the accounts this viewer may see.
 *
 * The weekly and monthly digests open with this date, because they fire on a clock and a reader
 * cannot otherwise tell a summary built on yesterday's import from one built on a month-old one.
 * It is a fact about IMPORTS, never about transactions: commitImport writes its row before it
 * counts anything, so a CSV that yielded nothing new still moved this date -- "somebody looked" is
 * the question, and a quiet account that was checked is fresh.
 *
 * Ruling R2, exactly as listAccounts applies it: a self-scoped viewer's answer comes from accounts
 * they own, and a joint account (owner NULL) is not one of them. The family channel's copy is
 * rendered through HOUSEHOLD_VIEWER and sees everything. Listed in REQUIRE_VIEWER
 * (tests/ops/visibility-invariants.test.ts) so the parameter can never become optional.
 *
 * Active accounts only. A deactivated account is out of the reminder's sight (evaluate/stale.ts)
 * and out of this for the same reason: nobody is expected to import into it.
 */
export function latestImportIso(viewer: Viewer): string | null {
  const scope = ownerScope(viewer);
  const clauses: SQL[] = [eq(accounts.isActive, true)];
  if (scope !== null) clauses.push(eq(accounts.ownerUserId, scope));
  const row = getDb()
    .select({ newest: sql<string | null>`max(${imports.createdAt})` })
    .from(imports)
    .innerJoin(accounts, eq(accounts.id, imports.accountId))
    .where(and(...clauses))
    .get();
  const newest = row?.newest ?? null;
  return newest === null ? null : newest.slice(0, 10);
}
```

- [ ] **Step 4: Register it with the R2 guard**

In `tests/ops/visibility-invariants.test.ts`, add to `REQUIRE_VIEWER` after the `listAccounts` entry:

```ts
  // Spec 2026-09-28 §2.1: the digests' "Last import" date. A self-scoped member must never read
  // another member's account date off the top of their own summary.
  { file: 'src/lib/import/freshness.ts', fn: 'latestImportIso' },
```

- [ ] **Step 5: Run the test and the guard, commit**

Run: `npx vitest run tests/lib/import/freshness.test.ts tests/ops/visibility-invariants.test.ts` — expected PASS.

```bash
git add src/lib/import/freshness.ts tests/lib/import/freshness.test.ts tests/ops/visibility-invariants.test.ts
git commit -m "feat(import): latestImportIso, viewer-scoped

- newest imports row among active accounts the viewer may see
- listed in REQUIRE_VIEWER"
```

---

### Task 8: The renderer opens a digest with `Last import <date>.`

**Files:**
- Modify: `src/lib/notify/render.ts:180-200` (weekly personal input), `:200-225` (weekly household input), `:344-372` (monthly input), `:960-969` (weekly case), `:1180-1181` (monthly case), plus one new helper beside `renderDigest`
- Modify: `tests/lib/notify/render.test.ts` — every `weekly_digest`/`monthly_digest` literal gains `lastImportIso`; new tests

**Interfaces:**
- Produces: `lastImportIso: string | null` is a **required** field on all three digest inputs. `withFreshness(lastImportIso, body)` is module-private. Task 9 supplies the value at every call site.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/notify/render.test.ts`:

1. In the `'§10.2: the weekly digest'` describe, add `lastImportIso: '2026-08-16',` to the `full` fixture (after `toIso`).
2. In the `'Task 16 (v1.7.0): the monthly digest'` describe, add `lastImportIso: null,` to its `full` fixture (after `savings: null`).
3. In the sample table (around line 547), add `lastImportIso: null,` to each `weekly_digest` sample and to the `monthly_digest` sample.
4. The household-variant test (`'v1.28.0: the household variant names members…'`) passes its own literal — add `lastImportIso: null,` to it.
5. Append a describe:

```ts
/**
 * Spec 2026-09-28 §2.1. A digest fires on a clock, so "built on what?" is a live question; alerts
 * fire because a transaction landed and do not get this line. Date only, first, then a blank line.
 */
describe('spec 2026-09-28 §2.1: the freshness line', () => {
  const weekly = {
    event: 'weekly_digest',
    variant: 'personal',
    fromIso: '2026-08-10',
    toIso: '2026-08-16',
    householdSpentCents: 12800,
    personalSpentCents: 4100,
    topCategories: [{ name: 'Groceries', cents: 4021 }],
    topMerchants: [],
    reviewCount: 0,
    budgets: { over: [], pace: [], close: [] },
    openMonths: [],
  } as const;

  it('is the first line of a weekly digest, followed by a blank line', () => {
    const { body } = renderEvent({ ...weekly, lastImportIso: '2026-08-16' });
    expect(body.startsWith('Last import 2026-08-16.\n\nHousehold spend: $128.00')).toBe(true);
  });

  it('is omitted, with no blank line left behind, when nothing has been imported', () => {
    const { body } = renderEvent({ ...weekly, lastImportIso: null });
    expect(body.startsWith('Household spend: $128.00')).toBe(true);
    expect(body).not.toContain('Last import');
  });

  it('still opens the empty digest, where it matters most', () => {
    const { body } = renderEvent({
      ...weekly,
      lastImportIso: '2026-07-30',
      householdSpentCents: 0,
      personalSpentCents: 0,
      topCategories: [],
    });
    expect(body.startsWith('Last import 2026-07-30.\n\nNo transactions were recorded this week.')).toBe(true);
  });

  it('opens the household variant the same way', () => {
    const { body } = renderEvent({
      event: 'weekly_digest',
      variant: 'household',
      lastImportIso: '2026-08-16',
      fromIso: '2026-08-10',
      toIso: '2026-08-16',
      householdSpentCents: 12800,
      members: [{ name: 'Alex', cents: 12800 }],
      unattributedCents: 0,
      topCategories: [],
      topMerchants: [],
      reviewCount: 0,
      budgets: { over: [], pace: [], close: [] },
      openMonths: [],
    });
    expect(body.startsWith('Last import 2026-08-16.\n\nHousehold spend: $128.00')).toBe(true);
  });

  it('opens the monthly digest, and leaves the empty month alone when there is no date', () => {
    const monthly = {
      event: 'monthly_digest',
      month: '2026-07',
      incomeCents: 500000,
      spendCents: 320000,
      netCents: 180000,
      budgetedLimitCents: 0,
      budgetedSpentCents: 0,
      topMerchants: [],
      savings: null,
    } as const;
    expect(renderEvent({ ...monthly, lastImportIso: '2026-07-31' }).body.startsWith('Last import 2026-07-31.\n\nIncome: $5,000.00')).toBe(true);
    expect(
      renderEvent({ ...monthly, lastImportIso: null, incomeCents: 0, spendCents: 0, netCents: 0 }).body,
    ).toBe('No transactions were recorded last month.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/notify/render.test.ts`
Expected: the five new tests FAIL (no `Last import` line is rendered). The pre-existing tests still pass — the added field is ignored by the current renderer.

- [ ] **Step 3: Implement**

In `src/lib/notify/render.ts`:

Add `lastImportIso` to the weekly **personal** input, immediately after `variant: 'personal';`:

```ts
      /**
       * Spec 2026-09-28 §2.1. The date of the newest import among the accounts this recipient may
       * see, or null when there has never been one. Rendered as the FIRST line of the body. Required
       * rather than optional so every call site is a compiler-checked edit; supplied by
       * latestImportIso(viewer) in evaluate/digest.ts.
       */
      lastImportIso: string | null;
```

Add to the weekly **household** input, after `variant: 'household';`:

```ts
      /** Spec 2026-09-28 §2.1. Household-wide (rendered through HOUSEHOLD_VIEWER). */
      lastImportIso: string | null;
```

Add to the `monthly_digest` input, after `month: string;`:

```ts
      /** Spec 2026-09-28 §2.1. Same line the weekly digest opens with; same source. */
      lastImportIso: string | null;
```

Add the helper immediately above `function renderDigest(`:

```ts
/**
 * Spec 2026-09-28 §2.1. The first line of a summary says what the summary is built on.
 *
 * Digests only, deliberately. An alert ("Unusual charge", "Budget 80%") fires BECAUSE a transaction
 * just landed, so its data is fresh by construction and a date would add nothing. A digest fires on
 * a clock whether anyone imported or not, so it is the one message where "built on what?" is a live
 * question. Date only: which accounts are behind is the stale_import reminder's job, and a summary
 * that also lists laggards is two messages in one envelope.
 *
 * Omitted outright when there is no date, so the empty digests keep their exact one-line bodies.
 */
function withFreshness(lastImportIso: string | null, body: string): string {
  return lastImportIso === null ? body : `Last import ${lastImportIso}.\n\n${body}`;
}
```

In `renderEvent`, the `weekly_digest` case becomes:

```ts
    case 'weekly_digest':
      return input.variant === 'household'
        ? {
            subject: `Household weekly summary — ${input.fromIso} to ${input.toIso}`,
            body: withFreshness(input.lastImportIso, renderHouseholdDigest(input)),
          }
        : {
            subject: `Weekly summary — ${input.fromIso} to ${input.toIso}`,
            body: withFreshness(input.lastImportIso, renderDigest(input)),
          };
```

(Keep the existing comment above it about the two subjects.) The `monthly_digest` case becomes:

```ts
    case 'monthly_digest':
      return {
        subject: `Monthly summary for ${monthLabel(input.month)}`,
        body: withFreshness(input.lastImportIso, renderMonthlyDigest(input)),
      };
```

- [ ] **Step 4: Run the renderer tests and typecheck**

Run: `npx vitest run tests/lib/notify/render.test.ts` — expected PASS.
Run: `npx tsc --noEmit` — expected to FAIL in exactly three places: `src/lib/notify/evaluate/digest.ts` (two `renderEvent` calls) and `src/lib/notify/evaluate/monthly.ts` (one), each missing `lastImportIso`. That is Task 9's job; do **not** commit a red typecheck. Continue straight into Task 9 and commit both together.

---

### Task 9: The evaluators supply the date

**Files:**
- Modify: `src/lib/notify/evaluate/digest.ts` (import; the personal `renderEvent` at `:217`; `buildHouseholdDigest`'s `renderEvent` at `:324`)
- Modify: `src/lib/notify/evaluate/monthly.ts` (import; `renderMonthlyDigestFor`'s `renderEvent` at `:407`)
- Modify: `tests/lib/notify/evaluate/digest.test.ts`, `tests/lib/notify/evaluate/digest-household.test.ts`, `tests/lib/notify/evaluate/monthly.test.ts` (append tests)

**Interfaces:**
- Consumes: `latestImportIso(viewer)` (Task 7); the three inputs from Task 8.

- [ ] **Step 1: Write the failing evaluator tests**

Append to `tests/lib/notify/evaluate/digest.test.ts` (uses its existing `emailUser`, `spend`, `accountId`, `NOW`, and `setUserVisibility`):

```ts
/** Spec 2026-09-28 §2.1. Where the date comes from, and whose accounts it may look at. */
describe('spec 2026-09-28 §2.1: the weekly digest opens with the last import date', () => {
  function importAt(createdAt: string, account: number = accountId): void {
    t.db.run(
      sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
          values (${account}, null, ${'export.csv'}, ${creatorId}, 0, 0, 0, ${createdAt})`,
    );
  }
  const bodyOf = (userId: number): string =>
    (t.sqlite.prepare('select body from notification_outbox where user_id = ?').get(userId) as { body: string }).body;

  it('states the newest import as the first line', () => {
    const userId = emailUser();
    importAt('2026-08-16T20:00:00.000Z');
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(bodyOf(userId).startsWith('Last import 2026-08-16.\n\n')).toBe(true);
  });

  it('has no such line for a household that has never imported', () => {
    const userId = emailUser();
    expect(evaluateWeeklyDigest({ userId, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(bodyOf(userId)).not.toContain('Last import');
  });

  /** Review focus 2. */
  it('ruling R2: a self-scoped member gets their own account date, not the joint one', () => {
    const member = emailUser('member');
    setUserVisibility(member, 'self');
    const own = insertTestAccount(t.db, { name: 'Own Visa', type: 'credit', ownerUserId: member });
    importAt('2026-08-16T20:00:00.000Z'); // the joint account, newer
    importAt('2026-08-10T20:00:00.000Z', own); // theirs, older

    expect(evaluateWeeklyDigest({ userId: member, slotDate: '2026-08-17', now: NOW })).toBe(1);
    expect(bodyOf(member).startsWith('Last import 2026-08-10.\n\n')).toBe(true);
  });
});
```

Append to `tests/lib/notify/evaluate/digest-household.test.ts` (uses its `person`, `familyTelegram`, `spend`, `householdRow`, `SLOT`, `NOW`; check the file's own import list and add `insertTestAccount` and `sql` if absent):

```ts
/** Spec 2026-09-28 §2.1: the room's copy is household-wide, whoever's slot fired first. */
describe('spec 2026-09-28 §2.1: the household digest opens with the household-wide last import', () => {
  it('uses the newest import across every account, including one the evaluating member cannot see', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    familyTelegram(alex);
    spend(70000, alex);
    const robins = insertTestAccount(t.db, { name: 'Robin Visa', type: 'credit', ownerUserId: robin });
    t.db.run(
      sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
          values (${robins}, null, ${'export.csv'}, ${robin}, 0, 0, 0, ${'2026-08-16T20:00:00.000Z'})`,
    );

    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });

    expect(householdRow().body.startsWith('Last import 2026-08-16.\n\nHousehold spend: $700.00')).toBe(true);
  });
});
```

Append to `tests/lib/notify/evaluate/monthly.test.ts` (uses `optedInUser`, `enableMonthlyDigest`, `setPref`, `seedHistory`, `accountId`, `creatorId`, `TZ`, `keys`):

```ts
/** Spec 2026-09-28 §2.1, and review focus 6: the empty-month body stays byte-identical without a date. */
describe('spec 2026-09-28 §2.1: the monthly digest opens with the last import date', () => {
  it('states it first when the household has imported', () => {
    const userId = optedInUser();
    enableMonthlyDigest(userId);
    setPref(userId, 'predicted_vs_actual', 'email', false);
    setPref(userId, 'suggested_budget_refresh', 'email', false);
    seedHistory();
    t.db.run(
      sql`insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
          values (${accountId}, null, ${'export.csv'}, ${creatorId}, 0, 0, 0, ${'2026-07-31T20:00:00.000Z'})`,
    );

    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const row = t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string };
    expect(row.body.startsWith('Last import 2026-07-31.\n\nIncome:')).toBe(true);
  });

  it('a household with no imports gets no freshness line, so the empty-month body is unchanged', () => {
    const userId = optedInUser();
    enableMonthlyDigest(userId);
    setPref(userId, 'predicted_vs_actual', 'email', false);
    setPref(userId, 'suggested_budget_refresh', 'email', false);

    expect(evaluateMonthBoundary({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const row = t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string };
    expect(row.body).toBe('No transactions were recorded last month.');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/notify/evaluate/digest.test.ts tests/lib/notify/evaluate/digest-household.test.ts tests/lib/notify/evaluate/monthly.test.ts`
Expected: the files fail to **load** — `renderEvent` is called without the required `lastImportIso` and esbuild does not typecheck, so the actual failure is the assertions: no `Last import` line appears. (The "no imports" cases pass already.)

- [ ] **Step 3: Implement**

In `src/lib/notify/evaluate/digest.ts`:

Add `import { latestImportIso } from '@/lib/import/freshness';`.

In the personal `renderEvent({ event: 'weekly_digest', variant: 'personal', …` call, add after `toIso: to,`:

```ts
    // Spec 2026-09-28 §2.1. Through THIS recipient's viewer (ruling R2): a self-scoped member's
    // date comes from accounts they own.
    lastImportIso: latestImportIso(viewer),
```

In `buildHouseholdDigest`'s `renderEvent({ event: 'weekly_digest', variant: 'household', …` call, add after `toIso: to,`:

```ts
    // Household-wide, through the same synthetic viewer every other figure in this body uses.
    lastImportIso: latestImportIso(HOUSEHOLD_VIEWER),
```

In `src/lib/notify/evaluate/monthly.ts`:

Add `import { latestImportIso } from '@/lib/import/freshness';`.

In `renderMonthlyDigestFor`'s `renderEvent({ event: 'monthly_digest', …` call, add after `month: endedMonth,`:

```ts
    // Spec 2026-09-28 §2.1. `viewer` is the recipient's for the personal copy and HOUSEHOLD_VIEWER
    // for the room's (fireMonthlyDigest calls this twice), so ruling R2 holds by construction.
    lastImportIso: latestImportIso(viewer),
```

- [ ] **Step 4: Run the three files, then the whole notify tree, then typecheck**

Run: `npx vitest run tests/lib/notify/` — expected PASS across the tree (`render.test.ts`, the evaluators, `family-channel-pass`, `outbox`).
Run: `npx tsc --noEmit` — expected clean.
Run: `npx vitest run tests/app/dashboard.test.tsx` — the manual "Send me a summary now" path goes through `evaluateWeeklyDigest`; expected PASS unchanged.

- [ ] **Step 5: Commit Tasks 8 and 9 together**

```bash
git add src/lib/notify/render.ts src/lib/notify/evaluate/digest.ts src/lib/notify/evaluate/monthly.ts tests/lib/notify/render.test.ts tests/lib/notify/evaluate/digest.test.ts tests/lib/notify/evaluate/digest-household.test.ts tests/lib/notify/evaluate/monthly.test.ts
git commit -m "feat(notify): the weekly and monthly digests open with the last import date

- lastImportIso is a required render input; the renderer prepends one line
- digests only: alerts fire because a transaction landed
- personal copy is viewer-scoped, the family channel's is household-wide
- omitted when nothing was ever imported, so the empty bodies are unchanged"
```

---

# Part B — Confirm every group in the review view

### Task 10: `sweepTransactionRows` and `bulkConfirmOwnCategory`

**Files:**
- Modify: `src/app/(app)/transactions/actions.ts:592-610` (`groupTransactionIds` → built on a new `sweepTransactionRows`); the `@/lib/transactions` import gains `type TransactionRow`
- Modify: `src/lib/transactions.ts` (add `ConfirmOwnResult` and `bulkConfirmOwnCategory` immediately after `bulkSetCategory`, before `bulkSetTransfer`'s docblock)
- Create: `tests/lib/bulk-confirm-own.test.ts`

**Interfaces:**
- Produces (actions.ts, module-private): `sweepTransactionRows(filter: TransactionFilter, viewer: SessionUser): { id: number; categoryId: number | null; source: TransactionRow['source'] }[]`
- Produces (transactions.ts):
  ```ts
  export interface ConfirmOwnResult { changed: number; skipped: number; uncategorized: number; alreadyConfirmed: number; categories: number }
  export function bulkConfirmOwnCategory(rows: readonly { id: number; categoryId: number | null; source: TransactionRow['source'] }[], userId: number, actorRole: 'admin' | 'member'): ConfirmOwnResult
  ```
  No `ok` discriminant: with `createRule: false`, `confirmCategory` never reaches its rule-ownership refusal (`src/lib/categorize/engine.ts`, the `if (input.createRule !== false …)` gate), so there is no refusal to return and a dead `owned_by_another` branch here would be exactly the "protection that reads live but is unreachable" the v1.27.0 ops guard exists to prevent.

- [ ] **Step 1: Write the failing lib test**

Create `tests/lib/bulk-confirm-own.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { bulkConfirmOwnCategory } from '@/lib/transactions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const add = (over: Partial<{ description: string; categoryId: number | null; source: string }> = {}) => {
    const description = over.description ?? 'CORNER MARKET';
    return current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${joint}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, -1000, ${over.categoryId ?? null}, ${over.source ?? 'rule'}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  };
  const stored = (id: number) =>
    current!.sqlite.prepare('select category_id as categoryId, categorization_source as source from transactions where id = ?').get(id) as {
      categoryId: number | null;
      source: string;
    };
  return { db: current.db, alice, add, stored };
}

/**
 * Spec 2026-09-28 §2.3. Ten groups, one press: each row is confirmed to the category it ALREADY
 * has, through the same confirmCategory loop bulkSetCategory runs, with createRule: false.
 */
describe('bulkConfirmOwnCategory', () => {
  it('confirms each row to its own category and counts the categories it touched', () => {
    const { db, alice, add, stored } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add({ description: 'CORNER MARKET', categoryId: groceries });
    const b = add({ description: 'GROCER 88', categoryId: groceries });
    const c = add({ description: 'CAFE ROMA', categoryId: coffee });

    const result = bulkConfirmOwnCategory(
      [
        { id: a, categoryId: groceries, source: 'rule' },
        { id: b, categoryId: groceries, source: 'rule' },
        { id: c, categoryId: coffee, source: 'rule' },
      ],
      alice,
      'admin',
    );

    expect(result).toEqual({ changed: 3, skipped: 0, uncategorized: 0, alreadyConfirmed: 0, categories: 2 });
    expect(stored(a)).toEqual({ categoryId: groceries, source: 'manual' });
    expect(stored(c)).toEqual({ categoryId: coffee, source: 'manual' });
  });

  it('leaves a row with no category alone and counts it -- there is nothing to confirm', () => {
    const { alice, add, stored } = setup();
    const none = add({ description: 'MYSTERY VENDOR', categoryId: null, source: 'none' });

    const result = bulkConfirmOwnCategory([{ id: none, categoryId: null, source: 'none' }], alice, 'admin');

    expect(result).toEqual({ changed: 0, skipped: 0, uncategorized: 1, alreadyConfirmed: 0, categories: 0 });
    expect(stored(none)).toEqual({ categoryId: null, source: 'none' });
  });

  it('leaves a row already set by hand out of the count', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const done = add({ categoryId: groceries, source: 'manual' });

    const result = bulkConfirmOwnCategory([{ id: done, categoryId: groceries, source: 'manual' }], alice, 'admin');

    expect(result).toEqual({ changed: 0, skipped: 0, uncategorized: 0, alreadyConfirmed: 1, categories: 0 });
  });

  it('writes no rule, because confirming is not new information', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const a = add({ categoryId: groceries });
    bulkConfirmOwnCategory([{ id: a, categoryId: groceries, source: 'rule' }], alice, 'admin');
    expect((current!.sqlite.prepare('select count(*) as n from categorization_rules').get() as { n: number }).n).toBe(0);
  });
});
```

If the rules table is not named `categorization_rules`, read `src/db/schema.ts` for the table `listRules` (src/lib/categorize/rules.ts) reads and use that name; `tests/lib/transactions.test.ts:521` shows `listRules('category')` as the alternative — `expect(listRules('category')).toHaveLength(0)` with `import { listRules } from '@/lib/categorize/rules';` is equally acceptable.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/bulk-confirm-own.test.ts`
Expected: FAIL — `bulkConfirmOwnCategory` is not exported from `@/lib/transactions`.

- [ ] **Step 3: Add the lib function**

In `src/lib/transactions.ts`, immediately after `bulkSetCategory`'s closing brace:

```ts
/** Spec 2026-09-28 §2.3. What "Confirm every group" did, in the numbers the message states. */
export interface ConfirmOwnResult {
  changed: number;
  /** Split rows, refused by confirmCategory for the reason bulkSetCategory's docblock gives. */
  skipped: number;
  /** Rows with no category: nothing to confirm, left for the person to pick. */
  uncategorized: number;
  /** Rows already `manual`: left alone and not counted, so "Confirmed N" is what actually moved. */
  alreadyConfirmed: number;
  /** Distinct categories among the rows that changed. */
  categories: number;
}

/**
 * Spec 2026-09-28 §2.3: "Confirm every group". Every row confirmed to the category it ALREADY has --
 * bulkSetCategory with a per-row category instead of one for the batch, and createRule: false
 * for the reason bulkConfirmGroupAction gives (confirming is not new information).
 *
 * The same one-transaction loop over confirmCategory, so every guard inside it (the split refusal,
 * the untrain/retrain pair) applies without being restated. NO ownership branch, and that is
 * deliberate rather than an omission: confirmCategory only reaches its rule-ownership refusal
 * inside its `createRule !== false` gate, so with createRule false the refusal is unreachable, and
 * a branch here that handled it would read like a live protection while protecting nothing --
 * the exact shape the v1.27.0 ops guard was written to prevent.
 *
 * The transaction is still one transaction: a thrown error partway (a missing row, a constraint)
 * rolls back every write this call already made, the same guarantee bulkSetCategory carries.
 */
export function bulkConfirmOwnCategory(
  rows: readonly { id: number; categoryId: number | null; source: TransactionRow['source'] }[],
  userId: number,
  actorRole: 'admin' | 'member',
): ConfirmOwnResult {
  const result: ConfirmOwnResult = { changed: 0, skipped: 0, uncategorized: 0, alreadyConfirmed: 0, categories: 0 };
  const categories = new Set<number>();
  getDb().transaction(() => {
    for (const row of rows) {
      if (row.categoryId === null) {
        result.uncategorized += 1;
        continue;
      }
      if (row.source === 'manual') {
        result.alreadyConfirmed += 1;
        continue;
      }
      const confirmed = confirmCategory({ transactionId: row.id, categoryId: row.categoryId, userId, createRule: false, actorRole });
      if (confirmed.ok) {
        result.changed += 1;
        categories.add(row.categoryId);
      } else {
        result.skipped += 1;
      }
    }
  });
  result.categories = categories.size;
  return result;
}
```

- [ ] **Step 4: Run the lib test to verify it passes**

Run: `npx vitest run tests/lib/bulk-confirm-own.test.ts` — expected PASS (4 tests).

- [ ] **Step 5: Extract the sweep in actions.ts**

In `src/app/(app)/transactions/actions.ts`, change the `@/lib/transactions` import to also bring `type TransactionRow` (add it to the existing braces). Replace `groupTransactionIds` (the function body from `function groupTransactionIds(` to its closing brace) with:

```ts
/**
 * Spec 2026-09-28 §2.3. Every row one filtered view matches, as the three fields a confirm needs.
 * The paging argument on groupTransactionIds's old docblock applies unchanged: listTransactions
 * clamps pageSize to 200, so "all of them" is a sweep, bounded by the FIRST query's own page count
 * so that no write it precedes can move the loop's exit. The rows come back from a VIEWER-SCOPED
 * read, so they are derived, not accepted from the request.
 */
function sweepTransactionRows(
  filter: TransactionFilter,
  viewer: SessionUser,
): { id: number; categoryId: number | null; source: TransactionRow['source'] }[] {
  const pick = (row: TransactionRow) => ({ id: row.id, categoryId: row.categoryId, source: row.source });
  const first = listTransactions({ ...filter, page: 1, pageSize: GROUP_SWEEP_PAGE_SIZE }, viewer);
  const rows = first.rows.map(pick);
  for (let page = 2; page <= first.pageCount; page += 1) {
    rows.push(...listTransactions({ ...filter, page, pageSize: GROUP_SWEEP_PAGE_SIZE }, viewer).rows.map(pick));
  }
  return rows;
}

function groupTransactionIds(filter: TransactionFilter, groupCategoryId: string, viewer: SessionUser): number[] {
  const clusterFilter: TransactionFilter =
    groupCategoryId === ''
      ? // The null cluster. `categoryExact` is meaningless for it (there is no id to be exact
        // about) and is cleared rather than left at whatever the posted URL carried, so a stale
        // `?exact=1` cannot change which rows "uncategorized" means.
        { ...filter, categoryId: 'uncategorized', categoryExact: false }
      : { ...filter, categoryId: Number(groupCategoryId), categoryExact: true };
  return sweepTransactionRows(clusterFilter, viewer).map((row) => row.id);
}
```

Keep the long docblock that sits above `groupTransactionIds` today; it still describes the cluster derivation.

- [ ] **Step 6: Run the existing group-action tests, typecheck, commit**

Run: `npx vitest run tests/app/transactions-actions.test.ts` — expected PASS (the refactor changes no behaviour).
Run: `npx tsc --noEmit` — expected clean.

```bash
git add src/lib/transactions.ts "src/app/(app)/transactions/actions.ts" tests/lib/bulk-confirm-own.test.ts
git commit -m "feat(transactions): bulkConfirmOwnCategory, and the view sweep behind the group actions

- each row confirmed to the category it already has, createRule false
- uncategorized and already-manual rows counted, not touched
- groupTransactionIds now derives its ids through sweepTransactionRows"
```

---

### Task 11: `bulkConfirmViewAction`

**Files:**
- Modify: `src/app/(app)/transactions/actions.ts` (add after `bulkRecategorizeGroupAction`); the `@/lib/transactions` import gains `bulkConfirmOwnCategory`
- Modify: `tests/app/transactions-actions.test.ts` (new tests inside the describe that owns `seedImport`/`addRuleRow`/`sourceOf`, i.e. the one containing `'confirms EVERY row in the group…'`; import `bulkConfirmViewAction` beside `bulkConfirmGroupAction`)

**Interfaces:**
- Consumes: `sweepTransactionRows`, `bulkConfirmOwnCategory` (Task 10), `filterFromQuery`, `splitSkipSentence`.
- Produces: `bulkConfirmViewAction(_prev: ActionState, formData: FormData): Promise<ActionState>`; form field `scope` only.

- [ ] **Step 1: Write the failing tests**

In `tests/app/transactions-actions.test.ts`, add `bulkConfirmViewAction,` to the import list from `@/app/(app)/transactions/actions`. Inside the describe that defines `seedImport`/`addRuleRow`/`sourceOf`/`categoryOf`, append:

```ts
  /**
   * Spec 2026-09-28 §2.3: "Confirm every group". The whole view -- every cluster, every row page --
   * confirmed to the categories it already has, in one press.
   */
  describe('bulkConfirmViewAction', () => {
    /** Review focus 4. */
    it('confirms every row in the view across every cluster, not only a rendered page', async () => {
      const { db } = setup();
      const groceries = categoryIdByName(db, 'Groceries');
      const coffee = categoryIdByName(db, 'Coffee');
      const importId = seedImport('march.csv');
      const groceryIds = Array.from({ length: 60 }, (_, index) => addRuleRow({ importId, categoryId: groceries, merchant: `GREENFIELD ${index}` }));
      const coffeeIds = Array.from({ length: 5 }, (_, index) => addRuleRow({ importId, categoryId: coffee, merchant: `ROAST ${index}` }));

      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}&source=rule&group=category` }));

      expect(result.error).toBeUndefined();
      expect(result.message).toBe('Confirmed 65 transactions across 2 categories. Rules will leave them alone from now on.');
      expect([...groceryIds, ...coffeeIds].every((id) => sourceOf(id) === 'manual')).toBe(true);
      expect(categoryOf(coffeeIds[0])).toBe(coffee);
    });

    it('leaves rows with no category for the person, and says how many', async () => {
      const { db } = setup();
      const groceries = categoryIdByName(db, 'Groceries');
      const importId = seedImport('march.csv');
      const filed = addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
      const unknown = addRuleRow({ importId, categoryId: null, merchant: 'MYSTERY VENDOR', source: 'none' });

      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}&group=category` }));

      expect(result.message).toBe(
        'Confirmed 1 transaction across 1 category. Rules will leave it alone from now on. 1 with no category yet was left for you to pick.',
      );
      expect(sourceOf(filed)).toBe('manual');
      expect(sourceOf(unknown)).toBe('none');
    });

    it('honours the posted filter: another import is left alone', async () => {
      const { db } = setup();
      const groceries = categoryIdByName(db, 'Groceries');
      const march = seedImport('march.csv');
      const april = seedImport('april.csv');
      const target = addRuleRow({ importId: march, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
      const other = addRuleRow({ importId: april, categoryId: groceries, merchant: 'GREENFIELD MARKET' });

      await bulkConfirmViewAction({}, formData({ scope: `import=${march}&source=rule&group=category` }));

      expect(sourceOf(target)).toBe('manual');
      expect(sourceOf(other)).toBe('rule');
    });

    /** Review focus 5: never "Confirmed 0". */
    it('says so when everything in the view was already set by hand', async () => {
      const { db } = setup();
      const groceries = categoryIdByName(db, 'Groceries');
      const importId = seedImport('march.csv');
      addRuleRow({ importId, categoryId: groceries, merchant: 'BY HAND SHOP', source: 'manual' });

      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}&group=category` }));

      expect(result.error).toBe('Everything in this view was already set by hand.');
    });

    it('says so when nothing in the view has a category to confirm', async () => {
      const { db } = setup();
      const importId = seedImport('march.csv');
      addRuleRow({ importId, categoryId: null, merchant: 'MYSTERY VENDOR', source: 'none' });

      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}&group=category` }));

      expect(result.error).toBe('Nothing in this view has a category to confirm yet — pick one for each group instead.');
    });

    it('reports honestly when the view has emptied out from under the dialog', async () => {
      setup();
      const importId = seedImport('march.csv');
      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}&group=category` }));
      expect(result.error).toBe('This view is empty now — nothing was changed.');
    });

    it('refuses a cross-origin post before reading anything', async () => {
      const { db } = setup();
      const groceries = categoryIdByName(db, 'Groceries');
      const importId = seedImport('march.csv');
      const id = addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
      sameOrigin.value = false;

      const result = await bulkConfirmViewAction({}, formData({ scope: `import=${importId}` }));

      expect(result.error).toBe(CROSS_ORIGIN_ERROR);
      expect(sourceOf(id)).toBe('rule');
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/app/transactions-actions.test.ts`
Expected: the new describe FAILS at import — `bulkConfirmViewAction` is not exported.

- [ ] **Step 3: Implement**

In `src/app/(app)/transactions/actions.ts`, add `bulkConfirmOwnCategory` to the `@/lib/transactions` import. After `bulkRecategorizeGroupAction`'s closing brace, add:

```ts
/**
 * Spec 2026-09-28 §2.3: "Confirm every group".
 *
 * WHY IT EXISTS. The dashboard's rule-review card sends a person to this page grouped by category,
 * where each group carries "These are all correct". An import that landed in ten categories was ten
 * dialogs to say the same thing ten times. This is the one press: every transaction the view
 * matches, confirmed to the category it already has.
 *
 * Same design as the two group actions above and for the same reason: the SET IS DERIVED FROM THE
 * POSTED FILTER, never from ids, so the count the dialog states is the count the write honours,
 * across every row page and every group page. Same single confirm path (bulkConfirmOwnCategory ->
 * confirmCategory), createRule false, split rows skipped and reported.
 *
 * Three honest refusals instead of "Confirmed 0": an empty view, a view where nothing has a
 * category yet, and a view already entirely set by hand.
 */
const viewScopeSchema = z.object({ scope: z.string().max(2000) });

export async function bulkConfirmViewAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!isSameOrigin(await headers())) return { error: CROSS_ORIGIN_ERROR };

  const user = await requireUser();
  const parsed = viewScopeSchema.safeParse({ scope: String(formData.get('scope') ?? '') });
  if (!parsed.success) return { error: 'Invalid request.' };

  const filter = filterFromQuery(parsed.data.scope, user);
  const rows = sweepTransactionRows(filter, user);
  if (rows.length === 0) return { error: 'This view is empty now — nothing was changed.' };

  const result = bulkConfirmOwnCategory(rows, user.id, user.role);
  if (result.changed === 0) {
    return {
      error:
        result.uncategorized > 0 && result.alreadyConfirmed === 0
          ? 'Nothing in this view has a category to confirm yet — pick one for each group instead.'
          : 'Everything in this view was already set by hand.',
    };
  }
  revalidatePath('/transactions');
  revalidatePath('/review');

  const plural = result.changed === 1 ? '' : 's';
  const noun = result.categories === 1 ? 'category' : 'categories';
  const parts = [
    `Confirmed ${result.changed} transaction${plural} across ${result.categories} ${noun}. Rules will leave ${result.changed === 1 ? 'it' : 'them'} alone from now on.`,
  ];
  if (result.uncategorized > 0) {
    parts.push(`${result.uncategorized} with no category yet ${result.uncategorized === 1 ? 'was' : 'were'} left for you to pick.`);
  }
  const splits = splitSkipSentence(result.skipped);
  if (splits) parts.push(splits);
  return { message: parts.join(' ') };
}
```

- [ ] **Step 4: Run the file, then the ops guards that read actions.ts**

Run: `npx vitest run tests/app/transactions-actions.test.ts tests/ops/` — expected PASS. (`tests/ops/use-server-exports.test.ts` requires every export of a `'use server'` file to be an async function: `viewScopeSchema` is a `const`, not exported — keep it that way.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/transactions/actions.ts" tests/app/transactions-actions.test.ts
git commit -m "feat(transactions): confirm every group in a view with one action

- set derived from the posted filter, across every row and group page
- three honest refusals instead of Confirmed 0
- uncategorized and split rows counted in the message"
```

---

### Task 12: The button and the dialog

**Files:**
- Modify: `src/app/(app)/transactions/transactions-client.tsx` — the actions import (`:60-80`), state (`:646-657`), the two `??` chains (`:971` and `:983`), `groupList` (`:2626-2636`, add a header row), a new `viewConfirmDialog()` beside `groupConfirmDialog()` (`:2755`), and wherever `{groupConfirmDialog()}` is rendered, render `{viewConfirmDialog()}` beside it
- Modify: `tests/app/transactions-client.test.tsx:12-40` (mock), append a `describe`

**Interfaces:**
- Consumes: `bulkConfirmViewAction` (Task 11), `RowDialog`, `SubmitButton`, `buttonClass`, `CategoryGroupPage`.

- [ ] **Step 1: Write the failing tests**

In `tests/app/transactions-client.test.tsx`, add `bulkConfirmViewAction: vi.fn(async () => ({})),` to the `vi.mock('@/app/(app)/transactions/actions', …)` factory (next to `bulkConfirmGroupAction`). Append:

```ts
/** Spec 2026-09-28 §2.3: one press for the whole view, above the groups. The per-group buttons stay. */
describe('spec 2026-09-28 §2.3: Confirm every group', () => {
  it('sits above the groups, naming the view total and the group count', () => {
    const { container } = renderGrouped();
    const button = screen.getByRole('button', { name: 'Confirm every group' });
    const header = button.closest('div')!;
    expect((header.textContent ?? '').replace(/\s+/g, ' ')).toContain('41 transactions in 2 categories');
    // Above the list, not inside a group.
    expect(container.querySelector('ul[data-category-groups]')!.contains(button)).toBe(false);
    // The per-group buttons are still there.
    expect(screen.getAllByRole('button', { name: 'These are all correct' })).toHaveLength(2);
  });

  it('is not offered when no group on the page has a category', () => {
    renderGrouped({
      groups: [
        {
          categoryId: null,
          categoryName: 'Uncategorized',
          parentId: null,
          count: 3,
          totalCents: -30_00,
          preview: [{ id: 601, date: '2026-03-02', description: 'MYSTERY VENDOR', amountCents: -10_00 }],
        },
      ],
      groupCount: 1,
      totalCount: 3,
    });
    expect(screen.queryByRole('button', { name: 'Confirm every group' })).toBeNull();
  });

  it('opens a dialog that states the whole view, not this page', () => {
    renderGrouped();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm every group' }));
    expect(screen.getByRole('dialog', { name: /Confirm every group in this view/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm all 41' })).toBeTruthy();
    expect(screen.getByText(/every group and every page of them, not only what is on screen/)).toBeTruthy();
    expect(screen.getByText(/no category yet are left for you to pick/)).toBeTruthy();
  });

  it('posts the page filter and nothing else', async () => {
    const { bulkConfirmViewAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkConfirmViewAction);
    spy.mockClear();
    const { container } = renderGrouped();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm every group' }));
    fireEvent.submit(container.querySelector('[data-testid="view-confirm-dialog-backdrop"] form') as HTMLFormElement);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const submitted = spy.mock.calls.at(-1)![1] as FormData;
    expect(submitted.get('scope')).toBe('import=7&source=rule&group=category');
    expect(submitted.get('ids')).toBeNull();
    expect(submitted.get('groupCategoryId')).toBeNull();
  });

  it('Cancel closes the dialog and writes nothing', async () => {
    const { bulkConfirmViewAction } = await import('@/app/(app)/transactions/actions');
    const spy = vi.mocked(bulkConfirmViewAction);
    spy.mockClear();
    renderGrouped();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm every group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/transactions-client.test.tsx`
Expected: the five new tests FAIL — no `Confirm every group` button.

- [ ] **Step 3: Implement**

In `src/app/(app)/transactions/transactions-client.tsx`:

Add `bulkConfirmViewAction,` to the actions import block (after `bulkConfirmGroupAction,`).

Beside the group states (after line 657), add:

```ts
  // Spec 2026-09-28 §2.3: the view-level confirm. A boolean, not a group -- it acts on the filter.
  const [confirmView, setConfirmView] = useState(false);
  const [confirmViewState, confirmViewFormAction] = useActionState(bulkConfirmViewAction, initial);
```

In the `message` `??` chain, after `confirmGroupState.message ?? recatGroupState.message ??` add `confirmViewState.message ??`. In the `error` chain, after `confirmGroupState.error ?? recatGroupState.error ??` add `confirmViewState.error ??`.

In `groupList`, immediately after `<Card as="div">` and before the `<ul data-category-groups>` comment, add:

```tsx
        {/* Spec 2026-09-28 §2.3. One press for the whole view, above the groups rather than in a
            footer: the person arrived here from the dashboard's review card to say "yes" to what
            the rules did, and the button has to be visible before they open the first group. Not
            offered when no group on this page has a category -- there would be nothing to confirm
            -- and the per-group buttons stay for the cluster-by-cluster read. */}
        {groupPage.groups.some((group) => group.categoryId !== null) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
            <span className="text-sm text-muted">
              {`${groupPage.totalCount} transaction${groupPage.totalCount === 1 ? '' : 's'} in ${groupPage.groupCount} categor${groupPage.groupCount === 1 ? 'y' : 'ies'}`}
            </span>
            <button type="button" className={buttonClass('primary', 'sm')} onClick={() => setConfirmView(true)}>
              Confirm every group
            </button>
          </div>
        ) : null}
```

Add the dialog function immediately after `groupConfirmDialog()`:

```tsx
  /**
   * Spec 2026-09-28 §2.3, the view-level dialog. Same shell and the same honesty rule as
   * groupConfirmDialog: it states the VIEW's true total (groupPage.totalCount is the whole
   * filtered set, every group page included) and posts the filter, so the write recomputes the same
   * set. Rows with no category are named as left alone, because the server will leave them.
   */
  function viewConfirmDialog() {
    if (!confirmView || !groups) return null;
    const count = groups.totalCount;
    const noun = count === 1 ? 'transaction' : 'transactions';
    return (
      <RowDialog
        dialogId="view-confirm-dialog"
        title="Confirm every group in this view"
        description={`${count} ${noun} in ${groups.groupCount} categor${groups.groupCount === 1 ? 'y' : 'ies'}`}
        onClose={() => setConfirmView(false)}
      >
        <form action={confirmViewFormAction} onSubmit={() => setConfirmView(false)} className="flex flex-col gap-3">
          <input type="hidden" name="scope" value={currentQuery} />
          <p className="text-sm text-ink">
            {`All ${count} ${noun} stay in the categories they have now and are marked set by hand, so a
            future rule run leaves them alone. Nothing else about them changes.`}
          </p>
          <p className="text-sm text-muted">
            {`This is the whole view — every group and every page of them, not only what is on screen. Any
            with no category yet are left for you to pick, and a split transaction is left alone; the
            message afterwards says how many.`}
          </p>
          <div className="flex gap-2">
            <SubmitButton className="w-fit">{`Confirm all ${count}`}</SubmitButton>
            <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirmView(false)}>
              Cancel
            </button>
          </div>
        </form>
      </RowDialog>
    );
  }
```

`groups` is the `CategoryGroupPage | undefined` prop `groupList` is called with — find the prop's name at the top of the component (the test passes it as `groups={…}`) and use that identifier; if the component destructures it under another name, use that one.

Wherever `{groupConfirmDialog()}` is rendered in the JSX, render `{viewConfirmDialog()}` on the next line.

- [ ] **Step 4: Run the client tests and typecheck**

Run: `npx vitest run tests/app/transactions-client.test.tsx` — expected PASS.
Run: `npx tsc --noEmit` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/transactions/transactions-client.tsx" tests/app/transactions-client.test.tsx
git commit -m "feat(transactions): Confirm every group, above the grouped view

- one press for the whole filter; the per-group buttons stay
- dialog states the view's true total and posts the filter, never ids
- hidden when no group on the page has a category"
```

---

# Release

### Task 13: v1.52.0

**Files:**
- Modify: `CHANGELOG.md:22-36` (the Unreleased section), `package.json` (`version`), `tests/ops/docker.test.ts:477-495` and the 21 `toBe('1.51.0')` pins

- [ ] **Step 1: Update the release guard first (it fails until the files match)**

In `tests/ops/docker.test.ts`, replace the `'MUST-7.1: the 1.51.0 release'` test with these two:

```ts
  it('MUST-7.1: the 1.52.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.52.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.52\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.52.0]'));
    expect(changelog.indexOf('## [1.52.0]')).toBeLessThan(changelog.indexOf('## [1.51.0]'));
    const current = changelog.slice(changelog.indexOf('## [1.52.0]'), changelog.indexOf('## [1.51.0]'));
    // The three things this release is, in the words a household will look for.
    expect(current).toMatch(/Last import/);
    expect(current).toMatch(/Confirm every group/);
    expect(current).toMatch(/Settings → Accounts/);
    expect(current).toMatch(/windows-quickstart\.ps1/);
  });

  it('MUST-7.1: the 1.51.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.51\.0\] - 2026-09-20$/m);
    expect(changelog.indexOf('## [1.51.0]')).toBeLessThan(changelog.indexOf('## [1.50.1]'));
    const current = changelog.slice(changelog.indexOf('## [1.51.0]'), changelog.indexOf('## [1.50.1]'));
    expect(current).toMatch(/Before updating/);
    expect(current).toMatch(/balance may move/i);
  });
```

Then replace every remaining `expect(pkg.version).toBe('1.51.0');` in that file with `'1.52.0'` (21 occurrences; a scripted replace is fine).

- [ ] **Step 2: Run the guard to verify it fails**

Run: `npx vitest run tests/ops/docker.test.ts`
Expected: the `1.52.0 release` test and the 21 pins FAIL on `1.51.0`.

- [ ] **Step 3: Write the changelog and bump the version**

In `CHANGELOG.md`, replace the whole Unreleased section (from `## Unreleased` down to, but not including, `## [1.51.0]`) with the following, using today's date in the heading:

```markdown
## Unreleased

## [1.52.0] - YYYY-MM-DD

### Added

- **Each account can say how often it is imported.** Settings → Accounts → Update account gains
  "Expect an import": Household default, Weekly, Every two weeks, Monthly, Yearly, or Never remind
  me. The existing "nothing imported lately" reminder reads each account's own setting and falls
  back to the household number for the rest, so a card imported monthly and a savings account whose
  statement comes once a year stop nagging on the same schedule. Nothing changes until you pick one.
- **Confirm every group.** The grouped-by-category view of Transactions — where the dashboard's
  rule-review card sends you — gains one button above the groups that does what ten "These are all
  correct" presses did: every transaction in the view stays in the category it has and is marked
  set by hand. Anything with no category yet is left for you to pick, and the message says so.
- **A one-line installer for a Windows PC** (`install/windows-quickstart.ps1`). The existing
  Windows script installs from source: it needs the repo and it builds the image. This one needs
  neither — it checks hardware virtualization, installs Docker Desktop with `winget` if it is
  missing, pulls the same prebuilt image the NAS install uses, starts it, adds a Start Menu
  shortcut and opens the browser. A machine with virtualization turned off in its BIOS is told so,
  with the setting named for both Intel and AMD, before anything is downloaded, and a machine
  missing WSL2 is offered the one elevated command that installs it — Docker Desktop answers
  `docker --version` perfectly happily while its engine has nothing to run on, so that case has to
  be named rather than waited out. A compose file the Docker parser cannot read is replaced on the
  next run instead of being kept out of politeness.

### Changed

- **The weekly and monthly summaries open with `Last import <date>.`** A summary fires on a clock
  whether anyone imported or not, so it now says what it is built on. Date only — which accounts are
  behind stays the reminder's job. A member who sees only their own accounts gets their own date.
- The stale-import reminder's subject names the account's own threshold when one account is
  overdue, and says "N accounts are overdue for an import" when several are, since their
  thresholds may now differ. The Settings → Notifications field for it is labelled as the household
  default.
```

(The Windows entry is the existing Unreleased text, moved unchanged. Keep the surrounding `## Unreleased` heading empty above the new section, as the file's own header comment asks.)

In `package.json`, set `"version": "1.52.0"`.

- [ ] **Step 4: Run the guard, then the whole suite**

Run: `npx vitest run tests/ops/docker.test.ts` — expected PASS.
Run: `npx vitest run` — expected all green, save for the known reporter flake (rerun that one file alone if it appears).

- [ ] **Step 5: Build and smoke**

```bash
rm -rf .next && npm run build
npm run smoke
```

Expected: build completes; smoke reports every check passed (two graceful-shutdown checks are skipped on Windows; that is documented in the smoke script's own output).

- [ ] **Step 6: Commit, push, tag**

```bash
git add CHANGELOG.md package.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.52.0

- per-account import cadence on the stale-import reminder
- Last import line on the weekly and monthly summaries
- Confirm every group on the review view
- Windows one-line installer ships"
git push origin main
git tag -a v1.52.0 -m "v1.52.0"
git push origin v1.52.0
gh run list --limit 3
```

Expected: `Release image` for `v1.52.0` shows `in_progress`, then `completed success` (the previous build took about half an hour).
