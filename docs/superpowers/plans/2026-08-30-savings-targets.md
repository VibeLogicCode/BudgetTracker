# Savings targets, the savings line, and a month you can choose — implementation plan (v1.17.0)

> **For agentic workers:** four lanes, disjoint file sets. No Playwright. Vitest + `npx tsc --noEmit`.

**Goal:** a household can set what it means to keep each month, see whether it is on track, and be
told when it lands — plus the two cheap things that make the same screens worth looking at: a
savings line with the target drawn across it, a dashboard you can point at any month, and a cash
runway figure.

**Why:** the app already computes income, spend and net per month (`cashflowTrend`) and a savings
rate (`savingsRate`), and nothing measures either against an intention. Goals cover "save $10,000
for a car by June" with hand-entered contributions; this covers "keep 20% of what we earn, every
month", measured automatically. Different question, no overlap.

**Spec:** this file.

## Global constraints

- No Playwright. Vitest + `npx tsc --noEmit` only.
- Public repo: no owner name, employer, Windows paths, or real statement data in code, comments,
  tests, fixtures or commit messages. Invented sample data only.
- Conventional commits. NO `Co-Authored-By`, no Claude attribution. Never change git identity.
- **`no new Date()` in `src/lib/**`.** Every function here takes `today` or `month`; an
  `at: Date = new Date()` default parameter is the repo's accepted pattern where one is needed.
- Integer cents, ISO dates (`YYYY-MM-DD`), months as `YYYY-MM`. 44px minimum touch targets.
- Never `git stash`, never `git add -A`, never touch `.tmp-data/`, never create a worktree, never
  copy or delete anything under `node_modules`.
- Lanes run NO git commands. The orchestrator stages and commits.

## Rulings

- **T1. "Saved" is `income − spend` for the month, transfers excluded.** That is exactly what
  `cashflowTrend` already returns (`src/lib/reports.ts:40-50` excludes `is_transfer` from every
  series). Do not invent a second definition of saving anywhere in this release.

  **Moving money into a savings account does not increase this figure, and must not.** Income minus
  spending already counts every dollar that was not consumed, including the ones still sitting in
  chequing; a transfer relocates money rather than creating any. If a transfer did raise the
  number, a household could hit any target by shuffling cash between its own accounts.

  Three cases decide whether the figure is right, and they are worth knowing before touching this
  code. On $5,000 of income, $3,500 of spending and $1,000 moved to savings:
  1. Savings account imported, both legs flagged as transfers — net $1,500. Correct.
  2. Savings account imported, NEITHER leg flagged — still $1,500. Uncategorised rows count as
     spend (`reports.ts:151-153`) and `netSpentCents` is a pure sign flip (`money.ts:71-74`), so
     the -1,000 and the +1,000 cancel exactly inside the spend bucket.
  3. Savings account NOT imported and the leg not flagged — net $500, understated by exactly the
     amount that was saved. This is the case that matters: saving more makes the number look worse.

  So the household rule is "import both sides, or flag the transfer", and flagging teaches itself
  (marking one row writes an exact-match transfer rule, `src/lib/categorize/engine.ts`). One more
  trap to guard against in test fixtures: a deposit into savings filed under an INCOME category
  inflates income and overstates the month. A transfer is never income.
- **T1a. The tile discloses the intent number without scoring it.** Beside the saved figure it
  prints how much of the month moved into savings — flagged deposits (positive amounts) landing in
  an account of `type = 'savings'`. Information only: it is never the target, never compared to it,
  and never added to it. When the household has NO savings-type account, the tile says so instead,
  because that is exactly the configuration in which case 3 above bites silently.
- **T2. A target is a percent of income OR a fixed amount of cents.** Percent is the default,
  because income varies and a percent target self-adjusts instead of failing you for a thin month.
  No "whichever is greater" — a rule nobody can restate is a rule nobody can act on.
- **T3. Household scope only.** Income and spend are pooled. There is no per-person savings target
  in this release, and the code must not pretend there might be one next week.
- **T4. One row per month, seeded by copy-forward.** Budgets already work this way and already have
  a "Copy previous month" button; a standing target with per-month overrides would be a second
  mental model for the same decision.
