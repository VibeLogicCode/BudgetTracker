/**
 * Plain-language reasons for a request to GitHub that never got an answer. No imports on
 * purpose: updates-client.tsx reads COULD_NOT_REACH_GITHUB, and a client file may not pull in
 * the server-only update modules.
 *
 * Node's fetch rejects with `TypeError('fetch failed')`; the real reason is on
 * `error.cause.code`, sometimes inside an AggregateError's `errors`. Only the code is read.
 * `cause.message` is never used, because it can carry an IP address.
 */
export const COULD_NOT_REACH_GITHUB = "Couldn't reach GitHub";

const REASONS: Record<string, string> = {
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed',
  ETIMEDOUT: 'connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  UND_ERR_HEADERS_TIMEOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection was dropped',
  UND_ERR_SOCKET: 'connection was dropped',
  ENETUNREACH: 'no route to the internet',
  EHOSTUNREACH: 'no route to the internet',
  CERT_HAS_EXPIRED: 'its certificate was not trusted',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate was not trusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate was not trusted',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate was not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate was not trusted',
};

const MAX_DEPTH = 3;

function codeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { code?: unknown; name?: unknown };
  if (typeof record.code === 'string' && record.code !== '') return record.code;
  if (record.name === 'AbortError') return 'AbortError';
  return null;
}

export function describeNetworkFailure(error: unknown): { reason: string; code: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth += 1) {
    const code = codeOf(current);
    if (code !== null) {
      if (code === 'AbortError') return { reason: 'the request was cancelled', code };
      return { reason: REASONS[code] ?? 'the request failed', code };
    }
    if (typeof current !== 'object') return null;
    const record = current as { cause?: unknown; errors?: unknown };
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const nested = describeNetworkFailure(record.errors[0]);
      if (nested !== null) return nested;
    }
    current = record.cause;
  }
  return null;
}
