import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { bulkConfirmOwnCategory } from '@/lib/transactions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const alice = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const joint = insertTestAccount(current.db, { name: 'Joint Chequing' });
  const add = (over: Partial<{ description: string; categoryId: number | null; source: string }> = {}) => {
    const description = over.description ?? 'CORNER MARKET';
    return current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${joint}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, -1000, ${over.categoryId ?? null}, ${over.source ?? 'rule'}, ${alice}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  };
  const stored = (id: number) =>
    current!.sqlite.prepare('select category_id as categoryId, categorization_source as source from transactions where id = ?').get(id) as {
      categoryId: number | null;
      source: string;
    };
  return { db: current.db, alice, add, stored };
}

/**
 * Spec 2026-09-28 §2.3. Ten groups, one press: each row is confirmed to the category it ALREADY
 * has, through the same confirmCategory loop bulkSetCategory runs, with createRule: false.
 */
describe('bulkConfirmOwnCategory', () => {
  it('confirms each row to its own category and counts the categories it touched', () => {
    const { db, alice, add, stored } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add({ description: 'CORNER MARKET', categoryId: groceries });
    const b = add({ description: 'GROCER 88', categoryId: groceries });
    const c = add({ description: 'CAFE ROMA', categoryId: coffee });

    const result = bulkConfirmOwnCategory(
      [
        { id: a, categoryId: groceries, source: 'rule' },
        { id: b, categoryId: groceries, source: 'rule' },
        { id: c, categoryId: coffee, source: 'rule' },
      ],
      alice,
      'admin',
    );

    expect(result).toEqual({ changed: 3, skipped: 0, uncategorized: 0, alreadyConfirmed: 0, categories: 2 });
    expect(stored(a)).toEqual({ categoryId: groceries, source: 'manual' });
    expect(stored(c)).toEqual({ categoryId: coffee, source: 'manual' });
  });

  it('leaves a row with no category alone and counts it -- there is nothing to confirm', () => {
    const { alice, add, stored } = setup();
    const none = add({ description: 'MYSTERY VENDOR', categoryId: null, source: 'none' });

    const result = bulkConfirmOwnCategory([{ id: none, categoryId: null, source: 'none' }], alice, 'admin');

    expect(result).toEqual({ changed: 0, skipped: 0, uncategorized: 1, alreadyConfirmed: 0, categories: 0 });
    expect(stored(none)).toEqual({ categoryId: null, source: 'none' });
  });

  it('leaves a row already set by hand out of the count', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const done = add({ categoryId: groceries, source: 'manual' });

    const result = bulkConfirmOwnCategory([{ id: done, categoryId: groceries, source: 'manual' }], alice, 'admin');

    expect(result).toEqual({ changed: 0, skipped: 0, uncategorized: 0, alreadyConfirmed: 1, categories: 0 });
  });

  it('writes no rule, because confirming is not new information', () => {
    const { db, alice, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const a = add({ categoryId: groceries });
    bulkConfirmOwnCategory([{ id: a, categoryId: groceries, source: 'rule' }], alice, 'admin');
    expect((current!.sqlite.prepare('select count(*) as n from merchant_rules').get() as { n: number }).n).toBe(0);
  });
});
