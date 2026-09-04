import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  applyPaymentMatchers,
  assignTransactionToLoan,
  recomputeLoanBalance,
  restoreLoanDescription,
  saveLoanRule,
  unassignTransactionFromLoan,
} from '@/lib/loans';
import { applyRenameRules, setTransactionDisplayName, upsertRenameRule } from '@/lib/categorize/engine';
import { addInstallment } from '@/lib/warranty/installments';
import { setupLoanTest } from './fixtures';

const NOW = '2026-06-01T12:00:00.000Z';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * A bill item with one unpaid installment and a matcher rule, a loan item with a balance, and one
 * transaction that the bill rule matches (item T / MON-2, ruling P4). Also a second loan item (for
 * MUST-11.16) and one unrelated transaction the bill rule does not touch.
 */
function setup() {
  current = createSeededTestDb();
  const db = current.db;
  const userId = insertTestUser(db, { username: 'payer' });
  const accountId = insertTestAccount(db, { name: 'Chequing' });

  const billTypeId = db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values ('Property tax', 0, 'bill', ${NOW}) returning id`,
  )!.id;
  const billItemId = db.get<{ id: number }>(
    sql`insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
        values ('City property tax', '2024-01-15', 0, ${userId}, ${billTypeId}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const installmentId = addInstallment({ itemId: billItemId, dueDate: '2026-06-15', amountCents: 120_000, at: NOW });
  saveLoanRule({ itemId: billItemId, merchantContains: 'CITY TAX OFFICE', accountId: null, enabled: true });

  const loanTypeId = db.get<{ id: number }>(
    sql`insert into warranty_item_types (name, is_subscription, kind, created_at)
        values ('Car loan', 0, 'loan', ${NOW}) returning id`,
  )!.id;
  const loanItemId = db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
        values ('Civic', '2024-01-15', 0, ${userId}, ${loanTypeId}, 2000000, 1800000, ${NOW}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const secondLoanItemId = db.get<{ id: number }>(
    sql`insert into warranty_items
          (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
        values ('Truck', '2024-01-15', 0, ${userId}, ${loanTypeId}, 3000000, 2500000, ${NOW}, ${NOW}, ${NOW}) returning id`,
  )!.id;

  const txnId = db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
        values (${accountId}, '2026-06-14', 'CITY TAX OFFICE', 'CITY TAX OFFICE', -120000, 0, ${userId}, ${NOW}, ${NOW}) returning id`,
  )!.id;
  const unrelatedTxnId = db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
        values (${accountId}, '2026-06-10', 'GROCERY STORE', 'GROCERY STORE', -5000, 0, ${userId}, ${NOW}, ${NOW}) returning id`,
  )!.id;

  return { txnId, loanItemId, secondLoanItemId, unrelatedTxnId, installmentId, db };
}

describe('a transaction cannot pay a bill and a loan (item T / MON-2, ruling P4)', () => {
  it('refuses the manual assign, by name, and does not move the loan balance', () => {
    const { txnId, loanItemId, db } = setup();
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    expect(db.get<{ paid: number | null }>(sql`select paid_txn_id as paid from bill_installments limit 1`).paid).toBe(
      txnId,
    );
    const before = db.get<{ b: number }>(
      sql`select current_balance_cents as b from warranty_items where id = ${loanItemId}`,
    ).b;

    expect(() => assignTransactionToLoan({ txnId, itemId: loanItemId })).toThrow(/already pays a bill installment/);

    expect(
      db.get<{ b: number }>(sql`select current_balance_cents as b from warranty_items where id = ${loanItemId}`).b,
    ).toBe(before);
  });

  it('still allows a manual assign for a transaction that pays no bill', () => {
    const { loanItemId, unrelatedTxnId } = setup();
    const result = assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: loanItemId });
    expect(result.linked).toBe(true);
  });

  it('still allows a SECOND loan on one transaction — MUST-11.16, a combined payment is legitimate', () => {
    const { unrelatedTxnId, loanItemId, secondLoanItemId } = setup();
    assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: loanItemId });
    expect(assignTransactionToLoan({ txnId: unrelatedTxnId, itemId: secondLoanItemId }).linked).toBe(true);
  });
});

