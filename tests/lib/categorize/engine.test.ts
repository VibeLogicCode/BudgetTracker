import { describe, it, expect, afterEach } from 'vitest';
import { and, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { transactions } from '@/db/schema';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  CARD_PAYMENT_PATTERNS,
  applyCategoryToMatching,
  applyRenameRules,
  applyRuleNow,
  buildContext,
  categorizeTransaction,
  clearCategory,
  clearRuleFromTransactions,
  confirmCategory,
  deleteRenameRule,
  deleteRules,
  detectTransfer,
  eligibleForRerun,
  matchesCardPaymentPattern,
  previewRerun,
  previewRuleReapply,
  rerunEngine,
  resolveRename,
  resolveRenameRule,
  REVIEW_SUGGESTED_WHERE,
  REVIEW_UNCATEGORIZED_WHERE,
  REVIEW_WHERE,
  reviewQueueCount,
  reviewQueueIds,
  ruleClearIds,
  ruleImpactCounts,
  ruleImpactIds,
  runEngine,
  setRuleDisabled,
  setRulesDisabled,
  setTransactionDisplayName,
  setTransferFlag,
  upsertRenameRule,
} from '@/lib/categorize/engine';
import { deleteRule, exactRuleOwner, listRules, matchRule, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { classify, train } from '@/lib/categorize/bayes';
import { normalizeMerchant, tokenize } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { assignTransactionToLoan, unassignTransactionFromLoan } from '@/lib/loans';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const add = (rawDescription: string, amountCents = -1000, date = '2026-03-02') => {
    const row = current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, ${date}, ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents}, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  };
  return { db: current.db, sqlite: current.sqlite, userId, accountId, add };
}

const readTxn = (sqlite: TestDb['sqlite'], id: number) =>
  sqlite.prepare('select category_id, categorization_source, confidence, is_transfer, normalized_merchant from transactions where id = ?').get(id) as {
    category_id: number | null;
    categorization_source: string;
    confidence: number | null;
    is_transfer: number;
    normalized_merchant: string;
  };

describe('transfer detection', () => {
  it('flags card-payment patterns', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('PAYMENT - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('AMEX PAYMENT RECEIVED - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('SCOTIA VISA PAYMENT', ctx)).toBe(true);
    expect(detectTransfer('TFR-TO C/C 4520********1234', ctx)).toBe(true);
    expect(detectTransfer('TFR-FR SAVINGS', ctx)).toBe(true);
    expect(CARD_PAYMENT_PATTERNS.length).toBeGreaterThan(5);
  });

  it('NEVER auto-flags an e-transfer', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('E-TRANSFER SENT J DOE', ctx)).toBe(false);
    expect(detectTransfer('INTERAC E-TRANSFER RECEIVED', ctx)).toBe(false);
    expect(detectTransfer('E-TRANSFER SENT LANDLORD', ctx)).toBe(false);
    expect(detectTransfer('EMAIL TRANSFER TO MOM', ctx)).toBe(false);
  });

  it('leaves ordinary merchants alone', () => {
    setup();
    const ctx = buildContext();
    expect(detectTransfer('TIM HORTONS', ctx)).toBe(false);
    expect(detectTransfer('LOBLAWS', ctx)).toBe(false);
  });

  it('honours a learned exact transfer rule', () => {
    setup();
    upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' });
    const ctx = buildContext();
    expect(detectTransfer('E-TRANSFER SENT J DOE', ctx)).toBe(true);
    // exact only — a similar e-transfer must not be caught
    expect(detectTransfer('E-TRANSFER SENT J DOE JR', ctx)).toBe(false);
  });
});

describe('categorizeTransaction ordering', () => {
  it('prefers an exact rule over a contains rule and over Bayes', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null, actorRole: 'admin' });
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], groceries);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], restaurants);

    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS' }, buildContext());
    expect(outcome).toMatchObject({ categoryId: coffee, source: 'rule', confidence: null, isTransfer: false });
  });

  it('falls back to a contains rule', () => {
    const { db } = setup();
    const restaurants = categoryIdByName(db, 'Restaurants');
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null, actorRole: 'admin' });
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS EXPRESS' }, buildContext())).toMatchObject({
      categoryId: restaurants,
      source: 'rule',
    });
  });

  it('falls back to Bayes and records the margin as confidence', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);

    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS' }, buildContext());
    expect(outcome.source).toBe('bayes');
    expect(outcome.categoryId).toBe(coffee);
    expect(outcome.confidence).toBeCloseTo(classify(tokenize('TIM HORTONS'))!.margin, 6);
  });

  it('leaves a row uncategorized when nothing matches', () => {
    setup();
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'SOME NEW SHOP' }, buildContext())).toMatchObject({
      categoryId: null,
      source: 'none',
      confidence: null,
      isTransfer: false,
    });
  });

  it('short-circuits on a transfer and does not categorize it', () => {
    const { db } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    expect(categorizeTransaction({ id: 1, normalizedMerchant: 'PAYMENT - THANK YOU' }, buildContext())).toMatchObject({
      categoryId: null,
      source: 'none',
      isTransfer: true,
    });
  });
});

