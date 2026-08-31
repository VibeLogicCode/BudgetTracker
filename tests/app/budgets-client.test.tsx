// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BudgetsClient } from '@/app/(app)/budgets/budgets-client';
import { sectionFrom } from '@/app/(app)/budgets/page';
import type { BudgetRow } from '@/lib/budgets';
import type { BudgetPredictions, CategorySuggestion } from '@/lib/predict/suggest';
// Type-only (see budgets-client.tsx's own import of this module for why): never evaluated at
// runtime, so this line does not need Lane 1's src/lib/savings-target.ts to exist to compile or
// to run under vitest -- only `@/app/(app)/budgets/page` above (a VALUE import) does.
import type { SavingsProgress } from '@/lib/savings-target';

vi.mock('@/app/(app)/budgets/actions', () => ({
  setLimitAction: vi.fn(async () => ({})),
  copyPreviousMonthAction: vi.fn(async () => ({})),
  applySuggestionAction: vi.fn(async () => ({})),
  applyAllSuggestionsAction: vi.fn(async () => ({})),
  setRolloverAction: vi.fn(async () => ({})),
  setSavingsTargetAction: vi.fn(async () => ({})),
}));

// The Lane 1 drill-down (2026-08-30 plan): a NEW module, not ./actions, so it gets its own mock.
// Nothing in this file exercises it directly (no test here opens "View transactions"), but every
// render mounts BudgetCategoryCard, and an unmocked module would otherwise reach requireUser()
// and the real database the moment a test DID click through -- mocked here so a future test that
// does can rely on a predictable, empty result rather than a real query.
vi.mock('@/app/(app)/budgets/category-transactions-action', () => ({
  categoryTransactionsAction: vi.fn(async () => ({ rows: [] })),
}));

afterEach(() => cleanup());

function makeRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
  return {
    categoryId: 1,
    categoryName: 'Groceries',
    parentId: null,
    isIncome: false,
    isArchived: false,
    limitCents: 20000,
    // v1.7.0 rollover: limitCents is the EFFECTIVE limit, base plus any carry. A row with no
    // rollover has base equal to limit and no carry, which is what this default represents.
    baseLimitCents: 20000,
    carryCents: 0,
    spentCents: 5000,
    remainingCents: 15000,
    pct: 25,
    overBudget: false,
    children: [],
    // v1.21.0 item 2: 0 by default, same as any row with no direct spend of its own --
    // BudgetCategoryCard renders the "Not in a sub-category" row only when this is non-zero,
    // so the default keeps every existing test's card exactly as it rendered before that row existed.
    directSpentCents: 0,
    ...overrides,
  };
}

const SUGGESTION: CategorySuggestion = {
  categoryId: 1,
  suggestedCents: 78000,
  medianCents: 76000,
  meanCents: 77000,
  trend: { direction: 'rising', deltaCents: 4000 },
  monthsUsed: 6,
  seasonalApplied: false,
  confidence: 'medium',
};

function predictionsWith(over: Partial<BudgetPredictions> = {}): BudgetPredictions {
  return {
    monthsUsed: 6,
    dayOfMonth: 12,
    household: { suggestions: [], projections: [], noAttribution: false },
    personal: [],
    ...over,
  };
}

/** A fully-resolved SavingsProgress fixture, close enough to what savingsProgress() itself
 *  would compute -- these tests only assert on what SavingsTargetControl reads off it (target,
 *  targetCents), not the money/pace math Lane 1's own tests already cover. */
function progressWith(over: Partial<SavingsProgress> = {}): SavingsProgress {
  return {
    month: '2026-03',
    target: null,
    targetCents: null,
    incomeCents: 0,
    spendCents: 0,
    netCents: 0,
    pct: null,
    met: false,
    movedToSavingsCents: 0,
    noSavingsAccount: false,
    ...over,
  };
}

/**
 * The file's existing inline shape, plus whatever the test under way needs.
 *
 * v1.12.1 (item X / UX-4): widened with an optional `limitCents` override so the clear-button
 * tests can vary just the row's limit without a second render(<BudgetsClient/>) call of their own
 * -- renderClient below is a thin alias over this, not a second mount.
 */
function renderBudgets(
  predictions: BudgetPredictions | null,
  opts: { limitCents?: number | null; savingsProgress?: SavingsProgress | null } = {},
) {
  return render(
    <BudgetsClient
      month="2026-03"
      currentUserId={1}
      household={[makeRow(opts.limitCents !== undefined ? { limitCents: opts.limitCents, baseLimitCents: opts.limitCents } : {})]}
      householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
      personal={[]}
      predictions={predictions}
      savingsProgress={opts.savingsProgress ?? null}
    />,
  );
}

/** v1.12.1 (item X / UX-4): the clear-button tests only care about one Groceries row's limit,
 *  not predictions -- this is renderBudgets(null, opts), named for what those tests read. */
function renderClient({ limitCents }: { limitCents: number | null }) {
  return renderBudgets(null, { limitCents });
}

/**
 * 2026-08-30 plan: the limit input, the clear button, the rollover checkbox, the carry/sinking-
 * fund sentences and the suggestion button all moved behind "Edit limits" -- the card grid never
 * renders any of them, editable row or not. `scope` narrows to one section on a page that
 * renders more than one (household + several people each have their OWN toggle), so this never
 * throws on an ambiguous match the way an unscoped `getByRole` would.
 */
