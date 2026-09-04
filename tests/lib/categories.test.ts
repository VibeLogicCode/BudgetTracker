import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, type TestDb } from '../helpers/db';
import {
  archiveCategory,
  categoryLabel,
  categoryTree,
  categoryWithDescendants,
  createCategory,
  listCategories,
  renameCategory,
  setCategoryTaxRelevant,
} from '@/lib/categories';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('categories', () => {
  it('lists the seeded tree with parents first', () => {
    current = createSeededTestDb();
    const tree = categoryTree();
    expect(tree).toHaveLength(9);
    expect(tree[0].name).toBe('Income');
    expect(tree[0].children.map((c) => c.name)).toEqual(['Salary', 'Other Income']);
    expect(tree.find((c) => c.name === 'Kids')?.children).toEqual([]);
  });

  it('rolls a parent up to include every child (max depth 2)', () => {
    current = createSeededTestDb();
    const food = categoryIdByName(current.db, 'Food');
    const groceries = categoryIdByName(current.db, 'Groceries');
    const ids = categoryWithDescendants(food);
    expect(ids).toContain(food);
    expect(ids).toContain(groceries);
    expect(ids).toHaveLength(4);
    expect(categoryWithDescendants(groceries)).toEqual([groceries]);
  });

  it('labels a category with its parent for disambiguation', () => {
    current = createSeededTestDb();
    const all = listCategories();
    const general = categoryIdByName(current.db, 'General');
    expect(categoryLabel(general, all)).toBe('Shopping › General');
    expect(categoryLabel(categoryIdByName(current.db, 'Kids'), all)).toBe('Kids');
    expect(categoryLabel(null, all)).toBe('Uncategorized');
  });

  it('archives instead of deleting and hides archived rows by default', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    archiveCategory(coffee, true);
    expect(listCategories().some((c) => c.id === coffee)).toBe(false);
    expect(listCategories({ includeArchived: true }).some((c) => c.id === coffee)).toBe(true);
    const stillThere = current.sqlite.prepare('select is_archived from categories where id = ?').get(coffee) as { is_archived: number };
    expect(stillThere.is_archived).toBe(1);
  });

  it('creates and renames custom categories', () => {
    current = createSeededTestDb();
    const food = categoryIdByName(current.db, 'Food');
    const id = createCategory({ name: 'Takeout', parentId: food });
    expect(listCategories().find((c) => c.id === id)).toMatchObject({ name: 'Takeout', parentId: food });
    renameCategory(id, 'Delivery');
    expect(listCategories().find((c) => c.id === id)?.name).toBe('Delivery');
  });

  it('rejects a third level of nesting', () => {
    current = createSeededTestDb();
    const groceries = categoryIdByName(current.db, 'Groceries');
    expect(() => createCategory({ name: 'Too Deep', parentId: groceries })).toThrowError(/two levels/i);
  });
});

// v1.7.0, Task 15a (spec 2026-08-22): the tax-relevant flag consumed by src/lib/tax.ts and
// toggled from the categories manager's Tax checkbox.
describe('taxRelevant flag', () => {
  it('defaults to false and is exposed on CategoryRecord', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    expect(listCategories().find((c) => c.id === coffee)?.taxRelevant).toBe(false);
  });

  it('setCategoryTaxRelevant toggles the flag on and back off', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    setCategoryTaxRelevant(coffee, true);
    expect(listCategories().find((c) => c.id === coffee)?.taxRelevant).toBe(true);
    setCategoryTaxRelevant(coffee, false);
    expect(listCategories().find((c) => c.id === coffee)?.taxRelevant).toBe(false);
  });

  it('is carried on both parent and child nodes in categoryTree', () => {
    current = createSeededTestDb();
    const food = categoryIdByName(current.db, 'Food');
    const groceries = categoryIdByName(current.db, 'Groceries');
    setCategoryTaxRelevant(food, true);
    setCategoryTaxRelevant(groceries, true);

    const foodNode = categoryTree().find((c) => c.id === food)!;
    expect(foodNode.taxRelevant).toBe(true);
    expect(foodNode.children.find((c) => c.id === groceries)?.taxRelevant).toBe(true);
    expect(foodNode.children.find((c) => c.name === 'Coffee')?.taxRelevant).toBe(false);
  });
});

/**
 * C-05 half 2 (controller ruling R2): the create-time and flip-time guards for the invariant
 * budgetProgress's Half 1 (src/lib/budgets.ts) only makes existing violations of render
 * tolerantly, rather than fixing -- a non-income category must never end up parented by an
 * income one. Two independent ways that shape can arise, two independent guards.
 */
describe('C-05 half 2: a non-income category must never be parented by an income one', () => {
  it('refuses creating a non-income category under an income parent', () => {
    current = createSeededTestDb();
    // "Income" itself, not "Salary" -- Salary is already a level-2 category, and
    // createCategory's separate two-level-nesting guard rejects a child under it first, which
    // would prove nothing about THIS guard.
    const income = categoryIdByName(current.db, 'Income');
    expect(() => createCategory({ name: 'Work expenses', parentId: income, isIncome: false })).toThrowError(
      /income/i,
    );
  });

  it('still allows an income child under an income parent (the ordinary, unflagged case)', () => {
    current = createSeededTestDb();
    const income = categoryIdByName(current.db, 'Income');
    const id = createCategory({ name: 'Bonus', parentId: income });
    expect(listCategories().find((c) => c.id === id)).toMatchObject({ isIncome: true });
  });

  /**
   * v1.31.0 item M-5: the two flip-time tests that used to sit here are gone with the function
   * they drove. `setCategoryIncome` had no caller outside them -- nothing in this app changes
   * `is_income` on an existing category -- so what they proved was that an unreachable guard
   * worked, which is the same standing `categorySpendWithRollup` was deleted for in v1.30.0. The
   * create-time guard above is the whole of the invariant that is actually reachable today.
   */
  it('refuses an EXPLICIT non-income override even when it merely restates the default', () => {
    current = createSeededTestDb();
    // The one shape that reaches this from real code: src/lib/packs.ts's importer always passes
    // is_income explicitly (`meta?.is_income ?? false`), so a pack child of an income parent that
    // declares nothing arrives here as a deliberate-looking `false`. v1.31.0's R-04(b) pre-flight
    // (assertPackFitsCategoryTree) is what a pack importer actually meets; this stays the backstop
    // underneath it.
    const income = categoryIdByName(current.db, 'Income');
    expect(() => createCategory({ name: 'Reimbursements', parentId: income, isIncome: false })).toThrowError(
      /spend category cannot be created under an income category/i,
    );
    expect(listCategories().some((c) => c.name === 'Reimbursements')).toBe(false);
  });
});
