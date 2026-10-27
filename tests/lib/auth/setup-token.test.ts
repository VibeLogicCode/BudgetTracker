import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { clearSetupToken, issueSetupTokenOnBoot, verifySetupToken } from '@/lib/auth/setup-token';
import { readEnv } from '@/lib/env';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
  vi.restoreAllMocks();
});

const BASE = { SECRET_KEY: 'k'.repeat(48) };
const envWith = (extra: Record<string, string> = {}) => readEnv({ ...BASE, ...extra });

function captureToken(): { logs: string[]; token: () => string } {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  return {
    logs,
    token: () => {
      const match = logs.join('\n').match(/Budget Tracker setup token: (\S+)/);
      if (!match) throw new Error('no token printed');
      return match[1] as string;
    },
  };
}

describe('issueSetupTokenOnBoot', () => {
  it('prints one token line and stores only its hash', () => {
    current = createTestDb();
    const out = captureToken();
    issueSetupTokenOnBoot(envWith());
    const token = out.token();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(out.logs.join('\n')).toMatch(/\/setup/);
    const rows = current.sqlite.prepare('select key, value from settings').all() as { key: string; value: string }[];
    expect(rows.some((r) => r.key === 'setup.token_hash')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(verifySetupToken(token, envWith())).toBe(true);
  });

  it('replaces the hash on a second call so the old token stops working', () => {
    current = createTestDb();
    const first = captureToken();
    issueSetupTokenOnBoot(envWith());
    const oldToken = first.token();
    vi.restoreAllMocks();
    const second = captureToken();
    issueSetupTokenOnBoot(envWith());
    const newToken = second.token();
    expect(newToken).not.toBe(oldToken);
    expect(verifySetupToken(oldToken, envWith())).toBe(false);
    expect(verifySetupToken(newToken, envWith())).toBe(true);
  });

  it('does nothing and drops a stored hash when a user exists', () => {
    current = createTestDb();
    const out = captureToken();
    issueSetupTokenOnBoot(envWith());
    const token = out.token();
    insertTestUser(current.db, { username: 'alex', role: 'admin' });
    vi.restoreAllMocks();
    const quiet = captureToken();
    issueSetupTokenOnBoot(envWith());
    expect(quiet.logs.join('\n')).not.toMatch(/setup token/);
    const row = current.sqlite.prepare("select value from settings where key = 'setup.token_hash'").get();
    expect(row).toBeUndefined();
    expect(verifySetupToken(token, envWith())).toBe(false);
  });

  it('prints no generated token when SETUP_TOKEN is configured, and that value verifies', () => {
    current = createTestDb();
    const out = captureToken();
    const configured = 'maple-grocer-fuel-stop-12';
    issueSetupTokenOnBoot(envWith({ SETUP_TOKEN: configured }));
    expect(out.logs.join('\n')).not.toMatch(/Budget Tracker setup token:/);
    expect(out.logs.join('\n')).toMatch(/SETUP_TOKEN/);
    expect(verifySetupToken(configured, envWith({ SETUP_TOKEN: configured }))).toBe(true);
    expect(verifySetupToken('something-else-entirely', envWith({ SETUP_TOKEN: configured }))).toBe(false);
  });

  it('treats a SETUP_TOKEN under 16 characters as unset and warns', () => {
    current = createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = captureToken();
    issueSetupTokenOnBoot(envWith({ SETUP_TOKEN: 'short' }));
    expect(warn).toHaveBeenCalled();
    expect(out.logs.join('\n')).toMatch(/Budget Tracker setup token: \S+/);
    expect(verifySetupToken('short', envWith({ SETUP_TOKEN: 'short' }))).toBe(false);
  });
});

describe('verifySetupToken', () => {
  it('rejects empty and wrong input', () => {
    current = createTestDb();
    captureToken();
    issueSetupTokenOnBoot(envWith());
    expect(verifySetupToken('', envWith())).toBe(false);
    expect(verifySetupToken('abc', envWith())).toBe(false);
  });

  it('stops verifying once the hash is cleared', () => {
    current = createTestDb();
    const out = captureToken();
    issueSetupTokenOnBoot(envWith());
    const token = out.token();
    clearSetupToken();
    expect(verifySetupToken(token, envWith())).toBe(false);
  });
});
