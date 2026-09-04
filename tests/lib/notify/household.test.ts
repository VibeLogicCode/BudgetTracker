import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import {
  EMAIL_SECRET_REFUSED,
  NOT_ADMIN_ERROR,
  NOT_HOUSEHOLD_ELIGIBLE,
  NO_DESTINATION_ERROR,
  TELEGRAM_SECRET_REQUIRED,
  deleteHouseholdTarget,
  getHouseholdTelegramToken,
  householdEventPrefs,
  householdRoutedChannels,
  householdTarget,
  isHouseholdRouted,
  listHouseholdTargets,
  setHouseholdEventPref,
  upsertHouseholdTarget,
} from '@/lib/notify/household';
import { hasAnyEnabledTarget, saveEmailTarget, saveSmtp, saveTelegramTarget, setPref } from '@/lib/notify/config';
import { householdEligibleEvents, householdWeeklyDigestKey, isHouseholdEligible } from '@/lib/notify/events';
import {
  HOUSEHOLD_INELIGIBLE_ERROR,
  drainOutboxForTests,
  enqueue,
  listRecentDeliveries,
  pumpOutbox,
  resetOutboxPumpForTests,
} from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests, type DeliveryRequest } from '@/lib/notify/send';

/**
 * v1.28.0 Lane 1. The household channel: one family Telegram and one family email, per-event
 * routing an admin controls, and the suppression rule that makes a routed event ONE message in
 * the group chat instead of one per member.
 *
 * The tokens below are invented and syntactically shaped like the real thing on purpose: the
 * leak assertions are only worth anything if the string they hunt for is the shape a real bot
 * token has (a numeric bot id, a colon, then the secret half).
 */
const FAMILY_TOKEN = '888800001:AAFAMILY-invented-token-never-a-real-one';
const ALEX_TOKEN = '111100002:AAALEX-invented-token-never-a-real-one';
const FAMILY_CHAT = '-1009876543210';

let t: TestDb;
let sent: DeliveryRequest[];
let logged: string[];

beforeEach(() => {
  t = createTestDb();
  sent = [];
  logged = [];
  resetOutboxPumpForTests();
  setNotifySenderForTests(async (request) => {
    sent.push(request);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function relay(): void {
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.invalid',
    password: 'relay-pw',
    fromEmail: 'me@example.invalid',
    fromName: 'Budget Tracker',
    enabled: true,
  });
}

/** A member with both personal channels live and the weekly digest switched on for both. */
function member(over: { role?: 'admin' | 'member'; name?: string; token?: string } = {}): number {
  const userId = insertTestUser(t.db, {
    role: over.role ?? 'admin',
    name: over.name ?? 'Alex',
    username: `u${Math.random().toString(36).slice(2, 8)}`,
  });
  saveEmailTarget({ userId, destination: `${userId}@example.invalid`, enabled: true });
  saveTelegramTarget({ userId, destination: `5550${userId}`, botToken: over.token ?? ALEX_TOKEN, enabled: true });
  setPref(userId, 'weekly_digest', 'email', true);
  setPref(userId, 'weekly_digest', 'telegram', true);
  return userId;
}

function familyChannels(actorUserId: number): void {
  expect(upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId }).ok).toBe(true);
  expect(upsertHouseholdTarget({ channel: 'email', destination: 'family@example.invalid', actorUserId }).ok).toBe(true);
}

function outbox(): { user_id: number | null; channel: string; event_id: string; dedup_key: string; subject: string }[] {
  return t.sqlite
    .prepare('select user_id, channel, event_id, dedup_key, subject from notification_outbox order by id')
    .all() as { user_id: number | null; channel: string; event_id: string; dedup_key: string; subject: string }[];
}

