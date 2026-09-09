// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESTART_NOTICE_KEY,
  RESTART_NOTICE_MAX_AGE_MS,
  clearRestartExpected,
  markRestartExpected,
  readRestartExpected,
} from '@/lib/update/restart-notice';

/**
 * v1.32.0 (UP-2). The rules that decide whether src/app/(app)/error.tsx is allowed to say "the
 * app is restarting" instead of "something went wrong", tested here rather than through the
 * component so each one can be broken on its own.
 *
 * The clock is a parameter throughout (the module reads none), so nothing in this file touches
 * fake timers.
 */
const NOW = 1_800_000_000_000;

/** Writes an entry directly, bypassing markRestartExpected -- localStorage is a place a person
 *  can write anything, and several of the cases below are shapes it would never write. */
function armRaw(value: string): void {
  window.localStorage.setItem(RESTART_NOTICE_KEY, value);
}

function read(over: { nowMs?: number; runningVersion?: string } = {}): string | null {
  return readRestartExpected({ nowMs: over.nowMs ?? NOW, runningVersion: over.runningVersion ?? '1.31.0' });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('the round trip', () => {
  it('a version written a moment ago is the version the error page names', () => {
    markRestartExpected('1.32.0', NOW - 30_000);
    expect(read()).toBe('1.32.0');
  });

  it('re-serialises the version from parsed integers rather than passing the stored string through', () => {
    // A leading "v" survives parseSemver and must not survive into "Installing v..." as "vv1.32.0".
    armRaw(JSON.stringify({ version: 'v1.32.0', at: NOW - 1_000 }));
    expect(read()).toBe('1.32.0');
  });

  it('nothing stored means the ordinary crash copy', () => {
    expect(read()).toBeNull();
  });

  it('clearRestartExpected removes the entry', () => {
    markRestartExpected('1.32.0', NOW);
    clearRestartExpected();
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });
});

describe('the entry expires, and a spent entry is cleared', () => {
  it('is still good at one second under the window', () => {
    markRestartExpected('1.32.0', NOW - (RESTART_NOTICE_MAX_AGE_MS - 1_000));
    expect(read()).toBe('1.32.0');
  });

  it('is refused at the window, and the key is removed so it cannot be reconsidered', () => {
    markRestartExpected('1.32.0', NOW - RESTART_NOTICE_MAX_AGE_MS);
    expect(read()).toBeNull();
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });

  it('a household that updated YESTERDAY sees today’s real error', () => {
    markRestartExpected('1.32.0', NOW - 24 * 60 * 60 * 1000);
    expect(read()).toBeNull();
  });

  it('a stamp from the FUTURE is refused too -- a clock jump is not a restart in progress', () => {
    // The bound is symmetric on purpose: a one-sided `now - at < MAX` test would treat an entry
    // dated next week as permanently fresh, which is exactly the "stale entry suppresses a real
    // crash message" failure, arrived at from the other direction.
    armRaw(JSON.stringify({ version: '1.32.0', at: NOW + RESTART_NOTICE_MAX_AGE_MS }));
    expect(read()).toBeNull();
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });
});

describe('a restart that has already landed stops speaking for itself', () => {
  it('an entry naming the version this bundle IS means the update finished', () => {
    markRestartExpected('1.32.0', NOW - 30_000);
    expect(read({ runningVersion: '1.32.0' })).toBeNull();
  });

  it('and the entry is cleared, so a later error in the same five minutes is reported honestly', () => {
    markRestartExpected('1.32.0', NOW - 30_000);
    read({ runningVersion: '1.32.0' });
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
    expect(read()).toBeNull();
  });

  it('a runningVersion this app cannot parse is ignored rather than treated as a match', () => {
    markRestartExpected('1.32.0', NOW - 30_000);
    expect(read({ runningVersion: 'unknown' })).toBe('1.32.0');
  });
});

describe('localStorage is a place a person can write anything', () => {
  it.each([
    ['not json at all', 'not json'],
    ['a bare string', JSON.stringify('1.32.0')],
    ['null', JSON.stringify(null)],
    ['no version', JSON.stringify({ at: NOW })],
    ['no stamp', JSON.stringify({ version: '1.32.0' })],
    ['a non-numeric stamp', JSON.stringify({ version: '1.32.0', at: '2026-09-05' })],
    ['a NaN stamp', '{"version":"1.32.0","at":null}'],
    ['a version this app cannot compare', JSON.stringify({ version: 'nightly', at: NOW })],
    ['a pre-release tag', JSON.stringify({ version: '2.0.0-rc.1', at: NOW })],
    ['a novel-length version', JSON.stringify({ version: 'x'.repeat(10_000), at: NOW })],
  ])('%s is refused', (_name, raw) => {
    armRaw(raw);
    expect(read()).toBeNull();
  });

  it('markRestartExpected refuses to write a version this app cannot compare', () => {
    markRestartExpected('main', NOW);
    expect(window.localStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });
});

describe('storage that throws (a private window, cleared site data, a browser blocking storage)', () => {
  it('reading returns null instead of replacing one broken screen with another', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    expect(() => read()).not.toThrow();
    expect(read()).toBeNull();
  });

  it('writing swallows the failure -- the page a household is looking at must not break over it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => markRestartExpected('1.32.0', NOW)).not.toThrow();
  });

  it('clearing swallows the failure too', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    expect(() => clearRestartExpected()).not.toThrow();
  });
});
