// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import {
  ReportsClient,
  type CategoryBreakdownDisplayRow,
  type SavingsMonthRow,
  type TaxYearDisplayRow,
} from '@/app/(app)/reports/reports-client';
import { buildSavingsSeries, hasAnyTarget, SavingsChart } from '@/components/charts/SavingsChart';
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

function baseProps(
  overrides: {
    taxYears?: number[];
    taxYear?: number | null;
    taxRows?: TaxYearDisplayRow[];
    cashflow?: SavingsMonthRow[];
  } = {},
) {
  return {
    range: RANGE,
    today: '2026-06-30',
    person: '',
    people: [],
    breakdown: [] as CategoryBreakdownDisplayRow[],
    // F-08: null means the range shifted twelve months back had no rows at all, so the two
    // comparison columns are withheld rather than shown as $0.00.
    priorYearRange: null as { from: string; to: string } | null,
    // F-04: the "Income by source" card's rows, empty in every pre-existing fixture here.
    income: [] as CategoryBreakdownDisplayRow[],
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
    cashflow: overrides.cashflow ?? [],
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
    // v1.15.0 (responsive rows): the category cell carries the tree's indent AND is the
    // phone card's headline (same rule as Budgets' Row component). Read off the CELL via
    // closest('td'), not off whatever element happens to hold the text: F-01 (v1.31.0) made the
    // name itself a drill-down <a> inside that cell, which is where the text now lives.
    expect(card.getAllByText('Groceries')[0].closest('td')?.className).toContain('cell-stack-headline');
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

/**
 * Lane 4 (savings targets, v1.17.0 spec docs/superpowers/plans/2026-08-30-savings-targets.md):
 * the "Cash flow and savings rate" card. No test for this card existed before this lane (Task
 * 14 relied entirely on savingsRate()'s own lib-level tests) -- this is new coverage, not a
 * rewrite of an existing block.
 *
 * SavingsChart (recharts) renders none of its children under jsdom's 0x0 ResponsiveContainer,
 * the same limitation the Net worth and Debt over time cards above already work around -- so
 * these tests exercise the summary sentence, the one piece of this card's content jsdom can
 * actually show. buildSavingsSeries' own describe block below covers the chart's data shape
 * directly, bypassing rendering entirely.
 */
describe('ReportsClient — Cash flow and savings rate card', () => {
  function cashflowCard(container: HTMLElement): HTMLElement {
    const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === 'Cash flow and savings rate');
    if (!heading) throw new Error('Cash flow and savings rate card heading not found');
    const card = heading.closest('section');
    if (!card) throw new Error('Cash flow and savings rate card section not found');
    return card as HTMLElement;
  }

  function savingsRow(over: Partial<SavingsMonthRow> & { month: string }): SavingsMonthRow {
    return {
      incomeCents: 0,
      spendCents: 0,
      netCents: 0,
      targetCents: null,
      met: false,
      ...over,
    };
  }

  it('shows the empty state when there is nothing in the range', () => {
    const { container } = render(<ReportsClient {...baseProps({ cashflow: [] })} />);
    expect(within(cashflowCard(container)).getByText('Nothing to show for this range')).toBeTruthy();
  });

  it('keeps the pre-existing summary sentence, with no target clause, when no month has a target', () => {
    const rows = [
      savingsRow({ month: '2026-05', incomeCents: 500000, spendCents: 350000, netCents: 150000 }),
      savingsRow({ month: '2026-06', incomeCents: 500000, spendCents: 400000, netCents: 100000 }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ cashflow: rows })} />);
    const card = within(cashflowCard(container));
    expect(card.getByText('Income $10,000.00 · Spent $7,500.00 · Saved $2,500.00 (25%)')).toBeTruthy();
    expect(card.queryByText(/Target met/)).toBeNull();
  });

  it('still shows the no-income sentence, unchanged, when the range has no income', () => {
    const rows = [savingsRow({ month: '2026-06', incomeCents: 0, spendCents: 10000, netCents: -10000 })];
    const { container } = render(<ReportsClient {...baseProps({ cashflow: rows })} />);
    expect(within(cashflowCard(container)).getByText('No income recorded in this range.')).toBeTruthy();
  });

  it('adds the target-met count when every month in range has a target, met or not', () => {
    const rows = [
      savingsRow({ month: '2026-04', incomeCents: 500000, spendCents: 350000, netCents: 150000, targetCents: 100000, met: true }),
      savingsRow({ month: '2026-05', incomeCents: 500000, spendCents: 450000, netCents: 50000, targetCents: 100000, met: false }),
      savingsRow({ month: '2026-06', incomeCents: 500000, spendCents: 400000, netCents: 100000, targetCents: 100000, met: true }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ cashflow: rows })} />);
    expect(within(cashflowCard(container)).getByText(/Target met in 2 of 3 months\.$/)).toBeTruthy();
  });

  it('excludes an untargeted month from both the numerator and the denominator', () => {
    const rows = [
      savingsRow({ month: '2026-05', incomeCents: 500000, spendCents: 350000, netCents: 150000, targetCents: 100000, met: true }),
      // No target at all this month -- Lane 1's own rule: neither met nor missed, so it must
      // not count toward either side of the fraction.
      savingsRow({ month: '2026-06', incomeCents: 500000, spendCents: 600000, netCents: -100000, targetCents: null, met: false }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ cashflow: rows })} />);
    expect(within(cashflowCard(container)).getByText(/Target met in 1 of 1 month\.$/)).toBeTruthy();
  });

  it('says nothing about a target at all when no month in the range has one', () => {
    const rows = [savingsRow({ month: '2026-06', incomeCents: 500000, spendCents: 400000, netCents: 100000 })];
    const { container } = render(<ReportsClient {...baseProps({ cashflow: rows })} />);
    expect(within(cashflowCard(container)).queryByText(/Target met/)).toBeNull();
  });
});

