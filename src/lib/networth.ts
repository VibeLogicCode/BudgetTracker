import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountBalanceSnapshots } from '@/db/schema';
import { getAccount, listAccounts } from '@/lib/accounts';
import { balancesAsOf } from '@/lib/balance';
import { nowIso } from '@/lib/clock';
import { addMonths, daysBetweenIso, isIsoDate, monthEnd, monthOf, monthRange, todayIso } from '@/lib/dates';
import { debtOverTime } from '@/lib/loans';
import { STALE_SNAPSHOT_DAYS } from '@/lib/networth-constants';

/**
 * Balance snapshot capture and net worth (spec 2026-08-22, v1.7.0, Task 6; routing rewritten
 * 2026-08-23, v1.8.0, Task 4). This file owns `account_balance_snapshots` --
 * `recordBalanceSnapshot` below is its only writer -- but no longer reads the table directly
 * for either `latestSnapshots` or `netWorthOverTime`. Both now resolve through `balancesAsOf`
 * (src/lib/balance.ts) instead, so a balance shown anywhere in the app includes movement
 * (transactions posted after the snapshot) rather than a figure that can only get staler
 * between imports and syncs. See src/lib/balance.ts's own docblock for ruling R1 (why that
 * resolver's transaction sum carries no is_transfer filter, no splits join and no category
 * filter -- reusing a spend-aggregate helper there would be wrong in a way that looks entirely
 * plausible) and ruling R2 (why it always anchors on the NEWEST snapshot at or before the
 * requested date, never the oldest).
 *
 * Ruling 6 (v1.7.0, unchanged): net worth is signed snapshot balances, assets +, credit cards -
 * as the source reports them, and nothing in THIS file normalizes a sign. A SimpleFIN credit
 * card balance arrives negative (see src/lib/simplefin/sync.ts's updateLinkBalance call, which
 * hands this module the same signed amountToCents() result it stores on the link); a manual
 * entry carries whatever sign recordBalanceSnapshot's caller passed in. Ruling R9 (v1.8.0)
 * negates a credit account's "amount currently owed" input to that same negative convention
 * BEFORE it ever reaches recordBalanceSnapshot -- in
 * src/app/(app)/settings/accounts/actions.ts's updateAccountAction, deliberately NOT here --
 * so this file's own rule keeps meaning exactly what it says: every balanceCents value crossing
 * this file's boundary, in or out, is already in final, signed form.
 */

export interface RecordSnapshotInput {
  accountId: number;
  date: string;
  balanceCents: number;
  /**
   * 'csv' added in v1.8.0 (spec 2026-08-23, Task 3/migration 0010): a balance read out of a
   * statement's own running-balance column (src/lib/import/mapping.ts's balanceCol), written
   * once per statement date by the import commit path. Source authority for the same
   * (accountId, date), highest first, per ruling R3: 'simplefin', 'csv', 'manual' — the
   * bank's own figure always outranks a typed one, which is the entire reason 'csv' is its
   * own value rather than being written as 'manual'.
   */
  source: 'simplefin' | 'manual' | 'csv';
}

/**
 * Ruling R3's source authority, as one exported constant instead of a claim in three docblocks.
 *
 * v1.12.1 (item BB / MON-4). This ordering was written down in this file's own type doc, in
 * src/db/schema.ts and in drizzle/0010_balances.sql -- which exists SPECIFICALLY so 'csv' is a
 * distinct value from 'manual' and the ranking is expressible -- and was implemented in none of
 * them: the upsert below used to set { balanceCents, source } unconditionally, so the last writer
 * won regardless of rank. Every balance in the app anchors on these rows (Settings > Accounts, net
 * worth over time, reconciliation), so the wrong anchor propagated everywhere, and a re-import
 * ping-ponged it with a hand-typed correction with no rule and no warning.
 */
export const SNAPSHOT_SOURCE_RANK: Readonly<Record<'manual' | 'csv' | 'simplefin', number>> = {
  manual: 1,
  csv: 2,
  simplefin: 3,
};

/**
 * Upserts on (accountId, date) via the `account_balance_snapshots_uq` unique index: a second
 * write for the same account and day REPLACES that day's balance instead of inserting a
 * second row, exactly as the schema doc comment on accountBalanceSnapshots promises. Losing
 * yesterday's row is not a concern -- ON CONFLICT only ever matches the one row sharing this
 * exact (accountId, date) pair, so every other day's history is untouched.
 *
 * Validates the date and the account up front and throws a clear message rather than letting
 * a malformed date reach SQLite as an un-indexable string or a dangling account id violate the
 * FK with a raw constraint error -- the same shape of guard renameAccount/setAccountOwner's
 * callers apply in src/app/(app)/settings/accounts/actions.ts.
 */
