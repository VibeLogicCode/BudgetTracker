// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImportHistoryCard } from '@/components/ImportHistoryCard';
import type { ImportHistoryRow } from '@/lib/import/commit';

const loadMore = vi.fn();
vi.mock('@/app/(app)/import/actions', () => ({
  loadImportHistoryAction: (...args: unknown[]) => loadMore(...args),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HISTORY: ImportHistoryRow[] = [
  {
    id: 77,
    accountId: 10,
    accountName: 'Joint Chequing',
    profileId: 1,
    filename: 'march.csv',
    importedBy: 1,
    importedByName: 'Alice',
    rowsAdded: 12,
    rowsDuplicate: 0,
    rowsError: 0,
    createdAt: '2026-03-10T09:00:00.000Z',
  },
];

/**
 * 2026-09-15. These three tests MOVED here, unchanged in substance, from
 * tests/app/import-client.test.tsx when the History card was extracted out of that component. They
 * were always about undo rather than about the import wizard -- they only lived there because the
 * card did.
 *
 * Undo is the one control on this page that deletes transactions, which is why it gets a
 * busy-guard test of its own and why the summary is asserted down to the balance-figure clause:
 * v1.12.1 shipped a fix for `snapshotsDeleted` being computed, documented as "reported", and never
 * actually shown.
 */
describe('ImportHistoryCard: the undo button is busy-guarded', () => {
  it('disables Undo while the lookup request is in flight', async () => {
    const pending: { release?: (value: unknown) => void } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.release = resolve;
          }),
      ),
    );

    const { getByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);

    const undo = getByText('Undo') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    // A second click here used to fire the whole delete sequence again.
    await waitFor(() => expect(undo.disabled).toBe(true));

    pending.release?.({ ok: false, json: async () => ({ error: 'nope' }) });
    await waitFor(() => expect(undo.disabled).toBe(false));
  });
});

describe('ImportHistoryCard: undo reports every table it touched (item AE / MON-5 follow-up)', () => {
  it('appends the balance-figure count to the undo summary when snapshots were removed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // lookup call
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }))
        // confirmed undo call
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ deleted: 3, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 2 }),
        })),
    );

    const { getByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);

    fireEvent.click(getByText('Undo'));

    await waitFor(() => expect(getByText(/Undo complete/)).toBeTruthy());
    expect(getByText(/3 deleted, 1 kept, and 2 balance figures removed\./)).toBeTruthy();
  });

  it('says nothing extra when no snapshot was removed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ deleted: 3, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 0 }),
        })),
    );

    const { getByText, queryByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);

    fireEvent.click(getByText('Undo'));

    await waitFor(() => expect(getByText(/Undo complete: 3 deleted, 1 kept\./)).toBeTruthy());
    expect(queryByText(/balance figure/)).toBeNull();
  });

  it('takes the undone import off the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }))
        .mockImplementationOnce(async () => ({
          ok: true,
          json: async () => ({ deleted: 3, kept: 1, loanLinksReversed: 0, snapshotsDeleted: 0 }),
        })),
    );

    const { getByText, queryByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    fireEvent.click(getByText('Undo'));
    await waitFor(() => expect(queryByText('march.csv')).toBeNull());
  });

  /** A refused confirm is a decision, and it must leave the import exactly where it was. */
  it('deletes nothing when the confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 77, willDelete: 3, willKeep: 1 }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { getByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    fireEvent.click(getByText('Undo'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getByText('march.csv')).toBeTruthy();
  });
});

/**
 * Both blocks below MOVED from tests/app/import-client.test.tsx with the card itself. They assert
 * the table's own markup, which is what they always did -- they named ImportClient only because
 * that is where the table used to live.
 */
describe('ImportHistoryCard: F-03, the "View rows" link', () => {
  it('links each row to exactly its own import, with no date or person filter riding along', () => {
    const { getByRole } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    const link = getByRole('link', { name: /view rows/i });
    expect(link.getAttribute('href')).toBe('/transactions?import=77');
  });
});

describe('ImportHistoryCard: responsive rows (v1.15.0, ruling S3)', () => {
  it('the File cell carries cell-stack-headline', () => {
    // Ruling S4 is the other half of this: the PREVIEW grid must never gain cell-stack-headline
    // or go responsive. It cannot, now that the two tables are in different files.
    const { container } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    // When: Account: File: By: Added: Dupes: Errors: Undo -- File is the third cell.
    expect(container.querySelector('tbody tr td:nth-child(3)')?.className).toContain('cell-stack-headline');
  });

  // v1.16.0 Lane C item 3: When and Account are context for the row (the file is what tells one
  // import from another), so both carry cell-stack-meta -- a small muted line under the File
  // headline instead of two more labelled rows of their own.
  it('the When and Account cells carry cell-stack-meta', () => {
    const { container } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    expect(container.querySelector('tbody tr td:nth-child(1)')?.className).toContain('cell-stack-meta');
    expect(container.querySelector('tbody tr td:nth-child(2)')?.className).toContain('cell-stack-meta');
  });
});

