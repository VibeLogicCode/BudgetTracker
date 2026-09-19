import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from '../../loans/fixtures';
import { assignTransactionToLoan, setLoanAnchor, postAllDueInterest } from '@/lib/loans';
import { evaluateLoanPaymentMissed, evaluateLoanReconcileDue } from '@/lib/notify/evaluate/loans';
import { evaluateGoals } from '@/lib/notify/evaluate/goals';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { addContribution, createGoal } from '@/lib/goals';
import { HOUSEHOLD_VIEWER } from '@/lib/auth/viewer';

let c: LoanTestContext;

beforeEach(() => {
  resetOutboxPumpForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  c?.t.cleanup();
});

function emailTarget(): void {
  saveSmtp({
    preset: 'brevo',
    host: 'h',
    port: 587,
    security: 'starttls',
    username: 'u',
    password: 'p',
    fromEmail: 'f@e.com',
    fromName: 'Budget Tracker',
    enabled: true,
  });
  saveEmailTarget({ userId: c.userId, destination: 'sam@example.com', enabled: true });
}

/** A loan with a rate, a statement and a rate-history row: the shape the ledger needs. */
function seedLoan(over: { name?: string; direction?: 'owed' | 'lent'; anchor?: string } = {}): number {
  const { itemId } = c.seedLoan({
    name: over.name ?? 'Car loan',
    balanceCents: 1_000_000,
    principalCents: 1_000_000,
    direction: over.direction,
  });
  c.t.sqlite
    .prepare(
      `update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`,
    )
    .run(itemId);
  setLoanAnchor({
    itemId,
    asOfDate: over.anchor ?? '2026-07-01',
    balanceCents: 1_000_000,
    source: 'form',
    actorUserId: c.userId,
    at: new Date('2026-07-01T12:00:00.000Z'),
  });
  c.t.sqlite
    .prepare(
      `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
       values (?, ?, 1000, 'apr_monthly', '2026-07-01T12:00:00.000Z')`,
    )
    .run(itemId, over.anchor ?? '2026-07-01');
  return itemId;
}

const outbox = (eventId: string) =>
  c.t.sqlite
    .prepare('select dedup_key, subject, body from notification_outbox where event_id = ? order by id')
    .all(eventId) as { dedup_key: string; subject: string; body: string }[];

const NOW = new Date('2026-09-18T09:00:00.000Z');

describe('N2: loan_interest_posted', () => {
  it('sends one message naming every loan that posted', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan();
    seedLoan({ name: 'Mortgage' });
    postAllDueInterest('2026-09-18', NOW);

    const rows = outbox('loan_interest_posted');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject).toBe('Interest added to 2 loans');
    expect(rows[0]!.body).toContain('Car loan');
    expect(rows[0]!.body).toContain('Mortgage');
  });

  /** The key carries each period, so a second sweep the same day says nothing. */
  it('does not repeat itself on a second sweep', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan();
    postAllDueInterest('2026-09-18', NOW);
    postAllDueInterest('2026-09-18', NOW);
    expect(outbox('loan_interest_posted')).toHaveLength(1);
  });

  it('names the loan when there is only one', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan();
    postAllDueInterest('2026-09-18', NOW);
    expect(outbox('loan_interest_posted')[0]!.subject).toBe('Interest added to Car loan');
  });
});

describe('N3: loan_payment_missed', () => {
  it('fires once for a period that closed with nothing paid into it', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan();
    postAllDueInterest('2026-09-18', NOW);

    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(1);
    const rows = outbox('loan_payment_missed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedup_key).toContain(`loan:missed:${itemId}:2026-09-01`);
    expect(rows[0]!.body).toContain('No payment was recorded on Car loan');

    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
    expect(outbox('loan_payment_missed')).toHaveLength(1);
  });

  it('says it the other way round for money lent out', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan({ name: 'Money lent', direction: 'lent' });
    postAllDueInterest('2026-09-18', NOW);
    evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' });
    expect(outbox('loan_payment_missed')[0]!.body).toContain('nothing received for');
  });

  it('stays quiet when the period was paid', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan();
    const txnId = c.spend('LENDER', -20_000, { date: '2026-08-15' });
    assignTransactionToLoan({ viewer: HOUSEHOLD_VIEWER, txnId, itemId, at: new Date('2026-08-15T12:00:00.000Z') });
    postAllDueInterest('2026-09-18', NOW);
    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });

  it('stays quiet when nothing has posted yet', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan();
    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });

  /** A finished term with a balance is a different message, and this is not it. */
  it('skips a loan whose term has already ended', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan();
    postAllDueInterest('2026-09-18', NOW);
    c.t.sqlite.prepare(`update warranty_items set expiry_date = '2026-08-15', warranty_months = 1 where id = ?`).run(itemId);
    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });
});

