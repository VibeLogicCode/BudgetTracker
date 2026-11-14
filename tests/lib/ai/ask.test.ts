import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ASK_DATES_ERROR,
  ASK_NOTHING_ERROR,
  ASK_OFF_ERROR,
  ASK_QUESTION_LENGTH_ERROR,
  ASK_SHAPE_ERROR,
  ASK_UNREADABLE_ERROR,
  ASK_BUSY_ERROR,
  ASK_COOLDOWN_ERROR,
  ASK_COOLDOWN_MS,
  askChoices,
  askToFilter,
  beginAsk,
  endAsk,
  readAskAnswer,
  resetAskLimitsForTests,
} from '@/lib/ai/ask';
import {
  SETTING_LOCAL_AI_FAILURES,
  SETTING_LOCAL_AI_LAST_ATTEMPT_AT,
  SETTING_LOCAL_AI_LAST_ERROR,
  SETTING_LOCAL_AI_LAST_OK_AT,
  localAiActive,
  saveLocalAiConfig,
} from '@/lib/ai/config';
import type { Viewer } from '@/lib/auth/viewer';
import { getSetting, setSetting } from '@/lib/settings';
import { transactionsHref } from '@/lib/transaction-links';
import { chatBody, modelServerHandler, startFakeModelServer, type CapturedRequest, type FakeModelServer } from '../../helpers/fake-model-server';
import { FIXTURE_NOTE, buildAiFixture, type AiFixture } from '../../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, Lane E). Ask in words, against the fake model server. March 2026. */
const AT = new Date('2026-03-10T09:00:00.000Z');
const TODAY = '2026-03-10';
const MODEL = 'test-model:1b';
const QUESTION = 'what did we spend at the grocery store this month';

let fx: AiFixture | null = null;
let server: FakeModelServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  fx?.t.cleanup();
  fx = null;
  resetAskLimitsForTests();
});

/** Every key the schema names, null or false unless a test says otherwise. */
const answer = (over: Record<string, unknown> = {}) => ({
  from: null,
  to: null,
  category: null,
  account: null,
  person: null,
  text: null,
  spendingOnly: false,
  ...over,
});

const household = (): Viewer => ({ id: fx!.alex, role: 'admin', visibility: 'household' });
const selfSam = (): Viewer => ({ id: fx!.sam, role: 'member', visibility: 'self' });
const userText = (request: CapturedRequest) => chatBody(request).messages[1].content;

async function turnOn(reply: (request: CapturedRequest) => unknown): Promise<FakeModelServer> {
  server = await startFakeModelServer(modelServerHandler({ answer: reply }));
  saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx!.alex, at: AT });
  return server;
}

const ask = (viewer: Viewer, question: unknown = QUESTION) => askToFilter({ question, viewer, today: TODAY, at: AT });

