import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { importRulesPack, parseRulesPack, type PackRule, type RulesPack } from '@/lib/packs';
import { listRules, matchTypeAllowedForKind, patternMatches, type MatchType } from '@/lib/categorize/rules';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { SEED_CATEGORIES } from '@/db/seed';

/**
 * Guard for packs/canadian-merchants.json (docs/CANADIAN-MERCHANT-RULES-PACK.md explains what
 * the pack itself does and does not assert). This file's whole reason to exist is the one
 * tests/ops/onboarding-coverage.test.ts states for its own guards: a fixture-driven test covers
 * whatever someone chose to write a fixture for, and a hand-authored data file this size (297
 * rules as of pack_version 3) has no fixture author to catch a typo, a duplicate pattern, or a
 * category name that drifted from src/db/seed.ts. These are the only tests that load the ACTUAL
 * shipped JSON, so they are the only thing standing between a future edit and a pack that
 * silently stops importing cleanly.
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
    // v1.31.0 R-12 added rulesSkippedDetail: the skipped entries BY NAME, not just a count. The
    // shipped pack skips nothing, so it must come back empty -- asserted rather than left out of
    // the object, because "no skips" is the property this test is here to pin.
    expect(second).toEqual({
      rulesAdded: 0,
      rulesOverwritten: 0,
      rulesKept: 0,
      rulesSkipped: 0,
      rulesSkippedDetail: [],
      categoriesCreated: 0,
    });
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
  function ruleFor(pattern: string): { pattern: string; match_type: MatchType } {
    const pack = loadPack();
    const rule = pack.rules.find((r) => r.pattern === pattern);
    if (!rule) throw new Error(`no rule for pattern ${pattern} in the shipped pack -- did the pattern text change?`);
    return rule;
  }

  /**
   * v1.25.0 (item 16): delegates to the REAL matcher (patternMatches, src/lib/categorize/rules.ts)
   * instead of the two-line reimplementation this file used to carry. That copy was fine while
   * there were only two match types and both were one-liners; with 'word' in play, a guard that
   * reimplements the matching rules it is guarding can only ever prove that the copy agrees with
   * itself. The whole value of this describe block is that it runs the collisions through the
   * production code path -- normalizeMerchant for the merchant text, patternMatches for the rule.
   */
  function ruleMatches(rule: { pattern: string; match_type: MatchType }, normalized: string): boolean {
    return patternMatches(rule.pattern, rule.match_type, normalized);
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
    // pack_version 3. Three more of exactly this class, all found in the SHIPPED v2 pack rather
    // than in a proposed addition -- see the three named tests below for what each one cost.
    { raw: 'METROLINX GO TRANSIT TORONTO ON', oldStemContained: 'METRO', fixedPattern: 'METRO' },
    { raw: 'METROPOLITAN SUPPLY CO #12 TORONTO ON', oldStemContained: 'METRO', fixedPattern: 'METRO' },
    { raw: 'PRESTON HARDWARE OTTAWA ON', oldStemContained: 'PRESTO', fixedPattern: 'PRESTO' },
    { raw: 'E-TRANSFER SENT SHELLEY SMITH', oldStemContained: 'SHELL', fixedPattern: 'SHELL' },
    { raw: 'SHELLFISH MARKET #8 HALIFAX NS', oldStemContained: 'SHELL', fixedPattern: 'SHELL' },
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

  /**
   * v1.25.0 (item 16) PROMOTED these from 'exact' to 'word'. They were only ever 'exact' because
   * matchRule had no boundary-aware option, and 'exact' honoured "prefer a miss over a false
   * positive" by giving up everything except the bare acronym. ATCO joins them from the other
   * direction: it was the ONE deliberate short-'contains' exception (documented in
   * docs/CANADIAN-MERCHANT-RULES-PACK.md, kept broad so one pattern catches ATCO Gas and ATCO
   * Electric), i.e. a knowingly-accepted collision risk that 'word' removes outright.
   *
   * RONA is DELIBERATELY still 'exact' and is asserted so here rather than merely omitted, so
   * that a future edit promoting it has to argue with this test: Rona is a woman's given name,
   * and a rename rule is the one kind whose false positive is visible on screen. `word RONA`
   * would rename "E-TRANSFER SENT RONA <surname>" to "Rona" -- the exact class of collision the
   * possessive-brand fixes above (HARVEY'S, WENDY'S, KELSEY'S) exist to prevent. No boundary rule
   * can tell a store from a person; only not being broad can.
   */
  it('the short acronyms (IGA, MAXI, ESSO, KFC, A&W, TTC, STM, F45, YMCA, XBOX, FIDO, ATCO) are word rules, not exact or contains', () => {
    const shortPatterns = ['IGA', 'MAXI', 'ESSO', 'KFC', 'A&W', 'TTC', 'STM', 'F45', 'YMCA', 'XBOX', 'FIDO', 'ATCO'];
    for (const pattern of shortPatterns) {
      expect(ruleFor(pattern).match_type, `${pattern} should be word`).toBe('word');
    }
  });

  it('RONA stays exact -- a word rule would rename an e-transfer to a person named Rona', () => {
    expect(ruleFor('RONA').match_type).toBe('exact');
    expect(ruleMatches(ruleFor('RONA'), normalizeMerchant('E-TRANSFER SENT RONA WILLIAMS'))).toBe(false);
  });

  it('no contains pattern in the shipped pack is 4 characters or fewer -- ATCO, the last exception, is a word rule now', () => {
    const pack = loadPack();
    const shortContains = pack.rules.filter((r) => r.match_type === 'contains' && r.pattern.length <= 4).map((r) => r.pattern);
    expect(shortContains).toEqual([]);
  });

  /**
   * The promotions have to be shown to have BOUGHT something, or 'word' is just a slower 'exact'.
   * Each line is the statement text 'exact' could never reach: a real store-format suffix on a
   * pattern that used to match the bare acronym and nothing else.
   */
  const nowReached: { raw: string; pattern: string }[] = [
    { raw: 'IGA MARCHE #4021 MONTREAL QC', pattern: 'IGA' },
    { raw: 'ESSO ON THE RUN #77 BARRIE ON', pattern: 'ESSO' },
    { raw: 'MAXI & CIE #310 LAVAL QC', pattern: 'MAXI' },
    { raw: 'TTC MONTHLY PASS TORONTO ON', pattern: 'TTC' },
    { raw: 'STM OPUS RECHARGE MONTREAL QC', pattern: 'STM' },
    { raw: 'YMCA OF GREATER TORONTO ON', pattern: 'YMCA' },
    { raw: 'ATCO GAS AND PIPELINES CALGARY AB', pattern: 'ATCO' },
    { raw: 'A&W RESTAURANT #812 GUELPH ON', pattern: 'A&W' },
  ];

  it.each(nowReached)('$pattern now reaches $raw, which exact never could', ({ raw, pattern }) => {
    const normalized = normalizeMerchant(raw);
    const rule = ruleFor(pattern);
    expect(normalized).not.toBe(rule.pattern); // else exact would already have matched and this proves nothing
    expect(ruleMatches(rule, normalized)).toBe(true);
  });

  /**
   * pack_version 3 NARROWED three shipped rules (METRO, PRESTO, SHELL: contains -> word), which is
   * the opposite direction from the promotions above and needs the opposite proof. A narrowing is
   * only free if it keeps every line the broad rule was there for, so each of these is a realistic
   * statement line the OLD `contains` rule matched and the new `word` rule still matches -- and
   * each is deliberately LONGER than its own pattern, so `exact` could not have stood in either.
   * Without this table, "fix the false positive" and "delete the rule" would pass the same tests.
   */
  const wordStillReaches: { raw: string; pattern: string }[] = [
    { raw: 'METRO PLUS #1234 LAVAL QC', pattern: 'METRO' },
    { raw: 'PRESTO FARE LOAD TORONTO ON', pattern: 'PRESTO' },
    { raw: 'SHELL CANADA #4821 BARRIE ON', pattern: 'SHELL' },
    { raw: 'METROLINX GO TRANSIT TORONTO ON', pattern: 'METROLINX' },
    { raw: 'COUCHE TARD DEPANNEUR LAVAL QC', pattern: 'COUCHE-TARD' },
    { raw: 'IRVING OIL BIG STOP MONCTON NB', pattern: 'IRVING OIL' },
    { raw: 'MOBIL CAR WASH OAKVILLE ON', pattern: 'MOBIL' },
    { raw: "MARK'S WORK WEARHOUSE #4410 CALGARY AB", pattern: "MARK'S" },
    { raw: "LEON'S FURNITURE #33 LONDON ON", pattern: "LEON'S" },
    { raw: "BALZAC'S COFFEE STRATFORD ON", pattern: "BALZAC'S" },
    { raw: 'TEKSAVVY SOLUTIONS CHATHAM ON', pattern: 'TEKSAVVY' },
    { raw: 'FIZZ MOBILE MONTREAL QC', pattern: 'FIZZ' },
  ];

  it.each(wordStillReaches)('word $pattern still reaches $raw', ({ raw, pattern }) => {
    const normalized = normalizeMerchant(raw);
    const rule = ruleFor(pattern);
    expect(rule.match_type).toBe('word');
    expect(normalized).not.toBe(rule.pattern);
    expect(ruleMatches(rule, normalized)).toBe(true);
  });

  /**
   * A `word` pattern tokenizes the SAME WAY whether the brand is spelled with a hyphen or a space,
   * because wordBoundaryTokens breaks on both (normalize.ts: "'-', '/', '.', '#' and friends are
   * JOINERS the bank puts BETWEEN separate words"). That is a real, load-bearing difference from
   * `contains`, and it is why this pack carries PETRO-CANADA *and* PETRO CANADA as two `contains`
   * rules but ships COUCHE-TARD and CO-OP GAS BAR as ONE `word` rule each. Asserted rather than
   * assumed, because the whole saving rests on it.
   */
  it('one word rule covers both the hyphenated and the spaced spelling of a brand', () => {
    const coucheTard = ruleFor('COUCHE-TARD');
    expect(coucheTard.match_type).toBe('word');
    expect(ruleMatches(coucheTard, normalizeMerchant('COUCHE-TARD #6612 LAVAL QC'))).toBe(true);
    expect(ruleMatches(coucheTard, normalizeMerchant('COUCHE TARD #6612 LAVAL QC'))).toBe(true);
    // The contains rule it is NOT: `contains COUCHE-TARD` would miss the spaced spelling outright.
    expect(patternMatches('COUCHE-TARD', 'contains', normalizeMerchant('COUCHE TARD #6612 LAVAL QC'))).toBe(false);
  });
});

