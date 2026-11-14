import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { accounts, transactions, transactionSplits, users } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { categoryWithDescendants, listCategories, type CategoryRecord } from '@/lib/categories';
import { netSpentCents } from '@/lib/money';
import { toCsv, UNATTRIBUTED_LABEL } from '@/lib/reports';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY, EFFECTIVE_PERSON, partPersonClause, personRowClause } from '@/lib/splits';
import { SPEND_ROW_WHERE } from '@/lib/spend-where';

/**
 * Tax-relevant categories + the tax-year report (spec 2026-08-22, v1.7.0, Task 15). Split out
 * of src/lib/reports.ts into its own module per the task's amended Files note: reports.ts was
 * already the largest lib module, tax-year reporting is its own domain (tax years, per-person
 * totals, its own CSV), and the split let this task run in parallel with Tasks 12-14, which
 * had reports.ts open. toCsv/UNATTRIBUTED_LABEL are IMPORTED from reports.ts rather than
 * duplicated -- that is what gives taxYearCsv the spreadsheet-formula-injection guard for
 * free, and keeps the unattributed-person label a single source of truth.
 *
 * THE OVERLAP RULE (read this before touching the rollup logic below): a flagged PARENT
 * category's row includes every child's spend, whether or not the child is itself flagged --
 * the same categoryWithDescendants rollup budgetProgress/categoryBreakdown already use. A
 * flagged CHILD has no children of its own (categories are limited to two levels), so it
 * always counts alone. When BOTH a parent and one of its children are flagged, the parent's
 * row keeps including the child's spend AND the child gets its own separate row -- these two
 * numbers are DELIBERATELY not disjoint and must never be summed together (see the "both
 * flagged" test in tests/lib/reports-tax.test.ts for the concrete arithmetic that makes a
 * naive sum wrong). Each row answers a different, independently correct question: "what did
 * this whole umbrella cost" versus "what did this one category alone cost".
 */

export interface TaxYearRow {
  categoryId: number;
  categoryName: string;
  totalCents: number;
  byUser: { userId: number | null; label: string; cents: number }[];
}