describe('askToFilter: the answer becomes a link, and the page does the sums', () => {
  it("the fake server's answer becomes the expected href and reading", async () => {
    fx = buildAiFixture();
    const s = await turnOn(() =>
      answer({ from: '2026-03-01', to: '2026-03-31', category: 'Food > Groceries', person: 'Sam', spendingOnly: true }),
    );
    const result = await ask(household());
    expect(result).toEqual({
      ok: true,
      href: `/transactions?range=custom&from=2026-03-01&to=2026-03-31&person=${fx.sam}&category=${fx.groceries}&spending=1`,
      reading: 'Food › Groceries, Sam, spending only, Mar 1 to Mar 31',
    });
    expect(result.ok && result.href).toBe(
      transactionsHref({ range: { from: '2026-03-01', to: '2026-03-31' }, person: fx.sam }, { kind: 'filter', categoryId: fx.groceries, spendingOnly: true }),
    );
    expect(s.requests).toHaveLength(1);
    const body = chatBody(s.requests[0]);
    expect(body.response_format.json_schema.name).toBe('transactions_filter');
    const schema = body.response_format.json_schema.schema as { properties: Record<string, unknown>; additionalProperties: boolean; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(['account', 'category', 'from', 'person', 'spendingOnly', 'text', 'to']);
    expect(schema.required.sort()).toEqual(['account', 'category', 'from', 'person', 'spendingOnly', 'text', 'to']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.person).toEqual({ anyOf: [{ type: 'string', enum: ['Alex', 'Sam'] }, { type: 'null' }] });
  });

  it('search text and an account read back into the link', async () => {
    fx = buildAiFixture();
    await turnOn(() => answer({ text: '  maple  grocer ', account: 'Maple Joint Chequing' }));
    expect(await ask(household())).toEqual({
      ok: true,
      href: `/transactions?account=${fx.joint}&q=maple+grocer`,
      reading: 'Matching “maple grocer”, Maple Joint Chequing, every date',
    });
  });

  it("a household viewer's prompt holds today, the labels, the accounts, the people and the question, and no transaction", async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => answer({ spendingOnly: true }));
    await ask(household());
    const text = userText(s.requests[0]);
    for (const expected of [
      `Today is ${TODAY}.`,
      '- Food > Groceries',
      '- Maple Joint Chequing',
      '- Sam Rewards Visa',
      '- Alex',
      '- Sam',
      `Question: ${QUESTION}`,
    ]) {
      expect(text).toContain(expected);
    }
    for (const absent of ['MAPLE GROCER', 'FUEL STOP', 'STREAMBOX', '42.17', '63.09', '18.50', FIXTURE_NOTE, 'Example Credit Union']) {
      expect(text).not.toContain(absent);
    }
  });

  it("a self viewer's prompt lists only their own accounts and no person, and an answer naming more is refused", async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => answer({ spendingOnly: true }));
    expect(await ask(selfSam())).toMatchObject({ ok: true, href: '/transactions?spending=1' });
    const text = userText(s.requests[0]);
    expect(text).toContain('- Sam Rewards Visa');
    expect(text).not.toContain('Maple Joint Chequing');
    expect(text).not.toContain('People:');
    expect(text).not.toContain('Alex');
    const schema = chatBody(s.requests[0]).response_format.json_schema.schema as { properties: Record<string, unknown> };
    expect(schema.properties.person).toEqual({ type: 'null' });

    const choices = askChoices(selfSam());
    expect(readAskAnswer(answer({ account: 'Maple Joint Chequing' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ person: 'Sam' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ account: 'Sam Rewards Visa' }), choices, TODAY)).toMatchObject({ ok: true, href: `/transactions?account=${fx.samCard}` });
  });
});

