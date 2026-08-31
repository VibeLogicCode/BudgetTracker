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
    // Originally: a THIRD, much larger advance was what stressed the running total here --
    // growth never clamps against that total's VALUE (only its nullness), so two advances
    // landing at the right database figure did not, by itself, prove the running figure carried
    // between them had the right sign.
    //
    // Item 6 (v1.21.0 backlog): there is no more running total for this loop to carry at all --
    // link() recomputes the WHOLE balance fresh on every call (recomputeBalance, replaying every
    // linked payment in true chronological order) and this loop just stores whatever it returns
    // for the NEXT call's balanceCents. The third, much larger advance still guards the same
    // regression risk in a different place: a mistake inside recomputeBalance that reintroduces
    // a ceiling on growth would truncate this one, where it would not have been visible against
    // a smaller number.
    const { itemId } = ctx.seedLoan({ balanceCents: 0, direction: 'lent' });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'E TRANSFER', accountId: null, enabled: true });
    ctx.spend('E TRANSFER', -20_000, { date: '2026-07-01' });
    ctx.spend('E TRANSFER', -30_000, { date: '2026-07-15' });
    ctx.spend('E TRANSFER', -1_000_000, { date: '2026-07-20' });

    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({ linked: 3, appliedCents: 1_050_000 });
    expect(ctx.balanceOf(itemId)).toBe(1_050_000);
  });

  /**
   * Originally: the genuinely observable version of the test above. Ruling P8 (the backfill row
   * query itself filters to `amount_cents < 0`) means a `lent` loan can only ever show growth
   * here, never a repayment -- an `owed` loan's repayments ARE clamped, so three in one backfill
   * run make the third one's clamp depend on what the first two left behind.
   *
   * Item 6 (v1.21.0 backlog): the mechanism changed, the numbers did not. Each transaction below
   * carries its OWN, ascending date, so recomputeBalance's chronological replay processes them in
   * the same order they were linked -- exactly what the OLD running-total code did too. What this
   * test still guards is that a batch of same-loan repayments clamp in sequence rather than each
   * one independently re-reading the loan's ORIGINAL balance.
   */
  it('three repayments on an owed loan in one backfill run: the third clamps against what the first two left', () => {
    const { itemId } = ctx.seedLoan({ balanceCents: 1_000 });
    const ruleId = saveLoanRule({ itemId, merchantContains: 'HONDA FIN', accountId: null, enabled: true });
    ctx.spend('HONDA FIN SVC', -300, { date: '2026-06-01' });
    ctx.spend('HONDA FIN SVC', -300, { date: '2026-06-15' });
    // Bigger than the true remaining balance (400) but smaller than the original one (1,000): a
    // batch that re-read the loan's ORIGINAL balance for each payment, instead of replaying them
    // in sequence, would let this apply in full instead of clamping to what is actually left.
    ctx.spend('HONDA FIN SVC', -1_000, { date: '2026-07-01' });

    expect(backfillLoanRule(ruleId, { at: new Date('2026-08-18T12:00:00Z') })).toEqual({ linked: 3, appliedCents: 1_000 });
    expect(ctx.balanceOf(itemId)).toBe(0);
  });
});