export function yearBounds(year: number): { from: string; to: string } {
  const y = String(year).padStart(4, '0');
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/**
 * Plainly four digits (so never negative, fractional or otherwise non-numeric), then the same
 * 1900-2999 bound src/lib/dates.ts's buildIso() already uses for a parsed statement date --
 * reused here rather than invented fresh. Anything outside this is rejected before it ever
 * reaches the plain string date-range comparison every reader below makes, which has no format
 * validation of its own and would otherwise silently accept a nonsensical year instead of
 * erroring.
 *
 * v1.63.0 (plan 2026-11-12, B1): moved here from the tax-export route, so the three year routes
 * (tax-export, tax-detail, year-end) read `?year=` by one rule.
 */
export function parseTaxYear(value: string | null): number | null {
  if (!value || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  if (year < 1900 || year > 2999) return null;
  return year;
}

/**
 * Years that have at least one non-transfer transaction, newest first. Feeds the tax-year
 * report's year picker (Task 15b) INDEPENDENTLY of whether any category is currently flagged
 * tax-relevant -- a household with plenty of data but no flagged category yet still gets a
 * normal year picker; it is taxYearReport's own empty result that tells the 15b UI to show its
 * "mark a category tax-relevant" empty state, not an empty year list. Transfers are excluded
 * for the same reason the Global Constraints exclude them from every other aggregate: a
 * transfer between two of a household's own accounts should never be what makes a year appear
 * to "have data".
 *
 * v1.63.0 (plan 2026-11-12, B1): takes the viewer. A self viewer's years are the years holding a
 * row of theirs (personRowClause: their own transactions, or a split with a part set to them), so
 * the Year picker never offers a year in which only somebody else spent.
 */
export function taxYears(viewer: Viewer): number[] {
  const own = ownerScope(viewer);
  const clauses: SQL[] = [eq(transactions.isTransfer, false)];
  if (own !== null) clauses.push(personRowClause(own));
  const rows = getDb()
    .select({ year: sql<string>`substr(${transactions.date}, 1, 4)` })
    .from(transactions)
    .where(and(...clauses))
    .groupBy(sql`substr(${transactions.date}, 1, 4)`)
    .all();
  return rows.map((row) => Number(row.year)).sort((a, b) => b - a);
}

/**
 * v1.63.0 (B1). The viewer's part of the split-joined read: nothing for a household viewer, their
 * own parts (partPersonClause on EFFECTIVE_PERSON) for a self viewer. One function, so the totals
 * and the detail rows below cannot scope differently.
 */
function viewerPartClauses(viewer: Viewer): SQL[] {
  const own = ownerScope(viewer);
  return own === null ? [] : [partPersonClause(own)];
}

/**
 * One calendar year's spend for every tax-relevant category (Task 15a). See the module's doc
 * comment above for the parent/child overlap rule.
 *
 * Split-aware (Task 3's pattern, reused rather than reimplemented): LEFT JOIN
 * transaction_splits and group by EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) so a
 * split transaction is counted once, at its parts' own categories -- never at its parent's own
 * lump category/amount, and never at both. `SPEND_ROW_WHERE` (src/lib/spend-where.ts, C-02 fix)
 * excludes both transfers and loan-principal movements, matching every other spend aggregate in
 * this app -- a lend-out filed under a tax-relevant category is not deductible spend any more
 * than it is budget spend.
 *
 * v1.63.0 (plan 2026-11-12, A3): the person axis is EFFECTIVE_PERSON, so a flagged part set to
 * someone else (or to Household) counts under that person, not under the transaction's.
 *
 * A category only appears here when its coverage (itself, plus every child when it is itself a
 * parent) actually has at least one matching transaction this year -- this is what makes "a
 * year with no data returns an empty array" true even for a category that IS flagged: an empty
 * `combined` map means zero rows existed in that coverage for this year, not merely that they
 * happened to net to zero (a purchase fully refunded in the same category, same year, still
 * produces a real -- if zero-valued -- row here, which is correct: something did happen).
 *
 * Amounts are net spend (src/lib/money.ts's netSpentCents), the same sign convention every
 * other report/budget number in this app uses -- an income category flagged tax-relevant
 * (e.g. freelance income for a tax slip) therefore reports as a NEGATIVE totalCents, which is
 * intentional and not filtered out: unlike categoryBreakdown/personSpendSplit, a tax report has
 * no reason to exclude income categories a household chooses to flag.
 *
 * v1.63.0 (plan 2026-11-12, B1, owner decision 1): takes the viewer. A household viewer gets
 * exactly what this returned before. A self viewer's read is their own parts (viewerPartClauses),
 * so every row has one person line, theirs: the always-present Household bucket below is a
 * household comparison, and a self viewer is given no household figure, not even a zero.
 */
export function taxYearReport(year: number, viewer: Viewer): TaxYearRow[] {
  const { from, to } = yearBounds(year);
  const all = listCategories({ includeArchived: true });
  const selfScoped = ownerScope(viewer) !== null;

  const rows = getDb()
    .select({
      categoryId: EFFECTIVE_CATEGORY,
      userId: EFFECTIVE_PERSON,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), ...SPEND_ROW_WHERE, ...viewerPartClauses(viewer)))
    .groupBy(EFFECTIVE_CATEGORY, EFFECTIVE_PERSON)
    .all();

  // Signed sums (not yet netted -- netSpentCents is applied once the per-category coverage is
  // folded together below, never per raw group row), keyed categoryId -> effective person (or
  // null) -> sum.
  const byCategory = new Map<number, Map<number | null, number>>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    let byUser = byCategory.get(row.categoryId);
    if (!byUser) {
      byUser = new Map();
      byCategory.set(row.categoryId, byUser);
    }
    byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + (row.total ?? 0));
  }

  // Fetched once and filtered per category below -- the same "one people query, reused" shape
  // personSpendSplit (src/lib/reports.ts) already uses, rather than a query per row.
  const people = getDb().select({ id: users.id, name: users.name }).from(users).all();

  const result: TaxYearRow[] = [];
  for (const category of all) {
    if (!category.taxRelevant) continue;

    // The rollup rule, reused rather than reimplemented: for a top-level category this is
    // [itself, ...its children] (flagged or not); for a child category (which has no children
    // of its own) this is just [itself] -- exactly the parent/child behaviour this module's
    // doc comment describes.
    const coveredIds = categoryWithDescendants(category.id, all);

    const combined = new Map<number | null, number>();
    for (const id of coveredIds) {
      const byUser = byCategory.get(id);
      if (!byUser) continue;
      for (const [userId, sum] of byUser) combined.set(userId, (combined.get(userId) ?? 0) + sum);
    }
    if (combined.size === 0) continue; // nothing in this coverage happened this year

    let totalSigned = 0;
    for (const sum of combined.values()) totalSigned += sum;

    const byUserRows: TaxYearRow['byUser'] = people
      .filter((person) => combined.has(person.id))
      .map((person) => ({ userId: person.id, label: person.name, cents: netSpentCents(combined.get(person.id) ?? 0) }));
    // The unattributed bucket is always present, even at zero -- personSpendSplit's own rule,
    // repeated here so a person can never be silently dropped from the breakdown. Not for a self
    // viewer, whose read holds only their own parts (see the docblock).
    if (!selfScoped) {
      byUserRows.push({ userId: null, label: UNATTRIBUTED_LABEL, cents: netSpentCents(combined.get(null) ?? 0) });
    }
    byUserRows.sort((a, b) => b.cents - a.cents);

    result.push({
      categoryId: category.id,
      categoryName: category.name,
      totalCents: netSpentCents(totalSigned),
      byUser: byUserRows,
    });
  }

  return result.sort((a, b) => b.totalCents - a.totalCents);
}

