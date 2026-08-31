import { requireUser } from '@/lib/auth/session';
import { isSelfScoped } from '@/lib/auth/viewer';
import { listAttributablePeople } from '@/lib/auth/users';
import { sinkingFundsFor } from '@/lib/bills';
import { budgetProgress, budgetTotals, rolloverStartMonth, type BudgetRow, type BudgetScope } from '@/lib/budgets';
import { currentMonth, isMonthKey, monthEnd, todayIso } from '@/lib/dates';
import { readEnv } from '@/lib/env';
import { flattenBudgetRows } from '@/lib/notify/evaluate/pace';
import { isAllNoSpend, suggestionsFor, type ScopeSuggestions } from '@/lib/predict/history';
import { projectMonthEnd } from '@/lib/predict/pace';
import type { BudgetPredictions, CategorySuggestion, SectionPredictions } from '@/lib/predict/suggest';
import { savingsProgress } from '@/lib/savings-target';
import { BudgetsClient } from './budgets-client';

export const dynamic = 'force-dynamic';

/**
 * MUST-8.7 and MUST-16.4: the projection reuses budgetProgress()'s own spentCents, so it adds
 * no query and can never disagree with the progress bar beside it.
 */
export function sectionFrom(
  scoped: ScopeSuggestions,
  rows: BudgetRow[],
  dayOfMonth: number,
  daysInMonth: number,
): SectionPredictions {
  const suggestions: CategorySuggestion[] = [];
  for (const [categoryId, result] of scoped.byCategory) {
    if (!('suggestion' in result)) continue;
    suggestions.push({ categoryId, ...result.suggestion });
  }
  const projections: { categoryId: number; projectedCents: number }[] = [];
  for (const row of flattenBudgetRows(rows)) {
    // LOW cleanup: an archived row is read-only and carries no suggestion slot, so a pace
    // line there would sit with nothing beside it.
    if (row.isArchived) continue;
    if (row.limitCents === null) continue;
    const projectedCents = projectMonthEnd({ spentCents: row.spentCents, dayOfMonth, daysInMonth });
    if (projectedCents === null) continue;
    projections.push({ categoryId: row.categoryId, projectedCents });
  }
  return { suggestions, projections, noAttribution: false };
}

/**
 * The set of category ids with rollover ON for this (scope, user), among the rows the page
 * actually renders for that section (v1.7.0, Task 11). BudgetRow itself (src/lib/budgets.ts,
 * not modified by this task) carries no "is rollover on" field -- only baseLimitCents and
 * carryCents, which tell the reader THAT a carry exists but not whether the toggle is on for a
 * row that is not currently carrying anything (e.g. its startMonth is this month or later).
 * So this reads rolloverStartMonth once per rendered row -- the same function
 * setRolloverAction and effectiveBudget already treat as the single source of truth for
 * on/off (a row's existence in budget_rollover means on; see budgets.ts's doc comment).
 */
