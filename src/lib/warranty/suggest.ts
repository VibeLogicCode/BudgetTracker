import { addMonthsClamped, isIsoDate } from '@/lib/dates';
import { parseAmountToCents } from '@/lib/money';

/**
 * Suggest-and-confirm (spec §8). Every extractor here is PURE: no I/O, no DB, and no clock
 * beyond the injected `today`, so the tests are deterministic. MUST-8.1: nothing here ever
 * auto-commits — the caller pre-fills form inputs the user can overwrite.
 */
export interface SuggestedFields {
  purchaseDate?: string;
  vendor?: string;
  priceCents?: number;
  /** Spec 2026-09-30 §2.3. A bill's due date, which may be in the future. */
  dueDate?: string;
}

/** Spec 2026-09-30 §2.3. A figure or a date with enough context for a person to judge it. */
export interface AmountCandidate { valueCents: number; snippet: string; score: number }
export interface DateCandidate { date: string; snippet: string; score: number }

/** §8.3 step 5: a mis-read barcode or phone number must not present as a nine-figure total. */
export const MAX_SUGGESTED_PRICE_CENTS = 10_000_000;
export const MAX_SUGGESTION_AGE_MONTHS = 240;
export const MAX_VENDOR_CHARS = 60;
export const MAX_CANDIDATES = 6;
export const MAX_DUE_DATE_MONTHS_AHEAD = 18;
export const MAX_DUE_DATE_MONTHS_BEHIND = 12;

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string | null {
  const candidate = `${y}-${pad2(m)}-${pad2(d)}`;
  return isIsoDate(candidate) ? candidate : null;
}

interface DateHit {
  index: number;
  /** Characters the date occupies in the text, for the snippet around it. */
  length: number;
  iso: string;
}

/**
 * Every valid calendar date in the text, in TEXT ORDER, with no bound on today: each caller
 * applies its own window (a purchase date is never in the future, a due date often is).
 */
function collectDateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const value = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (value) hits.push({ index: m.index ?? 0, length: m[0].length, iso: value });
  }

  // A/B/YYYY or A-B-YY. §8.1 step 3 ladder: A>12 -> DD/MM; else B>12 -> MM/DD; else MM/DD.
  for (const m of text.matchAll(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2}|\d{4})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const rawYear = Number(m[3]);
    const year = m[3].length === 2 ? 2000 + rawYear : rawYear;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    const value = iso(year, month, day);
    if (value) hits.push({ index: m.index ?? 0, length: m[0].length, iso: value });
  }

  // DD Mon YYYY (the shape the Amex export already uses, base §3).
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{4})\b/g)) {
    const month = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[1]));
    if (value) hits.push({ index: m.index ?? 0, length: m[0].length, iso: value });
  }

  // Mon D, YYYY
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].slice(0, 3).toUpperCase()];
    if (!month) continue;
    const value = iso(Number(m[3]), month, Number(m[2]));
    if (value) hits.push({ index: m.index ?? 0, length: m[0].length, iso: value });
  }

  // Stable, so two shapes at one index keep the order above.
  return hits.sort((a, b) => a.index - b.index);
}

export function suggestPurchaseDate(text: string, today: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const floor = addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS);
  const survivors = collectDateHits(text)
    .filter((hit) => hit.iso <= today && hit.iso >= floor)
    // §8.1 step 4: earliest OCCURRENCE in the text (receipt headers print the
    // transaction date before any expiry or promo date). Ties break on first match.
    .sort((a, b) => a.index - b.index);
  return survivors[0]?.iso;
}

const VENDOR_SKIP_RE = /^(receipt|invoice|order|tel|phone|fax|www\.|https?:|\d)/i;

export function suggestVendor(text: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  for (const line of lines) {
    const letters = line.match(/\p{L}/gu)?.length ?? 0;
    if (letters < 3) continue;
    if (VENDOR_SKIP_RE.test(line)) continue;
    return line.slice(0, MAX_VENDOR_CHARS);
  }
  return undefined;
}

