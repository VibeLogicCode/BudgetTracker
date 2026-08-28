import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { GET } from '@/app/api/warranties/receipts/[id]/route';
import { SESSION_COOKIE_NAME, createSession } from '@/lib/auth/session';
import { createWarrantyItem, listWarrantyReceipts, type WarrantyInput } from '@/lib/warranty/items';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';

/**
 * v1.13.0 ruling R3 / SEC-1 (review 2026-08-27). A receipt inherits its parent item's owner_user_id,
 * and the previous route only checked "does this id exist", so any signed-in household member could
 * page through every receipt in the house by incrementing the integer in the URL. This pins the fix:
 * a viewer who is neither the item's owner nor an admin gets the SAME 404 an unknown id gets --
 * never a 403, which would itself confirm the row exists.
 */

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let adminId: number;
let memberId: number;
let adminToken: string;
let memberToken: string;
let receiptOnAdminItem: number;
let receiptOnMemberItem: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function baseInput(ownerUserId: number): WarrantyInput {
  return {
    name: 'Fridge',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-08-16',
    warrantyMonths: 24,
    isLifetime: false,
    priceCents: null,
    ownerUserId,
    transactionId: null,
    typeId: null,
    notes: null,
  };
}

function attachReceipt(ownerUserId: number): number {
  const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
  writeSidecar(stagingId, { status: 'done', text: 'text' });
  const itemId = createWarrantyItem(baseInput(ownerUserId), [{ stagingId, originalFilename: 'a.jpg' }]);
  return listWarrantyReceipts(itemId)[0].id;
}

function requestAs(token: string, id: number | string) {
  const request = new Request(`http://nas.local:3000/api/warranties/receipts/${id}`, {
    headers: {
      host: 'nas.local:3000',
      origin: 'http://nas.local:3000',
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
  });
  return GET(request, { params: Promise.resolve({ id: String(id) }) });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-receipt-ownership-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  current = createSeededTestDb();
  adminId = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  memberId = insertTestUser(current.db, { name: 'Bob', username: 'bob', role: 'member' });
  adminToken = createSession(adminId).token;
  memberToken = createSession(memberId).token;
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'x' }) });

  receiptOnAdminItem = attachReceipt(adminId);
  receiptOnMemberItem = attachReceipt(memberId);
});

afterEach(() => {
  setOcrEngineForTests(null);
  resetOcrQueueForTests();
  current?.cleanup();
  current = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ruling R3 / SEC-1: a receipt is not readable by the household at large', () => {
  it("user B's session gets 404 -- not 403 -- on user A's receipt", async () => {
    const response = await requestAs(memberToken, receiptOnAdminItem);
    // 404, deliberately: a 403 confirms the row exists, and the whole point of an incrementing
    // integer id is that confirming existence IS the leak.
    expect(response.status).toBe(404);
  });

  it('the owner still gets the bytes', async () => {
    const response = await requestAs(adminToken, receiptOnAdminItem);
    expect(response.status).toBe(200);
  });

  it('an admin gets any receipt', async () => {
    const response = await requestAs(adminToken, receiptOnMemberItem);
    expect(response.status).toBe(200);
  });

  it('a member still gets their own receipt', async () => {
    const response = await requestAs(memberToken, receiptOnMemberItem);
    expect(response.status).toBe(200);
  });
});
