import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { createWarrantyItem, getWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
import { setTransactionSplits } from '@/lib/splits';
import { confirmCategory } from '@/lib/categorize/engine';
import { listRules, ruleOwnedError, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { NOT_YOURS_ERROR } from '@/lib/auth/viewer';

let currentUser: {
  id: number;
  name: string;
  username: string;
  role: 'admin' | 'member';
  /** Fix round 2 (ruling R2): defaults to undefined, which ownerScope() treats exactly like
   *  'household' (its check is `viewer.visibility === 'self'`) -- every pre-existing test in
   *  this file relies on that default. Only the R2 self-viewer tests set it explicitly. */
  visibility?: 'household' | 'self';
} = {
  id: 1,
  name: 'Alice',
  username: 'alice',
  role: 'admin',
};
// v1.3.1: toggleable so the loan actions' cross-origin-first test can flip it, same idiom as
// tests/app/update-actions.test.ts.
const sameOrigin = vi.hoisted(() => ({ value: true }));

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () =>
    sameOrigin.value
      ? new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' })
      : new Headers({ origin: 'http://evil.example', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { CROSS_ORIGIN_ERROR } from '@/lib/auth/csrf';
import {
  acceptGuessAction,
  applyToAllMatchingAction,
  assignToLoanAction,
  bulkCategorizeAction,
  bulkTransferAction,
  createLoanFromTransactionAction,
  manualEntryAction,
  renameTransactionAction,
  saveNoteAction,
  setAttributionAction,
  setCategoryAction,
  setRowTransferAction,
  unassignFromLoanAction,
} from '@/app/(app)/transactions/actions';

let current: TestDb | null = null;
// v1.3.1: set by setup(), read by the loan fixture helpers below so they don't need every
// call site to thread userId/accountId through by hand.
let ctx: { userId: number; accountId: number } | null = null;

afterEach(() => {
  sameOrigin.value = true;
  current?.cleanup();
  current = null;
  ctx = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  currentUser = { id: userId, name: 'Alice', username: 'alice', role: 'admin' };
  const accountId = insertTestAccount(current.db, { name: 'Joint Chequing' });
  ctx = { userId, accountId };
  const addTxn = (description = 'TIM HORTONS', amountCents = -500) => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, addTxn };
}

/**
 * insertTestAccount's own type union (tests/helpers/db.ts) is 'chequing' | 'credit' | 'cash' --
 * it predates ruling R10's five-value AccountType, and widening it is out of this task's file
 * scope (a shared helper, not one of this task's named files). The `type` column itself has
 * never carried a SQL CHECK (src/db/schema.ts), so a direct insert works exactly like
 * addTxn's own raw-SQL pattern above.
 */
function insertAssetAccount(name = 'Family Home'): number {
  const row = current!.db.get<{ id: number }>(sql`
    insert into accounts (name, institution, type, owner_user_id, is_active, created_at)
    values (${name}, '', 'asset', null, 1, ${nowIso()})
    returning id`);
  return row.id;
}

/** A loan-kind item, seeded directly through the data layer. */
function seedLoanItem(opts: { balanceCents?: number; loan_direction?: 'owed' | 'lent' } = {}): number {
  const { userId } = ctx!;
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
    ownerUserId: userId,
    transactionId: null,
    typeId: loanType.id,
    notes: null,
    principalCents: 3_000_000,
    interestRateBps: 549,
    currentBalanceCents: opts.balanceCents ?? 2_000_000,
    balanceUpdatedAt: nowIso(),
    loanDirection: opts.loan_direction ?? 'owed',
  });
}

/** A loan with the given balance, plus one negative (spend) transaction on the same account. */
function seedLoanAndSpend(balanceCents: number, amountCents: number): { itemId: number; txnId: number } {
  const { accountId, userId } = ctx!;
  const itemId = seedLoanItem({ balanceCents });
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return { itemId, txnId: row.id };
}

function balanceOf(itemId: number): number | null {
  // SessionUser gained `visibility` (v1.13.0 ruling R2); currentUser here is a bare mock shape
  // for the requireUser() mock, so a household-scoped Viewer literal is built inline instead.
  return getWarrantyItem(itemId, { id: currentUser.id, role: currentUser.role, visibility: 'household' })!.currentBalanceCents;
}

describe('setAttributionAction — missing input validation (finding 2)', () => {
  it('rejects a non-numeric attributedUserId instead of writing NaN', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: 'not-a-number' }));
    expect(result.error).toBeTruthy();
    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null };
    expect(row.a).not.toBeNaN();
    // Untouched by the rejected write — still whatever it started as (null here).
    expect(row.a).toBeNull();
  });

  it('still accepts a real user id and an empty selection meaning household/unattributed', async () => {
    const { userId, sqlite, addTxn } = setup();
    const id = addTxn();
    const attributed = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: String(userId) }));
    expect(attributed.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBe(userId);

    const cleared = await setAttributionAction({}, formData({ ids: String(id), attributedUserId: '' }));
    expect(cleared.message).toBeTruthy();
    expect((sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(id) as { a: number | null }).a).toBeNull();
  });
});

describe('saveNoteAction — missing input validation (finding 2)', () => {
  it('returns an error for a non-numeric transactionId instead of a silent no-op success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: 'nope', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('returns an error when the transaction does not exist instead of claiming success', async () => {
    setup();
    const result = await saveNoteAction({}, formData({ transactionId: '999999', notes: 'hi' }));
    expect(result.error).toBeTruthy();
  });

  it('saves the note for a real transaction', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    const result = await saveNoteAction({}, formData({ transactionId: String(id), notes: 'split with Bob' }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select notes from transactions where id = ?').get(id) as { notes: string | null };
    expect(row.notes).toBe('split with Bob');
  });
});

