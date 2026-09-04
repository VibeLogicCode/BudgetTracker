import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as C from '@/lib/warranty/ocr/onnx/constants';
import { MAX_RECEIPT_BYTES } from '@/lib/warranty/receipts';

const ONNX_DIR = path.join(process.cwd(), 'src/lib/warranty/ocr/onnx');

/**
 * Section 4.11's table, with four values corrected against RapidOCR v3.9.2 (Task 2
 * correction; see constants.ts and the spec's revision history): DET_LIMIT_SIDE_LEN,
 * DET_LIMIT_TYPE, DET_MEAN and DET_STD. The plan's four additions are deliberately absent.
 */
const TABLE: Record<string, number | string | boolean | readonly number[]> = {
  PREPROCESS_MAX_INPUT_PIXELS: 50_000_000,
  PREPROCESS_MIN_LONG_SIDE_PX: 1280,
  PREPROCESS_MAX_UPSCALE: 3.0,
  PREPROCESS_MAX_LONG_SIDE_PX: 1600,
  NORMALISE_LOWER_PERCENTILE: 1,
  NORMALISE_UPPER_PERCENTILE: 99,
  DESKEW_SEARCH_MAX_DEG: 10,
  DESKEW_SEARCH_STEP_DEG: 0.5,
  DESKEW_MIN_APPLY_DEG: 0.3,
  DESKEW_PROFILE_LONG_SIDE_PX: 800,
  DESKEW_BACKGROUND: '#ffffff',
  DET_LIMIT_SIDE_LEN: 736,
  DET_LIMIT_TYPE: 'min',
  DET_SIZE_MULTIPLE: 32,
  DET_MEAN: [0.5, 0.5, 0.5],
  DET_STD: [0.5, 0.5, 0.5],
  DET_SCALE: 1 / 255,
  DET_BINARY_THRESH: 0.3,
  DET_BOX_THRESH: 0.5,
  DET_UNCLIP_RATIO: 1.6,
  DET_MAX_CANDIDATES: 1000,
  DET_MIN_BOX_SIDE_PX: 3,
  DET_USE_DILATION: true,
  DET_DILATION_KERNEL: 2,
  DET_SCORE_MODE: 'fast',
  DET_MAX_BOXES: 200,
  CROP_MIN_ROTATE_DEG: 0.5,
  CLS_INPUT_HEIGHT: 80,
  CLS_INPUT_WIDTH: 160,
  CLS_MEAN: 0.5,
  CLS_STD: 0.5,
  CLS_PAD_VALUE: 0,
  CLS_THRESH: 0.9,
  CLS_BATCH_SIZE: 6,
  REC_INPUT_HEIGHT: 48,
  REC_BASE_WIDTH: 320,
  REC_MAX_WIDTH: 1200,
  REC_MEAN: 0.5,
  REC_STD: 0.5,
  REC_PAD_VALUE: 0,
  REC_BATCH_SIZE: 6,
  REC_BLANK_INDEX: 0,
  REC_USE_SPACE_CHAR: true,
  REC_DROP_SCORE: 0.5,
  LINE_OVERLAP_RATIO: 0.5,
  LINE_JOIN: ' ',
  BLOCK_JOIN: '\n',
  ORT_INTRA_OP_THREADS: 2,
  ORT_INTER_OP_THREADS: 1,
  ORT_GRAPH_OPT: 'all',
  ORT_LOG_SEVERITY: 3,
  ORT_CPU_MEM_ARENA: false,
  OCR_PROBE_DETAIL_MAX_CHARS: 200,
};

/** 0, 1, 2 and 3 are excluded: they are array indices and channel counts everywhere. */
const EXEMPT = new Set([0, 1, 2, 3]);

function bannedNumbers(): Set<number> {
  const out = new Set<number>();
  for (const value of Object.values(TABLE)) {
    const numbers = typeof value === 'number' ? [value] : Array.isArray(value) ? value : [];
    for (const n of numbers) if (!EXEMPT.has(n)) out.add(n);
  }
  // DET_SCALE is 1 / 255; the literal a stage file could reach for is 255, not 0.0039...
  out.delete(1 / 255);
  out.add(255);
  return out;
}

