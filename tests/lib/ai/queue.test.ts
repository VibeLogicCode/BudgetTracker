import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SETTING_LOCAL_AI_FAILURES, localAiStatus, saveLocalAiConfig, turnOffLocalAi } from '@/lib/ai/config';
import { AI_QUEUE_MAX_MERCHANT_JOBS, aiQueueDepth, drainAiQueue, enqueueAiJob, resetAiQueueForTests, sweepAiWork } from '@/lib/ai/queue';
import { getSetting } from '@/lib/settings';
import { readAiSidecar, writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { chatBody, modelServerHandler, sendJson, startFakeModelServer, type CapturedRequest, type FakeModelServer } from '../../helpers/fake-model-server';
import { buildAiFixture, type AiFixture } from '../../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, A9 and L5). Fake server, fake Date. */
const AT = new Date('2026-03-10T09:00:00.000Z');
const MINUTE = 60_000;
const MODEL = 'test-model:1b';

let fx: AiFixture | null = null;
let server: FakeModelServer | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ai-queue-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  await drainAiQueue();
  resetAiQueueForTests();
  await server?.close();
  server = null;
  fx?.t.cleanup();
  fx = null;
  vi.useRealTimers();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const userText = (request: CapturedRequest) => chatBody(request).messages[1].content;
const asksAbout = (request: CapturedRequest) => /Description: (.*)/.exec(userText(request))?.[1] ?? 'receipt';

/** One uncategorized row for `merchant`, described as the bank would: `BOOK NOOK 0815`. */
function addMerchant(merchant: string, date = '2026-03-01'): void {
  fx!.t.sqlite
    .prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
       values (?, ?, ?, ?, -1000, ?, '2026-03-10T12:00:00.000Z', '2026-03-10T12:00:00.000Z')`,
    )
    .run(fx!.joint, date, `${merchant} 0815`, merchant, fx!.alex);
}

function rows(): { m: string; status: string; category: number | null; name: string | null }[] {
  return fx!.t.sqlite
    .prepare('select normalized_merchant as m, status, category_id as category, clean_name as name from ai_suggestions order by m')
    .all() as { m: string; status: string; category: number | null; name: string | null }[];
}

async function turnOn(answer: (request: CapturedRequest) => unknown): Promise<FakeModelServer> {
  server = await startFakeModelServer(modelServerHandler({ answer }));
  saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx!.alex, at: AT });
  return server;
}

const GOOD = { category: 'Food > Groceries', merchant: 'Maple Grocer' };

describe('merchant jobs', () => {
  it('a sweep then a drain stores MAPLE GROCER with the label id and the clean name; a second sweep queues nothing', async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => GOOD);
    expect(sweepAiWork(AT)).toBe(1);
    await drainAiQueue();
    expect(rows()).toEqual([{ m: 'MAPLE GROCER', status: 'suggested', category: fx.groceries, name: 'Maple Grocer' }]);
    expect(s.requests).toHaveLength(1);
    expect(asksAbout(s.requests[0])).toBe('MAPLE GROCER 0042');
    expect(localAiStatus(AT)).toMatchObject({ state: 'on', lastOkAt: AT.toISOString(), failures: 0 });

    expect(sweepAiWork(AT)).toBe(0);
    await drainAiQueue();
    expect(s.requests).toHaveLength(1);
  });

  it('makes no request while off', async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => GOOD);
    turnOffLocalAi({ userId: fx.alex, at: AT });
    expect(sweepAiWork(AT)).toBe(0);
    expect(enqueueAiJob({ kind: 'merchant', merchant: 'MAPLE GROCER' })).toBe(true);
    await drainAiQueue();
    expect(s.requests).toHaveLength(0);
    expect(aiQueueDepth()).toBe(0);
  });

  it('a closed port is one failure and no rows, the rest are dropped, and a sweep inside the wait asks nothing', async () => {
    fx = buildAiFixture();
    addMerchant('BOOK NOOK');
    addMerchant('PIZZA PLACE');
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    saveLocalAiConfig({ baseUrl: `http://127.0.0.1:${port}`, model: MODEL, userId: fx.alex, at: AT });

    expect(sweepAiWork(AT)).toBe(3);
    await drainAiQueue();
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBe('1');
    expect(rows()).toEqual([]);
    expect(aiQueueDepth()).toBe(0);
    expect(localAiStatus(AT)).toMatchObject({ state: 'waiting', lastError: `Could not reach the model server at 127.0.0.1:${port}.` });

    vi.setSystemTime(new Date(AT.getTime() + 4 * MINUTE));
    expect(sweepAiWork(new Date())).toBe(0);
    expect(enqueueAiJob({ kind: 'merchant', merchant: 'MAPLE GROCER' })).toBe(true);
    await drainAiQueue();
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBe('1');
  });

  it('after the wait, one request again, and a success clears the count', async () => {
    fx = buildAiFixture();
    addMerchant('BOOK NOOK');
    let fail = true;
    server = await startFakeModelServer((request, res) => {
      if (fail) {
        sendJson(res, 500, { error: 'loading' });
        return;
      }
      modelServerHandler({ answer: () => GOOD })(request, res);
    });
    saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx.alex, at: AT });
    expect(sweepAiWork(AT)).toBe(2);
    await drainAiQueue();
    expect(server.requests).toHaveLength(1);
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBe('1');

    vi.setSystemTime(new Date(AT.getTime() + 4 * MINUTE));
    expect(sweepAiWork(new Date())).toBe(0);
    expect(server.requests).toHaveLength(1);

    fail = false;
    vi.setSystemTime(new Date(AT.getTime() + 5 * MINUTE));
    expect(sweepAiWork(new Date())).toBe(2);
    await drainAiQueue();
    expect(server.requests).toHaveLength(3);
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBeNull();
    expect(rows().map((row) => row.status)).toEqual(['suggested', 'suggested']);
  });

  it('an unreadable answer marks that merchant failed and the next one still runs', async () => {
    fx = buildAiFixture();
    addMerchant('BOOK NOOK');
    const s = await turnOn((request) => (asksAbout(request) === 'MAPLE GROCER 0042' ? 'not json at all' : { category: null, merchant: 'Book Nook' }));
    sweepAiWork(AT);
    await drainAiQueue();
    expect(s.requests).toHaveLength(2);
    expect(rows()).toEqual([
      { m: 'BOOK NOOK', status: 'suggested', category: null, name: 'Book Nook' },
      { m: 'MAPLE GROCER', status: 'failed', category: null, name: null },
    ]);
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBeNull();
  });

  it('an answer outside the labels, or with nothing usable, marks that merchant failed', async () => {
    fx = buildAiFixture();
    addMerchant('BOOK NOOK');
    // BOOK NOOK's answer hands the bank's own text back, which is not a name.
    await turnOn((request) => (asksAbout(request) === 'MAPLE GROCER 0042' ? { category: 'Fuel', merchant: null } : { category: null, merchant: 'Book Nook 0815' }));
    sweepAiWork(AT);
    await drainAiQueue();
    expect(rows().map((row) => [row.m, row.status])).toEqual([
      ['BOOK NOOK', 'failed'],
      ['MAPLE GROCER', 'failed'],
    ]);
  });

  it('five unreadable answers in a row wait like a server failure', async () => {
    fx = buildAiFixture();
    for (const name of ['A1 SHOP', 'B2 SHOP', 'C3 SHOP', 'D4 SHOP', 'E5 SHOP']) addMerchant(name);
    const s = await turnOn(() => '{"category":');
    expect(sweepAiWork(AT)).toBe(6);
    await drainAiQueue();
    expect(s.requests).toHaveLength(5);
    expect(rows().filter((row) => row.status === 'failed')).toHaveLength(5);
    expect(localAiStatus(AT)).toMatchObject({ state: 'waiting', failures: 1, lastError: 'The model gave 5 unreadable answers in a row.' });
  });

  it('a row filed between queueing and running makes no request', async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => GOOD);
    expect(sweepAiWork(AT)).toBe(1);
    fx.t.sqlite.prepare("update transactions set category_id = ?, categorization_source = 'manual' where normalized_merchant = 'MAPLE GROCER'").run(fx.groceries);
    await drainAiQueue();
    expect(s.requests).toHaveLength(0);
    expect(rows()).toEqual([]);
  });

  it('holds at most 100 merchant jobs', async () => {
    fx = buildAiFixture();
    await turnOn(() => GOOD);
    // Enqueued synchronously: the pump has not started, so nothing is taken off yet.
    const accepted = Array.from({ length: AI_QUEUE_MAX_MERCHANT_JOBS + 5 }, (_, i) => enqueueAiJob({ kind: 'merchant', merchant: `SHOP ${i}` }));
    expect(accepted.filter(Boolean)).toHaveLength(AI_QUEUE_MAX_MERCHANT_JOBS);
    expect(enqueueAiJob({ kind: 'merchant', merchant: 'SHOP 0' })).toBe(false);
    resetAiQueueForTests();
  });
});

