import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { categoryIdByName, createSeededTestDb, insertTestAccount, insertTestUser, type TestDb } from '../../../helpers/db';
import { setUserVisibility } from '@/lib/auth/users';
import { addDaysIso, todayIso } from '@/lib/dates';
import { saveEmailTarget, saveSmtp, setPref } from '@/lib/notify/config';
import { setHouseholdEventPref, upsertHouseholdTarget } from '@/lib/notify/household';
import * as outboxModule from '@/lib/notify/outbox';
import { resetOutboxPumpForTests } from '@/lib/notify/outbox';
import { resetNotifySenderForTests, setNotifySenderForTests } from '@/lib/notify/send';
import { evaluateAnomalies, evaluateSubscriptionCreep, resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';
import { runScheduledEvaluation, resetSlotSkipLogForTests, resetDailyEvaluationSlotForTests } from '@/lib/notify/evaluate';

let t: TestDb;
let accountId: number;
let creatorId: number;
const TZ = 'UTC';
const NOW = new Date('2026-08-18T12:00:00Z');

beforeEach(() => {
  t = createSeededTestDb();
  accountId = insertTestAccount(t.db, { name: 'Joint Chequing' });
  creatorId = insertTestUser(t.db, { username: 'creator' });
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
  setNotifySenderForTests(async () => {});
});

afterEach(() => {
  resetNotifySenderForTests();
  resetOutboxPumpForTests();
  resetAnomalyFingerprintForTests();
  t.cleanup();
});

function emailUser(role: 'admin' | 'member' = 'admin'): number {
  const userId = insertTestUser(t.db, { username: `u${Math.random().toString(36).slice(2, 8)}`, role });
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
  saveEmailTarget({ userId, destination: 'sam@example.com', enabled: true });
  return userId;
}

function charge(over: { merchant: string; cents: number; date: string; categoryId?: number | null }): number {
  const row = t.db.get<{ id: number }>(
    sql`insert into transactions
          (account_id, date, amount_cents, raw_description, normalized_merchant, category_id,
           attributed_user_id, is_transfer, dedup_hash, created_by, created_at, updated_at)
        values (${accountId}, ${over.date}, ${-over.cents}, ${over.merchant}, ${over.merchant}, ${over.categoryId ?? null},
                null, 0, ${`h${Math.random()}`}, ${creatorId}, ${'2026-08-01T00:00:00.000Z'}, ${'2026-08-01T00:00:00.000Z'})
        returning id`,
  );
  return row.id;
}

function keys(): string[] {
  return (t.sqlite.prepare('select dedup_key from notification_outbox order by id').all() as { dedup_key: string }[]).map(
    (r) => r.dedup_key,
  );
}

/** 60+ days of household history, so MUST-9.10 condition 1 is satisfied. */
function seedHistory(): void {
  charge({ merchant: 'ANCHOR', cents: 100, date: '2026-01-01' });
}

/**
 * `count` same-merchant samples at $120, all outside the 14-day candidate window.
 *
 * The count matters: unusualVerdict takes the median of the OTHER rows for that merchant, so a
 * test that plants many outliers needs enough $120 rows to keep that median at $120.
 */
function seedMerchantBaseline(merchant: string, categoryId: number, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String((index % 5) + 2).padStart(2, '0');
    charge({ merchant, cents: 12000, date: `2026-${month}-${day}`, categoryId });
  }
}

/**
 * Same shape as seedMerchantBaseline, but dated relative to `today` rather than to fixed 2026
 * calendar dates, so a floor-boundary test can plant a baseline that is guaranteed to be newer
 * than a deliberately-placed earliest-transaction anchor.
 */
function seedRecentBaseline(merchant: string, categoryId: number, today: string, count = 5): void {
  for (let index = 0; index < count; index += 1) {
    charge({ merchant, cents: 12000, date: addDaysIso(today, -(20 + index)), categoryId });
  }
}

/**
 * Wraps better-sqlite3's own prepare() -- the pattern of tests/lib/loans/matcher.test.ts and
 * tests/lib/predict/history.test.ts -- so a query-count assertion is a fact about what SQL
 * actually ran, not an inference from a return value. The return value alone cannot tell a
 * correctly-skipped evaluation apart from one that ran every query and happened to enqueue
 * nothing new: both report 0 fired.
 */
