import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountBalanceSnapshots, transactions } from '@/db/schema';
import type { Db } from '@/db/client';

/**
 * The balance resolver (spec 2026-08-23, v1.8.0, Task 4). Answers "what did this account hold
 * on date D" as the newest balance snapshot at or before D, plus the signed sum of every
 * transaction strictly after that snapshot's own date and up to and including D. A statement
 * CSV is a complete ledger of an account -- every charge, payment, fee and interest line is a
 * row -- so that sum is exact, not approximate, and entering a fresh snapshot at any date
 * re-anchors everything after it (ruling R2 below).
 *
 * This is the ONLY function in the app that turns a snapshot plus transactions into a balance.
 * src/lib/networth.ts routes both `latestSnapshots` and `netWorthOverTime` through it rather
 * than reading `account_balance_snapshots` on its own, so a balance shown anywhere -- Settings
 * -> Accounts, net worth over time -- reflects movement since its underlying snapshot instead
 * of a number that can only ever get staler between imports.
 *
 * ============================================================================================
 * RULING R1 -- READ THIS TWICE BEFORE TOUCHING THIS FILE (spec 2026-08-23, v1.8.0). This is,
 * in the spec's own words, "the single most dangerous line in the release."
 * ============================================================================================
 * The transaction sum below reads transactions.amount_cents RAW, straight off the parent
 * table: no is_transfer predicate, no join to the splits table, no category predicate. Do NOT
 * "clean this up" by importing a helper from src/lib/budgets.ts, src/lib/reports.ts or
 * src/lib/categorize/engine.ts -- every one of those carries a filter that is CORRECT for
 * spend reporting and CATASTROPHICALLY WRONG here:
 *
 *   - The transfer flag. A credit-card payment is normally marked as a transfer specifically
 *     to keep it OUT of spend totals -- it is money moving between two of the household's own
 *     accounts, not spend. If this resolver inherited that filter, every card payment would
 *     vanish from the balance calculation and the card's balance would climb forever while
 *     looking entirely plausible. No crash, no error -- just a slowly, confidently wrong
 *     number.
 *   - The splits table, and the split-aware coalesce helper in src/lib/splits.ts. A split
 *     divides one transaction across CATEGORIES for reporting, but the money that actually
 *     moved through the account is still the PARENT row's own amount -- that is the true
 *     movement, always. Reading through the split-aware helper here would either double count
 *     (summing both the parts and the parent) or silently fan one transaction out into several
 *     rows. Neither belongs anywhere in this file.
 *   - Category filters. A balance does not care what a transaction was categorized as, or
 *     whether it was categorized at all. An uncategorized transaction still moved money.
 *
 * tests/lib/balance.test.ts pins both traps with fixtures (a transfer-flagged card payment, a
 * split transaction). tests/ops/balance-invariants.test.ts is a second, independent guard: a
 * grep over this file's own source (comments stripped, so this very docblock is exempt)
 * asserting the CODE never mentions the splits table, the transfer flag, or the split-aware
 * amount helper by name, and never imports from the three spend-aggregate modules named above
 * -- so a future change that reintroduces the bug fails a test even when whatever fixture
 * motivated the change does not happen to cover it.
 *
 * RULING R2 -- the newest snapshot at or before the date wins, then the sum runs FORWARD from
 * it. Never sum from the oldest snapshot, and never sum across a newer snapshot that sits
 * between the anchor and the target date -- a snapshot is a hard re-anchor, correct for every
 * date after it regardless of what came before. That is what makes drift self-healing, which
 * is the entire reason this release caches nothing (see "What this release does NOT build" in
 * the v1.8.0 spec): a wrong number corrects itself the next time a real balance is recorded,
 * rather than compounding forever the way an incremented running total would.
 *
 * v1.8.0 Task 5 (spec 2026-08-23) adds `movementBetween` below, a second, narrower export this
 * file offers for src/lib/balance-reconcile.ts's reconciliation: the raw signed sum of
 * transactions.amount_cents for one account, strictly after one EXPLICIT date and up to and
 * including another -- no anchor lookup, because reconciliation already knows both dates (they
 * are two of the account's own source='csv' snapshots) and only needs the movement between them
 * checksummed against what the statement itself says changed. RULING R1 above applies to this
 * sum identically and for the identical reason: a transfer-flagged credit-card payment between
 * two statement dates is real money that moved through the account, and filtering it out would
 * flag a perfectly clean statement as a missing import. `movementBetween` lives HERE, not
 * re-derived in balance-reconcile.ts, so R1's guarantee has exactly ONE implementation for both
 * of this release's balance features to share -- guarded by the same tests/ops/
 * balance-invariants.test.ts grep that already covers this file, extended to cover that one too.
 */

export interface ResolvedBalance {
  accountId: number;
  balanceCents: number;
  /** The snapshot the sum was anchored on. */
  anchorDate: string;
  anchorSource: 'simplefin' | 'manual' | 'csv';
  /** Transactions summed forward from the anchor. 0 means the snapshot is exact for `date`. */
  movedSinceCents: number;
}

/**
 * The newest-snapshot-per-account building block both queries in `balancesAsOf` join against:
 * max(date) grouped by account, restricted to the accounts asked for and to snapshots at or
 * before `date` (ruling R2's "at or before"). A fresh call returns a fresh subquery object --
 * each of the two callers below builds and uses its own, rather than one query-builder object
 * built once and reused across two unrelated top-level statements.
 */
