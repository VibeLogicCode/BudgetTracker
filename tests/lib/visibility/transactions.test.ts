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
    // Fix round: Alex's own charge is read WHOLE -- a server-side read, whose callers (a loan seed,
    // the over-link warning, a warranty price) need the charge itself, not his share of it.
    expect(getTransaction(fx.maple, fx.self(fx.alex))).toMatchObject({ amountCents: -15000, attributedUserName: 'Alex' });
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

/**
 * v1.63.0 fix round. What a self viewer receives of a row they reach only through a part, and the
 * amount search and sort under a person scope.
 */
describe('v1.63.0 fix round: rows reached through a part, and the share in search and sort', () => {
  let current: TestDb | null = null;
  afterEach(() => {
    current?.cleanup();
    current = null;
  });

  it('a self viewer gets no note, account name or person id on a row that is not theirs, and keeps their own', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    updateTransactionNotes(fx.maple, 'reimburse from the trip fund');
    updateTransactionNotes(fx.fuel, 'work trip');
    const rows = listTransactions({}, fx.self(fx.sam)).rows;
    expect(rows.find((row) => row.id === fx.maple)).toMatchObject({ notes: null, attributedUserId: null, attributedUserName: null, accountName: '—' });
    expect(rows.find((row) => row.id === fx.fuel)).toMatchObject({ notes: 'work trip', attributedUserId: fx.sam, accountName: 'Joint chequing' });
    expect(getTransactionShare(fx.maple, fx.self(fx.sam))).toMatchObject({ notes: null, attributedUserId: null, accountName: '—' });
    expect(JSON.stringify(rows)).not.toContain('trip fund');
    // A household viewer, person filter or not, still reads every field.
    expect(listTransactions({ attributedUserId: fx.sam }, fx.admin).rows.find((row) => row.id === fx.maple)).toMatchObject({
      notes: 'reimburse from the trip fund',
      attributedUserId: fx.alex,
      accountName: 'Joint chequing',
    });
  });

  function withSharedBill(fx: ReturnType<typeof buildSplitPersonFixture>): number {
    const bill = fx.add({ date: '2026-03-15', description: 'HYDRO BILL', amountCents: -30000, categoryId: fx.groceries, person: fx.alex });
    setTransactionSplits({
      txnId: bill,
      parts: [
        { categoryId: fx.groceries, amountCents: -27000, person: 'follow' },
        { categoryId: fx.dining, amountCents: -3000, person: fx.sam },
      ],
      userId: fx.alex,
    });
    return bill;
  }

  it('an amount search under a person scope matches the share the row shows, not the whole charge', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const bill = withSharedBill(fx);
    const scopes: [Record<string, number>, Viewer][] = [
      [{ attributedUserId: fx.sam }, fx.admin],
      [{}, fx.self(fx.sam)],
    ];
    for (const [filter, viewer] of scopes) {
      expect(listTransactions({ ...filter, search: '30.00' }, viewer).rows.map((row) => [row.id, row.amountCents])).toEqual([[bill, -3000]]);
      expect(listTransactions({ ...filter, search: '300' }, viewer).rows).toEqual([]);
    }
    // With no person scope the whole charge is what shows, and what an amount search finds.
    expect(listTransactions({ search: '300' }, fx.admin).rows.map((row) => row.id)).toEqual([bill]);
  });

  it('the amount sort under a person scope orders by the share', () => {
    const fx = buildSplitPersonFixture();
    current = fx.t;
    const bill = withSharedBill(fx);
    // Sam's shares: HYDRO BILL -30.00, MAPLE GROCER -40.00, FUEL STOP 12 -61.30. The whole charges
    // (-300.00, -150.00, -61.30) put them in the opposite order.
    const expected = [bill, fx.maple, fx.fuel];
    expect(listTransactions({ attributedUserId: fx.sam, sort: 'amount', direction: 'desc' }, fx.admin).rows.map((row) => row.id)).toEqual(expected);
    expect(listTransactions({ sort: 'amount', direction: 'desc' }, fx.self(fx.sam)).rows.map((row) => row.id)).toEqual(expected);
    expect(listTransactions({ sort: 'amount', direction: 'asc' }, fx.self(fx.sam)).rows.map((row) => row.id)).toEqual([...expected].reverse());
  });
});
