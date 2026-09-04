// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { WarrantiesClient } from '@/app/(app)/warranties/warranties-client';
import type { RecurringChargeRow } from '@/lib/recurring';
import type { WarrantyListItem, WarrantySearchResult } from '@/lib/warranty/search';

afterEach(() => cleanup());

const TODAY = '2026-08-16';

function item(over: Partial<WarrantyListItem> = {}): WarrantyListItem {
  return {
    id: 1, name: 'Fridge', vendor: 'Home Depot', model: 'GDT645SYNFS', serial: null,
    purchaseDate: '2026-08-16', warrantyMonths: 24, isLifetime: false, expiryDate: '2028-08-16',
    priceCents: 129999, ownerUserId: 7, ownerName: 'Alice', transactionId: null,
    typeId: null, typeName: null, isSubscription: false, kind: 'warranty', notes: null,
    createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
    billingCycle: null, billingAmountCents: null,
    principalCents: null, interestRateBps: null, loanDirection: 'owed', currentBalanceCents: null, balanceUpdatedAt: null,
    budgetCategoryId: null,
    status: 'active', receiptCount: 1,
    ...over,
  };
}

function result(rows: WarrantyListItem[], over: Partial<WarrantySearchResult> = {}): WarrantySearchResult {
  return { rows, total: rows.length, page: 1, pageCount: 1, ...over };
}

const people = [{ id: 7, name: 'Alice' }, { id: 8, name: 'Bob' }];
const types = [
  { id: 1, name: 'Appliance', kind: 'warranty' as const },
  { id: 2, name: 'Subscription', kind: 'subscription' as const },
];

function renderList(res: WarrantySearchResult, over: Partial<Parameters<typeof WarrantiesClient>[0]> = {}) {
  return render(
    <WarrantiesClient
      result={res}
      people={people}
      types={types}
      today={TODAY}
      query=""
      status=""
      owner=""
      typeId=""
      sort="expiry"
      billSchedules={{}}
      recurring={[]}
      recurringLoad={{ monthlyCents: 0, annualCents: 0, itemCount: 0 }}
      recurringPerson={null}
      {...over}
    />,
  );
}

