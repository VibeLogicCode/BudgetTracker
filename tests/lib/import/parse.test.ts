import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { closingBalancesByDate, ImportLimitError, MAX_ROWS, parseCsv, previewRawRows, type CandidateRow } from '@/lib/import/parse';
import { getBuiltinPreset } from '@/lib/import/presets';
import type { ImportMapping } from '@/lib/import/mapping';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

describe('TD Chequing/Debit preset', () => {
  const mapping = getBuiltinPreset('TD Chequing/Debit');

  it('parses every row of the fixture with no errors', () => {
    const result = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(9);
    expect(result.encoding).toBe('utf-8');
  });

  it('treats the debit column as money out and the credit column as money in', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[0]).toMatchObject({ rowIndex: 0, rawDate: '2026-03-02', date: '2026-03-02', amountCents: -485 });
    expect(rows[2]).toMatchObject({ date: '2026-03-04', amountCents: 214567 });
  });

  it('keeps the raw description verbatim, including the bank’s space runs', () => {
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[0].rawDescription).toBe('POS PURCHASE       TIM HORTONS #4821 TORONTO ON');
  });

  it('preserves the raw date string separately from the parsed date', () => {
    // The real export's date column is already ISO, so rawDate and date coincide here —
    // the point of the assertion is that rawDate is read verbatim from the cell (trimmed,
    // unmodified), not reconstructed from the parsed components.
    const { rows } = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(rows[6].rawDate).toBe('2026-03-07');
    expect(rows[6].date).toBe('2026-03-07');
  });
});

describe('TD Visa preset', () => {
  it('reads a refund out of the credit column as a positive amount', () => {
    const { rows, errors } = parseCsv(fixture('td-visa.csv'), getBuiltinPreset('TD Visa'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows[5]).toMatchObject({ rawDescription: 'AMZN Mktp CA*RT4XY9083 REFUND', amountCents: 4127 });
    expect(rows[3]).toMatchObject({ rawDescription: 'PAYMENT - THANK YOU', amountCents: 50000 });
  });
});

describe('Scotiabank preset', () => {
  it('reads the signed amount column with negative = money out', () => {
    const { rows, errors } = parseCsv(fixture('scotia.csv'), getBuiltinPreset('Scotiabank Chequing/Debit'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ date: '2026-03-02', rawDescription: 'PETRO-CANADA 12345 BURLINGTON ON', amountCents: -4500 });
    expect(rows[2].amountCents).toBe(150000);
  });
});

describe('Amex Canada preset', () => {
  const mapping = getBuiltinPreset('Amex Canada');

  it('skips the header row and flips the sign (positive = charge)', () => {
    const { rows, errors } = parseCsv(fixture('amex.csv'), mapping);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ rowIndex: 0, date: '2026-03-02', rawDescription: 'CAFE DEPOT MONTREAL', amountCents: -1875 });
  });

  it('handles quoted embedded newlines without shifting the row alignment', () => {
    // Real export's multi-line quoting lives in Address/City-Province (cols 12-13), not
    // Description (col 2) or Amount (col 5) — this proves those newlines don't leak into
    // the columns the mapping actually reads.
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows.map((r) => r.date)).toEqual(['2026-03-02', '2026-03-04', '2026-03-06', '2026-03-07', '2026-03-09', '2026-03-11']);
  });

  it('turns a negative Amex amount into a positive credit', () => {
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows[2]).toMatchObject({ rawDescription: 'AMEX PAYMENT RECEIVED - THANK YOU', amountCents: 35000 });
    expect(rows[4]).toMatchObject({ rawDescription: 'UNIQLO CANADA TORONTO', amountCents: 5999 });
  });

  it('ignores the Amex Merchant/Card Member/Reference columns in v1 (real export has no Category column)', () => {
    // rawDescription must come from column 2 only; the Merchant column (11) intentionally
    // carries different text ("... STORE ...") to prove neighbouring columns don't leak in.
    const { rows } = parseCsv(fixture('amex.csv'), mapping);
    expect(rows[0].rawDescription).not.toContain('STORE');
  });
});

describe('windows-1252 fixture', () => {
  // td-chequing-win1252.csv is a generated, untouched fixture (scripts/make-fixtures.mjs)
  // whose dates are still MM/DD/YYYY; only the encoding fallback is under test here, so
  // the date format is overridden explicitly rather than regenerating the fixture.
  const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' };

  it('reports the detected encoding and keeps accented merchants intact', () => {
    const result = parseCsv(fixture('td-chequing-win1252.csv'), mapping);
    expect(result.encoding).toBe('windows-1252');
    expect(result.errors).toEqual([]);
    expect(result.rows[0].rawDescription).toContain('CAFÉ RÉPUBLIQUE');
    expect(result.rows[1].rawDescription).toContain('MÉTRO PLUS');
  });
});