/**
 * Lane 4: SavingsChart's own data-shaping helper (src/components/charts/SavingsChart.tsx),
 * unit tested directly rather than through a render -- see the describe block above for why
 * recharts itself is not a reachable assertion under jsdom.
 */
describe('buildSavingsSeries (src/components/charts/SavingsChart.tsx)', () => {
  it('carries Income/Spend/Net through in dollars', () => {
    const [point] = buildSavingsSeries([
      { month: '2026-06', incomeCents: 500000, spendCents: 350000, netCents: 150000, targetCents: null },
    ]);
    expect(point.Income).toBe(5000);
    expect(point.Spend).toBe(3500);
    expect(point.Net).toBe(1500);
  });

  it('resolves a set target to dollars', () => {
    const [point] = buildSavingsSeries([
      { month: '2026-06', incomeCents: 500000, spendCents: 350000, netCents: 150000, targetCents: 100000 },
    ]);
    expect(point.Target).toBe(1000);
  });

  it('a month with no target produces Target: null, never 0 -- a zero would read as "your target was nothing"', () => {
    const [point] = buildSavingsSeries([
      { month: '2026-06', incomeCents: 500000, spendCents: 350000, netCents: 150000, targetCents: null },
    ]);
    expect(point.Target).toBeNull();
  });

  it('accumulates the cumulative-saved column across the range, starting back at 0 each call', () => {
    const points = buildSavingsSeries([
      { month: '2026-04', incomeCents: 500000, spendCents: 400000, netCents: 100000, targetCents: null },
      { month: '2026-05', incomeCents: 500000, spendCents: 450000, netCents: 50000, targetCents: null },
      // A deficit month reduces the running total rather than clamping at 0 -- the column is a
      // plain running sum, not a floor.
      { month: '2026-06', incomeCents: 500000, spendCents: 600000, netCents: -100000, targetCents: null },
    ]);
    expect(points.map((p) => p['Cumulative saved'])).toEqual([1000, 1500, 500]);
  });
});

/**
 * v1.21.0 plan, item 5. `hasAnyTarget` decides defect 3 (a Target line/legend entry drawn when
 * no savings target was ever set) -- exported for exactly the reason buildSavingsSeries is: a
 * plain function can be pinned directly without fighting jsdom's inability to mount
 * ResponsiveContainer's children.
 */
describe('hasAnyTarget (src/components/charts/SavingsChart.tsx)', () => {
  it('false when every point in the window has no target', () => {
    const series = buildSavingsSeries([
      { month: '2026-05', incomeCents: 500000, spendCents: 400000, netCents: 100000, targetCents: null },
      { month: '2026-06', incomeCents: 500000, spendCents: 450000, netCents: 50000, targetCents: null },
    ]);
    expect(hasAnyTarget(series)).toBe(false);
  });

  it('true the moment any single point has a target, even if the rest do not', () => {
    const series = buildSavingsSeries([
      { month: '2026-05', incomeCents: 500000, spendCents: 400000, netCents: 100000, targetCents: null },
      { month: '2026-06', incomeCents: 500000, spendCents: 450000, netCents: 50000, targetCents: 100000 },
    ]);
    expect(hasAnyTarget(series)).toBe(true);
  });
});

/**
 * v1.21.0 plan, item 5. SavingsChart itself, rendered: recharts' ResponsiveContainer still
 * measures 0x0 under jsdom (the same limitation noted throughout this file), so nothing inside
 * it is assertable -- but the split this item introduces put a plain heading ("Cumulative
 * saved") OUTSIDE that container, specifically so the split is visible even under this
 * limitation, and that much IS assertable.
 */
