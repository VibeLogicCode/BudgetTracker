# Pending work

Approved but not started. Both items were raised by the owner on 2026-08-22, after v1.5.1
shipped and while v1.6.0 (import attribution) was still building. The owner will have these
planned separately, so this file records the diagnosis, the decisions already made, and the
open questions, so none of it has to be re-derived.

Nothing here is started. Neither item is in v1.6.0.

## 1. Split a transaction into parts

**Why.** Two real cases the app cannot express today:

- A restaurant bill shared with someone else. Only part of it is the household's spending.
- A deposit that is partly real income and partly a reimbursement of a company purchase the
  owner put on a personal card.

The only tool today is the whole-row transfer flag, which is all-or-nothing. Marking a
combined deposit as a transfer hides real income; leaving it as income inflates income by the
reimbursed amount. Both cases are the canonical reason personal-finance tools have splits.

**Estimated 12 to 20 hours.** Its own release, not a bolt-on. The feature itself is small;
the cost is the blast radius across every aggregate.

### Shape that fits this codebase

`amount_cents` is immutable by design and grep-guarded, so a split cannot reduce the original
row and add siblings. The workable shape:

- The parent row stays exactly as imported and keeps its `dedup_hash`, so a future import of
  the same statement still deduplicates against it.
- The parent becomes a container that is excluded from every sum.
- Children carry the categories, and must sum to the parent exactly in integer cents, with no
  rounding slack, enforced inside one transaction.
- Children get a NULL `dedup_hash`, the way manual rows already do (`src/lib/import/dedup.ts`
  notes that manual rows with a NULL hash can never match), so they can never collide with a
  future import.

### Owner decisions already made (2026-08-22)

- **Undo import: CASCADE.** If the parent is deleted by an undo, its children go with it. Do
  not refuse the undo.
- **Categorizer learning corpus: whichever is more logical**, provided reporting stays
  correct. (Children carrying the categories is the natural reading, but it changes what the
  Bayes corpus learns from a split row, so state the choice explicitly when planning.)
- **Backup/restore compatibility: do not gold-plate it.** Confirmed by the owner on
  2026-08-22: **everything currently on the NAS is dummy data**, imported for testing, and the
  owner intends to recreate the install from scratch once the current round of bugs is ironed
  out. So there is no real household history to protect yet, and a migration for this feature
  does not need elaborate cross-version restore scaffolding or careful preservation of
  existing rows. It does still need to work on a fresh database, which is the easy path.
  Revisit this the moment the owner does their real install and starts importing genuine
  statements, because that is the point at which migrations stop being cheap.

### The part that is actually the work

**Every aggregate must be audited for double-counting**, because a parent plus its children
both existing means any query that does not exclude containers counts the amount twice:

- `src/lib/budgets.ts`
- `src/lib/reports.ts` (categorySpend, categoryBreakdown, categoryMonthOverMonth,
  cashflowTrend, topMerchants)
- the dashboard
- the transactions list and its filters
- CSV export
- `src/lib/predict/*`
- `src/lib/goals.ts`
- `src/lib/loans.ts`

This is not hypothetical. v1.4.0's final review caught a `predicted_vs_actual` total that
double-counted in exactly this shape, parent plus child and then household plus personal. The
plan should make this audit an explicit task with its own review, not a step someone is
expected to notice.

### Other seams to decide when planning

- Per-split `attributed_user_id` falls out naturally and is what makes the shared-restaurant
  case work properly. Per-split transfer flags are what make the bundled-deposit case work.
- Whether a split row can re-enter the review queue.
- Whether a split can itself be split, or edited after the fact, and what happens to the
  sum-exactly invariant then.
- Loan matching reads transactions and has its own `applied_cents` bookkeeping.

### Workaround available today, no code

For a combined deposit: categorize the real deposit as income, and add a manual transaction
for the reimbursed portion marked as transfer. Manual rows carry a NULL dedup hash so they
never collide with future imports. The two rows are not linked, and it is clumsy, but it keeps
both income and spending honest, which the whole-row transfer flag cannot.

## 2. Category selects do not group children with their parents

**Reported** with a screenshot of the review screen's category select: the list ran
`... Kids, Fees, Fees > Bank Fees, Fees > Interest, Kids > Education`, so `Kids` and
`Kids > Education` were nowhere near each other.

**Verified cause. Nothing is wrong with the data, this is display ordering only.**
`src/app/(app)/review/page.tsx:16` feeds `listCategories()` straight into the select, and that
returns a FLAT list ordered by `sortOrder ASC, id ASC` (`src/lib/categories.ts:21`). Parent and
child adjacency is therefore incidental: the seeded categories happen to sit together because
they were created together, and a newly created child gets a later id and lands at the end of
the list. `Kids > Education` was created recently, so it sorts last.

**Owner ruling: order it the same way the Budgets page does.**

**This needs no new sort rule.** Budgets takes `listCategories()`, filters to top level, and
attaches each parent's children in that same order (`src/lib/budgets.ts:195-201`). That is
exactly what the existing `categoryTree()` helper already produces (`src/lib/categories.ts:25`),
because it preserves `listCategories()` order at both levels. So the fix is to flatten
`categoryTree()` — parent, then that parent's children — which matches Budgets by
construction rather than by re-implementing a rule that could later drift apart.

**Fix.** One exported helper in `src/lib/categories.ts` that returns the flattened tree, then
switch all three select call sites to it so a future new category cannot reintroduce the bug
on one screen only:

- `src/app/(app)/review/review-client.tsx:104` and `:120`
- `src/app/(app)/transactions/transactions-client.tsx:290`
- `src/app/(app)/settings/managers/managers-client.tsx:160`

Worth a test asserting a child immediately follows its own parent, and that the order matches
what Budgets renders, so the two cannot diverge.

**About 30 to 40 minutes**, most of it in making all three call sites share the helper.
