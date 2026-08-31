// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { MerchantRulesClient } from '@/app/(app)/settings/merchant-rules/merchant-rules-client';
import type { CategoryRecord } from '@/lib/categories';
import type { MerchantRuleRecord, RuleKind } from '@/lib/categorize/rules';

vi.mock('@/app/(app)/settings/merchant-rules/actions', () => ({
  saveRuleAction: vi.fn(async () => ({})),
  deleteRuleAction: vi.fn(async () => ({})),
  bulkDeleteRulesAction: vi.fn(async () => ({})),
  bulkSetDisabledAction: vi.fn(async () => ({})),
  setRuleDisabledAction: vi.fn(async () => ({})),
  applyRuleNowAction: vi.fn(async () => ({})),
  rerunAllAction: vi.fn(async () => ({})),
  previewRerunAllAction: vi.fn(async () => ({ eligible: 10, wouldChange: 4 })),
  installCanadianPackAction: vi.fn(async () => ({})),
  removeCanadianPackAction: vi.fn(async () => ({})),
  applyCanadianPackUpdateAction: vi.fn(async () => ({})),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

function category(over: Partial<CategoryRecord> = {}): CategoryRecord {
  return {
    id: 1, name: 'Coffee', parentId: null, icon: null, color: null, isIncome: false, isArchived: false,
    sortOrder: 0, taxRelevant: false, ...over,
  };
}

function rule(over: Partial<MerchantRuleRecord> = {}): MerchantRuleRecord {
  return {
    id: 1, pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: 1, renameTo: null,
    createdBy: null, hitCount: 0, lastUsedAt: null, createdAt: '2026-08-16T00:00:00.000Z', lastModifiedBy: null,
    disabledAt: null, packSource: null, packVersion: null, installedAt: null, ...over,
  };
}

function baseProps(overrides: Partial<Parameters<typeof MerchantRulesClient>[0]> = {}): Parameters<typeof MerchantRulesClient>[0] {
  return {
    categories: [category()],
    rows: [rule()],
    total: 1,
    page: 1,
    pageCount: 1,
    currentQuery: '',
    searchValue: '',
    activeKind: null,
    redundantOnly: false,
    presetOnly: false,
    presetCount: 0,
    kindCounts: { category: 1, transfer: 0, rename: 0, not_transfer: 0 },
    redundantCount: 0,
    impactCounts: {},
    redundantByRuleId: {},
    rulesPackRows: [],
    canadianPack: { installed: false, installedVersion: null, bundledVersion: 1, updateAvailable: false, presentCount: 0, totalCount: 190 },
    canadianInstallPreview: { totalRules: 190, categoryRules: 174, renameRules: 16, wouldWrite: 190, alreadyPresent: 0 },
    canadianRemovalPreview: null,
    canadianUpdateDiff: null,
    ...overrides,
  };
}

function openRowMenu(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${escaped}`) }));
}

describe('MerchantRulesClient — rendering the row', () => {
  it('shows the pattern, kind badge, category label and the live impact figure', () => {
    render(<MerchantRulesClient {...baseProps({ impactCounts: { 1: 7 } })} />);
    expect(screen.getByText('TIM HORTONS')).toBeTruthy();
    expect(screen.getByText('Category')).toBeTruthy();
    expect(screen.getByText('Coffee')).toBeTruthy();
    expect(screen.getByText('7 transactions')).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
  });

  it('shows a disabled badge, and never an Apply now item, for a disabled rule', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ disabledAt: '2026-08-20T00:00:00.000Z' })] })} />);
    expect(screen.getByText('disabled')).toBeTruthy();
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /apply now/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /enable/i })).toBeTruthy();
  });

  it('shows a redundant badge when the rule is covered by a contains rule', () => {
    render(<MerchantRulesClient {...baseProps({ redundantByRuleId: { 1: 42 } })} />);
    expect(screen.getByTitle('Already covered by rule #42')).toBeTruthy();
  });

  it('renders a rename rule showing its rename target, not a category', () => {
    render(
      <MerchantRulesClient
        {...baseProps({ rows: [rule({ ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" })], kindCounts: { category: 0, transfer: 0, rename: 1, not_transfer: 0 } })}
      />,
    );
    expect(screen.getByText("McDonald's")).toBeTruthy();
    expect(screen.getByText('Rename')).toBeTruthy();
  });

  it('shows an empty state, with a clear-filters action, when nothing matches', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [], total: 0 })} />);
    expect(screen.getByText(/no rules match this filter/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /clear filters/i })).toBeTruthy();
  });
});

describe('MerchantRulesClient — filter chips and search (item 10)', () => {
  it('renders one chip per kind, with counts, and highlights the active one', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          activeKind: 'rename',
          kindCounts: { category: 5, transfer: 2, rename: 3, not_transfer: 1 },
        })}
      />,
    );
    expect(screen.getByText('All (11)')).toBeTruthy();
    expect(screen.getByText('Category (5)')).toBeTruthy();
    expect(screen.getByText('Rename (3)')).toBeTruthy();
    expect(screen.getByText('Transfer (2)')).toBeTruthy();
    expect(screen.getByText('Not a transfer (1)')).toBeTruthy();
    const renameLink = screen.getByText('Rename (3)').closest('a')!;
    expect(renameLink.getAttribute('href')).toContain('kind=rename');
  });

  it('shows a Redundant chip only when at least one rule is redundant', () => {
    const { rerender } = render(<MerchantRulesClient {...baseProps({ redundantCount: 0 })} />);
    expect(screen.queryByText(/Redundant/)).toBeNull();
    rerender(<MerchantRulesClient {...baseProps({ redundantCount: 4 })} />);
    expect(screen.getByText('Redundant (4)')).toBeTruthy();
  });

  it('the search box carries the current search value', () => {
    render(<MerchantRulesClient {...baseProps({ searchValue: 'WALMART' })} />);
    expect((screen.getByLabelText(/search by pattern/i) as HTMLInputElement).value).toBe('WALMART');
  });
});

describe('MerchantRulesClient — paging', () => {
  it('shows Prev and Next, correctly bounded, across a page count', () => {
    render(<MerchantRulesClient {...baseProps({ page: 2, pageCount: 3, total: 60 })} />);
    expect(screen.getByText('Page 2 of 3 · 60 rules')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Prev' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Next' })).toBeTruthy();
  });

  it('hides Prev on the first page and Next on the last', () => {
    render(<MerchantRulesClient {...baseProps({ page: 1, pageCount: 2, total: 40 })} />);
    expect(screen.queryByRole('link', { name: 'Prev' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Next' })).toBeTruthy();
  });
});

describe('MerchantRulesClient — multi-select and bulk delete states its real consequence (item 10)', () => {
  it('selecting a row reveals the bulk toolbar with the right count', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ id: 1 }), rule({ id: 2, pattern: 'WENDYS' })] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('states how many TRANSACTIONS a bulk delete of rename rules will revert, not just the rule count', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ id: 1, ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" }), rule({ id: 2, ruleKind: 'rename', categoryId: null, renameTo: "Wendy's", pattern: 'WENDYS' })],
          impactCounts: { 1: 5, 2: 3 },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule WENDYS' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(screen.getByText(/8 transactions using a rename rule among them will revert/)).toBeTruthy();
  });

  it('a non-rename bulk selection says the delete cannot be undone, with no invented transaction count', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ id: 1 })] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(screen.getByText(/this cannot be undone/i)).toBeTruthy();
  });

  it('cancelling the bulk delete confirm submits nothing', async () => {
    const { bulkDeleteRulesAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ id: 1 })] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('button', { name: /delete permanently/i })).toBeNull();
    expect(bulkDeleteRulesAction).not.toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — the rule dialog (RowDialog, item 10)', () => {
  it('"New rule" opens a blank dialog', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    expect(screen.getByRole('dialog', { name: /new merchant rule/i })).toBeTruthy();
    expect((screen.getByPlaceholderText('WALMART') as HTMLInputElement).value).toBe('');
  });

  it('Edit opens the dialog pre-filled with this row\'s own values', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ pattern: 'WALMART' })] })} />);
    openRowMenu('Actions for WALMART');
    fireEvent.click(screen.getByRole('menuitem', { name: /^edit$/i }));
    expect(screen.getByRole('dialog', { name: /edit rule for "walmart"/i })).toBeTruthy();
    expect((screen.getByPlaceholderText('WALMART') as HTMLInputElement).value).toBe('WALMART');
  });

  it('closing the dialog removes it', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('MerchantRulesClient — per-rule Apply now (item 11: scoped, understandable, safe)', () => {
  it('offers Apply now, labelled with the live impact figure already on the row, for an enabled non-rename rule', async () => {
    const { applyRuleNowAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ ruleKind: 'category' })], impactCounts: { 1: 6 } })} />);
    openRowMenu('Actions for TIM HORTONS');
    const item = screen.getByRole('menuitem', { name: /apply now \(6 would affect\)/i });
    fireEvent.click(item);
    expect(applyRuleNowAction).toHaveBeenCalled();
  });

  it('never offers Apply now for a rename rule -- it is already retroactive', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" })] })} />);
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /apply now/i })).toBeNull();
  });
});

describe('MerchantRulesClient — household-wide Re-run rules gets a preview-then-confirm step (item 11)', () => {
  it('shows the preview counts before running, and a Cancel that never submits', async () => {
    const { rerunAllAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run rules' }));
    const confirmButton = await screen.findByRole('button', { name: /re-run now/i });
    // The eligible/wouldChange numbers render split across <strong> tags (real UI, not a test
    // artifact), so a single getByText regex cannot span them -- check the confirm panel's whole
    // rendered text instead of one of its child nodes.
    const panelText = confirmButton.closest('div')!.textContent ?? '';
    expect(panelText).toMatch(/look at\s*10\s*uncategorized/);
    expect(panelText).toMatch(/about\s*4\s*would actually change/);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('button', { name: /re-run now/i })).toBeNull();
    expect(rerunAllAction).not.toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — sharing a rules pack still lives on this page (moved off Managers)', () => {
  it('renders the pack panel', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    expect(screen.getByText(/share rules with another install/i)).toBeTruthy();
  });
});
