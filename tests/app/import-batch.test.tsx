// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen, within } from '@testing-library/react';
import { BatchClient, type BatchRow } from '@/app/(app)/import/batch-client';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ImportHistoryRow } from '@/lib/import/commit';

// Same reason as tests/app/import-client.test.tsx: opening a row mounts the real ImportClient,
// whose card-assignment and mapping saves go through Next server actions that touch next/headers
// and the DB.
vi.mock('@/app/(app)/import/actions', () => ({
  setCardPersonAction: vi.fn(async () => ({ message: 'Saved.' })),
  saveMappingAction: vi.fn(async () => ({ message: 'Saved.' })),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MAPPING = getBuiltinPreset('TD Chequing/Debit');

const props = {
  accounts: [
    { id: 7, name: 'Joint Visa', importProfileId: 3 },
    { id: 9, name: 'Chequing', importProfileId: 3 },
  ],
  profiles: [{ id: 3, name: 'TD Chequing/Debit', isBuiltin: true, mapping: MAPPING }],
  history: [],
  simplefinManaged: [],
  people: [],
};

const row = (over: Partial<BatchRow> = {}): BatchRow => ({
  status: 'ready',
  filename: 'jan.csv',
  reason: '12 of 40 rows in this file are already in Joint Visa.',
  stagingId: '11111111-1111-4111-8111-111111111111',
  rowCount: 40,
  account: { id: 7, name: 'Joint Visa' },
  accountConfidence: 'certain',
  profile: { id: 3, name: 'TD Chequing/Debit' },
  profileConfidence: 'certain',
  source: 'csv',
  counts: { totalRows: 7, duplicateCount: 6, errorCount: 0, willImport: 1 },
  ...over,
});

/** The drop is what starts everything, and jsdom has neither DataTransfer nor FileList. */
function dropFiles(names: string[]): void {
  const files = names.map((name) => new File(['Date,Description,Amount\n'], name, { type: 'text/csv' }));
  fireEvent.drop(screen.getByTestId('file-drop'), { dataTransfer: { files, types: ['Files'] } });
}

/** What /api/import/preview answers -- only the fields the screen actually renders. */
const PREVIEW = {
  stagingId: '11111111-1111-4111-8111-111111111111',
  filename: 'jan.csv',
  accountId: 7,
  profileId: 3,
  encoding: 'utf-8',
  mapping: MAPPING,
  rows: [
    {
      rowIndex: 0,
      rawDate: '2026-09-10',
      date: '2026-09-10',
      rawDescription: 'DOLLAR TREE',
      normalizedMerchant: 'DOLLAR TREE',
      amountCents: -2769,
      occurrenceIndex: 0,
      dedupHash: 'abc',
      externalId: null,
      isDuplicate: false,
      duplicateTransactionId: null,
      predictedCategoryId: null,
    },
  ],
  errors: [],
  totalRows: 7,
  duplicateCount: 6,
  errorCount: 0,
  skipped: 0,
  truncated: false,
  source: 'csv',
  cardValues: [],
  dateFormatDetection: { status: 'none' },
};

function answerDetect(rows: BatchRow[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/import/batch/detect')) {
      return { ok: true, json: async () => ({ rows }) } as unknown as Response;
    }
    if (String(url).includes('/api/import/preview')) {
      return { ok: true, json: async () => PREVIEW } as unknown as Response;
    }
    if (String(url).includes('/api/import/batch/commit')) {
      return {
        ok: true,
        json: async () => ({
          results: rows
            .filter((entry) => entry.status === 'ready')
            .map((entry) => ({ filename: entry.filename, ok: true, rowsAdded: entry.rowCount, rowsDuplicate: 0 })),
        }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * 2026-09-15. The owner's ask: "throughwing all together lets app handle the process".
 *
 * WHAT THIS FILE DOES NOT COVER: whether a file was classified correctly. Ruling B1 puts that
 * entirely in the detectors, and tests/lib/import/batch.test.ts covers the routing between them
 * and the four statuses. Everything here is about what the SCREEN does with rows it is handed.
 */
describe('BatchClient: the list', () => {
  it('shows a row for every file that was dropped', async () => {
    answerDetect([row({ filename: 'jan.csv' }), row({ filename: 'feb.csv' }), row({ filename: 'mar.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv', 'feb.csv', 'mar.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    expect(screen.getByText('feb.csv')).toBeTruthy();
    expect(screen.getByText('mar.csv')).toBeTruthy();
  });

  it('posts every dropped file in ONE request, which is the point of the feature', async () => {
    const fetchMock = answerDetect([row()]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv', 'feb.csv', 'mar.csv']);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchMock.mock.calls[0]![1].body as FormData;
    expect(body.getAll('files')).toHaveLength(3);
  });

  /**
   * Asserted on the BADGES, not on the page text. The page guide above the list explains what each
   * status means and therefore contains every one of these words -- a getByText finds two of each
   * and fails, which is exactly how this test broke once the guide was added. Reading the badges
   * also asserts something the text search could not: one badge per row, in the row order.
   */
  it('names each status on its row', async () => {
    answerDetect([
      row({ filename: 'jan.csv', status: 'ready' }),
      row({ filename: 'old.csv', status: 'already-imported', reason: 'Every one of these 40 rows is already in Joint Visa.' }),
      row({ filename: 'new-bank.csv', status: 'needs-you', reason: 'None of your import profiles could read this file.' }),
      row({ filename: 'scan.pdf', status: 'unsupported', stagingId: null, reason: 'This file could not be read.' }),
    ]);
    const { container } = render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(container.querySelectorAll('.badge')).toHaveLength(4));
    expect([...container.querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual([
      'Ready',
      'Already imported',
      'Needs you',
      'Skipped',
    ]);
  });

  /**
   * An unsupported row staged nothing, so there is no file behind it to open.
   *
   * The filename here is a .csv on purpose. A .pdf never reaches the server at all -- FileDrop's
   * own partition refuses it in the browser and says so (tests/components/file-drop.test.tsx), so
   * the SERVER's `unsupported` is for files that pass the extension check and then fail: too
   * large, or bytes no reader could make sense of.
   */
  it('leaves a skipped row unopenable', async () => {
    answerDetect([row({ filename: 'huge.csv', status: 'unsupported', stagingId: null, reason: 'This file is larger than 5 MB.' })]);
    render(<BatchClient {...props} />);
    dropFiles(['huge.csv']);
    await waitFor(() => expect(screen.getByText('huge.csv')).toBeTruthy());
    expect(screen.getByText('huge.csv').closest('button')!.disabled).toBe(true);
  });
});

/**
 * The owner's own choice, asked and answered on 2026-09-15: "Likely is enough, but show me first."
 * The group button must not be the thing that writes.
 */
describe('BatchClient: nothing commits without a confirmation', () => {
  it('offers to import only the ready ones, counted', async () => {
    answerDetect([row({ filename: 'jan.csv' }), row({ filename: 'feb.csv' }), row({ filename: 'x.csv', status: 'needs-you' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 2 ready ones')).toBeTruthy());
  });

  /**
   * The headline is what will ARRIVE, not how many rows were read. The owner's screenshots were of
   * six files holding 180 rows between them, 179 of which were already in -- "180 rows" would have
   * been true and useless.
   */
  it('counts what will arrive, not what was read', async () => {
    const fetchMock = answerDetect([
      row({ filename: 'jan.csv', counts: { totalRows: 40, duplicateCount: 36, errorCount: 0, willImport: 4 } }),
      row({ filename: 'feb.csv', counts: { totalRows: 12, duplicateCount: 10, errorCount: 0, willImport: 2 } }),
    ]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 2 ready ones')).toBeTruthy());
    fireEvent.click(screen.getByText('Import the 2 ready ones'));
    expect(screen.getByText(/About to import 6 transactions from 2 files/)).toBeTruthy();
    expect(screen.getByText(/46 of the 52 rows read are already here/)).toBeTruthy();
    // The confirmation is a screen, not a request: still exactly the one detect call so far.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** And the same on the list itself, per file, which is where the owner asked for it. */
  it('says what each file will import, on its own row', async () => {
    answerDetect([row({ filename: 'jan.csv', counts: { totalRows: 7, duplicateCount: 6, errorCount: 0, willImport: 1 } })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText(/7 rows/)).toBeTruthy());
    expect(screen.getByText(/6 already here/)).toBeTruthy();
    expect(screen.getByText('1 to import')).toBeTruthy();
  });

  it('says so plainly when a file would add nothing', async () => {
    answerDetect([
      row({
        filename: 'old.csv',
        status: 'already-imported',
        counts: { totalRows: 19, duplicateCount: 19, errorCount: 0, willImport: 0 },
      }),
    ]);
    render(<BatchClient {...props} />);
    dropFiles(['old.csv']);
    await waitFor(() => expect(screen.getByText('nothing to import')).toBeTruthy());
  });

  it('commits only after the confirmation is accepted', async () => {
    const fetchMock = answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 1 ready one')).toBeTruthy());
    fireEvent.click(screen.getByText('Import the 1 ready one'));
    fireEvent.click(screen.getByText('Yes, import them'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/import/batch/commit');
  });

  it('backs out of the confirmation without writing', async () => {
    const fetchMock = answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 1 ready one')).toBeTruthy());
    fireEvent.click(screen.getByText('Import the 1 ready one'));
    fireEvent.click(screen.getByText('Back'));
    expect(screen.queryByText(/About to import/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports what each file did, and takes the imported ones off the list', async () => {
    answerDetect([row({ filename: 'jan.csv', rowCount: 40 }), row({ filename: 'x.csv', status: 'needs-you' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 1 ready one')).toBeTruthy());
    fireEvent.click(screen.getByText('Import the 1 ready one'));
    fireEvent.click(screen.getByText('Yes, import them'));
    await waitFor(() => expect(screen.getByText(/40 added, 0 already there/)).toBeTruthy());
    // The one that still needs a person stays; the finished one goes.
    expect(screen.getByText('x.csv')).toBeTruthy();
  });
});

describe('BatchClient: opening one row', () => {
  it('mounts the real import wizard on that file, not a second screen of its own', async () => {
    answerDetect([row({ filename: 'new-bank.csv', status: 'needs-you' })]);
    render(<BatchClient {...props} />);
    dropFiles(['new-bank.csv']);
    await waitFor(() => expect(screen.getByText('new-bank.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('new-bank.csv'));
    // The wizard's own PageHeader description, which nothing on the batch screen carries.
    await waitFor(() =>
      expect(screen.getByText(/Upload a statement, check what it found/)).toBeTruthy(),
    );
  });

  it('offers the way back, or looking at one file would cost the other nine', async () => {
    answerDetect([row({ filename: 'jan.csv' }), row({ filename: 'feb.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('jan.csv'));
    await waitFor(() => expect(screen.getByText('← Back to the list')).toBeTruthy());
    fireEvent.click(screen.getByText('← Back to the list'));
    await waitFor(() => expect(screen.getByText('feb.csv')).toBeTruthy());
  });

  /** Seeded from the detection the list already holds, so the row opens mid-flow, not empty. */
  it('opens with the detected account and mapping already chosen', async () => {
    answerDetect([row({ filename: 'jan.csv' })]);
    const { container } = render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('jan.csv'));
    await waitFor(() => expect(screen.getByText('← Back to the list')).toBeTruthy());
    const selects = [...container.querySelectorAll('select')].map((select) => select.value);
    expect(selects).toContain('7');
    expect(selects).toContain('3');
  });
});

/**
 * 2026-09-15, owner report on v1.44.1 with screenshots: "when i click on the row that said ready it
 * took me to old page. it should have view rows option whichi should take me to last screenshot
 * similar to what i used to see."
 *
 * The file was already staged and both pickers were already right -- the row carries the detection
 * -- but opening it only SEEDED that state and then sat on step 1 behind an empty drop zone and a
 * Preview button. Clicking a row is a request to see the rows, so seeing them should not cost a
 * second press of a button that asks for a file already in hand.
 */
describe('BatchClient: opening a row goes straight to the rows', () => {
  it('previews the staged file without waiting to be asked', async () => {
    const fetchMock = answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('batch-list')).getByText('View rows'));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/import/preview'))).toBe(true));
  });

  it('lands on the row table, not on "choose a file"', async () => {
    answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('batch-list')).getByText('View rows'));
    // The preview header and the commit button, both of which only render once rows are in hand.
    await waitFor(() => expect(screen.getByText(/7 rows, 6 duplicates, 0 errors/)).toBeTruthy());
    expect(screen.getByText('Import 1 transactions')).toBeTruthy();
  });

  /** A drop zone asking for a file that is already loaded is the thing that made this confusing. */
  it('names the loaded file instead of offering an empty drop zone', async () => {
    answerDetect([row({ filename: 'jan.csv' })]);
    const { container } = render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('batch-list')).getByText('View rows'));
    await waitFor(() => expect(screen.getByText(/7 rows, 6 duplicates/)).toBeTruthy());
    expect(container.querySelector('[data-testid="file-drop"]')).toBeNull();
  });

  /**
   * A needs-you file is staged just like a ready one -- what it lacks is an account or a mapping,
   * not bytes. So it opens on the same screen, still naming the file, and the way forward is the
   * two pickers rather than a second copy of the file. What must NOT happen is an auto-preview:
   * the preview route refuses an unresolved id, and firing it would put an error on screen before
   * the household has done anything wrong.
   */
  it('opens a needs-you file on its pickers, and previews nothing yet', async () => {
    const fetchMock = answerDetect([
      row({ filename: 'new-bank.csv', status: 'needs-you', account: null, profile: null, stagingId: '22222222-2222-4222-8222-222222222222' }),
    ]);
    const { container } = render(<BatchClient {...props} />);
    dropFiles(['new-bank.csv']);
    await waitFor(() => expect(screen.getByText('new-bank.csv')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('batch-list')).getByText('Set it up'));
    await waitFor(() => expect(screen.getByText(/Upload a statement, check what it found/)).toBeTruthy());
    expect(container.querySelectorAll('select').length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/import/preview'))).toBe(false);
  });
});

/**
 * 2026-09-15, owner report on v1.44.1: "i should also have a history button on new page to take me
 * to page that shows me history of what was imported like in older screenshot."
 *
 * History was a card inside ImportClient, so the moment the batch screen became what the page
 * opens on, it vanished unless you clicked into a file first. Same class of miss as the page guide
 * a release earlier, and the reason both happened is that the landing surface changed and the
 * things bolted to the old one came unstuck.
 */
describe('BatchClient: history is on the landing screen', () => {
  const entry: ImportHistoryRow = {
    id: 12,
    accountId: 7,
    profileId: 3,
    createdAt: '2026-09-15T19:51:00.000Z',
    accountName: 'Joint - CC Amex',
    filename: 'activity.csv',
    importedBy: 1,
    importedByName: 'Jot',
    rowsAdded: 6,
    rowsDuplicate: 109,
    rowsError: 0,
  };

  it('shows past imports before anything has been dropped', () => {
    render(<BatchClient {...props} history={[entry]} />);
    expect(screen.getByText('History')).toBeTruthy();
    expect(screen.getByText('activity.csv')).toBeTruthy();
  });

  it('keeps the undo beside each one', () => {
    render(<BatchClient {...props} history={[entry]} />);
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  it('is still there once a drop has produced a list', async () => {
    answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} history={[entry]} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    expect(screen.getByText('activity.csv')).toBeTruthy();
  });

  /** The wizard keeps its own copy, so opening a file does not lose the list either. */
  it('is still there inside the wizard a row opens', async () => {
    answerDetect([row({ filename: 'jan.csv' })]);
    render(<BatchClient {...props} history={[entry]} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('jan.csv')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('batch-list')).getByText('View rows'));
    await waitFor(() => expect(screen.getByText(/7 rows, 6 duplicates/)).toBeTruthy());
    expect(screen.getByText('activity.csv')).toBeTruthy();
  });
});
