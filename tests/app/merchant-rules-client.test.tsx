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
