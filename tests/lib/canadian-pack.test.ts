import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';

/**
 * v1.25.0 (backlog item 18) is the reason this file mocks anything at all. Every other block below
 * drives the library directly, and deliberately -- but item 18 is about what happens when a rule
 * is re-keyed THROUGH THE FORM, and the whole defect lived in the gap between what the form
 * actually does (an upsert on the key, so a pattern change writes a second row) and what the pack
 * update flow assumed it did. Reaching for upsertRuleFromCorrection here instead would reproduce
 * the assumption rather than the behaviour, so saveRuleAction and deleteRuleAction are called for
 * real, with only their auth/CSRF/revalidate edges stubbed -- the same three stubs
 * tests/app/merchant-rules-actions.test.ts uses, for the same reason.
 */
let currentUser = { id: 1, name: 'Admin', username: 'admin', role: 'admin' as const };
vi.mock('@/lib/auth/session', () => ({ requireAdmin: vi.fn(async () => currentUser) }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'http://nas.local:3000', host: 'nas.local:3000' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { deleteRuleAction, saveRuleAction } from '@/app/(app)/settings/merchant-rules/actions';
import { RULES_PACK_FORMAT, type RulesPack } from '@/lib/packs';
import { deleteRule, listRules, matchRule, setRuleDisabledFlag, upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { applyRenameRules, buildContext } from '@/lib/categorize/engine';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import {
  CANADIAN_PACK_ID,
  applyCanadianPackUpdate,
  canadianPackState,
  canadianPackUpdateDiff,
  installCanadianPack,
  installedCanadianPackRows,
  notifyCanadianPackUpdateAvailable,
  previewCanadianPackRemoval,
  removeCanadianPack,
} from '@/lib/canadian-pack';

/**
 * These tests deliberately do NOT install the real shipped packs/canadian-merchants.json --
 * tests/ops/canadian-merchants-pack.test.ts already proves that file's own content is correct.
 * Every function under test here (installCanadianPack, canadianPackUpdateDiff,
 * applyCanadianPackUpdate, canadianPackState) takes an optional pack/version override for exactly
 * this reason: a synthetic two-version pack pair, fixed for the life of this file, is what lets
 * "added/changed/removed/unchanged" be asserted precisely without the test drifting every time
 * someone edits the real bundled pack for an unrelated reason -- which happens: v1.25.0 alone took
 * it from 190 rules to 297.
 */

function pack(rules: RulesPack['rules']): RulesPack {
  return { format: RULES_PACK_FORMAT, version: 1, exported_at: '', categories: [], rules };
}

const V1 = pack([
  { pattern: 'AAA COFFEE', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
  { pattern: 'BBB GROCER', match_type: 'exact', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null },
  { pattern: 'CCC RENAME', match_type: 'exact', rule_kind: 'rename', category: null, category_parent: null, rename_to: 'Ccc Co' },
  { pattern: 'DDD OLD', match_type: 'exact', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null },
]);

const V2 = pack([
  { pattern: 'AAA COFFEE', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null }, // unchanged
  { pattern: 'BBB GROCER', match_type: 'exact', rule_kind: 'category', category: 'Restaurants', category_parent: 'Food', rename_to: null }, // changed
  { pattern: 'CCC RENAME', match_type: 'exact', rule_kind: 'rename', category: null, category_parent: null, rename_to: 'Ccc Co V2' }, // changed
  { pattern: 'EEE NEW', match_type: 'exact', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null }, // added
  // DDD OLD dropped entirely -- removed
]);

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

function addTxn(db: TestDb['db'], accountId: number, userId: number, normalizedMerchant: string): number {
  const row = db.get<{ id: number }>(sql`
    insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, categorization_source, created_by, created_at, updated_at)
    values (${accountId}, '2026-03-02', ${normalizedMerchant}, ${normalizedMerchant}, -1000, 'none', ${userId}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    returning id`);
  return row.id;
}

/**
 * v1.25.0 (backlog item 16) bumped the real pack to pack_version 2 and, for twelve rules, changed
 * nothing but the MATCH TYPE (eleven 'exact' short acronyms and 'ATCO' promoted to 'word'). This
 * block pins how that presents to somebody who already installed v1, because the answer is NOT
 * "changed" and that is worth stating out loud rather than discovering during a release.
 *
 * WHY: walkCanadianPackUpdate keys everything on keyOf(), which is
 * `pattern|matchType|ruleKind` -- match_type is part of a rule's IDENTITY, not part of its
 * outcome, exactly as merchant_rules_pattern_uq treats it. So `IGA/word/category` is not a
 * modified `IGA/exact/category`; it is a rule the database does not have (-> added) sitting beside
 * one the new pack no longer names (-> removed). `changed` is reserved for a rule whose key is the
 * same and whose OUTCOME moved (a different category, a different rename target), which is the
 * only case where "before -> after" is a sentence that can be written at all.
 *
 * IS THAT A PROBLEM? No, and the assertions below are what establish it:
 *   - the confirm screen already lists `removed` explicitly, with deletion offered as an
 *     unchecked box, so nothing is hidden -- an admin sees "IGA is new" and "IGA is no longer in
 *     the pack" together, which is a true if slightly odd description of a promotion;
 *   - with deleteRemoved: false (the default) the old exact row survives with its stamp CLEARED,
 *     i.e. it becomes an ordinary household rule. It is not a duplicate that fights the new one:
 *     both carry the same category, and matchRule's precedence gives the exact row the exact
 *     merchant text and the word row every variation of it. The union of the two is strictly what
 *     the new pack intends plus one redundant row;
 *   - with deleteRemoved: true the old row goes and only the word rule remains.
 *
 * Making it report as `changed` would mean teaching walkCanadianPackUpdate to pair a removal with
 * an addition on pattern+kind alone and call it a rename of the match type. That is a real
 * feature (and would need to decide what happens when a household edited one side of the pair),
 * not a papering-over, so it is recorded here rather than smuggled in under this item.
 */
describe('canadianPackUpdateDiff: a match-type promotion presents as added + removed, not changed', () => {
  const WORD_V1 = pack([
    { pattern: 'IGA', match_type: 'exact', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null },
  ]);
  const WORD_V2 = pack([
    { pattern: 'IGA', match_type: 'word', rule_kind: 'category', category: 'Groceries', category_parent: 'Food', rename_to: null },
  ]);

  it('reports the word rule as added and the exact rule as removed, with nothing under changed', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), WORD_V1, 1);

    const diff = canadianPackUpdateDiff(WORD_V2, 2);
    expect(diff.added).toEqual([
      { pattern: 'IGA', matchType: 'word', ruleKind: 'category', categoryLabel: 'Food › Groceries', renameTo: null },
    ]);
    expect(diff.removed).toEqual([
      { pattern: 'IGA', matchType: 'exact', ruleKind: 'category', categoryLabel: 'Food › Groceries', renameTo: null },
    ]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
    expect(diff.skippedEdited).toEqual([]);
  });

  it('leaves the superseded exact rule in place but UNSTAMPED when removals are not deleted', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), WORD_V1, 1);

    applyCanadianPackUpdate({ deleteRemoved: false, pack: WORD_V2, toVersion: 2 });

    const rows = listRules().map((r) => ({ pattern: r.pattern, matchType: r.matchType, packSource: r.packSource, packVersion: r.packVersion }));
    expect(rows).toEqual([
      { pattern: 'IGA', matchType: 'exact', packSource: null, packVersion: null },
      { pattern: 'IGA', matchType: 'word', packSource: CANADIAN_PACK_ID, packVersion: 2 },
    ]);
    // The pack now claims exactly one row, so "installed v2, 1 of 1 present" is honest.
    expect(canadianPackState(WORD_V2, 2)).toMatchObject({ installed: true, installedVersion: 2, presentCount: 1, totalCount: 1, updateAvailable: false });
  });

  it('deletes the superseded exact rule when removals ARE deleted, leaving only the word rule', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), WORD_V1, 1);

    const result = applyCanadianPackUpdate({ deleteRemoved: true, pack: WORD_V2, toVersion: 2 });

    expect(result).toMatchObject({ added: 1, changed: 0, removedOffered: 1, removedDeleted: 1 });
    expect(listRules().map((r) => r.matchType)).toEqual(['word']);
  });

  /**
   * The reason the redundant pair is tolerable rather than merely visible: both rows agree, and
   * matchRule's precedence means the pack's intent is what actually fires either way.
   */
  it('the redundant pair categorizes identically, so the promotion is safe even if nobody deletes anything', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), WORD_V1, 1);
    applyCanadianPackUpdate({ deleteRemoved: false, pack: WORD_V2, toVersion: 2 });

    const ctx = buildContext();
    const groceries = current.db.get<{ id: number }>(sql`select id from categories where name = 'Groceries' limit 1`).id;
    // The bare acronym: the exact row wins on the type tie-break, same outcome.
    expect(matchRule('IGA', 'category', ctx.rules)?.categoryId).toBe(groceries);
    // The store-format line exact could never reach: the word row, which is the whole point.
    expect(matchRule(normalizeMerchant('IGA MARCHE #4021 MONTREAL QC'), 'category', ctx.rules)?.categoryId).toBe(groceries);
    // And the collision this item exists to kill stays dead.
    expect(matchRule(normalizeMerchant('MICHIGAN AVE SHOP #55 WINDSOR ON'), 'category', ctx.rules)).toBeNull();
  });
});

