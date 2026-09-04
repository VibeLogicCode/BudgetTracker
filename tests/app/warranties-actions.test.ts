import { ITEM_TYPE_IMMUTABLE_ERROR, MATCHING_KIND_ERROR } from '@/lib/warranty/constants';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { nowIso } from '@/lib/clock';

let currentUser: { id: number; name: string; username: string; role: 'admin' | 'member'; visibility: 'household' | 'self' } = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'member',
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
import { revalidatePath } from 'next/cache';

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

// CRITICAL 1: 'use server' files may export only async functions (Next 15) — the module
// under test cannot also export CROSS_ORIGIN_ERROR. The canonical string lives in
// @/lib/auth/csrf, imported directly here.
import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
// IMPORTANT 3: a namespace import, not just named ones, so the exhaustiveness check below
// (`Object.keys(warrantyActions)`) reflects the module's REAL export list — a future export
// added to actions.ts without also adding a case to `cases` fails that test immediately,
// instead of silently dodging the cross-origin-first guarantee.
import * as warrantyActions from '@/app/(app)/warranties/actions';
import {
  addInstallmentAction,
  attachReceiptsAction,
  createWarrantyAction,
  deleteLoanRuleAction,
  deleteReceiptAction,
  deleteWarrantyAction,
  recomputeLoanBalanceAction,
  removeInstallmentAction,
  reRunOcrAction,
  saveLoanRuleAction,
  setInstallmentPaidAction,
  unlinkLedgerTransactionAction,
  updateWarrantyAction,
} from '@/app/(app)/warranties/actions';
import { MAX_RULES_PER_LOAN, assignTransactionToLoan, itemLedger, listLoanRules, unassignTransactionFromLoan } from '@/lib/loans';
import { attachStagedReceipts, createWarrantyItem, getWarrantyItem, getWarrantyReceipt, listWarrantyReceipts } from '@/lib/warranty/items';
import { MAX_FILES_PER_UPLOAD, receiptFileExists } from '@/lib/warranty/receipts';
import { writeSidecar, writeStagedReceipt } from '@/lib/warranty/staging';
import { resetOcrQueueForTests } from '@/lib/warranty/ocr/queue';
import { setOcrEngineForTests } from '@/lib/warranty/ocr/engine';
import { createItemType, listItemTypes } from '@/lib/warranty/types';
import { NOT_YOURS_ERROR, type Viewer } from '@/lib/auth/viewer';
import { listAudit } from '@/lib/audit';

// v1.13.0 ruling R3: a household-visibility, admin-role stand-in used ONLY to read back state for
// assertions after an action runs -- never the viewer an action itself is exercised as. Its id (0)
// never matches a real seeded user; ownerScope() doesn't care, because visibility/role alone decide
// whether a read is scoped, not whether the id is real.
const ADMIN: Viewer = { id: 0, role: 'admin', visibility: 'household' };

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;
let ownerId: number;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-warranty-actions-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  originHeaders = { origin: 'http://nas.local:3000', host: 'nas.local:3000' };
  current = createSeededTestDb();
  ownerId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: ownerId, name: 'Alice', username: 'alice', role: 'member', visibility: 'household' };
  resetOcrQueueForTests();
  setOcrEngineForTests({ recognize: async () => ({ text: 'engine text' }) });
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

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function baseFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    name: 'Fridge',
    vendor: 'Home Depot',
    model: 'GDT645SYNFS',
    serial: '',
    purchaseDate: '2026-08-16',
    warrantyMonths: '24',
    price: '$1,299.99',
    ownerUserId: String(ownerId),
    transactionId: '',
    notes: '',
    staged: '[]',
    ...over,
  };
}

/** Runs a redirecting action and returns the path it redirected to. */
async function redirectPath(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error('expected a redirect');
}

/** v1.3.1: baseFields() plus a fresh loan-kind type, so the loan fieldset's readers fire. */
function loanForm(over: Record<string, string> = {}): Record<string, string> {
  const loanType = createItemType(`Loan ${randomUUID()}`, 'loan');
  return baseFields({ typeId: String(loanType.id), principal: '', interestRate: '', currentBalance: '', ...over });
}

/** Most recently created item -- for tests that don't need the redirect path itself. */
function latestItem() {
  const row = current!.db.get<{ id: number }>(sql`select id from warranty_items order by id desc limit 1`);
  return getWarrantyItem(row.id, ADMIN)!;
}

/**
 * A loan-kind item, seeded directly through the data layer (synchronous, no action/redirect
 * dance) so tests exercising the rule actions can set up fixtures inline.
 */
function seedLoanItem(opts: { balanceCents?: number } = {}): number {
  const loanType = createItemType(`Loan ${randomUUID()}`, 'loan');
  return createWarrantyItem({
    name: 'Car Loan',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: ownerId,
    transactionId: null,
    typeId: loanType.id,
    notes: null,
    principalCents: 3_000_000,
    interestRateBps: 549,
    currentBalanceCents: opts.balanceCents ?? 2_000_000,
    balanceUpdatedAt: nowIso(),
  });
}

