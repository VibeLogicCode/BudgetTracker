import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SIMPLEFIN_MAX_RESPONSE_BYTES,
  SIMPLEFIN_TIMEOUT_MS,
  SimplefinError,
  claimSetupToken,
  decodeSetupToken,
  fetchAccounts,
  splitAccessUrl,
  type Fetcher,
} from '@/lib/simplefin/client';

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/DEMO';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://abc123:s3cr3t@beta-bridge.simplefin.org/simplefin';

function fetcherReturning(body: string, ok = true, status = 200): Fetcher {
  return vi.fn(async () => ({ ok, status, text: async () => body }));
}

describe('decodeSetupToken', () => {
  it('base64-decodes to the claim URL', () => {
    expect(decodeSetupToken(SETUP_TOKEN)).toBe(CLAIM_URL);
  });

  it('tolerates whitespace and newlines the user pasted in', () => {
    expect(decodeSetupToken(`  ${SETUP_TOKEN.slice(0, 10)}\n${SETUP_TOKEN.slice(10)}  `)).toBe(CLAIM_URL);
  });

  it('rejects anything that does not decode to an https URL', () => {
    expect(() => decodeSetupToken('')).toThrowError(SimplefinError);
    expect(() => decodeSetupToken('not-base64!!!')).toThrowError(/setup token/i);
    expect(() => decodeSetupToken(Buffer.from('hello world').toString('base64'))).toThrowError(/setup token/i);
    expect(() => decodeSetupToken(Buffer.from('http://insecure.example/claim').toString('base64'))).toThrowError(/https/i);
  });
});

describe('splitAccessUrl', () => {
  it('separates the base URL from the basic-auth credentials', () => {
    const { base, authHeader } = splitAccessUrl(ACCESS_URL);
    expect(base).toBe('https://beta-bridge.simplefin.org/simplefin');
    expect(authHeader).toBe(`Basic ${Buffer.from('abc123:s3cr3t').toString('base64')}`);
  });

  it('url-decodes credentials that contain escaped characters', () => {
    const { authHeader } = splitAccessUrl('https://user%40x:p%40ss@host/path');
    expect(authHeader).toBe(`Basic ${Buffer.from('user@x:p@ss').toString('base64')}`);
  });

  it('rejects an access URL with no credentials', () => {
    expect(() => splitAccessUrl('https://beta-bridge.simplefin.org/simplefin')).toThrowError(/credentials/i);
  });
});

describe('claimSetupToken', () => {
  it('POSTs with Content-Length: 0 and returns the access URL', async () => {
    const fetcher = fetcherReturning(ACCESS_URL);
    const result = await claimSetupToken(SETUP_TOKEN, fetcher);
    expect(result).toBe(ACCESS_URL);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, { method: string; headers: Record<string, string> }][] } }).mock.calls[0];
    expect(url).toBe(CLAIM_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Length']).toBe('0');
  });

  it('reports a spent token as an explainable error, not a crash', async () => {
    const fetcher = fetcherReturning('Forbidden', false, 403);
    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrowError(SimplefinError);
    await expect(claimSetupToken(SETUP_TOKEN, fetcher)).rejects.toThrowError(/already been claimed|only be claimed once/i);
  });

  it('rejects a claim response that is not an access URL', async () => {
    await expect(claimSetupToken(SETUP_TOKEN, fetcherReturning('<html>oops</html>'))).rejects.toThrowError(/did not return an access URL/i);
  });

  it('surfaces other HTTP failures with the status', async () => {
    await expect(claimSetupToken(SETUP_TOKEN, fetcherReturning('boom', false, 500))).rejects.toThrowError(/500/);
  });
});

