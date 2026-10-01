import { describe, it, expect } from 'vitest';
import {
  DET_BINARY_THRESH,
  DET_DILATION_KERNEL,
  DET_MAX_BOXES,
  DET_MAX_CANDIDATES,
  DET_UNCLIP_RATIO,
} from '@/lib/warranty/ocr/onnx/constants';
import {
  binarize,
  boxScoreFast,
  boxesFromProbMap,
  convexHull,
  dilate,
  labelComponents,
  minAreaRect,
  rectCorners,
  unclipRect,
  type Point,
} from '@/lib/warranty/ocr/onnx/contours';
import {
  MANY_BOXES_MIN_VALUE,
  NOISE_MAP_COMPONENTS,
  manyBoxesMap,
  noiseMap,
  oneGapMap,
  twoBoxMap,
} from '../../../../helpers/ocr-probmaps';

describe('binarize (MUST-4.10)', () => {
  it('keeps values strictly above the threshold and drops the rest', () => {
    // 0.29999 rather than DET_BINARY_THRESH's own 0.3: a Float32Array cannot store the
    // double 0.3 exactly, and its nearest float32 neighbour rounds up past 0.3, which would
    // flip this boundary case to kept for a reason that has nothing to do with binarize's
    // own strict greater-than rule. 0.29999 rounds to a float32 safely below 0.3 either way.
    const map = new Float32Array([0.29, 0.29999, 0.31, 0.0, 1.0]);
    expect([...binarize(map, DET_BINARY_THRESH)]).toEqual([0, 0, 1, 0, 1]);
  });
});

describe('dilate (MUST-4.11)', () => {
  it('closes the one-pixel gap into a single component', () => {
    const gap = oneGapMap();
    const raw = labelComponents(binarize(gap.data, DET_BINARY_THRESH), gap.width, gap.height, DET_MAX_CANDIDATES);
    expect(raw.components).toHaveLength(2);
    const closed = dilate(
      binarize(gap.data, DET_BINARY_THRESH),
      gap.width,
      gap.height,
      DET_DILATION_KERNEL,
    );
    expect(labelComponents(closed, gap.width, gap.height, DET_MAX_CANDIDATES).components).toHaveLength(1);
  });

  it('leaves two well-separated blobs as two', () => {
    const clean = twoBoxMap();
    const closed = dilate(
      binarize(clean.data, DET_BINARY_THRESH),
      clean.width,
      clean.height,
      DET_DILATION_KERNEL,
    );
    expect(labelComponents(closed, clean.width, clean.height, DET_MAX_CANDIDATES).components).toHaveLength(2);
  });
});

describe('labelComponents (MUST-4.12)', () => {
  it('labels an 8-connected diagonal as one component', () => {
    const bitmap = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(labelComponents(bitmap, 3, 3, DET_MAX_CANDIDATES).components).toHaveLength(1);
  });

  it('labels a 4-connected line as one component', () => {
    const bitmap = new Uint8Array([1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(labelComponents(bitmap, 3, 3, DET_MAX_CANDIDATES).components).toHaveLength(1);
  });

  it('stops at exactly DET_MAX_CANDIDATES on the noise fixture', () => {
    const noise = noiseMap();
    // 1156 candidates in, 1000 out. If the fixture ever fell below the cap this assertion
    // would pass while proving nothing, so pin the input count too.
    expect(NOISE_MAP_COMPONENTS).toBeGreaterThan(DET_MAX_CANDIDATES);
    const result = labelComponents(
      binarize(noise.data, DET_BINARY_THRESH),
      noise.width,
      noise.height,
      DET_MAX_CANDIDATES,
    );
    expect(result.components).toHaveLength(DET_MAX_CANDIDATES);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated false and every component when the cap is not reached', () => {
    const clean = twoBoxMap();
    const result = labelComponents(
      binarize(clean.data, DET_BINARY_THRESH),
      clean.width,
      clean.height,
      DET_MAX_CANDIDATES,
    );
    expect(result.components).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });
});

describe('minAreaRect (MUST-4.13)', () => {
  it('recovers a 45 degree square as that square', () => {
    const points: Point[] = [
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 10 },
    ];
    const rect = minAreaRect(convexHull(points));
    expect(rect.cx).toBeCloseTo(10, 5);
    expect(rect.cy).toBeCloseTo(10, 5);
    const side = Math.sqrt(200);
    expect(Math.min(rect.width, rect.height)).toBeCloseTo(side, 3);
    expect(Math.max(rect.width, rect.height)).toBeCloseTo(side, 3);
    const normalised = ((rect.angleDeg % 90) + 90) % 90;
    expect(Math.min(Math.abs(normalised - 45), Math.abs(normalised - 45))).toBeLessThan(0.5);
  });

  it('recovers an axis-aligned rectangle exactly', () => {
    const rect = minAreaRect(
      convexHull([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 20 },
        { x: 0, y: 20 },
      ]),
    );
    expect(Math.max(rect.width, rect.height)).toBeCloseTo(100, 5);
    expect(Math.min(rect.width, rect.height)).toBeCloseTo(20, 5);
  });
});

