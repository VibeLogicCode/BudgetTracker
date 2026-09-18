/**
 * Finding the figures on a statement, without knowing which lender wrote it.
 *
 * RULING S1, AND THE WHOLE POINT: this PRE-FILLS a form. It never writes an anchor. A balance
 * scraped from an arbitrary PDF and saved unconfirmed would corrupt the one figure the app states
 * without qualification -- the movement between two confirmed statements -- so a person confirms
 * every one of these before it becomes anything.
 *
 * RULING S7: keyword proximity, NOT per-lender templates. A template per bank is a maintenance
 * burden that silently rots when a lender redesigns its statement, and it fails closed in the worst
 * way: confidently, with the wrong number. Scoring every money token by the words nearest it
 * degrades honestly instead -- a statement it half-understands offers several candidates and lets a
 * person pick, and one it cannot read at all offers none and says so.
 *
 * Every candidate carries the text around it, because "$312.00" means nothing on its own and
 * "Minimum payment due $312.00" tells a reader instantly why not to pick it.
 */

/** A figure found in the text, with enough context for a person to judge it. */
export interface Candidate {
  /** Cents. Always positive: a statement balance is a magnitude. */
  valueCents: number;
  /** ~40 characters around the match, for the chip under the field. */
  snippet: string;
  /** Higher is a better match. Only the ordering matters. */
  score: number;
}

export interface DateCandidate {
  /** ISO. */
  date: string;
  snippet: string;
  score: number;
}

export interface StatementCandidates {
  balance: Candidate[];
  statementDate: DateCandidate[];
  interest: Candidate[];
}

/**
 * The words lenders actually print, English and French -- this app is used in Canada, where a
 * statement may be either, and a French-only statement offering no candidates at all would look
 * like the feature was broken rather than unimplemented.
 *
 * Deliberately a flat list rather than per-lender sets: adding a phrase helps every lender that
 * uses it, and none of them is a special case.
 */
const BALANCE_WORDS = [
  'closing balance',
  'new balance',
  'current balance',
  'principal balance',
  'balance owing',
  'outstanding balance',
  'total balance',
  'balance due',
  'amount owing',
  'solde',
  'solde de cloture',
  'solde impaye',
];

const DATE_WORDS = ['statement date', 'statement period', 'as of', 'closing date', 'date du releve', 'periode'];

const INTEREST_WORDS = [
  'interest charged',
  'interest this period',
  'interest for this period',
  'finance charge',
  'total interest',
  'interet',
  'interets',
];

/**
 * Words that mean a figure is definitely NOT the balance. Scored negatively rather than filtered,
 * so a line that says both still competes on the strength of its other words -- but a line that
 * says only "minimum payment" loses to one that says "closing balance".
 */
const NOT_BALANCE_WORDS = [
  'minimum payment',
  'payment due',
  'available credit',
  'credit limit',
  'paiement minimum',
  'limite de credit',
];

/** Accents folded and case dropped, so "Intérêts" matches "interets" without a table per accent. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const SNIPPET_RADIUS = 40;

function snippetAround(text: string, at: number, length: number): string {
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + length + SNIPPET_RADIUS);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

/**
 * ONE LINE IS THE WINDOW, and that is the whole scoring model.
 *
 * A statement is a table. The label and its figure share a line -- "Closing balance  $199,913.15"
 * -- and a label on the line BELOW belongs to a different row. An earlier version of this scored a
 * character window instead, and on a real mortgage statement it read "Closing balance" from the
 * next line and confidently proposed the interest figure as the balance. Lines are not a
 * simplification here; they are what a statement actually is.
 */
function scoreLine(foldedLine: string, wanted: string[], against: string[]): number {
  let score = 0;
  for (const word of wanted) if (foldedLine.includes(word)) score += 10;
  for (const word of against) if (foldedLine.includes(word)) score -= 12;
  return score;
}

