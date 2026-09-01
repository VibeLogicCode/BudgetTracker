import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSeededTestDb, categoryIdByName, insertTestUser, type TestDb } from '../../helpers/db';
import { createUser } from '@/lib/auth/users';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bumpRuleUsage,
  deleteExactRule,
  deleteRule,
  findRedundantRules,
  listRules,
  matchRule,
  matchTypeAllowedForKind,
  patternMatches,
  setRuleDisabledFlag,
  upsertRuleFromCorrection,
  WORD_MATCH_KINDS,
  type MatchType,
  type MerchantRuleRecord,
} from '@/lib/categorize/rules';
import { parseRulesPack } from '@/lib/packs';

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

  // v1.21.0 (item 9): a rule saved as `walmart` used to be accepted, listed, and dead forever --
  // normalized_merchant is always uppercase and matchRule never folds case. Decision: uppercase
  // on save, so the stored data itself stays canonical rather than folding case at match time.
  describe('item 9: uppercases the pattern on save', () => {
    it('stores a lowercase pattern uppercased', () => {
      current = createSeededTestDb();
      const coffee = categoryIdByName(current.db, 'Coffee');
      const result = upsertRuleFromCorrection({
        pattern: 'walmart', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin',
      });
      if (!result.ok) throw new Error('unexpected refusal');
      expect(listRules()[0]).toMatchObject({ id: result.ruleId, pattern: 'WALMART' });
    });

    it('trims surrounding whitespace as well as folding case', () => {
      current = createSeededTestDb();
      upsertRuleFromCorrection({ pattern: '  shell  ', matchType: 'contains', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' });
      expect(listRules()[0].pattern).toBe('SHELL');
    });

    it('a lowercase and an already-uppercase write to the same pattern collide onto one row, not two', () => {
      current = createSeededTestDb();
      const coffee = categoryIdByName(current.db, 'Coffee');
      const restaurants = categoryIdByName(current.db, 'Restaurants');
      const first = upsertRuleFromCorrection({ pattern: 'costco', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
      const second = upsertRuleFromCorrection({ pattern: 'COSTCO', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: null, actorRole: 'admin' });
      if (!first.ok || !second.ok) throw new Error('unexpected refusal');
      expect(second.ruleId).toBe(first.ruleId);
      expect(listRules()).toHaveLength(1);
      expect(listRules()[0].categoryId).toBe(restaurants);
    });

    it('now actually matches an uppercase transaction merchant, where the raw lowercase pattern never could have', () => {
      current = createSeededTestDb();
      const coffee = categoryIdByName(current.db, 'Coffee');
      upsertRuleFromCorrection({ pattern: 'tim hortons', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
      expect(matchRule('TIM HORTONS', 'category', listRules())?.categoryId).toBe(coffee);
    });
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

  // v1.21.0 (item 11): matchRule is the ONE place every caller's match funnels through, so the
  // disabled skip has to live here rather than at every call site.
  it('skips a disabled rule entirely, exact or contains', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const exactId = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    const containsId = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    setRuleDisabledFlag(exactId, true);
    setRuleDisabledFlag(containsId, true);
    expect(matchRule('TIM HORTONS', 'category', listRules())).toBeNull();
  });

  it('a disabled exact rule stops shadowing a still-enabled contains rule underneath it', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    const exactId = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    upsertRuleFromCorrection({ pattern: 'TIM', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    setRuleDisabledFlag(exactId, true);
    expect(matchRule('TIM HORTONS', 'category', listRules())?.categoryId).toBe(groceries);
  });

  it('re-enabling (flag back to false) restores the match', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = ruleId(
      upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    setRuleDisabledFlag(id, true);
    setRuleDisabledFlag(id, false);
    expect(listRules()[0].disabledAt).toBeNull();
    expect(matchRule('TIM HORTONS', 'category', listRules())?.id).toBe(id);
  });
});

/**
 * v1.25.0 (backlog item 16): the 'word' match type. Two of these tests are named after the actual
 * defect they exist to keep dead -- `contains LOWE` matching FLOWERS and `contains IGA` matching
 * MICHIGAN, both shipped by the v1.22.0 Canadian pack build and both worked around by demoting the
 * pattern to 'exact' rather than fixed.
 *
 * patternMatches is exercised directly (pure, no DB) wherever the question is only "does this
 * pattern match this text"; matchRule is used where rule rows, kinds, precedence or the disabled
 * flag are part of the question.
 */
describe('patternMatches: the word match type', () => {
  const word = (pattern: string, merchant: string) => patternMatches(pattern, 'word', merchant);

  it('matches a whole token at the start, in the middle and at the end of the merchant text', () => {
    expect(word('IGA', 'IGA MARCHE PLUS')).toBe(true);
    expect(word('MARCHE', 'IGA MARCHE PLUS')).toBe(true);
    expect(word('PLUS', 'IGA MARCHE PLUS')).toBe(true);
  });

  it('matches a merchant text that is nothing but the pattern (so word never loses what exact had)', () => {
    expect(word('IGA', 'IGA')).toBe(true);
  });

  // THE REGRESSION, half one: v1.22.0 shipped `contains IGA`, which matched MICHIGAN.
  it('IGA does not match MICHIGAN (v1.22.0 pack collision, backlog item 16)', () => {
    expect(patternMatches('IGA', 'contains', 'MICHIGAN AVE SHOP')).toBe(true); // the defect, still true of contains
    expect(word('IGA', 'MICHIGAN AVE SHOP')).toBe(false);
  });

  // THE REGRESSION, half two: v1.22.0 shipped a bare `LOWE` stem, which matched FLOWERS.
  it('LOWE does not match FLOWERS (v1.22.0 pack collision, backlog item 16)', () => {
    expect(patternMatches('LOWE', 'contains', 'FLOWERS BY THE PARK')).toBe(true); // the defect, still true of contains
    expect(word('LOWE', 'FLOWERS BY THE PARK')).toBe(false);
  });

  it('does not match a token that merely starts or ends with the pattern', () => {
    expect(word('STM', 'SYSTEM SUPPLY CO')).toBe(false);
    expect(word('MAXI', 'MAXIMUM FITNESS SUPPLY')).toBe(false);
    expect(word('ESSO', 'PROFESSOR SUPPLY CO')).toBe(false);
    expect(word('RONA', 'CORONA IMPORTS')).toBe(false);
  });

  it('matches a multi-word pattern only as a consecutive run of tokens', () => {
    expect(word('REAL CANADIAN', 'REAL CANADIAN SUPERSTORE')).toBe(true);
    expect(word('REAL CANADIAN', 'CANADIAN TIRE REAL ESTATE')).toBe(false);
    expect(word('REAL CANADIAN', 'REAL FRESH CANADIAN GROCER')).toBe(false);
  });

  it('needs the run to be complete -- a pattern longer than the merchant text cannot match', () => {
    expect(word('REAL CANADIAN SUPERSTORE', 'REAL CANADIAN')).toBe(false);
  });

  /**
   * The apostrophe/ampersand decision, asserted rather than described: ' and & stay INSIDE a token
   * because normalizeMerchant preserves them and they only ever occur inside a brand's own word.
   * See wordBoundaryTokens' docblock (src/lib/categorize/normalize.ts).
   */
  it("keeps an apostrophe inside the token: LOWE'S matches LOWE'S, and LOWE does not", () => {
    expect(word("LOWE'S", "LOWE'S HOME IMPROVEMENT")).toBe(true);
    expect(word('LOWE', "LOWE'S HOME IMPROVEMENT")).toBe(false);
    expect(word('S', "LOWE'S HOME IMPROVEMENT")).toBe(false);
  });

  it('keeps an ampersand inside the token: M&M matches M&M FOOD MARKET, and M does not', () => {
    expect(word('M&M', 'M&M FOOD MARKET')).toBe(true);
    expect(word('M', 'M&M FOOD MARKET')).toBe(false);
    expect(word('A&W', 'A&W RESTAURANT')).toBe(true);
  });

  /**
   * The other half of that decision: every OTHER punctuation mark is a JOINER the bank puts
   * between separate words, so it breaks a token. This is what makes `word KFC` useful rather than
   * merely safe.
   */
  it('treats hyphens, slashes and dots as boundaries, so a joined brand still yields its words', () => {
    expect(word('PETRO', 'PETRO-CANADA GAS BAR')).toBe(true);
    expect(word('CANADA', 'PETRO-CANADA GAS BAR')).toBe(true);
    expect(word('KFC', 'KFC/TACO BELL')).toBe(true);
    expect(word('MERCHANT', 'WWW.MERCHANT.COM')).toBe(true);
  });

  it('keeps a punctuation-only token, so a pattern cannot skip over a word the merchant text has', () => {
    expect(word('MAXI', 'MAXI & CIE')).toBe(true);
    expect(word('MAXI CIE', 'MAXI & CIE')).toBe(false);
  });

  /**
   * The pattern is free text somebody types into a form, so it must never be compiled into a
   * RegExp: '.', '+', '(' and '*' have to mean themselves, an unbalanced bracket must not throw
   * from inside the categorization loop, and '.*' must match NOTHING rather than everything.
   */
  it('treats regex metacharacters as literal text and never throws', () => {
    expect(() => word('.*', 'ANYTHING AT ALL')).not.toThrow();
    expect(word('.*', 'ANYTHING AT ALL')).toBe(false);
    expect(word('(', 'ANYTHING AT ALL')).toBe(false);
    expect(word('A.B', 'A B C')).toBe(true); // '.' is a boundary, so this is the two-token run A B
    expect(word('A+B', 'A B C')).toBe(true);
    expect(word('[UNCLOSED', 'AN UNCLOSED THOUGHT')).toBe(true);
    expect(word('C++', 'LEARN C++ TODAY')).toBe(true);
  });

  it('an empty pattern matches nothing (never everything)', () => {
    expect(word('', 'ANYTHING')).toBe(false);
  });

  it('exact and contains are untouched by any of this', () => {
    expect(patternMatches('IGA', 'exact', 'IGA')).toBe(true);
    expect(patternMatches('IGA', 'exact', 'IGA MARCHE')).toBe(false);
    expect(patternMatches('IGA', 'contains', 'IGA MARCHE')).toBe(true);
  });
});

/**
 * v1.25.0 (item 16). Precedence: LONGEST PATTERN WINS is primary; a tie on length breaks
 * exact > word > contains; a tie on both breaks on lowest id. See matchRule's docblock for why
 * length outranks type (a person's long specific rule beats a short generic one whatever
 * mechanism either used).
 */
describe('matchRule: precedence across mixed match types', () => {
  it('lets a LONGER contains pattern beat a shorter word pattern', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'IGA MARCHE', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    expect(matchRule('IGA MARCHE PLUS', 'category', listRules())?.categoryId).toBe(groceries);
  });

  it('lets a LONGER word pattern beat a shorter contains pattern', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'IGA MARCHE', matchType: 'word', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    expect(matchRule('IGA MARCHE PLUS', 'category', listRules())?.categoryId).toBe(groceries);
  });

  /**
   * The tie-break, isolated: the same pattern text under two match types is two DISTINCT rows
   * (merchant_rules_pattern_uq includes match_type), so equal length is genuinely reachable.
   * The loser is created FIRST so it holds the LOWER id -- if the type tie-break were not doing
   * the work, lowest-id would hand it the win and this test would fail.
   */
  it('breaks an equal-length tie word over contains, regardless of which was created first', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'contains', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    expect(matchRule('IGA MARCHE', 'category', listRules())?.categoryId).toBe(groceries);
  });

  it('breaks an equal-length tie exact over word', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const groceries = categoryIdByName(current.db, 'Groceries');
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'exact', ruleKind: 'category', categoryId: groceries, createdBy: null, actorRole: 'admin' });
    expect(matchRule('IGA', 'category', listRules())?.categoryId).toBe(groceries);
  });

  it('skips a disabled word rule, exactly as it skips a disabled exact or contains rule', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    const id = ruleId(
      upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }),
    );
    setRuleDisabledFlag(id, true);
    expect(matchRule('IGA MARCHE', 'category', listRules())).toBeNull();
    setRuleDisabledFlag(id, false);
    expect(matchRule('IGA MARCHE', 'category', listRules())?.id).toBe(id);
  });
});