describe('cross-origin rejection comes FIRST (MUST-13.1)', () => {
  const cases: [string, (fd: FormData) => Promise<{ error?: string }>][] = [
    ['createWarrantyAction', (fd) => createWarrantyAction({}, fd)],
    ['updateWarrantyAction', (fd) => updateWarrantyAction({}, fd)],
    ['deleteWarrantyAction', (fd) => deleteWarrantyAction({}, fd)],
    ['attachReceiptsAction', (fd) => attachReceiptsAction({}, fd)],
    ['deleteReceiptAction', (fd) => deleteReceiptAction({}, fd)],
    ['reRunOcrAction', (fd) => reRunOcrAction({}, fd)],
    ['saveLoanRuleAction', (fd) => saveLoanRuleAction({}, fd)],
    ['deleteLoanRuleAction', (fd) => deleteLoanRuleAction(fd)],
    // v1.12.0: the three bill-installment actions (share this file's action-first origin check).
    ['addInstallmentAction', (fd) => addInstallmentAction({}, fd)],
    ['removeInstallmentAction', (fd) => removeInstallmentAction({}, fd)],
    ['setInstallmentPaidAction', (fd) => setInstallmentPaidAction({}, fd)],
    // Item 6 (v1.16.0 plan): the Linked transactions card's own Unlink.
    ['unlinkLedgerTransactionAction', (fd) => unlinkLedgerTransactionAction({}, fd)],
    // Item 6 (v1.21.0 backlog): the balance repair action.
    ['recomputeLoanBalanceAction', (fd) => recomputeLoanBalanceAction({}, fd)],
  ];

  it.each(cases)('%s refuses a mismatched Origin without touching the database', async (_name, run) => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    const before = current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c;
    const result = await run(formData(baseFields({ itemId: '1', receiptId: '1' })));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(before);
  });

  // IMPORTANT 3: a hardcoded 6-entry list above can't catch a future action added to
  // actions.ts without also being added to `cases` — it would silently ship unguarded. This
  // compares the fixture map against the module's REAL runtime export list, so a drift in
  // either direction fails immediately.
  it('the fixture map above covers exactly the module\'s exported actions', () => {
    const guarded = cases.map(([name]) => name).sort();
    const exported = Object.keys(warrantyActions).sort();
    expect(guarded).toEqual(exported);
  });
});

describe('createWarrantyAction', () => {
  it('creates the item, converts the price to cents, and redirects to the detail page', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    expect(to).toMatch(/^\/warranties\/\d+$/);
    const id = Number(to.split('/').pop());
    const item = getWarrantyItem(id, ADMIN)!;
    expect(item.name).toBe('Fridge');
    expect(item.priceCents).toBe(129999);
    expect(item.expiryDate).toBe('2028-08-16');
    expect(item.ownerUserId).toBe(ownerId);
  });

  it('stores a positive magnitude even if the price arrives signed (§17.26)', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ price: '-1299.99' }))));
    expect(getWarrantyItem(Number(to.split('/').pop()), ADMIN)!.priceCents).toBe(129999);
  });

  it('handles the Lifetime checkbox by clearing the term', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '' }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.isLifetime).toBe(true);
    expect(item.warrantyMonths).toBeNull();
    expect(item.expiryDate).toBeNull();
  });

  it('rejects lifetime combined with a term', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ isLifetime: 'on', warrantyMonths: '12' })));
    expect(result.error).toContain('lifetime');
  });

  it('rejects a future purchase date, a name over 200 chars and a non-numeric price', async () => {
    const tomorrow = '2999-01-01';
    expect((await createWarrantyAction({}, formData(baseFields({ purchaseDate: tomorrow })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ name: 'x'.repeat(201) })))).error).toBeTruthy();
    expect((await createWarrantyAction({}, formData(baseFields({ price: 'lots' })))).error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('commits staged receipts with the item', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'STAGED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const receipts = listWarrantyReceipts(Number(to.split('/').pop()));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].originalFilename).toBe('till.jpg');
    expect(receipts[0].ocrStatus).toBe('done');
  });

  // IMPORTANT 2(a): stagedSchema.safeParse (not .parse) means a shape mismatch never leaks a
  // raw ZodError.message (a JSON dump of `.issues`) to the user.
  it('rejects a malformed staged payload with a written message, not a raw ZodError dump', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ staged: '{"not":"an array"}' })));
    expect(result.error).toBe('That upload is no longer valid — please choose the files again.');
    expect(result.error).not.toContain('{');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  // IMPORTANT 2(b): invalid JSON must not leak the parser's raw SyntaxError text.
  it('rejects invalid JSON in the staged payload without leaking the parser error', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ staged: 'not-json' })));
    expect(result.error).toBe('That upload is no longer valid — please choose the files again.');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  // M4: the staged array is capped at MAX_FILES_PER_UPLOAD — an unbounded array must not
  // reach the write transaction.
  it('rejects a staged payload longer than the per-upload cap', async () => {
    const many = Array.from({ length: MAX_FILES_PER_UPLOAD + 1 }, (_, i) => ({
      stagingId: randomUUID(),
      originalFilename: `f${i}.jpg`,
    }));
    const result = await createWarrantyAction({}, formData(baseFields({ staged: JSON.stringify(many) })));
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  // IMPORTANT 2(c): ownerUserId/transactionId are only shape-checked by zod; a value that
  // does not exist reaches the FK constraint and must not leak "FOREIGN KEY constraint
  // failed" — it must read the same as a precheck would have written.
  it('refuses a nonexistent owner without leaking the raw SQLite FK error', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ ownerUserId: '999999' })));
    expect(result.error).toBe('That person or transaction no longer exists.');
    expect(result.error).not.toMatch(/FOREIGN KEY/i);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('refuses a nonexistent transactionId without leaking the raw SQLite FK error', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ transactionId: '999999' })));
    expect(result.error).toBe('That person or transaction no longer exists.');
    expect(result.error).not.toMatch(/FOREIGN KEY/i);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('accepts a transactionId and links the two', async () => {
    const accountId = insertTestAccount(current!.db, { name: 'Joint Chequing' });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-08-16', 'HOME DEPOT', 'HOME DEPOT', -129999, ${ownerId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ transactionId: String(txn.id) }))),
    );
    expect(getWarrantyItem(Number(to.split('/').pop()), ADMIN)!.transactionId).toBe(txn.id);
  });

  // Delta T8 (type-deltas.md): typeId round-trips; empty/'none' -> null; deleted/unknown
  // typeId is refused with a readable message and nothing is written; omitted -> stored NULL.
  it('round-trips a typeId and surfaces isSubscription from the type', async () => {
    const subscriptionType = listItemTypes().find((t) => t.name === 'Subscription')!;
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ typeId: String(subscriptionType.id) }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.typeId).toBe(subscriptionType.id);
    expect(item.typeName).toBe('Subscription');
    expect(item.isSubscription).toBe(true);
  });

  it('stores NULL when typeId is omitted', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.typeId).toBeNull();
    expect(item.typeName).toBeNull();
    expect(item.isSubscription).toBe(false);
  });

  it('treats an empty string and "none" as NULL', async () => {
    const to1 = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ typeId: '' }))));
    expect(getWarrantyItem(Number(to1.split('/').pop()), ADMIN)!.typeId).toBeNull();
    const to2 = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ typeId: 'none' }))));
    expect(getWarrantyItem(Number(to2.split('/').pop()), ADMIN)!.typeId).toBeNull();
  });

  it('refuses an unknown typeId and writes nothing', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ typeId: '999999' })));
    expect(result.error).toBe('That item type no longer exists.');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });
});

