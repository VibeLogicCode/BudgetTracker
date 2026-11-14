import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { HOUSEHOLD_VIEWER, NOT_YOURS_ERROR } from '@/lib/auth/viewer';
import { assignTransactionToLoan } from '@/lib/loans';
import { listRules, RULE_OWNED_BY_ANOTHER_ERROR, ruleOwnedError, setRecurringMarks, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import type { SessionUser } from '@/lib/auth/session';

/**
 * v1.64.1. Transactions actions: the rule-owner wording a self viewer gets, unassigning a loan the
 * viewer cannot open, and the Create a rule dialog's amount bounds.
 */

let currentUser: SessionUser = { id: 1, name: 'Alex', username: 'alex', role: 'admin', visibility: 'household' };

vi.mock('@/lib/auth/session', () => ({
  requireUser: vi.fn(async () => currentUser),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import {
  bulkCategorizeAction,
  createRulesFromRowAction,
  previewRowRuleAction,
  setRecurringMarkAction,
  unassignFromLoanAction,
} from '@/app/(app)/transactions/actions';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function setup() {
  current = createSeededTestDb();
  const admin = insertTestUser(current.db, { name: 'Admin', username: 'admin', role: 'admin' });
  const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex', role: 'member' });
  const sam = insertTestUser(current.db, { name: 'Sam', username: 'sam', role: 'member' });
  const account = insertTestAccount(current.db, { name: 'Joint chequing' });
  const addTxn = (description: string, person: number | null, amountCents = -4200) =>
    current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, attributed_user_id,
        created_by, created_at, updated_at)
      values (${account}, '2026-03-09', ${description}, ${normalizeMerchant(description)}, ${amountCents}, ${person},
        ${admin}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  const as = (id: number, name: string, role: 'admin' | 'member', visibility: 'household' | 'self') => {
    currentUser = { id, name, username: name.toLowerCase(), role, visibility };
  };
  return { db: current.db, admin, alex, sam, account, addTxn, as };
}

describe('the rule-owner refusal names nobody to a self viewer', () => {
  it('setRecurringMarkAction', async () => {
    const s = setup();
    expect(setRecurringMarks({ merchants: ['MAPLE GROCER'], mark: 'recurring', userId: s.sam, actorRole: 'member' }).ok).toBe(true);
    const own = s.addTxn('MAPLE GROCER', s.alex);

    s.as(s.alex, 'Alex', 'member', 'self');
    const result = await setRecurringMarkAction({}, formData({ transactionId: String(own), mark: 'not_recurring' }));
    expect(result).toEqual({ error: RULE_OWNED_BY_ANOTHER_ERROR });
    expect(result.error).not.toContain('Sam');

    // A household member is still told whose rule it is.
    s.as(s.alex, 'Alex', 'member', 'household');
    expect(await setRecurringMarkAction({}, formData({ transactionId: String(own), mark: 'not_recurring' }))).toEqual({
      error: ruleOwnedError('Sam'),
    });
  });

  it('bulkCategorizeAction', async () => {
    const s = setup();
    const groceries = categoryIdByName(s.db, 'Groceries');
    const coffee = categoryIdByName(s.db, 'Coffee');
    upsertRuleFromCorrection({
      pattern: normalizeMerchant('MAPLE GROCER'),
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: s.sam,
      actorRole: 'member',
    });
    const own = s.addTxn('MAPLE GROCER', s.alex);

    s.as(s.alex, 'Alex', 'member', 'self');
    const result = await bulkCategorizeAction({}, formData({ ids: String(own), categoryId: String(coffee), createRules: 'on' }));
    expect(result).toEqual({ error: RULE_OWNED_BY_ANOTHER_ERROR });
    expect(JSON.stringify(result)).not.toContain('Sam');
    expect(listRules('category').map((rule) => rule.categoryId)).toEqual([groceries]);

    s.as(s.alex, 'Alex', 'member', 'household');
    expect(await bulkCategorizeAction({}, formData({ ids: String(own), categoryId: String(coffee), createRules: 'on' }))).toEqual({
      error: ruleOwnedError('Sam'),
    });
  });
});

describe('unassignFromLoanAction: the loan must resolve for the viewer', () => {
  function seedLoan(db: TestDb['db'], owner: number, name: string): number {
    const now = '2026-03-01T00:00:00.000Z';
    const type = db.get<{ id: number }>(sql`
      insert into warranty_item_types (name, is_subscription, kind, created_at) values (${`${name} type`}, 0, 'loan', ${now}) returning id`);
    return db.get<{ id: number }>(sql`
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, principal_cents,
        current_balance_cents, created_at, updated_at)
      values (${name}, '2025-01-15', 0, ${owner}, ${type.id}, 'owed', 1000000, 1000000, ${now}, ${now})
      returning id`).id;
  }

  it("refuses a self viewer's own payment linked to someone else's loan, and the link stays", async () => {
    const s = setup();
    const samLoan = seedLoan(s.db, s.sam, 'Sam car loan');
    const own = s.addTxn('AUTO LENDER', s.alex);
    expect(assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: own, itemId: samLoan }).linked).toBe(true);

    s.as(s.alex, 'Alex', 'member', 'self');
    expect(await unassignFromLoanAction(formData({ transactionId: String(own), itemId: String(samLoan) }))).toEqual({ error: NOT_YOURS_ERROR });
    expect(s.db.get<{ c: number }>(sql`select count(*) as c from loan_payments where txn_id = ${own}`).c).toBe(1);
  });

  it('a household viewer still unassigns it', async () => {
    const s = setup();
    const samLoan = seedLoan(s.db, s.sam, 'Sam car loan');
    const own = s.addTxn('AUTO LENDER', s.alex);
    expect(assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId: own, itemId: samLoan }).linked).toBe(true);

    s.as(s.alex, 'Alex', 'member', 'household');
    expect((await unassignFromLoanAction(formData({ transactionId: String(own), itemId: String(samLoan) }))).error).toBeUndefined();
    expect(s.db.get<{ c: number }>(sql`select count(*) as c from loan_payments where txn_id = ${own}`).c).toBe(0);
  });
});

describe('Create a rule: the amount bounds are capped before they are read', () => {
  const LONG_AMOUNT = `${'0'.repeat(32)}1.00`;

  it('refuses an over-long bound on preview and on save, and writes no rule', async () => {
    const s = setup();
    s.as(s.admin, 'Admin', 'admin', 'household');
    const groceries = String(categoryIdByName(s.db, 'Groceries'));
    const fields = { normalizedMerchant: 'MAPLE GROCER', amountMin: LONG_AMOUNT, amountMax: '', categoryId: groceries, person: '' };

    expect(await previewRowRuleAction({}, formData(fields))).toEqual({ error: 'That amount is not a number.' });
    expect(await createRulesFromRowAction({}, formData(fields))).toEqual({ error: 'That amount is not a number.' });
    expect(await createRulesFromRowAction({}, formData({ ...fields, amountMin: '', amountMax: LONG_AMOUNT }))).toEqual({
      error: 'That amount is not a number.',
    });
    expect(listRules('category')).toEqual([]);

    // An ordinary bound still saves.
    expect((await createRulesFromRowAction({}, formData({ ...fields, amountMin: '1.00' }))).error).toBeUndefined();
  });
});
