/**
 * The LEARNING normalizer (spec section 4 step 1).
 *
 * This list is expected to grow over time. That is safe: nothing about the
 * dedup hash depends on this file (see src/lib/import/dedup.ts, which is
 * frozen and deliberately does not import from here).
 */
export const CHANNEL_PREFIXES: readonly string[] = [
  'POINT OF SALE PURCHASE',
  'CONTACTLESS INTERAC PURCHASE',
  'INTERAC RETAIL PURCHASE',
  'PREAUTHORIZED PAYMENT',
  'PREAUTHORIZED DEBIT',
  'ELECTRONIC FUNDS TRANSFER',
  'CONTACTLESS PURCHASE',
  'VISA DEBIT PURCHASE',
  'RECURRING PAYMENT',
  'INTERAC PURCHASE',
  'POS PURCHASE',
  'DEBIT PURCHASE',
  'PRE-AUTH PAYMENT',
  'PREAUTHORIZED',
  'MISC PAYMENT',
  'CONTACTLESS',
  'VISA DEBIT',
  'PRE-AUTH',
  'PREAUTH',
  'PURCHASE',
];

export const PROVINCE_CODES: readonly string[] = [
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'PQ', 'QC', 'SK', 'YT',
];

const PREFIXES_BY_LENGTH = [...CHANNEL_PREFIXES].sort((a, b) => b.length - a.length);
const PROVINCE_SET = new Set(PROVINCE_CODES);

// One alnum-character class shared by the prefix/delimiter logic and tokenize().
// Deliberately includes the Latin-1 accented block so café/république/Québec survive.
const ALNUM = 'À-ÖØ-öø-ÿ0-9A-Za-z';
const NON_ALNUM_RUN = new RegExp(`[^${ALNUM}]+`, 'u');
const NON_ALNUM_RUN_CAPTURED = new RegExp(`([^${ALNUM}]+)`, 'u');
const HAS_LETTER = new RegExp(`[A-Za-zÀ-ÖØ-öø-ÿ]`, 'u');

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripPrefixes(text: string): { text: string; stripped: boolean } {
  let current = text;
  let stripped = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PREFIXES_BY_LENGTH) {
      if (current === prefix) return { text: current, stripped };
      if (current.startsWith(`${prefix} `)) {
        current = current.slice(prefix.length + 1).trimStart();
        stripped = true;
        changed = true;
        break;
      }
    }
  }
  return { text: current, stripped };
}

function digitCount(token: string): number {
  let count = 0;
  for (const character of token) {
    if (character >= '0' && character <= '9') count += 1;
  }
  return count;
}

/**
 * Strips store-number and reference-number *fragments* out of a single
 * whitespace-delimited token, without disturbing punctuation that is part of
 * the merchant's actual name (e.g. "PETRO-CANADA", "HYDRO-QUÉBEC", "C/C").
 *
 * The token is split into alternating alnum/delimiter parts (capturing split).
 * Each alnum part is judged independently:
 *   - a bare digit run of 5+ ("12345")            -> dropped
 *   - a mixed alnum part with 5+ digits and a letter ("RT4XY9083") -> dropped
 *   - digits immediately preceded by a literal "#" ("#1042" -> "1042") -> dropped
 * When a part is dropped, its adjacent delimiter is dropped with it so no
 * orphaned punctuation (a stray "*" or "#") is left behind.
 */
function stripWithinToken(token: string): string {
  const parts = token.split(NON_ALNUM_RUN_CAPTURED);
  const kept: boolean[] = new Array(parts.length).fill(true);

  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    if (part.length === 0) continue;

    const isStoreDigits = i > 0 && parts[i - 1] === '#' && /^\d+$/.test(part);
    const isDigitRun = /^\d{5,}$/.test(part);
    const isReferenceToken = !isDigitRun && digitCount(part) >= 5 && HAS_LETTER.test(part);

    if (isStoreDigits || isDigitRun || isReferenceToken) {
      kept[i] = false;
      if (i > 0) kept[i - 1] = false; // the delimiter immediately before this part
    }
  }
  // A delimiter whose following part survived but whose preceding part didn't
  // is already handled above; also drop a delimiter whose following part died.
  for (let i = 1; i < parts.length; i += 2) {
    if (kept[i] && i + 1 < parts.length && !kept[i + 1]) kept[i] = false;
  }

  return parts.filter((_, index) => kept[index]).join('');
}

