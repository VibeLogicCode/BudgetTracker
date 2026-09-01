import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { saveSmtp } from '@/lib/notify/config';
import {
  deleteHouseholdTarget,
  householdEventPrefs,
  householdTarget,
  upsertHouseholdTarget,
} from '@/lib/notify/household';
import { resetNotifyRateLimitsForTests } from '@/lib/notify/ratelimit';
import { resetNotifySenderForTests, setNotifySenderForTests, NotifyError } from '@/lib/notify/send';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';

/**
 * v1.28.0 Lane 2: the family (household) channel actions in
 * src/app/(app)/settings/notifications/actions.ts. Mirrors notifications-actions.test.ts's own
 * setup (real database, real household.ts, a mocked session/headers pair) rather than mocking
 * @/lib/notify/household -- that module is now real (it landed mid-task from the concurrent
 * lane this page's brief named), so exercising it for real is a stronger guarantee than
 * asserting mock-call shapes against a contract that might drift.
 */

const TOKEN = '123456789:AAHk3f-EXAMPLE-tokenxxxxxxxxxxxxxxxxxx';

const headerBag = vi.hoisted(() => ({ value: new Headers({ host: 'budget.local', origin: 'http://budget.local' }) }));
const currentUser = vi.hoisted(() => ({ value: { id: 0, name: 'Alex', username: 'alex', role: 'admin' as 'admin' | 'member' } }));

vi.mock('next/headers', () => ({ headers: async () => headerBag.value }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
  requireAdmin: async () => {
    if (currentUser.value.role !== 'admin') throw new Error('forbidden');
    return currentUser.value;
  },
}));

const actions = await import('@/app/(app)/settings/notifications/actions');

let t: TestDb;

function relay(): void {
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'relay@example.com',
    password: 'xsmtpsib-not-a-real-key',
    fromEmail: 'relay@example.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

beforeEach(() => {
  t = createTestDb();
  currentUser.value = {
    id: insertTestUser(t.db, { role: 'admin', username: 'alex', name: 'Alex' }),
    name: 'Alex',
    username: 'alex',
    role: 'admin',
  };
  headerBag.value = new Headers({ host: 'budget.local', origin: 'http://budget.local' });
  resetNotifyRateLimitsForTests();
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetNotifyRateLimitsForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

describe('MUST-12.1-style: cross-origin is refused before auth, validation or the database, for every household action', () => {
  it('refuses all six', async () => {
    headerBag.value = new Headers({ host: 'budget.local', origin: 'http://evil.example' });
    const empty = form({});
    const results = [
      await actions.saveHouseholdTelegramTargetAction({}, empty),
      await actions.saveHouseholdEmailTargetAction({}, empty),
      await actions.removeHouseholdTargetAction(empty),
      await actions.testHouseholdTargetAction(empty),
      await actions.saveHouseholdPreferencesAction({}, empty),
      await actions.detectHouseholdTelegramChatIdAction(),
    ];
    expect(results).toHaveLength(6);
    for (const result of results) expect(result.error).toBe('Cross-origin request rejected');
    expect(householdTarget('telegram')).toBeNull();
    expect(householdTarget('email')).toBeNull();
  });
});

describe('the admin gate: every household action refuses a member', () => {
  it('rejects a member on all six', async () => {
    currentUser.value.role = 'member';
    await expect(actions.saveHouseholdTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: TOKEN }))).rejects.toThrow();
    await expect(actions.saveHouseholdEmailTargetAction({}, form({ destination: 'family@example.com' }))).rejects.toThrow();
    await expect(actions.removeHouseholdTargetAction(form({ channel: 'email' }))).rejects.toThrow();
    await expect(actions.testHouseholdTargetAction(form({ channel: 'email' }))).rejects.toThrow();
    await expect(actions.saveHouseholdPreferencesAction({}, form({}))).rejects.toThrow();
    await expect(actions.detectHouseholdTelegramChatIdAction()).rejects.toThrow();
  });
});

describe('saveHouseholdTelegramTargetAction calls upsertHouseholdTarget, and never returns the token', () => {
  it('creates the household Telegram target as scope=household, user_id=null', async () => {
    const result = await actions.saveHouseholdTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: TOKEN }));
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('AAHk3f');

    const stored = householdTarget('telegram');
    expect(stored?.scope).toBe('household');
    expect(stored?.userId).toBeNull();
    expect(stored?.destination).toBe('-1001234567890');
    expect(stored?.secretSet).toBe(true);
  });

  it('a blank bot token on a first save is refused with the library\'s own reason', async () => {
    const result = await actions.saveHouseholdTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: '' }));
    expect(result.error).toBe('A family Telegram channel needs its own bot token.');
    expect(householdTarget('telegram')).toBeNull();
  });

  it('a blank bot token on an update keeps the stored one (MUST-5.6)', async () => {
    await actions.saveHouseholdTelegramTargetAction({}, form({ destination: '-1001234567890', botToken: TOKEN }));
    const result = await actions.saveHouseholdTelegramTargetAction({}, form({ destination: '-1009999999999', botToken: '' }));
    expect(result.error).toBeUndefined();
    const stored = householdTarget('telegram');
    expect(stored?.destination).toBe('-1009999999999');
    expect(stored?.secretSet).toBe(true);
  });

  it('rejects a malformed chat id and a malformed token', async () => {
    expect((await actions.saveHouseholdTelegramTargetAction({}, form({ destination: 'not-a-number', botToken: TOKEN }))).error).toBeDefined();
    expect((await actions.saveHouseholdTelegramTargetAction({}, form({ destination: '5551234', botToken: 'nope' }))).error).toBeDefined();
  });
});