function countTransactionsQueries(run: () => void): number {
  const original = t.sqlite.prepare.bind(t.sqlite);
  let count = 0;
  const spy = vi.spyOn(t.sqlite, 'prepare').mockImplementation(((source: string) => {
    if (/\btransactions\b/.test(source)) count += 1;
    return original(source);
  }) as typeof t.sqlite.prepare);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return count;
}

describe('MUST-9.10: unusual_transaction end to end', () => {
  it('fires once for a charge three times the merchant baseline', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });

  it('R2: nothing fires at all on a household with under 60 days of history', () => {
    // evaluateAnomalies takes no user, so the user is set up for its side effect only.
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']) {
      charge({ merchant: 'CANADIAN TIRE', cents: 12000, date, categoryId: groceries });
    }
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-9.13: the cap holds at five with twelve candidates, oldest first', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // Twenty baseline rows against twelve outliers keeps the merchant median at $120.
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 17; day += 1) {
      // Amounts differ by a cent each so the duplicate detector, which needs the EXACT same
      // amount, stays out of this test's count.
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.slice(0, 5).map((id) => `unusual:${id}`));
  });

  it('MUST-9.36: the same charge reaches every admin with the event enabled', () => {
    // v1.31.0 owner ruling (item M-8): the audience narrows to role 'admin', not to "every
    // notifiable user" as MUST-9.36 originally read. Both users below are admins (emailUser()'s
    // default), so this still proves the fan-out over MULTIPLE recipients; the narrowing itself
    // is pinned separately below.
    const sam = emailUser();
    const alex = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(2);
    const rows = t.sqlite.prepare('select user_id from notification_outbox where dedup_key = ?').all(`unusual:${outlier}`) as {
      user_id: number;
    }[];
    expect(rows.map((row) => row.user_id).sort()).toEqual([sam, alex].sort());
  });
});

/**
 * R2 (final-fix-wave item 5): the risk table's mitigation named the 60-day household-history
 * floor as what holds a first big import back, but that floor measures min(transactions.date)
 * to today, and a 12-month import spans 365 days the moment it lands, so it clears the floor on
 * the very first tick. The promised test ("drives a 12-month import into a fresh install and
 * asserts zero messages") never existed. This is that test, written honestly: it does not
 * assert zero, it asserts the ACTUAL count, which is what UNUSUAL_MAX_PER_EVALUATION,
 * CREEP_MAX_PER_EVALUATION and DUPLICATE_MAX_PER_EVALUATION actually hold it to.
 */