describe('installCanadianPack: stamping and conflicts', () => {
  it('stamps only the rows it wrote, and never a conflict-kept row', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    // The household already has its own rule for this exact (pattern, match_type, rule_kind) --
    // a genuinely different category than V1 asserts.
    const restaurants = current.db.get<{ id: number }>(sql`select id from categories where name = 'Restaurants' limit 1`).id;
    upsertRuleFromCorrection({
      pattern: 'BBB GROCER', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId, actorRole: 'admin',
    });

    const result = installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), V1, 1);
    expect(result).toMatchObject({ rulesAdded: 3, rulesKept: 1, rulesOverwritten: 0, rulesSkipped: 0 });

    const installed = installedCanadianPackRows();
    expect(installed).toHaveLength(3);
    expect(installed.map((r) => r.pattern).sort()).toEqual(['AAA COFFEE', 'CCC RENAME', 'DDD OLD']);
    for (const row of installed) {
      expect(row.packSource).toBe(CANADIAN_PACK_ID);
      expect(row.packVersion).toBe(1);
      expect(row.installedAt).toBe('2026-01-01T00:00:00.000Z');
    }

    // The conflict-kept row is untouched: still the household's own category, still unstamped.
    const kept = listRules().find((r) => r.pattern === 'BBB GROCER')!;
    expect(kept.categoryId).toBe(restaurants);
    expect(kept.packSource).toBeNull();
    expect(kept.packVersion).toBeNull();
    expect(kept.installedAt).toBeNull();
  });
});

