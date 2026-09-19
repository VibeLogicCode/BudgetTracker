import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { setupLoanTest, type LoanTestContext } from './fixtures';
import { assignTransactionToLoan, setLoanAnchor } from '@/lib/loans';
import { runNightlyJob } from '@/lib/backup';
import { runNotifyTick } from '@/lib/scheduler';
import { saveEmailTarget, saveSmtp } from '@/lib/notify/config';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';

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

/**
 * P3: the ledger keeps itself current. The owner asked for interest that runs nightly without
 * being asked, and for a machine that was switched off to catch up when it comes back.
 */
function seedInterestLoan(): number {
  const { itemId } = c.seedLoan({ balanceCents: 1_000_000, principalCents: 1_000_000 });
  c.t.sqlite
    .prepare(
      `update warranty_items set purchase_date = '2026-07-01', interest_rate_bps = 1000, interest_rate_basis = 'apr_monthly' where id = ?`,
    )
    .run(itemId);
  setLoanAnchor({
    itemId,
    asOfDate: '2026-07-01',
    balanceCents: 1_000_000,
    source: 'form',
    actorUserId: c.userId,
    at: new Date('2026-07-01T12:00:00.000Z'),
  });
  c.t.sqlite
    .prepare(
      `insert into loan_rate_history (item_id, effective_from, rate_bps, basis, created_at)
       values (?, '2026-07-01', 1000, 'apr_monthly', '2026-07-01T12:00:00.000Z')`,
    )
    .run(itemId);
  return itemId;
}

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

const outbox = (eventId: string) =>
  c.t.sqlite
    .prepare('select dedup_key, subject, body from notification_outbox where event_id = ? order by id')
    .all(eventId) as { dedup_key: string; subject: string; body: string }[];

describe('P3: the nightly job posts due interest', () => {
  it('brings every loan up to date', () => {
    c = setupLoanTest();
    const itemId = seedInterestLoan();
    runNightlyJob(new Date('2026-09-18T02:00:00.000Z'));
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  /** A posting failure must never stop the backup: the sweep is the less important of the two. */
  it('still backs up when a loan cannot be posted', () => {
    c = setupLoanTest();
    seedInterestLoan();
    c.t.sqlite.prepare(`update warranty_items set purchase_date = 'not-a-date' where interest_rate_basis is not null`).run();
    expect(() => runNightlyJob(new Date('2026-09-18T02:00:00.000Z'))).not.toThrow();
  });
});

describe('P3: the boot tick catches up', () => {
  it('posts what a switched-off machine missed', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedInterestLoan();
    runNotifyTick(new Date('2026-09-18T09:00:00.000Z'), { atBoot: true });
    expect(c.balanceOf(itemId)).toBe(1_016_736);
  });

  /** An ordinary five-minute tick does not re-sweep every loan; the nightly job owns that. */
  it('does not sweep on an ordinary tick', () => {
    c = setupLoanTest();
    emailTarget();
    const itemId = seedInterestLoan();
    runNotifyTick(new Date('2026-09-18T09:05:00.000Z'));
    expect(c.balanceOf(itemId)).toBe(1_000_000);
  });
});

describe('N5: loan_paid_off', () => {
  it('is raised once when a payment clears the balance', () => {
    c = setupLoanTest();
    emailTarget();
    const { itemId } = c.seedLoan({ balanceCents: 50_000 });
    const txnId = c.spend('LENDER', -50_000, { date: '2026-09-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-10T12:00:00.000Z') });

    const rows = outbox('loan_paid_off');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedup_key).toBe(`loan:paidoff:${itemId}`);
    expect(rows[0]!.subject).toContain('paid off');
  });

  it('is not raised while anything is still owed', () => {
    c = setupLoanTest();
    emailTarget();
    const { itemId } = c.seedLoan({ balanceCents: 50_000 });
    const txnId = c.spend('LENDER', -20_000, { date: '2026-09-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-10T12:00:00.000Z') });
    expect(outbox('loan_paid_off')).toEqual([]);
  });

  /** A loan that was already at zero has not just been paid off. */
  it('is not raised by a payment against a loan already at zero', () => {
    c = setupLoanTest();
    emailTarget();
    const { itemId } = c.seedLoan({ balanceCents: 0 });
    const txnId = c.spend('LENDER', -5_000, { date: '2026-09-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-10T12:00:00.000Z') });
    expect(outbox('loan_paid_off')).toEqual([]);
  });

  it('says it the other way round for money lent out', () => {
    c = setupLoanTest();
    emailTarget();
    const { itemId } = c.seedLoan({ balanceCents: 50_000, direction: 'lent' });
    const txnId = c.spend('FRIEND', 50_000, { date: '2026-09-10' });
    assignTransactionToLoan({ txnId, itemId, at: new Date('2026-09-10T12:00:00.000Z') });
    expect(outbox('loan_paid_off')[0]!.body).toMatch(/repaid in full/i);
  });
});
