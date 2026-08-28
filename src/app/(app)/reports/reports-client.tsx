'use client';

import Link from 'next/link';
import { CashflowChart } from '@/components/charts/CashflowChart';
import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { DebtTrendChart } from '@/components/charts/DebtTrendChart';
import { NetWorthChart } from '@/components/charts/NetWorthChart';
import { LoanIcon, ReportsIcon, TrendDownIcon, TrendFlatIcon, TrendUpIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeParams, type ResolvedRange } from '@/lib/date-range';
import { monthLabel, monthOf } from '@/lib/dates';
import type { DebtPoint } from '@/lib/loans';
import { formatCents } from '@/lib/money';
import type { NetWorthPoint } from '@/lib/networth';
// Value-imported from the pure module directly, not from '@/lib/networth': that module imports
// getDb from @/db/client at module scope for its OTHER exports, so importing this number FROM
// IT -- even via a re-export -- would still drag better-sqlite3/node:fs into this client bundle
// (see src/lib/networth-constants.ts's docblock; this is the exact bug that guard fixed).
import { STALE_SNAPSHOT_DAYS } from '@/lib/networth-constants';
import type { BaselineRow } from '@/lib/predict/suggest';
import type {
  CategoryBreakdownRow,
  CategoryMonthTrend,
  MonthTrendRow,
  PersonSplitRow,
  TopMerchantRow,
  YoYRow,
} from '@/lib/reports';
// Same reasoning as STALE_SNAPSHOT_DAYS above, for '@/lib/reports' and its @/db/client import --
// see src/lib/savings-rate.ts's docblock.
import { savingsRate } from '@/lib/savings-rate';
import type { TaxYearRow } from '@/lib/tax';

/** Task 15b (v1.7.0): one taxYearReport() row, plus its place in the category tree. tax.ts's
 *  TaxYearRow does not carry parentId -- a tax-year row does not otherwise need it -- so the
 *  page attaches it before handing rows to this card, which needs it to indent a flagged child
 *  under its flagged parent and disclose the overlap (see orderTaxRows below). */
export interface TaxYearDisplayRow extends TaxYearRow {
  parentId: number | null;
}