function openEditLimits(scope: HTMLElement) {
  fireEvent.click(within(scope).getByRole('button', { name: 'Edit limits' }));
}

describe('BudgetsClient — review finding 2: archived rows are read-only', () => {
  it('renders an archived row without an editable limit form', () => {
    const row = makeRow({ categoryId: 99, categoryName: 'Kids', isArchived: true, limitCents: null, remainingCents: null, pct: null });
    const { container, getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(getByText('(archived)')).toBeTruthy();
    openEditLimits(container);
    expect(getByText('read-only')).toBeTruthy();
    // No amount input for this row, even behind Edit limits.
    expect(container.querySelector('input[name="amount"]')).toBeNull();
  });

  it('review LOW cleanup: sectionFrom gives an archived row no projection entry even though it still carries a limit and spend', () => {
    const archived = makeRow({ categoryId: 42, isArchived: true, limitCents: 20000, spentCents: 5000 });
    const { projections } = sectionFrom({ months: [], byCategory: new Map() }, [archived], 15, 30);
    expect(projections.some((entry) => entry.categoryId === 42)).toBe(false);
  });

  it('still renders an editable limit form for a non-archived row, behind Edit limits', () => {
    const row = makeRow({ categoryId: 2, categoryName: 'Coffee' });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    const input = container.querySelector('input[name="amount"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.defaultValue).toBe('200.00');
  });

  // v1.16.0 Lane C item 4's cell-stack-block guard applied to a <td> the progress bar lived in;
  // that cell no longer exists (budgets is a card grid now, ruling D7). What survives it that
  // matters is the bar itself: a real, shared ProgressBar (ruling D1) reporting the row's own
  // percentage, not a hand-rolled meter re-deriving it.
  it('the card renders a real ProgressBar carrying the row\'s own percentage', () => {
    const row = makeRow({ categoryId: 3, categoryName: 'Rent' });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    // Two bars exist on this page (the household total, and this one row's own) -- scoped by
    // label, since both happen to read the same percentage for this fixture.
    const bar = Array.from(container.querySelectorAll('[role="progressbar"]')).find(
      (el) => el.getAttribute('aria-label') === 'Rent budget used',
    );
    expect(bar?.getAttribute('aria-valuenow')).toBe('25');
  });
});

describe('BudgetsClient — polish item 5: other members’ personal sections are read-only', () => {
  const personalRow = makeRow({ categoryId: 7, categoryName: 'Hobbies', limitCents: 15000 });

  // v1.21.0 item 1: the category GRID now follows the scope pill, so only one person's grid is
  // ever mounted per render (see budgets-client.tsx's own `selectedPersonId` doc comment) --
  // this helper takes WHICH person's scope is selected rather than rendering both at once the
  // way it used to. The header each section always carries (name, "Copy previous month", the
  // read-only marker) is unaffected either way, which is exactly what these tests check.
  function renderFor(currentUserIsAdmin: boolean, selectedPersonId: number) {
    return render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={currentUserIsAdmin}
        selectedPersonId={selectedPersonId}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[
          { userId: 1, name: 'Alice', rows: [personalRow] },
          { userId: 2, name: 'Bob', rows: [personalRow] },
        ]}
      />,
    );
  }

  function sectionFor(container: HTMLElement, name: string): HTMLElement {
    const section = Array.from(container.querySelectorAll('section')).find((node) =>
      node.querySelector('h2')?.textContent?.startsWith(name),
    );
    if (!section) throw new Error(`no section for ${name}`);
    return section as HTMLElement;
  }

  it('a non-admin gets inputs and a copy button for themselves only', () => {
    const { container: aliceScoped } = renderFor(false, 1);
    const mine = sectionFor(aliceScoped, 'Alice');
    openEditLimits(mine);
    expect(mine.querySelector('input[name="amount"]')).not.toBeNull();
    expect(mine.textContent).toContain('Copy previous month');

    const { container: bobScoped } = renderFor(false, 2);
    const theirs = sectionFor(bobScoped, 'Bob');
    openEditLimits(theirs);
    // No control that setLimitAction / copyPreviousMonthAction would refuse anyway.
    expect(theirs.querySelector('input[name="amount"]')).toBeNull();
    expect(theirs.textContent).not.toContain('Copy previous month');
    // The number itself is still visible — the household sees everything by design (the card's
    // own "of $150.00" compare text, no Edit limits needed for that half).
    expect(theirs.textContent).toContain('$150.00');
    expect(theirs.textContent).toContain('read-only');
  });

  it('an admin keeps the controls on everyone’s section', () => {
    for (const [name, id] of [['Alice', 1], ['Bob', 2]] as const) {
      const { container } = renderFor(true, id);
      const section = sectionFor(container, name);
      openEditLimits(section);
      expect(section.querySelector('input[name="amount"]')).not.toBeNull();
      expect(section.textContent).toContain('Copy previous month');
    }
  });

  it('household rows stay editable for a non-admin', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        currentUserIsAdmin={false}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    expect(container.querySelector('input[name="amount"]')).not.toBeNull();
  });
});

describe('BudgetsClient — polish item 7: one banner, not two', () => {
  it('renders neither message nor error before anything has been submitted', () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    // A single banner slot means there is exactly one place a message can appear;
    // with no submission yet, neither the error role nor a success line is present.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.text-green-700')).toBeNull();
  });
});

