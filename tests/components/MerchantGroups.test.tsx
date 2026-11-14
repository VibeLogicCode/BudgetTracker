// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MerchantGroups } from '@/components/review/MerchantGroups';
import { reviewMerchantGroupAction } from '@/app/(app)/transactions/actions';
import { acceptAiSuggestionAction, ignoreAiSuggestionAction } from '@/app/(app)/transactions/ai-actions';
import type { AiSuggestionView } from '@/lib/ai/types';
import type { MerchantGroupPage, MerchantGroupRow, TransactionRow } from '@/lib/transactions';

vi.mock('@/app/(app)/transactions/actions', () => ({
  reviewMerchantGroupAction: vi.fn(async () => ({})),
}));

// v1.64.0: the AI Use and Ignore buttons post to these.
vi.mock('@/app/(app)/transactions/ai-actions', () => ({
  acceptAiSuggestionAction: vi.fn(async () => ({ message: 'Renamed.' })),
  ignoreAiSuggestionAction: vi.fn(async () => ({ message: 'Ignored. No more AI suggestions for MAPLE GROCER.' })),
}));

afterEach(() => {
  cleanup();
  vi.mocked(reviewMerchantGroupAction).mockClear();
  vi.mocked(acceptAiSuggestionAction).mockClear();
  vi.mocked(ignoreAiSuggestionAction).mockClear();
});

/** v1.62.0 (plan item 1, B6). One card per merchant waiting in Needs review, one decision each. */
const SCOPE = 'review=1&group=merchant';
const CATEGORIES = [
  { id: 42, name: 'Groceries', parentId: null, isArchived: false, sortOrder: 0 },
  { id: 43, name: 'Coffee', parentId: null, isArchived: false, sortOrder: 1 },
  { id: 44, name: 'Old Pantry', parentId: null, isArchived: true, sortOrder: 2 },
];
const PEOPLE = [
  { id: 11, name: 'Alex' },
  { id: 12, name: 'Sam' },
];

function row(over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 903,
    date: '2026-03-14',
    accountId: 1,
    accountName: 'Joint Chequing',
    rawDescription: 'MAPLE GROCER',
    displayDescription: null,
    displaySource: null,
    normalizedMerchant: 'MAPLE GROCER',
    amountCents: -6340,
    categoryId: null,
    categoryName: null,
    source: 'none',
    confidence: null,
    isTransfer: false,
    attributedUserId: null,
    attributedUserName: null,
    notes: null,
    importId: null,
    ...over,
  };
}

function group(over: Partial<MerchantGroupRow> = {}): MerchantGroupRow {
  return {
    merchant: 'MAPLE GROCER',
    displayName: 'MAPLE GROCER',
    count: 3,
    totalCents: -12362,
    firstDate: '2026-03-02',
    lastDate: '2026-03-14',
    guessCategoryId: 42,
    newest: row(),
    preview: [
      { id: 903, date: '2026-03-14', description: 'MAPLE GROCER', amountCents: -6340 },
      { id: 902, date: '2026-03-09', description: 'MAPLE GROCER', amountCents: -1805 },
      { id: 901, date: '2026-03-02', description: 'MAPLE GROCER', amountCents: -4217 },
    ],
    ...over,
  };
}

function page(groups: MerchantGroupRow[], over: Partial<MerchantGroupPage> = {}): MerchantGroupPage {
  return {
    groups,
    page: 1,
    pageSize: 25,
    pageCount: 1,
    groupCount: groups.length,
    totalCount: groups.reduce((sum, g) => sum + g.count, 0),
    ...over,
  };
}

function renderGroups(
  groups: MerchantGroupRow[],
  opts: { actionable?: boolean; onCreateRule?: (row: TransactionRow) => void; over?: Partial<MerchantGroupPage>; aiSuggestions?: Record<string, AiSuggestionView> } = {},
) {
  return render(
    <MerchantGroups
      groupPage={page(groups, opts.over)}
      scope={SCOPE}
      categories={CATEGORIES}
      people={PEOPLE}
      today="2026-03-14"
      actionable={opts.actionable ?? true}
      previousHref={null}
      nextHref={opts.over?.pageCount === 2 ? '/transactions?review=1&group=merchant&gpage=2' : null}
      onCreateRule={opts.onCreateRule ?? vi.fn()}
      aiSuggestions={opts.aiSuggestions}
    />,
  );
}

function card(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('[data-merchant-group]') as HTMLElement;
}

