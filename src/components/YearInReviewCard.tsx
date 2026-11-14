import Link from 'next/link';
import { ReportsIcon } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Money } from '@/components/ui/Money';
import { StatTile } from '@/components/ui/StatTile';
import { formatCents } from '@/lib/money';
import type { CashflowTotals, LargestPurchaseRow } from '@/lib/reports';
import { orderTaxRows, taxGrandTotal, type TaxYearDisplayRow } from '@/lib/tax-order';
import { transactionsHref } from '@/lib/transaction-links';

/**
 * v1.63.0 (plan 2026-11-12, B7). One year at a glance on Reports: money in, spent and net, the top
 * categories, the tax-relevant totals, the largest purchases, and the two year-end downloads.
 *
 * Props only. Every figure arrives built by reports/page.tsx over the viewer's own scope (a self
 * viewer's are their own rows: owner decision 1), and this component reaches no database: it is
 * rendered inside the Reports client component, so it imports only pure modules
 * (tests/ops/client-bundle.test.ts). The tax rows are ordered and totalled by src/lib/tax-order.ts,
 * the Tax year card's own functions, so the two cards cannot total the same rows differently.
 */
export interface YearInReviewData {
  year: number;
  /** The household's current year: the title says "so far" and every figure stops at `through`. */
  current: boolean;
  /** The window's last day, YYYY-MM-DD: December 31, or today for the current year. */
  through: string;
  /** cashflowForRange over January 1 to `through`. */
  totals: CashflowTotals;
  /** categoryBreakdown({ rollup: true }) over the same window, the top five with spending. */
  topCategories: { categoryId: number | null; categoryName: string; spentCents: number }[];
  /** largestPurchases over the same window. */
  largest: LargestPurchaseRow[];
  /** yearEndPackLine (src/lib/year-end.ts), and whether the pack is under its cap. */
  pack: { line: string; zipAvailable: boolean };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-ink">{children}</h3>;
}

export function YearInReviewCard({ data, taxRows, isAdmin }: { data: YearInReviewData; taxRows: TaxYearDisplayRow[]; isAdmin: boolean }) {
  const { year, totals } = data;
  const taxOrdered = orderTaxRows(taxRows);
  const taxTotalCents = taxGrandTotal(taxOrdered);

  return (
    <Card>
      <CardHeader
        title={`Year in review: ${year}${data.current ? ' so far' : ''}`}
        description={`${year}-01-01 to ${data.through}. Transfers are left out.`}
      />
      <CardBody className="flex flex-col gap-5">
        <div className="stat-grid gap-3">
          <StatTile
            label="Money in"
            value={formatCents(totals.incomeCents)}
            tone="positive"
            hint={totals.uncategorizedInCents > 0 ? `plus ${formatCents(totals.uncategorizedInCents)} not categorized yet` : undefined}
          />
          <StatTile label="Spent" value={formatCents(totals.spendCents)} />
          <StatTile
            label="Net"
            value={formatCents(totals.netCents, { showSign: true })}
            tone={totals.netCents < 0 ? 'negative' : 'positive'}
          />
        </div>

        <section className="flex flex-col gap-2" aria-label="Top categories">
          <SectionTitle>Top categories</SectionTitle>
          {data.topCategories.length === 0 ? (
            <p className="text-sm text-muted">No spending in {year} yet.</p>
          ) : (
            <ul className="border-t border-line text-sm">
              {data.topCategories.map((row) => (
                <li key={row.categoryId ?? 'uncategorized'} className="flex items-center justify-between gap-4 border-b border-line py-2">
                  <span>{row.categoryName}</span>
                  <Money cents={row.spentCents} plain />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Tax categories">
          <SectionTitle>Tax categories</SectionTitle>
          {taxRows.length === 0 ? (
            isAdmin ? (
              <EmptyState
                icon={ReportsIcon}
                size="compact"
                title="Nothing marked tax-relevant yet"
                action={
                  <Link href="/settings/managers" className={buttonClass('secondary', 'sm')}>
                    Mark categories as tax relevant
                  </Link>
                }
              >
                Mark categories as tax relevant in Settings and Managers to see them here.
              </EmptyState>
            ) : (
              <EmptyState
                icon={ReportsIcon}
                size="compact"
                title="Nothing marked tax-relevant yet"
                noAction="Marking categories as tax relevant happens in Settings and Managers, which only an admin can open."
              >
                Categories show here once an admin marks them as tax relevant in Settings.
              </EmptyState>
            )
          ) : (
            <ul className="border-t border-line text-sm">
              {taxOrdered.map(({ row, nested }) => (
                <li
                  key={row.categoryId}
                  className={`flex items-center justify-between gap-4 border-b border-line py-2 ${nested ? 'pl-5 text-muted' : ''}`}
                >
                  <span>{row.categoryName}</span>
                  <Money cents={row.totalCents} plain />
                </li>
              ))}
              <li className="flex items-center justify-between gap-4 py-2 font-semibold text-ink">
                <span>Total</span>
                <Money cents={taxTotalCents} plain />
              </li>
            </ul>
          )}
          {taxOrdered.some((entry) => entry.nested) ? (
            <p className="text-sm text-muted">
              An indented category&rsquo;s amount is already included in its parent above it, so the total counts it once.
            </p>
          ) : null}
        </section>

        <section className="flex flex-col gap-2" aria-label="Largest purchases">
          <SectionTitle>Largest purchases</SectionTitle>
          {data.largest.length === 0 ? (
            <p className="text-sm text-muted">No purchases in {year} yet.</p>
          ) : (
            <ul className="border-t border-line text-sm">
              {data.largest.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-4 border-b border-line py-2">
                  <span className="flex min-w-0 flex-col">
                    {/* One transaction: the id is the whole question (transactionsHref's own rule). */}
                    <Link
                      href={transactionsHref({ range: null, person: null }, { kind: 'transaction', transactionId: row.id })}
                      className="inline-flex min-h-11 items-center truncate text-accent-text hover:underline sm:min-h-0"
                    >
                      {row.description}
                    </Link>
                    <span className="text-xs text-muted">
                      {row.date} · {row.categoryName}
                    </span>
                  </span>
                  <Money cents={row.spentCents} plain />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2" aria-label="Year-end downloads">
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/api/reports/tax-detail?year=${year}`} className={buttonClass('secondary', 'sm')}>
              Download detail CSV
            </a>
            {data.pack.zipAvailable ? (
              <a href={`/api/reports/year-end?year=${year}`} className={buttonClass('secondary', 'sm')}>
                Download year-end pack (.zip)
              </a>
            ) : null}
          </div>
          <p className="text-sm text-muted">{data.pack.line}</p>
        </section>
      </CardBody>
    </Card>
  );
}
