import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyPaymentMatchers, reverseInstallmentLinksForTransactions, saveLoanRule } from '@/lib/loans';
import { addInstallment, listInstallments, markInstallmentPaid, unmarkInstallmentPaid } from '@/lib/warranty/installments';

const NOW = '2026-08-24T12:00:00.000Z';
const TODAY = '2026-08-24';

let t: TestDb;
let accountId = 0;
let userId = 0;

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'user-1' });
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
});
afterEach(() => t.cleanup());

/**
 * v1.12.1 (item BD / MON-7, ruling R2): the "nearest installment" and "un-marking sticks"
 * describes below each want a FRESH, isolated db per setup call -- so that `paidIdOf(db)` can
 * query "the one paid row" without needing to scope by item -- rather than sharing this file's
 * top-level `t`. Each is registered here and cleaned up alongside `t` in the SAME afterEach the
 * rest of this file already relies on.
 */
let extraDbs: TestDb[] = [];
afterEach(() => {
  for (const extra of extraDbs) extra.cleanup();
  extraDbs = [];
});

function typeOfKind(kind: string, name: string): number {
  return (
    t.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, ?, ?) returning id`)
      .get(name, kind, NOW) as { id: number }
  ).id;
}

function makeItem(typeId: number, name: string, balanceCents: number | null = null): number {
  return (
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get(name, userId, typeId, balanceCents, balanceCents, balanceCents === null ? null : NOW, NOW, NOW) as {
      id: number;
    }
  ).id;
}

function spend(merchant: string, amountCents: number, over: { accountId?: number; date?: string } = {}): number {
  return (
    t.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, 0, ?, ?, ?) returning id`,
      )
      .get(over.accountId ?? accountId, over.date ?? '2026-08-01', merchant, merchant.toUpperCase(), amountCents, userId, NOW, NOW) as {
      id: number;
    }
  ).id;
}

function seedBill(name = 'Municipal tax'): number {
  return makeItem(typeOfKind('bill', `Property tax ${name}`), name);
}

describe('a rule on a bill marks the EARLIEST unpaid installment', () => {
  it('picks by date, not by amount and not by insertion order', () => {
    // v1.12.1 (item BD / MON-7, ruling R2): this is the SUPERSEDED "always earliest" rule --
    // kept as the fallback case now, not the general one. The default `spend()` date
    // ('2026-08-01') is deliberately more than 45 days from both installments below (60 and
    // 121 days respectively), so nothing here is "nearest" and the earliest-unpaid fallback is
    // exactly what fires. See payment-matchers.test.ts's later "nearest installment" describe
    // for the general rule this test no longer exercises.
    const itemId = seedBill();
    // Deliberately: the earliest row is the LARGEST, and it is inserted LAST. Neither
    // "nearest by amount" nor "first by id" gives the right answer here.
    const later = addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 50_000 });
    const earliest = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 300_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });

    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);

    const rows = listInstallments(itemId, TODAY, 30);
    expect(rows.find((r) => r.id === earliest)!.paidTxnId).toBe(txnId);
    expect(rows.find((r) => r.id === later)!.paidAt).toBeNull();
  });

  it('records the transaction even when the amount does not match (ruling C7)', () => {
    const itemId = seedBill();
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    // A tax bill arrives with penalties, discounts and rounding. Refusing to match on a few
    // dollars would leave the household with an installment that IS paid and a reminder saying
    // it is not; the difference is shown on the detail page instead.
    const txnId = spend('city tax office', -127_450);
    expect(applyPaymentMatchers([txnId])).toBe(1);
    const row = listInstallments(itemId, TODAY, 30).find((r) => r.id === id)!;
    expect(row.paidTxnId).toBe(txnId);
    expect(row.paidTxn!.amountCents).toBe(-127_450);
  });

  it('is idempotent: a second run over the same transaction marks nothing more', () => {
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);
    expect(applyPaymentMatchers([txnId])).toBe(0);
    expect(listInstallments(itemId, TODAY, 30).filter((r) => r.paidAt !== null)).toHaveLength(1);
  });

  it('creates no link and throws nothing when every installment is already paid', () => {
    const itemId = seedBill();
    const id = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    markInstallmentPaid(id, NOW);
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    expect(() => applyPaymentMatchers([txnId])).not.toThrow();
    expect(applyPaymentMatchers([txnId])).toBe(0);
  });

  it('creates no link and throws nothing when the bill has no schedule at all', () => {
    const itemId = seedBill();
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    expect(applyPaymentMatchers([spend('city tax office', -120_000)])).toBe(0);
  });

  it('never moves current_balance_cents on the bill path', () => {
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    applyPaymentMatchers([spend('city tax office', -120_000)]);
    const row = t.sqlite
      .prepare('select current_balance_cents as b, balance_updated_at as u from warranty_items where id = ?')
      .get(itemId) as { b: number | null; u: string | null };
    // A bill has no balance, and MUST-11.8's human anchor stays a loan concept.
    expect(row.b).toBeNull();
    expect(row.u).toBeNull();
  });

  it('matches a bill rule even though the bill has no balance', () => {
    // The regression the loan-conditional balance clause guards: activeRules' dormancy bail used
    // to require a non-null current_balance_cents, which would make every bill rule inert.
    const itemId = seedBill();
    addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    expect(applyPaymentMatchers([spend('city tax office', -120_000)])).toBe(1);
  });
});

