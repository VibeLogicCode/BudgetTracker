# A page for recurring charges, a summary on Insights, and expected charges in Coming up — Implementation Plan (v1.55.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Recurring charges card on Insights becomes a three-line summary that links to a new full page, `/insights/recurring`, listing every merchant on a rhythm (Known, Looks and Forming, no cap) with its monthly equivalent, next expected date, a **Late** tag for a Known merchant that stopped charging, and the price-rise tag; the Transactions row menu toggles the mark; the bulk bar skips transfers; and the Dashboard's Coming up card lists marked merchants' next charges as **Expected** rows that never enter a total.

**Architecture:** Still no migration and nothing stored but the household's marks. The read model `recurringCharges` (src/lib/recurring.ts) gains a third tier (`forming`, now listed), four row fields (`nextExpected`, `late`, `monthlyCents`, `priceRise`), keeps Known rows that go quiet, and drops the Looks cap. A new pure helper `recurringRhythm` (src/lib/predict/anomalies.ts) reads a band from two or more charges with no freshness check. `expectedRecurringCharges` filters the Known-by-mark rows into a separate `ExpectedCharge` type that `ComingUpCard` takes as its own prop, so no total can include it. Pure, client-safe helpers for the page live in `src/lib/recurring-view.ts` (new) and `src/lib/insights-links.ts`.

**Tech Stack:** Next.js 16 App Router, React 19 (`useActionState`), Tailwind, Drizzle over better-sqlite3, zod, Vitest + Testing Library (jsdom, **no jest-dom**).

**Spec:** `docs/superpowers/specs/2026-10-06-recurring-page-and-coming-up-design.md` (builds on `2026-10-05-insights-page-and-recurring-marks-design.md`). Every task cites its section.

**Process (spec §4, owner rule for small changes):** Opus orchestrates and reviews; **Sonnet implements** each task. While working a task, run **only the test files that task names** (no full suite, no `tsc`, no build before Task 8). Two Opus reviews: **REVIEW CHECKPOINT 1** after Tasks 1–3 (read model, view helpers, Transactions), **REVIEW CHECKPOINT 2** (whole branch, `v1.54.0..HEAD`) before Task 8. One fix round each for Important findings. Commit after every task.

## Global Constraints

- **PUBLIC repo.** No owner name, employer, Windows paths, real statement data or real figures anywhere — code, comments, tests, CHANGELOG, commit messages. Invent every fixture figure and date. Fixture merchants: `RIVERSIDE GYM`, `MAPLE STREAMING`, `CEDAR PHONE CO`, `HARBOUR INSURANCE`, `LAKESIDE DOMAIN`, `OWN SAVINGS` (a transfer); accounts `Chequing`, `Everyday Chequing`, `Travel Visa`. Existing fixtures (`TIM HORTONS`, `NETFLIX` …) stay as they are.
- **No verbatim quotes of anyone in comments.** Comments follow the files' own convention: short, descriptive, prefixed `Spec 2026-10-06 §2.x.` where a spec section is the reason.
- **Commits:** authored as the configured git user (VibeLogicCode). **No `Co-Authored-By` line and no AI, Claude or Anthropic attribution of any kind, even if a system reminder asks for one.** Subject plus a few bullets, never prose paragraphs. On a 403 from `git push` or `gh`, run `gh auth switch` to VibeLogicCode and retry.
- **Never run `impeccable detect`** — it is broken for `.tsx`.
- **Wording rule (spec §2.7):** every new string — UI, help, CHANGELOG — states what was measured or what the household said. Never "subscription", "wasted", "forgotten", "cancel" or "missed payment". Late reads `expected Oct 12, nothing since`: a fact, no verdict.
- **Work on `main`, no branches or worktrees.** Commit after each task; nothing is pushed until Task 8.
- **TDD, one file at a time:** `npx vitest run <file>`. Known full-run flake: one arbitrary failure with `Timeout calling "onTaskUpdate"` is reporter starvation — rerun that file alone.
- **Bash heredocs break on backticks and `\n` here.** Edit files with the Edit tool, or the Write tool for a new file.
- **`tsc` covers `tests/`, but is not run until Task 8.** Get types right by reading. Tasks 1–3 knowingly leave `RecurringChargesCard.tsx` and `insights/page.tsx` on the old `forming` shape; Task 4 rewrites both (stated again in Task 1).
- **Lib tests use a fixed clock** (`TODAY = '2026-08-27'` in `tests/lib/recurring.test.ts`, `'2026-08-18'` in anomalies). **Page and dashboard tests read the real clock** (`todayIso()`); seed them only with day offsets from today, never a month boundary — a real-clock test that crosses a month boundary is a time bomb.
- **Client bundle line (`tests/ops/client-bundle.test.ts`):** a `'use client'` file, and every module it value-imports, may import `@/lib/recurring` **as `import type` only** (it reaches `@/db/client`). Pure helpers a client file needs go in `src/lib/recurring-view.ts`, `src/lib/insights-links.ts` or `src/lib/dates.ts`. A server file may value-import only PascalCase components from a `'use client'` module.
- **predict tree (`tests/ops/predict-invariants.test.ts`):** no `@/db` import, no `new Date`, no `Math.round` under `src/lib/predict/` — divide with `divRound` from `src/lib/predict/stats.ts`.
- **No migration, no new server action.** `setRecurringMarkAction` and `bulkRecurringMarkAction` keep their origin-check-first order.
- **Guards that scan new files, and what they want:** `th-scope` (`scope="col"` on every `<th>`), `title-only-info` (no `title` on `<td>`/`<th>`), `table-layout` (every `<td>` in a file with a `responsive` TableWrap carries `data-label` — the new table is **not** responsive, the phone gets a list), `button-vocabulary` (`buttonClass`, never `className="btn …"`), `transactions-href` (build `/transactions?` links with `transactionsHref` only), `type-scale` (no arbitrary `text-[…]`), `row-controls` (no form under `src/app` with one `<select>` + submit — the filters live in `src/components/insights/`), `reduced-motion` (no new `animate-pulse`/`animate-spin`; `/insights/recurring` inherits `insights/loading.tsx`), `loading-boundaries` (the new page never calls `notFound()`), `onboarding-coverage` (no new NAV entry, every `<EmptyState` has `action=` or a 30+ char `noAction=`), `visibility-invariants` (a new viewer-taking reader joins `REQUIRE_VIEWER` and the floor rises).

## Review Focus

Inputs the spec implies that are most likely to bite a household; each names the test that pins it.

1. **A card was replaced and a marked merchant never billed the new one.** Its charges stop; it must stay listed (never drop off), read **Late** with `expected <date>, nothing since`, and appear when the old card is chosen under Account with Show = Late. Task 1 (`'keeps a marked merchant listed, with its rhythm, long after its charges stop'`) and Task 5 (`'Show Late on the replaced card lists the marked merchant that went quiet'`).
2. **An expected charge leaking into money that is already budgeted.** The Coming up header total, the footer's "falls before" figure and `safeToSpend.billsDueCents` must not move when a marked merchant's expected row is shown. Task 6 (`'keeps expected charges out of the header total'`, and the dashboard test `'lists a marked merchant’s next charge, tagged Expected, and keeps it out of every total'`).
3. **A hand-edited or stale query string** (`?show=everything&sort=drop&account=abc&person=x`, or a v1.54.0 bookmark `/insights?account=3`) must render the defaults or redirect, never throw. Task 2 (`'reads a malformed or repeated value as the default'`), Task 4 (`'sends a v1.54.0 /insights?account= link to the full page'`) and Task 5 (`'reads a malformed query as the defaults'`).
4. **A self-scoped member on `/insights/recurring`** must see only their own charges whatever `?person=` says, and an `?account=` they cannot see reads as All accounts. Task 5 (`'a self viewer sees only their own charges, whatever ?person= says'`, `'ignores an account the viewer cannot see'`).
5. **A marked merchant with one charge, or irregular gaps** — no cadence — must render `Marked`, an em dash for typical and monthly, no next expected, be counted in N but not in the monthly figure, and never become an Expected row. Task 1 (`'lists a merchant the household marked under Known, after a single charge'`), Task 2 (`'counts every Known merchant but prices only the ones with a rhythm'`), Task 1 expected charges (`'leaves out Looks and Forming merchants, and a marked merchant with no rhythm'`) and Task 5 (`'says Marked and an em dash for a merchant marked after one charge'`).

## Decisions this plan makes where the code and the spec meet

