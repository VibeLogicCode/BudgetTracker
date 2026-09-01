import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setUserActive, setUserVisibility } from '@/lib/auth/users';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { saveEmailTarget, saveSmtp, saveTelegramTarget, setPref } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

/**
 * v1.28.0 Lane 1, Task 4: "showing household level spend to each member spend rather then just
 * your spend". The family channel's digest names every member, adds the unattributed pile, and
 * adds up to the household total; every personal digest is untouched.
 */
const FAMILY_TOKEN = '888800001:AAFAMILY-invented-token-never-a-real-one';
const FAMILY_CHAT = '-1009876543210';
const NOW = new Date('2026-08-17T09:00:00Z');
/** A Monday. The window is [slot − 7, slot − 1] = 2026-08-10 .. 2026-08-16. */
const SLOT = '2026-08-17';

let t: TestDb;
let accountId: number;
let creatorId: number;
let groceries: number;

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  creatorId = insertTestUser(t.db, { username: 'creator', name: 'Creator' });
  groceries = categoryIdByName(t.db, 'Groceries');
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
  saveSmtp({
    preset: 'brevo',
    host: 'smtp-relay.brevo.com',
    port: 587,
    security: 'starttls',
    username: 'me@example.invalid',
    password: 'pw',
    fromEmail: 'me@example.invalid',
    fromName: 'Budget Tracker',
    enabled: true,
  });
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function person(name: string, role: 'admin' | 'member' = 'admin'): number {
  const userId = insertTestUser(t.db, { name, role, username: name.toLowerCase() });
  saveEmailTarget({ userId, destination: `${name.toLowerCase()}@example.invalid`, enabled: true });
  saveTelegramTarget({ userId, destination: `5550${userId}`, botToken: `${userId}00001:AA-invented-token`, enabled: true });
  setPref(userId, 'weekly_digest', 'email', true);
  setPref(userId, 'weekly_digest', 'telegram', true);
  return userId;
}

function spend(cents: number, attributedUserId: number | null, merchant = 'LOBLAWS', date = '2026-08-12'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${merchant}, ${normalizeMerchant(merchant)}, ${groceries},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-12T00:00:00.000Z'}, ${'2026-08-12T00:00:00.000Z'})`,
  );
}

function familyTelegram(actorUserId: number): void {
  expect(
    upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId }).ok,
  ).toBe(true);
  expect(setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'telegram', enabled: true }).ok).toBe(true);
}

interface Row {
  user_id: number | null;
  channel: string;
  dedup_key: string;
  subject: string;
  body: string;
}

function rows(): Row[] {
  return t.sqlite
    .prepare('select user_id, channel, dedup_key, subject, body from notification_outbox order by id')
    .all() as Row[];
}

function householdRow(): Row {
  const found = rows().find((row) => row.user_id === null);
  if (!found) throw new Error('no household digest was enqueued');
  return found;
}

describe('the household digest names members', () => {
  it('names each member, includes unattributed, and adds up to the household total', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    familyTelegram(alex);
    spend(70000, alex);
    spend(43456, robin);
    spend(10000, null); // nobody has claimed this one

    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });

    const { subject, body } = householdRow();
    expect(subject).toBe('Household weekly summary — 2026-08-10 to 2026-08-16');
    expect(body).toContain('Household spend: $1,234.56');
    expect(body).toContain('Who spent it');
    expect(body).toMatch(/Alex\s+\$700\.00/);
    expect(body).toMatch(/Robin\s+\$434\.56/);
    // The line that matters in a joint household: the money nobody has claimed.
    expect(body).toMatch(/Unattributed\s+\$100\.00/);
    // 700.00 + 434.56 + 100.00 = 1,234.56, and the partition is exact by construction:
    // attributed_user_id is either a member's id or NULL, and those are exhaustive.
    expect(70000 + 43456 + 10000).toBe(123456);
    // It is a group message, so there is no "you" in it.
    expect(body).not.toContain('Your spend');
  });

  it('names an active member who spent nothing, and a deactivated one only if they did', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    const sam = person('Sam', 'member');
    familyTelegram(alex);
    spend(5000, alex);
    spend(2500, sam);
    setUserActive(sam, false); // deactivated AFTER spending: the money is still household money

    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });
    const { body } = householdRow();
    expect(body).toMatch(/Alex\s+\$50\.00/);
    // Robin is active and spent nothing: "$0.00" is information, and their absence would not be.
    expect(body).toMatch(/Robin\s+\$0\.00/);
    // Sam is gone but their $25 is not, so leaving them out would quietly break the addition.
    expect(body).toMatch(/Sam\s+\$25\.00/);
    expect(body).toContain('Household spend: $75.00');
  });

  it('is one message however many members fire, and however differently they set their weekday', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    familyTelegram(alex);
    spend(1000, alex);

    // Alex's slot is the Monday; Robin's is the Thursday of the SAME week. The personal key
    // carries the slot date, so wrapping it would have produced two family digests this week.
    evaluateWeeklyDigest({ userId: alex, slotDate: '2026-08-17', now: NOW });
    evaluateWeeklyDigest({ userId: robin, slotDate: '2026-08-20', now: NOW });

    const household = rows().filter((row) => row.user_id === null);
    expect(household, 'the group chat got a second digest for the same week').toHaveLength(1);
    expect(household[0].dedup_key).toBe('hh:digest-week:2026-08-17');
    // Only Telegram is routed here, so both still received their own personal EMAIL digest --
    // one family message, two personal ones, no duplicate anywhere.
    expect(rows().filter((row) => row.channel === 'email').map((row) => row.user_id).sort()).toEqual(
      [alex, robin].sort(),
    );

    // The following week is a new key and a new digest.
    evaluateWeeklyDigest({ userId: alex, slotDate: '2026-08-24', now: new Date('2026-08-24T09:00:00Z') });
    expect(rows().filter((row) => row.user_id === null).map((row) => row.dedup_key)).toEqual([
      'hh:digest-week:2026-08-17',
      'hh:digest-week:2026-08-24',
    ]);
  });
});

