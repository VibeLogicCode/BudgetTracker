import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import os from 'node:os';
import {
  BACKUP_CATCH_UP_DELAY_MS,
  NIGHTLY_CRON,
  NOTIFY_TICK_CRON,
  OCR_SWEEP_CRON,
  isSchedulerRunning,
  runAiTick,
  runNightlyTick,
  runNotifyTick,
  runUpdateTick,
  scheduleBackupCatchUp,
  startScheduler,
  stopScheduler,
} from '@/lib/scheduler';
import * as backupModule from '@/lib/backup';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import * as configModule from '@/lib/notify/config';
import * as evaluateModule from '@/lib/notify/evaluate';
import { drainOutboxForTests } from '@/lib/notify/outbox';
import * as raiseModule from '@/lib/notify/raise';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import * as checkModule from '@/lib/update/check';
import { readUpdateState, recordCheckOutcome, setUpdateChecksEnabled } from '@/lib/update/state';
import { APP_VERSION } from '@/lib/version';
import { saveLocalAiConfig } from '@/lib/ai/config';
import * as aiQueueModule from '@/lib/ai/queue';
import * as aiSuggestionsModule from '@/lib/ai/suggestions';

// M8: startScheduler() runs the OCR sweep once at boot, which calls getDb() via
// sweepPendingReceipts(). Without an isolated test db, that call falls through to the
// shared .tmp-data/budget.db used by every other test in the suite that doesn't set one up
// itself — leaking rows/side effects across test files. createTestDb() points getDb() at a
// throwaway temp-directory database for the duration of each test instead.
let current: TestDb | null = null;

beforeEach(() => {
  current = createTestDb();
});

afterEach(() => {
  stopScheduler();
  current?.cleanup();
  current = null;
});

describe('scheduler', () => {
  it('keeps the nightly cron and adds a ten-minute OCR sweep (MUST-7.12)', () => {
    expect(NIGHTLY_CRON).toBe('0 2 * * *');
    expect(OCR_SWEEP_CRON).toBe('*/10 * * * *');
  });

  it('is idempotent and stops cleanly', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    startScheduler();
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('also runs the sweep once at boot, not only on the tick', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toContain('sweepPendingReceipts');
    expect(source).toContain('runOcrSweep();');
  });
});

