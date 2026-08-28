import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { cashflowTrend, personSpendSplit, topMerchants, transactionsCsv } from '@/lib/reports';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../../helpers/db';

describe('ruling R2: reports aggregates take a viewer', () => {
  let current: TestDb | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  let adultId = 0;
  let childId = 0;

  // Deviation from the brief's literal `resetTestDb()`/`beforeEach`: that export does not exist
  // in tests/helpers/db.ts (confirmed by grep -- it only appears in plan/skill docs, same finding
  // Tasks 1-3 already made). This mirrors the convention tests/lib/visibility/transactions.test.ts
  // (Task 3) already established: a per-it async setup() that opens a fresh createTestDb().
  const setup = async () => {
    current = createTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
    const accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    createManualTransaction({
      accountId, date: '2026-08-10', description: 'GROCERY STORE', amountCents: -10000,
      categoryId: null, attributedUserId: adultId, userId: adultId,
      actorRole: 'admin',
    });
    createManualTransaction({
      accountId, date: '2026-08-11', description: 'CORNER SHOP', amountCents: -500,
      categoryId: null, attributedUserId: childId, userId: adultId,
      actorRole: 'admin',
    });
  };

  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });
  const range = { from: '2026-08-01', to: '2026-08-31' };

  it('a self viewer total is their own spending, not the household', async () => {
    await setup();
    const mine = cashflowTrend(1, { endMonth: '2026-08' }, child());
    const ours = cashflowTrend(1, { endMonth: '2026-08' }, adult());
    // Brief text says `.spentCents`; MonthTrendRow's field is `spendCents` (unchanged per the
    // Wave A interface sheet), so this asserts against the real field name.
    expect(mine[0]?.spendCents).toBe(500);
    expect(ours[0]?.spendCents).toBe(10500);
  });

  it('a self viewer cannot re-scope to another person through the options object', async () => {
    await setup();
    const spoofed = cashflowTrend(1, { endMonth: '2026-08', attributedUserId: adultId }, child());
    expect(spoofed[0]?.spendCents).toBe(500);
  });

  it('topMerchants is scoped the same way', async () => {
    await setup();
    expect(topMerchants({ ...range, limit: 10 }, child()).map((row) => row.normalizedMerchant))
      .toEqual(['CORNER SHOP']);
    expect(topMerchants({ ...range, limit: 10 }, adult())).toHaveLength(2);
  });

  it('personSpendSplit collapses to one row for a self viewer', async () => {
    await setup();
    expect(personSpendSplit(range, child()).map((row) => row.userId)).toEqual([childId]);
    // 3, not 2: personSpendSplit always appends the unattributed bucket (spentCents 0 here,
    // since this fixture has no unattributed transaction) -- pre-existing, unchanged behaviour
    // ("always includes the unattributed bucket, even at zero", tests/lib/reports.test.ts) --
    // on top of the adult and child rows. The brief's literal `toHaveLength(2)` omits that row.
    expect(personSpendSplit(range, adult())).toHaveLength(3);
  });

  it('the CSV export carries only the viewer own rows', async () => {
    await setup();
    const csv = transactionsCsv({ from: range.from, to: range.to }, child());
    expect(csv).toContain('CORNER SHOP');
    expect(csv).not.toContain('GROCERY STORE');
  });
});