describe('boxScoreFast (MUST-4.15)', () => {
  // Spec 2026-09-30 §2.4 item 1 (polygon-masked score) supersedes the old pin on the
  // bounding-box mean. The score is now the mean over the pixels whose CENTRE (x + 0.5, y + 0.5)
  // lies inside the quad. The crossing-number test is half-open: a centre on a left or top edge
  // is in, one on a right or bottom edge is out, so a unit square covers exactly one pixel.
  it('averages only the pixel centres inside the quad, not its whole bounding box', () => {
    const width = 4;
    const height = 2;
    const map = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const quad = rectCorners({ cx: 1, cy: 0.5, width: 1, height: 1, angleDeg: 0 });
    // Corners land on x in 0.5..1.5 and y in 0..1. The bounding box floors and ceils to columns
    // 0..2 of both rows, whose plain mean is 2.4 / 6 = 0.4 -- the old answer. Of those six pixel
    // centres only (0.5, 0.5) is inside: (1.5, 0.5) sits on the right edge, (2.5, 0.5) is past
    // it, and row 1's centres are at y = 1.5, below the quad. The score is pixel (0, 0) alone.
    expect(boxScoreFast(map, width, height, quad)).toBeCloseTo(0.1, 6);
  });

  it('clips to the map, then masks: a square hanging off the top edge scores its in-map centres', () => {
    const map = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const quad = rectCorners({ cx: 1.5, cy: 0.5, width: 2, height: 2, angleDeg: 0 });
    // x spans 0.5..2.5 and y spans -0.5..1.5, so y0 = floor(-0.5) = -1 clips to row 0 and nothing
    // is read from outside the map (an unclipped read would turn the mean into NaN). The 2 by 2
    // square covers four pixel centres: (0.5, -0.5) and (1.5, -0.5) are off the map, (0.5, 0.5)
    // and (1.5, 0.5) are pixels (0, 0) and (1, 0). Column 2 (x = 2.5) and row 1 (y = 1.5) sit on
    // the right and bottom edges and are out. The unmasked box mean here was 3.6 / 8 = 0.45.
    expect(boxScoreFast(map, 4, 2, quad)).toBeCloseTo((0.1 + 0.2) / 2, 6);
  });

  it('clips the bounding box into the map bounds', () => {
    const map = new Float32Array([1, 1, 1, 1]);
    const quad = rectCorners({ cx: 0, cy: 0, width: 100, height: 100, angleDeg: 0 });
    expect(boxScoreFast(map, 2, 2, quad)).toBeCloseTo(1, 6);
  });

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
    // The whole-box mean would be about 0.58 (800 ink pixels of the 61 by 21 = 1281 cells the
    // floored and ceiled box covers). Inside the polygon it is ~0.9.
    expect(boxScoreFast(map, width, height, quad)).toBeGreaterThan(0.85);
  });
});