describe('MerchantGroups (v1.62.0)', () => {
  it('states each group count, total and date span, previews its rows and seeds the guess', () => {
    const { container } = renderGroups([group(), group({ merchant: 'FUEL STOP 12', displayName: 'Fuel Stop', count: 2, totalCents: -11630, guessCategoryId: null, firstDate: '2026-03-05', lastDate: '2026-03-05', newest: row({ id: 801, normalizedMerchant: 'FUEL STOP 12' }), preview: [] })]);

    const maple = card('MAPLE GROCER');
    expect(maple.textContent).toContain('3 transactions');
    expect(maple.textContent).toContain('-$123.62');
    expect(maple.textContent).toContain('Mar 2 to Mar 14');
    expect(maple.querySelectorAll('[data-merchant-preview-row]')).toHaveLength(3);
    // The guess opens the picker, and is what File all would post.
    expect((within(maple).getByRole('combobox', { name: 'Category for MAPLE GROCER' }) as HTMLInputElement).value).toBe('Groceries');
    expect((maple.querySelector('input[type="hidden"][name="categoryId"]') as HTMLInputElement).value).toBe('42');

    const fuel = card('Fuel Stop');
    expect(fuel.textContent).toContain('2 transactions');
    expect(fuel.textContent).toContain('Mar 5');
    expect(fuel.textContent).not.toContain(' to ');
    // No guess: the picker opens empty and File all waits for a pick.
    expect((within(fuel).getByRole('button', { name: 'File all 2 (Fuel Stop)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Merchants 1–2 of 2 — 5 transactions in this view');
  });

  it('every decision posts the scope, the merchant and its decision', async () => {
    renderGroups([group()]);
    const maple = card('MAPLE GROCER');
    const submits: [string, string][] = [
      ['File all 3 (MAPLE GROCER)', 'category'],
      ['Set person for all 3 (MAPLE GROCER)', 'person'],
      ['Mark all 3 as transfers (MAPLE GROCER)', 'transfer'],
      ['Mark recurring (MAPLE GROCER)', 'recurring'],
    ];
    for (const [name, decision] of submits) {
      vi.mocked(reviewMerchantGroupAction).mockClear();
      fireEvent.submit(within(maple).getByRole('button', { name }).closest('form') as HTMLFormElement);
      await waitFor(() => expect(reviewMerchantGroupAction).toHaveBeenCalled());
      const posted = vi.mocked(reviewMerchantGroupAction).mock.calls.at(-1)![1] as FormData;
      expect([posted.get('scope'), posted.get('merchant'), posted.get('decision')]).toEqual([SCOPE, 'MAPLE GROCER', decision]);
      if (decision === 'category') {
        expect(posted.get('categoryId')).toBe('42');
        expect(posted.get('createRules')).toBe('on');
      }
    }
  });

  it('Remember is ticked by default and names the merchant', () => {
    renderGroups([group()]);
    const remember = screen.getByRole('checkbox', { name: 'Remember for future MAPLE GROCER rows' }) as HTMLInputElement;
    expect(remember.checked).toBe(true);
  });

  it('offers no archived category, and a guess on one opens the picker empty', () => {
    renderGroups([group({ guessCategoryId: 44 })]);
    const input = screen.getByRole('combobox', { name: 'Category for MAPLE GROCER' }) as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.focus(input);
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toContain('Groceries');
    expect(options.some((text) => (text ?? '').includes('Old Pantry'))).toBe(false);
  });

  it('the no-merchant-name group has no transfer, recurring, Remember or rule button', () => {
    renderGroups([group({ merchant: '', displayName: '', newest: row({ normalizedMerchant: '', rawDescription: '' }) })]);
    const nameless = card('No merchant name');
    expect(within(nameless).getByRole('button', { name: 'File all 3 (No merchant name)' })).toBeTruthy();
    expect(within(nameless).queryByRole('button', { name: /transfers/ })).toBeNull();
    expect(within(nameless).queryByRole('button', { name: /^Mark recurring/ })).toBeNull();
    expect(within(nameless).queryByRole('button', { name: /^Create a rule/ })).toBeNull();
    expect(within(nameless).queryByRole('checkbox')).toBeNull();
  });

  it('Create a rule hands the group newest row to the opener', () => {
    const onCreateRule = vi.fn();
    renderGroups([group()], { onCreateRule });
    fireEvent.click(screen.getByRole('button', { name: 'Create a rule… (MAPLE GROCER)' }));
    expect(onCreateRule).toHaveBeenCalledWith(expect.objectContaining({ id: 903, normalizedMerchant: 'MAPLE GROCER' }));
  });

  it('announces a decision in the list live region, and shows a refusal in its card', async () => {
    vi.mocked(reviewMerchantGroupAction).mockResolvedValueOnce({ message: 'Categorized 3 transactions from MAPLE GROCER as Groceries.' });
    renderGroups([group()]);
    fireEvent.submit(screen.getByRole('button', { name: 'File all 3 (MAPLE GROCER)' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Categorized 3 transactions from MAPLE GROCER as Groceries.'));

    vi.mocked(reviewMerchantGroupAction).mockResolvedValueOnce({ error: 'That group is empty now — nothing was changed.' });
    fireEvent.submit(screen.getByRole('button', { name: 'Mark recurring (MAPLE GROCER)' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(card('MAPLE GROCER').textContent).toContain('That group is empty now — nothing was changed.'));
  });

  it('read-only outside review mode: counts and previews, no decisions', () => {
    renderGroups([group()], { actionable: false });
    expect(card('MAPLE GROCER').textContent).toContain('3 transactions');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('pages by merchant, and an empty queue says so', () => {
    renderGroups([group()], { over: { pageCount: 2, groupCount: 26, totalCount: 60 } });
    expect(screen.getByRole('link', { name: 'Next merchants' }).getAttribute('href')).toContain('gpage=2');
    cleanup();

    renderGroups([]);
    expect(screen.getByText('Nothing to review. Everything is categorized.')).toBeTruthy();
  });
});

/** v1.64.0 (plan lane C4). The group's picker opens on the local AI's category when the categorizer has no guess. */
describe('MerchantGroups with an AI suggestion (v1.64.0)', () => {
  const AI: Record<string, AiSuggestionView> = { 'MAPLE GROCER': { categoryId: 43, categoryLabel: 'Coffee', cleanName: 'Maple Grocer' } };
  const picked = (name: string) => (card(name).querySelector('input[type="hidden"][name="categoryId"]') as HTMLInputElement).value;

  it('seeds the picker from the suggestion with a muted label when there is no guess', () => {
    renderGroups([group({ guessCategoryId: null })], { aiSuggestions: AI });
    const maple = card('MAPLE GROCER');
    expect((within(maple).getByRole('combobox', { name: 'Category for MAPLE GROCER' }) as HTMLInputElement).value).toBe('Coffee');
    expect(picked('MAPLE GROCER')).toBe('43');
    expect(maple.textContent).toContain('AI suggestion');
  });

  it('lets the categorizer guess win over the suggestion', () => {
    renderGroups([group({ guessCategoryId: 42 })], { aiSuggestions: AI });
    expect(picked('MAPLE GROCER')).toBe('42');
    expect(card('MAPLE GROCER').textContent).not.toContain('AI suggestion');
  });

  it('does not seed from an archived suggested category', () => {
    renderGroups([group({ guessCategoryId: null })], { aiSuggestions: { 'MAPLE GROCER': { categoryId: 44, categoryLabel: 'Old Pantry', cleanName: null } } });
    expect(picked('MAPLE GROCER')).toBe('');
  });

  it('offers the name for all, posting the newest row with remember, and Ignore posting the merchant', async () => {
    renderGroups([group({ guessCategoryId: null })], { aiSuggestions: AI });
    const maple = card('MAPLE GROCER');
    fireEvent.submit(within(maple).getByRole('button', { name: 'Use the name Maple Grocer for all (MAPLE GROCER)' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(acceptAiSuggestionAction).toHaveBeenCalledTimes(1));
    const posted = vi.mocked(acceptAiSuggestionAction).mock.calls.at(-1)![1] as FormData;
    expect([posted.get('transactionId'), posted.get('part'), posted.get('remember')]).toEqual(['903', 'name', '1']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Renamed.'));

    fireEvent.submit(within(maple).getByRole('button', { name: 'Ignore the AI suggestion for MAPLE GROCER' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(ignoreAiSuggestionAction).toHaveBeenCalledTimes(1));
    expect((vi.mocked(ignoreAiSuggestionAction).mock.calls.at(-1)![1] as FormData).get('merchant')).toBe('MAPLE GROCER');
  });

  it('shows nothing of the AI without a suggestion or outside review', () => {
    renderGroups([group()], { aiSuggestions: {} });
    expect(card('MAPLE GROCER').querySelector('[data-ai-suggestion]')).toBeNull();
    cleanup();
    renderGroups([group()], { aiSuggestions: AI, actionable: false });
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