describe('N4: loan_reconcile_due', () => {
  it('fires once a month for a loan two months past its statement', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan({ anchor: '2026-06-01' });
    setPref(c.userId, 'loan_reconcile_due', 'email', true);

    expect(evaluateLoanReconcileDue({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(1);
    const rows = outbox('loan_reconcile_due');
    expect(rows[0]!.dedup_key).toContain(`loan:stale:${itemId}:2026-09`);
    expect(rows[0]!.body).toContain('last statement 2026-06-01');
    expect(evaluateLoanReconcileDue({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });

  it('stays quiet for a recent statement', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan({ anchor: '2026-09-01' });
    setPref(c.userId, 'loan_reconcile_due', 'email', true);
    expect(evaluateLoanReconcileDue({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });

  /** Default-off: it asks a household to go and find something, so it has to be opted into. */
  it('is silent until somebody switches it on', () => {
    c = setupLoanTest();
    emailTarget();
    seedLoan({ anchor: '2026-06-01' });
    expect(evaluateLoanReconcileDue({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });
});

describe('N6: the goal events', () => {
  it('says a goal was reached, once', () => {
    c = setupLoanTest();
    emailTarget();
    const goalId = createGoal({ name: 'New roof', ownerUserId: c.userId, targetCents: 100_000, targetDate: null });
    addContribution({ goalId, amountCents: 100_000, date: '2026-09-01', userId: c.userId });

    expect(evaluateGoals({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(1);
    expect(outbox('goal_reached')[0]!.dedup_key).toBe(`goal:met:${goalId}`);
    expect(evaluateGoals({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
  });

  it('stays quiet on a goal still short of its target', () => {
    c = setupLoanTest();
    emailTarget();
    const goalId = createGoal({ name: 'New roof', ownerUserId: c.userId, targetCents: 100_000, targetDate: null });
    addContribution({ goalId, amountCents: 10_000, date: '2026-09-01', userId: c.userId });
    expect(outbox('goal_reached')).toEqual([]);
  });
});

/**
 * Review B7. The missed-payment check read loan_postings.payments_cents -- a figure frozen when the
 * period closed. Postings are written onConflictDoNothing, so a payment imported AFTERWARDS (a
 * statement that arrives a week late, which is the ordinary case) never updates that column. The
 * ledger card recomputed the period from the payments themselves and showed the payment; the
 * notification, reading the frozen figure, said none was recorded. Two screens, one period,
 * opposite answers.
 */
describe('B7: missed-payment reads the payments, not a frozen column', () => {
  it('stays quiet when the payment was imported after the period closed', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan();
    // The period closes with nothing recorded -- payments_cents is frozen at zero.
    postAllDueInterest('2026-09-18', NOW);
    expect(
      (
        c.t.sqlite
          .prepare("select payments_cents as p from loan_postings where item_id = ? and period_end = '2026-09-01'")
          .get(itemId) as { p: number }
      ).p,
    ).toBe(0);

    // The statement arrives late, carrying a payment dated INSIDE that period.
    const txnId = c.spend('CAR LOAN PAYMENT', -45_000, { date: '2026-08-15' });
    assignTransactionToLoan({ txnId, itemId, viewer: HOUSEHOLD_VIEWER, at: new Date('2026-09-17T12:00:00.000Z') });

    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(0);
    expect(outbox('loan_payment_missed')).toHaveLength(0);
  });

  it('still fires when nothing was paid into the period at all', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedLoan();
    postAllDueInterest('2026-09-18', NOW);
    // A payment OUTSIDE the closed period says nothing about it.
    const txnId = c.spend('CAR LOAN PAYMENT', -45_000, { date: '2026-09-15' });
    assignTransactionToLoan({ txnId, itemId, viewer: HOUSEHOLD_VIEWER, at: new Date('2026-09-17T12:00:00.000Z') });

    expect(evaluateLoanPaymentMissed({ userId: c.userId, now: NOW, tz: 'UTC' })).toBe(1);
  });
});
