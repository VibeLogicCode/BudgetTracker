// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, within } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { addDaysIso, dayLabel, todayIso } from '@/lib/dates';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * Spec 2026-10-06 §2.2–§2.4. The real page against a real database. Dates are day offsets from
 * today (the page reads the clock); no month boundary is involved.
 */
const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('RecurringChargesPage', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  const today = todayIso();

  async function seed() {
    t = createTestDb();
    const adult = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const child = await createUser({ name: 'Robin', username: 'robin', password: 'correct horse battery', role: 'member' });
    const chequing = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: adult.id });
    const visa = createAccount({ name: 'Travel Visa', type: 'credit', ownerUserId: adult.id });
    const spend = (input: { merchant: string; daysAgo: number; cents: number; person: number; accountId?: number }) =>
      createManualTransaction({
        accountId: input.accountId ?? chequing,
        date: addDaysIso(today, -input.daysAgo),
        description: input.merchant,
        amountCents: -input.cents,
        categoryId: null,
        attributedUserId: input.person,
        userId: adult.id,
        actorRole: 'admin',
      });
    return { adult: adult.id, child: child.id, chequing, visa, spend };
  }

  /** Looks: MAPLE STREAMING. Known, late, on Travel Visa: RIVERSIDE GYM. Forming: HARBOUR INSURANCE. */
  async function seedThreeTiers() {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'MAPLE STREAMING', daysAgo, cents: 1349, person: s.adult });
    for (const daysAgo of [100, 70]) s.spend({ merchant: 'RIVERSIDE GYM', daysAgo, cents: 4500, person: s.adult, accountId: s.visa });
    for (const daysAgo of [33, 3]) s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo, cents: 13400, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    return s;
  }

  async function renderPage(searchParams: Record<string, string> = {}) {
    const { default: RecurringChargesPage } = await import('@/app/(app)/insights/recurring/page');
    return render(await RecurringChargesPage({ searchParams: Promise.resolve(searchParams) }));
  }

  const table = () => within(document.querySelector('[data-recurring-table]') as HTMLElement);
  const merchantsInTable = () =>
    table()
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.querySelector('a')?.textContent);

  it('lists every tier in one table, with the tier, rhythm and monthly figure', async () => {
    await seedThreeTiers();
    await renderPage();
    expect(merchantsInTable()).toEqual(['HARBOUR INSURANCE', 'RIVERSIDE GYM', 'MAPLE STREAMING']);
    expect(table().getByText('Known')).toBeTruthy();
    expect(table().getByText('Looks')).toBeTruthy();
    expect(table().getByText('Forming')).toBeTruthy();
    expect(table().getAllByText('$134.00').length).toBeGreaterThan(0);
  });

  /** Review Focus 1. */
  it('Show Late on the replaced card lists the marked merchant that went quiet', async () => {
    const s = await seedThreeTiers();
    await renderPage({ account: String(s.visa), show: 'late' });
    expect(merchantsInTable()).toEqual(['RIVERSIDE GYM']);
    expect(table().getByText(`expected ${dayLabel(addDaysIso(today, -40), today)}, nothing since`)).toBeTruthy();
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe(String(s.visa));
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('late');
  });

  it('sorts by next expected, late first', async () => {
    await seedThreeTiers();
    await renderPage({ sort: 'next' });
    expect(merchantsInTable()[0]).toBe('RIVERSIDE GYM');
  });

  /** Review Focus 3. */
  it('reads a malformed query as the defaults', async () => {
    await seedThreeTiers();
    await renderPage({ show: 'everything', sort: 'drop', account: 'abc', person: 'x' });
    expect(merchantsInTable()).toHaveLength(3);
    expect((screen.getByLabelText('Show') as HTMLSelectElement).value).toBe('all');
    expect((screen.getByLabelText('Sort') as HTMLSelectElement).value).toBe('monthly');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  /** Review Focus 4. */
  it('a self viewer sees only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'MAPLE STREAMING', daysAgo, cents: 1349, person: s.adult });
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ person: String(s.adult) });
    expect(merchantsInTable()).toEqual(['CEDAR PHONE CO']);
  });

  /** Review Focus 4. */
  it('ignores an account the viewer cannot see', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ account: String(s.visa) });
    expect(merchantsInTable()).toEqual(['CEDAR PHONE CO']);
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  it('says whose charges a household viewer is looking at, with the way back', async () => {
    const s = await seed();
    for (const daysAgo of [63, 33, 3]) s.spend({ merchant: 'CEDAR PHONE CO', daysAgo, cents: 6200, person: s.child });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ person: String(s.child), show: 'looks' });
    expect(container.textContent).toMatch(/Recurring charges here are Robin/);
    expect(screen.getByRole('link', { name: 'Show the whole household' }).getAttribute('href')).toBe('/insights/recurring?show=looks');
  });

  it('says so when nothing charges on a rhythm yet, and never uses the banned words', async () => {
    await seed();
    currentUser.value = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('Nothing charges on a rhythm yet.');
    expect(container.textContent).not.toMatch(/subscription|wasted|forgotten|cancel|missed payment/i);
  });
});
