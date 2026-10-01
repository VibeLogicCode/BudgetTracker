/**
 * Every pinned number this release uses. PURE: this file imports nothing, which is what
 * lets the browser scanner import its SCANNER_ block without dragging a Node builtin into
 * the client bundle.
 *
 * MUST-4.41: none of these values appears as a literal anywhere else under onnx/.
 * tests/ops/constants.test.ts fails the build if one does.
 *
 * Every value below marked PaddleOCR or RapidOCR was checked against RapidOCR at tag
 * v3.9.2 per spec section 17.1. Four disagreed with the spec's original PaddleOCR-sourced
 * value and are corrected here: DET_LIMIT_SIDE_LEN, DET_LIMIT_TYPE, DET_MEAN and DET_STD.
 * See each constant's comment and the spec's revision history, Task 2 correction.
 */

// Preprocessing

/** Ours. Bounds decode memory. A 50 MP photo is well past any phone. */
export const PREPROCESS_MAX_INPUT_PIXELS = 50_000_000;
/** Ours. Below this, receipt print is under the detector's resolution. */
export const PREPROCESS_MIN_LONG_SIDE_PX = 1280;
/** Ours. Beyond 3x there is no information left to recover. */
export const PREPROCESS_MAX_UPSCALE = 3.0;
/** Ours. Corrected here (Task 3 controller ruling) from 4000 to 1600. DET_LIMIT_TYPE is
 *  'min' (see below), which raises a small image's short side but supplies no upper bound
 *  of its own, so this constant is the only cap standing between a full resolution phone
 *  photo and the detector. 1600 bounds that worst case on NAS hardware; the deskew rotate
 *  and any later crop buffer inherit the same bound because nothing downstream ever sees a
 *  larger image. See the spec's MUST-4.43 and its revision history, Task 3 correction. */
export const PREPROCESS_MAX_LONG_SIDE_PX = 1600;
/** Ours, sharp's normalise option. */
export const NORMALISE_LOWER_PERCENTILE = 1;
/** Ours, sharp's normalise option. */
export const NORMALISE_UPPER_PERCENTILE = 99;
/** Ours. A hand held phone shot past 10 degrees is a scanner crop case, not a deskew case. */
export const DESKEW_SEARCH_MAX_DEG = 10;
/** Ours. 41 candidates. */
export const DESKEW_SEARCH_STEP_DEG = 0.5;
/** Ours. Below this, the resample costs more than it gains. */
export const DESKEW_MIN_APPLY_DEG = 0.3;
/** Ours. */
export const DESKEW_PROFILE_LONG_SIDE_PX = 800;
/** Ours. White, because the image is already flattened onto white. */
export const DESKEW_BACKGROUND = '#ffffff';
/** Ours. Above this fraction of "ink" after Otsu, the frame is background, not text, and the
 *  profile search would measure the countertop's edges. The deskew then declines. */
export const DESKEW_MAX_INK_RATIO = 0.35;

// Detection

/**
 * RapidOCR v3.9.2's actual shipped default (python/rapidocr/config.yaml's Det section;
 * ch_ppocr_det/utils.py's DetPreProcess falls back to the same value). Corrected from the
 * spec's original 960: that number is PaddleOCR's tools/infer/utility.py inference CLI
 * default, a different code path from the DetResizeForTest operator's own fallback, which
 * is 736 and is what the model's published Eval config and RapidOCR both use. See
 * MUST-4.42 for the acceptance-run implication of this correction.
 */
export const DET_LIMIT_SIDE_LEN = 736;
/**
 * RapidOCR v3.9.2's actual default, matching PaddleOCR's own DetResizeForTest fallback.
 * Corrected from the spec's original 'max', which was PaddleOCR's inference CLI default
 * for the same reason DET_LIMIT_SIDE_LEN was corrected. 'min' raises the shorter side to
 * the floor and leaves the image alone otherwise, rather than capping the longer side.
 */
export const DET_LIMIT_TYPE = 'min';
/** DBNet's stride. */
export const DET_SIZE_MULTIPLE = 32;
/**
 * RapidOCR v3.9.2's actual Det.mean (config.yaml; DetPreProcess's own hardcoded default).
 * Corrected from the spec's original ImageNet triple [0.485, 0.456, 0.406]: that triple is
 * what PaddleOCR's PP-OCRv5_mobile_det.yml trains and evaluates with, but RapidOCR's
 * shipped runtime for this exact vendored .onnx file normalises uniformly instead, and
 * RapidOCR is the pipeline this release replicates.
 */
