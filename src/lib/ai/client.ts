import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  LOCAL_AI_ANSWER_TIMEOUT_MS,
  LOCAL_AI_CONNECT_TIMEOUT_MS,
  LOCAL_AI_LAN_ONLY_ERROR,
  LOCAL_AI_MAX_REQUEST_BYTES,
  LOCAL_AI_MAX_RESPONSE_BYTES,
  addressLabel,
  assertLocalAiUrl,
  isPrivateAddress,
  normalizeLocalAiBaseUrl,
  type LocalAiPath,
} from '@/lib/ai/lan';
import type { PromptPair } from '@/lib/ai/prompts';
import { chatEnvelopeSchema, isModelName, modelsEnvelopeSchema, parseModelJson, type JsonSchema } from '@/lib/ai/schemas';
import type { LocalAiConfig } from '@/lib/ai/types';

/**
 * v1.64.0 (plan 2026-11-12, L1-L3). THE ONE FILE UNDER src/ THAT MAKES A REQUEST TO THE MODEL SERVER,
 * and the only file under src/ that imports node:http, node:https or node:dns (tests/ops/notify-egress).
 *
 * - One protocol: POST /v1/chat/completions and GET /v1/models, nothing else (assertLocalAiUrl pins
 *   the path on the line immediately above the one request call).
 * - LAN only, checked twice per request: the configured address is normalised again here, and every
 *   address a name resolves to is checked in lanOnlyLookup, which hands Node the very addresses it
 *   checked, so nothing can swap the address between the check and the connect. An IP literal never
 *   reaches the lookup (Node skips it for one), which is why the literal check comes first.
 * - A 3xx is an error (http.request never follows one). No credential header of any kind is sent.
 * - 5 s to connect, 90 s for the whole answer, 1 MB back (a declared length over it is refused before
 *   reading; a counting read destroys the socket past it), 64 KB out, checked before sending.
 * - Every error is the app's own sentence. A reply body is never echoed, logged or stored.
 */

/** The server cannot be used right now: the queue records a failure and waits (L5). */
export class LocalAiServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAiServerError';
  }
}

/** This one answer cannot be used: that merchant or receipt is marked failed and the queue goes on (L5). */
export class LocalAiAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAiAnswerError';
  }
}

export const LOCAL_AI_TIMEOUT_ERROR = `The model server did not answer within ${LOCAL_AI_ANSWER_TIMEOUT_MS / 1000} seconds.`;
export const LOCAL_AI_REDIRECT_ERROR = 'The model server tried to redirect the request, which is not allowed.';
export const LOCAL_AI_KEY_ERROR = 'The model server asked for a key. This app does not send one.';
export const LOCAL_AI_HTTP_400_ERROR =
  "The model server refused the request (HTTP 400). It may not support structured answers; Ollama 0.5 or later and llama.cpp's server do.";
export const LOCAL_AI_TOO_LARGE_ERROR = "The model server's answer was larger than 1 MB.";
export const LOCAL_AI_NOT_LAN_NOW_ERROR = 'That name now points outside your network, so nothing was sent.';
export const LOCAL_AI_NOT_OPENAI_ERROR =
  "The model server's reply was not in the OpenAI-compatible format. Ollama 0.5 or later and llama.cpp's server answer in it.";
export const LOCAL_AI_NO_MODELS_ENDPOINT_ERROR =
  "The model server does not offer the OpenAI-compatible endpoints. Ollama 0.5 or later and llama.cpp's server do.";
export const LOCAL_AI_UNREADABLE_ERROR = "The model's answer was not readable JSON.";
export const LOCAL_AI_QUESTION_TOO_LARGE_ERROR = 'The question for the model was too large to send.';
export const LOCAL_AI_MODEL_NAME_ERROR = 'Enter the model name exactly as the server lists it, like llama3.2:3b.';

export function unreachableError(host: string): string {
  return `Could not reach the model server at ${host}.`;
}

export function nameNotFoundError(hostname: string): string {
  return `Could not find ${hostname} on the network. Inside Docker a .local name often does not resolve; use the server's IP address.`;
}

export function missingModelError(model: string): string {
  return `The model server does not have the model ${model}.`;
}

export interface LocalAiTimeouts {
  connectMs: number;
  answerMs: number;
}