describe('row-level errors', () => {
  // mint-like-edge-cases.csv is an untouched fixture whose dates are still MM/DD/YYYY;
  // this block is about row-level error collection, not the TD Chequing preset's real
  // date format, so it's overridden explicitly here rather than regenerating the fixture.
  const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), dateFormat: 'MM/DD/YYYY' };

  it('collects each failure without aborting the file', () => {
    const result = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(result.errors.map((e) => [e.rowIndex, e.reason])).toEqual([
      [0, 'unparseable date'],
      [1, 'unparseable amount'],
      [3, 'missing description'],
      [4, 'missing amount'],
      [5, 'ambiguous amount'],
    ]);
    expect(result.rows.map((r) => r.rowIndex)).toEqual([2, 6, 7]);
  });

  it('keeps a quoted comma inside one description cell', () => {
    const { rows } = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(rows[0]).toMatchObject({ rowIndex: 2, rawDescription: 'DESCRIPTION, WITH COMMA', amountCents: -2500 });
  });

  it('treats a negative debit as a refund', () => {
    const { rows } = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    expect(rows[2]).toMatchObject({ rowIndex: 7, rawDescription: 'NEGATIVE DEBIT IS A REFUND', amountCents: 1999 });
  });

  it('numbers error rowIndexes on the same scale as row rowIndexes', () => {
    const result = parseCsv(fixture('mint-like-edge-cases.csv'), mapping);
    const all = [...result.rows.map((r) => r.rowIndex), ...result.errors.map((e) => e.rowIndex)].sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('mapping options', () => {
  it('joins multiple description columns with a single space', () => {
    const mapping: ImportMapping = { ...getBuiltinPreset('Scotiabank Chequing/Debit'), descCols: [3, 1] };
    const { rows } = parseCsv(fixture('scotia.csv'), mapping);
    expect(rows[0].rawDescription).toBe('PETRO-CANADA 12345 BURLINGTON ON -45.00');
  });

  it('applies skipRules', () => {
    const mapping: ImportMapping = {
      ...getBuiltinPreset('TD Chequing/Debit'),
      skipRules: { containsAny: ['E-TRANSFER', 'MONTHLY ACCOUNT FEE'] },
    };
    const result = parseCsv(fixture('td-chequing.csv'), mapping);
    expect(result.skipped).toBe(2);
    expect(result.rows).toHaveLength(7);
    expect(result.rows.some((r) => r.rawDescription.includes('E-TRANSFER'))).toBe(false);
  });

  it('honours headerRows greater than 1', () => {
    const csv = Buffer.from(['bank export', 'Date,Amount,x,Desc', '03/02/2026,-45.00,,COFFEE'].join('\n'), 'utf8');
    const mapping: ImportMapping = { ...getBuiltinPreset('Scotiabank Chequing/Debit'), hasHeader: true, headerRows: 2 };
    const { rows, errors } = parseCsv(csv, mapping);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawDescription).toBe('COFFEE');
  });

  it('accepts an explicit encoding override from the mapping', () => {
    const mapping: ImportMapping = { ...getBuiltinPreset('TD Chequing/Debit'), encoding: 'windows-1252' };
    expect(parseCsv(fixture('td-chequing-win1252.csv'), mapping).encoding).toBe('windows-1252');
  });
});

describe('limits', () => {
  it('rejects a file over 5 MB', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    expect(() => parseCsv(big, getBuiltinPreset('TD Chequing/Debit'))).toThrowError(ImportLimitError);
    try {
      parseCsv(big, getBuiltinPreset('TD Chequing/Debit'));
    } catch (error) {
      expect((error as ImportLimitError).code).toBe('file_too_large');
    }
  });

  it('rejects a file over 10,000 rows', () => {
    const line = '2026-03-02,COFFEE,4.85,,0.00';
    const csv = Buffer.from(Array.from({ length: MAX_ROWS + 1 }, () => line).join('\n'), 'utf8');
    try {
      parseCsv(csv, getBuiltinPreset('TD Chequing/Debit'));
      throw new Error('expected ImportLimitError');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportLimitError);
      expect((error as ImportLimitError).code).toBe('too_many_rows');
    }
  });

  it('accepts exactly 10,000 rows', () => {
    const line = '2026-03-02,COFFEE,4.85,,0.00';
    const csv = Buffer.from(Array.from({ length: MAX_ROWS }, () => line).join('\n'), 'utf8');
    expect(parseCsv(csv, getBuiltinPreset('TD Chequing/Debit')).rows).toHaveLength(MAX_ROWS);
  });
});

