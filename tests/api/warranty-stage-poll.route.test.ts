import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/stage/[stagingId]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { writeAiSidecar, writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { saveLocalAiConfig } from '@/lib/ai/config';

const enqueue = vi.hoisted(() => vi.fn(() => true));
vi.mock('@/lib/ai/queue', () => ({ enqueueAiJob: enqueue }));

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let token: string;
let userId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  enqueue.mockClear();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-poll-route-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  userId = insertTestUser(current.db, { username: 'alice' });
  token = createSession(userId).token;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function poll(stagingId: string, opts: { token?: string | null; origin?: string | null } = {}) {
  const headers: Record<string, string> = { host: 'nas.local:3000' };
  const origin = opts.origin === undefined ? 'http://nas.local:3000' : opts.origin;
  if (origin !== null) headers.origin = origin;
  const sessionToken = opts.token === undefined ? token : opts.token;
  if (sessionToken) headers.cookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/stage/${stagingId}`, { headers });
  return GET(request, { params: Promise.resolve({ stagingId }) });
}

describe('GET /api/warranties/receipts/stage/[stagingId]', () => {
  it('reports pending while the sidecar is absent', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    const response = await poll(stagingId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  /*
    Spec 2026-09-30 §2.3: the client now sees what was read, but as the capped LINES the queue
    stores beside the text. The sidecar's `text` field (the whole capped read the FTS index gets)
    is still never part of the reply; a sidecar written without lines answers with none.
  */
  it('returns the suggestions on done, and never the sidecar\'s text field', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, {
      status: 'done',
      text: 'RAW OCR TEXT THE CLIENT MUST NOT RECEIVE',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
    });
    const body = await (await poll(stagingId)).json();
    expect(body).toEqual({
      status: 'done',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200, purchaseDate: '2026-08-16' },
      lines: [],
      candidates: { amounts: [], dates: [] },
      ai: { status: 'off' },
    });
    expect(body).not.toHaveProperty('text');
    expect(JSON.stringify(body)).not.toContain('RAW OCR TEXT');
  });

  it('returns the lines and the candidates on done when the sidecar has them (spec 2026-09-30 §2.3)', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    const lines = ['RIVERSIDE WATER', 'Amount due $312.44', 'Due date 2026-11-24'];
    const candidates = {
      amounts: [{ valueCents: 31244, snippet: 'Amount due $312.44', score: 3 }],
      dates: [{ date: '2026-11-24', snippet: 'Due date 2026-11-24', score: 2 }],
    };
    writeSidecar(stagingId, {
      status: 'done',
      text: lines.join('\n'),
      suggestions: { vendor: 'RIVERSIDE WATER', priceCents: 31244, dueDate: '2026-11-24' },
      lines,
      candidates,
    });
    const body = await (await poll(stagingId)).json();
    expect(body).toEqual({
      status: 'done',
      suggestions: { vendor: 'RIVERSIDE WATER', priceCents: 31244, dueDate: '2026-11-24' },
      lines,
      candidates,
      ai: { status: 'off' },
    });
    expect(body).not.toHaveProperty('text');
  });

  it('returns the error text on failed', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    expect(await (await poll(stagingId)).json()).toEqual({ status: 'failed', error: 'OCR timed out.' });
  });

  it('passes retryable: false through on a failure a retry cannot fix', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'failed', error: 'No text.', retryable: false });
    expect(await (await poll(stagingId)).json()).toEqual({ status: 'failed', error: 'No text.', retryable: false });
  });

  it('400s a staging id that is not a UUID, before any path is built', async () => {
    const response = await poll('../../budget.db');
    expect(response.status).toBe(400);
  });

  it('401s without a session and 403s a mismatched Origin', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    expect((await poll(stagingId, { token: null })).status).toBe(401);
    expect((await poll(stagingId, { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('allows a headerless request (plain HTTP on the LAN)', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    expect((await poll(stagingId, { origin: null })).status).toBe(200);
  });
});

/**
 * Review D7. A staging id was a bearer token: any signed-in member who had one could read the OCR
 * suggestions off somebody else's receipt -- its vendor, its date, its price. The upload now
 * records who staged it, and a poll by anybody else reads exactly like an id that does not exist.
 */
describe('D7: a staged upload belongs to whoever staged it', () => {
  it('tells another member nothing, even when the suggestions are ready', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'done', suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 } });
    const otherToken = createSession(insertTestUser(current!.db, { username: 'bob' })).token;

    const response = await poll(stagingId, { token: otherToken });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('still serves the member who staged it', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'done', suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 } });
    expect(await (await poll(stagingId)).json()).toEqual({
      status: 'done',
      suggestions: { vendor: 'HOME DEPOT', priceCents: 4200 },
      lines: [],
      candidates: { amounts: [], dates: [] },
      ai: { status: 'off' },
    });
  });

  /** A file staged by an older version has no owner recorded, so nobody can claim it. */
  it('refuses an upload with no recorded uploader', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    fs.rmSync(path.join(dataDir, 'tmp', `${stagingId}.owner.json`), { force: true });
    writeSidecar(stagingId, { status: 'done', suggestions: { vendor: 'HOME DEPOT' } });
    expect(await (await poll(stagingId)).json()).toEqual({ status: 'pending' });
  });
});

describe('the local AI read on a done poll (v1.64.0)', () => {
  const AT = new Date('2026-03-09T15:00:00.000Z');
  function doneReceipt(): string {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', userId);
    writeSidecar(stagingId, { status: 'done', text: 'MAPLE GROCER', suggestions: { vendor: 'MAPLE' } });
    return stagingId;
  }
  function aiOn() {
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId, at: AT });
  }

  it('with AI off, says off and queues nothing', async () => {
    const body = await (await poll(doneReceipt())).json();
    expect(body.ai).toEqual({ status: 'off' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('with AI on, the first done poll queues once and says pending; the second does not queue again', async () => {
    aiOn();
    const stagingId = doneReceipt();
    const first = await (await poll(stagingId)).json();
    expect(first.status).toBe('done');
    expect(first.ai).toEqual({ status: 'pending' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'receipt', stagingId, userId });
    // A second poll asks the queue again (its claimed set refuses a repeat) and still says pending.
    expect((await (await poll(stagingId)).json()).ai).toEqual({ status: 'pending' });
  });

  it('an AI sidecar gives done with its fields and queues nothing', async () => {
    aiOn();
    const stagingId = doneReceipt();
    writeAiSidecar(stagingId, { status: 'done', fields: { vendor: 'Maple Grocer', priceCents: 1299 }, at: AT.toISOString() });
    const body = await (await poll(stagingId)).json();
    expect(body.ai).toEqual({ status: 'done', fields: { vendor: 'Maple Grocer', priceCents: 1299 } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failed AI sidecar says failed', async () => {
    aiOn();
    const stagingId = doneReceipt();
    writeAiSidecar(stagingId, { status: 'failed', at: AT.toISOString() });
    expect((await (await poll(stagingId)).json()).ai).toEqual({ status: 'failed' });
  });

  it('while the helper is backing off, says off', async () => {
    aiOn();
    const { recordLocalAiFailure } = await import('@/lib/ai/config');
    recordLocalAiFailure(new Date(), 'Could not reach the helper.');
    const body = await (await poll(doneReceipt())).json();
    expect(body.ai).toEqual({ status: 'off' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("another member's id still gets a bare pending and queues nothing", async () => {
    aiOn();
    const other = insertTestUser(current!.db, { username: 'bob' });
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg', other);
    writeSidecar(stagingId, { status: 'done', text: 'x', suggestions: {} });
    const body = await (await poll(stagingId)).json();
    expect(body).toEqual({ status: 'pending' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
