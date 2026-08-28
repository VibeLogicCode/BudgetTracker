import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { addDaysIso } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import {
  creepVerdict,
  findDuplicates,
  hasEnoughHouseholdHistory,
  unusualVerdict,
  type SpendRow,
} from '@/lib/predict/anomalies';
import { DUPLICATE_LOOKBACK_DAYS, UNUSUAL_BASELINE_DAYS, UNUSUAL_LOOKBACK_DAYS } from '@/lib/predict/constants';

/**
 * v1.13.0 ruling R6 (item AJ / PROD-2). The maths already existed and was tested; it was
 * reachable only as a Telegram or email notification, so a household member with no channel
 * configured never learned that a subscription went up. This module is the READ-ONLY surface
 * for it.
 *
 * WHY IT IS NOT UNDER src/lib/predict/ (micro-ruling M4): tests/ops/predict-invariants.test.ts
 * fails any file in that tree except history.ts that imports @/db. This one needs the database,
 * so it cannot live there.
 *
 * WHY IT DOES NOT REUSE src/lib/notify/evaluate/anomalies.ts's queries (micro-ruling M4): that
 * module is built around a module-level fingerprint cache and per-user enqueue caps, both of
 * which exist to stop a notification firing twice. A page render wants neither, and threading
 * them through a shared helper would be a larger and riskier diff than the one query below.
 */
export type InsightKind = 'unusual' | 'duplicate' | 'creep';

export interface InsightRow {
  kind: InsightKind;
  /** The transaction the card row links to. A duplicate pair links to the SECOND charge. */
  transactionId: number;
  date: string;
  merchant: string;
  amountCents: number;
  /** One sentence, already formatted. The card renders it verbatim (MUST-19.11). */
  sentence: string;
}

/** The card is a nudge, not a report. Eight rows is a glance; forty is a second inbox. */
export const INSIGHTS_MAX_ROWS = 8;

function readSlice(sliceStart: string, scope: number | null): SpendRow[] {
  const clauses = [gte(transactions.date, sliceStart), eq(transactions.isTransfer, false), lt(transactions.amountCents, 0)];
  if (scope !== null) clauses.push(eq(transactions.attributedUserId, scope));
  return getDb()
    .select({
      id: transactions.id,
      date: transactions.date,
      merchant: transactions.normalizedMerchant,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(and(...clauses))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .all();
}

function earliestDate(scope: number | null): string | null {
  const row = getDb()
    .select({ first: sql<string | null>`min(${transactions.date})` })
    .from(transactions)
    .where(scope === null ? undefined : eq(transactions.attributedUserId, scope))
    .get();
  return row?.first ?? null;
}

/**
 * Newest-first, up to INSIGHTS_MAX_ROWS. Self-hides entirely (R6) when the household has too
 * little history to have a baseline at all, and respects R2 for a self viewer -- every query
 * below is scoped through ownerScope exactly like the rest of this release's readers.
 */
export function householdInsights(input: { today: string; viewer: Viewer }): InsightRow[] {
  const { today } = input;
  const scope = ownerScope(input.viewer);

  // The same first gate the notification evaluator applies: a household that has been using
  // the app for a fortnight has no baseline, and a "baseline" drawn from three rows is a guess
  // presented as a finding.
  if (!hasEnoughHouseholdHistory(earliestDate(scope), today)) return [];

  const baselineStart = addDaysIso(today, -UNUSUAL_BASELINE_DAYS);
  const slice = readSlice(baselineStart, scope);
  const lookbackStart = addDaysIso(today, -UNUSUAL_LOOKBACK_DAYS);
  const rows: InsightRow[] = [];

  for (const candidate of slice) {
    if (candidate.date < lookbackStart) continue;
    const merchantSample = slice
      .filter((row) => row.id !== candidate.id && row.merchant === candidate.merchant)
      .map((row) => Math.abs(row.amountCents));
    const categorySample =
      candidate.categoryId === null
        ? []
        : slice.filter((row) => row.id !== candidate.id && row.categoryId === candidate.categoryId).map((row) => Math.abs(row.amountCents));
    const verdict = unusualVerdict({ amountCents: candidate.amountCents, merchantSample, categorySample });
    if (verdict === null) continue;
    rows.push({
      kind: 'unusual',
      transactionId: candidate.id,
      date: candidate.date,
      merchant: candidate.merchant,
      amountCents: candidate.amountCents,
      sentence: `${formatCents(Math.abs(candidate.amountCents))} at ${candidate.merchant} — usually about ${formatCents(verdict.baselineCents)}.`,
    });
  }

  const duplicateStart = addDaysIso(today, -DUPLICATE_LOOKBACK_DAYS);
  for (const pair of findDuplicates({ rows: slice.filter((row) => row.date >= duplicateStart), today })) {
    rows.push({
      kind: 'duplicate',
      // The SECOND (higher-id) charge: it is the one a person would question, and the one
      // they would reverse.
      transactionId: pair.higherId,
      date: pair.laterDateIso,
      merchant: pair.merchant,
      amountCents: pair.amountCents,
      sentence: `${pair.merchant} charged ${formatCents(Math.abs(pair.amountCents))} twice on ${pair.laterDateIso}.`,
    });
  }

  const byMerchant = new Map<string, SpendRow[]>();
  for (const row of slice) {
    const bucket = byMerchant.get(row.merchant);
    if (bucket) bucket.push(row);
    else byMerchant.set(row.merchant, [row]);
  }
  for (const [merchant, charges] of byMerchant) {
    const verdict = creepVerdict({ charges, today });
    if (verdict === null) continue;
    const source = charges.find((charge) => charge.id === verdict.transactionId);
    if (source === undefined) continue; // defensive: creepVerdict always returns an id from `charges`
    rows.push({
      kind: 'creep',
      transactionId: verdict.transactionId,
      date: verdict.dateIso,
      merchant,
      amountCents: source.amountCents,
      sentence: `${merchant} went from ${formatCents(verdict.baselineCents)} to ${formatCents(verdict.newAmountCents)}.`,
    });
  }

  // Newest first, so the card leads with what just happened.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.transactionId - a.transactionId));
  return rows.slice(0, INSIGHTS_MAX_ROWS);
}