describe('BudgetsClient — review finding 1: three-number household headline', () => {
  it('reports budgeted spend/limit separately from total spend, not one misleading ratio', () => {
    const row = makeRow();
    const { getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 10000, budgetedSpentCents: 8000, totalSpentCents: 40000 }}
        personal={[]}
      />,
    );
    expect(getByText(/spent \$80\.00 of \$100\.00 budgeted/)).toBeTruthy();
    expect(getByText(/\$400\.00 total spent/)).toBeTruthy();
  });
});

describe('L-6: the no-attribution sentence names the viewer, not always "you"', () => {
  it('says "to you" in the viewer\'s own section and names the other person in theirs', () => {
    const row = makeRow({ categoryId: 7, categoryName: 'Hobbies', limitCents: 15000 });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[
          { userId: 1, name: 'Alice', rows: [row] },
          { userId: 2, name: 'Bob', rows: [row] },
        ]}
        predictions={predictionsWith({
          personal: [
            { userId: 1, predictions: { suggestions: [], projections: [], noAttribution: true } },
            { userId: 2, predictions: { suggestions: [], projections: [], noAttribution: true } },
          ],
        })}
      />,
    );
    const sections = Array.from(container.querySelectorAll('section'));
    const aliceSection = sections.find((node) => node.querySelector('h2')?.textContent?.startsWith('Alice'));
    const bobSection = sections.find((node) => node.querySelector('h2')?.textContent?.startsWith('Bob'));
    expect(aliceSection?.textContent).toContain('No transactions are attributed to you yet');
    expect(bobSection?.textContent).toContain('No transactions are attributed to Bob yet');
    expect(bobSection?.textContent).not.toContain('attributed to you');
  });
});

describe('MUST-14.3 to MUST-14.6: the predictive controls', () => {
  it('renders a Use button carrying no amount field, and its reasoning in the title (behind Edit limits)', () => {
    const { container } = renderBudgets(
      predictionsWith({ household: { suggestions: [SUGGESTION], projections: [], noAttribution: false } }),
    );
    openEditLimits(container);
    const button = Array.from(container.querySelectorAll('button')).find((el) => el.textContent === 'Use $780.00');
    expect(button).toBeTruthy();
    expect(button!.getAttribute('title')).toContain('Confidence: medium.');
    const data = new FormData(button!.closest('form') as HTMLFormElement);
    expect(data.get('amount')).toBeNull();
    expect(data.get('categoryId')).toBe('1');
    expect(data.get('month')).toBe('2026-03');
  });

  it('MUST-15.4: a category with no suggestion shows nothing in the slot', () => {
    const { container } = renderBudgets(predictionsWith());
    openEditLimits(container);
    expect(Array.from(container.querySelectorAll('button')).some((el) => el.textContent?.startsWith('Use '))).toBe(false);
  });

  it('MUST-14.4: the projection line appears on the card, with its assumption in the title', () => {
    const { getByText } = renderBudgets(
      predictionsWith({
        household: { suggestions: [], projections: [{ categoryId: 1, projectedCents: 105900 }], noAttribution: false },
      }),
    );
    const line = getByText('On pace for $1,059.00');
    expect(line.getAttribute('title')).toBe('Assumes the rest of the month looks like the 12 days so far.');
  });

  it('MUST-15.3: before the seventh there is no projection line and no placeholder', () => {
    // The page produces no projections at all before day 7, because projectMonthEnd returns
    // null. dayOfMonth is set to match, so this test fails if the card ever renders a dash or
    // an empty pace line rather than nothing.
    const { container } = renderBudgets(
      predictionsWith({ dayOfMonth: 3, household: { suggestions: [], projections: [], noAttribution: false } }),
    );
    expect(container.textContent).not.toContain('On pace for');
  });

  it('MUST-14.5: the section gains an apply-all button with its hint', () => {
    const { container } = renderBudgets(
      predictionsWith({ household: { suggestions: [SUGGESTION], projections: [], noAttribution: false } }),
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'Apply all suggestions',
    );
    expect(button).toBeTruthy();
    expect(button!.getAttribute('title')).toBe('Only fills in categories with no limit set. Nothing you have typed is changed.');
  });

  it('final-fix-wave item 1: the household apply-all control is absent whenever there are no suggestions', () => {
    // No predictions at all (a past month, or a fresh install where predictions is null).
    const { container: noPredictions } = renderBudgets(null);
    expect(
      Array.from(noPredictions.querySelectorAll('button')).some((el) => el.textContent === 'Apply all suggestions'),
    ).toBe(false);

    // Predictions computed, but this section has zero qualifying suggestions (under
    // MIN_HISTORY_MONTHS, or every category failed the suggestion floor).
    const { container: emptySuggestions } = renderBudgets(
      predictionsWith({ household: { suggestions: [], projections: [], noAttribution: false } }),
    );
    expect(
      Array.from(emptySuggestions.querySelectorAll('button')).some((el) => el.textContent === 'Apply all suggestions'),
    ).toBe(false);
  });

  it('final-fix-wave item 1: the personal section apply-all control is absent when that person has no suggestions', () => {
    const row = makeRow({ categoryId: 7, categoryName: 'Hobbies', limitCents: 15000 });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[{ userId: 1, name: 'Alice', rows: [row] }]}
        predictions={predictionsWith({
          personal: [{ userId: 1, predictions: { suggestions: [], projections: [], noAttribution: false } }],
        })}
      />,
    );
    expect(Array.from(container.querySelectorAll('button')).some((el) => el.textContent === 'Apply all suggestions')).toBe(
      false,
    );
  });

  it('MUST-15.1: under three months there is a sentence and no disabled button', () => {
    const { container, getByText } = renderBudgets(predictionsWith({ monthsUsed: 2 }));
    expect(getByText('Suggestions appear once there are three full calendar months of history.')).toBeTruthy();
    openEditLimits(container);
    expect(Array.from(container.querySelectorAll('button')).some((el) => el.textContent?.startsWith('Use '))).toBe(false);
  });

  it('MUST-14.1: a past month renders no Use button and no pace line', () => {
    const { container } = renderBudgets(null);
    openEditLimits(container);
    expect(Array.from(container.querySelectorAll('button')).some((el) => el.textContent?.startsWith('Use '))).toBe(false);
    expect(container.textContent).not.toContain('On pace for');
  });

  // MUST-15.3 used to be a shared <th title=...> column header -- there is no shared column
  // header in a card grid (ruling D7), so the same explanation now rides on each card's OWN
  // pace line instead, which is strictly more specific (it already names the exact day count,
  // where the old header's title was one generic sentence for the whole table).
  it('MUST-15.3: the pace line carries its own explanation, now per card', () => {
    const { container } = renderBudgets(
      predictionsWith({ household: { suggestions: [], projections: [{ categoryId: 1, projectedCents: 78000 }], noAttribution: false } }),
    );
    const span = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'On pace for $780.00');
    expect(span?.getAttribute('title')).toBe('Assumes the rest of the month looks like the 12 days so far.');
  });
});

