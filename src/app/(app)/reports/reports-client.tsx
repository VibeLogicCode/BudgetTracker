'use client';

import Link from 'next/link';
import { CategoryBarChart } from '@/components/charts/CategoryBarChart';
import { DebtTrendChart } from '@/components/charts/DebtTrendChart';
import { NetWorthChart } from '@/components/charts/NetWorthChart';
import { SavingsChart } from '@/components/charts/SavingsChart';
import { LoanIcon, ReportsIcon, TrendDownIcon, TrendFlatIcon, TrendUpIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterIcon } from '@/components/ui/icons';
import { Money } from '@/components/ui/Money';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Field, inputClass, selectClass } from '@/components/ui/form';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { rangeParams, type ResolvedRange } from '@/lib/date-range';
import { monthEnd, monthLabel, monthOf, monthStart } from '@/lib/dates';
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
// F-01: the ONE builder for every "show me the rows behind this number" link on this page.
// Pure and client-safe by construction (it value-imports only @/lib/date-range), so the
// dashboard's Server Component and the transactions row menu share it with this file rather
// than each hand-rolling a querystring -- see its own docblock for why that mattered.
import { transactionsHref, type TransactionsLinkScope, type TransactionsLinkTarget } from '@/lib/transaction-links';
import type { TaxYearRow } from '@/lib/tax';

/** Task 15b (v1.7.0): one taxYearReport() row, plus its place in the category tree. tax.ts's
 *  TaxYearRow does not carry parentId -- a tax-year row does not otherwise need it -- so the
 *  page attaches it before handing rows to this card, which needs it to indent a flagged child
 *  under its flagged parent and disclose the overlap (see orderTaxRows below). */
export interface TaxYearDisplayRow extends TaxYearRow {
  parentId: number | null;
}

/**
 * Savings targets, Lane 4 (spec docs/superpowers/plans/2026-08-30-savings-targets.md,
 * v1.17.0). One cashflowTrend() row (Task 14) plus its resolved savings target and whether the
 * month met it -- both read from savingsProgress() (src/lib/savings-target.ts, Lane 1) by
 * reports/page.tsx and carried through here already resolved, exactly the way TaxYearDisplayRow
 * above carries taxYearReport()'s own row plus a field the page attaches. This file never
 * recomputes `targetCents` (percent-of-income resolution) or `met` from scratch -- ruling T1
 * forbids a second definition of "saved", and savingsProgress is the one place that division
 * happens.
 */
/**
 * F-08 (v1.31.0): one `categoryBreakdown` row plus the same category's net spend over the range
 * shifted twelve months back, joined by categoryId BY THE PAGE -- exactly the way
 * TaxYearDisplayRow above carries a field reports/page.tsx attaches. The join happens there, once,
 * because that is where both reads live; doing it here would mean shipping a second array to the
 * browser purely so the browser could rebuild a Map the server already had.
 *
 * `priorCents` is 0 for a category that existed this year and not last. That is a real figure and
 * not a placeholder -- the table renders it as an em dash rather than "$0.00" (formatOrDash), and
 * the Change column says so in words. Whether the comparison is shown AT ALL is a separate,
 * card-level decision carried by `priorYearRange`.
 */
export interface CategoryBreakdownDisplayRow extends CategoryBreakdownRow {
  priorCents: number;
}

export interface SavingsMonthRow extends MonthTrendRow {
  /** null when no target is set this month, or a percent target had no income to resolve
   *  against -- never a fallback zero (see SavingsChart.tsx's SavingsChartRow docblock). */
  targetCents: number | null;
  met: boolean;
}

