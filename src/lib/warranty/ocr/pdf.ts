import fs from 'node:fs';

/** MUST-7.15: below this, the PDF is a scan, not a text-layer document. */
export const MIN_PDF_TEXT_CHARS = 20;

export const SCANNED_PDF_MESSAGE =
  'This PDF has no text layer — it looks like a scan. Scanned-PDF OCR is not supported yet; photograph the receipt instead.';

export class ScannedPdfError extends Error {
  constructor() {
    super(SCANNED_PDF_MESSAGE);
    this.name = 'ScannedPdfError';
  }
}

/** Review S-06 (2026-09-02). One pathological PDF must not run the job to its timeout. */
export const MAX_PDF_PAGES = 20;
/** Items whose baselines differ by less than this fraction of the median text height share a line. */
export const PDF_LINE_TOLERANCE_RATIO = 0.5;

export interface PdfTextItem {
  str: string;
  /** transform[4], [5]: the item's origin in PDF user space (y grows UP the page). */
  x: number;
  y: number;
  height: number;
  hasEOL: boolean;
}

/**
 * Spec 2026-09-30 §2.2. pdfjs hands back items in content-stream order with no line structure.
 * Grouped by baseline (top of page first), ordered left to right within a line, split on hasEOL.
 * One joined paragraph per page -- what this did before -- made the vendor the first 60 characters
 * of the page and gave the total and date heuristics one line to work with.
 */
export function linesFromItems(items: readonly PdfTextItem[]): string[] {
  const kept = items.filter((item) => item.str.trim().length > 0);
  if (kept.length === 0) return [];
  const heights = kept.map((item) => item.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medianHeight = heights.length === 0 ? 10 : heights[Math.floor(heights.length / 2)];
  const tolerance = medianHeight * PDF_LINE_TOLERANCE_RATIO;
  const ordered = [...kept].sort((a, b) => (Math.abs(b.y - a.y) > tolerance ? b.y - a.y : a.x - b.x));
  const lines: { y: number; items: PdfTextItem[] }[] = [];
  let forceBreak = false;
  for (const item of ordered) {
    const current = lines[lines.length - 1];
    if (!forceBreak && current !== undefined && Math.abs(item.y - current.y) <= tolerance) current.items.push(item);
    else lines.push({ y: item.y, items: [item] });
    forceBreak = item.hasEOL;
  }
  return lines.map((line) =>
    line.items
      .sort((a, b) => a.x - b.x)
      .map((item) => item.str)
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  );
}

/**
 * MUST-7.14: PDFs are NOT rasterised and NOT run through Tesseract. Text comes from the
 * document's own text layer via pdfjs-dist's legacy Node build, with every remote fetch
 * disabled (no font URL, no CMap URL, no worker fetch) so this path makes no network call.
 *
 * pdf-parse was rejected (§17.10): its published build executes a demo-file read at
 * require time when module.parent is unset, which breaks under bundlers and in ESM, and
 * it is unmaintained.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // Fix report RIDER 4: the literal 0 is pdfjs-dist's VerbosityLevel.ERRORS — importing
    // the enum just for this one constant isn't worth it. Suppresses the per-PDF standard-
    // font warnings pdfjs otherwise logs to stdout/stderr in production for every receipt.
    verbosity: 0,
  }).promise;

  try {
    const pages: string[] = [];
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = content.items.flatMap((item) =>
        'str' in item
          ? [{ str: item.str, x: item.transform[4], y: item.transform[5], height: item.height || Math.abs(item.transform[3]) || 0, hasEOL: Boolean(item.hasEOL) }]
          : [],
      );
      pages.push(linesFromItems(items).join('\n'));
      page.cleanup();
    }
    const text = pages.join('\n');
    if (text.replace(/\s/g, '').length < MIN_PDF_TEXT_CHARS) throw new ScannedPdfError();
    return text;
  } finally {
    await doc.destroy();
  }
}
