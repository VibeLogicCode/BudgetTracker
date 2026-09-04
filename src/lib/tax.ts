import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions, transactionSplits, users } from '@/db/schema';
import { categoryWithDescendants, listCategories } from '@/lib/categories';
import { netSpentCents } from '@/lib/money';
import { toCsv, UNATTRIBUTED_LABEL } from '@/lib/reports';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY } from '@/lib/splits';
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

function yearBounds(year: number): { from: string; to: string } {
  const y = String(year).padStart(4, '0');
  return { from: `${y}-01-01`, to: `${y}-12-31` };
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
 */
export function taxYears(): number[] {
  const rows = getDb()
    .select({ year: sql<string>`substr(${transactions.date}, 1, 4)` })
    .from(transactions)
    .where(eq(transactions.isTransfer, false))
    .groupBy(sql`substr(${transactions.date}, 1, 4)`)
    .all();
  return rows.map((row) => Number(row.year)).sort((a, b) => b - a);
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
 */
export function taxYearReport(year: number): TaxYearRow[] {
  const { from, to } = yearBounds(year);
  const all = listCategories({ includeArchived: true });

  const rows = getDb()
    .select({
      categoryId: EFFECTIVE_CATEGORY,
      userId: transactions.attributedUserId,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(gte(transactions.date, from), lte(transactions.date, to), ...SPEND_ROW_WHERE))
    .groupBy(EFFECTIVE_CATEGORY, transactions.attributedUserId)
    .all();

  // Signed sums (not yet netted -- netSpentCents is applied once the per-category coverage is
  // folded together below, never per raw group row), keyed categoryId -> attributedUserId(or
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
    // repeated here so a person can never be silently dropped from the breakdown.
    byUserRows.push({ userId: null, label: UNATTRIBUTED_LABEL, cents: netSpentCents(combined.get(null) ?? 0) });
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
 */
export function taxYearCsv(year: number): string {
  const rows: TaxCsvRow[] = [];
  for (const row of taxYearReport(year)) {
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
