import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  LOCAL_AI_HTTP_400_ERROR,
  LOCAL_AI_KEY_ERROR,
  LOCAL_AI_NOT_LAN_NOW_ERROR,
  LOCAL_AI_NOT_OPENAI_ERROR,
  LOCAL_AI_QUESTION_TOO_LARGE_ERROR,
  LOCAL_AI_REDIRECT_ERROR,
  LOCAL_AI_TIMEOUT_ERROR,
  LOCAL_AI_TOO_LARGE_ERROR,
  LOCAL_AI_UNREADABLE_ERROR,
  LocalAiAnswerError,
  LocalAiServerError,
  chatJson,
  listModels,
  missingModelError,
  nameNotFoundError,
  setResolverForTests,
  unreachableError,
} from '@/lib/ai/client';
import { LOCAL_AI_LAN_ONLY_ERROR } from '@/lib/ai/lan';
import { TEST_LABELS, TEST_PROMPT } from '@/lib/ai/prompts';
import { merchantAnswer } from '@/lib/ai/schemas';
import {
  chatBody,
  modelServerHandler,
  sendJson,
  startFakeModelServer,
  type FakeModelHandler,
  type FakeModelServer,
} from '../../helpers/fake-model-server';

/** v1.64.0 (plan 2026-11-12, A5, L1-L3). Every case against the fake server; no real model. */
const MODEL = 'test-model:1b';
const ANSWER = merchantAnswer(TEST_LABELS);

let server: FakeModelServer | null = null;
afterEach(async () => {
  setResolverForTests(null);
  await server?.close();
  server = null;
});

async function serve(handler: FakeModelHandler): Promise<FakeModelServer> {
  server = await startFakeModelServer(handler);
  return server;
}

function ask(baseUrl: string, timeouts?: { connectMs?: number; answerMs?: number }) {
  return chatJson({ config: { baseUrl, model: MODEL }, prompt: TEST_PROMPT, schemaName: 'merchant_suggestion', jsonSchema: ANSWER.jsonSchema, timeouts });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('chatJson: one round trip', () => {
  it('posts the L1 body with the schema, sends no credential header, and returns the parsed answer', async () => {
    const s = await serve(modelServerHandler({ answer: () => ({ category: 'Groceries', merchant: 'Maple Grocer' }) }));
    const result = await ask(s.baseUrl);
    expect(result.content).toEqual({ category: 'Groceries', merchant: 'Maple Grocer' });
    expect(result.ms).toBeGreaterThanOrEqual(0);

    expect(s.requests).toHaveLength(1);
    const [request] = s.requests;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers['content-type']).toBe('application/json');
    const body = chatBody(request);
    expect(body).toEqual({
      model: MODEL,
      messages: [
        { role: 'system', content: TEST_PROMPT.system },
        { role: 'user', content: TEST_PROMPT.user },
      ],
      temperature: 0,
      max_tokens: 256,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'merchant_suggestion', strict: true, schema: ANSWER.jsonSchema } },
    });
  });

  it('reads a fenced answer, and calls an unreadable one an answer error, not a server error', async () => {
    let reply = '```json\n{"category":null,"merchant":"Maple Grocer"}\n```';
    const s = await serve(modelServerHandler({ answer: () => reply }));
    expect((await ask(s.baseUrl)).content).toEqual({ category: null, merchant: 'Maple Grocer' });
    reply = 'I think it is groceries.';
    const error = await rejection(ask(s.baseUrl));
    expect(error).toBeInstanceOf(LocalAiAnswerError);
    expect(error.message).toBe(LOCAL_AI_UNREADABLE_ERROR);
  });

  it('lists the models the server has', async () => {
    const s = await serve(modelServerHandler({ models: ['llama3.2:3b', MODEL], answer: () => null }));
    expect(await listModels({ baseUrl: s.baseUrl, model: MODEL })).toEqual(['llama3.2:3b', MODEL]);
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/models']);
  });
});

