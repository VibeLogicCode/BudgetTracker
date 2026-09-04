import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setUserVisibility } from '@/lib/auth/users';
import { effectiveBudget, setRollover, upsertBudget } from '@/lib/budgets';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateBudgetPace } from '@/lib/notify/evaluate/pace';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
/** The 12th of a 31-day month, so the projection multiplier is 31/12. */
const NOW = new Date('2026-08-12T12:00:00Z');

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

function spend(categoryId: number, cents: number, attributedUserId: number | null = null, date = '2026-08-05'): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${-cents}, ${'MERCHANT'}, ${'merchant'}, ${categoryId},
                ${attributedUserId}, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-05T00:00:00.000Z'}, ${'2026-08-05T00:00:00.000Z'})`,
  );
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

describe('MUST-9.6: the four trigger conditions', () => {
  it('fires at a projected 110 percent and stays silent at 105', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // 31/12 of the spend is the projection. A $600 limit needs $660 projected, so $255.49 spent.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });

    spend(groceries, 24000); // projects to 62000, which is 103 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);

    spend(groceries, 2000); // 26000 total, projects to 67167, which is 111 percent
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });

  it('does not fire before the seventh', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 50000, null, '2026-08-01');
    expect(evaluateBudgetPace({ userId, now: new Date('2026-08-06T12:00:00Z'), tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 3: stands down once the budget is already blown', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 70000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.6 condition 2: a zero limit is budget_exceeded business, not a projection', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 0 });
    spend(groceries, 100);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('does not fire for a category with no limit at all', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    spend(groceries, 90000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});

describe('MUST-9.8: once per scope, per category, per month, ever', () => {
  it('stays silent across ten consecutive daily evaluations after the first', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);

    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(1);
    for (let day = 13; day <= 22; day += 1) {
      const at = new Date(`2026-08-${day}T12:00:00Z`);
      expect(evaluateBudgetPace({ userId, now: at, tz: TZ })).toBe(0);
    }
    expect(keys()).toEqual([`pace:h:${groceries}:2026-08`]);
  });
});

