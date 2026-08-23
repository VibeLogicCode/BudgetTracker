import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { isSchedulerRunning, runSimplefinTick, startScheduler, stopScheduler } from '@/lib/scheduler';
import {
  AUTO_SYNC_INTERVALS,
  DAILY_REQUEST_LIMIT,
  SETTING_AUTO_SYNC,
  SETTING_AUTO_SYNC_USER_ID,
  consumeRequest,
  markSynced,
  saveClaimedConnection,
} from '@/lib/simplefin/connection';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { drainOutboxForTests, resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { deleteSetting, setSetting } from '@/lib/settings';
import * as syncModule from '@/lib/simplefin/sync';

// Obviously-fake credential: SimpleFIN access URLs embed HTTP basic-auth credentials, and
// this suite exists in part to prove that string can never reach a notification. Never a
// real bridge host/token.
const FAKE_ACCESS_URL = 'https://fake-user:fake-pass@fake-bridge.example.test/simplefin';

let t: TestDb;

beforeEach(() => {
  t = createTestDb();
  resetOutboxPumpForTests();
  // No real network I/O for the outbox pump: several tests below expect the sync_failed
  // outbox row to reach 'sent' quickly via drainOutboxForTests(), and the fixture SMTP host
  // ('h') is not a real server.
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

/** An active admin with a working email target, so enqueue() actually inserts a row. */
function adminWithEmail(overrides: { role?: 'admin' | 'member'; isActive?: boolean } = {}): number {
  const userId = insertTestUser(t.db, {
    role: overrides.role ?? 'admin',
    isActive: overrides.isActive ?? true,
    username: `u${Math.random().toString(36).slice(2, 8)}`,
  });
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId, destination: 'admin@example.com', enabled: true });
  return userId;
}

function outboxRows(): { user_id: number; event_id: string; dedup_key: string; subject: string; body: string }[] {
  return t.sqlite
    .prepare('select user_id, event_id, dedup_key, subject, body from notification_outbox order by id')
    .all() as never;
}

function outboxCount(): number {
  const row = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
  return row.n;
}

function disableConnection(): void {
  t.sqlite.prepare('update simplefin_connections set enabled = 0').run();
}

describe('AUTO_SYNC_INTERVALS: the one constant the scheduler, UI and zod all read', () => {
  it('pins the four keys and their labels/dueAfterHours exactly (Task 8 spec)', () => {
    expect(AUTO_SYNC_INTERVALS).toEqual({
      '6h': { label: 'Every 6 hours', dueAfterHours: 5.5 },
      '12h': { label: 'Every 12 hours', dueAfterHours: 11 },
      daily: { label: 'Once a day', dueAfterHours: 20 },
      weekly: { label: 'Once a week', dueAfterHours: 160 },
    });
  });

  it('every dueAfterHours sits strictly below its nominal interval, so the tick cannot drift the cadence later', () => {
    expect(AUTO_SYNC_INTERVALS['6h'].dueAfterHours).toBeLessThan(6);
    expect(AUTO_SYNC_INTERVALS['12h'].dueAfterHours).toBeLessThan(12);
    expect(AUTO_SYNC_INTERVALS.daily.dueAfterHours).toBeLessThan(24);
    expect(AUTO_SYNC_INTERVALS.weekly.dueAfterHours).toBeLessThan(24 * 7);
  });
});

describe('runSimplefinTick — the gate (absence or an invalid value both mean off)', () => {
  it('attempts nothing when the setting is entirely absent', () => {
    const spy = vi.spyOn(syncModule, 'runSync');
    const adminId = adminWithEmail();
    saveClaimedConnection(FAKE_ACCESS_URL);
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));
    // deliberately no SETTING_AUTO_SYNC key at all

    runSimplefinTick(new Date());

    expect(spy).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it('attempts nothing when the stored value is not one of the four recognised keys', () => {
    const spy = vi.spyOn(syncModule, 'runSync');
    const adminId = adminWithEmail();
    saveClaimedConnection(FAKE_ACCESS_URL);
    setSetting(SETTING_AUTO_SYNC, 'monthly');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(new Date());

    expect(spy).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });
});

describe('runSimplefinTick — connection state is a silent no-op', () => {
  it('does nothing at all with no connection configured', () => {
    const spy = vi.spyOn(syncModule, 'runSync');
    const adminId = adminWithEmail();
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(new Date());

    expect(spy).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });

  it('does nothing at all when the connection is disabled', () => {
    const spy = vi.spyOn(syncModule, 'runSync');
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    disableConnection();
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(now);

    expect(spy).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });
});

describe('runSimplefinTick — an exhausted request budget is backpressure, never a failure', () => {
  it('does not sync and raises no notification when the daily budget is spent', async () => {
    const spy = vi.spyOn(syncModule, 'runSync');
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000)); // hugely overdue
    for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) consumeRequest(now);
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(now);
    await drainOutboxForTests();

    expect(spy).not.toHaveBeenCalled();
    expect(outboxCount()).toBe(0);
  });
});

