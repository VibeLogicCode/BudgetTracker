import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setUserVisibility } from '@/lib/auth/users';
import { upsertBudget } from '@/lib/budgets';
import { DEFAULT_USER_SETTINGS, saveEmailTarget, saveSmtp, saveUserSettings, setPref } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import { familyChannelNeedsOwnPass } from '@/lib/notify/family-pass';
import { evaluateAnomalies, evaluateSubscriptionCreep, resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';
import { evaluateBudgets, resetBudgetFingerprintForTests } from '@/lib/notify/evaluate/budget';
import { evaluateComingDue } from '@/lib/notify/evaluate/coming-due';
import { evaluateWeeklyDigest } from '@/lib/notify/evaluate/digest';
import { evaluateMonthBoundary } from '@/lib/notify/evaluate/monthly';
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';
import { evaluateSavingsDaily, evaluateSavingsTargetMet } from '@/lib/notify/evaluate/savings';
import { HOUSEHOLD_PASS_NOT_ROUTABLE, enqueue, resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { saveSavingsTarget } from '@/lib/savings-target';

/**
 * RULING R23 (v1.32.0). "A family-channel notification row is only ever written during some
 * individual's evaluation pass, so an event nobody has enabled personally produces no family row at
 * all." The household in every test below is the exact shape that produced it, and it is not an
 * exotic one: an admin sets up the family Telegram channel, switches the events on for the room,
 * and nobody sets up a personal channel of their own -- which is what a family with one shared
 * group chat and no interest in per-person email actually does. Before this ruling the family
 * channel was configured, enabled and silent, for every household-eligible event at once.
 *
 * Each test asserts the family row EXISTS and carries the household's figures. The pair of tests at
 * the bottom are the other half of the ruling: no duplicate send when a member IS subscribed, and
 * no second writer for the two eligible events that never had this defect.
 *
 * Fixture note: a family TELEGRAM channel, deliberately. An email family channel additionally needs
 * an enabled notification_smtp row, and setting one up is how a test accidentally gives the members
 * a working personal channel too -- which would put the household back in the state where somebody
 * IS subscribed and quietly test nothing.
 */
const FAMILY_TOKEN = '888800002:AAFAMILY-invented-token-never-a-real-one';
const FAMILY_CHAT = '-1009876543211';
const TZ = 'UTC';

let t: TestDb;
let accountId: number;
let adminId: number;

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db, { name: 'Joint Chequing' });
  adminId = insertTestUser(t.db, { username: 'admin', name: 'Admin' });
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  resetAnomalyFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetBudgetFingerprintForTests();
  resetAnomalyFingerprintForTests();
  t.cleanup();
});

/** The family Telegram channel, plus the events an admin has switched on for the room. */
function routeToFamily(...eventIds: string[]): void {
  expect(
    upsertHouseholdTarget({ channel: 'telegram', destination: FAMILY_CHAT, secret: FAMILY_TOKEN, actorUserId: adminId })
      .ok,
  ).toBe(true);
  for (const eventId of eventIds) {
    expect(setHouseholdEventPref({ eventId, channel: 'telegram', enabled: true }).ok).toBe(true);
  }
}

/** A member with a working PERSONAL channel, for the no-duplicates tests only. */
function subscribedMember(role: 'admin' | 'member' = 'admin'): number {
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
  saveEmailTarget({ userId, destination: 'sam@example.invalid', enabled: true });
  return userId;
}

function spend(categoryId: number, cents: number, date: string, merchant = 'MERCHANT'): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${merchant}, ${merchant}, ${categoryId},
                null, 0, ${`h${Math.random()}`}, ${adminId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function income(categoryId: number, cents: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${cents}, ${'PAY'}, ${'pay'}, ${categoryId},
                0, ${`h${Math.random()}`}, ${adminId}, ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
  );
}

interface OutboxRow {
  user_id: number | null;
  channel: string;
  event_id: string;
  dedup_key: string;
  subject: string;
  body: string;
}

function rows(): OutboxRow[] {
  return t.sqlite
    .prepare('select user_id, channel, event_id, dedup_key, subject, body from notification_outbox order by id')
    .all() as OutboxRow[];
}

