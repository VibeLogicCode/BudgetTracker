# A receipt reader that reads — Implementation Plan (Part B of v1.53.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run Part A (`2026-10-01-bills-amount-and-shapes.md`) first on the same branch; Task 7 here assumes its `onSuggestions` hooks exist.

**Goal:** Attaching a text-layer e-bill fills the bill's amount due and due date; photographing a receipt at a hand-held tilt on a countertop reads every word; a read that found nothing says so; the person can see what was read and tap the figure they meant. Measured, not hoped: an accuracy harness runs synthetic receipts through the real vendored models and asserts it.

**Architecture:** Three layers, each fixed where the fault was measured. **Engine** (`src/lib/warranty/ocr/onnx/`): the box score is masked to the polygon (parity with RapidOCR), the crop centre is rotated about the image centre, deskew refuses to guess on a dark background, line assembly rotates box centres by the median text angle, a 0°/90° orientation probe runs before detection, and the Tesseract fallback gets the same preprocessing. **Text** (`pdf.ts`, `suggest.ts`): PDF items are grouped into lines by position; the "largest number anywhere" fallback is deleted; payment lines are excluded; TOTAL matches fuzzily; a due-date extractor exists; every amount and date becomes a candidate with its surrounding words. **Surface** (`queue.ts`, the poll route, `ReceiptUploader.tsx`): the sidecar carries lines and candidates, an empty read is a failure with a message, the tile shows what was read and offers chips, a scanner fallback says why, a second file input lets a phone pick a PDF.

