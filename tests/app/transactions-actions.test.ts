import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { createWarrantyItem, getWarrantyItem } from '@/lib/warranty/items';
import { createItemType } from '@/lib/warranty/types';
import { setTransactionSplits } from '@/lib/splits';
import { confirmCategory, runEngine } from '@/lib/categorize/engine';
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
  acceptAllGuessesAction,
  acceptGuessAction,
  applyToAllMatchingAction,
  assignToLoanAction,
  bulkAssignToLoanAction,
  bulkCategorizeAction,
  // v1.26.0 Lane 3a item 4: the two group-header bulk actions.
  bulkConfirmGroupAction,
  bulkNoteAction,
  bulkRecategorizeGroupAction,
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
    // Item 6 (v1.21.0 backlog): SOME of the repayment applied, but not all -- exactly the shape
    // the new clamp warning exists for (see loanClampWarning, src/lib/warranty/constants.ts),
    // appended after the ordinary confirmation sentence rather than replacing it.
    expect(result.message).toBe(
      'Assigned. $100.00 came off; the balance is now $0.00. ' +
        'Note: only $100.00 of this $450.00 repayment applied -- $350.00 exceeded the outstanding balance at the time. ' +
        'If a deposit or charge that should have come first is still unlinked, link it, or use "Recompute balance" on the loan.',
    );
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

/**
 * v1.25.0 Lane R item R3. bulkAssignToLoanAction/bulkNoteAction, mirroring the shape of the
 * split-guard describe block below (bulkTransferAction/bulkCategorizeAction) but proving the
 * OPPOSITE: a split row is NOT skipped by either new action -- see bulkAssignToLoan/bulkSetNotes'
 * own doc comments (src/lib/transactions.ts) for the justification this task's report restates.
 */
