import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSeededTestDb, categoryIdByName, insertTestAccount, insertTestUser, type TestDb } from '../../helpers/db';
import { buildPreview, PREVIEW_ROW_LIMIT } from '@/lib/import/preview';
import { writeStagedFile } from '@/lib/import/staging';
import { getBuiltinPreset, getProfileByName } from '@/lib/import/presets';
import { commitImport } from '@/lib/import/commit';
import { commitStagedImport } from '@/lib/import/flow';
import { computeRowHashes } from '@/lib/import/dedup';
import { parseCsv } from '@/lib/import/parse';
import { parseOfx } from '@/lib/import/ofx';
import { upsertRuleFromCorrection } from '@/lib/categorize/rules';
import { upsertAccountCardPerson } from '@/lib/import/card-people';
import { recordSetAside } from '@/lib/import/set-aside';
import type { ImportMapping } from '@/lib/import/mapping';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

let current: TestDb | null = null;
let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-preview-'));
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

function setup(fixtureName = 'td-chequing.csv') {
  current = createSeededTestDb();
  const userId = insertTestUser(current.db);
  const accountId = insertTestAccount(current.db);
  const stagingId = writeStagedFile(fixture(fixtureName));
  return { db: current.db, sqlite: current.sqlite, userId, accountId, stagingId };
}