describe('v1.12.1: clearing a budget is a deliberate button (item X / UX-4)', () => {
  it('renders a clear control on a row that has a limit', () => {
    const { container } = renderClient({ limitCents: 60000 });
    openEditLimits(container);
    expect(screen.getByRole('button', { name: /Clear the budget for Groceries/ })).toBeTruthy();
  });

  it('renders no clear control on a row with no limit', () => {
    const { container } = renderClient({ limitCents: null });
    openEditLimits(container);
    expect(screen.queryByRole('button', { name: /Clear the budget for Groceries/ })).toBeNull();
  });

  it('the clear control submits an empty amount, which is what clearBudget reads', () => {
    const { container } = renderClient({ limitCents: 60000 });
    openEditLimits(container);
    const button = screen.getByRole('button', { name: /Clear the budget for Groceries/ });
    const form = button.closest('form');
    expect((form?.querySelector('input[name="amount"]') as HTMLInputElement | null)?.value).toBe('');
    expect((form?.querySelector('input[name="categoryId"]') as HTMLInputElement | null)?.value).toBeTruthy();
    expect((form?.querySelector('input[name="month"]') as HTMLInputElement | null)?.value).toBeTruthy();
  });

  it('fix round 2: a failing clear surfaces the server error inline, next to the button, instead of vanishing (`void setLimitAction(...)` used to discard it)', async () => {
    const { setLimitAction } = await import('@/app/(app)/budgets/actions');
    vi.mocked(setLimitAction).mockResolvedValueOnce({ error: 'You can only edit your own personal budgets.' });
    const { container } = renderClient({ limitCents: 60000 });
    openEditLimits(container);

    const button = screen.getByRole('button', { name: /Clear the budget for Groceries/ });
    fireEvent.submit(button.closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('You can only edit your own personal budgets.'));
    // The row itself is untouched by this render-only failure -- nothing else on the page
    // claims a message it did not earn.
    expect(screen.queryByText('Budget cleared from this month forward.')).toBeNull();
  });
});

describe('Lane 1 (2026-08-30 plan, ruling U1): MonthNav states the month once, in the pill', () => {
  it('prev/next read Feb/Apr, never raw ISO, and still point at ?month=', () => {
    const { container } = renderBudgets(null);
    const links = Array.from(container.querySelectorAll('nav[aria-label="Change month"] a')) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/budgets?month=2026-02', '/budgets?month=2026-04']);
    expect(links.map((a) => a.textContent)).toEqual(['← Feb', 'Apr →']);
  });

  it('the centre pill names the month, and the native month input is collapsed behind it rather than sitting beside it as a second control', () => {
    // Scoped to the nav itself: budgets-client.tsx renders its OWN `eyebrow={monthLabel(month)}`
    // (Lane 2's file, untouched here), which would also read "March 2026" and turn a page-wide
    // getByText into a false "multiple elements" failure that has nothing to do with MonthNav.
    const { container } = renderBudgets(null);
    const nav = container.querySelector('nav[aria-label="Change month"]') as HTMLElement;
    const pill = nav.querySelector('label[for="month-nav-jump"]') as HTMLElement;
    expect(pill.textContent).toContain('March 2026');
    // Exactly one <input type="month"> inside the nav -- v1.17.0 shipped a second, visible one
    // beside the pill; ruling U1 removed it rather than adding a third statement of the month.
    const monthInputs = nav.querySelectorAll('input[type="month"]');
    expect(monthInputs.length).toBe(1);
    expect((monthInputs[0] as HTMLInputElement).value).toBe('2026-03');
  });

  it('changing the month input submits the jump form (a real GET, no client router)', () => {
    // jsdom does not implement form submission/navigation (HTMLFormElement.prototype.requestSubmit
    // fires the "submit" event and then reports "not implemented"); spied so this test can assert
    // the control ASKS for a submit without depending on jsdom's own unimplemented navigation
    // path, and restored so no later test in this file observes the patched prototype.
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
    try {
      const { container } = renderBudgets(null);
      const monthInput = container.querySelector('input[type="month"]') as HTMLInputElement;
      fireEvent.change(monthInput, { target: { value: '2025-11' } });
      expect(requestSubmit).toHaveBeenCalledTimes(1);
    } finally {
      requestSubmit.mockRestore();
    }
  });
});

