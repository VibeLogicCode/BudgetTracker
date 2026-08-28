// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { ReportsClient, type TaxYearDisplayRow } from '@/app/(app)/reports/reports-client';
import { UNATTRIBUTED_LABEL } from '@/lib/reports';
import type { ResolvedRange } from '@/lib/date-range';
import type { NetWorthPoint } from '@/lib/networth';

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
 *
 * Adversarial-review fix (2026-08-23): the "ReportsClient — Net worth card" describe block below
 * renders NetWorthChart (recharts) with non-empty data for the first time in this file -- every
 * fixture above passes netWorth: []. recharts' ResponsiveContainer requires ResizeObserver to
 * mount, which jsdom does not provide; the stub right below is a test-environment shim, not a
 * production concern (real browsers all have ResizeObserver).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

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
    hasLent: false,
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
    // v1.13.0 ruling R2: every fixture in this file predates the household/self split, so it
    // keeps the pre-existing (household-viewer) behavior -- the person picker and split card
    // both visible -- unless a test overrides it.
    showPersonSplit: true,
    // v1.13.0 ruling R2 (fix round 1): same reasoning as showPersonSplit above -- every fixture
    // here predates the self-viewer net-worth/debt/tax-year exclusion, so it keeps the
    // pre-existing (household-viewer) behavior of showing all three unless a test overrides it.
    // The "Net worth card" describe block below depends on this being true to exercise that
    // card's own empty/populated states at all.
    showHouseholdTotals: true,
    // v1.13.0 ruling R2 (fix round 2): same reasoning as showPersonSplit/showHouseholdTotals
    // above -- every fixture here predates the self-viewer export-link exclusion, so it
    // keeps the pre-existing (household-viewer) behavior of offering Export CSV unless a
    // test overrides it.
    showExport: true,
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

/**
 * Adversarial-review fix (2026-08-23), Defect 2: this card's honesty note used to cover only
 * accountsMissing (an account with NO balance on file at all). src/lib/networth.ts now also
 * reports accountsStale (a balance that exists but is more than STALE_SNAPSHOT_DAYS old --
 * see that file), and this card must disclose that too, in the same voice, without the two
 * counts turning the note into a form letter when both fire at once.
 */
describe('ReportsClient — Net worth card', () => {
  const STALE_SNAPSHOT_DAYS = 45; // src/lib/networth.ts's exported constant, mirrored here to
  // keep this test file's import list unchanged; a drift in the real constant would show up as
  // a mismatched note string below, which is exactly the regression this guards against.

  function netWorthCard(container: HTMLElement): HTMLElement {
    const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === 'Net worth');
    if (!heading) throw new Error('Net worth card heading not found');
    const card = heading.closest('section');
    if (!card) throw new Error('Net worth card section not found');
    return card as HTMLElement;
  }

  function netWorthPoint(over: Partial<NetWorthPoint> = {}): NetWorthPoint {
    return {
      month: '2026-06',
      assetsCents: 100_000,
      debtsCents: 0,
      netCents: 100_000,
      accountsMissing: 0,
      accountsStale: 0,
      ...over,
    };
  }

  it('shows no honesty note when the latest point has nothing missing or stale', () => {
    const { container } = render(<ReportsClient {...baseProps()} netWorth={[netWorthPoint()]} />);
    const card = within(netWorthCard(container));
    expect(card.queryByText(/no balance/)).toBeNull();
    expect(card.queryByText(/reported a balance/)).toBeNull();
  });

  it('discloses one missing account, singular', () => {
    const { container } = render(<ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsMissing: 1 })]} />);
    const card = within(netWorthCard(container));
    expect(card.getByText('1 account has no balance yet. Update it in Settings and Accounts.')).toBeTruthy();
  });

  it('discloses several missing accounts, plural', () => {
    const { container } = render(<ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsMissing: 3 })]} />);
    const card = within(netWorthCard(container));
    expect(card.getByText('3 accounts have no balance yet. Update them in Settings and Accounts.')).toBeTruthy();
  });

  it('discloses one stale account, singular', () => {
    const { container } = render(<ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsStale: 1 })]} />);
    const card = within(netWorthCard(container));
    expect(
      card.getByText(`1 account has not reported a balance in over ${STALE_SNAPSHOT_DAYS} days. Update it in Settings and Accounts.`),
    ).toBeTruthy();
  });

  it('discloses several stale accounts, plural', () => {
    const { container } = render(<ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsStale: 2 })]} />);
    const card = within(netWorthCard(container));
    expect(
      card.getByText(`2 accounts have not reported a balance in over ${STALE_SNAPSHOT_DAYS} days. Update them in Settings and Accounts.`),
    ).toBeTruthy();
  });

  it('discloses missing AND stale together in one note, each correctly pluralized, when both are non-zero', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsMissing: 2, accountsStale: 3 })]} />,
    );
    const card = within(netWorthCard(container));
    expect(
      card.getByText(
        `2 accounts have no balance yet, and 3 accounts have not reported a balance in over ${STALE_SNAPSHOT_DAYS} days. Update them in Settings and Accounts.`,
      ),
    ).toBeTruthy();
  });

  it('reads correctly when exactly one account is missing and exactly one (a different one) is stale', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} netWorth={[netWorthPoint({ accountsMissing: 1, accountsStale: 1 })]} />,
    );
    const card = within(netWorthCard(container));
    expect(
      card.getByText(
        `1 account has no balance yet, and 1 account has not reported a balance in over ${STALE_SNAPSHOT_DAYS} days. Update them in Settings and Accounts.`,
      ),
    ).toBeTruthy();
  });

  it("uses only the LATEST point's counts -- an earlier gap that has since been filled does not linger", () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        netWorth={[
          netWorthPoint({ month: '2026-05', accountsMissing: 5, accountsStale: 5 }),
          netWorthPoint({ month: '2026-06', accountsMissing: 0, accountsStale: 0 }),
        ]}
      />,
    );
    const card = within(netWorthCard(container));
    expect(card.queryByText(/no balance/)).toBeNull();
    expect(card.queryByText(/reported a balance/)).toBeNull();
  });
});

