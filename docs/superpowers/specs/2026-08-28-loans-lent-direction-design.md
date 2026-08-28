# Loans with direction "lent" — design

**Date:** 2026-08-28
**Status:** Owner feature request **BU** (`docs/PENDING-FIXES.md`, "Owner feature requests after
v1.13.3"). Rulings **P1–P16** below are the PLANNER's; each names the code fact that forced it and
each is reversible by the owner.
**Target release:** v1.14.0 (built on v1.13.3)
**Answers:** `docs/PENDING-FIXES.md` item **BU** and nothing else.
**Migration:** `drizzle/0014_loan_direction.sql` — the only migration in this release, one
`ALTER TABLE ... ADD COLUMN`.

---

## Problem

A **Loan** item models exactly one thing today: a debt the household owes. `src/lib/loans.ts`'s
`link()` reads the sign of the assigned transaction and hard-codes what it means — money OUT is a
payment and the balance goes DOWN, money IN is a disbursement and the balance goes UP:

```ts
const isPayment = input.signedAmountCents < 0;
```

A loan *to* someone is the mirror image of that, so the app has no way to record one. Assigning the
outgoing e-transfer to a Loan item zeroes the item immediately, because the one line above reads
"money left the account" as "the debt shrank". `transaction_splits` carries a category, an amount
and a note but no person, so there is no "owed by" anywhere else in the app either. The workarounds
on offer are an Asset account named after the borrower, or a spend category that nets out on
repayment; both are bookkeeping tricks around a missing field.

Everything else the feature needs already exists: the balance column, the link table, the reversal
paths, the reconstruction, the card and the chart. Only the meaning of the sign is missing.

**Not in scope.** No interest maths (MUST-13.1 stands). No change to where a loan-linked row sits in
its category or its budgets (MUST-13.2 stands). No borrower field, no person on a split, no new
account type, no new npm dependency, no change to the matcher rules' own sign filters.

---

## Rulings

All sixteen are the planner's. **PLANNER rulings — owner may reverse.**

| # | Ruling |
|---|---|
| **P1** | The column is `loan_direction text NOT NULL DEFAULT 'owed'` with an inline `CHECK (loan_direction IN ('owed','lent'))` — **not** nullable, though BU's own wording says "nullable". `users.visibility` (0013) is the closest precedent and is NOT NULL with a default and a CHECK; a nullable column would make every reader handle a third state that means the same thing as `'owed'`. |
| **P2** | The value set is expressed **twice**: the SQL CHECK and a zod enum, exactly as `users.visibility` is. The CHECK is forward-only (SQLite does not re-validate existing rows against a CHECK added by `ALTER TABLE ADD COLUMN`) and that is harmless precisely because the column is new: every pre-existing row takes the default. Inventory entry **40** in 0014's header. |
| **P3** | A non-loan item always carries `'owed'`. Writing `'lent'` onto an item whose type's kind is not `loan` throws `LOAN_DIRECTION_KIND_ERROR` — the constant beside `MATCHING_KIND_ERROR`/`INSTALLMENT_KIND_ERROR` in `constants.ts` (where the pure, client-safe direction values already live), the assertion beside `assertLoanFieldsMatchKind` in `items.ts` (where the kind lookup is); `setItemTypeKind` resets the column to `'owed'` when a type moves away from `loan`, in the same `.set({...})` that already nulls the four money columns (MUST-12.5). |
| **P4** | **One helper owns the flip.** `loanSignedDelta(direction, amountCents)` in `src/lib/warranty/constants.ts` re-signs a transaction amount into the loan's own frame; negative always means "this balance goes DOWN". `src/lib/loans.ts` must not contain the literal `'lent'` at all — every sign decision calls the helper and every partition tests `=== 'owed'`. Pinned by a new grep invariant in `tests/ops/loan-invariants.test.ts`. |
| **P5** | `debtOverTime`'s two SQL queries stay **byte-identical**. The per-month `case when amount_cents < 0 ...` sum already computes the undo delta *for an owed loan*; a lent loan's undo delta is exactly its negation, so the flip happens in the in-memory fold (`loanSignedDelta`), not in SQL. This is what makes "existing `owed` loans behave byte-identically" a structural fact rather than a claim, including the documented clamp drift the docblock at `src/lib/loans.ts:1077-1093` pins. |
| **P6** | `DebtPoint` gains `lentCents: number \| null` and `owedCents` stops counting lent items. `src/lib/networth.ts:319` reads `owedCents` and is **not edited**: money someone owes the household is not a debt the household owes, so dropping it out of the net-worth debt line is the correct answer, not a regression. Lent money is **not** added to net worth as an asset — BU does not ask for it and the Asset-account workaround still exists. |
| **P7** | No borrower column, no person on a split. BU states splits carry no person and does not ask for one; the item's **name** ("Loan to a friend") is where a borrower's name lives, exactly as it does for every other item. |
| **P8** | Matcher rules are untouched. `applyPaymentMatchers`' `if (txn.amountCents >= 0) continue` (`loans.ts:511`) and the two `amount_cents < 0` SQL filters (`:587`, `:927`) stay as they are — they are shared with the bill-installment branch. A rule on a lent loan therefore matches **outgoing** money, which under the flipped convention means "you lent more", and that is correct; **incoming repayments are manual-assign only in v1.14.0**. |
| **P9** | `payoffProjection` returns `null` for a lent loan. Its query sums applied cents over transactions with `amount_cents < 0`, which for a lent loan is the balance GROWING; a projection built from that would read advances as repayments and print a payoff month that means nothing. One guard, no query change. |
| **P10** | `payoffFraction` is **kept** for a lent loan. `clamp(1 - balance / principal, 0, 1)` over principal = "what you lent" and balance = "what is still out" reads as *fraction repaid*, which is the honest thing for that bar to say. No change (MUST-15.4 untouched). |
| **P11** | The "Who owes us" card hides when no lent item has a balance **above zero** — stricter than `LoansCard`'s "has a balance or a principal" rule, because BU says "hides at zero" and a fully-repaid loan should stop asking to be chased. A `self` viewer sees it titled **"Owed to you"** over their own rows only; the household title is **"Who owes us"**. The total is derived from the rows `listLoans(today, viewer)` already scoped, so a self viewer's total is their own by construction and no household figure is computed and discarded. |
| **P12** | Reports: the debt card's existing `hasLoans` gate keeps its exact meaning (any loan with a tracked balance, either direction), so the card's visibility does not change for any existing install. A second **Lent** line and a `<Legend>` appear only when a lent loan has a balance — a legend over one line is noise. |
| **P13** | **No `INSTALL.md` change.** That file has no per-migration and no per-version section; grep for `0013`, `0012` and `Before updating` returns nothing in it. The `CHANGELOG.md` "Before updating" paragraph is this repo's only migration-note convention and v1.13.0 followed exactly it. Inventing a second one for a single ADD COLUMN is not the smallest change. The planning brief listed "`INSTALL.md` migration note" as a Lane C deliverable; it was investigated and dropped here, not forgotten. |
| **P14** | The reports **rendering** (`reports/page.tsx`, `reports-client.tsx`, `DebtTrendChart.tsx`) is in the surfaces lane, NOT the `src/lib/loans.ts` lane, even though it consumes `DebtPoint.lentCents` which the maths lane produces. That is only safe because **T1 declares both read-model shapes before either lane starts** — `LoanSummary.loanDirection` (selected from the new column) and `DebtPoint.lentCents` (returned as `null` until the maths lane fills it in). Interface first, so the two lanes are type-independent and neither blocks the other. T1 is the ONLY task other than the maths lane that opens `src/lib/loans.ts`, and it runs alone. |
| **P15** | The `/transactions` unassign confirm ("That loan's balance moves back up.") becomes direction-neutral — "That loan's balance moves back to what it was." — rather than plumbing a direction field through `LoanLink` and `loanLinksForTransactions` for one sentence. |
| **P16** | The Direction control reuses `loanFieldsAllowedForKind(kind)` as its gate. No second predicate: it would be `kind === 'loan'` again, and `tests/app/warranty-detail-client.test.tsx` already greps for the existing one. |

---

## Data model

### Migration `drizzle/0014_loan_direction.sql`

One statement. Additive, no table rebuild, no `PRAGMA` (`src/db/client.ts`'s `openDatabase()`
handles foreign keys around the whole migration pass — see 0011's and 0013's headers).

```sql
ALTER TABLE `warranty_items` ADD COLUMN `loan_direction` text NOT NULL DEFAULT 'owed' CHECK (`loan_direction` IN ('owed', 'lent'));
```

The header follows 0013's exactly: the hand-maintained warning, the separator note (the breakpoint
marker is *described*, never quoted, or the file is shredded), the "this CHECK is forward-only and
that is harmless because the column is new" paragraph, and the running inventory of
**objects that exist ONLY in SQL and have NO Drizzle representation**. Entries 1–39 are restated
verbatim from 0013's header and one entry is appended:

```
--  40. the loan_direction CHECK on warranty_items, and the column arriving   (0014)
--      by ALTER TABLE ADD COLUMN
```

`drizzle/meta/_journal.json` gains the `idx: 14`, `tag: "0014_loan_direction"` entry after 0013's.

`ALTER TABLE ADD COLUMN` appends physically, so `loan_direction` lands **after** `budget_category_id`
in `pragma table_info(warranty_items)`. `tests/db/loan-schema.test.ts:90` asserts the four loan money
columns are "contiguous and in order" — appending past them keeps that true and that test unedited.

### Schema mirror — `src/db/schema.ts`

Declared last in `warrantyItems`, after `budgetCategoryId`, the same ALTER-TABLE-ADD-COLUMN
convention `typeId`, the billing pair and the four money columns already follow:

```ts
    /**
     * v1.14.0, added by drizzle/0014_loan_direction.sql (spec
     * docs/superpowers/specs/2026-08-28-loans-lent-direction-design.md, item BU). Which way a
     * loan points. 'owed' is a debt the household owes -- every row before v1.14.0, and every
     * non-loan row forever. 'lent' is money someone owes the household, and it FLIPS the sign
     * convention: money OUT raises the balance, money IN lowers it.
     *
     * NOT NULL with a default, like users.visibility (0013) and unlike the four money columns
     * above: there is no third state, and 'owed' is the honest value for an item that is not a
     * loan at all. The rule that only a kind='loan' item may carry 'lent' is a CROSS-TABLE rule
     * a CHECK cannot see, so it lives in src/lib/warranty/items.ts beside
     * assertLoanFieldsMatchKind (planner ruling P3).
     *
     * NOT represented here -- SQL only:
     *   - CHECK (loan_direction IN ('owed','lent'))
     */
    loanDirection: text('loan_direction', { enum: ['owed', 'lent'] }).notNull().default('owed'),
```