describe('assignTransactionToLoan on a lent loan (spec BU)', () => {
  let ctx: ReturnType<typeof setupLoanTest>;
  afterEach(() => ctx?.t.cleanup());

  it('money OUT raises the balance and money IN lowers it', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 0, direction: 'lent' });

    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(50_000);

    const repayment = ctx.spend('E TRANSFER', 20_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 20_000 });
    expect(ctx.balanceOf(itemId)).toBe(30_000);
  });

  /**
   * Item 6 (v1.21.0 backlog): still exactly correct, and left UNCHANGED by the backlog's fix --
   * this is a single, isolated repayment against a KNOWN outstanding balance, with nothing else
   * on record for the loan. That is a genuinely ordinary clamp (the loan owes less than the
   * repayment covers), not the insertion-order defect item 6 traced: link() has nothing to
   * replay here except this one row, so recomputeBalance's chronological replay degenerates to
   * exactly this same arithmetic. See the test right below for the shape that DID change.
   */
  it('a repayment larger than the outstanding balance clamps at zero, never below', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 30_000, direction: 'lent' });
    const repayment = ctx.spend('E TRANSFER', 50_000);
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 30_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
  });

  /**
   * Item 6 (v1.21.0 backlog): the exact defect a read-only trace confirmed. The OLD link()
   * clamped a repayment against whatever current_balance_cents held AT THE MOMENT it was linked
   * -- which depended on which payment a person happened to link FIRST, not on when either
   * transaction actually happened. This reproduces the reported shape (a "lent" loan: $6,000 out,
   * $6,000 back, and a further $11.29 charge) LINKED IN THE WRONG ORDER -- chronologically last
   * first, chronologically first last -- and shows the balance lands on the correct $11.29
   * regardless, because link() now replays every payment in the order its TRANSACTION happened
   * (recomputeBalance), not the order it was linked. Before this fix, this exact sequence
   * displayed $6,000.00 -- the household's actual reported bug -- with $5,988.71 silently and
   * permanently unrecoverable.
   */
  it('item 6: linking a repayment before the growth that justifies it no longer loses the excess', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });

    // Chronologically: $6,000 lent out (day 1), $6,000 repaid (day 2), a further $11.29 charge
    // (day 3) -- but LINKED in the opposite order (day 3's small charge first, then day 2's
    // repayment, then day 1's disbursement last), exactly the shape that used to corrupt the
    // stored balance.
    const smallCharge = ctx.spend('E TRANSFER', -1_129, { date: '2026-08-03' });
    const repayment = ctx.spend('E TRANSFER', 600_000, { date: '2026-08-02' });
    const disbursement = ctx.spend('E TRANSFER', -600_000, { date: '2026-08-01' });

    expect(assignTransactionToLoan({ txnId: smallCharge, itemId })).toEqual({ linked: true, appliedCents: 1_129 });
    expect(ctx.balanceOf(itemId)).toBe(1_129);

    // Linked before its own growth exists on record: clamps to 0, exactly as the old code would
    // have too -- the fix is not that THIS call sees more room, it is that the LATER link below
    // fixes this row up without anyone having to notice or ask.
    expect(assignTransactionToLoan({ txnId: repayment, itemId })).toEqual({ linked: true, appliedCents: 0 });
    expect(ctx.balanceOf(itemId)).toBe(1_129);

    // The disbursement arrives LAST in link order but is dated FIRST -- replaying chronologically
    // now gives the repayment $600,000 of room to consume, correcting its own stored applied_cents
    // from 0 up to 600,000 in the same call, with no unlink/re-link step required.
    expect(assignTransactionToLoan({ txnId: disbursement, itemId })).toEqual({ linked: true, appliedCents: 600_000 });
    expect(ctx.balanceOf(itemId)).toBe(1_129);
  });

  it('an UNKNOWN balance still applies nothing in either direction (NEW-2, unchanged)', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: null, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    expect(assignTransactionToLoan({ txnId: advance, itemId })).toEqual({ linked: true, appliedCents: 0 });
    expect(ctx.balanceOf(itemId)).toBeNull();
  });

  it('an owed loan is untouched: money OUT still pays it down', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000);
    expect(assignTransactionToLoan({ txnId: payment, itemId })).toEqual({ linked: true, appliedCents: 50_000 });
    expect(ctx.balanceOf(itemId)).toBe(150_000);
  });
});

