import sharp from 'sharp';
import {
  ORIENTATION_FLIP_MAJORITY,
  ORIENTATION_MIN_WIDE_BOXES,
  ORIENTATION_TURN_DEG,
  ORIENTATION_WIDE_RATIO,
  ORIENTATION_WIN_RATIO,
} from '@/lib/warranty/ocr/onnx/constants';
import type { DetectedBox, Point, Quad } from '@/lib/warranty/ocr/onnx/contours';
import { detectBoxes } from '@/lib/warranty/ocr/onnx/detect';
import type { RawImage } from '@/lib/warranty/ocr/onnx/preprocess';
import type { TensorRun } from '@/lib/warranty/ocr/onnx/session';

/**
 * Spec 2026-09-30 §2.4 item 5. A receipt saved sideways with no EXIF tag read as garbage on both
 * engines: the line classifier only flips 0/180, and nothing asked whether the page itself was
 * turned. No new model -- detection already knows what a text line looks like (wide). When the real
 * detection pass finds no more wide boxes than tall ones, it runs once more on the page turned 90,
 * and the turn with more wide boxes wins. An upright page pays nothing; a sideways one pays one
 * more detection, where a page read sideways cost the whole receipt.
 *
 * Only 0 and 90 are tried, so a page saved the other way round lands at 180. The classifier turns
 * each line crop the right way up, and when it turns most of them the box positions are turned with
 * the page (turnQuad180), so the lines still assemble in reading order.
 */
function extent(quad: Quad): { w: number; h: number } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function wideCount(boxes: readonly DetectedBox[]): number {
  let count = 0;
  for (const { quad } of boxes) {
    const { w, h } = extent(quad);
    if (w >= h * ORIENTATION_WIDE_RATIO) count += 1;
  }
  return count;
}

function tallCount(boxes: readonly DetectedBox[]): number {
  let count = 0;
  for (const { quad } of boxes) {
    const { w, h } = extent(quad);
    if (h >= w * ORIENTATION_WIDE_RATIO) count += 1;
  }
  return count;
}

/** PURE. Whether a detection pass is worth checking at 90: no more wide boxes than tall ones. */
export function looksSideways(boxes: readonly DetectedBox[]): boolean {
  return wideCount(boxes) <= tallCount(boxes);
}

/** PURE. Which way up the page is, from two detection passes. */
export function chooseRotation(upright: readonly DetectedBox[], turned: readonly DetectedBox[]): 0 | 90 {
  const w0 = wideCount(upright);
  const w90 = wideCount(turned);
  return w90 >= ORIENTATION_MIN_WIDE_BOXES && w90 > w0 * ORIENTATION_WIN_RATIO ? ORIENTATION_TURN_DEG : 0;
}

export async function rotateRaw(image: RawImage, deg: 90 | 180 | 270): Promise<RawImage> {
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .rotate(deg)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * The real detection pass, plus the turned one only when the real one looks sideways. The page and
 * the boxes returned belong together: a turned page is read from its own pass, not detected a third
 * time. A pass that found nothing has nothing to turn.
 */
export async function detectOriented(
  image: RawImage,
  runDet: TensorRun,
): Promise<{ page: RawImage; boxes: DetectedBox[] }> {
  const boxes = await detectBoxes(image, runDet);
  if (boxes.length === 0 || !looksSideways(boxes)) return { page: image, boxes };
  const turnedPage = await rotateRaw(image, ORIENTATION_TURN_DEG);
  const turnedBoxes = await detectBoxes(turnedPage, runDet);
  return chooseRotation(boxes, turnedBoxes) === ORIENTATION_TURN_DEG
    ? { page: turnedPage, boxes: turnedBoxes }
    : { page: image, boxes };
}

/** PURE. The classifier's votes: a strict majority of line crops flipped means the page is upside down. */
export function pageIsUpsideDown(flipped: readonly boolean[]): boolean {
  return flipped.filter(Boolean).length > flipped.length * ORIENTATION_FLIP_MAJORITY;
}

/**
 * PURE. A quad turned 180 degrees about the centre of a width by height page, (x, y) -> (W - x, H - y).
 * The corners are re-indexed by two so corner 0 is the same corner of the box it was (top-left of a
 * level box) and the winding is kept.
 */
export function turnQuad180(quad: Quad, width: number, height: number): Quad {
  const turn = (p: Point): Point => ({ x: width - p.x, y: height - p.y });
  return [turn(quad[2]), turn(quad[3]), turn(quad[0]), turn(quad[1])] as const;
}
