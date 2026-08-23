import { requireUser } from '@/lib/auth/session';
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
import { isMonthKey, monthOf, monthsBetween, todayIso } from '@/lib/dates';
import { resolveRange } from '@/lib/date-range';
import { readEnv } from '@/lib/env';
import { suggestionsFor } from '@/lib/predict/history';
import type { BaselineRow } from '@/lib/predict/suggest';
import { taxYearReport, taxYears } from '@/lib/tax';
import { ReportsClient, type TaxYearDisplayRow } from './reports-client';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
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
  const person = personRaw === 'unattributed' ? 'unattributed' : personRaw && /^\d+$/.test(personRaw) ? Number(personRaw) : null;

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

  // MUST-14.8: this card's window is the last 6 FULL calendar months, always, whatever the
  // picker says. MUST-16.5: one query, not one per category.
  //
  // MUST-11.4: the month comes from the `today` Task 11 already resolved in the app's TZ, NOT
  // from a bare currentMonth(). Near a month boundary a container-local month would make this
  // card and the picker directly above it disagree about what month it is.
  const baseline = suggestionsFor({ targetMonth: monthOf(today), scope: 'household', userId: null });
  // MUST-14.7 and F19: TOP-LEVEL categories only. categorySeries mirrors budgetProgress, so it
  // also produces a row for each child; listing Food beside Groceries, whose medians overlap by
  // construction, would read as double counting on a card that has no indentation to explain it.
  const allCategories = listCategories({ includeArchived: true });
  const topLevelNames = new Map(
    allCategories.filter((category) => category.parentId === null).map((category) => [category.id, category.name] as const),
  );
  const baselines: BaselineRow[] = [];
  for (const [categoryId, result] of baseline.byCategory) {
    if (!('suggestion' in result)) continue;
    const categoryName = topLevelNames.get(categoryId);
    if (categoryName === undefined) continue;
    baselines.push({ categoryId, categoryName, suggestion: result.suggestion });
  }
  baselines.sort((a, b) => b.suggestion.medianCents - a.suggestion.medianCents);

  // Task 15b (v1.7.0): the tax-year report card. taxYears() lists every year that has at least
  // one non-transfer transaction, independent of whether any category is currently flagged
  // tax-relevant (see its doc comment in src/lib/tax.ts) -- a household with plenty of data but
  // no flagged category yet still gets a normal year picker; it is taxYearReport's own empty
  // result, not an empty year list, that tells the card to show its "nothing marked
  // tax-relevant" empty state. The requested year is only honored when it is both a plain
  // four-digit number and one of the years taxYears() actually returned; anything else
  // (missing, malformed, or simply a year with no data) falls back to the newest year so the
  // <select>, the table and the Download CSV link can never desync from each other.
  const taxYearOptions = taxYears();
  const taxYearRaw = one('taxYear');
  const requestedTaxYear = taxYearRaw && /^\d{4}$/.test(taxYearRaw) ? Number(taxYearRaw) : null;
  const selectedTaxYear =
    requestedTaxYear !== null && taxYearOptions.includes(requestedTaxYear) ? requestedTaxYear : (taxYearOptions[0] ?? null);
  const categoryParentById = new Map(allCategories.map((category) => [category.id, category.parentId] as const));
  const taxRows: TaxYearDisplayRow[] =
    selectedTaxYear === null
      ? []
      : taxYearReport(selectedTaxYear).map((row) => ({ ...row, parentId: categoryParentById.get(row.categoryId) ?? null }));

  return (
    <ReportsClient
      range={range}
      today={today}
      person={personRaw ?? ''}
      people={listUsers().map((u) => ({ id: u.id, name: u.name }))}
      breakdown={categoryBreakdown({ from, to, attributedUserId: person, rollup: true })}
      monthOverMonth={categoryMonthOverMonth({ fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7), attributedUserId: person, limit: 10 })}
      split={personSpendSplit({ from, to })}
      debt={debtOverTime(24)}
      hasLoans={listLoans().some((loan) => loan.currentBalanceCents !== null)}
      // Same fixed trailing-24-month window as the Debt over time card above, deliberately
      // independent of the date-range picker at the top of the page (a net worth trend, like a
      // debt trend, is a "how did we get here" widget, not a "for this custom range" one).
      netWorth={netWorthOverTime(24, { today })}
      baselines={baselines}
      baselineMonthsUsed={baseline.months.length}
      merchants={topMerchants({ from, to, limit: 15, attributedUserId: person })}
      yoy={categoryYearOverYear({ month: yoyMonth, attributedUserId: person })}
      yoyMonth={yoyMonth}
      cashflow={cashflowTrend(cashflowMonths, { endMonth: monthOf(to), attributedUserId: person })}
      taxYears={taxYearOptions}
      taxYear={selectedTaxYear}
      taxRows={taxRows}
    />
  );
}