describe('runEngine', () => {
  it('writes the outcome and bumps rule hit counts', () => {
    const { db, sqlite, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const ruleId = upserted.ruleId;
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    const result = runEngine([id]);
    expect(result).toMatchObject({ processed: 1, categorized: 1, transfers: 0, skipped: 0 });
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'rule', is_transfer: 0 });
    expect(listRules('category').find((r) => r.id === ruleId)?.hitCount).toBe(1);
  });

  it('sets is_transfer on card payments', () => {
    const { sqlite, add } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    const result = runEngine([id]);
    expect(result.transfers).toBe(1);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
  });

  it('NEVER touches a manual or rule row', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });

    const manualId = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manualId}`);
    const ruleId = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -1200);
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'rule' where id = ${ruleId}`);

    const result = runEngine([manualId, ruleId]);
    expect(result).toMatchObject({ processed: 0, skipped: 2 });
    expect(readTxn(sqlite, manualId).category_id).toBe(groceries);
    expect(readTxn(sqlite, ruleId).category_id).toBe(groceries);
  });

  it('DOES re-process an unaccepted bayes row', () => {
    const { db, sqlite, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes', confidence = 2.5 where id = ${id}`);
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });

    expect(runEngine([id])).toMatchObject({ processed: 1, categorized: 1 });
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'rule', confidence: null });
  });

  it('rerunEngine only picks eligible rows, optionally scoped to an account', () => {
    const { db, add, accountId } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${bayesRow}`);
    const manual = add('THIRD SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manual}`);

    expect(eligibleForRerun().sort()).toEqual([uncategorized, bayesRow].sort());
    expect(eligibleForRerun({ accountId }).sort()).toEqual([uncategorized, bayesRow].sort());
    expect(eligibleForRerun({ accountId: accountId + 999 })).toEqual([]);
    expect(rerunEngine().processed).toBe(2);
  });

  // v1.21.0 (item 11): EngineResult.changed distinguishes "the engine looked at N rows" from
  // "the engine actually changed N rows" -- what a re-run confirmation needs to say honestly.
  describe('EngineResult.changed', () => {
    it('counts a newly-categorized row as changed', () => {
      const { db, add } = setup();
      const coffee = categoryIdByName(db, 'Coffee');
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
      const id = add('TIM HORTONS');
      expect(runEngine([id])).toMatchObject({ processed: 1, changed: 1 });
    });

    it('does NOT count a bayes row re-guessed to the identical category', () => {
      const { db, add } = setup();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      // Two contrasting categories, matching how "falls back to Bayes" above establishes a real
      // margin -- a single trained category gives classify() nothing to contrast against and it
      // returns null, which would make this row look "changed" for the wrong reason entirely.
      for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
      for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);
      const id = add('TIM HORTONS');
      db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'bayes' where id = ${id}`);
      const result = runEngine([id]);
      expect(result.processed).toBe(1);
      expect(result.changed).toBe(0);
    });

    it('counts a row newly flagged a transfer', () => {
      const { add } = setup();
      const id = add('PAYMENT - THANK YOU');
      expect(runEngine([id])).toMatchObject({ changed: 1 });
    });
  });

  describe('previewRerun', () => {
    it('reports the same eligible/wouldChange figures runEngine would actually produce, without writing anything', () => {
      const { db, sqlite, add } = setup();
      const coffee = categoryIdByName(db, 'Coffee');
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
      const id = add('TIM HORTONS');

      const preview = previewRerun([id]);
      expect(preview).toEqual({ eligible: 1, wouldChange: 1 });
      // Nothing was written.
      expect(readTxn(sqlite, id)).toMatchObject({ category_id: null, categorization_source: 'none' });

      const real = runEngine([id]);
      expect(real).toMatchObject({ processed: preview.eligible, changed: preview.wouldChange });
    });

    it('an empty id list previews as nothing to do', () => {
      setup();
      expect(previewRerun([])).toEqual({ eligible: 0, wouldChange: 0 });
    });
  });
});

describe('the learning loop', () => {
  it('confirmCategory sets manual, creates an exact rule and trains Bayes', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    confirmCategory({ transactionId: id, categoryId: coffee, userId, actorRole: 'admin' });

    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'manual', confidence: null });
    const rules = listRules('category');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'TIM HORTONS', matchType: 'exact', categoryId: coffee, createdBy: userId });
    const trained = sqlite.prepare('select token, count from bayes_tokens where category_id = ? order by token').all(coffee);
    expect(trained).toEqual([{ token: 'HORTONS', count: 1 }, { token: 'TIM', count: 1 }]);
  });

  it('a correction untrains the old category and retrains the new one', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');

    confirmCategory({ transactionId: id, categoryId: coffee, userId, actorRole: 'admin' });
    confirmCategory({ transactionId: id, categoryId: restaurants, userId, actorRole: 'admin' });

    expect((sqlite.prepare('select count(*) as c from bayes_tokens where category_id = ?').get(coffee) as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from bayes_tokens where category_id = ?').get(restaurants) as { c: number }).c).toBe(2);
    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0].categoryId).toBe(restaurants);
  });

  it('accepting a Bayes guess is a confirmation, not a re-guess', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    for (let i = 0; i < 3; i += 1) train(['TIM', 'HORTONS'], coffee);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);

    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    runEngine([id]);
    expect(readTxn(sqlite, id).categorization_source).toBe('bayes');

    confirmCategory({ transactionId: id, categoryId: coffee, userId, actorRole: 'admin' });
    expect(readTxn(sqlite, id)).toMatchObject({ categorization_source: 'manual', category_id: coffee, confidence: null });
    // The accepted row leaves the review queue permanently.
    expect(reviewQueueIds()).not.toContain(id);
  });

  it('can create a confirmation without a rule when asked', () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('ONE OFF PURCHASE');
    confirmCategory({ transactionId: id, categoryId: coffee, userId, createRule: false, actorRole: 'admin' });
    expect(listRules('category')).toHaveLength(0);
  });

  /**
   * Regression anchor (2026-08-22 split-guard fix): clearCategory now refuses a split
   * transaction (see the guard tests in tests/lib/splits-bulk.test.ts), so this is the test
   * that proves the ORDINARY, unsplit case still untrains exactly as it did before that guard
   * was added -- pinned with exact doc/token-count numbers, not just "some tokens exist".
   */
  it('clearCategory untrains and returns the row to uncategorized', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId, actorRole: 'admin' }).ok).toBe(true);
    expect(
      sqlite.prepare('select doc_count as docCount, token_total as tokenTotal from bayes_category_totals where category_id = ?').get(coffee),
    ).toEqual({ docCount: 1, tokenTotal: 2 });

    expect(clearCategory({ transactionId: id, userId, deleteRule: true })).toBe(true);

    expect(readTxn(sqlite, id)).toMatchObject({ category_id: null, categorization_source: 'none' });
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
    expect(
      sqlite.prepare('select doc_count as docCount, token_total as tokenTotal from bayes_category_totals where category_id = ?').get(coffee),
    ).toEqual({ docCount: 0, tokenTotal: 0 });
  });

  it('applyCategoryToMatching confirms every matching row and creates one rule', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const a = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    const b = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -600, '2026-03-05');
    const c = add('LOBLAWS #1042 BURLINGTON ON');

    expect(applyCategoryToMatching({ normalizedMerchant: 'TIM HORTONS', categoryId: coffee, userId, actorRole: 'admin' })).toMatchObject({ ok: true, count: 2 });
    expect(readTxn(sqlite, a).categorization_source).toBe('manual');
    expect(readTxn(sqlite, b).categorization_source).toBe('manual');
    expect(readTxn(sqlite, c).categorization_source).toBe('none');
    expect(listRules('category')).toHaveLength(1);
  });
});

describe('transfer toggling', () => {
  it('turning the flag on teaches an EXACT transfer rule', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: true });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    const rules = listRules('transfer');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null });
  });

  it('turning it off removes the learned rule', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: true });
    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: true });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(0);
  });

  it('un-flagging a card-payment-pattern row teaches a not_transfer override that survives rerun', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);

    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: true });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    const rules = listRules('not_transfer');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'not_transfer', categoryId: null });

    // Without the override, rerunEngine would re-flag it on the very next pass.
    rerunEngine();
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
  });

  it('re-flagging as a transfer removes any earlier not_transfer override', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: true });
    expect(listRules('not_transfer')).toHaveLength(1);

    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: true });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(0);
    expect(detectTransfer('PAYMENT - THANK YOU', buildContext())).toBe(true);
  });
});

/**
 * v1.27.0 item 1 (the owner's report, verbatim: "when i add items to loan they are marked transfer
 * by default but it also adds a rule ... next time i buy from best buy woodbridge i dont want it to
 * automatically caretgorize it as transfer").
 *
 * The five cases above cover `learnRule: true` -- today's behaviour, unchanged. In particular
 * "turning the flag on teaches an EXACT transfer rule" is already the proof that the explicit
 * per-row "Mark as transfer" control still authors its rule exactly as before, so that case is NOT
 * duplicated here; every test in this block is about the other value.
 */
describe('v1.27.0 item 1: learnRule: false sets the flag and authors NO rule', () => {
  it('sets is_transfer and creates no merchant rule of any kind', () => {
    const { sqlite, add, userId } = setup();
    // The owner's shape: a shop they buy from normally, this once a reimbursement.
    const id = add('MAPLEVIEW ELECTRONICS WOODBRIDGE');
    expect(setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: false })).toEqual({ ok: true });

    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(listRules('transfer')).toEqual([]);
    expect(listRules('not_transfer')).toEqual([]);
    expect(listRules()).toEqual([]);
  });

  /**
   * The half a partial fix is most likely to miss. Suppressing only the UPSERT would still let a
   * loan assignment reach in and delete a rule the household deliberately made -- the same defect
   * wearing the other sign, and invisible in exactly the same way.
   */
  it('does NOT delete the opposite-kind rule as housekeeping (the half a partial fix misses)', () => {
    const { sqlite, add, userId } = setup();
    // Somebody has already told the household "this merchant is NOT a transfer", deliberately.
    upsertRuleFromCorrection({
      pattern: 'MAPLEVIEW ELECTRONICS WOODBRIDGE',
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: userId,
      actorRole: 'admin',
    });
    const id = add('MAPLEVIEW ELECTRONICS WOODBRIDGE');
    expect(setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: false })).toEqual({ ok: true });

    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(1);
    expect(listRules('transfer')).toEqual([]);
  });

  it('does NOT delete a learned transfer rule when un-flagging either', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: true });
    expect(listRules('transfer')).toHaveLength(1);

    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: false });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(1);
  });

  it('does NOT teach a not_transfer override for a card-payment merchant', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);

    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: false });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    // The card-payment branch is the one that reads least like a rule write and so is the one most
    // likely to be left un-gated. No rule means rerunEngine re-flags the row -- stated here rather
    // than left as a surprise, because it is the honest consequence of not teaching an override.
    expect(listRules('not_transfer')).toEqual([]);
  });

  /**
   * With no rule read and none written there is nothing to OWN, so this path cannot refuse on
   * ownership -- the counterpart of the `learnRule: true` refusals proved in the ruling R4 block
   * further down, which are unchanged.
   */
  it('cannot refuse on rule ownership, because it touches no rule', () => {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin Owner', username: 'admin-owner', role: 'admin' });
    const memberId = insertTestUser(current.db, { name: 'Member Other', username: 'member-other', role: 'member' });
    const accountId = insertTestAccount(current.db);
    const { sqlite } = current;
    upsertRuleFromCorrection({
      pattern: 'MAPLEVIEW ELECTRONICS WOODBRIDGE',
      matchType: 'exact',
      ruleKind: 'not_transfer',
      categoryId: null,
      createdBy: adminId,
      actorRole: 'admin',
    });
    const row = current.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', 'MAPLEVIEW ELECTRONICS WOODBRIDGE', ${normalizeMerchant('MAPLEVIEW ELECTRONICS WOODBRIDGE')}, -24999, 'none', ${memberId}, ${nowIso()}, ${nowIso()})
      returning id`);

    expect(
      setTransferFlag({ transactionId: row.id, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: false }),
    ).toEqual({ ok: true });
    expect(readTxn(sqlite, row.id).is_transfer).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(1);
  });

  it('a split row is still refused, and still writes nothing', () => {
    const { sqlite, db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('MAPLEVIEW ELECTRONICS WOODBRIDGE', -1000);
    db.run(sql`insert into transaction_splits (txn_id, category_id, amount_cents, created_at)
      values (${id}, ${coffee}, -1000, ${nowIso()})`);

    expect(setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin', learnRule: false })).toEqual({
      ok: false,
      reason: 'has_splits',
    });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules()).toEqual([]);
  });

  /**
   * THE BUG, end to end and in the owner's own terms: file one purchase from a shop against a loan
   * (flag set, no rule), then let the NEXT purchase from that same shop arrive the way a real one
   * does -- through the engine. It must be ordinary spending.
   */
  it('the next transaction from that merchant is not auto-flagged as a transfer on import', () => {
    const { sqlite, add, userId } = setup();
    const reimbursed = add('MAPLEVIEW ELECTRONICS WOODBRIDGE', -24999, '2026-03-02');
    setTransferFlag({ transactionId: reimbursed, isTransfer: true, userId, actorRole: 'admin', learnRule: false });

    expect(detectTransfer(normalizeMerchant('MAPLEVIEW ELECTRONICS WOODBRIDGE'), buildContext())).toBe(false);

    const nextMonth = add('MAPLEVIEW ELECTRONICS WOODBRIDGE', -8999, '2026-04-11');
    runEngine([nextMonth]);
    expect(readTxn(sqlite, nextMonth).is_transfer).toBe(0);

    // And a re-run over everything does not retroactively flag it either.
    rerunEngine();
    expect(readTxn(sqlite, nextMonth).is_transfer).toBe(0);
  });

  /**
   * The contrast, in one test, so the fix cannot be read as "loan payments stopped being
   * transfers": the SAME merchant, the SAME flag, marked through the deliberate per-row control
   * instead -- and the next import IS flagged, because that is what the person asked for.
   */
  it('but the deliberate per-row control still teaches the merchant, and the next import IS flagged', () => {
    const { sqlite, add, userId } = setup();
    const first = add('ACME PAYROLL DEPOSIT', 250000, '2026-03-02');
    setTransferFlag({ transactionId: first, isTransfer: true, userId, actorRole: 'admin', learnRule: true });
    expect(listRules('transfer')).toHaveLength(1);

    const second = add('ACME PAYROLL DEPOSIT', 250000, '2026-04-02');
    runEngine([second]);
    expect(readTxn(sqlite, second).is_transfer).toBe(1);
  });
});

describe('merchant renames', () => {
  const readDisplay = (sqlite: TestDb['sqlite'], id: number) =>
    sqlite.prepare('select raw_description, display_description, display_source, normalized_merchant from transactions where id = ?').get(id) as {
      raw_description: string;
      display_description: string | null;
      display_source: string | null;
      normalized_merchant: string;
    };

  it('resolves a rename rule with exact-then-longest-contains precedence', () => {
    const { userId } = setup();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'MCD', matchType: 'contains', renameTo: 'Mickey D', userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'MCDONALDS EXPRESS', matchType: 'contains', renameTo: "McDonald's Express", userId, actorRole: 'admin' });

    const ctx = buildContext();
    expect(resolveRename('MCDONALDS', ctx)).toBe("McDonald's");
    expect(resolveRename('MCDONALDS EXPRESS TERMINAL', ctx)).toBe("McDonald's Express");
    expect(resolveRename('MCD CAFE', ctx)).toBe('Mickey D');
    expect(resolveRename('TIM HORTONS', ctx)).toBeNull();
  });

  it('applies on import through runEngine and leaves the raw text alone', () => {
    const { sqlite, add, userId } = setup();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');

    runEngine([id]);

    expect(readDisplay(sqlite, id)).toEqual({
      raw_description: 'POS PURCHASE MCDONALDS #4821 TORONTO ON',
      display_description: "McDonald's",
      display_source: 'rename',
      normalized_merchant: 'MCDONALDS',
    });
  });

  it('never changes raw_description, normalized_merchant or the dedup hash', () => {
    const { db, sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    db.run(sql`update transactions set dedup_hash = 'frozen-hash-value' where id = ${id}`);
    const before = sqlite.prepare('select raw_description, normalized_merchant, dedup_hash from transactions where id = ?').get(id);

    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Lunch place', userId });
    applyRenameRules();

    const after = sqlite.prepare('select raw_description, normalized_merchant, dedup_hash from transactions where id = ?').get(id);
    expect(after).toEqual(before);
  });

  it('bulk-applies retroactively when the rule is created', () => {
    const { sqlite, add, userId } = setup();
    const a = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const b = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');
    const other = add('LOBLAWS #1042 BURLINGTON ON');

    const result = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!result.ok) throw new Error('unexpected refusal');
    expect(result.rowsUpdated).toBe(2);
    expect(readDisplay(sqlite, a).display_description).toBe("McDonald's");
    expect(readDisplay(sqlite, b).display_description).toBe("McDonald's");
    expect(readDisplay(sqlite, other).display_description).toBeNull();
  });

  it('re-applies when the rule text is edited', () => {
    const { sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: 'Golden Arches', userId, actorRole: 'admin' });
    expect(readDisplay(sqlite, id).display_description).toBe('Golden Arches');
    expect(listRules('rename')).toHaveLength(1);
  });

  it('MANUAL WINS: a manual rename is never overwritten by a rule, a re-run, or a rule edit', () => {
    const { sqlite, add, userId } = setup();
    const manual = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const ruled = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');

    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });

    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(readDisplay(sqlite, ruled)).toMatchObject({ display_description: "McDonald's", display_source: 'rename' });

    runEngine([manual, ruled]);
    applyRenameRules();
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: 'Golden Arches', userId, actorRole: 'admin' });

    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(readDisplay(sqlite, ruled).display_description).toBe('Golden Arches');
  });

  it('clearing a manual rename hands the row back to the rules', () => {
    const { sqlite, add, userId } = setup();
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    setTransactionDisplayName({ transactionId: id, displayDescription: 'Lunch with Bob', userId });
    expect(readDisplay(sqlite, id).display_source).toBe('manual');

    setTransactionDisplayName({ transactionId: id, displayDescription: null, userId });
    expect(readDisplay(sqlite, id)).toMatchObject({ display_description: "McDonald's", display_source: 'rename' });
  });

  it('deleting the rule clears only the rows it set', () => {
    const { sqlite, add, userId } = setup();
    const ruled = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const manual = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId });

    const result = deleteRenameRule({ pattern: 'MCDONALDS', matchType: 'exact' });
    expect(result.ruleId).not.toBeNull();
    expect(result.rowsCleared).toBe(1);
    expect(readDisplay(sqlite, ruled)).toMatchObject({ display_description: null, display_source: null });
    expect(readDisplay(sqlite, manual)).toMatchObject({ display_description: 'Lunch with Bob', display_source: 'manual' });
    expect(listRules('rename')).toHaveLength(0);
  });

  it('deleting a rule that does not exist is a no-op', () => {
    setup();
    expect(deleteRenameRule({ pattern: 'NOTHING', matchType: 'exact' })).toEqual({ ruleId: null, rowsCleared: 0 });
  });

  it('a rename rule and a category rule coexist on the same pattern', () => {
    const { db, sqlite, add, userId } = setup();
    const restaurants = categoryIdByName(db, 'Restaurants');
    const id = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });

    runEngine([id]);
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: restaurants, categorization_source: 'rule' });
    expect(readDisplay(sqlite, id).display_description).toBe("McDonald's");
    expect(listRules()).toHaveLength(2);
  });

  it('rename rules never leak into category or transfer matching', () => {
    const { add, userId } = setup();
    upsertRenameRule({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', renameTo: 'Card payment', userId, actorRole: 'admin' });
    const ctx = buildContext();
    expect(matchRule('PAYMENT - THANK YOU', 'category', ctx.rules)).toBeNull();
    // The card-payment pattern list still flags it; the rename rule is not what did that.
    expect(detectTransfer('PAYMENT - THANK YOU', ctx)).toBe(true);
    expect(detectTransfer('MCDONALDS', ctx)).toBe(false);
    expect(add).toBeTypeOf('function');
  });

  it('rejects an empty rename target', () => {
    const { userId } = setup();
    expect(() => upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: '   ', userId, actorRole: 'admin' })).toThrowError(/non-empty display name/);
  });
});