/**
 * pack_version 3. The two collisions the shipped v2 pack was carrying, each named after what it
 * actually cost a household, plus the third one found while fixing them. All three are the same
 * defect -- a `contains` pattern of 5-6 characters, long enough to clear this file's
 * "no contains shorter than 5 characters" guard and still short enough to sit inside a longer,
 * unrelated word. Each test asserts the OLD match type WOULD have fired, so it is pinning a real
 * bug rather than an imagined one, and that the new one does not.
 */
describe('shipped pack: the pack_version 3 contains-inside-a-longer-word fixes', () => {
  function ruleFor(pattern: string): { pattern: string; match_type: MatchType } {
    const rule = loadPack().rules.find((r) => r.pattern === pattern);
    if (!rule) throw new Error(`no rule for pattern ${pattern} in the shipped pack -- did the pattern text change?`);
    return rule;
  }

  it('METRO does not match METROLINX -- GO Transit fares were being filed as Groceries', () => {
    const normalized = normalizeMerchant('METROLINX GO TRANSIT TORONTO ON');
    const metro = ruleFor('METRO');
    expect(patternMatches('METRO', 'contains', normalized)).toBe(true); // the bug pack_version 2 shipped
    expect(metro.match_type).toBe('word');
    expect(patternMatches(metro.pattern, metro.match_type, normalized)).toBe(false);
  });

  it('PRESTO does not match PRESTON -- a place name and a surname, not a fare card', () => {
    const normalized = normalizeMerchant('PRESTON HARDWARE OTTAWA ON');
    const presto = ruleFor('PRESTO');
    expect(patternMatches('PRESTO', 'contains', normalized)).toBe(true); // the bug pack_version 2 shipped
    expect(presto.match_type).toBe('word');
    expect(patternMatches(presto.pattern, presto.match_type, normalized)).toBe(false);
  });

  it('SHELL does not match SHELLEY -- a given name that carries the brand as a substring', () => {
    const normalized = normalizeMerchant('E-TRANSFER SENT SHELLEY SMITH');
    const shell = ruleFor('SHELL');
    expect(patternMatches('SHELL', 'contains', normalized)).toBe(true); // found while fixing the two above
    expect(shell.match_type).toBe('word');
    expect(patternMatches(shell.pattern, shell.match_type, normalized)).toBe(false);
  });
});