describe('removeCanadianPack: deletes exactly the stamped rows and reverts exactly the expected renames', () => {
  it('deletes every stamped row and reverts only the transactions a stamped rename rule set', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    installCanadianPack(new Date(), V1, 1);

    const txnId = addTxn(current.db, accountId, userId, normalizeMerchant('CCC RENAME'));
    // Retroactive apply only runs inside install/removal paths that touch a rename rule -- run it
    // once here so the transaction picks up the rename before we then remove the pack.
    applyRenameRules(undefined, buildContext());

    const before = current.sqlite.prepare('select display_source from transactions where id = ?').get(txnId) as { display_source: string | null };
    expect(before.display_source).toBe('rename');

    const preview = previewCanadianPackRemoval();
    expect(preview).toEqual({ ruleCount: 4, transactionsRevert: 1 });

    const result = removeCanadianPack();
    expect(result).toEqual({ deleted: 4, transactionsReverted: 1 });
    expect(installedCanadianPackRows()).toHaveLength(0);
    expect(listRules()).toHaveLength(0);

    const after = current.sqlite.prepare('select display_source, display_description from transactions where id = ?').get(txnId) as {
      display_source: string | null;
      display_description: string | null;
    };
    expect(after).toEqual({ display_source: null, display_description: null });
  });

  it('never deletes a conflict-kept row that is not stamped', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const restaurants = current.db.get<{ id: number }>(sql`select id from categories where name = 'Restaurants' limit 1`).id;
    upsertRuleFromCorrection({ pattern: 'BBB GROCER', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId, actorRole: 'admin' });
    installCanadianPack(new Date(), V1, 1);

    removeCanadianPack();
    const remaining = listRules();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ pattern: 'BBB GROCER', categoryId: restaurants, packSource: null });
  });
});

describe('canadianPackState: counts after individual deletions', () => {
  it('presentCount drops by exactly one after deleting a single stamped rule, totalCount unaffected', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    expect(canadianPackState(V1, 1)).toMatchObject({ installed: true, installedVersion: 1, presentCount: 4, totalCount: 4, updateAvailable: false });

    const target = installedCanadianPackRows()[0];
    deleteRule(target.id);

    expect(canadianPackState(V1, 1)).toMatchObject({ installed: true, presentCount: 3, totalCount: 4 });
  });

  it('reports not-installed when nothing is stamped', () => {
    current = createSeededTestDb();
    expect(canadianPackState(V1, 1)).toEqual({ installed: false, installedVersion: null, bundledVersion: 1, updateAvailable: false, presentCount: 0, totalCount: 4 });
  });
});