// v1.3.0 user request: billing cycle + amount for subscriptions/contracts.
describe('createWarrantyAction — billing cycle and amount', () => {
  it('accepts billingCycle/billingAmount for a subscription type and stores cents', async () => {
    const sub = createItemType('Streaming Action', 'subscription');
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ typeId: String(sub.id), billingCycle: 'monthly', billingAmount: '15.99' })),
      ),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.billingCycle).toBe('monthly');
    expect(item.billingAmountCents).toBe(1599);
  });

  it('leaves billing fields null when omitted, even for a subscription type', async () => {
    const sub = createItemType('Streaming Action Blank', 'subscription');
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(baseFields({ typeId: String(sub.id) }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.billingCycle).toBeNull();
    expect(item.billingAmountCents).toBeNull();
  });

  it('rejects an invalid billing cycle value with a written message', async () => {
    const sub = createItemType('Streaming Action Bad Cycle', 'subscription');
    const result = await createWarrantyAction(
      {},
      formData(baseFields({ typeId: String(sub.id), billingCycle: 'weekly' })),
    );
    expect(result.error).toBe('Billing must be Monthly or Annual.');
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('rejects a non-numeric billing amount with a written message', async () => {
    const sub = createItemType('Streaming Action Bad Amount', 'subscription');
    const result = await createWarrantyAction(
      {},
      formData(baseFields({ typeId: String(sub.id), billingAmount: 'lots' })),
    );
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('refuses billing fields on a warranty-kind type and writes nothing', async () => {
    const warranty = createItemType('Appliance Action', 'warranty');
    const result = await createWarrantyAction(
      {},
      formData(baseFields({ typeId: String(warranty.id), billingCycle: 'monthly', billingAmount: '9.99' })),
    );
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('refuses billing fields on an untyped item and writes nothing', async () => {
    const result = await createWarrantyAction({}, formData(baseFields({ billingCycle: 'monthly' })));
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  it('refuses a PAIRED billing cycle+amount on an untyped item (the kind rule alone, not the pairing rule)', async () => {
    const result = await createWarrantyAction(
      {},
      formData(baseFields({ billingCycle: 'monthly', billingAmount: '9.99' })),
    );
    expect(result.error).toBeTruthy();
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
  });

  // review fix: cycle and amount must be entered together, or not at all.
  describe('billing cycle and amount must be a pair', () => {
    it('rejects a cycle with no amount, with the written pairing message', async () => {
      const sub = createItemType('Streaming Action Pair Cycle', 'subscription');
      const result = await createWarrantyAction(
        {},
        formData(baseFields({ typeId: String(sub.id), billingCycle: 'monthly' })),
      );
      expect(result.error).toBe('Enter both a billing cycle and an amount, or neither.');
      expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
    });

    it('rejects an amount with no cycle, with the written pairing message', async () => {
      const sub = createItemType('Streaming Action Pair Amount', 'subscription');
      const result = await createWarrantyAction(
        {},
        formData(baseFields({ typeId: String(sub.id), billingAmount: '9.99' })),
      );
      expect(result.error).toBe('Enter both a billing cycle and an amount, or neither.');
      expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_items`).c).toBe(0);
    });

    it('accepts both set together, and neither set at all', async () => {
      const sub = createItemType('Streaming Action Pair Both', 'subscription');
      const to = await redirectPath(() =>
        createWarrantyAction(
          {},
          formData(baseFields({ typeId: String(sub.id), billingCycle: 'monthly', billingAmount: '9.99' })),
        ),
      );
      const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
      expect(item.billingCycle).toBe('monthly');
      expect(item.billingAmountCents).toBe(999);
    });
  });
});

// v1.14.0 (spec BU): readLoanDirection follows readBillingCycle's own shape exactly -- '' means
// "no seed" -> the column's own default, anything else must be one of the two values.
describe('createWarrantyAction — loan direction (spec BU)', () => {
  it('an empty loanDirection field means owed (the same shape readBillingCycle has)', async () => {
    // An old cached page, or a form this app did not render, posts nothing at all -- that must
    // mean the default, not a refusal.
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields({ loanDirection: '' }))));
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.loanDirection).toBe('owed');
  });

  it('stores lent when the form says so', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(loanForm({ loanDirection: 'lent' }))),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.loanDirection).toBe('lent');
  });

  it('refuses a value that is neither', async () => {
    const result = await createWarrantyAction({}, formData(loanForm({ loanDirection: 'given' })));
    expect(result?.error).toMatch(/direction/i);
  });
});

describe('updateWarrantyAction', () => {
  it('updates fields and recomputes expiry', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Dishwasher', warrantyMonths: '12' })),
    );
    expect(result.message).toBeTruthy();
    const item = getWarrantyItem(id, ADMIN)!;
    expect(item.name).toBe('Dishwasher');
    expect(item.expiryDate).toBe('2027-08-16');
  });

  // Bug fix (v1.2.4): the success message used to say "Warranty updated." unconditionally --
  // wrong for a subscription/contract/loan. An untyped item (as created by baseFields() above,
  // which omits typeId) still reads as a plain warranty by the same fallback the client
  // components use.
  it('says "Warranty updated." for an untyped item', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: String(id) })));
    expect(result.message).toBe('Warranty updated.');
  });

  it('says "Subscription updated." for an item whose saved type is a subscription', async () => {
    const subscriptionType = listItemTypes().find((t) => t.name === 'Subscription')!;
    const to = await redirectPath(
      () => createWarrantyAction({}, formData(baseFields({ typeId: String(subscriptionType.id) }))),
    );
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), typeId: String(subscriptionType.id) })),
    );
    expect(result.message).toBe('Subscription updated.');
  });

  it('errors on an unknown item id', async () => {
    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: '99999' })));
    expect(result.error).toBeTruthy();
  });

  /**
   * v1.10.2 reversed this test's expectation, deliberately. It used to assert that an update
   * could move an item to a different type. The type decides which fields the form offers --
   * model and serial for a purchase, principal and balance for a loan -- so changing it
   * afterwards strands whatever the old kind stored and asks the record to be read as
   * something it was never filled in as. Same rule as transactions.amount_cents: a value that
   * governs how other values are interpreted is immutable after insert.
   *
   * The check is server-side because the form's read-only control is only advice to a browser.
   * A wrong type stays fixable: delete the item and add it again.
   */
  it('refuses a typeId change on update and leaves the item on its original type', async () => {
    const laptop = listItemTypes().find((t) => t.name === 'Laptop')!;
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;
    expect(before.typeId).not.toBe(laptop.id);

    const result = await updateWarrantyAction({}, formData(baseFields({ itemId: String(id), typeId: String(laptop.id) })));
    expect(result.error).toBe(ITEM_TYPE_IMMUTABLE_ERROR);

    const after = getWarrantyItem(id, ADMIN)!;
    expect(after.typeId).toBe(before.typeId);
  });

  it('still accepts an update that leaves the typeId alone', async () => {
    // The guard must reject a CHANGE, not every update that happens to post a typeId -- the
    // edit form posts the unchanged value on every save.
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({
        itemId: String(id),
        name: 'Renamed, same type',
        typeId: before.typeId === null ? '' : String(before.typeId),
      })),
    );
    expect(result.error).toBeUndefined();
    expect(getWarrantyItem(id, ADMIN)!.name).toBe('Renamed, same type');
  });

  it('refuses an unknown typeId on update and leaves the item unchanged', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    const result = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Should not stick', typeId: '999999' })),
    );
    expect(result.error).toBe('That item type no longer exists.');
    const item = getWarrantyItem(id, ADMIN)!;
    expect(item.name).toBe('Fridge');
    expect(item.typeId).toBeNull();
  });
});

describe('deleteWarrantyAction', () => {
  it('removes the item, its receipt rows, its FTS entries and its files, then redirects', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'DOOMED WORD' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'till.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const stored = listWarrantyReceipts(id)[0].storedFilename;

    expect(await redirectPath(() => deleteWarrantyAction({}, formData({ itemId: String(id) })))).toBe('/warranties');
    expect(getWarrantyItem(id, ADMIN)).toBeNull();
    expect(receiptFileExists(stored)).toBe(false);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_receipts`).c).toBe(0);
    expect(current!.db.get<{ c: number }>(sql`select count(*) as c from warranty_search`).c).toBe(0);
  });
});

// M8: pins §1.3 — warranty items are household-shared, not ownership-gated. Guards against a
// future access-control check creeping in on update/delete.
// M8, revised for v1.13.0 ruling R3: this used to pin "ownership is attribution only, not access
// control" for BOTH update and delete. R3 splits the two -- EDITING a household-shared item stays
// open to every member regardless of ownership (a household shares its subscriptions and its
// contracts); DELETING one does not (see the R3 describe block below, which pins the delete side).
describe('household sharing (§1.3): editing stays open to every member, delete does not (ruling R3)', () => {
  it('lets a member who does not own the item update it, but refuses them the delete', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());
    expect(getWarrantyItem(id, ADMIN)!.ownerUserId).toBe(ownerId);

    const otherId = insertTestUser(current!.db, { name: 'Bob', username: 'bob', role: 'member' });
    currentUser = { id: otherId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };

    const updateResult = await updateWarrantyAction(
      {},
      formData(baseFields({ itemId: String(id), name: 'Renamed by Bob' })),
    );
    expect(updateResult.message).toBeTruthy();
    expect(getWarrantyItem(id, ADMIN)!.name).toBe('Renamed by Bob');

    const deleteResult = await deleteWarrantyAction({}, formData({ itemId: String(id) }));
    expect(deleteResult.error).toBe(NOT_YOURS_ERROR);
    expect(getWarrantyItem(id, ADMIN)).not.toBeNull();
  });
});

describe('attachReceiptsAction / deleteReceiptAction / reRunOcrAction', () => {
  it('attaches to an existing item and warns about a duplicate without blocking it', async () => {
    const to = await redirectPath(() => createWarrantyAction({}, formData(baseFields())));
    const id = Number(to.split('/').pop());

    const first = writeStagedReceipt(JPEG, 'image/jpeg');
    await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: first, originalFilename: 'a.jpg' }]) }),
    );
    const second = writeStagedReceipt(JPEG, 'image/jpeg');
    const result = await attachReceiptsAction(
      {},
      formData({ itemId: String(id), staged: JSON.stringify([{ stagingId: second, originalFilename: 'a.jpg' }]) }),
    );
    expect(listWarrantyReceipts(id)).toHaveLength(2);
    expect(result.message).toContain('already');
  });

  it('deletes one receipt', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const id = Number(to.split('/').pop());
    const receipt = listWarrantyReceipts(id)[0];
    const result = await deleteReceiptAction({}, formData({ receiptId: String(receipt.id) }));
    expect(result.message).toBeTruthy();
    expect(listWarrantyReceipts(id)).toHaveLength(0);
    expect(receiptFileExists(receipt.storedFilename)).toBe(false);
  });

  it('re-runs OCR and is safe to click twice', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const receipt = listWarrantyReceipts(Number(to.split('/').pop()))[0];
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }))).message).toBeTruthy();
  });

  it('errors on unknown ids instead of throwing', async () => {
    expect((await deleteReceiptAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await reRunOcrAction({}, formData({ receiptId: '99999' }))).error).toBeTruthy();
    expect((await deleteReceiptAction({}, formData({ receiptId: 'abc' }))).error).toBeTruthy();
  });

  // S-02: reRunOcrAction discarded requireUser()'s return and never checked the receipt's
  // parent item at all -- a self-scoped member could re-run OCR on any household member's
  // receipt. The receipt-missing wording is reused for the refusal (not NOT_YOURS_ERROR),
  // closing the same existence-oracle leak api/warranties/receipts/[id]/route.ts already
  // closes by answering 404 rather than 403.
  it('refuses for a self-scoped viewer who cannot see the receipt\'s item, and the OCR state is untouched', async () => {
    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'failed', error: 'OCR timed out.' });
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(baseFields({ staged: JSON.stringify([{ stagingId, originalFilename: 'a.jpg' }]) })),
      ),
    );
    const receipt = listWarrantyReceipts(Number(to.split('/').pop()))[0];

    const strangerId = insertTestUser(current!.db, { name: 'Stranger', role: 'member' });
    currentUser = { id: strangerId, name: 'Stranger', username: 'stranger', role: 'member', visibility: 'self' };
    const result = await reRunOcrAction({}, formData({ receiptId: String(receipt.id) }));
    expect(result.error).toBe('That receipt no longer exists.');
    expect(getWarrantyReceipt(receipt.id)?.ocrStatus).toBe('failed');
  });
});

