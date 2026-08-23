import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountBalanceSnapshots } from '@/db/schema';
import { movementBetween } from '@/lib/balance';

/**
 * Reconciliation: the balance column as a checksum (spec 2026-08-23, v1.8.0, Task 5). Two
 * consecutive source='csv' snapshots are the bank's OWN statement balances for two dates --
 * not a manual guess, not a SimpleFIN sync, but the bank's own running-balance column, read by
 * src/lib/import/parse.ts's closingBalancesByDate at import time and ranked above the other two
 * sources for exactly this reason (see src/lib/balance.ts's header docblock, ruling R3). The
 * transactions imported between those two dates should account for EXACTLY the difference
 * between them. When they do not, the arithmetic itself says an import is missing rows, and the
 * pair of dates says which statement period to go check.
 *
 * RULING R7 -- reconciliation REPORTS, it never corrects. This module has no write path at all:
 * no adjusting transaction, no plug entry, nothing inserted or updated anywhere. A Discrepancy
 * is read-only evidence for a person to go re-import the missing statement; this file cannot
 * act on it even by accident, because there is nothing here that writes.
 *
 * RULING R1 applies here identically to src/lib/balance.ts, and for the identical reason: a
 * credit-card payment is normally is_transfer=1 to keep it out of spend reporting, but the
 * money still moved through the account and the bank's own statement balance reflects it. If
 * this module summed transactions itself -- with any of balanceAsOf's forbidden filters, or
 * even with no filter but its OWN re-derived sum, which could just as easily drift from
 * balance.ts's over time -- a transfer-flagged payment could vanish from `impliedCents` and a
 * perfectly clean statement would wrongly read as a missing import. So this file has NO
 * transaction sum of its own: every movement figure comes from `movementBetween`
 * (src/lib/balance.ts), the one place R1's raw sum is implemented. tests/ops/
 * balance-invariants.test.ts's grep covers this file the same way it already covers that one.
 *
 * Only `source='csv'` snapshots are valid reconciliation endpoints. A `manual` figure is a
 * household member's own typed guess and a `simplefin` figure is a live sync balance -- neither
 * is the bank's own per-transaction ledger, so neither disagreeing with the transactions around
 * it is evidence of anything. Both are simply excluded from the ordered list this file walks;
 * they never even appear as an intermediate point, since reconciliation only ever compares two
 * ADJACENT csv snapshots to each other, never a csv snapshot to whatever happens to sit between
 * them chronologically.
 */

export interface Discrepancy {
  accountId: number;
  /** The OLDER of the two consecutive csv-sourced statement dates being compared. */
  fromDate: string;
  /** The NEWER of the two consecutive csv-sourced statement dates being compared. */
  toDate: string;
  /** toDate's own stated balance -- the bank's figure for that date, taken as ground truth. */
  expectedCents: number;
  /**
   * fromDate's stated balance plus the raw movement between the two dates (ruling R1,
   * `movementBetween`), per this app's OWN imported transactions. Equal to expectedCents when
   * nothing is missing.
   */
  impliedCents: number;
  /**
   * impliedCents - expectedCents. Positive means the transactions imported for this account add
   * up to MORE than the bank says the account actually holds on toDate -- the statement reads
   * LOWER than our own rows account for; negative is the exact mirror image. Never zero: a zero
   * difference means no discrepancy at all, so reconcileAccount omits that pair entirely rather
   * than reporting a Discrepancy of 0.
   */
  deltaCents: number;
}

/**
 * Walks one account's `source='csv'` snapshots in date order and checksums every consecutive
 * PAIR: `impliedCents` is the older snapshot's own balance plus `movementBetween` (ruling R1,
 * src/lib/balance.ts) over `(fromDate, toDate]`, compared against the newer snapshot's own
 * stated balance. A non-zero difference becomes one `Discrepancy`; an exact match produces
 * nothing for that pair. Needs no `today` and no anchor lookup -- this reconciles RECORDED
 * history between two dates that already happened, which needs no notion of "now" at all.
 *
 * Fewer than two `source='csv'` snapshots for the account (zero or one) has no pair to compare
 * and returns `[]` -- there is nothing to check yet, which is a different thing from having
 * checked and found agreement, but this function's contract does not distinguish the two: an
 * empty array means "no discrepancy found," in either case.
 */
export function reconcileAccount(input: { accountId: number }): Discrepancy[] {
  const { accountId } = input;

  const snapshots = getDb()
    .select({ date: accountBalanceSnapshots.date, balanceCents: accountBalanceSnapshots.balanceCents })
    .from(accountBalanceSnapshots)
    .where(and(eq(accountBalanceSnapshots.accountId, accountId), eq(accountBalanceSnapshots.source, 'csv')))
    .orderBy(asc(accountBalanceSnapshots.date))
    .all();

  const discrepancies: Discrepancy[] = [];
  for (let i = 1; i < snapshots.length; i += 1) {
    const from = snapshots[i - 1];
    const to = snapshots[i];
    const impliedCents = from.balanceCents + movementBetween({ accountId, afterDate: from.date, throughDate: to.date });
    const deltaCents = impliedCents - to.balanceCents;
    if (deltaCents !== 0) {
      discrepancies.push({ accountId, fromDate: from.date, toDate: to.date, expectedCents: to.balanceCents, impliedCents, deltaCents });
    }
  }
  return discrepancies;
}
