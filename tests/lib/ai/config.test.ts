import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LOCAL_AI_TURNED_OFF_DETAIL,
  SETTING_LOCAL_AI_BASE_URL,
  SETTING_LOCAL_AI_ENABLED,
  SETTING_LOCAL_AI_FAILURES,
  SETTING_LOCAL_AI_LAST_ATTEMPT_AT,
  SETTING_LOCAL_AI_LAST_ERROR,
  SETTING_LOCAL_AI_LAST_OK_AT,
  SETTING_LOCAL_AI_MODEL,
  SETTING_LOCAL_AI_UNREADABLE_STREAK,
  localAiActive,
  localAiBackoff,
  localAiBackoffMs,
  localAiEnabled,
  localAiStatus,
  localAiUsable,
  readLocalAiConfig,
  recordLocalAiFailure,
  recordLocalAiSuccess,
  recordUnreadableAnswer,
  saveLocalAiConfig,
  testLocalAiConnection,
  turnOffLocalAi,
} from '@/lib/ai/config';
import { LOCAL_AI_MODEL_NAME_ERROR, unreachableError } from '@/lib/ai/client';
import { LOCAL_AI_LAN_ONLY_ERROR } from '@/lib/ai/lan';
import { recordMerchantFailure, recordMerchantSuggestion } from '@/lib/ai/suggestions';
import { listAudit } from '@/lib/audit';
import { getSetting, setSetting } from '@/lib/settings';
import { modelServerHandler, startFakeModelServer, type FakeModelServer } from '../../helpers/fake-model-server';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';

/** v1.64.0 (plan 2026-11-12, A6, L4 and L5). */
const AT = new Date('2026-03-09T15:00:00.000Z');
const MINUTE = 60_000;

let t: TestDb | null = null;
let server: FakeModelServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  t?.cleanup();
  t = null;
});

function setup(): number {
  t = createSeededTestDb();
  return insertTestUser(t.db, { name: 'Alex', username: 'alex' });
}

