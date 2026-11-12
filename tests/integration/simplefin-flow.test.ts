import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, insertTestUser, type TestDb } from '../helpers/db';
import { claimSetupToken, type Fetcher } from '@/lib/simplefin/client';
import {
  getAccessUrl,
  isSimplefinManaged,
  linkAccount,
  linkOverlap,
  markSynced,
  saveClaimedConnection,
  unlinkAccount,
} from '@/lib/simplefin/connection';
import { runSync } from '@/lib/simplefin/sync';
import { createAccount } from '@/lib/accounts';
import { commitStagedImport } from '@/lib/import/flow';
import { writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { commitImport, previewUndoImport, undoImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));
const CLAIM_URL = 'https://bridge.example/simplefin/claim/DEMO';
const SETUP_TOKEN = Buffer.from(CLAIM_URL, 'utf8').toString('base64');
const ACCESS_URL = 'https://abc123:s3cr3t@bridge.example/simplefin';
const NOW = new Date('2026-08-15T12:00:00.000Z');

let current: TestDb | null = null;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-simplefin-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
  current?.cleanup();
  current = null;
});

function bridge(body: unknown): Fetcher {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
}

const txn = (id: string, iso: string, amount: string, description: string) => ({
  id,
  posted: Math.floor(Date.parse(iso) / 1000),
  amount,
  description,
  pending: false,
});

function payload(transactions: Record<string, unknown>[]) {
  return {
    accounts: [{ id: 'remote-1', name: 'Bridge Chequing', currency: 'CAD', balance: '1000.00', 'balance-date': 1755216000, transactions }],
    errlist: [],
  };
}

describe('claim → link → sync', () => {
  it('claims once and stores the access URL encrypted, never in plaintext', async () => {
    current = createSeededTestDb();
    const claimFetcher = vi.fn(async () => ({ ok: true, status: 200, text: async () => ACCESS_URL }));
    const accessUrl = await claimSetupToken(SETUP_TOKEN, claimFetcher);
    saveClaimedConnection(accessUrl, NOW);

    const stored = current.sqlite.prepare('select access_url_encrypted from simplefin_connections').get() as { access_url_encrypted: string };
    expect(stored.access_url_encrypted).not.toContain('s3cr3t');
    expect(stored.access_url_encrypted).not.toContain('bridge.example');
    expect(getAccessUrl()).toBe(ACCESS_URL);
  });

  it('rejects reusing a spent setup token', async () => {
    current = createSeededTestDb();
    const spent = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }));
    await expect(claimSetupToken(SETUP_TOKEN, spent)).rejects.toThrowError(/only be claimed once/i);
  });

  it('imports, then re-syncs an overlapping window with no duplicates', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'Bridge Bank', type: 'chequing', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });

    const first = await runSync({
      userId,
      now: NOW,
      fetcher: bridge(payload([txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'), txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA')])),
    });
    expect(first.totalAdded).toBe(2);

    // Second sync: the same two rows plus one new one, exactly what a 5-day overlap produces.
    const second = await runSync({
      userId,
      now: new Date('2026-08-16T12:00:00.000Z'),
      fetcher: bridge(
        payload([
          txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'),
          txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA'),
          txn('t3', '2026-08-15T15:00:00Z', '-8.75', 'LOBLAWS'),
        ]),
      ),
    });
    expect(second.totalAdded).toBe(1);
    expect(second.totalDuplicates).toBe(2);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(3);
  });

  it('undo of a sync behaves exactly like undo of a CSV import', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'Bridge Bank', type: 'chequing', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });

    const rows = [txn('t1', '2026-08-10T15:00:00Z', '-12.34', 'TIM HORTONS'), txn('t2', '2026-08-11T15:00:00Z', '-45.00', 'PETRO-CANADA')];
    const first = await runSync({ userId, now: NOW, fetcher: bridge(payload(rows)) });
    const second = await runSync({ userId, now: new Date('2026-08-16T12:00:00.000Z'), fetcher: bridge(payload(rows)) });

    // Both syncs saw both rows, so the first sync owns nothing exclusively.
    const firstImportId = first.accounts[0].importId!;
    expect(previewUndoImport(firstImportId)).toMatchObject({ willDelete: 0, willKeep: 2 });
    // A SimpleFIN sync's CommitRows carry no running balance (balanceCents: null on every row,
    // per commit.ts's own docblock), so closingBalancesByDate never produces a csv snapshot to
    // begin with -- snapshotsDeleted is 0 on every undo in this describe block, sole or shared.
    expect(undoImport(firstImportId)).toEqual({ deleted: 0, kept: 2, loanLinksReversed: 0, snapshotsDeleted: 0 });
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(2);

    expect(undoImport(second.accounts[0].importId!)).toEqual({ deleted: 2, kept: 0, loanLinksReversed: 0, snapshotsDeleted: 0 });
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });
});