describe('Lane 3 item 3: the savings target control (ruling T6)', () => {
  it('ruling T3/R2: absent for a self viewer -- household is null, the same gate the Household card uses', () => {
    const { queryByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={null}
        householdTotals={null}
        personal={[]}
      />,
    );
    expect(queryByText('Savings target')).toBeNull();
  });

  it('renders for a household viewer even with no target set yet', () => {
    const { getByText } = renderBudgets(null, { savingsProgress: progressWith() });
    expect(getByText('Savings target')).toBeTruthy();
    expect(getByText('No savings target set for this month yet.')).toBeTruthy();
  });

  it('names the resolved figure for a percent target (ruling T5: provisional until the month closes)', () => {
    const { getByText } = renderBudgets(null, {
      savingsProgress: progressWith({ target: { month: '2026-03', mode: 'percent', value: 20 }, targetCents: 124000 }),
    });
    expect(getByText(/20% of income so far — \$1,240\.00\. Provisional until the month closes\./)).toBeTruthy();
  });

  it('names a percent target with no income yet, without dividing by zero', () => {
    const { getByText } = renderBudgets(null, {
      savingsProgress: progressWith({ target: { month: '2026-03', mode: 'percent', value: 20 }, targetCents: null }),
    });
    expect(getByText('20% of income -- no income recorded yet this month.')).toBeTruthy();
  });

  it('names a fixed amount target', () => {
    const { getByText } = renderBudgets(null, {
      savingsProgress: progressWith({ target: { month: '2026-03', mode: 'amount', value: 25000 }, targetCents: 25000 }),
    });
    expect(getByText('Fixed at $250.00 every month.')).toBeTruthy();
  });

  it('defaults the mode select and value input from the existing target', () => {
    const { container } = renderBudgets(null, {
      savingsProgress: progressWith({ target: { month: '2026-03', mode: 'amount', value: 25000 }, targetCents: 25000 }),
    });
    expect((container.querySelector('select[aria-label="Savings target mode"]') as HTMLSelectElement).value).toBe('amount');
    expect((container.querySelector('input[aria-label="Savings target amount"]') as HTMLInputElement).value).toBe('250.00');
  });

  it('switching mode clears the value rather than reinterpreting the old digits under the new unit', () => {
    const { container } = renderBudgets(null, {
      savingsProgress: progressWith({ target: { month: '2026-03', mode: 'percent', value: 20 }, targetCents: 124000 }),
    });
    const select = container.querySelector('select[aria-label="Savings target mode"]') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'amount' } });
    const amountInput = container.querySelector('input[aria-label="Savings target amount"]') as HTMLInputElement;
    expect(amountInput.value).toBe('');
  });

  it('committing a value on blur saves mode+value+month together', async () => {
    const { setSavingsTargetAction } = await import('@/app/(app)/budgets/actions');
    renderBudgets(null, { savingsProgress: progressWith() });
    const valueInput = screen.getByLabelText('Savings target percent') as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: '25' } });
    fireEvent.blur(valueInput);
    await waitFor(() => expect(setSavingsTargetAction).toHaveBeenCalled());
    const [, formData] = vi.mocked(setSavingsTargetAction).mock.calls.at(-1)!;
    expect((formData as FormData).get('month')).toBe('2026-03');
    expect((formData as FormData).get('mode')).toBe('percent');
    expect((formData as FormData).get('value')).toBe('25');
  });

  it('committing on Enter saves too, and a blank value never calls the server', async () => {
    const { setSavingsTargetAction } = await import('@/app/(app)/budgets/actions');
    // The mock is module-scoped and vitest.config.ts sets no clearMocks -- an earlier test's
    // call in this same file would otherwise still be sitting in this mock's history.
    vi.mocked(setSavingsTargetAction).mockClear();
    renderBudgets(null, { savingsProgress: progressWith() });
    const valueInput = screen.getByLabelText('Savings target percent') as HTMLInputElement;
    // Blank, then blurred: no value to save, so the server is never asked.
    fireEvent.blur(valueInput);
    expect(setSavingsTargetAction).not.toHaveBeenCalled();
    fireEvent.change(valueInput, { target: { value: '30' } });
    fireEvent.keyDown(valueInput, { key: 'Enter' });
    await waitFor(() => expect(setSavingsTargetAction).toHaveBeenCalledTimes(1));
  });
});

describe('Lane 3 item 1: "Copy previous month" also carries the savings target forward', () => {
  it("the household button's title says so, but a personal button's does not (ruling T3)", () => {
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [makeRow()] }]}
      />,
    );
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Copy previous month');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('title')).toMatch(/savings target/i);
    expect(buttons[1].getAttribute('title')).toBeNull();
  });
});