// Digit run bounded to 9 (not `\d+`) to prevent quadratic backtracking on a long unbroken
// digit run (garbled barcode OCR): an unbounded `\d+` alternative backtracks O(L) at each of
// L start positions, i.e. O(L^2) on the ~100k-char OCR cap. No valid amount is lost — a
// 10+-digit whole-dollar amount already exceeds the $100,000 ceiling and is rejected by
// centsOf() regardless (amended after Task 4 review; spec §8.3 step 3 mirrors this).
const CURRENCY_RE = /(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d{1,9})[.,](\d{2})(?!\d)/g;
/** Fuzzy on purpose: PP-OCR reads T0TAL and IOTAL for TOTAL often enough to matter. French for bilingual bills. */
const TOTAL_LINE_RE = /\b(t[o0]tal|[ti1]otal|amount\s+due|grand\s+total|balance\s+due|total\s+due|montant|solde)\b/i;
const SUBTOTAL_RE = /\bsub[\s-]?total\b|\bsous[\s-]?total\b/i;
/*
 * The patterns below that carry French use letter/number lookarounds, not `\b`: `\b` is
 * ASCII-only, and in "d'échéance" both the apostrophe and the é are non-word characters, so
 * `\béchéance` never matches. The `u` flag makes `\p{L}` work and folds É to é under `i`.
 */
/**
 * A line about how the bill was PAID is never the total, whatever else it says. "Payment due"
 * is what is owed, not what was paid, so "Total payment due $85.00" stays a total line.
 */
const PAYMENT_LINE_RE = /(?<![\p{L}\p{N}_])(cash|change|tender(?:ed)?|tip|gratuity|approved|payments?(?!\s+due)|cash\s*back|visa|mastercard|amex|debit|interac|paiements?|comptant|monnaie|remis)(?![\p{L}\p{N}_])/iu;
/**
 * A late-fee line ("Amount due after due date $328.06") is never the total either. Specific on
 * purpose, not a bare "after", so "Total after discount" stays a total line.
 */
const LATE_FEE_RE = /(?<![\p{L}\p{N}_])(after\s+(?:the\s+)?due\s+date|late\s+(?:fee|charge|payment)s?|past\s+due|overdue|penalt(?:y|ies)|frais\s+de\s+retard|apr[èe]s\s+(?:la\s+)?date\s+d['’]\s*[ée]ch[ée]ance|p[ée]nalit[ée]s?)(?![\p{L}\p{N}_])/iu;
const TAX_LINE_RE = /\b(hst|gst|pst|tax|tvq|tps)\b/i;
const DUE_LINE_RE = /(?<![\p{L}\p{N}_])(due\s+date|date\s+due|due\s+by|due\s+on|payable\s+by|pay\s+by|[ée]ch[ée]ance)(?![\p{L}\p{N}_])/iu;
/** The second tier: a bare "due", read only when no line in the text names the due date outright. */
const BARE_DUE_RE = /(?<![\p{L}\p{N}_])due(?![\p{L}\p{N}_])/iu;

function isTotalLine(line: string): boolean {
  return TOTAL_LINE_RE.test(line) && !SUBTOTAL_RE.test(line) && !PAYMENT_LINE_RE.test(line) && !LATE_FEE_RE.test(line);
}

function centsOf(whole: string, fraction: string): number | null {
  // One money parser in the app (MUST-13.5): integer cents, no floats.
  const cents = parseAmountToCents(`${whole}.${fraction}`);
  if (cents === null) return null;
  const magnitude = Math.abs(cents);
  if (magnitude <= 0 || magnitude >= MAX_SUGGESTED_PRICE_CENTS) return null;
  return magnitude;
}

export function suggestPriceCents(text: string): number | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  // The LAST qualifying line, and the last valid figure on it. No fallback: with no total line
  // there is no total, and a blank field a person fills beats a confident wrong one (PENDING-FIXES
  // item G, now adopted). "Confidently wrong is the worst output a suggester can produce."
  // A total line with no valid figure ("TOTAL NUMBER OF ITEMS SOLD = 5") steps back to the one
  // before it, and an invalid last figure (over the noise ceiling) to the one before it on the line.
  const totalLines = text.split(/\r?\n/).filter(isTotalLine);
  for (let l = totalLines.length - 1; l >= 0; l -= 1) {
    const matches = [...totalLines[l].matchAll(CURRENCY_RE)];
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const cents = centsOf(matches[i][1], matches[i][2]);
      if (cents !== null) return cents;
    }
  }
  return undefined;
}

/** Where the phrase ends on the line, or -1 when the line does not carry it. */
function phraseEnd(phrase: RegExp, line: string): number {
  const match = phrase.exec(line);
  return match === null ? -1 : match.index + match[0].length;
}