describe('MUST-14.8 … MUST-14.11: assign and unassign', () => {
  it('links and decrements; a second assign to the same loan is a reported no-op', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    // F2 fix-round: "Assigned." alone became the honest amount-and-direction message below.
    expect((await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe(
      'Assigned. $450.00 came off the balance.',
    );
    expect(balanceOf(itemId)).toBe(1_955_000);
    expect((await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }))).message).toBe(
      'That transaction is already linked to this loan.',
    );
    expect(balanceOf(itemId)).toBe(1_955_000);
  });

  it('MUST-14.10: a second LOAN on the same transaction succeeds and warns', async () => {
    setup();
    const { itemId: car, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    const boat = seedLoanItem({ balanceCents: 500_000 });
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(car) }));
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(boat) }));
    expect(result.message).toBe('Assigned. Note that this transaction is now linked to more than its own amount.');
    expect(result.error).toBeUndefined();
  });

  it('unassign restores exactly, and a nonexistent id is an error, not a 500', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    await unassignFromLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(balanceOf(itemId)).toBe(2_000_000);
    expect((await assignToLoanAction(formData({ transactionId: '999999', itemId: String(itemId) }))).error).toBe(
      'That transaction no longer exists.',
    );
  });

  it('both reject a cross-origin request first', async () => {
    setup();
    sameOrigin.value = false;
    expect((await assignToLoanAction(formData({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
    expect((await unassignFromLoanAction(formData({ transactionId: '1', itemId: '1' }))).error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('NEW-3 / F1 fix-round: a payment unassign says the balance went back UP, with the amount', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    const result = await unassignFromLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(result.message).toBe('Unassigned. The balance has gone back up by $450.00.');
  });

  it('NEW-3 / F1 fix-round: a disbursement unassign says the balance went back DOWN, not up, with the amount', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, 60_000);
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(balanceOf(itemId)).toBe(2_060_000);
    const result = await unassignFromLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(result.message).toBe('Unassigned. The balance has gone back down by $600.00.');
    expect(balanceOf(itemId)).toBe(2_000_000);
  });

  it('NEW-1 fix-round: a residual failure comes back as a normal action error, never a thrown stack trace', async () => {
    const { sqlite } = setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    sqlite.prepare('drop table loan_payments').run();
    // If unassignFromLoanAction did not catch this, the underlying SqliteError would reject
    // this promise and the `await` below would throw, failing the test on its own.
    const result = await unassignFromLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(result.error).toBeTruthy();
  });

  it('NEW-1 fix-round: reversing a disbursement that pushed the balance past what a later payment left room for clamps at zero instead of crashing', async () => {
    setup();
    // The exact probe: a 10,000 balance, a +60,000 disbursement (-> 70,000), then a -70,000
    // payment that clamps the balance to zero. Unassigning the disbursement afterwards would
    // naively ask for 0 - 60,000 = -60,000, which used to hit the CHECK and throw.
    const car = seedLoanItem({ balanceCents: 10_000 });
    const disbTxn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-03', 'HONDA FIN DISBURSEMENT', ${normalizeMerchant('HONDA FIN DISBURSEMENT')}, 60000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    await assignToLoanAction(formData({ transactionId: String(disbTxn.id), itemId: String(car) }));
    expect(balanceOf(car)).toBe(70_000);

    const paymentTxn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-04', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -70000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    await assignToLoanAction(formData({ transactionId: String(paymentTxn.id), itemId: String(car) }));
    expect(balanceOf(car)).toBe(0);

    const result = await unassignFromLoanAction(formData({ transactionId: String(disbTxn.id), itemId: String(car) }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();
    expect(balanceOf(car)).toBe(0);
  });

  it('F2 fix-round: a disbursement says the balance went up, with amount and direction', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, 60_000);
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. The balance went up $600.00 (money in).');
  });

  /**
   * Review round (Lane A): the copy above reads `txn.amountCents < 0` as "a payment" -- true
   * for an `owed` loan, backwards for a `lent` one. An outgoing e-transfer to a friend RAISES
   * what they owe the household; the old copy would have called that "$500.00 came off the
   * balance" while it went up. These two pin the honest, direction-aware wording instead.
   */
  it('review round (Lane A): a lent-loan advance says it was ADDED to what they owe, not that it came off', async () => {
    setup();
    const itemId = seedLoanItem({ balanceCents: 0, loan_direction: 'lent' });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'E TRANSFER', ${normalizeMerchant('E TRANSFER')}, -50000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. $500.00 added to what they owe.');
    expect(balanceOf(itemId)).toBe(50_000);
  });

  it('review round (Lane A): a lent-loan repayment says it came off what they owe', async () => {
    setup();
    const itemId = seedLoanItem({ balanceCents: 50_000, loan_direction: 'lent' });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'E TRANSFER', ${normalizeMerchant('E TRANSFER')}, 20000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. $200.00 came off what they owe.');
    expect(balanceOf(itemId)).toBe(30_000);
  });

  it('F2 fix-round: assigning against an UNKNOWN balance says so honestly, and applies nothing', async () => {
    setup();
    const loanType = createItemType(`Loan ${randomUUID()}`, 'loan');
    const itemId = createWarrantyItem({
      name: 'Unknown Balance Loan',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2026-01-01',
      warrantyMonths: null,
      isLifetime: false,
      priceCents: null,
      ownerUserId: ctx!.userId,
      transactionId: null,
      typeId: loanType.id,
      notes: null,
      principalCents: null,
      interestRateBps: null,
      currentBalanceCents: null,
      balanceUpdatedAt: null,
    });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -45000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. The balance was unknown, so it did not move.');
    expect(balanceOf(itemId)).toBeNull();
  });

  it('F2 fix-round: assigning a payment against an already-zero balance says nothing came off', async () => {
    setup();
    const itemId = seedLoanItem({ balanceCents: 0 });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -45000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. The balance was already $0.00, so nothing came off.');
    expect(balanceOf(itemId)).toBe(0);
  });

  // Review round: assignTransactionToLoan itself performs no owner check (MUST-13.13's own
  // docblock -- "any signed-in user may assign a transaction to any loan"), but the LATER
  // getWarrantyItem(itemId, user) read here, done only to compose the confirmation copy, is
  // scoped to the viewer. A self viewer acting on someone else's loan therefore gets a null
  // item back even though the assign itself succeeded -- and a null item is not the same fact
  // as a null BALANCE. `item?.currentBalanceCents ?? null` collapsed both into "unknown"; the
  // restored copy treats an item that genuinely came back null as a balance of 0 (the same
  // "nothing came off" sentence the already-zero-balance case above gets), not "unknown".
  it('review round: a self viewer assigning against a loan they cannot read back still gets the $0.00 wording, not "unknown"', async () => {
    const { sqlite } = setup();
    const itemId = seedLoanItem({ balanceCents: 0 }); // owned by ctx!.userId (Alice)
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -45000, ${ctx!.userId}, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const kidId = insertTestUser(current!.db, { name: 'Kid', username: 'kid', role: 'member' });
    sqlite.prepare("update users set visibility = 'self' where id = ?").run(kidId);
    currentUser = { id: kidId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };

    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));

    expect(result.message).toBe('Assigned. The balance was already $0.00, so nothing came off.');
  });

  it('F2 fix-round: a payment larger than the remaining balance clamps and says the balance is now $0.00', async () => {
    setup();
    const itemId = seedLoanItem({ balanceCents: 10_000 });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-05', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -45000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    const result = await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned. $100.00 came off; the balance is now $0.00.');
    expect(balanceOf(itemId)).toBe(0);
  });

  it('F1 fix-round: unassigning a link that never moved the balance says so, without claiming a restore', async () => {
    setup();
    const loanType = createItemType(`Loan ${randomUUID()}`, 'loan');
    const itemId = createWarrantyItem({
      name: 'Unknown Balance Loan 2',
      vendor: null,
      model: null,
      serial: null,
      purchaseDate: '2026-01-01',
      warrantyMonths: null,
      isLifetime: false,
      priceCents: null,
      ownerUserId: ctx!.userId,
      transactionId: null,
      typeId: loanType.id,
      notes: null,
      principalCents: null,
      interestRateBps: null,
      currentBalanceCents: null,
      balanceUpdatedAt: null,
    });
    const txn = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${ctx!.accountId}, '2026-03-06', 'HONDA FIN PAYMENT', ${normalizeMerchant('HONDA FIN PAYMENT')}, -45000, ${ctx!.userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    await assignToLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    const result = await unassignFromLoanAction(formData({ transactionId: String(txn.id), itemId: String(itemId) }));
    expect(result.error).toBeUndefined();
    expect(result.message).toBe("Unassigned. That link never moved the balance, so there's nothing to restore.");
  });

  it('F12 fix-round: an omitted loan selection gets a friendly prompt instead of "Invalid request."', async () => {
    setup();
    const { txnId } = seedLoanAndSpend(2_000_000, -45_000);
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: '' }));
    expect(result.error).toBe('Pick a loan first.');
  });
});