export function recordBalanceSnapshot(input: RecordSnapshotInput): void {
  if (!isIsoDate(input.date)) throw new Error('Snapshot date must be YYYY-MM-DD.');
  if (!getAccount(input.accountId)) throw new Error('That account no longer exists.');

  getDb()
    .insert(accountBalanceSnapshots)
    .values({
      accountId: input.accountId,
      date: input.date,
      balanceCents: input.balanceCents,
      source: input.source,
      createdAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [accountBalanceSnapshots.accountId, accountBalanceSnapshots.date],
      // createdAt is deliberately NOT in this set -- same convention as
      // upsertAccountCardPerson/notify's config upserts: the row's original createdAt survives
      // a same-day replace, only the balance and its source move.
      set: { balanceCents: input.balanceCents, source: input.source },
      // v1.12.1 (item BB / MON-4): the rank, enforced. `>=` and not `>`, so an equal-rank write is
      // still last-write -- re-importing a corrected statement has to be able to fix a day, and a
      // second SimpleFIN sync has to be able to move a balance the first one set.
      setWhere: sql`(case ${accountBalanceSnapshots.source}
                       when 'simplefin' then ${SNAPSHOT_SOURCE_RANK.simplefin}
                       when 'csv' then ${SNAPSHOT_SOURCE_RANK.csv}
                       else ${SNAPSHOT_SOURCE_RANK.manual}
                     end) <= ${SNAPSHOT_SOURCE_RANK[input.source]}`,
    })
    .run();
}

/**
 * The ONLY delete path against account_balance_snapshots in src/, and it is deliberately narrow.
 *
 * v1.12.1 (item AE / MON-5, ruling P8). commitImport writes one source='csv' snapshot per statement
 * date; undoImport reversed Bayes training, loan balances and installment links -- everything a
 * cascade cannot restore -- and left the snapshots, because there was no way to remove one. So
 * undoing an import into the WRONG account could not reverse the most consequential thing that
 * import did: balancesAsOf anchors on the newest snapshot at or before a date, so the foreign
 * bank's figure stayed authoritative for ever and every later transaction summed forward from it.
 *
 * source='csv' only: a hand-typed correction on the same day is somebody's decision and is not an
 * import's to delete. No per-date survivorship check (ruling P8): if two imports covered a day they
 * asserted the same bank's figure anyway, and losing an anchor is recoverable by re-importing while
 * keeping a wrong one is not -- balancesAsOf simply falls back to the previous snapshot.
 */
export function deleteCsvSnapshotsForAccountDates(accountId: number, dates: string[]): number {
  if (dates.length === 0) return 0;
  const result = getDb()
    .delete(accountBalanceSnapshots)
    .where(
      and(
        eq(accountBalanceSnapshots.accountId, accountId),
        eq(accountBalanceSnapshots.source, 'csv'),
        inArray(accountBalanceSnapshots.date, dates),
      ),
    )
    .run();
  return Number(result.changes ?? 0);
}

export interface LatestSnapshot {
  accountId: number;
  /** The ANCHOR date: the date of the snapshot `balanceCents` is based on, NOT the date
   *  `balanceCents` is true for. Those differ whenever `movedSinceCents` is non-zero. */
  date: string;
  balanceCents: number;
  /**
   * How much of `balanceCents` came from transactions posted AFTER `date`. 0 means the stored
   * snapshot is the balance as at `date` and nothing has moved since, so a caller may honestly
   * render "<balance> as of <date>"; non-zero means the balance is current and `date` is only
   * its provenance. Exposed because omitting it is what let the accounts page render a
   * today figure under an anchor date once this function started resolving through
   * `balancesAsOf` (v1.8.0 review defect).
   */
  movedSinceCents: number;
}

/**
 * The newest snapshot per account dated on or before `today`, one row per account -- RESOLVED
 * through `balancesAsOf` (v1.8.0, Task 4) rather than read off `account_balance_snapshots`
 * directly, so `balanceCents` includes movement (transactions posted after the snapshot)
 * instead of the raw stored figure. `date` stays the ANCHOR date -- the date of the snapshot
 * this balance is based on -- and is deliberately NOT rewritten to `today` just because the
 * number itself is now current: the anchor date is what lets a caller judge staleness (see
 * STALE_SNAPSHOT_DAYS below), and that signal would be destroyed by overwriting it.
 *
 * An account with no snapshot at or before that date is OMITTED entirely, not zero-filled --
 * Task 7's `accountsMissing` count is what surfaces that absence to the UI, and a silent 0 here
 * would be indistinguishable from a genuinely empty account.
 *
 * Every account, active or not, is offered to `balancesAsOf` as a candidate (the pre-v1.8.0
 * version of this function never joined to `accounts.is_active` either, reading
 * `account_balance_snapshots` on its own with no notion of an account's active status -- this
 * preserves that exactly). An account with no qualifying snapshot simply is not in the result,
 * at no extra query cost: `balancesAsOf` is two batched queries no matter how many candidate
 * ids are passed in.
 */