function allSettings(): Record<string, string> {
  const rows = t!.sqlite.prepare("select key, value from settings where key like 'local_ai_%' order by key").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe('saving, reading and turning off', () => {
  it('saves the origin and model, reads them back, and is on', () => {
    const alex = setup();
    expect(localAiEnabled()).toBe(false);
    expect(readLocalAiConfig()).toBeNull();
    const result = saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434/v1', model: 'test-model:1b', userId: alex, at: AT });
    expect(result).toEqual({ ok: true, config: { baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b' }, changed: true });
    expect(readLocalAiConfig()).toEqual({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b' });
    expect(localAiEnabled()).toBe(true);
    expect(localAiActive(AT)).toBe(true);
    expect(allSettings()).toEqual({
      [SETTING_LOCAL_AI_BASE_URL]: 'http://192.168.1.50:11434',
      [SETTING_LOCAL_AI_ENABLED]: '1',
      [SETTING_LOCAL_AI_MODEL]: 'test-model:1b',
    });
  });

  it('refuses a public address or a bad model name and writes nothing', () => {
    const alex = setup();
    expect(saveLocalAiConfig({ baseUrl: 'http://8.8.8.8:11434', model: 'test-model:1b', userId: alex, at: AT })).toEqual({
      ok: false,
      error: LOCAL_AI_LAN_ONLY_ERROR,
    });
    expect(saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'evil://user:pass@host', userId: alex, at: AT })).toEqual({
      ok: false,
      error: LOCAL_AI_MODEL_NAME_ERROR,
    });
    expect(allSettings()).toEqual({});
    expect(listAudit()).toEqual([]);
  });

  it('a new model clears failed rows and the state keys, and keeps suggestions', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    recordMerchantFailure({ merchant: 'FUEL STOP 12', model: 'test-model:1b', reason: 'Nothing in the answer could be used.', at: AT });
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: null, cleanName: 'Maple Grocer', model: 'test-model:1b', at: AT });
    recordLocalAiFailure(AT, 'Could not reach the model server at 192.168.1.50:11434.');
    recordUnreadableAnswer();

    // The same values again change nothing and keep the failed rows, but clear the backoff (below).
    expect(saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT })).toMatchObject({ changed: false });
    expect(t!.sqlite.prepare("select count(*) as c from ai_suggestions where status = 'failed'").get()).toEqual({ c: 1 });

    recordLocalAiFailure(AT, 'Could not reach the model server at 192.168.1.50:11434.');
    recordUnreadableAnswer();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'llama3.2:3b', userId: alex, at: AT });
    for (const key of [SETTING_LOCAL_AI_FAILURES, SETTING_LOCAL_AI_LAST_ATTEMPT_AT, SETTING_LOCAL_AI_LAST_ERROR, SETTING_LOCAL_AI_LAST_OK_AT, SETTING_LOCAL_AI_UNREADABLE_STREAK]) {
      expect(getSetting(key), key).toBeNull();
    }
    const statuses = t!.sqlite.prepare('select normalized_merchant as m, status from ai_suggestions order by m').all();
    expect(statuses).toEqual([{ m: 'MAPLE GROCER', status: 'suggested' }]);
  });

  it('saving the same address and model again clears an old backoff, so suggestions do start shortly', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    recordLocalAiSuccess(AT);
    recordLocalAiFailure(AT, 'Could not reach the model server at 192.168.1.50:11434.');
    recordUnreadableAnswer();
    expect(localAiActive(AT)).toBe(false);

    expect(saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT })).toMatchObject({ ok: true, changed: false });
    expect(localAiActive(AT)).toBe(true);
    expect(localAiStatus(AT)).toMatchObject({ state: 'on', failures: 0, lastError: null, nextTryAt: null, lastOkAt: AT.toISOString() });
    for (const key of [SETTING_LOCAL_AI_FAILURES, SETTING_LOCAL_AI_LAST_ERROR, SETTING_LOCAL_AI_UNREADABLE_STREAK]) {
      expect(getSetting(key), key).toBeNull();
    }
    // Nothing changed, so nothing is audited beyond the first save.
    expect(listAudit()).toHaveLength(1);
  });

  it('a saved address that no longer passes reads as off everywhere, and can still be turned off', () => {
    const alex = setup();
    // fd::1 is 00fd::1, a public address an earlier check let through.
    setSetting(SETTING_LOCAL_AI_ENABLED, '1');
    setSetting(SETTING_LOCAL_AI_BASE_URL, 'http://[fd::1]:11434');
    setSetting(SETTING_LOCAL_AI_MODEL, 'test-model:1b');
    expect(readLocalAiConfig()).toBeNull();
    expect(localAiEnabled()).toBe(true);
    expect(localAiUsable()).toBe(false);
    expect(localAiActive(AT)).toBe(false);
    expect(localAiStatus(AT)).toMatchObject({ state: 'off', enabled: true });

    expect(turnOffLocalAi({ userId: alex, at: AT })).toBe(true);
    expect(localAiStatus(AT)).toMatchObject({ state: 'off', enabled: false });
  });

  it('turning off keeps the address and model for the form', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://gpu-box.local:11434', model: 'test-model:1b', userId: alex, at: AT });
    expect(turnOffLocalAi({ userId: alex, at: AT })).toBe(true);
    expect(localAiEnabled()).toBe(false);
    expect(localAiActive(AT)).toBe(false);
    expect(readLocalAiConfig()).toEqual({ baseUrl: 'http://gpu-box.local:11434', model: 'test-model:1b' });
    expect(turnOffLocalAi({ userId: alex, at: AT })).toBe(false);
  });

  it('appends exactly one audit row per change, naming host and port only', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: new Date('2026-03-09T15:00:00.000Z') });
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: new Date('2026-03-09T15:01:00.000Z') });
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.51:11434', model: 'test-model:1b', userId: alex, at: new Date('2026-03-09T15:02:00.000Z') });
    turnOffLocalAi({ userId: alex, at: new Date('2026-03-09T15:03:00.000Z') });
    turnOffLocalAi({ userId: alex, at: new Date('2026-03-09T15:04:00.000Z') });
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.51:11434', model: 'test-model:1b', userId: alex, at: new Date('2026-03-09T15:05:00.000Z') });
    saveLocalAiConfig({ baseUrl: 'http://user:secret@192.168.1.51:11434', model: 'test-model:1b', userId: alex, at: new Date('2026-03-09T15:06:00.000Z') });
    const rows = listAudit();
    expect(rows.map((row) => [row.action, row.entity, row.entityId, row.detail])).toEqual([
      ['set_local_ai', 'settings', 0, 'Local AI on: test-model:1b at 192.168.1.51:11434'],
      ['set_local_ai', 'settings', 0, LOCAL_AI_TURNED_OFF_DETAIL],
      ['set_local_ai', 'settings', 0, 'Local AI on: test-model:1b at 192.168.1.51:11434'],
      ['set_local_ai', 'settings', 0, 'Local AI on: test-model:1b at 192.168.1.50:11434'],
    ]);
    for (const row of rows) {
      expect(row.detail).not.toContain('://');
      expect(row.detail).not.toContain('@');
      expect(row.detail).not.toContain('secret');
    }
  });
});

