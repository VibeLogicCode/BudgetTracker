import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { budgetProgress, budgetTotals, categorySpend, categoryTransactions, clearBudget, copyBudgetsFromPreviousMonth, flattenBudgetRows, resolveBudget, upsertBudget } from '@/lib/budgets';
import { nowIso } from '@/lib/clock';
// Lane 1 (2026-08-30 plan): categoryTransactions is split-aware, the same way categorySpend
// (immediately below) already is -- one test proves it by actually splitting a transaction,
// rather than trusting that reusing EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT was enough.
import { setTransactionSplits } from '@/lib/splits';

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
  const spend = (over: { categoryId: number | null; amountCents: number; date?: string; attributedUserId?: number | null; isTransfer?: boolean }) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${joint}, ${over.date ?? '2026-03-10'}, 'X', 'X', ${over.amountCents}, ${over.categoryId}, 'manual', ${over.isTransfer ? 1 : 0}, ${over.attributedUserId ?? null}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, alice, bob, joint, spend };
}

describe('resolveBudget', () => {
  it('returns null when no budget was ever set', () => {
    const { db } = setup();
    expect(resolveBudget('household', null, categoryIdByName(db, 'Groceries'), '2026-03')).toBeNull();
  });

  it('applies a budget from its effective month forward', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 80000 });

    expect(resolveBudget('household', null, groceries, '2026-01')).toBeNull();
    expect(resolveBudget('household', null, groceries, '2026-02')).toBe(80000);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(80000);
    expect(resolveBudget('household', null, groceries, '2027-01')).toBe(80000);
  });

  it('uses the newest row at or before the viewed month', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 70000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-05', amountCents: 90000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 80000 });

    expect(resolveBudget('household', null, groceries, '2026-02')).toBe(70000);
    expect(resolveBudget('household', null, groceries, '2026-04')).toBe(80000);
    expect(resolveBudget('household', null, groceries, '2026-06')).toBe(90000);
  });

  it('treats a NULL amount as "cleared from this month forward", distinct from zero', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 70000 });
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-04' });

    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(70000);
    expect(resolveBudget('household', null, groceries, '2026-04')).toBeNull();
    expect(resolveBudget('household', null, groceries, '2026-09')).toBeNull();

    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-06', amountCents: 0 });
    expect(resolveBudget('household', null, groceries, '2026-06')).toBe(0);
  });

  it('keeps household and personal budgets independent', () => {
    const { db, alice, bob } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 80000 });
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-03', amountCents: 20000 });

    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(80000);
    expect(resolveBudget('personal', alice, groceries, '2026-03')).toBe(20000);
    expect(resolveBudget('personal', bob, groceries, '2026-03')).toBeNull();
  });

  it('upserting twice in the same month overwrites rather than duplicating', () => {
    const { db, sqlite } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 80000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 85000 });
    expect((sqlite.prepare('select count(*) as c from budgets').get() as { c: number }).c).toBe(1);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(85000);
  });

  it('editing at month M never mutates an earlier row', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 70000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-06', amountCents: 95000 });
    expect(resolveBudget('household', null, groceries, '2026-01')).toBe(70000);
    expect(resolveBudget('household', null, groceries, '2026-05')).toBe(70000);
    expect(resolveBudget('household', null, groceries, '2026-06')).toBe(95000);
  });

  it('rejects a malformed month key', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    expect(() => upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-3', amountCents: 100 })).toThrowError(/YYYY-MM/);
  });
});

describe('categorySpend — netting, transfers and attribution', () => {
  it('nets refunds against spend in the same category', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -12000 });
    spend({ categoryId: groceries, amountCents: 2000 }); // refund
    expect(categorySpend('2026-03').get(groceries)).toBe(10000);
  });

  it('excludes transfers entirely', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -5000 });
    spend({ categoryId: groceries, amountCents: -100000, isTransfer: true });
    expect(categorySpend('2026-03').get(groceries)).toBe(5000);
  });

  it('only counts the requested month', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -5000, date: '2026-02-28' });
    spend({ categoryId: groceries, amountCents: -7000, date: '2026-03-01' });
    spend({ categoryId: groceries, amountCents: -9000, date: '2026-03-31' });
    spend({ categoryId: groceries, amountCents: -1000, date: '2026-04-01' });
    expect(categorySpend('2026-03').get(groceries)).toBe(16000);
  });

  it('scopes personal spend on attributed_user_id, not the account owner', () => {
    const { db, alice, bob, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -5000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -3000, attributedUserId: bob });
    spend({ categoryId: groceries, amountCents: -2000, attributedUserId: null });

    expect(categorySpend('2026-03').get(groceries)).toBe(10000);
    expect(categorySpend('2026-03', { attributedUserId: alice }).get(groceries)).toBe(5000);
    expect(categorySpend('2026-03', { attributedUserId: bob }).get(groceries)).toBe(3000);
  });

  it('ignores uncategorized rows', () => {
    const { spend } = setup();
    spend({ categoryId: null, amountCents: -4000 });
    expect(categorySpend('2026-03').size).toBe(0);
  });
});

