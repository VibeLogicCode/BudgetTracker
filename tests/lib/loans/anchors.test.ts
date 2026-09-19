import { describe, it, expect, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { listItemTypes } from '@/lib/warranty/types';
import { createWarrantyItem } from '@/lib/warranty/items';
import { createManualTransaction } from '@/lib/transactions';
import {
  assignTransactionToLoan,
  unassignTransactionFromLoan,
  listLoanAnchors,
  retractLoanAnchor,
  setLoanAnchor,
} from '@/lib/loans';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const loanTypeId = (): number => listItemTypes().find((type) => type.kind === 'loan')!.id;

function makeLoan(over: Record<string, unknown> = {}): { itemId: number; user: number; accountId: number } {
  current = createSeededTestDb();
  const user = insertTestUser(current.db, { role: 'admin' });
  const accountId = insertTestAccount(current.db, { name: 'Chequing' });
  const itemId = createWarrantyItem({
    name: 'Mortgage',
    vendor: null,
    model: null,
    serial: null,
    purchaseDate: '2026-01-01',
    warrantyMonths: null,
    isLifetime: false,
    priceCents: null,
    ownerUserId: user,
    transactionId: null,
    typeId: loanTypeId(),
    notes: null,
    ...over,
  } as Parameters<typeof createWarrantyItem>[0]);
  return { itemId, user, accountId };
}

function pay(accountId: number, user: number, date: string, amountCents: number): number {
  return createManualTransaction({
    accountId,
    date,
    description: 'MORTGAGE PAYMENT',
    amountCents,
    categoryId: null,
    attributedUserId: user,
    userId: user,
    actorRole: 'admin',
  });
}

const balanceOf = (itemId: number): number =>
  (current!.sqlite.prepare('select current_balance_cents as b from warranty_items where id = ?').get(itemId) as { b: number }).b;

const appliedFor = (txnId: number): number =>
  (current!.sqlite.prepare('select applied_cents as a from loan_payments where txn_id = ?').get(txnId) as { a: number }).a;

/**
 * Ruling R2: setLoanAnchor is the ONLY code path that writes a human balance. It appends to
 * loan_anchors, sets balance_updated_at to the STATEMENT's date (not the day of typing, which is
 * what the old anchor recorded), and replays the confirmed figure forward through the movements
 * linked after it.
 */
describe('setLoanAnchor: the one writer', () => {
  it('records the figure and the date the statement was true as of', () => {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_031_000, source: 'reconcile', actorUserId: user });
    const [anchor] = listLoanAnchors(itemId);
    expect(anchor!.asOfDate).toBe('2026-09-01');
    expect(anchor!.balanceCents).toBe(20_031_000);
    expect(anchor!.source).toBe('reconcile');
  });

  /** The old anchor recorded the day of TYPING, so a statement entered late moved the balance late. */
  it('sets the cached anchor date to the statement date, not today', () => {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_031_000, source: 'reconcile', actorUserId: user });
    const row = current!.sqlite
      .prepare('select balance_updated_at as at from warranty_items where id = ?')
      .get(itemId) as { at: string };
    expect(row.at.slice(0, 10)).toBe('2026-09-01');
  });

  it('caches the confirmed figure as the current balance when nothing is linked after it', () => {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_031_000, source: 'reconcile', actorUserId: user });
    expect(balanceOf(itemId)).toBe(20_031_000);
  });

  /** Correcting a statement is a SECOND row, never an edit (ruling R8). */
  it('appends rather than replacing, even for the same date', () => {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_031_000, source: 'reconcile', actorUserId: user });
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_030_000, source: 'reconcile', actorUserId: user });
    expect(listLoanAnchors(itemId)).toHaveLength(2);
  });

  it('keeps the newest row as the one the cache reflects', () => {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-08-01', balanceCents: 21_000_000, source: 'reconcile', actorUserId: user });
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_031_000, source: 'reconcile', actorUserId: user });
    expect(balanceOf(itemId)).toBe(20_031_000);
  });

  /**
   * The comparison columns, computed at write time. difference_cents is arithmetic on two knowns,
   * so it is a FACT -- but what caused it is not stored and not guessed (ruling R4).
   */
  it('records what the app believed, and by how much the statement differed', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-08-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: pay(accountId, user, '2026-08-15', -100_000), itemId });
    // The app now believes $199,000. The statement says $199,037.
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 19_903_700, source: 'reconcile', actorUserId: user });
    const anchors = listLoanAnchors(itemId);
    const newest = anchors[anchors.length - 1]!;
    expect(newest.appBalanceCents).toBe(19_900_000);
    expect(newest.differenceCents).toBe(3_700);
    expect(newest.paymentsBetweenCents).toBe(-100_000);
  });
});

/**
 * THE WALL, ruling R5. A statement figure already contains every movement up to its date, so a
 * payment dated on or before it must not move the balance a second time. It is recorded with
 * applied_cents = 0 -- the existing "recorded, not moved" convention -- which also makes reversing
 * or deleting it a no-op, so the undo paths needed no change at all.
 */