describe('MUST-14.4 / MUST-14.7 / MUST-14.14: the loan readers and the rule actions', () => {
  it('the three readers parse and round-trip, and the rate becomes basis points', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction(
        {},
        formData(loanForm({ principal: '28,000.00', interestRate: '5.49', currentBalance: '$19,550.00' })),
      ),
    );
    const item = getWarrantyItem(Number(to.split('/').pop()), ADMIN)!;
    expect(item.principalCents).toBe(2_800_000);
    expect(item.interestRateBps).toBe(549);
    expect(item.currentBalanceCents).toBe(1_955_000);
    // MUST-14.2 / MUST-11.8: the anchor is written here, and only here.
    expect(item.balanceUpdatedAt).not.toBeNull();
  });

  it('an empty balance sets BOTH the balance and the anchor to null', async () => {
    await redirectPath(() => createWarrantyAction({}, formData(loanForm({ currentBalance: '' }))));
    const item = latestItem();
    expect(item.currentBalanceCents).toBeNull();
    expect(item.balanceUpdatedAt).toBeNull();
  });

  it('both rule actions reject a cross-origin request first', async () => {
    originHeaders = { origin: 'http://evil.example', host: 'nas.local:3000' };
    expect((await saveLoanRuleAction({}, formData({ itemId: '1', merchantContains: 'HONDA' }))).error).toBe(CROSS_ORIGIN_ERROR);
    expect((await deleteLoanRuleAction(formData({ id: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses fewer than three characters, the sixth rule, and a duplicate — each with its fixed wording', async () => {
    const itemId = seedLoanItem();
    expect((await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'HO' }))).error).toBe(
      'Use at least three characters, or this will match almost everything.',
    );
    for (let i = 0; i < MAX_RULES_PER_LOAN; i += 1) {
      await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: `RULE${i}` }));
    }
    expect((await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'ONEMORE' }))).error).toBe(
      'Five rules per loan is the limit.',
    );
    const second = seedLoanItem();
    await saveLoanRuleAction({}, formData({ itemId: String(second), merchantContains: 'HONDA FIN' }));
    expect((await saveLoanRuleAction({}, formData({ itemId: String(second), merchantContains: 'HONDA FIN' }))).error).toBe(
      'That rule already exists on this loan.',
    );
  });

  it('MUST-14.14: revalidateAll covers /transactions and /reports', async () => {
    const itemId = seedLoanItem();
    vi.mocked(revalidatePath).mockClear();
    await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'HONDA FIN' }));
    const calls = vi.mocked(revalidatePath).mock.calls.map((call) => call[0]);
    expect(calls).toContain('/transactions');
    expect(calls).toContain('/reports');
  });

  // Task 9 review finding (MED), carried into this task: the edit form used to omit the four
  // loan money fields entirely, and readItemInput() normalises an absent field to null -- so
  // editing only the item's NAME used to silently wipe principal/rate/balance/anchor on every
  // loan.
  //
  // F7 fix-round: what THIS test actually proves is narrower than the fix as a whole. The
  // FormData below is hand-built with principal/interestRate/currentBalance already populated
  // -- exactly what a FIXED edit form would submit -- so this is an ACTION-layer round-trip
  // proof: given a resubmission that carries the values forward, updateWarrantyAction does not
  // wipe them and (F6 fix-round) does not move the anchor when the balance is unchanged. It
  // would pass just as well against the PRE-fix client, because the bug lived entirely in
  // EditForm never rendering/submitting these fields in the first place -- that half of the
  // fix (the fieldset is actually seeded from the item, so a real edit form really does
  // resubmit them) is proven separately, by warranty-detail-client.test.tsx's "seeds the edit
  // form's loan fields from the item's existing values" test, which reads the rendered
  // <input>s' own values rather than constructing FormData by hand.
  //
  // balanceUpdatedAt is asserted BYTE-IDENTICAL, not merely non-null (F6 fix-round):
  // readItemInput() only re-stamps the anchor when the parsed balance actually DIFFERS from
  // what's already stored, so an unrelated edit that resubmits the same figure must not move
  // it at all.
  it('regression (Task 9 review, MED / F6 fix-round): the ACTION round-trips principal/rate/balance/anchor when an edit resubmits them unchanged', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(loanForm({ principal: '30,000.00', interestRate: '5.49', currentBalance: '25,000.00' }))),
    );
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;
    expect(before.currentBalanceCents).not.toBeNull();

    const result = await updateWarrantyAction(
      {},
      formData(
        baseFields({
          itemId: String(id),
          typeId: String(before.typeId),
          name: 'Renamed Loan',
          principal: '30,000.00',
          interestRate: '5.49',
          currentBalance: '25,000.00',
          // Fix wave item 4: a real (post-fix) edit form also posts the seed it was rendered
          // with, here the same figure the field itself carries -- an untouched field.
          currentBalanceSeed: '25,000.00',
        }),
      ),
    );
    expect(result.message).toBeTruthy();

    const after = getWarrantyItem(id, ADMIN)!;
    expect(after.name).toBe('Renamed Loan');
    expect(after.principalCents).toBe(before.principalCents);
    expect(after.interestRateBps).toBe(before.interestRateBps);
    expect(after.currentBalanceCents).toBe(before.currentBalanceCents);
    expect(after.balanceUpdatedAt).toBe(before.balanceUpdatedAt);
  });

  it('F6 fix-round: a CHANGED balance still gets a fresh anchor', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(loanForm({ principal: '30,000.00', interestRate: '5.49', currentBalance: '25,000.00' }))),
    );
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;

    await updateWarrantyAction(
      {},
      formData(
        baseFields({
          itemId: String(id),
          typeId: String(before.typeId),
          principal: '30,000.00',
          interestRate: '5.49',
          currentBalance: '24,000.00',
          currentBalanceSeed: '25,000.00',
        }),
      ),
    );
    const after = getWarrantyItem(id, ADMIN)!;
    expect(after.currentBalanceCents).toBe(2_400_000);
    expect(after.balanceUpdatedAt).not.toBeNull();
    expect(after.balanceUpdatedAt).not.toBe(before.balanceUpdatedAt);
  });
});