describe('R2 (final-fix-wave item 5): a 12-month import into a fresh install is capped, not silenced', () => {
  it('the first tick and the first daily slot together produce the real, capped message count', () => {
    emailUser();
    resetSlotSkipLogForTests();
    resetDailyEvaluationSlotForTests();

    // runScheduledEvaluation reads its tz from readEnv(), which resolves to the test
    // environment's TZ (America/Toronto, EDT/UTC-4 in August), not this file's own UTC
    // constant. 13:00 UTC is 09:00 local Wednesday: inside the daily catch-up window
    // (dailyHour defaults to 8) so budget_pace/subscription_creep/monthBoundary all run, but
    // outside the weekly one (digestWeekday defaults to Monday, and hoursSince here is 49
    // against a 48h window), so the weekly digest's own message does not add uncertainty to
    // the count. The calendar date is 2026-08-19 in both UTC and Toronto at this instant, so
    // the transaction dates below (anchored to this file's UTC `today`) line up with what the
    // evaluators compute as "today" too.
    const importNow = new Date('2026-08-19T13:00:00Z');
    const today = todayIso(importNow, TZ);

    // 8 merchants, each with a $40.00 baseline (5 charges, 150 to 350 days old, 50 days apart
    // so the gap never reads as a monthly rhythm) and one $150.00 charge in the last two
    // weeks: 8 unusual_transaction candidates, more than that detector's 5-per-evaluation cap.
    for (let i = 1; i <= 8; i += 1) {
      const merchant = `IMPORT SHOP ${i}`;
      for (const offset of [350, 300, 250, 200, 150]) {
        charge({ merchant, cents: 4000, date: addDaysIso(today, -offset) });
      }
      charge({ merchant, cents: 15000, date: addDaysIso(today, -(1 + i)) });
    }

    // 8 recurring merchants, three monthly charges at $15.00 then a fourth, recent one at
    // $17.00 (a 13 percent, $2.00 rise): 8 subscription_creep candidates, again more than that
    // detector's cap. Both amounts sit under unusual_transaction's $50 floor, and no amount
    // repeats within 3 days of itself, so these never cross into the other two detectors.
    for (let i = 1; i <= 8; i += 1) {
      const merchant = `IMPORT SUB ${i}`;
      for (const offset of [100, 70, 40]) {
        charge({ merchant, cents: 1500, date: addDaysIso(today, -offset) });
      }
      charge({ merchant, cents: 1700, date: addDaysIso(today, -(4 + i)) });
    }

    // 3 merchants charged twice at an identical $25.00 a day apart, in the last two weeks: 3
    // duplicate_charge candidates, under that detector's cap so all 3 are expected to fire.
    // $25.00 is also under unusual_transaction's floor and these merchants carry no other
    // history, so creepVerdict's 4-charge minimum is never met either.
    for (let i = 1; i <= 3; i += 1) {
      const merchant = `IMPORT DUPE ${i}`;
      charge({ merchant, cents: 2500, date: addDaysIso(today, -3) });
      charge({ merchant, cents: 2500, date: addDaysIso(today, -2) });
    }

    expect((t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number }).n).toBe(0);

    runScheduledEvaluation(importNow);

    const total = (t.sqlite.prepare('select count(*) as n from notification_outbox').get() as { n: number }).n;
    // The real figure: 5 unusual (of 8 candidates, capped) + 5 creep (of 8, capped) + 3
    // duplicate (of 3, under its cap) = 13. Comfortably inside the "roughly 10 to 15" the
    // fix-wave review accepted as documented behaviour from these three caps acting together,
    // and nowhere near either the zero the spec wrongly promised or the "dozens" R2 warns
    // about with the caps removed.
    expect(total).toBe(13);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(15);
  });
});

describe('MUST-9.10 condition 1: the 60-day household-history floor', () => {
  it('is silent at exactly 59 days of history', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const today = todayIso(NOW, TZ);
    charge({ merchant: 'ANCHOR', cents: 100, date: addDaysIso(today, -59) });
    seedRecentBaseline('CANADIAN TIRE', groceries, today);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: addDaysIso(today, -4), categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
  });

  it('fires at exactly 60 days of history', () => {
    emailUser();
    const groceries = categoryIdByName(t.db, 'Groceries');
    const today = todayIso(NOW, TZ);
    charge({ merchant: 'ANCHOR', cents: 100, date: addDaysIso(today, -60) });
    seedRecentBaseline('CANADIAN TIRE', groceries, today);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: addDaysIso(today, -4), categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });
});

describe('MUST-9.13: the cap boundary', () => {
  it('fires all five when there are exactly five candidates', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 10; day += 1) {
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.map((id) => `unusual:${id}`));
  });

  it('fires all three when there are fewer than five candidates', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('BIG SHOP', groceries, 20);
    const ids: number[] = [];
    for (let day = 6; day <= 8; day += 1) {
      ids.push(
        charge({ merchant: 'BIG SHOP', cents: 90000 + day, date: `2026-08-${String(day).padStart(2, '0')}`, categoryId: groceries }),
      );
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(3);
    expect(keys()).toEqual(ids.map((id) => `unusual:${id}`));
  });
});

