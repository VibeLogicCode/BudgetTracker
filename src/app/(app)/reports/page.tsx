import { requireUser } from '@/lib/auth/session';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { listUsers } from '@/lib/auth/users';
import { listCategories } from '@/lib/categories';
import { debtOverTime, listLoans } from '@/lib/loans';
import { netWorthOverTime } from '@/lib/networth';
import {
  cashflowTrend,
  categoryBreakdown,
  categoryMonthOverMonth,
  categoryYearOverYear,
  personSpendSplit,
  topMerchants,
} from '@/lib/reports';
import { addMonthsClamped, isMonthKey, monthOf, monthsBetween, todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
import { suggestionsFor } from '@/lib/predict/history';
import type { BaselineRow } from '@/lib/predict/suggest';
import { savingsProgress } from '@/lib/savings-target';
import { taxYearReport, taxYears } from '@/lib/tax';
import {
  ReportsClient,
  type CategoryBreakdownDisplayRow,
  type SavingsMonthRow,
  type TaxYearDisplayRow,
} from './reports-client';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // MUST-11.4: the server resolves today, in the configured TZ, and hands it down. The client
  // never computes a date from the browser clock.
  const today = todayIso(new Date(), readEnv().tz);
  const range = resolveRange({
    preset: one('range'),
    from: one('from'),
    to: one('to'),
    today,
    fallback: 'last_6_months',
  })!; // non-null: the fallback is non-null
  const from = range.from;
  const to = range.to;
  const personRaw = one('person');
  const urlScope = personRaw === 'unattributed' ? 'unattributed' : personRaw && /^\d+$/.test(personRaw) ? Number(personRaw) : null;
  // Ruling R2: a self viewer's person scope is THEIR OWN id, whatever the URL asked for -- the
  // person picker and the "Who spent it" card are hidden entirely for them below
  // (showPersonSplit), and every aggregate call is force-scoped through `viewer` regardless, but
  // this keeps the <select>'s own value and the CSV export link honest about what is actually
  // being read.
  const person = ownerScope(viewer) ?? urlScope;

  /**
   * v1.13.0 ruling R2 (fix round 1, controller directive). R2 binds every page, not just the
   * dashboard: a self viewer gets NO account balances, NO net worth, and NO report of a
   * household total. Net worth, debt-over-time and the tax-year card are all household-scope
   * (debtOverTime and taxYears/taxYearReport take no viewer at all; netWorthOverTime's own
   * accounts are scoped to the viewer, but R2 is categorical here the same way the dashboard's
   * netWorthLatest already is -- no net worth for a self viewer, full stop, not merely one
   * restricted to their own accounts). The three household-wide queries below are skipped
   * OUTRIGHT for a self viewer, not run and discarded -- the same "no household figure leaves
   * this file, even unrendered" reasoning already applied on budgets/page.tsx's household-scope
   * suggestion skip.
   */
  const showHouseholdTotals = !isSelfScoped(viewer);

  // Task 13 (v1.7.0): the year-over-year card's own month picker, independent of the range
  // above -- "this month" is always exactly one month, never a range. It lives in the same
  // filter form as range/person (below) so Apply carries all three at once and no card's scope
  // resets when another one changes.
  const yoyRaw = one('yoyMonth');
  const yoyMonth = yoyRaw && isMonthKey(yoyRaw) ? yoyRaw : monthOf(today);

  // Task 14 (v1.7.0): cashflowTrend is monthly, so the picked date range becomes a whole-month
  // span for it, capped at 24 -- the same cap Debt over time and Net worth already use below --
  // rather than inventing a day-granular series that does not exist.
  const cashflowMonths = Math.min(24, monthsBetween(monthOf(from), monthOf(to)) + 1);
  const cashflowRows = cashflowTrend(cashflowMonths, { endMonth: monthOf(to), attributedUserId: person }, viewer);
  // Lane 4 (savings targets, v1.17.0 spec): each month's resolved target and whether it was met
  // come from savingsProgress() (Lane 1, src/lib/savings-target.ts) -- never recomputed here
  // (ruling T1). savingsProgress is household-scope by construction (ruling T3: there is no
  // per-person savings target), so these two figures do not follow the Person filter above the
  // way the rest of this card's own Income/Spend bars do; that is the correct reading of "one
  // household, one target" rather than a gap to close.
  const cashflow: SavingsMonthRow[] = cashflowRows.map((row) => {
    const progress = savingsProgress(row.month, viewer);
    return { ...row, targetCents: progress.targetCents, met: progress.met };
  });

  // MUST-14.8: this card's window is the last 6 FULL calendar months, always, whatever the
  // picker says. MUST-16.5: one query, not one per category.
  //
  // MUST-11.4: the month comes from the `today` Task 11 already resolved in the app's TZ, NOT
  // from a bare currentMonth(). Near a month boundary a container-local month would make this
  // card and the picker directly above it disagree about what month it is.
  //
  // v1.13.0 ruling R2 (item C1): this call was unconditional and always scope: 'household',
  // userId: null -- so a self viewer's RSC payload carried the whole household's category
  // baselines regardless of whether the "Category baselines" card below rendered them. Skipped
  // OUTRIGHT for a self viewer, not run and discarded, mirroring budgets/page.tsx's household-
  // scope suggestion skip (see this file's own showHouseholdTotals comment above).
  const baseline = showHouseholdTotals ? suggestionsFor({ targetMonth: monthOf(today), scope: 'household', userId: null }) : null;
  // MUST-14.7 and F19: TOP-LEVEL categories only. categorySeries mirrors budgetProgress, so it
  // also produces a row for each child; listing Food beside Groceries, whose medians overlap by
  // construction, would read as double counting on a card that has no indentation to explain it.
  const allCategories = listCategories({ includeArchived: true });
  const topLevelNames = new Map(
    allCategories.filter((category) => category.parentId === null).map((category) => [category.id, category.name] as const),
  );
  const baselines: BaselineRow[] = [];
  if (baseline !== null) {
    for (const [categoryId, result] of baseline.byCategory) {
      if (!('suggestion' in result)) continue;
      const categoryName = topLevelNames.get(categoryId);
      if (categoryName === undefined) continue;
      baselines.push({ categoryId, categoryName, suggestion: result.suggestion });
    }
    baselines.sort((a, b) => b.suggestion.medianCents - a.suggestion.medianCents);
  }

  // Task 15b (v1.7.0): the tax-year report card. taxYears() lists every year that has at least
  // one non-transfer transaction, independent of whether any category is currently flagged
  // tax-relevant (see its doc comment in src/lib/tax.ts) -- a household with plenty of data but
  // no flagged category yet still gets a normal year picker; it is taxYearReport's own empty
  // result, not an empty year list, that tells the card to show its "nothing marked
  // tax-relevant" empty state. The requested year is only honored when it is both a plain
  // four-digit number and one of the years taxYears() actually returned; anything else
  // (missing, malformed, or simply a year with no data) falls back to the newest year so the
  // <select>, the table and the Download CSV link can never desync from each other.
  const taxYearOptions = showHouseholdTotals ? taxYears() : [];
  const taxYearRaw = one('taxYear');
  const requestedTaxYear = taxYearRaw && /^\d{4}$/.test(taxYearRaw) ? Number(taxYearRaw) : null;
  const selectedTaxYear =
    requestedTaxYear !== null && taxYearOptions.includes(requestedTaxYear) ? requestedTaxYear : (taxYearOptions[0] ?? null);
  const categoryParentById = new Map(allCategories.map((category) => [category.id, category.parentId] as const));
  const taxRows: TaxYearDisplayRow[] =
    selectedTaxYear === null
      ? []
      : taxYearReport(selectedTaxYear).map((row) => ({ ...row, parentId: categoryParentById.get(row.categoryId) ?? null }));

  /**
   * F-08 (v1.31.0): the same breakdown over the same range shifted twelve months back, joined by
   * categoryId. `addMonthsClamped` (src/lib/dates.ts) does the day-level shift, so 29 February
   * lands on 28 February rather than overflowing into March the way Date.setMonth would.
   *
   * A SECOND call to the function the card already uses, with the same person scope and the same
   * viewer -- not a new aggregate. Anything narrower would have to re-decide what counts as
   * spend, which is exactly the disagreement SPEND_ROW_WHERE (src/lib/spend-where.ts) exists to
   * make impossible; anything wider would be a read model nobody asked for.
   *
   * `priorYearRange` is null when the shifted window held no rows AT ALL, and that nullness is
   * what hides the two columns on the card. It is deliberately not "every row's prior figure is
   * zero": a household that has been running for three months has no last year, and a table of
   * "$0.00 last year" tells them they spent nothing then rather than that nothing is known. A row
   * that IS zero inside a range that has other rows is a real figure and stays (rendered as an em
   * dash, with the change stated in words).
   */
  const priorFrom = addMonthsClamped(from, -12);
  const priorTo = addMonthsClamped(to, -12);
  const priorRows = categoryBreakdown({ from: priorFrom, to: priorTo, attributedUserId: person, rollup: true }, viewer);
  const priorByCategory = new Map(priorRows.map((row) => [row.categoryId, row.spentCents]));
  const breakdown: CategoryBreakdownDisplayRow[] = categoryBreakdown(
    { from, to, attributedUserId: person, rollup: true },
    viewer,
  ).map((row) => ({ ...row, priorCents: priorByCategory.get(row.categoryId) ?? 0 }));

  /**
   * F-04 (v1.31.0). `categoryBreakdown` has taken `includeIncome` since v1.7.0 and no caller in
   * the repository ever passed it -- income categories are first-class in the schema, the
   * merchant pack files payroll into them, and the Reports page hid the split anyway.
   *
   * Rollup OFF, unlike the spend breakdown above: the seeded tree is Income > Salary / Other
   * Income, so a rolled-up read answers "income: $6,000" -- the one figure the dashboard's Money
   * in tile already shows, and the exact question this card exists to break apart.
   *
   * Sorted here rather than relying on categoryBreakdown's own sort: that sort is descending by
   * `spentCents`, and income rows carry a NEGATIVE spentCents (netSpentCents' sign convention),
   * so its order puts the smallest income first. Ascending on the same field is "largest income
   * first" for exactly the same reason.
   *
   * Scoped like every other card here -- same range, same person, same viewer -- so a self-scoped
   * member sees their own income and nobody else's (scopeFor, src/lib/reports.ts).
   */
  const income = categoryBreakdown({ from, to, attributedUserId: person, includeIncome: true }, viewer)
    .filter((row) => row.isIncome)
    .sort((a, b) => a.spentCents - b.spentCents);

  // v1.14.0 (ruling P12): ONE read, two flags. hasLoans keeps its exact meaning -- any loan with
  // a tracked balance, either direction -- so the card's visibility does not change for any
  // existing install; hasLent decides only whether a second LINE and a legend appear.
  const loansForFlags = showHouseholdTotals ? listLoans(today, viewer) : [];
  const hasLoans = loansForFlags.some((loan) => loan.currentBalanceCents !== null);
  const hasLent = loansForFlags.some((loan) => loan.loanDirection !== 'owed' && loan.currentBalanceCents !== null);

  return (
    <ReportsClient
      range={range}
      today={today}
      person={person === null ? '' : String(person)}
      // v1.13.0 ruling R2 (fix round 2). listUsers() names every household member -- an
      // RSC payload prop reaches the browser even when the client component never renders
      // it, so a self viewer (whose Person <select> is hidden entirely via showPersonSplit)
      // must not receive the other names at all, not merely be shown a select that omits
      // them. Same principle as suggestionsFor/netWorthOverTime/debtOverTime/taxYears above.
      people={showHouseholdTotals ? listUsers().map((u) => ({ id: u.id, name: u.name })) : []}
      breakdown={breakdown}
      priorYearRange={priorRows.length === 0 ? null : { from: priorFrom, to: priorTo }}
      income={income}
      monthOverMonth={categoryMonthOverMonth(
        { fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7), attributedUserId: person, limit: 10 },
        viewer,
      )}
      split={personSpendSplit({ from, to }, viewer)}
      debt={showHouseholdTotals ? debtOverTime(24) : []}
      hasLoans={hasLoans}
      hasLent={hasLent}
      // Same fixed trailing-24-month window as the Debt over time card above, deliberately
      // independent of the date-range picker at the top of the page (a net worth trend, like a
      // debt trend, is a "how did we get here" widget, not a "for this custom range" one).
      netWorth={showHouseholdTotals ? netWorthOverTime(24, { today, viewer }) : []}
      baselines={baselines}
      baselineMonthsUsed={baseline === null ? 0 : baseline.months.length}
      merchants={topMerchants({ from, to, limit: 15, attributedUserId: person }, viewer)}
      yoy={categoryYearOverYear({ month: yoyMonth, attributedUserId: person }, viewer)}
      yoyMonth={yoyMonth}
      cashflow={cashflow}
      taxYears={taxYearOptions}
      taxYear={selectedTaxYear}
      taxRows={taxRows}
      // Ruling R2: a self viewer sees no person split at all -- there is no per-person
      // breakdown to show when the person scope is always and only themselves.
      showPersonSplit={!isSelfScoped(viewer)}
      // Ruling R2 (fix round 1): net worth, debt-over-time and the tax-year card are all
      // dropped entirely for a self viewer, not shown as a scoped-to-zero/empty-state version.
      showHouseholdTotals={showHouseholdTotals}
      // Ruling R2 (fix round 2): the top "Export CSV" control is not offered to a self
      // viewer at all -- Task 14 gates /api/reports/export server-side for them, but the
      // ruling was "no export links offered", not merely "the route refuses them".
      showExport={!isSelfScoped(viewer)}
    />
  );
}
