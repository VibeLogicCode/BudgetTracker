/**
 * Reading a statement that arrived as a spreadsheet (ledger spec S1–S3).
 *
 * The owner's choice: detect the columns, and show a picker only when detection is unsure or the
 * person disagrees. A lender's export keeps its shape month to month, so the confirmed mapping is
 * remembered against the loan and the picker becomes a fallback rather than a monthly chore.
 *
 * Like the PDF reader beside it, this NEVER writes anything. It returns figures for a form to be
 * filled in with, and a person presses the button (ruling S1). A balance scraped from an arbitrary
 * file and saved unconfirmed would corrupt the one number the app states without qualification.
 */
import Papa from 'papaparse';
import { parseAmountToCents } from '@/lib/money';

export interface StatementColumns {
  date: string | null;
  balance: string | null;
  interest: string | null;
}

export interface DetectedColumns {
  headers: string[];
  mapping: StatementColumns;
  /** Both a date and a balance were found. False means show the picker (S2). */
  confident: boolean;
}

/**
 * What lenders call these columns, English and French. Flat lists rather than per-lender sets: a
 * phrase added here helps every export that uses it, and none of them is a special case.
 */
const DATE_WORDS = ['date', 'posted', 'transaction date', 'posting date', 'date de', 'date du'];

const BALANCE_WORDS = [
  'balance',
  'running balance',
  'closing balance',
  'new balance',
  'statement balance',
  'principal balance',
  'solde',
];

const INTEREST_WORDS = ['interest', 'interest charged', 'finance charge', 'interet', 'interets'];

/**
 * Headings that look like money and are NOT the balance. Scored against rather than filtered, so a
 * heading that says both still competes -- but "Minimum payment" alone never wins over "Balance".
 */
const NOT_BALANCE_WORDS = ['minimum', 'payment due', 'available', 'limit', 'paiement', 'limite'];

/** Accents folded and case dropped, so "Intérêts" matches "interets" without a table per accent. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function score(heading: string, wanted: string[], against: string[]): number {
  const folded = fold(heading);
  if (folded.length === 0) return 0;
  let total = 0;
  for (const word of wanted) if (folded.includes(word)) total += word.length;
  for (const word of against) if (folded.includes(word)) total -= 40;
  return total;
}

function bestHeading(headers: string[], wanted: string[], against: string[]): string | null {
  let best: { heading: string; points: number } | null = null;
  for (const heading of headers) {
    const points = score(heading, wanted, against);
    if (points <= 0) continue;
    if (best === null || points > best.points) best = { heading, points };
  }
  return best?.heading ?? null;
}

function rowsOf(text: string): string[][] {
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  return parsed.data.filter((row) => Array.isArray(row));
}

export function detectStatementColumns(text: string): DetectedColumns {
  const rows = rowsOf(text);
  const headers = (rows[0] ?? []).map((cell) => cell.trim());
  if (headers.length === 0) {
    return { headers: [], mapping: { date: null, balance: null, interest: null }, confident: false };
  }
  const mapping: StatementColumns = {
    date: bestHeading(headers, DATE_WORDS, []),
    balance: bestHeading(headers, BALANCE_WORDS, NOT_BALANCE_WORDS),
    interest: bestHeading(headers, INTEREST_WORDS, []),
  };
  return { headers, mapping, confident: mapping.date !== null && mapping.balance !== null };
}

/**
 * Money as a statement prints it, in both conventions this app meets.
 *
 * parseAmountToCents treats a comma as a thousands separator, which is right for "1,234.56" and
 * badly wrong for "2 550,00 $" -- it would read a quarter of a million. So the French convention is
 * recognised first (a comma with exactly two digits after it and no point later) and rewritten into
 * the form the shared parser already understands.
 */
function moneyToCents(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const french = /,\d{2}\s*\$?$/.test(text) && !text.includes('.');
  const normalised = french ? text.replace(/[\s. ]/g, '').replace(',', '.') : text;
  const cents = parseAmountToCents(normalised);
  return cents === null ? null : Math.abs(cents);
}

/** ISO first, then the two orderings a spreadsheet exports. Ambiguity is left to the person. */
function toIsoDate(raw: string): string | null {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (slashed) {
    const [, a, b, year] = slashed;
    // Day-first unless the first number cannot be a day, which is the commoner Canadian export.
    const day = Number(a) > 12 ? a : b;
    const month = Number(a) > 12 ? b : a;
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }
  return null;
}

export interface StatementFigures {
  statementDate: string;
  balanceCents: number;
  /** The interest the statement PRINTED, summed over its rows. Null when no column was mapped. */
  interestCents: number | null;
  /** The first few rows, so the picker can show what it is choosing between. */
  preview: string[][];
}

/**
 * The statement's own figures, from the columns a person confirmed.
 *
 * The chronologically LAST dated row is the statement: a running-balance export ends on the figure
 * the lender is telling you about, and taking the last row in file order would trust the export's
 * sort instead of its dates.
 */
export function readStatementCsv(text: string, mapping: StatementColumns): StatementFigures | null {
  if (mapping.date === null || mapping.balance === null) return null;
  const rows = rowsOf(text);
  const headers = (rows[0] ?? []).map((cell) => cell.trim());
  const dateAt = headers.indexOf(mapping.date);
  const balanceAt = headers.indexOf(mapping.balance);
  const interestAt = mapping.interest === null ? -1 : headers.indexOf(mapping.interest);
  if (dateAt < 0 || balanceAt < 0) return null;

  const body = rows.slice(1);
  let newest: { date: string; balanceCents: number } | null = null;
  let interestTotal = 0;
  let sawInterest = false;

  for (const row of body) {
    const date = toIsoDate(row[dateAt] ?? '');
    if (date === null) continue;
    if (interestAt >= 0) {
      const charged = moneyToCents(row[interestAt] ?? '');
      if (charged !== null) {
        interestTotal += charged;
        sawInterest = true;
      }
    }
    const balance = moneyToCents(row[balanceAt] ?? '');
    if (balance === null) continue;
    if (newest === null || date >= newest.date) newest = { date, balanceCents: balance };
  }
  if (newest === null) return null;

  return {
    statementDate: newest.date,
    balanceCents: newest.balanceCents,
    interestCents: interestAt >= 0 && sawInterest ? interestTotal : null,
    preview: body.slice(0, 5),
  };
}
