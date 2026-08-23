import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories } from '@/db/schema';

export interface CategoryRecord {
  id: number;
  name: string;
  parentId: number | null;
  icon: string | null;
  color: string | null;
  isIncome: boolean;
  isArchived: boolean;
  sortOrder: number;
  /** v1.7.0, Task 15 (spec 2026-08-22): marks a category relevant for the tax-year report
   *  (src/lib/tax.ts). Toggled from the categories manager's Tax checkbox via
   *  setCategoryTaxRelevant below. A flagged PARENT rolls in every child's spend even when
   *  the child itself is unflagged; see taxYearReport's doc comment for the full rule. */
  taxRelevant: boolean;
}

export interface CategoryNode extends CategoryRecord {
  children: CategoryRecord[];
}

export function listCategories(opts: { includeArchived?: boolean } = {}): CategoryRecord[] {
  const rows = getDb().select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id)).all();
  return opts.includeArchived ? rows : rows.filter((row) => !row.isArchived);
}

export function categoryTree(opts: { includeArchived?: boolean } = {}): CategoryNode[] {
  const all = listCategories(opts);
  const parents = all.filter((row) => row.parentId === null);
  return parents.map((parent) => ({ ...parent, children: all.filter((row) => row.parentId === parent.id) }));
}

export function categoryLabel(id: number | null, all: CategoryRecord[]): string {
  if (id === null) return 'Uncategorized';
  const category = all.find((row) => row.id === id);
  if (!category) return 'Uncategorized';
  if (category.parentId === null) return category.name;
  const parent = all.find((row) => row.id === category.parentId);
  return parent ? `${parent.name} › ${category.name}` : category.name;
}

/** Rollup rule (spec section 3): a parent counts its own rows plus all children's. */
export function categoryWithDescendants(id: number, all: CategoryRecord[] = listCategories({ includeArchived: true })): number[] {
  const children = all.filter((row) => row.parentId === id).map((row) => row.id);
  return [id, ...children];
}

export function createCategory(input: {
  name: string;
  parentId: number | null;
  icon?: string | null;
  color?: string | null;
  isIncome?: boolean;
}): number {
  const db = getDb();
  let isIncome = input.isIncome ?? false;
  if (input.parentId !== null) {
    const parent = db.select().from(categories).where(eq(categories.id, input.parentId)).get();
    if (!parent) throw new Error(`No category ${input.parentId}`);
    if (parent.parentId !== null) throw new Error('Categories are limited to two levels');
    if (input.isIncome === undefined) isIncome = parent.isIncome;
  }
  const maxOrder = listCategories({ includeArchived: true }).reduce((max, row) => Math.max(max, row.sortOrder), 0);
  const row = db
    .insert(categories)
    .values({
      name: input.name.trim(),
      parentId: input.parentId,
      icon: input.icon ?? null,
      color: input.color ?? null,
      isIncome,
      isArchived: false,
      sortOrder: maxOrder + 1,
    })
    .returning({ id: categories.id })
    .get();
  return row.id;
}

export function renameCategory(id: number, name: string): void {
  getDb().update(categories).set({ name: name.trim() }).where(eq(categories.id, id)).run();
}

/** Archive only — transactions, rules and budgets reference categories forever. */
export function archiveCategory(id: number, archived: boolean): void {
  getDb().update(categories).set({ isArchived: archived }).where(eq(categories.id, id)).run();
}

/** v1.7.0, Task 15a (spec 2026-08-22): the categories manager's Tax checkbox writes here via
 *  setCategoryTaxRelevantAction. See the doc comment on CategoryRecord.taxRelevant above and
 *  taxYearReport (src/lib/tax.ts) for what flagging a parent versus a child means. */
export function setCategoryTaxRelevant(id: number, taxRelevant: boolean): void {
  getDb().update(categories).set({ taxRelevant }).where(eq(categories.id, id)).run();
}
