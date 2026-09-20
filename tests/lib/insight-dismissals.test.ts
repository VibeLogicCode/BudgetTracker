import { describe, it, expect, afterEach } from 'vitest';
import { createAccount } from '@/lib/accounts';
import { createUser } from '@/lib/auth/users';
import type { Viewer } from '@/lib/auth/viewer';
import { INSIGHTS_MAX_ROWS, householdInsights } from '@/lib/insights';
import { dismissInsight, isDismissalKey, listDismissedKeys, pruneInsightDismissals } from '@/lib/insight-dismissals';
import { createManualTransaction } from '@/lib/transactions';
import { createTestDb, type TestDb } from '../helpers/db';

const TODAY = '2026-08-27';

let current: TestDb | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

/**
 * Reported 2026-09-20: "how do i get rid of take a look? it goes to transactions with no way to
 * clear it". The card had no dismiss at all, and the reason recorded in its own docblock -- that a
 * card with a dismiss is a card somebody dismisses once and never sees again -- was an argument
 * about dismissing the WHOLE CARD. It does not answer the question asked, which is what to do with
 * one charge you have already looked at and decided is fine.
 *
 * So: per FINDING, never per merchant. The next charge at the same merchant is a different
 * transaction and a different question, and a merchant whitelist is how a detector quietly turns
 * into a list of exceptions nobody revisits.
 */
describe('dismissing one finding', () => {
  let adultId = 0;
  let accountId = 0;

  const seed = async () => {
    current = createTestDb();
    adultId = (await createUser({ name: 'Person One', username: 'user-1', password: 'correct horse 9', role: 'admin' })).id;
    accountId = createAccount({ name: 'Chequing', type: 'chequing', ownerUserId: adultId });
  };

  const adult = (): Viewer => ({ id: adultId, role: 'admin', visibility: 'household' });

  const spend = (date: string, description: string, cents: number) =>
    createManualTransaction({
      accountId,
      date,
      description,
      amountCents: -cents,
      categoryId: null,
      attributedUserId: adultId,
      userId: adultId,
      actorRole: 'admin',
    });

  /**
   * Twelve months of ordinary charges ending recently, so the merchant has enough samples INSIDE
   * the 365-day baseline for a charge to be unusual against it (UNUSUAL_MIN_SAMPLES).
   */
  const withHistory = () => {
    for (let month = 8; month <= 19; month += 1) {
      const iso = `2025-${String(month > 12 ? month - 12 : month).padStart(2, '0')}-05`;
      spend(month > 12 ? iso.replace('2025', '2026') : iso, 'GROCERY STORE', 4200);
    }
  };

  it('carries a stable key on every row, naming the charge it is about', async () => {
    await seed();
    withHistory();
    const outlier = spend('2026-08-20', 'GROCERY STORE', 92000);
    // One charge can trip two detectors (this one is both unusual and a price rise), and each is
    // its own finding with its own key -- clearing "unusually large" says nothing about the rise.
    const unusual = householdInsights({ today: TODAY, viewer: adult() }).find((row) => row.kind === 'unusual');
    expect(unusual?.key).toBe(`unusual:${outlier}`);
    // Same finding, same key, every render -- or a dismissal would not survive a refresh.
    const again = householdInsights({ today: TODAY, viewer: adult() }).find((row) => row.kind === 'unusual');
    expect(again?.key).toBe(unusual?.key);
  });

  it('keys a duplicate on the PAIR, so a third charge is still its own question', async () => {
    await seed();
    withHistory();
    const first = spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const second = spend('2026-08-20', 'CITY TAX OFFICE', 6500);
    const duplicate = householdInsights({ today: TODAY, viewer: adult() }).find((row) => row.kind === 'duplicate');
    expect(duplicate?.key).toBe(`dupe:${Math.min(first, second)}:${Math.max(first, second)}`);
  });

  it('takes the row off the card once it is dismissed', async () => {
    await seed();
    withHistory();
    const outlier = spend('2026-08-20', 'GROCERY STORE', 92000);
    expect(householdInsights({ today: TODAY, viewer: adult() }).map((row) => row.key)).toContain(`unusual:${outlier}`);

    dismissInsight({ key: `unusual:${outlier}`, on: TODAY });

    expect(householdInsights({ today: TODAY, viewer: adult() }).map((row) => row.key)).not.toContain(`unusual:${outlier}`);
  });

  /** A verdict on one charge is not a verdict on the merchant. */
  it('does not silence the same merchant next time', async () => {
    await seed();
    withHistory();
    const first = spend('2026-08-18', 'GROCERY STORE', 92000);
    dismissInsight({ key: `unusual:${first}`, on: TODAY });
    const second = spend('2026-08-20', 'GROCERY STORE', 88000);

    const unusual = householdInsights({ today: TODAY, viewer: adult() }).filter((row) => row.kind === 'unusual');
    expect(unusual.map((row) => row.transactionId)).toEqual([second]);
  });

  /**
   * The filter runs BEFORE the cap, so clearing a row lets the next one through rather than
   * leaving a gap on a card that was already full.
   */
  it('lets the next finding up into the space it freed', async () => {
    await seed();
    withHistory();
    for (let n = 1; n <= 20; n += 1) {
      spend('2026-08-20', `SHOP ${n}`, 6500);
      spend('2026-08-20', `SHOP ${n}`, 6500);
    }
    const before = householdInsights({ today: TODAY, viewer: adult() });
    expect(before).toHaveLength(INSIGHTS_MAX_ROWS);

    dismissInsight({ key: before[0]!.key, on: TODAY });

    const after = householdInsights({ today: TODAY, viewer: adult() });
    expect(after).toHaveLength(INSIGHTS_MAX_ROWS);
    expect(after.map((row) => row.key)).not.toContain(before[0]!.key);
  });

  it('can be undone in the library, because nothing about it is destructive', async () => {
    await seed();
    withHistory();
    const outlier = spend('2026-08-20', 'GROCERY STORE', 92000);
    dismissInsight({ key: `unusual:${outlier}`, on: TODAY });
    dismissInsight({ key: `unusual:${outlier}`, on: TODAY, dismissed: false });
    expect(householdInsights({ today: TODAY, viewer: adult() }).map((row) => row.key)).toContain(`unusual:${outlier}`);
  });
});

/**
 * The store is bounded by construction rather than by a policy somebody has to remember: no
 * detector can flag a charge older than its own lookback, so a dismissal past the longest of them
 * can never match anything again.
 */
describe('the dismissal store keeps itself small', () => {
  it('drops a dismissal too old for any detector to still be flagging', () => {
    current = createTestDb();
    dismissInsight({ key: 'unusual:1', on: '2026-01-01' });
    dismissInsight({ key: 'unusual:2', on: '2026-08-20' });

    pruneInsightDismissals('2026-08-27');

    expect([...listDismissedKeys()]).toEqual(['unusual:2']);
  });

  it('accepts only the three shapes the detectors produce', () => {
    expect(isDismissalKey('unusual:12')).toBe(true);
    expect(isDismissalKey('creep:12')).toBe(true);
    expect(isDismissalKey('dupe:3:12')).toBe(true);
    expect(isDismissalKey('unusual:')).toBe(false);
    expect(isDismissalKey('dupe:3')).toBe(false);
    expect(isDismissalKey("unusual:1'; drop table settings; --")).toBe(false);
    expect(isDismissalKey('something:12')).toBe(false);
  });
});
