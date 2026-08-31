import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { importRulesPack, parseRulesPack, type RulesPack } from '@/lib/packs';
import { listRules } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { SEED_CATEGORIES } from '@/db/seed';

/**
 * Guard for packs/canadian-merchants.json (docs/CANADIAN-MERCHANT-RULES-PACK.md explains what
 * the pack itself does and does not assert). This file's whole reason to exist is the one
 * tests/ops/onboarding-coverage.test.ts states for its own guards: a fixture-driven test covers
 * whatever someone chose to write a fixture for, and a hand-authored data file this size (190
 * rules) has no fixture author to catch a typo, a duplicate pattern, or a category name that
 * drifted from src/db/seed.ts. These are the only tests that load the ACTUAL shipped JSON, so
 * they are the only thing standing between a future edit and a pack that silently stops
 * importing cleanly.
 *
 * The last describe block (false-positive collisions) exists for a second, distinct reason:
 * structural correctness (parses, uppercase, no dangling category) says nothing about whether a
 * rule fires on the WRONG transaction. 2026-08-31 coordinator review found two real collisions
 * this pack shipped with (a bare `LOWE` stem matching FLOWERS, `IGA` as `contains` matching
 * MICHIGAN) that every guard above would have passed happily. "Prefer a miss over a false
 * positive" is the governing principle for this pack; these assertions are what enforce it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_PATH = path.join(root, 'packs/canadian-merchants.json');

function loadRawPack(): unknown {
  expect(fs.existsSync(PACK_PATH), `expected a shipped pack at ${PACK_PATH}`).toBe(true);
  return JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
}

function loadPack(): RulesPack {
  return parseRulesPack(loadRawPack());
}

/** Every (parent, child) pair the household's own seeded category tree actually has. */
function seedCategoryPairs(): Set<string> {
  const pairs = new Set<string>();
  for (const parent of SEED_CATEGORIES) {
    for (const child of parent.children) pairs.add(`${parent.name}|${child}`);
  }
  return pairs;
}

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