/**
 * Amounts as a statement prints them, in both conventions this app meets:
 *   1,234.56 / $1,234.56 / 1234.56     English
 *   2 550,00 $ / 2.550,00              French, where the roles of comma and point are swapped
 *
 * A bare integer is deliberately NOT money: on a statement it is far more often a page number, an
 * account digit or part of a date, and offering those as candidates would bury the real figures.
 */
const MONEY = /\(?\$?\s?(\d{1,3}(?:[ ,.]\d{3})+|\d+)([.,]\d{2})\)?\s?\$?/g;

function centsFrom(whole: string, fraction: string): number | null {
  const digits = whole.replace(/[ ,.]/g, '');
  const cents = Number(digits) * 100 + Number(fraction.slice(1));
  return Number.isFinite(cents) ? cents : null;
}

/** Dates as a statement prints them: 2026-09-01, 01/09/2026, 1 Sep 2026, Sep 1, 2026. */
const DATES: { pattern: RegExp; toIso: (match: RegExpMatchArray) => string | null }[] = [
  { pattern: /(\d{4})-(\d{2})-(\d{2})/g, toIso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  {
    // Ambiguous by nature (is 01/09 January or September?). Offered as a candidate with the text
    // around it, and a person decides -- which is the design, not a shortcoming.
    pattern: /(\d{2})\/(\d{2})\/(\d{4})/g,
    toIso: (m) => `${m[3]}-${m[2]}-${m[1]}`,
  },
  {
    pattern: /(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/gi,
    toIso: (m) => isoFromMonthName(m[3]!, m[2]!, m[1]!),
  },
  {
    pattern: /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/gi,
    toIso: (m) => isoFromMonthName(m[3]!, m[1]!, m[2]!),
  },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoFromMonthName(year: string, month: string, day: string): string | null {
  const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (index < 0) return null;
  return `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function bestFirst<T extends { score: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.score - a.score);
}

/**
 * Every plausible figure in a statement's text, best first.
 *
 * Returns candidates, never a decision. Two equally-scored candidates pre-fill NOTHING (see
 * prefill below): a coin toss between two figures is worse than asking, because it looks like
 * knowledge.
 */
export function findStatementCandidates(text: string): StatementCandidates {
  const balance: Candidate[] = [];
  const interest: Candidate[] = [];
  const statementDate: DateCandidate[] = [];

  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const folded = fold(line);
    const balanceScore = scoreLine(folded, BALANCE_WORDS, NOT_BALANCE_WORDS);
    const interestScore = scoreLine(folded, INTEREST_WORDS, []);
    const dateScore = scoreLine(folded, DATE_WORDS, []);

    if (balanceScore > 0 || interestScore > 0) {
      for (const match of line.matchAll(MONEY)) {
        const cents = centsFrom(match[1]!, match[2]!);
        if (cents === null) continue;
        const at = offset + (match.index ?? 0);
        const snippet = snippetAround(text, at, match[0].length);
        if (balanceScore > 0) balance.push({ valueCents: cents, snippet, score: balanceScore });
        if (interestScore > 0) interest.push({ valueCents: cents, snippet, score: interestScore });
      }
    }

    if (dateScore > 0) {
      for (const { pattern, toIso } of DATES) {
        for (const match of line.matchAll(pattern)) {
          const iso = toIso(match);
          if (iso === null || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
          const month = Number(iso.slice(5, 7));
          const day = Number(iso.slice(8, 10));
          if (month < 1 || month > 12 || day < 1 || day > 31) continue;
          statementDate.push({
            date: iso,
            snippet: snippetAround(text, offset + (match.index ?? 0), match[0].length),
            score: dateScore,
          });
        }
      }
    }

    offset += line.length + 1;
  }

  return { balance: bestFirst(balance), statementDate: bestFirst(statementDate), interest: bestFirst(interest) };
}

/**
 * The one candidate to pre-fill, or null.
 *
 * Null when nothing was found AND when the top two are tied: a tie means the text gave no reason to
 * prefer either, and filling one in anyway would present a guess as a reading. The field is left
 * empty and both appear as chips.
 */
export function prefill<T extends { score: number }>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return null;
  return candidates[0]!;
}