describe('the household target API', () => {
  it('creates exactly one row per channel and reuses it on re-save', () => {
    const admin = member();
    const first = upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId: admin });
    expect(first.ok).toBe(true);
    const again = upsertHouseholdTarget({ channel: 'telegram', destination: '-1001111111', actorUserId: admin });
    expect(again).toEqual(first); // the same id: an update, never a second family Telegram
    expect(listHouseholdTargets()).toHaveLength(1);
    expect(householdTarget('telegram')?.destination).toBe('-1001111111');
    expect(householdTarget('email')).toBeNull();
  });

  it('MUST-5.6: re-saving without a token keeps the stored one', () => {
    const admin = member();
    upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId: admin });
    upsertHouseholdTarget({ channel: 'telegram', destination: '-1002222222', actorUserId: admin });
    expect(getHouseholdTelegramToken()).toBe(FAMILY_TOKEN);
  });

  it('never returns the token, only whether one is set', () => {
    const admin = member();
    familyChannels(admin);
    const rows = listHouseholdTargets();
    // The type has no field for it; this asserts the VALUE cannot appear either, whatever a
    // future field is called.
    expect(JSON.stringify(rows)).not.toContain(FAMILY_TOKEN);
    expect(rows.find((r) => r.channel === 'telegram')?.secretSet).toBe(true);
    expect(rows.find((r) => r.channel === 'email')?.secretSet).toBe(false);
    expect(rows.every((r) => r.userId === null && r.scope === 'household')).toBe(true);
    expect(rows.find((r) => r.channel === 'telegram')?.createdByUserId).toBe(admin);
  });

  it('refuses a member, an empty destination, a tokenless Telegram and a secret-carrying email', () => {
    const admin = member();
    const plain = member({ role: 'member', name: 'Robin' });
    expect(upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId: plain })).toEqual({
      ok: false,
      reason: NOT_ADMIN_ERROR,
    });
    expect(upsertHouseholdTarget({ channel: 'email', destination: '   ', actorUserId: admin })).toEqual({
      ok: false,
      reason: NO_DESTINATION_ERROR,
    });
    // Refused here rather than left to fail the SQL pairing CHECK, which would reach the admin
    // as a stack trace.
    expect(upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, actorUserId: admin })).toEqual({
      ok: false,
      reason: TELEGRAM_SECRET_REQUIRED,
    });
    expect(upsertHouseholdTarget({ channel: 'email', destination: 'f@example.invalid', secret: 'x', actorUserId: admin })).toEqual({
      ok: false,
      reason: EMAIL_SECRET_REFUSED,
    });
    expect(listHouseholdTargets()).toEqual([]);
  });

  it('deletes a family channel and leaves the routing choice remembered', () => {
    const admin = member();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    expect(deleteHouseholdTarget('telegram')).toBe(true);
    expect(deleteHouseholdTarget('telegram')).toBe(false);
    expect(householdTarget('telegram')).toBeNull();
    // The route survives the channel, so re-adding the Telegram restores what the admin chose;
    // but with no target it routes nothing, so delivery falls straight back to personal.
    expect(householdEventPrefs().weekly_digest.telegram).toBe(true);
    expect(isHouseholdRouted('weekly_digest', 'telegram')).toBe(false);
  });
});

