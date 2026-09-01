// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { MerchantRulesClient } from '@/app/(app)/settings/merchant-rules/merchant-rules-client';
import type { CanadianPackState, CanadianPackUpdateDiff } from '@/lib/canadian-pack';
import type { CategoryRecord } from '@/lib/categories';
import type { MerchantRuleRecord, RuleKind } from '@/lib/categorize/rules';

vi.mock('@/app/(app)/settings/merchant-rules/actions', () => ({
  saveRuleAction: vi.fn(async () => ({})),
  deleteRuleAction: vi.fn(async () => ({})),
  deleteRuleAndClearAction: vi.fn(async () => ({})),
  bulkDeleteRulesAction: vi.fn(async () => ({})),
  bulkSetDisabledAction: vi.fn(async () => ({})),
  setRuleDisabledAction: vi.fn(async () => ({})),
  applyRuleNowAction: vi.fn(async () => ({})),
  rerunAllAction: vi.fn(async () => ({})),
  previewRerunAllAction: vi.fn(async () => ({ eligible: 10, wouldChange: 4 })),
  previewRuleClearAction: vi.fn(async () => ({ affected: 41, kind: 'category' as const })),
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

function updateDiffFixture(over: Partial<CanadianPackUpdateDiff> = {}): CanadianPackUpdateDiff {
  return {
    fromVersion: 1,
    toVersion: 2,
    added: [],
    changed: [],
    removed: [],
    skippedEdited: [],
    unchangedCount: 180,
    ...over,
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
});

/**
 * Owner ask (2026-08-31): this confirm moved from a plain bordered div under the toolbar to a
 * RowDialog (see that component's own docblock, and merchant-rules-client.tsx's bulkDeleteDialog
 * docblock, for why: page-level, a multi-row selection rather than one row to keep looking at,
 * and a real consequence to read first). The shell RowDialog itself owes every caller -- role,
 * aria-modal, Escape, backdrop, focus trap, focus-restore-to-trigger -- is asserted once, in full,
 * against the split editor in transactions-client.test.tsx (its first caller); this block only
 * pins THIS dialog's own content: the disclaimer wording is unchanged from the pre-dialog version.
 */
describe('MerchantRulesClient — bulk delete confirm (RowDialog, item 10)', () => {
  it('opens a labelled dialog naming how many rules it will delete', () => {
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ id: 1 }), rule({ id: 2, pattern: 'WENDYS' })] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule WENDYS' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(screen.getByRole('dialog', { name: /delete 2 rules/i })).toBeTruthy();
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

  it('cancelling the bulk delete confirm submits nothing and closes the dialog', async () => {
    const { bulkDeleteRulesAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps({ rows: [rule({ id: 1 })] })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select rule TIM HORTONS' }));
    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
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

/**
 * v1.24.0 (owner ask, 2026-09-01: "when we click re-run it should open a dialogue... blurred popup
 * with proper disclaimer"). The preview-then-confirm behaviour item 11 built is unchanged; it moved
 * from an inline strip into a RowDialog and gained the all-time/date-range choice. See
 * RunRulesDialog's own docblock in merchant-rules-client.tsx (and the retired carve-out in
 * RowDialog.tsx) for why the earlier "this one stays inline" reasoning was reversed.
 */
describe('MerchantRulesClient — Run rules now (dialog 4, RowDialog, v1.24.0)', () => {
  it('opens a labelled dialog stating the preview counts, and a Cancel that never submits', async () => {
    const { rerunAllAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run rules' }));
    const dialog = screen.getByRole('dialog', { name: /run rules now\?/i });
    // The eligible/wouldChange numbers render split across <strong> tags (real UI, not a test
    // artifact), so a single getByText regex cannot span them -- check the dialog's whole
    // rendered text instead of one of its child nodes.
    await screen.findByText(/would actually change/);
    const text = dialog.textContent ?? '';
    expect(text).toMatch(/look at\s*10\s*transaction/);
    expect(text).toMatch(/about\s*4\s*would actually change/);
    // The disclosure has to match ELIGIBLE, not flatter it: a hand-categorized row, a split row
    // and a row a rule already settled are all skipped.
    expect(text).toMatch(/categorized by hand, split into parts, or that a rule has already settled/);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rerunAllAction).not.toHaveBeenCalled();
  });

  it('defaults to All time and reveals two date inputs when Date range is chosen', async () => {
    const { previewRerunAllAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run rules' }));
    expect((screen.getByRole('radio', { name: 'All time' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('From')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }));
    expect(screen.getByLabelText('From')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    // The count is re-previewed for the narrowed range, not left showing the all-time figure.
    await screen.findByText(/would actually change/);
    expect(previewRerunAllAction).toHaveBeenCalledWith('2026-01-01', '2026-03-31');
  });

  it('refuses a backwards range in the dialog rather than after submitting', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-run rules' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-31' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-01' } });
    expect(screen.getByRole('alert').textContent).toMatch(/ends before it starts/);
    expect((screen.getByRole('button', { name: 'Run rules' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * v1.24.0, dialogs 1-3. The owner's report was that deleting a rule left the transactions it had
 * already changed exactly as the rule made them, with nothing on screen saying so ("user deletes
 * the rule but nothing gets fixed"). The fix is two menu items and three dialogs whose copy is
 * kind-true: a category/transfer clear genuinely cannot be undone (nothing records the previous
 * category), while a rename revert genuinely can be described as restoring the bank's own text.
 * The shell RowDialog owes every caller -- role, aria-modal, Escape, backdrop, focus trap,
 * focus-restore -- is asserted once, in full, against the split editor in
 * transactions-client.test.tsx; these tests pin THIS content.
 */
describe('MerchantRulesClient — Delete this rule? (dialog 1, v1.24.0)', () => {
  it('replaces the window.confirm with a dialog saying what a plain delete does NOT change', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    const dialog = screen.getByRole('dialog', { name: /delete this rule\?/i });
    expect(dialog.textContent).toMatch(/cannot be undone/i);
    expect(dialog.textContent).toMatch(/Transactions it already changed keep what it gave them/);
  });

  it('cancelling submits nothing and closes', async () => {
    const { deleteRuleAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteRuleAction).not.toHaveBeenCalled();
  });

  it('a not-a-transfer override also warns that the card-payment patterns can re-flag the merchant', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'not_transfer', categoryId: null })],
          kindCounts: { category: 0, transfer: 0, rename: 0, not_transfer: 1 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/card-payment patterns can flag that merchant as a transfer again/);
  });

  it('never offers the clear option for a not-a-transfer rule -- clearing it would re-flag money as transfers', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'not_transfer', categoryId: null })],
          kindCounts: { category: 0, transfer: 0, rename: 0, not_transfer: 1 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /clear from transactions/i })).toBeNull();
  });
});

describe('MerchantRulesClient — Delete rule and clear it from transactions (dialog 2, v1.24.0)', () => {
  it('states the server-side count, the no-undo warning and that other rules are not re-run', async () => {
    render(<MerchantRulesClient {...baseProps()} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: /clear from transactions/i }));
    expect(screen.getByRole('dialog', { name: /delete rule and clear it from transactions\?/i })).toBeTruthy();
    await screen.findByText(/41 transactions were categorized by this rule/);
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/This cannot be undone/);
    expect(text).toMatch(/returns them to Needs review/);
    expect(text).toMatch(/is not recorded and cannot be brought back/);
    expect(text).toMatch(/Other rules are not re-run/);
  });

  it('re-previews the count against a chosen date range', async () => {
    const { previewRuleClearAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    vi.mocked(previewRuleClearAction).mockResolvedValue({ affected: 7, kind: 'category' as const });
    render(<MerchantRulesClient {...baseProps()} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: /clear from transactions/i }));
    fireEvent.click(screen.getByRole('radio', { name: 'Date range' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-02-01' } });
    await screen.findByText(/7 transactions were categorized by this rule/);
    expect(previewRuleClearAction).toHaveBeenCalledWith(1, '2026-02-01', null);
  });

  it('a transfer rule says the flag is being cleared, never a category', async () => {
    const { previewRuleClearAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    vi.mocked(previewRuleClearAction).mockResolvedValue({ affected: 3, kind: 'transfer' as const });
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'transfer', categoryId: null })],
          kindCounts: { category: 0, transfer: 1, rename: 0, not_transfer: 0 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: /clear from transactions/i }));
    await screen.findByText(/3 transactions are flagged as a transfer by this rule/);
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/Clearing removes the transfer flag/);
    expect(text).not.toMatch(/removes their category/);
  });

  it('cancelling mutates nothing', async () => {
    const { deleteRuleAndClearAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: /clear from transactions/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteRuleAndClearAction).not.toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — Delete rule and restore original descriptions (dialog 3, v1.24.0)', () => {
  it('promises the bank text back, states the count, and offers NO date range', async () => {
    const { previewRuleClearAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    vi.mocked(previewRuleClearAction).mockResolvedValue({ affected: 128, kind: 'rename' as const });
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" })],
          kindCounts: { category: 0, transfer: 0, rename: 1, not_transfer: 0 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    expect(screen.getByRole('dialog', { name: /delete rule and restore original descriptions\?/i })).toBeTruthy();
    await screen.findByText(/128 of them/);
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/go back to the text from your bank/);
    expect(text).toMatch(/No date range/);
    // A rename revert is genuinely reversible in fact, so it must NOT borrow the other kinds'
    // "this cannot be undone" warning about the transactions -- only deleting the rule is final.
    expect(text).toMatch(/Deleting the rule cannot be undone/);
    expect(screen.queryByRole('radio', { name: 'Date range' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete and restore' })).toBeTruthy();
  });

  it('a rename rule offers ONE delete item, since deleting it already reverts its rows', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" })],
          kindCounts: { category: 0, transfer: 0, rename: 1, not_transfer: 0 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    expect(screen.queryByRole('menuitem', { name: /clear from transactions/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete rule' })).toBeTruthy();
  });

  it('cancelling mutates nothing', async () => {
    const { deleteRuleAndClearAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(
      <MerchantRulesClient
        {...baseProps({
          rows: [rule({ ruleKind: 'rename', categoryId: null, renameTo: "McDonald's" })],
          kindCounts: { category: 0, transfer: 0, rename: 1, not_transfer: 0 },
        })}
      />,
    );
    openRowMenu('Actions for TIM HORTONS');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete rule' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteRuleAndClearAction).not.toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — sharing a rules pack still lives on this page (moved off Managers)', () => {
  it('renders the pack panel', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    expect(screen.getByText(/share rules with another install/i)).toBeTruthy();
  });
});

/**
 * Owner ask (2026-08-31): the Canadian pack panel's three confirmations (install, remove-all,
 * review-update) moved from inline disclosures to RowDialog -- see canadian-pack-panel.tsx's own
 * docblock, and RowDialog's, for why. The shell RowDialog owes every caller (role, aria-modal,
 * Escape, backdrop, focus trap, focus-restore) is asserted once, in full, against the split editor
 * in transactions-client.test.tsx (its first caller) -- these three blocks only pin each dialog's
 * own CONTENT: the disclaimer wording, the remove-consequence count and the update diff are every
 * one carried over unchanged from the v1.23.0 inline version, so these assertions are the same
 * substance that version's own text was, just read out of a dialog now instead of a bordered div.
 */
describe('MerchantRulesClient — Canadian pack panel: persistent status line stays outside any dialog', () => {
  it('renders "not installed" as plain page content, with no dialog open', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/not installed/)).toBeTruthy();
  });

  it('renders the installed/version/count line as plain page content too', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          canadianPack: { installed: true, installedVersion: 1, bundledVersion: 1, updateAvailable: false, presentCount: 182, totalCount: 190 },
        })}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/installed, v1 · 182 of 190 present/)).toBeTruthy();
  });
});

describe('MerchantRulesClient — Canadian pack panel: install confirmation (RowDialog)', () => {
  it('Install opens a labelled dialog carrying the write count, the FORTIS/ATCO caveat and the removable-afterward note', () => {
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: /install the canadian merchant pack/i });
    expect(dialog.textContent).toMatch(/writes\s*190\s*rules out of 190 in the pack/);
    expect(dialog.textContent).toMatch(/174 categorizations, 16 merchant-name/);
    expect(dialog.textContent).toContain('FORTIS');
    expect(dialog.textContent).toContain('ATCO');
    expect(dialog.textContent).toMatch(/removable afterward with the Remove all button/);
  });

  it('reports how many already-present patterns are left untouched, only when there are any', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          canadianInstallPreview: { totalRules: 190, categoryRules: 174, renameRules: 16, wouldWrite: 185, alreadyPresent: 5 },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(screen.getByText(/5 patterns you already have will be left exactly as they are/)).toBeTruthy();
  });

  it('Cancel closes the install dialog and calls nothing', async () => {
    const { installCanadianPackAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(installCanadianPackAction).not.toHaveBeenCalled();
  });

  it('Install now submits the install action', async () => {
    const { installCanadianPackAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install now' }));
    expect(installCanadianPackAction).toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — Canadian pack panel: remove confirmation (RowDialog)', () => {
  const installedState: CanadianPackState = {
    installed: true,
    installedVersion: 1,
    bundledVersion: 1,
    updateAvailable: false,
    presentCount: 190,
    totalCount: 190,
  };

  it('Remove all opens a labelled dialog stating the rule count and the transaction-revert consequence', () => {
    render(
      <MerchantRulesClient
        {...baseProps({ canadianPack: installedState, canadianRemovalPreview: { ruleCount: 190, transactionsRevert: 12 } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    const dialog = screen.getByRole('dialog', { name: /remove the canadian merchant pack/i });
    expect(dialog.textContent).toMatch(/Remove 190 preset rules\?/);
    expect(dialog.textContent).toMatch(/12 transactions using a preset rename will revert to the bank's wording/);
    expect(dialog.textContent).toMatch(/A rule you edited since installing is not touched/);
  });

  it('says the removal cannot be undone when no rename rule would revert anything', () => {
    render(
      <MerchantRulesClient
        {...baseProps({ canadianPack: installedState, canadianRemovalPreview: { ruleCount: 190, transactionsRevert: 0 } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(screen.getByText(/this cannot be undone/i)).toBeTruthy();
  });

  it('Cancel closes it without calling the remove action', async () => {
    const { removeCanadianPackAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(
      <MerchantRulesClient
        {...baseProps({ canadianPack: installedState, canadianRemovalPreview: { ruleCount: 190, transactionsRevert: 0 } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(removeCanadianPackAction).not.toHaveBeenCalled();
  });

  it('Remove permanently submits the remove action', async () => {
    const { removeCanadianPackAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(
      <MerchantRulesClient
        {...baseProps({ canadianPack: installedState, canadianRemovalPreview: { ruleCount: 190, transactionsRevert: 0 } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove permanently' }));
    expect(removeCanadianPackAction).toHaveBeenCalled();
  });
});

describe('MerchantRulesClient — Canadian pack panel: update review (RowDialog)', () => {
  const updateAvailableState: CanadianPackState = {
    installed: true,
    installedVersion: 1,
    bundledVersion: 2,
    updateAvailable: true,
    presentCount: 190,
    totalCount: 190,
  };

  it('Update opens a labelled dialog naming the target version, keeping the "What vX changes" heading and every section of the diff', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          canadianPack: updateAvailableState,
          canadianUpdateDiff: updateDiffFixture({
            added: [{ pattern: 'PETRO CANADA', matchType: 'contains', ruleKind: 'category', categoryLabel: 'Gas', renameTo: null }],
            changed: [{ pattern: 'ESSO', matchType: 'contains', ruleKind: 'rename', before: 'Esso', after: 'ESSO Gas Station' }],
            removed: [{ pattern: 'OLDCO', matchType: 'exact', ruleKind: 'category', categoryLabel: 'Misc', renameTo: null }],
            skippedEdited: [{ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryLabel: 'Coffee', renameTo: null }],
            unchangedCount: 175,
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const dialog = screen.getByRole('dialog', { name: /update the canadian merchant pack to v2/i });
    expect(dialog.textContent).toMatch(/What v2 changes \(currently v1\)/);
    expect(dialog.textContent).toMatch(/1 added:/);
    expect(dialog.textContent).toContain('PETRO CANADA');
    expect(dialog.textContent).toMatch(/1 changed:/);
    expect(dialog.textContent).toContain('ESSO: Esso → ESSO Gas Station');
    expect(dialog.textContent).toMatch(/1 no longer in the pack:/);
    expect(dialog.textContent).toContain('OLDCO');
    expect(dialog.textContent).toMatch(/1 rule left alone/);
    expect(dialog.textContent).toContain('TIM HORTONS');
    expect(dialog.textContent).toMatch(/175 rules unchanged/);
  });

  it('the "also delete" checkbox appears only when something was removed, and toggles', () => {
    render(
      <MerchantRulesClient
        {...baseProps({
          canadianPack: updateAvailableState,
          canadianUpdateDiff: updateDiffFixture({
            removed: [{ pattern: 'OLDCO', matchType: 'exact', ruleKind: 'category', categoryLabel: 'Misc', renameTo: null }],
          }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const checkbox = screen.getByRole('checkbox', { name: /also delete the 1 rule no longer in the pack/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('the checkbox is absent when nothing was removed', () => {
    render(<MerchantRulesClient {...baseProps({ canadianPack: updateAvailableState, canadianUpdateDiff: updateDiffFixture() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(screen.queryByRole('checkbox', { name: /also delete/i })).toBeNull();
  });

  it('Cancel closes it without applying the update', async () => {
    const { applyCanadianPackUpdateAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps({ canadianPack: updateAvailableState, canadianUpdateDiff: updateDiffFixture() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applyCanadianPackUpdateAction).not.toHaveBeenCalled();
  });

  it('Apply update submits the update action, its label naming the target version', async () => {
    const { applyCanadianPackUpdateAction } = await import('@/app/(app)/settings/merchant-rules/actions');
    render(<MerchantRulesClient {...baseProps({ canadianPack: updateAvailableState, canadianUpdateDiff: updateDiffFixture() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply update to v2' }));
    expect(applyCanadianPackUpdateAction).toHaveBeenCalled();
  });
});
