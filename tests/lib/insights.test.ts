import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createCategory } from '@/lib/categories';
import { householdInsights } from '@/lib/insights';
import { setTransactionSplits } from '@/lib/splits';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

const TODAY = '2026-08-27';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('householdInsights (ruling R6)', () => {
  let adultId = 0;
  let childId = 0;
  let accountId = 0;

  const seed = async () => {
    current = createTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    childId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
    accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
  };

  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });
  const child = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });

  const spend = (date: string, description: string, cents: number, person = adultId) =>
    createManualTransaction({
      accountId,
      date,
      description,
      amountCents: -cents,
      categoryId: null,
      attributedUserId: person,
      userId: adultId,
      actorRole: 'admin',
    });

  it('says nothing at all on a household with too little history', async () => {
    await seed();
    spend('2026-08-20', 'GROCERY STORE', 4210);
    expect(householdInsights({ today: TODAY, viewer: adult() })).toEqual([]);
  });

  it('flags a charge far above that merchant own baseline', async () => {
    await seed();
    // Twelve months of ordinary charges, then one outlier inside the lookback window.
    for (let month = 8; month <= 19; month += 1) {
      const iso = `2025-${String(month > 12 ? month - 12 : month).padStart(2, '0')}-05`;
      spend(month > 12 ? iso.replace('2025', '2026') : iso, 'GROCERY STORE', 4200);
    }
    const outlier = spend('2026-08-20', 'GROCERY STORE', 92000);
    const rows = householdInsights({ today: TODAY, viewer: adult() });
    expect(rows.filter((row) => row.kind === 'unusual').map((row) => row.transactionId)).toEqual([outlier]);
  });

  it('flags a duplicate pair and links to the SECOND charge', async () => {
    await seed();
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const second = spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const rows = householdInsights({ today: TODAY, viewer: adult() });
    expect(rows.filter((row) => row.kind === 'duplicate').map((row) => row.transactionId)).toEqual([second]);
  });

  it('still flags a duplicate whose earlier charge sits 16 days back, past the 14-day lookback (fix round 1, finding 1)', async () => {
    await seed();
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    // Earlier charge is 16 days before `today` -- outside the 14-day lookback on its own -- and
    // the later charge is only 2 days after it (2026-08-13, 14 days back), well inside
    // DUPLICATE_WINDOW_DAYS. Before the fix, the pre-findDuplicates filter dropped the earlier
    // row entirely (its date < today-14), so this pair was never seen at all.
    spend('2026-08-11', 'CITY TAX OFFICE', 6500);
    const later = spend('2026-08-13', 'CITY TAX OFFICE', 6500);
    const rows = householdInsights({ today: TODAY, viewer: adult() });
    expect(rows.filter((row) => row.kind === 'duplicate').map((row) => row.transactionId)).toEqual([later]);
  });

  it('a self viewer sees only rows from their own transactions', async () => {
    await seed();
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    expect(householdInsights({ today: TODAY, viewer: child() })).toEqual([]);
  });

  it('never returns more than INSIGHTS_MAX_ROWS', async () => {
    await seed();
    for (let n = 1; n <= 12; n += 1) spend(`2025-${String(n).padStart(2, '0')}-05`, 'GROCERY STORE', 4200);
    for (let n = 1; n <= 20; n += 1) {
      spend('2026-08-20', `SHOP ${n}`, 6500);
      spend('2026-08-20', `SHOP ${n}`, 6500);
    }
    expect(householdInsights({ today: TODAY, viewer: adult() }).length).toBeLessThanOrEqual(8);
  });

  describe('a split charge and the per-category baseline', () => {
    const inCategory = (date: string, description: string, cents: number, categoryId: number) =>
      createManualTransaction({
        accountId,
        date,
        description,
        amountCents: -cents,
        categoryId,
        attributedUserId: adultId,
        userId: adultId,
        actorRole: 'admin',
      });

    const split = (txnId: number, cents: number, first: number, second: number) => {
      const half = Math.floor(cents / 2);
      setTransactionSplits({
        txnId,
        userId: adultId,
        parts: [
          { categoryId: first, amountCents: -half, note: null },
          { categoryId: second, amountCents: -(cents - half), note: null },
        ],
      });
    };

    const unusualIds = () =>
      householdInsights({ today: TODAY, viewer: adult() })
        .filter((row) => row.kind === 'unusual')
        .map((row) => row.transactionId);

    /** Two categories, an anchor row for the history gate, and five $120 charges at five merchants. */
    const seedCategories = () => {
      const groceries = createCategory({ name: 'Food shop', parentId: null });
      const coffee = createCategory({ name: 'Cafe', parentId: null });
      inCategory('2025-10-01', 'ANCHOR', 100, groceries);
      for (let n = 1; n <= 5; n += 1) inCategory(`2026-0${n + 1}-1${n}`, `CORNER SHOP ${n}`, 12000, groceries);
      return { groceries, coffee };
    };

    it('a split charge is not compared with its stale parent category baseline', async () => {
      await seed();
      const { groceries, coffee } = seedCategories();
      const control = inCategory('2026-08-20', 'ONE OFF STORE', 41288, groceries);
      expect(unusualIds()).toEqual([control]);

      split(control, 41288, groceries, coffee);
      expect(unusualIds()).toEqual([]);
    });

    it('a split parent does not pad its category baseline', async () => {
      await seed();
      const { groceries, coffee } = seedCategories();
      // Eleven samples with a $900 median would hide a $412.88 charge; without the six it is $120.
      for (let n = 1; n <= 6; n += 1) {
        const big = inCategory(`2026-03-0${n}`, `BIG SPLIT ${n}`, 90000 + n, groceries);
        split(big, 90000 + n, groceries, coffee);
      }
      const candidate = inCategory('2026-08-20', 'ONE OFF STORE', 41288, groceries);
      expect(unusualIds()).toEqual([candidate]);
    });

    it('a split charge is still checked against its merchant baseline', async () => {
      await seed();
      const { groceries, coffee } = seedCategories();
      for (let n = 1; n <= 5; n += 1) inCategory(`2026-0${n + 1}-0${n}`, 'HARDWARE STORE', 12000, groceries);
      const outlier = inCategory('2026-08-20', 'HARDWARE STORE', 41288, groceries);
      split(outlier, 41288, groceries, coffee);
      expect(unusualIds()).toEqual([outlier]);
    });
  });
});