// v1.21.0 (item 11): "disable, not delete" -- disabling a rename rule must revert its rows
// exactly as deleting does; disabling any other kind changes nothing retroactively by itself.
describe('setRuleDisabled', () => {
  const readDisplay = (sqlite: TestDb['sqlite'], id: number) =>
    sqlite.prepare('select display_description, display_source from transactions where id = ?').get(id) as {
      display_description: string | null;
      display_source: string | null;
    };

  it('disabling a rename rule reverts every row it set, and re-enabling restores them', () => {
    const { sqlite, add, userId } = setup();
    const ruled = add('POS PURCHASE MCDONALDS #4821 TORONTO ON');
    const manual = add('POS PURCHASE MCDONALDS #1099 OAKVILLE ON', -1500, '2026-03-05');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    setTransactionDisplayName({ transactionId: manual, displayDescription: 'Lunch with Bob', userId });

    const disabled = setRuleDisabled({ ruleId: upserted.ruleId, disabled: true });
    expect(disabled.rowsChanged).toBe(1);
    expect(readDisplay(sqlite, ruled)).toEqual({ display_description: null, display_source: null });
    // Manual is never touched, exactly like a delete.
    expect(readDisplay(sqlite, manual)).toEqual({ display_description: 'Lunch with Bob', display_source: 'manual' });
    // The rule itself is still there, just inert -- unlike deleteRenameRule.
    expect(listRules('rename')).toHaveLength(1);
    expect(listRules('rename')[0].disabledAt).not.toBeNull();

    const reenabled = setRuleDisabled({ ruleId: upserted.ruleId, disabled: false });
    expect(reenabled.rowsChanged).toBe(1);
    expect(readDisplay(sqlite, ruled)).toEqual({ display_description: "McDonald's", display_source: 'rename' });
    expect(listRules('rename')[0].disabledAt).toBeNull();
  });

  it('disabling a category rule reports zero rows changed and leaves already-set rows exactly as they were', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const id = add('TIM HORTONS');
    runEngine([id]);
    expect(readTxn(sqlite, id).category_id).toBe(coffee);

    const result = setRuleDisabled({ ruleId: upserted.ruleId, disabled: true });
    expect(result.rowsChanged).toBe(0);
    // Disabling the rule stops it from matching the NEXT run; it does not un-decide this row.
    expect(readTxn(sqlite, id)).toMatchObject({ category_id: coffee, categorization_source: 'rule' });
    expect(matchRule('TIM HORTONS', 'category', listRules())).toBeNull();
  });

  it('an unknown ruleId is a no-op', () => {
    setup();
    expect(setRuleDisabled({ ruleId: 999999, disabled: true })).toEqual({ rowsChanged: 0 });
  });
});

describe('applyRuleNow / previewRuleReapply (item 11: per-rule Apply now)', () => {
  it('categorizes exactly the rows this rule resolves, never a manually-decided row', () => {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('TIM HORTONS');
    const manual = add('TIM HORTONS EXPRESS', -500, '2026-03-05');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manual}`);
    const unrelated = add('SOME OTHER SHOP');

    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');

    const preview = previewRuleReapply(upserted.ruleId);
    expect(preview).toEqual({ eligible: 1, wouldChange: 1 });

    const result = applyRuleNow(upserted.ruleId);
    expect(result).toMatchObject({ processed: 1, changed: 1 });
    expect(readTxn(sqlite, uncategorized).category_id).toBe(coffee);
    // Never touched: the manual row, and the row an unrelated rule/pattern would not reach.
    expect(readTxn(sqlite, manual)).toMatchObject({ category_id: groceries, categorization_source: 'manual' });
    expect(readTxn(sqlite, unrelated).category_id).toBeNull();
  });

  it('does not reach a merchant a transfer rule already claims (category rule scoping respects precedence)', () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    const categoryRule = upsertRuleFromCorrection({ pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!categoryRule.ok) throw new Error('unexpected refusal');
    add('PAYMENT - THANK YOU');

    expect(previewRuleReapply(categoryRule.ruleId)).toEqual({ eligible: 0, wouldChange: 0 });
  });

  it('a rename rule has nothing left to apply -- it is already retroactive', () => {
    const { add, userId } = setup();
    add('MCDONALDS');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    expect(previewRuleReapply(upserted.ruleId)).toEqual({ eligible: 0, wouldChange: 0 });
    expect(applyRuleNow(upserted.ruleId)).toMatchObject({ processed: 0 });
  });

  it('an unknown ruleId previews and applies as nothing to do', () => {
    setup();
    expect(previewRuleReapply(999999)).toEqual({ eligible: 0, wouldChange: 0 });
    expect(applyRuleNow(999999)).toMatchObject({ processed: 0, changed: 0 });
  });
});

// v1.21.0 (item 12): "currently affects N transactions", computed on demand, replaces relying on
// hit_count (which a rename rule can never bump -- see bumpRuleUsage's only caller in runEngine).
describe('ruleImpactCounts', () => {
  it('category: counts both an already-settled row and a still-eligible one, never a manual row', () => {
    const { db, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');
    const upserted = upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const alreadySettled = add('TIM HORTONS');
    runEngine([alreadySettled]);
    const stillEligible = add('TIM HORTONS', -500, '2026-03-05');
    const manual = add('TIM HORTONS', -700, '2026-03-06');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manual}`);

    const counts = ruleImpactCounts();
    expect(counts.get(upserted.ruleId)).toBe(2); // alreadySettled + stillEligible, not manual
  });

  it('a rule matching nothing is simply absent from the map (never a false zero-vs-missing ambiguity)', () => {
    const { db, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const upserted = upsertRuleFromCorrection({ pattern: 'NOBODY SHOPS HERE', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    expect(ruleImpactCounts().get(upserted.ruleId) ?? 0).toBe(0);
    expect(db).toBeDefined();
  });

  it('transfer / not_transfer: counts against the CURRENT stored is_transfer flag', () => {
    const { add, userId } = setup();
    const transferRule = upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    if (!transferRule.ok) throw new Error('unexpected refusal');
    const id = add('E-TRANSFER SENT J DOE');
    // Not yet flagged (still 0/false) -- this is exactly what applying the rule would change.
    expect(ruleImpactCounts().get(transferRule.ruleId)).toBe(1);
    runEngine([id]);
    // Now flagged -- the 'transfer' rule's own job is already done, nothing left for it to affect.
    expect(ruleImpactCounts().get(transferRule.ruleId) ?? 0).toBe(0);
  });

  it('rename: counts transactions currently carrying display_source = rename that this rule resolves', () => {
    const { add, userId } = setup();
    const a = add('MCDONALDS');
    const b = add('MCDONALDS', -500, '2026-03-05');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    expect(ruleImpactCounts().get(upserted.ruleId)).toBe(2);
    expect([a, b]).toHaveLength(2);
  });
});

describe('review queue', () => {
  it('contains uncategorized rows and unconfirmed bayes rows only', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes', confidence = 3.1 where id = ${bayesRow}`);
    const ruleRow = add('THIRD SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'rule' where id = ${ruleRow}`);
    const manualRow = add('FOURTH SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manualRow}`);

    expect(reviewQueueIds().sort()).toEqual([uncategorized, bayesRow].sort());
    expect(reviewQueueCount()).toBe(2);
  });

  it('excludes transfers, which never need a category', () => {
    const { add } = setup();
    const transfer = add('PAYMENT - THANK YOU', 50000);
    runEngine([transfer]);
    expect(reviewQueueIds()).not.toContain(transfer);
    expect(reviewQueueCount()).toBe(0);
  });

  it('paginates', () => {
    const { add } = setup();
    const ids = [add('SHOP A'), add('SHOP B'), add('SHOP C')];
    expect(reviewQueueIds(2, 0)).toHaveLength(2);
    expect(reviewQueueIds(2, 2)).toHaveLength(1);
    expect(reviewQueueCount()).toBe(ids.length);
  });
});

/**
 * v1.25.0 Lane R item R1 (deferred from v1.20.0). REVIEW_SUGGESTED_WHERE/REVIEW_UNCATEGORIZED_WHERE
 * are the two "?queue=" chip clauses, meant to be composed as `and(REVIEW_WHERE, <clause>)`
 * (buildWhere, src/lib/transactions.ts) -- never stand alone. This file's own `add()` fixture
 * always inserts `categorization_source = 'none'`, so these queries update it by hand, the same
 * raw-SQL idiom the 'review queue' describe block just above already uses.
 */
describe('review queue chips (v1.25.0 Lane R item R1): REVIEW_SUGGESTED_WHERE / REVIEW_UNCATEGORIZED_WHERE narrow REVIEW_WHERE', () => {
  function idsWhere(clause: NonNullable<typeof REVIEW_WHERE>) {
    return getDb().select({ id: transactions.id }).from(transactions).where(clause).all().map((row) => row.id);
  }

  it('REVIEW_SUGGESTED_WHERE selects only the bayes-guessed row, not the uncategorized one', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${bayesRow}`);

    const ids = idsWhere(and(REVIEW_WHERE, REVIEW_SUGGESTED_WHERE)!);
    expect(ids).toEqual([bayesRow]);
    expect(ids).not.toContain(uncategorized);
  });

  it('REVIEW_UNCATEGORIZED_WHERE selects only the uncategorized row, not the bayes-guessed one', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${bayesRow}`);

    const ids = idsWhere(and(REVIEW_WHERE, REVIEW_UNCATEGORIZED_WHERE)!);
    expect(ids).toEqual([uncategorized]);
    expect(ids).not.toContain(bayesRow);
  });

  it('together the two chips partition REVIEW_WHERE exactly -- their union is the plain queue, and neither overlaps the other', () => {
    const { db, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const uncategorized = add('SOME NEW SHOP');
    const bayesRow = add('ANOTHER SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${bayesRow}`);
    const manualRow = add('THIRD SHOP');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manualRow}`);

    const plain = idsWhere(REVIEW_WHERE!).sort();
    const suggested = idsWhere(and(REVIEW_WHERE, REVIEW_SUGGESTED_WHERE)!);
    const notCategorized = idsWhere(and(REVIEW_WHERE, REVIEW_UNCATEGORIZED_WHERE)!);
    expect(plain).toEqual([uncategorized, bayesRow].sort());
    expect([...suggested, ...notCategorized].sort()).toEqual(plain);
    expect(suggested.some((id) => notCategorized.includes(id))).toBe(false);
  });

  /**
   * The genuine-narrowing property the brief calls out: a row REVIEW_WHERE excludes for a
   * reason that has nothing to do with categoryId/source (a transfer, here) must stay excluded
   * under EVERY chip, even though it would satisfy REVIEW_UNCATEGORIZED_WHERE evaluated alone
   * (categoryId is null on a transfer row too). Composing as `and(REVIEW_WHERE, <clause>)`
   * rather than `<clause>` alone is what buildWhere (src/lib/transactions.ts) actually does; this
   * proves that composition, not a standalone use of either constant, is what a caller must do.
   */
  it('a row REVIEW_WHERE excludes (a transfer) stays excluded under both chips, even though it would match REVIEW_UNCATEGORIZED_WHERE alone', () => {
    const { add } = setup();
    const transfer = add('PAYMENT - THANK YOU', 50000);
    runEngine([transfer]); // flags is_transfer = true, category_id stays null

    // Evaluated ALONE (the bug this composition rule prevents), the transfer row WOULD match --
    // it has no category. This is the trap: a caller who forgot to AND against REVIEW_WHERE
    // would silently let transfers leak into the "Not categorized" chip.
    expect(idsWhere(REVIEW_UNCATEGORIZED_WHERE)).toContain(transfer);

    // Composed correctly (what buildWhere actually does), it does not.
    expect(idsWhere(and(REVIEW_WHERE, REVIEW_SUGGESTED_WHERE)!)).not.toContain(transfer);
    expect(idsWhere(and(REVIEW_WHERE, REVIEW_UNCATEGORIZED_WHERE)!)).not.toContain(transfer);
  });
});

/**
 * 2026-08-30 fix: assigning a transaction to a loan writes a loan_payments row (see
 * src/lib/loans.ts's assignTransactionToLoan) and never touches category_id or
 * categorization_source -- so, before this fix, a loan-linked row a person had already dealt
 * with kept coming back to the review queue forever, exactly because nothing about its category
 * ever changed. These tests are the executable proof the new clause on REVIEW_WHERE closes that:
 * a loan link is a decision, and it takes the row out of the queue the same way confirming a
 * category or splitting a row already does; undoing the link is undoing the decision, so the
 * row is undecided again.
 */
describe('review queue: a loan link is a decision (2026-08-30 fix)', () => {
  /** Seeds a loan-kind warranty item and links `txnId` to it via a real loan_payments row, the
   *  same raw-SQL shape tests/lib/item-ledger.test.ts already uses for the same table -- this
   *  file has no fixture of its own for warranty items, so it is inserted directly here rather
   *  than pulled in from another test file's helper. */
  function linkToLoan(db: TestDb['db'], userId: number, txnId: number): number {
    const now = nowIso();
    // migration 0004 already seeds a default 'Loan' item type on every fresh db (it backfills one
    // for exactly this reason, so createLoanFromTransaction always has one to use) -- inserting a
    // second row with that same name collides with warranty_item_types_name_uq's COLLATE NOCASE
    // unique index, so this looks the existing one up instead of inserting another.
    const typeId = db.get<{ id: number }>(sql`select id from warranty_item_types where name = 'Loan' collate nocase limit 1`).id;
    const itemId = db.get<{ id: number }>(sql`
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, created_at, updated_at)
      values ('Car Loan', '2026-01-01', 0, ${userId}, ${typeId}, 'owed', ${now}, ${now}) returning id`).id;
    db.run(sql`insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
               values (${txnId}, ${itemId}, 1000, 1000, 'manual', ${now})`);
    return itemId;
  }

  it('a loan-linked, uncategorized row is absent from the queue and its count', () => {
    const { db, userId, add } = setup();
    const linked = add('CAR LOAN PAYMENT');
    linkToLoan(db, userId, linked);

    expect(reviewQueueIds()).not.toContain(linked);
    expect(reviewQueueCount()).toBe(0);
  });

  it('an unlinked, uncategorized control row is still present', () => {
    const { db, userId, add } = setup();
    const linked = add('CAR LOAN PAYMENT');
    linkToLoan(db, userId, linked);
    const control = add('SOME NEW SHOP');

    expect(reviewQueueIds()).toEqual([control]);
    expect(reviewQueueCount()).toBe(1);
  });

  it('a bayes-guessed, loan-linked row is absent too, not just an uncategorized one', () => {
    const { db, userId, add } = setup();
    const groceries = categoryIdByName(db, 'Groceries');
    const linked = add('CAR LOAN PAYMENT');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'bayes' where id = ${linked}`);
    linkToLoan(db, userId, linked);

    expect(reviewQueueIds()).not.toContain(linked);
    expect(reviewQueueCount()).toBe(0);
  });

  it('unlinking the transaction from its loan puts it back in the queue -- undecided again', () => {
    const { db, userId, add } = setup();
    const txnId = add('CAR LOAN PAYMENT');
    const itemId = linkToLoan(db, userId, txnId);
    expect(reviewQueueIds()).not.toContain(txnId);

    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);

    expect(reviewQueueIds()).toContain(txnId);
    expect(reviewQueueCount()).toBe(1);
  });
});