describe('MUST-10.4 to MUST-10.6: the tick fingerprint', () => {
  it('short-circuits a second evaluation with no data change', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toHaveLength(1);
  });

  it('a new transaction after a first evaluation fires on the next tick (count/maxId changed)', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // Nothing unusual exists yet: this pass only establishes the fingerprint.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);

    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    // A genuinely new row moves both count and maxId, so this tick is not a repeat.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${outlier}`]);
  });

  it('MUST-10.5: re-categorising an existing row changes the fingerprint and flips the outcome from 0 to 1', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    // A category baseline of five, at a merchant DIFFERENT from the candidate below, so the
    // candidate has no merchant baseline of its own and can only qualify via the category.
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // Uncategorised: neither a merchant baseline (unique merchant) nor a category baseline
    // (no category at all) exists yet, so this cannot fire no matter how large it is.
    const candidate = charge({ merchant: 'NEW SHOP', cents: 41288, date: '2026-08-14', categoryId: null });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);

    // Re-categorising into groceries, which already has five same-category samples, unlocks
    // the category baseline. A mutant that ignores this update (a constant or otherwise broken
    // fingerprint) would incorrectly keep skipping and report 0 here instead of 1, which a bare
    // "returns 0 again" assertion could never distinguish from the correct skip-then-rerun.
    t.db.run(sql`update transactions set category_id = ${groceries}, updated_at = '2026-08-18T13:00:00.000Z' where id = ${candidate}`);
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`unusual:${candidate}`]);
  });

  it('MUST-10.10 and AC8: zero participants means zero work and no burned fingerprint', () => {
    const userId = emailUser();
    setPref(userId, 'unusual_transaction', 'email', false);
    setPref(userId, 'unusual_transaction', 'telegram', false);
    setPref(userId, 'duplicate_charge', 'email', false);
    setPref(userId, 'duplicate_charge', 'telegram', false);
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    for (let tick = 0; tick < 12; tick += 1) expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    expect(keys()).toEqual([]);
  });

  it('MUST-10.6: an error partway through the participant loop does not burn the fingerprint, so the next tick still evaluates', () => {
    const sam = emailUser();
    const alex = emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    // sam has the lower user id and is processed first; alex's enqueue call is made to throw.
    expect(alex).toBeGreaterThan(sam);
    const realEnqueue = outboxModule.enqueue;
    let calls = 0;
    const spy = vi.spyOn(outboxModule, 'enqueue').mockImplementation((input) => {
      calls += 1;
      if (calls === 2) throw new Error('enqueue boom');
      return realEnqueue(input);
    });
    try {
      expect(() => evaluateAnomalies({ now: NOW, tz: TZ })).toThrow('enqueue boom');
    } finally {
      spy.mockRestore();
    }
    // Only sam's row landed before the throw killed the pass.
    expect(keys()).toHaveLength(1);

    // Nothing about the data changed between the two calls, but the fingerprint was never
    // recorded on the failed pass (MUST-10.6's post-loop placement, anomalies.ts's
    // `lastAnomalyKey = key` after the participant loop), so this tick re-evaluates instead of
    // short-circuiting, and alex finally receives the delivery the first pass never reached.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toHaveLength(2);
  });
});

describe('MUST-10.9 and AC8: statement counts prove the guard actually skips work', () => {
  it('an unchanged fingerprint performs exactly the one indexed count query and nothing else', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);

    // MUST-10.9 promises this tick costs one indexed count query and nothing more: no slice
    // read, no baseline query. Counting actual prepared statements, rather than trusting the
    // return value, is what catches a mutant that deletes the short-circuit: that mutant also
    // happens to return 0 here (the finding is already enqueued) while still re-running every
    // query to get there.
    const transactionQueries = countTransactionsQueries(() => {
      expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    });
    expect(transactionQueries).toBe(1);
  });

  it('AC8, verbatim: a zero-participant tick performs no transactions query at all', () => {
    const userId = emailUser();
    setPref(userId, 'unusual_transaction', 'email', false);
    setPref(userId, 'unusual_transaction', 'telegram', false);
    setPref(userId, 'duplicate_charge', 'email', false);
    setPref(userId, 'duplicate_charge', 'telegram', false);
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    // With no participant, the code returns before the fingerprint query is even built, so
    // not even the one-query cost of the guarded case applies here.
    const transactionQueries = countTransactionsQueries(() => {
      expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(0);
    });
    expect(transactionQueries).toBe(0);
  });
});