describe('buildPreview', () => {
  it('returns parsed rows with hashes, the detected encoding and the row counts', () => {
    const { accountId, stagingId } = setup();
    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });

    expect(preview).toMatchObject({ stagingId, filename: 'td.csv', accountId, encoding: 'utf-8', totalRows: 9, duplicateCount: 0, errorCount: 0, skipped: 0, truncated: false, source: 'csv' });
    expect(preview.rows).toHaveLength(9);
    expect(preview.rows[0]).toMatchObject({
      rowIndex: 0,
      rawDate: '2026-03-02',
      date: '2026-03-02',
      amountCents: -485,
      normalizedMerchant: 'TIM HORTONS',
      occurrenceIndex: 0,
      isDuplicate: false,
      duplicateTransactionId: null,
    });
    expect(preview.rows[0].dedupHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('flags rows already present in the database', () => {
    const { userId, accountId, stagingId } = setup();
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    const hashed = computeRowHashes(accountId, parsed.rows);
    const committed = commitImport({ accountId, profileId: null, filename: 'first.csv', importedBy: userId, rows: hashed.slice(0, 4), errors: [] });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.duplicateCount).toBe(4);
    expect(preview.rows.slice(0, 4).every((r) => r.isDuplicate)).toBe(true);
    expect(preview.rows[0].duplicateTransactionId).toBe(committed.insertedTransactionIds[0]);
    expect(preview.rows[4].isDuplicate).toBe(false);
  });

  it('scopes duplicate detection to the account', () => {
    const { db, userId, accountId, stagingId } = setup();
    const otherAccount = insertTestAccount(db, { name: 'Other' });
    const parsed = parseCsv(fixture('td-chequing.csv'), getBuiltinPreset('TD Chequing/Debit'));
    commitImport({ accountId: otherAccount, profileId: null, filename: 'other.csv', importedBy: userId, rows: computeRowHashes(otherAccount, parsed.rows), errors: [] });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.duplicateCount).toBe(0);
  });

  it('predicts a category per row without writing anything', () => {
    const { db, accountId, stagingId, sqlite } = setup();
    const coffee = categoryIdByName(db, 'Coffee');
    upsertRuleFromCorrection({ pattern: 'TIM HORTONS', matchType: 'exact', ruleKind: 'category', categoryId: coffee, createdBy: null, actorRole: 'admin' });

    const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.rows[0]).toMatchObject({ predictedCategoryId: coffee, predictedCategoryName: 'Coffee', predictedSource: 'rule' });
    expect((sqlite.prepare('select count(*) as c from transactions').get() as { c: number }).c).toBe(0);
  });

  it('marks card payments as transfers in the preview', () => {
    const { accountId, stagingId } = setup('td-visa.csv');
    const preview = buildPreview({ stagingId, filename: 'visa.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    const payment = preview.rows.find((r) => r.rawDescription === 'PAYMENT - THANK YOU');
    expect(payment?.isTransfer).toBe(true);
    expect(preview.rows.find((r) => r.rawDescription.startsWith('ESSO'))?.isTransfer).toBe(false);
  });

  it('lists error rows without dropping them silently', () => {
    // TD Visa's layout (date, desc, debit, credit) matches this fixture's columns
    // and its MM/DD/YYYY date format, unlike TD Chequing/Debit which now expects
    // ISO dates (src/lib/import/presets.ts, corrected against real exports).
    const { accountId, stagingId } = setup('mint-like-edge-cases.csv');
    const preview = buildPreview({ stagingId, filename: 'edge.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    expect(preview.errorCount).toBe(5);
    expect(preview.errors.map((e) => e.reason)).toContain('unparseable date');
    expect(preview.totalRows).toBe(3);
  });

  it('reports the detected encoding for a windows-1252 file', () => {
    // Same MM/DD/YYYY-vs-ISO reasoning as above: TD Visa's mapping fits this fixture.
    const { accountId, stagingId } = setup('td-chequing-win1252.csv');
    const preview = buildPreview({ stagingId, filename: 'fr.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Visa') });
    expect(preview.encoding).toBe('windows-1252');
    expect(preview.rows[0].rawDescription).toContain('CAFÉ RÉPUBLIQUE');
  });

  it('truncates the preview table but keeps the true totals', () => {
    current = createSeededTestDb();
    const accountId = insertTestAccount(current.db);
    const line = (n: number) => `2026-03-02,SHOP ${n},4.85,,0.00`;
    const csv = Buffer.from(Array.from({ length: PREVIEW_ROW_LIMIT + 25 }, (_, i) => line(i)).join('\n'), 'utf8');
    const stagingId = writeStagedFile(csv);

    const preview = buildPreview({ stagingId, filename: 'big.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
    expect(preview.rows).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(preview.totalRows).toBe(PREVIEW_ROW_LIMIT + 25);
    expect(preview.truncated).toBe(true);
  });

  describe('dateFormatDetection', () => {
    it('is unique for a file whose date column only fits one known format', () => {
      // amex.csv's dates are "02 Mar 2026" etc — only 'DD-MMM-YYYY' parses them.
      const { accountId, stagingId } = setup('amex.csv');
      const preview = buildPreview({ stagingId, filename: 'amex.csv', accountId, profileId: null, mapping: getBuiltinPreset('Amex Canada') });
      expect(preview.dateFormatDetection.status).toBe('unique');
      expect(preview.dateFormatDetection.detected).toBe('DD-MMM-YYYY');
    });

    it('resolves deterministically when the surviving formats can never disagree', () => {
      // td-chequing.csv's dates are ISO ("2026-03-02"), which both 'YYYY-MM-DD' and
      // 'YYYY/MM/DD' parse identically (see dates.ts) — a harmless tie, not a real
      // ambiguity, so detection still names one winner instead of asking the user.
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.dateFormatDetection.status).toBe('resolved');
      expect(preview.dateFormatDetection.detected).toBe('YYYY-MM-DD');
      expect(preview.dateFormatDetection.candidates).toContain('YYYY/MM/DD');
    });

    it('is ambiguous for a real DD/MM vs MM/DD file and still honours the explicitly chosen dateFormat', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(
        ['03/04/2026,SHOP A,4.85,,0.00', '05/06/2026,SHOP B,10.00,,0.00'].join('\n'),
        'utf8',
      );
      const stagingId = writeStagedFile(csv);
      const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' };

      const preview = buildPreview({ stagingId, filename: 'ambiguous.csv', accountId, profileId: null, mapping });
      expect(preview.dateFormatDetection.status).toBe('ambiguous');
      expect(preview.dateFormatDetection.detected).toBeNull();
      expect(preview.dateFormatDetection.candidates).toEqual(expect.arrayContaining(['MM/DD/YYYY', 'DD/MM/YYYY']));
      // The explicit mapping.dateFormat still won — rows parsed as MM/DD/YYYY, not
      // overridden by detection disagreeing with it.
      expect(preview.rows[0].date).toBe('2026-03-04');
      expect(preview.rows[1].date).toBe('2026-05-06');
    });

    it('reports none, without throwing, when nothing in the date column parses', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(['N/A,SHOP A,4.85,,0.00', 'N/A,SHOP B,10.00,,0.00'].join('\n'), 'utf8');
      const stagingId = writeStagedFile(csv);

      const preview = buildPreview({ stagingId, filename: 'none.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.dateFormatDetection).toEqual({ status: 'none', detected: null, candidates: [] });
      expect(preview.errorCount).toBe(2);
    });

    it('samples the raw date column even for rows the current dateFormat fails to parse', () => {
      // The mapping below is wrong on purpose (ISO expected, file is MM/DD/YYYY), so every
      // row lands in `errors` with reason 'unparseable date' — detection must still see the
      // raw column via those error rows' cells, not just successfully parsed rows.
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const csv = Buffer.from(['03/14/2026,SHOP A,4.85,,0.00', '01/05/2026,SHOP B,10.00,,0.00'].join('\n'), 'utf8');
      const stagingId = writeStagedFile(csv);

      const preview = buildPreview({ stagingId, filename: 'wrong-format.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.errorCount).toBe(2);
      expect(preview.dateFormatDetection.status).toBe('unique');
      expect(preview.dateFormatDetection.detected).toBe('MM/DD/YYYY');
    });
  });

  // Spec 2026-08-22, v1.6.0, Task 6 Carry 1: the preview is the only caller with real parsed
  // rows/headers, so it (and only it) gets a true column picker instead of MappingEditor's
  // plain numeric cardCol input. Always present, independent of mapping.cardCol's current
  // value -- it is exactly what lets someone SET cardCol for the first time.
  describe('columnOptions (Task 6 Carry 1 — the preview column picker)', () => {
    it('labels every column "Column N" for a headerless mapping', () => {
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      // td-chequing.csv's real rows carry a 5th (running-balance) column the mapping never
      // references by index -- columnOptions reports every column actually in the file, not
      // just the ones a bank preset happens to use.
      expect(preview.columnOptions).toEqual([
        { index: 0, label: 'Column 0' },
        { index: 1, label: 'Column 1' },
        { index: 2, label: 'Column 2' },
        { index: 3, label: 'Column 3' },
        { index: 4, label: 'Column 4' },
      ]);
    });

    it('labels every column with its real header text when the mapping has a header row', () => {
      const { accountId, stagingId } = setup('amex.csv');
      const preview = buildPreview({ stagingId, filename: 'amex.csv', accountId, profileId: null, mapping: getBuiltinPreset('Amex Canada') });
      expect(preview.columnOptions).toHaveLength(17);
      expect(preview.columnOptions[0]).toEqual({ index: 0, label: 'Date' });
      expect(preview.columnOptions[3]).toEqual({ index: 3, label: 'Card Member' });
      expect(preview.columnOptions[4]).toEqual({ index: 4, label: 'Account #' });
    });

    it('is present even when the mapping has no cardCol at all', () => {
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview.mapping.cardCol).toBeNull();
      expect(preview.columnOptions.length).toBe(5);
    });
  });

  // MUST-6.1's byte-identical guarantee: a mapping with no cardholder column must produce a
  // PreviewResult indistinguishable from before this feature existed.
  describe('cardValues (MUST-6.1) and the cardCol-null byte-identical guarantee', () => {
    it('is entirely absent from PreviewResult when mapping.cardCol is null -- not present as null, not present at all', () => {
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect('cardValues' in preview).toBe(false);
    });

    it('leaves every pre-existing field exactly as it was when cardCol is null', () => {
      const { accountId, stagingId } = setup();
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping: getBuiltinPreset('TD Chequing/Debit') });
      expect(preview).toMatchObject({
        stagingId,
        filename: 'td.csv',
        accountId,
        encoding: 'utf-8',
        totalRows: 9,
        duplicateCount: 0,
        errorCount: 0,
        skipped: 0,
        truncated: false,
      });
      expect(preview.rows).toHaveLength(9);
    });

    it('lists the distinct normalized card values with row counts, excluding blank cells, when cardCol is set', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const stagingId = writeStagedFile(fixture('amex-two-card.csv'));
      const mapping: ImportMapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };

      const preview = buildPreview({ stagingId, filename: 'amex.csv', accountId, profileId: null, mapping });

      expect(preview.cardValues).toEqual([
        { value: '-1001', rowCount: 3, assignedUserId: null, assignedUserName: null },
        { value: '-1002', rowCount: 2, assignedUserId: null, assignedUserName: null },
        { value: '-9999', rowCount: 1, assignedUserId: null, assignedUserName: null },
      ]);
    });

    it('shows the current account_card_people assignment for a value that already has one', () => {
      current = createSeededTestDb();
      const accountId = insertTestAccount(current.db);
      const alexId = insertTestUser(current.db, { name: 'Alex' });
      upsertAccountCardPerson({ accountId, cardValue: '-1001', userId: alexId });
      const stagingId = writeStagedFile(fixture('amex-two-card.csv'));
      const mapping: ImportMapping = { ...getBuiltinPreset('Amex Canada'), cardCol: 4 };

      const preview = buildPreview({ stagingId, filename: 'amex.csv', accountId, profileId: null, mapping });

      expect(preview.cardValues!.find((v) => v.value === '-1001')).toMatchObject({
        rowCount: 3,
        assignedUserId: alexId,
        assignedUserName: 'Alex',
      });
      expect(preview.cardValues!.find((v) => v.value === '-1002')).toMatchObject({ assignedUserId: null, assignedUserName: null });
    });

    it("reports no card values at all when cardCol points past every row's cell count", () => {
      const { accountId, stagingId } = setup(); // td-chequing.csv, 4 columns
      const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), cardCol: 50 };
      const preview = buildPreview({ stagingId, filename: 'td.csv', accountId, profileId: null, mapping });
      expect(preview.cardValues).toEqual([]);
    });
  });

  // v1.13.0 ruling R9 fix (item C2). buildPreview used to call parseCsv unconditionally, so an
  // OFX/QFX file previewed as garbled CSV (its own SGML tags read as "columns") while
  // commitStagedImport (src/lib/import/flow.ts) already dispatched on looksLikeOfx correctly --
  // a preview that bore no resemblance to what committing the same file would actually do.
  describe('OFX/QFX files (ruling R9, item C2)', () => {
    // Same synthetic OFX 1.x (SGML) fixture shape as tests/lib/import/ofx.test.ts's own SGML
    // constant -- three transactions, each with a real bank FITID.
    const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>CAD
<BANKACCTFROM><BANKID>000000000<ACCTID>0000000<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000<TRNAMT>-42.10<FITID>FIT-0001<NAME>GROCERY STORE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260812120000<TRNAMT>-180.00<FITID>FIT-0002<NAME>CITY TAX OFFICE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260815120000<TRNAMT>2100.00<FITID>FIT-0003<NAME>PAYROLL DEPOSIT</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

    function setupOfx() {
      current = createSeededTestDb();
      const userId = insertTestUser(current.db);
      const accountId = insertTestAccount(current.db);
      return { db: current.db, sqlite: current.sqlite, userId, accountId };
    }

    it('previews the real OFX rows (not CSV-garbled columns), with FITIDs as externalIds', () => {
      const { accountId } = setupOfx();
      const stagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      // The mapping passed here belongs to whatever CSV profile the account remembers -- ruling
      // R9 says an OFX file skips it entirely, so any valid CSV mapping proves the point.
      const preview = buildPreview({
        stagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: null,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      });

      const parsed = parseOfx(Buffer.from(OFX, 'utf8'));
      expect(preview.totalRows).toBe(parsed.rows.length);
      expect(preview.rows).toHaveLength(3);
      expect(preview.rows.map((r) => r.externalId)).toEqual(['FIT-0001', 'FIT-0002', 'FIT-0003']);
      expect(preview.rows[0]).toMatchObject({
        date: '2026-08-03',
        rawDescription: 'GROCERY STORE',
        amountCents: -4210,
        externalId: 'FIT-0001',
      });
      expect(preview.rows[2]?.amountCents).toBe(210000);
      expect(preview.encoding).toBe('utf-8');
    });

    // The heart of C2: a preview must agree with what commitStagedImport (the ACTUAL commit
    // path) does with the same bytes -- same row count, same FITIDs stored as external_id.
    it('yields the same rows commitStagedImport actually inserts, FITID for FITID', () => {
      const { accountId, userId } = setupOfx();

      const previewStagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      const preview = buildPreview({
        stagingId: previewStagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: null,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      });

      const commitStagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      const committed = commitStagedImport({
        stagingId: commitStagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: 1,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId,
      });

      expect(committed.rowsAdded).toBe(preview.rows.length);
      const storedExternalIds = current!.sqlite
        .prepare('select external_id as e from transactions where account_id = ? order by e')
        .all(accountId)
        .map((row) => (row as { e: string }).e);
      expect(storedExternalIds).toEqual(preview.rows.map((r) => r.externalId).sort());
    });

    // findExistingByExternalIds (src/lib/import/dedup.ts): a preview of a statement already
    // committed must mark its FITID rows as duplicates -- the dedup_hash-only lookup that
    // predates this fix can never do this, because commitImport stores dedup_hash NULL for a
    // provider-id row (src/lib/import/commit.ts).
    it('flags rows already committed by FITID as duplicates on a re-preview', () => {
      const { accountId, userId } = setupOfx();

      const firstStagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      commitStagedImport({
        stagingId: firstStagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: 1,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
        userId,
      });

      const secondStagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      const preview = buildPreview({
        stagingId: secondStagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: null,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      });

      expect(preview.duplicateCount).toBe(3);
      expect(preview.rows.every((r) => r.isDuplicate)).toBe(true);
    });

    it('reports the source so the client can stop offering a CSV mapping (item BP)', () => {
      const { accountId } = setupOfx();
      const stagingId = writeStagedFile(Buffer.from(OFX, 'utf8'));
      const preview = buildPreview({
        stagingId,
        filename: 'statement.ofx',
        accountId,
        profileId: null,
        mapping: getBuiltinPreset('TD Chequing/Debit'),
      });

      expect(preview.source).toBe('ofx');
      // The two fields the client was inferring OFX from remain what they were -- source
      // replaces the inference, it does not change the data.
      expect(preview.dateFormatDetection.status).toBe('none');
      expect(preview.columnOptions).toEqual([]);
    });
  });
});

