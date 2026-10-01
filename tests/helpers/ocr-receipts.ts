import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Fictional receipts rendered in-test. The repo may hold no real receipt images (public repo, the
 * household's paper is theirs), so every pixel here comes from these strings. Cleaner than a real
 * thermal photo -- no curl, glare or uneven fading -- which makes a failure here MORE serious, not
 * less: a pipeline that cannot read this cannot read the real thing.
 */
export const RECEIPT_LINES = [
  'MAPLE GROCERY CO.',
  '1200 Example Ave, Toronto ON',
  'Tel (416) 555-0142',
  'DATE: 2026-09-14  TIME: 18:42',
  '2% MILK 4L            6.49',
  'BANANAS 1.12kg        1.95',
  'WHOLE WHEAT BREAD     3.79',
  'EGGS LARGE 12         4.29',
  'CHEDDAR 400G          7.99',
  'SUBTOTAL             24.51',
  'HST 13%               0.80',
  'TOTAL                25.31',
  'VISA ****4821        25.31',
];

/**
 * RECEIPT_LINES grown to 33 lines with more items, so the paper is clearly taller than wide, the
 * shape of a real receipt. Same header and the same SUBTOTAL / HST / TOTAL 25.31 / VISA tail.
 */
export const TALL_RECEIPT_LINES = [
  ...RECEIPT_LINES.slice(0, 9),
  ...(
    [
      ['ROLLED OATS 1KG', '4.49'],
      ['APPLES GALA 3LB', '5.03'],
      ['CARROTS 2LB', '2.29'],
      ['YOGURT PLAIN 750G', '3.99'],
      ['PASTA PENNE 900G', '2.49'],
      ['TOMATO SAUCE 680ML', '1.99'],
      ['RICE BASMATI 2KG', '6.99'],
      ['OLIVE OIL 1L', '9.49'],
      ['COFFEE GROUND 340G', '8.99'],
      ['TEA BAGS 72CT', '4.79'],
      ['PEANUT BUTTER 1KG', '5.49'],
      ['ORANGE JUICE 2L', '4.99'],
      ['BUTTER SALTED 454G', '6.29'],
      ['ONIONS YELLOW 3LB', '3.49'],
      ['POTATOES 10LB', '5.99'],
      ['CHICKEN THIGHS 1KG', '9.87'],
      ['FROZEN PEAS 750G', '2.79'],
      ['PAPER TOWEL 6PK', '7.49'],
      ['DISH SOAP 740ML', '3.29'],
      ['GRANOLA BARS 6PK', '3.99'],
    ] as const
  ).map(([name, price]) => `${name}${price.padStart(26 - name.length)}`),
  ...RECEIPT_LINES.slice(9),
];

export const LONG_RECEIPT_LINES = [
  ...RECEIPT_LINES.slice(0, 4),
  ...Array.from({ length: 25 }, (_, i) => `ITEM ${String(i + 1).padStart(2, '0')} DESCRIPTION   ${(1 + i * 0.37).toFixed(2).padStart(6)}`),
  'SUBTOTAL            129.75',
  'HST 13%               4.22',
  'TOTAL               133.97',
  'VISA ****4821       133.97',
];

export interface RenderOptions {
  /** Receipt paper width in pixels. 576 is a flat scan; the photo case scales it inside a frame. */
  widthPx?: number;
  /** Rigid tilt of the paper, degrees, positive clockwise. */
  tiltDeg?: number;
  /**
   * 'countertop' places the paper on a mid-grey 3024x4032 frame, scaled to 72 percent of the
   * frame's height, or of its width if that binds first. TALL_RECEIPT_LINES covers about half of it.
   */
  background?: 'none' | 'countertop';
  /** Gaussian blur sigma, to stand in for a phone's focus. */
  blur?: number;
  /** Saved sideways, no EXIF tag. */
  rotate90?: boolean;
  jpegQuality?: number;
}

export async function renderReceipt(lines: string[], opts: RenderOptions = {}): Promise<Buffer> {
  const width = opts.widthPx ?? 576;
  const lineHeight = Math.round(width / 24);
  const fontPx = Math.round(lineHeight * 0.62);
  const height = lineHeight * (lines.length + 2);
  const escaped = lines.map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n');
  // pango markup, monospace so the columns line up like a thermal printer's.
  const text = await sharp({
    text: {
      text: `<span font_family="monospace" size="${fontPx * 1024}" foreground="#1a1a1a">${escaped}</span>`,
      width: width - lineHeight,
      height: height - lineHeight,
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const paper = sharp({ create: { width, height, channels: 3, background: '#f4efe6' } })
    .composite([{ input: text, left: Math.round(lineHeight / 2), top: Math.round(lineHeight / 2) }])
    .png();
  let image = sharp(await paper.toBuffer());
  if (opts.tiltDeg) image = sharp(await image.rotate(opts.tiltDeg, { background: '#6b6b6b' }).png().toBuffer());
  if (opts.background === 'countertop') {
    const inner = await image.png().toBuffer();
    const meta = await sharp(inner).metadata();
    const innerWidth = meta.width ?? width;
    const innerHeight = meta.height ?? height;
    // Fit both ways: a wide, short paper scaled by height alone overflows the frame.
    const scale = Math.min((3024 * 0.72) / innerWidth, (4032 * 0.72) / innerHeight);
    const scaled = await sharp(inner).resize({ height: Math.round(innerHeight * scale) }).png().toBuffer();
    const scaledMeta = await sharp(scaled).metadata();
    image = sharp({ create: { width: 3024, height: 4032, channels: 3, background: '#6b6b6b' } }).composite([
      { input: scaled, left: Math.round((3024 - (scaledMeta.width ?? 0)) / 2), top: Math.round((4032 - (scaledMeta.height ?? 0)) / 2) },
    ]);
    image = sharp(await image.png().toBuffer());
  }
  if (opts.blur) image = sharp(await image.blur(opts.blur).png().toBuffer());
  if (opts.rotate90) image = sharp(await image.rotate(90).png().toBuffer());
  return image.jpeg({ quality: opts.jpegQuality ?? 80 }).toBuffer();
}

export function writeTemp(buf: Buffer, ext: 'jpg' | 'png'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-'));
  const file = path.join(dir, `receipt.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/** Character error rate: Levenshtein distance over the expected length, whitespace collapsed. */
export function cer(expected: string, actual: string): number {
  const a = collapse(expected);
  const b = collapse(actual);
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return a.length === 0 ? 0 : prev[b.length] / a.length;
}
