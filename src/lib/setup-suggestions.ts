import { ownerScope, type Viewer } from '@/lib/auth/viewer';
import { formatCents } from '@/lib/money';
import { recurringCharges } from '@/lib/recurring';

/**
 * v1.62.0 lane E. Small things the household can tell the app that make its numbers sharper. One
 * kind ships now: a merchant that LOOKS recurring (the dates show a rhythm, nobody has said so).
 * Marking it lets the month check-in count it as still due. The `kind` field is the room left for
 * later kinds (an unlinked card value, a big category with no budget).
 */
export interface RecurringSetupSuggestion {
  kind: 'recurring';
  /** Normalized merchant, exactly as the ledger groups it. */
  merchant: string;
  /** The merchant's newest charge: the mark buttons post it, so the action checks it against the viewer. */
  transactionId: number;
  /** Positive cents of what it usually costs per charge. */
  typicalCents: number;
  /** Positive cents of the monthly equivalent; the sort key. */
  monthlyCents: number;
  /** Day of the month of its newest charge, 1..31; null when the date cannot be read. */
  dayOfMonth: number | null;
  /** Why marking helps, one sentence. */
  reason: string;
  /** The whole line the card prints. */
  sentence: string;
}

export type SetupSuggestion = RecurringSetupSuggestion;

export const SETUP_SUGGESTION_REASON = 'Mark it so the month check-in counts it as still due.';

function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * The Looks recurring merchants (not Known, not Forming, not marked not_recurring: recurringCharges
 * already sorts those out), largest monthly amount first. `ownerUserId` is the Insights person pill
 * (null for the household); a self-scoped member is scoped to their own merchants by `ownerScope`
 * whatever the pill says, and recurringCharges applies the viewer's visibility on top.
 */
export function setupSuggestions(viewer: Viewer, today: string, ownerUserId: number | null = null): SetupSuggestion[] {
  const result = recurringCharges({ today, ownerUserId: ownerScope(viewer) ?? ownerUserId, viewer, accountId: null });
  return result.looks
    .map((row): SetupSuggestion => {
      const typicalCents = Math.abs(row.typicalCents ?? row.lastAmountCents);
      const monthlyCents = Math.abs(row.monthlyCents ?? typicalCents);
      const match = /^\d{4}-\d{2}-(\d{2})$/.exec(row.lastDate);
      const dayOfMonth = match === null ? null : Number(match[1]);
      const when =
        row.cadence === 'yearly'
          ? 'about once a year'
          : dayOfMonth === null
            ? 'about once a month'
            : `around the ${ordinal(dayOfMonth)} of each month`;
      return {
        kind: 'recurring',
        merchant: row.merchant,
        transactionId: row.transactionId,
        typicalCents,
        monthlyCents,
        dayOfMonth,
        reason: SETUP_SUGGESTION_REASON,
        sentence: `${row.merchant} looks recurring: about ${formatCents(typicalCents, { currency: true }).replace(/\.00$/, '')} ${when}. ${SETUP_SUGGESTION_REASON}`,
      };
    })
    .sort((a, b) => b.monthlyCents - a.monthlyCents || (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0));
}
