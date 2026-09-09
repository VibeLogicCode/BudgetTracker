import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createTestDb, insertTestUser, type TestDb } from '../../../helpers/db';
import { nowIso } from '@/lib/clock';
import { weeklyDigestKey } from '@/lib/notify/events';
import * as digestModule from '@/lib/notify/evaluate/digest';
import { runScheduledEvaluation, resetSlotSkipLogForTests, resetDailyEvaluationSlotForTests } from '@/lib/notify/evaluate';
import { resetAnomalyFingerprintForTests } from '@/lib/notify/evaluate/anomalies';
import * as paceModule from '@/lib/notify/evaluate/pace';
import * as anomaliesModule from '@/lib/notify/evaluate/anomalies';
import * as monthlyModule from '@/lib/notify/evaluate/monthly';
import * as budgetModule from '@/lib/notify/evaluate/budget';
import * as savingsModule from '@/lib/notify/evaluate/savings';

let t: TestDb;
const originalTz = process.env.TZ;

beforeEach(() => {
  t = createTestDb();
  process.env.TZ = 'UTC';
  resetSlotSkipLogForTests();
  resetAnomalyFingerprintForTests();
  resetDailyEvaluationSlotForTests();
});

afterEach(() => {
  process.env.TZ = originalTz;
  resetSlotSkipLogForTests();
  resetAnomalyFingerprintForTests();
  resetDailyEvaluationSlotForTests();
  t.cleanup();
});