describe('shipped pack: packs/canadian-merchants.json parses and is internally consistent', () => {
  it('parses as a valid rules pack', () => {
    expect(() => loadPack()).not.toThrow();
  });

  it('carries a non-trivial number of category and rename rules', () => {
    const pack = loadPack();
    const categoryRules = pack.rules.filter((r) => r.rule_kind === 'category');
    const renameRules = pack.rules.filter((r) => r.rule_kind === 'rename');
    // Floors, not exact counts (same discipline as onboarding-coverage.test.ts) -- growing the
    // pack must never fail this guard, only shrinking it to near-nothing should.
    expect(categoryRules.length).toBeGreaterThan(50);
    expect(renameRules.length).toBeGreaterThan(5);
    expect(categoryRules.length + renameRules.length).toBe(pack.rules.length);
  });

  it('every pattern is uppercase (v1.21.0 item 9\'s write choke point expects this, not lowercase input)', () => {
    const pack = loadPack();
    const notUppercase = pack.rules.filter((r) => r.pattern !== r.pattern.toUpperCase()).map((r) => r.pattern);
    expect(notUppercase).toEqual([]);
  });

  it('every (pattern, match_type, rule_kind) appears only once', () => {
    const pack = loadPack();
    const seen = new Map<string, number>();
    for (const rule of pack.rules) {
      const key = `${rule.pattern}|${rule.match_type}|${rule.rule_kind}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    expect(duplicates).toEqual([]);
  });

  it('every rename entry has a non-empty rename_to, and every category entry has a category', () => {
    const pack = loadPack();
    const badRenames: string[] = [];
    const badCategories: string[] = [];
    for (const rule of pack.rules) {
      if (rule.rule_kind === 'rename') {
        if (rule.rename_to === null || rule.rename_to.trim().length === 0) badRenames.push(rule.pattern);
        // Rename-only by design (Part 2 of the brief): a rename rule in this pack never also
        // asserts a category, so the same entry cannot both misfile a transaction and clean up
        // its name.
        if (rule.category !== null) badCategories.push(`${rule.pattern} (rename with a category)`);
      } else if (rule.rule_kind === 'category') {
        if (rule.category === null) badCategories.push(rule.pattern);
      }
    }
    expect(badRenames).toEqual([]);
    expect(badCategories).toEqual([]);
  });

  it('every category rule references a (category_parent, category) pair that exists in SEED_CATEGORIES', () => {
    const pack = loadPack();
    const valid = seedCategoryPairs();
    const dangling = pack.rules
      .filter((r) => r.rule_kind === 'category')
      .filter((r) => !valid.has(`${r.category_parent}|${r.category}`))
      .map((r) => `${r.pattern} -> ${r.category_parent ?? '(none)'} > ${r.category}`);
    expect(dangling).toEqual([]);
  });
});

describe('shipped pack: imports cleanly into a freshly seeded database', () => {
  it('imports with zero skipped entries', () => {
    current = createSeededTestDb();
    const result = importRulesPack(loadRawPack());
    expect(result.rulesSkipped).toBe(0);
  });

  it('creates NO categories -- every referenced category already exists in the seeded tree', () => {
    current = createSeededTestDb();
    const result = importRulesPack(loadRawPack());
    expect(result.categoriesCreated).toBe(0);
  });

  it('adds exactly as many rules as the pack carries, on a database with nothing to conflict with', () => {
    current = createSeededTestDb();
    const pack = loadPack();
    const result = importRulesPack(loadRawPack());
    expect(result).toMatchObject({ rulesAdded: pack.rules.length, rulesOverwritten: 0, rulesKept: 0, rulesSkipped: 0, categoriesCreated: 0 });
  });

  // Coordinator brief: "importing it twice is idempotent and reports the second run as conflicts
  // kept, not duplicates written." Read literally against importRulesPack's own mechanism
  // (src/lib/packs.ts): once every rule's stored outcome (categoryId or renameTo) already equals
  // what the pack says, the write loop's own sameOutcome check `continue`s before touching
  // rulesAdded/rulesKept/rulesOverwritten at all -- the identical precedent already established
  // by tests/lib/packs.test.ts's "is idempotent when nothing changed". So the second run reports
  // ALL ZERO, which is the general case "kept, not duplicates" describes: nothing new is written,
  // and the row count proves no duplicate landed.
  it('importing it twice is idempotent: the second run writes nothing and creates no duplicate rows', () => {
    current = createSeededTestDb();
    const raw = loadRawPack();
    importRulesPack(raw);
    const rowCountAfterFirst = listRules().length;

    const second = importRulesPack(raw);
    expect(second).toEqual({ rulesAdded: 0, rulesOverwritten: 0, rulesKept: 0, rulesSkipped: 0, categoriesCreated: 0 });
    expect(listRules().length).toBe(rowCountAfterFirst);
  });
});

describe('shipped pack: an imported rename behaves exactly like one saved on the form', () => {
  function addTxn(db: TestDb['db'], accountId: number, userId: number, rawDescription: string): number {
    const row = db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${rawDescription}, ${normalizeMerchant(rawDescription)}, -1000, 'none', ${userId}, ${nowIso()}, ${nowIso()})
      returning id`);
    return row.id;
  }

  it('changes a matching transaction\'s display to the pack\'s rename target', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const id = addTxn(current.db, accountId, userId, 'WALMART #3921 TORONTO ON');

    importRulesPack(loadRawPack());

    const row = current.sqlite
      .prepare('select display_description, display_source from transactions where id = ?')
      .get(id) as { display_description: string | null; display_source: string | null };
    expect(row.display_source).toBe('rename');
    expect(row.display_description).toBe('Walmart');
  });

  it('never overwrites a transaction a household member already renamed by hand', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const id = addTxn(current.db, accountId, userId, 'COSTCO WHOLESALE #221 OTTAWA ON');
    current.sqlite
      .prepare("update transactions set display_description = ?, display_source = 'manual' where id = ?")
      .run('Costco run with Dana', id);

    importRulesPack(loadRawPack());

    const row = current.sqlite
      .prepare('select display_description, display_source from transactions where id = ?')
      .get(id) as { display_description: string | null; display_source: string | null };
    expect(row).toEqual({ display_description: 'Costco run with Dana', display_source: 'manual' });
  });
});

