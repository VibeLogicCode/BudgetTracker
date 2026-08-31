import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { exportProfilesPack, exportRulesPack, importProfilesPack, importRulesPack, previewRulesPackImport } from '@/lib/packs';
import { listRules, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { createCategory, listCategories } from '@/lib/categories';
import { BUILTIN_PRESET_NAMES, createProfile, getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { upsertAccountCardPerson } from '@/lib/import/card-people';
import { buildContext, categorizeTransaction } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { nowIso } from '@/lib/clock';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/** Build a "sender" database, take a pack out of it, then throw the database away. */
function packFromSender(includeTransferRules: boolean) {
  const sender = createSeededTestDb();
  const userId = insertTestUser(sender.db, { name: 'Alice', username: 'alice' });
  const food = categoryIdByName(sender.db, 'Food');
  const pets = createCategory({ name: 'Pets', parentId: null });
  const vet = createCategory({ name: 'Vet', parentId: pets });

  upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: categoryIdByName(sender.db, 'Coffee'), createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'LOBLAWS', matchType: 'contains', ruleKind: 'category', categoryId: categoryIdByName(sender.db, 'Groceries'), createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'RIVERSIDE ANIMAL HOSPITAL', matchType: 'exact', ruleKind: 'category', categoryId: vet, createdBy: userId, actorRole: 'admin' });
  upsertRuleFromCorrection({ pattern: 'E-TRANSFER SENT J DOE', matchType: 'exact', ruleKind: 'transfer', categoryId: null, createdBy: userId, actorRole: 'admin' });
  createProfile({ name: 'Tangerine Chequing', institution: 'Tangerine', mapping: { ...getBuiltinPreset('Scotiabank Chequing/Debit'), dateFormat: 'YYYY-MM-DD' } });

  const rules = exportRulesPack({ includeTransferRules });
  const profiles = exportProfilesPack();
  void food;
  sender.cleanup();
  return { rules, profiles };
}

describe('rules pack round trip onto a fresh database', () => {
  it('creates the missing categories by name and lands every rule', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();

    const plan = previewRulesPackImport(rules);
    expect(plan.totalRules).toBe(3);
    expect(plan.newRules).toBe(3);
    expect(plan.newCategories.sort()).toEqual(['Pets', 'Vet']);

    const result = importRulesPack(rules);
    expect(result).toMatchObject({ rulesAdded: 3, rulesOverwritten: 0, rulesKept: 0, categoriesCreated: 2 });

    const all = listCategories();
    const pets = all.find((c) => c.name === 'Pets')!;
    const vet = all.find((c) => c.name === 'Vet')!;
    expect(pets.parentId).toBeNull();
    expect(vet.parentId).toBe(pets.id);

    // Existing seeded categories were reused, not duplicated.
    expect(all.filter((c) => c.name === 'Coffee')).toHaveLength(1);
    const coffee = categoryIdByName(current.db, 'Coffee');
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(coffee);
    expect(listRules('category').find((r) => r.pattern === 'RIVERSIDE ANIMAL HOSPITAL')?.categoryId).toBe(vet.id);
  });

  it('the imported rules immediately drive the categorizer', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);

    const ctx = buildContext();
    const merchant = normalizeMerchant('POS PURCHASE       TIM HORTONS #4821 TORONTO ON');
    const outcome = categorizeTransaction({ id: 1, normalizedMerchant: merchant }, ctx);
    expect(outcome.source).toBe('rule');
    expect(outcome.categoryId).toBe(categoryIdByName(current.db, 'Coffee'));
  });

  it('leaves the receiver Bayes model completely untouched', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);
    expect((current.sqlite.prepare('select count(*) as c from bayes_tokens').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((current.sqlite.prepare('select count(*) as c from accounts').get() as { c: number }).c).toBe(0);
  });

  it('carries no transfer rules unless the sender opted in', () => {
    const withoutTransfers = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(withoutTransfers.rules);
    expect(listRules('transfer')).toHaveLength(0);
    current.cleanup();
    current = null;

    const withTransfers = packFromSender(true);
    current = createSeededTestDb();
    importRulesPack(withTransfers.rules);
    expect(listRules('transfer').map((r) => r.pattern)).toEqual(['E-TRANSFER SENT J DOE']);
    expect(listRules('transfer')[0].matchType).toBe('exact');
  });

  it('respects keep on the second import and overwrite when asked', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);

    // The receiver reclassifies TIM HORTONS locally, then re-imports the pack.
    // (Brief's literal test hardcoded createdBy: 1, but a fresh seeded test db has
    // no users row yet — insert one so the FK on merchant_rules.created_by holds.)
    const receiverUserId = insertTestUser(current.db, { name: 'Receiver', username: 'receiver' });
    const restaurants = categoryIdByName(current.db, 'Restaurants');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: receiverUserId, actorRole: 'admin' });

    const kept = importRulesPack(rules);
    expect(kept).toMatchObject({ rulesAdded: 0, rulesKept: 1, rulesOverwritten: 0 });
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(restaurants);

    const overwritten = importRulesPack(rules, { onConflict: 'overwrite' });
    expect(overwritten).toMatchObject({ rulesAdded: 0, rulesKept: 0, rulesOverwritten: 1 });
    expect(listRules('category').find((r) => r.pattern === 'TIM HORTONS')?.categoryId).toBe(categoryIdByName(current.db, 'Coffee'));
  });

  it('is idempotent when nothing changed', () => {
    const { rules } = packFromSender(false);
    current = createSeededTestDb();
    importRulesPack(rules);
    const before = listRules().length;
    const again = importRulesPack(rules);
    expect(again).toEqual({ rulesAdded: 0, rulesOverwritten: 0, rulesKept: 0, rulesSkipped: 0, categoriesCreated: 0 });
    expect(listRules().length).toBe(before);
  });

  // Coordinator brief (2026-08-31 revision): a round trip -- export with renames opted in, import
  // into a fresh seeded database -- must reproduce the rename AND apply it retroactively, the same
  // way saving one on the form does. Renames stay OFF by default (controller ruling (a)), so this
  // sender deliberately asks for includeRenameRules: true rather than reusing packFromSender.
  it('reproduces a rename on round trip and applies it retroactively when the sender opted in', () => {
    const sender = createSeededTestDb();
    const senderUserId = insertTestUser(sender.db, { name: 'Alice', username: 'alice' });
    upsertRuleFromCorrection({
      pattern: 'MCDONALDS',
      matchType: 'exact',
      ruleKind: 'rename',
      categoryId: null,
      renameTo: "McDonald's",
      createdBy: senderUserId,
      actorRole: 'admin',
    });
    const withoutOptIn = exportRulesPack();
    const withOptIn = exportRulesPack({ includeRenameRules: true });
    sender.cleanup();

    // Off by default even on a sender who has the rule -- confirms the export side of the round
    // trip before touching the receiver at all.
    expect(withoutOptIn.rules.some((r) => r.rule_kind === 'rename')).toBe(false);
    expect(withOptIn.rules.find((r) => r.rule_kind === 'rename')).toMatchObject({ pattern: 'MCDONALDS', rename_to: "McDonald's" });

    current = createSeededTestDb();
    const receiverUserId = insertTestUser(current.db, { name: 'Bob', username: 'bob' });
    const accountId = insertTestAccount(current.db);
    const txn = current.db.get<{ id: number }>(sql`
      insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
      values (${accountId}, '2026-03-02', ${'MCDONALDS #4821 TORONTO ON'}, ${normalizeMerchant('MCDONALDS #4821 TORONTO ON')}, -1200, 'none', ${receiverUserId}, ${nowIso()}, ${nowIso()})
      returning id`);

    const result = importRulesPack(withOptIn);
    expect(result.rulesAdded).toBe(1);
    expect(listRules('rename').find((r) => r.pattern === 'MCDONALDS')?.renameTo).toBe("McDonald's");

    const row = current.sqlite
      .prepare('select display_description, display_source from transactions where id = ?')
      .get(txn.id) as { display_description: string | null; display_source: string | null };
    expect(row).toEqual({ display_description: "McDonald's", display_source: 'rename' });
  });
});