describe('WarrantiesClient', () => {
  it('renders every column of §10.2', () => {
    const { container } = renderList(result([item()]));
    expect(screen.getByText('Fridge')).toBeTruthy();
    expect(screen.getByText('GDT645SYNFS')).toBeTruthy();
    expect(screen.getByText('Home Depot')).toBeTruthy();
    expect(screen.getByText('2026-08-16')).toBeTruthy();
    // Delta T9: the Expiry cell reads through expiryPhrase() -- "expires 2028-08-16" for a
    // non-subscription item -- rather than the bare date.
    expect(screen.getByText(/2028-08-16/)).toBeTruthy();
    // M15: the status filter's <select> now also spells out "Active" as an option label
    // (statusLabel(), not the raw 'active' code), and the owner filter's <select> lists
    // Alice by name -- scope both assertions to the table body to avoid a duplicate-text
    // ambiguity against those two filter controls.
    const tbodyText = container.querySelector('tbody')?.textContent;
    expect(tbodyText).toContain('Active');
    expect(tbodyText).toContain('Alice');
    // v1.15.0 (responsive rows): the item name is the row's identity, so it carries
    // cell-stack-headline for the phone-card layout.
    const headlineCell = container.querySelector('tbody tr td:first-child');
    expect(headlineCell?.className).toContain('cell-stack-headline');
  });

  // Item 4 (v1.16.0 plan): Vendor stopped being its own column -- it now reads as a muted
  // sub-line nested inside the Item cell (the "Home Depot" assertion above already proves it
  // renders somewhere; this pins WHERE), and the table lost a whole <col>/<th> pair.
  it('nests Vendor under the item name instead of giving it its own column', () => {
    const { container } = renderList(result([item()]));
    const headlineCell = container.querySelector('tbody tr td:first-child')!;
    expect(headlineCell.textContent).toContain('Home Depot');
    expect(container.querySelectorAll('thead th')).toHaveLength(8);
  });

  it('shows the expiring badge with a day count', () => {
    renderList(result([item({ status: 'expiring', expiryDate: '2026-09-15' })]));
    expect(screen.getByText('Expires in 30 days')).toBeTruthy();
  });

  it('drives ?q= from a GET form so a search is linkable and survives refresh', () => {
    const { container } = renderList(result([item()]), { query: 'fridge' });
    const form = container.querySelector('form[method="get"]')!;
    expect(form).toBeTruthy();
    const search = form.querySelector('input[name="q"]') as HTMLInputElement;
    expect(search.defaultValue).toBe('fridge');
    expect(form.querySelector('select[name="status"]')).toBeTruthy();
    expect(form.querySelector('select[name="owner"]')).toBeTruthy();
    expect(form.querySelector('select[name="sort"]')).toBeTruthy();
  });

  it('offers all six status filter options including unknown', () => {
    const { container } = renderList(result([item()]));
    const options = Array.from(container.querySelectorAll('select[name="status"] option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'active', 'expiring', 'expired', 'lifetime', 'unknown']);
  });

  // v1.2.2 Task 2: "No warranties yet" -> "Nothing tracked yet" (section rename to
  // Contracts & Coverage; the empty state now names all four kinds).
  it('distinguishes "nothing tracked yet" from "no matches for that search"', () => {
    renderList(result([]));
    expect(screen.getByText(/Nothing tracked yet/i)).toBeTruthy();
    expect(screen.getByText(/warranty, subscription, contract, or loan/i)).toBeTruthy();
    cleanup();
    renderList(result([]), { query: 'zzzz' });
    expect(screen.getByText(/No matches/i)).toBeTruthy();
  });

  // v1.2.2 Task 2: page title "Warranties" -> "Contracts & Coverage"; button "Add warranty"
  // -> "Add item" (section rename, labels only -- the route stays /warranties/new).
  it('titles the page "Contracts & Coverage" and offers Add item', () => {
    const { container } = renderList(result([item()]));
    expect(screen.getByText('Contracts & Coverage')).toBeTruthy();
    expect(screen.getByText('Add item')).toBeTruthy();
    expect(container.querySelector('a[href="/warranties/new"]')).toBeTruthy();
  });

  it('links each row to its detail page', () => {
    const { container } = renderList(result([item({ id: 42 })]));
    expect(container.querySelector('a[href="/warranties/42"]')).toBeTruthy();
  });

  it('surfaces the malformed-query message instead of a crash', () => {
    renderList(result([], { error: "That search couldn't be understood — try different words." }), { query: 'a"b' });
    expect(screen.getByText(/couldn't be understood/)).toBeTruthy();
  });

  // --- type-deltas.md T9 ---

  it('shows a Type column with the type name, or an em dash when untyped', () => {
    const { container } = renderList(
      result([item({ typeId: 1, typeName: 'Appliance' }), item({ id: 2, name: 'Netflix' })]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(2)')).map((td) => td.textContent);
    expect(cells).toEqual(['Appliance', '—']);
  });

  it('offers a type filter select that composes with q/status/owner/sort', () => {
    const { container } = renderList(result([item()]), { typeId: '2' });
    const form = container.querySelector('form[method="get"]')!;
    const typeSelect = form.querySelector('select[name="typeId"]') as HTMLSelectElement;
    expect(typeSelect).toBeTruthy();
    expect(typeSelect.value).toBe('2');
    const optionValues = Array.from(typeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['', '1', '2']);
  });

  it('renders subscription rows with "cancel by" wording instead of "expires"', () => {
    renderList(
      result([
        item({
          status: 'expiring',
          expiryDate: '2026-09-15',
          typeId: 2,
          typeName: 'Subscription',
          isSubscription: true,
          kind: 'subscription',
        }),
      ]),
    );
    expect(screen.getByText('Cancel in 30 days')).toBeTruthy();
  });

  // v1.2.2 Task 2: kind now drives the row wording directly (isSubscription is kept on the
  // data row for backward compat, but the UI reads `kind`) -- contract/loan get their own verb.
  it('renders contract and loan rows with their own expiry verb', () => {
    renderList(
      result([
        item({ id: 10, expiryDate: '2028-08-16', kind: 'contract' }),
        item({ id: 11, expiryDate: '2028-08-16', kind: 'loan' }),
      ]),
    );
    expect(screen.getByText(/ends on 2028-08-16/)).toBeTruthy();
    expect(screen.getByText(/paid off by 2028-08-16/)).toBeTruthy();
  });

  // --- v1.3.0: open-ended display label (task B) ---

  it('shows the per-kind open-ended word in the Expiry cell instead of a blank/dash for an open-ended item', () => {
    const { container } = renderList(
      result([
        item({ id: 20, isLifetime: true, expiryDate: null, kind: 'warranty' }),
        item({ id: 21, isLifetime: true, expiryDate: null, kind: 'subscription' }),
        item({ id: 22, isLifetime: true, expiryDate: null, kind: 'contract' }),
        item({ id: 23, isLifetime: true, expiryDate: null, kind: 'loan' }),
      ]),
    );
    // Item 4 (v1.16.0 plan): Expiry moved from the 5th column to the 4th once Vendor stopped
    // being its own column (Item, Type, Started, Expiry, ...).
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(4)')).map((td) => td.textContent);
    expect(cells).toEqual(['Lifetime', 'Lifetime', 'Ongoing', 'Open-ended']);
  });

  // --- v1.3.0: billing cycle and amount (task A) ---

  it('shows the Billing column with the formatted amount and cycle suffix when set', () => {
    const { container } = renderList(
      result([
        item({ id: 30, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: 'monthly', billingAmountCents: 1599 }),
      ]),
    );
    // Item 4 (v1.16.0 plan): Billing moved from the 9th (last) column to the 8th (last) once
    // Vendor stopped being its own column.
    const cell = container.querySelector('tbody td:nth-child(8)');
    expect(cell?.textContent).toBe('$15.99 / month');
  });

  it('shows an em dash in the Billing column for a warranty item and for an unset subscription', () => {
    const { container } = renderList(
      result([
        item({ id: 31, kind: 'warranty' }),
        item({ id: 32, kind: 'subscription', typeId: 2, typeName: 'Subscription' }),
      ]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(8)')).map((td) => td.textContent);
    expect(cells).toEqual(['—', '—']);
  });

  // review fix: a partial pair must never render the amount alone (silently dropping the
  // cycle the member chose) nor the cycle alone against a blank amount -- both collapse to
  // a plain em dash, same as neither being set.
  it('shows an em dash for a partial billing pair, in either direction', () => {
    const { container } = renderList(
      result([
        item({ id: 33, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: 'monthly', billingAmountCents: null }),
        item({ id: 34, kind: 'subscription', typeId: 2, typeName: 'Subscription', billingCycle: null, billingAmountCents: 1599 }),
      ]),
    );
    const cells = Array.from(container.querySelectorAll('tbody td:nth-child(8)')).map((td) => td.textContent);
    expect(cells).toEqual(['—', '—']);
  });
});

describe('WarrantiesClient — a Bill row shows its schedule (item Q)', () => {
  const bill = () => item({ id: 42, name: 'Property tax', kind: 'bill', isLifetime: true, expiryDate: null, typeName: 'Tax bill' });

  it('shows the next due date instead of "Ongoing"', () => {
    renderList(result([bill()]), { billSchedules: { 42: { nextDueDate: '2026-09-30', overdueCount: 0 } } });
    expect(screen.getByText('Next due 2026-09-30')).toBeTruthy();
    expect(screen.queryByText('Ongoing')).toBeNull();
  });

  it('leads with the overdue count when the bill is behind', () => {
    renderList(result([bill()]), { billSchedules: { 42: { nextDueDate: '2026-06-30', overdueCount: 2 } } });
    expect(screen.getByText('2 overdue · next 2026-06-30')).toBeTruthy();
  });

  it('still reads "Ongoing" when every installment is paid', () => {
    renderList(result([bill()]), { billSchedules: {} });
    expect(screen.getByText('Ongoing')).toBeTruthy();
  });

  it('leaves a non-bill kind alone', () => {
    renderList(result([item({ id: 42, kind: 'contract', isLifetime: true, expiryDate: null })]), {
      billSchedules: { 42: { nextDueDate: '2026-09-30', overdueCount: 0 } },
    });
    expect(screen.getByText('Ongoing')).toBeTruthy();
    expect(screen.queryByText('Next due 2026-09-30')).toBeNull();
  });
});

describe('WarrantiesClient — the table declares its own widths (item I, ruling P3)', () => {
  it('is a fixed table with one <col> per column', () => {
    const { container } = renderList(result([item()]));
    const table = container.querySelector('table');
    expect(table?.className).toContain('data-table--fixed');
    // Item 4 (v1.16.0 plan): 9 -> 8 once Vendor stopped being its own column.
    expect(container.querySelectorAll('colgroup > col')).toHaveLength(8);
    expect(container.querySelectorAll('thead th')).toHaveLength(8);
  });

  it('carries data-page-width="wide" and a minWidth equal to the colgroup total (item 4)', () => {
    const { container } = renderList(result([item()]));
    expect(container.querySelector('[data-page-width="wide"]')).toBeTruthy();
    const table = container.querySelector('table') as HTMLTableElement;
    expect(table.style.minWidth).toBe('72rem');
  });
});

/**
 * F-05 (2026-09-02 review, v1.31.0): the Recurring charges card and the recorded-billing line.
 *
 * Half of these assertions are about what the page must NOT say. That is the point of the
 * feature: cadence detection cannot tell a subscription from a monthly grocery shop, so any
 * wording that names one is a claim the data does not support -- and the wording is the only
 * place that claim could get made, since the read model deliberately returns no such field.
 */
function charge(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'NETFLIX',
    cadence: 'monthly',
    chargeCount: 13,
    typicalCents: 1649,
    lastAmountCents: 1799,
    lastDate: '2026-08-14',
    transactionId: 4210,
    tracked: null,
    ...over,
  };
}

describe('Recurring charges card (F-05)', () => {
  it('shows the merchant, the rhythm, the last charge and how much evidence there is', () => {
    renderList(result([]), { recurring: [charge()] });
    expect(screen.getByText('NETFLIX')).toBeTruthy();
    expect(screen.getByText('Monthly')).toBeTruthy();
    expect(screen.getByText('$17.99')).toBeTruthy();
    expect(screen.getByText('2026-08-14')).toBeTruthy();
    // The count and the typical amount together are how a reader judges the row: 13 charges is
    // stronger than 3, and "usually $16.49" against a $17.99 last charge says it varies.
    expect(screen.getByText('13 charges · usually $16.49')).toBeTruthy();
  });

  it('never calls a rhythm a subscription, and says so in the card itself', () => {
    const { container } = renderList(result([]), { recurring: [charge()] });
    const card = container.textContent ?? '';
    expect(card).toContain('A rhythm is not a subscription');
    expect(card).toContain('Nothing on this card is saved anywhere');
    // Not "Your subscriptions", not "Wasted", not "Cancel these" -- none of which the detector
    // has any basis for. The card title and the column heading both say what was measured.
    expect(card).toContain('Recurring charges');
    expect(card).not.toMatch(/your subscriptions|forgotten|wasted|you can cancel/i);
  });

  it('offers Track on an untracked merchant, through the ONE prefill path there is', () => {
    const { container } = renderList(result([]), { recurring: [charge({ transactionId: 4210 })] });
    const track = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Track');
    expect(track?.getAttribute('href')).toBe('/warranties/new?transactionId=4210');
  });

  it('names the record that covers a tracked merchant instead of showing a bare tick', () => {
    const { container } = renderList(result([]), {
      recurring: [charge({ tracked: { kind: 'item', itemId: 12, itemName: 'Netflix Premium' } })],
    });
    const badge = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Netflix Premium');
    expect(badge?.getAttribute('href')).toBe('/warranties/12');
    // No Track link on a row the household has already recorded.
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'Track')).toBe(false);
  });

  it('drills into the merchant rows through transactionsHref, carrying the person scope', () => {
    const { container } = renderList(result([]), { recurring: [charge()], recurringPerson: 7 });
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'NETFLIX');
    const href = link?.getAttribute('href') ?? '';
    expect(href.startsWith('/transactions?')).toBe(true);
    const params = new URLSearchParams(href.slice('/transactions?'.length));
    expect(params.get('q')).toBe('NETFLIX');
    expect(params.get('person')).toBe('7');
  });

  it('says nothing has a rhythm yet, rather than "no subscriptions found"', () => {
    const { container } = renderList(result([]), { recurring: [] });
    expect(container.textContent).toContain('No merchant is charging on a regular rhythm yet');
  });
});

describe('the recorded-billing header line (F-05)', () => {
  it('reads the monthly and the annual totals as two figures, never one blended number', () => {
    const { container } = renderList(result([]), {
      recurringLoad: { monthlyCents: 41200, annualCents: 118000, itemCount: 7 },
    });
    expect(container.textContent).toContain('Recorded billing:');
    expect(container.textContent).toContain('$412.00 a month, plus $1,180.00 a year billed annually, across 7 recorded items.');
    // $1,180 a year is NOT quietly divided into the monthly figure: $412 + $98.33 would be a
    // monthly payment nobody makes, and adding it would double-count the same dollar.
    expect(container.textContent).not.toContain('$510.33');
  });

  it('says "Recorded", because the figure is the sum of what somebody typed in', () => {
    const { container } = renderList(result([]), {
      recurringLoad: { monthlyCents: 1649, annualCents: 0, itemCount: 1 },
    });
    expect(container.textContent).toContain('$16.49 a month across 1 recorded item.');
  });

  it('prints no line at all when nothing carries a billing amount', () => {
    const { container } = renderList(result([]), {
      recurringLoad: { monthlyCents: 0, annualCents: 0, itemCount: 0 },
    });
    // Not "$0.00 a month", which reads as a finding about the household rather than an empty record.
    expect(container.textContent).not.toContain('Recorded billing:');
  });
});