interface TaxCsvRow extends Record<string, unknown> {
  Category: string;
  Person: string;
  Amount: string;
}

/**
 * Category, Person, Amount -- one row per (flagged category, person) breakdown. Built on the
 * SAME toCsv/csvCell every other export in this app uses (src/lib/reports.ts), which is the
 * whole reason to reuse it rather than write new CSV code: the spreadsheet-formula-injection
 * guard on the Category and Person columns comes for free.
 *
 * Because a flagged parent's row already folds in a flagged child's spend (see this module's
 * doc comment on the overlap), the same person's cents can legitimately appear on two lines of
 * this export -- once under the parent, once under the child -- and summing the Amount column
 * blindly double-counts exactly that overlap. This is the same by-design overlap taxYearReport
 * documents, not a CSV-specific bug.
 *
 * v1.63.0 (B1): the viewer's own report, so a self viewer's file holds their lines only.
 */
export function taxYearCsv(year: number, viewer: Viewer): string {
  const rows: TaxCsvRow[] = [];
  for (const row of taxYearReport(year, viewer)) {
    for (const person of row.byUser) {
      rows.push({ Category: row.categoryName, Person: person.label, Amount: (person.cents / 100).toFixed(2) });
    }
  }
  return toCsv(rows, [
    { key: 'Category', header: 'Category' },
    { key: 'Person', header: 'Person' },
    { key: 'Amount', header: 'Amount' },
  ]);
}

/**
 * v1.63.0 (plan 2026-11-12, Y1 and B2). One transaction, or one part of a split, behind a tax
 * total: the rows a return actually needs and the totals card cannot give.
 */
