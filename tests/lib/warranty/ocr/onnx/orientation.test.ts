import { describe, it, expect } from 'vitest';
import { chooseRotation, looksSideways, pageIsUpsideDown, turnQuad180 } from '@/lib/warranty/ocr/onnx/orientation';
import { assembleText, type AssemblyBox } from '@/lib/warranty/ocr/onnx/assemble';
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

/** The turned pass is paid for only when the real one looks sideways: no more wide boxes than tall. */
describe('looksSideways', () => {
  it('a page of wide boxes is upright, so no second detection', () => {
    expect(looksSideways([...boxes(8, 180, 18), ...boxes(2, 18, 180)])).toBe(false);
  });
  it('a page of tall boxes looks sideways', () => {
    expect(looksSideways([...boxes(8, 18, 180), ...boxes(2, 180, 18)])).toBe(true);
  });
  it('as many tall as wide is not upright enough to skip the check', () => {
    expect(looksSideways([...boxes(3, 18, 180), ...boxes(3, 180, 18)])).toBe(true);
  });
  it('squat boxes are neither, and do not tip it', () => {
    expect(looksSideways([...boxes(1, 180, 18), ...boxes(6, 30, 30)])).toBe(false);
  });
});

/** A level box centred at (cx, cy), as detection reports it. */
function line(text: string, cx: number, cy: number, width: number): AssemblyBox {
  return { quad: rectCorners({ cx, cy, width, height: 20, angleDeg: 0 }), text, score: 0.9 };
}

/**
 * Spec 2026-09-30 §2.4 item 5. The orientation step only tries 0 or 90, so a page saved at +90
 * comes out at 180. The line classifier turns each crop the right way up, but the boxes still sit where an
 * upside-down page put them: last line first, and each amount left of its label.
 */
describe('turnQuad180', () => {
  const W = 400;
  const H = 200;
  // The upright page is "MAPLE GROCERY" above "TOTAL ... 25.31"; this is where each box sits
  // once that page is turned 180 degrees, (x, y) -> (W - x, H - y).
  const upsideDown = [line('MAPLE GROCERY', 200, 170, 200), line('TOTAL', 320, 100, 80), line('25.31', 80, 100, 80)];
  const turned = upsideDown.map((box) => ({ ...box, quad: turnQuad180(box.quad, W, H) }));

  it('the unturned layout really does read backwards', () => {
    expect(assembleText(upsideDown)).toBe('25.31 TOTAL\nMAPLE GROCERY');
  });

  it('turned about the page centre, lines come out top to bottom and words left to right', () => {
    expect(assembleText(turned)).toBe('MAPLE GROCERY\nTOTAL 25.31');
  });

  it('turns every corner about the centre, and corner 0 stays top-left', () => {
    const before = upsideDown[1].quad;
    const after = turned[1].quad;
    expect(after.map((p) => [p.x, p.y]).sort()).toEqual(before.map((p) => [W - p.x, H - p.y]).sort());
    expect(after[0]).toEqual({ x: Math.min(...after.map((p) => p.x)), y: Math.min(...after.map((p) => p.y)) });
    expect(after[2]).toEqual({ x: Math.max(...after.map((p) => p.x)), y: Math.max(...after.map((p) => p.y)) });
  });
});

/** The classifier's own votes decide whether the page is upside down: a strict majority of its line crops. */
describe('pageIsUpsideDown', () => {
  it('turns the page when more than half the crops were flipped', () => {
    expect(pageIsUpsideDown([true, true, false])).toBe(true);
    expect(pageIsUpsideDown([true, true, true, true, false])).toBe(true);
  });
  it('does not turn it at exactly half, or below', () => {
    expect(pageIsUpsideDown([true, false])).toBe(false);
    expect(pageIsUpsideDown([true, true, false, false])).toBe(false);
    expect(pageIsUpsideDown([false, false, true])).toBe(false);
  });
  it('does not turn a page with no crops', () => {
    expect(pageIsUpsideDown([])).toBe(false);
  });
});