describe('runSimplefinTick — due-check, table-driven across all four intervals', () => {
  for (const [key, cfg] of Object.entries(AUTO_SYNC_INTERVALS)) {
    it(`${key}: does not fire just under its dueAfterHours (${cfg.dueAfterHours}h)`, () => {
      const spy = vi.spyOn(syncModule, 'runSync');
      const adminId = adminWithEmail();
      const now = new Date('2026-08-22T12:00:00Z');
      saveClaimedConnection(FAKE_ACCESS_URL, now);
      markSynced(new Date(now.getTime() - (cfg.dueAfterHours * 3600 * 1000 - 60_000)));
      setSetting(SETTING_AUTO_SYNC, key);
      setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

      runSimplefinTick(now);

      expect(spy).not.toHaveBeenCalled();
    });

    it(`${key}: fires just over its dueAfterHours (${cfg.dueAfterHours}h)`, () => {
      const now = new Date('2026-08-22T12:00:00Z');
      const spy = vi.spyOn(syncModule, 'runSync').mockResolvedValue({
        ranAt: now.toISOString(),
        accounts: [],
        errlist: [],
        totalAdded: 0,
        totalDuplicates: 0,
        engine: { processed: 0, categorized: 0, transfers: 0, skipped: 0 },
        engineFailed: false,
        loanLinksCreated: 0,
        loanMatchFailed: false,
      });
      const adminId = adminWithEmail();
      saveClaimedConnection(FAKE_ACCESS_URL, now);
      markSynced(new Date(now.getTime() - (cfg.dueAfterHours * 3600 * 1000 + 60_000)));
      setSetting(SETTING_AUTO_SYNC, key);
      setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

      runSimplefinTick(now);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ userId: adminId, now });
    });
  }

  it('a connection that has never synced (lastSyncAt null) is always due, regardless of interval', () => {
    const spy = vi.spyOn(syncModule, 'runSync').mockResolvedValue({
      ranAt: new Date().toISOString(),
      accounts: [],
      errlist: [],
      totalAdded: 0,
      totalDuplicates: 0,
      engine: { processed: 0, categorized: 0, transfers: 0, skipped: 0 },
      engineFailed: false,
      loanLinksCreated: 0,
      loanMatchFailed: false,
    });
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now); // lastSyncAt stays null
    setSetting(SETTING_AUTO_SYNC, 'weekly');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(now);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('runSimplefinTick — single-flight', () => {
  it('a second tick arriving while one is still in flight does nothing', async () => {
    let resolveSync!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const spy = vi.spyOn(syncModule, 'runSync').mockImplementation(async () => {
      await pending;
      return {
        ranAt: new Date().toISOString(),
        accounts: [],
        errlist: [],
        totalAdded: 0,
        totalDuplicates: 0,
        engine: { processed: 0, categorized: 0, transfers: 0, skipped: 0 },
        engineFailed: false,
        loanLinksCreated: 0,
        loanMatchFailed: false,
      };
    });
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    runSimplefinTick(now);
    runSimplefinTick(new Date(now.getTime() + 1000));
    runSimplefinTick(new Date(now.getTime() + 2000));

    expect(spy).toHaveBeenCalledTimes(1);

    resolveSync();
    // The guard only clears once the .finally() on the in-flight promise chain actually
    // runs, a few microtasks after resolveSync(). toHaveBeenCalledTimes(1) is already true
    // right now, so merely awaiting that condition would resolve immediately and prove
    // nothing; retrying the ACTION itself inside vi.waitFor is what actually waits for the
    // guard to release, then confirms a fresh tick goes through.
    await vi.waitFor(() => {
      runSimplefinTick(new Date(now.getTime() + 3000));
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('runSimplefinTick — a sync failure raises sync_failed', () => {
  it('raises exactly one outbox row for the day, and neither its subject nor its body contains the access URL', async () => {
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    const boom = new Error('The SimpleFIN bridge returned HTTP 500.');
    // Attach the fake credential to a field OTHER than .message, to prove the failure path
    // extracts only error.message and never serialises the whole error/stack anywhere.
    boom.stack = `Error: boom\n    at fetchAccounts (${FAKE_ACCESS_URL}:1:1)`;
    vi.spyOn(syncModule, 'runSync').mockRejectedValue(boom);

    runSimplefinTick(now);
    await vi.waitFor(() => expect(outboxCount()).toBeGreaterThan(0));
    await drainOutboxForTests();

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe('sync_failed');
    expect(rows[0].dedup_key).toBe('sync-failed:2026-08-22');
    expect(rows[0].subject).not.toContain(FAKE_ACCESS_URL);
    expect(rows[0].subject).not.toContain('fake-pass');
    expect(rows[0].body).not.toContain(FAKE_ACCESS_URL);
    expect(rows[0].body).not.toContain('fake-pass');
    expect(rows[0].body).toContain(boom.message);

    // A second failure the same calendar day must not add a second row.
    vi.spyOn(syncModule, 'runSync').mockRejectedValue(new Error('a different failure'));
    runSimplefinTick(new Date(now.getTime() + 3600_000));
    await vi.waitFor(() => expect(outboxCount()).toBe(1));
  });
});

describe('runSimplefinTick — an invalid stored auto-sync user', () => {
  it('raises sync_failed instead of throwing or calling runSync, when the id no longer exists', async () => {
    const adminId = adminWithEmail();
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId + 99999));
    const spy = vi.spyOn(syncModule, 'runSync');

    expect(() => runSimplefinTick(now)).not.toThrow();
    await vi.waitFor(() => expect(outboxCount()).toBe(1));

    expect(spy).not.toHaveBeenCalled();
    const rows = outboxRows();
    expect(rows[0].event_id).toBe('sync_failed');
    expect(rows[0].body).toMatch(/no longer.*admin/i);
    expect(rows[0].body).toMatch(/re-save|settings/i);
  });

  it('raises sync_failed instead of syncing as them, when the id belongs to a demoted (member) user', async () => {
    const adminId = adminWithEmail(); // provides the email target admins are notified through
    const demotedId = insertTestUser(t.db, { role: 'member', username: 'demoted' });
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(demotedId));
    const spy = vi.spyOn(syncModule, 'runSync');

    runSimplefinTick(now);
    await vi.waitFor(() => expect(outboxCount()).toBe(1));

    expect(spy).not.toHaveBeenCalled();
    expect(outboxRows()[0].user_id).toBe(adminId);
  });

  it('raises sync_failed instead of syncing as them, when the id belongs to a deactivated admin', async () => {
    const adminId = adminWithEmail();
    const deactivatedId = insertTestUser(t.db, { role: 'admin', isActive: false, username: 'gone' });
    const now = new Date('2026-08-22T12:00:00Z');
    saveClaimedConnection(FAKE_ACCESS_URL, now);
    markSynced(new Date(now.getTime() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(deactivatedId));
    const spy = vi.spyOn(syncModule, 'runSync');

    runSimplefinTick(now);
    await vi.waitFor(() => expect(outboxCount()).toBe(1));

    expect(spy).not.toHaveBeenCalled();
    expect(outboxRows()[0].user_id).toBe(adminId);
  });
});

describe('runSimplefinTick — registration (mirrors the house style for runUpdateTick)', () => {
  function allIndicesOf(haystack: string, needle: string): number[] {
    const out: number[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) return out;
      out.push(at);
      from = at + needle.length;
    }
  }

  it('is registered in the cron callback and once at boot, both after runUpdateTick', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');

    // The existing MUST-5.2 test in scheduler.test.ts already pins runUpdateTick() directly
    // ahead of runNotifyTick() in both places (the cron callback and the boot sequence), and
    // that runUpdateTick() itself appears exactly twice. Here: runSimplefinTick() also
    // appears exactly twice, and -- comparing the two calls in file order, allowing for
    // comment lines in between rather than demanding strict line adjacency -- the Nth
    // runUpdateTick() call precedes the Nth runSimplefinTick() call, in both the cron
    // callback and the boot sequence.
    const updateAts = allIndicesOf(source, 'runUpdateTick();');
    const simplefinAts = allIndicesOf(source, 'runSimplefinTick();');
    expect(updateAts).toHaveLength(2);
    expect(simplefinAts).toHaveLength(2);
    expect(updateAts[0]).toBeLessThan(simplefinAts[0]);
    expect(updateAts[1]).toBeLessThan(simplefinAts[1]);
  });

  it('stopScheduler resets the single-flight guard', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toMatch(/simplefinTicking = false;/);
  });

  it('boot runs an immediate simplefin tick, so a due sync fires without waiting for the next cron tick', () => {
    const spy = vi.spyOn(syncModule, 'runSync').mockResolvedValue({
      ranAt: new Date().toISOString(),
      accounts: [],
      errlist: [],
      totalAdded: 0,
      totalDuplicates: 0,
      engine: { processed: 0, categorized: 0, transfers: 0, skipped: 0 },
      engineFailed: false,
      loanLinksCreated: 0,
      loanMatchFailed: false,
    });
    const adminId = adminWithEmail();
    // startScheduler() calls runSimplefinTick() with the real clock (no `now` override), so
    // this fixture is anchored to Date.now() rather than a fixed calendar date.
    saveClaimedConnection(FAKE_ACCESS_URL);
    markSynced(new Date(Date.now() - 999 * 3600 * 1000));
    setSetting(SETTING_AUTO_SYNC, 'daily');
    setSetting(SETTING_AUTO_SYNC_USER_ID, String(adminId));

    startScheduler();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(isSchedulerRunning()).toBe(true);
  });

  it('does not add a fourth ScheduledTask: isSchedulerRunning is unaffected by the gate state', () => {
    deleteSetting(SETTING_AUTO_SYNC);
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});