export function latestSnapshots(today: string): LatestSnapshot[] {
  const accountIds = listAccounts({ includeInactive: true }).map((account) => account.id);
  if (accountIds.length === 0) return [];

  const resolved = balancesAsOf({ accountIds, date: today });
  return accountIds
    .filter((accountId) => resolved.has(accountId))
    .sort((a, b) => a - b)
    .map((accountId) => {
      const balance = resolved.get(accountId)!;
      return {
        accountId,
        date: balance.anchorDate,
        balanceCents: balance.balanceCents,
        movedSinceCents: balance.movedSinceCents,
      };
    });
}

// ---------------------------------------------------------------- net worth over time

export interface NetWorthPoint {
  month: string;
  assetsCents: number;
  debtsCents: number;
  netCents: number;
  /** Active accounts with NO snapshot at or before this month's end -- the balance is entirely
   *  absent, not merely old. Mutually exclusive with accountsStale: an account with zero
   *  snapshots has nothing to evaluate for staleness, so it is counted here or there, never
   *  both. */
  accountsMissing: number;
  /**
   * Adversarial-review fix (2026-08-23): active accounts whose carried-forward snapshot DOES
   * exist (accountsMissing did not flag it) but is more than STALE_SNAPSHOT_DAYS older than this
   * month's end date. The reviewer's reproduction: a single 2025-10 snapshot read as fully
   * current -- accountsMissing: 0 -- every month through 2026-08, because accountsMissing only
   * ever checked "does a snapshot exist", never "is it still trustworthy". The balance still
   * carries forward into assetsCents/debtsCents at full value here; this field is disclosure
   * only, not exclusion -- see netWorthHint below and reports-client.tsx's accountsNote for
   * where that disclosure surfaces.
   */
  accountsStale: number;
}

// Re-exported so every existing importer of STALE_SNAPSHOT_DAYS from '@/lib/networth' keeps
// working unchanged -- the actual constant lives in @/lib/networth-constants (client-bundle fix,
// 2026-08-23): a 'use client' component (reports-client.tsx) needs this number, and importing it
// from THIS file would still drag @/db/client's better-sqlite3/node:fs graph into the browser
// bundle even though the number itself never touches the database. See that module's docblock.
export { STALE_SNAPSHOT_DAYS };

/**
 * Task 7. Net worth over time: ruling 6's "signed snapshot balances (assets +, credit cards -
 * as SimpleFIN reports them) + manual snapshots for unlinked accounts - loan balances", summed
 * into one monthly series.
 *
 * Clock-free the same way debtOverTime/cashflowTrend are (project-wide v1.4.0 rule): `today`/
 * `endMonth` are parameters, defaulted only through todayIso()/monthOf(), with no direct clock
 * construction anywhere in this function's own body -- a caller after determinism (every test
 * in tests/lib/networth-series.test.ts) passes both explicitly.
 *
 * Algorithm, per month END date, for every ACTIVE account (listAccounts()'s default -- an
 * inactive account is excluded from this computation entirely: it never contributes a balance,
 * never counts toward accountsMissing or accountsStale, and never anchors the series' start
 * date either): resolve the account through `balancesAsOf` (v1.8.0, Task 4; src/lib/balance.ts)
 * rather than reading `account_balance_snapshots` directly -- see that module's docblock for
 * ruling R1 (why its transaction sum carries no is_transfer filter, no splits join and no
 * category filter) and ruling R2 (why it always anchors on the newest snapshot at or before the
 * date, never the oldest). No snapshot at or before that date -> the account contributes 0 and
 * counts in that month's accountsMissing. A snapshot that DOES exist but whose OWN anchor date
 * (`ResolvedBalance.anchorDate`, not `today` and not this month's `end`) is more than
 * STALE_SNAPSHOT_DAYS older than this month's end date still carries forward at full value --
 * this function never discards a balance for being old -- but counts in accountsStale instead
 * of silently passing as current. The stale check only runs on the branch where a snapshot was
 * found, so an account is counted in exactly one of accountsMissing/accountsStale, never both.
 * A carried balance > 0 is an asset; < 0 is debt (its absolute value); debtOverTime's owed
 * figure for the month is added on top of the debts side (a month debtOverTime could not
 * reconstruct, MUST-15.7's null case, folds in as 0 rather than forcing debtsCents to carry a
 * null NetWorthPoint's contract does not allow). Months before the first snapshot of any
 * (active) account are omitted entirely -- never fabricate net worth history predating every
 * account's first recorded balance. No snapshot anywhere (or no active account at all)
 * returns [].
 *
 * Performance note (v1.8.0): this now calls `balancesAsOf` once per month in the requested
 * window -- two batched queries per call, never one query per account -- rather than the single
 * up-front snapshot query plus in-memory forward cursor the pre-v1.8.0 version used. The trade
 * is deliberate: ruling R1's dangerous transaction sum has exactly ONE implementation in the
 * whole app (src/lib/balance.ts), guarded by both tests/lib/balance.test.ts and the source-level
 * grep in tests/ops/balance-invariants.test.ts, and a second, independent copy of that sum here
 * would need its own fixtures and its own guard to be trusted the same way -- see that file's
 * docblock. At this app's scale (a household's handful of accounts, a window of months rather
 * than years of daily granularity) O(months) query pairs is not a real cost. debtOverTime is
 * the one other query this function makes, and only once, not per month.
 */
