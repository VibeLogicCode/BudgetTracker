import { and, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories, transactions, transactionSplits, users } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { listCategories } from '@/lib/categories';
import { addMonths, monthEnd, monthOf, monthRange, monthStart } from '@/lib/dates';
import { netSpentCents } from '@/lib/money';
import { savingsRate, type SavingsRate } from '@/lib/savings-rate';
import { EFFECTIVE_AMOUNT, EFFECTIVE_CATEGORY, splitsForTransactions } from '@/lib/splits';
import { listTransactions, type TransactionFilter } from '@/lib/transactions';

export interface DateRange {
  from: string;
  to: string;
}

export const UNATTRIBUTED_LABEL = 'Household/unattributed';

type PersonScope = number | 'unattributed' | null | undefined;

function personClause(scope: PersonScope): SQL | null {
  if (scope === undefined || scope === null) return null;
  if (scope === 'unattributed') return isNull(transactions.attributedUserId);
  return eq(transactions.attributedUserId, scope);
}

/**
 * v1.13.0 ruling R2: a self viewer's person scope is THEIR OWN id, whatever the URL asked for.
 *
 * This is the one place in reports.ts that knows about visibility. Every exported aggregate below
 * runs its requested scope through it before building a clause, so a page cannot forget -- and
 * `viewer` is a required parameter on all seven, so a NEW aggregate cannot forget either: it will
 * not compile until its author decides what scope it is reading.
 */
function scopeFor(requested: PersonScope, viewer: Viewer): PersonScope {
  const own = ownerScope(viewer);
  return own === null ? requested : own;
}

function rangeClauses(range: DateRange, scope: PersonScope): SQL[] {
  const clauses: SQL[] = [
    gte(transactions.date, range.from),
    lte(transactions.date, range.to),
    // Transfers are excluded from every report series.
    eq(transactions.isTransfer, false),
  ];
  const person = personClause(scope);
  if (person) clauses.push(person);
  return clauses;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  categoryName: string;
  parentId: number | null;
  isIncome: boolean;
  spentCents: number;
}

export function categoryBreakdown(
  input: DateRange & { attributedUserId?: PersonScope; rollup?: boolean; includeIncome?: boolean },
  viewer: Viewer,
): CategoryBreakdownRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  // Split-aware (spec 2026-08-22, v1.7.0, Task 3): a split transaction is counted once, at
  // its parts' own categories/amounts (EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT, src/lib/splits.ts)
  // via the LEFT JOIN below, never at its own lump category/amount and never at both.
  const rows = getDb()
    .select({ categoryId: EFFECTIVE_CATEGORY, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .where(and(...rangeClauses(input, scope)))
    .groupBy(EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const spendByCategory = new Map<number | null, number>();
  for (const row of rows) spendByCategory.set(row.categoryId, netSpentCents(row.total ?? 0));

  const result: CategoryBreakdownRow[] = [];
  const emit = (categoryId: number | null, spentCents: number) => {
    const category = categoryId === null ? null : byId.get(categoryId);
    const isIncome = category?.isIncome ?? false;
    if (!input.includeIncome && isIncome) return;
    result.push({
      categoryId,
      categoryName: category?.name ?? 'Uncategorized',
      parentId: category?.parentId ?? null,
      isIncome,
      spentCents,
    });
  };

  if (input.rollup) {
    const rolled = new Map<number | null, number>();
    for (const [categoryId, spent] of spendByCategory) {
      if (categoryId === null) {
        rolled.set(null, (rolled.get(null) ?? 0) + spent);
        continue;
      }
      const category = byId.get(categoryId);
      const target = category?.parentId ?? categoryId;
      rolled.set(target, (rolled.get(target) ?? 0) + spent);
    }
    for (const [categoryId, spent] of rolled) emit(categoryId, spent);
  } else {
    for (const [categoryId, spent] of spendByCategory) emit(categoryId, spent);
  }

  return result.sort((a, b) => b.spentCents - a.spentCents);
}

export interface MonthTrendRow {
  month: string;
  incomeCents: number;
  spendCents: number;
  netCents: number;
}

export function cashflowTrend(
  months: number,
  opts: { endMonth?: string; attributedUserId?: PersonScope } = {},
  viewer: Viewer,
): MonthTrendRow[] {
  const scope = scopeFor(opts.attributedUserId, viewer);
  const endMonth = opts.endMonth ?? monthOf(new Date().toISOString().slice(0, 10));
  const startMonth = addMonths(endMonth, -(months - 1));
  const keys = monthRange(startMonth, endMonth);

  // Split-aware (Task 3): each split part is classified as income/spend by ITS OWN category
  // (the categories join below keys off EFFECTIVE_CATEGORY, not the parent's own
  // transactions.category_id), so a part filed under an income category moves into the
  // income series even when the parent transaction itself was not.
  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      isIncome: categories.isIncome,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses({ from: monthStart(startMonth), to: monthEnd(endMonth) }, scope)))
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, categories.isIncome)
    .all();

  const income = new Map<string, number>();
  const spend = new Map<string, number>();
  for (const row of rows) {
    // Income counts ONLY is_income categories; everything else (including
    // uncategorized rows) is spend, netted.
    if (row.isIncome) income.set(row.month, (income.get(row.month) ?? 0) + (row.total ?? 0));
    else spend.set(row.month, (spend.get(row.month) ?? 0) + (row.total ?? 0));
  }

  return keys.map((month) => {
    const incomeCents = income.get(month) ?? 0;
    const spendCents = netSpentCents(spend.get(month) ?? 0);
    return { month, incomeCents, spendCents, netCents: incomeCents - spendCents };
  });
}