/** Splits a freshly-added -$100.00 txn into $70 groceries / $30 gas -- the reviewer's own
 *  reproduction numbers -- via the given setup()'s own addTxn/userId. */
function splitAMerchant(
  addTxn: (description?: string, amountCents?: number) => number,
  groceries: number,
  gas: number,
  userId: number,
  description: string,
): number {
  const id = addTxn(description, -10000);
  setTransactionSplits({
    txnId: id,
    parts: [
      { categoryId: groceries, amountCents: -7000 },
      { categoryId: gas, amountCents: -3000 },
    ],
    userId,
  });
  return id;
}

/**
 * Adversarial-review fix (2026-08-22): bulkTransferAction and bulkCategorizeAction now report
 * a truthful message when bulkSetTransfer/bulkSetCategory (src/lib/transactions.ts) skip a
 * split transaction instead of silently either erasing its money (defect 1, "Mark transfer")
 * or poisoning the categorizer with a false merchant signal (defect 2, "Categorize"). See the
 * guard on confirmCategory/setTransferFlag in src/lib/categorize/engine.ts.
 */
describe('bulkTransferAction and bulkCategorizeAction: split rows are skipped and reported', () => {
  it('bulkTransferAction: an ordinary batch with no splits is unaffected', async () => {
    const { addTxn } = setup();
    const a = addTxn('CONTROL A');
    const b = addTxn('CONTROL B');
    const result = await bulkTransferAction({}, formData({ ids: `${a},${b}`, isTransfer: '1' }));
    expect(result.message).toBe('Marked 2 transactions as transfers.');
  });

  it('bulkTransferAction: an all-split batch of one reports the singular skip sentence', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');

    const result = await bulkTransferAction({}, formData({ ids: String(id), isTransfer: '1' }));
    expect(result.message).toBe('Marked 0 transactions as transfers. 1 split transaction was skipped, clear its split first.');
  });

  it('bulkTransferAction: a partially-split batch reports both counts', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');
    const a = addTxn('CONTROL A');
    const b = addTxn('CONTROL B');

    const result = await bulkTransferAction({}, formData({ ids: `${splitId},${a},${b}`, isTransfer: '1' }));
    expect(result.message).toBe('Marked 2 transactions as transfers. 1 split transaction was skipped, clear its split first.');
  });

  it('bulkTransferAction: two split rows report the plural skip sentence', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const first = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT ONE');
    const second = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT TWO');

    const result = await bulkTransferAction({}, formData({ ids: `${first},${second}`, isTransfer: '1' }));
    expect(result.message).toBe('Marked 0 transactions as transfers. 2 split transactions were skipped, clear their split first.');
  });

  it('bulkCategorizeAction: a single unsplit row reports the singular changed sentence, no skip clause', async () => {
    const { db, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = addTxn('CONTROL A');
    const result = await bulkCategorizeAction({}, formData({ ids: String(id), categoryId: String(groceries) }));
    expect(result.message).toBe('Categorized 1 transaction.');
  });

  it('bulkCategorizeAction: an all-split batch of one reports the singular skip sentence', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const coffee = categoryIdByName(db, 'Coffee');
    const id = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');

    const result = await bulkCategorizeAction({}, formData({ ids: String(id), categoryId: String(coffee) }));
    expect(result.message).toBe('Categorized 0 transactions. 1 split transaction was skipped, clear its split first.');
  });

  it('bulkCategorizeAction: a partially-split batch reports both counts', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const coffee = categoryIdByName(db, 'Coffee');
    const splitId = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');
    const a = addTxn('CONTROL A');
    const b = addTxn('CONTROL B');

    const result = await bulkCategorizeAction({}, formData({ ids: `${splitId},${a},${b}`, categoryId: String(coffee) }));
    expect(result.message).toBe('Categorized 2 transactions. 1 split transaction was skipped, clear its split first.');
  });
});

/**
 * Final pre-release review fix (2026-08-22): setCategoryAction's EMPTY-selection branch calls
 * clearCategory, the third sibling of confirmCategory/setTransferFlag that never got Task 2b's
 * split guard (see the clearCategory tests in tests/lib/splits-bulk.test.ts for the engine-level
 * proof this refuses and untrains nothing). This is the action-level path: a stale form
 * resubmit, or a second household member's unrefreshed page, is the only realistic way to POST
 * an empty categoryId for a split row, since the UI hides this form entirely once a row shows
 * a "Split" badge.
 */