describe('SavingsChart (src/components/charts/SavingsChart.tsx)', () => {
  it('renders the cumulative-saved chart with its own heading, not folded back into one chart', () => {
    const { container } = render(
      <SavingsChart
        data={[{ month: '2026-06', incomeCents: 500000, spendCents: 400000, netCents: 100000, targetCents: null }]}
      />,
    );
    expect(within(container).getByText('Cumulative saved')).toBeTruthy();
  });
});

/**
 * v1.31.0, F-01 / F-04 / F-08.
 *
 * Every assertion below reads an `href` off the rendered DOM rather than calling
 * `transactionsHref` and comparing strings: what a person gets when they click the number is the
 * behaviour worth pinning, and a test that rebuilt the URL with the same helper the component
 * used would pass even if the component had passed it the WRONG SCOPE -- which is precisely the
 * defect class this feature had to avoid (v1.30.0 shipped three fixes for paths that dropped a
 * person scope). So every expected scope is spelled out here, literally, per card.
 */

function cardByTitle(container: HTMLElement, title: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === title);
  if (!heading) throw new Error(`No card titled ${title}`);
  const card = heading.closest('section');
  if (!card) throw new Error(`No <section> around the ${title} card`);
  return card as HTMLElement;
}

/** Every <a> inside one card, as [text, href] -- the shape an assertion about drill-downs wants. */
function linksIn(card: HTMLElement): [string, string][] {
  return Array.from(card.querySelectorAll('a')).map((a) => [a.textContent ?? '', a.getAttribute('href') ?? '']);
}

function breakdownRow(over: {
  categoryId: number | null;
  categoryName: string;
  spentCents: number;
  priorCents?: number;
  direct?: boolean;
  isIncome?: boolean;
}): CategoryBreakdownDisplayRow {
  return {
    parentId: null,
    isIncome: false,
    direct: false,
    priorCents: 0,
    ...over,
  };
}

describe('ReportsClient — F-01: every figure links to the rows behind it', () => {
  it("a Category breakdown row links to its category over the card's own range and person", () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        person="4"
        breakdown={[breakdownRow({ categoryId: 12, categoryName: 'Groceries', spentCents: 124000 })]}
      />,
    );
    expect(linksIn(cardByTitle(container, 'Category breakdown'))).toContainEqual([
      'Groceries',
      '/transactions?range=last_6_months&person=4&category=12',
    ]);
  });

  it('the Uncategorized bucket links too, as a real filter value', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        breakdown={[breakdownRow({ categoryId: null, categoryName: 'Uncategorized', spentCents: 4000 })]}
      />,
    );
    expect(linksIn(cardByTitle(container, 'Category breakdown'))).toContainEqual([
      'Uncategorized',
      '/transactions?range=last_6_months&category=uncategorized',
    ]);
  });

  it('a household figure links without a person filter, so it does not answer a narrower question', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        person=""
        breakdown={[breakdownRow({ categoryId: 12, categoryName: 'Groceries', spentCents: 124000 })]}
      />,
    );
    expect(linksIn(cardByTitle(container, 'Category breakdown'))[0][1]).not.toContain('person=');
  });

  it('the unattributed person scope travels as a scope, not as an absent one', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        person="unattributed"
        breakdown={[breakdownRow({ categoryId: 12, categoryName: 'Groceries', spentCents: 124000 })]}
      />,
    );
    expect(linksIn(cardByTitle(container, 'Category breakdown'))[0][1]).toContain('person=unattributed');
  });

  it('a Month over month row asks for that category ALONE, because that is what the row sums', () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        person="4"
        monthOverMonth={{
          months: ['2026-05', '2026-06'],
          rows: [{ categoryId: 12, categoryName: 'Groceries', byMonth: { '2026-05': 1000, '2026-06': 2000 }, totalCents: 3000 }],
        }}
      />,
    );
    expect(linksIn(cardByTitle(container, 'Month over month'))).toContainEqual([
      'Groceries',
      '/transactions?range=last_6_months&person=4&category=12&exact=1',
    ]);
  });

  it("a year-over-year row links to the card's OWN compare month, not the page range", () => {
    const { container } = render(
      <ReportsClient
        {...baseProps()}
        person="4"
        yoyMonth="2026-02"
        yoy={[{ categoryId: 12, categoryName: 'Groceries', thisMonthCents: 1000, lastMonthCents: 900, lastYearCents: 800 }]}
      />,
    );
    expect(linksIn(cardByTitle(container, 'This month against last year'))).toContainEqual([
      'Groceries',
      '/transactions?range=custom&from=2026-02-01&to=2026-02-28&person=4&category=12',
    ]);
  });

  it('a Top merchants row searches for that merchant over the range and person', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} person="4" merchants={[{ normalizedMerchant: 'TIM HORTONS', spentCents: 4200, count: 7 }]} />,
    );
    expect(linksIn(cardByTitle(container, 'Top merchants'))).toContainEqual([
      'TIM HORTONS',
      '/transactions?range=last_6_months&person=4&q=TIM+HORTONS',
    ]);
  });

  it("a Tax year row links to the whole tax year and to THAT ROW'S person, not the page filter", () => {
    const rows = [
      taxRow({
        categoryId: 12,
        categoryName: 'Medical',
        totalCents: 9000,
        byUser: [
          { userId: 3, label: 'Alice', cents: 6000 },
          { userId: null, label: UNATTRIBUTED_LABEL, cents: 3000 },
        ],
      }),
    ];
    const { container } = render(<ReportsClient {...baseProps({ taxYears: [2025], taxYear: 2025, taxRows: rows })} person="4" />);
    const hrefs = linksIn(cardByTitle(container, 'Tax year')).filter(([, href]) => href.startsWith('/transactions'));
    expect(hrefs).toEqual([
      ['Medical', '/transactions?range=custom&from=2025-01-01&to=2025-12-31&person=3&category=12'],
      ['Medical', '/transactions?range=custom&from=2025-01-01&to=2025-12-31&person=unattributed&category=12'],
    ]);
  });
});