export const DET_MEAN: readonly [number, number, number] = [0.5, 0.5, 0.5];
/** Same source as DET_MEAN. Corrected from the spec's original ImageNet [0.229, 0.224, 0.225]. */
export const DET_STD: readonly [number, number, number] = [0.5, 0.5, 0.5];
/** RapidOCR v3.9.2 and PaddleOCR NormalizeImage, identical. */
export const DET_SCALE = 1 / 255;
/** PaddleOCR det_db_thresh and RapidOCR thresh, identical. */
export const DET_BINARY_THRESH = 0.3;
/** RapidOCR box_thresh. PaddleOCR uses 0.6; the more permissive value is chosen because
 *  thermal receipt print is faint and a missed line is worse here than a spurious one,
 *  which REC_DROP_SCORE filters anyway. */
export const DET_BOX_THRESH = 0.5;
/** RapidOCR unclip_ratio. PaddleOCR uses 1.5; the wider value keeps descenders and thin
 *  digits inside the crop. */
export const DET_UNCLIP_RATIO = 1.6;
/** RapidOCR max_candidates. */
export const DET_MAX_CANDIDATES = 1000;
/** PaddleOCR min_size, hardcoded in RapidOCR's DBPostProcess. */
export const DET_MIN_BOX_SIDE_PX = 3;
/** RapidOCR default. */
export const DET_USE_DILATION = true;
/** RapidOCR's 2 by 2 kernel of ones. */
export const DET_DILATION_KERNEL = 2;
/** RapidOCR score_mode. */
export const DET_SCORE_MODE = 'fast';
/** Ours (MUST-4.18). */
export const DET_MAX_BOXES = 200;
/** Ours (MUST-4.20). */
export const CROP_MIN_ROTATE_DEG = 0.5;

// Orientation

/** Ours. A box counts as a text line when its horizontal extent is at least this many times its vertical one.
 *  The same ratio the other way round makes a box tall, which is what a sideways page's lines look like. */
export const ORIENTATION_WIDE_RATIO = 2;
/** Ours. Fewer wide boxes than this in the turned pass is not evidence of anything. */
export const ORIENTATION_MIN_WIDE_BOXES = 3;
/** Ours. The turned pass must beat the upright one by this factor to win; a tie keeps the image as it came. */
export const ORIENTATION_WIN_RATIO = 1.5;
/** Ours. The one turn the orientation step tries, a quarter turn clockwise; 180 is settled by the line classifier. */
export const ORIENTATION_TURN_DEG = 90;
/** Ours. More than this fraction of lines read upside down means the page is, and positions are turned with it. */
export const ORIENTATION_FLIP_MAJORITY = 0.5;

// Orientation classifier

/** RapidOCR's own CLS_SHAPE_BY_OCR_VERSION[PP-OCRv5] (ch_ppocr_cls/main.py), matching
 *  Task 1's measured static graph input. Used only as a fallback when the graph's own
 *  dimension is symbolic (MUST-4.22); the graph wins. */
export const CLS_INPUT_HEIGHT = 80;
/** Same source as CLS_INPUT_HEIGHT. */
export const CLS_INPUT_WIDTH = 160;
/** PaddleOCR and RapidOCR cls preprocessing, identical. */
export const CLS_MEAN = 0.5;
/** Same source as CLS_MEAN. */
export const CLS_STD = 0.5;
/** Normalised space, mid-grey. */
export const CLS_PAD_VALUE = 0;
/** PaddleOCR and RapidOCR cls_thresh, identical. */
export const CLS_THRESH = 0.9;
/** PaddleOCR and RapidOCR cls_batch_num, identical. */
export const CLS_BATCH_SIZE = 6;

// Recognition

/** PaddleOCR rec_image_shape height for v4 and v5 mobile, and RapidOCR's rec_img_shape, identical. */
export const REC_INPUT_HEIGHT = 48;
/** PaddleOCR rec_image_shape width, and RapidOCR's rec_img_shape, identical. */
export const REC_BASE_WIDTH = 320;
/** Ours. Bounds one absurdly wide crop's tensor at 25 to 1. */
export const REC_MAX_WIDTH = 1200;
/** PaddleOCR and RapidOCR rec preprocessing, identical. */
export const REC_MEAN = 0.5;
/** Same source as REC_MEAN. */
export const REC_STD = 0.5;
/** Normalised space, mid-grey. Padding with normalised -1 (black) puts a black bar after
 *  every short line and the CTC head reads characters into it. */
export const REC_PAD_VALUE = 0;
/** PaddleOCR and RapidOCR rec_batch_num, identical. */
export const REC_BATCH_SIZE = 6;
/** PaddleOCR CTCLabelDecode.add_special_char prepends 'blank'; RapidOCR's
 *  get_ignored_tokens() returns [0] for the same reason. Identical. */
export const REC_BLANK_INDEX = 0;
/** PaddleOCR use_space_char default for English. Confirmed empirically by Task 1: the
 *  real dictionary's 436 entries plus the CTC blank plus one appended space equal the
 *  real model's declared 438 output classes. */
export const REC_USE_SPACE_CHAR = true;
/** PaddleOCR drop_score default. RapidOCR's equivalent, Global.text_score, defaults to
 *  the same 0.5. */
