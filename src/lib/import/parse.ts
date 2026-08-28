import Papa from 'papaparse';
import { parseDateString } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import { decodeBuffer, type DetectedEncoding } from './decode';
import type { EncodingChoice, ImportMapping } from './mapping';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10_000;

export class ImportLimitError extends Error {
  readonly code: 'file_too_large' | 'too_many_rows';
  constructor(code: 'file_too_large' | 'too_many_rows', message: string) {
    super(message);
    this.name = 'ImportLimitError';
    this.code = code;
  }
}

export interface CandidateRow {
  rowIndex: number;
  rawDate: string;
  date: string;
  rawDescription: string;
  amountCents: number;
  /**
   * The account's running balance immediately after this row, read out of
   * `mapping.balanceCol` (v1.8.0, spec 2026-08-23 Task 3) via the SAME parseAmountToCents
   * helper amountCol/debitCol/creditCol already use — thousands separators, currency symbols
   * and parenthesised negatives all behave identically to every other money cell in this
   * file. null means either the mapping has no balance column at all, or this particular
   * cell did not parse — ruling R6: an unparseable balance is NOT a row error, the
   * transaction still imports, and only that date's snapshot (closingBalancesByDate below) is
   * skipped.
   */
  balanceCents: number | null;
  /**
   * v1.13.0 ruling R9: the provider's stable per-transaction id (OFX FITID). null for every
   * CSV row. commitImport ALREADY dedups on this when set, and stores NULL in dedup_hash for
   * such a row (src/lib/import/commit.ts:196-198,231-233) -- the SimpleFIN path built exactly
   * this machinery and OFX needs no change to commit, undo or the transactions_external_id_uq
   * index at all.
   */
  externalId?: string | null;
  cells: string[];
}

export type RowErrorReason =
  | 'unparseable date'
  | 'missing description'
  | 'unparseable amount'
  | 'missing amount'
  | 'ambiguous amount'
  | 'malformed row';

export interface RowError {
  rowIndex: number;
  cells: string[];
  reason: RowErrorReason;
}

export interface ParseResult {
  rows: CandidateRow[];
  errors: RowError[];
  encoding: DetectedEncoding;
  skipped: number;
  /**
   * Whether this file's rows run oldest-to-newest or newest-to-oldest, DETECTED from the
   * first vs. last successfully-parsed row's date (v1.8.0, spec 2026-08-23 Task 3, ruling
   * R5) — never assumed. Feeds closingBalancesByDate below, which needs to know which
   * physical row of a same-date group is that date's chronologically LAST (closing) row.
   * Assuming a direction instead of detecting it silently inverts every balance for a bank
   * that exports the other way. A file with zero or one parsed row, or every parsed row
   * sharing one date, has nothing to detect direction from and is treated as oldest_first.
   */
  dateOrder: 'oldest_first' | 'newest_first';
}

function splitRows(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    // papaparse handles quoted embedded newlines and commas natively (Amex needs both).
  });
  return parsed.data.filter((row) => Array.isArray(row));
}

function cell(cells: string[], index: number | null): string {
  if (index === null) return '';
  const value = cells[index];
  return typeof value === 'string' ? value : '';
}