/**
 * v1.18.0 Lane 2: collapsible budget groups, the zero state, and the parent-limit warning
 * (rulings U2-U6). `makeRow`'s default `children: []` already makes every OTHER describe block
 * in this file exercise the "ordinary row" path unchanged -- these tests are the ones that
 * actually give a row children.
 *
 * 2026-08-30 plan: the group-open STATE (and its localStorage keys) is unchanged and shared by
 * both the card grid's "View breakdown" and the Edit-limits list's own disclosure chevron. Most
 * of these tests exercise it through Edit limits -- its ids and aria-controls are the least
 * changed surface from the old table, so they carry over almost verbatim -- and one dedicated
 * test at the end proves the card grid's own toggle reads and writes that very same state.
 */
function housingGroupRow(overrides: { childRent?: Partial<BudgetRow>; childUtilities?: Partial<BudgetRow> } = {}): BudgetRow {
  return makeRow({
    categoryId: 10,
    categoryName: 'Housing',
    baseLimitCents: 200000,
    limitCents: 200000,
    spentCents: 150000,
    remainingCents: 50000,
    pct: 75,
    overBudget: false,
    children: [
      makeRow({
        categoryId: 11,
        categoryName: 'Rent',
        parentId: 10,
        baseLimitCents: 100000,
        limitCents: 100000,
        spentCents: 100000,
        remainingCents: 0,
        pct: 100,
        ...overrides.childRent,
      }),
      makeRow({
        categoryId: 12,
        categoryName: 'Utilities',
        parentId: 10,
        baseLimitCents: 50000,
        limitCents: 50000,
        spentCents: 50000,
        remainingCents: 0,
        pct: 100,
        ...overrides.childUtilities,
      }),
    ],
  });
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Not what this suite is testing -- if the jsdom environment itself has no working
    // localStorage, the "throws" test below covers that case explicitly.
  }
});