export function netWorthOverTime(months: number, opts: { endMonth?: string; today?: string } = {}): NetWorthPoint[] {
  const today = opts.today ?? todayIso();
  const endMonth = opts.endMonth ?? monthOf(today);
  const keys = monthRange(addMonths(endMonth, -(months - 1)), endMonth);
  const windowEndDate = monthEnd(endMonth);

  const activeAccountIds = listAccounts().map((account) => account.id);
  if (activeAccountIds.length === 0) return [];

  // Only bound to decide whether ANY active account has a snapshot at all inside the window --
  // see the `end < firstDate` skip below. balancesAsOf (called per month, further down) is what
  // actually resolves each point's balance; this is a single cheap MIN aggregate, not a second
  // copy of that resolution logic.
  const firstDateRow = getDb()
    .select({ firstDate: sql<string | null>`min(${accountBalanceSnapshots.date})`.as('first_date') })
    .from(accountBalanceSnapshots)
    .where(and(inArray(accountBalanceSnapshots.accountId, activeAccountIds), lte(accountBalanceSnapshots.date, windowEndDate)))
    .get();
  const firstDate = firstDateRow?.firstDate ?? null;
  if (firstDate === null) return [];

  const debtByMonth = new Map(debtOverTime(months, { endMonth, today }).map((point) => [point.month, point.owedCents]));

  const points: NetWorthPoint[] = [];
  for (const month of keys) {
    const end = monthEnd(month);
    if (end < firstDate) continue; // before every account's first snapshot -- never fabricated

    const resolved = balancesAsOf({ accountIds: activeAccountIds, date: end });

    let assetsCents = 0;
    let debtsCents = 0;
    let accountsMissing = 0;
    let accountsStale = 0;

    for (const accountId of activeAccountIds) {
      const balance = resolved.get(accountId);
      if (!balance) {
        accountsMissing += 1;
        continue;
      }
      if (daysBetweenIso(balance.anchorDate, end) > STALE_SNAPSHOT_DAYS) accountsStale += 1;
      if (balance.balanceCents > 0) assetsCents += balance.balanceCents;
      else if (balance.balanceCents < 0) debtsCents += -balance.balanceCents;
    }

    debtsCents += debtByMonth.get(month) ?? 0;
    points.push({ month, assetsCents, debtsCents, netCents: assetsCents - debtsCents, accountsMissing, accountsStale });
  }

  return points;
}

/**
 * Adversarial-review fix (2026-08-23), Defect 2: the dashboard's Net worth StatTile carried the
 * fixed hint "Assets minus debts and loans, across every tracked account" no matter what
 * accountsMissing/accountsStale said, so it kept claiming completeness on days the Reports "Net
 * worth" card (reports-client.tsx's accountsNote) was disclosing a gap or a stale balance for
 * the exact same figure. This is the dashboard tile's half of that fix: it is the ONLY input to
 * the tile's hint prop, so the two surfaces can no longer disagree about whether the figure is
 * current.
 *
 * Deliberately short (a stat tile hint is one line, not the Reports card's fuller note with its
 * "Update ... in Settings and Accounts" call to action) and deliberately silent on which
 * accounts, exactly -- that detail lives on Reports. The only obligations here: never say
 * "every tracked account" while either count is non-zero, and read correctly at N=1.
 */
export function netWorthHint(point: Pick<NetWorthPoint, 'accountsMissing' | 'accountsStale'>): string {
  const { accountsMissing, accountsStale } = point;
  if (accountsMissing === 0 && accountsStale === 0) {
    return 'Assets minus debts and loans, across every tracked account';
  }
  if (accountsMissing > 0 && accountsStale > 0) {
    return 'Some accounts have no balance or an outdated one';
  }
  if (accountsMissing > 0) {
    return accountsMissing === 1 ? '1 account has no balance yet' : `${accountsMissing} accounts have no balance yet`;
  }
  return accountsStale === 1 ? '1 account has an outdated balance' : `${accountsStale} accounts have outdated balances`;
}