describe('MUST-9.20 to MUST-9.24: duplicate_charge end to end', () => {
  it('fires once per pair and says the wording MUST-14.10 requires', () => {
    emailUser();
    seedHistory();
    const first = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-12' });
    const second = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-13' });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`dupe:${first}:${second}`]);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('It may be a real second charge, or the bank may have reported one charge twice.');
  });

  it('caps at five duplicate pairs, oldest first, with seven candidate pairs', () => {
    emailUser();
    seedHistory();
    const ids: { first: number; second: number }[] = [];
    for (let index = 0; index < 7; index += 1) {
      const merchant = `DUPE MERCHANT ${index}`;
      const first = charge({ merchant, cents: 1500, date: '2026-08-12' });
      const second = charge({ merchant, cents: 1500, date: '2026-08-13' });
      ids.push({ first, second });
    }
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(5);
    expect(keys()).toEqual(ids.slice(0, 5).map((pair) => `dupe:${pair.first}:${pair.second}`));
  });
});

describe('MUST-9.15 to MUST-9.19: subscription_creep on the daily slot', () => {
  it('fires once for a monthly subscription whose price went up', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    const risen = charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });

    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(1);
    expect(keys()).toEqual([`creep:${risen}`]);
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a merchant with no recurring rhythm', () => {
    const userId = emailUser();
    seedHistory();
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-11' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-12' });
    charge({ merchant: 'CAFE', cents: 500, date: '2026-08-13' });
    charge({ merchant: 'CAFE', cents: 900, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });

  it('is silent for a user with the event switched off', () => {
    const userId = emailUser();
    setPref(userId, 'subscription_creep', 'email', false);
    setPref(userId, 'subscription_creep', 'telegram', false);
    seedHistory();
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-05-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-06-14' });
    charge({ merchant: 'NETFLIX', cents: 1649, date: '2026-07-14' });
    charge({ merchant: 'NETFLIX', cents: 2099, date: '2026-08-14' });
    expect(evaluateSubscriptionCreep({ userId, now: NOW, tz: TZ })).toBe(0);
  });
});

describe('evaluator-to-renderer wiring', () => {
  it('the rendered body carries the real account name and, on a category-baseline verdict, the real category name', () => {
    emailUser();
    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    // A one-off merchant with no baseline of its own, categorised into groceries: the verdict
    // can only come from the category baseline, which is the branch that names the category
    // rather than the merchant (render.ts's baselineKind === 'category' case).
    charge({ merchant: 'ONE OFF SHOP', cents: 41288, date: '2026-08-14', categoryId: groceries });
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);
    const body = (t.sqlite.prepare('select body from notification_outbox limit 1').get() as { body: string }).body;
    expect(body).toContain('Joint Chequing');
    expect(body).toContain('Groceries');
  });
});

/**
 * v1.31.0 owner ruling (item M-8, docs/reviews/2026-09-02-review-for-opus.md). v1.30.0 closed
 * every OTHER path by which household money figures reached a self-scoped member by push,
 * leaving unusual_transaction and duplicate_charge alone as documented, intentional exceptions
 * (MUST-9.36 -- "a large charge is a household fact"). The owner has now ruled: narrow the
 * AUDIENCE to admins rather than scope the figures (which would gut the feature: an anomaly
 * alert is only useful when it names the charge somebody did not recognise) or drop the feature
 * (which would lose a genuine early warning). Role is the axis, not visibility -- an admin whose
 * row says visibility 'self' stays unrestricted (micro-ruling M1) -- so these tests exercise
 * every combination: a household-visibility member, a self-scoped member, a household-visibility
 * admin and a self-scoped admin.
 */
