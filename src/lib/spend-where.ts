import { eq, sql, type SQL } from 'drizzle-orm';
import { loanPayments, transactions, warrantyItems } from '@/db/schema';

/**
 * The single definition of "a row that counts as spend" (C-02 fix). Before this module existed,
 * `reports.ts` was the only caller that excluded loan principal movements (NOT_PRINCIPAL_MOVEMENT,
 * below) -- `budgets.ts`, `predict/history.ts`, `tax.ts`, `insights.ts` and
 * `notify/evaluate/anomalies.ts` all filtered on `is_transfer = 0` alone, so a loan-linked row
 * (still eligible for auto-categorisation -- see `ELIGIBLE` in `src/lib/categorize/engine.ts`)
 * could land under a real category and then read as $0 spend on Reports while reading as
 * thousands of dollars of spend (or a phantom refund) on Budgets. Every spend aggregate in this
 * app composes from `SPEND_ROW_WHERE` below so the two surfaces cannot disagree again.
 *
 * Imports ONLY `drizzle-orm` and `@/db/schema`, deliberately -- `budgets.ts` must never import
 * `reports.ts` (see reports.ts's own history: it grew a `next/cache`-adjacent server-only
 * dependency more than once), so this rule cannot be exported FROM reports.ts the way it used to
 * live there. Living in its own leaf module means any of budgets.ts/predict/history.ts/tax.ts/
 * insights.ts/notify/evaluate/anomalies.ts/reports.ts can import it with no cycle.
 */

/** A transfer between two of the household's own accounts is never spend or income. */
export const NOT_TRANSFER: SQL = eq(transactions.isTransfer, false);

/**
 * v1.21.0 (2026-08-30 plan, item 8a; revised same day after coordinator review -- see below). A
 * transaction linked to a loan moves loan PRINCIPAL, and principal is not always spend or income
 * -- restating the plan's classification table:
 *
 *   money out, 'lent' loan  -- lending money out      -- NOT spend  (cash becomes a receivable)
 *   money in,  'lent' loan  -- being repaid            -- NOT income (a receivable becomes cash)
 *   money in,  'owed' loan  -- borrowing                -- NOT income
 *   money out, 'owed' loan  -- repaying what we owe    -- SPEND, deliberately (MUST-13.2)
 *
 * Only the last row is real consumption -- a car payment is money the household will never see
 * again, exactly like any other bill, which is what MUST-13.2 exists to protect. The other three
 * convert one asset into another (cash into a receivable, or back) without changing how much was
 * earned or spent; counting any of them as spend or income double-books the same dollar as both
 * "money moved" and "money consumed/earned".
 *
 * CORRELATED, not materialized. The first version of this fix computed a JS-side Set<number> of
 * excluded ids via one unfiltered three-table scan of the WHOLE loan_payments/warranty_items
 * history, then ran it again at every one of rangeClauses' 7 call sites, and fed the result into
 * `notInArray(transactions.id, [...ids])`. Both halves were wrong at scale: MUST-16.3 budgets a
 * page's grouped aggregates deliberately, and an unfiltered scan repeated 7 times has no such
 * budget; and notInArray splats one bind parameter per excluded id, which runs into SQLite's
 * SQLITE_MAX_VARIABLE_NUMBER ceiling on a household with years of loan payments -- discoverable
 * only on the largest, oldest databases, the worst possible time. This version instead lets
 * SQLite decide inclusion per ROW via `loan_payments_txn_idx`, the same `not exists (select 1
 * from ... where ...)` idiom REVIEW_WHERE (src/lib/categorize/engine.ts) already uses for the
 * identical reason -- nothing is materialized into JS, and no bind parameter count scales with
 * history.
 *
 * Whole-transaction, not split-aware: `loan_payments.txn_id` names a whole transaction -- the
 * same row `transactions.amount_cents` belongs to -- and there is no split-part counterpart to
 * join against here the way EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) give the
 * rest of this file for category totals.
 *
 * Every row this reads is a LOAN's own direction, never a bill's absence of one:
 * `applyPaymentMatchers` (src/lib/loans.ts) routes a bill-kind match to `bill_installments`
 * instead of `loan_payments`, and `assignTransactionToLoan`'s `itemId` is always a loan by
 * construction of the loan picker that calls it. `loan_payments` rows are loan-kind, full stop.
 *
 * MUST-11.16 tie-break -- worth deriving carefully, because the obvious single NOT EXISTS gets
 * it backwards. One transaction may legitimately fund two loans, and MUST-13.2 requires that it
 * stays counted as spend the moment ANY linked loan makes it an owed-loan repayment (money out,
 * 'owed'), regardless of what a second link on the same row says. A single
 * `not exists (select ... where txn_id = transactions.id and not (owed-repayment))` would instead
 * implement the WRONG quantifier: "keep only if EVERY link is an owed-repayment", i.e. it would
 * EXCLUDE a transaction the instant any one of its links is not a repayment -- exactly the
 * failure MUST-13.2 forbids, applied to a row that also, coincidentally, repays a real debt. The
 * correct rule is existential, not universal: keep this row if it has NO loan link at all, OR at
 * least ONE of its links is an owed-repayment. That is the OR of two independent correlated
 * subqueries below, not a single inverted NOT EXISTS. tests/lib/reports.test.ts's own
 * MUST-11.16 case pins this: a transaction linked to both an owed loan (a repayment) and a lent
 * loan (growth, not a repayment) must still count as spend in full.
 */
export const NOT_PRINCIPAL_MOVEMENT: SQL = sql`(
  not exists (select 1 from ${loanPayments} where ${loanPayments.txnId} = ${transactions.id})
  or exists (
    select 1 from ${loanPayments}
    inner join ${warrantyItems} on ${warrantyItems.id} = ${loanPayments.itemId}
    where ${loanPayments.txnId} = ${transactions.id}
      and ${transactions.amountCents} < 0
      and ${warrantyItems.loanDirection} = ${'owed'}
  )
)`;

/** Both, for the callers that want the whole rule. Spread into an existing `clauses` array. */
export const SPEND_ROW_WHERE: SQL[] = [NOT_TRANSFER, NOT_PRINCIPAL_MOVEMENT];