export function normalizeMerchant(raw: string): string {
  const base = collapse(raw.normalize('NFC').toUpperCase());
  if (base.length === 0) return '';

  const { text: afterPrefix, stripped } = stripPrefixes(base);
  let tokens = afterPrefix.split(' ').filter((token) => token.length > 0);

  // Terminal ids that immediately follow a stripped channel prefix.
  if (stripped) {
    while (tokens.length > 1 && /^\d+$/.test(tokens[0])) tokens.shift();
  }

  // Store numbers, digit runs, and reference tokens.
  const cleaned: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === 'STORE' || token === 'UNIT') {
      if (index + 1 < tokens.length && /^#?\d+$/.test(tokens[index + 1])) index += 1;
      continue; // the STORE/UNIT marker itself is never part of a merchant name
    }
    if (token === '#' && index + 1 < tokens.length && /^\d+$/.test(tokens[index + 1])) {
      index += 1;
      continue;
    }

    const strippedToken = stripWithinToken(token);
    if (strippedToken.length > 0) cleaned.push(strippedToken);
  }
  tokens = cleaned;

  // Trailing CITY PROVINCE tail.
  if (tokens.length >= 2 && PROVINCE_SET.has(tokens[tokens.length - 1])) {
    tokens.pop();
    if (tokens.length >= 2) tokens.pop();
  }

  const result = collapse(tokens.join(' '));
  return result.length > 0 ? result : base;
}

/** Multinomial Bayes needs the token multiset, so duplicates are preserved. */
export function tokenize(normalizedMerchant: string): string[] {
  return normalizedMerchant
    .split(NON_ALNUM_RUN)
    .map((token) => token.toUpperCase())
    .filter((token) => token.length > 1 && !/^\d+$/.test(token));
}

/**
 * v1.25.0 (backlog item 16). The token definition behind matchRule's 'word' match type
 * (src/lib/categorize/rules.ts). It lives HERE, immediately below tokenize(), and not next to
 * matchRule, for one reason: both functions are opinions about where a word ends in
 * normalizeMerchant()'s own output, and the ALNUM class above is the shared premise of all three.
 * Split them across two files and the next person to widen ALNUM (the accented block was added
 * for café/Québec) fixes one caller and silently breaks the other.
 *
 * THE SEPARATOR, stated explicitly because it IS the feature: a token boundary is any run of one
 * or more characters that is neither alphanumeric (ALNUM, accents included) NOR an apostrophe
 * (') NOR an ampersand (&).
 *
 * Why those two characters stay INSIDE a token while '-', '/', '.', '#', '*' and every other
 * punctuation mark break one -- an asymmetry that looks arbitrary and is not:
 *
 *   - ' and & occur INSIDE a brand's own single word. normalizeMerchant deliberately preserves
 *     both (see stripWithinToken, and the "apostrophes survive" assertion in
 *     tests/ops/canadian-merchants-pack.test.ts), so LOWE'S, HARVEY'S, A&W and M&M arrive here
 *     intact. Keeping them in means "LOWE'S" is the single token LOWE'S -- so a rule whose
 *     pattern is LOWE'S matches it, and a rule whose pattern is LOWE does NOT, because LOWE is a
 *     different token, not a prefix of a shorter one. That single discrimination is the whole
 *     reason this match type exists: `contains LOWE` matching FLOWERS is the v1.22.0 defect
 *     (backlog item 16), and a boundary that split LOWE'S into LOWE + S would hand the same trap
 *     straight back.
 *   - '-', '/', '.', '#' and friends are JOINERS the bank puts BETWEEN separate words:
 *     PETRO-CANADA, KFC/TACO BELL, WWW.MERCHANT.COM. Treating them as boundaries is what makes
 *     `word KFC` actually match KFC/TACO BELL instead of merely being safe by matching nothing --
 *     "prefer a miss over a false positive" (this pack's governing principle) is a tie-breaker,
 *     not a reason to prefer a miss when there is no false positive on offer.
 *
 * Punctuation-only tokens (the lone '&' in "MAXI & CIE") are KEPT rather than filtered. They can
 * only ever be matched by an equally pathological pattern, and keeping them is what makes the
 * consecutive-run check honest: pattern "MAXI CIE" must NOT match "MAXI & CIE", because the
 * merchant text has a word between the two.
 *
 * Deliberately NOT tokenize(): that one folds case, drops single characters and drops pure-digit
 * runs because multinomial Bayes wants a feature bag. Every one of those three would be a defect
 * here -- it would make pattern F45 unmatchable, make A&W's own "A" vanish, and fold case that
 * matchRule documents itself as never folding (see v1.21.0 item 9: patterns are uppercased once
 * at the write choke point precisely so no reader has to fold).
 */
const WORD_BOUNDARY_RUN = new RegExp(`[^${ALNUM}'&]+`, 'u');

export function wordBoundaryTokens(text: string): string[] {
  return text.split(WORD_BOUNDARY_RUN).filter((token) => token.length > 0);
}