describe('an edited preset rule survives an update and is reported skipped', () => {
  it('is excluded from "changed", left untouched by apply, and stays unstamped', () => {
    current = createSeededTestDb();
    const admin = insertTestUser(current.db, { role: 'admin' });
    installCanadianPack(new Date(), V1, 1);

    // Simulate the household editing BBB GROCER through the ordinary form path -- no `pack` field,
    // exactly what saveRuleAction does -- to a category neither V1 nor V2 assert.
    const coffee = current.db.get<{ id: number }>(sql`select id from categories where name = 'Coffee' limit 1`).id;
    upsertRuleFromCorrection({ pattern: 'BBB GROCER', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: admin, actorRole: 'admin' });
    const editedRow = listRules().find((r) => r.pattern === 'BBB GROCER')!;
    expect(editedRow.packSource).toBeNull();

    const diff = canadianPackUpdateDiff(V2, 2);
    expect(diff.skippedEdited.map((e) => e.pattern)).toContain('BBB GROCER');
    expect(diff.changed.map((e) => e.pattern)).not.toContain('BBB GROCER');

    const result = applyCanadianPackUpdate({ deleteRemoved: false, pack: V2, toVersion: 2 });
    expect(result.skippedEdited).toBeGreaterThanOrEqual(1);

    const after = listRules().find((r) => r.pattern === 'BBB GROCER')!;
    expect(after.categoryId).toBe(coffee); // the household's edit, untouched
    expect(after.packSource).toBeNull(); // still not reclaimed by the pack
  });
});

describe('a disabled preset rule stays disabled through an update', () => {
  it('keeps disabled_at set even though its content changes', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    const rename = installedCanadianPackRows().find((r) => r.pattern === 'CCC RENAME')!;
    setRuleDisabledFlag(rename.id, true);

    applyCanadianPackUpdate({ deleteRemoved: false, pack: V2, toVersion: 2 });

    const after = listRules().find((r) => r.pattern === 'CCC RENAME')!;
    expect(after.renameTo).toBe('Ccc Co V2'); // content DID update
    expect(after.disabledAt).not.toBeNull(); // but it is still disabled
    expect(after.packSource).toBe(CANADIAN_PACK_ID);
    expect(after.packVersion).toBe(2);
  });
});

describe('canadianPackUpdateDiff: added/removed/changed/unchanged', () => {
  it('classifies every rule correctly with nothing edited or disabled', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);

    const diff = canadianPackUpdateDiff(V2, 2);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    expect(diff.added.map((e) => e.pattern)).toEqual(['EEE NEW']);
    expect(diff.removed.map((e) => e.pattern)).toEqual(['DDD OLD']);
    expect(diff.changed.map((e) => e.pattern).sort()).toEqual(['BBB GROCER', 'CCC RENAME']);
    expect(diff.skippedEdited).toEqual([]);
    expect(diff.unchangedCount).toBe(1); // AAA COFFEE

    const bbb = diff.changed.find((e) => e.pattern === 'BBB GROCER')!;
    expect(bbb.before).toBe('Food › Groceries');
    expect(bbb.after).toBe('Food › Restaurants');
  });
});

describe('applyCanadianPackUpdate: writes', () => {
  it('inserts added rules stamped at the new version', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    const result = applyCanadianPackUpdate({ deleteRemoved: false, pack: V2, toVersion: 2, at: new Date('2026-02-01T00:00:00.000Z') });
    expect(result).toMatchObject({ added: 1, changed: 2, unchanged: 1, skippedEdited: 0, removedOffered: 1 });

    const added = listRules().find((r) => r.pattern === 'EEE NEW')!;
    expect(added.packSource).toBe(CANADIAN_PACK_ID);
    expect(added.packVersion).toBe(2);
    expect(added.installedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('bumps an UNCHANGED row to the new version too, so installedVersion is a single honest number afterward', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    applyCanadianPackUpdate({ deleteRemoved: false, pack: V2, toVersion: 2 });

    const unchanged = listRules().find((r) => r.pattern === 'AAA COFFEE')!;
    expect(unchanged.packVersion).toBe(2);
    expect(canadianPackState(V2, 2).installedVersion).toBe(2);
    expect(canadianPackState(V2, 2).updateAvailable).toBe(false);
  });

  it('with deleteRemoved=false, a removed rule is kept but its stamp is cleared', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    const result = applyCanadianPackUpdate({ deleteRemoved: false, pack: V2, toVersion: 2 });
    expect(result.removedDeleted).toBe(0);

    const ddd = listRules().find((r) => r.pattern === 'DDD OLD')!;
    expect(ddd).toBeDefined();
    expect(ddd.packSource).toBeNull();
    expect(ddd.packVersion).toBeNull();
  });

  it('with deleteRemoved=true, a removed rule is actually deleted', () => {
    current = createSeededTestDb();
    installCanadianPack(new Date(), V1, 1);
    const result = applyCanadianPackUpdate({ deleteRemoved: true, pack: V2, toVersion: 2 });
    expect(result.removedDeleted).toBe(1);
    expect(listRules().find((r) => r.pattern === 'DDD OLD')).toBeUndefined();
  });
});

