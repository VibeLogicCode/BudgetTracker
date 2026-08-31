// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { currentMonth } from '@/lib/dates';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.21.0 item 1: budgets/page.tsx's own half of the scope-pill feature -- reading `?person=`,
 * validating it, and deciding `selectedPersonId` (household's grid when null, that person's when
 * not). budgets-client.test.tsx and budgets-rollover-ui.test.tsx already exercise what the CLIENT
 * does with a given `selectedPersonId`; this file is the one place the SERVER-SIDE resolution --
 * the part a naive test would otherwise have to reverse-engineer out of which category cards
 * happen to render -- is checked directly, the same way dashboard.test.tsx's own
 * `capturedSavingsChartProps` checks what DashboardPage computes without fighting recharts'
 * jsdom-hostile internals.
 *
 * BudgetsClient is mocked ONLY in this file (not in budgets-page.test.tsx, which still renders
 * the real component to prove what a household viewer actually SEES) -- a module-level vi.mock
 * applies to every test in its file, and every other budgets-page test still wants the real
 * render.
 */

const capturedProps = vi.hoisted(() => ({ selectedPersonId: undefined as number | null | undefined }));
vi.mock('@/app/(app)/budgets/budgets-client', () => ({
  BudgetsClient: (props: { selectedPersonId?: number | null }) => {
    capturedProps.selectedPersonId = props.selectedPersonId;
    return null;
  },
}));

const currentUser = vi.hoisted(() => ({
  value: {
    id: 0,
    name: '',
    username: '',
    role: 'admin' as 'admin' | 'member',
    visibility: 'household' as 'household' | 'self',
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireUser: async () => currentUser.value,
}));

afterEach(() => {
  capturedProps.selectedPersonId = undefined;
});

describe('BudgetsPage — v1.21.0 item 1: reading and validating `?person=`', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function setup() {
    t = createSeededTestDb();
    const db = t.db;
    const adultId = insertTestUser(db, { name: 'Adult', username: 'adult', role: 'admin' });
    const kidId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    insertTestAccount(db, { name: 'Chequing', ownerUserId: adultId });
    return { adultId, kidId };
  }

  it('defaults to Household (null) when no `?person=` is present', async () => {
    const { adultId } = setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({}) }));
    expect(capturedProps.selectedPersonId).toBe(null);
  });

  it('resolves `?person=<id>` to that id when it names a real attributable person', async () => {
    const { adultId, kidId } = setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({ person: String(kidId) }) }));
    expect(capturedProps.selectedPersonId).toBe(kidId);
  });

  it('falls back to Household for a `?person=` naming nobody in this household (removed member, stale bookmark)', async () => {
    const { adultId, kidId } = setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({ person: String(kidId + 999) }) }));
    expect(capturedProps.selectedPersonId).toBe(null);
  });

  it('falls back to Household for a non-numeric `?person=`, the same "malformed input never throws" rule `month` follows', async () => {
    const { adultId } = setup();
    currentUser.value = { id: adultId, name: 'Adult', username: 'adult', role: 'admin', visibility: 'household' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    render(await BudgetsPage({ searchParams: Promise.resolve({ person: 'not-a-number' }) }));
    expect(capturedProps.selectedPersonId).toBe(null);
  });

  it('ruling R2: a self-scoped viewer always resolves to null, even when `?person=<someone-else>` is given', async () => {
    const { adultId, kidId } = setup();
    currentUser.value = { id: kidId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const { default: BudgetsPage } = await import('@/app/(app)/budgets/page');
    // Asking for the admin's id explicitly -- a self viewer has no household scope to select in
    // the first place (their `people` is only ever themselves), and this proves the URL cannot
    // be used to reach it even so.
    render(await BudgetsPage({ searchParams: Promise.resolve({ person: String(adultId), month: currentMonth() }) }));
    expect(capturedProps.selectedPersonId).toBe(null);
  });
});