const DEFAULT_TIMEOUTS: LocalAiTimeouts = { connectMs: LOCAL_AI_CONNECT_TIMEOUT_MS, answerMs: LOCAL_AI_ANSWER_TIMEOUT_MS };

// ---------------------------------------------------------------------------------- the lookup

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LocalAiResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const systemResolver: LocalAiResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });
let resolver: LocalAiResolver = systemResolver;

/** Tests answer a name with chosen addresses; null puts the system resolver back. */
export function setResolverForTests(next: LocalAiResolver | null): void {
  resolver = next ?? systemResolver;
}

const NOT_LAN_CODE = 'ELOCALAI_NOT_LAN';
const CONNECT_TIMEOUT_CODE = 'ELOCALAI_CONNECT_TIMEOUT';

function codedError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function familyOf(option: unknown): 0 | 4 | 6 {
  if (option === 4 || option === 'IPv4') return 4;
  if (option === 6 || option === 'IPv6') return 6;
  return 0;
}

/**
 * The http.request `lookup` hook. Resolves every address for the name and refuses unless EVERY one
 * of them is private (L2), then hands back exactly the addresses it checked, as one or as all,
 * whichever Node asked for. A name with any public address is refused outright rather than
 * filtered: a name that points both ways is not a name on your own network.
 */
export const lanOnlyLookup: LookupFunction = (hostname, options, callback) => {
  resolver(hostname).then(
    (found) => {
      if (found.length === 0) {
        callback(codedError('ENOTFOUND', 'no address'), '');
        return;
      }
      if (!found.every((entry) => isPrivateAddress(entry.address))) {
        callback(codedError(NOT_LAN_CODE, 'a resolved address is outside the local network'), '');
        return;
      }
      const family = familyOf(options?.family);
      const usable = found.filter((entry) => family === 0 || entry.family === family);
      if (usable.length === 0) {
        callback(codedError('ENOTFOUND', 'no address of the requested family'), '');
        return;
      }
      if (options?.all) callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
      else callback(null, usable[0].address, usable[0].family);
    },
    (error: unknown) => {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'ENOTFOUND';
      callback(codedError(code, 'lookup failed'), '');
    },
  );
};

// ---------------------------------------------------------------------------------- the request

interface SendInit {
  method: 'GET' | 'POST';
  body?: string;
  timeouts: LocalAiTimeouts;
}

interface SendResult {
  status: number;
  body: string;
}

function toServerError(error: unknown, url: URL, signal: AbortSignal): LocalAiServerError {
  if (error instanceof LocalAiServerError) return error;
  if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
    return new LocalAiServerError(LOCAL_AI_TIMEOUT_ERROR);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === NOT_LAN_CODE) return new LocalAiServerError(LOCAL_AI_NOT_LAN_NOW_ERROR);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_NODATA' || code === 'EAI_FAIL') {
    return new LocalAiServerError(nameNotFoundError(url.hostname));
  }
  return new LocalAiServerError(unreachableError(addressLabel(url.origin)));
}

/**
 * The one request. `agent: false` (no pooled socket), the LAN-only lookup, a connect timer, and an
 * abort signal over the whole exchange. The body is read with a running count and the socket is
 * destroyed the moment it passes the cap.
 */
function send(url: URL, init: SendInit): Promise<SendResult> {
  return new Promise<SendResult>((resolve, reject) => {
    const signal = AbortSignal.timeout(init.timeouts.answerMs);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (error: LocalAiServerError | null, result?: SendResult) => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (error !== null) reject(error);
      else resolve(result as SendResult);
    };
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(init.body));
    }
    const transport = url.protocol === 'https:' ? https : http;
    let req: http.ClientRequest;
    try {
      assertLocalAiUrl(url.href);
      req = transport.request(url, { method: init.method, headers, agent: false, lookup: lanOnlyLookup, signal }, (res) => {
        const status = res.statusCode ?? 0;
        const stop = (error: LocalAiServerError) => {
          settle(error);
          res.destroy();
          req.destroy();
        };
        if (status >= 300 && status < 400) {
          stop(new LocalAiServerError(LOCAL_AI_REDIRECT_ERROR));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > LOCAL_AI_MAX_RESPONSE_BYTES) {
          stop(new LocalAiServerError(LOCAL_AI_TOO_LARGE_ERROR));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > LOCAL_AI_MAX_RESPONSE_BYTES) {
            stop(new LocalAiServerError(LOCAL_AI_TOO_LARGE_ERROR));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => settle(null, { status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (error) => settle(toServerError(error, url, signal)));
        res.on('close', () => {
          if (!res.complete) settle(toServerError(codedError('ECONNRESET', 'closed early'), url, signal));
        });
      });
    } catch (error) {
      const refused = error instanceof Error && error.message.startsWith('refusing a local AI request');
      settle(refused ? new LocalAiServerError(LOCAL_AI_LAN_ONLY_ERROR) : toServerError(error, url, signal));
      return;
    }
    req.on('error', (error) => settle(toServerError(error, url, signal)));
    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => req.destroy(codedError(CONNECT_TIMEOUT_CODE, 'connect timed out')), init.timeouts.connectMs);
      connectTimer.unref?.();
      socket.once('connect', () => {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
      });
    });
    req.end(init.body);
  });
}