describe('notifyCanadianPackUpdateAvailable: wired into the existing notification digest', () => {
  function configuredAdmin(): number {
    const userId = insertTestUser(current!.db, { role: 'admin' });
    saveSmtp({
      preset: 'brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls',
      username: 'me@example.com', password: 'pw', fromEmail: 'me@example.com', fromName: 'Budget Tracker', enabled: true,
    });
    saveEmailTarget({ userId, destination: 'admin@example.com', enabled: true });
    return userId;
  }

  function outboxRows(): { userId: number; eventId: string; dedupKey: string }[] {
    return current!.sqlite
      .prepare('select user_id as userId, event_id as eventId, dedup_key as dedupKey from notification_outbox')
      .all() as { userId: number; eventId: string; dedupKey: string }[];
  }

  it('enqueues nothing when no update is pending', () => {
    current = createSeededTestDb();
    configuredAdmin();
    installCanadianPack(new Date(), V1, 1); // installed === bundled, nothing pending
    const result = notifyCanadianPackUpdateAvailable(new Date(), canadianPackState(V1, 1));
    expect(result).toBe(false);
    expect(outboxRows()).toEqual([]);
  });

  it('enqueues one row per admin, deduped by (pack, version), when an update is pending', () => {
    current = createSeededTestDb();
    const admin1 = configuredAdmin();
    const admin2 = configuredAdmin();
    installCanadianPack(new Date(), V1, 1);
    const state = canadianPackState(V2, 2); // bundledVersion=2, installedVersion=1 -> pending

    const first = notifyCanadianPackUpdateAvailable(new Date(), state);
    expect(first).toBe(true);
    const rows = outboxRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([admin1, admin2].sort((a, b) => a - b));
    for (const row of rows) {
      expect(row.eventId).toBe('pack_update_available');
      expect(row.dedupKey).toBe('pack-update:canadian-merchants:2');
    }

    // Calling it again for the SAME version enqueues nothing further -- the dedup key already
    // used is the guard, not a separate "already notified" flag this function checks itself.
    const second = notifyCanadianPackUpdateAvailable(new Date(), state);
    expect(second).toBe(false);
    expect(outboxRows()).toHaveLength(2);
  });

  it('never reaches a member -- pack_update_available is audience "admin"', () => {
    current = createSeededTestDb();
    const memberId = insertTestUser(current.db, { role: 'member' });
    saveSmtp({
      preset: 'brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls',
      username: 'me@example.com', password: 'pw', fromEmail: 'me@example.com', fromName: 'Budget Tracker', enabled: true,
    });
    saveEmailTarget({ userId: memberId, destination: 'member@example.com', enabled: true });
    installCanadianPack(new Date(), V1, 1);

    notifyCanadianPackUpdateAvailable(new Date(), canadianPackState(V2, 2));
    expect(outboxRows()).toEqual([]); // adminUserIds() never named this member in the first place
  });
});

/**
 * v1.25.0 (backlog item 18). WHAT WAS ACTUALLY WRONG, in the order it was found -- because the
 * brief that produced this block described a slightly different mechanism and the code turned out
 * to be worse than that:
 *
 *   1. saveRuleAction does not rename a rule in place. It is an UPSERT on
 *      (pattern, match_type, rule_kind) -- ruleKeyOf, mirroring merchant_rules_pattern_uq -- with
 *      no row id anywhere in its write. So changing a preset rule's pattern writes a SECOND row
 *      under the new key and leaves the pack's original exactly where it was, still stamped. The
 *      form says so in as many words ("Changing the pattern, match or kind creates a separate rule
 *      rather than renaming this one in place -- save it under its new pattern, then delete this
 *      row from the table if it should not also remain"). Right after such a "rename", the update
 *      diff reported `unchanged: 1` -- the pack was perfectly content, and the household had two
 *      competing rules.
 *   2. Following that instruction is what broke. Once the pack's own row is deleted, its provenance
 *      goes with it: nothing tied the replacement to the entry it came from. The next update found
 *      no row under the pack's pattern, classified it as an ADDITION indistinguishable from a
 *      genuinely new merchant, and wrote it back stamped at the new version -- so the household
 *      ended up holding BOTH their replacement and the original they had deliberately removed,
 *      quietly competing through matchRule's longest-pattern-wins. Nothing in the confirm dialog
 *      hinted at it: `skippedEdited` was empty, `removed` was empty, and "1 added: TIM HORTONS"
 *      read exactly like a new merchant.
 *
 * The fix is merchant_rules.pack_origin_key (drizzle/0018_pack_origin_key.sql): a rule records the
 * pack KEY it descends from, the pack writes it on every row it stamps, and a form save that
 * re-keys such a rule passes it to the row it creates. The first test below is the regression --
 * it performs exactly the sequence above and asserts what the code does NOW, having first been
 * written to assert what it used to do.
 *
 * NOT CONTRADICTED: the match-type block at the top of this file still holds. That one is about the
 * PACK changing its own match type between versions, where added-plus-removed is the right and
 * pinned answer. This block is about the HOUSEHOLD changing a key. The origin stores a whole key
 * precisely so the two cannot be confused -- 'IGA|exact|category' and 'IGA|word|category' stay two
 * different rules, so a pack-side promotion is never mistaken for a household edit.
 */