/**
 * v1.61.0 item 1a. Rows with no exact duplicate that the account may still hold: a row from another
 * source with the same amount within 3 days, or a key set aside before. Listed over the WHOLE file,
 * with the Leave out default the screen seeds its box from.
 */
describe('buildPreview: rows that may already be here (v1.61.0)', () => {
  const TD = () => getBuiltinPreset('TD Chequing/Debit');

  function setupHousehold() {
    current = createSeededTestDb();
    const alex = insertTestUser(current.db, { name: 'Alex', username: 'alex' });
    const accountId = insertTestAccount(current.db, { name: 'Joint Chequing', ownerUserId: alex });
    const t = current;
    /** One row already in the account, arrived by `origin` (default: typed by hand). */
    const existing = (date: string, amountCents: number, origin = 'manual', description = 'MAPLE GROCER') =>
      (
        t.sqlite
          .prepare(
            `insert into transactions (account_id, attributed_user_id, date, raw_description, normalized_merchant,
               amount_cents, origin, created_by, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z') returning id`,
          )
          .get(accountId, alex, date, description, description, amountCents, origin, alex) as { id: number }
      ).id;
    return { alex, accountId, existing, sqlite: t.sqlite };
  }

  const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');

  /** What a single delete of an imported row, or a Leave out tick, leaves behind. */
  function setAside(over: {
    accountId: number;
    alex: number;
    row: { dedupHash: string; hashVersion: number; date: string; amountCents: number; rawDescription: string };
    state: 'waiting' | 'dismissed';
    reason: 'possible_duplicate' | 'deleted';
    importId?: number | null;
  }) {
    recordSetAside({
      accountId: over.accountId,
      importId: over.importId ?? null,
      state: over.state,
      reason: over.reason,
      origin: 'csv',
      date: over.row.date,
      amountCents: over.row.amountCents,
      rawDescription: over.row.rawDescription,
      attributedUserId: over.alex,
      dedupHash: over.row.dedupHash,
      externalId: null,
      hashVersion: over.row.hashVersion,
      candidateTxnId: null,
      decidedBy: over.state === 'dismissed' ? over.alex : null,
    });
  }

  it('lists a possible duplicate at row 230 of a 250-row file, past the table limit', () => {
    const { accountId, existing } = setupHousehold();
    // Every row a different amount, so only SHOP 230 (-$231.00) meets the hand-typed row.
    const lines = Array.from({ length: 250 }, (_, n) => `2026-03-10,SHOP ${n},${n + 1}.00,,`);
    const typed = existing('2026-03-09', -23100);

    const preview = buildPreview({ stagingId: writeStagedFile(csv(lines)), filename: 'march.csv', accountId, profileId: null, mapping: TD() });

    expect(preview.rows).toHaveLength(PREVIEW_ROW_LIMIT);
    expect(preview.setAside).toHaveLength(1);
    expect(preview.setAside[0]).toMatchObject({
      rawDescription: 'SHOP 230',
      date: '2026-03-10',
      amountCents: -23100,
      kind: 'possible_duplicate',
      defaultSkip: true,
      decidable: true,
    });
    expect(preview.setAside[0]!.candidates.map((candidate) => candidate.id)).toEqual([typed]);
    // The preview names the row by the key the commit stores it under.
    const hashed = computeRowHashes(accountId, parseCsv(csv(lines), TD()).rows);
    expect(preview.setAside[0]!.key).toBe(hashed[230]!.dedupHash);
    expect(preview.duplicateCount).toBe(0);
  });

  it('ticks one candidate by default and leaves two unticked, with both listed', () => {
    const { accountId, existing } = setupHousehold();
    const only = existing('2026-03-08', -4217);
    const near = existing('2026-03-14', -6130, 'manual', 'FUEL STOP 12');
    const far = existing('2026-03-17', -6130, 'manual', 'FUEL STOP 12');
    const stagingId = writeStagedFile(csv(['2026-03-09,MAPLE GROCER,42.17,,', '2026-03-15,FUEL STOP 12,61.30,,']));

    const preview = buildPreview({ stagingId, filename: 'march.csv', accountId, profileId: null, mapping: TD() });

    expect(preview.setAside.map((row) => [row.rawDescription, row.defaultSkip, row.candidates.map((c) => c.id)])).toEqual([
      ['MAPLE GROCER', true, [only]],
      ['FUEL STOP 12', false, [near, far]],
    ]);
    expect(preview.rows.map((row) => row.setAsideKind)).toEqual(['possible_duplicate', 'possible_duplicate']);
    expect(preview.setAside[0]!.candidates[0]).toMatchObject({ date: '2026-03-08', origin: 'manual', personName: 'Alex' });
  });

  it('lists a row deleted after an earlier import, and one left out before, both ticked', () => {
    const { accountId, alex, sqlite } = setupHousehold();
    const lines = ['2026-03-09,MAPLE GROCER,42.17,,', '2026-03-10,FUEL STOP 12,61.30,,', '2026-03-11,CORNER BAKERY,8.25,,'];
    const hashed = computeRowHashes(accountId, parseCsv(csv(lines), TD()).rows);
    const first = commitImport({ accountId, profileId: null, filename: 'march.csv', importedBy: alex, rows: hashed, errors: [] });
    for (const id of first.insertedTransactionIds.slice(0, 2)) {
      sqlite.prepare('delete from transaction_imports where transaction_id = ?').run(id);
      sqlite.prepare('delete from transactions where id = ?').run(id);
    }
    setAside({ accountId, alex, row: hashed[0]!, state: 'dismissed', reason: 'deleted', importId: first.importId });
    setAside({ accountId, alex, row: hashed[1]!, state: 'dismissed', reason: 'possible_duplicate', importId: first.importId });

    const preview = buildPreview({ stagingId: writeStagedFile(csv(lines)), filename: 'march.csv', accountId, profileId: null, mapping: TD() });

    expect(preview.duplicateCount).toBe(1);
    expect(preview.setAside.map((row) => [row.rawDescription, row.kind, row.defaultSkip, row.decidable])).toEqual([
      ['MAPLE GROCER', 'deleted_before', true, true],
      ['FUEL STOP 12', 'left_out_before', true, true],
    ]);
    expect(preview.rows.map((row) => row.setAsideKind)).toEqual(['deleted_before', 'left_out_before', null]);
  });

  it('lists a key waiting in Needs review as not decidable', () => {
    const { accountId, alex } = setupHousehold();
    const lines = ['2026-03-09,MAPLE GROCER,42.17,,'];
    const hashed = computeRowHashes(accountId, parseCsv(csv(lines), TD()).rows);
    setAside({ accountId, alex, row: hashed[0]!, state: 'waiting', reason: 'possible_duplicate' });

    const preview = buildPreview({ stagingId: writeStagedFile(csv(lines)), filename: 'march.csv', accountId, profileId: null, mapping: TD() });

    expect(preview.setAside).toEqual([
      expect.objectContaining({ key: hashed[0]!.dedupHash, kind: 'waiting', decidable: false, candidates: [] }),
    ]);
  });

  it('lists nothing for a file with no matches, and never compares a file with its own rows', () => {
    const { accountId } = setupHousehold();
    // Two identical same-day purchases from one file are two purchases.
    const stagingId = writeStagedFile(csv(['2026-03-09,MAPLE GROCER,42.17,,', '2026-03-09,MAPLE GROCER,42.17,,']));
    const preview = buildPreview({ stagingId, filename: 'march.csv', accountId, profileId: null, mapping: TD() });
    expect(preview.setAside).toEqual([]);
    expect(preview.rows.map((row) => row.setAsideKind)).toEqual([null, null]);
  });

  it('flags a QFX statement that overlaps rows a CSV already brought in', () => {
    const { accountId, alex } = setupHousehold();
    const history = computeRowHashes(accountId, parseCsv(csv(['2026-08-02,MAPLE GROCER #12,42.10,,']), TD()).rows);
    const csvImport = commitImport({ accountId, profileId: null, filename: 'august.csv', importedBy: alex, rows: history, errors: [], origin: 'csv' });
    const qfx = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '',
      '<OFX>',
      '<BANKMSGSRSV1><STMTTRNRS><STMTRS>',
      '<CURDEF>CAD',
      '<BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000<TRNAMT>-42.10<FITID>FIT-0001<NAME>MAPLE GROCER</STMTTRN>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260815120000<TRNAMT>2100.00<FITID>FIT-0003<NAME>PAYROLL DEPOSIT</STMTTRN>',
      '</BANKTRANLIST>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n');

    const preview = buildPreview({
      stagingId: writeStagedFile(Buffer.from(qfx, 'utf8')),
      filename: 'august.qfx',
      accountId,
      profileId: null,
      mapping: TD(),
    });

    expect(preview.source).toBe('ofx');
    expect(preview.setAside).toEqual([
      expect.objectContaining({
        key: 'FIT-0001',
        kind: 'possible_duplicate',
        defaultSkip: true,
        candidates: [expect.objectContaining({ id: csvImport.insertedTransactionIds[0], origin: 'csv', date: '2026-08-02' })],
      }),
    ]);
  });

  it('agrees with the commit past the table limit: the listed row is held when nobody decides', () => {
    const { accountId, alex, existing, sqlite } = setupHousehold();
    const lines = Array.from({ length: 250 }, (_, n) => `2026-03-10,SHOP ${n},${n + 1}.00,,`);
    existing('2026-03-09', -23100);
    const preview = buildPreview({ stagingId: writeStagedFile(csv(lines)), filename: 'march.csv', accountId, profileId: null, mapping: TD() });

    const result = commitStagedImport({
      stagingId: writeStagedFile(csv(lines)),
      filename: 'march.csv',
      accountId,
      profileId: getProfileByName('TD Chequing/Debit')!.id,
      mapping: TD(),
      userId: alex,
    });

    expect(preview.setAside).toHaveLength(1);
    expect(result).toMatchObject({ rowsAdded: 249, rowsHeld: 1, rowsSetAside: 0 });
    expect((sqlite.prepare(`select dedup_hash as h from set_aside_rows where state = 'waiting'`).get() as { h: string }).h).toBe(
      preview.setAside[0]!.key,
    );
  });
});