/** A real line break, spelled without an escape so this file stays easy to edit by hand. */
const NEWLINE = String.fromCharCode(10);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function numericLiterals(source: string): number[] {
  return [...stripComments(source).matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w.$])/g)].map((m) =>
    Number(m[0].replace(/_/g, '')),
  );
}

describe('MUST-4.41: the pinned constant table', () => {
  it.each(Object.entries(TABLE))('%s equals the spec value', (name, expected) => {
    expect((C as Record<string, unknown>)[name]).toEqual(expected);
  });

  /**
   * v1.31.0 item M-4: THE POSITIVE CONTROL, which this guard shipped without.
   *
   * The check below asserts an empty offender list built from a directory walk and a regex. Both
   * can fail silently: a renamed directory, an `endsWith` that no longer matches, a typo in
   * numericLiterals' character class, or a TABLE that stopped yielding numbers all leave
   * `offenders` empty and the assertion green forever, protecting nothing. Every guard added in
   * v1.31.0 carries a control like this one; this file predates the convention, and M-4 is the
   * observation that "it passes" and "it works" had become indistinguishable here.
   *
   * Three things are pinned, because they are the three ways the scan can go vacuous: the walk
   * finds the stage files, the banned set is populated, and the detector still sees a planted
   * literal it is supposed to catch.
   */
  it('the scan is not vacuous: files walked, numbers banned, detector live', () => {
    const scanned = fs.readdirSync(ONNX_DIR).filter((entry) => entry !== 'constants.ts' && entry.endsWith('.ts'));
    expect(scanned.length).toBeGreaterThanOrEqual(10);
    expect(scanned).toContain('preprocess.ts');

    const banned = bannedNumbers();
    expect(banned.size).toBeGreaterThanOrEqual(20);
    expect(banned.has(C.DET_LIMIT_SIDE_LEN)).toBe(true);
    expect(banned.has(255)).toBe(true);

    // The defect, reconstructed: a stage file reaching for the number instead of the constant.
    const planted = ['const target = 736;', 'const scale = 1 / 255;'].join(NEWLINE);
    expect(numericLiterals(planted).filter((value) => banned.has(value))).toEqual([736, 255]);
    // ...and prose about the number is not the number (the stage files explain these in comments).
    expect(numericLiterals('// DET_LIMIT_SIDE_LEN is 736 for RapidOCR v3.9.2.')).toEqual([]);
  });

  it('every other file under onnx/ reaches for the constant, never the number', () => {
    const banned = bannedNumbers();
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(ONNX_DIR)) {
      if (entry === 'constants.ts' || !entry.endsWith('.ts')) continue;
      const found = numericLiterals(fs.readFileSync(path.join(ONNX_DIR, entry), 'utf8'));
      for (const value of found) if (banned.has(value)) offenders.push(`${entry}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('plan resolution 14: the client-safe byte cap is pinned to the server one', () => {
  it('SCANNER_MAX_OUTPUT_BYTES equals MAX_RECEIPT_BYTES', () => {
    // scan.ts cannot import @/lib/warranty/receipts: that module pulls node:fs, node:crypto
    // and @/lib/env, and scan.ts is value-imported by a 'use client' component. This test is
    // the pin that stops the duplicate drifting.
    expect(C.SCANNER_MAX_OUTPUT_BYTES).toBe(MAX_RECEIPT_BYTES);
  });
});

describe('MUST-2.1: constants.ts, contours.ts and assemble.ts are pure', () => {
  it.each(['constants.ts', 'contours.ts', 'assemble.ts'])('%s imports nothing forbidden', (file) => {
    const source = fs.readFileSync(path.join(ONNX_DIR, file), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env['"]/);
    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/['"]onnxruntime-node['"]/);
    expect(source).not.toMatch(/from\s+['"]sharp['"]/);
  });

  it('constants.ts imports nothing at all', () => {
    const source = stripComments(fs.readFileSync(path.join(ONNX_DIR, 'constants.ts'), 'utf8'));
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
