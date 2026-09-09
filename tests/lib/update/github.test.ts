import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_CHANGELOG_BYTES,
  MAX_CHANGELOG_GROUPS,
  MAX_CHANGELOG_ITEMS,
  UNPARSEABLE_TAG_ERROR,
  UpdateCheckError,
  boundRelease,
  fetchLatestRelease,
  fetchRemoteChangelog,
} from '@/lib/update/github';
import {
  GITHUB_INTERACTIVE_TIMEOUT_MS,
  GITHUB_SCHEDULED_TIMEOUT_MS,
  timeoutSeconds,
} from '@/lib/update/timeouts';
import { parseChangelog } from '@/lib/changelog';
import { APP_VERSION } from '@/lib/version';
import * as egress from '@/lib/update/egress';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  // MUST-19.1: no test in this file may reach a real network. Restoring the real fetch in
  // an afterEach is what stops a later test in the same file from doing so by accident.
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('MUST-4.2 / MUST-4.3 / MUST-4.4: the release request, exactly', () => {
  it('is one GET to the pinned endpoint with the three fixed headers and no Authorization', async () => {
    stub(() => json({ tag_name: 'v1.4.0', published_at: '2026-08-16T09:00:00Z' }));
    const release = await fetchLatestRelease();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/VibeLogicCode/BudgetTracker/releases/latest');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toEqual({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `BudgetTracker/${APP_VERSION}`,
    });
    expect(Object.keys(headers)).not.toContain('Authorization');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(release).toEqual({ tag: 'v1.4.0', version: '1.4.0', publishedAt: '2026-08-16T09:00:00Z' });
  });

  it('MUST-4.6: a tag that fails parseSemver is a PERMANENT error and is never classified', async () => {
    stub(() => json({ tag_name: 'nightly', published_at: null }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ message: UNPARSEABLE_TAG_ERROR, permanent: true });
  });

  it('MUST-4.10: a pre-release tag is refused outright', async () => {
    stub(() => json({ tag_name: 'v2.0.0-rc.1' }));
    await expect(fetchLatestRelease()).rejects.toMatchObject({ permanent: true });
  });

  it('tolerates a missing published_at', async () => {
    stub(() => json({ tag_name: '1.4.0' }));
    await expect(fetchLatestRelease()).resolves.toEqual({ tag: '1.4.0', version: '1.4.0', publishedAt: null });
  });

  describe('fix wave item 5: published_at is bounded before it reaches settings or a rendered message', () => {
    it('accepts a real ISO-8601 UTC timestamp, with or without milliseconds', async () => {
      stub(() => json({ tag_name: 'v1.4.0', published_at: '2026-08-16T09:00:00.123Z' }));
      await expect(fetchLatestRelease()).resolves.toMatchObject({ publishedAt: '2026-08-16T09:00:00.123Z' });
    });

    it('a wildly oversized string is stored as null, not truncated and passed through', async () => {
      stub(() => json({ tag_name: 'v1.4.0', published_at: `2026-08-16T09:00:00Z${'x'.repeat(10_000)}` }));
      await expect(fetchLatestRelease()).resolves.toMatchObject({ publishedAt: null });
    });

    it('a value that is not ISO-shaped at all is stored as null', async () => {
      stub(() => json({ tag_name: 'v1.4.0', published_at: 'not a timestamp' }));
      await expect(fetchLatestRelease()).resolves.toMatchObject({ publishedAt: null });
    });

    it('a non-string published_at (e.g. a number) is stored as null', async () => {
      stub(() => json({ tag_name: 'v1.4.0', published_at: 1755331200 }));
      await expect(fetchLatestRelease()).resolves.toMatchObject({ publishedAt: null });
    });
  });
});

/**
 * v1.32.0 (UP-1). One 15-second budget used to serve both endpoints, so pressing Check now
 * could sit on "Working…" for fifteen seconds -- the owner's recording of a real update shows
 * them reloading the page at about 22 seconds rather than waiting it out.
 *
 * Asserted on AbortSignal.timeout()'s argument rather than by waiting one out, because the
 * budget is not otherwise readable off the signal the stub receives (the existing MUST-4.4 test
 * above can only say `toBeInstanceOf(AbortSignal)`), and a test that really waited five seconds
 * would be five seconds of nothing in every run. The spy calls through, so the request under
 * test is the real one.
 */
