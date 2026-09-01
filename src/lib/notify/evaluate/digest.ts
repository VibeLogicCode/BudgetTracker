import { budgetProgress, type BudgetRow } from '@/lib/budgets';
import { findUserById, listUsers } from '@/lib/auth/users';
import { type Viewer } from '@/lib/auth/viewer';
import { reviewQueueCount } from '@/lib/categorize/engine';
import { addDaysIso, currentMonth } from '@/lib/dates';
import { categoryBreakdown, topMerchants } from '@/lib/reports';
import { householdWeeklyDigestKey, weeklyDigestKey } from '@/lib/notify/events';
import { mondayOfIsoWeek } from '@/lib/notify/evaluate/slots';
import { householdRoutedChannels } from '@/lib/notify/household';
import { enqueue, enqueuedAnything } from '@/lib/notify/outbox';
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
 * v1.13.1 (item BK). Returns null -- and the evaluator sends NOTHING -- if the user row is gone by
 * the time this runs (a deleted account mid-batch). It used to fall back to a household-scoped
 * admin viewer so one missing row could not crash the batch, which is still the right instinct;
 * the wrong part was the shape of the fallback. A self-scoped recipient whose row vanished in
 * the window their digest fired would have carried household-wide figures in that one delivery,
 * which is the single thing ruling R2 exists to prevent. Skipping still cannot crash the batch.
 */
function viewerFor(userId: number): Viewer | null {
  const user = findUserById(userId);
  return user ? { id: user.id, role: user.role, visibility: user.visibility } : null;
}

/**
 * v1.28.0. The viewer the HOUSEHOLD digest is rendered with, and the answer to "can a member's
 * visibility setting change what the family channel says": no, structurally.
 *
 * viewerFor() builds a viewer from the RECIPIENT, and scopeFor() in reports.ts silently forces a
 * self-visibility viewer to their own rows (ruling R2). That is exactly right for a message
 * addressed to one person and exactly wrong for one message addressed to a room: whichever
 * member's slot happened to fire first would decide what everybody else reads, and a household
 * with one self-scoped member would get a "household total" that was really that member's spend.
 * So the household digest is rendered through this synthetic household-scoped viewer instead --
 * it is not a per-viewer render at all, and no member's setting is consulted.
 *
 * The honest consequence, and the household's own decision (v1.28.0 decision 3): routing the
 * digest to the family channel PUTS household figures and per-member spend in a room every member
 * reads. Ruling R2 keeps household totals away from a self-scoped viewer's screen; it cannot
 * govern a group chat an admin deliberately pointed the household's bot at. Nobody's personal
 * digest changes -- a self-scoped member who is still receiving one still sees only their own
 * figures -- and no PERSONAL-scope event is ever routable at all (enqueue's subjectScope).
 */
const HOUSEHOLD_VIEWER: Viewer = { id: 0, role: 'admin', visibility: 'household' };

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
  // Item BK: 0 already means "no outbox row was enqueued" to every caller of this function.
  if (viewer === null) return 0;

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

  const reviewCount = reviewQueueCount();
  const overBudget = overBudgetNames(budgetProgress(currentMonth(input.now), 'household', null));

  const { subject, body } = renderEvent({
    event: 'weekly_digest',
    variant: 'personal',
    fromIso: from,
    toIso: to,
    householdSpentCents: sum(householdCategories),
    personalSpentCents: sum(personalCategories),
    topCategories,
    topMerchants: topMerchantLines,
    reviewCount,
    overBudget,
  });

  // Only built when the digest is actually routed: an unrouted household pays for none of the
  // per-member queries below, and its evaluation is exactly what it was before v1.28.0.
  const routed = householdRoutedChannels('weekly_digest');
  const household =
    routed.length === 0
      ? undefined
      : buildHouseholdDigest({ from, to, slotDate: input.slotDate, reviewCount, overBudget });

  const result = enqueue({
    userId: input.userId,
    eventId: 'weekly_digest',
    dedupKey: weeklyDigestKey(input.slotDate),
    subject,
    body,
    household,
    at: input.now,
  });
  return enqueuedAnything(result) ? 1 : 0;
}

/**
 * The family channel's digest: the household total, one line per person, and the unattributed
 * pile. Every figure comes from categoryBreakdown() through HOUSEHOLD_VIEWER, so the lines are a
 * true partition of the total -- personClause() in reports.ts splits on attributed_user_id with
 * `= id` per person and `IS NULL` for unattributed, and those are exhaustive and disjoint.
 *
 * listUsers(), not listAttributablePeople(): a DEACTIVATED person's transactions still carry
 * their attribution, so leaving them out would quietly break the addition. They are named only
 * when they actually spent something in the window; an active member with a zero week is still
 * named, because "Bob $0.00" is information and Bob's absence from the list is not.
 */
function buildHouseholdDigest(input: {
  from: string;
  to: string;
  slotDate: string;
  reviewCount: number;
  overBudget: string[];
}): { subject: string; body: string; dedupKey: string } {
  const { from, to } = input;
  const sum = (rows: { spentCents: number }[]): number => rows.reduce((total, row) => total + row.spentCents, 0);

  const members: DigestLine[] = [];
  for (const person of listUsers()) {
    const cents = sum(categoryBreakdown({ from, to, attributedUserId: person.id }, HOUSEHOLD_VIEWER));
    if (!person.isActive && cents === 0) continue;
    members.push({ name: person.name, cents });
  }

  const { subject, body } = renderEvent({
    event: 'weekly_digest',
    variant: 'household',
    fromIso: from,
    toIso: to,
    householdSpentCents: sum(categoryBreakdown({ from, to }, HOUSEHOLD_VIEWER)),
    members,
    unattributedCents: sum(categoryBreakdown({ from, to, attributedUserId: 'unattributed' }, HOUSEHOLD_VIEWER)),
    topCategories: categoryBreakdown({ from, to }, HOUSEHOLD_VIEWER)
      .slice()
      .sort((a, b) => b.spentCents - a.spentCents)
      .slice(0, TOP_CATEGORIES)
      .map((row) => ({ name: row.categoryName, cents: row.spentCents })),
    topMerchants: topMerchants({ from, to, limit: TOP_MERCHANTS }, HOUSEHOLD_VIEWER).map((row) => ({
      name: row.normalizedMerchant,
      cents: row.spentCents,
    })),
    reviewCount: input.reviewCount,
    overBudget: input.overBudget,
  });

  // Keyed by the WEEK, not by this member's slot date: see householdWeeklyDigestKey. Every
  // member's weekly slot in the same week aims at this one key, so the group gets one digest
  // however many people fire, and however differently they set their own digest weekday.
  return { subject, body, dedupKey: householdWeeklyDigestKey(mondayOfIsoWeek(input.slotDate)) };
}
