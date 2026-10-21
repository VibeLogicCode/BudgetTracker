import { describe, it, expect } from 'vitest';
import { COULD_NOT_REACH_GITHUB, describeNetworkFailure } from '@/lib/update/network-error';

function failure(code: string): Error {
  const cause = Object.assign(new Error('low-level'), { code });
  return new TypeError('fetch failed', { cause });
}

describe('describeNetworkFailure', () => {
  it('names the product the check could not reach', () => {
    expect(COULD_NOT_REACH_GITHUB).toBe("Couldn't reach GitHub");
  });

  it.each([
    ['ENOTFOUND', 'DNS lookup failed'],
    ['EAI_AGAIN', 'DNS lookup failed'],
    ['ETIMEDOUT', 'connection timed out'],
    ['UND_ERR_CONNECT_TIMEOUT', 'connection timed out'],
    ['UND_ERR_HEADERS_TIMEOUT', 'connection timed out'],
    ['ECONNREFUSED', 'connection refused'],
    ['ECONNRESET', 'connection was dropped'],
    ['UND_ERR_SOCKET', 'connection was dropped'],
    ['ENETUNREACH', 'no route to the internet'],
    ['EHOSTUNREACH', 'no route to the internet'],
    ['CERT_HAS_EXPIRED', 'its certificate was not trusted'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'its certificate was not trusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'its certificate was not trusted'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'its certificate was not trusted'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'its certificate was not trusted'],
    ['EWHATEVER', 'the request failed'],
  ])('maps %s to "%s"', (code, reason) => {
    expect(describeNetworkFailure(failure(code))).toEqual({ reason, code });
  });

  it('reads the code from an AggregateError inside the cause', () => {
    const inner = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    const error = new TypeError('fetch failed', { cause: new AggregateError([inner], 'many') });
    expect(describeNetworkFailure(error)).toEqual({ reason: 'connection timed out', code: 'ETIMEDOUT' });
  });

  it('reads the code from an AggregateError that carries it itself', () => {
    const error = Object.assign(new AggregateError([], 'many'), { code: 'ETIMEDOUT' });
    expect(describeNetworkFailure(error)).toEqual({ reason: 'connection timed out', code: 'ETIMEDOUT' });
  });

  it('names an AbortError', () => {
    const error = new DOMException('aborted', 'AbortError');
    expect(describeNetworkFailure(error)).toEqual({ reason: 'the request was cancelled', code: 'AbortError' });
  });

  it('returns null for an error with no code', () => {
    expect(describeNetworkFailure(new Error('boom'))).toBeNull();
    expect(describeNetworkFailure('nope')).toBeNull();
  });
});
