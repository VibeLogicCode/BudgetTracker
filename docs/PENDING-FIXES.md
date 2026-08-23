# Pending work

Approved but not started, plus one item that has now shipped and is kept here only long enough
to record how it differed from the plan.

## 1. Split a transaction into parts — SHIPPED in v1.7.0

Raised 2026-08-22 as its own release, estimated 12 to 20 hours. The owner then chose to fold it
into v1.7.0 with everything else, and it shipped there. This section is kept because the design
that shipped is NOT the one sketched here, and anyone reading the old sketch would be misled.

**What was sketched:** the parent row becomes a container excluded from every sum, child
transaction rows carry the categories, children get a NULL `dedup_hash`.

**What shipped instead:** a separate `transaction_splits` table (migration 0009). The parent
transaction is untouched, and every category aggregate LEFT JOINs the split table and reads
`coalesce(split.category_id, transactions.category_id)` and `coalesce(split.amount_cents,
transactions.amount_cents)`. A transaction with no splits behaves exactly as before, byte for
byte, which is what let the conversion land without disturbing existing behaviour. No child
transaction rows exist, so there is nothing for dedup to collide with and nothing to exclude
from sums. The audit this file called "the part that is actually the work" was done as its own
task with its own review, as recommended.

**How the open seams were decided:**

- Per-split `attributed_user_id`: NOT built. Attribution stays whole-transaction, so both
  halves of a split land on the same person. The shared-restaurant case is therefore only half
  solved: the categories split, the person does not. Revisit if that matters in practice.
- Per-split transfer flags: NOT built. A transfer cannot be split at all, and a split
  transaction can no longer be flagged a transfer.
- Re-entering the review queue: a split transaction LEAVES the review queue, because the split
  is the answer the queue was asking for. Clearing the split puts it back.
- Editing after the fact: yes, the editor replaces all parts at once, and the sum-exactly
  invariant is re-checked on every save.
- Splitting a split: not applicable, since parts are not transactions.
- Loan matching: untouched and orthogonal, verified by review. A transaction can be both split
  and loan-linked with no interaction.
- Categorizer corpus: splits do NOT train it. A split describes one transaction, not a rule
  about that merchant.

**Worth knowing:** the review of this feature found six defects that a 3,500-test suite did not
see, five of them in the interaction between splits and code that already existed. If splits are
extended, review the interaction surface rather than the new code.

## 2. Category selects do not group children with their parents

Still not started. Unchanged in substance from when it was reported, except that the fix now has
a fourth call site.

**Reported** with a screenshot of the review screen's category select: the list ran
`... Kids, Fees, Fees > Bank Fees, Fees > Interest, Kids > Education`, so `Kids` and
`Kids > Education` were nowhere near each other.

**Verified cause. Nothing is wrong with the data, this is display ordering only.**
The review page feeds `listCategories()` straight into the select, and that returns a FLAT list
ordered by `sortOrder ASC, id ASC`. Parent and child adjacency is therefore incidental: the
seeded categories happen to sit together because they were created together, and a newly created
child gets a later id and lands at the end of the list.

**Owner ruling: order it the same way the Budgets page does.**

**This needs no new sort rule.** Budgets takes `listCategories()`, filters to top level, and
attaches each parent's children in that same order. That is exactly what the existing
`categoryTree()` helper already produces, because it preserves `listCategories()` order at both
levels. So the fix is to flatten `categoryTree()` — parent, then that parent's children — which
matches Budgets by construction rather than by re-implementing a rule that could later drift.

**Fix.** One exported helper in `src/lib/categories.ts` returning the flattened tree, then switch
every select call site to it so a future new category cannot reintroduce the bug on one screen
only. Grep for the call sites rather than trusting a line number; v1.7.0 moved several of them.
As of v1.7.0 they are the review client (two selects), the transactions client (its filter select
AND the per-part selects in the new split editor), and the managers client.

Worth a test asserting a child immediately follows its own parent, and that the order matches
what Budgets renders, so the two cannot diverge.

**About 30 to 40 minutes**, most of it in making every call site share the helper.

## 3. Nothing alerts when the balance pipeline quietly stops

Deferred during the v1.7.0 review on 2026-08-23. The disclosure half was fixed; the alert half
was not.

**The problem.** A net worth figure is built from balance snapshots that carry forward. If an
account stops producing snapshots, the last one keeps being counted at full weight. v1.7.0 added
an `accountsStale` count and says so on both the dashboard tile and the Reports card, so the
figure is no longer presented as complete when it is not. But nothing actively tells anyone.

**Why the existing alert does not cover it.** `stale_import` keys off the `imports` table, and
`runSync` writes an import row even when the balance-snapshot write inside it fails. That failure
only reaches `console.error`. So transactions can keep importing normally, `stale_import` stays
quiet because imports are arriving, and the balance side can be broken for months with no signal
except a number on a page nobody is required to look at.

**Shape of the fix.** One more event on the existing registry, so no migration: raise it from the
daily slot when any active account's newest snapshot is older than the staleness threshold, keyed
per account per week so it nags at most weekly rather than daily. `STALE_SNAPSHOT_DAYS` in
`src/lib/networth.ts` is already the threshold and should be reused rather than duplicated.
Consider also making the snapshot-write failure inside `runSync` visible rather than only logged,
since that is the specific path that breaks silently.

**Small**, an hour or two, and it is the difference between an honest number and a number someone
notices is wrong six months later.
