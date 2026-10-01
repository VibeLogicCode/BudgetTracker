import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_PDF_PAGES, ScannedPdfError, extractPdfText, linesFromItems } from '@/lib/warranty/ocr/pdf';

/**
 * M5: pdf.ts had zero execution coverage. MUST-7.17 forbids loading the real WASM OCR
 * engine in tests — it does NOT forbid pdfjs-dist, which reads a PDF's own text layer and
 * never touches tesseract or any .wasm file. So these fixtures are hand-authored, minimal,
 * but STRUCTURALLY REAL PDFs, run through the actual extractPdfText().
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-pdf-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Run = { x: number; y: number; text: string };
function contentFor(runs: Run[]): string {
  return runs.map((run) => `BT /F1 12 Tf ${run.x} ${run.y} Td (${run.text.replace(/([()\\])/g, '\\$1')}) Tj ET`).join('\n');
}
/** One page per inner array. The old single-string form is `buildPdf([[{x:10,y:100,text}]])`. */
function buildPdf(pages: Run[][]): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const fontIndex = 3 + pages.length * 2;
  pages.forEach((runs, i) => {
    const pageIndex = 3 + i * 2;
    const contentIndex = pageIndex + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${fontIndex} 0 R >> >> /MediaBox [0 0 400 300] /Contents ${contentIndex} 0 R >>`);
    const content = contentFor(runs);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** A minimal single-page PDF with one Helvetica text-show operator (or none, for `text === ''`). */
function buildMinimalPdf(text: string): Buffer {
  return buildPdf([text.length > 0 ? [{ x: 10, y: 100, text }] : []]);
}

function writeFixture(text: string): string {
  const file = path.join(dir, 'fixture.pdf');
  fs.writeFileSync(file, buildMinimalPdf(text));
  return file;
}

describe('extractPdfText (M5 — real pdfjs-dist execution, not the OCR engine)', () => {
  it('reads the text layer of a real text-layer PDF', async () => {
    const file = writeFixture('HOME DEPOT TOTAL 42.00 hardware receipt');
    const text = await extractPdfText(file);
    expect(text).toContain('HOME DEPOT TOTAL 42.00');
  });

  it('throws ScannedPdfError when the PDF has no text layer', async () => {
    const file = writeFixture('');
    await expect(extractPdfText(file)).rejects.toThrow(ScannedPdfError);
  });
});

/** Spec 2026-09-30 §2.2. Items are grouped into LINES by position; one paragraph per page broke every line-based heuristic. */
describe('extractPdfText reads lines', () => {
  it('puts items at different heights on different lines, top first', async () => {
    const file = path.join(dir, 'two.pdf');
    fs.writeFileSync(file, buildPdf([[{ x: 10, y: 200, text: 'RIVERSIDE WATER' }, { x: 10, y: 100, text: 'Amount due 444.43' }]]));
    expect(await extractPdfText(file)).toBe('RIVERSIDE WATER\nAmount due 444.43');
  });

  /** Review focus 3: a two-column bill -- label left, figure right, same height. */
  it('reads a two-column bill, left to right on one line', async () => {
    const file = path.join(dir, 'cols.pdf');
    fs.writeFileSync(
      file,
      buildPdf([[
        { x: 10, y: 200, text: 'Amount due' },
        { x: 250, y: 200, text: '$444.43' },
        { x: 10, y: 170, text: 'Due date' },
        { x: 250, y: 170, text: '2026-10-31' },
      ]]),
    );
    expect(await extractPdfText(file)).toBe('Amount due $444.43\nDue date 2026-10-31');
  });

  /** Review focus 6. */
  it('stops at the page cap and returns what it read', async () => {
    const pages = Array.from({ length: MAX_PDF_PAGES + 5 }, (_, i) => [{ x: 10, y: 100, text: `PAGE ${i + 1}` }]);
    const file = path.join(dir, 'many.pdf');
    fs.writeFileSync(file, buildPdf(pages));
    const text = await extractPdfText(file);
    expect(text).toContain(`PAGE ${MAX_PDF_PAGES}`);
    expect(text).not.toContain(`PAGE ${MAX_PDF_PAGES + 1}`);
  });
});

describe('linesFromItems (pure)', () => {
  it('uses hasEOL as a hard break even at the same height', () => {
    expect(
      linesFromItems([
        { str: 'A', x: 0, y: 100, height: 10, hasEOL: true },
        { str: 'B', x: 50, y: 100, height: 10, hasEOL: false },
      ]),
    ).toEqual(['A', 'B']);
  });
});
