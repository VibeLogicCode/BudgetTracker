import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import {
  budgetProgress,
  budgetTotals,
  clearBudget,
  effectiveBudget,
  rolloverStartMonth,
  setRollover,
  upsertBudget,
} from '@/lib/budgets';
import { addMonths } from '@/lib/dates';
import { nowIso } from '@/lib/clock';

/**
 * Rollover budgets: math + storage (spec 2026-08-22, v1.7.0, Task 10). A budget_rollover row's
 * EXISTENCE means rollover is ON for a (scope, user, category); deleting it turns it off
 * (src/db/schema.ts). Ruling 4: rollover carries POSITIVE leftovers only -- overspend never
 * creates a carried debt -- capped at a 24-month look-back, starting the month the toggle was
 * enabled.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const bob = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const spend = (over: { categoryId: number | null; amountCents: number; date: string; attributedUserId?: number | null }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', 0, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, joint, spend };
}

/** One transaction dated on the 10th of `month`, so callers just pick a month key. */
function onMonth(month: string): string {
  return `${month}-10`;
}

describe('effectiveBudget — no rollover row', () => {
  it('reports carryCents 0 and effectiveCents equal to base when nothing was ever enabled', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 80000 });

    expect(effectiveBudget('household', null, groceries, '2026-03')).toEqual({
      baseCents: 80000,
      carryCents: 0,
      effectiveCents: 80000,
    });
  });

  it('reports a null base and null effective, still with carryCents 0, when no budget was ever set either', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    expect(effectiveBudget('household', null, groceries, '2026-03')).toEqual({
      baseCents: null,
      carryCents: 0,
      effectiveCents: null,
    });
  });
});

describe('effectiveBudget — month at or before startMonth', () => {
  it('has no carry for the start month itself, or any earlier month', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 80000 });
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-03' });

    expect(effectiveBudget('household', null, groceries, '2026-03').carryCents).toBe(0);
    expect(effectiveBudget('household', null, groceries, '2026-02').carryCents).toBe(0);
  });
});

describe('effectiveBudget — leftover accumulation', () => {
  it('accumulates positive leftover across three consecutive months', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    // Base $1000/month; leftovers of $200, $100 and $300 in Jan/Feb/Mar -> carry of $600
    // entering April.
    for (const month of ['2026-01', '2026-02', '2026-03']) {
      upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month, amountCents: 100000 });
    }
    spend({ categoryId: groceries, amountCents: -80000, date: onMonth('2026-01') }); // leftover 20000
    spend({ categoryId: groceries, amountCents: -90000, date: onMonth('2026-02') }); // leftover 10000 (carry 30000)
    spend({ categoryId: groceries, amountCents: -70000, date: onMonth('2026-03') }); // leftover 30000 (carry 60000)

    const result = effectiveBudget('household', null, groceries, '2026-04');
    expect(result.carryCents).toBe(60000);
    // Budgets carry forward from their effective month (resolveBudget's own, pre-existing
    // rule -- see budgets.test.ts's "applies a budget from its effective month forward"), so
    // April's base is still March's 100000; nobody cleared it.
    expect(result.baseCents).toBe(100000);
    expect(result.effectiveCents).toBe(160000);
  });

  it('treats a month with no resolved base as contributing 0, not null, to the running carry', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 100000 });
    spend({ categoryId: groceries, amountCents: -80000, date: onMonth('2026-01') }); // leftover 20000, carry -> 20000
    // February is explicitly CLEARED (distinct from "never set": resolveBudget carries a
    // budget forward otherwise, see the test above), so resolveBudget('2026-02') is null and
    // must contribute 0 to the running carry, not null/NaN. No spend in February either.
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 100000 });
    spend({ categoryId: groceries, amountCents: -70000, date: onMonth('2026-03') }); // leftover 30000, carry -> 50000

    expect(effectiveBudget('household', null, groceries, '2026-04').carryCents).toBe(50000);
  });
});

describe('effectiveBudget — overspend clamps at 0', () => {
  it('never goes negative on overspend, and resumes accumulating from 0 afterward', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 100000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 100000 });

    spend({ categoryId: groceries, amountCents: -150000, date: onMonth('2026-01') }); // overspend by 50000 -> clamps to 0
    expect(effectiveBudget('household', null, groceries, '2026-02').carryCents).toBe(0);

    spend({ categoryId: groceries, amountCents: -50000, date: onMonth('2026-02') }); // leftover 50000, starting fresh from 0
    expect(effectiveBudget('household', null, groceries, '2026-03').carryCents).toBe(50000);
  });
});

describe('effectiveBudget — 24-month cap', () => {
  it('counts only the last 24 months of a 30-month rollover history', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const startMonth = '2020-01';
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth });

    // 30 consecutive months, each with a $10 leftover ($100 base, $90 spent).
    for (let i = 0; i < 30; i += 1) {
      const month = addMonths(startMonth, i);
      upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month, amountCents: 10000 });
      spend({ categoryId: groceries, amountCents: -9000, date: onMonth(month) });
    }

    const evalMonth = addMonths(startMonth, 30);
    // Uncapped, 30 months of $1000 leftover would carry $30000; capped at the last 24 it is
    // $24000.
    expect(effectiveBudget('household', null, groceries, evalMonth).carryCents).toBe(24000);
  });
});

