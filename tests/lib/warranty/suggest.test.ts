import { describe, it, expect } from 'vitest';
import {
  MAX_CANDIDATES,
  MAX_SUGGESTED_PRICE_CENTS,
  amountCandidates,
  dateCandidates,
  suggestDueDate,
  suggestFromOcrText,
  suggestPriceCents,
  suggestPurchaseDate,
  suggestVendor,
} from '@/lib/warranty/suggest';

const TODAY = '2026-08-16';

describe('suggestPurchaseDate', () => {
  it('reads ISO, slash, DD Mon YYYY and Mon D, YYYY shapes', () => {
    expect(suggestPurchaseDate('Sold on 2026-07-04 thanks', TODAY)).toBe('2026-07-04');
    expect(suggestPurchaseDate('Date: 04/07/2026', TODAY)).toBe('2026-04-07');
    expect(suggestPurchaseDate('16 Aug 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('Aug 16, 2026', TODAY)).toBe('2026-08-16');
    expect(suggestPurchaseDate('4-7-26', TODAY)).toBe('2026-04-07');
  });

  it('applies the ambiguity ladder in order (§8.1 step 3)', () => {
    expect(suggestPurchaseDate('13/05/2026', TODAY)).toBe('2026-05-13'); // A > 12 -> DD/MM
    expect(suggestPurchaseDate('05/13/2026', TODAY)).toBe('2026-05-13'); // B > 12 -> MM/DD
    expect(suggestPurchaseDate('05/06/2026', TODAY)).toBe('2026-05-06'); // default MM/DD
  });

  it('discards impossible, future and >20-year-old dates', () => {
    expect(suggestPurchaseDate('02/30/2026', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2027-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('1990-01-01', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('2006-08-16', TODAY)).toBe('2006-08-16'); // exactly 20 years: kept
    expect(suggestPurchaseDate('2006-08-15', TODAY)).toBeUndefined();
  });

  it('takes the earliest occurrence in the text, not the earliest date', () => {
    const receipt = ['HOME DEPOT', 'Purchased 2026-08-16', 'Return by 2026-09-15', 'Promo ends 2026-01-05'].join('\n');
    expect(suggestPurchaseDate(receipt, TODAY)).toBe('2026-08-16');
  });

  it('returns undefined for text with no date', () => {
    expect(suggestPurchaseDate('THANK YOU FOR SHOPPING', TODAY)).toBeUndefined();
    expect(suggestPurchaseDate('', TODAY)).toBeUndefined();
  });
});

describe('suggestVendor', () => {
  it('picks the first plausible line among the first five', () => {
    expect(suggestVendor('HOME DEPOT #7042\n123 Main St\nTOTAL 45.00')).toBe('HOME DEPOT #7042');
  });

  it('skips phone, www, receipt/invoice/order headers and digit-led lines', () => {
    const text = ['www.rona.ca', 'TEL 514-555-0134', '4412', 'RECEIPT', 'RONA L’ENTREPÔT'].join('\n');
    expect(suggestVendor(text)).toBe('RONA L’ENTREPÔT');
  });

  it('skips lines with fewer than three letters and collapses whitespace', () => {
    expect(suggestVendor('== $$ ==\n  BEST   BUY   CANADA  \n')).toBe('BEST BUY CANADA');
  });

  it('never looks past the fifth non-empty line', () => {
    const text = ['1', '2', '3', '4', '5', 'CANADIAN TIRE'].join('\n');
    expect(suggestVendor(text)).toBeUndefined();
  });

  it('caps at 60 characters and does not title-case', () => {
    const long = 'a'.repeat(80);
    expect(suggestVendor(long)).toHaveLength(60);
    expect(suggestVendor('canadian tire')).toBe('canadian tire');
  });

  it('returns undefined for empty text', () => {
    expect(suggestVendor('')).toBeUndefined();
  });
});

describe('suggestPriceCents', () => {
  it('prefers the TOTAL line over SUBTOTAL', () => {
    const text = ['SUBTOTAL   40.00', 'GST         2.00', 'TOTAL      42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST total line when several match', () => {
    const text = ['TOTAL       10.00', 'BALANCE DUE 42.00'].join('\n');
    expect(suggestPriceCents(text)).toBe(4200);
  });

  it('takes the LAST currency number on that line', () => {
    expect(suggestPriceCents('TOTAL 3 items 129.99')).toBe(12999);
  });

  it('never reads a SUBTOTAL line as the total', () => {
    // Spec 2026-09-30 §2.3: with the fallback gone, a lone SUBTOTAL line yields nothing.
    expect(suggestPriceCents('SUB-TOTAL 99.99')).toBeUndefined();
    expect(suggestPriceCents('SUBTOTAL 99.99\nTOTAL 105.99')).toBe(10599);
  });

  it('no longer falls back to the largest currency amount anywhere (spec 2026-09-30 §2.3)', () => {
    expect(suggestPriceCents('Item A 12.00\nItem B 145.50\nCash 200.00 Change 54.50')).toBeUndefined();
  });

  it('handles thousands separators and a dollar sign', () => {
    expect(suggestPriceCents('TOTAL $1,299.99')).toBe(129999);
  });

  it('ignores anything at or above the $100,000 noise ceiling', () => {
    expect(MAX_SUGGESTED_PRICE_CENTS).toBe(10_000_000);
    expect(suggestPriceCents('BARCODE 9876543210.99\nTOTAL 45.00')).toBe(4500);
    expect(suggestPriceCents('BARCODE 9876543210.99')).toBeUndefined();
  });

  it('returns undefined when nothing looks like money', () => {
    expect(suggestPriceCents('THANK YOU')).toBeUndefined();
    expect(suggestPriceCents('')).toBeUndefined();
  });

  it('always returns an integer positive magnitude', () => {
    const cents = suggestPriceCents('TOTAL -42.00');
    expect(cents).toBe(4200);
    expect(Number.isInteger(cents)).toBe(true);
  });

  it('does not backtrack quadratically on a 100k digit run', () => {
    // Regression for a quadratic-backtracking CURRENCY_RE: an unbounded `\d+` alternative
    // backtracks O(L) at each of L start positions on a long unbroken digit run (garbled
    // barcode OCR), i.e. O(L^2) on the ~100k-char OCR cap. Vitest's default 5s test timeout
    // is the guard here — this test hangs under the old pattern and finishes instantly under
    // the fixed one.
    const digitRun = '9'.repeat(100_000);
    const result = suggestFromOcrText(digitRun, TODAY);
    expect(result.priceCents).toBeUndefined();
  });

  it('still parses legit large-but-valid amounts after bounding the digit run to 9', () => {
    expect(suggestPriceCents('TOTAL 1,234.56')).toBe(123456);
    // 999999.99 is syntactically a valid amount (6-digit whole part, well within the 9-digit
    // bound) but sits above the $100,000 noise ceiling, so it is correctly rejected there —
    // not silently mis-parsed by the digit-run bound.
    expect(suggestPriceCents('TOTAL 999999.99')).toBeUndefined();
  });

  it('walks backward past an invalid last candidate on the TOTAL line to an earlier valid one', () => {
    // Deliberate liberality beyond the spec's literal "last number" step: when the last
    // currency-shaped number on the TOTAL line fails validation (here, over the noise
    // ceiling), earlier candidates on the same line are tried before giving up on that line.
    expect(suggestPriceCents('TOTAL 45.00 9999999.99')).toBe(4500);
  });
});

describe('suggestFromOcrText', () => {
  it('combines all three on a realistic receipt', () => {
    const receipt = [
      'HOME DEPOT #7042',
      '1000 boul. Cure-Labelle, Laval QC',
      'TEL 450-555-0199',
      '08/16/2026  14:32',
      'GE FRIDGE GDT645SYNFS   1,299.99',
      'SUBTOTAL              1,299.99',
      'TPS/GST                  65.00',
      'TOTAL                 1,494.49',
    ].join('\n');
    expect(suggestFromOcrText(receipt, TODAY)).toEqual({
      purchaseDate: '2026-08-16',
      vendor: 'HOME DEPOT #7042',
      priceCents: 149449,
    });
  });

  it('returns an empty object for empty text, with each field independently optional', () => {
    expect(suggestFromOcrText('', TODAY)).toEqual({});
    expect(suggestFromOcrText('CANADIAN TIRE', TODAY)).toEqual({ vendor: 'CANADIAN TIRE' });
  });
});

/** Spec 2026-09-30 §2.3. Never guess, always show. */
describe('suggestPriceCents without the fallback', () => {
  it('prefers the TOTAL line over a larger CASH line (review focus 4)', () => {
    expect(suggestPriceCents(['SUBTOTAL 42.00', 'TOTAL 47.32', 'CASH 100.00', 'CHANGE 52.68'].join('\n'))).toBe(4732);
  });
  it('suggests nothing when no total-like line exists, rather than the largest number anywhere', () => {
    expect(suggestPriceCents(['MILK 6.49', 'BREAD 3.79', 'CASH 100.00'].join('\n'))).toBeUndefined();
  });
  it('reads a misrecognised TOTAL and the words a bill uses', () => {
    expect(suggestPriceCents('T0TAL 25.31')).toBe(2531);
    expect(suggestPriceCents('IOTAL 25.31')).toBe(2531);
    expect(suggestPriceCents('Amount due $312.44')).toBe(31244);
    expect(suggestPriceCents('Montant 12,50')).toBe(1250);
  });
  it('never takes a payment line as the total even when it says total', () => {
    expect(suggestPriceCents(['TOTAL 47.32', 'VISA TOTAL TENDERED 100.00'].join('\n'))).toBe(4732);
  });
  it('never takes a late-fee line as the total, but keeps a total after a discount', () => {
    expect(suggestPriceCents(['Amount due $312.44', 'Amount due after due date $328.06'].join('\n'))).toBe(31244);
    expect(suggestPriceCents(['TOTAL 47.32', 'Late fee total 5.00'].join('\n'))).toBe(4732);
    expect(suggestPriceCents('Total after discount 40.00')).toBe(4000);
  });
  it('steps back past a later total line that carries no figure', () => {
    expect(suggestPriceCents(['TOTAL 47.32', 'TOTAL NUMBER OF ITEMS SOLD = 5'].join('\n'))).toBe(4732);
  });
  it('reads "payment due" as what is owed, and a payment received as paid', () => {
    expect(suggestPriceCents('Total payment due $85.00')).toBe(8500);
    expect(suggestPriceCents(['Total payment due $85.00', 'Total payments received 120.00'].join('\n'))).toBe(8500);
  });
  it('excludes French late-fee and payment lines too', () => {
    expect(suggestPriceCents(['Montant dû 312,44 $', "Montant après la date d'échéance 328,06 $"].join('\n'))).toBe(31244);
    expect(suggestPriceCents(['Montant dû 85,00', 'Montant du dernier paiement 120,00'].join('\n'))).toBe(8500);
  });
});

describe('suggestDueDate', () => {
  it('finds the due date on its own line, in the future (review focus 3)', () => {
    const text = ['RIVERSIDE WATER', 'Billing period 2026-08-04 to 2026-11-03', 'Amount due $312.44', 'Due date 2026-11-24'].join('\n');
    expect(suggestDueDate(text, '2026-11-07')).toBe('2026-11-24');
  });
  it('accepts the words a bill prints, English and French', () => {
    expect(suggestDueDate('Payable by Oct 31, 2026', '2026-09-20')).toBe('2026-10-31');
    expect(suggestDueDate("Date d'échéance 2026-10-31", '2026-09-20')).toBe('2026-10-31');
  });
  it('ignores a date more than eighteen months out or a year past, and finds nothing on a receipt', () => {
    expect(suggestDueDate('Due date 2029-01-01', '2026-09-20')).toBeUndefined();
    expect(suggestDueDate('Due date 2025-08-01', '2026-09-20')).toBeUndefined();
    expect(suggestDueDate('Due date 2025-10-21', '2026-09-20')).toBe('2025-10-21');
    expect(suggestDueDate('DATE: 2026-09-14 TOTAL 25.31', '2026-09-20')).toBeUndefined();
  });
  it('takes the date after the phrase when two columns share a line', () => {
    expect(suggestDueDate('Billing period 2026-08-04 to 2026-11-03   Due date 2026-11-24', '2026-11-07')).toBe('2026-11-24');
    expect(suggestDueDate('Bill date: Sep 15, 2026     Due date: Oct 15, 2026', '2026-09-20')).toBe('2026-10-15');
    // Nothing after the phrase: the first in-range date on the line.
    expect(suggestDueDate('2026-10-31   Due date', '2026-09-20')).toBe('2026-10-31');
  });
  it('reads French upper case and an unaccented echeance', () => {
    expect(suggestDueDate("DATE D'ÉCHÉANCE 2026-10-31", '2026-09-20')).toBe('2026-10-31');
    expect(suggestDueDate('Echeance 2026-10-31', '2026-09-20')).toBe('2026-10-31');
  });
  it('falls back to a bare "due" only when no due-date phrase yields a date', () => {
    expect(suggestDueDate('Due Oct 31, 2026', '2026-09-20')).toBe('2026-10-31');
    expect(suggestDueDate(['Payment due 2026-09-25', 'Due date 2026-10-31'].join('\n'), '2026-09-20')).toBe('2026-10-31');
    expect(suggestDueDate('Overdue since 2026-08-01', '2026-09-20')).toBeUndefined();
    expect(suggestDueDate('Past due 2026-08-01', '2026-09-20')).toBeUndefined();
  });
});

describe('candidates carry the words around them', () => {
  // The statement date comes first, so the first-date bonus competes with the due-date line.
  const bill = ['RIVERSIDE WATER', 'Statement date 2026-11-06', 'Water charges 141.07', 'Sewer charges 171.89', 'Total current charges $312.96', 'Amount due $312.44', 'Due date 2026-11-24', 'Amount due after due date $328.06'].join('\n');
  it('ranks the amount-due line first and keeps each figure once with its snippet', () => {
    const amounts = amountCandidates(bill);
    expect(amounts[0]).toMatchObject({ valueCents: 31244 });
    expect(amounts[0].snippet).toContain('Amount due');
    expect(amounts.length).toBeLessThanOrEqual(6);
    expect(new Set(amounts.map((c) => c.valueCents)).size).toBe(amounts.length);
  });
  it('ranks the due-date line first among dates', () => {
    const dates = dateCandidates(bill, '2026-11-07');
    expect(dates[0]).toMatchObject({ date: '2026-11-24' });
    expect(dates[0].snippet).toContain('Due date');
  });
  it('suggestFromOcrText carries the due date', () => {
    expect(suggestFromOcrText(bill, '2026-11-07')).toMatchObject({ vendor: 'RIVERSIDE WATER', priceCents: 31244, dueDate: '2026-11-24' });
  });
  it('ranks a late-fee figure below the figures on ordinary lines', () => {
    const amounts = amountCandidates(bill);
    expect(amounts[amounts.length - 1]).toMatchObject({ valueCents: 32806 });
  });
  it('gives the due-date score only to a date after the phrase on a joined line', () => {
    const dates = dateCandidates('Billing period 2026-08-04 to 2026-11-03   Due date 2026-11-24', '2026-11-07');
    expect(dates[0]).toMatchObject({ date: '2026-11-24' });
    expect(dates[0].snippet).toContain('Due date');
  });
  it('cuts the snippet around the figure, not from the start of a long joined line', () => {
    const line = 'Service address 12 Example Road, Riverside      Account summary      Amount due $312.44';
    const [top] = amountCandidates(line);
    expect(top.snippet).toContain('Amount due $312.44');
    expect(top.snippet.length).toBeLessThanOrEqual(70);
    expect(top.snippet).not.toMatch(/\s{2}/);
  });
  it('caps at six candidates and keeps a repeated figure once, with its later line', () => {
    const receipt = ['MAPLE GROCERY CO.', 'MILK 6.49', 'BREAD 3.79', 'EGGS 4.29', 'CHEDDAR 7.99', 'APPLES 5.03', 'COFFEE 8.99', 'OAT MILK 6.49', 'TOTAL 43.07'].join('\n');
    const amounts = amountCandidates(receipt);
    expect(amounts).toHaveLength(MAX_CANDIDATES);
    expect(new Set(amounts.map((c) => c.valueCents)).size).toBe(amounts.length);
    expect(amounts.find((c) => c.valueCents === 649)?.snippet).toBe('OAT MILK 6.49');
  });
});

/*
  A one-baseline PDF reads as a single line, and these run in the server process after the OCR
  timeout has already returned. Each hit used to cost the whole line (the line's flags once per
  match, and a whitespace pass over everything either side of it), so 100k characters of figures
  held the server for seconds. The bound is loose on purpose: it guards the shape, not a benchmark.
*/
describe('candidates on one very long line', () => {
  const day = (i: number) => new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  let line = '';
  for (let i = 0; line.length < 100_000; i += 1) line += `${(i % 900) + 1}.${String(i % 100).padStart(2, '0')} ${day(i)} `;
  line = line.slice(0, 100_000);

  it('ranks the amounts in well under a second, still capped', () => {
    const started = performance.now();
    const amounts = amountCandidates(line);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(amounts).toHaveLength(MAX_CANDIDATES);
  });

  it('ranks the dates in well under a second, still capped', () => {
    const started = performance.now();
    const dates = dateCandidates(line, TODAY);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(dates).toHaveLength(MAX_CANDIDATES);
  });
});
