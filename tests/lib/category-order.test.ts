import { describe, it, expect } from 'vitest';
import { categoryOptionGroups, categoryOptions, categorySelectOptions, orderedCategoryRows } from '@/lib/category-order';
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

/**
 * v1.57.2: one rule for every picker. An ASSIGNMENT picker (a pick writes a category to
 * something) lists live categories, plus the thing's own archived category when it holds one,
 * disabled. A FILTER picker (a pick narrows a list) keeps every archived category, selectable,
 * after the live ones.
 */
describe('categoryOptions picker kinds (v1.57.2)', () => {
  const row = (id: number, name: string, parentId: number | null, sortOrder: number, isArchived = false) => ({ id, name, parentId, sortOrder, isArchived });
  const all = [
    row(1, 'Hobbies', null, 0),
    row(2, 'Kites', 1, 0),
    row(3, 'Lanterns', 1, 1, true),
    row(4, 'Ferries', null, 1, true),
    row(5, 'Pantry', null, 2),
  ];

  it('an assignment picker with nothing current lists live categories only', () => {
    expect(categoryOptions(all)).toEqual([
      { id: 1, label: 'Hobbies', depth: 0 },
      { id: 2, label: 'Kites', depth: 1 },
      { id: 5, label: 'Pantry', depth: 0 },
    ]);
    expect(categoryOptions(all, { kind: 'assign', current: null })).toEqual(categoryOptions(all));
  });

  it('an assignment picker on a live category lists live categories only', () => {
    expect(categoryOptions(all, { kind: 'assign', current: 2 })).toEqual(categoryOptions(all));
  });

  it('an assignment picker on an archived category adds exactly that one, disabled, after the live ones', () => {
    expect(categoryOptions(all, { kind: 'assign', current: 3 })).toEqual([
      { id: 1, label: 'Hobbies', depth: 0 },
      { id: 2, label: 'Kites', depth: 1 },
      { id: 5, label: 'Pantry', depth: 0 },
      { id: 3, label: 'Hobbies › Lanterns (archived)', depth: 0, disabled: true },
    ]);
  });

  it('never offers an archived category that is not the current one', () => {
    const ids = categoryOptions(all, { kind: 'assign', current: 4 }).map((o) => o.id);
    expect(ids).toContain(4);
    expect(ids).not.toContain(3);
  });

  it('a filter picker keeps every archived category, selectable, after the live ones', () => {
    expect(categoryOptions(all, { kind: 'filter' })).toEqual([
      { id: 1, label: 'Hobbies', depth: 0 },
      { id: 2, label: 'Kites', depth: 1 },
      { id: 5, label: 'Pantry', depth: 0 },
      { id: 3, label: 'Hobbies › Lanterns (archived)', depth: 0 },
      { id: 4, label: 'Ferries (archived)', depth: 0 },
    ]);
  });

  it('names the parent of an archived child, whether that parent is live or archived', () => {
    const tree = [
      row(1, 'Hobbies', null, 0),
      row(2, 'Kites', 1, 0, true),
      row(3, 'Ferries', null, 1, true),
      row(4, 'Dinghies', 3, 0, true),
      row(5, 'Rowboats', 3, 1),
    ];
    expect(categoryOptions(tree, { kind: 'filter' }).map((o) => `${o.depth}:${o.label}`)).toEqual([
      '0:Hobbies',
      '0:Rowboats',
      '0:Hobbies › Kites (archived)',
      '0:Ferries (archived)',
      '0:Ferries › Dinghies (archived)',
    ]);
  });

  it('groups put the archived options after the live groups, ungrouped', () => {
    expect(categoryOptionGroups(all, { kind: 'assign', current: 4 })).toEqual([
      {
        label: 'Hobbies',
        options: [
          { id: 1, label: 'Hobbies', depth: 0 },
          { id: 2, label: 'Kites', depth: 1 },
        ],
      },
      { label: null, options: [{ id: 5, label: 'Pantry', depth: 0 }] },
      { label: null, options: [{ id: 4, label: 'Ferries (archived)', depth: 0, disabled: true }] },
    ]);
  });

  it('select options carry the disabled flag for the current archived category only', () => {
    expect(categorySelectOptions(all, { kind: 'assign', current: 4 })).toEqual([
      { label: 'Hobbies', options: [{ value: '1', label: 'Hobbies' }, { value: '2', label: 'Kites' }] },
      { value: '5', label: 'Pantry' },
      { value: '4', label: 'Ferries (archived)', disabled: true },
    ]);
    expect(categorySelectOptions(all)).toEqual([
      { label: 'Hobbies', options: [{ value: '1', label: 'Hobbies' }, { value: '2', label: 'Kites' }] },
      { value: '5', label: 'Pantry' },
    ]);
  });
});