export function rolloverIdsFor(scope: BudgetScope, userId: number | null, rows: BudgetRow[]): number[] {
  const ids: number[] = [];
  for (const row of flattenBudgetRows(rows)) {
    if (rolloverStartMonth(scope, userId, row.categoryId) !== null) ids.push(row.categoryId);
  }
  return ids;
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireUser();
  const params = await searchParams;
  const raw = Array.isArray(params.month) ? params.month[0] : params.month;
  const month = raw && isMonthKey(raw) ? raw : currentMonth();

  const selfScoped = isSelfScoped(viewer);
  // Ruling R2: a self viewer sees no household scope at all -- a household limit is a household
  // total, which is the thing R2 names. And the personal loop is themselves and nobody else.
  const household = selfScoped ? null : budgetProgress(month, 'household', null);
  const householdRolloverIds = household === null ? [] : rolloverIdsFor('household', null, household);
  // Ruling T3: household scope only, so this is null exactly when `household` is -- there is no
  // per-person target to resolve for a self viewer, the same pairing householdTotals below uses.
  const savings = household === null ? null : savingsProgress(month, viewer);
  const people = selfScoped
    ? listAttributablePeople().filter((person) => person.id === viewer.id)
    : listAttributablePeople();

  /**
   * v1.21.0 item 1: which SET OF BUDGETS the category grid below shows -- reusing the
   * dashboard's own `?person=` param and validation shape (dashboard/page.tsx's `urlScope`),
   * not a new control (see budgets-client.tsx's own doc comment on why this is a filter over
   * which GRID renders, never over which DATA is fetched -- every household/personal query
   * below still runs exactly as it did before this item, for every scope, unconditionally).
   * A non-numeric or unrecognised id falls back to the default (household), the same
   * "malformed input is a reason to fall back, never to throw" rule `month` above already
   * follows -- and, deliberately, the same fallback a since-removed member or a stale bookmark
   * produces, rather than a page that errors because someone left the household.
   *
   * Ruling R2: forced null for a self viewer regardless of the URL. There is no household
   * scope for them to select in the first place, and (falls out of the same rule) they get no
   * pills to choose one with at all -- `people` above is already just themselves, so this could
   * never resolve to anyone else even unvalidated, but forcing it here keeps the rule stated in
   * one place rather than relying on that incidental fact.
   */
  const rawPerson = Array.isArray(params.person) ? params.person[0] : params.person;
  const requestedPersonId = rawPerson && /^\d+$/.test(rawPerson) ? Number(rawPerson) : null;
  const selectedPersonId = selfScoped
    ? null
    : requestedPersonId !== null && people.some((person) => person.id === requestedPersonId)
      ? requestedPersonId
      : null;

  const { tz } = readEnv();
  const today = todayIso(new Date(), tz);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = Number(monthEnd(month).slice(8, 10));

  /**
   * Ruling R11 / micro-ruling M9. READ-SIDE ONLY -- see sinkingFundsFor's own doc comment.
   *
   * Called ONCE PER SECTION, deliberately NOT once against a `[...household, ...personal]`
   * concatenation: sinkingFundsFor's Map is keyed by categoryId alone, with no scope of its
   * own, and budgetProgress() returns a row for EVERY category in EVERY scope regardless of
   * whether that scope actually budgets it. Concatenating rows across sections would mean the
   * last section walked wins that categoryId's carryCents for every category, including this
   * one, silently clobbering a real household carry with a personal section's untouched (zero)
   * one -- or the other way round. Calling it per section, against only that section's own
   * rows, is the only way each section's own carry survives.
   */
  const householdSinkingFunds = household === null ? {} : Object.fromEntries(sinkingFundsFor({ month, today, rows: household, viewer }));
  const personal = people.map((person) => {
    const rows = budgetProgress(month, 'personal', person.id);
    return {
      userId: person.id,
      name: person.name,
      rows,
      rolloverIds: rolloverIdsFor('personal', person.id, rows),
      sinkingFunds: Object.fromEntries(sinkingFundsFor({ month, today, rows, viewer })),
    };
  });

  // MUST-14.1: computed ONLY when the viewed month is the current month. A pace projection for
  // July, viewed in August, is not a projection.
  let predictions: BudgetPredictions | null = null;
  if (month === currentMonth(new Date(), tz)) {
    // MUST-16.3 budgets this page at 2 + 2P grouped aggregates, so each scope is read ONCE.
    // Ruling R2: a self viewer never triggers the household-scope query at all -- not even to
    // discard its result -- because sectionFrom() reads its `suggestions` straight off the
    // scope's OWN byCategory map, independent of the `rows` passed beside it. Running it for a
    // self viewer would serialize household category figures into this page's props even
    // though the Household card never renders them.
    const householdScope = selfScoped ? null : suggestionsFor({ targetMonth: month, scope: 'household', userId: null });
    const householdAllNoSpend = householdScope !== null && isAllNoSpend(householdScope.byCategory);
    const personalSections = personal.map((person) => {
      const personalScope = suggestionsFor({ targetMonth: month, scope: 'personal', userId: person.userId });
      return {
        userId: person.userId,
        monthsUsed: personalScope.months.length,
        predictions: {
          ...sectionFrom(personalScope, person.rows, dayOfMonth, daysInMonth),
          // MUST-15.2 and MUST-7.2: derived from the HISTORICAL series suggestionsFor()
          // already computed, not from this month's budgetProgress() snapshot. The current
          // month is excluded from that series by construction (historyMonths), so this
          // holds regardless of whether the person has posted anything yet this month.
          noAttribution: isAllNoSpend(personalScope.byCategory) && !householdAllNoSpend,
        },
      };
    });
    predictions = {
      // A self viewer has no household scope to count months from, so their own personal
      // scope's month count stands in for it -- the same number that section's own
      // "three full calendar months" sentence is judged against.
      monthsUsed: householdScope !== null ? householdScope.months.length : (personalSections[0]?.monthsUsed ?? 0),
      dayOfMonth,
      household:
        householdScope !== null
          ? sectionFrom(householdScope, household ?? [], dayOfMonth, daysInMonth)
          : { suggestions: [], projections: [], noAttribution: false },
      personal: personalSections.map(({ userId, predictions: sectionPredictions }) => ({ userId, predictions: sectionPredictions })),
    };
  }

  return (
    <BudgetsClient
      month={month}
      currentUserId={viewer.id}
      currentUserIsAdmin={viewer.role === 'admin'}
      selectedPersonId={selectedPersonId}
      household={household}
      householdRolloverIds={householdRolloverIds}
      householdTotals={household === null ? null : budgetTotals(household)}
      personal={personal}
      predictions={predictions}
      // A Map is not a valid Server-Component prop -- each section's sinkingFundsFor() result
      // is serialized to a plain object keyed by category id, per the comment above.
      householdSinkingFunds={householdSinkingFunds}
      savingsProgress={savings}
    />
  );
}