### The one helper — `src/lib/warranty/constants.ts`

This module is pure and client-safe (no `@/db` import), which is why the flip lives here and not in
`src/lib/loans.ts`: a client component may import it without dragging `better-sqlite3` into the
browser bundle (`tests/ops/client-bundle.test.ts`).

```ts
export const LOAN_DIRECTIONS = ['owed', 'lent'] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

/**
 * The transaction's amount re-expressed in the loan's own frame. NEGATIVE always means "this
 * balance goes DOWN", whichever way the loan points. This is NOT the delta finally applied --
 * link() still clamps a repayment at the outstanding balance -- it is the SIGN and the
 * MAGNITUDE the clamp then works from.
 *
 *   owed, -100  ->  -100   money out pays the debt down      (today's behaviour, unchanged)
 *   owed, +100  ->  +100   money in is a disbursement        (today's behaviour, unchanged)
 *   lent, -100  ->  +100   money out lends more; they owe us more
 *   lent, +100  ->  -100   money in is a repayment
 */
export function loanSignedDelta(direction: LoanDirection, amountCents: number): number {
  return direction === 'lent' ? -amountCents : amountCents;
}

export function isLoanRepayment(direction: LoanDirection, amountCents: number): boolean {
  return loanSignedDelta(direction, amountCents) < 0;
}

/** Plain-language, in the voice of the household. Used by both item forms and the detail row. */
export const LOAN_DIRECTION_LABELS: Record<LoanDirection, string> = {
  owed: 'We owe this',
  lent: 'Owed to us',
};

export function isLoanDirection(value: string): value is LoanDirection {
  return (LOAN_DIRECTIONS as readonly string[]).includes(value);
}
```

Ruling P4 makes this the only place the word `'lent'` appears in any sign decision.

---

## Sign semantics

`a` = `transactions.amount_cents`, immutable and signed (negative = money left the account).
`b` = `warranty_items.current_balance_cents`, non-negative or NULL.
`e = loanSignedDelta(direction, a)`.

| Step | Rule (identical for both directions, written in terms of `e`) |
|---|---|
| repayment? | `e < 0` |
| `applied` | `b === null ? 0 : (e < 0 ? max(0, min(abs(a), b)) : abs(a))` — a repayment clamps at the outstanding balance, growth applies in full, an unknown balance applies nothing |
| balance delta | `e < 0 ? -applied : +applied` |
| unassign / reverse | `restore = e < 0 ? +applied : -applied`, then `max(0, b + restore)` and only where `b is not null`. Both paths already join `transactions` to recover the sign; they now also join `warranty_items` for the direction. |
| running balance inside the two rule loops | `applyPaymentMatchers`' `balances.set(id, balance - applied)` (`loans.ts:537`) and `backfillLoanFromRule`'s `balance -= applied` (`:612`) BOTH hard-code "a link shrinks the balance", which is only true for `owed`. Each becomes the signed move `e < 0 ? -applied : +applied`, so a second matched advance on a `lent` loan is clamped against the balance the first one already raised. Missing this is the one way a lent loan can go wrong without any test noticing, because the single-transaction case is right either way. |
| `debtOverTime` walk | per (item, month): `undo = loanSignedDelta(direction, sqlUndo)` where `sqlUndo` is the existing `sum(case when a < 0 then applied else -applied end)`; months later than E are added back onto `b` |
| `payoffFraction` | `clamp(1 - b / principal, 0, 1)` — unchanged, reads as "fraction repaid" for a lent loan (P10) |
| `payoffProjection` | `null` for `lent` (P9); unchanged for `owed` |

Worked, both ways, on the same numbers:

