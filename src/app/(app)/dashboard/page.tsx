import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { findUserById, listAttributablePeople } from '@/lib/auth/users';
import { safeToSpend, upcomingBills } from '@/lib/bills';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { listCategories } from '@/lib/categories';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { addMonths, currentMonth, isMonthKey, monthEnd, monthLabel, monthStart, todayIso } from '@/lib/dates';
import { listGoals } from '@/lib/goals';
import { householdInsights } from '@/lib/insights';
import { listLoans } from '@/lib/loans';
import { netWorthHint, netWorthOverTime } from '@/lib/networth';
import { onboardingSteps } from '@/lib/onboarding';
import { cashflowTrend, categoryBreakdown, topMerchants, type MonthTrendRow } from '@/lib/reports';
import { cashRunway, cashRunwayHint, type CashRunway } from '@/lib/runway';
import { savingsProgress, type SavingsProgress } from '@/lib/savings-target';
import { expiringSoonItems } from '@/lib/warranty/search';
import { formatCents } from '@/lib/money';
import { ComingUpCard } from '@/components/ComingUpCard';
import { GettingStartedCard } from '@/components/GettingStartedCard';
import { GoalCard } from '@/components/GoalCard';
import { LoansCard } from '@/components/LoansCard';
import { WhoOwesUsCard } from '@/components/WhoOwesUsCard';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import { QuickAddTransaction, QuickAddTrigger } from '@/components/QuickAddTransaction';
import { SavingsChart, type SavingsChartRow } from '@/components/charts/SavingsChart';
import { AlertIcon, ArrowRightIcon, InfoIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MonthNav } from '@/components/ui/MonthNav';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { PillNav } from '@/components/ui/PillNav';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatTile, type DeltaTone } from '@/components/ui/StatTile';
import { TableWrap } from '@/components/ui/Table';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';

/**
 * Item 1 (2026-08-30 plan): "+2.4% vs last month", derived from whatever prior-period figure
 * the tile already has a twin query for (see prevMonthCashflow/netWorthPrev below -- none of
 * this widens what the page COMPUTES for its headline values, only what it fetches
 * ALONGSIDE them to describe a trend). `prev === 0` returns null rather than a fabricated
 * percentage (a household with $0 spent last month dividing by zero is not "infinite percent
 * more", it is nothing to compare against) -- callers render no delta at all in that case, which
 * ruling calls out as strictly better than a wrong one.
 */
function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

/**
 * The one place sign and tone are reconciled (item 1's own warning: "getting that backwards is
 * worse than shipping no delta at all"). `goodWhenUp` names what kind of figure this is -- money
 * IN going up is good news (spending going up is bad news) -- rather than the tone ever being
 * guessed from the number's arithmetic sign alone.
 */
function deltaProps(curr: number, prev: number, goodWhenUp: boolean): { delta?: string; deltaTone?: DeltaTone } {
  const pct = deltaPct(curr, prev);
  if (pct === null) return {};
  const sign = pct > 0 ? '+' : '';
  const tone: DeltaTone = pct === 0 ? 'default' : (pct > 0) === goodWhenUp ? 'positive' : 'negative';
  return { delta: `${sign}${pct.toFixed(1)}% vs last month`, deltaTone: tone };
}

/**
 * v1.21.0 plan, item 5, defect 1. `cashflowTrend` seeds every month key in its requested range
 * with 0 by contract (src/lib/reports.ts) -- it has no way to tell "the household earned $0 and
 * spent $0 this month" apart from "this month is before the household's first transaction", so it
 * does not try; that is this function's job instead. Ten such months, on a household a few weeks
 * old, used to squeeze one real month of data into the last few percent of a 12-wide chart.
 *
 * Trims only the LEADING run of zero-both months, never an interior or trailing one: once real
 * history has started, a later genuinely-quiet month is indistinguishable from "no data" by this
 * same test, and only the former is the defect being fixed here -- a real zero month stays on the
 * chart. Every dropped row would have plotted a flat, informationless baseline bar anyway (income
 * 0, spend 0, so net 0 too), so the cumulative-saved running total SavingsChart derives from
 * whatever survives this trim is unaffected: a dropped row could only ever have contributed 0 to
 * it.
 *
 * Lives here rather than in src/lib/reports.ts: cashflowTrend's own contract (zero-fill every
 * requested month) is correct and shared by callers that need exactly that, e.g. Reports' own
 * cash flow card, which follows a range the person picking it already chose on purpose -- this
 * trim is specific to the dashboard's own fixed trailing-N-months-ending-today window, the one
 * place a household's youth actually produces a wall of leading zeros nobody asked to see.
 */