/**
 * v1.25.0 (item 16). The rule-kind restriction on 'word', enforced at the write choke point.
 * See WORD_MATCH_KINDS' docblock (src/lib/categorize/rules.ts) for the argument: four functions in
 * engine.ts attribute a transfer/not_transfer rule's rows by asking SQL for
 * `normalized_merchant = rule.pattern`, and a word rule would silently invalidate all four.
 */
describe('word match type: restricted to category and rename kinds', () => {
  it('accepts word on a category rule and on a rename rule', () => {
    current = createSeededTestDb();
    const coffee = categoryIdByName(current.db, 'Coffee');
    expect(
      upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' }).ok,
    ).toBe(true);
    expect(
      upsertRuleFromCorrection({ pattern: 'RONA', matchType: 'word', ruleKind: 'rename', categoryId: null, renameTo: 'Rona', createdBy: null, actorRole: 'admin' }).ok,
    ).toBe(true);
  });

  it('refuses word on a transfer rule, and writes NO row', () => {
    current = createSeededTestDb();
    expect(() =>
      upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'transfer', categoryId: null, createdBy: null, actorRole: 'admin' }),
    ).toThrow(/category and rename rules only/);
    expect(listRules()).toEqual([]);
  });

  it('refuses word on a not_transfer rule, and writes NO row', () => {
    current = createSeededTestDb();
    expect(() =>
      upsertRuleFromCorrection({ pattern: 'IGA', matchType: 'word', ruleKind: 'not_transfer', categoryId: null, createdBy: null, actorRole: 'admin' }),
    ).toThrow(/category and rename rules only/);
    expect(listRules()).toEqual([]);
  });

  it('matchTypeAllowedForKind is indifferent to kind for exact and contains', () => {
    for (const kind of ['category', 'transfer', 'rename', 'not_transfer'] as const) {
      expect(matchTypeAllowedForKind('exact', kind)).toBe(true);
      expect(matchTypeAllowedForKind('contains', kind)).toBe(true);
    }
    expect(WORD_MATCH_KINDS).toEqual(['category', 'rename']);
  });

  /**
   * Belt and braces, and the reason the check also lives in matchRule: a row can reach the table
   * without passing through this build's upsert at all -- a hand-edited database, or a backup
   * restored from a build that allowed the combination. It must still be unable to fire.
   */
  it('matchRule refuses to honour a word transfer row that reached the table another way', () => {
    current = createSeededTestDb();
    current.sqlite
      .prepare("insert into merchant_rules (pattern, match_type, rule_kind, hit_count, created_at) values ('IGA', 'word', 'transfer', 0, '2026-01-01T00:00:00.000Z')")
      .run();
    expect(listRules('transfer')).toHaveLength(1);
    expect(matchRule('IGA MARCHE', 'transfer', listRules())).toBeNull();
  });
});

