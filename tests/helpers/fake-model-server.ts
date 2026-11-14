import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * v1.64.0. A stand-in for a local model server (Ollama or llama.cpp's OpenAI-compatible endpoints)
 * on 127.0.0.1 and a free port. No test talks to a real model. `requests` keeps every request the
 * server saw, so a test can prove what was sent and that nothing was sent at all.
 */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FakeModelHandler = (request: CapturedRequest, res: http.ServerResponse) => void | Promise<void>;

export interface FakeModelServer {
  baseUrl: string;
  port: number;
  requests: CapturedRequest[];
  /** Sockets the server saw close, so a test can prove the client hung up. */
  closedSockets(): number;
  close(): Promise<void>;
}

export async function startFakeModelServer(handler: FakeModelHandler): Promise<FakeModelServer> {
  const requests: CapturedRequest[] = [];
  let closed = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      Promise.resolve(handler(captured, res)).catch(() => res.destroy());
    });
  });
  server.on('connection', (socket) => socket.on('close', () => (closed += 1)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    closedSockets: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** The OpenAI-compatible reply around a model's content. A non-string is sent as its JSON text. */
export function chatEnvelope(content: unknown): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model:1b',
    choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }],
  };
}

export function modelsEnvelope(ids: string[]): unknown {
  return { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'library' })) };
}

/**
 * The usual server: lists `models`, and answers each chat with `answer(request)` (content, or a
 * full status and body when it returns `{ status, body }`).
 */
export function modelServerHandler(options: {
  models?: string[];
  answer: (request: CapturedRequest) => unknown;
}): FakeModelHandler {
  return (request, res) => {
    if (request.method === 'GET' && request.path === '/v1/models') {
      sendJson(res, 200, modelsEnvelope(options.models ?? ['test-model:1b']));
      return;
    }
    if (request.method === 'POST' && request.path === '/v1/chat/completions') {
      const reply = options.answer(request);
      if (reply !== null && typeof reply === 'object' && 'status' in reply && 'body' in reply) {
        const { status, body } = reply as { status: number; body: unknown };
        sendJson(res, status, body);
        return;
      }
      sendJson(res, 200, chatEnvelope(reply));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}

/** The parsed chat body a request carried. */
export function chatBody(request: CapturedRequest): {
  model: string;
  messages: { role: string; content: string }[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format: { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
} {
  return JSON.parse(request.body);
}