/**
 * Fix wave item 4 (final pre-tag fix wave, LOW): readItemInput() used to decide "was the
 * balance touched by this submit" by comparing the posted figure against whatever is stored
 * in the database AT SAVE TIME (getWarrantyItem, fetched fresh in updateWarrantyAction). A
 * matcher rule can move that stored value while an edit form sits open in a browser tab; the
 * form's own visible field is a controlled React input seeded once at mount and never
 * refetches, so it keeps posting the STALE pre-move figure. The old comparison read that as
 * "the balance changed" (stale != freshly-moved) and used the posted, stale value --
 * silently reverting the automatic move on a completely unrelated (e.g. name-only) save.
 *
 * The fix compares the posted balance against `currentBalanceSeed` instead: the value the
 * form was rendered with, posted back unconditionally alongside the visible field
 * (warranty-detail-client.tsx). Only a figure that differs from ITS OWN seed can be a real
 * edit; an untouched field can therefore never overwrite a balance that moved underneath it.
 */
describe('Fix wave item 4: the seed decides "untouched", not the live stored value', () => {
  it('a matcher moving the balance while the form is open survives a name-only save; the anchor does not move', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(loanForm({ principal: '30,000.00', interestRate: '5.49', currentBalance: '25,000.00' }))),
    );
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;
    expect(before.currentBalanceCents).toBe(2_500_000);

    // The matcher rule moves the balance directly, exactly as a real matched payment does
    // (MUST-11.8: never touches balance_updated_at), WHILE the edit form -- rendered with the
    // OLD $25,000.00 figure -- is still open in a browser tab.
    current!.sqlite.prepare(`update warranty_items set current_balance_cents = ? where id = ?`).run(2_000_000, id);

    // The tab submits a name-only change: the visible field still shows the STALE $25,000.00
    // it was rendered with (a controlled input, never refetched), and the seed field posts
    // that exact same stale figure, because it too was seeded from what the page loaded.
    const result = await updateWarrantyAction(
      {},
      formData(
        baseFields({
          itemId: String(id),
          typeId: String(before.typeId),
          name: 'Renamed Loan',
          principal: '30,000.00',
          interestRate: '5.49',
          currentBalance: '25,000.00',
          currentBalanceSeed: '25,000.00',
        }),
      ),
    );
    expect(result.message).toBeTruthy();

    const after = getWarrantyItem(id, ADMIN)!;
    expect(after.name).toBe('Renamed Loan');
    // The automatic move survives: the stale $25,000.00 the tab had did NOT clobber it.
    expect(after.currentBalanceCents).toBe(2_000_000);
    // And the human anchor was not stamped -- nothing the person did counts as an edit.
    expect(after.balanceUpdatedAt).toBe(before.balanceUpdatedAt);
  });

  it('a real edit still writes, even though the stored value also moved underneath it', async () => {
    const to = await redirectPath(() =>
      createWarrantyAction({}, formData(loanForm({ principal: '30,000.00', interestRate: '5.49', currentBalance: '25,000.00' }))),
    );
    const id = Number(to.split('/').pop());
    const before = getWarrantyItem(id, ADMIN)!;

    current!.sqlite.prepare(`update warranty_items set current_balance_cents = ? where id = ?`).run(2_000_000, id);

    const result = await updateWarrantyAction(
      {},
      formData(
        baseFields({
          itemId: String(id),
          typeId: String(before.typeId),
          principal: '30,000.00',
          interestRate: '5.49',
          currentBalance: '24,000.00',
          currentBalanceSeed: '25,000.00',
        }),
      ),
    );
    expect(result.message).toBeTruthy();

    const after = getWarrantyItem(id, ADMIN)!;
    // The person's own new figure wins -- not the stale seed, and not whatever the matcher
    // left behind either.
    expect(after.currentBalanceCents).toBe(2_400_000);
    expect(after.balanceUpdatedAt).not.toBeNull();
    expect(after.balanceUpdatedAt).not.toBe(before.balanceUpdatedAt);
  });
});