export const REC_DROP_SCORE = 0.5;

// Assembly and sessions

/** Ours (MUST-4.33). Pinned by the constant table; assemble.ts now groups lines by
 *  LINE_CENTRE_TOLERANCE_RATIO instead (spec 2026-09-30 §2.4 item 4). */
export const LINE_OVERLAP_RATIO = 0.5;
/** Ours (spec 2026-09-30 §2.4). After rotating box centres by the median text angle, two boxes
 *  share a line when their centres sit within this fraction of the median box height. */
export const LINE_CENTRE_TOLERANCE_RATIO = 0.5;
/** Ours. A box is "wide" -- a text line, not a stray glyph -- when its longer edge is at least
 *  this many times its shorter edge. Only wide boxes vote on the text angle. */
export const LINE_WIDE_BOX_RATIO = 2;
/** Ours. */
export const LINE_JOIN = ' ';
/** Ours, and required by MUST-4.34. */
export const BLOCK_JOIN = '\n';
/** Ours. A budget NAS has 2 or 4 cores and the queue is concurrency 1. */
export const ORT_INTRA_OP_THREADS = 2;
/** Ours. */
export const ORT_INTER_OP_THREADS = 1;
/** ORT default for a static graph. */
export const ORT_GRAPH_OPT = 'all';
/** Errors only. */
export const ORT_LOG_SEVERITY = 3;
/** Ours (MUST-4.36). */
export const ORT_CPU_MEM_ARENA = false;

// Additions beyond section 4.11, needed so no stage file has to write a raw number that
// MUST-4.41 bans.

/** The same 1 / 255 as DET_SCALE, under a stage neutral name, because the classifier and
 *  the recogniser normalise with it too. */
export const PIXEL_SCALE = 1 / 255;
/** A recognition batch's tensor width is rounded up to a multiple of this. */
export const REC_WIDTH_MULTIPLE = 8;
/** Class index 1 from the orientation model means the crop is this far round. */
export const CLS_FLIP_DEGREES = 180;
/** A min area rectangle can describe one shape either way round. A text line is wider than
 *  it is tall, so an angle outside this bound means width and height should be swapped.
 *  assemble.ts reads it the same way: a wide box steeper than this is not a level text line
 *  and gets no vote on the text angle. */
export const CROP_ANGLE_LIMIT_DEG = 45;
/** Ours. A pixel is sampled at its centre for the point-in-polygon mask. */
export const PIXEL_CENTRE_OFFSET = 0.5;

// Probe protocol, per plan resolution 8. Lives here so that '200' is not a bare literal
// under onnx/.

/** The exact line the probe child prints on success. Duplicated as a literal in
 *  scripts/ocr-probe.mjs, which cannot resolve '@/...'. tests/scripts/ocr-probe.test.ts
 *  pins the two equal. */
export const OCR_PROBE_OK_LINE = 'ocr-probe-ok';
/** After this the child is SIGKILLed and the verdict is the fallback engine. */
export const OCR_PROBE_TIMEOUT_MS = 60_000;
/** How much of the child's stderr is kept as the recorded reason. */
export const OCR_PROBE_DETAIL_MAX_CHARS = 200;

// The browser scanner's own limits, per plan resolutions 7 and 14. This block is the only
// part of this file a 'use client' module imports, and it is why this file may never grow
// an import.

/** loadScanner() rejects after this. 9 MB over a LAN on a phone, with headroom. */
export const SCANNER_LOAD_TIMEOUT_MS = 15_000;
/** Contour work on a 12 MP bitmap on a mid range phone takes seconds. At this size it
 *  takes tens of milliseconds and finds the same quad, which is scaled back up after. */
export const SCANNER_WORK_MAX_PX = 1600;
/** The corrected image's long side. The recogniser wants more than the working size. */
export const SCANNER_OUTPUT_MAX_PX = 2400;
export const SCANNER_JPEG_QUALITY = 0.92;
/** A sliver of the frame is a countertop edge, not paper; a long receipt shot whole fills 10-20
 *  percent of a 3:4 frame and must pass. */
export const SCANNER_MIN_QUAD_AREA_RATIO = 0.08;
/** A quad hugging the full frame is the photo's border, not paper -- the ceiling the old comment
 *  described. */
export const SCANNER_MAX_QUAD_AREA_RATIO = 0.97;
/** A sliver quad is a countertop edge. */
export const SCANNER_MIN_SIDE_RATIO = 0.05;
/** The countdown before the corrected image uploads on its own. */
export const SCANNER_AUTO_ACCEPT_MS = 8000;
/** The same 10 MB as MAX_RECEIPT_BYTES in @/lib/warranty/receipts, duplicated here because
 *  that module imports node:fs, node:crypto and @/lib/env, and scan.ts is reachable from a
 *  'use client' component. tests/ops/constants.test.ts pins the two equal. */
export const SCANNER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
