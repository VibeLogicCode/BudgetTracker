import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { createCategory } from '@/lib/categories';
import { setLastAccountId } from '@/lib/auth/users';
import { createWarrantyItem } from '@/lib/warranty/items';
import { addInstallment, listInstallments } from '@/lib/warranty/installments';
import { createItemType } from '@/lib/warranty/types';

/**
 * Item BN. recordInstallmentPayment's linked_elsewhere refusal and the rule_owned refusal are
 * both exercised at the library level; neither goes through the ACTION, which is the layer a
 * future refactor could silently stop forwarding. Reproducing linked_elsewhere end-to-end would
 * re-test the library (it is raised deep inside the payment's own db.transaction by a loan rule
 * claiming the transaction), so this file forces each result and asserts the sentence the person
 * is shown. Partial mock: findInstallmentItem and everything else stay real.
 */
const recordInstallmentPayment = vi.hoisted(() => vi.fn());

vi.mock('@/lib/warranty/installments', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/warranty/installments')>()),
  recordInstallmentPayment,
}));

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

import { recordBillPaymentAction } from '@/app/(app)/bills/actions';

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let adminId: number;
let accountId: number;
let itemId: number;
let installmentId: number;

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function unpaidCount(id: number): number {
  return listInstallments(id, '2026-08-27', 30).filter((row) => row.paidAt === null).length;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-bills-actions-refusals-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };
  recordInstallmentPayment.mockReset();

  current = createSeededTestDb();
  adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  accountId = insertTestAccount(current.db, { type: 'chequing', ownerUserId: null });
  setLastAccountId(adminId, accountId);

  const billType = createItemType(`Bill ${randomUUID()}`, 'bill');
  createCategory({ name: `Property tax ${randomUUID()}`, parentId: null });

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

describe('recordBillPaymentAction forwards the library\'s refusals (item BN)', () => {
  it('turns linked_elsewhere into a sentence about the loan rule', async () => {
    recordInstallmentPayment.mockReturnValue({ ok: false, reason: 'linked_elsewhere' });
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe('That payment matched an existing loan rule instead of this bill, so nothing was recorded.');
    expect(unpaidCount(itemId)).toBe(1);
  });

  it('passes a rule_owned refusal through in the library\'s own words', async () => {
    recordInstallmentPayment.mockReturnValue({
      ok: false,
      reason: 'rule_owned',
      error: 'Alice set up this rule. Ask an admin to change it under Settings → Categories & rules.',
    });
    const result = await recordBillPaymentAction({}, formData({ installmentId: String(installmentId) }));
    expect(result.error).toBe('Alice set up this rule. Ask an admin to change it under Settings → Categories & rules.');
    expect(unpaidCount(itemId)).toBe(1);
  });
});
