import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { setRecurringMarks } from '@/lib/categorize/rules';
import { setupSuggestions } from '@/lib/setup-suggestions';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

/** v1.62.0 lane E1. Explicit March 2026 dates; the clock is never read. */
const TODAY = '2026-03-18';

describe('setupSuggestions', () => {
  let t: TestDb | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function seed() {
    t = createTestDb();
    const alex = await createUser({ name: 'Alex', username: 'alex', password: 'correct horse battery', role: 'admin' });
    const sam = await createUser({ name: 'Sam', username: 'sam', password: 'correct horse battery', role: 'member' });
    const account = createAccount({ name: 'Everyday Chequing', type: 'chequing', ownerUserId: alex.id });
    const spend = (merchant: string, date: string, cents: number, person: number) =>
      createManualTransaction({
        accountId: account,
        date,
        description: merchant,
        amountCents: -cents,
        categoryId: null,
        attributedUserId: person,
        userId: alex.id,
        actorRole: 'admin',
      });
    const monthly = (merchant: string, cents: number, person: number, day = '02') => {
      for (const month of ['2026-01', '2026-02', '2026-03']) spend(merchant, `${month}-${day}`, cents, person);
    };
    const household: Viewer = { id: alex.id, role: 'admin', visibility: 'household' };
    const self: Viewer = { id: sam.id, role: 'member', visibility: 'self' };
    return { alex: alex.id, sam: sam.id, spend, monthly, household, self };
  }

  it('lists Looks merchants, largest monthly amount first, with merchant, amount, day and reason', async () => {
    const s = await seed();
    s.monthly('STREAMBOX', 1349, s.alex, '14');
    s.monthly('MAPLE MORTGAGE', 240000, s.alex);
    const rows = setupSuggestions(s.household, TODAY);
    expect(rows.map((row) => row.merchant)).toEqual(['MAPLE MORTGAGE', 'STREAMBOX']);
    expect(rows[0]).toMatchObject({ kind: 'recurring', typicalCents: 240000, monthlyCents: 240000, dayOfMonth: 2 });
    expect(rows[0].sentence).toBe(
      'MAPLE MORTGAGE looks recurring: about $2,400 around the 2nd of each month. Mark it so the month check-in counts it as still due.',
    );
    expect(rows[1].sentence).toContain('around the 14th of each month');
  });

  it('leaves out Known, Forming and not-recurring merchants', async () => {
    const s = await seed();
    s.monthly('MAPLE MORTGAGE', 240000, s.alex);
    s.monthly('STREAMBOX', 1349, s.alex);
    s.monthly('FUEL STOP 12', 5200, s.alex);
    s.spend('MAPLE GROCER', '2026-02-10', 4217, s.alex);
    s.spend('MAPLE GROCER', '2026-03-10', 4217, s.alex);
    setRecurringMarks({ merchants: ['STREAMBOX'], mark: 'recurring', userId: s.alex, actorRole: 'admin' });
    setRecurringMarks({ merchants: ['FUEL STOP 12'], mark: 'not_recurring', userId: s.alex, actorRole: 'admin' });
    expect(setupSuggestions(s.household, TODAY).map((row) => row.merchant)).toEqual(['MAPLE MORTGAGE']);
  });

  it('a mark takes the merchant out of the list', async () => {
    const s = await seed();
    s.monthly('MAPLE MORTGAGE', 240000, s.alex);
    expect(setupSuggestions(s.household, TODAY)).toHaveLength(1);
    setRecurringMarks({ merchants: ['MAPLE MORTGAGE'], mark: 'recurring', userId: s.alex, actorRole: 'admin' });
    expect(setupSuggestions(s.household, TODAY)).toEqual([]);
  });

  it('a self-scoped member sees only their own merchants', async () => {
    const s = await seed();
    s.monthly('MAPLE MORTGAGE', 240000, s.alex);
    s.monthly('STREAMBOX', 1349, s.sam);
    expect(setupSuggestions(s.self, TODAY).map((row) => row.merchant)).toEqual(['STREAMBOX']);
    expect(setupSuggestions(s.household, TODAY).map((row) => row.merchant)).toEqual(['MAPLE MORTGAGE', 'STREAMBOX']);
  });
});
