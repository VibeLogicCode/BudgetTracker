import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyPaymentMatchers, reverseInstallmentLinksForTransactions, saveLoanRule } from '@/lib/loans';
import { addInstallment, listInstallments, markInstallmentPaid } from '@/lib/warranty/installments';

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