describe('backoff (L5)', () => {
  it('waits 5, 10, 20 minutes, doubling, never more than 6 hours', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 30].map((n) => localAiBackoffMs(n) / MINUTE)).toEqual([0, 5, 10, 20, 40, 320, 360, 360]);
  });

  it('waits from the last attempt, and a success clears it', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    recordLocalAiFailure(AT, 'Could not reach the model server at 192.168.1.50:11434.');
    expect(localAiActive(new Date(AT.getTime() + 4 * MINUTE))).toBe(false);
    expect(localAiActive(new Date(AT.getTime() + 5 * MINUTE))).toBe(true);
    recordLocalAiFailure(new Date(AT.getTime() + 5 * MINUTE), 'again');
    expect(localAiBackoff(new Date(AT.getTime() + 14 * MINUTE))).toEqual({ failures: 2, nextTryAt: new Date(AT.getTime() + 15 * MINUTE) });
    expect(localAiStatus(new Date(AT.getTime() + 14 * MINUTE))).toMatchObject({
      state: 'waiting',
      failures: 2,
      lastError: 'again',
      nextTryAt: '2026-03-09T15:15:00.000Z',
    });
    recordLocalAiSuccess(new Date(AT.getTime() + 15 * MINUTE));
    expect(localAiBackoff(new Date(AT.getTime() + 15 * MINUTE))).toBeNull();
    expect(localAiStatus(new Date(AT.getTime() + 15 * MINUTE))).toMatchObject({
      state: 'on',
      failures: 0,
      lastError: null,
      lastOkAt: '2026-03-09T15:15:00.000Z',
      nextTryAt: null,
    });
  });

  it('counts unreadable answers in a row, and a success or a failure resets the streak', () => {
    setup();
    expect([recordUnreadableAnswer(), recordUnreadableAnswer(), recordUnreadableAnswer()]).toEqual([1, 2, 3]);
    recordLocalAiSuccess(AT);
    expect(recordUnreadableAnswer()).toBe(1);
    recordLocalAiFailure(AT, 'x');
    expect(recordUnreadableAnswer()).toBe(1);
  });

  it('reads a damaged attempt time as no wait', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    setSetting(SETTING_LOCAL_AI_FAILURES, '3');
    setSetting(SETTING_LOCAL_AI_LAST_ATTEMPT_AT, 'garbage');
    expect(localAiActive(AT)).toBe(true);
  });

  it('reports off with counts when the helper is off', () => {
    setup();
    recordMerchantSuggestion({ merchant: 'MAPLE GROCER', categoryId: null, cleanName: 'Maple Grocer', model: 'test-model:1b', at: AT });
    expect(localAiStatus(AT)).toEqual({
      state: 'off',
      enabled: false,
      lastOkAt: null,
      nextTryAt: null,
      failures: 0,
      lastError: null,
      counts: { suggested: 1, ignored: 0, failed: 0, toAsk: 0 },
    });
  });
});

/**
 * v1.64.0 review fix. The Connections page reads localAiStatus for every admin. While the helper is
 * off or was never set up, it does no review-queue scan, and with no stored suggestion it counts
 * nothing at all.
 */