1. **Expected rows are a separate prop of a separate type, not a branch of `UpcomingBill`.** `ComingUpCard` gains `expected?: ExpectedCharge[]`; `ExpectedCharge` (src/lib/recurring.ts) carries `typicalCents` and has **no `amountCents`**, and its producer `expectedRecurringCharges` is called only by the Dashboard. The header total still sums `bills` alone (computed before the two kinds are merged for display), and `safeToSpend` still reads only `upcomingBills`. A union inside `UpcomingBill` was rejected: `safeToSpend`'s `sumCents(upcomingBills(...).map(b => b.amountCents))` and the card's `reduce` would each have to remember to filter it out. Pinned by a card test and a dashboard test (Review Focus 2).
2. **`RECURRING_LATE_GRACE_DAYS = 7` lives in `src/lib/predict/constants.ts`**, directly after `RECURRING_STALE_GRACE_DAYS`, and is pinned in `tests/lib/predict/constants.test.ts` like every threshold there.
3. **A cadence is read from two charges for Known and Forming rows.** Spec §2.1 names "one charge, or irregular gaps" as the cases with no cadence, so a marked merchant with two charges a month apart now reads Monthly, gets a monthly figure and a next expected date. This changes v1.54.0's test `'gives a marked merchant with two charges the median of both'` (cadence `null` → `'monthly'`). Looks still needs `recurringVerdict` (three charges, every gap in band, fresh). The new pure `recurringRhythm` is the one reading of "these charges sit in a band" and `recurringVerdict` and `formingRhythm` are refactored to call it (their existing tests pin the refactor).
4. **Known never drops off, within the window.** A marked merchant was already kept whatever its dates. A tracked merchant was Known only while `recurringVerdict` held (fresh); now it stays Known while its charges still show a rhythm read **without** the freshness check (`recurringRhythm`, at least `RECURRING_MIN_CHARGES` charges) and a record covers it. An uncovered rhythm that stops still drops (Looks keeps its stale rule). "Never" is bounded by the read model's one window, `RECURRING_LOOKBACK_DAYS` (1200 days): a merchant with no charge in it has no row. A tracked merchant with an off-band gap is not Known, as v1.54.0 decision 5 ruled.
5. **Next expected is `addDaysIso(lastDate, medianGapDays)`** — the spec's "last charge + median gap", in days, not a calendar-month step. Late is `daysBetweenIso(nextExpected, today) > RECURRING_LATE_GRACE_DAYS`, Known rows only. A past next expected inside the grace is not late; the Coming up row reads `nothing since` without the Late styling.
6. **Forming rows are listed** (tier `'forming'`) and count toward the Account options (owner ruling 1: options are the accounts on listed rows). A Forming merchant a record covers stays Forming with `tracked` set (Track is not offered); Known-by-tracking still needs a three-charge rhythm.
7. **No cap anywhere.** `RECURRING_MAX_ROWS` is deleted; the summary card lists no rows and the page lists all.
8. **Price went up = `creepVerdict` over the merchant's charges inside `CREEP_BASELINE_DAYS`** — the same verdict and the same 365-day window Needs a look reads. The tag shows whether or not that Needs a look row was dismissed: the tag is a measured fact on the row, a dismissal is about the card's attention.
9. **Coming up's expected rows follow the card's scope**, the viewer (`ownerScope`), exactly as `upcomingBills` does — the person pill narrows neither (the Dashboard help already says bills do not follow the pill). Source: Known `knownBy === 'mark'` **and** `tracked === null` (a marked merchant that is also tracked already has its item's rows). Lookahead `nextExpected <= today + 30` in the lib; the `COMING_UP_OVERDUE_DAYS` bound is applied in the card, the same place it is applied to bills. The row title links to the merchant's transactions (`transactionsHref`), and the row names the account its newest charge landed on.
10. **`/insights/recurring` search params:** `person` and `account` (digits, else ignored), `show` ∈ `all | known | looks | forming | late` (default `all`), `sort` ∈ `monthly | next | last | merchant` (default `monthly`). Anything else reads as the default; default values are not written into links. The account is still validated by the read model (an account no listed row names reads as All accounts). A v1.54.0 bookmark `/insights?account=N` (that release promised a sendable filtered list) redirects to `/insights/recurring?account=N`.
11. **Mobile layout:** the Transactions arrangement — a `<ul className="sm:hidden">` of `ListRow`s and a `hidden sm:block` table, both rendered (jsdom shows both; tests scope with `data-recurring-cards` / `data-recurring-table`). `ListRow` gains an optional `detail` line that wraps instead of truncating, for the late sentence and the tags. Row actions are one component in both layouts: a single button when there is one action, a `RowMenu` kebab for two or more (ruling R2's rule).
12. **Bulk skip:** `merchantsOfTransactions` skips transfer rows for both callers (the row menu already hides marks on a transfer, and the Insights page posts a charge). A selection with no merchant left gets `'There is no merchant on these rows to mark. Transfer rows are skipped.'`
13. **The /insights summary counts every account** — the Account filter moved to the page. Tiers at zero still show 0. The ` · about $X a month` clause is left out when no Known merchant has a cadence, rather than printing "about $0.00". The late count links to `?show=late&sort=next`.
14. **Dates on the page** use a new `dayLabel(iso, today)` in `src/lib/dates.ts` — `Oct 12`, or `Nov 3, 2025` outside today's year — a lookup table like `monthLabel`, no `Date`.
15. **Mark actions refresh the new places marks show:** both actions add `revalidatePath('/insights/recurring')` and `revalidatePath('/dashboard')`.

---

## File map

| Area | Files |
|---|---|
| Rhythm and threshold | `src/lib/predict/anomalies.ts`, `src/lib/predict/constants.ts` |
| Read model | `src/lib/recurring.ts` |
| Pure view helpers | `src/lib/recurring-view.ts` (new), `src/lib/insights-links.ts`, `src/lib/dates.ts` |
| Transactions | `src/lib/transactions.ts`, `src/app/(app)/transactions/actions.ts`, `transactions-client.tsx` |
| Summary card and /insights | `src/components/insights/RecurringChargesCard.tsx`, `src/app/(app)/insights/page.tsx`, `insights-client.tsx` |
| Full page | `src/app/(app)/insights/recurring/page.tsx` (new), `src/components/insights/RecurringTable.tsx` (new), `RecurringFilters.tsx` (new), `RecurringRowActions.tsx` (new), `src/components/ui/ListRow.tsx`, `scripts/smoke-routes.mjs` |
| Coming up | `src/components/ComingUpCard.tsx`, `src/app/(app)/dashboard/page.tsx` |
| Help, release | `src/app/(app)/help/content.tsx`, `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json` |
| Guards touched | `tests/ops/visibility-invariants.test.ts`, `tests/ops/docker.test.ts` |

---

### Task 1: The read model — rhythm, next expected, late, monthly equivalent, Forming rows, price rise, and Coming up's expected charges (spec §2.1, §2.2, §2.3, §2.4, §2.6)

**Files:**
- Modify: `src/lib/predict/constants.ts` (after `RECURRING_STALE_GRACE_DAYS`, line 83)
- Modify: `src/lib/predict/anomalies.ts` (`recurringVerdict` :195-246, `formingRhythm` :253-265; new `recurringRhythm` after `chargesAsOf` :156-160)
- Modify: `src/lib/recurring.ts` (imports :1-12, `RECURRING_MAX_ROWS` :49-54, types :74-112, `recurringCharges` :281-379; new `ExpectedCharge` + `expectedRecurringCharges` after it)
- Modify: `tests/ops/visibility-invariants.test.ts` (`REQUIRE_VIEWER` :84-85, floor :264-267)
- Test: `tests/lib/predict/constants.test.ts`, `tests/lib/predict/anomalies.test.ts`, `tests/lib/recurring.test.ts`, `tests/ops/visibility-invariants.test.ts`

**Interfaces:**
- Produces (`src/lib/predict/constants.ts`): `RECURRING_LATE_GRACE_DAYS = 7`.
- Produces (`src/lib/predict/anomalies.ts`, pure): `interface RecurringRhythm { cadence: RecurringCadence; medianGapDays: number }`; `recurringRhythm(input: { charges: SpendRow[]; today: string }): RecurringRhythm | null`.
- Produces (`src/lib/recurring.ts`, server-only): `type RecurringTier = 'known' | 'looks' | 'forming'`; `interface RecurringPriceRise { fromCents: number; toCents: number }`; `RecurringChargeRow` gains `nextExpected: string | null`, `late: boolean`, `monthlyCents: number | null`, `priceRise: RecurringPriceRise | null`; `RecurringCharges.forming` becomes `RecurringChargeRow[]`; `RECURRING_MAX_ROWS` is removed; `interface ExpectedCharge { merchant: string; expectedDate: string; typicalCents: number; late: boolean; accountName: string }`; `expectedRecurringCharges(input: { today: string; days: number; viewer: Viewer }): ExpectedCharge[]`.

**Known transient break, do not fix here:** `src/components/insights/RecurringChargesCard.tsx` (`formingSentence(result.forming)`) and `src/app/(app)/insights/page.tsx` still assume the old `forming` record; Task 4 rewrites both. Do not run their tests in this task.

- [ ] **Step 1: Pin the new threshold (failing)**

In `tests/lib/predict/constants.test.ts`, after line 40 `RECURRING_STALE_GRACE_DAYS: C.RECURRING_STALE_GRACE_DAYS,` add:

```ts
      RECURRING_LATE_GRACE_DAYS: C.RECURRING_LATE_GRACE_DAYS,
```

and after line 82 `RECURRING_STALE_GRACE_DAYS: 10,` add:

```ts
      RECURRING_LATE_GRACE_DAYS: 7,
```

Fails before / passes after: `C.RECURRING_LATE_GRACE_DAYS` is `undefined` until Step 5.

- [ ] **Step 2: Write the failing rhythm tests**

In `tests/lib/predict/anomalies.test.ts`, add `recurringRhythm,` to the `@/lib/predict/anomalies` import (between `hasEnoughHouseholdHistory,` and `recurringVerdict,`), then append at the end of the file:

```ts
/** Spec 2026-10-06 §2.3. The band, read with no freshness check: what next expected is measured from. */
describe('recurringRhythm: the band of two charges or more', () => {
  /** Charges `gaps` apart, oldest gap first, the newest `endsDaysAgo` before TODAY. */
  const charges = (gaps: number[], endsDaysAgo = 3): SpendRow[] => {
    const dates = [addDaysIso(TODAY, -endsDaysAgo)];
    for (const gap of [...gaps].reverse()) dates.unshift(addDaysIso(dates[0], -gap));
    return dates.map((date, index) => row({ id: index + 1, date, amountCents: -1649 }));
  };

  it('reads the band and the median gap from two charges or more', () => {
    expect(recurringRhythm({ charges: charges([30]), today: TODAY })).toEqual({ cadence: 'monthly', medianGapDays: 30 });
    expect(recurringRhythm({ charges: charges([29, 31, 30]), today: TODAY })).toEqual({ cadence: 'monthly', medianGapDays: 30 });
    expect(recurringRhythm({ charges: charges([365, 365], 6), today: TODAY })).toEqual({ cadence: 'yearly', medianGapDays: 365 });
  });

  it('keeps the rhythm of charges that stopped long ago: freshness is the caller’s question', () => {
    expect(recurringRhythm({ charges: charges([30, 30, 30], 400), today: TODAY })).toEqual({ cadence: 'monthly', medianGapDays: 30 });
    expect(recurringVerdict({ charges: charges([30, 30, 30], 400), today: TODAY })).toBeNull();
  });

  it('is null for one charge, and when any gap leaves the band', () => {
    expect(recurringRhythm({ charges: charges([]), today: TODAY })).toBeNull();
    expect(recurringRhythm({ charges: charges([30, 60, 30]), today: TODAY })).toBeNull();
    expect(recurringRhythm({ charges: charges([7, 7, 7]), today: TODAY })).toBeNull();
  });

  it('counts charges only: a refund and a future-dated row are neither', () => {
    const withNoise = [
      ...charges([30]),
      row({ id: 9, date: addDaysIso(TODAY, -1), amountCents: 1649 }),
      row({ id: 8, date: addDaysIso(TODAY, 20), amountCents: -1649 }),
    ];
    expect(recurringRhythm({ charges: withNoise, today: TODAY })).toEqual({ cadence: 'monthly', medianGapDays: 30 });
  });
});
```

Fails before / passes after: `recurringRhythm` does not exist until Step 6. The existing `recurringVerdict` and `formingRhythm` describes are **pins** for the Step 6 refactor (they pass before and after).

- [ ] **Step 3: Update and add the read-model tests (failing)**

In `tests/lib/recurring.test.ts`:

(a) Replace line 10

```ts
import { RECURRING_MAX_ROWS, recurringCharges, recurringLoad, type RecurringCharges } from '@/lib/recurring';
```

with

```ts
import { RECURRING_LATE_GRACE_DAYS } from '@/lib/predict/constants';
import { expectedRecurringCharges, recurringCharges, recurringLoad, type RecurringCharges } from '@/lib/recurring';
```

(b) In `'names the merchant, the cadence, the last charge and how many charges it read'`, add four fields after `accounts: [{ id: ctx.accountId, name: 'Chequing' }],`:

```ts
        // Spec 2026-10-06 §2.3: the last charge plus the median gap.
        nextExpected: addDaysIso(TODAY, 27),
        late: false,
        monthlyCents: 1649,
        priceRise: null,
```

(c) Replace the whole `it('caps the list, because the card is an audit list and not a second ledger', …)` with:

```ts
  /** Spec 2026-10-06 §2.2: the full page lists every row; the Insights card only counts. */
  it('lists every Looks row: there is no cap', async () => {
    const ctx = await setup();
    for (let n = 0; n < 16; n += 1) {
      ctx.cadence({ merchant: `MERCHANT ${String(n).padStart(2, '0')}`, count: 4, cents: 1000 + n });
    }
    expect(read(ctx).looks).toHaveLength(16);
    expect(read(ctx).known).toEqual([]);
  });
```

(d) In `'lists a merchant the household marked under Known, after a single charge'`, add after `accounts: [{ id: ctx.accountId, name: 'Chequing' }],`:

```ts
        // No cadence from one charge: no next expected, never late, no monthly figure.
        nextExpected: null,
        late: false,
        monthlyCents: null,
        priceRise: null,
```

(e) Replace `'gives a marked merchant with two charges the median of both'` with (decision 3):

```ts
  /** Spec 2026-10-06 §2.1: two charges a month apart are a cadence for a merchant the household marked. */
  it('reads a monthly rhythm from a marked merchant’s two charges, with the median of both', async () => {
    const ctx = await setup();
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -34), cents: -4000 });
    ctx.spend({ merchant: 'RIVERSIDE GYM', date: addDaysIso(TODAY, -4), cents: -5000 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known[0]).toMatchObject({
      chargeCount: 2,
      typicalCents: 4500,
      cadence: 'monthly',
      monthlyCents: 4500,
      nextExpected: addDaysIso(TODAY, 26),
      late: false,
    });
  });
```

(f) In `'drops a not_recurring merchant from both tiers and from the forming count'`, rename it `'drops a not_recurring merchant from every tier'` and change its first expectation to:

```ts
    expect(read(ctx)).toEqual({ known: [], looks: [], forming: [], accounts: [], accountId: null });
```

(g) Delete `it('applies the Looks cap after the filter, so other accounts never crowd a filtered list out', …)` entirely, and replace `it('offers an account whose only rows the Looks cap cut', …)` with:

```ts
  it('offers an account named only on a Forming row, and filters Forming by it', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200, accountId: ctx.visaId });
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349 });
    expect(read(ctx).accounts.map((account) => account.name)).toEqual(['Chequing', 'Travel Visa']);
    const visa = read(ctx, { accountId: ctx.visaId });
    expect(visa.accountId).toBe(ctx.visaId);
    expect(visa.forming.map((row) => row.merchant)).toEqual(['CEDAR PHONE CO']);
    expect(visa.looks).toEqual([]);
  });
```

(h) Replace the whole `describe('recurringCharges: rhythms one charge short', …)` block with:

```ts
/** Spec 2026-10-06 §2.2: the merchants v1.54.0 only counted are listed as Forming rows. */
describe('recurringCharges: Forming, one charge short of a rhythm', () => {
  it('lists merchants with two charges a band apart, the newest recent, by merchant', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, cents: 6200 });
    ctx.cadence({ merchant: 'LAKESIDE DOMAIN', count: 2, gapDays: 365, endsDaysAgo: 6, cents: 2400 });
    const result = read(ctx);
    expect(result.known).toEqual([]);
    expect(result.looks).toEqual([]);
    expect(result.forming.map((row) => [row.merchant, row.tier, row.cadence, row.nextExpected, row.monthlyCents, row.late])).toEqual([
      ['CEDAR PHONE CO', 'forming', 'monthly', addDaysIso(TODAY, 27), 6200, false],
      ['HARBOUR INSURANCE', 'forming', 'monthly', addDaysIso(TODAY, 27), 13400, false],
      ['LAKESIDE DOMAIN', 'forming', 'yearly', addDaysIso(TODAY, 359), 200, false],
    ]);
  });

  it('does not list a merchant whose second charge is stale or off-band', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, endsDaysAgo: 200, cents: 13400 });
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 2, gapDays: 60, cents: 6200 });
    expect(read(ctx).forming).toEqual([]);
  });

  it('lists a marked merchant under Known, not Forming, with the band its two charges show', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, cents: 13400 });
    ctx.mark('HARBOUR INSURANCE', 'recurring');
    const result = read(ctx);
    expect(result.forming).toEqual([]);
    expect(result.known.map((row) => [row.merchant, row.cadence])).toEqual([['HARBOUR INSURANCE', 'monthly']]);
  });
});

/** Spec 2026-10-06 §2.3. */
describe('recurringCharges: next expected and late', () => {
  it('turns a marked merchant late once today is more than RECURRING_LATE_GRACE_DAYS past next expected', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 4, endsDaysAgo: 30 + RECURRING_LATE_GRACE_DAYS, cents: 6200 });
    ctx.cadence({ merchant: 'RIVERSIDE GYM', count: 4, endsDaysAgo: 31 + RECURRING_LATE_GRACE_DAYS, cents: 4500 });
    ctx.mark('CEDAR PHONE CO', 'recurring');
    ctx.mark('RIVERSIDE GYM', 'recurring');
    expect(read(ctx).known.map((row) => [row.merchant, row.nextExpected, row.late])).toEqual([
      ['CEDAR PHONE CO', addDaysIso(TODAY, -RECURRING_LATE_GRACE_DAYS), false],
      ['RIVERSIDE GYM', addDaysIso(TODAY, -RECURRING_LATE_GRACE_DAYS - 1), true],
    ]);
  });

  /** Review Focus 1: the merchant that never billed the new card. */
  it('keeps a marked merchant listed, with its rhythm, long after its charges stop', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 4, endsDaysAgo: 200, cents: 6200, accountId: ctx.visaId });
    ctx.mark('CEDAR PHONE CO', 'recurring');
    expect(read(ctx, { accountId: ctx.visaId }).known).toMatchObject([
      { merchant: 'CEDAR PHONE CO', cadence: 'monthly', nextExpected: addDaysIso(TODAY, -170), late: true },
    ]);
  });

  it('keeps a tracked merchant Known, and late, after its rhythm goes quiet', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 6, endsDaysAgo: 100, cents: 13400 });
    ctx.item({ name: 'Harbour Insurance', typeId: ctx.itemType('Subscription', 'subscription') });
    const result = read(ctx);
    expect(result.known).toMatchObject([
      { merchant: 'HARBOUR INSURANCE', knownBy: 'tracked', cadence: 'monthly', nextExpected: addDaysIso(TODAY, -70), late: true },
    ]);
    expect(result.looks).toEqual([]);
  });

  it('never calls a Looks or Forming row late', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', endsDaysAgo: 40, cents: 1349 });
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, endsDaysAgo: 40, cents: 13400 });
    const result = read(ctx);
    expect(result.looks.map((row) => [row.merchant, row.nextExpected, row.late])).toEqual([['MAPLE STREAMING', addDaysIso(TODAY, -10), false]]);
    expect(result.forming.map((row) => [row.merchant, row.nextExpected, row.late])).toEqual([['HARBOUR INSURANCE', addDaysIso(TODAY, -10), false]]);
  });
});

/** Spec 2026-10-06 §2.1 and §2.4. */
describe('recurringCharges: the monthly figure and the price rise', () => {
  it('states a monthly equivalent: the typical charge, or a twelfth of a yearly one', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', cents: 1349 });
    ctx.cadence({ merchant: 'LAKESIDE DOMAIN', count: 3, gapDays: 365, endsDaysAgo: 6, cents: 2500 });
    expect(read(ctx).looks.map((row) => [row.merchant, row.monthlyCents])).toEqual([
      ['LAKESIDE DOMAIN', 208],
      ['MAPLE STREAMING', 1349],
    ]);
  });

  it('carries the price rise Needs a look finds, as from and to', async () => {
    const ctx = await setup();
    for (const [daysAgo, cents] of [[93, 1349], [63, 1349], [33, 1349], [3, 1599]] as const) {
      ctx.spend({ merchant: 'MAPLE STREAMING', date: addDaysIso(TODAY, -daysAgo), cents: -cents });
    }
    ctx.cadence({ merchant: 'CEDAR PHONE CO', cents: 6200 });
    const result = read(ctx);
    expect(result.looks.find((row) => row.merchant === 'MAPLE STREAMING')?.priceRise).toEqual({ fromCents: 1349, toCents: 1599 });
    expect(result.looks.find((row) => row.merchant === 'CEDAR PHONE CO')?.priceRise).toBeNull();
  });
});

/** Spec 2026-10-06 §2.6. What the Dashboard's Coming up card lists beside the bills. */
describe('expectedRecurringCharges', () => {
  const expected = (ctx: Ctx, viewer: Viewer = household(ctx.adultId)) => expectedRecurringCharges({ today: TODAY, days: 30, viewer });

  it('lists a merchant marked recurring whose next charge falls inside the window, about its typical charge', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 4, endsDaysAgo: 10, cents: 6200, accountId: ctx.visaId });
    ctx.mark('CEDAR PHONE CO', 'recurring');
    expect(expected(ctx)).toEqual([
      { merchant: 'CEDAR PHONE CO', expectedDate: addDaysIso(TODAY, 20), typicalCents: 6200, late: false, accountName: 'Travel Visa' },
    ]);
  });

  it('keeps a late one, flagged, and leaves out one past the window', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'RIVERSIDE GYM', count: 4, endsDaysAgo: 60, cents: 4500 });
    ctx.cadence({ merchant: 'LAKESIDE DOMAIN', count: 3, gapDays: 365, endsDaysAgo: 6, cents: 2400 });
    ctx.mark('RIVERSIDE GYM', 'recurring');
    ctx.mark('LAKESIDE DOMAIN', 'recurring');
    expect(expected(ctx)).toEqual([
      { merchant: 'RIVERSIDE GYM', expectedDate: addDaysIso(TODAY, -30), typicalCents: 4500, late: true, accountName: 'Chequing' },
    ]);
  });

  it('leaves out a tracked merchant, marked or not: its item already has rows of its own', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', count: 4, endsDaysAgo: 10, cents: 1349 });
    ctx.mark('MAPLE STREAMING', 'recurring');
    ctx.item({ name: 'Maple Streaming', typeId: ctx.itemType('Subscription', 'subscription') });
    expect(expected(ctx)).toEqual([]);
  });

  /** Review Focus 5. */
  it('leaves out Looks and Forming merchants, and a marked merchant with no rhythm', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'MAPLE STREAMING', count: 4, endsDaysAgo: 10, cents: 1349 });
    ctx.cadence({ merchant: 'HARBOUR INSURANCE', count: 2, endsDaysAgo: 10, cents: 13400 });
    ctx.spend({ merchant: 'CEDAR PHONE CO', date: addDaysIso(TODAY, -4), cents: -6200 });
    ctx.mark('CEDAR PHONE CO', 'recurring');
    expect(expected(ctx)).toEqual([]);
  });

  it('gives a self viewer only their own charges', async () => {
    const ctx = await setup();
    ctx.cadence({ merchant: 'CEDAR PHONE CO', count: 4, endsDaysAgo: 10, cents: 6200, person: ctx.adultId });
    ctx.mark('CEDAR PHONE CO', 'recurring');
    expect(expected(ctx, selfOnly(ctx.childId))).toEqual([]);
    expect(expected(ctx).map((charge) => charge.merchant)).toEqual(['CEDAR PHONE CO']);
  });
});
```

The existing `'drops a cadence that stopped: a cancelled subscription is not a current commitment'` is a **pin** for decision 4 (an uncovered quiet rhythm still drops); leave it unchanged.

Fails before / passes after: every new field, the Forming rows, the uncapped Looks list, the quiet tracked row and `expectedRecurringCharges` are absent until Step 7.

- [ ] **Step 4: Add the visibility guard entry (failing)**

In `tests/ops/visibility-invariants.test.ts`, after line 85 `{ file: 'src/lib/recurring.ts', fn: 'recurringLoad' },` add:

```ts
  // Spec 2026-10-06 §2.6: the Coming up card's expected charges, a spending read like recurringCharges.
  { file: 'src/lib/recurring.ts', fn: 'expectedRecurringCharges' },
```

and replace the floor test:

```ts
  // Spec 2026-10-05: raised from 34 to 41, the actual count with merchantsOfTransactions added.
  it('the named lists cannot shrink below 41 entries', () => {
    expect(REQUIRE_VIEWER.length + EXEMPT.length).toBeGreaterThanOrEqual(41);
  });
```

with

```ts
  // Spec 2026-10-05: raised from 34 to 41, the actual count with merchantsOfTransactions added.
  // Spec 2026-10-06: raised from 41 to 42, the actual count with expectedRecurringCharges added.
  it('the named lists cannot shrink below 42 entries', () => {
    expect(REQUIRE_VIEWER.length + EXEMPT.length).toBeGreaterThanOrEqual(42);
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/predict/constants.test.ts tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/ops/visibility-invariants.test.ts`
Expected: FAIL — `RECURRING_LATE_GRACE_DAYS` undefined, `recurringRhythm is not a function`, `expectedRecurringCharges is not a function`, missing row fields, `expectedRecurringCharges is not exported from src/lib/recurring.ts`.

- [ ] **Step 6: The constant and the rhythm**

In `src/lib/predict/constants.ts`, after line 83 `export const RECURRING_STALE_GRACE_DAYS = 10;` add:

```ts
/**
 * Spec 2026-10-06 §2.3. How far past its next expected date a Known merchant may be before its row
 * says late. A week: a monthly charge that lands a few days off its usual date is ordinary, and one
 * a week overdue is worth a look after a card is replaced. Next expected itself is the last charge
 * plus the median gap (src/lib/recurring.ts).
 */
export const RECURRING_LATE_GRACE_DAYS = 7;
```

In `src/lib/predict/anomalies.ts`, directly after `chargesAsOf` (ends line 160), add:

```ts
/** Spec 2026-10-06 §2.3. A band, and the median gap it was read from. */
export interface RecurringRhythm {
  cadence: RecurringCadence;
  /** Median days between charges. Next expected is the last charge plus this. */
  medianGapDays: number;
}

/**
 * Spec 2026-10-06 §2.3. The one reading of "these charges sit in a band": two charges or more
 * (chargesAsOf: money out, not in the future), the median gap in a band, and EVERY gap in that same
 * band. No freshness check, which is the point: a Known merchant's next expected date is measured
 * from this rhythm, and that date matters most once the charges have stopped. recurringVerdict and
 * formingRhythm put their own charge counts and freshness on top.
 *
 * Every gap must itself sit in the band the median chose -- not just the median (2026-09-02
 * review, I-1). At three charges there are exactly two gaps, and medianCents() of two values is
 * their mean, not an observed interval: gaps of 1 and 59 days average to 30 and, without this
 * check, would read as a confident "Monthly" though neither gap is a month. Requiring the band on
 * every gap is what stops a mean from posing as a rhythm, at any count.
 */
export function recurringRhythm(input: { charges: SpendRow[]; today: string }): RecurringRhythm | null {
  const charges = chargesAsOf(input.charges, input.today);
  if (charges.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < charges.length; index += 1) {
    gaps.push(daysBetweenIso(charges[index - 1].date, charges[index].date));
  }
  const medianGapDays = medianCents(gaps);
  if (medianGapDays === null) return null;
  const cadence = recurringBand(medianGapDays);
  if (cadence === null || !gaps.every((gap) => recurringBand(gap) === cadence)) return null;
  return { cadence, medianGapDays };
}
```

Then replace the body of `recurringVerdict` (from `const charges = chargesAsOf(input.charges, input.today);` through its final `return { … };`, keeping its leading refund/future comment and the "STILL charging" comment) with:

```ts
  // A refund or a reversal on the same merchant is not one of its charges, and a future-dated
  // row (a post-dated entry, a bad import) is not evidence of anything yet -- the same L-8
  // reasoning findDuplicates() applies below.
  const charges = chargesAsOf(input.charges, input.today);
  if (charges.length < RECURRING_MIN_CHARGES) return null;
  // The band, every gap inside it (recurringRhythm carries the I-1 reasoning).
  const rhythm = recurringRhythm({ charges, today: input.today });
  if (rhythm === null) return null;

  /**
   * STILL charging, not "once charged". This is the condition the wide window (see
   * RECURRING_LOOKBACK_DAYS) makes load-bearing: a subscription cancelled two years ago has a
   * textbook monthly median gap inside that window, and listing it as a current commitment
   * would be the exact overclaim F-05 is written to avoid. One band-width plus a small grace,
   * so a renewal read a fortnight after its anniversary still counts and one read a year late
   * does not.
   */
  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > bandMaxDays(rhythm.cadence) + RECURRING_STALE_GRACE_DAYS) return null;

  const typicalCents = medianCents(charges.map((charge) => Math.abs(charge.amountCents)));
  if (typicalCents === null) return null;

  return {
    cadence: rhythm.cadence,
    chargeCount: charges.length,
    medianGapDays: rhythm.medianGapDays,
    latestId: latest.id,
    latestDateIso: latest.date,
    latestAmountCents: Math.abs(latest.amountCents),
    typicalCents,
  };
```

(The "STILL charging" comment text above is the existing one, unchanged; the long I-1 comment moves into `recurringRhythm`'s docblock.) Replace the body of `formingRhythm` with:

```ts
  const charges = chargesAsOf(input.charges, input.today);
  if (charges.length !== RECURRING_MIN_CHARGES - 1) return null;
  const rhythm = recurringRhythm({ charges, today: input.today });
  if (rhythm === null) return null;
  const latest = charges[charges.length - 1];
  if (daysBetweenIso(latest.date, input.today) > bandMaxDays(rhythm.cadence) + RECURRING_STALE_GRACE_DAYS) return null;
  return rhythm.cadence;
```

and in its docblock change `A count's input only; nothing lists these merchants by name.` to `Spec 2026-10-06 §2.2: the Forming tier's membership test.`

Run: `npx vitest run tests/lib/predict/constants.test.ts tests/lib/predict/anomalies.test.ts`
Expected: PASS (the old `recurringVerdict`/`formingRhythm` tests included).

- [ ] **Step 7: The read model**

In `src/lib/recurring.ts`:

(a) Replace imports lines 5-9 with:

```ts
import { addDaysIso, daysBetweenIso } from '@/lib/dates';
import { listRecurringMarkRules, recurringMarkFor } from '@/lib/categorize/rules';
import {
  chargesAsOf,
  creepVerdict,
  formingRhythm,
  recurringRhythm,
  recurringVerdict,
  type RecurringCadence,
  type SpendRow,
} from '@/lib/predict/anomalies';
import { CREEP_BASELINE_DAYS, RECURRING_LATE_GRACE_DAYS, RECURRING_LOOKBACK_DAYS, RECURRING_MIN_CHARGES } from '@/lib/predict/constants';
import { divRound, medianCents } from '@/lib/predict/stats';
```

(b) Delete lines 49-54 (the `RECURRING_MAX_ROWS` docblock and constant).

(c) Replace from `/** Spec §2.3. 'known': the household marked it, or a record covers it. 'looks': a rhythm only. */` (line 74) through the end of `interface RecurringCharges` (line 112) with:

```ts
/**
 * Spec 2026-10-06 §2.2. 'known': the household marked it, or a record covers it. 'looks': a rhythm
 * only. 'forming': two charges a band apart, one short of a rhythm.
 */
export type RecurringTier = 'known' | 'looks' | 'forming';
export type RecurringKnownBy = 'mark' | 'tracked';

/** Spec 2026-10-06 §2.4. The creep finding Needs a look makes, carried onto the merchant's row. */
export interface RecurringPriceRise {
  fromCents: number;
  toCents: number;
}

export interface RecurringChargeRow {
  /** `transactions.normalized_merchant`, i.e. uppercase, exactly as the ledger groups it. */
  merchant: string;
  tier: RecurringTier;
  /** Why a Known row is known; null on a Looks or Forming row. A mark wins over a cover: only a mark can be undone. */
  knownBy: RecurringKnownBy | null;
  /** The band the charges sit in (recurringRhythm), or null: one charge, or irregular gaps. */
  cadence: RecurringCadence | null;
  chargeCount: number;
  /** Median charge magnitude; null with a single charge, where there is no "usually" to state. */
  typicalCents: number | null;
  lastAmountCents: number;
  lastDate: string;
  /** The newest charge. The Track link prefills from it, and the mark buttons post it. */
  transactionId: number;
  tracked: RecurringCover | null;
  /** Spec 2026-10-05 §2.4. Every account the merchant charged inside the window, newest charge first. */
  accounts: RecurringAccount[];
  /** Spec 2026-10-06 §2.3. lastDate plus the median gap, on any row with a cadence. May be in the past. */
  nextExpected: string | null;
  /** Spec 2026-10-06 §2.3. Known rows only: today is more than RECURRING_LATE_GRACE_DAYS past nextExpected. */
  late: boolean;
  /** Spec 2026-10-06 §2.1. typicalCents for a monthly rhythm, a twelfth of it for a yearly one; null without a cadence. */
  monthlyCents: number | null;
  /** Spec 2026-10-06 §2.4. Set when creepVerdict finds the newest charge went up. */
  priceRise: RecurringPriceRise | null;
}

export interface RecurringCharges {
  /** Sorted by merchant, never capped, and kept when the charges stop: a quiet Known row reads late. */
  known: RecurringChargeRow[];
  /** Biggest typical charge first. Spec 2026-10-06 §2.2: no cap. */
  looks: RecurringChargeRow[];
  /** Spec 2026-10-06 §2.2: listed, by merchant. */
  forming: RecurringChargeRow[];
  /**
   * Spec 2026-10-05 §2.4, owner ruling: the Account select's options -- every distinct account named
   * on a listed row of any tier, read BEFORE the account filter, by name then id.
   */
  accounts: RecurringAccount[];
  /** The account filter actually applied: input.accountId when it is among `accounts`, otherwise null (every account). */
  accountId: number | null;
}
```

(d) Replace the docblock and body of `recurringCharges` (from `/**\n * Spec 2026-10-05 §2.3 and §2.4. Two tiers over the same charges.` at line 281 through the closing `}` at line 379) with:

```ts
/** Spec 2026-10-06 §2.1. What a merchant comes to a month: a yearly charge is a twelfth of itself. */
function monthlyEquivalent(cadence: RecurringCadence | null, typicalCents: number | null): number | null {
  if (cadence === null || typicalCents === null) return null;
  return cadence === 'monthly' ? typicalCents : divRound(typicalCents, 12);
}

interface Candidate {
  row: RecurringChargeRow;
  charges: ChargeRow[];
  /** The rhythm's median gap, which next expected is measured from; null without a rhythm. */
  gapDays: number | null;
  /** A three-charge rhythm that has gone quiet: listed only if a record makes it Known. */
  quiet: boolean;
}

/**
 * Spec 2026-10-05 §2.3–§2.4 and 2026-10-06 §2.1–§2.4. Three tiers over the same charges.
 *
 * Known: the household marked the merchant 'recurring', or a recorded item or rule covers a rhythm.
 * A Known row never drops off for going quiet (2026-10-06 §2.3): a mark is kept whatever the dates
 * do, and a covered rhythm is read without the freshness check; its row reads late instead.
 * Looks: a fresh three-charge rhythm (recurringVerdict) and nothing more; a Looks rhythm that stops
 * is history and drops, as before. Forming: two charges a band apart, the newest recent. A
 * 'not_recurring' merchant is on no list.
 *
 * Every row with a cadence gets next expected (last charge plus the median gap) and a monthly
 * equivalent; Known rows past next expected by more than RECURRING_LATE_GRACE_DAYS are late. The
 * price rise is creepVerdict over the CREEP_BASELINE_DAYS slice, the window Needs a look reads.
 *
 * The account filter keeps a merchant that charged the chosen account at any point in the window.
 * The Account options are read before the filter; an account no row names reads as every account.
 * Known and Forming are sorted by merchant, Looks by typical amount descending; nothing is capped.
 */
export function recurringCharges(input: {
  today: string;
  ownerUserId: number | null;
  viewer: Viewer;
  /** Spec 2026-10-05 §2.4. Keep only merchants that charged this account; null is every account. */
  accountId: number | null;
}): RecurringCharges {
  const scope = resolveScope(input.viewer, input.ownerUserId);
  const slice = readCharges(addDaysIso(input.today, -RECURRING_LOOKBACK_DAYS), scope);

  const byMerchant = new Map<string, ChargeRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }

  const marks = listRecurringMarkRules();
  const names = accountNames();
  const candidates: Candidate[] = [];

  for (const [merchant, all] of byMerchant) {
    const mark = recurringMarkFor(merchant, marks);
    // Spec 2026-10-05 §2.3: a not_recurring merchant is on no list.
    if (mark === 'not_recurring') continue;
    const charges = chargesAsOf(all, input.today);
    if (charges.length === 0) continue;
    // Spec 2026-10-06 §2.3: the band with no freshness check, which next expected and late are read from.
    const rhythm = recurringRhythm({ charges, today: input.today });
    let tier: RecurringTier;
    let quiet = false;
    if (mark === 'recurring') tier = 'known';
    else if (recurringVerdict({ charges, today: input.today }) !== null) tier = 'looks';
    else if (rhythm !== null && charges.length >= RECURRING_MIN_CHARGES) {
      tier = 'looks';
      quiet = true;
    } else if (formingRhythm({ charges, today: input.today }) !== null) tier = 'forming';
    else continue;
    const latest = charges[charges.length - 1];
    const typicalCents = charges.length > 1 ? medianCents(charges.map((charge) => Math.abs(charge.amountCents))) : null;
    const cadence = rhythm?.cadence ?? null;
    candidates.push({
      charges,
      quiet,
      gapDays: rhythm?.medianGapDays ?? null,
      row: {
        merchant,
        tier,
        knownBy: mark === 'recurring' ? 'mark' : null,
        cadence,
        chargeCount: charges.length,
        typicalCents,
        lastAmountCents: Math.abs(latest.amountCents),
        lastDate: latest.date,
        transactionId: latest.id,
        tracked: null,
        accounts: accountsNewestFirst(charges, names),
        nextExpected: null,
        late: false,
        monthlyCents: monthlyEquivalent(cadence, typicalCents),
        priceRise: null,
      },
    });
  }

  // A cover makes a Looks row Known -- and keeps a quiet one Known (spec 2026-10-06 §2.3).
  if (candidates.length > 0) {
    const covering = needles(input.today, scope);
    for (const { row } of candidates) {
      const hit = covering.find((needle) => covers(needle, row.merchant));
      row.tracked = hit === undefined ? null : { kind: hit.kind, itemId: hit.itemId, itemName: hit.itemName };
      if (row.tier === 'looks' && row.tracked !== null) {
        row.tier = 'known';
        row.knownBy = 'tracked';
      }
    }
  }

  // Looks keeps its stale rule: an unmarked, uncovered rhythm that stopped is history.
  const listed = candidates.filter((candidate) => !candidate.quiet || candidate.row.tier === 'known');
  const creepStart = addDaysIso(input.today, -CREEP_BASELINE_DAYS);
  for (const { row, charges, gapDays } of listed) {
    row.nextExpected = gapDays === null ? null : addDaysIso(row.lastDate, gapDays);
    row.late =
      row.tier === 'known' && row.nextExpected !== null && daysBetweenIso(row.nextExpected, input.today) > RECURRING_LATE_GRACE_DAYS;
    // Spec 2026-10-06 §2.4: the same verdict, over the same window, as Needs a look.
    const rise = creepVerdict({ charges: charges.filter((charge) => charge.date >= creepStart), today: input.today });
    row.priceRise = rise === null ? null : { fromCents: rise.baselineCents, toCents: rise.newAmountCents };
  }

  // Spec 2026-10-05 §2.4, owner ruling: the options are every account a listed row names, before the filter.
  const optionById = new Map<number, RecurringAccount>();
  for (const { row } of listed) for (const account of row.accounts) optionById.set(account.id, account);
  const options = [...optionById.values()].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.id - b.id,
  );
  const accountId = input.accountId !== null && optionById.has(input.accountId) ? input.accountId : null;
  const charged = (charges: ChargeRow[]) => accountId === null || charges.some((charge) => charge.accountId === accountId);

  const kept = listed.filter(({ charges }) => charged(charges)).map(({ row }) => row);
  const byName = (a: RecurringChargeRow, b: RecurringChargeRow) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0);
  const known = kept.filter((row) => row.tier === 'known').sort(byName);
  const looks = kept
    .filter((row) => row.tier === 'looks')
    .sort((a, b) => (b.typicalCents ?? 0) - (a.typicalCents ?? 0) || byName(a, b));
  const forming = kept.filter((row) => row.tier === 'forming').sort(byName);
  return { known, looks, forming, accounts: options, accountId };
}

/**
 * Spec 2026-10-06 §2.6. A marked merchant's next charge, as the Dashboard's Coming up card lists it.
 * NOT a bill: it has no amountCents, so nothing that totals UpcomingBill rows (the card's header,
 * safeToSpend's billsDueCents) can add it by accident. A recurring charge is usually already inside a
 * category budget; counting it again would count it twice.
 */
export interface ExpectedCharge {
  merchant: string;
  /** Last charge plus the median gap. May be in the past: late, or still inside the grace. */
  expectedDate: string;
  /** The median charge; the card prints "about" it. */
  typicalCents: number;
  late: boolean;
  /** The account the newest charge landed on. */
  accountName: string;
}

/**
 * Spec 2026-10-06 §2.6. Known merchants BY MARK only, with a rhythm, whose next charge falls on or
 * before today + `days`: a tracked merchant already shows through its item's own rows, so a marked
 * merchant something covers is left out too. The overdue bound is the card's (COMING_UP_OVERDUE_DAYS),
 * applied there as it is to bills. Scoped like upcomingBills -- the viewer only, no person pill.
 */
export function expectedRecurringCharges(input: { today: string; days: number; viewer: Viewer }): ExpectedCharge[] {
  const windowEnd = addDaysIso(input.today, input.days);
  const out: ExpectedCharge[] = [];
  for (const row of recurringCharges({ today: input.today, ownerUserId: null, viewer: input.viewer, accountId: null }).known) {
    if (row.knownBy !== 'mark' || row.tracked !== null) continue;
    if (row.nextExpected === null || row.typicalCents === null || row.nextExpected > windowEnd) continue;
    out.push({
      merchant: row.merchant,
      expectedDate: row.nextExpected,
      typicalCents: row.typicalCents,
      late: row.late,
      accountName: row.accounts[0]?.name ?? '',
    });
  }
  return out.sort((a, b) =>
    a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0,
  );
}
```

(e) In the module docblock, after the paragraph beginning `Spec 2026-10-05 §2.2: what IS stored`, add:

```ts
 * Spec 2026-10-06: a third tier, Forming, is listed; every row with a cadence carries next expected,
 * a monthly equivalent and the price-rise finding; a Known row that goes quiet stays and reads late.
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/predict/constants.test.ts tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/ops/visibility-invariants.test.ts tests/ops/predict-invariants.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/predict/constants.ts src/lib/predict/anomalies.ts src/lib/recurring.ts tests/lib/predict/constants.test.ts tests/lib/predict/anomalies.test.ts tests/lib/recurring.test.ts tests/ops/visibility-invariants.test.ts
git commit -m "feat(recurring): next expected, late, Forming rows and expected charges

- recurringRhythm: band from two charges, no freshness check
- rows gain nextExpected, late, monthlyCents, priceRise; Known never drops
- Forming listed, Looks uncapped; expectedRecurringCharges for Coming up"
```

---

### Task 2: Pure helpers for the page — links, filters, sorts, the summary and the row actions (spec §2.1, §2.2, §2.3)

**Files:**
- Create: `src/lib/recurring-view.ts`
- Modify: `src/lib/insights-links.ts` (whole file; new exports appended)
- Modify: `src/lib/dates.ts` (new `dayLabel` after `monthLabel`, line 333)
- Test: `tests/lib/recurring-view.test.ts` (new), `tests/lib/insights-links.test.ts`, `tests/lib/dates.test.ts`

**Interfaces:**
- Consumes (Task 1): `RecurringChargeRow`, `RecurringCharges`, `RecurringTier` (type-only).
- Produces (`src/lib/insights-links.ts`, no imports): `RECURRING_SHOWS = ['all','known','looks','forming','late'] as const`; `type RecurringShow`; `RECURRING_SORTS = ['monthly','next','last','merchant'] as const`; `type RecurringSort`; `interface RecurringLinkScope extends InsightsLinkScope { show: RecurringShow; sort: RecurringSort }`; `recurringHref(scope: RecurringLinkScope): string`; `readRecurringParams(params: Record<string, string | string[] | undefined>): RecurringLinkScope`.
- Produces (`src/lib/dates.ts`): `dayLabel(isoDate: string, today: string): string`.
- Produces (`src/lib/recurring-view.ts`, client-safe — `import type` only from `@/lib/recurring`): `TIER_LABEL: Record<RecurringTier, string>`; `SHOW_LABEL: Record<RecurringShow, string>`; `SORT_LABEL: Record<RecurringSort, string>`; `rhythmLabel(row): string`; `nextExpectedText(row, today): string`; `priceRiseText(row): string | null`; `interface RecurringSummary { known: number; knownPriced: number; knownMonthlyCents: number; late: number; looks: number; forming: number }`; `recurringSummary(result: Pick<RecurringCharges, 'known' | 'looks' | 'forming'>): RecurringSummary`; `recurringRows(result: Pick<RecurringCharges, 'known' | 'looks' | 'forming'>, view: { show: RecurringShow; sort: RecurringSort }): RecurringChargeRow[]`; `type RecurringRowAction = { kind: 'mark'; mark: 'recurring' | 'not_recurring' | 'clear'; label: string; ariaLabel: string } | { kind: 'link'; href: string; label: string }`; `recurringRowActions(row: RecurringChargeRow): RecurringRowAction[]`.

- [ ] **Step 1: Write the failing tests**

`tests/lib/dates.test.ts`: add `dayLabel` to the existing `@/lib/dates` import, then append:

```ts
/** Spec 2026-10-06 §2.3. "expected Oct 12, nothing since": a day, with the year only when it is not this one. */
describe('dayLabel', () => {
  it('names the month and day, and the year only outside today’s', () => {
    expect(dayLabel('2026-10-12', '2026-10-06')).toBe('Oct 12');
    expect(dayLabel('2026-09-01', '2026-10-06')).toBe('Sep 1');
    expect(dayLabel('2025-11-03', '2026-10-06')).toBe('Nov 3, 2025');
  });

  it('hands back anything that is not a date untouched', () => {
    expect(dayLabel('not-a-date', '2026-10-06')).toBe('not-a-date');
  });
});
```

`tests/lib/insights-links.test.ts`: change the import to `import { insightsHref, readInsightsParams, readRecurringParams, recurringHref } from '@/lib/insights-links';` and append:

```ts
/** Spec 2026-10-06 §2.2. The /insights/recurring link and its reader. */
describe('recurringHref and readRecurringParams', () => {
  const paramsOf = (href: string) => Object.fromEntries(new URL(href, 'http://nas.local').searchParams);

  it('round-trips every shape through its reader', () => {
    for (const scope of [
      { person: null, account: null, show: 'all', sort: 'monthly' },
      { person: 7, account: 3, show: 'late', sort: 'next' },
      { person: null, account: 3, show: 'forming', sort: 'merchant' },
      { person: 7, account: null, show: 'known', sort: 'last' },
    ] as const) {
      const href = recurringHref(scope);
      expect(href.startsWith('/insights/recurring')).toBe(true);
      expect(readRecurringParams(paramsOf(href))).toEqual(scope);
    }
  });

  it('writes no querystring for the defaults, and only what differs otherwise', () => {
    expect(recurringHref({ person: null, account: null, show: 'all', sort: 'monthly' })).toBe('/insights/recurring');
    expect(recurringHref({ person: 7, account: 3, show: 'late', sort: 'next' })).toBe('/insights/recurring?person=7&account=3&show=late&sort=next');
  });

  /** Review Focus 3. */
  it('reads a malformed or repeated value as the default', () => {
    expect(readRecurringParams({ show: 'everything', sort: 'drop', account: 'abc', person: 'x' })).toEqual({
      person: null,
      account: null,
      show: 'all',
      sort: 'monthly',
    });
    expect(readRecurringParams({ show: ['late', 'known'], sort: ['next'] })).toEqual({ person: null, account: null, show: 'late', sort: 'next' });
  });
});
```

Create `tests/lib/recurring-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { RecurringChargeRow } from '@/lib/recurring';
import {
  nextExpectedText,
  priceRiseText,
  recurringRowActions,
  recurringRows,
  recurringSummary,
  rhythmLabel,
} from '@/lib/recurring-view';

/** Spec 2026-10-06 §2.1–§2.3. Pure: the page and the card read rows through these. */
const TODAY = '2026-10-06';

function row(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'MAPLE STREAMING',
    tier: 'looks',
    knownBy: null,
    cadence: 'monthly',
    chargeCount: 7,
    typicalCents: 1349,
    lastAmountCents: 1349,
    lastDate: '2026-09-28',
    transactionId: 501,
    tracked: null,
    accounts: [{ id: 2, name: 'Travel Visa' }],
    nextExpected: '2026-10-28',
    late: false,
    monthlyCents: 1349,
    priceRise: null,
    ...over,
  };
}

const gym = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', typicalCents: 4500, monthlyCents: 4500, lastDate: '2026-08-01', nextExpected: '2026-08-31', late: true, transactionId: 610 });
const phone = row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, monthlyCents: null, nextExpected: null, lastDate: '2026-10-01', transactionId: 620 });
const domain = row({
  merchant: 'LAKESIDE DOMAIN',
  tier: 'known',
  knownBy: 'tracked',
  cadence: 'yearly',
  typicalCents: 2500,
  monthlyCents: 208,
  lastDate: '2025-11-03',
  nextExpected: '2026-11-03',
  tracked: { kind: 'item', itemId: 9, itemName: 'Lakeside Domain' },
  transactionId: 630,
});
const insurance = row({ merchant: 'HARBOUR INSURANCE', tier: 'forming', typicalCents: 13400, monthlyCents: 13400, lastDate: '2026-10-03', nextExpected: '2026-11-02', transactionId: 640 });
const maple = row();
const result = { known: [phone, domain, gym], looks: [maple], forming: [insurance] };
const names = (rows: RecurringChargeRow[]) => rows.map((r) => r.merchant);

describe('recurringSummary', () => {
  /** Review Focus 5. */
  it('counts every Known merchant but prices only the ones with a rhythm', () => {
    expect(recurringSummary(result)).toEqual({ known: 3, knownPriced: 2, knownMonthlyCents: 4708, late: 1, looks: 1, forming: 1 });
  });

  it('is all zeroes on nothing', () => {
    expect(recurringSummary({ known: [], looks: [], forming: [] })).toEqual({ known: 0, knownPriced: 0, knownMonthlyCents: 0, late: 0, looks: 0, forming: 0 });
  });
});

describe('recurringRows', () => {
  it('shows every tier, one tier, or the late rows', () => {
    expect(recurringRows(result, { show: 'all', sort: 'merchant' })).toHaveLength(5);
    expect(names(recurringRows(result, { show: 'known', sort: 'merchant' }))).toEqual(['CEDAR PHONE CO', 'LAKESIDE DOMAIN', 'RIVERSIDE GYM']);
    expect(names(recurringRows(result, { show: 'looks', sort: 'merchant' }))).toEqual(['MAPLE STREAMING']);
    expect(names(recurringRows(result, { show: 'forming', sort: 'merchant' }))).toEqual(['HARBOUR INSURANCE']);
    expect(names(recurringRows(result, { show: 'late', sort: 'merchant' }))).toEqual(['RIVERSIDE GYM']);
  });

  it('sorts by monthly amount, biggest first, a row with none last', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'monthly' }))).toEqual([
      'HARBOUR INSURANCE', 'RIVERSIDE GYM', 'MAPLE STREAMING', 'LAKESIDE DOMAIN', 'CEDAR PHONE CO',
    ]);
  });

  it('sorts by next expected, late first, soonest next, a row with none last', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'next' }))).toEqual([
      'RIVERSIDE GYM', 'MAPLE STREAMING', 'HARBOUR INSURANCE', 'LAKESIDE DOMAIN', 'CEDAR PHONE CO',
    ]);
  });

  it('sorts by last charge, newest first, and by merchant', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'last' }))).toEqual([
      'HARBOUR INSURANCE', 'CEDAR PHONE CO', 'MAPLE STREAMING', 'RIVERSIDE GYM', 'LAKESIDE DOMAIN',
    ]);
    expect(names(recurringRows(result, { show: 'all', sort: 'merchant' }))).toEqual([
      'CEDAR PHONE CO', 'HARBOUR INSURANCE', 'LAKESIDE DOMAIN', 'MAPLE STREAMING', 'RIVERSIDE GYM',
    ]);
  });

  it('leaves the read model’s own lists in their order', () => {
    recurringRows(result, { show: 'all', sort: 'monthly' });
    expect(names(result.known)).toEqual(['CEDAR PHONE CO', 'LAKESIDE DOMAIN', 'RIVERSIDE GYM']);
  });
});

describe('the words on a row', () => {
  it('names the rhythm, or Marked without one', () => {
    expect([rhythmLabel(maple), rhythmLabel(domain), rhythmLabel(phone)]).toEqual(['Monthly', 'Yearly', 'Marked']);
  });

  it('states next expected, and a late row as expected <day>, nothing since', () => {
    expect(nextExpectedText(gym, TODAY)).toBe('expected Aug 31, nothing since');
    expect(nextExpectedText(maple, TODAY)).toBe('Oct 28');
    expect(nextExpectedText(domain, TODAY)).toBe('Nov 3');
    expect(nextExpectedText(phone, TODAY)).toBe('—');
  });

  it('states a price rise as up from A to B', () => {
    expect(priceRiseText(row({ priceRise: { fromCents: 1349, toCents: 1599 } }))).toBe('up from $13.49 to $15.99');
    expect(priceRiseText(maple)).toBeNull();
  });
});

/** Spec 2026-10-06 §2.2, row actions by state. */
describe('recurringRowActions', () => {
  const labels = (r: RecurringChargeRow) => recurringRowActions(r).map((action) => action.label);

  it('Looks and Forming: Mark recurring, Not recurring, and Track when nothing covers it', () => {
    expect(labels(maple)).toEqual(['Mark recurring', 'Not recurring', 'Track']);
    expect(recurringRowActions(maple)[2]).toEqual({ kind: 'link', href: '/warranties/new?transactionId=501', label: 'Track' });
    expect(labels(row({ tier: 'forming', tracked: { kind: 'rule', itemId: 4, itemName: 'Phone plan' } }))).toEqual(['Mark recurring', 'Not recurring']);
  });

  it('Known by a mark: Unmark, and Track when nothing covers it', () => {
    expect(labels(phone)).toEqual(['Unmark', 'Track']);
    expect(labels(row({ tier: 'known', knownBy: 'mark', tracked: { kind: 'item', itemId: 9, itemName: 'Lakeside Domain' } }))).toEqual(['Unmark']);
    expect(recurringRowActions(phone)[0]).toMatchObject({ kind: 'mark', mark: 'clear' });
  });

  it('Known by tracking only: Mark recurring, and the way to the item', () => {
    expect(recurringRowActions(domain)).toEqual([
      { kind: 'mark', mark: 'recurring', label: 'Mark recurring', ariaLabel: 'Mark LAKESIDE DOMAIN as recurring' },
      { kind: 'link', href: '/warranties/9', label: 'Open Lakeside Domain' },
    ]);
  });
});
```

Fails before / passes after: `dayLabel`, `recurringHref`, `readRecurringParams` and the whole `recurring-view` module do not exist until Steps 3–5.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/dates.test.ts tests/lib/insights-links.test.ts tests/lib/recurring-view.test.ts`
Expected: FAIL — not exported / cannot find module `@/lib/recurring-view`.

- [ ] **Step 3: `dayLabel`**

In `src/lib/dates.ts`, after `monthLabel` (ends line 333) add:

```ts
/**
 * Spec 2026-10-06 §2.3. '2026-10-12' -> 'Oct 12', or 'Nov 3, 2025' when the year is not today's,
 * so a yearly merchant's date is never read as this year's. The same lookup table as monthLabel,
 * for the same reason: no Date, no zone. Anything that is not a date is handed back untouched.
 */
export function dayLabel(isoDate: string, today: string): string {
  if (!isIsoDate(isoDate)) return isoDate;
  const [year, month, day] = isoDate.split('-');
  const label = `${FULL_MONTH_NAMES[Number(month) - 1].slice(0, 3)} ${Number(day)}`;
  return year === today.slice(0, 4) ? label : `${label}, ${year}`;
}
```

- [ ] **Step 4: The links**

Replace `src/lib/insights-links.ts` with:

```ts
/**
 * Spec 2026-10-05 §2.4 and 2026-10-06 §2.2. The one builder of an /insights or /insights/recurring
 * link and the one reader of their params. A link that drops `person` answers a different question
 * than the figure it came from -- the rule transactionsHref (src/lib/transaction-links.ts) enforces
 * for /transactions. No imports, so a client component and a server page can both use it
 * (tests/ops/client-bundle.test.ts).
 */
export interface InsightsLinkScope {
  /** The person scope, a user id; null is the whole household. A self viewer's own scope still wins server-side. */
  person: number | null;
  /** The Account filter; null is every account. */
  account: number | null;
}

export function insightsHref(scope: InsightsLinkScope): string {
  const params = new URLSearchParams();
  if (scope.person !== null) params.set('person', String(scope.person));
  if (scope.account !== null) params.set('account', String(scope.account));
  const query = params.toString();
  return query === '' ? '/insights' : `/insights?${query}`;
}

/** The first value of a param, or '' -- a repeated key reads as its first. */
function firstValue(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Digits or nothing, the way the Dashboard reads ?person=: a malformed value is no filter, never an error. */
function idOf(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

export function readInsightsParams(params: Record<string, string | string[] | undefined>): InsightsLinkScope {
  return { person: idOf(firstValue(params, 'person')), account: idOf(firstValue(params, 'account')) };
}

/** Spec 2026-10-06 §2.2. The full page's Show choices; 'all' is the default and is never written. */
export const RECURRING_SHOWS = ['all', 'known', 'looks', 'forming', 'late'] as const;
export type RecurringShow = (typeof RECURRING_SHOWS)[number];

/** Spec 2026-10-06 §2.2. The full page's Sort choices; 'monthly' is the default and is never written. */
export const RECURRING_SORTS = ['monthly', 'next', 'last', 'merchant'] as const;
export type RecurringSort = (typeof RECURRING_SORTS)[number];

export interface RecurringLinkScope extends InsightsLinkScope {
  show: RecurringShow;
  sort: RecurringSort;
}

export function recurringHref(scope: RecurringLinkScope): string {
  const params = new URLSearchParams();
  if (scope.person !== null) params.set('person', String(scope.person));
  if (scope.account !== null) params.set('account', String(scope.account));
  if (scope.show !== 'all') params.set('show', scope.show);
  if (scope.sort !== 'monthly') params.set('sort', scope.sort);
  const query = params.toString();
  return query === '' ? '/insights/recurring' : `/insights/recurring?${query}`;
}

/** A value outside the fixed lists reads as the default: a hand-edited address shows the page, never an error. */
export function readRecurringParams(params: Record<string, string | string[] | undefined>): RecurringLinkScope {
  const show = firstValue(params, 'show');
  const sort = firstValue(params, 'sort');
  return {
    ...readInsightsParams(params),
    show: (RECURRING_SHOWS as readonly string[]).includes(show) ? (show as RecurringShow) : 'all',
    sort: (RECURRING_SORTS as readonly string[]).includes(sort) ? (sort as RecurringSort) : 'monthly',
  };
}
```

- [ ] **Step 5: `src/lib/recurring-view.ts`**

```ts
import { dayLabel } from '@/lib/dates';
import type { RecurringShow, RecurringSort } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
// Type-only: @/lib/recurring imports @/db, and this module is value-imported by client components
// (tests/ops/client-bundle.test.ts draws exactly that line).
import type { RecurringChargeRow, RecurringCharges, RecurringTier } from '@/lib/recurring';

/**
 * Spec 2026-10-06 §2.1–§2.3. What the Insights summary and the full page read from the rows, pure,
 * so a client component and a server page can share it. Every string here states what was measured
 * or what the household said (spec §2.7).
 */
export const TIER_LABEL: Record<RecurringTier, string> = { known: 'Known', looks: 'Looks', forming: 'Forming' };

export const SHOW_LABEL: Record<RecurringShow, string> = {
  all: 'All',
  known: 'Known recurring',
  looks: 'Looks recurring',
  forming: 'Forming',
  late: 'Late',
};

export const SORT_LABEL: Record<RecurringSort, string> = {
  monthly: 'Monthly amount',
  next: 'Next expected',
  last: 'Last charge',
  merchant: 'Merchant, A to Z',
};

export function rhythmLabel(row: RecurringChargeRow): string {
  if (row.cadence === null) return 'Marked';
  return row.cadence === 'monthly' ? 'Monthly' : 'Yearly';
}

/** Spec §2.3: a late row reads "expected Oct 12, nothing since" -- a measured fact, no verdict. */
export function nextExpectedText(row: RecurringChargeRow, today: string): string {
  if (row.nextExpected === null) return '—';
  const day = dayLabel(row.nextExpected, today);
  return row.late ? `expected ${day}, nothing since` : day;
}

/** Spec §2.4. */
export function priceRiseText(row: RecurringChargeRow): string | null {
  if (row.priceRise === null) return null;
  return `up from ${formatCents(row.priceRise.fromCents)} to ${formatCents(row.priceRise.toCents)}`;
}

/** Spec §2.1. The card's three lines. The monthly figure is Known only, and only rows with a cadence. */
export interface RecurringSummary {
  known: number;
  /** How many Known rows the monthly figure was summed from; 0 means the card prints no figure. */
  knownPriced: number;
  knownMonthlyCents: number;
  late: number;
  looks: number;
  forming: number;
}

type Tiers = Pick<RecurringCharges, 'known' | 'looks' | 'forming'>;

export function recurringSummary(result: Tiers): RecurringSummary {
  const priced = result.known.filter((row) => row.monthlyCents !== null);
  return {
    known: result.known.length,
    knownPriced: priced.length,
    knownMonthlyCents: priced.reduce((sum, row) => sum + (row.monthlyCents ?? 0), 0),
    late: result.known.filter((row) => row.late).length,
    looks: result.looks.length,
    forming: result.forming.length,
  };
}

const byMerchant = (a: RecurringChargeRow, b: RecurringChargeRow) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0);

/** Ascending, a missing date last. */
function byDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const COMPARE: Record<RecurringSort, (a: RecurringChargeRow, b: RecurringChargeRow) => number> = {
  monthly: (a, b) => (b.monthlyCents ?? -1) - (a.monthlyCents ?? -1) || byMerchant(a, b),
  next: (a, b) => Number(b.late) - Number(a.late) || byDate(a.nextExpected, b.nextExpected) || byMerchant(a, b),
  last: (a, b) => byDate(b.lastDate, a.lastDate) || byMerchant(a, b),
  merchant: byMerchant,
};

/** Spec §2.2. Every tier in one list, narrowed by Show and ordered by Sort. A new array; the inputs are left as they are. */
export function recurringRows(result: Tiers, view: { show: RecurringShow; sort: RecurringSort }): RecurringChargeRow[] {
  const all = [...result.known, ...result.looks, ...result.forming];
  const shown = all.filter((row) => (view.show === 'all' ? true : view.show === 'late' ? row.late : row.tier === view.show));
  return shown.sort(COMPARE[view.sort]);
}

export type RecurringRowAction =
  | { kind: 'mark'; mark: 'recurring' | 'not_recurring' | 'clear'; label: string; ariaLabel: string }
  | { kind: 'link'; href: string; label: string };

/**
 * Spec §2.2, row actions by state. Looks or Forming: Mark recurring, Not recurring, and Track when
 * nothing covers it. Known by a mark: Unmark, and Track when nothing covers it. Known by tracking
 * only: Mark recurring (so it stays listed if the record goes) and the way to the item.
 */
export function recurringRowActions(row: RecurringChargeRow): RecurringRowAction[] {
  const mark: RecurringRowAction = { kind: 'mark', mark: 'recurring', label: 'Mark recurring', ariaLabel: `Mark ${row.merchant} as recurring` };
  const track: RecurringRowAction[] =
    row.tracked === null ? [{ kind: 'link', href: `/warranties/new?transactionId=${row.transactionId}`, label: 'Track' }] : [];
  if (row.tier !== 'known') {
    return [
      mark,
      { kind: 'mark', mark: 'not_recurring', label: 'Not recurring', ariaLabel: `Mark ${row.merchant} as not recurring and take it off these lists` },
      ...track,
    ];
  }
  if (row.knownBy === 'mark') return [{ kind: 'mark', mark: 'clear', label: 'Unmark', ariaLabel: `Unmark ${row.merchant}` }, ...track];
  return row.tracked === null ? [mark] : [mark, { kind: 'link', href: `/warranties/${row.tracked.itemId}`, label: `Open ${row.tracked.itemName}` }];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/dates.test.ts tests/lib/insights-links.test.ts tests/lib/recurring-view.test.ts tests/ops/no-utc-date-slice.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dates.ts src/lib/insights-links.ts src/lib/recurring-view.ts tests/lib/dates.test.ts tests/lib/insights-links.test.ts tests/lib/recurring-view.test.ts
git commit -m "feat(recurring): pure helpers for the recurring page

- recurringHref/readRecurringParams: show and sort, defaults unwritten
- recurring-view: summary, Show/Sort, row actions, labels
- dayLabel for next expected"
```

---

### Task 3: Transactions — the bulk bar skips transfers, the row menu toggles (spec §2.5)

**Files:**
- Modify: `src/lib/transactions.ts` (`merchantsOfTransactions` :962-971)
- Modify: `src/app/(app)/transactions/actions.ts` (`setRecurringMarkAction` :477-496, `bulkRecurringMarkAction` :499-517)
- Modify: `src/app/(app)/transactions/transactions-client.tsx` (`recurringMenuItems` :1284-1304)
- Test: `tests/app/transactions-actions.test.ts`, `tests/app/transactions-client.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `merchantsOfTransactions(ids)` now leaves transfer rows out (signature unchanged).

- [ ] **Step 1: Write the failing action tests**

In `tests/app/transactions-actions.test.ts`, inside `describe('bulkRecurringMarkAction', …)`, change the expectation of `'refuses a selection with no merchant instead of reporting it marked'` to:

```ts
    expect(await bulkRecurringMarkAction({}, formData({ ids: String(id), mark: 'recurring' }))).toEqual({
      error: 'There is no merchant on these rows to mark. Transfer rows are skipped.',
    });
```

and append inside the same describe:

```ts
  /** Spec 2026-10-06 §2.5. A transfer is never a charge, so the count is the merchants actually marked. */
  it('skips transfer rows, so the count is the merchants actually marked', async () => {
    const { addTxn, sqlite } = setup();
    const a = addTxn('RIVERSIDE GYM', -4500);
    const b = addTxn('OWN SAVINGS', -20000);
    sqlite.prepare('update transactions set is_transfer = 1 where id = ?').run(b);
    expect(await bulkRecurringMarkAction({}, formData({ ids: `${a},${b}`, mark: 'recurring' }))).toEqual({
      message: 'Marked 1 merchant as recurring.',
    });
    expect(listRules('recurring').map((rule) => rule.pattern)).toEqual(['RIVERSIDE GYM']);
  });

  it('refuses a selection of transfer rows only, and says transfers are skipped', async () => {
    const { addTxn, sqlite } = setup();
    const b = addTxn('OWN SAVINGS', -20000);
    sqlite.prepare('update transactions set is_transfer = 1 where id = ?').run(b);
    expect(await bulkRecurringMarkAction({}, formData({ ids: String(b), mark: 'recurring' }))).toEqual({
      error: 'There is no merchant on these rows to mark. Transfer rows are skipped.',
    });
    expect(listRules('recurring')).toEqual([]);
  });

  /** Spec 2026-10-06 §2.2, §2.6: a mark now shows on the full page and in Coming up. */
  it('refreshes the recurring page and the Dashboard, from the row and the bulk bar', async () => {
    const { addTxn } = setup();
    const id = addTxn('RIVERSIDE GYM', -4500);
    vi.mocked(revalidatePath).mockClear();
    await setRecurringMarkAction({}, formData({ transactionId: String(id), mark: 'recurring' }));
    await bulkRecurringMarkAction({}, formData({ ids: String(id), mark: 'clear' }));
    const paths = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    expect(paths.filter((p) => p === '/insights/recurring')).toHaveLength(2);
    expect(paths.filter((p) => p === '/dashboard')).toHaveLength(2);
  });
```

Fails before / passes after: `merchantsOfTransactions` returns the transfer's merchant today, so the count is 2 and the transfer-only selection is marked; the two new `revalidatePath` calls do not exist.

- [ ] **Step 2: Write the failing menu tests**

In `tests/app/transactions-client.test.tsx`, inside `describe('TransactionsClient — the recurring mark', …)`, replace the first and third tests:

```ts
  /** Spec 2026-10-06 §2.5: a toggle, like the transfer item. Not recurring is set from Insights. */
  it('offers only Mark recurring for a merchant with no mark', () => {
    render(<TransactionsClient page={pageWithRow()} {...base} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Mark recurring' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Not recurring' })).toBeNull();
  });
```

```ts
  /** Review Focus 4 (v1.54.0): the way back from Not recurring, and nothing else until it is taken. */
  it('offers only the way back from Not recurring', () => {
    render(<TransactionsClient page={pageWithRow()} {...base} recurringMarks={{ 'TIM HORTONS': 'not_recurring' }} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.getByRole('menuitem', { name: 'Clear “not recurring”' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Mark recurring' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Not recurring' })).toBeNull();
  });
```

`'offers only Unmark recurring once the merchant is marked'`, `'offers no mark on a transfer row …'`, `'posts the row id and the mark'` and `'marks every selected row from the bulk bar'` are **pins** (unchanged, pass before and after).

Fails before / passes after: the menu offers `Not recurring` on an unmarked merchant and `Mark recurring` on a not_recurring one until Step 5.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx`
Expected: FAIL in the five new or changed tests only.

- [ ] **Step 4: Skip transfers, and refresh the new places**

`src/lib/transactions.ts`, replace `merchantsOfTransactions` with:

```ts
/**
 * The distinct merchants of `ids`, for the recurring marks (spec 2026-10-05 §2.2). Spec 2026-10-06
 * §2.5: transfer rows are left out -- a transfer is never a charge, so "Marked N merchants" counts
 * only merchants a mark can mean anything for. Callers have already passed `ids` through
 * allTransactionsVisible.
 */
export function merchantsOfTransactions(ids: number[]): string[] {
  if (ids.length === 0) return [];
  return getDb()
    .selectDistinct({ merchant: transactions.normalizedMerchant })
    .from(transactions)
    .where(and(inArray(transactions.id, ids), eq(transactions.isTransfer, false)))
    .orderBy(asc(transactions.normalizedMerchant))
    .all()
    .map((row) => row.merchant);
}
```

(Confirm `and` and `eq` are already imported from `drizzle-orm` at the top of `src/lib/transactions.ts`; add whichever is missing to that import.)

`src/app/(app)/transactions/actions.ts`: in **both** `setRecurringMarkAction` and `bulkRecurringMarkAction`, after `revalidatePath('/insights');` add:

```ts
  revalidatePath('/insights/recurring');
  revalidatePath('/dashboard');
```

and in `bulkRecurringMarkAction` change

```ts
  if (result.merchants === 0) return { error: 'There is no merchant on these rows to mark.' };
```

to

```ts
  if (result.merchants === 0) return { error: 'There is no merchant on these rows to mark. Transfer rows are skipped.' };
```

and its docblock to `/** Spec 2026-10-05 §2.2, 2026-10-06 §2.5. The bulk bar's "Mark recurring": every distinct merchant in the selection, transfers skipped, all or nothing. */`.

- [ ] **Step 5: The toggle**

`transactions-client.tsx`, replace `recurringMenuItems` and its docblock with:

```tsx
  /**
   * Spec 2026-10-06 §2.5. A toggle, like the transfer item beside it: Mark recurring, or Unmark
   * recurring once marked. Not recurring is set from the Insights page; a merchant marked that way
   * offers only the way back here.
   */
  function recurringMenuItems(row: TransactionRow) {
    const mark = recurringMarks[row.normalizedMerchant] ?? null;
    const fields = (choice: 'recurring' | 'clear') => ({ transactionId: String(row.id), mark: choice });
    if (mark === 'recurring') {
      return <RowMenuForm action={rowRecurringAction} fields={fields('clear')}>Unmark recurring</RowMenuForm>;
    }
    if (mark === 'not_recurring') {
      return <RowMenuForm action={rowRecurringAction} fields={fields('clear')}>{'Clear “not recurring”'}</RowMenuForm>;
    }
    return <RowMenuForm action={rowRecurringAction} fields={fields('recurring')}>Mark recurring</RowMenuForm>;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx tests/ops/visibility-invariants.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/transactions.ts "src/app/(app)/transactions/actions.ts" "src/app/(app)/transactions/transactions-client.tsx" tests/app/transactions-actions.test.ts tests/app/transactions-client.test.tsx
git commit -m "feat(transactions): recurring mark toggles; bulk mark skips transfers

- row menu: Mark recurring / Unmark recurring / Clear not recurring
- merchantsOfTransactions leaves transfer rows out
- mark actions refresh /insights/recurring and /dashboard"
```

> **REVIEW CHECKPOINT 1 (Opus).** Review Tasks 1–3 together (`git diff 1b19d95..HEAD`): the rhythm refactor against its pins, the read model's tiers/never-drop/late/monthly/price-rise and decision 4's bounds, `expectedRecurringCharges` and decision 9, the view helpers' sorts and row actions against spec §2.2, the Transactions toggle and transfer skip. Run the touched test files above. One fix round for Important findings, then Task 4.

---

### Task 4: Recurring charges on Insights becomes a summary (spec §2.1)

**Files:**
- Modify: `src/components/insights/RecurringChargesCard.tsx` (whole file except `recordedBillingSentence`, which is kept byte-for-byte)
- Modify: `src/app/(app)/insights/page.tsx`, `src/app/(app)/insights/insights-client.tsx`
- Test: `tests/components/recurring-charges-card.test.tsx` (rewritten), `tests/app/insights-page.test.tsx`

**Interfaces:**
- Consumes (Task 1): `recurringCharges`. (Task 2): `recurringSummary`, `RecurringSummary`, `recurringHref`, `readInsightsParams`.
- Produces: `RecurringChargesCard({ summary, person }: { summary: RecurringSummary; person: number | null })`; `InsightsClient` takes `summary: RecurringSummary` in place of `recurring: RecurringCharges`.

- [ ] **Step 1: Rewrite the card test (failing)**

Replace `tests/components/recurring-charges-card.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import type { RecurringSummary } from '@/lib/recurring-view';

afterEach(cleanup);

/** Spec 2026-10-06 §2.1. The card counts; the rows live on /insights/recurring. */
const SOME: RecurringSummary = { known: 3, knownPriced: 2, knownMonthlyCents: 4708, late: 1, looks: 4, forming: 2 };
const NONE: RecurringSummary = { known: 0, knownPriced: 0, knownMonthlyCents: 0, late: 0, looks: 0, forming: 0 };

function lineFor(term: string): string {
  const dt = screen.getByText(term, { selector: 'dt' });
  return (dt.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('RecurringChargesCard', () => {
  it('states each tier as one line', () => {
    render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(lineFor('Known recurring')).toBe('3 merchants · about $47.08 a month · 1 late');
    expect(lineFor('Looks recurring')).toBe('4 to review');
    expect(lineFor('Forming')).toBe('2 one more charge from a rhythm');
  });

  it('still shows a tier at zero, so the card reads as alive', () => {
    render(<RecurringChargesCard summary={NONE} person={null} />);
    expect(lineFor('Known recurring')).toBe('0 merchants');
    expect(lineFor('Looks recurring')).toBe('0 to review');
    expect(lineFor('Forming')).toBe('0 one more charge from a rhythm');
  });

  /** Review Focus 5. */
  it('leaves the monthly figure out when no Known merchant has a rhythm', () => {
    render(<RecurringChargesCard summary={{ ...NONE, known: 1 }} person={null} />);
    expect(lineFor('Known recurring')).toBe('1 merchant');
  });

  it('links the late count to the page filtered to late rows, carrying the person', () => {
    render(<RecurringChargesCard summary={SOME} person={7} />);
    expect(screen.getByRole('link', { name: '1 late' }).getAttribute('href')).toBe('/insights/recurring?person=7&show=late&sort=next');
  });

  it('opens the full page from See all recurring charges, carrying the person', () => {
    render(<RecurringChargesCard summary={SOME} person={7} />);
    expect(screen.getByRole('link', { name: 'See all recurring charges' }).getAttribute('href')).toBe('/insights/recurring?person=7');
  });

  it('lists no merchant rows and offers no Account filter', () => {
    const { container } = render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('never says subscription, wasted, forgotten, cancel or missed payment', () => {
    const { container } = render(<RecurringChargesCard summary={SOME} person={null} />);
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
```

Fails before / passes after: the old card takes `result`, not `summary`, and renders tier tables until Step 4.

- [ ] **Step 2: Update the page test (failing)**

In `tests/app/insights-page.test.tsx`:

(a) After the `vi.mock('@/lib/auth/session', …)` line add:

```ts
// redirect() throws in Next; the same stand-in tests/app/import-page.test.ts uses, the rest of the module kept.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
```

(b) Replace `'renders the guide, both tiers and a marked merchant under Known recurring'` with:

```ts
  it('renders the guide and the Recurring charges summary, without the rows', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.spend({ merchant: 'RIVERSIDE GYM', daysAgo: 4, cents: 4500, person: s.adult });
    s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo: 33, cents: 13400, person: s.adult });
    s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo: 3, cents: 13400, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('What is this page for?');
    const card = screen.getByRole('heading', { name: 'Recurring charges' }).closest('section') as HTMLElement;
    expect(card.textContent).toContain('1 merchant');
    expect(card.textContent).toContain('1 to review');
    expect(card.textContent).toContain('1 one more charge from a rhythm');
    expect(card.querySelector('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'See all recurring charges' }).getAttribute('href')).toBe('/insights/recurring');
  });

  it('links the late count to the full page', async () => {
    const s = await seed();
    for (const daysAgo of [100, 70]) s.spend({ merchant: 'RIVERSIDE GYM', daysAgo, cents: 4500, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(screen.getByRole('link', { name: '1 late' }).getAttribute('href')).toBe('/insights/recurring?show=late&sort=next');
  });
```

(c) Replace `'a self viewer sees only their own charges, whatever ?person= says'` with:

```ts
  /** Review Focus 4. */
  it('a self viewer’s summary counts only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ person: String(s.adult) });
    const card = screen.getByRole('heading', { name: 'Recurring charges' }).closest('section') as HTMLElement;
    expect(card.textContent).toContain('1 to review');
  });
```

(d) Replace both `'filters to the account in ?account= and keeps the choice selected'` and `'ignores an account the viewer cannot see'` with:

```ts
  /** Review Focus 3: v1.54.0 promised a filtered list could be bookmarked or sent. */
  it('sends a v1.54.0 /insights?account= link to the full page', async () => {
    await seed();
    currentUser.value = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await expect(renderPage({ account: '7', person: '3' })).rejects.toThrow('NEXT_REDIRECT:/insights/recurring?person=3&account=7');
  });
```

(e) Delete `'a self viewer can pick an account their own charges landed on, though they do not own it'` (Task 5 owns the Account select). `'says whose charges a household viewer is looking at, with the way back'` and `'shows every Needs a look finding, past the Dashboard cap'` are **pins**.

Fails before / passes after: the summary text, `See all recurring charges`, the late link and the redirect are missing until Steps 4–5.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/components/recurring-charges-card.test.tsx tests/app/insights-page.test.tsx`
Expected: FAIL.

- [ ] **Step 4: The card**

Replace everything in `src/components/insights/RecurringChargesCard.tsx` **above** the `recordedBillingSentence` docblock (`/**\n * The Contracts & Coverage header line …`) with:

```tsx
import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { recurringHref } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
import type { RecurringSummary } from '@/lib/recurring-view';

/**
 * Spec 2026-10-06 §2.1. "Recurring charges" on Insights, as a summary: one line per tier and the way
 * to the full list on /insights/recurring, where the rows, the Account filter and the marks live.
 *
 * THE WORDING IS STILL THE FEATURE (spec §2.7). Cadence detection cannot tell a once-a-month shop
 * from a bill, so every string states what was measured or what the household said. The monthly
 * figure is Known recurring only (a Looks row may be a monthly shop), and says "about" because it is
 * a sum of medians.
 */
export function RecurringChargesCard({ summary, person }: { summary: RecurringSummary; person: number | null }) {
  const merchants = `${summary.known} ${summary.known === 1 ? 'merchant' : 'merchants'}`;
  const monthly = summary.knownPriced === 0 ? '' : ` · about ${formatCents(summary.knownMonthlyCents)} a month`;
  return (
    <Card>
      <CardHeader
        title="Recurring charges"
        description="Merchants that bill on a rhythm, read from about three years of the ledger. Known recurring is what you said; Looks recurring is what the dates show; Forming is one charge short of a rhythm."
        action={
          <Link href={recurringHref({ person, account: null, show: 'all', sort: 'monthly' })} className={buttonClass('secondary', 'sm')}>
            See all recurring charges
          </Link>
        }
      />
      <CardBody>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Known recurring</dt>
            <dd className="text-muted">
              {merchants}
              {monthly}
              {summary.late === 0 ? null : (
                <>
                  {' · '}
                  <Link
                    href={recurringHref({ person, account: null, show: 'late', sort: 'next' })}
                    className="font-medium text-accent-text underline underline-offset-2"
                  >
                    {summary.late} late
                  </Link>
                </>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Looks recurring</dt>
            <dd className="text-muted">{summary.looks} to review</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-semibold text-ink">Forming</dt>
            <dd className="text-muted">{summary.forming} one more charge from a rhythm</dd>
          </div>
        </dl>
      </CardBody>
    </Card>
  );
}
```

(`formingSentence`, `AccountFilter`, `ChargeRowView`, `Tier`, `CADENCE_LABEL` and their imports go; `recordedBillingSentence` stays — `warranties-client.tsx` imports it.)

- [ ] **Step 5: The page and its client**

Replace `src/app/(app)/insights/page.tsx` with:

```tsx
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { householdInsights } from '@/lib/insights';
import { readInsightsParams, recurringHref } from '@/lib/insights-links';
import { recurringCharges } from '@/lib/recurring';
import { recurringSummary } from '@/lib/recurring-view';
import { InsightsClient } from './insights-client';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-05 §2.1 and 2026-10-06 §2.1. Two read models, nothing stored. The person scope follows
 * ruling R2's S-01 order -- a self viewer's own scope wins over whatever ?person= asks. The Recurring
 * charges card is a summary over every account; the Account filter moved to /insights/recurring, and
 * a v1.54.0 link that still carries ?account= is sent there (that release promised a filtered list
 * could be bookmarked or sent).
 */
export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readInsightsParams(await searchParams);
  if (asked.account !== null) redirect(recurringHref({ person: asked.person, account: asked.account, show: 'all', sort: 'monthly' }));
  const today = todayIso();
  const person = ownerScope(viewer) ?? asked.person;
  const summary = recurringSummary(recurringCharges({ today, ownerUserId: person, viewer, accountId: null }));
  // The full list: the Dashboard's card is the capped summary of this one.
  const findings = householdInsights({ today, viewer, limit: null });
  const personName = isSelfScoped(viewer) || person === null ? null : (findUserById(person)?.name ?? null);
  return <InsightsClient summary={summary} findings={findings} person={person} personName={personName} />;
}
```

In `src/app/(app)/insights/insights-client.tsx`:
- replace `import type { RecurringCharges } from '@/lib/recurring';` with `import type { RecurringSummary } from '@/lib/recurring-view';`
- in the props, replace `recurring,` / `recurring: RecurringCharges;` with `summary,` / `summary: RecurringSummary;`
- replace `<RecurringChargesCard result={recurring} person={person} />` with `<RecurringChargesCard summary={summary} person={person} />`
- replace `insightsHref({ person: null, account: recurring.accountId })` with `insightsHref({ person: null, account: null })`
- replace the first `PageGuide` paragraph with:

```tsx
        <p>
          Two lists, both worked out from your own transactions. <strong className="font-semibold text-ink">Recurring charges</strong>{' '}
          counts the merchants that bill you on a rhythm. <strong className="font-semibold text-ink">See all recurring charges</strong>{' '}
          opens every one of them: pick a card under <strong className="font-semibold text-ink">Account</strong> to see everything
          that bills it — the list to work through when a card is replaced — and show <strong className="font-semibold text-ink">Late</strong>{' '}
          for the ones that have not charged since.
        </p>
```

- in the second `PageGuide` paragraph, replace `A new ledger shows little here for its first few months, because a rhythm takes three charges.` with `A new ledger shows little here for its first few months; Forming counts the merchants one charge away.`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/components/recurring-charges-card.test.tsx tests/app/insights-page.test.tsx tests/app/warranties-client.test.tsx tests/ops/client-bundle.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/insights/RecurringChargesCard.tsx "src/app/(app)/insights/page.tsx" "src/app/(app)/insights/insights-client.tsx" tests/components/recurring-charges-card.test.tsx tests/app/insights-page.test.tsx
git commit -m "feat(insights): Recurring charges card becomes a summary

- Known count, about a month, late link; Looks to review; Forming
- See all recurring charges opens the full page
- old /insights?account= links redirect to /insights/recurring"
```

---

### Task 5: The full page, `/insights/recurring` (spec §2.2, §2.3, §2.4)

**Files:**
- Modify: `src/components/ui/ListRow.tsx` (new optional `detail` prop)
- Create: `src/components/insights/RecurringRowActions.tsx` (`'use client'`)
- Create: `src/components/insights/RecurringFilters.tsx` (server-safe, no hooks)
- Create: `src/components/insights/RecurringTable.tsx` (server-safe, no hooks)
- Create: `src/app/(app)/insights/recurring/page.tsx`
- Modify: `scripts/smoke-routes.mjs` (`DEFAULT_PAGES`)
- Test: `tests/unit/list-row.test.tsx`, `tests/components/recurring-table.test.tsx` (new), `tests/app/recurring-page.test.tsx` (new), `tests/components/nav.test.ts`

**Interfaces:**
- Consumes (Task 1): `recurringCharges`, `RecurringChargeRow`, `RecurringAccount`. (Task 2): `readRecurringParams`, `recurringHref`, `insightsHref`, `RECURRING_SHOWS`, `RECURRING_SORTS`, `RecurringLinkScope`, `recurringRows`, `recurringRowActions`, `TIER_LABEL`, `SHOW_LABEL`, `SORT_LABEL`, `rhythmLabel`, `nextExpectedText`, `priceRiseText`, `dayLabel`.
- Produces: `ListRow` prop `detail?: React.ReactNode`; `RecurringRowActions({ row })`; `RecurringFilters({ accounts, scope })`; `RecurringTable({ rows, person, today })`; the route `/insights/recurring`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/list-row.test.tsx`, append inside `describe('ListRow', …)`:

```tsx
  /** Spec 2026-10-06 §2.2: the recurring page's phone rows need a line a reader sees whole. */
  it('prints a detail line under the meta, which wraps rather than truncating', () => {
    const { container } = renderRow(<ListRow title="MAPLE STREAMING" meta="Looks · Monthly" detail="expected Oct 12, nothing since" />);
    const detail = screen.getByText('expected Oct 12, nothing since');
    expect(detail.className).not.toContain('truncate');
    expect(container.textContent).toContain('Looks · Monthly');
  });
```

`tests/components/nav.test.ts`: add `activeNavItem` to the `@/components/app-shell/nav` import and append (a **pin**: `activeNavItem` already prefix-matches):

```ts
describe('activeNavItem on the recurring page (spec 2026-10-06 §2.2)', () => {
  it('keeps Insights lit on /insights/recurring, which has no nav entry of its own', () => {
    expect(activeNavItem('/insights/recurring')?.href).toBe('/insights');
    expect(NAV.map((item) => item.href)).not.toContain('/insights/recurring');
  });
});
```

Create `tests/components/recurring-table.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { RecurringTable } from '@/components/insights/RecurringTable';
import type { RecurringChargeRow } from '@/lib/recurring';

vi.mock('@/app/(app)/transactions/actions', () => ({ setRecurringMarkAction: vi.fn(async () => ({})) }));

afterEach(cleanup);

/** Spec 2026-10-06 §2.2–§2.4. Both trees render in jsdom (no media queries), so each test scopes to one. */
const TODAY = '2026-10-06';

function row(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'MAPLE STREAMING',
    tier: 'looks',
    knownBy: null,
    cadence: 'monthly',
    chargeCount: 7,
    typicalCents: 1349,
    lastAmountCents: 1349,
    lastDate: '2026-09-28',
    transactionId: 501,
    tracked: null,
    accounts: [{ id: 2, name: 'Travel Visa' }],
    nextExpected: '2026-10-28',
    late: false,
    monthlyCents: 1349,
    priceRise: null,
    ...over,
  };
}

const late = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', lastDate: '2026-08-01', nextExpected: '2026-08-31', late: true, transactionId: 610 });
const single = row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, monthlyCents: null, nextExpected: null, transactionId: 620 });
const table = () => within(document.querySelector('[data-recurring-table]') as HTMLElement);
const cards = () => within(document.querySelector('[data-recurring-cards]') as HTMLElement);

describe('RecurringTable', () => {
  it('renders each row in a phone list and in a wide table', () => {
    render(<RecurringTable rows={[row(), late]} person={null} today={TODAY} />);
    expect(document.querySelectorAll('[data-recurring-cards] > li')).toHaveLength(2);
    expect(table().getAllByRole('row')).toHaveLength(3);
  });

  /** Review Focus 5. */
  it('says Marked and an em dash for a merchant marked after one charge, with no next expected', () => {
    render(<RecurringTable rows={[single]} person={null} today={TODAY} />);
    const cells = table().getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toContain('Marked');
    expect(cells.filter((text) => text === '—')).toHaveLength(3);
  });

  /** Review Focus 1. */
  it('reads a late row as expected <day>, nothing since, tagged Late, in both layouts', () => {
    render(<RecurringTable rows={[late]} person={null} today={TODAY} />);
    expect(table().getByText('expected Aug 31, nothing since')).toBeTruthy();
    expect(table().getByText('Late')).toBeTruthy();
    expect(cards().getByText(/expected Aug 31, nothing since/)).toBeTruthy();
  });

  it('tags a price rise as up from A to B, and names the record that covers a merchant', () => {
    render(
      <RecurringTable
        rows={[row({ priceRise: { fromCents: 1349, toCents: 1599 }, tracked: { kind: 'item', itemId: 9, itemName: 'Maple plan' } })]}
        person={null}
        today={TODAY}
      />,
    );
    expect(table().getByText('up from $13.49 to $15.99')).toBeTruthy();
    expect(table().getByRole('link', { name: 'Maple plan' }).getAttribute('href')).toBe('/warranties/9');
  });

  it('gathers a Looks row’s actions in one menu: Mark recurring, Not recurring, Track', () => {
    render(<RecurringTable rows={[row()]} person={null} today={TODAY} />);
    fireEvent.click(table().getByRole('button', { name: 'Actions for MAPLE STREAMING' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Mark recurring', 'Not recurring', 'Track']);
  });

  it('offers a single Unmark button where that is the only action', () => {
    render(<RecurringTable rows={[row({ tier: 'known', knownBy: 'mark', tracked: { kind: 'rule', itemId: 4, itemName: 'Gym plan' } })]} person={null} today={TODAY} />);
    expect(table().getByRole('button', { name: 'Unmark MAPLE STREAMING' })).toBeTruthy();
  });

  it('drills into the merchant’s transactions, carrying the person scope', () => {
    render(<RecurringTable rows={[row()]} person={7} today={TODAY} />);
    expect(table().getByRole('link', { name: 'MAPLE STREAMING' }).getAttribute('href')).toBe('/transactions?person=7&q=MAPLE+STREAMING');
  });

  it('never says subscription, wasted, forgotten, cancel or missed payment', () => {
    const { container } = render(<RecurringTable rows={[row(), late, single]} person={null} today={TODAY} />);
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
```

Create `tests/app/recurring-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { addDaysIso, dayLabel, todayIso } from '@/lib/dates';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * Spec 2026-10-06 §2.2–§2.4. The real page against a real database. Dates are day offsets from
 * today (the page reads the clock); no month boundary is involved.
 */
const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('RecurringChargesPage', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  async function seed() {
    t = createTestDb();
    const adult = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Robin', username: 'robin', password: 'correct horse battery', role: 'member' });
    const chequing = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: adult.id });
    const visa = createAccount({ name: 'Travel Visa', type: 'credit', ownerUserId: adult.id });
    const spend = (input: { merchant: string; daysAgo: number; cents: number; person: number; accountId?: number }) =>
      createManualTransaction({
        accountId: input.accountId ?? chequing,
        date: addDaysIso(today, -input.daysAgo),
        description: input.merchant,
        amountCents: -input.cents,
        categoryId: null,
        attributedUserId: input.person,
        userId: adult.id,
        actorRole: 'admin',
      });
    return { adult: adult.id, child: child.id, chequing, visa, spend };
  }

  /** Looks: MAPLE STREAMING. Known, late, on Travel Visa: RIVERSIDE GYM. Forming: HARBOUR INSURANCE. */
  async function seedThreeTiers() {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'MAPLE STREAMING', daysAgo, cents: 1349, person: s.adult });
    for (const daysAgo of [100, 70]) s.spend({ merchant: 'RIVERSIDE GYM', daysAgo, cents: 4500, person: s.adult, accountId: s.visa });
    for (const daysAgo of [33, 3]) s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo, cents: 13400, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    return s;
  }

  async function renderPage(searchParams: Record<string, string> = {}) {
    const { default: RecurringChargesPage } = await import('@/app/(app)/insights/recurring/page');
    return render(await RecurringChargesPage({ searchParams: Promise.resolve(searchParams) }));
  }

  const table = () => within(document.querySelector('[data-recurring-table]') as HTMLElement);
  const merchantsInTable = () =>
    table()
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.querySelector('a')?.textContent);

  it('lists every tier in one table, with the tier, rhythm and monthly figure', async () => {
    await seedThreeTiers();
    await renderPage();
    expect(merchantsInTable()).toEqual(['HARBOUR INSURANCE', 'RIVERSIDE GYM', 'MAPLE STREAMING']);
    expect(table().getByText('Known')).toBeTruthy();
    expect(table().getByText('Looks')).toBeTruthy();
    expect(table().getByText('Forming')).toBeTruthy();
    expect(table().getAllByText('$134.00').length).toBeGreaterThan(0);
  });

  /** Review Focus 1. */
  it('Show Late on the replaced card lists the marked merchant that went quiet', async () => {
    const s = await seedThreeTiers();
    await renderPage({ account: String(s.visa), show: 'late' });
    expect(merchantsInTable()).toEqual(['RIVERSIDE GYM']);
    expect(table().getByText(`expected ${dayLabel(addDaysIso(today, -40), today)}, nothing since`)).toBeTruthy();
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe(String(s.visa));
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('late');
  });

  it('sorts by next expected, late first', async () => {
    await seedThreeTiers();
    await renderPage({ sort: 'next' });
    expect(merchantsInTable()[0]).toBe('RIVERSIDE GYM');
  });

  /** Review Focus 3. */
  it('reads a malformed query as the defaults', async () => {
    await seedThreeTiers();
    await renderPage({ show: 'everything', sort: 'drop', account: 'abc', person: 'x' });
    expect(merchantsInTable()).toHaveLength(3);
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('all');
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('monthly');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  /** Review Focus 4. */
  it('a self viewer sees only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'MAPLE STREAMING', daysAgo, cents: 1349, person: s.adult });
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ person: String(s.adult) });
    expect(merchantsInTable()).toEqual(['CEDAR PHONE CO']);
  });

  /** Review Focus 4. */
  it('ignores an account the viewer cannot see', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ account: String(s.visa) });
    expect(merchantsInTable()).toEqual(['CEDAR PHONE CO']);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  it('says whose charges a household viewer is looking at, with the way back', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ person: String(s.child), show: 'looks' });
    expect(container.textContent).toMatch(/Recurring charges here are Robin/);
    expect(screen.getByRole('link', { name: 'Show the whole household' }).getAttribute('href')).toBe('/insights/recurring?show=looks');
  });

  it('says so when nothing charges on a rhythm yet, and never uses the banned words', async () => {
    await seed();
    currentUser.value = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('Nothing charges on a rhythm yet.');
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
```

Fails before / passes after: `ListRow` ignores `detail`, and the components and the route do not exist until Steps 3–6. The nav test is a **pin**.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/list-row.test.tsx tests/components/recurring-table.test.tsx tests/app/recurring-page.test.tsx tests/components/nav.test.ts`
Expected: FAIL (nav pin passes).

- [ ] **Step 3: `ListRow.detail`**

In `src/components/ui/ListRow.tsx`, add to the destructured props (after `meta,`) `detail,`; to the prop types, after `meta?: React.ReactNode;`:

```ts
  /**
   * Spec 2026-10-06 §2.2. A second small line under `meta` that WRAPS instead of truncating -- for a
   * sentence or a few tags a reader has to see whole on a phone (the recurring page's late line).
   */
  detail?: React.ReactNode;
```

and after `{meta ? <p className="truncate text-xs text-subtle">{meta}</p> : null}`:

```tsx
        {detail ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">{detail}</div> : null}
```

- [ ] **Step 4: `RecurringRowActions.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { FormError } from '@/components/FormError';
import { RecurringMarkForm } from '@/components/insights/RecurringMarkForm';
import { buttonClass } from '@/components/ui/Button';
import { RowMenu, RowMenuForm, RowMenuLink } from '@/components/ui/RowMenu';
// Type-only, so @/lib/recurring (which imports @/db) never becomes a bundle edge.
import type { RecurringChargeRow } from '@/lib/recurring';
import { recurringRowActions } from '@/lib/recurring-view';
// RELATIVE, like RecurringMarkForm.tsx: the client-bundle guard walks only @/ value imports.
import { setRecurringMarkAction, type ActionState } from '../../app/(app)/transactions/actions';

const initial: ActionState = {};

/**
 * Spec 2026-10-06 §2.2. A row's actions on the recurring page, the same in the table and the phone
 * list. Ruling R2's kebab rule: one action is a button, two or more are a RowMenu. A mark posts the
 * merchant's newest charge, so setRecurringMarkAction checks that row against the viewer.
 */
export function RecurringRowActions({ row }: { row: RecurringChargeRow }) {
  const [state, dispatch] = useActionState(setRecurringMarkAction, initial);
  const actions = recurringRowActions(row);
  if (actions.length === 1) {
    const only = actions[0];
    return only.kind === 'mark' ? (
      <RecurringMarkForm transactionId={row.transactionId} mark={only.mark} label={only.label} ariaLabel={only.ariaLabel} />
    ) : (
      <Link href={only.href} className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        {only.label}
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <RowMenu label={`Actions for ${row.merchant}`}>
        {actions.map((action) =>
          action.kind === 'mark' ? (
            <RowMenuForm key={action.mark} action={dispatch} fields={{ transactionId: String(row.transactionId), mark: action.mark }}>
              {action.label}
            </RowMenuForm>
          ) : (
            <RowMenuLink key={action.href} href={action.href}>
              {action.label}
            </RowMenuLink>
          ),
        )}
      </RowMenu>
      <FormError message={state.error} />
    </div>
  );
}
```

- [ ] **Step 5: `RecurringFilters.tsx` and `RecurringTable.tsx`**

`src/components/insights/RecurringFilters.tsx`:

```tsx
import { buttonClass } from '@/components/ui/Button';
import { labelClass, selectClass } from '@/components/ui/form';
import { RECURRING_SHOWS, RECURRING_SORTS, type RecurringLinkScope } from '@/lib/insights-links';
import type { RecurringAccount } from '@/lib/recurring';
import { SHOW_LABEL, SORT_LABEL } from '@/lib/recurring-view';

/**
 * Spec 2026-10-06 §2.2. A plain GET form: the choices are the page address, so a filtered list can be
 * bookmarked or sent. Each label wraps its select (no useId, so this renders on the server). Lives in
 * src/components, beside the other Insights pieces: it is a filter, not a row control
 * (tests/ops/row-controls.test.ts).
 */
export function RecurringFilters({ accounts, scope }: { accounts: RecurringAccount[]; scope: RecurringLinkScope }) {
  return (
    <form method="get" action="/insights/recurring" className="flex flex-wrap items-end gap-3">
      {scope.person === null ? null : <input type="hidden" name="person" value={String(scope.person)} />}
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Account</span>
        <select name="account" defaultValue={scope.account === null ? '' : String(scope.account)} className={selectClass}>
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Show</span>
        <select name="show" defaultValue={scope.show} className={selectClass}>
          {RECURRING_SHOWS.map((value) => (
            <option key={value} value={value}>
              {SHOW_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Sort</span>
        <select name="sort" defaultValue={scope.sort} className={selectClass}>
          {RECURRING_SORTS.map((value) => (
            <option key={value} value={value}>
              {SORT_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={buttonClass('secondary', 'sm', 'min-h-11 sm:min-h-0')}>
        Apply
      </button>
    </form>
  );
}
```

`src/components/insights/RecurringTable.tsx`:

```tsx
import Link from 'next/link';
import { RecurringRowActions } from '@/components/insights/RecurringRowActions';
import { ListRow } from '@/components/ui/ListRow';
import { TableWrap } from '@/components/ui/Table';
import { dayLabel } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import type { RecurringChargeRow, RecurringTier } from '@/lib/recurring';
import { nextExpectedText, priceRiseText, rhythmLabel, TIER_LABEL } from '@/lib/recurring-view';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';

const TIER_BADGE: Record<RecurringTier, string> = { known: 'badge badge--accent', looks: 'badge badge--slate', forming: 'badge badge--muted' };

const money = (cents: number | null) => (cents === null ? '—' : formatCents(cents));

/** Late, the price rise, and the record that covers the merchant -- measured facts, no verdicts (spec §2.7). */
function Tags({ row }: { row: RecurringChargeRow }) {
  const rise = priceRiseText(row);
  if (!row.late && rise === null && row.tracked === null) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {row.late ? <span className="badge badge--red">Late</span> : null}
      {rise === null ? null : <span className="badge badge--amber">{rise}</span>}
      {row.tracked === null ? null : (
        <Link href={`/warranties/${row.tracked.itemId}`} className="badge badge--green hover:underline">
          {row.tracked.itemName}
        </Link>
      )}
    </span>
  );
}

/**
 * Spec 2026-10-06 §2.2. Laid out like Transactions: a list of ListRows on a phone and a table from
 * `sm` up. A real browser shows one of the two; jsdom shows both, so tests scope to
 * data-recurring-cards or data-recurring-table. One row per merchant, every tier, no cap.
 */
export function RecurringTable({ rows, person, today }: { rows: RecurringChargeRow[]; person: number | null; today: string }) {
  const merchantLink = (row: RecurringChargeRow) => (
    <Link href={transactionsHref({ range: null, person }, { kind: 'merchant', merchant: row.merchant })} className="font-medium text-ink hover:text-accent-text">
      {row.merchant}
    </Link>
  );
  return (
    <>
      <ul className="border-t border-line sm:hidden" data-recurring-cards>
        {rows.map((row) => (
          <ListRow
            key={row.merchant}
            title={merchantLink(row)}
            meta={`${TIER_LABEL[row.tier]} · ${rhythmLabel(row)} · ${row.accounts.map((account) => account.name).join(', ')}`}
            detail={
              <>
                <span>Last {dayLabel(row.lastDate, today)}</span>
                {row.nextExpected === null ? null : <span>{row.late ? nextExpectedText(row, today) : `next ${nextExpectedText(row, today)}`}</span>}
                <Tags row={row} />
              </>
            }
            amount={row.monthlyCents === null ? '—' : `${formatCents(row.monthlyCents)}/mo`}
            trailing={<RecurringRowActions row={row} />}
          />
        ))}
      </ul>
      <div className="hidden sm:block" data-recurring-table>
        <TableWrap bare>
          <thead>
            <tr>
              <th scope="col">Merchant</th>
              <th scope="col">Tier</th>
              <th scope="col">Rhythm</th>
              <th scope="col" className="text-right">Typical</th>
              <th scope="col" className="text-right">Monthly</th>
              <th scope="col">Last charge</th>
              <th scope="col">Next expected</th>
              <th scope="col">Accounts</th>
              <th scope="col">Tags</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.merchant}>
                <td>
                  {merchantLink(row)}
                  <div className="text-xs text-subtle">
                    {row.chargeCount} {row.chargeCount === 1 ? 'charge' : 'charges'}
                  </div>
                </td>
                <td>
                  <span className={TIER_BADGE[row.tier]}>{TIER_LABEL[row.tier]}</span>
                </td>
                <td>{rhythmLabel(row)}</td>
                <td className="tabnum text-right">{money(row.typicalCents)}</td>
                <td className="tabnum text-right">{money(row.monthlyCents)}</td>
                <td className="tabnum whitespace-nowrap text-muted">{dayLabel(row.lastDate, today)}</td>
                <td className={row.late ? 'text-danger' : 'text-muted'}>{nextExpectedText(row, today)}</td>
                <td className="text-muted">{row.accounts.map((account) => account.name).join(', ')}</td>
                <td>
                  <Tags row={row} />
                </td>
                <td>
                  <RecurringRowActions row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </>
  );
}
```

(The single-charge row's cells hold `—` in Typical, Monthly and Next expected — the three em dashes the test counts. If `TableWrap` without `responsive` renders anything different from a plain `<table>`, read `src/components/ui/Table.tsx` first; it must not be passed `responsive` or `fixed`.)

- [ ] **Step 6: The route**

Create `src/app/(app)/insights/recurring/page.tsx`:

```tsx
import Link from 'next/link';
import { RecurringFilters } from '@/components/insights/RecurringFilters';
import { RecurringTable } from '@/components/insights/RecurringTable';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { findUserById } from '@/lib/auth/users';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { todayIso } from '@/lib/dates';
import { insightsHref, readRecurringParams, recurringHref, type RecurringLinkScope } from '@/lib/insights-links';
import { RECURRING_LATE_GRACE_DAYS } from '@/lib/predict/constants';
import { recurringCharges } from '@/lib/recurring';
import { recurringRows } from '@/lib/recurring-view';

export const dynamic = 'force-dynamic';

/**
 * Spec 2026-10-06 §2.2–§2.4. Every merchant on a rhythm, in every tier, with no row cap. No nav entry
 * of its own: activeNavItem keeps Insights lit, and insights/loading.tsx is its skeleton (this page
 * never calls notFound(), tests/ops/loading-boundaries.test.ts). The person scope follows ruling R2's
 * S-01 order; the Account filter accepts only an account named on a listed row (the read model
 * decides); Show and Sort are read from fixed lists, anything else as the default.
 */
export default async function RecurringChargesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const asked = readRecurringParams(await searchParams);
  const today = todayIso();
  const selfScoped = isSelfScoped(viewer);
  const person = ownerScope(viewer) ?? asked.person;
  const result = recurringCharges({ today, ownerUserId: person, viewer, accountId: asked.account });
  // The filter the read model actually applied, so the select and every link agree with the rows.
  const scope: RecurringLinkScope = { person, account: result.accountId, show: asked.show, sort: asked.sort };
  const rows = recurringRows(result, scope);
  const total = result.known.length + result.looks.length + result.forming.length;
  const personName = selfScoped || person === null ? null : (findUserById(person)?.name ?? null);
  return (
    <div data-page-width="wide" className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        title="Recurring charges"
        description="Every merchant that bills on a rhythm: what it usually costs, about how much that is a month, when it last charged and when its rhythm says the next charge is expected."
        actions={
          <Link href={insightsHref({ person: selfScoped ? null : person, account: null })} className={buttonClass('secondary', 'sm')}>
            All insights
          </Link>
        }
      />

      {personName === null ? null : (
        <Notice tone="info">
          Recurring charges here are {personName}&rsquo;s.{' '}
          <Link href={recurringHref({ ...scope, person: null })} className="font-medium text-accent-text underline underline-offset-2">
            Show the whole household
          </Link>
        </Notice>
      )}

      <Card>
        <CardHeader
          title={`${rows.length} of ${total} ${total === 1 ? 'merchant' : 'merchants'}`}
          description="Known recurring is what you said: a merchant you marked, or one an item covers. Looks recurring is what the dates show. Forming is two charges about a month or a year apart, one short of a rhythm."
        />
        <CardBody padded={false}>
          <div className="border-b border-line px-4 pb-4 sm:px-5">
            <RecurringFilters accounts={result.accounts} scope={scope} />
          </div>
          {rows.length > 0 ? (
            <RecurringTable rows={rows} person={person} today={today} />
          ) : (
            <p className="px-4 py-4 text-sm text-muted sm:px-5">
              {total === 0
                ? 'Nothing charges on a rhythm yet. A merchant appears here after two charges about a month or a year apart, or as soon as you mark it recurring from its row menu on Transactions.'
                : 'Nothing here matches these choices. Show All, or pick All accounts.'}
            </p>
          )}
          {rows.some((row) => row.late) ? (
            <p className="border-t border-line px-4 py-3 text-sm text-muted sm:px-5">
              Late: a merchant you marked or track whose next charge is more than {RECURRING_LATE_GRACE_DAYS} days past the date its
              rhythm gives, with nothing since. After a card is replaced, pick it under Account and show Late: these are the merchants
              that charged that card and have gone quiet.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
```

`scripts/smoke-routes.mjs`: in `DEFAULT_PAGES`, after `'/insights',` add `'/insights/recurring',`, and raise the leading comment's page-route count by one.

- [ ] **Step 7: Run the tests and the guards that scan the new files**

Run: `npx vitest run tests/unit/list-row.test.tsx tests/components/recurring-table.test.tsx tests/app/recurring-page.test.tsx tests/components/nav.test.ts`
Expected: PASS.

Run: `npx vitest run tests/ops/client-bundle.test.ts tests/ops/th-scope.test.ts tests/ops/title-only-info.test.ts tests/ops/table-layout.test.ts tests/ops/button-vocabulary.test.ts tests/ops/row-controls.test.ts tests/ops/transactions-href.test.ts tests/ops/type-scale.test.ts tests/ops/onboarding-coverage.test.ts tests/ops/loading-boundaries.test.ts tests/ops/reduced-motion.test.ts tests/ops/docker.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/ListRow.tsx src/components/insights/RecurringRowActions.tsx src/components/insights/RecurringFilters.tsx src/components/insights/RecurringTable.tsx "src/app/(app)/insights/recurring/page.tsx" scripts/smoke-routes.mjs tests/unit/list-row.test.tsx tests/components/recurring-table.test.tsx tests/app/recurring-page.test.tsx tests/components/nav.test.ts
git commit -m "feat(insights): the full recurring charges page

- /insights/recurring: every tier, no cap; Account, Show, Sort in the URL
- next expected, late, price rise and record tags; table and phone list
- row actions by state in one menu; ListRow gains a wrapping detail line"
```

---

### Task 6: Expected charges in Coming up (spec §2.6)

**Files:**
- Modify: `src/components/ComingUpCard.tsx` (whole file)
- Modify: `src/app/(app)/dashboard/page.tsx` (import :19, `bills` :237, `ComingUpCard` :719-727)
- Test: `tests/components/ComingUpCard.test.tsx`, `tests/app/dashboard.test.tsx`

**Interfaces:**
- Consumes (Task 1): `ExpectedCharge`, `expectedRecurringCharges`. (Task 2): `recurringHref`.
- Produces: `ComingUpCard` prop `expected?: ExpectedCharge[]` (default `[]`); `COMING_UP_EXPECTED_NOTE` (exported string).

- [ ] **Step 1: Write the failing card tests**

In `tests/components/ComingUpCard.test.tsx`, change the first import to `import { ComingUpCard, COMING_UP_EXPECTED_NOTE, COMING_UP_OVERDUE_DAYS, COMING_UP_ROW_LIMIT } from '@/components/ComingUpCard';`, add `import type { ExpectedCharge } from '@/lib/recurring';` and `import { addDaysIso } from '@/lib/dates';`, and append:

```tsx
/** Spec 2026-10-06 §2.6. Marked merchants' next charges, beside the bills and never in a total. */
describe('ComingUpCard expected recurring charges', () => {
  const today = '2026-08-16';
  const base = { budgetedRemainingCents: 50_000, billsDueCents: 7_700, hasBudgetedLimits: false, monthEndDate: '2026-08-31', canRecord: true, today };
  const charge = (over: Partial<ExpectedCharge> = {}): ExpectedCharge => ({
    merchant: 'CEDAR PHONE CO',
    expectedDate: '2026-08-26',
    typicalCents: 90_000,
    late: false,
    accountName: 'Travel Visa',
    ...over,
  });
  const bill: UpcomingBill = { itemId: 1, name: 'Streaming', kind: 'subscription', dueDate: '2026-08-26', amountCents: 7700, installmentId: 41, overdue: false };
  const titles = (container: HTMLElement) => Array.from(container.querySelectorAll('li p:first-child')).map((p) => p.textContent);

  it('lists an expected charge, tagged Expected, about its typical amount, with no Record payment button', () => {
    const { container } = render(<ComingUpCard {...base} bills={[]} expected={[charge()]} />);
    expect(screen.getByText('CEDAR PHONE CO')).toBeTruthy();
    expect(screen.getByText('Expected')).toBeTruthy();
    expect(screen.getByText('about $900.00')).toBeTruthy();
    expect(container.textContent).toContain('Travel Visa');
    expect(screen.queryByRole('button', { name: /record payment/i })).toBeNull();
  });

  /** Review Focus 2 -- a pin: the total never read `expected`, and must not start to. */
  it('keeps expected charges out of the header total', () => {
    const { container } = render(<ComingUpCard {...base} bills={[bill]} expected={[charge()]} />);
    expect(container.querySelector('[aria-label="Total due $77.00"]')).toBeTruthy();
  });

  it('shows the card for expected charges alone, with no total', () => {
    const { container } = render(<ComingUpCard {...base} bills={[]} expected={[charge()]} />);
    expect(screen.getByText('Coming up')).toBeTruthy();
    expect(container.querySelector('[aria-label^="Total due"]')).toBeNull();
  });

  it('sorts a bill before an expected charge on the same date, and caps both kinds together', () => {
    const many = Array.from({ length: COMING_UP_ROW_LIMIT }, (_unused, index) =>
      charge({ merchant: `MERCHANT ${index}`, expectedDate: addDaysIso('2026-08-27', index) }),
    );
    const { container } = render(<ComingUpCard {...base} bills={[bill]} expected={[charge(), ...many]} />);
    const shown = titles(container);
    expect(shown.slice(0, 2)).toEqual(['Streaming', 'CEDAR PHONE CO']);
    expect(shown.filter((title) => title !== null && !title.startsWith('+'))).toHaveLength(COMING_UP_ROW_LIMIT);
    expect(screen.getByRole('link', { name: '+2 more expected' }).getAttribute('href')).toBe('/insights/recurring?show=known&sort=next');
  });

  it('says expected rows are estimates outside the totals, only when one is shown', () => {
    render(<ComingUpCard {...base} bills={[bill]} expected={[charge()]} />);
    expect(screen.getByText(COMING_UP_EXPECTED_NOTE)).toBeTruthy();
    cleanup();
    render(<ComingUpCard {...base} bills={[bill]} />);
    expect(screen.queryByText(COMING_UP_EXPECTED_NOTE)).toBeNull();
  });

  it('reads a past expected date as nothing since, and drops one older than COMING_UP_OVERDUE_DAYS', () => {
    render(
      <ComingUpCard
        {...base}
        bills={[]}
        expected={[
          charge({ merchant: 'RIVERSIDE GYM', expectedDate: addDaysIso(today, -20), late: true }),
          charge({ merchant: 'HARBOUR INSURANCE', expectedDate: addDaysIso(today, -COMING_UP_OVERDUE_DAYS - 1), late: true }),
        ]}
      />,
    );
    expect(screen.getByText('RIVERSIDE GYM')).toBeTruthy();
    expect(screen.getByText('nothing since')).toBeTruthy();
    expect(screen.queryByText('HARBOUR INSURANCE')).toBeNull();
  });

  it('never says missed payment, subscription or cancel about an expected row', () => {
    const { container } = render(<ComingUpCard {...base} bills={[]} expected={[charge({ expectedDate: addDaysIso(today, -20), late: true })]} />);
    expect(container.textContent).not.toMatch(/missed payment|subscription|cancel|wasted|forgotten/i);
  });
});
```

Notes for the implementer: `ListRow` renders the title in the first `<p>` of each `<li>`; the "+N more" items are plain `<li>`s whose first `<p>` does not exist (their link sits directly in the `<li>`), which is why `titles` keeps them out — if the selector also catches them, filter on `startsWith('+')` as written. `cleanup` and `addDaysIso` must be imported in this file (`cleanup` already is).

Fails before / passes after: the card ignores `expected` (no row, the card hides with no bills, no note, no "+N more expected") until Step 3. The header-total test is a **pin**.

- [ ] **Step 2: Write the failing dashboard test**

In `tests/app/dashboard.test.tsx`, add `within` to the `@testing-library/react` import, add `import { setRecurringMarks } from '@/lib/categorize/rules';` and `import { COMING_UP_EXPECTED_NOTE } from '@/components/ComingUpCard';`, and append:

```tsx
/** Spec 2026-10-06 §2.6. Review Focus 2. */
describe('DashboardPage — Coming up lists expected recurring charges', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists a marked merchant’s next charge, tagged Expected, and keeps it out of every total', async () => {
    t = createTestDb();
    const adult = await createUser({ name: 'Adult', username: 'adult', password: 'correct horse battery', role: 'admin' });
    const accountId = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: adult.id });
    const today = todayIso();
    // Thirty days apart, the newer twenty days ago: next expected is ten days out, whatever the month.
    for (const daysAgo of [50, 20]) {
      createManualTransaction({
        accountId,
        date: addDaysIso(today, -daysAgo),
        description: 'CEDAR PHONE CO',
        amountCents: -6200,
        categoryId: null,
        attributedUserId: adult.id,
        userId: adult.id,
        actorRole: 'admin',
      });
    }
    setRecurringMarks({ merchants: ['CEDAR PHONE CO'], mark: 'recurring', userId: adult.id, actorRole: 'admin' });
    currentUser.value = { id: adult.id, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };

    const { default: DashboardPage } = await import('@/app/(app)/dashboard/page');
    render(await DashboardPage({ searchParams: Promise.resolve({}) }));
    const card = screen.getByRole('heading', { name: 'Coming up' }).closest('section') as HTMLElement;
    const inCard = within(card);
    expect(inCard.getByText('CEDAR PHONE CO')).toBeTruthy();
    expect(inCard.getByText('Expected')).toBeTruthy();
    expect(inCard.getByText('about $62.00')).toBeTruthy();
    expect(inCard.getByText(COMING_UP_EXPECTED_NOTE)).toBeTruthy();
    // No bill: no header total, and safeToSpend's billsDueCents stays at nothing.
    expect(card.querySelector('[aria-label^="Total due"]')).toBeNull();
    expect(card.textContent).toMatch(/nothing more due before/);
  });
});
```

Fails before / passes after: the Dashboard never computes expected charges, so with no bill and no budget the card is absent until Step 4.

- [ ] **Step 3: The card**

Replace `src/components/ComingUpCard.tsx` with the following. Every existing comment is kept; the new code is marked `Spec 2026-10-06 §2.6`.

```tsx
import Link from 'next/link';
import { daysBetweenIso } from '@/lib/dates';
import { recurringHref } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
import type { UpcomingBill } from '@/lib/bills';
import type { ExpectedCharge } from '@/lib/recurring';
// Every /transactions link in this app is built here (F-01).
import { transactionsHref } from '@/lib/transaction-links';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { DaysRemainingPill } from '@/components/ui/DaysRemainingPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListRow } from '@/components/ui/ListRow';
import { RecordPaymentForm } from '@/components/RecordPaymentForm';
import { buttonClass } from '@/components/ui/Button';

/**
 * Item P (ruling P9). The notification evaluator has had a flood guard since v1.4
 * (MAX_NEW_ROWS_PER_USER_PER_EVALUATION, notify/evaluate/coming-due.ts:18); this card had
 * nothing, so a household several bills behind got a wall of rows instead of a card.
 */
export const COMING_UP_ROW_LIMIT = 8;

/**
 * And nothing bounded the other end: with includeOverdue, an installment from years ago was
 * exactly as eligible as one from last week. Most-overdue-first with a cutoff, not literally
 * everything ever missed.
 */
export const COMING_UP_OVERDUE_DAYS = 90;

/** Spec 2026-10-06 §2.6, the line under the list whenever an expected row is shown. */
export const COMING_UP_EXPECTED_NOTE = 'Expected charges are estimates from past charges and are not in the totals above.';

/**
 * Spec 2026-10-06 §2.6. What the list renders, built AFTER the totals. The two kinds are separate
 * props of separate types, so the header total (bills only) and safeToSpend's billsDueCents (which
 * never sees this card's input) cannot include an expected charge by accident: a recurring charge
 * is usually already inside a category budget, and subtracting it again would count it twice.
 */
type ComingUpEntry = { kind: 'bill'; date: string; bill: UpcomingBill } | { kind: 'expected'; date: string; charge: ExpectedCharge };

/**
 * Task 9 (spec 2026-08-22, v1.7.0): SELF-HIDING, in the manner of LoansCard -- the dashboard
 * renders it unconditionally, and it is absent when there is nothing to say (no bills coming
 * up AND no budgeted limits at all this month). Spec 2026-10-06 §2.6: expected rows alone are
 * enough to show it.
 *
 * The list total (header) and the footer sentence's "bills still to come" figure are
 * deliberately different numbers when they differ: the list is a fixed 30-day lookahead, a
 * simple "what's coming soon" convenience view, while `billsDueCents` (from safeToSpend) is
 * scoped to the END OF THIS MONTH -- the number that actually answers "is what's left in my
 * budget enough to cover what the rest of this month still owes." They usually land close
 * together, but they are not required to match.
 *
 * Task 1 (spec 2026-08-23, v1.8.0, ruling R8): the two windows are staying different, so the
 * fix is naming them rather than reconciling them. The footer now says "before <month end>"
 * so it reads as its own, narrower window instead of contradicting the header's 30-day total.
 */
export function ComingUpCard({
  bills,
  expected = [],
  budgetedRemainingCents,
  billsDueCents,
  hasBudgetedLimits,
  monthEndDate,
  canRecord,
  today,
}: {
  /** Already filtered by the caller to a fixed lookahead window (the next 30 days). */
  bills: UpcomingBill[];
  /**
   * Spec 2026-10-06 §2.6. Marked merchants' next charges (expectedRecurringCharges), the same 30-day
   * lookahead. Listed beside the bills, never in a total.
   */
  expected?: ExpectedCharge[];
  budgetedRemainingCents: number;
  /** Bills due on or before the end of the current month (safeToSpend's own window). */
  billsDueCents: number;
  hasBudgetedLimits: boolean;
  /** ISO YYYY-MM-DD, the same month end safeToSpend scoped billsDueCents to. Display only --
   *  this component formats it, it does not derive a month end client-side. */
  monthEndDate: string;
  /**
   * v1.13.0 ruling R8: false for a self viewer with no account they can post to, true otherwise
   * (Task 13 computes it -- this card does not re-derive account eligibility itself).
   */
  canRecord: boolean;
  /** Item P: the reference date for COMING_UP_OVERDUE_DAYS. The dashboard already has it. */
  today: string;
}) {
  const withinBound = bills.filter(
    (b) => !b.overdue || daysBetweenIso(b.dueDate, today) <= COMING_UP_OVERDUE_DAYS,
  );
  // Spec 2026-10-06 §2.6: the same overdue bound, applied to a late expected charge.
  const expectedWithinBound = expected.filter((charge) => daysBetweenIso(charge.expectedDate, today) <= COMING_UP_OVERDUE_DAYS);
  if (withinBound.length === 0 && expectedWithinBound.length === 0 && !hasBudgetedLimits) return null;

  // Bills only, by construction: `expected` is a different type with no amountCents (spec 2026-10-06 §2.6).
  const listTotalCents = withinBound.reduce((sum, bill) => sum + bill.amountCents, 0);
  const hasOverdue = withinBound.some((bill) => bill.overdue);
  // One list, by date; on the same date a bill sorts before an expected charge. The cap covers both.
  const entries: ComingUpEntry[] = [
    ...withinBound.map((bill) => ({ kind: 'bill' as const, date: bill.dueDate, bill })),
    ...expectedWithinBound.map((charge) => ({ kind: 'expected' as const, date: charge.expectedDate, charge })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'bill' ? -1 : 1));
  const shown = entries.slice(0, COMING_UP_ROW_LIMIT);
  const hiddenBills = withinBound.length - shown.filter((entry) => entry.kind === 'bill').length;
  const hiddenExpected = expectedWithinBound.length - shown.filter((entry) => entry.kind === 'expected').length;
  const showsExpected = shown.some((entry) => entry.kind === 'expected');
  const budgetPhrase = hasBudgetedLimits
    ? `Budgets have ${formatCents(budgetedRemainingCents)} left this month`
    : 'No category limits set yet';
  const cutoff = new Date(`${monthEndDate}T00:00:00`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
  });
  const billsPhrase =
    billsDueCents === 0
      ? `nothing more due before ${cutoff}`
      : `${formatCents(billsDueCents)} of that falls before ${cutoff}`;

  return (
    <Card>
      <CardHeader
        title="Coming up"
        description={
          hasOverdue
            ? // Review B fix round (item 4): the bare "and anything overdue" overpromised -- a
              // bill overdue by more than COMING_UP_OVERDUE_DAYS is dropped from this card
              // entirely (see withinBound above), so the clause now names the actual bound
              // rather than reading as "every overdue bill, no matter how old".
              'Bills due in the next 30 days, and anything overdue in the last 90 days.'
            : 'Bills due in the next 30 days.'
        }
        action={
          withinBound.length > 0 ? (
            <span className="money-lg" aria-label={`Total due ${formatCents(listTotalCents)}`}>
              {formatCents(listTotalCents)}
            </span>
          ) : null
        }
      />
      {withinBound.length === 0 && expectedWithinBound.length === 0 ? (
        <CardBody>
          {/* [keep the existing long EmptyState comment here, unchanged] */}
          <EmptyState
            size="compact"
            title={
              bills.length > 0 ? (
                <>
                  Nothing due in the next 30 days. Older overdue bills are on the{' '}
                  <Link href="/warranties" className="font-medium text-accent-text">
                    Loans &amp; Coverage page
                  </Link>
                  .
                </>
              ) : (
                'No bills due in the next 30 days.'
              )
            }
            action={
              bills.length > 0 ? (
                <Link href="/warranties" className={buttonClass('secondary', 'sm')}>
                  View bills
                </Link>
              ) : (
                <Link href="/warranties/new" className={buttonClass('primary', 'sm')}>
                  Add a bill
                </Link>
              )
            }
          />
        </CardBody>
      ) : (
        <>
          <ul className="border-t border-line text-sm">
            {/* [keep the existing "Ruling D1: ListRow (Lane 0)" comment here, unchanged] */}
            {shown.map((entry) => {
              if (entry.kind === 'expected') {
                const { charge } = entry;
                // Spec 2026-10-06 §2.6: tagged Expected, "about" its typical charge, no Record payment
                // (it is not an installment). A past date reads "nothing since" -- a fact, not a verdict.
                return (
                  <ListRow
                    key={`expected-${charge.merchant}`}
                    title={
                      <Link
                        href={transactionsHref({ range: null, person: null }, { kind: 'merchant', merchant: charge.merchant })}
                        className="hover:text-accent-text"
                      >
                        {charge.merchant}
                      </Link>
                    }
                    meta={
                      <>
                        <span className={charge.late ? 'text-danger' : undefined}>{charge.expectedDate}</span>{' '}
                        <span className="badge badge--slate">Expected</span>{' '}
                        {charge.expectedDate >= today ? (
                          <DaysRemainingPill days={daysBetweenIso(today, charge.expectedDate)} />
                        ) : (
                          <span className={charge.late ? 'text-danger' : undefined}>nothing since</span>
                        )}
                        {charge.accountName === '' ? null : <> · {charge.accountName}</>}
                      </>
                    }
                    amount={`about ${formatCents(charge.typicalCents)}`}
                  />
                );
              }
              const { bill } = entry;
              const pill = bill.overdue ? null : <DaysRemainingPill days={daysBetweenIso(today, bill.dueDate)} />;
              return (
                <ListRow
                  // [keep the existing v1.12.0 key comment here, unchanged]
                  key={bill.installmentId === null ? `item-${bill.itemId}` : `installment-${bill.installmentId}`}
                  title={bill.name}
                  meta={
                    <>
                      <span className={bill.overdue ? 'text-danger' : undefined}>{bill.dueDate}</span>{' '}
                      {bill.overdue ? <span className="badge badge--red">Overdue</span> : pill}
                    </>
                  }
                  amount={formatCents(bill.amountCents)}
                  trailing={
                    // [keep the existing Ruling R8 comment here, unchanged]
                    canRecord && bill.installmentId !== null ? (
                      <RecordPaymentForm installmentId={bill.installmentId} />
                    ) : undefined
                  }
                />
              );
            })}
            {hiddenBills > 0 ? (
              <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
                {/* [keep the existing Ruling P10 comment here, unchanged] */}
                <Link href="/warranties" className="text-sm font-medium text-accent-text">
                  +{hiddenBills} more due
                </Link>
              </li>
            ) : null}
            {hiddenExpected > 0 ? (
              <li className="border-b border-line px-5 py-3 last:border-b-0 sm:px-6">
                <Link
                  href={recurringHref({ person: null, account: null, show: 'known', sort: 'next' })}
                  className="text-sm font-medium text-accent-text"
                >
                  +{hiddenExpected} more expected
                </Link>
              </li>
            ) : null}
          </ul>
          {showsExpected ? <p className="border-t border-line px-4 py-3 text-xs text-subtle sm:px-5">{COMING_UP_EXPECTED_NOTE}</p> : null}
        </>
      )}
      <CardFooter>
        {budgetPhrase}, and {billsPhrase}.
      </CardFooter>
    </Card>
  );
}
```

Each `[keep the existing … comment here, unchanged]` marker means: copy that comment verbatim from the current file at the same place; do not leave the bracket text in the source.

- [ ] **Step 4: The Dashboard**

`src/app/(app)/dashboard/page.tsx`: change line 19 to `import { expectedRecurringCharges, recurringLoad } from '@/lib/recurring';`; after line 237 (`const bills = upcomingBills({ today, days: 30, includeOverdue: true, viewer });`) add:

```ts
  // Spec 2026-10-06 §2.6. Marked merchants' next charges, for the Coming up card only: never added to
  // `bills` or to spendPlan, and only read when the card renders (the current month). Viewer-scoped,
  // like upcomingBills -- the person pill narrows neither.
  const expected = isCurrentMonth ? expectedRecurringCharges({ today, days: 30, viewer }) : [];
```

and in the `<ComingUpCard … />` props add `expected={expected}` after `bills={bills}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/components/ComingUpCard.test.tsx tests/app/dashboard.test.tsx tests/ops/transactions-href.test.ts tests/ops/onboarding-coverage.test.ts`
Expected: PASS (every pre-existing ComingUpCard test included).

- [ ] **Step 6: Commit**

```bash
git add src/components/ComingUpCard.tsx "src/app/(app)/dashboard/page.tsx" tests/components/ComingUpCard.test.tsx tests/app/dashboard.test.tsx
git commit -m "feat(dashboard): expected recurring charges in Coming up

- marked merchants' next charges, tagged Expected, about the usual amount
- separate prop and type: never in the header total or billsDueCents
- one date order and one cap across bills and expected rows"
```

---

### Task 7: Help, README and the release notes (spec §2.8)

**Files:**
- Modify: `src/app/(app)/help/content.tsx` (`dashboard` section :122-157, `insights` section :547-584)
- Modify: `README.md` (line 182-183)
- Modify: `CHANGELOG.md` (under `## Unreleased`)
- Test: `tests/app/help.test.tsx`, `tests/lib/changelog.test.ts`

- [ ] **Step 1: Write the failing help tests**

Append to `tests/app/help.test.tsx`:

```tsx
/** Spec 2026-10-06 §2.8. */
describe('the help page covers the recurring page and Expected rows in Coming up', () => {
  const insights = () => textOf(section('insights').body);
  const dashboard = () => textOf(section('dashboard').body);

  it('names the full page, where it is, and its choices', () => {
    expect(insights()).toMatch(/See all recurring charges/);
    expect(insights()).toContain('/insights/recurring');
    expect(insights()).toMatch(/Account[\s\S]*Late[\s\S]*sort/);
  });

  it('explains next expected, Late with its grace, and the price tag', () => {
    expect(insights()).toMatch(/next expected/);
    expect(insights()).toMatch(/Late/);
    expect(insights()).toMatch(/more than 7 days past/);
    expect(insights()).toMatch(/up from/);
  });

  it('pairs the Account filter with Late after a card is replaced', () => {
    expect(insights()).toMatch(/replaced[\s\S]*Account[\s\S]*Late/);
  });

  it('says Not recurring is set on Insights, and the row menu toggles', () => {
    expect(insights()).toMatch(/Unmark recurring/);
    expect(insights()).toMatch(/transfer rows are skipped/);
  });

  it('explains the Expected rows in Coming up and why they are not in the totals', () => {
    expect(dashboard()).toMatch(/Expected/);
    expect(dashboard()).toMatch(/not in the card’s totals/);
  });

  it('keeps the wording rule on the Insights section', () => {
    expect(insights()).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
```

Fails before / passes after: none of these sentences exist until Step 3. (`more than 7 days past` is rendered from `RECURRING_LATE_GRACE_DAYS`, so the test also pins the constant into the help.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/app/help.test.tsx`
Expected: FAIL in the new describe only.

- [ ] **Step 3: The help**

At the top of `src/app/(app)/help/content.tsx` add `import { RECURRING_LATE_GRACE_DAYS } from '@/lib/predict/constants';` (that module imports nothing, so the help stays client-safe).

In the `dashboard` section, after the `Needs a look` paragraph add:

```tsx
        <P>
          <B>Coming up</B> lists the bills due in the next 30 days. It also lists the next charge of each merchant you
          marked recurring, tagged <B>Expected</B>, at about its usual amount, on the date its past charges point to.
          Expected rows are estimates and are not in the card&rsquo;s totals or in what is left to spend: a recurring
          charge is usually already inside a category budget, so counting it again would count it twice. A merchant you
          track as an item shows through that item&rsquo;s own bill instead.
        </P>
```

Replace the `insights` section's `body` with:

```tsx
    body: (
      <>
        <Where path="/insights">under Planning in the menu, after Reports —</Where>
        <P>
          Two lists the app works out from your own transactions. <B>Recurring charges</B> sums up the merchants that
          bill you on a rhythm, and <B>Needs a look</B> lists every charge that stands out — the same findings the
          Dashboard shows a few of, all of them here, each with its own <B>That&rsquo;s fine</B>.
        </P>
        <P>
          The Recurring charges card counts three groups. <B>Known recurring</B> is what you have said: a merchant you
          marked, or one that an item or a payment rule on Loans &amp; Coverage already covers, with about how much they
          come to a month — a monthly merchant at its usual charge, a yearly one at a twelfth of it. <B>Looks
          recurring</B> is what the dates show: three or more charges about a month or a year apart, the newest one
          recent. A rhythm is a measurement, not a verdict — a once-a-month shop makes the same dates as a bill.{' '}
          <B>Forming</B> is two charges about a month or a year apart: one more and it has a rhythm.
        </P>
        <P>
          <B>See all recurring charges</B> opens the full list at /insights/recurring: every merchant in every group,
          with its usual charge, about how much that is a month, its last charge and its <B>next expected</B> date — the
          last charge plus the usual gap between charges. Pick an <B>Account</B>, show one group or only the{' '}
          <B>Late</B> ones, and sort by monthly amount, next expected, last charge or merchant. The choices are part of
          the page address, so a filtered list can be bookmarked or sent to someone else in the household.
        </P>
        <P>
          A merchant you marked or track is <B>Late</B> when its next expected date is more than{' '}
          {RECURRING_LATE_GRACE_DAYS} days past with nothing since. It stays on the list: a merchant you marked does not
          drop off because its charges stopped. A row whose newest charge rose shows <B>up from</B> the usual amount to
          the new one, the same finding Needs a look makes.
        </P>
        <P>
          When a card is <B>replaced</B>, pick it under <B>Account</B> on the full list: Known recurring there is every
          merchant that needs the new number. A few weeks later, show <B>Late</B> on the same card to see which of them
          has not charged since.
        </P>
        <P>
          <B>Mark recurring</B> moves a merchant to Known recurring; <B>Not recurring</B> takes it off every list and
          keeps it off. Both are on the full list. On Transactions, a row&rsquo;s menu offers <B>Mark recurring</B>, or{' '}
          <B>Unmark recurring</B> once marked, and <B>Mark recurring</B> is in the bar that appears when you select rows
          (transfer rows are skipped). A merchant marked Not recurring shows <B>Clear &ldquo;not recurring&rdquo;</B> in
          its row menu instead; an admin also sees every mark under <B>Settings → Merchant rules</B>.
        </P>
        <P>
          A new ledger shows little here for its first few months, because a rhythm takes three charges, or two for a
          merchant you marked. Until then Forming says what is one charge away.
        </P>
      </>
    ),
```

`README.md` lines 182-183 become:

```markdown
8. **Insights**, the merchants that bill you on a rhythm — a full list you can filter by card, sort,
   and narrow to the ones that went quiet — plus every charge that stands out.
```

- [ ] **Step 4: The release notes, under Unreleased**

In `CHANGELOG.md`, directly under `## Unreleased` (Task 8 moves this into the dated section):

```markdown
### Added

- **A full page for recurring charges**, opened from **See all recurring charges** on Insights. It
  lists every merchant on a rhythm, with no limit: what it usually costs, about how much that is a
  month, when it last charged and when its rhythm says the next charge is expected. Pick an
  **Account**, show only Known recurring, Looks recurring, Forming or **Late**, and sort by monthly
  amount, next expected, last charge or merchant. The choices are part of the page address.
- **Late.** A merchant you marked or track that has not charged for more than 7 days past its
  expected date is tagged Late and stays on the list instead of dropping off. After a card is
  replaced, pick it under Account and show Late.
- **Forming merchants are listed**: two charges about a month or a year apart, one short of a
  rhythm, each with Mark recurring and Not recurring.
- **A price that went up** shows on the merchant's row, up from the usual amount to the new one.
- **Expected charges in Coming up.** On the Dashboard, each merchant you marked recurring shows its
  next charge, tagged Expected, at about its usual amount. Expected rows are estimates and are not
  in the card's totals or in what is left to spend.

### Changed

- **Recurring charges on Insights is a summary**: how many merchants are Known recurring and about
  how much they come to a month, how many are late, how many Looks recurring are left to review and
  how many are forming.
- **The Transactions row menu toggles the mark**: Mark recurring, or Unmark recurring once marked.
  Not recurring is set on Insights; a merchant marked that way shows Clear "not recurring".
- **Mark recurring in the bulk bar skips transfer rows**, so the count is the merchants actually marked.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/app/help.test.tsx tests/lib/changelog.test.ts tests/ops/onboarding-coverage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/help/content.tsx" README.md CHANGELOG.md tests/app/help.test.tsx
git commit -m "docs: help and release notes for the recurring page

- Insights help: full page, next expected, Late, price tag, card replaced
- Dashboard help: Expected rows and why they are not in the totals
- CHANGELOG notes under Unreleased"
```

> **REVIEW CHECKPOINT 2 (Opus, whole branch).** Review `git diff 1b19d95..HEAD` (v1.54.0..HEAD) against the spec end to end: the wording rule on every new string (UI, help, CHANGELOG), the client-bundle line on the new client file and `recurring-view.ts`, the guard updates, the decisions above, and every Review Focus line. One fix round for Important findings, then Task 8.

---

### Task 8: Release v1.55.0

**Files:**
- Modify: `tests/ops/docker.test.ts` (`'MUST-7.1: the 1.54.0 release'` :477-492 and every remaining `toBe('1.54.0')`), `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Update the release guard first**

Replace `it('MUST-7.1: the 1.54.0 release', …)` with:

```ts
  it('MUST-7.1: the 1.55.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.55.0');
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe('1.55.0');
    expect(lock.packages[''].version).toBe('1.55.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.55\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.55.0]'));
    expect(changelog.indexOf('## [1.55.0]')).toBeLessThan(changelog.indexOf('## [1.54.0]'));
    const current = changelog.slice(changelog.indexOf('## [1.55.0]'), changelog.indexOf('## [1.54.0]'));
    expect(current).toMatch(/See all recurring charges/);
    expect(current).toMatch(/Late/);
    expect(current).toMatch(/Expected/);
    expect(current).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
    // Unreleased was emptied into this section.
    expect(changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('## [1.55.0]'))).not.toMatch(/See all recurring charges/);
  });

  it('MUST-7.1: the 1.54.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.54\.0\] - 2026-10-06$/m);
    expect(changelog.indexOf('## [1.54.0]')).toBeLessThan(changelog.indexOf('## [1.53.1]'));
    const current = changelog.slice(changelog.indexOf('## [1.54.0]'), changelog.indexOf('## [1.53.1]'));
    expect(current).toMatch(/Insights/);
    expect(current).toMatch(/Known recurring/);
    expect(current).toMatch(/Mark recurring/);
  });
```

Then change every remaining `toBe('1.54.0')` to `toBe('1.55.0')`. Check: `grep -c "toBe('1.54.0')" tests/ops/docker.test.ts` → `0`; `grep -c "toBe('1.55.0')" tests/ops/docker.test.ts` → `24`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ops/docker.test.ts`
Expected: FAIL — `expected '1.54.0' to be '1.55.0'` across the version pins, and no `## [1.55.0]` heading.

- [ ] **Step 3: Date the notes and bump the version**

In `CHANGELOG.md`, insert `## [1.55.0] - <output of date +%F>` and a blank line between `## Unreleased` and the notes Task 7 wrote, so `## Unreleased` is empty again above the dated section. `package.json` and both `"version"` fields near the top of `package-lock.json`: `1.54.0` → `1.55.0`.

Run: `npx vitest run tests/ops/docker.test.ts tests/lib/changelog.test.ts` — expected PASS.

- [ ] **Step 4: The release gate**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
rm -rf .next && npm run build
npm run smoke
```

Expected: vitest exit 0 (a lone `Timeout calling "onTaskUpdate"` failure in a parallel run is the known flake — rerun that file alone; the `--no-file-parallelism` run itself must exit 0); tsc no errors; build exit 0 with the 8 known Turbopack dynamic-filesystem warnings; smoke reports every check passed, `/insights/recurring` included, with the 2 known Windows skips.

- [ ] **Step 5: Commit and push main**

```bash
git add CHANGELOG.md package.json package-lock.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.55.0

- recurring charges page, Late and next expected, Insights summary
- Expected rows in Coming up, kept out of every total
- row menu mark toggle; bulk mark skips transfers"
git push origin main
```

On a 403, `gh auth switch` to VibeLogicCode and push again.

- [ ] **Step 6: Wait for the Test suite workflow**

```bash
gh run list --workflow test.yml --limit 3
gh run watch <id of the run for this commit> --exit-status
```

Expected: `Test suite` completes successfully. Do not tag until it does. On a failure, fix forward with a new commit; never force-push.

- [ ] **Step 7: Tag and watch the Release image**

```bash
git tag -a v1.55.0 -m "v1.55.0"
git push origin v1.55.0
gh run list --workflow release-image.yml --limit 3
gh run watch <id of the v1.55.0 run> --exit-status
```

Expected: `Release image` for `v1.55.0` completes successfully. Never move or delete a tag; fix forward on a failed workflow.

**Review focus:**
- The CHANGELOG entry passes the wording rule (the guard asserts it), and Unreleased is empty again.
- The 1.54.0 section is untouched and pinned append-only.