describe('CSV vs SimpleFIN exclusivity', () => {
  it('refuses a CSV import into a linked account, and allows it again after unlinking', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const accountId = createAccount({ name: 'Bridge Chequing', institution: 'TD Canada Trust', type: 'chequing', ownerUserId: null });
    const profileId = getProfileByName('TD Chequing/Debit')!.id;
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD' });
    expect(isSimplefinManaged(accountId)).toBe(true);

    const stagingId = writeStagedFile(fixture('td-chequing.csv'));
    expect(() =>
      commitStagedImport({
        stagingId,
        filename: 'td.csv',
        accountId,
        profileId,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId,
      }),
    ).toThrowError(/synced from SimpleFIN/i);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);

    unlinkAccount('remote-1');
    expect(isSimplefinManaged(accountId)).toBe(false);
    const retry = writeStagedFile(fixture('td-chequing.csv'));
    const result = commitStagedImport({
      stagingId: retry,
      filename: 'td.csv',
      accountId,
      profileId,
      mapping: getBuiltinPreset('TD Chequing/Debit'),
      userId,
    });
    expect(result.rowsAdded).toBe(9);
  });

  it('leaves unlinked accounts importing normally', async () => {
    current = createSeededTestDb();
    const userId = insertTestUser(current.db, { name: 'Alice', username: 'alice' });
    const linked = createAccount({ name: 'Bridge Chequing', institution: 'Bridge', type: 'chequing', ownerUserId: null });
    const csvOnly = createAccount({ name: 'Joint Visa', institution: 'TD Canada Trust', type: 'credit', ownerUserId: null });
    saveClaimedConnection(ACCESS_URL, NOW);
    linkAccount({ simplefinAccountId: 'remote-1', accountId: linked, currency: 'CAD' });

    const stagingId = writeStagedFile(fixture('td-visa.csv'));
    const result = commitStagedImport({
      stagingId,
      filename: 'visa.csv',
      accountId: csvOnly,
      profileId: getProfileByName('TD Visa')!.id,
      mapping: getBuiltinPreset('TD Visa'),
      userId,
    });
    expect(result.rowsAdded).toBe(6);
  });
});

/**
 * v1.61.0 items 3a-3d end to end. An account fed by statements is linked to a connection that has
 * already synced: the overlap suggests the day after the statement, the first sync reaches back to
 * it (no gap), the statement's rows are not taken twice, and the bank's copy of a hand-typed
 * purchase waits in Needs review instead of counting twice.
 */
describe('statements, then a bank link from the chosen day', () => {
  it('takes the bank from the day after the statement, and holds the copy of a hand-typed row', async () => {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const accountId = createAccount({ name: 'Sam Visa', institution: 'Bridge Bank', type: 'credit', ownerUserId: null });
    const statement = computeRowHashes(
      accountId,
      [
        ['2026-03-05', -4217, 'MAPLE GROCER'],
        ['2026-03-12', -6130, 'FUEL STOP 12'],
        ['2026-03-19', -1800, 'CORNER CAFE'],
      ].map(([date, amountCents, rawDescription], rowIndex) => ({
        rowIndex,
        rawDate: String(date),
        date: String(date),
        rawDescription: String(rawDescription),
        amountCents: Number(amountCents),
        balanceCents: null,
        cells: [],
      })),
    );
    commitImport({ accountId, profileId: null, filename: 'march.csv', importedBy: alex, rows: statement, errors: [], origin: 'csv' });
    // Alex typed a fuel purchase in by hand after the statement closed.
    current.sqlite
      .prepare(
        `insert into transactions (account_id, date, raw_description, normalized_merchant, amount_cents, origin, created_by, created_at, updated_at)
         values (?, '2026-03-22', 'FUEL STOP 12', 'FUEL STOP 12', -6130, 'manual', ?, '2026-03-22T20:00:00.000Z', '2026-03-22T20:00:00.000Z')`,
      )
      .run(accountId, alex);

    // The connection already synced other accounts the day before.
    saveClaimedConnection(ACCESS_URL, new Date('2026-03-01T12:00:00.000Z'));
    markSynced(new Date('2026-03-26T16:00:00.000Z'));

    const overlap = linkOverlap(accountId, '2026-03-27');
    expect(overlap).toMatchObject({ rowsInWindow: 4, byOrigin: { csv: 3, manual: 1 }, suggestedStart: '2026-03-20' });
    linkAccount({ simplefinAccountId: 'remote-1', accountId, currency: 'CAD', syncFrom: overlap.suggestedStart });

    const bank = payload([
      txn('b-05', '2026-03-05T15:00:00Z', '-42.17', 'MAPLE GROCER #12'),
      txn('b-12', '2026-03-12T15:00:00Z', '-61.30', 'FUEL STOP 12'),
      txn('b-19', '2026-03-19T15:00:00Z', '-18.00', 'CORNER CAFE'),
      txn('b-21', '2026-03-21T15:00:00Z', '-25.40', 'MAPLE GROCER #12'),
      txn('b-23', '2026-03-23T15:00:00Z', '-61.30', 'FUEL STOP 12'),
    ]);
    const fetcher = bridge(bank);
    const first = await runSync({ userId: alex, now: new Date('2026-03-27T16:00:00.000Z'), fetcher });

    // The first pull reaches the start date, not just last sync minus five days (2026-03-21).
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toContain(`start-date=${Date.parse('2026-03-19T00:00:00.000Z') / 1000}`);
    expect(first.accounts[0]).toMatchObject({ added: 1, beforeStart: 3, held: 1, setAside: 0 });
    expect(first.totalHeld).toBe(1);
    const fuel = () =>
      (current!.sqlite.prepare("select count(*) as c from transactions where amount_cents = -6130").get() as { c: number }).c;
    expect(fuel()).toBe(2);
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(5);

    // The next sync overlaps the last one: nothing new, nothing held again.
    const second = await runSync({ userId: alex, now: new Date('2026-03-28T16:00:00.000Z'), fetcher: bridge(bank) });
    expect(second.accounts[0]).toMatchObject({ added: 0, duplicates: 1, held: 0, setAside: 1, beforeStart: 3 });
    expect((current.sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(5);
    expect((current.sqlite.prepare("select count(*) as c from set_aside_rows where state = 'waiting'").get() as { c: number }).c).toBe(1);
  });
});
