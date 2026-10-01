import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { onnxOcrEngine } from '@/lib/warranty/ocr/onnx/engine';
import { releaseOnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
import { suggestFromOcrText } from '@/lib/warranty/suggest';
import { LONG_RECEIPT_LINES, RECEIPT_LINES, TALL_RECEIPT_LINES, cer, renderReceipt, writeTemp } from '../helpers/ocr-receipts';

/**
 * Spec 2026-09-30 §1.2 / §2.4. The ONLY recognition-quality test in the repo: everything else fakes
 * the sessions. The bounds are generous on purpose -- this is a regression floor, not a benchmark
 * -- and each case is one failure mode the measurement found. Real vendored models, real sharp,
 * fictional receipts rendered on the fly. Slow (a few seconds a case); lives under tests/integration.
 */
const files: string[] = [];
afterAll(async () => {
  // Not releaseOcrEngine(): it frees the ONNX sessions only when the default engine loaded them,
  // and this file calls onnxOcrEngine directly, so the three native sessions would stay live.
  await releaseOnnxOcrSessions();
  for (const file of files) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

async function read(buf: Buffer): Promise<string> {
  const file = writeTemp(buf, 'jpg');
  files.push(file);
  return (await onnxOcrEngine.recognize(file, 'image/jpeg')).text;
}

const TODAY = '2026-09-20';

describe('OCR accuracy on rendered receipts', () => {
  it('A: a flat scan reads at under 3 percent character error, with vendor, date and total extracted', async () => {
    const text = await read(await renderReceipt(RECEIPT_LINES));
    expect(cer(RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.03);
    const s = suggestFromOcrText(text, TODAY);
    expect(s.vendor).toBe('MAPLE GROCERY CO.');
    expect(s.purchaseDate).toBe('2026-09-14');
    expect(s.priceCents).toBe(2531);
  }, 60_000);

  /** The reported failure: a hand-held photo on a counter. Shipped: 86% CER, no total. */
  it('B: a tilted phone photo on a countertop reads under 20 percent and finds the total', async () => {
    const text = await read(await renderReceipt(TALL_RECEIPT_LINES, { tiltDeg: 6, background: 'countertop', blur: 1.2, jpegQuality: 70 }));
    expect(cer(TALL_RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.2);
    // 25.31 is on the VISA line too: the total must come from a TOTAL line actually read.
    expect(text).toMatch(/(^|\s)TOTAL\s*25[.,]31/m);
    const s = suggestFromOcrText(text, TODAY);
    expect(s.vendor).toBe('MAPLE GROCERY CO.');
    expect(s.purchaseDate).toBe('2026-09-14');
    expect(s.priceCents).toBe(2531);
  }, 90_000);

  it('C: a long receipt keeps every line, merchant and total', async () => {
    const text = await read(await renderReceipt(LONG_RECEIPT_LINES, { widthPx: 1100, blur: 0.6 }));
    expect(cer(LONG_RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.03);
    const s = suggestFromOcrText(text, TODAY);
    expect(s.vendor).toBe('MAPLE GROCERY CO.');
    expect(s.purchaseDate).toBe('2026-09-14');
    expect(s.priceCents).toBe(13397);
  }, 90_000);

  it('D: a receipt saved sideways with no EXIF tag reads as well as a flat scan', async () => {
    const text = await read(await renderReceipt(RECEIPT_LINES, { rotate90: true }));
    // A's bar, in order: the quarter turn can land the page upside down, and the classifier's
    // votes catch that and turn the boxes the other half turn before the lines are put together,
    // so the vendor is the first line again rather than the last.
    expect(cer(RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.03);
    expect(text).toMatch(/(^|\s)TOTAL\s*25[.,]31/m);
    const s = suggestFromOcrText(text, TODAY);
    expect(s.vendor).toBe('MAPLE GROCERY CO.');
    expect(s.purchaseDate).toBe('2026-09-14');
    expect(s.priceCents).toBe(2531);
  }, 60_000);
});