describe('F9 fix-round: the backfill checkbox only treats "on" as checked', () => {
  it('an omitted backfill field skips backfillLoanRule entirely (no "past payments linked" copy)', async () => {
    const itemId = seedLoanItem();
    const result = await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'HONDA FIN' }));
    expect(result.message).toBe('Rule saved. It will apply to payments that arrive from now on.');
  });

  it('backfill="on" still runs the historical pass', async () => {
    const itemId = seedLoanItem();
    const result = await saveLoanRuleAction(
      {},
      formData({ itemId: String(itemId), merchantContains: 'HONDA FIN', backfill: 'on' }),
    );
    expect(result.message).toMatch(/past payments linked/);
  });
});

describe('F10 fix-round: deleteLoanRuleAction verifies the rule belongs to itemId', () => {
  it('refuses to delete a rule that exists but belongs to a DIFFERENT item', async () => {
    const itemA = seedLoanItem();
    const itemB = seedLoanItem();
    await saveLoanRuleAction({}, formData({ itemId: String(itemA), merchantContains: 'HONDA FIN' }));
    const ruleId = listLoanRules(itemA)[0]!.id;

    const result = await deleteLoanRuleAction(formData({ id: String(ruleId), itemId: String(itemB) }));
    expect(result.error).toBe('That rule no longer exists.');
    // Untouched -- still there under its real item.
    expect(listLoanRules(itemA)).toHaveLength(1);
  });

  it('deletes the rule when the pair actually matches', async () => {
    const itemId = seedLoanItem();
    await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'HONDA FIN' }));
    const ruleId = listLoanRules(itemId)[0]!.id;

    const result = await deleteLoanRuleAction(formData({ id: String(ruleId), itemId: String(itemId) }));
    expect(result.message).toBeTruthy();
    expect(listLoanRules(itemId)).toHaveLength(0);
  });

  // S-02: deleteLoanRuleAction discarded requireUser()'s return and never checked the item at
  // all -- a self-scoped member could delete any household member's loan matching rule.
  it('refuses for a self-scoped viewer who cannot see the item, and the rule is untouched', async () => {
    const itemId = seedLoanItem();
    await saveLoanRuleAction({}, formData({ itemId: String(itemId), merchantContains: 'HONDA FIN' }));
    const ruleId = listLoanRules(itemId)[0]!.id;

    const strangerId = insertTestUser(current!.db, { name: 'Stranger', role: 'member' });
    currentUser = { id: strangerId, name: 'Stranger', username: 'stranger', role: 'member', visibility: 'self' };
    const result = await deleteLoanRuleAction(formData({ id: String(ruleId), itemId: String(itemId) }));
    expect(result.error).toBe('That item no longer exists.');
    expect(listLoanRules(itemId)).toHaveLength(1);
  });
});