describe('MUST-6.1 / MUST-6.4: the notification tick', () => {
  it('pins the cron expression', () => {
    expect(NOTIFY_TICK_CRON).toBe('*/5 * * * *');
  });

  it('AC4: on a dormant install the tick reaches neither the evaluator nor the sender', async () => {
    const t = createTestDb();
    const sender = vi.fn(async () => {});
    const evaluate = vi.spyOn(evaluateModule, 'runScheduledEvaluation');
    setNotifySenderForTests(sender);
    try {
      for (let i = 0; i < 12; i += 1) runNotifyTick(new Date(Date.now() + i * 5 * 60_000));
      await drainOutboxForTests();
      // The empty-outbox/zero-row assertions below hold even if the dormancy bail itself
      // were deleted (there is nothing configured to evaluate or send either way), so the
      // evaluator spy is what actually proves the bail short-circuited the tick.
      expect(evaluate).not.toHaveBeenCalled();
      expect(sender).not.toHaveBeenCalled();
      const { n } = t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number };
      expect(n).toBe(0);

      // Enabling a channel lifts the dormancy bail: the very next tick must reach the
      // evaluator exactly once.
      const userId = insertTestUser(t.db, { username: 'dormancy-probe' });
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
      saveEmailTarget({ userId, destination: 'probe@example.com', enabled: true });
      runNotifyTick(new Date());
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
      resetNotifySenderForTests();
      t.cleanup();
    }
  });

  // O-03: hasAnyEnabledTarget()/countPendingOutbox() are database reads sitting ABOVE
  // runNotifyTick's own try/catch -- a throw there (a locked database, a full disk, a
  // corrupted page) used to propagate out of the cron callback uncaught, instead of being
  // caught and logged the same way every sibling job in this file handles its own failure.
  it("O-03: a throwing dormancy read does not escape runNotifyTick, and is logged like every sibling job", () => {
    const boom = new Error('database is locked');
    const spy = vi.spyOn(configModule, 'hasAnyEnabledTarget').mockImplementation(() => {
      throw boom;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => runNotifyTick(new Date())).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith('[notify] tick failed', boom);
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('registers and stops the notify task with the others', () => {
    startScheduler();
    expect(isSchedulerRunning()).toBe(true);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it('MUST-14.1: a nightly failure raises backup_failed with the same error the job threw', () => {
    const boom = new Error('ENOSPC: no space left on device');
    const nightly = vi.spyOn(backupModule, 'runNightlyJob').mockImplementation(() => {
      throw boom;
    });
    const raise = vi.spyOn(raiseModule, 'raiseBackupFailed').mockImplementation(() => {});
    try {
      const at = new Date('2026-08-17T06:00:00Z');
      // Deleting the raiseBackupFailed call from the scheduler's nightly catch would leave
      // runNightlyTick's own error handling intact (it still logs and swallows), so the
      // meaningful assertion is that the raise was actually reached with the real error —
      // not merely that runNightlyTick didn't throw.
      expect(() => runNightlyTick(at)).not.toThrow();
      expect(nightly).toHaveBeenCalledWith(at);
      expect(raise).toHaveBeenCalledWith({ error: boom, at });
    } finally {
      raise.mockRestore();
      nightly.mockRestore();
    }
  });
});

describe('MUST-5.1 … MUST-5.4: the update tick', () => {
  it('AC4: with checks disabled, a boot plus twelve ticks perform ZERO fetches', () => {
    const spy = vi.fn(async () => new Response('', { status: 200 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      startScheduler();
      for (let i = 0; i < 12; i += 1) runUpdateTick(new Date(Date.now() + i * 5 * 60_000));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('respects the 24-hour interval: nothing at 23 hours, a check at 25', async () => {
    const userId = insertTestUser(current!.db, { username: 'sched-admin', role: 'admin' });
    setUpdateChecksEnabled({ enabled: true, userId });
    recordCheckOutcome({ at: new Date('2026-08-18T00:00:00.000Z'), latestVersion: null });
    const spy = vi.fn(async () => new Response(JSON.stringify({ tag_name: `v${APP_VERSION}` }), { status: 200 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      runUpdateTick(new Date('2026-08-18T23:00:00.000Z'));
      expect(spy).not.toHaveBeenCalled();
      const at = new Date('2026-08-19T01:00:00.000Z');
      runUpdateTick(at);
      // Wait for the PERSISTED outcome, not just the fetch call: runUpdateCheck's fire-and-
      // forget chain keeps writing (recordCheckOutcome, possibly the outbox) after the fetch
      // promise resolves, and if the test returns as soon as the spy fires, that write can
      // land after this test's db is torn down and land in the next test's db instead.
      await vi.waitFor(() => expect(readUpdateState().lastCheckedAt).toBe(at.toISOString()));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('MUST-5.2: the cron callback and the boot path call it BEFORE runNotifyTick', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    // 2026-09-09: runCanadianPackUpdateTick sat between these two until a merchant-pack update
    // stopped being pushed at all (it is on the Merchant rules page, it is not urgent, and a
    // channel that mostly carries such facts stops being read). The ordering claim this test
    // exists for -- the app's own update check runs BEFORE the generic notify tick -- is
    // unchanged, and is now the plain adjacency it originally was.
    expect(source).toMatch(/runUpdateTick\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*runNotifyTick\(/);
    // Two occurrences: the cron callback and the boot call.
    expect(source.match(/runUpdateTick\(\);/g)).toHaveLength(2);
    // The function still EXISTS -- unscheduling it is one line to revisit, exactly as
    // evaluateBudgets is -- but nothing calls it on a tick or at boot any more.
    expect(source.match(/^\s*runCanadianPackUpdateTick\(\);/gm)).toBeNull();
  });

  it('MUST-5.3: notify\'s dormancy bail is still the first statement after its single-flight guard', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toContain('if (!hasAnyEnabledTarget() && countPendingOutbox() === 0) return;');
  });

  it('MUST-5.4: stopScheduler resets the update single-flight guard', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    expect(source).toMatch(/bootExpiryDone = false;[\s\S]{0,200}updateTicking = false;/);
  });

  it('MUST-5.4 (behavioral): a rejected runUpdateCheck still clears the single-flight guard, so a second tick runs it again', async () => {
    const userId = insertTestUser(current!.db, { username: 'sched-admin3', role: 'admin' });
    setUpdateChecksEnabled({ enabled: true, userId });
    const spy = vi.spyOn(checkModule, 'runUpdateCheck').mockRejectedValueOnce(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // state.lastCheckedAt is never written by a mocked runUpdateCheck, so dueForCheck stays
      // true for both calls below regardless of the timestamps passed — the only thing under
      // test is whether updateTicking's `finally` clears the flag after a REJECTION, not just
      // after a normal resolution.
      runUpdateTick(new Date('2026-08-18T00:00:00.000Z'));
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

      spy.mockResolvedValueOnce({
        severity: 'none',
        currentVersion: APP_VERSION,
        latestVersion: null,
        applied: false,
        notified: false,
        error: null,
      });
      runUpdateTick(new Date('2026-08-18T00:05:00.000Z'));
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('a throwing runUpdateCheck does not prevent runNotifyTick from running', () => {
    const userId = insertTestUser(current!.db, { username: 'sched-admin2', role: 'admin' });
    setUpdateChecksEnabled({ enabled: true, userId });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    try {
      expect(() => {
        runUpdateTick(new Date());
        runNotifyTick(new Date());
      }).not.toThrow();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * v1.60.0 item 7c. A machine that was off at 02:00 (or for a week) took its next backup at the
 * next 02:00. Boot now checks once and, when the newest archive is over 26 hours old (or there is
 * none) and somebody has an account, runs the nightly job two minutes later on an unref'd timer, so
 * boot itself never waits on it.
 */
describe('boot backup catch-up (item 7c)', () => {
  const BOOT = new Date('2026-11-12T15:00:00.000Z');
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-catchup-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: BOOT });
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function archiveHoursAgo(hours: number): void {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'budget-2026-11-11.tar.gz');
    fs.writeFileSync(file, 'x');
    const at = new Date(BOOT.getTime() - hours * 3600_000);
    fs.utimesSync(file, at, at);
  }

  function stubNightly() {
    return vi.spyOn(backupModule, 'runNightlyJob').mockImplementation(() => ({}) as never);
  }

  it('waits two minutes', () => {
    expect(BACKUP_CATCH_UP_DELAY_MS).toBe(2 * 60 * 1000);
  });

  it('with no archive and a user, runs the nightly job two minutes after boot, not before', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const nightly = stubNightly();

    expect(scheduleBackupCatchUp(BOOT)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(nightly).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BACKUP_CATCH_UP_DELAY_MS - 1);
    expect(nightly).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(nightly).toHaveBeenCalledTimes(1);
  });

  it('runs when the newest archive is 27 hours old, not when it is 25', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    archiveHoursAgo(25);
    expect(scheduleBackupCatchUp(BOOT)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    archiveHoursAgo(27);
    expect(scheduleBackupCatchUp(BOOT)).toBe(true);
  });

  it('does nothing before anyone has an account', () => {
    const nightly = stubNightly();
    expect(scheduleBackupCatchUp(BOOT)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(nightly).not.toHaveBeenCalled();
  });

  it('stopScheduler clears the pending timer', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const nightly = stubNightly();
    scheduleBackupCatchUp(BOOT);
    stopScheduler();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(nightly).not.toHaveBeenCalled();
  });

  it('schedules once, however often it is asked', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    expect(scheduleBackupCatchUp(BOOT)).toBe(true);
    expect(scheduleBackupCatchUp(BOOT)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('skips the run when a backup landed during the wait (the 02:00 job, say)', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const nightly = stubNightly();
    scheduleBackupCatchUp(BOOT);
    archiveHoursAgo(0);
    vi.advanceTimersByTime(BACKUP_CATCH_UP_DELAY_MS);
    expect(nightly).not.toHaveBeenCalled();
  });

  it('skips the run while a restore is staged or being applied', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const nightly = stubNightly();
    scheduleBackupCatchUp(BOOT);
    fs.mkdirSync(path.join(dataDir, 'restore-staged'), { recursive: true });
    vi.advanceTimersByTime(BACKUP_CATCH_UP_DELAY_MS);
    expect(nightly).not.toHaveBeenCalled();

    fs.rmSync(path.join(dataDir, 'restore-staged'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, 'restore-applying'), { recursive: true });
    scheduleBackupCatchUp(new Date());
    vi.advanceTimersByTime(BACKUP_CATCH_UP_DELAY_MS);
    expect(nightly).not.toHaveBeenCalled();
  });

  it('a failing catch-up raises the same backup_failed alert as the nightly cron', () => {
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const boom = new Error('ENOSPC: no space left on device');
    vi.spyOn(backupModule, 'runNightlyJob').mockImplementation(() => {
      throw boom;
    });
    const raise = vi.spyOn(raiseModule, 'raiseBackupFailed').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduleBackupCatchUp(BOOT);
    vi.advanceTimersByTime(BACKUP_CATCH_UP_DELAY_MS);
    expect(raise).toHaveBeenCalledWith({ error: boom, at: new Date(BOOT.getTime() + BACKUP_CATCH_UP_DELAY_MS) });
  });

  it('a throwing check never escapes into boot', () => {
    vi.spyOn(backupModule, 'newestBackupAt').mockImplementation(() => {
      throw new Error('EACCES');
    });
    insertTestUser(current!.db, { username: 'catchup-admin', role: 'admin' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => scheduleBackupCatchUp(BOOT)).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('startScheduler asks for it once, after the boot ticks', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    const startAt = source.indexOf('export function startScheduler');
    const body = source.slice(startAt, source.indexOf('export function stopScheduler'));
    expect(body.match(/scheduleBackupCatchUp\(\);/g)).toHaveLength(1);
    expect(body.indexOf('scheduleBackupCatchUp();')).toBeGreaterThan(body.lastIndexOf('runSimplefinTick();'));
  });
});

describe('v1.64.0 (plan 2026-11-12, A10): the local AI tick', () => {
  const AT = new Date('2026-03-10T09:00:00.000Z');

  afterEach(async () => {
    await aiQueueModule.drainAiQueue();
    aiQueueModule.resetAiQueueForTests();
    vi.restoreAllMocks();
  });

  it('asks for no targets while local AI is off', () => {
    const targets = vi.spyOn(aiSuggestionsModule, 'aiMerchantTargets');
    runAiTick(AT);
    expect(targets).not.toHaveBeenCalled();
  });

  it('sweeps up to 100 targets while it is on', () => {
    const alex = insertTestUser(current!.db, { username: 'ai-admin', role: 'admin' });
    saveLocalAiConfig({ baseUrl: 'http://192.168.1.50:11434', model: 'test-model:1b', userId: alex, at: AT });
    // No target comes back, so nothing is queued and no request is made.
    const targets = vi.spyOn(aiSuggestionsModule, 'aiMerchantTargets').mockReturnValue([]);
    runAiTick(AT);
    expect(targets).toHaveBeenCalledWith(100);
  });

  it('logs a throw and never lets it escape the cron callback', () => {
    const boom = new Error('database is locked');
    vi.spyOn(aiQueueModule, 'sweepAiWork').mockImplementation(() => {
      throw boom;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => runAiTick(AT)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[ai] tick failed', boom);
  });

  it('runs in the five-minute callback and at boot, after the SimpleFIN tick each time', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    const startAt = source.indexOf('export function startScheduler');
    const body = source.slice(startAt, source.indexOf('export function stopScheduler'));
    expect(body.match(/runAiTick\(\);/g)).toHaveLength(2);
    const callback = body.slice(body.indexOf('NOTIFY_TICK_CRON,'), body.indexOf('{ timezone: tz },', body.indexOf('NOTIFY_TICK_CRON,')));
    expect(callback.indexOf('runAiTick();')).toBeGreaterThan(callback.indexOf('runSimplefinTick();'));
    expect(body.lastIndexOf('runAiTick();')).toBeGreaterThan(body.lastIndexOf('runSimplefinTick();'));
  });
});
