import { describe, it, expect } from 'vitest';
import type { RecurringChargeRow } from '@/lib/recurring';
import {
  nextExpectedText,
  priceRiseText,
  recurringRowActions,
  recurringRows,
  recurringSummary,
  rhythmLabel,
} from '@/lib/recurring-view';

/** Spec 2026-10-06 §2.1–§2.3. Pure: the page and the card read rows through these. */
const TODAY = '2026-10-06';

function row(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'MAPLE STREAMING',
    tier: 'looks',
    knownBy: null,
    cadence: 'monthly',
    chargeCount: 7,
    typicalCents: 1349,
    lastAmountCents: 1349,
    lastDate: '2026-09-28',
    transactionId: 501,
    tracked: null,
    accounts: [{ id: 2, name: 'Travel Visa' }],
    nextExpected: '2026-10-28',
    late: false,
    monthlyCents: 1349,
    priceRise: null,
    ...over,
  };
}

const gym = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', typicalCents: 4500, monthlyCents: 4500, lastDate: '2026-08-01', nextExpected: '2026-08-31', late: true, transactionId: 610 });
const phone = row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, monthlyCents: null, nextExpected: null, lastDate: '2026-10-01', transactionId: 620 });
const domain = row({
  merchant: 'LAKESIDE DOMAIN',
  tier: 'known',
  knownBy: 'tracked',
  cadence: 'yearly',
  typicalCents: 2500,
  monthlyCents: 208,
  lastDate: '2025-11-03',
  nextExpected: '2026-11-03',
  tracked: { kind: 'item', itemId: 9, itemName: 'Lakeside Domain' },
  transactionId: 630,
});
const insurance = row({ merchant: 'HARBOUR INSURANCE', tier: 'forming', typicalCents: 13400, monthlyCents: 13400, lastDate: '2026-10-03', nextExpected: '2026-11-02', transactionId: 640 });
const maple = row();
const result = { known: [phone, domain, gym], looks: [maple], forming: [insurance] };
const names = (rows: RecurringChargeRow[]) => rows.map((r) => r.merchant);

describe('recurringSummary', () => {
  /** Review Focus 5. */
  it('counts every Known merchant but prices only the ones with a rhythm', () => {
    expect(recurringSummary(result)).toEqual({ known: 3, knownPriced: 2, knownMonthlyCents: 4708, late: 1, looks: 1, forming: 1 });
  });

  it('is all zeroes on nothing', () => {
    expect(recurringSummary({ known: [], looks: [], forming: [] })).toEqual({ known: 0, knownPriced: 0, knownMonthlyCents: 0, late: 0, looks: 0, forming: 0 });
  });
});

describe('recurringRows', () => {
  it('shows every tier, one tier, or the late rows', () => {
    expect(recurringRows(result, { show: 'all', sort: 'merchant' })).toHaveLength(5);
    expect(names(recurringRows(result, { show: 'known', sort: 'merchant' }))).toEqual(['CEDAR PHONE CO', 'LAKESIDE DOMAIN', 'RIVERSIDE GYM']);
    expect(names(recurringRows(result, { show: 'looks', sort: 'merchant' }))).toEqual(['MAPLE STREAMING']);
    expect(names(recurringRows(result, { show: 'forming', sort: 'merchant' }))).toEqual(['HARBOUR INSURANCE']);
    expect(names(recurringRows(result, { show: 'late', sort: 'merchant' }))).toEqual(['RIVERSIDE GYM']);
  });

  it('sorts by monthly amount, biggest first, a row with none last', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'monthly' }))).toEqual([
      'HARBOUR INSURANCE', 'RIVERSIDE GYM', 'MAPLE STREAMING', 'LAKESIDE DOMAIN', 'CEDAR PHONE CO',
    ]);
  });

  it('sorts by next expected, late first, soonest next, a row with none last', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'next' }))).toEqual([
      'RIVERSIDE GYM', 'MAPLE STREAMING', 'HARBOUR INSURANCE', 'LAKESIDE DOMAIN', 'CEDAR PHONE CO',
    ]);
  });

  it('sorts by last charge, newest first, and by merchant', () => {
    expect(names(recurringRows(result, { show: 'all', sort: 'last' }))).toEqual([
      'HARBOUR INSURANCE', 'CEDAR PHONE CO', 'MAPLE STREAMING', 'RIVERSIDE GYM', 'LAKESIDE DOMAIN',
    ]);
    expect(names(recurringRows(result, { show: 'all', sort: 'merchant' }))).toEqual([
      'CEDAR PHONE CO', 'HARBOUR INSURANCE', 'LAKESIDE DOMAIN', 'MAPLE STREAMING', 'RIVERSIDE GYM',
    ]);
  });

  it('leaves the read model’s own lists in their order', () => {
    recurringRows(result, { show: 'all', sort: 'monthly' });
    expect(names(result.known)).toEqual(['CEDAR PHONE CO', 'LAKESIDE DOMAIN', 'RIVERSIDE GYM']);
  });
});

describe('the words on a row', () => {
  it('names the rhythm, or Marked without one', () => {
    expect([rhythmLabel(maple), rhythmLabel(domain), rhythmLabel(phone)]).toEqual(['Monthly', 'Yearly', 'Marked']);
  });

  it('states next expected, and a late row as expected <day>, nothing since', () => {
    expect(nextExpectedText(gym, TODAY)).toBe('expected Aug 31, nothing since');
    expect(nextExpectedText(maple, TODAY)).toBe('Oct 28');
    expect(nextExpectedText(domain, TODAY)).toBe('Nov 3');
    expect(nextExpectedText(phone, TODAY)).toBe('—');
  });

  it('states a price rise as up from A to B', () => {
    expect(priceRiseText(row({ priceRise: { fromCents: 1349, toCents: 1599 } }))).toBe('up from $13.49 to $15.99');
    expect(priceRiseText(maple)).toBeNull();
  });
});

/** Spec 2026-10-06 §2.2, row actions by state. */
describe('recurringRowActions', () => {
  const labels = (r: RecurringChargeRow) => recurringRowActions(r).map((action) => action.label);

  it('Looks and Forming: Mark recurring, Not recurring, and Track when nothing covers it', () => {
    expect(labels(maple)).toEqual(['Mark recurring', 'Not recurring', 'Track']);
    expect(recurringRowActions(maple)[2]).toEqual({ kind: 'link', href: '/warranties/new?transactionId=501', label: 'Track' });
    expect(labels(row({ tier: 'forming', tracked: { kind: 'rule', itemId: 4, itemName: 'Phone plan' } }))).toEqual(['Mark recurring', 'Not recurring']);
  });

  it('Known by a mark: Unmark, and Track when nothing covers it', () => {
    expect(labels(phone)).toEqual(['Unmark', 'Track']);
    expect(labels(row({ tier: 'known', knownBy: 'mark', tracked: { kind: 'item', itemId: 9, itemName: 'Lakeside Domain' } }))).toEqual(['Unmark']);
    expect(recurringRowActions(phone)[0]).toMatchObject({ kind: 'mark', mark: 'clear' });
  });

  it('Known by tracking only: Mark recurring, and the way to the item', () => {
    expect(recurringRowActions(domain)).toEqual([
      { kind: 'mark', mark: 'recurring', label: 'Mark recurring', ariaLabel: 'Mark LAKESIDE DOMAIN as recurring' },
      { kind: 'link', href: '/warranties/9', label: 'Open Lakeside Domain' },
    ]);
  });
});
