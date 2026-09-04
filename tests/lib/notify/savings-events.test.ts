import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { setUserVisibility } from '@/lib/auth/users';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import { evaluateSavingsDaily, evaluateSavingsTargetMet } from '@/lib/notify/evaluate/savings';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { saveSavingsTarget } from '@/lib/savings-target';

/**
 * Lane 2, spec docs/superpowers/plans/2026-08-30-savings-targets.md. These three events read
 * savings_target.ts's own savingsProgress/savingsStreak (ruling T1: no second definition of
 * "saved", "met" or "streak" lives here), so every fixture below only has to set up a target and
 * some income/spend and can trust the resolved figures to be correct -- these tests are about
 * WHEN the three events fire, not what the numbers mean.
 */

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db);
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  t.cleanup();
});

function emailUser(role: 'admin' | 'member' = 'admin'): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}`, role });
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
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

/** One income (positive) or spend (negative) row, never a transfer -- ruling T1's series. */
function txn(categoryId: number, amountCents: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${amountCents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
  );
}

/** Income and spend for one month that nets to exactly $2,000 saved ($5,000 in, $3,000 out). */
function seedMetMonth(month: string): void {
  const salary = categoryIdByName(t.db, 'Salary');
  const groceries = categoryIdByName(t.db, 'Groceries');
  txn(salary, 500000, `${month}-05`);
  txn(groceries, -300000, `${month}-10`);
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('savings_target_met', () => {
  it('fires once the month first reaches its target, and not again on a later tick the same month', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 100000 });
    seedMetMonth('2026-08'); // nets $2,000, past the $1,000 target

    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(1);
    expect(keys()).toEqual(['savings-met:2026-08']);

    // A later tick the same month, net unchanged -- the dedup key already carries the month,
    // so this must be a no-op regardless of how many times it is re-evaluated.
    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-13T12:00:00Z'), tz: TZ })).toBe(0);
    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-20T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual(['savings-met:2026-08']);
  });

  it('stays silent while the target has not yet been reached', () => {
    emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 1000000 }); // $10,000, unreachable
    seedMetMonth('2026-08'); // only nets $2,000

    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('delivers the same message to every opted-in user', () => {
    const sam = emailUser();
    const alex = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 100000 });
    seedMetMonth('2026-08');

    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(2);
    const rows = t.sqlite.prepare('select user_id from notification_outbox order by user_id').all() as { user_id: number }[];
    expect(rows.map((r) => r.user_id).sort((a, b) => a - b)).toEqual([sam, alex].sort((a, b) => a - b));
  });
});

describe('savings_target_pace', () => {
  it('does not fire before day 7, even when badly behind pace', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 310000 });
    // No income at all yet -- as behind as a month can be -- but day 6 is still too early to say so.
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-06T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('stays silent once the pro-rated pace is being met', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 310000 }); // $3,100 for a 31-day month
    const salary = categoryIdByName(t.db, 'Salary');
    // Day 10 of 31: pro-rated target is 310000 * 10 / 31 = 100000 exactly. Net of 100000 is
    // right on pace, not short of it.
    txn(salary, 100000, '2026-08-08');
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-10T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('fires once net-so-far falls short of the pro-rated target, and never again that month', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 310000 });
    const salary = categoryIdByName(t.db, 'Salary');
    // Same day-10 pro-rated target of 100000, but only 40000 saved so far.
    txn(salary, 40000, '2026-08-08');

    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-10T12:00:00Z'), tz: TZ })).toBe(1);
    expect(keys()).toEqual(['savings-pace:2026-08']);

    // A later day the same month, still short of pace -- the monthly dedup key makes this a
    // no-op regardless, the same "never re-alert on a moving projection" rule budget_pace uses.
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-15T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual(['savings-pace:2026-08']);
  });
});

describe('savings_month_closed', () => {
  it('fires on day 1, 2 and 3 of the new month and not on day 4', () => {
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 100000 });
    seedMetMonth('2026-07');

    for (const day of ['01', '02', '03']) {
      const userId = emailUser();
      expect(evaluateSavingsDaily({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ })).toBe(1);
    }
    const userId = emailUser();
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-04T09:00:00Z'), tz: TZ })).toBe(0);
  });

  it('fires exactly once across days 1 through 3 for the same user', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 100000 });
    seedMetMonth('2026-07');

    let total = 0;
    for (const day of ['01', '02', '03']) {
      total += evaluateSavingsDaily({ userId, now: new Date(`2026-08-${day}T09:00:00Z`), tz: TZ });
    }
    expect(total).toBe(1);
    expect(keys()).toEqual(['savings-closed:2026-07']);
  });

  it('reports a miss as a miss, with no streak clause', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 1000000 }); // $10,000, unreachable
    seedMetMonth('2026-07'); // only nets $2,000

    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const row = t.sqlite.prepare('select subject, body from notification_outbox limit 1').get() as {
      subject: string;
      body: string;
    };
    expect(row.subject).toBe('Savings target missed: July 2026');
    expect(row.body).not.toContain('month running');
  });

  it('carries the streak: three months running reads as "3rd month running"', () => {
    const userId = emailUser();
    for (const month of ['2026-05', '2026-06', '2026-07']) {
      saveSavingsTarget({ month, mode: 'amount', value: 100000 });
      seedMetMonth(month);
    }

    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const row = t.sqlite.prepare('select subject, body from notification_outbox limit 1').get() as {
      subject: string;
      body: string;
    };
    expect(row.subject).toBe('Savings target met: July 2026');
    expect(row.body).toContain('This is the 3rd month running.');
  });

  it('does not mention a streak for a single month with no prior one', () => {
    const userId = emailUser();
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 100000 });
    seedMetMonth('2026-07');
    // June has no target at all, so the streak stops there: July alone counts as 1.

    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).not.toContain('month running');
  });
});

/**
 * S-18 fix round 1 (v1.13.0 ruling R2, new scope). This file's three events pushed the
 * HOUSEHOLD's netCents and targetCents into a per-recipient send for every notifiable user,
 * self-scoped members included -- a household uses self scope for a child's account, and
 * evaluateSavingsTargetMet renders once and fans that identical body out over notifiableUsers().
 * Structurally the same leak as S-18's budget evaluators; the original sweep missed this file
 * because it uses none of the six symbols that sweep grepped for.
 *
 * Ruling T3 justifies the READ SHAPE (a savings target is household-scoped only, never
 * per-person) and says nothing about DELIVERY. All three events are householdEligible, so the
 * family channel is fine and the per-user copy is not: the fix is enqueue's familyChannelOnly at
 * each call site. A savings target has no personal analogue to narrow to, so for a self-scoped
 * recipient the personal send is omitted outright rather than scoped to zero -- a "$0.00 target"
 * sentence would be a false statement about household state, not a narrowed one.
 */
describe('S-18 round 1 (ruling R2): household savings figures never reach a self-scoped member personally', () => {
  const MET_TICK = new Date('2026-08-12T12:00:00Z');
  const PACE_SLOT = new Date('2026-08-10T12:00:00Z');
  const CLOSED_SLOT = new Date('2026-08-01T09:00:00Z');

  /** An admin whose row says visibility 'self' -- setUserVisibility refuses the pairing
   *  (micro-ruling M1), so this is the hand-edited-database case isSelfScoped's admin clause
   *  exists for, and the answer must be "not self-scoped". */
  function adminWithSelfRow(): number {
    const userId = emailUser();
    t.db.run(sql`update users set visibility = 'self' where id = ${userId}`);
    return userId;
  }

  function rows(): { user_id: number | null; dedup_key: string; body: string }[] {
    return t.sqlite.prepare('select user_id, dedup_key, body from notification_outbox order by id').all() as {
      user_id: number | null;
      dedup_key: string;
      body: string;
    }[];
  }

  /** creatorId is an active admin with no notification target of its own, so isEventEnabled is
   *  false for it everywhere and it never becomes a participant -- but it can still be the admin
   *  who sets the family channel up, which is what upsertHouseholdTarget asks for. */
  function routeToFamilyEmail(eventId: string): void {
    expect(
      upsertHouseholdTarget({ channel: 'email', destination: 'family@example.invalid', actorUserId: creatorId }).ok,
    ).toBe(true);
    expect(setHouseholdEventPref({ eventId, channel: 'email', enabled: true }).ok).toBe(true);
  }

  it('savings_target_met: the self-scoped member gets no personal copy, everybody else is unchanged', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    const control = emailUser(); // household-visibility admin
    const adminSelf = adminWithSelfRow();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 100000 });
    seedMetMonth('2026-08'); // nets $2,000 against the $1,000 target

    expect(evaluateSavingsTargetMet({ now: MET_TICK, tz: TZ })).toBe(2);

    // The bug this pins: `self` used to receive savings-met:2026-08 as well, its body naming the
    // household's $2,000.00 net and $1,000.00 target -- figures a self-scoped member may not see
    // on any screen, delivered by push to their own inbox.
    expect(rows().filter((r) => r.user_id === self)).toEqual([]);
    expect(rows().map((r) => r.user_id).sort((a, b) => Number(a) - Number(b))).toEqual(
      [control, adminSelf].sort((a, b) => a - b),
    );
    expect(rows().every((r) => r.body.includes('$2,000.00') && r.body.includes('$1,000.00'))).toBe(true);
  });

  it('savings_target_met: a household whose only opted-in member is self-scoped still reaches the family channel', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    routeToFamilyEmail('savings_target_met');
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 100000 });
    seedMetMonth('2026-08');

    expect(evaluateSavingsTargetMet({ now: MET_TICK, tz: TZ })).toBe(1);
    expect(rows().map((r) => [r.user_id, r.dedup_key])).toEqual([[null, 'hh:savings-met:2026-08']]);
    expect(rows()[0].body).toContain('$2,000.00');
  });

  it('savings_target_pace: no personal copy for the self-scoped member, unchanged for everybody else', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    const control = emailUser();
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 310000 });
    const salary = categoryIdByName(t.db, 'Salary');
    txn(salary, 40000, '2026-08-08'); // day 10 needs $1,000 saved; only $400 is

    expect(evaluateSavingsDaily({ userId: self, now: PACE_SLOT, tz: TZ })).toBe(0);
    expect(evaluateSavingsDaily({ userId: control, now: PACE_SLOT, tz: TZ })).toBe(1);
    expect(rows().map((r) => [r.user_id, r.dedup_key])).toEqual([[control, 'savings-pace:2026-08']]);
    expect(rows()[0].body).toContain('$3,100.00');
  });

  it('savings_month_closed: no personal copy for the self-scoped member, unchanged for everybody else', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    const control = emailUser();
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 100000 });
    seedMetMonth('2026-07');

    expect(evaluateSavingsDaily({ userId: self, now: CLOSED_SLOT, tz: TZ })).toBe(0);
    expect(evaluateSavingsDaily({ userId: control, now: CLOSED_SLOT, tz: TZ })).toBe(1);
    expect(rows().map((r) => [r.user_id, r.dedup_key])).toEqual([[control, 'savings-closed:2026-07']]);
    expect(rows()[0].body).toContain('$2,000.00');
  });

  it('savings_month_closed: a self-scoped-only household still reaches the family channel', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    routeToFamilyEmail('savings_month_closed');
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 100000 });
    seedMetMonth('2026-07');

    expect(evaluateSavingsDaily({ userId: self, now: CLOSED_SLOT, tz: TZ })).toBe(1);
    expect(rows().map((r) => [r.user_id, r.dedup_key])).toEqual([[null, 'hh:savings-closed:2026-07']]);
    expect(rows()[0].body).toContain('$2,000.00');
  });
});

describe('a household with no target set is silent across all three events', () => {
  it('fires nothing for savings_target_met, savings_target_pace or savings_month_closed', () => {
    const userId = emailUser();
    // Income and spend exist, but no savings_targets row for any month -- ruling: never nag a
    // household about a target it never agreed to.
    seedMetMonth('2026-07');
    seedMetMonth('2026-08');

    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(0);
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(0);
    expect(evaluateSavingsDaily({ userId, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});
