import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assembleText, medianTextAngleDeg, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
import type { Quad } from '@/lib/warranty/ocr/onnx/contours';
import { suggestFromOcrText } from '@/lib/warranty/suggest';

function quad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ] as const;
}

function fixture(): AssemblyBox[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/ocr/receipt-boxes.json'), 'utf8'),
  ) as { quad: [number, number][]; text: string; score: number }[];
  return raw.map((entry) => ({
    quad: entry.quad.map(([x, y]) => ({ x, y })) as unknown as Quad,
    text: entry.text,
    score: entry.score,
  }));
}

// Lines are now grouped by centre distance (spec 2026-09-30 §2.4 item 4), not by y-overlap. For
// two level boxes of equal height h, overlapping by r * h is the same as centres (1 - r) * h
// apart, so the old 50 percent overlap rule and a centre gap of at most
// LINE_CENTRE_TOLERANCE_RATIO (0.5) of the median height split these pairs at the same place.
describe('assembleText (MUST-4.33)', () => {
  it('merges two boxes overlapping by 60 percent of the shorter height', () => {
    // Box A spans y 0..20, box B spans y 8..28, both 20 tall. Overlap is
    // min(20, 28) - max(0, 8) = 12, or 0.6 of the height: centres 8 apart, inside the 10 allowed.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'left', score: 0.9 },
      { quad: quad(60, 8, 110, 28), text: 'right', score: 0.9 },
    ]);
    expect(text).toBe('left right');
  });

  it('does not merge two boxes overlapping by 40 percent', () => {
    // Same shapes shifted four pixels further down: overlap is
    // min(20, 32) - max(0, 12) = 8, or 0.4 of the height: centres 12 apart, outside the 10.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'top', score: 0.9 },
      { quad: quad(60, 12, 110, 32), text: 'bottom', score: 0.9 },
    ]);
    expect(text).toBe('top\nbottom');
  });

  it('merges at exactly LINE_OVERLAP_RATIO, because the comparison is at-or-above', () => {
    // Overlap 10 of a 20 tall pair is exactly 0.5: centres exactly 10 apart, the tolerance itself.
    const text = assembleText([
      { quad: quad(0, 0, 50, 20), text: 'a', score: 0.9 },
      { quad: quad(60, 10, 110, 30), text: 'b', score: 0.9 },
    ]);
    expect(text).toBe('a b');
  });

  it('emits a single box as one line with no trailing newline', () => {
    expect(assembleText([{ quad: quad(0, 0, 10, 10), text: 'only', score: 0.9 }])).toBe('only');
  });

  it('returns the empty string for no boxes', () => {
    expect(assembleText([])).toBe('');
  });
});

describe('MUST-4.34: the assembled text is what suggest.ts can read (risk R9)', () => {
  const text = assembleText(fixture());

  it('puts the vendor on the first line even though the fixture is scrambled', () => {
    expect(text.split('\n')[0]).toBe('HOME HARDWARE');
  });

  it('keeps the TOTAL line intact and on one line', () => {
    expect(text).toMatch(/^TOTAL 42\.17$/m);
  });

  it('keeps the subtotal on its own line, so it cannot be read as the total', () => {
    expect(text).toMatch(/^Subtotal 37\.85$/m);
  });

  // The single most important assertion in this suite. Better OCR that assembles into one
  // long line would make every suggestion worse while looking like an improvement.
  it('yields the expected vendor, date and price through the real suggester', () => {
    expect(suggestFromOcrText(text, '2026-08-18')).toEqual({
      vendor: 'HOME HARDWARE',
      purchaseDate: '2026-03-14',
      priceCents: 4217,
    });
  });
});

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

  // The test above cannot fail on the ratio filter: its 20 by 60 box at 60 degrees is, by shape,
  // a 60 by 20 line at -30 degrees, and a median of three 4s and anything is 4. Here the squat
  // box's vote would move the median from 4 to 17.
  it('gives no vote to a squat box under LINE_WIDE_BOX_RATIO', () => {
    const boxes = [tilted(0, 0, 200, 20, 4), tilted(300, 0, 330, 20, 30)].map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(4, 5);
  });

  // Real detection quads come from rectCorners(minAreaRect(hull)), which keeps the FIRST
  // minimum-area hull edge, so quad[0] -> quad[1] may run along the text, back along it, or
  // across it. On the harness's 6 degree receipt about half the boxes start on the far corner
  // and read -174 degrees edge-first. The angle and the line height must come from the box's
  // shape, not from which corner it starts on.
  /** Same rectangle, starting on the opposite corner: quad[0] -> quad[1] runs right to left. */
  function reversed(q: Quad): Quad {
    return [q[2], q[3], q[0], q[1]] as const;
  }
  /** Same rectangle, starting one corner on: quad[0] -> quad[1] runs across the line. */
  function quarterTurned(q: Quad): Quad {
    return [q[1], q[2], q[3], q[0]] as const;
  }

  it('reads the same angle whichever corner the quad starts on', () => {
    const quads = [tilted(0, 0, 200, 20, 5), reversed(tilted(0, 40, 220, 60, 5)), quarterTurned(tilted(0, 80, 180, 100, 5))];
    const boxes = quads.map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(5, 5);
  });

  // Only non-canonical boxes vote in these two, so a lost fold or a lost longer-edge pick turns
  // every vote into one the 45 degree gate drops, and the angle falls back to 0.
  it('folds a quad that starts on the far corner back to the text angle', () => {
    const boxes = [reversed(tilted(0, 0, 200, 20, 5)), reversed(tilted(0, 40, 220, 60, 5))].map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(5, 5);
  });

  it('takes the longer edge as the text direction when quad[0] -> quad[1] runs across the line', () => {
    const boxes = [quarterTurned(tilted(0, 0, 200, 20, 5)), quarterTurned(tilted(0, 40, 220, 60, 5))].map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(5, 5);
  });

  it('gives no vote to a wide box steeper than CROP_ANGLE_LIMIT_DEG', () => {
    const boxes = [tilted(0, 0, 200, 20, 5), tilted(300, 0, 500, 20, 70)].map((quad) => ({ quad, text: 'x', score: 0.9 }));
    expect(medianTextAngleDeg(boxes)).toBeCloseTo(5, 5);
  });

  it('keeps each label with its own price when the quads start on different corners', () => {
    const orders = [(q: Quad) => q, reversed, quarterTurned];
    const rows = [
      ['SUBTOTAL', '24.51'],
      ['HST 13%', '0.80'],
      ['TOTAL', '25.31'],
    ];
    const boxes: AssemblyBox[] = rows.flatMap(([label, price], i) => [
      { quad: orders[i % 3](tilted(20, 100 + i * 30, 200, 120 + i * 30, 5)), text: label, score: 0.9 },
      { quad: orders[(i + 1) % 3](tilted(400, 100 + i * 30, 470, 120 + i * 30, 5)), text: price, score: 0.9 },
    ]);
    expect(assembleText(boxes)).toBe('SUBTOTAL 24.51\nHST 13% 0.80\nTOTAL 25.31');
  });
});
