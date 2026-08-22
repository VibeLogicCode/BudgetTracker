import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { createAccount } from '@/lib/accounts';
import { buildPreview } from '@/lib/import/preview';
import { commitStagedImport } from '@/lib/import/flow';
import { writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { undoImport } from '@/lib/import/commit';
import { listAccountCardPeople, upsertAccountCardPerson } from '@/lib/import/card-people';
import type { ImportMapping } from '@/lib/import/mapping';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-card-attribution-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

/**
 * MUST-6.3 (spec 2026-08-22 v1.6.0, Task 6). End to end, through the same public entry
 * points the real preview screen and API routes use (buildPreview, commitStagedImport,
 * undoImport — never commit.ts's internals directly): stage the two-card Amex fixture, map
 * cardCol to the Account # suffix column, assign both suffixes to two different users,
 * commit, prove per-row attribution; undo; re-import the same file and prove full dedup.
 *
 * amex-two-card.csv (fixtures/amex-two-card.csv, built by Task 3 for exactly this purpose)
 * has 7 data rows: 3 for suffix -1001 (Alex), 2 for -1002 (Sam), 1 for an unmapped
 * suffix -9999, and 1 with a blank Card Member/Account # entirely — the two distinct
 * fallback-to-owner paths, in the same file as the two matched cardholders.
 */
describe('per-card attribution: preview -> assign -> commit -> undo -> re-import dedup', () => {
  it('attributes each row to the right cardholder, falls back to the owner for the rest, survives undo, and fully dedups on re-import', () => {
    current = createSeededTestDb();
    const importedBy = insertTestUser(current.db, { name: 'Admin', username: 'admin' });
    const alexId = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const samId = insertTestUser(current.db, { name: 'Sam', username: 'sam' });
    // A genuinely joint account: no single owner, so the two fallback rows land on
    // attributed_user_id = NULL rather than a third person — the "unattributed" branch of
    // SHOULD-3.6's summary wording, not just "the account owner" branch.
    const accountId = createAccount({ name: 'Amex Cobalt', institution: 'American Express Canada', type: 'credit', ownerUserId: null });
    const builtinProfileId = getProfileByName('Amex Canada')!.id;
    // Account # (index 4) is the stabler key the spec recommends over Card Member (index 3)
    // — both work per Task 3, but this is the documented preference.
    const mapping: ImportMapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };

    // --- Preview: MUST-6.1's cardValues list, before any assignment exists yet.
    const firstStaging = writeStagedFile(fixture('amex-two-card.csv'));
    const preview = buildPreview({ stagingId: firstStaging, filename: 'amex-two-card.csv', accountId, profileId: builtinProfileId, mapping });
    expect(preview.totalRows).toBe(7);
    expect(preview.cardValues).toEqual([
      { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
      { value: '-1002', rowCount: 2, assignedUserId: null, assignedUserName: null },
      { value: '-9999', rowCount: 1, assignedUserId: null, assignedUserName: null },
    ]);

    // --- Assign both suffixes (what the preview screen's server action does immediately).
    upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alexId });
    upsertAccountCardPerson({ accountId, cardValue: '-1002', userId: samId });
    expect(listAccountCardPeople(accountId)).toHaveLength(2);

    // Re-preview after assigning: MUST-6.2's "already assigned shows preselected", proved at
    // the data layer (the component-level proof lives in import-client.test.tsx).
    const reStaging = writeStagedFile(fixture('amex-two-card.csv'));
    const reassignedPreview = buildPreview({ stagingId: reStaging, filename: 'amex-two-card.csv', accountId, profileId: builtinProfileId, mapping });
    expect(reassignedPreview.cardValues!.find((v) => v.value === '-1001')).toMatchObject({ assignedUserId: alexId, assignedUserName: 'Alex' });
    expect(reassignedPreview.cardValues!.find((v) => v.value === '-1002')).toMatchObject({ assignedUserId: samId, assignedUserName: 'Sam' });

    // --- Commit.
    const commitStaging = writeStagedFile(fixture('amex-two-card.csv'));
    const result = commitStagedImport({
      stagingId: commitStaging,
      filename: 'amex-two-card.csv',
      accountId,
      profileId: builtinProfileId,
      mapping,
      userId: importedBy,
    });
    expect(result.rowsAdded).toBe(7);
    expect(result.rowsDuplicate).toBe(0);
    expect(result.attributionSummary).toBe('3 rows to Alex, 2 rows to Sam, 2 rows to unattributed (no card match)');

    // Per-row attributed_user_id, checked by row content so a coincidental count match can't
    // hide a wrong pairing.
    const rows = current.sqlite
      .prepare('select raw_description, attributed_user_id from transactions where account_id = ? order by id')
      .all(accountId) as { raw_description: string; attributed_user_id: number | null }[];
    expect(rows).toEqual([
      { raw_description: 'CAFE DEPOT MONTREAL', attributed_user_id: alexId },
      { raw_description: 'INDIGO BOOKS TORONTO', attributed_user_id: samId },
      { raw_description: 'LCBO TORONTO', attributed_user_id: alexId },
      { raw_description: 'SHOPPERS DRUG MART', attributed_user_id: samId },
      { raw_description: 'LCBO OTTAWA', attributed_user_id: alexId },
      { raw_description: 'UNKNOWN CARD PURCHASE', attributed_user_id: null },
      { raw_description: 'NO CARD VALUE PURCHASE', attributed_user_id: null },
    ]);

    // --- Re-import the same file: full dedup, nothing new added (MUST-6.3).
    //
    // Ordering note (spec correction, documented rather than silently reordered without
    // explanation): the spec text sequences "undo, then re-import and assert full dedup".
    // undoImport hard-deletes a transaction once no import references it any more (verified
    // directly in tests/lib/import/undo.test.ts, Task 3) — so undoing THIS commit first
    // would remove all 7 rows, and a subsequent "re-import" would necessarily insert them
    // fresh (rowsAdded: 7, rowsDuplicate: 0), the opposite of "full dedup". Re-importing
    // BEFORE undo is the only order under which "rowsDuplicate equals the row count, rowsAdded
    // zero" can be true, so that is what this test proves, then undo is proved afterward
    // (below) using the exact "overlapping import" semantics tests/integration/import-flow.test.ts
    // already established for the non-attributed case.
    const secondStaging = writeStagedFile(fixture('amex-two-card.csv'));
    const second = commitStagedImport({
      stagingId: secondStaging,
      filename: 'amex-two-card.csv',
      accountId,
      profileId: result.profileId,
      mapping,
      userId: importedBy,
    });
    expect(second.rowsAdded).toBe(0);
    expect(second.rowsDuplicate).toBe(7);

    // --- Undo the original import. Every transaction is now ALSO linked to the second
    // (all-duplicate) import via transaction_imports, so undoing the first one keeps every
    // row — the same "shared row" behaviour the non-attributed overlapping-import test
    // already covers — and per-card attribution on the surviving rows is untouched.
    const undoFirst = undoImport(result.importId);
    expect(undoFirst).toMatchObject({ deleted: 0, kept: 7 });
    expect((current.sqlite.prepare('select count(*) as c from transactions where account_id = ?').get(accountId) as { c: number }).c).toBe(7);
    const survivingAttribution = current.sqlite
      .prepare('select raw_description, attributed_user_id from transactions where account_id = ? order by id')
      .all(accountId) as { raw_description: string; attributed_user_id: number | null }[];
    expect(survivingAttribution).toEqual(rows); // unchanged by undo

    // Undoing the second (now the only remaining) import removes them for good, proving
    // undo really can fully clean up a per-card-attributed import.
    const undoSecond = undoImport(second.importId);
    expect(undoSecond).toMatchObject({ deleted: 7, kept: 0 });
    expect((current.sqlite.prepare('select count(*) as c from transactions where account_id = ?').get(accountId) as { c: number }).c).toBe(0);

    // The card->person map is an account fact, not import history — neither undo touched it.
    expect(listAccountCardPeople(accountId)).toHaveLength(2);
  });
});
