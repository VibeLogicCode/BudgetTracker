# Bills with due dates (and collapsed page guides) — design

**Date:** 2026-08-24
**Status:** Approved by controller (rulings C1–C8 below); further rulings B1–B16 recorded here
**Target release:** v1.12.0
**Answers:** `docs/PENDING-FIXES.md` items **N** (page guides start collapsed) and **O** (tax bills
with due dates, for reminders)
**Supersedes:** the v1.10.0 onboarding spec's "open state is derived from emptiness" rule for
`PageGuide` (Component 5 of `2026-08-23-in-app-onboarding-and-help-design.md`), on owner feedback.
The v1.11.0 auto-save and row-menu rules stay in force and this design obeys them.

---

## Problem

Two unrelated owner requests landed after v1.11.0. They ship together because one is fifteen
minutes and the other is a release on its own.

**N — page guides open themselves.** `PageGuide` renders `<GuidePanel open={empty}>`, so the "What
is this page for?" panel springs open on any page with no rows. The v1.10.0 spec argued for that:
"a screen with nothing on it is exactly when a reader needs the explanation." The owner disagrees
after living with it — a panel that opens itself is a panel in the way, and an empty page is
already explained by its `EmptyState` and its action button.

**O — no cadence expresses a property tax bill.** Today's billing model on an item is a cadence:
`BILLING_CYCLES` is `monthly | annual`, and `upcomingBills()` walks `addMonthsClamped(purchase_date,
k × step)` forward from an anchor. Property tax is two to six installments a year on fixed,
irregular dates set by a municipality — not by any interval. A "Tax" item type under the existing
`contract` kind would therefore remind on the wrong days, and a reminder that fires on the wrong day
is worse than no reminder. The cheap alternative (add Quarterly and Semi-annual cadences) was
considered and rejected in item O for the same reason: the dates are not an interval.

The machinery to deliver the reminder already exists and is not the problem. `ComingUpCard` and
`evaluateComingDue` already read items and already own the windows, the dedup and the flood guard.
What is missing is a *shape of reminder data* they can read: an explicit schedule.

---

## Rulings

Rulings marked **[controller]** are binding and were decided before this document. The rest are
choices the code forced, each with the reason it was made.

- **C1 — One release, two deliverables.** v1.12.0 ships item N and item O. **[controller]**
- **C2 — A fifth `ItemKind`, `bill`.** Not a new top-level entity: a bill is an item, so it inherits
  ownership, receipts, search, the detail page and the type-immutability rule for nothing.
  **[controller]**
- **C3 — Reminder data is an explicit schedule, not a cadence.** A child table of
  `(item_id, due_date, amount_cents, paid_at NULL, paid_txn_id NULL)` rows. One new migration,
  append-only. **[controller]**
- **C4 — For kind `bill`: no product fields, no billing cadence fields, no loan fields.** The
  schedule replaces the cadence; the three existing `*AllowedForKind` gates are extended and a
  fourth, `installmentsAllowedForKind`, is added. MUST-19.11 ("one place per wording rule") governs
  every string this introduces. **[controller]**
- **C5 — The create form gets no schedule fields.** Installments are added on the detail page after
  the item exists. **[controller]**
- **C6 — Readers, not new machinery.** The Coming-up card and the existing coming-due notification
  read unpaid installments inside the window they already use; overdue installments surface
  distinctly. No new notification channel. **[controller]**
- **C7 — Payment matching marks the earliest unpaid installment.** The existing merchant-contains +
  account rules, when they match a transaction to a bill, mark the earliest unpaid installment paid
  and record the transaction. Manual mark-paid stays. An amount mismatch does **not** block the
  match — tax bills carry penalties and rounding — and the difference is shown rather than
  suppressed. **[controller]**
- **C8 — Integer cents, ISO date strings, v1.11.0 auto-save rules for any inline edit.** Mark-paid
  is a deliberate button, not an auto-save. **[controller]**

- **B1 — `PageGuide` loses the `empty` prop entirely; it does not keep it unread.** Passing
  `open={false}` while still accepting an `empty` argument nothing reads is precisely the stale
  claim this repo's docblocks keep warning about. All nine call sites drop the prop, and three of
  them (`dashboard`, `budgets`, `reports`) keep the expression they were computing because it is
  used elsewhere on the page; the rest were computed only for the panel and go away with it.
- **B2 — The panel keeps `<details>` and keeps `GuidePanel`'s `open` prop.** `GuidePanel` still
  serves the notification setup guides, which pass `open` for their own reasons. Only `PageGuide`'s
  derivation dies. Nothing becomes a client component and nothing is persisted, so ruling A6 of the
  onboarding spec survives untouched.
- **B3 — The table is `bill_installments`, not `item_installments`.** The schema names child tables
  after the feature that owns them, not after the parent table: `loan_matcher_rules` and
  `loan_payments` both hang off `warranty_items` and neither is called `warranty_item_*`.
- **B4 — `billingAllowedForKind` becomes an explicit allowlist.** It currently reads
  `kind !== 'warranty'`, so adding a fifth kind would silently grant a bill the cadence fields C4
  forbids. It becomes `kind === 'subscription' || kind === 'contract' || kind === 'loan'`. A
  negative gate is a gate that admits every kind nobody thought about yet.
