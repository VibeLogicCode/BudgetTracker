import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { createSession } from '@/lib/auth/session';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session-constants';
import { GET as exportGet } from '@/app/api/reports/export/route';
import { GET as taxExportGet } from '@/app/api/reports/tax-export/route';
import { GET as backupGet } from '@/app/api/backup/download/route';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup(mustChange: boolean) {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice', role: 'admin' });
  if (mustChange) current.db.run(sql`update users set must_change_password = 1 where id = ${userId}`);
  const session = createSession(userId, { userAgent: null, ip: 'unknown', at: new Date() });
  const cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
  return { cookie };
}

function request(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } });
}

describe('v1.12.1: bulk exports honour the forced-password-change gate (item AD / SEC-9)', () => {
  it('the transactions export returns 403 under the flag', async () => {
    const { cookie } = setup(true);
    const response = await exportGet(request('http://localhost/api/reports/export', cookie));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Finish setting your password first.');
  });

  it('the tax-year export returns 403 under the flag', async () => {
    const { cookie } = setup(true);
    const response = await taxExportGet(request('http://localhost/api/reports/tax-export?year=2026', cookie));
    expect(response.status).toBe(403);
  });

  it('the backup download returns 403 under the flag, before any archive is built', async () => {
    const { cookie } = setup(true);
    const response = await backupGet(request('http://localhost/api/backup/download', cookie));
    expect(response.status).toBe(403);
  });

  it('the transactions export works normally without the flag', async () => {
    const { cookie } = setup(false);
    const response = await exportGet(request('http://localhost/api/reports/export', cookie));
    expect(response.status).toBe(200);
  });
});
