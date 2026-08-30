import { and, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { savingsTargets, transactions } from '@/db/schema';
import { listAccounts } from '@/lib/accounts';
import type { Viewer } from '@/lib/auth/viewer';
import { nowIso } from '@/lib/clock';
import { addMonths, isMonthKey, monthEnd, monthStart } from '@/lib/dates';
import { cashflowTrend } from '@/lib/reports';

/**
 * Savings targets (spec docs/superpowers/plans/2026-08-30-savings-targets.md, Lane 1, v1.17.0).
 * Mirrors drizzle/0015_savings_targets.sql.
 *
 * Ruling T1 is the one this whole module has to respect without restating its own version:
 * "saved" is `income - spend` for the month, transfers excluded, exactly as `cashflowTrend`
 * (src/lib/reports.ts) already computes it. `savingsProgress` below reads that series rather
 * than running a second income/spend query -- a second definition of "saved" is the one thing
 * this release must not invent. Ruling T1a's disclosure line (`movedToSavingsCents`) is
 * computed separately, on purpose: it is information about where the saved money went, never a
 * second input to the saved figure itself.
 */

export type SavingsTargetMode = 'percent' | 'amount';

export interface SavingsTarget {
  month: string;
  mode: SavingsTargetMode;
  value: number;
}

export interface SavingsProgress {
  month: string;
  target: SavingsTarget | null;
  /** The target resolved to cents for THIS month: percent applied to this month's income, or the
   *  fixed amount. null when no target is set, or when a percent target has no income to apply to. */
  targetCents: number | null;
  incomeCents: number;
  spendCents: number;
  netCents: number;
  /** net over targetCents as a whole percent; null when targetCents is null or not positive. */
  pct: number | null;
  met: boolean;
  /** Ruling T1a, disclosure only: flagged transfer deposits landing in a `savings`-type account
   *  this month. NEVER added to netCents, never compared against targetCents. */
  movedToSavingsCents: number;
  /** True when the household has no account of type 'savings' at all, which is the setup where an
   *  unflagged transfer to an outside bank silently understates the month (ruling T1, case 3). */
  noSavingsAccount: boolean;
}

function assertMonth(month: string): void {
  if (!isMonthKey(month)) throw new Error(`Month must be YYYY-MM, got "${month}"`);
}

/**
 * Ruling T2: percent is 1-100 (a whole percent) and an amount cannot be negative. Mirrors the SQL
 * CHECK in drizzle/0015_savings_targets.sql -- enforced here too so a caller gets a clear message
 * instead of a raw SQLite constraint error, the same discipline recordBalanceSnapshot
 * (src/lib/networth.ts) applies to its own date/account checks.
 */
function assertTarget(input: SavingsTarget): void {
  assertMonth(input.month);
  if (input.mode === 'percent' && (!Number.isInteger(input.value) || input.value < 1 || input.value > 100)) {
    throw new Error('A percent savings target must be a whole percent from 1 to 100.');
  }
  if (input.mode === 'amount' && (!Number.isInteger(input.value) || input.value < 0)) {
    throw new Error('An amount savings target must be a non-negative whole number of cents.');
  }
}

export function getSavingsTarget(month: string): SavingsTarget | null {
  assertMonth(month);
  const row = getDb()
    .select({ month: savingsTargets.month, mode: savingsTargets.mode, value: savingsTargets.value })
    .from(savingsTargets)
    .where(eq(savingsTargets.month, month))
    .get();
  return row ?? null;
}

/** Upsert on `month` (ruling T3/T4: one household, one row per month) -- a second save for the
 *  same month replaces it rather than adding a duplicate row. */
export function saveSavingsTarget(input: SavingsTarget, at: Date = new Date()): void {
  assertTarget(input);
  const db = getDb();
  const timestamp = nowIso(at);
  const existing = db.select({ month: savingsTargets.month }).from(savingsTargets).where(eq(savingsTargets.month, input.month)).get();

  if (existing) {
    db.update(savingsTargets)
      .set({ mode: input.mode, value: input.value, updatedAt: timestamp })
      .where(eq(savingsTargets.month, input.month))
      .run();
    return;
  }

  db.insert(savingsTargets)
    .values({ month: input.month, mode: input.mode, value: input.value, createdAt: timestamp, updatedAt: timestamp })
    .run();
}

export function deleteSavingsTarget(month: string): boolean {
  assertMonth(month);
  const result = getDb().delete(savingsTargets).where(eq(savingsTargets.month, month)).run();
  return Number(result.changes ?? 0) > 0;
}

/**
 * Ruling T4 (copy-forward, the same idiom Budgets' "Copy previous month" already uses). Returns
 * false -- writes nothing -- when the previous month has no target at all, so a caller can tell
 * "nothing to copy" apart from "copied successfully".
 */
export function copySavingsTargetForward(month: string, at: Date = new Date()): boolean {
  assertMonth(month);
  const previous = getSavingsTarget(addMonths(month, -1));
  if (previous === null) return false;
  saveSavingsTarget({ month, mode: previous.mode, value: previous.value }, at);
  return true;
}

/** Percent applied to this month's income, or the fixed amount. null when there is no target, or
 *  a percent target has no positive income to apply to (never divide by zero). */
function resolveTargetCents(target: SavingsTarget | null, incomeCents: number): number | null {
  if (target === null) return null;
  if (target.mode === 'amount') return target.value;
  if (incomeCents <= 0) return null;
  return Math.round((incomeCents * target.value) / 100);
}

/**
 * Ruling T1a: flagged transfer DEPOSITS (positive amounts) landing in an account of
 * `type = 'savings'` this month. Disclosure only -- see this module's docblock -- so it is
 * computed independently of cashflowTrend's income/spend series rather than folded into it.
 *
 * `noSavingsAccount` is true when the viewer's household has no savings-type account at all
 * (active accounts only, same as every other balance-facing read in this app -- e.g.
 * src/lib/networth.ts's netWorthOverTime uses listAccounts({}, viewer) the same way): that is
 * exactly the configuration where an unflagged transfer to an outside bank silently understates
 * the month (ruling T1, case 3), so the tile has to say so instead of showing a confident zero.
 *
 * Uses `listAccounts` for its account set so a self-scoped viewer only ever sees deposits into
 * savings accounts THEY own (ruling R2, v1.13.0) -- the same boundary every other account-scoped
 * read in this app respects, rather than re-deriving a person filter here.
 */
function movedToSavings(month: string, viewer: Viewer): { movedToSavingsCents: number; noSavingsAccount: boolean } {
  const savingsAccountIds = listAccounts({}, viewer)
    .filter((account) => account.type === 'savings')
    .map((account) => account.id);
  if (savingsAccountIds.length === 0) return { movedToSavingsCents: 0, noSavingsAccount: true };

  const row = getDb()
    .select({ total: sql<number>`sum(${transactions.amountCents})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.isTransfer, true),
        gt(transactions.amountCents, 0),
        inArray(transactions.accountId, savingsAccountIds),
        gte(transactions.date, monthStart(month)),
        lte(transactions.date, monthEnd(month)),
      ),
    )
    .get();

  return { movedToSavingsCents: row?.total ?? 0, noSavingsAccount: false };
}

/**
 * Ruling T1: gets its income/spend/net from `cashflowTrend(1, { endMonth: month }, viewer)` --
 * NOT a second query -- so this can never drift from the one series every other report reads.
 * `met` is `netCents >= targetCents` with `targetCents !== null`; a month with no target is
 * never "met" and never "missed", it simply has no opinion (matches this file's docblock and
 * the plan's own wording).
 */
export function savingsProgress(month: string, viewer: Viewer): SavingsProgress {
  assertMonth(month);
  const target = getSavingsTarget(month);
  const [row] = cashflowTrend(1, { endMonth: month }, viewer);
  const incomeCents = row?.incomeCents ?? 0;
  const spendCents = row?.spendCents ?? 0;
  const netCents = row?.netCents ?? incomeCents - spendCents;
  const targetCents = resolveTargetCents(target, incomeCents);
  const met = targetCents !== null && netCents >= targetCents;
  const pct = targetCents !== null && targetCents > 0 ? Math.round((netCents / targetCents) * 100) : null;
  const { movedToSavingsCents, noSavingsAccount } = movedToSavings(month, viewer);

  return { month, target, targetCents, incomeCents, spendCents, netCents, pct, met, movedToSavingsCents, noSavingsAccount };
}

/**
 * Consecutive months ending at `endMonth` whose target was set AND met. Stops at the first miss
 * or the first month with no target -- both are the same "no streak past here" signal, since a
 * monthless gap is not a met month either. Bounded by `max` so a household with years of history
 * cannot make this walk unboundedly far back.
 */
export function savingsStreak(endMonth: string, viewer: Viewer, max: number = 24): number {
  assertMonth(endMonth);
  let streak = 0;
  let month = endMonth;
  while (streak < max) {
    const progress = savingsProgress(month, viewer);
    if (progress.target === null || !progress.met) break;
    streak += 1;
    month = addMonths(month, -1);
  }
  return streak;
}
