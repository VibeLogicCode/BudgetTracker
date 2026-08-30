import { listAccounts } from '@/lib/accounts';
import type { Viewer } from '@/lib/auth/viewer';
import { addMonths, monthOf } from '@/lib/dates';
import { latestSnapshots } from '@/lib/networth';
import { cashflowTrend } from '@/lib/reports';

/**
 * Cash runway (spec docs/superpowers/plans/2026-08-30-savings-targets.md, Lane 1, v1.17.0):
 * "how many months could this household's liquid cash cover, at its recent pace of spending".
 *
 * Deliberately reuses two existing resolvers rather than writing a new query:
 * `latestSnapshots` (src/lib/networth.ts) for the balances -- it already resolves through
 * `balancesAsOf`, so a runway figure never gets a stale number `netWorthOverTime` wouldn't --
 * and `cashflowTrend` (src/lib/reports.ts) for the spend history, the same series
 * `savingsProgress` (src/lib/savings-target.ts) and `savingsRate` read.
 */

export interface CashRunway {
  liquidCents: number;
  avgMonthlySpendCents: number;
  /** liquid / average spend, one decimal. null when average spend is not positive. */
  months: number | null;
  /** Liquid accounts with no balance on file — the figure is only as good as this is 0. */
  accountsMissing: number;
}

const DEFAULT_TRAILING_MONTHS = 6;

/**
 * Ruling from src/db/schema.ts:129's account type enum: `credit` is a liability (it is debt, not
 * cash on hand) and `asset` is property (a house, an RRSP -- not spendable this month), so neither
 * counts toward runway. `chequing`, `savings` and `cash` all behave like money in hand for this
 * purpose, same grouping `countsTowardSafeToSpend` (src/lib/accounts.ts) uses for chequing/cash,
 * widened here to include savings -- unlike safe-to-spend, a runway figure is asking "how long
 * could we survive", and money sitting in savings answers that question even though it is
 * deliberately excluded from a month-to-month spending allowance.
 */
const LIQUID_ACCOUNT_TYPES = new Set(['chequing', 'savings', 'cash']);

/**
 * `opts.today` anchors both halves: the balance side reads `latestSnapshots(opts.today, viewer)`
 * (never a new query against account_balance_snapshots — see that function's own docblock for why
 * it resolves through `balancesAsOf` rather than reading the table directly), and the spend side
 * averages the `opts.months` (default 6) FULL calendar months immediately before `opts.today`'s
 * own month — the current, possibly partial, month is deliberately excluded so a runway checked on
 * the 3rd of the month is not diluted by 27 days of spending that have not happened yet.
 *
 * An account with no snapshot at all is OMITTED from `liquidCents` (contributes 0) and counted in
 * `accountsMissing` instead of being silently treated as an honest zero balance.
 */
export function cashRunway(opts: { today: string; months?: number }, viewer: Viewer): CashRunway {
  const trailingMonths = opts.months ?? DEFAULT_TRAILING_MONTHS;

  const liquidAccountIds = new Set(
    listAccounts({}, viewer)
      .filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type))
      .map((account) => account.id),
  );

  const snapshotByAccount = new Map(latestSnapshots(opts.today, viewer).map((snapshot) => [snapshot.accountId, snapshot]));

  let liquidCents = 0;
  let accountsMissing = 0;
  for (const accountId of liquidAccountIds) {
    const snapshot = snapshotByAccount.get(accountId);
    if (!snapshot) {
      accountsMissing += 1;
      continue;
    }
    liquidCents += snapshot.balanceCents;
  }

  const lastFullMonth = addMonths(monthOf(opts.today), -1);
  const trend = cashflowTrend(trailingMonths, { endMonth: lastFullMonth }, viewer);
  const avgMonthlySpendCents =
    trend.length === 0 ? 0 : Math.round(trend.reduce((sum, row) => sum + row.spendCents, 0) / trend.length);

  return {
    liquidCents,
    avgMonthlySpendCents,
    months: avgMonthlySpendCents > 0 ? Math.round((liquidCents / avgMonthlySpendCents) * 10) / 10 : null,
    accountsMissing,
  };
}