describe('unclipRect (MUST-4.16)', () => {
  it('expands a 100 by 20 rectangle by exactly 2 * (2000 * 1.6 / 240) in each dimension', () => {
    const area = 100 * 20;
    const perimeter = 2 * (100 + 20);
    const distance = (area * DET_UNCLIP_RATIO) / perimeter;
    // 2000 * 1.6 = 3200; 3200 / 240 = 13.3333...; twice that is 26.6666...
    expect(distance).toBeCloseTo(3200 / 240, 10);
    const grown = unclipRect({ cx: 50, cy: 10, width: 100, height: 20, angleDeg: 0 }, DET_UNCLIP_RATIO);
    expect(grown.width).toBeCloseTo(100 + 2 * (3200 / 240), 10);
    expect(grown.height).toBeCloseTo(20 + 2 * (3200 / 240), 10);
    expect(grown.cx).toBe(50);
    expect(grown.cy).toBe(10);
    expect(grown.angleDeg).toBe(0);
  });
});

describe('boxesFromProbMap (MUST-4.14, MUST-4.15, MUST-4.18)', () => {
  it('finds both boxes on the clean fixture', () => {
    const clean = twoBoxMap();
    expect(boxesFromProbMap(clean.data, clean.width, clean.height)).toHaveLength(2);
  });

  it('drops a component two pixels tall by DET_MIN_BOX_SIDE_PX', () => {
    const width = 40;
    const height = 20;
    const map = new Float32Array(width * height);
    for (let y = 5; y <= 6; y += 1) for (let x = 4; x <= 30; x += 1) map[y * width + x] = 0.9;
    expect(boxesFromProbMap(map, width, height)).toHaveLength(0);
  });

  it('keeps a box scoring 0.51 and drops one scoring 0.49', () => {
    // The region runs flush to the right and bottom edges on purpose. dilate() only grows
    // down and to the right and clamps at the bounds, so the dilated set is identical to the
    // region, the box's bounding box is exactly the region, and the measured score is the
    // fill value exactly. Before the polygon mask (spec 2026-09-30 §2.4 item 1) a region
    // floating in the middle was measured over a bounding box one row and one column larger
    // than itself, diluting 0.51 to about 0.435. The mask reads only the pixel centres inside
    // the quad, so a floating region now scores 0.51 too; the flush placement is kept, but it
    // is no longer load-bearing.
    const width = 30;
    const height = 12;
    function mapAt(value: number): Float32Array {
      const map = new Float32Array(width * height);
      for (let y = 2; y <= height - 1; y += 1) {
        for (let x = 3; x <= width - 1; x += 1) map[y * width + x] = value;
      }
      return map;
    }
    // Rectangle corners (3,2) and (29,11): 26 by 9, so min side 9 clears DET_MIN_BOX_SIDE_PX.
    // Score cells are the pixel centres inside that quad, x 3..28 by y 2..10 = 26 * 9 = 234,
    // all of them inside the region.
    expect(boxesFromProbMap(mapAt(0.51), width, height)).toHaveLength(1);
    expect(boxesFromProbMap(mapAt(0.51), width, height)[0].score).toBeCloseTo(0.51, 5);
    expect(boxesFromProbMap(mapAt(0.49), width, height)).toHaveLength(0);
  });

  it('caps at DET_MAX_BOXES, keeping the highest-scoring ones', () => {
    const many = manyBoxesMap();
    const boxes = boxesFromProbMap(many.data, many.width, many.height);
    // 231 blocks all clear both filters, so the cap has to do real work here. The noise
    // fixture cannot test this: its single-pixel components dilate to a 2 by 2 whose
    // rectangle measures 1 by 1 and DET_MIN_BOX_SIDE_PX drops every one of them, leaving an
    // empty array that satisfies any upper-bound assertion.
    expect(boxes).toHaveLength(DET_MAX_BOXES);
    // The 31 weakest blocks were dropped, so nothing at the floor value survives. Under the
    // polygon mask a block scores its own value, so the weakest block would score exactly
    // MANY_BOXES_MIN_VALUE (0.75 is exact in float32) and fail this strict comparison.
    expect(Math.min(...boxes.map((box) => box.score))).toBeGreaterThan(MANY_BOXES_MIN_VALUE);
  });

  it('the noise fixture is dropped on size, not on the cap', () => {
    const noise = noiseMap();
    // A single pixel dilates to 2 by 2, whose min-area rectangle measures 1 by 1 because the
    // extent is max minus min. 1 < DET_MIN_BOX_SIDE_PX, so a patterned countertop costs
    // nothing downstream.
    expect(boxesFromProbMap(noise.data, noise.width, noise.height)).toEqual([]);
  });
});