describe('localAiStatus does no new work while off', () => {
  function statements(run: () => void): string[] {
    const spy = vi.spyOn(t!.sqlite, 'prepare');
    try {
      run();
      return spy.mock.calls.map(([sql]) => String(sql));
    } finally {
      spy.mockRestore();
    }
  }
  const touchesTransactions = (sql: string) => /"transactions"/.test(sql);
  const countsSuggestions = (sql: string) => /ai_suggestions/.test(sql) && /count\(/i.test(sql);

  it('never set up, with an empty table: no count and no review-queue scan', () => {
    setup();
    let status: ReturnType<typeof localAiStatus> | null = null;
    const sqls = statements(() => {
      status = localAiStatus(AT);
    });
    expect(status!.counts).toEqual({ suggested: 0, ignored: 0, failed: 0, toAsk: 0 });
    expect(sqls.filter(touchesTransactions)).toEqual([]);
    expect(sqls.filter(countsSuggestions)).toEqual([]);
  });

  it('turned off with stored rows: counts them for Forget, still no review-queue scan', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    recordMerchantFailure({ merchant: 'FUEL STOP 12', model: 'test-model:1b', reason: 'Nothing in the answer could be used.', at: AT });
    turnOffLocalAi({ userId: alex, at: AT });
    let status: ReturnType<typeof localAiStatus> | null = null;
    const sqls = statements(() => {
      status = localAiStatus(AT);
    });
    expect(status!.counts).toEqual({ suggested: 0, ignored: 0, failed: 1, toAsk: 0 });
    expect(sqls.filter(touchesTransactions)).toEqual([]);
  });

  it('on: counts the merchants still to ask', () => {
    const alex = setup();
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    const sqls = statements(() => localAiStatus(AT));
    expect(sqls.filter(touchesTransactions).length).toBeGreaterThan(0);
  });
});

describe('testLocalAiConnection', () => {
  const VALID = { category: 'Groceries', merchant: 'Maple Grocer' };

  it('says the model answered, and writes no setting, state, suggestion or audit row', async () => {
    setup();
    server = await startFakeModelServer(modelServerHandler({ models: ['test-model:1b'], answer: () => VALID }));
    const result = await testLocalAiConnection({ baseUrl: server.baseUrl, model: 'test-model:1b' }, AT);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^test-model:1b answered in \d+\.\d seconds\.$/);
    // The models it listed come back with the answer, so the card's picker needs no second request.
    expect(result.models).toEqual(['test-model:1b']);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/models', 'POST /v1/chat/completions']);
    expect(server.requests[1].body).toContain('MAPLE GROCER 0042');
    expect(allSettings()).toEqual({});
    expect(listAudit()).toEqual([]);
    expect(t!.sqlite.prepare('select count(*) as c from ai_suggestions').get()).toEqual({ c: 0 });
  });

  it('says so when the server does not list the model but answered anyway', async () => {
    setup();
    server = await startFakeModelServer(modelServerHandler({ models: ['llama3.2:3b'], answer: () => VALID }));
    expect(await testLocalAiConnection({ baseUrl: server.baseUrl, model: 'test-model:1b' }, AT)).toEqual({
      ok: true,
      message: 'The server does not list test-model:1b; it answered anyway.',
      models: ['llama3.2:3b'],
    });
  });

  it('says when the answer is in the wrong shape', async () => {
    setup();
    server = await startFakeModelServer(modelServerHandler({ answer: () => ({ category: 'Fuel', merchant: 'Maple Grocer' }) }));
    const result = await testLocalAiConnection({ baseUrl: server.baseUrl, model: 'test-model:1b' }, AT);
    expect(result).toEqual({ ok: false, message: 'test-model:1b answered, but not in the shape the app asked for. Try a different model.' });
  });

  it('says it could not reach a refused connection, and refuses a public address without trying', async () => {
    setup();
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await testLocalAiConnection({ baseUrl: `http://127.0.0.1:${port}`, model: 'test-model:1b' }, AT)).toEqual({
      ok: false,
      message: unreachableError(`127.0.0.1:${port}`),
    });
    expect(await testLocalAiConnection({ baseUrl: 'http://8.8.8.8', model: 'test-model:1b' }, AT)).toEqual({ ok: false, message: LOCAL_AI_LAN_ONLY_ERROR });
    expect(allSettings()).toEqual({});
  });
});
