import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMonths } from '@/lib/dates';
import { payoffProjection } from '@/lib/loans';
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
