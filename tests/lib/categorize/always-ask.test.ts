import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  applyCategoryToMatching,
  buildContext,
  categorizeTransaction,
  confirmCategory,
  createRulesFromRow,
  runEngine,
} from '@/lib/categorize/engine';
import {
  listRules,
  setAlwaysAskRule,
  setRuleDisabledFlag,
  upsertRuleFromCorrection,
  type AlwaysAskMatchType,
  type MatchType,
} from '@/lib/categorize/rules';
import { classify, train } from '@/lib/categorize/bayes';
import { normalizeMerchant, tokenize } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

/**
 * An Always ask rule files nothing: the engine returns no category for a merchant it matches (after
 * transfer detection, ahead of the category rule and the guess), and a person's pick on such a row
 * is saved without teaching a category rule or training Bayes.
 */

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const add = (rawDescription: string, amountCents = -1000) =>
    current!.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${rawDescription}, ${normalizeMerchant(rawDescription)}, ${amountCents}, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  const rule = (pattern: string, matchType: MatchType, categoryId: number) => {
    const written = upsertRuleFromCorrection({
      pattern,
      matchType,
      ruleKind: 'category',
      categoryId,
      createdBy: userId,
      actorRole: 'admin',
    });
    if (!written.ok) throw new Error('rule refused');
    return written.ruleId;
  };
  const ask = (pattern: string, matchType: AlwaysAskMatchType) => {
    const written = setAlwaysAskRule({ pattern, matchType, userId, actorRole: 'admin' });
    if (!written.ok) throw new Error('rule refused');
    return written.ruleId;
  };
  const read = (id: number) =>
    current!.sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
      category_id: number | null;
      categorization_source: string;
    };
  return {
    db: current.db,
    sqlite: current.sqlite,
    userId,
    add,
    rule,
    ask,
    read,
    coffee: categoryIdByName(current.db, 'Coffee'),
    groceries: categoryIdByName(current.db, 'Groceries'),
  };
}