// Re-exported so every existing importer of savingsRate/SavingsRate from '@/lib/reports' keeps
// working unchanged -- the actual implementation lives in @/lib/savings-rate (client-bundle fix,
// 2026-08-23): a 'use client' component (reports-client.tsx) needs this function, and importing
// it from THIS file would still drag @/db/client's better-sqlite3/node:fs graph into the browser
// bundle even though the function itself never touches the database. See that module's docblock.
export { savingsRate, type SavingsRate };

export interface CategoryMonthTrend {
  categoryId: number;
  categoryName: string;
  byMonth: Record<string, number>;
  totalCents: number;
}

export function categoryMonthOverMonth(
  input: {
    fromMonth: string;
    toMonth: string;
    attributedUserId?: PersonScope;
    limit?: number;
  },
  viewer: Viewer,
): { months: string[]; rows: CategoryMonthTrend[] } {
  const scope = scopeFor(input.attributedUserId, viewer);
  const months = monthRange(input.fromMonth, input.toMonth);
  // Split-aware (Task 3): grouped by EFFECTIVE_CATEGORY so each split part gets its own
  // monthly row, and the income-exclusion join below keys off EFFECTIVE_CATEGORY too, so a
  // part's own category decides inclusion rather than the parent's.
  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: EFFECTIVE_CATEGORY,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(
      and(
        ...rangeClauses({ from: monthStart(input.fromMonth), to: monthEnd(input.toMonth) }, scope),
        eq(categories.isIncome, false),
      ),
    )
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  const trends = new Map<number, CategoryMonthTrend>();

  for (const row of rows) {
    if (row.categoryId === null) continue;
    let trend = trends.get(row.categoryId);
    if (!trend) {
      trend = {
        categoryId: row.categoryId,
        categoryName: byId.get(row.categoryId)?.name ?? 'Unknown',
        byMonth: Object.fromEntries(months.map((month) => [month, 0])),
        totalCents: 0,
      };
      trends.set(row.categoryId, trend);
    }
    const spent = netSpentCents(row.total ?? 0);
    trend.byMonth[row.month] = spent;
    trend.totalCents += spent;
  }

  const sorted = [...trends.values()].sort((a, b) => b.totalCents - a.totalCents);
  return { months, rows: input.limit ? sorted.slice(0, input.limit) : sorted };
}

export interface YoYRow {
  categoryId: number;
  categoryName: string;
  thisMonthCents: number;
  lastMonthCents: number;
  lastYearCents: number;
}