describe('bulkAssignToLoanAction and bulkNoteAction (v1.25.0 Lane R item R3)', () => {
  it('bulkAssignToLoanAction: links every selected transaction and names the loan in the message', async () => {
    const { sqlite, addTxn } = setup();
    const itemId = seedLoanItem({ balanceCents: 2_000_000 });
    const a = addTxn('PAYMENT A', -1000);
    const b = addTxn('PAYMENT B', -2000);

    const result = await bulkAssignToLoanAction({}, formData({ ids: `${a},${b}`, itemId: String(itemId) }));
    expect(result.message).toBe('Assigned 2 transactions to Car Loan.');
    const rows = sqlite.prepare('select count(*) as c from loan_payments where item_id = ?').get(itemId) as { c: number };
    expect(rows.c).toBe(2);
  });

  it('bulkAssignToLoanAction: links a SPLIT transaction too -- not subject to the split guard', async () => {
    const { db, userId, addTxn } = setup();
    const itemId = seedLoanItem({ balanceCents: 2_000_000 });
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');

    const result = await bulkAssignToLoanAction({}, formData({ ids: String(splitId), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned 1 transaction to Car Loan.');
  });

  it('bulkAssignToLoanAction: a row already linked to the chosen loan is reported as left unchanged, not as an error', async () => {
    setup();
    const itemId = seedLoanItem({ balanceCents: 2_000_000 });
    const { txnId } = seedLoanAndSpend(2_000_000, -45_000);
    await bulkAssignToLoanAction({}, formData({ ids: String(txnId), itemId: String(itemId) }));

    const result = await bulkAssignToLoanAction({}, formData({ ids: String(txnId), itemId: String(itemId) }));
    expect(result.message).toBe('Assigned 0 transactions to Car Loan. 1 was left unchanged (already linked, or not eligible for this loan).');
  });

  it('bulkAssignToLoanAction: requires a loan selection and at least one id', async () => {
    const { addTxn } = setup();
    const itemId = seedLoanItem();
    const id = addTxn();
    expect((await bulkAssignToLoanAction({}, formData({ ids: '', itemId: String(itemId) }))).error).toBe('Nothing selected.');
    expect((await bulkAssignToLoanAction({}, formData({ ids: String(id), itemId: '' }))).error).toBe('Pick a loan first.');
  });

  it('bulkAssignToLoanAction rejects a cross-origin request first', async () => {
    const { addTxn } = setup();
    const itemId = seedLoanItem();
    sameOrigin.value = false;
    const result = await bulkAssignToLoanAction({}, formData({ ids: String(addTxn()), itemId: String(itemId) }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('bulkNoteAction: writes the same note on every selected transaction, INCLUDING a split one', async () => {
    const { db, userId, sqlite, addTxn } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const gas = categoryIdByName(db, 'Gas');
    const splitId = splitAMerchant(addTxn, groceries, gas, userId, 'ACME SPLIT MERCHANT');
    const plain = addTxn('CONTROL');

    const result = await bulkNoteAction({}, formData({ ids: `${splitId},${plain}`, notes: 'shared with Bob' }));
    expect(result.message).toBe('Note saved for 2 transactions.');
    const rows = sqlite.prepare('select notes from transactions where id in (?, ?)').all(splitId, plain) as { notes: string | null }[];
    expect(rows.every((r) => r.notes === 'shared with Bob')).toBe(true);
  });

  it('bulkNoteAction: an empty note clears every selected row, and an empty id list is refused', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    await bulkNoteAction({}, formData({ ids: String(id), notes: 'temp' }));
    await bulkNoteAction({}, formData({ ids: String(id), notes: '' }));
    expect((sqlite.prepare('select notes from transactions where id = ?').get(id) as { notes: string | null }).notes).toBeNull();
    expect((await bulkNoteAction({}, formData({ ids: '', notes: 'x' }))).error).toBe('Nothing selected.');
  });

  it('bulkNoteAction rejects a cross-origin request first', async () => {
    setup();
    sameOrigin.value = false;
    const result = await bulkNoteAction({}, formData({ ids: '1', notes: 'x' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });
});

/**
 * 2026-08-30 fix. The assign-to-loan editor's "Also mark as a transfer" checkbox (defaulting ON
 * in the UI) posts `alsoTransfer` alongside `transactionId`/`itemId`; assignToLoanAction reads it
 * and, when present, calls setTransferFlag -- the SAME already-guarded path setRowTransferAction
 * posts to (see that describe block below) -- rather than writing is_transfer a second way.
 */
describe('assignToLoanAction: the opt-in "also mark as a transfer" checkbox', () => {
  it('ticked (alsoTransfer=1) sets is_transfer on the linked transaction', async () => {
    const { sqlite } = setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId), alsoTransfer: '1' }));
    expect(result.error).toBeUndefined();
    expect((sqlite.prepare('select is_transfer as t from transactions where id = ?').get(txnId) as { t: number }).t).toBe(1);
  });

  it('unticked (alsoTransfer omitted) leaves is_transfer exactly as it was -- today\'s behaviour', async () => {
    const { sqlite } = setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId) }));
    expect(result.error).toBeUndefined();
    expect((sqlite.prepare('select is_transfer as t from transactions where id = ?').get(txnId) as { t: number }).t).toBe(0);
  });

  /**
   * v1.27.0 item 1. This test used to assert the OPPOSITE, and the change is deliberate rather
   * than a regression, so the old expectation is recorded here rather than deleted quietly.
   *
   * It used to prove that a member assigning a transaction to a loan was REFUSED when an admin
   * owned that merchant's transfer rule -- correct, and unavoidable, while the loan path authored
   * a rule of its own. Now it does not author one (`learnRule: false`), so there is nothing to
   * own and nothing to refuse: the member's assign succeeds, the flag is set on their own
   * transaction, and the admin's household-wide rule is left exactly as it was. That is strictly
   * better on both counts -- the member is no longer blocked from filing their own paperwork by a
   * rule that was never relevant to it, and the admin's rule is no longer at risk from it.
   *
   * The ownership refusal itself is untouched on the path that still authors rules; see
   * setRowTransferAction's own R4 tests below.
   */
  it('no longer refuses on a rule someone else owns, because the loan path authors no rule (v1.27.0 item 1)', async () => {
    const { sqlite } = setup();
    const { itemId, txnId } = seedLoanAndSpend(2_000_000, -45_000);
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('HONDA FIN PAYMENT'), matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: ctx!.userId, actorRole: 'admin',
    });
    const memberId = insertTestUser(current!.db, { name: 'Member Other', username: 'member-other-loan', role: 'member' });
    currentUser = { id: memberId, name: 'Member Other', username: 'member-other-loan', role: 'member' };

    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId), alsoTransfer: '1' }));

    expect(result.error).toBeUndefined();
    expect(balanceOf(itemId)).toBe(1_955_000);
    expect((sqlite.prepare('select is_transfer as t from transactions where id = ?').get(txnId) as { t: number }).t).toBe(1);
    // Alice's rule survives the member's assign, unedited and undeleted.
    const owned = listRules('transfer');
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ pattern: normalizeMerchant('HONDA FIN PAYMENT'), createdBy: ctx!.userId });
  });
});