const bayesRows = () =>
  (current!.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c;

const outcomeFor = (normalizedMerchant: string) =>
  categorizeTransaction({ id: 0, normalizedMerchant, amountCents: -1000 }, buildContext());
const NOTHING = { categoryId: null, source: 'none', confidence: null, isTransfer: false, matchedRuleId: null };

/** Spec 2026-10-21 §2.1. After transfer detection, before the category rule and the guess. */
describe('categorizeTransaction with an Always ask rule', () => {
  it('files nothing for a matching merchant, ahead of an exact category rule and a guess', () => {
    const { rule, ask, groceries, coffee } = setup();
    rule('E-TRANSFER ***LL9', 'exact', groceries);
    for (let i = 0; i < 6; i += 1) train(tokenize('E-TRANSFER ***AB1'), groceries);
    for (let i = 0; i < 6; i += 1) train(tokenize('BEAN BARN ROASTERS'), coffee);
    expect(classify(tokenize('E-TRANSFER ***AB1'))?.categoryId).toBe(groceries);
    expect(outcomeFor('E-TRANSFER ***LL9').categoryId).toBe(groceries);
    ask('E-TRANSFER', 'contains');
    expect(outcomeFor('E-TRANSFER ***LL9')).toEqual(NOTHING);
    expect(outcomeFor('E-TRANSFER ***AB1')).toEqual(NOTHING);
  });

  it('leaves a transfer a transfer: detection runs first', () => {
    const { ask, userId } = setup();
    upsertRuleFromCorrection({ pattern: 'E-TRANSFER ***QX7', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    ask('E-TRANSFER', 'contains');
    expect(outcomeFor('E-TRANSFER ***QX7')).toMatchObject({ isTransfer: true, categoryId: null });
  });

  it('an exact rule asks about that text only', () => {
    const { rule, ask, groceries } = setup();
    rule('E-TRANSFER', 'contains', groceries);
    ask('E-TRANSFER ***AB1', 'exact');
    expect(outcomeFor('E-TRANSFER ***AB1')).toEqual(NOTHING);
    expect(outcomeFor('E-TRANSFER ***QX7').categoryId).toBe(groceries);
  });

  // Pin: matchRule already skips a disabled row of any kind.
  it('stops asking once the rule is disabled', () => {
    const { rule, ask, groceries } = setup();
    rule('E-TRANSFER', 'contains', groceries);
    setRuleDisabledFlag(ask('E-TRANSFER', 'contains'), true);
    expect(outcomeFor('E-TRANSFER ***AB1').categoryId).toBe(groceries);
  });

  it('a re-run clears a guess on an Always ask row and leaves a rule-filed row as it is', () => {
    const { add, ask, read, groceries, sqlite } = setup();
    const guessed = add('E-TRANSFER ***AB1');
    const filed = add('E-TRANSFER ***QX7');
    sqlite.prepare("update transactions set category_id = ?, categorization_source = 'bayes', confidence = 3 where id = ?").run(groceries, guessed);
    sqlite.prepare("update transactions set category_id = ?, categorization_source = 'rule' where id = ?").run(groceries, filed);
    ask('E-TRANSFER', 'contains');
    runEngine([guessed, filed]);
    expect(read(guessed)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(filed)).toEqual({ category_id: groceries, categorization_source: 'rule' });
  });
});

/** Spec 2026-10-21 §2.1 No learning: the category is saved, nothing is learned. */
describe('an Always ask row teaches nothing', () => {
  it('confirming in review mode files the row, writes no category rule and trains nothing', () => {
    const { add, ask, read, userId, groceries } = setup();
    const id = add('E-TRANSFER ***AB1');
    ask('E-TRANSFER', 'contains');
    expect(confirmCategory({ transactionId: id, categoryId: groceries, userId, createRule: true, actorRole: 'admin' })).toEqual({ ok: true });
    expect(read(id)).toEqual({ category_id: groceries, categorization_source: 'manual' });
    expect(listRules('category')).toEqual([]);
    expect(bayesRows()).toBe(0);
  });

  it('createRulesFromRow files the rows and writes the person rule, not the category rule', () => {
    const { add, ask, userId, groceries } = setup();
    add('E-TRANSFER ***AB1');
    ask('E-TRANSFER', 'contains');
    expect(
      createRulesFromRow({ normalizedMerchant: 'E-TRANSFER ***AB1', amountMinCents: null, amountMaxCents: null, categoryId: groceries, attributedUserId: null, userId, actorRole: 'admin' }),
    ).toEqual({ ok: true, rulesCreated: 1, categoryChanged: 1, personChanged: 0, splitsSkipped: 0 });
    expect(listRules('category')).toEqual([]);
    expect(listRules('attribution')).toHaveLength(1);
    expect(bayesRows()).toBe(0);
  });

  it('applyCategoryToMatching files every row and writes no rule', () => {
    const { add, ask, userId, groceries } = setup();
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***AB1', -2500);
    ask('E-TRANSFER', 'contains');
    expect(applyCategoryToMatching({ normalizedMerchant: 'E-TRANSFER ***AB1', categoryId: groceries, userId, actorRole: 'admin' })).toEqual({ ok: true, count: 2 });
    expect(listRules('category')).toEqual([]);
    expect(bayesRows()).toBe(0);
  });

  // Pin: a merchant no Always ask rule matches learns exactly as before.
  it('a merchant with no Always ask rule still learns', () => {
    const { add, ask, userId, groceries } = setup();
    const id = add('MAPLE GROCER');
    ask('E-TRANSFER', 'contains');
    confirmCategory({ transactionId: id, categoryId: groceries, userId, createRule: true, actorRole: 'admin' });
    expect(listRules('category').map((r) => r.pattern)).toEqual(['MAPLE GROCER']);
    expect(bayesRows()).toBeGreaterThan(0);
  });
});
