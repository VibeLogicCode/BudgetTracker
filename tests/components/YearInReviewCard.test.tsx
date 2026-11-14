// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { YearInReviewCard, type YearInReviewData } from '@/components/YearInReviewCard';
import { UNATTRIBUTED_LABEL } from '@/lib/reports';
import type { TaxYearDisplayRow } from '@/lib/tax-order';

/**
 * v1.63.0 (plan 2026-11-12, B7). The Year in review card, from props alone. The figures the page
 * builds for an admin and for a self viewer are checked against the real page in
 * tests/app/reports.test.tsx.
 */

afterEach(cleanup);

function data(over: Partial<YearInReviewData> = {}): YearInReviewData {
  return {
    year: 2026,
    current: false,
    through: '2026-12-31',
    totals: { incomeCents: 250000, uncategorizedInCents: 0, spendCents: 33217, netCents: 216783 },
    topCategories: [
      { categoryId: 1, categoryName: 'Medical', spentCents: 15217 },
      { categoryId: 4, categoryName: 'Groceries', spentCents: 8000 },
    ],
    largest: [
      { id: 41, date: '2026-04-14', description: 'CITY CLINIC', categoryName: 'Medical', spentCents: 12000 },
      { id: 42, date: '2026-06-01', description: 'COMMUNITY FUND', categoryName: 'Split', spentCents: 10000 },
    ],
    pack: { line: 'Includes 2 receipts, 41 bytes.', zipAvailable: true },
    ...over,
  };
}

const TAX_ROWS: TaxYearDisplayRow[] = [
  {
    categoryId: 1,
    categoryName: 'Medical',
    parentId: null,
    totalCents: 15217,
    byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 0 }],
  },
  {
    categoryId: 3,
    categoryName: 'Charity',
    parentId: null,
    totalCents: 6000,
    byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 0 }],
  },
];

function section(container: HTMLElement, label: string) {
  const found = container.querySelector(`section[aria-label="${label}"]`);
  if (!found) throw new Error(`no ${label} section`);
  return within(found as HTMLElement);
}

describe('YearInReviewCard', () => {
  it('a past year: its title, the three tiles, the top categories and the tax totals', () => {
    const { container, getByRole } = render(<YearInReviewCard data={data()} taxRows={TAX_ROWS} isAdmin />);
    expect(getByRole('heading', { level: 2 }).textContent).toBe('Year in review: 2026');
    expect(container.textContent).toContain('2026-01-01 to 2026-12-31.');
    const tiles = [...container.querySelectorAll('.stat-grid > div')].map((tile) => tile.textContent);
    expect(tiles).toEqual(['Money in$2,500.00', 'Spent$332.17', 'Net+$2,167.83']);
    expect(section(container, 'Top categories').getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Medical$152.17',
      'Groceries$80.00',
    ]);
    expect(section(container, 'Tax categories').getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Medical$152.17',
      'Charity$60.00',
      'Total$212.17',
    ]);
  });

  it('the current year reads so far and names the day it stops', () => {
    const { getByRole, container } = render(
      <YearInReviewCard data={data({ current: true, through: '2026-11-13' })} taxRows={TAX_ROWS} isAdmin />,
    );
    expect(getByRole('heading', { level: 2 }).textContent).toBe('Year in review: 2026 so far');
    expect(container.textContent).toContain('2026-01-01 to 2026-11-13.');
  });

  it('a flagged child under its flagged parent is counted once in the total, as on the Tax year card', () => {
    const rows: TaxYearDisplayRow[] = [
      { ...TAX_ROWS[0] },
      { categoryId: 2, categoryName: 'Pharmacy', parentId: 1, totalCents: 3217, byUser: [] },
    ];
    const { container } = render(<YearInReviewCard data={data()} taxRows={rows} isAdmin />);
    expect(section(container, 'Tax categories').getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Medical$152.17',
      'Pharmacy$32.17',
      'Total$152.17',
    ]);
    expect(container.textContent).toContain('already included in its parent above it');
  });

  it('each largest purchase links to its own transaction', () => {
    const { container } = render(<YearInReviewCard data={data()} taxRows={TAX_ROWS} isAdmin />);
    const links = section(container, 'Largest purchases').getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['CITY CLINIC', '/transactions?id=41'],
      ['COMMUNITY FUND', '/transactions?id=42'],
    ]);
    expect(container.textContent).toContain('2026-06-01 · Split');
  });

  it('offers both downloads, with the pack line under them', () => {
    const { container } = render(<YearInReviewCard data={data()} taxRows={TAX_ROWS} isAdmin />);
    const downloads = section(container, 'Year-end downloads');
    expect(downloads.getByRole('link', { name: 'Download detail CSV' }).getAttribute('href')).toBe('/api/reports/tax-detail?year=2026');
    expect(downloads.getByRole('link', { name: 'Download year-end pack (.zip)' }).getAttribute('href')).toBe('/api/reports/year-end?year=2026');
    expect(downloads.getByText('Includes 2 receipts, 41 bytes.')).toBeTruthy();
  });

  it('over the cap: no zip link, and the line says why', () => {
    const line =
      "This year's receipts come to 2.4 GB, more than the 2 GB one pack can carry. Download the detail CSV, and the receipts from each item.";
    const { container } = render(<YearInReviewCard data={data({ pack: { line, zipAvailable: false } })} taxRows={TAX_ROWS} isAdmin />);
    const downloads = section(container, 'Year-end downloads');
    expect(downloads.queryByRole('link', { name: 'Download year-end pack (.zip)' })).toBeNull();
    expect(container.querySelector('a[href^="/api/reports/year-end"]')).toBeNull();
    expect(downloads.getByRole('link', { name: 'Download detail CSV' })).toBeTruthy();
    expect(downloads.getByText(line)).toBeTruthy();
  });

  it('nothing flagged: the admin is offered the setting, anyone else is told who sets it', () => {
    const admin = render(<YearInReviewCard data={data()} taxRows={[]} isAdmin />);
    const adminTax = section(admin.container, 'Tax categories');
    expect(adminTax.getByText('Nothing marked tax-relevant yet')).toBeTruthy();
    expect(adminTax.getByRole('link', { name: 'Mark categories as tax relevant' }).getAttribute('href')).toBe('/settings/managers');
    cleanup();

    const member = render(<YearInReviewCard data={data()} taxRows={[]} isAdmin={false} />);
    const memberTax = section(member.container, 'Tax categories');
    expect(memberTax.queryByRole('link')).toBeNull();
    expect(memberTax.getByText('Categories show here once an admin marks them as tax relevant in Settings.')).toBeTruthy();
  });

  it('names uncategorized money in on the Money in tile, and says when there is nothing yet', () => {
    const { container } = render(
      <YearInReviewCard
        data={data({
          totals: { incomeCents: 0, uncategorizedInCents: 5000, spendCents: 0, netCents: 5000 },
          topCategories: [],
          largest: [],
        })}
        taxRows={TAX_ROWS}
        isAdmin
      />,
    );
    expect(container.textContent).toContain('plus $50.00 not categorized yet');
    expect(container.textContent).toContain('No spending in 2026 yet.');
    expect(container.textContent).toContain('No purchases in 2026 yet.');
  });
});
