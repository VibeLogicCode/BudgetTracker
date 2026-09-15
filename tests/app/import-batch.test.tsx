// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { BatchClient, type BatchRow } from '@/app/(app)/import/batch-client';
import { getBuiltinPreset } from '@/lib/import/presets';

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
  ...over,
});

/** The drop is what starts everything, and jsdom has neither DataTransfer nor FileList. */
function dropFiles(names: string[]): void {
  const files = names.map((name) => new File(['Date,Description,Amount\n'], name, { type: 'text/csv' }));
  fireEvent.drop(screen.getByTestId('file-drop'), { dataTransfer: { files, types: ['Files'] } });
}

function answerDetect(rows: BatchRow[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/api/import/batch/detect')) {
      return { ok: true, json: async () => ({ rows }) } as unknown as Response;
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

  it('names each status on its row', async () => {
    answerDetect([
      row({ filename: 'jan.csv', status: 'ready' }),
      row({ filename: 'old.csv', status: 'already-imported', reason: 'Every one of these 40 rows is already in Joint Visa.' }),
      row({ filename: 'new-bank.csv', status: 'needs-you', reason: 'None of your import profiles could read this file.' }),
      row({ filename: 'scan.pdf', status: 'unsupported', stagingId: null, reason: 'This file could not be read.' }),
    ]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
    expect(screen.getByText('Already imported')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Skipped')).toBeTruthy();
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

  it('shows the files and their rows before writing anything', async () => {
    const fetchMock = answerDetect([row({ filename: 'jan.csv', rowCount: 40 }), row({ filename: 'feb.csv', rowCount: 12 })]);
    render(<BatchClient {...props} />);
    dropFiles(['jan.csv']);
    await waitFor(() => expect(screen.getByText('Import the 2 ready ones')).toBeTruthy());
    fireEvent.click(screen.getByText('Import the 2 ready ones'));
    expect(screen.getByText(/About to import 2 files, 52 rows/)).toBeTruthy();
    // The confirmation is a screen, not a request: still exactly the one detect call so far.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