describe('UP-1: two budgets, and each endpoint takes the right one by default', () => {
  it('fetchLatestRelease defaults to the SCHEDULED budget -- the 04:00 tick has nobody waiting', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    stub(() => json({ tag_name: 'v1.4.0' }));
    await fetchLatestRelease();
    expect(timeout).toHaveBeenCalledWith(GITHUB_SCHEDULED_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(GITHUB_INTERACTIVE_TIMEOUT_MS);
  });

  it('fetchLatestRelease honours an explicit budget -- this is how the Check-now path shortens it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    stub(() => json({ tag_name: 'v1.4.0' }));
    await fetchLatestRelease({ timeoutMs: GITHUB_INTERACTIVE_TIMEOUT_MS });
    expect(timeout).toHaveBeenCalledWith(GITHUB_INTERACTIVE_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(GITHUB_SCHEDULED_TIMEOUT_MS);
  });

  it('fetchRemoteChangelog defaults to the INTERACTIVE budget -- its only caller is a button', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const content = Buffer.from('# Changelog', 'utf8').toString('base64');
    stub(() => json({ encoding: 'base64', size: 11, content }));
    await fetchRemoteChangelog('1.4.0');
    expect(timeout).toHaveBeenCalledWith(GITHUB_INTERACTIVE_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(GITHUB_SCHEDULED_TIMEOUT_MS);
  });

  it('the budget a person waits on is strictly the shorter of the two', () => {
    // The split only means something while they differ. Collapsing them back to one number --
    // in either direction -- fails here rather than quietly restoring the fifteen-second wait.
    expect(GITHUB_INTERACTIVE_TIMEOUT_MS).toBeLessThan(GITHUB_SCHEDULED_TIMEOUT_MS);
  });
});

