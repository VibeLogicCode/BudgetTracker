import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { createManualTransaction, getTransaction, listTransactions, updateTransactionNotes } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../../helpers/db';

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
