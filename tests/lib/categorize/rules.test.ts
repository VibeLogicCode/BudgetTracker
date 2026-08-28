import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../../helpers/db';
import { createUser } from '@/lib/auth/users';
import {
  bumpRuleUsage,
  deleteExactRule,
  deleteRule,
  listRules,
  matchRule,
  upsertRuleFromCorrection,
  type MerchantRuleRecord,
} from '@/lib/categorize/rules';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Every case in this file is unconcerned with ownership refusals, so 'admin' reproduces the
 * pre-R4 unconditional-overwrite behaviour and this throws on the one shape it should never see. */
function ruleId(
  result: ReturnType<typeof upsertRuleFromCorrection>,
): number {
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
  return result.ruleId;
}

describe('upsertRuleFromCorrection', () => {
  it('creates a rule and returns its id', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' }),
    );
    const rules = listRules('category');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id, pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, hitCount: 0 });
  });

  it('updates in place on conflict instead of piling up duplicates', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const coffee = categoryIdByName(current.db, 'Coffee');
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    const first = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' }),
    );
    const second = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId, actorRole: 'admin' }),
    );
    expect(second).toBe(first);
    expect(listRules('category')).toHaveLength(1);
    expect(listRules('category')[0].categoryId).toBe(restaurants);
  });

  it('treats (pattern, matchType, ruleKind) as the key', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' });
    expect(listRules()).toHaveLength(3);
    expect(listRules('transfer')).toHaveLength(1);
  });
});

describe('matchRule', () => {
  function ruleset() {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: restaurants, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'TIM HORT', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    return { coffee, restaurants, groceries, rules: listRules('category') };
  }

  it('prefers an exact match over any contains match', () => {
    const { coffee, rules } = ruleset();
    expect(matchRule('TIM HORTONS', 'category', rules)?.categoryId).toBe(coffee);
  });

  it('uses the longest contains pattern when no exact rule matches', () => {
    const { groceries, rules } = ruleset();
    expect(matchRule('TIM HORTONS EXPRESS', 'category', rules)?.categoryId).toBe(groceries);
  });

  it('returns null when nothing matches', () => {
    const { rules } = ruleset();
    expect(matchRule('LOBLAWS', 'category', rules)).toBeNull();
  });

  it('never returns a rule of a different kind', () => {
    current = createSeededTestDb();
    upsertRuleFromCorrection({ pattern: 'PAYMENT - THANK YOU', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' });
    const all = listRules();
    expect(matchRule('PAYMENT - THANK YOU', 'category', all)).toBeNull();
    expect(matchRule('PAYMENT - THANK YOU', 'transfer', all)?.ruleKind).toBe('transfer');
  });

  it('breaks a length tie by lowest rule id', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    const first = ruleId(
      upsertRuleFromCorrection({ pattern: 'AAAA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    upsertRuleFromCorrection({ pattern: 'BBBB', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    expect(matchRule('XX AAAA BBBB XX', 'category', listRules())?.id).toBe(first);
  });
});

describe('rule maintenance', () => {
  it('bumps hit count and last used', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    bumpRuleUsage(id, new Date('2026-08-15T12:00:00.000Z'));
    bumpRuleUsage(id, new Date('2026-08-16T12:00:00.000Z'));
    const rule = listRules('category')[0];
    expect(rule.hitCount).toBe(2);
    expect(rule.lastUsedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('deletes by id and by exact pattern', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    upsertRuleFromCorrection({ pattern: 'TFR-TO', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' });
    deleteRule(id);
    expect(listRules('category')).toHaveLength(0);
    expect(deleteExactRule('TFR-TO', 'transfer')).toBe(1);
    expect(listRules()).toHaveLength(0);
    expect(deleteExactRule('NOTHING', 'transfer')).toBe(0);
  });
});

describe('ruling R4 (item AH / SEC-6): a member cannot overwrite another person rule', () => {
  let adminId = 0;
  let memberId = 0;

  function storedRule(pattern: string): MerchantRuleRecord | undefined {
    return listRules().find((r) => r.pattern === pattern);
  }

  // Adapted from the brief's `resetTestDb()` (a plan-doc-only helper, not present in
  // tests/helpers/db.ts) to this file's own `current`/`afterEach` convention.
  beforeEach(async () => {
    current = createSeededTestDb();
    adminId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    memberId = (await createUser({ name: 'Person Two', username: 'user-2', password: 'correct horse 9', role: 'member' })).id;
  });

  const rule = (createdBy: number, actorRole: 'admin' | 'member', categoryId: number | null) =>
    upsertRuleFromCorrection({
      pattern: 'GROCERY STORE',
      matchType: 'contains',
      ruleKind: 'category',
      categoryId,
      renameTo: null,
      createdBy,
      actorRole,
    });

  it('a first write succeeds for anyone and records the author', () => {
    const result = rule(memberId, 'member', 3);
    expect(result.ok).toBe(true);
    expect(storedRule('GROCERY STORE')?.createdBy).toBe(memberId);
    expect(storedRule('GROCERY STORE')?.lastModifiedBy).toBe(memberId);
  });

  it('a member overwriting an admin rule writes NOTHING and names the owner', () => {
    rule(adminId, 'admin', 3);
    const result = rule(memberId, 'member', 9);
    expect(result).toEqual({ ok: false, reason: 'owned_by_another', ownerName: 'Person One' });
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(3);
    expect(stored?.createdBy).toBe(adminId);
    expect(stored?.lastModifiedBy).toBeNull();
  });

  it('the author may change their own rule, and created_by survives', () => {
    rule(memberId, 'member', 3);
    expect(rule(memberId, 'member', 9).ok).toBe(true);
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(9);
    expect(stored?.createdBy).toBe(memberId);
    expect(stored?.lastModifiedBy).toBe(memberId);
  });

  it('an admin may change anyone rule, and created_by STILL survives', () => {
    rule(memberId, 'member', 3);
    expect(rule(adminId, 'admin', 9).ok).toBe(true);
    const stored = storedRule('GROCERY STORE');
    expect(stored?.categoryId).toBe(9);
    expect(stored?.createdBy).toBe(memberId);
    expect(stored?.lastModifiedBy).toBe(adminId);
  });
});