function anchorDatesByAccount(db: Db, accountIds: number[], date: string) {
  return db
    .select({
      accountId: accountBalanceSnapshots.accountId,
      anchorDate: sql<string>`max(${accountBalanceSnapshots.date})`.as('anchor_date'),
    })
    .from(accountBalanceSnapshots)
    .where(and(inArray(accountBalanceSnapshots.accountId, accountIds), lte(accountBalanceSnapshots.date, date)))
    .groupBy(accountBalanceSnapshots.accountId)
    .as('anchor_dates');
}

/**
 * Resolves every account in `accountIds` as of `date` in exactly two queries, however many
 * accounts are asked for -- one to find each account's own anchor snapshot, one to sum the
 * movement since each account's own anchor in a single batched join (accounts can be anchored
 * on different dates, which is why this needs a join rather than one shared WHERE clause).
 * Neither query runs inside a loop, so netWorthOverTime (src/lib/networth.ts) can call this
 * once per report point without turning into an N+1-accounts problem.
 *
 * An account with no snapshot at or before `date` is simply ABSENT from the returned map --
 * nothing to anchor on, so nothing to resolve. Callers distinguish "no balance yet" from "a
 * zero balance" with `.has()` / `.get() ?? null`, the same absence-means-unknown convention
 * `latestSnapshots` already used for one account at a time.
 */
export function balancesAsOf(input: { accountIds: number[]; date: string }): Map<number, ResolvedBalance> {
  const { accountIds, date } = input;
  const out = new Map<number, ResolvedBalance>();
  if (accountIds.length === 0) return out;

  const db = getDb();

  // Ruling R2: each account's own newest snapshot at or before `date`, with that row's own
  // balance and source -- same grouped-subquery-then-join shape latestSnapshots already used.
  const anchorSubquery = anchorDatesByAccount(db, accountIds, date);
  const anchors = db
    .select({
      accountId: accountBalanceSnapshots.accountId,
      anchorDate: accountBalanceSnapshots.date,
      balanceCents: accountBalanceSnapshots.balanceCents,
      source: accountBalanceSnapshots.source,
    })
    .from(accountBalanceSnapshots)
    .innerJoin(
      anchorSubquery,
      and(eq(anchorSubquery.accountId, accountBalanceSnapshots.accountId), eq(anchorSubquery.anchorDate, accountBalanceSnapshots.date)),
    )
    .all();
  if (anchors.length === 0) return out;

  // RULING R1: raw transactions.amount_cents, no transfer predicate, no splits join, no
  // category predicate -- see this file's header docblock. The join's only purpose is to
  // compare each transaction's date against ITS OWN account's anchor date, since two accounts
  // in the same batch can be anchored on two different dates; a single WHERE clause cannot
  // express a different lower bound per account.
  const movedSubquery = anchorDatesByAccount(db, accountIds, date);
  const movedRows = db
    .select({
      accountId: transactions.accountId,
      movedCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`.as('moved_cents'),
    })
    .from(transactions)
    .innerJoin(movedSubquery, eq(movedSubquery.accountId, transactions.accountId))
    .where(and(inArray(transactions.accountId, accountIds), gt(transactions.date, movedSubquery.anchorDate), lte(transactions.date, date)))
    .groupBy(transactions.accountId)
    .all();
  const movedByAccount = new Map(movedRows.map((row) => [row.accountId, row.movedCents]));

  for (const anchor of anchors) {
    const movedSinceCents = movedByAccount.get(anchor.accountId) ?? 0;
    out.set(anchor.accountId, {
      accountId: anchor.accountId,
      balanceCents: anchor.balanceCents + movedSinceCents,
      anchorDate: anchor.anchorDate,
      anchorSource: anchor.source,
      movedSinceCents,
    });
  }
  return out;
}

/**
 * Single-account convenience wrapper over `balancesAsOf` -- there is exactly one
 * implementation of ruling R1's dangerous sum in this file, and every caller (single-account or
 * batch) goes through it. null when the account has no snapshot at or before `date` -- nothing
 * to anchor on.
 */
export function balanceAsOf(input: { accountId: number; date: string }): ResolvedBalance | null {
  return balancesAsOf({ accountIds: [input.accountId], date: input.date }).get(input.accountId) ?? null;
}

/**
 * The raw movement of money through one account, strictly after `afterDate` and up to and
 * including `throughDate` -- v1.8.0 Task 5's building block for
 * src/lib/balance-reconcile.ts's reconcileAccount, which asks a narrower question than
 * balanceAsOf above: not "what is the balance on date D", but "how much moved between two
 * ALREADY-KNOWN statement dates, so that figure can be checksummed against what the statement
 * itself says changed." Same ruling R1 as this file's header docblock, applied to a single
 * account and an explicit date range instead of a batch anchored on balancesAsOf's own
 * newest-snapshot lookup: raw transactions.amount_cents, no is_transfer predicate, no splits
 * join, no category predicate.
 *
 * `afterDate` is exclusive and `throughDate` is inclusive, matching balancesAsOf's own
 * anchor-to-target convention (ruling R2: a snapshot is that date's CLOSING balance, so the day
 * a range starts from is already inside the earlier figure and must not be summed again).
 *
 * Returns 0, never null, for a range with no matching transactions -- unlike balanceAsOf there
 * is no "nothing to anchor on" case here, because the caller already supplies both dates: an
 * empty account, or an empty date range, genuinely moved zero cents.
 */
export function movementBetween(input: { accountId: number; afterDate: string; throughDate: string }): number {
  const { accountId, afterDate, throughDate } = input;

  // RULING R1: raw transactions.amount_cents, no transfer predicate, no splits join, no
  // category predicate -- see this file's header docblock.
  const row = getDb()
    .select({ movedCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)`.as('moved_cents') })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), gt(transactions.date, afterDate), lte(transactions.date, throughDate)))
    .get();
  return row?.movedCents ?? 0;
}
