import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  CARD_PAYMENT_PATTERNS,
  applyCategoryToMatching,
  applyRenameRules,
  applyRuleNow,
  buildContext,
  categorizeTransaction,
  clearCategory,
  confirmCategory,
  deleteRenameRule,
  detectTransfer,
  eligibleForRerun,
  previewRerun,
  previewRuleReapply,
  rerunEngine,
  resolveRename,
  reviewQueueCount,
  reviewQueueIds,
  ruleImpactCounts,
  runEngine,
  setRuleDisabled,
  setTransactionDisplayName,
  setTransferFlag,
  upsertRenameRule,
} from '@/lib/categorize/engine';
import { exactRuleOwner, listRules, matchRule, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { classify, train } from '@/lib/categorize/bayes';
import { normalizeMerchant, tokenize } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { unassignTransactionFromLoan } from '@/lib/loans';

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
    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin' });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    const rules = listRules('transfer');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null });
  });

  it('turning it off removes the learned rule', () => {
    const { sqlite, add, userId } = setup();
    const id = add('E-TRANSFER SENT J DOE');
    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin' });
    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin' });
    expect(readTxn(sqlite, id).is_transfer).toBe(0);
    expect(listRules('transfer')).toHaveLength(0);
  });

  it('un-flagging a card-payment-pattern row teaches a not_transfer override that survives rerun', () => {
    const { sqlite, add, userId } = setup();
    const id = add('PAYMENT - THANK YOU', 50000);
    runEngine([id]);
    expect(readTxn(sqlite, id).is_transfer).toBe(1);

    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin' });
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
    setTransferFlag({ transactionId: id, isTransfer: false, userId, actorRole: 'admin' });
    expect(listRules('not_transfer')).toHaveLength(1);

    setTransferFlag({ transactionId: id, isTransfer: true, userId, actorRole: 'admin' });
    expect(readTxn(sqlite, id).is_transfer).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(0);
    expect(detectTransfer('PAYMENT - THANK YOU', buildContext())).toBe(true);
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
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: adminId, actorRole: 'admin' }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      const result = setTransferFlag({ transactionId: second, isTransfer: true, userId: memberId, actorRole: 'member' });
      expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Admin Owner' });

      expect(readTxn(sqlite, second).is_transfer).toBe(0);
      expect(readTxn(sqlite, first).is_transfer).toBe(1);
      expect(listRules('transfer')).toHaveLength(1);
    });

    it('an admin can overwrite anyone\'s transfer rule', () => {
      const { sqlite, adminId, memberId, add } = setupTwoUsers();
      const first = add('ACME PAYROLL CO', -500, '2026-03-02');
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: memberId, actorRole: 'member' }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      expect(setTransferFlag({ transactionId: second, isTransfer: true, userId: adminId, actorRole: 'admin' }).ok).toBe(true);
      expect(readTxn(sqlite, second).is_transfer).toBe(1);
    });

    it('a member can update a transfer rule they own themselves', () => {
      const { sqlite, memberId, add } = setupTwoUsers();
      const first = add('ACME PAYROLL CO', -500, '2026-03-02');
      expect(setTransferFlag({ transactionId: first, isTransfer: true, userId: memberId, actorRole: 'member' }).ok).toBe(true);

      const second = add('ACME PAYROLL CO', -500, '2026-03-03');
      expect(setTransferFlag({ transactionId: second, isTransfer: true, userId: memberId, actorRole: 'member' }).ok).toBe(true);
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

    const result = setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' });

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

    const result = setTransferFlag({ transactionId: txnId, isTransfer: false, userId: memberId, actorRole: 'member' });

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

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: adminId, actorRole: 'admin' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('lets a member delete their OWN opposite-kind rule', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: memberId, actorRole: 'member',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });

  it('deletes an ownerless rule as before', () => {
    const { memberId, txnId, merchant } = setupOwnedRule();
    upsertRuleFromCorrection({
      pattern: merchant, matchType: 'exact', ruleKind: 'not_transfer',
      categoryId: null, createdBy: null, actorRole: 'admin',
    });

    expect(setTransferFlag({ transactionId: txnId, isTransfer: true, userId: memberId, actorRole: 'member' })).toEqual({ ok: true });
    expect(exactRuleOwner(merchant, 'not_transfer')).toBeNull();
  });
});