describe('owner ruling (v1.31.0, item M-8): unusual_transaction and duplicate_charge narrow to admins', () => {
  it('a household-visibility member and a self-scoped member get neither event; every admin, self-scoped or not, gets both unchanged', () => {
    const admin = emailUser('admin');
    const adminSelf = emailUser('admin');
    // setUserVisibility refuses the admin+self pairing (micro-ruling M1), so the row is written
    // directly -- this IS the hand-edited-database case that refusal exists for, and per the
    // ruling this admin must be treated as unrestricted regardless.
    t.db.run(sql`update users set visibility = 'self' where id = ${adminSelf}`);
    const member = emailUser('member');
    const memberSelf = emailUser('member');
    setUserVisibility(memberSelf, 'self');

    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });
    const first = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-12' });
    const second = charge({ merchant: 'BELL CANADA', cents: 8950, date: '2026-08-13' });

    // Proves the scenario actually produced deliveries, without pinning an exact count: the
    // count alone cannot tell "nobody ineligible got a row" apart from "nobody got anything at
    // all", which is exactly why the assertions below read the outbox rows themselves.
    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBeGreaterThan(0);

    const rows = t.sqlite
      .prepare('select user_id, dedup_key, body from notification_outbox order by id')
      .all() as { user_id: number | null; dedup_key: string; body: string }[];

    // The bug this pins: a non-admin -- household-visibility or self-scoped -- used to receive
    // both events, naming a charge that may not even be theirs. Asserted on the actual outbox
    // rows (the rendered body), not on evaluateAnomalies' return value.
    expect(rows.filter((r) => r.user_id === member)).toEqual([]);
    expect(rows.filter((r) => r.user_id === memberSelf)).toEqual([]);

    // Every admin, self-scoped or not, still gets both events, unchanged.
    for (const adminId of [admin, adminSelf]) {
      const adminRows = rows.filter((r) => r.user_id === adminId);
      expect(adminRows.map((r) => r.dedup_key).sort()).toEqual(
        [`unusual:${outlier}`, `dupe:${first}:${second}`].sort(),
      );
      expect(adminRows.some((r) => r.body.includes('CANADIAN TIRE'))).toBe(true);
      expect(adminRows.some((r) => r.body.includes('BELL CANADA'))).toBe(true);
    }

    // No stray recipients: the four rows above (two admins x two events) are the whole outbox.
    expect(rows).toHaveLength(4);
  });
});

describe('owner ruling (v1.31.0, item M-8): the family channel keeps working for a household-eligible anomaly event', () => {
  /**
   * The trap two earlier agents hit on this exact subsystem (v1.30.0's two S-18 corrections):
   * narrowing a per-user delivery must not silence the shared family channel. unusual_transaction
   * is householdEligible (events.ts), so an admin may still route it to the family room exactly
   * as before this ruling -- that is a distinct, admin-opted-into decision from the personal
   * audience this ruling narrows. This household's only non-admin is self-scoped, the case v1.30.0
   * round 0 got wrong for budget alerts (skipping the household loop for them silenced the room).
   */
  it('is byte-identical whether or not a self-scoped member is even in the household', () => {
    const admin = emailUser('admin');
    const selfMember = emailUser('member');
    setUserVisibility(selfMember, 'self');

    expect(
      upsertHouseholdTarget({ channel: 'email', destination: 'family@example.invalid', actorUserId: creatorId }).ok,
    ).toBe(true);
    expect(setHouseholdEventPref({ eventId: 'unusual_transaction', channel: 'email', enabled: true }).ok).toBe(true);

    seedHistory();
    const groceries = categoryIdByName(t.db, 'Groceries');
    seedMerchantBaseline('CANADIAN TIRE', groceries);
    const outlier = charge({ merchant: 'CANADIAN TIRE', cents: 41288, date: '2026-08-14', categoryId: groceries });

    expect(evaluateAnomalies({ now: NOW, tz: TZ })).toBe(1);

    const rows = t.sqlite
      .prepare('select user_id, channel, dedup_key, body from notification_outbox order by id')
      .all() as { user_id: number | null; channel: string; dedup_key: string; body: string }[];

    const familyRows = rows.filter((r) => r.user_id === null);
    expect(familyRows).toHaveLength(1);
    expect(familyRows[0].channel).toBe('email');
    expect(familyRows[0].dedup_key).toBe(`hh:unusual:${outlier}`);
    expect(familyRows[0].body).toContain('CANADIAN TIRE');
    expect(familyRows[0].body).toContain('Joint Chequing');

    // No personal copy for anybody: the admin's email is routed to the family channel instead
    // (v1.28.0 decision 4), and the self-scoped member is off the recipient list entirely (this
    // ruling) -- so removing them from the household changes nothing about the row above.
    expect(rows.filter((r) => r.user_id === admin)).toEqual([]);
    expect(rows.filter((r) => r.user_id === selfMember)).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});
