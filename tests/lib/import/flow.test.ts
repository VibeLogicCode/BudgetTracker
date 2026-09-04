import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../../helpers/db';
import { createAccount } from '@/lib/accounts';
import { getBuiltinPreset, getProfileByName, listProfiles } from '@/lib/import/presets';
import { stagedFilePath, writeStagedFile } from '@/lib/import/staging';
import { ImportLimitError, MAX_FILE_BYTES } from '@/lib/import/parse';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

// Only runEngine is mocked; everything else in the module (buildContext,
// categorizeTransaction) keeps its real behaviour, since flow.ts's own logic
// (not the categorizer's) is what's under test here.
const runEngineMock = vi.fn();
vi.mock('@/lib/categorize/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/categorize/engine')>();
  return { ...actual, runEngine: (...args: Parameters<typeof actual.runEngine>) => runEngineMock(...args) };
});

// commitStagedImport is imported after the mock is registered so it picks up the mocked binding.
const { commitStagedImport } = await import('@/lib/import/flow');

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-flow-unit-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  runEngineMock.mockReset();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function setup() {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
  const accountId = createAccount({ name: 'Joint Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
  const profileId = getProfileByName('TD Chequing/Debit')!.id;
  return { db: current.db, sqlite: current.sqlite, userId, accountId, profileId };
}

describe('commitStagedImport — engine-failure isolation (review finding 2)', () => {
  it('reports engineFailed instead of throwing when runEngine blows up after a successful commit, and still cleans up staging', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    runEngineMock.mockImplementation(() => {
      throw new Error('categorizer exploded');
    });
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    const mapping = getBuiltinPreset('TD Chequing/Debit');

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping, userId });

    expect(result.engineFailed).toBe(true);
    expect(result.rowsAdded).toBe(9);
    expect(result.engine).toEqual({ processed: 0, categorized: 0, transfers: 0, skipped: 0, changed: 0 });
    // The rows are genuinely committed, not rolled back because categorization failed.
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(9);
    // Staging must not leak just because the engine threw.
    expect(fs.existsSync(stagedFilePath(stagingId))).toBe(false);
  });

  it('reports engineFailed: false and the real engine stats on the happy path', () => {
    const { userId, accountId, profileId } = setup();
    runEngineMock.mockImplementation((ids: number[]) => ({ processed: ids.length, categorized: 0, transfers: 1, skipped: 0 }));
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));

    const result = commitStagedImport({ stagingId, filename: 'td.csv', accountId, profileId, mapping: getBuiltinPreset('TD Chequing/Debit'), userId });

    expect(result.engineFailed).toBe(false);
    expect(result.engine).toEqual({ processed: 9, categorized: 0, transfers: 1, skipped: 0 });
    // F-03 (v1.31.0): the real fixture's own closing balances are internally consistent day
    // over day (it is a genuine bank export), so the newest pair this import supplied agrees
    // and the summary has nothing to say.
    expect(result.discrepancy).toBeNull();
  });
});

