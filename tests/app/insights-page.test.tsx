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
// redirect() throws in Next; the same stand-in tests/app/import-page.test.ts uses, the rest of the module kept.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

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

  it('renders the guide and the Recurring charges summary, without the rows', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.spend({ merchant: 'RIVERSIDE GYM', daysAgo: 4, cents: 4500, person: s.adult });
    s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo: 33, cents: 13400, person: s.adult });
    s.spend({ merchant: 'HARBOUR INSURANCE', daysAgo: 3, cents: 13400, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    const { container } = await renderPage();
    expect(container.textContent).toContain('What is this page for?');
    const card = screen.getByRole('heading', { name: 'Recurring charges' }).closest('section') as HTMLElement;
    expect(card.textContent).toContain('1 merchant');
    expect(card.textContent).toContain('1 to review');
    expect(card.textContent).toContain('1 one more charge from a rhythm');
    expect(card.querySelector('table')).toBeNull();
    expect(screen.getByRole('link', { name: 'See all recurring charges' }).getAttribute('href')).toBe('/insights/recurring');
  });

  it('links the late count to the full page', async () => {
    const s = await seed();
    for (const daysAgo of [100, 70]) s.spend({ merchant: 'RIVERSIDE GYM', daysAgo, cents: 4500, person: s.adult });
    setRecurringMarks({ merchants: ['RIVERSIDE GYM'], mark: 'recurring', userId: s.adult, actorRole: 'admin' });
    currentUser.value = { id: s.adult, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await renderPage();
    expect(screen.getByRole('link', { name: '1 late' }).getAttribute('href')).toBe('/insights/recurring?show=late&sort=next');
  });

  /** Review Focus 4. */
  it('a self viewer’s summary counts only their own charges, whatever ?person= says', async () => {
    const s = await seed();
    s.monthly('MAPLE STREAMING', s.adult);
    s.monthly('CEDAR PHONE CO', s.child);
    currentUser.value = { id: s.child, name: 'Robin', username: 'robin', role: 'member', visibility: 'self' };
    await renderPage({ person: String(s.adult) });
    const card = screen.getByRole('heading', { name: 'Recurring charges' }).closest('section') as HTMLElement;
    expect(card.textContent).toContain('1 to review');
  });

  /** Review Focus 3: v1.54.0 promised a filtered list could be bookmarked or sent. */
  it('sends a v1.54.0 /insights?account= link to the full page', async () => {
    await seed();
    currentUser.value = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };
    await expect(renderPage({ account: '7', person: '3' })).rejects.toThrow('NEXT_REDIRECT:/insights/recurring?person=3&account=7');
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
});