/**
 * pack_version 3's structural guard, and the reason it exists rather than another hand-written
 * list of collisions: METRO/METROLINX was in the pack for three releases, and every check above it
 * passed. Both halves of that bug were IN THE FILE -- one rule's pattern fired on another rule's
 * pattern text, and the two meant different things. That is a property the pack can be asked about
 * directly, so a future edit cannot reintroduce the class by hand.
 *
 * WHY "different resolution" and not "different pattern": two rules that mean the SAME thing are
 * allowed, and required, to overlap. PETRO-CANADA and PETRO CANADA are one merchant spelled two
 * ways; `word XBOX` sits underneath `contains XBOX GAME PASS` on purpose; RACHELLE-BÉRY and
 * RACHELLE-BERY are the same grocer with and without the accent a bank may or may not print.
 * Flagging those would make the guard noise, and noise is how a guard gets deleted. Only a pair
 * that DISAGREES about where the money goes can misfile anything.
 */
describe('shipped pack: no rule fires on another rule\'s pattern text (cross-collision guard)', () => {
  /** A category rule resolves to a (parent, child) pair; a rename rule resolves to a display name
   *  and asserts no category at all, which is why the two kinds can never be compared as equal. */
  function resolutionOf(rule: PackRule): string {
    return rule.rule_kind === 'rename'
      ? `rename -> ${rule.rename_to}`
      : `category -> ${rule.category_parent} > ${rule.category}`;
  }

  /**
   * The ONE accepted pair, with the reason spelled out per entry rather than the check being
   * weakened for everybody. Keyed `matcher|matched`, so an allowance is directional: permitting
   * AMAZON to see AMAZON PRIME does not also permit the reverse.
   */
  const CROSS_COLLISION_ALLOWED: ReadonlyMap<string, string> = new Map([
    [
      'AMAZON|AMAZON PRIME',
      'Deliberate prefix pair, and the overlap IS the design. `contains AMAZON` is a rename-only ' +
        'rule (no category at all, so it cannot misfile anything), and on a real transaction ' +
        'matchRule hands AMAZON PRIME the win anyway -- longest matching pattern first, and ' +
        '"AMAZON PRIME" is longer than "AMAZON". Removing either rule would be worse: without ' +
        'the rename, every AMZN line keeps its raw text; without the category rule, a Prime ' +
        'subscription stops being a Subscription.',
    ],
  ]);

  function findCrossCollisions(rules: readonly PackRule[], allowed: ReadonlyMap<string, string>): string[] {
    const found: string[] = [];
    for (const matcher of rules) {
      for (const matched of rules) {
        if (matcher === matched) continue;
        if (resolutionOf(matcher) === resolutionOf(matched)) continue;
        if (!patternMatches(matcher.pattern, matcher.match_type, matched.pattern)) continue;
        if (allowed.has(`${matcher.pattern}|${matched.pattern}`)) continue;
        found.push(
          `${matcher.match_type} ${matcher.pattern} (${resolutionOf(matcher)}) fires on the pattern text of ${matched.pattern} (${resolutionOf(matched)})`,
        );
      }
    }
    return found;
  }

  it('no pair of rules with different outcomes matches the other\'s pattern', () => {
    expect(findCrossCollisions(loadPack().rules, CROSS_COLLISION_ALLOWED)).toEqual([]);
  });

  /**
   * The check has to be shown to FAIL on the bug it was written for, or "it passes" means nothing:
   * a check that silently matched no pairs at all -- a typo in resolutionOf, a patternMatches
   * signature that changed argument order -- would also pass the assertion above forever. The pair
   * below is the shipped v2 defect reconstructed exactly, in the test rather than in the pack.
   */
  it('would FAIL on a deliberately colliding pair, and the allow-list is what accepts one', () => {
    const colliding: PackRule[] = [
      { pattern: 'METRO', match_type: 'contains', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null },
      { pattern: 'METROLINX', match_type: 'word', rule_kind: 'category', category: 'Transit', category_parent: 'Transport', rename_to: null },
    ];

    const found = findCrossCollisions(colliding, new Map());
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('contains METRO');
    expect(found[0]).toContain('METROLINX');

    expect(findCrossCollisions(colliding, new Map([['METRO|METROLINX', 'accepted for this test']]))).toEqual([]);
  });

  it('every allow-list entry still names a pair the pack actually has', () => {
    const patterns = new Set(loadPack().rules.map((r) => r.pattern));
    const stale = [...CROSS_COLLISION_ALLOWED.keys()].filter((key) => key.split('|').some((p) => !patterns.has(p)));
    expect(stale).toEqual([]);
  });

  it('every allow-list entry carries a reason, not just a key', () => {
    const unexplained = [...CROSS_COLLISION_ALLOWED.entries()].filter(([, why]) => why.trim().length < 40).map(([key]) => key);
    expect(unexplained).toEqual([]);
  });

  /**
   * v1.25.0 (item 16) restricted `word` to category and rename rules, enforced at the form's write
   * choke point and again in matchRule. The pack is a THIRD way rules reach the table, and the
   * importer skips an illegal entry silently-but-countably rather than failing the file -- so a
   * `word` transfer rule smuggled into this JSON would import as a skip, not an error, and the
   * "imports with zero skipped entries" test above is the only thing that would notice. This says
   * it directly, against the same predicate matchRule uses.
   */
  it('every rule\'s match type is legal for its rule kind', () => {
    const illegal = loadPack()
      .rules.filter((rule) => !matchTypeAllowedForKind(rule.match_type, rule.rule_kind))
      .map((rule) => `${rule.match_type} ${rule.pattern} (${rule.rule_kind})`);
    expect(illegal).toEqual([]);
  });
});

