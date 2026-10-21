import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  applyCategoryToMatching,
  buildContext,
  categorizeTransaction,
  confirmCategory,
  clearRuleFromTransactions,
  createRulesFromRow,
  ruleClearIds,
  ruleImpactCounts,
  ruleImpactIds,
  runEngine,
} from '@/lib/categorize/engine';
import { listRules, upsertRuleFromCorrection, type MatchType } from '@/lib/categorize/rules';
import { BAYES_MARGIN_THRESHOLD, classify, train } from '@/lib/categorize/bayes';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { archiveCategory } from '@/lib/categories';
import { nowIso } from '@/lib/clock';

/**
 * An archived category is never assigned automatically. A rule pointing at one does not fire
 * (and stays in the table, so restoring the category restores the rule), Bayes never guesses one,
 * and a person picking one by hand saves the row without teaching a rule.
 *
 * "Archived" is the category's OWN flag, the definition the category pickers use: archiving a
 * parent does not archive its children (categoryOptions promotes them instead).
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
  const read = (id: number) =>
    current!.sqlite.prepare('select category_id, categorization_source from transactions where id = ?').get(id) as {
      category_id: number | null;
      categorization_source: string;
    };
  return {
    db: current.db,
    userId,
    add,
    rule,
    read,
    coffee: categoryIdByName(current.db, 'Coffee'),
    groceries: categoryIdByName(current.db, 'Groceries'),
    restaurants: categoryIdByName(current.db, 'Restaurants'),
    food: categoryIdByName(current.db, 'Food'),
  };
}

const outcomeFor = (normalizedMerchant: string) =>
  categorizeTransaction({ id: 0, normalizedMerchant, amountCents: -1000 }, buildContext());

describe('rules pointing at an archived category', () => {
  it('do not fire, and a shorter rule pointing at a live category gets its turn', () => {
    const { rule, coffee, restaurants } = setup();
    const longer = rule('BEAN BARN ROASTERS', 'contains', coffee);
    const shorter = rule('BEAN BARN', 'contains', restaurants);
    expect(outcomeFor('BEAN BARN ROASTERS 0042')).toMatchObject({ categoryId: coffee, matchedRuleId: longer });

    archiveCategory(coffee, true);
    expect(outcomeFor('BEAN BARN ROASTERS 0042')).toMatchObject({
      categoryId: restaurants,
      source: 'rule',
      matchedRuleId: shorter,
    });
  });

  it('do not file a row on an engine run, and the rule row itself is left alone', () => {
    const { rule, add, read, coffee } = setup();
    const ruleId = rule('BEAN BARN', 'contains', coffee);
    archiveCategory(coffee, true);
    const id = add('BEAN BARN 0042');
    runEngine([id]);
    expect(read(id).category_id).not.toBe(coffee);
    expect(read(id).categorization_source).not.toBe('rule');
    const stored = listRules('category').find((r) => r.id === ruleId);
    expect(stored).toMatchObject({ categoryId: coffee, disabledAt: null, categoryArchived: true });
  });

  it('fire again once the category is restored', () => {
    const { rule, coffee } = setup();
    const ruleId = rule('BEAN BARN', 'contains', coffee);
    archiveCategory(coffee, true);
    expect(outcomeFor('BEAN BARN 0042').matchedRuleId).toBeNull();
    archiveCategory(coffee, false);
    expect(outcomeFor('BEAN BARN 0042')).toMatchObject({ categoryId: coffee, source: 'rule', matchedRuleId: ruleId });
  });

  it('use the pickers’ definition: an archived parent leaves a live child’s rule firing', () => {
    const { rule, coffee, food } = setup();
    const ruleId = rule('BEAN BARN', 'contains', coffee);
    archiveCategory(food, true);
    expect(outcomeFor('BEAN BARN 0042')).toMatchObject({ categoryId: coffee, matchedRuleId: ruleId });
  });
});

describe('attribution for a rule whose category is archived', () => {
  it('Delete and clear reaches the rows an archived category rule filed', () => {
    const { rule, add, read, coffee } = setup();
    const r = rule('BEAN BARN', 'contains', coffee);
    const a = add('BEAN BARN ROASTERS 0042');
    runEngine([a]);
    archiveCategory(coffee, true);

    expect(ruleImpactCounts().get(r)).toBe(1);
    expect(ruleImpactIds(r)).toEqual([a]);
    expect(ruleClearIds(r)).toEqual([a]);
    expect(clearRuleFromTransactions({ ruleId: r }).rowsCleared).toBe(1);
    expect(read(a)).toMatchObject({ category_id: null, categorization_source: 'none' });
  });

  it('a shorter live rule is not credited with the archived rule rows', () => {
    const { rule, add, read, coffee, restaurants } = setup();
    const longer = rule('BEAN BARN ROASTERS', 'contains', coffee);
    const shorter = rule('BEAN BARN', 'contains', restaurants);
    const a = add('BEAN BARN ROASTERS 0042');
    const b = add('BEAN BARN DOWNTOWN');
    runEngine([a, b]);
    archiveCategory(coffee, true);

    expect(ruleImpactIds(longer)).toEqual([a]);
    expect(ruleImpactIds(shorter)).toEqual([b]);
    const counts = ruleImpactCounts();
    expect(counts.get(longer)).toBe(1);
    expect(counts.get(shorter)).toBe(1);
    clearRuleFromTransactions({ ruleId: shorter });
    expect(read(a).category_id).toBe(coffee);
  });

  it('does not credit an archived rule with a row it did not file', () => {
    const { rule, add, coffee, restaurants } = setup();
    const archived = rule('BEAN BARN ROASTERS', 'contains', coffee);
    const shorter = rule('BEAN BARN', 'contains', restaurants);
    archiveCategory(coffee, true);
    const u = add('BEAN BARN ROASTERS 0042');
    expect(ruleImpactIds(archived)).toEqual([]);
    expect(ruleImpactIds(shorter)).toEqual([u]);
  });
});

describe('Bayes and archived categories', () => {
  it('never guesses an archived category; the next-best live one can win on the usual margin', () => {
    const { coffee, restaurants, groceries } = setup();
    // Coffee wins clearly; with Coffee out of the running, Restaurants still clears the margin
    // over Groceries on its own.
    for (let i = 0; i < 10; i += 1) train(['BEAN', 'BARN'], coffee);
    for (let i = 0; i < 3; i += 1) train(['BEAN', 'BARN', 'DINER', 'GRILL', 'HOUSE', 'KITCHEN'], restaurants);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS', 'FRESH', 'MART'], groceries);
    expect(classify(['BEAN', 'BARN'])?.categoryId).toBe(coffee);

    archiveCategory(coffee, true);
    const guess = classify(['BEAN', 'BARN']);
    expect(guess?.categoryId).toBe(restaurants);
    expect(guess!.margin).toBeGreaterThanOrEqual(BAYES_MARGIN_THRESHOLD);
  });

  it('makes no guess when the only clear winner is archived', () => {
    const { coffee, groceries } = setup();
    for (let i = 0; i < 3; i += 1) train(['BEAN', 'BARN'], coffee);
    for (let i = 0; i < 3; i += 1) train(['METRO', 'PLUS'], groceries);
    expect(classify(['BEAN', 'BARN'])?.categoryId).toBe(coffee);

    archiveCategory(coffee, true);
    const guess = classify(['BEAN', 'BARN']);
    expect(guess === null || guess.categoryId !== coffee).toBe(true);
    expect(outcomeFor('BEAN BARN').categoryId).not.toBe(coffee);
  });
});

describe('Bayes and archived categories, edge cases', () => {
  it('makes no guess when the two live categories left are within the margin of each other', () => {
    const { coffee, restaurants, groceries } = setup();
    for (let i = 0; i < 10; i += 1) train(['BEAN', 'BARN'], coffee);
    for (let i = 0; i < 3; i += 1) train(['BEAN', 'GRILL'], restaurants);
    for (let i = 0; i < 3; i += 1) train(['BEAN', 'MART'], groceries);
    expect(classify(['BEAN', 'BARN'])?.categoryId).toBe(coffee);
    archiveCategory(coffee, true);
    expect(classify(['BEAN', 'BARN'])).toBeNull();
  });

  it('does not count tokens only an archived category has seen towards the known-token gate', () => {
    const { coffee, restaurants, groceries } = setup();
    // BEAN and BARN are known only to Coffee; the live categories have never seen either.
    for (let i = 0; i < 5; i += 1) train(['BEAN', 'BARN'], coffee);
    for (let i = 0; i < 400; i += 1) train(['MART'], groceries);
    for (let i = 0; i < 3; i += 1) train(['GRILL'], restaurants);
    archiveCategory(coffee, true);
    expect(classify(['BEAN', 'BARN'])).toBeNull();
  });
});

describe('teaching next to a rule whose category is archived', () => {
  it('leaves the archived bounded rule untouched and teaches the merchant-wide rule', () => {
    const { add, userId, coffee, restaurants } = setup();
    const merchant = normalizeMerchant('BEAN BARN 0042');
    const bounded = upsertRuleFromCorrection({
      pattern: merchant,
      matchType: 'exact',
      ruleKind: 'category',
      categoryId: coffee,
      amountMinCents: 500,
      amountMaxCents: 1500,
      createdBy: userId,
      actorRole: 'admin',
    });
    if (!bounded.ok) throw new Error('rule refused');
    archiveCategory(coffee, true);
    const id = add('BEAN BARN 0042', -1000);
    confirmCategory({ transactionId: id, categoryId: restaurants, userId, createRule: true, actorRole: 'admin' });

    const rules = listRules('category').map((r) => ({ id: r.id, categoryId: r.categoryId, min: r.amountMinCents }));
    expect(rules).toContainEqual({ id: bounded.ruleId, categoryId: coffee, min: 500 });
    expect(rules).toContainEqual(expect.objectContaining({ categoryId: restaurants, min: null }));
  });
});

describe('picking an archived category by hand', () => {
  it('saves the row as a manual pick but teaches no rule (review mode)', () => {
    const { add, read, userId, coffee } = setup();
    archiveCategory(coffee, true);
    const id = add('BEAN BARN 0042');
    expect(confirmCategory({ transactionId: id, categoryId: coffee, userId, createRule: true, actorRole: 'admin' })).toEqual({
      ok: true,
    });
    expect(read(id)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(listRules('category')).toEqual([]);
  });

  it('does not rewrite an existing rule for that merchant either', () => {
    const { add, rule, userId, coffee, restaurants } = setup();
    const id = add('BEAN BARN 0042');
    const ruleId = rule(normalizeMerchant('BEAN BARN 0042'), 'exact', restaurants);
    archiveCategory(coffee, true);
    confirmCategory({ transactionId: id, categoryId: coffee, userId, createRule: true, actorRole: 'admin' });
    expect(listRules('category').map((r) => ({ id: r.id, categoryId: r.categoryId }))).toEqual([
      { id: ruleId, categoryId: restaurants },
    ]);
  });

  it('applies to every matching row without creating a rule', () => {
    const { add, read, userId, coffee } = setup();
    archiveCategory(coffee, true);
    const a = add('BEAN BARN 0042');
    const b = add('BEAN BARN 0042', -2500);
    const result = applyCategoryToMatching({ normalizedMerchant: normalizeMerchant('BEAN BARN 0042'), categoryId: coffee, userId, actorRole: 'admin' });
    expect(result).toEqual({ ok: true, count: 2 });
    expect(read(a)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(read(b)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(listRules('category')).toEqual([]);
  });

  it('files the rows from the rule dialog but writes no category rule', () => {
    const { add, read, userId, coffee } = setup();
    archiveCategory(coffee, true);
    const id = add('BEAN BARN 0042');
    const result = createRulesFromRow({
      normalizedMerchant: normalizeMerchant('BEAN BARN 0042'),
      amountMinCents: null,
      amountMaxCents: null,
      categoryId: coffee,
      userId,
      actorRole: 'admin',
    });
    expect(result).toMatchObject({ ok: true, rulesCreated: 0, categoryChanged: 1 });
    expect(read(id)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(listRules('category')).toEqual([]);
  });
});