describe('effectiveBudget — child rollup', () => {
  it("counts a child category's leftovers via the rollup, including an archived child's", () => {
    const { db, sqlite, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    setRollover({ scope: 'household', userId: null, categoryId: food, enabled: true, startMonth: '2026-01' });
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-01', amountCents: 100000 });

    // Own (Food) spend $20000, Groceries $30000, Coffee $10000 -> rollup spend $60000,
    // leftover $40000.
    spend({ categoryId: food, amountCents: -20000, date: onMonth('2026-01') });
    spend({ categoryId: groceries, amountCents: -30000, date: onMonth('2026-01') });
    spend({ categoryId: coffee, amountCents: -10000, date: onMonth('2026-01') });

    // Archive Coffee AFTER the spend happened -- buildRow's rollupChildren rule is
    // archived-inclusive, and effectiveBudget must apply the exact same rule.
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(coffee);

    expect(effectiveBudget('household', null, food, '2026-02').carryCents).toBe(40000);
  });
});

describe('effectiveBudget — scope independence', () => {
  it('keeps personal and household rollover carries independent for the same category', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    setRollover({ scope: 'personal', userId: alice, categoryId: groceries, enabled: true, startMonth: '2026-01' });

    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 100000 });
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-01', amountCents: 30000 });

    // Household scope counts EVERY row regardless of attribution (categorySpend's own,
    // pre-existing rule), so its total is both transactions: $20000 (Alice) + $50000
    // (unattributed) = $70000 against a $100000 base -> leftover 30000. Personal (Alice)
    // scope counts only HER attributed row: $20000 against her own $30000 base -> leftover
    // 10000 -- a different number computed a different way, proving the two do not share
    // state.
    spend({ categoryId: groceries, amountCents: -20000, date: onMonth('2026-01'), attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -50000, date: onMonth('2026-01'), attributedUserId: null });

    expect(effectiveBudget('household', null, groceries, '2026-02').carryCents).toBe(30000);
    expect(effectiveBudget('personal', alice, groceries, '2026-02').carryCents).toBe(10000);
  });

  it('throws for personal scope without a user, the same guard budgetProgress and categorySpend already have', () => {
    setup();
    expect(() => effectiveBudget('personal', null, 1, '2026-03')).toThrowError(/requires a user/);
  });
});

describe('budgetProgress — rollover-aware rows', () => {
  it('exposes baseLimitCents, carryCents and an effective limitCents consistently, with limitCents === base + carry', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 100000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 90000 });
    spend({ categoryId: groceries, amountCents: -80000, date: onMonth('2026-01') }); // leftover 20000

    const row = budgetProgress('2026-02').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row.baseLimitCents).toBe(90000);
    expect(row.carryCents).toBe(20000);
    expect(row.limitCents).toBe(110000);
    expect(row.remainingCents).toBe(110000 - row.spentCents);
  });

  it('leaves limitCents, baseLimitCents equal and carryCents at 0 for a category with no rollover, unchanged from before this feature', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 80000 });
    spend({ categoryId: groceries, amountCents: -20000, date: onMonth('2026-03') });

    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row).toMatchObject({ limitCents: 80000, baseLimitCents: 80000, carryCents: 0, spentCents: 20000, remainingCents: 60000 });
  });
});

describe('budgetTotals — rollover', () => {
  it('sums the EFFECTIVE limits, not the base ones', () => {
    const { db, spend } = setup();
    // budgetTotals sums TOP-LEVEL rows only (children are already rolled into their parent),
    // so the rollover target here must itself be top-level -- Kids has no children in the
    // seed tree, which also keeps this fixture free of any rollup interaction.
    const kids = categoryIdByName(db, 'Kids');
    setRollover({ scope: 'household', userId: null, categoryId: kids, enabled: true, startMonth: '2026-01' });
    upsertBudget({ scope: 'household', userId: null, categoryId: kids, month: '2026-01', amountCents: 100000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: kids, month: '2026-02', amountCents: 90000 });
    spend({ categoryId: kids, amountCents: -80000, date: onMonth('2026-01') }); // leftover 20000

    const rows = budgetProgress('2026-02');
    // budgetedLimitCents must reflect 90000 (base) + 20000 (carry) = 110000, not the bare base.
    expect(budgetTotals(rows).budgetedLimitCents).toBe(110000);
  });
});

describe('setRollover', () => {
  it('turning it off deletes the row and returns behaviour to no-carry', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 100000 });
    spend({ categoryId: groceries, amountCents: -80000, date: onMonth('2026-01') });
    expect(effectiveBudget('household', null, groceries, '2026-02').carryCents).toBe(20000);

    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: false, startMonth: '2026-01' });

    expect(rolloverStartMonth('household', null, groceries)).toBeNull();
    expect(effectiveBudget('household', null, groceries, '2026-02').carryCents).toBe(0);
  });

  it('re-enabling an already-on rollover does not move its startMonth', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-01' });
    setRollover({ scope: 'household', userId: null, categoryId: groceries, enabled: true, startMonth: '2026-06' });

    expect(rolloverStartMonth('household', null, groceries)).toBe('2026-01');
  });

  it('throws for personal scope without a user', () => {
    setup();
    expect(() => setRollover({ scope: 'personal', userId: null, categoryId: 1, enabled: true, startMonth: '2026-01' })).toThrowError(
      /requires a user/,
    );
  });

  it('throws for household scope with a user', () => {
    const { alice } = setup();
    expect(() =>
      setRollover({ scope: 'household', userId: alice, categoryId: 1, enabled: true, startMonth: '2026-01' }),
    ).toThrowError(/must not have a user/);
  });
});