describe('ReportsClient — the debt card carries both series (rulings P12, P14)', () => {
  const twoSeries = [
    { month: '2026-06', owedCents: 200_000, lentCents: 50_000 },
    { month: '2026-07', owedCents: 190_000, lentCents: 50_000 },
    { month: '2026-08', owedCents: 180_000, lentCents: 30_000 },
  ];

  it('names both lines in the card description when a lent loan has a balance', () => {
    const { container } = render(<ReportsClient {...baseProps()} debt={twoSeries} hasLoans hasLent />);
    expect(container.textContent).toContain('what it has lent out');
  });

  it('says nothing about lending when the household has lent nothing', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        debt={twoSeries.map((p) => ({ ...p, lentCents: null }))}
        hasLoans
        hasLent={false}
      />,
    );
    expect(container.textContent).not.toContain('lent out');
  });

  it('the card is still hidden from a self viewer, whichever series exist (ruling R2)', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} debt={twoSeries} hasLoans hasLent showHouseholdTotals={false} />,
    );
    expect(container.textContent).not.toContain('Debt over time');
  });

  it('the empty state is still driven by the OWED series alone', () => {
    // A household with one lent loan and no debt history has nothing to draw on the debt line,
    // and that is what the "Not enough history yet" state is about -- ruling P12 keeps the gate.
    const { container } = render(
      <ReportsClient {...baseProps()} debt={twoSeries.map((p) => ({ ...p, owedCents: null }))} hasLoans hasLent />,
    );
    expect(container.textContent).toContain('Not enough history yet');
  });
});

describe('ReportsClient — the "Who spent it" card (item A, ruling P2)', () => {
  function splitCard(container: HTMLElement): HTMLElement {
    const heading = [...container.querySelectorAll('h2, h3')].find((node) => node.textContent === 'Who spent it');
    const card = heading?.closest('div[class*="card"], section, article') ?? heading?.parentElement?.parentElement;
    if (!card) throw new Error('the "Who spent it" card is not on the page');
    return card as HTMLElement;
  }

  it('shows the empty state when every row is zero', () => {
    // The defect: personSpendSplit ALWAYS pushes the unattributed bucket (src/lib/reports.ts:361),
    // so split.length was never 0 for the only viewer who sees this card, and "Nothing to split
    // yet" -- written, styled and given an action -- could never render.
    const { container } = render(
      <ReportsClient {...baseProps()} split={[{ userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 }]} />,
    );
    expect(within(splitCard(container)).getByText('Nothing to split yet')).toBeTruthy();
  });

  it('shows the rows when any row carries spend', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        split={[
          { userId: 7, label: 'Alice', spentCents: 42000 },
          { userId: null, label: UNATTRIBUTED_LABEL, spentCents: 0 },
        ]}
      />,
    );
    const card = within(splitCard(container));
    expect(card.queryByText('Nothing to split yet')).toBeNull();
    expect(card.getByText('Alice')).toBeTruthy();
    // The zero bucket still renders once there is anything to compare it against.
    expect(card.getByText(UNATTRIBUTED_LABEL)).toBeTruthy();
  });
});

describe('ReportsClient — the page guide names no absent control (item BM, ruling P15)', () => {
  function guideText(container: HTMLElement): string {
    return container.querySelector('details')?.textContent ?? '';
  }

  it('does not promise Export CSV to a viewer who has no Export CSV button', () => {
    const { container } = render(<ReportsClient {...baseProps()} showExport={false} />);
    expect(guideText(container)).not.toContain('Export CSV');
  });

  it('does not promise a per-person split to a viewer who has no split card', () => {
    const { container } = render(<ReportsClient {...baseProps()} showPersonSplit={false} />);
    expect(guideText(container)).not.toContain('split by person');
  });

  it('still says both to a household viewer', () => {
    const { container } = render(<ReportsClient {...baseProps()} />);
    const text = guideText(container);
    expect(text).toContain('Export CSV');
    expect(text).toContain('split by person');
  });

  // Review B fix round, item 3. The ungated clause "The date range and person at the top drive
  // every card below at once" named the Person select even when showPersonSplit is false, and
  // the third guide paragraph named the Net worth and Tax year cards even when showHouseholdTotals
  // is false -- both self-viewer-only omissions the same class of bug as showExport/showPersonSplit
  // above, just missed by the first pass.
  it('names no person, Net worth or Tax year copy for a self viewer', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        showPersonSplit={false}
        showHouseholdTotals={false}
        showExport={false}
      />,
    );
    const description = container.querySelector('p.max-w-2xl')?.textContent ?? '';
    const guide = guideText(container);
    for (const text of ['person', 'Net worth', 'Tax year']) {
      expect(description).not.toContain(text);
      expect(guide).not.toContain(text);
    }
  });

  it('still says person, Net worth and Tax year to a household viewer', () => {
    const { container } = render(<ReportsClient {...baseProps()} />);
    const description = container.querySelector('p.max-w-2xl')?.textContent ?? '';
    const guide = guideText(container);
    expect(description).toContain('person');
    expect(guide).toContain('person');
    expect(guide).toContain('Net worth');
    expect(guide).toContain('Tax year');
  });
});
