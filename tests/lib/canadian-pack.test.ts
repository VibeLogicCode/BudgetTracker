import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { RULES_PACK_FORMAT, type RulesPack } from '@/lib/packs';
import { deleteRule, listRules, setRuleDisabledFlag, upsertRuleFromCorrection } from '@/lib/categorize/rules';
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
 * someone edits the real 190-rule pack for an unrelated reason.
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
