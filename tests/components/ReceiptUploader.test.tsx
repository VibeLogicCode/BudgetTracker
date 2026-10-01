// @vitest-environment jsdom
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
          suggestions: { vendor: 'RIVERSIDE WATER', priceCents: 44443 },
          lines: ['RIVERSIDE WATER', 'Amount due $444.43'],
          candidates: {
            amounts: [
              { valueCents: 44443, snippet: 'Amount due $444.43', score: 4 },
              { valueCents: 46667, snippet: 'Amount due after due date $466.67', score: 1 },
            ],
            dates: [{ date: '2026-10-31', snippet: 'Due date 2026-10-31', score: 4 }],
          },
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const onPickAmount = vi.fn();
    const onPickDate = vi.fn();
    const { container } = render(
      <ReceiptUploader onStagedChange={vi.fn()} onPickAmount={onPickAmount} onPickDate={onPickDate} />,
    );

    await pickAndPoll(container, fetchMock);

    expect(screen.getByText('Filled vendor, amount.')).toBeTruthy();
    fireEvent.click(screen.getByText('What was read'));
    // Scoped: the same words are also the first chip's snippet.
    expect(within(container.querySelector('details')!).getByText('Amount due $444.43')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /\$466\.67/ }));
    expect(onPickAmount).toHaveBeenCalledWith(46667);
    fireEvent.click(screen.getByRole('button', { name: /Oct 31, 2026/ }));
    expect(onPickDate).toHaveBeenCalledWith('2026-10-31');
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

  it('offers a second input without capture so a phone can pick a PDF', () => {
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute('capture')).toBe('environment');
    expect(inputs[1].hasAttribute('capture')).toBe(false);
    expect(inputs[1].getAttribute('accept')).toBe('image/*,application/pdf');
    expect((inputs[1] as HTMLInputElement).multiple).toBe(true);
    expect(screen.getByLabelText('Choose a file or PDF')).toBe(inputs[1]);
  });

  it('the second input stages what it is given, like the camera one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stageResponse({ originalFilename: 'manual.pdf', mime: 'application/pdf' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const pdf = new File(['%PDF-1.4'], 'manual.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose a file or PDF'), { target: { files: [pdf] } });
    await screen.findByText('manual.pdf');
    expect((fetchMock.mock.calls[0][1].body as FormData).getAll('file')[0]).toBe(pdf);
  });
});

describe('summaryOf', () => {
  it('names what was filled, and says when no total was found', () => {
    expect(summaryOf({ vendor: 'MAPLE GROCERY CO.', purchaseDate: '2026-09-12', priceCents: 1299 })).toBe(
      'Filled vendor, date, amount.',
    );
    expect(summaryOf({ dueDate: '2026-10-31' })).toBe('Filled date — no total found.');
    expect(summaryOf({})).toBe(SCAN_SUMMARY_NOTHING);
  });
});
