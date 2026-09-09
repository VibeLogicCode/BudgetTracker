import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../helpers/db';
import { normalizeMerchant } from '@/lib/categorize/normalize';
import { closeMonth, closeMonthsAutomatically, closedMonthsAwaitingSummary, markMonthSummarySent, monthState, openMonths } from '@/lib/month-close';

/**
 * 2026-09-08. Owner report: "what happens if 1 of the accounts doesnt have any entry for 15 days in
 * next month and there is nothing to import ... because we have simplefin too transactions can auto
 * come in too using logic we have now is not reliable."
 *
 * He is right, and these tests pin the answer: a manual account's completeness is a HUMAN
 * statement, a SimpleFIN-linked account's is a machine one, and nothing is ever inferred from
 * import timing.
 */
let t: TestDb;
let userId: number;

beforeEach(() => {
  t = createSeededTestDb();
  userId = insertTestUser(t.db, { username: 'owner' });
});
afterEach(() => t.cleanup());

function spend(accountId: number, date: string): void {
  t.db.run(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${date}, -1000, ${'SHOP'}, ${normalizeMerchant('SHOP')}, 0, ${`h${Math.random()}`}, ${userId}, ${`${date}T00:00:00.000Z`}, ${`${date}T00:00:00.000Z`})`,
  );
}

describe('which months are open', () => {
  it('lists ended months with no closure, oldest first, and never the month in progress', () => {
    const account = insertTestAccount(t.db, { name: 'Chequing' });
    spend(account, '2026-07-05');
    spend(account, '2026-09-02');

    const open = openMonths(new Date('2026-09-08T12:00:00Z'));
    expect(open).toEqual(['2026-07', '2026-08']);
    // September is not late, it is simply not over.
    expect(open).not.toContain('2026-09');
  });

  it('is empty on a household with no transactions at all', () => {
    insertTestAccount(t.db, { name: 'Chequing' });
    // A fresh install must not present months of homework for a period it holds nothing about.
    expect(openMonths(new Date('2026-09-08T12:00:00Z'))).toEqual([]);
  });

  it('drops a month once it is closed', () => {
    const account = insertTestAccount(t.db, { name: 'Chequing' });
    spend(account, '2026-07-05');
    closeMonth('2026-07', userId, new Date('2026-08-02T00:00:00Z'));
    expect(openMonths(new Date('2026-08-08T12:00:00Z'))).toEqual([]);
  });
});

describe('a manual account needs a person to say the month is complete', () => {
  it('asks for confirmation, and never closes itself', () => {
    const account = insertTestAccount(t.db, { name: 'Savings' });
    spend(account, '2026-07-05');

    const state = monthState('2026-07');
    expect(state.needsConfirmation).toBe(true);
    expect(state.closed).toBe(false);

    // THE OWNER'S CASE: a quiet account with nothing to import in the new month. No inference over
    // import timing could ever distinguish that from a statement that has not arrived, so the app
    // does not try — it waits to be told.
    expect(closeMonthsAutomatically(new Date('2026-09-01T12:00:00Z'))).toEqual([]);
    expect(monthState('2026-07').closed).toBe(false);
  });

  it('closes when a person says so, and records who', () => {
    const account = insertTestAccount(t.db, { name: 'Savings' });
    spend(account, '2026-07-05');
    closeMonth('2026-07', userId, new Date('2026-08-09T00:00:00Z'));

    expect(monthState('2026-07').closed).toBe(true);
    const row = t.sqlite.prepare('select closed_by from month_closures where month = ?').get('2026-07') as {
      closed_by: number;
    };
    expect(row.closed_by).toBe(userId);
  });
});

describe('the summary is enqueued once per closed month', () => {
  it('reports a closed month as awaiting its summary until it is marked sent', () => {
    closeMonth('2026-07', userId, new Date('2026-08-09T00:00:00Z'));
    expect(closedMonthsAwaitingSummary()).toEqual(['2026-07']);

    markMonthSummarySent('2026-07', new Date('2026-08-09T09:00:00Z'));
    expect(closedMonthsAwaitingSummary()).toEqual([]);
  });

  it('returns two closed months oldest first, so a holiday catches up in order', () => {
    closeMonth('2026-08', userId, new Date('2026-09-07T00:00:00Z'));
    closeMonth('2026-07', userId, new Date('2026-09-07T00:00:00Z'));
    expect(closedMonthsAwaitingSummary()).toEqual(['2026-07', '2026-08']);
  });

  it('marking twice is harmless', () => {
    closeMonth('2026-07', userId, new Date('2026-08-09T00:00:00Z'));
    markMonthSummarySent('2026-07', new Date('2026-08-09T09:00:00Z'));
    const first = t.sqlite.prepare('select summary_sent_at from month_closures where month = ?').get('2026-07') as {
      summary_sent_at: string;
    };
    // The second call must not move the timestamp: it is a record of when the household was told.
    markMonthSummarySent('2026-07', new Date('2026-08-20T09:00:00Z'));
    const second = t.sqlite.prepare('select summary_sent_at from month_closures where month = ?').get('2026-07') as {
      summary_sent_at: string;
    };
    expect(second.summary_sent_at).toBe(first.summary_sent_at);
  });
});
