import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { findUserById } from '@/lib/auth/users';
import { type Viewer } from '@/lib/auth/viewer';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { addDaysIso, currentMonth } from '@/lib/dates';
import { categoryBreakdown, topMerchants } from '@/lib/reports';
import { weeklyDigestKey } from '@/lib/notify/events';
import { enqueue } from '@/lib/notify/outbox';
import { renderEvent, type DigestLine } from '@/lib/notify/render';

const TOP_CATEGORIES = 5;
const TOP_MERCHANTS = 3;

/**
 * v1.13.0 ruling R2 (Task 6 fix round 1, controller ruling): every reports.ts aggregate this
 * evaluator calls now takes a viewer, and a self-visibility viewer is silently forced to their
 * own scope regardless of what is asked (src/lib/reports.ts's scopeFor). Building the viewer from
 * the RECIPIENT's own user record -- not a hardcoded household viewer -- is what makes a
 * household/admin recipient's digest byte-identical to before, and a self-visibility recipient's
 * digest carry only their own attributed figures through every line below, never the true
 * household total (R2: no household totals reach a self viewer through any channel).
 *
 * Falls back to a household-scoped viewer if the user row is somehow gone by the time this
 * evaluator runs (a deleted account mid-batch): that reproduces the pre-R2 unscoped behaviour
 * rather than crashing the whole scheduled run over one missing row.
 */
function viewerFor(userId: number): Viewer {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : { id: userId, role: 'admin', visibility: 'household' };
}

function overBudgetNames(rows: BudgetRow[], acc: string[] = []): string[] {
  for (const row of rows) {
    if (row.overBudget) acc.push(row.categoryName);
    if (row.children.length > 0) overBudgetNames(row.children, acc);
  }
  return acc;
}

/**
 * §10.2: the digest covers the 7 days ENDING THE DAY BEFORE the slot date:
 * from = addDaysIso(slotDate, -7), to = addDaysIso(slotDate, -1). A fixed trailing window
 * rather than a fixed calendar week running Monday to Sunday, so any chosen digest_weekday
 * yields a complete week with no stale tail (decision 8).
 *
 * Composed from EXISTING helpers only: categoryBreakdown() and topMerchants() in
 * reports.ts, budgetProgress() in budgets.ts, reviewQueueCount() in categorize/engine.ts
 * (a count, not listReviewQueue()'s hydrated rows: accurate above 1000 and no row
 * hydration for a number nothing else in this message needs).
 * Transfers and income are excluded by the report helpers themselves.
 *
 * A week with no transactions still sends: silence would be indistinguishable from a
 * broken channel.
 */
export function evaluateWeeklyDigest(input: { userId: number; slotDate: string; now: Date }): number {
  const from = addDaysIso(input.slotDate, -7);
  const to = addDaysIso(input.slotDate, -1);
  const viewer = viewerFor(input.userId);

  const householdCategories = categoryBreakdown({ from, to }, viewer);
  const personalCategories = categoryBreakdown({ from, to, attributedUserId: input.userId }, viewer);

  const sum = (rows: { spentCents: number }[]): number => rows.reduce((total, row) => total + row.spentCents, 0);

  const topCategories: DigestLine[] = householdCategories
    .slice()
    .sort((a, b) => b.spentCents - a.spentCents)
    .slice(0, TOP_CATEGORIES)
    .map((row) => ({ name: row.categoryName, cents: row.spentCents }));

  // TopMerchantRow's field is `normalizedMerchant` (src/lib/reports.ts): the merchant name
  // as stored, which normalizeMerchant() UPPERCASES (src/lib/categorize/normalize.ts), so
  // production digests show e.g. "LOBLAWS", not a title-cased or lowercase variant.
  const topMerchantLines: DigestLine[] = topMerchants({ from, to, limit: TOP_MERCHANTS }, viewer).map((row) => ({
    name: row.normalizedMerchant,
    cents: row.spentCents,
  }));

  const { subject, body } = renderEvent({
    event: 'weekly_digest',
    fromIso: from,
    toIso: to,
    householdSpentCents: sum(householdCategories),
    personalSpentCents: sum(personalCategories),
    topCategories,
    topMerchants: topMerchantLines,
    reviewCount: reviewQueueCount(),
    overBudget: overBudgetNames(budgetProgress(currentMonth(input.now), 'household', null)),
  });

  const result = enqueue({
    userId: input.userId,
    eventId: 'weekly_digest',
    dedupKey: weeklyDigestKey(input.slotDate),
    subject,
    body,
    at: input.now,
  });
  return result.inserted.length > 0 ? 1 : 0;
}
