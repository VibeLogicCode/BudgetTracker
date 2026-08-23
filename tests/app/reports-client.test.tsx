// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { ReportsClient, type TaxYearDisplayRow } from '@/app/(app)/reports/reports-client';
import { UNATTRIBUTED_LABEL } from '@/lib/reports';
import type { ResolvedRange } from '@/lib/date-range';

/**
 * Task 15b (spec 2026-08-22, v1.7.0): the Reports page's "Tax year" card. No reports page/client
 * test file existed before this task (Tasks 12-14 relied on their lib-level tests only), so this
 * is a new file rather than an extension of one.
 *
 * Every query below that touches the card's own content is scoped with within(taxCard(...))
 * rather than the top-level render result -- the person filter's static
 * <option>Household/unattributed</option> carries the exact same text as UNATTRIBUTED_LABEL,
 * and is present on every render regardless of the fixtures below, so an unscoped getByText
 * would be ambiguous.
 */

afterEach(() => cleanup());

const RANGE: ResolvedRange = { preset: 'last_6_months', from: '2026-01-01', to: '2026-06-30', label: 'Last 6 months' };

function baseProps(overrides: { taxYears?: number[]; taxYear?: number | null; taxRows?: TaxYearDisplayRow[] } = {}) {
  return {
    range: RANGE,
    today: '2026-06-30',
    person: '',
    people: [],
    breakdown: [],
    monthOverMonth: { months: [], rows: [] },
    split: [],
    debt: [],
    hasLoans: false,
    netWorth: [],
    baselines: [],
    baselineMonthsUsed: 0,
    merchants: [],
    yoy: [],
    yoyMonth: '2026-06',
    cashflow: [],
    taxYears: overrides.taxYears ?? [],
    taxYear: overrides.taxYear ?? null,
    taxRows: overrides.taxRows ?? [],
  };
}

function taxRow(over: Partial<TaxYearDisplayRow> & { categoryId: number; categoryName: string }): TaxYearDisplayRow {
  return {
    parentId: null,
    totalCents: 0,
    byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 0 }],
    ...over,
  };
}

/** The Tax year card's own <section>, found via its CardHeader <h2> (the top filter form has a
 *  same-named Field label, but that is a <span>, never an <h2>, so this is unambiguous). */
function taxCard(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === 'Tax year');
  if (!heading) throw new Error('Tax year card heading not found');
  const card = heading.closest('section');
  if (!card) throw new Error('Tax year card section not found');
  return card as HTMLElement;
}