| | direction `owed` (a car loan) | direction `lent` (an e-transfer to a friend) |
|---|---|---|
| balance before | 200000 | 0 |
| assign `a = -50000` (money out) | repayment → balance **150000** | advance → balance **50000** |
| assign `a = +50000` (money in) | disbursement → balance **250000** | repayment → balance **0** |
| unassign the `-50000` link | +applied → back to 200000 | −applied → back to 0 |
| counted in `owedCents` / the debt line | yes | no — its own `lentCents` series |
| counted in `loansTotalOwedCents()` | yes | no |
| dashboard card | Loans | "Who owes us" |

Because `loanSignedDelta('owed', a) === a`, every expression above collapses to today's code for an
`owed` loan. That is asserted directly: an existing-fixture test seeds a loan the pre-migration way
(no `loan_direction` named in the INSERT, so it takes the default) and pins the same numbers the
v1.13.x suite already pins.

---

## Read model

**Both read-model shapes are declared by the foundation task T1, before any lane starts** (ruling P14), so the maths lane and the
surfaces lane never wait on each other's types.

**`LoanSummary` gains `loanDirection: LoanDirection`** and `listLoans(today, viewer)` selects the
column. The signature does not change, so its `REQUIRE_VIEWER` entry in
`tests/ops/visibility-invariants.test.ts` still matches and **that file is not edited by this
release** — no new library function takes a viewer, and none needs to: the dashboard partitions the
rows `listLoans` already scoped.

**`loansTotalOwedCents()`** filters to `loanDirection === 'owed'`. It stays viewer-free and stays out
of `REQUIRE_VIEWER` for the reason its own docblock gives.

**`DebtPoint`** becomes:

```ts
export interface DebtPoint {
  month: string;
  /** Household debt: the sum over direction 'owed' loans. NULL breaks the line -- see the
   *  MUST-15.7 reconstruction rules, unchanged. */
  owedCents: number | null;
  /** v1.14.0: the same reconstruction over direction 'lent' loans, as its own series. Same
   *  null semantics, computed independently -- one unknown lent loan must not break the
   *  household-debt line and vice versa. */
  lentCents: number | null;
}
```

Both accumulators run over the same month axis, from the same two queries, in the same fold. A loan
contributes to exactly one of them. T1 declares the field and returns `lentCents: null` from the existing fold, which is
type-correct and behaviour-neutral (nothing reads it yet, and no `lent` loan can exist before the forms ship). The maths lane
replaces the `null` with the real second accumulator.

**Fixtures typed against these shapes must be updated by whichever lane owns them** — `tests/app/loans-card.test.tsx` builds
literal `LoanSummary` values and `loanDirection` is required, so that file belongs to the surfaces lane.

---

## Surfaces

### Dashboard — the "Who owes us" card

`src/components/WhoOwesUsCard.tsx`, a server component built from `LoansCard`'s skeleton (`Card` /
`CardHeader` with a `money-lg` total in the `action` slot / a `<ul className="border-t border-line
text-sm">` of rows). Props:

```ts
{ loans: LoanSummary[]; totalLentCents: number; selfScoped: boolean }
```

- Rows: item name and outstanding balance, matching `LoansCard`'s row shape. No owner name and no
  borrower name (P7) — the item's name is the borrower.
- Self-hides: `loans.filter((l) => (l.currentBalanceCents ?? 0) > 0)` empty → `return null` (P11).
- Copy: `selfScoped` → title **"Owed to you"**, description *"Money you have lent and not been
  repaid."*; otherwise title **"Who owes us"**, description *"Money the household has lent and not
  been repaid."* Neither sentence claims a household total to a self viewer, and the numbers behind
  the self version are that viewer's own rows.

`src/app/(app)/dashboard/page.tsx` keeps its single read-model scan and partitions it:

```tsx
  const loans = listLoans(today, viewer);
  const owedLoans = loans.filter((loan) => loan.loanDirection === 'owed');
  const lentLoans = loans.filter((loan) => loan.loanDirection !== 'owed');
  const totalOwedCents = owedLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
  const totalLentCents = lentLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
```

`LoansCard` is fed `owedLoans`, so its description *"What the household still owes."* is now true
rather than accidentally true. The new card renders directly under it, **without** the
`selfScoped ? null :` gate the Loans card carries: ruling R2 (v1.13.0) hides household balances from
a child, and this card shows only rows that child owns.

The dashboard `PageGuide`'s second paragraph currently reads "Loans, net worth and upcoming bills
stay household-wide whichever pill is chosen". It gains a clause naming the second card so the guide
does not describe a page with one loan card on it when there are two.

### Reports — the second series

`debtOverTime(24)` is already gated behind `showHouseholdTotals` in
`src/app/(app)/reports/page.tsx:152`; a self viewer gets `[]` and that does not change — a lent
series is still a household figure on that page, and the dashboard card is where a self viewer sees
their own.

