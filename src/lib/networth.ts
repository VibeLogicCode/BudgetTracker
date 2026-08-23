import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accountBalanceSnapshots } from '@/db/schema';
import { getAccount } from '@/lib/accounts';
import { nowIso } from '@/lib/clock';
import { isIsoDate } from '@/lib/dates';

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