describe('recomputeLoanBalance (item 6, v1.21.0 backlog: the repair action)', () => {
  let ctx: ReturnType<typeof setupLoanTest>;
  afterEach(() => ctx?.t.cleanup());

  /**
   * Fixes a loan already corrupted BEFORE this fix shipped -- the household's own reported case,
   * seeded directly (not through assignTransactionToLoan) so the test does not rely on link()'s
   * own self-healing to prove the SEPARATE, on-demand repair action also works. The three
   * loan_payments rows and the anchor below are exactly the backlog's own worked example:
   * a $11.29 growth linked first (clamps nothing), a $6,000 repayment linked second (wrongly
   * clamped to the $11.29 that existed at that moment), a $6,000 growth linked third (unclamped) --
   * landing on a displayed balance of $6,000.00 when the true figure is $11.29.
   */
  it('recovers the true balance from a loan that had no reason to get a new link soon', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 600_000, direction: 'lent' });

    const bigGrowth = ctx.spend('E TRANSFER', -600_000, { date: '2026-08-01' });
    const repayment = ctx.spend('E TRANSFER', 600_000, { date: '2026-08-02' });
    const smallGrowth = ctx.spend('E TRANSFER', -1_129, { date: '2026-08-03' });

    for (const [txnId, amountCents, appliedCents] of [
      [smallGrowth, 1_129, 1_129],
      [repayment, 600_000, 1_129],
      [bigGrowth, 600_000, 600_000],
    ] as const) {
      ctx.t.sqlite
        .prepare(
          `insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
           values (?, ?, ?, ?, 'manual', ?)`,
        )
        .run(txnId, itemId, amountCents, appliedCents, '2026-08-18T12:00:00.000Z');
    }
    expect(ctx.balanceOf(itemId)).toBe(600_000); // the corrupted, displayed figure

    expect(recomputeLoanBalance(itemId)).toEqual({ balanceCents: 1_129 });
    expect(ctx.balanceOf(itemId)).toBe(1_129);
  });

  it('refuses a loan with no balance being tracked -- there is nothing to recompute', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: null });
    expect(() => recomputeLoanBalance(itemId)).toThrow(/no balance being tracked/);
  });

  it('refuses an item that no longer exists', () => {
    ctx = setupLoanTest();
    expect(() => recomputeLoanBalance(999_999)).toThrow(/no longer exists/);
  });

  it('unassign stays simple: it does not itself trigger a replay (Task 10 carry (a) is untouched)', () => {
    // Documents the deliberate asymmetry recomputeBalance's own docblock argues: unassign still
    // clamps its own single-row restore, exactly as before this fix, and is pinned by
    // tests/lib/loans/debt-over-time.test.ts's "Task 10 carry (a)" documented drift test -- this
    // is not that test, just confirmation that unassigning does not silently start replaying.
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const advance = ctx.spend('E TRANSFER', -50_000);
    assignTransactionToLoan({ txnId: advance, itemId });
    expect(ctx.balanceOf(itemId)).toBe(50_000);
    expect(unassignTransactionFromLoan({ txnId: advance, itemId })).toBe(true);
    expect(ctx.balanceOf(itemId)).toBe(0);
  });
});