// F-03 (v1.31.0). "Did I miss a statement?" -- reconcileAccount (src/lib/balance-reconcile.ts)
// already exists and is exercised on its own in tests/lib/balance-reconcile.test.ts; what is new
// here is ONLY the wiring: does commitStagedImport call it for the right date, and does it stay
// silent for every account that cannot reconcile at all. A hand-built 'signed' mapping (rather
// than a built-in preset) keeps each fixture to the exact three columns this needs.
describe('commitStagedImport — F-03: the post-commit balance check', () => {
  const SIGNED_WITH_BALANCE = {
    hasHeader: false,
    headerRows: 0,
    dateCol: 0,
    dateFormat: 'YYYY-MM-DD',
    descCols: [1],
    amountMode: 'signed' as const,
    amountCol: 2,
    debitCol: null,
    creditCol: null,
    signConvention: 'negative_is_spend' as const,
    encoding: 'auto' as const,
    skipRules: null,
    cardCol: null,
    balanceCol: 3,
  };
  const NO_BALANCE_COL = { ...SIGNED_WITH_BALANCE, balanceCol: null };

  it('reports the newest pair when this import\'s own statement balance disagrees with the transactions since the last one', () => {
    runEngineMock.mockImplementation((ids: number[]) => ({ processed: ids.length, categorized: 0, transfers: 0, skipped: 0 }));
    const { userId, accountId, profileId } = setup();

    // First statement: anchors the account at $900.00 on 2026-07-01.
    commitStagedImport({
      stagingId: writeStagedFile(Buffer.from('2026-07-01,FIRST ROW,-100.00,900.00\n')),
      filename: 'first.csv',
      accountId,
      profileId,
      mapping: SIGNED_WITH_BALANCE,
      userId,
    });

    // Second statement: a real $50.00 spend on 2026-07-20 would leave $850.00, but this
    // (deliberately wrong) statement claims $800.00 -- a $50.00 gap only the bank's own
    // statement column could catch.
    const result = commitStagedImport({
      stagingId: writeStagedFile(Buffer.from('2026-07-20,SECOND ROW,-50.00,800.00\n')),
      filename: 'second.csv',
      accountId,
      profileId,
      mapping: SIGNED_WITH_BALANCE,
      userId,
    });

    expect(result.discrepancy).toEqual({
      accountId,
      fromDate: '2026-07-01',
      toDate: '2026-07-20',
      expectedCents: 80000,
      impliedCents: 85000,
      deltaCents: 5000,
    });
  });

  it('stays silent -- never "checked" -- for an account whose mapping has no balance column at all', () => {
    runEngineMock.mockImplementation((ids: number[]) => ({ processed: ids.length, categorized: 0, transfers: 0, skipped: 0 }));
    const { userId, accountId, profileId } = setup();

    commitStagedImport({
      stagingId: writeStagedFile(Buffer.from('2026-07-01,FIRST ROW,-100.00\n')),
      filename: 'first.csv',
      accountId,
      profileId,
      mapping: NO_BALANCE_COL,
      userId,
    });
    const result = commitStagedImport({
      stagingId: writeStagedFile(Buffer.from('2026-07-20,SECOND ROW,-50.00\n')),
      filename: 'second.csv',
      accountId,
      profileId,
      mapping: NO_BALANCE_COL,
      userId,
    });

    expect(result.discrepancy).toBeNull();
  });
});

describe('commitStagedImport — fork ordering (review finding 3)', () => {
  it('never forks the profile or repoints the account when the file fails validation', () => {
    const { sqlite, userId, accountId, profileId } = setup();
    const before = listProfiles().length;
    const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 'a');
    const stagingId = writeStagedFile(oversized);
    // An edited mapping, which WOULD trigger forkProfileIfBuiltin if reached.
    const edited = { ...getBuiltinPreset('TD Chequing/Debit'), encoding: 'utf-8' as const };

    expect(() => commitStagedImport({ stagingId, filename: 'huge.csv', accountId, profileId, mapping: edited, userId })).toThrow(ImportLimitError);

    expect(listProfiles()).toHaveLength(before);
    const account = sqlite.prepare('select import_profile_id from accounts where id = ?').get(accountId) as {
      import_profile_id: number | null;
    };
    expect(account.import_profile_id).toBeNull();
  });
});

// v1.13.0 whole-branch review, item I6. An asset account (ruling R10) holds a typed balance and
// takes no transactions at all -- the picker on every page that leads here already filters these
// out, but commitStagedImport itself had no second gate, the same one manualEntryAction
// (transactions/actions.ts) already carries for the hand-entry path.
describe('commitStagedImport — ruling R10: an asset account refuses to import (item I6)', () => {
  it('throws and inserts no transaction row, no import row, for an asset account', () => {
    const { sqlite, userId, profileId } = setup();
    const assetAccountId = createAccount({ name: 'Family Home', institution: '', type: 'asset', ownerUserId: null });
    const stagingId = writeStagedFile(fixture('td-chequing.csv'));

    expect(() =>
      commitStagedImport({
        stagingId,
        filename: 'td.csv',
        accountId: assetAccountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId,
      }),
    ).toThrow('That account only holds a balance you type in.');

    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
    expect((sqlite.prepare('select count(*) as c from imports').get() as { c: number }).c).toBe(0);
  });
});
