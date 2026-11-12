import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, type TestDb } from '../../helpers/db';
import {
  SETTING_AUTO_SYNC_FAILURES,
  SETTING_AUTO_SYNC_LAST_ATTEMPT_AT,
  autoSyncBackoff,
  autoSyncBackoffMs,
  deleteConnection,
  getConnection,
  isSimplefinManaged,
  linkAccount,
  listLinks,
  markSynced,
  recordAutoSyncAttempt,
  recordAutoSyncFailure,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';
import { getSetting } from '@/lib/settings';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';

describe('deleteConnection — "forget" must not permanently lock accounts out of CSV import', () => {
  it('clears every account link along with the connection row', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    deleteConnection();

    expect(getConnection()).toBeNull();
    expect(listLinks()).toHaveLength(0);
    // The account reverts to CSV-managed — otherwise the CSV-exclusivity guard
    // in flow.ts would refuse it forever with no UI left to unlink from.
    expect(isSimplefinManaged(accountId)).toBe(false);
  });

  it('clears links for every account, not just the first', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(current.db, { name: 'Bridge Savings' });
    saveClaimedConnection(ACCESS_URL);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });

    deleteConnection();

    expect(isSimplefinManaged(a)).toBe(false);
    expect(isSimplefinManaged(b)).toBe(false);
  });

  it('is a no-op (no throw) when nothing is configured', () => {
    current = createSeededTestDb();
    expect(() => deleteConnection()).not.toThrow();
    expect(getConnection()).toBeNull();
    expect(listLinks()).toHaveLength(0);
  });
});

/**
 * v1.60.0 item 3a. A failing bank used to re-run the automatic sync on every five-minute tick until
 * the day's requests were gone. Consecutive automatic failures now push the next try back.
 */
describe('automatic sync backoff', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it('doubles from 30 minutes and caps at 24 hours', () => {
    expect(autoSyncBackoffMs(0)).toBe(0);
    expect(autoSyncBackoffMs(1)).toBe(30 * MIN);
    expect(autoSyncBackoffMs(2)).toBe(HOUR);
    expect(autoSyncBackoffMs(3)).toBe(2 * HOUR);
    expect(autoSyncBackoffMs(6)).toBe(16 * HOUR);
    expect(autoSyncBackoffMs(7)).toBe(24 * HOUR);
    expect(autoSyncBackoffMs(60)).toBe(24 * HOUR);
  });

  it('is not backing off with nothing recorded, or after an attempt that has not failed', () => {
    current = createSeededTestDb();
    const at = new Date('2026-11-12T14:00:00.000Z');
    expect(autoSyncBackoff(at)).toBeNull();
    recordAutoSyncAttempt(at);
    expect(autoSyncBackoff(new Date(at.getTime() + MIN))).toBeNull();
  });

  it('waits out the backoff from the last attempt, then lets the next try through', () => {
    current = createSeededTestDb();
    const at = new Date('2026-11-12T14:00:00.000Z');
    recordAutoSyncAttempt(at);
    expect(recordAutoSyncFailure()).toBe(1);
    expect(autoSyncBackoff(new Date(at.getTime() + 10 * MIN))).toEqual({ failures: 1, nextTryAt: new Date(at.getTime() + 30 * MIN) });
    expect(autoSyncBackoff(new Date(at.getTime() + 30 * MIN))).toBeNull();

    recordAutoSyncAttempt(new Date(at.getTime() + 30 * MIN));
    recordAutoSyncFailure();
    recordAutoSyncFailure();
    expect(autoSyncBackoff(new Date(at.getTime() + 40 * MIN))).toEqual({
      failures: 3,
      nextTryAt: new Date(at.getTime() + 30 * MIN + 2 * HOUR),
    });
  });

  it('a clean sync (markSynced) clears both keys', () => {
    current = createSeededTestDb();
    const at = new Date('2026-11-12T14:00:00.000Z');
    saveClaimedConnection(ACCESS_URL, at);
    recordAutoSyncAttempt(at);
    recordAutoSyncFailure();
    markSynced(new Date(at.getTime() + MIN));
    expect(getSetting(SETTING_AUTO_SYNC_FAILURES)).toBeNull();
    expect(getSetting(SETTING_AUTO_SYNC_LAST_ATTEMPT_AT)).toBeNull();
    expect(autoSyncBackoff(new Date(at.getTime() + 2 * MIN))).toBeNull();
  });

  it("claiming a new bridge starts without the old one's backoff", () => {
    current = createSeededTestDb();
    const at = new Date('2026-11-12T14:00:00.000Z');
    recordAutoSyncAttempt(at);
    recordAutoSyncFailure();
    saveClaimedConnection(ACCESS_URL, new Date(at.getTime() + MIN));
    expect(autoSyncBackoff(new Date(at.getTime() + 2 * MIN))).toBeNull();
  });
});
