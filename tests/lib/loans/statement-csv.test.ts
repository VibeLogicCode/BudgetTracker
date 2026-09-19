import { describe, it, expect } from 'vitest';
import { detectStatementColumns, readStatementCsv } from '@/lib/loans/statement-csv';

/**
 * Reading a statement that arrived as a spreadsheet (ledger spec S1–S3).
 *
 * Detection first, a picker only when detection is unsure -- the owner's choice. A lender's export
 * keeps its shape month to month, so the mapping is remembered and the picker is a fallback rather
 * than a monthly chore.
 */
const ENGLISH = [
  'Date,Description,Amount,Balance,Interest',
  '2026-08-05,Payment received,-500.00,"9,583.33",',
  '2026-09-01,Interest charged,83.33,"9,666.66",83.33',
  '',
].join('\n');

describe('detectStatementColumns (S1)', () => {
  it('finds the date, balance and interest columns by their headings', () => {
    const found = detectStatementColumns(ENGLISH);
    expect(found.headers).toEqual(['Date', 'Description', 'Amount', 'Balance', 'Interest']);
    expect(found.mapping).toEqual({ date: 'Date', balance: 'Balance', interest: 'Interest' });
    expect(found.confident).toBe(true);
  });

  it('is confident without an interest column, which many statements do not have', () => {
    const found = detectStatementColumns('Posted,Details,Running balance\n2026-09-01,x,100.00\n');
    expect(found.mapping).toEqual({ date: 'Posted', balance: 'Running balance', interest: null });
    expect(found.confident).toBe(true);
  });

  /** Canada: a statement may arrive in French, and offering nothing would look like a bug. */
  it('reads French headings', () => {
    const found = detectStatementColumns('Date,Description,Solde,Intérêts\n2026-09-01,x,"1 000,00","12,34"\n');
    expect(found.mapping.balance).toBe('Solde');
    expect(found.mapping.interest).toBe('Intérêts');
  });

  /** S2: unsure is a real answer. A wrong column silently chosen is worse than a picker. */
  it('is not confident when nothing looks like a balance', () => {
    const found = detectStatementColumns('When,What,How much\n2026-09-01,x,1.00\n');
    expect(found.mapping.balance).toBeNull();
    expect(found.confident).toBe(false);
  });

  it('is not confident about an empty file', () => {
    expect(detectStatementColumns('')).toMatchObject({ headers: [], confident: false });
  });

  /** A "minimum payment" column is not a balance, however much it looks like money. */
  it('does not mistake a minimum payment for the balance', () => {
    const found = detectStatementColumns('Date,Minimum payment,Closing balance\n2026-09-01,25.00,900.00\n');
    expect(found.mapping.balance).toBe('Closing balance');
  });
});

describe('readStatementCsv (S1)', () => {
  it('takes the chronologically last row as the statement', () => {
    const read = readStatementCsv(ENGLISH, { date: 'Date', balance: 'Balance', interest: 'Interest' });
    expect(read).toMatchObject({ statementDate: '2026-09-01', balanceCents: 966_666 });
  });

  /** The interest a statement PRINTS is the one interest figure needing no qualification. */
  it('totals the interest column across the period', () => {
    const read = readStatementCsv(ENGLISH, { date: 'Date', balance: 'Balance', interest: 'Interest' });
    expect(read?.interestCents).toBe(8_333);
  });

  it('reports no interest when the column was not mapped', () => {
    const read = readStatementCsv(ENGLISH, { date: 'Date', balance: 'Balance', interest: null });
    expect(read?.interestCents).toBeNull();
  });

  it('is not fooled by rows out of order', () => {
    const shuffled = ['Date,Balance', '2026-09-01,"9,666.66"', '2026-08-05,"9,583.33"', ''].join('\n');
    const read = readStatementCsv(shuffled, { date: 'Date', balance: 'Balance', interest: null });
    expect(read).toMatchObject({ statementDate: '2026-09-01', balanceCents: 966_666 });
  });

  it('reads French amounts, where the comma is the decimal point', () => {
    const french = ['Date,Solde', '2026-09-01,"2 550,00 $"', ''].join('\n');
    const read = readStatementCsv(french, { date: 'Date', balance: 'Solde', interest: null });
    expect(read?.balanceCents).toBe(255_000);
  });

  it('takes a balance as a magnitude, however the lender signs it', () => {
    const negative = ['Date,Balance', '2026-09-01,-1234.56', ''].join('\n');
    expect(readStatementCsv(negative, { date: 'Date', balance: 'Balance', interest: null })?.balanceCents).toBe(123_456);
  });

  it('returns null when the mapped columns hold nothing usable', () => {
    expect(readStatementCsv('Date,Balance\nnot-a-date,not-money\n', { date: 'Date', balance: 'Balance', interest: null })).toBeNull();
  });

  it('carries a few rows back for the picker to show', () => {
    const read = readStatementCsv(ENGLISH, { date: 'Date', balance: 'Balance', interest: 'Interest' });
    expect(read?.preview.length).toBeGreaterThan(0);
    expect(read?.preview[0]).toContain('2026-08-05');
  });
});
