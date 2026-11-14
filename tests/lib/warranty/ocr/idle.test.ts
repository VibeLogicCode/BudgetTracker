import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { setSetting } from '@/lib/settings';
import { recognizeWithTesseract } from '@/lib/warranty/ocr/tesseract';
import { preprocessReceiptPng } from '@/lib/warranty/ocr/onnx/preprocess';
import {
  SETTING_OCR_ENGINE,
  SETTING_OCR_ENGINE_PROBED_VERSION,
  probeCacheKey,
  resetOcrProbeForTests,
} from '@/lib/warranty/ocr/onnx/probe';
import { createSeededTestDb, type TestDb } from '../../../helpers/db';
import { PREPROCESS_MAX_INPUT_PIXELS } from '@/lib/warranty/ocr/onnx/constants';
import {
  OCR_FAILED_MESSAGE,
  OCR_IDLE_TERMINATE_MS,
  getOcrEngine,
  releaseOcrEngine,
  setOcrEngineForTests,
  setOcrWorkerForTests,
  type TesseractWorkerLike,
} from '@/lib/warranty/ocr/engine';

/**
 * IMPORTANT 2: armIdleTimer() previously only re-armed the idle-terminate timer inside
 * `finally`, after a job finished. That left a window where job N's OWN recognize() call
 * could still be in flight when the timer job N-1 armed on ITS completion fired, terminating
 * a worker that a live job was actively using. This exercises the REAL defaultEngine (not a
 * fake OcrEngine) via setOcrWorkerForTests, which seeds the module's cached worker directly
 * so getWorker()'s cache-hit path is taken and createWorker()/real tesseract.js/WASM are
 * never invoked (MUST-7.17).
 */
let current: TestDb | null = null;
let warn: MockInstance<typeof console.warn>;

/**
 * A greyscale PNG whose header says `width` x `height` and whose data holds only `rows` rows. sharp
 * reads the header of every one of these; only a full one decodes.
 */
function partialPng(width: number, height: number, rows: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width + 1) * rows))), chunk('IEND', Buffer.alloc(0))]);
}

// One small readable receipt image for the engine tests below, which only care what the worker
// is asked, not what it is handed.
let imageDir: string;
let imageA: string;
let imageB: string;
beforeAll(async () => {
  imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-idle-'));
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c8c8c8' } }).png().toBuffer();
  imageA = path.join(imageDir, 'a.png');
  imageB = path.join(imageDir, 'b.png');
  fs.writeFileSync(imageA, png);
  fs.writeFileSync(imageB, png);
});
afterAll(() => fs.rmSync(imageDir, { recursive: true, force: true }));

beforeEach(() => {
  // The tesseract path warns when it cannot preprocess. Silenced so the output stays clean; the
  // fallback test asserts on it.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  current = createSeededTestDb();
  resetOcrProbeForTests();
  // The selector asks resolveOcrEngineKind() before it touches an engine. Seeding a
  // verdict that matches this build's cache key is what keeps this file about the idle
  // timer instead of about the probe: no child is spawned, and the fake worker below is
  // what actually runs.
  setSetting(SETTING_OCR_ENGINE, 'tesseract');
  setSetting(SETTING_OCR_ENGINE_PROBED_VERSION, probeCacheKey());
});

afterEach(async () => {
  vi.useRealTimers();
  await releaseOcrEngine();
  setOcrWorkerForTests(null);
  setOcrEngineForTests(null);
  resetOcrProbeForTests();
  current?.cleanup();
  current = null;
});