/**
 * Lane 1 (2026-08-30 plan): the read the Budgets card's "View breakdown" drill-down needs to
 * show a category's own transactions rather than just its total. Written before the
 * implementation (categoryTransactions, below categorySpend in src/lib/budgets.ts) -- every
 * assertion here failed against a stub that returned [] before the real query was written.
 * Scoping mirrors categorySpend's own tests one section up: same household/personal split, same
 * transfer exclusion, same "requires a user" guard for personal scope.
 */
describe('categoryTransactions — the Lane 1 breakdown drill-down', () => {
  it('lists this category\'s own transactions for the month, newest first, with a real merchant name', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -1200, date: '2026-03-05' });
    spend({ categoryId: groceries, amountCents: -3400, date: '2026-03-20' });
    const rows = categoryTransactions('2026-03', groceries);
    expect(rows.map((r) => r.amountCents)).toEqual([-3400, -1200]);
    expect(rows[0].merchant).toBe('X'); // the spend() fixture's raw_description
    expect(rows[0].date).toBe('2026-03-20');
  });

  it('excludes another category and another month', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    spend({ categoryId: coffee, amountCents: -500, date: '2026-03-10' });
    spend({ categoryId: groceries, amountCents: -700, date: '2026-02-10' });
    expect(categoryTransactions('2026-03', groceries)).toEqual([]);
  });

  it('excludes transfers', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -900, isTransfer: true });
    expect(categoryTransactions('2026-03', groceries)).toEqual([]);
  });

  it('scopes personal by attributedUserId, same as categorySpend', () => {
    const { db, alice, bob, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -1000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -2000, attributedUserId: bob });
    const rows = categoryTransactions('2026-03', groceries, { scope: 'personal', attributedUserId: alice });
    expect(rows.map((r) => r.amountCents)).toEqual([-1000]);
  });

  it('household scope counts every attribution, ignoring attributedUserId if also passed', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -1000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -2000, attributedUserId: null });
    const rows = categoryTransactions('2026-03', groceries, { scope: 'household', attributedUserId: alice });
    expect(rows).toHaveLength(2);
  });

  it('throws for personal scope without a user, the same trap categorySpend guards against', () => {
    setup();
    expect(() => categoryTransactions('2026-03', 1, { scope: 'personal' })).toThrowError(/requires a user/);
  });

  it('is split-aware: a split part contributes its own category and amount, not the parent transaction\'s', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = spend({ categoryId: groceries, amountCents: -10000 });
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -6000 },
        { categoryId: restaurants, amountCents: -4000 },
      ],
      userId: alice,
    });
    expect(categoryTransactions('2026-03', groceries).map((r) => r.amountCents)).toEqual([-6000]);
    expect(categoryTransactions('2026-03', restaurants).map((r) => r.amountCents)).toEqual([-4000]);
  });
});