export function parseCsv(buf: Buffer, mapping: ImportMapping): ParseResult {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }

  const { text, encoding } = decodeBuffer(buf, mapping.encoding);
  const allRows = splitRows(text);
  const skipCount = mapping.hasHeader ? Math.max(mapping.headerRows, 1) : mapping.headerRows;
  const dataRows = allRows.slice(skipCount);

  if (dataRows.length > MAX_ROWS) {
    throw new ImportLimitError('too_many_rows', `File has more than ${MAX_ROWS} rows`);
  }

  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  let skipped = 0;

  dataRows.forEach((cells, rowIndex) => {
    if (mapping.skipRules && mapping.skipRules.containsAny.length > 0) {
      const joined = cells.join(' ').toUpperCase();
      if (mapping.skipRules.containsAny.some((needle) => joined.includes(needle.toUpperCase()))) {
        skipped += 1;
        return;
      }
    }

    if (cells.length === 1 && cells[0].trim() === '') {
      errors.push({ rowIndex, cells, reason: 'malformed row' });
      return;
    }

    const rawDate = cell(cells, mapping.dateCol).trim();
    const date = parseDateString(rawDate, mapping.dateFormat);
    if (date === null) {
      errors.push({ rowIndex, cells, reason: 'unparseable date' });
      return;
    }

    const rawDescription = mapping.descCols
      .map((index) => cell(cells, index).trim())
      .filter((part) => part.length > 0)
      .join(' ');
    if (rawDescription.length === 0) {
      errors.push({ rowIndex, cells, reason: 'missing description' });
      return;
    }

    let amountCents: number;
    if (mapping.amountMode === 'signed') {
      const parsed = parseAmountToCents(cell(cells, mapping.amountCol));
      if (parsed === null) {
        const blank = cell(cells, mapping.amountCol).trim().length === 0;
        errors.push({ rowIndex, cells, reason: blank ? 'missing amount' : 'unparseable amount' });
        return;
      }
      amountCents = mapping.signConvention === 'positive_is_spend' ? -parsed : parsed;
    } else {
      const debitRaw = cell(cells, mapping.debitCol).trim();
      const creditRaw = cell(cells, mapping.creditCol).trim();
      const debit = debitRaw.length === 0 ? null : parseAmountToCents(debitRaw);
      const credit = creditRaw.length === 0 ? null : parseAmountToCents(creditRaw);

      if (debitRaw.length > 0 && debit === null) {
        errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        return;
      }
      if (creditRaw.length > 0 && credit === null) {
        errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        return;
      }
      if (debit === null && credit === null) {
        errors.push({ rowIndex, cells, reason: 'missing amount' });
        return;
      }
      if (debit !== null && credit !== null && debit !== 0 && credit !== 0) {
        errors.push({ rowIndex, cells, reason: 'ambiguous amount' });
        return;
      }
      // -debit (not -|debit|) so a negative debit reads as a refund.
      amountCents = debit !== null && debit !== 0 ? -debit : (credit ?? 0);
    }

    // Ruling R6: reuses the SAME parseAmountToCents helper as amountCol/debitCol/creditCol
    // above (no second number parser), and its failure is discarded rather than turned into
    // a RowError -- an unparseable balance cell does not stop the transaction itself from
    // importing. mapping.balanceCol === null (every mapping before v1.8.0, and every built-in
    // preset except TD Chequing/Debit) short-circuits to null without even reading a cell.
    const balanceCents = mapping.balanceCol === null ? null : parseAmountToCents(cell(cells, mapping.balanceCol));

    // Stamped explicitly (not merely absent) so a CSV row and an OFX row differ in this ONE
    // field's value, never in whether the field exists on the object.
    rows.push({ rowIndex, rawDate, date, rawDescription, amountCents, balanceCents, externalId: null, cells });
  });

  // Ruling R5: detected from the first vs. last ACCEPTED row (error/skipped rows never reach
  // `rows`, so they cannot skew this), never assumed. `rows` is a subsequence of file order
  // (the forEach above only ever appends, in the order dataRows was walked), so rows[0] and
  // rows[rows.length - 1] are exactly the first and last surviving rows as they appeared in
  // the file. Equal dates (a single-date file, however many rows) fail the `<` comparison and
  // fall through to oldest_first, matching R5's explicit rule for that case.
  const dateOrder: ParseResult['dateOrder'] =
    rows.length > 1 && rows[rows.length - 1].date < rows[0].date ? 'newest_first' : 'oldest_first';

  return { rows, errors, encoding, skipped, dateOrder };
}

/**
 * That date's CLOSING balance per ruling R4: the balance on the last row of the date group in
 * chronological order. For an oldest-first file that is the last such row in file order; for
 * a newest-first file it is the first. Rows whose balance cell did not parse (ruling R6) are
 * skipped entirely (never treated as a zero), and a date with no parseable balance at all gets
 * no entry rather than a fabricated one.
 *
 * Implementation note: walking the (optionally reversed) rows left-to-right and letting a
 * plain Map.set for the same date key OVERWRITE is what "last one processed wins" means here
 * -- for dateOrder 'newest_first' the array is reversed first, so the row that ends up
 * "last processed" is the file's FIRST row of that date's group, exactly as R5 requires.
 */
export function closingBalancesByDate(
  rows: CandidateRow[],
  dateOrder: ParseResult['dateOrder'],
): Map<string, number> {
  const out = new Map<string, number>();
  const ordered = dateOrder === 'newest_first' ? [...rows].reverse() : rows;
  for (const row of ordered) {
    if (row.balanceCents === null) continue;
    out.set(row.date, row.balanceCents); // later write wins => last row of the group
  }
  return out;
}

export function previewRawRows(
  buf: Buffer,
  encoding: EncodingChoice,
  limit = 10,
): { rows: string[][]; encoding: DetectedEncoding } {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const decoded = decodeBuffer(buf, encoding);
  return { rows: splitRows(decoded.text).slice(0, limit), encoding: decoded.encoding };
}