describe('saveHouseholdEmailTargetAction calls upsertHouseholdTarget', () => {
  it('creates the household email target', async () => {
    const result = await actions.saveHouseholdEmailTargetAction({}, form({ destination: 'family@example.com' }));
    expect(result.error).toBeUndefined();
    const stored = householdTarget('email');
    expect(stored?.destination).toBe('family@example.com');
    expect(stored?.scope).toBe('household');
    expect(stored?.userId).toBeNull();
  });

  it('rejects a malformed address', async () => {
    expect((await actions.saveHouseholdEmailTargetAction({}, form({ destination: 'not-an-address' }))).error).toBeDefined();
  });
});

describe('removeHouseholdTargetAction calls deleteHouseholdTarget', () => {
  it('deletes the real household row for the given channel only', async () => {
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    upsertHouseholdTarget({ channel: 'telegram', destination: '-1001234567890', secret: TOKEN, actorUserId: currentUser.value.id });

    const result = await actions.removeHouseholdTargetAction(form({ channel: 'email' }));
    expect(result.error).toBeUndefined();
    expect(householdTarget('email')).toBeNull();
    // The other channel survives.
    expect(householdTarget('telegram')).not.toBeNull();
  });
});

describe('testHouseholdTargetAction: the family channel test-send path', () => {
  it('email: sends via the shared relay to the family address and records the outcome', async () => {
    relay();
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    const sent: string[] = [];
    setNotifySenderForTests(async (request) => {
      sent.push(request.destination);
    });
    const result = await actions.testHouseholdTargetAction(form({ channel: 'email' }));
    expect(result.error).toBeUndefined();
    expect(sent).toEqual(['family@example.com']);
    expect(householdTarget('email')?.verifiedAt).not.toBeNull();
  });

  it('email: refused with the shared "no relay" sentence when the relay is not set up', async () => {
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    const result = await actions.testHouseholdTargetAction(form({ channel: 'email' }));
    expect(result.error).toBe('An admin needs to set up outbound email before this can send.');
  });

  it('refuses with "Set this channel up first." when no family channel of that kind exists, and spends no quota', async () => {
    let calls = 0;
    setNotifySenderForTests(async () => {
      calls += 1;
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await actions.testHouseholdTargetAction(form({ channel: 'telegram' }))).error).toBe('Set this channel up first.');
    }
    expect(calls).toBe(0);
  });

  it('surfaces a transport failure and does not verify', async () => {
    relay();
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    setNotifySenderForTests(async () => {
      throw new NotifyError('550 rejected', { permanent: true, scope: 'relay' });
    });
    const result = await actions.testHouseholdTargetAction(form({ channel: 'email' }));
    expect(result.error).toContain('550 rejected');
    expect(householdTarget('email')?.verifiedAt).toBeNull();
  });
});

describe('saveHouseholdPreferencesAction calls setHouseholdEventPref, one call per eligible event per configured channel', () => {
  it('writes a routed pref only for the configured channel', async () => {
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    const result = await actions.saveHouseholdPreferencesAction({}, form({ 'household-pref:coming_due:email': 'on' }));
    expect(result.error).toBeUndefined();

    const prefs = householdEventPrefs();
    expect(prefs.coming_due?.email).toBe(true);
    // Telegram was never configured, so it is never written, matching the personal matrix's
    // own "an unconfigured channel is never touched" rule (savePreferencesAction).
    expect(prefs.coming_due?.telegram).toBe(false);
  });

  it('unchecking a previously-routed event deletes the row (sparse storage, like applyPref)', async () => {
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    await actions.saveHouseholdPreferencesAction({}, form({ 'household-pref:coming_due:email': 'on' }));
    expect(householdEventPrefs().coming_due?.email).toBe(true);

    await actions.saveHouseholdPreferencesAction({}, form({}));
    expect(householdEventPrefs().coming_due?.email).toBe(false);
  });

  it('a security event forged into the form is never routed, even with a configured channel', async () => {
    upsertHouseholdTarget({ channel: 'email', destination: 'family@example.com', actorUserId: currentUser.value.id });
    const result = await actions.saveHouseholdPreferencesAction({}, form({ 'household-pref:new_signin:email': 'on' }));
    expect(result.error).toBeUndefined();
    expect(householdEventPrefs().new_signin).toBeUndefined();
    const row = t.sqlite
      .prepare(`select 1 from notification_household_prefs where event_id = 'new_signin'`)
      .get();
    expect(row).toBeUndefined();
  });

  it('a knobs-only save with no configured channel writes nothing', async () => {
    const result = await actions.saveHouseholdPreferencesAction({}, form({ 'household-pref:coming_due:email': 'on' }));
    expect(result.error).toBeUndefined();
    const { n } = t.sqlite.prepare('select count(*) as n from notification_household_prefs').get() as { n: number };
    expect(n).toBe(0);
  });
});

describe('detectHouseholdTelegramChatIdAction: the household mirror of detectTelegramChatIdAction', () => {
  it('refuses with the exact sentence when no household token is saved', async () => {
    const result = await actions.detectHouseholdTelegramChatIdAction();
    expect(result.error).toBe('Save your bot token first.');
  });
});