/**
 * pack_version 3's bilingual coverage rests on one measured fact about normalizeMerchant: it
 * uppercases and it preserves the Latin-1 accented block (the ALNUM class in normalize.ts exists
 * for exactly that), and it does NOT fold É to E. So an accented pattern matches accented text and
 * nothing else, and a bank that prints ASCII gets no match at all from it. Canadian banks print
 * both. The pack's answer -- already its practice for HYDRO-QUÉBEC and ÉNERGIR, now a rule -- is
 * to ship BOTH spellings of every accented brand, and the structural test below is what keeps a
 * future edit from adding the accented half alone and quietly covering nobody.
 */
describe('shipped pack: accented patterns ship beside their unaccented spelling', () => {
  const deaccent = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '');

  function resolutionOf(rule: PackRule): string {
    return rule.rule_kind === 'rename'
      ? `rename -> ${rule.rename_to}`
      : `category -> ${rule.category_parent} > ${rule.category}`;
  }

  it('normalizeMerchant preserves accents and never folds them, so the two spellings are two patterns', () => {
    expect(normalizeMerchant('RACHELLE-BÉRY #12 MONTREAL QC')).toBe('RACHELLE-BÉRY');
    expect(normalizeMerchant('VIDÉOTRON MTL QC')).toBe('VIDÉOTRON');
    // The accented pattern does NOT reach the ASCII spelling, which is the whole reason for the
    // sibling rule -- BÉRY and BERY are different tokens, not a token and its prefix.
    expect(patternMatches('RACHELLE-BÉRY', 'word', normalizeMerchant('RACHELLE-BERY #12 MONTREAL QC'))).toBe(false);
    expect(patternMatches('RACHELLE-BERY', 'word', normalizeMerchant('RACHELLE-BÉRY #12 MONTREAL QC'))).toBe(false);
    // Each spelling is reached by its own rule, which is why both ship.
    expect(patternMatches('RACHELLE-BÉRY', 'word', normalizeMerchant('RACHELLE-BÉRY #12 MONTREAL QC'))).toBe(true);
    expect(patternMatches('RACHELLE-BERY', 'word', normalizeMerchant('RACHELLE-BERY #12 MONTREAL QC'))).toBe(true);
  });

  it('an apostrophe survives inside an accented Quebec brand too (L\'ÉQUIPEUR is ONE token)', () => {
    expect(normalizeMerchant("L'ÉQUIPEUR #221 QUEBEC QC")).toBe("L'ÉQUIPEUR");
    expect(patternMatches("L'ÉQUIPEUR", 'word', normalizeMerchant("L'ÉQUIPEUR #221 QUEBEC QC"))).toBe(true);
  });

  it('every accented pattern has an unaccented sibling of the same kind and outcome', () => {
    const pack = loadPack();
    const orphans = pack.rules
      .filter((rule) => deaccent(rule.pattern) !== rule.pattern)
      .filter(
        (rule) =>
          !pack.rules.some(
            (other) =>
              other.pattern === deaccent(rule.pattern) &&
              other.rule_kind === rule.rule_kind &&
              resolutionOf(other) === resolutionOf(rule),
          ),
      )
      .map((rule) => rule.pattern);
    expect(orphans).toEqual([]);
  });
});

