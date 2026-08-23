import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMonths, monthLabel } from '@/lib/dates';
import { assignTransactionToLoan, payoffProjection } from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from './loans/fixtures';

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
});

const TODAY = '2026-08-15'; // thisMonth = 2026-08; the 6-month window is 2026-02 .. 2026-07.

/**
 * Inserts a loan_payments row directly (bypassing applyLoanMatchers/assignTransactionToLoan
 * entirely), so each test controls exactly which calendar month a payment lands in and how
 * much of it applied, without exercising unrelated matcher/rule machinery. A real transaction
 * row is still created for the NOT NULL FK, via the shared fixture's spend() helper.
 */
function insertPayment(itemId: number, appliedCents: number, createdAtIso: string): void {
  const txnId = ctx.spend('LOAN PAYMENT', -appliedCents, { date: createdAtIso.slice(0, 10) });
  ctx.t.sqlite
    .prepare(
      `insert into loan_payments (txn_id, item_id, amount_cents, applied_cents, source, created_at)
       values (?, ?, ?, ?, 'manual', ?)`,
    )
    .run(txnId, itemId, appliedCents, appliedCents, createdAtIso);
}

describe('payoffProjection: the six-month mean', () => {
  it('means across all 6 months, counting a month with no payment as zero', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    insertPayment(itemId, 10_000, '2026-02-10T00:00:00.000Z');
    insertPayment(itemId, 10_000, '2026-04-10T00:00:00.000Z');
    insertPayment(itemId, 10_000, '2026-06-10T00:00:00.000Z');
    // March, May and July carry no row at all -- they must count as 0, not be skipped.

    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    // (10000 + 0 + 10000 + 0 + 10000 + 0) / 6 = 5000, exactly.
    expect(result!.monthlyAppliedCents).toBe(5_000);
  });

  it('a loan paid exactly once in the window paces at one sixth of that payment, never the full amount', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    insertPayment(itemId, 60_000, '2026-06-18T00:00:00.000Z');

    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    expect(result!.monthlyAppliedCents).toBe(10_000); // 60000 / 6, exactly.
    // The bug this guards against: treating one payment as if it recurred every month.
    expect(result!.monthlyAppliedCents).not.toBe(60_000);
  });

  it('ignores payments outside the window: the current (in-progress) month and anything older than 6 months', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    insertPayment(itemId, 999_999, '2026-01-20T00:00:00.000Z'); // one month before the window starts
    insertPayment(itemId, 888_888, '2026-08-05T00:00:00.000Z'); // today's own (partial) month

    // Nothing at all lands inside 2026-02..2026-07, so the mean is 0 and the result is null --
    // if either distractor were wrongly included the mean would be far from 0.
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });
});

describe('payoffProjection: null cases', () => {
  it('is null when current_balance_cents is null', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: null });
    insertPayment(itemId, 50_000, '2026-06-10T00:00:00.000Z');
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });

  it('is null when current_balance_cents is zero', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 0 });
    insertPayment(itemId, 50_000, '2026-06-10T00:00:00.000Z');
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });

  it('is null when the mean is 0 (no payments at all in the window)', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });
});

describe('payoffProjection: projected month arithmetic', () => {
  it('divides exactly when the balance is a whole multiple of the monthly pace', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 180_000 }); // 3 x 60000, exactly
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 60_000, `2026-${month}-15T00:00:00.000Z`);
    }
    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    expect(result!.monthlyAppliedCents).toBe(60_000);
    expect(result!.projectedPayoffMonth).toBe(addMonths('2026-08', 3));
    expect(result!.projectedPayoffMonth).toBe('2026-11');
  });

  it('rounds up to the next whole month when the balance does not divide evenly', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 180_001 }); // one cent past the exact multiple
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 60_000, `2026-${month}-15T00:00:00.000Z`);
    }
    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    expect(result!.monthlyAppliedCents).toBe(60_000);
    // ceil(180001 / 60000) = 4, not 3: the ceiling must round up on the smallest overrun.
    expect(result!.projectedPayoffMonth).toBe(addMonths('2026-08', 4));
    expect(result!.projectedPayoffMonth).toBe('2026-12');
  });
});

describe('payoffProjection: clock-free', () => {
  it('returns identical results across repeated calls with the same input', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 180_000 });
    insertPayment(itemId, 60_000, '2026-06-15T00:00:00.000Z');
    const first = payoffProjection(itemId, TODAY);
    const second = payoffProjection(itemId, TODAY);
    expect(second).toEqual(first);
  });
});