export function ReportsClient({
  range,
  today,
  person,
  people,
  breakdown,
  monthOverMonth,
  split,
  debt,
  hasLoans,
  netWorth,
  baselines,
  baselineMonthsUsed,
  merchants,
  yoy,
  yoyMonth,
  cashflow,
  taxYears,
  taxYear,
  taxRows,
  showPersonSplit,
}: {
  range: ResolvedRange;
  today: string;
  person: string;
  people: { id: number; name: string }[];
  breakdown: CategoryBreakdownRow[];
  monthOverMonth: { months: string[]; rows: CategoryMonthTrend[] };
  split: PersonSplitRow[];
  debt: DebtPoint[];
  hasLoans: boolean;
  netWorth: NetWorthPoint[];
  baselines: BaselineRow[];
  baselineMonthsUsed: number;
  /** Task 12: the largest net charges over the range/person scope above, limit 15. */
  merchants: TopMerchantRow[];
  /** Task 13: this month vs last month vs the same month last year, rolled up and person-scoped. */
  yoy: YoYRow[];
  /** The month the Task 13 card is comparing, echoed back so the picker keeps its value. */
  yoyMonth: string;
  /** Task 14: cashflowTrend() over the range's whole-month span, capped at 24. */
  cashflow: MonthTrendRow[];
  /** Task 15b: years with at least one non-transfer transaction, newest first (taxYears() in
   *  src/lib/tax.ts) -- populates the year select independently of whether anything is flagged. */
  taxYears: number[];
  /** The resolved selected year, or null when taxYears is empty (no data at all yet). */
  taxYear: number | null;
  /** taxYearReport(taxYear), each row's parentId attached by the page. Empty whenever nothing
   *  is flagged for this year, which is what drives the card's empty state below. */
  taxRows: TaxYearDisplayRow[];
  /** v1.13.0 ruling R2: false for a self viewer -- there is no per-person breakdown to offer
   *  when the person scope is always and only themselves, so the picker's Person field and the
   *  "Who spent it" card are both dropped rather than shown with one row. */
  showPersonSplit: boolean;
}) {
  const exportHref = `/api/reports/export?${new URLSearchParams({
    ...rangeParams(range),
    ...(person ? { person } : {}),
  }).toString()}`;

  // Task 15b: ordered once for both the table and the grand total below, so the two can never
  // disagree about which rows overlap.
  const taxOrdered = orderTaxRows(taxRows);
  const taxGrandTotalCents = taxGrandTotal(taxOrdered);
  const taxHasOverlap = taxOrdered.some((entry) => entry.nested);

  // The Net worth card's honesty note reads the latest point's two counts once, here, so the
  // condition deciding whether to render the note and the values passed into its text can never
  // drift apart (same reasoning as taxOrdered/taxGrandTotalCents above).
  const netWorthLatestPoint = netWorth.length > 0 ? netWorth[netWorth.length - 1] : null;

  return (
    // data-page-width: the month-over-month table grows a column per month (see globals.css).
    <div data-page-width="wide" className="flex flex-col gap-6">
      <PageHeader
        eyebrow={range.label}
        title="Reports"
        description="Where the money went over a stretch of time, by category and by person."
        actions={
          <a href={exportHref} className="btn btn--secondary">
            Export CSV
          </a>
        }
      />

      <PageGuide>
        <p>
          Reports answers questions about a stretch of time rather than the current month: where
          the money went by category, how one month compares with the last, how a year compares
          with the year before, and how the household&rsquo;s split by person works out. The date
          range and person at the top drive every card below at once, and{' '}
          <strong className="font-semibold text-ink">Export CSV</strong> gives you the same rows
          in a spreadsheet.
        </p>
        <p>
          Most of these cards are comparisons, so they have nothing to compare until several
          months of statements are on file. A card saying it does not have enough history yet is
          not broken — importing older statements is what fills it in, and month-over-month,
          year-over-year and the spending baselines all get more useful the further back your
          imports go.
        </p>
        <p>
          Two cards are waiting on a setting rather than on history. Net worth needs a balance
          recorded against at least one account under Settings, and the Tax year card only lists
          categories you have marked as tax relevant under Settings and Managers. Neither will
          fill in from importing more months.
        </p>
      </PageGuide>

      <Card>
        <CardBody className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <DateRangePicker value={range.preset} from={range.from} to={range.to} today={today} />
            {showPersonSplit ? (
              <Field label="Person">
                <select name="person" defaultValue={person} className={selectClass}>
                  <option value="">Everyone</option>
                  <option value="unattributed">Household/unattributed</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Compare month" hint="Feeds the year-over-year card below.">
              <input type="month" name="yoyMonth" defaultValue={yoyMonth} max={monthOf(today)} className={inputClass} />
            </Field>
            {taxYears.length > 0 ? (
              <Field label="Tax year" hint="Feeds the tax year card below.">
                <select name="taxYear" defaultValue={taxYear ?? ''} className={selectClass}>
                  {taxYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <button type="submit" className="btn btn--primary">Apply</button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Category baselines"
          description="Median and average over the last 6 full calendar months. This card does not follow the date filter above: a median needs equal-length months, and an arbitrary range does not have them."
        />
        <CardBody padded={false}>
          {baselineMonthsUsed < 3 ? (
            <EmptyState
              icon={ReportsIcon}
              title="Not enough history yet"
              action={
                <Link href="/import" className="btn btn--secondary btn--sm">
                  Import older statements
                </Link>
              }
            >
              Baselines appear after three full calendar months.
            </EmptyState>
          ) : baselines.length === 0 ? (
            <EmptyState
              icon={ReportsIcon}
              title="No category has enough regular spend for a baseline yet"
              action={
                <Link href="/import" className="btn btn--secondary btn--sm">
                  Import more statements
                </Link>
              }
            >
              A category needs a median spend above the suggestion floor, and this household's does not clear it yet.
            </EmptyState>
          ) : (
            <TableWrap bare>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="text-right">Median</th>
                  <th className="text-right">Average</th>
                  <th>Trend</th>
                  <th className="text-right">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {baselines.map((row) => (
                  <tr key={row.categoryId}>
                    <td>{row.categoryName}</td>
                    <AmountCell>
                      <Money cents={row.suggestion.medianCents} plain />
                    </AmountCell>
                    <AmountCell>
                      <Money cents={row.suggestion.meanCents} plain />
                    </AmountCell>
                    <td>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        {row.suggestion.trend.direction === 'rising' ? <TrendUpIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'falling' ? <TrendDownIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'flat' ? <TrendFlatIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'unknown'
                          ? null
                          : `${row.suggestion.trend.direction === 'rising' ? 'Rising' : row.suggestion.trend.direction === 'falling' ? 'Falling' : 'Flat'} ${formatCents(Math.abs(row.suggestion.trend.deltaCents), { currency: true })}`}
                      </span>
                    </td>
                    <AmountCell>
                      <Money cents={row.suggestion.suggestedCents} plain />
                    </AmountCell>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Category breakdown" description="Net spend per category over the range." />
        {breakdown.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="Nothing spent in this range"
            action={
              <Link href="/reports" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          >
            Widen the dates, or import the statements that cover them.
          </EmptyState>
        ) : (
          <CardBody>
            <CategoryBarChart data={breakdown} />
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Cash flow and savings rate" description="Income and spend by month over the range above." />
        {cashflow.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="Nothing to show for this range"
            action={
              <Link href="/reports" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          />
        ) : (
          <CardBody className="flex flex-col gap-3">
            <CashflowChart data={cashflow} />
            <p className="text-sm text-muted">{cashflowSummary(cashflow)}</p>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Month over month" description="The same categories, month by month." />
        {monthOverMonth.rows.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="No months to compare yet"
            action={
              <Link href="/reports" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          />
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Category</th>
                {monthOverMonth.months.map((month) => (
                  <th scope="col" key={month} className="text-right">{month}</th>
                ))}
                <th scope="col" className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthOverMonth.rows.map((row) => (
                <tr key={row.categoryId}>
                  <td className="whitespace-nowrap font-medium text-ink">{row.categoryName}</td>
                  {monthOverMonth.months.map((month) => (
                    <td key={month} className="text-right text-muted">
                      {formatOrDash(row.byMonth[month] ?? 0)}
                    </td>
                  ))}
                  <td className="text-right font-semibold">
                    <Money cents={row.totalCents} plain />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card>
        <CardHeader
          title="This month against last year"
          description={`${monthLabel(yoyMonth)} compared with last month and the same month last year.`}
        />
        {yoy.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="Nothing to compare yet"
            action={
              <Link href="/reports" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          />
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="text-right">This month</th>
                <th scope="col" className="text-right">Last month</th>
                <th scope="col" className="text-right">Last year</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {yoy.map((row) => (
                <tr key={row.categoryId}>
                  <td className="whitespace-nowrap font-medium text-ink">{row.categoryName}</td>
                  <td className="text-right">{formatOrDash(row.thisMonthCents)}</td>
                  <td className="text-right text-muted">{formatOrDash(row.lastMonthCents)}</td>
                  <td className="text-right text-muted">{formatOrDash(row.lastYearCents)}</td>
                  <td>{yoyChange(row.thisMonthCents, row.lastYearCents)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Ruling R2: dropped entirely for a self viewer -- there is no per-person split to show
          when the person scope is always and only themselves. */}
      {showPersonSplit ? (
        <Card>
          <CardHeader title="Who spent it" description="Split by the person each transaction is attributed to." />
          {split.length === 0 ? (
            <EmptyState
              icon={ReportsIcon}
              title="Nothing to split yet"
              action={
                <Link href="/reports" className="btn btn--secondary btn--sm">
                  Clear filters
                </Link>
              }
            />
          ) : (
            <ul className="border-t border-line text-sm">
              {split.map((row) => (
                <li
                  key={row.userId ?? 'unattributed'}
                  className="flex items-center justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
                >
                  <span>{row.label}</span>
                  <Money cents={row.spentCents} plain />
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Top merchants" description="The largest net charges over the range above." />
        {merchants.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="No merchant charges in this range"
            action={
              <Link href="/reports" className="btn btn--secondary btn--sm">
                Clear filters
              </Link>
            }
          >
            Widen the dates, or import the statements that cover them.
          </EmptyState>
        ) : (
          <TableWrap bare>
            <thead>
              <tr>
                <th scope="col">Merchant</th>
                <th scope="col" className="text-right">Charges</th>
                <th scope="col" className="text-right">Net spent</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((row) => (
                <tr key={row.normalizedMerchant}>
                  <td className="whitespace-nowrap font-medium text-ink">{row.normalizedMerchant}</td>
                  <td className="text-right text-muted">{row.count}</td>
                  <AmountCell>
                    <Money cents={row.spentCents} plain />
                  </AmountCell>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card>
        <CardHeader title="Net worth" description="Assets minus debts and loans, carried forward from the balances you have on file." />
        {netWorth.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="No balances recorded yet"
            action={
              <Link href="/settings/accounts" className="btn btn--secondary btn--sm">
                Record a balance
              </Link>
            }
          >
            Record a balance for at least one account in Settings and Accounts to see net worth here.
          </EmptyState>
        ) : (
          <CardBody className="flex flex-col gap-3">
            <NetWorthChart data={netWorth} />
            {/* Honesty over a tidy chart: the line only ever reflects the accounts that have a
                recorded balance AND treats it as still current, and this says so whenever
                either is untrue, using the most recent month's counts -- an older gap that has
                since been filled, or a stale balance that has since been refreshed, is no
                longer true today, so it does not linger here once every account has caught up. */}
            {netWorthLatestPoint && (netWorthLatestPoint.accountsMissing > 0 || netWorthLatestPoint.accountsStale > 0) ? (
              <p className="text-sm text-muted">
                {accountsNote(netWorthLatestPoint.accountsMissing, netWorthLatestPoint.accountsStale)}
              </p>
            ) : null}
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Tax year"
          description="Net spend in every tax-relevant category, by person, for one calendar year."
          action={
            taxYear !== null ? (
              <a href={`/api/reports/tax-export?year=${taxYear}`} className="btn btn--secondary">
                Download CSV
              </a>
            ) : null
          }
        />
        {taxRows.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="Nothing marked tax-relevant yet"
            action={
              <Link href="/settings/managers" className="btn btn--secondary btn--sm">
                Mark categories as tax relevant
              </Link>
            }
          >
            Mark categories as tax relevant in Settings and Managers to see them here.
          </EmptyState>
        ) : (
          <>
            <TableWrap bare>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Person</th>
                  <th scope="col" className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {taxOrdered.flatMap(({ row, nested }) =>
                  row.byUser.map((personRow) => (
                    <tr key={`${row.categoryId}-${personRow.userId ?? 'unattributed'}`}>
                      <td
                        style={{ paddingLeft: nested ? '36px' : '16px' }}
                        className={nested ? 'text-muted' : 'font-medium text-ink'}
                      >
                        {row.categoryName}
                      </td>
                      <td className="text-muted">{personRow.label}</td>
                      <AmountCell>
                        <Money cents={personRow.cents} plain />
                      </AmountCell>
                    </tr>
                  )),
                )}
                <tr>
                  <td colSpan={2} className="font-semibold text-ink">
                    Total
                  </td>
                  <AmountCell className="font-semibold">
                    <Money cents={taxGrandTotalCents} plain />
                  </AmountCell>
                </tr>
              </tbody>
            </TableWrap>
            {/* Task 15b: a flagged parent's row already folds in every child's spend (flagged or
                not, per src/lib/tax.ts's module doc comment). When a child is ALSO separately
                flagged it gets its own row too, indented directly above -- and this note is the
                one place that overlap is spelled out, so nobody reads this table and adds every
                row together. */}
            {taxHasOverlap ? (
              <CardBody className="pt-3">
                <p className="text-sm text-muted">
                  An indented category's amount is already included in its parent's total above it, so adding both
                  would count it twice.
                </p>
              </CardBody>
            ) : null}
          </>
        )}
      </Card>

      {!hasLoans ? null : (
        <Card>
          <CardHeader title="Debt over time" description="Total owed across every loan with a balance." />
          {/* Review fix-round: gated on "fewer than two" rather than "every point null" -- a
              single non-null point (the common first-run shape, one anchor amid 23 NULLs)
              draws no visible line either, so it belongs here rather than in a chart with
              nothing to show. This also retires what was otherwise a dead branch, since the
              current month is always non-null once the card renders at all. */}
          {debt.filter((point) => point.owedCents !== null).length < 2 ? (
            <EmptyState
              icon={LoanIcon}
              title="Not enough history yet"
              action={
                <Link href="/import" className="btn btn--secondary btn--sm">
                  Import older statements
                </Link>
              }
            >
              The chart appears after a month of tracked activity.
            </EmptyState>
          ) : (
            <CardBody className="flex flex-col gap-3">
              <DebtTrendChart data={debt} />
              {/* MUST-15.6: always visible, because a reader is entitled to know where a line comes from. */}
              <p className="text-sm text-muted">
                The line starts when you first recorded a balance for each loan, and is reconstructed by adding back the
                payments you have linked since.
              </p>
            </CardBody>
          )}
        </Card>
      )}
    </div>
  );
}

/** A zero in a month-over-month grid is noise; an em dash reads as "nothing here". */
function formatOrDash(cents: number): React.ReactNode {
  if (cents === 0) return <span className="text-subtle">—</span>;
  return <Money cents={cents} plain />;
}

/** Task 14: the Cash flow and savings rate card's one-line summary. All the arithmetic
 *  (including the division-by-zero guard) lives in savingsRate() (src/lib/reports.ts), so it
 *  has exactly one implementation and one place it is unit tested; this only formats it. */
function cashflowSummary(rows: MonthTrendRow[]): string {
  const rate = savingsRate(rows);
  if (rate.pct === null) return 'No income recorded in this range.';
  return `Income ${formatCents(rate.incomeCents)} · Spent ${formatCents(rate.spendCents)} · Saved ${formatCents(rate.netCents)} (${rate.pct}%)`;
}

/** Task 13: the YoY card's delta indicator. A category with nothing spent in the reference
 *  month has no percentage change to report, so this says so in words rather than dividing by
 *  zero -- the same guard savingsRate() applies for the card above. */
function yoyChange(thisMonthCents: number, lastYearCents: number): React.ReactNode {
  if (lastYearCents === 0) {
    if (thisMonthCents === 0) return <span className="text-subtle">—</span>;
    return <span className="text-xs text-muted">No spend this month last year</span>;
  }
  const pct = Math.round(((thisMonthCents - lastYearCents) / lastYearCents) * 100);
  const direction = pct > 0 ? 'rising' : pct < 0 ? 'falling' : 'flat';
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      {direction === 'rising' ? <TrendUpIcon className="h-4 w-4" /> : null}
      {direction === 'falling' ? <TrendDownIcon className="h-4 w-4" /> : null}
      {direction === 'flat' ? <TrendFlatIcon className="h-4 w-4" /> : null}
      {direction === 'flat' ? 'Flat vs last year' : `${pct > 0 ? '+' : ''}${pct}% vs last year`}
    </span>
  );
}

/**
 * The Net worth card's honesty note (see the comment above its call site). Adversarial-review
 * fix (2026-08-23): extended from missing-only to also cover accountsStale (a snapshot that
 * exists but is more than STALE_SNAPSHOT_DAYS old -- src/lib/networth.ts). The two counts are
 * independent -- either, both, or neither can be non-zero -- so every branch below has its own
 * test in tests/app/reports-client.test.tsx. Singular/plural agreement matters at exactly 1 --
 * "1 accounts have" reads as broken, not just informal -- for BOTH counts independently, since a
 * household can have exactly one of each kind at once.
 */
function accountsNote(accountsMissing: number, accountsStale: number): string {
  const missingPhrase = accountsMissing === 1 ? '1 account has no balance yet' : `${accountsMissing} accounts have no balance yet`;
  const stalePhrase =
    accountsStale === 1
      ? `1 account has not reported a balance in over ${STALE_SNAPSHOT_DAYS} days`
      : `${accountsStale} accounts have not reported a balance in over ${STALE_SNAPSHOT_DAYS} days`;

  if (accountsMissing > 0 && accountsStale > 0) {
    return `${missingPhrase}, and ${stalePhrase}. Update them in Settings and Accounts.`;
  }
  if (accountsMissing > 0) {
    return `${missingPhrase}. Update ${accountsMissing === 1 ? 'it' : 'them'} in Settings and Accounts.`;
  }
  return `${stalePhrase}. Update ${accountsStale === 1 ? 'it' : 'them'} in Settings and Accounts.`;
}

/**
 * Task 15b: pairs each taxYearReport() row with whether it is a flagged child nested under a
 * flagged parent that is ALSO present in this year's rows -- the one case where two rows on
 * this card overlap (src/lib/tax.ts's module doc comment: a flagged parent's row always folds
 * in every child's spend, flagged or not, so a separately-flagged child's own row duplicates
 * part of its parent's total by design).
 *
 * A nested row is placed directly after its parent regardless of where taxYearReport's own
 * totalCents-descending sort put it -- the whole point of nesting is that the two rows read
 * together, adjacent, not wherever their totals happened to rank. A child whose parent is not
 * separately flagged (so the parent never appears as its own row here) has nothing to overlap
 * with and stays at the top level, in taxYearReport's original order.
 */
function orderTaxRows(rows: TaxYearDisplayRow[]): { row: TaxYearDisplayRow; nested: boolean }[] {
  const presentIds = new Set(rows.map((row) => row.categoryId));
  const nestedIds = new Set(
    rows.filter((row) => row.parentId !== null && presentIds.has(row.parentId)).map((row) => row.categoryId),
  );
  const ordered: { row: TaxYearDisplayRow; nested: boolean }[] = [];
  for (const row of rows) {
    if (nestedIds.has(row.categoryId)) continue;
    ordered.push({ row, nested: false });
    for (const child of rows) {
      if (nestedIds.has(child.categoryId) && child.parentId === row.categoryId) ordered.push({ row: child, nested: true });
    }
  }
  return ordered;
}

/** The card's own total. A nested row's spend already counts inside the parent row placed
 *  directly above it, so only the non-nested rows are added -- summing every row's totalCents
 *  unconditionally would double the exact overlap this card exists to disclose. */
function taxGrandTotal(ordered: { row: TaxYearDisplayRow; nested: boolean }[]): number {
  return ordered.filter((entry) => !entry.nested).reduce((sum, entry) => sum + entry.row.totalCents, 0);
}