describe('item 13 (v1.21.0 backlog): the row is labelled for what it is', () => {
  let ctx: ReturnType<typeof setupLoanTest>;
  afterEach(() => ctx?.t.cleanup());

  function displaySourceOf(txnId: number): { displayDescription: string | null; displaySource: string | null } {
    return ctx.t.sqlite
      .prepare('select display_description as displayDescription, display_source as displaySource from transactions where id = ?')
      .get(txnId) as { displayDescription: string | null; displaySource: string | null };
  }

  it('labels a "lent" loan\'s growth as "Loan to <name>" and its repayment as "Repayment from <name>"', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Loan to a friend', balanceCents: 0, direction: 'lent' });

    const advance = ctx.spend('E TRANSFER', -50_000);
    assignTransactionToLoan({ txnId: advance, itemId });
    expect(displaySourceOf(advance)).toEqual({ displayDescription: 'Loan to Loan to a friend', displaySource: 'loan' });

    const repayment = ctx.spend('E TRANSFER', 20_000);
    assignTransactionToLoan({ txnId: repayment, itemId });
    expect(displaySourceOf(repayment)).toEqual({ displayDescription: 'Repayment from Loan to a friend', displaySource: 'loan' });
  });

  it('never overwrites a row a person renamed by hand (display_source = manual)', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Civic', balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000);
    ctx.t.sqlite
      .prepare("update transactions set display_description = 'My own name', display_source = 'manual' where id = ?")
      .run(payment);

    assignTransactionToLoan({ txnId: payment, itemId });
    expect(displaySourceOf(payment)).toEqual({ displayDescription: 'My own name', displaySource: 'manual' });
  });

  it('reverts the label on unassign, exactly as deleting a rename rule does -- but leaves a manual row alone', () => {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Civic', balanceCents: 200_000 });
    const payment = ctx.spend('CAR LOAN', -50_000);

    assignTransactionToLoan({ txnId: payment, itemId });
    expect(displaySourceOf(payment).displaySource).toBe('loan');
    unassignTransactionFromLoan({ txnId: payment, itemId });
    expect(displaySourceOf(payment)).toEqual({ displayDescription: null, displaySource: null });

    // A manual row is never touched in the first place, so unassigning it is a no-op for the
    // label too -- there is nothing for revertLoanDescription to revert.
    const second = ctx.spend('CAR LOAN', -60_000);
    ctx.t.sqlite
      .prepare("update transactions set display_description = 'My own name', display_source = 'manual' where id = ?")
      .run(second);
    assignTransactionToLoan({ txnId: second, itemId });
    unassignTransactionFromLoan({ txnId: second, itemId });
    expect(displaySourceOf(second)).toEqual({ displayDescription: 'My own name', displaySource: 'manual' });
  });
});

/**
 * v1.31.0 finding B-1, the release blocker: the THIRD writer of display_description
 * (setTransactionDisplayName, src/lib/categorize/engine.ts) consulted the precedence module on
 * neither of its paths, and its clear branch nulled both columns unconditionally. The reproduction
 * below is the reviewer's, against a seeded database: link a loan, empty the rename dialog on that
 * row, and the loan label was replaced by the merchant name -- then unlinking repaired nothing,
 * because revertLoanDescription only clears a row still labelled 'loan'.
 */