describe('balanceCol (Task 3, spec 2026-08-23 v1.8.0)', () => {
  const TD = { ...getBuiltinPreset('TD Chequing/Debit'), balanceCol: 4 };

  it('reads the balance column into balanceCents', () => {
    expect(parseCsv(Buffer.from('2026-07-25,COFFEE SHOP,4.50,,1000.00\n'), TD).rows[0].balanceCents).toBe(100000);
  });

  it('leaves balanceCents null and still imports the row when the balance cell is junk (ruling R6)', () => {
    const result = parseCsv(Buffer.from('2026-07-25,COFFEE SHOP,4.50,,n/a\n'), TD);
    expect(result.rows).toHaveLength(1); // ruling R6: an unparseable balance is not a row error
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0].balanceCents).toBeNull();
  });

  it('leaves balanceCents null when the mapping has no balance column', () => {
    const noBalance = { ...TD, balanceCol: null };
    expect(parseCsv(Buffer.from('2026-07-25,COFFEE SHOP,4.50,,1000.00\n'), noBalance).rows[0].balanceCents).toBeNull();
  });

  it('parses a negative balance for an overdrawn chequing account', () => {
    expect(parseCsv(Buffer.from('2026-07-25,FEE,4.50,,-120.75\n'), TD).rows[0].balanceCents).toBe(-12075);
  });

  it('parses a negative balance for a credit card owing money, via the same amount-cell parser as debit/credit columns', () => {
    // Reuses parseAmountToCents, the same helper amountCol/debitCol/creditCol already go
    // through -- accounting-parenthesis and $ prefixed forms must behave identically here.
    expect(parseCsv(Buffer.from('2026-07-25,GROCERY,45.00,,($245.10)\n'), TD).rows[0].balanceCents).toBe(-24510);
  });

  it('parses a balance with a thousands separator', () => {
    expect(parseCsv(Buffer.from('2026-07-25,PAYCHEQUE,,2000.00,"12,345.67"\n'), TD).rows[0].balanceCents).toBe(1234567);
  });

  it('detects an oldest-first file', () => {
    const csv = '2026-07-01,A,1.00,,900.00\n2026-07-20,B,1.00,,899.00\n';
    expect(parseCsv(Buffer.from(csv), TD).dateOrder).toBe('oldest_first');
  });

  it('detects a newest-first file', () => {
    const csv = '2026-07-20,B,1.00,,899.00\n2026-07-01,A,1.00,,900.00\n';
    expect(parseCsv(Buffer.from(csv), TD).dateOrder).toBe('newest_first');
  });

  it('treats a single-date file as oldest-first (ruling R5), even with several rows', () => {
    const csv = '2026-07-20,A,1.00,,900.00\n2026-07-20,B,1.00,,899.00\n2026-07-20,C,1.00,,898.00\n';
    expect(parseCsv(Buffer.from(csv), TD).dateOrder).toBe('oldest_first');
  });

  it('treats a file with zero or one parsed row as oldest-first', () => {
    expect(parseCsv(Buffer.from('2026-07-20,A,1.00,,900.00\n'), TD).dateOrder).toBe('oldest_first');
    expect(parseCsv(Buffer.from(''), TD).dateOrder).toBe('oldest_first');
  });

  it('reads the real TD Chequing fixture balance column, including the two same-date rows', () => {
    // fixtures/td-chequing.csv is the real 5-column export (date, description, debit, credit,
    // balance); rows 6 and 7 (0-based) share 2026-03-07 with two different balances, exactly
    // the shape ruling R4 exists for.
    const { rows } = parseCsv(fixture('td-chequing.csv'), TD);
    expect(rows[0].balanceCents).toBe(243122);
    expect(rows[6]).toMatchObject({ date: '2026-03-07', balanceCents: 360733 });
    expect(rows[7]).toMatchObject({ date: '2026-03-07', balanceCents: 360248 });
  });
});