describe('ImportHistoryCard: the When cell is in the household time zone', () => {
  const EVENING: ImportHistoryRow[] = [{ ...HISTORY[0], createdAt: '2026-03-10T03:30:00.000Z' }];
  const whenOf = (container: HTMLElement): string | null =>
    container.querySelector('td[data-label="When"]')?.textContent ?? null;

  it('reads the household date and time', () => {
    const { container } = render(<ImportHistoryCard history={EVENING} tz="America/Toronto" />);
    expect(whenOf(container)).toBe('2026-03-09 23:30');
  });

  it('follows the zone it is given', () => {
    const { container } = render(<ImportHistoryCard history={EVENING} tz="UTC" />);
    expect(whenOf(container)).toBe('2026-03-10 03:30');
  });
});

function historyRow(id: number, over: Partial<ImportHistoryRow> = {}): ImportHistoryRow {
  return {
    id,
    accountId: 10,
    accountName: 'Joint Chequing',
    profileId: 1,
    filename: `statement-${id}.csv`,
    importedBy: 1,
    importedByName: 'Alice',
    rowsAdded: 4,
    rowsDuplicate: 0,
    rowsError: 0,
    createdAt: '2026-03-10T09:00:00.000Z',
    ...over,
  };
}

// v1.60.0 item 3b: history pages and quiet bank syncs fold.
describe('ImportHistoryCard: Show more', () => {
  it('appends the next page, with Undo working on a loaded row, and drops the button at the end', async () => {
    loadMore.mockResolvedValueOnce({ rows: [historyRow(4), historyRow(3)], hasMore: false });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ importId: 3, willDelete: 4, willKeep: 0 }) }))
        .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ deleted: 4, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 0 }) })),
    );
    const { getByText, queryByText, getAllByText } = render(
      <ImportHistoryCard history={[historyRow(6), historyRow(5)]} hasMore tz="America/Toronto" />,
    );

    fireEvent.click(getByText('Show more'));
    await waitFor(() => expect(getByText('statement-3.csv')).toBeTruthy());
    expect(loadMore).toHaveBeenCalledWith(5);
    expect(getByText('statement-6.csv')).toBeTruthy();
    expect(queryByText('Show more')).toBeNull();

    // Undo on the row Show more brought in (the fourth Undo button, in newest-first order).
    fireEvent.click(getAllByText('Undo')[3]);
    await waitFor(() => expect(queryByText('statement-3.csv')).toBeNull());
    expect(getByText('statement-4.csv')).toBeTruthy();
  });

  /** Fix round: the wait is announced to a screen reader, then the live region empties. */
  it('announces "Loading…" in a live region while the next page is on its way', async () => {
    let release: (value: unknown) => void = () => {};
    loadMore.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { getByText, getByRole } = render(<ImportHistoryCard history={[historyRow(6), historyRow(5)]} hasMore tz="America/Toronto" />);

    const status = getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    fireEvent.click(getByText('Show more'));
    await waitFor(() => expect(getByRole('status').textContent).toBe('Loading…'));
    release({ rows: [historyRow(4)], hasMore: true });
    await waitFor(() => expect(getByText('statement-4.csv')).toBeTruthy());
    expect(getByRole('status').textContent).toBe('');
  });

  it('offers no button when there is nothing older', () => {
    const { queryByText } = render(<ImportHistoryCard history={[historyRow(1)]} tz="America/Toronto" />);
    expect(queryByText('Show more')).toBeNull();
  });
});

