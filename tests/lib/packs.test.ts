import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import {
  PACK_VERSION,
  PROFILES_PACK_FORMAT,
  PackFormatError,
  RULES_PACK_FORMAT,
  exportProfilesPack,
  exportRulesPack,
  importProfilesPack,
  importRulesPack,
  packFilename,
  parseProfilesPack,
  parseRulesPack,
  previewProfilesPackExport,
  previewRulesPackExport,
  previewRulesPackImport,
} from '@/lib/packs';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { listCategories } from '@/lib/categories';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';
import { BUILTIN_PRESET_NAMES, getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const coffee = categoryIdByName(current.db, 'Coffee');
  const groceries = categoryIdByName(current.db, 'Groceries');
  const kids = categoryIdByName(current.db, 'Kids');
  upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'LOBLAWS', matchType: 'contains', ruleKind: 'category', categoryId: groceries, createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'TOY STORE', matchType: 'exact', ruleKind: 'category', categoryId: kids, createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
  return { db: current.db, sqlite: current.sqlite, userId, coffee, groceries, kids };
}

/** Insert a bare transaction row, the way an import would leave it (categorization_source 'none'). */
function addTxn(db: TestDb['db'], accountId: number, userId: number, rawDescription: string): number {
  const row = db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${rawDescription}, ${normalizeMerchant(rawDescription)}, -1000, 'none', ${userId}, ${nowIso()}, ${nowIso()})
    returning id`);
  return row.id;
}

describe('rules pack envelope', () => {
  it('stamps the format, version and export timestamp', () => {
    setup();
    const pack = exportRulesPack({ at: new Date('2026-08-15T12:00:00.000Z') });
    expect(pack.format).toBe(RULES_PACK_FORMAT);
    expect(RULES_PACK_FORMAT).toBe('budget-tracker-rules');
    expect(pack.version).toBe(PACK_VERSION);
    expect(PACK_VERSION).toBe(1);
    expect(pack.exported_at).toBe('2026-08-15T12:00:00.000Z');
  });

  it('names the download file by format and date', () => {
    expect(packFilename(RULES_PACK_FORMAT, new Date('2026-08-15T12:00:00.000Z'))).toBe('budget-tracker-rules-2026-08-15.json');
    expect(packFilename(PROFILES_PACK_FORMAT, new Date('2026-08-15T12:00:00.000Z'))).toBe('budget-tracker-profiles-2026-08-15.json');
  });
});

describe('rules pack privacy', () => {
  it('carries no transactions, amounts, accounts, users or Bayes statistics', () => {
    setup();
    const serialized = JSON.stringify(exportRulesPack());
    expect(Object.keys(exportRulesPack()).sort()).toEqual(['categories', 'exported_at', 'format', 'rules', 'version']);
    for (const forbidden of ['transaction', 'amount_cents', 'account', 'user', 'bayes', 'token', 'created_by', 'hit_count', 'dedup']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('excludes transfer rules by default', () => {
    setup();
    const pack = exportRulesPack();
    expect(pack.rules.map((r) => r.pattern)).not.toContain('E-TRANSFER SENT J DOE');
    expect(pack.rules).toHaveLength(3);
    expect(pack.rules.every((r) => r.rule_kind === 'category')).toBe(true);
  });

  it('includes transfer rules only when explicitly asked', () => {
    setup();
    const pack = exportRulesPack({ includeTransferRules: true });
    expect(pack.rules).toHaveLength(4);
    const transfer = pack.rules.find((r) => r.rule_kind === 'transfer')!;
    expect(transfer).toMatchObject({ pattern: 'E-TRANSFER SENT J DOE', match_type: 'exact', category: null, category_parent: null });
  });

  // Controller ruling (a) — revised 2026-08-31: rename rules ARE exportable now, but only
  // behind their own explicit opt-in (includeRenameRules), off by default and independent of
  // the transfer toggle — the risk is disclosure of free text a person typed, not a difference
  // of taste. See src/lib/packs.ts's controller ruling (a) docblock for the full argument.
  it('excludes rename rules from export unless includeRenameRules is explicitly set', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: null, renameTo: "McDonald's", createdBy: userId, actorRole: 'admin' });
    expect(exportRulesPack().rules.some((r) => r.pattern === 'MCDONALDS')).toBe(false);
    // The transfer toggle alone does not pull renames in -- they are independent opt-ins.
    expect(exportRulesPack({ includeTransferRules: true }).rules).toHaveLength(4);
    expect(previewRulesPackExport({ includeTransferRules: true }).some((r) => r.ruleKind === 'rename')).toBe(false);
    expect(JSON.stringify(exportRulesPack())).not.toContain("McDonald's");
  });

  it('includes rename rules, WITH their target text, only when includeRenameRules is set', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: null, renameTo: "McDonald's", createdBy: userId, actorRole: 'admin' });

    const pack = exportRulesPack({ includeRenameRules: true });
    expect(pack.rules).toHaveLength(4); // 3 category + the 1 rename (transfer stays excluded, its own toggle is off)
    const rename = pack.rules.find((r) => r.rule_kind === 'rename')!;
    expect(rename).toMatchObject({ pattern: 'MCDONALDS', match_type: 'exact', category: null, category_parent: null, rename_to: "McDonald's" });
    expect(JSON.stringify(pack)).toContain("McDonald's");

    const withBoth = exportRulesPack({ includeTransferRules: true, includeRenameRules: true });
    expect(withBoth.rules).toHaveLength(5);
  });

  it('surfaces the rename target text in the export preview, so an opt-in is informed consent', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: null, renameTo: "McDonald's", createdBy: userId, actorRole: 'admin' });
    // renameTo is present in the preview row regardless of the toggle -- the household needs to
    // see the text BEFORE deciding whether to opt in, not after.
    const withoutOptIn = previewRulesPackExport();
    expect(withoutOptIn.some((r) => r.pattern === 'MCDONALDS')).toBe(false);
    const withOptIn = previewRulesPackExport({ includeRenameRules: true });
    expect(withOptIn.find((r) => r.pattern === 'MCDONALDS')).toMatchObject({ ruleKind: 'rename', renameTo: "McDonald's", categoryLabel: null });
  });

  it('excludeRuleIds can drop a single rename while keeping the others', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'MCDONALDS', matchType: 'exact', ruleKind: 'rename', categoryId: null, renameTo: "McDonald's", createdBy: userId, actorRole: 'admin' });
    upsertRuleFromCorrection({ pattern: 'WALMART', matchType: 'contains', ruleKind: 'rename', categoryId: null, renameTo: 'Walmart', createdBy: userId, actorRole: 'admin' });

    const rows = previewRulesPackExport({ includeRenameRules: true });
    const mcdonalds = rows.find((r) => r.pattern === 'MCDONALDS')!.ruleId;
    const pack = exportRulesPack({ includeRenameRules: true, excludeRuleIds: [mcdonalds] });
    const renames = pack.rules.filter((r) => r.rule_kind === 'rename');
    expect(renames.map((r) => r.pattern)).toEqual(['WALMART']);
  });

  // Controller ruling (a): 'not_transfer' (added post-brief) is excluded from packs
  // for the same reason as rename — it's a local override, not shareable knowledge.
  it('never exports not_transfer rules, even with the transfer toggle on (controller ruling a)', () => {
    const { userId } = setup();
    upsertRuleFromCorrection({ pattern: 'ACME PAYROLL CO', matchType: 'exact', ruleKind: 'not_transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
    expect(exportRulesPack().rules.some((r) => r.pattern === 'ACME PAYROLL CO')).toBe(false);
    const withTransfers = exportRulesPack({ includeTransferRules: true });
    expect(withTransfers.rules).toHaveLength(4);
    expect(withTransfers.rules.some((r) => r.pattern === 'ACME PAYROLL CO')).toBe(false);
    expect(previewRulesPackExport({ includeTransferRules: true }).some((r) => r.ruleKind === 'not_transfer')).toBe(false);
  });

  // Controller ruling (a) — revised 2026-08-31: rename is importable now (only export keeps the
  // opt-in). Importing a rename creates the rule -- it is never skipped.
  it('imports a rename rule entry rather than skipping it', () => {
    setup();
    const pack = {
      ...exportRulesPack(),
      rules: [{ pattern: 'mcdonalds', match_type: 'exact', rule_kind: 'rename', category: null, rename_to: "McDonald's" }],
    };
    expect(() => parseRulesPack(pack)).not.toThrow();

    const plan = previewRulesPackImport(pack);
    expect(plan).toMatchObject({ totalRules: 1, newRules: 1, unchanged: 0, skippedRules: 0, conflicts: [] });

    const result = importRulesPack(pack);
    expect(result).toMatchObject({ rulesAdded: 1, rulesOverwritten: 0, rulesKept: 0, rulesSkipped: 0 });
    const rule = listRules('rename').find((r) => r.pattern === 'MCDONALDS');
    // Required care item 3: patterns are uppercased at the write choke point even when the pack
    // itself was authored lowercase.
    expect(rule?.pattern).toBe('MCDONALDS');
    expect(rule?.renameTo).toBe("McDonald's");
  });

  it('rejects a rename entry with no non-empty rename_to, rather than silently skipping it', () => {
    setup();
    const noTarget = {
      ...exportRulesPack(),
      rules: [{ pattern: 'MCDONALDS', match_type: 'exact', rule_kind: 'rename', category: null, rename_to: null }],
    };
    expect(() => parseRulesPack(noTarget)).toThrowError(PackFormatError);
    expect(() => parseRulesPack(noTarget)).toThrowError(/rename rule needs a non-empty rename_to/i);

    const blankTarget = {
      ...exportRulesPack(),
      rules: [{ pattern: 'MCDONALDS', match_type: 'exact', rule_kind: 'rename', category: null, rename_to: '   ' }],
    };
    expect(() => parseRulesPack(blankTarget)).toThrowError(PackFormatError);
  });

  it('skips a not_transfer rule entry in an incoming pack gracefully', () => {
    setup();
    const pack = {
      ...exportRulesPack(),
      rules: [{ pattern: 'ACME PAYROLL CO', match_type: 'exact', rule_kind: 'not_transfer', category: null }],
    };
    const plan = previewRulesPackImport(pack);
    expect(plan.skippedRules).toBe(1);
    const result = importRulesPack(pack);
    expect(result.rulesSkipped).toBe(1);
    expect(listRules('not_transfer')).toHaveLength(0);
  });

  it('skips an entirely unrecognised rule_kind gracefully rather than crashing', () => {
    setup();
    const pack = {
      ...exportRulesPack(),
      rules: [{ pattern: 'SOMETHING NEW', match_type: 'exact', rule_kind: 'future_kind_v2', category: null }],
    };
    const result = importRulesPack(pack);
    expect(result.rulesSkipped).toBe(1);
    expect(result.rulesAdded).toBe(0);
  });
});

describe('rules pack export preview', () => {
  it('lists every pattern that would leave the system, with its category label', () => {
    setup();
    const rows = previewRulesPackExport();
    expect(rows.map((r) => r.pattern).sort()).toEqual(['LOBLAWS', 'TIM HORTONS', 'TOY STORE']);
    expect(rows.find((r) => r.pattern === 'TIM HORTONS')).toMatchObject({ matchType: 'exact', ruleKind: 'category', categoryLabel: 'Food › Coffee', hitCount: 0 });
    expect(rows.find((r) => r.pattern === 'TOY STORE')?.categoryLabel).toBe('Kids');
  });

  it('shows transfer rules in the preview when the toggle is on', () => {
    setup();
    expect(previewRulesPackExport({ includeTransferRules: true })).toHaveLength(4);
  });

  it('honours per-rule exclusion checkboxes', () => {
    setup();
    const rows = previewRulesPackExport();
    const excluded = rows.find((r) => r.pattern === 'LOBLAWS')!.ruleId;
    const pack = exportRulesPack({ excludeRuleIds: [excluded] });
    expect(pack.rules.map((r) => r.pattern).sort()).toEqual(['TIM HORTONS', 'TOY STORE']);
  });

  it('only exports the categories the surviving rules actually reference', () => {
    setup();
    const rows = previewRulesPackExport();
    const pack = exportRulesPack({ excludeRuleIds: rows.filter((r) => r.pattern !== 'TIM HORTONS').map((r) => r.ruleId) });
    expect(pack.categories.map((c) => c.name).sort()).toEqual(['Coffee', 'Food']);
    expect(pack.categories.find((c) => c.name === 'Coffee')).toMatchObject({ parent: 'Food', is_income: false });
    expect(pack.categories.find((c) => c.name === 'Food')).toMatchObject({ parent: null });
  });

  it('emits the parent of every referenced child so nothing dangles', () => {
    setup();
    const pack = exportRulesPack();
    const names = new Set(pack.categories.map((c) => c.name));
    for (const category of pack.categories) {
      if (category.parent !== null) expect(names.has(category.parent)).toBe(true);
    }
  });
});

describe('envelope rejection', () => {
  it('rejects an unknown format with a clear message', () => {
    setup();
    expect(() => parseRulesPack({ format: 'mint-export', version: 1, exported_at: '', categories: [], rules: [] })).toThrowError(PackFormatError);
    expect(() => parseRulesPack({ format: 'mint-export', version: 1, exported_at: '', categories: [], rules: [] })).toThrowError(
      /not a budget tracker rules pack/i,
    );
  });

  it('rejects a profiles pack fed to the rules importer and vice versa', () => {
    setup();
    const profiles = exportProfilesPack();
    expect(() => parseRulesPack(profiles)).toThrowError(/rules pack/i);
    expect(() => parseProfilesPack(exportRulesPack())).toThrowError(/profiles pack/i);
  });

  it('rejects a pack from a newer version', () => {
    setup();
    expect(() => parseRulesPack({ ...exportRulesPack(), version: 2 })).toThrowError(/newer version/i);
    expect(() => parseProfilesPack({ ...exportProfilesPack(), version: 99 })).toThrowError(/newer version/i);
  });

  it('rejects malformed input rather than throwing a raw zod error', () => {
    setup();
    expect(() => parseRulesPack(null)).toThrowError(PackFormatError);
    expect(() => parseRulesPack('{}')).toThrowError(PackFormatError);
    expect(() => parseRulesPack({ format: RULES_PACK_FORMAT, version: 1 })).toThrowError(PackFormatError);
    expect(() => parseRulesPack({ ...exportRulesPack(), version: 0 })).toThrowError(PackFormatError);
  });

  it('accepts the minimal shape from the spec example, without rule_kind or category_parent', () => {
    setup();
    const minimal = {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [{ name: 'Coffee', parent: 'Food', is_income: false, icon: null, color: null }],
      rules: [{ pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' }],
    };
    const parsed = parseRulesPack(minimal);
    expect(parsed.rules[0]).toMatchObject({ pattern: 'SECOND CUP', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: null });
  });

  it('rejects a pack whose category chain nests more than two levels deep', () => {
    setup();
    const deep = {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [
        { name: 'Pets', parent: null, is_income: false, icon: null, color: null },
        { name: 'Vet', parent: 'Pets', is_income: false, icon: null, color: null },
        { name: 'Emergency Vet', parent: 'Vet', is_income: false, icon: null, color: null },
      ],
      rules: [{ pattern: 'EMERGENCY VET CLINIC', match_type: 'exact', category: 'Emergency Vet', category_parent: 'Vet' }],
    };
    expect(() => parseRulesPack(deep)).toThrowError(PackFormatError);
    expect(() => parseRulesPack(deep)).toThrowError(/more than two levels/i);
  });

  it('rejects a pack with a parent/child cycle rather than looping forever', () => {
    setup();
    const cyclic = {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [
        { name: 'A', parent: 'B', is_income: false, icon: null, color: null },
        { name: 'B', parent: 'A', is_income: false, icon: null, color: null },
      ],
      rules: [],
    };
    expect(() => parseRulesPack(cyclic)).toThrowError(PackFormatError);
  });
});

describe('importRulesPack', () => {
  function packFrom(rules: { pattern: string; match_type: 'exact' | 'contains'; category: string | null; category_parent?: string | null; rule_kind?: 'category' | 'transfer' }[], categories: { name: string; parent: string | null }[]) {
    return {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: categories.map((c) => ({ ...c, is_income: false, icon: null, color: null })),
      rules,
    };
  }

  it('creates missing categories by name, reusing existing ones case-insensitively', () => {
    const { db } = setup();
    const before = listCategories().length;
    const pack = packFrom(
      [
        { pattern: 'SECOND CUP', match_type: 'exact', category: 'coffee' },
        { pattern: 'PET SUPPLIES', match_type: 'contains', category: 'Pets' },
      ],
      [
        { name: 'coffee', parent: 'FOOD' },
        { name: 'Pets', parent: null },
      ],
    );

    const result = importRulesPack(pack);
    expect(result.categoriesCreated).toBe(1);
    expect(listCategories().length).toBe(before + 1);

    const coffeeId = categoryIdByName(db, 'Coffee');
    const secondCup = listRules('category').find((r) => r.pattern === 'SECOND CUP')!;
    expect(secondCup.categoryId).toBe(coffeeId);

    const pets = listCategories().find((c) => c.name === 'Pets')!;
    expect(pets.parentId).toBeNull();
    expect(listRules('category').find((r) => r.pattern === 'PET SUPPLIES')?.categoryId).toBe(pets.id);
  });

  it('creates a missing parent before its child', () => {
    setup();
    const pack = packFrom([{ pattern: 'VET CLINIC', match_type: 'exact', category: 'Vet', category_parent: 'Pets' }], [
      { name: 'Pets', parent: null },
      { name: 'Vet', parent: 'Pets' },
    ]);
    importRulesPack(pack);
    const all = listCategories();
    const pets = all.find((c) => c.name === 'Pets')!;
    const vet = all.find((c) => c.name === 'Vet')!;
    expect(vet.parentId).toBe(pets.id);
  });

  it('disambiguates a repeated leaf name using category_parent', () => {
    setup();
    const pack = packFrom(
      [
        { pattern: 'ODD ONE', match_type: 'exact', category: 'Other', category_parent: 'Personal' },
        { pattern: 'ODD TWO', match_type: 'exact', category: 'Other', category_parent: 'Fees' },
      ],
      [
        { name: 'Other', parent: 'Personal' },
        { name: 'Other', parent: 'Fees' },
      ],
    );
    importRulesPack(pack);
    const all = listCategories();
    const personal = all.find((c) => c.name === 'Personal' && c.parentId === null)!;
    const fees = all.find((c) => c.name === 'Fees' && c.parentId === null)!;
    const one = listRules('category').find((r) => r.pattern === 'ODD ONE')!;
    const two = listRules('category').find((r) => r.pattern === 'ODD TWO')!;
    expect(all.find((c) => c.id === one.categoryId)?.parentId).toBe(personal.id);
    expect(all.find((c) => c.id === two.categoryId)?.parentId).toBe(fees.id);
    expect(one.categoryId).not.toBe(two.categoryId);
  });

  it('gives imported rules created_by NULL and hit_count 0', () => {
    const { sqlite } = setup();
    importRulesPack(packFrom([{ pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' }], [{ name: 'Coffee', parent: 'Food' }]));
    const row = sqlite.prepare("select created_by, hit_count, last_used_at from merchant_rules where pattern = 'SECOND CUP'").get() as {
      created_by: number | null;
      hit_count: number;
      last_used_at: string | null;
    };
    expect(row).toEqual({ created_by: null, hit_count: 0, last_used_at: null });
  });

  it('keeps the existing rule on a conflict by default', () => {
    const { coffee, groceries } = setup();
    const result = importRulesPack(
      packFrom([{ pattern: 'TIM HORTONS', match_type: 'exact', category: 'Groceries' }], [{ name: 'Groceries', parent: 'Food' }]),
    );
    expect(result).toMatchObject({ rulesAdded: 0, rulesOverwritten: 0, rulesKept: 1 });
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(coffee);
    expect(groceries).toBeGreaterThan(0);
  });

  it('overwrites on request, resetting hit_count, and preserves who originally set the rule up', () => {
    const { sqlite, groceries, userId } = setup();
    sqlite.prepare("update merchant_rules set hit_count = 42 where pattern = 'TIM HORTONS'").run();
    const result = importRulesPack(
      packFrom([{ pattern: 'TIM HORTONS', match_type: 'exact', category: 'Groceries' }], [{ name: 'Groceries', parent: 'Food' }]),
      { onConflict: 'overwrite' },
    );
    expect(result).toMatchObject({ rulesAdded: 0, rulesOverwritten: 1, rulesKept: 0 });
    const row = sqlite
      .prepare("select category_id, created_by, last_modified_by, hit_count from merchant_rules where pattern = 'TIM HORTONS'")
      .get() as {
      category_id: number;
      created_by: number | null;
      last_modified_by: number | null;
      hit_count: number;
    };
    // v1.13.0 ruling R4: created_by is never rewritten by the shared upsert once a rule exists
    // (see rules.ts), so a pack re-import over Alice's own rule keeps her as its author. Only
    // last_modified_by moves, to null, recording the import as a system touch rather than hers.
    expect(row).toEqual({ category_id: groceries, created_by: userId, last_modified_by: null, hit_count: 0 });
  });

  it('is not a conflict when the incoming rule already matches', () => {
    setup();
    const result = importRulesPack(packFrom([{ pattern: 'TIM HORTONS', match_type: 'exact', category: 'Coffee' }], [{ name: 'Coffee', parent: 'Food' }]));
    expect(result).toMatchObject({ rulesAdded: 0, rulesOverwritten: 0, rulesKept: 0 });
  });

  it('treats (pattern, match_type, rule_kind) as the identity, not pattern alone', () => {
    setup();
    const result = importRulesPack(
      packFrom([{ pattern: 'TIM HORTONS', match_type: 'contains', category: 'Groceries' }], [{ name: 'Groceries', parent: 'Food' }]),
    );
    expect(result.rulesAdded).toBe(1);
    expect(listRules('category').filter((r) => r.pattern === 'TIM HORTONS')).toHaveLength(2);
  });

  it('never touches Bayes tables', () => {
    const { sqlite } = setup();
    importRulesPack(packFrom([{ pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' }], [{ name: 'Coffee', parent: 'Food' }]));
    expect((sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from bayes_category_totals').get() as { c: number }).c).toBe(0);
  });

  it('handles duplicate category and rule entries in the same pack without duplicating rows', () => {
    const { db } = setup();
    const before = listCategories().length;
    const pack = packFrom(
      [
        { pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' },
        { pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' },
      ],
      [
        { name: 'Coffee', parent: 'Food' },
        { name: 'Coffee', parent: 'Food' },
      ],
    );
    const result = importRulesPack(pack);
    expect(result.categoriesCreated).toBe(0);
    expect(listCategories().length).toBe(before);
    expect(listRules('category').filter((r) => r.pattern === 'SECOND CUP')).toHaveLength(1);
    const coffee = categoryIdByName(db, 'Coffee');
    expect(listRules('category').find((r) => r.pattern === 'SECOND CUP')?.categoryId).toBe(coffee);
  });

  it('handles a large pack (many categories and rules) without crashing or hanging', () => {
    setup();
    const categories = Array.from({ length: 150 }, (_, i) => ({ name: `Custom Root ${i}`, parent: null }));
    const rules = Array.from({ length: 1000 }, (_, i) => ({
      pattern: `MERCHANT ${i}`,
      match_type: 'exact' as const,
      category: `Custom Root ${i % 150}`,
    }));
    const pack = packFrom(rules, categories);
    const result = importRulesPack(pack);
    expect(result.rulesAdded).toBe(1000);
    expect(result.categoriesCreated).toBe(150);
  }, 20000);
});

describe('previewRulesPackImport', () => {
  it('reports new rules, conflicts and new categories before writing anything', () => {
    const { sqlite } = setup();
    const pack = {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [
        { name: 'Coffee', parent: 'Food', is_income: false, icon: null, color: null },
        { name: 'Pets', parent: null, is_income: false, icon: null, color: null },
      ],
      rules: [
        { pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' },
        { pattern: 'TIM HORTONS', match_type: 'exact', category: 'Pets' },
        { pattern: 'LOBLAWS', match_type: 'contains', category: 'Groceries' },
        { pattern: 'E-TRANSFER SENT J DOE', match_type: 'exact', rule_kind: 'transfer', category: null },
      ],
    };
    const before = (sqlite.prepare('select count(*) as c from merchant_rules').get() as { c: number }).c;

    const plan = previewRulesPackImport(pack);
    expect(plan.totalRules).toBe(4);
    expect(plan.newRules).toBe(1);
    expect(plan.unchanged).toBe(2); // LOBLAWS already matches; the transfer rule already exists
    expect(plan.transferRules).toBe(1);
    expect(plan.skippedRules).toBe(0);
    expect(plan.newCategories).toEqual(['Pets']);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ pattern: 'TIM HORTONS', matchType: 'exact', existingCategory: 'Food › Coffee', incomingCategory: 'Pets' });

    expect((sqlite.prepare('select count(*) as c from merchant_rules').get() as { c: number }).c).toBe(before);
    expect(sqlite.prepare("select count(*) as c from categories where name = 'Pets'").get()).toEqual({ c: 0 });
  });
});

describe('importRulesPack applies renames retroactively', () => {
  function renamePack(pattern: string, renameTo: string) {
    return {
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [],
      rules: [{ pattern, match_type: 'exact', rule_kind: 'rename', category: null, rename_to: renameTo }],
    };
  }

  // Required care item 2: the form path (upsertRenameRule) runs the engine's reapply pass, so an
  // imported rename must too -- otherwise it would sit in merchant_rules changing nothing until
  // some unrelated re-run happened to touch the row.
  it('changes a matching transaction\'s display immediately, the same way saving one on the form does', () => {
    const { db, sqlite, userId } = setup();
    const accountId = insertTestAccount(db);
    const id = addTxn(db, accountId, userId, 'MCDONALDS #4821 TORONTO ON');

    importRulesPack(renamePack('MCDONALDS', "McDonald's"));

    const row = sqlite.prepare('select display_description, display_source from transactions where id = ?').get(id) as {
      display_description: string | null;
      display_source: string | null;
    };
    expect(row).toEqual({ display_description: "McDonald's", display_source: 'rename' });
  });

  it('never overwrites a transaction a household member renamed by hand (display_source = manual)', () => {
    const { db, sqlite, userId } = setup();
    const accountId = insertTestAccount(db);
    const id = addTxn(db, accountId, userId, 'MCDONALDS #4821 TORONTO ON');
    sqlite
      .prepare("update transactions set display_description = ?, display_source = 'manual' where id = ?")
      .run('Lunch with Bob', id);

    importRulesPack(renamePack('MCDONALDS', "McDonald's"));

    const row = sqlite.prepare('select display_description, display_source from transactions where id = ?').get(id) as {
      display_description: string | null;
      display_source: string | null;
    };
    expect(row).toEqual({ display_description: 'Lunch with Bob', display_source: 'manual' });
  });

  it('leaves an unrelated manual rename alone when the pack has no rename rules at all', () => {
    const { db, sqlite, userId } = setup();
    const accountId = insertTestAccount(db);
    const id = addTxn(db, accountId, userId, 'SECOND CUP #12');
    sqlite.prepare("update transactions set display_description = ?, display_source = 'manual' where id = ?").run('Study coffee', id);

    // A category-only pack still runs the ensureCategory/upsert machinery; this asserts the
    // renameRulesWritten guard correctly skips the reapply pass (no rename rows were written),
    // leaving the manual row exactly as it was rather than merely "still correct by coincidence".
    importRulesPack({
      format: RULES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      categories: [{ name: 'Coffee', parent: 'Food', is_income: false, icon: null, color: null }],
      rules: [{ pattern: 'SECOND CUP', match_type: 'exact', category: 'Coffee' }],
    });

    const row = sqlite.prepare('select display_description, display_source from transactions where id = ?').get(id) as {
      display_description: string | null;
      display_source: string | null;
    };
    expect(row).toEqual({ display_description: 'Study coffee', display_source: 'manual' });
  });
});

describe('profiles pack', () => {
  it('exports name, institution and mapping only', () => {
    setup();
    const pack = exportProfilesPack({ at: new Date('2026-08-15T12:00:00.000Z') });
    expect(pack.format).toBe(PROFILES_PACK_FORMAT);
    // v1.13.0 Task 9 grew the built-in count from 4 to 7 -- derived rather than a literal.
    expect(pack.profiles).toHaveLength(BUILTIN_PRESET_NAMES.length);
    for (const profile of pack.profiles) {
      expect(Object.keys(profile).sort()).toEqual(['institution', 'mapping', 'name']);
    }
    expect(JSON.stringify(pack)).not.toContain('is_builtin');
    expect(JSON.stringify(pack)).not.toContain('account');
  });

  it('can export a chosen subset, and previews what would go', () => {
    setup();
    const rows = previewProfilesPackExport();
    expect(rows).toHaveLength(BUILTIN_PRESET_NAMES.length);
    expect(rows[0]).toMatchObject({ isBuiltin: true });
    const amex = rows.find((r) => r.name === 'Amex Canada')!;
    const pack = exportProfilesPack({ profileIds: [amex.profileId] });
    expect(pack.profiles.map((p) => p.name)).toEqual(['Amex Canada']);
    expect(pack.profiles[0].mapping.signConvention).toBe('positive_is_spend');
  });

  it('auto-renames on a name collision and marks the import non-builtin', () => {
    setup();
    const pack = {
      format: PROFILES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      profiles: [
        { name: 'TD Visa', institution: 'TD Canada Trust', mapping: getBuiltinPreset('TD Visa') },
        { name: 'Tangerine Chequing', institution: 'Tangerine', mapping: getBuiltinPreset('Scotiabank Chequing/Debit') },
      ],
    };
    const result = importProfilesPack(pack);
    expect(result.added).toEqual([
      { name: 'TD Visa (2)', renamedFrom: 'TD Visa' },
      { name: 'Tangerine Chequing', renamedFrom: null },
    ]);
    expect(getProfileByName('TD Visa (2)')?.isBuiltin).toBe(false);
    expect(getProfileByName('TD Visa')?.isBuiltin).toBe(true); // the built-in is untouched
    expect(listProfiles()).toHaveLength(BUILTIN_PRESET_NAMES.length + 2);
  });

  it('keeps counting up when (2) is also taken', () => {
    setup();
    const make = (name: string) => ({
      format: PROFILES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      profiles: [{ name, institution: 'TD Canada Trust', mapping: getBuiltinPreset('TD Visa') }],
    });
    importProfilesPack(make('TD Visa'));
    const second = importProfilesPack(make('TD Visa'));
    expect(second.added).toEqual([{ name: 'TD Visa (3)', renamedFrom: 'TD Visa' }]);
  });

  it('rejects a profile whose mapping is invalid', () => {
    setup();
    const pack = {
      format: PROFILES_PACK_FORMAT,
      version: 1,
      exported_at: '2026-08-15T12:00:00.000Z',
      profiles: [{ name: 'Broken', institution: 'X', mapping: { ...getBuiltinPreset('TD Visa'), descCols: [] } }],
    };
    expect(() => importProfilesPack(pack)).toThrowError(PackFormatError);
    expect(getProfileByName('Broken')).toBeNull();
  });
});