export function ReportsClient({
  range,
  today,
  person,
  people,
  breakdown,
  priorYearRange,
  income,
  monthOverMonth,
  split,
  debt,
  hasLoans,
  hasLent,
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
  showHouseholdTotals,
  showExport,
}: {
  range: ResolvedRange;
  today: string;
  person: string;
  people: { id: number; name: string }[];
  breakdown: CategoryBreakdownDisplayRow[];
  /**
   * F-08: the window `priorCents` above was summed over -- the picked range shifted twelve months
   * back -- or null when that window held no rows at all.
   *
   * Null hides the two comparison columns outright rather than rendering them full of zeros. A
   * column of "$0.00" against last year does not read as "we have no statements from then"; it
   * reads as "we spent nothing", which is a different and false claim. v1.30.0 fixed exactly that
   * mistake in a notification, and this is the same mistake with a table around it.
   */
  priorYearRange: { from: string; to: string } | null;
  /**
   * F-04: `categoryBreakdown({ includeIncome: true })`'s income rows for the same range and
   * person, rollup OFF and sorted largest first by the page. Rollup is off deliberately: the
   * seeded tree files payroll under Income > Salary, so a rolled-up read collapses to the single
   * "money in" figure the dashboard already shows -- the exact question this card exists to break
   * apart. Amounts arrive NEGATIVE (netSpentCents' sign convention for income); the card renders
   * their magnitude.
   */
  income: CategoryBreakdownRow[];
  monthOverMonth: { months: string[]; rows: CategoryMonthTrend[] };
  split: PersonSplitRow[];
  debt: DebtPoint[];
  hasLoans: boolean;
  /** v1.14.0 (spec BU, ruling P12): true when at least one loan with a tracked balance points
   *  'lent' -- decides only whether the debt chart draws a second line and shows a legend, and
   *  whether the card's description mentions lending. It does NOT gate the card itself: that is
   *  still hasLoans alone, unchanged, so an all-owed household sees exactly what it always has. */
  hasLent: boolean;
  netWorth: NetWorthPoint[];
  baselines: BaselineRow[];
  baselineMonthsUsed: number;
  /** Task 12: the largest net charges over the range/person scope above, limit 15. */
  merchants: TopMerchantRow[];
  /** Task 13: this month vs last month vs the same month last year, rolled up and person-scoped. */
  yoy: YoYRow[];
  /** The month the Task 13 card is comparing, echoed back so the picker keeps its value. */
  yoyMonth: string;
  /** Task 14: cashflowTrend() over the range's whole-month span, capped at 24. Lane 4 (v1.17.0):
   *  each row also carries that month's resolved savings target and whether it was met, both
   *  already resolved by the page via savingsProgress() -- see SavingsMonthRow above. */
  cashflow: SavingsMonthRow[];
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
  /** v1.13.0 ruling R2 (fix round 1, controller directive): false for a self viewer -- net
   *  worth, debt-over-time and the tax-year card are all DROPPED ENTIRELY, not rendered as a
   *  scoped-to-zero/empty-state version of themselves. R2 binds every page, not just the
   *  dashboard, and reads categorically ("NO account balances, NO net worth, NO reports of
   *  household totals"), not "scoped to the viewer's own accounts". */
  showHouseholdTotals: boolean;
  /** v1.13.0 ruling R2 (fix round 2, controller directive): false for a self viewer -- the
   *  top "Export CSV" control is not OFFERED at all, not merely refused server-side. Task
   *  14 gates /api/reports/export for a self viewer, but the ruling reads "no export links
   *  offered", so the control itself must not appear. */
  showExport: boolean;
}) {
  const exportHref = `/api/reports/export?${new URLSearchParams({
    ...rangeParams(range),
    ...(person ? { person } : {}),
  }).toString()}`;

  /**
   * F-01. The scope every range-driven card on this page was built with, resolved ONCE: the
   * picker's own range and the person filter the page force-scoped through the viewer. Every
   * drill-down below either passes this object or passes a scope of its own with a comment
   * saying why it differs (the year-over-year card follows its compare month; the tax card
   * follows its year and its row's own person). One value rather than a literal at each call
   * site is what makes "does this link carry the person scope?" answerable by reading, and a
   * dropped scope visible in a diff.
   */
  const rangeScope: TransactionsLinkScope = { range, person };

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
    <div data-page-width="wide" className="flex flex-col gap-4 sm:gap-5">
      <PageHeader
        eyebrow={range.label}
        title="Reports"
        description={
          showPersonSplit
            ? 'Where the money went over a stretch of time, by category and by person.'
            : 'Where the money went over a stretch of time, by category.'
        }
        actions={
          showExport ? (
            <a href={exportHref} className="btn btn--secondary">
              Export CSV
            </a>
          ) : undefined
        }
      />

      {/* item BM (ruling P15): both clauses are gated, not just the Export one the backlog named.
          showExport and showPersonSplit are both !isSelfScoped(viewer) (reports/page.tsx:169,176),
          and this paragraph made two promises a self viewer cannot keep -- a control that is not on
          their page (:140-146) and a card that is dropped for them (:412).

          Review B fix round (item 3): the second clause below -- "and person at the top drive
          every card" -- named the Person select even when showPersonSplit is false, and the third
          paragraph named Net worth and Tax year even when showHouseholdTotals is false (both cards
          are dropped entirely for that viewer, ruling R2). Same class of bug as the two clauses
          above; this just gates the rest of it. */}
      <PageGuide>
        <p>
          Reports answers questions about a stretch of time rather than the current month: where
          the money went by category, how one month compares with the last, how a year compares
          with the year before
          {showPersonSplit ? ", and how the household's split by person works out" : ''}.{' '}
          {showPersonSplit
            ? 'The date range and person at the top drive every card below at once'
            : 'The date range at the top drives every card below at once'}
          {showExport ? (
            <>
              , and <strong className="font-semibold text-ink">Export CSV</strong> gives you the same
              rows in a spreadsheet
            </>
          ) : null}
          .
        </p>
        <p>
          Most of these cards are comparisons, so they have nothing to compare until several
          months of statements are on file. A card saying it does not have enough history yet is
          not broken — importing older statements is what fills it in, and month-over-month,
          year-over-year and the spending baselines all get more useful the further back your
          imports go.
        </p>
        {showHouseholdTotals ? (
          <p>
            Two cards are waiting on a setting rather than on history. Net worth needs a balance
            recorded against at least one account under Settings, and the Tax year card only lists
            categories you have marked as tax relevant under Settings and Managers. Neither will
            fill in from importing more months.
          </p>
        ) : null}
      </PageGuide>

      <Card>
        <CardBody className="flex flex-col gap-3 pt-5">
          {/* Lane 4 (2026-08-30 one-design-language plan): Reports keeps every chart and table
              as-is (ruling D7) and adopts only the tightened shell and a SectionHeader -- this
              is the one section on the page with no CardHeader of its own to already carry
              that role. */}
          <SectionHeader title="Filter" icon={<FilterIcon className="h-4 w-4" />} />
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

      {/* v1.13.0 ruling R2 (item C1): dropped entirely for a self viewer, not rendered as a
          scoped-to-zero/empty-state version -- this card is always household-wide
          (suggestionsFor's scope: 'household' on the page), so there is no honest per-person
          version of it to show a self viewer instead. Same pattern as the Net worth and Tax
          year cards below. */}
      {showHouseholdTotals ? (
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
            <TableWrap bare responsive>
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
                    <td className="cell-stack-headline" data-label="Category">{row.categoryName}</td>
                    <AmountCell data-label="Median">
                      <Money cents={row.suggestion.medianCents} plain />
                    </AmountCell>
                    <AmountCell data-label="Average">
                      <Money cents={row.suggestion.meanCents} plain />
                    </AmountCell>
                    <td data-label="Trend">
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        {row.suggestion.trend.direction === 'rising' ? <TrendUpIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'falling' ? <TrendDownIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'flat' ? <TrendFlatIcon className="h-4 w-4" /> : null}
                        {row.suggestion.trend.direction === 'unknown'
                          ? null
                          : `${row.suggestion.trend.direction === 'rising' ? 'Rising' : row.suggestion.trend.direction === 'falling' ? 'Falling' : 'Flat'} ${formatCents(Math.abs(row.suggestion.trend.deltaCents), { currency: true })}`}
                      </span>
                    </td>
                    {/* Suggested, not Median or Average, is the amount call: it is the figure
                        this card exists to hand off to the "Use $X" button on Budgets, so it
                        is the one worth a glance in row 1 of the phone card. */}
                    <AmountCell data-label="Suggested" className="cell-stack-amount">
                      <Money cents={row.suggestion.suggestedCents} plain />
                    </AmountCell>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </CardBody>
      </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Category breakdown"
          description={
            priorYearRange
              ? `Net spend per category over the range, beside the same stretch a year earlier (${priorYearRange.from} to ${priorYearRange.to}).`
              : 'Net spend per category over the range.'
          }
        />
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
          <>
            <CardBody>
              <CategoryBarChart data={breakdown} />
            </CardBody>
            {/* F-01/F-08: the chart keeps its job (ruling D7 -- Reports keeps its charts as they
                are) and the table beside it does the two things a <Bar> cannot: carry a link per
                category, and carry a second figure per category. The chart plots the top 12; this
                table is every row, which is also why the card's own total is not restated here --
                the rows ARE the breakdown. */}
            <TableWrap bare responsive>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="text-right">Net spent</th>
                  {priorYearRange ? (
                    <>
                      <th scope="col" className="text-right">Same period last year</th>
                      <th scope="col">Change</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={row.categoryId ?? 'uncategorized'}>
                    <td className="cell-stack-headline" data-label="Category">
                      <DrillLink scope={rangeScope} target={{ kind: 'category', categoryId: row.categoryId, exact: row.direct }}>
                        {row.categoryName}
                      </DrillLink>
                    </td>
                    <AmountCell data-label="Net spent" className="cell-stack-amount">
                      <Money cents={row.spentCents} plain />
                    </AmountCell>
                    {priorYearRange ? (
                      <>
                        <AmountCell data-label="Same period last year" className="text-muted">
                          {formatOrDash(row.priorCents)}
                        </AmountCell>
                        <td data-label="Change">{yoyChange(row.spentCents, row.priorCents, 'No spend in this range last year')}</td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </>
        )}
      </Card>

      {/* F-04. Not gated on showHouseholdTotals: unlike Net worth or the tax year, income by
          source has an honest per-person shape -- categoryBreakdown force-scopes a self viewer to
          their OWN attributed rows through `viewer` (scopeFor, src/lib/reports.ts), so what a
          child sees here is their own money and nothing else, exactly like the Category breakdown
          card directly above. */}
      <Card>
        <CardHeader title="Income by source" description="What came in over the range, by income category." />
        {income.length === 0 ? (
          <EmptyState
            icon={ReportsIcon}
            title="No income in this range"
            action={
              <Link href="/settings/managers" className="btn btn--secondary btn--sm">
                Mark a category as income
              </Link>
            }
          >
            Income shows up here once a category is marked as income and a deposit is filed under it.
          </EmptyState>
        ) : (
          <TableWrap bare responsive>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="text-right">Received</th>
              </tr>
            </thead>
            <tbody>
              {income.map((row) => (
                <tr key={row.categoryId ?? 'uncategorized'}>
                  <td className="cell-stack-headline" data-label="Source">
                    <DrillLink scope={rangeScope} target={{ kind: 'category', categoryId: row.categoryId, exact: row.direct }}>
                      {row.categoryName}
                    </DrillLink>
                  </td>
                  {/* netSpentCents makes income negative (it is the negation of a signed sum, and
                      a deposit's sign is positive), so the magnitude is the figure a person means
                      by "how much came in". `plain` keeps it uncoloured for the same reason the
                      spend columns are uncoloured: a positive number here means money in, and
                      Money's own red/green pair would paint it by SIGN, which is the opposite
                      reading. */}
                  <AmountCell data-label="Received" className="cell-stack-amount">
                    <Money cents={-row.spentCents} plain />
                  </AmountCell>
                </tr>
              ))}
            </tbody>
          </TableWrap>
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
            <SavingsChart data={cashflow} />
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
          <TableWrap bare responsive>
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
                  <td className="whitespace-nowrap font-medium text-ink cell-stack-headline" data-label="Category">
                    {/* `exact` -- categoryMonthOverMonth groups by the transaction's OWN category
                        with no rollup (src/lib/reports.ts), so a parent's row here is that
                        parent's direct rows only. A link without `exact=1` would list the parent
                        AND every child: a larger set than the total beside it. */}
                    <DrillLink scope={rangeScope} target={{ kind: 'category', categoryId: row.categoryId, exact: true }}>
                      {row.categoryName}
                    </DrillLink>
                  </td>
                  {monthOverMonth.months.map((month) => (
                    <td key={month} className="text-right text-muted" data-label={month}>
                      {formatOrDash(row.byMonth[month] ?? 0)}
                    </td>
                  ))}
                  {/* Total, not any one month, is the amount call: the month columns vary in
                      count from one range to the next, and the total is the one figure every
                      render of this card actually has. */}
                  <td className="text-right font-semibold cell-stack-amount" data-label="Total">
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
          <TableWrap bare responsive>
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
                  <td className="whitespace-nowrap font-medium text-ink cell-stack-headline" data-label="Category">
                    {/* This card follows its OWN compare month, not the page's date range -- the
                        range picker never touched these three figures, so a link carrying it
                        would open a list that does not contain the number beside it. The month
                        chosen is the "This month" column's, the figure the other two exist to be
                        compared against and the one this row is sorted by. No `exact`:
                        categoryYearOverYear rolls children into their parent, so a row here
                        really is the parent plus everything under it. */}
                    <DrillLink
                      scope={{ range: { from: monthStart(yoyMonth), to: monthEnd(yoyMonth) }, person }}
                      target={{ kind: 'category', categoryId: row.categoryId }}
                    >
                      {row.categoryName}
                    </DrillLink>
                  </td>
                  {/* This month, not Last month or Last year, is the amount call: it is
                      today's figure, the one the other two columns exist to compare against. */}
                  <td className="text-right cell-stack-amount" data-label="This month">{formatOrDash(row.thisMonthCents)}</td>
                  <td className="text-right text-muted" data-label="Last month">{formatOrDash(row.lastMonthCents)}</td>
                  <td className="text-right text-muted" data-label="Last year">{formatOrDash(row.lastYearCents)}</td>
                  <td data-label="Change">{yoyChange(row.thisMonthCents, row.lastYearCents)}</td>
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
          {/* item A (ruling P2): NOT split.length === 0 -- personSpendSplit always pushes the
              unattributed bucket (src/lib/reports.ts:361-362), deliberately, so this array is never
              empty for the only viewer who sees this card and the branch below was unreachable. The
              honest condition is "there is nothing to split", which is every row at zero. */}
          {split.every((row) => row.spentCents === 0) ? (
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
          <TableWrap bare responsive>
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
                  <td className="whitespace-nowrap font-medium text-ink cell-stack-headline" data-label="Merchant">
                    {/* A search, not a merchant id -- there is no merchant table, and `?q=` is the
                        same hop NeedsALookCard has always used from a flagged charge. The name is
                        already the folded/renamed identity topMerchants grouped by (item 8b), so
                        searching it finds the same rows the bucket counted. */}
                    <DrillLink scope={rangeScope} target={{ kind: 'merchant', merchant: row.normalizedMerchant }}>
                      {row.normalizedMerchant}
                    </DrillLink>
                  </td>
                  <td className="text-right text-muted" data-label="Charges">{row.count}</td>
                  <AmountCell data-label="Net spent" className="cell-stack-amount">
                    <Money cents={row.spentCents} plain />
                  </AmountCell>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      {/* Ruling R2 (fix round 1, controller directive): dropped entirely for a self viewer, not
          rendered as a scoped-to-zero/empty-state version -- R2 gives them NO net worth, full
          stop, not one restricted to their own accounts. */}
      {showHouseholdTotals ? (
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
      ) : null}

      {/* Ruling R2 (fix round 1): dropped entirely for a self viewer -- taxYearReport() rolls up
          every household member's spend with no owner scoping of its own, and the Download CSV
          link below points at a household-wide route (Task 14 refuses it server-side, but a
          self viewer is not offered it here in the first place). */}
      {showHouseholdTotals ? (
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
              <TableWrap bare responsive>
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
                        {/* v1.15.0 (responsive rows): same tree shape as Budgets -- the
                            nested-child indent (paddingLeft) and the phone card's headline
                            share this one cell, so a nested row keeps its indent on screen. */}
                        <td
                          style={{ paddingLeft: nested ? '36px' : '16px' }}
                          className={`${nested ? 'text-muted' : 'font-medium text-ink'} cell-stack-headline`}
                          data-label="Category"
                        >
                          {/* F-01's highest-value link: the whole tax year, that category, THAT
                              PERSON. The person comes from the ROW, never from the page's filter
                              -- taxYearReport takes no person scope at all, so this card's own
                              figures do not follow the picker and a link that carried it would
                              open a list that does not add up to the amount beside it. The
                              transaction list this reaches is what a return actually needs, which
                              the Category/Person/Amount CSV (src/lib/tax.ts) cannot give. */}
                          <DrillLink
                            scope={{
                              range: { from: `${taxYear}-01-01`, to: `${taxYear}-12-31` },
                              person: personRow.userId ?? 'unattributed',
                            }}
                            target={{ kind: 'category', categoryId: row.categoryId }}
                          >
                            {row.categoryName}
                          </DrillLink>
                        </td>
                        <td className="text-muted" data-label="Person">{personRow.label}</td>
                        <AmountCell data-label="Amount" className="cell-stack-amount">
                          <Money cents={personRow.cents} plain />
                        </AmountCell>
                      </tr>
                    )),
                  )}
                  <tr>
                    {/* This summary row's first cell spans Category+Person -- it is not any
                        one column's value, so it gets no label, the same rule a colSpan
                        sub-row follows everywhere else in this release. */}
                    <td colSpan={2} className="font-semibold text-ink" data-label="">
                      Total
                    </td>
                    <AmountCell className="font-semibold cell-stack-amount" data-label="Amount">
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
      ) : null}

      {/* Ruling R2 (fix round 1): showHouseholdTotals gates this independently of hasLoans, so
          "hidden because self-viewer" is never conflated with "hidden because this household
          genuinely has no loans yet". */}
      {!showHouseholdTotals || !hasLoans ? null : (
        <Card>
          <CardHeader
            title="Debt over time"
            description={
              hasLent
                ? 'What the household owes, and what it has lent out, as separate lines.'
                : 'Total owed across every loan with a balance.'
            }
          />
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
              <DebtTrendChart data={debt} showLent={hasLent} />
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

/**
 * F-01: one component for every drill-down on this page, so the link AFFORDANCE is as single as
 * the URL builder behind it. Both props are required and neither has a default -- a call site
 * has to name the scope it is linking with, which is the whole point (a link that silently
 * inherits "no person filter" is how a household figure's rows reach somebody who asked about one
 * person).
 *
 * `min-h-11 sm:min-h-0`: below `sm` these tables reflow into stacked cards where the category
 * name is the row's headline and the only tap target on it, so it carries the 44px minimum. On a
 * desktop row it goes back to sitting on the text's own line height, because a 44px-tall cell in
 * a table of fifteen categories is a table nobody can see the bottom of.
 */
function DrillLink({
  scope,
  target,
  children,
}: {
  scope: TransactionsLinkScope;
  target: TransactionsLinkTarget;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={transactionsHref(scope, target)}
      className="inline-flex min-h-11 items-center text-accent-text hover:underline sm:min-h-0"
    >
      {children}
    </Link>
  );
}

/** A zero in a month-over-month grid is noise; an em dash reads as "nothing here". */
function formatOrDash(cents: number): React.ReactNode {
  if (cents === 0) return <span className="text-subtle">—</span>;
  return <Money cents={cents} plain />;
}

/**
 * Task 14 + Lane 4 (savings targets, v1.17.0): the Cash flow and savings rate card's one-line
 * summary. All the money arithmetic (including the division-by-zero guard) lives in
 * savingsRate() (src/lib/savings-rate.ts); whether a month met its target lives in
 * savingsProgress() (src/lib/savings-target.ts, Lane 1) and reaches this file already resolved
 * on each row (SavingsMonthRow above) -- this function only formats and counts what is already
 * computed, so it never invents a second definition of either "saved" or "met" (ruling T1).
 *
 * A month with no target set is neither met nor missed -- the same "no opinion" rule
 * savingsProgress/savingsStreak apply -- so it is left out of both the numerator and the
 * denominator of the added sentence. The sentence itself is skipped entirely when no month in
 * the range has a target at all: "met in 0 of 0 months" is not a fact worth stating.
 */
function cashflowSummary(rows: SavingsMonthRow[]): string {
  const rate = savingsRate(rows);
  if (rate.pct === null) return 'No income recorded in this range.';
  const base = `Income ${formatCents(rate.incomeCents)} · Spent ${formatCents(rate.spendCents)} · Saved ${formatCents(rate.netCents)} (${rate.pct}%)`;
  const withTarget = rows.filter((row) => row.targetCents !== null);
  if (withTarget.length === 0) return base;
  const met = withTarget.filter((row) => row.met).length;
  return `${base} · Target met in ${met} of ${withTarget.length} month${withTarget.length === 1 ? '' : 's'}.`;
}

/**
 * Task 13: the YoY card's delta indicator. A category with nothing spent in the reference period
 * has no percentage change to report, so this says so in words rather than dividing by zero --
 * the same guard savingsRate() applies for the card above.
 *
 * F-08 (v1.31.0) gave it a second caller -- the Category breakdown's "same period last year"
 * column -- rather than a second copy. Only the zero-reference SENTENCE differs between them
 * ("this month" against a range the person picked), so only that sentence is a parameter; the
 * percentage, the rounding, the direction and the icons stay one implementation. Writing a
 * near-identical `rangeChange()` beside it is exactly the "one idea implemented twice" shape this
 * review lineage keeps finding.
 */
function yoyChange(thisMonthCents: number, lastYearCents: number, noReferenceCopy = 'No spend this month last year'): React.ReactNode {
  if (lastYearCents === 0) {
    if (thisMonthCents === 0) return <span className="text-subtle">—</span>;
    return <span className="text-xs text-muted">{noReferenceCopy}</span>;
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