/**
 * pack_version 3 added six `exact` rules on top of RONA, and every one of them is a deliberate
 * refusal to be broad rather than an oversight. Two reasons, both of which cost real coverage and
 * are paid anyway:
 *
 *   - the brand text IS a person's name (IRVING, ADONIS, PATRICK MORIN). Identical to RONA: no
 *     boundary rule can tell a store from a person, so the only defence is not being broad.
 *   - the brand text is a three-letter agency acronym with no verified suffix (RTC, STL, RTL, STS,
 *     EXO). TTC and STM are `word` because this file can name the statement lines that promotion
 *     buys (TTC MONTHLY PASS, STM OPUS RECHARGE); for these five it cannot, and a three-letter
 *     token is the highest-collision-density pattern shape in the pack. `exact` still reaches the
 *     fare-machine line, because a reference number and a trailing CITY PROVINCE are exactly what
 *     normalizeMerchant strips.
 *
 * Each row asserts what `word` WOULD have done, so the cost of `exact` is stated rather than
 * assumed -- if a future release can source a real suffix for one of these, the promotion has this
 * test to argue with.
 */
describe('shipped pack: the exact-by-design rules and the collision each one dodges', () => {
  function ruleFor(pattern: string): { pattern: string; match_type: MatchType } {
    const rule = loadPack().rules.find((r) => r.pattern === pattern);
    if (!rule) throw new Error(`no rule for pattern ${pattern} in the shipped pack -- did the pattern text change?`);
    return rule;
  }

  const exactByDesign: { pattern: string; reason: string; reaches: string; mustNotReach: string }[] = [
    { pattern: 'IRVING', reason: 'Irving is a given name and a surname', reaches: 'IRVING #1042 MONCTON NB', mustNotReach: 'E-TRANSFER SENT IRVING BLOOM' },
    { pattern: 'ADONIS', reason: 'Adonis is a given name', reaches: 'ADONIS #6 LAVAL QC', mustNotReach: 'E-TRANSFER SENT ADONIS PAPPAS' },
    { pattern: 'PATRICK MORIN', reason: 'the banner is literally a person\'s full name', reaches: 'PATRICK MORIN #12 JOLIETTE QC', mustNotReach: 'E-TRANSFER SENT PATRICK MORIN JR' },
    { pattern: 'RTC', reason: 'a three-letter acronym with no sourced suffix', reaches: 'RTC 1234567 QUEBEC QC', mustNotReach: 'RTC LOGISTICS GROUP BARRIE ON' },
    { pattern: 'STL', reason: 'a three-letter acronym with no sourced suffix', reaches: 'STL 4567890 LAVAL QC', mustNotReach: 'STL FREIGHT SYSTEMS MISSISSAUGA ON' },
    { pattern: 'RTL', reason: 'a three-letter acronym with no sourced suffix', reaches: 'RTL 9876543 LONGUEUIL QC', mustNotReach: 'RTL TOOLING SUPPLY WINDSOR ON' },
    { pattern: 'STS', reason: 'a three-letter acronym with no sourced suffix', reaches: 'STS 1122334 SHERBROOKE QC', mustNotReach: 'STS SAFETY SUPPLY EDMONTON AB' },
    { pattern: 'EXO', reason: 'a three-letter acronym with no sourced suffix', reaches: 'EXO 7654321 MONTREAL QC', mustNotReach: 'EXO FITNESS STUDIO TORONTO ON' },
  ];

  it.each(exactByDesign)('$pattern stays exact because $reason', ({ pattern, reaches, mustNotReach }) => {
    const rule = ruleFor(pattern);
    expect(rule.match_type).toBe('exact');
    expect(patternMatches(rule.pattern, rule.match_type, normalizeMerchant(reaches))).toBe(true);
    expect(patternMatches(rule.pattern, rule.match_type, normalizeMerchant(mustNotReach))).toBe(false);
    // The collision is real, not hypothetical: `word` -- this pack's default for a brand -- fires.
    expect(patternMatches(pattern, 'word', normalizeMerchant(mustNotReach))).toBe(true);
  });
});
