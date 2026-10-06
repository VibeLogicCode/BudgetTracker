// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { RecurringTable } from '@/components/insights/RecurringTable';
import type { RecurringChargeRow } from '@/lib/recurring';

vi.mock('@/app/(app)/transactions/actions', () => ({ setRecurringMarkAction: vi.fn(async () => ({})) }));

afterEach(cleanup);

/** Spec 2026-10-06 §2.2–§2.4. Both trees render in jsdom (no media queries), so each test scopes to one. */
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

const late = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', lastDate: '2026-08-01', nextExpected: '2026-08-31', late: true, transactionId: 610 });
const single = row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, monthlyCents: null, nextExpected: null, transactionId: 620 });
const table = () => within(document.querySelector('[data-recurring-table]') as HTMLElement);
const cards = () => within(document.querySelector('[data-recurring-cards]') as HTMLElement);

describe('RecurringTable', () => {
  it('renders each row in a phone list and in a wide table', () => {
    render(<RecurringTable rows={[row(), late]} person={null} today={TODAY} />);
    expect(document.querySelectorAll('[data-recurring-cards] > li')).toHaveLength(2);
    expect(table().getAllByRole('row')).toHaveLength(3);
  });

  /** Review Focus 5. */
  it('says Marked and an em dash for a merchant marked after one charge, with no next expected', () => {
    render(<RecurringTable rows={[single]} person={null} today={TODAY} />);
    const cells = table().getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toContain('Marked');
    expect(cells.filter((text) => text === '—')).toHaveLength(3);
  });

  /** Review Focus 1. */
  it('reads a late row as expected <day>, nothing since, tagged Late, in both layouts', () => {
    render(<RecurringTable rows={[late]} person={null} today={TODAY} />);
    expect(table().getByText('expected Aug 31, nothing since')).toBeTruthy();
    expect(table().getByText('Late')).toBeTruthy();
    expect(cards().getByText(/expected Aug 31, nothing since/)).toBeTruthy();
  });

  it('tags a price rise as up from A to B, and names the record that covers a merchant', () => {
    render(
      <RecurringTable
        rows={[row({ priceRise: { fromCents: 1349, toCents: 1599 }, tracked: { kind: 'item', itemId: 9, itemName: 'Maple plan' } })]}
        person={null}
        today={TODAY}
      />,
    );
    expect(table().getByText('up from $13.49 to $15.99')).toBeTruthy();
    expect(table().getByRole('link', { name: 'Maple plan' }).getAttribute('href')).toBe('/warranties/9');
  });

  it('gathers a Looks row’s actions in one menu: Mark recurring, Not recurring, Track', () => {
    render(<RecurringTable rows={[row()]} person={null} today={TODAY} />);
    fireEvent.click(table().getByRole('button', { name: 'Actions for MAPLE STREAMING' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Mark recurring', 'Not recurring', 'Track']);
  });

  it('offers a single Unmark button where that is the only action', () => {
    render(<RecurringTable rows={[row({ tier: 'known', knownBy: 'mark', tracked: { kind: 'rule', itemId: 4, itemName: 'Gym plan' } })]} person={null} today={TODAY} />);
    expect(table().getByRole('button', { name: 'Unmark MAPLE STREAMING' })).toBeTruthy();
  });

  it('drills into the merchant’s transactions, carrying the person scope', () => {
    render(<RecurringTable rows={[row()]} person={7} today={TODAY} />);
    expect(table().getByRole('link', { name: 'MAPLE STREAMING' }).getAttribute('href')).toBe('/transactions?person=7&q=MAPLE+STREAMING');
  });

  it('never says subscription, wasted, forgotten, cancel or missed payment', () => {
    const { container } = render(<RecurringTable rows={[row(), late, single]} person={null} today={TODAY} />);
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });

  it('shows the last charge’s date and amount, so a merchant marked after one charge still shows what it charged', () => {
    render(<RecurringTable rows={[row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, monthlyCents: null, nextExpected: null, lastAmountCents: 6200, lastDate: '2026-10-01' })]} person={null} today={TODAY} />);
    expect(table().getByText('Oct 1 · $62.00')).toBeTruthy();
    expect(cards().getByText('Last Oct 1 · $62.00')).toBeTruthy();
  });
});
