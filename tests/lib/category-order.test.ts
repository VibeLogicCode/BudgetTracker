import { describe, it, expect } from 'vitest';
import { categoryOptions, orderedCategoryRows } from '@/lib/category-order';
import type { CategoryRecord } from '@/lib/categories';

/**
 * Task 6 (spec 2026-08-23, v1.8.0): categoryOptions() is the shared flattening helper behind
 * every category <select> in the app. These fixtures are plain object literals, never a real
 * CategoryRecord from the database -- the whole point of this module is that it needs none of
 * @/lib/categories' database access, only the shape of its exported type.
 */
describe('categoryOptions', () => {
  it('places each child directly after its parent', () => {
    const all = [
      { id: 1, name: 'Food', parentId: null, sortOrder: 0 },
      { id: 2, name: 'Transport', parentId: null, sortOrder: 1 },
      { id: 3, name: 'Groceries', parentId: 1, sortOrder: 0 },
      { id: 4, name: 'Gas', parentId: 2, sortOrder: 0 },
    ] as CategoryRecord[];
    expect(categoryOptions(all).map((o) => `${o.depth}:${o.label}`)).toEqual([
      '0:Food',
      '1:Groceries',
      '0:Transport',
      '1:Gas',
    ]);
  });

  it('orders by sortOrder then id, matching the Budgets page', () => {
    // Same sortOrder values as the previous test, but shuffled array position and shuffled
    // ids -- proves the ordering comes from sortOrder/id, not from input array order.
    const all = [
      { id: 4, name: 'Gas', parentId: 2, sortOrder: 0 },
      { id: 2, name: 'Transport', parentId: null, sortOrder: 1 },
      { id: 3, name: 'Groceries', parentId: 1, sortOrder: 0 },
      { id: 1, name: 'Food', parentId: null, sortOrder: 0 },
    ] as CategoryRecord[];
    expect(categoryOptions(all).map((o) => `${o.depth}:${o.label}`)).toEqual([
      '0:Food',
      '1:Groceries',
      '0:Transport',
      '1:Gas',
    ]);
  });

  it('keeps an orphan whose parent is archived or missing, at depth 0', () => {
    // Dropping it would make a category unselectable with no way to notice.
    const all = [
      { id: 1, name: 'Food', parentId: null, sortOrder: 0, isArchived: true },
      { id: 2, name: 'Groceries', parentId: 1, sortOrder: 0 }, // parent (1) is archived
      { id: 3, name: 'Gas', parentId: 999, sortOrder: 1 }, // parent (999) does not exist
    ] as CategoryRecord[];
    expect(categoryOptions(all)).toEqual([
      { id: 2, label: 'Groceries', depth: 0 },
      { id: 3, label: 'Gas', depth: 0 },
    ]);
  });

  it('excludes archived categories', () => {
    const all = [
      { id: 1, name: 'Food', parentId: null, sortOrder: 0 },
      { id: 2, name: 'Groceries', parentId: 1, sortOrder: 0 },
      { id: 3, name: 'Takeout', parentId: 1, sortOrder: 1, isArchived: true },
    ] as CategoryRecord[];
    expect(categoryOptions(all)).toEqual([
      { id: 1, label: 'Food', depth: 0 },
      { id: 2, label: 'Groceries', depth: 1 },
    ]);
  });
});

describe('orderedCategoryRows (backlog 2a: the admin table keeps archived rows, so it cannot use categoryOptions)', () => {
  const row = (id: number, name: string, parentId: number | null, sortOrder: number, isArchived = false) => ({ id, name, parentId, sortOrder, isArchived });

  it('places every child directly after its own parent, archived rows included', () => {
    const rows = [
      row(1, 'Kids', null, 0),
      row(2, 'Fees', null, 1),
      row(3, 'Bank Fees', 2, 2),
      row(4, 'Interest', 2, 3),
      row(5, 'Education', 1, 4),
      row(6, 'Activities', 1, 5, true),
    ];
    expect(orderedCategoryRows(rows).map((r) => `${r.depth}:${r.row.name}`)).toEqual([
      '0:Kids', '1:Education', '1:Activities', '0:Fees', '1:Bank Fees', '1:Interest',
    ]);
  });

  it('promotes a child whose parent is missing from the list to the top level', () => {
    expect(orderedCategoryRows([row(5, 'Education', 99, 0)])).toEqual([{ row: row(5, 'Education', 99, 0), depth: 0 }]);
  });
});
