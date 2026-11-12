import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  SETTING_AUTO_SYNC_FAILURES,
  SETTING_AUTO_SYNC_LAST_ATTEMPT_AT,
  autoSyncBackoff,
  autoSyncBackoffMs,
  deleteConnection,
  getConnection,
  isSimplefinManaged,
  linkAccount,
  linkOverlap,
  listLinks,
  markLinksFirstSynced,
  markSynced,
  recordAutoSyncAttempt,
  recordAutoSyncFailure,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';
import { getSetting } from '@/lib/settings';
import { addDaysIso } from '@/lib/dates';

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

/**
 * v1.61.0 item 3a. Before an account is linked, the admin sees what the account already holds from
 * the bridge's 90 days and a first day to take from the bank: the day after the newest IMPORTED
 * row. Hand-typed rows never move it; they go through the duplicate check at sync instead.
 */
describe('linkOverlap', () => {
  function seed() {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Sam Visa', type: 'credit' });
    const otherId = insertTestAccount(current.db, { name: 'Joint Chequing' });
    const insert = current.sqlite.prepare(
      `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, origin, created_by, created_at, updated_at)
       values (?, ?, 'MAPLE GROCER', 'MAPLE GROCER', -4217, ?, ?, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
    );
    const add = (date: string, origin: string, account = accountId) => insert.run(account, date, origin, alex);
    return { accountId, otherId, add };
  }

  it('suggests the day after the newest imported row, counts the window by source, and ignores hand-typed rows', () => {
    const { accountId, otherId, add } = seed();
    // 198 CSV rows ending 2026-05-28, all inside the window that opens 2026-03-08.
    for (let i = 0; i < 198; i += 1) add(addDaysIso('2026-05-28', -Math.floor(i / 3)), 'csv');
    // 14 hand-typed rows up to 2026-06-02.
    for (let i = 0; i < 14; i += 1) add(addDaysIso('2026-06-02', -i), 'manual');
    // Outside the window, and another account: neither is counted.
    add('2026-01-15', 'csv');
    add('2026-06-01', 'csv', otherId);

    expect(linkOverlap(accountId, '2026-06-05')).toEqual({
      today: '2026-06-05',
      windowStart: '2026-03-08',
      rowsInWindow: 212,
      byOrigin: { manual: 14, csv: 198, ofx: 0, simplefin: 0 },
      newestImported: '2026-05-28',
      suggestedStart: '2026-05-29',
    });
  });

  it('suggests the window start when the account holds nothing imported', () => {
    const { accountId, add } = seed();
    add('2026-06-03', 'manual');
    const overlap = linkOverlap(accountId, '2026-06-05');
    expect(overlap.newestImported).toBeNull();
    expect(overlap.suggestedStart).toBe('2026-03-08');
    expect(overlap.rowsInWindow).toBe(1);
  });

  it('suggests the window start when the newest imported row is older than the window', () => {
    const { accountId, add } = seed();
    add('2026-01-15', 'ofx');
    expect(linkOverlap(accountId, '2026-06-05')).toMatchObject({ rowsInWindow: 0, newestImported: '2026-01-15', suggestedStart: '2026-03-08' });
  });

  it('suggests today when the newest imported row is today', () => {
    const { accountId, add } = seed();
    add('2026-06-05', 'ofx');
    expect(linkOverlap(accountId, '2026-06-05')).toMatchObject({ newestImported: '2026-06-05', suggestedStart: '2026-06-05' });
  });

  /**
   * Fix round. Rows an earlier link synced meet the next sync by bank id, so they never move the
   * start: after an unlink and relink, a start the day after the newest of them would drop every
   * row the bank posts late as `beforeStart`, for good.
   */
  it('ignores rows an earlier link synced: only statements move the suggestion', () => {
    const { accountId, add } = seed();
    add('2026-05-20', 'csv');
    add('2026-06-03', 'simplefin');
    expect(linkOverlap(accountId, '2026-06-05')).toMatchObject({
      byOrigin: { manual: 0, csv: 1, ofx: 0, simplefin: 1 },
      newestImported: '2026-05-20',
      suggestedStart: '2026-05-21',
    });
  });

  it('suggests the window start for an account that only ever synced', () => {
    const { accountId, add } = seed();
    add('2026-06-03', 'simplefin');
    expect(linkOverlap(accountId, '2026-06-05')).toMatchObject({ newestImported: null, suggestedStart: '2026-03-08' });
  });
});

describe('the link start date (v1.61.0 item 3b)', () => {
  it('stores sync_from on a new link and leaves an old-style link NULL', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(current.db, { name: 'Bridge Savings' });
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD', syncFrom: '2026-05-29' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });
    const byRemote = new Map(listLinks().map((link) => [link.simplefinAccountId, link]));
    expect(byRemote.get('remote-1')).toMatchObject({ syncFrom: '2026-05-29', firstSyncedAt: null });
    expect(byRemote.get('remote-2')).toMatchObject({ syncFrom: null, firstSyncedAt: null });
  });

  it('linking again moves the start and makes the next sync a first sync again', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD', syncFrom: '2026-05-29' });
    markLinksFirstSynced(['remote-1'], new Date('2026-06-05T16:00:00.000Z'));
    expect(listLinks()[0]).toMatchObject({ firstSyncedAt: '2026-06-05T16:00:00.000Z' });

    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD', syncFrom: '2026-05-20' });
    expect(listLinks()[0]).toMatchObject({ syncFrom: '2026-05-20', firstSyncedAt: null });
  });

  it('stamps only links still waiting for their first sync, and keeps the first stamp', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'Bridge Chequing' });
    const b = insertTestAccount(current.db, { name: 'Bridge Savings' });
    linkAccount({ simplefinAccountId: 'remote-1', accountId: a, currency: 'CAD', syncFrom: '2026-05-29' });
    linkAccount({ simplefinAccountId: 'remote-2', accountId: b, currency: 'CAD' });
    markLinksFirstSynced(['remote-1', 'remote-2'], new Date('2026-06-05T16:00:00.000Z'));
    markLinksFirstSynced(['remote-1'], new Date('2026-06-06T16:00:00.000Z'));
    const byRemote = new Map(listLinks().map((link) => [link.simplefinAccountId, link]));
    expect(byRemote.get('remote-1')!.firstSyncedAt).toBe('2026-06-05T16:00:00.000Z');
    // An old-style link has no start date, so there is nothing pending to stamp.
    expect(byRemote.get('remote-2')!.firstSyncedAt).toBeNull();
  });
});