/**
 * Fix-round (F-payoff): loan_payments.applied_cents is stored UNSIGNED IN BOTH DIRECTIONS (see
 * link()'s docblock in src/lib/loans.ts). A payment (a negative transaction) decrements the
 * balance; a disbursement or upward adjustment (a positive transaction, linked via
 * assignTransactionToLoan -- a supported, existing feature, not a hypothetical) increments it.
 * Both write a POSITIVE applied_cents. Summing applied_cents by month with no filter on the
 * linked transaction's own sign therefore counts money drawn AGAINST a loan as though it had
 * been paid off it. These tests use the real assignTransactionToLoan for every disbursement
 * (never a raw insert), and the existing insertPayment helper above -- which always creates a
 * negative transaction -- for every real payment, so both link kinds go through their actual
 * write paths.
 */
describe('payoffProjection: disbursements never count toward the payoff pace', () => {
  it("the reviewer's reproduction: a $6,000 balance, a real $100/month payment history, and one $5,900 linked disbursement projects ~60 months, not 6", () => {
    // Seed the loan BEFORE the disbursement lands, so that once the $5,900 draw is linked
    // through the real assignTransactionToLoan path (which increments the balance), the
    // resulting current_balance_cents is exactly the reviewer's $6,000 figure.
    const { itemId } = ctx.seedLoan({ balanceCents: 10_000 });
    const drawTxnId = ctx.spend('LINE OF CREDIT DRAW', 590_000, { date: '2026-07-20' });
    // `at` controls loan_payments.created_at (what the pace query groups by) -- without it,
    // assignTransactionToLoan defaults to the real wall-clock "now", which would land outside
    // the 2026-02..2026-07 pace window entirely and mask the very bug this test reproduces.
    const draw = assignTransactionToLoan({ itemId, txnId: drawTxnId, at: new Date('2026-07-20T00:00:00.000Z') });
    expect(draw).toEqual({ linked: true, appliedCents: 590_000 });
    expect(ctx.balanceOf(itemId)).toBe(600_000); // 10,000 + 590,000 draw = $6,000

    // A real $100/month payment, one per month, across the whole 6-month pace window.
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 10_000, `2026-${month}-10T00:00:00.000Z`);
    }

    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    // Payments-only mean: (10,000 x 6) / 6 = 10,000 exactly. The bug: summing the $5,900 draw
    // (590,000 cents) in unsigned alongside the payments pushed the buggy mean to 108,333 --
    // (5 x 10,000 + (10,000 + 590,000)) / 6 -- which projects ceil(600,000 / 108,333) = 6
    // months, the reviewer's exact wrong reproduction. The fix must exclude it entirely.
    expect(result!.monthlyAppliedCents).toBe(10_000);
    expect(result!.monthlyAppliedCents).not.toBe(108_333);
    // ceil(600,000 / 10,000) = 60 months -- the true pace -- not the reviewer's wrongly
    // observed 6.
    const expectedMonth = addMonths('2026-08', 60);
    expect(expectedMonth).toBe('2031-08');
    expect(result!.projectedPayoffMonth).toBe(expectedMonth);
    // monthLabel must render a real month, not pass a raw storage key through untouched.
    expect(monthLabel(result!.projectedPayoffMonth)).toBe('August 2031');
  });

  it('a loan whose only linked rows are disbursements returns null, not a confident projection', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 100_000 });
    const drawTxnId = ctx.spend('LINE OF CREDIT DRAW', 50_000, { date: '2026-06-15' });
    expect(
      assignTransactionToLoan({ itemId, txnId: drawTxnId, at: new Date('2026-06-15T00:00:00.000Z') }).linked,
    ).toBe(true);
    // No insertPayment call at all: every linked row on this loan is a disbursement.
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });

  it("excludes disbursements from every month's total, not just months where a payment also landed", () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 300_000 });
    insertPayment(itemId, 10_000, '2026-02-10T00:00:00.000Z');
    insertPayment(itemId, 10_000, '2026-04-10T00:00:00.000Z');
    insertPayment(itemId, 10_000, '2026-06-10T00:00:00.000Z');

    // A disbursement ALONE in March -- no payment that month at all. `at` pins
    // loan_payments.created_at to that same month; see the note in the reviewer's-reproduction
    // test above on why the default (real wall-clock "now") would mask the bug.
    const marchDrawTxnId = ctx.spend('LOC DRAW', 100_000, { date: '2026-03-12' });
    expect(
      assignTransactionToLoan({ itemId, txnId: marchDrawTxnId, at: new Date('2026-03-12T00:00:00.000Z') }).linked,
    ).toBe(true);
    // A second disbursement sharing June with a real payment, so a fix that only "nets"
    // a disbursement against a payment IN THE SAME MONTH (rather than excluding it outright
    // via the transactions.amount_cents < 0 filter) cannot pass this by coincidence.
    const juneDrawTxnId = ctx.spend('LOC DRAW', 200_000, { date: '2026-06-20' });
    expect(
      assignTransactionToLoan({ itemId, txnId: juneDrawTxnId, at: new Date('2026-06-20T00:00:00.000Z') }).linked,
    ).toBe(true);

    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    // Only the three real $100 payments count, in any month: (10,000 x 3) / 6 = 5,000 exactly.
    // The buggy sum (all months, disbursements included) would be 10,000 + 100,000 + 10,000 +
    // 0 + (10,000 + 200,000) + 0 = 330,000, mean 55,000 -- eleven times too high.
    expect(result!.monthlyAppliedCents).toBe(5_000);
  });

  it('the existing payments-only behaviour is unchanged: a real payment history alone still paces and projects exactly as before', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 180_000 }); // 3 x 60,000, exactly
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 60_000, `2026-${month}-15T00:00:00.000Z`);
    }
    const result = payoffProjection(itemId, TODAY);
    expect(result).toEqual({ monthlyAppliedCents: 60_000, projectedPayoffMonth: '2026-11' });
  });
});

