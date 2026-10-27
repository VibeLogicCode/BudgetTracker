import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { applyPaymentMatchers, backfillLoanRule, loanRuleReach, saveLoanRule } from '@/lib/loans';
import { addInstallment } from '@/lib/warranty/installments';

/**
 * v1.58.1: a payment rule on an item whose owner is self-scoped only considers transactions
 * attributed to that owner. Household and admin owners keep household-wide matching.
 */
const NOW = '2026-08-18T12:00:00.000Z';

let t: TestDb;
let alex = 0; // self-scoped member
let sam = 0; // household member
let accountId = 0;

beforeEach(() => {
  t = createSeededTestDb();
  alex = insertTestUser(t.db, { name: 'Alex', username: 'alex', role: 'member' });
  sam = insertTestUser(t.db, { name: 'Sam', username: 'sam', role: 'member' });
  t.sqlite.prepare("update users set visibility = 'self' where id = ?").run(alex);
  accountId = insertTestAccount(t.db, { name: 'Chequing' });
});
afterEach(() => t.cleanup());

function typeOfKind(kind: 'loan' | 'bill'): number {
  return (
    t.sqlite
      .prepare('insert into warranty_item_types (name, is_subscription, kind, created_at) values (?, 0, ?, ?) returning id')
      .get(`${kind} type ${Math.random()}`, kind, NOW) as { id: number }
  ).id;
}

function makeItem(kind: 'loan' | 'bill', ownerUserId: number): number {
  const balance = kind === 'loan' ? 2_000_000 : null;
  return (
    t.sqlite
      .prepare(
        `insert into warranty_items
           (name, purchase_date, is_lifetime, owner_user_id, type_id, principal_cents, current_balance_cents, balance_updated_at, created_at, updated_at)
         values (?, '2024-01-15', 0, ?, ?, ?, ?, ?, ?, ?) returning id`,
      )
      .get('Fuel card', ownerUserId, typeOfKind(kind), balance, balance, balance === null ? null : NOW, NOW, NOW) as { id: number }
  ).id;
}

function spend(attributedUserId: number | null, date = '2026-08-10', merchant = 'FUEL STOP 12'): number {
  return (
    t.sqlite
      .prepare(
        `insert into transactions
           (account_id, date, raw_description, normalized_merchant, amount_cents, is_transfer, attributed_user_id, created_by, created_at, updated_at)
         values (?, ?, ?, ?, -45000, 0, ?, ?, ?, ?) returning id`,
      )
      .get(accountId, date, merchant, merchant, attributedUserId, alex, NOW, NOW) as { id: number }
  ).id;
}

const loanLinks = (): number[] =>
  (t.sqlite.prepare('select txn_id as id from loan_payments order by txn_id').all() as { id: number }[]).map((r) => r.id);

describe('v1.58.1: payment rules respect a self-scoped item owner', () => {
  it('(a) loanRuleReach counts only the owner\'s attributed rows', () => {
    const itemId = makeItem('loan', alex);
    spend(alex);
    spend(sam);
    spend(null);
    expect(loanRuleReach({ itemId, merchantContains: 'FUEL STOP', accountId: null })).toBe(1);
  });

  it('(b) backfillLoanRule links only the owner\'s rows', () => {
    const itemId = makeItem('loan', alex);
    const mine = spend(alex);
    const theirs = spend(sam);
    const ruleId = saveLoanRule({ itemId, merchantContains: 'FUEL STOP', accountId: null, enabled: true });

    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') }).linked).toBe(1);
    expect(loanLinks()).toEqual([mine]);
    expect(loanLinks()).not.toContain(theirs);
  });

  it('(c) applyPaymentMatchers links only the owner\'s row for a loan', () => {
    const itemId = makeItem('loan', alex);
    saveLoanRule({ itemId, merchantContains: 'FUEL STOP', accountId: null, enabled: true });
    const theirs = spend(sam);
    const mine = spend(alex);

    expect(applyPaymentMatchers([theirs, mine])).toBe(1);
    expect(loanLinks()).toEqual([mine]);
  });

  it('(c) applyPaymentMatchers marks a bill installment paid only from the owner\'s row', () => {
    const itemId = makeItem('bill', alex);
    const installmentId = addInstallment({ itemId, dueDate: '2026-08-12', amountCents: 45_000 });
    saveLoanRule({ itemId, merchantContains: 'FUEL STOP', accountId: null, enabled: true });
    const theirs = spend(sam);

    expect(applyPaymentMatchers([theirs])).toBe(0);
    const paidBefore = t.sqlite.prepare('select paid_txn_id as p from bill_installments where id = ?').get(installmentId) as { p: number | null };
    expect(paidBefore.p).toBeNull();

    const mine = spend(alex);
    expect(applyPaymentMatchers([mine])).toBe(1);
    const paidAfter = t.sqlite.prepare('select paid_txn_id as p from bill_installments where id = ?').get(installmentId) as { p: number | null };
    expect(paidAfter.p).toBe(mine);
  });

  it('(d) a household-owned item still matches any member\'s row', () => {
    const itemId = makeItem('loan', sam);
    saveLoanRule({ itemId, merchantContains: 'FUEL STOP', accountId: null, enabled: true });
    const fromAlex = spend(alex, '2026-08-10');
    const unattributed = spend(null, '2026-08-11');

    expect(loanRuleReach({ itemId, merchantContains: 'FUEL STOP', accountId: null })).toBe(2);
    expect(applyPaymentMatchers([fromAlex, unattributed])).toBe(2);
  });
});