/** The configured server, checked again, and the endpoint on it. */
function endpointUrl(config: LocalAiConfig, path: LocalAiPath): URL {
  const normalized = normalizeLocalAiBaseUrl(config.baseUrl);
  if (!normalized.ok) throw new LocalAiServerError(normalized.error);
  if (!isModelName(config.model)) throw new LocalAiServerError(LOCAL_AI_MODEL_NAME_ERROR);
  return new URL(path, normalized.baseUrl);
}

function assertOk(status: number, config: LocalAiConfig, path: LocalAiPath): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new LocalAiServerError(LOCAL_AI_KEY_ERROR);
  if (status === 404) {
    throw new LocalAiServerError(path === '/v1/models' ? LOCAL_AI_NO_MODELS_ENDPOINT_ERROR : missingModelError(config.model));
  }
  if (status === 400) throw new LocalAiServerError(LOCAL_AI_HTTP_400_ERROR);
  throw new LocalAiServerError(`The model server answered with an error (HTTP ${status}).`);
}

function readEnvelope<T>(body: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LocalAiServerError(LOCAL_AI_NOT_OPENAI_ERROR);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new LocalAiServerError(LOCAL_AI_NOT_OPENAI_ERROR);
  return result.data;
}

export interface ChatJsonInput {
  config: LocalAiConfig;
  prompt: PromptPair;
  schemaName: string;
  jsonSchema: JsonSchema;
  timeouts?: Partial<LocalAiTimeouts>;
}

/**
 * One question, one JSON answer. Returns the parsed JSON (each caller checks its own shape with
 * zod) and how long the server took. Throws LocalAiServerError when the server cannot be used and
 * LocalAiAnswerError when this one answer cannot be read.
 */
export async function chatJson(input: ChatJsonInput): Promise<{ content: unknown; ms: number }> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const url = endpointUrl(input.config, '/v1/chat/completions');
  const body = JSON.stringify({
    model: input.config.model,
    messages: [
      { role: 'system', content: input.prompt.system },
      { role: 'user', content: input.prompt.user },
    ],
    temperature: 0,
    max_tokens: 256,
    stream: false,
    response_format: { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema: input.jsonSchema } },
  });
  if (Buffer.byteLength(body) > LOCAL_AI_MAX_REQUEST_BYTES) throw new LocalAiAnswerError(LOCAL_AI_QUESTION_TOO_LARGE_ERROR);
  const started = performance.now();
  const result = await send(url, { method: 'POST', body, timeouts });
  assertOk(result.status, input.config, '/v1/chat/completions');
  const envelope = readEnvelope(result.body, chatEnvelopeSchema);
  const parsed = parseModelJson(envelope.choices[0].message.content);
  if (!parsed.ok) throw new LocalAiAnswerError(LOCAL_AI_UNREADABLE_ERROR);
  return { content: parsed.value, ms: Math.round(performance.now() - started) };
}

/** The model ids the server lists. */
export async function listModels(config: LocalAiConfig, timeouts?: Partial<LocalAiTimeouts>): Promise<string[]> {
  const url = endpointUrl(config, '/v1/models');
  const result = await send(url, { method: 'GET', timeouts: { ...DEFAULT_TIMEOUTS, ...timeouts } });
  assertOk(result.status, config, '/v1/models');
  return readEnvelope(result.body, modelsEnvelopeSchema).data.map((entry) => entry.id);
}