**Tech Stack:** sharp (preprocessing, synthetic receipt rendering via pango text), onnxruntime-node 1.27.0 (exact pin, PP-OCRv5 mobile det/cls/rec), tesseract.js, pdfjs-dist legacy build, zod, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-30-bills-shapes-and-receipt-reading-design.md` §1.2–§1.3 (findings) and §2.2–§2.5 (decisions). Every task cites its section. The measurements the spec quotes came from a scratch run of the production modules on synthetic receipts; Task 1 turns that run into a permanent test.

## Global Constraints

- **Public repo.** No real receipt images, no owner data, no verbatim owner quotes. Every fixture is rendered in-test from fictional text ("MAPLE GROCERY CO.", "1200 Example Ave").
- **Commit messages:** subject + a few bullets. **No `Co-Authored-By` or AI attribution lines.**
- **TDD, one file at a time.** The accuracy harness (Task 1) is the RED for Tasks 2–7: write it first, watch the tilted and sideways cases fail, make them pass one fix at a time. Known full-run flake: `tests/ops/install.test.ts` with `Timeout calling "onTaskUpdate"` — rerun alone.
- **Bash heredocs break on backticks and `\n`/`\b` here.** Use the Edit tool or a python script written with the Write tool.
- **Every numeric constant under `src/lib/warranty/ocr/onnx/` lives in `onnx/constants.ts`** (`tests/ops/constants.test.ts` fails on literals elsewhere in that tree). New constants carry a one-line "Ours." or source note like their neighbours. Check that file's pinned-table test and add new names where it enumerates them.
- **`renderEvent`-style purity holds for `contours.ts`, `assemble.ts`, `constants.ts`** (no node builtins, no sharp, no ORT) — `tests/ops/constants.test.ts:155`.
- **ORT is imported in exactly two files** (`tests/ops/ocr-egress.test.ts`); nothing here adds a third. Zero runtime egress: no model downloads, no fetches.
- **No new model, no resolution-cap change, no cloud.** Spec §2.4 records why.
- **`capture="environment"` stays on the camera input** (`tests/ops/no-viewfinder.test.ts:57` pins it). The second input is additional.
- **Copy is copied verbatim** from the task that names it.
- **Release:** bump `package.json` to `1.53.0`; CHANGELOG under Added / Changed / Fixed; MUST-7.1 guard in `tests/ops/docker.test.ts` (every `toBe('1.52.0')` → `'1.53.0'`, the `1.52.0 release` case becomes append-only, a new `1.53.0 release` case); `rm -rf .next && npm run build`; `npm run smoke`; commit `chore(release): v1.53.0`; push `main`; push tag `v1.53.0`; watch `Release image`.

## Review Focus

1. **A receipt saved sideways with no EXIF tag** must read, not produce garbage marked "Read". Task 1 case D + Task 6.
2. **A dark countertop around a level receipt** must not rotate the image 10° (the deskew bound). Task 4 (`'returns 0 on a dark background'`).
3. **An e-bill whose "Amount due" and "Due date" are on different lines from their labels' neighbours** must still yield both. Task 8 (`'reads a two-column bill'`) + Task 9 (`'finds the due date on its own line'`).
4. **A receipt with `CASH 100.00` and `TOTAL 47.32`** must suggest 47.32, and one with no TOTAL line must suggest nothing. Task 9.
5. **Two receipts attached together** must not have the second's suggestions overwrite the first's typed values, and the notice must not clear while one is still reading. Task 11 (`'keeps the notice while another is still reading'`).
6. **A PDF with hundreds of pages** must stop at the cap and still return what it read. Task 8 (`'stops at the page cap'`).

---

## File map

| Area | Files |
|---|---|
| Harness | `tests/helpers/ocr-receipts.ts` (new), `tests/integration/ocr-accuracy.test.ts` (new) |
| Engine | `src/lib/warranty/ocr/onnx/contours.ts` (score), `crop.ts` (centre), `preprocess.ts` (ink guard, PNG export), `assemble.ts` (tilt), `orientation.ts` (new), `engine.ts` (wiring), `constants.ts`; `src/lib/warranty/ocr/tesseract.ts` |
| Text | `src/lib/warranty/ocr/pdf.ts`, `src/lib/warranty/suggest.ts` |
| Surface | `src/lib/warranty/staging.ts` (sidecar shape), `src/lib/warranty/ocr/queue.ts`, `src/lib/warranty/ocr/engine.ts` (messages), `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`, `src/components/warranty/ReceiptUploader.tsx`, `ReceiptScanPreview.tsx`, `src/lib/scanner/scan.ts` |
| Copy | `src/app/(app)/warranties/new/new-warranty-client.tsx:227`, `src/app/(app)/help/content.tsx:376-388`, `README.md:39-46` |
| Release | `CHANGELOG.md`, `package.json`, `tests/ops/docker.test.ts` |

---

### Task 1: The accuracy harness — RED for the engine

**Files:**
- Create: `tests/helpers/ocr-receipts.ts`
- Create: `tests/integration/ocr-accuracy.test.ts`

**Interfaces:**
- Produces: `renderReceipt(lines: string[], opts: { widthPx?: number; tiltDeg?: number; background?: 'none' | 'countertop'; blur?: number; rotate90?: boolean }): Promise<Buffer>` — a JPEG of fictional receipt text rendered with sharp's pango text; `cer(expected: string, actual: string): number` — character error rate over whitespace-collapsed text; `RECEIPT_LINES`, `LONG_RECEIPT_LINES` fixtures; `writeTemp(buf, ext): string`.
- The test uses the REAL vendored models through `onnxOcrEngine.recognize` (the same way `tests/lib/warranty/ocr/onnx/dict.test.ts` loads the real recogniser) and the real `suggestFromOcrText`.

- [ ] **Step 1: Write the helper**

```ts
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
  /** 'countertop' places the paper on a mid-grey 3024x4032 frame filling about 30 percent of it. */
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
  let paper = sharp({ create: { width, height, channels: 3, background: '#f4efe6' } })
    .composite([{ input: text, left: Math.round(lineHeight / 2), top: Math.round(lineHeight / 2) }])
    .png();
  let image = sharp(await paper.toBuffer());
  if (opts.tiltDeg) image = sharp(await image.rotate(opts.tiltDeg, { background: '#6b6b6b' }).png().toBuffer());
  if (opts.background === 'countertop') {
    const inner = await image.png().toBuffer();
    const meta = await sharp(inner).metadata();
    const scale = (4032 * 0.72) / (meta.height ?? height);
    const scaled = await sharp(inner).resize({ height: Math.round((meta.height ?? height) * scale) }).png().toBuffer();
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
```

- [ ] **Step 2: Write the failing harness test**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { onnxOcrEngine } from '@/lib/warranty/ocr/onnx/engine';
import { releaseOcrEngine } from '@/lib/warranty/ocr/engine';
import { suggestFromOcrText } from '@/lib/warranty/suggest';
import { LONG_RECEIPT_LINES, RECEIPT_LINES, cer, renderReceipt, writeTemp } from '../helpers/ocr-receipts';

/**
 * Spec 2026-09-30 §1.2 / §2.4. The ONLY recognition-quality test in the repo: everything else fakes
 * the sessions. The bounds are generous on purpose -- this is a regression floor, not a benchmark
 * -- and each case is one failure mode the measurement found. Real vendored models, real sharp,
 * fictional receipts rendered on the fly. Slow (a few seconds a case); lives under tests/integration.
 */
const files: string[] = [];
afterAll(async () => {
  await releaseOcrEngine();
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
    const text = await read(await renderReceipt(RECEIPT_LINES, { tiltDeg: 6, background: 'countertop', blur: 1.2, jpegQuality: 70 }));
    expect(cer(RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.2);
    expect(suggestFromOcrText(text, TODAY).priceCents).toBe(2531);
  }, 90_000);

  it('C: a long receipt keeps every line, merchant and total', async () => {
    const text = await read(await renderReceipt(LONG_RECEIPT_LINES, { widthPx: 1100, blur: 0.6 }));
    expect(cer(LONG_RECEIPT_LINES.join('\n'), text)).toBeLessThan(0.03);
    const s = suggestFromOcrText(text, TODAY);
    expect(s.vendor).toBe('MAPLE GROCERY CO.');
    expect(s.priceCents).toBe(13397);
  }, 90_000);

  it('D: a receipt saved sideways with no EXIF tag still reads its total', async () => {
    const text = await read(await renderReceipt(RECEIPT_LINES, { rotate90: true }));
    expect(suggestFromOcrText(text, TODAY).priceCents).toBe(2531);
  }, 60_000);
});
```

- [ ] **Step 3: Run it to verify it fails for the right reasons**

Run: `npx vitest run tests/integration/ocr-accuracy.test.ts`
Expected: **A passes or nearly** (the measured clean-scan CER was 1.1%); **B FAILS** (CER far above 0.2, `priceCents` undefined or wrong); **C may fail** on the vendor ("MAPLE G GROCERY") — the crop bug; **D FAILS** (garbage). If A fails on `vendor` with a duplicated fragment, that is also the crop bug and Task 3 fixes it. If sharp throws on `text` ("text rendering not available"), the sharp build lacks pango: install the project's pinned sharp again (`npm ci`) — the prebuilt linux/win binaries include it — and do not stub the renderer.

- [ ] **Step 4: Commit the harness red**

```bash
git add tests/helpers/ocr-receipts.ts tests/integration/ocr-accuracy.test.ts
git commit -m "test(ocr): an accuracy harness on rendered receipts

- fictional receipts rendered in-test; real vendored models
- flat, tilted on a countertop, long, and sideways
- B and D fail today: that is the point"
```

(A red commit is deliberate here and only here: the next five tasks each turn one case green, and the branch review sees the whole arc.)

---

### Task 2: Polygon-masked box score (spec §1.2 bug 1)

**Files:**
- Modify: `src/lib/warranty/ocr/onnx/contours.ts:233-251` (`boxScoreFast`)
- Test: `tests/lib/warranty/ocr/onnx/contours.test.ts:139-152`

- [ ] **Step 1: Write the failing unit test**

Append inside `describe('boxScoreFast (MUST-4.15)', …)`:

```ts
  /**
   * Spec 2026-09-30 §1.2 bug 1. A text line tilted a few degrees has an axis-aligned bounding box
   * that is mostly background. RapidOCR/PaddleOCR average only inside the polygon; averaging the
   * whole box scored every long tilted line under DET_BOX_THRESH and threw it away -- 13 of 24
   * lines on the measured photo.
   */
  it('averages inside the polygon, so a tilted line keeps its score', () => {
    const width = 100;
    const height = 40;
    const map = new Float32Array(width * height).fill(0.05);
    // A slanted band: on row y the ink runs from x = 20 + (y - 10) to x = 60 + (y - 10).
    for (let y = 10; y < 30; y += 1) for (let x = 20 + (y - 10); x < 60 + (y - 10); x += 1) map[y * width + x] = 0.9;
    const quad = [
      { x: 20, y: 10 },
      { x: 60, y: 10 },
      { x: 80, y: 30 },
      { x: 40, y: 30 },
    ] as const;
    // The whole-box mean would be about 0.62 (800 ink pixels of 1200). Inside the polygon it is ~0.9.
    expect(boxScoreFast(map, width, height, quad)).toBeGreaterThan(0.85);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/contours.test.ts`
Expected: the new test FAILS with a score near 0.62. The existing axis-aligned test (`2.4 / 6`) still passes afterwards because its quad IS its bounding box.

- [ ] **Step 3: Implement**

Replace `boxScoreFast` and its docblock:

```ts
/**
 * DET_SCORE_MODE is 'fast': RapidOCR's box_score_fast -- the mean probability INSIDE THE POLYGON,
 * computed over the polygon's axis-aligned bounding box with a point-in-polygon mask. The mask is
 * the whole point (spec 2026-09-30 §1.2 bug 1): without it a text line tilted a few degrees scored
 * mostly background and was dropped before recognition ever saw it.
 */
export function boxScoreFast(probMap: Float32Array, width: number, height: number, quad: Quad): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(Math.min(...xs))));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(...xs))));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(Math.min(...ys))));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(...ys))));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (!insideQuad(quad, x + 0.5, y + 0.5)) continue;
      sum += probMap[y * width + x];
      count += 1;
    }
  }
  // A degenerate polygon (zero area after rounding) falls back to the box mean rather than 0, so a
  // one-pixel-tall sliver is judged by its pixels and not refused for its shape.
  if (count === 0) return boxMean(probMap, width, x0, x1, y0, y1);
  return sum / count;
}

function boxMean(probMap: Float32Array, width: number, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      sum += probMap[y * width + x];
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/** Crossing-number test against the four edges. Pure arithmetic, no dependency. */
function insideQuad(quad: Quad, px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i, i += 1) {
    const a = quad[i];
    const b = quad[j];
    const crosses = a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
```

- [ ] **Step 4: Run contours, then the harness, commit**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/contours.test.ts` — PASS.
Run: `npx vitest run tests/integration/ocr-accuracy.test.ts` — B's CER should drop sharply (measured: 86% → ~35% with this fix alone) but still FAIL; that is expected until Task 3.

```bash
git add src/lib/warranty/ocr/onnx/contours.ts tests/lib/warranty/ocr/onnx/contours.test.ts
git commit -m "fix(ocr): score detection boxes inside the polygon, not the bounding box

- parity with RapidOCR's box_score_fast, which the comment already claimed
- a tilted text line no longer scores mostly background and vanishes"
```

---

### Task 3: Rotate the crop centre with the image (spec §1.2 bug 2)

**Files:**
- Modify: `src/lib/warranty/ocr/onnx/crop.ts:60-90` (`cropBoxes`)
- Test: `tests/lib/warranty/ocr/onnx/crop.test.ts`

- [ ] **Step 1: Write the failing content test**

Append to `crop.test.ts` (it already imports `sharp`? If not, add `import sharp from 'sharp';`):

```ts
/**
 * Spec 2026-09-30 §1.2 bug 2. The old test only checked the crop's SIZE, for a box at the exact
 * image centre -- the one place the bug cannot show. This one checks CONTENT: a dark line near a
 * corner, tilted, must land inside its own crop. With the centre not rotated, the window lands on
 * white paper 35 px away and the recogniser reads nothing, or half of the next line.
 */
describe('cropBoxes follows a rotated box to where it actually is', () => {
  async function pageWithTiltedLine(cx: number, cy: number, angleDeg: number): Promise<RawImage> {
    const line = await sharp({ create: { width: 120, height: 14, channels: 3, background: '#000000' } })
      .rotate(angleDeg, { background: '#ffffff' })
      .png()
      .toBuffer();
    const meta = await sharp(line).metadata();
    const { data, info } = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
      .composite([{ input: line, left: Math.round(cx - (meta.width ?? 0) / 2), top: Math.round(cy - (meta.height ?? 0) / 2) }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  const meanLuma = (crop: { data: Buffer; width: number; height: number }) => {
    let sum = 0;
    for (let i = 0; i < crop.data.length; i += 1) sum += crop.data[i];
    return sum / crop.data.length;
  };

  it('crops the dark line, not the paper beside it, for a box far from the centre at 6 degrees', async () => {
    const image = await pageWithTiltedLine(300, 80, 6);
    const [crop] = await cropBoxes(image, [box(300, 80, 120, 14, 6)]);
    // Mostly ink. A miss lands on white and reads far above 200.
    expect(meanLuma(crop)).toBeLessThan(110);
  });

  it('still crops a level box at the centre exactly as before', async () => {
    const image = await pageWithTiltedLine(200, 150, 0);
    const [crop] = await cropBoxes(image, [box(200, 150, 120, 14, 0)]);
    expect(meanLuma(crop)).toBeLessThan(40);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/crop.test.ts`
Expected: the 6° test FAILS with a mean luma above 200 (white); the level one passes.

- [ ] **Step 3: Implement**

In `cropBoxes`, replace the `extractWindow(...)` call's centre arguments:

```ts
    // The source was rotated about ITS centre by -angleDeg and its canvas grew. The box centre has
    // to make the same journey: offset from the old centre, rotated by the same angle, re-anchored
    // on the new centre. Translating by the canvas growth alone (what this did before) leaves a box
    // 400 px from centre about 35 px off at 5 degrees -- more than a text line (spec §1.2 bug 2).
    const theta = rotate ? (-angleDeg * Math.PI) / 180 : 0;
    const dx = boxes[boxIndex].rect.cx - image.width / 2;
    const dy = boxes[boxIndex].rect.cy - image.height / 2;
    const cx = source.info.width / 2 + dx * Math.cos(theta) - dy * Math.sin(theta);
    const cy = source.info.height / 2 + dx * Math.sin(theta) + dy * Math.cos(theta);
    const window = extractWindow(source.info.width, source.info.height, cx, cy, width, height);
```

If the 6° test still reads white after this, the sign convention of sharp's rotation is the other way for this build: flip the sign of `theta` (`(angleDeg * Math.PI) / 180`) and rerun — the content test is the arbiter, which is why it exists.

- [ ] **Step 4: Run crop, the harness, commit**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/crop.test.ts` — PASS.
Run: `npx vitest run tests/integration/ocr-accuracy.test.ts` — A and C now PASS including the vendor; B's CER falls further (measured ~12% with Tasks 2+3 but line pairing still wrong, so `priceCents` may still fail); D still FAILS.

```bash
git add src/lib/warranty/ocr/onnx/crop.ts tests/lib/warranty/ocr/onnx/crop.test.ts
git commit -m "fix(ocr): rotate the crop centre with the image

- the window now lands on the tilted line, not the paper beside it
- content test near a corner, where the old size-only test could not look"
```

---

### Task 4: Deskew refuses to guess on a dark background (spec §1.2 bug 3)

**Files:**
- Modify: `src/lib/warranty/ocr/onnx/preprocess.ts:110-133` (`estimateSkewDeg`), `constants.ts` (one constant)
- Test: `tests/lib/warranty/ocr/onnx/preprocess.test.ts:114-160`

- [ ] **Step 1: Write the failing test**

Append inside the deskew describe:

```ts
  /**
   * Spec 2026-09-30 §1.2 bug 3. Otsu over the whole frame marks a countertop as ink, the profile
   * search runs to the bound, and a level receipt is rotated ten degrees. When most of the frame
   * binarises to ink there is no text to measure; the honest answer is 0.
   */
  it('returns 0 on a dark background around a level receipt, instead of the search bound', async () => {
    const paper = await barGridPng(0, 300, 400);
    const framed = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#3c3c3c' } })
      .composite([{ input: paper, left: 300, top: 400 }])
      .png()
      .toBuffer();
    expect(await estimateSkewDeg(framed)).toBe(0);
  });
```

(`sharp` and `barGridPng` are already imported in that file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/preprocess.test.ts`
Expected: FAILS with `-10` (or `10`).

- [ ] **Step 3: Implement**

In `constants.ts`, after `DESKEW_BACKGROUND`:

```ts
/** Ours. Above this fraction of "ink" after Otsu, the frame is background, not text, and the
 *  profile search would measure the countertop's edges. The deskew then declines. */
export const DESKEW_MAX_INK_RATIO = 0.35;
```

In `estimateSkewDeg`, after the `binary` array is filled:

```ts
  let ink = 0;
  for (let i = 0; i < binary.length; i += 1) ink += binary[i];
  // Spec 2026-09-30 §1.2 bug 3: a frame that is mostly ink has no lines to level.
  if (ink / binary.length > DESKEW_MAX_INK_RATIO) return 0;
```

Import `DESKEW_MAX_INK_RATIO`.

- [ ] **Step 4: Run, commit**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/preprocess.test.ts tests/ops/constants.test.ts` — PASS.

```bash
git add src/lib/warranty/ocr/onnx/preprocess.ts src/lib/warranty/ocr/onnx/constants.ts tests/lib/warranty/ocr/onnx/preprocess.test.ts
git commit -m "fix(ocr): deskew declines when the frame is mostly background

- Otsu over a countertop marked it as ink and the search ran to the bound"
```

---

### Task 5: Tilt-aware line assembly (spec §2.4 item 4)

**Files:**
- Modify: `src/lib/warranty/ocr/onnx/assemble.ts`, `constants.ts`
- Test: `tests/lib/warranty/ocr/onnx/assemble.test.ts`

**Interfaces:**
- Produces: `assembleText(boxes)` unchanged signature; new exported pure helper `medianTextAngleDeg(boxes: readonly AssemblyBox[]): number`; constant `LINE_CENTRE_TOLERANCE_RATIO = 0.5`.

- [ ] **Step 1: Write the failing test**

Append to `assemble.test.ts`:

```ts
/**
 * Spec 2026-09-30 §2.4 item 4. Grouping by axis-aligned y-overlap pairs each price with the line
 * ABOVE it once a few degrees of tilt remain -- measured at 4 degrees: "SUBTOTAL 0.80",
 * "HST 13% 25.31". Rotating the box centres by the median text angle first puts every row back.
 */
describe('assembleText follows the text angle', () => {
  function tilted(x0: number, y0: number, x1: number, y1: number, deg: number): Quad {
    const rad = (deg * Math.PI) / 180;
    const rot = (x: number, y: number) => ({ x: x * Math.cos(rad) - y * Math.sin(rad), y: x * Math.sin(rad) + y * Math.cos(rad) });
    return [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)] as const;
  }

  it('keeps each label with its own price at 5 degrees', () => {
    const rows = [
      ['SUBTOTAL', '24.51'],
      ['HST 13%', '0.80'],
      ['TOTAL', '25.31'],
    ];
    const boxes: AssemblyBox[] = rows.flatMap(([label, price], i) => [
      { quad: tilted(20, 100 + i * 30, 200, 120 + i * 30, 5), text: label, score: 0.9 },
      { quad: tilted(400, 100 + i * 30, 470, 120 + i * 30, 5), text: price, score: 0.9 },
    ]);
    expect(assembleText(boxes)).toBe('SUBTOTAL 24.51\nHST 13% 0.80\nTOTAL 25.31');
  });

  it('measures the median angle from the wide boxes and ignores the narrow ones', () => {
    const wide = [tilted(0, 0, 200, 20, 4), tilted(0, 40, 220, 60, 4), tilted(0, 80, 180, 100, 4)];
    const narrow = tilted(300, 0, 320, 60, 60);
    const boxes = [...wide, narrow].map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(4, 0);
  });
});
```

Import `medianTextAngleDeg` from the module.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/assemble.test.ts`
Expected: the tilt test FAILS (prices paired with the wrong labels, or merged lines); `medianTextAngleDeg` not exported.

- [ ] **Step 3: Implement**

In `constants.ts`, after `LINE_OVERLAP_RATIO`:

```ts
/** Ours (spec 2026-09-30 §2.4). After rotating box centres by the median text angle, two boxes
 *  share a line when their centres sit within this fraction of the median box height. */
export const LINE_CENTRE_TOLERANCE_RATIO = 0.5;
/** Ours. A box is "wide" -- a text line, not a stray glyph -- when its top edge is at least this
 *  many times its left edge. Only wide boxes vote on the text angle. */
export const LINE_WIDE_BOX_RATIO = 2;
```

Replace `assembleText` and add the helper (keep the file's header docblock, update its last sentence to mention the rotation):

```ts
function edge(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The angle the text runs at, in degrees, positive meaning down to the right: the median of the
 * top-edge angles of the WIDE boxes. Narrow boxes (a lone digit, a stray mark) do not vote -- their
 * min-area rectangle can be read either way round and their angle is noise.
 */
export function medianTextAngleDeg(boxes: readonly AssemblyBox[]): number {
  const angles: number[] = [];
  for (const { quad } of boxes) {
    const top = edge(quad[0], quad[1]);
    const left = edge(quad[0], quad[3]);
    if (top < left * LINE_WIDE_BOX_RATIO) continue;
    angles.push((Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x) * 180) / Math.PI);
  }
  return median(angles);
}

export function assembleText(boxes: readonly AssemblyBox[]): string {
  if (boxes.length === 0) return '';
  const angle = medianTextAngleDeg(boxes);
  const rad = (-angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const extents = boxes.map((box) => {
    const cx = box.quad.reduce((s, p) => s + p.x, 0) / 4;
    const cy = box.quad.reduce((s, p) => s + p.y, 0) / 4;
    return { box, cx: cx * cos - cy * sin, cy: cx * sin + cy * cos, height: edge(box.quad[0], box.quad[3]) };
  });
  extents.sort((a, b) => a.cy - b.cy);
  const tolerance = median(extents.map((e) => e.height)) * LINE_CENTRE_TOLERANCE_RATIO;

  const lines: { cy: number; items: typeof extents }[] = [];
  for (const extent of extents) {
    const current = lines[lines.length - 1];
    if (current !== undefined && Math.abs(extent.cy - current.cy) <= tolerance) {
      current.items.push(extent);
      // Running mean, so a line's centre is where its boxes are, not where its first box was.
      current.cy += (extent.cy - current.cy) / current.items.length;
    } else {
      lines.push({ cy: extent.cy, items: [extent] });
    }
  }
  return lines
    .map((line) => [...line.items].sort((a, b) => a.cx - b.cx).map((e) => e.box.text).join(LINE_JOIN))
    .join(BLOCK_JOIN);
}
```

Import the two new constants. `LINE_OVERLAP_RATIO` stays exported (another file or the pinned-table test may name it); it is simply unused here now.

- [ ] **Step 4: Run assemble (the existing level-receipt fixture tests must still pass), constants guard, harness, commit**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/assemble.test.ts tests/ops/constants.test.ts` — PASS.
Run: `npx vitest run tests/integration/ocr-accuracy.test.ts` — **B now PASSES**; D still FAILS.

```bash
git add src/lib/warranty/ocr/onnx/assemble.ts src/lib/warranty/ocr/onnx/constants.ts tests/lib/warranty/ocr/onnx/assemble.test.ts
git commit -m "fix(ocr): group lines along the text angle, not the image axis

- box centres rotated by the median wide-box angle before grouping
- a residual tilt no longer pairs each price with the line above"
```

---

### Task 6: Page orientation, 0° or 90° (spec §2.4 item 5)

**Files:**
- Create: `src/lib/warranty/ocr/onnx/orientation.ts`
- Modify: `src/lib/warranty/ocr/onnx/engine.ts:20-40`, `constants.ts`
- Create: `tests/lib/warranty/ocr/onnx/orientation.test.ts`

**Interfaces:**
- Produces: `chooseRotation(upright: readonly DetectedBox[], turned: readonly DetectedBox[]): 0 | 90` (pure); `pickPageRotation(image: RawImage, runDet: TensorRun): Promise<0 | 90>`; `rotateRaw(image: RawImage, deg: 90 | 180 | 270): Promise<RawImage>`.
- Constants: `ORIENTATION_PROBE_LONG_SIDE_PX = 640`, `ORIENTATION_WIDE_RATIO = 2`, `ORIENTATION_MIN_WIDE_BOXES = 3`, `ORIENTATION_WIN_RATIO = 1.5`.

- [ ] **Step 1: Write the failing pure test**

```ts
import { describe, it, expect } from 'vitest';
import { chooseRotation } from '@/lib/warranty/ocr/onnx/orientation';
import { rectCorners, type DetectedBox } from '@/lib/warranty/ocr/onnx/contours';

function boxes(count: number, width: number, height: number): DetectedBox[] {
  return Array.from({ length: count }, (_, i) => {
    const rect = { cx: 100, cy: 20 + i * 30, width, height, angleDeg: 0 };
    return { rect, quad: rectCorners(rect), score: 0.9 };
  });
}

/** Spec 2026-09-30 §2.4 item 5. Text lines are wide. A sideways page has tall narrow boxes upright
 *  and wide ones once turned; the turn with more wide boxes wins. */
describe('chooseRotation', () => {
  it('keeps 0 when the upright pass finds the wide boxes', () => {
    expect(chooseRotation(boxes(8, 180, 18), boxes(8, 18, 180))).toBe(0);
  });
  it('turns 90 when only the turned pass finds wide boxes', () => {
    expect(chooseRotation(boxes(8, 18, 180), boxes(8, 180, 18))).toBe(90);
  });
  it('keeps 0 when neither pass finds enough to judge', () => {
    expect(chooseRotation([], boxes(2, 180, 18))).toBe(0);
  });
  it('needs a clear margin, not a tie', () => {
    expect(chooseRotation(boxes(5, 180, 18), boxes(6, 180, 18))).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/orientation.test.ts` — FAILS: module missing.

- [ ] **Step 3: Implement**

`constants.ts`, a new `// Orientation` block after the Detection block:

```ts
// Orientation

/** Ours. The probe runs detection on a copy this size, at 0 and at 90 degrees. */
export const ORIENTATION_PROBE_LONG_SIDE_PX = 640;
/** Ours. A box counts as a text line when its horizontal extent is at least this many times its vertical one. */
export const ORIENTATION_WIDE_RATIO = 2;
/** Ours. Fewer wide boxes than this in the turned pass is not evidence of anything. */
export const ORIENTATION_MIN_WIDE_BOXES = 3;
/** Ours. The turned pass must beat the upright one by this factor to win; a tie keeps the image as it came. */
export const ORIENTATION_WIN_RATIO = 1.5;
```

`orientation.ts`:

```ts
import sharp from 'sharp';
import {
  ORIENTATION_MIN_WIDE_BOXES,
  ORIENTATION_PROBE_LONG_SIDE_PX,
  ORIENTATION_WIDE_RATIO,
  ORIENTATION_WIN_RATIO,
} from '@/lib/warranty/ocr/onnx/constants';
import type { DetectedBox } from '@/lib/warranty/ocr/onnx/contours';
import { detectBoxes } from '@/lib/warranty/ocr/onnx/detect';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
import type { TensorRun } from '@/lib/warranty/ocr/onnx/session';

/**
 * Spec 2026-09-30 §2.4 item 5. A receipt saved sideways with no EXIF tag read as garbage on both
 * engines: the line classifier only flips 0/180, and nothing asked whether the page itself was
 * turned. No new model -- detection already knows what a text line looks like (wide), so it is run
 * twice on a small copy and the turn with more wide boxes wins. Two small detections cost a
 * fraction of a second; a page read sideways cost the whole receipt.
 */
function wideCount(boxes: readonly DetectedBox[]): number {
  let count = 0;
  for (const { quad } of boxes) {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w >= h * ORIENTATION_WIDE_RATIO) count += 1;
  }
  return count;
}

/** PURE. Which way up the page is, from two detection passes. */
export function chooseRotation(upright: readonly DetectedBox[], turned: readonly DetectedBox[]): 0 | 90 {
  const w0 = wideCount(upright);
  const w90 = wideCount(turned);
  return w90 >= ORIENTATION_MIN_WIDE_BOXES && w90 > w0 * ORIENTATION_WIN_RATIO ? 90 : 0;
}

export async function rotateRaw(image: RawImage, deg: 90 | 180 | 270): Promise<RawImage> {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .rotate(deg)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function shrink(image: RawImage): Promise<RawImage> {
  const scale = Math.min(1, ORIENTATION_PROBE_LONG_SIDE_PX / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize({ width: Math.round(image.width * scale), height: Math.round(image.height * scale), fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function pickPageRotation(image: RawImage, runDet: TensorRun): Promise<0 | 90> {
  const small = await shrink(image);
  const upright = await detectBoxes(small, runDet);
  const turned = await detectBoxes(await rotateRaw(small, 90), runDet);
  return chooseRotation(upright, turned);
}
```

In `onnx/engine.ts`, after `const sessions = await getOnnxOcrSessions();`:

```ts
    // Spec 2026-09-30 §2.4 item 5: a page saved sideways is turned before detection sees it.
    const rotation = await pickPageRotation(image, sessions.runDet);
    const upright = rotation === 0 ? image : await rotateRaw(image, rotation);
    const boxes = await detectBoxes(upright, sessions.runDet);
    if (boxes.length === 0) return { text: '' };

    const crops = await cropBoxes(upright, boxes);
```

(and `image` → `upright` nowhere else is needed; crops come from `upright`). Import `pickPageRotation`, `rotateRaw`.

- [ ] **Step 4: Run the unit test, the fake-session engine tests, the constants guard, then the harness**

Run: `npx vitest run tests/lib/warranty/ocr/onnx/orientation.test.ts tests/lib/warranty/ocr/onnx/engine.test.ts tests/integration/ocr-engine.test.ts tests/ops/constants.test.ts tests/ops/ocr-egress.test.ts`
Expected: PASS. The fake `runDet` in `tests/integration/ocr-engine.test.ts` returns one horizontal bar whatever the input, so the probe's turned pass sees a tall bar and `chooseRotation` keeps 0 — no fixture change needed. If `engine.test.ts`'s fake det is called a fixed number of times, it now sees two extra calls; update that count and say so in the commit.

Run: `npx vitest run tests/integration/ocr-accuracy.test.ts` — **all four PASS.**

```bash
git add src/lib/warranty/ocr/onnx/orientation.ts src/lib/warranty/ocr/onnx/engine.ts src/lib/warranty/ocr/onnx/constants.ts tests/lib/warranty/ocr/onnx/orientation.test.ts
git commit -m "feat(ocr): turn a sideways page before detection

- detection on a small copy at 0 and 90; the turn with more wide boxes wins
- no new model; the line classifier still handles 180"
```

---

### Task 7: The Tesseract fallback gets the preprocessed image (spec §2.4 item 6)

**Files:**
- Modify: `src/lib/warranty/ocr/onnx/preprocess.ts` (export `preprocessReceiptPng`), `src/lib/warranty/ocr/tesseract.ts:75-79`
- Test: `tests/lib/warranty/ocr/engine-options.test.ts` (if it pins `recognize(filePath)`), `tests/lib/warranty/ocr/onnx/preprocess.test.ts`

- [ ] **Step 1: Write the failing tests**

In `preprocess.test.ts`:

```ts
  it('exports the deskewed greyscale PNG for the tesseract path, same pipeline, encoded', async () => {
    const png = await preprocessReceiptPng(await writePng(await barGridPng(4)));
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.channels).toBeGreaterThanOrEqual(1);
  });
```

(`writePng` is whatever temp-file helper that file already uses for `preprocessReceipt(filePath)`.)

In the tesseract test that stubs the worker (`grep -rln "setOcrWorkerForTests" tests/lib/warranty/ocr`), add:

```ts
  it('hands the worker the preprocessed PNG buffer, not the raw file path (spec 2026-09-30 §2.4 item 6)', async () => {
    const seen: unknown[] = [];
    setOcrWorkerForTests({ recognize: async (input) => { seen.push(input); return { data: { text: 'x' } }; }, terminate: async () => {} });
    await recognizeWithTesseract(fixturePath);
    expect(Buffer.isBuffer(seen[0])).toBe(true);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Expected: `preprocessReceiptPng` not exported; the worker receives a string path.

- [ ] **Step 3: Implement**

In `preprocess.ts`, refactor the tail of `preprocessReceipt` so the deskewed sharp pipeline is built once:

```ts
async function preparedPipeline(filePath: string): Promise<sharp.Sharp> {
  /* …everything preprocessReceipt does today up to and including the `deskewed` const… */
  return deskewed;
}

export async function preprocessReceipt(filePath: string): Promise<RawImage> {
  const { data, info } = await (await preparedPipeline(filePath))
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Spec 2026-09-30 §2.4 item 6. The same EXIF-rotate, flatten, greyscale, normalise, resize and
 * deskew the ONNX path gets, encoded for a recogniser that takes a file. Measured on the photo
 * case: the date went from wrong to right and the time halved.
 */
export async function preprocessReceiptPng(filePath: string): Promise<Buffer> {
  return (await preparedPipeline(filePath)).png().toBuffer();
}
```

In `tesseract.ts`:

```ts
import { preprocessReceiptPng } from '@/lib/warranty/ocr/onnx/preprocess';

export async function recognizeWithTesseract(filePath: string): Promise<string> {
  const active = await getWorker();
  // The tesseract path used to receive the raw upload with no preprocessing at all -- the only
  // engine in the app that did. preprocess.ts imports sharp and nothing from onnxruntime, so
  // reaching it from here adds no ORT import (tests/ops/ocr-egress.test.ts).
  const result = await active.recognize(await preprocessReceiptPng(filePath));
  return result.data.text;
}
```

If `TesseractWorkerLike.recognize` is typed to take `string`, widen it to `string | Buffer`.

- [ ] **Step 4: Run, commit**

Run: `npx vitest run tests/lib/warranty/ocr/ tests/ops/ocr-egress.test.ts` — PASS.

```bash
git add src/lib/warranty/ocr/onnx/preprocess.ts src/lib/warranty/ocr/tesseract.ts tests/lib/warranty/ocr
git commit -m "fix(ocr): the tesseract fallback reads the preprocessed image

- same rotate/flatten/greyscale/normalise/deskew as the ONNX path, as PNG"
```

---

### Task 8: PDF text as lines, with a page cap (spec §2.2)

**Files:**
- Modify: `src/lib/warranty/ocr/pdf.ts`
- Test: `tests/lib/warranty/ocr/pdf.test.ts`

**Interfaces:**
- Produces: `MAX_PDF_PAGES = 20`; `PDF_LINE_TOLERANCE_RATIO = 0.5`; `linesFromItems(items: PdfTextItem[]): string[]` (exported, pure) where `PdfTextItem = { str: string; x: number; y: number; height: number; hasEOL: boolean }`.

- [ ] **Step 1: Write the failing tests**

Extend `buildMinimalPdf` in the test to take positioned runs and pages:

```ts
type Run = { x: number; y: number; text: string };
function contentFor(runs: Run[]): string {
  return runs.map((run) => `BT /F1 12 Tf ${run.x} ${run.y} Td (${run.text.replace(/([()\\])/g, '\\$1')}) Tj ET`).join('\n');
}
/** One page per inner array. The old single-string form is `buildMinimalPdf([[{x:10,y:100,text}]])`. */
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
  /* …then the same xref/trailer assembly the existing builder does… */
}
```

(Keep the existing `buildMinimalPdf(text)` as a one-liner over `buildPdf` so the two existing tests are untouched.) Append:

```ts
/** Spec 2026-09-30 §2.2. Items are grouped into LINES by position; one paragraph per page broke every line-based heuristic. */
describe('extractPdfText reads lines', () => {
  it('puts items at different heights on different lines, top first', async () => {
    const file = path.join(dir, 'two.pdf');
    fs.writeFileSync(file, buildPdf([[{ x: 10, y: 200, text: 'RIVERSIDE WATER' }, { x: 10, y: 100, text: 'Amount due 312.44' }]]));
    expect(await extractPdfText(file)).toBe('RIVERSIDE WATER\nAmount due 312.44');
  });

  /** Review focus 3: a two-column bill -- label left, figure right, same height. */
  it('reads a two-column bill, left to right on one line', async () => {
    const file = path.join(dir, 'cols.pdf');
    fs.writeFileSync(
      file,
      buildPdf([[
        { x: 10, y: 200, text: 'Amount due' },
        { x: 250, y: 200, text: '$312.44' },
        { x: 10, y: 170, text: 'Due date' },
        { x: 250, y: 170, text: '2026-11-24' },
      ]]),
    );
    expect(await extractPdfText(file)).toBe('Amount due $312.44\nDue date 2026-11-24');
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
```

Import `MAX_PDF_PAGES`, `linesFromItems`.

- [ ] **Step 2: Run them to verify they fail**

Expected: the two-line test gets one line; `MAX_PDF_PAGES` not exported.

- [ ] **Step 3: Implement**

```ts
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
```

In `extractPdfText`, replace the per-page body:

```ts
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
```

- [ ] **Step 4: Run, commit**

Run: `npx vitest run tests/lib/warranty/ocr/pdf.test.ts tests/lib/warranty/ocr/engine.test.ts` — PASS.

```bash
git add src/lib/warranty/ocr/pdf.ts tests/lib/warranty/ocr/pdf.test.ts
git commit -m "fix(ocr): a PDF's text layer comes back as lines, capped at 20 pages

- items grouped by baseline, left to right, hasEOL breaks
- one paragraph per page had defeated every line-based heuristic"
```

---

### Task 9: The extractor stops guessing and learns due dates (spec §2.3)

**Files:**
- Modify: `src/lib/warranty/suggest.ts`
- Test: `tests/lib/warranty/suggest.test.ts`

**Interfaces:**
- Produces: `SuggestedFields.dueDate?: string`; `suggestDueDate(text, today): string | undefined`; `AmountCandidate { valueCents; snippet; score }`, `DateCandidate { date; snippet; score }`; `amountCandidates(text): AmountCandidate[]` (≤ 6); `dateCandidates(text, today): DateCandidate[]` (≤ 6); `suggestFromOcrText` fills `dueDate`. `suggestPriceCents` returns `undefined` when no total-like line exists (fallback deleted).
- Internals: the date scanning loop is extracted into `findDates(text): { iso: string; index: number }[]` with no today-bound; `suggestPurchaseDate` applies its existing bounds over it.

- [ ] **Step 1: Write the failing tests**

Append to `suggest.test.ts`:

```ts
/** Spec 2026-09-30 §2.3. Never guess, always show. */
describe('suggestPriceCents without the fallback', () => {
  it('prefers the TOTAL line over a larger CASH line (review focus 4)', () => {
    expect(suggestPriceCents(['SUBTOTAL 42.00', 'TOTAL 47.32', 'CASH 100.00', 'CHANGE 52.68'].join('\n'))).toBe(4732);
  });
  it('suggests nothing when no total-like line exists, rather than the largest number anywhere', () => {
    expect(suggestPriceCents(['MILK 6.49', 'BREAD 3.79', 'CASH 100.00'].join('\n'))).toBeUndefined();
  });
  it('reads a misrecognised TOTAL and the words a bill uses', () => {
    expect(suggestPriceCents('T0TAL 25.31')).toBe(2531);
    expect(suggestPriceCents('IOTAL 25.31')).toBe(2531);
    expect(suggestPriceCents('Amount due $312.44')).toBe(31244);
    expect(suggestPriceCents('Montant 12,50')).toBe(1250);
  });
  it('never takes a payment line as the total even when it says total', () => {
    expect(suggestPriceCents(['TOTAL 47.32', 'VISA TOTAL TENDERED 100.00'].join('\n'))).toBe(4732);
  });
});

describe('suggestDueDate', () => {
  it('finds the due date on its own line, in the future (review focus 3)', () => {
    const text = ['RIVERSIDE WATER', 'Billing period 2026-08-04 to 2026-11-03', 'Amount due $312.44', 'Due date 2026-11-24'].join('\n');
    expect(suggestDueDate(text, '2026-11-07')).toBe('2026-11-24');
  });
  it('accepts the words a bill prints, English and French', () => {
    expect(suggestDueDate('Payable by Oct 31, 2026', '2026-09-20')).toBe('2026-10-31');
    expect(suggestDueDate("Date d'échéance 2026-10-31", '2026-09-20')).toBe('2026-10-31');
  });
  it('ignores a date more than eighteen months out or a year past, and finds nothing on a receipt', () => {
    expect(suggestDueDate('Due date 2029-01-01', '2026-09-20')).toBeUndefined();
    expect(suggestDueDate('DATE: 2026-09-14 TOTAL 25.31', '2026-09-20')).toBeUndefined();
  });
});

describe('candidates carry the words around them', () => {
  const bill = ['RIVERSIDE WATER', 'Water charges 141.07', 'Sewer charges 171.89', 'Total current charges $312.96', 'Amount due $312.44', 'Due date 2026-11-24', 'Amount due after due date $328.06'].join('\n');
  it('ranks the amount-due line first and keeps each figure once with its snippet', () => {
    const amounts = amountCandidates(bill);
    expect(amounts[0]).toMatchObject({ valueCents: 31244 });
    expect(amounts[0].snippet).toContain('Amount due');
    expect(amounts.length).toBeLessThanOrEqual(6);
    expect(new Set(amounts.map((c) => c.valueCents)).size).toBe(amounts.length);
  });
  it('ranks the due-date line first among dates', () => {
    const dates = dateCandidates(bill, '2026-11-07');
    expect(dates[0]).toMatchObject({ date: '2026-11-24' });
    expect(dates[0].snippet).toContain('Due date');
  });
  it('suggestFromOcrText carries the due date', () => {
    expect(suggestFromOcrText(bill, '2026-11-07')).toMatchObject({ vendor: 'RIVERSIDE WATER', priceCents: 31244, dueDate: '2026-11-24' });
  });
});
```

Import `suggestDueDate`, `amountCandidates`, `dateCandidates`. Also find the existing test that asserted the fallback (grep `largest` or a case expecting a price with no total line) and **delete or invert it** — that behaviour is gone by decision; say so in the commit.

- [ ] **Step 2: Run to verify failures**

Expected: new exports missing; the fallback test (`CASH 100.00` with no total) returns 10000.

- [ ] **Step 3: Implement**

Replace the regexes and `suggestPriceCents`; add the rest:

```ts
export interface SuggestedFields {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  /** Spec 2026-09-30 §2.3. A bill's due date, which may be in the future. */
  dueDate?: string;
}

/** Spec 2026-09-30 §2.3. A figure or a date with enough context for a person to judge it. */
export interface AmountCandidate { valueCents: number; snippet: string; score: number }
export interface DateCandidate { date: string; snippet: string; score: number }
export const MAX_CANDIDATES = 6;
export const MAX_DUE_DATE_MONTHS_AHEAD = 18;
export const MAX_DUE_DATE_MONTHS_BEHIND = 12;

const CURRENCY_RE = /(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/g;
/** Fuzzy on purpose: PP-OCR reads T0TAL and IOTAL for TOTAL often enough to matter. French for bilingual bills. */
const TOTAL_LINE_RE = /\b(t[o0]tal|[ti1]otal|amount\s+due|grand\s+total|balance\s+due|total\s+due|montant|solde)\b/i;
const SUBTOTAL_RE = /\bsub[\s-]?total\b|\bsous[\s-]?total\b/i;
/** A line about how the bill was PAID is never the total, whatever else it says. */
const PAYMENT_LINE_RE = /\b(cash|change|tender(?:ed)?|tip|gratuity|approved|payment|cash\s*back|visa|mastercard|amex|debit|interac)\b/i;
const DUE_LINE_RE = /\b(due\s+date|date\s+due|due\s+by|due\s+on|payable\s+by|pay\s+by|échéance|echeance)\b/i;

function isTotalLine(line: string): boolean {
  return TOTAL_LINE_RE.test(line) && !SUBTOTAL_RE.test(line) && !PAYMENT_LINE_RE.test(line);
}

export function suggestPriceCents(text: string): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  // The LAST qualifying line, and the last valid figure on it. No fallback: with no total line
  // there is no total, and a blank field a person fills beats a confident wrong one (PENDING-FIXES
  // item G, now adopted). "Confidently wrong is the worst output a suggester can produce."
  const totalLines = text.split(/\r?\n/).filter(isTotalLine);
  const lastTotalLine = totalLines[totalLines.length - 1];
  if (lastTotalLine === undefined) return undefined;
  const matches = [...lastTotalLine.matchAll(CURRENCY_RE)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const cents = centsOf(matches[i][1], matches[i][2]);
    if (cents !== null) return cents;
  }
  return undefined;
}

export function suggestDueDate(text: string, today: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const floor = addMonthsClamped(today, -MAX_DUE_DATE_MONTHS_BEHIND);
  const ceiling = addMonthsClamped(today, MAX_DUE_DATE_MONTHS_AHEAD);
  for (const line of text.split(/\r?\n/)) {
    if (!DUE_LINE_RE.test(line)) continue;
    const found = findDates(line).find((d) => d.iso >= floor && d.iso <= ceiling);
    if (found !== undefined) return found.iso;
  }
  return undefined;
}

const snippetOf = (line: string) => line.trim().slice(0, 60);

export function amountCandidates(text: string): AmountCandidate[] {
  const best = new Map<number, AmountCandidate>();
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(CURRENCY_RE)];
    matches.forEach((m, i) => {
      const cents = centsOf(m[1], m[2]);
      if (cents === null) return;
      let score = 0;
      if (isTotalLine(line)) score += 3;
      if (PAYMENT_LINE_RE.test(line)) score -= 3;
      if (SUBTOTAL_RE.test(line) || /\b(hst|gst|pst|tax|tvq|tps)\b/i.test(line)) score -= 2;
      if (i === matches.length - 1) score += 1;
      const prior = best.get(cents);
      if (prior === undefined || score > prior.score) best.set(cents, { valueCents: cents, snippet: snippetOf(line), score });
    });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.valueCents - a.valueCents).slice(0, MAX_CANDIDATES);
}

export function dateCandidates(text: string, today: string): DateCandidate[] {
  const floor = addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS);
  const ceiling = addMonthsClamped(today, MAX_DUE_DATE_MONTHS_AHEAD);
  const best = new Map<string, DateCandidate>();
  let first = true;
  for (const line of text.split(/\r?\n/)) {
    for (const found of findDates(line)) {
      if (found.iso < floor || found.iso > ceiling) continue;
      let score = DUE_LINE_RE.test(line) ? 3 : 0;
      if (first) score += 1;
      first = false;
      const prior = best.get(found.iso);
      if (prior === undefined || score > prior.score) best.set(found.iso, { date: found.iso, snippet: snippetOf(line), score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, MAX_CANDIDATES);
}
```

Refactor the existing date code: the body of `suggestPurchaseDate` that scans ISO / slash / dash / "DD Mon YYYY" / "Mon D, YYYY" shapes and builds ISO strings becomes `function findDates(text): { iso: string; index: number }[]` returning every valid calendar date it sees with its index (no today check). `suggestPurchaseDate(text, today)` becomes: `findDates(text).filter(d => d.iso <= today && d.iso >= addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS)).sort((a,b) => a.index - b.index)[0]?.iso`. Every existing `suggestPurchaseDate` test must still pass unchanged — that is the refactor's gate.

`suggestFromOcrText` adds:

```ts
  const dueDate = suggestDueDate(text, today);
  if (dueDate !== undefined) out.dueDate = dueDate;
```

- [ ] **Step 4: Run suggest, the assemble fixture test (it calls suggestFromOcrText), the harness, commit**

Run: `npx vitest run tests/lib/warranty/suggest.test.ts tests/lib/warranty/ocr/onnx/assemble.test.ts tests/integration/ocr-accuracy.test.ts` — PASS.

```bash
git add src/lib/warranty/suggest.ts tests/lib/warranty/suggest.test.ts
git commit -m "feat(ocr): the extractor stops guessing and learns due dates

- the largest-number-anywhere fallback is gone; no total line, no total
- payment lines excluded; TOTAL matched fuzzily, French included
- suggestDueDate; amount and date candidates with their snippets"
```

---

### Task 10: The sidecar carries lines and candidates; an empty read is a failure (spec §2.3)

**Files:**
- Modify: `src/lib/warranty/staging.ts:28-56` (sidecar type + schema), `src/lib/warranty/ocr/engine.ts` (two constants), `src/lib/warranty/ocr/queue.ts:187-236`, `src/app/api/warranties/receipts/stage/[stagingId]/route.ts`
- Test: `tests/lib/warranty/ocr/queue.test.ts`, the poll-route test (`grep -rln "stagingId" tests/app tests/api 2>/dev/null`)

**Interfaces:**
- Produces: `OcrSidecar.lines?: string[]`, `OcrSidecar.candidates?: { amounts: AmountCandidate[]; dates: DateCandidate[] }`; `suggestedFieldsSchema` gains `dueDate`; `OCR_LINES_MAX = 200`; `NO_TEXT_MESSAGE = 'No text was found on this image. Try a flatter, closer photo, or attach the PDF.'`.
- Produces: poll route `done` body `{ status, suggestions, lines, candidates }`.

- [ ] **Step 1: Write the failing tests**

In `queue.test.ts`, beside `'writes a done sidecar with the raw text and the suggestions'`:

```ts
  it('writes the lines and the candidates beside the suggestions (spec 2026-09-30 §2.3)', async () => {
    /* same setup as the test above, with the fake engine returning 'RIVERSIDE WATER\nAmount due $312.44\nDue date 2026-11-24' */
    const sidecar = readSidecar(stagingId);
    expect(sidecar?.lines).toEqual(['RIVERSIDE WATER', 'Amount due $312.44', 'Due date 2026-11-24']);
    expect(sidecar?.candidates?.amounts[0]).toMatchObject({ valueCents: 31244 });
    expect(sidecar?.suggestions?.dueDate).toBe('2026-11-24');
  });

  it('records an empty read as a failure with a message, never as done (spec §2.3)', async () => {
    /* fake engine returning '' */
    expect(readSidecar(stagingId)).toEqual({ status: 'failed', error: NO_TEXT_MESSAGE });
  });
```

(Adapt the setup to the file's existing fake-engine idiom; import `NO_TEXT_MESSAGE` from `@/lib/warranty/ocr/engine`.) In the poll-route test, add a case asserting the `done` body carries `lines` and `candidates` when the sidecar has them.

- [ ] **Step 2: Run to verify failures**

Expected: `lines` undefined on the sidecar; the empty read is `done`.

- [ ] **Step 3: Implement**

`engine.ts`:

```ts
/** Spec 2026-09-30 §2.3. What the poll endpoint hands the client to show; the FTS index keeps the whole text. */
export const OCR_LINES_MAX = 200;
export const NO_TEXT_MESSAGE = 'No text was found on this image. Try a flatter, closer photo, or attach the PDF.';
```

`staging.ts`: extend the interface and schema:

```ts
export interface OcrSidecar {
  status: 'done' | 'failed';
  text?: string;
  error?: string;
  suggestions?: SuggestedFields;
  lines?: string[];
  candidates?: { amounts: AmountCandidate[]; dates: DateCandidate[] };
}
const suggestedFieldsSchema = z.object({ purchaseDate: z.string().optional(), vendor: z.string().optional(), priceCents: z.number().optional(), dueDate: z.string().optional() });
const amountCandidateSchema = z.object({ valueCents: z.number(), snippet: z.string(), score: z.number() });
const dateCandidateSchema = z.object({ date: z.string(), snippet: z.string(), score: z.number() });
const ocrSidecarSchema = z.object({
  status: z.enum(['done', 'failed']),
  text: z.string().optional(),
  error: z.string().optional(),
  suggestions: suggestedFieldsSchema.optional(),
  lines: z.array(z.string()).optional(),
  candidates: z.object({ amounts: z.array(amountCandidateSchema), dates: z.array(dateCandidateSchema) }).optional(),
});
```

`queue.ts` `runStagedJob`:

```ts
    const { text } = await recognizeWithTimeout(staged.path, staged.mime);
    const { text: capped } = truncateOcrText(text);
    // Spec 2026-09-30 §2.3: zero boxes used to be stored as 'done' with '' and the tile said "Read".
    if (capped.trim().length === 0) {
      writeSidecar(stagingId, { status: 'failed', error: NO_TEXT_MESSAGE });
      return;
    }
    const today = todayIso();
    writeSidecar(stagingId, {
      status: 'done',
      text: capped,
      suggestions: suggestFromOcrText(capped, today),
      lines: capped.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).slice(0, OCR_LINES_MAX),
      candidates: { amounts: amountCandidates(capped), dates: dateCandidates(capped, today) },
    });
```

`runReceiptJob`: after `truncateOcrText`, `if (capped.trim().length === 0) { update ocrStatus 'failed', ocrText null, ocrError NO_TEXT_MESSAGE; return; }`.

The poll route's `done` branch:

```ts
  return Response.json({ status: 'done', suggestions: sidecar.suggestions ?? {}, lines: sidecar.lines ?? [], candidates: sidecar.candidates ?? { amounts: [], dates: [] } });
```

Rewrite the route's docblock sentence about raw text: *"The recognised LINES are returned (capped at OCR_LINES_MAX) so the person can see what was read and tap the figure they meant; spec §16 item 6 deferred EDITING the text, not showing it. Owner-scoped like everything else here (D7)."*

- [ ] **Step 4: Run, commit**

Run: `npx vitest run tests/lib/warranty/ocr/queue.test.ts tests/lib/warranty/ocr/onnx/engine.test.ts tests/app/` (the route test) — PASS. `engine.test.ts`'s `'empty-detection returns ""'` still holds: the engine returns `''`; the queue is what now calls it a failure.

```bash
git add src/lib/warranty/staging.ts src/lib/warranty/ocr/engine.ts src/lib/warranty/ocr/queue.ts "src/app/api/warranties/receipts/stage/[stagingId]/route.ts" tests
git commit -m "feat(ocr): the poll reply carries what was read and the figures found

- sidecar gains lines and candidates; dueDate joins the suggestions
- an empty read is a failure with a message, never a silent Read"
```

---

### Task 11: The uploader shows the read, offers chips, retries, and says why a scan fell back (spec §2.3, §2.5)

**Files:**
- Modify: `src/components/warranty/ReceiptUploader.tsx`, `src/components/warranty/ReceiptScanPreview.tsx:40,55`, `src/lib/scanner/scan.ts`, `src/lib/warranty/ocr/onnx/constants.ts` (scanner constants)
- Test: `tests/components/ReceiptUploader.test.tsx`, `tests/app/receipt-scanner.test.tsx`, `tests/lib/scanner/scan-run.test.ts`

**Interfaces:**
- `SuggestedFieldsDto` gains `dueDate?: string`. `StagedFile` gains `lines?: string[]`, `candidates?: { amounts: AmountCandidate[]; dates: DateCandidate[] }`.
- Props gain `onPickAmount?: (cents: number) => void`, `onPickDate?: (iso: string) => void`.
- `ScanResult` gains `reason?: 'no-paper' | 'bad-quad' | 'too-large'`; constants `SCANNER_MIN_QUAD_AREA_RATIO = 0.08`, new `SCANNER_MAX_QUAD_AREA_RATIO = 0.97`, `SCANNER_AUTO_ACCEPT_MS = 8000`.
- Copy: `SCANNER_NO_PAPER_MESSAGE = "Couldn't find the paper edges — using the whole photo."`; `SCAN_SUMMARY_NOTHING = 'Read, but found no vendor, date or amount — check the text below.'`; the summary builder `summaryOf(fields)` → `` `Filled ${list}.` `` or with ` — no total found` appended when `priceCents` is missing; `'What was read'` is the `<summary>` text; `'Try again'` the retry button.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/scanner/scan-run.test.ts` (or wherever `isUsableQuad` is tested): a tall narrow quad covering 12% of the frame is now usable; a quad covering 99% is not. In `tests/components/ReceiptUploader.test.tsx`:

```ts
  it('shows what was read under the tile and offers the figures as chips', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(stageResponse())
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'done', suggestions: { vendor: 'RIVERSIDE WATER', priceCents: 31244 }, lines: ['RIVERSIDE WATER', 'Amount due $312.44'], candidates: { amounts: [{ valueCents: 31244, snippet: 'Amount due $312.44', score: 4 }, { valueCents: 32806, snippet: 'Amount due after due date $328.06', score: 1 }], dates: [{ date: '2026-11-24', snippet: 'Due date 2026-11-24', score: 4 }] } }) }));
    const onPickAmount = vi.fn();
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} onPickAmount={onPickAmount} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'bill.pdf', { type: 'application/pdf' })] } });
    await screen.findByText('Filled vendor, amount.');
    fireEvent.click(screen.getByText('What was read'));
    expect(screen.getByText('Amount due $312.44')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /\$328\.06/ }));
    expect(onPickAmount).toHaveBeenCalledWith(32806);
  });

  it('says when nothing could be filled, and offers Try again on a failed read', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(stageResponse())
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'failed', error: 'No text was found on this image. Try a flatter, closer photo, or attach the PDF.' }) }));
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'bill.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByText(/No text was found on this image/)).toBeTruthy();
  });

  /** Review focus 5: the first receipt to finish used to clear the shared notice for all of them. */
  it('keeps the notice while another receipt is still reading', async () => {
    const stage = {
      ok: true,
      json: async () => ({
        staged: [
          { stagingId: 's1', originalFilename: 'a.pdf', mime: 'application/pdf', sizeBytes: 1, sha256: 'a'.repeat(64) },
          { stagingId: 's2', originalFilename: 'b.pdf', mime: 'application/pdf', sizeBytes: 1, sha256: 'b'.repeat(64) },
        ],
      }),
    } as Response;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/stage')) return Promise.resolve(stage);
      if (url.endsWith('/s1')) return Promise.resolve({ ok: true, json: async () => ({ status: 'done', suggestions: { vendor: 'A' }, lines: ['A'], candidates: { amounts: [], dates: [] } }) } as Response);
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
    expect(screen.getByText(READING_MESSAGE)).toBeTruthy();
  });

  it('offers a second input without capture so a phone can pick a PDF', () => {
    const { container } = render(<ReceiptUploader onStagedChange={vi.fn()} />);
    const inputs = container.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute('capture')).toBe('environment');
    expect(inputs[1].hasAttribute('capture')).toBe(false);
  });
```

In `tests/app/receipt-scanner.test.tsx`, add: when `scanReceiptFile` resolves `{ file, reason: 'no-paper' }`, the text `Couldn't find the paper edges — using the whole photo.` appears.

- [ ] **Step 2: Run to verify failures**

Expected: no chips, no second input, no reason notice, one input.

- [ ] **Step 3: Implement**

`constants.ts`: `SCANNER_MIN_QUAD_AREA_RATIO` → `0.08` with the comment corrected ("A sliver of the frame is a countertop edge, not paper; a long receipt shot whole fills 10-20 percent of a 3:4 frame and must pass"); add `export const SCANNER_MAX_QUAD_AREA_RATIO = 0.97; /** A quad hugging the full frame is the photo's border, not paper -- the ceiling the old comment described. */`; `SCANNER_AUTO_ACCEPT_MS` → `8000`.

`scan.ts`: `isUsableQuad` adds `if (Math.abs(area) / 2 > workWidth * workHeight * SCANNER_MAX_QUAD_AREA_RATIO) return false;`. `ScanResult` gains `reason?`; the `return { file }` sites become `{ file, reason: 'no-paper' }` (null contour), `{ file, reason: 'bad-quad' }` (quad fails), `{ file, reason: 'too-large' }` (byte cap); the WebAssembly/createImageBitmap bails stay reason-less.

`ReceiptScanPreview.tsx`: `max-h-40` → `max-h-64` on both images.

`ReceiptUploader.tsx`:
- `decide()`: after `result = await scanReceiptFile(original)`, `if (result.corrected === undefined && result.reason !== undefined) setNotice(SCANNER_NO_PAPER_MESSAGE);`.
- Keep an `originalsRef = useRef(new Map<string, File>())`; in `upload`, after staging, `originalsRef.current.set(entry.stagingId, chosen[index])`. `retry(stagingId)`: `const file = originalsRef.current.get(stagingId); remove(stagingId); if (file) void upload([file]);`.
- Track pending count for the notice: `const readingRef = useRef(new Set<string>())`; add on poll start, delete on resolve; `setNotice(null)` only when the set is empty, else leave `READING_MESSAGE`.
- On `done`: store `lines`, `candidates`, `suggestions` on the tile; set the per-tile summary: `summaryOf(body.suggestions ?? {})`:

```ts
export function summaryOf(fields: SuggestedFieldsDto): string {
  const filled = [fields.vendor ? 'vendor' : null, fields.purchaseDate || fields.dueDate ? 'date' : null, fields.priceCents !== undefined ? 'amount' : null].filter((x): x is string => x !== null);
  if (filled.length === 0) return SCAN_SUMMARY_NOTHING;
  return `Filled ${filled.join(', ')}${fields.priceCents === undefined ? ' — no total found' : ''}.`;
}
```

- Render, per tile, after the status line: the summary `<p>`; a `<details><summary>What was read</summary><ol>…lines…</ol></details>` when `lines.length > 0`; chips: `candidates.amounts.map(c => <button type="button" onClick={() => onPickAmount?.(c.valueCents)} title={c.snippet}>{formatCents(c.valueCents)}<span>{c.snippet}</span></button>)` and the same for dates with `onPickDate`, styled like `reconcile-loan-form.tsx:341-378`'s chips; on `failed`, a `Try again` button beside Remove.
- A second `<input type="file" accept="image/*,application/pdf" multiple disabled={busy} onChange={…same handler…}>` under a label `Choose a file or PDF`, rendered after the camera input.

Wire the new props: in `new-warranty-client.tsx` pass `onPickAmount={(c) => { kind-routed exactly like onSuggestions' price branch }}` and `onPickDate={(d) => installmentsAllowedForKind(kind) ? setDueDate(d) : setPurchaseDate(d)}`; in the detail client pass `onPickAmount={(c) => setNewAmount(centsToInput(c))}` and `onPickDate={setNewDueDate}` for a bill.

- [ ] **Step 4: Run the three test files, the viewfinder and scanner-assets guards, commit**

Run: `npx vitest run tests/components/ReceiptUploader.test.tsx tests/app/receipt-scanner.test.tsx tests/lib/scanner/ tests/ops/no-viewfinder.test.ts tests/ops/constants.test.ts tests/app/new-warranty-client.test.tsx tests/app/warranty-detail-client.test.tsx` — PASS.

```bash
git add src/components/warranty src/lib/scanner/scan.ts src/lib/warranty/ocr/onnx/constants.ts "src/app/(app)/warranties" tests
git commit -m "feat(receipts): show what was read, offer the figures, say why a scan fell back

- lines under the tile; amount and date chips with their snippets
- Try again on a failed read; the notice waits for every receipt
- a second file input without capture, so a phone can pick a PDF
- quad floor 8 percent, ceiling 97; preview larger; countdown 8 s"
```

---

### Task 12: Copy and docs (spec §2.5)

**Files:**
- Modify: `src/app/(app)/warranties/new/new-warranty-client.tsx:227`, `src/app/(app)/help/content.tsx:376-388`, `README.md:39-46`

- [ ] **Step 1: Make the three edits**

Receipt card description: `"Photograph it or attach a PDF. Reading happens on this machine — nothing leaves your network."`

Help, replace the third paragraph of the Loans & Coverage section with:

```tsx
        <P>
          That reading happens on your own server. The recognition models ship inside the app, no
          image or text leaves your network to interpret a receipt, and it works on an install with{' '}
          <B>no internet connection at all</B>. A photo is straightened in your browser first when
          the paper's edges can be found; when they cannot, the whole photo is used and the page
          says so. Under each receipt you can open <B>What was read</B> to see the text and tap
          the figure you meant. A PDF with a text layer is read directly; a scanned PDF is not yet
          supported — photograph the page instead.
        </P>
```

README: in the warranties paragraph, after the OCR sentence, add: *"What the reader found is shown under each receipt, and a bill's amount due and due date are filled in from the e-bill you attach."*

- [ ] **Step 2: Run the help guards, commit**

Run: `npx vitest run tests/app/help.test.tsx tests/ops/onboarding-coverage.test.ts tests/app/new-warranty-client.test.tsx` — PASS.

```bash
git add "src/app/(app)/warranties/new/new-warranty-client.tsx" "src/app/(app)/help/content.tsx" README.md
git commit -m "docs: what the receipt reader does and where it runs"
```

---

### Task 13: Release v1.53.0

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → `## [1.53.0] - YYYY-MM-DD`), `package.json`, `tests/ops/docker.test.ts:477-490` and the 22 `toBe('1.52.0')` pins

- [ ] **Step 1: Update the guard first**

Replace the `'MUST-7.1: the 1.52.0 release'` test with:

```ts
  it('MUST-7.1: the 1.53.0 release', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(pkg.version).toBe('1.53.0');
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.53\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(changelog.indexOf('## Unreleased')).toBeLessThan(changelog.indexOf('## [1.53.0]'));
    expect(changelog.indexOf('## [1.53.0]')).toBeLessThan(changelog.indexOf('## [1.52.0]'));
    const current = changelog.slice(changelog.indexOf('## [1.53.0]'), changelog.indexOf('## [1.52.0]'));
    expect(current).toMatch(/Amount due/);
    expect(current).toMatch(/What was read/);
    expect(current).toMatch(/tilted/i);
  });

  it('MUST-7.1: the 1.52.0 release is still recorded intact (append-only discipline)', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(/^## \[1\.52\.0\] - 2026-09-28$/m);
    const current = changelog.slice(changelog.indexOf('## [1.52.0]'), changelog.indexOf('## [1.51.0]'));
    expect(current).toMatch(/Last import/);
    expect(current).toMatch(/Confirm every group/);
  });
```

Then every remaining `toBe('1.52.0')` → `'1.53.0'`.

- [ ] **Step 2: Run it to verify it fails**, then **write the changelog and bump**

CHANGELOG, under a fresh empty `## Unreleased`:

```markdown
## [1.53.0] - YYYY-MM-DD

### Added

- **A bill asks for its amount.** Adding a bill now takes **Amount due** and **Due date** and writes
  them as its first installment. A plan with several dates adds the rest on the bill's page; a bill
  that comes back each cycle takes the next from the e-bill you attach. The list row shows the next
  amount beside the due date, and how many are unpaid with the total when there are several; the
  bill's page leads with its next payment.
- **You can see what the receipt reader read.** Under each receipt, **What was read** opens the text
  line by line, and the amounts and dates it found are offered as buttons with the words around
  them — tap the one you meant. A read that finds nothing now says so instead of showing "Read".
- A second file control on the receipt card, so a phone can pick an existing photo or a PDF rather
  than only opening the camera.
- An attached e-bill fills a bill's amount due and due date — on the add form and on the bill's own
  page.

### Fixed

- **A tilted phone photo of a receipt reads.** Three faults in the image pipeline, each measured on
  rendered receipts: detection boxes were scored over their bounding box instead of their polygon,
  so every long line at a few degrees of tilt was thrown away; the crop window was not rotated
  with the image, so lines were cut and digits dropped; and a dark countertop was taken for ink,
  so the deskew turned a level receipt ten degrees. Lines are now grouped along the text angle, a
  page saved sideways is turned before reading, and the fallback engine gets the same
  preprocessing. A photo that read 86 percent of its characters wrong reads every word.
- **An e-bill PDF reads as lines**, not as one paragraph per page, so the vendor, total and dates
  are found. Reading stops at twenty pages.
- The receipt reader no longer guesses a total from the largest number on the page. No total line,
  no total — a blank you fill beats a wrong figure you have to notice.
- The browser crop no longer rejects a long receipt photographed whole; the preview is larger and
  the countdown longer; a scan that falls back to the whole photo says so.

### Changed

- The receipt card says "nothing leaves your network", which is what is true from a phone.
```

`package.json` → `1.53.0`.

- [ ] **Step 3: Full suite, build, smoke**

```bash
npx vitest run
rm -rf .next && npm run build
npm run smoke
```

Expected: all green (modulo the documented flake, rerun alone); build exit 0; smoke every check passed.

- [ ] **Step 4: Commit, push, tag**

```bash
git add CHANGELOG.md package.json tests/ops/docker.test.ts
git commit -m "chore(release): v1.53.0

- bills ask for and show their amount
- the receipt reader reads tilted photos and e-bill PDFs, and shows its work"
git push origin main
git tag -a v1.53.0 -m "v1.53.0"
git push origin v1.53.0
gh run list --limit 3
```

Expected: `Release image` for `v1.53.0` in progress.
