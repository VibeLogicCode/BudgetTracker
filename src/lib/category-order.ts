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

export function categoryOptions(all: CategoryLike[]): CategoryOption[] {
  // Categories are limited to two levels (enforced at creation in createCategory), so sorting
  // once up front and walking it twice (outer pass over top-level rows, inner pass to pick out
  // each one's children) is enough -- no recursion needed the way categoryTree() has none either.
  const active = [...all].filter((category) => !category.isArchived).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const activeIds = new Set(active.map((category) => category.id));

  // A child whose parent got archived or was deleted out from under it has nowhere left to
  // nest -- promoted to depth 0 instead of dropped, so it stays selectable rather than
  // disappearing with no way to notice (it is still a category some past transaction may hold).
  const isTopLevel = (category: CategoryLike) => category.parentId === null || !activeIds.has(category.parentId);

  const options: CategoryOption[] = [];
  for (const category of active) {
    if (!isTopLevel(category)) continue; // placed under its parent below, not here
    options.push({ id: category.id, label: category.name, depth: 0 });
    for (const child of active) {
      if (child.parentId === category.id) options.push({ id: child.id, label: child.name, depth: 1 });
    }
  }
  return options;
}