describe('receipt jobs', () => {
  const RECEIPT_TEXT = ['MAPLE GROCER', 'Date: 2026-03-08', 'SUBTOTAL 42.17', 'TOTAL 47.32'].join('\n');
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

  function stage(userId: number): string {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'done', text: RECEIPT_TEXT });
    return stagingId;
  }

  const receiptAnswer = { vendor: 'Maple Grocer', total: '47.32', purchaseDate: '2026-03-08', dueDate: '2026-03-07' };

  it('runs ahead of three merchant jobs, and stores only the grounded fields', async () => {
    fx = buildAiFixture();
    addMerchant('BOOK NOOK');
    addMerchant('PIZZA PLACE');
    const s = await turnOn((request) => (asksAbout(request) === 'receipt' ? receiptAnswer : { category: null, merchant: null }));
    const stagingId = stage(fx.alex);
    expect(sweepAiWork(AT)).toBe(3);
    expect(enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.alex })).toBe(true);
    expect(enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.alex })).toBe(false);
    await drainAiQueue();
    expect(s.requests).toHaveLength(4);
    expect(asksAbout(s.requests[0])).toBe('receipt');
    expect(userText(s.requests[0])).toContain('Today is 2026-03-');
    expect(userText(s.requests[0])).toContain('TOTAL 47.32');
    expect(readAiSidecar(stagingId)).toEqual({
      status: 'done',
      fields: { vendor: 'Maple Grocer', priceCents: 4732, purchaseDate: '2026-03-08' },
      at: AT.toISOString(),
    });
    // Answered once: a second job for it asks nothing.
    expect(enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.alex })).toBe(true);
    await drainAiQueue();
    expect(s.requests).toHaveLength(4);
  });

  it("skips another member's receipt", async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => receiptAnswer);
    const stagingId = stage(fx.alex);
    enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.sam });
    await drainAiQueue();
    expect(s.requests).toHaveLength(0);
    expect(readAiSidecar(stagingId)).toBeNull();
  });

  it('writes a failed AI sidecar when the server fails, so the form stops waiting', async () => {
    fx = buildAiFixture();
    server = await startFakeModelServer((_request, res) => sendJson(res, 503, { error: 'busy' }));
    saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx.alex, at: AT });
    const stagingId = stage(fx.alex);
    enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.alex });
    sweepAiWork(AT);
    await drainAiQueue();
    expect(server.requests).toHaveLength(1);
    expect(readAiSidecar(stagingId)).toEqual({ status: 'failed', at: AT.toISOString() });
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBe('1');
    expect(rows()).toEqual([]);
  });

  it('writes a failed AI sidecar when nothing in the answer is printed on the receipt', async () => {
    fx = buildAiFixture();
    await turnOn(() => ({ vendor: 'Fuel Stop', total: '99.99', purchaseDate: null, dueDate: null }));
    const stagingId = stage(fx.alex);
    enqueueAiJob({ kind: 'receipt', stagingId, userId: fx.alex });
    await drainAiQueue();
    expect(readAiSidecar(stagingId)).toEqual({ status: 'failed', at: AT.toISOString() });
  });
});
