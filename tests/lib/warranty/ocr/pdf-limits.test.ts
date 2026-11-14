import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

/**
 * extractPdfText's bounds, against a stubbed pdfjs so the page count, the text per page and the
 * moment a read is stopped are all under the test's control.
 */
const pdfjs = vi.hoisted(() => {
  const state = {
    pages: [] as string[],
    onTextContent: null as null | ((pageNumber: number) => void),
    getPage: null as unknown as Mock,
    destroy: null as unknown as Mock,
  };
  return state;
});

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      get numPages() {
        return pdfjs.pages.length;
      },
      getPage: (pageNumber: number) => pdfjs.getPage(pageNumber),
      destroy: () => pdfjs.destroy(),
    }),
  }),
}));

import { MAX_PDF_PAGES, MAX_PDF_TEXT_CHARS, extractPdfText } from '@/lib/warranty/ocr/pdf';

beforeEach(() => {
  pdfjs.pages = [];
  pdfjs.onTextContent = null;
  pdfjs.destroy = vi.fn(async () => {});
  pdfjs.getPage = vi.fn(async (pageNumber: number) => ({
    getTextContent: async () => {
      pdfjs.onTextContent?.(pageNumber);
      return {
        items: [{ str: pdfjs.pages[pageNumber - 1], transform: [1, 0, 0, 12, 10, 100], height: 12, hasEOL: false }],
      };
    },
    cleanup: () => {},
  }));
});

describe('extractPdfText text cap', () => {
  it('stops collecting once MAX_PDF_TEXT_CHARS is reached', async () => {
    const perPage = Math.ceil(MAX_PDF_TEXT_CHARS / 4);
    pdfjs.pages = Array.from({ length: MAX_PDF_PAGES }, () => 'A'.repeat(perPage));
    const text = await extractPdfText(new Uint8Array([1, 2, 3]));
    expect(text.length).toBeLessThanOrEqual(MAX_PDF_TEXT_CHARS);
    expect(pdfjs.getPage.mock.calls.length).toBeLessThanOrEqual(5);
    expect(pdfjs.destroy).toHaveBeenCalledTimes(1);
  });

  it('caps the text a single page hands back', async () => {
    pdfjs.pages = ['B'.repeat(MAX_PDF_TEXT_CHARS * 2)];
    const text = await extractPdfText(new Uint8Array([1, 2, 3]));
    expect(text.length).toBeLessThanOrEqual(MAX_PDF_TEXT_CHARS);
  });
});

describe('extractPdfText stop signal', () => {
  it('destroys the document at the next page boundary once the signal is aborted', async () => {
    pdfjs.pages = ['Amount due 312.44 MAPLE GROCER', 'second page text here', 'third page text here'];
    const controller = new AbortController();
    pdfjs.onTextContent = (pageNumber) => {
      if (pageNumber === 1) controller.abort(new Error('stopped'));
    };
    await expect(extractPdfText(new Uint8Array([1, 2, 3]), { signal: controller.signal })).rejects.toThrow('stopped');
    expect(pdfjs.getPage).toHaveBeenCalledTimes(1);
    expect(pdfjs.destroy).toHaveBeenCalledTimes(1);
  });

  it('reads nothing when the signal is already aborted', async () => {
    pdfjs.pages = ['Amount due 312.44 MAPLE GROCER'];
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(extractPdfText(new Uint8Array([1, 2, 3]), { signal: controller.signal })).rejects.toThrow('stopped');
    expect(pdfjs.getPage).not.toHaveBeenCalled();
  });
});