describe('ImportHistoryCard: quiet bank syncs fold into one line', () => {
  const quiet = (id: number, at: string) =>
    historyRow(id, { filename: `simplefin 2026-03-10 ${at}`, rowsAdded: 0, createdAt: `2026-03-10T${at}:00.000Z` });

  it('folds a run of syncs that added nothing, and opens it on request', () => {
    const rows = [quiet(9, '15:00'), quiet(8, '14:00'), quiet(7, '13:00'), historyRow(6)];
    const { getByText, queryByText, getByRole } = render(<ImportHistoryCard history={rows} tz="America/Toronto" />);

    expect(getByText('3 bank syncs with nothing new')).toBeTruthy();
    expect(queryByText('simplefin 2026-03-10 14:00')).toBeNull();
    expect(getByText('statement-6.csv')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: '3 bank syncs with nothing new' }));
    expect(getByText('simplefin 2026-03-10 14:00')).toBeTruthy();
  });

  /** Fix round: the folded line is a cell like any other on a phone, so it carries a label. */
  it('labels the folded line for the stacked phone layout', () => {
    const rows = [quiet(9, '15:00'), quiet(8, '14:00')];
    const { getByRole } = render(<ImportHistoryCard history={rows} tz="America/Toronto" />);
    const cell = getByRole('button', { name: '2 bank syncs with nothing new' }).closest('td');
    expect(cell?.getAttribute('data-label')).toBe('Bank syncs');
  });

  /** Fix round: a sync that added nothing but hit row errors is news, so it never folds away. */
  it('keeps a sync with row errors in sight, outside the fold', () => {
    const rows = [
      quiet(9, '15:00'),
      historyRow(8, { filename: 'simplefin 2026-03-10 14:00', rowsAdded: 0, rowsError: 2, createdAt: '2026-03-10T14:00:00.000Z' }),
      quiet(7, '13:00'),
    ];
    const { getByText, queryByText } = render(<ImportHistoryCard history={rows} tz="America/Toronto" />);

    expect(queryByText(/bank syncs with nothing new/)).toBeNull();
    expect(getByText('simplefin 2026-03-10 14:00')).toBeTruthy();
  });

  it('keeps a sync that added rows, a lone quiet sync and CSV rows as ordinary rows', () => {
    const rows = [
      quiet(9, '15:00'),
      historyRow(8, { filename: 'simplefin 2026-03-10 14:00', rowsAdded: 3 }),
      quiet(7, '13:00'),
      historyRow(6, { rowsAdded: 0 }),
    ];
    const { getByText, queryByText } = render(<ImportHistoryCard history={rows} tz="America/Toronto" />);

    expect(queryByText(/bank syncs with nothing new/)).toBeNull();
    expect(getByText('simplefin 2026-03-10 15:00')).toBeTruthy();
    expect(getByText('simplefin 2026-03-10 14:00')).toBeTruthy();
    expect(getByText('simplefin 2026-03-10 13:00')).toBeTruthy();
    expect(getByText('statement-6.csv')).toBeTruthy();
  });
});

describe('ImportHistoryCard: the undo confirm lists what else goes', () => {
  async function confirmTextFor(preview: Record<string, unknown>): Promise<string> {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => ({ ok: true, json: async () => preview })));
    const { getByText } = render(<ImportHistoryCard history={HISTORY} tz="America/Toronto" />);
    fireEvent.click(getByText('Undo'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    return String(confirm.mock.calls[0][0]);
  }

  it('names each non-zero count on its own line and leaves the zero ones out', async () => {
    const text = await confirmTextFor({
      importId: 77,
      willDelete: 3,
      willKeep: 1,
      alsoRemoved: {
        splitRows: 2,
        notedRows: 0,
        manualCategories: 1,
        renamedRows: 0,
        itemLinks: 0,
        loanPayments: 1,
        installments: 0,
        snapshots: 4,
      },
    });
    expect(text).toContain('Will delete 3 transactions.');
    expect(text).toContain('- 2 transactions with split parts');
    expect(text).toContain('- 1 transaction with a category set by hand');
    expect(text).toContain('- 1 loan payment reversed');
    expect(text).toContain('- 4 balance figures removed');
    expect(text).not.toMatch(/note|renamed|purchase link|installment/);
  });

  it('names the possible duplicates the import left waiting (v1.61.0)', async () => {
    const text = await confirmTextFor({
      importId: 77,
      willDelete: 3,
      willKeep: 0,
      alsoRemoved: { splitRows: 0, notedRows: 0, manualCategories: 0, renamedRows: 0, itemLinks: 0, loanPayments: 0, installments: 0, snapshots: 0, heldRows: 2 },
    });
    expect(text).toContain('- 2 possible duplicates waiting in Needs review removed');
  });

  it('adds nothing when every count is zero', async () => {
    const text = await confirmTextFor({
      importId: 77,
      willDelete: 3,
      willKeep: 1,
      alsoRemoved: { splitRows: 0, notedRows: 0, manualCategories: 0, renamedRows: 0, itemLinks: 0, loanPayments: 0, installments: 0, snapshots: 0 },
    });
    expect(text).not.toContain('also changes');
  });
});