describe('readAskAnswer: a closed set of filters', () => {
  it('an unknown label is refused', () => {
    fx = buildAiFixture();
    const choices = askChoices(household());
    expect(readAskAnswer(answer({ category: 'Pets > Vet' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ person: 'Jordan' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ account: 'Offshore Account' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ text: 'x'.repeat(41) }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer({ category: 'Food > Groceries' }, choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer('Food > Groceries', choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
  });

  it('a key the schema does not name is dropped, never read', () => {
    fx = buildAiFixture();
    const result = readAskAnswer(
      answer({ category: 'Food > Groceries', minAmount: 50, accountId: 999, href: '/settings', write: true }),
      askChoices(household()),
      TODAY,
    );
    expect(result).toEqual({ ok: true, href: `/transactions?category=${fx.groceries}`, reading: 'Food › Groceries, every date' });
  });

  it('dates must be real, in order and within 10 years of today', () => {
    fx = buildAiFixture();
    const choices = askChoices(household());
    for (const bad of [
      { from: '2026-03-31', to: '2026-03-01' },
      { from: '2016-03-09', to: '2016-12-31' },
      { from: '2026-01-01', to: '2036-03-11' },
      { from: '2026-02-30', to: '2026-03-01' },
    ]) {
      expect(readAskAnswer(answer(bad), choices, TODAY), JSON.stringify(bad)).toEqual({ ok: false, error: ASK_DATES_ERROR });
    }
    // Not even shaped like a date: the schema refuses it before the date check.
    expect(readAskAnswer(answer({ from: '2026-3-1' }), choices, TODAY)).toEqual({ ok: false, error: ASK_SHAPE_ERROR });
    expect(readAskAnswer(answer({ from: '2016-03-10', to: '2016-12-31' }), choices, TODAY)).toMatchObject({ ok: true });
  });

  it('one date is an open range: since a day runs to today, up to a day runs from the 10-year floor', () => {
    fx = buildAiFixture();
    const choices = askChoices(household());
    expect(readAskAnswer(answer({ from: '2026-01-01' }), choices, TODAY)).toEqual({
      ok: true,
      href: '/transactions?range=custom&from=2026-01-01&to=2026-03-10',
      reading: 'Since Jan 1',
    });
    expect(readAskAnswer(answer({ to: '2025-12-31' }), choices, TODAY)).toEqual({
      ok: true,
      href: '/transactions?range=custom&from=2016-03-10&to=2025-12-31',
      reading: 'Up to Dec 31, 2025',
    });
  });

  it('an answer with no filter at all is refused rather than listing everything', () => {
    fx = buildAiFixture();
    expect(readAskAnswer(answer({ text: '   ' }), askChoices(household()), TODAY)).toEqual({ ok: false, error: ASK_NOTHING_ERROR });
  });
});

describe('askToFilter: off, down, unreadable, and the question', () => {
  it('off is refused, and nothing is sent', async () => {
    fx = buildAiFixture();
    expect(await ask(household())).toEqual({ ok: false, error: ASK_OFF_ERROR });
  });

  it('a question shorter than 3 or longer than 200 characters is refused before any request', async () => {
    fx = buildAiFixture();
    const s = await turnOn(() => answer({ spendingOnly: true }));
    expect(await ask(household(), 'hi')).toEqual({ ok: false, error: ASK_QUESTION_LENGTH_ERROR });
    expect(await ask(household(), 'a'.repeat(201))).toEqual({ ok: false, error: ASK_QUESTION_LENGTH_ERROR });
    expect(await ask(household(), 42)).toEqual({ ok: false, error: ASK_QUESTION_LENGTH_ERROR });
    expect(s.requests).toHaveLength(0);
  });

  it('a server that is down reads as off and starts the backoff, so the box goes away', async () => {
    fx = buildAiFixture();
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    saveLocalAiConfig({ baseUrl: `http://127.0.0.1:${port}`, model: MODEL, userId: fx.alex, at: AT });
    expect(localAiActive(AT)).toBe(true);
    expect(await ask(household())).toEqual({ ok: false, error: ASK_OFF_ERROR });
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBe('1');
    expect(localAiActive(AT)).toBe(false);
  });

  it('an answer in the shape asked for clears an old failure count, as the queue does', async () => {
    fx = buildAiFixture();
    await turnOn(() => answer({ spendingOnly: true }));
    // Two failures long past their wait: active again, but the next failure would wait 20 minutes.
    setSetting(SETTING_LOCAL_AI_FAILURES, '2');
    setSetting(SETTING_LOCAL_AI_LAST_ATTEMPT_AT, '2026-03-10T07:00:00.000Z');
    setSetting(SETTING_LOCAL_AI_LAST_ERROR, 'Could not reach the model server.');
    expect(localAiActive(AT)).toBe(true);
    expect(await ask(household())).toMatchObject({ ok: true });
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBeNull();
    expect(getSetting(SETTING_LOCAL_AI_LAST_ERROR)).toBeNull();
    expect(getSetting(SETTING_LOCAL_AI_LAST_OK_AT)).toBe(AT.toISOString());
  });

  it('an unreadable answer is this question only: refused, and no failure recorded', async () => {
    fx = buildAiFixture();
    await turnOn(() => 'Sure! You spent a lot on groceries.');
    expect(await ask(household())).toEqual({ ok: false, error: ASK_UNREADABLE_ERROR });
    expect(getSetting(SETTING_LOCAL_AI_FAILURES)).toBeNull();
    expect(localAiActive(AT)).toBe(true);
  });
});

describe('one question at a time per person, and a short wait', () => {
  it('refuses a second question in flight and one inside the cooldown, never another person', () => {
    expect(beginAsk(1, 0)).toBeNull();
    expect(beginAsk(1, 10)).toBe(ASK_BUSY_ERROR);
    expect(beginAsk(2, 10)).toBeNull();
    endAsk(1, 1_000);
    expect(beginAsk(1, 1_000 + ASK_COOLDOWN_MS - 1)).toBe(ASK_COOLDOWN_ERROR);
    expect(beginAsk(1, 1_000 + ASK_COOLDOWN_MS)).toBeNull();
  });
});