describe('v1.12.1: clearCategory only deletes a rule when told to (item U, ruling P5)', () => {
  /** setupConfirmed(): the same three lines behind "clearCategory untrains and returns the row
   *  to uncategorized" above, factored out for this describe's two deleteRule cases. */
  function setupConfirmed() {
    const { db, sqlite, add, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const id = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId, actorRole: 'admin' }).ok).toBe(true);
    return { db, sqlite, id, userId };
  }

  it('deleteRule: false leaves the merchant rule in place and still untrains', () => {
    const { db, id, userId } = setupConfirmed();
    expect(db.get<{ n: number }>(sql`select count(*) as n from merchant_rules`).n).toBe(1);

    expect(clearCategory({ transactionId: id, userId, deleteRule: false })).toBe(true);

    expect(db.get<{ n: number }>(sql`select count(*) as n from merchant_rules`).n).toBe(1);
    expect(db.get<{ c: number | null }>(sql`select category_id as c from transactions where id = ${id}`).c).toBeNull();
  });

  it('deleteRule: true still deletes it, for the deliberate control that asks for that', () => {
    const { db, id, userId } = setupConfirmed();
    expect(clearCategory({ transactionId: id, userId, deleteRule: true })).toBe(true);
    expect(db.get<{ n: number }>(sql`select count(*) as n from merchant_rules`).n).toBe(0);
  });
});

/**
 * v1.13.0 ruling R4, fix round 1 (item AH / SEC-6). The reviewer's finding: confirmCategory,
 * setTransferFlag and applyCategoryToMatching each learn/refuse a merchant rule internally, but
 * only upsertRenameRule (Task 8's original scope) actually threaded a real actorRole through to
 * upsertRuleFromCorrection -- these three hard-coded 'admin' and so silently ignored R4 for
 * every member-facing writer that reaches them (acceptGuessAction, fixCategoryAction,
 * applyToAllMatchingAction, markTransferAction). This block is the executable proof that is
 * fixed: a member refused against a foreign-owned rule, an admin unrestricted, and a member
 * updating their own rule -- for all three functions -- with the transaction row(s) provably
 * untouched on refusal.
 */
describe('ruling R4, fix round 1: confirmCategory / setTransferFlag / applyCategoryToMatching honour rule ownership', () => {
  function setupTwoUsers() {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin Owner', username: 'admin-owner', role: 'admin' });
    const memberId = insertTestUser(current.db, { name: 'Member Other', username: 'member-other', role: 'member' });
    const accountId = insertTestAccount(current.db);
    const add = (rawDescription: string, amountCents = -1000, date = '2026-03-02') => {
      const row = current!.db.get<{ id: number }>(sql`
        insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
        values (${accountId}, ${date}, ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents}, 'none', ${adminId}, ${nowIso()}, ${nowIso()})
        returning id`);
      return row.id;
    };
    return { db: current.db, sqlite: current.sqlite, adminId, memberId, add };
  }

  describe('confirmCategory', () => {
    it('a member cannot overwrite an admin-owned category rule; the row and the rule stay untouched', () => {
      const { db, sqlite, adminId, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      const first = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
      expect(confirmCategory({ transactionId: first, categoryId: coffee, userId: adminId, actorRole: 'admin' }).ok).toBe(true);

      const second = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -500, '2026-03-03');
      const result = confirmCategory({ transactionId: second, categoryId: groceries, userId: memberId, actorRole: 'member' });
      expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });

      expect(readTxn(sqlite, second)).toMatchObject({ category_id: null, categorization_source: 'none' });
      expect(readTxn(sqlite, first)).toMatchObject({ category_id: coffee, categorization_source: 'manual' });
      expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(coffee);
    });

    it('an admin can overwrite anyone\'s rule', () => {
      const { db, sqlite, adminId, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      const first = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
      expect(confirmCategory({ transactionId: first, categoryId: coffee, userId: memberId, actorRole: 'member' }).ok).toBe(true);

      const second = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -500, '2026-03-03');
      expect(confirmCategory({ transactionId: second, categoryId: groceries, userId: adminId, actorRole: 'admin' }).ok).toBe(true);
      expect(readTxn(sqlite, second).category_id).toBe(groceries);
    });

    it('a member can update a rule they own themselves', () => {
      const { db, sqlite, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      const first = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON');
      expect(confirmCategory({ transactionId: first, categoryId: coffee, userId: memberId, actorRole: 'member' }).ok).toBe(true);

      const second = add('POS PURCHASE TIM HORTONS #4821 TORONTO ON', -500, '2026-03-03');
      expect(confirmCategory({ transactionId: second, categoryId: groceries, userId: memberId, actorRole: 'member' }).ok).toBe(true);
      expect(readTxn(sqlite, second).category_id).toBe(groceries);
    });
  });

  describe('setTransferFlag', () => {
    it('a member cannot overwrite an admin-owned transfer rule; is_transfer stays untouched', () => {
      const { sqlite, adminId, memberId, add } = setupTwoUsers();
      const first = add('ACME PAYROLL CO', -500, '2026-03-02');
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: adminId, actorRole: 'admin', learnRule: true }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      const result = setTransferFlag({ transactionId: second, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true });
      expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });

      expect(readTxn(sqlite, second).is_transfer).toBe(0);
      expect(readTxn(sqlite, first).is_transfer).toBe(1);
      expect(listRules('transfer')).toHaveLength(1);
    });

    it('an admin can overwrite anyone\'s transfer rule', () => {
      const { sqlite, adminId, memberId, add } = setupTwoUsers();
      const first = add('ACME PAYROLL CO', -500, '2026-03-02');
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      expect(setTransferFlag({ transactionId: second, isTransfer: true, userId: adminId, actorRole: 'admin', learnRule: true }).ok).toBe(true);
      expect(readTxn(sqlite, second).is_transfer).toBe(1);
    });

    it('a member can update a transfer rule they own themselves', () => {
      const { sqlite, memberId, add } = setupTwoUsers();
      const first = add('ACME PAYROLL CO', -500, '2026-03-02');
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      expect(setTransferFlag({ transactionId: second, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true }).ok).toBe(true);
      expect(readTxn(sqlite, second).is_transfer).toBe(1);
    });
  });

  describe('applyCategoryToMatching', () => {
    it('a member cannot overwrite an admin-owned rule; NOT ONE matching row is touched', () => {
      const { db, sqlite, adminId, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      // The admin owns this exact rule already, e.g. from Settings -> Rules. Seeded directly
      // (rather than through a matching transaction) so the count assertions below are exact.
      upsertRuleFromCorrection({
        pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: adminId, actorRole: 'admin',
      });

      const a = add('TIM HORTONS', -700, '2026-03-04');
      const b = add('TIM HORTONS', -800, '2026-03-05');
      const result = applyCategoryToMatching({ normalizedMerchant: 'TIM HORTONS', categoryId: groceries, userId: memberId, actorRole: 'member' });
      expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });

      expect(readTxn(sqlite, a).category_id).toBeNull();
      expect(readTxn(sqlite, b).category_id).toBeNull();
      expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(coffee);
    });

    it('an admin can overwrite anyone\'s rule and applies to every matching row', () => {
      const { db, sqlite, adminId, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      upsertRuleFromCorrection({
        pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: memberId, actorRole: 'member',
      });

      const a = add('TIM HORTONS', -700, '2026-03-04');
      const b = add('TIM HORTONS', -800, '2026-03-05');
      const result = applyCategoryToMatching({ normalizedMerchant: 'TIM HORTONS', categoryId: groceries, userId: adminId, actorRole: 'admin' });
      expect(result).toEqual({ ok: true, count: 2 });
      expect(readTxn(sqlite, a).category_id).toBe(groceries);
      expect(readTxn(sqlite, b).category_id).toBe(groceries);
    });

    it('a member can apply-to-all against a rule they own themselves', () => {
      const { db, sqlite, memberId, add } = setupTwoUsers();
      const coffee = categoryIdByName(db, 'Coffee');
      const groceries = categoryIdByName(db, 'Groceries');
      upsertRuleFromCorrection({
        pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: memberId, actorRole: 'member',
      });

      const a = add('TIM HORTONS', -700, '2026-03-04');
      const result = applyCategoryToMatching({ normalizedMerchant: 'TIM HORTONS', categoryId: groceries, userId: memberId, actorRole: 'member' });
      expect(result).toEqual({ ok: true, count: 1 });
      expect(readTxn(sqlite, a).category_id).toBe(groceries);
    });
  });
});