/** A plain (non-loan) warranty item owned by `ownerUserId`, seeded directly through the data layer. */
function seedItem(ownerUserId: number, name = 'Item'): number {
  return createWarrantyItem({
    name,
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId,
    transactionId: null,
    typeId: null,
    notes: null,
  });
}

describe('ruling R3: destructive actions are owner-or-admin, and are recorded', () => {
  let adminId: number;
  let memberId: number;
  let adminOwnedItemId: number;
  let memberOwnedItemId: number;
  let receiptOnAdminItem: number;

  beforeEach(() => {
    adminId = insertTestUser(current!.db, { name: 'Admin', role: 'admin' });
    memberId = insertTestUser(current!.db, { name: 'Bob', role: 'member' });
    adminOwnedItemId = seedItem(adminId, 'Admin Item');
    memberOwnedItemId = seedItem(memberId, 'Member Item');

    const stagingId = writeStagedReceipt(JPEG, 'image/jpeg');
    writeSidecar(stagingId, { status: 'done', text: 'admin receipt text' });
    [receiptOnAdminItem] = attachStagedReceipts(adminOwnedItemId, [{ stagingId, originalFilename: 'a.jpg' }]);
  });

  it('a member deleting another person item is refused and the row survives', async () => {
    currentUser = { id: memberId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };
    const form = new FormData();
    form.set('itemId', String(adminOwnedItemId));
    expect((await deleteWarrantyAction({}, form)).error).toBe(NOT_YOURS_ERROR);
    expect(getWarrantyItem(adminOwnedItemId, ADMIN)).not.toBeNull();
    expect(listAudit()).toEqual([]);
  });

  it('an owner deleting their own item succeeds and appends exactly one audit row', async () => {
    currentUser = { id: memberId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };
    const form = new FormData();
    form.set('itemId', String(memberOwnedItemId));
    // redirect() throws by design -- a successful delete signals via a thrown RedirectSignal.
    await expect(deleteWarrantyAction({}, form)).rejects.toThrow();
    expect(getWarrantyItem(memberOwnedItemId, ADMIN)).toBeNull();
    const audit = listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      userId: memberId,
      action: 'delete_item',
      entity: 'warranty_items',
      entityId: memberOwnedItemId,
    });
  });

  it('an admin may delete anyone item, and the audit row names the admin', async () => {
    currentUser = { id: adminId, name: 'Admin', username: 'admin', role: 'admin', visibility: 'household' };
    const form = new FormData();
    form.set('itemId', String(memberOwnedItemId));
    await expect(deleteWarrantyAction({}, form)).rejects.toThrow();
    expect(listAudit()[0]?.userId).toBe(adminId);
  });

  it('a member deleting a receipt on another person item is refused', async () => {
    currentUser = { id: memberId, name: 'Bob', username: 'bob', role: 'member', visibility: 'household' };
    const form = new FormData();
    form.set('receiptId', String(receiptOnAdminItem));
    expect((await deleteReceiptAction({}, form)).error).toBe(NOT_YOURS_ERROR);
    expect(getWarrantyReceipt(receiptOnAdminItem)).not.toBeNull();
  });
});

