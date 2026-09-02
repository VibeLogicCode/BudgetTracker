import { listAccounts } from '@/lib/accounts';
import type { Viewer } from '@/lib/auth/viewer';
import { addMonths, monthLabel, monthOf } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { latestSnapshots } from '@/lib/networth';
import { cashflowTrend, trimLeadingEmptyMonths } from '@/lib/reports';

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
  /**
   * v1.21.0 plan, item 14. The month (YYYY-MM) that has to finish before `months` can stop
   * being null on a household this new -- i.e. the first month `cashflowTrend`'s trailing
   * window below will include once it has ended. Always computed, even when `months` is
   * already non-null (there is nothing wrong with a well-defined value nobody currently reads);
   * `cashRunwayHint` is the one place it is actually consulted.
   */
  readyAfterMonth: string;
  /**
   * How many complete months of real data the average is drawn from (0 when there is none), i.e.
   * the divisor `avgMonthlySpendCents` was actually computed over -- NOT the width of the window
   * that was requested. On a household whose history starts part-way into that window the two
   * differ, and `cashRunwayHint` says which one the figure rests on rather than leaving a reader
   * to assume the full six.
   */
  monthsOfHistory: number;
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
 * Below this many months of real history, `cashRunwayHint` says so in the sentence. Three is the
 * point at which an average stops being one or two months wearing an average's clothes; it gates
 * WORDING only -- the number itself is always shown (see that function's own docblock).
 */
const THIN_HISTORY_MONTHS = 3;

/**
 * `opts.today` anchors both halves: the balance side reads `latestSnapshots(opts.today, viewer)`
 * (never a new query against account_balance_snapshots — see that function's own docblock for why
 * it resolves through `balancesAsOf` rather than reading the table directly), and the spend side
 * averages the FULL calendar months, out of the `opts.months` (default 6) immediately before
 * `opts.today`'s own month, that the household actually has history for — the current, possibly
 * partial, month is deliberately excluded so a runway checked on the 3rd of the month is not
 * diluted by 27 days of spending that have not happened yet, and the leading months before this
 * household's first transaction are excluded for the same reason (see the trim at the call site
 * below). `monthsOfHistory` reports how many months survived and therefore what the average is
 * really drawn from.
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
  // `cashflowTrend` zero-fills every month in the requested window by contract, so a household
  // whose history starts three months ago used to hand three phantom `spendCents: 0` months to
  // the divisor below -- a six-month divisor over three months of data halves the average and
  // therefore doubles the runway (10.5 months reported where the truth was nearer 5). Trimming
  // is LEADING-only here for exactly the reason it is on the dashboard chart (see
  // trimLeadingEmptyMonths' docblock in src/lib/reports.ts): a month before the household's
  // first transaction never happened for them and must not be averaged, while an interior quiet
  // month is a month they genuinely lived through and spent nothing in, which is real signal
  // about their pace and belongs in the divisor.
  const trend = trimLeadingEmptyMonths(cashflowTrend(trailingMonths, { endMonth: lastFullMonth }, viewer));
  const avgMonthlySpendCents =
    trend.length === 0 ? 0 : Math.round(trend.reduce((sum, row) => sum + row.spendCents, 0) / trend.length);

  return {
    liquidCents,
    avgMonthlySpendCents,
    months: avgMonthlySpendCents > 0 ? Math.round((liquidCents / avgMonthlySpendCents) * 10) / 10 : null,
    accountsMissing,
    // Exactly the divisor used above, never re-derived: `cashRunwayHint` reads it to state what
    // the figure rests on, and a second count computed some other way is how the sentence and
    // the arithmetic would drift apart.
    monthsOfHistory: trend.length,
    // Item 14: `opts.today`'s own month is the partial one this whole function deliberately
    // excludes (the docblock above). It becomes usable the moment the household is INTO the
    // following month, which is exactly when `lastFullMonth` above would advance to include it.
    readyAfterMonth: addMonths(monthOf(opts.today), 1),
  };
}

/**
 * v1.21.0 plan, item 14. `CashRunwayTile` (src/app/(app)/dashboard/page.tsx) used to say "no
 * spending history yet to average" whenever `months` was null -- true on a household that has
 * genuinely never recorded a transaction, false and actively misleading on one looking at a page
 * full of this month's own spending: the arithmetic (excluding the current, partial month from
 * the average) is correct, deliberate, and unchanged by this fix -- see cashRunway's own
 * docblock -- only the SENTENCE was lying about why there is nothing to show yet.
 *
 * The single place this wording is decided, the same pattern `netWorthHint` (src/lib/networth.ts)
 * already established for the sibling "some accounts have no balance" disclosure -- so a second
 * surface rendering a runway figure could not reinvent, and possibly mis-state, the same
 * sentence differently.
 *
 * The sentence also names `monthsOfHistory`, the divisor the average was really taken over. A
 * household three months old is shown a runway drawn from three months, not six, and saying so is
 * the whole disclosure: the figure is honest arithmetic on a short history, and the reader can
 * only judge how much to lean on it if the length of that history is on the tile. Below
 * THIN_HISTORY_MONTHS the sentence adds that the run is short -- and DELIBERATELY still shows the
 * number. Blanking the tile under a threshold was considered and rejected: a new household would
 * lose the one figure that answers "can we cover next month", and a stated-basis estimate beats no
 * estimate. Same register as `netWorthHint` (src/lib/networth.ts) for the sibling "some accounts
 * have no balance" disclosure -- it states what is missing, it does not apologise for it.
 */
export function cashRunwayHint(
  runway: Pick<CashRunway, 'months' | 'liquidCents' | 'avgMonthlySpendCents' | 'readyAfterMonth' | 'monthsOfHistory'>,
): string {
  if (runway.months === null) {
    return `Needs one complete month of spending before this can be estimated — check back once ${monthLabel(runway.readyAfterMonth)} begins.`;
  }
  const basis = `${formatCents(runway.liquidCents)} liquid ÷ ${formatCents(runway.avgMonthlySpendCents)} average monthly spend, based on ${runway.monthsOfHistory} ${runway.monthsOfHistory === 1 ? 'month' : 'months'} of history`;
  return runway.monthsOfHistory < THIN_HISTORY_MONTHS ? `${basis} — a short run to average over` : basis;
}
