import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createManualTransaction, getTransaction, getTransactionShare, listTransactions, updateTransactionNotes } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../../helpers/db';
import { buildSplitPersonFixture } from '../../helpers/split-person-fixture';
import { setTransactionSplits } from '@/lib/splits';

const HOUSEHOLD: Viewer = { id: 1, role: 'member', visibility: 'household' };

describe('ruling R2: listTransactions and getTransaction take a viewer', () => {
  let current: TestDb | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  let adultId = 0;
  let childId = 0;
  let accountId = 0;
  let adultTxn = 0;
  let childTxn = 0;

  const setup = async () => {
    current = createTestDb();
    const adult = await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' });
    const child = await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' });
    adultId = adult.id;
    childId = child.id;
    accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
    adultTxn = createManualTransaction({
      accountId, date: '2026-08-10', description: 'GROCERY STORE', amountCents: -4210,
      categoryId: null, attributedUserId: adultId, userId: adultId,
      actorRole: 'admin',
    });
    childTxn = createManualTransaction({
      accountId, date: '2026-08-11', description: 'CORNER SHOP', amountCents: -500,
      categoryId: null, attributedUserId: childId, userId: adultId,
      actorRole: 'admin',
    });
  };

  const childViewer = (): Viewer => ({ id: childId, role: 'member', visibility: 'self' });
  const adultViewer = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  it('a household viewer sees both rows, exactly as before v1.13.0', async () => {
    await setup();
    const page = listTransactions({}, adultViewer());
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id).sort()).toEqual([adultTxn, childTxn].sort());
  });

  it('a self viewer sees only rows attributed to them', async () => {
    await setup();
    const page = listTransactions({}, childViewer());
    expect(page.total).toBe(1);
    expect(page.rows[0]?.id).toBe(childTxn);
  });

  it('a self viewer asking for someone else gets nothing, not that person rewritten', async () => {
    await setup();
    const page = listTransactions({ attributedUserId: adultId }, childViewer());
    expect(page.total).toBe(0);
    expect(page.rows).toEqual([]);
  });

  it('getTransaction returns null for another person row, and the row for their own', async () => {
    await setup();
    expect(getTransaction(adultTxn, childViewer())).toBeNull();
    expect(getTransaction(childTxn, childViewer())?.id).toBe(childTxn);
    expect(getTransaction(adultTxn, adultViewer())?.id).toBe(adultTxn);
  });

  it('ruling R13: the search box matches a note as well as a description', async () => {
    await setup();
    updateTransactionNotes(adultTxn, 'reimbursed by the school trip fund');
    const page = listTransactions({ search: 'school trip' }, HOUSEHOLD);
    expect(page.rows.map((row) => row.id)).toEqual([adultTxn]);
  });
});

/**
 * v1.63.0 (plan 2026-11-12, Lane A, A4). A self viewer's rows include every charge holding a part of
 * theirs, at their share, and never the whole amount, the other parts or another person's name.
 */
describe('v1.63.0: a self viewer and a split part set to them', () => {
  let current: TestDb | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  it('lists the shared charge at their share, marked partial, with no whole amount, and sums the share', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const page = listTransactions({}, fx.self(fx.sam));
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => [row.rawDescription, row.amountCents, row.partial, row.parentAmountCents])).toEqual([
      ['FUEL STOP 12', -6130, false, null],
      ['MAPLE GROCER', -4000, true, null],
    ]);
    expect(page.outCents).toBe(-10130);
    expect(page.inCents).toBe(0);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('-15000');
    expect(serialized).not.toContain('Alex');
  });

  it('getTransactionShare returns the share for a charge holding their part, and null for an unrelated one', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const other = fx.add({ date: '2026-03-20', description: 'CITY CLINIC', amountCents: -2500, categoryId: fx.groceries, person: fx.alex });
    expect(getTransactionShare(fx.maple, fx.self(fx.sam))).toMatchObject({ id: fx.maple, amountCents: -4000, partial: true, parentAmountCents: null });
    expect(getTransactionShare(fx.maple, fx.self(fx.sam))?.attributedUserName).toBeNull();
    expect(JSON.stringify(getTransactionShare(fx.maple, fx.self(fx.sam)))).not.toContain('-15000');
    expect(getTransactionShare(other, fx.self(fx.sam))).toBeNull();
    // A household viewer reads the whole charge.
    expect(getTransactionShare(fx.maple, fx.admin)).toMatchObject({ amountCents: -15000, partial: false, parentAmountCents: -15000 });
  });

  it('getTransaction stays the may-act gate: a part of a charge does not make the charge theirs to change', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    expect(getTransaction(fx.maple, fx.self(fx.sam))).toBeNull();
    expect(getTransaction(fx.fuel, fx.self(fx.sam))).toMatchObject({ amountCents: -6130, partial: false });
    // Alex keeps his own charge, read at his share of it.
    expect(getTransaction(fx.maple, fx.self(fx.alex))).toMatchObject({ amountCents: -8000, partial: true, attributedUserName: 'Alex', parentAmountCents: null });
    expect(getTransaction(fx.maple, fx.admin)).toMatchObject({ amountCents: -15000, partial: false, parentAmountCents: -15000 });
  });

  it('a charge whose every part is set to someone else leaves its own person scope', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const gift = fx.add({ date: '2026-03-14', description: 'PHARMACY PLUS', amountCents: -2000, categoryId: fx.groceries, person: fx.alex });
    setTransactionSplits({
      txnId: gift,
      parts: [
        { categoryId: fx.groceries, amountCents: -1500, person: fx.sam },
        { categoryId: fx.dining, amountCents: -500, person: fx.sam },
      ],
      userId: fx.alex,
    });
    expect(listTransactions({}, fx.self(fx.alex)).rows.map((row) => row.id)).toEqual([fx.maple]);
    expect(listTransactions({}, fx.self(fx.sam)).rows.find((row) => row.id === gift)).toMatchObject({ amountCents: -2000, partial: false });
  });

  it('with every part following, a self viewer list is exactly what v1.62.0 gave', () => {
    const fx = buildSplitPersonFixture({ allFollow: true });
    current = fx.t;
    const sam = listTransactions({}, fx.self(fx.sam));
    expect(sam.rows.map((row) => [row.id, row.amountCents])).toEqual([[fx.fuel, -6130]]);
    expect(sam.outCents).toBe(-6130);
    const alex = listTransactions({}, fx.self(fx.alex));
    expect(alex.rows.map((row) => [row.id, row.amountCents, row.partial])).toEqual([[fx.maple, -15000, false]]);
  });
});