describe('budgetProgress', () => {
  it('nests children under parents and rolls their spend up', () => {
    const { db, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    spend({ categoryId: food, amountCents: -1000 });
    spend({ categoryId: groceries, amountCents: -20000 });
    spend({ categoryId: coffee, amountCents: -3000 });

    const rows = budgetProgress('2026-03');
    const foodRow = rows.find((r) => r.categoryId === food)!;
    expect(foodRow.spentCents).toBe(24000);
    expect(foodRow.children.find((c) => c.categoryId === groceries)?.spentCents).toBe(20000);
    expect(foodRow.children.find((c) => c.categoryId === coffee)?.spentCents).toBe(3000);
  });

  it('computes remaining and percentage against the resolved limit', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 80000 });
    spend({ categoryId: groceries, amountCents: -20000 });

    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row).toMatchObject({ limitCents: 80000, spentCents: 20000, remainingCents: 60000 });
    expect(row.pct).toBeCloseTo(25, 6);
  });

  it('reports a negative remaining when over budget', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 10000 });
    spend({ categoryId: groceries, amountCents: -15000 });
    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row.remainingCents).toBe(-5000);
    expect(row.pct).toBeCloseTo(150, 6);
  });

  it('leaves remaining and pct null when there is no limit', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -15000 });
    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row).toMatchObject({ limitCents: null, remainingCents: null, pct: null });
  });

  it('scopes personal progress by attribution, leaving unattributed spend to the household', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 80000 });
    upsertBudget({ scope: 'personal', userId: alice, categoryId: groceries, month: '2026-03', amountCents: 20000 });
    spend({ categoryId: groceries, amountCents: -5000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -7000, attributedUserId: null });

    const household = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    const personal = budgetProgress('2026-03', 'personal', alice).flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;

    expect(household).toMatchObject({ limitCents: 80000, spentCents: 12000 });
    expect(personal).toMatchObject({ limitCents: 20000, spentCents: 5000 });
  });

  it('totals only the top level so children are not double counted', () => {
    const { db, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 100000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 60000 });
    spend({ categoryId: groceries, amountCents: -20000 });

    const rows = budgetProgress('2026-03');
    expect(budgetTotals(rows)).toEqual({ budgetedLimitCents: 100000, budgetedSpentCents: 20000, totalSpentCents: 20000 });
  });

  it('omits an archived category with no limit and no spend', () => {
    const { db, sqlite } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(coffee);
    const rows = budgetProgress('2026-03');
    expect(rows.flatMap((r) => r.children).some((c) => c.categoryId === coffee)).toBe(false);
  });

  // v1.12.1 (item S / MON-1): this used to assert `false` unconditionally -- omitting an archived
  // child even when it still carried real spend, which is exactly the compounding half of MON-1
  // (the limit vanished from every total while the spend went on counting against the parent, with
  // no row left to explain why). An archived child with spend is now a read-only row, same as an
  // archived child with a limit.
  it('keeps an archived category that still carries spend, unlike one with neither limit nor spend', () => {
    const { db, sqlite, spend } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(coffee);
    spend({ categoryId: coffee, amountCents: -1000 });
    const rows = budgetProgress('2026-03');
    expect(rows.flatMap((r) => r.children).some((c) => c.categoryId === coffee)).toBe(true);
  });
});

describe('copyBudgetsFromPreviousMonth', () => {
  it('writes rows at the viewed month for everything that resolved last month', () => {
    const { db, sqlite } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 80000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: coffee, month: '2026-01', amountCents: 5000 });

    expect(copyBudgetsFromPreviousMonth('2026-03', 'household', null)).toBe(2);
    const rows = sqlite.prepare("select category_id, amount_cents from budgets where effective_month = '2026-03' order by category_id").all();
    expect(rows).toHaveLength(2);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(80000);
  });

  it('copies an ARCHIVED category’s limit too, matching what budgetProgress surfaces', () => {
    const { db, sqlite } = setup();
    const kids = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: kids, month: '2026-02', amountCents: 30000 });
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(kids);

    // budgetProgress keeps rendering an archived category that still carries spend, so
    // dropping its limit here would have silently reclassified budgeted spend as
    // unbudgeted the month after somebody archived it.
    expect(copyBudgetsFromPreviousMonth('2026-03', 'household', null)).toBe(1);
    expect(resolveBudget('household', null, kids, '2026-03')).toBe(30000);
  });

  it('does not copy a cleared budget', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-01', amountCents: 80000 });
    clearBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02' });
    expect(copyBudgetsFromPreviousMonth('2026-03', 'household', null)).toBe(0);
  });

  it('overwrites an existing row for the viewed month', () => {
    const { db, sqlite } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-02', amountCents: 80000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 10000 });
    copyBudgetsFromPreviousMonth('2026-03', 'household', null);
    expect(resolveBudget('household', null, groceries, '2026-03')).toBe(80000);
    expect((sqlite.prepare('select count(*) as c from budgets').get() as { c: number }).c).toBe(2);
  });
});

