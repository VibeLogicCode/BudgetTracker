import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { commitImport, markImportRulesReviewed, undoImport, unreviewedRuleImports } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { commitStagedImport } from '@/lib/import/flow';
import { parseCsv } from '@/lib/import/parse';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { writeStagedFile } from '@/lib/import/staging';
import { resetImportHooks } from '@/lib/import/hooks';
import { nowIso } from '@/lib/clock';
import { listTransactions } from '@/lib/transactions';
import type { Viewer } from '@/lib/auth/viewer';

/**
 * v1.26.0 Lane 2 item 4 -- the "have I looked at this import" marker.
 *
 * The whole feature answers one objection: rules auto-categorize on import and a rule-assigned row
 * NEVER enters the review queue (REVIEW_WHERE is `category IS NULL OR source = 'bayes'`), so there
 * was no surface anywhere that showed what the rules had done. Confirmation must NOT become
 * mandatory -- if every rule-assigned row needed confirming, rules would create exactly as much
 * work as they save -- so the batch is inspectable and DISMISSIBLE, and this marker is what makes
 * the dismissal durable.
 */

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));
const VIEWER: Viewer = { id: 1, role: 'admin', visibility: 'household' };

let current: TestDb | null = null;
beforeEach(() => resetImportHooks());
afterEach(() => {
  resetImportHooks();
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const db = current.db;

  /** An imports row on its own -- no CSV, no engine, so the fixture states exactly what it means. */
  const addImport = (filename: string) =>
    db.get<{ id: number }>(sql`
      insert into imports (account_id, profile_id, filename, imported_by, rows_added, rows_duplicate, rows_error, created_at)
      values (${accountId}, null, ${filename}, ${userId}, 0, 0, 0, ${nowIso()})
      returning id`).id;

  const addRow = (over: { importId: number | null; source?: string; description?: string; categoryId?: number | null }) => {
    const description = over.description ?? 'CORNER MARKET';
    return db.get<{ id: number }>(sql`
      insert into transactions (account_id, import_id, date, raw_description, normalized_merchant, amount_cents,
                                category_id, categorization_source, is_transfer, hash_version, created_by, created_at, updated_at)
      values (${accountId}, ${over.importId}, '2026-03-04', ${description}, ${description}, -2500,
              ${over.categoryId ?? categoryIdByName(db, 'Groceries')}, ${over.source ?? 'rule'}, 0, 1, ${userId}, ${nowIso()}, ${nowIso()})
      returning id`).id;
  };

  return { db, sqlite: current.sqlite, userId, accountId, addImport, addRow };
}

describe('unreviewedRuleImports', () => {
  it('a FRESH import is unseen, and reports how many rows its rules claimed', () => {
    const { addImport, addRow } = setup();
    const importId = addImport('march.csv');
    addRow({ importId });
    addRow({ importId, description: 'FUEL DEPOT' });
    // Not a rule assignment, so it is not part of what the rules did.
    addRow({ importId, source: 'bayes', description: 'ODD SHOP' });

    // Nothing was written to imports.rules_reviewed_at at import time, on purpose (see the comment
    // in src/lib/import/flow.ts): the column is nullable with no default, so unreviewed is what a
    // new imports row already is.
    expect(unreviewedRuleImports()).toEqual([
      { importId, accountId: expect.any(Number), accountName: 'Joint Chequing', filename: 'march.csv', createdAt: expect.any(String), ruleRowCount: 2 },
    ]);
  });

  it('never lists an import whose rules claimed nothing', () => {
    const { addImport, addRow } = setup();
    const importId = addImport('quiet.csv');
    addRow({ importId, source: 'none', categoryId: null });
    addRow({ importId, source: 'bayes' });
    expect(unreviewedRuleImports()).toEqual([]);
  });

  it('counts by import_id, the import that ADDED the row, not by transaction_imports', () => {
    const { db, addImport, addRow } = setup();
    const first = addImport('march.csv');
    const second = addImport('april-overlapping.csv');
    const row = addRow({ importId: first });
    // What commitImport does for an overlapping re-import: the already-present row is linked into
    // the second import too. It was not ADDED by the second import and must not be audited twice.
    db.run(sql`insert into transaction_imports (transaction_id, import_id, created_at) values (${row}, ${first}, ${nowIso()})`);
    db.run(sql`insert into transaction_imports (transaction_id, import_id, created_at) values (${row}, ${second}, ${nowIso()})`);

    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([first]);
  });

  it('agrees exactly with what the audit list will show', () => {
    const { addImport, addRow } = setup();
    const importId = addImport('march.csv');
    addRow({ importId });
    addRow({ importId, description: 'FUEL DEPOT' });
    addRow({ importId, source: 'manual', description: 'HAND TYPED' });

    const [entry] = unreviewedRuleImports();
    // The banner count and the audit view's own query are the same question asked of the same two
    // columns, so they cannot disagree.
    expect(entry.ruleRowCount).toBe(listTransactions({ source: 'rule', importId }, VIEWER).total);
  });

  it('clears itself when every rule row has been dealt with individually', () => {
    const { db, addImport, addRow } = setup();
    const importId = addImport('march.csv');
    const row = addRow({ importId });
    expect(unreviewedRuleImports()).toHaveLength(1);

    // What confirmCategory does when a person confirms or corrects the row: stamps 'manual'. The
    // row leaves the rule-assigned set, so the import's count falls on its own -- nobody has to
    // press dismiss for an import they worked through row by row.
    db.run(sql`update transactions set categorization_source = 'manual' where id = ${row}`);
    expect(unreviewedRuleImports()).toEqual([]);
  });

  it('lists several unreviewed imports newest first', () => {
    const { addImport, addRow } = setup();
    const first = addImport('january.csv');
    const second = addImport('february.csv');
    const third = addImport('march.csv');
    for (const importId of [first, second, third]) addRow({ importId });
    expect(unreviewedRuleImports().map((entry) => entry.filename)).toEqual(['march.csv', 'february.csv', 'january.csv']);
  });
});

describe('markImportRulesReviewed', () => {
  it('marking an import seen STICKS, and is scoped to that import alone', () => {
    const { sqlite, addImport, addRow } = setup();
    const first = addImport('march.csv');
    const second = addImport('april.csv');
    addRow({ importId: first });
    addRow({ importId: second });

    expect(markImportRulesReviewed({ importId: first, at: new Date('2026-04-01T09:00:00.000Z') })).toBe(true);
    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([second]);
    const stamp = sqlite.prepare('select rules_reviewed_at from imports where id = ?').get(first) as { rules_reviewed_at: string | null };
    expect(stamp.rules_reviewed_at).toBe('2026-04-01T09:00:00.000Z');

    // Reading it again does not un-stick it, and neither does anything else happening in the app.
    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([second]);
  });

  it('a NEW import does not clear another import own reviewed state', () => {
    const { sqlite, addImport, addRow } = setup();
    const old = addImport('march.csv');
    addRow({ importId: old });
    markImportRulesReviewed({ importId: old, at: new Date('2026-04-01T09:00:00.000Z') });

    const fresh = addImport('april.csv');
    addRow({ importId: fresh });

    // The marker is a column on the imports row itself, so one import's state is untouchable from
    // another -- the new one is unreviewed, the old one stays dismissed.
    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([fresh]);
    const stamp = sqlite.prepare('select rules_reviewed_at from imports where id = ?').get(old) as { rules_reviewed_at: string | null };
    expect(stamp.rules_reviewed_at).toBe('2026-04-01T09:00:00.000Z');
  });

  it('an unrelated edit to a reviewed import rows does not un-dismiss it', () => {
    const { db, addImport, addRow } = setup();
    const importId = addImport('march.csv');
    const row = addRow({ importId });
    markImportRulesReviewed({ importId, at: new Date('2026-04-01T09:00:00.000Z') });

    // A note is written by bulkSetNotes, which bumps updated_at -- as do bulkSetAttribution and
    // setTransactionSplits, all for reasons that have nothing to do with categorization. If the
    // read compared updated_at against the stamp, typing a note would resurrect the banner, on a
    // surface whose entire justification is that it must not nag.
    db.run(sql`update transactions set notes = 'receipt in the drawer', updated_at = ${nowIso(new Date('2026-05-01T00:00:00.000Z'))} where id = ${row}`);
    expect(unreviewedRuleImports()).toEqual([]);
  });

  it('un-dismisses on request, the recovery path for an accidental click', () => {
    const { addImport, addRow } = setup();
    const importId = addImport('march.csv');
    addRow({ importId });
    markImportRulesReviewed({ importId });
    expect(unreviewedRuleImports()).toEqual([]);

    expect(markImportRulesReviewed({ importId, reviewed: false })).toBe(true);
    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([importId]);
  });

  it('returns false for an import that does not exist, rather than reporting a write it never made', () => {
    setup();
    expect(markImportRulesReviewed({ importId: 999999 })).toBe(false);
  });
});

describe('undoImport leaves no dangling marker', () => {
  function commitFixture() {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(accountId, parsed.rows);
    const committed = commitImport({ accountId, profileId: null, filename: 'td.csv', importedBy: userId, rows: hashed, errors: [] });
    return { db: current.db, sqlite: current.sqlite, importId: committed.importId };
  }

  it('a reviewed import that is then undone leaves nothing behind at all', () => {
    const { db, sqlite, importId } = commitFixture();
    db.run(sql`update transactions set categorization_source = 'rule' where import_id = ${importId}`);
    expect(unreviewedRuleImports().map((entry) => entry.importId)).toEqual([importId]);
    markImportRulesReviewed({ importId });

    undoImport(importId);

    // The marker lives ON the imports row, and the undo deletes that row -- so there is no orphaned
    // reviewed-flag pointing at a batch that no longer exists. This is the fourth reason the marker
    // is not per-transaction: a per-row flag would SURVIVE on every row an undo keeps.
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
    expect(sqlite.prepare('select count(*) as c from imports where rules_reviewed_at is not null').get()).toEqual({ c: 0 });
    expect(unreviewedRuleImports()).toEqual([]);
  });

  it('an UNREVIEWED import that is undone stops being counted', () => {
    const { db, importId } = commitFixture();
    db.run(sql`update transactions set categorization_source = 'rule' where import_id = ${importId}`);
    expect(unreviewedRuleImports()).toHaveLength(1);
    undoImport(importId);
    expect(unreviewedRuleImports()).toEqual([]);
  });
});

describe('commitStagedImport reports what the rules did, and never marks the import seen', () => {
  // commitStagedImport reads the staged file out of DATA_DIR, so this block needs a real one.
  let tempDir: string;
  let originalDataDir: string | undefined;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-rules-audit-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
  });
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('counts the rows a rule claimed and leaves rules_reviewed_at NULL', () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db);
    const accountId = insertTestAccount(current.db);
    const groceries = categoryIdByName(current.db, 'Groceries');

    // A rule the household wrote, over an invented merchant, so this fixture says exactly what it
    // means: one of the two rows will be claimed by a rule and the other by nothing.
    upsertRuleFromCorrection({
      pattern: 'CORNER MARKET',
      matchType: 'contains',
      ruleKind: 'category',
      categoryId: groceries,
      createdBy: userId,
      actorRole: 'admin',
    });

    const csv = Buffer.from(
      ['"2026-03-02","POS PURCHASE CORNER MARKET","24.50",,"1000.00"', '"2026-03-03","POS PURCHASE FUEL DEPOT","40.00",,"960.00"', ''].join('\n'),
      'utf8',
    );
    const stagingId = writeStagedFile(csv);
    const result = commitStagedImport({
      stagingId,
      filename: 'march.csv',
      accountId,
      profileId: getProfileByName('TD Chequing/Debit')!.id,
      mapping: getBuiltinPreset('TD Chequing/Debit'),
      userId,
    });

    expect(result.rowsAdded).toBe(2);
    // The number the owner's objection is about. Distinct from needsReview, which by construction
    // EXCLUDES every rule-assigned row: REVIEW_WHERE treats a rule assignment as settled.
    expect(result.rulesApplied).toBe(1);
    expect(result.needsReview).toBe(1);

    // NOTHING was written to the marker at import time. A fresh import must be UNREVIEWED, and the
    // nullable-no-default column is what makes that true with no write to forget.
    const stamp = current.sqlite.prepare('select rules_reviewed_at from imports where id = ?').get(result.importId) as {
      rules_reviewed_at: string | null;
    };
    expect(stamp.rules_reviewed_at).toBeNull();
    expect(unreviewedRuleImports()).toEqual([
      {
        importId: result.importId,
        accountId,
        accountName: 'Joint Chequing',
        filename: 'march.csv',
        createdAt: expect.any(String),
        ruleRowCount: 1,
      },
    ]);
  });
});