describe('ruling R4, fix round 2 (item BJ): setTransferFlag refuses over the rule it would DELETE', () => {
  function setupOwnedRule(opts: { cardPattern?: boolean; startFlagged?: boolean } = {}) {
    current = createSeededTestDb();
    const adminId = insertTestUser(current.db, { name: 'Admin Owner', username: 'admin-owner-bj', role: 'admin' });
    const memberId = insertTestUser(current.db, { name: 'Member Other', username: 'member-other-bj', role: 'member' });
    const accountId = insertTestAccount(current.db);
    const raw = opts.cardPattern ? 'TD VISA PAYMENT' : 'ACME PAYROLL CO';
    const merchant = normalizeMerchant(raw);
    const row = current.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, is_transfer, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${raw}, ${merchant}, -500, 'none', ${opts.startFlagged ? 1 : 0}, ${adminId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return { adminId, memberId, txnId: row.id, merchant };
  }

  function isTransferOf(txnId: number): boolean {
    return readTxn(current!.sqlite, txnId).is_transfer === 1;
  }

  it('refuses a member re-flagging a merchant whose not_transfer rule an admin owns', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: adminId, actorRole: 'admin',
    });

    const result = setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true });

    // The whole action refuses. An "optional owner check" that still deletes on a refusal is
    // not this fix -- every sibling R4 writer leaves every row and every rule untouched.
    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });
    expect(exactRuleOwner(merchant, 'not_transfer')).not.toBeNull();
    expect(exactRuleOwner(merchant, 'transfer')).toBeNull();
    expect(isTransferOf(txnId)).toBe(false);
  });

  it('refuses a member un-flagging a card-pattern merchant whose transfer rule an admin owns', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule({ cardPattern: true, startFlagged: true });
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: adminId, actorRole: 'admin',
    });

    const result = setTransferFlag({ transactionId: txnId, isTransfer: false, userId: memberId, actorRole: 'member', learnRule: true });

    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });
    expect(exactRuleOwner(merchant, 'transfer')).not.toBeNull();
    expect(isTransferOf(txnId)).toBe(true);
  });

  it('lets an admin delete anyone\'s opposite-kind rule', () => {
    const { adminId, memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: memberId, actorRole: 'member',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: adminId, actorRole: 'admin', learnRule: true })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('lets a member delete their OWN opposite-kind rule', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: memberId, actorRole: 'member',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('deletes an ownerless rule as before', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: null, actorRole: 'admin',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member', learnRule: true })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });
});

/**
 * v1.24.0 (owner ask: "user deletes the rule but nothing gets fixed... delete rule and remove it
 * from transactions, all or for a date range"). Two things are being pinned here, and the first
 * matters more than it looks: ruleImpactIds must agree EXACTLY with ruleImpactCounts, because the
 * rules table shows the count and the dialog's button acts on the ids. If those two definitions
 * ever drift, the app states a number it does not honour -- which is worse than stating none.
 */
describe('ruleImpactIds (v1.24.0: the ids behind the "Affects" figure)', () => {
  function threeMonths() {
    const fixture = setup();
    const coffee = categoryIdByName(fixture.db, 'Coffee');
    const jan = fixture.add('TIM HORTONS', -1000, '2026-01-15');
    const feb = fixture.add('TIM HORTONS', -1100, '2026-02-01');
    const mar = fixture.add('TIM HORTONS', -1200, '2026-03-31');
    const upserted = upsertRuleFromCorrection({
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category',
      categoryId: coffee, createdBy: fixture.userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    runEngine([jan, feb, mar]);
    return { ...fixture, coffee, jan, feb, mar, ruleId: upserted.ruleId };
  }

  it('with no scope, returns exactly as many ids as ruleImpactCounts reports for the same rule', () => {
    const { db, add, ruleId, jan, feb, mar } = threeMonths();
    // Noise the two definitions must both exclude, in the same way: a hand-decided row and a
    // row at a merchant this rule does not reach.
    const manual = add('TIM HORTONS', -700, '2026-02-10');
    db.run(sql`update transactions set category_id = ${categoryIdByName(db, 'Groceries')}, categorization_source = 'manual' where id = ${manual}`);
    add('SOME OTHER SHOP', -500, '2026-02-11');

    const ids = ruleImpactIds(ruleId);
    expect(ids).toEqual([jan, feb, mar]);
    expect(ids).toHaveLength(ruleImpactCounts().get(ruleId)!);
  });

  it('a date range narrows it, and BOTH bounds are inclusive', () => {
    const { ruleId, jan, feb, mar } = threeMonths();
    expect(ruleImpactIds(ruleId, { from: '2026-02-01', to: '2026-03-31' })).toEqual([feb, mar]);
    expect(ruleImpactIds(ruleId, { from: '2026-01-15', to: '2026-02-01' })).toEqual([jan, feb]);
    // One-sided ranges: null/absent means unbounded on that side.
    expect(ruleImpactIds(ruleId, { from: '2026-03-31' })).toEqual([mar]);
    expect(ruleImpactIds(ruleId, { to: '2026-01-15' })).toEqual([jan]);
    expect(ruleImpactIds(ruleId, { from: null, to: null })).toEqual([jan, feb, mar]);
  });

  it('an unknown ruleId resolves to no ids at all', () => {
    threeMonths();
    expect(ruleImpactIds(999999)).toEqual([]);
  });

  it('rename: matches ruleImpactCounts for the same rule', () => {
    const { add, userId } = setup();
    add('MCDONALDS', -900, '2026-01-05');
    add('MCDONALDS', -900, '2026-02-05');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    expect(ruleImpactIds(upserted.ruleId)).toHaveLength(ruleImpactCounts().get(upserted.ruleId)!);
  });

  it('transfer: matches ruleImpactCounts, which for this kind means the rows NOT yet flagged', () => {
    const { add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE', -5000, '2026-02-02');
    const upserted = upsertRuleFromCorrection({
      pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    expect(ruleImpactIds(upserted.ruleId)).toEqual([id]);
    expect(ruleImpactIds(upserted.ruleId)).toHaveLength(ruleImpactCounts().get(upserted.ruleId)!);
    // Once flagged, the FORWARD-looking "affects" set is empty -- and the set a CLEAR would write
    // to is the mirror image. This asymmetry is the whole reason ruleClearIds exists.
    runEngine([id]);
    expect(ruleImpactIds(upserted.ruleId)).toEqual([]);
    expect(ruleClearIds(upserted.ruleId)).toEqual([id]);
  });
});

describe('clearRuleFromTransactions (v1.24.0: "we can set those transactions as uncategorized")', () => {
  function categorized() {
    const fixture = setup();
    const coffee = categoryIdByName(fixture.db, 'Coffee');
    const jan = fixture.add('TIM HORTONS', -1000, '2026-01-15');
    const feb = fixture.add('TIM HORTONS', -1100, '2026-02-14');
    const mar = fixture.add('TIM HORTONS', -1200, '2026-03-31');
    const upserted = upsertRuleFromCorrection({
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category',
      categoryId: coffee, createdBy: fixture.userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    runEngine([jan, feb, mar]);
    return { ...fixture, coffee, jan, feb, mar, ruleId: upserted.ruleId };
  }

  it('clears exactly the scoped rows and leaves rows outside the range untouched', () => {
    const { sqlite, coffee, jan, feb, mar, ruleId } = categorized();
    const result = clearRuleFromTransactions({ ruleId, scope: { from: '2026-02-01', to: '2026-02-28' } });
    expect(result).toEqual({ rowsCleared: 1 });
    expect(readTxn(sqlite, feb)).toMatchObject({ category_id: null, categorization_source: 'none', confidence: null });
    expect(readTxn(sqlite, jan)).toMatchObject({ category_id: coffee, categorization_source: 'rule' });
    expect(readTxn(sqlite, mar)).toMatchObject({ category_id: coffee, categorization_source: 'rule' });
  });

  it('with no scope, clears every row the rule set', () => {
    const { sqlite, jan, feb, mar, ruleId } = categorized();
    expect(clearRuleFromTransactions({ ruleId })).toEqual({ rowsCleared: 3 });
    for (const id of [jan, feb, mar]) {
      expect(readTxn(sqlite, id)).toMatchObject({ category_id: null, categorization_source: 'none' });
    }
  });

  it('a cleared row genuinely comes back to the review queue (REVIEW_WHERE, not just the columns)', () => {
    const { jan, feb, mar, ruleId } = categorized();
    expect(reviewQueueCount()).toBe(0); // all three settled by the rule
    clearRuleFromTransactions({ ruleId });
    expect(reviewQueueIds().sort()).toEqual([jan, feb, mar].sort());
    expect(reviewQueueCount()).toBe(3);
  });

  it('NEVER clears a manually-categorized row, whatever its date', () => {
    const { db, sqlite, add, ruleId } = categorized();
    const groceries = categoryIdByName(db, 'Groceries');
    const manual = add('TIM HORTONS', -700, '2026-02-20');
    db.run(sql`update transactions set category_id = ${groceries}, categorization_source = 'manual' where id = ${manual}`);

    clearRuleFromTransactions({ ruleId });
    expect(readTxn(sqlite, manual)).toMatchObject({ category_id: groceries, categorization_source: 'manual' });
    expect(reviewQueueIds()).not.toContain(manual);
  });

  it('NEVER clears a split row -- its parts ARE its categorization (spec ruling 2a)', () => {
    const { db, sqlite, add, coffee, ruleId } = categorized();
    const split = add('TIM HORTONS', -2000, '2026-02-21');
    db.run(sql`update transactions set category_id = ${coffee}, categorization_source = 'rule' where id = ${split}`);
    db.run(sql`insert into transaction_splits (txn_id, category_id, amount_cents, created_at)
               values (${split}, ${coffee}, -2000, ${nowIso()})`);

    clearRuleFromTransactions({ ruleId });
    expect(readTxn(sqlite, split)).toMatchObject({ category_id: coffee, categorization_source: 'rule' });
  });

  it('does NOT untrain: the Bayes set is fed only by manual confirmations, never by a rule', () => {
    const { db, sqlite, add, userId, ruleId } = categorized();
    const restaurants = categoryIdByName(db, 'Restaurants');
    // A manual confirmation is the ONLY thing that ever feeds the Bayes set (confirmCategory's
    // train() is its single writer), so the training below belongs to a HUMAN decision at this
    // merchant, not to the rule being cleared. Read straight off the table rather than through
    // classify(), which needs a runner-up category and a margin over the threshold before it
    // returns anything -- that gate would make this assertion pass vacuously.
    const trained = add('TIM HORTONS', -800, '2026-02-22');
    confirmCategory({ transactionId: trained, categoryId: restaurants, userId, createRule: false, actorRole: 'admin' });
    const training = () => sqlite.prepare('select token, category_id, count from bayes_tokens order by token, category_id').all();
    const before = training();
    expect(before.length).toBeGreaterThan(0);

    clearRuleFromTransactions({ ruleId });
    expect(training()).toEqual(before);
  });

  it('does NOT re-run the other rules, so a broader rule cannot silently re-categorize the cleared rows', () => {
    const { db, sqlite, jan, feb, mar, ruleId, userId } = categorized();
    const restaurants = categoryIdByName(db, 'Restaurants');
    upsertRuleFromCorrection({
      pattern: 'TIM', matchType: 'contains', ruleKind: 'category',
      categoryId: restaurants, createdBy: userId, actorRole: 'admin',
    });
    clearRuleFromTransactions({ ruleId });
    for (const id of [jan, feb, mar]) {
      expect(readTxn(sqlite, id)).toMatchObject({ category_id: null, categorization_source: 'none' });
    }
  });

  it('transfer: clears the flag on the rows it already flagged, without inventing an override rule', () => {
    const { sqlite, add, userId } = setup();
    const jan = add('E-TRANSFER SENT J DOE', -5000, '2026-01-10');
    const feb = add('E-TRANSFER SENT J DOE', -5000, '2026-02-10');
    const upserted = upsertRuleFromCorrection({
      pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    runEngine([jan, feb]);
    expect(readTxn(sqlite, jan).is_transfer).toBe(1);

    const result = clearRuleFromTransactions({ ruleId: upserted.ruleId, scope: { from: '2026-02-01' } });
    expect(result).toEqual({ rowsCleared: 1 });
    expect(readTxn(sqlite, feb).is_transfer).toBe(0);
    expect(readTxn(sqlite, jan).is_transfer).toBe(1);
    // setTransferFlag's rule housekeeping (which would have created a 'not_transfer' override)
    // is deliberately NOT on this path -- a bulk revert must not author a brand-new rule.
    expect(listRules('not_transfer')).toHaveLength(0);
  });

  it('not_transfer: returns 0 and writes nothing -- re-flagging rows AS transfers is not a revert', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000, '2026-02-02');
    runEngine([id]);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    const upserted = upsertRuleFromCorrection({
      pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');

    expect(clearRuleFromTransactions({ ruleId: upserted.ruleId })).toEqual({ rowsCleared: 0 });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(ruleClearIds(upserted.ruleId)).toEqual([]);
  });

  it('rename: IGNORES the date range and reverts every row, because a bounded revert would unwind later', () => {
    const { sqlite, add, userId } = setup();
    const jan = add('MCDONALDS', -900, '2026-01-05');
    const mar = add('MCDONALDS', -900, '2026-03-05');
    const upserted = upsertRenameRule({ pattern: 'MCDONALDS', matchType: 'exact', renameTo: "McDonald's", userId, actorRole: 'admin' });
    if (!upserted.ok) throw new Error('unexpected refusal');
    const display = (id: number) =>
      sqlite.prepare('select display_description, display_source from transactions where id = ?').get(id) as {
        display_description: string | null;
        display_source: string | null;
      };
    expect(display(jan).display_description).toBe("McDonald's");

    // A range that names only March: both rows still revert, and the rule is gone.
    expect(clearRuleFromTransactions({ ruleId: upserted.ruleId, scope: { from: '2026-03-01' } })).toEqual({ rowsCleared: 2 });
    expect(display(jan)).toMatchObject({ display_description: null, display_source: null });
    expect(display(mar)).toMatchObject({ display_description: null, display_source: null });
    expect(listRules('rename')).toHaveLength(0);
  });

  it('an unknown ruleId clears nothing', () => {
    const { sqlite, jan, coffee } = categorized();
    expect(clearRuleFromTransactions({ ruleId: 999999 })).toEqual({ rowsCleared: 0 });
    expect(readTxn(sqlite, jan)).toMatchObject({ category_id: coffee });
  });
});

/**
 * v1.24.0: "date should be on re-apply logic too". A bounded re-apply is safe for every kind
 * because re-applying only ever ADDS -- which is exactly why the bound is offered here and refused
 * for a rename revert.
 */
describe('scoped re-apply (v1.24.0: a date range on eligibleForRerun / rerunEngine / applyRuleNow)', () => {
  function twoMonths() {
    const fixture = setup();
    const coffee = categoryIdByName(fixture.db, 'Coffee');
    const jan = fixture.add('TIM HORTONS', -1000, '2026-01-15');
    const mar = fixture.add('TIM HORTONS', -1200, '2026-03-31');
    const upserted = upsertRuleFromCorrection({
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category',
      categoryId: coffee, createdBy: fixture.userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    return { ...fixture, coffee, jan, mar, ruleId: upserted.ruleId };
  }

  it('eligibleForRerun honours both bounds inclusively, and still honours accountId', () => {
    const { accountId, jan, mar } = twoMonths();
    expect(eligibleForRerun()).toEqual([jan, mar]);
    expect(eligibleForRerun({ from: '2026-02-01' })).toEqual([mar]);
    expect(eligibleForRerun({ to: '2026-01-15' })).toEqual([jan]);
    expect(eligibleForRerun({ from: '2026-01-15', to: '2026-03-31' })).toEqual([jan, mar]);
    expect(eligibleForRerun({ accountId, from: '2026-03-31' })).toEqual([mar]);
    expect(eligibleForRerun({ accountId: accountId + 999, from: '2026-01-01' })).toEqual([]);
  });

  it('rerunEngine only looks at the rows in range', () => {
    const { sqlite, coffee, jan, mar } = twoMonths();
    const result = rerunEngine({ from: '2026-02-01' });
    expect(result).toMatchObject({ processed: 1, changed: 1 });
    expect(readTxn(sqlite, mar).category_id).toBe(coffee);
    expect(readTxn(sqlite, jan).category_id).toBeNull();
  });

  it('previewRuleReapply and applyRuleNow take the same range, and agree with each other', () => {
    const { sqlite, coffee, jan, mar, ruleId } = twoMonths();
    expect(previewRuleReapply(ruleId, { from: '2026-02-01' })).toEqual({ eligible: 1, wouldChange: 1 });
    expect(applyRuleNow(ruleId, { from: '2026-02-01' })).toMatchObject({ processed: 1, changed: 1 });
    expect(readTxn(sqlite, mar).category_id).toBe(coffee);
    expect(readTxn(sqlite, jan).category_id).toBeNull();
  });
});

/**
 * v1.31.0 R-01 (P1). `matchTypeAllowedForKind` refuses only `word` on a transfer kind, so the
 * rules form and the pack importer have always accepted a `contains` transfer rule, and matchRule
 * has always fired it as a substring match -- while all four attribution functions looked rows up
 * by `normalized_merchant = rule.pattern`, on the strength of six docblocks asserting an invariant
 * nothing enforced. The visible damage was the delete-and-clear button: it previewed the exact-text
 * rows, un-flagged only those, and stranded every substring-matched row as a transfer -- excluded
 * from every report and budget -- with the rule gone and nothing left to attribute them to.
 *
 * These tests pin attribution to what the engine ACTUALLY does (matchRule + detectTransfer), for
 * every match type the app accepts, so the fix cannot regress into the shortcut again.
 */
describe('v1.31.0 R-01: transfer attribution simulates the match instead of assuming exact', () => {
  function containsPaymentTransfer() {
    const fixture = setup();
    // Three merchants the rule matches and only ONE of which equals its pattern. The first is also
    // in CARD_PAYMENT_PATTERNS, which is deliberate: the card list flags it either way, and the
    // rule still claims it, exactly as an exact rule on that text does today.
    const thankYou = fixture.add('PAYMENT - THANK YOU', 50000, '2026-01-10');
    const cc = fixture.add('CC PAYMENT 1234', 25000, '2026-02-10');
    const bare = fixture.add('PAYMENT', 10000, '2026-03-10');
    const upserted = upsertRuleFromCorrection({
      pattern: 'PAYMENT', matchType: 'contains', ruleKind: 'transfer',
      categoryId: null, createdBy: fixture.userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');
    return { ...fixture, thankYou, cc, bare, ruleId: upserted.ruleId };
  }

  it('counts, ids and re-apply scope all reach every substring-matched row, not just the exact one', () => {
    const { sqlite, thankYou, cc, bare, ruleId } = containsPaymentTransfer();

    // "Affects", for a transfer rule, is the FORWARD-looking set: rows not yet flagged that
    // applying the rule would flip. All three qualify; the shortcut saw only `bare`.
    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(3);
    expect(ruleImpactIds(ruleId)).toEqual([thankYou, cc, bare]);
    expect(previewRuleReapply(ruleId)).toEqual({ eligible: 3, wouldChange: 3 });

    runEngine([thankYou, cc, bare]);
    for (const id of [thankYou, cc, bare]) expect(readTxn(sqlite, id).is_transfer).toBe(1);

    // Now the forward-looking set is empty and the CLEAR set is its mirror image -- all three.
    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(0);
    expect(ruleClearIds(ruleId)).toEqual([thankYou, cc, bare]);
  });

  it('delete-and-clear leaves NO row still flagged by the rule it deleted', () => {
    const { sqlite, thankYou, cc, bare, ruleId } = containsPaymentTransfer();
    runEngine([thankYou, cc, bare]);

    // The order deleteRuleAndClearAction uses, and it is load-bearing: attribution is derived, so
    // the rule must still exist while the rows are being resolved.
    expect(clearRuleFromTransactions({ ruleId })).toEqual({ rowsCleared: 3 });
    deleteRule(ruleId);

    for (const id of [thankYou, cc, bare]) expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(0);
    // No override rule invented as a side effect of a bulk revert.
    expect(listRules('not_transfer')).toHaveLength(0);
  });

  it('a date range still narrows the clear, and rows outside it keep their flag', () => {
    const { sqlite, thankYou, cc, bare, ruleId } = containsPaymentTransfer();
    runEngine([thankYou, cc, bare]);
    expect(clearRuleFromTransactions({ ruleId, scope: { from: '2026-02-01' } })).toEqual({ rowsCleared: 2 });
    expect(readTxn(sqlite, thankYou).is_transfer).toBe(1);
    expect(readTxn(sqlite, cc).is_transfer).toBe(0);
    expect(readTxn(sqlite, bare).is_transfer).toBe(0);
  });

  it('an exact transfer rule behaves exactly as it always has -- this is a strict widening', () => {
    const { sqlite, add, userId } = setup();
    const exact = add('E-TRANSFER SENT J DOE', -5000, '2026-02-02');
    const longer = add('E-TRANSFER SENT J DOE RENT', -5000, '2026-02-03');
    const upserted = upsertRuleFromCorrection({
      pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!upserted.ok) throw new Error('unexpected refusal');

    expect(ruleImpactCounts().get(upserted.ruleId) ?? 0).toBe(1);
    expect(ruleImpactIds(upserted.ruleId)).toEqual([exact]);
    expect(previewRuleReapply(upserted.ruleId)).toEqual({ eligible: 1, wouldChange: 1 });
    runEngine([exact, longer]);
    expect(readTxn(sqlite, longer).is_transfer).toBe(0);
    expect(ruleClearIds(upserted.ruleId)).toEqual([exact]);
  });

  it('a not_transfer override still wins over a contains transfer rule that also matches', () => {
    const { sqlite, thankYou, cc, bare, ruleId, userId } = containsPaymentTransfer();
    const override = upsertRuleFromCorrection({
      pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!override.ok) throw new Error('unexpected refusal');

    // detectTransfer refuses the merchant outright, so the transfer rule cannot claim its row --
    // an "Affects" figure that counted it would promise a flip that will never happen.
    expect(detectTransfer('PAYMENT - THANK YOU', buildContext())).toBe(false);
    expect(ruleImpactIds(ruleId)).toEqual([cc, bare]);
    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(2);

    runEngine([thankYou, cc, bare]);
    expect(readTxn(sqlite, thankYou).is_transfer).toBe(0);
    expect(ruleClearIds(ruleId)).toEqual([cc, bare]);
    expect(clearRuleFromTransactions({ ruleId })).toEqual({ rowsCleared: 2 });
    expect(readTxn(sqlite, thankYou).is_transfer).toBe(0);
  });

  it('a contains not_transfer rule is attributed the same way, by simulation', () => {
    const { sqlite, add, userId } = setup();
    // Two merchants the card-payment list flags, one of which a contains override releases.
    const released = add('VISA PAYMENT MONTREAL', 40000, '2026-02-05');
    const kept = add('AMEX PAYMENT', 30000, '2026-02-06');
    runEngine([released, kept]);
    expect(readTxn(sqlite, released).is_transfer).toBe(1);

    const override = upsertRuleFromCorrection({
      pattern: 'VISA PAYMENT', matchType: 'contains', ruleKind: 'not_transfer',
      categoryId: null, createdBy: userId, actorRole: 'admin',
    });
    if (!override.ok) throw new Error('unexpected refusal');

    // "Affects" for not_transfer is the currently-FLAGGED rows it releases: the substring one too.
    expect(ruleImpactCounts().get(override.ruleId) ?? 0).toBe(1);
    expect(ruleImpactIds(override.ruleId)).toEqual([released]);
    // Clearing a not_transfer override stays refused -- re-flagging rows AS transfers is not a revert.
    expect(ruleClearIds(override.ruleId)).toEqual([]);
  });
});

/**
 * v1.31.0 review finding R-02 (P2). A category rule with no category used to be accepted, WIN its
 * merchant in matchRule (longest pattern first), and then decline to act -- so the shorter rule
 * that would have filed the merchant never got asked, the null rule's own "Affects" column read 0,
 * and the household saw a rule, no error, and a merchant that had silently stopped being
 * categorised by anything.
 */
describe('v1.31.0 R-02: a rule with no outcome can neither fire nor shadow', () => {
  /**
   * The offending row is written STRAIGHT TO THE TABLE, and as of v1.31.0 R-09 that is the only
   * way it can be written at all -- which is the point of both findings taken together.
   *
   * These two tests used to build their subject through upsertRuleFromCorrection, under a comment
   * saying that stood in for "a row that predates the guard, or a hand-edited database". It did
   * not: upsertRuleFromCorrection is this app's write choke point, so the comment was describing
   * a back door as if it were a museum piece while the door was open. R-09 shut it (the upsert now
   * throws for a kind whose outcome is missing, using the same ruleOutcomeMissing predicate
   * matchRule uses to skip one). So the row is inserted the way ruleOutcomeMissing's own docblock
   * says such a row arrives -- raw SQL, no helper -- and the READ-side backstop is now tested
   * against the only state that can actually reach it.
   */
  const insertRawRule = (
    sqlite: TestDb['sqlite'],
    row: { pattern: string; matchType: string; ruleKind: string; categoryId: number | null; renameTo: string | null },
  ) =>
    sqlite
      .prepare(
        `insert into merchant_rules (pattern, match_type, rule_kind, category_id, rename_to, hit_count, created_at)
         values (?, ?, ?, ?, ?, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run(row.pattern, row.matchType, row.ruleKind, row.categoryId, row.renameTo);

  it('a null-category rule no longer blocks the shorter rule that can actually file the merchant', () => {
    const { db, sqlite, userId } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    // The shadowing rule: longer pattern, so matchRule ranks it first -- and no category.
    insertRawRule(sqlite, {
      pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: null, renameTo: null,
    });
    upsertRuleFromCorrection({
      pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: coffee,
      createdBy: userId, actorRole: 'admin',
    });

    const ctx = buildContext();
    expect(matchRule('TIM HORTONS', 'category', ctx.rules)?.pattern).toBe('TIM');
    expect(
      categorizeTransaction({ id: 1, normalizedMerchant: 'TIM HORTONS' }, ctx),
    ).toMatchObject({ categoryId: coffee, source: 'rule' });
  });

  it('the same for a rename rule with no target text', () => {
    const { sqlite, userId } = setup();
    // Every writer in the app refuses a rename with no target -- upsertRenameRule throws, the
    // form returns a sentence, the pack schema fails the file, and (R-09) the shared upsert throws
    // too. So this row is written the one way it could ever exist: raw.
    insertRawRule(sqlite, {
      pattern: 'WALMART SUPERCENTRE', matchType: 'contains', ruleKind: 'rename', categoryId: null, renameTo: '   ',
    });
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });

    expect(resolveRename('WALMART SUPERCENTRE #1234', buildContext())).toBe('Walmart');
  });

  it('a transfer rule is untouched by the check -- its kind IS its outcome', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({
      pattern: 'E-TRANSFER', matchType: 'contains', ruleKind: 'transfer', categoryId: null,
      createdBy: userId, actorRole: 'admin',
    });
    expect(detectTransfer('E-TRANSFER SENT J DOE', buildContext())).toBe(true);
  });
});

/**
 * v1.31.0 review finding R-03 (P2), controller ruling R24: manual > loan > rename > unset.
 *
 * Both writers of display_description refused only 'manual', so each overwrote the other and the
 * label a row showed depended on which pass ran last. Under R24 the explicit per-row loan link
 * wins over the bulk text-matched rename, and the order lives in ONE place
 * (DISPLAY_SOURCE_PRECEDENCE, src/lib/display-source.ts) that both writers read.
 */
describe('v1.31.0 R-03 / ruling R24: a loan label outranks a rename rule', () => {
  const readDisplay = (sqlite: TestDb['sqlite'], id: number) =>
    sqlite.prepare('select display_description as text, display_source as source from transactions where id = ?').get(id) as {
      text: string | null;
      source: string | null;
    };

  /** A loan-kind warranty item, the same raw-SQL shape linkToLoan above uses. */
  function seedLoan(db: TestDb['db'], userId: number): number {
    const now = nowIso();
    const typeId = db.get<{ id: number }>(sql`select id from warranty_item_types where name = 'Loan' collate nocase limit 1`).id;
    return db.get<{ id: number }>(sql`
      insert into warranty_items (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, current_balance_cents, balance_updated_at, created_at, updated_at)
      values ('Car Loan', '2026-01-01', 0, ${userId}, ${typeId}, 'owed', 2000000, ${now}, ${now}, ${now}) returning id`).id;
  }

  it('no rename pass overwrites it -- not applyRenameRules, not runEngine', () => {
    const { db, sqlite, userId, add } = setup();
    const txnId = add('WALMART #1234 TORONTO ON');
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });
    expect(readDisplay(sqlite, txnId)).toEqual({ text: 'Walmart', source: 'rename' });

    const itemId = seedLoan(db, userId);
    assignTransactionToLoan({ txnId, itemId });
    const labelled = readDisplay(sqlite, txnId);
    expect(labelled.source).toBe('loan');
    expect(labelled.text).toContain('Car Loan');

    // Every pass that used to rewrite it: a bare rename sweep, and the engine's own per-row pass.
    applyRenameRules();
    expect(readDisplay(sqlite, txnId)).toEqual(labelled);
    applyRenameRules([txnId]);
    expect(readDisplay(sqlite, txnId)).toEqual(labelled);
    runEngine([txnId]);
    expect(readDisplay(sqlite, txnId)).toEqual(labelled);
    // ...and saving/deleting an unrelated rename rule, which runs a full sweep of its own.
    upsertRenameRule({ pattern: 'LOBLAWS', matchType: 'contains', renameTo: 'Loblaws', userId, actorRole: 'admin' });
    deleteRenameRule({ pattern: 'LOBLAWS', matchType: 'contains' });
    expect(readDisplay(sqlite, txnId)).toEqual(labelled);
  });

  it('unlinking hands the row back to the rules, and the rename reappears', () => {
    const { db, sqlite, userId, add } = setup();
    const txnId = add('WALMART #1234 TORONTO ON');
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });
    const itemId = seedLoan(db, userId);
    assignTransactionToLoan({ txnId, itemId });

    expect(unassignTransactionFromLoan({ txnId, itemId })).toBe(true);
    // revertLoanDescription cleared the loan label; the rename is what should be there now, and
    // unassignFromLoanAction is what runs this pass in the app (see its own comment).
    expect(readDisplay(sqlite, txnId)).toEqual({ text: null, source: null });
    applyRenameRules([txnId]);
    expect(readDisplay(sqlite, txnId)).toEqual({ text: 'Walmart', source: 'rename' });
  });

  it('a manual name still outranks a loan link, the level above', () => {
    const { db, sqlite, userId, add } = setup();
    const txnId = add('WALMART #1234 TORONTO ON');
    setTransactionDisplayName({ transactionId: txnId, displayDescription: 'Sam pays me back', userId });
    const itemId = seedLoan(db, userId);
    assignTransactionToLoan({ txnId, itemId });
    expect(readDisplay(sqlite, txnId)).toEqual({ text: 'Sam pays me back', source: 'manual' });
  });
});

/**
 * v1.31.0 review finding R-07 (P3). Card-payment matching was written twice -- detectTransfer's
 * `for` loop and setTransferFlag's `.some(...)` -- so a future narrowing of one would have left the
 * other matching substrings. matchesCardPaymentPattern is the one definition.
 *
 * The property worth pinning is not "the helper works" (its body is one line); it is that the TWO
 * CALLERS AGREE, because that is what the duplication put at risk. setTransferFlag's `else if`
 * branch exists solely to author the not_transfer override that detectTransfer's FIRST step
 * honours, so if the two ever disagreed about what "the list matched" means, un-flagging a card
 * payment would write no override and the very next re-run would silently re-flag the row.
 */
describe('v1.31.0 R-07: one card-payment predicate, and both callers agree', () => {
  it('detectTransfer flags exactly the texts matchesCardPaymentPattern claims', () => {
    setup();
    const ctx = buildContext();
    for (const pattern of CARD_PAYMENT_PATTERNS) {
      const text = `${pattern} SOMETHING ELSE`;
      expect({ pattern, helper: matchesCardPaymentPattern(text), engine: detectTransfer(text, ctx) }).toEqual({
        pattern,
        helper: true,
        engine: true,
      });
    }
    expect(matchesCardPaymentPattern('CORNER STORE')).toBe(false);
    expect(detectTransfer('CORNER STORE', ctx)).toBe(false);
  });

  it('un-flagging a card-payment row writes the not_transfer override the same predicate demands', () => {
    const { userId, add } = setup();
    const id = add('PAYMENT - THANK YOU');
    const merchant = normalizeMerchant('PAYMENT - THANK YOU');
    expect(matchesCardPaymentPattern(merchant)).toBe(true);

    // The branch under test: `learnRule: true`, isTransfer false, on a merchant the LIST claims
    // rather than a rule. Deleting a nonexistent transfer rule would leave the list re-catching it
    // on the next re-run, so an override has to be authored instead.
    expect(setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin', learnRule: true }).ok).toBe(true);
    expect(listRules('not_transfer').map((rule) => rule.pattern)).toEqual([merchant]);
    // ...and that override is the first thing detectTransfer honours, so the row stays un-flagged.
    expect(detectTransfer(merchant, buildContext())).toBe(false);
  });
});

/**
 * v1.31.0 review finding R-06 (P3). ELIGIBLE's JavaScript twin was typed out three times beside
 * it, and eligibleForRuleReapply re-applied it to ids that had ALREADY come out of the SQL
 * predicate. isEligibleRow is now the one JS spelling, and that redundant filter is gone.
 *
 * So the property to pin is that dropping the filter dropped nothing: a manually decided row and a
 * split row are still out of scope for "Apply now" -- because eligibleForRerun's own SQL says so,
 * which was the point.
 */
describe('v1.31.0 R-06: one eligibility predicate, and removing the duplicate filter changed nothing', () => {
  it('Apply now still never reaches a manually decided row or a split row', () => {
    const { db, sqlite, userId, add } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    const groceries = categoryIdByName(db, 'Groceries');

    const untouched = add('TIM HORTONS #123');
    const manual = add('TIM HORTONS #456');
    const split = add('TIM HORTONS #789');

    confirmCategory({ transactionId: manual, categoryId: groceries, userId, createRule: false, actorRole: 'admin' });
    sqlite
      .prepare(
        "insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, -1000, '2026-01-01T00:00:00.000Z')",
      )
      .run(split, groceries);

    upsertRuleFromCorrection({
      pattern: 'TIM HORTONS',
      matchType: 'contains',
      ruleKind: 'category',
      categoryId: coffee,
      createdBy: userId,
      actorRole: 'admin',
    });
    const ruleId = listRules('category').find((rule) => rule.pattern === 'TIM HORTONS')!.id;

    expect(previewRuleReapply(ruleId)).toEqual({ eligible: 1, wouldChange: 1 });
    expect(applyRuleNow(ruleId).processed).toBe(1);
    expect(readTxn(sqlite, untouched).category_id).toBe(coffee);
    expect(readTxn(sqlite, manual).category_id).toBe(groceries);
    expect(readTxn(sqlite, split).category_id).toBeNull();
  });
});

/**
 * v1.31.0 review finding R-09 (P3). "Does this merchant have a rename?" was answered in three
 * places three ways, and the shared upsert stored whatever renameTo a caller passed for a rename,
 * including null. resolveRenameRule is the one definition; the upsert now refuses an outcome-less
 * rule with the same programmer-error treatment it already gave an illegal `word` kind.
 */
describe('v1.31.0 R-09: one rename resolution, and the upsert refuses a rule with no outcome', () => {
  it('resolveRenameRule and resolveRename are the same answer, projected two ways', () => {
    const { userId } = setup();
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });
    const ctx = buildContext();

    const rule = resolveRenameRule('WALMART SUPERCENTRE #1234', ctx);
    expect({ pattern: rule?.pattern, renameTo: rule?.renameTo }).toEqual({ pattern: 'WALMART', renameTo: 'Walmart' });
    expect(resolveRename('WALMART SUPERCENTRE #1234', ctx)).toBe('Walmart');

    expect(resolveRenameRule('CORNER STORE', ctx)).toBeNull();
    expect(resolveRename('CORNER STORE', ctx)).toBeNull();
  });

  it('refuses a rename with an empty target -- the null the upsert used to store', () => {
    const { userId } = setup();
    for (const renameTo of [null, '', '   ']) {
      expect(() =>
        upsertRuleFromCorrection({
          pattern: 'WALMART',
          matchType: 'contains',
          ruleKind: 'rename',
          categoryId: null,
          renameTo,
          createdBy: userId,
          actorRole: 'admin',
        }),
      ).toThrow(/needs a non-empty renameTo/);
    }
    expect(listRules('rename')).toEqual([]);
  });

  it('refuses a category rule with no category, through the same shared predicate', () => {
    const { userId } = setup();
    // ruleOutcomeMissing, not a second emptiness test written at the write side -- which is the
    // whole of R-09: ONE definition of "this rule has no outcome", read by the matcher that skips
    // such a row and by the writer that now refuses to create one.
    expect(() =>
      upsertRuleFromCorrection({
        pattern: 'TIM HORTONS',
        matchType: 'exact',
        ruleKind: 'category',
        categoryId: null,
        createdBy: userId,
        actorRole: 'admin',
      }),
    ).toThrow(/needs a category/);
    expect(listRules('category')).toEqual([]);
  });

  it('leaves transfer and not_transfer alone -- for those the kind IS the outcome', () => {
    const { userId } = setup();
    expect(() =>
      upsertRuleFromCorrection({
        pattern: 'E-TRANSFER',
        matchType: 'contains',
        ruleKind: 'transfer',
        categoryId: null,
        createdBy: userId,
        actorRole: 'admin',
      }),
    ).not.toThrow();
    expect(listRules('transfer')).toHaveLength(1);
  });
});

/**
 * v1.31.0 review finding R-10 (P3). Every bulk delete/disable ran one full retroactive rename pass
 * PER RULE, where importRulesPack had batched the identical work since it shipped. deleteRules and
 * setRulesDisabled are that batching; the measured before/after is in deleteRules' own docblock.
 *
 * These tests pin the OUTCOME, which is what a household sees: the same rows revert, the reported
 * count is the single pass's, and a batch with no rename in it pays for no pass at all.
 */
describe('v1.31.0 R-10: many rules, one rename pass', () => {
  const readLabel = (sqlite: TestDb['sqlite'], id: number) =>
    sqlite.prepare('select display_description as text, display_source as source from transactions where id = ?').get(id) as {
      text: string | null;
      source: string | null;
    };

  it('reverts every row of every deleted rename rule and reports the single pass total', () => {
    const { sqlite, userId, add } = setup();
    const a = add('AAA STORE #1');
    const b = add('BBB STORE #2');
    upsertRenameRule({ pattern: 'AAA', matchType: 'contains', renameTo: 'Aaa Co', userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'BBB', matchType: 'contains', renameTo: 'Bbb Co', userId, actorRole: 'admin' });
    expect(readLabel(sqlite, a).text).toBe('Aaa Co');
    expect(readLabel(sqlite, b).text).toBe('Bbb Co');

    expect(deleteRules(listRules('rename').map((rule) => rule.id))).toEqual({ deleted: 2, rowsCleared: 2 });
    expect(listRules('rename')).toEqual([]);
    expect(readLabel(sqlite, a)).toEqual({ text: null, source: null });
    expect(readLabel(sqlite, b)).toEqual({ text: null, source: null });
  });

  it('runs no rename pass at all for a batch with no rename rule in it', () => {
    const { db, userId } = setup();
    upsertRuleFromCorrection({
      pattern: 'TIM HORTONS',
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: categoryIdByName(db, 'Coffee'),
      createdBy: userId,
      actorRole: 'admin',
    });
    // rowsCleared 0 is the observable form of "no pass ran" -- deleting a category rule changes
    // nothing retroactively, which is setRuleDisabled's own long-standing ruling.
    expect(deleteRules(listRules('category').map((rule) => rule.id))).toEqual({ deleted: 1, rowsCleared: 0 });
  });

  it('skips an id that names no rule rather than failing the batch', () => {
    const { userId } = setup();
    upsertRenameRule({ pattern: 'AAA', matchType: 'contains', renameTo: 'Aaa Co', userId, actorRole: 'admin' });
    const real = listRules('rename')[0].id;
    // A second session may have deleted one between the page render and the click.
    expect(deleteRules([real, real + 9999]).deleted).toBe(1);
  });

  it('disables and re-enables a set of rename rules, one pass each way', () => {
    const { sqlite, userId, add } = setup();
    const a = add('AAA STORE #1');
    const b = add('BBB STORE #2');
    upsertRenameRule({ pattern: 'AAA', matchType: 'contains', renameTo: 'Aaa Co', userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'BBB', matchType: 'contains', renameTo: 'Bbb Co', userId, actorRole: 'admin' });
    const ids = listRules('rename').map((rule) => rule.id);

    expect(setRulesDisabled({ ruleIds: ids, disabled: true })).toEqual({ touched: 2, rowsChanged: 2 });
    expect(readLabel(sqlite, a).text).toBeNull();
    expect(readLabel(sqlite, b).text).toBeNull();

    expect(setRulesDisabled({ ruleIds: ids, disabled: false })).toEqual({ touched: 2, rowsChanged: 2 });
    expect(readLabel(sqlite, a).text).toBe('Aaa Co');
    expect(readLabel(sqlite, b).text).toBe('Bbb Co');
  });

  it('leaves the same rows behind as the per-rule loop it replaced', () => {
    // The equivalence that matters: batching must not change WHICH rows revert. Two OVERLAPPING
    // rename rules, deleted one at a time versus deleted as a batch -- the surviving display state
    // has to be identical. The COUNTS legitimately differ, and deleteRules' docblock says why: a
    // per-rule sum double-counts a row re-resolved to the second rule once the first is gone. This
    // asserts the state, which is what a household actually reads off the screen.
    const perRule = (() => {
      const first = setup();
      const id = first.add('WALMART SUPERCENTRE #1');
      upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId: first.userId, actorRole: 'admin' });
      upsertRenameRule({
        pattern: 'WALMART SUPERCENTRE',
        matchType: 'contains',
        renameTo: 'Walmart Supercentre',
        userId: first.userId,
        actorRole: 'admin',
      });
      for (const rule of listRules('rename')) deleteRenameRule({ pattern: rule.pattern, matchType: rule.matchType });
      const after = readLabel(first.sqlite, id);
      current?.cleanup();
      current = null;
      return after;
    })();

    const { sqlite, userId, add } = setup();
    const id = add('WALMART SUPERCENTRE #1');
    upsertRenameRule({ pattern: 'WALMART', matchType: 'contains', renameTo: 'Walmart', userId, actorRole: 'admin' });
    upsertRenameRule({ pattern: 'WALMART SUPERCENTRE', matchType: 'contains', renameTo: 'Walmart Supercentre', userId, actorRole: 'admin' });
    deleteRules(listRules('rename').map((rule) => rule.id));

    expect(readLabel(sqlite, id)).toEqual(perRule);
    expect(readLabel(sqlite, id)).toEqual({ text: null, source: null });
  });
});