/**
 * Fix-round (F-payoff), second defect: an absurd pace (a real payment of a few cents against a
 * large balance) divides out to a payoff centuries away. isMonthKey (src/lib/dates.ts) requires
 * EXACTLY a 4-digit year, so a year that far out fails it and monthLabel silently hands back the
 * raw "YYYYYYYYY-MM" storage key instead of a formatted month, instead of erroring loudly.
 *
 * Chosen bound: 1200 months (100 years), returning null beyond it. This mirrors the SAME
 * "a century of months" cap nextPayment() already uses a few functions above in this file --
 * not a new number invented for this fix -- and null is the honest answer once a projection is
 * that far out: "we cannot meaningfully project this" is true, and a garbled year is not.
 */
describe('payoffProjection: the absurd-pace bound', () => {
  it('at exactly the 1200-month (100-year) bound, still returns a real, formattable projection', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 120_000 }); // 1200 x 100, exactly
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 100, `2026-${month}-10T00:00:00.000Z`);
    }
    const result = payoffProjection(itemId, TODAY);
    expect(result).not.toBeNull();
    expect(result!.monthlyAppliedCents).toBe(100);
    expect(result!.projectedPayoffMonth).toBe(addMonths('2026-08', 1200));
    expect(monthLabel(result!.projectedPayoffMonth)).toBe('August 2126');
  });

  it('one month past the bound, returns null rather than a month monthLabel cannot format', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 120_100 }); // one payment-cent past 1200 x 100
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 100, `2026-${month}-10T00:00:00.000Z`);
    }
    expect(payoffProjection(itemId, TODAY)).toBeNull();
  });

  it('the reviewer\'s own example -- one cent a month against a $1,000,000 balance -- returns null, never a nine-digit-year month string', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 100_000_000 }); // $1,000,000
    for (const month of ['02', '03', '04', '05', '06', '07']) {
      insertPayment(itemId, 1, `2026-${month}-10T00:00:00.000Z`);
    }
    const result = payoffProjection(itemId, TODAY);
    expect(result).toBeNull();
  });
});

/**
 * MUST-13.1 (tests/ops/loan-invariants.test.ts) already guards the whole file against any
 * arithmetic operator touching interestRateBps. This test is scoped tighter, to the function
 * itself: payoffProjection must not reference the column AT ALL, arithmetic or otherwise, and
 * must never read the clock -- both restated here as an explicit, function-scoped source scan
 * rather than trusting a whole-file regex not to have a gap. Extraction mirrors the
 * balanced-brace `parenBody` idiom tests/ops/loan-invariants.test.ts already uses for parens,
 * adapted to braces so it works regardless of where in the file the function lives.
 */
describe('payoffProjection: source guards', () => {
  function functionSource(name: string): string {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const source = fs.readFileSync(path.join(root, 'src/lib/loans.ts'), 'utf8');
    const marker = `export function ${name}(`;
    const start = source.indexOf(marker);
    expect(start, `${name} not found in src/lib/loans.ts`).toBeGreaterThan(-1);
    const braceStart = source.indexOf('{', start);
    let depth = 1;
    let i = braceStart + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    return source.slice(start, i);
  }

  it('never references interestRateBps or interest_rate_bps', () => {
    const body = functionSource('payoffProjection');
    expect(body).not.toMatch(/interestRateBps/);
    expect(body).not.toMatch(/interest_rate_bps/);
  });

  it('never touches the clock: no new Date(, Date.now(, or todayIso( inside the function', () => {
    const body = functionSource('payoffProjection');
    expect(body).not.toMatch(/new Date\(/);
    expect(body).not.toMatch(/Date\.now\(/);
    expect(body).not.toMatch(/todayIso\(/);
  });
});