describe('idle-terminate timer does not fire on a worker a job is actively using', () => {
  it('disarms the pending idle timer the instant a second job claims the worker, even if the timer would have fired mid-recognition', async () => {
    vi.useFakeTimers();
    setOcrEngineForTests(null); // ensure the real defaultEngine is active

    const terminate = vi.fn(async () => {});
    let resolveJob2!: (value: { data: { text: string } }) => void;
    const job2Result = new Promise<{ data: { text: string } }>((resolve) => {
      resolveJob2 = resolve;
    });
    let calls = 0;
    const fake: TesseractWorkerLike = {
      recognize: async () => {
        calls += 1;
        if (calls === 1) return { data: { text: 'first' } };
        return job2Result;
      },
      terminate,
    };
    setOcrWorkerForTests(fake);

    // Job 1 completes quickly. Its `finally` arms a 60 s idle-terminate timer.
    const first = await getOcrEngine().recognize(imageA, 'image/png');
    expect(first.text).toBe('first');

    // Advance to just before the idle deadline, then start job 2 — this call must disarm
    // the pending timer BEFORE its own (still in-flight) recognize() call can be hit by it.
    await vi.advanceTimersByTimeAsync(OCR_IDLE_TERMINATE_MS - 5000);
    const job2 = getOcrEngine().recognize(imageB, 'image/png');

    // Advance well past the ORIGINAL idle deadline while job 2 is still awaiting its
    // recognize() call. If the timer were not disarmed, this would terminate the worker
    // out from under job 2.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminate).not.toHaveBeenCalled();

    resolveJob2({ data: { text: 'second' } });
    const second = await job2;
    expect(second.text).toBe('second');
    expect(terminate).not.toHaveBeenCalled();
  });

  it('still terminates on a fresh idle timer once the worker is genuinely idle again', async () => {
    vi.useFakeTimers();
    setOcrEngineForTests(null);

    const terminate = vi.fn(async () => {});
    const fake: TesseractWorkerLike = {
      recognize: async () => ({ data: { text: 'ok' } }),
      terminate,
    };
    setOcrWorkerForTests(fake);

    await getOcrEngine().recognize(imageA, 'image/png');
    await vi.advanceTimersByTimeAsync(OCR_IDLE_TERMINATE_MS + 1000);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('routes to the tesseract worker when that is the cached verdict, without spawning a probe', async () => {
    setOcrEngineForTests(null);
    const fake: TesseractWorkerLike = {
      recognize: async () => ({ data: { text: 'from the fallback' } }),
      terminate: async () => {},
    };
    setOcrWorkerForTests(fake);
    const result = await getOcrEngine().recognize(imageA, 'image/png');
    expect(result.text).toBe('from the fallback');
  });
});

describe('what the tesseract worker is handed', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-tess-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hands the worker the preprocessed PNG buffer, not the raw file path (spec 2026-09-30 §2.4 item 6)', async () => {
    const fixturePath = path.join(dir, 'tiny.png');
    fs.writeFileSync(
      fixturePath,
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c8c8c8' } }).png().toBuffer(),
    );
    const seen: unknown[] = [];
    setOcrWorkerForTests({ recognize: async (input) => { seen.push(input); return { data: { text: 'x' } }; }, terminate: async () => {} });
    await recognizeWithTesseract(fixturePath);
    expect(Buffer.isBuffer(seen[0])).toBe(true);
    // Byte-equal to the preprocessed PNG, so handing over the upload's own bytes cannot pass.
    expect(Buffer.compare(seen[0] as Buffer, await preprocessReceiptPng(fixturePath))).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('hands the worker the raw path when preprocessing refuses an image within the pixel limit', async () => {
    const partial = path.join(dir, 'partial.png');
    fs.writeFileSync(partial, partialPng(40, 30, 2));
    const seen: unknown[] = [];
    setOcrWorkerForTests({ recognize: async (input) => { seen.push(input); return { data: { text: 'x' } }; }, terminate: async () => {} });
    await recognizeWithTesseract(partial);
    expect(seen[0]).toBe(partial);
    expect(warn).toHaveBeenCalledWith('[ocr] tesseract preprocess failed; reading the raw file', expect.anything());
  });

  it('fails the job without reaching the worker when the image is past the pixel limit', async () => {
    const side = Math.ceil(Math.sqrt(PREPROCESS_MAX_INPUT_PIXELS)) + 1;
    const oversized = path.join(dir, 'oversized.png');
    fs.writeFileSync(oversized, partialPng(side, side, 2));
    const recognize = vi.fn(async () => ({ data: { text: 'x' } }));
    setOcrWorkerForTests({ recognize, terminate: async () => {} });
    await expect(recognizeWithTesseract(oversized)).rejects.toThrow(OCR_FAILED_MESSAGE);
    expect(recognize).not.toHaveBeenCalled();
  });

  it('fails the job without reaching the worker when sharp cannot read the file', async () => {
    const missing = path.join(dir, 'missing.jpg');
    const recognize = vi.fn(async () => ({ data: { text: 'x' } }));
    setOcrWorkerForTests({ recognize, terminate: async () => {} });
    await expect(recognizeWithTesseract(missing)).rejects.toThrow(OCR_FAILED_MESSAGE);
    expect(recognize).not.toHaveBeenCalled();
  });
});