/**
 * The in-range date on a due line, preferring the first one AFTER the phrase: a joined
 * two-column line ("Bill date: Sep 15, 2026     Due date: Oct 15, 2026") carries the other
 * column's date first. With nothing after the phrase, the first in-range date on the line.
 */
function dueDateOnLine(line: string, phrase: RegExp, floor: string, ceiling: string): string | undefined {
  const end = phraseEnd(phrase, line);
  if (end < 0) return undefined;
  const inRange = collectDateHits(line).filter((d) => d.iso >= floor && d.iso <= ceiling);
  return (inRange.find((d) => d.index >= end) ?? inRange[0])?.iso;
}

export function suggestDueDate(text: string, today: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const floor = addMonthsClamped(today, -MAX_DUE_DATE_MONTHS_BEHIND);
  const ceiling = addMonthsClamped(today, MAX_DUE_DATE_MONTHS_AHEAD);
  const lines = text.split(/\r?\n/);
  // Tier 1: a line that names the due date outright. Tier 2, only when tier 1 found nothing: a
  // bare "due" ("Due Oct 31, 2026"), but never a late-fee line ("Past due 2026-08-01").
  for (const line of lines) {
    const found = dueDateOnLine(line, DUE_LINE_RE, floor, ceiling);
    if (found !== undefined) return found;
  }
  for (const line of lines) {
    if (LATE_FEE_RE.test(line)) continue;
    const found = dueDateOnLine(line, BARE_DUE_RE, floor, ceiling);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Context kept either side of a candidate, so a long joined line still shows the figure itself. */
const SNIPPET_SIDE_CHARS = 28;
const squash = (s: string) => s.replace(/\s+/g, ' ');

/**
 * Raw characters read either side of a hit before whitespace is collapsed. A bounded slice, not
 * the rest of the line: a crafted one-line PDF is 100k characters, and a whole-line pass per hit
 * made that quadratic. Four times the side is plenty for any real read, whose words are joined by
 * single spaces, so the snippet comes out the same.
 */
const SNIPPET_RAW_CHARS = 4 * SNIPPET_SIDE_CHARS;

/**
 * The words around a hit: up to SNIPPET_SIDE_CHARS either side of it, whitespace collapsed (a
 * receipt's column spacing would otherwise eat the window), and a word the window cut in two
 * dropped rather than shown as a fragment.
 */
function snippetAround(line: string, index: number, length: number): string {
  let before = squash(line.slice(Math.max(0, index - SNIPPET_RAW_CHARS), index));
  if (before.length > SNIPPET_SIDE_CHARS) {
    const cut = before.length - SNIPPET_SIDE_CHARS;
    const cutMidWord = !/\s/.test(before[cut - 1]);
    before = before.slice(cut);
    if (cutMidWord) before = before.replace(/^\S+/, '');
  }
  let after = squash(line.slice(index + length, index + length + SNIPPET_RAW_CHARS));
  if (after.length > SNIPPET_SIDE_CHARS) {
    const cutMidWord = !/\s/.test(after[SNIPPET_SIDE_CHARS]);
    after = after.slice(0, SNIPPET_SIDE_CHARS);
    if (cutMidWord) after = after.replace(/\S+$/, '');
  }
  return `${before}${squash(line.slice(index, index + length))}${after}`.trim();
}

export function amountCandidates(text: string): AmountCandidate[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // `line` is the tie-break: on equal scores the LATER line ranks first, as the last total line
  // wins in suggestPriceCents. It is dropped from what is returned.
  const best = new Map<number, AmountCandidate & { line: number }>();
  text.split(/\r?\n/).forEach((line, lineIndex) => {
    const matches = [...line.matchAll(CURRENCY_RE)];
    if (matches.length === 0) return;
    // What the line says is the same for every figure on it, so it is read once per line.
    let lineScore = 0;
    if (isTotalLine(line)) lineScore += 3;
    if (PAYMENT_LINE_RE.test(line)) lineScore -= 3;
    if (LATE_FEE_RE.test(line)) lineScore -= 3;
    if (SUBTOTAL_RE.test(line) || TAX_LINE_RE.test(line)) lineScore -= 2;
    matches.forEach((m, i) => {
      const cents = centsOf(m[1], m[2]);
      if (cents === null) return;
      let score = lineScore;
      if (i === matches.length - 1) score += 1;
      const prior = best.get(cents);
      if (prior === undefined || score >= prior.score) {
        best.set(cents, { valueCents: cents, snippet: snippetAround(line, m.index ?? 0, m[0].length), score, line: lineIndex });
      }
    });
  });
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.line - a.line || b.valueCents - a.valueCents)
    .slice(0, MAX_CANDIDATES)
    .map(({ valueCents, snippet, score }) => ({ valueCents, snippet, score }));
}

export function dateCandidates(text: string, today: string): DateCandidate[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const floor = addMonthsClamped(today, -MAX_SUGGESTION_AGE_MONTHS);
  const ceiling = addMonthsClamped(today, MAX_DUE_DATE_MONTHS_AHEAD);
  const best = new Map<string, DateCandidate>();
  let first = true;
  for (const line of text.split(/\r?\n/)) {
    // The due-date score goes only to a date after the phrase, as suggestDueDate prefers it.
    const end = phraseEnd(DUE_LINE_RE, line);
    for (const found of collectDateHits(line)) {
      if (found.iso < floor || found.iso > ceiling) continue;
      let score = end >= 0 && found.index >= end ? 3 : 0;
      if (first) score += 1;
      first = false;
      const prior = best.get(found.iso);
      if (prior === undefined || score > prior.score) {
        best.set(found.iso, { date: found.iso, snippet: snippetAround(line, found.index, found.length), score });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, MAX_CANDIDATES);
}

/** A sign or currency the extractor's figure leaves behind: "-$312.44", "$-312.44", "312,44 $", "312.44 CAD". */
const FIGURE_LEAD_RE = /(?:\$\s*)?[-−]\s*$/;
const FIGURE_TRAIL_RE = /^\s*(?:\$|(?:CAD|USD)(?![\p{L}\p{N}_]))/u;
/** Separators and dot leaders left at either side of a cut ("Due date: ", "TOTAL ......"). */
const LABEL_EDGE_START_RE = /^[\s:;,.=|*·–—-]+/;
const LABEL_EDGE_END_RE = /[\s:;,.=|*·–—-]+$/;

/** Where the candidate's own figure sits in its snippet, found with the extractor's own patterns. */
function figureSpan(candidate: AmountCandidate | DateCandidate): [number, number] | null {
  const { snippet } = candidate;
  if ('valueCents' in candidate) {
    for (const m of snippet.matchAll(CURRENCY_RE)) {
      const start = m.index ?? 0;
      if (centsOf(m[1], m[2]) === candidate.valueCents) return [start, start + m[0].length];
    }
    return null;
  }
  const hit = collectDateHits(snippet).find((found) => found.iso === candidate.date);
  return hit === undefined ? null : [hit.index, hit.index + hit.length];
}

/**
 * Spec 2026-09-30 §2.3: the words a candidate's snippet says about it, with the figure itself cut
 * out ("Amount due $312.44" -> "Amount due"), for the receipt tile's row in use. Empty when nothing
 * else is left, and the whole snippet when its figure cannot be found in it. Pure and client-safe.
 */
export function candidateLabel(candidate: AmountCandidate | DateCandidate): string {
  const snippet = candidate.snippet;
  const span = figureSpan(candidate);
  if (span === null) return squash(snippet).trim();
  let [start, end] = span;
  if ('valueCents' in candidate) {
    start -= FIGURE_LEAD_RE.exec(snippet.slice(0, start))?.[0].length ?? 0;
    end += FIGURE_TRAIL_RE.exec(snippet.slice(end))?.[0].length ?? 0;
    // An accounting negative, "(312.44)".
    if (snippet[start - 1] === '(' && snippet[end] === ')') {
      start -= 1;
      end += 1;
    }
  }
  const before = snippet.slice(0, start).replace(LABEL_EDGE_END_RE, '');
  const after = snippet.slice(end).replace(LABEL_EDGE_START_RE, '');
  return squash(`${before} ${after}`).replace(LABEL_EDGE_START_RE, '').replace(LABEL_EDGE_END_RE, '');
}

export function suggestFromOcrText(text: string, today: string): SuggestedFields {
  const out: SuggestedFields = {};
  const purchaseDate = suggestPurchaseDate(text, today);
  if (purchaseDate !== undefined) out.purchaseDate = purchaseDate;
  const vendor = suggestVendor(text);
  if (vendor !== undefined) out.vendor = vendor;
  const priceCents = suggestPriceCents(text);
  if (priceCents !== undefined) out.priceCents = priceCents;
  const dueDate = suggestDueDate(text, today);
  if (dueDate !== undefined) out.dueDate = dueDate;
  return out;
}
