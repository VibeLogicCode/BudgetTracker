import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  NOTIFICATION_EVENTS,
  backupFailedKey,
  budgetExceededKey,
  budgetPaceKey,
  budgetThresholdKey,
  comingDueKey,
  duplicateChargeKey,
  eventDef,
  eventsFor,
  isChannel,
  isNotificationEventId,
  monthlyDigestKey,
  newSigninKey,
  packUpdateAvailableKey,
  predictedVsActualKey,
  restoreOutcomeKey,
  staleImportKey,
  subscriptionCreepKey,
  suggestedBudgetRefreshKey,
  syncFailedKey,
  unusualTransactionKey,
  updateAvailableKey,
  weeklyDigestKey,
} from '@/lib/notify/events';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('MUST-2.1: events.ts is pure and client-safe', () => {
  it('imports neither @/db nor @/lib/env nor any node builtin', () => {
    const source = fs.readFileSync(path.join(root, 'src/lib/notify/events.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/db/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/env/);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});

describe('the twenty-three registered events', () => {
  it('has exactly twenty-three entries with unique, well-formed ids', () => {
    // Backlog item 17 / Part 4 (preset pack version awareness): pack_update_available brought
    // this from 22 to 23, the same way each addition before it moved the count (see the >=
    // precedent lower down for events whose OWN historical contribution is what is pinned).
    expect(NOTIFICATION_EVENTS).toHaveLength(23);
    const ids = NOTIFICATION_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(23);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('matches the spec table exactly', () => {
    expect(
      NOTIFICATION_EVENTS.map((e) => [e.id, e.audience, e.trigger, e.defaultEnabled] as const),
    ).toEqual([
      ['coming_due', 'all', 'daily_slot', true],
      ['budget_threshold', 'all', 'tick', false],
      ['budget_exceeded', 'all', 'tick', true],
      ['backup_failed', 'admin', 'immediate', true],
      ['weekly_digest', 'all', 'weekly_slot', false],
      ['new_signin', 'all', 'immediate', true],
      ['password_changed', 'all', 'immediate', true],
      ['mfa_disabled', 'all', 'immediate', true],
      ['restore_outcome', 'admin', 'immediate', true],
      ['stale_import', 'all', 'daily_slot', false],
      ['update_available', 'admin', 'tick', true],
      ['budget_pace', 'all', 'daily_slot', true],
      ['unusual_transaction', 'all', 'tick', true],
      ['subscription_creep', 'all', 'daily_slot', true],
      ['duplicate_charge', 'all', 'tick', true],
      ['predicted_vs_actual', 'all', 'daily_slot', false],
      ['suggested_budget_refresh', 'all', 'daily_slot', false],
      ['sync_failed', 'admin', 'immediate', true],
      ['monthly_digest', 'all', 'daily_slot', false],
      ['savings_target_met', 'all', 'tick', true],
      ['savings_target_pace', 'all', 'daily_slot', true],
      ['savings_month_closed', 'all', 'daily_slot', true],
      ['pack_update_available', 'admin', 'tick', true],
    ]);
  });

  it('MUST-4.1: the default-on set is the wrong-or-imminent half', () => {
    const on = NOTIFICATION_EVENTS.filter((e) => e.defaultEnabled).map((e) => e.id).sort();
    expect(on).toEqual([
      'backup_failed',
      'budget_exceeded',
      'budget_pace',
      'coming_due',
      'duplicate_charge',
      'mfa_disabled',
      'new_signin',
      'pack_update_available',
      'password_changed',
      'restore_outcome',
      'savings_month_closed',
      'savings_target_met',
      'savings_target_pace',
      'subscription_creep',
      'sync_failed',
      'unusual_transaction',
      'update_available',
    ]);
  });

  it('gives every event a label and a one-sentence blurb', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.label.length).toBeGreaterThan(0);
      expect(event.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe('lookup helpers', () => {
  it('eventDef resolves a known id and returns undefined for an unknown one', () => {
    expect(eventDef('coming_due')?.label).toBe('Something is coming due');
    expect(eventDef('on_pace_overshoot')).toBeUndefined();
    expect(isNotificationEventId('coming_due')).toBe(true);
    expect(isNotificationEventId('on_pace_overshoot')).toBe(false);
  });

  it('MUST-4.3: eventsFor("member") excludes both admin events', () => {
    expect(eventsFor('member').map((e) => e.id)).not.toContain('backup_failed');
    expect(eventsFor('member').map((e) => e.id)).not.toContain('restore_outcome');
    // v1.12.1 (item AA / SEC-4): password_changed and mfa_disabled are both audience 'all',
    // so they widen both counts by two. v1.17.0's three savings_* events (also all audience
    // 'all') widen both counts by three more.
    // pack_update_available (backlog item 17 / Part 4) is audience 'admin' too, so it widens only
    // the admin count, same as backup_failed/restore_outcome/sync_failed above it.
    expect(eventsFor('member')).toHaveLength(18);
    expect(eventsFor('admin')).toHaveLength(23);
  });

  it('exposes the two channels', () => {
    expect(CHANNELS).toEqual(['telegram', 'email']);
    expect(isChannel('telegram')).toBe(true);
    expect(isChannel('sms')).toBe(false);
  });
});

describe('MUST-3.11: the exact dedup key strings', () => {
  it('builds every key shape in the table', () => {
    expect(comingDueKey(42, '2026-09-01')).toBe('due:42:2026-09-01');
    expect(budgetThresholdKey('household', 7, '2026-08', 80)).toBe('budget:h:7:2026-08:80');
    expect(budgetThresholdKey('personal', 7, '2026-08', 90)).toBe('budget:p:7:2026-08:90');
    expect(budgetExceededKey('household', 7, '2026-08')).toBe('budget:h:7:2026-08:100');
    expect(budgetExceededKey('personal', 7, '2026-08')).toBe('budget:p:7:2026-08:100');
    expect(backupFailedKey('2026-08-17')).toBe('backup-failed:2026-08-17');
    expect(weeklyDigestKey('2026-08-17')).toBe('digest:2026-08-17');
    expect(newSigninKey('2026-08-17T12:00:00.000Z')).toBe('signin:2026-08-17T12:00:00.000Z');
    expect(restoreOutcomeKey('2026-08-17T12:00:00.000Z')).toBe('restore:2026-08-17T12:00:00.000Z');
    // v1.13.0 ruling R14: the key now carries the account id (item AM / PROD-10).
    expect(staleImportKey('2026-08-17', 4)).toBe('stale:2026-08-17:4');
  });

  it('never repeats user or channel inside the key — the unique index already carries them', () => {
    for (const key of [
      comingDueKey(42, '2026-09-01'),
      budgetThresholdKey('household', 7, '2026-08', 80),
      backupFailedKey('2026-08-17'),
    ]) {
      expect(key).not.toMatch(/telegram|email|user/);
    }
  });

  it('a threshold key and an exceeded key for the same category and month never collide', () => {
    expect(budgetThresholdKey('household', 7, '2026-08', 99)).not.toBe(budgetExceededKey('household', 7, '2026-08'));
  });

  it('household and personal are two different facts for the same category', () => {
    expect(budgetExceededKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('personal', 7, '2026-08'));
  });
});

describe('MUST-6.1: the update_available registry entry', () => {
  it('brings the registry to fifteen and is admin-audience, default-on, tick-triggered', () => {
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThanOrEqual(15);
    const entry = eventDef('update_available');
    expect(entry).toEqual({
      id: 'update_available',
      label: 'An update is available',
      blurb: 'A newer version of Budget Tracker is published and is waiting for your say-so.',
      audience: 'admin',
      trigger: 'tick',
      defaultEnabled: true,
    });
  });

  it('MUST-4.3: eventsFor(member) excludes it', () => {
    expect(eventsFor('member').some((e) => e.id === 'update_available')).toBe(false);
    expect(eventsFor('admin').some((e) => e.id === 'update_available')).toBe(true);
  });

  it('MUST-6.3: the dedup key is per version and only ever goes up', () => {
    expect(updateAvailableKey('1.4.0')).toBe('update:1.4.0');
    expect(updateAvailableKey('1.4.0')).not.toBe(updateAvailableKey('1.5.0'));
  });
});

describe('Task 8 (v1.7.0): the sync_failed registry entry', () => {
  it('brings the registry to sixteen and is admin-audience, default-on, immediate-triggered', () => {
    // >= rather than an exact count, matching the MUST-6.1 block's own precedent above: this
    // test asserts what sync_failed's OWN addition brought the registry to, not a live total
    // that every later addition (monthly_digest, here) would otherwise have to keep in sync.
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThanOrEqual(16);
    const entry = eventDef('sync_failed');
    expect(entry).toEqual({
      id: 'sync_failed',
      label: 'A SimpleFIN sync failed',
      blurb: 'The unattended sync could not finish and needs a look.',
      audience: 'admin',
      trigger: 'immediate',
      defaultEnabled: true,
    });
  });

  it('MUST-4.3: eventsFor(member) excludes it', () => {
    expect(eventsFor('member').some((e) => e.id === 'sync_failed')).toBe(false);
    expect(eventsFor('admin').some((e) => e.id === 'sync_failed')).toBe(true);
  });

  it('keys once per calendar day and never repeats the user or channel', () => {
    expect(syncFailedKey('2026-08-22')).toBe('sync-failed:2026-08-22');
    expect(syncFailedKey('2026-08-22')).not.toBe(syncFailedKey('2026-08-23'));
    expect(syncFailedKey('2026-08-22')).not.toMatch(/telegram|email|user/);
  });

  it('never collides with backup_failed, which uses the same day-keyed shape', () => {
    expect(syncFailedKey('2026-08-17')).not.toBe(backupFailedKey('2026-08-17'));
  });
});

describe('spec section 9: the six predictive dedup keys', () => {
  it('builds every key shape in the table', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).toBe('pace:h:7:2026-08');
    expect(budgetPaceKey('personal', 7, '2026-08')).toBe('pace:p:7:2026-08');
    expect(unusualTransactionKey(4211)).toBe('unusual:4211');
    expect(subscriptionCreepKey(4211)).toBe('creep:4211');
    expect(duplicateChargeKey(31, 44)).toBe('dupe:31:44');
    expect(predictedVsActualKey('2026-07')).toBe('predvs:2026-07');
    expect(suggestedBudgetRefreshKey('2026-08')).toBe('suggest:2026-08');
  });

  it('MUST-9.22: a duplicate pair keys the same way whichever row the scan reaches first', () => {
    expect(duplicateChargeKey(44, 31)).toBe(duplicateChargeKey(31, 44));
  });

  it('a pace key never collides with a threshold or an exceeded key', () => {
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetExceededKey('household', 7, '2026-08'));
    expect(budgetPaceKey('household', 7, '2026-08')).not.toBe(budgetThresholdKey('household', 7, '2026-08', 80));
  });

  it('carries neither the user nor the channel, which the unique index already holds', () => {
    for (const key of [budgetPaceKey('personal', 7, '2026-08'), unusualTransactionKey(1), predictedVsActualKey('2026-07')]) {
      expect(key).not.toMatch(/telegram|email|user/);
    }
  });
});

describe('Task 16 (v1.7.0): the monthly_digest registry entry', () => {
  it('brings the registry to seventeen and is all-audience, default-off, daily_slot-triggered', () => {
    // v1.12.1 (item AA / SEC-4): password_changed and mfa_disabled, added after this one,
    // brought the live total further to 19; v1.17.0's three savings_* events bring it to 22, and
    // backlog item 17 / Part 4's pack_update_available brings it to 23 -- this assertion tracks
    // the current total, not monthly_digest's own historical contribution (see the >= pattern
    // used above for update_available/sync_failed, which exists for exactly this reason).
    expect(NOTIFICATION_EVENTS).toHaveLength(23);
    const entry = eventDef('monthly_digest');
    expect(entry).toEqual({
      id: 'monthly_digest',
      label: 'Monthly household summary',
      blurb: 'Income, spending and budgets for the month that just ended.',
      audience: 'all',
      trigger: 'daily_slot',
      defaultEnabled: false,
    });
  });

  it('MUST-4.3: audience "all" means both member and admin see it', () => {
    expect(eventsFor('member').some((e) => e.id === 'monthly_digest')).toBe(true);
    expect(eventsFor('admin').some((e) => e.id === 'monthly_digest')).toBe(true);
  });

  it('keys once per reported month, ever, and never repeats the user or channel', () => {
    expect(monthlyDigestKey('2026-07')).toBe('monthly-digest:2026-07');
    expect(monthlyDigestKey('2026-07')).not.toBe(monthlyDigestKey('2026-08'));
    expect(monthlyDigestKey('2026-07')).not.toMatch(/telegram|email|user/);
  });

  it('never collides with weeklyDigestKey, which uses a similarly-named prefix', () => {
    expect(monthlyDigestKey('2026-07')).not.toBe(weeklyDigestKey('2026-07-01'));
    expect(monthlyDigestKey('2026-07-01')).not.toBe(weeklyDigestKey('2026-07-01'));
  });
});

describe('backlog item 17 / Part 4: the pack_update_available registry entry', () => {
  it('brings the registry to twenty-three and is admin-audience, default-on, tick-triggered -- modelled on update_available', () => {
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThanOrEqual(23);
    const entry = eventDef('pack_update_available');
    expect(entry).toEqual({
      id: 'pack_update_available',
      label: 'A merchant rules pack update is available',
      blurb: 'A merchant rules pack you installed (e.g. the Canadian pack) has a newer version published.',
      audience: 'admin',
      trigger: 'tick',
      defaultEnabled: true,
    });
  });

  it('MUST-4.3: eventsFor(member) excludes it', () => {
    expect(eventsFor('member').some((e) => e.id === 'pack_update_available')).toBe(false);
    expect(eventsFor('admin').some((e) => e.id === 'pack_update_available')).toBe(true);
  });

  it('the dedup key is per (pack, version) and only ever goes up, and never collides with updateAvailableKey', () => {
    expect(packUpdateAvailableKey('canadian-merchants', 1)).toBe('pack-update:canadian-merchants:1');
    expect(packUpdateAvailableKey('canadian-merchants', 1)).not.toBe(packUpdateAvailableKey('canadian-merchants', 2));
    expect(packUpdateAvailableKey('canadian-merchants', 1)).not.toBe(updateAvailableKey('1'));
    expect(packUpdateAvailableKey('canadian-merchants', 1)).not.toMatch(/telegram|email|user/);
  });
});