- **T5. A percent target is provisional until the month closes,** because income is still landing.
  Say so in the UI (the tile names the resolved figure and the percent it came from), and make the
  pace evaluator pro-rate rather than compare a part-month against a whole-month target.
- **T6. The target is set on Budgets, not in Settings.** Deciding to keep 20% is a budgeting
  decision and belongs beside the budgets for that month.
- **T7. A dashboard section either follows the chosen month or is visibly "as of today".** Half a
  page silently ignoring a filter is worse than no filter.

## Lane 1 — the library, the schema, the migration (everyone else depends on this)

**Files:** create `drizzle/0015_savings_targets.sql`, `src/lib/savings-target.ts`,
`src/lib/runway.ts`, `tests/lib/savings-target.test.ts`, `tests/lib/runway.test.ts`; modify
`src/db/schema.ts`.

Migration `drizzle/0015_savings_targets.sql` — additive, nothing reshaped:

```sql
CREATE TABLE savings_targets (
  month TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`month` is `YYYY-MM` and is the primary key because of ruling T3/T4: one household, one target per
month. `mode` is `'percent'` or `'amount'`; `value` is a whole percent (1-100) or an amount in
cents, and which one it means is `mode`'s job — do not store both columns.

**Produces** (lanes 2-4 consume these names verbatim):

```ts
// src/lib/savings-target.ts
export type SavingsTargetMode = 'percent' | 'amount';
export interface SavingsTarget { month: string; mode: SavingsTargetMode; value: number }
export interface SavingsProgress {
  month: string;
  target: SavingsTarget | null;
  /** The target resolved to cents for THIS month: percent applied to this month's income, or the
   *  fixed amount. null when no target is set, or when a percent target has no income to apply to. */
  targetCents: number | null;
  incomeCents: number;
  spendCents: number;
  netCents: number;
  /** net over targetCents as a whole percent; null when targetCents is null or not positive. */
  pct: number | null;
  met: boolean;
  /** Ruling T1a, disclosure only: flagged transfer deposits landing in a `savings`-type account
   *  this month. NEVER added to netCents, never compared against targetCents. */
  movedToSavingsCents: number;
  /** True when the household has no account of type 'savings' at all, which is the setup where an
   *  unflagged transfer to an outside bank silently understates the month (ruling T1, case 3). */
  noSavingsAccount: boolean;
}
export function getSavingsTarget(month: string): SavingsTarget | null;
export function saveSavingsTarget(input: SavingsTarget, at?: Date): void; // upsert on month
export function deleteSavingsTarget(month: string): boolean;
export function copySavingsTargetForward(month: string, at?: Date): boolean; // from month-1
export function savingsProgress(month: string, viewer: Viewer): SavingsProgress;
/** Consecutive months ending at `endMonth` whose target was set AND met. Stops at the first miss
 *  or the first month with no target. Bounded by `max` (default 24) so it cannot walk for ever. */
export function savingsStreak(endMonth: string, viewer: Viewer, max?: number): number;