describe("a member's own settings cannot change the family digest", () => {
  it('renders the household total even when the firing member is self-scoped', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    familyTelegram(alex);
    spend(70000, alex);
    spend(30000, robin);
    // Ruling R2 forces a self-visibility viewer to their own rows for everything rendered FOR
    // them. The family digest is not rendered for anybody in particular, so it must not move.
    setUserVisibility(robin, 'self');

    evaluateWeeklyDigest({ userId: robin, slotDate: SLOT, now: NOW });
    const { body } = householdRow();
    expect(body).toContain('Household spend: $1,000.00');
    expect(body).toMatch(/Alex\s+\$700\.00/);
    expect(body).toMatch(/Robin\s+\$300\.00/);
  });

  it('produces the same family digest whichever member fires it', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    setUserVisibility(robin, 'self');
    familyTelegram(alex);
    spend(70000, alex);
    spend(30000, robin);

    evaluateWeeklyDigest({ userId: robin, slotDate: SLOT, now: NOW });
    const fromRobin = householdRow().body;

    // A second household, identical but for who fires first.
    t.sqlite.prepare('delete from notification_outbox').run();
    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });
    expect(householdRow().body).toBe(fromRobin);
  });
});

describe('a personal digest is unchanged', () => {
  it('is byte-for-byte what it was before any family channel existed', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    spend(70000, alex);
    spend(43456, robin);
    spend(10000, null);

    // 1. No household anything.
    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });
    const before = rows().filter((row) => row.user_id === alex);
    expect(before).toHaveLength(2);
    const beforeBody = before[0].body;
    const beforeSubject = before[0].subject;

    // 2. A family Telegram, with the digest routed to it. Alex's EMAIL digest is not routed and
    //    must be the identical string -- not "similar", not "still correct": identical.
    t.sqlite.prepare('delete from notification_outbox').run();
    familyTelegram(alex);
    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });

    const after = rows();
    const personal = after.filter((row) => row.user_id === alex);
    expect(personal.map((row) => row.channel)).toEqual(['email']);
    expect(personal[0].subject).toBe(beforeSubject);
    expect(personal[0].body).toBe(beforeBody);
    expect(beforeBody).toContain('Your spend:');

    // ...and the Telegram copy went to the family channel instead of to Alex.
    expect(after.filter((row) => row.channel === 'telegram').map((row) => row.user_id)).toEqual([null]);
  });

  it('sends nothing personally on a channel the family channel has taken', () => {
    const alex = person('Alex');
    const robin = person('Robin', 'member');
    familyTelegram(alex);
    expect(
      upsertHouseholdTarget({ channel: 'email', destination: 'family@example.invalid', actorUserId: alex }).ok,
    ).toBe(true);
    setHouseholdEventPref({ eventId: 'weekly_digest', channel: 'email', enabled: true });
    spend(1000, alex);

    evaluateWeeklyDigest({ userId: alex, slotDate: SLOT, now: NOW });
    evaluateWeeklyDigest({ userId: robin, slotDate: SLOT, now: NOW });

    // Decision 4: the family channel REPLACES the personal one. Two members, two channels, two
    // messages in total -- one per family channel, none to anybody personally.
    expect(rows().map((row) => [row.channel, row.user_id])).toEqual([
      ['telegram', null],
      ['email', null],
    ]);
  });
});
