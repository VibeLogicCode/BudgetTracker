import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountBalanceSnapshots } from '@/db/schema';
import { getAccount, listAccounts } from '@/lib/accounts';
import { nowIso } from '@/lib/clock';
import { addMonths, daysBetweenIso, isIsoDate, monthEnd, monthOf, monthRange, todayIso } from '@/lib/dates';
import { debtOverTime } from '@/lib/loans';
import { STALE_SNAPSHOT_DAYS } from '@/lib/networth-constants';

/**
 * Balance snapshot capture and net worth (spec 2026-08-22, v1.7.0, Task 6). This file owns
 * `account_balance_snapshots` (drizzle/0009_finish_line.sql, created empty by that migration --
 * this is the first writer). Task 7 adds `netWorthOverTime`/`NetWorthPoint` to this same file,
 * reading through `latestSnapshots` below; that is why the file is not named
 * "balance-snapshots.ts" even though that is all it contains for now.
 *
 * Ruling 6 (net worth = signed snapshot balances, assets +, credit cards - as the source
 * reports them): nothing in this file normalizes a sign. A SimpleFIN credit card balance
 * arrives negative (see src/lib/simplefin/sync.ts's updateLinkBalance call, which hands this
 * module the same signed amountToCents() result it stores on the link) and a manual entry
 * carries whatever sign the person typed (src/app/(app)/settings/accounts/actions.ts's
 * parseAmountToCents), so both sources land here identically shaped.
 */

export interface RecordSnapshotInput {
  accountId: number;
  date: string;
  balanceCents: number;
  source: 'simplefin' | 'manual';
}

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
    })
    .run();
}

export interface LatestSnapshot {
  accountId: number;
  date: string;
  balanceCents: number;
}

/**
 * The newest snapshot per account dated on or before `today`, one row per account. An account
 * with no snapshot at or before that date is OMITTED entirely, not zero-filled -- Task 7's
 * `accountsMissing` count is what surfaces that absence to the UI, and a silent 0 here would
 * be indistinguishable from a genuinely empty account.
 *
 * (accountId, date) is unique, so grouping for max(date) per account and joining back to the
 * balance identifies exactly one row per account with no tie to break -- same grouped-subquery
 * shape as partitionByAssociation in src/lib/import/commit.ts.
 */
export function latestSnapshots(today: string): LatestSnapshot[] {
  const db = getDb();
  const latest = db
    .select({
      accountId: accountBalanceSnapshots.accountId,
      maxDate: sql<string>`max(${accountBalanceSnapshots.date})`.as('max_date'),
    })
    .from(accountBalanceSnapshots)
    .where(lte(accountBalanceSnapshots.date, today))
    .groupBy(accountBalanceSnapshots.accountId)
    .as('latest');

  return db
    .select({
      accountId: accountBalanceSnapshots.accountId,
      date: accountBalanceSnapshots.date,
      balanceCents: accountBalanceSnapshots.balanceCents,
    })
    .from(accountBalanceSnapshots)
    .innerJoin(latest, and(eq(latest.accountId, accountBalanceSnapshots.accountId), eq(latest.maxDate, accountBalanceSnapshots.date)))
    .orderBy(accountBalanceSnapshots.accountId)
    .all();
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
 * date either): the latest snapshot dated on or before that date carries forward. No such
 * snapshot -> the account contributes 0 and counts in that month's accountsMissing. A snapshot
 * that DOES exist but is more than STALE_SNAPSHOT_DAYS older than this month's end date still
 * carries forward at full value -- this function never discards a balance for being old -- but
 * counts in accountsStale instead of silently passing as current. The stale check only runs on
 * the branch where a snapshot was found, so an account is counted in exactly one of
 * accountsMissing/accountsStale, never both. A carried balance > 0 is an asset; < 0 is debt (its
 * absolute value); debtOverTime's owed figure for the month is added on top of the debts side (a
 * month debtOverTime could not reconstruct, MUST-15.7's null case, folds in as 0 rather than
 * forcing debtsCents to carry a null NetWorthPoint's contract does not allow). Months before the
 * first snapshot of any (active) account are omitted entirely -- never fabricate net worth
 * history predating every account's first recorded balance. No snapshot anywhere (or no active
 * account at all) returns [].
 *
 * ONE query fetches every relevant snapshot, oldest first per account; a forward-only cursor
 * per account then walks the ascending month axis (monthRange/addMonths, the same windowing
 * idiom cashflowTrend and debtOverTime both use) with no query inside the loop. debtOverTime is
 * the one other query this function makes.
 */
export function netWorthOverTime(months: number, opts: { endMonth?: string; today?: string } = {}): NetWorthPoint[] {
  const today = opts.today ?? todayIso();
  const endMonth = opts.endMonth ?? monthOf(today);
  const keys = monthRange(addMonths(endMonth, -(months - 1)), endMonth);
  const windowEndDate = monthEnd(endMonth);

  const activeAccountIds = listAccounts().map((account) => account.id);
  if (activeAccountIds.length === 0) return [];

  const snapshots = getDb()
    .select({
      accountId: accountBalanceSnapshots.accountId,
      date: accountBalanceSnapshots.date,
      balanceCents: accountBalanceSnapshots.balanceCents,
    })
    .from(accountBalanceSnapshots)
    .where(and(inArray(accountBalanceSnapshots.accountId, activeAccountIds), lte(accountBalanceSnapshots.date, windowEndDate)))
    .orderBy(asc(accountBalanceSnapshots.accountId), asc(accountBalanceSnapshots.date))
    .all();
  if (snapshots.length === 0) return [];

  // Rows arrive account-major, date-minor (the ORDER BY above), so each per-account bucket is
  // already ascending by date -- no re-sort needed for the forward-cursor walk below.
  let firstDate = snapshots[0].date;
  const byAccount = new Map<number, { date: string; balanceCents: number }[]>();
  for (const row of snapshots) {
    if (row.date < firstDate) firstDate = row.date;
    const bucket = byAccount.get(row.accountId);
    if (bucket) bucket.push(row);
    else byAccount.set(row.accountId, [row]);
  }

  const debtByMonth = new Map(debtOverTime(months, { endMonth, today }).map((point) => [point.month, point.owedCents]));

  const cursor = new Map<number, number>();
  const points: NetWorthPoint[] = [];
  for (const month of keys) {
    const end = monthEnd(month);
    if (end < firstDate) continue; // before every account's first snapshot -- never fabricated

    let assetsCents = 0;
    let debtsCents = 0;
    let accountsMissing = 0;
    let accountsStale = 0;

    for (const accountId of activeAccountIds) {
      const bucket = byAccount.get(accountId) ?? [];
      let idx = cursor.get(accountId) ?? 0;
      while (idx < bucket.length && bucket[idx].date <= end) idx += 1;
      cursor.set(accountId, idx);

      if (idx === 0) {
        accountsMissing += 1;
        continue;
      }
      const snapshot = bucket[idx - 1];
      if (daysBetweenIso(snapshot.date, end) > STALE_SNAPSHOT_DAYS) accountsStale += 1;
      if (snapshot.balanceCents > 0) assetsCents += snapshot.balanceCents;
      else if (snapshot.balanceCents < 0) debtsCents += -snapshot.balanceCents;
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