// src/lib/runway.ts
export interface CashRunway {
  liquidCents: number;
  avgMonthlySpendCents: number;
  /** liquid / average spend, one decimal. null when average spend is not positive. */
  months: number | null;
  /** Liquid accounts with no balance on file — the figure is only as good as this is 0. */
  accountsMissing: number;
}
export function cashRunway(opts: { today: string; months?: number }, viewer: Viewer): CashRunway;
```

Notes the implementer needs:
- `savingsProgress` gets its numbers from `cashflowTrend(1, { endMonth: month }, viewer)` — do NOT
  write a second income/spend query (ruling T1). A percent target resolves as
  `round(incomeCents * value / 100)`.
- `met` is `netCents >= targetCents` with `targetCents !== null`. A month with no target is never
  "met" and never "missed" — it simply has no opinion.
- `cashRunway` sums the latest balance of every ACTIVE account whose `type` is `chequing`,
  `savings` or `cash` (`src/db/schema.ts:129` is the enum; `credit` is a liability and `asset` is
  property — neither is money you can spend this month). Use `latestSnapshots(today, viewer)`
  (`src/lib/networth.ts:204`) rather than a new query, and count accounts with no snapshot into
  `accountsMissing`. Average monthly spend is the mean `spendCents` of the trailing `months`
  (default 6) full months from `cashflowTrend`.
- Both modules are server-side; a chart or a tile that needs one of these numbers receives it as a
  prop. Do NOT import either from a `'use client'` component — `tests/ops/client-bundle.test.ts`
  guards this, and `src/lib/savings-rate.ts`'s docblock explains why the split exists.

Write the failing tests first. Cover: percent and amount targets resolve correctly; a percent
target with zero income gives `targetCents: null` and never divides by zero; upsert replaces rather
than duplicating a month; copy-forward returns false when the previous month has none; the streak
stops at a miss, stops at a monthless gap, and honours `max`; runway excludes credit and asset
accounts and reports `accountsMissing`; runway with no spend history returns `months: null`.

Run `npx vitest run tests/lib/savings-target.test.ts tests/lib/runway.test.ts tests/ops` and
`npx tsc --noEmit`.

## Lane 2 — the three alerts

**Files:** modify `src/lib/notify/events.ts`, `src/lib/notify/render.ts`,
`src/lib/notify/evaluate/index.ts`; create `src/lib/notify/evaluate/savings.ts`; tests
`tests/lib/notify/savings-events.test.ts` plus whichever existing notify test asserts the registry
shape (find it; it will fail on a new event until updated).

`src/lib/notify/events.ts` documents the extension point at its head: append a registry entry, add
a `renderEvent()` case, add an evaluator call. **An `id` is permanent once shipped** — pick
carefully and do not rename.

Three events:

| id | label | trigger | default | fires when |
|---|---|---|---|---|
| `savings_target_met` | You hit this month's savings target | `tick` | on | net for the month first reaches `targetCents` |
| `savings_target_pace` | On pace to miss the savings target | `daily_slot` | on | pro-rated pace says the month will land short |
| `savings_month_closed` | Last month's savings, against target | `daily_slot` | on | the day after a month ends, once |

- **Pace pro-rates** (ruling T5): compare net so far against `targetCents * dayOfMonth / daysInMonth`,
  and — like the existing budget pace evaluator — do not fire before day 7 of the month, because a
  three-day sample says nothing. Read `src/lib/notify/evaluate/pace.ts` and follow its shape and
  its constants discipline rather than inventing new magic numbers inline; put any new constant
  beside the existing ones in `src/lib/predict/constants.ts`.
- **Month closed** carries the streak from `savingsStreak` — "third month running" is the sentence
  that changes behaviour, and a single month on its own is noise.
- Dedup keys are per event per month, in the scheme `events.ts` already uses. `savings_target_met`
  must fire ONCE per month, not on every 5-minute tick after the target is crossed.
- A month with no target set fires nothing at all. Never nag a household about a target it never
  agreed to.
- Audience `all`, both channels, exactly like every other event — no new channel in this release.

Run `npx vitest run tests/lib/notify tests/ops` and `npx tsc --noEmit`.

## Lane 3 — Budgets control, dashboard month filter, dashboard tiles

**Files:** modify `src/app/(app)/budgets/budgets-client.tsx`, the budgets `page.tsx` and its
actions file, `src/app/(app)/dashboard/page.tsx`; create `src/components/ui/MonthNav.tsx`; tests
`tests/app/budgets-client.test.tsx`, `tests/app/budgets-page.test.tsx`,
`tests/app/budgets-actions.test.ts`, `tests/app/dashboard.test.tsx`.

1. **Ruling T6 — the target control on Budgets.** At the top of the month, beside the existing
   month navigation: the mode (percent / amount), the value, and what it resolves to for this month
   ("20% of income so far — $1,240"). Auto-save, no Save button (v1.11.0 ruling R1 and
   `tests/ops/row-controls.test.ts` — a per-row form holding one control is the idiom that was
   removed). The existing **Copy previous month** button also copies the savings target forward,
   through `copySavingsTargetForward`; say so in that button's surrounding copy.
2. **`MonthNav`, a shared component.** Budgets currently navigates with bare prev/next links
   (`budgets-client.tsx:408-421`), and the dashboard has nothing. Extract one component: prev /
   current / next plus an `<input type="month">` for jumping to any month or year, emitting
   `?month=YYYY-MM`. Use it on BOTH pages so the two stop differing.
3. **Ruling T7 — the dashboard follows a month.** `dashboard/page.tsx:56` hard-codes
   `currentMonth()`; parse `?month=` instead, defaulting to the current month, and validate it
   (a malformed month falls back to the current one, never throws). Every function the page already
   calls takes a month or a range — `budgetProgress`, `cashflowTrend({endMonth})`, `topMerchants`,
   `safeToSpend` — so this is plumbing, not new maths.
   - **Follows the month:** budgets, the Spent / Money in / Net tiles, top merchants, the new
     savings tile.
   - **Does not follow it, and must say so:** the 12-month cashflow chart, net worth, upcoming
     bills (30 days), goals, loans, who owes us, expiring soon, needs a look. When the chosen month
     is not the current one, the page shows a "Viewing <Month YYYY>" bar and each of these carries
     an "as of today" note.
   - **Safe to spend is hidden entirely** for a past month: "how much can we still spend" has no
     meaning for a month that has ended.
4. **Two new tiles**, beside the existing ones: **Saved this month** — `$X of $Y target`, the
   percent, and a bar (from `savingsProgress`); and **Cash runway** — `4.2 months covered`, with
   the `accountsMissing` caveat shown when it is not zero (from `cashRunway`). Both take their
   numbers as props from the server component; do not import the libs into a client component.
   Per ruling T1a the savings tile carries a sub-line reading `· $1,000 of it moved to savings`
   from `movedToSavingsCents` — worded so it plainly reads as part of the saved figure rather than
   an addition to it — and when `noSavingsAccount` is true it instead says that no savings account
   is set up, and that money moved to a bank the app does not know about counts as spending unless
   the transaction is marked a transfer.

Run `npx vitest run tests/app/budgets-client.test.tsx tests/app/budgets-page.test.tsx tests/app/budgets-actions.test.ts tests/app/dashboard.test.tsx tests/ops` and `npx tsc --noEmit`.

## Lane 4 — the savings line and the target across it

**Files:** create `src/components/charts/SavingsChart.tsx`; modify
`src/app/(app)/reports/reports-client.tsx`, `src/app/(app)/reports/page.tsx`; tests
`tests/app/reports-client.test.tsx`, `tests/app/reports.test.tsx`.

The Reports "Cash flow and savings rate" card already draws `CashflowChart` (Income and Spend bars,
`src/components/charts/CashflowChart.tsx`) with a one-line text summary under it. The net is text
only, so the shape of your saving over time is invisible.

1. **`SavingsChart`** — recharts `ComposedChart` over the same `MonthTrendRow[]` the card already
   has: the existing Income/Spend bars, a **Net line** on top, and a **cumulative saved area**
   (a running sum of `netCents` across the range) on a second axis. Match the existing charts'
   conventions exactly — read all four in `src/components/charts/` first; they share tooltip
   formatting, colour tokens (`--positive-solid`, `--negative-solid`) and an empty state.
2. **The target line.** `reports/page.tsx` fetches the target for each month in the range and passes
   `targetCents` per point; the chart draws it as a dashed reference line per month. Months with no
   target simply have no segment — do not draw zero, which reads as "your target was nothing".
3. Keep the existing summary sentence, and add the count: "target met in 4 of 6 months".
4. Do not touch `CashflowChart.tsx` — the dashboard still uses it, and Lane 3 is in that file.

Run `npx vitest run tests/app/reports-client.test.tsx tests/app/reports.test.tsx tests/ops` and
`npx tsc --noEmit`.

## Release (after all four lanes)

`package.json` → `1.17.0`; `tests/ops/docker.test.ts` gains a 1.17.0 block and renames the 1.16.0
one; `CHANGELOG.md` gains `## [1.17.0]` **stating that this release HAS a migration (0015) and that
it is additive** — a reader deciding whether to back up first is the audience for that line;
`docs/PENDING-FIXES.md` records anything deferred. Then the full `npx vitest run`,
`npx tsc --noEmit`, tag `v1.17.0`, image.
