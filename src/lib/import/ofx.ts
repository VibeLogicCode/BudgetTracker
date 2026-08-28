import { isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';
import { decodeBuffer, type DetectedEncoding } from './decode';
import { ImportLimitError, MAX_FILE_BYTES, type CandidateRow, type ParseResult, type RowError } from './parse';

/**
 * v1.13.0 ruling R9 (item AO / PROD-5). A reader for OFX 1.x (SGML) and OFX 2.x (XML), written in
 * repo because ruling R16 forbids a new dependency and because the subset we need is small.
 *
 * WHY NOT AN XML PARSER: OFX 1.x is NOT XML. Its leaves have no closing tags -- `<TRNAMT>-42.10`
 * followed by the next `<` is the whole element -- so every XML parser in existence rejects the
 * format the majority of Canadian banks still emit from "download for Quicken". A tag scanner reads
 * both dialects with one loop; an XML parser reads one of them.
 *
 * WHY FITID MATTERS: it is the bank's own stable id for a transaction, so overlapping statement
 * periods dedup EXACTLY instead of by our (date, amount, description, occurrence) fingerprint. The
 * database already has the column and the index for it -- transactions.external_id and
 * transactions_external_id_uq, both shipped for SimpleFIN -- so this needs no migration.
 */
export interface OfxParseResult {
  rows: CandidateRow[];
  errors: RowError[];
  /** From <CURDEF>, uppercased, or null. Recorded for the preview banner; never enforced. */
  currency: string | null;
  dialect: 'sgml' | 'xml';
  dateOrder: ParseResult['dateOrder'];
  /** v1.13.0 ruling R9 fix (item C2): buildPreview's PreviewResult reports the detected encoding
   *  for every file, CSV or OFX -- this is what a preview built from an OFX buffer reads. */
  encoding: DetectedEncoding;
}

/** Extension AND content. An extension alone is a claim, not evidence. */
export function looksLikeOfx(filename: string, buf: Buffer): boolean {
  if (!/\.(ofx|qfx)$/i.test(filename)) return false;
  const head = buf.subarray(0, 2048).toString('utf8').toUpperCase();
  return head.includes('OFXHEADER') || head.includes('<OFX>');
}

interface Tag {
  name: string;
  /** The text between this tag and the next '<'. Empty for a container. */
  value: string;
  closing: boolean;
}

/** One pass, no allocation per character. Skips the header block and any processing instruction. */
function scan(text: string): Tag[] {
  const body = text.slice(Math.max(0, text.toUpperCase().indexOf('<OFX>')));
  const tags: Tag[] = [];
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf('<', index);
    if (open === -1) break;
    const close = body.indexOf('>', open + 1);
    if (close === -1) break;
    const raw = body.slice(open + 1, close).trim();
    index = close + 1;
    if (raw.startsWith('?') || raw.startsWith('!')) continue;
    const closing = raw.startsWith('/');
    const name = (closing ? raw.slice(1) : raw).split(/\s/)[0]?.toUpperCase() ?? '';
    if (name.length === 0) continue;
    const nextOpen = body.indexOf('<', index);
    const value = (nextOpen === -1 ? body.slice(index) : body.slice(index, nextOpen)).trim();
    tags.push({ name, value, closing });
  }
  return tags;
}

/** OFX dates are YYYYMMDD[HHMMSS][.MMM][TZ]. Only the first eight characters are a calendar date. */
function toIsoDate(raw: string): string | null {
  const digits = raw.trim().slice(0, 8);
  if (!/^\d{8}$/.test(digits)) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return isIsoDate(iso) ? iso : null;
}