describe('budgetTotals — review finding 1: unbudgeted spend must not pollute the budgeted ratio', () => {
  it('separates budgeted limit/spend (rows with a resolved limit) from total spend (every non-income row)', () => {
    const { db, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const kids = categoryIdByName(db, 'Kids');
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 10000 });
    spend({ categoryId: food, amountCents: -8000 });
    spend({ categoryId: kids, amountCents: -32000 }); // Kids never budgeted this month

    const totals = budgetTotals(budgetProgress('2026-03'));
    // Old bug: totalCents mixed ALL non-income spend against ONLY the budgeted limit,
    // reading as "$40,000 of $10,000 budgeted" (400% over) even though $32,000 of that
    // was never budgeted at all.
    expect(totals).toEqual({ budgetedLimitCents: 10000, budgetedSpentCents: 8000, totalSpentCents: 40000 });
  });
});

describe('budgetProgress — review finding 2: archived-category spend', () => {
  // v1.12.1 (item S / MON-1): this used to assert the child was never rendered as its own row --
  // that was the compounding half of the defect (spend rolled up, but the row that would have
  // explained why was suppressed). An archived child that still carries real spend now surfaces
  // as a read-only row, same as one that still carries a limit; the rollup into the parent is
  // unchanged.
  it("rolls an archived child's spend into its live parent, rendering the child as a read-only row", () => {
    const { db, sqlite, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(coffee);
    spend({ categoryId: groceries, amountCents: -20000 });
    spend({ categoryId: coffee, amountCents: -3000 });

    const rows = budgetProgress('2026-03');
    const foodRow = rows.find((r) => r.categoryId === food)!;
    expect(foodRow.spentCents).toBe(23000); // groceries (20000) + archived coffee (3000), no longer dropped
    expect(foodRow.children.some((c) => c.categoryId === coffee)).toBe(true);
  });

  it('surfaces an archived top-level category with real spend as a read-only row and folds it into totalSpentCents', () => {
    const { db, sqlite, spend } = setup();
    const kids = categoryIdByName(db, 'Kids');
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(kids);
    spend({ categoryId: kids, amountCents: -4000 });

    const rows = budgetProgress('2026-03');
    const kidsRow = rows.find((r) => r.categoryId === kids);
    expect(kidsRow).toBeDefined();
    expect(kidsRow).toMatchObject({ isArchived: true, spentCents: 4000, limitCents: null });
    expect(budgetTotals(rows).totalSpentCents).toBe(4000);
  });

  it('does not surface an archived top-level category with no spend this month', () => {
    const { db, sqlite } = setup();
    const kids = categoryIdByName(db, 'Kids');
    sqlite.prepare('update categories set is_archived = 1 where id = ?').run(kids);
    const rows = budgetProgress('2026-03');
    expect(rows.some((r) => r.categoryId === kids)).toBe(false);
  });
});

describe('categorySpend — review finding 3: scope option', () => {
  it('scope "household" counts everyone, ignoring attributedUserId if one is also passed', () => {
    const { db, alice, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -5000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -3000, attributedUserId: null });
    expect(categorySpend('2026-03', { scope: 'household', attributedUserId: alice }).get(groceries)).toBe(8000);
  });

  it('scope "personal" filters to the given attributedUserId', () => {
    const { db, alice, bob, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -5000, attributedUserId: alice });
    spend({ categoryId: groceries, amountCents: -3000, attributedUserId: bob });
    expect(categorySpend('2026-03', { scope: 'personal', attributedUserId: alice }).get(groceries)).toBe(5000);
  });

  it('throws for scope "personal" without a user, the same trap resolveBudget already guards against', () => {
    setup();
    expect(() => categorySpend('2026-03', { scope: 'personal' })).toThrowError(/requires a user/);
  });
});

describe('budgetProgress — review finding 4: personal scope requires a user', () => {
  it('throws instead of silently returning household spend labelled personal', () => {
    setup();
    expect(() => budgetProgress('2026-03', 'personal', null)).toThrowError(/requires a user/);
  });
});

describe('budgetProgress — review finding 5: a $0 limit is not the same as no limit', () => {
  it('reports 100% and overBudget=true when a $0 limit has real spend against it', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 0 });
    spend({ categoryId: groceries, amountCents: -1500 });
    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row.limitCents).toBe(0);
    expect(row.pct).toBe(100);
    expect(row.overBudget).toBe(true);
    expect(row.remainingCents).toBe(-1500);
  });

  it('reports 0% and overBudget=false for a $0 limit with no spend', () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 0 });
    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row.pct).toBe(0);
    expect(row.overBudget).toBe(false);
  });

  it('keeps pct null and overBudget=false for no limit at all, distinct from an explicit $0 limit', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    spend({ categoryId: groceries, amountCents: -1500 });
    const row = budgetProgress('2026-03').flatMap((r) => r.children).find((r) => r.categoryId === groceries)!;
    expect(row.limitCents).toBeNull();
    expect(row.pct).toBeNull();
    expect(row.overBudget).toBe(false);
  });
});