- **B5 — `bill` reuses `contract`'s wording row verbatim in `KIND_WORDING`.** `warranty_items.
  purchase_date` is `NOT NULL` and stays so (append-only), so a bill still has a start date and may
  still have an end date — those describe the *item's* life ("we have owned this property since…"),
  never the schedule. Duplicating one row of a wording matrix is not a MUST-19.11 violation; the
  rule forbids a second *place*, not a fifth row.
- **B6 — Installments are KEPT, never deleted, when a type's kind flips away from `bill`.**
  `setItemTypeKind()` clears disallowed *columns* on a flip, and that is right for a cadence nobody
  typed. Installment rows are dates and amounts a person typed by hand; deleting them on a
  Settings-page dropdown change is silent data loss. Every reader joins on `kind = 'bill'`, so kept
  rows simply go quiet and come back if the type is flipped back.
- **B7 — …and the Installments section renders whenever the item HAS installments, whatever the
  kind.** This is `productFieldsAllowedForKind`'s own documented rule applied to rows instead of
  columns: a gate decides what a form *offers*, never what it may *hide*, because hiding a stored
  value is how data gets dropped. Add and mark-paid are disabled outside kind `bill`; remove is not.
- **B8 — No inline edit of an installment; correction is remove and re-add.** C8 would put auto-save
  on a date and an amount, and an amount that saves itself on blur is a poor fit for a two-field row
  that is trivially re-entered. The loan-rules card next to it works the same way and nobody has
  asked for edit there.
- **B9 — Each installment row's actions live in a `RowMenu`.** Mark paid / Unmark and Remove is two
  actions, and v1.11.0's ruling R2 collapses two or more into one kebab. The accessible name is
  `Actions for the {amount} installment due {dueDate}` — amount *and* date, because item M of
  PENDING-FIXES is exactly the bug that a repeated single field produces.
- **B10 — `applyLoanMatchers` is renamed `applyPaymentMatchers`; there is no alias.** It now matches
  bills too, so its name would be a lie, and this repo deletes superseded helpers rather than
  keeping wrappers (see `KIND_WORDING` superseding the four boolean label helpers). Five call sites
  and their tests move with it. The `loan_matcher_rules` TABLE, `LoanRule`, `listLoanRules` and
  `saveLoanRuleAction` keep their names: their shape is unchanged, and renaming a shipped table for
  cosmetics is a migration nobody needs. The schema docblock says so out loud.
- **B11 — One pass, one transaction, one link per transaction — across both kinds.** MUST-13.4
  guarantees the rule path creates at most one link per transaction, so a loan and a bill whose
  rules both match one merchant string cannot both take the payment. That is only expressible if
  both branches share the "already linked" set, which is why B10 is a rename rather than a sibling
  function called afterwards.
- **B12 — `bill_installments.paid_txn_id` carries a UNIQUE index, and that index IS the idempotency
  guard.** Same shape as `loan_payments_txn_item_uq`. SQLite treats NULLs as distinct in a unique
  index, so the many hand-marked rows need no partial index. A matched transaction can mark at most
  one installment, for ever, whatever re-runs.
- **B13 — `paid_txn_id IS NULL` means "a person marked this".** No `source` column: the link column
  already answers the question, and a second column that must agree with it is a second column that
  can disagree with it.
- **B14 — An import undo explicitly un-marks the installments it paid, before the delete.** The
  `ON DELETE SET NULL` cascade would drop the link but cannot restore `paid_at`, leaving an
  installment marked paid by a transaction that no longer exists. This is the argument
  `reverseLoanLinksForTransactions` already makes about balances, and the new
  `reverseInstallmentLinksForTransactions` is called from the same place in `undoImport`, before
  `tx.delete(transactions)`. Keyed on `paid_txn_id IN (…)`, it can never touch a hand-marked row
  (B13).
- **B15 — No new notification event id; the `coming_due` payload carries the installment.** The
  event's payload *can* carry it: `RenderInput`'s `coming_due` member gains a
  `variant: 'item' | 'installment'` discriminator, and the installment arm carries `dueDate`,
  `amountCents` and `overdue`. Making `variant` required (not optional) forces every existing call
  site to say `variant: 'item'`, which is a compiler-checked edit rather than a silent default. The
  cost of a new id would be a new toggle in the matrix, a new prefs default, and a second switch a
  household has to find; "something is coming due" is one idea and stays one switch. Its blurb is
  reworded to name bills.
- **B16 — The overdue reminder's dedup key is bounded to a calendar month.** MUST-3.12 requires
  every dedup key to be bounded to a calendar period evaluation only visits within the current few
  days, or derived from a never-recurring timestamp. An overdue installment stays overdue for ever,
  so a date-free key (`overdue:<id>`) would be announced once and then re-announced whenever the
  400-day retention sweep pruned it — the exact resurrection MUST-3.12 forbids. Keying it
  `overdue:<installmentId>:<YYYY-MM>` makes it an honest monthly nag with a bounded key.

---

## Part 1 — Item N: page guides start collapsed

**Files:** `src/components/ui/PageGuide.tsx`, the nine call sites,
`tests/components/page-guide.test.tsx`, `tests/ops/onboarding-coverage.test.ts`.

```tsx
export function PageGuide({ children }: { children: React.ReactNode }) {
  return (
    <GuidePanel summary="What is this page for?" open={false}>
      {children}
    </GuidePanel>
  );
}
```

The docblock is rewritten, not trimmed: it currently argues *for* the derivation at some length, and
a docblock that argues for behaviour the code no longer has is worse than no docblock. The
replacement states the owner ruling, keeps the two sentences that still hold (nothing is persisted,
so no per-user flag and no migration), and names this spec.

The nine call sites (`dashboard/page.tsx`, `budgets-client.tsx`, `goals-client.tsx`,
`import-client.tsx`, `reports-client.tsx`, `review-client.tsx`, `settings/page.tsx`,
`transactions-client.tsx`, `warranties-client.tsx`) drop the prop. Per ruling B1, delete any local
that existed only to feed it; `dashboard`'s `monthIsEmpty`, and the totals/breakdown expressions in
`budgets` and `reports`, are used elsewhere on their pages and stay.

Guard 3 of `tests/ops/onboarding-coverage.test.ts` greps for the literal `<PageGuide`, which still
matches — it needs no edit, and the fact that it needs no edit is worth confirming rather than
assuming.

---

## Part 2 — Item O: bills with due dates

### Component 1 — the migration

**File:** `drizzle/0011_bill_installments.sql` (new). `drizzle/meta/_journal.json` gains
`{ "idx": 11, "version": "6", "tag": "0011_bill_installments", "breakpoints": true }`.

Two parts. The second is purely additive; the first is a table rebuild, and the paragraph after the
SQL explains why it cannot be avoided and why it is not 0010's shortcut.

```sql
-- Part 1: widen warranty_item_types.kind to admit 'bill'. Full rebuild — see below.
-- Part 2: the schedule.
CREATE TABLE `bill_installments` (
  `id`          integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `item_id`     integer NOT NULL REFERENCES `warranty_items`(`id`) ON DELETE CASCADE,
  `due_date`    text    NOT NULL CHECK (`due_date` GLOB '____-__-__'),
  `amount_cents` integer NOT NULL CHECK (`amount_cents` > 0),
  `paid_at`     text,
  `paid_txn_id` integer REFERENCES `transactions`(`id`) ON DELETE SET NULL,
  `created_at`  text    NOT NULL,
  CHECK (`paid_txn_id` IS NULL OR `paid_at` IS NOT NULL)
);
CREATE UNIQUE INDEX `bill_installments_txn_uq` ON `bill_installments` (`paid_txn_id`);
CREATE INDEX `bill_installments_item_idx`      ON `bill_installments` (`item_id`, `due_date`);
CREATE INDEX `bill_installments_due_idx`       ON `bill_installments` (`paid_at`, `due_date`);
```

**The kind CHECK is the one thing that is NOT altered.** `warranty_item_types.kind` carries
`CHECK (kind IN ('warranty','subscription','contract','loan'))` from 0004, and SQLite cannot ALTER a
CHECK. Widening it to admit `'bill'` means a full `__new_` / `INSERT … SELECT` / `DROP` / `RENAME`
rebuild of `warranty_item_types` — with the `COLLATE NOCASE` unique index re-created and both 0003
CHECKs re-declared — because 0010's header forbids the drop-and-recreate shortcut for anything
holding data nobody can regenerate, and item types are exactly that. **This rebuild is the single
riskiest step in the release and is its own implementation task**, with the 12-step shape 0010's
header spells out, plus a foreign-key-off/on pair around the rename (`warranty_items.type_id`
references it) matching how Drizzle's own generated rebuilds do it. It runs before the
`bill_installments` create so the new kind exists before anything can point at it.

The header follows 0007's and 0009's convention: the numbered inventory of objects that live in raw
SQL only (MUST-3.4). It restates entries 1–27 with 26 superseded by 0010, and adds:

- **28.** every CHECK constraint on `bill_installments` (0011)
- **29.** the widened `kind` CHECK on `warranty_item_types`, now five values, **superseding entry 11**

`bill_installments_txn_uq` is a plain unique index and *is* mirrored in `schema.ts`, so it does not
appear in the inventory.

`ON DELETE SET NULL` on `paid_txn_id` follows `warranty_items.transaction_id`'s precedent (MUST-3.7:
an import undo must not take the evidence with it) and is a backstop only — B14's explicit reversal
is what actually keeps the row honest.

### Component 2 — the schema mirror

**File:** `src/db/schema.ts`

```ts
export const billInstallments = sqliteTable(
  'bill_installments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id').notNull().references(() => warrantyItems.id, { onDelete: 'cascade' }),
    /** ISO YYYY-MM-DD. The municipality's date, typed by a person. */
    dueDate: text('due_date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** ISO timestamp, or NULL for unpaid. The one field every reader filters on. */
    paidAt: text('paid_at'),
    /** NULL means a PERSON marked this paid (ruling B13). Non-NULL means a rule matched. */
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

`warrantyItemTypes.kind`'s enum gains `'bill'`. Its docblock records that 0011 rebuilt the table to
widen the CHECK and that this is the second time a shipped table has been recreated, with the reason.

The `loanMatcherRules` docblock gains one paragraph (ruling B10): the table now also carries rules
for bill-kind items, its name is historical, and renaming a shipped table for accuracy is a cost with
no benefit — the rule row's shape did not change.

There is deliberately **no `(item_id, due_date)` unique index**. Two parcels can fall due on the same
day for the same bill, at different amounts. Ordering is therefore `due_date ASC, id ASC` everywhere,
so "the earliest unpaid installment" is total and deterministic even in that case.

### Component 3 — the kind, the gates and the wording

**File:** `src/lib/warranty/constants.ts`

```ts
export const ITEM_KINDS = ['warranty', 'subscription', 'contract', 'loan', 'bill'] as const;

export const ITEM_KIND_LABELS = { …, bill: 'Bill' };

// ruling B4: an allowlist, not a negation.
export function billingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'subscription' || kind === 'contract' || kind === 'loan';
}
export function loanFieldsAllowedForKind(kind: ItemKind): boolean { return kind === 'loan'; }
export function productFieldsAllowedForKind(kind: ItemKind): boolean { return kind === 'warranty'; }

/** v1.12.0: a due-date schedule instead of a cadence. Bills only. */
export function installmentsAllowedForKind(kind: ItemKind): boolean { return kind === 'bill'; }

/** v1.12.0: which kinds may carry merchant-matching rules at all. */
export function matchingAllowedForKind(kind: ItemKind): boolean {
  return kind === 'loan' || kind === 'bill';
}
```

`ITEM_KINDS` is the only list; `itemKindSchema = z.enum(ITEM_KINDS)` in `types.ts` and the admin
page's `<select>` both derive from it and need no edit. The three `Record<ItemKind, …>` matrices
(`KIND_WORDING`, `BILLING_WORDING`, `OPEN_ENDED_DISPLAY_LABEL`) are exhaustive record types, so the
compiler names every one that needs a `bill` row — that is the mechanism, not a checklist to
remember.

Wording added, all of it here and nowhere else (MUST-19.11):

| where | `bill` |
|---|---|
| `KIND_WORDING.bill` | ruling B5 — `contract`'s row verbatim: Start date / Term (months) / ends on / Ends / End date / In effect through / Ongoing (no end date) |
| `BILLING_WORDING.bill` | present only so the record is total, and unreachable — `billingAllowedForKind('bill')` is false, exactly as the `warranty` row's own comment explains |
| `OPEN_ENDED_DISPLAY_LABEL.bill` | `Ongoing` |
| `INSTALLMENT_SECTION_LABEL` | `Installments` |
| `installmentStateLabel(state)` | `Paid` / `Overdue` / `Due soon` / `Scheduled` |
| `MATCHING_KIND_ERROR` | replaces the string literal `'Payment matching only applies to loans.'` hard-coded in `warranties/actions.ts:531`: *"Payment matching only applies to loans and bills."* |
| `matchingBlurbForKind(kind)` | the sentence above the rules table. Loan: today's text, unchanged. Bill: "When a transaction's merchant contains this text, the app marks the next unpaid installment on this bill as paid and records which transaction paid it. The payment still counts in your budget and in your reports." |
| `INSTALLMENT_KIND_ERROR` | *"A due-date schedule only applies to bills."* |

Item-type immutability after save (v1.10.2, `ITEM_TYPE_IMMUTABLE_ERROR`) already covers the new kind
with no edit: an item saved as a bill can never become a loan, so an installment can never be
orphaned by an item edit. The only remaining path is a *type's* kind flipping, which ruling B6
handles.

**File:** `src/lib/warranty/types.ts` — `setItemTypeKind()`'s clearing pass gains one branch: a flip
*to* `bill` clears the billing pair and the four loan columns on that type's items, because both are
now disallowed. A flip *away from* `bill` clears nothing and deletes nothing (B6). The docblock says
which and why, since the asymmetry is deliberate.

### Component 4 — installments: the data layer

**File:** `src/lib/warranty/installments.ts` (new, server-side; `@/db` importer, so never imported by
a client component — the Ruling P4 constraint that governs `constants.ts`).

```ts
export type InstallmentState = 'paid' | 'overdue' | 'due_soon' | 'scheduled';

export interface InstallmentRow {
  id: number;
  itemId: number;
  dueDate: string;
  amountCents: number;
  paidAt: string | null;
  paidTxnId: number | null;
  /** Only when paidTxnId is set: what the matched transaction actually was. */
  paidTxn: { id: number; date: string; description: string; amountCents: number } | null;
  state: InstallmentState;
}

/** due_date ASC, id ASC. The total order every other function in this file relies on. */
export function listInstallments(itemId: number, today: string, dueSoonDays: number): InstallmentRow[];

export function addInstallment(input: { itemId: number; dueDate: string; amountCents: number }): InstallmentRow;
export function removeInstallment(id: number): boolean;

/** Manual mark-paid: paid_at set, paid_txn_id left NULL (ruling B13). Idempotent. */
export function markInstallmentPaid(id: number, at?: string): boolean;
/** Clears BOTH columns — an unmark of a rule-marked row also drops the link. */
export function unmarkInstallmentPaid(id: number): boolean;

/** The reader C6 needs: unpaid rows on bill-kind items, joined to owner + item name. */
export function unpaidInstallments(input: {
  today: string;
  windowEnd: string;
  includeOverdue: boolean;
  ownerUserId?: number;
}): { installmentId: number; itemId: number; itemName: string; ownerUserId: number;
      dueDate: string; amountCents: number; overdue: boolean }[];
```

`addInstallment` asserts `installmentsAllowedForKind(kindOfItem(itemId))` and throws
`INSTALLMENT_KIND_ERROR` otherwise — in the data layer, not only in the action, by the same argument
`assertBillingMatchesKind()` makes about `createWarrantyItem` staying correct for every caller.
`removeInstallment` does **not** assert the kind (ruling B7).

`state` is derived, never stored: `paid_at` non-null → `paid`; else `due_date < today` → `overdue`;
else `due_date <= addDaysIso(today, dueSoonDays)` → `due_soon`; else `scheduled`. `dueSoonDays` is
the caller's, so the detail page and the notification evaluator agree with whatever window each of
them already uses rather than inventing a third.

Amount validation reuses `parseAmountToCents` and the `amount_cents > 0` CHECK; date validation
reuses `isIsoDate`. A due date in the past is **allowed** — a household enters a bill it is already
behind on, and that is precisely the case the overdue state exists to show. `MIN_PURCHASE_DATE`'s
floor (`1970-01-01`) applies.

### Component 5 — payment matching

**File:** `src/lib/loans.ts`

`activeRules()` widens by exactly one clause pair:

```ts
.where(and(
  eq(loanMatcherRules.enabled, true),
  inArray(warrantyItemTypes.kind, ['loan', 'bill']),
  // the balance requirement is a LOAN dormancy condition, not a general one: a bill has
  // no balance to move, so requiring one would make every bill rule permanently inert.
  sql`(${warrantyItemTypes.kind} = 'bill' OR ${warrantyItems.currentBalanceCents} is not null)`,
))
```

and selects `kind` alongside the rest. `applyLoanMatchers` → **`applyPaymentMatchers`** (B10), same
signature `(txnIds, at?, report?) => number`, same single `db.transaction`, same dormancy bail, same
never-throws contract (MUST-13.5), same "payments only, negative amounts" filter, same
"first rule by id wins". Two things change inside it:

1. `alreadyLinked()` unions `loan_payments.txn_id` with `bill_installments.paid_txn_id` over the same
   chunked id set, so the one-link-per-transaction guarantee (MUST-13.4) spans both kinds (B11).
2. The apply step branches on the matched rule's kind. `kind === 'loan'` → today's `link()`,
   byte-for-byte. `kind === 'bill'` → `markEarliestUnpaid()`:

```ts
// Ruling C7: the amount is NOT compared. A tax bill arrives with penalties, discounts and
// rounding, and refusing to match on a few dollars' difference would leave the household with
// an installment that is paid and a reminder that says it is not. The transaction is recorded
// so the difference is visible on the detail page instead of being decided here.
function markEarliestUnpaid(tx, input: { txnId; itemId; at }): boolean {
  const target = tx.select({ id: billInstallments.id })
    .from(billInstallments)
    .where(and(eq(billInstallments.itemId, input.itemId), isNull(billInstallments.paidAt)))
    .orderBy(asc(billInstallments.dueDate), asc(billInstallments.id))
    .limit(1).get();
  if (target === undefined) return false;          // nothing scheduled, or all paid: no link
  const result = tx.update(billInstallments)
    .set({ paidAt: input.at, paidTxnId: input.txnId })
    .where(and(eq(billInstallments.id, target.id), isNull(billInstallments.paidAt)))
    .run();
  return result.changes > 0;
}
```

The `AND paid_at IS NULL` in the UPDATE plus `bill_installments_txn_uq` (B12) are together the
idempotency guard, the same pairing `loan_payments` uses: a re-run cannot double-mark, and one
transaction can never mark two installments. Neither `warranty_items.current_balance_cents` nor
`balance_updated_at` is touched on the bill path — a bill has no balance, and MUST-11.8's human
anchor stays a loan concept.

New, beside `reverseLoanLinksForTransactions`:

```ts
/** Ruling B14. Called from undoImport's transaction, BEFORE tx.delete(transactions). */
export function reverseInstallmentLinksForTransactions(txnIds: number[]): number;
// UPDATE bill_installments SET paid_at = NULL, paid_txn_id = NULL WHERE paid_txn_id IN (…)
```

It uses `getDb()` rather than a passed handle, joining the caller's open transaction, for the reason
the note under `reverseLoanLinksForTransactions` already states — do not change one without the
other. `src/lib/import/commit.ts:417` calls it on the same `sole` id list, immediately after the loan
reversal.

Renamed call sites: `src/lib/categorize/engine.ts` (×2), `src/lib/import/flow.ts`,
`src/lib/simplefin/sync.ts`, `src/lib/transactions.ts`, plus the two client-side comments in
`import-client.tsx` and `connections-client.tsx` that name the function. `MUST-13.16`'s guard
("exactly one place deletes a transaction row") is unaffected.

**Backfill stays loan-only.** `backfillLoanRule`'s checkbox is not rendered for a bill, and the
function refuses a bill rule. Retroactively marking twelve months of installments paid from a year of
transactions is the exact mistake that checkbox's own hint warns about, and a bill has three or four
installments a year that are one click each.

### Component 6 — the readers

**File:** `src/lib/bills.ts`

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

export function upcomingBills(input: {
  today: string;
  days: number;
  /** Ruling: default FALSE. See below. */
  includeOverdue?: boolean;
}): UpcomingBill[];
```

The cadence half is untouched — same `RECURRING_KINDS`, same `nextOccurrence`, same
`gt(billingAmountCents, 0)` fix, same expiry filter. A second query adds unpaid installments with
`due_date <= addDaysIso(today, days)` and, when `includeOverdue`, no lower bound. Both halves land in
one array and go through the existing `dueDate` ascending sort, which already puts overdue rows
first because their dates are earlier — no second sort key needed.

**`includeOverdue` defaults to false, and `safeToSpend()` keeps the default.** The dashboard card
passes `true`. The reason is that `safeToSpend`'s `billsDueCents` answers "is what is left in my
budget enough for what the rest of *this month* still owes"; folding in an installment from two years
ago that nobody ever marked paid would quietly and permanently distort that number, and it would do
so most for the household that is worst at housekeeping. The card, whose whole job is to surface the
thing you forgot, wants it.

**File:** `src/components/ComingUpCard.tsx`

The header stays "Coming up" / "Bills due in the next 30 days." with one clause appended when any
overdue row is present: "…and anything overdue." Overdue rows render with a `badge badge--red`
"Overdue" beside the date and the date in the same negative tone; due-soon and scheduled rows are
unchanged. The list total in the header keeps summing every listed row — an overdue bill is money
still owed and belongs in it — and the footer sentence, which reads `billsDueCents`, is unchanged
because that figure is unchanged (previous paragraph). The header's `aria-label` already reads
`Total due {amount}`, which stays honest.

**File:** `src/lib/notify/evaluate/coming-due.ts`

`evaluateComingDue` gains a second source before its existing loop:

- `unpaidInstallments({ today, windowEnd: addDaysIso(today, settings.comingDueDays), includeOverdue: true, ownerUserId })` — MUST-6.11's ownership rule needs no new column, because an installment's owner is its item's `owner_user_id`.
- **Overdue rows are enqueued first**, then upcoming installments, then the existing item-expiry rows. `MAX_NEW_ROWS_PER_USER_PER_EVALUATION` is shared across all three, unchanged at 20, and counting rows not items as it already does. Ordering matters only because of that cap: when it bites, the household should lose the least urgent message, not the most.
- Dedup keys (`events.ts`, beside `comingDueKey`):

```ts
/** Once per installment per due date, EVER. Editing the date is a new fact and a new key. */
export function installmentDueKey(installmentId: number, dueDate: string): string {
  return `bill:${installmentId}:${dueDate}`;
}
/** Ruling B16: once per calendar month while it stays unpaid — bounded, per MUST-3.12. */
export function installmentOverdueKey(installmentId: number, month: string): string {
  return `overdue:${installmentId}:${month}`;
}
```

  Distinct prefixes are load-bearing: `comingDueKey` is `due:<itemId>:<date>`, and an item's own end
  date can legitimately equal one of its installment due dates, which under a shared prefix would
  make one message silently suppress the other.

**File:** `src/lib/notify/render.ts` — the `coming_due` member of `RenderInput` splits on a required
`variant` (B15):

```ts
| { event: 'coming_due'; variant: 'item'; itemName; kind: ItemKind; expiryDate; todayIso; vendor; priceCents }
| { event: 'coming_due'; variant: 'installment'; itemName: string; dueDate: string;
    amountCents: number; todayIso: string; overdue: boolean }
```

Rendered:

- upcoming — subject `Coming due: {name}`, body `Bill "{name}": {amount} due {dueDate} (in N days).`
- overdue — subject `Overdue: {name}`, body `Bill "{name}": {amount} was due {dueDate} and is still unpaid (N days ago).`

`inDays()` and `money()` are the existing helpers; the noun "Bill" comes from `ITEM_KIND_LABELS`, not
from a literal. `events.ts`'s `coming_due` blurb becomes "A warranty, subscription, contract or loan
reaches its date soon, or a bill installment is due." The `id` is untouched — MUST-4.5 makes it
permanent, and renaming it would reset every stored preference.

### Component 7 — the detail page

**Files:** `src/app/(app)/warranties/[id]/page.tsx`, `warranty-detail-client.tsx`,
`src/app/(app)/warranties/actions.ts`

The page loads `listInstallments(item.id, today, 30)` and passes `installments: InstallmentRow[]`
alongside today's `rules` / `accounts` / `payoffFraction` props.

**Installments card**, rendered when `installmentsAllowedForKind(item.kind) || installments.length > 0`
(ruling B7), placed above Payment matching:

- Header: `Installments ({n} unpaid, {total} outstanding)` — outstanding sums unpaid rows only.
- One sentence: "Enter each due date the way it appears on the bill. The app reminds you before each
  one and flags any that go past."
- `TableWrap bare` inside the card, matching the loan-rules table exactly (no `fixed`, so the
  `table-layout` guard's `fixed ⇒ minWidth` pairing does not apply). Columns: **Due date · Amount ·
  Status · ⋯**, sorted `due_date ASC, id ASC`.
- Status cell: `badge badge--red` Overdue · `badge badge--amber` Due soon · `badge badge--green` Paid
  · `badge badge--muted` Scheduled. The five warranty-status hues are not reused wholesale, because
  `StatusBadge` is about an item's own lifecycle and an installment is not an item; the shared thing
  is the `.badge` primitive, which is where it should be shared.
- A rule-marked row shows, under the status, `Paid by {txn.date} · {txn.description}` as a link to
  the transaction, and **when the transaction's amount differs from the installment's, the difference
  in plain words** — `Transaction was {amount} ({diff} more than scheduled)` (ruling C7). Not an
  error, not a warning colour: a fact the household reads and decides about.
- Actions per row: `RowMenu` (B9) with **Mark paid** or **Unmark**, and **Remove**. Both are
  `RowMenuForm` over server actions — deliberate buttons, per C8 and the v1.11.0 safety rule
  (mark-paid is a judgment call; remove is destructive).
- Add form under the table: `Due date` (`type="date"`) + `Amount` (`inputMode="decimal"`) +
  `Add installment`. One `<form>`, one submit — no auto-save (B8). Errors render in the existing
  `FormError` beneath it.
- Empty state: `EmptyState` with an `action` — required by guard 1 of `onboarding-coverage.test.ts`,
  and the action is the add form's own submit target.

**Payment matching card** changes in three places and nowhere else: the gate becomes
`matchingAllowedForKind(item.kind)`; the paragraph becomes `matchingBlurbForKind(item.kind)`; the
backfill checkbox renders only for a loan. The rules table, the add form, `saveLoanRuleAction` and
`deleteLoanRuleAction` are otherwise untouched — `actions.ts:531`'s hard-coded refusal string becomes
`MATCHING_KIND_ERROR` and its condition becomes `!matchingAllowedForKind(item.kind)`.

New server actions in `warranties/actions.ts`, each `await requireUser()` (no `requireAdmin` anywhere
in this file, deliberately) and each revalidating `/warranties/{id}`, `/dashboard` and `/warranties`
through the existing helper: `addInstallmentAction`, `removeInstallmentAction`,
`setInstallmentPaidAction` (one action, a `paid` field, covering mark and unmark — two actions that
differ by a boolean are one action). All four are plain function exports, per
`tests/ops/use-server-exports.test.ts`.

**The create form is untouched.** `new-warranty-client.tsx` already computes its three fieldsets from
`billingAllowedForKind` / `loanFieldsAllowedForKind` / `productFieldsAllowedForKind`, so choosing a
bill type hides all three with no edit — which is the payoff for C4 being expressed as gates. Per C5,
no schedule fields are added; the item is saved and the installments go on next.

### Component 8 — seeding

`src/db/seed.ts` seeds categories and import profiles **only**; there are no default item types today
(`warranty_item_types` is not imported there). So, per the controller's conditional: **nothing is
seeded.** The user creates a `Property tax` type of kind `Bill` under Settings → Item types, and this
is documented in two places that already exist — the help page's Contracts & Coverage section
(`src/app/(app)/help/content.tsx`) and the warranties `PageGuide`. Adding the app's first-ever seeded
item type as a side effect of this feature would be a product decision about the empty-database
experience, made in the wrong spec.

---

## Failure and concurrency

- Two people marking the same installment paid: the `AND paid_at IS NULL` guard makes the second
  UPDATE a no-op returning `changes === 0`; the action treats that as success, because the desired
  state holds. The stale-delete case has somewhere to surface, matching the F3 fix-round treatment on
  the loan-rules table: removing an already-removed installment says "That installment no longer
  exists."
- A rule matching a bill with no unpaid installments left creates **no link and no error**. The
  transaction is a normal transaction, the household sees it on `/transactions`, and nothing is
  fabricated. It is also not marked "already linked", so a later-added installment is matched by the
  next import that touches that transaction — but the rule path never revisits an old transaction on
  its own, and backfill is loan-only, so in practice this is the hand-mark case and says so in the
  card's copy.
- `applyPaymentMatchers` keeps MUST-13.5: it never throws into an import, a sync, a manual entry or a
  category confirmation. The bill branch is inside the same try/catch and the same transaction.
- Deleting a bill item cascades its installments (`ON DELETE CASCADE`), exactly as it already
  cascades receipts and matcher rules.

---

## Testing

1. **Migration** (`tests/db/migration-0011.test.ts`): the `warranty_item_types` rebuild preserves
   every existing row, its `COLLATE NOCASE` unique index still folds `'Laptop'`/`'laptop'`, both 0003
   CHECKs still bite, `kind = 'bill'` is now accepted and `kind = 'nonsense'` is still refused, and
   `warranty_items.type_id`'s foreign key still resolves after the rename. Then: `bill_installments`
   exists with its four CHECKs enforced (`amount_cents <= 0` refused, malformed `due_date` refused,
   `paid_txn_id` without `paid_at` refused), `bill_installments_txn_uq` refuses a second row with the
   same `paid_txn_id` and accepts many NULLs, and the cascade fires on item delete.
2. **Gates** (`tests/lib/warranty/constants.test.ts`, extended): all five kinds against all five
   gates as a table — `billingAllowedForKind('bill')` false is the case B4 exists for, and the table
   form is what stops a sixth kind slipping through a negation. Every `Record<ItemKind, …>` matrix
   has five keys. `ITEM_KIND_LABELS` covers `ITEM_KINDS` exactly.
3. **Installment CRUD and paid toggling** (`tests/lib/warranty/installments.test.ts`): add rejects a
   non-bill item with `INSTALLMENT_KIND_ERROR`; remove does not (B7); listing is ordered
   `due_date, id` including the same-date tie; the four states derive correctly around the `today`
   and `dueSoonDays` boundaries, both edges inclusive as specified; mark → unmark → mark is
   idempotent and clears **both** columns on unmark; a hand-marked row keeps `paid_txn_id` NULL.
4. **Kind flip** (`tests/lib/warranty/types.test.ts`, extended): flipping a type to `bill` clears the
   billing pair and the loan columns on its items; flipping away from `bill` deletes **no**
   installment rows (B6) and the rows reappear when it is flipped back.
5. **Coming-up inclusion and overdue** (`tests/lib/bills.test.ts`, extended): an unpaid installment
   inside the window appears with `overdue: false` and its `installmentId`; a paid one never appears;
   an overdue one appears only with `includeOverdue: true` and sorts ahead of everything; cadence
   bills are unchanged in the same call; `safeToSpend()` does **not** move when an ancient unpaid
   installment exists, which is the regression the default guards.
6. **Notification inclusion and overdue** (`tests/lib/notify/evaluate/coming-due.test.ts`, extended):
   an installment inside `comingDueDays` enqueues one row per channel under
   `installmentDueKey`; a second evaluation the next day enqueues nothing; an overdue installment
   enqueues under `installmentOverdueKey` and enqueues **again** the following calendar month but not
   the following day (B16); an item whose expiry equals one of its installment due dates produces two
   distinct rows, not one; the shared flood cap truncates upcoming before overdue.
   `tests/lib/notify/render.test.ts` gains both installment bodies and the `variant: 'item'` edit.
7. **Payment matching** (`tests/lib/loans.test.ts` / a new `payment-matchers.test.ts`): a rule on a
   bill marks the **earliest** unpaid installment, not the nearest by amount and not the first by id
   — pinned with a schedule whose earliest row is deliberately the largest; a second run of
   `applyPaymentMatchers` over the same transaction marks nothing more; a transaction matching both a
   loan rule and a bill rule links exactly once (B11); an amount mismatch still matches and records
   the transaction (C7); a bill with every installment paid produces no link and no throw; a bill
   rule never moves `current_balance_cents`; an import undo un-marks the installments that import
   paid and leaves hand-marked ones alone (B14). `tests/ops/loan-invariants.test.ts` is re-read after
   the rename — its three greps target `src/lib/loans.ts` by path and by symbol, so the rename must
   not quietly narrow one of them to nothing.
8. **PageGuide default and the guard** (`tests/components/page-guide.test.tsx`): the two derivation
   tests are **replaced**, not deleted, by one that asserts `details.open === false` and no `open`
   attribute, plus a note naming this spec as the reversal — a deleted test leaves no record that the
   behaviour was once the opposite. The summary-text and children tests stand.
   `tests/ops/onboarding-coverage.test.ts` guard 3 is re-run to confirm the literal `<PageGuide` grep
   still matches all nine pages after the prop is dropped.
9. **Ops guards stay green, unedited:** `use-server-exports.test.ts` (four new actions),
   `row-controls.test.ts` (the new card pairs no `<select` with a `SubmitButton`),
   `table-layout.test.ts` (the installments table is not `fixed`, so it needs no `minWidth`),
   `client-bundle.test.ts` (`installments.ts` imports `@/db` and must never reach a client component
   — the detail client takes rows as props), `onboarding-coverage.test.ts` guard 1 (the new
   `EmptyState` passes `action=`).
10. **Real-browser check, before any push (non-negotiable, the v1.10.1 lesson).** Playwright against
    a running dev build at **390** and **1280** px, on `/warranties/{id}` for a bill carrying at
    least one overdue, one due-soon, one scheduled and one rule-marked installment:
    - no horizontal scroll on the page at 1280; the installments table scrolls inside its own box at
      390 and nothing else does;
    - the row kebab opens un-clipped **from the last row**, including when that row is the last thing
      on the page (the `position: fixed` upward-opening path);
    - the four status badges are distinguishable and legible in both themes;
    - the add form's date and amount inputs are usable at 390 without zoom, and the mismatch sentence
      wraps rather than overflowing;
    - the page guide on `/warranties` is **collapsed** on load, on a page with rows and on a page
      without;
    - the dashboard Coming-up card at both widths with an overdue row present.

---

## What this does NOT build

- **No recurring-schedule generator.** The user types each date. The dates are irregular by
  definition — that is the entire reason this design exists rather than two new cadences.
- **No partial payments.** An installment is unpaid or paid. A part-payment ledger is a second
  amount column, a running remainder, and a reconciliation rule, for a case nobody has reported.
- **No amortization, interest or penalty maths.** Consistent with MUST-13.1, which keeps a loan's
  own rate display-only.
- **No changes to `BILLING_CYCLES`.** No Quarterly, no Semi-annual. Item O's cheaper alternative
  stays rejected; adding it now would give a household two ways to express the same bill and no
  reason to prefer either.
- **No calendar export.** No `.ics`, no feed. It would be the first outbound artifact in an app whose
  zero-egress claim is a feature.
- **No backfill for bill rules.** Loan-only (Component 5).
- **No inline editing of an installment.** Remove and re-add (B8).
- **No bill entry from the transactions page.** A bill is created where every other item is created.
- **No new notification channel, and no new event id.** (C6, B15.)

---

## Release

v1.12.0. Build by Opus/Sonnet subagents per the implementation plan; owner reviews between tasks.
Suggested task order, chosen so nothing lands half-wired: (1) item N, standalone and shippable
alone; (2) the `warranty_item_types` rebuild migration and the `bill_installments` table, with test 1
green before anything reads them; (3) constants, gates and wording; (4) `installments.ts` plus the
detail-page card and actions; (5) the two readers; (6) payment matching and the rename. Same tag and
GHCR flow as prior releases.
