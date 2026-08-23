import type { MonthTrendRow } from './reports';

/**
 * Client-safe savings-rate math -- deliberately split out of @/lib/reports (client-bundle fix,
 * 2026-08-23; same Ruling P4 constraint as src/lib/networth-constants.ts, src/lib/warranty/
 * constants.ts, src/lib/notify/events.ts and src/lib/env-tz.ts). reports.ts imports getDb from
 * @/db/client at module scope for its query functions, so a client component that value-imports
 * savingsRate from reports.ts drags that whole module -- and therefore @/db/client's
 * better-sqlite3/node:fs/node:crypto -- into the browser bundle, exactly the way
 * STALE_SNAPSHOT_DAYS did from @/lib/networth (see networth-constants.ts's docblock).
 *
 * savingsRate is pure arithmetic over an array the caller already fetched (cashflowTrend's
 * MonthTrendRow[]); it never touches the database itself, so it belongs here, not in reports.ts.
 * The `import type` below is erased at compile time (tsconfig.json's isolatedModules), so it
 * creates no runtime dependency back on reports.ts -- reports.ts imports the VALUE from here and
 * re-exports it, so there is exactly one definition and the module graph stays a one-way edge
 * (reports.ts -> savings-rate.ts), never a cycle.
 */

export interface SavingsRate {
  incomeCents: number;
  spendCents: number;
  netCents: number;
  /** null whenever there is no positive income to divide by (Task 14: never a division-by-zero
   *  artifact) -- the caller shows a plain "no income" sentence instead of a percentage. */
  pct: number | null;
}

/**
 * Task 14 (spec 2026-08-22, v1.7.0): aggregates a cashflowTrend() series into the one summary
 * line the Reports "Cash flow and savings rate" card shows -- total income, total spend, total
 * saved (net), and the savings-rate percentage (net over income, rounded to a whole percent).
 * pct is null whenever incomeCents is not strictly positive, so the UI never divides by zero
 * or renders a nonsensical percentage for a range with no income.
 */
export function savingsRate(rows: MonthTrendRow[]): SavingsRate {
  const incomeCents = rows.reduce((sum, row) => sum + row.incomeCents, 0);
  const spendCents = rows.reduce((sum, row) => sum + row.spendCents, 0);
  const netCents = rows.reduce((sum, row) => sum + row.netCents, 0);
  const pct = incomeCents > 0 ? Math.round((netCents / incomeCents) * 100) : null;
  return { incomeCents, spendCents, netCents, pct };
}