describe('v1.18.0 Lane 2 items 1-2: a group collapses, and its header already carries the numbers', () => {
  it('renders collapsed by default, with the rolled-up figures already on the closed header', () => {
    const { container, getByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    const toggle = getByRole('button', { name: 'Housing' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('budget-row-household-h-11 budget-row-household-h-12');

    // Ruling U2: the parent's OWN row already carries the rolled-up spend/remaining
    // (foldRollup, src/lib/budgets.ts) -- no client-side re-summation was needed to show it.
    const header = container.querySelector('#budget-row-household-h-10') as HTMLDivElement;
    expect(header.hidden).toBe(false);

    // Ruling U3: a closed group's children stay in the DOM (hidden, not unmounted) -- see the
    // EditRow prop's own doc comment for why.
    const childRow = container.querySelector('#budget-row-household-h-11') as HTMLDivElement;
    expect(childRow.hidden).toBe(true);
  });

  it('expanding the group reveals its children', () => {
    const { container, getByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    fireEvent.click(getByRole('button', { name: 'Housing' }));
    expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('true');
    const childRow = container.querySelector('#budget-row-household-h-11') as HTMLDivElement;
    expect(childRow.hidden).toBe(false);
  });

  it('a parent with no children renders no disclosure (an ordinary row, not an empty disclosure)', () => {
    const { container, queryByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow({ categoryId: 5, categoryName: 'Insurance' })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    expect(queryByRole('button', { name: 'Insurance' })).toBeNull();
  });

  it('marks an over-budget group with a Pill, and only when it is actually over', () => {
    const overBudget = housingGroupRow();
    overBudget.overBudget = true;
    overBudget.spentCents = 250000;
    const { container, getByText, rerender } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[overBudget]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 250000, totalSpentCents: 250000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    expect(getByText('Over budget')).toBeTruthy();

    const underBudget = housingGroupRow();
    rerender(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[underBudget]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    expect(() => getByText('Over budget')).toThrow();
  });

  it('Household and Personal never collapse themselves (ruling U4) -- both render their rows with no click needed', () => {
    // v1.21.0 item 1: only one scope's grid is mounted per render now (the pill picks which),
    // so this proves the rule once for the Household-scoped render (the default) and once more
    // for Alice's own -- two renders, not the one that used to see both grids at once.
    const { container: householdScoped, getAllByRole: householdButtons } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow({ categoryId: 1 })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [makeRow({ categoryId: 2 })] }]}
      />,
    );
    for (const button of householdButtons('button', { name: 'Edit limits' })) fireEvent.click(button);
    const householdRow = householdScoped.querySelector('#budget-row-household-h-1') as HTMLDivElement;
    expect(householdRow.hidden).toBe(false);

    const { container: aliceScoped, getAllByRole: aliceButtons } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        selectedPersonId={1}
        household={[makeRow({ categoryId: 1 })]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [makeRow({ categoryId: 2 })] }]}
      />,
    );
    for (const button of aliceButtons('button', { name: 'Edit limits' })) fireEvent.click(button);
    const personalRow = aliceScoped.querySelector('#budget-row-personal-1-2') as HTMLDivElement;
    expect(personalRow.hidden).toBe(false);
  });

  it('one Expand all/Collapse all control opens every group in the section at once, then flips', () => {
    const food = housingGroupRow({});
    food.categoryId = 20;
    food.categoryName = 'Food';
    food.children = food.children.map((child, i) => ({ ...child, categoryId: 21 + i, parentId: 20 }));
    const { container, getByRole, queryByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow(), food]}
        householdTotals={{ budgetedLimitCents: 400000, budgetedSpentCents: 300000, totalSpentCents: 300000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    fireEvent.click(getByRole('button', { name: 'Expand all' }));
    expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('true');
    expect(getByRole('button', { name: 'Food' }).getAttribute('aria-expanded')).toBe('true');
    expect(queryByRole('button', { name: 'Expand all' })).toBeNull();

    fireEvent.click(getByRole('button', { name: 'Collapse all' }));
    expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('false');
    expect(getByRole('button', { name: 'Food' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('no Expand all/Collapse all control appears when a section has nothing that can collapse', () => {
    const { queryByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(queryByRole('button', { name: 'Expand all' })).toBeNull();
    expect(queryByRole('button', { name: 'Collapse all' })).toBeNull();
  });

  it('ruling U5: remembers an open group across a remount, keyed separately for household and personal', () => {
    // v1.21.0 item 1: only one scope's grid mounts per render now, so "opening the household
    // one must not touch Alice's own copy of the same category id" is proven across renders --
    // open household's, remount Household-scoped to prove IT persisted, then switch to Alice's
    // own scope and prove HER copy of the same category (10) was never touched.
    // Both sections' headers render on every one of these renders regardless of which grid is
    // selected (household's own Card, and Alice's, per PersonalCard's own doc comment) -- so
    // "Edit limits" always has two matches; household's is the first in document order (it
    // renders before the `personal.map(...)` loop), same as this test's original comment on
    // "Housing" below.
    const { getAllByRole, unmount } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [housingGroupRow()] }]}
      />,
    );
    fireEvent.click(getAllByRole('button', { name: 'Edit limits' })[0]);
    fireEvent.click(getAllByRole('button', { name: 'Housing' })[0]);
    expect(getAllByRole('button', { name: 'Housing' })[0].getAttribute('aria-expanded')).toBe('true');
    unmount();

    const { getAllByRole: getAllByRoleAfterRemount, unmount: unmountAfterRemount } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [housingGroupRow()] }]}
      />,
    );
    fireEvent.click(getAllByRoleAfterRemount('button', { name: 'Edit limits' })[0]);
    // The household's own group is still open after the remount.
    expect(getAllByRoleAfterRemount('button', { name: 'Housing' })[0].getAttribute('aria-expanded')).toBe('true');
    unmountAfterRemount();

    const { getAllByRole: getAllByRoleAliceScoped, getByRole: getByRoleAliceScoped } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        selectedPersonId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[{ userId: 1, name: 'Alice', rows: [housingGroupRow()] }]}
      />,
    );
    // Household's own Card header still renders (and still offers its own Edit limits toggle)
    // even though its grid is not the one selected -- clicking every "Edit limits" toggle here
    // reaches Alice's own regardless of how many others exist.
    for (const button of getAllByRoleAliceScoped('button', { name: 'Edit limits' })) fireEvent.click(button);
    // Alice's own copy of category id 10 -- untouched by opening the household's above, which is
    // exactly what a separate localStorage key (`budgets:groups:personal:1`) buys.
    expect(getByRoleAliceScoped('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('ruling U5: renders correctly (all closed) when localStorage throws on read', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      const { container, getByRole } = render(
        <BudgetsClient
          month="2026-03"
          currentUserId={1}
          household={[housingGroupRow()]}
          householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
          personal={[]}
        />,
      );
      openEditLimits(container);
      expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('false');
    } finally {
      getItem.mockRestore();
    }
  });

  it('ruling U5: a toggle click does not throw when localStorage.setItem throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      const { container, getByRole } = render(
        <BudgetsClient
          month="2026-03"
          currentUserId={1}
          household={[housingGroupRow()]}
          householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
          personal={[]}
        />,
      );
      openEditLimits(container);
      expect(() => fireEvent.click(getByRole('button', { name: 'Housing' }))).not.toThrow();
      expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('true');
    } finally {
      setItem.mockRestore();
    }
  });

  it('2026-08-30 plan: the card grid\'s own "View breakdown" reads and writes the SAME state as the Edit-limits disclosure', () => {
    const { getByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    // Opened from the default card grid...
    fireEvent.click(getByRole('button', { name: 'View breakdown' }));
    expect(getByRole('button', { name: 'Hide breakdown' })).toBeTruthy();
    // ...switching to Edit limits shows the SAME category already open, not reset closed.
    fireEvent.click(getByRole('button', { name: 'Edit limits' }));
    expect(getByRole('button', { name: 'Housing' }).getAttribute('aria-expanded')).toBe('true');
  });
});

/**
 * v1.21.0 item 2 (owner's screenshot: a parent reading $628.55 over children totalling
 * $183.55, because the direct-to-parent spend counted in the headline but rendered nowhere).
 * These render the card grid (the default mode -- "View breakdown", not Edit limits), since
 * that is where BudgetCategoryCard's breakdown -- and this new row inside it -- lives.
 */