/**
 * Task 13 (spec 2026-08-22, v1.7.0): one month against the month before it and the same month
 * a year earlier, for the Reports "This month against last year" card.
 *
 * ONE query, not three: the three month keys are not contiguous (lastYear sits 11 months
 * before lastMonth), so this scans the full span from the earliest to the latest of the three
 * -- the same shape categoryMonthOverMonth already uses for a contiguous window, grouped by
 * (month, EFFECTIVE_CATEGORY) -- and keeps only the three month buckets that matter in JS. That
 * is still one grouped aggregate hitting transactions_date_idx once, never one round trip per
 * month key.
 *
 * Split-aware (Task 3's pattern): LEFT JOIN transaction_splits and group by EFFECTIVE_CATEGORY/
 * EFFECTIVE_AMOUNT so a split transaction is counted once, at its parts' own categories, never
 * at the parent's own lump category/amount.
 */
export function categoryYearOverYear(input: { month: string; attributedUserId?: PersonScope }, viewer: Viewer): YoYRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  const thisMonth = input.month;
  const lastMonth = addMonths(thisMonth, -1);
  const lastYear = addMonths(thisMonth, -12);

  const rows = getDb()
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      categoryId: EFFECTIVE_CATEGORY,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(
      and(
        ...rangeClauses({ from: monthStart(lastYear), to: monthEnd(thisMonth) }, scope),
        eq(categories.isIncome, false),
      ),
    )
    .groupBy(sql`substr(${transactions.date}, 1, 7)`, EFFECTIVE_CATEGORY)
    .all();

  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));

  // Cells keyed by the transaction's OWN category (pre-rollup), matching only the three month
  // keys this card cares about -- every other month the range query happened to scan is
  // dropped here, in JS, rather than fetched again.
  interface Cell {
    thisMonthCents: number;
    lastMonthCents: number;
    lastYearCents: number;
  }
  const cellsByCategory = new Map<number, Cell>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    if (row.month !== thisMonth && row.month !== lastMonth && row.month !== lastYear) continue;
    const cell = cellsByCategory.get(row.categoryId) ?? { thisMonthCents: 0, lastMonthCents: 0, lastYearCents: 0 };
    const spent = netSpentCents(row.total ?? 0);
    if (row.month === thisMonth) cell.thisMonthCents += spent;
    else if (row.month === lastMonth) cell.lastMonthCents += spent;
    else cell.lastYearCents += spent;
    cellsByCategory.set(row.categoryId, cell);
  }

  // Rollup to parent level (categoryBreakdown({ rollup: true })'s rule): each child's three
  // cells fold into ITS OWN parent, never into a shared bucket.
  const rolled = new Map<number, Cell>();
  for (const [categoryId, cell] of cellsByCategory) {
    const target = byId.get(categoryId)?.parentId ?? categoryId;
    const existing = rolled.get(target) ?? { thisMonthCents: 0, lastMonthCents: 0, lastYearCents: 0 };
    existing.thisMonthCents += cell.thisMonthCents;
    existing.lastMonthCents += cell.lastMonthCents;
    existing.lastYearCents += cell.lastYearCents;
    rolled.set(target, existing);
  }

  const result: YoYRow[] = [];
  for (const [categoryId, cell] of rolled) {
    // A row with nothing to show in any of the three months is noise, not a comparison.
    if (cell.thisMonthCents === 0 && cell.lastMonthCents === 0 && cell.lastYearCents === 0) continue;
    result.push({ categoryId, categoryName: byId.get(categoryId)?.name ?? 'Unknown', ...cell });
  }
  return result.sort((a, b) => b.thisMonthCents - a.thisMonthCents);
}

export interface PersonSplitRow {
  userId: number | null;
  label: string;
  spentCents: number;
}

/**
 * A self viewer gets exactly one row -- their own. The split IS the household comparison otherwise,
 * which is precisely the "reports of household totals" ruling R2 forbids, so the Reports page renders
 * this section only for a household viewer (Task 13). Returning one row rather than throwing keeps
 * this function total for any caller.
 */
