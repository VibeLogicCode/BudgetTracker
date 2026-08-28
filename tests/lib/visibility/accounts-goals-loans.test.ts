import { describe, it, expect, afterEach } from 'vitest';
import { acceptsTransactions, countsTowardSafeToSpend, createAccount, listAccounts } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createGoal, listContributions, listGoals, addContribution } from '@/lib/goals';
import { createTestDb, type TestDb } from '../../helpers/db';

describe('ruling R2: accounts, goals and loans take a viewer', () => {
  let current: TestDb | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  let adultId = 0;
  let childId = 0;

  const setup = async () => {
    current = createTestDb();
    const adult = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    const child = await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' });
    adultId = adult.id;
    childId = child.id;
  };

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('a self viewer lists only the accounts they own', async () => {
    await setup();
    createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    const theirs = createAccount({ name: 'Pocket money', type: 'cash', ownerUserId: childId });
    expect(listAccounts({}, child()).map((row) => row.id)).toEqual([theirs]);
    expect(listAccounts({}, adult())).toHaveLength(2);
  });

  it('a shared (un-owned) account is not visible to a self viewer', async () => {
    await setup();
    createAccount({ name: 'Joint chequing', type: 'chequing', ownerUserId: null });
    expect(listAccounts({}, child())).toEqual([]);
  });

  it('ruling R10: the five account types round-trip and their two predicates hold', async () => {
    await setup();
    for (const type of ['chequing', 'credit', 'cash', 'savings', 'asset'] as const) {
      const id = createAccount({ name: `A ${type}`, type, ownerUserId: adultId });
      expect(listAccounts({}, adult()).find((row) => row.id === id)?.type).toBe(type);
    }
    expect(acceptsTransactions('asset')).toBe(false);
    expect(acceptsTransactions('savings')).toBe(true);
    expect(countsTowardSafeToSpend('savings')).toBe(false);
    expect(countsTowardSafeToSpend('asset')).toBe(false);
    expect(countsTowardSafeToSpend('chequing')).toBe(true);
    expect(countsTowardSafeToSpend('cash')).toBe(true);
    expect(countsTowardSafeToSpend('credit')).toBe(false);
  });

  it('a self viewer sees their own goals and shared goals, never another person goal', async () => {
    await setup();
    const mine = createGoal({ name: 'Bike', ownerUserId: childId, targetCents: 20000, targetDate: null });
    const shared = createGoal({ name: 'Holiday', ownerUserId: null, targetCents: 500000, targetDate: null });
    createGoal({ name: 'New roof', ownerUserId: adultId, targetCents: 900000, targetDate: null });
    expect(listGoals({}, child()).map((row) => row.id).sort()).toEqual([mine, shared].sort());
    expect(listGoals({}, adult())).toHaveLength(3);
  });

  it('listContributions returns nothing for a goal the viewer cannot see', async () => {
    await setup();
    const theirs = createGoal({ name: 'New roof', ownerUserId: adultId, targetCents: 900000, targetDate: null });
    addContribution({ goalId: theirs, userId: adultId, amountCents: 10000, date: '2026-08-01', note: null });
    expect(listContributions(theirs, child())).toEqual([]);
    expect(listContributions(theirs, adult())).toHaveLength(1);
  });
});