function familyRows(eventId: string): OutboxRow[] {
  return rows().filter((row) => row.user_id === null && row.event_id === eventId);
}

describe('R23: an event nobody has enabled personally still reaches the family channel', () => {
  it('budget_exceeded and budget_threshold, at the household threshold rather than a member one', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('budget_threshold', 'budget_exceeded');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 75000, '2026-08-05');

    expect(evaluateBudgets({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(2);

    // The threshold key carries the pct it fired at (budgetThresholdKey). 80 is
    // HOUSEHOLD_PASS_SETTINGS.budgetThresholdPct -- the app default -- and NOT some member's, which
    // is the property that keeps the family row's key from moving when somebody edits their
    // settings page.
    expect(familyRows('budget_threshold').map((row) => row.dedup_key)).toEqual([
      `hh:budget:h:${groceries}:2026-08:80`,
    ]);
    expect(familyRows('budget_exceeded').map((row) => row.dedup_key)).toEqual([`hh:budget:h:${groceries}:2026-08:100`]);
    expect(familyRows('budget_exceeded')[0].body).toContain('Groceries');
    // Nothing personal: there is no person in this household with a channel at all.
    expect(rows().every((row) => row.user_id === null)).toBe(true);
  });

  it('budget_pace', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('budget_pace');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    // The 12th of a 31-day month, so the projection multiplier is 31/12: $255.49 spent projects to
    // $660, ten percent past a $600 limit.
    spend(groceries, 25549, '2026-08-05');

    expect(evaluateBudgetPace({ userId: null, now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('budget_pace').map((row) => row.dedup_key)).toEqual([`hh:pace:h:${groceries}:2026-08`]);
  });

  it('predicted_vs_actual, suggested_budget_refresh and monthly_digest', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('predicted_vs_actual', 'suggested_budget_refresh', 'monthly_digest');
    // Six flat months ending 2026-06 give suggestionsFor a baseline; July is the closed month.
    for (const month of ['01', '02', '03', '04', '05', '06', '07']) {
      spend(groceries, 60000, `2026-${month}-10`);
    }
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 20000 });

    expect(evaluateMonthBoundary({ userId: null, now: new Date('2026-08-01T09:00:00Z'), tz: TZ })).toBe(3);

    expect(familyRows('predicted_vs_actual').map((row) => row.dedup_key)).toEqual(['hh:predvs:2026-07']);
    expect(familyRows('suggested_budget_refresh').map((row) => row.dedup_key)).toEqual(['hh:suggest:2026-08']);
    expect(familyRows('monthly_digest').map((row) => row.dedup_key)).toEqual(['hh:monthly-digest:2026-07']);
    // The room's monthly digest carries the HOUSEHOLD's budgeted pair, not a narrowed one: the
    // household pass reads through HOUSEHOLD_VIEWER, whose ownerScope is null.
    expect(familyRows('monthly_digest')[0].body).toContain('$600.00');
  });

  it('savings_target_met', () => {
    const salary = categoryIdByName(t.db, 'Salary');
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('savings_target_met');
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 200000 });
    income(salary, 500000, '2026-08-05');
    spend(groceries, 300000, '2026-08-10');

    expect(evaluateSavingsTargetMet({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('savings_target_met').map((row) => row.dedup_key)).toEqual(['hh:savings-met:2026-08']);
  });

  it('savings_target_pace and savings_month_closed', () => {
    const salary = categoryIdByName(t.db, 'Salary');
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('savings_target_pace', 'savings_month_closed');
    saveSavingsTarget({ month: '2026-08', mode: 'amount', value: 200000 });
    saveSavingsTarget({ month: '2026-07', mode: 'amount', value: 200000 });
    income(salary, 100000, '2026-08-02');
    income(salary, 100000, '2026-07-02');
    spend(groceries, 90000, '2026-07-10');

    // The 2nd is inside MONTH_REPORT_DAY_MAX for the closed month; day 7 is PACE_MIN_DAY_OF_MONTH,
    // so the pace half needs a later date. Both halves share evaluateSavingsDaily.
    expect(evaluateSavingsDaily({ userId: null, now: new Date('2026-08-02T09:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('savings_month_closed').map((row) => row.dedup_key)).toEqual(['hh:savings-closed:2026-07']);

    expect(evaluateSavingsDaily({ userId: null, now: new Date('2026-08-20T09:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('savings_target_pace').map((row) => row.dedup_key)).toEqual(['hh:savings-pace:2026-08']);
  });

  it('unusual_transaction and duplicate_charge, which v1.31.0 made the ordinary case', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('unusual_transaction', 'duplicate_charge');
    // 60+ days of household history (MUST-9.10 condition 1), a merchant baseline, and one outlier.
    spend(groceries, 100, '2026-01-01');
    for (let index = 0; index < 5; index += 1) {
      spend(groceries, 12000, `2026-0${(index % 5) + 2}-1${index}`, 'CANADIAN TIRE');
    }
    const outlier = spend(groceries, 41288, '2026-08-14', 'CANADIAN TIRE');
    const first = spend(groceries, 8950, '2026-08-12', 'BELL CANADA');
    const second = spend(groceries, 8950, '2026-08-13', 'BELL CANADA');

    expect(evaluateAnomalies({ now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(2);
    expect(familyRows('unusual_transaction').map((row) => row.dedup_key)).toEqual([`hh:unusual:${outlier}`]);
    expect(familyRows('duplicate_charge').map((row) => row.dedup_key)).toEqual([`hh:dupe:${first}:${second}`]);
  });

  it('subscription_creep', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('subscription_creep');
    spend(groceries, 100, '2026-01-01');
    spend(groceries, 1649, '2026-05-14', 'NETFLIX');
    spend(groceries, 1649, '2026-06-14', 'NETFLIX');
    spend(groceries, 1649, '2026-07-14', 'NETFLIX');
    const risen = spend(groceries, 2099, '2026-08-14', 'NETFLIX');

    expect(evaluateSubscriptionCreep({ userId: null, now: new Date('2026-08-18T12:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('subscription_creep').map((row) => row.dedup_key)).toEqual([`hh:creep:${risen}`]);
  });
});

describe('R23: the household pass and the member path are mutually exclusive, so nothing is sent twice', () => {
  it('does not run at all once a member is subscribed, however differently that member is configured', () => {
    routeToFamily('budget_exceeded');
    expect(familyChannelNeedsOwnPass('budget_exceeded')).toBe(true);

    // A SELF-SCOPED member on a channel the family channel has not taken: the case where the member
    // gets no personal delivery either (enqueue's familyChannelOnly). They are still a subscriber,
    // so their pass is the one that writes the family row and the household pass stands down.
    const member = subscribedMember('member');
    setUserVisibility(member, 'self');
    expect(familyChannelNeedsOwnPass('budget_exceeded')).toBe(false);

    // ...and switching it off again brings the household pass back.
    setPref(member, 'budget_exceeded', 'email', false);
    setPref(member, 'budget_exceeded', 'telegram', false);
    expect(familyChannelNeedsOwnPass('budget_exceeded')).toBe(true);
  });

  it('writes exactly one family row for a category, not one per subscribed member plus one', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('budget_threshold', 'budget_exceeded');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 75000, '2026-08-05');

    // Two members, both subscribed, on DIFFERENT thresholds -- so the household pass must stay out
    // of the way entirely rather than adding a third key alongside theirs.
    const one = subscribedMember('admin');
    const two = subscribedMember('member');
    saveUserSettings(one, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 70 });
    saveUserSettings(two, { ...DEFAULT_USER_SETTINGS, budgetThresholdPct: 90 });

    evaluateBudgets({ now: new Date('2026-08-12T12:00:00Z'), tz: TZ });

    expect(familyRows('budget_exceeded')).toHaveLength(1);
    // Two, not three: one per subscribed member's threshold (the pre-existing member-path shape,
    // documented in family-pass.ts), and none at the household's own 80.
    //
    // Neither member has budget_threshold switched on -- it defaults OFF (MUST-4.1) and neither
    // touched it -- yet both write a family THRESHOLD row anyway, because enqueue's routed branch
    // does not consult isEventEnabled and evaluateBudgets' roster is the union of the two events.
    // That is why evaluateBudgets gates its household pass on an empty roster rather than on
    // familyChannelNeedsOwnPass alone; see the `noMemberPass` comment there. This assertion is the
    // one that caught it.
    const thresholdKeys = familyRows('budget_threshold').map((row) => row.dedup_key).sort();
    expect(thresholdKeys).toEqual([`hh:budget:h:${groceries}:2026-08:70`, `hh:budget:h:${groceries}:2026-08:90`]);
    expect(thresholdKeys.some((key) => key.endsWith(':80'))).toBe(false);
  });

  it('re-running the household pass writes nothing further', () => {
    const groceries = categoryIdByName(t.db, 'Groceries');
    routeToFamily('budget_pace');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 25549, '2026-08-05');

    const now = new Date('2026-08-12T12:00:00Z');
    expect(evaluateBudgetPace({ userId: null, now, tz: TZ })).toBe(1);
    expect(evaluateBudgetPace({ userId: null, now, tz: TZ })).toBe(0);
    expect(familyRows('budget_pace')).toHaveLength(1);
  });
});

describe('R23: the two household-eligible events that never had this defect', () => {
  /**
   * coming_due and weekly_digest have no personal gate in their evaluators at all -- both run for
   * every notifiable user whatever that user's toggles say -- so the family row was always written.
   * Proven rather than asserted, because "this evaluator has no gate" is exactly the kind of claim
   * that quietly stops being true. tests/ops/family-channel-pass.test.ts holds the source-level
   * half of the same claim.
   */
  it('coming_due still reaches the family channel from a member pass with nobody subscribed', () => {
    routeToFamily('coming_due');
    // warranty_items CHECK constraints (drizzle/0002_warranty_tracker.sql) pair warranty_months
    // with expiry_date; 12 satisfies them and nothing here reads it.
    t.db.run(
      sql`insert into warranty_items
            (name, vendor, owner_user_id, purchase_date, warranty_months, price_cents, expiry_date, is_lifetime, created_at, updated_at)
          values (${'Dishwasher'}, ${'A Shop'}, ${adminId}, ${'2024-08-01'}, ${12}, ${120000}, ${'2026-08-20'}, 0,
                  ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'})`,
    );

    expect(evaluateComingDue({ userId: adminId, now: new Date('2026-08-12T09:00:00Z'), tz: TZ })).toBe(1);
    expect(familyRows('coming_due')).toHaveLength(1);
  });

  it('weekly_digest still reaches the family channel from a member pass with nobody subscribed', () => {
    routeToFamily('weekly_digest');
    expect(evaluateWeeklyDigest({ userId: adminId, slotDate: '2026-08-17', now: new Date('2026-08-17T09:00:00Z') })).toBe(1);
    expect(familyRows('weekly_digest')).toHaveLength(1);
  });
});

describe('R23: enqueue itself', () => {
  it('writes only the family row on a household pass, and no personal row for anybody', () => {
    routeToFamily('budget_exceeded');
    const member = subscribedMember('admin');

    const result = enqueue({
      userId: null,
      eventId: 'budget_exceeded',
      dedupKey: 'be:h:1:2026-08',
      subject: 'Groceries is over budget',
      body: 'body',
      at: new Date('2026-08-12T12:00:00Z'),
    });

    expect(result.inserted).toEqual([]);
    expect(result.household).toEqual(['telegram']);
    // Nothing was suppressed: a household pass has no personal send for the family channel to
    // replace, and the subscribed member's own email row is not this call's business.
    expect(result.suppressed).toEqual([]);
    expect(rows().map((row) => row.user_id)).toEqual([null]);
    expect(rows().every((row) => row.user_id !== member)).toBe(true);
  });

  it('refuses a household pass over a personal-scope event rather than silently enqueueing nothing', () => {
    routeToFamily('budget_threshold');
    expect(() =>
      enqueue({
        userId: null,
        eventId: 'budget_threshold',
        dedupKey: 'bt:p:1:2026-08:80',
        subject: 's',
        body: 'b',
        subjectScope: 'personal',
      }),
    ).toThrow(HOUSEHOLD_PASS_NOT_ROUTABLE);
  });
});