describe('one link per transaction, across both kinds (ruling B11 / MUST-13.4)', () => {
  it('a transaction matching a loan rule AND a bill rule links exactly once', () => {
    const loanId = makeItem(typeOfKind('loan', 'Car loan'), 'Civic', 2_000_000);
    const billId = seedBill();
    addInstallment({ itemId: billId, dueDate: '2026-09-30', amountCents: 120_000 });
    // Same merchant string on both. First rule by id wins; the point is that the SECOND does
    // not also take it, which is only expressible because both branches share alreadyLinked().
    saveLoanRule({ itemId: loanId, merchantContains: 'CITY', accountId: null, enabled: true });
    saveLoanRule({ itemId: billId, merchantContains: 'CITY', accountId: null, enabled: true });

    const txnId = spend('city tax office', -120_000);
    expect(applyPaymentMatchers([txnId])).toBe(1);

    const loanLinks = t.sqlite.prepare('select count(*) as n from loan_payments where txn_id = ?').get(txnId) as { n: number };
    const billLinks = t.sqlite
      .prepare('select count(*) as n from bill_installments where paid_txn_id = ?')
      .get(txnId) as { n: number };
    expect(loanLinks.n + billLinks.n).toBe(1);
  });

  it('a transaction already linked to a bill is not then taken by a loan rule', () => {
    const billId = seedBill();
    addInstallment({ itemId: billId, dueDate: '2026-09-30', amountCents: 120_000 });
    saveLoanRule({ itemId: billId, merchantContains: 'CITY', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    applyPaymentMatchers([txnId]);

    const loanId = makeItem(typeOfKind('loan', 'Car loan'), 'Civic', 2_000_000);
    saveLoanRule({ itemId: loanId, merchantContains: 'CITY', accountId: null, enabled: true });
    expect(applyPaymentMatchers([txnId])).toBe(0);
  });
});

describe('reverseInstallmentLinksForTransactions (ruling B14)', () => {
  it('un-marks what those transactions paid and leaves hand-marked rows alone', () => {
    const itemId = seedBill();
    const matched = addInstallment({ itemId, dueDate: '2026-09-30', amountCents: 120_000 });
    const byHand = addInstallment({ itemId, dueDate: '2026-11-30', amountCents: 120_000 });
    markInstallmentPaid(byHand, NOW);
    saveLoanRule({ itemId, merchantContains: 'CITY TAX', accountId: null, enabled: true });
    const txnId = spend('city tax office', -120_000);
    applyPaymentMatchers([txnId]);

    expect(reverseInstallmentLinksForTransactions([txnId])).toBe(1);

    const rows = listInstallments(itemId, TODAY, 30);
    const wasMatched = rows.find((r) => r.id === matched)!;
    expect(wasMatched.paidAt).toBeNull();
    expect(wasMatched.paidTxnId).toBeNull();
    // Keyed on paid_txn_id IN (...), so it can never touch a row a person marked (B13).
    expect(rows.find((r) => r.id === byHand)!.paidAt).toBe(NOW);
  });

  it('is a no-op for an empty list and for transactions that paid nothing', () => {
    expect(reverseInstallmentLinksForTransactions([])).toBe(0);
    expect(reverseInstallmentLinksForTransactions([spend('grocery', -5_000)])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// v1.12.1 (items BD / MON-7 and BA / MON-3): each setup below builds its OWN isolated db, so
// paidIdOf() can ask "which row is paid" without scoping by item -- there is only ever one bill
// per setup call. Registered in extraDbs above for cleanup.

const BILL_RULE = 'CITY TAX OFFICE';

function freshBillDb(): TestDb {
  const fresh = createSeededTestDb();
  extraDbs.push(fresh);
  return fresh;
}

function seedThreeInstallmentBill(fresh: TestDb): { itemId: number; march: number; june: number; september: number } {
  const uid = insertTestUser(fresh.db, { username: 'payer' });
  const typeId = (
    fresh.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Property tax', 0, 'bill', ?) returning id`)
      .get(NOW) as { id: number }
  ).id;
  const itemId = (
    fresh.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('City property tax', '2024-01-15', 0, ?, ?, ?, ?) returning id`,
      )
      .get(uid, typeId, NOW, NOW) as { id: number }
  ).id;
  const march = addInstallment({ itemId, dueDate: '2026-03-15', amountCents: 80_000, at: NOW });
  const june = addInstallment({ itemId, dueDate: '2026-06-15', amountCents: 80_000, at: NOW });
  const september = addInstallment({ itemId, dueDate: '2026-09-15', amountCents: 80_000, at: NOW });
  saveLoanRule({ itemId, merchantContains: BILL_RULE, accountId: null, enabled: true });
  return { itemId, march, june, september };
}

function spendOn(fresh: TestDb, date: string, amountCents = -80_000): number {
  const accountId = insertTestAccount(fresh.db, { name: 'Chequing' });
  const uid = (fresh.sqlite.prepare('select id from users limit 1').get() as { id: number }).id;
  return (
    fresh.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, 0, ?, ?, ?) returning id`,
      )
      .get(accountId, date, BILL_RULE, BILL_RULE, amountCents, uid, NOW, NOW) as { id: number }
  ).id;
}

function setupThreeInstallments(opts: { txnDate: string; txnAmountCents?: number }): {
  txnId: number;
  installments: { march: number; june: number; september: number };
  db: TestDb['db'];
} {
  const fresh = freshBillDb();
  const installments = seedThreeInstallmentBill(fresh);
  const txnId = spendOn(fresh, opts.txnDate, opts.txnAmountCents);
  return { txnId, installments, db: fresh.db };
}

function setupTwoEquidistantInstallments(): { txnId: number; installments: { earlier: number; later: number }; db: TestDb['db'] } {
  const fresh = freshBillDb();
  const uid = insertTestUser(fresh.db, { username: 'payer' });
  const typeId = (
    fresh.sqlite
      .prepare(`insert into warranty_item_types (name, is_subscription, kind, created_at) values ('Property tax', 0, 'bill', ?) returning id`)
      .get(NOW) as { id: number }
  ).id;
  const itemId = (
    fresh.sqlite
      .prepare(
        `insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, created_at, updated_at)
         values ('City property tax', '2024-01-15', 0, ?, ?, ?, ?) returning id`,
      )
      .get(uid, typeId, NOW, NOW) as { id: number }
  ).id;
  const earlier = addInstallment({ itemId, dueDate: '2026-06-10', amountCents: 80_000, at: NOW });
  const later = addInstallment({ itemId, dueDate: '2026-06-20', amountCents: 80_000, at: NOW });
  saveLoanRule({ itemId, merchantContains: BILL_RULE, accountId: null, enabled: true });
  const txnId = spendOn(fresh, '2026-06-15');
  return { txnId, installments: { earlier, later }, db: fresh.db };
}

/** Adds one more transaction to the CURRENTLY ACTIVE db (the last one a setup* helper created and
 *  left active) -- the same "re-picking a category re-runs the matcher" flow MON-3 describes. */
function setupSecondPaymentTransaction(opts: { date: string }): number {
  const db = getDb();
  const accountId = db.get<{ id: number }>(sql`select id from accounts limit 1`)!.id;
  const uid = db.get<{ id: number }>(sql`select id from users limit 1`)!.id;
  return db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, created_by, created_at, updated_at)
        values (${accountId}, ${opts.date}, ${BILL_RULE}, ${BILL_RULE}, -80000, 0, ${uid}, ${NOW}, ${NOW}) returning id`,
  )!.id;
}

function paidIdOf(db: TestDb['db']): number | undefined {
  return db.get<{ id: number }>(sql`select id from bill_installments where paid_at is not null limit 1`)?.id;
}

describe('a bill payment marks the installment nearest its own date (item BD / MON-7, ruling R2)', () => {
  it('marks the second of three when the transaction is dated beside it', () => {
    const { txnId, installments, db } = setupThreeInstallments({ txnDate: '2026-06-14' });
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));

    expect(paidIdOf(db)).toBe(installments.june);
  });

  it('falls back to the earliest unpaid when nothing is within 45 days', () => {
    const { txnId, installments, db } = setupThreeInstallments({ txnDate: '2027-06-14' });
    applyPaymentMatchers([txnId], new Date('2027-06-20T00:00:00.000Z'));

    expect(paidIdOf(db)).toBe(installments.march);
  });

  it('45 days is inclusive and 46 is not', () => {
    const inWindow = setupThreeInstallments({ txnDate: '2026-05-01' }); // 45 days before 2026-06-15
    applyPaymentMatchers([inWindow.txnId], new Date('2026-05-02T00:00:00.000Z'));
    expect(paidIdOf(inWindow.db)).toBe(inWindow.installments.june);

    const outOfWindow = setupThreeInstallments({ txnDate: '2026-04-30' }); // 46 days before
    applyPaymentMatchers([outOfWindow.txnId], new Date('2026-05-02T00:00:00.000Z'));
    expect(paidIdOf(outOfWindow.db)).toBe(outOfWindow.installments.march);
  });

  it('a tie goes to the earlier due date, so the choice is deterministic', () => {
    const { txnId, installments, db } = setupTwoEquidistantInstallments();
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    expect(paidIdOf(db)).toBe(installments.earlier);
  });

  it('still does not compare amounts — ruling R2 and v1.12.0 ruling C7 both say so', () => {
    const { txnId, installments, db } = setupThreeInstallments({ txnDate: '2026-06-14', txnAmountCents: -12345 });
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    expect(paidIdOf(db)).toBe(installments.june);
  });
});

describe('un-marking an installment sticks (item BA / MON-3, ruling P1)', () => {
  it('the matcher does not re-mark a row a person un-marked', () => {
    const { txnId, installments, db } = setupThreeInstallments({ txnDate: '2026-06-14' });
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    expect(paidIdOf(db)).toBe(installments.june);

    unmarkInstallmentPaid(installments.june, '2026-06-21T00:00:00.000Z');

    // This is the loop MON-3 describes: confirmCategory calls applyPaymentMatchers on BOTH of its
    // exits, so re-picking the same category on /transactions used to be enough to re-mark it.
    applyPaymentMatchers([txnId], new Date('2026-06-22T00:00:00.000Z'));

    expect(paidIdOf(db)).toBeUndefined();
    expect(
      db.get<{ at: string | null }>(sql`select unlinked_at as at from bill_installments where id = ${installments.june}`)
        .at,
    ).not.toBeNull();
  });

  it('the matcher moves on to the next candidate instead of stalling', () => {
    const { txnId, installments, db } = setupThreeInstallments({ txnDate: '2026-06-14' });
    applyPaymentMatchers([txnId], new Date('2026-06-20T00:00:00.000Z'));
    unmarkInstallmentPaid(installments.june, '2026-06-21T00:00:00.000Z');

    const second = setupSecondPaymentTransaction({ date: '2026-09-14' });
    applyPaymentMatchers([second], new Date('2026-09-20T00:00:00.000Z'));

    // June is suppressed, so the September payment takes September, not June.
    expect(paidIdOf(db)).toBe(installments.september);
  });
});