- `page.tsx` computes `hasLoans` and a new `hasLent` from **one** `listLoans` call instead of the
  inline one at `:153`. `hasLoans` keeps its exact meaning (P12).
- `reports-client.tsx` passes `showLent={hasLent}` to the chart and widens the card description to
  *"What the household owes, and what it has lent out, as separate lines."*
- `DebtTrendChart` maps `{ month, Owed, Lent }`, keeps the existing `Owed` line
  (`var(--negative-solid)`, `connectNulls={false}`) untouched, and adds `Lent`
  (`var(--positive-solid)`) plus a `<Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)',
  paddingTop: 8 }} />` — both only when `showLent`, copying `NetWorthChart`'s multi-series skeleton.

### The item forms

Both forms are plain `<form action={...}>` submits: `src/app/(app)/warranties/new/new-warranty-client.tsx`
and the local `EditForm` inside `src/app/(app)/warranties/[id]/warranty-detail-client.tsx` (there is no
`/warranties/[id]/edit` route). The control is a plain `<select>`
in a `<Field>`, copying the billing-cycle select in each file verbatim — **not** `AutoSaveSelect`,
which in that file is used only for the Installments card's bound action:

```tsx
<Field label="Direction" hint="Which way this loan points.">
  <select name="loanDirection" value={loanDirection} onChange={(e) => setLoanDirection(e.target.value)} className={selectClass}>
    {LOAN_DIRECTIONS.map((direction) => (
      <option key={direction} value={direction}>{LOAN_DIRECTION_LABELS[direction]}</option>
    ))}
  </select>
</Field>
```

There is no `"Not set"` option: the column is NOT NULL and `'owed'` is the default (P1). The control
is rendered inside each file's existing `loanApplicable` block (P16) and is reset to `'owed'` by the
same effect that already nulls the loan money fields when that gate goes false. `selectClass`
already carries the 44px target both forms use.

`readItemInput` (`src/app/(app)/warranties/actions.ts:256`) gains a `readLoanDirection(formData)`
beside `readBillingCycle`, following its shape exactly: `'' -> 'owed'`, anything else must be one of
the two values or it throws `LOAN_DIRECTION_ERROR`.

### The item detail

Inside the existing loan money block (`warranty-detail-client.tsx:418-460`), the `<dl>` at `:450`
gains one row, following the block's own rule — *show when the kind's gate allows it OR a value is
stored*:

```tsx
{!loanFieldsAllowedForKind(item.kind) && item.loanDirection === 'owed' ? null : (
  <Detail label="Direction">{LOAN_DIRECTION_LABELS[item.loanDirection]}</Detail>
)}
```

The block's "Removing an old payment can push the balance above your latest statement figure." hint
stays as written: it is true in both directions (a removed link moves the balance back, and for a
lent loan that is downward), and rewording it per direction is more churn than the sentence is worth.

### Help