describe('v1.21.0 item 2: a parent\'s own direct spend gets its own row', () => {
  it('renders "Not in a sub-category" with the right amount, only when direct spend is non-zero', () => {
    const row = housingGroupRow();
    // The headline already counts this (foldRollup's seed, src/lib/budgets.ts) -- only the
    // ROW was missing before this fix.
    row.directSpentCents = 30000;
    row.spentCents += 30000;
    const { getByRole, getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 180000, totalSpentCents: 180000 }}
        personal={[]}
      />,
    );
    fireEvent.click(getByRole('button', { name: 'View breakdown' }));
    expect(getByText('Not in a sub-category')).toBeTruthy();
    expect(getByText('$300.00')).toBeTruthy();
  });

  it('renders nothing extra when the parent has no direct spend of its own', () => {
    const { getByRole, queryByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    fireEvent.click(getByRole('button', { name: 'View breakdown' }));
    expect(queryByText('Not in a sub-category')).toBeNull();
  });

  it('the eyebrow reads "N sub-categories", and the direct bucket never counts toward "over"', () => {
    const row = housingGroupRow();
    row.directSpentCents = 30000;
    row.spentCents += 30000;
    const { getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    // Two REAL children (Rent, Utilities); the direct bucket is not one of them and cannot be
    // "over" (it carries no limit), so this must read exactly this, not "3 sub-categories".
    expect(getByText('2 sub-categories · 0 over')).toBeTruthy();
  });
});

describe('v1.18.0 Lane 2 item 4: the parent-limit warning (ruling U6)', () => {
  it('appears with the right amounts when children add up to more than the parent', () => {
    const row = housingGroupRow({ childRent: { baseLimitCents: 150000, limitCents: 150000 }, childUtilities: { baseLimitCents: 90000, limitCents: 90000 } });
    const { container, getByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    // 150000 + 90000 = 240000 ($2,400.00), 40000 ($400.00) over the parent's 200000 ($2,000.00).
    expect(getByText("Children add up to $2,400.00 — $400.00 over Housing's limit.")).toBeTruthy();
  });

  it('shows nothing at all when the children sum under the parent -- a deliberate, ordinary state', () => {
    const { container, queryByText, queryByRole } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[housingGroupRow()]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    expect(queryByText(/Children add up to/)).toBeNull();
    expect(queryByRole('button', { name: /^Raise/ })).toBeNull();
  });

  it('"Raise <parent> to $X" submits the parent\'s limit through the existing auto-save path', async () => {
    const { setLimitAction } = await import('@/app/(app)/budgets/actions');
    vi.mocked(setLimitAction).mockClear();
    const row = housingGroupRow({ childRent: { baseLimitCents: 150000, limitCents: 150000 }, childUtilities: { baseLimitCents: 90000, limitCents: 90000 } });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    fireEvent.click(screen.getByRole('button', { name: 'Raise Housing to $2,400.00' }));
    await waitFor(() => expect(setLimitAction).toHaveBeenCalled());
    const [, formData] = vi.mocked(setLimitAction).mock.calls.at(-1)!;
    expect((formData as FormData).get('scope')).toBe('household');
    expect((formData as FormData).get('categoryId')).toBe('10');
    expect((formData as FormData).get('amount')).toBe('2400.00');
  });

  it('offers no Undo on a fresh page load, and Undo restores the value from before Raise was clicked', async () => {
    const { setLimitAction } = await import('@/app/(app)/budgets/actions');
    vi.mocked(setLimitAction).mockClear();
    const row = housingGroupRow({ childRent: { baseLimitCents: 150000, limitCents: 150000 }, childUtilities: { baseLimitCents: 90000, limitCents: 90000 } });
    const { container } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 200000, budgetedSpentCents: 150000, totalSpentCents: 150000 }}
        personal={[]}
      />,
    );
    openEditLimits(container);
    // Ruling U6: no edit has happened yet this session, so there is nothing to restore.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Raise Housing to $2,400.00' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vi.mocked(setLimitAction)).toHaveBeenCalledTimes(2));
    const [, undoFormData] = vi.mocked(setLimitAction).mock.calls.at(-1)!;
    expect((undoFormData as FormData).get('categoryId')).toBe('10');
    // Housing's own base limit before Raise was clicked (200000 cents = $2,000.00).
    expect((undoFormData as FormData).get('amount')).toBe('2000.00');
  });
});

describe('v1.18.0 Lane 2 item 3: the zero-state header replaces the three-zero sentence', () => {
  it('says what to do instead when nothing is budgeted for the month', () => {
    const row = makeRow({ limitCents: null, baseLimitCents: null, remainingCents: null, pct: null, spentCents: 0 });
    const { getByText, queryByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[row]}
        householdTotals={{ budgetedLimitCents: 0, budgetedSpentCents: 0, totalSpentCents: 0 }}
        personal={[]}
      />,
    );
    expect(getByText('No budgets set for March 2026.')).toBeTruthy();
    expect(getByText('Set a limit on any category below to start tracking it.')).toBeTruthy();
    // The existing Copy previous month BUTTON stays -- the zero state only replaces the title.
    // (PageGuide also mentions the phrase in prose, so this is scoped to the control itself.)
    expect(screen.getByRole('button', { name: 'Copy previous month' })).toBeTruthy();
    expect(queryByText(/spent \$0\.00 of \$0\.00 budgeted/)).toBeNull();
  });

  it('keeps the classic header for a month that has real budgets', () => {
    const { queryByText } = render(
      <BudgetsClient
        month="2026-03"
        currentUserId={1}
        household={[makeRow()]}
        householdTotals={{ budgetedLimitCents: 20000, budgetedSpentCents: 5000, totalSpentCents: 5000 }}
        personal={[]}
      />,
    );
    expect(queryByText(/No budgets set for/)).toBeNull();
  });
});