describe('setCategoryAction: clearing a category on a split transaction is refused (third sibling to the bulk split guard)', () => {
  it("errors and leaves the split parent's category, source and Bayes training untouched", async () => {
    const { db, sqlite, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const id = addTxn('ACME SPLIT MERCHANT', -10000);
    expect(confirmCategory({ transactionId: id, categoryId: groceries, userId, actorRole: 'admin' }).ok).toBe(true);
    setTransactionSplits({
      txnId: id,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: gas, amountCents: -3000 },
      ],
      userId,
    });
    const readRow = () =>
      sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
        category_id: number | null;
        categorization_source: string;
      };
    const before = readRow();
    expect(before).toEqual({ category_id: groceries, categorization_source: 'manual' });

    const result = await setCategoryAction({}, formData({ transactionId: String(id), categoryId: '' }));

    expect(result.error).toBeTruthy();
    expect(result.message).toBeUndefined();
    expect(readRow()).toEqual(before);
    // The real training confirmCategory did for this merchant/category must survive.
    expect((sqlite.prepare('select count(*) as c from bayes_tokens where category_id = ?').get(groceries) as { c: number }).c).toBeGreaterThan(0);
  });

  it('an unsplit control transaction can still have its category cleared through the action', async () => {
    const { db, sqlite, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const id = addTxn('CONTROL MERCHANT');
    expect(confirmCategory({ transactionId: id, categoryId: groceries, userId, actorRole: 'admin' }).ok).toBe(true);

    const result = await setCategoryAction({}, formData({ transactionId: String(id), categoryId: '' }));

    expect(result.message).toBe('Category updated.');
    expect(result.error).toBeUndefined();
    const row = sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
      category_id: number | null;
      categorization_source: string;
    };
    expect(row).toEqual({ category_id: null, categorization_source: 'none' });
  });
});

describe('v1.12.1: a row edit on /transactions edits ONE row (item U / UX-2, ruling R4)', () => {
  it('sets the category and creates no household merchant rule', async () => {
    const { db, addTxn } = setup();
    const txnId = addTxn('CITY GROCER', -5000);
    const before = db.get<{ n: number }>(sql`select count(*) as n from merchant_rules`).n;

    await setCategoryAction({}, formData({ transactionId: String(txnId), categoryId: String(categoryIdByName(db, 'Groceries')) }));

    expect(db.get<{ n: number }>(sql`select count(*) as n from merchant_rules`).n).toBe(before);
    expect(db.get<{ c: number | null }>(sql`select category_id as c from transactions where id = ${txnId}`).c).toBe(
      categoryIdByName(db, 'Groceries'),
    );
  });

  it('clearing to Uncategorized leaves that merchant rule alone', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const txnId = addTxn('CITY GROCER', -5000);
    // A rule an admin made deliberately, through Settings -> Rules.
    upsertRuleFromCorrection({
      pattern: 'CITY GROCER',
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: userId,
      actorRole: 'admin',
      at: new Date('2026-08-01T00:00:00.000Z'),
    });

    await setCategoryAction({}, formData({ transactionId: String(txnId), categoryId: '' }));

    expect(db.get<{ n: number }>(sql`select count(*) as n from merchant_rules where pattern = 'CITY GROCER'`).n).toBe(1);
    expect(db.get<{ c: number | null }>(sql`select category_id as c from transactions where id = ${txnId}`).c).toBeNull();
  });
});

/**
 * Controller fix round 1: this task's own report flagged these three as missing. Each proves
 * RED by hand-reverting the guard it covers (see task-10-fix-report.md for the transcripts).
 */
describe('manualEntryAction — ruling R10: an asset account refuses transactions', () => {
  it('returns {error} inline and inserts no transaction row', async () => {
    const { sqlite } = setup();
    const assetAccountId = insertAssetAccount();
    const before = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

    const result = await manualEntryAction(
      {},
      formData({
        amount: '12.34',
        direction: 'spend',
        accountId: String(assetAccountId),
        date: '2026-03-02',
        description: 'Quarterly balance check',
      }),
    );

    expect(result.error).toBe('That account only holds a balance you type in.');
    expect(result.message).toBeUndefined();
    const after = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('manualEntryAction — ruling R7: lastAccountId', () => {
  it('a successful quick-add stamps the users row with the account it used', async () => {
    const { sqlite, userId, accountId } = setup();
    const before = sqlite.prepare('select last_account_id as v from users where id = ?').get(userId) as {
      v: number | null;
    };
    expect(before.v).toBeNull();

    const result = await manualEntryAction(
      {},
      formData({ amount: '12.34', direction: 'spend', accountId: String(accountId), date: '2026-03-02', description: 'Coffee' }),
    );

    expect(result.message).toBeTruthy();
    const after = sqlite.prepare('select last_account_id as v from users where id = ?').get(userId) as {
      v: number | null;
    };
    expect(after.v).toBe(accountId);
  });

  it('a failed quick-add (bad amount) leaves it untouched', async () => {
    const { sqlite, userId } = setup();

    const result = await manualEntryAction(
      {},
      formData({ amount: 'not-a-number', direction: 'spend', accountId: 'cash', date: '2026-03-02', description: 'Coffee' }),
    );

    expect(result.error).toBeTruthy();
    const after = sqlite.prepare('select last_account_id as v from users where id = ?').get(userId) as {
      v: number | null;
    };
    expect(after.v).toBeNull();
  });
});

describe("renameTransactionAction — ruling R4: a member cannot overwrite another user's rule", () => {
  it("refuses a member's 'all matching' rename with ruleOwnedError, leaving the rule and the row unchanged", async () => {
    const { db, sqlite, addTxn } = setup();
    const ownerId = ctx!.userId; // 'Alice', admin, seeded by setup()
    const memberId = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });

    // The owner creates the rename rule first, as an admin (createdBy is recorded).
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('CITY GROCER'),
      matchType: 'exact',
      ruleKind: 'rename',
      categoryId: null,
      renameTo: 'City Grocer Co-op',
      createdBy: ownerId,
      actorRole: 'admin',
      at: new Date('2026-08-01T00:00:00.000Z'),
    });

    const txnId = addTxn('CITY GROCER', -4000);
    currentUser = { id: memberId, name: 'Bob', username: 'bob', role: 'member' };

    const result = await renameTransactionAction(
      {},
      formData({ transactionId: String(txnId), displayName: 'Somebody Else Grocer', scope: 'all' }),
    );

    expect(result.error).toBe(ruleOwnedError('Alice'));
    expect(result.message).toBeUndefined();

    const rule = sqlite
      .prepare('select rename_to as renameTo, created_by as createdBy from merchant_rules where pattern = ?')
      .get(normalizeMerchant('CITY GROCER')) as { renameTo: string; createdBy: number };
    expect(rule.renameTo).toBe('City Grocer Co-op');
    expect(rule.createdBy).toBe(ownerId);

    const row = sqlite
      .prepare('select display_description as d, display_source as s from transactions where id = ?')
      .get(txnId) as { d: string | null; s: string | null };
    expect(row.d).toBeNull();
    expect(row.s).toBeNull();
  });

  it('an admin CAN overwrite the same rule', async () => {
    const { sqlite, addTxn } = setup();
    const ownerId = ctx!.userId;
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('CITY GROCER'),
      matchType: 'exact',
      ruleKind: 'rename',
      categoryId: null,
      renameTo: 'City Grocer Co-op',
      createdBy: ownerId,
      actorRole: 'admin',
      at: new Date('2026-08-01T00:00:00.000Z'),
    });
    const txnId = addTxn('CITY GROCER', -4000);
    // currentUser is already the admin `setup()` created.

    const result = await renameTransactionAction(
      {},
      formData({ transactionId: String(txnId), displayName: 'City Grocer (renamed)', scope: 'all' }),
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toBeTruthy();
    const rule = sqlite
      .prepare('select rename_to as renameTo from merchant_rules where pattern = ?')
      .get(normalizeMerchant('CITY GROCER')) as { renameTo: string };
    expect(rule.renameTo).toBe('City Grocer (renamed)');
  });
});

