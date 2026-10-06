import { dayLabel } from '@/lib/dates';
import type { RecurringShow, RecurringSort } from '@/lib/insights-links';
import { formatCents } from '@/lib/money';
// Type-only: @/lib/recurring imports @/db, and this module is value-imported by client components
// (tests/ops/client-bundle.test.ts draws exactly that line).
import type { RecurringChargeRow, RecurringCharges, RecurringTier } from '@/lib/recurring';

/**
 * Spec 2026-10-06 §2.1–§2.3. What the Insights summary and the full page read from the rows, pure,
 * so a client component and a server page can share it. Every string here states what was measured
 * or what the household said (spec §2.7).
 */
export const TIER_LABEL: Record<RecurringTier, string> = { known: 'Known', looks: 'Looks', forming: 'Forming' };

export const SHOW_LABEL: Record<RecurringShow, string> = {
  all: 'All',
  known: 'Known recurring',
  looks: 'Looks recurring',
  forming: 'Forming',
  late: 'Late',
};

export const SORT_LABEL: Record<RecurringSort, string> = {
  monthly: 'Monthly amount',
  next: 'Next expected',
  last: 'Last charge',
  merchant: 'Merchant, A to Z',
};

export function rhythmLabel(row: RecurringChargeRow): string {
  if (row.cadence === null) return 'Marked';
  return row.cadence === 'monthly' ? 'Monthly' : 'Yearly';
}

/** Spec §2.3: a late row reads "expected Oct 12, nothing since" -- a measured fact, no verdict. */
export function nextExpectedText(row: RecurringChargeRow, today: string): string {
  if (row.nextExpected === null) return '—';
  const day = dayLabel(row.nextExpected, today);
  return row.late ? `expected ${day}, nothing since` : day;
}

/** Spec §2.4. */
export function priceRiseText(row: RecurringChargeRow): string | null {
  if (row.priceRise === null) return null;
  return `up from ${formatCents(row.priceRise.fromCents)} to ${formatCents(row.priceRise.toCents)}`;
}

/** Spec §2.1. The card's three lines. The monthly figure is Known only, and only rows with a cadence. */
export interface RecurringSummary {
  known: number;
  /** How many Known rows the monthly figure was summed from; 0 means the card prints no figure. */
  knownPriced: number;
  knownMonthlyCents: number;
  late: number;
  looks: number;
  forming: number;
}

type Tiers = Pick<RecurringCharges, 'known' | 'looks' | 'forming'>;

export function recurringSummary(result: Tiers): RecurringSummary {
  const priced = result.known.filter((row) => row.monthlyCents !== null);
  return {
    known: result.known.length,
    knownPriced: priced.length,
    knownMonthlyCents: priced.reduce((sum, row) => sum + (row.monthlyCents ?? 0), 0),
    late: result.known.filter((row) => row.late).length,
    looks: result.looks.length,
    forming: result.forming.length,
  };
}

const byMerchant = (a: RecurringChargeRow, b: RecurringChargeRow) => (a.merchant < b.merchant ? -1 : a.merchant > b.merchant ? 1 : 0);

/** Ascending, a missing date last. */
function byDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const COMPARE: Record<RecurringSort, (a: RecurringChargeRow, b: RecurringChargeRow) => number> = {
  monthly: (a, b) => (b.monthlyCents ?? -1) - (a.monthlyCents ?? -1) || byMerchant(a, b),
  next: (a, b) => Number(b.late) - Number(a.late) || byDate(a.nextExpected, b.nextExpected) || byMerchant(a, b),
  last: (a, b) => byDate(b.lastDate, a.lastDate) || byMerchant(a, b),
  merchant: byMerchant,
};

/** Spec §2.2. Every tier in one list, narrowed by Show and ordered by Sort. A new array; the inputs are left as they are. */
export function recurringRows(result: Tiers, view: { show: RecurringShow; sort: RecurringSort }): RecurringChargeRow[] {
  const all = [...result.known, ...result.looks, ...result.forming];
  const shown = all.filter((row) => (view.show === 'all' ? true : view.show === 'late' ? row.late : row.tier === view.show));
  return shown.sort(COMPARE[view.sort]);
}

export type RecurringRowAction =
  | { kind: 'mark'; mark: 'recurring' | 'not_recurring' | 'clear'; label: string; ariaLabel: string }
  | { kind: 'link'; href: string; label: string };

/**
 * Spec §2.2, row actions by state. Looks or Forming: Mark recurring, Not recurring, and Track when
 * nothing covers it. Known by a mark: Unmark, and Track when nothing covers it. Known by tracking
 * only: Mark recurring (so it stays listed if the record goes) and the way to the item.
 */
export function recurringRowActions(row: RecurringChargeRow): RecurringRowAction[] {
  const mark: RecurringRowAction = { kind: 'mark', mark: 'recurring', label: 'Mark recurring', ariaLabel: `Mark ${row.merchant} as recurring` };
  const track: RecurringRowAction[] =
    row.tracked === null ? [{ kind: 'link', href: `/warranties/new?transactionId=${row.transactionId}`, label: 'Track' }] : [];
  if (row.tier !== 'known') {
    return [
      mark,
      { kind: 'mark', mark: 'not_recurring', label: 'Not recurring', ariaLabel: `Mark ${row.merchant} as not recurring and take it off these lists` },
      ...track,
    ];
  }
  if (row.knownBy === 'mark') return [{ kind: 'mark', mark: 'clear', label: 'Unmark', ariaLabel: `Unmark ${row.merchant}` }, ...track];
  return row.tracked === null ? [mark] : [mark, { kind: 'link', href: `/warranties/${row.tracked.itemId}`, label: `Open ${row.tracked.itemName}` }];
}