/** A real transaction row, inserted the same way every other test in this file does. */
function seedTransaction(accountId: number, over: Partial<{ date: string; merchant: string; amountCents: number }> = {}): number {
  const merchant = over.merchant ?? 'HONDA FIN';
  return current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, ${over.date ?? '2026-06-14'}, ${merchant}, ${merchant}, ${over.amountCents ?? -450_00}, ${ownerId}, ${nowIso()}, ${nowIso()})
    returning id`).id;
}

describe('unlinkLedgerTransactionAction (item 6, v1.16.0 plan)', () => {
  it('unlinks a loan payment (unassignTransactionFromLoan) and the ledger row disappears', async () => {
    const itemId = seedLoanItem({ balanceCents: 200_000 });
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txnId = seedTransaction(accountId);
    expect(assignTransactionToLoan({ txnId, itemId }).linked).toBe(true);
    expect(itemLedger(itemId).rows).toHaveLength(1);

    const result = await unlinkLedgerTransactionAction({}, formData({ itemId: String(itemId), txnId: String(txnId) }));
    expect(result.message).toBeTruthy();
    expect(itemLedger(itemId).rows).toHaveLength(0);
  });

  it('unlinks a paid bill installment (the un-mark path) and the ledger row disappears', async () => {
    const billType = createItemType(`Bill ${randomUUID()}`, 'bill');
    const billItemId = createWarrantyItem({
      name: 'Property Tax',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2024-01-15',
      warrantyMonths: null,
      isLifetime: true,
      priceCents: null,
      ownerUserId: ownerId,
      transactionId: null,
      typeId: billType.id,
      notes: null,
    });
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txnId = seedTransaction(accountId, { merchant: 'CITY TAX OFFICE', amountCents: -120_000 });
    const installmentId = current!.db.get<{ id: number }>(
      sql`insert into bill_installments (item_id, due_date, amount_cents, paid_at, paid_txn_id, created_at)
          values (${billItemId}, '2026-06-15', 120000, ${nowIso()}, ${txnId}, ${nowIso()}) returning id`,
    ).id;
    expect(itemLedger(billItemId).rows).toMatchObject([{ txnId, source: 'installment' }]);

    const result = await unlinkLedgerTransactionAction({}, formData({ itemId: String(billItemId), txnId: String(txnId) }));
    expect(result.message).toBeTruthy();
    expect(itemLedger(billItemId).rows).toHaveLength(0);
    const row = current!.db.get<{ paidAt: string | null; paidTxnId: number | null }>(
      sql`select paid_at as paidAt, paid_txn_id as paidTxnId from bill_installments where id = ${installmentId}`,
    );
    expect(row.paidAt).toBeNull();
    expect(row.paidTxnId).toBeNull();
  });

  it('refuses when the transaction is not actually linked to this item', async () => {
    const itemId = seedLoanItem();
    const result = await unlinkLedgerTransactionAction({}, formData({ itemId: String(itemId), txnId: '999999' }));
    expect(result.error).toBe('That transaction is no longer linked to this item.');
  });

  // Authorization: the SAME viewer guard every other action in this file uses (getWarrantyItem),
  // not a new one -- a self-scoped viewer who cannot see the item at all must be refused exactly
  // like every other action's "unknown item" case, never widened into a different message that
  // would leak whether the item exists.
  it('refuses for a self-scoped viewer who cannot see the item', async () => {
    const itemId = seedLoanItem();
    const strangerId = insertTestUser(current!.db, { name: 'Stranger', role: 'member' });
    currentUser = { id: strangerId, name: 'Stranger', username: 'stranger', role: 'member', visibility: 'self' };
    const result = await unlinkLedgerTransactionAction({}, formData({ itemId: String(itemId), txnId: '1' }));
    expect(result.error).toBe('That item no longer exists.');
  });
});

describe('recomputeLoanBalanceAction (item 6, v1.21.0 backlog)', () => {
  it('recomputes and reports the corrected figure', async () => {
    const itemId = seedLoanItem({ balanceCents: 1_955_000 });
    const accountId = insertTestAccount(current!.db, { name: 'Chequing' });
    const txnId = seedTransaction(accountId, { amountCents: -45_000 });
    expect(assignTransactionToLoan({ txnId, itemId }).linked).toBe(true);
    expect(getWarrantyItem(itemId, currentUser)?.currentBalanceCents).toBe(1_910_000);

    const result = await recomputeLoanBalanceAction({}, formData({ itemId: String(itemId) }));
    expect(result.message).toBe('Balance recomputed from the linked payments: $19,100.00.');
    expect(getWarrantyItem(itemId, currentUser)?.currentBalanceCents).toBe(1_910_000);
  });

  it('refuses a bill-kind item -- there is no balance for it to recompute', async () => {
    const billType = createItemType(`Bill ${randomUUID()}`, 'bill');
    const billItemId = createWarrantyItem({
      name: 'Property Tax',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2024-01-15',
      warrantyMonths: null,
      isLifetime: true,
      priceCents: null,
      ownerUserId: ownerId,
      transactionId: null,
      typeId: billType.id,
      notes: null,
    });
    const result = await recomputeLoanBalanceAction({}, formData({ itemId: String(billItemId) }));
    expect(result.error).toBe(MATCHING_KIND_ERROR);
  });

  it('refuses a loan with no balance being tracked', async () => {
    const itemId = seedLoanItem();
    current!.db.run(sql`update warranty_items set current_balance_cents = null, balance_updated_at = null where id = ${itemId}`);
    const result = await recomputeLoanBalanceAction({}, formData({ itemId: String(itemId) }));
    expect(result.error).toBe('This loan has no balance being tracked yet.');
  });

  it('refuses for a self-scoped viewer who cannot see the item', async () => {
    const itemId = seedLoanItem();
    const strangerId = insertTestUser(current!.db, { name: 'Stranger', role: 'member' });
    currentUser = { id: strangerId, name: 'Stranger', username: 'stranger', role: 'member', visibility: 'self' };
    const result = await recomputeLoanBalanceAction({}, formData({ itemId: String(itemId) }));
    expect(result.error).toBe('That item no longer exists.');
  });
});
