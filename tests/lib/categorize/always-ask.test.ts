import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import {
  alwaysAskMatchCount,
  alwaysAskSendBackIds,
  applyCategoryToMatching,
  buildContext,
  categorizeTransaction,
  confirmCategory,
  createRulesFromRow,
  reviewQueueIds,
  ruleImpactCounts,
  ruleImpactIds,
  runEngine,
  sendAlwaysAskRowsToReview,
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
  const file = (id: number, source: string, categoryId: number) =>
    current!.sqlite
      .prepare('update transactions set categorization_source = ?, category_id = ?, confidence = ? where id = ?')
      .run(source, categoryId, source === 'bayes' ? 3 : null, id);
  const transfer = (id: number) => current!.sqlite.prepare('update transactions set is_transfer = 1 where id = ?').run(id);
  const split = (id: number, categoryId: number) => {
    const insert = current!.sqlite.prepare(
      'insert into transaction_splits (txn_id, category_id, amount_cents, created_at) values (?, ?, ?, ?)',
    );
    insert.run(id, categoryId, -600, nowIso());
    insert.run(id, categoryId, -400, nowIso());
  };
  const loanLink = (id: number) => {
    const now = nowIso();
    const typeId = current!.db.get<{ id: number }>(sql`
      insert into warranty_item_types (name, is_subscription, kind, created_at)
      values (${'Loan type'}, 0, 'loan', ${now})
      returning id`).id;
    const itemId = current!.db.get<{ id: number }>(sql`
      insert into warranty_items
        (name, purchase_date, is_lifetime, owner_user_id, type_id, loan_direction, current_balance_cents, balance_updated_at, created_at, updated_at)
      values (${'Test loan'}, '2026-01-01', 0, ${userId}, ${typeId}, 'owed', ${5_000_000}, ${now}, ${now}, ${now})
      returning id`).id;
    current!.sqlite
      .prepare('insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, itemId, 1000, 1000, 'manual', now);
  };
  return {
    db: current.db,
    sqlite: current.sqlite,
    userId,
    add,
    rule,
    ask,
    read,
    file,
    transfer,
    split,
    loanLink,
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

/** Spec 2026-10-21 §2.1. The dialog's live count: every non-transfer row the pattern matches. */
describe('alwaysAskMatchCount', () => {
  it('counts the non-transfer rows the pattern matches, under either type', () => {
    const { add, transfer } = setup();
    add('E-TRANSFER ***AB1');
    add('E-TRANSFER ***QX7');
    transfer(add('E-TRANSFER ***QX7'));
    add('TIM HORTONS');
    expect(alwaysAskMatchCount({ pattern: ' e-transfer ', matchType: 'contains' })).toBe(2);
    expect(alwaysAskMatchCount({ pattern: 'E-TRANSFER ***QX7', matchType: 'exact' })).toBe(1);
    expect(alwaysAskMatchCount({ pattern: '   ', matchType: 'contains' })).toBe(0);
  });
});

/**
 * v1.56.1 (v1.56.0 review M-4). One count, one meaning: the rows a rule's text matches, whether or not
 * another Always ask rule matches them too. The dialog's "Matches N" and the rule's Affects agree even
 * when two rules overlap.
 */
describe('Matches N: the dialog and Affects', () => {
  it('two overlapping rules each show the same number in the dialog and in Affects', () => {
    const { add, ask, transfer } = setup();
    const ab1 = [add('E-TRANSFER ***AB1'), add('E-TRANSFER ***AB1')];
    const qx7 = add('E-TRANSFER ***QX7');
    transfer(add('E-TRANSFER ***AB1'));
    add('TIM HORTONS');
    const wide = ask('E-TRANSFER', 'contains');
    const narrow = ask('E-TRANSFER ***AB1', 'exact');
    const affects = ruleImpactCounts();
    expect({ wide: affects.get(wide), narrow: affects.get(narrow) }).toEqual({
      wide: alwaysAskMatchCount({ pattern: 'E-TRANSFER', matchType: 'contains' }),
      narrow: alwaysAskMatchCount({ pattern: 'E-TRANSFER ***AB1', matchType: 'exact' }),
    });
    expect({ wide: affects.get(wide), narrow: affects.get(narrow) }).toEqual({ wide: 3, narrow: 2 });
    // The ids behind each figure are that figure's rows.
    expect(ruleImpactIds(wide)).toEqual([...ab1, qx7]);
    expect(ruleImpactIds(narrow)).toEqual(ab1);
  });

  it('a rule that is off matches nothing', () => {
    const { add, ask } = setup();
    add('E-TRANSFER ***AB1');
    const ruleId = ask('E-TRANSFER', 'contains');
    setRuleDisabledFlag(ruleId, true);
    expect(ruleImpactCounts().get(ruleId) ?? 0).toBe(0);
    expect(ruleImpactIds(ruleId)).toEqual([]);
  });
});

/** Spec 2026-10-21 §2.1. Only what a rule or a guess filed goes back; a person's decision never does. */
describe('Send back to review', () => {
  it('offers back rows a rule or a guess filed, and never a hand-set, split, transfer or loan-linked row', () => {
    const { add, ask, file, transfer, split, loanLink, groceries, coffee } = setup();
    const byRule = add('E-TRANSFER ***LL9');
    const byGuess = add('E-TRANSFER ***AB1');
    const byHand = add('E-TRANSFER ***AB1');
    const splitRow = add('E-TRANSFER ***QX7');
    const transferRow = add('E-TRANSFER ***QX7');
    const linked = add('E-TRANSFER ***LL9');
    const otherMerchant = add('MAPLE GROCER');
    file(byRule, 'rule', groceries);
    file(byGuess, 'bayes', groceries);
    file(byHand, 'manual', coffee);
    file(splitRow, 'rule', groceries);
    split(splitRow, groceries);
    file(transferRow, 'rule', groceries);
    transfer(transferRow);
    file(linked, 'rule', groceries);
    loanLink(linked);
    file(otherMerchant, 'rule', groceries);
    const ruleId = ask('E-TRANSFER', 'contains');
    expect(alwaysAskSendBackIds(ruleId)).toEqual([byRule, byGuess]);
  });

  it('clears exactly those rows, so they wait in the Uncategorized tab', () => {
    const { add, ask, file, read, groceries, coffee } = setup();
    const byRule = add('E-TRANSFER ***LL9');
    const byGuess = add('E-TRANSFER ***AB1');
    const byHand = add('E-TRANSFER ***AB1');
    file(byRule, 'rule', groceries);
    file(byGuess, 'bayes', groceries);
    file(byHand, 'manual', coffee);
    const ruleId = ask('E-TRANSFER', 'contains');
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 2 });
    expect(read(byRule)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(byGuess)).toEqual({ category_id: null, categorization_source: 'none' });
    expect(read(byHand)).toEqual({ category_id: coffee, categorization_source: 'manual' });
    expect(reviewQueueIds()).toEqual(expect.arrayContaining([byRule, byGuess]));
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 0 });
  });

  it('sends nothing for a disabled rule, a missing one, or a rule of another kind', () => {
    const { add, ask, file, rule, groceries } = setup();
    file(add('E-TRANSFER ***LL9'), 'rule', groceries);
    const ruleId = ask('E-TRANSFER', 'contains');
    const categoryRuleId = rule('E-TRANSFER', 'contains', groceries);
    expect(alwaysAskSendBackIds(categoryRuleId)).toEqual([]);
    expect(alwaysAskSendBackIds(999_999)).toEqual([]);
    setRuleDisabledFlag(ruleId, true);
    expect(alwaysAskSendBackIds(ruleId)).toEqual([]);
    expect(sendAlwaysAskRowsToReview({ ruleId })).toEqual({ sent: 0 });
  });
});