export function personSpendSplit(input: DateRange, viewer: Viewer): PersonSplitRow[] {
  // Split-aware (Task 3): grouped by transactions.attributedUserId (attribution stays
  // whole-transaction, design ruling 1 -- a split has no owner of its own), but the income
  // exclusion join keys off EFFECTIVE_CATEGORY and the summed amount is EFFECTIVE_AMOUNT, so
  // BOTH of a split's parts land on the parent's person, each correctly included/excluded by
  // its OWN category rather than the parent's.
  const rows = getDb()
    .select({ userId: transactions.attributedUserId, total: sql<number>`sum(${EFFECTIVE_AMOUNT})` })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses(input, undefined), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.attributedUserId)
    .all();

  const people = getDb().select({ id: users.id, name: users.name }).from(users).all();
  const spendByUser = new Map<number | null, number>();
  for (const row of rows) spendByUser.set(row.userId, netSpentCents(row.total ?? 0));

  const result: PersonSplitRow[] = people
    .filter((person) => spendByUser.has(person.id))
    .map((person) => ({ userId: person.id, label: person.name, spentCents: spendByUser.get(person.id) ?? 0 }));

  // The unattributed bucket is always present — never silently dropped.
  result.push({ userId: null, label: UNATTRIBUTED_LABEL, spentCents: spendByUser.get(null) ?? 0 });
  const sorted = result.sort((a, b) => b.spentCents - a.spentCents);

  const own = ownerScope(viewer);
  return own === null ? sorted : sorted.filter((row) => row.userId === own);
}

export interface TopMerchantRow {
  normalizedMerchant: string;
  spentCents: number;
  count: number;
}

export function topMerchants(input: DateRange & { limit?: number; attributedUserId?: PersonScope }, viewer: Viewer): TopMerchantRow[] {
  const scope = scopeFor(input.attributedUserId, viewer);
  // Split-aware (v1.7.0 review fix, 2026-08-22): merchant IDENTITY still groups by the
  // parent's own normalizedMerchant -- a split never changes who charged the card, so the
  // GROUPING here was always correct. What was wrong was the income FILTER and the SUM: this
  // used to join `categories` on the parent's own transactions.categoryId, which a split
  // never updates (splits.ts ruling 1/2), so the whole transaction's include/exclude decision
  // was made on a stale category. A charge filed under an income category and later corrected
  // by a split -- exactly the case splitting exists for -- had its entire amount silently
  // excluded forever. Both the join and the summed amount now key off
  // EFFECTIVE_CATEGORY/EFFECTIVE_AMOUNT (src/lib/splits.ts) via a LEFT JOIN onto
  // transaction_splits, so each split PART decides its own inclusion and contributes its own
  // amount, while every part still lands in the parent's merchant bucket.
  //
  // count(distinct transactions.id), NOT count(*): the transaction_splits join multiplies
  // rows per split part (an N-part split yields N joined rows for one charge), so count(*)
  // would report a 3-part split as 3 charges at that merchant. Counting distinct transaction
  // ids keeps "Charges" meaning the number of card charges, not the number of category parts
  // summed across all of them.
  const rows = getDb()
    .select({
      normalizedMerchant: transactions.normalizedMerchant,
      total: sql<number>`sum(${EFFECTIVE_AMOUNT})`,
      count: sql<number>`count(distinct ${transactions.id})`,
    })
    .from(transactions)
    .leftJoin(transactionSplits, eq(transactionSplits.txnId, transactions.id))
    .leftJoin(categories, eq(categories.id, EFFECTIVE_CATEGORY))
    .where(and(...rangeClauses(input, scope), sql`coalesce(${categories.isIncome}, 0) = 0`))
    .groupBy(transactions.normalizedMerchant)
    .all();

  return rows
    .map((row) => ({ normalizedMerchant: row.normalizedMerchant, spentCents: netSpentCents(row.total ?? 0), count: row.count }))
    .filter((row) => row.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, input.limit ?? 10);
}

export interface CsvColumn<T> {
  key: keyof T & string;
  header: string;
}

/**
 * Fields a spreadsheet would execute rather than display. Excel/Sheets/LibreOffice all
 * treat a leading =, +, - or @ as the start of a formula, and a leading tab as a cell
 * separator that shifts the payload into the next cell — so a transaction note reading
 * `=SUM(1)` (or worse, a WEBSERVICE/HYPERLINK call) would run on open. Bank descriptions
 * are attacker-influenced text in exactly the way this attack needs.
 */