/**
 * v1.21.0 (item 10): "once contains WALMART exists, every exact WALMART <store> <city> rule
 * under it is dead weight still evaluated on every match". Pure over an already-fetched list --
 * no DB access -- so these tests build MerchantRuleRecord fixtures directly rather than through
 * upsertRuleFromCorrection.
 *
 * v1.27.0 (owner finding): renamed from findRedundantExactRules -- the old name stopped being
 * true the moment 'word' shipped as the pack's default match type, since an exact rule sitting
 * under a word rule (the now-common case) went completely undetected. See the function's own
 * docblock (src/lib/categorize/rules.ts) for the full coverage matrix and the proof behind each
 * cell; the describe blocks below are organized the same way -- one per matrix cell that IS
 * covered, one proving the ones that are NOT covered stay unflagged even when a naive reading of
 * the pattern text might suggest otherwise.
 */
describe('findRedundantRules', () => {
  function fixture(over: Partial<MerchantRuleRecord>): MerchantRuleRecord {
    return {
      id: 1, pattern: 'X', matchType: 'exact', ruleKind: 'category', categoryId: null, renameTo: null,
      createdBy: null, hitCount: 0, lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
      lastModifiedBy: null, disabledAt: null, packSource: null, packVersion: null, installedAt: null, ...over,
    };
  }

  describe('exact covered by contains (pre-existing case)', () => {
    it('flags an exact rule already covered by a contains rule with the same category', () => {
      const contains = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
      const exact = fixture({ id: 2, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([contains, exact])).toEqual([
        { ruleId: 2, coveredByRuleId: 1, coveredByPattern: 'WALMART', coveredByMatchType: 'contains' },
      ]);
    });

    it('does not flag an exact rule the contains pattern does not actually cover', () => {
      const contains = fixture({ id: 1, pattern: 'SHELL', matchType: 'contains', categoryId: 5 });
      const exact = fixture({ id: 2, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([contains, exact])).toEqual([]);
    });
  });

  describe('exact covered by word (the v1.25.0 regression this widening fixes)', () => {
    it('flags an exact rule already covered by a word rule with the same category', () => {
      const word = fixture({ id: 1, pattern: 'IGA', matchType: 'word', categoryId: 5 });
      const exact = fixture({ id: 2, pattern: 'IGA MARCHE PLUS', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([word, exact])).toEqual([
        { ruleId: 2, coveredByRuleId: 1, coveredByPattern: 'IGA', coveredByMatchType: 'word' },
      ]);
    });

    it('does not flag an exact rule when the word pattern is not a token run inside it', () => {
      // IGA occupies no whole token of MICHIGAN -- exactly the MICHIGAN collision 'word' exists
      // to avoid (see patternMatches' own docblock).
      const word = fixture({ id: 1, pattern: 'IGA', matchType: 'word', categoryId: 5 });
      const exact = fixture({ id: 2, pattern: 'MICHIGAN', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([word, exact])).toEqual([]);
    });
  });

  describe('contains covered by a broader contains', () => {
    it('flags a longer contains rule already covered by a shorter contains rule with the same category', () => {
      const broad = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
      const narrow = fixture({ id: 2, pattern: 'WALMART SUPERCENTER', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([broad, narrow])).toEqual([
        { ruleId: 2, coveredByRuleId: 1, coveredByPattern: 'WALMART', coveredByMatchType: 'contains' },
      ]);
    });

    it('does not flag two contains rules whose patterns are not substrings of one another', () => {
      const a = fixture({ id: 1, pattern: 'SHELL', matchType: 'contains', categoryId: 5 });
      const b = fixture({ id: 2, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([a, b])).toEqual([]);
    });

    it('never flags a contains rule against itself', () => {
      const contains = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([contains])).toEqual([]);
    });
  });

  describe('word covered by a broader word', () => {
    it('flags a longer word rule already covered by a shorter word rule with the same category', () => {
      const broad = fixture({ id: 1, pattern: 'IGA', matchType: 'word', categoryId: 5 });
      const narrow = fixture({ id: 2, pattern: 'IGA MARCHE', matchType: 'word', categoryId: 5 });
      expect(findRedundantRules([broad, narrow])).toEqual([
        { ruleId: 2, coveredByRuleId: 1, coveredByPattern: 'IGA', coveredByMatchType: 'word' },
      ]);
    });

    it('does not flag two word rules whose token runs do not nest', () => {
      const a = fixture({ id: 1, pattern: 'SHELL', matchType: 'word', categoryId: 5 });
      const b = fixture({ id: 2, pattern: 'IGA MARCHE', matchType: 'word', categoryId: 5 });
      expect(findRedundantRules([a, b])).toEqual([]);
    });
  });

  /**
   * The matrix cells that are deliberately NOT covered, asserted even where the SAME outcome and
   * a superficially matching pattern text are both present -- so a future edit cannot "fix" these
   * into false positives by mistake. See findRedundantRules' own docblock for the unsoundness
   * proof each one is guarding.
   */
  describe('the cells the coverage matrix refuses, even with the same outcome', () => {
    it('never flags a contains rule as covered by a word rule (WALMART/MART: word MART misses embedded MART)', () => {
      const word = fixture({ id: 1, pattern: 'MART', matchType: 'word', categoryId: 5 });
      const contains = fixture({ id: 2, pattern: 'MART', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([word, contains])).toEqual([]);
    });

    it('never flags a word rule as covered by a contains rule, even under the identical pattern text', () => {
      // word PETRO CANADA reaches "PETRO-CANADA" (hyphen); contains PETRO CANADA (space-joined,
      // literal) never would -- the two match types disagree about what a boundary is.
      const contains = fixture({ id: 1, pattern: 'PETRO CANADA', matchType: 'contains', categoryId: 5 });
      const word = fixture({ id: 2, pattern: 'PETRO CANADA', matchType: 'word', categoryId: 5 });
      expect(findRedundantRules([contains, word])).toEqual([]);
    });

    // Deliberately DIFFERENT pattern lengths from one another: an equal-text exact/contains pair
    // (both "WALMART") would also exercise the SEPARATE, legitimate exact-covered-by-contains
    // direction (the exact rule as the narrow one), which is not what this test is isolating.
    it('never flags a contains rule as covered by an exact rule', () => {
      const exact = fixture({ id: 1, pattern: 'WALMART', matchType: 'exact', categoryId: 5 });
      const contains = fixture({ id: 2, pattern: 'WALMART SUPERCENTER', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([exact, contains])).toEqual([]);
    });

    it('never flags a word rule as covered by an exact rule', () => {
      const exact = fixture({ id: 1, pattern: 'IGA', matchType: 'exact', categoryId: 5 });
      const word = fixture({ id: 2, pattern: 'IGA MARCHE', matchType: 'word', categoryId: 5 });
      expect(findRedundantRules([exact, word])).toEqual([]);
    });
  });

  /** "Different outcome never flagged" over every eligible (narrow, broad) match-type pair. */
  describe('a different outcome is never flagged, for every match-type pair', () => {
    it.each([
      { narrowType: 'exact' as MatchType, broadType: 'contains' as MatchType, narrowPattern: 'WALMART SUPERCENTER TORONTO', broadPattern: 'WALMART' },
      { narrowType: 'exact' as MatchType, broadType: 'word' as MatchType, narrowPattern: 'IGA MARCHE PLUS', broadPattern: 'IGA' },
      { narrowType: 'contains' as MatchType, broadType: 'contains' as MatchType, narrowPattern: 'WALMART SUPERCENTER', broadPattern: 'WALMART' },
      { narrowType: 'word' as MatchType, broadType: 'word' as MatchType, narrowPattern: 'IGA MARCHE', broadPattern: 'IGA' },
    ])('$narrowType covered by $broadType', ({ narrowType, broadType, narrowPattern, broadPattern }) => {
      const broad = fixture({ id: 1, pattern: broadPattern, matchType: broadType, categoryId: 5 });
      const narrow = fixture({ id: 2, pattern: narrowPattern, matchType: narrowType, categoryId: 9 });
      expect(findRedundantRules([broad, narrow])).toEqual([]);
    });
  });

  /** "A disabled rule on either side is never flagged", across the match types the widening added. */
  describe('a disabled rule on either side is never flagged', () => {
    it('never flags an already-disabled exact rule, or one only a disabled contains rule covers', () => {
      const contains = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', categoryId: 5, disabledAt: '2026-01-01T00:00:00.000Z' });
      const exact = fixture({ id: 2, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([contains, exact])).toEqual([]);
      const exactDisabled = fixture({ id: 3, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', categoryId: 5, disabledAt: '2026-01-01T00:00:00.000Z' });
      const liveContains = fixture({ id: 4, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
      expect(findRedundantRules([liveContains, exactDisabled])).toEqual([]);
    });

    it('never flags a disabled word rule as covering, or a disabled exact rule as covered', () => {
      const disabledWord = fixture({ id: 1, pattern: 'IGA', matchType: 'word', categoryId: 5, disabledAt: '2026-01-01T00:00:00.000Z' });
      const exact = fixture({ id: 2, pattern: 'IGA MARCHE', matchType: 'exact', categoryId: 5 });
      expect(findRedundantRules([disabledWord, exact])).toEqual([]);
      const liveWord = fixture({ id: 3, pattern: 'IGA', matchType: 'word', categoryId: 5 });
      const disabledExact = fixture({ id: 4, pattern: 'IGA MARCHE', matchType: 'exact', categoryId: 5, disabledAt: '2026-01-01T00:00:00.000Z' });
      expect(findRedundantRules([liveWord, disabledExact])).toEqual([]);
    });
  });

  it('matches rename rules on renameTo rather than categoryId', () => {
    const contains = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', ruleKind: 'rename', renameTo: 'Walmart' });
    const exact = fixture({ id: 2, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', ruleKind: 'rename', renameTo: 'Walmart' });
    expect(findRedundantRules([contains, exact])).toEqual([
      { ruleId: 2, coveredByRuleId: 1, coveredByPattern: 'WALMART', coveredByMatchType: 'contains' },
    ]);
    const differentTarget = fixture({ id: 3, pattern: 'WALMART SUPERCENTER TORONTO', matchType: 'exact', ruleKind: 'rename', renameTo: 'Wally World' });
    expect(findRedundantRules([contains, differentTarget])).toEqual([]);
  });

  it('prefers the longest covering pattern when more than one rule covers the same narrow rule', () => {
    // Neither coverer is a substring of the other (SUPERCENTER does not contain WALMART or vice
    // versa), so each covers ONLY the narrow rule, not each other -- isolating the tie-break.
    const shortCover = fixture({ id: 1, pattern: 'WALMART', matchType: 'contains', categoryId: 5 });
    const longCover = fixture({ id: 2, pattern: 'SUPERCENTER', matchType: 'contains', categoryId: 5 });
    const narrow = fixture({ id: 3, pattern: 'WALMART SUPERCENTER', matchType: 'contains', categoryId: 5 });
    expect(findRedundantRules([shortCover, longCover, narrow])).toEqual([
      { ruleId: 3, coveredByRuleId: 2, coveredByPattern: 'SUPERCENTER', coveredByMatchType: 'contains' },
    ]);
  });

  /**
   * The best available check on the coverage matrix above: the REAL shipped pack, 297 rules of
   * real data (packs/canadian-merchants.json, read-only -- this test never writes to it). Every
   * category/parent name is mapped to a synthetic numeric id (findRedundantRules only ever
   * compares outcomes for EQUALITY, so what the id actually IS does not matter, only that two
   * rules resolving to the same category get the same one).
   *
   * "No false positive" is checked two ways:
   *   1. every flagged pair genuinely has the covering rule's pattern as a real match against the
   *      narrow rule's own pattern text, via patternMatches -- the same production function the
   *      page itself runs through, not a re-derivation;
   *   2. a stress pass per flagged pair: several synthetic merchant strings built around the
   *      narrow pattern (embedded in a longer token with no boundary, joined by a hyphen instead
   *      of a space, prefixed and suffixed by noise) -- whenever the narrow rule's own matcher
   *      matches one of these, the covering rule's matcher must match it too. This is what would
   *      have caught the WALMART/MART and PETRO-CANADA/PETRO CANADA failure modes the matrix's
   *      docblock argues about by hand, if the implementation had gotten either one wrong.
   */
  describe('the real pack produces no false positive (packs/canadian-merchants.json)', () => {
    function loadPackFixtures(): MerchantRuleRecord[] {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
      const raw = JSON.parse(fs.readFileSync(path.join(root, 'packs/canadian-merchants.json'), 'utf8'));
      const pack = parseRulesPack(raw);
      const categoryIds = new Map<string, number>();
      let nextId = 1;
      const idFor = (parent: string | null, category: string | null) => {
        const key = `${parent ?? ''}|${category ?? ''}`;
        if (!categoryIds.has(key)) categoryIds.set(key, categoryIds.size + 1);
        return categoryIds.get(key)!;
      };
      return pack.rules.map((rule) => ({
        id: nextId++,
        pattern: rule.pattern,
        matchType: rule.match_type,
        ruleKind: rule.rule_kind === 'category' || rule.rule_kind === 'rename' ? rule.rule_kind : 'category',
        categoryId: rule.rule_kind === 'category' ? idFor(rule.category_parent, rule.category) : null,
        renameTo: rule.rename_to,
        createdBy: null, hitCount: 0, lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
        lastModifiedBy: null, disabledAt: null, packSource: null, packVersion: null, installedAt: null,
      }));
    }

    /** Same tokenizer the production matcher uses, imported indirectly through patternMatches --
     *  used here only to build a stress text's word-joined variant. */
    function stressTexts(pattern: string): string[] {
      return [
        `X${pattern}X`, // embedded in a larger token, no boundary on either side
        `${pattern}X`,
        `X${pattern}`,
        `PREFIX-${pattern}-SUFFIX`, // hyphen-joined noise, stresses word/contains boundary rules
        `PREFIX ${pattern} SUFFIX`, // space-joined noise
        pattern,
      ];
    }

    it('flags nothing whose covering rule does not really match the narrow rule\'s own pattern text', () => {
      const rules = loadPackFixtures();
      const flagged = findRedundantRules(rules);
      for (const entry of flagged) {
        const narrow = rules.find((r) => r.id === entry.ruleId)!;
        expect(patternMatches(entry.coveredByPattern, entry.coveredByMatchType, narrow.pattern)).toBe(true);
      }
    });

    it('flags nothing where a stress text the narrow rule matches is missed by the covering rule', () => {
      const rules = loadPackFixtures();
      const flagged = findRedundantRules(rules);
      const misses: string[] = [];
      for (const entry of flagged) {
        const narrow = rules.find((r) => r.id === entry.ruleId)!;
        for (const text of stressTexts(narrow.pattern)) {
          const narrowMatches = patternMatches(narrow.pattern, narrow.matchType, text);
          if (!narrowMatches) continue;
          const coveringMatches = patternMatches(entry.coveredByPattern, entry.coveredByMatchType, text);
          if (!coveringMatches) {
            misses.push(`${narrow.matchType} "${narrow.pattern}" (#${narrow.id}) matches "${text}" but its claimed coverer ${entry.coveredByMatchType} "${entry.coveredByPattern}" does not`);
          }
        }
      }
      expect(misses).toEqual([]);
    });

    /**
     * The two checks above prove no false positive; this proves they are not vacuously true
     * because the pack has nothing to flag at all -- it does not, and that is a GOOD property of
     * a hand-curated pack (docs/CANADIAN-MERCHANT-RULES-PACK.md and the cross-collision guard
     * both argue for a pack with no redundant entries in the first place, not one that needs
     * tidying). So this adds ONE synthetic rule, built to be redundant under a real pack rule
     * (same category, a pattern the real rule's own tokens run inside), and confirms the pipeline
     * catches it against the real 297-rule backdrop.
     */
    it('a synthetic rule laid on top of a real pack rule is correctly caught', () => {
      const rules = loadPackFixtures();
      const broad = rules.find((r) => r.matchType === 'word' && r.ruleKind === 'category');
      if (!broad) throw new Error('expected at least one word category rule in the shipped pack');
      const synthetic: MerchantRuleRecord = {
        ...broad,
        id: Math.max(...rules.map((r) => r.id)) + 1,
        pattern: `${broad.pattern} EXTRA SUFFIX STORE`,
        matchType: 'exact',
      };
      const flagged = findRedundantRules([...rules, synthetic]);
      expect(flagged).toContainEqual({
        ruleId: synthetic.id,
        coveredByRuleId: broad.id,
        coveredByPattern: broad.pattern,
        coveredByMatchType: 'word',
      });
    });
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
