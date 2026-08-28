import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BACKFILL_MAX_GLOBAL,
  BACKFILL_WINDOW_MS,
  LOAN_BACKFILL_MAX,
  backfillLoanRule,
  checkLoanBackfill,
  resetLoanRateLimitsForTests,
  saveLoanRule,
  setLoanRateLimitClockForTests,
} from '@/lib/loans';
import { setupLoanTest, type LoanTestContext } from './fixtures';

let ctx: LoanTestContext;

beforeEach(() => {
  ctx = setupLoanTest();
});
afterEach(() => {
  ctx.t.cleanup();
  setLoanRateLimitClockForTests(null);
  resetLoanRateLimitsForTests();
});

describe('MUST-13.9 / MUST-13.10 / MUST-14.12: the backfill', () => {
  it('is off by default — saveLoanRule alone links nothing', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
    saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(ctx.balanceOf(itemId)).toBe(2_000_000);
    expect(ctx.t.sqlite.prepare('select count(*) as n from loan_payments').get()).toEqual({ n: 0 });
  });

  it('links only inside the 365-day window and reports the count and the total applied', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 2_000_000 });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-02-01' });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2026-05-01' });
    ctx.spend('HONDA FIN SVC', -45_000, { date: '2024-01-01' }); // outside the window
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({
      linked: 2,
      appliedCents: 90_000,
    });
    expect(ctx.balanceOf(itemId)).toBe(1_910_000);
  });

  it('stops at LOAN_BACKFILL_MAX', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 100_000_000 });
    for (let i = 0; i < LOAN_BACKFILL_MAX + 10; i += 1) ctx.spend('HONDA FIN SVC', -100, { date: '2026-05-01' });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') }).linked).toBe(LOAN_BACKFILL_MAX);
  });

  it('the sixth backfill in a window is refused, and the bucket is global', () => {
    let now = 1_000_000;
    setLoanRateLimitClockForTests(() => now);
    resetLoanRateLimitsForTests();
    for (let i = 0; i < BACKFILL_MAX_GLOBAL; i += 1) expect(checkLoanBackfill().allowed).toBe(true);
    expect(checkLoanBackfill().allowed).toBe(false);
    now += BACKFILL_WINDOW_MS + 1;
    expect(checkLoanBackfill().allowed).toBe(true);
    setLoanRateLimitClockForTests(null);
  });

  it('accumulates advances on a lent loan (the running balance is signed)', () => {
    // Review round (Lane A): a THIRD, much larger advance is what actually stresses the running
    // total here -- growth never clamps against that total's VALUE (only its nullness), so two
    // advances landing at the right database figure does not, by itself, prove the running
    // figure carried between them has the right sign. It guards the same regression risk as the
    // three-advance test in payment-matchers.test.ts: a mistake in this round's refactor
    // (backfillLoanRule now advances `balance` by link()'s own returned signed delta, rather
    // than re-deriving the sign a second time) that reintroduces a ceiling on growth.
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'E TRANSFER', accountId: null, enabled: true });
    ctx.spend('E TRANSFER', -20_000, { date: '2026-07-01' });
    ctx.spend('E TRANSFER', -30_000, { date: '2026-07-15' });
    ctx.spend('E TRANSFER', -1_000_000, { date: '2026-07-20' });

    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({ linked: 3, appliedCents: 1_050_000 });
    expect(ctx.balanceOf(itemId)).toBe(1_050_000);
  });

  /**
   * Review round (Lane A): the genuinely observable version of the test above. Ruling P8 (the
   * backfill row query itself filters to `amount_cents < 0`) means a `lent` loan can only ever
   * show growth here, never a repayment -- and growth's applied amount never reads the running
   * `balance`'s VALUE, only whether it is null, so nothing reachable through backfillLoanRule can
   * tell a correctly-signed running total apart from a wrongly-signed one on that side. An `owed`
   * loan's repayments ARE clamped against that value, so three in one backfill run make the third
   * one's clamp depend on what the first two left behind.
   *
   * Confirmed by hand: with `balance` advanced by `result.appliedCents` (unsigned) instead of
   * `result.deltaCents` (signed), the third repayment sees an inflated ceiling, applies its full
   * magnitude instead of clamping, current_balance_cents' own CHECK constraint throws on the
   * resulting negative balance, backfillLoanRule's own catch swallows it, and this test's
   * expectations (linked: 3, appliedCents: 1,000, balance 0) fail.
   */
  it('three repayments on an owed loan in one backfill run: the third clamps against what the first two left', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 1_000 });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    ctx.spend('HONDA FIN SVC', -300, { date: '2026-06-01' });
    ctx.spend('HONDA FIN SVC', -300, { date: '2026-06-15' });
    // Bigger than the true remaining balance (400) but smaller than the original one (1,000): a
    // running total that forgot to subtract (or subtracted the wrong thing) would let this apply
    // in full instead of clamping to what is actually left.
    ctx.spend('HONDA FIN SVC', -1_000, { date: '2026-07-01' });

    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({ linked: 3, appliedCents: 1_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
  });
});
