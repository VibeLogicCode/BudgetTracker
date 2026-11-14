import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { ASK_COOLDOWN_ERROR, ASK_COOLDOWN_MS, ASK_OFF_ERROR, ASK_QUESTION_LENGTH_ERROR, resetAskLimitsForTests } from '@/lib/ai/ask';
import { saveLocalAiConfig, turnOffLocalAi } from '@/lib/ai/config';
import { chatBody, modelServerHandler, startFakeModelServer, type CapturedRequest, type FakeModelServer } from '../helpers/fake-model-server';
import { buildAiFixture, type AiFixture } from '../helpers/ai-fixture';

/** v1.64.0 (plan 2026-11-12, E3). The Ask in words action, against the fake model server. */
const AT = new Date('2026-03-10T14:00:00.000Z');
const MODEL = 'test-model:1b';
const QUESTION = 'groceries this month';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility: 'household' | 'self' } = {
  id: 1,
  name: 'Alex',
  username: 'alex',
  role: 'admin',
  visibility: 'household',
};
const sameOrigin = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));
vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' })
      : new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }),
}));

import { askInWordsAction } from '@/app/(app)/transactions/ask-action';

let fx: AiFixture | null = null;
let server: FakeModelServer | null = null;

beforeEach(() => {
  sameOrigin.value = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
});

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
  fx?.t.cleanup();
  fx = null;
  resetAskLimitsForTests();
});

const form = (question: string) => {
  const data = new FormData();
  data.set('question', question);
  return data;
};

const GROCERIES_THIS_MONTH = {
  from: '2026-03-01',
  to: '2026-03-31',
  category: 'Food > Groceries',
  account: null,
  person: null,
  text: null,
  spendingOnly: true,
};

function signIn(as: 'alex' | 'sam-self'): void {
  currentUser =
    as === 'alex'
      ? { id: fx!.alex, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' }
      : { id: fx!.sam, name: 'Sam', username: 'sam', role: 'member', visibility: 'self' };
}

async function turnOn(reply: (request: CapturedRequest) => unknown = () => GROCERIES_THIS_MONTH): Promise<FakeModelServer> {
  server = await startFakeModelServer(modelServerHandler({ answer: reply }));
  saveLocalAiConfig({ baseUrl: server.baseUrl, model: MODEL, userId: fx!.alex, at: AT });
  return server;
}

describe('askInWordsAction', () => {
  it('turns the question into a /transactions link and says how it read it', async () => {
    fx = buildAiFixture();
    signIn('alex');
    const s = await turnOn();
    expect(await askInWordsAction({}, form(QUESTION))).toEqual({
      href: `/transactions?range=custom&from=2026-03-01&to=2026-03-31&category=${fx.groceries}&spending=1`,
      reading: 'Food › Groceries, spending only, Mar 1 to Mar 31',
    });
    expect(s.requests).toHaveLength(1);
    // The household's today, in its own zone (TZ is America/Toronto in the test config).
    expect(chatBody(s.requests[0]).messages[1].content).toContain('Today is 2026-03-10.');
  });

  it('refuses a cross-origin post before anything else, and sends nothing', async () => {
    fx = buildAiFixture();
    signIn('alex');
    const s = await turnOn();
    sameOrigin.value = false;
    expect(await askInWordsAction({}, form(QUESTION))).toEqual({ error: CROSS_ORIGIN_ERROR });
    expect(s.requests).toHaveLength(0);
  });

  it('off is refused plainly, set up or not', async () => {
    fx = buildAiFixture();
    signIn('alex');
    expect(await askInWordsAction({}, form(QUESTION))).toEqual({ error: ASK_OFF_ERROR });
    const s = await turnOn();
    turnOffLocalAi({ userId: fx.alex, at: AT });
    expect(await askInWordsAction({}, form(QUESTION))).toEqual({ error: ASK_OFF_ERROR });
    expect(s.requests).toHaveLength(0);
  });

  it("a self viewer's captured prompt lists only their own accounts and no person", async () => {
    fx = buildAiFixture();
    const s = await turnOn();
    signIn('sam-self');
    expect(await askInWordsAction({}, form(QUESTION))).toMatchObject({ href: expect.stringContaining('/transactions?') });
    const text = chatBody(s.requests[0]).messages[1].content;
    expect(text).toContain('- Sam Rewards Visa');
    expect(text).not.toContain('Maple Joint Chequing');
    expect(text).not.toContain('People:');
    expect(text).not.toContain('Alex');
  });

  it('refuses a question out of length without asking', async () => {
    fx = buildAiFixture();
    signIn('alex');
    const s = await turnOn();
    expect(await askInWordsAction({}, form('ok'))).toEqual({ error: ASK_QUESTION_LENGTH_ERROR });
    expect(s.requests).toHaveLength(0);
  });

  it('waits a few seconds between one person’s questions', async () => {
    fx = buildAiFixture();
    signIn('alex');
    const s = await turnOn();
    expect(await askInWordsAction({}, form(QUESTION))).toHaveProperty('href');
    expect(await askInWordsAction({}, form(QUESTION))).toEqual({ error: ASK_COOLDOWN_ERROR });
    expect(s.requests).toHaveLength(1);
    vi.setSystemTime(new Date(AT.getTime() + ASK_COOLDOWN_MS));
    expect(await askInWordsAction({}, form(QUESTION))).toHaveProperty('href');
    expect(s.requests).toHaveLength(2);
  });

  it('never logs or stores the question, and writes nothing', async () => {
    fx = buildAiFixture();
    signIn('alex');
    await turnOn();
    const snapshot = () =>
      JSON.stringify([
        fx!.t.sqlite.prepare('select * from settings order by key').all(),
        fx!.t.sqlite.prepare('select * from audit_log order by id').all(),
        fx!.t.sqlite.prepare('select * from transactions order by id').all(),
        fx!.t.sqlite.prepare('select * from merchant_rules order by id').all(),
        fx!.t.sqlite.prepare('select * from ai_suggestions order by id').all(),
      ]);
    const before = snapshot();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    expect(await askInWordsAction({}, form('what did we spend on the secret birthday gift'))).toHaveProperty('href');
    const printed = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
    expect(printed).not.toContain('birthday');
    expect(snapshot()).toBe(before);
  });
});
