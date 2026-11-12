import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import {
  SETTING_AUTO_SYNC,
  SETTING_AUTO_SYNC_USER_ID,
  isSimplefinManaged,
  linkAccount,
  listLinks,
  recordAutoSyncAttempt,
  recordAutoSyncFailure,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';
import { getSetting, setSetting } from '@/lib/settings';

let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };
let requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });

vi.mock('@/lib/auth/session', () => ({
  requireAdmin: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { forgetConnectionAction, setSimplefinAutoSyncAction } from '@/app/(app)/settings/connections/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';

function setup() {
  requestHeaders = new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' });
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
  return { db: current.db };
}

describe('forgetConnectionAction', () => {
  it('deletes the connection AND unlinks every account, reverting them to CSV-managed', async () => {
    const { db } = setup();
    const accountId = insertTestAccount(db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    const result = await forgetConnectionAction();

    expect(listLinks()).toHaveLength(0);
    expect(isSimplefinManaged(accountId)).toBe(false);
    expect(result.message).toMatch(/Bridge Chequing/);
    expect(result.message).toMatch(/CSV import/i);
  });

  it('names every affected account when more than one was linked', async () => {
    const { db } = setup();
    const a = insertTestAccount(db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(db, { name: 'Bridge Savings' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });

    const result = await forgetConnectionAction();

    expect(result.message).toMatch(/Bridge Chequing/);
    expect(result.message).toMatch(/Bridge Savings/);
    expect(isSimplefinManaged(a)).toBe(false);
    expect(isSimplefinManaged(b)).toBe(false);
  });

  it('rejects a cross-origin request and leaves the connection and its links alone (I2)', async () => {
    const { db } = setup();
    const accountId = insertTestAccount(db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await forgetConnectionAction();

    expect(result.error).toBe('Cross-origin request rejected');
    expect(result.message).toBeUndefined();
    expect(listLinks()).toHaveLength(1);
    expect(isSimplefinManaged(accountId)).toBe(true);
  });

  it('reports a plain removal message when nothing was ever linked', async () => {
    setup();
    saveClaimedConnection(ACCESS_URL);

    const result = await forgetConnectionAction();

    expect(result.message).toMatch(/Connection removed/i);
    expect(result.message).not.toMatch(/CSV import/i);
  });
});

describe('setSimplefinAutoSyncAction (Task 8)', () => {
  it('writes both settings keys, using the acting admin id, when an interval is chosen', async () => {
    setup();

    const result = await setSimplefinAutoSyncAction('daily');

    expect(result.error).toBeUndefined();
    expect(getSetting(SETTING_AUTO_SYNC)).toBe('daily');
    expect(getSetting(SETTING_AUTO_SYNC_USER_ID)).toBe(String(currentUser.id));
  });

  it('accepts every one of the four interval keys', async () => {
    setup();
    for (const key of ['6h', '12h', 'daily', 'weekly']) {
      const result = await setSimplefinAutoSyncAction(key);
      expect(result.error).toBeUndefined();
      expect(getSetting(SETTING_AUTO_SYNC)).toBe(key);
    }
  });

  it('deletes both settings keys when set to off', async () => {
    setup();
    await setSimplefinAutoSyncAction('daily');
    expect(getSetting(SETTING_AUTO_SYNC)).not.toBeNull();

    const result = await setSimplefinAutoSyncAction('off');

    expect(result.error).toBeUndefined();
    expect(getSetting(SETTING_AUTO_SYNC)).toBeNull();
    expect(getSetting(SETTING_AUTO_SYNC_USER_ID)).toBeNull();
  });

  it('rejects a value outside the constant, and writes nothing', async () => {
    setup();

    const result = await setSimplefinAutoSyncAction('every-lunar-cycle');

    expect(result.error).toBeTruthy();
    expect(getSetting(SETTING_AUTO_SYNC)).toBeNull();
    expect(getSetting(SETTING_AUTO_SYNC_USER_ID)).toBeNull();
  });

  it('rejects a cross-origin request and writes nothing (same guard style as forgetConnectionAction)', async () => {
    setup();
    requestHeaders = new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' });

    const result = await setSimplefinAutoSyncAction('daily');

    expect(result.error).toBe('Cross-origin request rejected');
    expect(getSetting(SETTING_AUTO_SYNC)).toBeNull();
  });
});

/**
 * v1.60.0 (fix round). A backoff runs up to 24 hours, so the waiting line's "Next try" names the
 * day once it is not today in the household's zone (the suite runs in America/Toronto).
 */
describe('ConnectionsPage: the backoff line names the day when it is not today', () => {
  afterEach(() => vi.useRealTimers());

  async function nextTry(lastAttempt: string, failures: number, now: string): Promise<string | undefined> {
    setup();
    saveClaimedConnection(ACCESS_URL);
    setSetting(SETTING_AUTO_SYNC, 'daily');
    recordAutoSyncAttempt(new Date(lastAttempt));
    for (let i = 0; i < failures; i += 1) recordAutoSyncFailure();
    vi.useFakeTimers({ now: new Date(now), toFake: ['Date'] });
    const { default: ConnectionsPage } = await import('@/app/(app)/settings/connections/page');
    const element = (await ConnectionsPage()) as { props: { autoSyncWaiting: { nextTry: string } | null } };
    return element.props.autoSyncWaiting?.nextTry;
  }

  it('a time later today is the time alone', async () => {
    // 10:00 Toronto, one failure: back in 30 minutes.
    expect(await nextTry('2026-11-12T15:00:00.000Z', 1, '2026-11-12T15:05:00.000Z')).toBe('10:30');
  });

  it('a time past midnight names its day', async () => {
    // 23:50 Toronto on Nov 12, one failure: 00:20 on Nov 13, which is not today.
    expect(await nextTry('2026-11-13T04:50:00.000Z', 1, '2026-11-13T04:55:00.000Z')).toBe('Nov 13 at 00:20');
  });
});