describe('the wall: movements already inside the confirmed figure', () => {
  it('records a payment dated before the statement without moving the balance', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    const txnId = pay(accountId, user, '2026-08-20', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(appliedFor(txnId)).toBe(0);
    expect(balanceOf(itemId)).toBe(20_000_000);
  });

  /** A statement figure is end-of-day, so the statement's own date is inside it. */
  it('walls off a payment dated exactly on the statement date', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    const txnId = pay(accountId, user, '2026-09-01', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(appliedFor(txnId)).toBe(0);
    expect(balanceOf(itemId)).toBe(20_000_000);
  });

  it('applies a payment dated after the statement in full', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    const txnId = pay(accountId, user, '2026-09-02', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(appliedFor(txnId)).toBe(100_000);
    expect(balanceOf(itemId)).toBe(19_900_000);
  });

  /**
   * This is what the wall buys, and why MUST-13.16 needed no change: removing a walled payment
   * restores 0, which is a no-op. It retires the old hint that removing an old payment could push
   * the balance above the statement figure.
   */
  it('unassigning a walled payment leaves the balance exactly where it was', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    const txnId = pay(accountId, user, '2026-08-20', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    unassignTransactionFromLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(balanceOf(itemId)).toBe(20_000_000);
  });

  /** A later statement moves the wall forward, so what was live becomes history. */
  it('moves the wall when a newer statement is confirmed', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-08-01', balanceCents: 20_000_000, source: 'reconcile', actorUserId: user });
    const txnId = pay(accountId, user, '2026-08-20', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(appliedFor(txnId)).toBe(100_000);

    setLoanAnchor({ itemId, asOfDate: '2026-09-01', balanceCents: 19_900_000, source: 'reconcile', actorUserId: user });
    expect(appliedFor(txnId)).toBe(0);
    expect(balanceOf(itemId)).toBe(19_900_000);
  });
});

/**
 * Review A3. A statement typed with the wrong year used to be unrecoverable through the app: the
 * newest as_of_date governs, the table is append-only, and the correct statement is older, so
 * entering it afterwards never wins.
 */
describe('withdrawing a statement', () => {
  function withTypo(): { itemId: number; user: number; typoId: number } {
    const { itemId, user } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-07-01', balanceCents: 20_000_000, source: 'form', actorUserId: user });
    setLoanAnchor({ itemId, asOfDate: '2027-06-01', balanceCents: 50_000_000, source: 'reconcile', actorUserId: user });
    const typoId = listLoanAnchors(itemId).find((row) => row.asOfDate === '2027-06-01')!.id;
    return { itemId, user, typoId };
  }

  it('puts the balance back to the statement before it', () => {
    const { itemId, user, typoId } = withTypo();
    expect(balanceOf(itemId)).toBe(50_000_000);
    expect(retractLoanAnchor({ anchorId: typoId, actorUserId: user })).toBe(true);
    expect(balanceOf(itemId)).toBe(20_000_000);
  });

  /** Withdrawn, not deleted: the reconciliation history is a record of what somebody saw. */
  it('keeps the row in the history, marked', () => {
    const { itemId, user, typoId } = withTypo();
    retractLoanAnchor({ anchorId: typoId, actorUserId: user });
    const anchors = listLoanAnchors(itemId);
    expect(anchors).toHaveLength(2);
    expect(anchors.find((row) => row.id === typoId)!.retractedAt).not.toBeNull();
    expect(anchors.find((row) => row.asOfDate === '2026-07-01')!.retractedAt).toBeNull();
  });

  /** Payments linked after the statement that now governs are replayed over it again. */
  it('replays the movements the withdrawn statement had walled off', () => {
    const { itemId, user, accountId } = makeLoan();
    setLoanAnchor({ itemId, asOfDate: '2026-07-01', balanceCents: 20_000_000, source: 'form', actorUserId: user });
    const txnId = pay(accountId, user, '2026-08-15', -100_000);
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId });
    expect(balanceOf(itemId)).toBe(19_900_000);

    setLoanAnchor({ itemId, asOfDate: '2027-06-01', balanceCents: 50_000_000, source: 'reconcile', actorUserId: user });
    const typoId = listLoanAnchors(itemId).find((row) => row.asOfDate === '2027-06-01')!.id;
    expect(balanceOf(itemId)).toBe(50_000_000);

    retractLoanAnchor({ anchorId: typoId, actorUserId: user });
    expect(balanceOf(itemId)).toBe(19_900_000);
  });

  it('refuses to withdraw the same statement twice', () => {
    const { user, typoId } = withTypo();
    expect(retractLoanAnchor({ anchorId: typoId, actorUserId: user })).toBe(true);
    expect(retractLoanAnchor({ anchorId: typoId, actorUserId: user })).toBe(false);
  });

  it('is false for a statement that does not exist', () => {
    makeLoan();
    expect(retractLoanAnchor({ anchorId: 9_999, actorUserId: null })).toBe(false);
  });
});