describe('profiles pack round trip onto a fresh database', () => {
  it('renames colliding built-in names and lands the custom profile as-is', () => {
    const { profiles } = packFromSender(false);
    current = createSeededTestDb();

    const result = importProfilesPack(profiles);
    // v1.13.0 Task 9 grew the built-in count from 4 to 7 -- derived rather than a literal. Every
    // built-in collides with the fresh database's own seeded set and is renamed; Tangerine
    // Chequing is the one custom profile and lands as-is.
    expect(result.added.map((a) => a.name)).toEqual([...BUILTIN_PRESET_NAMES.map((name) => `${name} (2)`), 'Tangerine Chequing']);
    expect(listProfiles()).toHaveLength(BUILTIN_PRESET_NAMES.length * 2 + 1);

    const tangerine = getProfileByName('Tangerine Chequing')!;
    expect(tangerine.isBuiltin).toBe(false);
    expect(tangerine.mapping!.dateFormat).toBe('YYYY-MM-DD');
    expect(getProfileByName('TD Visa')?.isBuiltin).toBe(true);
    expect(getProfileByName('TD Visa (2)')?.isBuiltin).toBe(false);
  });
});

describe('profiles pack export carries cardCol but NEVER card assignments (MUST-3.2)', () => {
  it('exports cardCol as plain file-layout knowledge while excluding the account-specific card->person map entirely', () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Amex Joint' });

    // A real household's per-account fork: cardCol set to the Account # suffix column,
    // plus a genuine assignment row in account_card_people — the exact shape a real
    // export would try to leak from if the "whole mapping travels" convenience ever
    // widened into "whole account travels".
    const profileId = createProfile({
      name: 'Amex Canada (Amex Joint)',
      institution: 'American Express Canada',
      mapping: { ...getBuiltinPreset('Amex Canada'), cardCol: 4 },
    });
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alex });

    const pack = exportProfilesPack({ profileIds: [profileId] });
    const serialized = JSON.stringify(pack);

    expect(pack.profiles).toHaveLength(1);
    expect(pack.profiles[0].mapping.cardCol).toBe(4);
    // Structural guarantee: a pack profile is name/institution/mapping ONLY — no room for
    // an accountId, a userId, or an assignment list to have been bolted on.
    expect(Object.keys(pack.profiles[0]).sort()).toEqual(['institution', 'mapping', 'name']);

    // The only "card"-shaped thing in the whole pack is the column-index fact, not a value.
    expect(serialized).toContain('"cardCol":4');
    expect(serialized).not.toContain('cardValue');
    expect(serialized).not.toContain('card_value');
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('accountCardPeople');
    expect(serialized).not.toContain('account_card_people');
    // And no trace of the actual personal facts assigned above: the card suffix or the
    // person's name.
    expect(serialized).not.toContain('-1001');
    expect(serialized).not.toContain('Alex');

    // Confirm the assignment genuinely exists in the DB (so the absence above is because
    // exportProfilesPack never queries it, not because nothing was ever written).
    const assignmentCount = current.sqlite.prepare('select count(*) as c from account_card_people where account_id = ?').get(accountId) as { c: number };
    expect(assignmentCount.c).toBe(1);
  });
});
