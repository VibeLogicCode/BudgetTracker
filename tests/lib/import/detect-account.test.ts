import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { BUILTIN_PRESETS } from '@/lib/import/presets';
import { parseCsv } from '@/lib/import/parse';
import { commitImport } from '@/lib/import/commit';
import { computeRowHashes } from '@/lib/import/dedup';
import { createProfile } from '@/lib/import/presets';
import { detectImportAccount } from '@/lib/import/detect-account';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

const TD_CHEQUING = BUILTIN_PRESETS['TD Chequing/Debit'].mapping;

function fixtureRows(name: string, mapping = TD_CHEQUING) {
  return parseCsv(fs.readFileSync(path.join(root, 'fixtures', name)), mapping).rows;
}

/** The whole fixture, already in one account -- the state a re-download of the same period lands in. */
function importInto(accountId: number, userId: number, filename: string, rows = fixtureRows(filename)) {
  return commitImport({
    accountId,
    profileId: null,
    filename,
    importedBy: userId,
    // Hashed for THIS account, exactly as the real import path does -- which is also the whole
    // reason the overlap signal works: the same row in another account hashes differently.
    rows: computeRowHashes(accountId, rows),
    errors: [],
    mapping: TD_CHEQUING,
  });
}

/**
 * The the question asked, in one sentence: two TD accounts export files that look identical, so
 * which account a file belongs to cannot come from the file's SHAPE. It comes from its CONTENT --
 * the rows themselves, which differ per account. The dedup hash already scopes a row to an
 * account (dedupHash includes accountId, src/lib/import/dedup.ts), so asking "how many of these
 * rows does this account already have?" is a question the existing machinery can answer for every
 * account at once.
 */
describe('detectImportAccount: rows the account already has', () => {
  it('picks the account a re-downloaded statement overlaps', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing' });
    const other = insertTestAccount(current.db, { name: 'TD Visa', type: 'credit' });
    importInto(chequing, user, 'td-chequing.csv');

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'td-chequing.csv',
      profileId: null,
      accounts: [
        { id: chequing, name: 'TD Chequing', importProfileId: null },
        { id: other, name: 'TD Visa', importProfileId: null },
      ],
    });

    expect(result.account?.id).toBe(chequing);
    expect(result.confidence).toBe('certain');
    expect(result.reason).toContain('already in TD Chequing');
  });

  it('picks nothing when no account has seen any of these rows', () => {
    current = createSeededTestDb();
    const a = insertTestAccount(current.db, { name: 'TD Chequing' });
    const b = insertTestAccount(current.db, { name: 'TD Visa', type: 'credit' });

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'td-chequing.csv',
      profileId: null,
      accounts: [
        { id: a, name: 'TD Chequing', importProfileId: null },
        { id: b, name: 'TD Visa', importProfileId: null },
      ],
    });

    expect(result.account).toBeNull();
    expect(result.confidence).toBe('none');
  });

  it('reports the overlap count for every account it scored', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing' });
    importInto(chequing, user, 'td-chequing.csv');

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'td-chequing.csv',
      profileId: null,
      accounts: [{ id: chequing, name: 'TD Chequing', importProfileId: null }],
    });

    expect(result.scores[0]?.matchedRows).toBeGreaterThan(0);
  });
});

/**
 * The weaker signals, each of which only speaks when the one above it is silent. A first-ever
 * import into a fresh account overlaps nothing, so without these the picker would have no more to
 * go on than it does today (accounts[0], chosen by nothing at all).
 */