export function parseOfx(buf: Buffer): OfxParseResult {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ImportLimitError('file_too_large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }
  // OFX 1.x is routinely windows-1252 (its own header commonly declares CHARSET:1252), and
  // Node's Buffer#toString('utf8') is NOT strict -- it silently replaces invalid bytes with
  // U+FFFD rather than erroring, which is exactly the MÉTRO -> MÃ‰TRO corruption decode.ts's
  // own docblock warns about for CSV. Reusing the same strict-UTF-8-first/1252-fallback
  // decoder here (rather than a second, ad hoc guess) makes an accented merchant name in an
  // OFX file behave identically to one in a CSV file.
  const { text, encoding } = decodeBuffer(buf, 'auto');
  // An XML declaration or a closing leaf tag is the only reliable tell; OFXHEADER:100 vs
  // OFXHEADER="200" is the other. Reported, never acted on -- the scanner reads both.
  const dialect: 'sgml' | 'xml' = /^\s*<\?xml/i.test(text) || /OFXHEADER\s*=\s*"2/i.test(text) ? 'xml' : 'sgml';

  const tags = scan(text);
  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  let currency: string | null = null;
  let current: Record<string, string> | null = null;
  let rowIndex = 0;
  // v1.13.0 fix round 2 (reviewer finding, Important): a repeated FITID reaching commitImport
  // hits transactions_external_id_uq INSIDE the commit transaction and aborts the whole import
  // with a raw throw -- so parseOfx itself must never hand commit two rows sharing one FITID.
  // Tracked here (not in commit.ts, which is Task 12's) because "which occurrence wins" is a
  // parsing decision, not a commit one: the FIRST occurrence is kept, exactly like a CSV
  // preset's own descCols/amountCol would keep whatever a person actually meant.
  const seenExternalIds = new Set<string>();

  for (const tag of tags) {
    if (tag.name === 'CURDEF' && tag.value.length > 0 && currency === null) {
      currency = tag.value.toUpperCase();
      continue;
    }
    if (tag.name === 'STMTTRN') {
      if (!tag.closing) current = {};
      else if (current !== null) {
        const record = current;
        current = null;
        const cells = [record.DTPOSTED ?? '', record.NAME ?? '', record.TRNAMT ?? '', record.FITID ?? ''];
        const date = toIsoDate(record.DTPOSTED ?? '');
        const description = [record.NAME ?? '', record.MEMO ?? ''].map((part) => part.trim()).filter(Boolean).join(' ');
        const amountCents = parseAmountToCents(record.TRNAMT ?? '');
        const externalId = (record.FITID ?? '').trim() || null;
        if (date === null) {
          errors.push({ rowIndex, cells, reason: 'unparseable date' });
        } else if (description.length === 0) {
          errors.push({ rowIndex, cells, reason: 'missing description' });
        } else if (amountCents === null) {
          errors.push({ rowIndex, cells, reason: 'unparseable amount' });
        } else if (externalId !== null && seenExternalIds.has(externalId)) {
          errors.push({ rowIndex, cells, reason: `duplicate external id ${externalId}` });
        } else {
          if (externalId !== null) seenExternalIds.add(externalId);
          rows.push({
            rowIndex,
            // The bank's own string, kept verbatim: dedupHash trims it and nothing else reads it.
            rawDate: (record.DTPOSTED ?? '').slice(0, 8),
            date,
            rawDescription: description,
            // OFX signs a debit negative itself, so there is no sign convention to ask a person
            // about -- which is one of the two reasons this format is worth supporting at all.
            amountCents,
            // No running balance per row in OFX. <LEDGERBAL> is one balance for the whole file and
            // deliberately not read: recordBalanceSnapshot keys on (account, date), and one figure
            // whose date is the download time is not a statement date's closing balance.
            balanceCents: null,
            externalId,
            cells,
          });
        }
        rowIndex += 1;
      }
      continue;
    }
    if (current !== null && !tag.closing && tag.value.length > 0) current[tag.name] = tag.value;
  }

  // v1.13.0 fix round 2 (reviewer finding, Important): a truncated download (the file simply
  // stops mid-<STMTTRN>, no closing tag at all) used to be silently dropped -- `current` would
  // still be non-null when the tag loop ends, and nothing ever reported it. Whatever fields DID
  // arrive before the cut are surfaced in `cells` the same way any other row error's cells are.
  if (current !== null) {
    const record = current;
    const cells = [record.DTPOSTED ?? '', record.NAME ?? '', record.TRNAMT ?? '', record.FITID ?? ''];
    errors.push({ rowIndex, cells, reason: 'statement ended mid-transaction' });
  }

  const first = rows.at(0)?.date;
  const last = rows.at(-1)?.date;
  const dateOrder: ParseResult['dateOrder'] =
    first !== undefined && last !== undefined && last < first ? 'newest_first' : 'oldest_first';

  return { rows, errors, currency, dialect, dateOrder, encoding };
}
