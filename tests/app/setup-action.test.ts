import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';

let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { setupAction } from '@/app/(auth)/setup/actions';
import { issueSetupTokenOnBoot, verifySetupToken } from '@/lib/auth/setup-token';
import { countUsers } from '@/lib/auth/users';

let current: TestDb | null = null;
const ORIGINAL = process.env.SETUP_TOKEN;

beforeEach(() => {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  process.env.SECRET_KEY = 'k'.repeat(48);
  delete process.env.SETUP_TOKEN;
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (ORIGINAL === undefined) delete process.env.SETUP_TOKEN;
  else process.env.SETUP_TOKEN = ORIGINAL;
  vi.restoreAllMocks();
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const ACCOUNT = { name: 'Alex', username: 'alex', password: 'correct horse battery' };

function issue(): string {
  let line = '';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    line += `${args.map(String).join(' ')}\n`;
  });
  issueSetupTokenOnBoot();
  vi.restoreAllMocks();
  return (line.match(/Budget Tracker setup token: (\S+)/) as RegExpMatchArray)[1] as string;
}

describe('setupAction token gate', () => {
  it('refuses a missing token and creates no user', async () => {
    current = createTestDb();
    issue();
    const result = await setupAction({}, form(ACCOUNT));
    expect(result.error).toMatch(/setup token/i);
    expect(countUsers()).toBe(0);
  });

  it('refuses a wrong token and creates no user', async () => {
    current = createTestDb();
    issue();
    const result = await setupAction({}, form({ ...ACCOUNT, setupToken: 'not-the-token' }));
    expect(result.error).toMatch(/does not match/i);
    expect(countUsers()).toBe(0);
  });

  it('accepts the issued token, creates the admin and clears the hash', async () => {
    current = createTestDb();
    const token = issue();
    await expect(setupAction({}, form({ ...ACCOUNT, setupToken: token }))).rejects.toThrow('REDIRECT:/setup/accounts');
    expect(countUsers()).toBe(1);
    const row = current.sqlite.prepare("select value from settings where key = 'setup.token_hash'").get();
    expect(row).toBeUndefined();
    expect(verifySetupToken(token)).toBe(false);
  });

  it('accepts a configured SETUP_TOKEN', async () => {
    current = createTestDb();
    process.env.SETUP_TOKEN = 'maple-grocer-fuel-stop-12';
    await expect(
      setupAction({}, form({ ...ACCOUNT, setupToken: 'maple-grocer-fuel-stop-12' })),
    ).rejects.toThrow('REDIRECT:/setup/accounts');
    expect(countUsers()).toBe(1);
  });

  it('redirects to /login once an admin exists, even with a valid token', async () => {
    current = createTestDb();
    const token = issue();
    insertTestUser(current.db, { username: 'sam', role: 'admin' });
    await expect(setupAction({}, form({ ...ACCOUNT, setupToken: token }))).rejects.toThrow('REDIRECT:/login');
    expect(countUsers()).toBe(1);
  });
});
