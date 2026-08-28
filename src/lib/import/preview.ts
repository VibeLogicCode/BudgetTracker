import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { categories } from '@/db/schema';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { buildContext, categorizeTransaction } from '@/lib/categorize/engine';
import { listAccountCardPeople } from './card-people';
import { detectDateFormat, type DateFormatDetection } from './detect-date-format';
import { computeRowHashes, findExistingByExternalIds, findExistingByHashes, type HashedRow } from './dedup';
import { normalizeCardValue, type ImportMapping } from './mapping';
import { looksLikeOfx, parseOfx } from './ofx';
import { parseCsv, previewRawRows, type CandidateRow, type ParseResult, type RowError } from './parse';
import { readStagedFile } from './staging';
import type { DetectedEncoding } from './decode';

export const PREVIEW_ROW_LIMIT = 200;

export interface PreviewRow {
  rowIndex: number;
  rawDate: string;
  date: string;
  rawDescription: string;
  normalizedMerchant: string;
  amountCents: number;
  occurrenceIndex: number;
  dedupHash: string;
  /** v1.13.0 ruling R9 (item C2): the provider's own id (OFX FITID). null for every CSV row --
   *  see CandidateRow's own doc comment (src/lib/import/parse.ts). */
  externalId: string | null;
  isDuplicate: boolean;
  duplicateTransactionId: number | null;
  predictedCategoryId: number | null;
  predictedCategoryName: string | null;
  predictedSource: 'rule' | 'bayes' | 'none';
  isTransfer: boolean;
}

export interface ColumnOption {
  index: number;
  /** Header text when mapping.hasHeader is true; a plain "Column N" placeholder otherwise. */
  label: string;
}

export interface CardValueSummary {
  /** Already normalizeCardValue()'d. */
  value: string;
  rowCount: number;
  /** This account's current account_card_people assignment for `value`, if any. */
  assignedUserId: number | null;
  assignedUserName: string | null;
}

export interface PreviewResult {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number | null;
  encoding: DetectedEncoding;
  mapping: ImportMapping;
  rows: PreviewRow[];
  errors: RowError[];
  totalRows: number;
  duplicateCount: number;
  errorCount: number;
  skipped: number;
  truncated: boolean;
  /**
   * Which reader produced this preview. v1.13.1 (item BP, ruling P18): the client had no way to
   * ask, so it rendered the CSV mapping editor over an OFX file -- whose controls preview and
   * commit both ignore (ruling R9) -- and MappingEditor turned dateFormatDetection.status
   * 'none' into a "could not recognize this column's date format" warning about dates that
   * parsed perfectly. Inferring it from columnOptions.length and that status would encode two
   * unrelated implementation details into a UI condition; one field says it outright.
   */
  source: 'csv' | 'ofx';
  /**
   * What the date column looks like independent of mapping.dateFormat — informational only.
   * mapping.dateFormat, above, is always what actually
   * parsed `rows`/`errors`; detection never overrides an explicit choice, it only tells the
   * caller whether that choice was the only reasonable one, a safe tie, or genuinely
   * ambiguous so the mapping UI can ask.
   */
  dateFormatDetection: DateFormatDetection;
  /**
   * Every column in the file's first row, labeled with its header text when mapping.hasHeader
   * is true (else a plain "Column N" placeholder) — powers the preview screen's cardholder
   * column picker (spec 2026-08-22, v1.6.0 Task 6, Carry 1). Always present, independent of
   * mapping.cardCol's current value, because it is exactly what lets someone SET cardCol for
   * the first time; it carries no card-value or person data of its own, so it is not part of
   * MUST-6.1's byte-identical guarantee below.
   */
  columnOptions: ColumnOption[];
  /**
   * MUST-6.1 (v1.6.0). Present only when mapping.cardCol is non-null: every distinct
   * normalizeCardValue() found among the file's valid (non-error) rows, with how many rows
   * carry it and this account's current account_card_people assignment for it, if any. A
   * blank cell or a cardCol beyond a row's own cell count never produces an entry — there is
   * nothing to assign there, since commit.ts's resolveAttribution always falls back to the
   * account owner for exactly those two cases. Absent entirely (not merely undefined) when
   * cardCol is null, so a mapping with no cardholder column produces a PreviewResult with no
   * trace of this feature — proved in preview.test.ts with `'cardValues' in preview`.
   */
  cardValues?: CardValueSummary[];
}