describe('detectImportAccount: the fallbacks, in order', () => {
  it('falls back to the account this filename went to last time', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing' });
    const other = insertTestAccount(current.db, { name: 'Scotia', institution: 'Scotiabank' });
    // History for the name, but NO overlapping rows: an older statement, same export filename.
    importInto(chequing, user, 'accountactivity.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'accountactivity.csv',
      profileId: null,
      accounts: [
        { id: chequing, name: 'TD Chequing', importProfileId: null },
        { id: other, name: 'Scotia', importProfileId: null },
      ],
    });

    expect(result.account?.id).toBe(chequing);
    expect(result.confidence).toBe('likely');
    expect(result.reason).toContain('accountactivity.csv');
  });

  /**
   * 2026-09-15, ruling B4. This branch took the single most recent `imports` row matching the
   * filename and never asked whether EARLIER ones went somewhere else -- and its own comment
   * already called the signal "weak on its own -- a bank that names every export
   * accountactivity.csv defeats it".
   *
   * That weakness was contained while a human was in the loop: they read the sentence and then
   * read a preview. The batch screen (src/lib/import/batch.ts) auto-imports on `likely`, so
   * nobody reads it any more, and a filename two accounts share would silently land a statement
   * in whichever one was used last. Disagreement now means the signal says nothing, which is this
   * file's own stated principle everywhere else: a wrong answer is worse than no answer.
   */
  it('says nothing when one filename has gone to two different accounts', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing' });
    const other = insertTestAccount(current.db, { name: 'Scotia', institution: 'Scotiabank' });
    // The same export name used by both accounts, neither overlapping the file being detected.
    importInto(chequing, user, 'accountactivity.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));
    importInto(other, user, 'accountactivity.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'accountactivity.csv',
      profileId: null,
      accounts: [
        { id: chequing, name: 'TD Chequing', importProfileId: null },
        { id: other, name: 'Scotia', importProfileId: null },
      ],
    });

    expect(result.account).toBeNull();
    expect(result.confidence).toBe('none');
  });

  /** Repeated agreement is the ordinary case and must still speak, or the fallback is dead. */
  it('still speaks when every past import of that filename agrees', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing' });
    const other = insertTestAccount(current.db, { name: 'Scotia', institution: 'Scotiabank' });
    importInto(chequing, user, 'accountactivity.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));
    importInto(chequing, user, 'accountactivity.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'accountactivity.csv',
      profileId: null,
      accounts: [
        { id: chequing, name: 'TD Chequing', importProfileId: null },
        { id: other, name: 'Scotia', importProfileId: null },
      ],
    });

    expect(result.account?.id).toBe(chequing);
    expect(result.confidence).toBe('likely');
  });

  it('falls back to the only account pinned to the detected profile', () => {
    current = createSeededTestDb();
    const tdProfile = createProfile({ name: 'TD test', institution: 'TD', mapping: TD_CHEQUING });
    const amexProfile = createProfile({ name: 'Amex test', institution: 'Amex', mapping: TD_CHEQUING });
    const chequing = insertTestAccount(current.db, { name: 'TD Chequing', importProfileId: tdProfile });
    const other = insertTestAccount(current.db, { name: 'Amex', importProfileId: amexProfile });

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'whatever.csv',
      profileId: tdProfile,
      accounts: [
        { id: chequing, name: 'TD Chequing', importProfileId: tdProfile },
        { id: other, name: 'Amex', importProfileId: amexProfile },
      ],
    });

    expect(result.account?.id).toBe(chequing);
    expect(result.reason).toContain('only account that uses');
  });

  it('picks nothing when TWO accounts are pinned to the detected profile -- the two-TD-accounts case', () => {
    current = createSeededTestDb();
    const shared = createProfile({ name: 'TD test', institution: 'TD', mapping: TD_CHEQUING });
    const one = insertTestAccount(current.db, { name: 'TD Chequing (joint)', importProfileId: shared });
    const two = insertTestAccount(current.db, { name: 'TD Chequing (mine)', importProfileId: shared });

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'whatever.csv',
      profileId: shared,
      accounts: [
        { id: one, name: 'TD Chequing (joint)', importProfileId: shared },
        { id: two, name: 'TD Chequing (mine)', importProfileId: shared },
      ],
    });

    expect(result.account).toBeNull();
    expect(result.reason).toContain('more than one');
  });

  it('prefers the overlap over the filename when the two disagree', () => {
    current = createSeededTestDb();
    const user = insertTestUser(current.db, { role: 'admin' });
    const rowsAccount = insertTestAccount(current.db, { name: 'Holds the rows' });
    const nameAccount = insertTestAccount(current.db, { name: 'Holds the filename' });
    importInto(rowsAccount, user, 'td-chequing.csv');
    importInto(nameAccount, user, 'export.csv', fixtureRows('td-visa.csv', BUILTIN_PRESETS['TD Visa'].mapping));

    const result = detectImportAccount({
      rows: fixtureRows('td-chequing.csv'),
      filename: 'export.csv',
      profileId: null,
      accounts: [
        { id: rowsAccount, name: 'Holds the rows', importProfileId: null },
        { id: nameAccount, name: 'Holds the filename', importProfileId: null },
      ],
    });

    expect(result.account?.id).toBe(rowsAccount);
  });
});
