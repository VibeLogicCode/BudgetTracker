import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { createCategory } from '@/lib/categories';
import { setAccountActive } from '@/lib/accounts';
import { setLastAccountId } from '@/lib/auth/users';
import { NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { createWarrantyItem, getWarrantyItem } from '@/lib/warranty/items';
import { addInstallment, listInstallments } from '@/lib/warranty/installments';
import { createItemType } from '@/lib/warranty/types';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility: 'household' | 'self' } = {
  id: 1,
  name: 'Admin',
  username: 'admin',
  role: 'admin',
  visibility: 'household',
};
let originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(originHeaders),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// CRITICAL: a 'use server' file may export only async functions -- CROSS_ORIGIN_ERROR is
// imported directly from its canonical home rather than re-exported by actions.ts.
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import { recordBillPaymentAction, setBillCategoryAction } from '@/app/(app)/bills/actions';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let adminId: number;
let accountId: number;
let itemId: number;
let installmentId: number;
let propertyTaxCategoryId: number;

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function unpaidCount(id: number): number {
  return listInstallments(id, '2026-08-27', 30).filter((row) => row.paidAt === null).length;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-bills-actions-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };

  current = createSeededTestDb();
  adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  accountId = insertTestAccount(current.db, { type: 'chequing', ownerUserId: null });
  setLastAccountId(adminId, accountId);

  const billType = createItemType(`Bill ${randomUUID()}`, 'bill');
  propertyTaxCategoryId = createCategory({ name: `Property tax ${randomUUID()}`, parentId: null });

  itemId = createWarrantyItem({
    name: 'Property tax',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: adminId,
    transactionId: null,
    typeId: billType.id,
    notes: null,
  });
  installmentId = addInstallment({ itemId, dueDate: '2026-06-30', amountCents: 180_000 });

  currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
});

afterEach(() => {
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('recordBillPaymentAction (ruling R8)', () => {
  it('rejects a cross-origin request before touching auth or the database', async () => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('records the payment and says so', async () => {
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.message).toMatch(/recorded/i);
    expect(unpaidCount(itemId)).toBe(0);
  });

  it('refuses on an installment belonging to another person (ruling R3)', async () => {
    const otherMemberId = insertTestUser(current!.db, { name: 'Bob', username: 'bob', role: 'member' });
    currentUser = { id: otherMemberId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };

    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('tells the person plainly when the row was already marked', async () => {
    await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    const second = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(second.error).toMatch(/already marked paid/i);
  });

  it('tells the person to add an account when they have none', async () => {
    setAccountActive(accountId, false);
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toMatch(/account/i);
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('says so plainly when the installment no longer exists', async () => {
    const result = await recordBillPaymentAction({}, formData({ installmentId: '999999' }));
    expect(result.error).toMatch(/no longer exists/i);
  });

  it('leaves the remembered account untouched when the attempt fails', async () => {
    setAccountActive(accountId, false);
    const before = (await import('@/lib/auth/users')).findUserById(adminId)?.lastAccountId;
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toMatch(/account/i);
    const after = (await import('@/lib/auth/users')).findUserById(adminId)?.lastAccountId;
    expect(after).toBe(before);
  });

  it('remembers the account used only after a successful record', async () => {
    const otherAccountId = insertTestAccount(current!.db, { name: 'Cash', type: 'cash', ownerUserId: null });
    setLastAccountId(adminId, otherAccountId);
    await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    // The installment is paid using the remembered account (otherAccountId), and that choice is
    // unchanged by the call -- setLastAccountId was already pointing there, so this simply proves
    // recording did not clobber it with some other default.
    const { findUserById } = await import('@/lib/auth/users');
    expect(findUserById(adminId)?.lastAccountId).toBe(otherAccountId);
  });
});

describe('setBillCategoryAction (ruling R11)', () => {
  it('links and unlinks', async () => {
    const link = await setBillCategoryAction({}, formData({ itemId: String(itemId), categoryId: String(propertyTaxCategoryId) }));
    expect(link.message).toBeTruthy();
    expect(getWarrantyItem(itemId, currentUser)?.budgetCategoryId).toBe(propertyTaxCategoryId);

    const clear = await setBillCategoryAction({}, formData({ itemId: String(itemId), categoryId: '' }));
    expect(clear.message).toBeTruthy();
    expect(getWarrantyItem(itemId, currentUser)?.budgetCategoryId).toBeNull();
  });

  it('refuses on an item belonging to another person (ruling R3)', async () => {
    const otherMemberId = insertTestUser(current!.db, { name: 'Bob', username: 'bob', role: 'member' });
    currentUser = { id: otherMemberId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };

    const result = await setBillCategoryAction({}, formData({ itemId: String(itemId), categoryId: String(propertyTaxCategoryId) }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
  });

  it('rejects a cross-origin request', async () => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const result = await setBillCategoryAction({}, formData({ itemId: String(itemId), categoryId: String(propertyTaxCategoryId) }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });
});
