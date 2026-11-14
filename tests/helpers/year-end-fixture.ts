import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Viewer } from '@/lib/auth/viewer';
import { createCategory } from '@/lib/categories';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { setTransactionSplits } from '@/lib/splits';
import { createTestDb, insertTestAccount, insertTestUser, type TestDb } from './db';

/**
 * v1.63.0 (plan 2026-11-12, Lane B). The one year-end fixture, 2026:
 *
 *   Medical (tax-relevant) with child Pharmacy; Charity (tax-relevant); Groceries, Dining; Salary
 *   (income). Users: Admin (admin), Alex and Sam (members, household visibility).
 *
 *   PAYROLL       +2,500.00  2026-01-30  Salary     Alex
 *   PHARMACY PLUS    -42.17  2026-02-03  Pharmacy   Alex   item owned by Alex, receipt r1 (pdf)
 *   PHARMACY PLUS    +10.00  2026-02-10  Pharmacy   Alex   (a refund)
 *   MAPLE GROCER     -80.00  2026-03-09  Groceries  Alex
 *   CITY CLINIC     -120.00  2026-04-14  Medical    Sam    item owned by Sam, receipt r2 (jpg)
 *   (transfer)      -300.00  2026-05-05  Medical    Alex   is_transfer
 *   COMMUNITY FUND  -100.00  2026-06-01  Alex's, split Charity -60.00 (follows) / Dining -40.00 (Sam)
 *   CITY CLINIC      -55.00  2025-11-20  Medical    Alex
 *
 * Medical totals 152.17 (42.17 - 10.00 + 120.00), Charity 60.00. Receipt files live under a temp
 * DATA_DIR this fixture sets and `cleanup()` restores.
 */
export interface YearEndFixture {
  t: TestDb;
  dataDir: string;
  admin: number;
  alex: number;
  sam: number;
  account: number;
  medical: number;
  pharmacy: number;
  charity: number;
  groceries: number;
  dining: number;
  salary: number;
  txn: { payroll: number; pharmacy: number; refund: number; grocer: number; clinic: number; transfer: number; fund: number; lastYear: number };
  receipts: { r1: Receipt; r2: Receipt };
  viewers: { admin: Viewer; household: (id: number) => Viewer; self: (id: number) => Viewer };
  /** A receipt on a new item owned by `owner`, linked to `txnId` by its purchase or a paid bill. */
  addReceipt: (input: { owner: number; txnId: number; via?: 'purchase' | 'bill'; mime?: Mime; bytes?: Buffer; itemName?: string }) => Receipt;
  cleanup: () => void;
}

type Mime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export interface Receipt {
  id: number;
  itemId: number;
  storedFilename: string;
  path: string;
  bytes: Buffer;
}

