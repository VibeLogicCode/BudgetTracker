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
    // C-05 half 2: a non-income category with an income parent has no surviving top-level
    // ancestor in budgetProgress's walk (src/lib/budgets.ts) -- Half 1 there makes any
    // EXISTING row in that shape render tolerantly, but nothing should be able to create a
    // NEW one. It refuses only an EXPLICIT override: isIncome inherits the parent's value above
    // when the caller omits it, so an ordinary child never trips this.
    //
    // v1.31.0 item M-5: there is exactly ONE caller that always passes isIncome explicitly, and
    // the docblock used to imply there were none. src/lib/packs.ts's ensureCategory passes
    // `isIncome: meta?.is_income ?? false`, so a pack declaring a child under an income parent
    // without `is_income: true` reaches this throw with an explicit `false` it never meant. Left
    // as a throw rather than softened to inheritance, because the throw is no longer what a pack
    // importer meets: v1.31.0's R-04(b) added `assertPackFitsCategoryTree`, which refuses that
    // exact shape BEFORE the first write, as a PackFormatError the route turns into a 400 naming
    // the offending category and telling the reader to declare `"is_income": true` or re-parent
    // it. Softening the rule here would have removed the backstop under that pre-flight while
    // leaving the pre-flight's own message the only thing standing between a pack and a
    // half-imported tree.
    if (parent.isIncome && !isIncome) {
      throw new Error('A spend category cannot be created under an income category.');
    }
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

/*
 * v1.31.0 item M-5: `setCategoryIncome` USED TO LIVE HERE, as C-05 half 2's flip-time guard --
 * createCategory only checks the ONE row it is inserting, so it could not stop an existing
 * non-income parent from being flipped to income out from under children it already had.
 *
 * Deleted, not kept as pre-emption, because there is no flip path to guard: nothing outside its
 * own tests ever called it. The categories manager RENDERS the income/spend badge
 * (settings/managers/managers-client.tsx) and offers no control that changes `is_income` on an
 * existing category, and no action, route, importer or backup path writes that column either --
 * only createCategory sets it, at insert time. Its docblock nonetheless read as though a live
 * flip path existed, which is worse than silence: a reviewer checking whether the invariant is
 * covered would have concluded it was, on both halves.
 *
 * Same reasoning that deleted `categorySpendWithRollup` in v1.30.0: an exported function on no
 * guard list is a route somebody can call tomorrow, and an unused export with a guard inside it
 * is a guard nothing has ever exercised against the real tree. If a flip control is ever added,
 * it needs this function AND a test that drives it through the action, not a resurrection of an
 * export nobody called -- so the argument is recorded here and the code is not.
 */
