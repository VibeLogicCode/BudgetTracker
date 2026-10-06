// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { addDaysIso, todayIso } from '@/lib/dates';
import { INSIGHTS_MAX_ROWS } from '@/lib/insights';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * Spec 2026-10-05 §2.1–§2.4. The real page against a real database. Dates are relative to today
 * because the page reads the clock; a rhythm is days apart, so no month boundary is involved.
 */
const currentUser = vi.hoisted(() => ({
  value: { id: 0, name: '', username: '', role: 'admin' as 'admin' | 'member', visibility: 'household' as 'household' | 'self' },
}));
vi.mock('@/lib/auth/session', () => ({ requireUser: async () => currentUser.value }));

afterEach(cleanup);

describe('InsightsPage', () => {
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
    const monthly = (merchant: string, person: number, accountId?: number) => {
      for (const daysAgo of [63, 33, 3]) spend({ merchant, daysAgo, cents: 1349, person, accountId });
    };
    return { adult: adult.id, child: child.id, chequing, visa, spend, monthly };
  }

  async function renderPage(searchParams: Record<string, string> = {}) {
    const { default: InsightsPage } = await import('@/app/(app)/insights/page');
    return render(await InsightsPage({ searchParams: Promise.resolve(searchParams) }));
  }

  it('renders the guide, both tiers and a marked merchant under Known recurring', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.spend({ merchant: 'RIVERSIDE GYM', daysAgo: 4, cents: 4500, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('What is this page for?');
    expect(screen.getByRole('heading', { name: 'Known recurring' })).toBeTruthy();
    expect(container.textContent).toContain('RIVERSIDE GYM');
    expect(container.textContent).toContain('MAPLE STREAMING');
  });

  /** Review Focus 3. */
  it('a self viewer sees only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    const { container } = await renderPage({ person: String(s.adult) });
    expect(container.textContent).toContain('CEDAR PHONE CO');
    expect(container.textContent).not.toContain('MAPLE STREAMING');
  });

  it('filters to the account in ?account= and keeps the choice selected', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('HARBOUR INSURANCE', s.adult, s.visa);
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ account: String(s.visa) });
    expect(container.textContent).toContain('HARBOUR INSURANCE');
    expect(container.textContent).not.toContain('MAPLE STREAMING');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe(String(s.visa));
  });

  /** Review Focus 3. */
  it('ignores an account the viewer cannot see', async () => {
    const s = await seed();
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    const { container } = await renderPage({ account: String(s.visa) });
    expect(container.textContent).toContain('CEDAR PHONE CO');
    expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
  });

  it('says whose charges a household viewer is looking at, with the way back', async () => {
    const s = await seed();
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage({ person: String(s.child) });
    expect(container.textContent).toMatch(/Recurring charges here are Robin/);
    expect(screen.getByRole('link', { name: 'Show the whole household' }).getAttribute('href')).toBe('/insights');
  });

  it('shows every Needs a look finding, past the Dashboard cap', async () => {
    const s = await seed();
    s.spend({ merchant: 'LAKESIDE DOMAIN', daysAgo: 90, cents: 2400, person: s.adult });
    for (let n = 1; n <= INSIGHTS_MAX_ROWS + 2; n += 1) {
      s.spend({ merchant: `SHOP ${n}`, daysAgo: 1, cents: 6500, person: s.adult });
      s.spend({ merchant: `SHOP ${n}`, daysAgo: 1, cents: 6500, person: s.adult });
    }
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(screen.getAllByRole('button', { name: /as fine and take it off this card/ })).toHaveLength(INSIGHTS_MAX_ROWS + 2);
  });

  /** Review ruling R6. */
  it('a self viewer can pick an account their own charges landed on, though they do not own it', async () => {
    const s = await seed();
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ account: String(s.chequing) });
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect(select.value).toBe(String(s.chequing));
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels).toContain('Everyday Chequing');
    expect(labels).not.toContain('Travel Visa');
  });
});
