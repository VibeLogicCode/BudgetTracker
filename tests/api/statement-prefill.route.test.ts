import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { UPLOAD_BODY_LIMIT_BYTES } from '@/lib/upload-limits';

const pdf = vi.hoisted(() => ({ release: null as null | ((text: string) => void) }));

vi.mock('@/lib/warranty/ocr/pdf', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/warranty/ocr/pdf')>();
  return {
    ...original,
    extractPdfText: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pdf.release = resolve;
        }),
    ),
  };
});

import { POST } from '@/app/api/loans/statement-prefill/route';
import { extractPdfText } from '@/lib/warranty/ocr/pdf';

let current: TestDb | null = null;
let token: string;

beforeEach(() => {
  current = createSeededTestDb();
  token = createSession(insertTestUser(current.db, { name: 'Alex', username: 'alex' })).token;
  pdf.release = null;
  vi.mocked(extractPdfText).mockClear();
});

afterEach(() => {
  current?.cleanup();
  current = null;
});

function statementRequest(extraHeaders: Record<string, string> = {}): Request {
  const form = new FormData();
  form.append('statement', new File([Buffer.from('%PDF-1.7\n%%EOF\n')], 'statement.pdf', { type: 'application/pdf' }));
  return new Request('http://nas.local:3000/api/loans/statement-prefill', {
    method: 'POST',
    headers: { origin: 'http://nas.local:3000', host: 'nas.local:3000', cookie: `${SESSION_COOKIE_NAME}=${token}`, ...extraHeaders },
    body: form,
  });
}

const scratchFiles = () => fs.readdirSync(os.tmpdir()).filter((name) => /^statement-.*\.pdf$/.test(name));

async function untilReading(): Promise<void> {
  for (let attempt = 0; attempt < 200 && pdf.release === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(pdf.release).not.toBeNull();
}

describe('POST /api/loans/statement-prefill', () => {
  it('reads one statement at a time for the household: a second answers 429 and the first completes', async () => {
    const first = POST(statementRequest());
    await untilReading();

    const second = await POST(statementRequest());
    expect(second.status).toBe(429);

    pdf.release!('Closing balance $1,234.56');
    const done = await first;
    expect(done.status).toBe(200);
    expect(((await done.json()) as { balance: { valueCents: number } }).balance.valueCents).toBe(123_456);

    // The slot is free again once the first finishes.
    pdf.release = null;
    const third = POST(statementRequest());
    await untilReading();
    pdf.release!('Closing balance $10.00');
    expect((await third).status).toBe(200);
  });

  it('hands the PDF to the reader as bytes, with no scratch file in the system temp folder', async () => {
    const before = scratchFiles();
    const reading = POST(statementRequest());
    await untilReading();
    expect(scratchFiles()).toEqual(before);
    expect(vi.mocked(extractPdfText).mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
    pdf.release!('Closing balance $1.00');
    await reading;
  });

  it('refuses a declared length over UPLOAD_BODY_LIMIT_BYTES before reading the body', async () => {
    const response = await POST(statementRequest({ 'content-length': String(UPLOAD_BODY_LIMIT_BYTES + 1) }));
    expect(response.status).toBe(413);
    expect(extractPdfText).not.toHaveBeenCalled();
  });
});