/**
 * v1.27.0 item 1 -- the owner's report, verbatim:
 *
 *   "when i add items to loan they are marked transfer by default but it also adds a rule. for
 *    example i moved this to work loan as this was re ebuisnment but next time i buy from
 *    [that shop] i dont want it to automatically caretgorize it as transfer."
 *
 * The checkbox is pre-armed ON and posts `alsoTransfer=1`; setTransferFlag does not only set
 * `is_transfer`, it upserts an exact merchant rule. So one reimbursement filed against a work loan
 * taught the household that everything from that shop is a transfer, permanently, with nothing on
 * screen to say a rule had been written. The fix is `learnRule: false` on this path only.
 */
describe('assignToLoanAction: filing one reimbursement against a loan must not teach the merchant', () => {
  /** The owner's own shape: a shop the household buys from normally, this once reimbursed. */
  function seedLoanAndPurchase(): { itemId: number; txnId: number } {
    const { accountId, userId } = ctx!;
    const itemId = seedLoanItem({ balanceCents: 2_000_000 });
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'MAPLEVIEW ELECTRONICS WOODBRIDGE', ${normalizeMerchant('MAPLEVIEW ELECTRONICS WOODBRIDGE')}, -24999, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return { itemId, txnId: row.id };
  }

  it('sets is_transfer and creates NO merchant rule of any kind, and deletes none', async () => {
    const { sqlite } = setup();
    const { itemId, txnId } = seedLoanAndPurchase();

    const result = await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId), alsoTransfer: '1' }));
    expect(result.error).toBeUndefined();

    expect((sqlite.prepare('select is_transfer as t from transactions where id = ?').get(txnId) as { t: number }).t).toBe(1);
    expect(listRules('transfer')).toEqual([]);
    expect(listRules('not_transfer')).toEqual([]);
    expect(listRules()).toEqual([]);
  });

  it('leaves an existing not_transfer rule for that merchant alone (no housekeeping delete)', async () => {
    setup();
    const { itemId, txnId } = seedLoanAndPurchase();
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('MAPLEVIEW ELECTRONICS WOODBRIDGE'), matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: ctx!.userId, actorRole: 'admin',
    });

    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId), alsoTransfer: '1' }));
    expect(listRules('not_transfer')).toHaveLength(1);
  });

  it('the next purchase from that same merchant is not auto-flagged as a transfer on import', async () => {
    const { sqlite, accountId, userId } = setup();
    const { itemId, txnId } = seedLoanAndPurchase();
    await assignToLoanAction(formData({ transactionId: String(txnId), itemId: String(itemId), alsoTransfer: '1' }));

    const next = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-04-11', 'MAPLEVIEW ELECTRONICS WOODBRIDGE', ${normalizeMerchant('MAPLEVIEW ELECTRONICS WOODBRIDGE')}, -8999, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    runEngine([next.id]);

    expect((sqlite.prepare('select is_transfer as t from transactions where id = ?').get(next.id) as { t: number }).t).toBe(0);
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
describe('manualEntryAction — F-10 (v1.31.0): quick-add\'s own Note field', () => {
  it('a posted note is saved on the new row, trimmed', async () => {
    const { sqlite, accountId } = setup();

    const result = await manualEntryAction(
      {},
      formData({
        amount: '12.34',
        direction: 'spend',
        accountId: String(accountId),
        date: '2026-03-02',
        description: 'Coffee',
        notes: '  split with Bob  ',
      }),
    );

    expect(result.message).toBeTruthy();
    const row = sqlite.prepare('select notes from transactions order by id desc limit 1').get() as { notes: string | null };
    expect(row.notes).toBe('split with Bob');
  });

  it('an empty note is stored as null, exactly like before this field existed', async () => {
    const { sqlite, accountId } = setup();

    await manualEntryAction(
      {},
      formData({ amount: '12.34', direction: 'spend', accountId: String(accountId), date: '2026-03-02', description: 'Coffee' }),
    );

    const row = sqlite.prepare('select notes from transactions order by id desc limit 1').get() as { notes: string | null };
    expect(row.notes).toBeNull();
  });
});

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

/**
 * v1.19.0 Lane 2 item 5: "Accept all suggestions". This action's OWN body does almost nothing --
 * it validates the id list, then calls acceptGuessAction once per id, exactly as a person clicking
 * Accept N times would. These tests prove that reuse actually holds (the self-scoped refusal, the
 * has-a-guess check and the rule-ownership guard all fire without being reimplemented here), and
 * that a refusal partway through stops the batch and reports the truth instead of pretending
 * every id was accepted.
 */
describe('acceptAllGuessesAction (v1.19.0 Lane 2 item 5)', () => {
  it('accepts every id and reports the plural sentence', async () => {
    const { db, sqlite } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = addTxnWithCategory('MERCHANT ONE', coffee, 'bayes');
    const b = addTxnWithCategory('MERCHANT TWO', coffee, 'bayes');
    const result = await acceptAllGuessesAction({}, formData({ ids: `${a},${b}` }));
    expect(result.message).toBe('Accepted 2 suggestions.');
    const rows = sqlite
      .prepare('select category_id as c, categorization_source as s from transactions where id in (?, ?)')
      .all(a, b) as { c: number; s: string }[];
    expect(rows.every((row) => row.c === coffee && row.s === 'manual')).toBe(true);
  });

  it('reports the singular sentence for exactly one id', async () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = addTxnWithCategory('MERCHANT SOLO', coffee, 'bayes');
    const result = await acceptAllGuessesAction({}, formData({ ids: String(a) }));
    expect(result.message).toBe('Accepted 1 suggestion.');
  });

  it('errors on an empty id list instead of silently accepting nothing', async () => {
    setup();
    const result = await acceptAllGuessesAction({}, formData({ ids: '' }));
    expect(result.error).toBe('Nothing to accept.');
  });

  it('checks the origin before anything else', async () => {
    setup();
    sameOrigin.value = false;
    const result = await acceptAllGuessesAction({}, formData({ ids: '1' }));
    expect(result.error).toBe(CROSS_ORIGIN_ERROR);
  });

  it('refuses a self-scoped viewer, byte-identical to the review-page guard, and writes nothing', async () => {
    const { db, sqlite } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = addTxnWithCategory('MERCHANT SELF', coffee, 'bayes');
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await acceptAllGuessesAction({}, formData({ ids: String(a) }));
    expect(result.error).toBe('Review is not available on this account.');
    const row = sqlite.prepare('select categorization_source as s from transactions where id = ?').get(a) as { s: string };
    expect(row.s).toBe('bayes');
  });

  it('errors when a row has no guess to accept -- the same guard acceptGuessAction enforces on its own', async () => {
    const { addTxn } = setup();
    const id = addTxn();
    const result = await acceptAllGuessesAction({}, formData({ ids: String(id) }));
    expect(result.error).toBe('There is no guess to accept on that row.');
  });

  it('stops at the first refusal, keeps what already succeeded, and never touches the rows after it', async () => {
    const { db, sqlite } = setup();
    const bob = insertTestUser(db, { name: 'Bob', username: 'bob', role: 'member' });
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    // Bob owns MERCHANT TWO's rule already -- the one row in the batch a member cannot accept.
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('MERCHANT TWO'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: bob,
      actorRole: 'member',
    });
    const a = addTxnWithCategory('MERCHANT ONE', coffee, 'bayes');
    const b = addTxnWithCategory('MERCHANT TWO', coffee, 'bayes');
    const c = addTxnWithCategory('MERCHANT THREE', coffee, 'bayes');
    currentUser = { ...currentUser, role: 'member' };

    const result = await acceptAllGuessesAction({}, formData({ ids: `${a},${b},${c}` }));

    expect(result.error).toBe(`Accepted 1 suggestion before stopping. ${ruleOwnedError('Bob')}`);
    expect(result.message).toBeUndefined();
    const row = (id: number) =>
      sqlite.prepare('select category_id as c, categorization_source as s from transactions where id = ?').get(id) as {
        c: number;
        s: string;
      };
    expect(row(a)).toEqual({ c: coffee, s: 'manual' }); // accepted before the refusal
    expect(row(b)).toEqual({ c: coffee, s: 'bayes' }); // the refusal itself changed nothing
    expect(row(c)).toEqual({ c: coffee, s: 'bayes' }); // never reached
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

  /**
   * v1.14.1 fix round: the ported guard refused every self-scoped viewer with the review page's
   * own sentence. As a per-row control offered on EVERY row that was both wrong and confusing --
   * bulkTransferAction already lets a self viewer flip their own rows. These two pin the model
   * this action now shares with it: scoped by visibility, not by a blanket refusal.
   */
  it('refuses a self-scoped viewer a row that is not theirs, and writes nothing', async () => {
    const { sqlite, addTxn } = setup();
    const id = addTxn();
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await setRowTransferAction({}, formData({ transactionId: String(id), isTransfer: '1' }));
    expect(result.error).toBe(NOT_YOURS_ERROR);
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(id) as { is_transfer: number };
    expect(row.is_transfer).toBe(0);
  });

  it('lets a self-scoped viewer flip a row attributed to them, exactly as the bulk toolbar does', async () => {
    const { db, sqlite, accountId, userId } = setup();
    const own = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'E-TRANSFER OWN', ${normalizeMerchant('E-TRANSFER OWN')}, -2500, ${userId}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };
    const result = await setRowTransferAction({}, formData({ transactionId: String(own), isTransfer: '1' }));
    expect(result.error).toBeUndefined();
    const row = sqlite.prepare('select is_transfer from transactions where id = ?').get(own) as { is_transfer: number };
    expect(row.is_transfer).toBe(1);
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

/**
 * v1.26.0 Lane 3a item 4. The two group bulk actions.
 *
 * The property every test here is really about: a group header states
 * `CategoryGroupRow.count`, which is the cluster's FULL size across every row page, so the write
 * behind it must reach the same set. The fixture is deliberately 60 rows against a 50-row page --
 * anything that can only see one rendered page of rows fails these, which is the exact failure the
 * dialog's own copy would otherwise be lying about.
 */
describe('bulkConfirmGroupAction / bulkRecategorizeGroupAction (Lane 3a item 4)', () => {
  /** One import, so `?import=` in the posted scope has something to select and something to
   *  exclude. */
  function seedImport(filename: string): number {
    const { accountId, userId } = ctx!;
    return current!.db.get<{ id: number }>(sql`
      insert into imports (account_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
      values (${accountId}, ${filename}, ${userId}, 0, 0, 0, ${nowIso()})
      returning id`).id;
  }

  function addRuleRow(opts: {
    importId: number;
    categoryId: number | null;
    merchant: string;
    amountCents?: number;
    source?: 'rule' | 'manual' | 'none';
  }): number {
    const { accountId, userId } = ctx!;
    return current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${opts.importId}, '2026-03-02', ${opts.merchant}, ${normalizeMerchant(opts.merchant)},
              ${opts.amountCents ?? -1000}, ${opts.categoryId}, ${opts.source ?? 'rule'}, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  }

  function sourceOf(id: number): string {
    return (
      current!.sqlite.prepare('select categorization_source as s from transactions where id = ?').get(id) as { s: string }
    ).s;
  }

  function categoryOf(id: number): number | null {
    return (
      current!.sqlite.prepare('select category_id as c from transactions where id = ?').get(id) as { c: number | null }
    ).c;
  }

  it('confirms EVERY row in the group, not only the 50 one row page could show', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');
    // 60 > the 50-row page listTransactions serves this page with, and > any single rendered page.
    const ids = Array.from({ length: 60 }, (_, index) =>
      addRuleRow({ importId, categoryId: groceries, merchant: `GREENFIELD ${index}` }),
    );

    const result = await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${importId}&source=rule&group=category`, groupCategoryId: String(groceries) }),
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toContain('Confirmed 60 transactions');
    expect(ids.every((id) => sourceOf(id) === 'manual')).toBe(true);
    // The category itself is untouched -- confirming is about locking the row, not moving it.
    expect(categoryOf(ids[0])).toBe(groceries);
  });

  it('honours the posted filter: another cluster, and another import, are left alone', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const march = seedImport('march.csv');
    const april = seedImport('april.csv');
    const target = addRuleRow({ importId: march, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
    const otherCluster = addRuleRow({ importId: march, categoryId: coffee, merchant: 'HARBOUR ROAST' });
    const otherImport = addRuleRow({ importId: april, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
    const byHand = addRuleRow({ importId: march, categoryId: groceries, merchant: 'BY HAND SHOP', source: 'manual' });

    const result = await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${march}&source=rule&group=category`, groupCategoryId: String(groceries) }),
    );

    expect(result.message).toContain('Confirmed 1 transaction');
    expect(sourceOf(target)).toBe('manual');
    expect(sourceOf(otherCluster)).toBe('rule');
    expect(sourceOf(otherImport)).toBe('rule');
    // Already 'manual', excluded by ?source=rule -- and untouched either way.
    expect(sourceOf(byHand)).toBe('manual');
  });

  it('creates no merchant rule -- a confirmation says the existing category is right, nothing more', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');
    addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });

    await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${importId}&source=rule`, groupCategoryId: String(groceries) }),
    );

    expect(listRules('category')).toEqual([]);
  });

  it('refuses the uncategorized cluster -- there is no category there to confirm', async () => {
    setup();
    const importId = seedImport('march.csv');
    const id = addRuleRow({ importId, categoryId: null, merchant: 'UNKNOWN SHOP', source: 'none' });

    const result = await bulkConfirmGroupAction({}, formData({ scope: `import=${importId}`, groupCategoryId: '' }));

    expect(result.error).toBeTruthy();
    expect(result.message).toBeUndefined();
    expect(sourceOf(id)).toBe('none');
  });

  it('reports honestly when the group has emptied out from under the dialog', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');

    const result = await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${importId}&source=rule`, groupCategoryId: String(groceries) }),
    );

    expect(result.error).toContain('empty');
  });

  it('refuses a cross-origin post before reading anything', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');
    const id = addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
    sameOrigin.value = false;

    const confirm = await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${importId}`, groupCategoryId: String(groceries) }),
    );
    const recategorize = await bulkRecategorizeGroupAction(
      {},
      formData({ scope: `import=${importId}`, groupCategoryId: String(groceries), categoryId: String(groceries) }),
    );

    expect(confirm.error).toBe(CROSS_ORIGIN_ERROR);
    expect(recategorize.error).toBe(CROSS_ORIGIN_ERROR);
    expect(sourceOf(id)).toBe('rule');
  });

  it('moves EVERY row in the group to the chosen category, not only a rendered page of them', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const importId = seedImport('march.csv');
    const ids = Array.from({ length: 60 }, (_, index) =>
      addRuleRow({ importId, categoryId: groceries, merchant: `GREENFIELD ${index}` }),
    );

    const result = await bulkRecategorizeGroupAction(
      {},
      formData({
        scope: `import=${importId}&source=rule&group=category`,
        groupCategoryId: String(groceries),
        categoryId: String(coffee),
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.message).toContain('Moved 60 transactions');
    expect(ids.every((id) => categoryOf(id) === coffee)).toBe(true);
    expect(ids.every((id) => sourceOf(id) === 'manual')).toBe(true);
  });

  it('moves the uncategorized cluster too -- everything the rules had no opinion about, in one go', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');
    const blank = addRuleRow({ importId, categoryId: null, merchant: 'UNKNOWN SHOP', source: 'none' });
    const filed = addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });

    const result = await bulkRecategorizeGroupAction(
      {},
      formData({ scope: `import=${importId}`, groupCategoryId: '', categoryId: String(groceries) }),
    );

    expect(result.message).toContain('Moved 1 transaction');
    expect(categoryOf(blank)).toBe(groceries);
    // The already-filed row is a different cluster and was never in scope.
    expect(sourceOf(filed)).toBe('rule');
  });

  it('teaches a rule only when the checkbox was ticked', async () => {
    const { db } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const importId = seedImport('march.csv');
    addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });

    const untaught = await bulkRecategorizeGroupAction(
      {},
      formData({ scope: `import=${importId}`, groupCategoryId: String(groceries), categoryId: String(coffee) }),
    );
    expect(untaught.message).toBeTruthy();
    expect(listRules('category')).toEqual([]);

    addRuleRow({ importId, categoryId: groceries, merchant: 'OTHER MARKET' });
    const taught = await bulkRecategorizeGroupAction(
      {},
      formData({
        scope: `import=${importId}`,
        groupCategoryId: String(groceries),
        categoryId: String(coffee),
        createRules: 'on',
      }),
    );
    expect(taught.message).toBeTruthy();
    expect(listRules('category').map((rule) => rule.pattern)).toContain('OTHER MARKET');
  });

  it('skips a split transaction in the cluster and says how many were skipped', async () => {
    const { db, userId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const coffee = categoryIdByName(db, 'Coffee');
    const gas = categoryIdByName(db, 'Gas');
    const importId = seedImport('march.csv');
    const plain = addRuleRow({ importId, categoryId: groceries, merchant: 'GREENFIELD MARKET' });
    // A split row with one PART in Groceries: categoryMatchClause selects a split transaction on
    // its parts (src/lib/transactions.ts), so this row really is in the Groceries cluster and
    // really is swept into the ids -- which is what makes the skip worth asserting rather than
    // assuming.
    const split = addRuleRow({ importId, categoryId: null, merchant: 'SPLIT SHOP', amountCents: -10000, source: 'none' });
    setTransactionSplits({
      txnId: split,
      parts: [
        { categoryId: groceries, amountCents: -7000 },
        { categoryId: gas, amountCents: -3000 },
      ],
      userId,
    });

    const result = await bulkRecategorizeGroupAction(
      {},
      formData({ scope: `import=${importId}`, groupCategoryId: String(groceries), categoryId: String(coffee) }),
    );

    expect(result.message).toContain('Moved 1 transaction');
    expect(result.message).toContain('1 split transaction was skipped');
    expect(categoryOf(plain)).toBe(coffee);
    // The split row's own parts are untouched, which is the whole point of the skip.
    expect(
      current!.sqlite.prepare('select count(*) as c from transaction_splits where txn_id = ?').get(split),
    ).toEqual({ c: 2 });
  });

  it('cannot be widened past a self viewer’s own rows by a tampered scope', async () => {
    const { db, accountId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const importId = seedImport('march.csv');
    const other = insertTestUser(db, { name: 'Robin', username: 'robin', role: 'member' });
    const mine = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, ${importId}, '2026-03-02', 'MINE', 'MINE', -100, ${groceries}, 'rule', ${currentUser.id}, ${currentUser.id}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    const theirs = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents, category_id, categorization_source, attributed_user_id, created_by, created_at, updated_at)
      values (${accountId}, ${importId}, '2026-03-02', 'THEIRS', 'THEIRS', -200, ${groceries}, 'rule', ${other}, ${currentUser.id}, ${nowIso()}, ${nowIso()})
      returning id`).id;
    // A self-scoped MEMBER: ownerScope (src/lib/auth/viewer.ts) is `visibility === 'self' && role
    // !== 'admin'`, so an admin is never scoped down whatever their visibility says -- setting only
    // `visibility` here would have tested a household viewer and passed for the wrong reason.
    currentUser = { ...currentUser, role: 'member', visibility: 'self' };

    // The posted scope asks for the OTHER person's rows. readFilter forces a self viewer's own id
    // over any `?person=` (ruling R2), and listTransactions applies ownerScope on top, so the
    // sweep can only ever return rows this viewer already owns.
    const result = await bulkConfirmGroupAction(
      {},
      formData({ scope: `import=${importId}&person=${other}`, groupCategoryId: String(groceries) }),
    );

    expect(result.message).toContain('Confirmed 1 transaction');
    expect(sourceOf(mine)).toBe('manual');
    expect(sourceOf(theirs)).toBe('rule');
  });
});
