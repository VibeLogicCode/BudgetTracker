import { describe, it, expect } from 'vitest';
import { MAX_STATEMENT_LINE_CHARS, findStatementCandidates, prefill } from '@/lib/loans/statement-extract';

/**
 * Ruling S7. Candidates by keyword proximity, never per-lender templates -- a template rots
 * silently when a bank redesigns its statement, and it fails confidently rather than visibly.
 *
 * The statements below are synthetic and deliberately awkward: every one carries figures that are
 * NOT the balance, which is the whole difficulty. A reader glancing at a mortgage statement sees
 * four dollar amounts and knows instantly which is which; a scoring function has to be told.
 */
const MORTGAGE = `
FIRST NATIONAL BANK
Mortgage statement

Statement date: 2026-09-01
Account number 123456789

Previous balance            $200,462.11
Payments received            $1,800.00
Interest charged this period $1,251.04
Closing balance             $199,913.15

Minimum payment due          $1,800.00
`;

const CARD = `
Statement date  09/01/2026
Credit limit                $10,000.00
Available credit             $7,450.00
New balance                  $2,550.00
Minimum payment due             $75.00
`;

const FRENCH = `
Date du releve : 2026-09-01
Solde de cloture              2 550,00 $
Paiement minimum                 75,00 $
`;

describe('findStatementCandidates: the balance', () => {
  it('prefers the closing balance over every other figure on the page', () => {
    const best = prefill(findStatementCandidates(MORTGAGE).balance);
    expect(best?.valueCents).toBe(19_991_315);
  });

  /** The trap this exists to avoid: a minimum payment is a dollar figure too. */
  it('does not offer the minimum payment as the balance', () => {
    const candidates = findStatementCandidates(MORTGAGE).balance;
    expect(candidates.some((candidate) => candidate.valueCents === 180_000)).toBe(false);
  });

  it('does not mistake a credit limit or available credit for a balance', () => {
    const best = prefill(findStatementCandidates(CARD).balance);
    expect(best?.valueCents).toBe(255_000);
  });

  /** A person needs to see WHY a figure was proposed, or they cannot check it. */
  it('carries the words around each candidate', () => {
    const best = prefill(findStatementCandidates(MORTGAGE).balance);
    expect(best?.snippet.toLowerCase()).toContain('closing balance');
  });
});

describe('findStatementCandidates: the statement date', () => {
  it('finds an ISO date beside its label', () => {
    expect(prefill(findStatementCandidates(MORTGAGE).statementDate)?.date).toBe('2026-09-01');
  });

  it('reads a slashed date as day-first, and offers it rather than deciding silently', () => {
    const candidates = findStatementCandidates(CARD).statementDate;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.date).toBe('2026-01-09');
  });

  it('ignores a date with no label anywhere near it', () => {
    expect(findStatementCandidates('Some text 2026-09-01 and nothing else').statementDate).toEqual([]);
  });
});

describe('findStatementCandidates: the interest the statement printed', () => {
  it('finds it, which is the figure worth the most on this form', () => {
    expect(prefill(findStatementCandidates(MORTGAGE).interest)?.valueCents).toBe(125_104);
  });

  it('offers nothing when the statement does not print one', () => {
    expect(findStatementCandidates(CARD).interest).toEqual([]);
  });
});

/** Canada: a statement may well be in French, and offering nothing would look like a broken feature. */
describe('findStatementCandidates: French statements', () => {
  it('finds the closing balance under its French label', () => {
    const candidates = findStatementCandidates(FRENCH).balance;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.snippet.toLowerCase()).toContain('solde');
  });

  it('finds the statement date under its French label', () => {
    expect(prefill(findStatementCandidates(FRENCH).statementDate)?.date).toBe('2026-09-01');
  });
});

/**
 * Ruling S7's refusal. A tie means the text gave no reason to prefer either figure, and filling one
 * in anyway would present a coin toss as a reading.
 */
describe('prefill: when not to answer', () => {
  it('fills nothing in when the top two are tied', () => {
    const tied = [
      { valueCents: 100, snippet: 'a', score: 10 },
      { valueCents: 200, snippet: 'b', score: 10 },
    ];
    expect(prefill(tied)).toBeNull();
  });

  it('fills nothing in when nothing was found', () => {
    expect(prefill([])).toBeNull();
  });

  it('answers when one candidate is genuinely better', () => {
    const clear = [
      { valueCents: 100, snippet: 'a', score: 20 },
      { valueCents: 200, snippet: 'b', score: 10 },
    ];
    expect(prefill(clear)?.valueCents).toBe(100);
  });
});

describe('findStatementCandidates: text that is not a statement', () => {
  it('offers nothing rather than guessing', () => {
    const found = findStatementCandidates('Thank you for banking with us. Please retain for your records.');
    expect(found.balance).toEqual([]);
    expect(found.statementDate).toEqual([]);
    expect(found.interest).toEqual([]);
  });

  /** Page numbers, account digits and dates are not money, and must not be offered as figures. */
  it('does not read bare integers as money', () => {
    const found = findStatementCandidates('Closing balance page 2 of 3 account 123456789');
    expect(found.balance).toEqual([]);
  });
});

describe('findStatementCandidates: line length and pattern bounds', () => {
  it('skips a line longer than MAX_STATEMENT_LINE_CHARS within a generous time bound', () => {
    const longDigits = `Closing balance ${'1'.repeat(200_000)}x`;
    const longMonth = `Statement date 1 jan${'a'.repeat(200_000)} 2026`;
    const text = `${longDigits}\n${longMonth}\n${MORTGAGE}`;
    const started = performance.now();
    const found = findStatementCandidates(text);
    expect(performance.now() - started).toBeLessThan(1_000);
    // The ordinary lines after the long ones are still read.
    expect(prefill(found.balance)?.valueCents).toBe(19_991_315);
    expect(prefill(found.statementDate)?.date).toBe('2026-09-01');
  });

  it('still reads a line at the cap', () => {
    const line = 'Closing balance $1,234.56'.padEnd(MAX_STATEMENT_LINE_CHARS, ' ');
    expect(line.length).toBe(MAX_STATEMENT_LINE_CHARS);
    expect(prefill(findStatementCandidates(line).balance)?.valueCents).toBe(123_456);
    const over = `${line} `;
    expect(findStatementCandidates(over).balance).toEqual([]);
  });

  it('reads a full month name and a twelve-digit figure, and nothing longer as one figure', () => {
    expect(prefill(findStatementCandidates('Statement date September 1, 2026').statementDate)?.date).toBe('2026-09-01');
    expect(prefill(findStatementCandidates('Statement date 1 September 2026').statementDate)?.date).toBe('2026-09-01');
    expect(prefill(findStatementCandidates('Closing balance 123456789012.34').balance)?.valueCents).toBe(12_345_678_901_234);
    expect(findStatementCandidates('Closing balance 1234567890123.45').balance).toEqual([]);
  });
});
