// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ImportHistoryCard } from '@/components/ImportHistoryCard';
import type { ImportHistoryRow } from '@/lib/import/commit';

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

    const { getByText } = render(<ImportHistoryCard history={HISTORY} />);

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

    const { getByText } = render(<ImportHistoryCard history={HISTORY} />);

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

    const { getByText, queryByText } = render(<ImportHistoryCard history={HISTORY} />);

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

    const { getByText, queryByText } = render(<ImportHistoryCard history={HISTORY} />);
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

    const { getByText } = render(<ImportHistoryCard history={HISTORY} />);
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
    const { getByRole } = render(<ImportHistoryCard history={HISTORY} />);
    const link = getByRole('link', { name: /view rows/i });
    expect(link.getAttribute('href')).toBe('/transactions?import=77');
  });
});

describe('ImportHistoryCard: responsive rows (v1.15.0, ruling S3)', () => {
  it('the File cell carries cell-stack-headline', () => {
    // Ruling S4 is the other half of this: the PREVIEW grid must never gain cell-stack-headline
    // or go responsive. It cannot, now that the two tables are in different files.
    const { container } = render(<ImportHistoryCard history={HISTORY} />);
    // When: Account: File: By: Added: Dupes: Errors: Undo -- File is the third cell.
    expect(container.querySelector('tbody tr td:nth-child(3)')?.className).toContain('cell-stack-headline');
  });

  // v1.16.0 Lane C item 3: When and Account are context for the row (the file is what tells one
  // import from another), so both carry cell-stack-meta -- a small muted line under the File
  // headline instead of two more labelled rows of their own.
  it('the When and Account cells carry cell-stack-meta', () => {
    const { container } = render(<ImportHistoryCard history={HISTORY} />);
    expect(container.querySelector('tbody tr td:nth-child(1)')?.className).toContain('cell-stack-meta');
    expect(container.querySelector('tbody tr td:nth-child(2)')?.className).toContain('cell-stack-meta');
  });
});