describe('MUST-9.35: household rows reach every enabled user, personal rows only their owner', () => {
  it('keys household and personal separately and delivers each to the right person', () => {
    const sam = emailUser();
    const alex = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    // Above the $260 spent so far, so MUST-9.6 condition 3 does not stand the personal row
    // down; the 31/12 projection of $671.67 still clears 110 percent of $300.
    upsertBudget({ scope: 'personal', userId: sam, categoryId: groceries, month: '2026-08', amountCents: 30000 });
    spend(groceries, 26000, sam);

    expect(evaluateBudgetPace({ userId: sam, now: NOW, tz: TZ })).toBe(2);
    expect(evaluateBudgetPace({ userId: alex, now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite.prepare('select user_id, dedup_key from notification_outbox order by id').all() as {
      user_id: number;
      dedup_key: string;
    }[];
    expect(rows.filter((row) => row.dedup_key === `pace:p:${groceries}:2026-08`).map((row) => row.user_id)).toEqual([sam]);
    expect(rows.filter((row) => row.dedup_key === `pace:h:${groceries}:2026-08`).map((row) => row.user_id).sort()).toEqual(
      [sam, alex].sort(),
    );
  });
});

/**
 * MEDIUM fix (final-fix-wave item 3): PACE_MAX_PER_EVALUATION caps this detector the same way
 * the three anomaly detectors already cap themselves. Twelve leaf categories, each with a
 * $100.00 limit and a distinct spend so every overshoot is a distinct value, all qualify; only
 * the five worst should ever be enqueued.
 */
describe('MEDIUM fix: PACE_MAX_PER_EVALUATION caps the detector at its five largest overshoots', () => {
  it('12 qualifying categories produce exactly 5 messages, the 5 with the largest overshoot', () => {
    const userId = emailUser();
    // Twelve distinct leaf categories from the seed tree (Food x3, Transport x6, Shopping x3),
    // none sharing a parent budget, so only these 12 rows are pace candidates.
    const leaves = [
      'Groceries',
      'Restaurants',
      'Coffee',
      'Gas',
      'Car Payment',
      'Car Insurance',
      'Maintenance',
      'Transit',
      'Parking',
      'Clothing',
      'Electronics',
      'General',
    ];
    // Descending spend, 500 cents apart, so every projected overshoot is distinct: 10000 down
    // to 4500 in 12 steps. All 12 clear the 110 percent floor at day 12 of a 31-day month
    // (even the smallest, 4500, projects to 11625 against a 11000 floor).
    const spentByLeaf = new Map(leaves.map((name, index) => [name, 10000 - index * 500]));

    const ids = new Map(leaves.map((name) => [name, categoryIdByName(t.db, name)]));
    for (const name of leaves) {
      const categoryId = ids.get(name)!;
      upsertBudget({ scope: 'household', userId: null, categoryId, month: '2026-08', amountCents: 10000 });
      spend(categoryId, spentByLeaf.get(name)!);
    }

    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(5);

    // The 5 largest spends (and therefore the 5 largest overshoots) are the first 5 in the
    // descending list: Groceries, Restaurants, Coffee, Gas, Car Payment.
    const expectedFired = ['Groceries', 'Restaurants', 'Coffee', 'Gas', 'Car Payment'];
    const expectedSkipped = leaves.filter((name) => !expectedFired.includes(name));

    const fired = keys();
    for (const name of expectedFired) {
      expect(fired).toContain(`pace:h:${ids.get(name)}:2026-08`);
    }
    for (const name of expectedSkipped) {
      expect(fired).not.toContain(`pace:h:${ids.get(name)}:2026-08`);
    }
    expect(fired.length).toBe(5);
  });
});

describe('notify MUST-4.2: a user with the event switched off hears nothing', () => {
  it('enqueues no row when every channel is off for budget_pace', () => {
    const userId = emailUser();
    setPref(userId, 'budget_pace', 'email', false);
    setPref(userId, 'budget_pace', 'telegram', false);
    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

/**
 * v1.7.0 Task 11, deliverable (c): same verification as budget.test.ts's equivalent block --
 * `grep -n "resolveBudget" src/lib/notify/evaluate/pace.ts` returns no matches; `candidateFor`
 * (this file's source, above) reads only `row.limitCents` / `row.spentCents` from
 * `budgetProgress()`, which already carries the EFFECTIVE limit (base + rollover carry) per
 * budgets.ts's BudgetRow doc comment.
 *
 * CONCLUSION: current behaviour is already correct; no fix was needed in pace.ts. This test
 * pins it: a carry that would clear the 110 percent overshoot floor against the base alone
 * keeps the projection comfortably under it once the carry is counted.
 */
describe('v1.7.0 Task 11: rollover carry keeps a covered category off the pace alert', () => {
  it('budget_pace does not fire when the carry covers the projected overshoot', () => {
    const userId = emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-07' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-07', amountCents: 100000 });
    // August: a $500 base. $400 spent at day 12 of a 31-day month projects to about $1033.33 --
    // over 110% of the $500 base alone -- but only about 69% of the $1500 effective limit.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 50000 });
    expect(effectiveBudget('household', null, groceries, '2026-08').carryCents).toBe(100000);

    spend(groceries, 40000);
    expect(evaluateBudgetPace({ userId, now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });
});

/**
 * S-18 fix (v1.13.0 ruling R2, applied one layer down): evaluateBudgetPace used to build BOTH
 * scopes' candidates for every user regardless of visibility, so a self-scoped recipient (a
 * household uses this for a child's account) got a household pace projection by push -- its
 * category name, limit and projected month-end figure -- with no crafted request involved. Fixed
 * with viewerFor (src/lib/auth/users.ts): round 1 marks a self-scoped recipient's
 * household candidates familyChannelOnly (outbox.ts) so the routed family-channel row survives
 * and the personal copy does not, and skips the household read outright when the event is routed
 * to no family channel at all.
 */
describe('S-18 fix (v1.13.0 ruling R2): a self-scoped recipient never receives a household pace alert', () => {
  it('gets no household figure, keeps their own personal pace alert, and leaves a household-visibility member, an admin, and an admin whose row says self, unchanged', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    const control = emailUser(); // household-visibility admin -- the "everyone else" byte-identical check
    // Review round 1 (minor 5): admin + visibility 'self', the pairing no test covered. Written
    // straight into the row because setUserVisibility refuses it (micro-ruling M1) -- the
    // hand-edited-database case isSelfScoped's admin clause exists for. An admin is never
    // self-scoped, so this recipient must be treated exactly like `control`.
    const adminSelf = emailUser();
    t.db.run(sql`update users set visibility = 'self' where id = ${adminSelf}`);
    const groceries = categoryIdByName(t.db, 'Groceries');
    const gas = categoryIdByName(t.db, 'Gas');

    // Household budget, someone else's (unattributed) spend -- self must never see this.
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000); // projects to 111 percent of the $600 household limit

    // self's OWN personal budget, self's own spend -- self must still see this.
    upsertBudget({ scope: 'personal', userId: self, categoryId: gas, month: '2026-08', amountCents: 60000 });
    spend(gas, 26000, self); // the identical projection, personal scope

    expect(evaluateBudgetPace({ userId: self, now: NOW, tz: TZ })).toBe(1);
    expect(evaluateBudgetPace({ userId: control, now: NOW, tz: TZ })).toBe(1);
    expect(evaluateBudgetPace({ userId: adminSelf, now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite
      .prepare('select user_id, dedup_key, body from notification_outbox order by id')
      .all() as { user_id: number; dedup_key: string; body: string }[];
    const selfRows = rows.filter((r) => r.user_id === self);
    const controlRows = rows.filter((r) => r.user_id === control);

    // The bug this pins: self used to also receive `pace:h:${groceries}:2026-08`, naming
    // "Groceries" in the body.
    expect(selfRows.map((r) => r.dedup_key)).toEqual([`pace:p:${gas}:2026-08`]);
    expect(selfRows[0].body).not.toContain('Groceries');
    expect(selfRows[0].body).toContain('Gas');

    // Byte-identical for everyone else: the household-visibility control still gets the
    // household pace alert, naming "Groceries", unchanged.
    expect(controlRows.map((r) => r.dedup_key)).toEqual([`pace:h:${groceries}:2026-08`]);
    expect(controlRows[0].body).toContain('Groceries');

    // ...and so does the admin whose row says 'self'.
    const adminSelfRows = rows.filter((r) => r.user_id === adminSelf);
    expect(adminSelfRows.map((r) => r.dedup_key)).toEqual([`pace:h:${groceries}:2026-08`]);
    expect(adminSelfRows[0].body).toContain('Groceries');
  });

  /**
   * The regression review round 1 exists to prevent, for budget_pace: round 0 dropped the
   * household scope from a self-scoped recipient's `scopes` array, and on a routed channel that
   * scope is the only thing that feeds the family room. A household whose one opted-in member is
   * self-scoped lost its family pace alerts entirely.
   */
  it('still feeds the family channel when the only opted-in recipient is self-scoped', () => {
    const self = emailUser('member');
    setUserVisibility(self, 'self');
    // creatorId is an active admin with no notification target of its own: it can set the family
    // channel up without becoming a recipient itself.
    expect(
      upsertHouseholdTarget({ channel: 'email', destination: 'family@example.invalid', actorUserId: creatorId }).ok,
    ).toBe(true);
    expect(setHouseholdEventPref({ eventId: 'budget_pace', channel: 'email', enabled: true }).ok).toBe(true);

    const groceries = categoryIdByName(t.db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-08', amountCents: 60000 });
    spend(groceries, 26000); // projects to 111 percent of the $600 household limit

    expect(evaluateBudgetPace({ userId: self, now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite
      .prepare('select user_id, dedup_key, body from notification_outbox order by id')
      .all() as { user_id: number | null; dedup_key: string; body: string }[];
    expect(rows.map((r) => [r.user_id, r.dedup_key])).toEqual([[null, `hh:pace:h:${groceries}:2026-08`]]);
    expect(rows[0].body).toContain('Groceries');
  });
});