const FORMULA_TRIGGER = /^[=+\-@\t]/;

/**
 * ...except a plain number. Spend is stored negative, so the Amount column is full of
 * values like "-45.00": those start with a trigger character but are numeric literals,
 * not formulas, and quoting them as text would break every sum in the exported sheet —
 * the one thing people export a CSV to do. Anything with an operator in it ("-2+3") fails
 * this test and is still guarded.
 */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * RFC 4180 quoting is preserved exactly as before; the injection guard is a separate,
 * earlier step that prefixes a single quote. The apostrophe is what spreadsheets read as
 * "this cell is literal text" — it is not shown in the cell, and a plain-text reader sees
 * one extra leading character, which is the accepted cost of the guard.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_TRIGGER.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function transactionsCsv(filter: TransactionFilter, viewer: Viewer): string {
  const all = listCategories({ includeArchived: true });
  const byId = new Map(all.map((row) => [row.id, row]));
  // Shared by the unsplit and per-part rows below so a part's category renders with exactly
  // the same "Parent > Child" formatting the unsplit path has always used.
  const categoryPath = (categoryId: number | null): string => {
    const category = categoryId === null ? null : byId.get(categoryId);
    if (!category) return 'Uncategorized';
    const parent = category.parentId ? byId.get(category.parentId) : undefined;
    return parent ? `${parent.name} > ${category.name}` : category.name;
  };

  const page = listTransactions({ ...filter, page: 1, pageSize: 200 }, viewer);
  const rows: Record<string, unknown>[] = [];

  for (let pageNumber = 1; pageNumber <= page.pageCount; pageNumber += 1) {
    const chunk = pageNumber === 1 ? page : listTransactions({ ...filter, page: pageNumber, pageSize: 200 }, viewer);
    // Split-aware (spec 2026-08-22, v1.7.0, Task 4): one batched lookup per page of up to
    // 200 transactions, not a query per row.
    const splitsByTxn = splitsForTransactions(chunk.rows.map((row) => row.id));

    for (const row of chunk.rows) {
      const parts = splitsByTxn.get(row.id) ?? [];

      if (parts.length === 0) {
        // Unchanged from the pre-split format -- byte-identical for every transaction that
        // was never split (tests/lib/reports.test.ts asserts this against a fixture).
        rows.push({
          Date: row.date,
          Account: row.accountName,
          Description: row.rawDescription,
          Merchant: row.normalizedMerchant,
          Amount: (row.amountCents / 100).toFixed(2),
          Category: categoryPath(row.categoryId),
          Person: row.attributedUserName ?? UNATTRIBUTED_LABEL,
          Transfer: row.isTransfer ? 'yes' : 'no',
          Source: row.source,
          Notes: row.notes ?? '',
        });
        continue;
      }

      // One row per part: amount, category and note are the part's own. Date, account,
      // merchant, person, transfer and source stay the parent's -- attribution and every
      // other parent-level fact are whole-transaction (design ruling 1, spec 2026-08-22).
      parts.forEach((part, index) => {
        rows.push({
          Date: row.date,
          Account: row.accountName,
          Description: `${row.rawDescription} (split ${index + 1}/${parts.length})`,
          Merchant: row.normalizedMerchant,
          Amount: (part.amountCents / 100).toFixed(2),
          Category: categoryPath(part.categoryId),
          Person: row.attributedUserName ?? UNATTRIBUTED_LABEL,
          Transfer: row.isTransfer ? 'yes' : 'no',
          Source: row.source,
          Notes: part.note ?? '',
        });
      });
    }
  }

  return toCsv(rows, [
    { key: 'Date', header: 'Date' },
    { key: 'Account', header: 'Account' },
    { key: 'Description', header: 'Description' },
    { key: 'Merchant', header: 'Merchant' },
    { key: 'Amount', header: 'Amount' },
    { key: 'Category', header: 'Category' },
    { key: 'Person', header: 'Person' },
    { key: 'Transfer', header: 'Transfer' },
    { key: 'Source', header: 'Source' },
    { key: 'Notes', header: 'Notes' },
  ]);
}