One paragraph in `src/app/(app)/help/content.tsx`, in the `coverage` section, immediately after the
existing loan paragraph (`:348-353`) and before the `bill` paragraph. Plain mechanics, no figures and
no advice (rulings A1/A2 in that file's header):

> A loan can point either way. **We owe this** is the usual one — money leaving the account pays it
> down. **Owed to us** is for money you lent someone: money leaving the account adds to what they owe
> you, and money coming back takes it off again. Loans you lent out are kept out of the debt figures
> and get their own card on the Dashboard and their own line on the debt report.

### `/transactions`

One string, per ruling P15: the unassign confirm becomes *"Unassign this transaction from {name}?
That loan's balance moves back to what it was."*

---

## Self-scope rules

| Surface | `household` viewer | `self` viewer |
|---|---|---|
| Loans card | unchanged | hidden (v1.13.0 ruling R2, unchanged) |
| "Who owes us" card | shown, titled "Who owes us", household rows | shown, titled **"Owed to you"**, ONLY rows with `ownerUserId === viewer.id` (already enforced by `listLoans`'s `ownerScope` filter), no household wording |
| Reports debt chart, both lines | shown | not rendered and **not computed** — `debtOverTime` is not called at all (`showHouseholdTotals`) |
| `loansTotalOwedCents()` | household-wide, `owed` only | not reachable from a self-viewer surface |

`debtOverTime` keeps **no** viewer parameter and keeps its `HOUSEHOLD_ONLY_AT_PAGE` entry in
`tests/ops/visibility-invariants.test.ts`; that test fails if it ever grows one, and the page-level
gate at `reports/page.tsx:152` is the guarantee.

---

## Safety

- **Additive migration, no rebuild.** One `ALTER TABLE ADD COLUMN`; no foreign key, no index, no
  table touched but `warranty_items`.
- **Existing rows are byte-identical.** Every pre-migration row takes `'owed'`;
  `loanSignedDelta('owed', a) === a`; `debtOverTime`'s SQL does not change. Pinned by a test that
  seeds a loan with a pre-1.14.0-shaped INSERT (no `loan_direction` named) and asserts the v1.13.x
  numbers.
- **MUST-13.1 intact.** Nothing added multiplies, accrues or projects with `interest_rate_bps`;
  `tests/ops/loan-invariants.test.ts`'s scan still covers `src/lib/loans.ts`.
- **MUST-13.2 intact.** Nothing added writes `is_transfer`, `category_id` or `attributed_user_id`,
  and nothing added writes the `transactions` table at all. A `lent` row stays in its spending
  category and in every budget — BU's own instruction, so the money shows as spending until repaid.
- **`transactions.amount_cents` immutable.** Direction is derived at read time from the item;
  `tests/lib/loans/invariants.test.ts`'s `.update(transactions).set({...})` scanner is unaffected.
- **Clock-free.** Nothing added calls `new Date()` inside `src/lib/**`.

---

## Release

### `CHANGELOG.md` — a new section directly under `## Unreleased`

`## [1.14.0] - 2026-08-28`, with the **Before updating** / **Stop the old container** /
**The migration is all-or-nothing** / **To roll back** block copied from v1.13.0's wording and
re-pointed at 1.13.3 — this release has a migration, so the backup paragraph is mandatory. Groups:
**Added** (the direction control, the "Who owes us" card, the second line on the debt report),
**Changed** (loans you lent out no longer count toward household debt or net worth's debt line).

### Version bump

`package.json` → `1.14.0`; `tests/ops/docker.test.ts` gains a `MUST-7.1: the 1.14.0 release` block
above the current head and renames the 1.13.3 block to `... is still recorded intact (append-only
discipline)`, flipping its `toBe('1.13.3')` to `not.toBe('1.13.3')`. The 1.14.0 block asserts the
dated heading, the `Unreleased < [1.14.0] < [1.13.3]` order, and — unlike the last three releases —
that the entry does **not** say "no migration".

### `docs/PENDING-FIXES.md`

Item **BU**'s heading gains `— SHIPPED in v1.14.0` and a `Status:` line naming this spec, the same
form every shipped item above it uses.

---

# Addendum A — Assign to new loan (owner-confirmed 2026-08-28)

Confirmed by the owner after the direction wording landed (`81777b3`). It is an addendum, not a
re-open: nothing above changes, and rulings P1–P16 all stay in force.

## Behaviour

A transaction row's menu (`/transactions`) gains one more item, **"Assign to new loan…"**, offered
in the same non-transfer block the existing `Assign to <loan>` / `Unassign from <loan>` items live
in. Choosing it opens an **inline sub-row under the row**, exactly the way `Note…` already does —
not a dialog, not a form inside the menu — carrying two fields and a Save button:

| Field | Control | Default |
|---|---|---|
| Name | `<input name="loanName">` | empty, `autoFocus` |
| Direction | `<select name="loanDirection">` over `LOAN_DIRECTIONS`, labelled from `LOAN_DIRECTION_LABELS` | `lent` (*Lent out — they owe us*) |

Submitting creates the loan item **and** assigns this transaction as its first entry, in ONE
database transaction. The balance afterwards is `|amountCents|` in every accepted case.

The existing **"Assign to `<loan>`"** items are untouched and stay exactly where they are: money out
on a lent loan adds to what they owe, money in reduces it (ruling P4's flip, already shipped).

**Guardrails.**

- A `lent` loan created from an **incoming** (positive) transaction is refused:
  *"A loan you lent out starts with money going out."* A loan you lent out cannot begin with money
  arriving; that would be a repayment of a loan that does not exist yet.
- `owed` accepts **either** sign. The first entry of a borrowed loan may legitimately be the deposit
  that arrived, or the first payment made on money borrowed before the household started tracking it.

Help and `CHANGELOG.md` already describe all of this (`81777b3`); the implementation task must not
edit either file.

## Rulings

All are the planner's, numbered A-series so they never collide with P1–P16.
**PLANNER rulings — owner may reverse.**

| # | Ruling |
|---|---|
| **A1** | **An inline disclosure sub-row, not a form inside the menu.** The new item is a `RowMenuButton` that opens the same kind of `<tr><td colSpan={COLUMN_COUNT}>` editor the `Note…` item already opens (`transactions-client.tsx:665` ff), with one more nullable state slot (`creatingLoan`) mirroring `noting` exactly, so opening it on a second row replaces whichever was open. A `RowMenuForm` cannot hold two fields: the menu is a 14rem fixed-position list of `role="menuitem"` rows, and a name box plus a select inside one would be unreadable and structurally wrong for assistive tech. |
| **A2** | **Both refusal strings live in `src/lib/warranty/constants.ts`**, beside `LOAN_DIRECTION_KIND_ERROR` — `LOAN_LENT_FIRST_ENTRY_ERROR` and `LOAN_ALREADY_LINKED_ERROR`. Two standing reasons: MUST-19.11 keeps user-facing kind/direction wording in one place, and ruling **P4** forbids the literal `'lent'` in `src/lib/loans.ts`, which is where the refusal is raised. |
| **A3** | **The seed is defined as `target − delta`, never as a second write.** `link()` stays the ONLY code that moves `current_balance_cents` on this path. The new item is created with `currentBalanceCents` set to the balance the loan had *the instant before this transaction*, and the assign then moves it to `|amountCents|` on its own. See the seed table below. There is no post-assign `update warranty_items set current_balance_cents`, so an unassign returns the loan to its seed by construction — the same contract every other unassign carries. |
| **A4** | **One `getDb().transaction()` wraps type resolution, the implicit type create, the item insert and the assign.** A throw anywhere — a zero-amount transaction, an already-linked transaction, a direction/kind mismatch — rolls back the item *and* the implicitly created type, so a refused submission leaves nothing behind. `createWarrantyItem`'s own inner `db.transaction` joins the outer one (better-sqlite3 nests as a savepoint; the note under `reverseLoanLinksForTransactions` records this codebase's existing reliance on that), and its `deferred` side-effect list is empty here because `staged` is `[]`. |
| **A5** | **The implicit item-type create is allowed for a member.** `createItemType()` in `src/lib/warranty/types.ts` carries no role check of its own: `requireAdmin()` sits in `settings/item-types/actions.ts`, gating that SCREEN, not the function. The implicit create is far narrower than that screen — at most one type, named exactly `Loan`, of kind `loan`, only when no loan-kind type exists at all — and it never renames, re-kinds or deletes one. Refusing a member here would mean a household whose admin never created a Loan type cannot use this feature at all, which is the very detour the feature exists to remove. |
| **A6** | **The type chosen is the first `kind: 'loan'` type in `listItemTypes()` order** — `name collate nocase` — which is the exact order the New item form's own dropdown renders (`warranties/new/page.tsx:48`). Item types carry no active/archived flag (`src/db/schema.ts`), so "first active" and "first" are the same row; the plan says *first* and means it. |
| **A7** | **Idempotency: a transaction that already carries ANY loan link is refused** (`paymentLinksForTransaction(txnId).loans > 0` → `LOAN_ALREADY_LINKED_ERROR`). That is what makes a double-submit safe: the first submit creates the link, the second is refused, and the household is never left holding two loans that each claim the same money as their opening entry. MUST-11.16 (a combined payment split across two loans) is **untouched** — it governs `Assign to <loan>`, which is where a genuine combined payment belongs. `assignTransactionToLoan` already refuses the bill leg of this same question (v1.12.1 item T); this is the loan leg of it, on this path only. |
| **A8** | **The assign copy is EXTRACTED, not copied.** `loanAssignedMessage()` moves into `constants.ts` (pure, no `@/db`; `formatCents` comes from `@/lib/money`, which imports nothing at all) and BOTH `assignToLoanAction` and the new action call it. MUST-19.11 again: a second copy of `3efb23f`'s direction-aware sentences is a second place they can drift. `assignToLoanAction` keeps its own over-link warning branch, which is about LINKS rather than the balance and is unreachable on the create path (A7 refuses a second link outright). |
| **A9** | **The result message is `Created <name>. ` followed by `loanAssignedMessage(...)`.** Both facts, in the order they happened, with the second half word-for-word the sentence the existing assign already produces. A bespoke sentence for the create path was considered and rejected under A8. |
| **A10** | **Owner resolution belongs to the action, and `canActOnOwner` is enforced there** — see the self-scope table below. `createLoanFromTransaction` re-derives the same two facts from the viewer it is handed, so a caller that does not route through the action cannot skip either. |
| **A11** | **No audit row.** `AuditAction` is `'delete_item' \| 'delete_receipt' \| 'undo_import'` (`src/lib/audit.ts:15`): item *creation* is audited nowhere in this codebase, the ordinary create-item action included. Auditing this one path and not the form beside it would make the log claim a completeness it does not have. `src/lib/audit.ts` is not opened. |
| **A12** | **`createLoanFromTransaction(input, viewer)` takes a REQUIRED viewer and is registered in `tests/ops/visibility-invariants.test.ts`'s `REQUIRE_VIEWER`**, floor raised 27 → 28. It is a WRITER, not a read model, so its entry carries a one-line note saying so: the guarantee borrowed from that list is the mechanical one it actually asserts — the parameter exists and is never optional — which is exactly what stops a future caller compiling a scope-free create. |
| **A13** | **No new transfer check server-side.** The menu item sits inside the existing `row.isTransfer ? null :` block, like every other loan item; `assignTransactionToLoan` has never refused a transfer on the manual path and this addendum does not change it (the neighbour of ruling P8: the *rule* path skips transfers, the manual path is a person's deliberate act). |

## Seed and sign, per case

`a` = `transactions.amount_cents` (immutable, signed). `m = |a|`.
`e = loanSignedDelta(direction, a)` — negative always means "this balance goes DOWN" (P4).

| direction | `a` | `e` | seed `current_balance_cents` | `link()` applies | balance after |
|---|---|---|---|---|---|
| `lent` | `< 0` (money out) | `+m` | **0** | `+m` | **`m`** |
| `lent` | `> 0` (money in) | `−m` | — | — | **REFUSED** — `LOAN_LENT_FIRST_ENTRY_ERROR` |
| `owed` | `> 0` (money in — the borrowed money arriving) | `+m` | **0** | `+m` | **`m`** |
| `owed` | `< 0` (money out — a first payment on money borrowed earlier) | `−m` | **`2m`** | `−m`, clamped against the seed, which is `≥ m`, so applied in full | **`m`** |
| either | `0` | — | — | — | REFUSED by `assignTransactionToLoan`'s existing zero-amount guard; the whole create rolls back (A4) |

One expression, no direction literal, no new sign logic:

```ts
const magnitude = Math.abs(txn.amountCents);
const seedCents = isLoanRepayment(input.direction, txn.amountCents) ? magnitude * 2 : 0;
```

`2m` is arithmetic, not fabrication: if `m` is still owed *after* a payment of `m`, then `2m` was
owed before it. `balance_updated_at` is set to the same `at` as the row — MUST-11.7's pairing is
enforced by `assertBalanceAnchorPairing`, so the two are written together or the create throws — and
`link()` never touches it afterwards (MUST-11.8).

`principal_cents`, `interest_rate_bps`, `billing_cycle` and `billing_amount_cents` are **left NULL**.
Nothing here knows the principal of a loan whose first entry is a payment, and MUST-13.1 keeps the
rate display-only in any case. `purchase_date` is the transaction's own `date`; `warranty_months` is
null and `is_lifetime` false, so `computeExpiryDate` returns null (open-ended — a loan's own
"Ongoing (no end date)").

## Self-scope

| Viewer | Transaction resolved through | `owner_user_id` of the new loan | Then |
|---|---|---|---|
| `self` (a kid) | `getTransaction(txnId, viewer)` — null for a row outside their scope, the same refusal as "no such row" | **`viewer.id`, always** — never the row's `attributed_user_id`, which for a self viewer is already their own id and must not become a second source of truth | `canActOnOwner` passes trivially |
| `household` | `getTransaction(txnId, viewer)` (unscoped for them) | **`transaction.attributedUserId ?? viewer.id`** — a household transaction with no attribution becomes the actor's own loan | `canActOnOwner(ownerUserId, viewer)`: a member creating a loan against a row attributed to somebody ELSE is refused with `NOT_YOURS_ERROR`; an admin is not |

That is the pairing `warranties/actions.ts` already uses (`:279` for the owner fallback, `:457` for
the refusal), reused rather than re-invented.

## Guard strategy

| Guard | How the implementation passes it, legitimately |
|---|---|
| `tests/ops/row-controls.test.ts` | The offence is a per-row `<form>` whose ONLY editable control is one `<select>` (every `<input>` in it `type="hidden"`, no `<textarea>`, a submit, a single-row write). The new form carries a **visible text input** (`name="loanName"`), so `inputs.length !== hidden.length` and the scanner exempts it at that exact line — the same exemption the accounts editor row and the "Add a user" card already take. It is a real two-field editor, not an auto-save cell, and the guard's own docblock names that as the shape it means to allow. **Not** an `AutoSaveSelect`: nothing may be written before a name is typed. |
| 44px targets | The sub-row uses `inputClass` / `selectClass` / `SubmitButton` from `@/components/ui/form`, which already carry the phone-height floor; the menu item is a `RowMenuButton` and inherits `ITEM_CLASS`'s `min-h-11`. No hand-rolled classes. |
| `tests/ops/use-server-exports.test.ts` | `transactions/actions.ts` gains exactly one export, `createLoanFromTransactionAction`, an `async function`. The zod schema and every helper stay module-private. |
| `tests/ops/loan-invariants.test.ts` (ruling P4) | `src/lib/loans.ts` gains no literal `'lent'`: the refusal tests `isLoanRepayment(direction, amountCents)`, the message is a constant imported from `constants.ts`, and the direction is passed through to `createWarrantyItem` unread. No arithmetic touches `interestRateBps`. |
| `tests/ops/client-bundle.test.ts` | `constants.ts` gains one import, `@/lib/money`, which has zero imports of its own. |
| `tests/ops/visibility-invariants.test.ts` | Ruling A12 — one `REQUIRE_VIEWER` entry, floor 27 → 28. |
| `tests/ops/table-layout.test.ts` | No new column: the sub-row is a `colSpan={COLUMN_COUNT}` cell, the shape `Note…` already uses. |