export function buildPreview(input: {
  stagingId: string;
  filename: string;
  accountId: number;
  profileId: number | null;
  mapping: ImportMapping;
}): PreviewResult {
  const buf = readStagedFile(input.stagingId);
  // v1.13.0 ruling R9 fix (item C2). This used to call parseCsv unconditionally, so an OFX/QFX
  // file previewed as garbled CSV (its own SGML/XML tags read as "columns") while the commit
  // path (src/lib/import/flow.ts) already dispatched correctly -- a preview that bore no
  // resemblance to what committing the same file would actually do. Same dispatch as flow.ts's
  // commitStagedImport, now shared by both.
  const ofx = looksLikeOfx(input.filename, buf) ? parseOfx(buf) : null;
  // `csv` (not `parsed.encoding`/`ofx === null`) is what every CSV-only branch below tests --
  // keeping it its own binding, rather than folding straight into a `parsed` union, is what lets
  // TypeScript narrow it back to a real ParseResult wherever it's used, since OfxParseResult has
  // no `skipped` field and this file's date-format/column-picker helpers are typed against
  // ParseResult specifically.
  const csv = ofx ? null : parseCsv(buf, input.mapping);
  const parsed = ofx ?? csv!;
  const hashed = computeRowHashes(input.accountId, parsed.rows);
  const existing = findExistingByHashes(
    input.accountId,
    hashed.map((row) => row.dedupHash),
  );
  // v1.13.0 ruling R9 fix (item C2): a provider-id row (OFX FITID) is stored with dedup_hash
  // NULL at commit time (commit.ts), so findExistingByHashes above can never match one of these
  // rows against an already-committed transaction -- an OFX preview needs this second lookup, the
  // exact one commitImport itself runs, or it would report every row "new" even on a re-preview
  // of an already-imported statement.
  const externalIds = hashed
    .map((row) => row.externalId ?? null)
    .filter((value): value is string => value !== null && value.length > 0);
  const existingByExternalId = findExistingByExternalIds(input.accountId, externalIds);

  const ctx = buildContext();
  const categoryNames = new Map<number, string>(
    getDb().select({ id: categories.id, name: categories.name }).from(categories).all().map((row) => [row.id, row.name]),
  );

  let duplicateCount = 0;
  const rows: PreviewRow[] = [];

  for (const row of hashed) {
    // Mirrors commitImport's own resolution exactly (src/lib/import/commit.ts): a provider id,
    // when present, is authoritative; only its absence falls back to the CSV dedup hash.
    const providerId = row.externalId || null;
    const duplicateTransactionId = providerId ? (existingByExternalId.get(providerId) ?? null) : (existing.get(row.dedupHash) ?? null);
    if (duplicateTransactionId !== null) duplicateCount += 1;

    if (rows.length < PREVIEW_ROW_LIMIT) {
      const normalizedMerchant = normalizeMerchant(row.rawDescription);
      const outcome = categorizeTransaction({ id: 0, normalizedMerchant }, ctx);
      rows.push({
        rowIndex: row.rowIndex,
        rawDate: row.rawDate,
        date: row.date,
        rawDescription: row.rawDescription,
        normalizedMerchant,
        amountCents: row.amountCents,
        occurrenceIndex: row.occurrenceIndex,
        dedupHash: row.dedupHash,
        externalId: providerId,
        isDuplicate: duplicateTransactionId !== null,
        duplicateTransactionId,
        predictedCategoryId: outcome.categoryId,
        predictedCategoryName: outcome.categoryId === null ? null : categoryNames.get(outcome.categoryId) ?? null,
        predictedSource: outcome.source,
        isTransfer: outcome.isTransfer,
      });
    }
  }

  const result: PreviewResult = {
    stagingId: input.stagingId,
    filename: input.filename,
    accountId: input.accountId,
    profileId: input.profileId,
    encoding: parsed.encoding,
    mapping: input.mapping,
    rows,
    errors: parsed.errors,
    totalRows: hashed.length,
    duplicateCount,
    errorCount: parsed.errors.length,
    // OfxParseResult has no skip-rules concept (ruling R9: an OFX file skips the CSV mapping
    // entirely, so there is no mapping.skipRules to apply against it either).
    skipped: csv?.skipped ?? 0,
    truncated: hashed.length > PREVIEW_ROW_LIMIT,
    source: ofx ? 'ofx' : 'csv',
    // Both informational-only, and both meaningless for OFX: its dates are always the fixed
    // OFX YYYYMMDD shape (parseOfx's own toIsoDate), never mapping.dateFormat, and its cells are
    // [DTPOSTED, NAME, TRNAMT, FITID] rather than the file's real CSV columns, so re-reading the
    // buffer as CSV to label "columns" for a picker that OFX has no use for would be actively
    // misleading rather than merely unused.
    dateFormatDetection: csv ? detectDateFormat(rawDateColumn(csv, input.mapping.dateCol)) : { candidates: [], status: 'none', detected: null },
    columnOptions: csv ? buildColumnOptions(buf, input.mapping) : [],
  };

  // Ruling R9: an OFX import has no cardholder column -- mapping.cardCol belongs to whatever CSV
  // mapping this account remembers, not to this file, so it is never consulted for one.
  if (csv && input.mapping.cardCol !== null) {
    result.cardValues = buildCardValueSummaries(input.accountId, input.mapping.cardCol, hashed);
  }

  return result;
}