describe('chatJson: the server cannot be used', () => {
  it('refuses a redirect after exactly one request', async () => {
    const s = await serve((_request, res) => {
      res.writeHead(302, { location: 'http://8.8.8.8/v1/chat/completions' });
      res.end();
    });
    const error = await rejection(ask(s.baseUrl));
    expect(error).toBeInstanceOf(LocalAiServerError);
    expect(error.message).toBe(LOCAL_AI_REDIRECT_ERROR);
    expect(s.requests).toHaveLength(1);
  });

  it('gives each status its own sentence', async () => {
    let status = 401;
    const s = await serve((_request, res) => sendJson(res, status, { error: 'x' }));
    const cases: [number, string][] = [
      [401, LOCAL_AI_KEY_ERROR],
      [403, LOCAL_AI_KEY_ERROR],
      [404, missingModelError(MODEL)],
      [400, LOCAL_AI_HTTP_400_ERROR],
      [500, 'The model server answered with an error (HTTP 500).'],
    ];
    for (const [code, sentence] of cases) {
      status = code;
      const error = await rejection(ask(s.baseUrl));
      expect(error, String(code)).toBeInstanceOf(LocalAiServerError);
      expect(error.message).toBe(sentence);
    }
    expect(missingModelError(MODEL)).toBe('The model server does not have the model test-model:1b.');
  });

  it('calls a reply that is not the OpenAI shape a server error', async () => {
    const s = await serve((_request, res) => sendJson(res, 200, { message: { content: '{}' } }));
    const error = await rejection(ask(s.baseUrl));
    expect(error).toBeInstanceOf(LocalAiServerError);
    expect(error.message).toBe(LOCAL_AI_NOT_OPENAI_ERROR);
  });

  it('refuses a declared 2 MB reply before reading it, and hangs up', async () => {
    const s = await serve((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) });
      res.write('{"choices":[');
      // Never ended: only the declared length can end this exchange quickly.
    });
    const error = await rejection(ask(s.baseUrl, { answerMs: 10_000 }));
    expect(error.message).toBe(LOCAL_AI_TOO_LARGE_ERROR);
    await vi.waitFor(() => expect(s.closedSockets()).toBeGreaterThan(0));
  });

  it('refuses an undeclared 2 MB reply while it streams, and hangs up', async () => {
    const s = await serve((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 32; i += 1) res.write(chunk);
      // Never ended: only the running count can end this exchange quickly.
    });
    const error = await rejection(ask(s.baseUrl, { answerMs: 10_000 }));
    expect(error.message).toBe(LOCAL_AI_TOO_LARGE_ERROR);
    await vi.waitFor(() => expect(s.closedSockets()).toBeGreaterThan(0));
  });

  it('times out on a server that never answers', async () => {
    const s = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    const error = await rejection(ask(s.baseUrl, { connectMs: 200, answerMs: 200 }));
    expect(error).toBeInstanceOf(LocalAiServerError);
    expect(error.message).toBe(LOCAL_AI_TIMEOUT_ERROR);
    expect(LOCAL_AI_TIMEOUT_ERROR).toBe('The model server did not answer within 90 seconds.');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('says it could not reach a closed port', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const error = await rejection(ask(`http://127.0.0.1:${port}`));
    expect(error).toBeInstanceOf(LocalAiServerError);
    expect(error.message).toBe(unreachableError(`127.0.0.1:${port}`));
    expect(unreachableError('192.168.1.50:11434')).toBe('Could not reach the model server at 192.168.1.50:11434.');
  });

  it('refuses a configured address that is not on the network, with no request', async () => {
    const error = await rejection(ask('http://8.8.8.8:11434'));
    expect(error).toBeInstanceOf(LocalAiServerError);
    expect(error.message).toBe(LOCAL_AI_LAN_ONLY_ERROR);
  });

  it('refuses a question over 64 KB before sending it', async () => {
    const s = await serve(modelServerHandler({ answer: () => ({ category: null, merchant: null }) }));
    const big = { system: 'x', user: 'y'.repeat(65 * 1024) };
    const error = await rejection(
      chatJson({ config: { baseUrl: s.baseUrl, model: MODEL }, prompt: big, schemaName: 'merchant_suggestion', jsonSchema: ANSWER.jsonSchema }),
    );
    expect(error).toBeInstanceOf(LocalAiAnswerError);
    expect(error.message).toBe(LOCAL_AI_QUESTION_TOO_LARGE_ERROR);
    expect(s.requests).toHaveLength(0);
  });
});

describe('lanOnlyLookup: every resolved address, on every request', () => {
  it('connects to gpu-box.local when it resolves to 127.0.0.1', async () => {
    const s = await serve(modelServerHandler({ answer: () => ({ category: 'Groceries', merchant: null }) }));
    const asked: string[] = [];
    setResolverForTests(async (hostname) => {
      asked.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    });
    const result = await ask(`http://gpu-box.local:${s.port}`);
    expect(result.content).toEqual({ category: 'Groceries', merchant: null });
    expect(asked).toEqual(['gpu-box.local']);
    expect(s.requests[0].headers.host).toBe(`gpu-box.local:${s.port}`);
  });

  it('refuses a name with any public address, and the server sees nothing', async () => {
    const s = await serve(modelServerHandler({ answer: () => ({ category: null, merchant: null }) }));
    for (const answer of [
      [
        { address: '192.168.1.5', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ],
      [{ address: '8.8.8.8', family: 4 }],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
    ]) {
      setResolverForTests(async () => answer);
      const error = await rejection(ask(`http://gpu-box.local:${s.port}`));
      expect(error).toBeInstanceOf(LocalAiServerError);
      expect(error.message).toBe(LOCAL_AI_NOT_LAN_NOW_ERROR);
    }
    expect(s.requests).toHaveLength(0);
  });

  it('says a name was not found, with the Docker hint', async () => {
    setResolverForTests(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND gpu-box.local'), { code: 'ENOTFOUND' });
    });
    const error = await rejection(ask('http://gpu-box.local:11434'));
    expect(error.message).toBe(nameNotFoundError('gpu-box.local'));
    expect(error.message).toBe("Could not find gpu-box.local on the network. Inside Docker a .local name often does not resolve; use the server's IP address.");
  });
});