describe('shipped pack: known false-positive collisions stay fixed (2026-08-31 coordinator review)', () => {
  function ruleFor(pattern: string): { pattern: string; match_type: 'exact' | 'contains' } {
    const pack = loadPack();
    const rule = pack.rules.find((r) => r.pattern === pattern);
    if (!rule) throw new Error(`no rule for pattern ${pattern} in the shipped pack -- did the pattern text change?`);
    return rule;
  }

  function ruleMatches(rule: { pattern: string; match_type: 'exact' | 'contains' }, normalized: string): boolean {
    return rule.match_type === 'exact' ? normalized === rule.pattern : normalized.includes(rule.pattern);
  }

  /**
   * Every case here is a REAL bug the pack shipped with, verified against the live normalizer
   * (not assumed): a bare possessive stem (LOWE, HARVEY, KELSEY, MCDONALD, WENDY, LONGO) or a
   * short `contains` acronym (IGA, MAXI, ESSO, RONA) matched an unrelated merchant or a plain
   * personal name. `oldStemContained` is asserted true first -- if it were ever false the rest of
   * the assertion would be proving nothing, since the collision it is meant to guard against
   * would already be impossible for an unrelated reason (e.g. the fixture text changed).
   */
  const collisions: { raw: string; oldStemContained: string; fixedPattern: string }[] = [
    { raw: 'FLOWERS BY THE PARK #123 TORONTO ON', oldStemContained: 'LOWE', fixedPattern: "LOWE'S" },
    { raw: 'MICHIGAN AVE SHOP #55 WINDSOR ON', oldStemContained: 'IGA', fixedPattern: 'IGA' },
    { raw: 'MAXIMUM FITNESS SUPPLY #4 OTTAWA ON', oldStemContained: 'MAXI', fixedPattern: 'MAXI' },
    { raw: 'PROFESSOR SUPPLY CO #12 OTTAWA ON', oldStemContained: 'ESSO', fixedPattern: 'ESSO' },
    { raw: 'ACCESSORY WORLD #4 OTTAWA ON', oldStemContained: 'ESSO', fixedPattern: 'ESSO' },
    { raw: 'CORONA IMPORTS #9 OTTAWA ON', oldStemContained: 'RONA', fixedPattern: 'RONA' },
    { raw: 'E-TRANSFER SENT J HARVEY', oldStemContained: 'HARVEY', fixedPattern: "HARVEY'S" },
    { raw: 'E-TRANSFER SENT KELSEY SMITH', oldStemContained: 'KELSEY', fixedPattern: "KELSEY'S" },
    { raw: 'E-TRANSFER SENT J MONTANA', oldStemContained: 'MONTANA', fixedPattern: "MONTANA'S" },
    { raw: 'E-TRANSFER SENT J DENNY', oldStemContained: 'DENNY', fixedPattern: "DENNY'S" },
    { raw: 'E-TRANSFER SENT J MCDONALD', oldStemContained: 'MCDONALD', fixedPattern: "MCDONALD'S" },
    { raw: 'E-TRANSFER SENT WENDY SMITH', oldStemContained: 'WENDY', fixedPattern: "WENDY'S" },
    { raw: 'E-TRANSFER SENT J NANDO', oldStemContained: 'NANDO', fixedPattern: "NANDO'S" },
    { raw: 'E-TRANSFER SENT M LONGO', oldStemContained: 'LONGO', fixedPattern: "LONGO'S" },
    { raw: 'E-TRANSFER SENT M DOMINO', oldStemContained: 'DOMINO', fixedPattern: "DOMINO'S" },
  ];

  it.each(collisions)('$raw does not match the fixed $fixedPattern rule', ({ raw, oldStemContained, fixedPattern }) => {
    const normalized = normalizeMerchant(raw);
    expect(normalized.includes(oldStemContained)).toBe(true);
    expect(ruleMatches(ruleFor(fixedPattern), normalized)).toBe(false);
  });

  it('confirms apostrophes survive normalization -- the premise the possessive-brand fixes rest on', () => {
    expect(normalizeMerchant("HARVEY'S #123 TORONTO ON")).toBe("HARVEY'S");
    expect(normalizeMerchant("MONTANA'S BBQ #4 OTTAWA ON")).toBe("MONTANA'S BBQ");
  });

  it('the length-based fixes (IGA, MAXI, ESSO, RONA, KFC, A&W, TTC, STM, F45, YMCA, XBOX, FIDO) are all exact, not contains', () => {
    const shortPatterns = ['IGA', 'MAXI', 'ESSO', 'RONA', 'KFC', 'A&W', 'TTC', 'STM', 'F45', 'YMCA', 'XBOX', 'FIDO'];
    for (const pattern of shortPatterns) {
      expect(ruleFor(pattern).match_type, `${pattern} should be exact`).toBe('exact');
    }
  });

  it('no contains pattern in the shipped pack is 4 characters or fewer, except the documented ATCO exception', () => {
    const pack = loadPack();
    const shortContains = pack.rules.filter((r) => r.match_type === 'contains' && r.pattern.length <= 4).map((r) => r.pattern);
    expect(shortContains).toEqual(['ATCO']);
  });
});
