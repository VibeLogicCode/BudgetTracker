// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  POLL_INTERVAL_MS,
  READING_MESSAGE,
  ReceiptUploader,
  SCAN_SUMMARY_NOTHING,
  summaryOf,
} from '@/components/warranty/ReceiptUploader';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stageResponse(overrides: Partial<{ stagingId: string; originalFilename: string; mime: string }> = {}) {
  return {
    ok: true,
    json: async () => ({
      staged: [
        {
          stagingId: 's1',
          originalFilename: 'receipt.jpg',
          mime: 'image/jpeg',
          sizeBytes: 12345,
          sha256: 'a'.repeat(64),
          ...overrides,
        },
      ],
    }),
  } as Response;
}

describe('ReceiptUploader', () => {
  beforeEach(() => {
    // jsdom does not implement these; the component calls them directly (no server-side
    // image processing anywhere in this feature -- §16.2 -- so this is the browser's own API).
    (URL as unknown as { createObjectURL: (file: File) => string }).createObjectURL = vi.fn(() => 'blob:mock-preview');
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = vi.fn();
  });

  it(
    'still previews an image receipt after the input is cleared (CRITICAL 1 regression: ' +
      'the FileList captured at change-time must be snapshotted before event.target.value ' +
      'is reset, since browsers clear the live FileList in place rather than swapping it)',
    async () => {
      const onStagedChange = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(stageResponse());
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<ReceiptUploader onStagedChange={onStagedChange} />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['fake-jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

      fireEvent.change(input, { target: { files: [file] } });
      // The onChange handler resets the input's value synchronously, right after kicking
      // off upload() -- this is the exact sequence that reproduced the bug.
      expect(input.value).toBe('');

      const img = await screen.findByAltText('receipt.jpg');
      expect(img.getAttribute('src')).toBe('blob:mock-preview');

      // The staged array reaching the parent form must carry the real file, not an entry
      // whose previewUrl silently came back null/undefined because createObjectURL threw.
      //
      // waitFor, not a bare assertion on the last call: findByAltText above resolves when the
      // IMAGE renders, which happens from local preview state -- a DIFFERENT async continuation
      // from the one that calls onStagedChange with the staged entry, since that one waits on
      // the mocked fetch to resolve and commit. On a fast machine both land in the same batch
      // and a bare assertion passes; on a slower or differently-scheduled runner the assertion
      // wins the race and sees the earlier empty-array call instead. That is exactly how this
      // failed once on CI and passed on a re-run of the SAME commit (v1.8.1, 2026-08-23) --
      // awaiting a proxy for the condition rather than the condition itself.
      await waitFor(() => {
        const lastCall = onStagedChange.mock.calls.at(-1)?.[0];
        expect(lastCall).toHaveLength(1);
        expect(lastCall[0]).toMatchObject({ stagingId: 's1', previewUrl: 'blob:mock-preview' });
      });
    },
  );

  it('does not preview a PDF (no createObjectURL call, just a placeholder tile)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      stageResponse({ originalFilename: 'manual.pdf', mime: 'application/pdf' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByText('manual.pdf');
    expect(screen.getByText('PDF')).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('marks a receipt failed and surfaces a message when a poll response is not ok (IMPORTANT 3, e.g. a 401 on session expiry)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse())
      .mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['fake-jpeg-bytes'], 'receipt.jpg', { type: 'image/jpeg' });

    fireEvent.change(input, { target: { files: [file] } });
    // Let the (fake-timer-independent) stage upload's promise chain settle.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1500);
    // The poll's fetch fires inside the advance above, but the setFiles/setNotice
    // re-render it triggers only commits on the next microtask flush -- one more
    // (zero-duration) advance lets that pending render land before the assertions below.
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText('Could not read')).toBeTruthy();
    expect(screen.getByText('That receipt could not be read.')).toBeTruthy();
  });

  /** Picks one PDF, lets the stage upload settle, then runs the first poll tick. */
  async function pickAndPoll(container: HTMLElement, fetchMock: ReturnType<typeof vi.fn>) {
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'bill.pdf', { type: 'application/pdf' })] },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('shows what was read under the tile and offers the figures as chips', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse({ originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'done',
          suggestions: { vendor: 'RIVERSIDE WATER', priceCents: 31244 },
          lines: ['RIVERSIDE WATER', 'Amount due $312.44'],
          candidates: {
            amounts: [
              { valueCents: 31244, snippet: 'Amount due $312.44', score: 4 },
              { valueCents: 32806, snippet: 'Amount due after due date $328.06', score: 1 },
            ],
            dates: [{ date: '2026-11-24', snippet: 'Due date 2026-11-24', score: 4 }],
          },
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const onPickAmount = vi.fn();
    const onPickDate = vi.fn();
    const { container } = render(
      <ReceiptUploader
        onStagedChange={vi.fn()}
        onSuggestions={() => ['vendor', 'amount']}
        onPickAmount={onPickAmount}
        onPickDate={onPickDate}
      />,
    );

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText('Filled vendor, amount.')).toBeTruthy();
    fireEvent.click(screen.getByText('What was read'));
    // Scoped to the read text's own panel: the chips carry the same words.
    expect(within(screen.getByText('What was read').closest('details')!).getByText('Amount due $312.44')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /\$328\.06/ }));
    expect(onPickAmount).toHaveBeenCalledWith(32806);
    fireEvent.click(screen.getByRole('button', { name: /Nov 24, 2026/ }));
    expect(onPickDate).toHaveBeenCalledWith('2026-11-24');
  });

  it('offers no chip a tap could not use', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse({ originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'done',
          suggestions: {},
          lines: ['MAPLE GROCERY CO.'],
          candidates: { amounts: [{ valueCents: 1299, snippet: 'Subtotal 12.99', score: 1 }], dates: [] },
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText(SCAN_SUMMARY_NOTHING)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /\$12\.99/ })).toBeNull();
  });

  /** A finished read whose figures a page did not take (a detail page fills nothing) claims no fill. */
  function doneRead() {
    return vi
      .fn()
      .mockResolvedValueOnce(stageResponse({ originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'done',
          suggestions: { vendor: 'RIVERSIDE WATER', dueDate: '2026-11-24', priceCents: 31244 },
          lines: ['RIVERSIDE WATER', 'Due date 2026-11-24', 'Amount due $312.44'],
          candidates: { amounts: [], dates: [] },
        }),
      } as Response);
  }

  it('says nothing was filled on a page that takes no suggestions, and still shows what was read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = doneRead();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.queryByText(/Filled/)).toBeNull();
    expect(screen.getByText('What was read')).toBeTruthy();
  });

  it('names only the fields the page filled, not every one the read found', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = doneRead();
    vi.stubGlobal('fetch', fetchMock);
    // A bill's detail page: it has an amount and a due date to fill, and no vendor.
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} onSuggestions={() => ['date', 'amount']} />);

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText('Filled date, amount.')).toBeTruthy();
  });

  it('claims no fill when the page took nothing it was offered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = doneRead();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} onSuggestions={() => undefined} />);

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.queryByText(/Filled/)).toBeNull();
  });

  it('says when nothing could be filled, and offers Try again on a failed read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse({ originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'failed',
          error: 'No text was found on this image. Try a flatter, closer photo, or attach the PDF.',
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);

    await pickAndPoll(container, fetchMock);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText(/No text was found on this image/)).toBeTruthy();
  });

  it('Try again stages the same file again in place of the failed tile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stageResponse({ stagingId: 's1', originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed', error: 'OCR failed.' }) } as Response)
      .mockResolvedValueOnce(stageResponse({ stagingId: 's2', originalFilename: 'bill.pdf', mime: 'application/pdf' }))
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'pending' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    await pickAndPoll(container, fetchMock);
    const first = (fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0];

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[2][1].body as FormData).getAll('file')[0]).toBe(first);
    await vi.waitFor(() => expect(screen.getByText('Reading…')).toBeTruthy());
    expect(screen.queryByText('Could not read')).toBeNull();
    expect(screen.getAllByText('bill.pdf')).toHaveLength(1);
  });

  /** Review focus 5: the first receipt to finish used to clear the shared notice for all of them. */
  it('keeps the notice while another receipt is still reading', async () => {
    // One staged entry per POST, as the component uploads one file per request.
    let stagedSoFar = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/stage')) {
        stagedSoFar += 1;
        const id = `s${stagedSoFar}`;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            staged: [{ stagingId: id, originalFilename: `${id}.pdf`, mime: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64) }],
          }),
        } as Response);
      }
      if (url.endsWith('/s1')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'done', suggestions: { vendor: 'A' }, lines: ['A'], candidates: { amounts: [], dates: [] } }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ status: 'pending' }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' }), new File(['y'], 'b.pdf', { type: 'application/pdf' })] },
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    // s1 is done, s2 is still pending: the reading notice stays.
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Reading…')).toBeTruthy();
    expect(screen.getByText(READING_MESSAGE)).toBeTruthy();
  });

  /*
    The done tile leads with what the page used and folds the other figures away. One bill gave
    eleven stacked rows when every candidate was a chip with its words under it.
  */
  describe('a done tile leads with what was used', () => {
    const BILL_AMOUNTS = [
      { valueCents: 31244, snippet: 'Amount due $312.44', score: 4 },
      { valueCents: 31296, snippet: 'Total current charges $312.96', score: 4 },
      { valueCents: 17189, snippet: 'Sewer charges 171.89', score: 1 },
      { valueCents: 14107, snippet: 'Water charges 141.07', score: 1 },
      { valueCents: 32806, snippet: 'Amount due after due date $328.06', score: 1 },
      { valueCents: 124976, snippet: 'Paid, thank you -1,249.76', score: -2 },
    ];
    const BILL_DATES = [
      { date: '2026-11-24', snippet: 'Due date 2026-11-24', score: 3 },
      { date: '2026-11-06', snippet: 'Statement date 2026-11-06', score: 1 },
      { date: '2026-08-04', snippet: 'Billing period 2026-08-04 to 2026-11-03', score: 0 },
      { date: '2026-11-03', snippet: 'Billing period 2026-08-04 to 2026-11-03', score: 0 },
      { date: '2026-11-07', snippet: 'Printed 2026-11-07', score: 0 },
    ];

    /** The poll's answer for the invented bill: six amounts and five dates by default. */
    function billBody(candidates: { amounts?: unknown[]; dates?: unknown[] } = {}) {
      return {
        status: 'done',
        suggestions: { vendor: 'RIVERSIDE WATER', purchaseDate: '2026-11-06', priceCents: 31244, dueDate: '2026-11-24' },
        lines: ['RIVERSIDE WATER', 'Statement date 2026-11-06', 'Amount due $312.44', 'Due date 2026-11-24'],
        candidates: { amounts: candidates.amounts ?? BILL_AMOUNTS, dates: candidates.dates ?? BILL_DATES },
      };
    }

    function billRead(candidates: { amounts?: unknown[]; dates?: unknown[] } = {}) {
      return vi
        .fn()
        .mockResolvedValueOnce(stageResponse({ originalFilename: 'bill.pdf', mime: 'application/pdf' }))
        .mockResolvedValue({ ok: true, json: async () => billBody(candidates) } as Response);
    }

    type Props = Partial<ComponentProps<typeof ReceiptUploader>>;

    /** A bill's page by default: both pick handlers, and its fields hold the amount due and the due date. */
    function billElement(props: Props, handlers: { onPickAmount: () => void; onPickDate: () => void }) {
      return (
        <ReceiptUploader
          onStagedChange={vi.fn()}
          onSuggestions={() => ['vendor', 'amount', 'date']}
          onPickAmount={handlers.onPickAmount}
          onPickDate={handlers.onPickDate}
          dateField="dueDate"
          inUse={{ amountCents: 31244, date: '2026-11-24' }}
          {...props}
        />
      );
    }

    async function renderBill(props: Props = {}, read = billRead()) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal('fetch', read);
      const handlers = { onPickAmount: vi.fn(), onPickDate: vi.fn() };
      const view = render(billElement(props, handlers));
      await pickAndPoll(view.container, read);
      return { ...view, ...handlers, rerenderWith: (more: Props) => view.rerender(billElement({ ...props, ...more }, handlers)) };
    }

    /** The rows in use, as their field name, value and words. */
    function rowsInUse(scope: HTMLElement) {
      return [...scope.querySelectorAll('dt')].map((dt) => {
        const dd = dt.nextElementSibling as HTMLElement;
        const words = dd.querySelector('.truncate');
        return { field: dt.textContent, value: dd.firstElementChild?.textContent, words: words?.textContent ?? null };
      });
    }

    /** What a sighted person reads on a chip: no screen-reader text, no decoration. */
    function visibleText(element: HTMLElement): string {
      const copy = element.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll('.sr-only, [aria-hidden="true"]')) hidden.remove();
      return (copy.textContent ?? '').trim();
    }

    const chipsIn = (row: string) => within(screen.getByRole('group', { name: row })).getAllByRole('button');
    const pressed = (row: string) => chipsIn(row).map((chip) => chip.getAttribute('aria-pressed'));

    it('shows at most two rows in use and counts the rest under Other figures', async () => {
      const { container } = await renderBill();

      expect(rowsInUse(container).map((row) => row.field)).toEqual(['Amount', 'Due']);
      // Five amounts and four dates are not in use.
      expect(screen.getByText('Other figures (9)')).toBeTruthy();
      // The summary line is as it was.
      expect(screen.getByText('Filled vendor, date, amount.')).toBeTruthy();
    });

    it('lays the other figures out as value-only chips, side by side in labelled rows', async () => {
      await renderBill();

      const amounts = screen.getByRole('group', { name: 'Amounts' });
      const dates = screen.getByRole('group', { name: 'Dates' });
      for (const row of [amounts, dates]) {
        expect(row.classList.contains('flex')).toBe(true);
        expect(row.classList.contains('flex-wrap')).toBe(true);
        for (const chip of within(row).getAllByRole('button')) expect(chip.parentElement).toBe(row);
      }
      expect(chipsIn('Amounts').map(visibleText)).toEqual(['$312.44', '$312.96', '$171.89', '$141.07', '$328.06', '$1,249.76']);
      // Every date on this bill is in one year, so the chips leave it off.
      expect(chipsIn('Dates').map(visibleText)).toEqual(['Nov 24', 'Nov 6', 'Aug 4', 'Nov 3', 'Nov 7']);
      // The name starts with what the chip shows (label in name) and carries the words; so does the title.
      const statement = within(dates).getByRole('button', { name: 'Nov 6, 2026, Statement date 2026-11-06' });
      expect(statement.getAttribute('title')).toBe('Nov 6, 2026, Statement date 2026-11-06');
      const charges = within(amounts).getByRole('button', { name: '$312.96, Total current charges $312.96' });
      expect(charges.getAttribute('title')).toBe('$312.96, Total current charges $312.96');
    });

    it('shows the year on every date chip when the dates span two years', async () => {
      await renderBill(
        {},
        billRead({
          dates: [
            { date: '2027-01-05', snippet: 'Due date 2027-01-05', score: 3 },
            { date: '2026-12-08', snippet: 'Statement date 2026-12-08', score: 1 },
          ],
        }),
      );

      expect(chipsIn('Dates').map(visibleText)).toEqual(['Jan 5, 2027', 'Dec 8, 2026']);
    });

    it('presses the figure the field holds, and marks it with a check', async () => {
      await renderBill();

      expect(pressed('Amounts')).toEqual(['true', 'false', 'false', 'false', 'false', 'false']);
      expect(pressed('Dates')).toEqual(['true', 'false', 'false', 'false', 'false']);
      const [used, other] = chipsIn('Amounts');
      expect(used.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(other.querySelector('svg')).toBeNull();
    });

    it('a tap calls the handler, and the pressed chip waits for the field to change', async () => {
      const { onPickAmount, onPickDate } = await renderBill();

      fireEvent.click(screen.getByRole('button', { name: /^\$328\.06,/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Nov 6, 2026,/ }));

      expect(onPickAmount).toHaveBeenCalledWith(32806);
      expect(onPickDate).toHaveBeenCalledWith('2026-11-06');
      // Nothing here changed the fields, so what they hold is still the one in use.
      expect(pressed('Amounts')[0]).toBe('true');
      expect(pressed('Dates')[0]).toBe('true');
    });

    it('moves the row and the pressed chip to whatever the fields hold now', async () => {
      const { container, rerenderWith } = await renderBill();

      rerenderWith({ inUse: { amountCents: 32806, date: '2026-11-06' } });

      expect(pressed('Amounts')).toEqual(['false', 'false', 'false', 'false', 'true', 'false']);
      expect(pressed('Dates')).toEqual(['false', 'true', 'false', 'false', 'false']);
      expect(rowsInUse(container)).toEqual([
        { field: 'Amount', value: '$328.06', words: 'Amount due after due date' },
        { field: 'Due', value: 'Nov 6, 2026', words: 'Statement date' },
      ]);
      expect(screen.getByText('Other figures (9)')).toBeTruthy();
    });

    it('shows no row for a field holding a figure the read did not find, or nothing at all', async () => {
      const { container, rerenderWith } = await renderBill();

      // Typed by hand.
      rerenderWith({ inUse: { amountCents: 9000, date: '2026-11-30' } });
      expect(rowsInUse(container)).toEqual([]);
      expect(pressed('Amounts')).not.toContain('true');
      expect(pressed('Dates')).not.toContain('true');
      expect(screen.getByText('Other figures (11)')).toBeTruthy();

      // Emptied, as the detail page does once an installment is added.
      rerenderWith({ inUse: {} });
      expect(rowsInUse(container)).toEqual([]);
      rerenderWith({ inUse: undefined });
      expect(rowsInUse(container)).toEqual([]);
    });

    it('collapses figures of one value into one chip, with the better-scored words', async () => {
      const { container } = await renderBill(
        {},
        billRead({
          amounts: [
            { valueCents: 31244, snippet: 'Previous balance 312.44', score: 0 },
            { valueCents: 31244, snippet: 'Amount due $312.44', score: 4 },
            { valueCents: 32806, snippet: 'Amount due after due date $328.06', score: 1 },
          ],
        }),
      );

      expect(chipsIn('Amounts').map(visibleText)).toEqual(['$312.44', '$328.06']);
      const amounts = screen.getByRole('group', { name: 'Amounts' });
      expect(within(amounts).getByRole('button', { name: '$312.44, Amount due $312.44' })).toBeTruthy();
      expect(rowsInUse(container)[0]).toEqual({ field: 'Amount', value: '$312.44', words: 'Amount due' });
      // One amount and four dates are not in use.
      expect(screen.getByText('Other figures (5)')).toBeTruthy();
    });

    it('shows neither block when the page passed no pick handlers', async () => {
      const { container } = await renderBill({ onPickAmount: undefined, onPickDate: undefined });

      expect(screen.getByText('Read')).toBeTruthy();
      expect(rowsInUse(container)).toEqual([]);
      expect(screen.queryByText(/Other figures/)).toBeNull();
      expect(screen.queryByRole('button', { name: /\$312\.96/ })).toBeNull();
    });

    it('shows only the amount when the page takes no date', async () => {
      const { container } = await renderBill({ onPickDate: undefined });

      expect(rowsInUse(container).map((row) => row.field)).toEqual(['Amount']);
      expect(screen.getByText('Other figures (5)')).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Amounts' })).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Dates' })).toBeNull();
    });

    it('names the figure in use by its words, on one cut line with the whole snippet in its title', async () => {
      const { container } = await renderBill();

      const words = container.querySelector('dd .truncate')!;
      expect(words.textContent).toBe('Amount due');
      expect(words.classList.contains('min-w-0')).toBe(true);
      expect(words.getAttribute('title')).toBe('Amount due $312.44');
    });

    it('shows no words when the snippet is only the figure', async () => {
      const { container } = await renderBill({}, billRead({ amounts: [{ valueCents: 31244, snippet: '$312.44', score: 4 }] }));

      expect(rowsInUse(container)[0]).toEqual({ field: 'Amount', value: '$312.44', words: null });
    });

    it("calls a bill's date row Due, and any other page's Date, from the prop it has now", async () => {
      const { container, rerenderWith } = await renderBill();
      expect(rowsInUse(container)[1]).toEqual({ field: 'Due', value: 'Nov 24, 2026', words: 'Due date' });

      // The add page's kind moved away from a bill: its date chips now fill the start date.
      rerenderWith({ dateField: 'purchaseDate', inUse: { amountCents: 31244, date: '2026-11-06' } });
      expect(rowsInUse(container)[1]).toEqual({ field: 'Date', value: 'Nov 6, 2026', words: 'Statement date' });

      // No dateField reads as the start date.
      rerenderWith({ dateField: undefined });
      expect(rowsInUse(container)[1]?.field).toBe('Date');
    });

    it('puts What was read after Other figures', async () => {
      const { container } = await renderBill();

      expect([...container.querySelectorAll('summary')].map((summary) => summary.textContent)).toEqual([
        'Other figures (9)',
        'What was read',
      ]);
    });
  });

  /** The two native controls: the camera one first, as the tests above take it. */
  function cameraAndPlain(): { camera: HTMLInputElement; plain: HTMLInputElement } {
    return {
      camera: screen.getByLabelText('Take a photo') as HTMLInputElement,
      plain: screen.getByLabelText('Choose a file') as HTMLInputElement,
    };
  }

  it('names both inputs for a screen reader, the camera one first', () => {
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    const { camera, plain } = cameraAndPlain();
    expect(camera).toBe(inputs[0]);
    expect(plain).toBe(inputs[1]);
    expect(camera.type).toBe('file');
    expect(plain.type).toBe('file');
  });

  it('keeps the camera input exactly as MUST-6.1 fixes it, and a second one without capture for a PDF', () => {
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const { camera, plain } = cameraAndPlain();
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.getAttribute('accept')).toBe('image/*,application/pdf');
    expect(plain.hasAttribute('capture')).toBe(false);
    expect(plain.getAttribute('accept')).toBe('image/*,application/pdf');
    expect(plain.multiple).toBe(true);
  });

  it('shows the camera button on a coarse pointer only, and never hides the input on its own', () => {
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const { camera } = cameraAndPlain();
    const button = camera.closest('label')!;
    expect(button.classList.contains('hidden')).toBe(true);
    expect(button.classList.contains('pointer-coarse:inline-flex')).toBe(true);
    // A touch-only button: the app's 44px phone floor.
    expect(button.classList.contains('min-h-11')).toBe(true);
    expect(button.classList.contains('sm:min-h-0')).toBe(true);
    expect(camera.classList.contains('sr-only')).toBe(true);
    expect(camera.classList.contains('hidden')).toBe(false);
    expect(camera.hidden).toBe(false);
  });

  it('always shows the file button, styled as a secondary button', () => {
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const { plain } = cameraAndPlain();
    const button = plain.closest('label')!;
    expect(button.classList.contains('btn')).toBe(true);
    expect(button.classList.contains('btn--secondary')).toBe(true);
    expect(button.classList.contains('min-h-11')).toBe(true);
    expect(button.classList.contains('sm:min-h-0')).toBe(true);
    for (const element of [plain, button]) {
      expect(element.classList.contains('hidden')).toBe(false);
      expect([...element.classList].some((name) => name.startsWith('pointer-'))).toBe(false);
    }
    expect(plain.classList.contains('sr-only')).toBe(true);
  });

  it.each([
    ['Take a photo', 'scan.pdf'],
    ['Choose a file', 'manual.pdf'],
  ])('stages what %s is given', async (name, filename) => {
    const fetchMock = vi.fn().mockResolvedValue(stageResponse({ originalFilename: filename, mime: 'application/pdf' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const pdf = new File(['%PDF-1.4'], filename, { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(name), { target: { files: [pdf] } });
    await screen.findByText(filename);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/warranties/receipts/stage');
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(pdf);
  });

  it('disables both inputs while an upload is in flight, and the buttons show it and the focus ring', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const { camera, plain } = cameraAndPlain();
    fireEvent.change(plain, { target: { files: [new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(plain.disabled).toBe(true));
    expect(camera.disabled).toBe(true);
    for (const input of [camera, plain]) {
      const button = input.closest('label')!;
      for (const name of [
        'has-[:disabled]:pointer-events-none',
        'has-[:disabled]:opacity-55',
        'has-[:focus-visible]:outline-2',
        'has-[:focus-visible]:outline-offset-2',
        'has-[:focus-visible]:outline-focus',
      ]) {
        expect(button.classList.contains(name)).toBe(true);
      }
    }
  });

  it('captions the two buttons with the label, or with the default one', () => {
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Receipt photo or PDF' })).toBeTruthy();
    cleanup();
    render(<ReceiptUploader onStagedChange={vi.fn()} label="Add another receipt" />);
    const group = screen.getByRole('group', { name: 'Add another receipt' });
    expect(within(group).getByLabelText('Take a photo')).toBeTruthy();
    expect(within(group).getByLabelText('Choose a file')).toBeTruthy();
  });
});

describe('summaryOf', () => {
  it('names what was filled, and says when no total was found', () => {
    expect(
      summaryOf({ vendor: 'MAPLE GROCERY CO.', purchaseDate: '2026-09-12', priceCents: 1299 }, ['vendor', 'date', 'amount']),
    ).toBe('Filled vendor, date, amount.');
    expect(summaryOf({ dueDate: '2026-10-31' }, ['date'])).toBe('Filled date — no total found.');
    expect(summaryOf({}, [])).toBe(SCAN_SUMMARY_NOTHING);
  });

  it('lists only the filled fields, in a fixed order, and says nothing when none was filled', () => {
    const found = { vendor: 'MAPLE GROCERY CO.', purchaseDate: '2026-09-12', priceCents: 1299 };
    expect(summaryOf(found, ['amount', 'date'])).toBe('Filled date, amount.');
    expect(summaryOf({ vendor: 'MAPLE GROCERY CO.', purchaseDate: '2026-09-12' }, ['date'])).toBe(
      'Filled date — no total found.',
    );
    expect(summaryOf(found, [])).toBeNull();
  });
});
