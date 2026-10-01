import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { onnxOcrEngine } from '@/lib/warranty/ocr/onnx/engine';
import { setOnnxSessionsForTests, type OnnxOcrSessions } from '@/lib/warranty/ocr/onnx/session';
import { solidRgb } from '../../../../helpers/ocr-images';

const DICT = ['', 'T', 'O', 'A', 'L', ' '];

afterEach(() => {
  setOnnxSessionsForTests(null);
  vi.restoreAllMocks();
});

async function receiptFile(): Promise<{ file: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-engine-'));
  const width = 1400;
  const height = 900;
  const png = await sharp(solidRgb(width, height, [250, 250, 250]), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();
  const file = path.join(dir, 'receipt.png');
  fs.writeFileSync(file, png);
  return { file, dir };
}

/**
 * A fake session set that reports one box covering the top strip and decodes it to 'TOTAL'.
 *
 * The detection map takes its spatial dims from the INPUT tensor, as a real detector's does,
 * with the bar clipped to it. detectBoxes throws on a spatial-dimension mismatch, and the
 * engine may ask at two sizes: the image as it came and, when that pass looks sideways, the
 * image turned 90 degrees (spec 2026-09-30 §2.4 item 5). One bar is one wide box, so the page
 * looks upright and is read from the first pass.
 */
async function fakeSessions(): Promise<OnnxOcrSessions> {
  return {
    runDet: async (input) => {
      const [, , height, width] = input.dims;
      const map = new Float32Array(width * height);
      for (let y = 10; y < Math.min(34, height); y += 1) {
        for (let x = 10; x < Math.min(120, width); x += 1) map[y * width + x] = 0.95;
      }
      return { data: map, dims: [1, 1, height, width] };
    },
    runCls: async (input) => {
      const batch = input.dims[0];
      const data = new Float32Array(batch * 2);
      for (let n = 0; n < batch; n += 1) data[n * 2] = 0.99;
      return { data, dims: [batch, 2] };
    },
    runRec: async (input) => {
      const batch = input.dims[0];
      const steps: number[] = [1, 2, 1, 3, 4];
      const data = new Float32Array(batch * steps.length * DICT.length);
      for (let n = 0; n < batch; n += 1) {
        steps.forEach((cls, t) => {
          data[(n * steps.length + t) * DICT.length + cls] = 0.95;
        });
      }
      return { data, dims: [batch, steps.length, DICT.length] };
    },
    clsInputHeight: 80,
    clsInputWidth: 160,
    recClassCount: DICT.length,
    dictionary: DICT,
  };
}

describe('onnxOcrEngine (MUST-4.1, MUST-4.2)', () => {
  it('satisfies the OcrEngine interface and returns { text }', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests(await fakeSessions());
      const result = await onnxOcrEngine.recognize(file, 'image/png');
      expect(Object.keys(result)).toEqual(['text']);
      expect(result.text).toContain('TOTAL');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs no inference at all for a PDF (MUST-4.2, MUST-7.1)', async () => {
    // v1.13.1 (item K). This used to call receiptFile() -- a 1400x900 raw RGB buffer through
    // sharp().png() -- and fakeSessions(), whose first line runs the real preprocessReceipt.
    // Both were dead weight: the PNG is never recognized and runDet is overwritten immediately,
    // and the cost is what made this test hit the 20s testTimeout in one full-suite run and
    // pass 7/7 in isolation straight after. Same family as item E, different mechanism: a
    // genuine wall-clock timeout on a test that loads the PDF stack while 249 other files
    // compete for the CPU. The fix is not a bigger timeout -- it is to measure the code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ocr-pdf-'));
    try {
      let touched = 0;
      const refuse = async (): Promise<never> => {
        touched += 1;
        throw new Error('the PDF path must never reach a session');
      };
      setOnnxSessionsForTests({
        runDet: refuse,
        runCls: refuse,
        runRec: refuse,
        clsInputHeight: 48,
        clsInputWidth: 192,
        recClassCount: DICT.length,
        dictionary: DICT,
      });

      const pdf = path.join(dir, 'not-a-pdf.pdf');
      fs.writeFileSync(pdf, Buffer.from('not really a pdf'));
      await expect(onnxOcrEngine.recognize(pdf, 'application/pdf')).rejects.toThrow('Invalid PDF structure.');
      expect(touched).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('returns an empty string when detection finds nothing, rather than throwing', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions()),
        runDet: async (input) => ({
          data: new Float32Array(input.dims[2] * input.dims[3]),
          dims: [1, 1, input.dims[2], input.dims[3]],
        }),
      });
      expect(await onnxOcrEngine.recognize(file, 'image/png')).toEqual({ text: '' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.9: a detection tensor whose spatial dims disagree with the input throws', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions()),
        runDet: async () => ({ data: new Float32Array(4), dims: [1, 1, 2, 2] }),
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow(/spatial/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.3: a detection failure propagates rather than being swallowed', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions()),
        runDet: async () => {
          throw new Error('det kernel exploded');
        },
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('det kernel exploded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.3: a recognition failure propagates rather than being swallowed', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests({
        ...(await fakeSessions()),
        runRec: async () => {
          throw new Error('rec kernel exploded');
        },
      });
      await expect(onnxOcrEngine.recognize(file, 'image/png')).rejects.toThrow('rec kernel exploded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MUST-4.35: the engine applies no cap of its own', async () => {
    const { file, dir } = await receiptFile();
    try {
      setOnnxSessionsForTests(await fakeSessions());
      const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/warranty/ocr/onnx/engine.ts'), 'utf8');
      expect(source).not.toContain('truncateOcrText');
      expect(source).not.toContain('MAX_OCR_TEXT_CHARS');
      await onnxOcrEngine.recognize(file, 'image/png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Spec 2026-09-30 §2.4 item 5: the turned pass is paid for only when the first one looks sideways. */
describe('onnxOcrEngine page orientation', () => {
  it('a page that detects as tall boxes is turned 90 and read from the turned pass', async () => {
    const { file, dir } = await receiptFile();
    try {
      // Answers by the shape it is asked about, as a real detector on a sideways page would: five
      // tall bars side by side on the landscape input, five wide bars stacked on the portrait one.
      const asked: string[] = [];
      setOnnxSessionsForTests({
        ...(await fakeSessions()),
        runDet: async (input) => {
          const [, , height, width] = input.dims;
          const landscape = width > height;
          asked.push(landscape ? 'landscape' : 'portrait');
          const map = new Float32Array(width * height);
          for (let bar = 0; bar < 5; bar += 1) {
            for (let across = 40 + bar * 100; across < 64 + bar * 100; across += 1) {
              for (let along = 10; along < 300; along += 1) {
                map[landscape ? along * width + across : across * width + along] = 0.95;
              }
            }
          }
          return { data: map, dims: [1, 1, height, width] };
        },
      });
      const { text } = await onnxOcrEngine.recognize(file, 'image/png');
      expect(asked).toEqual(['landscape', 'portrait']);
      // Read from the turned pass: five lines. The first pass's tall bars would share one line.
      expect(text).toBe(['TOTAL', 'TOTAL', 'TOTAL', 'TOTAL', 'TOTAL'].join('\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a page that detects as wide boxes costs one detection and no turned pass', async () => {
    const { file, dir } = await receiptFile();
    try {
      const base = await fakeSessions();
      let calls = 0;
      setOnnxSessionsForTests({
        ...base,
        runDet: async (input) => {
          calls += 1;
          return base.runDet(input);
        },
      });
      expect((await onnxOcrEngine.recognize(file, 'image/png')).text).toBe('TOTAL');
      expect(calls).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