/**
 * Controller fix round 2, finding 1: bulkCategorizeAction/bulkTransferAction used to call
 * bulkSetCategory/bulkSetTransfer with a hard-coded actorRole: 'admin', so any member selecting
 * rows and clicking Categorize/Mark transfer (the create-rules checkbox defaults checked) could
 * silently overwrite a household rule owned by someone else. Both actions now pass user.role
 * and translate a { ok: false, reason: 'owned_by_another' } refusal into the same ruleOwnedError
 * sentence the single-row and rename paths already use.
 */
describe('bulkCategorizeAction / bulkTransferAction -- ruling R4 fix round 2', () => {
  it('bulkCategorizeAction: a member is refused over a foreign-owned rule, and the row is unchanged', async () => {
    const { db, sqlite, userId, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');

    upsertRuleFromCorrection({
      pattern: normalizeMerchant('OWNER MERCHANT'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: userId,
      actorRole: 'admin',
    });
    const txnId = addTxn('OWNER MERCHANT', -1500);
    currentUser = { id: bob, name: 'Bob', username: 'bob', role: 'member' };

    const result = await bulkCategorizeAction({}, formData({ ids: String(txnId), categoryId: String(coffee), createRules: 'on' }));

    expect(result.error).toBe(ruleOwnedError('Alice'));
    expect(result.message).toBeUndefined();
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(txnId) as { c: number | null };
    expect(row.c).toBeNull();
  });

  it('bulkCategorizeAction: an admin CAN overwrite the same rule', async () => {
    const { db, userId, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('OWNER MERCHANT'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: userId,
      actorRole: 'admin',
    });
    const txnId = addTxn('OWNER MERCHANT', -1500);
    // currentUser is already the admin setup() created.

    const result = await bulkCategorizeAction({}, formData({ ids: String(txnId), categoryId: String(coffee), createRules: 'on' }));

    expect(result.error).toBeUndefined();
    expect(result.message).toBe('Categorized 1 transaction.');
  });

  it('bulkTransferAction: a member is refused over a foreign-owned rule, and the row is unchanged', async () => {
    const { db, sqlite, userId, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('E-TRANSFER OWNER'),
      matchType: 'exact',
      ruleKind: 'transfer',
      categoryId: null,
      createdBy: userId,
      actorRole: 'admin',
    });
    const txnId = addTxn('E-TRANSFER OWNER', -1500);
    currentUser = { id: bob, name: 'Bob', username: 'bob', role: 'member' };

    const result = await bulkTransferAction({}, formData({ ids: String(txnId), isTransfer: '1' }));

    expect(result.error).toBe(ruleOwnedError('Alice'));
    expect(result.message).toBeUndefined();
    const row = sqlite.prepare('select is_transfer as t from transactions where id = ?').get(txnId) as { t: number };
    expect(row.t).toBe(0);
  });
});

/**
 * Controller fix round 2, finding 2: none of these four actions resolved their target row(s)
 * through the viewer before writing, so a self viewer could POST a transactionId/ids value
 * belonging to someone else and change its category, transfer flag or attribution. Every action
 * now refuses the whole request (writes nothing) with NOT_YOURS_ERROR when any target row does
 * not resolve through getTransaction(id, viewer).
 */
describe('ruling R2 fix round 2 -- a self viewer cannot write another persons transaction', () => {
  function setupSelfViewer() {
    const { db, sqlite, userId, accountId, addTxn } = setup();
    // userId/currentUser from setup() is Alice, household-visibility admin -- the "someone
    // else" whose transaction the self viewer must not be able to touch.
    const selfUserId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    db.run(sql`update users set visibility = 'self' where id = ${selfUserId}`);
    // A transaction attributed to Alice, not the self viewer.
    const foreignTxnId = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'FOREIGN ROW', ${normalizeMerchant('FOREIGN ROW')}, -1200, ${userId}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    currentUser = { id: selfUserId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    return { sqlite, foreignTxnId, addTxn };
  }

  it('setCategoryAction refuses and leaves the category untouched', async () => {
    const { sqlite, foreignTxnId } = setupSelfViewer();
    const groceries = categoryIdByName(current!.db, 'Groceries');

    const result = await setCategoryAction({}, formData({ transactionId: String(foreignTxnId), categoryId: String(groceries) }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(foreignTxnId) as {
      c: number | null;
    };
    expect(row.c).toBeNull();
  });

  it('bulkCategorizeAction refuses and leaves the category untouched', async () => {
    const { sqlite, foreignTxnId } = setupSelfViewer();
    const groceries = categoryIdByName(current!.db, 'Groceries');

    const result = await bulkCategorizeAction({}, formData({ ids: String(foreignTxnId), categoryId: String(groceries) }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(foreignTxnId) as {
      c: number | null;
    };
    expect(row.c).toBeNull();
  });

  it('bulkTransferAction refuses and leaves is_transfer untouched', async () => {
    const { sqlite, foreignTxnId } = setupSelfViewer();

    const result = await bulkTransferAction({}, formData({ ids: String(foreignTxnId), isTransfer: '1' }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    const row = sqlite.prepare('select is_transfer as t from transactions where id = ?').get(foreignTxnId) as { t: number };
    expect(row.t).toBe(0);
  });

  it('setAttributionAction refuses and leaves attribution untouched', async () => {
    const { sqlite, foreignTxnId } = setupSelfViewer();

    const result = await setAttributionAction({}, formData({ ids: String(foreignTxnId), attributedUserId: '' }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(foreignTxnId) as {
      a: number | null;
    };
    // still attributed to Alice -- the clear-to-household write never ran.
    expect(row.a).not.toBeNull();
  });

  it('a household viewer (the pre-existing default) is unaffected by any of the above', async () => {
    // Regression guard: currentUser here is the plain household admin setup() seeds -- every
    // existing test in this file already exercises this path, so this is a single, explicit
    // witness rather than a duplicate of the whole suite.
    const { sqlite, addTxn } = setup();
    const groceries = categoryIdByName(current!.db, 'Groceries');
    const txnId = addTxn('HOUSEHOLD ROW', -900);

    const result = await setCategoryAction({}, formData({ transactionId: String(txnId), categoryId: String(groceries) }));

    expect(result.message).toBe('Category updated.');
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(txnId) as { c: number | null };
    expect(row.c).toBe(groceries);
  });
});

// v1.13.0 whole-branch review, item I3. manualEntryAction used unscoped getAccount() and trusted
// whatever attributedUserId a self viewer's form posted; setAttributionAction checked that every
// TARGET ROW resolved through the viewer, but never checked the DESTINATION PERSON. Both let a
// self viewer write into someone else's account, or attribute a row to someone else, despite R2's
// "no household figure leaves this file" posture.
describe('ruling R2 fix round 3 -- a self viewer writes are forced to their own scope (item I3)', () => {
  function setupSelfViewer() {
    const { db, sqlite, userId, accountId } = setup(); // accountId: Alice's Joint Chequing (owner null)
    const selfUserId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    db.run(sql`update users set visibility = 'self' where id = ${selfUserId}`);
    const selfOwnAccountId = insertTestAccount(db, { name: 'Kid Cash', type: 'cash', ownerUserId: selfUserId });
    currentUser = { id: selfUserId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    return { db, sqlite, foreignAccountId: accountId, selfOwnAccountId, selfUserId, otherUserId: userId };
  }

  it("manualEntryAction refuses an account outside the self viewer's own scope, and inserts no row", async () => {
    const { sqlite, foreignAccountId } = setupSelfViewer();
    const before = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;

    const result = await manualEntryAction(
      {},
      formData({ amount: '12.34', direction: 'spend', accountId: String(foreignAccountId), date: '2026-03-02', description: 'Sneaky' }),
    );

    expect(result.error).toBe(NOT_YOURS_ERROR);
    const after = (sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("manualEntryAction forces attribution to the self viewer's own id, ignoring a posted attributedUserId", async () => {
    const { sqlite, selfOwnAccountId, selfUserId, otherUserId } = setupSelfViewer();

    const result = await manualEntryAction(
      {},
      formData({
        amount: '12.34',
        direction: 'spend',
        accountId: String(selfOwnAccountId),
        date: '2026-03-02',
        description: 'Coffee',
        attributedUserId: String(otherUserId),
      }),
    );

    expect(result.message).toBeTruthy();
    const row = sqlite
      .prepare('select attributed_user_id as a from transactions where account_id = ? order by id desc limit 1')
      .get(selfOwnAccountId) as { a: number | null };
    expect(row.a).toBe(selfUserId);
  });

  it("setAttributionAction refuses attributing the viewer's OWN row to anyone but themself -- another person, or back to household", async () => {
    const { db, sqlite, selfOwnAccountId, selfUserId, otherUserId } = setupSelfViewer();
    const ownTxnId = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${selfOwnAccountId}, '2026-03-02', 'OWN ROW', ${normalizeMerchant('OWN ROW')}, -500, ${selfUserId}, ${selfUserId}, ${nowIso()}, ${nowIso()})
      returning id`).id;

    const toOther = await setAttributionAction({}, formData({ ids: String(ownTxnId), attributedUserId: String(otherUserId) }));
    expect(toOther.error).toBe(NOT_YOURS_ERROR);

    const toHousehold = await setAttributionAction({}, formData({ ids: String(ownTxnId), attributedUserId: '' }));
    expect(toHousehold.error).toBe(NOT_YOURS_ERROR);

    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(ownTxnId) as {
      a: number | null;
    };
    expect(row.a).toBe(selfUserId);
  });

  it('setAttributionAction still allows a self viewer to attribute their own row to themself', async () => {
    const { db, sqlite, selfOwnAccountId, selfUserId } = setupSelfViewer();
    const ownTxnId = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${selfOwnAccountId}, '2026-03-02', 'OWN ROW', ${normalizeMerchant('OWN ROW')}, -500, ${selfUserId}, ${selfUserId}, ${nowIso()}, ${nowIso()})
      returning id`).id;

    const result = await setAttributionAction({}, formData({ ids: String(ownTxnId), attributedUserId: String(selfUserId) }));

    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select attributed_user_id as a from transactions where id = ?').get(ownTxnId) as {
      a: number | null;
    };
    expect(row.a).toBe(selfUserId);
  });
});

describe('bulk ownership pre-check (item BL, ruling P14)', () => {
  function categoryOf(sqlite: TestDb['sqlite'], id: number): number | null {
    return (sqlite.prepare('select category_id as c from transactions where id = ?').get(id) as { c: number | null }).c;
  }

  it('still refuses a household viewer a nonexistent id and writes nothing', async () => {
    // The regression this ruling exists to pin: getTransaction(id, viewer) returned null for
    // "no such row" as well as "not yours", and allTransactionsVisible refused on both. A
    // scope-only rewrite would quietly start accepting bogus ids from a household viewer.
    const { sqlite, addTxn } = setup();
    const groceries = categoryIdByName(current!.db, 'Groceries');
    const txnId = addTxn('CITY GROCER', -1200);
    const before = categoryOf(sqlite, txnId);

    const result = await bulkCategorizeAction({}, formData({ ids: `${txnId},999999`, categoryId: String(groceries) }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(categoryOf(sqlite, txnId)).toBe(before);
  });

  it("still refuses a self viewer somebody else's id and writes nothing", async () => {
    const { db, sqlite, userId, accountId } = setup();
    const groceries = categoryIdByName(current!.db, 'Groceries');
    const bobsTxnId = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'BOBS ROW', ${normalizeMerchant('BOBS ROW')}, -1200, ${userId}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    const selfUserId = insertTestUser(db, { name: 'Kid', username: 'kid', role: 'member' });
    db.run(sql`update users set visibility = 'self' where id = ${selfUserId}`);
    currentUser = { id: selfUserId, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const before = categoryOf(sqlite, bobsTxnId);

    const result = await bulkCategorizeAction({}, formData({ ids: String(bobsTxnId), categoryId: String(groceries) }));

    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(categoryOf(sqlite, bobsTxnId)).toBe(before);
  });
});

/** Addendum A: a transaction with the sign the case under test needs. */
function addSigned(amountCents: number, description = 'E-TRANSFER SAM'): number {
  const { accountId, userId } = ctx!;
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

function loanItems(): { id: number; name: string; balance: number | null; direction: string; type_id: number }[] {
  return current!.sqlite
    .prepare(
      `select i.id, i.name, i.current_balance_cents as balance, i.loan_direction as direction, i.type_id
         from warranty_items i join warranty_item_types t on t.id = i.type_id
        where t.kind = 'loan' order by i.id`,
    )
    .all() as never;
}

describe('createLoanFromTransactionAction — Addendum A', () => {
  it('lends: money out on a new lent loan leaves them owing exactly that amount', async () => {
    setup();
    const txnId = addSigned(-50_000);
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBeUndefined();
    const [loan] = loanItems();
    expect(loan!.name).toBe('Loan to Sam');
    expect(loan!.direction).toBe('lent');
    // Ruling A3: seed 0, link() applies +m, balance after = |amount|.
    expect(loan!.balance).toBe(50_000);
    expect(result.message).toBe('Created Loan to Sam. Assigned. $500.00 added to what they owe.');
  });

  it('borrows, money in: the deposit that arrived becomes the opening balance', async () => {
    setup();
    const txnId = addSigned(50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Bank loan', loanDirection: 'owed' }),
    );
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('borrows, money out: a first payment still leaves |amount| owing (seed 2m, ruling A3)', async () => {
    setup();
    const txnId = addSigned(-50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Family loan', loanDirection: 'owed' }),
    );
    // Seeded at 2m so link()'s repayment of m lands on m: if m is still owed after paying m,
    // 2m was owed before it. NOT a second write -- link() is the only mover.
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('refuses a lent loan opened by money coming IN, and writes nothing at all', async () => {
    setup();
    const txnId = addSigned(50_000);
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe('A loan you lent out starts with money going out.');
    // Ruling A4: one transaction, so a refusal leaves no item, no type and no link behind.
    expect(loanItems()).toEqual([]);
    expect(
      current!.sqlite.prepare('select count(*) as n from loan_payments').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('creates the Loan item type when the household has none, and reuses it next time', async () => {
    setup();
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'First', loanDirection: 'lent' }),
    );
    const types = current!.sqlite
      .prepare("select id, name from warranty_item_types where kind = 'loan'")
      .all() as { id: number; name: string }[];
    expect(types.map((t) => t.name)).toEqual(['Loan']);   // ruling A5
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-25_000)), loanName: 'Second', loanDirection: 'lent' }),
    );
    expect(
      current!.sqlite.prepare("select count(*) as n from warranty_item_types where kind = 'loan'").get(),
    ).toEqual({ n: 1 });
    expect(loanItems().map((loan) => loan.balance)).toEqual([50_000, 25_000]);
  });

  it('uses the first loan-kind type by name when one already exists (ruling A6)', async () => {
    setup();
    createItemType('Zebra loan', 'loan');
    const alpha = createItemType('Alpha loan', 'loan');
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(loanItems()[0]!.type_id).toBe(alpha.id);
  });

  it('refuses a second submit of the same transaction (ruling A7 — the double-submit guard)', async () => {
    setup();
    const txnId = addSigned(-50_000);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const second = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(second.error).toBe('That transaction is already assigned to a loan.');
    expect(loanItems()).toHaveLength(1);
    expect(loanItems()[0]!.balance).toBe(50_000);
  });

  it('refuses a name that is only whitespace', async () => {
    setup();
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: '   ', loanDirection: 'lent' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it('refuses a direction that is neither', async () => {
    setup();
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'given' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(addSigned(-50_000)), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
    expect(loanItems()).toEqual([]);
  });
});

describe('createLoanFromTransactionAction — scope (rulings A10, A12)', () => {
  it("a self viewer cannot open a loan against somebody else's transaction", async () => {
    const { db, accountId } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    currentUser = { id: currentUser.id, name: 'Kid', username: 'kid', role: 'member', visibility: 'self' };
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBeTruthy();
    expect(loanItems()).toEqual([]);
  });

  it("a self viewer's own loan is owned by them, never by the row's attribution", async () => {
    const { db, accountId } = setup();
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(currentUser.id, txnId);
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const owner = current!.sqlite
      .prepare('select owner_user_id as o from warranty_items order by id desc limit 1')
      .get() as { o: number };
    expect(owner.o).toBe(currentUser.id);
  });

  it('a household MEMBER is refused a row attributed to someone else', async () => {
    const { db } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    currentUser = { ...currentUser, role: 'member' };
    const result = await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    expect(result.error).toBe(NOT_YOURS_ERROR);
    expect(loanItems()).toEqual([]);
  });

  it('a household ADMIN may, and the loan belongs to the person the row is attributed to', async () => {
    const { db } = setup();
    const otherId = insertTestUser(db, { name: 'Bob', username: 'bob' });
    const txnId = addSigned(-50_000);
    current!.sqlite.prepare('update transactions set attributed_user_id = ? where id = ?').run(otherId, txnId);
    await createLoanFromTransactionAction(
      {},
      formData({ transactionId: String(txnId), loanName: 'Loan to Sam', loanDirection: 'lent' }),
    );
    const owner = current!.sqlite
      .prepare('select owner_user_id as o from warranty_items order by id desc limit 1')
      .get() as { o: number };
    expect(owner.o).toBe(otherId);
  });
});

/** A row with a category already on it (a bayes guess, or a plain confirmed category). */
function addTxnWithCategory(description: string, categoryId: number, source: 'bayes' | 'manual' = 'bayes'): number {
  const { accountId, userId } = ctx!;
  const row = current!.db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${description}, ${normalizeMerchant(description)}, -500, ${categoryId}, ${source}, ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

/**
 * v1.14.1 -- these three actions were ported from src/app/(app)/review/actions.ts (deleted by
 * Lane 2 once the transactions page absorbs the queue). Their guards, refusal messages and
 * actorRole arguments are byte-identical to the review-page originals; only the wiring (rename,
 * ActionState shape, revalidatePath target, and setRowTransferAction's new isTransfer field)
 * changed.
 */
describe('acceptGuessAction (ported from review/actions.ts)', () => {
  it('confirms the guessed category and reports it accepted', async () => {
    const { db, sqlite, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxnWithCategory('TIM HORTONS', coffee, 'bayes');
    const result = await acceptGuessAction({}, formData({ transactionId: String(id) }));
    expect(result.message).toBe('Accepted.');
    const row = sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
      category_id: number;
      categorization_source: string;
    };
    expect(row).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(addTxn).toBeTypeOf('function');
  });

  it('errors when the row has no guess to accept', async () => {
    const { addTxn } = setup();
    const id = addTxn();
    const result = await acceptGuessAction({}, formData({ transactionId: String(id) }));
    expect(result.error).toBe('There is no guess to accept on that row.');
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await acceptGuessAction({}, formData({ transactionId: '1' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses a self-scoped viewer, byte-identical to the review-page guard', async () => {
    const { db, sqlite, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxnWithCategory('TIM HORTONS', coffee, 'bayes');
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await acceptGuessAction({}, formData({ transactionId: String(id) }));
    expect(result.error).toBe('Review is not available on this account.');
    const row = sqlite.prepare('select categorization_source as s from transactions where id = ?').get(id) as { s: string };
    expect(row.s).toBe('bayes');
    expect(addTxn).toBeTypeOf('function');
  });

  it('surfaces a rule-ownership refusal the same way confirmCategory reports it elsewhere', async () => {
    const { db, sqlite, userId, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('SOMEBODY ELSES RULE'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: bob,
      actorRole: 'member',
    });
    const id = addTxnWithCategory('SOMEBODY ELSES RULE', coffee, 'bayes');
    currentUser = { ...currentUser, role: 'member' };
    const result = await acceptGuessAction({}, formData({ transactionId: String(id) }));
    expect(result.error).toBe(ruleOwnedError('Bob'));
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(id) as { c: number };
    expect(row.c).toBe(coffee);
    expect(userId).toBeGreaterThan(0);
    expect(addTxn).toBeTypeOf('function');
  });
});

describe('applyToAllMatchingAction (ported from review/actions.ts)', () => {
  it('applies the category to every other matching row and creates a rule', async () => {
    const { db, sqlite, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = addTxn('TIM HORTONS');
    const b = addTxn('TIM HORTONS');
    const result = await applyToAllMatchingAction(
      {},
      formData({ normalizedMerchant: normalizeMerchant('TIM HORTONS'), categoryId: String(coffee) }),
    );
    expect(result.message).toBe('Applied to 2 transactions and created a rule.');
    const rows = sqlite.prepare('select category_id as c from transactions where id in (?, ?)').all(a, b) as { c: number }[];
    expect(rows.every((r) => r.c === coffee)).toBe(true);
  });

  it('errors when no category was picked', async () => {
    setup();
    const result = await applyToAllMatchingAction({}, formData({ normalizedMerchant: 'TIM HORTONS', categoryId: '' }));
    expect(result.error).toBe('Pick a category.');
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await applyToAllMatchingAction({}, formData({ normalizedMerchant: 'X', categoryId: '1' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses a self-scoped viewer, byte-identical to the review-page guard', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await applyToAllMatchingAction(
      {},
      formData({ normalizedMerchant: normalizeMerchant('TIM HORTONS'), categoryId: String(coffee) }),
    );
    expect(result.error).toBe('Review is not available on this account.');
  });

  it('refuses a rule-ownership conflict and writes nothing', async () => {
    const { db, sqlite, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('OWNER MERCHANT'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: bob,
      actorRole: 'member',
    });
    const id = addTxn('OWNER MERCHANT');
    currentUser = { ...currentUser, role: 'member' };
    const result = await applyToAllMatchingAction(
      {},
      formData({ normalizedMerchant: normalizeMerchant('OWNER MERCHANT'), categoryId: String(coffee) }),
    );
    expect(result.error).toBe(ruleOwnedError('Bob'));
    const row = sqlite.prepare('select category_id as c from transactions where id = ?').get(id) as { c: number | null };
    expect(row.c).toBeNull();
  });
});

describe('setRowTransferAction (ported from review/actions.ts, renamed, both directions -- ruling R4)', () => {
  it('marks a row a transfer and learns an exact rule', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn('E-TRANSFER SENT J DOE');
    const result = await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '1' }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(1);
  });

  it('un-marks a transfer back to not-a-transfer', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn('E-TRANSFER SENT J DOE');
    await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '1' }));
    const result = await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '0' }));
    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(0);
  });

  it('returns a clean error for a non-numeric transactionId instead of throwing', async () => {
    setup();
    await expect(setRowTransferAction({}, formData({ transactionId: 'nope', isTransfer: '1' }))).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await setRowTransferAction({}, formData({ transactionId: '1', isTransfer: '1' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses a self-scoped viewer, byte-identical to the review-page guard', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '1' }));
    expect(result.error).toBe('Review is not available on this account.');
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(0);
  });

  it('surfaces the rule-ownership refusal as the row error and writes nothing', async () => {
    const { db, sqlite, addTxn } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('E-TRANSFER OWNER'),
      matchType: 'exact',
      ruleKind: 'transfer',
      categoryId: null,
      createdBy: bob,
      actorRole: 'member',
    });
    const id = addTxn('E-TRANSFER OWNER');
    currentUser = { ...currentUser, role: 'member' };
    const result = await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '1' }));
    expect(result.error).toBe(ruleOwnedError('Bob'));
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(0);
  });
});

/**
 * v1.14.1 ruling R3: setCategoryAction's category-pick branch now reads a `teach` field. `'1'`
 * means the row's own pick doubles as the categorizer's confirmation (createRule: true, as
 * /review's fixCategoryAction always did); anything else (absent, '0', or garbage) keeps today's
 * createRule: false -- a plain per-row edit, no household rule.
 */
describe("setCategoryAction: ruling R3 -- teach='1' creates a rule, anything else does not", () => {
  it("teach='1' creates a merchant rule for this category, same as accepting a guess", async () => {
    const { db, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxn('TEACH MERCHANT');
    const result = await setCategoryAction({}, formData({ transactionId: String(id), categoryId: String(coffee), teach: '1' }));
    expect(result.message).toBe('Category updated.');
    expect(listRules('category').map((r) => r.pattern)).toContain(normalizeMerchant('TEACH MERCHANT'));
  });

  it('teach absent creates no rule (today\'s behaviour, unchanged)', async () => {
    const { db, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxn('NO TEACH MERCHANT');
    await setCategoryAction({}, formData({ transactionId: String(id), categoryId: String(coffee) }));
    expect(listRules('category').map((r) => r.pattern)).not.toContain(normalizeMerchant('NO TEACH MERCHANT'));
  });

  it("teach='0' (or any other value) creates no rule either", async () => {
    const { db, addTxn } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = addTxn('GARBAGE TEACH MERCHANT');
    await setCategoryAction({}, formData({ transactionId: String(id), categoryId: String(coffee), teach: 'garbage' }));
    expect(listRules('category').map((r) => r.pattern)).not.toContain(normalizeMerchant('GARBAGE TEACH MERCHANT'));
  });
});