describe('slot-skip logging is deduped by (kind, userId, slotDate)', () => {
  it('logs a skipped slot once, not once per tick, and again only when the slot date changes', () => {
    insertTestUser(t.db);
    // dailyHour defaults to 8; at 22:00 UTC hoursSince = 14 > DAILY_MAX_CATCHUP_HOURS (12),
    // so the daily slot is outside its catch-up window on both calendar days below.
    const day1 = new Date('2026-08-17T22:00:00Z');
    const day2 = new Date('2026-08-18T22:00:00Z');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runScheduledEvaluation(day1);
      runScheduledEvaluation(day1);
      const dailyLines = () => logSpy.mock.calls.filter((args) => typeof args[0] === 'string' && args[0].includes('(daily)'));
      expect(dailyLines()).toHaveLength(1);
      expect(dailyLines()[0][0]).toContain('2026-08-17');

      runScheduledEvaluation(day2);
      expect(dailyLines()).toHaveLength(2);
      expect(dailyLines()[1][0]).toContain('2026-08-18');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('MUST-10.9 (final-fix-wave item 4): the three newer daily evaluators run once per slot, not once per tick', () => {
  /**
   * v1.32.0 (ruling R23): each of the three now runs TWICE per daily slot with one member in the
   * household -- once for that member (`userId: <id>`) and once for the family channel itself
   * (`userId: null`, from runHouseholdEvaluation). The counts below assert the pair rather than a
   * bare number, so this test still fails if either pass loses its once-per-slot cache and starts
   * recomputing on every five-minute tick -- which is the thing MUST-10.9 is about.
   */
  const recipients = (spy: { mock: { calls: unknown[][] } }): unknown[] =>
    spy.mock.calls.map((args) => (args[0] as { userId: number | null }).userId);

  it('two ticks inside the same daily window run them once per recipient, and a new slot date runs them again', () => {
    const userId = insertTestUser(t.db);
    // dailyHour defaults to 8; 09:00 UTC on the 17th and 09:05 UTC on the 17th are both inside
    // the same daily slot (slotDate '2026-08-17'). 09:00 on the 18th is the next day's slot.
    const paceSpy = vi.spyOn(paceModule, 'evaluateBudgetPace').mockReturnValue(0);
    const creepSpy = vi.spyOn(anomaliesModule, 'evaluateSubscriptionCreep').mockReturnValue(0);
    // 2026-09-09: evaluateMonthBoundary is NO LONGER one of them. Its trigger is the month being
    // closed, not a slot, so it moved into flushMonthSummaries -- which owns the loop over every
    // recipient precisely so it can mark the month sent once everybody has been evaluated. Its
    // own once-per-month guard is the summary_sent_at column, not this in-memory slot cache.
    const monthlySpy = vi.spyOn(monthlyModule, 'evaluateMonthBoundary').mockReturnValue(0);
    try {
      runScheduledEvaluation(new Date('2026-08-17T09:00:00Z'));
      runScheduledEvaluation(new Date('2026-08-17T09:05:00Z'));
      for (const spy of [paceSpy, creepSpy]) {
        expect(recipients(spy)).toEqual([userId, null]);
      }
      // No month is closed in this fixture, so flushMonthSummaries returns before evaluating
      // anybody -- which is the cheap early-out that lets it run on every tick.
      expect(monthlySpy).not.toHaveBeenCalled();

      runScheduledEvaluation(new Date('2026-08-18T09:00:00Z'));
      for (const spy of [paceSpy, creepSpy]) {
        expect(recipients(spy)).toEqual([userId, null, userId, null]);
      }
    } finally {
      paceSpy.mockRestore();
      creepSpy.mockRestore();
      monthlySpy.mockRestore();
    }
  });
});

describe('the weekly digest existence pre-check', () => {
  // 2026-08-17 is a Monday (slots.ts's mondayOfIsoWeek uses it as KNOWN_MONDAY); digestWeekday
  // defaults to 1 (Monday) and digestHour to 8, so 09:00 UTC on this date is inside the
  // weekly slot's catch-up window with slotDate '2026-08-17'.
  const now = new Date('2026-08-17T09:00:00Z');
  const slotDate = '2026-08-17';

  it('skips recomputing the digest when a row already exists for this user and slot', () => {
    const userId = insertTestUser(t.db);
    const at = nowIso(now);
    // Bypass enqueue()/isEventEnabled entirely — the pre-check only cares whether a row
    // already exists for (user_id, dedup_key), on ANY channel.
    t.db.run(sql`
      insert into notification_outbox (user_id, channel, event_id, dedup_key, subject, body, status, attempts, next_attempt_at, created_at)
      values (${userId}, 'email', 'weekly_digest', ${weeklyDigestKey(slotDate)}, 's', 'b', 'sent', 1, ${at}, ${at})
    `);

    const spy = vi.spyOn(digestModule, 'evaluateWeeklyDigest');
    try {
      runScheduledEvaluation(now);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still recomputes when no digest row exists yet for this slot', () => {
    const userId = insertTestUser(t.db);
    const spy = vi.spyOn(digestModule, 'evaluateWeeklyDigest').mockReturnValue(0);
    try {
      runScheduledEvaluation(now);
      expect(spy).toHaveBeenCalledWith({ userId, slotDate, now });
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Owner report, 2026-09-08: "it shouldnt send notifications on boot. when it reboots it sends
 * notifications about budget."
 *
 * The boot pass exists for SLOT catch-up (MUST-6.1) -- a container that was off overnight still
 * owes yesterday's coming_due and the weekly digest. It never needed to run the TICK-triggered
 * evaluators, which describe a current state and will say the same thing five minutes later.
 *
 * It turned loud in v1.32.0: the family channel gained its own pass (R23), so on the first boot
 * after that upgrade every household dedup key was unwritten and every over-budget category fired
 * into the family channel at once.
 */
describe('the boot pass does not fire tick-triggered events', () => {
  it('skips anomalies when atBoot is set', () => {
    const anomalies = vi.spyOn(anomaliesModule, 'evaluateAnomalies').mockReturnValue(0);
    try {
      runScheduledEvaluation(new Date('2026-09-08T12:00:00Z'), { atBoot: true });
      expect(anomalies).not.toHaveBeenCalled();
    } finally {
      anomalies.mockRestore();
    }
  });

  it('never fires per-category budget alerts at all -- they are a section of the weekly summary now', () => {
    const budgets = vi.spyOn(budgetModule, 'evaluateBudgets').mockReturnValue(0);
    try {
      // Both paths. The owner's complaint was six messages for four budgets; the figures moved
      // into the digest (evaluate/digest.ts, collectBudgets) and this evaluator stopped running.
      runScheduledEvaluation(new Date('2026-09-08T12:00:00Z'), { atBoot: true });
      runScheduledEvaluation(new Date('2026-09-08T12:05:00Z'));
      expect(budgets).not.toHaveBeenCalled();
    } finally {
      budgets.mockRestore();
    }
  });

  it('still fires them on an ordinary tick', () => {
    const anomalies = vi.spyOn(anomaliesModule, 'evaluateAnomalies').mockReturnValue(0);
    try {
      // No options at all -- the cron path. If this ever stopped firing, the anomaly alerts would
      // go silent entirely, which is a far worse defect than the burst this change removes.
      runScheduledEvaluation(new Date('2026-09-08T12:05:00Z'));
      expect(anomalies).toHaveBeenCalledTimes(1);
    } finally {
      anomalies.mockRestore();
    }
  });

  it('2026-09-09: savings_target_met no longer fires on ANY tick -- it is a monthly-summary line', () => {
    // It fired the moment net first crossed the target, which for a household paid monthly is a
    // push on payday every month about something the Savings page already showed. The fact belongs
    // to the month, so it is now a line in the monthly summary (evaluate/monthly.ts).
    const savings = vi.spyOn(savingsModule, 'evaluateSavingsTargetMet').mockReturnValue(0);
    try {
      runScheduledEvaluation(new Date('2026-09-08T12:00:00Z'), { atBoot: true });
      runScheduledEvaluation(new Date('2026-09-08T12:05:00Z'));
      expect(savings).not.toHaveBeenCalled();
    } finally {
      savings.mockRestore();
    }
  });

  it('the scheduler passes atBoot ONLY on the boot call, never on the cron one', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/scheduler.ts'), 'utf8');
    // The cron registration calls it bare; the boot call carries the flag. Getting these the wrong
    // way round would silence every budget alert forever, so it is pinned rather than assumed.
    expect(source).toContain('runNotifyTick(new Date(), { atBoot: true })');
    expect(source).toMatch(/runNotifyTick\(\);/);
  });
});