describe('event eligibility is a rule, not a default', () => {
  it('refuses to route an ineligible event at the write path', () => {
    for (const eventId of ['new_signin', 'password_changed', 'mfa_disabled', 'backup_failed', 'sync_failed']) {
      expect(setHouseholdEventPref({ eventId, channel: 'telegram', enabled: true })).toEqual({
        ok: false,
        reason: NOT_HOUSEHOLD_ELIGIBLE,
      });
    }
    expect(setHouseholdEventPref({ eventId: 'not_an_event', channel: 'email', enabled: true }).ok).toBe(false);
    const rows = t.sqlite.prepare('select count(*) as n from notification_household_prefs').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('stores prefs sparsely and reports only eligible events', () => {
    expect(setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true }).ok).toBe(true);
    const prefs = householdEventPrefs();
    expect(prefs.weekly_digest).toEqual({ telegram: true, email: false });
    expect(Object.keys(prefs).sort()).toEqual(householdEligibleEvents().map((e) => e.id).sort());
    expect(prefs.new_signin, 'an ineligible event has no place in the matrix').toBeUndefined();

    // Switching a route back off DELETES the row, so an absent table means what a fresh install
    // means (applyPref's rule, applied to the household matrix).
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: false });
    const rows = t.sqlite.prepare('select count(*) as n from notification_household_prefs').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('kills a hand-written ineligible household send at the SEND path, before any connection', async () => {
    const admin = member();
    familyChannels(admin);
    // The case the write-path guard cannot reach: a row put straight into the database file.
    t.db.run(
      sql`insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, next_attempt_at, created_at)
          values (null, 'telegram', 'new_signin', 'hh:signin:2026-09-01T00:00:00.000Z', 'New sign-in to your account',
                  'Alex signed in.', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    );
    await pumpOutbox(new Date('2026-09-01T01:00:00Z'));
    await drainOutboxForTests();

    expect(sent, 'a sign-in alert must never reach a group chat').toEqual([]);
    const row = t.sqlite.prepare('select status, last_error from notification_outbox').get() as {
      status: string;
      last_error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe(HOUSEHOLD_INELIGIBLE_ERROR);
  });

  it('never routes an event the registry does not mark eligible, even with a pref row forced in', () => {
    const admin = member();
    familyChannels(admin);
    t.db.run(
      sql`insert into notification_household_prefs (event_id, channel, enabled, updated_at)
          values ('new_signin', 'telegram', 1, '2026-09-01T00:00:00.000Z')`,
    );
    expect(isHouseholdRouted('new_signin', 'telegram')).toBe(false);
    // ...and enqueue therefore behaves exactly as it did before v1.28.0 for it.
    const result = enqueue({ userId: admin, eventId: 'new_signin', dedupKey: 'signin:x', subject: 's', body: 'b' });
    expect(result.suppressed).toEqual([]);
    expect(result.household).toEqual([]);
    expect(outbox().every((row) => row.user_id === admin)).toBe(true);
  });
});

describe('routing and suppression', () => {
  it('routes one household send and suppresses every personal one for that event', () => {
    const admin = member({ name: 'Alex' });
    relay();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'email', enabled: true });

    const result = enqueue({ userId: admin, eventId: 'weekly_digest', dedupKey: 'digest:2026-08-17', subject: 'S', body: 'B' });
    expect(result.inserted, 'no personal row survives a routed event').toEqual([]);
    expect(result.suppressed.sort()).toEqual(['email', 'telegram']);
    expect(result.household.sort()).toEqual(['email', 'telegram']);

    const rows = outbox();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.user_id === null)).toBe(true);
    expect(rows.map((row) => row.dedup_key)).toEqual(['hh:digest:2026-08-17', 'hh:digest:2026-08-17']);
  });

  it('suppresses per CHANNEL, so an unrouted channel still delivers personally', () => {
    const admin = member();
    relay();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });

    const result = enqueue({ userId: admin, eventId: 'weekly_digest', dedupKey: 'digest:2026-08-17', subject: 'S', body: 'B' });
    expect(result.suppressed).toEqual(['telegram']);
    expect(result.inserted).toEqual(['email']);
    expect(outbox().map((row) => [row.channel, row.user_id])).toEqual([
      ['telegram', null],
      ['email', admin],
    ]);
  });

  /**
   * S-18 fix round 1 (v1.30.0). familyChannelOnly's contract at the level enqueue() actually
   * decides it: the ROUTED channel still writes the household row -- the room's message, user_id
   * NULL -- and the unrouted channel writes NOTHING, where without the flag it would have written
   * this recipient's personal copy. That per-channel asymmetry is exactly why the flag lives here
   * rather than at the evaluator: gating the whole enqueue on householdRoutedChannels() instead
   * would still write the email row this test proves is withheld.
   */
  it('familyChannelOnly writes the family row and withholds the personal copy, per channel', () => {
    const admin = member({ name: 'Alex' });
    relay();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });

    const result = enqueue({
      userId: admin,
      eventId: 'weekly_digest',
      dedupKey: 'digest:2026-08-17',
      subject: 'S',
      body: 'B',
      familyChannelOnly: true,
    });
    expect(result.household).toEqual(['telegram']);
    expect(result.suppressed).toEqual(['telegram']);
    expect(result.inserted, 'the email copy this recipient would otherwise have received').toEqual([]);
    expect(outbox().map((row) => [row.channel, row.user_id])).toEqual([['telegram', null]]);
  });

  it('familyChannelOnly with nothing routed enqueues nothing at all', () => {
    const admin = member();
    relay();
    familyChannels(admin); // the channels exist; no event is routed to them

    const result = enqueue({
      userId: admin,
      eventId: 'weekly_digest',
      dedupKey: 'digest:2026-08-17',
      subject: 'S',
      body: 'B',
      familyChannelOnly: true,
    });
    expect(result).toEqual({ inserted: [], household: [], suppressed: [] });
    expect(outbox()).toEqual([]);
  });

  it('two members, same event, routed: still one message', () => {
    const alex = member({ name: 'Alex' });
    const robin = member({ role: 'member', name: 'Robin' });
    relay();
    familyChannels(alex);
    setHouseholdEventPref({ eventId: 'coming_due', channel: 'telegram', enabled: true });
    setPref(alex, 'coming_due', 'telegram', true);
    setPref(robin, 'coming_due', 'telegram', true);

    const key = 'due:4:2026-09-15';
    const first = enqueue({ userId: alex, eventId: 'coming_due', dedupKey: key, subject: 'S', body: 'B' });
    const second = enqueue({ userId: robin, eventId: 'coming_due', dedupKey: key, subject: 'S', body: 'B' });

    expect(first.household).toEqual(['telegram']);
    // The dedup index is what makes this zero, not an application-side "have we already" flag.
    expect(second.household).toEqual([]);
    expect(second.suppressed).toEqual(['telegram']);
    expect(outbox().filter((row) => row.channel === 'telegram')).toHaveLength(1);
  });

  it('an unrouted event behaves exactly as it did before v1.28.0', () => {
    const alex = member({ name: 'Alex' });
    const robin = member({ role: 'member', name: 'Robin' });
    relay();
    familyChannels(alex); // channels exist; nothing is routed to them
    setPref(alex, 'coming_due', 'telegram', true);
    setPref(robin, 'coming_due', 'telegram', true);

    enqueue({ userId: alex, eventId: 'coming_due', dedupKey: 'due:4:2026-09-15', subject: 'S', body: 'B' });
    enqueue({ userId: robin, eventId: 'coming_due', dedupKey: 'due:4:2026-09-15', subject: 'S', body: 'B' });

    const telegram = outbox().filter((row) => row.channel === 'telegram');
    expect(telegram.map((row) => row.user_id).sort()).toEqual([alex, robin].sort());
    expect(telegram.every((row) => !row.dedup_key.startsWith('hh:'))).toBe(true);
  });

  it('never routes a PERSONAL-scope fact, however the admin has set the switch', () => {
    const alex = member({ name: 'Alex' });
    const robin = member({ role: 'member', name: 'Robin' });
    familyChannels(alex);
    setHouseholdEventPref({ eventId: 'budget_exceeded', channel: 'telegram', enabled: true });
    setPref(alex, 'budget_exceeded', 'telegram', true);
    setPref(robin, 'budget_exceeded', 'telegram', true);

    // budgetExceededKey('personal', ...) carries no user id, so routed these two would collapse
    // into ONE household row and Robin's alert would vanish. Both stay personal instead.
    const key = 'budget:p:9:2026-08:100';
    const a = enqueue({ userId: alex, eventId: 'budget_exceeded', dedupKey: key, subject: 'S', body: 'B', subjectScope: 'personal' });
    const b = enqueue({ userId: robin, eventId: 'budget_exceeded', dedupKey: key, subject: 'S', body: 'B', subjectScope: 'personal' });
    expect(a.suppressed).toEqual([]);
    expect(b.suppressed).toEqual([]);
    expect(outbox().filter((row) => row.channel === 'telegram').map((row) => row.user_id).sort()).toEqual(
      [alex, robin].sort(),
    );

    // The same category at HOUSEHOLD scope is one shared fact and does route.
    const householdKey = 'budget:h:9:2026-08:100';
    const c = enqueue({ userId: alex, eventId: 'budget_exceeded', dedupKey: householdKey, subject: 'S', body: 'B', subjectScope: 'household' });
    expect(c.household).toEqual(['telegram']);
  });

  it('MUST-6.4: a household with ONLY a family channel is not dormant', () => {
    const admin = insertTestUser(t.db, { role: 'admin', username: 'solo' });
    expect(hasAnyEnabledTarget()).toBe(false);
    familyChannels(admin);
    // The dormancy bail is what stops the scheduler doing any work at all while no channel
    // exists (§1.1). A household that configured only the family channel and no personal one
    // would otherwise never be evaluated, and the group chat would stay silent for ever.
    expect(hasAnyEnabledTarget()).toBe(true);
  });

  it('a routed event needs the household channel enabled and, for email, a relay', () => {
    const admin = member();
    familyChannels(admin); // no relay configured
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'email', enabled: true });
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    expect(householdRoutedChannels('weekly_digest')).toEqual(['telegram']);
    relay();
    expect(householdRoutedChannels('weekly_digest').sort()).toEqual(['email', 'telegram']);
  });
});

describe('the send path', () => {
  // enqueue() stamps next_attempt_at from `at`, and the pump only picks up rows already due, so
  // every test below enqueues and pumps on the same fixed clock rather than the wall clock.
  const AT = new Date('2026-08-17T09:00:00Z');

  it('sends a household row to the family chat with the FAMILY bot token', async () => {
    const admin = member({ token: ALEX_TOKEN });
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    enqueue({
      userId: admin,
      eventId: 'weekly_digest',
      dedupKey: householdWeeklyDigestKey('2026-08-17'),
      subject: 'Household weekly summary',
      body: 'Household spend: $10.00',
      at: AT,
    });

    await pumpOutbox(AT);
    await drainOutboxForTests();

    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request.channel).toBe('telegram');
    expect(request.destination).toBe(FAMILY_CHAT);
    // A member's token would fail with "chat not found" even if using it were acceptable.
    expect(request.channel === 'telegram' && request.botToken).toBe(FAMILY_TOKEN);
  });

  it('records the outcome on the household row, not on a member', async () => {
    const admin = member();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    enqueue({ userId: admin, eventId: 'weekly_digest', dedupKey: 'digest:2026-08-17', subject: 'S', body: 'B', at: AT });
    await pumpOutbox(AT);
    await drainOutboxForTests();

    expect(householdTarget('telegram')?.lastSuccessAt).not.toBeNull();
    const personal = t.sqlite
      .prepare("select last_success_at from notification_targets where user_id = ? and channel = 'telegram'")
      .get(admin) as { last_success_at: string | null };
    expect(personal.last_success_at, "a member's own channel was not used and must not be marked").toBeNull();
  });

  it('never puts a bot token in a subject, a body, a log line or a stored error', async () => {
    const admin = member();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    // The realistic leak: Telegram's token is in the request URL, so any transport error that
    // echoes the URL echoes the credential (MUST-5.5).
    setNotifySenderForTests(async (request) => {
      const url = request.channel === 'telegram' ? `https://api.telegram.org/bot${request.botToken}/sendMessage` : '';
      throw new Error(`request to ${url} failed`);
    });

    enqueue({ userId: admin, eventId: 'weekly_digest', dedupKey: 'digest:2026-08-17', subject: 'S', body: 'B', at: AT });
    await pumpOutbox(AT);
    await drainOutboxForTests();

    const rows = t.sqlite.prepare('select subject, body, last_error from notification_outbox').all() as {
      subject: string;
      body: string;
      last_error: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error).toContain('[redacted]');
    for (const haystack of [
      JSON.stringify(rows),
      logged.join('\n'),
      JSON.stringify(listRecentDeliveries({ userId: null })),
      JSON.stringify(householdTarget('telegram')),
    ]) {
      expect(haystack).not.toContain(FAMILY_TOKEN);
    }
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('kills a household row whose family channel was removed before delivery', async () => {
    const admin = member();
    familyChannels(admin);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true });
    enqueue({ userId: admin, eventId: 'weekly_digest', dedupKey: 'digest:2026-08-17', subject: 'S', body: 'B', at: AT });
    deleteHouseholdTarget('telegram');

    await pumpOutbox(AT);
    await drainOutboxForTests();
    // MUST-7.5's pre-send revalidation, household side: removing the channel stops egress at
    // once, including for rows already queued.
    expect(sent).toEqual([]);
    const row = t.sqlite.prepare('select status from notification_outbox').get() as { status: string };
    expect(row.status).toBe('failed');
  });
});

describe('the registry classification', () => {
  it('marks every eligible event as audience "all"', () => {
    for (const event of householdEligibleEvents()) {
      expect(event.audience, `${event.id} is admin-only and must not be routable to a family channel`).toBe('all');
    }
  });

  it('keeps every account, session and operational event unroutable', () => {
    for (const id of [
      'new_signin',
      'password_changed',
      'mfa_disabled',
      'backup_failed',
      'restore_outcome',
      'sync_failed',
      'update_available',
    ]) {
      expect(isHouseholdEligible(id), `${id} must never be routable to a group chat`).toBe(false);
    }
  });
});