describe('budgetProgress — review finding 7 (folded): income categories are not budgetable rows', () => {
  it('excludes income categories, and their children, from the returned rows entirely', () => {
    const { db, spend } = setup();
    const income = categoryIdByName(db, 'Income');
    const salary = categoryIdByName(db, 'Salary');
    spend({ categoryId: salary, amountCents: 500000 });
    const rows = budgetProgress('2026-03');
    expect(rows.some((r) => r.categoryId === income)).toBe(false);
    expect(rows.flatMap((r) => r.children).some((c) => c.categoryId === salary)).toBe(false);
  });
});

describe('budgetTotals counts limits set on sub-categories (item S / MON-1, ruling P3)', () => {
  it('sums the children when the parent carries no limit of its own', () => {
    const { db, spend } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const restaurants = categoryIdByName(db, 'Restaurants');
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 60000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: restaurants, month: '2026-03', amountCents: 20000 });
    spend({ categoryId: groceries, amountCents: -50000 });
    spend({ categoryId: restaurants, amountCents: -15000 });

    const totals = budgetTotals(budgetProgress('2026-03'));
    // The defect: this used to be 0, and the dashboard said "$0.00 left in budgets" while the
    // page itself rendered both child limits correctly one row down.
    expect(totals.budgetedLimitCents).toBe(80000);
    expect(totals.budgetedSpentCents).toBe(65000);
    expect(totals.totalSpentCents).toBe(65000);
  });

  it('does not double count: a parent with its own limit supersedes its children (ruling P3)', () => {
    const { db, spend } = setup();
    const food = categoryIdByName(db, 'Food');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertBudget({ scope: 'household', userId: null, categoryId: food, month: '2026-03', amountCents: 100000 });
    upsertBudget({ scope: 'household', userId: null, categoryId: groceries, month: '2026-03', amountCents: 60000 });
    spend({ categoryId: groceries, amountCents: -50000 });

    const totals = budgetTotals(budgetProgress('2026-03'));
    // 100000, NOT 160000: the parent's spentCents already rolls the child's in, so adding both
    // limits would compare one pot of spending against two pots of budget.
    expect(totals.budgetedLimitCents).toBe(100000);
    expect(totals.budgetedSpentCents).toBe(50000);
  });

  it('keeps an archived child that still carries a limit and spend', () => {
    const { db, spend } = setup();
    const restaurants = categoryIdByName(db, 'Restaurants');
    upsertBudget({ scope: 'household', userId: null, categoryId: restaurants, month: '2026-03', amountCents: 20000 });
    spend({ categoryId: restaurants, amountCents: -15000 });
    db.run(sql`update categories set is_archived = 1 where id = ${restaurants}`);

    const rows = budgetProgress('2026-03');
    const food = rows.find((row) => row.categoryName === 'Food');
    expect(food?.children.map((child) => child.categoryName)).toContain('Restaurants');
    // The compounding half of MON-1: the spend kept rolling into Food while the limit vanished,
    // so Food read as over budget for no visible reason.
    expect(budgetTotals(rows).budgetedLimitCents).toBe(20000);
  });

  it('drops an archived child that carries neither a limit nor spend', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    db.run(sql`update categories set is_archived = 1 where id = ${coffee}`);

    const food = budgetProgress('2026-03').find((row) => row.categoryName === 'Food');
    expect(food?.children.map((child) => child.categoryName)).not.toContain('Coffee');
  });
});

describe('flattenBudgetRows (moved here from notify/evaluate/pace.ts, ruling P2)', () => {
  it('returns parents and children in depth-first order', () => {
    const { db } = setup();
    upsertBudget({
      scope: 'household',
      userId: null,
      categoryId: categoryIdByName(db, 'Groceries'),
      month: '2026-03',
      amountCents: 60000,
    });
    const names = flattenBudgetRows(budgetProgress('2026-03')).map((row) => row.categoryName);
    expect(names.indexOf('Food')).toBeLessThan(names.indexOf('Groceries'));
  });
});
