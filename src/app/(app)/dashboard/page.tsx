import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { acceptsTransactions, listAccounts } from '@/lib/accounts';
import { isSelfScoped, ownerScope } from '@/lib/auth/viewer';
import { findUserById, listAttributablePeople } from '@/lib/auth/users';
import { safeToSpend, upcomingBills } from '@/lib/bills';
import { budgetProgress, budgetTotals } from '@/lib/budgets';
import { listCategories } from '@/lib/categories';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { currentMonth, monthEnd, monthLabel, monthStart, todayIso } from '@/lib/dates';
import { listGoals } from '@/lib/goals';
import { householdInsights } from '@/lib/insights';
import { listLoans } from '@/lib/loans';
import { netWorthHint, netWorthOverTime } from '@/lib/networth';
import { onboardingSteps } from '@/lib/onboarding';
import { cashflowTrend, topMerchants } from '@/lib/reports';
import { expiringSoonItems } from '@/lib/warranty/search';
import { formatCents } from '@/lib/money';
import { BudgetProgressBar } from '@/components/BudgetProgressBar';
import { ComingUpCard } from '@/components/ComingUpCard';
import { GettingStartedCard } from '@/components/GettingStartedCard';
import { GoalCard } from '@/components/GoalCard';
import { LoansCard } from '@/components/LoansCard';
import { WhoOwesUsCard } from '@/components/WhoOwesUsCard';
import { NeedsALookCard } from '@/components/NeedsALookCard';
import { QuickAddTransaction } from '@/components/QuickAddTransaction';
import { CashflowChart } from '@/components/charts/CashflowChart';
import { AlertIcon, ArrowRightIcon, InfoIcon } from '@/components/icons';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageGuide } from '@/components/ui/PageGuide';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatTile } from '@/components/ui/StatTile';
import { TableWrap } from '@/components/ui/Table';
import { ExpiringSoonCard, EXPIRING_WIDGET_LIMIT } from '@/components/warranty/ExpiringSoonCard';

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

  const month = currentMonth();
  const rows = scopeUserId === null ? budgetProgress(month) : budgetProgress(month, 'personal', scopeUserId);
  const totals = budgetTotals(rows);
  const trend = cashflowTrend(12, { endMonth: month, attributedUserId: scopeUserId }, viewer);
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
   */
  const netWorthLatest = selfScoped ? null : netWorthOverTime(1, { today, viewer }).at(0) ?? null;

  // Task 9: upcoming bills + safe-to-spend. Ruling M8: for a self viewer these read the
  // PERSONAL budget scope (see safeToSpend's own doc comment), so unlike net worth and loans
  // they are not simply hidden.
  // v1.12.0: the CARD wants overdue rows -- surfacing the thing you forgot is its whole job.
  // safeToSpend below deliberately does not; see upcomingBills' docblock.
  const bills = upcomingBills({ today, days: 30, includeOverdue: true, viewer });
  const spendPlan = safeToSpend({ month, today, viewer });
  const householdTotals = selfScoped ? totals : scopeUserId === null ? totals : budgetTotals(budgetProgress(month));

  // The trend already covers this month, so the headline income/net figures come
  // out of it rather than costing a second query.
  const thisMonth = trend.find((row) => row.month === month);
  const incomeCents = thisMonth?.incomeCents ?? 0;
  const netCents = thisMonth?.netCents ?? incomeCents - totals.totalSpentCents;

  const budgetRows = rows.filter((row) => !row.isIncome && (row.limitCents !== null || row.spentCents !== 0));
  const scopedPerson = scopeUserId === null ? null : people.find((person) => person.id === scopeUserId);

  // Ruling R6. Self-hiding widget: absent whenever there is nothing to say.
  const insights = householdInsights({ today, viewer });

  // Task 10 (ruling R7): the same component and the same manualEntryAction as /transactions'
  // own quick-add, so hand entry does not drift between the two surfaces.
  const categories = listCategories({});
  const lastAccountId = findUserById(viewer.id)?.lastAccountId ?? null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={monthLabel(month)}
        title={`Hello, ${viewer.name}`}
        description={
          selfScoped
            ? 'Your month.'
            : scopedPerson
              ? `${scopedPerson.name}'s share of the month.`
              : 'Everything the household spent and brought in this month.'
        }
        actions={
          selfScoped ? undefined : (
            <nav aria-label="Whose money to show" className="flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface-2 p-1">
              <PersonPill href="/dashboard" label="Household" active={scopeUserId === null} />
              {people.map((person) => (
                <PersonPill
                  key={person.id}
                  href={`/dashboard?person=${person.id}`}
                  label={person.name}
                  active={scopeUserId === person.id}
                />
              ))}
            </nav>
          )
        }
      />

      <PageGuide>
        <p>
          This is the current month at a glance: what {selfScoped ? 'you' : 'the household'} spent,
          what came in, and how much of any limit you set is left. Every figure here is read back
          from imported statements, so nothing on this screen is edited in place.
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
          are one habit. */}
      <QuickAddTransaction
        variant="card"
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
          value={formatCents(totals.totalSpentCents)}
          hint={
            totals.budgetedLimitCents > 0
              ? `${formatCents(totals.budgetedSpentCents)} of ${formatCents(totals.budgetedLimitCents)} budgeted`
              : 'No category limits set yet'
          }
          footer={
            totals.budgetedLimitCents > 0 ? (
              <BudgetProgressBar
                limitCents={totals.budgetedLimitCents}
                spentCents={totals.budgetedSpentCents}
                label="Budgeted spend this month"
              />
            ) : null
          }
        />
        <StatTile label="Money in" value={formatCents(incomeCents)} tone="positive" hint="Transfers excluded" />
        <StatTile
          label="Net this month"
          value={formatCents(netCents, { showSign: true })}
          tone={netCents < 0 ? 'negative' : 'positive'}
          hint={netCents < 0 ? 'Spending outran income' : 'Kept, after everything went out'}
        />
        {/* Task 7: self-hiding, in the manner of LoansCard -- rendered unconditionally, absent
            when there is no balance on file yet to compute it from. Adversarial-review fix
            (2026-08-23): the hint used to be this fixed string regardless of
            accountsMissing/accountsStale, so it kept claiming "every tracked account" on days
            the Reports Net worth card was disclosing the opposite for the same figure --
            netWorthHint is the one place that wording is decided now, so the two surfaces
            cannot disagree. Ruling R2: also absent whenever the viewer is self-scoped -- see
            netWorthLatest's own comment above. */}
        {netWorthLatest === null ? null : (
          <StatTile
            label="Net worth"
            value={formatCents(netWorthLatest.netCents, { showSign: true })}
            tone={netWorthLatest.netCents < 0 ? 'negative' : 'positive'}
            hint={netWorthHint(netWorthLatest)}
          />
        )}
      </div>

      {/* Ruling R6 (item AJ / PROD-2): self-hiding, above ExpiringSoonCard -- it is the card
          that asks for attention, and the cards below it are reference. */}
      <NeedsALookCard rows={insights} />

      <ExpiringSoonCard items={expiring} today={today} />

      {/* MUST-15.1: self-hiding. Rendered unconditionally; absent when there is nothing to say.
          Ruling R2: a loan balance is household money, so this is hidden entirely for a self
          viewer -- there is no honest per-person share of it to show instead. */}
      {selfScoped ? null : <LoansCard loans={owedLoans} totalOwedCents={totalOwedCents} />}

      {/* v1.14.0: NOT behind selfScoped -- ruling R2 hides household balances from a child, and
          every row here is a row that child owns (listLoans has already scoped them). */}
      <WhoOwesUsCard loans={lentLoans} totalLentCents={totalLentCents} selfScoped={selfScoped} />

      {/* Task 9: self-hiding, same pattern as LoansCard -- absent when there are no bills
          coming up AND no budgeted limits at all this month. */}
      <ComingUpCard
        bills={bills}
        budgetedRemainingCents={spendPlan.budgetedRemainingCents}
        billsDueCents={spendPlan.billsDueCents}
        hasBudgetedLimits={householdTotals.budgetedLimitCents > 0}
        monthEndDate={monthEnd(month)}
        canRecord={hasAccounts}
        today={today}
      />

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
            <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
              Nothing spent yet this month. Import a statement and the categories will fill in here.
            </p>
          </CardBody>
        ) : (
          <TableWrap bare className="border-t border-line">
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
                  <td className="font-medium text-ink">{row.categoryName}</td>
                  <td>
                    <BudgetProgressBar limitCents={row.limitCents} spentCents={row.spentCents} label={row.categoryName} />
                  </td>
                  <td className="money text-right whitespace-nowrap">
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
          <CardHeader title="12-month cashflow" description="Transfers excluded." />
          <CardBody>
            <CashflowChart data={trend} />
          </CardBody>
        </Card>

        {/* Ruling R2: hidden entirely for a self viewer. */}
        {selfScoped ? null : (
          <Card className="lg:col-span-2">
            <CardHeader title="Top merchants" description={`Where the money went in ${monthLabel(month)}.`} />
            {merchants.length === 0 ? (
              <CardBody>
                <p className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
                  No transactions this month yet.
                </p>
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
          <h2 className="text-base font-semibold text-ink">Goals</h2>
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

function PersonPill({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`rounded-full px-3 py-1 text-sm transition-colors ${
        active ? 'bg-surface font-semibold text-ink shadow-flat' : 'font-medium text-muted hover:text-ink'
      }`}
    >
      {label}
    </Link>
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