const EXT: Record<Mime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function buildYearEndFixture(): YearEndFixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-year-end-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true });

  const t = createTestDb();
  const admin = insertTestUser(t.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'member' });
  const sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(t.db, { name: 'Joint chequing', ownerUserId: admin });

  const medical = createCategory({ name: 'Medical', parentId: null });
  const pharmacy = createCategory({ name: 'Pharmacy', parentId: medical });
  const charity = createCategory({ name: 'Charity', parentId: null });
  const groceries = createCategory({ name: 'Groceries', parentId: null });
  const dining = createCategory({ name: 'Dining', parentId: null });
  const income = createCategory({ name: 'Income', parentId: null, isIncome: true });
  const salary = createCategory({ name: 'Salary', parentId: income });
  t.sqlite.prepare('update categories set tax_relevant = 1 where id in (?, ?)').run(medical, charity);

  const add = (over: { date: string; description: string; amountCents: number; categoryId: number | null; person: number | null; transfer?: boolean }) =>
    t.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id,
        categorization_source, is_transfer, attributed_user_id, created_by, created_at, updated_at)
      values (${account}, ${over.date}, ${over.description}, ${normalizeMerchant(over.description)}, ${over.amountCents},
        ${over.categoryId}, 'manual', ${over.transfer ? 1 : 0}, ${over.person}, ${admin}, ${nowIso()}, ${nowIso()})
      returning id`).id;

  const txn = {
    payroll: add({ date: '2026-01-30', description: 'PAYROLL', amountCents: 250000, categoryId: salary, person: alex }),
    pharmacy: add({ date: '2026-02-03', description: 'PHARMACY PLUS', amountCents: -4217, categoryId: pharmacy, person: alex }),
    refund: add({ date: '2026-02-10', description: 'PHARMACY PLUS', amountCents: 1000, categoryId: pharmacy, person: alex }),
    grocer: add({ date: '2026-03-09', description: 'MAPLE GROCER', amountCents: -8000, categoryId: groceries, person: alex }),
    clinic: add({ date: '2026-04-14', description: 'CITY CLINIC', amountCents: -12000, categoryId: medical, person: sam }),
    transfer: add({ date: '2026-05-05', description: 'TRANSFER TO SAVINGS', amountCents: -30000, categoryId: medical, person: alex, transfer: true }),
    fund: add({ date: '2026-06-01', description: 'COMMUNITY FUND', amountCents: -10000, categoryId: charity, person: alex }),
    lastYear: add({ date: '2025-11-20', description: 'CITY CLINIC', amountCents: -5500, categoryId: medical, person: alex }),
  };
  setTransactionSplits({
    txnId: txn.fund,
    parts: [
      { categoryId: charity, amountCents: -6000, person: 'follow' },
      { categoryId: dining, amountCents: -4000, person: sam },
    ],
    userId: admin,
  });

  const now = nowIso();
  const addReceipt: YearEndFixture['addReceipt'] = ({ owner, txnId, via = 'purchase', mime = 'application/pdf', bytes, itemName = 'Receipt item' }) => {
    const itemId = t.db.get<{ id: number }>(sql`
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, transaction_id, created_at, updated_at)
      values (${itemName}, '2026-01-01', 0, ${owner}, ${via === 'purchase' ? txnId : null}, ${now}, ${now})
      returning id`).id;
    if (via === 'bill') {
      t.db.run(sql`
        insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
        values (${itemId}, '2026-01-01', 1000, ${now}, ${txnId}, ${now})`);
    }
    const body = bytes ?? Buffer.from(`receipt ${randomUUID()}`);
    const storedFilename = `${randomUUID()}.${EXT[mime]}`;
    const file = path.join(dataDir, 'receipts', storedFilename);
    fs.writeFileSync(file, body);
    const id = t.db.get<{ id: number }>(sql`
      insert into warranty_receipts (warranty_item_id, original_filename, stored_filename, mime, size_bytes, sha256, ocr_status, created_at)
      values (${itemId}, ${`scan.${EXT[mime]}`}, ${storedFilename}, ${mime}, ${body.length},
        ${createHash('sha256').update(body).digest('hex')}, 'done', ${now})
      returning id`).id;
    return { id, itemId, storedFilename, path: file, bytes: body };
  };

  const r1 = addReceipt({ owner: alex, txnId: txn.pharmacy, mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 pharmacy receipt'), itemName: 'Prescription' });
  const r2 = addReceipt({
    owner: sam,
    txnId: txn.clinic,
    mime: 'image/jpeg',
    bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('clinic visit')]),
    itemName: 'Clinic visit',
  });

  return {
    t,
    dataDir,
    admin,
    alex,
    sam,
    account,
    medical,
    pharmacy,
    charity,
    groceries,
    dining,
    salary,
    txn,
    receipts: { r1, r2 },
    viewers: {
      admin: { id: admin, role: 'admin', visibility: 'household' },
      household: (id) => ({ id, role: 'member', visibility: 'household' }),
      self: (id) => ({ id, role: 'member', visibility: 'self' }),
    },
    addReceipt,
    cleanup: () => {
      t.cleanup();
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