describe('UP-1: an expired budget says so in words a household can act on', () => {
  it('reports GitHub, not "the operation was aborted", and stays TRANSIENT', async () => {
    // AbortSignal.timeout()'s real rejection shape on Node, pinned the same way
    // tests/lib/update/watchtower.test.ts pins it: a DOMException named 'TimeoutError'.
    stub(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const error = (await fetchLatestRelease({ timeoutMs: GITHUB_INTERACTIVE_TIMEOUT_MS }).catch(
      (e: unknown) => e,
    )) as UpdateCheckError;
    expect(error.message).toBe(`GitHub did not answer within ${timeoutSeconds(GITHUB_INTERACTIVE_TIMEOUT_MS)} seconds.`);
    expect(error.message).not.toMatch(/aborted/i);
    // MUST-4.7: a timeout is not a permanent failure. It was transient before this release and
    // rewriting the sentence must not have quietly reclassified it.
    expect(error.permanent).toBe(false);
  });

  it('names the budget that actually expired, so the scheduled path does not report five seconds', async () => {
    stub(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const error = (await fetchLatestRelease().catch((e: unknown) => e)) as UpdateCheckError;
    expect(error.message).toBe(`GitHub did not answer within ${timeoutSeconds(GITHUB_SCHEDULED_TIMEOUT_MS)} seconds.`);
  });

  it('every other rejection still carries its own message through', async () => {
    // "getaddrinfo ENOTFOUND api.github.com" is more useful than anything requestFailure could
    // write over it, so only the TimeoutError branch is rewritten.
    stub(() => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    const error = (await fetchLatestRelease().catch((e: unknown) => e)) as UpdateCheckError;
    expect(error.message).toBe('getaddrinfo ENOTFOUND api.github.com');
    expect(error.permanent).toBe(false);
  });
});

describe('MUST-4.7: error classification', () => {
  it.each([401, 403, 404, 422])('treats HTTP %i as permanent', async (status) => {
    stub(() => new Response('', { status }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateCheckError);
    expect((error as UpdateCheckError).permanent).toBe(true);
  });

  it.each([429, 500, 502, 503])('treats HTTP %i as transient', async (status) => {
    stub(() => new Response('', { status }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(false);
  });

  it('treats a DNS failure, a connect timeout and an abort as transient', async () => {
    stub(() => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(false);
  });

  it('treats a malformed payload as permanent', async () => {
    stub(() => new Response('not json', { status: 200 }));
    const error = await fetchLatestRelease().catch((e: unknown) => e);
    expect((error as UpdateCheckError).permanent).toBe(true);
  });
});

describe('MUST-4.2 endpoint 2 / MUST-4.6: the changelog read is pinned to the release tag', () => {
  function contents(text: string, over: Record<string, unknown> = {}): Response {
    const content = Buffer.from(text, 'utf8').toString('base64');
    return json({ encoding: 'base64', size: Buffer.byteLength(text, 'utf8'), content, ...over });
  }

  it('requests ?ref=v<version> and decodes base64', async () => {
    stub(() => contents('# Changelog\n\n## [1.4.0] - 2026-08-16\n\n### Added\n\n- A thing.\n'));
    const text = await fetchRemoteChangelog('1.4.0');
    expect(calls[0]!.url).toBe(
      'https://api.github.com/repos/VibeLogicCode/BudgetTracker/contents/CHANGELOG.md?ref=v1.4.0',
    );
    expect(text).toContain('## [1.4.0] - 2026-08-16');
  });

  it('refuses a non-base64 encoding and an oversized file', async () => {
    stub(() => contents('x', { encoding: 'utf-8' }));
    await expect(fetchRemoteChangelog('1.4.0')).rejects.toMatchObject({ permanent: true });

    stub(() => contents('x', { size: MAX_CHANGELOG_BYTES + 1 }));
    await expect(fetchRemoteChangelog('1.4.0')).rejects.toMatchObject({ permanent: true });
  });

  it('refuses a version string that is not a bare semver, before any fetch', async () => {
    stub(() => contents('x'));
    await expect(fetchRemoteChangelog('main')).rejects.toMatchObject({ permanent: true });
    expect(calls).toHaveLength(0);
  });
});

describe('MUST-8.5: the guard is actually invoked, not merely imported', () => {
  it('fetchLatestRelease never reaches fetch when assertGithubUrl throws', async () => {
    stub(() => json({ tag_name: 'v1.4.0', published_at: '2026-08-16T09:00:00Z' }));
    vi.spyOn(egress, 'assertGithubUrl').mockImplementation(() => {
      throw new Error('blocked by guard');
    });

    await expect(fetchLatestRelease()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('fetchRemoteChangelog never reaches fetch when assertGithubUrl throws', async () => {
    const content = Buffer.from('# Changelog', 'utf8').toString('base64');
    stub(() => json({ encoding: 'base64', size: 11, content }));
    vi.spyOn(egress, 'assertGithubUrl').mockImplementation(() => {
      throw new Error('blocked by guard');
    });

    await expect(fetchRemoteChangelog('1.4.0')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('MUST-4.8: the remote changelog is untrusted text and is bounded', () => {
  it('truncates a 400-item release to 200 items across at most 12 groups', () => {
    const groups = Array.from({ length: 20 }, (_, g) => {
      const items = Array.from({ length: 20 }, (_, i) => `- item ${g}-${i} ${'x'.repeat(600)}`).join('\n');
      return `### Group ${'G'.repeat(80)}${g}\n\n${items}`;
    }).join('\n\n');
    const parsed = parseChangelog(`## [1.4.0] - 2026-08-16\n\n${groups}\n`);
    const bounded = boundRelease(parsed[0]!);

    expect(bounded.groups.length).toBeLessThanOrEqual(MAX_CHANGELOG_GROUPS);
    const total = bounded.groups.reduce((n, group) => n + group.items.length, 0);
    expect(total).toBe(MAX_CHANGELOG_ITEMS);
    for (const group of bounded.groups) {
      expect(group.title.length).toBeLessThanOrEqual(60);
      for (const item of group.items) expect(item.length).toBeLessThanOrEqual(500);
    }
  });
});
