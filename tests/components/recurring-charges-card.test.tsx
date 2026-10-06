// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { formingSentence, RecurringChargesCard } from '@/components/insights/RecurringChargesCard';
import type { RecurringAccount, RecurringChargeRow, RecurringCharges } from '@/lib/recurring';

afterEach(cleanup);

/**
 * Spec 2026-10-05 §2.3–§2.5. Half of these assertions are about what the card must NOT say: cadence
 * detection cannot tell a monthly shop from a bill, so every string states a measurement or the
 * household's own word.
 */
const CHEQUING: RecurringAccount = { id: 1, name: 'Everyday Chequing' };
const VISA: RecurringAccount = { id: 2, name: 'Travel Visa' };
const NONE = { monthly: 0, yearly: 0 };

function row(over: Partial<RecurringChargeRow> = {}): RecurringChargeRow {
  return {
    merchant: 'MAPLE STREAMING',
    tier: 'looks',
    knownBy: null,
    cadence: 'monthly',
    chargeCount: 7,
    typicalCents: 1349,
    lastAmountCents: 1399,
    lastDate: '2026-09-28',
    transactionId: 501,
    tracked: null,
    accounts: [VISA],
    ...over,
  };
}

function renderCard(result: Partial<RecurringCharges> = {}, over: { person?: number | null; accountId?: number | null } = {}) {
  return render(
    <RecurringChargesCard
      result={{ known: [], looks: [], forming: NONE, accounts: [CHEQUING, VISA], accountId: over.accountId ?? null, ...result }}
      person={over.person ?? null}
    />,
  );
}

const marked = row({ merchant: 'RIVERSIDE GYM', tier: 'known', knownBy: 'mark', cadence: null, chargeCount: 1, typicalCents: null, transactionId: 610, accounts: [CHEQUING] });

