import {
  BLOCK_JOIN,
  CROP_ANGLE_LIMIT_DEG,
  LINE_CENTRE_TOLERANCE_RATIO,
  LINE_JOIN,
  LINE_WIDE_BOX_RATIO,
} from '@/lib/warranty/ocr/onnx/constants';
import type { Point, Quad } from '@/lib/warranty/ocr/onnx/contours';

/**
 * PURE. Takes boxes and strings, returns one string.
 *
 * The output must be newline-separated lines in top-to-bottom reading order, because
 * src/lib/warranty/suggest.ts depends on exactly that and is not being modified:
 * suggestVendor takes the first five non-empty lines, suggestPriceCents finds the total
 * line and reads the last currency number ON that line, and suggestPurchaseDate uses the
 * earliest occurrence index. One long line silently ruins all three, and so does a few
 * degrees of tilt pairing each price with the line above, which is why the box centres are
 * rotated by the median text angle before they are grouped into lines.
 */

export interface AssemblyBox {
  quad: Quad;
  text: string;
  score: number;
}

function edge(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A box's text axis, read from its shape and not its vertex order. Detection quads come from
 * rectCorners(minAreaRect(hull)), which keeps the first minimum-area hull edge, so
 * quad[0] -> quad[1] may run along the text, back along it, or across it. The longer of the two
 * edges leaving quad[0] runs along the text and the shorter is the line's height; the angle is
 * folded into (-90, 90] so a right-to-left edge reads the same as a left-to-right one.
 */
function textAxis(quad: Quad): { angleDeg: number; length: number; height: number } {
  const first = edge(quad[0], quad[1]);
  const second = edge(quad[0], quad[3]);
  const along = first >= second ? quad[1] : quad[3];
  let dx = along.x - quad[0].x;
  let dy = along.y - quad[0].y;
  if (dx < 0 || (dx === 0 && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  return {
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    length: Math.max(first, second),
    height: Math.min(first, second),
  };
}

/**
 * The angle the text runs at, in degrees, positive meaning down to the right: the median of the
 * long-edge angles of the WIDE boxes. Squat boxes (a lone digit, a stray mark) do not vote --
 * their min-area rectangle can be read either way round and their angle is noise -- and neither
 * does a box steeper than CROP_ANGLE_LIMIT_DEG, which the crop stage already treats as the bound
 * on a text line's angle.
 */
export function medianTextAngleDeg(boxes: readonly AssemblyBox[]): number {
  const angles: number[] = [];
  for (const { quad } of boxes) {
    const axis = textAxis(quad);
    if (axis.length < axis.height * LINE_WIDE_BOX_RATIO) continue;
    if (Math.abs(axis.angleDeg) > CROP_ANGLE_LIMIT_DEG) continue;
    angles.push(axis.angleDeg);
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
    const cx = box.quad.reduce((s, p) => s + p.x, 0) / box.quad.length;
    const cy = box.quad.reduce((s, p) => s + p.y, 0) / box.quad.length;
    return { box, cx: cx * cos - cy * sin, cy: cx * sin + cy * cos, height: textAxis(box.quad).height };
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