describe('closingBalancesByDate (rulings R4 + R5)', () => {
  it('takes the LAST row of a date group as that date closing balance, oldest-first', () => {
    const rows = [
      { rowIndex: 0, date: '2026-07-27', balanceCents: 50000 },
      { rowIndex: 1, date: '2026-07-27', balanceCents: 40000 },
      { rowIndex: 2, date: '2026-07-27', balanceCents: 30000 },
    ] as unknown as CandidateRow[];
    expect(closingBalancesByDate(rows, 'oldest_first').get('2026-07-27')).toBe(30000);
  });

  it('takes the FIRST row of a date group when the file is newest-first', () => {
    const rows = [
      { rowIndex: 0, date: '2026-07-27', balanceCents: 30000 },
      { rowIndex: 1, date: '2026-07-27', balanceCents: 40000 },
      { rowIndex: 2, date: '2026-07-27', balanceCents: 50000 },
    ] as unknown as CandidateRow[];
    // NOTE on this expected value -- see this task's final report for the full derivation:
    // the spec's own Task 3 Step 2 snippet asserts 50000 here, which contradicts ruling R5
    // ("newest-first means the FIRST row [in file order] carries the closing balance") applied
    // to this exact fixture. File-order row 0 (balanceCents: 30000) IS that first row, so
    // 30000 is what R5 names -- 50000 is file-order row 2, the LAST row, which is the
    // OLDEST-FIRST rule. The spec's own reference closingBalancesByDate algorithm (Step 5:
    // reverse the array for newest_first, then a plain left-to-right "last write wins" loop)
    // also computes 30000 for this input, confirming the algorithm is right and only the
    // test's literal expected value was wrong. Corrected here rather than copied verbatim.
    expect(closingBalancesByDate(rows, 'newest_first').get('2026-07-27')).toBe(30000);
  });

  it('takes the last row in FILE ORDER for a mixed multi-date oldest-first file, per date', () => {
    const rows = [
      { rowIndex: 0, date: '2026-07-01', balanceCents: 100000 },
      { rowIndex: 1, date: '2026-07-02', balanceCents: 90000 },
      { rowIndex: 2, date: '2026-07-02', balanceCents: 80000 },
      { rowIndex: 3, date: '2026-07-03', balanceCents: 70000 },
    ] as unknown as CandidateRow[];
    const result = closingBalancesByDate(rows, 'oldest_first');
    expect(result.get('2026-07-01')).toBe(100000);
    expect(result.get('2026-07-02')).toBe(80000);
    expect(result.get('2026-07-03')).toBe(70000);
  });

  it('ignores rows with a null balance when picking the closing balance', () => {
    const rows = [
      { rowIndex: 0, date: '2026-07-27', balanceCents: 30000 },
      { rowIndex: 1, date: '2026-07-27', balanceCents: null },
    ] as unknown as CandidateRow[];
    expect(closingBalancesByDate(rows, 'oldest_first').get('2026-07-27')).toBe(30000);
  });

  it('falls back to the nearest parseable row when the one R4 would otherwise have picked is null', () => {
    // Oldest-first: R4 names the LAST row of the group (rowIndex 2) as the closing balance,
    // but ruling R6 says that row still imports as a transaction with balanceCents: null. It
    // must not poison the day's snapshot with a missing value -- the last row that DID parse
    // (rowIndex 1, 45000) wins instead, not rowIndex 0's 50000 and not "no entry at all".
    const rows = [
      { rowIndex: 0, date: '2026-07-27', balanceCents: 50000 },
      { rowIndex: 1, date: '2026-07-27', balanceCents: 45000 },
      { rowIndex: 2, date: '2026-07-27', balanceCents: null },
    ] as unknown as CandidateRow[];
    expect(closingBalancesByDate(rows, 'oldest_first').get('2026-07-27')).toBe(45000);
  });

  it('returns no entry for a date whose every balance is null', () => {
    const rows = [{ rowIndex: 0, date: '2026-07-27', balanceCents: null }] as unknown as CandidateRow[];
    expect(closingBalancesByDate(rows, 'oldest_first').has('2026-07-27')).toBe(false);
  });

  it('returns an empty map for an empty row list', () => {
    expect(closingBalancesByDate([], 'oldest_first').size).toBe(0);
  });
});

describe('previewRawRows', () => {
  it('returns the first N raw rows including any header, for the mapping wizard', () => {
    const { rows, encoding } = previewRawRows(fixture('amex.csv'), 'auto', 3);
    expect(encoding).toBe('utf-8');
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe('Date');
    expect(rows[1][0]).toBe('02 Mar 2026');
    // Multi-line quoting lives in the City / Province column (index 13) in the real export.
    expect(rows[1][13]).toContain('\n');
  });

  it('defaults to 10 rows', () => {
    const { rows } = previewRawRows(fixture('td-chequing.csv'), 'auto');
    expect(rows).toHaveLength(9);
  });
});