/**
 * Task 6 Carry 1: real column labels for the preview's cardholder-column picker. Reads the
 * file's own first physical row again (cheap relative to the MAX_FILE_BYTES/MAX_ROWS caps
 * already enforced by the parseCsv call above, which this can never exceed since it reads
 * the same already-validated buffer) rather than reusing `parsed`, because parseCsv already
 * discards header rows (`dataRows = allRows.slice(skipCount)`) — exactly the row whose text
 * this needs when mapping.hasHeader is true.
 */
function buildColumnOptions(buf: Buffer, mapping: ImportMapping): ColumnOption[] {
  const firstRow = previewRawRows(buf, mapping.encoding, 1).rows[0] ?? [];
  return firstRow.map((cell, index) => ({
    index,
    label: mapping.hasHeader && cell.trim().length > 0 ? cell.trim() : `Column ${index}`,
  }));
}

/**
 * MUST-6.1: distinct normalizeCardValue()'d values across every valid (non-error) row —
 * the same row set commit.ts's resolveAttribution walks — each with a row count and this
 * account's current assignment, if any. Counts every hashed row, including rows that would
 * dedup as duplicates at commit time: the point is to show the file's real distribution so
 * an admin can assign people BEFORE committing, not just what would be newly inserted.
 */
function buildCardValueSummaries(accountId: number, cardCol: number, rows: HashedRow[]): CardValueSummary[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row.cells[cardCol];
    if (raw === undefined) continue;
    const value = normalizeCardValue(raw);
    if (value.length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const assignments = new Map(listAccountCardPeople(accountId).map((row) => [row.cardValue, row]));
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, rowCount]) => {
      const assignment = assignments.get(value);
      return {
        value,
        rowCount,
        assignedUserId: assignment?.userId ?? null,
        assignedUserName: assignment?.userName ?? null,
      };
    });
}

/**
 * Raw (pre-dateFormat) date-column strings, in original row order, from every row the
 * parser produced — both `rows` (dateFormat matched) and `errors` (whatever the reason,
 * including 'unparseable date'). Deliberately reads straight off each row's `cells`
 * rather than the already-parsed `date`/`rawDate` fields, so a currently-wrong
 * mapping.dateFormat doesn't hide the column's real values from detection — every error row
 * still carries its own cells verbatim.
 */
function rawDateColumn(parsed: ParseResult, dateCol: number): string[] {
  const combined: Array<{ rowIndex: number; cells: string[] }> = [
    ...parsed.rows.map((row: CandidateRow) => ({ rowIndex: row.rowIndex, cells: row.cells })),
    ...parsed.errors.map((row: RowError) => ({ rowIndex: row.rowIndex, cells: row.cells })),
  ];
  combined.sort((a, b) => a.rowIndex - b.rowIndex);
  return combined.map((row) => row.cells[dateCol] ?? '');
}