export interface TaxDetailRow {
  txnId: number;
  /** The split part's id, or null for a transaction that is not split. */
  splitId: number | null;
  date: string;
  accountName: string;
  /** The display name: display_description when set, else the bank's own wording. */
  description: string;
  categoryId: number;
  /** `Parent > Child`, or the name alone for a top-level category. */
  categoryPath: string;
  /** Every flagged category whose coverage holds this row, as paths (a flagged parent and child both). */
  taxCategories: string[];
  /** EFFECTIVE_PERSON: the part's own person when set, else the transaction's. Null is Household. */
  personId: number | null;
  personName: string;
  /** EFFECTIVE_AMOUNT, signed as stored: spend negative, a refund positive. */
  amountCents: number;
  /** The part's note, else the transaction's. */
  note: string | null;
}

/**
 * v1.63.0 (B2). Every transaction or split part dated in `year` whose effective category is inside
 * a tax-relevant category's coverage (the same categoryWithDescendants rollup taxYearReport uses),
 * under SPEND_ROW_WHERE and the viewer's scope (viewerPartClauses), ordered by date, transaction
 * and part. The year-end pack's rows: one function behind the detail CSV and the zip, and for each
 * flagged category the rows naming it sum to its taxYearReport total.
 *
 * A row in both a flagged parent's and a flagged child's coverage is ONE row naming both, never two
 * rows: the overlap the module docblock describes stays visible without doubling any amount.
 */
export function taxDetailRows(year: number, viewer: Viewer): TaxDetailRow[] {
  const { from, to } = yearBounds(year);
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((category) => [category.id, category]));

  // category id -> the flagged categories covering it, in category order.
  const flagsCovering = new Map<number, CategoryRecord[]>();
  for (const flagged of all) {
    if (!flagged.taxRelevant) continue;
    for (const id of categoryWithDescendants(flagged.id, all)) {
      const list = flagsCovering.get(id) ?? [];
      list.push(flagged);
      flagsCovering.set(id, list);
    }
  }
  if (flagsCovering.size === 0) return [];

  const path = (category: CategoryRecord): string => {
    const parent = category.parentId === null ? undefined : byId.get(category.parentId);
    return parent ? `${parent.name} > ${category.name}` : category.name;
  };

  const rows = getDb()
    .select({
      txnId: transactions.id,
      splitId: transactionSplits.id,
      date: transactions.date,
      accountName: accounts.name,
      rawDescription: transactions.rawDescription,
      displayDescription: transactions.displayDescription,
      categoryId: EFFECTIVE_CATEGORY,
      personId: EFFECTIVE_PERSON,
      amountCents: EFFECTIVE_AMOUNT,
      partNote: transactionSplits.note,
      transactionNote: transactions.notes,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(
      and(
        gte(transactions.date, from),
        lte(transactions.date, to),
        ...SPEND_ROW_WHERE,
        ...viewerPartClauses(viewer),
        inArray(EFFECTIVE_CATEGORY, [...flagsCovering.keys()]),
      ),
    )
    .orderBy(asc(transactions.date), asc(transactions.id), asc(transactionSplits.id))
    .all();

  // One people read for the whole year, not one per row.
  const names = new Map(getDb().select({ id: users.id, name: users.name }).from(users).all().map((user) => [user.id, user.name]));

  return rows.flatMap((row) => {
    const category = row.categoryId === null ? undefined : byId.get(row.categoryId);
    if (!category) return [];
    const description = row.displayDescription !== null && row.displayDescription.length > 0 ? row.displayDescription : row.rawDescription;
    return [
      {
        txnId: row.txnId,
        splitId: row.splitId,
        date: row.date,
        accountName: row.accountName,
        description,
        categoryId: category.id,
        categoryPath: path(category),
        taxCategories: (flagsCovering.get(category.id) ?? []).map(path),
        personId: row.personId,
        personName: row.personId === null ? UNATTRIBUTED_LABEL : (names.get(row.personId) ?? UNATTRIBUTED_LABEL),
        amountCents: row.amountCents,
        note: row.partNote ?? row.transactionNote ?? null,
      },
    ];
  });
}