describe('fetchAccounts', () => {
  const payload = JSON.stringify({
    accounts: [
      {
        id: 'acct-1',
        name: 'Chequing',
        currency: 'CAD',
        balance: '1234.56',
        'balance-date': 1755216000,
        transactions: [{ id: 'txn-1', posted: 1755216000, amount: '-12.34', description: 'TIM HORTONS', pending: false }],
      },
    ],
    errlist: [],
  });

  it('sends version=2, the window, and the Authorization header — never credentials in the URL', async () => {
    const fetcher = fetcherReturning(payload);
    const result = await fetchAccounts({ accessUrl: ACCESS_URL, startDate: 1752537600, endDate: 1755216000, fetcher });

    expect(result.accounts).toHaveLength(1);
    expect(result.errlist).toEqual([]);
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, { method: string; headers: Record<string, string> }][] } }).mock.calls[0];
    expect(url).toContain('/accounts?');
    expect(url).toContain('version=2');
    expect(url).toContain('start-date=1752537600');
    expect(url).toContain('end-date=1755216000');
    expect(url).not.toContain('s3cr3t');
    expect(url).not.toContain('abc123');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.method).toBe('GET');
  });

  it('defaults a missing errlist to an empty array', async () => {
    const result = await fetchAccounts({
      accessUrl: ACCESS_URL,
      startDate: 1,
      endDate: 2,
      fetcher: fetcherReturning(JSON.stringify({ accounts: [] })),
    });
    expect(result.errlist).toEqual([]);
  });

  it('surfaces errlist entries verbatim', async () => {
    const result = await fetchAccounts({
      accessUrl: ACCESS_URL,
      startDate: 1,
      endDate: 2,
      fetcher: fetcherReturning(JSON.stringify({ accounts: [], errlist: ['Connection to Bank X needs attention'] })),
    });
    expect(result.errlist).toEqual(['Connection to Bank X needs attention']);
  });

  it('throws on a non-OK response and on unparseable JSON', async () => {
    await expect(
      fetchAccounts({ accessUrl: ACCESS_URL, startDate: 1, endDate: 2, fetcher: fetcherReturning('nope', false, 503) }),
    ).rejects.toThrowError(/503/);
    await expect(
      fetchAccounts({ accessUrl: ACCESS_URL, startDate: 1, endDate: 2, fetcher: fetcherReturning('not json') }),
    ).rejects.toThrowError(/could not be read/i);
  });

  it('rejects a window longer than 90 days before making the request', async () => {
    const fetcher = fetcherReturning(payload);
    const end = 1755216000;
    const start = end - 91 * 86400;
    await expect(fetchAccounts({ accessUrl: ACCESS_URL, startDate: start, endDate: end, fetcher })).rejects.toThrowError(/90 days/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('v1.58.1: the real fetch path is bounded', () => {
  const encoder = new TextEncoder();

  function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
      cancel() {
        onCancel?.();
      },
    });
  }

  function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const window = { accessUrl: ACCESS_URL, startDate: 1, endDate: 2 };

  it('passes redirect: error and a 60 second abort signal on every request', async () => {
    const spy = stubFetch(async () => new Response(JSON.stringify({ accounts: [], errlist: [] })));
    await fetchAccounts(window);
    const init = spy.mock.calls[0][1];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SIMPLEFIN_TIMEOUT_MS).toBe(60_000);
    spy.mockClear();
    stubFetch(async () => new Response('https://u:p@bridge.example/simplefin'));
    await claimSetupToken(SETUP_TOKEN);
  });

  it('a normal body still parses', async () => {
    stubFetch(async () => new Response(JSON.stringify({ accounts: [{ id: 'a', name: 'Chequing', currency: 'USD', balance: '1.00' }], errlist: [] })));
    const result = await fetchAccounts(window);
    expect(result.accounts).toHaveLength(1);
  });

  it('maps a timeout to a plain message', async () => {
    stubFetch(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    await expect(fetchAccounts(window)).rejects.toThrowError('SimpleFIN did not answer within 60 seconds.');
    await expect(claimSetupToken(SETUP_TOKEN)).rejects.toThrowError('SimpleFIN did not answer within 60 seconds.');
  });

  it('maps a refused redirect to a plain message', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    await expect(fetchAccounts(window)).rejects.toThrowError('SimpleFIN tried to redirect the request, which is not allowed.');
  });

  it('cancels the reader and refuses a streamed body over the cap', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 12 }, () => chunk);
    stubFetch(async () => new Response(streamOf(chunks, () => { cancelled = true; })));
    await expect(fetchAccounts(window)).rejects.toThrowError("SimpleFIN's answer was larger than 10 MB.");
    expect(cancelled).toBe(true);
  });

  it('refuses early when Content-Length is over the cap', async () => {
    let cancelled = false;
    stubFetch(async () =>
      new Response(streamOf([encoder.encode('{}')], () => { cancelled = true; }), {
        headers: { 'Content-Length': String(SIMPLEFIN_MAX_RESPONSE_BYTES + 1) },
      }),
    );
    await expect(fetchAccounts(window)).rejects.toThrowError("SimpleFIN's answer was larger than 10 MB.");
    expect(cancelled).toBe(true);
  });
});
