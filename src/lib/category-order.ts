import type { CategoryRecord } from '@/lib/categories';

/**
 * Task 6 (spec 2026-08-23, v1.8.0): the shared flattening helper behind every category
 * `<select>` in the app, replacing four separate copies of "children rendered in raw
 * (sortOrder, id) creation order, scattered away from their parent" -- the long-deferred
 * grouping bug. Ordering matches budgetProgress()/flattenBudgetRows() (src/lib/budgets.ts,
 * src/lib/notify/evaluate/pace.ts), the Budgets page's own reference implementation: active
 * top-level categories in (sortOrder, id) order, each immediately followed by its own active
 * children in the same order.
 *
 * THE TRAP (repeat of the exact v1.7.0 build blocker): src/lib/categories.ts imports
 * @/db/client, and every call site of this helper is a 'use client' component. `import type`
 * erases completely at compile time (isolatedModules), so it is safe here -- but a VALUE
 * import of anything from '@/lib/categories', or of any other module that itself reaches
 * @/db/client, would make `next build` fail with "Module not found: Can't resolve 'fs'" while
 * `tsc --noEmit` and the whole vitest suite stay green, because neither of those bundles
 * anything for the browser. CI does not run `next build`. tests/ops/client-bundle.test.ts is
 * the guard that catches this class of defect; keep this file free of value imports that reach
 * the database.
 */
export interface CategoryOption {
  id: number;
  label: string;
  depth: 0 | 1;
}

/**
 * Deliberately narrower than the full CategoryRecord: only the fields the grouping algorithm
 * actually reads. transactions-client.tsx's existing category prop (and the fixtures in
 * tests/app/transactions-client.test.tsx covering its archived-category handling) already
 * carry only a trimmed id/name/parentId/isArchived shape -- widening categoryOptions' own
 * parameter to demand the full CategoryRecord (icon/color/isIncome/taxRelevant included) would
 * have forced every one of those fixtures to grow fields no select ever reads. A real
 * CategoryRecord[] -- e.g. straight from listCategories(), as review-client.tsx passes -- is
 * still a valid argument here, since it carries every field this Pick asks for and then some.
 */
export type CategoryLike = Pick<CategoryRecord, 'id' | 'name' | 'parentId' | 'sortOrder' | 'isArchived'>;

/**
 * Backlog 2a: the grouping walk on its own, generic over the row type and WITHOUT the
 * active-only filter, for callers that must keep archived rows on screen (the Settings ->
 * Categories admin table). Same order as categoryOptions by construction: rows sorted by
 * (sortOrder, id), each top-level row immediately followed by its own children in that same
 * order. A child whose parent is not in `all` is promoted to depth 0 rather than dropped.
 */
export function orderedCategoryRows<T extends CategoryLike>(all: T[]): Array<{ row: T; depth: 0 | 1 }> {
  const sorted = [...all].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const ids = new Set(sorted.map((category) => category.id));
  const isTopLevel = (category: T) => category.parentId === null || !ids.has(category.parentId);

  const rows: Array<{ row: T; depth: 0 | 1 }> = [];
  for (const category of sorted) {
    if (!isTopLevel(category)) continue; // placed under its parent below, not here
    rows.push({ row: category, depth: 0 });
    for (const child of sorted) {
      if (child.parentId === category.id) rows.push({ row: child, depth: 1 });
    }
  }
  return rows;
}

export function categoryOptions(all: CategoryLike[]): CategoryOption[] {
  // Categories are limited to two levels (enforced at creation in createCategory). Archived
  // rows are dropped BEFORE the walk, so a child whose parent got archived has nowhere left to
  // nest and is promoted to depth 0 by orderedCategoryRows -- it stays selectable rather than
  // disappearing with no way to notice (some past transaction may still hold it).
  const active = all.filter((category) => !category.isArchived);
  return orderedCategoryRows(active).map(({ row, depth }) => ({ id: row.id, label: row.name, depth }));
}

/**
 * Backlog BZ (owner ruling A, 2026-08-29). The same order categoryOptions() produces, arranged
 * for `<optgroup>`: a parent that HAS children becomes a group whose label is the parent's name,
 * with the parent itself as the first selectable option inside it, and a top-level category with
 * no children stays a plain ungrouped option.
 *
 * Why grouping rather than shading: a native <select> gives no per-option styling worth relying
 * on, but every browser renders an <optgroup> label distinctly (and the iOS/Android pickers group
 * it too), so the hierarchy the two leading non-breaking spaces were carrying alone becomes
 * visible for free -- no custom combobox, no JavaScript, no accessibility risk.
 *
 * `label: null` means "render these options directly, not inside a group".
 */
export interface CategoryOptionGroup {
  label: string | null;
  options: CategoryOption[];
}

export function categoryOptionGroups(all: CategoryLike[]): CategoryOptionGroup[] {
  const flat = categoryOptions(all);
  const groups: CategoryOptionGroup[] = [];
  for (let i = 0; i < flat.length; i += 1) {
    const option = flat[i];
    if (option.depth !== 0) continue; // consumed by its parent below
    const children: CategoryOption[] = [];
    for (let j = i + 1; j < flat.length && flat[j].depth === 1; j += 1) children.push(flat[j]);
    groups.push(
      children.length === 0
        ? { label: null, options: [option] }
        : { label: option.label, options: [option, ...children] },
    );
  }
  return groups;
}