describe('ReportsClient — Tax year card', () => {
  it('shows the empty state when nothing is flagged tax-relevant', () => {
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026, 2025], taxYear: 2026, taxRows: [] })} />);
    const card = within(taxCard(container));
    expect(card.getByText('Nothing marked tax-relevant yet')).toBeTruthy();
    expect(card.getByText('Mark categories as tax relevant in Settings and Managers to see them here.')).toBeTruthy();
  });

  it('lists the years taxYears() returns, newest first, in the year select, defaulting to the newest', () => {
    const rows = [
      taxRow({ categoryId: 1, categoryName: 'Groceries', totalCents: 4000, byUser: [{ userId: 1, label: 'Alice', cents: 4000 }] }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026, 2025, 2024], taxYear: 2026, taxRows: rows })} />);
    const select = container.querySelector('select[name="taxYear"]') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['2026', '2025', '2024']);
    expect(select.value).toBe('2026');
  });

  it('does not render a year select when there is no data at all', () => {
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [], taxYear: null, taxRows: [] })} />);
    expect(container.querySelector('select[name="taxYear"]')).toBeNull();
  });

  it('renders a Category/Person/Amount row for each person in the selected year, plus the total', () => {
    const rows = [
      taxRow({
        categoryId: 1,
        categoryName: 'Groceries',
        totalCents: 5000,
        byUser: [
          { userId: 1, label: 'Alice', cents: 4000 },
          { userId: null, label: UNATTRIBUTED_LABEL, cents: 1000 },
        ],
      }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
    const card = within(taxCard(container));

    expect(card.getAllByText('Groceries')).toHaveLength(2); // one row per person
    expect(card.getByText('Alice')).toBeTruthy();
    expect(card.getByText(UNATTRIBUTED_LABEL)).toBeTruthy();
    expect(card.getByText('$40.00')).toBeTruthy();
    expect(card.getByText('$10.00')).toBeTruthy();
    expect(card.getByText('Total')).toBeTruthy();
    expect(card.getByText('$50.00')).toBeTruthy(); // grand total; nothing overlaps in this fixture
  });

  it('offers Download CSV for the selected year, linking to the tax-export route', () => {
    const rows = [
      taxRow({ categoryId: 1, categoryName: 'Groceries', totalCents: 4000, byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 4000 }] }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
    const link = within(taxCard(container)).getByText('Download CSV') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/reports/tax-export?year=2026');
  });

  it('does not offer Download CSV when there is no year to download', () => {
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [], taxYear: null, taxRows: [] })} />);
    expect(within(taxCard(container)).queryByText('Download CSV')).toBeNull();
  });

  describe('parent/child overlap disclosure', () => {
    it('indents a flagged child under its flagged parent, notes the overlap, and excludes the child from the total', () => {
      const rows = [
        taxRow({ categoryId: 1, categoryName: 'Food', parentId: null, totalCents: 8000, byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 8000 }] }),
        taxRow({ categoryId: 2, categoryName: 'Groceries', parentId: 1, totalCents: 5000, byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 5000 }] }),
      ];
      const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
      const card = taxCard(container);
      const scoped = within(card);

      expect(scoped.getByText('Food')).toBeTruthy();
      expect(scoped.getByText('Groceries')).toBeTruthy();
      expect(
        scoped.getByText(
          "An indented category's amount is already included in its parent's total above it, so adding both would count it twice.",
        ),
      ).toBeTruthy();

      const rowsInDom = Array.from(card.querySelectorAll('tbody tr'));
      const parentRow = rowsInDom.find((tr) => tr.textContent?.includes('Food'));
      const childRow = rowsInDom.find((tr) => tr.textContent?.includes('Groceries'));
      const totalRow = rowsInDom.find((tr) => tr.textContent?.startsWith('Total'));
      const parentCell = parentRow?.querySelector('td') as HTMLElement;
      const childCell = childRow?.querySelector('td') as HTMLElement;

      // The child is visually indented relative to its parent.
      expect(childCell.style.paddingLeft).not.toBe(parentCell.style.paddingLeft);

      expect(parentRow?.textContent).toContain('$80.00');
      expect(childRow?.textContent).toContain('$50.00');
      // The total is Food's rollup alone ($80), never Food + Groceries ($130) -- that $130
      // would be the overlap counted twice.
      expect(totalRow?.textContent).toContain('$80.00');
      expect(card.textContent).not.toContain('$130.00');
    });

    it('does not indent or add the note when only the parent is flagged (the child has no row of its own)', () => {
      const rows = [
        taxRow({ categoryId: 1, categoryName: 'Food', parentId: null, totalCents: 8000, byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 8000 }] }),
      ];
      const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
      const card = taxCard(container);
      expect(within(card).queryByText(/already included in its parent/)).toBeNull();
      const foodCell = Array.from(card.querySelectorAll('tbody td')).find((td) => td.textContent === 'Food') as HTMLElement;
      expect(foodCell.style.paddingLeft).toBe('16px');
    });

    it('does not indent or add the note when only a child is flagged and its parent has no row', () => {
      const rows = [
        // parentId 1 (Food) is never itself a row here -- only Groceries is flagged.
        taxRow({ categoryId: 2, categoryName: 'Groceries', parentId: 1, totalCents: 5000, byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 5000 }] }),
      ];
      const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
      const card = taxCard(container);
      const scoped = within(card);
      expect(scoped.queryByText(/already included in its parent/)).toBeNull();
      const groceriesCell = Array.from(card.querySelectorAll('tbody td')).find((td) => td.textContent === 'Groceries') as HTMLElement;
      expect(groceriesCell.style.paddingLeft).toBe('16px');
      // The lone row and the total agree -- there is nothing to fold in.
      expect(scoped.getAllByText('$50.00')).toHaveLength(2);
    });

    it('both flagged with more than one person: the total still counts the parent rollup once', () => {
      const rows = [
        taxRow({
          categoryId: 1,
          categoryName: 'Food',
          parentId: null,
          totalCents: 8000,
          byUser: [
            { userId: 1, label: 'Alice', cents: 3000 },
            { userId: null, label: UNATTRIBUTED_LABEL, cents: 5000 },
          ],
        }),
        taxRow({
          categoryId: 2,
          categoryName: 'Groceries',
          parentId: 1,
          totalCents: 5000,
          byUser: [{ userId: null, label: UNATTRIBUTED_LABEL, cents: 5000 }],
        }),
      ];
      const { container } = render(<ReportsClient {...baseProps({ taxYears: [2026], taxYear: 2026, taxRows: rows })} />);
      const card = taxCard(container);
      const rowsInDom = Array.from(card.querySelectorAll('tbody tr'));
      const totalRow = rowsInDom.find((tr) => tr.textContent?.startsWith('Total'));
      expect(totalRow?.textContent).toContain('$80.00');
      expect(card.textContent).not.toContain('$130.00');
    });
  });
});