describe('RecurringChargesCard', () => {
  it('puts each tier under its own heading, saying what it means', () => {
    const { container } = renderCard({ known: [marked], looks: [row()] });
    expect(screen.getByRole('heading', { name: 'Known recurring' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Looks recurring' })).toBeTruthy();
    expect(container.textContent).toContain('You marked it, or you track it.');
    expect(container.textContent).toContain('A rhythm, which is not a verdict');
  });

  /** Review Focus 5. */
  it('shows Marked and an em dash for a merchant marked after one charge', () => {
    renderCard({ known: [marked] });
    expect(screen.getByText('Marked')).toBeTruthy();
    expect(screen.getByText('1 charge · usually —')).toBeTruthy();
  });

  it('lists every account a merchant charged, newest first', () => {
    renderCard({ looks: [row({ accounts: [VISA, CHEQUING] })] });
    expect(screen.getByText('Travel Visa, Everyday Chequing')).toBeTruthy();
  });

  it('offers Mark recurring and Not recurring on a Looks row, posting its newest charge', () => {
    const { container } = renderCard({ looks: [row()] });
    expect(screen.getByRole('button', { name: 'Mark MAPLE STREAMING as recurring' }).textContent).toBe('Mark recurring');
    expect(screen.getByRole('button', { name: /Mark MAPLE STREAMING as not recurring/ }).textContent).toBe('Not recurring');
    const posted = [...container.querySelectorAll('form')].map((form) => [
      form.querySelector<HTMLInputElement>('input[name="transactionId"]')?.value,
      form.querySelector<HTMLInputElement>('input[name="mark"]')?.value,
    ]);
    expect(posted).toEqual(expect.arrayContaining([['501', 'recurring'], ['501', 'not_recurring']]));
  });

  it('offers Unmark only on a row the household marked', () => {
    renderCard({ known: [marked, row({ merchant: 'CEDAR PHONE CO', tier: 'known', knownBy: 'tracked', tracked: { kind: 'item', itemId: 12, itemName: 'Cedar phone plan' } })] });
    expect(screen.getByRole('button', { name: 'Unmark RIVERSIDE GYM' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unmark CEDAR PHONE CO' })).toBeNull();
  });

  it('offers Track where nothing covers the merchant, through the one prefill path', () => {
    const { container } = renderCard({ known: [marked] });
    const track = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Track');
    expect(track?.getAttribute('href')).toBe('/warranties/new?transactionId=610');
  });

  it('names the record that covers a tracked merchant, and offers no Track on it', () => {
    const { container } = renderCard({ known: [row({ tier: 'known', knownBy: 'tracked', tracked: { kind: 'item', itemId: 12, itemName: 'Maple plan' } })] });
    const badge = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Maple plan');
    expect(badge?.getAttribute('href')).toBe('/warranties/12');
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'Track')).toBe(false);
  });

  it('drills into the merchant rows through transactionsHref, carrying the person scope', () => {
    const { container } = renderCard({ looks: [row()] }, { person: 7 });
    const href = [...container.querySelectorAll('a')].find((a) => a.textContent === 'MAPLE STREAMING')?.getAttribute('href') ?? '';
    const params = new URLSearchParams(href.slice('/transactions?'.length));
    expect([href.startsWith('/transactions?'), params.get('q'), params.get('person')]).toEqual([true, 'MAPLE STREAMING', '7']);
  });

  it('counts merchants one charge short, per band, and says nothing at zero', () => {
    expect(formingSentence(NONE)).toBeNull();
    expect(formingSentence({ monthly: 1, yearly: 0 })).toBe('1 merchant has charged twice about a month apart. One more charge and it appears here.');
    expect(formingSentence({ monthly: 4, yearly: 0 })).toBe('4 merchants have charged twice about a month apart. One more charge and they appear here.');
    expect(formingSentence({ monthly: 0, yearly: 1 })).toBe('1 merchant has charged twice about a year apart. One more charge and it appears here.');
    expect(formingSentence({ monthly: 4, yearly: 1 })).toBe('4 merchants have charged twice about a month apart, and 1 about a year apart. One more charge and they appear here.');
  });

  it('puts the forming sentence where an empty Looks list would be', () => {
    const { container } = renderCard({ known: [marked], forming: { monthly: 4, yearly: 0 } });
    expect(container.textContent).toContain('4 merchants have charged twice about a month apart.');
    expect(container.textContent).not.toContain('No merchant is charging on a regular rhythm yet');
  });

  it('with nothing listed and nothing forming, says nothing has a rhythm yet', () => {
    const { container } = renderCard();
    expect(container.textContent).toContain('No merchant is charging on a regular rhythm yet');
  });

  it('filters through a plain GET form that keeps the person scope', () => {
    const { container } = renderCard({ looks: [row()] }, { person: 7, accountId: 2 });
    const form = container.querySelector('form[method="get"]') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/insights');
    expect(form.querySelector<HTMLInputElement>('input[name="person"]')?.value).toBe('7');
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['All accounts', 'Everyday Chequing', 'Travel Visa']);
    expect(select.value).toBe('2');
  });

  it('says so by name when the chosen account has nothing on either list', () => {
    const { container } = renderCard({}, { accountId: 2 });
    expect(container.textContent).toContain('Nothing on either list charged Travel Visa.');
  });

  it('names the chosen account in the Known tier when only a Looks row charged it', () => {
    const { container } = renderCard({ looks: [row()] }, { accountId: 2 });
    expect(container.textContent).toContain('No merchant you marked or track charged Travel Visa.');
    expect(container.textContent).not.toContain('Nothing marked yet');
  });

  it('names the chosen account in the Looks tier when only a Known row charged it', () => {
    const { container } = renderCard({ known: [marked] }, { accountId: 2 });
    expect(container.textContent).toContain('Nothing else charged Travel Visa on a regular rhythm.');
  });

  it('never says subscription, wasted, forgotten or cancel', () => {
    for (const result of [{}, { known: [marked], looks: [row()], forming: { monthly: 2, yearly: 1 } }]) {
      const { container } = renderCard(result);
      expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel/i);
      cleanup();
    }
  });
});