describe('B-1: clearing a hand-typed name hands the row down the precedence order, not to the rules', () => {
  let ctx: ReturnType<typeof setupLoanTest>;
  afterEach(() => ctx?.t.cleanup());

  function labelOf(txnId: number): { text: string | null; source: string | null } {
    return ctx.t.sqlite
      .prepare('select display_description as text, display_source as source from transactions where id = ?')
      .get(txnId) as { text: string | null; source: string | null };
  }

  /** A loan-linked WALMART payment that a rename rule also matches -- both claims live at once. */
  function contested(): { txnId: number; itemId: number } {
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Car Loan', balanceCents: 2_000_000 });
    const txnId = ctx.spend('WALMART', -50_000);
    const rule = upsertRenameRule({
      pattern: 'WALMART',
      matchType: 'contains',
      renameTo: 'Walmart',
      userId: ctx.userId,
      actorRole: 'admin',
    });
    if (!rule.ok) throw new Error('unexpected refusal');
    expect(labelOf(txnId)).toEqual({ text: 'Walmart', source: 'rename' });
    assignTransactionToLoan({ txnId, itemId });
    expect(labelOf(txnId)).toEqual({ text: 'Repayment from Car Loan', source: 'loan' });
    return { txnId, itemId };
  }

  it('keeps the loan label when the rename dialog is emptied on a linked row', () => {
    const { txnId } = contested();

    // What the dialog does: "Leave it empty to go back to the bank's wording".
    setTransactionDisplayName({ transactionId: txnId, displayDescription: '   ', userId: ctx.userId });

    // Before the fix this read { text: 'Walmart', source: 'rename' } -- a live loan payment
    // looking like an ordinary purchase on every loan page.
    expect(labelOf(txnId)).toEqual({ text: 'Repayment from Car Loan', source: 'loan' });
  });

  it('is repairable by unlinking, which it was not before', () => {
    const { txnId, itemId } = contested();
    setTransactionDisplayName({ transactionId: txnId, displayDescription: null, userId: ctx.userId });

    unassignTransactionFromLoan({ txnId, itemId });
    // unassignFromLoanAction runs this for the unlinked id; the label falls to the rename rule.
    applyRenameRules([txnId]);
    expect(labelOf(txnId)).toEqual({ text: 'Walmart', source: 'rename' });
  });

  it('still hands an UNLINKED row straight to the rules', () => {
    ctx = setupLoanTest();
    const plain = ctx.spend('WALMART', -50_000);
    const rule = upsertRenameRule({
      pattern: 'WALMART',
      matchType: 'contains',
      renameTo: 'Walmart',
      userId: ctx.userId,
      actorRole: 'admin',
    });
    if (!rule.ok) throw new Error('unexpected refusal');
    setTransactionDisplayName({ transactionId: plain, displayDescription: 'Weekly shop', userId: ctx.userId });
    expect(labelOf(plain)).toEqual({ text: 'Weekly shop', source: 'manual' });

    setTransactionDisplayName({ transactionId: plain, displayDescription: null, userId: ctx.userId });
    expect(labelOf(plain)).toEqual({ text: 'Walmart', source: 'rename' });
  });

  it('invents no label for a row linked only by a matcher RULE, which never labelled it', () => {
    // The rule/backfill path links without labelling (only assignTransactionToLoan labels), so
    // restoring from any live link would put a loan label on a row that never wore one.
    ctx = setupLoanTest();
    const { itemId } = ctx.seedLoan({ name: 'Car Loan', balanceCents: 2_000_000 });
    saveLoanRule({ itemId, merchantContains: 'WALMART', accountId: null, enabled: true });
    const txnId = ctx.spend('WALMART', -50_000);
    expect(applyPaymentMatchers([txnId], new Date(NOW))).toBe(1);
    expect(labelOf(txnId)).toEqual({ text: null, source: null });

    setTransactionDisplayName({ transactionId: txnId, displayDescription: 'Weekly shop', userId: ctx.userId });
    setTransactionDisplayName({ transactionId: txnId, displayDescription: null, userId: ctx.userId });
    expect(labelOf(txnId)).toEqual({ text: null, source: null });
    expect(restoreLoanDescription(txnId, new Date(NOW))).toBe(false);
  });

  it('restores the NEWEST manual link, which is the label the row was showing', () => {
    ctx = setupLoanTest();
    const first = ctx.seedLoan({ name: 'Car Loan', balanceCents: 2_000_000 });
    const second = ctx.seedLoan({ name: 'Boat Loan', balanceCents: 500_000 });
    // MUST-11.16: a combined payment may legitimately be assigned to two loans.
    const txnId = ctx.spend('CHEQUE 118', -50_000);
    assignTransactionToLoan({ txnId, itemId: first.itemId });
    assignTransactionToLoan({ txnId, itemId: second.itemId });
    expect(labelOf(txnId)).toEqual({ text: 'Repayment from Boat Loan', source: 'loan' });

    setTransactionDisplayName({ transactionId: txnId, displayDescription: 'Two loans at once', userId: ctx.userId });
    setTransactionDisplayName({ transactionId: txnId, displayDescription: null, userId: ctx.userId });
    expect(labelOf(txnId)).toEqual({ text: 'Repayment from Boat Loan', source: 'loan' });
  });
});