describe('an update re-adds a pack rule the household replaced under a different pattern', () => {
  const PRESET_V1 = pack([
    { pattern: 'TIM HORTONS', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
    // A second rule nobody touches, so the pack stays "installed": canadianPackState reads
    // installedVersion off the stamped rows, and with a one-rule pack, deleting the only stamped
    // row reports the pack as not installed at all -- there would be no update flow left to test.
    { pattern: 'AAA KEEP', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
  ]);
  const PRESET_V2 = pack([
    ...PRESET_V1.rules,
    { pattern: 'ZZZ NEW', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
  ]);

  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    return fd;
  }

  function asAdmin(): number {
    const userId = insertTestUser(current!.db, { name: 'Admin', username: 'admin' });
    currentUser = { id: userId, name: 'Admin', username: 'admin', role: 'admin' };
    return userId;
  }

  /** pattern -> pack_origin_key, read straight off the column (MerchantRuleRecord does not carry it). */
  function origins(): Map<string, string | null> {
    const rows = current!.sqlite
      .prepare('select pattern, pack_origin_key as origin from merchant_rules')
      .all() as { pattern: string; origin: string | null }[];
    return new Map(rows.map((row) => [row.pattern, row.origin]));
  }

  /** The real form path: save the rule under a new key, then delete the row left behind. */
  async function replaceThroughTheForm(from: string, to: string, over: Record<string, string> = {}): Promise<void> {
    const original = listRules().find((rule) => rule.pattern === from)!;
    const saved = await saveRuleAction(
      {},
      form({
        pattern: to,
        matchType: original.matchType,
        ruleKind: original.ruleKind,
        categoryId: original.categoryId === null ? '' : String(original.categoryId),
        renameTo: original.renameTo ?? '',
        fromRuleId: String(original.id),
        ...over,
      }),
    );
    expect(saved.error).toBeUndefined();
    const deleted = await deleteRuleAction({}, form({ ruleId: String(original.id) }));
    expect(deleted.error).toBeUndefined();
  }

  it('REGRESSION: the replaced rule is reported as not-added-back, never as an addition', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);

    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTON');
    // The form really did write a new row, and the origin came with it.
    expect(origins().get('TIM HORTON')).toBe('TIM HORTONS|exact|category');

    const diff = canadianPackUpdateDiff(PRESET_V2, 2);
    // BEFORE item 18 this read ['TIM HORTONS', 'ZZZ NEW'] -- the pack's own rule offered back as a
    // new merchant, with the household's replacement already sitting in the table.
    expect(diff.added.map((e) => e.pattern)).toEqual(['ZZZ NEW']);
    expect(diff.editedAway).toEqual([
      {
        pattern: 'TIM HORTONS',
        matchType: 'exact',
        ruleKind: 'category',
        categoryLabel: 'Food › Coffee',
        renameTo: null,
        savedAs: [{ pattern: 'TIM HORTON', matchType: 'exact' }],
      },
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.skippedEdited).toEqual([]);
    expect(diff.unchangedCount).toBe(1); // AAA KEEP
  });

  it('applying the update writes nothing for it, so the replacement is never joined by the original', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);
    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTON');

    const result = applyCanadianPackUpdate({ deleteRemoved: false, pack: PRESET_V2, toVersion: 2 });
    expect(result).toMatchObject({ added: 1, changed: 0, unchanged: 1, editedAway: 1, removedOffered: 0, removedDeleted: 0 });

    expect(listRules().map((rule) => rule.pattern).sort()).toEqual(['AAA KEEP', 'TIM HORTON', 'ZZZ NEW']);
    const replacement = listRules().find((rule) => rule.pattern === 'TIM HORTON')!;
    expect(replacement.packSource).toBeNull(); // still theirs -- the pack did not reclaim it
    expect(replacement.categoryId).toBe(categoryIdByName(current.db, 'Coffee'));
  });

  it('a rule the household wrote from scratch is never claimed by the pack', async () => {
    current = createSeededTestDb();
    asAdmin();
    const coffee = categoryIdByName(current.db, 'Coffee');
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);

    // A brand-new rule of their own: the dialog sends no fromRuleId at all for "New merchant rule".
    await saveRuleAction({}, form({ pattern: 'CORNER STORE', matchType: 'contains', ruleKind: 'category', categoryId: String(coffee), renameTo: '' }));
    // And re-keying THAT rule must not conjure an origin either -- it has none to inherit.
    const own = listRules().find((rule) => rule.pattern === 'CORNER STORE')!;
    await saveRuleAction({}, form({ pattern: 'CORNER SHOP', matchType: 'contains', ruleKind: 'category', categoryId: String(coffee), renameTo: '', fromRuleId: String(own.id) }));
    expect(origins().get('CORNER STORE')).toBeNull();
    expect(origins().get('CORNER SHOP')).toBeNull();

    // Deleting a preset rule outright -- no replacement, they simply do not want it -- is NOT a
    // re-key, and the pack still offers it back. Unchanged pre-existing behaviour, stated here so
    // the difference between "I replaced this" and "I deleted this" stays a deliberate one.
    const preset = listRules().find((rule) => rule.pattern === 'TIM HORTONS')!;
    await deleteRuleAction({}, form({ ruleId: String(preset.id) }));
    const diff = canadianPackUpdateDiff(PRESET_V2, 2);
    expect(diff.editedAway).toEqual([]);
    expect(diff.added.map((e) => e.pattern).sort()).toEqual(['TIM HORTONS', 'ZZZ NEW']);
  });

  it('a replacement saved over a pattern the household already had a rule for inherits nothing', async () => {
    current = createSeededTestDb();
    asAdmin();
    const coffee = categoryIdByName(current.db, 'Coffee');
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);

    // Their own rule first, then they edit the preset rule and type that same pattern. The upsert
    // updates THEIR row in place; nothing new is created, so there is no descendant to record and
    // their rule must not be handed the pack's history.
    await saveRuleAction({}, form({ pattern: 'CORNER STORE', matchType: 'exact', ruleKind: 'category', categoryId: String(coffee), renameTo: '' }));
    const preset = listRules().find((rule) => rule.pattern === 'TIM HORTONS')!;
    await saveRuleAction({}, form({ pattern: 'CORNER STORE', matchType: 'exact', ruleKind: 'category', categoryId: String(coffee), renameTo: '', fromRuleId: String(preset.id) }));

    expect(origins().get('CORNER STORE')).toBeNull();
    await deleteRuleAction({}, form({ ruleId: String(preset.id) }));
    const diff = canadianPackUpdateDiff(PRESET_V2, 2);
    expect(diff.editedAway).toEqual([]);
    expect(diff.added.map((e) => e.pattern).sort()).toEqual(['TIM HORTONS', 'ZZZ NEW']);
  });

  /**
   * A rename rule does not reach the same write as a category rule: saveRuleAction routes it through
   * upsertRenameRule (src/lib/categorize/engine.ts) so the change is applied to existing
   * transactions, and deleteRuleAction routes its deletion through deleteRenameRule so they revert.
   * The origin has to survive both, or item 18 would hold for two rule kinds out of three.
   */
  it('a re-keyed rename rule is recognised too, through its own write path', async () => {
    current = createSeededTestDb();
    asAdmin();
    const RENAME_V1 = pack([
      { pattern: 'CCC RENAME', match_type: 'exact', rule_kind: 'rename', category: null, category_parent: null, rename_to: 'Ccc Co' },
      { pattern: 'AAA KEEP', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
    ]);
    const RENAME_V2 = pack([
      ...RENAME_V1.rules,
      { pattern: 'ZZZ NEW', match_type: 'exact', rule_kind: 'category', category: 'Coffee', category_parent: 'Food', rename_to: null },
    ]);
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), RENAME_V1, 1);

    await replaceThroughTheForm('CCC RENAME', 'CCC RENAMED', { renameTo: 'Ccc Company' });
    expect(origins().get('CCC RENAMED')).toBe('CCC RENAME|exact|rename');

    const diff = canadianPackUpdateDiff(RENAME_V2, 2);
    expect(diff.added.map((e) => e.pattern)).toEqual(['ZZZ NEW']);
    expect(diff.editedAway).toHaveLength(1);
    expect(diff.editedAway[0]).toMatchObject({
      pattern: 'CCC RENAME',
      ruleKind: 'rename',
      renameTo: 'Ccc Co',
      savedAs: [{ pattern: 'CCC RENAMED', matchType: 'exact' }],
    });

    applyCanadianPackUpdate({ deleteRemoved: false, pack: RENAME_V2, toVersion: 2 });
    // The pack's own rename is NOT put back, so it cannot out-rank the household's on pattern
    // length and quietly retitle their transactions again.
    expect(listRules().map((rule) => rule.pattern).sort()).toEqual(['AAA KEEP', 'CCC RENAMED', 'ZZZ NEW']);
    const replacement = listRules().find((rule) => rule.pattern === 'CCC RENAMED')!;
    expect(replacement.renameTo).toBe('Ccc Company');
    expect(replacement.packSource).toBeNull();
  });

  it('a match-type change made by the household is recognised the same way a pattern change is', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);

    // Same pattern, different match type -- a re-key all the same, because the key is all three
    // columns. This is the case that makes storing the whole key rather than the pattern matter.
    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTONS', { matchType: 'word' });

    const diff = canadianPackUpdateDiff(PRESET_V2, 2);
    expect(diff.added.map((e) => e.pattern)).toEqual(['ZZZ NEW']);
    expect(diff.editedAway).toHaveLength(1);
    expect(diff.editedAway[0]).toMatchObject({
      pattern: 'TIM HORTONS',
      matchType: 'exact',
      savedAs: [{ pattern: 'TIM HORTONS', matchType: 'word' }],
    });
  });

  it('removing the pack deletes its own rows and never the replacement', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);
    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTON');

    // The count the dialog states is the count "Remove permanently" honours: one stamped row is
    // left (AAA KEEP), and the replacement is not in it even though it carries a pack origin.
    expect(previewCanadianPackRemoval()).toEqual({ ruleCount: 1, transactionsRevert: 0 });
    expect(removeCanadianPack()).toEqual({ deleted: 1, transactionsReverted: 0 });

    const remaining = listRules();
    expect(remaining.map((rule) => rule.pattern)).toEqual(['TIM HORTON']);
    // The origin survives removal, which is the point of it being a historical fact rather than a
    // claim: re-installing the pack later must still recognise this row as its rule's descendant.
    expect(origins().get('TIM HORTON')).toBe('TIM HORTONS|exact|category');
  });

  it('a re-key, an update, then a second update is stable -- no drift and no duplicate', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);
    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTON');

    const first = applyCanadianPackUpdate({ deleteRemoved: false, pack: PRESET_V2, toVersion: 2 });
    expect(first).toMatchObject({ added: 1, editedAway: 1 });
    const afterFirst = listRules().map((rule) => ({ pattern: rule.pattern, packSource: rule.packSource, packVersion: rule.packVersion }));

    // The version comparison is satisfied by the rows the pack DOES claim, so it does not sit there
    // permanently offering an update it can never finish.
    expect(canadianPackState(PRESET_V2, 2)).toMatchObject({ installed: true, installedVersion: 2, updateAvailable: false, presentCount: 2 });

    // And re-running the same update changes nothing at all.
    const second = applyCanadianPackUpdate({ deleteRemoved: false, pack: PRESET_V2, toVersion: 2 });
    expect(second).toMatchObject({ added: 0, changed: 0, unchanged: 2, editedAway: 1, removedOffered: 0 });
    expect(listRules().map((rule) => ({ pattern: rule.pattern, packSource: rule.packSource, packVersion: rule.packVersion }))).toEqual(afterFirst);
    expect(canadianPackUpdateDiff(PRESET_V2, 2).editedAway).toHaveLength(1);
  });

  it('install records an origin on every row it stamps and never on a conflict-kept row', () => {
    current = createSeededTestDb();
    const userId = asAdmin();
    const restaurants = current.db.get<{ id: number }>(sql`select id from categories where name = 'Restaurants' limit 1`).id;
    // The household's own BBB GROCER, which V1 also names: importRulesPack keeps theirs and never
    // stamps it, so it must never acquire an origin either.
    upsertRuleFromCorrection({ pattern: 'BBB GROCER', matchType: 'exact', ruleKind: 'category', categoryId: restaurants, createdBy: userId, actorRole: 'admin' });

    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), V1, 1);

    const recorded = origins();
    expect(recorded.get('AAA COFFEE')).toBe('AAA COFFEE|exact|category');
    expect(recorded.get('CCC RENAME')).toBe('CCC RENAME|exact|rename');
    expect(recorded.get('DDD OLD')).toBe('DDD OLD|exact|category');
    expect(recorded.get('BBB GROCER')).toBeNull();
  });

  it('a stamped row carrying no recorded origin is treated as the household own work', async () => {
    current = createSeededTestDb();
    asAdmin();
    installCanadianPack(new Date('2026-01-01T00:00:00.000Z'), PRESET_V1, 1);
    // Stand in for a database that came through 0017 and was re-keyed BEFORE 0018 existed: stamped
    // rows, no origins. drizzle/0018_pack_origin_key.sql refuses to invent one for an unstamped
    // row, so that one rule keeps the old behaviour exactly once rather than being guessed at.
    current.sqlite.prepare('update merchant_rules set pack_origin_key = null').run();

    await replaceThroughTheForm('TIM HORTONS', 'TIM HORTON');
    expect(origins().get('TIM HORTON')).toBeNull();

    const diff = canadianPackUpdateDiff(PRESET_V2, 2);
    expect(diff.editedAway).toEqual([]);
    expect(diff.added.map((e) => e.pattern).sort()).toEqual(['TIM HORTONS', 'ZZZ NEW']);
  });
});