function trimLeadingEmptyMonths(rows: MonthTrendRow[]): MonthTrendRow[] {
  const firstReal = rows.findIndex((row) => row.incomeCents !== 0 || row.spendCents !== 0);
  return firstReal === -1 ? [] : rows.slice(firstReal);
}

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.person) ? params.person[0] : params.person;
  const urlScope = raw && /^\d+$/.test(raw) ? Number(raw) : null;

  /**
   * v1.13.0 ruling R2. For a self viewer the person scope is THEIR OWN id, whatever the URL says --
   * and the pills that would let them change it are not rendered at all. Everything below reads
   * `scopeUserId`, so there is one place this decision is made.
   */
  const selfScoped = isSelfScoped(viewer);
  const scopeUserId = ownerScope(viewer) ?? urlScope;

  // Ruling T7: the dashboard follows `?month=`, same fallback-on-malformed-input rule
  // budgets/page.tsx already uses -- a bad month string is a reason to show the current month,
  // never a reason to throw.
  const rawMonth = Array.isArray(params.month) ? params.month[0] : params.month;
  const month = rawMonth && isMonthKey(rawMonth) ? rawMonth : currentMonth();
  const isCurrentMonth = month === currentMonth();

  const rows = scopeUserId === null ? budgetProgress(month) : budgetProgress(month, 'personal', scopeUserId);
  const totals = budgetTotals(rows);
  // Ruling T7: the 12-month chart does NOT follow the chosen month -- it stays pinned to the
  // trailing 12 months ending TODAY regardless of which month is being drilled into, so a look
  // back at March does not also truncate the household's own trend line to end in March. The
  // person-pill scoping is unaffected; only which month is the rightmost bar is fixed.
  const trend = cashflowTrend(12, { endMonth: currentMonth(), attributedUserId: scopeUserId }, viewer);
  // Item 5 (2026-08-30 plan): drop the leading run of months before this scope's first
  // transaction -- see trimLeadingEmptyMonths' own docblock. `monthsOfHistory` (below) is exactly
  // how many of the requested 12 survive, and is what the card's own title and description read
  // instead of a hardcoded "12-month" claim that stopped being true the day this trim was added.
  const trimmedTrend = trimLeadingEmptyMonths(trend);
  const monthsOfHistory = trimmedTrend.length;
  // Item 1 (2026-08-30 plan): the dashboard's 12-month card now renders the same SavingsChart
  // Reports does, fed the same way -- each row's `targetCents` comes from savingsProgress()
  // (Lane 1, src/lib/savings-target.ts), never recomputed here (ruling T1: no second definition
  // of "saved"). Ruling T3: the target is household-scope only and does not vary by the person
  // pill, so it is resolved once per month regardless of `scopeUserId` -- but a self-scoped
  // viewer must still never receive it, the same gate `savings`/`runway` below already use for
  // every other household-wide figure on this page, so their rows carry `null` rather than a
  // call to savingsProgress at all.
  const savingsChartData: SavingsChartRow[] = trimmedTrend.map((row) => ({
    ...row,
    targetCents: selfScoped ? null : savingsProgress(row.month, viewer).targetCents,
  }));
  // Item 5: the title never claims a month count the trim above did not actually deliver. Only
  // the "12-month" case gets the special-cased noun (matching how every other count-bearing
  // string on this page already reads, e.g. "N accounts missing"), because "1-month cashflow"
  // reads as a typo of "12-month cashflow" where "This month's cashflow" does not.
  const cashflowCardTitle =
    monthsOfHistory === 0 ? 'Cashflow' : monthsOfHistory === 1 ? "This month's cashflow" : `${monthsOfHistory}-month cashflow`;
  const cashflowCardDescription = `Transfers excluded.${
    isCurrentMonth
      ? ''
      : ` Always the trailing ${monthsOfHistory === 1 ? 'month' : `${monthsOfHistory} months`} to today, not ${monthLabel(month)}.`
  }`;
  // The headline Money-in/Net tiles DO follow the chosen month (ruling T7), and unlike the chart
  // above they need to work for a month outside the chart's own trailing-12 window -- a
  // dedicated one-month query, not a lookup into `trend`, which cashflowTrend already supports
  // (Lane 1's own note: "every function the page calls already takes a month or a range").
  const monthCashflow = cashflowTrend(1, { endMonth: month, attributedUserId: scopeUserId }, viewer)[0] ?? null;
  // Item 1: the prior-period twin of `monthCashflow` above, purely to power each tile's "vs last
  // month" delta -- same function, same scoping, one month earlier than whatever is being VIEWED
  // (not calendar-"last month" when a past month is being drilled into).
  //
  // Item 4 (2026-08-30 plan): this used to also carry `prevRows`/`prevTotals`
  // (budgetProgress/budgetTotals for prevMonth), purely to power the old "Spent this month"
  // delta. That delta now compares spentCents/prevSpentCents (both cashflowTrend figures, below)
  // instead, so the budget-scoped prior-month query was dropped rather than left computing a
  // number nothing on this page reads any more.
  const prevMonth = addMonths(month, -1);
  const prevMonthCashflow = cashflowTrend(1, { endMonth: prevMonth, attributedUserId: scopeUserId }, viewer)[0] ?? null;
  const merchants = topMerchants(
    { from: monthStart(month), to: monthEnd(month), limit: 8, attributedUserId: scopeUserId },
    viewer,
  );
  const goals = listGoals({}, viewer);
  const reviewCount = reviewQueueCount();
  // v1.13.1 review A: a self viewer must never receive the household roster -- not shown, not
  // sent. Every other use of `people` below is already behind `selfScoped ? undefined : (...)`
  // except the QuickAddTransaction prop, which this gate now covers too.
  const people = selfScoped ? [] : listAttributablePeople();
  // Nothing can be imported until at least one account exists, and a fresh
  // install has none. Say so here rather than letting the Import page
  // dead-end. Asset accounts don't accept transactions (ruling: asset accounts refuse
  // transactions/import), so they don't count toward "can this household do anything yet".
  const accounts = listAccounts({}, viewer).filter((account) => acceptsTransactions(account.type));
  const hasAccounts = accounts.length > 0;

  // Task 6 (spec 2026-08-23, ruling A4): counted, not remembered. Every step's done-ness is
  // re-derived per render inside onboarding.ts, so this page holds no setup state of its own.
  // GettingStartedCard is deliberately role-blind, so the role rule lives here. Only an admin
  // can create an account, and every import has to land in one -- so for a member with no
  // accounts yet there is no step they can actually take, and the "ask an admin" banner below
  // is the honest thing to show instead of a card whose buttons would bounce them. Once
  // accounts exist, importing is something a member can do, so the card comes back minus the
  // step that was never theirs.
  const setupSteps =
    viewer.role === 'admin' || hasAccounts
      ? onboardingSteps().filter((step) => viewer.role === 'admin' || step.key !== 'account')
      : [];

  // MUST-10.6: the widget respects the dashboard's existing person switcher. Household
  // shows every item, a selected person shows only items they own.
  const today = todayIso();

  // Ruling T3: household scope only -- there is no per-person savings target, so this is null
  // for a self viewer, the same pairing net worth below already uses.
  const savings: SavingsProgress | null = selfScoped ? null : savingsProgress(month, viewer);
  // Cash runway takes `today`, not a month (Lane 1's own signature) -- it cannot follow the
  // chosen month even in principle, so it is always "as of today" and says so in its own hint
  // rather than needing the "as of today" note the loans/goals/etc. sections below carry.
  const runway: CashRunway | null = selfScoped ? null : cashRunway({ today }, viewer);

  const expiring = expiringSoonItems(EXPIRING_WIDGET_LIMIT, scopeUserId, today, viewer);
  // Review fix-round: one read-model scan, not two -- loansTotalOwedCents() would otherwise
  // call listLoans() again just to re-derive the sum LoansCard's own props already carry.
  const loans = listLoans(today, viewer);
  // v1.14.0 (spec BU): one scan, partitioned. LoansCard's "What we owe" is now
  // true rather than accidentally true, and the lent rows are a different question entirely.
  const owedLoans = loans.filter((loan) => loan.loanDirection === 'owed');
  const lentLoans = loans.filter((loan) => loan.loanDirection !== 'owed');
  const totalOwedCents = owedLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);
  const totalLentCents = lentLoans.reduce((sum, loan) => sum + (loan.currentBalanceCents ?? 0), 0);

  /**
   * Ruling R2: NO net worth for a self viewer. Net worth is the household's balance sheet --
   * accounts and loans have no per-person attribution the way a transaction does -- so there
   * is no honest scoped version of it to render. The query is not even run.
   *
   * Item 1: widened from 1 month to 2 -- purely to get last month's point for the tile's own
   * delta, the same one-more-point pattern prevMonthCashflow uses above. netWorthOverTime OMITS
   * (not zero-fills) a month before the household's first snapshot, so the array can still come
   * back with only one entry; `netWorthPrev` stays null in that case rather than assuming a
   * second element exists.
   */
  const netWorthPoints = selfScoped ? [] : netWorthOverTime(2, { today, viewer });
  const netWorthLatest = netWorthPoints.at(-1) ?? null;
  const netWorthPrev = netWorthPoints.length >= 2 ? netWorthPoints.at(-2)! : null;

  // Task 9: upcoming bills + safe-to-spend. Ruling M8: for a self viewer these read the
  // PERSONAL budget scope (see safeToSpend's own doc comment), so unlike net worth and loans
  // they are not simply hidden.
  // v1.12.0: the CARD wants overdue rows -- surfacing the thing you forgot is its whole job.
  // safeToSpend below deliberately does not; see upcomingBills' docblock.
  const bills = upcomingBills({ today, days: 30, includeOverdue: true, viewer });
  const spendPlan = safeToSpend({ month, today, viewer });
  const householdTotals = selfScoped ? totals : scopeUserId === null ? totals : budgetTotals(budgetProgress(month));

  // monthCashflow (above) is the SAME query cashflowTrend always was, just no longer read off
  // the 12-month `trend` -- ruling T7 pinned that one to today, so a viewed month outside its
  // trailing-12 window would otherwise silently zero out these two tiles.
  const incomeCents = monthCashflow?.incomeCents ?? 0;

  /**
   * Item 4 (2026-08-30 plan): "Spent this month" now counts EVERYTHING cashflowTrend counts --
   * every non-income, non-transfer row (uncategorized included), minus item 8a's loan-principal
   * exclusions -- the same source Money in/Net already read, so the three headline tiles
   * reconcile on their face: Money in - Spent = Net, always. Before this, the tile read
   * `totals.totalSpentCents` (budgetProgress, CATEGORIZED rows only), which could -- and on the
   * owner's own reported case, did -- disagree with Net by exactly the amount of uncategorized
   * spend. `totals.totalSpentCents` keeps its home in this tile's own hint and the progress bar
   * below it, where a budget-relative comparison belongs; it is not deleted, only demoted.
   */
  const spentCents = monthCashflow?.spendCents ?? 0;
  const prevSpentCents = prevMonthCashflow?.spendCents ?? 0;
  const netCents = monthCashflow?.netCents ?? incomeCents - spentCents;

  /**
   * Item 4: the gap between "everything spent" (spentCents, above) and "spend that has a
   * category" (totals.totalSpentCents) is uncategorized spend -- but it is read directly off
   * categoryBreakdown's own null-category bucket rather than diffed between those two numbers.
   * A diff would also include item 8a's loan-principal exclusions the moment a CATEGORIZED
   * transaction happens to be a loan link (assigning to a loan never touches category_id, so a
   * previously-categorized row can do exactly this) -- a real gap, but a different one, and
   * mislabelling it "not categorized yet" would send someone to the review queue to fix a row
   * that was never uncategorized in the first place.
   */
  const uncategorizedSpentCents =
    categoryBreakdown({ from: monthStart(month), to: monthEnd(month), attributedUserId: scopeUserId }, viewer).find(
      (row) => row.categoryId === null,
    )?.spentCents ?? 0;

  const budgetRows = rows.filter((row) => !row.isIncome && (row.limitCents !== null || row.spentCents !== 0));
  const scopedPerson = scopeUserId === null ? null : people.find((person) => person.id === scopeUserId);

  // Ruling R6. Self-hiding widget: absent whenever there is nothing to say.
  const insights = householdInsights({ today, viewer });

  // Task 10 (ruling R7): the same component and the same manualEntryAction as /transactions'
  // own quick-add, so hand entry does not drift between the two surfaces.
  const categories = listCategories({});
  const lastAccountId = findUserById(viewer.id)?.lastAccountId ?? null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Ruling U1 (2026-08-30 plan): no `eyebrow` here anymore -- the MonthNav pill below is
          now the one place the month is stated, and it is also the control that changes it.
          Restating it a second time above the greeting was the defect this lane fixes. */}
      <PageHeader
        title={`Hello, ${viewer.name}`}
        description={
          selfScoped
            ? 'Your month.'
            : scopedPerson
              ? `${scopedPerson.name}'s share of the month.`
              // "this month" dropped (ruling U1): the sentence is wrong the instant someone
              // navigates MonthNav to any other month, and nothing else here names which month
              // it means -- the nav right above already says that.
              : 'Everything the household spent and brought in.'
        }
        actions={
          // Item 5 (2026-08-30 plan, corrected): PageHeader's own actions slot is now a plain
          // row, so a page passing several stacked rows -- this one passes three: quick-add,
          // the month nav, and the person-scope pills -- composes its own column instead of
          // relying on the shared slot to do it. Keeps the pre-fix look (stacked, sharing the
          // right page gutter at `sm` and up) exactly as it was before that slot changed.
          <div className="flex w-full flex-col items-start gap-2 sm:items-end">
            {/* Item 6: "Add a transaction" now lives in this row (PageHeader's own item 5 fix
                is what makes that a row worth adding it to -- see PageHeader.tsx). Its own toggle
                state is the #quick-add hash, not React state, because the form it opens is a
                completely different part of the tree (see QuickAddTransaction.tsx's
                useQuickAddHash for why). */}
            <QuickAddTrigger />
            {/* Ruling T7: the dashboard follows `?month=`, same as Budgets -- see MonthNav's own
                docblock for why this needs no client-side router. `person=` is carried along
                only when it is actually a household viewer's own choice: a self viewer's own id
                is forced server-side regardless of the URL (ownerScope), so encoding it here
                would be a param nobody ever reads back. */}
            <MonthNav
              month={month}
              basePath="/dashboard"
              extraParams={!selfScoped && scopeUserId !== null ? { person: String(scopeUserId) } : {}}
            />
            {selfScoped ? null : (
              <PillNav
                groupLabel="Whose money to show"
                // Both options now carry `month=` too -- without it, switching WHO the page is
                // scoped to would silently reset WHICH month it shows, the same drift ruling T7
                // exists to prevent in the other direction.
                options={[
                  { key: 'household', href: `/dashboard?month=${month}`, label: 'Household', active: scopeUserId === null },
                  ...people.map((person) => ({
                    key: String(person.id),
                    href: `/dashboard?person=${person.id}&month=${month}`,
                    label: person.name,
                    active: scopeUserId === person.id,
                  })),
                ]}
              />
            )}
          </div>
        }
      />

      {/* Ruling T7: "A dashboard section either follows the chosen month or is visibly 'as of
          today'." This is the page-level half of that -- the per-section "as of today" notes
          below are the other half, on each section that does not follow `month`. */}
      {!isCurrentMonth ? (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg"
        >
          <InfoIcon className="h-4 w-4 shrink-0" />
          Viewing {monthLabel(month)}. Net worth, loans, goals, upcoming bills and everything below
          marked “as of today” still reflect today, not this month.
        </div>
      ) : null}

      <PageGuide>
        <p>
          This is {isCurrentMonth ? 'the current month' : monthLabel(month)} at a glance: what{' '}
          {selfScoped ? 'you' : 'the household'} spent, what came in, and how much of any limit you
          set is left. Every figure here is read back from imported statements, so nothing on this
          screen is edited in place.
        </p>
        {selfScoped ? (
          // Review fix-round: the household clause below (pills, Loans card, "stay
          // household-wide") describes controls and cards a self viewer never sees -- there are
          // no pills for them and no Loans card, so that copy would be describing someone
          // else's page (the BM/P11 defect class). This is the whole of what applies to them.
          <p>&quot;Owed to you&quot; lists money you have lent out and not yet been repaid.</p>
        ) : (
          <p>
            The pills beside the greeting scope the spending figures to one household member, or to
            everyone. Loans, net worth and upcoming bills stay household-wide whichever pill is
            chosen, because a balance owed is not attributed to a person the way a transaction is.
            A loan can point either way: &quot;What we owe&quot; is what the household still owes,
            and &quot;Who owes us&quot; is money the household has lent out and not been repaid.
          </p>
        )}
        <p>
          Cards on this page hide themselves when they have nothing to say. A short page means
          there is nothing on file for them yet, not that something failed.
        </p>
      </PageGuide>

      {/* Task 10 (ruling R7): the same position it holds on /transactions, so the two surfaces
          are one habit. v1.16.0 Lane C item 1 folded this behind a disclosure; item 6 (2026-08-30
          plan) went one step further and removed the card around it entirely -- the button that
          opens it now lives up in PageHeader's own actions row (QuickAddTrigger, just above),
          so this call renders nothing but the bare form itself, when open. */}
      <QuickAddTransaction
        variant="card"
        collapsible
        accounts={accounts}
        categories={categories}
        // v1.13.0 (item I2): `people` above is listAttributablePeople()'s full UserRecord —
        // username, totpEnabled and every other private field included. QuickAddTransaction's
        // own prop type is structurally just `{ id, name }[]`, so TypeScript let the extra
        // fields ride along into the RSC payload unnoticed. Trimmed to exactly what the client
        // component declares, the same way transactions/page.tsx already does for its own
        // `people` prop.
        people={people.map((p) => ({ id: p.id, name: p.name }))}
        today={today}
        defaultAccountId={lastAccountId}
      />

      {/* The admin half of this banner became GettingStartedCard's first step, which says the
          same thing with the reason attached, so keeping both put two prompts to the same page
          one above the other on a household's very first screen. What survives is the half the
          card cannot express: the card is role-blind, and only an admin can create an account,
          so pointing a member at a page that would bounce them straight back here helps
          nobody. */}
      {!hasAccounts && viewer.role !== 'admin' ? (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-md bg-info-soft px-3.5 py-3 text-sm text-info-soft-fg"
        >
          <InfoIcon className="h-4 w-4 shrink-0" />
          No bank accounts yet — ask an admin to add them to get started.
        </div>
      ) : null}

      {reviewCount > 0 ? (
        // Review round (fold /review in): the review queue is now `?review=1` on Transactions
        // rather than a second page (ruling R1) -- this callout is the dashboard's own link to
        // it, repointed the same way the nav item was.
        <CalloutLink href="/transactions?review=1" tone="warning">
          {reviewCount} transactions need review
        </CalloutLink>
      ) : null}

      {/* Task 6: self-hiding, same pattern as LoansCard below -- absent once every step is done,
          which is the whole of the dismiss story (ruling A9). First of the cards, and above the
          tiles rather than among them: during setup the tiles are all zeros, so the order of
          operations is the only thing on this page worth reading. */}
      <GettingStartedCard steps={setupSteps} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          className="sm:col-span-2"
          emphasis
          label="Spent this month"
          value={formatCents(spentCents)}
          hint={
            <>
              {totals.budgetedLimitCents > 0
                ? `${formatCents(totals.budgetedSpentCents)} of ${formatCents(totals.budgetedLimitCents)} budgeted`
                : 'No category limits set yet'}
              {/* Item 4: the tile now counts uncategorized spend in its headline, so it says so
                  here rather than leaving the gap between this figure and "budgeted" unexplained
                  -- and links straight to the queue that fixes it. */}
              {uncategorizedSpentCents > 0 ? (
                <>
                  <br />
                  <Link href="/transactions?review=1" className="underline hover:text-ink">
                    {formatCents(uncategorizedSpentCents)} not categorized yet
                  </Link>
                </>
              ) : null}
            </>
          }
          // Item 1: spending UP is bad news, so goodWhenUp is false here -- the one tile in this
          // grid where a positive arithmetic move is the negative-toned one. Item 4: the delta now
          // compares the SAME figure the tile displays (spentCents/prevSpentCents), not the
          // budget-relative totalSpentCents pair -- a "+12% vs last month" describing a different
          // number than the one shown above it would be its own version of this item's original
          // defect.
          {...deltaProps(spentCents, prevSpentCents, false)}
          footer={
            totals.budgetedLimitCents > 0 ? (
              <ProgressBar
                pct={Math.round((totals.budgetedSpentCents / totals.budgetedLimitCents) * 100)}
                label="Budgeted spend this month"
              />
            ) : null
          }
        />
        <StatTile
          label="Money in"
          value={formatCents(incomeCents)}
          tone="positive"
          hint="Transfers excluded"
          {...deltaProps(incomeCents, prevMonthCashflow?.incomeCents ?? 0, true)}
        />
        <StatTile
          label="Net this month"
          value={formatCents(netCents, { showSign: true })}
          tone={netCents < 0 ? 'negative' : 'positive'}
          hint={netCents < 0 ? 'Spending outran income' : 'Kept, after everything went out'}
          {...deltaProps(
            netCents,
            // Item 4: this fallback now matches netCents' OWN fallback above -- spentCents/
            // prevSpentCents (the "everything" cashflow figure), never the budget-relative
            // totalSpentCents pair. Both fallbacks are effectively unreachable in practice
            // (cashflowTrend(1, ...) always returns exactly one row), kept only so a delta
            // computed from a hypothetically-missing monthCashflow point could never describe a
            // different number than the tile itself would then be showing.
            prevMonthCashflow?.netCents ?? (prevMonthCashflow?.incomeCents ?? 0) - prevSpentCents,
            true,
          )}
        />
        {/* Task 7: self-hiding, in the manner of LoansCard -- rendered unconditionally, absent
            when there is no balance on file yet to compute it from. Adversarial-review fix
            (2026-08-23): the hint used to be this fixed string regardless of
            accountsMissing/accountsStale, so it kept claiming "every tracked account" on days
            the Reports Net worth card was disclosing the opposite for the same figure --
            netWorthHint is the one place that wording is decided now, so the two surfaces
            cannot disagree. Ruling R2: also absent whenever the viewer is self-scoped -- see
            netWorthLatest's own comment above.

            Item 7 (2026-08-30 plan): when accountsMissing > 0 this tile STOPS ASSERTING a sign --
            with accounts excluded, the sign is not established (they could easily be credit cards
            that flip it), so a green/red tone here would be a claim the data does not support.
            The figure itself is kept (it is still genuinely useful), marked "(partial)" beside
            the number, and the "vs last month" delta -- which would otherwise put its own
            good/bad tone on a comparison between two possibly-differently-partial figures -- is
            dropped rather than compounding the same claim a second way. netWorthHint's own
            wording (unchanged, still the single source of "N accounts...") already says what is
            missing; this only adds the route to fix it, the same "Update ... in Settings and
            Accounts" call to action the Reports net-worth card already offers for the identical
            figure. */}
        {netWorthLatest === null ? null : (
          <StatTile
            label="Net worth"
            value={
              <>
                {formatCents(netWorthLatest.netCents, { showSign: true })}
                {netWorthLatest.accountsMissing > 0 ? (
                  <span className="ml-1.5 align-middle text-xs font-normal text-muted">(partial)</span>
                ) : null}
              </>
            }
            tone={netWorthLatest.accountsMissing > 0 ? 'default' : netWorthLatest.netCents < 0 ? 'negative' : 'positive'}
            // Ruling T7: net worth does not follow the chosen month (it is always today's
            // balance sheet) -- netWorthHint's own sentence is unaffected, so the disclosure is
            // appended after it rather than replacing it.
            hint={
              <>
                {netWorthHint(netWorthLatest)}
                {netWorthLatest.accountsMissing > 0 ? (
                  <>
                    {' '}
                    <Link href="/settings/accounts" className="underline hover:text-ink">
                      Update in Settings and Accounts
                    </Link>
                  </>
                ) : null}
                {!isCurrentMonth ? ' · as of today' : ''}
              </>
            }
            // Item 1: only when there IS a prior point -- netWorthPrev is null (rather than 0)
            // when the household's own history does not reach back that far yet, and deltaProps
            // treats a genuine 0 prior balance differently (that still renders a delta) from "no
            // prior data" (which must not). Item 7: also suppressed once accountsMissing > 0 --
            // see this tile's own comment above.
            {...(netWorthPrev !== null && netWorthLatest.accountsMissing === 0
              ? deltaProps(netWorthLatest.netCents, netWorthPrev.netCents, true)
              : {})}
          />
        )}
        {/* Lane 3 item 4: ruling T3 makes both of these household-only, same gate as Net worth
            just above. Ruling T7: the savings tile follows the chosen month (savingsProgress was
            computed against it); cash runway cannot even in principle (Lane 1's own signature
            takes `today`, never a month), so it says "as of today" in its own hint instead of
            needing the page-level note the sections further down carry. */}
        {savings !== null ? <SavedThisMonthTile progress={savings} /> : null}
        {runway !== null ? <CashRunwayTile runway={runway} /> : null}
      </div>

      {/* Ruling R6 (item AJ / PROD-2): self-hiding, above ExpiringSoonCard -- it is the card
          that asks for attention, and the cards below it are reference. Ruling T7: insights are
          always "as of today" (householdInsights takes `today`, never `month`), so a note is
          added only while it actually has something to say and the viewed month differs. */}
      {!isCurrentMonth && insights.length > 0 ? <AsOfTodayNote month={month} /> : null}
      <NeedsALookCard rows={insights} />

      {!isCurrentMonth && expiring.length > 0 ? <AsOfTodayNote month={month} /> : null}
      <ExpiringSoonCard items={expiring} today={today} />

      {/* MUST-15.1: self-hiding. Rendered unconditionally; absent when there is nothing to say.
          Ruling R2: a loan balance is household money, so this is hidden entirely for a self
          viewer -- there is no honest per-person share of it to show instead. Ruling T7: loans
          are always "as of today" (listLoans takes `today`, never `month`). */}
      {selfScoped ? null : (
        <>
          {!isCurrentMonth && owedLoans.length > 0 ? <AsOfTodayNote month={month} /> : null}
          <LoansCard loans={owedLoans} totalOwedCents={totalOwedCents} />
        </>
      )}

      {/* v1.14.0: NOT behind selfScoped -- ruling R2 hides household balances from a child, and
          every row here is a row that child owns (listLoans has already scoped them). Ruling
          T7: same "as of today" reasoning as the Loans card above. */}
      {!isCurrentMonth && lentLoans.length > 0 ? <AsOfTodayNote month={month} /> : null}
      <WhoOwesUsCard loans={lentLoans} totalLentCents={totalLentCents} selfScoped={selfScoped} />

      {/* Task 9 / ruling T7: "Safe to spend is hidden entirely for a past month" -- this card's
          own footer sentence blends the (always-current) upcoming-bills list with month-scoped
          safeToSpend figures, and the two are not separable within the card (there is one footer
          sentence, not two). Hiding the whole card for any month other than the current one is
          the closest honest reading of "hidden entirely" -- "how much can we still spend" has no
          meaning for a month that is not the one in progress, in either direction. This lane's
          own conversion of ComingUpCard.tsx (item 3's days-remaining pill, its rows to ListRow)
          does not touch this gate: what the card computes and when it renders is unchanged, only
          how each row reads. */}
      {isCurrentMonth ? (
        <ComingUpCard
          bills={bills}
          budgetedRemainingCents={spendPlan.budgetedRemainingCents}
          billsDueCents={spendPlan.billsDueCents}
          hasBudgetedLimits={householdTotals.budgetedLimitCents > 0}
          monthEndDate={monthEnd(month)}
          canRecord={hasAccounts}
          today={today}
        />
      ) : null}

      <Card>
        <CardHeader
          title={`${monthLabel(month)} budgets`}
          description={
            totals.budgetedLimitCents > 0
              ? `${formatCents(totals.budgetedSpentCents)} of ${formatCents(totals.budgetedLimitCents)} budgeted · ${formatCents(totals.totalSpentCents)} spent in total`
              : `${formatCents(totals.totalSpentCents)} spent in total`
          }
          action={
            <Link href="/budgets" className="btn btn--ghost btn--sm text-accent-text hover:text-accent-text">
              Set limits
              <ArrowRightIcon className="h-4 w-4" />
            </Link>
          }
        />
        {budgetRows.length === 0 ? (
          <CardBody>
            {/* Item 2 (2026-08-30 plan): the shared EmptyState, `size="compact"` -- see that
                component's own docblock for why a card-scoped empty box drops the icon circle
                and bold title the page-level default carries. Guard 1
                (tests/ops/onboarding-coverage.test.ts) requires a real action on every
                EmptyState; the honest next step for "nothing spent yet" is the same one the
                sentence already names -- go import a statement. */}
            <EmptyState
              size="compact"
              title="Nothing spent yet this month. Import a statement and the categories will fill in here."
              action={
                <Link href="/import" className="btn btn--secondary btn--sm">
                  Import a statement
                </Link>
              }
            />
          </CardBody>
        ) : (
          <TableWrap bare className="border-t border-line" responsive>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="w-1/2">
                  Progress
                </th>
                <th scope="col" className="text-right">
                  Spent
                </th>
              </tr>
            </thead>
            <tbody>
              {budgetRows.map((row) => (
                <tr key={row.categoryId}>
                  {/* v1.15.0 (responsive rows): the category is what tells one row from another
                      on this widget, so it is the phone card's headline. */}
                  <td className="font-medium text-ink cell-stack-headline" data-label="Category">{row.categoryName}</td>
                  <td data-label="Progress">
                    {/* Ruling D1: the shared ProgressBar (Lane 0) rather than a second hand-rolled
                        bar. Item 4 (2026-08-30 plan): BudgetProgressBar.tsx is gone -- Budgets
                        moved to this same shared ProgressBar first (budgets-client.tsx), which
                        left it unused everywhere, and this page's own two bars (this one, the
                        StatTile footer above) were the last holdouts still worth naming here.
                        Its D5 threshold scale (< 80 calm, 80-100 warning, > 100 over) is the
                        default, so `tone` is left to auto-derive from `pct`. */}
                    {row.limitCents === null ? (
                      <span className="text-xs text-subtle">No budget</span>
                    ) : (
                      <ProgressBar
                        pct={
                          row.limitCents === 0
                            ? row.spentCents > 0
                              ? 100
                              : 0
                            : Math.round((row.spentCents / row.limitCents) * 100)
                        }
                        label={`${row.categoryName} budget used`}
                      />
                    )}
                  </td>
                  {/* Spent is the one money figure this widget carries, so it is the phone
                      card's amount slot. */}
                  <td className="money text-right whitespace-nowrap cell-stack-amount" data-label="Spent">
                    {formatCents(row.spentCents)}
                    {row.limitCents === null ? null : (
                      <span className="text-subtle"> / {formatCents(row.limitCents)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className={selfScoped ? 'lg:col-span-5' : 'lg:col-span-3'}>
          <CardHeader
            // Item 5 (2026-08-30 plan): no longer a hardcoded "12-month" -- see
            // trimLeadingEmptyMonths' docblock above for why a household with less than 12
            // months of its own history should never be told it is looking at 12.
            title={cashflowCardTitle}
            // Ruling T7: this chart does NOT follow the chosen month (see `trend` above) --
            // always the trailing N months ending today, so the note only needs to appear
            // once here rather than on every bar.
            description={cashflowCardDescription}
          />
          <CardBody>
            {savingsChartData.length === 0 ? (
              // Item 5: a chart with nothing plotted on it is not a chart, it is an empty
              // rectangle -- the same "go import a statement" action every other empty first-run
              // card on this page already offers (Guard 1: tests/ops/onboarding-coverage.test.ts).
              <EmptyState
                size="compact"
                title="No transactions yet to chart."
                action={
                  <Link href="/import" className="btn btn--secondary btn--sm">
                    Import a statement
                  </Link>
                }
              />
            ) : (
              <SavingsChart data={savingsChartData} />
            )}
          </CardBody>
        </Card>

        {/* Ruling R2: hidden entirely for a self viewer. */}
        {selfScoped ? null : (
          <Card className="lg:col-span-2">
            <CardHeader title="Top merchants" description={`Where the money went in ${monthLabel(month)}.`} />
            {merchants.length === 0 ? (
              <CardBody>
                {/* Guard 1: same reasoning as the Budgets card above -- nothing to show here
                    until a statement is imported, so that is the action. */}
                <EmptyState
                  size="compact"
                  title="No transactions this month yet."
                  action={
                    <Link href="/import" className="btn btn--secondary btn--sm">
                      Import a statement
                    </Link>
                  }
                />
              </CardBody>
            ) : (
              <ul className="border-t border-line text-sm">
                {merchants.map((merchant) => (
                  <li
                    key={merchant.normalizedMerchant}
                    className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-2.5 last:border-b-0 sm:px-6"
                  >
                    <span className="min-w-0 truncate text-ink">
                      {merchant.normalizedMerchant} <span className="text-subtle">({merchant.count})</span>
                    </span>
                    <span className="money shrink-0">{formatCents(merchant.spentCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      {goals.length > 0 ? (
        <section className="flex flex-col gap-3">
          {/* Item 2: this bare <h2> never had a shared header at all before this release --
              exactly SectionHeader's own reason to exist ("what CardHeader is for a single card,
              this is for a whole section of them"). GoalCard itself is Lane 1's file (goals-client
              .tsx converts it to a MetricCard wrapper), so item 4 ("Goals on the dashboard render
              the same MetricCard as the Goals page") falls out for free here -- this section
              already renders the SAME GoalCard the Goals page does; only this heading was ever
              this lane's own. */}
          <SectionHeader
            title="Goals"
            action={
              <Link href="/goals" className="btn btn--ghost btn--sm text-accent-text hover:text-accent-text">
                Add goal
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
            }
          />
          {/* Ruling T7: goals are always "as of today" (listGoals takes no month at all), so
              this note only earns its place when the page is actually showing a different one. */}
          {!isCurrentMonth ? (
            <p className="text-xs text-subtle">As of today, not {monthLabel(month)}.</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** A banner that is also the way to act on what it says. */
function CalloutLink({
  href,
  tone,
  children,
}: {
  href: string;
  tone: 'info' | 'warning';
  children: React.ReactNode;
}) {
  const wrap =
    tone === 'warning' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-info-soft text-info-soft-fg';
  const Icon = tone === 'warning' ? AlertIcon : InfoIcon;
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-md px-3.5 py-3 text-sm font-medium transition-opacity hover:opacity-90 ${wrap}`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {children}
      <ArrowRightIcon className="ml-auto h-4 w-4 shrink-0" />
    </Link>
  );
}

/**
 * Ruling T7's per-section half: a section that reads from `today` rather than the page's own
 * `month` still needs to say so once the two have diverged, or a household drilling into March
 * would have no way to tell that the loan balance sitting beside it is today's, not March's.
 * Every call site already gates this on the SAME emptiness check that decides whether the
 * section below it renders at all, so this never appears with nothing under it to explain.
 */
function AsOfTodayNote({ month }: { month: string }) {
  return <p className="text-xs text-subtle">As of today, not {monthLabel(month)}.</p>;
}

/**
 * Lane 3 item 4. Ruling T1a: the sub-line below the hint is disclosure, never addition -- "of
 * it" ties `movedToSavingsCents` back to the figure already shown above, so this can never be
 * misread as "moving money to savings increases what we saved" (ruling T1's own wording test).
 *
 * Item 4 (2026-08-30 plan): the bar below is deliberately NOT the shared ProgressBar
 * (ui/ProgressBar.tsx, formerly also BudgetProgressBar.tsx before that component was retired as
 * dead code) -- that component's default scale reads "over 100%" as a red warning, which is
 * exactly backwards for a savings target: exceeding it is the good outcome, not the over-budget
 * one. ProgressBar's `tone` prop can be overridden explicitly for exactly this kind of case, but
 * this tile's tone is a binary on whether the target was met (`netCents >= targetCents`), not a
 * percentage band, so it keeps its own small bar rather than fighting ProgressBar's pct-shaped
 * tone derivation for a comparison ProgressBar was never built to express.
 */
function SavedThisMonthTile({ progress }: { progress: SavingsProgress }) {
  const { netCents, target, targetCents, pct, movedToSavingsCents, noSavingsAccount } = progress;

  const hint = (() => {
    if (target === null) return 'No savings target set for this month yet — set one on Budgets.';
    if (targetCents === null) {
      // Ruling T5: a percent target with no income recorded yet has nothing to resolve
      // against -- targetCents is null here rather than a divide-by-zero.
      return `${target.value}% target — no income recorded yet this month.`;
    }
    return `${formatCents(netCents)} of ${formatCents(targetCents)} target${pct === null ? '' : ` (${pct}%)`}`;
  })();

  const clampedPct = Math.max(0, Math.min(100, pct ?? 0));

  return (
    <StatTile
      label="Saved this month"
      value={formatCents(netCents, { showSign: true })}
      tone={netCents < 0 ? 'negative' : 'positive'}
      hint={
        <>
          {hint}
          <br />
          {noSavingsAccount ? (
            // Ruling T1 case 3: exactly the setup where an unflagged transfer to an outside
            // bank silently understates the month -- this is the one place that trap gets
            // surfaced, rather than the figure above just quietly reading low.
            <>
              No savings-type account is set up. Money moved to a bank this app doesn&apos;t track
              counts as spending unless the transaction is marked a transfer.
            </>
          ) : (
            <>· {formatCents(movedToSavingsCents)} of it moved to savings</>
          )}
        </>
      }
      footer={
        targetCents !== null && targetCents > 0 ? (
          <div
            role="progressbar"
            aria-label="Savings target progress"
            aria-valuenow={clampedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div
              style={{ width: `${clampedPct}%` }}
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                netCents >= targetCents ? 'bg-positive-solid' : 'bg-warning-solid'
              }`}
            />
          </div>
        ) : null
      }
    />
  );
}

/** Lane 3 item 4. `months` is null exactly when there is no spend history to average against
 *  (Lane 1's own contract) -- shown as a dash rather than a nonsense "0.0 months".
 *
 *  v1.21.0 plan, item 14: the sentence explaining WHY is now `cashRunwayHint`
 *  (src/lib/runway.ts) rather than a ternary re-litigated here -- see that function's own
 *  docblock for why "no spending history yet to average" was false on a page full of spending,
 *  and what replaced it. */
function CashRunwayTile({ runway }: { runway: CashRunway }) {
  return (
    <StatTile
      label="Cash runway"
      value={runway.months === null ? '—' : `${runway.months.toFixed(1)} months covered`}
      hint={
        <>
          {/* cashRunway takes `today`, never a month (Lane 1's own signature) -- this is always
              "as of today" regardless of which month the rest of the page is showing, so it
              says so in its own hint rather than needing AsOfTodayNote beside it. */}
          As of today · {cashRunwayHint(runway)}
          {runway.accountsMissing > 0 ? (
            <>
              <br />
              {runway.accountsMissing} account{runway.accountsMissing === 1 ? '' : 's'} missing a
              balance — this figure is incomplete.
            </>
          ) : null}
        </>
      }
    />
  );
}