describe('ReportsClient — F-08: the same period a year earlier', () => {
  const breakdown = [
    breakdownRow({ categoryId: 12, categoryName: 'Groceries', spentCents: 124000, priorCents: 100000 }),
    breakdownRow({ categoryId: 13, categoryName: 'Coffee', spentCents: 5000, priorCents: 0 }),
  ];

  it('adds the comparison columns when the shifted range has rows', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} breakdown={breakdown} priorYearRange={{ from: '2025-01-01', to: '2025-06-30' }} />,
    );
    const card = within(cardByTitle(container, 'Category breakdown'));
    expect(card.getByText('Same period last year')).toBeTruthy();
    expect(card.getByText('$1,000.00')).toBeTruthy();
    expect(card.getByText('+24% vs last year')).toBeTruthy();
  });

  it('says so in words rather than showing a $0.00 comparison for a category that is new this year', () => {
    const { container } = render(
      <ReportsClient {...baseProps()} breakdown={breakdown} priorYearRange={{ from: '2025-01-01', to: '2025-06-30' }} />,
    );
    const card = within(cardByTitle(container, 'Category breakdown'));
    expect(card.getByText('No spend in this range last year')).toBeTruthy();
    expect(card.queryByText('$0.00')).toBeNull();
  });

  it('hides the columns entirely when the shifted range has nothing in it', () => {
    const { container } = render(<ReportsClient {...baseProps()} breakdown={breakdown} priorYearRange={null} />);
    const card = within(cardByTitle(container, 'Category breakdown'));
    expect(card.queryByText('Same period last year')).toBeNull();
    expect(card.queryByText('Change')).toBeNull();
    // The card still shows this year's own figures -- only the comparison is withheld.
    expect(card.getByText('$1,240.00')).toBeTruthy();
  });
});

describe('ReportsClient — F-04: Income by source', () => {
  const income = [
    breakdownRow({ categoryId: 20, categoryName: 'Salary', spentCents: -500000, isIncome: true }),
    breakdownRow({ categoryId: 21, categoryName: 'Child benefit', spentCents: -60000, isIncome: true }),
    breakdownRow({
      categoryId: 22,
      categoryName: 'Income — not in a sub-category',
      spentCents: -7000,
      isIncome: true,
      direct: true,
    }),
  ];

  it('reads income as money IN, not as a negative amount of spend', () => {
    const { container } = render(<ReportsClient {...baseProps()} income={income} />);
    const card = within(cardByTitle(container, 'Income by source'));
    expect(card.getByText('$5,000.00')).toBeTruthy();
    expect(card.getByText('$600.00')).toBeTruthy();
    expect(card.queryByText('-$5,000.00')).toBeNull();
  });

  it("links each source, and asks for a parent category ALONE when the row is that parent's own slice", () => {
    const { container } = render(<ReportsClient {...baseProps()} person="4" income={income} />);
    const hrefs = linksIn(cardByTitle(container, 'Income by source'));
    expect(hrefs).toContainEqual(['Salary', '/transactions?range=last_6_months&person=4&category=20']);
    expect(hrefs).toContainEqual([
      'Income — not in a sub-category',
      '/transactions?range=last_6_months&person=4&category=22&exact=1',
    ]);
  });

  it('shows an empty state rather than a card of nothing when no income landed in the range', () => {
    const { container } = render(<ReportsClient {...baseProps()} income={[]} />);
    expect(within(cardByTitle(container, 'Income by source')).getByText('No income in this range')).toBeTruthy();
  });
});
